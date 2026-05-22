'use strict';

const IR = require('../../tx/engine/ir');
const { interpretScopedIR } = require('../../tx/engine/scoped-ir-interpreter');
const { buildMembershipPlan } = require('../../tx/cs/sqlite-v0-plan-builder');
const { interpretMembershipPlan, conceptIdsToCodes } = require('../../tx/cs/sqlite-v0-plan-interpret');

const propertyDefs = new Map([
  ['CLASS', { property_id: 1, value_kind: 'literal' }],
]);

const runtime = {
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
      },
    },
  },
};

function powerset(values) {
  const out = [[]];
  for (const value of values) {
    const next = out.map(set => [...set, value]);
    out.push(...next);
  }
  return out;
}

function buildFixture({ activeMask, classMask, refsetMask, hasEdge }) {
  const concepts = [
    { concept_id: 1, code: 'A', display: 'Alpha', active: activeMask & 1 ? 1 : 0 },
    { concept_id: 2, code: 'B', display: 'Beta', active: activeMask & 2 ? 1 : 0 },
  ];
  const closure = [
    { ancestor_id: 1, descendant_id: 1 },
    { ancestor_id: 2, descendant_id: 2 },
  ];
  if (hasEdge) closure.push({ ancestor_id: 1, descendant_id: 2 });
  const literals = [
    { source_concept_id: 1, property: 'CLASS', value_text: classMask & 1 ? 'CHEM' : 'DIAG', value_raw: classMask & 1 ? 'CHEM' : 'DIAG', active: 1 },
    { source_concept_id: 2, property: 'CLASS', value_text: classMask & 2 ? 'CHEM' : 'DIAG', value_raw: classMask & 2 ? 'CHEM' : 'DIAG', active: 1 },
  ];
  const members = [];
  if (refsetMask & 1) members.push(1);
  if (refsetMask & 2) members.push(2);
  return {
    concepts,
    closure,
    literals,
    links: [],
    designations: [],
    relations: {},
    valueSetMembers: {
      'http://example.org/refset/x': members,
    },
  };
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

  function idsToCodes(ids) {
    return [...ids]
      .map(id => concepts.find(row => row.concept_id === id)?.code)
      .filter(Boolean)
      .sort();
  }

  if (node.shape === 'whole' || node.shape === 'all') return new Set(allCodes);
  if (node.shape === 'concept') {
    return new Set((node.conceptCodes || []).map(cc => cc.code).filter(code => byCode.has(code)));
  }

  let out = new Set(allCodes);
  for (const clause of node.filterClauses || []) {
    const property = String(clause.property || '');
    const op = String(clause.op || '');
    const value = String(clause.value || '');
    let clauseCodes = new Set();
    if (property === 'concept' && op === 'is-a') {
      const seed = byCode.get(value);
      const ids = seed ? [...(descendantsByAncestor.get(seed.concept_id) || [])] : [];
      clauseCodes = new Set(idsToCodes(ids));
    } else if (property === 'concept' && op === 'descendent-of') {
      const seed = byCode.get(value);
      const ids = seed ? [...(descendantsByAncestor.get(seed.concept_id) || [])].filter(id => id !== seed.concept_id) : [];
      clauseCodes = new Set(idsToCodes(ids));
    } else if (property === 'concept' && op === 'in') {
      clauseCodes = new Set(idsToCodes(fixture.valueSetMembers[value] || []));
    } else if (property === 'code' && op === 'regex') {
      const re = new RegExp(value);
      clauseCodes = new Set(allCodes.filter(code => re.test(code)));
    } else if (property === 'CLASS' && op === '=') {
      const match = value === 'chemistry' ? 'CHEM' : value;
      clauseCodes = new Set(
        (fixture.literals || [])
          .filter(row => row.property === 'CLASS' && String(row.value_text) === match)
          .map(row => concepts.find(c => c.concept_id === row.source_concept_id)?.code)
          .filter(Boolean)
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

function selectorCatalog() {
  return [
    IR.selector({ system: 'urn:sys:A', shape: 'whole' }),
    IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'A' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'B' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'concept', op: 'is-a', value: 'A' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'concept', op: 'descendent-of', value: 'A' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'concept', op: 'in', value: 'http://example.org/refset/x' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'code', op: 'regex', value: '^A$' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }] }),
  ];
}

function exprCatalog() {
  const selectors = selectorCatalog();
  const out = [...selectors];
  for (const [a, b] of powerset(selectors).filter(set => set.length === 2)) {
    out.push(IR.union([a, b]));
    out.push(IR.intersect([a, b]));
    out.push(IR.diff(a, b));
  }
  return out;
}

describe('sqlite-v0 bounded exhaustive scoped-IR -> logical-plan parity', () => {
  test('provider logical interpreter matches scoped IR on tiny exhaustive catalog', () => {
    const exprs = exprCatalog();
    let checked = 0;
    for (let activeMask = 0; activeMask < 4; activeMask++) {
      for (let classMask = 0; classMask < 4; classMask++) {
        for (let refsetMask = 0; refsetMask < 4; refsetMask++) {
          for (const hasEdge of [false, true]) {
            const fixture = buildFixture({ activeMask, classMask, refsetMask, hasEdge });
            for (const expr of exprs) {
              const lowered = buildMembershipPlan(expr, { propertyDefs, runtime });
              expect(lowered.ok).toBe(true);
              const logicalCodes = conceptIdsToCodes(interpretMembershipPlan(lowered.plan, fixture), fixture);
              const irCodes = [...interpretScopedIR(expr, {
                evaluateSelector(node) {
                  return evaluateSelectorDirect(node, fixture);
                },
              })].sort();
              expect(logicalCodes).toEqual(irCodes);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
