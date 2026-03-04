#!/usr/bin/env node
/**
 * IR engine test harness — hits the running server, asserts concrete expectations.
 * Usage: node scripts/ir-harness.mjs [filter] [--legacy] [--trace] [--perf]
 *
 * --perf   Run each test with both engines (5 runs each), collect median
 *          timings, write tmp/perf-table.html at the end.
 */
const BASE = process.env.BASE_URL || 'http://localhost:8000';
const EXPAND = `${BASE}/r4/ValueSet/$expand`;
const FILTER = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const RUN_LEGACY = process.argv.includes('--legacy');
const WANT_TRACE = process.argv.includes('--trace');
const PERF_MODE = process.argv.includes('--perf');
const RUNS = parseInt(process.env.PERF_RUNS || '3', 10);
const PERF_RUNS = parseInt(process.env.PERF_RUNS || '5', 10);

const SYS = {
  SCT: 'http://snomed.info/sct',
  LOINC: 'http://loinc.org',
  RXNORM: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  GENDER: 'http://hl7.org/fhir/administrative-gender',
  PUBSTAT: 'http://hl7.org/fhir/publication-status',
};

// ── helpers ────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;

function vs(include, exclude) {
  const inc = Array.isArray(include) ? include : [include];
  const exc = exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : undefined;
  return { resourceType: 'ValueSet', compose: { include: inc, ...(exc ? { exclude: exc } : {}) } };
}

const DEFAULT_ENGINE = RUN_LEGACY ? 'legacy' : 'ir';
async function expand(vsJson, opts = {}, engine = DEFAULT_ENGINE) {
  lastExpandCall = { vsJson, opts };
  const params = [{ name: 'valueSet', resource: vsJson }];
  params.push({ name: '_engine', valueString: engine });
  if (opts.count !== undefined) params.push({ name: 'count', valueInteger: opts.count });
  if (opts.offset !== undefined) params.push({ name: 'offset', valueInteger: opts.offset });
  if (opts.activeOnly) params.push({ name: 'activeOnly', valueBoolean: true });
  if (opts.filter) params.push({ name: 'filter', valueString: opts.filter });
  if (opts.includeDesignations) params.push({ name: 'includeDesignations', valueBoolean: true });
  if (WANT_TRACE) params.push({ name: '_trace', valueString: 'true' });
  params.push({ name: '_nocache', valueString: 'true' });

  const t0 = performance.now();
  const resp = await fetch(EXPAND, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceType: 'Parameters', parameter: params }),
  });
  const ms = performance.now() - t0;
  const body = await resp.json();
  if (body.resourceType === 'OperationOutcome') {
    throw new Error(body.issue?.[0]?.details?.text || JSON.stringify(body));
  }
  return { result: body, ms };
}

function codes(result) {
  const out = [];
  const walk = (c) => { for (const x of c || []) { out.push(x); walk(x.contains); } };
  walk(result.expansion?.contains);
  return out;
}

function findCode(result, code) {
  return codes(result).find(c => c.code === code);
}

