'use strict';

// LOINC importer for the shared sqlite-v1 terminology schema.
//
// Streams the LOINC CSV distribution (Loinc.csv + AccessoryFiles) into a
// sqlite-v1 database using the shared writer (tx/importers/sqlite-v1-core.js).
// Per-terminology behavior is written as data (cs_config rows + property_def
// metadata); the generic provider only reads it back.
//
// Data mapping is reproduced from the v0 draft importer
// (import-loinc-sqlite-v0.module.js), adapted to the v1 schema deltas:
//   * property_def now carries `uri` + `fhir_type` (no source_type);
//   * designation carries `use_system` (v0 only kept use_code);
//   * closure is derived by writer.buildClosure from child->parent is_hierarchy
//     links (no PATH_TO_ROOT self-rows; no self rows at all);
//   * answer lists are materialized as value_set / value_set_member rows and
//     surfaced through cs_config implicitValueSets (vs-table http://loinc.org/vs/{code}).
//
// See docs/sqlite-v1-design.md for the semantics rules and the cs_config key
// registry, and tx/importers/schema-v1.sql for the target schema.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { BaseTerminologyModule } = require('./tx-import-base');
const { openV1Database, V1Writer } = require('./sqlite-v1-core');

const BASE_URI = 'http://loinc.org';
const PROPERTY_URI_BASE = 'http://loinc.org/property';
const DESIGNATION_USE_SYSTEM = BASE_URI;
const PARENT_PROPERTY_CODE = 'parent';
const EDGE_SET_PRIMARY = 1;
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_VERSION = '2.82';

// LOINC main-file columns that carry a link to a Part concept (LoincPartLink).
// These are the concept-valued (code) properties. Order mirrors v0.
const PART_TYPE_PROPERTIES = [
  'COMPONENT',
  'PROPERTY',
  'TIME_ASPCT',
  'SYSTEM',
  'SCALE_TYP',
  'METHOD_TYP',
  'CLASS',
  'DOCUMENT.TYPEOFSETTING',
  'DOCUMENT.TYPEOFSERVICE',
  'DOCUMENT.ROLE',
  'DOCUMENT.SUBJECT',
  'DOCUMENT.KIND',
  'SUPER.SYSTEM',
  'RAD.ANATOMIC.LOCATION',
  'RAD.ANATOMIC.LOCATION.LATERALITY',
  'RAD.ANATOMIC.LOCATION.REGION.IMAGED',
  'RAD.GUIDANCE.FOR.ACTION',
  'RAD.GUIDANCE.FOR.APPROACH',
  'RAD.MANEUVER.MANEUVER.TYPE',
  'RAD.MODALITY.MODALITY.SUBTYPE',
  'RAD.MODALITY.MODALITY.TYPE',
  'RAD.PHARMACEUTICAL.ROUTE',
  'RAD.PHARMACEUTICAL.SUBSTANCE.GIVEN',
  'RAD.REASON.FOR.EXAM',
  'RAD.TIMING',
  'RAD.VIEW.AGGREGATION',
  'RAD.VIEW.VIEW.TYPE',
  'CHALLENGE',
  'ADJUSTMENT',
  'COUNT',
  'DIVISOR',
  'TIME.MODIFIER',
  'SUFFIX'
];

// LoincPartLink PartTypeName values that need mapping onto the Loinc.csv
// column property codes.
const PART_TYPE_NORMALIZATION = {
  TIME: 'TIME_ASPCT',
  SCALE: 'SCALE_TYP',
  METHOD: 'METHOD_TYP'
};

// Loinc.csv columns copied verbatim as literal properties, with their v1
// fhir_type. Everything is `string` except the small typed set below; the
// typed projections (value_num / value_bool) fall out of fhir_type in the
// writer (sqlite-v1-core addLiteral).
const LITERAL_COLUMN_MAP = [
  { property: 'CLASS', column: 'CLASS', fhirType: 'string' },
  { property: 'COMPONENT', column: 'COMPONENT', fhirType: 'string' },
  { property: 'PROPERTY', column: 'PROPERTY', fhirType: 'string' },
  { property: 'TIME_ASPCT', column: 'TIME_ASPCT', fhirType: 'string' },
  { property: 'SYSTEM', column: 'SYSTEM', fhirType: 'string' },
  { property: 'SCALE_TYP', column: 'SCALE_TYP', fhirType: 'string' },
  { property: 'METHOD_TYP', column: 'METHOD_TYP', fhirType: 'string' },
  { property: 'ORDER_OBS', column: 'ORDER_OBS', fhirType: 'string' },
  { property: 'CLASSTYPE', column: 'CLASSTYPE', fhirType: 'integer' },
  { property: 'STATUS', column: 'STATUS', fhirType: 'code' },
  { property: 'EXAMPLE_UNITS', column: 'EXAMPLE_UNITS', fhirType: 'string' },
  { property: 'EXAMPLE_UCUM_UNITS', column: 'EXAMPLE_UCUM_UNITS', fhirType: 'string' },
  { property: 'UNITSREQUIRED', column: 'UNITSREQUIRED', fhirType: 'boolean' },
  { property: 'FORMULA', column: 'FORMULA', fhirType: 'string' },
  { property: 'SURVEY_QUEST_TEXT', column: 'SURVEY_QUEST_TEXT', fhirType: 'string' },
  { property: 'DefinitionDescription', column: 'DefinitionDescription', fhirType: 'string' },
  { property: 'EXTERNAL_COPYRIGHT_NOTICE', column: 'EXTERNAL_COPYRIGHT_NOTICE', fhirType: 'string' },
  { property: 'RELATEDNAMES2', column: 'RELATEDNAMES2', fhirType: 'string' }
];

