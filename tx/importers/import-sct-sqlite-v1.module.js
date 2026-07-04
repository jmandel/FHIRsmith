'use strict';

// SNOMED CT RF2 Snapshot -> sqlite-v1 shared terminology schema.
//
// This importer streams RF2 Snapshot files (Concept, Description, TextDefinition,
// Relationship, RelationshipConcreteValues, Language refset, Simple refset) into
// the shared schema (tx/importers/schema-v1.sql) via the V1Writer in
// tx/importers/sqlite-v1-core.js. ALL writes go through the writer; behavior that
// differs per terminology is written as cs_config rows and property_def metadata,
// not baked into the provider.
//
// Data semantics mirror the v0 importer (import-sct-sqlite-v0.module.js), the
// normative reference for WHAT to import:
//   * concepts: active + inactive, active flag from RF2 `active`.
//   * displays: preferred US-English synonym (en-US language refset
//     900000000000509007, acceptability preferred 900000000000548007), falling
//     back to FSN, then first active designation, then the code.
//   * designations: FSN / synonym / text-definition with use_system
//     http://snomed.info/sct and use_code = the RF2 description typeId; preferred
//     flag from the language refset (FSN always preferred).
//   * relationships: only the inferred set (sct2_Relationship, edge_set 1) is
//     imported -- v0 deliberately skips sct2_StatedRelationship. is-a
//     (116680003) rows are hierarchy links (child->parent) with an is_hierarchy
//     property_def; every other attribute typeId becomes a concept-valued
//     property keyed by that typeId. group_id = RF2 relationshipGroup.
//   * concrete values (sct2_RelationshipConcreteValues): literal properties keyed
//     by typeId; RF2 lexical form (#<num>, "<str>", true/false) preserved in
//     value_raw and projected per fhir_type.
//   * simple refsets (der2_Refset_Simple): value_set rows with url
//     http://snomed.info/sct?fhir_vs=refset/{refsetId} and members.
//
// The whole Description file is >2GB territory; everything here streams
// line-by-line with readline and never slurps a file into memory. The only
// large in-memory structures are the code->conceptId map and the set of
// preferred description ids (~1M entries each), which is acceptable.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { BaseTerminologyModule } = require('./tx-import-base');
const { openV1Database, V1Writer } = require('./sqlite-v1-core');

// ---- SNOMED CT constant ids ------------------------------------------------

const BASE_URI = 'http://snomed.info/sct';

const IS_A_TYPE_ID = '116680003';
const FSN_TYPE_ID = '900000000000003001';
const SYNONYM_TYPE_ID = '900000000000013009';
const TEXT_DEFINITION_TYPE_ID = '900000000000550004';

const CHAR_INFERRED = '900000000000011006';

const EN_US_LANGUAGE_REFSET = '900000000000509007';
const ACCEPTABILITY_PREFERRED = '900000000000548007';

const INTERNATIONAL_MODULE = '900000000000207008';
const US_MODULE = '731000124108';

// Hierarchy convention (schema-v1): child->parent links; is-a gets is_hierarchy=1.
// Closure is built over edge_set 1 (inferred).
const EDGE_SET_INFERRED = 1;

// property_def codes for the per-concept metadata we synthesise from RF2 columns.
const PROP_MODULE_ID = 'moduleId';
const PROP_DEFINITION_STATUS = 'definitionStatusId';
const PROP_EFFECTIVE_TIME = 'effectiveTime';
const PROP_INACTIVE = 'inactive';

// Concept-valued attribute properties (typeIds) and literal concrete-value
// properties (typeIds) are declared lazily as they are encountered.

// ---------------------------------------------------------------------------
// Module (auto-discovered by tx-import.js: *.module.js, class ending in Module).
// ---------------------------------------------------------------------------

class SnomedSqliteV1Module extends BaseTerminologyModule {
  getName() {
    return 'snomed-sqlite-v1';
  }

  getDescription() {
    return 'SNOMED CT RF2 Snapshot -> SQLite (shared v1 terminology schema)';
  }

  getSupportedFormats() {
    return ['rf2', 'directory'];
  }

  getEstimatedDuration() {
    return '30-180 minutes (depends on edition size and closure)';
  }

