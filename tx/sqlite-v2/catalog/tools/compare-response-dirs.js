#!/usr/bin/env node
'use strict';
// Compare two replay response caches (replay.js --cache DIR) request by request: full response
// bodies, minus fields that change per call (ids, timestamps, meta, expansion identifier, trace).
// Used to show that two builds of the same release answer identically (e.g. an RF2 build and a
// reverse-loaded cache, docs/sqlite-v2-sct-from-cache.md).
//
//   node tx/sqlite-v2/catalog/tools/compare-response-dirs.js DIR_A DIR_B [--json out.json]

const fs = require('fs');
const path = require('path');

const [A, B] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const ji = process.argv.indexOf('--json');
const out = ji > 0 ? process.argv[ji + 1] : null;

const VOLATILE = new Set(['id', 'timestamp', 'meta', 'identifier', 'date', 'lastUpdated']);
function norm(x) {
  if (Array.isArray(x)) return x.map(norm);
  if (x && typeof x === 'object') {
    const o = {};
    for (const k of Object.keys(x).sort()) {
      if (VOLATILE.has(k)) continue;
      if (k === 'extension' && Array.isArray(x[k])) {
        const e = x[k].filter((y) => !/trace/i.test(y.url || ''));
        if (e.length) o[k] = norm(e);
        continue;
      }
      o[k] = norm(x[k]);
    }
    return o;
  }
  return x;
}
function diffs(a, b, p = '', acc = []) {
  if (acc.length > 20) return acc;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null || typeof a !== 'object') {
    if (JSON.stringify(a) !== JSON.stringify(b)) acc.push({ path: p, a, b });
    return acc;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) acc.push({ path: p + '.length', a: a.length, b: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffs(a[i], b[i], `${p}[${i}]`, acc);
    return acc;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffs(a[k], b[k], p ? `${p}.${k}` : k, acc);
  return acc;
}

const files = fs.readdirSync(A).filter((f) => f.endsWith('.json'));
const res = { same: 0, differ: 0, missing: 0, items: [] };
for (const f of files) {
  const fb = path.join(B, f);
  if (!fs.existsSync(fb)) { res.missing++; continue; }
  const a = JSON.parse(fs.readFileSync(path.join(A, f), 'utf8'));
  const b = JSON.parse(fs.readFileSync(fb, 'utf8'));
  const d = a.status !== b.status ? [{ path: 'status', a: a.status, b: b.status }] : diffs(norm(a.json), norm(b.json));
  if (!d.length) { res.same++; continue; }
  res.differ++;
  res.items.push({ key: f.replace(/\.json$/, ''), request: a.request && a.request.path, diffs: d.slice(0, 8) });
}
console.log(`${files.length} responses: ${res.same} identical, ${res.differ} differ, ${res.missing} missing in B`);
for (const it of res.items) {
  console.log(`\n${it.key} ${it.request}`);
  for (const d of it.diffs) console.log(`  ${d.path}: ${String(JSON.stringify(d.a)).slice(0, 160)} -> ${String(JSON.stringify(d.b)).slice(0, 160)}`);
}
if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
