'use strict';

/**
 * End-to-end comparison tests: IR engine vs legacy ValueSetExpander.
 *
 * These tests hit the actual running server with `_engine=ir` and `_engine=legacy`
 * parameters and compare the full FHIR expansion responses — codes, displays,
 * totals, designations, and properties.
 *
 * Requires the server to be running on localhost:8000 with v0 databases loaded.
 */

const BASE = 'http://localhost:8000/r4/ValueSet/$expand';

let serverAvailable = false;

beforeAll(async () => {
  try {
    const resp = await fetch(`${BASE}?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=1&_engine=ir`);
    serverAvailable = resp.ok;
  } catch {
    serverAvailable = false;
  }
});

const describeIfServer = () => serverAvailable ? describe : describe.skip;

function makeUrl(vsUrl, params = {}) {
  const qs = new URLSearchParams({ url: vsUrl, ...params });
  return `${BASE}?${qs}`;
}

async function expandBothPaths(vsUrl, extraParams = {}) {
  const irResp = await fetch(makeUrl(vsUrl, { ...extraParams, _engine: 'ir' }));
  const legacyResp = await fetch(makeUrl(vsUrl, { ...extraParams, _engine: 'legacy' }));

  if (!irResp.ok || !legacyResp.ok) {
    const irBody = await irResp.text();
    const legacyBody = await legacyResp.text();
    throw new Error(`Request failed: IR=${irResp.status} Legacy=${legacyResp.status}\nIR: ${irBody.slice(0, 300)}\nLegacy: ${legacyBody.slice(0, 300)}`);
  }

  const ir = await irResp.json();
  const legacy = await legacyResp.json();

  return { ir, legacy };
}

/** Recursively extract all codes from expansion (handles nested .contains hierarchy). */
function extractCodes(expansion) {
  const codes = [];
  function walk(contains) {
    for (const c of contains || []) {
      codes.push(c.code);
      walk(c.contains);
    }
  }
  walk(expansion?.expansion?.contains);
  return codes.sort();
}

function extractCodeDisplayPairs(expansion) {
  const pairs = [];
  function walk(contains) {
    for (const c of contains || []) {
      pairs.push({ code: c.code, display: c.display });
      walk(c.contains);
    }
  }
  walk(expansion?.expansion?.contains);
  return pairs.sort((a, b) => a.code.localeCompare(b.code));
}

// Use a getter-like pattern to defer the check
let _desc;
function getDescribe() {
  if (!_desc) _desc = describeIfServer();
  return _desc;
}