  getDefaultConfig() {
    return {
      verbose: true,
      overwrite: false,
      edition: US_MODULE,
    };
  }

  registerCommands(terminologyCommand, globalOptions) {
    terminologyCommand
      .command('import')
      .description('Import SNOMED CT RF2 Snapshot into the sqlite-v1 schema')
      .option('-s, --source <directory>', 'RF2 release root or Snapshot directory')
      .option('-d, --dest <file>', 'Destination SQLite file')
      .option('-e, --edition <code>', 'Edition/module code (default 731000124108 US)')
      .option('--snomed-version <YYYYMMDD>', 'Version date in YYYYMMDD format')
      .option('-u, --uri <uri>', 'Canonical SNOMED version URI; overrides edition+version')
      .option('--max-concepts <n>', 'Cap concepts loaded (smoke test)', (v) => parseInt(v, 10))
      .option('--overwrite', 'Overwrite destination database if it exists')
      .option('-y, --yes', 'Skip confirmations')
      .action(async (options) => {
        await this.handleImportCommand({ ...globalOptions, ...options });
      });
  }

  async handleImportCommand(options) {
    const config = options.yes
      ? this._buildConfig(options)
      : { ...this._buildConfig(options), ...(await this.gatherCommonConfig(options)) };

    if (!options.yes) {
      const confirmed = await this.confirmImport(config);
      if (!confirmed) {
        this.logInfo('Import cancelled');
        return;
      }
    }

    const importer = new SnomedSqliteV1Importer(config, this);
    const result = await importer.run();
    this.logSuccess(
      `Imported ${result.stats.concepts.toLocaleString()} concepts into ${config.dest}`
    );
    return result;
  }

  _buildConfig(options) {
    const edition = options.edition || US_MODULE;
    const version = options.snomedVersion || options.version || null;
    let uri = options.uri || null;
    if (!uri && edition && version) {
      uri = `${BASE_URI}/${edition}/version/${version}`;
    }
    return {
      source: options.source,
      dest: options.dest,
      edition,
      version,
      uri,
      maxConcepts: options.maxConcepts || null,
      overwrite: !!options.overwrite,
      verbose: options.verbose !== false,
    };
  }
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

class SnomedSqliteV1Importer {
  constructor(config = {}, logger = null) {
    this.config = { ...config };
    this.logger = logger;

    this.db = null;
    this.writer = null;
    this.csId = null;
    this.auditRunId = null;

    // Streaming state.
    this.conceptIds = new Set();            // codes that were loaded (respecting maxConcepts)
    this.preferredDescriptions = new Set(); // descriptionIds preferred in en-US refset
    this.attributePropIds = new Map();      // typeId -> property_id (concept-valued)
    this.literalPropIds = new Map();        // typeId -> property_id (literal-valued)
    this.isAPropertyId = null;

    this.stats = {
      concepts: 0,
      conceptsActive: 0,
      descriptions: 0,
      isaLinks: 0,
      attributeLinks: 0,
      concreteValues: 0,
      valueSets: 0,
      refsetMembers: 0,
      skippedLinks: 0,
      skippedRefsetMembers: 0,
      closureRows: 0,
    };
  }

  log(message) {
    if (!this.config.verbose) return;
    if (this.logger && typeof this.logger.logInfo === 'function') {
      this.logger.logInfo(message);
    } else {
      // eslint-disable-next-line no-console
      console.log(message);
    }
  }

  // ---- file discovery ------------------------------------------------------

  _discoverFiles() {
    const root = this.config.source;
    if (!root || !fs.existsSync(root)) {
      throw new Error(`Source path not found: ${root}`);
    }
    const files = {
      concept: null,
      description: [],
      relationship: null,
      concreteValues: null,
      language: [],
      simpleRefset: [],
    };
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) walk(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;
        if (!full.toLowerCase().includes('snapshot')) continue;
        this._classify(full, files);
      }
    };
    walk(root);

