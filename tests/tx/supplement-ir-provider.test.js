const IR = require('../../tx/engine/ir');
const { CodeSystem } = require('../../tx/library/codesystem');
const { wrapIRProviderWithSupplements } = require('../../tx/supplements/ir-provider');
const { buildDiceSupplementBundle } = require('../../tx/supplements/synthetic');

function makeSupplement(concepts) {
  return new CodeSystem({
    resourceType: 'CodeSystem',
    url: 'http://example.org/supp',
    version: '1.0',
    status: 'active',
    content: 'supplement',
    supplements: 'http://example.org/base',
    concept: concepts,
  });
}

function makeProvider(dataset) {
  const byCode = new Map(dataset.map(item => [item.code, item]));

  function applyBaseFilter(item, clause) {
    const values = (item.baseProperties || [])
      .filter(prop => prop.code === clause.property)
      .map(prop => String(prop.value));
    switch (clause.op) {
      case '=':
        return values.includes(String(clause.value));
      case 'in':
        return String(clause.value).split(',').map(v => v.trim()).filter(Boolean)
          .some(value => values.includes(value));
      case 'exists': {
        const expectExists = !/^(false|0)$/i.test(String(clause.value ?? 'true'));
        return expectExists ? values.length > 0 : values.length === 0;
      }
      default:
        throw new Error(`unsupported base test filter ${clause.op}`);
    }
  }

  async function executeIR(node, opts = {}) {
    let candidates;
    switch (node.kind) {
      case 'empty':
        candidates = [];
        break;
      case 'selector':
        if (node.shape === 'whole') {
          candidates = dataset.map(item => ({ code: item.code, display: item.display, active: true }));
        } else if (node.shape === 'concept') {
          const wanted = new Set((node.conceptCodes || []).map(cc => cc.code));
          candidates = dataset
            .filter(item => wanted.has(item.code))
            .map(item => ({ code: item.code, display: item.display, active: true }));
        } else if (node.shape === 'filter') {
          const intersectCodes = Array.isArray(node.intersectCodes) ? new Set(node.intersectCodes) : null;
          candidates = dataset
            .filter(item => !intersectCodes || intersectCodes.has(item.code))
            .filter(item => (node.filterClauses || []).every(clause => applyBaseFilter(item, clause)))
            .map(item => ({ code: item.code, display: item.display, active: true }));
        } else {
          candidates = [];
        }
        break;
      default:
        throw new Error(`unsupported test node kind ${node.kind}`);
    }

    candidates.sort((a, b) => a.code.localeCompare(b.code));
    const off = opts.offset || 0;
    const lim = opts.count != null ? opts.count : candidates.length;
    return { candidates: candidates.slice(off, off + lim) };
  }

  async function membershipForIR(node) {
    const result = await executeIR(node, {});
    const codes = new Set((result.candidates || []).map(candidate => candidate.code));
    return { has: code => codes.has(code) };
  }

  return {
    system() { return 'http://example.org/base'; },
    version() { return '1'; },
    async properties(code) {
      return [...(byCode.get(code)?.baseProperties || [])];
    },
    executeIR,
    membershipForIR,
    countForIR: async (node) => {
      const result = await executeIR(node, {});
      return (result.candidates || []).length;
    },
  };
}

