'use strict';

const IR = require('../../tx/engine/ir');
const { interpretScopedIR } = require('../../tx/engine/scoped-ir-interpreter');
const { buildHierarchyDescriptors } = require('../../tx/cs/sqlite-v0-hierarchy');
const { buildMembershipPlan, buildSelectionPlan } = require('../../tx/cs/sqlite-v0-plan-builder');
const { membershipPlanStructuralForm } = require('../../tx/cs/sqlite-v0-plan-normalize');
const { interpretMembershipPlan, conceptIdsToCodes } = require('../../tx/cs/sqlite-v0-plan-interpret');

function makeFixture() {
  return {
    concepts: [
      { concept_id: 1, code: 'A-100', display: 'Alpha Root', active: 1 },
      { concept_id: 2, code: 'A-110', display: 'Alpha Lab', active: 1 },
      { concept_id: 3, code: 'A-120', display: 'Alpha Diag', active: 1 },
      { concept_id: 4, code: 'A-130', display: 'Alpha Doc', active: 1 },
      { concept_id: 5, code: 'A-140', display: 'Dormant Alpha', active: 0 },
    ],
    closure: [
      { ancestor_id: 1, descendant_id: 1 },
      { ancestor_id: 1, descendant_id: 2 },
      { ancestor_id: 1, descendant_id: 3 },
      { ancestor_id: 1, descendant_id: 4 },
      { ancestor_id: 2, descendant_id: 2 },
      { ancestor_id: 2, descendant_id: 4 },
      { ancestor_id: 3, descendant_id: 3 },
      { ancestor_id: 4, descendant_id: 4 },
    ],
    literals: [
      { source_concept_id: 2, property: 'CLASS', value_text: 'CHEM', active: 1 },
      { source_concept_id: 3, property: 'CLASS', value_text: 'DIAG', active: 1 },
      { source_concept_id: 4, property: 'CLASS', value_text: 'CHEM', active: 1 },
      { source_concept_id: 4, property: 'SCALE', value_text: 'Doc', active: 1 },
      { source_concept_id: 5, property: 'NOTE', value_text: 'Dormant marker', active: 1 },
    ],
    designations: [
      { concept_id: 3, value_text: 'Sugar disease', active: 1 },
      { concept_id: 5, value_text: 'Dormant designation', active: 1 },
    ],
    links: [
      { source_concept_id: 2, property: 'CATEGORY', target_concept_id: 1, active: 1 },
      { source_concept_id: 4, property: 'CATEGORY', target_concept_id: 1, active: 1 },
      { source_concept_id: 3, property: 'CATEGORY', target_concept_id: 3, active: 1 },
    ],
    relations: {
      'property:PART_OF': [
        { ancestor_id: 1, descendant_id: 1 },
        { ancestor_id: 1, descendant_id: 4 },
        { ancestor_id: 4, descendant_id: 4 },
      ],
    },
    valueSetMembers: {
      'http://example.org/refset/labish': [2, 4],
    },
  };
}

function makeRuntime() {
  return {
    filters: {
      concept: {
        implicitValueSets: {
          'http://example.org/refset/': true,
        },
      },
      properties: {
        defaultSources: ['literal'],
        byCode: {
          CLASS: {
            sources: ['literal'],
            value: {
              aliases: { chemistry: 'CHEM' },
            },
          },
          CATEGORY: {
            sources: ['link'],
            linkMatch: 'code-or-display',
          },
          SCALE: {
            sources: ['literal'],
          },
          PART_OF: {
            sources: ['link'],
          },
        },
      },
    },
  };
}

function makePropertyDefs() {
  return new Map([
    ['CLASS', { property_id: 1, value_kind: 'literal' }],
    ['CATEGORY', { property_id: 2, value_kind: 'concept' }],
    ['SCALE', { property_id: 3, value_kind: 'literal' }],
    ['PART_OF', { property_id: 4, value_kind: 'concept', is_hierarchy: true }],
  ]);
}

function sorted(values) {
  return [...values].sort();
}

