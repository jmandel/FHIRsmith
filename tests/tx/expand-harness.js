/**
 * expansion test harness — runs expansions directly, no Express/HTTP.
 *
 * Loads the Library once (slow), then each test calls expand() directly
 * through the ExpandWorker → ValueSetExpander chain. Traces are captured
 * via AsyncLocalStorage and attached to results.
 *
 * Usage:
 *   node tests/tx/expand-harness.js                # run all
 *   node tests/tx/expand-harness.js "snomed is-a"  # run matching tests
 *   EXPAND_TRACE=1 node tests/tx/expand-harness.js # with full tracing
 *   EXPAND_TRACE=1 EXPAND_TRACE_FORMAT=summary node tests/tx/expand-harness.js
 *   EXPAND_TRACE=1 EXPAND_TRACE_PRINT=all node tests/tx/expand-harness.js "pagination-safety"
 *   EXPAND_IMPL=v3 node tests/tx/expand-harness.js
 *   EXPAND_IMPL=v3 node tests/tx/expand-harness.js # explicit impl selection (default)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Bootstrap folder-setup before anything else touches it
const folders = require('../../library/folder-setup');
folders.init(path.join(__dirname, '../../data'));

const { Library } = require('../../tx/library');
const { OperationContext } = require('../../tx/operation-context');
const { Languages } = require('../../library/languages');
const { TxParameters } = require('../../tx/params');
const { SearchFilterText } = require('../../tx/library/designations');
const ValueSet = require('../../tx/library/valueset');
const { VersionUtilities } = require('../../library/version-utilities');
const { ExpandTrace, traceStore, formatTraceSummary } = require('../../tx/workers/expand-trace');
const { ExpandWorker: TxExpandWorker } = require('../../tx/workers/expand-worker');
const { ValueSetExpander: ValueSetExpanderV3Compat } = require('../../tx/workers/expand-v3');
const { decideTotalOutcome } = require('../../tx/workers/expand-v3/src/engine/total-policy');

const EXPAND_IMPL = (process.env.EXPAND_IMPL || 'v3').toLowerCase();
if (EXPAND_IMPL !== 'v3') {
  throw new Error(`Invalid EXPAND_IMPL='${EXPAND_IMPL}'. Expected v3.`);
}

const TRACE_ENABLED = process.env.EXPAND_TRACE && process.env.EXPAND_TRACE !== '0';
const TRACE_PRINT = (process.env.EXPAND_TRACE_PRINT || 'fail').toLowerCase(); // fail | all | off
const TRACE_FORMAT = (process.env.EXPAND_TRACE_FORMAT || 'summary').toLowerCase(); // summary | json
const TRACE_MAX_SPANS = Number.parseInt(process.env.EXPAND_TRACE_MAX_SPANS || '12', 10) || 12;
const TRACE_RESULTS_FILE = process.env.EXPAND_TRACE_RESULTS || 'expand-results.json';
const TRACE_HEAVY = process.env.EXPAND_TRACE_HEAVY && process.env.EXPAND_TRACE_HEAVY !== '0';
const PUSH_DOWN_DISABLED = process.env.EXPAND_DISABLE_PUSHDOWN === '1';

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
  const preferredConfig = path.join(__dirname, 'fixtures', 'expand-test-library.yaml');
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
  const configured = process.env.TEST_ASSESSMENT_FILE || path.join(__dirname, 'fixtures', 'expand-assessment-status.json');
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
  if (impl !== 'v3') {
    throw new Error(`Unsupported implementation '${impl}'. Expected 'v3'.`);
  }
  const opContext = new OperationContext('en', i18n, null, 30);
  const worker = new TxExpandWorker(opContext, log, provider, langDefs, i18n);

  // Inject tx-resources if any
  if (opts.txResources) {
    worker.additionalResources = opts.txResources
      .map(res => worker.wrapRawResource ? worker.wrapRawResource(res) : null)
      .filter(Boolean);
  }
  if (typeof opts.patchWorker === 'function') {
    opts.patchWorker(worker);
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
  const expander = new ValueSetExpanderV3Compat(worker, txp);

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
  recordProviderCoverage(vsJson, _currentTestName);
  return runExpandWithImpl(EXPAND_IMPL, vsJson, opts, true);
}

const OPT_PROFILE_MATRIX = [
  'default',
  'baseline',
  'no-pushdown',
  'no-membership',
  'no-decorate-many',
];

async function withOptimizationProfile(profile, fn) {
  const prevProfile = process.env.EXPAND_OPT_PROFILE;
  const prevPushdown = process.env.EXPAND_DISABLE_PUSHDOWN;
  const prevMembership = process.env.EXPAND_DISABLE_MEMBERSHIP;
  const prevDecorateMany = process.env.EXPAND_DISABLE_DECORATE_MANY;
  if (profile && profile !== 'default') process.env.EXPAND_OPT_PROFILE = profile;
  else delete process.env.EXPAND_OPT_PROFILE;
  delete process.env.EXPAND_DISABLE_PUSHDOWN;
  delete process.env.EXPAND_DISABLE_MEMBERSHIP;
  delete process.env.EXPAND_DISABLE_DECORATE_MANY;
  try {
    return await fn();
  } finally {
    if (prevProfile === undefined) delete process.env.EXPAND_OPT_PROFILE;
    else process.env.EXPAND_OPT_PROFILE = prevProfile;
    if (prevPushdown === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prevPushdown;
    if (prevMembership === undefined) delete process.env.EXPAND_DISABLE_MEMBERSHIP;
    else process.env.EXPAND_DISABLE_MEMBERSHIP = prevMembership;
    if (prevDecorateMany === undefined) delete process.env.EXPAND_DISABLE_DECORATE_MANY;
    else process.env.EXPAND_DISABLE_DECORATE_MANY = prevDecorateMany;
  }
}

async function withEnv(overrides, fn) {
  const prev = new Map();
  for (const [k, v] of Object.entries(overrides || {})) {
    prev.set(k, process.env[k]);
    if (v === null || v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of prev.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function runExpandAcrossOptimizationProfiles(vsJson, opts = {}, profiles = OPT_PROFILE_MATRIX, captureTrace = false) {
  const out = {};
  for (const profile of profiles) {
    out[profile] = await withOptimizationProfile(profile, async () =>
      runExpandWithImpl('v3', vsJson, opts, captureTrace)
    );
  }
  return out;
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

/** Assert expansion.parameter entries are structurally well-formed. */
function assertExpansionParams(result) {
  const params = result?.expansion?.parameter || [];
  for (const p of params) {
    assert(typeof p.name === 'string' && p.name.length > 0,
      `parameter missing name: ${JSON.stringify(p)}`);
    const valueKeys = Object.keys(p).filter(k => k.startsWith('value'));
    assert(valueKeys.length === 1,
      `parameter '${p.name}' should have exactly 1 value[x], got ${valueKeys.length}`);
  }
}

function findParams(result, name) {
  return (result?.expansion?.parameter || []).filter(p => p.name === name);
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

function getProperty(containsEntry, code) {
  return (containsEntry?.property || []).find(p => p.code === code);
}

function hasUsedSupplementCanonical(values, canonical) {
  if (!canonical) return false;
  return (values || []).some(v => v === canonical || String(v || '').startsWith(`${canonical}|`));
}

function buildSupplementResourceFromSqlite(dbPath, codes) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const manifest = db.prepare(`
      SELECT supplement_uri, supplement_version, target_system, target_version
      FROM supplement_manifest
      LIMIT 1
    `).get();
    if (!manifest) throw new Error(`supplement manifest missing in ${dbPath}`);

    const cleanCodes = [...new Set((codes || []).map(c => String(c || '')).filter(Boolean))];
    if (cleanCodes.length === 0) {
      const allCodes = db.prepare(`
        SELECT code
        FROM supplement_code
        ORDER BY code
      `).all();
      cleanCodes.push(...allCodes.map(r => String(r.code || '')).filter(Boolean));
    }
    if (cleanCodes.length === 0) throw new Error('no codes provided');
    const placeholders = cleanCodes.map(() => '?').join(',');

    const dRows = db.prepare(`
      SELECT code, designation, designation_system, language_code, val, preferred, active
      FROM supplement_designation_by_code
      WHERE code IN (${placeholders}) AND active = 1
      ORDER BY code, designation
    `).all(...cleanCodes);

    const pRows = db.prepare(`
      SELECT code, property, value_type, value_string, value_code, value_decimal, value_integer, value_boolean, active
      FROM supplement_property_by_code
      WHERE code IN (${placeholders}) AND active = 1
      ORDER BY code, property
    `).all(...cleanCodes);

    const concepts = new Map();
    const propTypes = new Map();
    for (const code of cleanCodes) {
      concepts.set(code, { code, designation: [], property: [] });
    }

    for (const r of dRows) {
      const c = concepts.get(String(r.code));
      if (!c) continue;
      const d = {
        value: String(r.val || ''),
      };
      if (r.language_code) d.language = String(r.language_code);
      if (r.designation_system || r.designation) {
        d.use = {
          system: r.designation_system ? String(r.designation_system) : undefined,
          code: r.designation ? String(r.designation) : undefined,
        };
      }
      c.designation.push(d);
    }

    for (const r of pRows) {
      const c = concepts.get(String(r.code));
      if (!c) continue;
      const code = String(r.property || '');
      if (!code) continue;
      const vt = String(r.value_type || '').toLowerCase();
      let prop = { code };
      if (vt === 'code' && r.value_code != null) {
        prop.valueCode = String(r.value_code);
        propTypes.set(code, 'code');
      } else if (vt === 'decimal' && r.value_decimal != null) {
        prop.valueDecimal = Number(r.value_decimal);
        propTypes.set(code, 'decimal');
      } else if (vt === 'integer' && r.value_integer != null) {
        prop.valueInteger = Number(r.value_integer);
        propTypes.set(code, 'integer');
      } else if (vt === 'boolean' && r.value_boolean != null) {
        prop.valueBoolean = Number(r.value_boolean) === 1;
        propTypes.set(code, 'boolean');
      } else {
        const sv = r.value_string ?? r.value_code;
        if (sv == null) continue;
        prop.valueString = String(sv);
        if (!propTypes.has(code)) propTypes.set(code, 'string');
      }
      c.property.push(prop);
    }

    const property = [...propTypes.entries()].map(([code, type]) => ({
      code,
      uri: `http://example.org/fhir/CodeSystemProperty/${code}`,
      type,
    }));

    const targetVersionToken = manifest.target_version == null
      ? null
      : (VersionUtilities.normalizeVersionToken(String(manifest.target_version)) || null);

    return {
      resourceType: 'CodeSystem',
      url: String(manifest.supplement_uri),
      ...(manifest.supplement_version ? { version: String(manifest.supplement_version) } : {}),
      status: 'active',
      content: 'supplement',
      supplements: targetVersionToken
        ? `${manifest.target_system}|${targetVersionToken}`
        : String(manifest.target_system),
      ...(property.length > 0 ? { property } : {}),
      concept: cleanCodes.map(code => concepts.get(code)),
    };
  } finally {
    db.close();
  }
}

function createTempSupplementSqliteFixture({
  canonical,
  canonicalVersion = null,
  targetSystem,
  targetVersion = null,
  properties = [],
}) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-sqlite-supp-'));
  const dbPath = path.join(dir, 'supplement.v0.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE supplement_manifest (
        supplement_uri TEXT NOT NULL,
        supplement_version TEXT,
        target_system TEXT NOT NULL,
        target_version TEXT,
        generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE supplement_code (
        code_id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE
      );
      CREATE TABLE supplement_property (
        property_id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_id INTEGER NOT NULL,
        property TEXT NOT NULL,
        value_type TEXT NOT NULL DEFAULT 'string',
        value_string TEXT,
        value_code TEXT,
        value_decimal REAL,
        value_integer INTEGER,
        value_boolean INTEGER,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE supplement_designation (
        designation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_id INTEGER NOT NULL,
        designation TEXT NOT NULL,
        designation_system TEXT,
        language_code TEXT,
        val TEXT NOT NULL,
        preferred INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE VIEW supplement_property_by_code AS
      SELECT
        sc.code,
        sp.property,
        sp.value_type,
        sp.value_string,
        sp.value_code,
        sp.value_decimal,
        sp.value_integer,
        sp.value_boolean,
        sp.active
      FROM supplement_property sp
      JOIN supplement_code sc ON sc.code_id = sp.code_id;
      CREATE VIEW supplement_designation_by_code AS
      SELECT
        sc.code,
        sd.designation,
        sd.designation_system,
        sd.language_code,
        sd.val,
        sd.preferred,
        sd.active
      FROM supplement_designation sd
      JOIN supplement_code sc ON sc.code_id = sd.code_id;
      CREATE INDEX idx_supp_prop_property_code ON supplement_property(property, code_id);
      CREATE INDEX idx_supp_code_code ON supplement_code(code);
    `);

    const normalizedTargetVersion = targetVersion == null
      ? null
      : (VersionUtilities.normalizeVersionToken(String(targetVersion)) || null);

    db.prepare(`
      INSERT INTO supplement_manifest
        (supplement_uri, supplement_version, target_system, target_version)
      VALUES (?, ?, ?, ?)
    `).run(canonical, canonicalVersion, targetSystem, normalizedTargetVersion);

    const insCode = db.prepare(`INSERT INTO supplement_code(code) VALUES (?)`);
    const insProp = db.prepare(`
      INSERT INTO supplement_property
        (code_id, property, value_type, value_string, value_code, value_decimal, value_integer, value_boolean, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const codeIdByCode = new Map();
    for (const row of properties || []) {
      const code = String(row?.code || '');
      const property = String(row?.property || '');
      if (!code || !property) continue;
      let codeId = codeIdByCode.get(code);
      if (!codeId) {
        const r = insCode.run(code);
        codeId = Number(r.lastInsertRowid);
        codeIdByCode.set(code, codeId);
      }
      const valueType = String(row?.valueType || inferSupplementValueType(row));
      insProp.run(
        codeId,
        property,
        valueType,
        row?.valueString ?? null,
        row?.valueCode ?? null,
        row?.valueDecimal ?? null,
        row?.valueInteger ?? null,
        row?.valueBoolean == null ? null : (row.valueBoolean ? 1 : 0),
      );
    }
  } finally {
    db.close();
  }
  return { dir, dbPath };
}

function inferSupplementValueType(row) {
  if (row?.valueCode != null) return 'code';
  if (row?.valueInteger != null) return 'integer';
  if (row?.valueDecimal != null) return 'decimal';
  if (row?.valueBoolean != null) return 'boolean';
  return 'string';
}

function sampleD20CodesFromSupplementSqlite(dbPath, lowCount = 3, highCount = 3) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const lows = db.prepare(`
      SELECT code, value_integer
      FROM supplement_property_by_code
      WHERE property = 'd20' AND active = 1 AND value_integer < 5
      ORDER BY code
      LIMIT ?
    `).all(lowCount);
    const highs = db.prepare(`
      SELECT code, value_integer
      FROM supplement_property_by_code
      WHERE property = 'd20' AND active = 1 AND value_integer >= 5
      ORDER BY code
      LIMIT ?
    `).all(highCount);
    const selected = [...lows, ...highs];
    const valueByCode = new Map(selected.map(r => [String(r.code), Number(r.value_integer)]));
    return {
      lowCodes: lows.map(r => String(r.code)),
      highCodes: highs.map(r => String(r.code)),
      valueByCode,
    };
  } finally {
    db.close();
  }
}

