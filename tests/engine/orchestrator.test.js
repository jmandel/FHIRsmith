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
  });

  test('accepts compose.lockedDate for IR path', () => {
    expect(canHandleValueSet({
      compose: {
        lockedDate: '2021-01-01',
        include: [{ system: 'http://snomed.info/sct' }],
      },
    })).toBe(true);
  });

  test('accepts wildcard component version "*" for IR path', () => {
    expect(canHandleValueSet({
      compose: {
        include: [{ system: 'http://snomed.info/sct', version: '*' }],
      },
    })).toBe(true);
  });

  test('rejects invalid include/exclude components', () => {
    // vsd-1: cannot have both concept and filter
    expect(canHandleValueSet({
      compose: { include: [{ system: 'http://snomed.info/sct', concept: [{ code: '73211009' }], filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }] }
    })).toBe(false);

    // vsd-2: system is required when concept/filter is present
    expect(canHandleValueSet({
      compose: { include: [{ concept: [{ code: '73211009' }] }] }
    })).toBe(false);
    expect(canHandleValueSet({
      compose: { include: [{ filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }] }
    })).toBe(false);

    // vsd-3: version cannot appear without system
    expect(canHandleValueSet({
      compose: { include: [{ version: '2025-01', valueSet: ['http://example.org/vs/a'] }] }
    })).toBe(false);

    // Empty component is invalid in strict mode
    expect(canHandleValueSet({ compose: { include: [{}] } })).toBe(false);
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

describe('expandViaIR debug plan text', () => {
  test('includes request-time text filter in runtime constraints', async () => {
    const mockProvider = {
      version: () => null,
      executeIR: async () => ({ candidates: [], unclosed: null }),
      countForIR: async () => 0,
    };
    const findProviderMock = async (system) => (
      system === 'http://snomed.info/sct' ? mockProvider : null
    );
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:whole-system-with-text',
      compose: { include: [{ system: 'http://snomed.info/sct' }] },
    };

    const result = await expandViaIR(vs, {
      findProvider: findProviderMock,
      text: 'diabetes',
      offset: 0,
      count: 2000,
      debugPlan: true,
    });

    expect(result).toBeTruthy();
    expect(result.debug?.planText).toContain('runtime-constraints:');
    expect(result.debug?.planText).toContain('text-filter: "diabetes"');
    expect(result.debug?.planText).toContain('pagination: offset=0 count=2000');
    expect(result.debug?.planText).toContain('selector whole http://snomed.info/sct');
  });
});

describe('expandViaIR compose override identity', () => {
  test('keys compose display/designation overrides by system+version+code, not system+code only', async () => {
    function makeProvider(version, baseDisplay) {
      return {
        version: () => version,
        executeIR: async () => ({
          candidates: [{ code: 'shared', display: baseDisplay, active: true }],
          unclosed: null,
        }),
        countForIR: async () => 1,
      };
    }

    const providersByVersion = new Map([
      ['v1', makeProvider('v1', 'Base v1')],
      ['v2', makeProvider('v2', 'Base v2')],
    ]);

    const result = await expandViaIR({
      resourceType: 'ValueSet',
      url: 'test:compose-override-version-key',
      status: 'active',
      compose: {
        include: [
          {
            system: 'http://example.org/cs',
            version: 'v1',
            concept: [{
              code: 'shared',
              display: 'Display v1',
              designation: [{ language: 'en', value: 'Designation v1' }],
            }],
          },
          {
            system: 'http://example.org/cs',
            version: 'v2',
            concept: [{
              code: 'shared',
              display: 'Display v2',
              designation: [{ language: 'en', value: 'Designation v2' }],
            }],
          },
        ],
      },
    }, {
      findProvider: async (system, version) => (
        system === 'http://example.org/cs' ? providersByVersion.get(version) || null : null
      ),
      includeDesignations: true,
      count: 10,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(2);
    expect(result.expansion.contains).toHaveLength(2);

    const byVersion = new Map(result.expansion.contains.map(item => [item.version, item]));
    expect(byVersion.get('v1')?.display).toBe('Display v1');
    expect(byVersion.get('v2')?.display).toBe('Display v2');
    expect(byVersion.get('v1')?.designation?.map(d => d.value)).toContain('Designation v1');
    expect(byVersion.get('v2')?.designation?.map(d => d.value)).toContain('Designation v2');
  });
});

describe('expandViaIR sideband metadata propagation', () => {
  test('preserves unclosed messages discovered during lazy countForIR', async () => {
    const provider = {
      _discoveredUnclosed: [],
      version: () => null,
      executeIR: async () => ({
        candidates: [{ code: 'A', display: 'Alpha', active: true }],
        unclosed: null,
      }),
      countForIR: async function countForIR() {
        this._discoveredUnclosed.push('grammar shell from count');
        return 1;
      },
    };

    const result = await expandViaIR({
      resourceType: 'ValueSet',
      url: 'test:lazy-count-unclosed',
      status: 'active',
      compose: {
        include: [{ system: 'http://example.org/cs', concept: [{ code: 'A' }] }],
      },
    }, {
      findProvider: async (system) => (
        system === 'http://example.org/cs' ? provider : null
      ),
      count: 1,
      exactTotal: true,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.total).toBeUndefined();
    expect(result.expansion.unclosedMessages).toContain('grammar shell from count');
  });
});

describe('expandViaIR semantic guards', () => {
  function codesFromIR(node) {
    if (!node) return new Set();
    switch (node.kind) {
      case 'empty':
        return new Set();
      case 'selector':
        return new Set((node.conceptCodes || []).map(c => String(c.code || '')).filter(Boolean));
      case 'import':
        return node.resolved ? codesFromIR(node.resolved) : new Set();
      case 'union': {
        const out = new Set();
        for (const child of node.items || []) {
          for (const code of codesFromIR(child)) out.add(code);
        }
        return out;
      }
      case 'intersect': {
        const items = node.items || [];
        if (items.length === 0) return new Set();
        const first = codesFromIR(items[0]);
        const out = new Set(first);
        for (const child of items.slice(1)) {
          const right = codesFromIR(child);
          for (const code of [...out]) if (!right.has(code)) out.delete(code);
        }
        return out;
      }
      case 'diff': {
        const left = codesFromIR(node.left);
        const right = codesFromIR(node.right);
        const out = new Set(left);
        for (const code of right) out.delete(code);
        return out;
      }
      default:
        return new Set();
    }
  }

  test('compose.inactive=false enforces active-only membership semantics', async () => {
    const mockProvider = {
      version: () => null,
      countForIR: async (_subtree, opts = {}) => (opts.activeOnly ? 1 : 2),
      executeIR: async (_subtree, opts = {}) => {
        const all = [
          { code: 'A1', display: 'Active One', active: true },
          { code: 'I1', display: 'Inactive One', active: false },
        ];
        return { candidates: opts.activeOnly ? all.filter(c => c.active) : all, unclosed: null };
      },
    };
    const findProviderMock = async (system) => (
      system === 'http://example.org/cs' ? mockProvider : null
    );
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:compose-inactive-false',
      compose: {
        inactive: false,
        include: [{ system: 'http://example.org/cs' }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider: findProviderMock,
      activeOnly: false,
      count: 10,
      debugPlan: true,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(1);
    expect(result.expansion.contains.map(c => c.code)).toEqual(['A1']);
    expect(result.debug?.planText).toContain('active-only: true');
  });

  test('compose.inactive=true does not force active-only membership semantics', async () => {
    const mockProvider = {
      version: () => null,
      countForIR: async (_subtree, opts = {}) => (opts.activeOnly ? 1 : 2),
      executeIR: async (_subtree, opts = {}) => {
        const all = [
          { code: 'A1', display: 'Active One', active: true },
          { code: 'I1', display: 'Inactive One', active: false },
        ];
        return { candidates: opts.activeOnly ? all.filter(c => c.active) : all, unclosed: null };
      },
    };
    const findProviderMock = async (system) => (
      system === 'http://example.org/cs' ? mockProvider : null
    );
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:compose-inactive-true',
      compose: {
        inactive: true,
        include: [{ system: 'http://example.org/cs' }],
      },
    };

    const resultNoReqFilter = await expandViaIR(vs, {
      findProvider: findProviderMock,
      activeOnly: false,
      count: 10,
      debugPlan: true,
    });

    expect(resultNoReqFilter).toBeTruthy();
    expect(resultNoReqFilter.expansion.total).toBe(2);
    expect(resultNoReqFilter.expansion.contains.map(c => c.code).sort()).toEqual(['A1', 'I1']);
    expect(resultNoReqFilter.debug?.planText).not.toContain('active-only: true');

    const resultReqFilter = await expandViaIR(vs, {
      findProvider: findProviderMock,
      activeOnly: true,
      count: 10,
      debugPlan: true,
    });
    expect(resultReqFilter).toBeTruthy();
    expect(resultReqFilter.expansion.total).toBe(1);
    expect(resultReqFilter.expansion.contains.map(c => c.code)).toEqual(['A1']);
    expect(resultReqFilter.debug?.planText).toContain('active-only: true');
  });

  test('single-system execution uses provider total when executeIR returns one', async () => {
    const mockProvider = {
      version: () => null,
      countForIR: async () => {
        throw new Error('countForIR should not be called when executeIR returns total');
      },
      executeIR: async () => ({
        candidates: Array.from({ length: 10 }, (_, i) => ({
          code: `A${i}`,
          display: `Alpha ${i}`,
          active: true,
        })),
        total: 123,
        unclosed: null,
      }),
    };
    const findProviderMock = async (system) => (
      system === 'http://example.org/cs' ? mockProvider : null
    );
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:provider-total',
      compose: {
        include: [{ system: 'http://example.org/cs' }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider: findProviderMock,
      count: 10,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(123);
    expect(result.expansion.contains).toHaveLength(10);
  });

  test('lockedDate ValueSet is handled by IR when called directly', async () => {
    const mockProvider = {
      version: () => null,
      countForIR: async () => 1,
      executeIR: async () => ({ candidates: [{ code: 'X', display: 'X' }], unclosed: null }),
    };
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:locked-date-direct',
      compose: {
        lockedDate: '2021-01-01',
        include: [{ system: 'http://example.org/cs' }],
      },
    };
    const result = await expandViaIR(vs, {
      findProvider: async () => mockProvider,
      count: 10,
    });
    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(1);
    expect(result.expansion.contains.map(c => c.code)).toEqual(['X']);
  });

  test('lockedDate resolver binds concrete version before provider dispatch', async () => {
    const providerCalls = [];
    const mockProvider = {
      version: () => 'A.v1',
      countForIR: async (subtree) => codesFromIR(subtree).size || 1,
      executeIR: async (subtree) => {
        const codes = [...codesFromIR(subtree)];
        return {
          candidates: (codes.length > 0 ? codes : ['X']).map(code => ({ code, display: code, active: true })),
          unclosed: null,
        };
      },
    };
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:locked-date-bind',
      compose: {
        lockedDate: '2021-01-01',
        include: [{ system: 'http://example.org/cs', concept: [{ code: 'A' }] }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider: async (system, version) => {
        providerCalls.push({ system, version });
        return mockProvider;
      },
      resolveVersionAtDate: async (system, lockedDate) => {
        expect(system).toBe('http://example.org/cs');
        expect(lockedDate).toBe('2021-01-01');
        return 'A.v1';
      },
      count: 10,
      debugPlan: true,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(1);
    expect(providerCalls.some(c => c.system === 'http://example.org/cs' && c.version === 'A.v1')).toBe(true);
    expect(result.debug?.planText).toContain('selector concept http://example.org/cs|A.v1');
  });

  test('nested imports can resolve different versions from different lockedDate scopes', async () => {
    const providerCalls = [];
    const childUrl = 'http://example.org/vs/child';
    const root = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/root',
      compose: {
        lockedDate: '2021-01-01',
        include: [
          { system: 'http://example.org/cs', concept: [{ code: 'A' }] },
          { valueSet: [childUrl] },
        ],
      },
    };
    const child = {
      resourceType: 'ValueSet',
      url: childUrl,
      compose: {
        lockedDate: '2023-01-01',
        include: [
          { system: 'http://example.org/cs', concept: [{ code: 'B' }] },
        ],
      },
    };

    const findProvider = async (system, version) => {
      providerCalls.push({ system, version });
      return {
        version: () => version,
        countForIR: async (subtree) => codesFromIR(subtree).size || 1,
        executeIR: async (subtree) => {
          const codes = [...codesFromIR(subtree)];
          return {
            candidates: codes.map(code => ({ code, display: code, active: true })),
            unclosed: null,
          };
        },
      };
    };

    const result = await expandViaIR(root, {
      findProvider,
      resolveValueSet: async (url) => (url === childUrl ? child : null),
      resolveVersionAtDate: async (_system, lockedDate) => (
        lockedDate === '2021-01-01' ? 'A.v1' : (lockedDate === '2023-01-01' ? 'A.v2' : null)
      ),
      count: 10,
    });

    expect(result).toBeTruthy();
    const uniqueVersions = new Set(providerCalls.map(c => c.version));
    expect(uniqueVersions.has('A.v1')).toBe(true);
    expect(uniqueVersions.has('A.v2')).toBe(true);
    const codes = result.expansion.contains.map(c => c.code).sort();
    expect(codes).toEqual(['A', 'B']);
  });

  test('version "*" is handled as unversioned selector semantics', async () => {
    const mockProvider = {
      version: () => null,
      countForIR: async () => 1,
      executeIR: async () => ({ candidates: [{ code: 'W1', display: 'Wildcard' }], unclosed: null }),
    };
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:version-star-direct',
      compose: {
        include: [{ system: 'http://example.org/cs', version: '*' }],
      },
    };
    const result = await expandViaIR(vs, {
      findProvider: async (system, version) => {
        expect(system).toBe('http://example.org/cs');
        expect(version == null || version === '').toBe(true);
        return mockProvider;
      },
      count: 10,
    });
    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(1);
    expect(result.expansion.contains[0].code).toBe('W1');
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

  test('deep later single-system pages can omit total when exactTotal is disabled', async () => {
    let countCalls = 0;
    const mockProvider = {
      version: () => null,
      countForIR: async () => {
        countCalls += 1;
        return 100;
      },
      executeIR: async (_subtree, opts = {}) => {
        const out = [];
        const start = opts.offset || 0;
        for (let i = 0; i < (opts.count || 0); i++) {
          out.push({ code: `C${start + i}`, display: `Code ${start + i}`, active: true });
        }
        return { candidates: out, unclosed: null };
      },
    };
    const findProviderMock = async (system) => (
      system === 'http://example.org/cs' ? mockProvider : null
    );
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:later-page-best-effort-total',
      compose: { include: [{ system: 'http://example.org/cs' }] },
    };

    const result = await expandViaIR(vs, {
      findProvider: findProviderMock,
      offset: 100,
      count: 5,
      exactTotal: false,
    });

    expect(result.expansion.contains.length).toBe(5);
    expect(result.expansion.total).toBeNull();
    expect(countCalls).toBe(0);
  });

  test('later single-system pages still compute exact total by default', async () => {
    let countCalls = 0;
    const mockProvider = {
      version: () => null,
      countForIR: async () => {
        countCalls += 1;
        return 100;
      },
      executeIR: async (_subtree, opts = {}) => {
        const out = [];
        const start = opts.offset || 0;
        for (let i = 0; i < (opts.count || 0); i++) {
          out.push({ code: `C${start + i}`, display: `Code ${start + i}`, active: true });
        }
        return { candidates: out, unclosed: null };
      },
    };
    const findProviderMock = async (system) => (
      system === 'http://example.org/cs' ? mockProvider : null
    );
    const vs = {
      resourceType: 'ValueSet',
      url: 'test:later-page-exact-total-default',
      compose: { include: [{ system: 'http://example.org/cs' }] },
    };

    const result = await expandViaIR(vs, {
      findProvider: findProviderMock,
      offset: 10,
      count: 5,
    });

    expect(result.expansion.contains.length).toBe(5);
    expect(result.expansion.total).toBe(100);
    expect(countCalls).toBe(1);
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

    // Should have concept-valued properties (valueCode; system is implicit)
    const isaProps = entry.property.filter(p => p.code === '116680003');
    expect(isaProps.length).toBeGreaterThan(0);
    for (const p of isaProps) {
      expect(p.valueCode).toBeTruthy();
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
