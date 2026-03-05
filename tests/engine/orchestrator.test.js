'use strict';

const { canHandleValueSet, expandViaIR, buildExpandedValueSet } = require('../../tx/engine/orchestrator');
const { SqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');
const { SNOMED_DB, LOINC_DB, hasSnomed, hasLoinc } = require('../v0-db-config');

const hasDBs = hasSnomed && hasLoinc;
const describeIfDBs = hasDBs ? describe : describe.skip;

let i18n, langDefs;
let sctFactory, loincFactory;
let providers = new Map(); // system -> provider

beforeAll(async () => {
  langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
});

function makeOpContext() {
  return new OperationContext('en', i18n);
}

async function findProvider(system, version) {
  if (!providers.has(system)) {
    let factory;
    if (system === 'http://snomed.info/sct') factory = sctFactory;
    else if (system === 'http://loinc.org') factory = loincFactory;
    if (factory) {
      providers.set(system, await factory.build(makeOpContext(), null));
    }
  }
  return providers.get(system) || null;
}

afterAll(() => {
  for (const p of providers.values()) {
    if (p && typeof p.close === 'function') p.close();
  }
});

describe('canHandleValueSet', () => {
  test('handles simple include', () => {
    expect(canHandleValueSet({
      compose: { include: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }] }
    })).toBe(true);
  });

  test('accepts empty/degenerate shapes (expands to empty)', () => {
    expect(canHandleValueSet({})).toBe(true);
    expect(canHandleValueSet({ compose: {} })).toBe(true);
    expect(canHandleValueSet({ compose: { include: [] } })).toBe(true);
    expect(canHandleValueSet({ compose: { include: [{}] } })).toBe(true);
  });

  test('handles include with exclude', () => {
    expect(canHandleValueSet({
      compose: {
        include: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }],
        exclude: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] }],
      }
    })).toBe(true);
  });
});

describe('expandViaIR trivial empties', () => {
  test('no compose returns empty expansion', async () => {
    const result = await expandViaIR({ resourceType: 'ValueSet', url: 'test:empty-no-compose' }, {});
    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(0);
    expect(result.expansion.contains).toEqual([]);
  });

  test('empty include returns empty expansion', async () => {
    const result = await expandViaIR({
      resourceType: 'ValueSet',
      url: 'test:empty-include',
      compose: { include: [] },
    }, {});
    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(0);
    expect(result.expansion.contains).toEqual([]);
  });
});