function sampleD20CodeForValue(dbPath, value) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`
      SELECT code
      FROM supplement_property_by_code
      WHERE property = 'd20' AND active = 1 AND value_integer = ?
      ORDER BY code
      LIMIT 1
    `).get(value);
    return row ? String(row.code) : null;
  } finally {
    db.close();
  }
}

function addDerivedRarityProperty(supplement) {
  if (!supplement || !Array.isArray(supplement.concept)) return;
  supplement.property = Array.isArray(supplement.property) ? supplement.property : [];
  if (!supplement.property.some(p => p?.code === 'rarity')) {
    supplement.property.push({
      code: 'rarity',
      uri: 'http://example.org/fhir/CodeSystemProperty/rarity',
      type: 'code',
    });
  }
  for (const concept of supplement.concept) {
    if (!concept || !concept.code) continue;
    concept.property = Array.isArray(concept.property) ? concept.property : [];
    const d20 = concept.property.find(p => p?.code === 'd20');
    const d20Value = d20?.valueInteger;
    if (!Number.isInteger(d20Value)) continue;
    if (concept.property.some(p => p?.code === 'rarity')) continue;
    concept.property.push({
      code: 'rarity',
      valueCode: d20Value < 5 ? 'low' : 'high',
    });
  }
}

function buildSupplementPropertyIndex(supplement, propertyCode) {
  const map = new Map();
  for (const concept of supplement?.concept || []) {
    if (!concept?.code || !Array.isArray(concept.property)) continue;
    const vals = [];
    for (const p of concept.property) {
      if (!p || String(p.code || '') !== propertyCode) continue;
      const v = readPropertyValue(p);
      if (v == null) continue;
      vals.push(String(v));
    }
    if (vals.length > 0) {
      map.set(String(concept.code), vals);
    }
  }
  return map;
}

function readPropertyValue(p) {
  if (p.valueCode != null) return p.valueCode;
  if (p.valueString != null) return p.valueString;
  if (p.valueInteger != null) return p.valueInteger;
  if (p.valueBoolean != null) return p.valueBoolean;
  if (p.valueDecimal != null) return p.valueDecimal;
  return null;
}

function matchesPropertyClause(values, clause) {
  const op = String(clause?.op || '');
  const raw = String(clause?.value ?? '');
  if (op === '=') {
    return values.includes(raw);
  }
  if (op === 'in') {
    const set = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
    return values.some(v => set.has(v));
  }
  if (op === 'exists') {
    const want = raw.toLowerCase() !== 'false';
    return want ? values.length > 0 : values.length === 0;
  }
  return false;
}

function createPredicateTrackingSupplementContext(baseCtx, metrics = {}, opts = {}) {
  const allowed = opts.allowedProperties
    ? new Set(opts.allowedProperties.map(v => String(v)))
    : null;
  return {
    canonicals: () => (typeof baseCtx?.canonicals === 'function' ? baseCtx.canonicals() : []),
    markResolved: (url) => baseCtx?.markResolved?.(url),
    markUsed: (url, why) => baseCtx?.markUsed?.(url, why),
    resolvedCanonicals: () => (typeof baseCtx?.resolvedCanonicals === 'function' ? baseCtx.resolvedCanonicals() : []),
    usedCanonicals: () => (typeof baseCtx?.usedCanonicals === 'function' ? baseCtx.usedCanonicals() : []),
    native: (request) => (typeof baseCtx?.native === 'function' ? baseCtx.native(request) : null),
    decorateMany: async (request) => (typeof baseCtx?.decorateMany === 'function'
      ? baseCtx.decorateMany(request)
      : new Map()),
    preparePredicate: async (request) => {
      const prop = String(request?.clause?.property || '');
      metrics.prepareCalls = metrics.prepareCalls || [];
      metrics.prepareCalls.push(prop);
      if (allowed && !allowed.has(prop)) {
        return null;
      }
      const pred = await baseCtx?.preparePredicate?.(request);
      if (!pred || typeof pred.batchHas !== 'function') {
        return pred;
      }
      return {
        batchHas: async (codes) => {
          metrics.batchCalls = (metrics.batchCalls || 0) + 1;
          metrics.batchSizes = metrics.batchSizes || [];
          metrics.batchSizes.push(codes.length);
          return pred.batchHas(codes);
        },
        close: async () => {
          if (typeof pred.close === 'function') await pred.close();
        },
      };
    },
    close: async () => {
      if (typeof baseCtx?.close === 'function') {
        await baseCtx.close();
      }
    },
  };
}

function installConfigurableSupplementProviderPatch(worker, cfg = {}) {
  const targetSystems = new Set((cfg.systems || []).map(s => String(s)));
  const nativeProps = new Set((cfg.nativeSupplementProperties || []).map(s => String(s)));
  const nativeOps = new Set((cfg.nativeSupplementOperators || []).map(s => String(s)));
  const nativeData = cfg.nativeSupplementData || {};
  const metrics = cfg.metrics || {};
  const origFindCodeSystem = worker.findCodeSystem.bind(worker);

  worker.findCodeSystem = async (...args) => {
    const cs = await origFindCodeSystem(...args);
    if (!cs) return cs;
    const system = await cs.system();
    if (targetSystems.size > 0 && !targetSystems.has(system)) return cs;
    if (cs.__harnessNegotiationPatchApplied) return cs;

    Object.defineProperty(cs, '__harnessNegotiationPatchApplied', {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });

    const origNegotiate = typeof cs.negotiate === 'function'
      ? cs.negotiate.bind(cs)
      : async () => ({});
    const origOpenStream = typeof cs.openStream === 'function'
      ? cs.openStream.bind(cs)
      : null;

    cs.negotiate = async (request = {}) => {
      const base = await origNegotiate(request);
      const report = {
        ...base,
        query: base?.query === true,
        membership: base?.membership === true,
        decorateMany: base?.decorateMany === true,
        ordering: base?.ordering || { stable: false, kind: 'unspecified' },
        pagination: base?.pagination === true,
        legacyFilter: base?.legacyFilter || {
          filterPipeline: true,
          supportsSearchFilter: true,
          supportsFilterPage: true,
        },
        supplements: {
          ...(base?.supplements || {}),
          handles: nativeProps.size > 0 ? 'partial' : 'none',
          filtering: nativeProps.size > 0 ? 'native' : 'none',
          properties: [...nativeProps],
          operators: [...nativeOps],
          unsupported: (cfg.unsupportedSupplementProperties || []).map(v => String(v)),
        },
      };
      metrics.reports = metrics.reports || [];
      metrics.reports.push(report);
      return report;
    };

    if (origOpenStream && nativeProps.size > 0) {
      cs.openStream = async (request = {}) => {
        const queryIR = request?.queryIR;
        const select = queryIR?.select;
        const clauses = Array.isArray(select?.clauses) ? select.clauses : [];
        if (!queryIR || select?.kind !== 'filter' || clauses.length === 0) {
          return origOpenStream(request);
        }

        const nativeClauses = [];
        const providerClauses = [];
        for (const fc of clauses) {
          const prop = String(fc?.property || '');
          const op = String(fc?.op || '');
          if (nativeProps.has(prop) && nativeOps.has(op)) {
            nativeClauses.push(fc);
          } else {
            providerClauses.push(fc);
          }
        }
        if (nativeClauses.length === 0) {
          return origOpenStream(request);
        }

        const baseQueryIR = structuredClone(queryIR);
        if (providerClauses.length === 0) {
          const nextSelect = { kind: 'all' };
          if (select?.text) nextSelect.text = select.text;
          if (Array.isArray(select?.intersectCodes)) {
            nextSelect.intersectCodes = [...select.intersectCodes];
          }
          baseQueryIR.select = nextSelect;
        } else {
          baseQueryIR.select = {
            ...select,
            kind: 'filter',
            clauses: providerClauses,
          };
        }

        const rows = await origOpenStream({ ...request, queryIR: baseQueryIR });
        if (!rows) return rows;

        const batchSize = 256;
        const filterRows = async function* () {
          let batch = [];
          for await (const row of rows) {
            batch.push(row);
            if (batch.length >= batchSize) {
              yield* flush(batch);
              batch = [];
            }
          }
          if (batch.length > 0) {
            yield* flush(batch);
          }
        };

        const flush = (items) => {
          const accepted = [];
          for (const row of items) {
            const code = String(row?.code || '');
            if (!code) continue;
            let ok = true;
            for (const clause of nativeClauses) {
              const prop = String(clause?.property || '');
              const values = nativeData?.[prop]?.get(code) || [];
              if (!matchesPropertyClause(values, clause)) {
                ok = false;
                break;
              }
            }
            if (ok) accepted.push(row);
          }
          metrics.nativeClauseBatchCalls = (metrics.nativeClauseBatchCalls || 0) + 1;
          metrics.nativeClauseRowsChecked = (metrics.nativeClauseRowsChecked || 0) + items.length;
          return accepted;
        };

        const stream = filterRows();
        stream.total = null;
        stream.notClosed = !!rows.notClosed;
        return stream;
      };
    }

    return cs;
  };
}

function traceSpans(traceJson) {
  return Array.isArray(traceJson?.spans) ? traceJson.spans : [];
}

function traceFindSpansByName(traceJson, name) {
  const matches = [];
  const walk = (spans) => {
    for (const span of spans || []) {
      if (!span || span.name === 'note') continue;
      if (span.name === name) matches.push(span);
      if (span.children?.length) walk(span.children);
    }
  };
  walk(traceSpans(traceJson));
  return matches;
}

function traceHasSpan(traceJson, name, predicate = null) {
  const spans = traceFindSpansByName(traceJson, name);
  if (!predicate) return spans.length > 0;
  return spans.some(s => {
    try {
      return !!predicate(s);
    } catch {
      return false;
    }
  });
}

function assertSqlitePushdownTrace(traceJson, label = 'expected sqlite-v0 pushdown trace span') {
  assert(traceHasSpan(traceJson, 'v0.expandQuery'), label);
  if (EXPAND_IMPL !== 'v3') {
    assert(
      traceHasSpan(traceJson, '_tryPushdown', s => s.result?.handled === true),
      'expected _tryPushdown handled=true'
    );
  }
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

test('supplement: useSupplement parameter applies supplement content and records used-supplement', async () => {
  const csUrl = `http://example.org/cs/supp-base-${Date.now()}`;
  const suppUrl = `http://example.org/cs/supp-pack-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'x', display: 'Base Display' },
    ],
  };
  const supplement = {
    resourceType: 'CodeSystem',
    url: suppUrl,
    status: 'active',
    content: 'supplement',
    supplements: csUrl,
    concept: [
      {
        code: 'x',
        display: 'Supplement Display',
        designation: [
          { language: 'en', value: 'Supplement Synonym' },
        ],
      },
    ],
  };

  const { result } = await expand(vs({ system: csUrl, concept: [{ code: 'x' }] }), {
    txResources: [cs, supplement],
    params: [
      { name: 'useSupplement', valueCanonical: suppUrl },
      { name: 'includeDesignations', valueBoolean: true },
    ],
  });

  assertExpansionStructure(result);
  assertExpansionParams(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 1, `expected 1 code, got ${contains.length}`);
  const item = findCode(contains, 'x');
  assert(item, 'missing code x');
  assert(typeof item.display === 'string' && item.display.length > 0,
    'expected non-empty display');
  assert((item.designation || []).some(d => d.value === 'Supplement Display'),
    'expected supplement display to be present as a designation');
  assert((item.designation || []).some(d => d.value === 'Supplement Synonym'),
    'expected supplement synonym designation');

  const usedSupp = findParams(result, 'used-supplement').map(p => p.valueUri || p.valueCanonical || '');
  assert(hasUsedSupplementCanonical(usedSupp, suppUrl),
    `expected used-supplement to include ${suppUrl}, got ${JSON.stringify(usedSupp)}`);
});

test('supplement: provided but not requested supplement is ignored', async () => {
  const csUrl = `http://example.org/cs/supp-base-unrequested-${Date.now()}`;
  const suppUrl = `http://example.org/cs/supp-pack-unrequested-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [{ code: 'x', display: 'Base X' }],
  };
  const supplement = {
    resourceType: 'CodeSystem',
    url: suppUrl,
    status: 'active',
    content: 'supplement',
    supplements: csUrl,
    concept: [{ code: 'x', display: 'Supplement X' }],
  };

  const { result } = await expand(vs({ system: csUrl, concept: [{ code: 'x' }] }), {
    txResources: [cs, supplement],
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });

  assertExpansionStructure(result);
  assertExpansionParams(result);
  const item = findCode(result.expansion.contains || [], 'x');
  assert(item, 'missing code x');
  assert(item.display === 'Base X', `expected base display, got '${item.display}'`);
  assert(!(item.designation || []).some(d => d.value === 'Supplement X'),
    'unrequested supplement designation should not be present');
  const usedSupp = findParams(result, 'used-supplement');
  assert(usedSupp.length === 0,
    `expected no used-supplement parameters when supplement is not requested, got ${usedSupp.length}`);
});

test('supplement: valueset-supplement extension on ValueSet activates supplement', async () => {
  const csUrl = `http://example.org/cs/supp-base-ext-${Date.now()}`;
  const suppUrl = `http://example.org/cs/supp-pack-ext-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [{ code: 'y', display: 'Base Y' }],
  };
  const supplement = {
    resourceType: 'CodeSystem',
    url: suppUrl,
    status: 'active',
    content: 'supplement',
    supplements: csUrl,
    concept: [{ code: 'y', display: 'Supplement Y' }],
  };
  const query = vs({
    system: csUrl,
    concept: [{ code: 'y' }],
  });
  query.extension = [{
      url: 'http://hl7.org/fhir/StructureDefinition/valueset-supplement',
      valueCanonical: suppUrl,
    }];

  const { result } = await expand(query, {
    txResources: [cs, supplement],
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  assertExpansionParams(result);
  const item = findCode(result.expansion.contains || [], 'y');
  assert(item, 'missing code y');
  assert((item.designation || []).some(d => d.value === 'Supplement Y'),
    'expected supplement value via designations when valueset-supplement is declared');
  const usedSupp = findParams(result, 'used-supplement').map(p => p.valueUri || p.valueCanonical || '');
  assert(hasUsedSupplementCanonical(usedSupp, suppUrl),
    `expected used-supplement to include ${suppUrl}, got ${JSON.stringify(usedSupp)}`);
});

test('supplement: used-supplement parameter is deduped across multiple matched codes', async () => {
  const csUrl = `http://example.org/cs/supp-base-dedupe-${Date.now()}`;
  const suppUrl = `http://example.org/cs/supp-pack-dedupe-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'a', display: 'Base A' },
      { code: 'b', display: 'Base B' },
    ],
  };
  const supplement = {
    resourceType: 'CodeSystem',
    url: suppUrl,
    status: 'active',
    content: 'supplement',
    supplements: csUrl,
    concept: [
      { code: 'a', display: 'Supp A' },
      { code: 'b', display: 'Supp B' },
    ],
  };

  const { result } = await expand(vs({ system: csUrl }), {
    txResources: [cs, supplement],
    params: [{ name: 'useSupplement', valueCanonical: suppUrl }],
  });
  assertExpansionStructure(result);
  assertExpansionParams(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 codes, got ${contains.length}`);
  const usedSupp = findParams(result, 'used-supplement').map(p => p.valueUri || p.valueCanonical || '');
  const matched = usedSupp.filter(v => v === suppUrl);
  assert(matched.length === 1,
    `expected used-supplement to be deduped to one entry, got ${matched.length}: ${JSON.stringify(usedSupp)}`);
});

