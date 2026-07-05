#!/usr/bin/env node
/* eslint-disable */
'use strict';

// -----------------------------------------------------------------------------
// sqlite-v1 PERFORMANCE BENCHMARK: OLD terminology providers vs NEW generic
// sqlite-v1 provider.
//
// Measures end-to-end provider-contract latency (NOT raw SQL). The OLD LOINC /
// RxNorm providers are async-sqlite3-based; the NEW SqliteCodeSystemProvider is
// better-sqlite3-based. That driver + schema difference IS the comparison.
//
// Usage:
//   node scripts/sqlite-v1-bench/bench-provider.mjs --all [--json DIR]
//   node scripts/sqlite-v1-bench/bench-provider.mjs --pair loinc|rxnorm|snomed
//
// Writes one JSON per pair into the json dir (default /tmp/claude-1000/) plus a
// combined bench-all.json. Never mutates the DBs (all opened read-only where a
// direct handle is used). Runs every measured op SEQUENTIALLY.
//
// Method (perf hygiene):
//   * performance.now() for all timings.
//   * >=3 warmup iterations, then N timed iterations chosen so each cell takes
//     roughly 0.5-5s; report median + p95 (ms) or ops/sec for micro-ops.
//   * factory.load() timed separately (cold start, single run).
//   * Same seeded code list drives both sides of a pair.
// -----------------------------------------------------------------------------

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);

// --- repo modules -----------------------------------------------------------
const { LanguageDefinitions } = require(path.join(REPO, 'library/languages'));
const { I18nSupport } = require(path.join(REPO, 'library/i18nsupport'));
const { OperationContext } = require(path.join(REPO, 'tx/operation-context'));
const { Designations, SearchFilterText } = require(path.join(REPO, 'tx/library/designations'));

const { RxNormServicesFactory } = require(path.join(REPO, 'tx/cs/cs-rxnorm'));
const { LoincServicesFactory } = require(path.join(REPO, 'tx/cs/cs-loinc'));
const { SqliteCodeSystemFactory } = require(path.join(REPO, 'tx/cs/cs-sqlite'));

const Database = require('better-sqlite3');

// --- DB paths ---------------------------------------------------------------
const HOME = process.env.HOME;
const DBS = {
  loinc: {
    old: path.join(HOME, 'work/tx-dbs/loinc-old.db'),
    new: path.join(HOME, 'work/tx-dbs/loinc-v1.db'),
  },
  rxnorm: {
    old: path.join(HOME, 'work/tx-dbs/rxnorm-old.db'),
    new: path.join(HOME, 'work/tx-dbs/rxnorm-v1.db'),
  },
  snomed: {
    old: null, // no old baseline
    new: path.join(HOME, 'work/tx-dbs/sct-v1.db'),
  },
};

// Approximate historical import wall-times (do NOT re-run imports).
const IMPORT_NOTES = {
  loinc: { oldApproxMin: 4, oldNote: 'old ~4min with the new txn patch (approx)' },
  rxnorm: { oldApproxMin: 12, oldNote: 'old ~12min from earlier logs (approx)' },
  snomed: { oldApproxMin: null, oldNote: 'no old baseline' },
};

// --- CLI --------------------------------------------------------------------
function parseArgs(argv) {
  const a = { pairs: [], json: '/tmp/claude-1000' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--all') a.pairs = ['loinc', 'rxnorm', 'snomed'];
    else if (t === '--pair') a.pairs.push(argv[++i]);
    else if (t === '--json') a.json = argv[++i];
    else throw new Error('Unknown arg: ' + t);
  }
  if (a.pairs.length === 0) a.pairs = ['loinc', 'rxnorm', 'snomed'];
  for (const p of a.pairs) if (!DBS[p]) throw new Error('Unknown pair: ' + p);
  return a;
}

// deterministic PRNG (mulberry32)
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 1234567;

// --- stats ------------------------------------------------------------------
function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function summarize(samplesMs) {
  const s = samplesMs.slice().sort((a, b) => a - b);
  return {
    n: s.length,
    medianMs: round(median(s)),
    p95Ms: round(pct(s, 95)),
    minMs: round(s[0]),
    maxMs: round(s[s.length - 1]),
  };
}
function round(x) { return x == null ? null : Math.round(x * 1000) / 1000; }

// Time a synchronous-or-async op `iters` times after `warmup` warmups.
// `fn` receives the iteration index (so it can pick a distinct input).
async function timeLoop(fn, { warmup = 3, iters = 100 } = {}) {
  for (let i = 0; i < warmup; i++) await fn(i);
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  return summarize(samples);
}

