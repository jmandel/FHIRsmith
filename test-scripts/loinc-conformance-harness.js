#!/usr/bin/env node
'use strict';

// LOINC conformance diff harness.
//
// Replays the official tx-ecosystem LOINC reference cases
// (~/.fhir/packages/hl7.fhir.uv.tx-ecosystem#current/package/tests/tx.fhir.org/
// loinc-*) directly through the workers (LookupWorker / ValidateWorker /
// ExpandWorker) against the sqlite-v1 LOINC provider, then diffs each actual
// response against the reference expected response using the suite's
// comparison semantics:
//   * array order never matters (bipartite-ish greedy matching),
//   * "$optional$" elements / "$optional-properties$" keys may be absent,
//   * "$id$" / "$uuid$" / "$instant$" match any value,
//   * everything else must match exactly (extra actual content is a failure).
//
// Usage:
//   node test-scripts/loinc-conformance-harness.js [--filter substr] [--verbose]
//   node test-scripts/loinc-conformance-harness.js --db /path/to/loinc.db
//
// Exit code 0 iff every selected case matches.

const fs = require('fs');
const path = require('path');

const LookupWorker = require('../tx/workers/lookup.js');
const { ValidateWorker } = require('../tx/workers/validate.js');
const { ExpandWorker } = require('../tx/workers/expand.js');
const { SqliteCodeSystemFactory } = require('../tx/cs/cs-sqlite.js');
const { OperationContext } = require('../tx/operation-context.js');
const { LanguageDefinitions } = require('../library/languages.js');
const { I18nSupport } = require('../library/i18nsupport.js');
const { CodeSystem } = require('../tx/library/codesystem.js');
const ValueSet = require('../tx/library/valueset.js');
const { FhirCodeSystemProvider } = require('../tx/cs/cs-cs.js');

const HOME = process.env.HOME;
const TESTS_DIR = path.join(
  HOME, '.fhir/packages/hl7.fhir.uv.tx-ecosystem#current/package/tests');
const UZ_SUPPLEMENT = path.join(
  HOME, '.fhir/packages/fhir.tx.support.r4#0.37.0/package/CodeSystem-loinc-supplement-uz.json');
const DEFAULT_DB = path.join(HOME, 'work/tx-dbs/loinc-v1.db');
const LOINC = 'http://loinc.org';

const quietLog = { error: () => {}, debug: () => {}, log: () => {}, info: () => {}, warn: () => {} };

// ---------------------------------------------------------------------------
// comparison (official-suite semantics)
// ---------------------------------------------------------------------------

const META_KEYS = new Set(['$optional$', '$optional-properties$']);
const WILDCARDS = new Set(['$id$', '$uuid$', '$instant$', '$semver$', '$version$', '$date$', '$url$']);
// Keys the official runner normalizes away: `diagnostics` is debug-only output
// and `location` is the R4 twin of `expression` (the validator maps between
// them across FHIR versions).
const IGNORED_KEYS = new Set(['diagnostics', 'location']);

function realKeys(obj) {
  return Object.keys(obj).filter((k) => !META_KEYS.has(k) && !IGNORED_KEYS.has(k) && obj[k] !== undefined);
}

function isOptional(node) {
  return !!(node && typeof node === 'object' && !Array.isArray(node) &&
    Object.prototype.hasOwnProperty.call(node, '$optional$'));
}

/** Boolean structural match, order-insensitive arrays, $ markers honored. */
function matches(exp, act) {
  if (Array.isArray(exp)) {
    if (!Array.isArray(act)) return false;
    return matchArray(exp, act) === null;
  }
  if (exp !== null && typeof exp === 'object') {
    if (act === null || typeof act !== 'object' || Array.isArray(act)) return false;
    const optionalProps = new Set(exp['$optional-properties$'] || []);
    const actKeys = new Set(realKeys(act));
    for (const k of realKeys(exp)) {
      if (!actKeys.has(k)) {
        if (optionalProps.has(k) || isOptional(exp[k])) continue;
        return false;
      }
      if (!matches(exp[k], act[k])) return false;
    }
    for (const k of actKeys) {
      if (!(k in exp)) return false;
    }
    return true;
  }
  if (typeof exp === 'string' && WILDCARDS.has(exp)) return act !== undefined && act !== null;
  return exp === act;
}

/**
 * Order-insensitive array match. Returns null on success, else
 * { unmatchedExpected: [...], unmatchedActual: [...] }.
 * Greedy with exact-first pass; adequate because elements are distinctive.
 */