test('supplement: missing required supplement fails expansion', async () => {
  const csUrl = `http://example.org/cs/supp-base-missing-${Date.now()}`;
  const missingSuppUrl = `http://example.org/cs/supp-missing-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [{ code: 'z', display: 'Base Z' }],
  };

  let failed = false;
  try {
    await expand(vs({ system: csUrl, concept: [{ code: 'z' }] }), {
      txResources: [cs],
      params: [{ name: 'useSupplement', valueCanonical: missingSuppUrl }],
    });
  } catch (e) {
    failed = true;
    const msg = String(e?.message || '');
    assert(msg.toLowerCase().includes('supplement'),
      `expected missing supplement error, got '${msg}'`);
  }
  assert(failed, 'expected expansion to fail when a required supplement is missing');
});

test('supplement: missing ValueSet extension supplement fails expansion', async () => {
  const csUrl = `http://example.org/cs/supp-base-missing-ext-${Date.now()}`;
  const missingSuppUrl = `http://example.org/cs/supp-missing-ext-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [{ code: 'm', display: 'Base M' }],
  };
  const query = vs({ system: csUrl, concept: [{ code: 'm' }] });
  query.extension = [{
    url: 'http://hl7.org/fhir/StructureDefinition/valueset-supplement',
    valueCanonical: missingSuppUrl,
  }];

  let failed = false;
  try {
    await expand(query, { txResources: [cs] });
  } catch (e) {
    failed = true;
    const msg = String(e?.message || '');
    assert(msg.toLowerCase().includes('supplement'),
      `expected missing supplement error, got '${msg}'`);
  }
  assert(failed, 'expected expansion to fail when ValueSet extension supplement is missing');
});

test('supplement: designation filter can select supplement use-coded designation', async () => {
  const csUrl = `http://example.org/cs/supp-base-design-${Date.now()}`;
  const suppUrl = `http://example.org/cs/supp-pack-design-${Date.now()}`;
  const useSystem = 'http://snomed.info/sct';
  const useCode = '900000000000003001';
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [{ code: 'd', display: 'Base D' }],
  };
  const supplement = {
    resourceType: 'CodeSystem',
    url: suppUrl,
    status: 'active',
    content: 'supplement',
    supplements: csUrl,
    concept: [{
      code: 'd',
      designation: [{
        language: 'en',
        use: { system: useSystem, code: useCode },
        value: 'Supplement FSN',
      }],
    }],
  };

  const { result } = await expand(vs({ system: csUrl, concept: [{ code: 'd' }] }), {
    txResources: [cs, supplement],
    params: [
      { name: 'useSupplement', valueCanonical: suppUrl },
      { name: 'includeDesignations', valueBoolean: true },
      { name: 'designation', valueString: `${useSystem}|${useCode}` },
    ],
  });

  assertExpansionStructure(result);
  assertExpansionParams(result);
  const item = findCode(result.expansion.contains || [], 'd');
  assert(item, 'missing code d');
  const designations = item.designation || [];
  assert(designations.length > 0, 'expected filtered designations');
  assert(designations.some(d => d.value === 'Supplement FSN'),
    'expected supplement FSN designation after use-based designation filtering');
});

test('supplement: itemWeight extension from supplement is projected into expansion properties', async () => {
  const csUrl = `http://example.org/cs/supp-base-weight-${Date.now()}`;
  const suppUrl = `http://example.org/cs/supp-pack-weight-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [{ code: 'w', display: 'Base W' }],
  };
  const supplement = {
    resourceType: 'CodeSystem',
    url: suppUrl,
    status: 'active',
    content: 'supplement',
    supplements: csUrl,
    concept: [{
      code: 'w',
      extension: [{
        url: 'http://hl7.org/fhir/StructureDefinition/itemWeight',
        valueDecimal: 2.5,
      }],
    }],
  };

  const { result } = await expand(vs({ system: csUrl, concept: [{ code: 'w' }] }), {
    txResources: [cs, supplement],
    params: [{ name: 'useSupplement', valueCanonical: suppUrl }],
  });

  assertExpansionStructure(result);
  const item = findCode(result.expansion.contains || [], 'w');
  assert(item, 'missing code w');
  assert(hasProperty(item, 'weight'),
    'expected weight property derived from supplement itemWeight extension');
});

test('supplement: version-pinned useSupplement canonical is accepted', async () => {
  const csUrl = `http://example.org/cs/supp-base-versioned-${Date.now()}`;
  const suppUrl = `http://example.org/cs/supp-pack-versioned-${Date.now()}`;
  const suppVersion = '2026-02';
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    version: '1',
    status: 'active',
    content: 'complete',
    concept: [{ code: 'v', display: 'Base V' }],
  };
  const supplement = {
    resourceType: 'CodeSystem',
    url: suppUrl,
    version: suppVersion,
    status: 'active',
    content: 'supplement',
    supplements: `${csUrl}|1`,
    concept: [{ code: 'v', display: 'Supp V' }],
  };
  const pinnedSupp = `${suppUrl}|${suppVersion}`;

  const { result } = await expand(vs({ system: csUrl, version: '1', concept: [{ code: 'v' }] }), {
    txResources: [cs, supplement],
    params: [{ name: 'useSupplement', valueCanonical: pinnedSupp }],
  });

  assertExpansionStructure(result);
  const item = findCode(result.expansion.contains || [], 'v');
  assert(item, 'missing code v');
  const usedSupp = findParams(result, 'used-supplement').map(p => p.valueUri || p.valueCanonical || '');
  assert(usedSupp.includes(pinnedSupp),
    `expected used-supplement to include pinned canonical ${pinnedSupp}, got ${JSON.stringify(usedSupp)}`);
});

test('supplement-sqlite: D20 LOINC fixture projects property/designation', async () => {
  const dbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-loinc-d20.v0.db');
  if (!fs.existsSync(dbPath)) return { skipped: `missing fixture ${dbPath}` };
  const propertyCode = 'd20';
  const loincCodes = ['2160-0', '4548-4', '718-7'];
  const supplement = buildSupplementResourceFromSqlite(dbPath, loincCodes);
  const suppCanonical = supplement.url;

  const { result } = await expand(vs({
    system: SYS.LOINC,
    concept: loincCodes.map(code => ({ code })),
  }), {
    txResources: [supplement],
    params: [
      { name: 'useSupplement', valueCanonical: suppCanonical },
      { name: 'property', valueCode: propertyCode },
      { name: 'includeDesignations', valueBoolean: true },
    ],
  });

  assertExpansionStructure(result);
  assertExpansionParams(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === loincCodes.length, `expected ${loincCodes.length} codes, got ${contains.length}`);
  for (const code of loincCodes) {
    const entry = findCode(contains, code);
    assert(entry, `missing LOINC code ${code}`);
    assert(hasProperty(entry, propertyCode), `expected ${propertyCode} on ${code}`);
    const prop = getProperty(entry, propertyCode);
    assert(Number.isInteger(prop.valueInteger), `expected integer ${propertyCode} on ${code}, got ${JSON.stringify(prop)}`);
    assert(prop.valueInteger >= 1 && prop.valueInteger <= 20,
      `expected ${propertyCode} in [1,20] on ${code}, got ${JSON.stringify(prop)}`);
    assert((entry.designation || []).some(d => d.value === `D20 ${code}`),
      `expected D20 designation on ${code}`);
    const dndDesignations = (entry.designation || []).filter(d => d.use?.code === 'DND');
    if (prop.valueInteger < 5) {
      assert(dndDesignations.some(d => d.language === 'en'), `expected DND en designation on ${code} when ${propertyCode}<5`);
      assert(dndDesignations.some(d => d.language === 'fr'), `expected DND fr designation on ${code} when ${propertyCode}<5`);
    } else {
      assert(dndDesignations.length === 0, `expected no DND designation on ${code} when ${propertyCode}>=5`);
    }
  }
  const usedSupp = findParams(result, 'used-supplement').map(p => p.valueUri || p.valueCanonical || '');
  assert(hasUsedSupplementCanonical(usedSupp, suppCanonical), `expected used-supplement ${suppCanonical}`);
});

test('supplement-sqlite: D20 LOINC full-page parity across optimization profiles', async () => {
  const dbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-loinc-d20.v0.db');
  if (!fs.existsSync(dbPath)) return { skipped: `missing fixture ${dbPath}` };

  const db = new Database(dbPath, { readonly: true });
  let expectedCount = 0;
  let suppCanonical = null;
  try {
    const manifest = db.prepare(`
      SELECT supplement_uri, supplement_version
      FROM supplement_manifest
      LIMIT 1
    `).get();
    if (manifest?.supplement_uri) {
      const uri = String(manifest.supplement_uri);
      const ver = manifest.supplement_version ? String(manifest.supplement_version) : null;
      suppCanonical = ver ? `${uri}|${ver}` : uri;
    }
    const row = db.prepare(`
      SELECT COUNT(DISTINCT code) AS c
      FROM supplement_property_by_code
      WHERE property = 'd20' AND active = 1 AND value_integer = 1
    `).get();
    expectedCount = Number(row?.c || 0);
  } finally {
    db.close();
  }
  if (expectedCount <= 0) return { skipped: 'no d20=1 rows in LOINC supplement fixture' };
  if (!suppCanonical) return { skipped: 'missing supplement canonical in LOINC supplement fixture' };

  const query = vs({
    system: SYS.LOINC,
    filter: [{ property: 'd20', op: '=', value: '1' }],
  });
  const opts = {
    count: 20000,
    offset: 0,
    params: [
      { name: 'useSupplement', valueCanonical: suppCanonical },
      { name: 'limit', valueInteger: 200000 },
    ],
  };

  const runs = await runExpandAcrossOptimizationProfiles(query, opts, OPT_PROFILE_MATRIX, false);
  const baseline = runs.default.result;
  assertExpansionStructure(baseline);
  assertExpansionParams(baseline);

  const baselineContains = baseline.expansion.contains || [];
  assert(baselineContains.length === expectedCount,
    `default profile should return ${expectedCount} codes, got ${baselineContains.length}`);
  assert(baseline.expansion.total === expectedCount,
    `default profile total should be ${expectedCount}, got ${baseline.expansion.total}`);

  for (const profile of OPT_PROFILE_MATRIX) {
    const run = runs[profile];
    const result = run.result;
    assertExpansionStructure(result);
    const contains = result.expansion.contains || [];
    assert(contains.length === expectedCount,
      `${profile} should return ${expectedCount} codes, got ${contains.length}`);
    assert(result.expansion.total === expectedCount,
      `${profile} total should be ${expectedCount}, got ${result.expansion.total}`);
    const parity = compareParity(baseline, result, 'default', profile);
    assert(parity.ok, `profile parity mismatch (${profile}): ${parity.reason}`);
  }

  return {
    expectedCount,
    ms: Object.fromEntries(OPT_PROFILE_MATRIX.map(profile => [profile, runs[profile].ms])),
  };
});

test('supplement-sqlite: D20 RxNorm fixture projects property/designation', async () => {
  const dbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-rxnorm-d20.v0.db');
  if (!fs.existsSync(dbPath)) return { skipped: `missing fixture ${dbPath}` };
  const propertyCode = 'd20';
  const rxnormCodes = ['161', '5640', '1191'];
  const supplement = buildSupplementResourceFromSqlite(dbPath, rxnormCodes);
  const suppCanonical = supplement.url;

  const { result } = await expand(vs({
    system: SYS.RXNORM,
    concept: rxnormCodes.map(code => ({ code })),
  }), {
    txResources: [supplement],
    params: [
      { name: 'useSupplement', valueCanonical: suppCanonical },
      { name: 'property', valueCode: propertyCode },
      { name: 'includeDesignations', valueBoolean: true },
    ],
  });

  assertExpansionStructure(result);
  assertExpansionParams(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === rxnormCodes.length, `expected ${rxnormCodes.length} codes, got ${contains.length}`);
  for (const code of rxnormCodes) {
    const entry = findCode(contains, code);
    assert(entry, `missing RxNorm code ${code}`);
    assert(hasProperty(entry, propertyCode), `expected ${propertyCode} on ${code}`);
    const prop = getProperty(entry, propertyCode);
    assert(Number.isInteger(prop.valueInteger), `expected integer ${propertyCode} on ${code}, got ${JSON.stringify(prop)}`);
    assert(prop.valueInteger >= 1 && prop.valueInteger <= 20,
      `expected ${propertyCode} in [1,20] on ${code}, got ${JSON.stringify(prop)}`);
    assert((entry.designation || []).some(d => d.value === `D20 ${code}`),
      `expected D20 designation on ${code}`);
    const dndDesignations = (entry.designation || []).filter(d => d.use?.code === 'DND');
    if (prop.valueInteger < 5) {
      assert(dndDesignations.some(d => d.language === 'en'), `expected DND en designation on ${code} when ${propertyCode}<5`);
      assert(dndDesignations.some(d => d.language === 'fr'), `expected DND fr designation on ${code} when ${propertyCode}<5`);
    } else {
      assert(dndDesignations.length === 0, `expected no DND designation on ${code} when ${propertyCode}>=5`);
    }
  }
  const usedSupp = findParams(result, 'used-supplement').map(p => p.valueUri || p.valueCanonical || '');
  assert(hasUsedSupplementCanonical(usedSupp, suppCanonical), `expected used-supplement ${suppCanonical}`);
});