function applySelectionFiltersDirect(codes, fixture, runtime, opts = {}) {
  const concepts = new Map((fixture.concepts || []).map(row => [row.code, row]));
  const text = opts.text != null ? String(opts.text).toLowerCase() : '';
  const searchCfg = runtime?.search || {
    sources: ['display', 'designation'],
    activeOnly: true,
    designationActiveOnly: true,
    literalActiveOnly: true,
  };

  let out = new Set(codes);
  if (opts.activeOnly) {
    out = new Set([...out].filter(code => {
      const row = concepts.get(code);
      return row && row.active !== 0 && row.active !== false;
    }));
  }

  if (text) {
    out = new Set([...out].filter(code => {
      const row = concepts.get(code);
      if (!row) return false;
      if (searchCfg.activeOnly !== false && (row.active === 0 || row.active === false)) return false;

      if ((searchCfg.sources || []).includes('display') && String(row.display || '').toLowerCase().includes(text)) {
        return true;
      }
      if ((searchCfg.sources || []).includes('designation')) {
        const found = (fixture.designations || []).some(d =>
          d.concept_id === row.concept_id
          && (searchCfg.designationActiveOnly === false || (d.active !== 0 && d.active !== false))
          && String(d.value_text || d.value || '').toLowerCase().includes(text));
        if (found) return true;
      }
      if ((searchCfg.sources || []).includes('literal')) {
        const found = (fixture.literals || []).some(l =>
          l.source_concept_id === row.concept_id
          && (searchCfg.literalActiveOnly === false || (l.active !== 0 && l.active !== false))
          && String(l.value_text || l.value || '').toLowerCase().includes(text));
        if (found) return true;
      }
      return false;
    }));
  }

  return out;
}

function evaluateSelectorDirect(node, fixture) {
  const concepts = fixture.concepts || [];
  const byCode = new Map(concepts.map(row => [row.code, row]));
  const allCodes = concepts.map(row => row.code);
  const descendantsByAncestor = new Map();
  for (const edge of fixture.closure || []) {
    if (!descendantsByAncestor.has(edge.ancestor_id)) descendantsByAncestor.set(edge.ancestor_id, new Set());
    descendantsByAncestor.get(edge.ancestor_id).add(edge.descendant_id);
  }
  const partOfByAncestor = new Map();
  for (const edge of fixture.relations?.['property:PART_OF'] || []) {
    if (!partOfByAncestor.has(edge.ancestor_id)) partOfByAncestor.set(edge.ancestor_id, new Set());
    partOfByAncestor.get(edge.ancestor_id).add(edge.descendant_id);
  }

  function idsToCodes(ids) {
    return sorted(ids.map(id => concepts.find(row => row.concept_id === id)?.code).filter(Boolean));
  }

  function propertyValues(property, allowedValues, linkMatch) {
    const allowed = new Set(allowedValues.map(v => String(v).toLowerCase()));
    const out = new Set();
    for (const row of fixture.literals || []) {
      if (String(row.property || '') !== property || row.active === 0 || row.active === false) continue;
      if (allowed.has(String(row.value_text || '').toLowerCase())) out.add(row.source_concept_id);
    }
    for (const row of fixture.links || []) {
      if (String(row.property || '') !== property || row.active === 0 || row.active === false) continue;
      const target = concepts.find(c => c.concept_id === row.target_concept_id);
      if (!target) continue;
      const codeMatch = allowed.has(String(target.code || '').toLowerCase());
      const displayMatch = allowed.has(String(target.display || '').toLowerCase());
      if (codeMatch || (linkMatch === 'code-or-display' && displayMatch)) out.add(row.source_concept_id);
    }
    return idsToCodes([...out]);
  }

  if (node.shape === 'concept') {
    return new Set((node.conceptCodes || []).map(cc => cc.code).filter(code => byCode.has(code)));
  }
  if (node.shape === 'whole' || node.shape === 'all') {
    return new Set(allCodes);
  }
  let out = new Set(allCodes);
  for (const clause of node.filterClauses || []) {
    let clauseCodes = new Set();
    const property = String(clause.property || '');
    const op = String(clause.op || '');
    const value = String(clause.value || '');
    if (property === 'concept' && op === 'is-a') {
      const seed = byCode.get(value);
      const ids = seed ? [...(descendantsByAncestor.get(seed.concept_id) || [])] : [];
      clauseCodes = new Set(idsToCodes(ids));
    } else if (property === 'concept' && op === 'descendent-of') {
      const seed = byCode.get(value);
      const ids = seed ? [...(descendantsByAncestor.get(seed.concept_id) || [])].filter(id => id !== seed.concept_id) : [];
      clauseCodes = new Set(idsToCodes(ids));
    } else if (property === 'PART_OF' && op === 'is-a') {
      const seed = byCode.get(value);
      const ids = seed ? [...(partOfByAncestor.get(seed.concept_id) || [])] : [];
      clauseCodes = new Set(idsToCodes(ids));
    } else if (property === 'PART_OF' && op === 'descendent-of') {
      const seed = byCode.get(value);
      const ids = seed ? [...(partOfByAncestor.get(seed.concept_id) || [])].filter(id => id !== seed.concept_id) : [];
      clauseCodes = new Set(idsToCodes(ids));
    } else if (property === 'concept' && op === 'in') {
      clauseCodes = new Set(idsToCodes(fixture.valueSetMembers[value] || []));
    } else if (property === 'code' && op === 'regex') {
      const re = new RegExp(value);
      clauseCodes = new Set(allCodes.filter(code => re.test(code)));
    } else if (property === 'CLASS' && op === '=') {
      clauseCodes = new Set(propertyValues('CLASS', [value === 'chemistry' ? 'CHEM' : value], 'code-only'));
    } else if (property === 'CATEGORY' && op === '=') {
      clauseCodes = new Set(propertyValues('CATEGORY', [value], 'code-or-display'));
    } else if (property === 'SCALE' && op === 'regex') {
      const re = new RegExp(value);
      clauseCodes = new Set(
        idsToCodes(
          (fixture.literals || [])
            .filter(row => row.property === 'SCALE' && row.active !== 0 && row.active !== false && re.test(String(row.value_text || '')))
            .map(row => row.source_concept_id)
        )
      );
    }
    out = new Set([...out].filter(code => clauseCodes.has(code)));
  }
  if (Array.isArray(node.intersectCodes) && node.intersectCodes.length > 0) {
    const allow = new Set(node.intersectCodes.map(String));
    out = new Set([...out].filter(code => allow.has(code)));
  }
  return out;
}

