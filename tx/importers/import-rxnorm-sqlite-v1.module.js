'use strict';

// RxNorm RRF -> sqlite-v1 shared terminology schema importer.
//
// This is a re-staging of import-rxnorm-sqlite-v0.module.js onto the shared
// sqlite-v1 writer (tx/importers/sqlite-v1-core.js) and schema
// (tx/importers/schema-v1.sql). All database writes go through V1Writer; this
// module never touches SQL directly. Files are streamed line-by-line with
// readline so a ~1M-row RXNCONSO / multi-hundred-MB RXNREL never lands in
// memory whole.
//
// WHAT is imported (data semantics inherited from the v0 importer):
//   * Concepts:       one per RXCUI that appears with SAB=RXNORM. active=0 when
//                     the atom is SUPPRESS O/E (obsolete/editor-suppressed),
//                     else 1; a CUI is active if ANY of its RXNORM atoms is.
//   * Display:        the STR of the highest-priority-TTY RXNORM atom
//                     (TTY_PRIORITY below; PSN > SCD > SBD > ...), RXCUI as a
//                     last resort.
//   * Designations:   one per RXNORM atom with a non-empty STR. use is the atom
//                     TTY as a coding (use_system = the RxNorm base URI the v0
//                     importer used for designation use codings, use_code = TTY);
//                     language en-US; preferred=1 when TTY in PREFERRED_TTYS.
//   * TTY property:    literal 'code', the distinct TTYs a CUI carries.
//   * STY property:    literal 'string', semantic types from RXNSTY.
//   * SAB property:    literal 'code', the source abbreviation (always RXNORM,
//                     kept so $lookup can surface it like v0 surfaced TTY).
//   * RELA properties: one concept-valued ('code') property per distinct RELA
//                     seen on a SAB=RXNORM RXNREL row, linking two loaded CUIs.
//
// v1 DELTAS vs the v0 importer (documented, intentional):
//   1. NO hierarchy / NO closure. The v0 importer modelled the RELA 'isa' as an
//      is_hierarchy property and built a transitive closure. RxNorm's is-a graph
//      is not a subsumption hierarchy we serve here, and the task brief for this
//      schema states RxNorm has no hierarchy: every RELA property (including
//      'isa') is defined with isHierarchy=false and buildClosure is skipped
//      (it would return 0 anyway with no hierarchy properties).
//   2. Flat cs_config keys. v0 wrote 'runtime.*' JSON blobs; sqlite-v1 uses the
//      flat key registry from docs/sqlite-v1-design.md (caseSensitive,
//      defaultLanguage, versionAlgorithm, statusProperty, ...).
//   3. property_def carries uri + fhir_type (v1 schema) instead of source_type.
//   4. designation.use_system is populated (v0's schema lost the use system).
//   5. RXNSAT attributes are NOT imported (kept out of scope for this importer);
//      TTY/STY/SAB are the literal properties carried. STY (RXNSTY) is imported
//      here, which the v0 importer did not do.
//
// RELA LINK DIRECTION (mirrors v0): for an RXNREL row (RXCUI1, RXCUI2, RELA)
// the link is written source = concept(RXCUI2), target = concept(RXCUI1), i.e.
// "RXCUI2 --RELA--> RXCUI1". RRF states RELA as the relationship of the second
// concept (RXCUI2/AUI2) to the first (RXCUI1/AUI1), so source=RXCUI2 reads as
// "RXCUI2 <RELA> RXCUI1" (e.g. RXCUI2 has_ingredient RXCUI1).

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execFileSync } = require('child_process');

const { BaseTerminologyModule } = require('./tx-import-base');
const { openV1Database, V1Writer } = require('./sqlite-v1-core');

const BASE_URI = 'http://www.nlm.nih.gov/research/umls/rxnorm';

// Designation "use" coding system. The v0 importer used the RxNorm base URI as
// the system for its TTY use codings (runtime.designations.defaultSystem), so
// we keep that. (The schema-v1 fallback would be
// http://www.nlm.nih.gov/research/umls/rxnorm/TTY, unused here.)
const TTY_USE_SYSTEM = BASE_URI;

// Display selection priority by TTY (index 0 = best), from the v0 importer.
const TTY_PRIORITY = ['PSN', 'SCD', 'SBD', 'GPCK', 'BPCK', 'IN', 'MIN', 'PIN', 'BN'];
const PREFERRED_TTYS = new Set(['PSN', 'SCD', 'SBD']);