test('supplement-sqlite: D20 LOINC + RxNorm fixtures both apply in one expansion', async () => {
  const loincDbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-loinc-d20.v0.db');
  const rxDbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-rxnorm-d20.v0.db');
  if (!fs.existsSync(loincDbPath) || !fs.existsSync(rxDbPath)) {
    return { skipped: `missing fixture(s): ${loincDbPath}, ${rxDbPath}` };
  }
  const loincPropertyCode = 'd20';
  const rxPropertyCode = 'd20';
  const loincCode = '2160-0';
  const rxCode = '1191';

  const loincSupp = buildSupplementResourceFromSqlite(loincDbPath, [loincCode]);
  const rxSupp = buildSupplementResourceFromSqlite(rxDbPath, [rxCode]);
  const loincSuppCanonical = loincSupp.url;
  const rxSuppCanonical = rxSupp.url;

  const { result } = await expand(vs([
    { system: SYS.LOINC, concept: [{ code: loincCode }] },
    { system: SYS.RXNORM, concept: [{ code: rxCode }] },
  ]), {
    txResources: [loincSupp, rxSupp],
    params: [
      { name: 'useSupplement', valueCanonical: loincSuppCanonical },
      { name: 'useSupplement', valueCanonical: rxSuppCanonical },
      { name: 'property', valueCode: loincPropertyCode },
      { name: 'property', valueCode: rxPropertyCode },
    ],
  });

  assertExpansionStructure(result);
  assertExpansionParams(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 codes, got ${contains.length}`);
  assert(hasProperty(findCode(contains, loincCode), loincPropertyCode), `expected ${loincPropertyCode} on ${loincCode}`);
  assert(hasProperty(findCode(contains, rxCode), rxPropertyCode), `expected ${rxPropertyCode} on ${rxCode}`);

  const usedSupp = findParams(result, 'used-supplement').map(p => p.valueUri || p.valueCanonical || '');
  assert(hasUsedSupplementCanonical(usedSupp, loincSuppCanonical), `expected used-supplement ${loincSuppCanonical}`);
  assert(hasUsedSupplementCanonical(usedSupp, rxSuppCanonical), `expected used-supplement ${rxSuppCanonical}`);
});

test('supplement-sqlite: D20 SNOMED fixture projects property/designation', async () => {
  const dbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-snomed-d20.v0.db');
  if (!fs.existsSync(dbPath)) return { skipped: `missing fixture ${dbPath}` };
  const propertyCode = 'd20';
  const snomedCodes = ['73211009', '44054006', '46635009'];
  const supplement = buildSupplementResourceFromSqlite(dbPath, snomedCodes);
  const suppCanonical = supplement.url;

  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: snomedCodes.map(code => ({ code })),
  }), {
    txResources: [supplement],
    params: [
      { name: 'useSupplement', valueCanonical: suppCanonical },
      { name: 'property', valueCode: propertyCode },
      { name: 'includeDesignations', valueBoolean: true },
    ],
  });

  assertExpansionStructure(result);
  assertExpansionParams(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === snomedCodes.length, `expected ${snomedCodes.length} codes, got ${contains.length}`);
  for (const code of snomedCodes) {
    const entry = findCode(contains, code);
    assert(entry, `missing SNOMED code ${code}`);
    assert(hasProperty(entry, propertyCode), `expected ${propertyCode} on ${code}`);
    const prop = getProperty(entry, propertyCode);
    assert(Number.isInteger(prop.valueInteger), `expected integer ${propertyCode} on ${code}, got ${JSON.stringify(prop)}`);
    assert(prop.valueInteger >= 1 && prop.valueInteger <= 20,
      `expected ${propertyCode} in [1,20] on ${code}, got ${JSON.stringify(prop)}`);
    assert((entry.designation || []).some(d => d.value === `D20 ${code}`),
      `expected D20 designation on ${code}`);
    const dndDesignations = (entry.designation || []).filter(d => d.use?.code === 'DND');
    if (prop.valueInteger < 5) {
      assert(dndDesignations.some(d => d.language === 'en'), `expected DND en designation on ${code} when ${propertyCode}<5`);
      assert(dndDesignations.some(d => d.language === 'fr'), `expected DND fr designation on ${code} when ${propertyCode}<5`);
    } else {
      assert(dndDesignations.length === 0, `expected no DND designation on ${code} when ${propertyCode}>=5`);
    }
  }
  const usedSupp = findParams(result, 'used-supplement').map(p => p.valueUri || p.valueCanonical || '');
  assert(hasUsedSupplementCanonical(usedSupp, suppCanonical), `expected used-supplement ${suppCanonical}`);
});

test('supplement-sqlite: full SNOMED D20 supplement + designation filter returns DND only for low rolls', async () => {
  const dbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-snomed-d20.v0.db');
  if (!fs.existsSync(dbPath)) return { skipped: `missing fixture ${dbPath}` };

  const { lowCodes, highCodes, valueByCode } = sampleD20CodesFromSupplementSqlite(dbPath, 3, 3);
  if (lowCodes.length < 3 || highCodes.length < 3) {
    return { skipped: 'insufficient low/high d20 samples in SNOMED supplement fixture' };
  }
  const allCodes = [...lowCodes, ...highCodes];
  const supplement = buildSupplementResourceFromSqlite(dbPath);
  const suppCanonical = supplement.url;

  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: allCodes.map(code => ({ code })),
  }), {
    txResources: [supplement],
    params: [
      { name: 'useSupplement', valueCanonical: suppCanonical },
      { name: 'includeDesignations', valueBoolean: true },
      { name: 'designation', valueString: 'http://example.org/fhir/CodeSystem/d20|DND' },
    ],
  });

  assertExpansionStructure(result);
  assertExpansionParams(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === allCodes.length, `expected ${allCodes.length} concepts, got ${contains.length}`);
  for (const code of allCodes) {
    const entry = findCode(contains, code);
    assert(entry, `missing SNOMED code ${code}`);
    const dnd = (entry.designation || []).filter(d =>
      d.use?.system === 'http://example.org/fhir/CodeSystem/d20' && d.use?.code === 'DND'
    );
    const d20 = valueByCode.get(code);
    assert(Number.isInteger(d20), `missing sampled d20 for ${code}`);
    if (d20 < 5) {
      assert(dnd.some(d => d.language === 'en'), `expected DND en for low-roll code ${code}`);
      assert(dnd.some(d => d.language === 'fr'), `expected DND fr for low-roll code ${code}`);
    } else {
      assert(dnd.length === 0, `expected no DND designation for high-roll code ${code}`);
    }
  }
});

test('supplement-sqlite: full SNOMED D20 supplement + concept filter + property/designation requests', async () => {
  const dbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-snomed-d20.v0.db');
  if (!fs.existsSync(dbPath)) return { skipped: `missing fixture ${dbPath}` };
  const { lowCodes, valueByCode } = sampleD20CodesFromSupplementSqlite(dbPath, 1, 0);
  if (lowCodes.length < 1) return { skipped: 'insufficient low d20 samples in SNOMED supplement fixture' };

  const code = lowCodes[0];
  const supplement = buildSupplementResourceFromSqlite(dbPath);
  const suppCanonical = supplement.url;

  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: '=', value: code }],
  }), {
    txResources: [supplement],
    params: [
      { name: 'useSupplement', valueCanonical: suppCanonical },
      { name: 'property', valueCode: 'd20' },
      { name: 'includeDesignations', valueBoolean: true },
      { name: 'designation', valueString: 'http://example.org/fhir/CodeSystem/d20|DND' },
    ],
  });

  assertExpansionStructure(result);
  assertExpansionParams(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 1, `expected single filtered concept, got ${contains.length}`);
  const entry = contains[0];
  assert(entry.code === code, `expected code ${code}, got ${entry.code}`);

  const prop = getProperty(entry, 'd20');
  assert(prop && Number.isInteger(prop.valueInteger), `expected integer d20 property on ${code}`);
  assert(prop.valueInteger === valueByCode.get(code),
    `expected d20=${valueByCode.get(code)} on ${code}, got ${JSON.stringify(prop)}`);
  const dnd = (entry.designation || []).filter(d =>
    d.use?.system === 'http://example.org/fhir/CodeSystem/d20' && d.use?.code === 'DND'
  );
  assert(dnd.some(d => d.language === 'en'), `expected DND en designation for ${code}`);
  assert(dnd.some(d => d.language === 'fr'), `expected DND fr designation for ${code}`);
});

test('supplement-sqlite: filter by supplement property value can be evaluated with resource supplement fallback', async () => {
  const dbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-snomed-d20.v0.db');
  if (!fs.existsSync(dbPath)) return { skipped: `missing fixture ${dbPath}` };
  const supplement = buildSupplementResourceFromSqlite(dbPath);
  const suppCanonical = supplement.url;
  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'd20', op: '=', value: '4' }],
  }), {
    txResources: [supplement],
    params: [
      { name: 'useSupplement', valueCanonical: suppCanonical },
      { name: 'property', valueCode: 'd20' },
    ],
  });

  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'expected at least one concept for d20=4');
  for (const c of contains) {
    const prop = getProperty(c, 'd20');
    assert(prop?.valueInteger === 4, `expected d20=4 for ${c.code}, got ${JSON.stringify(prop)}`);
  }
});

test('supplement-sqlite: tx-resource supplement is negotiated as sqlite-native for query provider', async () => {
  const dbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-snomed-d20.v0.db');
  if (!fs.existsSync(dbPath)) return { skipped: `missing fixture ${dbPath}` };
  const code = sampleD20CodeForValue(dbPath, 4);
  if (!code) return { skipped: 'no SNOMED d20=4 sample available in supplement fixture' };

  const supplement = buildSupplementResourceFromSqlite(dbPath, [code]);
  const suppCanonical = supplement.url;
  const metrics = {
    nativeCalls: 0,
    nativeKinds: [],
    nativeProperties: [],
    prepareCalls: [],
  };

  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [
      { property: 'concept', op: '=', value: code },
      { property: 'd20', op: '=', value: '4' },
    ],
  }), {
    txResources: [supplement],
    params: [
      { name: 'useSupplement', valueCanonical: suppCanonical },
      { name: 'property', valueCode: 'd20' },
    ],
    patchWorker: (worker) => {
      const origResolveSupplementContext = worker.resolveSupplementContext.bind(worker);
      worker.resolveSupplementContext = async (required, request) => {
        const base = await origResolveSupplementContext(required, request);
        return {
          canonicals: () => (typeof base?.canonicals === 'function' ? base.canonicals() : []),
          markResolved: (url) => base?.markResolved?.(url),
          markUsed: (url, why) => base?.markUsed?.(url, why),
          resolvedCanonicals: () => (typeof base?.resolvedCanonicals === 'function' ? base.resolvedCanonicals() : []),
          usedCanonicals: () => (typeof base?.usedCanonicals === 'function' ? base.usedCanonicals() : []),
          native: (nativeRequest) => {
            metrics.nativeCalls += 1;
            const handle = (typeof base?.native === 'function') ? base.native(nativeRequest) : null;
            metrics.nativeKinds.push(handle?.kind || null);
            if (Array.isArray(handle?.availableProperties)) {
              metrics.nativeProperties.push(...handle.availableProperties.map(v => String(v)));
            }
            return handle;
          },
          preparePredicate: async (predicateRequest) => {
            metrics.prepareCalls.push(String(predicateRequest?.clause?.property || ''));
            return (typeof base?.preparePredicate === 'function')
              ? base.preparePredicate(predicateRequest)
              : null;
          },
          decorateMany: async (decorateRequest) => (typeof base?.decorateMany === 'function'
            ? base.decorateMany(decorateRequest)
            : new Map()),
          close: async () => {
            if (typeof base?.close === 'function') await base.close();
          },
        };
      };
    },
  });

  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 1, `expected one concept, got ${contains.length}`);
  assert(contains[0].code === code, `expected code ${code}, got ${contains[0].code}`);
  assert(getProperty(contains[0], 'd20')?.valueInteger === 4,
    `expected d20=4 property on ${code}`);

  assert(metrics.nativeCalls > 0, 'expected supplementContext.native() to be called');
  assert(metrics.nativeKinds.includes('sqlite'),
    `expected sqlite native handle, got ${JSON.stringify(metrics.nativeKinds)}`);
  assert(metrics.nativeProperties.includes('d20'),
    `expected native handle properties to include d20, got ${JSON.stringify(metrics.nativeProperties)}`);
  assert(!metrics.prepareCalls.includes('d20'),
    `expected d20 clause to avoid fallback preparePredicate, got ${JSON.stringify(metrics.prepareCalls)}`);
});

test('supplement-report: provider-owned supplement filtering avoids fallback predicates', async () => {
  const dbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-snomed-d20.v0.db');
  if (!fs.existsSync(dbPath)) return { skipped: `missing fixture ${dbPath}` };
  const code = sampleD20CodeForValue(dbPath, 4);
  if (!code) return { skipped: 'no SNOMED d20=4 sample available in supplement fixture' };

  const supplement = buildSupplementResourceFromSqlite(dbPath, [code]);
  addDerivedRarityProperty(supplement);
  const suppCanonical = supplement.url;

  const fallbackMetrics = {};

  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [
      { property: 'concept', op: '=', value: code },
      { property: 'd20', op: '=', value: '4' },
      { property: 'rarity', op: '=', value: 'low' },
    ],
  }), {
    txResources: [supplement],
    params: [
      { name: 'useSupplement', valueCanonical: suppCanonical },
      { name: 'property', valueCode: 'd20' },
      { name: 'property', valueCode: 'rarity' },
    ],
    patchWorker: (worker) => {
      const origResolveSupplementContext = worker.resolveSupplementContext.bind(worker);
      worker.resolveSupplementContext = async (required, request) => {
        const base = await origResolveSupplementContext(required, request);
        return createPredicateTrackingSupplementContext(base, fallbackMetrics, {
          allowedProperties: ['d20', 'rarity'],
        });
      };
    },
  });

  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 1, `expected one code after mixed supplement filter routing, got ${contains.length}`);
  assert(contains[0].code === code, `expected code ${code}, got ${contains[0].code}`);
  assert(getProperty(contains[0], 'd20')?.valueInteger === 4,
    `expected d20=4 property on ${code}`);
  assert(getProperty(contains[0], 'rarity')?.valueCode === 'low',
    `expected rarity=low property on ${code}`);

  const preparedProps = fallbackMetrics.prepareCalls || [];
  assert(preparedProps.length === 0,
    `expected no fallback predicate preparation when provider owns supplement filtering, got ${JSON.stringify(preparedProps)}`);
});

test('supplement-report: unsupported supplement clause fails when provider cannot handle it', async () => {
  const dbPath = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-snomed-d20.v0.db');
  if (!fs.existsSync(dbPath)) return { skipped: `missing fixture ${dbPath}` };
  const code = sampleD20CodeForValue(dbPath, 4);
  if (!code) return { skipped: 'no SNOMED d20=4 sample available in supplement fixture' };

  const supplement = buildSupplementResourceFromSqlite(dbPath, [code]);
  addDerivedRarityProperty(supplement);
  const suppCanonical = supplement.url;

  let failed = false;
  try {
    await expand(vs({
      system: SYS.SCT,
      filter: [
        { property: 'concept', op: '=', value: code },
        { property: 'd20', op: '=', value: '4' },
        { property: 'rarity-unsupported', op: '=', value: 'low' },
      ],
    }), {
      txResources: [supplement],
      params: [{ name: 'useSupplement', valueCanonical: suppCanonical }],
    });
  } catch (e) {
    failed = true;
    const msg = String(e?.message || '').toLowerCase();
    assert(msg.includes('unsupported filter clause') || msg.includes('unsupported filter'),
      `expected unsupported filter failure, got '${e?.message}'`);
  }
  assert(failed, 'expected expansion to fail when clause is neither provider-native nor fallback-preparable');
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
  assertExpansionParams(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'UCUM expansion should return at least one code');
  const unclosed = (result.expansion.extension || [])
    .find(e => e.url === 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
  assert(unclosed, 'UCUM expansion should carry valueset-unclosed extension');
  assert(unclosed.valueBoolean === true,
    `valueset-unclosed should be valueBoolean=true, got ${JSON.stringify(unclosed)}`);
  assert(unclosed.valueString == null,
    `valueset-unclosed must not use valueString, got ${JSON.stringify(unclosed)}`);
  assert(hasExtension(result.expansion, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed'),
    'UCUM expansion should carry valueset-unclosed extension');
});

// ═══════════════════════════════════════════════════════════════════════════
// Expansion metadata (parameters, warnings, provenance)
// ═══════════════════════════════════════════════════════════════════════════

test('meta: multi-system expansion emits used-codesystem for each system', async () => {
  const { result } = await expand(vs([
    { system: SYS.GENDER, concept: [{ code: 'male' }] },
    { system: SYS.PUBSTAT, concept: [{ code: 'active' }] },
  ]));
  assertExpansionStructure(result);
  assertExpansionParams(result);
  const usedCs = findParams(result, 'used-codesystem').map(p => p.valueUri || '');
  assert(usedCs.some(v => v.startsWith(SYS.GENDER)), 'should include administrative-gender in used-codesystem');
  assert(usedCs.some(v => v.startsWith(SYS.PUBSTAT)), 'should include publication-status in used-codesystem');
});

test('meta: used-codesystem dedupes repeated same-system usage', async () => {
  const { result } = await expand(vs({
    system: SYS.GENDER,
    concept: [{ code: 'male' }, { code: 'female' }, { code: 'other' }],
  }));
  assertExpansionStructure(result);
  assertExpansionParams(result);
  const usedCs = findParams(result, 'used-codesystem')
    .filter(p => typeof p.valueUri === 'string' && p.valueUri.startsWith(SYS.GENDER));
  assert(usedCs.length === 1, `expected exactly 1 used-codesystem for ${SYS.GENDER}, got ${usedCs.length}`);
});

test('meta: ValueSet import emits used-valueset parameter', async () => {
  const csUrl = `http://example.org/cs/meta-used-vs-${Date.now()}`;
  const importedVsUrl = `http://example.org/vs/meta-used-vs-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [{ code: 'a', display: 'A' }, { code: 'b', display: 'B' }],
  };
  const importedVs = {
    resourceType: 'ValueSet',
    url: importedVsUrl,
    status: 'active',
    compose: {
      include: [{ system: csUrl, concept: [{ code: 'a' }] }],
    },
  };

  const { result } = await expand(vs({ valueSet: [importedVsUrl] }), { txResources: [cs, importedVs] });
  assertExpansionStructure(result);
  assertExpansionParams(result);
  const usedVs = findParams(result, 'used-valueset');
  assert(usedVs.some(p => typeof p.valueUri === 'string' && p.valueUri.startsWith(importedVsUrl)),
    `expected used-valueset to include ${importedVsUrl}`);
});

test('meta: offset/count are echoed in expansion parameters', async () => {
  const { result } = await expand(vs({ system: SYS.USPS }), { count: 5, offset: 2 });
  assertExpansionStructure(result);
  assertExpansionParams(result);
  const offsetP = findParams(result, 'offset')[0];
  const countP = findParams(result, 'count')[0];
  assert(offsetP?.valueInteger === 2, `expected offset=2, got ${offsetP?.valueInteger}`);
  assert(countP?.valueInteger === 5, `expected count=5, got ${countP?.valueInteger}`);
  assert(result.expansion.offset === 2, `expected expansion.offset=2, got ${result.expansion.offset}`);
});

test('meta: text filter is echoed in expansion parameters', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }), { filter: 'mell', count: 5 });
  assertExpansionStructure(result);
  assertExpansionParams(result);
  const filterP = findParams(result, 'filter')[0];
  assert(filterP?.valueString === 'mell', `expected filter='mell', got '${filterP?.valueString}'`);
});

test('meta: draft code system emits warning-draft parameter', async () => {
  const csUrl = `http://example.org/cs/meta-draft-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'draft',
    content: 'complete',
    concept: [{ code: 'x', display: 'X' }],
  };

  const { result } = await expand(vs({ system: csUrl, concept: [{ code: 'x' }] }), { txResources: [cs] });
  assertExpansionStructure(result);
  assertExpansionParams(result);
  assert(findParams(result, 'warning-draft').length > 0, 'expected warning-draft parameter');
});