describe('sqlite-v0 logical membership plan', () => {
  const fixture = makeFixture();
  const runtime = makeRuntime();
  const propertyDefs = makePropertyDefs();

  test('builds hierarchy descriptors for default and property-specific relations', () => {
    const descriptors = buildHierarchyDescriptors(propertyDefs, runtime);
    expect(descriptors.get('concept')).toEqual(expect.objectContaining({
      key: 'concept',
      property: 'concept',
      storage: 'closure',
    }));
    expect(descriptors.get('property:PART_OF')).toEqual(expect.objectContaining({
      key: 'property:PART_OF',
      property: 'PART_OF',
      storage: 'conceptLink',
    }));
  });

  test('explicitly rejects unsupported property lowering instead of returning empty', () => {
    const expr = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'UNKNOWN', op: '=', value: 'x', meta: { path: 'ValueSet.compose.include[0].filter[0]' } }],
    });

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime });
    expect(lowered.ok).toBe(false);
    expect(lowered.reason).toBe('unknown-property');
    expect(lowered.meta?.path).toBe('ValueSet.compose.include[0].filter[0]');
  });

  test('lowers and interprets hierarchy, property, regex, and valueSet membership filters', () => {
    const expr = IR.union([
      IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
      }),
      IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'CATEGORY', op: '=', value: 'Alpha Root' }],
      }),
      IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'SCALE', op: 'regex', value: '^Doc$' }],
      }),
      IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'in', value: 'http://example.org/refset/labish' }],
      }),
    ]);

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime });
    expect(lowered.ok).toBe(true);

    const ids = interpretMembershipPlan(lowered.plan, fixture);
    expect(conceptIdsToCodes(ids, fixture)).toEqual(['A-110', 'A-130']);
  });

  test('uses hierarchy descriptors for property-specific reachability', () => {
    const expr = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'PART_OF', op: 'is-a', value: 'A-100' }],
    });

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime });
    expect(lowered.ok).toBe(true);
    expect(membershipPlanStructuralForm(lowered.plan)).toEqual({
      kind: 'intersect',
      items: [{
        kind: 'fromRows',
        key: 'concept_id',
        rows: {
          kind: 'reachability',
          relation: expect.objectContaining({
            key: 'property:PART_OF',
            property: 'PART_OF',
          }),
          seed: {
            kind: 'explicitCodes',
            codes: ['A-100'],
          },
          direction: 'down',
          includeSelf: true,
          minDepth: 0,
          maxDepth: null,
        },
      }],
    });

    const ids = interpretMembershipPlan(lowered.plan, fixture);
    expect(conceptIdsToCodes(ids, fixture)).toEqual(['A-100', 'A-130']);
  });

  test('selection kernel applies activeOnly and deterministic text-search semantics', () => {
    const expr = IR.selector({
      system: 'urn:sys:A',
      shape: 'whole',
    });

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime });
    expect(lowered.ok).toBe(true);

    const selectionPlan = buildSelectionPlan(lowered.plan, {
      activeOnly: true,
      text: 'doc',
    }, {
      search: {
        sources: ['display', 'literal'],
        activeOnly: true,
        designationActiveOnly: true,
        literalActiveOnly: true,
      },
    });

    const ids = interpretMembershipPlan(selectionPlan, fixture);
    expect(conceptIdsToCodes(ids, fixture)).toEqual(['A-130']);
  });

  test('selection kernel matches direct active/text filtering on scoped IR results', () => {
    const expr = IR.union([
      IR.selector({
        system: 'urn:sys:A',
        shape: 'whole',
      }),
      IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'PART_OF', op: 'is-a', value: 'A-100' }],
      }),
    ]);

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime });
    expect(lowered.ok).toBe(true);

    const selectionRuntime = {
      search: {
        sources: ['display', 'designation', 'literal'],
        activeOnly: true,
        designationActiveOnly: true,
        literalActiveOnly: true,
      },
    };
    const selectionPlan = buildSelectionPlan(lowered.plan, {
      activeOnly: true,
      text: 'sugar',
    }, selectionRuntime);

    const planCodes = conceptIdsToCodes(interpretMembershipPlan(selectionPlan, fixture), fixture);
    const irCodes = sorted(interpretScopedIR(expr, {
      evaluateSelector(node) {
        return evaluateSelectorDirect(node, fixture);
      },
    }));
    const filteredDirect = sorted(applySelectionFiltersDirect(irCodes, fixture, selectionRuntime, {
      activeOnly: true,
      text: 'sugar',
    }));

    expect(planCodes).toEqual(filteredDirect);
    expect(planCodes).toEqual(['A-120']);
  });

  test('matches scoped IR semantics on a representative projected subtree', () => {
    const expr = IR.diff(
      IR.union([
        IR.selector({
          system: 'urn:sys:A',
          shape: 'filter',
          filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
        }),
        IR.selector({
          system: 'urn:sys:A',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'in', value: 'http://example.org/refset/labish' }],
        }),
        IR.selector({
          system: 'urn:sys:A',
          shape: 'concept',
          conceptCodes: [{ code: 'A-120' }],
        }),
        IR.selector({
          system: 'urn:sys:A',
          shape: 'filter',
          filterClauses: [{ property: 'PART_OF', op: 'is-a', value: 'A-100' }],
        }),
      ]),
      IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'descendent-of', value: 'A-110' }],
      }),
    );

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime });
    expect(lowered.ok).toBe(true);

    const planCodes = conceptIdsToCodes(interpretMembershipPlan(lowered.plan, fixture), fixture);
    const irCodes = sorted(interpretScopedIR(expr, {
      evaluateSelector(node) {
        return evaluateSelectorDirect(node, fixture);
      },
    }));

    expect(planCodes).toEqual(irCodes);
    expect(planCodes).toEqual(['A-100', 'A-110', 'A-120']);
  });
});