    if (!files.concept) throw new Error('No sct2_Concept Snapshot file found');
    if (files.description.length === 0) throw new Error('No sct2_Description Snapshot file found');
    return files;
  }

  _classify(filePath, files) {
    const header = readFirstLine(filePath);
    if (!header) return;
    const name = path.basename(filePath).toLowerCase();

    if (header.startsWith('id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId')) {
      files.concept = filePath;
      return;
    }
    if (header.startsWith('id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId')) {
      // Both Description and TextDefinition share this header.
      files.description.push(filePath);
      return;
    }
    if (header.startsWith('id\teffectiveTime\tactive\tmoduleId\tsourceId\tdestinationId\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId')) {
      // v0 deliberately imports only the inferred relationship file, skipping
      // sct2_StatedRelationship. Mirror that: stated is edge_set 2 and NOT loaded.
      if (name.includes('statedrelationship')) return;
      files.relationship = filePath;
      return;
    }
    if (header.startsWith('id\teffectiveTime\tactive\tmoduleId\tsourceId\tvalue\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId')) {
      files.concreteValues = filePath;
      return;
    }
    if (header.startsWith('id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tacceptabilityId')) {
      files.language.push(filePath);
      return;
    }
    // Simple refset (der2_Refset_Simple): the header is EXACTLY the 6-field form
    // with no trailing columns. Many other refset types (Association,
    // AttributeValue, maps, MRCM, DescriptionType, annotations, ...) share the
    // same header prefix but add columns; those are NOT simple refsets and must
    // not become value sets. Match the exact header and the filename to scope to
    // the Simple refset only.
    if (header === 'id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId'
        && name.includes('der2_refset_simple')) {
      files.simpleRefset.push(filePath);
    }
  }

  // ---- run -----------------------------------------------------------------

  async run() {
    if (!this.config.source) throw new Error('source is required');
    if (!this.config.dest) throw new Error('dest is required');
    if (!this.config.version) throw new Error('version (YYYYMMDD) is required');
    if (!this.config.uri) {
      this.config.uri = `${BASE_URI}/${this.config.edition}/version/${this.config.version}`;
    }

    const files = this._discoverFiles();
    this.log(
      `Discovered: concept=${files.concept ? 1 : 0}, description=${files.description.length}, ` +
      `relationship=${files.relationship ? 1 : 0}, concrete=${files.concreteValues ? 1 : 0}, ` +
      `language=${files.language.length}, simpleRefset=${files.simpleRefset.length}`
    );

    this.db = openV1Database(this.config.dest, { overwrite: this.config.overwrite });
    this.writer = new V1Writer(this.db);

    try {
      this.auditRunId = this.writer.beginAudit({
        sourcePath: this.config.source,
        targetDb: this.config.dest,
        terminology: 'snomed-sqlite-v1',
        editionCode: this.config.edition,
        version: this.config.version,
      });

      this._createCodeSystem();

      // Pass 1: language refset acceptability, so display selection can prefer
      // the US-English preferred synonym while descriptions are still streamed.
      await this._loadLanguagePreferences(files.language);

      // Concepts (active + inactive), plus per-concept metadata properties.
      await this._importConcepts(files.concept);

      // Descriptions -> designations, buffering per concept to derive display.
      await this._importDescriptions(files.description);

      // Inferred relationships -> is-a links + concept-valued attribute props.
      if (files.relationship) {
        await this._importRelationships(files.relationship);
      }

      // Concrete values -> literal properties.
      if (files.concreteValues) {
        await this._importConcreteValues(files.concreteValues);
      }

      // Simple refsets -> value sets.
      await this._importSimpleRefsets(files.simpleRefset);

      this.writer.flush();

      this.log('Building closure (is-a, inferred edge set)...');
      this.stats.closureRows = this.writer.buildClosure(this.csId, { edgeSetId: EDGE_SET_INFERRED });

      this.log('Building search index...');
      this.writer.buildSearchIndex(this.csId);

      this._writeCsConfig();

      this.log('Finalizing...');
      this.writer.finalize({ caseSensitive: true });

      this.writer.finishAudit(this.auditRunId, { status: 'success', stats: this.stats });
      this.log(`Done. ${JSON.stringify(this.stats)}`);
    } catch (error) {
      if (this.writer && this.auditRunId) {
        try {
          this.writer.finishAudit(this.auditRunId, {
            status: 'failed',
            stats: { ...this.stats, error: error.message },
          });
        } catch (_) { /* best effort */ }
      }
      throw error;
    } finally {
      if (this.db) {
        this.db.close();
        this.db = null;
      }
    }

    return { csId: this.csId, uri: this.config.uri, stats: this.stats };
  }

  // ---- code system + fixed properties --------------------------------------

  _createCodeSystem() {
    this.csId = this.writer.codeSystem({
      baseUri: BASE_URI,
      editionCode: this.config.edition,
      version: this.config.version,
      canonicalUri: this.config.uri,
      releaseDate: releaseDateFromYyyymmdd(this.config.version),
      name: snomedName(this.config.edition),
      title: snomedName(this.config.edition),
      description: `SNOMED CT RF2 Snapshot, module ${this.config.edition}, version ${this.config.version}`,
      contentMode: 'complete',
      sourceKind: 'snomed-sqlite-v1',
    });

    // is-a hierarchy property.
    this.isAPropertyId = this.writer.defineProperty(this.csId, {
      code: IS_A_TYPE_ID,
      uri: `${BASE_URI}/${IS_A_TYPE_ID}`,
      fhirType: 'code',
      valueKind: 'concept',
      isHierarchy: true,
      display: 'Is a (attribute)',
    });

    // Per-concept metadata properties synthesised from RF2 Concept columns.
    this.moduleProp = this.writer.defineProperty(this.csId, {
      code: PROP_MODULE_ID, fhirType: 'code', valueKind: 'literal', display: 'Module id',
    });
    this.definitionStatusProp = this.writer.defineProperty(this.csId, {
      code: PROP_DEFINITION_STATUS, fhirType: 'code', valueKind: 'literal', display: 'Definition status',
    });
    this.effectiveTimeProp = this.writer.defineProperty(this.csId, {
      code: PROP_EFFECTIVE_TIME, fhirType: 'dateTime', valueKind: 'literal', display: 'Effective time',
    });
    this.inactiveProp = this.writer.defineProperty(this.csId, {
      code: PROP_INACTIVE, fhirType: 'boolean', valueKind: 'literal', display: 'Inactive',
    });
  }

  _attributeProperty(typeId) {
    let id = this.attributePropIds.get(typeId);
    if (id === undefined) {
      id = this.writer.defineProperty(this.csId, {
        code: typeId,
        uri: `${BASE_URI}/${typeId}`,
        fhirType: 'code',
        valueKind: 'concept',
      });
      this.attributePropIds.set(typeId, id);
    }
    return id;
  }

  // ---- pass 1: language refset --------------------------------------------

  async _loadLanguagePreferences(langFiles) {
    if (!langFiles || langFiles.length === 0) {
      this.log('No language refset files; preferred flags limited to FSN');
      return;
    }
    for (const file of langFiles) {
      await forEachRow(file, (cols) => {
        // id, effectiveTime, active, moduleId, refsetId, referencedComponentId, acceptabilityId
        if (cols.length < 7) return;
        if (cols[2] !== '1') return;
        if (cols[4] !== EN_US_LANGUAGE_REFSET) return;
        if (cols[6] !== ACCEPTABILITY_PREFERRED) return;
        this.preferredDescriptions.add(cols[5]);
      });
    }
    this.log(`Captured ${this.preferredDescriptions.size.toLocaleString()} preferred description ids`);
  }

  // ---- concepts ------------------------------------------------------------

  async _importConcepts(file) {
    const cap = this.config.maxConcepts || Infinity;
    await forEachRow(file, (cols) => {
      // id, effectiveTime, active, moduleId, definitionStatusId
      if (cols.length < 5) return;
      if (this.conceptIds.size >= cap) return;

      const code = cols[0];
      const effectiveTime = cols[1];
      const active = cols[2] === '1';
      const moduleId = cols[3];
      const definitionStatusId = cols[4];

      const conceptId = this.writer.addConcept(this.csId, {
        code,
        active,
        display: null,
        definition: null,
      });
      this.conceptIds.add(code);
      this.stats.concepts += 1;
      if (active) this.stats.conceptsActive += 1;

      // Per-concept metadata as literal properties (preserve RF2 provenance).
      this.writer.addLiteral({ sourceId: conceptId, propertyId: this.moduleProp, value: moduleId, active });
      this.writer.addLiteral({ sourceId: conceptId, propertyId: this.definitionStatusProp, value: definitionStatusId, active });
      this.writer.addLiteral({ sourceId: conceptId, propertyId: this.effectiveTimeProp, value: effectiveTime, active });
      this.writer.addLiteral({ sourceId: conceptId, propertyId: this.inactiveProp, value: active ? '0' : '1', active: true });
    });
    this.log(
      `Concepts: ${this.stats.concepts.toLocaleString()} ` +
      `(${this.stats.conceptsActive.toLocaleString()} active)`
    );
  }

  // ---- descriptions --------------------------------------------------------
  //
  // Buffer designations per concept (grouped because RF2 Description rows for a
  // concept are contiguous only within a file, but we may cross files) then pick
  // the display once we have flushed a concept's rows. To keep memory bounded and
  // avoid holding every designation, we buffer per current concept and flush the
  // display decision when the conceptId changes; a final flush handles the tail.
  // Descriptions and text definitions are streamed sequentially.

  async _importDescriptions(files) {
    // Accumulate the best display candidate per concept without holding all
    // designations: display selection only needs, per concept, the preferred
    // synonym term (if any), the FSN term, and the first active term.
    // We compute these incrementally and update concept.display at the end.
    const bestPreferred = new Map(); // conceptCode -> preferred-synonym term
    const bestFsn = new Map();       // conceptCode -> FSN term
    const firstActive = new Map();   // conceptCode -> first active term seen

    for (const file of files) {
      await forEachRow(file, (cols) => {
        // id, effectiveTime, active, moduleId, conceptId, languageCode, typeId, term, caseSignificanceId
        if (cols.length < 9) return;
        const descriptionId = cols[0];
        const active = cols[2] === '1';
        const conceptCode = cols[4];
        const languageCode = cols[5] || null;
        const typeId = cols[6] || null;
        const term = cols[7] || '';

        if (!this.conceptIds.has(conceptCode)) return; // absent (maxConcepts cap)
        const conceptId = this.writer.conceptId(this.csId, conceptCode);
        if (conceptId === undefined) return;

        const isFsn = typeId === FSN_TYPE_ID;
        const preferred = isFsn || this.preferredDescriptions.has(descriptionId);

        this.writer.addDesignation(conceptId, {
          active,
          language: languageCode,
          useSystem: BASE_URI,
          useCode: typeId,
          term,
          preferred,
        });
        this.stats.descriptions += 1;

        // Also fill concept.definition from an active text-definition row.
        if (active && typeId === TEXT_DEFINITION_TYPE_ID) {
          this.db.prepare('UPDATE concept SET definition = ? WHERE concept_id = ? AND definition IS NULL')
            .run(term, conceptId);
        }

        // Display candidates (active rows only).
        if (active) {
          if (preferred && !isFsn && !bestPreferred.has(conceptCode)) {
            bestPreferred.set(conceptCode, term);
          }
          if (isFsn && !bestFsn.has(conceptCode)) {
            bestFsn.set(conceptCode, term);
          }
          if (!firstActive.has(conceptCode)) {
            firstActive.set(conceptCode, term);
          }
        }
      });
    }

    // Apply display selection: preferred synonym > FSN > first active > code.
    this.writer.flush();
    const upd = this.db.prepare('UPDATE concept SET display = ? WHERE concept_id = ?');
    this.db.exec('BEGIN');
    let n = 0;
    for (const code of this.conceptIds) {
      const conceptId = this.writer.conceptId(this.csId, code);
      const display = bestPreferred.get(code)
        ?? bestFsn.get(code)
        ?? firstActive.get(code)
        ?? code;
      upd.run(display, conceptId);
      if (++n % 50000 === 0) { this.db.exec('COMMIT'); this.db.exec('BEGIN'); }
    }
    this.db.exec('COMMIT');
    this.log(`Descriptions: ${this.stats.descriptions.toLocaleString()}; displays assigned`);
  }

  // ---- relationships (inferred only) --------------------------------------

  async _importRelationships(file) {
    await forEachRow(file, (cols) => {
      // id, effectiveTime, active, moduleId, sourceId, destinationId, relationshipGroup, typeId, characteristicTypeId, modifierId
      if (cols.length < 10) return;
      const active = cols[2] === '1';
      const sourceCode = cols[4];
      const targetCode = cols[5];
      const groupId = parseInt(cols[6], 10) || 0;
      const typeId = cols[7] || null;

      const sourceId = this.writer.conceptId(this.csId, sourceCode);
      const targetId = this.writer.conceptId(this.csId, targetCode);
      if (sourceId === undefined || targetId === undefined) {
        this.stats.skippedLinks += 1;
        return;
      }

      if (typeId === IS_A_TYPE_ID) {
        // Hierarchy convention: source = child, target = parent.
        this.writer.addLink({
          edgeSetId: EDGE_SET_INFERRED,
          sourceId,
          propertyId: this.isAPropertyId,
          targetId,
          groupId,
          active,
        });
        this.stats.isaLinks += 1;
      } else if (typeId) {
        this.writer.addLink({
          edgeSetId: EDGE_SET_INFERRED,
          sourceId,
          propertyId: this._attributeProperty(typeId),
          targetId,
          groupId,
          active,
        });
        this.stats.attributeLinks += 1;
      }
    });
    this.log(
      `Relationships: is-a=${this.stats.isaLinks.toLocaleString()}, ` +
      `attribute=${this.stats.attributeLinks.toLocaleString()}, ` +
      `skipped(absent concept)=${this.stats.skippedLinks.toLocaleString()}`
    );
  }

  // ---- concrete values -----------------------------------------------------

  async _importConcreteValues(file) {
    await forEachRow(file, (cols) => {
      // id, effectiveTime, active, moduleId, sourceId, value, relationshipGroup, typeId, characteristicTypeId, modifierId
      if (cols.length < 10) return;
      const active = cols[2] === '1';
      const sourceCode = cols[4];
      const rawValue = cols[5];
      const groupId = parseInt(cols[6], 10) || 0;
      const typeId = cols[7] || null;

      const sourceId = this.writer.conceptId(this.csId, sourceCode);
      if (sourceId === undefined) { this.stats.skippedLinks += 1; return; }
      if (!typeId) return;

      // RF2 concrete lexical form: #<number>, "<string>", or true/false. Choose
      // the property fhir_type from the value shape; value_raw keeps the source
      // form. addLiteral projects value_num/value_bool/value_text per fhir_type.
      const parsed = classifyConcrete(rawValue);
      const propertyId = this._concreteProperty(typeId, parsed.fhirType);
      this.writer.addLiteral({
        edgeSetId: EDGE_SET_INFERRED,
        sourceId,
        propertyId,
        value: parsed.value,
        groupId,
        active,
      });
      this.stats.concreteValues += 1;
    });
    this.log(`Concrete values: ${this.stats.concreteValues.toLocaleString()}`);
  }

  _concreteProperty(typeId, fhirType) {
    // Key the property by (typeId, fhirType) so a typeId that carries both a
    // numeric and a string value across concepts keeps a coherent projection.
    const key = `${typeId}|${fhirType}`;
    let id = this.literalPropIds.get(key);
    if (id === undefined) {
      id = this.writer.defineProperty(this.csId, {
        code: `concrete:${typeId}`,
        uri: `${BASE_URI}/${typeId}`,
        fhirType,
        valueKind: 'literal',
      });
      this.literalPropIds.set(key, id);
    }
    return id;
  }

  // ---- simple refsets ------------------------------------------------------

  async _importSimpleRefsets(files) {
    if (!files || files.length === 0) {
      this.log('No simple refset files');
      return;
    }
    const vsByRefset = new Map(); // refsetId -> vs_id
    for (const file of files) {
      await forEachRow(file, (cols) => {
        // id, effectiveTime, active, moduleId, refsetId, referencedComponentId
        if (cols.length < 6) return;
        if (cols[2] !== '1') return; // active members only
        const refsetId = cols[4];
        const componentId = cols[5];
        if (!refsetId || !componentId) return;

        const conceptId = this.writer.conceptId(this.csId, componentId);
        if (conceptId === undefined) { this.stats.skippedRefsetMembers += 1; return; }

        let vsId = vsByRefset.get(refsetId);
        if (vsId === undefined) {
          vsId = this.writer.addValueSet(this.csId, {
            url: `${BASE_URI}?fhir_vs=refset/${refsetId}`,
            version: this.config.version,
            name: `SNOMED CT Refset ${refsetId}`,
          });
          vsByRefset.set(refsetId, vsId);
          this.stats.valueSets += 1;
        }
        this.writer.addValueSetMember(vsId, conceptId, true);
        this.stats.refsetMembers += 1;
      });
    }
    this.log(
      `Refsets: ${this.stats.valueSets.toLocaleString()} value sets, ` +
      `${this.stats.refsetMembers.toLocaleString()} members ` +
      `(skipped ${this.stats.skippedRefsetMembers.toLocaleString()} absent)`
    );
  }

  // ---- cs_config -----------------------------------------------------------

  _writeCsConfig() {
    const set = (key, value) => this.writer.setConfig(this.csId, key, value);
    set('caseSensitive', '1');
    set('defaultLanguage', 'en');
    set('versionAlgorithm', 'date');
    // SNOMED CT supports post-coordinated expressions (focus : attr = value).
    // Only SNOMED sets this; the provider gates all expression parsing on it.
    set('supportsExpressions', '1');
    set('hierarchyMeaning', 'is-a');
    set('hierarchyEdgeSet', String(EDGE_SET_INFERRED));
    set('statusProperty', PROP_INACTIVE);
    set('inactiveProperty', PROP_INACTIVE);
    // Leading '?' matters: the provider matches pattern or system()+pattern
    // against the full implicit-VS URL (http://snomed.info/sct?fhir_vs=...).
    set('implicitValueSets', [
      { pattern: '?fhir_vs', kind: 'all' },
      { pattern: '?fhir_vs=isa/{code}', kind: 'isa' },
      { pattern: '?fhir_vs=refset/{id}', kind: 'vs-table' },
    ]);
    set('searchSources', ['display', 'designation', 'literal']);
    set('webSource', 'https://browser.ihtsdotools.org/?perspective=full&conceptId1={code}');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function snomedName(editionCode) {
  if (editionCode === INTERNATIONAL_MODULE) return 'SNOMED CT International';
  if (editionCode === US_MODULE) return 'SNOMED CT US Edition';
  return `SNOMED CT ${editionCode || ''}`.trim();
}

function releaseDateFromYyyymmdd(v) {
  if (!v || !/^\d{8}$/.test(v)) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

// Classify an RF2 concrete value lexical form into a fhir_type + a value string
// that addLiteral will project (# = number, " = string, true/false = boolean).
function classifyConcrete(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { fhirType: 'string', value: raw ?? null };
  }
  if (raw.startsWith('#')) {
    return { fhirType: 'decimal', value: raw.slice(1) };
  }
  if (raw === 'true' || raw === 'false') {
    return { fhirType: 'boolean', value: raw };
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return { fhirType: 'string', value: raw.slice(1, -1) };
  }
  return { fhirType: 'string', value: raw };
}

function readFirstLine(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const count = fs.readSync(fd, buf, 0, buf.length, 0);
    if (count <= 0) return '';
    const text = buf.toString('utf8', 0, count);
    const nl = text.indexOf('\n');
    return (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, '');
  } finally {
    fs.closeSync(fd);
  }
}

// Stream a tab-delimited RF2 file, skipping the header, invoking cb(cols) per row.
async function forEachRow(filePath, cb) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let first = true;
  try {
    for await (const line of rl) {
      if (first) { first = false; continue; }
      if (!line) continue;
      cb(line.split('\t'));
    }
  } finally {
    rl.close();
  }
}

module.exports = {
  SnomedSqliteV1Module,
  SnomedSqliteV1Importer,
  constants: {
    BASE_URI,
    IS_A_TYPE_ID,
    FSN_TYPE_ID,
    SYNONYM_TYPE_ID,
    TEXT_DEFINITION_TYPE_ID,
    CHAR_INFERRED,
    EN_US_LANGUAGE_REFSET,
    ACCEPTABILITY_PREFERRED,
    EDGE_SET_INFERRED,
    US_MODULE,
    INTERNATIONAL_MODULE,
  },
};