const DEFAULT_LANGUAGE = 'en-US';

// Literal property definitions (property_code -> spec). All are 'code'/'string'
// literals scoped to this code system.
const TTY_PROPERTY_CODE = 'TTY';
const STY_PROPERTY_CODE = 'STY';
const SAB_PROPERTY_CODE = 'SAB';
const SUPPRESS_PROPERTY_CODE = 'SUPPRESS';

// RRF SUPPRESS values that mean "not active" (obsolete / editor-suppressed).
function isSuppressed(flag) {
  return flag === 'O' || flag === 'E';
}

function ttyRank(tty) {
  const idx = TTY_PRIORITY.indexOf(tty);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

// --- version helpers --------------------------------------------------------

function normalizeVersion(version) {
  if (!version) return null;
  const text = String(version).trim();
  return /^\d{8}$/.test(text) ? text : null;
}

function detectVersionFromPath(value) {
  if (!value) return null;
  const text = String(value);
  const specific = text.match(/RxNorm[_-]full[_-](\d{8})/i);
  if (specific) return specific[1];
  const generic = text.match(/(\d{8})/);
  return generic ? generic[1] : null;
}

// RXNSAB SVER like '20AA_260504F' embeds YYMMDD -> MMDDYYYY.
async function detectVersionFromRxnSab(rxnsabFile) {
  if (!rxnsabFile || !fs.existsSync(rxnsabFile)) return null;
  for await (const cols of readRrf(rxnsabFile)) {
    if (cols.length < 7) continue;
    const rsab = cols[3];
    const sver = cols[6] || '';
    if (rsab !== 'RXNORM') continue;
    const m = sver.match(/(\d{6})/);
    if (m) {
      const yy = m[1].slice(0, 2);
      const mm = m[1].slice(2, 4);
      const dd = m[1].slice(4, 6);
      return `${mm}${dd}20${yy}`;
    }
  }
  return null;
}

function releaseDateFromMmddyyyy(input) {
  const text = String(input || '').trim();
  if (!/^\d{8}$/.test(text)) return null;
  return `${text.slice(4, 8)}-${text.slice(0, 2)}-${text.slice(2, 4)}`;
}

// --- RRF streaming ----------------------------------------------------------

async function* readRrf(filePath) {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    yield line.split('|');
  }
}

function scanDirectoryForRrf(dir, files) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) scanDirectoryForRrf(fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const name = entry.name.toUpperCase();
    if (name === 'RXNCONSO.RRF') files.rxnconso = fullPath;
    else if (name === 'RXNREL.RRF') files.rxnrel = fullPath;
    else if (name === 'RXNSTY.RRF') files.rxnsty = fullPath;
    else if (name === 'RXNSAB.RRF') files.rxnsab = fullPath;
  }
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

class RxNormSqliteV1Importer {
  constructor(config = {}) {
    this.config = {
      source: config.source,
      dest: config.dest,
      version: normalizeVersion(config.version) || detectVersionFromPath(config.source),
      uri: config.uri || null,
      // Cap RXNCONSO rows scanned for smoke runs; relationships / STY / SAB are
      // then filtered to whatever CUIs actually loaded.
      maxRows: config.maxRows != null ? Number(config.maxRows)
        : (config.limit != null ? Number(config.limit) : null),
      overwrite: !!config.overwrite,
      verbose: config.verbose !== false,
    };

    this.db = null;
    this.writer = null;
    this.csId = null;
    this.runId = null;

    this.sourceRoot = null;
    this.extractedTempDir = null;

    // property_code -> property_id for RELA (concept-valued) properties.
    this.relaPropId = new Map();
    this.ttyPropId = null;
    this.styPropId = null;
    this.sabPropId = null;

    this.stats = {
      concepts: 0,
      designations: 0,
      relationships: 0,
      ttyLiterals: 0,
      styLiterals: 0,
      sabLiterals: 0,
      literals: 0,
      relaProps: 0,
      scannedConso: 0,
    };
  }

  static discoverRrfFiles(source) {
    const files = { rxnconso: null, rxnrel: null, rxnsty: null, rxnsab: null };
    scanDirectoryForRrf(source, files);
    return files;
  }