// Designation "use" codes (LOINC-defined), mapped to a full coding via
// DESIGNATION_USE_SYSTEM so the v1 designation.use_system survives.
const DESIGNATION_USES = {
  LONG_COMMON_NAME: 'Long common name',
  SHORTNAME: 'Short name',
  DisplayName: 'Display name',
  ConsumerName: 'Consumer name',
  LinguisticVariantDisplayName: 'Linguistic variant display name'
};

// --------------------------------------------------------------------------
// CLI module (auto-discovered by tx-import.js via the *.module.js convention)
// --------------------------------------------------------------------------

class LoincSqliteV1Module extends BaseTerminologyModule {
  getName() {
    return 'loinc-sqlite-v1';
  }

  getDescription() {
    return 'LOINC CSV -> shared sqlite-v1 terminology schema';
  }

  getSupportedFormats() {
    return ['csv', 'directory', 'zip'];
  }

  getEstimatedDuration() {
    return '10-90 minutes (depends on release size and closure)';
  }

  getDefaultConfig() {
    return { verbose: true, overwrite: false, dest: './data/loinc-sqlite-v1.db' };
  }

  registerCommands(terminologyCommand, globalOptions) {
    terminologyCommand
      .command('import')
      .description('Import a LOINC CSV distribution into the sqlite-v1 schema')
      .option('-s, --source <path>', 'Source directory or LOINC .zip release')
      .option('-d, --dest <file>', 'Destination SQLite file')
      .option('-v, --loinc-version <version>', 'LOINC version (e.g., 2.82)')
      .option('-u, --uri <uri>', 'Canonical (versioned) URI; overrides base|version')
      .option('--release-date <date>', 'Release date YYYY-MM-DD')
      .option('--max-rows <n>', 'Cap Loinc.csv rows loaded (smoke testing)')
      .option('--limit <n>', 'Alias for --max-rows')
      .option('--overwrite', 'Overwrite destination database if it exists')
      .option('-y, --yes', 'Skip confirmations')
      .action(async (options) => {
        await this.handleImportCommand({ ...globalOptions, ...options });
      });

    terminologyCommand
      .command('validate')
      .description('Validate a LOINC source path and list discovered CSV files')
      .option('-s, --source <path>', 'Source directory or zip file')
      .action(async (options) => {
        await this.handleValidateCommand({ ...globalOptions, ...options });
      });
  }

  async handleImportCommand(options) {
    const config = options.yes
      ? this.buildNonInteractiveConfig(options)
      : await this.gatherConfig(options);

    if (!options.yes) {
      const confirmed = await this.confirmImport(config);
      if (!confirmed) {
        this.logInfo('Import cancelled');
        return;
      }
    }

    await this.runImport(config);
  }

  async gatherConfig(options) {
    const base = await this.gatherCommonConfig(options);
    return {
      ...base,
      version: options.loincVersion || options.version || detectVersionFromPath(base.source) || DEFAULT_VERSION,
      uri: options.uri || base.uri || null,
      releaseDate: options.releaseDate || base.releaseDate || null,
      maxRows: parseMaxRows(options.maxRows ?? options.limit),
      overwrite: !!(options.overwrite || base.overwrite)
    };
  }

  buildNonInteractiveConfig(options) {
    if (!options.source) {
      throw new Error('source is required when using --yes');
    }
    return {
      ...this.getDefaultConfig(),
      ...options,
      source: options.source,
      dest: options.dest || this.getDefaultConfig().dest,
      version: options.loincVersion || options.version || detectVersionFromPath(options.source) || DEFAULT_VERSION,
      uri: options.uri || null,
      releaseDate: options.releaseDate || null,
      maxRows: parseMaxRows(options.maxRows ?? options.limit),
      overwrite: !!options.overwrite,
      verbose: !!options.verbose
    };
  }

  async confirmImport(config) {
    const chalk = require('chalk');
    const inquirer = require('inquirer');
    console.log(chalk.cyan(`\n📋 ${this.getName()} Import Configuration:`));
    console.log(`  Source:       ${chalk.white(config.source)}`);
    console.log(`  Destination:  ${chalk.white(config.dest)}`);
    console.log(`  Version:      ${chalk.white(config.version || '(auto)')}`);
    console.log(`  Max rows:     ${chalk.white(config.maxRows ? config.maxRows.toLocaleString() : '(all)')}`);
    console.log(`  Overwrite:    ${chalk.white(config.overwrite ? 'Yes' : 'No')}`);
    const { confirmed } = await inquirer.prompt({
      type: 'confirm', name: 'confirmed', message: 'Proceed with import?', default: true
    });
    return confirmed;
  }

  async handleValidateCommand(options) {
    const source = options.source;
    if (!source || !fs.existsSync(source)) {
      this.logError(`Source does not exist: ${source}`);
      return;
    }
    const files = discoverLoincFiles(path.resolve(source));
    console.log('\nDiscovered LOINC files:');
    console.log(`  Loinc.csv:                  ${files.loinc || '(missing)'}`);
    console.log(`  Part.csv:                   ${files.part || '(missing)'}`);
    console.log(`  LoincPartLink_Primary.csv:  ${files.partLink || '(missing)'}`);
    console.log(`  ComponentHierarchyBySystem: ${files.hierarchy || '(missing)'}`);
    console.log(`  AnswerList.csv:             ${files.answerList || '(missing)'}`);
    console.log(`  LoincAnswerListLink.csv:    ${files.answerListLink || '(missing)'}`);
    console.log(`  ConsumerName.csv:           ${files.consumerName || '(missing)'}`);
    console.log(`  LinguisticVariants:         ${files.linguisticVariants.length}`);
    if (!files.loinc) {
      this.logError('Validation failed: Loinc.csv is required');
      return;
    }
    this.logSuccess('Validation passed');
  }