test('meta: retired code system emits warning-retired parameter', async () => {
  const csUrl = `http://example.org/cs/meta-retired-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'retired',
    content: 'complete',
    concept: [{ code: 'y', display: 'Y' }],
  };

  const { result } = await expand(vs({ system: csUrl, concept: [{ code: 'y' }] }), { txResources: [cs] });
  assertExpansionStructure(result);
  assertExpansionParams(result);
  assert(findParams(result, 'warning-retired').length > 0, 'expected warning-retired parameter');
});

test('meta: draft code system warning is suppressed when source ValueSet is draft', async () => {
  const csUrl = `http://example.org/cs/meta-draft-suppressed-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'draft',
    content: 'complete',
    concept: [{ code: 'z', display: 'Z' }],
  };
  const draftVs = {
    resourceType: 'ValueSet',
    url: `http://example.org/vs/meta-draft-suppressed-${Date.now()}`,
    status: 'draft',
    compose: {
      include: [{ system: csUrl, concept: [{ code: 'z' }] }],
    },
  };

  const { result } = await expand(draftVs, { txResources: [cs] });
  assertExpansionStructure(result);
  assertExpansionParams(result);
  assert(findParams(result, 'warning-draft').length === 0,
    'warning-draft should be suppressed when source ValueSet is draft');
});

test('meta: fragment content mode emits valueset-unclosed as valueBoolean', async () => {
  const csUrl = `http://example.org/cs/meta-fragment-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'fragment',
    concept: [{ code: 'f1', display: 'Fragment 1' }],
  };

  const { result } = await expand(vs({ system: csUrl, concept: [{ code: 'f1' }] }), { txResources: [cs] });
  assertExpansionStructure(result);
  assertExpansionParams(result);
  const unclosed = (result.expansion.extension || [])
    .find(e => e.url === 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
  assert(unclosed, 'fragment expansion should include valueset-unclosed extension');
  assert(unclosed.valueBoolean === true,
    `valueset-unclosed should be valueBoolean=true, got ${JSON.stringify(unclosed)}`);
  assert(unclosed.valueString == null,
    `valueset-unclosed must not use valueString, got ${JSON.stringify(unclosed)}`);
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

test('lang: includeDesignations returns designation entries for SNOMED concept', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }), {
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const dm = findCode(result.expansion.contains || [], '73211009');
  assert(dm, 'missing 73211009');
  assert(typeof dm.display === 'string' && dm.display.length > 0, 'display should be non-empty');
  assert(Array.isArray(dm.designation) && dm.designation.length > 0,
    'expected designation entries when includeDesignations=true');
  for (const d of dm.designation) {
    assert(typeof d.value === 'string' && d.value.length > 0,
      `designation missing value: ${JSON.stringify(d)}`);
  }
});

test('lang: designation parameter filters SNOMED designations by FSN use code', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }), {
    params: [
      { name: 'includeDesignations', valueBoolean: true },
      { name: 'designation', valueString: 'http://snomed.info/sct|900000000000003001' },
    ],
  });
  assertExpansionStructure(result);
  const dm = findCode(result.expansion.contains || [], '73211009');
  assert(dm, 'missing 73211009');
  const list = dm.designation || [];
  assert(list.length > 0, 'expected at least one FSN designation after designation filter');
  for (const d of list) {
    assert(d.use?.system === 'http://snomed.info/sct' && d.use?.code === '900000000000003001',
      `designation should match FSN use filter, got ${JSON.stringify(d.use)}`);
  }
  const echoed = (result.expansion.parameter || []).find(p => p.name === 'designation');
  assert(echoed, 'expansion should echo designation parameter');
});

test('lang: displayLanguage=en matches default display for SNOMED concept', async () => {
  const base = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }));
  const withEn = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }), {
    params: [{ name: 'displayLanguage', valueCode: 'en' }],
  });

  assertExpansionStructure(base.result);
  assertExpansionStructure(withEn.result);
  const a = findCode(base.result.expansion.contains || [], '73211009');
  const b = findCode(withEn.result.expansion.contains || [], '73211009');
  assert(a && b, 'both expansions should include 73211009');
  assert(typeof a.display === 'string' && a.display.length > 0, 'default display must be non-empty');
  assert(typeof b.display === 'string' && b.display.length > 0, 'en display must be non-empty');
  assert(a.display === b.display,
    `displayLanguage=en should match default display, got '${a.display}' vs '${b.display}'`);
});

test('lang: compose inline designation override is included with includeDesignations', async () => {
  const { result } = await expand(vs({
    system: SYS.GENDER,
    concept: [{
      code: 'male',
      display: 'Masculin',
      designation: [{ language: 'de', value: 'Maennlich' }],
    }],
  }), {
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const male = findCode(result.expansion.contains || [], 'male');
  assert(male, 'missing male');
  assert(male.display === 'Masculin' || male.display === 'Male',
    `display should be override or CS default, got '${male.display}'`);
  const de = (male.designation || []).find(d => d.language === 'de' && d.value === 'Maennlich');
  assert(de, 'expected inline German designation override');
});

test('lang: includeDesignations on package cs-cs whole-system is structurally valid', async () => {
  const { result } = await expand(vs({ system: SYS.GENDER }), {
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length >= 3, `expected >=3 gender codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.GENDER);
  for (const c of contains) {
    for (const d of c.designation || []) {
      assert(typeof d.value === 'string' && d.value.length > 0,
        `designation for ${c.code} missing value`);
    }
  }
});

test('lang: includeDesignations on SNOMED is-a filter returns designation content', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }), {
    count: 20,
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'expected filtered SNOMED results');
  const withDesig = contains.filter(c => Array.isArray(c.designation) && c.designation.length > 0);
  assert(withDesig.length > 0, 'expected at least one filtered result with designations');
});

test('lang: redundant designation equal to primary display is suppressed', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }), {
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const dm = findCode(result.expansion.contains || [], '73211009');
  assert(dm, 'missing 73211009');
  for (const d of dm.designation || []) {
    const redundant = d.value === dm.display
      && (!d.use || d.use?.code === 'display')
      && (!d.language || d.language.startsWith('en'));
    assert(!redundant,
      `redundant designation should be suppressed for display '${dm.display}'`);
  }
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

test('pagination-bug: preloaded map total matches full expansion when paged', async () => {
  const { result: full } = await expand(vs({ system: SYS.CURRENCY }));
  assertExpansionStructure(full);
  const fullCount = (full.expansion.contains || []).length;
  assert(fullCount > 10, `expected full expansion >10 codes, got ${fullCount}`);

  const { result: paged } = await expand(vs({ system: SYS.CURRENCY }), {
    count: 10,
    offset: 0,
    params: [{ name: 'needTotal', valueBoolean: true }],
  });
  assertExpansionStructure(paged);
  const pageContains = paged.expansion.contains || [];
  assert(pageContains.length === 10, `expected 10 paged results, got ${pageContains.length}`);
  assert(paged.expansion.total === fullCount,
    `paged total should equal full expansion size ${fullCount}, got ${paged.expansion.total}`);
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
    assert(r1.expansion.total >= c1.length,
      `when present, total should be >= page size, got ${r1.expansion.total}`);
  }
});

test('pagination: count=0 returns total only', async () => {
  const { result, trace } = await expand(vs({ system: SYS.USPS }), { count: 0 });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 0, `count=0 should return no codes, got ${contains.length}`);
  assert(result.expansion.total === 62, `total should still be 62, got ${result.expansion.total}`);
  if (EXPAND_IMPL !== 'v3') {
    assert(traceHasSpan(trace, '_handleCompose', s => s.result?.fastPath === 'count-zero-total-only'),
      'count=0 whole-system expansion should use fast-path total-only handling');
  }
});

test('pagination: high offset (>1000) works in both pushdown and fallback modes', async () => {
  const query = vs({
    system: SYS.LOINC,
    filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }],
  });

  const push = await expand(query, { count: 20, offset: 1000 });
  assertExpansionStructure(push.result);
  const pushContains = push.result.expansion.contains || [];
  assert(pushContains.length === 20, `pushdown page should have 20, got ${pushContains.length}`);

  const prev = process.env.EXPAND_DISABLE_PUSHDOWN;
  process.env.EXPAND_DISABLE_PUSHDOWN = '1';
  try {
    const fallback = await expand(query, { count: 20, offset: 1000 });
    assertExpansionStructure(fallback.result);
    const fallbackContains = fallback.result.expansion.contains || [];
    assert(fallbackContains.length === 20, `fallback page should have 20, got ${fallbackContains.length}`);

    const pushCodes = pushContains.map(c => `${c.system}|${c.code}`);
    const fallbackCodes = fallbackContains.map(c => `${c.system}|${c.code}`);
    assert(deepEqual(pushCodes, fallbackCodes),
      'pushdown and fallback pages should match at high offset');
  } finally {
    if (prev === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prev;
  }
});

test('pagination: deep offset invariant (all SNOMED) fallback must match or too-costly', async () => {
  const query = vs({ system: SYS.SCT });
  const opts = { count: 1000, offset: 50000 };

  const push = await runExpandWithImpl('v3', query, opts, true);
  assertExpansionStructure(push.result);
  const pushContains = push.result.expansion.contains || [];
  const pushKeys = pushContains.map(c => `${c.system}|${c.code}`);
  assert(pushKeys.length === 1000, `pushdown page should have 1000, got ${pushKeys.length}`);

  const prev = process.env.EXPAND_DISABLE_PUSHDOWN;
  process.env.EXPAND_DISABLE_PUSHDOWN = '1';
  try {
    let fallback;
    try {
      fallback = await runExpandWithImpl('v3', query, opts, true);
    } catch (e) {
      assert(isTooCostlyError(e),
        `fallback failed with non-too-costly error: ${e.message}`);
      return;
    }

    assertExpansionStructure(fallback.result);
    const fallbackContains = fallback.result.expansion.contains || [];
    const fallbackKeys = fallbackContains.map(c => `${c.system}|${c.code}`);
    assert(deepEqual(pushKeys, fallbackKeys),
      'fallback deep-offset page must match pushdown page when both succeed');

    const pushTotal = push.result.expansion.total;
    const fallbackTotal = fallback.result.expansion.total;
    if (fallbackTotal !== undefined) {
      assert(pushTotal !== undefined,
        'fallback returned total but pushdown did not');
      assert(fallbackTotal === pushTotal,
        `fallback total must be exact when present (push=${pushTotal}, fallback=${fallbackTotal})`);
    }
  } finally {
    if (prev === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prev;
  }
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
  ), {
    count: 5,
    offset: 0,
    params: [{ name: 'needTotal', valueBoolean: true }],
  });
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

  const { result: full } = await expand(query, { count: 1000, offset: 0 });
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

  const { result: full } = await expand(query, { count: 1000, offset: 0 });
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

  const { result: full } = await expand(query, { count: 1000, offset: 0 });
  const fullKeys = [];
  flattenContainsKeys(full.expansion.contains || [], fullKeys);
  const fullSet = new Set(fullKeys);
  assert(!fullSet.has(`${SYS.GENDER}||unknown`), 'imported unknown gender should be excluded');

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

test('logic: sqlite-v0 pushdown is active for basic concept expansion', async () => {
  if (PUSH_DOWN_DISABLED) return { skipped: 'requires pushdown enabled' };
  const { result, trace } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }, { code: '44054006' }],
  }));
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 codes, got ${contains.length}`);
  assertSqlitePushdownTrace(trace, 'expected v0.expandQuery trace span');
});

test('logic: same-system valueSet intersections constrain final include membership', async () => {
  if (PUSH_DOWN_DISABLED) return { skipped: 'requires pushdown enabled' };
  const aUrl = `http://example.org/vs/sct-a-${Date.now()}`;
  const bUrl = `http://example.org/vs/sct-b-${Date.now()}`;
  const vsA = {
    resourceType: 'ValueSet',
    url: aUrl,
    status: 'active',
    compose: {
      include: [{ system: SYS.SCT, concept: [{ code: '73211009' }, { code: '44054006' }] }],
    },
  };
  const vsB = {
    resourceType: 'ValueSet',
    url: bUrl,
    status: 'active',
    compose: {
      include: [{ system: SYS.SCT, concept: [{ code: '44054006' }, { code: '46635009' }] }],
    },
  };

  const { result, trace } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }],
    valueSet: [aUrl, bUrl],
  }), { txResources: [vsA, vsB] });

  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 1, `expected one intersection code, got ${contains.length}`);
  assert(contains[0].code === '44054006', `expected 44054006, got ${contains[0].code}`);
  assert(traceHasSpan(trace, 'v0.expandQuery'), 'expected pushdown expandQuery span for intersection case');
});

test('logic: regex filter is handled in sqlite-v0 pushdown path', async () => {
  if (PUSH_DOWN_DISABLED) return { skipped: 'requires pushdown enabled' };
  const { result, trace } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'code', op: 'regex', value: '7.*' }],
  }), { count: 20, offset: 0 });

  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'expected regex expansion to return results');
  assertSqlitePushdownTrace(trace, 'expected regex query to run in v0.expandQuery');
});