  log(msg) {
    if (this.config.verbose) console.log(msg);
  }

  async run() {
    if (!this.config.source || !this.config.dest) {
      throw new Error('source and dest are required');
    }

    await this.prepareSource();
    const files = RxNormSqliteV1Importer.discoverRrfFiles(this.sourceRoot);
    if (!files.rxnconso) {
      throw new Error('RXNCONSO.RRF was not found under ' + this.sourceRoot);
    }

    if (!this.config.version) {
      this.config.version = await detectVersionFromRxnSab(files.rxnsab);
    }
    if (!this.config.uri) {
      this.config.uri = this.config.version
        ? `${BASE_URI}|${this.config.version}`
        : BASE_URI;
    }

    this.db = openV1Database(this.config.dest, { overwrite: this.config.overwrite });
    this.writer = new V1Writer(this.db);

    try {
      this.createCodeSystem();
      this.runId = this.writer.beginAudit({
        sourcePath: this.config.source,
        targetDb: this.config.dest,
        terminology: 'rxnorm',
        editionCode: null,
        version: this.config.version || null,
      });

      this.log(
        `Files: RXNCONSO=${!!files.rxnconso}, RXNREL=${!!files.rxnrel}, ` +
        `RXNSTY=${!!files.rxnsty}, RXNSAB=${!!files.rxnsab}`
      );

      await this.importConcepts(files.rxnconso);
      await this.importDesignations(files.rxnconso);
      await this.importSemanticTypes(files.rxnsty);
      await this.importRelationships(files.rxnrel);

      this.writer.buildSearchIndex(this.csId);
      // No hierarchy in RxNorm v1: no is_hierarchy properties, closure skipped.

      this.writer.finishAudit(this.runId, { status: 'success', stats: this.stats });
      this.writer.finalize({ caseSensitive: true });
    } catch (error) {
      if (this.runId != null) {
        try {
          this.writer.finishAudit(this.runId, {
            status: 'failed',
            stats: { ...this.stats, error: error.message },
          });
        } catch (_) { /* best effort */ }
      }
      throw error;
    } finally {
      if (this.db && this.db.open) this.db.close();
      this.db = null;
      await this.cleanupSource();
    }

    return { csId: this.csId, uri: this.config.uri, version: this.config.version, stats: this.stats };
  }

  createCodeSystem() {
    this.csId = this.writer.codeSystem({
      baseUri: BASE_URI,
      editionCode: null,
      version: this.config.version || null,
      canonicalUri: this.config.uri,
      releaseDate: releaseDateFromMmddyyyy(this.config.version),
      name: 'RxNorm',
      title: 'RxNorm',
      description: 'RxNorm normalized drug nomenclature from the U.S. National Library of Medicine',
      contentMode: 'complete',
      sourceKind: 'rxnorm-sqlite-v1',
    });

    // Flat cs_config per docs/sqlite-v1-design.md registry.
    // RxNorm codes (RXCUIs) are case-sensitive numeric identifiers.
    this.writer.setConfig(this.csId, 'caseSensitive', 1);
    this.writer.setConfig(this.csId, 'defaultLanguage', DEFAULT_LANGUAGE);
    // Version strings are release date stamps (MMDDYYYY) -> date algorithm.
    this.writer.setConfig(this.csId, 'versionAlgorithm', 'date');
    // getStatus() surfaces the source status vocabulary: the per-CUI SUPPRESS
    // flag ('N' if any atom is unsuppressed, else the first suppressed value
    // seen). concept.active is the normalized form of the same flag.
    this.writer.setConfig(this.csId, 'statusProperty', SUPPRESS_PROPERTY_CODE);
    this.writer.setConfig(this.csId, 'webSource', 'https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm={code}');

    // Literal property definitions.
    this.ttyPropId = this.writer.defineProperty(this.csId, {
      code: TTY_PROPERTY_CODE, uri: `${BASE_URI}/${TTY_PROPERTY_CODE}`,
      fhirType: 'code', valueKind: 'literal', display: 'Term Type in Source',
    });
    // STY values are UMLS semantic-type TUIs (e.g. T121): that is what the
    // legacy provider's `STY =` filter matches (rxnsty.TUI), so parity depends
    // on storing the TUI, not the human-readable STY name.
    this.styPropId = this.writer.defineProperty(this.csId, {
      code: STY_PROPERTY_CODE, uri: `${BASE_URI}/${STY_PROPERTY_CODE}`,
      fhirType: 'code', valueKind: 'literal', display: 'Semantic Type (TUI)',
    });
    this.sabPropId = this.writer.defineProperty(this.csId, {
      code: SAB_PROPERTY_CODE, uri: `${BASE_URI}/${SAB_PROPERTY_CODE}`,
      fhirType: 'code', valueKind: 'literal', display: 'Source Abbreviation',
    });
    this.suppressPropId = this.writer.defineProperty(this.csId, {
      code: SUPPRESS_PROPERTY_CODE, uri: `${BASE_URI}/${SUPPRESS_PROPERTY_CODE}`,
      fhirType: 'code', valueKind: 'literal', display: 'Suppress Flag',
    });
  }