  async validatePrerequisites(config) {
    const baseOk = await super.validatePrerequisites(config);
    const files = discoverLoincFiles(path.resolve(config.source));
    if (!files.loinc) {
      this.logError('Loinc.csv was not found under the source path');
      return false;
    }
    this.logSuccess('Loinc.csv located');
    return baseOk;
  }

  async executeImport(config) {
    const importer = new LoincV1Importer(config, {
      log: (msg) => this.logInfo(msg)
    });
    const result = await importer.run();
    this.logSuccess(
      `Concepts: ${result.stats.concepts.toLocaleString()}, ` +
      `Designations: ${result.stats.designations.toLocaleString()}, ` +
      `Links: ${result.stats.links.toLocaleString()}, ` +
      `Literals: ${result.stats.literals.toLocaleString()}, ` +
      `ValueSets: ${result.stats.valueSets.toLocaleString()}, ` +
      `Closure: ${result.stats.closureRows.toLocaleString()}`
    );
  }
}

// --------------------------------------------------------------------------
// Importer (usable directly, e.g. from the Jest test)
// --------------------------------------------------------------------------

class LoincV1Importer {
  /**
   * @param {object} config { source, dest, version, uri, releaseDate, maxRows, overwrite, verbose }
   * @param {object} [hooks] { log }
   */
  constructor(config = {}, hooks = {}) {
    const detected = detectVersionFromPath(config.source);
    this.config = {
      source: config.source,
      dest: config.dest,
      version: config.version || detected || DEFAULT_VERSION,
      uri: config.uri || null,
      releaseDate: config.releaseDate || null,
      maxRows: parseMaxRows(config.maxRows),
      overwrite: !!config.overwrite,
      verbose: config.verbose !== false
    };
    if (!this.config.uri) {
      this.config.uri = `${BASE_URI}|${this.config.version}`;
    }
    this.log = hooks.log || ((msg) => { if (this.config.verbose) console.log(msg); });

    this.db = null;
    this.writer = null;
    this.csId = null;
    this.sourceRoot = null;
    this.extractedTempDir = null;

    // property_code -> property_id
    this.propByCode = new Map();
    this.hierarchyPropertyId = null;

    // Which codes we actually loaded as concepts (for filtering accessories to
    // the maxRows-capped set).
    this.loadedCodes = new Set();

    // code -> concept.active (1/0), to type designations without a re-query.
    this.activeByCode = new Map();

    // LOINC main code -> CLASS name (upper), for the CLASS -> class-part link.
    this.loincClassByCode = new Map();
    // CLASS part name (upper) -> PartNumber.
    this.classPartByName = new Map();

    this.stats = {
      concepts: 0, mainCodes: 0, parts: 0, answerLists: 0, answers: 0,
      designations: 0, links: 0, literals: 0,
      valueSets: 0, valueSetMembers: 0, closureRows: 0
    };
  }

  async run() {
    if (!this.config.source || !this.config.dest) {
      throw new Error('source and dest are required');
    }

    await this.prepareSource();
    const files = discoverLoincFiles(this.sourceRoot);
    if (!files.loinc) {
      throw new Error('Loinc.csv was not found');
    }
    this.log(
      `Discovered: Loinc=${yn(files.loinc)}, Part=${yn(files.part)}, ` +
      `PartLink=${yn(files.partLink)}, Hierarchy=${yn(files.hierarchy)}, ` +
      `AnswerList=${yn(files.answerList)}, AnswerLink=${yn(files.answerListLink)}, ` +
      `ConsumerName=${yn(files.consumerName)}, LingVariants=${files.linguisticVariants.length}`
    );

    this.db = openV1Database(this.config.dest, { overwrite: this.config.overwrite });
    this.writer = new V1Writer(this.db);

    let auditRunId = null;
    try {
      auditRunId = this.writer.beginAudit({
        sourcePath: this.config.source,
        targetDb: this.config.dest,
        terminology: 'loinc',
        editionCode: null,
        version: this.config.version
      });

      this.createCodeSystem();
      this.defineProperties();

      await this.importPartConcepts(files);
      await this.importMainConcepts(files);
      await this.importAnswerConcepts(files);
      await this.importHierarchyNodes(files);

      await this.importHierarchyLinks(files);
      await this.importPartLinks(files);
      this.importClassLinks();
      await this.importAnswerLinksAndValueSets(files);

      await this.importDesignations(files);
      await this.importLiterals(files);

      this.writeCsConfig(files);

      this.log('Building transitive closure...');
      this.stats.closureRows = this.writer.buildClosure(this.csId, { edgeSetId: EDGE_SET_PRIMARY });
      this.log(`Closure complete: ${this.stats.closureRows.toLocaleString()} rows`);

      this.log('Building search index...');
      this.writer.buildSearchIndex(this.csId);

      this.writer.finalize({ caseSensitive: true });
      this.writer.finishAudit(auditRunId, { status: 'success', stats: this.stats });
    } catch (error) {
      if (this.writer && auditRunId) {
        try {
          this.writer.finishAudit(auditRunId, {
            status: 'failed',
            stats: { ...this.stats, error: error.message }
          });
        } catch (_ignored) { /* best effort */ }
      }
      throw error;
    } finally {
      if (this.db && this.db.open) {
        this.db.close();
      }
      await this.cleanupSource();
    }

    return { csId: this.csId, uri: this.config.uri, stats: this.stats };
  }

