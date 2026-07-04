/* eslint-disable */
// Differential harness: SNOMED official cases vs sqlite-v1 provider output.
//
// Starts the real TX server on the sqlite fixtures library
// (tx/fixtures/test-cases-sqlite.yml) and POSTs each official SNOMED request
// ($expand/$validate-code/$lookup/...), comparing the response to the expected
// fixture with the OFFICIAL suite's comparison semantics ($optional/$id/$uuid/
// $instant wildcards, order-insensitive arrays, extra-key rejection) — the same
// matcher as test-scripts/loinc-conformance-harness.js.
//
// Suite setup ValueSets/CodeSystems are injected as tx-resource parameters so
// url-referenced value sets resolve. undici's fetch injects `accept-language: *`
// (the real runner sends none), so we strip it — otherwise every expansion
// gains a spurious displayLanguage=* parameter.
//
// Usage:  node test-scripts/sct-conformance-harness.js          # all SNOMED cases
//         TX_EXPAND_ENGINE=legacy|pushdown|ir node ...          # one engine
//         ONLY=case-name,... VERBOSE=1 node ...                 # focused diffs
//         DUMP=1 ONLY=case node ...                             # write /tmp/actual-<case>.json
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const TXModule = require(path.join(ROOT, 'tx/tx.js'));
const ServerStats = require(path.join(ROOT, 'stats'));

const TESTS = '/home/jmandel/.fhir/packages/hl7.fhir.uv.tx-ecosystem#current/package/tests';
const PORT = 9099;
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const VERBOSE = process.env.VERBOSE === '1';

const OP_ENDPOINT = {
  'expand': 'ValueSet/$expand',
  'validate-code': 'ValueSet/$validate-code',
  'cs-validate-code': 'CodeSystem/$validate-code',
  'lookup': 'CodeSystem/$lookup',
  'translate': 'ConceptMap/$translate',
};

// ---- comparison (official-suite semantics; from loinc-conformance-harness) --
const META_KEYS = new Set(['$optional$', '$optional-properties$']);
const WILDCARDS = new Set(['$id$', '$uuid$', '$instant$', '$semver$', '$version$', '$date$', '$url$']);
const IGNORED_KEYS = new Set(['diagnostics', 'location']);
function realKeys(obj) { return Object.keys(obj).filter((k) => !META_KEYS.has(k) && !IGNORED_KEYS.has(k) && obj[k] !== undefined); }
function isOptional(node) {
  return !!(node && typeof node === 'object' && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, '$optional$'));
}
function matches(exp, act) {
  if (Array.isArray(exp)) { if (!Array.isArray(act)) return false; return matchArray(exp, act) === null; }
  if (exp !== null && typeof exp === 'object') {
    if (act === null || typeof act !== 'object' || Array.isArray(act)) return false;
    const optionalProps = new Set(exp['$optional-properties$'] || []);
    const actKeys = new Set(realKeys(act));
    for (const k of realKeys(exp)) {
      if (!actKeys.has(k)) { if (optionalProps.has(k) || isOptional(exp[k])) continue; return false; }
      if (!matches(exp[k], act[k])) return false;
    }
    for (const k of actKeys) { if (!(k in exp)) return false; }
    return true;
  }
  if (typeof exp === 'string' && WILDCARDS.has(exp)) return act !== undefined && act !== null;
  return exp === act;
}
function matchArray(exp, act) {
  const usedAct = new Array(act.length).fill(false);
  const unmatchedExpected = [];
  for (const e of exp) {
    let found = -1;
    for (let j = 0; j < act.length; j++) { if (!usedAct[j] && matches(e, act[j])) { found = j; break; } }
    if (found >= 0) usedAct[found] = true;
    else if (!isOptional(e)) unmatchedExpected.push(e);
  }
  const unmatchedActual = act.filter((_, j) => !usedAct[j]);
  if (unmatchedExpected.length === 0 && unmatchedActual.length === 0) return null;
  return { unmatchedExpected, unmatchedActual };
}
function short(v) { const s = JSON.stringify(v); return s && s.length > 240 ? s.slice(0, 240) + '…' : s; }
function explain(exp, act, pathStr, out) {
  if (out.length > 60) return;
  if (Array.isArray(exp)) {
    if (!Array.isArray(act)) { out.push(`${pathStr}: expected array, got ${short(act)}`); return; }
    const res = matchArray(exp, act);
    if (res) {
      for (const e of res.unmatchedExpected) out.push(`${pathStr}: MISSING ${short(e)}`);
      for (const a of res.unmatchedActual) out.push(`${pathStr}: EXTRA ${short(a)}`);
    }
    return;
  }
  if (exp !== null && typeof exp === 'object') {
    if (act === null || typeof act !== 'object' || Array.isArray(act)) { out.push(`${pathStr}: expected object, got ${short(act)}`); return; }
    const optionalProps = new Set(exp['$optional-properties$'] || []);
    const actKeys = new Set(realKeys(act));
    for (const k of realKeys(exp)) {
      if (!actKeys.has(k)) { if (!optionalProps.has(k) && !isOptional(exp[k])) out.push(`${pathStr}.${k}: missing (expected ${short(exp[k])})`); continue; }
      if (!matches(exp[k], act[k])) explain(exp[k], act[k], `${pathStr}.${k}`, out);
    }
    for (const k of actKeys) { if (!(k in exp)) out.push(`${pathStr}.${k}: unexpected (actual ${short(act[k])})`); }
    return;
  }
  if (!matches(exp, act)) out.push(`${pathStr}: expected ${short(exp)}, actual ${short(act)}`);
}