// --- filter drain -----------------------------------------------------------
// executeFilters + drain ALL results of sets[0] via filterMore/filterConcept,
// counting codes. Returns { count, wallMs }.
async function executeAndDrain(cs, applyFilter) {
  const t0 = performance.now();
  const prep = await cs.getPrepContext(true);
  await applyFilter(cs, prep);
  const sets = await cs.executeFilters(prep);
  let count = 0;
  if (sets && sets.length > 0) {
    const set = sets[0];
    while (await cs.filterMore(prep, set)) {
      const ctx = await cs.filterConcept(prep, set);
      if (ctx == null) break;
      const code = await cs.code(ctx);
      if (code != null) count++;
    }
  }
  if (cs.filterFinish) await cs.filterFinish(prep);
  return { count, wallMs: performance.now() - t0 };
}

// Build a filter set (execute only, no drain) and return the set for probing.
async function buildFilterSet(cs, applyFilter) {
  const prep = await cs.getPrepContext(true);
  await applyFilter(cs, prep);
  const sets = await cs.executeFilters(prep);
  return { prep, set: sets && sets[0] };
}

// --- full lookup decoration (per-code) --------------------------------------
async function decorateOne(cs, langDefs, code) {
  const loc = await cs.locate(code);
  const ctx = loc && loc.context;
  if (!ctx) return;
  await cs.display(ctx);
  const d = new Designations(langDefs);
  await cs.designations(ctx, d);
  await cs.properties(ctx);
  await cs.isInactive(ctx);
  await cs.getStatus(ctx);
}

// --- sample codes from NEW db (seeded, shared across both sides) -------------
function sampleCodesFromNew(newDbPath, csId, n, seed, { activeOnly = false } = {}) {
  const db = new Database(newDbPath, { readonly: true });
  const where = activeOnly ? 'AND active = 1' : '';
  const rows = db.prepare(
    `SELECT code FROM concept WHERE cs_id = ? ${where} ORDER BY concept_id`
  ).all(csId);
  db.close();
  const rand = mulberry32(seed);
  const picks = [];
  for (let i = 0; i < n; i++) picks.push(rows[Math.floor(rand() * rows.length)].code);
  return picks;
}