  // ---- source prep --------------------------------------------------------

  async prepareSource() {
    const src = path.resolve(this.config.source);
    if (!fs.existsSync(src)) {
      throw new Error(`Source does not exist: ${src}`);
    }
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      this.sourceRoot = src;
      return;
    }
    if (!stat.isFile() || !src.toLowerCase().endsWith('.zip')) {
      throw new Error('Source must be a LOINC directory or a .zip file');
    }
    this.extractedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loinc-sqlite-v1-'));
    this.log(`Extracting ${src} to ${this.extractedTempDir} ...`);
    execFileSync('unzip', ['-q', src, '-d', this.extractedTempDir], { stdio: 'pipe' });
    this.sourceRoot = this.extractedTempDir;
  }

  async cleanupSource() {
    if (this.extractedTempDir && fs.existsSync(this.extractedTempDir)) {
      fs.rmSync(this.extractedTempDir, { recursive: true, force: true });
    }
    this.extractedTempDir = null;
    this.sourceRoot = null;
  }

  // ---- code system + property registry ------------------------------------

  createCodeSystem() {
    this.csId = this.writer.codeSystem({
      baseUri: BASE_URI,
      editionCode: null,
      version: this.config.version,
      canonicalUri: this.config.uri,
      releaseDate: this.config.releaseDate,
      name: 'LOINC',
      title: 'Logical Observation Identifiers Names and Codes (LOINC)',
      description: 'LOINC imported from the CSV distribution into sqlite-v1.',
      contentMode: 'complete',
      sourceKind: 'loinc-sqlite-v1'
    });
  }

  defineProp(spec) {
    const id = this.writer.defineProperty(this.csId, spec);
    this.propByCode.set(spec.code, id);
    return id;
  }

  defineProperties() {
    // Hierarchy edge property (child -> parent).
    this.hierarchyPropertyId = this.defineProp({
      code: PARENT_PROPERTY_CODE,
      uri: `${PROPERTY_URI_BASE}/${PARENT_PROPERTY_CODE}`,
      fhirType: 'code', valueKind: 'concept', isHierarchy: true, display: 'parent'
    });

    // Concept-valued part-type properties.
    for (const code of PART_TYPE_PROPERTIES) {
      this.defineProp({
        code, uri: `${PROPERTY_URI_BASE}/${code}`,
        fhirType: 'code', valueKind: 'concept', isHierarchy: false, display: code
      });
    }

    // Literal properties copied from Loinc.csv columns.
    for (const item of LITERAL_COLUMN_MAP) {
      this.defineProp({
        code: item.property, uri: `${PROPERTY_URI_BASE}/${item.property}`,
        fhirType: item.fhirType, valueKind: 'literal', isHierarchy: false, display: item.property
      });
    }

    // Answer-list machinery.
    this.defineProp({
      code: 'LIST', uri: `${PROPERTY_URI_BASE}/LIST`,
      fhirType: 'string', valueKind: 'literal', isHierarchy: false, display: 'LIST'
    });
    this.defineProp({
      code: 'Answer', uri: `${PROPERTY_URI_BASE}/Answer`,
      fhirType: 'code', valueKind: 'concept', isHierarchy: false, display: 'Answer'
    });
    this.defineProp({
      code: 'answers-for', uri: `${PROPERTY_URI_BASE}/answers-for`,
      fhirType: 'code', valueKind: 'concept', isHierarchy: false, display: 'answers-for'
    });
    this.defineProp({
      code: 'AnswerList', uri: `${PROPERTY_URI_BASE}/AnswerList`,
      fhirType: 'code', valueKind: 'concept', isHierarchy: false, display: 'AnswerList'
    });
  }

  // ---- concepts -----------------------------------------------------------

  addConceptOnce(code, spec) {
    if (this.writer.conceptId(this.csId, code) !== undefined) {
      return this.writer.conceptId(this.csId, code);
    }
    const id = this.writer.addConcept(this.csId, { code, ...spec });
    this.loadedCodes.add(code);
    this.activeByCode.set(code, (spec.active === undefined ? true : !!spec.active) ? 1 : 0);
    this.stats.concepts += 1;
    return id;
  }

  async importPartConcepts(files) {
    if (!files.part) return;
    this.log('Importing part concepts...');
    for await (const row of readCsv(files.part)) {
      const code = trim(row.PartNumber);
      if (!code) continue;

      // Track CLASS parts so main COMPONENT/CLASS links can resolve names.
      const partTypeName = trim(row.PartTypeName);
      const partName = trim(row.PartName);
      if (partTypeName === 'CLASS' && partName) {
        this.classPartByName.set(partName.toUpperCase(), code);
      }

      if (this.writer.conceptId(this.csId, code) !== undefined) continue;

      const display = trim(row.PartName) || trim(row.PartDisplayName) || code;
      const status = normalizeLoincStatus(row.Status, null);
      const active = isActiveLoincStatus(status);
      this.addConceptOnce(code, { active, display });
      this.stats.parts += 1;
    }
    this.log(`Part concepts: ${this.stats.parts.toLocaleString()}`);
  }

  async importMainConcepts(files) {
    this.log('Importing main LOINC concepts...');
    let n = 0;
    for await (const row of readCsv(files.loinc)) {
      if (this.config.maxRows && n >= this.config.maxRows) break;
      const code = trim(row.LOINC_NUM);
      if (!code) continue;
      n += 1;

      const display = trim(row.LONG_COMMON_NAME) || trim(row.DisplayName) || trim(row.SHORTNAME) || code;
      const definition = trim(row.DefinitionDescription) || null;
      const status = normalizeLoincStatus(row.STATUS, 'ACTIVE');
      const active = isActiveLoincStatus(status);

      // A LOINC_NUM should not collide with a Part number, but guard anyway.
      if (this.writer.conceptId(this.csId, code) === undefined) {
        this.addConceptOnce(code, { active, display, definition });
        this.stats.mainCodes += 1;
      }

      const className = trim(row.CLASS);
      if (className) {
        this.loincClassByCode.set(code, className.toUpperCase());
      }
    }
    this.log(`Main concepts: ${this.stats.mainCodes.toLocaleString()} (of ${n.toLocaleString()} rows scanned)`);
  }

  async importAnswerConcepts(files) {
    if (!files.answerList) return;
    this.log('Importing answer-list + answer concepts...');
    for await (const row of readCsv(files.answerList)) {
      const listCode = trim(row.AnswerListId);
      if (listCode && this.writer.conceptId(this.csId, listCode) === undefined) {
        const display = trim(row.AnswerListName) || listCode;
        const definition = trim(row.Description) || null;
        this.addConceptOnce(listCode, { active: true, display, definition });
        this.stats.answerLists += 1;
      }
      const answerCode = trim(row.AnswerStringId);
      if (answerCode && this.writer.conceptId(this.csId, answerCode) === undefined) {
        const display = trim(row.DisplayText) || answerCode;
        const definition = trim(row.Description) || null;
        this.addConceptOnce(answerCode, { active: true, display, definition });
        this.stats.answers += 1;
      }
    }
    this.log(`Answer lists: ${this.stats.answerLists.toLocaleString()}, answers: ${this.stats.answers.toLocaleString()}`);
  }

  // ---- hierarchy + links --------------------------------------------------

  // ComponentHierarchyBySystem introduces intermediate CODE / IMMEDIATE_PARENT
  // nodes that are not LOINC main codes or Parts (e.g. axis roots). v0 created
  // these as concepts so the multiaxial hierarchy is connected; do the same,
  // marking them active with CODE_TEXT as display.
  async importHierarchyNodes(files) {
    if (!files.hierarchy) return;
    let added = 0;
    for await (const row of readCsv(files.hierarchy)) {
      const code = trim(row.CODE);
      if (code && this.writer.conceptId(this.csId, code) === undefined) {
        this.addConceptOnce(code, { active: true, display: trim(row.CODE_TEXT) || code });
        added += 1;
      }
      const parent = trim(row.IMMEDIATE_PARENT);
      if (parent && this.writer.conceptId(this.csId, parent) === undefined) {
        this.addConceptOnce(parent, { active: true, display: parent });
        added += 1;
      }
    }
    if (added) this.log(`Hierarchy filler concepts: ${added.toLocaleString()}`);
  }

  async importHierarchyLinks(files) {
    if (!files.hierarchy) return;
    this.log('Importing multiaxial hierarchy links (child -> parent)...');
    let n = 0;
    for await (const row of readCsv(files.hierarchy)) {
      const childCode = trim(row.CODE);
      const parentCode = trim(row.IMMEDIATE_PARENT);
      if (!childCode || !parentCode || childCode === parentCode) continue;
      const childId = this.writer.conceptId(this.csId, childCode);
      const parentId = this.writer.conceptId(this.csId, parentCode);
      if (childId === undefined || parentId === undefined) continue;
      this.writer.addLink({
        sourceId: childId, propertyId: this.hierarchyPropertyId, targetId: parentId,
        edgeSetId: EDGE_SET_PRIMARY
      });
      this.stats.links += 1;
      n += 1;
    }
    this.log(`Hierarchy links: ${n.toLocaleString()}`);
  }

  async importPartLinks(files) {
    if (!files.partLink) return;
    this.log('Importing LoincPartLink concept properties...');
    let n = 0;
    for await (const row of readCsv(files.partLink)) {
      const sourceCode = trim(row.LoincNumber);
      const targetCode = trim(row.PartNumber);
      const partTypeRaw = trim(row.PartTypeName);
      const partType = PART_TYPE_NORMALIZATION[partTypeRaw] || partTypeRaw;
      if (!sourceCode || !targetCode || !partType) continue;
      const propertyId = this.propByCode.get(partType);
      if (!propertyId) continue;
      const sourceId = this.writer.conceptId(this.csId, sourceCode);
      const targetId = this.writer.conceptId(this.csId, targetCode);
      if (sourceId === undefined || targetId === undefined) continue;
      this.writer.addLink({ sourceId, propertyId, targetId, edgeSetId: EDGE_SET_PRIMARY });
      this.stats.links += 1;
      n += 1;
    }
    this.log(`Part links: ${n.toLocaleString()}`);
  }

  importClassLinks() {
    const classPropertyId = this.propByCode.get('CLASS');
    if (!classPropertyId) return;
    let n = 0;
    for (const [loincCode, className] of this.loincClassByCode.entries()) {
      const classPartCode = this.classPartByName.get(className);
      if (!classPartCode) continue;
      const sourceId = this.writer.conceptId(this.csId, loincCode);
      const targetId = this.writer.conceptId(this.csId, classPartCode);
      if (sourceId === undefined || targetId === undefined) continue;
      this.writer.addLink({ sourceId, propertyId: classPropertyId, targetId, edgeSetId: EDGE_SET_PRIMARY });
      this.stats.links += 1;
      n += 1;
    }
    if (n) this.log(`CLASS links: ${n.toLocaleString()}`);
  }

  async importAnswerLinksAndValueSets(files) {
    // list -> answer links, plus a value_set per answer list with its answers
    // as members (implicit VS http://loinc.org/vs/{AnswerListId}).
    const answerPropertyId = this.propByCode.get('Answer');
    if (answerPropertyId && files.answerList) {
      this.log('Importing answer-list membership (links + value sets)...');
      const vsByList = new Map(); // listCode -> vsId
      let links = 0;
      for await (const row of readCsv(files.answerList)) {
        const listCode = trim(row.AnswerListId);
        const answerCode = trim(row.AnswerStringId);
        if (!listCode || !answerCode) continue;
        const listId = this.writer.conceptId(this.csId, listCode);
        const answerId = this.writer.conceptId(this.csId, answerCode);
        if (listId === undefined || answerId === undefined) continue;

        // list --Answer--> answer link (parity with v0).
        this.writer.addLink({
          sourceId: listId, propertyId: answerPropertyId, targetId: answerId,
          edgeSetId: EDGE_SET_PRIMARY
        });
        this.stats.links += 1;
        links += 1;

        // Materialize the answer list as a value set.
        let vsId = vsByList.get(listCode);
        if (vsId === undefined) {
          vsId = this.writer.addValueSet(this.csId, {
            url: `${BASE_URI}/vs/${listCode}`,
            version: this.config.version,
            name: trim(row.AnswerListName) || listCode
          });
          vsByList.set(listCode, vsId);
          this.stats.valueSets += 1;
        }
        this.writer.addValueSetMember(vsId, answerId);
        this.stats.valueSetMembers += 1;
      }
      this.log(`Answer links: ${links.toLocaleString()}, value sets: ${this.stats.valueSets.toLocaleString()}`);
    }

    // answer list --answers-for--> loinc code, and LIST literal on each answer.
    const answersForPropertyId = this.propByCode.get('answers-for');
    if (answersForPropertyId && files.answerListLink) {
      let n = 0;
      for await (const row of readCsv(files.answerListLink)) {
        const loincCode = trim(row.LoincNumber);
        const listCode = trim(row.AnswerListId);
        if (!loincCode || !listCode) continue;
        const loincId = this.writer.conceptId(this.csId, loincCode);
        const listId = this.writer.conceptId(this.csId, listCode);
        if (loincId === undefined || listId === undefined) continue;
        // Convention (parity with v0): source = answer list, target = loinc code.
        this.writer.addLink({
          sourceId: listId, propertyId: answersForPropertyId, targetId: loincId,
          edgeSetId: EDGE_SET_PRIMARY
        });
        this.stats.links += 1;
        n += 1;
      }
      if (n) this.log(`answers-for links: ${n.toLocaleString()}`);
    }
  }

  // ---- designations -------------------------------------------------------

  addDesignation(conceptId, active, language, useCode, term, preferred) {
    if (!term) return;
    this.writer.addDesignation(conceptId, {
      active,
      language,
      useSystem: DESIGNATION_USE_SYSTEM,
      useCode,
      term,
      preferred
    });
    this.stats.designations += 1;
  }

  async importDesignations(files) {
    this.log('Importing designations + linguistic variants...');

    // Main file: en-US designations. LONG_COMMON_NAME is the preferred term.
    let n = 0;
    for await (const row of readCsv(files.loinc)) {
      if (this.config.maxRows && n >= this.config.maxRows) break;
      const code = trim(row.LOINC_NUM);
      if (!code) continue;
      n += 1;
      const conceptId = this.writer.conceptId(this.csId, code);
      if (conceptId === undefined) continue;
      const active = this.conceptActive(code);

      const longName = trim(row.LONG_COMMON_NAME);
      this.addDesignation(conceptId, active, DEFAULT_LANGUAGE, 'LONG_COMMON_NAME', longName, true);
      this.addDesignation(conceptId, active, DEFAULT_LANGUAGE, 'SHORTNAME', trim(row.SHORTNAME), false);
      const displayName = trim(row.DisplayName);
      if (displayName && displayName !== longName) {
        this.addDesignation(conceptId, active, DEFAULT_LANGUAGE, 'DisplayName', displayName, false);
      }
      this.addDesignation(conceptId, active, DEFAULT_LANGUAGE, 'ConsumerName', trim(row.CONSUMER_NAME), false);
    }

    // ConsumerName accessory file.
    if (files.consumerName) {
      for await (const row of readCsv(files.consumerName)) {
        const code = trim(row.LoincNumber);
        const conceptId = this.writer.conceptId(this.csId, code);
        const consumer = trim(row.ConsumerName);
        if (conceptId === undefined || !consumer) continue;
        this.addDesignation(conceptId, this.conceptActive(code), DEFAULT_LANGUAGE, 'ConsumerName', consumer, false);
      }
    }

    // Linguistic variants (one language per file).
    for (const variantFile of files.linguisticVariants) {
      const lang = languageFromVariantFilename(path.basename(variantFile));
      if (!lang) continue;
      for await (const row of readCsv(variantFile)) {
        const code = trim(row.LOINC_NUM);
        const conceptId = this.writer.conceptId(this.csId, code);
        if (conceptId === undefined) continue;
        const active = this.conceptActive(code);
        this.addDesignation(conceptId, active, lang, 'LONG_COMMON_NAME', trim(row.LONG_COMMON_NAME), false);
        this.addDesignation(conceptId, active, lang, 'SHORTNAME', trim(row.SHORTNAME), false);
        this.addDesignation(conceptId, active, lang, 'LinguisticVariantDisplayName',
          trim(row.LinguisticVariantDisplayName), false);
      }
    }

    // Part display names as en-US designations.
    if (files.part) {
      for await (const row of readCsv(files.part)) {
        const code = trim(row.PartNumber);
        const conceptId = this.writer.conceptId(this.csId, code);
        if (conceptId === undefined) continue;
        const display = trim(row.PartDisplayName) || trim(row.PartName);
        this.addDesignation(conceptId, this.conceptActive(code), DEFAULT_LANGUAGE, 'DisplayName', display, false);
      }
    }

    this.log(`Designations: ${this.stats.designations.toLocaleString()}`);
  }

  conceptActive(code) {
    // concept.active as recorded during concept import (default active).
    return this.activeByCode.has(code) ? !!this.activeByCode.get(code) : true;
  }

  // ---- literals -----------------------------------------------------------

  async importLiterals(files) {
    this.log('Importing literal properties...');

    let n = 0;
    for await (const row of readCsv(files.loinc)) {
      if (this.config.maxRows && n >= this.config.maxRows) break;
      const code = trim(row.LOINC_NUM);
      if (!code) continue;
      n += 1;
      const conceptId = this.writer.conceptId(this.csId, code);
      if (conceptId === undefined) continue;

      for (const spec of LITERAL_COLUMN_MAP) {
        const raw = spec.property === 'STATUS'
          ? normalizeLoincStatus(row.STATUS, 'ACTIVE')
          : trim(row[spec.column]);
        if (!raw) continue;
        const propertyId = this.propByCode.get(spec.property);
        if (!propertyId) continue;
        this.writer.addLiteral({
          sourceId: conceptId, propertyId, value: raw, edgeSetId: EDGE_SET_PRIMARY
        });
        this.stats.literals += 1;
      }
    }

    // STATUS literal for parts.
    const statusPropertyId = this.propByCode.get('STATUS');
    if (statusPropertyId && files.part) {
      for await (const row of readCsv(files.part)) {
        const code = trim(row.PartNumber);
        const conceptId = this.writer.conceptId(this.csId, code);
        const raw = normalizeLoincStatus(row.Status, null);
        if (conceptId === undefined || !raw) continue;
        this.writer.addLiteral({
          sourceId: conceptId, propertyId: statusPropertyId, value: raw, edgeSetId: EDGE_SET_PRIMARY
        });
        this.stats.literals += 1;
      }
    }

    // LIST literal on each answer: which answer list it belongs to.
    const listPropertyId = this.propByCode.get('LIST');
    if (listPropertyId && files.answerList) {
      for await (const row of readCsv(files.answerList)) {
        const answerCode = trim(row.AnswerStringId);
        const listCode = trim(row.AnswerListId);
        const conceptId = this.writer.conceptId(this.csId, answerCode);
        if (conceptId === undefined || !listCode) continue;
        this.writer.addLiteral({
          sourceId: conceptId, propertyId: listPropertyId, value: listCode, edgeSetId: EDGE_SET_PRIMARY
        });
        this.stats.literals += 1;
      }
    }

    this.log(`Literals: ${this.stats.literals.toLocaleString()}`);
  }

  // ---- cs_config ----------------------------------------------------------

  writeCsConfig(files) {
    const w = this.writer;
    w.setConfig(this.csId, 'caseSensitive', 1);
    w.setConfig(this.csId, 'defaultLanguage', DEFAULT_LANGUAGE);
    w.setConfig(this.csId, 'versionAlgorithm', 'natural');
    w.setConfig(this.csId, 'hierarchyMeaning', 'is-a');
    w.setConfig(this.csId, 'hierarchyEdgeSet', EDGE_SET_PRIMARY);
    w.setConfig(this.csId, 'statusProperty', 'STATUS');

    // Text search surfaces populated by buildSearchIndex.
    w.setConfig(this.csId, 'searchSources', ['display', 'designation', 'literal']);

    // VSAC-style filter aliases: LOINC `code`/`parent` map onto the hierarchy.
    w.setConfig(this.csId, 'filterAliases', { code: PARENT_PROPERTY_CODE });
    // Legacy LOINC relationship filters match the target Part's NAME
    // (SCALE_TYP=Qn, PROPERTY=Mass, ...); published ValueSets depend on it.
    w.setConfig(this.csId, 'conceptFilterMatch', 'code-or-display');

    // Implicit value sets: all-of-LOINC + one vs-table per answer list.
    const implicit = [
      { pattern: `${BASE_URI}/vs`, kind: 'all' },
      { pattern: `${BASE_URI}/vs/{code}`, kind: 'vs-table' }
    ];
    if (files.hierarchy || files.partLink) {
      implicit.push({ pattern: `${BASE_URI}/vs?fhir_vs=isa/{code}`, kind: 'isa' });
    }
    w.setConfig(this.csId, 'implicitValueSets', implicit);

    // Designation use codings -> full coding via useSystem = http://loinc.org.
    w.setConfig(this.csId, 'designationUses', DESIGNATION_USES);

    w.setConfig(this.csId, 'webSource', 'https://loinc.org/{code}');
  }
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function parseMaxRows(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function detectVersionFromPath(value) {
  if (!value) return null;
  const match = String(value).match(/Loinc[_-]?(\d+\.\d+(?:\.\d+)?)/i);
  return match ? match[1] : null;
}

// LOINC status vocabulary (preserved as the STATUS literal). Only ACTIVE and
// TRIAL are considered active for concept.active (parity with v0/cs-loinc).
const LOINC_STATUS_BY_KEY = new Map([
  ['NOTSTATED', 'NotStated'],
  ['ACTIVE', 'ACTIVE'],
  ['DEPRECATED', 'DEPRECATED'],
  ['TRIAL', 'TRIAL'],
  ['DISCOURAGED', 'DISCOURAGED'],
  ['EXAMPLE', 'EXAMPLE'],
  ['PREFERRED', 'PREFERRED'],
  ['PRIMARY', 'Primary'],
  ['DOCUMENTONTOLOGY', 'DocumentOntology'],
  ['RADIOLOGY', 'Radiology'],
  ['NORMATIVE', 'NORMATIVE']
]);

function normalizeLoincStatus(status, fallback) {
  const key = String(status || '').trim().toUpperCase();
  if (!key) return fallback;
  return LOINC_STATUS_BY_KEY.get(key) || fallback;
}

function isActiveLoincStatus(status) {
  return status === 'ACTIVE' || status === 'TRIAL';
}

function trim(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function yn(value) {
  return value ? 'yes' : 'no';
}

const LOINC_FILE_NAMES = {
  'Loinc.csv': 'loinc',
  'Part.csv': 'part',
  'LoincPartLink_Primary.csv': 'partLink',
  'ComponentHierarchyBySystem.csv': 'hierarchy',
  'ConsumerName.csv': 'consumerName',
  'AnswerList.csv': 'answerList',
  'LoincAnswerListLink.csv': 'answerListLink'
};

function discoverLoincFiles(root) {
  const files = {
    loinc: null, part: null, partLink: null, hierarchy: null,
    consumerName: null, answerList: null, answerListLink: null,
    linguisticVariants: []
  };
  scanForLoincFiles(root, files);
  files.linguisticVariants.sort();
  return files;
}

function scanForLoincFiles(dir, files) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) scanForLoincFiles(full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const key = LOINC_FILE_NAMES[entry.name];
    if (key) {
      files[key] = full;
    } else if (entry.name.endsWith('LinguisticVariant.csv')) {
      files.linguisticVariants.push(full);
    }
  }
}