async function post(endpoint, body) {
  const r = await fetch(`http://localhost:${PORT}/r5/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

async function main() {
  const app = express();
  // undici's fetch injects a default `accept-language: *`; the real conformance
  // runner sends none. Strip it so the harness measures true provider behavior
  // (a bare wildcard would otherwise surface as a spurious displayLanguage=*).
  app.use((req, _res, next) => { delete req.headers['accept-language']; next(); });
  app.use(express.json({ limit: '50mb' }));
  const stats = new ServerStats();
  const tx = new TXModule(stats);
  const config = {
    enabled: true, consoleErrors: false, host: 'local.host',
    librarySource: 'tx/fixtures/test-cases-sqlite.yml',
    endpoints: [{ path: '/r5', fhirVersion: '5.0', context: null }, { path: '/r4', fhirVersion: '4.0', context: null }],
  };
  await tx.initialize(config, app);
  const server = await new Promise((res) => { const s = app.listen(PORT, () => res(s)); });

  const manifest = JSON.parse(fs.readFileSync(path.join(TESTS, 'test-cases.json'), 'utf8'));
  const cases = [];
  for (const s of manifest.suites) {
    // Suite setup resources (ValueSets/CodeSystems) are registered on the real
    // server; inject them as tx-resource parameters so url-referenced VS resolve.
    const setup = [];
    for (const f of s.setup || []) {
      const p = path.join(TESTS, f);
      if (fs.existsSync(p)) { try { setup.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch { /* xml etc */ } }
    }
    for (const t of s.tests || []) {
      const req = t.request, resp = t.response;
      if (!req || !resp) continue;
      const rp = path.join(TESTS, req), sp = path.join(TESTS, resp);
      if (!fs.existsSync(rp) || !fs.existsSync(sp)) continue;
      const rtxt = fs.readFileSync(rp, 'utf8'), stxt = fs.readFileSync(sp, 'utf8');
      if (!rtxt.includes('snomed.info/sct') && !stxt.includes('snomed.info/sct')) continue;
      if (!OP_ENDPOINT[t.operation]) continue;
      const reqBody = JSON.parse(rtxt);
      if (reqBody.resourceType === 'Parameters' && setup.length) {
        reqBody.parameter = reqBody.parameter || [];
        for (const r of setup) reqBody.parameter.push({ name: 'tx-resource', resource: r });
      }
      cases.push({ suite: s.name, name: t.name, op: t.operation, req: reqBody, exp: JSON.parse(stxt) });
    }
  }

  const byOp = {};
  const fails = [];
  for (const c of cases) {
    if (ONLY && !ONLY.includes(c.name)) continue;
    byOp[c.op] = byOp[c.op] || { pass: 0, fail: 0 };
    let actual;
    try { actual = (await post(OP_ENDPOINT[c.op], c.req)).json; }
    catch (e) { actual = { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: 'HARNESS: ' + e.message }] }; }
    const ok = matches(c.exp, actual);
    if (ok) byOp[c.op].pass++;
    else { byOp[c.op].fail++; fails.push({ ...c, actual }); }
    if (VERBOSE || ONLY) {
      console.log(`\n=== ${c.suite}/${c.name} [${c.op}] ${ok ? 'PASS' : 'FAIL'} ===`);
      if (process.env.DUMP) fs.writeFileSync('/tmp/actual-' + c.name + '.json', JSON.stringify(actual));
      if (!ok) { const d = []; explain(c.exp, actual, '', d); console.log(d.join('\n')); }
    }
  }

  console.log('\n===== SUMMARY (SNOMED cases) =====');
  let tp = 0, tf = 0;
  for (const op of Object.keys(byOp).sort()) {
    console.log(`  ${op.padEnd(18)} pass=${byOp[op].pass}  fail=${byOp[op].fail}`);
    tp += byOp[op].pass; tf += byOp[op].fail;
  }
  console.log(`  ${'TOTAL'.padEnd(18)} pass=${tp}  fail=${tf}`);
  console.log('\nFAILING: ' + fails.map((f) => `${f.suite}/${f.name}`).join(', '));

  server.close();
  if (tx.shutdown) await tx.shutdown();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
