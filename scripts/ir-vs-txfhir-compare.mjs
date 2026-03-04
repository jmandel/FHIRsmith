#!/usr/bin/env node
/**
 * Compare IR engine expansions against tx.fhir.org for real-world ValueSets.
 * Usage: node scripts/ir-vs-txfhir-compare.mjs
 */

const LOCAL = 'http://localhost:8000/r4';
const TX = 'https://tx.fhir.org/r4';

const VALUESETS = [
  // Small HL7 code systems
  'http://hl7.org/fhir/ValueSet/administrative-gender',
  'http://hl7.org/fhir/ValueSet/diagnostic-report-status',
  'http://hl7.org/fhir/ValueSet/encounter-status',
  'http://hl7.org/fhir/ValueSet/event-status',
  'http://hl7.org/fhir/ValueSet/request-status',
  'http://hl7.org/fhir/ValueSet/observation-status',
  'http://hl7.org/fhir/ValueSet/allergy-intolerance-category',
  'http://hl7.org/fhir/ValueSet/allergy-intolerance-criticality',
  'http://hl7.org/fhir/ValueSet/reaction-event-severity',
  'http://hl7.org/fhir/ValueSet/condition-clinical',
  'http://hl7.org/fhir/ValueSet/condition-ver-status',
  'http://hl7.org/fhir/ValueSet/observation-category',
  // Multi-code-system from HL7 terminology
  'http://hl7.org/fhir/ValueSet/identifier-type',
  'http://terminology.hl7.org/ValueSet/v3-ActEncounterCode',
  // SNOMED concept lists & is-a filters
  'http://hl7.org/fhir/ValueSet/condition-severity',
  'http://hl7.org/fhir/ValueSet/observation-vitalsignresult',
  'http://hl7.org/fhir/ValueSet/performer-role',
  'http://hl7.org/fhir/ValueSet/route-codes',
  // UCUM concept lists
  'http://hl7.org/fhir/ValueSet/ucum-vitals-common',
  'http://hl7.org/fhir/ValueSet/units-of-time',
  'http://hl7.org/fhir/ValueSet/age-units',
  // Larger: currencies, languages
  'http://hl7.org/fhir/ValueSet/currencies',
  'http://hl7.org/fhir/ValueSet/languages',
  // SNOMED is-a filters (medium-sized)
  'http://hl7.org/fhir/ValueSet/medication-form-codes',
  'http://hl7.org/fhir/ValueSet/body-site',
  'http://hl7.org/fhir/ValueSet/clinical-findings',
  'http://hl7.org/fhir/ValueSet/procedure-code',
  'http://hl7.org/fhir/ValueSet/medication-codes',
  // LOINC-based
  'http://hl7.org/fhir/ValueSet/doc-typecodes',
  'http://hl7.org/fhir/ValueSet/report-codes',
  // Published ValueSets with excludes or complex composition
  'http://hl7.org/fhir/ValueSet/substance-code',
  'http://hl7.org/fhir/ValueSet/approach-site-codes',
];

let passed = 0, failed = 0, skipped = 0;
const failures = [];

async function expandTx(url, count = 1000) {
  const resp = await fetch(
    `${TX}/ValueSet/$expand?url=${encodeURIComponent(url)}&count=${count}&offset=0`,
    { headers: { Accept: 'application/fhir+json' } }
  );
  return resp.json();
}

async function expandLocal(vsJson, count = 500) {
  const params = [
    { name: 'valueSet', resource: vsJson },
    { name: '_engine', valueString: 'ir' },
    { name: '_nocache', valueString: 'true' },
    { name: 'count', valueInteger: count },
    { name: 'offset', valueInteger: 0 },
  ];
  const resp = await fetch(`${LOCAL}/ValueSet/$expand`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceType: 'Parameters', parameter: params }),
  });
  return resp.json();
}

function extractCodes(result) {
  const codes = [];
  const walk = (items) => {
    for (const c of items || []) {
      codes.push({ system: c.system, code: c.code, display: c.display });
      walk(c.contains);
    }
  };
  walk(result.expansion?.contains);
  return codes;
}

function codeKey(c) { return `${c.system}|${c.code}`; }

function compareSets(txCodes, irCodes) {
  const txSet = new Set(txCodes.map(codeKey));
  const irSet = new Set(irCodes.map(codeKey));
  const onlyTx = txCodes.filter(c => !irSet.has(codeKey(c)));
  const onlyIR = irCodes.filter(c => !txSet.has(codeKey(c)));
  return { onlyTx, onlyIR, txCount: txCodes.length, irCount: irCodes.length };
}

