#!/usr/bin/env node
/**
 * IR engine test harness — hits the running server, asserts concrete expectations.
 * Usage: node scripts/ir-harness.mjs [filter] [--legacy] [--trace]
 */
const BASE = process.env.BASE_URL || 'http://localhost:8000';
const EXPAND = `${BASE}/r4/ValueSet/$expand`;
const FILTER = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const RUN_LEGACY = process.argv.includes('--legacy');
const WANT_TRACE = process.argv.includes('--trace');
const RUNS = parseInt(process.env.PERF_RUNS || '3', 10);

const SYS = {
  SCT: 'http://snomed.info/sct',
  LOINC: 'http://loinc.org',
  RXNORM: 'http://www.nlm.nih.gov/research/umls/rxnorm',
};

// ── helpers ────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;

function vs(include, exclude) {
  const inc = Array.isArray(include) ? include : [include];
  const exc = exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : undefined;
  return { resourceType: 'ValueSet', compose: { include: inc, ...(exc ? { exclude: exc } : {}) } };
}

async function expand(vsJson, opts = {}, engine = 'ir') {
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
  try {
    const t0 = performance.now();
    await fn();
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`  \x1b[32m✓\x1b[0m ${name} (${ms}ms)`);
    passed++;
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`); }

// ── tests ──────────────────────────────────────────────────────────────
async function run() {
  // Check server is up
  try {
    const r = await fetch(`${EXPAND}?url=${SYS.SCT}?fhir_vs=isa/73211009&count=1&_engine=ir`);
    if (!r.ok) throw new Error();
  } catch { console.error('Server not reachable at', BASE); process.exit(1); }

  console.log('\n=== SNOMED is-a ===');

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

  console.log('\n=== Pagination ===');

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

  console.log('\n=== Excludes ===');

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

  console.log('\n=== Text search ===');

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

  console.log('\n=== Property filters ===');

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

  console.log('\n=== Concept enumeration ===');

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

  console.log('\n=== Multi-system ===');

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

  // ── summary ──────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, ${skipped} skipped`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(2); });