describe('supplement-aware IR provider', () => {
  test('matches supplement-backed property filters against merged base and supplement values', async () => {
    const provider = makeProvider([
      { code: 'A', display: 'Alpha', baseProperties: [] },
      { code: 'B', display: 'Bravo', baseProperties: [{ code: 'rank', value: 1 }] },
      { code: 'C', display: 'Charlie', baseProperties: [] },
    ]);
    const supplement = makeSupplement([
      { code: 'A', property: [{ code: 'rank', valueInteger: 1 }] },
    ]);
    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [{ overlaySource: supplement }],
    });

    const subtree = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [{ property: 'rank', op: '=', value: '1' }],
    });

    const result = await wrapped.executeIR(subtree, {});
    expect(result.candidates.map(candidate => candidate.code)).toEqual(['A', 'B']);
  });

  test('uses unaffected base clauses as support while applying supplement clauses post-filter', async () => {
    const provider = makeProvider([
      { code: 'A', display: 'Alpha', baseProperties: [{ code: 'class', value: 'chem' }] },
      { code: 'B', display: 'Bravo', baseProperties: [{ code: 'class', value: 'chem' }] },
      { code: 'C', display: 'Charlie', baseProperties: [{ code: 'class', value: 'other' }] },
    ]);
    const supplement = makeSupplement([
      { code: 'B', property: [{ code: 'rank', valueInteger: 1 }] },
      { code: 'C', property: [{ code: 'rank', valueInteger: 1 }] },
    ]);
    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [{ overlaySource: supplement }],
    });

    const subtree = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [
        { property: 'class', op: '=', value: 'chem' },
        { property: 'rank', op: '=', value: '1' },
      ],
    });

    const result = await wrapped.executeIR(subtree, {});
    expect(result.candidates.map(candidate => candidate.code)).toEqual(['B']);
  });

  test('text filter matches supplement designations', async () => {
    const provider = makeProvider([
      { code: 'A', display: 'Alpha', baseProperties: [] },
      { code: 'B', display: 'Bravo', baseProperties: [] },
    ]);
    const supplement = makeSupplement([
      { code: 'A', designation: [{ language: 'fr', value: 'Pomme' }] },
    ]);
    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [{ overlaySource: supplement }],
    });

    const subtree = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'whole',
    });

    const result = await wrapped.executeIR(subtree, { text: 'pomme' });
    expect(result.candidates.map(candidate => candidate.code)).toEqual(['A']);
  });

  test('multiple supplements contribute distinct and shared properties additively', async () => {
    const dataset = Array.from({ length: 24 }, (_, index) => ({
      code: `C${String(index + 1).padStart(2, '0')}`,
      display: `Code ${index + 1}`,
      baseProperties: [],
    }));
    const provider = makeProvider(dataset);
    const base = {
      system: provider.system(),
      version: provider.version(),
      name: 'Synthetic Base',
      codes: dataset.map(item => ({ code: item.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20', 'd8'],
      urlRoot: 'http://example.org/fhir/CodeSystem/test-dice',
      version: '1',
      salt: 'multi',
    });
    const d20 = new CodeSystem(bundle.find(item => item.die === 'd20').resource);
    const d8 = new CodeSystem(bundle.find(item => item.die === 'd8').resource);
    const d20ByCode = new Map(d20.jsonObj.concept.map(concept => [concept.code, concept]));
    const d8ByCode = new Map(d8.jsonObj.concept.map(concept => [concept.code, concept]));

    const target = dataset.find(item => {
      const d20Damage = d20ByCode.get(item.code).property.find(prop => prop.code === 'damage-type')?.valueCode;
      const d8Damage = d8ByCode.get(item.code).property.find(prop => prop.code === 'damage-type')?.valueCode;
      return d20Damage && d8Damage && d20Damage !== d8Damage;
    });
    expect(target).toBeTruthy();

    const d20Roll = String(
      d20ByCode.get(target.code).property.find(prop => prop.code === 'd20-roll').valueInteger
    );
    const d8Damage = d8ByCode.get(target.code).property.find(prop => prop.code === 'damage-type').valueCode;

    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [
        { overlaySource: d20 },
        { overlaySource: d8 },
      ],
    });

    const subtree = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [
        { property: 'd20-roll', op: '=', value: d20Roll },
        { property: 'damage-type', op: '=', value: d8Damage },
      ],
    });

    const result = await wrapped.executeIR(subtree, {});
    expect(result.candidates.map(candidate => candidate.code)).toContain(target.code);
  });

  test('composes union, diff, count, and paging through the shared generic executor', async () => {
    const provider = makeProvider([
      { code: 'A', display: 'Alpha', baseProperties: [] },
      { code: 'B', display: 'Bravo', baseProperties: [{ code: 'class', value: 'chem' }] },
      { code: 'C', display: 'Charlie', baseProperties: [] },
      { code: 'D', display: 'Delta', baseProperties: [] },
    ]);
    const supplement = makeSupplement([
      { code: 'A', property: [{ code: 'rank', valueInteger: 1 }] },
      { code: 'C', property: [{ code: 'rank', valueInteger: 1 }] },
      { code: 'D', property: [{ code: 'rank', valueInteger: 2 }] },
    ]);
    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [{ overlaySource: supplement }],
    });

    const ranked = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [{ property: 'rank', op: '=', value: '1' }],
    });
    const chem = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [{ property: 'class', op: '=', value: 'chem' }],
    });
    const subtractA = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'concept',
      conceptCodes: [{ code: 'A' }],
    });

    const subtree = IR.diff(IR.union([ranked, chem]), subtractA);

    expect(await wrapped.countForIR(subtree)).toBe(2);

    const paged = await wrapped.executeIR(subtree, { offset: 1, count: 1 });
    expect(paged.candidates.map(candidate => candidate.code)).toEqual(['C']);

    const membership = await wrapped.membershipForIR(subtree);
    expect(membership.has('A')).toBe(false);
    expect(membership.has('B')).toBe(true);
    expect(membership.has('C')).toBe(true);
  });

  test('flattens hierarchical support results before supplement-only filtering and paging', async () => {
    const provider = {
      system() { return 'http://example.org/base'; },
      version() { return '1'; },
      async properties(code) {
        return [];
      },
      async executeIR(node) {
        if (node.kind !== 'selector' || node.shape !== 'whole') return { candidates: [] };
        return {
          candidates: [
            {
              code: 'A',
              display: 'Alpha',
              active: true,
              _context: 'A',
              _children: [
                { code: 'B', display: 'Bravo', active: true, _context: 'B' },
                { code: 'C', display: 'Charlie', active: true, _context: 'C' },
              ],
            },
          ],
        };
      },
      async membershipForIR(node) {
        const result = await this.executeIR(node);
        const flat = [];
        const walk = (items) => {
          for (const item of items || []) {
            flat.push(item.code);
            if (item._children) walk(item._children);
          }
        };
        walk(result.candidates || []);
        const codes = new Set(flat);
        return { has: code => codes.has(code) };
      },
      countForIR: async () => 3,
    };
    const supplement = makeSupplement([
      { code: 'B', property: [{ code: 'rank', valueInteger: 1 }] },
      { code: 'C', property: [{ code: 'rank', valueInteger: 1 }] },
    ]);
    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [{ overlaySource: supplement }],
    });

    const subtree = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [{ property: 'rank', op: '=', value: '1' }],
    });

    expect(await wrapped.countForIR(subtree)).toBe(2);
    const paged = await wrapped.executeIR(subtree, { offset: 1, count: 1 });
    expect(paged.candidates.map(candidate => candidate.code)).toEqual(['C']);
  });

  test('fails closed for unsupported overlay-backed property operators', async () => {
    const provider = makeProvider([
      { code: 'A', display: 'Alpha', baseProperties: [] },
    ]);
    const supplement = makeSupplement([
      { code: 'A', property: [{ code: 'parent', valueCode: 'root' }] },
    ]);
    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [{ overlaySource: supplement }],
    });

    const subtree = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [{ property: 'parent', op: 'is-a', value: 'root' }],
    });

    await expect(wrapped.executeIR(subtree, {})).rejects.toThrow(
      "Supplement filter op 'is-a' is not supported for property 'parent'"
    );
  });

  test('forwards allowIncompleteExpansion on the three base-provider delegation paths', async () => {
    const calls = [];
    const provider = {
      system() { return 'http://example.org/base'; },
      version() { return '1'; },
      async properties() { return []; },
      async executeIR(node, opts = {}) {
        calls.push({ node, opts });
        return {
          candidates: [{ code: 'A', display: 'Alpha', active: true }],
          limitedExpansion: !!opts.allowIncompleteExpansion,
          unclosed: opts.allowIncompleteExpansion ? 'grammar shell' : null,
        };
      },
      async membershipForIR(node) {
        const result = await this.executeIR(node, {});
        const codes = new Set((result.candidates || []).map(candidate => candidate.code));
        return { has: code => codes.has(code) };
      },
      async countForIR() { return 1; },
    };
    const supplement = makeSupplement([
      { code: 'A', property: [{ code: 'rank', valueInteger: 1 }] },
    ]);
    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [{ overlaySource: supplement }],
    });

    await wrapped.executeIR(IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'whole',
    }), { allowIncompleteExpansion: true });

    await wrapped.executeIR(IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [{ property: 'class', op: '=', value: 'chem' }],
    }), { allowIncompleteExpansion: true });

    await wrapped.executeIR(IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [
        { property: 'class', op: '=', value: 'chem' },
        { property: 'rank', op: '=', value: '1' },
      ],
    }), { allowIncompleteExpansion: true });

    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.opts.allowIncompleteExpansion === true)).toBe(true);
  });

  test('keeps text and paging top-level instead of forwarding them to leaf provider execution', async () => {
    const calls = [];
    const provider = {
      system() { return 'http://example.org/base'; },
      version() { return '1'; },
      async properties() { return []; },
      async executeIR(node, opts = {}) {
        calls.push({ node, opts });
        return {
          candidates: [
            { code: 'A', display: 'Alpha', active: true },
            { code: 'B', display: 'Bravo', active: true },
          ],
        };
      },
      async membershipForIR() {
        return { has: () => true };
      },
      async countForIR() { return 2; },
    };
    const supplement = makeSupplement([
      { code: 'A', property: [{ code: 'rank', valueInteger: 1 }] },
    ]);
    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [{ overlaySource: supplement }],
    });

    await wrapped.executeIR(IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'whole',
    }), {
      text: 'alp',
      offset: 1,
      count: 1,
      activeOnly: true,
      allowIncompleteExpansion: true,
    });

    await wrapped.executeIR(IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [{ property: 'rank', op: '=', value: '1' }],
    }), {
      text: 'alp',
      offset: 1,
      count: 1,
      activeOnly: true,
      allowIncompleteExpansion: true,
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.opts.activeOnly).toBe(true);
      expect(call.opts.allowIncompleteExpansion).toBe(true);
      expect(call.opts.text).toBeUndefined();
      expect(call.opts.offset).toBeUndefined();
      expect(call.opts.count).toBeUndefined();
    }
  });
});
