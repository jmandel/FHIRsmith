#!/usr/bin/env node
'use strict';
// Record reference answers from a public server (default https://tx-dev.fhir.org/r4) into
// reference/<id>.json. Every raw response is cached on disk by request hash, so reruns
// never re-query; only entries/patterns whose requests are not cached hit the network.
//
//   node tx/sqlite-v2/catalog/fetch-reference.js [--base URL] [--cache DIR] [--only id,id]
//        [--interval-ms 1100] [--max-requests 500] [--dry-run]
//
// Gentle by construction: sequential, >= interval between network requests, a hard cap on
// network requests per run, and exponential back-off on 429/5xx/transport errors.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function args() {
  const a = { base: 'https://tx-dev.fhir.org/r4', cache: null, intervalMs: 1100, maxRequests: 500, only: null, dryRun: false };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i];
    if (k === '--base') a.base = v[++i];
    else if (k === '--cache') a.cache = v[++i];
    else if (k === '--only') a.only = new Set(v[++i].split(','));
    else if (k === '--interval-ms') a.intervalMs = +v[++i];
    else if (k === '--max-requests') a.maxRequests = +v[++i];
    else if (k === '--dry-run') a.dryRun = true;
    else throw new Error('unknown argument ' + k);
  }
  // the disk cache is keyed by request only, so each reference server has its own folder
  if (!a.cache) a.cache = process.env.CATALOG_CACHE || path.join(process.env.HOME || '.', 'hobby/.agent-scratch',
    /\/\/tx\.fhir\.org\//.test(a.base + '/') ? 'catalog-txcache' : 'catalog-cache-' + new URL(a.base).host);
  return a;
}

async function main() {
  const a = args();
  const entries = lib.loadEntries().map((x) => x.entry).filter((e) => !a.only || a.only.has(e.id));
  let network = 0;
  const statuses = {};
  const log = (m) => console.error('  ' + m);
  // wrap callServer with budget + back-off
  const call = async (base, req, opts) => {
    const key = lib.requestKey(req);
    const cached = path.join(a.cache, key + '.json');
    if (fs.existsSync(cached)) return lib.callServer(base, req, opts);
    if (a.dryRun) { network++; return { status: -1, json: null, key, cached: false }; }
    if (network >= a.maxRequests) throw new Error('request budget exhausted');
    let wait = 5000;
    for (let attempt = 0; ; attempt++) {
      if (network >= a.maxRequests) throw new Error('request budget exhausted');
      network++;
      // a 5xx is retried once after a pause, and then recorded as the answer (a deterministic
      // server error is a valid outcome); 429 and transport errors back off up to 3 times
      const r = await lib.callServer(base, req, { ...opts, minIntervalMs: a.intervalMs, log, cache5xx: attempt >= 1 });
      if (r.status && r.status !== 429 && (r.status < 500 || attempt >= 1)) return r;
      if (attempt >= 3) { log(`giving up after ${attempt + 1} tries: status ${r.status} ${r.error || ''}`); return r; }
      log(`backing off ${wait} ms after status ${r.status}`);
      await new Promise((res) => setTimeout(res, wait));
      wait *= 3;
    }
  };
  for (const e of entries) {
    console.error(e.id);
    let result;
    try {
      result = await lib.runEntry(e, a.base, { cacheDir: a.cache, call });
    } catch (x) {
      console.error('  stopped: ' + x.message);
      break;
    }
    if (a.dryRun) continue;
    for (const pg of Object.values(result.patterns).flat()) statuses[pg.status] = (statuses[pg.status] || 0) + 1;
    const ref = { id: e.id, server: a.base, recordedAt: new Date().toISOString(), requests: result.requests, patterns: result.patterns };
    const prev = path.join(lib.REFERENCE_DIR, e.id + '.json');
    if (fs.existsSync(prev)) {
      // keep the first recording time when nothing changed
      const old = JSON.parse(fs.readFileSync(prev, 'utf8'));
      if (JSON.stringify(stripVolatile(old.patterns)) === JSON.stringify(stripVolatile(ref.patterns))) ref.recordedAt = old.recordedAt;
    }
    fs.mkdirSync(lib.REFERENCE_DIR, { recursive: true });
    fs.writeFileSync(prev, JSON.stringify(ref, null, 1) + '\n');
  }
  console.error(`network requests this run: ${network}${a.dryRun ? ' (dry run: uncached requests, last-with-total counted once)' : ''}`);
  if (!a.dryRun) console.error('page statuses: ' + JSON.stringify(statuses));
}

function stripVolatile(p) { return JSON.parse(JSON.stringify(p, (k, v) => (k === 'ms' ? undefined : v))); }

main().catch((e) => { console.error(e); process.exit(1); });