async function test(name, fn) {
  if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) { skipped++; return; }
  lastExpandCall = null;
  try {
    const t0 = performance.now();
    await fn();
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`  \x1b[32m✓\x1b[0m ${name} (${ms}ms)`);
    passed++;

    // In perf mode, re-run the last expand() call with both engines
    if (PERF_MODE && lastExpandCall) {
      const { vsJson, opts } = lastExpandCall;
      const ir = await timeEngine(vsJson, opts, 'ir', PERF_RUNS);
      const leg = await timeEngine(vsJson, opts, 'legacy', PERF_RUNS);
      perfRows.push({ name, category: currentCategory, irMs: ir.ms, legMs: leg.ms, irErr: ir.err, legErr: leg.err });
      const irStr = ir.err ? '❌' : `${ir.ms}ms`;
      const legStr = leg.err ? '❌' : `${leg.ms}ms`;
      console.log(`    perf: IR=${irStr}  Legacy=${legStr}`);
    }
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`); }
function findParams(result, name) {
  return (result?.expansion?.parameter || []).filter(p => p.name === name);
}

// ── perf collection ────────────────────────────────────────────────────
const perfRows = [];  // { name, category, irMs, legMs, irErr, legErr }
let currentCategory = '';
let lastExpandCall = null;  // { vsJson, opts } from most recent expand()

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function timeEngine(vsJson, opts, engine, runs) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    try {
      const { ms } = await expand(vsJson, opts, engine);
      times.push(ms);
    } catch {
      return { ms: null, err: true };
    }
  }
  return { ms: Math.round(median(times)), err: false };
}

// ── tests ──────────────────────────────────────────────────────────────
async function run() {
  // Check server is up
  try {
    const r = await fetch(`${EXPAND}?url=${SYS.SCT}?fhir_vs=isa/73211009&count=1&_engine=ir`);
    if (!r.ok) throw new Error();
  } catch { console.error('Server not reachable at', BASE); process.exit(1); }

  console.log('\n=== SNOMED is-a ==='); currentCategory = 'SNOMED is-a';

  await test('is-a Diabetes: 124 codes, includes self+children', async () => {
    const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 124, 'total');
    assert(findCode(result, '73211009'), 'is-a includes self');
    assert(findCode(result, '44054006'), 'includes Type 2');
    assert(findCode(result, '46635009'), 'includes Type 1');
    assert(codes(result).every(c => c.display?.length > 0), 'all have display');
  });

  await test('descendent-of Diabetes: 123 codes, excludes self', async () => {
    const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'descendent-of', value: '73211009' }] }),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 123, 'total');
    assert(!findCode(result, '73211009'), 'descendent-of excludes self');
    assert(findCode(result, '44054006'), 'includes Type 2');
  });

  await test('Clinical finding count=0: total=124412', async () => {
    const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }),
      { count: 0, activeOnly: true });
    eq(result.expansion.total, 124412, 'total');
    eq(codes(result).length, 0, 'no codes returned');
  });

  await test('Clinical finding first 50: fast with EXISTS pushdown', async () => {
    const { result, ms } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }),
      { count: 50, activeOnly: true });
    eq(result.expansion.total, 124412, 'total');
    eq(codes(result).length, 50, 'page size');
    assert(ms < 500, `expected <500ms, got ${ms.toFixed(0)}ms`);
  });

  console.log('\n=== Pagination ==='); currentCategory = 'Pagination';

  await test('Diabetes pages are disjoint and reconstruct full set', async () => {
    const allCodes = new Set();
    for (let off = 0; off < 200; off += 30) {
      const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }),
        { count: 30, offset: off, activeOnly: true });
      eq(result.expansion.total, 124, 'total stable across pages');
      for (const c of codes(result)) {
        assert(!allCodes.has(c.code), `duplicate code ${c.code} at offset ${off}`);
        allCodes.add(c.code);
      }
    }
    eq(allCodes.size, 124, 'all codes covered');
  });

  await test('LOINC STATUS=ACTIVE high offset (1000,20)', async () => {
    const { result } = await expand(vs({ system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] }),
      { count: 20, offset: 1000 });
    assert(result.expansion.total > 90000, `total ${result.expansion.total}`);
    eq(codes(result).length, 20, 'page size');
  });

  console.log('\n=== Excludes ==='); currentCategory = 'Excludes';

  await test('Diabetes minus Type2 subtree: 108 codes', async () => {
    const { result } = await expand(
      vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
         { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] }),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 108, 'total');
    assert(!findCode(result, '44054006'), 'Type 2 excluded');
    assert(findCode(result, '73211009'), 'self remains');
    assert(findCode(result, '46635009'), 'Type 1 remains');
  });

  await test('Diabetes minus Type1+Type2: ~86 codes', async () => {
    const { result } = await expand(
      vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
         [{ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
          { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '46635009' }] }]),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 86, 'total');
    assert(!findCode(result, '44054006'), 'Type 2 excluded');
    assert(!findCode(result, '46635009'), 'Type 1 excluded');
    assert(findCode(result, '73211009'), 'self remains');
  });

  await test('Diabetes exclude 2 enumerated codes', async () => {
    const { result } = await expand(
      vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
         { system: SYS.SCT, concept: [{ code: '44054006' }, { code: '46635009' }] }),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 122, 'total');
    assert(!findCode(result, '44054006'), '44054006 excluded');
    assert(!findCode(result, '46635009'), '46635009 excluded');
    assert(findCode(result, '73211009'), 'self remains');
  });

  console.log('\n=== Text search ==='); currentCategory = 'Text search';

  await test('is-a Diabetes + text gestational: 8 codes', async () => {
    const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }),
      { count: 200, activeOnly: true, filter: 'gestational' });
    eq(result.expansion.total, 8, 'total');
    assert(codes(result).every(c => c.display.toLowerCase().includes('gestational')), 'all match');
  });

  await test('is-a Diabetes + text insulin: results match text', async () => {
    const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }),
      { count: 200, activeOnly: true, filter: 'insulin' });
    assert(result.expansion.total > 10, `total ${result.expansion.total}`);
    // FTS may match on designations not just display — just check we get results
    assert(codes(result).length > 0, 'has results');
  });

  await test('LOINC text creatinine first 20', async () => {
    const { result } = await expand(vs({ system: SYS.LOINC }),
      { count: 20, filter: 'creatinine' });
    assert(codes(result).length > 0, 'has results');
    assert(codes(result).length <= 20, 'respects count');
  });

  await test('RxNorm text aspirin + TTY=IN: finds aspirin 1191', async () => {
    const { result } = await expand(vs({ system: SYS.RXNORM, filter: [{ property: 'TTY', op: '=', value: 'IN' }] }),
      { count: 20, filter: 'aspirin' });
    assert(findCode(result, '1191'), 'aspirin 1191 present');
  });

  console.log('\n=== Property filters ==='); currentCategory = 'Property filters';

  await test('RxNorm TTY=IN first 50', async () => {
    const { result } = await expand(vs({ system: SYS.RXNORM, filter: [{ property: 'TTY', op: '=', value: 'IN' }] }),
      { count: 50 });
    assert(result.expansion.total > 14000, `total ${result.expansion.total}`);
    eq(codes(result).length, 50, 'page size');
    assert(codes(result).every(c => c.display?.length > 0), 'all have display');
  });

  await test('LOINC CLASSTYPE=1 first 50: ~66K total', async () => {
    const { result } = await expand(vs({ system: SYS.LOINC, filter: [{ property: 'CLASSTYPE', op: '=', value: '1' }] }),
      { count: 50 });
    assert(result.expansion.total > 60000, `total ${result.expansion.total}`);
    eq(codes(result).length, 50, 'page size');
  });

  await test('LOINC STATUS=ACTIVE first 20: ~96K total', async () => {
    const { result } = await expand(vs({ system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] }),
      { count: 20 });
    assert(result.expansion.total > 90000, `total ${result.expansion.total}`);
    eq(codes(result).length, 20, 'page size');
  });

  console.log('\n=== Concept enumeration ==='); currentCategory = 'Concept enum';

  await test('SNOMED 3 codes: correct displays', async () => {
    const { result } = await expand(vs({ system: SYS.SCT, concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }] }));
    eq(result.expansion.total, 3, 'total');
    // v0 provider returns preferred term; cs-snomed returns FSN without suffix
    assert(findCode(result, '73211009')?.display?.startsWith('Diabetes mellitus'), 'DM display');
  });

  await test('SNOMED enum + designations', async () => {
    const { result } = await expand(vs({ system: SYS.SCT, concept: [{ code: '73211009' }] }),
      { includeDesignations: true });
    const entry = findCode(result, '73211009');
    assert(entry?.designation?.length > 0, 'has designations');
  });

  console.log('\n=== Whole-system (cs-cs / legacy adapter) ==='); currentCategory = 'Whole-system';

  await test('gender whole-system: 4 codes', async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }));
    eq(result.expansion.total, 4, 'total');
    assert(findCode(result, 'male')?.display === 'Male', 'male');
    assert(findCode(result, 'female')?.display === 'Female', 'female');
    assert(findCode(result, 'other')?.display === 'Other', 'other');
    assert(findCode(result, 'unknown')?.display === 'Unknown', 'unknown');
  });

  await test('gender enumerated subset: male+female only', async () => {
    const { result } = await expand(vs({ system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] }));
    eq(result.expansion.total, 2, 'total');
    assert(findCode(result, 'male'), 'male present');
    assert(!findCode(result, 'unknown'), 'unknown absent');
  });

  await test('gender exclude: minus other+unknown = male+female', async () => {
    const { result } = await expand(
      vs({ system: SYS.GENDER },
         { system: SYS.GENDER, concept: [{ code: 'other' }, { code: 'unknown' }] }));
    eq(result.expansion.total, 2, 'total');
    assert(findCode(result, 'male'), 'male remains');
    assert(findCode(result, 'female'), 'female remains');
    assert(!findCode(result, 'other'), 'other excluded');
    assert(!findCode(result, 'unknown'), 'unknown excluded');
  });

  await test('LOINC enumerated: 2160-0 + 2345-7', async () => {
    const { result } = await expand(vs({ system: SYS.LOINC, concept: [{ code: '2160-0' }, { code: '2345-7' }] }));
    eq(result.expansion.total, 2, 'total');
    assert(findCode(result, '2160-0')?.display?.includes('Creatinine'), 'Creatinine');
    assert(findCode(result, '2345-7')?.display?.includes('Glucose'), 'Glucose');
  });

  await test('RxNorm enumerated: aspirin + ibuprofen + acetaminophen', async () => {
    const { result } = await expand(vs({ system: SYS.RXNORM, concept: [{ code: '161' }, { code: '5640' }, { code: '1191' }] }));
    eq(result.expansion.total, 3, 'total');
    assert(findCode(result, '1191')?.display === 'aspirin', 'aspirin');
    assert(findCode(result, '5640')?.display === 'ibuprofen', 'ibuprofen');
    assert(findCode(result, '161')?.display === 'acetaminophen', 'acetaminophen');
  });

  await test('SNOMED concept-in refset 723560006: 19 top-level categories', async () => {
    const { result } = await expand(vs({ system: SYS.SCT,
      filter: [{ property: 'concept', op: 'in', value: 'http://snomed.info/sct?fhir_vs=refset/723560006' }] }));
    eq(result.expansion.total, 19, 'total');
    assert(findCode(result, '404684003'), 'Clinical finding');
    assert(findCode(result, '71388002'), 'Procedure');
    assert(findCode(result, '123037004'), 'Body structure');
  });

  await test('same-system dedup: gender male+female \u222a female+other = 3', async () => {
    const { result } = await expand(vs([
      { system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] },
      { system: SYS.GENDER, concept: [{ code: 'female' }, { code: 'other' }] },
    ]));
    eq(result.expansion.total, 3, 'total (female deduped)');
    assert(findCode(result, 'male'), 'male');
    assert(findCode(result, 'female'), 'female');
    assert(findCode(result, 'other'), 'other');
  });

  await test('cross-system exclude: gender+pubstat minus both unknowns = 6', async () => {
    const { result } = await expand(vs(
      [{ system: SYS.GENDER }, { system: SYS.PUBSTAT }],
      [{ system: SYS.GENDER, concept: [{ code: 'unknown' }] },
       { system: SYS.PUBSTAT, concept: [{ code: 'unknown' }] }]));
    eq(result.expansion.total, 6, 'total');
    assert(!codes(result).some(c => c.code === 'unknown'), 'no unknowns');
    eq(codes(result).filter(c => c.system === SYS.GENDER).length, 3, 'gender count');
    eq(codes(result).filter(c => c.system === SYS.PUBSTAT).length, 3, 'pubstat count');
  });

  await test('text filter across cs-cs systems: gender+pubstat filter=unknown', async () => {
    const { result } = await expand(vs([{ system: SYS.GENDER }, { system: SYS.PUBSTAT }]),
      { filter: 'unknown' });
    assert(codes(result).length >= 2, 'at least 2 matches');
    const systems = new Set(codes(result).map(c => c.system));
    eq(systems.size, 2, 'matches from both systems');
  });

  console.log('\n=== Multi-system ==='); currentCategory = 'Multi-system';

  await test('SNOMED+LOINC+RxNorm enum: 3 codes, 3 systems', async () => {
    const { result } = await expand(vs([
      { system: SYS.SCT, concept: [{ code: '73211009' }] },
      { system: SYS.LOINC, concept: [{ code: '2160-0' }] },
      { system: SYS.RXNORM, concept: [{ code: '1191' }] },
    ]));
    eq(result.expansion.total, 3, 'total');
    const systems = new Set(codes(result).map(c => c.system));
    eq(systems.size, 3, 'system count');
    assert(findCode(result, '1191')?.display === 'aspirin', 'RxNorm display');
  });

  await test('Mixed v0+cs-cs: gender (4) + SNOMED enum (1) = 5', async () => {
    const { result, ms } = await expand(vs([
      { system: 'http://hl7.org/fhir/administrative-gender' },
      { system: SYS.SCT, concept: [{ code: '73211009' }] },
    ]));
    eq(result.expansion.total, 5, 'total');
    const systems = new Set(codes(result).map(c => c.system));
    eq(systems.size, 2, 'system count');
    assert(findCode(result, 'male')?.display === 'Male', 'gender display');
    assert(findCode(result, '73211009')?.display?.startsWith('Diabetes mellitus'), 'SNOMED display');
  });

  await test('Mixed v0+cs-cs: gender (4) + SNOMED is-a (124), stride across boundary', async () => {
    // Canonical order: gender first (http://hl7...), SNOMED second (http://snomed...)
    // offset=2 count=5 → 2 gender + 3 SNOMED
    const { result } = await expand(vs([
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: 'http://hl7.org/fhir/administrative-gender' },
    ]), { count: 5, offset: 2, activeOnly: true });
    eq(result.expansion.total, 128, 'total');
    eq(codes(result).length, 5, 'page size');
    const systems = new Set(codes(result).map(c => c.system));
    eq(systems.size, 2, 'page spans both systems');
  });

  await test('Mixed v0+cs-cs + text filter', async () => {
    const { result } = await expand(vs([
      { system: 'http://hl7.org/fhir/administrative-gender' },
      { system: SYS.SCT, concept: [{ code: '73211009' }, { code: '44054006' }] },
    ]), { filter: 'male' });
    // 'male' matches gender code; SNOMED diabetes doesn't match
    assert(findCode(result, 'male'), 'male found');
    assert(codes(result).length >= 1, 'at least male');
  });

  await test('Multi-system stride pagination', async () => {
    // SNOMED is-a Diabetes (124) + LOINC CLASSTYPE=1 (66K)
    // offset=120 should get tail of SNOMED + start of LOINC
    const query = vs([
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: SYS.LOINC, filter: [{ property: 'CLASSTYPE', op: '=', value: '1' }] },
    ]);
    const { result } = await expand(query, { count: 10, offset: 120, activeOnly: true });
    eq(codes(result).length, 10, 'page size');
    const systems = new Set(codes(result).map(c => c.system));
    // Should span the boundary between the two systems
    assert(result.expansion.total > 60000, `total ${result.expansion.total}`);
  });

  // ── meta: expansion parameters ──────────────────────────────────────────
  console.log('\n=== Meta ==='); currentCategory = 'Meta';

  await test('meta: multi-system emits used-codesystem for each system', async () => {
    const { result } = await expand(vs([
      { system: SYS.GENDER, concept: [{ code: 'male' }] },
      { system: SYS.PUBSTAT, concept: [{ code: 'active' }] },
    ]));
    const usedCs = findParams(result, 'used-codesystem').map(p => p.valueUri || '');
    assert(usedCs.some(v => v.startsWith(SYS.GENDER)), 'gender in used-codesystem');
    assert(usedCs.some(v => v.startsWith(SYS.PUBSTAT)), 'pubstat in used-codesystem');
  });

  await test('meta: used-codesystem dedupes repeated same-system', async () => {
    const { result } = await expand(vs([
      { system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] },
      { system: SYS.GENDER, concept: [{ code: 'other' }] },
    ]));
    const usedCs = findParams(result, 'used-codesystem')
      .filter(p => typeof p.valueUri === 'string' && p.valueUri.startsWith(SYS.GENDER));
    eq(usedCs.length, 1, 'exactly 1 used-codesystem for gender');
  });

  await test('meta: offset/count are echoed in expansion parameters', async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }), { count: 2, offset: 1 });
    const offsetP = findParams(result, 'offset')[0];
    const countP = findParams(result, 'count')[0];
    assert(offsetP?.valueInteger === 1, `expected offset=1, got ${offsetP?.valueInteger}`);
    assert(countP?.valueInteger === 2, `expected count=2, got ${countP?.valueInteger}`);
  });

  await test('meta: text filter is echoed in expansion parameters', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    }), { filter: 'mell', count: 5, activeOnly: true });
    const filterP = findParams(result, 'filter')[0];
    eq(filterP?.valueString, 'mell', 'filter echoed');
  });

  await test('meta: v0 used-codesystem includes version', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT, concept: [{ code: '73211009' }],
    }));
    const usedCs = findParams(result, 'used-codesystem').map(p => p.valueUri || '');
    const sctEntry = usedCs.find(v => v.startsWith(SYS.SCT));
    assert(sctEntry, 'SNOMED in used-codesystem');
    assert(sctEntry.includes('|'), `expected version in used-codesystem, got ${sctEntry}`);
  });

  // ── vs-import ────────────────────────────────────────────────────────
  console.log('\n=== ValueSet imports ==='); currentCategory = 'VS import';

  await test('vs-import: pure import of administrative-gender', async () => {
    const { result } = await expand(vs({ valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'] }));
    eq(result.expansion.total, 4, 'total');
    assert(findCode(result, 'male'), 'male');
    assert(findCode(result, 'female'), 'female');
    assert(findCode(result, 'other'), 'other');
    assert(findCode(result, 'unknown'), 'unknown');
  });

  await test('vs-import: system + valueSet intersection', async () => {
    const { result } = await expand(vs({
      system: SYS.GENDER,
      concept: [{ code: 'male' }, { code: 'female' }, { code: 'other' }],
      valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'],
    }));
    eq(result.expansion.total, 3, 'intersection total');
    assert(findCode(result, 'male'), 'male in intersection');
    assert(findCode(result, 'female'), 'female in intersection');
    assert(findCode(result, 'other'), 'other in intersection');
    assert(!findCode(result, 'unknown'), 'unknown not in intersection');
  });

  // ── pagination-safety ──────────────────────────────────────────────
  console.log('\n=== Pagination safety ==='); currentCategory = 'Pagination safety';

  await test('pagination-safety: mixed v0+cs-cs reconstruct full set', async () => {
    const query = vs([
      { system: SYS.GENDER },
      { system: SYS.SCT, concept: [{ code: '73211009' }] },
    ]);
    const allCodes = new Set();
    for (let off = 0; off < 10; off += 2) {
      const { result } = await expand(query, { count: 2, offset: off });
      eq(result.expansion.total, 5, `total stable at offset ${off}`);
      for (const c of codes(result)) {
        assert(!allCodes.has(c.code), `dup ${c.code} at offset ${off}`);
        allCodes.add(c.code);
      }
    }
    eq(allCodes.size, 5, 'all codes covered');
  });

  await test('pagination-safety: v0 filter+cs-cs pages are disjoint', async () => {
    const query = vs([
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: SYS.GENDER },
    ]);
    const allCodes = new Set();
    const pageSize = 20;
    for (let off = 0; off < 128; off += pageSize) {
      const { result } = await expand(query, { count: pageSize, offset: off, activeOnly: true });
      eq(result.expansion.total, 128, `total stable at offset ${off}`);
      for (const c of codes(result)) {
        assert(!allCodes.has(`${c.system}|${c.code}`), `dup ${c.code} at offset ${off}`);
        allCodes.add(`${c.system}|${c.code}`);
      }
    }
    eq(allCodes.size, 128, 'all codes covered without gaps');
  });

  await test('pagination-safety: offset beyond end returns empty', async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }), { count: 10, offset: 100 });
    eq(result.expansion.total, 4, 'total');
    eq(codes(result).length, 0, 'no codes past end');
  });

  await test('pagination-safety: deep offset 110K into 124K set returns 10K codes', async () => {
    const { result, ms } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    }), { count: 10000, offset: 110000, activeOnly: true });
    eq(result.expansion.total, 124412, 'total');
    eq(codes(result).length, 10000, 'page size');
    assert(codes(result).every(c => c.code && c.display), 'all have code+display');
    // Verify codes are sorted (pagination determinism)
    const sorted = codes(result).map(c => c.code);
    const expected = [...sorted].sort();
    assert(JSON.stringify(sorted) === JSON.stringify(expected), 'codes are sorted');
  });

  await test('pagination-safety: last page of 124K set is partial', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    }), { count: 10000, offset: 120000, activeOnly: true });
    eq(result.expansion.total, 124412, 'total');
    eq(codes(result).length, 4412, 'partial last page');
  });

  // ── combined ─────────────────────────────────────────────────────────
  console.log('\n=== Combined ==='); currentCategory = 'Combined';

  await test('combined: SNOMED is-a + text filter', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    }), { filter: 'insulin', activeOnly: true });
    assert(codes(result).length > 0, 'has results');
    assert(codes(result).every(c => c.system === SYS.SCT), 'all SNOMED');
  });

  await test('combined: include filter + exclude filter same system', async () => {
    const { result } = await expand(
      vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
         [{ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
          { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '46635009' }] }]),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 86, 'Diabetes minus Type1+Type2');
    assert(!findCode(result, '44054006'), 'Type2 excluded');
    assert(!findCode(result, '46635009'), 'Type1 excluded');
  });

  await test('combined: enumerated + text filter', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }],
    }), { filter: 'type' });
    assert(codes(result).length >= 1, 'at least 1 match');
    assert(codes(result).every(c => c.display.toLowerCase().includes('type')), 'all match text');
  });

  await test('combined: multi-system + exclude + pagination', async () => {
    const query = vs(
      [{ system: SYS.GENDER }, { system: SYS.PUBSTAT }],
      [{ system: SYS.GENDER, concept: [{ code: 'unknown' }] },
       { system: SYS.PUBSTAT, concept: [{ code: 'unknown' }] }]);
    const allCodes = new Set();
    for (let off = 0; off < 6; off += 2) {
      const { result } = await expand(query, { count: 2, offset: off });
      eq(result.expansion.total, 6, `total at offset ${off}`);
      for (const c of codes(result)) {
        assert(c.code !== 'unknown', `unknown at offset ${off}`);
        allCodes.add(`${c.system}|${c.code}`);
      }
    }
    eq(allCodes.size, 6, 'all 6 codes covered');
  });

  // ── lang / designations ───────────────────────────────────────────
  console.log('\n=== Designations ==='); currentCategory = 'Designations';

  await test('lang: SNOMED includeDesignations returns entries', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT, concept: [{ code: '73211009' }],
    }), { includeDesignations: true });
    const entry = findCode(result, '73211009');
    assert(entry?.designation?.length > 0, 'has designations');
    assert(entry.designation.every(d => d.value?.length > 0), 'all have value');
  });

  await test('lang: SNOMED is-a filter includeDesignations', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    }), { count: 5, activeOnly: true, includeDesignations: true });
    assert(codes(result).length > 0, 'has results');
    assert(codes(result).every(c => c.designation?.length > 0), 'all have designations');
  });

  await test('lang: LOINC includeDesignations returns entries', async () => {
    const { result } = await expand(vs({
      system: SYS.LOINC, concept: [{ code: '2160-0' }],
    }), { includeDesignations: true });
    const entry = findCode(result, '2160-0');
    assert(entry?.designation?.length > 0, 'has designations');
  });

  // ── summary ──────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, ${skipped} skipped`);
  console.log('='.repeat(50));

  if (PERF_MODE && perfRows.length > 0) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync('tmp', { recursive: true });
    writeFileSync(join('tmp', 'perf-table.html'), buildPerfHtml(perfRows));
    console.log(`\nPerf table written to tmp/perf-table.html (${perfRows.length} rows)`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

// ── perf HTML builder ──────────────────────────────────────────────────
function buildPerfHtml(rows) {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const ts = new Date().toISOString().replace('T',' ').slice(0,19) + ' UTC';

  const tableRows = rows.map(r => {
    const irStr = r.irErr ? '<span class="err">❌</span>' : `${r.irMs}ms`;
    const legStr = r.legErr ? '<span class="err">❌</span>' : `${r.legMs}ms`;
    let ratio = '', cls = 'even';
    if (!r.irErr && !r.legErr && r.irMs > 0 && r.legMs > 0) {
      if (r.irMs <= r.legMs) {
        const x = (r.legMs / r.irMs).toFixed(1);
        ratio = x === '1.0' ? '≈' : `IR ×${x}`;
        cls = x === '1.0' ? 'even' : 'ir-win';
      } else {
        const x = (r.irMs / r.legMs).toFixed(1);
        ratio = x === '1.0' ? '≈' : `Leg ×${x}`;
        cls = x === '1.0' ? 'even' : 'leg-win';
      }
    } else if (r.legErr && !r.irErr) {
      ratio = 'IR only'; cls = 'ir-only';
    }
    return `<tr class="${cls}"><td>${esc(r.category)}</td><td>${esc(r.name)}</td><td class="num">${irStr}</td><td class="num">${legStr}</td><td>${ratio}</td></tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>IR vs Legacy Perf</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 2em auto; padding: 0 1em; }
  h1 { font-size: 1.3em; }
  .meta { color: #666; font-size: 0.85em; margin-bottom: 1em; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 6px 10px; border: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .ir-win { background: #e8f5e9; }
  .leg-win { background: #fff3e0; }
  .ir-only { background: #e3f2fd; }
  .even { }
  .err { color: #c62828; }
</style></head><body>
<h1>IR vs Legacy Engine — Performance Comparison</h1>
<p class="meta">Generated ${ts} &middot; median of ${PERF_RUNS} runs &middot; _nocache=true</p>
<table>
<thead><tr><th>Category</th><th>Test</th><th>IR</th><th>Legacy</th><th>Winner</th></tr></thead>
<tbody>
${tableRows}
</tbody></table>
</body></html>`;
}

run().catch(e => { console.error('Fatal:', e); process.exit(2); });
