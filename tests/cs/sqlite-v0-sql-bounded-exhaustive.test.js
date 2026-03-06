'use strict';

const IR = require('../../tx/engine/ir');
const { buildMembershipPlan, buildSelectionPlan } = require('../../tx/cs/sqlite-v0-plan-builder');
const { interpretMembershipPlan, conceptIdsToCodes } = require('../../tx/cs/sqlite-v0-plan-interpret');
const { buildMaterializePlan, buildCountPlan, buildProbePlan } = require('../../tx/cs/sqlite-v0-terminal-builder');
const { physicalizeTerminalPlan } = require('../../tx/cs/sqlite-v0-physicalize');
const { lowerPhysicalPlanToSqlAst } = require('../../tx/cs/sqlite-v0-sql-ast');
const { emitSqlAst } = require('../../tx/cs/sqlite-v0-sql-emit');
const { buildRuntimeSqliteV0Db } = require('../support/sqlite-v0-runtime-db');

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
  search: {
    sources: ['display', 'designation'],
    activeOnly: true,
    designationActiveOnly: true,
    literalActiveOnly: true,
  },
};

function buildFixture({ activeMask, classMask, refsetMask, hasEdge }) {
  const concepts = [
    { concept_id: 1, code: 'A', display: 'Alpha', definition: 'Alpha', active: activeMask & 1 ? 1 : 0 },
    { concept_id: 2, code: 'B', display: 'Beta', definition: 'Beta', active: activeMask & 2 ? 1 : 0 },
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
  const designations = [
    { concept_id: 1, value_text: 'Alpha alt', active: 1 },
    { concept_id: 2, value_text: 'Beta alt', active: 1 },
  ];
  const members = [];
  if (refsetMask & 1) members.push(1);
  if (refsetMask & 2) members.push(2);
  return {
    concepts,
    closure,
    literals,
    links: [],
    designations,
    relations: {},
    valueSetMembers: {
      'http://example.org/refset/x': members,
    },
  };
}

function exprCatalog() {
  return [
    IR.selector({ system: 'urn:sys:A', shape: 'whole' }),
    IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'A' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'B' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'concept', op: 'is-a', value: 'A' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'concept', op: 'descendent-of', value: 'A' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'concept', op: 'in', value: 'http://example.org/refset/x' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'code', op: 'regex', value: '^A$' }] }),
    IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }),
    IR.union([
      IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }),
      IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'B' }] }),
    ]),
    IR.intersect([
      IR.selector({ system: 'urn:sys:A', shape: 'whole' }),
      IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'concept', op: 'in', value: 'http://example.org/refset/x' }] }),
    ]),
    IR.diff(
      IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'concept', op: 'is-a', value: 'A' }] }),
      IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'B' }] })
    ),
  ];
}

function compileSql(physical, scope) {
  const lowered = lowerPhysicalPlanToSqlAst(physical, { propertyDefs, runtime, scope });
  return emitSqlAst(lowered.ast, lowered.params);
}

describe('sqlite-v0 bounded exhaustive logical-plan -> SQL parity', () => {
  test('emitted SQL matches logical interpreter on tiny exhaustive catalog', () => {
    const exprs = exprCatalog();
    const selections = [
      { activeOnly: false, text: '' },
      { activeOnly: true, text: '' },
      { activeOnly: false, text: 'alpha' },
      { activeOnly: false, text: 'beta' },
    ];

    let checked = 0;
    for (let activeMask = 0; activeMask < 4; activeMask++) {
      for (let classMask = 0; classMask < 4; classMask++) {
        for (let refsetMask = 0; refsetMask < 4; refsetMask++) {
          for (const hasEdge of [false, true]) {
            const fixture = buildFixture({ activeMask, classMask, refsetMask, hasEdge });
            const scope = { csId: 1, system: 'urn:sys:A', version: null };
            const db = buildRuntimeSqliteV0Db(fixture, { propertyDefs, runtime, csId: scope.csId });
            try {
              for (const expr of exprs) {
                const lowered = buildMembershipPlan(expr, { propertyDefs, runtime, scope });
                expect(lowered.ok).toBe(true);
                for (const selection of selections) {
                  const selected = buildSelectionPlan(lowered.plan, selection, runtime);
                  const expectedCodes = conceptIdsToCodes(interpretMembershipPlan(selected, fixture), fixture);
                  const expectedCount = expectedCodes.length;

                  const expandSql = compileSql(physicalizeTerminalPlan(buildMaterializePlan(selected, { scope }), { runtime }), scope);
                  const expandRows = db.prepare(expandSql.text).all(expandSql.params);
                  expect(expandRows.map(r => r.code)).toEqual(expectedCodes);

                  const countSql = compileSql(physicalizeTerminalPlan(buildCountPlan(selected, { scope }), { runtime }), scope);
                  const countRow = db.prepare(countSql.text).get(countSql.params);
                  expect(countRow.cnt).toBe(expectedCount);
                }

                const expectedProbe = interpretMembershipPlan(lowered.plan, fixture).has(1);
                const probeSql = compileSql(physicalizeTerminalPlan(buildProbePlan(lowered.plan, 'A', { scope }), { runtime }), scope);
                const probeRow = db.prepare(probeSql.text).get(probeSql.params);
                expect(!!probeRow).toBe(expectedProbe);
                checked++;
              }
            } finally {
              db.close();
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