function shortUrl(url) {
  return url
    .replace('http://hl7.org/fhir/ValueSet/', '')
    .replace('http://terminology.hl7.org/ValueSet/', 'thl7:');
}

async function run() {
  console.log('Comparing IR engine vs tx.fhir.org\n');

  for (const url of VALUESETS) {
    const label = shortUrl(url);
    process.stdout.write(`  ${label}... `);

    // 1. Fetch VS definition from tx.fhir.org
    let txResult;
    try {
      txResult = await expandTx(url);
    } catch (e) {
      console.log(`\x1b[33mSKIP\x1b[0m (tx.fhir.org error: ${e.message?.substring(0, 60)})`);
      skipped++;
      continue;
    }
    if (txResult.resourceType !== 'ValueSet') {
      console.log(`\x1b[33mSKIP\x1b[0m (tx.fhir.org: ${txResult.issue?.[0]?.details?.text?.substring(0, 60) || 'error'})`);
      skipped++;
      continue;
    }

    const txCodes = extractCodes(txResult);

    // 2. Get the VS definition (strip expansion, keep compose)
    let vsDef;
    try {
      const defResp = await fetch(
        `${TX}/ValueSet?url=${encodeURIComponent(url)}&_format=json`,
        { headers: { Accept: 'application/fhir+json' } }
      );
      const bundle = await defResp.json();
      vsDef = bundle.entry?.[0]?.resource;
      if (!vsDef?.compose) {
        // Fallback: use the expansion result but strip the expansion
        vsDef = { ...txResult };
        delete vsDef.expansion;
      }
    } catch {
      vsDef = { ...txResult };
      delete vsDef.expansion;
    }

    if (!vsDef?.compose) {
      console.log(`\x1b[33mSKIP\x1b[0m (no compose)`);
      skipped++;
      continue;
    }

    // 3. Expand locally via IR engine
    let irResult;
    try {
      irResult = await expandLocal(vsDef, Math.max(txCodes.length + 100, 500));
    } catch (e) {
      console.log(`\x1b[31mFAIL\x1b[0m (local error: ${e.message?.substring(0, 60)})`);
      failures.push({ url: label, reason: `local error: ${e.message}` });
      failed++;
      continue;
    }
    if (irResult.resourceType !== 'ValueSet') {
      const msg = irResult.issue?.[0]?.details?.text?.substring(0, 80) || 'error';
      console.log(`\x1b[31mFAIL\x1b[0m (IR: ${msg})`);
      failures.push({ url: label, reason: `IR error: ${msg}` });
      failed++;
      continue;
    }

    const irCodes = extractCodes(irResult);

    // 4. Compare
    const { onlyTx, onlyIR, txCount, irCount } = compareSets(txCodes, irCodes);

    if (onlyTx.length === 0 && onlyIR.length === 0) {
      console.log(`\x1b[32mMATCH\x1b[0m (${txCount} codes)`);
      passed++;
    } else {
      console.log(`\x1b[31mDIFF\x1b[0m tx=${txCount} ir=${irCount} onlyTx=${onlyTx.length} onlyIR=${onlyIR.length}`);
      if (onlyTx.length > 0 && onlyTx.length <= 10) {
        for (const c of onlyTx) console.log(`    tx-only: ${c.system?.split('/').pop()}|${c.code} "${c.display}"`);
      } else if (onlyTx.length > 10) {
        for (const c of onlyTx.slice(0, 5)) console.log(`    tx-only: ${c.system?.split('/').pop()}|${c.code} "${c.display}"`);
        console.log(`    ... and ${onlyTx.length - 5} more tx-only`);
      }
      if (onlyIR.length > 0 && onlyIR.length <= 10) {
        for (const c of onlyIR) console.log(`    ir-only: ${c.system?.split('/').pop()}|${c.code} "${c.display}"`);
      } else if (onlyIR.length > 10) {
        for (const c of onlyIR.slice(0, 5)) console.log(`    ir-only: ${c.system?.split('/').pop()}|${c.code} "${c.display}"`);
        console.log(`    ... and ${onlyIR.length - 5} more ir-only`);
      }
      failures.push({ url: label, txCount, irCount, onlyTx: onlyTx.length, onlyIR: onlyIR.length });
      failed++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  \x1b[32m${passed} match\x1b[0m, \x1b[31m${failed} diff\x1b[0m, ${skipped} skipped`);
  console.log('='.repeat(50));

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      if (f.reason) {
        console.log(`  ${f.url}: ${f.reason}`);
      } else {
        console.log(`  ${f.url}: tx=${f.txCount} ir=${f.irCount} onlyTx=${f.onlyTx} onlyIR=${f.onlyIR}`);
      }
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(2); });
