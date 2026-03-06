'use strict';

const IR = require('../../tx/engine/ir');
const { createSqliteV0Compiler } = require('../../tx/cs/sqlite-v0-compiler');
const { buildMembershipPlan, buildSelectionPlan } = require('../../tx/cs/sqlite-v0-plan-builder');
const { interpretMembershipPlan, conceptIdsToCodes } = require('../../tx/cs/sqlite-v0-plan-interpret');
const { buildCountPlan, buildMaterializePlan, buildProbePlan } = require('../../tx/cs/sqlite-v0-terminal-builder');
const { physicalizeTerminalPlan } = require('../../tx/cs/sqlite-v0-physicalize');
const { lowerPhysicalPlanToSqlAst, sqlAstStructuralForm } = require('../../tx/cs/sqlite-v0-sql-ast');
const { emitSqlAst } = require('../../tx/cs/sqlite-v0-sql-emit');
const { buildRuntimeSqliteV0Db } = require('../support/sqlite-v0-runtime-db');

function makeFixture() {
  return {
    concepts: [
      { concept_id: 1, code: 'A-100', display: 'Alpha Root', definition: 'alpha root', active: 1 },
      { concept_id: 2, code: 'A-110', display: 'Alpha Lab', definition: 'alpha lab', active: 1 },
      { concept_id: 3, code: 'A-120', display: 'Alpha Diag', definition: 'alpha diag', active: 1 },
      { concept_id: 4, code: 'A-130', display: 'Alpha Doc', definition: 'alpha doc', active: 1 },
      { concept_id: 5, code: 'A-140', display: 'Dormant Alpha', definition: 'alpha dormant', active: 0 },
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
      { source_concept_id: 2, property: 'CLASS', value_text: 'CHEM', value_raw: 'CHEM', active: 1 },
      { source_concept_id: 3, property: 'CLASS', value_text: 'DIAG', value_raw: 'DIAG', active: 1 },
      { source_concept_id: 4, property: 'CLASS', value_text: 'CHEM', value_raw: 'CHEM', active: 1 },
      { source_concept_id: 4, property: 'SCALE', value_text: 'Doc', value_raw: 'Doc', active: 1 },
      { source_concept_id: 5, property: 'NOTE', value_text: 'Dormant marker', value_raw: 'Dormant marker', active: 1 },
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
    search: {
      sources: ['display', 'designation', 'literal'],
      activeOnly: true,
      designationActiveOnly: true,
      literalActiveOnly: true,
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

describe('sqlite-v0 SQL AST parity', () => {
  const fixture = makeFixture();
  const runtime = makeRuntime();
  const propertyDefs = makePropertyDefs();

  test('compiler emits SQL AST and SQL for expand/count/probe', () => {
    const compiler = createSqliteV0Compiler({
      propertyDefs,
      runtime,
      scope: { system: 'urn:sys:A', version: null },
    });
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
    });

    const expand = compiler.compileExpand(subtree, { activeOnly: true, text: 'alpha', count: 10 });
    const count = compiler.compileCount(subtree, { activeOnly: true, text: 'alpha' });
    const probe = compiler.compileProbe(subtree, 'A-110');

    expect(sqlAstStructuralForm(expand.sqlAst)).toEqual(expect.objectContaining({ kind: 'select' }));
    expect(expand.sql.text).toContain('SELECT');
    expect(count.sql.text).toContain('COUNT');
    expect(probe.sql.text).toContain('LIMIT 1');
  });

  test('compiler fast-path hierarchy materialization matches logical interpreter on the runtime schema', () => {
    const scope = { csId: 1, system: 'urn:sys:A', version: null };
    const db = buildRuntimeSqliteV0Db(fixture, { propertyDefs, runtime, csId: scope.csId });
    const compiler = createSqliteV0Compiler({ propertyDefs, runtime, scope });
    const expr = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'concept', op: 'is-a', value: 'A-100' }],
    });

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime, scope });
    expect(lowered.ok).toBe(true);
    const expectedCodes = conceptIdsToCodes(
      interpretMembershipPlan(buildSelectionPlan(lowered.plan, { activeOnly: true }, runtime), fixture),
      fixture
    ).slice(0, 2);

    const compiled = compiler.compileExpand(expr, { activeOnly: true, count: 2 });
    expect(compiled.sql.text).toContain('FROM "concept" "c"');
    expect(compiled.sql.text).toContain('EXISTS (SELECT 1 AS "found" FROM "closure" "cl"');

    const rows = db.prepare(compiled.sql.text).all(compiled.sql.params);
    expect(rows.map(r => r.code)).toEqual(expectedCodes);

    db.close();
  });

  test('compiler fast-path hierarchy count matches logical interpreter on the runtime schema', () => {
    const scope = { csId: 1, system: 'urn:sys:A', version: null };
    const db = buildRuntimeSqliteV0Db(fixture, { propertyDefs, runtime, csId: scope.csId });
    const compiler = createSqliteV0Compiler({ propertyDefs, runtime, scope });
    const expr = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'concept', op: 'is-a', value: 'A-100' }],
    });

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime, scope });
    expect(lowered.ok).toBe(true);
    const expectedCount = interpretMembershipPlan(buildSelectionPlan(lowered.plan, { activeOnly: true }, runtime), fixture).size;

    const compiled = compiler.compileCount(expr, { activeOnly: true });
    expect(compiled.sql.text).toContain('FROM "closure" "cl"');
    expect(compiled.sql.text).not.toContain('FROM (SELECT DISTINCT "r"."concept_id"');

    const row = db.prepare(compiled.sql.text).get(compiled.sql.params);
    expect(row.cnt).toBe(expectedCount);

    db.close();
  });

  test('compiler fast-path concept-link materialization with text matches logical interpreter on the runtime schema', () => {
    const scope = { csId: 1, system: 'urn:sys:A', version: null };
    const db = buildRuntimeSqliteV0Db(fixture, { propertyDefs, runtime, csId: scope.csId });
    const compiler = createSqliteV0Compiler({ propertyDefs, runtime, scope });
    const expr = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CATEGORY', op: '=', value: 'root' }],
    });

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime, scope });
    expect(lowered.ok).toBe(true);
    const expectedCodes = conceptIdsToCodes(
      interpretMembershipPlan(buildSelectionPlan(lowered.plan, { activeOnly: true, text: 'alpha' }, runtime), fixture),
      fixture
    ).slice(0, 2);

    const compiled = compiler.compileExpand(expr, { activeOnly: true, text: 'alpha', count: 2 });
    expect(compiled.sql.text).toContain('FROM "concept" "c"');
    expect(compiled.sql.text).toContain('EXISTS (SELECT 1 AS "found"');
    expect(compiled.sql.text).toContain('MATCH @search_match_');

    const rows = db.prepare(compiled.sql.text).all(compiled.sql.params);
    expect(rows.map(r => r.code)).toEqual(expectedCodes);

    db.close();
  });

  test('compiler fast-path concept-link count with text matches logical interpreter on the runtime schema', () => {
    const scope = { csId: 1, system: 'urn:sys:A', version: null };
    const db = buildRuntimeSqliteV0Db(fixture, { propertyDefs, runtime, csId: scope.csId });
    const compiler = createSqliteV0Compiler({ propertyDefs, runtime, scope });
    const expr = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CATEGORY', op: '=', value: 'root' }],
    });

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime, scope });
    expect(lowered.ok).toBe(true);
    const expectedCount = interpretMembershipPlan(
      buildSelectionPlan(lowered.plan, { activeOnly: true, text: 'alpha' }, runtime),
      fixture
    ).size;

    const compiled = compiler.compileCount(expr, { activeOnly: true, text: 'alpha' });
    expect(compiled.sql.text).toContain('FROM "concept" "c"');
    expect(compiled.sql.text).toContain('COUNT(*)');
    expect(compiled.sql.text).toContain('EXISTS (SELECT 1 AS "found"');
    expect(compiled.sql.text).toContain('MATCH @search_match_');

    const row = db.prepare(compiled.sql.text).get(compiled.sql.params);
    expect(row.cnt).toBe(expectedCount);

    db.close();
  });

  test('logical interpreter and emitted SQL agree for materialize/count/probe on the runtime schema', () => {
    const scope = { csId: 1, system: 'urn:sys:A', version: null };
    const db = buildRuntimeSqliteV0Db(fixture, { propertyDefs, runtime, csId: scope.csId });
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

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime, scope });
    expect(lowered.ok).toBe(true);
    const selected = buildSelectionPlan(lowered.plan, {
      activeOnly: true,
      text: 'alpha',
    }, runtime);

    const expectedMaterialized = conceptIdsToCodes(interpretMembershipPlan(selected, fixture), fixture).slice(0, 2);
    const expectedCount = interpretMembershipPlan(selected, fixture).size;
    const expectedProbeTrue = interpretMembershipPlan(lowered.plan, fixture).has(2);
    const expectedProbeFalse = interpretMembershipPlan(lowered.plan, fixture).has(5);

    const expandPhysical = physicalizeTerminalPlan(buildMaterializePlan(selected, { scope, count: 2 }), { runtime });
    const expandSql = (() => {
      const loweredAst = lowerPhysicalPlanToSqlAst(expandPhysical, { propertyDefs, runtime, scope });
      return emitSqlAst(loweredAst.ast, loweredAst.params);
    })();
    const expandRows = db.prepare(expandSql.text).all(expandSql.params);
    expect(expandRows.map(r => r.code)).toEqual(expectedMaterialized);

    const countPhysical = physicalizeTerminalPlan(buildCountPlan(selected, { scope }), { runtime });
    const countAst = lowerPhysicalPlanToSqlAst(countPhysical, { propertyDefs, runtime, scope });
    const countSql = emitSqlAst(countAst.ast, countAst.params);
    const countRow = db.prepare(countSql.text).get(countSql.params);
    expect(countRow.cnt).toBe(expectedCount);

    const probeTruePhysical = physicalizeTerminalPlan(buildProbePlan(lowered.plan, 'A-110', { scope }), { runtime });
    const probeTrueAst = lowerPhysicalPlanToSqlAst(probeTruePhysical, { propertyDefs, runtime, scope });
    const probeTrueSql = emitSqlAst(probeTrueAst.ast, probeTrueAst.params);
    const probeTrueRow = db.prepare(probeTrueSql.text).get(probeTrueSql.params);
    expect(!!probeTrueRow).toBe(expectedProbeTrue);

    const probeFalsePhysical = physicalizeTerminalPlan(buildProbePlan(lowered.plan, 'A-140', { scope }), { runtime });
    const probeFalseAst = lowerPhysicalPlanToSqlAst(probeFalsePhysical, { propertyDefs, runtime, scope });
    const probeFalseSql = emitSqlAst(probeFalseAst.ast, probeFalseAst.params);
    const probeFalseRow = db.prepare(probeFalseSql.text).get(probeFalseSql.params);
    expect(!!probeFalseRow).toBe(expectedProbeFalse);

    db.close();
  });

  test('runtime-mode SQL matches logical interpreter on the real v0 schema and respects scope', () => {
    const scopedFixture = makeFixture();
    scopedFixture.concepts.push({
      concept_id: 99, cs_id: 2, code: 'X-999', display: 'Alpha Foreign', definition: 'foreign alpha', active: 1,
    });
    scopedFixture.literals.push({
      source_concept_id: 99, property: 'CLASS', value_text: 'CHEM', value_raw: 'CHEM', active: 1,
    });

    const scope = { csId: 1, system: 'urn:sys:A', version: null };
    const db = buildRuntimeSqliteV0Db(scopedFixture, { propertyDefs, runtime, csId: 1 });
    const expr = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
    });

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime, scope });
    expect(lowered.ok).toBe(true);
    const selected = buildSelectionPlan(lowered.plan, {
      activeOnly: true,
      text: 'alpha',
    }, runtime);

    const expectedCodes = conceptIdsToCodes(interpretMembershipPlan(selected, scopedFixture), scopedFixture).sort();
    expect(expectedCodes).toEqual(['A-110', 'A-130']);

    const expandPhysical = physicalizeTerminalPlan(buildMaterializePlan(selected, { scope, count: 10 }), { runtime });
    const expandAst = lowerPhysicalPlanToSqlAst(expandPhysical, {
      propertyDefs,
      runtime,
      scope,
    });
    const expandSql = emitSqlAst(expandAst.ast, expandAst.params);
    const expandRows = db.prepare(expandSql.text).all(expandSql.params);
    expect(expandRows.map(r => r.code).sort()).toEqual(expectedCodes);
    expect(expandRows.some(r => r.code === 'X-999')).toBe(false);

    const countPhysical = physicalizeTerminalPlan(buildCountPlan(selected, { scope }), { runtime });
    const countAst = lowerPhysicalPlanToSqlAst(countPhysical, {
      propertyDefs,
      runtime,
      scope,
    });
    const countSql = emitSqlAst(countAst.ast, countAst.params);
    const countRow = db.prepare(countSql.text).get(countSql.params);
    expect(countRow.cnt).toBe(expectedCodes.length);

    const probePhysical = physicalizeTerminalPlan(buildProbePlan(lowered.plan, 'X-999', { scope }), { runtime });
    const probeAst = lowerPhysicalPlanToSqlAst(probePhysical, {
      propertyDefs,
      runtime,
      scope,
    });
    const probeSql = emitSqlAst(probeAst.ast, probeAst.params);
    const probeRow = db.prepare(probeSql.text).get(probeSql.params);
    expect(!!probeRow).toBe(false);

    db.close();
  });

  test('runtime-mode recursive property hierarchy matches logical interpreter on the real v0 schema', () => {
    const fixture = {
      concepts: [
        { concept_id: 1, cs_id: 1, code: 'A-100', display: 'Root', active: 1 },
        { concept_id: 2, cs_id: 1, code: 'A-110', display: 'Child', active: 1 },
        { concept_id: 3, cs_id: 1, code: 'A-120', display: 'Leaf', active: 1 },
        { concept_id: 4, cs_id: 1, code: 'A-130', display: 'Peer', active: 1 },
      ],
      links: [
        { source_concept_id: 2, property: 'PART_OF', target_concept_id: 1, active: 1 },
        { source_concept_id: 3, property: 'PART_OF', target_concept_id: 2, active: 1 },
        { source_concept_id: 4, property: 'PART_OF', target_concept_id: 1, active: 1 },
      ],
      relations: {
        'property:PART_OF': [
          { ancestor_id: 1, descendant_id: 1 },
          { ancestor_id: 1, descendant_id: 2 },
          { ancestor_id: 1, descendant_id: 3 },
          { ancestor_id: 1, descendant_id: 4 },
          { ancestor_id: 2, descendant_id: 2 },
          { ancestor_id: 2, descendant_id: 3 },
          { ancestor_id: 3, descendant_id: 3 },
          { ancestor_id: 4, descendant_id: 4 },
        ],
      },
    };
    const scope = { csId: 1, system: 'urn:sys:A', version: null };
    const db = buildRuntimeSqliteV0Db(fixture, { propertyDefs, runtime, csId: 1 });
    const expr = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'PART_OF', op: 'is-a', value: 'A-100' }],
    });

    const lowered = buildMembershipPlan(expr, { propertyDefs, runtime, scope });
    expect(lowered.ok).toBe(true);
    const expectedIds = interpretMembershipPlan(lowered.plan, fixture);
    const expectedCodes = conceptIdsToCodes(expectedIds, fixture).sort();
    expect(expectedCodes).toEqual(['A-100', 'A-110', 'A-120', 'A-130']);

    const expandPhysical = physicalizeTerminalPlan(buildMaterializePlan(lowered.plan, { scope, count: 10 }), { runtime });
    const expandAst = lowerPhysicalPlanToSqlAst(expandPhysical, {
      propertyDefs,
      runtime,
      scope,
    });
    const expandSql = emitSqlAst(expandAst.ast, expandAst.params);
    const expandRows = db.prepare(expandSql.text).all(expandSql.params);
    expect(expandRows.map(r => r.code).sort()).toEqual(expectedCodes);

    const descExpr = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'PART_OF', op: 'descendent-of', value: 'A-100' }],
    });
    const descLowered = buildMembershipPlan(descExpr, { propertyDefs, runtime, scope });
    expect(descLowered.ok).toBe(true);
    const descExpected = conceptIdsToCodes(interpretMembershipPlan(descLowered.plan, fixture), fixture).sort();
    expect(descExpected).toEqual(['A-110', 'A-120', 'A-130']);
    const descPhysical = physicalizeTerminalPlan(buildMaterializePlan(descLowered.plan, { scope, count: 10 }), { runtime });
    const descAst = lowerPhysicalPlanToSqlAst(descPhysical, {
      propertyDefs,
      runtime,
      scope,
    });
    const descSql = emitSqlAst(descAst.ast, descAst.params);
    const descRows = db.prepare(descSql.text).all(descSql.params);
    expect(descRows.map(r => r.code).sort()).toEqual(descExpected);

    db.close();
  });

  test('row-values lowers through SQL AST and executes deterministically', () => {
    const scope = { csId: 1, system: 'urn:sys:A', version: null };
    const db = buildRuntimeSqliteV0Db({
      concepts: [
        { concept_id: 1, code: 'A', display: 'A', active: 1, cs_id: 1 },
        { concept_id: 2, code: 'B', display: 'B', active: 1, cs_id: 1 },
        { concept_id: 3, code: 'C', display: 'C', active: 1, cs_id: 1 },
      ],
    }, { csId: scope.csId, propertyDefs, runtime });
    const rowValuesPlan = {
      kind: 'materialize',
      strategy: 'ordered-materialize',
      members: {
        kind: 'fromRows',
        strategy: 'row-source',
        key: 'concept_id',
        rows: {
          kind: 'row-values',
          strategy: 'inline-values',
          columns: ['concept_id'],
          rows: [[3], [1], [3], [2]],
        },
      },
      columns: ['concept_id', 'code'],
      orderBy: [{ key: 'concept_id', direction: 'asc' }],
      offset: 0,
      count: null,
      scope,
      origin: { nodeIds: [], paths: [] },
    };
    const lowered = lowerPhysicalPlanToSqlAst(rowValuesPlan, { propertyDefs, runtime, scope });
    const sql = emitSqlAst(lowered.ast, lowered.params);
    const rows = db.prepare(sql.text).all(sql.params);

    expect(rows.map(r => [r.concept_id, r.code])).toEqual([[1, 'A'], [2, 'B'], [3, 'C']]);
    db.close();
  });
});