  relaProperty(rela) {
    let id = this.relaPropId.get(rela);
    if (id != null) return id;
    id = this.writer.defineProperty(this.csId, {
      code: rela,
      uri: `${BASE_URI}/${rela}`,
      fhirType: 'code',
      valueKind: 'concept',
      isHierarchy: false, // v1 delta: RxNorm carries no subsumption hierarchy.
      display: rela,
    });
    this.relaPropId.set(rela, id);
    this.stats.relaProps += 1;
    return id;
  }

  // Pass 1 over RXNCONSO: fold RXNORM atoms into per-CUI concept records, then
  // write concepts + TTY/SAB literals. Only SAB=RXNORM atoms define concepts.
  async importConcepts(rxnconsoFile) {
    this.log('Importing concepts from RXNCONSO.RRF...');

    const concepts = new Map(); // rxcui -> { display, rank, active, ttys:Map(tty->active) }
    let scanned = 0;

    for await (const cols of readRrf(rxnconsoFile)) {
      if (this.config.maxRows != null && scanned >= this.config.maxRows) break;
      if (cols.length < 17) continue;
      scanned += 1;

      const rxcui = cols[0];
      const sab = cols[11];
      const tty = cols[12];
      const str = (cols[14] || '').trim();
      const suppress = cols[16];

      if (sab !== 'RXNORM' || !rxcui) continue;

      const active = isSuppressed(suppress) ? 0 : 1;
      const rank = ttyRank(tty);
      const existing = concepts.get(rxcui);
      if (!existing) {
        const ttys = new Map();
        if (tty) ttys.set(tty, active);
        concepts.set(rxcui, {
          display: str || rxcui,
          rank,
          active,
          suppress: suppress || 'N',
          ttys,
        });
      } else {
        if (active === 1) existing.active = 1;
        if (suppress === 'N') existing.suppress = 'N';
        if (tty) {
          const prev = existing.ttys.get(tty) || 0;
          if (!existing.ttys.has(tty) || active > prev) existing.ttys.set(tty, active);
        }
        // Keep the best display by TTY priority.
        if ((str && rank < existing.rank) || !existing.display) {
          existing.display = str || rxcui;
          existing.rank = rank;
        }
      }
    }
    this.stats.scannedConso = scanned;

    for (const [rxcui, info] of concepts.entries()) {
      const conceptId = this.writer.addConcept(this.csId, {
        code: rxcui,
        active: info.active === 1,
        display: info.display || rxcui,
      });
      this.stats.concepts += 1;

      // SAB literal (always RXNORM for a loaded concept) — the coarse source
      // status vocabulary getStatus() reads.
      this.writer.addLiteral({
        sourceId: conceptId, propertyId: this.sabPropId, value: 'RXNORM',
      });
      this.stats.sabLiterals += 1;

      // Per-CUI SUPPRESS flag ('N' if any atom unsuppressed) — the status
      // vocabulary named by cs_config statusProperty.
      this.writer.addLiteral({
        sourceId: conceptId, propertyId: this.suppressPropId,
        value: info.suppress || 'N',
      });
      this.stats.suppressLiterals = (this.stats.suppressLiterals || 0) + 1;

      // Distinct TTY literals with their active flag.
      for (const [tty, ttyActive] of info.ttys.entries()) {
        this.writer.addLiteral({
          sourceId: conceptId, propertyId: this.ttyPropId,
          value: tty, active: ttyActive === 1,
        });
        this.stats.ttyLiterals += 1;
      }
    }
    this.stats.literals += this.stats.sabLiterals + this.stats.ttyLiterals;

    this.log(
      `  scanned=${scanned}, concepts=${this.stats.concepts}, ` +
      `ttyLiterals=${this.stats.ttyLiterals}`
    );
  }