function matchArray(exp, act) {
  const usedAct = new Array(act.length).fill(false);
  const unmatchedExpected = [];
  for (const e of exp) {
    let found = -1;
    for (let j = 0; j < act.length; j++) {
      if (!usedAct[j] && matches(e, act[j])) { found = j; break; }
    }
    if (found >= 0) usedAct[found] = true;
    else if (!isOptional(e)) unmatchedExpected.push(e);
  }
  const unmatchedActual = act.filter((_, j) => !usedAct[j]);
  if (unmatchedExpected.length === 0 && unmatchedActual.length === 0) return null;
  return { unmatchedExpected, unmatchedActual };
}

/** Human-oriented list of differences (path-labelled). */
function explain(exp, act, pathStr, out) {
  if (Array.isArray(exp)) {
    if (!Array.isArray(act)) { out.push(`${pathStr}: expected array, got ${JSON.stringify(act)}`); return; }
    const res = matchArray(exp, act);
    if (res) {
      for (const e of res.unmatchedExpected) out.push(`${pathStr}: MISSING expected ${label(e)}: ${short(e)}`);
      for (const a of res.unmatchedActual) out.push(`${pathStr}: EXTRA actual ${label(a)}: ${short(a)}`);
    }
    return;
  }
  if (exp !== null && typeof exp === 'object') {
    if (act === null || typeof act !== 'object' || Array.isArray(act)) {
      out.push(`${pathStr}: expected object, got ${short(act)}`); return;
    }
    const optionalProps = new Set(exp['$optional-properties$'] || []);
    const actKeys = new Set(realKeys(act));
    for (const k of realKeys(exp)) {
      if (!actKeys.has(k)) {
        if (!optionalProps.has(k) && !isOptional(exp[k])) out.push(`${pathStr}.${k}: missing (expected ${short(exp[k])})`);
        continue;
      }
      if (!matches(exp[k], act[k])) explain(exp[k], act[k], `${pathStr}.${k}`, out);
    }
    for (const k of actKeys) {
      if (!(k in exp)) out.push(`${pathStr}.${k}: unexpected (actual ${short(act[k])})`);
    }
    return;
  }
  if (!matches(exp, act)) out.push(`${pathStr}: expected ${short(exp)}, actual ${short(act)}`);
}

function label(el) {
  if (el && typeof el === 'object' && !Array.isArray(el)) {
    if (el.name === 'property' && Array.isArray(el.part)) {
      const code = el.part.find((p) => p.name === 'code');
      const lang = el.part.find((p) => p.name === 'language');
      return `property[${code ? code.valueCode : '?'}${lang ? ',' + lang.valueCode : ''}]`;
    }
    if (el.name === 'designation' && Array.isArray(el.part)) {
      const lang = el.part.find((p) => p.name === 'language');
      const use = el.part.find((p) => p.name === 'use');
      return `designation[${lang ? lang.valueCode : '?'},${use && use.valueCoding ? use.valueCoding.code : '?'}]`;
    }
    if (el.name) return `param[${el.name}]`;
    if (el.code) return `contains[${el.code}]`;
  }
  return 'item';
}

function short(v) {
  const s = JSON.stringify(v);
  return s && s.length > 220 ? s.slice(0, 220) + '…' : s;
}

// ---------------------------------------------------------------------------
// environment: provider stub + setup resources
// ---------------------------------------------------------------------------

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }

function buildStub(factory, i18n) {
  // Setup resources for the tx.fhir.org suite (pre-registered on the server).
  const manifest = loadJson(path.join(TESTS_DIR, 'test-cases.json'));
  const suite = manifest.suites.find((s) => s.name === 'tx.fhir.org');
  const valueSets = new Map();
  const supplements = [];
  for (const rel of suite.setup || []) {
    const res = loadJson(path.join(TESTS_DIR, rel));
    if (res.resourceType === 'ValueSet') valueSets.set(res.url, res);
    else if (res.resourceType === 'CodeSystem' && res.content === 'supplement') {
      supplements.push(new CodeSystem(res));
    }
  }
  supplements.push(new CodeSystem(loadJson(UZ_SUPPLEMENT)));

  return {
    tests: suite.tests,
    provider: {
      getCodeSystemProvider: async (op, system, version, supps) => {
        let url = system, v = version || null;
        if (url.includes('|')) { v = url.split('|')[1]; url = url.split('|')[0]; }
        if (url !== LOINC) return null;
        if (v && v !== factory.version()) return null;
        return factory.build(op, supps || []);
      },
      createCodeSystemProvider: async (op, cs, supps) => new FhirCodeSystemProvider(op, cs, supps || []),
      loadSupplements: (url, _version, statedSupplements) => {
        const out = [];
        for (const s of supplements) {
          const target = s.jsonObj.supplements;
          const base = target.includes('|') ? target.split('|')[0] : target;
          if (base !== url) continue;
          if (s.isLangPack() || (statedSupplements && (statedSupplements.has(s.url) || statedSupplements.has(s.vurl)))) {
            out.push(s);
          }
        }
        return out;
      },
      findValueSet: async (_op, url, version) => {
        const vs = valueSets.get(url);
        if (vs && (!version || vs.version === version)) return new ValueSet(vs);
        const known = await factory.buildKnownValueSet(url, version);
        return known ? new ValueSet(known) : null;
      },
      listCodeSystemVersions: async (url) => (url === LOINC ? [factory.version()] : []),
      getCodeSystemById: () => null,
      getFhirVersion: () => 'R5',
    },
    i18n,
  };
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function runCase(test, env, langDefs) {
  const request = loadJson(path.join(TESTS_DIR, test.request));
  const op = new OperationContext('en', env.i18n);
  const req = { method: 'POST', body: request, query: {}, params: {}, headers: {} };
  const res = mockRes();
  try {
    if (test.operation === 'lookup') {
      const w = new LookupWorker(op, quietLog, env.provider, langDefs, env.i18n);
      await w.handle(req, res);
    } else if (test.operation === 'cs-validate-code') {
      const w = new ValidateWorker(op, quietLog, env.provider, langDefs, env.i18n);
      await w.handleCodeSystem(req, res);
    } else if (test.operation === 'validate-code') {
      const w = new ValidateWorker(op, quietLog, env.provider, langDefs, env.i18n);
      await w.handleValueSet(req, res);
    } else if (test.operation === 'expand') {
      // Official-suite limits (test-runner posts as the validator's UA):
      // internal 10000, external 3000.
      const w = new ExpandWorker(op, quietLog, env.provider, langDefs, env.i18n, 10000, 3000);
      await w.handle(req, res);
    } else {
      return { skipped: `unsupported operation ${test.operation}` };
    }
  } finally {
    await op.closeProviders?.();
  }
  return { status: res.statusCode, body: res.body };
}

async function main() {
  const args = process.argv.slice(2);
  const getOpt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const filter = getOpt('--filter');
  const verbose = args.includes('--verbose');
  const dbPath = getOpt('--db') || DEFAULT_DB;
  const dumpDir = getOpt('--dump'); // write actual responses here for inspection

  const langDefs = await LanguageDefinitions.fromFiles(path.join(__dirname, '../tx/data'));
  const i18n = new I18nSupport(path.join(__dirname, '../translations'), langDefs);
  await i18n.load();

  const factory = new SqliteCodeSystemFactory(i18n, dbPath);
  await factory.load();
  const env = buildStub(factory, i18n);

  const cases = env.tests.filter((t) =>
    t.request && t.request.includes('/loinc-') && (!filter || t.name.includes(filter)));

  let pass = 0, fail = 0;
  const failures = [];
  for (const test of cases) {
    const expected = loadJson(path.join(TESTS_DIR, test.response));
    let outcome;
    try {
      outcome = await runCase(test, env, langDefs);
    } catch (e) {
      outcome = { status: 'EXCEPTION', body: { error: e.message, stack: e.stack } };
    }
    if (outcome.skipped) { console.log(`SKIP ${test.name}: ${outcome.skipped}`); continue; }
    if (dumpDir) {
      fs.mkdirSync(dumpDir, { recursive: true });
      fs.writeFileSync(path.join(dumpDir, `${test.name}.json`),
        JSON.stringify({ status: outcome.status, body: outcome.body }, null, 2));
    }

    // http-code expectation (e.g. "4xx") for error cases.
    let httpOk = true;
    if (test['http-code']) {
      const pat = String(test['http-code']).replace(/x/g, '\\d');
      httpOk = new RegExp(`^${pat}$`).test(String(outcome.status));
    } else {
      httpOk = outcome.status === 200;
    }

    const problems = [];
    if (!httpOk) problems.push(`http status: expected ${test['http-code'] || 200}, got ${outcome.status}`);
    explain(expected, outcome.body, '$', problems);

    if (problems.length === 0) {
      pass++;
      console.log(`PASS ${test.name}`);
    } else {
      fail++;
      failures.push(test.name);
      console.log(`FAIL ${test.name}`);
      const max = verbose ? problems.length : 12;
      for (const p of problems.slice(0, max)) console.log(`     ${p}`);
      if (problems.length > max) console.log(`     … ${problems.length - max} more`);
      if (verbose && outcome.body && outcome.body.error) console.log(outcome.body.stack);
    }
  }

  console.log(`\n${pass}/${pass + fail} LOINC reference cases match` +
    (fail ? `; failing: ${failures.join(', ')}` : ''));
  await factory.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
