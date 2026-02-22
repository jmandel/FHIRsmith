/**
 * expand-v2 test harness — runs expansions directly, no Express/HTTP.
 *
 * Loads the Library once (slow), then each test calls expand() directly
 * through the ExpandWorker → ValueSetExpander chain. Traces are captured
 * via AsyncLocalStorage and attached to results.
 *
 * Usage:
 *   node tests/tx/expand-v2-harness.js                # run all
 *   node tests/tx/expand-v2-harness.js "snomed is-a"  # run matching tests
 *   EXPAND_TRACE=1 node tests/tx/expand-v2-harness.js # with full tracing
 *   EXPAND_IMPL=legacy node tests/tx/expand-v2-harness.js
 *   EXPAND_IMPL=v2 node tests/tx/expand-v2-harness.js
 *   EXPAND_IMPL=parity node tests/tx/expand-v2-harness.js # compare v2 vs legacy
 *   EXPAND_IMPL=v2-parity node tests/tx/expand-v2-harness.js # compare v2 pushdown vs v2 fallback
 */

'use strict';

const path = require('path');
const fs = require('fs');

// Bootstrap folder-setup before anything else touches it
const folders = require('../../library/folder-setup');
folders.init(path.join(__dirname, '../../data'));

const { Library } = require('../../tx/library');
const { OperationContext } = require('../../tx/operation-context');
const { Languages } = require('../../library/languages');
const { TxParameters } = require('../../tx/params');
const { SearchFilterText } = require('../../tx/library/designations');
const ValueSet = require('../../tx/library/valueset');
const { ExpandTrace, traceStore } = require('../../tx/workers/expand-trace');

const WORKER_MODULES = {
  legacy: require('../../tx/workers/expand'),
  v2: require('../../tx/workers/expand-v2'),
};

const EXPAND_IMPL = (process.env.EXPAND_IMPL || 'v2').toLowerCase();
if (!['legacy', 'v2', 'parity', 'v2-parity'].includes(EXPAND_IMPL)) {
  throw new Error(`Invalid EXPAND_IMPL='${EXPAND_IMPL}'. Expected legacy, v2, parity, or v2-parity.`);
}

// ── Minimal logger ─────────────────────────────────────────────────────────

