#!/usr/bin/env node
'use strict';

const crypto = require('crypto');

function parseArgs(argv) {
  const out = {
    server: 'https://tx.fhir.org',
    fhirPath: '/r4',
    valueSetUrl: 'http://hl7.org/fhir/ValueSet/administrative-gender',
    count: 2,
    offsetA: 0,
    offsetB: 2,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server' && argv[i + 1]) out.server = argv[++i];
    else if (a === '--path' && argv[i + 1]) out.fhirPath = argv[++i];
    else if (a === '--url' && argv[i + 1]) out.valueSetUrl = argv[++i];
    else if (a === '--count' && argv[i + 1]) out.count = Number(argv[++i]);
    else if (a === '--offset-a' && argv[i + 1]) out.offsetA = Number(argv[++i]);
    else if (a === '--offset-b' && argv[i + 1]) out.offsetB = Number(argv[++i]);
  }

  return out;
}

function normalizePath(p) {
  return p.startsWith('/') ? p : `/${p}`;
}

async function callExpand({ server, fhirPath, valueSetUrl, count, offset }) {
  const qs = new URLSearchParams({
    offset: String(offset),
    count: String(count),
  });
  const endpoint = `${server}${normalizePath(fhirPath)}/ValueSet/$expand?${qs.toString()}`;
  const body = {
    resourceType: 'Parameters',
    parameter: [{ name: 'url', valueUri: valueSetUrl }],
  };

  const t0 = Date.now();
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/fhir+json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  const durationMs = Date.now() - t0;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Leave json null.
  }

  const contains = Array.isArray(json?.expansion?.contains) ? json.expansion.contains : [];
  const sig = crypto.createHash('sha256').update(JSON.stringify(contains)).digest('hex');

  return {
    request: endpoint,
    status: resp.status,
    durationMs,
    resourceType: json?.resourceType || null,
    total: json?.expansion?.total ?? null,
    returned: contains.length,
    codes: contains.map((c) => c.code),
    containsSha256: sig,
    diagnostics: json?.issue?.[0]?.diagnostics || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const first = await callExpand({ ...args, offset: args.offsetA });
  const second = await callExpand({ ...args, offset: args.offsetB });

  const out = {
    server: args.server,
    path: normalizePath(args.fhirPath),
    valueSetUrl: args.valueSetUrl,
    queryCount: args.count,
    offsetA: args.offsetA,
    offsetB: args.offsetB,
    samePayload: first.containsSha256 === second.containsSha256,
    first,
    second,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
