#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

function usage() {
  console.error('Usage: node scripts/replay-perf-input.mjs <input.json> [--engine ir|legacy|both] [--base <url>] [--out <file>]');
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.length < 1) usage();

const inputPath = argv[0];
let engine = 'both';
let base = null;
let outPath = null;

for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--engine') {
    engine = argv[++i] || '';
    continue;
  }
  if (a === '--base') {
    base = argv[++i] || '';
    continue;
  }
  if (a === '--out') {
    outPath = argv[++i] || '';
    continue;
  }
  if (!a.startsWith('--')) usage();
}

if (!['ir', 'legacy', 'both'].includes(engine)) usage();

const doc = JSON.parse(readFileSync(inputPath, 'utf8'));
const requests = doc?.requests || {};

function withBase(urlString) {
  if (!base) return urlString;
  const src = new URL(urlString);
  const dstBase = new URL(base);
  src.protocol = dstBase.protocol;
  src.host = dstBase.host;
  return src.toString();
}

async function runOne(label) {
  const req = requests[label];
  if (!req?.url || !req?.body) {
    throw new Error(`Missing request payload for engine=${label}`);
  }
  const url = withBase(req.url);
  const resp = await fetch(url, {
    method: req.method || 'POST',
    headers: req.headers || { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  });
  const text = await resp.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    engine: label,
    request: { ...req, url },
    response: {
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers.entries()),
      body,
    },
  };
}

const labels = engine === 'both' ? ['legacy', 'ir'] : [engine];
const results = [];
for (const label of labels) {
  results.push(await runOne(label));
}

const out = {
  source: inputPath,
  replayedAt: new Date().toISOString(),
  requestedEngine: engine,
  baseOverride: base || null,
  results,
};

if (outPath) {
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote replay output to ${outPath}`);
} else {
  console.log(JSON.stringify(out, null, 2));
}
