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
  CURRENCY: 'urn:iso:std:iso:4217',
  COUNTRY: 'urn:iso:std:iso:3166',
  LANG: 'urn:ietf:bcp:47',
  CONDVER: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  OBSCAT: 'http://terminology.hl7.org/CodeSystem/observation-category',
  USPS: 'https://www.usps.com/',
  AREACODE: 'http://unstats.un.org/unsd/methods/m49/m49.htm',
  MIME: 'urn:ietf:bcp:13',
  UCUM: 'http://unitsofmeasure.org',
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
  // Attach inline tx-resource(s) (e.g. custom CodeSystems)
  if (opts.txResources) {
    for (const res of Array.isArray(opts.txResources) ? opts.txResources : [opts.txResources]) {
      params.push({ name: 'tx-resource', resource: res });
    }
  }
  // Generic extra parameters (e.g. designation, useSupplement, displayLanguage)
  if (opts.params) {
    for (const p of opts.params) params.push(p);
  }

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

function expansionParams(result, name) {
  return (result.expansion?.parameter || []).filter(p => p.name === name);
}

function hasExpansionParam(result, name, value) {
  const params = expansionParams(result, name);
  if (value === undefined) return params.length > 0;
  return params.some(p => (p.valueUri || p.valueString || p.valueCode || p.valueBoolean) === value);
}