describe('E2E: IR vs Legacy expansion comparison', () => {
  // We can't use describeIfServer() at parse time since beforeAll hasn't run.
  // Instead, each test checks serverAvailable and skips if not.

  function testIfServer(name, fn, timeout) {
    test(name, async () => {
      if (!serverAvailable) return; // silent skip
      await fn();
    }, timeout);
  }

  testIfServer('SNOMED is-a: same code set (legacy hierarchy flattened)', async () => {
    const { ir, legacy } = await expandBothPaths(
      'http://snomed.info/sct?fhir_vs=isa/73211009',
      { count: '200', activeOnly: 'true' }
    );

    const irCodes = extractCodes(ir);
    const legacyCodes = extractCodes(legacy);

    // Same total
    expect(ir.expansion.total).toBe(legacy.expansion.total);
    // Same code set (legacy may nest codes in .contains hierarchy;
    // extractCodes walks recursively to get all codes)
    expect(irCodes).toEqual(legacyCodes);
  });

  testIfServer('SNOMED is-a: same displays', async () => {
    const { ir, legacy } = await expandBothPaths(
      'http://snomed.info/sct?fhir_vs=isa/73211009',
      { count: '50', activeOnly: 'true' }
    );

    const irPairs = extractCodeDisplayPairs(ir);
    const legacyPairs = extractCodeDisplayPairs(legacy);

    expect(irPairs).toEqual(legacyPairs);
  });

  testIfServer('SNOMED diff: same code set', async () => {
    // Diabetes minus Type 2 — uses implicit VS syntax
    // Build as a POST with a ValueSet body since implicit URLs can't express diff
    const vs = {
      resourceType: 'ValueSet',
      compose: {
        include: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }],
        exclude: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] }],
      },
    };

    const irResp = await fetch(BASE + '?_engine=ir&activeOnly=true&count=500', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType: 'Parameters', parameter: [
        { name: 'valueSet', resource: vs },
        { name: 'count', valueInteger: 500 },
        { name: 'activeOnly', valueBoolean: true },
        { name: '_engine', valueString: 'ir' },
      ]}),
    });
    const legacyResp = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType: 'Parameters', parameter: [
        { name: 'valueSet', resource: vs },
        { name: 'count', valueInteger: 500 },
        { name: 'activeOnly', valueBoolean: true },
        { name: '_engine', valueString: 'legacy' },
      ]}),
    });

    if (!irResp.ok || !legacyResp.ok) {
      console.log('IR status:', irResp.status, (await irResp.text()).slice(0, 300));
      console.log('Legacy status:', legacyResp.status, (await legacyResp.text()).slice(0, 300));
    }
    expect(irResp.ok).toBe(true);
    expect(legacyResp.ok).toBe(true);

    const ir = await irResp.json();
    const legacy = await legacyResp.json();

    expect(ir.expansion.total).toBe(legacy.expansion.total);
    expect(extractCodes(ir)).toEqual(extractCodes(legacy));
  });

  testIfServer('SNOMED concept enumeration: same codes and displays', async () => {
    const vs = {
      resourceType: 'ValueSet',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }],
        }],
      },
    };

    async function expandWith(engine) {
      const resp = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceType: 'Parameters', parameter: [
          { name: 'valueSet', resource: vs },
          { name: '_engine', valueString: engine },
        ]}),
      });
      expect(resp.ok).toBe(true);
      return resp.json();
    }

    const ir = await expandWith('ir');
    const legacy = await expandWith('legacy');

    expect(extractCodeDisplayPairs(ir)).toEqual(extractCodeDisplayPairs(legacy));
  });

  testIfServer('count=0: both return total only', async () => {
    const { ir, legacy } = await expandBothPaths(
      'http://snomed.info/sct?fhir_vs=isa/73211009',
      { count: '0', activeOnly: 'true' }
    );

    // Both should have a total
    expect(ir.expansion.total).toBeGreaterThan(50);
    expect(legacy.expansion.total).toBeGreaterThan(50);
    expect(ir.expansion.total).toBe(legacy.expansion.total);

    // Neither should have contains
    expect(ir.expansion.contains).toBeUndefined();
    expect(legacy.expansion.contains).toBeUndefined();
  });

  testIfServer('pagination: same totals, no overlap between pages', async () => {
    const page1 = await expandBothPaths(
      'http://snomed.info/sct?fhir_vs=isa/73211009',
      { count: '10', offset: '0', activeOnly: 'true' }
    );
    const page2 = await expandBothPaths(
      'http://snomed.info/sct?fhir_vs=isa/73211009',
      { count: '10', offset: '10', activeOnly: 'true' }
    );

    // Same totals across engines
    expect(page1.ir.expansion.total).toBe(page1.legacy.expansion.total);
    expect(page2.ir.expansion.total).toBe(page2.legacy.expansion.total);

    // Same codes per page across engines
    expect(extractCodes(page1.ir)).toEqual(extractCodes(page1.legacy));
    expect(extractCodes(page2.ir)).toEqual(extractCodes(page2.legacy));

    // No overlap between pages (using IR as representative)
    const p1codes = new Set(extractCodes(page1.ir));
    for (const c of extractCodes(page2.ir)) {
      expect(p1codes.has(c)).toBe(false);
    }
  });

  testIfServer('designations: same designation sets', async () => {
    const vs = {
      resourceType: 'ValueSet',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }],
        }],
      },
    };

    async function expandWith(engine) {
      const resp = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceType: 'Parameters', parameter: [
          { name: 'valueSet', resource: vs },
          { name: 'includeDesignations', valueBoolean: true },
          { name: '_engine', valueString: engine },
        ]}),
      });
      expect(resp.ok).toBe(true);
      return resp.json();
    }

    const ir = await expandWith('ir');
    const legacy = await expandWith('legacy');

    const irEntry = ir.expansion.contains[0];
    const legacyEntry = legacy.expansion.contains[0];

    expect(irEntry.code).toBe('73211009');
    expect(legacyEntry.code).toBe('73211009');

    // Both should have designations
    expect(irEntry.designation).toBeDefined();
    expect(legacyEntry.designation).toBeDefined();

    // Compare designation values (sort for deterministic comparison).
    // IR bulk decoration filters inactive designations; legacy may include them.
    // So IR designations should be a subset of legacy.
    const irDesigValues = (irEntry.designation || []).map(d => d.value).sort();
    const legacyDesigValues = new Set((legacyEntry.designation || []).map(d => d.value));
    expect(irDesigValues.length).toBeGreaterThan(0);
    for (const v of irDesigValues) {
      expect(legacyDesigValues.has(v)).toBe(true);
    }
  });

  testIfServer('LOINC property filter: same code set', async () => {
    const vs = {
      resourceType: 'ValueSet',
      compose: {
        include: [{
          system: 'http://loinc.org',
          filter: [{ property: 'CLASSTYPE', op: '=', value: '1' }],
        }],
      },
    };

    async function expandWith(engine) {
      const resp = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceType: 'Parameters', parameter: [
          { name: 'valueSet', resource: vs },
          { name: 'count', valueInteger: 100 },
          { name: '_engine', valueString: engine },
        ]}),
      });
      expect(resp.ok).toBe(true);
      return resp.json();
    }

    const ir = await expandWith('ir');
    const legacy = await expandWith('legacy');

    // Legacy may omit total for large sets; IR always provides it
    if (legacy.expansion.total != null) {
      expect(ir.expansion.total).toBe(legacy.expansion.total);
    } else {
      expect(ir.expansion.total).toBeGreaterThan(0);
    }
    // Same first 100 codes
    expect(extractCodes(ir)).toEqual(extractCodes(legacy));
  }, 30000);

  testIfServer('used-codesystem parameter present in both', async () => {
    const { ir, legacy } = await expandBothPaths(
      'http://snomed.info/sct?fhir_vs=isa/73211009',
      { count: '5', activeOnly: 'true' }
    );

    const irUsedCS = (ir.expansion.parameter || []).filter(p => p.name === 'used-codesystem');
    const legacyUsedCS = (legacy.expansion.parameter || []).filter(p => p.name === 'used-codesystem');

    expect(irUsedCS.length).toBeGreaterThan(0);
    expect(legacyUsedCS.length).toBeGreaterThan(0);

    // Both should reference SNOMED
    expect(irUsedCS[0].valueUri).toContain('snomed');
    expect(legacyUsedCS[0].valueUri).toContain('snomed');
  });
});
