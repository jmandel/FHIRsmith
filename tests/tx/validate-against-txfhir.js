#!/usr/bin/env node
/**
 * Validate expand-v2 test expectations against tx.fhir.org
 *
 * Queries the public FHIR tx server to verify our ground-truth assumptions.
 * tx.fhir.org may reject some queries (unsupported filter, unknown CS) —
 * those are noted but NOT treated as test failures.
 *
 * Page order is undefined, so pagination tests only check page sizes
 * and cross-page uniqueness, never specific codes on specific pages.
 *
 * Usage:
 *   node tests/tx/validate-against-txfhir.js [filter]
 */

'use strict';

const https = require('https');

const TX_BASE = 'https://tx.fhir.org/r4';

// ── HTTP helper ────────────────────────────────────────────────────────────

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/fhir+json',
        'Accept': 'application/fhir+json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 30000,
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf) });
        } catch {
          resolve({ status: res.statusCode, body: buf });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Expand helper ──────────────────────────────────────────────────────────

async function txExpand(vsJson, opts = {}) {
  const params = {
    resourceType: 'Parameters',
    parameter: [
      { name: 'valueSet', resource: vsJson },
    ],
  };
  if (opts.count !== undefined) params.parameter.push({ name: 'count', valueInteger: opts.count });
  if (opts.offset !== undefined) params.parameter.push({ name: 'offset', valueInteger: opts.offset });
  if (opts.filter) params.parameter.push({ name: 'filter', valueString: opts.filter });

  const t0 = performance.now();
  const { status, body } = await post(`${TX_BASE}/ValueSet/$expand`, params);
  const ms = Math.round(performance.now() - t0);

  if (status !== 200 || body.resourceType === 'OperationOutcome') {
    const issue = body.issue?.[0]?.diagnostics || body.issue?.[0]?.details?.text || JSON.stringify(body).slice(0, 200);
    return { ok: false, status, issue, ms };
  }

  const contains = body.expansion?.contains || [];
  // Flatten nested contains (tx.fhir.org sometimes returns hierarchical)
  const flat = [];
  function flatten(items) {
    for (const c of items) {
      flat.push(c);
      if (c.contains) flatten(c.contains);
    }
  }
  flatten(contains);

  return {
    ok: true,
    status,
    ms,
    total: body.expansion?.total,
    count: flat.length,
    contains: flat,
    offset: body.expansion?.offset,
  };
}

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

function findCode(contains, code) {
  return contains.find(c => c.code === code);
}

// ── Systems ────────────────────────────────────────────────────────────────

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
  OBSCAT:   'http://terminology.hl7.org/CodeSystem/observation-category',
};

// ── Test infrastructure ────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ── Test definitions ───────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// Shape A: whole system
// ═══════════════════════════════════════════════════════════════════════════

test('shape-A: administrative-gender', async () => {
  const r = await txExpand(vs({ system: SYS.GENDER }));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 4, `expected 4 gender codes, got ${r.count}`);
  assert(r.total === 4, `total=${r.total}`);
  assert(findCode(r.contains, 'male')?.display === 'Male', 'male display');
  assert(findCode(r.contains, 'female')?.display === 'Female', 'female display');
  assert(findCode(r.contains, 'other')?.display === 'Other', 'other display');
  assert(findCode(r.contains, 'unknown')?.display === 'Unknown', 'unknown display');
  return { count: r.count, ms: r.ms };
});

test('shape-A: publication-status', async () => {
  const r = await txExpand(vs({ system: SYS.PUBSTAT }));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 4, `expected 4, got ${r.count}`);
  assert(findCode(r.contains, 'draft')?.display === 'Draft', 'draft');
  assert(findCode(r.contains, 'active')?.display === 'Active', 'active');
  assert(findCode(r.contains, 'retired')?.display === 'Retired', 'retired');
  assert(findCode(r.contains, 'unknown')?.display === 'Unknown', 'unknown');
  return { count: r.count, ms: r.ms };
});

