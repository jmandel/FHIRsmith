'use strict';

// SNOMED CT legacy `.cache` -> sqlite-v1 shared terminology schema.
//
// Sibling of import-sct-sqlite-v1.module.js (the RF2 Snapshot importer). That
// importer streams an RF2 release directory; THIS one reads a legacy SNOMED
// `.cache` binary (the in-memory format cs-snomed.js loads) and emits the SAME
// sqlite-v1 rows / cs_config, so a cache-sourced fixture behaves IDENTICALLY to a
// source-built one. It exists for SNOMED versions we only have as a `.cache`
// (e.g. International 20250201, which the official test suite loads from
// data/terminology-cache/sct_intl_20250201.cache) and cannot re-import from RF2.
//
// The cache is read through the repo's own reader (tx/sct/structures.js
// SnomedFileReader.loadSnomedData) wrapped in the exported SnomedServices class
// (tx/cs/cs-snomed.js) -- the exact in-memory structures the running test suite
// resolves against. No binary format is re-implemented here.
//
// v1 semantics are copied verbatim from import-sct-sqlite-v1.module.js (the
// source of truth): is-a hierarchy links (child->parent, is_hierarchy=1);
// attribute relationships as concept-valued properties keyed by typeId;
// per-concept metadata (moduleId / definitionStatusId / effectiveTime / inactive)
// as typed literals; designations with use_system http://snomed.info/sct and
// use_code = the description typeId, preferred = FSN OR PREFERRED in the en-US
// language refset; display = preferred en synonym > FSN > first active > code;
// simple refsets -> value_set at ?fhir_vs=refset/{id}; identical cs_config
// (implicitValueSets '?'-prefixed patterns, status/inactive property, etc.).
//
// Where the cache carries LESS than RF2 (documented at each site):
//   * concrete values: the `.cache` blob has no concrete-value section, so there
//     are NO literal concrete properties (RF2 sct2_RelationshipConcreteValues).
//   * definitionStatusId: the cache stores only a primitive bit (flags & 0x10),
//     not the RF2 SCTID; it is reconstructed to the two canonical status SCTIDs.
//   * moduleId: the cache exposes the owning module as a concept byte-index
//     (concepts.getModuleId). In caches that populate it (v16 International) each
//     concept gets a moduleId literal; in caches that leave it 0 (the v17 test
//     edition) no moduleId literal is emitted -- matching the cache oracle, which
//     emits the `module` $lookup property only when getModuleId != 0.
//   * effectiveTime: the cache stores a uint16 day-count from the Delphi epoch
//     1899-12-30; it is converted back to the RF2 YYYYMMDD string the RF2
//     importer stores (deterministic pure-UTC reconstruction).

const path = require('path');

const { BaseTerminologyModule } = require('./tx-import-base');
const { openV1Database, V1Writer } = require('./sqlite-v1-core');
const { SnomedFileReader, SnomedConceptList } = require('../sct/structures');
const { SnomedServices } = require('../cs/cs-snomed');

// ---- SNOMED CT constant ids (verbatim from import-sct-sqlite-v1) -----------

const BASE_URI = 'http://snomed.info/sct';

const IS_A_TYPE_ID = '116680003';
const FSN_TYPE_ID = '900000000000003001';
const SYNONYM_TYPE_ID = '900000000000013009';
const TEXT_DEFINITION_TYPE_ID = '900000000000550004';

const EN_US_LANGUAGE_REFSET = '900000000000509007';
const ACCEPTABILITY_PREFERRED = '900000000000548007';

// Canonical RF2 definitionStatusId SCTIDs, reconstructed from the cache's
// primitive bit (there is no stored SCTID in the cache concept record).
const DEF_STATUS_PRIMITIVE = '900000000000074008'; // Primitive
const DEF_STATUS_DEFINED = '900000000000073002';   // Sufficiently defined

const INTERNATIONAL_MODULE = '900000000000207008';
const US_MODULE = '731000124108';

// Hierarchy convention (schema-v1): child->parent links; is-a gets is_hierarchy=1.
// Closure is built over edge_set 1 (the cache stores only the inferred form).
const EDGE_SET_INFERRED = 1;

// property_def codes for the per-concept metadata synthesised from the cache.
const PROP_MODULE_ID = 'moduleId';
const PROP_DEFINITION_STATUS = 'definitionStatusId';
const PROP_EFFECTIVE_TIME = 'effectiveTime';
const PROP_INACTIVE = 'inactive';

