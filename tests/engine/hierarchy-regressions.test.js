'use strict';

const IR = require('../../tx/engine/ir');
const { wrapWithLegacyIR } = require('../../tx/engine/legacy-ir-adapter');
const { expandViaIR } = require('../../tx/engine/orchestrator');

function flattenCandidates(candidates) {
  const out = [];
  const walk = (items) => {
    for (const c of items || []) {
      out.push(c.code);
      if (c._children) walk(c._children);
    }
  };
  walk(candidates);
  return out;
}

function flattenContainsCodes(contains) {
  const out = [];
  const walk = (items) => {
    for (const c of items || []) {
      out.push(`${c.system}|${c.code}`);
      if (c.contains) walk(c.contains);
    }
  };
  walk(contains || []);
  return out;
}

function makeHierProvider(systemUrl, roots, childrenByCode) {
  const parentByCode = {};
  for (const [parent, kids] of Object.entries(childrenByCode || {})) {
    for (const kid of kids || []) parentByCode[kid] = parent;
  }
  return {
    system() { return systemUrl; },
    version() { return '1'; },
    status() { return {}; },
    contentMode() { return 'complete'; },
    hasParents() { return true; },
    async locate(code) {
      const allCodes = new Set([...(roots || []), ...Object.keys(childrenByCode || {}), ...Object.values(childrenByCode || {}).flat()]);
      if (!allCodes.has(code)) return { context: null };
      return { context: { code, parent: parentByCode[code] || null } };
    },
    async parent(ctx) { return ctx.parent || null; },
    async iterator(parentCtx) {
      const codes = parentCtx ? (childrenByCode[parentCtx.code] || []) : roots;
      return { codes, index: 0, parent: parentCtx ? parentCtx.code : null };
    },
    async nextContext(iter) {
      if (iter.index >= iter.codes.length) return null;
      const code = iter.codes[iter.index++];
      return { code, parent: iter.parent };
    },
    async code(ctx) { return ctx.code; },
    async display(ctx) { return ctx.code; },
    async isInactive() { return false; },
    async definition(ctx) { return `def-${ctx.code}`; },
    async iteratorAll() { return null; },
  };
}

function makeFlatProvider(systemUrl, codes) {
  return {
    system() { return systemUrl; },
    version() { return '1'; },
    status() { return {}; },
    contentMode() { return 'complete'; },
    hasParents() { return false; },
    async iteratorAll() {
      return { codes, index: 0 };
    },
    async nextContext(iter) {
      if (iter.index >= iter.codes.length) return null;
      const code = iter.codes[iter.index++];
      return { code };
    },
    async code(ctx) { return ctx.code; },
    async display(ctx) { return ctx.code; },
    async isInactive() { return false; },
    async definition(ctx) { return `def-${ctx.code}`; },
  };
}

function makeConceptProvider(systemUrl, conceptMetaByCode) {
  return {
    system() { return systemUrl; },
    version() { return '1'; },
    status() { return {}; },
    contentMode() { return 'complete'; },
    hasParents() { return false; },
    async locate(code) {
      if (!conceptMetaByCode[code]) return { context: null };
      return { context: { code } };
    },
    async code(ctx) { return ctx.code; },
    async display(ctx) { return conceptMetaByCode[ctx.code].display || ctx.code; },
    async isInactive(ctx) { return !!conceptMetaByCode[ctx.code].inactive; },
    async definition(ctx) { return conceptMetaByCode[ctx.code].definition || `def-${ctx.code}`; },
  };
}

function makeFilterProvider(systemUrl, codes) {
  const byCode = new Map();
  for (const row of codes) byCode.set(row.code, { ...row });
  return {
    system() { return systemUrl; },
    version() { return '1'; },
    status() { return {}; },
    contentMode() { return 'complete'; },
    hasParents() { return false; },
    async locate(code) {
      const c = byCode.get(code);
      return c ? { context: c } : { context: null };
    },
    async code(ctx) { return ctx.code; },
    async display(ctx) { return ctx.display || ctx.code; },
    async isInactive(ctx) { return !!ctx.inactive; },
    async definition(ctx) { return ctx.definition || `def-${ctx.code}`; },
    async getPrepContext() {
      return { clauses: [] };
    },
    async filter(prep, property, op, value) {
      prep.clauses.push({ property, op, value });
    },
    async executeFilters(prep) {
      const sets = [];
      for (const clause of prep.clauses || []) {
        if (clause.property === 'code' && clause.op === 'regex') {
          let re = null;
          try { re = new RegExp(String(clause.value || '')); } catch { re = null; }
          const matched = [...byCode.values()]
            .filter(c => re && re.test(c.code))
            .map(c => c.code)
            .sort();
          sets.push({ codes: matched, index: 0, codeSet: new Set(matched) });
        }
      }
      return sets;
    },
    async filterMore(prep, set) {
      return set.index < set.codes.length;
    },
    async filterConcept(prep, set) {
      const code = set.codes[set.index++];
      return byCode.get(code) || null;
    },
    async filterCheck(prep, set, ctx) {
      return set.codeSet.has(ctx.code);
    },
  };
}