test('shape-A: condition-ver-status', async () => {
  const r = await txExpand(vs({ system: SYS.CVSTAT }));
  if (!r.ok) return { skipped: r.issue };
  // Flattened: unconfirmed, provisional, differential, confirmed, refuted, entered-in-error = 6
  assert(r.count === 6, `expected 6, got ${r.count}`);
  assert(findCode(r.contains, 'unconfirmed')?.display === 'Unconfirmed', 'unconfirmed');
  assert(findCode(r.contains, 'provisional')?.display === 'Provisional', 'provisional');
  assert(findCode(r.contains, 'differential')?.display === 'Differential', 'differential');
  assert(findCode(r.contains, 'confirmed')?.display === 'Confirmed', 'confirmed');
  assert(findCode(r.contains, 'refuted')?.display === 'Refuted', 'refuted');
  assert(findCode(r.contains, 'entered-in-error')?.display === 'Entered in Error', 'entered-in-error');
  return { count: r.count, ms: r.ms };
});

test('shape-A: observation-category', async () => {
  const r = await txExpand(vs({ system: SYS.OBSCAT }));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 10, `expected 10, got ${r.count}`);
  assert(findCode(r.contains, 'laboratory')?.display === 'Laboratory', 'laboratory');
  assert(findCode(r.contains, 'vital-signs')?.display === 'Vital Signs', 'vital-signs');
  return { count: r.count, ms: r.ms };
});

test('shape-A: US states (may not be on tx.fhir.org)', async () => {
  const r = await txExpand(vs({ system: SYS.USPS }));
  if (!r.ok) return { skipped: `tx.fhir.org: ${r.issue}` };
  // If it works, validate count
  return { count: r.count, total: r.total, ms: r.ms, note: 'tx.fhir.org has this CS' };
});

test('shape-A: currency (may not be on tx.fhir.org)', async () => {
  const r = await txExpand(vs({ system: SYS.CURRENCY }));
  if (!r.ok) return { skipped: `tx.fhir.org: ${r.issue}` };
  return { count: r.count, total: r.total, ms: r.ms };
});

test('shape-A: area codes (may not be on tx.fhir.org)', async () => {
  const r = await txExpand(vs({ system: SYS.M49 }));
  if (!r.ok) return { skipped: `tx.fhir.org: ${r.issue}` };
  return { count: r.count, total: r.total, ms: r.ms };
});

// ═══════════════════════════════════════════════════════════════════════════
// Shape B: enumerated concepts
// ═══════════════════════════════════════════════════════════════════════════

test('shape-B: gender enumerated subset', async () => {
  const r = await txExpand(vs({
    system: SYS.GENDER,
    concept: [{ code: 'male' }, { code: 'female' }],
  }));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 2, `expected 2, got ${r.count}`);
  assert(findCode(r.contains, 'male')?.display === 'Male', 'male');
  assert(findCode(r.contains, 'female')?.display === 'Female', 'female');
  assert(!findCode(r.contains, 'other'), 'other should not appear');
  return { count: r.count, ms: r.ms };
});

test('shape-B: SNOMED enumerated', async () => {
  const r = await txExpand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }],
  }));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 3, `expected 3, got ${r.count}`);
  assert(findCode(r.contains, '73211009')?.display === 'Diabetes mellitus', '73211009');
  // tx.fhir.org may use different display for Type 2
  const t2 = findCode(r.contains, '44054006');
  assert(t2, 'missing 44054006');
  console.log(`      tx.fhir.org display for 44054006: "${t2.display}"`);
  const t1 = findCode(r.contains, '46635009');
  assert(t1, 'missing 46635009');
  console.log(`      tx.fhir.org display for 46635009: "${t1.display}"`);
  return { count: r.count, ms: r.ms };
});

test('shape-B: LOINC enumerated', async () => {
  const r = await txExpand(vs({
    system: SYS.LOINC,
    concept: [{ code: '2160-0' }, { code: '2345-7' }],
  }));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 2, `expected 2, got ${r.count}`);
  const creat = findCode(r.contains, '2160-0');
  assert(creat, 'missing 2160-0');
  console.log(`      tx.fhir.org display for 2160-0: "${creat.display}"`);
  assert(creat.display.includes('Creatinine'), 'should mention Creatinine');
  return { count: r.count, ms: r.ms };
});

test('shape-B: RxNorm enumerated', async () => {
  const r = await txExpand(vs({
    system: SYS.RXNORM,
    concept: [{ code: '161' }, { code: '5640' }, { code: '1191' }],
  }));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 3, `expected 3, got ${r.count}`);
  assert(findCode(r.contains, '161')?.display === 'acetaminophen', '161');
  assert(findCode(r.contains, '5640')?.display === 'ibuprofen', '5640');
  assert(findCode(r.contains, '1191')?.display === 'aspirin', '1191');
  return { count: r.count, ms: r.ms };
});