// The cache concept record stores effectiveTime as a uint16 day-count from the
// Delphi/Pascal epoch 1899-12-30. A pure-UTC reconstruction (whole days) yields
// the exact calendar date the RF2 effectiveTime encodes, independent of host TZ,
// so the literal matches the RF2 importer's raw YYYYMMDD string.
const EFFECTIVE_TIME_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

const CONCEPT_SIZE = SnomedConceptList.CONCEPT_SIZE; // 56

// SNOMED `lang` byte -> BCP-47 tag (mirrors SnomedProvider.getLanguageCode).
const LANGUAGE_BY_INDEX = {
  1: 'en', 2: 'fr', 3: 'nl', 4: 'es', 5: 'sv', 6: 'da', 7: 'de', 8: 'it', 9: 'cs',
};

function languageFromIndex(langIndex) {
  return LANGUAGE_BY_INDEX[langIndex] || 'en';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function effectiveTimeToYyyymmdd(dayCount) {
  if (!dayCount) return null;
  const d = new Date(EFFECTIVE_TIME_EPOCH_UTC_MS + dayCount * 86400000);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

function releaseDateFromYyyymmdd(v) {
  if (!v || !/^\d{8}$/.test(v)) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

function snomedName(editionCode) {
  if (editionCode === INTERNATIONAL_MODULE) return 'SNOMED CT International';
  if (editionCode === US_MODULE) return 'SNOMED CT US Edition';
  return `SNOMED CT ${editionCode || ''}`.trim();
}

// ---------------------------------------------------------------------------
// Module (auto-discovered by tx-import.js: *.module.js, class ending in Module).
// ---------------------------------------------------------------------------

class SnomedCacheSqliteV1Module extends BaseTerminologyModule {
  getName() {
    return 'snomed-cache-sqlite-v1';
  }

  getDescription() {
    return 'SNOMED CT legacy .cache -> SQLite (shared v1 terminology schema)';
  }

  getSupportedFormats() {
    return ['cache'];
  }

  getEstimatedDuration() {
    return '1-15 minutes (depends on edition size and closure)';
  }

  getDefaultConfig() {
    return { verbose: true, overwrite: false };
  }

  registerCommands(terminologyCommand, globalOptions) {
    terminologyCommand
      .command('import')
      .description('Import a SNOMED CT .cache file into the sqlite-v1 schema')
      .option('-s, --source <file>', 'SNOMED CT .cache file')
      .option('-d, --dest <file>', 'Destination SQLite file')
      .option('-u, --uri <uri>', 'Canonical version URI (default: taken from the cache header)')
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

    const importer = new SnomedCacheSqliteV1Importer(config, this);
    const result = await importer.run();
    this.logSuccess(
      `Imported ${result.stats.concepts.toLocaleString()} concepts into ${config.dest}`
    );
    return result;
  }

  _buildConfig(options) {
    return {
      source: options.source,
      dest: options.dest,
      uri: options.uri || null,
      overwrite: !!options.overwrite,
      verbose: options.verbose !== false,
    };
  }
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

class SnomedCacheSqliteV1Importer {
  constructor(config = {}, logger = null) {
    this.config = { ...config };
    this.logger = logger;

    this.db = null;
    this.writer = null;
    this.csId = null;
    this.auditRunId = null;

    this.sct = null;
    this.shared = null;

    // cache concept byte-index -> v1 concept_id.
    this.conceptIdByIndex = new Map();
    // description byte-indices PREFERRED in the en-US language refset.
    this.preferredDescriptionRefs = new Set();
    // typeId -> property_id (concept-valued attribute relationships).
    this.attributePropIds = new Map();

    this.isAPropertyId = null;
    this.moduleProp = null;
    this.definitionStatusProp = null;
    this.effectiveTimeProp = null;
    this.inactiveProp = null;

    this.stats = {
      concepts: 0,
      conceptsActive: 0,
      designations: 0,
      isaLinks: 0,
      attributeLinks: 0,
      moduleLiterals: 0,
      literals: 0,
      valueSets: 0,
      refsetMembers: 0,
      skippedLinks: 0,
      skippedDescriptionRefsets: 0,
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

  // ---- cache loading (repo reader + exported SnomedServices) ---------------

  async _loadCache() {
    if (!this.config.source) throw new Error('source is required');
    const t0 = Date.now();
    const reader = new SnomedFileReader(this.config.source);
    this.shared = await reader.loadSnomedData();
    this.sct = new SnomedServices(this.shared);
    this.log(
      `Cache loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(format v${this.shared.cacheVersion}, ${this.sct.concepts.count().toLocaleString()} concepts)`
    );

    // edition / version / uri are authoritative from the cache header.
    this.edition = this.shared.edition;
    this.version = this.shared.version;
    this.uri = this.config.uri || this.shared.versionUri;
    if (!this.uri) throw new Error('Unable to resolve canonical URI from cache');
    if (!this.version) throw new Error('Unable to resolve version from cache');
  }

  // ---- run -----------------------------------------------------------------

  async run() {
    if (!this.config.dest) throw new Error('dest is required');

    await this._loadCache();

    this.db = openV1Database(this.config.dest, { overwrite: this.config.overwrite });
    this.writer = new V1Writer(this.db);

    try {
      this.auditRunId = this.writer.beginAudit({
        sourcePath: this.config.source,
        targetDb: this.config.dest,
        terminology: 'snomed-cache-sqlite-v1',
        editionCode: this.edition,
        version: this.version,
      });

      this._createCodeSystem();

      this._collectPreferredDescriptions();
      this._importConcepts();      // concepts + designations + metadata literals
      this._importRelationships(); // is-a + attribute concept-links
      this._importRefsets();       // simple/concept refsets -> value sets

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

    return { csId: this.csId, uri: this.uri, stats: this.stats };
  }

  // ---- code system + fixed properties --------------------------------------

  _createCodeSystem() {
    this.csId = this.writer.codeSystem({
      baseUri: BASE_URI,
      editionCode: this.edition,
      // For SNOMED the FHIR `version` reported in responses is the full
      // versioned edition URI (e.g. http://snomed.info/xsct/<module>/version/
      // <date>), matching the binary provider's versionUri — not the bare date.
      version: this.uri,
      canonicalUri: this.uri,
      releaseDate: releaseDateFromYyyymmdd(this.version),
      name: snomedName(this.edition),
      title: snomedName(this.edition),
      description: `SNOMED CT (.cache), module ${this.edition}, version ${this.version}`,
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

    // Per-concept metadata properties (mirror the RF2 importer's Concept columns).
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

  // ---- preferred-designation reconstruction (en-US language refset) --------
  //
  // A description is `preferred` if it is an FSN OR is PREFERRED (548007) in the
  // en-US language refset (509007) -- the exact signal the RF2 importer reads
  // from the language refset files. Members are keyed by `ref`, a description
  // byte-index identical to the values in each concept's descriptions list, so
  // the per-description lookup is O(1).

  _collectPreferredDescriptions() {
    const sct = this.sct;
    for (let i = 0; i < sct.refSetIndex.count(); i++) {
      const rs = sct.refSetIndex.getReferenceSet(i);
      if (!rs.membersByRef || rs.membersByRef === 0xffffffff) continue;
      const refsetId = sct.getConceptId(rs.definition);
      if (refsetId !== EN_US_LANGUAGE_REFSET) continue;

      const members = sct.refSetMembers.getMembers(rs.membersByRef);
      if (!members) continue;
      for (const m of members) {
        if (!m.values) continue;
        const vals = sct.refs.getReferences(m.values);
        if (!vals || vals.length === 0) continue;
        if (sct.getConceptId(vals[0]) === ACCEPTABILITY_PREFERRED) {
          this.preferredDescriptionRefs.add(m.ref);
        }
      }
    }
    this.log(
      `Captured ${this.preferredDescriptionRefs.size.toLocaleString()} preferred (en-US) description refs`
    );
  }

  // ---- concepts + designations + metadata literals -------------------------

  _importConcepts() {
    const sct = this.sct;
    const n = sct.concepts.count();

    for (let i = 0; i < n; i++) {
      const c = sct.concepts.getConceptByCount(i);
      const code = c.identity.toString();
      const active = (c.flags & 0x0f) === 0;
      const primitive = (c.flags & 0x10) !== 0;

      // Read this concept's descriptions once: derive designations + display +
      // definition. Display = the concept's preferred term = the FIRST active
      // SYNONYM (type 900000000000013009) in description order — the tag-free
      // term the reference tx server returns (e.g. 730807009 -> "Entire canal of
      // Hering", not the FSN "... (body structure)"; 10200004 -> "Liver", not
      // the FSN nor the refset-"preferred" "Liver structure"). Verified against
      // the official SNOMED expand fixtures: every returned display is the first
      // active synonym, independent of the en-US language-refset PREFERRED flag.
      // Falls back to the FSN, then the first active description, then the code.
      const descSpecs = [];
      let firstActive = null;
      let firstSynonym = null;
      let fsn = null;
      let definition = null;

      const descRefs = c.descriptions ? (sct.refs.getReferences(c.descriptions) || []) : [];
      for (const di of descRefs) {
        const d = sct.descriptions.getDescription(di);
        const term = sct.strings.getEntry(d.iDesc).trim();
        const typeId = sct.getConceptId(d.kind);
        const languageCode = languageFromIndex(d.lang);
        const isFsn = typeId === FSN_TYPE_ID;
        const preferred = isFsn || this.preferredDescriptionRefs.has(di);

        descSpecs.push({
          active: d.active,
          language: languageCode,
          useSystem: BASE_URI,
          useCode: typeId,
          term,
          preferred,
        });

        if (d.active) {
          if (firstActive === null) firstActive = term;
          if (firstSynonym === null && typeId === SYNONYM_TYPE_ID) firstSynonym = term;
          if (fsn === null && isFsn) fsn = term;
          if (typeId === TEXT_DEFINITION_TYPE_ID && definition === null) definition = term;
        }
      }

      const display = firstSynonym ?? fsn ?? firstActive ?? code;

      const conceptId = this.writer.addConcept(this.csId, {
        code, active, display, definition,
      });
      this.conceptIdByIndex.set(c.index, conceptId);
      this.stats.concepts += 1;
      if (active) this.stats.conceptsActive += 1;

      for (const spec of descSpecs) {
        this.writer.addDesignation(conceptId, spec);
        this.stats.designations += 1;
      }

      // Per-concept metadata as literal properties (preserve RF2 provenance).
      const moduleIndex = sct.concepts.getModuleId(c.index);
      if (moduleIndex && moduleIndex !== 0xffffffff) {
        const moduleSctid = sct.getConceptId(moduleIndex);
        this.writer.addLiteral({ sourceId: conceptId, propertyId: this.moduleProp, value: moduleSctid, active });
        this.stats.moduleLiterals += 1;
      }
      this.writer.addLiteral({
        sourceId: conceptId,
        propertyId: this.definitionStatusProp,
        value: primitive ? DEF_STATUS_PRIMITIVE : DEF_STATUS_DEFINED,
        active,
      });
      const et = effectiveTimeToYyyymmdd(c.effectiveTime);
      if (et) {
        this.writer.addLiteral({ sourceId: conceptId, propertyId: this.effectiveTimeProp, value: et, active });
      }
      this.writer.addLiteral({ sourceId: conceptId, propertyId: this.inactiveProp, value: active ? '0' : '1', active: true });
      this.stats.literals += 2 + (et ? 1 : 0) + ((moduleIndex && moduleIndex !== 0xffffffff) ? 1 : 0);
    }

    this.log(
      `Concepts: ${this.stats.concepts.toLocaleString()} ` +
      `(${this.stats.conceptsActive.toLocaleString()} active), ` +
      `${this.stats.designations.toLocaleString()} designations, ` +
      `${this.stats.moduleLiterals.toLocaleString()} moduleId literals`
    );
  }

  // ---- relationships (inferred) -> is-a + attribute links ------------------

  _importRelationships() {
    const sct = this.sct;
    const n = sct.concepts.count();

    for (let i = 0; i < n; i++) {
      const c = sct.concepts.getConceptByCount(i);
      const sourceId = this.conceptIdByIndex.get(c.index);
      if (sourceId === undefined) continue;

      const relRefs = c.outbounds ? (sct.refs.getReferences(c.outbounds) || []) : [];
      for (const ri of relRefs) {
        const rel = sct.relationships.getRelationship(ri);
        const targetId = this.conceptIdByIndex.get(rel.target);
        if (targetId === undefined) { this.stats.skippedLinks += 1; continue; }

        const typeId = sct.getConceptId(rel.relType);
        if (typeId === IS_A_TYPE_ID) {
          // Hierarchy convention: source = child, target = parent.
          this.writer.addLink({
            edgeSetId: EDGE_SET_INFERRED,
            sourceId,
            propertyId: this.isAPropertyId,
            targetId,
            groupId: rel.group,
            active: rel.active,
          });
          this.stats.isaLinks += 1;
        } else if (typeId) {
          this.writer.addLink({
            edgeSetId: EDGE_SET_INFERRED,
            sourceId,
            propertyId: this._attributeProperty(typeId),
            targetId,
            groupId: rel.group,
            active: rel.active,
          });
          this.stats.attributeLinks += 1;
        }
      }
    }

    this.log(
      `Relationships: is-a=${this.stats.isaLinks.toLocaleString()}, ` +
      `attribute=${this.stats.attributeLinks.toLocaleString()}, ` +
      `skipped(absent target)=${this.stats.skippedLinks.toLocaleString()}`
    );
  }

  // ---- refsets -> value_set / value_set_member -----------------------------
  //
  // A refset whose members ALL reference concepts (every member ref is a valid
  // concept byte-offset) becomes a value_set at ?fhir_vs=refset/{id}. Refsets
  // whose members reference descriptions (language refsets, description
  // inactivation, ...) are skipped -- their referencedComponentId is a
  // descriptionId that never maps to a concept, exactly as the RF2 importer.
  // (The .cache does not preserve the RF2 refset file TYPE, so -- like the cache
  //  oracle's ?fhir_vs=refset/{id} -- ANY concept-referencing refset is exposed,
  //  not only der2_Refset_Simple.)

  _importRefsets() {
    const sct = this.sct;
    const conceptBlobLength = sct.concepts.length;

    for (let i = 0; i < sct.refSetIndex.count(); i++) {
      const rs = sct.refSetIndex.getReferenceSet(i);
      if (!rs.membersByRef || rs.membersByRef === 0xffffffff) continue;
      const members = sct.refSetMembers.getMembers(rs.membersByRef);
      if (!members || members.length === 0) continue;

      let referencesConcepts = true;
      for (const m of members) {
        if (m.ref % CONCEPT_SIZE !== 0 || m.ref >= conceptBlobLength) {
          referencesConcepts = false;
          break;
        }
      }
      if (!referencesConcepts) { this.stats.skippedDescriptionRefsets += 1; continue; }

      const refsetId = sct.getConceptId(rs.definition);
      let vsId;
      for (const m of members) {
        const conceptId = this.conceptIdByIndex.get(m.ref);
        if (conceptId === undefined) continue;
        if (vsId === undefined) {
          vsId = this.writer.addValueSet(this.csId, {
            url: `${BASE_URI}?fhir_vs=refset/${refsetId}`,
            version: this.version,
            name: `SNOMED CT Refset ${refsetId}`,
          });
          this.stats.valueSets += 1;
        }
        this.writer.addValueSetMember(vsId, conceptId, true);
        this.stats.refsetMembers += 1;
      }
    }

    this.log(
      `Refsets: ${this.stats.valueSets.toLocaleString()} value sets, ` +
      `${this.stats.refsetMembers.toLocaleString()} members ` +
      `(skipped ${this.stats.skippedDescriptionRefsets.toLocaleString()} description-referenced refsets)`
    );
  }

  // ---- cs_config (identical to import-sct-sqlite-v1._writeCsConfig) --------

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
    // The reference reports a filter/hierarchy miss on $validate-code as a bare
    // "not found in the value set" message, with no "not in the specified
    // filter" preamble — same as LOINC. Silence the filter-locate-miss text.
    set('filterLocateMiss', 'silent');
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
// Optional direct CLI: node import-sct-cache-sqlite-v1.module.js -s <cache> -d <db> [-u <uri>] [--overwrite]
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const opt = (long, short) => {
      const idx = argv.findIndex((a) => a === long || a === short);
      return idx >= 0 ? argv[idx + 1] : undefined;
    };
    const config = {
      source: opt('--source', '-s'),
      dest: opt('--dest', '-d'),
      uri: opt('--uri', '-u') || null,
      overwrite: argv.includes('--overwrite'),
      verbose: true,
    };
    if (!config.source || !config.dest) {
      // eslint-disable-next-line no-console
      console.error('usage: node import-sct-cache-sqlite-v1.module.js -s <cache> -d <dest.db> [-u <uri>] [--overwrite]');
      process.exit(2);
    }
    const importer = new SnomedCacheSqliteV1Importer(config);
    const result = await importer.run();
    // eslint-disable-next-line no-console
    console.log(`OK: ${path.basename(config.dest)} — ${JSON.stringify(result.stats)}`);
  })().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  SnomedCacheSqliteV1Module,
  SnomedCacheSqliteV1Importer,
  constants: {
    BASE_URI,
    IS_A_TYPE_ID,
    FSN_TYPE_ID,
    TEXT_DEFINITION_TYPE_ID,
    EN_US_LANGUAGE_REFSET,
    ACCEPTABILITY_PREFERRED,
    EDGE_SET_INFERRED,
    INTERNATIONAL_MODULE,
    US_MODULE,
  },
};
