'use strict';

// Shared SQLite import core for the sqlite-v1 terminology schema.
//
// This module is NOT an importer; it is the infrastructure that every
// per-terminology importer (LOINC, RxNorm, SNOMED CT, ...) shares. It owns the
// schema application, bulk-load pragmas, prepared-statement reuse, transitive
// closure building, FTS population, and the import audit trail. Terminology
// specific behavior stays in the importers (which write cs_config rows and
// property_def metadata); this file stays boring on purpose.
//
// Target schema: tx/importers/schema-v1.sql (PRAGMA user_version = 2).
// See docs/sqlite-v1-design.md for the semantics decisions.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, 'schema-v1.sql');

// Commit an open write transaction after this many buffered writes.
const COMMIT_EVERY = 20000;

// Rows per closure-insert transaction. Kept well above the 50k floor the spec
// asks for so a 500k-concept SNOMED load commits in a handful of chunks.
const CLOSURE_BATCH = 100000;

const FHIR_TYPES = new Set([
  'code', 'Coding', 'string', 'integer', 'boolean', 'decimal', 'dateTime'
]);
const VALUE_KINDS = new Set(['concept', 'literal']);

// fhir_type -> which typed projection column value_text/value_num carries it.
// (boolean is handled separately into value_bool.)
const TEXT_TYPES = new Set(['code', 'string', 'Coding', 'dateTime']);
const NUM_TYPES = new Set(['integer', 'decimal']);

/**
 * Open (or create) a sqlite-v1 database with the schema applied and bulk-load
 * pragmas set. Throws if the file already exists and !overwrite.
 * @returns {import('better-sqlite3').Database}
 */
