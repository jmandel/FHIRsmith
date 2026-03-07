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
      items: [{ overlaySource: { codeSystem: supplement } }],
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
      items: [{ overlaySource: { codeSystem: supplement } }],
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
      items: [{ overlaySource: { codeSystem: supplement } }],
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
        { overlaySource: { codeSystem: d20 } },
        { overlaySource: { codeSystem: d8 } },
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
});