test('logic: regex filter works for literal-valued property in sqlite-v0', async () => {
  const query = vs({
    system: SYS.LOINC,
    filter: [{ property: 'STATUS', op: 'regex', value: '^ACT' }],
  });
  const opts = { count: 20, offset: 0 };

  const push = await runExpandWithImpl('v3', query, opts, true);
  assertExpansionStructure(push.result);
  const pushContains = push.result.expansion.contains || [];
  assert(pushContains.length > 0, 'expected pushdown literal-property regex to return results');
  assert(
    traceHasSpan(push.trace, 'v0.expandQuery') || traceHasSpan(push.trace, 'v3.openStream'),
    'expected provider pushdown/stream path for literal-property regex'
  );

  const prev = process.env.EXPAND_DISABLE_PUSHDOWN;
  process.env.EXPAND_DISABLE_PUSHDOWN = '1';
  try {
    const fallback = await runExpandWithImpl('v3', query, opts, true);
    assertExpansionStructure(fallback.result);
    const fallbackContains = fallback.result.expansion.contains || [];
    assert(fallbackContains.length > 0, 'expected fallback literal-property regex to return results');
  } finally {
    if (prev === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prev;
  }
});

test('logic: total policy decision table', async () => {
  const cases = [
    {
      name: 'paging partial returns unknown total',
      input: { wantPaging: true, count: 10, done: true, limitedByCap: false, textFilter: null, survivors: 42 },
      expect: { totalStatus: 'unknown', total: null },
    },
    {
      name: 'paging count=0 returns exact total when not capped',
      input: { wantPaging: true, count: 0, done: true, limitedByCap: false, textFilter: null, survivors: 99 },
      expect: { totalStatus: 'known', total: 99 },
    },
    {
      name: 'paging fully enumerated returns exact total',
      input: { wantPaging: true, count: 50, done: false, limitedByCap: false, textFilter: null, survivors: 180 },
      expect: { totalStatus: 'known', total: 180 },
    },
    {
      name: 'non-paging text-filter + cap omits total',
      input: { wantPaging: false, count: -1, done: true, limitedByCap: true, textFilter: { filter: 'abc' }, survivors: 1000 },
      expect: { totalStatus: 'off', total: null },
    },
    {
      name: 'non-paging uncapped returns exact total',
      input: { wantPaging: false, count: -1, done: false, limitedByCap: false, textFilter: null, survivors: 250 },
      expect: { totalStatus: 'known', total: 250 },
    },
  ];

  for (const tc of cases) {
    const out = decideTotalOutcome(tc.input);
    assert(out.totalStatus === tc.expect.totalStatus,
      `${tc.name}: expected totalStatus=${tc.expect.totalStatus}, got ${out.totalStatus}`);
    assert(out.total === tc.expect.total,
      `${tc.name}: expected total=${tc.expect.total}, got ${out.total}`);
  }
});

test('logic: display fast path is exercised on cs-cs provider', async () => {
  const { result, trace } = await expand(vs({ system: SYS.GENDER }));
  assertExpansionStructure(result);
  if (EXPAND_IMPL === 'v3') return { skipped: 'v3 does not expose display_fastpath trace counter' };
  const hits = trace?.counters?.display_fastpath_hits || 0;
  assert(hits > 0, `expected display fast path hits > 0, got ${hits}`);
});

test('logic: imported include/exclude valueSets (no system) apply Inc\\\\Exc semantics', async () => {
  const csUrl = `http://example.org/cs/logic-palette-${Date.now()}`;
  const includeVsUrl = `http://example.org/vs/logic-palette-include-${Date.now()}`;
  const excludeVsUrl = `http://example.org/vs/logic-palette-exclude-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'red', display: 'Red' },
      { code: 'blue', display: 'Blue' },
      { code: 'green', display: 'Green' },
      { code: 'yellow', display: 'Yellow' },
    ],
  };
  const includeVs = {
    resourceType: 'ValueSet',
    url: includeVsUrl,
    status: 'active',
    compose: {
      include: [{ system: csUrl, concept: [{ code: 'red' }, { code: 'blue' }, { code: 'green' }] }],
    },
  };
  const excludeVs = {
    resourceType: 'ValueSet',
    url: excludeVsUrl,
    status: 'active',
    compose: {
      include: [{ system: csUrl, concept: [{ code: 'blue' }] }],
    },
  };

  const { result } = await expand(vs([
    { valueSet: [includeVsUrl] },
  ], [
    { valueSet: [excludeVsUrl] },
  ]), { txResources: [cs, includeVs, excludeVs] });

  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 2, `expected 2 codes after exclusion, got ${contains.length}`);
  assert(findCode(contains, 'red')?.system === csUrl, 'red should remain');
  assert(findCode(contains, 'green')?.system === csUrl, 'green should remain');
  assert(!findCode(contains, 'blue'), 'blue should be excluded');
});

test('logic: total includes direct and imported include contributions', async () => {
  const csUrl = `http://example.org/cs/logic-total-${Date.now()}`;
  const importVsUrl = `http://example.org/vs/logic-total-import-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'red', display: 'Red' },
      { code: 'blue', display: 'Blue' },
      { code: 'green', display: 'Green' },
      { code: 'yellow', display: 'Yellow' },
    ],
  };
  const importedVs = {
    resourceType: 'ValueSet',
    url: importVsUrl,
    status: 'active',
    compose: {
      include: [{ system: csUrl, concept: [{ code: 'green' }, { code: 'yellow' }] }],
    },
  };

  const { result } = await expand(vs([
    { system: csUrl, concept: [{ code: 'red' }, { code: 'blue' }] },
    { valueSet: [importVsUrl] },
  ]), { txResources: [cs, importedVs] });

  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 4, `expected 4 total codes, got ${contains.length}`);
  assert(result.expansion.total === 4, `expected total=4, got ${result.expansion.total}`);
});

test('logic: whole-system descendant traversal keeps exact total', async () => {
  const csUrl = `http://example.org/cs/logic-whole-total-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      {
        code: 'root-a',
        display: 'Root A',
        concept: [
          { code: 'child-a1', display: 'Child A1' },
          { code: 'child-a2', display: 'Child A2' },
        ],
      },
      {
        code: 'root-b',
        display: 'Root B',
        concept: [
          { code: 'child-b1', display: 'Child B1' },
        ],
      },
    ],
  };

  const { result } = await expand(vs({ system: csUrl }), { txResources: [cs] });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  const keys = [];
  flattenContainsKeys(contains, keys);
  assert(keys.length === 5, `expected 5 flattened codes, got ${keys.length}`);
  assert(result.expansion.total === 5, `expected total=5, got ${result.expansion.total}`);
});

test('logic: total reflects imported excludes without mutating accumulated list', async () => {
  const csUrl = `http://example.org/cs/logic-total-exclude-${Date.now()}`;
  const includeVsUrl = `http://example.org/vs/logic-total-exclude-include-${Date.now()}`;
  const excludeVsUrl = `http://example.org/vs/logic-total-exclude-exclude-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'red', display: 'Red' },
      { code: 'blue', display: 'Blue' },
      { code: 'green', display: 'Green' },
      { code: 'yellow', display: 'Yellow' },
    ],
  };
  const includeVs = {
    resourceType: 'ValueSet',
    url: includeVsUrl,
    status: 'active',
    compose: {
      include: [{ system: csUrl, concept: [{ code: 'red' }, { code: 'blue' }, { code: 'green' }, { code: 'yellow' }] }],
    },
  };
  const excludeVs = {
    resourceType: 'ValueSet',
    url: excludeVsUrl,
    status: 'active',
    compose: {
      include: [{ system: csUrl, concept: [{ code: 'blue' }, { code: 'yellow' }] }],
    },
  };

  const query = vs([
    { valueSet: [includeVsUrl] },
  ], [
    { valueSet: [excludeVsUrl] },
  ]);

  const { result: full } = await expand(query, { txResources: [cs, includeVs, excludeVs] });
  assertExpansionStructure(full);
  const fullContains = full.expansion.contains || [];
  assert(fullContains.length === 2, `expected 2 survivors, got ${fullContains.length}`);
  if (full.expansion.total != null) {
    assert(full.expansion.total === 2, `expected total=2 after imported excludes, got ${full.expansion.total}`);
  }
  assert(findCode(fullContains, 'red'), 'red should remain');
  assert(findCode(fullContains, 'green'), 'green should remain');
  assert(!findCode(fullContains, 'blue'), 'blue should be excluded');
  assert(!findCode(fullContains, 'yellow'), 'yellow should be excluded');

  const { result: page } = await expand(query, { txResources: [cs, includeVs, excludeVs], count: 1, offset: 0 });
  assertExpansionStructure(page);
  const pageContains = page.expansion.contains || [];
  assert(pageContains.length === 1, `expected one item on page, got ${pageContains.length}`);
  if (page.expansion.total != null) {
    assert(page.expansion.total === 2, `paged total should remain 2, got ${page.expansion.total}`);
  }
});

test('logic: fallback deep-offset page never reports partial total', async () => {
  const query = vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '123037004' }],
  });
  const opts = {
    count: 1000,
    offset: 40000,
    params: [{ name: 'needTotal', valueBoolean: true }],
  };

  const push = await runExpandWithImpl('v3', query, opts, true);
  assertExpansionStructure(push.result);
  const pushContains = push.result.expansion.contains || [];
  const pushTotal = push.result.expansion.total;
  assert(pushContains.length === 1000, `expected 1000 pushdown results, got ${pushContains.length}`);
  assert(
    Number.isFinite(pushTotal) && pushTotal > opts.offset + pushContains.length,
    `expected exact pushdown total beyond page window, got ${pushTotal}`
  );

  const prev = process.env.EXPAND_DISABLE_PUSHDOWN;
  process.env.EXPAND_DISABLE_PUSHDOWN = '1';
  try {
    const fallback = await runExpandWithImpl('v3', query, opts, true);
    assertExpansionStructure(fallback.result);
    const fallbackContains = fallback.result.expansion.contains || [];
    const fallbackTotal = fallback.result.expansion.total;
    assert(fallbackContains.length === 1000, `expected 1000 fallback results, got ${fallbackContains.length}`);
    assert(
      fallbackTotal == null || fallbackTotal > opts.offset + fallbackContains.length,
      `fallback total must be omitted or exact (> page window); got ${fallbackTotal}`
    );
    if (fallbackTotal != null) {
      assert(
        fallbackTotal === pushTotal,
        `when both totals are present, fallback must equal pushdown; push=${pushTotal}, fallback=${fallbackTotal}`
      );
    }
  } finally {
    if (prev === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prev;
  }
});

test('logic: system exclude remains global when import include is present (pushdown guard)', async () => {
  if (PUSH_DOWN_DISABLED) return { skipped: 'requires pushdown enabled' };

  const importVsUrl = `http://example.org/vs/logic-sct-import-${Date.now()}`;
  const importedVs = {
    resourceType: 'ValueSet',
    url: importVsUrl,
    status: 'active',
    compose: {
      include: [{ system: SYS.SCT, concept: [{ code: '44054006' }] }],
    },
  };

  const { result, trace } = await expand(vs([
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    { valueSet: [importVsUrl] },
  ], [
    { system: SYS.SCT, concept: [{ code: '44054006' }] },
  ]), { txResources: [importedVs] });

  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(!findCode(contains, '44054006'), 'system exclude should remain effective across later import include');
  if (EXPAND_IMPL !== 'v3') {
    assert(traceHasSpan(trace, '_tryPushdown', s =>
      s.result?.handled === false && s.result?.reason === 'global-excludes-with-imports'
    ), 'expected pushdown guard to defer to fallback when excludes coexist with import includes');
  } else {
    assert(
      traceHasSpan(trace, 'v0.expandQuery') || traceHasSpan(trace, 'v3.openStream'),
      'expected v3 to evaluate include sources through provider stream/pushdown'
    );
  }
});

test('logic: mixed import+peer include/exclude paginates without gaps or duplicates', async () => {
  const csUrl = `http://example.org/cs/logic-page-${Date.now()}`;
  const includeVsUrl = `http://example.org/vs/logic-page-include-${Date.now()}`;
  const excludeVsUrl = `http://example.org/vs/logic-page-exclude-${Date.now()}`;
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
  const includeVs = {
    resourceType: 'ValueSet',
    url: includeVsUrl,
    status: 'active',
    compose: {
      include: [{ system: csUrl, concept: [{ code: 'red' }, { code: 'blue' }, { code: 'green' }] }],
    },
  };
  const excludeVs = {
    resourceType: 'ValueSet',
    url: excludeVsUrl,
    status: 'active',
    compose: {
      include: [{ system: csUrl, concept: [{ code: 'blue' }] }],
    },
  };
  const query = vs(
    [
      { valueSet: [includeVsUrl] },
      { system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] },
    ],
    [
      { valueSet: [excludeVsUrl] },
      { system: SYS.GENDER, concept: [{ code: 'female' }] },
    ],
  );

  const { result: full } = await expand(query, { txResources: [cs, includeVs, excludeVs], count: 100, offset: 0 });
  const fullKeys = [];
  flattenContainsKeys(full.expansion.contains || [], fullKeys);
  const fullSet = new Set(fullKeys);
  assert(fullSet.size === 3, `expected 3 final codes, got ${fullSet.size}`);

  const pagedKeys = [];
  for (let off = 0; off < 10; off++) {
    const { result: page } = await expand(query, {
      txResources: [cs, includeVs, excludeVs],
      count: 1,
      offset: off,
    });
    const keys = [];
    flattenContainsKeys(page.expansion.contains || [], keys);
    if (keys.length === 0) break;
    pagedKeys.push(...keys);
  }
  const pagedSet = new Set(pagedKeys);
  assert(pagedKeys.length === pagedSet.size, 'paged reconstruction should not duplicate codes');
  assert(pagedSet.size === fullSet.size, `paged size ${pagedSet.size} should match full size ${fullSet.size}`);
  for (const key of fullSet) {
    assert(pagedSet.has(key), `missing key from paged reconstruction: ${key}`);
  }
});

test('logic: bulk locate resolver handles >50 unique concepts in fallback mode', async () => {
  const prev = process.env.EXPAND_DISABLE_PUSHDOWN;
  process.env.EXPAND_DISABLE_PUSHDOWN = '1';
  try {
    const { result: seed } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    }), { count: 150, offset: 0 });
    const seedCodes = [...new Set((seed.expansion.contains || []).map(c => c.code).filter(Boolean))];
    const selectedCodes = seedCodes.slice(0, 60);
    assert(selectedCodes.length >= 50, `expected >=50 seed codes, got ${selectedCodes.length}`);

    const { result } = await expand(vs({
      system: SYS.SCT,
      concept: selectedCodes.map(code => ({ code })),
    }), { count: 200, offset: 0 });
    assertExpansionStructure(result);
    const gotCodes = (result.expansion.contains || []).map(c => c.code);
    const gotSet = new Set(gotCodes);
    const expectedSet = new Set(selectedCodes);
    assert(gotSet.size === expectedSet.size,
      `expected ${expectedSet.size} resolved codes, got ${gotSet.size}`);
    for (const code of expectedSet) {
      assert(gotSet.has(code), `missing code from bulk locate expansion: ${code}`);
    }
  } finally {
    if (prev === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prev;
  }
});

test('logic: low limit without pagination returns too-costly', async () => {
  let failed = false;
  try {
    await expand(vs({ system: SYS.USPS }), {
      params: [{ name: 'limit', valueInteger: 10 }],
    });
  } catch (e) {
    failed = true;
    const msg = String(e?.message || '').toLowerCase();
    assert(msg.includes('costly') || msg.includes('>10'),
      `expected too-costly style error for limit=10, got: ${e.message}`);
  }
  assert(failed, 'expected low-limit whole-system expansion to fail');
});

