#!/usr/bin/env node
'use strict';

/**
 * Comprehensive expandForValueSet tests: richer include/exclude combinations
 * and cross-system (RxNorm + LOINC) ValueSets.
 *
 * Tests exercise:
 *  - Filter-based excludes that fully cover, partially cover, or don't overlap includes
 *  - Multi-include with multi-exclude using filters on both sides
 *  - Cross-system ValueSets (RxNorm + LOINC includes, excludes across systems)
 *  - Edge cases: exclude superset of include, empty result sets, disjoint exclude
 *
 * Usage: node scripts/test-expand-cross-system.js [--full]
 */

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3000;
const REF_PORT = 3001;
const BASE_URL = `http://localhost:${PORT}/r4`;
const REF_URL = `http://localhost:${REF_PORT}/r4`;
const SERVER_START_TIMEOUT = 300000;
const LIBRARY_CONFIG = process.env.TEST_LIBRARY_CONFIG || 'tx/tx.rxnorm-loinc.yml';
const NATIVE_LIBRARY_CONFIG = process.env.TEST_NATIVE_CONFIG || 'tx/tx.rxnorm-loinc.yml';
const HAS_REFERENCE = LIBRARY_CONFIG !== NATIVE_LIBRARY_CONFIG;

const RXSYS = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LNSYS = 'http://loinc.org';

// --- Test helpers ---
function makeVS(compose) {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'valueSet', resource: { resourceType: 'ValueSet', compose } },
      ...(compose._params || []),
    ],
  };
}