// ═══════════════════════════════════════════════════════════════════════════
// Filters
// ═══════════════════════════════════════════════════════════════════════════

test('filter: gender regex [mf].*', async () => {
  const r = await txExpand(vs({
    system: SYS.GENDER,
    filter: [{ property: 'code', op: 'regex', value: '[mf].*' }],
  }));
  if (!r.ok) return { skipped: `tx.fhir.org: ${r.issue}` };
  console.log(`      regex [mf].* on gender: ${r.count} codes: ${r.contains.map(c=>c.code)}`);
  assert(r.count === 2, `expected 2 (male+female), got ${r.count}`);
  assert(findCode(r.contains, 'male'), 'male');
  assert(findCode(r.contains, 'female'), 'female');
  return { count: r.count, ms: r.ms };
});

test('filter: SNOMED is-a diabetes', async () => {
  const r = await txExpand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }));
  if (!r.ok) return { skipped: r.issue };
  // is-a includes self
  assert(findCode(r.contains, '73211009'), 'is-a should include self');
  assert(findCode(r.contains, '44054006'), 'should include Type 2');
  assert(findCode(r.contains, '46635009'), 'should include Type 1');
  console.log(`      SNOMED is-a 73211009: ${r.count} codes (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('filter: SNOMED descendent-of diabetes', async () => {
  const r = await txExpand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'descendent-of', value: '73211009' }],
  }));
  if (!r.ok) return { skipped: r.issue };
  assert(!findCode(r.contains, '73211009'), 'descendent-of must exclude self');
  assert(findCode(r.contains, '44054006'), 'should include Type 2');
  console.log(`      SNOMED descendent-of 73211009: ${r.count} codes (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('filter: condition-ver-status is-a unconfirmed', async () => {
  const r = await txExpand(vs({
    system: SYS.CVSTAT,
    filter: [{ property: 'concept', op: 'is-a', value: 'unconfirmed' }],
  }));
  if (!r.ok) return { skipped: r.issue };
  console.log(`      is-a unconfirmed: ${r.count} codes: ${r.contains.map(c=>c.code)}`);
  // Expected: unconfirmed + provisional + differential = 3
  assert(findCode(r.contains, 'unconfirmed'), 'should include self');
  return { count: r.count, ms: r.ms };
});

test('filter: condition-ver-status descendent-of unconfirmed', async () => {
  const r = await txExpand(vs({
    system: SYS.CVSTAT,
    filter: [{ property: 'concept', op: 'descendent-of', value: 'unconfirmed' }],
  }));
  if (!r.ok) return { skipped: r.issue };
  console.log(`      descendent-of unconfirmed: ${r.count} codes: ${r.contains.map(c=>c.code)}`);
  assert(!findCode(r.contains, 'unconfirmed'), 'must exclude self');
  assert(findCode(r.contains, 'provisional'), 'provisional');
  assert(findCode(r.contains, 'differential'), 'differential');
  return { count: r.count, ms: r.ms };
});

test('filter: SNOMED concept-in refset/723560006', async () => {
  const r = await txExpand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'in', value: 'http://snomed.info/sct?fhir_vs=refset/723560006' }],
  }));
  if (!r.ok) return { skipped: r.issue };
  console.log(`      concept-in refset/723560006: ${r.count} codes (total=${r.total})`);
  assert(findCode(r.contains, '404684003'), 'Clinical finding should be in refset');
  assert(findCode(r.contains, '71388002'), 'Procedure should be in refset');
  return { count: r.count, total: r.total, ms: r.ms };
});