test('logic: low limit with pagination allows partial page', async () => {
  const { result } = await expand(vs({ system: SYS.USPS }), {
    count: 5,
    offset: 0,
    params: [{ name: 'limit', valueInteger: 10 }],
  });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 5, `expected page size 5, got ${contains.length}`);
  if (result.expansion.total !== undefined) {
    assert(result.expansion.total >= contains.length,
      `total should be >= page size when present, got ${result.expansion.total}`);
  }
});

test('logic: text-filter low-limit fallback short-circuits without total', async () => {
  const prev = process.env.EXPAND_DISABLE_PUSHDOWN;
  process.env.EXPAND_DISABLE_PUSHDOWN = '1';
  try {
    const { result } = await expand(vs({ system: SYS.SCT }), {
      filter: 'diabetes',
      params: [{ name: 'limit', valueInteger: 10 }],
    });
    assertExpansionStructure(result);
    const contains = result.expansion.contains || [];
    assert(contains.length <= 10, `expected <=10 due limit short-circuit, got ${contains.length}`);
    assert(result.expansion.total === undefined, 'expected total omitted after text-limit short-circuit');
  } finally {
    if (prev === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prev;
  }
});

test('high-value: mixed-system text filter limit boundary then success', async () => {
  const query = vs([
    {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '64572001' }],
    },
    {
      system: SYS.LOINC,
      concept: [
        { code: '2160-0' }, { code: '4548-4' }, { code: '718-7' }, { code: '1742-6' }, { code: '2345-7' },
        { code: '2951-2' }, { code: '3094-0' }, { code: '1963-8' }, { code: '1920-8' }, { code: '2093-3' },
      ],
    },
    { system: SYS.RXNORM },
  ]);

  if (!PUSH_DOWN_DISABLED) {
    let tooCostly = false;
    let lowLimitResult = null;
    try {
      lowLimitResult = await runExpandWithImpl('v3', query, {
        filter: 'aspirin',
        count: 200,
        offset: 0,
        params: [{ name: 'limit', valueInteger: 1000 }],
      }, true);
    } catch (e) {
      tooCostly = true;
      assertTooCostlyError(e, {
        context: 'with limit=1000',
        messageHints: ['too many codes', '>1000'],
      });
    }
    if (!tooCostly) {
      assertExpansionStructure(lowLimitResult.result);
      const lowLimitContains = lowLimitResult.result.expansion.contains || [];
      assert(lowLimitContains.length > 0 && lowLimitContains.length <= 200,
        `expected successful low-limit page to be bounded by requested count, got ${lowLimitContains.length}`);
    }
  }

  const push = await runExpandWithImpl('v3', query, {
    filter: 'aspirin',
    count: 200,
    offset: 0,
    params: [{ name: 'limit', valueInteger: 1600 }],
  }, true);
  assertExpansionStructure(push.result);
  const pushContains = push.result.expansion.contains || [];
  assert(pushContains.length === 200, `pushdown should return 200, got ${pushContains.length}`);
  if (!PUSH_DOWN_DISABLED && push.result.expansion.total !== undefined) {
    assert(push.result.expansion.total >= 200,
      `pushdown total should be >= 200, got ${push.result.expansion.total}`);
  } else if (push.result.expansion.total !== undefined) {
    assert(push.result.expansion.total >= 200,
      `fallback total (when present) should be >= 200, got ${push.result.expansion.total}`);
  }

  const prev = process.env.EXPAND_DISABLE_PUSHDOWN;
  process.env.EXPAND_DISABLE_PUSHDOWN = '1';
  try {
    const fallback = await runExpandWithImpl('v3', query, {
      filter: 'aspirin',
      count: 200,
      offset: 0,
      params: [{ name: 'limit', valueInteger: 1600 }],
    }, true);
    assertExpansionStructure(fallback.result);
    const fallbackContains = fallback.result.expansion.contains || [];
    assert(fallbackContains.length === 200, `fallback should return 200, got ${fallbackContains.length}`);
  } finally {
    if (prev === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prev;
  }
});

test('high-value: include.valueSet + sibling filter works at scale (pushdown and fallback)', async () => {
  const seed = await runExpandWithImpl('v3', vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '64572001' }],
  }), {
    count: 1400,
    offset: 0,
    params: [{ name: 'limit', valueInteger: 5000 }],
  }, false);

  const seedCodes = [...new Set((seed.result.expansion.contains || []).map(c => c.code).filter(Boolean))];
  const importedCodes = seedCodes.slice(0, 1200);
  assert(importedCodes.length === 1200, `expected 1200 imported codes, got ${importedCodes.length}`);

  const importedVsUrl = `http://example.org/vs/high-value-import-${Date.now()}`;
  const importedVs = {
    resourceType: 'ValueSet',
    url: importedVsUrl,
    status: 'active',
    compose: {
      include: [{
        system: SYS.SCT,
        concept: importedCodes.map(code => ({ code })),
      }],
    },
  };

  const query = vs({
    system: SYS.SCT,
    valueSet: [importedVsUrl],
    filter: [{ property: 'concept', op: 'descendent-of', value: '64572001' }],
  });
  const opts = {
    txResources: [importedVs],
    count: 200,
    offset: 400,
    params: [{ name: 'limit', valueInteger: 5000 }],
  };

  const push = await runExpandWithImpl('v3', query, opts, true);
  assertExpansionStructure(push.result);
  const pushContains = push.result.expansion.contains || [];
  assert(pushContains.length === 200, `pushdown page should have 200, got ${pushContains.length}`);

  const prev = process.env.EXPAND_DISABLE_PUSHDOWN;
  process.env.EXPAND_DISABLE_PUSHDOWN = '1';
  try {
    const fallback = await runExpandWithImpl('v3', query, opts, true);
    assertExpansionStructure(fallback.result);
    const fallbackContains = fallback.result.expansion.contains || [];
    assert(fallbackContains.length === 200, `fallback page should have 200, got ${fallbackContains.length}`);

    const importedSet = new Set(importedCodes);
    const pushKeys = pushContains.map(c => `${c.system}|${c.code}`);
    const fallbackKeys = fallbackContains.map(c => `${c.system}|${c.code}`);
    assert(new Set(pushKeys).size === pushKeys.length, 'pushdown page should not contain duplicates');
    assert(new Set(fallbackKeys).size === fallbackKeys.length, 'fallback page should not contain duplicates');
    for (const c of pushContains) {
      assert(c.system === SYS.SCT, `pushdown result should stay in SNOMED, got ${c.system}`);
      assert(importedSet.has(c.code), `pushdown code ${c.code} should be in imported ValueSet`);
    }
    for (const c of fallbackContains) {
      assert(c.system === SYS.SCT, `fallback result should stay in SNOMED, got ${c.system}`);
      assert(importedSet.has(c.code), `fallback code ${c.code} should be in imported ValueSet`);
    }
  } finally {
    if (prev === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prev;
  }
});

test('v3-invariant: same-system import+filter deep page matches with pushdown on/off', async () => {
  if (EXPAND_IMPL !== 'v3') return { skipped: 'v3-only invariant test' };

  const importedVsUrl = `http://example.org/vs/v3-import-clinical-${Date.now()}`;
  const importedVs = {
    resourceType: 'ValueSet',
    url: importedVsUrl,
    status: 'active',
    compose: {
      include: [{
        system: SYS.SCT,
        filter: [{ property: 'concept', op: 'is-a', value: '404684003' }], // Clinical finding
      }],
    },
  };

  const query = vs({
    system: SYS.SCT,
    valueSet: [importedVsUrl],
    filter: [{ property: 'concept', op: 'descendent-of', value: '64572001' }], // Disease
  });
  const opts = {
    txResources: [importedVs],
    count: 1000,
    offset: 50000,
    params: [{ name: 'limit', valueInteger: 200000 }],
  };

  const prevPushdown = process.env.EXPAND_DISABLE_PUSHDOWN;
  try {
    delete process.env.EXPAND_DISABLE_PUSHDOWN;
    const pushOn = await runExpandWithImpl('v3', query, opts, true);
    assertExpansionStructure(pushOn.result);
    assertSqlitePushdownTrace(pushOn.trace, 'expected pushdown trace in v3 pushdown-on mode');
    const onContains = pushOn.result.expansion.contains || [];
    assert(onContains.length === 1000, `pushdown-on should return 1000, got ${onContains.length}`);

    process.env.EXPAND_DISABLE_PUSHDOWN = '1';
    const pushOff = await runExpandWithImpl('v3', query, opts, true);
    assertExpansionStructure(pushOff.result);
    assert(!traceHasSpan(pushOff.trace, 'v0.expandQuery'),
      'pushdown-off should not use v0.expandQuery');
    const offContains = pushOff.result.expansion.contains || [];
    assert(offContains.length === 1000, `pushdown-off should return 1000, got ${offContains.length}`);

    const parity = compareParity(pushOn.result, pushOff.result, 'v3-pushdown-on', 'v3-pushdown-off');
    assert(parity.ok, `v3 pushdown parity mismatch (${parity.reason})`);
  } finally {
    if (prevPushdown === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prevPushdown;
  }
});

test('v3-lowering: import-intersect-with-union compiles to single provider pushdown', async () => {
  if (EXPAND_IMPL !== 'v3') return { skipped: 'v3-only test' };

  const importVsUrl = `http://example.org/vs/v3-lowering-int-union-${Date.now()}`;
  const importedVs = {
    resourceType: 'ValueSet',
    url: importVsUrl,
    status: 'active',
    compose: {
      include: [
        { system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] },
        { system: SYS.LOINC, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] },
      ],
    },
  };

  const query = vs({
    system: SYS.LOINC,
    filter: [{ property: 'COMPONENT', op: 'regex', value: '.*glucose.*' }],
    valueSet: [importVsUrl],
  });
  const opts = { txResources: [importedVs], count: 100, offset: 0 };

  const lowered = await withEnv({
    EXPAND_V3_DISABLE_QUERYIR_LOWERING: null,
    EXPAND_V3_DISABLE_FULL_ROOT_PUSHDOWN: null,
  }, async () => runExpandWithImpl('v3', query, opts, true));

  const unlowered = await withEnv({
    EXPAND_V3_DISABLE_QUERYIR_LOWERING: '1',
    EXPAND_V3_DISABLE_FULL_ROOT_PUSHDOWN: '1',
  }, async () => runExpandWithImpl('v3', query, opts, true));

  assertExpansionStructure(lowered.result);
  assertExpansionStructure(unlowered.result);
  const parity = compareParity(lowered.result, unlowered.result, 'lowered', 'unlowered');
  assert(parity.ok, `membership mismatch with lowering toggle (${parity.reason})`);

  const loweredPushSpans = traceFindSpansByName(lowered.trace, 'v0.expandQuery').length;
  const unloweredPushSpans = traceFindSpansByName(unlowered.trace, 'v0.expandQuery').length;
  assert(loweredPushSpans === 1, `expected exactly one pushdown query span with lowering, got ${loweredPushSpans}`);
  assert(unloweredPushSpans >= 2, `expected split execution without lowering, got ${unloweredPushSpans} spans`);

  return {
    spans: { lowered: loweredPushSpans, unlowered: unloweredPushSpans },
    ms: { lowered: lowered.ms, unlowered: unlowered.ms },
  };
});

test('v3-lowering: include minus union-excludes uses single provider query', async () => {
  if (EXPAND_IMPL !== 'v3') return { skipped: 'v3-only test' };

  const query = vs(
    { system: SYS.LOINC, filter: [{ property: 'COMPONENT', op: 'regex', value: '.*glucose.*' }] },
    [
      { system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] },
      { system: SYS.LOINC, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] },
    ],
  );
  const opts = { count: 100, offset: 0 };

  const lowered = await withEnv({
    EXPAND_V3_DISABLE_QUERYIR_LOWERING: null,
    EXPAND_V3_DISABLE_FULL_ROOT_PUSHDOWN: null,
  }, async () => runExpandWithImpl('v3', query, opts, true));

  const unlowered = await withEnv({
    EXPAND_V3_DISABLE_QUERYIR_LOWERING: '1',
    EXPAND_V3_DISABLE_FULL_ROOT_PUSHDOWN: '1',
  }, async () => runExpandWithImpl('v3', query, opts, true));

  assertExpansionStructure(lowered.result);
  assertExpansionStructure(unlowered.result);

  const loweredPushSpans = traceFindSpansByName(lowered.trace, 'v0.expandQuery').length;
  const unloweredPushSpans = traceFindSpansByName(unlowered.trace, 'v0.expandQuery').length;
  assert(loweredPushSpans === 1, `expected one pushdown span with lowering, got ${loweredPushSpans}`);
  assert(unloweredPushSpans >= 2, `expected split execution without lowering, got ${unloweredPushSpans}`);

  return {
    spans: { lowered: loweredPushSpans, unlowered: unloweredPushSpans },
    ms: { lowered: lowered.ms, unlowered: unlowered.ms },
  };
});

test('v3-lowering: include minus imported diff lowers to single provider query', async () => {
  if (EXPAND_IMPL !== 'v3') return { skipped: 'v3-only test' };

  const excludeVsUrl = `http://example.org/vs/v3-gap-exclude-diff-${Date.now()}`;
  const excludeVs = {
    resourceType: 'ValueSet',
    url: excludeVsUrl,
    status: 'active',
    compose: {
      include: [{ system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] }],
      exclude: [{ system: SYS.LOINC, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }],
    },
  };
  const query = vs(
    { system: SYS.LOINC, filter: [{ property: 'COMPONENT', op: 'regex', value: '.*glucose.*' }] },
    [{ valueSet: [excludeVsUrl] }],
  );
  const opts = { txResources: [excludeVs], count: 100, offset: 0 };

  const lowered = await withEnv({
    EXPAND_V3_DISABLE_QUERYIR_LOWERING: null,
    EXPAND_V3_DISABLE_FULL_ROOT_PUSHDOWN: null,
  }, async () => runExpandWithImpl('v3', query, opts, true));

  const unlowered = await withEnv({
    EXPAND_V3_DISABLE_QUERYIR_LOWERING: '1',
    EXPAND_V3_DISABLE_FULL_ROOT_PUSHDOWN: '1',
  }, async () => runExpandWithImpl('v3', query, opts, true));

  assertExpansionStructure(lowered.result);
  assertExpansionStructure(unlowered.result);

  const loweredPushSpans = traceFindSpansByName(lowered.trace, 'v0.expandQuery').length;
  const unloweredPushSpans = traceFindSpansByName(unlowered.trace, 'v0.expandQuery').length;
  assert(loweredPushSpans === 1, `expected one pushdown span with lowering, got ${loweredPushSpans}`);
  assert(unloweredPushSpans >= 2, `expected split execution without lowering, got ${unloweredPushSpans}`);

  return {
    spans: { lowered: loweredPushSpans, unlowered: unloweredPushSpans },
    ms: { lowered: lowered.ms, unlowered: unlowered.ms },
  };
});

test('v3-gap: mixed-system import pressure prevents single-provider root pushdown', async () => {
  if (EXPAND_IMPL !== 'v3') return { skipped: 'v3-only test' };

  const importVsUrl = `http://example.org/vs/v3-gap-mixed-${Date.now()}`;
  const importedVs = {
    resourceType: 'ValueSet',
    url: importVsUrl,
    status: 'active',
    compose: {
      include: [
        { system: SYS.USPS, concept: [{ code: 'CA' }, { code: 'NY' }] },
        { system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] },
      ],
    },
  };
  const query = vs({ valueSet: [importVsUrl] });
  const opts = { txResources: [importedVs], count: 50, offset: 0 };

  const run = await runExpandWithImpl('v3', query, opts, true);
  assertExpansionStructure(run.result);
  const spans = traceFindSpansByName(run.trace, 'v0.expandQuery').length;
  const systems = [...new Set((run.result.expansion.contains || []).map(c => c.system))];
  assert(systems.includes(SYS.USPS), `expected USPS results in mixed-provider run, got systems=${JSON.stringify(systems)}`);
  assert(systems.includes(SYS.LOINC), `expected LOINC results in mixed-provider run, got systems=${JSON.stringify(systems)}`);
  assert(spans >= 1, `expected at least one sqlite pushdown span for LOINC slice, got ${spans}`);
  return { spans, systems, ms: run.ms };
});

