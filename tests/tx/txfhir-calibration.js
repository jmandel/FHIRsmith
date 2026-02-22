'use strict';

const https = require('https');

const TX_BASE = process.env.TX_BASE || 'https://tx.fhir.org/r5';
const EXPAND_ENDPOINT = `${TX_BASE}/ValueSet/$expand`;

function asUrl(base, query) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function requestJson(url, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(url, {
      method,
      headers: payload
        ? {
            'accept': 'application/fhir+json, application/json',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          }
        : { 'accept': 'application/fhir+json, application/json' },
      timeout: 45000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${String(data).slice(0, 300)}`));
          return;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function flattenContains(contains, out = []) {
  for (const c of contains || []) {
    out.push(c);
    if (c.contains) flattenContains(c.contains, out);
  }
  return out;
}

function membershipSet(expansion) {
  return new Set(flattenContains(expansion?.contains || []).map((c) => `${c.system || ''}|${c.code || ''}`));
}

function fail(msg) {
  throw new Error(msg);
}

function expect(cond, msg) {
  if (!cond) fail(msg || 'expectation failed');
}

async function runCase(c) {
  const url = asUrl(EXPAND_ENDPOINT, c.query || {});
  const res = await requestJson(url, {
    method: c.body ? 'POST' : 'GET',
    body: c.body || undefined,
  });

  if (res.status >= 400 || res.body.resourceType === 'OperationOutcome') {
    const issue = res.body?.issue?.[0];
    const diag = issue?.details?.text || issue?.diagnostics || `HTTP ${res.status}`;
    return { ok: false, error: diag };
  }

  const expansion = res.body.expansion;
  if (!expansion) return { ok: false, error: 'No expansion in response' };

  const payload = {
    expansion,
    contains: flattenContains(expansion.contains || []),
    membership: membershipSet(expansion),
  };

  try {
    c.check(payload);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return { ok: true, payload };
}

const SYS = {
  GENDER: 'http://hl7.org/fhir/administrative-gender',
  PUBSTAT: 'http://hl7.org/fhir/publication-status',
  CVSTAT: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
};

const CASES = [
  {
    name: 'shape-A: administrative-gender canonical',
    query: { url: 'http://hl7.org/fhir/ValueSet/administrative-gender' },
    check: ({ membership }) => {
      expect(membership.has(`${SYS.GENDER}|male`), 'missing male');
      expect(membership.has(`${SYS.GENDER}|female`), 'missing female');
      expect(membership.has(`${SYS.GENDER}|other`), 'missing other');
      expect(membership.has(`${SYS.GENDER}|unknown`), 'missing unknown');
    },
    assessTests: [
      'shape-A: administrative-gender (inline FHIR cs-cs)',
      'shape-B: gender enumerated subset (inline FHIR cs-cs)',
      'vs-import: pure import of administrative-gender VS',
    ],
  },
  {
    name: 'shape-A: publication-status canonical',
    query: { url: 'http://hl7.org/fhir/ValueSet/publication-status' },
    check: ({ membership }) => {
      expect(membership.has(`${SYS.PUBSTAT}|draft`), 'missing draft');
      expect(membership.has(`${SYS.PUBSTAT}|active`), 'missing active');
      expect(membership.has(`${SYS.PUBSTAT}|retired`), 'missing retired');
      expect(membership.has(`${SYS.PUBSTAT}|unknown`), 'missing unknown');
    },
    assessTests: ['shape-A: publication-status (inline FHIR cs-cs)'],
  },
  {
    name: 'shape-A: condition-ver-status canonical',
    query: { url: 'http://hl7.org/fhir/ValueSet/condition-ver-status' },
    check: ({ membership }) => {
      for (const code of ['unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted', 'entered-in-error']) {
        expect(membership.has(`${SYS.CVSTAT}|${code}`), `missing ${code}`);
      }
    },
    assessTests: ['provider: cs-cs hierarchy iteration (condition-ver-status)'],
  },
  {
    name: 'exclude: gender minus other+unknown custom compose',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{ system: SYS.GENDER }],
        exclude: [{ system: SYS.GENDER, concept: [{ code: 'other' }, { code: 'unknown' }] }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has(`${SYS.GENDER}|male`), 'missing male');
      expect(membership.has(`${SYS.GENDER}|female`), 'missing female');
      expect(!membership.has(`${SYS.GENDER}|other`), 'other should be excluded');
      expect(!membership.has(`${SYS.GENDER}|unknown`), 'unknown should be excluded');
    },
    assessTests: ['exclude: gender minus other+unknown (cs-cs)'],
  },
  {
    name: 'exclude: cross-system unknown removal custom compose',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{ system: SYS.GENDER }, { system: SYS.PUBSTAT }],
        exclude: [
          { system: SYS.GENDER, concept: [{ code: 'unknown' }] },
          { system: SYS.PUBSTAT, concept: [{ code: 'unknown' }] },
        ],
      },
    },
    check: ({ membership }) => {
      expect(membership.has(`${SYS.GENDER}|male`), 'male should remain');
      expect(membership.has(`${SYS.PUBSTAT}|active`), 'active should remain');
      expect(!membership.has(`${SYS.GENDER}|unknown`), 'gender unknown should be excluded');
      expect(!membership.has(`${SYS.PUBSTAT}|unknown`), 'pubstatus unknown should be excluded');
    },
    assessTests: ['exclude: cross-system multi-exclude (gender + pub-status minus unknowns)'],
  },
  {
    name: 'filter: gender regex [mf].* custom compose',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: SYS.GENDER,
          filter: [{ property: 'concept', op: 'regex', value: '[mf].*' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has(`${SYS.GENDER}|male`), 'male should match');
      expect(membership.has(`${SYS.GENDER}|female`), 'female should match');
      expect(!membership.has(`${SYS.GENDER}|other`), 'other should not match [mf].*');
      expect(!membership.has(`${SYS.GENDER}|unknown`), 'unknown should not match [mf].*');
    },
    assessTests: ['filter: gender regex [mf].* (inline FHIR cs-cs)'],
  },
  {
    name: 'filter: inline FHIR concept = exact code',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: SYS.CVSTAT,
          filter: [{ property: 'concept', op: '=', value: 'confirmed' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has(`${SYS.CVSTAT}|confirmed`), 'confirmed should be included');
      expect(!membership.has(`${SYS.CVSTAT}|unconfirmed`), 'unconfirmed should not be included');
      expect(!membership.has(`${SYS.CVSTAT}|refuted`), 'refuted should not be included');
    },
    assessTests: ['filter: inline FHIR concept = exact code (cs-cs)'],
  },
  {
    name: 'filter: inline FHIR is-a hierarchy',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: SYS.CVSTAT,
          filter: [{ property: 'concept', op: 'is-a', value: 'unconfirmed' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has(`${SYS.CVSTAT}|unconfirmed`), 'unconfirmed should be included');
      expect(membership.has(`${SYS.CVSTAT}|provisional`), 'provisional should be included');
      expect(membership.has(`${SYS.CVSTAT}|differential`), 'differential should be included');
      expect(!membership.has(`${SYS.CVSTAT}|confirmed`), 'confirmed should not be included');
    },
    assessTests: ['filter: inline FHIR is-a with hierarchy (condition-ver-status)'],
  },
  {
    name: 'filter: inline FHIR descendent-of hierarchy',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: SYS.CVSTAT,
          filter: [{ property: 'concept', op: 'descendent-of', value: 'unconfirmed' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(!membership.has(`${SYS.CVSTAT}|unconfirmed`), 'unconfirmed should be excluded for descendent-of');
      expect(membership.has(`${SYS.CVSTAT}|provisional`), 'provisional should be included');
      expect(membership.has(`${SYS.CVSTAT}|differential`), 'differential should be included');
    },
    assessTests: ['filter: inline FHIR descendent-of (condition-ver-status)'],
  },
  {
    name: 'exclude: inline FHIR filter-based exclude',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{ system: SYS.CVSTAT }],
        exclude: [{
          system: SYS.CVSTAT,
          filter: [{ property: 'concept', op: 'is-a', value: 'unconfirmed' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(!membership.has(`${SYS.CVSTAT}|unconfirmed`), 'unconfirmed should be excluded');
      expect(!membership.has(`${SYS.CVSTAT}|provisional`), 'provisional should be excluded');
      expect(!membership.has(`${SYS.CVSTAT}|differential`), 'differential should be excluded');
      expect(membership.has(`${SYS.CVSTAT}|confirmed`), 'confirmed should remain');
      expect(membership.has(`${SYS.CVSTAT}|refuted`), 'refuted should remain');
      expect(membership.has(`${SYS.CVSTAT}|entered-in-error`), 'entered-in-error should remain');
    },
    assessTests: ['exclude: inline FHIR filter-based exclude (condition-ver-status)'],
  },
  {
    name: 'multi-system: same system in two include components (dedup)',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [
          { system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] },
          { system: SYS.GENDER, concept: [{ code: 'female' }, { code: 'other' }] },
        ],
      },
    },
    check: ({ membership }) => {
      expect(membership.has(`${SYS.GENDER}|male`), 'male should be included');
      expect(membership.has(`${SYS.GENDER}|female`), 'female should be included');
      expect(membership.has(`${SYS.GENDER}|other`), 'other should be included');
      expect(!membership.has(`${SYS.GENDER}|unknown`), 'unknown should not be included');
    },
    assessTests: ['multi-system: same system in two include components (union, dedup)'],
  },
  {
    name: 'shape-B: SNOMED enumerated concept list',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has('http://snomed.info/sct|73211009'), 'missing 73211009');
      expect(membership.has('http://snomed.info/sct|44054006'), 'missing 44054006');
      expect(membership.has('http://snomed.info/sct|46635009'), 'missing 46635009');
    },
    assessTests: ['shape-B: SNOMED enumerated (v0 pushdown)'],
  },
  {
    name: 'shape-B: LOINC enumerated concept list',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: 'http://loinc.org',
          concept: [{ code: '2160-0' }, { code: '2345-7' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has('http://loinc.org|2160-0'), 'missing 2160-0');
      expect(membership.has('http://loinc.org|2345-7'), 'missing 2345-7');
    },
    assessTests: ['shape-B: LOINC enumerated (v0 pushdown)'],
  },
  {
    name: 'shape-B: RxNorm enumerated concept list',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
          concept: [{ code: '1191' }, { code: '161' }, { code: '860975' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has('http://www.nlm.nih.gov/research/umls/rxnorm|1191'), 'missing 1191');
      expect(membership.has('http://www.nlm.nih.gov/research/umls/rxnorm|161'), 'missing 161');
      expect(membership.has('http://www.nlm.nih.gov/research/umls/rxnorm|860975'), 'missing 860975');
    },
    assessTests: ['shape-B: RxNorm enumerated (v0 pushdown)'],
  },
  {
    name: 'shape-B: SNOMED single concept exact match',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has('http://snomed.info/sct|73211009'), 'missing 73211009');
    },
    assessTests: ['shape-B: single concept exact match (v0)'],
  },
  {
    name: 'filter: SNOMED is-a diabetes',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has('http://snomed.info/sct|73211009'), 'is-a should include seed code');
      expect(membership.has('http://snomed.info/sct|44054006'), 'expected known descendant 44054006');
      expect(membership.has('http://snomed.info/sct|46635009'), 'expected known descendant 46635009');
    },
    assessTests: ['filter: SNOMED is-a diabetes (v0 closure, includes self)'],
  },
  {
    name: 'filter: SNOMED descendent-of diabetes',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'descendent-of', value: '73211009' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(!membership.has('http://snomed.info/sct|73211009'), 'descendent-of should exclude seed code');
      expect(membership.has('http://snomed.info/sct|44054006'), 'expected known descendant 44054006');
      expect(membership.has('http://snomed.info/sct|46635009'), 'expected known descendant 46635009');
    },
    assessTests: ['filter: SNOMED descendent-of diabetes (v0 closure, excludes self)'],
  },
  {
    name: 'exclude: SNOMED is-a minus Type2 subtree',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }],
        exclude: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '44054006' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has('http://snomed.info/sct|73211009'), 'parent should remain');
      expect(!membership.has('http://snomed.info/sct|44054006'), 'Type2 seed should be excluded');
    },
    assessTests: ['exclude: SNOMED is-a minus Type2 subtree (v0 pushdown)'],
  },
  {
    name: 'exclude: SNOMED is-a minus Type1 subtree',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }],
        exclude: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '46635009' }],
        }],
      },
    },
    check: ({ membership }) => {
      expect(membership.has('http://snomed.info/sct|73211009'), 'parent should remain');
      expect(!membership.has('http://snomed.info/sct|46635009'), 'Type1 seed should be excluded');
    },
    assessTests: ['exclude: SNOMED is-a minus Type1 subtree (v0 pushdown)'],
  },
  {
    name: 'combined: include filter + exclude filter same system (SNOMED)',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }],
        exclude: [
          {
            system: 'http://snomed.info/sct',
            filter: [{ property: 'concept', op: 'is-a', value: '44054006' }],
          },
          {
            system: 'http://snomed.info/sct',
            filter: [{ property: 'concept', op: 'is-a', value: '46635009' }],
          },
        ],
      },
    },
    check: ({ membership }) => {
      expect(membership.has('http://snomed.info/sct|73211009'), 'parent should remain');
      expect(!membership.has('http://snomed.info/sct|44054006'), 'Type2 seed should be excluded');
      expect(!membership.has('http://snomed.info/sct|46635009'), 'Type1 seed should be excluded');
    },
    assessTests: ['combined: include filter + exclude filter same system (v0)'],
  },
  {
    name: 'multi-system: SNOMED + gender',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [
          { system: 'http://snomed.info/sct', concept: [{ code: '73211009' }] },
          { system: SYS.GENDER, concept: [{ code: 'male' }] },
        ],
      },
    },
    check: ({ membership }) => {
      expect(membership.has('http://snomed.info/sct|73211009'), 'SNOMED code missing');
      expect(membership.has(`${SYS.GENDER}|male`), 'gender code missing');
    },
    assessTests: ['multi-system: SNOMED + gender (mixed v0 + cs-cs)'],
  },
  {
    name: 'multi-system: SNOMED + LOINC + RxNorm',
    body: {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [
          { system: 'http://snomed.info/sct', concept: [{ code: '73211009' }] },
          { system: 'http://loinc.org', concept: [{ code: '2160-0' }] },
          { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', concept: [{ code: '1191' }] },
        ],
      },
    },
    check: ({ membership }) => {
      expect(membership.has('http://snomed.info/sct|73211009'), 'SNOMED code missing');
      expect(membership.has('http://loinc.org|2160-0'), 'LOINC code missing');
      expect(membership.has('http://www.nlm.nih.gov/research/umls/rxnorm|1191'), 'RxNorm code missing');
    },
    assessTests: ['multi-system: three systems (SNOMED + LOINC + RxNorm)'],
  },
  {
    name: 'text-search: inline FHIR filter=male canonical',
    query: {
      url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
      filter: 'male',
    },
    check: ({ membership }) => {
      expect(membership.has(`${SYS.GENDER}|male`), 'male should be present with filter=male');
    },
    assessTests: ['text-search: inline FHIR filter=male (cs-cs searchFilter)'],
  },
];

async function main() {
  const assessedRows = [];
  const failures = [];

  for (const c of CASES) {
    let res;
    try {
      res = await runCase(c);
    } catch (e) {
      failures.push({ name: c.name, error: `request failed: ${e.message}` });
      console.log(`❌ ${c.name}: request failed: ${e.message}`);
      continue;
    }

    if (!res.ok) {
      failures.push({ name: c.name, error: res.error });
      console.log(`❌ ${c.name}: ${res.error}`);
      continue;
    }

    console.log(`✅ ${c.name}`);
    for (const testName of c.assessTests || []) {
      assessedRows.push({
        name: testName,
        status: 'assessed',
        assessedAt: new Date().toISOString().slice(0, 10),
        source: TX_BASE,
        notes: `Validated via calibration case '${c.name}'.`,
      });
    }
  }

  if (assessedRows.length > 0) {
    console.log('\nSuggested assessment metadata entries (merge into expand-v2-assessment-status.json):');
    console.log(JSON.stringify(assessedRows, null, 2));
  } else {
    console.log('\nNo successful assessment suggestions generated.');
  }

  if (failures.length > 0) {
    console.log('\nCalibration issues:');
    for (const f of failures) console.log(`- ${f.name}: ${f.error}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