describe('Hierarchy regressions', () => {
  test('legacy adapter pagination windows operate on flattened hierarchy order', async () => {
    const provider = makeHierProvider(
      'http://example.org/hier',
      ['A', 'B', 'C'],
      {
        A: ['A1', 'A2'],
        A1: [],
        A2: [],
        B: ['B1'],
        B1: [],
        C: [],
      }
    );
    const wrapped = wrapWithLegacyIR(provider);
    const subtree = IR.selector({ system: provider.system(), shape: 'whole' });

    const total = await wrapped.countForIR(subtree, {});
    expect(total).toBe(6);

    const page = await wrapped.executeIR(subtree, { offset: 1, count: 3 });
    expect(flattenCandidates(page.candidates)).toEqual(['A1', 'A2', 'B']);
  });

  test('hierarchy nesting uses system+code identity (no cross-system collisions)', async () => {
    const SYS_A = 'http://a.example.org/hier';
    const SYS_B = 'http://z.example.org/flat';

    const bySystem = {
      [SYS_A]: makeHierProvider(SYS_A, ['active'], { active: ['alpha'], alpha: [] }),
      [SYS_B]: makeFlatProvider(SYS_B, ['active']),
    };

    const vs = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/hier-collision',
      compose: {
        include: [{ system: SYS_A }, { system: SYS_B }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider: async (system) => bySystem[system] || null,
      count: 100,
      offset: 0,
      excludeNested: false,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(3);

    const roots = result.expansion.contains || [];
    const aActive = roots.find(c => c.system === SYS_A && c.code === 'active');
    const bActive = roots.find(c => c.system === SYS_B && c.code === 'active');
    expect(aActive).toBeTruthy();
    expect(bActive).toBeTruthy();

    const aChildren = (aActive.contains || []).map(c => `${c.system}|${c.code}`);
    expect(aChildren).toEqual([`${SYS_A}|alpha`]);
    expect(bActive.contains).toBeUndefined();

    const allCodes = flattenContainsCodes(result.expansion.contains);
    expect(new Set(allCodes).size).toBe(3);
  });

  test('set operations on hierarchical whole-system do not drop descendants of excluded parents', async () => {
    const provider = makeHierProvider(
      'http://example.org/hier-diff',
      ['A', 'B'],
      {
        A: ['A1', 'A2'],
        A1: [],
        A2: [],
        B: [],
      }
    );
    const wrapped = wrapWithLegacyIR(provider);
    const subtree = IR.diff(
      IR.selector({ system: provider.system(), shape: 'whole' }),
      IR.selector({ system: provider.system(), shape: 'concept', conceptCodes: [{ code: 'A' }] }),
    );

    const count = await wrapped.countForIR(subtree, {});
    expect(count).toBe(3);

    const result = await wrapped.executeIR(subtree, { offset: 0, count: 10 });
    expect(flattenCandidates(result.candidates)).toEqual(['A1', 'A2', 'B']);
  });

  test('text filtering over hierarchy includes matching descendants (not roots only)', async () => {
    const provider = makeHierProvider(
      'http://example.org/hier-text',
      ['ROOT'],
      {
        ROOT: ['LAB_CHILD', 'DIAG_CHILD'],
        LAB_CHILD: [],
        DIAG_CHILD: [],
      }
    );
    const wrapped = wrapWithLegacyIR(provider);
    const subtree = IR.selector({ system: provider.system(), shape: 'whole' });

    const count = await wrapped.countForIR(subtree, { text: 'lab' });
    expect(count).toBe(1);

    const result = await wrapped.executeIR(subtree, { text: 'lab', offset: 0, count: 10 });
    expect(flattenCandidates(result.candidates)).toEqual(['LAB_CHILD']);
  });

  test('total-only with activeOnly does not use static concept count fast-path', async () => {
    const system = 'http://example.org/concepts-active';
    const provider = makeConceptProvider(system, {
      ACTIVE: { inactive: false, display: 'Active concept' },
      INACTIVE: { inactive: true, display: 'Inactive concept' },
    });
    const bySystem = { [system]: provider };
    const vs = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/active-only-total',
      compose: {
        include: [{
          system,
          concept: [{ code: 'ACTIVE' }, { code: 'INACTIVE' }],
        }],
      },
    };

    const result = await expandViaIR(vs, {
      findProvider: async (s) => bySystem[s] || null,
      activeOnly: true,
      count: 0,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(1);
    expect(result.expansion.contains || []).toEqual([]);
  });

  test('filter selector enforces intersectCodes constraint in legacy adapter', async () => {
    const provider = makeFilterProvider('http://example.org/intersect-codes', [
      { code: 'A-100', display: 'Alpha 100', inactive: false },
      { code: 'A-110', display: 'Alpha 110', inactive: false },
      { code: 'A-120', display: 'Alpha 120', inactive: false },
      { code: 'A-130', display: 'Alpha 130', inactive: false },
    ]);
    const wrapped = wrapWithLegacyIR(provider);
    const subtree = IR.selector({
      system: provider.system(),
      shape: 'filter',
      filterClauses: [{ property: 'code', op: 'regex', value: '^A-..0$' }],
      intersectCodes: ['A-100', 'A-120'],
    });

    const result = await wrapped.executeIR(subtree, {});
    const codes = flattenCandidates(result.candidates);
    expect(codes).toEqual(['A-100', 'A-120']);

    const membership = await wrapped.membershipForIR(subtree);
    expect(membership.has('A-100')).toBe(true);
    expect(membership.has('A-120')).toBe(true);
    expect(membership.has('A-130')).toBe(false);
  });
});