test('pagination-safety: mixed import+system high-count page is not silently capped', async () => {
  if (PUSH_DOWN_DISABLED) return { skipped: 'requires pushdown enabled' };

  const baseline = await runExpandWithImpl('v3', vs({ system: SYS.LOINC }), {
    count: 120000,
    offset: 0,
  }, false);
  const baselineCount = (baseline.result.expansion.contains || []).length;
  if (baselineCount < 120000) {
    return { skipped: `requires local LOINC with >=120000 concepts, got ${baselineCount}` };
  }

  const csUrl = `http://example.org/cs/mixed-cap-peer-${Date.now()}`;
  const vsUrl = `http://example.org/vs/mixed-cap-peer-${Date.now()}`;
  const peerCs = {
    resourceType: 'CodeSystem',
    url: csUrl,
    status: 'active',
    content: 'complete',
    concept: [{ code: 'peer-only', display: 'Peer Only' }],
  };
  const peerVs = {
    resourceType: 'ValueSet',
    url: vsUrl,
    status: 'active',
    compose: {
      include: [{ system: csUrl, concept: [{ code: 'peer-only' }] }],
    },
  };

  const mixedQuery = vs([
    { system: SYS.LOINC },
    { valueSet: [vsUrl] },
  ]);

  const mixed = await runExpandWithImpl('v3', mixedQuery, {
    txResources: [peerCs, peerVs],
    count: 120000,
    offset: 0,
  }, true);

  assertExpansionStructure(mixed.result);
  const mixedContains = mixed.result.expansion.contains || [];
  assert(
    mixedContains.length === 120000,
    `mixed import+system page should fill requested count=120000; got ${mixedContains.length}`
  );

  return {
    baselineCount,
    mixedCount: mixedContains.length,
    ms: { baseline: baseline.ms, mixed: mixed.ms },
  };
});

test('high-value: SNOMED hierarchy tail pagination is stable across modes', async () => {
  if (PUSH_DOWN_DISABLED) return { skipped: 'requires pushdown enabled' };

  const query = vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '64572001' }],
  });

  const totalProbe = await runExpandWithImpl('v3', query, { count: 0, offset: 0 }, TRACE_HEAVY);
  const total = totalProbe.result.expansion.total;
  if (!Number.isFinite(total) || total <= 2000) {
    return { skipped: `requires numeric SNOMED disease total > 2000, got ${total}` };
  }

  const tailOffset = Math.max(0, total - 500);
  const pushTail = await runExpandWithImpl('v3', query, { count: 1000, offset: tailOffset }, TRACE_HEAVY);
  const pushAfter = await runExpandWithImpl('v3', query, { count: 1000, offset: total }, TRACE_HEAVY);
  const pushTailContains = pushTail.result.expansion.contains || [];
  const pushAfterContains = pushAfter.result.expansion.contains || [];
  assert(pushTailContains.length > 0 && pushTailContains.length <= 1000,
    `pushdown tail page should be 1..1000, got ${pushTailContains.length}`);
  assert(pushAfterContains.length === 0, `pushdown page at offset=total should be empty, got ${pushAfterContains.length}`);

  const prev = process.env.EXPAND_DISABLE_PUSHDOWN;
  process.env.EXPAND_DISABLE_PUSHDOWN = '1';
  try {
    const fallbackTail = await runExpandWithImpl('v3', query, { count: 1000, offset: tailOffset }, TRACE_HEAVY);
    const fallbackAfter = await runExpandWithImpl('v3', query, { count: 1000, offset: total }, TRACE_HEAVY);
    const fallbackTailContains = fallbackTail.result.expansion.contains || [];
    const fallbackAfterContains = fallbackAfter.result.expansion.contains || [];
    assert(fallbackTailContains.length === pushTailContains.length,
      `fallback tail len ${fallbackTailContains.length} should match pushdown ${pushTailContains.length}`);
    assert(fallbackAfterContains.length === pushAfterContains.length,
      `fallback post-tail len ${fallbackAfterContains.length} should match pushdown ${pushAfterContains.length}`);

    const pushTailKeys = pushTailContains.map(c => `${c.system}|${c.code}`);
    const fallbackTailKeys = fallbackTailContains.map(c => `${c.system}|${c.code}`);
    assert(deepEqual(pushTailKeys, fallbackTailKeys),
      'tail page keys should match between pushdown and fallback for single hierarchy filter');
    return {
      total,
      tailOffset,
      ms: {
        totalProbe: totalProbe.ms,
        pushTail: pushTail.ms,
        pushAfter: pushAfter.ms,
        fallbackTail: fallbackTail.ms,
        fallbackAfter: fallbackAfter.ms,
      },
    };
  } finally {
    if (prev === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prev;
  }
});

test('high-value: complex same-system include/exclude pages are internally consistent per mode', async () => {
  const query = vs(
    [
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '64572001' }] },
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '123037004' }] },
    ],
    [
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '442083009' }] },
    ],
  );
  const opts1 = { count: 1000, offset: 50000, params: [{ name: 'limit', valueInteger: 200000 }] };
  const opts2 = { count: 1000, offset: 51000, params: [{ name: 'limit', valueInteger: 200000 }] };

  const push1 = await runExpandWithImpl('v3', query, opts1, TRACE_HEAVY);
  const push2 = await runExpandWithImpl('v3', query, opts2, TRACE_HEAVY);
  const push1Contains = push1.result.expansion.contains || [];
  const push2Contains = push2.result.expansion.contains || [];
  assert(push1Contains.length === 1000, `pushdown page1 should have 1000, got ${push1Contains.length}`);
  assert(push2Contains.length === 1000, `pushdown page2 should have 1000, got ${push2Contains.length}`);
  const push1Keys = new Set(push1Contains.map(c => `${c.system}|${c.code}`));
  const push2Keys = new Set(push2Contains.map(c => `${c.system}|${c.code}`));
  assert(push1Keys.size === push1Contains.length, 'pushdown page1 should not contain duplicates');
  assert(push2Keys.size === push2Contains.length, 'pushdown page2 should not contain duplicates');
  const pushOverlap = [...push1Keys].filter(k => push2Keys.has(k));
  assert(pushOverlap.length === 0, `pushdown adjacent pages should not overlap, got ${pushOverlap.length}`);

  const prev = process.env.EXPAND_DISABLE_PUSHDOWN;
  process.env.EXPAND_DISABLE_PUSHDOWN = '1';
  try {
    const fb1 = await runExpandWithImpl('v3', query, opts1, TRACE_HEAVY);
    const fb2 = await runExpandWithImpl('v3', query, opts2, TRACE_HEAVY);
    const fb1Contains = fb1.result.expansion.contains || [];
    const fb2Contains = fb2.result.expansion.contains || [];
    assert(fb1Contains.length === 1000, `fallback page1 should have 1000, got ${fb1Contains.length}`);
    assert(fb2Contains.length === 1000, `fallback page2 should have 1000, got ${fb2Contains.length}`);
    const fb1Keys = new Set(fb1Contains.map(c => `${c.system}|${c.code}`));
    const fb2Keys = new Set(fb2Contains.map(c => `${c.system}|${c.code}`));
    assert(fb1Keys.size === fb1Contains.length, 'fallback page1 should not contain duplicates');
    assert(fb2Keys.size === fb2Contains.length, 'fallback page2 should not contain duplicates');
    const fbOverlap = [...fb1Keys].filter(k => fb2Keys.has(k));
    assert(fbOverlap.length === 0, `fallback adjacent pages should not overlap, got ${fbOverlap.length}`);
    return {
      opts1,
      opts2,
      ms: {
        push1: push1.ms,
        push2: push2.ms,
        fallback1: fb1.ms,
        fallback2: fb2.ms,
      },
      overlap: {
        push: pushOverlap.length,
        fallback: fbOverlap.length,
      },
    };
  } finally {
    if (prev === undefined) delete process.env.EXPAND_DISABLE_PUSHDOWN;
    else process.env.EXPAND_DISABLE_PUSHDOWN = prev;
  }
});

test('supplement d20+d8 loinc: active,d20=20,d8=8 returns latin designation and no french', async () => {
  const d20Path = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-loinc-d20.v0.db');
  const d8Path = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-loinc-d8.v0.db');
  if (!fs.existsSync(d20Path) || !fs.existsSync(d8Path)) {
    return { skipped: `missing fixtures ${d20Path} or ${d8Path}` };
  }

  const { result } = await expand(vs({
    system: 'http://loinc.org',
    filter: [
      { property: 'STATUS', op: '=', value: 'ACTIVE' },
      { property: 'd20', op: '=', value: '20' },
      { property: 'd8', op: '=', value: '8' },
    ],
  }), {
    params: [
      { name: 'useSupplement', valueCanonical: 'http://example.org/fhir/CodeSystem/supplement-loinc-d20' },
      { name: 'useSupplement', valueCanonical: 'http://example.org/fhir/CodeSystem/supplement-loinc-d8' },
      { name: 'includeDesignations', valueBoolean: true },
      { name: 'designation', valueString: 'fr' },
      { name: 'designation', valueString: 'la' },
      { name: 'count', valueInteger: 1000 },
      { name: 'offset', valueInteger: 0 },
    ],
  });

  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'expected at least one LOINC match for STATUS=ACTIVE,d20=20,d8=8');

  let la = 0;
  let fr = 0;
  for (const c of contains) {
    const dnds = (c.designation || []).filter(d => d?.use?.code === 'DND');
    for (const d of dnds) {
      const lang = String(d.language || '').toLowerCase();
      if (lang === 'la') la++;
      if (lang === 'fr') fr++;
    }
  }
  assert(la > 0, 'expected latin DND designations from d8 supplement');
  assert(fr === 0, `expected no french DND designations when d20=20, got ${fr}`);

  const usedSupps = (result.expansion.parameter || [])
    .filter(p => p.name === 'used-supplement')
    .map(p => p.valueUri || p.valueCanonical || p.valueString);
  assert(usedSupps.includes('http://example.org/fhir/CodeSystem/supplement-loinc-d20'),
    `expected used-supplement loinc-d20, got ${JSON.stringify(usedSupps)}`);
  assert(usedSupps.includes('http://example.org/fhir/CodeSystem/supplement-loinc-d8'),
    `expected used-supplement loinc-d8, got ${JSON.stringify(usedSupps)}`);

  return { contains: contains.length, la, fr };
});

test('supplement d20+d8 loinc: active,d20=4,d8=8 returns both french and latin designations', async () => {
  const d20Path = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-loinc-d20.v0.db');
  const d8Path = path.join(__dirname, 'fixtures', 'sqlite-supplements', 'supplement-loinc-d8.v0.db');
  if (!fs.existsSync(d20Path) || !fs.existsSync(d8Path)) {
    return { skipped: `missing fixtures ${d20Path} or ${d8Path}` };
  }

  const { result } = await expand(vs({
    system: 'http://loinc.org',
    filter: [
      { property: 'STATUS', op: '=', value: 'ACTIVE' },
      { property: 'd20', op: '=', value: '4' },
      { property: 'd8', op: '=', value: '8' },
    ],
  }), {
    params: [
      { name: 'useSupplement', valueCanonical: 'http://example.org/fhir/CodeSystem/supplement-loinc-d20' },
      { name: 'useSupplement', valueCanonical: 'http://example.org/fhir/CodeSystem/supplement-loinc-d8' },
      { name: 'includeDesignations', valueBoolean: true },
      { name: 'designation', valueString: 'fr' },
      { name: 'designation', valueString: 'la' },
      { name: 'count', valueInteger: 1000 },
      { name: 'offset', valueInteger: 0 },
    ],
  });

  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'expected at least one LOINC match for STATUS=ACTIVE,d20=4,d8=8');

  let la = 0;
  let fr = 0;
  for (const c of contains) {
    const dnds = (c.designation || []).filter(d => d?.use?.code === 'DND');
    for (const d of dnds) {
      const lang = String(d.language || '').toLowerCase();
      if (lang === 'la') la++;
      if (lang === 'fr') fr++;
    }
  }
  assert(la > 0, 'expected latin DND designations from d8 supplement');
  assert(fr > 0, 'expected french DND designations from d20 supplement when d20=4');

  return { contains: contains.length, la, fr };
});

// ── Runner ─────────────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isTooCostlyError(e) {
  if (!e) return false;
  if (e.toocostly === true) return true;
  if (e.issueCode === 'too-costly') return true;
  const msg = String(e.message || '');
  return /VALUESET_TOO_COSTLY|too-costly/i.test(msg);
}

function assertTooCostlyError(e, opts = {}) {
  const context = opts.context ? ` ${opts.context}` : '';
  const messageHints = Array.isArray(opts.messageHints) ? opts.messageHints : [];
  const msg = String(e?.message || '').toLowerCase();
  const hinted = messageHints.some(h => msg.includes(String(h).toLowerCase()));
  assert(isTooCostlyError(e) || hinted,
    `expected too-costly${context}, got: ${e?.message || e}`);
}

function shouldPrintTrace(status) {
  if (!TRACE_ENABLED) return false;
  if (TRACE_PRINT === 'off' || TRACE_PRINT === 'none') return false;
  if (TRACE_PRINT === 'all') return true;
  return status === 'fail';
}

function renderTrace(traceJson) {
  if (!traceJson) return 'trace unavailable';
  if (TRACE_FORMAT === 'json') {
    return JSON.stringify(traceJson, null, 2);
  }
  return formatTraceSummary(traceJson, { maxSpans: TRACE_MAX_SPANS });
}

function printTrace(traceJson) {
  if (!traceJson) return;
  console.log('  ── trace ──');
  console.log(renderTrace(traceJson).split('\n').map(l => '    ' + l).join('\n'));
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
        if (shouldPrintTrace('skip')) printTrace(_lastExpandTrace);
        skipped++;
      } else {
        const info = extra ? ` ${JSON.stringify(extra)}` : '';
        console.log(`  ✅ ${t.name} (${ms}ms)${info}`);
        if (shouldPrintTrace('pass')) printTrace(_lastExpandTrace);
        passed++;
      }
      results.push({
        name: t.name,
        status: 'pass',
        ms,
        extra,
        ...(TRACE_ENABLED ? { trace: _lastExpandTrace } : {}),
      });
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      console.log(`  ❌ ${t.name} (${ms}ms) — ${e.message}`);
      if (process.env.HARNESS_VERBOSE) console.log(e.stack);
      if (shouldPrintTrace('fail')) printTrace(_lastExpandTrace);
      failed++;
      results.push({ name: t.name, status: 'fail', ms, error: e.message, trace: _lastExpandTrace });
    } finally {
      _currentTestName = null;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  printProviderCoverageReport();
  printAssessmentStatusReport(results);

  if (TRACE_ENABLED || process.env.EXPAND_TRACE_RESULTS) {
    const outPath = path.isAbsolute(TRACE_RESULTS_FILE)
      ? TRACE_RESULTS_FILE
      : path.join(__dirname, TRACE_RESULTS_FILE);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`Results written to ${outPath}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