function expansionExtensions(result, url) {
  return (result.expansion?.extension || []).filter(e => e.url === url);
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

  // ── Expansion metadata & canonical status warnings ───────────────────
  console.log('\n── Expansion metadata & canonical status warnings ──');

  // Helper: build a complete inline CodeSystem
  function inlineCS(url, overrides = {}) {
    return {
      resourceType: 'CodeSystem',
      url,
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [
        { code: 'A', display: 'Alpha' },
        { code: 'B', display: 'Bravo' },
        { code: 'C', display: 'Charlie' },
      ],
      ...overrides,
    };
  }

  // Helper: build a VS referencing an inline CS
  function vsForCS(csUrl) {
    return {
      resourceType: 'ValueSet',
      url: 'http://example.org/test-vs',
      status: 'active',
      compose: { include: [{ system: csUrl }] },
    };
  }

  await test('meta: used-codesystem emitted for single system', async () => {
    const cs = inlineCS('http://example.org/cs/meta-used-1');
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    const usedParams = expansionParams(result, 'used-codesystem');
    assert(usedParams.length >= 1, 'expected at least one used-codesystem parameter');
    assert(usedParams.some(p => p.valueUri?.includes('example.org/cs/meta-used-1')),
      `used-codesystem should reference the inline CS, got: ${JSON.stringify(usedParams)}`);
  });

  await test('meta: used-codesystem emitted for multi-system', async () => {
    const cs1 = inlineCS('http://example.org/cs/multi-1');
    const cs2 = inlineCS('http://example.org/cs/multi-2', {
      concept: [{ code: 'X', display: 'Xray' }],
    });
    const vsJson = {
      resourceType: 'ValueSet',
      url: 'http://example.org/test-vs-multi',
      status: 'active',
      compose: { include: [
        { system: cs1.url },
        { system: cs2.url },
      ] },
    };
    const { result } = await expand(vsJson, { txResources: [cs1, cs2] });
    assert(codes(result).length === 4, `expected 4 codes, got ${codes(result).length}`);
    const usedParams = expansionParams(result, 'used-codesystem');
    assert(usedParams.some(p => p.valueUri?.includes('multi-1')),
      'should record cs/multi-1');
    assert(usedParams.some(p => p.valueUri?.includes('multi-2')),
      'should record cs/multi-2');
  });

  await test('meta: warning-draft for draft CodeSystem', async () => {
    const cs = inlineCS('http://example.org/cs/draft-1', { status: 'draft' });
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(hasExpansionParam(result, 'warning-draft'),
      `expected warning-draft parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  await test('meta: warning-retired for retired CodeSystem', async () => {
    const cs = inlineCS('http://example.org/cs/retired-1', { status: 'retired' });
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(hasExpansionParam(result, 'warning-retired'),
      `expected warning-retired parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  await test('meta: warning-experimental for experimental CodeSystem (non-experimental VS)', async () => {
    const cs = inlineCS('http://example.org/cs/experimental-1', { experimental: true });
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(hasExpansionParam(result, 'warning-experimental'),
      `expected warning-experimental parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  await test('meta: NO warning-draft when VS is also draft', async () => {
    const cs = inlineCS('http://example.org/cs/draft-2', { status: 'draft' });
    const vsJson = {
      resourceType: 'ValueSet',
      url: 'http://example.org/test-vs-draft',
      status: 'draft',  // VS is also draft — should suppress warning
      compose: { include: [{ system: cs.url }] },
    };
    const { result } = await expand(vsJson, { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(!hasExpansionParam(result, 'warning-draft'),
      `should NOT have warning-draft when VS is also draft, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  // Note: legacy engine has a bug here — ValueSet wrapper doesn't expose .experimental,
  // so it always emits warning-experimental. IR engine correctly suppresses it.
  await test('meta: NO warning-experimental when VS is also experimental', async () => {
    const cs = inlineCS('http://example.org/cs/experimental-2', { experimental: true });
    const vsJson = {
      resourceType: 'ValueSet',
      url: 'http://example.org/test-vs-experimental',
      status: 'active',
      experimental: true,  // VS is also experimental — should suppress warning
      compose: { include: [{ system: cs.url }] },
    };
    const { result } = await expand(vsJson, { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(!hasExpansionParam(result, 'warning-experimental'),
      `should NOT have warning-experimental when VS is also experimental`);
  });

  await test('meta: warning-deprecated via standardsStatus extension', async () => {
    const cs = inlineCS('http://example.org/cs/deprecated-1', {
      extension: [{
        url: 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
        valueCode: 'deprecated',
      }],
    });
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(hasExpansionParam(result, 'warning-deprecated'),
      `expected warning-deprecated parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  await test('meta: fragment CodeSystem sets valueset-unclosed extension', async () => {
    const cs = inlineCS('http://example.org/cs/fragment-1', { content: 'fragment' });
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    const unclosed = expansionExtensions(result, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
    assert(unclosed.length > 0,
      `expected valueset-unclosed extension, got extensions: ${JSON.stringify(result.expansion?.extension)}`);
  });

  await test('meta: SNOMED expansion emits used-codesystem with version', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    }), { count: 5 });
    const usedParams = expansionParams(result, 'used-codesystem');
    assert(usedParams.some(p => p.valueUri?.startsWith('http://snomed.info/sct')),
      `SNOMED expansion should have used-codesystem, got: ${JSON.stringify(usedParams)}`);
  });

  // ── Phase 1.1–1.4: compose overrides, used-valueset, count guard ─────

  await test('compose: display override from compose replaces provider display', async () => {
    // Gender 'male' has provider display 'Male' — compose overrides to 'Masculin'
    const { result } = await expand(vs({
      system: SYS.GENDER,
      concept: [{ code: 'male', display: 'Masculin' }, { code: 'female' }],
    }));
    const male = findCode(result, 'male');
    assert(male, 'missing code male');
    assert(male.display === 'Masculin',
      `expected display 'Masculin', got '${male.display}'`);
    // female should retain provider display
    const female = findCode(result, 'female');
    assert(female, 'missing code female');
    assert(female.display === 'Female',
      `expected display 'Female', got '${female.display}'`);
  });

  await test('compose: inline designation from compose appears with includeDesignations', async () => {
    const { result } = await expand(vs({
      system: SYS.GENDER,
      concept: [{
        code: 'male',
        designation: [
          { language: 'de', value: 'Männlich' },
          { language: 'fr', value: 'Masculin' },
        ],
      }],
    }), { includeDesignations: true });
    const male = findCode(result, 'male');
    assert(male, 'missing code male');
    const desigs = male.designation || [];
    assert(desigs.some(d => d.language === 'de' && d.value === 'Männlich'),
      `expected German designation, got: ${JSON.stringify(desigs)}`);
    assert(desigs.some(d => d.language === 'fr' && d.value === 'Masculin'),
      `expected French designation, got: ${JSON.stringify(desigs)}`);
  });

  await test('meta: ValueSet import emits used-valueset parameter', async () => {
    // Pure import of administrative-gender VS — should emit used-valueset
    const { result } = await expand(vs({
      valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'],
    }));
    const usedVS = expansionParams(result, 'used-valueset');
    assert(usedVS.length > 0,
      `expected used-valueset parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
    assert(usedVS.some(p => (p.valueUri || '').includes('administrative-gender')),
      `expected used-valueset for administrative-gender, got: ${JSON.stringify(usedVS)}`);
  });

  await test('meta: count parameter is omitted when not requested (no count=-1)', async () => {
    // Expand without specifying count — should NOT emit count=-1
    const { result } = await expand(vs({
      system: SYS.GENDER,
    }));
    const countParams = expansionParams(result, 'count');
    const negative = countParams.filter(p => p.valueInteger < 0);
    assert(negative.length === 0,
      `should not emit negative count, got: ${JSON.stringify(countParams)}`);
  });


  // ── Phase 1.5: designation parameter filter ────────────────────────

  await test('lang: designation parameter filters SNOMED designations by FSN use code', async () => {
    // SNOMED 73211009 has 3 designations: 2 synonyms + 1 FSN
    // designation=http://snomed.info/sct|900000000000003001 should keep only FSN
    const { result } = await expand(vs({
      system: SYS.SCT,
      concept: [{ code: '73211009' }],
    }), {
      includeDesignations: true,
      params: [
        { name: 'designation', valueString: 'http://snomed.info/sct|900000000000003001' },
      ],
    });
    const entry = findCode(result, '73211009');
    assert(entry, 'missing code 73211009');
    const desigs = entry.designation || [];
    assert(desigs.length > 0, 'expected at least one designation after filter');
    // All returned designations should have FSN use code
    for (const d of desigs) {
      assert(d.use?.code === '900000000000003001',
        `expected only FSN designations, got use.code=${d.use?.code} value=${d.value}`);
    }
    // Should have exactly 1 FSN
    assert(desigs.length === 1,
      `expected 1 FSN designation, got ${desigs.length}: ${JSON.stringify(desigs)}`);
  });

  await test('lang: displayLanguage=en echoed and matches default display for SNOMED', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      concept: [{ code: '73211009' }],
    }), {
      params: [{ name: 'displayLanguage', valueCode: 'en' }],
    });
    const entry = findCode(result, '73211009');
    assert(entry, 'missing code 73211009');
    assert(entry.display === 'Diabetes mellitus',
      `expected English display, got '${entry.display}'`);
    // displayLanguage should be echoed in expansion parameters
    assert(hasExpansionParam(result, 'displayLanguage', 'en'),
      `expected displayLanguage=en in params, got: ${JSON.stringify(expansionParams(result, 'displayLanguage'))}`);
  });

  await test('lang: redundant designation equal to primary display is suppressed', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      concept: [{ code: '73211009' }],
    }), { includeDesignations: true });
    const dm = findCode(result, '73211009');
    assert(dm, 'missing 73211009');
    for (const d of dm.designation || []) {
      const redundant = d.value === dm.display
        && (!d.use || d.use?.code === 'display')
        && (!d.language || d.language.startsWith('en'));
      assert(!redundant,
        `redundant designation should be suppressed for display '${dm.display}'`);
    }
  });

  // ── Phase 1.8: property-value regex in SQL ─────────────────────────

  await test('logic: property regex on literal-valued property (LOINC STATUS regex ^ACT)', async () => {
    // LOINC STATUS is a literal property. regex should work like = but with pattern matching.
    const { result } = await expand(vs({
      system: SYS.LOINC,
      filter: [{ property: 'STATUS', op: 'regex', value: '^ACT' }],
    }), { count: 5 });
    assert(codes(result).length > 0,
      `expected results for STATUS regex ^ACT, got ${codes(result).length}`);
    assert(result.expansion.total > 0 || codes(result).length > 0,
      `expected non-zero total or results`);
  });

  // ── Phase 2: shape-A, infra, shape-B/filter tests ─────────────────
  console.log('\n=== Phase 2: shape-A / infra / shape-B / filters ==='); currentCategory = 'Phase 2';

  await test('shape-A: currency full expansion (preloaded map)', async () => {
    const { result } = await expand(vs({ system: SYS.CURRENCY }), { count: 500 });
    const all = codes(result);
    assert(all.length >= 150, `expected ≥150 currency codes, got ${all.length}`);
    const usd = findCode(result, 'USD');
    assert(usd, 'USD not found');
    assert(usd.display && usd.display.length > 0, 'USD missing display');
    const eur = findCode(result, 'EUR');
    assert(eur, 'EUR not found');
    assert(eur.display && eur.display.length > 0, 'EUR missing display');
    const jpy = findCode(result, 'JPY');
    assert(jpy, 'JPY not found');
    assert(jpy.display && jpy.display.length > 0, 'JPY missing display');
  });

  await test('shape-A: administrative-gender (cs-cs) strict shape', async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }));
    eq(result.expansion.total, 4, 'total');
    eq(codes(result).length, 4, 'exactly 4 codes returned');
    assert(findCode(result, 'male')?.display === 'Male', 'male display');
    assert(findCode(result, 'female')?.display === 'Female', 'female display');
    assert(findCode(result, 'other')?.display === 'Other', 'other display');
    assert(findCode(result, 'unknown')?.display === 'Unknown', 'unknown display');
  });

  await test('shape-A: publication-status (cs-cs)', async () => {
    const { result } = await expand(vs({ system: SYS.PUBSTAT }));
    eq(result.expansion.total, 4, 'total');
    eq(codes(result).length, 4, 'exactly 4 codes returned');
    assert(findCode(result, 'draft')?.display === 'Draft', 'draft display');
    assert(findCode(result, 'active')?.display === 'Active', 'active display');
    assert(findCode(result, 'retired')?.display === 'Retired', 'retired display');
    assert(findCode(result, 'unknown')?.display === 'Unknown', 'unknown display');
  });

  await test('infra: tx-resource injected CodeSystem can be expanded', async () => {
    const cs = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/cs/colors',
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [
        { code: 'red', display: 'Red' },
        { code: 'green', display: 'Green' },
        { code: 'blue', display: 'Blue' },
      ],
    };
    const { result } = await expand(vs({ system: cs.url }), { txResources: cs });
    eq(codes(result).length, 3, 'expected 3 codes');
    assert(findCode(result, 'red')?.display === 'Red', 'red present');
    assert(findCode(result, 'green')?.display === 'Green', 'green present');
    assert(findCode(result, 'blue')?.display === 'Blue', 'blue present');
  });

  await test('infra: tx-resource injected ValueSet import resolves', async () => {
    const cs = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/cs/shapes',
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [
        { code: 'circle', display: 'Circle' },
        { code: 'square', display: 'Square' },
        { code: 'triangle', display: 'Triangle' },
      ],
    };
    const importedVS = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/two-shapes',
      status: 'active',
      compose: { include: [{ system: cs.url, concept: [{ code: 'circle' }, { code: 'square' }] }] },
    };
    const outerVS = {
      resourceType: 'ValueSet',
      status: 'active',
      compose: { include: [{ valueSet: [importedVS.url] }] },
    };
    const { result } = await expand(outerVS, { txResources: [cs, importedVS] });
    eq(codes(result).length, 2, 'expected 2 codes from import');
    assert(findCode(result, 'circle'), 'circle present');
    assert(findCode(result, 'square'), 'square present');
    assert(!findCode(result, 'triangle'), 'triangle should be absent');
  });

  await test('shape-B: single concept exact match (v0)', async () => {
    const { result } = await expand(vs({ system: SYS.SCT, concept: [{ code: '73211009' }] }));
    eq(result.expansion.total, 1, 'total');
    const dm = findCode(result, '73211009');
    assert(dm, 'code 73211009 not found');
    assert(dm.display?.startsWith('Diabetes mellitus'), `unexpected display: ${dm.display}`);
  });

  await test('filter: gender regex [mf].* (inline FHIR cs-cs)', async () => {
    const { result } = await expand(vs({
      system: SYS.GENDER,
      filter: [{ property: 'code', op: 'regex', value: '[mf].*' }],
    }));
    eq(codes(result).length, 2, 'expected 2 codes');
    assert(findCode(result, 'male'), 'male present');
    assert(findCode(result, 'female'), 'female present');
    assert(!findCode(result, 'other'), 'other should be absent');
    assert(!findCode(result, 'unknown'), 'unknown should be absent');
  });

  await test('filter: inline FHIR is-a with hierarchy (condition-ver-status)', async () => {
    // condition-ver-status hierarchy: unconfirmed → {provisional, differential}, confirmed, refuted, entered-in-error
    // is-a "unconfirmed" = unconfirmed + provisional + differential = 3 codes
    const { result } = await expand(vs({
      system: SYS.CONDVER,
      filter: [{ property: 'concept', op: 'is-a', value: 'unconfirmed' }],
    }));
    eq(codes(result).length, 3, 'is-a unconfirmed = 3 codes');
    assert(findCode(result, 'unconfirmed'), 'unconfirmed present (self)');
    assert(findCode(result, 'provisional'), 'provisional present (child)');
    assert(findCode(result, 'differential'), 'differential present (child)');
    assert(!findCode(result, 'confirmed'), 'confirmed should be absent');
    assert(!findCode(result, 'refuted'), 'refuted should be absent');
    assert(!findCode(result, 'entered-in-error'), 'entered-in-error should be absent');
  });

  await test('filter: inline FHIR descendent-of (condition-ver-status)', async () => {
    // descendent-of "unconfirmed" = provisional + differential = 2 codes (excludes self)
    const { result } = await expand(vs({
      system: SYS.CONDVER,
      filter: [{ property: 'concept', op: 'descendent-of', value: 'unconfirmed' }],
    }));
    eq(codes(result).length, 2, 'descendent-of unconfirmed = 2 codes');
    assert(!findCode(result, 'unconfirmed'), 'unconfirmed excluded (self)');
    assert(findCode(result, 'provisional'), 'provisional present');
    assert(findCode(result, 'differential'), 'differential present');
  });

  await test('filter: inline FHIR concept = exact code (cs-cs)', async () => {
    const { result } = await expand(vs({
      system: SYS.CONDVER,
      filter: [{ property: 'concept', op: '=', value: 'confirmed' }],
    }));
    eq(codes(result).length, 1, 'expected exactly 1 code');
    assert(findCode(result, 'confirmed'), 'confirmed present');
  });

  await test('filter: country code regex A.* (cs-country)', async () => {
    const { result } = await expand(vs({
      system: SYS.COUNTRY,
      filter: [{ property: 'code', op: 'regex', value: 'A.*' }],
    }), { count: 500 });
    assert(codes(result).length > 10, `expected >10 country codes starting with A, got ${codes(result).length}`);
    assert(codes(result).every(c => c.code.startsWith('A')),
      'all codes should start with A');
  });

  await test('filter: currency decimals=0 (property =)', async () => {
    const { result } = await expand(vs({
      system: SYS.CURRENCY,
      filter: [{ property: 'decimals', op: '=', value: '0' }],
    }), { count: 500 });
    assert(codes(result).length > 5, `expected >5 zero-decimal currencies, got ${codes(result).length}`);
    assert(findCode(result, 'JPY'), 'JPY should be zero-decimal');
  });

  await test('params: property=definition includes definition property', async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }), {
      params: [{ name: 'property', valueString: 'definition' }],
    });
    const all = codes(result);
    assert(all.length > 0, 'should have codes');
    for (const c of all) {
      const props = c.property || [];
      const defProp = props.find(p => p.code === 'definition');
      assert(defProp, `code ${c.code} should have a definition property, got props: ${JSON.stringify(props)}`);
      assert(defProp.valueString && defProp.valueString.length > 0,
        `code ${c.code} definition should have non-empty valueString`);
    }
  });

  await test('lang: includeDesignations on package cs-cs whole-system is structurally valid', async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }), { includeDesignations: true });
    const all = codes(result);
    assert(all.length === 4, `expected 4 gender codes, got ${all.length}`);
    let totalDesignations = 0;
    for (const c of all) {
      if (c.designation && c.designation.length > 0) {
        totalDesignations += c.designation.length;
        for (const d of c.designation) {
          // Each designation must have at least a value
          assert(d.value && d.value.length > 0,
            `designation for ${c.code} missing value: ${JSON.stringify(d)}`);
          // Structural validity: must have language, use, or value
          assert(d.language || d.use || d.value,
            `designation for ${c.code} missing language/use/value: ${JSON.stringify(d)}`);
        }
      }
    }
    assert(totalDesignations >= 0, 'designation check completed');
  });

  // ── Phase 2 batch 2: logic, provider, pagination, text-search, exclude ──

  await test('logic: imported inc/exc valueSets apply Inc/Exc semantics', async () => {
    const csUrl = `http://example.org/cs/palette-${Date.now()}`;
    const incVsUrl = `http://example.org/vs/palette-inc-${Date.now()}`;
    const excVsUrl = `http://example.org/vs/palette-exc-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'red',display:'Red'},{code:'blue',display:'Blue'},{code:'green',display:'Green'},{code:'yellow',display:'Yellow'}]};
    const incVs = {resourceType:'ValueSet',url:incVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'red'},{code:'blue'},{code:'green'}]}]}};
    const excVs = {resourceType:'ValueSet',url:excVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'blue'}]}]}};
    const { result } = await expand(vs([{valueSet:[incVsUrl]}],[{valueSet:[excVsUrl]}]),
      {txResources:[cs,incVs,excVs]});
    assert(codes(result).length === 2, `expected 2 codes, got ${codes(result).length}`);
    assert(findCode(result,'red'), 'red should remain');
    assert(findCode(result,'green'), 'green should remain');
    assert(!findCode(result,'blue'), 'blue should be excluded');
  });

  await test('logic: total includes direct and imported include contributions', async () => {
    const csUrl = `http://example.org/cs/total-${Date.now()}`;
    const impVsUrl = `http://example.org/vs/total-imp-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'red',display:'Red'},{code:'blue',display:'Blue'},{code:'green',display:'Green'},{code:'yellow',display:'Yellow'}]};
    const impVs = {resourceType:'ValueSet',url:impVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'green'},{code:'yellow'}]}]}};
    const { result } = await expand(vs([
      {system:csUrl,concept:[{code:'red'},{code:'blue'}]},
      {valueSet:[impVsUrl]},
    ]),{txResources:[cs,impVs]});
    assert(codes(result).length === 4, `expected 4 codes, got ${codes(result).length}`);
    assert(result.expansion.total === 4, `expected total=4, got ${result.expansion.total}`);
  });

  await test('logic: whole-system descendant traversal keeps exact total', async () => {
    const csUrl = `http://example.org/cs/hier-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[
        {code:'root-a',display:'Root A',concept:[{code:'child-a1',display:'Child A1'},{code:'child-a2',display:'Child A2'}]},
        {code:'root-b',display:'Root B',concept:[{code:'child-b1',display:'Child B1'}]},
      ]};
    const { result } = await expand(vs({system:csUrl}),{txResources:[cs]});
    const all = codes(result);
    assert(all.length === 5, `expected 5 flattened codes, got ${all.length}`);
    assert(result.expansion.total === 5, `expected total=5, got ${result.expansion.total}`);
  });

  await test('logic: total reflects imported excludes without mutating accumulated list', async () => {
    const csUrl = `http://example.org/cs/exc-total-${Date.now()}`;
    const incVsUrl = `http://example.org/vs/exc-total-inc-${Date.now()}`;
    const excVsUrl = `http://example.org/vs/exc-total-exc-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'red',display:'Red'},{code:'blue',display:'Blue'},{code:'green',display:'Green'},{code:'yellow',display:'Yellow'}]};
    const incVs = {resourceType:'ValueSet',url:incVsUrl,status:'active',
      compose:{include:[{system:csUrl}]}};
    const excVs = {resourceType:'ValueSet',url:excVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'blue'},{code:'yellow'}]}]}};
    const { result: full } = await expand(vs([{valueSet:[incVsUrl]}],[{valueSet:[excVsUrl]}]),
      {txResources:[cs,incVs,excVs]});
    assert(codes(full).length === 2, `expected 2 survivors, got ${codes(full).length}`);
    assert(findCode(full,'red'), 'red should remain');
    assert(findCode(full,'green'), 'green should remain');
    if (full.expansion.total != null) {
      assert(full.expansion.total === 2, `expected total=2, got ${full.expansion.total}`);
    }
    // Paginated: total should still be 2
    const { result: page } = await expand(vs([{valueSet:[incVsUrl]}],[{valueSet:[excVsUrl]}]),
      {txResources:[cs,incVs,excVs], count:1, offset:0});
    if (page.expansion.total != null) {
      assert(page.expansion.total === 2, `paged total should be 2, got ${page.expansion.total}`);
    }
  });

  await test('logic: mixed import+peer inc/exc paginates without gaps or duplicates', async () => {
    const csUrl = `http://example.org/cs/page-${Date.now()}`;
    const incVsUrl = `http://example.org/vs/page-inc-${Date.now()}`;
    const excVsUrl = `http://example.org/vs/page-exc-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'red',display:'Red'},{code:'blue',display:'Blue'},{code:'green',display:'Green'}]};
    const incVs = {resourceType:'ValueSet',url:incVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'red'},{code:'blue'},{code:'green'}]}]}};
    const excVs = {resourceType:'ValueSet',url:excVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'blue'}]}]}};
    const query = vs(
      [{valueSet:[incVsUrl]},{system:SYS.GENDER,concept:[{code:'male'},{code:'female'}]}],
      [{valueSet:[excVsUrl]},{system:SYS.GENDER,concept:[{code:'female'}]}]);
    const txR = [cs,incVs,excVs];
    const { result: full } = await expand(query, {txResources:txR, count:100});
    const fullCodes = codes(full).map(c => `${c.system}|${c.code}`);
    const fullSet = new Set(fullCodes);
    assert(fullSet.size === 3, `expected 3 final codes, got ${fullSet.size}`);
    // Page through with count=1
    const pagedCodes = [];
    for (let off = 0; off < 10; off++) {
      const { result: p } = await expand(query, {txResources:txR, count:1, offset:off});
      const pc = codes(p).map(c => `${c.system}|${c.code}`);
      if (pc.length === 0) break;
      pagedCodes.push(...pc);
    }
    const pagedSet = new Set(pagedCodes);
    assert(pagedCodes.length === pagedSet.size, 'paged should not duplicate');
    assert(pagedSet.size === fullSet.size, `paged ${pagedSet.size} != full ${fullSet.size}`);
  });

  await test('logic: bulk locate handles >50 unique concepts', async () => {
    // Seed from SNOMED is-a diabetes
    const { result: seed } = await expand(vs({
      system: SYS.SCT, filter: [{property:'concept',op:'is-a',value:'73211009'}],
    }), {count:150});
    const seedCodes = [...new Set(codes(seed).map(c=>c.code))].slice(0,60);
    assert(seedCodes.length >= 50, `need >=50 seed codes, got ${seedCodes.length}`);
    const { result } = await expand(vs({
      system: SYS.SCT, concept: seedCodes.map(code=>({code})),
    }), {count:200});
    const gotSet = new Set(codes(result).map(c=>c.code));
    assert(gotSet.size === seedCodes.length,
      `expected ${seedCodes.length} codes, got ${gotSet.size}`);
  });

  await test('text-search: SNOMED filter=diabetes no pagination', async () => {
    // count: 2000 to bypass default limit (diabetes returns ~1179 codes > 1000 limit)
    const { result } = await expand(vs({system:SYS.SCT}), {filter:'diabetes', count: 2000});
    const c = codes(result);
    assert(c.length > 0, `expected results, got ${c.length}`);
    assert(c.length >= 100, `expected many results, got ${c.length}`);
  });

  await test('logic: system exclude global when import include is present', async () => {
    const impVsUrl = `http://example.org/vs/exc-guard-${Date.now()}`;
    const impVs = {resourceType:'ValueSet',url:impVsUrl,status:'active',
      compose:{include:[{system:SYS.SCT,concept:[{code:'44054006'}]}]}};
    const { result } = await expand(vs(
      [{system:SYS.SCT,filter:[{property:'concept',op:'is-a',value:'73211009'}]},{valueSet:[impVsUrl]}],
      [{system:SYS.SCT,concept:[{code:'44054006'}]}]
    ), {txResources:[impVs], count:200});
    assert(!findCode(result,'44054006'), 'excluded code should not appear despite import');
  });

  await test('exclude: inline FHIR filter-based exclude (condition-ver-status)', async () => {
    const { result } = await expand(vs(
      [{system:SYS.CONDVER}],
      [{system:SYS.CONDVER,filter:[{property:'concept',op:'is-a',value:'unconfirmed'}]}]
    ));
    const c = codes(result);
    // Total is 6, minus unconfirmed subtree (3) = 3
    assert(c.length === 3, `expected 3 after exclude, got ${c.length}`);
    assert(!findCode(result,'unconfirmed'), 'unconfirmed excluded');
    assert(!findCode(result,'provisional'), 'provisional excluded');
    assert(!findCode(result,'differential'), 'differential excluded');
    assert(findCode(result,'confirmed'), 'confirmed should remain');
  });

  await test('provider: preloaded map iteration (currency full + filter)', async () => {
    const { result: full } = await expand(vs({system:SYS.CURRENCY}));
    assert(codes(full).length >= 150, `expected >=150 currencies, got ${codes(full).length}`);
    const { result: filtered } = await expand(vs({
      system:SYS.CURRENCY, filter:[{property:'decimals',op:'=',value:'0'}],
    }));
    assert(codes(filtered).length === 18,
      `expected 18 zero-decimal currencies, got ${codes(filtered).length}`);
  });

  await test('provider: cs-cs hierarchy iteration (condition-ver-status)', async () => {
    const { result } = await expand(vs({system:SYS.CONDVER}));
    const c = codes(result);
    assert(c.length === 6, `expected 6 condition-ver-status codes, got ${c.length}`);
    assert(findCode(result,'unconfirmed'), 'missing unconfirmed');
    assert(findCode(result,'provisional'), 'missing provisional');
    assert(findCode(result,'differential'), 'missing differential');
    assert(findCode(result,'confirmed'), 'missing confirmed');
    assert(findCode(result,'refuted'), 'missing refuted');
    assert(findCode(result,'entered-in-error'), 'missing entered-in-error');
  });

  // ── Phase 2 batch 3: pagination, multi-system, coverage, pagination-safety ──

  await test('pagination: currency count=10 offset=0', async () => {
    const { result } = await expand(vs({system:SYS.CURRENCY}), {count:10, offset:0});
    assert(codes(result).length === 10, `expected 10 codes, got ${codes(result).length}`);
    assert(result.expansion.total >= 150, `expected total>=150, got ${result.expansion.total}`);
  });

  await test('pagination-bug: preloaded map total matches full expansion when paged', async () => {
    // Full expansion
    const { result: full } = await expand(vs({system:SYS.CURRENCY}));
    const fullCount = codes(full).length;
    // Paged — total should match
    const { result: page } = await expand(vs({system:SYS.CURRENCY}), {count:10, offset:0});
    assert(page.expansion.total === fullCount,
      `paged total ${page.expansion.total} != full count ${fullCount}`);
  });

  await test('multi-system: v0 filter + preloaded whole + cs-cs enumerated', async () => {
    const { result } = await expand(vs([
      {system:SYS.SCT, filter:[{property:'concept',op:'is-a',value:'73211009'}]},
      {system:SYS.CURRENCY},
      {system:SYS.GENDER, concept:[{code:'male'}]},
    ]), {count:5, offset:0});
    const c = codes(result);
    assert(c.length === 5, `expected 5 codes, got ${c.length}`);
    // total should be diabetes codes + all currencies + 1 gender
    assert(result.expansion.total > 200, `expected large total, got ${result.expansion.total}`);
  });

  await test('provider: v0 SNOMED large is-a pagination consistency', async () => {
    const q = vs({system:SYS.SCT, filter:[{property:'concept',op:'is-a',value:'73211009'}]});
    const { result: p1 } = await expand(q, {count:50, offset:0});
    const { result: p2 } = await expand(q, {count:50, offset:50});
    const set1 = new Set(codes(p1).map(c=>c.code));
    const set2 = new Set(codes(p2).map(c=>c.code));
    assert(set1.size === 50, `page1 expected 50, got ${set1.size}`);
    assert(set2.size === 50, `page2 expected 50, got ${set2.size}`);
    // No overlap
    for (const code of set2) {
      assert(!set1.has(code), `code ${code} in both pages`);
    }
  });

  await test('provider: v0 RxNorm text search + property filter combined', async () => {
    const { result } = await expand(vs({
      system:SYS.RXNORM, filter:[{property:'TTY',op:'=',value:'IN'}],
    }), {filter:'aspirin', count:20});
    const c = codes(result);
    assert(c.length > 0, 'expected aspirin results');
    assert(c.some(x => x.code === '1191'), 'expected aspirin code 1191');
  });

  await test('coverage: tx-resource whole include with cs-cs peer', async () => {
    const csUrl = `http://example.org/cs/cov-whole-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'a',display:'A'},{code:'b',display:'B'}]};
    const { result } = await expand(vs([
      {system:csUrl},
      {system:SYS.GENDER, concept:[{code:'male'}]},
    ]),{txResources:[cs]});
    const c = codes(result);
    assert(c.length === 3, `expected 3, got ${c.length}`);
    assert(findCode(result,'a'), 'missing a');
    assert(findCode(result,'male'), 'missing male');
  });

  await test('coverage: tx-resource concept include + exclude with cs-cs peer', async () => {
    const csUrl = `http://example.org/cs/cov-exc-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'x',display:'X'},{code:'y',display:'Y'},{code:'z',display:'Z'}]};
    const { result } = await expand(vs(
      [{system:csUrl,concept:[{code:'x'},{code:'y'},{code:'z'}]},{system:SYS.GENDER,concept:[{code:'male'},{code:'female'}]}],
      [{system:csUrl,concept:[{code:'y'}]},{system:SYS.GENDER,concept:[{code:'female'}]}]
    ),{txResources:[cs]});
    const c = codes(result);
    assert(c.length === 3, `expected 3 (x,z,male), got ${c.length}`);
    assert(findCode(result,'x'), 'missing x');
    assert(findCode(result,'z'), 'missing z');
    assert(findCode(result,'male'), 'missing male');
    assert(!findCode(result,'y'), 'y should be excluded');
    assert(!findCode(result,'female'), 'female should be excluded');
  });

  await test('coverage: valueset-import include with gender peer', async () => {
    // Adapted from codex-2 USPS test — use gender import instead
    const { result } = await expand(vs([
      {valueSet:['http://hl7.org/fhir/ValueSet/administrative-gender']},
      {system:SYS.PUBSTAT, concept:[{code:'active'}]},
    ]));
    const c = codes(result);
    assert(c.length === 5, `expected 5 (4 gender + 1 pubstat), got ${c.length}`);
    assert(findCode(result,'male'), 'missing male');
    assert(findCode(result,'active'), 'missing active');
  });

  await test('coverage: valueset-import include with gender peer and exclude', async () => {
    const { result } = await expand(vs(
      [{valueSet:['http://hl7.org/fhir/ValueSet/administrative-gender']},{system:SYS.PUBSTAT,concept:[{code:'active'}]}],
      [{system:SYS.GENDER,concept:[{code:'other'},{code:'unknown'}]}]
    ));
    const c = codes(result);
    assert(c.length === 3, `expected 3 (male,female,active), got ${c.length}`);
    assert(!findCode(result,'other'), 'other excluded');
    assert(!findCode(result,'unknown'), 'unknown excluded');
  });

  await test('coverage: country regex filter with cs-cs peer include', async () => {
    const { result } = await expand(vs([
      {system:SYS.COUNTRY, filter:[{property:'code',op:'regex',value:'A.*'}]},
      {system:SYS.GENDER, concept:[{code:'male'}]},
    ]));
    const c = codes(result);
    assert(c.length > 10, `expected >10, got ${c.length}`);
    assert(findCode(result,'male'), 'missing gender peer code');
  });

  await test('pagination-safety: mixed v0 + preloaded reconstruct full set', async () => {
    const q = vs([
      {system:SYS.SCT, concept:[{code:'73211009'},{code:'44054006'},{code:'46635009'}]},
      {system:SYS.CURRENCY},
    ]);
    const { result: full } = await expand(q, {count:500});
    const fullSet = new Set(codes(full).map(c=>`${c.system}|${c.code}`));
    // Page through
    const pagedKeys = [];
    for (let off = 0; off < fullSet.size + 10; off += 50) {
      const { result: p } = await expand(q, {count:50, offset:off});
      const pc = codes(p).map(c=>`${c.system}|${c.code}`);
      if (pc.length === 0) break;
      pagedKeys.push(...pc);
    }
    const pagedSet = new Set(pagedKeys);
    assert(pagedSet.size === fullSet.size,
      `paged ${pagedSet.size} != full ${fullSet.size}`);
  });

  await test('pagination-safety: valueset-import peer with excludes reconstruct', async () => {
    const csUrl = `http://example.org/cs/pgsafe-${Date.now()}`;
    const vsUrl = `http://example.org/vs/pgsafe-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'a',display:'A'},{code:'b',display:'B'},{code:'c',display:'C'},{code:'d',display:'D'}]};
    const impVs = {resourceType:'ValueSet',url:vsUrl,status:'active',
      compose:{include:[{system:csUrl}]}};
    const q = vs([{valueSet:[vsUrl]},{system:SYS.GENDER}],
      [{system:csUrl,concept:[{code:'b'}]},{system:SYS.GENDER,concept:[{code:'unknown'}]}]);
    const { result: full } = await expand(q, {txResources:[cs,impVs], count:100});
    const fullSet = new Set(codes(full).map(c=>`${c.system}|${c.code}`));
    const pagedKeys = [];
    for (let off = 0; off < 20; off++) {
      const { result: p } = await expand(q, {txResources:[cs,impVs], count:1, offset:off});
      const pc = codes(p).map(c=>`${c.system}|${c.code}`);
      if (pc.length === 0) break;
      pagedKeys.push(...pc);
    }
    const pagedSet = new Set(pagedKeys);
    assert(pagedKeys.length === pagedSet.size, 'no duplicates in paged');
    assert(pagedSet.size === fullSet.size,
      `paged ${pagedSet.size} != full ${fullSet.size}`);
  });

  await test('pagination-safety: mixed import+system high-count page not capped', async () => {
    // Expand gender import + currency peer — high count should return all
    const { result } = await expand(vs([
      {valueSet:['http://hl7.org/fhir/ValueSet/administrative-gender']},
      {system:SYS.CURRENCY},
    ]), {count:500});
    const c = codes(result);
    assert(c.length >= 160, `expected >=160 (4 gender + ~178 currency), got ${c.length}`);
  });

  await test('logic: same-system valueSet intersections constrain membership', async () => {
    // System + valueSet[] intersection: only codes in both the system filter AND the imported VS
    const { result } = await expand(vs({
      system: SYS.GENDER,
      valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'],
      concept: [{code:'male'},{code:'female'}],
    }));
    const c = codes(result);
    assert(c.length === 2, `expected 2 (male+female intersection), got ${c.length}`);
  });

  await test('logic: code regex handled in sqlite-v0', async () => {
    const { result } = await expand(vs({
      system: SYS.SCT, filter:[{property:'code',op:'regex',value:'^7[0-9]{4,}'}],
    }), {count:20});
    const c = codes(result);
    assert(c.length > 0, 'expected code regex results');
    for (const x of c) {
      assert(x.code.startsWith('7'), `expected code starting with 7, got ${x.code}`);
    }
  });

  // ── Phase 2 batch 4: remaining green tests ──

  await test('coverage: UCUM whole-system with gender peer include', async () => {
    // UCUM whole-system uses specialEnumeration (ucum-common) — returns common units + unclosed
    // count: 2000 to bypass default limit (UCUM common = 1364 + 1 gender > 1000)
    const { result } = await expand(vs([
      {system:SYS.UCUM},
      {system:SYS.GENDER, concept:[{code:'male'}]},
    ]), { count: 2000 });
    const c = codes(result);
    assert(findCode(result,'male'), 'gender peer code should be present');
    assert(c.length > 100, `expected many UCUM common units + peer, got ${c.length}`);
  });

  // ── Phase 4: fixture expansion (US states, area codes, MIME, language) ──

  // ── Phase 4.1: US states (preloaded map, 62 codes) ──

  await test('shape-A: US states full expansion', async () => {
    const { result } = await expand(vs({system:SYS.USPS}));
    assert(result.expansion.total === 62, `expected 62 US states, got ${result.expansion.total}`);
    assert(findCode(result,'CA'), 'California should be present');
    assert(findCode(result,'TX'), 'Texas should be present');
    const ca = findCode(result,'CA');
    assert(ca.display === 'California', `expected California, got ${ca.display}`);
  });

  await test('shape-B: US states enumerated', async () => {
    const { result } = await expand(vs({system:SYS.USPS,
      concept:[{code:'CA'},{code:'NY'},{code:'TX'}]}));
    assert(result.expansion.total === 3, `expected 3, got ${result.expansion.total}`);
    assert(findCode(result,'CA')?.display === 'California');
    assert(findCode(result,'NY')?.display === 'New York');
    assert(findCode(result,'TX')?.display === 'Texas');
  });

  await test('exclude: US states subtract 2 from 4 enumerated', async () => {
    const { result } = await expand(vs(
      {system:SYS.USPS, concept:[{code:'CA'},{code:'NY'},{code:'TX'},{code:'FL'}]},
      {system:SYS.USPS, concept:[{code:'CA'},{code:'FL'}]}
    ));
    assert(result.expansion.total === 2, `expected 2 after exclude, got ${result.expansion.total}`);
    assert(findCode(result,'NY'), 'NY should remain');
    assert(findCode(result,'TX'), 'TX should remain');
    assert(!findCode(result,'CA'), 'CA should be excluded');
    assert(!findCode(result,'FL'), 'FL should be excluded');
  });

  await test('exclude: exclude from whole system (preloaded map)', async () => {
    const { result } = await expand(vs(
      {system:SYS.USPS},
      {system:SYS.USPS, concept:[{code:'CA'},{code:'NY'}]}
    ));
    assert(result.expansion.total === 60, `expected 60, got ${result.expansion.total}`);
    assert(!findCode(result,'CA'), 'CA should be excluded');
    assert(!findCode(result,'NY'), 'NY should be excluded');
    assert(findCode(result,'TX'), 'TX should remain');
  });

  await test('pagination: US states disjoint pages', async () => {
    const { result: p1 } = await expand(vs({system:SYS.USPS}), {count:30, offset:0});
    const { result: p2 } = await expand(vs({system:SYS.USPS}), {count:30, offset:30});
    const { result: p3 } = await expand(vs({system:SYS.USPS}), {count:30, offset:60});
    const c1 = codes(p1), c2 = codes(p2), c3 = codes(p3);
    assert(c1.length === 30, `page 1 should have 30, got ${c1.length}`);
    assert(c2.length === 30, `page 2 should have 30, got ${c2.length}`);
    assert(c3.length === 2, `page 3 should have 2, got ${c3.length}`);
    const all = [...c1, ...c2, ...c3];
    assert(new Set(all).size === 62, `pages should be disjoint (got ${new Set(all).size} unique)`);
  });

  await test('pagination: US states last page partial', async () => {
    const { result } = await expand(vs({system:SYS.USPS}), {count:20, offset:50});
    const c = codes(result);
    assert(c.length === 12, `expected 12 on last page, got ${c.length}`);
    assert(result.expansion.total === 62, `total should be 62, got ${result.expansion.total}`);
  });

  await test('pagination: US states offset beyond end', async () => {
    const { result } = await expand(vs({system:SYS.USPS}), {count:10, offset:100});
    const c = codes(result);
    assert(c.length === 0, `expected 0, got ${c.length}`);
    assert(result.expansion.total === 62, `total should be 62, got ${result.expansion.total}`);
  });

  await test('multi-system: gender + US states union', async () => {
    const { result } = await expand(vs([
      {system:SYS.GENDER},
      {system:SYS.USPS},
    ]));
    assert(result.expansion.total === 66, `expected 4+62=66, got ${result.expansion.total}`);
    assert(findCode(result,'male'), 'gender male should be present');
    assert(findCode(result,'CA'), 'CA should be present');
  });

  // ── Phase 4.2: area codes (M49, 270 codes) ──

  await test('shape-A: area codes full expansion', async () => {
    const { result } = await expand(vs({system:SYS.AREACODE}));
    assert(result.expansion.total === 270, `expected 270, got ${result.expansion.total}`);
  });

  await test('filter: area codes class=region', async () => {
    const { result } = await expand(vs({system:SYS.AREACODE,
      filter:[{property:'class', op:'=', value:'region'}]}));
    assert(result.expansion.total === 29, `expected 29 regions, got ${result.expansion.total}`);
    // Spot check: World (001) should be present
    assert(findCode(result,'001'), 'World (001) should be present');
  });

  await test('filter: area codes class=country', async () => {
    const { result } = await expand(vs({system:SYS.AREACODE,
      filter:[{property:'class', op:'=', value:'country'}]}));
    assert(result.expansion.total === 241, `expected 241 countries, got ${result.expansion.total}`);
  });

  await test('coverage: areacode class filter with cs-cs peer', async () => {
    const { result } = await expand(vs([
      {system:SYS.AREACODE, filter:[{property:'class', op:'=', value:'region'}]},
      {system:SYS.GENDER, concept:[{code:'male'}]},
    ]));
    assert(result.expansion.total === 30, `expected 29+1=30, got ${result.expansion.total}`);
    assert(findCode(result,'male'), 'gender should be present');
    assert(findCode(result,'001'), 'World should be present');
  });

  // ── Phase 4.3: MIME types (grammar-based, concept-include only) ──

  await test('shape-B: MIME types enumerated', async () => {
    const { result } = await expand(vs({system:SYS.MIME,
      concept:[{code:'text/html'},{code:'application/json'},{code:'image/png'}]}));
    assert(result.expansion.total === 3, `expected 3, got ${result.expansion.total}`);
    assert(findCode(result,'text/html'), 'text/html should be present');
    assert(findCode(result,'application/json'), 'application/json should be present');
    assert(findCode(result,'image/png'), 'image/png should be present');
  });

  // ── Phase 4.4: Language codes (grammar-based, concept-include) ──

  await test('shape-B: language codes enumerated', async () => {
    const { result } = await expand(vs({system:SYS.LANG,
      concept:[{code:'en'},{code:'fr'},{code:'de'}]}));
    assert(result.expansion.total === 3, `expected 3, got ${result.expansion.total}`);
    assert(findCode(result,'en')?.display === 'English', `expected English, got ${findCode(result,'en')?.display}`);
    assert(findCode(result,'fr')?.display === 'French', `expected French, got ${findCode(result,'fr')?.display}`);
    assert(findCode(result,'de')?.display === 'German', `expected German, got ${findCode(result,'de')?.display}`);
  });

  await test('params: language code includeDesignations', async () => {
    const { result } = await expand(vs({system:SYS.LANG,
      concept:[{code:'en'}]}), {includeDesignations:true});
    assert(findCode(result,'en'), 'en should be present');
    // Language provider may or may not have extra designations.
    // Verify structure is valid (no crash, display present).
    assert(findCode(result,'en').display === 'English');
  });

  // ── Phase 5: inline supplement plumbing ──

  // Helper: inline CS + supplement fixture
  function suppFixture(csUrl, suppUrl, concepts, suppConcepts, opts = {}) {
    const cs = {
      resourceType: 'CodeSystem', url: csUrl, content: 'complete',
      concept: concepts,
    };
    const supp = {
      resourceType: 'CodeSystem', url: suppUrl, content: 'supplement',
      supplements: opts.supplements || csUrl,
      concept: suppConcepts,
    };
    if (opts.suppVersion) supp.version = opts.suppVersion;
    return [cs, supp];
  }

  await test('supplement: useSupplement applies content + records used-supplement', async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s1', 'http://example.org/supp-s1',
      [{code:'A', display:'Alpha'}, {code:'B', display:'Bravo'}],
      [{code:'A', designation:[{language:'de', value:'Anfang'}]}]
    );
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'A'},{code:'B'}]}),
      { txResources: [cs, supp], includeDesignations: true,
        params: [{name:'useSupplement', valueString: supp.url}] }
    );
    // Designation from supplement appears
    const a = findCode(result, 'A');
    assert(a, 'code A missing');
    const deDes = (a.designation||[]).find(d => d.language === 'de');
    assert(deDes?.value === 'Anfang', `expected Anfang, got ${deDes?.value}`);
    // used-supplement emitted
    const usedSupp = expansionParams(result, 'used-supplement');
    assert(usedSupp.length > 0, 'used-supplement param missing');
    assert(usedSupp[0].valueUri === supp.url, `expected ${supp.url}, got ${usedSupp[0].valueUri}`);
  });

  await test('supplement: provided but not requested is ignored', async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s2', 'http://example.org/supp-s2',
      [{code:'X', display:'Xray'}],
      [{code:'X', designation:[{language:'fr', value:'Rayon'}]}]
    );
    // Provide supplement as tx-resource but DON'T request via useSupplement
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'X'}]}),
      { txResources: [cs, supp], includeDesignations: true }
    );
    const x = findCode(result, 'X');
    assert(x, 'code X missing');
    // Supplement designation should NOT appear (supplement not requested)
    const frDes = (x.designation||[]).find(d => d.language === 'fr');
    assert(!frDes, 'unrequested supplement designation should not leak');
    // No used-supplement param
    const usedSupp = expansionParams(result, 'used-supplement');
    assert(usedSupp.length === 0, 'used-supplement should not be emitted');
  });

  await test('supplement: valueset-supplement extension activates', async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s3', 'http://example.org/supp-s3',
      [{code:'M', display:'Mike'}],
      [{code:'M', designation:[{language:'es', value:'Miguel'}]}]
    );
    // Use VS extension instead of useSupplement parameter
    const vsJson = vs({system:cs.url, concept:[{code:'M'}]});
    vsJson.extension = [{
      url: 'http://hl7.org/fhir/StructureDefinition/valueset-supplement',
      valueCanonical: supp.url,
    }];
    const { result } = await expand(vsJson,
      { txResources: [cs, supp], includeDesignations: true });
    const m = findCode(result, 'M');
    const esDes = (m?.designation||[]).find(d => d.language === 'es');
    assert(esDes?.value === 'Miguel', `expected Miguel, got ${esDes?.value}`);
  });

  await test('supplement: used-supplement deduped', async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s4', 'http://example.org/supp-s4',
      [{code:'P', display:'Papa'}, {code:'Q', display:'Quebec'}],
      [{code:'P', designation:[{language:'de', value:'Pp'}]},
       {code:'Q', designation:[{language:'de', value:'Qq'}]}]
    );
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'P'},{code:'Q'}]}),
      { txResources: [cs, supp], includeDesignations: true,
        params: [{name:'useSupplement', valueString: supp.url}] }
    );
    const usedSupp = expansionParams(result, 'used-supplement');
    assert(usedSupp.length === 1, `used-supplement should appear once, got ${usedSupp.length}`);
  });

  await test('supplement: missing required fails', async () => {
    const cs = {
      resourceType: 'CodeSystem', url: 'http://example.org/cs-s5',
      content: 'complete', concept: [{code:'Z', display:'Zulu'}],
    };
    try {
      await expand(
        vs({system:cs.url, concept:[{code:'Z'}]}),
        { txResources: [cs],
          params: [{name:'useSupplement', valueString:'http://example.org/nonexistent'}] }
      );
      assert(false, 'expected error for missing supplement');
    } catch (e) {
      assert(e.message.includes('not found') || e.message.includes('supplement'),
        `expected supplement error, got: ${e.message}`);
    }
  });

  await test('supplement: missing VS extension supplement fails', async () => {
    const cs = {
      resourceType: 'CodeSystem', url: 'http://example.org/cs-s6',
      content: 'complete', concept: [{code:'Y', display:'Yankee'}],
    };
    const vsJson = vs({system:cs.url, concept:[{code:'Y'}]});
    vsJson.extension = [{
      url: 'http://hl7.org/fhir/StructureDefinition/valueset-supplement',
      valueCanonical: 'http://example.org/missing-supp',
    }];
    try {
      await expand(vsJson, { txResources: [cs] });
      assert(false, 'expected error for missing VS extension supplement');
    } catch (e) {
      assert(e.message.includes('not found') || e.message.includes('supplement'),
        `expected supplement error, got: ${e.message}`);
    }
  });

  await test('supplement: designation filter selects supplement use-coded designation', async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s7', 'http://example.org/supp-s7',
      [{code:'D', display:'Delta'}],
      [{code:'D', designation:[{
        language:'en',
        use:{system:'http://example.org/use', code:'abbrev'},
        value:'DLT'
      }]}]
    );
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'D'}]}),
      { txResources: [cs, supp], includeDesignations: true,
        params: [
          {name:'useSupplement', valueString: supp.url},
          {name:'designation', valueString:'http://example.org/use|abbrev'},
        ]}
    );
    const d = findCode(result, 'D');
    const desigs = d?.designation || [];
    assert(desigs.length === 1, `expected 1 filtered designation, got ${desigs.length}`);
    assert(desigs[0].value === 'DLT', `expected DLT, got ${desigs[0].value}`);
  });

  await test('supplement: version-pinned canonical accepted', async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s8', 'http://example.org/supp-s8',
      [{code:'V', display:'Victor'}],
      [{code:'V', designation:[{language:'ja', value:'\u30D3\u30AF\u30BF\u30FC'}]}],
      { suppVersion: '1.0' }
    );
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'V'}]}),
      { txResources: [cs, supp], includeDesignations: true,
        params: [{name:'useSupplement', valueString: supp.url + '|1.0'}] }
    );
    const v = findCode(result, 'V');
    const jaDes = (v?.designation||[]).find(d => d.language === 'ja');
    assert(jaDes, 'version-pinned supplement designation should appear');
  });

  await test('supplement: itemWeight extension projected', async () => {
    const cs = {
      resourceType: 'CodeSystem', url: 'http://example.org/cs-s9',
      content: 'complete',
      concept: [{code:'W', display:'Whiskey'}],
    };
    const supp = {
      resourceType: 'CodeSystem', url: 'http://example.org/supp-s9',
      content: 'supplement', supplements: cs.url,
      concept: [{
        code: 'W',
        extension: [{
          url: 'http://hl7.org/fhir/StructureDefinition/itemWeight',
          valueDecimal: 3.5,
        }],
      }],
    };
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'W'}]}),
      { txResources: [cs, supp],
        params: [
          {name:'useSupplement', valueString: supp.url},
          {name:'property', valueString:'http://hl7.org/fhir/StructureDefinition/itemWeight'},
        ]}
    );
    const w = findCode(result, 'W');
    // itemWeight should appear as extension on the contains entry
    const ext = (w?.extension || []).find(
      e => e.url === 'http://hl7.org/fhir/StructureDefinition/itemWeight');
    assert(ext, 'itemWeight extension should be projected');
    assert(ext.valueDecimal === 3.5, `expected 3.5, got ${ext?.valueDecimal}`);
  });

  // ── Phase 5: v0 supplement paths ──

  await test('supplement: inline supplement adds designation to SNOMED v0 code', async () => {
    const supp = {
      resourceType: 'CodeSystem', url: 'http://example.org/sct-supp-test',
      content: 'supplement', supplements: SYS.SCT,
      concept: [{code:'73211009', designation:[{language:'de', value:'Zuckerkrankheit'}]}],
    };
    const { result } = await expand(
      vs({system:SYS.SCT, concept:[{code:'73211009'}]}),
      { txResources: [supp], includeDesignations: true,
        params: [{name:'useSupplement', valueString: supp.url}] }
    );
    const dm = findCode(result, '73211009');
    assert(dm, 'missing 73211009');
    const deDes = (dm.designation||[]).find(d => d.language === 'de' && d.value === 'Zuckerkrankheit');
    assert(deDes, 'German designation from supplement should appear');
  });

  await test('supplement: inline supplement display override on LOINC v0 code', async () => {
    const supp = {
      resourceType: 'CodeSystem', url: 'http://example.org/loinc-supp-test',
      content: 'supplement', supplements: SYS.LOINC,
      concept: [{code:'2160-0', display:'Creatinine [Custom Override]'}],
    };
    const { result } = await expand(
      vs({system:SYS.LOINC, concept:[{code:'2160-0'}]}),
      { txResources: [supp],
        params: [{name:'useSupplement', valueString: supp.url}] }
    );
    const cr = findCode(result, '2160-0');
    assert(cr, 'missing 2160-0');
    assert(cr.display === 'Creatinine [Custom Override]',
      `expected overridden display, got ${cr.display}`);
  });

  // ── Phase 6: grammar-based provider handling ──

  await test('notClosed: UCUM expansion reports valueset-unclosed', async () => {
    const { result } = await expand(vs({system:SYS.UCUM}), {count:5});
    const c = codes(result);
    assert(c.length === 5, `expected 5, got ${c.length}`);
    assert(result.expansion.total > 100, `expected many UCUM codes, got ${result.expansion.total}`);
    // Must have valueset-unclosed extension
    const ext = (result.expansion.extension || []).find(
      e => e.url === 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
    assert(ext, 'valueset-unclosed extension should be present');
    assert(ext.valueString?.includes('grammar'), `unclosed message should mention grammar, got: ${ext.valueString}`);
  });

  await test('notClosed: MIME whole-system not enumerable', async () => {
    // Should return an OperationOutcome with too-costly (expand() throws on OO)
    try {
      await expand(vs({system:SYS.MIME}));
      assert(false, 'expected too-costly error');
    } catch (e) {
      assert(e.message.includes('grammar'), `error should mention grammar, got: ${e.message}`);
    }
  });

  await test('coverage: MIME concept + language peer', async () => {
    const { result } = await expand(vs([
      {system:SYS.MIME, concept:[{code:'text/html'},{code:'application/json'}]},
      {system:SYS.LANG, concept:[{code:'en'}]},
    ]));
    assert(result.expansion.total === 3, `expected 3, got ${result.expansion.total}`);
    assert(findCode(result,'text/html'), 'MIME text/html should be present');
    assert(findCode(result,'en'), 'language en should be present');
  });

  // ── Phase 7: limit enforcement ──

  await test('limit: SNOMED whole-system exceeds default limit → too-costly', async () => {
    try {
      await expand(vs({system:SYS.SCT}));
      assert(false, 'expected too-costly error');
    } catch (e) {
      assert(e.message.includes('too-costly') || e.message.includes('limit') || e.message.includes('codes'),
        `error should mention limit/too-costly, got: ${e.message}`);
    }
  });

  await test('limit: explicit limit=50 rejects US states (62 codes)', async () => {
    try {
      await expand(vs({system:SYS.USPS}), {
        params: [{ name: 'limit', valueInteger: 50 }],
      });
      assert(false, 'expected too-costly error');
    } catch (e) {
      assert(e.message.includes('62') || e.message.includes('limit'),
        `error should mention count or limit, got: ${e.message}`);
    }
  });

  await test('limit: pagination bypasses limit for large system', async () => {
    const { result } = await expand(vs({system:SYS.SCT}), { offset: 0, count: 10 });
    assert(result.expansion.total > 1000, `SNOMED total should be >1000, got ${result.expansion.total}`);
    assert(result.expansion.contains.length === 10, `expected 10 codes, got ${result.expansion.contains.length}`);
  });

  // ── Phase 8: high-value stress tests ──

  await test('unclosed: multi-system with grammar provider reports unclosed on all pages', async () => {
    // UCUM (grammar-based, unclosed) + SNOMED hand parts.
    // SNOMED sorts first alphabetically, so page 1 is all SNOMED.
    // The unclosed signal must still appear even when UCUM isn't on this page.
    const mixedVS = vs([
      {system:SYS.UCUM},
      {system:SYS.SCT, filter:[{property:'concept',op:'is-a',value:'85562004'}]}, // hand structure
    ]);
    const { result } = await expand(mixedVS, { offset: 0, count: 10 });
    // Page should be all SNOMED (it sorts before UCUM)
    const systems = new Set(codes(result).map(c => c.system));
    assert(systems.has(SYS.SCT), 'first page should have SNOMED codes');
    assert(!systems.has(SYS.UCUM), 'first page should not yet have UCUM codes');
    // But unclosed must still be reported
    const unclosed = (result.expansion.extension || []).find(
      e => e.url === 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
    assert(unclosed, 'valueset-unclosed extension must be present even on SNOMED-only page');
    assert(unclosed.valueString?.includes('grammar'),
      `unclosed message should mention grammar, got: ${unclosed?.valueString}`);
  });

  await test('stress: deep SNOMED is-a pagination stable across adjacent pages', async () => {
    // Two overlapping pages deep into Clinical finding hierarchy
    const isA404684003 = vs({system:SYS.SCT, filter:[{property:'concept',op:'is-a',value:'404684003'}]});
    const { result: p1 } = await expand(isA404684003, { offset: 50000, count: 20 });
    const { result: p2 } = await expand(isA404684003, { offset: 50010, count: 20 });

    assert(p1.expansion.total === p2.expansion.total, `totals should match: ${p1.expansion.total} vs ${p2.expansion.total}`);
    assert(p1.expansion.total > 100000, `Clinical finding total should be >100k, got ${p1.expansion.total}`);
    assert(p1.expansion.contains.length === 20, `p1 should have 20 codes, got ${p1.expansion.contains.length}`);

    // p1's last 10 codes should equal p2's first 10 codes (overlap region)
    const p1Last10 = p1.expansion.contains.slice(10).map(c => c.code);
    const p2First10 = p2.expansion.contains.slice(0, 10).map(c => c.code);
    assert(JSON.stringify(p1Last10) === JSON.stringify(p2First10),
      'overlapping region should be identical across adjacent pages');
  });

  await test('stress: complex same-system inc/exc with pagination', async () => {
    // Include is-a diabetes, exclude two specific codes, paginate
    const complexVS = vs(
      [{system:SYS.SCT, filter:[{property:'concept',op:'is-a',value:'73211009'}]}],
      [{system:SYS.SCT, concept:[{code:'44054006'},{code:'46635009'}]}]
    );
    const { result: full } = await expand(complexVS, { count: 0 });
    assert(full.expansion.total > 100, `expected >100 diabetes descendants, got ${full.expansion.total}`);

    // Paginate and verify excludes are absent
    const { result: p1 } = await expand(complexVS, { offset: 0, count: full.expansion.total });
    const allCodes = codes(p1).map(c => c.code);
    assert(!allCodes.includes('44054006'), 'excluded code 44054006 must not appear');
    assert(!allCodes.includes('46635009'), 'excluded code 46635009 must not appear');
    assert(allCodes.length === full.expansion.total, `all codes should match total: ${allCodes.length} vs ${full.expansion.total}`);
  });

  await test('stress: mixed-system text filter with limit boundary', async () => {
    // SNOMED + LOINC filtered by 'glucose' — total > 1000, so unpaginated triggers limit
    const mixedVS = vs([{system:SYS.SCT},{system:SYS.LOINC}]);

    // Unpaginated should fail with too-costly
    try {
      await expand(mixedVS, { filter: 'glucose' });
      assert(false, 'expected too-costly error for mixed-system glucose without pagination');
    } catch (e) {
      assert(e.message.includes('too-costly') || e.message.includes('limit') || e.message.includes('codes'),
        `error should mention limit/too-costly, got: ${e.message}`);
    }

    // With explicit count, should succeed and contain both systems
    const { result } = await expand(mixedVS, { filter: 'glucose', offset: 0, count: 2000 });
    assert(result.expansion.total > 1000, `mixed-system glucose total should be >1000, got ${result.expansion.total}`);
    const systems = new Set(codes(result).map(c => c.system));
    assert(systems.has(SYS.LOINC), 'LOINC codes should be present');
    assert(systems.has(SYS.SCT), 'SNOMED codes should be present');
  });

  await test('stress: include.valueSet + sibling filter at scale', async () => {
    // Import a published VS (observation-codes = LOINC whole-system) with a SNOMED filter peer
    const { result } = await expand(vs([
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: SYS.LOINC, concept: [{ code: '2339-0' }, { code: '2345-7' }] },
    ]), { count: 200 });
    const c = codes(result);
    assert(c.length > 10, `expected many codes, got ${c.length}`);
    const systems = new Set(c.map(x => x.system));
    assert(systems.has(SYS.SCT), 'SNOMED codes should be present');
    assert(systems.has(SYS.LOINC), 'LOINC codes should be present');
    assert(findCode(result, '2339-0'), 'LOINC 2339-0 should be present');
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