function openV1Database(targetPath, options = {}) {
  const { overwrite = false } = options;
  if (fs.existsSync(targetPath)) {
    if (!overwrite) {
      throw new Error(`Destination exists: ${targetPath} (pass {overwrite:true} to replace)`);
    }
    fs.rmSync(targetPath, { force: true });
    // Drop stray WAL/SHM siblings from a previous run.
    fs.rmSync(`${targetPath}-wal`, { force: true });
    fs.rmSync(`${targetPath}-shm`, { force: true });
  } else {
    const dir = path.dirname(targetPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(targetPath);
  db.pragma('foreign_keys = OFF');
  db.pragma('journal_mode = MEMORY');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -64000');

  const ddl = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(ddl);
  return db;
}

/**
 * Writer over an open sqlite-v1 database. Buffers writes into a single lazily
 * opened transaction, committing every COMMIT_EVERY writes and at
 * closure/finalize boundaries. All inserts reuse prepared statements.
 */
class V1Writer {
  constructor(db) {
    this.db = db;
    this._inTxn = false;
    this._pending = 0;

    // Per-cs code -> concept_id maps, for importer lookups without SQL.
    this._codeMaps = new Map(); // csId -> Map(code -> conceptId)
    // Per-cs property caches: (csId, propertyCode) -> property_def row.
    this._propByCode = new Map(); // csId -> Map(code -> {propertyId, fhirType, valueKind})
    // property_id -> fhirType, for literal projection without a re-lookup.
    this._propType = new Map();

    this._prepare();
  }

  _prepare() {
    const db = this.db;
    this._st = {
      insCodeSystem: db.prepare(
        `INSERT INTO code_system
           (base_uri, edition_code, version, canonical_uri, release_date,
            name, title, description, content_mode, source_kind)
         VALUES (@baseUri, @editionCode, @version, @canonicalUri, @releaseDate,
                 @name, @title, @description, @contentMode, @sourceKind)`
      ),
      insConfig: db.prepare(
        `INSERT INTO cs_config (cs_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(cs_id, key) DO UPDATE SET value = excluded.value`
      ),
      insProperty: db.prepare(
        `INSERT INTO property_def
           (cs_id, property_code, uri, fhir_type, value_kind, is_hierarchy, display)
         VALUES (@csId, @code, @uri, @fhirType, @valueKind, @isHierarchy, @display)`
      ),
      insConcept: db.prepare(
        `INSERT INTO concept (cs_id, code, active, display, definition)
         VALUES (@csId, @code, @active, @display, @definition)`
      ),
      selConcept: db.prepare(
        `SELECT concept_id FROM concept WHERE cs_id = ? AND code = ?`
      ),
      insDesignation: db.prepare(
        `INSERT INTO designation
           (concept_id, active, language_code, use_system, use_code, term, preferred)
         VALUES (@conceptId, @active, @language, @useSystem, @useCode, @term, @preferred)`
      ),
      insLink: db.prepare(
        `INSERT INTO concept_link
           (edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)
         VALUES (@edgeSetId, @sourceId, @propertyId, @targetId, @groupId, @active)`
      ),
      insLiteral: db.prepare(
        `INSERT INTO concept_literal
           (edge_set_id, source_concept_id, property_id, value_raw,
            value_text, value_num, value_bool, group_id, active)
         VALUES (@edgeSetId, @sourceId, @propertyId, @valueRaw,
                 @valueText, @valueNum, @valueBool, @groupId, @active)`
      ),
      insValueSet: db.prepare(
        `INSERT INTO value_set (cs_id, url, version, name) VALUES (@csId, @url, @version, @name)`
      ),
      insValueSetMember: db.prepare(
        `INSERT OR IGNORE INTO value_set_member (vs_id, concept_id, active) VALUES (?, ?, ?)`
      ),
      insAudit: db.prepare(
        `INSERT INTO load_audit
           (started_at, source_path, target_db, terminology, edition_code, version, status)
         VALUES (@startedAt, @sourcePath, @targetDb, @terminology, @editionCode, @version, 'running')`
      ),
      finishAudit: db.prepare(
        `UPDATE load_audit
            SET completed_at = @completedAt, status = @status, stats_json = @statsJson
          WHERE run_id = @runId`
      ),
    };
  }

  // ---- transaction plumbing ------------------------------------------------

  _begin() {
    if (!this._inTxn) {
      this.db.exec('BEGIN');
      this._inTxn = true;
    }
  }

  /** Count one buffered write and commit the batch when it grows too large. */
  _tick() {
    this._pending += 1;
    if (this._pending >= COMMIT_EVERY) {
      this.flush();
    }
  }

  /** Commit any open transaction. Safe to call when nothing is buffered. */
  flush() {
    if (this._inTxn) {
      this.db.exec('COMMIT');
      this._inTxn = false;
    }
    this._pending = 0;
  }

  // ---- code system + config ------------------------------------------------

  codeSystem(spec) {
    this._begin();
    const info = this._st.insCodeSystem.run({
      baseUri: spec.baseUri,
      editionCode: spec.editionCode ?? null,
      version: spec.version ?? null,
      canonicalUri: spec.canonicalUri,
      releaseDate: spec.releaseDate ?? null,
      name: spec.name ?? null,
      title: spec.title ?? null,
      description: spec.description ?? null,
      contentMode: spec.contentMode ?? 'complete',
      sourceKind: spec.sourceKind ?? null,
    });
    const csId = Number(info.lastInsertRowid);
    this._codeMaps.set(csId, new Map());
    this._propByCode.set(csId, new Map());
    this._tick();
    return csId;
  }

  setConfig(csId, key, value) {
    let str;
    if (value === null || value === undefined) {
      str = '';
    } else if (typeof value === 'object') {
      str = JSON.stringify(value);
    } else {
      str = String(value);
    }
    this._begin();
    this._st.insConfig.run(csId, key, str);
    this._tick();
  }

  // ---- properties ----------------------------------------------------------

  defineProperty(csId, spec) {
    const { code, uri = null, fhirType, valueKind, isHierarchy = false, display = null } = spec;
    if (!FHIR_TYPES.has(fhirType)) {
      throw new Error(`defineProperty: invalid fhirType '${fhirType}' for '${code}'`);
    }
    if (!VALUE_KINDS.has(valueKind)) {
      throw new Error(`defineProperty: invalid valueKind '${valueKind}' for '${code}'`);
    }
    const cache = this._propCache(csId);
    const existing = cache.get(code);
    if (existing) {
      return existing.propertyId;
    }
    this._begin();
    const info = this._st.insProperty.run({
      csId, code, uri, fhirType, valueKind,
      isHierarchy: isHierarchy ? 1 : 0,
      display,
    });
    const propertyId = Number(info.lastInsertRowid);
    cache.set(code, { propertyId, fhirType, valueKind });
    this._propType.set(propertyId, fhirType);
    this._tick();
    return propertyId;
  }

  _propCache(csId) {
    let c = this._propByCode.get(csId);
    if (!c) {
      c = new Map();
      this._propByCode.set(csId, c);
    }
    return c;
  }

  // ---- concepts ------------------------------------------------------------

  addConcept(csId, spec) {
    const { code, active = true, display = null, definition = null } = spec;
    this._begin();
    const info = this._st.insConcept.run({
      csId, code,
      active: active ? 1 : 0,
      display,
      definition,
    });
    const conceptId = Number(info.lastInsertRowid);
    this._codeMap(csId).set(code, conceptId);
    this._tick();
    return conceptId;
  }

  conceptId(csId, code) {
    const map = this._codeMap(csId);
    if (map.has(code)) {
      return map.get(code);
    }
    const row = this._st.selConcept.get(csId, code);
    if (!row) return undefined;
    map.set(code, row.concept_id);
    return row.concept_id;
  }

  _codeMap(csId) {
    let m = this._codeMaps.get(csId);
    if (!m) {
      m = new Map();
      this._codeMaps.set(csId, m);
    }
    return m;
  }

  // ---- designations --------------------------------------------------------

  addDesignation(conceptId, spec) {
    const {
      language = null, useSystem = null, useCode = null,
      term, preferred = false,
    } = spec;
    this._begin();
    this._st.insDesignation.run({
      conceptId,
      active: (spec.active ?? true) ? 1 : 0,
      language, useSystem, useCode, term,
      preferred: preferred ? 1 : 0,
    });
    this._tick();
  }

  // ---- links + literals ----------------------------------------------------

  // Hierarchy convention: a concept_link row for an is_hierarchy property is
  // written as source = child, target = parent. Importers MUST emit child->parent
  // links; buildClosure walks them to fill (ancestor, descendant) pairs.
  addLink(spec) {
    const {
      sourceId, propertyId, targetId,
      edgeSetId = 1, groupId = 0, active = true,
    } = spec;
    this._begin();
    this._st.insLink.run({
      edgeSetId, sourceId, propertyId, targetId, groupId,
      active: active ? 1 : 0,
    });
    this._tick();
  }

  addLiteral(spec) {
    const {
      sourceId, propertyId, value,
      edgeSetId = 1, groupId = 0, active = true,
    } = spec;
    const fhirType = this._propType.get(propertyId);
    const raw = value === null || value === undefined ? null : String(value);

    let valueText = null;
    let valueNum = null;
    let valueBool = null;
    if (raw !== null) {
      if (fhirType === 'boolean') {
        valueBool = (raw === 'Y' || raw === 'true' || raw === '1') ? 1 : 0;
      } else if (NUM_TYPES.has(fhirType)) {
        const n = Number(raw);
        valueNum = Number.isNaN(n) ? null : n;
      } else if (TEXT_TYPES.has(fhirType)) {
        valueText = raw;
      }
    }

    this._begin();
    this._st.insLiteral.run({
      edgeSetId, sourceId, propertyId,
      valueRaw: raw, valueText, valueNum, valueBool, groupId,
      active: active ? 1 : 0,
    });
    this._tick();
  }

  // ---- value sets ----------------------------------------------------------

  addValueSet(csId, spec) {
    const { url, version = null, name = null } = spec;
    this._begin();
    const info = this._st.insValueSet.run({ csId, url, version, name });
    this._tick();
    return Number(info.lastInsertRowid);
  }

  addValueSetMember(vsId, conceptId, active = true) {
    this._begin();
    this._st.insValueSetMember.run(vsId, conceptId, active ? 1 : 0);
    this._tick();
  }

  // ---- closure -------------------------------------------------------------

  /**
   * Build the transitive closure over ACTIVE concept_link rows whose
   * property_def.is_hierarchy = 1 and edge_set_id = edgeSetId. Link direction
   * is source = child, target = parent, so an edge contributes the ancestor
   * (parent) / descendant (child) relation. NO self-rows are written.
   *
   * Algorithm: load edges into flat parent-adjacency arrays, DFS from every
   * concept with iterative accumulation, and dedupe ancestors per node with a
   * per-descendant visited stamp (an Int32Array reused across nodes, so no
   * per-node Set allocation). Emitted pairs are batched into transactions.
   *
   * Memory profile for 500k concepts / 2M hierarchy edges:
   *   - id<->index maps: two arrays + a Map, O(N) ~ a few MB.
   *   - CSR parent adjacency: Int32Array(N+1) offsets + Int32Array(E) targets
   *     ~ (0.5M + 2M) * 4B ≈ 10 MB.
   *   - visited stamp: Int32Array(N) ≈ 2 MB, reused, never grows with output.
   *   - a stack (Int32Array) bounded by the longest is-a chain.
   * The output pairs (potentially tens of millions) are streamed straight to
   * SQLite in CLOSURE_BATCH-sized transactions and never all held in JS.
   *
   * @returns {number} closure row count inserted.
   */
  buildClosure(csId, options = {}) {
    const { edgeSetId = 1 } = options;
    this.flush();

    // Hierarchy property_ids for this cs.
    const hierProps = this.db.prepare(
      `SELECT property_id FROM property_def WHERE cs_id = ? AND is_hierarchy = 1`
    ).all(csId).map((r) => r.property_id);

    this.db.exec('DELETE FROM closure');
    if (hierProps.length === 0) {
      return 0;
    }

    // Collect active child->parent edges (source=child, target=parent) for the
    // hierarchy properties of this cs on the requested edge set. The property
    // filter already scopes to this cs (property_def rows are per-cs).
    const placeholders = hierProps.map(() => '?').join(',');
    const edgeStmt = this.db.prepare(
      `SELECT source_concept_id AS child, target_concept_id AS parent
         FROM concept_link
        WHERE property_id IN (${placeholders})
          AND edge_set_id = ?
          AND active = 1`
    );

    // Build a compact index space over the concept ids that appear.
    const idToIx = new Map();
    const ixToId = [];
    const childOf = [];
    const parentOf = [];
    const intern = (id) => {
      let ix = idToIx.get(id);
      if (ix === undefined) {
        ix = ixToId.length;
        idToIx.set(id, ix);
        ixToId.push(id);
      }
      return ix;
    };
    for (const row of edgeStmt.iterate(...hierProps, edgeSetId)) {
      childOf.push(intern(row.child));
      parentOf.push(intern(row.parent));
    }

    const n = ixToId.length;
    const e = childOf.length;
    if (e === 0) {
      return 0;
    }

    // CSR: for each node, the list of its direct parents.
    const degree = new Int32Array(n);
    for (let i = 0; i < e; i++) degree[childOf[i]] += 1;
    const offset = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) offset[i + 1] = offset[i] + degree[i];
    const parents = new Int32Array(e);
    const cursor = offset.slice(0, n);
    for (let i = 0; i < e; i++) {
      const c = childOf[i];
      parents[cursor[c]++] = parentOf[i];
    }

    // DFS ancestor accumulation. For each descendant node d, walk all parents
    // transitively; `stamp` marks nodes already recorded as ancestors of d in
    // this pass so each (ancestor, descendant) is emitted exactly once and
    // self-rows are impossible (we never seed d into its own ancestor set).
    const stamp = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n > 0 ? n : 1);

    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO closure (ancestor_id, descendant_id) VALUES (?, ?)`
    );
    let batch = [];
    let total = 0;
    const flushBatch = () => {
      if (batch.length === 0) return;
      this.db.exec('BEGIN');
      for (let i = 0; i < batch.length; i += 2) {
        insertStmt.run(batch[i], batch[i + 1]);
      }
      this.db.exec('COMMIT');
      total += batch.length / 2;
      batch = [];
    };

    for (let d = 0; d < n; d++) {
      const descId = ixToId[d];
      let sp = 0;
      // seed stack with direct parents of d
      for (let k = offset[d]; k < offset[d + 1]; k++) {
        const p = parents[k];
        if (stamp[p] !== d) {
          stamp[p] = d;
          stack[sp++] = p;
        }
      }
      while (sp > 0) {
        const a = stack[--sp];
        batch.push(ixToId[a], descId);
        for (let k = offset[a]; k < offset[a + 1]; k++) {
          const p = parents[k];
          if (stamp[p] !== d) {
            stamp[p] = d;
            stack[sp++] = p;
          }
        }
      }
      if (batch.length >= CLOSURE_BATCH * 2) {
        flushBatch();
      }
    }
    flushBatch();
    return total;
  }

  // ---- search index --------------------------------------------------------

  /**
   * Populate the contentless trigram FTS tables for one code system.
   * rowid links back to concept_id / designation_id / literal_id.
   */
  buildSearchIndex(csId) {
    this.flush();
    this.db.exec('BEGIN');
    this.db.prepare(
      `INSERT INTO search_fts_display(rowid, term)
         SELECT concept_id, display FROM concept
          WHERE cs_id = ? AND display IS NOT NULL AND trim(display) <> ''`
    ).run(csId);
    this.db.prepare(
      `INSERT INTO search_fts_designation(rowid, term)
         SELECT d.designation_id, d.term
           FROM designation d
           JOIN concept c ON c.concept_id = d.concept_id
          WHERE c.cs_id = ? AND d.term IS NOT NULL AND trim(d.term) <> ''`
    ).run(csId);
    this.db.prepare(
      `INSERT INTO search_fts_literal(rowid, term)
         SELECT l.literal_id, l.value_text
           FROM concept_literal l
           JOIN concept c ON c.concept_id = l.source_concept_id
          WHERE c.cs_id = ? AND l.value_text IS NOT NULL AND trim(l.value_text) <> ''`
    ).run(csId);
    this.db.exec('COMMIT');
  }

  // ---- audit ---------------------------------------------------------------

  beginAudit(spec) {
    this.flush();
    const info = this._st.insAudit.run({
      startedAt: new Date().toISOString(),
      sourcePath: spec.sourcePath ?? null,
      targetDb: spec.targetDb ?? null,
      terminology: spec.terminology ?? null,
      editionCode: spec.editionCode ?? null,
      version: spec.version ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  finishAudit(runId, result = {}) {
    const { status = 'success', stats = null } = result;
    this.flush();
    this._st.finishAudit.run({
      runId,
      completedAt: new Date().toISOString(),
      status,
      statsJson: stats === null ? null : JSON.stringify(stats),
    });
  }

  // ---- finalize ------------------------------------------------------------

  /**
   * Flush, run integrity checks (throwing on any violation), ANALYZE, and
   * restore durable pragmas. caseSensitive=false additionally checks for codes
   * that collide under case folding.
   */
  finalize(options = {}) {
    const { caseSensitive = true } = options;
    this.flush();

    const dupCode = this.db.prepare(
      `SELECT cs_id, code, COUNT(*) AS n
         FROM concept GROUP BY cs_id, code HAVING n > 1 LIMIT 1`
    ).get();
    if (dupCode) {
      throw new Error(
        `Integrity: duplicate (cs_id,code) (${dupCode.cs_id}, '${dupCode.code}') x${dupCode.n}`
      );
    }

    if (!caseSensitive) {
      const dupFold = this.db.prepare(
        `SELECT cs_id, lower(code) AS lc, COUNT(*) AS n
           FROM concept GROUP BY cs_id, lower(code) HAVING n > 1 LIMIT 1`
      ).get();
      if (dupFold) {
        throw new Error(
          `Integrity: duplicate (cs_id,lower(code)) (${dupFold.cs_id}, '${dupFold.lc}') x${dupFold.n}`
        );
      }
    }

    const selfRow = this.db.prepare(
      `SELECT ancestor_id FROM closure WHERE ancestor_id = descendant_id LIMIT 1`
    ).get();
    if (selfRow) {
      throw new Error(`Integrity: closure contains self-row for ${selfRow.ancestor_id}`);
    }

    const danglingLink = this.db.prepare(
      `SELECT edge_id FROM concept_link
        WHERE source_concept_id NOT IN (SELECT concept_id FROM concept)
           OR target_concept_id NOT IN (SELECT concept_id FROM concept)
        LIMIT 1`
    ).get();
    if (danglingLink) {
      throw new Error(
        `Integrity: concept_link edge ${danglingLink.edge_id} references a missing concept`
      );
    }

    this.db.exec('ANALYZE');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('journal_mode = DELETE');
  }
}

module.exports = { openV1Database, V1Writer };