test('filter: RxNorm TTY=IN (count=5)', async () => {
  const r = await txExpand(vs({
    system: SYS.RXNORM,
    filter: [{ property: 'TTY', op: '=', value: 'IN' }],
  }), { count: 5 });
  if (!r.ok) return { skipped: `tx.fhir.org: ${r.issue}` };
  console.log(`      RxNorm TTY=IN: ${r.count} returned (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('filter: LOINC STATUS=ACTIVE (count=5)', async () => {
  const r = await txExpand(vs({
    system: SYS.LOINC,
    filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }],
  }), { count: 5 });
  if (!r.ok) return { skipped: `tx.fhir.org: ${r.issue}` };
  console.log(`      LOINC STATUS=ACTIVE: ${r.count} returned (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('filter: gender concept = male', async () => {
  const r = await txExpand(vs({
    system: SYS.GENDER,
    filter: [{ property: 'concept', op: '=', value: 'male' }],
  }));
  if (!r.ok) return { skipped: `tx.fhir.org: ${r.issue}` };
  assert(r.count === 1, `expected 1, got ${r.count}`);
  assert(r.contains[0].code === 'male', 'should be male');
  return { count: r.count, ms: r.ms };
});

// ═══════════════════════════════════════════════════════════════════════════
// Text search
// ═══════════════════════════════════════════════════════════════════════════

test('text-search: SNOMED filter=diabetes (count=50)', async () => {
  const r = await txExpand(
    vs({ system: SYS.SCT }),
    { filter: 'diabetes', count: 50 }
  );
  if (!r.ok) return { skipped: r.issue };
  assert(r.count > 0, 'should have results');
  assert(r.count <= 50, 'should respect count');
  assert(findCode(r.contains, '73211009'), '73211009 should appear in diabetes search');
  console.log(`      SNOMED text=diabetes: ${r.count} codes (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('text-search: SNOMED is-a + filter=type', async () => {
  const r = await txExpand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }), { filter: 'type', count: 50 });
  if (!r.ok) return { skipped: r.issue };
  assert(r.count > 0, 'should have results');
  console.log(`      is-a diabetes + text=type: ${r.count} codes`);
  const displays = r.contains.map(c => c.display.toLowerCase());
  assert(displays.some(d => d.includes('type')), 'should match "type"');
  return { count: r.count, ms: r.ms };
});

test('text-search: RxNorm filter=aspirin (count=20)', async () => {
  const r = await txExpand(
    vs({ system: SYS.RXNORM }),
    { filter: 'aspirin', count: 20 }
  );
  if (!r.ok) return { skipped: r.issue };
  assert(r.count > 0, 'should have results');
  assert(findCode(r.contains, '1191'), 'aspirin 1191 should appear');
  console.log(`      RxNorm text=aspirin: ${r.count} codes (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('text-search: LOINC filter=creatinine (count=20)', async () => {
  const r = await txExpand(
    vs({ system: SYS.LOINC }),
    { filter: 'creatinine', count: 20 }
  );
  if (!r.ok) return { skipped: r.issue };
  assert(r.count > 0, 'should have results');
  assert(findCode(r.contains, '2160-0'), '2160-0 should appear');
  console.log(`      LOINC text=creatinine: ${r.count} codes (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('text-search: inline FHIR filter=male', async () => {
  const r = await txExpand(
    vs({ system: SYS.GENDER }),
    { filter: 'male' }
  );
  if (!r.ok) return { skipped: r.issue };
  console.log(`      gender text=male: ${r.count} codes: ${r.contains.map(c=>c.code)}`);
  assert(findCode(r.contains, 'male'), 'male should appear');
  return { count: r.count, ms: r.ms };
});

test('text-search: multi-system filter=unknown', async () => {
  const r = await txExpand(vs([
    { system: SYS.GENDER },
    { system: SYS.PUBSTAT },
  ]), { filter: 'unknown' });
  if (!r.ok) return { skipped: r.issue };
  console.log(`      gender+pubstat text=unknown: ${r.count} codes: ${r.contains.map(c=>c.system.split('/').pop()+'/'+c.code)}`);
  return { count: r.count, ms: r.ms };
});

// ═══════════════════════════════════════════════════════════════════════════
// Excludes
// ═══════════════════════════════════════════════════════════════════════════

test('exclude: gender minus other+unknown', async () => {
  const r = await txExpand(vs(
    { system: SYS.GENDER },
    { system: SYS.GENDER, concept: [{ code: 'other' }, { code: 'unknown' }] }
  ));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 2, `expected 2, got ${r.count}`);
  assert(findCode(r.contains, 'male'), 'male');
  assert(findCode(r.contains, 'female'), 'female');
  assert(!findCode(r.contains, 'other'), 'other excluded');
  assert(!findCode(r.contains, 'unknown'), 'unknown excluded');
  return { count: r.count, ms: r.ms };
});

test('exclude: SNOMED is-a minus Type2 subtree', async () => {
  const r = await txExpand(vs(
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] }
  ));
  if (!r.ok) return { skipped: r.issue };
  assert(!findCode(r.contains, '44054006'), 'Type 2 must be excluded');
  assert(findCode(r.contains, '73211009'), 'parent should remain');
  assert(findCode(r.contains, '46635009'), 'Type 1 should remain');
  console.log(`      is-a diabetes minus Type2: ${r.count} codes (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('exclude: SNOMED is-a minus Type1 subtree', async () => {
  const r = await txExpand(vs(
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '46635009' }] }
  ));
  if (!r.ok) return { skipped: r.issue };
  assert(!findCode(r.contains, '46635009'), 'Type 1 must be excluded');
  assert(findCode(r.contains, '44054006'), 'Type 2 should remain');
  console.log(`      is-a diabetes minus Type1: ${r.count} codes (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('exclude: SNOMED exclude enumerated from is-a', async () => {
  const r = await txExpand(vs(
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    { system: SYS.SCT, concept: [{ code: '44054006' }, { code: '46635009' }] }
  ));
  if (!r.ok) return { skipped: r.issue };
  assert(!findCode(r.contains, '44054006'), '44054006 excluded');
  assert(!findCode(r.contains, '46635009'), '46635009 excluded');
  assert(findCode(r.contains, '73211009'), 'parent remains');
  console.log(`      is-a diabetes minus 2 codes: ${r.count} codes (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('exclude: cross-system gender+pubstat minus unknowns', async () => {
  const r = await txExpand(vs(
    [
      { system: SYS.GENDER },
      { system: SYS.PUBSTAT },
    ],
    [
      { system: SYS.GENDER, concept: [{ code: 'unknown' }] },
      { system: SYS.PUBSTAT, concept: [{ code: 'unknown' }] },
    ]
  ));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 6, `expected 6, got ${r.count}`);
  assert(!r.contains.some(c => c.code === 'unknown'), 'no unknowns');
  assert(findCode(r.contains, 'male'), 'male');
  assert(findCode(r.contains, 'draft'), 'draft');
  return { count: r.count, ms: r.ms };
});

test('exclude: condition-ver-status minus is-a unconfirmed', async () => {
  const r = await txExpand(vs(
    { system: SYS.CVSTAT },
    { system: SYS.CVSTAT, filter: [{ property: 'concept', op: 'is-a', value: 'unconfirmed' }] }
  ));
  if (!r.ok) return { skipped: r.issue };
  console.log(`      cvstat minus is-a unconfirmed: ${r.count} codes: ${r.contains.map(c=>c.code)}`);
  assert(!findCode(r.contains, 'unconfirmed'), 'unconfirmed excluded');
  assert(!findCode(r.contains, 'provisional'), 'provisional excluded');
  assert(!findCode(r.contains, 'differential'), 'differential excluded');
  assert(findCode(r.contains, 'confirmed'), 'confirmed remains');
  return { count: r.count, ms: r.ms };
});

// ═══════════════════════════════════════════════════════════════════════════
// Pagination
// ═══════════════════════════════════════════════════════════════════════════

test('pagination: gender count=2 offset=0', async () => {
  const r = await txExpand(vs({ system: SYS.GENDER }), { count: 2, offset: 0 });
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 2, `expected 2, got ${r.count}`);
  assert(r.total === 4, `total should be 4, got ${r.total}`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('pagination: gender count=2 offset=2', async () => {
  const r = await txExpand(vs({ system: SYS.GENDER }), { count: 2, offset: 2 });
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 2, `expected 2, got ${r.count}`);
  assert(r.total === 4, `total should be 4, got ${r.total}`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('pagination: gender pages disjoint', async () => {
  const r1 = await txExpand(vs({ system: SYS.GENDER }), { count: 2, offset: 0 });
  const r2 = await txExpand(vs({ system: SYS.GENDER }), { count: 2, offset: 2 });
  if (!r1.ok || !r2.ok) return { skipped: 'pagination not supported' };

  const c1 = r1.contains.map(c => c.code);
  const c2 = r2.contains.map(c => c.code);
  const all = [...c1, ...c2];
  assert(new Set(all).size === 4, `expected 4 unique across 2 pages, got ${new Set(all).size}`);
  return { page1: c1, page2: c2, ms: r1.ms + r2.ms };
});

test('pagination: gender offset beyond end', async () => {
  const r = await txExpand(vs({ system: SYS.GENDER }), { count: 10, offset: 10 });
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 0, `expected 0 past end, got ${r.count}`);
  assert(r.total === 4, `total should be 4, got ${r.total}`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('pagination: count=0 returns total only', async () => {
  const r = await txExpand(vs({ system: SYS.GENDER }), { count: 0 });
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 0, `count=0 should return 0 codes, got ${r.count}`);
  assert(r.total === 4, `total should be 4, got ${r.total}`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('pagination: SNOMED is-a paginated pages disjoint', async () => {
  const f = [{ property: 'concept', op: 'is-a', value: '73211009' }];
  const r1 = await txExpand(vs({ system: SYS.SCT, filter: f }), { count: 20, offset: 0 });
  const r2 = await txExpand(vs({ system: SYS.SCT, filter: f }), { count: 20, offset: 20 });
  if (!r1.ok || !r2.ok) return { skipped: 'pagination not supported for SNOMED is-a' };

  assert(r1.count === 20, `page 1: expected 20, got ${r1.count}`);
  assert(r2.count === 20, `page 2: expected 20, got ${r2.count}`);

  const c1 = new Set(r1.contains.map(c => c.code));
  const c2 = new Set(r2.contains.map(c => c.code));
  const overlap = [...c1].filter(c => c2.has(c));
  assert(overlap.length === 0, `pages must not overlap, found: ${overlap.slice(0, 5)}`);

  console.log(`      SNOMED is-a paginated: total=${r1.total}, p1=${r1.count}, p2=${r2.count}`);
  return { total: r1.total, ms: r1.ms + r2.ms };
});

// ═══════════════════════════════════════════════════════════════════════════
// Multi-system
// ═══════════════════════════════════════════════════════════════════════════

test('multi-system: gender + pubstat union', async () => {
  const r = await txExpand(vs([
    { system: SYS.GENDER },
    { system: SYS.PUBSTAT },
  ]));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 8, `expected 8 (4+4), got ${r.count}`);
  const systems = [...new Set(r.contains.map(c => c.system))];
  assert(systems.length === 2, `expected 2 systems, got ${systems.length}`);
  return { count: r.count, ms: r.ms };
});

test('multi-system: SNOMED + gender', async () => {
  const r = await txExpand(vs([
    { system: SYS.SCT, concept: [{ code: '73211009' }] },
    { system: SYS.GENDER, concept: [{ code: 'male' }] },
  ]));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 2, `expected 2, got ${r.count}`);
  assert(findCode(r.contains, '73211009'), 'SNOMED code');
  assert(findCode(r.contains, 'male'), 'gender code');
  return { count: r.count, ms: r.ms };
});

test('multi-system: three v0 systems', async () => {
  const r = await txExpand(vs([
    { system: SYS.SCT, concept: [{ code: '73211009' }] },
    { system: SYS.LOINC, concept: [{ code: '2160-0' }] },
    { system: SYS.RXNORM, concept: [{ code: '1191' }] },
  ]));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 3, `expected 3, got ${r.count}`);
  assert(findCode(r.contains, '73211009'), 'SNOMED');
  assert(findCode(r.contains, '2160-0'), 'LOINC');
  assert(findCode(r.contains, '1191'), 'RxNorm');
  return { count: r.count, ms: r.ms };
});

test('multi-system: same system two includes (dedup)', async () => {
  const r = await txExpand(vs([
    { system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] },
    { system: SYS.GENDER, concept: [{ code: 'female' }, { code: 'other' }] },
  ]));
  if (!r.ok) return { skipped: r.issue };
  // Should union and deduplicate
  console.log(`      same-system dedup: ${r.count} codes: ${r.contains.map(c=>c.code)}`);
  assert(r.count === 3, `expected 3 (male+female+other deduped), got ${r.count}`);
  return { count: r.count, ms: r.ms };
});

// ═══════════════════════════════════════════════════════════════════════════
// VS import
// ═══════════════════════════════════════════════════════════════════════════

test('vs-import: administrative-gender VS', async () => {
  const r = await txExpand(vs({
    valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'],
  }));
  if (!r.ok) return { skipped: r.issue };
  assert(r.count === 4, `expected 4, got ${r.count}`);
  assert(findCode(r.contains, 'male'), 'male');
  assert(findCode(r.contains, 'female'), 'female');
  return { count: r.count, ms: r.ms };
});

test('vs-import: system + valueSet intersection', async () => {
  const r = await txExpand(vs({
    system: SYS.GENDER,
    concept: [{ code: 'male' }, { code: 'female' }, { code: 'other' }],
    valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'],
  }));
  if (!r.ok) return { skipped: r.issue };
  // All 3 are in the VS, so intersection = 3
  console.log(`      system+VS intersection: ${r.count} codes: ${r.contains.map(c=>c.code)}`);
  assert(r.count === 3, `expected 3 (all in VS), got ${r.count}`);
  return { count: r.count, ms: r.ms };
});

// ═══════════════════════════════════════════════════════════════════════════
// Combined
// ═══════════════════════════════════════════════════════════════════════════

test('combined: SNOMED is-a + text=insulin', async () => {
  const r = await txExpand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }), { filter: 'insulin' });
  if (!r.ok) return { skipped: r.issue };
  assert(r.count > 0, 'should have results');
  console.log(`      is-a diabetes + text=insulin: ${r.count} codes (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('combined: include+exclude filter same system', async () => {
  const r = await txExpand(vs(
    { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    [
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '46635009' }] },
    ]
  ));
  if (!r.ok) return { skipped: r.issue };
  assert(!findCode(r.contains, '44054006'), 'Type 2 excluded');
  assert(!findCode(r.contains, '46635009'), 'Type 1 excluded');
  assert(findCode(r.contains, '73211009'), 'parent remains');
  console.log(`      diabetes minus Type1+Type2 subtrees: ${r.count} codes (total=${r.total})`);
  return { count: r.count, total: r.total, ms: r.ms };
});

test('combined: RxNorm text=aspirin + TTY=IN', async () => {
  const r = await txExpand(vs({
    system: SYS.RXNORM,
    filter: [{ property: 'TTY', op: '=', value: 'IN' }],
  }), { filter: 'aspirin', count: 20 });
  if (!r.ok) return { skipped: `tx.fhir.org: ${r.issue}` };
  console.log(`      RxNorm aspirin+TTY=IN: ${r.count} codes (total=${r.total})`);
  if (r.count > 0) {
    assert(findCode(r.contains, '1191'), 'aspirin 1191 is TTY=IN');
  }
  return { count: r.count, total: r.total, ms: r.ms };
});

// ═══════════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════════

async function run() {
  const filter = process.argv[2]?.toLowerCase();
  console.log(`\nValidating ${tests.length} expectations against tx.fhir.org${filter ? ` (filter: "${filter}")` : ''}...\n`);

  let passed = 0, failed = 0, skipped = 0;
  const learnings = [];

  for (const t of tests) {
    if (filter && !t.name.toLowerCase().includes(filter)) {
      skipped++;
      continue;
    }

    try {
      const extra = await t.fn();
      if (extra?.skipped) {
        console.log(`  ⏭  ${t.name} — ${extra.skipped}`);
        skipped++;
        learnings.push({ test: t.name, status: 'skipped', reason: extra.skipped });
      } else {
        const info = extra ? ` ${JSON.stringify(extra)}` : '';
        console.log(`  ✅ ${t.name}${info}`);
        passed++;
        learnings.push({ test: t.name, status: 'confirmed', data: extra });
      }
    } catch (e) {
      console.log(`  ❌ ${t.name} — ${e.message}`);
      failed++;
      learnings.push({ test: t.name, status: 'mismatch', error: e.message });
    }

    // Rate limit: tx.fhir.org is a public service
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n${passed} confirmed, ${failed} mismatches, ${skipped} skipped/unsupported\n`);

  // Summary of learnings
  const mismatches = learnings.filter(l => l.status === 'mismatch');
  if (mismatches.length > 0) {
    console.log('=== MISMATCHES (our expectations differ from tx.fhir.org) ===');
    for (const m of mismatches) {
      console.log(`  ${m.test}: ${m.error}`);
    }
    console.log();
  }

  const confirmed = learnings.filter(l => l.status === 'confirmed');
  if (confirmed.length > 0) {
    console.log('=== CONFIRMED ground truth ===');
    for (const c of confirmed) {
      console.log(`  ${c.test}: ${JSON.stringify(c.data)}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