// LinguisticVariant filenames look like `arJO32LinguisticVariant.csv` ->
// BCP-47 `ar-JO`.
function languageFromVariantFilename(fileName) {
  const match = fileName.match(/^([a-z]{2})([A-Z]{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

/**
 * Stream a CSV file as an async iterable of row objects keyed by header.
 *
 * Robust to RFC-4180 quoting: fields may contain commas, embedded newlines,
 * and doubled ("") quotes. The distribution is UTF-8 with an occasional BOM on
 * the first header cell; that is stripped. Reads a chunk at a time so the whole
 * file is never resident.
 */
async function* readCsv(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 16 });
  let headers = null;
  for await (const record of parseCsvStream(stream)) {
    if (!headers) {
      headers = record.map((h, i) => (i === 0 ? h.replace(/^\uFEFF/, '') : h));
      continue;
    }
    const row = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = record[i] !== undefined ? record[i] : '';
    }
    yield row;
  }
}

/**
 * Turn a UTF-8 text stream into an async iterable of records (arrays of field
 * strings). Handles quoted fields with embedded commas / CR / LF / "" escapes,
 * carrying an incomplete field or quote state across chunk boundaries.
 */
async function* parseCsvStream(stream) {
  let field = '';
  let record = [];
  let inQuotes = false;      // inside a quoted field
  let quotePending = false;  // saw a '"' inside quotes; next char decides ("" vs close)
  let recordHasData = false; // distinguishes a real empty-line record
  let sawCR = false;         // last emitted terminator was CR (swallow a following LF)

  const pushField = () => { record.push(field); field = ''; };
  const endRecord = () => { pushField(); const r = record; record = []; recordHasData = false; return r; };

  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i += 1) {
      const c = chunk[i];

      // Swallow the LF of a CRLF pair, wherever the split falls.
      if (sawCR) {
        sawCR = false;
        if (c === '\n') continue;
      }

      if (quotePending) {
        // A '"' while inside quotes: this char tells us whether it was an
        // escaped quote ("") or the closing quote of the field.
        quotePending = false;
        if (c === '"') { field += '"'; continue; }  // escaped quote
        inQuotes = false; // field closed; fall through to process c normally
      }

      if (inQuotes) {
        if (c === '"') { quotePending = true; }
        else { field += c; }
        continue;
      }

      if (c === '"') {
        inQuotes = true;
        recordHasData = true;
      } else if (c === ',') {
        pushField();
        recordHasData = true;
      } else if (c === '\n') {
        yield endRecord();
      } else if (c === '\r') {
        sawCR = true;
        yield endRecord();
      } else {
        field += c;
        recordHasData = true;
      }
    }
  }

  // A pending quote at EOF was a closing quote.
  if (quotePending) { quotePending = false; inQuotes = false; }

  // Flush a trailing record with no final newline.
  if (field.length > 0 || record.length > 0 || recordHasData) {
    yield endRecord();
  }
}

module.exports = {
  LoincSqliteV1Module,
  LoincV1Importer,
  discoverLoincFiles,
  languageFromVariantFilename,
  normalizeLoincStatus,
  isActiveLoincStatus,
  detectVersionFromPath,
  readCsv,
  constants: {
    BASE_URI,
    PARENT_PROPERTY_CODE,
    EDGE_SET_PRIMARY,
    PART_TYPE_PROPERTIES,
    PART_TYPE_NORMALIZATION,
    LITERAL_COLUMN_MAP,
    DESIGNATION_USES
  }
};
