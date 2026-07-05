#!/usr/bin/env node
// -----------------------------------------------------------------------------
// sqlite-v1 SQL profiler
//
// Profiles the raw SQL that tx/cs/cs-sqlite.js generates, across a broad matrix
// of query shapes, on the LARGE real vocabularies:
//   ~/work/tx-dbs/sct-v1.db     (SNOMED CT US 20260301, 537,781 concepts)
//   ~/work/tx-dbs/loinc-v1.db   (LOINC 2.82, 252,207 concepts)
//   ~/work/tx-dbs/rxnorm-v1.db  (RxNorm, 228,626 concepts)
//
// For EACH query shape it captures:
//   * the exact SQL string + params (reconstructed from the provider templates)
//   * EXPLAIN QUERY PLAN output, parsed to SCAN (full) / SEARCH (index) / temp-btree
//   * wall-clock median (warmup + N iters), adaptive to query cost
//   * rows returned
// It also drives the provider's public terminals (executeIR / countForIR /
// processSelection) to measure the true end-to-end JS-set-algebra path, and
// quantifies the "JS materialization tax" vs a single all-SQL INTERSECT/EXCEPT
// statement with LIMIT.
//
// Read-only. Does not modify any DB or any existing file.
//
//   node scripts/sqlite-v1-profile/profile-sql.mjs [--out <json>] [--quick]
//
// Emits a machine-readable JSON (default: scripts/sqlite-v1-profile/results.json)
// and prints a compact per-category summary. docs/sqlite-v1-sql-profile.md holds
// the narrative synthesis.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.chdir('/home/jmandel/work/fs2');

const Database = require('/home/jmandel/work/fs2/node_modules/better-sqlite3');
const { SqliteCodeSystemFactory } = require('/home/jmandel/work/fs2/tx/cs/cs-sqlite.js');
const { OperationContext } = require('/home/jmandel/work/fs2/tx/operation-context.js');
const { LanguageDefinitions } = require('/home/jmandel/work/fs2/library/languages.js');
const { I18nSupport } = require('/home/jmandel/work/fs2/library/i18nsupport.js');

const HOME = process.env.HOME;
const ARGS = process.argv.slice(2);
const OUT = argVal('--out') || 'scripts/sqlite-v1-profile/results.json';
const QUICK = ARGS.includes('--quick');
const SINGLE_TIMEOUT_MS = 30000;  // cap: if one execution exceeds this, stop repeating

function argVal(flag) { const i = ARGS.indexOf(flag); return i >= 0 ? ARGS[i + 1] : null; }

// -----------------------------------------------------------------------------
// Set-algebra primitives — copied VERBATIM from cs-sqlite.js so the measured
// JS-materialization cost matches the provider's exactly.
// -----------------------------------------------------------------------------
function intersectSorted(a, b) {
  const out = []; let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) i++; else if (a[i] > b[j]) j++; else { out.push(a[i]); i++; j++; }
  }
  return out;
}
function diffSorted(a, b) {
  const out = []; let i = 0, j = 0;
  while (i < a.length) {
    if (j >= b.length || a[i] < b[j]) out.push(a[i++]);
    else if (a[i] > b[j]) j++; else { i++; j++; }
  }
  return out;
}
function unionSorted(arrays) {
  const nonEmpty = arrays.filter((a) => a && a.length);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return nonEmpty[0];
  const merged = [].concat(...nonEmpty).sort((x, y) => x - y);
  const out = [];
  for (const v of merged) if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  return out;
}

// -----------------------------------------------------------------------------
// Timing / EQP helpers
// -----------------------------------------------------------------------------
function now() { return Number(process.hrtime.bigint()) / 1e6; }

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Adaptive timing of a synchronous 0-arg fn returning a row-count-ish number.
// Returns { medianMs, minMs, rows, iters, timedOut }.
function timeFn(fn) {
  // one warmup + measure its cost to pick an iteration budget
  let t0 = now();
  let rows = fn();
  let warm = now() - t0;
  if (warm > SINGLE_TIMEOUT_MS) {
    return { medianMs: warm, minMs: warm, rows: rowCount(rows), iters: 1, timedOut: true };
  }
  let iters, extraWarm;
  if (QUICK) { iters = 1; extraWarm = 0; }
  else if (warm > 3000) { iters = 3; extraWarm = 0; }
  else if (warm > 400) { iters = 5; extraWarm = 1; }
  else { iters = 9; extraWarm = 2; }
  for (let i = 0; i < extraWarm; i++) fn();
  const ms = [];
  let timedOut = false;
  for (let i = 0; i < iters; i++) {
    t0 = now(); rows = fn(); const dt = now() - t0; ms.push(dt);
    if (dt > SINGLE_TIMEOUT_MS) { timedOut = true; break; }
  }
  return { medianMs: median(ms), minMs: Math.min(...ms), rows: rowCount(rows), iters: ms.length, timedOut };
}
function rowCount(r) {
  if (Array.isArray(r)) return r.length;
  if (r && typeof r === 'object' && 'n' in r) return r.n;
  if (typeof r === 'number') return r;
  return r == null ? 0 : 1;
}

// Async twin of timeFn for provider terminals (which are async but do only
// synchronous sqlite work under the hood).
async function timeFnAsync(fn) {
  let t0 = now();
  let rows = await fn();
  const warm = now() - t0;
  if (warm > SINGLE_TIMEOUT_MS) return { medianMs: warm, minMs: warm, rows: rowCount(rows), iters: 1, timedOut: true };
  let iters, extraWarm;
  if (QUICK) { iters = 1; extraWarm = 0; }
  else if (warm > 3000) { iters = 3; extraWarm = 0; }
  else if (warm > 400) { iters = 5; extraWarm = 1; }
  else { iters = 9; extraWarm = 2; }
  for (let i = 0; i < extraWarm; i++) await fn();
  const ms = []; let timedOut = false;
  for (let i = 0; i < iters; i++) { t0 = now(); rows = await fn(); const dt = now() - t0; ms.push(dt); if (dt > SINGLE_TIMEOUT_MS) { timedOut = true; break; } }
  return { medianMs: median(ms), minMs: Math.min(...ms), rows: rowCount(rows), iters: ms.length, timedOut };
}