  // Pass 2 over RXNCONSO: one designation per RXNORM atom with a STR, for CUIs
  // that were loaded as concepts.
  async importDesignations(rxnconsoFile) {
    this.log('Importing designations from RXNCONSO.RRF...');
    let scanned = 0;

    for await (const cols of readRrf(rxnconsoFile)) {
      if (this.config.maxRows != null && scanned >= this.config.maxRows) break;
      if (cols.length < 17) continue;
      scanned += 1;

      const rxcui = cols[0];
      const sab = cols[11];
      const tty = cols[12];
      const str = (cols[14] || '').trim();
      const suppress = cols[16];

      if (sab !== 'RXNORM' || !rxcui || !str) continue;

      const conceptId = this.writer.conceptId(this.csId, rxcui);
      if (conceptId === undefined) continue;

      this.writer.addDesignation(conceptId, {
        language: DEFAULT_LANGUAGE,
        useSystem: TTY_USE_SYSTEM,
        useCode: tty || null,
        term: str,
        preferred: PREFERRED_TTYS.has(tty),
        active: !isSuppressed(suppress),
      });
      this.stats.designations += 1;
    }
    this.log(`  designations=${this.stats.designations}`);
  }

  // RXNSTY: STY literal (fhir_type string) per loaded CUI. RXNSTY has no SAB
  // column; filter to CUIs already loaded as concepts.
  async importSemanticTypes(rxnstyFile) {
    if (!rxnstyFile) {
      this.log('RXNSTY.RRF not found; skipping semantic types');
      return;
    }
    this.log('Importing semantic types from RXNSTY.RRF...');

    for await (const cols of readRrf(rxnstyFile)) {
      if (cols.length < 4) continue;
      const rxcui = cols[0];
      // Store the TUI (T-code), not the STY name: the legacy provider's
      // `STY =` filter matches rxnsty.TUI.
      const sty = (cols[1] || '').trim();
      if (!rxcui || !sty) continue;

      const conceptId = this.writer.conceptId(this.csId, rxcui);
      if (conceptId === undefined) continue;

      this.writer.addLiteral({
        sourceId: conceptId, propertyId: this.styPropId, value: sty,
      });
      this.stats.styLiterals += 1;
    }
    this.stats.literals += this.stats.styLiterals;
    this.log(`  styLiterals=${this.stats.styLiterals}`);
  }

  // RXNREL: SAB=RXNORM rows with a non-empty RELA that relate two loaded CUIs
  // become concept-valued links. Direction mirrors v0: source=concept(RXCUI2),
  // target=concept(RXCUI1). Rows lacking RELA (bare REL like RB/RN) are skipped,
  // as in v0.
  async importRelationships(rxnrelFile) {
    if (!rxnrelFile) {
      this.log('RXNREL.RRF not found; skipping relationships');
      return;
    }
    this.log('Importing relationships from RXNREL.RRF...');

    let imported = 0;
    let skipped = 0;

    for await (const cols of readRrf(rxnrelFile)) {
      if (cols.length < 15) continue;

      const rxcui1 = cols[0];
      const rxcui2 = cols[4];
      const rela = cols[7];
      const sab = cols[10];
      const suppress = cols[14];

      if (sab !== 'RXNORM' || !rela) { skipped += 1; continue; }

      // Both endpoints must exist as loaded concepts.
      const sourceId = this.writer.conceptId(this.csId, rxcui2);
      const targetId = this.writer.conceptId(this.csId, rxcui1);
      if (sourceId === undefined || targetId === undefined) { skipped += 1; continue; }

      const propertyId = this.relaProperty(rela);
      this.writer.addLink({
        sourceId,
        propertyId,
        targetId,
        active: !isSuppressed(suppress),
      });
      imported += 1;
    }

    this.stats.relationships = imported;
    this.log(`  relationships=${imported} (skipped ${skipped})`);
  }