const log = {
  info: (...a) => process.env.HARNESS_VERBOSE ? console.log('[INFO]', ...a) : null,
  debug: () => {},
  error: (...a) => console.error('[ERR]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
};

// ── State ──────────────────────────────────────────────────────────────────

let library, provider, langDefs, i18n;

async function setup() {
  const preferredConfig = path.join(__dirname, 'fixtures', 'expand-v2-test-library.yaml');
  const fallbackConfig = path.join(__dirname, 'fixtures', 'test-library.yaml');
  const configFile = fs.existsSync(preferredConfig) ? preferredConfig : fallbackConfig;
  if (!fs.existsSync(configFile)) {
    throw new Error(`Missing config: ${preferredConfig} (or fallback ${fallbackConfig})`);
  }

  console.log('Loading library (this takes a while on first run)...');
  const t0 = performance.now();
  library = new Library(configFile, null, log, null, {});
  await library.load();

  langDefs = library.languageDefinitions;
  i18n = library.i18n;

  // Clone for R5 (loads hl7.fhir.r5.core etc.)
  provider = await library.cloneWithFhirVersion('5.0', null, '/r5');
  console.log(`Library loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

// ── Core expand helper ─────────────────────────────────────────────────────

let _lastExpandTrace = null;
let _currentTestName = null;
const _providerCoverage = new Map();
let _assessmentSourcePath = null;

function getWorkerClasses(impl) {
  const mod = WORKER_MODULES[impl];
  if (!mod) {
    throw new Error(`Unknown worker implementation '${impl}'`);
  }
  return mod;
}

function providerFamily(system) {
  if (!system) return 'valueset-import';

  // sqlite-v0 family (current runtime provider for these code systems)
  if (system === 'http://snomed.info/sct'
    || system === 'http://loinc.org'
    || system === 'http://www.nlm.nih.gov/research/umls/rxnorm') {
    return 'sqlite-v0';
  }

  // Internal providers
  if (system === 'urn:ietf:bcp:47') return 'internal:lang';
  if (system === 'urn:ietf:bcp:13') return 'internal:mimetypes';
  if (system === 'urn:iso:std:iso:3166') return 'internal:country';
  if (system === 'urn:iso:std:iso:4217') return 'internal:currency';
  if (system === 'http://unstats.un.org/unsd/methods/m49/m49.htm') return 'internal:areacode';
  if (system === 'https://www.usps.com/') return 'internal:usstates';

  // Grammar provider
  if (system === 'http://unitsofmeasure.org') return 'ucum';

  // Package-backed code systems
  if (system.startsWith('http://hl7.org/fhir/')
    || system.startsWith('http://terminology.hl7.org/')) {
    return 'package:cs-cs';
  }

  // Injected in tests
  if (system.startsWith('http://example.org/')) return 'tx-resource';

  return 'other';
}

function composeShape(cset) {
  const base = cset.concept?.length ? 'concept'
    : cset.filter?.length ? 'filter'
    : 'whole';
  const hasImport = Array.isArray(cset.valueSet) && cset.valueSet.length > 0;
  return hasImport ? `${base}+valueset` : base;
}

function recordProviderCoverage(vsJson, testName) {
  const compose = vsJson?.compose;
  if (!compose) return;

  const include = compose.include || [];
  const exclude = compose.exclude || [];
  const components = [
    ...include.map(cset => ({ role: 'include', cset })),
    ...exclude.map(cset => ({ role: 'exclude', cset })),
  ];
  if (components.length === 0) return;

  const allProviders = components.map(c => providerFamily(c.cset.system));
  for (let i = 0; i < components.length; i++) {
    const { role, cset } = components[i];
    const provider = providerFamily(cset.system);
    const shape = composeShape(cset);
    const peers = [...new Set(allProviders.filter((_, j) => j !== i))].sort();
    const peerKey = peers.join(',') || '-';
    const key = `${provider}|${role}|${shape}|${peerKey}`;

    if (!_providerCoverage.has(key)) {
      _providerCoverage.set(key, {
        provider,
        role,
        shape,
        peers,
        tests: new Set(),
        calls: 0,
      });
    }
    const row = _providerCoverage.get(key);
    row.calls += 1;
    if (testName) row.tests.add(testName);
  }
}

function printProviderCoverageReport() {
  if (_providerCoverage.size === 0) {
    console.log('\nProvider coverage matrix: none\n');
    return;
  }

  const rows = [..._providerCoverage.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider)
    || a.role.localeCompare(b.role)
    || a.shape.localeCompare(b.shape)
    || (a.peers.join(',')).localeCompare(b.peers.join(','))
  );

  console.log('\nProvider coverage matrix (provider | role | shape | peers | tests | calls):\n');
  for (const r of rows) {
    const peers = r.peers.length > 0 ? r.peers.join(',') : '-';
    console.log(`  - ${r.provider} | ${r.role} | ${r.shape} | peers=${peers} | tests=${r.tests.size} | calls=${r.calls}`);
    if (process.env.HARNESS_VERBOSE) {
      const names = [...r.tests].sort().join('; ');
      console.log(`    tests: ${names}`);
    }
  }

  if (process.env.PROVIDER_COVERAGE_JSON) {
    const outPath = path.join(__dirname, process.env.PROVIDER_COVERAGE_JSON);
    const payload = rows.map(r => ({
      provider: r.provider,
      role: r.role,
      shape: r.shape,
      peers: r.peers,
      testCount: r.tests.size,
      calls: r.calls,
      tests: [...r.tests].sort(),
    }));
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log(`\nProvider coverage written to ${outPath}`);
  }
}

function loadAssessmentOverrides() {
  const configured = process.env.TEST_ASSESSMENT_FILE || path.join(__dirname, 'fixtures', 'expand-v2-assessment-status.json');
  const filePath = path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  if (!fs.existsSync(filePath)) {
    return new Map();
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rows = Array.isArray(raw) ? raw : Object.entries(raw).map(([name, meta]) => ({ name, ...meta }));
  const map = new Map();
  for (const row of rows) {
    if (!row || !row.name) continue;
    map.set(row.name, row);
  }
  _assessmentSourcePath = filePath;
  return map;
}

const _assessmentOverrides = loadAssessmentOverrides();

function normalizeAssessment(meta = {}) {
  const status = (meta.status || 'pending').toLowerCase();
  if (!['pending', 'assessed', 'n/a'].includes(status)) {
    throw new Error(`Invalid assessment status '${meta.status}'`);
  }
  return {
    status,
    assessedAt: meta.assessedAt || null,
    source: meta.source || null,
    notes: meta.notes || null,
  };
}

function printAssessmentStatusReport(results) {
  const executed = new Set(results.map(r => r.name));
  const executedRows = tests
    .filter(t => executed.has(t.name))
    .map(t => ({ name: t.name, ...t.assessment }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const counts = { pending: 0, assessed: 0, 'n/a': 0 };
  for (const r of executedRows) counts[r.status] = (counts[r.status] || 0) + 1;

  console.log('\nDesign-time assessment status (executed tests):');
  console.log(`  - pending: ${counts.pending}`);
  console.log(`  - assessed: ${counts.assessed}`);
  console.log(`  - n/a: ${counts['n/a']}`);
  if (_assessmentSourcePath) {
    console.log(`  - source: ${_assessmentSourcePath}`);
  }

  const pendingNames = executedRows.filter(r => r.status === 'pending').map(r => r.name);
  if (pendingNames.length > 0) {
    console.log('  - pending tests:');
    for (const name of pendingNames) {
      console.log(`    * ${name}`);
    }
  }

  if (process.env.ASSESSMENT_STATUS_JSON) {
    const outPath = path.isAbsolute(process.env.ASSESSMENT_STATUS_JSON)
      ? process.env.ASSESSMENT_STATUS_JSON
      : path.join(__dirname, process.env.ASSESSMENT_STATUS_JSON);
    fs.writeFileSync(outPath, JSON.stringify(executedRows, null, 2));
    console.log(`\nAssessment status written to ${outPath}`);
  }
}

function flattenContainsKeys(contains, out) {
  for (const c of contains || []) {
    out.push(`${c.system || ''}|${c.version || ''}|${c.code || ''}`);
    if (c.contains) flattenContainsKeys(c.contains, out);
  }
}

function normalizeForParity(result) {
  const keys = [];
  flattenContainsKeys(result?.expansion?.contains || [], keys);
  keys.sort();
  return {
    resourceType: result?.resourceType || null,
    total: result?.expansion?.total ?? null,
    keys,
  };
}

function compareParity(aResult, bResult, aLabel = 'a', bLabel = 'b') {
  const a = normalizeForParity(aResult);
  const b = normalizeForParity(bResult);

  if (a.resourceType !== b.resourceType) {
    return { ok: false, reason: `resourceType mismatch: ${aLabel}=${a.resourceType}, ${bLabel}=${b.resourceType}` };
  }

  if (!deepEqual(a.keys, b.keys)) {
    const max = Math.min(a.keys.length, b.keys.length);
    let firstDiff = -1;
    for (let i = 0; i < max; i++) {
      if (a.keys[i] !== b.keys[i]) {
        firstDiff = i;
        break;
      }
    }
    if (firstDiff === -1 && a.keys.length !== b.keys.length) {
      firstDiff = max;
    }
    const left = a.keys[firstDiff] || '(none)';
    const right = b.keys[firstDiff] || '(none)';
    return {
      ok: false,
      reason: `membership mismatch: ${aLabel}=${a.keys.length}, ${bLabel}=${b.keys.length}, firstDiff=${firstDiff}, ${aLabel}='${left}', ${bLabel}='${right}'`,
    };
  }

  const compareTotal = process.env.PARITY_COMPARE_TOTAL === '1';
  if (compareTotal && a.total !== null && b.total !== null && a.total !== b.total) {
    return { ok: false, reason: `total mismatch: ${aLabel}=${a.total}, ${bLabel}=${b.total}` };
  }

  return { ok: true };
}

/**
 * Run a ValueSet expansion and return { result, trace, ms }.
 *
 * @param {object} vsJson - raw ValueSet JSON (with compose)
 * @param {object} opts
 * @param {string} opts.filter - text search filter
 * @param {number} opts.count - page size
 * @param {number} opts.offset - page offset
 * @param {object[]} opts.txResources - additional CodeSystem/ValueSet resources
 * @param {object[]} opts.params - raw Parameters.parameter entries
 */
async function runExpandWithImpl(impl, vsJson, opts = {}, captureTrace = true) {
  const { ExpandWorker, ValueSetExpander } = getWorkerClasses(impl);
  const opContext = new OperationContext('en', i18n, null, 30);
  const worker = new ExpandWorker(opContext, log, provider, langDefs, i18n);

  // Inject tx-resources if any
  if (opts.txResources) {
    worker.additionalResources = opts.txResources
      .map(res => worker.wrapRawResource ? worker.wrapRawResource(res) : null)
      .filter(Boolean);
  }

  const txp = new TxParameters(langDefs, i18n, false);
  const params = { resourceType: 'Parameters', parameter: [] };
  if (opts.count !== undefined) params.parameter.push({ name: 'count', valueInteger: opts.count });
  if (opts.offset !== undefined) params.parameter.push({ name: 'offset', valueInteger: opts.offset });
  if (opts.filter) params.parameter.push({ name: 'filter', valueString: opts.filter });
  if (Array.isArray(opts.params) && opts.params.length > 0) {
    params.parameter.push(...opts.params);
  }
  txp.readParams(params);

  const vs = new ValueSet(vsJson);
  const searchFilter = new SearchFilterText(opts.filter || null);
  const expander = new ValueSetExpander(worker, txp);

  const t0 = performance.now();
  let result;
  let traceJson = null;

  if (captureTrace) {
    const trace = new ExpandTrace();
    result = await traceStore.run(trace, () => expander.expand(vs, searchFilter, false));
    traceJson = trace.toJSON();
    _lastExpandTrace = traceJson;
    if (result.expansion && process.env.EXPAND_TRACE) {
      trace.attachTo(result.expansion);
    }
  } else {
    result = await expander.expand(vs, searchFilter, false);
  }

  const ms = Math.round(performance.now() - t0);
  return { result, trace: traceJson, ms };
}

async function expand(vsJson, opts = {}) {
  if (EXPAND_IMPL !== 'parity' && EXPAND_IMPL !== 'v2-parity') {
    recordProviderCoverage(vsJson, _currentTestName);
    return runExpandWithImpl(EXPAND_IMPL, vsJson, opts, true);
  }

  if (EXPAND_IMPL === 'parity') {
    recordProviderCoverage(vsJson, _currentTestName);
    const v2 = await runExpandWithImpl('v2', vsJson, opts, true);
    const legacy = await runExpandWithImpl('legacy', vsJson, opts, false);
    const parity = compareParity(v2.result, legacy.result, 'v2', 'legacy');
    if (!parity.ok) {
      throw new Error(`Parity mismatch (${parity.reason})`);
    }
    return v2;
  }

  const v2Pushdown = await runExpandWithImpl('v2', vsJson, opts, true);
  recordProviderCoverage(vsJson, _currentTestName);
  const prev = process.env.EXPAND_V2_DISABLE_PUSHDOWN;
  process.env.EXPAND_V2_DISABLE_PUSHDOWN = '1';
  try {
    const v2Fallback = await runExpandWithImpl('v2', vsJson, opts, false);
    const parity = compareParity(v2Pushdown.result, v2Fallback.result, 'v2-push', 'v2-fallback');
    if (!parity.ok) {
      throw new Error(`V2 parity mismatch (${parity.reason})`);
    }
  } finally {
    if (prev === undefined) delete process.env.EXPAND_V2_DISABLE_PUSHDOWN;
    else process.env.EXPAND_V2_DISABLE_PUSHDOWN = prev;
  }
  return v2Pushdown;
}

// ── ValueSet builder ───────────────────────────────────────────────────────

function vs(include, exclude) {
  return {
    resourceType: 'ValueSet',
    url: `http://test.fhirsmith.org/vs/${Date.now()}`,
    status: 'active',
    compose: {
      include: Array.isArray(include) ? include : [include],
      ...(exclude ? { exclude: Array.isArray(exclude) ? exclude : [exclude] } : {}),
    },
  };
}

// ── Test runner ─────────────────────────────────────────────────────────────

const tests = [];

function test(name, fn, meta = {}) {
  const override = _assessmentOverrides.get(name) || {};
  const assessment = normalizeAssessment({ ...meta, ...override });
  tests.push({ name, fn, assessment });
}

// ── Assertion helpers ──────────────────────────────────────────────────────

/** Assert expansion has valid FHIR structure. */
function assertExpansionStructure(result) {
  assert(result.resourceType === 'ValueSet', `expected ValueSet, got ${result.resourceType}`);
  assert(result.expansion, 'missing expansion');
  assert(result.expansion.timestamp, 'missing expansion.timestamp');
  assert(result.expansion.identifier, 'missing expansion.identifier');
  assert(result.expansion.identifier.startsWith('urn:uuid:'), 'identifier should be a UUID URN');
}

/** Assert each contains entry has required fields. */
function assertContainsShape(contains, expectedSystem) {
  for (const c of contains) {
    assert(c.code, `entry missing code: ${JSON.stringify(c)}`);
    assert(c.system, `entry missing system for code ${c.code}`);
    if (expectedSystem) assert(c.system === expectedSystem, `wrong system for ${c.code}: ${c.system}`);
    assert(typeof c.display === 'string' && c.display.length > 0, `entry ${c.code} missing or empty display`);
  }
}

/** Find a specific code in contains (recursing into hierarchy). */
function findCode(contains, code) {
  for (const c of contains) {
    if (c.code === code) return c;
    if (c.contains) { const f = findCode(c.contains, code); if (f) return f; }
  }
  return undefined;
}

/** Count all codes in a possibly-hierarchical contains array. */
function countAll(arr) {
  return (arr || []).reduce((n, c) => n + 1 + countAll(c.contains), 0);
}

function hasExtension(resource, url) {
  return !!(resource?.extension || []).find(e => e.url === url);
}

function hasProperty(containsEntry, code) {
  return !!(containsEntry?.property || []).find(p => p.code === code);
}

// ── Test definitions ───────────────────────────────────────────────────────

// Shorthand systems
const SYS = {
  SCT:      'http://snomed.info/sct',
  LOINC:    'http://loinc.org',
  RXNORM:   'http://www.nlm.nih.gov/research/umls/rxnorm',
  GENDER:   'http://hl7.org/fhir/administrative-gender',
  PUBSTAT:  'http://hl7.org/fhir/publication-status',
  CVSTAT:   'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  USPS:     'https://www.usps.com/',
  CURRENCY: 'urn:iso:std:iso:4217',
  COUNTRY:  'urn:iso:std:iso:3166',
  M49:      'http://unstats.un.org/unsd/methods/m49/m49.htm',
  LANG:     'urn:ietf:bcp:47',
  MIME:     'urn:ietf:bcp:13',
  OBSCAT:   'http://terminology.hl7.org/CodeSystem/observation-category',
};

// ═══════════════════════════════════════════════════════════════════════════
// Shape A: whole system (no concept, no filter)
// ═══════════════════════════════════════════════════════════════════════════

test('shape-A: US states full expansion (preloaded map)', async () => {
  const { result, ms } = await expand(vs({ system: SYS.USPS }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 62, `expected 62 US state/territory codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.USPS);
  assert(result.expansion.total === 62, `expected total=62, got ${result.expansion.total}`);

  assert(findCode(contains, 'CA')?.display === 'California', 'CA display');
  assert(findCode(contains, 'NY')?.display === 'New York', 'NY display');
  assert(findCode(contains, 'TX')?.display === 'Texas', 'TX display');
  assert(findCode(contains, 'DC'), 'missing DC');
  assert(findCode(contains, 'PR'), 'missing Puerto Rico (PR)');
  assert(findCode(contains, 'GU'), 'missing Guam (GU)');

  return { codes: contains.length, ms };
});

test('shape-A: currency full expansion (preloaded map)', async () => {
  const { result, ms } = await expand(vs({ system: SYS.CURRENCY }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length >= 150, `expected ≥150 currencies, got ${contains.length}`);
  assertContainsShape(contains, SYS.CURRENCY);

  assert(findCode(contains, 'USD')?.display === 'United States dollar', 'USD display');
  assert(findCode(contains, 'EUR')?.display === 'Euro', 'EUR display');
  assert(findCode(contains, 'JPY')?.display === 'Japanese yen', 'JPY display');
  assert(findCode(contains, 'GBP'), 'missing GBP');

  return { codes: contains.length, ms };
});

test('shape-A: administrative-gender (inline FHIR cs-cs)', async () => {
  const { result, ms } = await expand(vs({ system: SYS.GENDER }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 4, `expected 4 gender codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.GENDER);
  assert(result.expansion.total === 4, `expected total=4, got ${result.expansion.total}`);

  assert(findCode(contains, 'male')?.display === 'Male', 'male display');
  assert(findCode(contains, 'female')?.display === 'Female', 'female display');
  assert(findCode(contains, 'other')?.display === 'Other', 'other display');
  assert(findCode(contains, 'unknown')?.display === 'Unknown', 'unknown display');

  return { codes: contains.length, ms };
});

test('shape-A: publication-status (inline FHIR cs-cs)', async () => {
  const { result } = await expand(vs({ system: SYS.PUBSTAT }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 4, `expected 4 pub-status codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.PUBSTAT);

  assert(findCode(contains, 'draft')?.display === 'Draft', 'draft display');
  assert(findCode(contains, 'active')?.display === 'Active', 'active display');
  assert(findCode(contains, 'retired')?.display === 'Retired', 'retired display');
  assert(findCode(contains, 'unknown')?.display === 'Unknown', 'unknown display');
});

test('shape-A: area codes full expansion (preloaded map)', async () => {
  const { result } = await expand(vs({ system: SYS.M49 }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // tx.fhir.org had 270; our data may differ slightly by version
  assert(contains.length >= 260, `expected ≥260 area codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.M49);
  assert(findCode(contains, '001')?.display === 'World', 'World display');
  assert(findCode(contains, '840'), 'missing 840 (US)');
});

// ═══════════════════════════════════════════════════════════════════════════
// Harness infra / edge semantics
// ═══════════════════════════════════════════════════════════════════════════

test('infra: tx-resource injected CodeSystem can be expanded', async () => {
  const csUrl = `http://example.org/cs/colors-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'red', display: 'Red', definition: 'Warm color' },
      { code: 'blue', display: 'Blue', definition: 'Cool color' },
      { code: 'green', display: 'Green', definition: 'Nature color' },
    ],
  };

  const { result } = await expand(vs({ system: csUrl }), { txResources: [cs] });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 3, `expected 3 injected codes, got ${contains.length}`);
  assertContainsShape(contains, csUrl);
  assert(findCode(contains, 'red')?.display === 'Red', 'red display');
  assert(findCode(contains, 'blue')?.display === 'Blue', 'blue display');
  assert(findCode(contains, 'green')?.display === 'Green', 'green display');
});

test('infra: tx-resource injected ValueSet import resolves against injected CodeSystem', async () => {
  const csUrl = `http://example.org/cs/palette-${Date.now()}`;
  const vsUrl = `http://example.org/vs/warm-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'red', display: 'Red' },
      { code: 'orange', display: 'Orange' },
      { code: 'blue', display: 'Blue' },
    ],
  };
  const importedVs = {
    resourceType: 'ValueSet',
    url: vsUrl,
    status: 'active',
    compose: {
      include: [{
        system: csUrl,
        concept: [{ code: 'red' }, { code: 'orange' }],
      }],
    },
  };

  const { result } = await expand(vs({ valueSet: [vsUrl] }), { txResources: [cs, importedVs] });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 imported codes, got ${contains.length}`);
  assertContainsShape(contains, csUrl);
  assert(findCode(contains, 'red'), 'red should be imported');
  assert(findCode(contains, 'orange'), 'orange should be imported');
  assert(!findCode(contains, 'blue'), 'blue should not be imported');
});

test('params: property=definition includes definition property on contains entries', async () => {
  const csUrl = `http://example.org/cs/defs-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'alpha', display: 'Alpha', definition: 'First letter' },
      { code: 'beta', display: 'Beta', definition: 'Second letter' },
    ],
  };

  const { result } = await expand(vs({ system: csUrl }), {
    txResources: [cs],
    params: [{ name: 'property', valueCode: 'definition' }],
  });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 codes, got ${contains.length}`);
  assert(hasProperty(findCode(contains, 'alpha'), 'definition'), 'alpha should include definition property');
  assert(hasProperty(findCode(contains, 'beta'), 'definition'), 'beta should include definition property');
});

test('notClosed: UCUM expansion reports valueset-unclosed extension', async () => {
  const { result } = await expand(vs({ system: 'http://unitsofmeasure.org' }), { count: 20 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'UCUM expansion should return at least one code');
  assert(hasExtension(result.expansion, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed'),
    'UCUM expansion should carry valueset-unclosed extension');
});

// ═══════════════════════════════════════════════════════════════════════════
// Shape B: enumerated concepts
// ═══════════════════════════════════════════════════════════════════════════

test('shape-B: US states enumerated (preloaded map)', async () => {
  const { result } = await expand(vs({
    system: SYS.USPS,
    concept: [{ code: 'CA' }, { code: 'NY' }, { code: 'TX' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 3, `expected 3 codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.USPS);

  assert(findCode(contains, 'CA')?.display === 'California', 'CA display');
  assert(findCode(contains, 'NY')?.display === 'New York', 'NY display');
  assert(findCode(contains, 'TX')?.display === 'Texas', 'TX display');
});

test('shape-B: gender enumerated subset (inline FHIR cs-cs)', async () => {
  const { result } = await expand(vs({
    system: SYS.GENDER,
    concept: [{ code: 'male' }, { code: 'female' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 codes, got ${contains.length}`);
  assert(findCode(contains, 'male')?.display === 'Male', 'male display');
  assert(findCode(contains, 'female')?.display === 'Female', 'female display');
  assert(!findCode(contains, 'other'), 'other must not appear');
  assert(!findCode(contains, 'unknown'), 'unknown must not appear');
});

test('shape-B: SNOMED enumerated (v0 pushdown)', async () => {
  const { result, trace, ms } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 3, `expected 3 SNOMED codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.SCT);

  assert(findCode(contains, '73211009')?.display === 'Diabetes mellitus', '73211009 display');
  assert(findCode(contains, '44054006')?.display === 'Diabetes mellitus type II', '44054006 display');
  assert(findCode(contains, '46635009')?.display === 'Diabetes mellitus type I', '46635009 display');

  return { codes: contains.length, ms };
});

test('shape-B: LOINC enumerated (v0 pushdown)', async () => {
  const { result, ms } = await expand(vs({
    system: SYS.LOINC,
    concept: [{ code: '2160-0' }, { code: '2345-7' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 LOINC codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.LOINC);

  assert(findCode(contains, '2160-0')?.display?.includes('Creatinine'), '2160-0 should mention Creatinine');
  assert(findCode(contains, '2345-7')?.display?.includes('Glucose'), '2345-7 should mention Glucose');

  return { codes: contains.length, ms };
});

test('shape-B: RxNorm enumerated (v0 pushdown)', async () => {
  const { result, ms } = await expand(vs({
    system: SYS.RXNORM,
    concept: [{ code: '161' }, { code: '5640' }, { code: '1191' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 3, `expected 3 RxNorm codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.RXNORM);

  assert(findCode(contains, '161')?.display === 'acetaminophen', '161 display');
  assert(findCode(contains, '5640')?.display === 'ibuprofen', '5640 display');
  assert(findCode(contains, '1191')?.display === 'aspirin', '1191 display');

  return { codes: contains.length, ms };
});

test('shape-B: enumerated with user-supplied display override', async () => {
  const { result } = await expand(vs({
    system: SYS.GENDER,
    concept: [
      { code: 'male', display: 'Masculin' },
      { code: 'female', display: 'Féminin' },
    ],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2, got ${contains.length}`);
  // Display override from compose should be used
  const male = findCode(contains, 'male');
  assert(male, 'missing male');
  // Server may use the compose display or the CS display — check either
  assert(male.display === 'Masculin' || male.display === 'Male',
    `male display should be 'Masculin' or 'Male', got '${male.display}'`);
});

test('shape-B: single concept exact match (v0)', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 1, `expected exactly 1, got ${contains.length}`);
  assert(contains[0].code === '73211009', 'wrong code');
  assert(contains[0].display === 'Diabetes mellitus', 'wrong display');
  assert(contains[0].system === SYS.SCT, 'wrong system');
});

test('shape-B: language codes enumerated (internal:lang)', async () => {
  const { result } = await expand(vs({
    system: SYS.LANG,
    concept: [{ code: 'en' }, { code: 'fr-CA' }, { code: 'zh-Hant' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 3, `expected 3 language codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.LANG);
  assert(findCode(contains, 'en'), 'missing en');
  assert(findCode(contains, 'fr-CA'), 'missing fr-CA');
  assert(findCode(contains, 'zh-Hant'), 'missing zh-Hant');
});

test('shape-B: MIME types enumerated (internal:mimetypes)', async () => {
  const { result } = await expand(vs({
    system: SYS.MIME,
    concept: [{ code: 'text/html' }, { code: 'application/json' }, { code: 'application/fhir+json' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 3, `expected 3 mime types, got ${contains.length}`);
  assertContainsShape(contains, SYS.MIME);
  assert(findCode(contains, 'text/html'), 'missing text/html');
  assert(findCode(contains, 'application/json'), 'missing application/json');
  assert(findCode(contains, 'application/fhir+json'), 'missing application/fhir+json');
});

// ═══════════════════════════════════════════════════════════════════════════
// Shape C: filters
// ═══════════════════════════════════════════════════════════════════════════

// ── Property filters ────────────────────────────────────────────────────

test('filter: area codes class=region (property =)', async () => {
  const { result } = await expand(vs({
    system: SYS.M49,
    filter: [{ property: 'class', op: '=', value: 'region' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 29, `expected 29 regions, got ${contains.length}`);
  assertContainsShape(contains, SYS.M49);

  assert(findCode(contains, '001')?.display === 'World', '001=World');
  assert(findCode(contains, '002'), 'missing 002 (Africa)');
  assert(findCode(contains, '150'), 'missing 150 (Europe)');
  assert(findCode(contains, '019'), 'missing 019 (Americas)');
});

test('filter: area codes class=country (property =)', async () => {
  const { result } = await expand(vs({
    system: SYS.M49,
    filter: [{ property: 'class', op: '=', value: 'country' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // tx.fhir.org: 270 total - 29 regions ≈ 241 countries; ours may differ
  assert(contains.length >= 230, `expected ≥230 countries, got ${contains.length}`);
  // No region codes
  assert(!findCode(contains, '001'), 'World is a region, not a country');
  assert(!findCode(contains, '002'), 'Africa is a region, not a country');
  assert(findCode(contains, '840'), 'missing 840 (United States)');
});

test('filter: currency decimals=0 (property =)', async () => {
  const { result } = await expand(vs({
    system: SYS.CURRENCY,
    filter: [{ property: 'decimals', op: '=', value: '0' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // 18 known zero-decimal currencies (confirmed by cs-currency.js data)
  assert(contains.length === 18, `expected 18 zero-decimal currencies, got ${contains.length}`);
  assertContainsShape(contains, SYS.CURRENCY);

  const expected0dec = ['BIF','CLP','CVE','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF'];
  for (const code of expected0dec) {
    assert(findCode(contains, code), `missing zero-decimal currency: ${code}`);
  }
  assert(!findCode(contains, 'USD'), 'USD has decimals=2, should not appear');
  assert(!findCode(contains, 'EUR'), 'EUR has decimals=2, should not appear');
});

// ── Regex filter ────────────────────────────────────────────────────────

test('filter: country code regex A.* (cs-country)', async () => {
  // A.* works whether regex is anchored or not — matches codes starting with A
  const { result } = await expand(vs({
    system: SYS.COUNTRY,
    filter: [{ property: 'code', op: 'regex', value: 'A.*' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 10, `expected >10 A-codes (alpha-2+alpha-3), got ${contains.length}`);
  assertContainsShape(contains, SYS.COUNTRY);
  assert(contains.every(c => c.code.startsWith('A')), 'all codes must start with A');
  assert(findCode(contains, 'AU'), 'missing AU');
  assert(findCode(contains, 'AT'), 'missing AT');
  assert(findCode(contains, 'AUS'), 'missing AUS (alpha-3)');
  assert(!findCode(contains, 'BR'), 'BR should not match A.*');
  assert(!findCode(contains, 'US'), 'US should not match A.*');
});

test('filter: gender regex [mf].* (inline FHIR cs-cs)', async () => {
  // Use [mf].* which works whether regex is anchored (^...$) or not.
  // tx.fhir.org confirmed: anchored [mf].* matches male+female.
  const { result } = await expand(vs({
    system: SYS.GENDER,
    filter: [{ property: 'code', op: 'regex', value: '[mf].*' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 (male+female), got ${contains.length}`);
  assert(findCode(contains, 'male'), 'missing male');
  assert(findCode(contains, 'female'), 'missing female');
  assert(!findCode(contains, 'other'), 'other should not match');
  assert(!findCode(contains, 'unknown'), 'unknown should not match');
});

// ── is-a / descendent-of filters ────────────────────────────────────────

test('filter: SNOMED is-a diabetes (v0 closure, includes self)', async () => {
  const { result, ms } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // tx.fhir.org confirmed 124 for intl 2025-02 edition
  assert(contains.length >= 100 && contains.length <= 200, `expected ~124 diabetes is-a codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.SCT);

  assert(findCode(contains, '73211009'), 'is-a should include self');
  assert(findCode(contains, '44054006'), 'missing Type 2 diabetes');
  assert(findCode(contains, '46635009'), 'missing Type 1 diabetes');
  assert(contains.every(c => c.display?.length > 0), 'all entries need display');

  return { codes: contains.length, ms };
});

test('filter: SNOMED descendent-of diabetes (v0 closure, excludes self)', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'descendent-of', value: '73211009' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // tx.fhir.org confirmed 123 (124-1 self)
  assert(contains.length >= 99 && contains.length <= 199, `expected ~123 descendants, got ${contains.length}`);
  assert(!findCode(contains, '73211009'), 'descendent-of must exclude self');
  assert(findCode(contains, '44054006'), 'missing Type 2 diabetes');
  assert(findCode(contains, '46635009'), 'missing Type 1 diabetes');
});

test('filter: inline FHIR is-a with hierarchy (condition-ver-status)', async () => {
  // condition-ver-status: unconfirmed → {provisional, differential}
  const { result } = await expand(vs({
    system: SYS.CVSTAT,
    filter: [{ property: 'concept', op: 'is-a', value: 'unconfirmed' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // is-a unconfirmed = self + provisional + differential = 3
  assert(countAll(contains) === 3, `expected 3 (unconfirmed + 2 children), got ${countAll(contains)}`);
  assert(findCode(contains, 'unconfirmed'), 'is-a should include self');
  assert(findCode(contains, 'provisional'), 'missing child: provisional');
  assert(findCode(contains, 'differential'), 'missing child: differential');
  assert(!findCode(contains, 'confirmed'), 'confirmed is not under unconfirmed');
  assert(!findCode(contains, 'refuted'), 'refuted is not under unconfirmed');
});

test('filter: inline FHIR descendent-of (condition-ver-status)', async () => {
  const { result } = await expand(vs({
    system: SYS.CVSTAT,
    filter: [{ property: 'concept', op: 'descendent-of', value: 'unconfirmed' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // descendent-of excludes self → just provisional + differential = 2
  assert(contains.length === 2, `expected 2 descendants, got ${contains.length}`);
  assert(!findCode(contains, 'unconfirmed'), 'descendent-of must exclude self');
  assert(findCode(contains, 'provisional'), 'missing provisional');
  assert(findCode(contains, 'differential'), 'missing differential');
});

test('filter: inline FHIR concept = exact code (cs-cs)', async () => {
  const { result } = await expand(vs({
    system: SYS.GENDER,
    filter: [{ property: 'concept', op: '=', value: 'male' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 1, `expected 1 exact match, got ${contains.length}`);
  assert(contains[0].code === 'male', 'should be male');
  assert(contains[0].display === 'Male', 'display should be Male');
});

test('params: language code includeDesignations yields alternates (internal:lang)', async () => {
  const { result } = await expand(vs({
    system: SYS.LANG,
    concept: [{ code: 'fr-CA' }],
  }), {
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 1, `expected 1 language code, got ${contains.length}`);
  assertContainsShape(contains, SYS.LANG);
  const frCa = findCode(contains, 'fr-CA');
  assert(frCa, 'expected fr-CA');
  assert((frCa.designation || []).length > 0, 'expected alternate designations for fr-CA');
});

test('notClosed: MIME whole-system expansion is not enumerable', async () => {
  let failed = false;
  try {
    await expand(vs({ system: SYS.MIME }));
  } catch (e) {
    failed = true;
    const msg = String(e?.message || '');
    assert(msg.includes('cannot be enumerated') || msg.includes('grammar'),
      `expected non-enumerable grammar failure, got '${msg}'`);
  }
  assert(failed, 'expected mime whole-system expansion to fail');
});

// ── concept-in (refset membership) ──────────────────────────────────────

test('filter: SNOMED concept-in refset (v0 value_set_member)', async () => {
  // Refset 723560006 has 19 active members (top-level SNOMED categories)
  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'in', value: 'http://snomed.info/sct?fhir_vs=refset/723560006' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 19, `expected 19 refset members, got ${contains.length}`);
  assertContainsShape(contains, SYS.SCT);

  // Known members of this refset (top-level SNOMED categories)
  assert(findCode(contains, '404684003'), 'missing Clinical finding');
  assert(findCode(contains, '71388002'), 'missing Procedure');
  assert(findCode(contains, '105590001'), 'missing Substance');
  assert(findCode(contains, '123037004'), 'missing Body structure');
  assert(findCode(contains, '363787002'), 'missing Observable entity');
});

// ── RxNorm property filter ──────────────────────────────────────────────

test('filter: RxNorm TTY=IN property filter (v0 pushdown)', async () => {
  const { result, ms } = await expand(vs({
    system: SYS.RXNORM,
    filter: [{ property: 'TTY', op: '=', value: 'IN' }],
  }), { count: 50 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 50, `expected 50 (count-limited), got ${contains.length}`);
  assertContainsShape(contains, SYS.RXNORM);
  // Total may be full cardinality or a capped/server-estimated value.
  if (result.expansion.total != null) {
    assert(result.expansion.total >= contains.length, `total should be >= page size, got ${result.expansion.total}`);
  }
  // aspirin (1191) is TTY=IN
  // Not guaranteed in first 50, but check structure
  assert(contains.every(c => typeof c.display === 'string' && c.display.length > 0), 'all entries need display');

  return { codes: contains.length, ms };
});

// ── LOINC property filters ──────────────────────────────────────────────

test('filter: LOINC STATUS=ACTIVE (v0 pushdown)', async () => {
  const { result, ms } = await expand(vs({
    system: SYS.LOINC,
    filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }],
  }), { count: 20 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 20, `expected 20, got ${contains.length}`);
  assertContainsShape(contains, SYS.LOINC);
  // Total may be full cardinality or a capped/server-estimated value.
  if (result.expansion.total != null) {
    assert(result.expansion.total >= contains.length, `ACTIVE LOINC total should be >= page size, got ${result.expansion.total}`);
  }

  return { codes: contains.length, ms };
});

// ═══════════════════════════════════════════════════════════════════════════
// Text search (filter parameter)
// ═══════════════════════════════════════════════════════════════════════════

test('text-search: SNOMED filter=diabetes (v0 FTS)', async () => {
  const { result, ms } = await expand(
    vs({ system: SYS.SCT }),
    { filter: 'diabetes', count: 50 }
  );
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'expected diabetes results');
  assert(contains.length <= 50, 'should respect count limit');
  assertContainsShape(contains, SYS.SCT);

  const displays = contains.map(c => c.display.toLowerCase());
  assert(displays.some(d => d.includes('diabet')), 'at least one display should mention diabetes');

  return { codes: contains.length, ms };
});

test('text-search: SNOMED filter=diabetes no pagination (probe bug)', async () => {
  // Without count/offset, the v0 probe sees >1000 matches and returns tooCostly
  // with 0 results. The correct behavior is to return up to 1000 codes.
  const { result } = await expand(
    vs({ system: SYS.SCT }),
    { filter: 'diabetes' }
  );
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // Should get codes, not an empty too-costly rejection
  assert(contains.length > 0, `expected diabetes results without pagination, got ${contains.length} (probe may have rejected as too-costly)`);
  assert(contains.length >= 100, `expected many results, got ${contains.length}`);
  assertContainsShape(contains, SYS.SCT);
});

test('text-search: SNOMED filter + is-a combined', async () => {
  const { result, ms } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }), { filter: 'type', count: 50 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'expected results');
  // All should be descendants of 73211009 AND match "type"
  assertContainsShape(contains, SYS.SCT);
  const displays = contains.map(c => c.display.toLowerCase());
  assert(displays.some(d => d.includes('type')), 'results should match "type"');

  return { codes: contains.length, ms };
});

test('text-search: RxNorm filter=aspirin (v0 FTS)', async () => {
  const { result, ms } = await expand(
    vs({ system: SYS.RXNORM }),
    { filter: 'aspirin', count: 20 }
  );
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'expected aspirin results');
  assert(contains.length <= 20, 'should respect count limit');
  assertContainsShape(contains, SYS.RXNORM);

  const displays = contains.map(c => c.display.toLowerCase());
  assert(displays.some(d => d.includes('aspirin')), 'at least one result should mention aspirin');

  return { codes: contains.length, ms };
});

test('text-search: LOINC filter=creatinine (v0 FTS)', async () => {
  const { result, ms } = await expand(
    vs({ system: SYS.LOINC }),
    { filter: 'creatinine', count: 20 }
  );
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'expected creatinine results');
  assert(contains.length <= 20, 'should respect count limit');
  assertContainsShape(contains, SYS.LOINC);

  const displays = contains.map(c => c.display.toLowerCase());
  assert(displays.some(d => d.includes('creatinine')), 'at least one result should mention creatinine');

  return { codes: contains.length, ms };
});

test('text-search: inline FHIR filter=male (cs-cs searchFilter)', async () => {
  const { result } = await expand(
    vs({ system: SYS.GENDER }),
    { filter: 'male' }
  );
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length >= 1, 'should match at least male');
  assert(findCode(contains, 'male'), 'male should appear');
  // "female" also contains "male" substring — might or might not match
});

test('text-search: multi-system with filter', async () => {
  // Text filter applied across two different systems
  const { result } = await expand(vs([
    { system: SYS.GENDER },
    { system: SYS.PUBSTAT },
  ]), { filter: 'unknown' });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // Both gender and pub-status have "unknown"
  assert(contains.length >= 2, `expected ≥2 matching unknown, got ${contains.length}`);
  const systems = [...new Set(contains.map(c => c.system))];
  assert(systems.length === 2, 'should match from both systems');
});

// ═══════════════════════════════════════════════════════════════════════════
// Excludes
// ═══════════════════════════════════════════════════════════════════════════

// ── Exclude enumerated concepts ─────────────────────────────────────────

test('exclude: gender minus other+unknown (cs-cs)', async () => {
  const { result } = await expand(vs(
    { system: SYS.GENDER },
    { system: SYS.GENDER, concept: [{ code: 'other' }, { code: 'unknown' }] }
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 after excluding 2 from 4, got ${contains.length}`);

  assert(findCode(contains, 'male')?.display === 'Male', 'male should remain');
  assert(findCode(contains, 'female')?.display === 'Female', 'female should remain');
  assert(!findCode(contains, 'other'), 'other must be excluded');
  assert(!findCode(contains, 'unknown'), 'unknown must be excluded');
});

test('exclude: US states subtract 2 from 4 enumerated (preloaded map)', async () => {
  const { result } = await expand(vs(
    { system: SYS.USPS, concept: [{ code: 'CA' }, { code: 'NY' }, { code: 'TX' }, { code: 'FL' }] },
    { system: SYS.USPS, concept: [{ code: 'TX' }, { code: 'FL' }] }
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2, got ${contains.length}`);
  const codes = contains.map(c => c.code).sort();
  assert(deepEqual(codes, ['CA', 'NY']), `expected [CA, NY], got ${codes}`);
});

test('exclude: SNOMED exclude enumerated from is-a (v0)', async () => {
  const { result } = await expand(vs(
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    { system: SYS.SCT, concept: [{ code: '44054006' }, { code: '46635009' }] }
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(!findCode(contains, '44054006'), 'excluded 44054006 must not appear');
  assert(!findCode(contains, '46635009'), 'excluded 46635009 must not appear');
  assert(findCode(contains, '73211009'), 'parent 73211009 should remain');
  assert(contains.length >= 100, `expected ≥100 after excluding only 2 from ~124, got ${contains.length}`);
});

// ── Exclude by filter (subtree) ─────────────────────────────────────────

test('exclude: SNOMED is-a minus Type2 subtree (v0 pushdown)', async () => {
  const { result, ms } = await expand(vs(
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] }
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // tx.fhir.org confirmed 108 for intl 2025; allow range for edition differences
  assert(contains.length >= 90 && contains.length <= 130,
    `expected ~108 (is-a minus Type2 subtree), got ${contains.length}`);

  assert(!findCode(contains, '44054006'), 'Type 2 diabetes must be excluded');
  assert(findCode(contains, '46635009'), 'Type 1 diabetes should remain');
  assert(findCode(contains, '73211009'), 'parent should remain');

  return { codes: contains.length, ms };
});

test('exclude: SNOMED is-a minus Type1 subtree (v0 pushdown)', async () => {
  const { result } = await expand(vs(
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '46635009' }] }
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // tx.fhir.org confirmed 102 for intl 2025; allow range for edition differences
  assert(contains.length >= 80 && contains.length <= 130,
    `expected ~102 (is-a minus Type1 subtree), got ${contains.length}`);
  assert(!findCode(contains, '46635009'), 'Type 1 diabetes must be excluded');
  assert(findCode(contains, '44054006'), 'Type 2 diabetes should remain');
  assert(findCode(contains, '73211009'), 'parent should remain');
});

test('exclude: inline FHIR filter-based exclude (condition-ver-status)', async () => {
  // Include all, exclude is-a unconfirmed (unconfirmed + provisional + differential)
  const { result } = await expand(vs(
    { system: SYS.CVSTAT },
    { system: SYS.CVSTAT, filter: [{ property: 'concept', op: 'is-a', value: 'unconfirmed' }] }
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // 6 total - 3 (unconfirmed+children) = 3 (confirmed, refuted, entered-in-error)
  assert(contains.length === 3, `expected 3 after excluding unconfirmed subtree, got ${contains.length}`);
  assert(!findCode(contains, 'unconfirmed'), 'unconfirmed must be excluded');
  assert(!findCode(contains, 'provisional'), 'provisional must be excluded (child of unconfirmed)');
  assert(!findCode(contains, 'differential'), 'differential must be excluded (child of unconfirmed)');
  assert(findCode(contains, 'confirmed'), 'confirmed should remain');
  assert(findCode(contains, 'refuted'), 'refuted should remain');
  assert(findCode(contains, 'entered-in-error'), 'entered-in-error should remain');
});

// ── Cross-system exclude ────────────────────────────────────────────────

test('exclude: cross-system multi-exclude (gender + pub-status minus unknowns)', async () => {
  const { result } = await expand(vs(
    [
      { system: SYS.GENDER },
      { system: SYS.PUBSTAT },
    ],
    [
      { system: SYS.GENDER, concept: [{ code: 'unknown' }] },
      { system: SYS.PUBSTAT, concept: [{ code: 'unknown' }] },
    ]
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // 4 gender + 4 pub-status - 1 unknown(gender) - 1 unknown(pub) = 6
  assert(contains.length === 6, `expected 6, got ${contains.length}`);

  const genderCodes = contains.filter(c => c.system === SYS.GENDER);
  const pubCodes = contains.filter(c => c.system === SYS.PUBSTAT);
  assert(genderCodes.length === 3, `expected 3 gender codes, got ${genderCodes.length}`);
  assert(pubCodes.length === 3, `expected 3 pub-status codes, got ${pubCodes.length}`);

  assert(findCode(contains, 'male'), 'male should remain');
  assert(findCode(contains, 'female'), 'female should remain');
  assert(findCode(contains, 'other'), 'other should remain');
  assert(findCode(contains, 'draft'), 'draft should remain');
  assert(findCode(contains, 'active'), 'active should remain');
  assert(findCode(contains, 'retired'), 'retired should remain');
  // Neither unknown should be present
  assert(!contains.some(c => c.code === 'unknown'), 'no unknown codes should remain');
});

test('exclude: exclude from whole system (preloaded map)', async () => {
  // Include all US states, exclude specific territories
  const { result } = await expand(vs(
    { system: SYS.USPS },
    { system: SYS.USPS, concept: [{ code: 'PR' }, { code: 'GU' }, { code: 'VI' }, { code: 'AS' }, { code: 'MP' }] }
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 57, `expected 62-5=57, got ${contains.length}`);
  assert(!findCode(contains, 'PR'), 'PR must be excluded');
  assert(!findCode(contains, 'GU'), 'GU must be excluded');
  assert(findCode(contains, 'CA'), 'CA should remain');
  assert(findCode(contains, 'DC'), 'DC should remain');
});

// ═══════════════════════════════════════════════════════════════════════════
// Pagination
// ═══════════════════════════════════════════════════════════════════════════

test('pagination: currency count=10 offset=0', async () => {
  const { result } = await expand(vs({ system: SYS.CURRENCY }), { count: 10 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 10, `expected 10, got ${contains.length}`);
  if (result.expansion.total != null) {
    assert(result.expansion.total >= contains.length, `total should be >= page size, got ${result.expansion.total}`);
  }
});

test('pagination: US states disjoint pages', async () => {
  const { result: r1 } = await expand(vs({ system: SYS.USPS }), { count: 10, offset: 0 });
  const { result: r2 } = await expand(vs({ system: SYS.USPS }), { count: 10, offset: 10 });
  const { result: r3 } = await expand(vs({ system: SYS.USPS }), { count: 10, offset: 20 });

  const c1 = (r1.expansion.contains || []).map(c => c.code);
  const c2 = (r2.expansion.contains || []).map(c => c.code);
  const c3 = (r3.expansion.contains || []).map(c => c.code);

  assert(c1.length === 10 && c2.length === 10 && c3.length === 10, 'each page should have 10');

  const all = [...c1, ...c2, ...c3];
  assert(new Set(all).size === 30, '3 pages should produce 30 unique codes');

  if (r1.expansion.total != null && r2.expansion.total != null) {
    assert(r1.expansion.total >= c1.length, 'page 1 total should be >= page size');
    assert(r2.expansion.total >= c2.length, 'page 2 total should be >= page size');
  }
});

test('pagination: US states last page partial', async () => {
  const { result } = await expand(vs({ system: SYS.USPS }), { count: 10, offset: 60 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 remaining (62-60), got ${contains.length}`);
  assert(result.expansion.total === 62, `total should be 62, got ${result.expansion.total}`);
});

test('pagination: US states offset beyond end', async () => {
  const { result } = await expand(vs({ system: SYS.USPS }), { count: 10, offset: 100 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 0, `expected 0 past end, got ${contains.length}`);
  assert(result.expansion.total === 62, `total should still be 62, got ${result.expansion.total}`);
});

test('pagination: SNOMED is-a paginated (v0)', async () => {
  const f = [{ property: 'concept', op: 'is-a', value: '73211009' }];
  const { result: r1 } = await expand(vs({ system: SYS.SCT, filter: f }), { count: 20, offset: 0 });
  const { result: r2 } = await expand(vs({ system: SYS.SCT, filter: f }), { count: 20, offset: 20 });

  const c1 = (r1.expansion.contains || []).map(c => c.code);
  const c2 = (r2.expansion.contains || []).map(c => c.code);

  assert(c1.length === 20, `page 1: expected 20, got ${c1.length}`);
  assert(c2.length === 20, `page 2: expected 20, got ${c2.length}`);

  const overlap = c1.filter(c => c2.includes(c));
  assert(overlap.length === 0, `pages must not overlap: ${overlap}`);

  if (r1.expansion.total != null) {
    assert(r1.expansion.total >= 100, `total should be ≥100, got ${r1.expansion.total}`);
  }
});

test('pagination: count=0 returns total only', async () => {
  const { result } = await expand(vs({ system: SYS.USPS }), { count: 0 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 0, `count=0 should return no codes, got ${contains.length}`);
  assert(result.expansion.total === 62, `total should still be 62, got ${result.expansion.total}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Multi-system compose (union)
// ═══════════════════════════════════════════════════════════════════════════

test('multi-system: gender + US states union', async () => {
  const { result } = await expand(vs([
    { system: SYS.GENDER },
    { system: SYS.USPS, concept: [{ code: 'CA' }, { code: 'NY' }] },
  ]));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 6, `expected 4+2=6, got ${contains.length}`);

  const systems = [...new Set(contains.map(c => c.system))];
  assert(systems.length === 2, `expected 2 systems, got ${systems.length}`);
  assert(findCode(contains, 'male')?.display === 'Male', 'male display');
  assert(findCode(contains, 'CA')?.display === 'California', 'CA display');
});

test('multi-system: SNOMED + gender (mixed v0 + cs-cs)', async () => {
  const { result } = await expand(vs([
    { system: SYS.SCT, concept: [{ code: '73211009' }] },
    { system: SYS.GENDER, concept: [{ code: 'male' }] },
  ]));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2, got ${contains.length}`);
  assert(findCode(contains, '73211009')?.display === 'Diabetes mellitus', 'SNOMED display');
  assert(findCode(contains, 'male')?.display === 'Male', 'gender display');
});

test('multi-system: three systems (SNOMED + LOINC + RxNorm)', async () => {
  const { result } = await expand(vs([
    { system: SYS.SCT, concept: [{ code: '73211009' }] },
    { system: SYS.LOINC, concept: [{ code: '2160-0' }] },
    { system: SYS.RXNORM, concept: [{ code: '1191' }] },
  ]));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 3, `expected 3, got ${contains.length}`);

  const systems = [...new Set(contains.map(c => c.system))];
  assert(systems.length === 3, `expected 3 different systems, got ${systems.length}`);

  assert(findCode(contains, '73211009')?.display === 'Diabetes mellitus', 'SNOMED');
  assert(findCode(contains, '2160-0')?.display?.includes('Creatinine'), 'LOINC');
  assert(findCode(contains, '1191')?.display === 'aspirin', 'RxNorm');
});

test('multi-system: v0 filter + preloaded whole system + cs-cs enumerated', async () => {
  const { result } = await expand(vs([
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    { system: SYS.USPS },
    { system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] },
  ]));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // SNOMED is-a (~124) + 62 US states + 2 gender
  assert(contains.length >= 164, `expected ≥164 (is-a + 62 + 2), got ${contains.length}`);

  const systems = [...new Set(contains.map(c => c.system))];
  assert(systems.length === 3, `expected 3 systems, got ${systems.length}`);
});

test('multi-system: same system in two include components (union, dedup)', async () => {
  // Two include components for gender — codes should be unioned (no duplicates)
  const { result } = await expand(vs([
    { system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] },
    { system: SYS.GENDER, concept: [{ code: 'female' }, { code: 'other' }] },
  ]));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // male + female + other = 3 (female deduplicated)
  assert(contains.length === 3, `expected 3 (deduped), got ${contains.length}`);
  assert(findCode(contains, 'male'), 'male');
  assert(findCode(contains, 'female'), 'female');
  assert(findCode(contains, 'other'), 'other');
  assert(!findCode(contains, 'unknown'), 'unknown not in either include');
});

// ═══════════════════════════════════════════════════════════════════════════
// ValueSet imports (intersection semantics)
// ═══════════════════════════════════════════════════════════════════════════

test('vs-import: pure import of administrative-gender VS', async () => {
  const { result } = await expand(vs({
    valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 4, `expected 4 gender codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.GENDER);
  assert(findCode(contains, 'male'), 'male');
  assert(findCode(contains, 'female'), 'female');
  assert(findCode(contains, 'other'), 'other');
  assert(findCode(contains, 'unknown'), 'unknown');
});

test('vs-import: system + valueSet intersection (shape D)', async () => {
  // Include SNOMED concepts that are also in the diabetes is-a ValueSet
  // Enumerated concepts intersected with a ValueSet
  const { result } = await expand(vs({
    system: SYS.GENDER,
    concept: [{ code: 'male' }, { code: 'female' }, { code: 'other' }],
    valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // All 3 are in the gender VS, so intersection = 3
  assert(contains.length === 3, `expected 3, got ${contains.length}`);
  assert(findCode(contains, 'male'), 'male in intersection');
  assert(findCode(contains, 'female'), 'female in intersection');
  assert(findCode(contains, 'other'), 'other in intersection');
});

// ═══════════════════════════════════════════════════════════════════════════
// Combined filters on same system
// ═══════════════════════════════════════════════════════════════════════════

test('combined: SNOMED is-a + text filter (v0)', async () => {
  // is-a diabetes + text filter "insulin"
  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }), { filter: 'insulin' });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'expected results for diabetes + insulin');
  // All results should be descendants of diabetes AND match "insulin"
  assertContainsShape(contains, SYS.SCT);
  const displays = contains.map(c => c.display.toLowerCase());
  assert(displays.some(d => d.includes('insulin')), 'should include insulin-related results');
});

test('combined: include filter + exclude filter same system (v0)', async () => {
  // Include: is-a 73211009 (124 codes)
  // Exclude: both Type 1 subtree (22) and Type 2 subtree (16)
  const { result } = await expand(vs(
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    [
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '46635009' }] },
    ]
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // tx.fhir.org confirmed 86 for intl 2025; allow range for edition differences
  assert(contains.length >= 70 && contains.length <= 100,
    `expected ~86 (is-a minus Type1+Type2), got ${contains.length}`);
  assert(!findCode(contains, '44054006'), 'Type 2 excluded');
  assert(!findCode(contains, '46635009'), 'Type 1 excluded');
  assert(findCode(contains, '73211009'), 'parent should remain');
});

test('combined: enumerated + text filter (v0)', async () => {
  // Give a concept list and apply text filter — only matching concepts returned
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }],
  }), { filter: 'type' });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // Only "type I" and "type II" match "type" — 73211009 "Diabetes mellitus" doesn't
  assert(contains.length >= 1 && contains.length <= 3, `expected 1-3 with type filter, got ${contains.length}`);
  if (findCode(contains, '73211009')) {
    // OK if server doesn't filter enumerated by text
  } else {
    assert(findCode(contains, '44054006') || findCode(contains, '46635009'), 'at least one type should match');
  }
});

test('combined: multi-system + exclude + pagination', async () => {
  // Complex: SNOMED filter + gender, exclude some, paginate
  const { result } = await expand(vs(
    [
      { system: SYS.GENDER },
      { system: SYS.USPS, concept: [{ code: 'CA' }, { code: 'NY' }, { code: 'TX' }] },
    ],
    { system: SYS.GENDER, concept: [{ code: 'unknown' }] }
  ), { count: 5, offset: 0 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // Total should be 3 gender + 3 states = 6
  assert(result.expansion.total === 6, `expected total=6, got ${result.expansion.total}`);
  assert(contains.length === 5, `expected 5 (page 1 of 6), got ${contains.length}`);
  assert(!contains.some(c => c.code === 'unknown' && c.system === SYS.GENDER), 'unknown excluded');
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider-specific architecture tests
// ═══════════════════════════════════════════════════════════════════════════

test('provider: preloaded map iteration (currency full + filter)', async () => {
  // First full, then filtered — tests both paths
  const { result: full } = await expand(vs({ system: SYS.CURRENCY }));
  const { result: filtered } = await expand(vs({
    system: SYS.CURRENCY,
    filter: [{ property: 'decimals', op: '=', value: '2' }],
  }));
  const fullCount = (full.expansion.contains || []).length;
  const filteredCount = (filtered.expansion.contains || []).length;
  assert(filteredCount > 50, `expected >50 two-decimal currencies, got ${filteredCount}`);
  assert(filteredCount < fullCount, 'filtered should be subset of full');
  // Verify mutual exclusivity with decimals=0
  const { result: zero } = await expand(vs({
    system: SYS.CURRENCY,
    filter: [{ property: 'decimals', op: '=', value: '0' }],
  }));
  const zeroCount = (zero.expansion.contains || []).length;
  // decimals=0 and decimals=2 should be disjoint
  const zeroCodes = new Set((zero.expansion.contains || []).map(c => c.code));
  const filteredCodes = (filtered.expansion.contains || []).map(c => c.code);
  const overlap = filteredCodes.filter(c => zeroCodes.has(c));
  assert(overlap.length === 0, `decimals=0 and decimals=2 should not overlap: ${overlap.slice(0, 5)}`);
});

test('provider: cs-cs hierarchy iteration (condition-ver-status)', async () => {
  const { result } = await expand(vs({ system: SYS.CVSTAT }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  // 6 codes total: unconfirmed, provisional, differential, confirmed, refuted, entered-in-error
  assert(countAll(contains) === 6, `expected 6 condition-ver-status codes, got ${countAll(contains)}`);
  assertContainsShape(contains, SYS.CVSTAT);

  assert(findCode(contains, 'unconfirmed')?.display === 'Unconfirmed', 'unconfirmed display');
  assert(findCode(contains, 'provisional')?.display === 'Provisional', 'provisional display');
  assert(findCode(contains, 'differential')?.display === 'Differential', 'differential display');
  assert(findCode(contains, 'confirmed')?.display === 'Confirmed', 'confirmed display');
  assert(findCode(contains, 'refuted')?.display === 'Refuted', 'refuted display');
  assert(findCode(contains, 'entered-in-error')?.display === 'Entered in Error', 'entered-in-error display');
});

test('provider: v0 SNOMED large is-a with pagination consistency', async () => {
  // Expand full is-a, then reconstruct from pages — should match
  const { result: full } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }));
  const fullCodes = new Set((full.expansion.contains || []).map(c => c.code));

  // Paginate through all
  const allPaged = [];
  for (let off = 0; off < 200; off += 30) {
    const { result: page } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    }), { count: 30, offset: off });
    const codes = (page.expansion.contains || []).map(c => c.code);
    if (codes.length === 0) break;
    allPaged.push(...codes);
  }

  assert(allPaged.length === fullCodes.size,
    `paged total ${allPaged.length} should match full ${fullCodes.size}`);
  const pagedSet = new Set(allPaged);
  assert(pagedSet.size === allPaged.length, 'no duplicates across pages');
  for (const code of fullCodes) {
    assert(pagedSet.has(code), `code ${code} in full but missing from pages`);
  }
});

test('provider: v0 RxNorm text search + property filter combined', async () => {
  // RxNorm: text=aspirin AND TTY=IN (ingredients only)
  const { result } = await expand(vs({
    system: SYS.RXNORM,
    filter: [{ property: 'TTY', op: '=', value: 'IN' }],
  }), { filter: 'aspirin', count: 20 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'should have aspirin ingredients');
  assert(contains.length <= 20, 'respect count');
  assertContainsShape(contains, SYS.RXNORM);

  // 1191 (aspirin) is TTY=IN, should appear
  assert(findCode(contains, '1191'), 'aspirin 1191 should appear (TTY=IN)');
  // 611 (aluminum aspirin) is also TTY=IN
  const displays = contains.map(c => c.display.toLowerCase());
  assert(displays.every(d => d.includes('aspirin')), 'all should match aspirin text filter');
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider/shape/peer-context coverage expansion
// ═══════════════════════════════════════════════════════════════════════════

test('coverage: UCUM whole-system with language peer include', async () => {
  const { result } = await expand(vs([
    { system: 'http://unitsofmeasure.org' },
    { system: SYS.LANG, concept: [{ code: 'en' }] },
  ]));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(findCode(contains, 'en')?.system === SYS.LANG, 'language peer code should be present');
  assert(contains.length >= 1, 'expected at least peer concept in mixed UCUM expansion');
});

test('coverage: MIME concept include with language peer include', async () => {
  const { result } = await expand(vs([
    { system: SYS.MIME, concept: [{ code: 'application/json' }] },
    { system: SYS.LANG, concept: [{ code: 'fr' }] },
  ]));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(findCode(contains, 'fr')?.system === SYS.LANG, 'language peer code should be present');
  assert(findCode(contains, 'application/json')?.system === SYS.MIME, 'MIME peer code should be present');
});

test('coverage: tx-resource whole include with cs-cs peer', async () => {
  const csUrl = `http://example.org/cs/shapes-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'circle', display: 'Circle' },
      { code: 'square', display: 'Square' },
    ],
  };
  const { result } = await expand(vs([
    { system: csUrl },
    { system: SYS.GENDER, concept: [{ code: 'female' }] },
  ]), { txResources: [cs] });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 3, `expected 3 codes, got ${contains.length}`);
  assert(findCode(contains, 'circle')?.system === csUrl, 'circle from tx-resource');
  assert(findCode(contains, 'square')?.system === csUrl, 'square from tx-resource');
  assert(findCode(contains, 'female')?.system === SYS.GENDER, 'female from cs-cs peer');
});

test('coverage: tx-resource concept include + exclude with cs-cs peer', async () => {
  const csUrl = `http://example.org/cs/colors-mixed-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'red', display: 'Red' },
      { code: 'blue', display: 'Blue' },
      { code: 'green', display: 'Green' },
    ],
  };
  const { result } = await expand(vs(
    [
      { system: csUrl, concept: [{ code: 'red' }, { code: 'blue' }, { code: 'green' }] },
      { system: SYS.GENDER, concept: [{ code: 'male' }] },
    ],
    { system: csUrl, concept: [{ code: 'blue' }] }
  ), { txResources: [cs] });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 3, `expected 3 codes after exclusion, got ${contains.length}`);
  assert(findCode(contains, 'red')?.system === csUrl, 'red should remain');
  assert(findCode(contains, 'green')?.system === csUrl, 'green should remain');
  assert(!findCode(contains, 'blue'), 'blue should be excluded');
  assert(findCode(contains, 'male')?.system === SYS.GENDER, 'male from peer');
});

test('coverage: valueset-import include with USPS peer include', async () => {
  const { result } = await expand(vs([
    { valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'] },
    { system: SYS.USPS, concept: [{ code: 'CA' }] },
  ]));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 5, `expected 5 codes (4 gender + CA), got ${contains.length}`);
  assert(findCode(contains, 'male')?.system === SYS.GENDER, 'male present via imported ValueSet');
  assert(findCode(contains, 'CA')?.system === SYS.USPS, 'CA present via USPS peer');
});

test('coverage: valueset-import include with USPS peer and USPS exclude', async () => {
  const { result } = await expand(vs(
    [
      { valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'] },
      { system: SYS.USPS, concept: [{ code: 'CA' }, { code: 'NY' }] },
    ],
    { system: SYS.USPS, concept: [{ code: 'NY' }] }
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 5, `expected 5 codes (4 gender + CA), got ${contains.length}`);
  assert(findCode(contains, 'male')?.system === SYS.GENDER, 'male present');
  assert(findCode(contains, 'CA')?.system === SYS.USPS, 'CA present');
  assert(!findCode(contains, 'NY'), 'NY excluded');
});

test('coverage: country regex filter with cs-cs peer include', async () => {
  const { result } = await expand(vs([
    { system: SYS.COUNTRY, filter: [{ property: 'code', op: 'regex', value: 'A.*' }] },
    { system: SYS.GENDER, concept: [{ code: 'male' }] },
  ]));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(findCode(contains, 'male')?.system === SYS.GENDER, 'male peer code should be present');
  const countryMatches = contains.filter(c => c.system === SYS.COUNTRY);
  assert(countryMatches.length > 0, 'expected regex-filtered country results');
});

test('coverage: areacode class filter with cs-cs include/exclude peer', async () => {
  const { result } = await expand(vs(
    [
      { system: SYS.M49, filter: [{ property: 'class', op: '=', value: 'region' }] },
      { system: SYS.GENDER, concept: [{ code: 'unknown' }] },
    ],
    { system: SYS.GENDER, concept: [{ code: 'unknown' }] }
  ));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(!contains.some(c => c.system === SYS.GENDER && c.code === 'unknown'),
    'unknown should be excluded from peer component');
  const regions = contains.filter(c => c.system === SYS.M49);
  assert(regions.length > 0, 'expected area-code region results');
});

// ═══════════════════════════════════════════════════════════════════════════
// Pagination safety across mixed providers / mixed execution modes
// ═══════════════════════════════════════════════════════════════════════════

test('pagination-safety: mixed v0 + cs-cs include/exclude reconstructs full set', async () => {
  const query = vs(
    [
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: SYS.GENDER },
    ],
    [
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
      { system: SYS.GENDER, concept: [{ code: 'unknown' }] },
    ]
  );

  const { result: full } = await expand(query);
  const fullKeys = [];
  flattenContainsKeys(full.expansion.contains || [], fullKeys);
  const fullSet = new Set(fullKeys);

  const pageSize = 17;
  const pagedKeys = [];
  for (let off = 0; off < fullSet.size + pageSize * 4; off += pageSize) {
    const { result: page } = await expand(query, { count: pageSize, offset: off });
    const keys = [];
    flattenContainsKeys(page.expansion.contains || [], keys);
    if (keys.length === 0) break;
    pagedKeys.push(...keys);
  }

  const pagedSet = new Set(pagedKeys);
  assert(pagedKeys.length === pagedSet.size, 'paged reconstruction should not duplicate codes');
  assert(pagedSet.size === fullSet.size,
    `paged size ${pagedSet.size} should match full size ${fullSet.size}`);
  for (const k of fullSet) {
    assert(pagedSet.has(k), `missing key from paged reconstruction: ${k}`);
  }
});

test('pagination-safety: mixed v0 + preloaded include/exclude reconstructs full set', async () => {
  const query = vs(
    [
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: SYS.USPS },
    ],
    [
      { system: SYS.SCT, concept: [{ code: '44054006' }, { code: '46635009' }] },
      { system: SYS.USPS, concept: [{ code: 'PR' }, { code: 'GU' }, { code: 'VI' }, { code: 'AS' }, { code: 'MP' }] },
    ]
  );

  const { result: full } = await expand(query);
  const fullKeys = [];
  flattenContainsKeys(full.expansion.contains || [], fullKeys);
  const fullSet = new Set(fullKeys);

  const pageSize = 23;
  const pagedKeys = [];
  for (let off = 0; off < fullSet.size + pageSize * 4; off += pageSize) {
    const { result: page } = await expand(query, { count: pageSize, offset: off });
    const keys = [];
    flattenContainsKeys(page.expansion.contains || [], keys);
    if (keys.length === 0) break;
    pagedKeys.push(...keys);
  }

  const pagedSet = new Set(pagedKeys);
  assert(pagedKeys.length === pagedSet.size, 'paged reconstruction should not duplicate codes');
  assert(pagedSet.size === fullSet.size,
    `paged size ${pagedSet.size} should match full size ${fullSet.size}`);
  for (const k of fullSet) {
    assert(pagedSet.has(k), `missing key from paged reconstruction: ${k}`);
  }
});

test('pagination-safety: valueset-import peer with excludes reconstructs full set', async () => {
  const query = vs(
    [
      { valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'] },
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: SYS.USPS, concept: [{ code: 'CA' }, { code: 'NY' }, { code: 'TX' }] },
    ],
    [
      { system: SYS.GENDER, concept: [{ code: 'unknown' }] },
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
      { system: SYS.USPS, concept: [{ code: 'NY' }] },
    ]
  );

  const { result: full } = await expand(query);
  const fullKeys = [];
  flattenContainsKeys(full.expansion.contains || [], fullKeys);
  const fullSet = new Set(fullKeys);

  const pageSize = 19;
  const pagedKeys = [];
  for (let off = 0; off < fullSet.size + pageSize * 4; off += pageSize) {
    const { result: page } = await expand(query, { count: pageSize, offset: off });
    const keys = [];
    flattenContainsKeys(page.expansion.contains || [], keys);
    if (keys.length === 0) break;
    pagedKeys.push(...keys);
  }

  const pagedSet = new Set(pagedKeys);
  assert(pagedKeys.length === pagedSet.size, 'paged reconstruction should not duplicate codes');
  assert(pagedSet.size === fullSet.size,
    `paged size ${pagedSet.size} should match full size ${fullSet.size}`);
  for (const k of fullSet) {
    assert(pagedSet.has(k), `missing key from paged reconstruction: ${k}`);
  }
});

test('pagination-safety: mixed providers page windows are disjoint and bounded', async () => {
  const query = vs(
    [
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: SYS.GENDER },
      { system: SYS.USPS, concept: [{ code: 'CA' }, { code: 'NY' }, { code: 'TX' }] },
    ],
    [
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
      { system: SYS.GENDER, concept: [{ code: 'unknown' }] },
    ]
  );

  const { result: p1 } = await expand(query, { count: 25, offset: 0 });
  const { result: p2 } = await expand(query, { count: 25, offset: 25 });
  const k1 = [];
  const k2 = [];
  flattenContainsKeys(p1.expansion.contains || [], k1);
  flattenContainsKeys(p2.expansion.contains || [], k2);
  const s1 = new Set(k1);
  const s2 = new Set(k2);

  const overlap = [...s1].filter(k => s2.has(k));
  assert(overlap.length === 0, `page windows should be disjoint, overlap=${overlap.slice(0, 5)}`);
  assert(k1.length <= 25, `page 1 should be bounded by count=25, got ${k1.length}`);
  assert(k2.length <= 25, `page 2 should be bounded by count=25, got ${k2.length}`);
});

// ── Runner ─────────────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function run() {
  const filter = process.argv[2]?.toLowerCase();

  await setup();
  console.log(`\nRunning ${tests.length} tests${filter ? ` (filter: "${filter}")` : ''} [impl=${EXPAND_IMPL}]...\n`);

  let passed = 0, failed = 0, skipped = 0;
  const results = [];

  for (const t of tests) {
    if (filter && !t.name.toLowerCase().includes(filter)) {
      skipped++;
      continue;
    }

    _lastExpandTrace = null;
    _currentTestName = t.name;
    const t0 = performance.now();
    try {
      const extra = await t.fn();
      const ms = Math.round(performance.now() - t0);
      if (extra?.skipped) {
        console.log(`  ⏭  ${t.name} — ${extra.skipped}`);
        skipped++;
      } else {
        const info = extra ? ` ${JSON.stringify(extra)}` : '';
        console.log(`  ✅ ${t.name} (${ms}ms)${info}`);
        passed++;
      }
      results.push({ name: t.name, status: 'pass', ms, extra });
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      console.log(`  ❌ ${t.name} (${ms}ms) — ${e.message}`);
      if (process.env.HARNESS_VERBOSE) console.log(e.stack);
      if (process.env.EXPAND_TRACE && _lastExpandTrace) {
        console.log('  ── trace ──');
        console.log(JSON.stringify(_lastExpandTrace, null, 2).split('\n').map(l => '    ' + l).join('\n'));
      }
      failed++;
      results.push({ name: t.name, status: 'fail', ms, error: e.message, trace: _lastExpandTrace });
    } finally {
      _currentTestName = null;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  printProviderCoverageReport();
  printAssessmentStatusReport(results);

  if (process.env.EXPAND_TRACE) {
    fs.writeFileSync(
      path.join(__dirname, 'expand-v2-results.json'),
      JSON.stringify(results, null, 2)
    );
    console.log('Results written to tests/tx/expand-v2-results.json');
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