// ============================================================
//  RxNorm-only: richer include/exclude patterns
//  Includes STY-based excludes which stress-test query planning —
//  if these hang, that's a real issue (blocks the event loop).
// ============================================================
const RXNORM_TESTS = [
  {
    name: 'rx-exclude-same-tty',
    desc: 'Include TTY=SBD, exclude TTY=SBD (full cover → 0 results)',
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-exclude-disjoint-tty',
    desc: 'Include TTY=SBD, exclude TTY=IN (disjoint → no effect)',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'IN' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-exclude-partial-tty',
    desc: 'Include TTY in SBD,SCD, exclude TTY=SBD (partial → only SCD left)',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,SCD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-sty-exclude-overlapping',
    desc: 'Include TTY=SBD, exclude STY=T200 (cross-property partial overlap)',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-concepts-exclude-tty-filter',
    desc: '10 concepts include, exclude TTY=SBD (removes SBD members)',
    body: makeVS({
      include: [{ system: RXSYS, concept: [
        { code: '197381' }, { code: '197382' }, { code: '197383' },
        { code: '197384' }, { code: '197385' }, { code: '313782' },
        { code: '312961' }, { code: '312962' }, { code: '310798' },
        { code: '308056' },
      ]}],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] }],
    }),
  },
  {
    name: 'rx-filter-exclude-20-concepts',
    desc: 'Include TTY=SCD, exclude 20 specific codes',
    drainCount: 20000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SCD' }] }],
      exclude: [{ system: RXSYS, concept: [
        { code: '197381' }, { code: '197382' }, { code: '197383' },
        { code: '197384' }, { code: '197385' }, { code: '197386' },
        { code: '197387' }, { code: '197388' }, { code: '197389' },
        { code: '197390' }, { code: '197391' }, { code: '197392' },
        { code: '197393' }, { code: '197394' }, { code: '197395' },
        { code: '197396' }, { code: '197397' }, { code: '197398' },
        { code: '197399' }, { code: '197400' },
      ]}],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-multi-include-sty+concepts-exclude',
    desc: 'SBD+SCD includes, exclude STY=T200 + 5 concepts',
    drainCount: 40000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SCD' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
        { system: RXSYS, concept: [
          { code: '197381' }, { code: '197382' }, { code: '197383' },
          { code: '197384' }, { code: '197385' },
        ]},
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-3-tty-include-2-tty-exclude',
    desc: 'Include TTY in SBD,SCD,GPCK, exclude TTY in SBD,GPCK',
    drainCount: 25000,
    body: makeVS({
      include: [{ system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,SCD,GPCK' }] }],
      exclude: [{ system: RXSYS, filter: [{ property: 'TTY', op: 'in', value: 'SBD,GPCK' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
];

// ============================================================
//  LOINC-only: richer include/exclude patterns
// ============================================================
const LOINC_TESTS = [
  {
    name: 'ln-exclude-filter-partial',
    desc: 'Include CLASS=LP7786-9, exclude COMPONENT=LP14635-4 (partial)',
    drainCount: 5000,
    body: makeVS({
      include: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
      exclude: [{ system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'LP14635-4' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-exclude-same-filter',
    desc: 'Include CLASS=LP7786-9, exclude CLASS=LP7786-9 (full cover → 0)',
    body: makeVS({
      include: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
      exclude: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-exclude-disjoint',
    desc: 'Include CLASS=LP7786-9, exclude CLASS=LP7819-8 (disjoint)',
    drainCount: 5000,
    body: makeVS({
      include: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
      exclude: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7819-8' }] }],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'ln-concepts-exclude-filter',
    desc: '5 LOINC codes include, exclude CLASS=LP7786-9 (removes CHEM)',
    body: makeVS({
      include: [{ system: LNSYS, concept: [
        { code: '2339-0' }, { code: '2345-7' }, { code: '718-7' },
        { code: '4548-4' }, { code: '14749-6' },
      ]}],
      exclude: [{ system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] }],
    }),
  },
  {
    name: 'ln-multi-include-multi-exclude',
    desc: 'CHEM + HEM/BC, exclude COMPONENT=Glucose + 3 concepts',
    drainCount: 8000,
    body: makeVS({
      include: [
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7803-2' }] },
      ],
      exclude: [
        { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'LP14635-4' }] },
        { system: LNSYS, concept: [{ code: '2339-0' }, { code: '2345-7' }, { code: '718-7' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
];

// ============================================================
//  Cross-system: RxNorm + LOINC in same ValueSet
// ============================================================
const CROSS_SYSTEM_TESTS = [
  {
    name: 'cross-rx-ln-include',
    desc: 'Include RxNorm TTY=SBD + LOINC CLASS=CHEM, count=10',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-rx-include-ln-exclude',
    desc: 'Include RxNorm TTY=SBD + LOINC CHEM, exclude LOINC COMPONENT=Glucose',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
      ],
      exclude: [
        { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'LP14635-4' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-ln-include-rx-exclude',
    desc: 'Include LOINC CHEM + RxNorm SBD, exclude RxNorm STY=T200',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-concepts-both-systems',
    desc: 'Include 3 RxNorm concepts + 3 LOINC concepts',
    body: makeVS({
      include: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '197383' }] },
        { system: LNSYS, concept: [{ code: '2339-0' }, { code: '2345-7' }, { code: '718-7' }] },
      ],
    }),
  },
  {
    name: 'cross-concepts-exclude-concepts',
    desc: '3 RxNorm + 3 LOINC concepts, exclude 1 from each system',
    body: makeVS({
      include: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '197383' }] },
        { system: LNSYS, concept: [{ code: '2339-0' }, { code: '2345-7' }, { code: '718-7' }] },
      ],
      exclude: [
        { system: RXSYS, concept: [{ code: '197381' }] },
        { system: LNSYS, concept: [{ code: '718-7' }] },
      ],
    }),
  },
  {
    name: 'cross-filter-exclude-cross',
    desc: 'Include RxNorm SBD + LOINC CHEM, exclude both RxNorm T200 + LOINC Glucose',
    drainCount: 30000,
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7786-9' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'STY', op: '=', value: 'T200' }] },
        { system: LNSYS, filter: [{ property: 'COMPONENT', op: '=', value: 'LP14635-4' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'cross-mixed-concepts-filters',
    desc: 'RxNorm concepts + LOINC filter, exclude LOINC concepts + RxNorm filter',
    body: makeVS({
      include: [
        { system: RXSYS, concept: [{ code: '197381' }, { code: '197382' }, { code: '313782' }] },
        { system: LNSYS, filter: [{ property: 'CLASS', op: '=', value: 'LP7803-2' }] },
      ],
      exclude: [
        { system: LNSYS, concept: [{ code: '718-7' }] },
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  // Unsupported filter property → forces fallback to baseline path (~1.0x)
  {
    name: 'rx-unsupported-filter-fallback',
    desc: 'Include with unsupported filter property → baseline fallback',
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'BOGUS_PROPERTY', op: '=', value: 'XYZ' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
  {
    name: 'rx-unsupported-exclude-filter-fallback',
    desc: 'Supported include + unsupported exclude filter → exclude falls back',
    body: makeVS({
      include: [
        { system: RXSYS, filter: [{ property: 'TTY', op: '=', value: 'SBD' }] },
      ],
      exclude: [
        { system: RXSYS, filter: [{ property: 'BOGUS_PROPERTY', op: '=', value: 'XYZ' }] },
      ],
      _params: [{ name: 'count', valueInteger: 10 }],
    }),
  },
];

// ============================================================
//  HTTP helpers
// ============================================================
function postJson(url, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpPost(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''),
      method: 'POST', headers: { 'Content-Length': 0 },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

async function waitForServer(url, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await httpGet(url);
      if (res.status === 200) return true;
    } catch (_) { /* not ready */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Server did not start within timeout');
}

function extractCodes(responseBody) {
  try {
    const json = JSON.parse(responseBody);
    if (!json.expansion || !json.expansion.contains) return [];
    return json.expansion.contains.map(c => ({
      code: c.code, display: c.display, system: c.system, inactive: c.inactive || false,
    }));
  } catch (_) { return null; }
}

function codesEqual(a, b) {
  if (a === null || b === null) return { match: false, reason: 'null' };
  if (a.length !== b.length) return { match: false, reason: `count ${a.length} vs ${b.length}` };
  let exact = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].code !== b[i].code || a[i].system !== b[i].system) { exact = false; break; }
  }
  if (exact) return { match: true, reason: 'exact' };
  const key = c => `${c.system}|${c.code}`;
  const setA = new Set(a.map(key));
  const setB = new Set(b.map(key));
  const sameSet = setA.size === setB.size && [...setA].every(c => setB.has(c));
  if (sameSet) return { match: true, reason: 'order differs' };
  return { match: false, reason: 'different codes' };
}

// ============================================================
//  Main runner
// ============================================================
function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

async function main() {
  const full = process.argv.includes('--full');
  const rxOnly = process.argv.includes('--rx');
  const lnOnly = process.argv.includes('--ln');
  const crossOnly = process.argv.includes('--cross');

  let testList;
  if (rxOnly) testList = RXNORM_TESTS;
  else if (lnOnly) testList = LOINC_TESTS;
  else if (crossOnly) testList = CROSS_SYSTEM_TESTS;
  else testList = [...RXNORM_TESTS, ...LOINC_TESTS, ...CROSS_SYSTEM_TESTS];

  const serverDir = path.resolve(__dirname, '..');

  log(`Running ${testList.length} tests`);
  log(`Using library: ${LIBRARY_CONFIG}`);
  if (HAS_REFERENCE) log(`Native reference: ${NATIVE_LIBRARY_CONFIG} on port ${REF_PORT}`);

  let server, refServer;
  try {
    log(`Starting server on port ${PORT}...`);
    server = spawn('node', ['server.js'], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', TX_LIBRARY_SOURCE: LIBRARY_CONFIG, PORT: String(PORT) },
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});

    if (HAS_REFERENCE) {
      log(`Starting native reference server on port ${REF_PORT}...`);
      refServer = spawn('node', ['server.js'], {
        cwd: serverDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test', TX_LIBRARY_SOURCE: NATIVE_LIBRARY_CONFIG, PORT: String(REF_PORT) },
      });
      refServer.stdout.on('data', () => {});
      refServer.stderr.on('data', () => {});
    }

    await waitForServer(`http://localhost:${PORT}/r4/metadata`, SERVER_START_TIMEOUT);
    log('Server ready.');
    if (HAS_REFERENCE) {
      await waitForServer(`http://localhost:${REF_PORT}/r4/metadata`, SERVER_START_TIMEOUT);
      log('Native reference server ready.');
    }
    log('');

    await httpPost(`http://localhost:${PORT}/debug/perf-counters/enable`);

    const results = [];

    for (let ti = 0; ti < testList.length; ti++) {
      const test = testList[ti];
      const body = JSON.parse(JSON.stringify(test.body));
      if (body.parameter[0].resource.compose._params) {
        body.parameter.push(...body.parameter[0].resource.compose._params);
        delete body.parameter[0].resource.compose._params;
      }

      log(`[${ti+1}/${testList.length}] ${test.name}: ${test.desc}`);

      // OPTIMIZED
      await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=false`);
      const t0 = performance.now();
      let optRes;
      try { optRes = await postJson(BASE_URL + '/ValueSet/$expand', body); }
      catch (e) { optRes = { status: 'ERROR', body: e.message }; }
      const optMs = performance.now() - t0;
      const optCodes = typeof optRes.body === 'string' ? extractCodes(optRes.body) : null;

      // BASELINE (skip if test.skipBaseline — query blocks the event loop)
      let baseRes, baseTimeout = false, baseMs = 0, baseCodes = null, baseSkipped = false;
      if (test.skipBaseline) {
        baseSkipped = true;
        baseRes = { status: 'SKIP', body: '' };
      } else {
        await httpPost(`http://localhost:${PORT}/debug/bypass-expand-for-valueset?bypass=true`);
        const t1 = performance.now();
        try { baseRes = await postJson(BASE_URL + '/ValueSet/$expand', body); }
        catch (e) {
          baseTimeout = e.message === 'Request timed out';
          baseRes = { status: 'TIMEOUT', body: '' };
        }
        baseMs = performance.now() - t1;
        baseCodes = typeof baseRes.body === 'string' ? extractCodes(baseRes.body) : null;
      }

      // NATIVE REFERENCE
      let natMs = 0, natCodes = null, natStatus = null;
      if (HAS_REFERENCE) {
        const t2 = performance.now();
        let natRes;
        try { natRes = await postJson(REF_URL + '/ValueSet/$expand', body); }
        catch (e) { natRes = { status: 'ERROR', body: e.message }; }
        natMs = performance.now() - t2;
        natStatus = natRes.status;
        natCodes = typeof natRes.body === 'string' ? extractCodes(natRes.body) : null;
      }

      // Compare opt vs baseline
      const cmpBase = baseSkipped ? { match: null, reason: 'baseline skipped' }
        : baseTimeout ? { match: null, reason: 'baseline timeout' }
        : codesEqual(optCodes, baseCodes);

      // Compare opt vs native (primary correctness check when available)
      const cmpNat = HAS_REFERENCE ? codesEqual(optCodes, natCodes) : null;

      const speedupBase = (baseSkipped || baseTimeout) ? Infinity : baseMs / optMs;
      const speedupNat = HAS_REFERENCE ? (natMs / optMs) : null;

      const natIcon = cmpNat ? (cmpNat.match === true ? '✅' : '❌') : '';
      const baseIcon = cmpBase.match === true ? '✅' : cmpBase.match === false ? '❌' : '⏱️';

      if (HAS_REFERENCE) {
        log(`  Opt: ${optMs.toFixed(0)}ms  Native: ${natMs.toFixed(0)}ms (${natStatus}) ${natIcon} ${cmpNat.reason}  Base: ${baseSkipped ? 'SKIP' : baseTimeout ? 'TIMEOUT' : baseMs.toFixed(0) + 'ms'} ${baseIcon}`);
      } else {
        const baseLabel = baseSkipped ? 'SKIP' : baseTimeout ? 'TIMEOUT' : `${baseMs.toFixed(0)}ms`;
        log(`  Opt: ${optMs.toFixed(0)}ms (${optRes.status})  Base: ${baseLabel} (${baseRes.status})  ${speedupBase === Infinity ? '∞' : speedupBase.toFixed(1) + 'x'}  ${baseIcon} ${cmpBase.reason} opt:${optCodes?.length ?? '?'} base:${baseCodes?.length ?? '?'}`);
      }
      log('');

      results.push({
        name: test.name, optMs: optMs.toFixed(1),
        baseMs: baseSkipped ? 'SKIP' : baseTimeout ? 'TIMEOUT' : baseMs.toFixed(1),
        natMs: HAS_REFERENCE ? natMs.toFixed(1) : null,
        speedupBase: speedupBase === Infinity ? '∞' : speedupBase.toFixed(1),
        speedupNat: speedupNat != null ? speedupNat.toFixed(1) : null,
        matchBase: cmpBase.match, reasonBase: cmpBase.reason,
        matchNat: cmpNat?.match ?? null, reasonNat: cmpNat?.reason ?? null,
        baseTimeout, baseSkipped,
        optCount: optCodes?.length ?? '?',
        baseCount: baseCodes?.length ?? '?',
        natCount: natCodes?.length ?? '?',
      });
    }

    // Summary table
    const lines = [];
    lines.push('=== Cross-system expandForValueSet test results ===');
    lines.push(`Date: ${new Date().toISOString()}`);
    lines.push(`Library: ${LIBRARY_CONFIG}`);
    lines.push(`Tests: ${testList.length}`);
    lines.push('');

    if (HAS_REFERENCE) {
      lines.push('Test                               | Opt (ms) | Nat (ms) | Speedup | Codes | vs Native                | vs Base');
      lines.push('-----------------------------------|----------|----------|---------|-------|--------------------------|--------');
      for (const r of results) {
        const natOk = r.matchNat === true;
        const baseOk = r.matchBase === true;
        const natIcon = natOk ? '✅' : r.matchNat === false ? '❌' : '—';
        const baseIcon = r.baseSkipped ? '⏭️' : r.baseTimeout ? '⏱️' : (baseOk ? '✅' : '❌');
        const natDetail = natOk ? r.reasonNat : `${r.reasonNat} (${r.optCount}/${r.natCount})`;
        const speedCol = r.speedupNat ? `${r.speedupNat.padStart(6)}x` : '     — ';
        lines.push(
          `${r.name.padEnd(35)}| ${r.optMs.padStart(8)} | ${r.natMs.padStart(8)} | ${speedCol} | ${String(r.optCount).padStart(5)} | ${natIcon} ${natDetail.padEnd(23)} | ${baseIcon}`
        );
      }
    } else {
      lines.push('Test                               | Opt (ms) | Base (ms) | Speedup | Codes | Result');
      lines.push('-----------------------------------|----------|-----------|---------|-------|-------');
      for (const r of results) {
        const pass = r.matchBase === true;
        const icon = r.baseSkipped ? '⚠️' : r.baseTimeout ? '⏱️' : (pass ? '✅' : '❌');
        const detail = r.baseSkipped ? `baseline skipped (opt: ${r.optCount} codes)`
          : r.baseTimeout ? `baseline timeout (opt OK: ${r.optCount} codes)` : r.reasonBase;
        const speedCol = r.speedupBase === '∞' ? '     ∞ ' : `${r.speedupBase.padStart(6)}x`;
        lines.push(`${r.name.padEnd(35)}| ${r.optMs.padStart(8)} | ${r.baseMs.padStart(9)} | ${speedCol} | ${String(r.optCount).padStart(5)} | ${icon} ${detail}`);
      }
    }

    console.log('\n' + lines.join('\n'));

    const outPath = path.join(serverDir, 'test-cross-system-results.txt');
    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    log(`Results written to ${outPath}`);

  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
    }
    if (refServer) {
      refServer.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