  async prepareSource() {
    const src = path.resolve(this.config.source);
    if (!fs.existsSync(src)) throw new Error(`Source does not exist: ${src}`);

    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      this.sourceRoot = src;
      return;
    }
    if (!stat.isFile() || !src.toLowerCase().endsWith('.zip')) {
      throw new Error('Source must be an RxNorm RRF directory or a .zip release');
    }

    this.extractedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rxnorm-sqlite-v1-'));
    this.log(`Extracting ${src} to ${this.extractedTempDir} ...`);
    try {
      execFileSync('unzip', ['-q', src, '-d', this.extractedTempDir], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`Failed to extract zip '${src}': ${error.message}`);
    }
    this.sourceRoot = this.extractedTempDir;
  }

  async cleanupSource() {
    if (this.extractedTempDir && fs.existsSync(this.extractedTempDir)) {
      fs.rmSync(this.extractedTempDir, { recursive: true, force: true });
    }
    this.extractedTempDir = null;
    this.sourceRoot = null;
  }
}

// ---------------------------------------------------------------------------
// tx-import module (auto-discovered *.module.js exporting a *Module class)
// ---------------------------------------------------------------------------

class RxNormSqliteV1Module extends BaseTerminologyModule {
  getName() {
    return 'rxnorm-sqlite-v1';
  }

  getDescription() {
    return 'RxNorm RRF -> SQLite (shared sqlite-v1 schema)';
  }

  getSupportedFormats() {
    return ['rrf', 'directory', 'zip'];
  }

  getEstimatedDuration() {
    return '5-30 minutes (depends on source size)';
  }

  getDefaultConfig() {
    return { verbose: true, overwrite: false, dest: './data/rxnorm-sqlite-v1.db' };
  }

  registerCommands(terminologyCommand, globalOptions) {
    terminologyCommand
      .command('import')
      .description('Import RxNorm RRF into the sqlite-v1 schema')
      .option('-s, --source <path>', 'Source RRF directory or RxNorm .zip release')
      .option('-d, --dest <file>', 'Destination SQLite file')
      .option('-v, --rxnorm-version <MMDDYYYY>', 'RxNorm version date (e.g. 05042026)')
      .option('-u, --uri <uri>', 'Canonical URI; overrides default base|version')
      .option('--max-rows <n>', 'Cap RXNCONSO rows scanned (smoke runs)')
      .option('--overwrite', 'Overwrite destination database if it exists')
      .option('-y, --yes', 'Skip confirmations')
      .action(async (options) => {
        const config = {
          ...this.getDefaultConfig(),
          ...globalOptions,
          source: options.source,
          dest: options.dest || this.getDefaultConfig().dest,
          version: options.rxnormVersion || options.version,
          uri: options.uri,
          maxRows: options.maxRows,
          overwrite: !!options.overwrite,
          verbose: options.verbose !== false,
        };
        if (!config.source) throw new Error('--source is required');
        const importer = new RxNormSqliteV1Importer(config);
        const result = await importer.run();
        this.logSuccess(
          `RxNorm sqlite-v1 import complete: ${result.uri} ` +
          `(concepts=${result.stats.concepts}, designations=${result.stats.designations}, ` +
          `relationships=${result.stats.relationships})`
        );
      });

    terminologyCommand
      .command('validate')
      .description('Discover RxNorm RRF files under a source path')
      .option('-s, --source <path>', 'Source directory')
      .action((options) => {
        const files = RxNormSqliteV1Importer.discoverRrfFiles(path.resolve(options.source || '.'));
        console.log('Discovered RRF files:');
        console.log(`  RXNCONSO: ${files.rxnconso || '(missing)'}`);
        console.log(`  RXNREL:   ${files.rxnrel || '(missing)'}`);
        console.log(`  RXNSTY:   ${files.rxnsty || '(missing)'}`);
        console.log(`  RXNSAB:   ${files.rxnsab || '(missing)'}`);
        if (!files.rxnconso) this.logError('RXNCONSO.RRF is required');
        else this.logSuccess('Validation passed');
      });
  }
}

module.exports = {
  RxNormSqliteV1Module,
  RxNormSqliteV1Importer,
  constants: {
    BASE_URI,
    TTY_USE_SYSTEM,
    TTY_PRIORITY,
    PREFERRED_TTYS,
    TTY_PROPERTY_CODE,
    STY_PROPERTY_CODE,
    SAB_PROPERTY_CODE,
    DEFAULT_LANGUAGE,
  },
};