// Distinct random codes (no repeats), for membership probing.
function distinctCodesFromNew(newDbPath, csId, n, seed, filterSql = '') {
  const db = new Database(newDbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT code FROM concept WHERE cs_id = ? ${filterSql} ORDER BY concept_id`
  ).all(csId);
  db.close();
  const rand = mulberry32(seed);
  const out = new Set();
  let guard = 0;
  while (out.size < Math.min(n, rows.length) && guard < n * 100) {
    out.add(rows[Math.floor(rand() * rows.length)].code);
    guard++;
  }
  return [...out];
}

// Seeded subsumption pairs (ancestor, descendant) from the NEW closure table,
// plus non-related pairs. Returns array of [a, b].
function subsumptionPairs(newDbPath, n, seed) {
  const db = new Database(newDbPath, { readonly: true });
  const rand = mulberry32(seed);
  // Pull a chunk of closure edges, then sample.
  const edges = db.prepare(
    `SELECT ca.code AS anc, cd.code AS des
       FROM closure cl
       JOIN concept ca ON ca.concept_id = cl.ancestor_id
       JOIN concept cd ON cd.concept_id = cl.descendant_id
      WHERE cl.ancestor_id <> cl.descendant_id
      LIMIT 200000`
  ).all();
  db.close();
  const pairs = [];
  for (let i = 0; i < n && edges.length > 0; i++) {
    const e = edges[Math.floor(rand() * edges.length)];
    pairs.push([e.anc, e.des]);
  }
  return pairs;
}

function csIdOf(newDbPath) {
  const db = new Database(newDbPath, { readonly: true });
  const row = db.prepare('SELECT cs_id FROM code_system ORDER BY cs_id LIMIT 1').get();
  db.close();
  return row.cs_id;
}

function statsJson(newDbPath) {
  try {
    const db = new Database(newDbPath, { readonly: true });
    const row = db.prepare(
      `SELECT stats_json, started_at, completed_at FROM load_audit
        WHERE status = 'success' ORDER BY run_id DESC LIMIT 1`
    ).get();
    db.close();
    if (!row) return null;
    let importMs = null;
    if (row.started_at && row.completed_at) {
      importMs = new Date(row.completed_at) - new Date(row.started_at);
    }
    return { stats: row.stats_json ? JSON.parse(row.stats_json) : null, importMs };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return null; }
}

// -----------------------------------------------------------------------------
// FILTER SPECS per pair. `drainAll` filters go through executeAndDrain; the
// SNOMED refset is a ValueSet expansion (buildKnownValueSet), handled separately.
// -----------------------------------------------------------------------------
const FILTER_SPECS = {
  loinc: [
    { name: 'CLASSTYPE=1', apply: (cs, p) => cs.filter(p, true, 'CLASSTYPE', '=', '1') },
    { name: 'STATUS=ACTIVE', apply: (cs, p) => cs.filter(p, true, 'STATUS', '=', 'ACTIVE') },
    { name: 'SCALE_TYP=Qn', apply: (cs, p) => cs.filter(p, true, 'SCALE_TYP', '=', 'Qn') },
    { name: 'concept descendent-of LP432695-7', apply: (cs, p) => cs.filter(p, true, 'concept', 'descendent-of', 'LP432695-7') },
    { name: "searchFilter('glucose')", apply: (cs, p) => cs.searchFilter(p, new SearchFilterText('glucose'), false) },
  ],
  rxnorm: [
    { name: 'TTY=IN', apply: (cs, p) => cs.filter(p, true, 'TTY', '=', 'IN') },
    { name: 'STY=T121', apply: (cs, p) => cs.filter(p, true, 'STY', '=', 'T121') },
    { name: 'SAB=RXNORM', apply: (cs, p) => cs.filter(p, true, 'SAB', '=', 'RXNORM') },
    // has_tradename: OLD wants CUI: prefix; NEW rewrites it away (filterValueRewrites).
    // We pass the OLD-form value to both; NEW strips the prefix internally.
    { name: 'has_tradename=CUI:854979', apply: (cs, p) => cs.filter(p, true, 'has_tradename', '=', 'CUI:854979') },
    { name: "searchFilter('aspirin')", apply: (cs, p) => cs.searchFilter(p, new SearchFilterText('aspirin'), false) },
  ],
  // SNOMED: new-only. is-a filters via filter protocol; refset via ValueSet.
  snomed: [
    { name: 'concept is-a 404684003 (Clinical finding)', apply: (cs, p) => cs.filter(p, true, 'concept', 'is-a', '404684003') },
    { name: 'concept is-a 373873005 (Pharmaceutical)', apply: (cs, p) => cs.filter(p, true, 'concept', 'is-a', '373873005') },
    { name: "searchFilter('myocardial')", apply: (cs, p) => cs.searchFilter(p, new SearchFilterText('myocardial'), false) },
  ],
};

// The filter to use for filterLocate membership probing (biggest set of pair).
const PROBE_FILTER = {
  loinc: { name: 'STATUS=ACTIVE', apply: (cs, p) => cs.filter(p, true, 'STATUS', '=', 'ACTIVE') },
  rxnorm: { name: 'SAB=RXNORM', apply: (cs, p) => cs.filter(p, true, 'SAB', '=', 'RXNORM') },
  snomed: { name: 'concept is-a 404684003', apply: (cs, p) => cs.filter(p, true, 'concept', 'is-a', '404684003') },
};

const REFSET = { snomed: { id: '723264001', url: 'http://snomed.info/sct?fhir_vs=refset/723264001' } };

// -----------------------------------------------------------------------------
// Boot i18n + factories, run all benchmarks for one pair.
// -----------------------------------------------------------------------------
async function benchPair(pairName, ctx) {
  const { langDefs, i18n, freshOp } = ctx;
  const dbPaths = DBS[pairName];
  const hasOld = !!dbPaths.old;

  const report = {
    pair: pairName,
    dbs: dbPaths,
    seed: SEED,
    generatedAt: new Date().toISOString(),
    ops: {},
    meta: {},
  };

  // --- machine / driver / size context ------------------------------------
  const newAudit = statsJson(dbPaths.new);
  report.meta = {
    node: process.version,
    betterSqlite3: require(path.join(REPO, 'node_modules/better-sqlite3/package.json')).version,
    oldDriver: hasOld ? 'sqlite3 (async)' : null,
    newDriver: 'better-sqlite3 (sync)',
    dbSizeBytes: { old: hasOld ? fileSize(dbPaths.old) : null, new: fileSize(dbPaths.new) },
    newLoadAudit: newAudit,
    importNotes: IMPORT_NOTES[pairName],
  };

  // --- factories + cold-start load() timing --------------------------------
  let oldFactory = null;
  if (hasOld) {
    oldFactory = pairName === 'rxnorm'
      ? new RxNormServicesFactory(i18n, dbPaths.old)
      : new LoincServicesFactory(i18n, dbPaths.old);
  }
  const newFactory = new SqliteCodeSystemFactory(i18n, dbPaths.new);

  const loadTimings = {};
  if (hasOld) {
    const t0 = performance.now();
    await oldFactory.load();
    loadTimings.oldLoadMs = round(performance.now() - t0);
  }
  {
    const t0 = performance.now();
    await newFactory.load();
    loadTimings.newLoadMs = round(performance.now() - t0);
  }
  report.ops.factoryLoad = loadTimings;

  const oldCS = hasOld ? await oldFactory.build(freshOp(), []) : null;
  const newCS = await newFactory.build(freshOp(), []);

  const csId = csIdOf(dbPaths.new);
  report.meta.totalCount = {
    old: hasOld ? await oldCS.totalCount().catch(() => null) : null,
    new: await newCS.totalCount().catch(() => null),
  };

  // === OP 1: locate() hot — 1000 random codes, shared list ================
  {
    const codes = sampleCodesFromNew(dbPaths.new, csId, 1000, SEED + 1);
    const run = async (cs) => timeLoop(async (i) => { await cs.locate(codes[i % codes.length]); },
      { warmup: 20, iters: 1000 });
    const newR = await run(newCS);
    const oldR = hasOld ? await run(oldCS) : null;
    report.ops.locateHot = { codes: codes.length, old: oldR, new: newR, ratio: ratio(oldR, newR) };
  }

  // === OP 2: full lookup decoration — 200 codes, per-code median ==========
  {
    const codes = sampleCodesFromNew(dbPaths.new, csId, 200, SEED + 2);
    const run = async (cs) => timeLoop(async (i) => { await decorateOne(cs, langDefs, codes[i % codes.length]); },
      { warmup: 5, iters: 200 });
    const newR = await run(newCS);
    const oldR = hasOld ? await run(oldCS) : null;
    report.ops.lookupDecoration = { codes: codes.length, old: oldR, new: newR, ratio: ratio(oldR, newR) };
  }

  // === OP 3: filter execution + drain ALL =================================
  {
    const filters = {};
    for (const spec of FILTER_SPECS[pairName]) {
      const cell = { name: spec.name };
      // NEW
      cell.new = await benchDrain(newCS, spec.apply);
      // OLD (skip searchFilter form differences are fine; both sides run same apply)
      if (hasOld) cell.old = await benchDrain(oldCS, spec.apply);
      cell.ratioWallMs = cell.old ? ratioNum(cell.old.wallMedianMs, cell.new.wallMedianMs) : null;
      filters[spec.name] = cell;
    }
    // SNOMED refset (723264001), new-only. A refset is exposed as an implicit
    // ValueSet expansion (buildKnownValueSet), NOT a filter() clause. This DB's
    // stored implicitValueSets patterns lack the '?' separator the URL matcher
    // needs, so buildKnownValueSet returns null for the canonical refset URL; we
    // detect that and fall back to timing the provider's own refset member
    // enumeration SQL (the exact query _buildVsTable runs) via a read-only
    // handle, so the cell is still an apples-to-apples "expand the refset" op.
    if (pairName === 'snomed') {
      const rf = REFSET.snomed;
      const urlForms = [rf.url, `${newCS.system()}?fhir_vs=refset/${rf.id}`, `fhir_vs=refset/${rf.id}`];
      let method = null;
      let probe = null;
      for (const u of urlForms) {
        try { probe = await newFactory.buildKnownValueSet(u, null); } catch { probe = null; }
        if (probe) { method = 'buildKnownValueSet'; break; }
      }
      let bench;
      if (method === 'buildKnownValueSet') {
        const u = urlForms.find(async () => true); // resolved below via closure
        bench = await timeLoopValue(async () => {
          const t0 = performance.now();
          const vs = await newFactory.buildKnownValueSet(rf.url, null) || probe;
          let count = 0;
          for (const inc of (vs.compose.include || [])) count += (inc.concept || []).length;
          return { count, wallMs: performance.now() - t0 };
        }, { warmup: 2, iters: 5 });
      } else {
        // Fallback: time the refset member enumeration query directly.
        method = 'refset member enumeration (raw SQL fallback; ValueSet path config-blocked)';
        const db = new Database(dbPaths.new, { readonly: true });
        const vsRow = db.prepare(
          `SELECT vs_id FROM value_set WHERE cs_id = ? AND url = ? ORDER BY (version IS NULL) DESC LIMIT 1`
        ).get(csId, rf.url);
        bench = await timeLoopValue(async () => {
          const t0 = performance.now();
          const members = db.prepare(
            `SELECT c.code AS code, c.display AS display
               FROM value_set_member m JOIN concept c ON c.concept_id = m.concept_id
              WHERE m.vs_id = ? ORDER BY m.member_id`
          ).all(vsRow.vs_id);
          return { count: members.length, wallMs: performance.now() - t0 };
        }, { warmup: 2, iters: 5 });
        db.close();
      }
      filters[`concept in (refset) ${rf.id}`] = {
        name: `concept in (refset) ${rf.id}`,
        method,
        new: bench,
      };
    }
    report.ops.filterDrain = filters;
  }

  // === OP 4: filterLocate membership probe ================================
  {
    const spec = PROBE_FILTER[pairName];
    // members: sample from within the probe set is hard without draining; instead
    // sample generic codes (likely members) + guaranteed non-members (bogus).
    const memberCodes = distinctCodesFromNew(dbPaths.new, csId, 200, SEED + 3,
      pairName === 'snomed' ? 'AND active = 1' : '');
    const nonMembers = [];
    for (let i = 0; i < 200; i++) nonMembers.push(`__nomatch_${pairName}_${i}__`);
    const probes = [...memberCodes, ...nonMembers];

    const run = async (cs) => {
      const { prep, set } = await buildFilterSet(cs, spec.apply);
      const r = await timeLoop(async (i) => { await cs.filterLocate(prep, set, probes[i % probes.length]); },
        { warmup: 10, iters: 400 });
      if (cs.filterFinish) await cs.filterFinish(prep);
      return r;
    };
    const newR = await run(newCS);
    const oldR = hasOld ? await run(oldCS) : null;
    report.ops.filterLocate = { probeFilter: spec.name, probes: probes.length, old: oldR, new: newR, ratio: ratio(oldR, newR) };
  }

  // === OP 5: subsumesTest — 500 seeded pairs ==============================
  // LOINC + SNOMED (new). Old LOINC returns a constant — still timed as baseline.
  if (pairName === 'loinc' || pairName === 'snomed') {
    const pairs = subsumptionPairs(dbPaths.new, 500, SEED + 4);
    const run = async (cs) => timeLoop(async (i) => {
      const [a, b] = pairs[i % pairs.length];
      await cs.subsumesTest(a, b);
    }, { warmup: 10, iters: 500 });
    const newR = await run(newCS);
    const oldR = hasOld ? await run(oldCS) : null;
    report.ops.subsumesTest = {
      pairs: pairs.length,
      oldNote: pairName === 'loinc' ? 'old LOINC subsumesTest returns a constant; timed as baseline' : undefined,
      old: oldR, new: newR, ratio: ratio(oldR, newR),
    };
  }

  // === OP 6: iteration throughput — first 50000 concepts ==================
  {
    const CAP = 50000;
    // OLD providers: hasParents()===true so iteratorAll() throws "Must override";
    // their iterator(null) is the all-concepts traversal. NEW: iteratorAll().
    const drainNew = async () => {
      const t0 = performance.now();
      const it = await newCS.iteratorAll();
      let n = 0;
      while (n < CAP) { const c = await newCS.nextContext(it); if (!c) break; n++; }
      return { n, wallMs: performance.now() - t0 };
    };
    const drainOld = async () => {
      const t0 = performance.now();
      const it = await oldCS.iterator(null);
      let n = 0;
      while (n < CAP) { const c = await oldCS.nextContext(it); if (!c) break; n++; }
      return { n, wallMs: performance.now() - t0 };
    };
    // warmup once (small), then one full timed drain each (0.5-5s range).
    const newI = await drainNew();
    const oldI = hasOld ? await drainOld() : null;
    const cps = (r) => (r && r.wallMs > 0) ? Math.round(r.n / (r.wallMs / 1000)) : null;
    report.ops.iteration = {
      cap: CAP,
      old: oldI ? { count: oldI.n, wallMs: round(oldI.wallMs), conceptsPerSec: cps(oldI) } : null,
      new: { count: newI.n, wallMs: round(newI.wallMs), conceptsPerSec: cps(newI) },
      ratioConceptsPerSec: oldI ? ratioNum(cps(newI), cps(oldI)) : null, // >1 = new faster
    };
  }

  // --- cleanup -------------------------------------------------------------
  try { if (oldCS && oldCS.close) oldCS.close(); } catch {}
  try { if (newCS && newCS.close) newCS.close(); } catch {}
  try { if (oldFactory && oldFactory.close) await oldFactory.close(); } catch {}
  try { if (newFactory && newFactory.close) await newFactory.close(); } catch {}

  return report;
}

// bench a drain: warmup then a few timed full drains; report wall median/p95 + count + codes/sec.
async function benchDrain(cs, applyFilter) {
  // warmup
  let last;
  for (let i = 0; i < 2; i++) last = await executeAndDrain(cs, applyFilter);
  const count = last.count;
  // pick iters so total ~0.5-5s based on warmup wall time
  const iters = Math.max(3, Math.min(15, Math.round(2000 / Math.max(1, last.wallMs))));
  const walls = [];
  for (let i = 0; i < iters; i++) walls.push((await executeAndDrain(cs, applyFilter)).wallMs);
  const s = summarize(walls);
  const cps = s.medianMs > 0 ? Math.round(count / (s.medianMs / 1000)) : null;
  return { count, iters, wallMedianMs: s.medianMs, wallP95Ms: s.p95Ms, codesPerSec: cps };
}

// time a value-returning op; capture last returned {count} + wall stats.
async function timeLoopValue(fn, { warmup = 2, iters = 5 } = {}) {
  let last;
  for (let i = 0; i < warmup; i++) last = await fn();
  const walls = [];
  for (let i = 0; i < iters; i++) { const r = await fn(); walls.push(r.wallMs); last = r; }
  const s = summarize(walls);
  const cps = s.medianMs > 0 ? Math.round(last.count / (s.medianMs / 1000)) : null;
  return { count: last.count, iters, wallMedianMs: s.medianMs, wallP95Ms: s.p95Ms, codesPerSec: cps };
}

// ratio of old_median / new_median (>1 means new faster). Works on summarize objs.
function ratio(oldR, newR) {
  if (!oldR || !newR || !newR.medianMs) return null;
  return round(oldR.medianMs / newR.medianMs);
}
function ratioNum(a, b) {
  if (a == null || b == null || !b) return null;
  return round(a / b);
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.json, { recursive: true });

  const langDefs = await LanguageDefinitions.fromFiles(path.join(REPO, 'tx/data'));
  const i18n = new I18nSupport(path.join(REPO, 'translations'), langDefs);
  await i18n.load();
  const freshOp = () => new OperationContext('en', i18n, null, 3600);
  const ctx = { langDefs, i18n, freshOp };

  const all = { generatedAt: new Date().toISOString(), pairs: {} };
  for (const pair of args.pairs) {
    process.stderr.write(`\n[bench] pair=${pair} ...\n`);
    const t0 = performance.now();
    const rep = await benchPair(pair, ctx);
    process.stderr.write(`[bench] pair=${pair} done in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);
    all.pairs[pair] = rep;
    fs.writeFileSync(path.join(args.json, `bench-${pair}.json`), JSON.stringify(rep, null, 2));
  }
  const combined = path.join(args.json, 'bench-all.json');
  fs.writeFileSync(combined, JSON.stringify(all, null, 2));
  process.stderr.write(`\n[bench] wrote ${combined}\n`);

  // print compact summary
  printSummary(all);
}

function printSummary(all) {
  const L = [];
  for (const [pair, r] of Object.entries(all.pairs)) {
    L.push(`\n=== ${pair.toUpperCase()} ===`);
    L.push(`load: old=${r.ops.factoryLoad.oldLoadMs ?? 'n/a'}ms new=${r.ops.factoryLoad.newLoadMs}ms`);
    const lh = r.ops.locateHot;
    L.push(`locate hot: old med=${lh.old?.medianMs ?? 'n/a'} new med=${lh.new.medianMs} ratio=${lh.ratio ?? 'n/a'}`);
    const ld = r.ops.lookupDecoration;
    L.push(`decorate: old med=${ld.old?.medianMs ?? 'n/a'} new med=${ld.new.medianMs} ratio=${ld.ratio ?? 'n/a'}`);
    const it = r.ops.iteration;
    L.push(`iter 50k: old cps=${it.old?.conceptsPerSec ?? 'n/a'} new cps=${it.new.conceptsPerSec} ratio=${it.ratioConceptsPerSec ?? 'n/a'}`);
  }
  console.log(L.join('\n'));
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e);
  process.exit(1);
});