describeIfDBs('expandViaIR', () => {
  beforeAll(async () => {
    sctFactory = new SqliteV0FactoryProvider(i18n, SNOMED_DB);
    await sctFactory.load();

    loincFactory = new SqliteV0FactoryProvider(i18n, LOINC_DB);
    await loincFactory.load();
  });

  test('simple is-a expansion', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:diabetes',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider,
      activeOnly: true,
      count: 50,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.contains.length).toBeGreaterThan(10);
    expect(result.expansion.contains.length).toBeLessThanOrEqual(50);
    expect(result.expansion.total).toBeGreaterThan(50); // Many subtypes of diabetes

    // Check structure
    for (const c of result.expansion.contains) {
      expect(c.system).toBe('http://snomed.info/sct');
      expect(c.code).toBeTruthy();
      expect(c.display).toBeTruthy();
    }
  });

  test('include + exclude (diff)', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:diabetes-minus-type2',
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
    };

    const result = await expandViaIR(vs, {
      findProvider,
      activeOnly: true,
      count: 1000,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.contains.length).toBeGreaterThan(0);

    // Should NOT include Type 2 diabetes
    expect(result.expansion.contains.some(c => c.code === '44054006')).toBe(false);

    // Should still include Diabetes mellitus itself (it's not a descendant of Type 2 DM)
    expect(result.expansion.contains.some(c => c.code === '73211009')).toBe(true);
  });

  test('concept enumeration', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:specific-codes',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [
            { code: '73211009' },
            { code: '44054006' },
            { code: '46635009' },
          ],
        }],
      },
    };

    const result = await expandViaIR(vs, { findProvider, count: 100 });

    expect(result).toBeTruthy();
    expect(result.expansion.contains.length).toBe(3);
    const codes = result.expansion.contains.map(c => c.code).sort();
    expect(codes).toEqual(['44054006', '46635009', '73211009']);
  });

  test('unpinned include does not emit concept version in expanded ValueSet', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:version-unpinned',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, { findProvider, count: 10 });
    expect(result).toBeTruthy();
    expect(result.expansion.contains.length).toBe(1);
    expect(result.expansion.contains[0].version).toBeUndefined();

    const expanded = buildExpandedValueSet(vs, result.expansion, { count: 10 });
    expect(expanded.expansion.contains[0].version).toBeUndefined();
  });

  test('version-pinned include emits concept version in expanded ValueSet', async () => {
    const provider = await findProvider('http://snomed.info/sct');
    const pinnedVersion = provider.version();
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:version-pinned',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          version: pinnedVersion,
          concept: [{ code: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, { findProvider, count: 10 });
    expect(result).toBeTruthy();
    expect(result.expansion.contains.length).toBe(1);
    expect(result.expansion.contains[0].version).toBeTruthy();

    const expanded = buildExpandedValueSet(vs, result.expansion, { count: 10 });
    expect(expanded.expansion.contains[0].version).toBeTruthy();
  });

  test('pagination (offset + count)', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:diabetes',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }],
      },
    };

    // First page
    const page1 = await expandViaIR(vs, { findProvider, activeOnly: true, offset: 0, count: 10 });
    expect(page1.expansion.contains.length).toBe(10);

    // Second page
    const page2 = await expandViaIR(vs, { findProvider, activeOnly: true, offset: 10, count: 10 });
    expect(page2.expansion.contains.length).toBe(10);

    // No overlap
    const codes1 = new Set(page1.expansion.contains.map(c => c.code));
    const codes2 = new Set(page2.expansion.contains.map(c => c.code));
    for (const c of codes2) {
      expect(codes1.has(c)).toBe(false);
    }

    // Same total
    expect(page1.expansion.total).toBe(page2.expansion.total);
  });

  test('text search filter', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:diabetes-search',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider,
      activeOnly: true,
      text: 'type 2',
      count: 50,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.contains.length).toBeGreaterThan(0);
  });

  test('LOINC with property filter', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:loinc-lab',
      compose: {
        include: [{
          system: 'http://loinc.org',
          filter: [{ property: 'CLASSTYPE', op: '=', value: '1' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider,
      count: 20,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.contains.length).toBe(20);
    for (const c of result.expansion.contains) {
      expect(c.system).toBe('http://loinc.org');
    }
  });

  test('buildExpandedValueSet produces valid FHIR', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'http://example.com/ValueSet/test',
      name: 'TestVS',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, { findProvider, count: 100 });
    const expanded = buildExpandedValueSet(vs, result.expansion, {
      activeOnly: false,
    });

    expect(expanded.resourceType).toBe('ValueSet');
    expect(expanded.url).toBe('http://example.com/ValueSet/test');
    expect(expanded.expansion).toBeTruthy();
    expect(expanded.expansion.timestamp).toBeTruthy();
    expect(expanded.expansion.identifier).toMatch(/^urn:uuid:/);
    expect(expanded.expansion.contains.length).toBe(1);
    expect(expanded.expansion.contains[0].code).toBe('73211009');
    expect(expanded.expansion.total).toBe(1);
  });

  test('includeDesignations returns designation entries', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:dm-desig',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider,
      includeDesignations: true,
      count: 10,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.contains.length).toBe(1);
    const entry = result.expansion.contains[0];
    expect(entry.code).toBe('73211009');
    expect(entry.display).toBeTruthy();

    // Should have designations
    expect(entry.designation).toBeDefined();
    expect(entry.designation.length).toBeGreaterThan(0);

    // Each designation should have value and language
    for (const d of entry.designation) {
      expect(d.value).toBeTruthy();
      expect(d.language).toBeTruthy();
    }

    // Should include the FSN (fully specified name)
    const fsn = entry.designation.find(d => d.value?.includes('(disorder)'));
    expect(fsn).toBeTruthy();
  });

  test('properties param returns requested properties', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:dm-props',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider,
      properties: ['116680003'], // is-a property
      count: 10,
    });

    expect(result).toBeTruthy();
    const entry = result.expansion.contains[0];
    expect(entry.property).toBeDefined();
    expect(entry.property.length).toBeGreaterThan(0);

    // Should have concept-valued properties (valueCoding)
    const isaProps = entry.property.filter(p => p.code === '116680003');
    expect(isaProps.length).toBeGreaterThan(0);
    for (const p of isaProps) {
      expect(p.valueCoding).toBeTruthy();
      expect(p.valueCoding.code).toBeTruthy();
    }
  });

  test('wildcard properties returns all properties', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:dm-all-props',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider,
      properties: ['*'],
      count: 10,
    });

    const entry = result.expansion.contains[0];
    expect(entry.property).toBeDefined();
    expect(entry.property.length).toBeGreaterThan(0);
  });

  test('LOINC designations include multiple language terms', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:creatinine-desig',
      compose: {
        include: [{
          system: 'http://loinc.org',
          concept: [{ code: '2160-0' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider,
      includeDesignations: true,
      count: 10,
    });

    const entry = result.expansion.contains[0];
    expect(entry.designation).toBeDefined();
    expect(entry.designation.length).toBeGreaterThan(3); // LOINC has many designations
  });

  test('returns null for unsupported systems', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:unknown',
      compose: {
        include: [{
          system: 'http://unknown.system/cs',
          concept: [{ code: 'test' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider: async () => null,
      count: 100,
    });

    expect(result).toBeNull();
  });

  test('count=0 returns total only with no contains', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:diabetes-count0',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider,
      activeOnly: true,
      count: 0,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.contains).toEqual([]);
    expect(result.expansion.total).toBeGreaterThan(50); // Many subtypes of diabetes
  });

  test('used-codesystem reported in expansion', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:dm-used-cs',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, { findProvider, count: 10 });

    expect(result).toBeTruthy();
    expect(result.expansion.usedSystems).toBeDefined();
    expect(result.expansion.usedSystems.length).toBe(1);
    // Should be system|version canonical format
    expect(result.expansion.usedSystems[0]).toMatch(/^http:\/\/snomed\.info\/sct\|/);
  });

  test('buildExpandedValueSet includes used-codesystem parameters', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'http://example.com/ValueSet/test-used-cs',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, { findProvider, count: 10 });
    const expanded = buildExpandedValueSet(vs, result.expansion, { count: 10 });

    const usedCSParams = expanded.expansion.parameter.filter(p => p.name === 'used-codesystem');
    expect(usedCSParams.length).toBe(1);
    expect(usedCSParams[0].valueUri).toMatch(/^http:\/\/snomed\.info\/sct\|/);
  });

  test('count=0 with buildExpandedValueSet produces total, no contains', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'http://example.com/ValueSet/count0-full',
      status: 'active',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider,
      activeOnly: true,
      count: 0,
    });
    const expanded = buildExpandedValueSet(vs, result.expansion, {
      count: 0,
      activeOnly: true,
    });

    expect(expanded.expansion.total).toBeGreaterThan(50);
    expect(expanded.expansion.contains).toBeUndefined(); // empty array becomes undefined
    // count param should be present
    const countParam = expanded.expansion.parameter.find(p => p.name === 'count');
    expect(countParam).toBeDefined();
    expect(countParam.valueInteger).toBe(0);
  });
});