// EXPLAIN QUERY PLAN -> parsed verdict.
function eqp(db, sql, params) {
  let rows;
  try { rows = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...(params || [])); }
  catch (e) { return { lines: ['EQP-ERROR: ' + e.message], fullScan: false, tempBtree: false, indexed: false, verdict: 'ERROR' }; }
  const lines = rows.map((r) => r.detail);
  let fullScan = false, indexed = false, tempBtree = false;
  for (const d of lines) {
    const u = d.toUpperCase();
    const isIndexed = u.includes('USING INDEX') || u.includes('USING COVERING INDEX') ||
      u.includes('USING INTEGER PRIMARY KEY') || u.includes('USING PRIMARY KEY') ||
      u.includes('VIRTUAL TABLE INDEX');
    if (isIndexed) indexed = true;
    if (u.includes('USE TEMP B-TREE')) tempBtree = true;
    // A bare "SCAN <table>" with no index marker == full table scan.
    if (/(^|[^A-Z])SCAN /.test(u) && !isIndexed) fullScan = true;
  }
  const verdict = fullScan ? 'FULL-SCAN' : (indexed ? 'INDEX' : 'OTHER');
  return { lines, fullScan, indexed, tempBtree, verdict };
}

// -----------------------------------------------------------------------------
// Per-DB context
// -----------------------------------------------------------------------------
function openRaw(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('cache_size = -64000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
  return db;
}

function ctxFor(db) {
  const meta = db.prepare('SELECT cs_id FROM code_system ORDER BY cs_id LIMIT 1').get();
  const csId = meta.cs_id;
  const propByCode = new Map();
  for (const p of db.prepare('SELECT * FROM property_def WHERE cs_id=?').all(csId)) propByCode.set(p.property_code, p);
  const hierIds = [...propByCode.values()].filter((p) => p.is_hierarchy).map((p) => p.property_id);
  const cfg = {};
  for (const r of db.prepare('SELECT key,value FROM cs_config WHERE cs_id=?').all(csId)) cfg[r.key] = r.value;
  const edgeSet = cfg.hierarchyEdgeSet != null ? Number(cfg.hierarchyEdgeSet) : 1;
  const hierPh = hierIds.length ? hierIds.map(() => '?').join(',') : '-1';
  const locate = (code) => {
    const r = db.prepare('SELECT concept_id FROM concept WHERE cs_id=? AND code=?').get(csId, code);
    return r ? r.concept_id : null;
  };
  return { db, csId, propByCode, hierIds, hierPh, edgeSet, cfg, locate };
}

// -----------------------------------------------------------------------------
// Raw-SQL builders — mirror the exact templates in cs-sqlite.js
// -----------------------------------------------------------------------------
function sqlHierarchy(c, op, seedId) {
  if (op === 'is-a') return { sql: `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ?\n             UNION SELECT ? AS id ORDER BY id`, params: [seedId, seedId] };
  if (op === 'descendent-of') return { sql: `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ? ORDER BY id`, params: [seedId] };
  if (op === 'generalizes') return { sql: `SELECT ancestor_id AS id FROM closure WHERE descendant_id = ?\n             UNION SELECT ? AS id ORDER BY id`, params: [seedId, seedId] };
  if (op === 'child-of') return {
    sql: `SELECT DISTINCT cl.source_concept_id AS id\n               FROM concept_link cl\n              WHERE cl.target_concept_id = ?\n                AND cl.property_id IN (${c.hierPh})\n                AND cl.edge_set_id = ?\n                AND cl.active = 1\n              ORDER BY id`,
    params: [seedId, ...c.hierIds, c.edgeSet],
  };
  throw new Error('bad op ' + op);
}
// The closure sub-SELECT WITHOUT the trailing ORDER BY (as used inside _fastSource / set-algebra).
function srcHierarchy(op, seedId) {
  if (op === 'descendent-of') return { sql: `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ?`, params: [seedId] };
  if (op === 'is-a') return { sql: `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ? UNION SELECT ? AS id`, params: [seedId, seedId] };
  if (op === 'generalizes') return { sql: `SELECT ancestor_id AS id FROM closure WHERE descendant_id = ? UNION SELECT ? AS id`, params: [seedId, seedId] };
  throw new Error('bad src op ' + op);
}

function sqlPropExists(c, def, want) {
  const table = def.value_kind === 'concept' ? 'concept_link' : 'concept_literal';
  if (want) return { sql: `SELECT DISTINCT source_concept_id AS id FROM ${table}\n            WHERE property_id = ? AND active = 1 ORDER BY id`, params: [def.property_id] };
  return {
    sql: `SELECT concept_id AS id FROM concept\n          WHERE cs_id = ? AND concept_id NOT IN\n            (SELECT source_concept_id FROM ${table} WHERE property_id = ? AND active = 1)\n          ORDER BY id`,
    params: [c.csId, def.property_id],
  };
}
function sqlConceptFilter(def, targetIds) {
  const ph = targetIds.map(() => '?').join(',');
  return { sql: `SELECT DISTINCT source_concept_id AS id FROM concept_link\n          WHERE property_id = ? AND active = 1 AND target_concept_id IN (${ph})\n          ORDER BY id`, params: [def.property_id, ...targetIds] };
}
function sqlLiteralFilter(def, values) {
  const ph = values.map(() => '?').join(',');
  return { sql: `SELECT DISTINCT source_concept_id AS id FROM concept_literal\n        WHERE property_id = ? AND active = 1\n          AND (value_text IN (${ph}) COLLATE NOCASE OR value_raw IN (${ph}) COLLATE NOCASE)\n        ORDER BY id`, params: [def.property_id, ...values, ...values] };
}
function sqlLiteralRegexCandidates(def) {
  return { sql: `SELECT source_concept_id AS id, value_text, value_raw\n         FROM concept_literal WHERE property_id = ? AND active = 1`, params: [def.property_id] };
}
function ftsQuery(text) { return '"' + text.replace(/"/g, '""') + '"'; }
function sqlFtsDisplay(c, term) { return { sql: `SELECT sf.rowid AS id FROM search_fts_display sf\n             JOIN concept c ON c.concept_id = sf.rowid\n            WHERE c.cs_id = ? AND sf.term MATCH ?`, params: [c.csId, ftsQuery(term)] }; }
function sqlFtsDesignation(c, term) { return { sql: `SELECT d.concept_id AS id FROM search_fts_designation sf\n             JOIN designation d ON d.designation_id = sf.rowid\n             JOIN concept c ON c.concept_id = d.concept_id\n            WHERE c.cs_id = ? AND sf.term MATCH ?`, params: [c.csId, ftsQuery(term)] }; }
function sqlLikeDisplay(c, term) { return { sql: `SELECT concept_id AS id FROM concept\n            WHERE cs_id = ? AND display LIKE ? COLLATE NOCASE`, params: [c.csId, `%${term}%`] }; }
function sqlVsMembers(vsId) { return { sql: `SELECT concept_id AS id FROM value_set_member\n            WHERE vs_id = ? AND active = 1 ORDER BY id`, params: [vsId] }; }

// Fast-path page + count (the IR speed win, _tryFastPage / _tryFastCount).
function sqlFastPage(src, count, offset) {
  const limitClause = count > -1 ? 'LIMIT ? OFFSET ?' : (offset > 0 ? 'LIMIT -1 OFFSET ?' : '');
  const limitArgs = count > -1 ? [count, offset] : (offset > 0 ? [offset] : []);
  return {
    sql: `SELECT c.code AS code, c.display AS display, c.active AS active\n         FROM (${src.sql}) s JOIN concept c ON c.concept_id = s.id\n        ORDER BY c.concept_id ${limitClause}`,
    params: [...src.params, ...limitArgs],
  };
}
function sqlFastCount(src) { return { sql: `SELECT COUNT(*) AS n FROM (${src.sql})`, params: src.params }; }

// -----------------------------------------------------------------------------
// Case runner
// -----------------------------------------------------------------------------
const RESULTS = [];
function record(rec) {
  RESULTS.push(rec);
  const flags = [rec.verdict];
  if (rec.tempBtree) flags.push('TEMP-BTREE');
  if (rec.timedOut) flags.push('TIMEOUT');
  const ms = rec.medianMs != null ? rec.medianMs.toFixed(1).padStart(9) : '     n/a';
  console.log(`  [${rec.db}] ${rec.category.padEnd(11)} ${ms}ms  rows=${String(rec.rows).padStart(7)}  ${flags.join(',').padEnd(20)} ${rec.name}`);
}

// A "sql case": time db.prepare(sql).all(params); EQP the same statement.
function caseSql(c, dbName, category, name, sql, params, note) {
  const stmt = c.db.prepare(sql);
  const t = timeFn(() => stmt.all(...(params || [])));
  const plan = eqp(c.db, sql, params);
  record({ db: dbName, category, name, note: note || null, sql, params, rows: t.rows,
    medianMs: t.medianMs, minMs: t.minMs, iters: t.iters, timedOut: t.timedOut,
    verdict: plan.verdict, fullScan: plan.fullScan, indexed: plan.indexed, tempBtree: plan.tempBtree, eqp: plan.lines });
}
// A "count case": time COUNT(*) statement.
function caseCount(c, dbName, category, name, sql, params, note) {
  const stmt = c.db.prepare(sql);
  const t = timeFn(() => stmt.get(...(params || [])));
  const plan = eqp(c.db, sql, params);
  record({ db: dbName, category, name, note: note || null, sql, params, rows: (t.rows && t.rows.n) != null ? t.rows.n : t.rows,
    medianMs: t.medianMs, minMs: t.minMs, iters: t.iters, timedOut: t.timedOut,
    verdict: plan.verdict, fullScan: plan.fullScan, indexed: plan.indexed, tempBtree: plan.tempBtree, eqp: plan.lines });
}
// A "js case": time an arbitrary fn (SQL fetch + JS work); EQP an associated sql for the SQL portion.
function caseJs(c, dbName, category, name, fn, eqpSql, eqpParams, note) {
  const t = timeFn(fn);
  const plan = eqpSql ? eqp(c.db, eqpSql, eqpParams) : { lines: ['(js-only)'], fullScan: false, indexed: false, tempBtree: false, verdict: 'JS' };
  record({ db: dbName, category, name, note: note || null, sql: eqpSql || '(js)', params: eqpParams || [], rows: t.rows,
    medianMs: t.medianMs, minMs: t.minMs, iters: t.iters, timedOut: t.timedOut,
    verdict: plan.verdict, fullScan: plan.fullScan, indexed: plan.indexed, tempBtree: plan.tempBtree, eqp: plan.lines });
}

// -----------------------------------------------------------------------------
// SNOMED matrix
// -----------------------------------------------------------------------------
async function runSnomed(c, prov) {
  const D = 'sct';
  // Seed codes spanning subtree sizes (verified against the DB).
  const seeds = {
    leaf: '101009',                 // Quilonia ethiopica (0 descendants)
    s10: '376006',                  // ~10
    s100: '6285003',                // ~100 Tachyarrhythmia
    s1k: '363212003',               // ~1000
    s10k: '106077005',              // ~10006 Integumentary system finding
    finding: '404684003',           // 132172 Clinical finding
    procedure: '71388002',          // 61221
    body: '123037004',              // 43459 Body structure
    substance: '105590001',         // 29234
    disease: '64572001',            // subset of finding
    root: '138875005',              // 386109 (whole-ish system)
  };
  const id = {};
  for (const [k, v] of Object.entries(seeds)) id[k] = c.locate(v);

  // --- Hierarchy across subtree sizes ---
  for (const [k, size] of [['leaf', 0], ['s10', 10], ['s100', 100], ['s1k', 1000], ['s10k', 10000], ['finding', 132172], ['root', 386109]]) {
    const s = sqlHierarchy(c, 'descendent-of', id[k]);
    caseSql(c, D, 'hierarchy', `descendent-of ${seeds[k]} (~${size})`, s.sql, s.params);
    const isa = sqlHierarchy(c, 'is-a', id[k]);
    caseSql(c, D, 'hierarchy', `is-a ${seeds[k]} (~${size}) [UNION+sort]`, isa.sql, isa.params);
  }
  // generalizes (ancestors) — deep leaf gives longest ancestor chain
  {
    const g = sqlHierarchy(c, 'generalizes', id.leaf);
    caseSql(c, D, 'hierarchy', `generalizes ${seeds.leaf} (ancestors of a deep leaf)`, g.sql, g.params);
  }
  // child-of (direct children via concept_link)
  {
    const ch = sqlHierarchy(c, 'child-of', id.finding);
    caseSql(c, D, 'hierarchy', `child-of ${seeds.finding} (direct children)`, ch.sql, ch.params);
  }
  // is-a-of-root: degenerate whole system
  {
    const isa = sqlHierarchy(c, 'is-a', id.root);
    caseSql(c, D, 'pathological', `is-a ROOT ${seeds.root} (whole system, UNION+sort)`, isa.sql, isa.params);
  }

  // --- Fast-path (IR) page vs count, small vs deep offset ---
  {
    const src = srcHierarchy('descendent-of', id.finding); // 132172
    const p0 = sqlFastPage(src, 100, 0);
    caseSql(c, D, 'paging', `fast page LIMIT 100 OFFSET 0 (descendent-of finding 132k)`, p0.sql, p0.params);
    const pDeep = sqlFastPage(src, 100, 130000);
    caseSql(c, D, 'paging', `fast page LIMIT 100 OFFSET 130000 (deep offset)`, pDeep.sql, pDeep.params);
    const cnt = sqlFastCount(src);
    caseCount(c, D, 'paging', `fast COUNT(*) (descendent-of finding 132k)`, cnt.sql, cnt.params);
    // page+total two-query cost together
    caseJs(c, D, 'paging', `fast page+total two queries (offset 0)`, () => {
      c.db.prepare(p0.sql).all(...p0.params);
      return c.db.prepare(cnt.sql).get(...cnt.params);
    }, p0.sql, p0.params, 'page then count, as _tryFastPage does');
  }

  // --- Property filters (concept-valued: finding site 363698007) ---
  {
    const fs = c.propByCode.get('363698007'); // finding site
    if (fs) {
      let e = sqlPropExists(c, fs, true);
      caseSql(c, D, 'property', `exists 363698007 finding-site (concept_link)`, e.sql, e.params);
      let ne = sqlPropExists(c, fs, false);
      caseSql(c, D, 'pathological', `NOT EXISTS 363698007 finding-site (whole-system anti-join)`, ne.sql, ne.params);
      // = a specific target
      const tgt = c.db.prepare(`SELECT target_concept_id AS t, COUNT(*) n FROM concept_link WHERE property_id=? AND active=1 GROUP BY target_concept_id ORDER BY n DESC LIMIT 1`).get(fs.property_id);
      if (tgt) {
        const eq = sqlConceptFilter(fs, [tgt.t]);
        caseSql(c, D, 'property', `363698007 = <top target> (concept IN, 1 target)`, eq.sql, eq.params);
        // long IN list: top 50 targets
        const many = c.db.prepare(`SELECT target_concept_id AS t FROM concept_link WHERE property_id=? AND active=1 GROUP BY target_concept_id ORDER BY COUNT(*) DESC LIMIT 50`).all(fs.property_id).map((r) => r.t);
        const inl = sqlConceptFilter(fs, many);
        caseSql(c, D, 'property', `363698007 IN <50 targets> (long IN list)`, inl.sql, inl.params);
      }
    }
  }
  // --- Literal property = / exists (moduleId) ---
  {
    const mod = c.propByCode.get('moduleId');
    if (mod) {
      const top = c.db.prepare(`SELECT COALESCE(value_text,value_raw) v FROM concept_literal WHERE property_id=? AND active=1 GROUP BY v ORDER BY COUNT(*) DESC LIMIT 1`).get(mod.property_id);
      const lf = sqlLiteralFilter(mod, [top.v]);
      caseSql(c, D, 'property', `moduleId = <top> (literal =, dual NOCASE IN)`, lf.sql, lf.params);
      const le = sqlPropExists(c, mod, true);
      caseSql(c, D, 'property', `exists moduleId (literal, near-whole-system)`, le.sql, le.params);
    }
  }

  // --- Text search (FTS trigram) ---
  {
    caseSql(c, D, 'search-fts', `FTS display MATCH "heart" (common)`, ...[sqlFtsDisplay(c, 'heart')].flatMap((s) => [s.sql, s.params]));
    caseSql(c, D, 'search-fts', `FTS display MATCH "diabetes mellitus"`, ...[sqlFtsDisplay(c, 'diabetes mellitus')].flatMap((s) => [s.sql, s.params]));
    caseSql(c, D, 'search-fts', `FTS display MATCH "pheochromocytoma" (rare)`, ...[sqlFtsDisplay(c, 'pheochromocytoma')].flatMap((s) => [s.sql, s.params]));
    caseSql(c, D, 'search-fts', `FTS designation MATCH "heart" (3-table join)`, ...[sqlFtsDesignation(c, 'heart')].flatMap((s) => [s.sql, s.params]));
    // <3 char fallback to LIKE full scan
    caseSql(c, D, 'search-like', `LIKE display %ca% (<3char fallback, full scan)`, ...[sqlLikeDisplay(c, 'ca')].flatMap((s) => [s.sql, s.params]));
    // full multi-source _searchIds via provider
    caseJs(c, D, 'search-fts', `_searchIds("heart") 3 sources + JS Set/sort (end-to-end)`, () => prov._searchIds('heart'),
      sqlFtsDisplay(c, 'heart').sql, sqlFtsDisplay(c, 'heart').params, 'display+designation+literal unioned in a JS Set');
  }

  // --- Refset membership (21,400-member refset 723264001) ---
  {
    const vs = c.db.prepare(`SELECT vs_id FROM value_set WHERE cs_id=? AND url LIKE '%refset/723264001'`).get(c.csId);
    if (vs) {
      const m = sqlVsMembers(vs.vs_id);
      caseSql(c, D, 'refset', `in refset 723264001 (21,400 members)`, m.sql, m.params);
    }
  }

  // --- Set algebra: provider JS path vs single-statement SQL ---
  setAlgebra(c, D, prov, {
    A: { label: `descendent-of finding (132k)`, op: 'descendent-of', seed: id.finding },
    B: { label: `descendent-of disease 64572001`, op: 'descendent-of', seed: id.disease },
    C: { label: `descendent-of procedure (61k)`, op: 'descendent-of', seed: id.procedure },
  });

  // --- Pathological: unbounded whole-system iteration (allConceptIds) ---
  caseSql(c, D, 'pathological', `all concept_ids ORDER BY concept_id (whole-system materialize)`,
    `SELECT concept_id FROM concept WHERE cs_id = ? ORDER BY concept_id`, [c.csId]);

  // --- End-to-end IR terminals: fast path vs forced slow (activeOnly) ---
  await irTerminals(prov, D, { property: 'concept', op: 'descendent-of', value: seeds.finding }, 'descendent-of finding (132k)');
}

// -----------------------------------------------------------------------------
// LOINC matrix
// -----------------------------------------------------------------------------
async function runLoinc(c, prov) {
  const D = 'loinc';
  // parent-hierarchy seeds
  const seeds = { s10: 'LP203652-5', s100: 'LP14343-5', s1k: 'LP65098-3', s10k: 'LP29684-5', big: 'LP432695-7' };
  const id = {}; for (const [k, v] of Object.entries(seeds)) id[k] = c.locate(v);
  for (const [k, size] of [['s10', 10], ['s100', 100], ['s1k', 1044], ['s10k', 10278], ['big', 181430]]) {
    if (id[k] == null) continue;
    const s = sqlHierarchy(c, 'descendent-of', id[k]);
    caseSql(c, D, 'hierarchy', `descendent-of ${seeds[k]} (~${size})`, s.sql, s.params);
  }

  // CLASSTYPE literal = (integer stored as raw text) — CLASSTYPE=1 -> 66,861
  {
    const ct = c.propByCode.get('CLASSTYPE');
    const f = sqlLiteralFilter(ct, ['1']);
    caseSql(c, D, 'property', `CLASSTYPE = 1 (literal, 66,861 rows)`, f.sql, f.params);
    const flist = sqlLiteralFilter(ct, ['1', '2', '3', '4']);
    caseSql(c, D, 'property', `CLASSTYPE IN (1,2,3,4) (all classtypes)`, flist.sql, flist.params);
  }
  // STATUS = ACTIVE (170,391 rows) — near-whole system literal
  {
    const st = c.propByCode.get('STATUS');
    const f = sqlLiteralFilter(st, ['ACTIVE']);
    caseSql(c, D, 'property', `STATUS = ACTIVE (literal, 170,391 rows)`, f.sql, f.params);
  }
  // SCALE_TYP concept-valued with code-or-display (Qn) -> exercises display join
  {
    const sc = c.propByCode.get('SCALE_TYP');
    // provider path: resolve "Qn" by code AND by display, then IN
    caseJs(c, D, 'property', `SCALE_TYP = Qn (code-or-display resolve + concept IN, 43,658)`, () => prov._propertyIds({ name: 'SCALE_TYP', def: sc, op: '=', value: 'Qn' }),
      `SELECT concept_id FROM concept WHERE cs_id = ? AND display = ?`, [c.csId, 'Qn'], 'display-join resolution then target IN');
    // the byName display lookup in isolation (is it indexed?)
    caseSql(c, D, 'property', `  display = 'Qn' lookup (code-or-display leg)`, `SELECT concept_id FROM concept WHERE cs_id = ? AND display = ?`, [c.csId, 'Qn']);
  }
  // COMPONENT concept IN (big prop, 962k edges)
  {
    const comp = c.propByCode.get('COMPONENT');
    const top = c.db.prepare(`SELECT target_concept_id t FROM concept_link WHERE property_id=? AND active=1 GROUP BY t ORDER BY COUNT(*) DESC LIMIT 1`).get(comp.property_id);
    const f = sqlConceptFilter(comp, [top.t]);
    caseSql(c, D, 'property', `COMPONENT = <top target> (concept IN)`, f.sql, f.params);
  }

  // Regex on high-cardinality literal RELATEDNAMES2 (109,325 rows fetched to JS)
  {
    const rn = c.propByCode.get('RELATEDNAMES2');
    const cand = sqlLiteralRegexCandidates(rn);
    caseJs(c, D, 'regex', `regex RELATEDNAMES2 ~ /sodium/i (fetch 109,325 -> JS RegExp)`, () => prov._literalRegexIds(rn, 'sodium'),
      cand.sql, cand.params, 'PATHOLOGICAL: fetches ALL candidate rows into JS then RegExp.test each');
    // the raw candidate fetch alone (SQL portion)
    caseSql(c, D, 'regex', `  RELATEDNAMES2 candidate fetch (SQL only, 109,325 rows)`, cand.sql, cand.params);
    // STATUS regex — 183,412 candidate rows
    const st = c.propByCode.get('STATUS');
    caseJs(c, D, 'regex', `regex STATUS ~ /ACT/ (fetch 183,412 -> JS RegExp)`, () => prov._literalRegexIds(st, 'ACT'),
      sqlLiteralRegexCandidates(st).sql, sqlLiteralRegexCandidates(st).params, 'high-cardinality literal regex');
  }

  // FTS search
  caseSql(c, D, 'search-fts', `FTS display MATCH "glucose"`, ...[sqlFtsDisplay(c, 'glucose')].flatMap((s) => [s.sql, s.params]));
  caseSql(c, D, 'search-fts', `FTS display MATCH "sodium"`, ...[sqlFtsDisplay(c, 'sodium')].flatMap((s) => [s.sql, s.params]));

  // Set algebra: CLASSTYPE=1 (66k) INTERSECT SCALE_TYP=Qn (43k), literal x concept
  setAlgebraCustom(c, D, prov, 'CLASSTYPE=1 ∩ SCALE_TYP-Qn (literal ∩ concept)',
    () => prov._propertyIds({ name: 'CLASSTYPE', def: c.propByCode.get('CLASSTYPE'), op: '=', value: '1' }),
    () => prov._propertyIds({ name: 'SCALE_TYP', def: c.propByCode.get('SCALE_TYP'), op: '=', value: 'Qn' }),
    sqlLiteralFilter(c.propByCode.get('CLASSTYPE'), ['1']),
    null);

  await irTerminals(prov, D, { property: 'concept', op: 'descendent-of', value: seeds.big }, 'descendent-of LP432695-7 (181k)');
}

// -----------------------------------------------------------------------------
// RxNorm matrix (NO hierarchy, NO value sets — literal + concept-rel props only)
// -----------------------------------------------------------------------------
async function runRxnorm(c, prov) {
  const D = 'rxnorm';
  // TTY literal = (SCD 17,547) and IN
  {
    const tty = c.propByCode.get('TTY');
    let f = sqlLiteralFilter(tty, ['SCD']);
    caseSql(c, D, 'property', `TTY = SCD (literal, 17,547)`, f.sql, f.params);
    f = sqlLiteralFilter(tty, ['SCD', 'SBD', 'IN', 'PIN', 'BN', 'SY', 'PSN', 'SCDC']);
    caseSql(c, D, 'property', `TTY IN (8 values) (literal long IN)`, f.sql, f.params);
  }
  // STY = T200 (192,492 rows — near whole system)
  {
    const sty = c.propByCode.get('STY');
    const f = sqlLiteralFilter(sty, ['T200']);
    caseSql(c, D, 'property', `STY = T200 (literal, 192,492 rows — near whole)`, f.sql, f.params);
    const e = sqlPropExists(c, sty, true);
    caseSql(c, D, 'property', `exists STY (literal)`, e.sql, e.params);
    const ne = sqlPropExists(c, sty, false);
    caseSql(c, D, 'pathological', `NOT EXISTS STY (whole-system anti-join)`, ne.sql, ne.params);
  }
  // Concept-valued relationship: has_ingredient = <top ingredient> (983 sources)
  {
    const hi = c.propByCode.get('has_ingredient');
    const top = c.db.prepare(`SELECT target_concept_id t FROM concept_link WHERE property_id=? AND active=1 GROUP BY t ORDER BY COUNT(*) DESC LIMIT 1`).get(hi.property_id);
    const f = sqlConceptFilter(hi, [top.t]);
    caseSql(c, D, 'property', `has_ingredient = <top> (concept rel, 983)`, f.sql, f.params);
    const e = sqlPropExists(c, hi, true);
    caseSql(c, D, 'property', `exists has_ingredient (concept rel)`, e.sql, e.params);
  }
  // FTS
  caseSql(c, D, 'search-fts', `FTS display MATCH "aspirin"`, ...[sqlFtsDisplay(c, 'aspirin')].flatMap((s) => [s.sql, s.params]));
  caseSql(c, D, 'search-fts', `FTS display MATCH "sodium chloride"`, ...[sqlFtsDisplay(c, 'sodium chloride')].flatMap((s) => [s.sql, s.params]));

  // Set algebra: TTY=SCD (17k) INTERSECT STY=T200 (192k), literal ∩ literal
  setAlgebraCustom(c, D, prov, 'TTY-SCD ∩ STY-T200 (literal ∩ literal)',
    () => prov._propertyIds({ name: 'TTY', def: c.propByCode.get('TTY'), op: '=', value: 'SCD' }),
    () => prov._propertyIds({ name: 'STY', def: c.propByCode.get('STY'), op: '=', value: 'T200' }),
    sqlLiteralFilter(c.propByCode.get('TTY'), ['SCD']),
    sqlLiteralFilter(c.propByCode.get('STY'), ['T200']));
}

// -----------------------------------------------------------------------------
// Set-algebra measurement: provider per-clause-SQL + JS setop  vs  single SQL.
// A/B/C describe hierarchy clauses (closure sub-selects). Measures:
//   - each clause's SQL fetch (full sorted array into JS)
//   - JS intersect/diff/union cost in isolation
//   - single-statement all-SQL INTERSECT/EXCEPT/UNION set + first-page variant
// => the "JS materialization tax".
// -----------------------------------------------------------------------------
function setAlgebra(c, D, prov, { A, B, C }) {
  const srcA = srcHierarchy(A.op, A.seed);
  const srcB = srcHierarchy(B.op, B.seed);
  const srcC = srcHierarchy(C.op, C.seed);
  const fetchA = () => c.db.prepare(sqlHierarchy(c, A.op, A.seed).sql).all(...sqlHierarchy(c, A.op, A.seed).params).map((r) => r.id);
  const fetchB = () => c.db.prepare(sqlHierarchy(c, B.op, B.seed).sql).all(...sqlHierarchy(c, B.op, B.seed).params).map((r) => r.id);
  const fetchC = () => c.db.prepare(sqlHierarchy(c, C.op, C.seed).sql).all(...sqlHierarchy(c, C.op, C.seed).params).map((r) => r.id);

  void srcC; void fetchC; // C is used by the 3-way union measured separately in main
  measureSetPair(c, D, `INTERSECT: ${A.label} ∩ ${B.label}`, fetchA, fetchB,
    (a, b) => intersectSorted(a, b), 'intersect', srcA, srcB);
  measureSetPair(c, D, `DIFF (exclude): ${A.label} \\ ${B.label}`, fetchA, fetchB,
    (a, b) => diffSorted(a, b), 'except', srcA, srcB);
}

// simpler custom two-clause set-algebra measurement with arbitrary id producers.
function setAlgebraCustom(c, D, prov, label, prodA, prodB, srcA, srcB) {
  // provider path: pull both full arrays, JS intersect
  const tProv = timeFn(() => { const a = prodA(); const b = prodB(); return intersectSorted(a, b); });
  const a0 = prodA(); const b0 = prodB();
  const tA = timeFn(() => prodA());
  const tB = timeFn(() => prodB());
  const tJs = timeFn(() => intersectSorted(a0, b0));
  record({ db: D, category: 'set-algebra', name: `${label} — provider (SQLx2 + JS intersect)`, note: `|A|=${a0.length} |B|=${b0.length} out=${intersectSorted(a0, b0).length}`,
    sql: '(two statements + intersectSorted)', params: [], rows: intersectSorted(a0, b0).length,
    medianMs: tProv.medianMs, minMs: tProv.minMs, iters: tProv.iters, timedOut: tProv.timedOut, verdict: 'JS-SETOP', fullScan: false, indexed: true, tempBtree: false,
    eqp: [`fetchA ${tA.medianMs.toFixed(1)}ms`, `fetchB ${tB.medianMs.toFixed(1)}ms`, `JS intersect ${tJs.medianMs.toFixed(1)}ms`] });
  RESULTS[RESULTS.length - 1].breakdown = { fetchA: tA.medianMs, fetchB: tB.medianMs, jsSetop: tJs.medianMs };

  // single-statement all-SQL, if both srcs are pure SQL
  if (srcA && srcB) {
    const setSql = `SELECT id FROM (${srcA.sql}) INTERSECT SELECT id FROM (${srcB.sql})`;
    const setParams = [...srcA.params, ...srcB.params];
    caseSql(c, D, 'set-algebra', `${label} — single SQL INTERSECT (full set)`, setSql, setParams);
    const pageSql = `SELECT c.code FROM (${setSql}) s JOIN concept c ON c.concept_id = s.id ORDER BY c.concept_id LIMIT 100`;
    caseSql(c, D, 'set-algebra', `${label} — single SQL INTERSECT + LIMIT 100 (page)`, pageSql, setParams);
  } else if (srcA && !srcB) {
    // one side is SQL-expressible; note the mixed case
    record({ db: D, category: 'set-algebra', name: `${label} — single-SQL not attempted (mixed literal/concept)`, note: 'B side is concept-display resolve; left as provider JS', sql: '(n/a)', params: [], rows: null, medianMs: null, verdict: 'N/A', fullScan: false, indexed: false, tempBtree: false, eqp: [] });
  }
}

function measureSetPair(c, D, label, fetchA, fetchB, jsOp, sqlKw, srcA, srcB) {
  const a0 = fetchA(); const b0 = fetchB();
  const out = jsOp(a0, b0);
  const tProv = timeFn(() => { const a = fetchA(); const b = fetchB(); return jsOp(a, b); });
  const tA = timeFn(fetchA); const tB = timeFn(fetchB); const tJs = timeFn(() => jsOp(a0, b0));
  record({ db: D, category: 'set-algebra', name: `${label} — provider (SQLx2 + JS ${sqlKw})`, note: `|A|=${a0.length} |B|=${b0.length} out=${out.length}`,
    sql: '(two statements + JS setop)', params: [], rows: out.length, medianMs: tProv.medianMs, minMs: tProv.minMs, iters: tProv.iters, timedOut: tProv.timedOut,
    verdict: 'JS-SETOP', fullScan: false, indexed: true, tempBtree: false,
    eqp: [`fetchA ${tA.medianMs.toFixed(1)}ms`, `fetchB ${tB.medianMs.toFixed(1)}ms`, `JS ${sqlKw} ${tJs.medianMs.toFixed(1)}ms`] });
  RESULTS[RESULTS.length - 1].breakdown = { fetchA: tA.medianMs, fetchB: tB.medianMs, jsSetop: tJs.medianMs };
  const kw = sqlKw === 'except' ? 'EXCEPT' : 'INTERSECT';
  const setSql = `SELECT id FROM (${srcA.sql}) ${kw} SELECT id FROM (${srcB.sql})`;
  const params = [...srcA.params, ...srcB.params];
  caseSql(c, D, 'set-algebra', `${label} — single SQL ${kw} (full set)`, setSql, params);
  const pageSql = `SELECT c.code FROM (${setSql}) s JOIN concept c ON c.concept_id = s.id ORDER BY c.concept_id LIMIT 100`;
  caseSql(c, D, 'set-algebra', `${label} — single SQL ${kw} + LIMIT 100 (page)`, pageSql, params);
}

function measureSetUnion3(c, D, label, seeds3) {
  const fetch = (seed) => c.db.prepare(sqlHierarchy(c, 'descendent-of', seed).sql).all(seed).map((r) => r.id);
  const arrs = seeds3.map((s) => fetch(s));
  const tProv = timeFn(() => unionSorted(seeds3.map((s) => fetch(s))));
  const tJs = timeFn(() => unionSorted(arrs));
  const out = unionSorted(arrs);
  record({ db: D, category: 'set-algebra', name: `${label} — provider (SQLx3 + JS unionSorted)`, note: `out=${out.length}`,
    sql: '(three statements + unionSorted concat+sort)', params: [], rows: out.length, medianMs: tProv.medianMs, minMs: tProv.minMs, iters: tProv.iters, timedOut: tProv.timedOut,
    verdict: 'JS-SETOP', fullScan: false, indexed: true, tempBtree: false, eqp: [`JS unionSorted ${tJs.medianMs.toFixed(1)}ms`] });
  RESULTS[RESULTS.length - 1].breakdown = { jsSetop: tJs.medianMs };
  const parts = seeds3.map(() => `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ?`);
  const setSql = parts.join(' UNION ');
  const pageSql = `SELECT c.code FROM (${setSql}) s JOIN concept c ON c.concept_id = s.id ORDER BY c.concept_id LIMIT 100`;
  caseSql(c, D, 'set-algebra', `${label} — single SQL UNION (full set)`, setSql, seeds3);
  caseSql(c, D, 'set-algebra', `${label} — single SQL UNION + LIMIT 100 (page)`, pageSql, seeds3);
}

// -----------------------------------------------------------------------------
// End-to-end IR terminals: provider.executeIR fast path vs forced slow path.
// -----------------------------------------------------------------------------
async function irTerminals(prov, D, fc, label) {
  const subtree = { kind: 'selector', shape: 'filter', filterClauses: [fc] };
  // fast page (no activeOnly): pushes membership + LIMIT into SQL
  const tFast = await timeFnAsync(() => prov.executeIR(subtree, { offset: 0, count: 100, activeOnly: false }).then((r) => r.candidates));
  const rFast = await prov.executeIR(subtree, { offset: 0, count: 100, activeOnly: false });
  record({ db: D, category: 'ir-terminal', name: `executeIR fast page LIMIT100 [${label}]`, note: `total=${rFast.total} candidates=${rFast.candidates.length}`,
    sql: '(provider._tryFastPage: page SQL + COUNT SQL)', params: [], rows: rFast.candidates.length, medianMs: tFast.medianMs, minMs: tFast.minMs, iters: tFast.iters, timedOut: tFast.timedOut,
    verdict: 'INDEX', fullScan: false, indexed: true, tempBtree: false, eqp: ['fast path (see paging category for the raw SQL EQP)'] });
  // forced slow path: activeOnly=true routes through _evalIR (full array into JS, filter by active set, slice)
  const tSlow = await timeFnAsync(() => prov.executeIR(subtree, { offset: 0, count: 100, activeOnly: true }).then((r) => r.candidates));
  const rSlow = await prov.executeIR(subtree, { offset: 0, count: 100, activeOnly: true });
  record({ db: D, category: 'ir-terminal', name: `executeIR SLOW page LIMIT100 activeOnly [${label}]`, note: `total=${rSlow.total} — _evalIR materializes full array + activeSet filter`,
    sql: '(provider._evalIR + _activeIdSet filter + slice)', params: [], rows: rSlow.candidates.length, medianMs: tSlow.medianMs, minMs: tSlow.minMs, iters: tSlow.iters, timedOut: tSlow.timedOut,
    verdict: 'JS-SETOP', fullScan: false, indexed: true, tempBtree: false, eqp: ['slow path: SELECT ... + _candidateFromId per page row'] });
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main() {
  const ld = await LanguageDefinitions.fromFiles('tx/data');
  const i18n = new I18nSupport('translations', ld); await i18n.load();
  // Large time limit: this profiler intentionally runs for minutes; the default
  // 30s OperationContext deadCheck would abort the regex (deadCheck) path.
  const newOp = () => new OperationContext('en', i18n, null, 1e6);

  const dbs = [
    ['sct', `${HOME}/work/tx-dbs/sct-v1.db`, runSnomed],
    ['loinc', `${HOME}/work/tx-dbs/loinc-v1.db`, runLoinc],
    ['rxnorm', `${HOME}/work/tx-dbs/rxnorm-v1.db`, runRxnorm],
  ];

  for (const [name, path, runner] of dbs) {
    console.log(`\n===== ${name} =====`);
    const raw = openRaw(path);
    const c = ctxFor(raw);
    const factory = new SqliteCodeSystemFactory(i18n, path);
    const prov = await factory.build(newOp(), []);
    try {
      await runner(c, prov);
      // SNOMED union-of-three needs seeds resolved; do it here for cleanliness
      if (name === 'sct') {
        const s3 = ['71388002', '123037004', '105590001'].map((cd) => c.locate(cd));
        measureSetUnion3(c, 'sct', 'UNION: procedure ∪ body ∪ substance', s3);
      }
    } catch (e) {
      console.error(`  ERROR in ${name}:`, e.stack || e.message);
    }
    await factory.close();
    raw.close();
  }

  fs.writeFileSync(OUT, JSON.stringify(RESULTS, null, 2));
  console.log(`\nWrote ${RESULTS.length} records to ${OUT}`);
  printSummary();
}

function printSummary() {
  const scans = RESULTS.filter((r) => r.fullScan);
  const temps = RESULTS.filter((r) => r.tempBtree);
  const runaway = RESULTS.filter((r) => r.medianMs != null && r.medianMs > 100 && r.category !== 'ir-terminal');
  console.log(`\n--- full scans: ${scans.length}, temp-btree sorts: ${temps.length}, >100ms shapes: ${runaway.length} ---`);
  console.log('\nSlowest 15:');
  RESULTS.filter((r) => r.medianMs != null).sort((a, b) => b.medianMs - a.medianMs).slice(0, 15)
    .forEach((r) => console.log(`  ${r.medianMs.toFixed(1).padStart(9)}ms  [${r.db}] ${r.name}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
