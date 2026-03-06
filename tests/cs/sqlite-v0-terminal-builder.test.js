'use strict';

const Types = require('../../tx/cs/sqlite-v0-plan-types');
const { buildSelectionPlan } = require('../../tx/cs/sqlite-v0-selection-builder');
const { buildMaterializePlan, buildCountPlan, buildProbePlan } = require('../../tx/cs/sqlite-v0-terminal-builder');
const { physicalizeTerminalPlan, physicalPlanStructuralForm } = require('../../tx/cs/sqlite-v0-physicalize');

describe('sqlite-v0 plan type and terminal builders', () => {
  test('infers origin from nested logical plans', () => {
    const plan = Types.setIntersect({
      items: [
        {
          ...Types.explicitCodes({ codes: ['A'] }),
          meta: { path: 'ValueSet.compose.include[0]' },
          nodeId: 'n.0',
        },
        {
          ...Types.setUnion({
            items: [
              {
                ...Types.explicitCodes({ codes: ['B'] }),
                meta: { path: 'ValueSet.compose.include[1]' },
                nodeId: 'n.1',
              },
            ],
          }),
          nodeId: 'n',
          meta: { path: 'ValueSet.compose' },
        },
      ],
      meta: { path: 'ValueSet.compose.root' },
    });

    expect(Types.inferOriginFromPlan(plan)).toEqual({
      nodeIds: ['n', 'n.0', 'n.1'],
      paths: ['ValueSet.compose', 'ValueSet.compose.include[0]', 'ValueSet.compose.include[1]', 'ValueSet.compose.root'],
    });
  });

  test('selection builder remains a separate contract from IR lowering', () => {
    const selected = buildSelectionPlan(
      Types.explicitCodes({ codes: ['A', 'B'] }),
      { activeOnly: true, text: 'beta', meta: { path: 'runtime.selection' } },
      {}
    );

    expect(selected.kind).toBe('intersect');
    expect(selected.items.map(item => item.kind)).toEqual(['intersect', 'fromRows']);
    expect(physicalPlanStructuralForm(physicalizeTerminalPlan(buildCountPlan(selected)))).toEqual({
      kind: 'count',
      strategy: 'count-distinct-codes',
      selection: { activeOnly: false, text: null },
      members: {
        kind: 'intersect',
        strategy: 'exists-by-key',
        items: [
          {
            kind: 'scan-codes',
            strategy: 'code-in',
            codes: ['A', 'B'],
          },
          {
            kind: 'fromRows',
            strategy: 'row-source',
            key: 'concept_id',
            rows: {
              kind: 'row-filter',
              strategy: 'where-active',
              predicate: { kind: 'activeEquals', value: true },
              input: {
                kind: 'row-scan',
                strategy: 'table-scan',
                table: 'concept',
                as: null,
              },
            },
          },
          {
            kind: 'fromRows',
            strategy: 'row-source',
            key: 'concept_id',
            rows: {
              kind: 'row-search',
              strategy: 'fts-union-default-tables',
              text: 'beta',
              spec: {
                sources: ['designation', 'display'],
                activeOnlyConcepts: true,
                designationActiveOnly: true,
                literalActiveOnly: true,
              },
              ftsTables: { display: null, designation: null, literal: null },
            },
          },
        ],
      },
    });
  });

  test('terminal builders derive materialize, count, and probe plans with inferred origin', () => {
    const members = {
      ...Types.explicitCodes({ codes: ['A'] }),
      meta: { path: 'ValueSet.compose.include[0]' },
      nodeId: 'n.0',
    };

    expect(buildMaterializePlan(members, { offset: 10, count: 25 })).toEqual({
      kind: 'materializeConcepts',
      members,
      columns: ['active', 'code', 'concept_id', 'definition', 'display'],
      includeTotal: false,
      orderBy: [{ key: 'code', direction: 'asc' }],
      offset: 10,
      count: 25,
      selection: { activeOnly: false, text: null },
      scope: null,
      origin: { nodeIds: ['n.0'], paths: ['ValueSet.compose.include[0]'] },
      meta: null,
    });

    expect(buildCountPlan(members)).toEqual({
      kind: 'countMembers',
      members,
      selection: { activeOnly: false, text: null },
      scope: null,
      origin: { nodeIds: ['n.0'], paths: ['ValueSet.compose.include[0]'] },
      meta: null,
    });

    expect(buildProbePlan(members, 'A')).toEqual({
      kind: 'probeMemberByCode',
      members,
      code: 'A',
      scope: null,
      origin: { nodeIds: ['n.0'], paths: ['ValueSet.compose.include[0]'] },
      meta: null,
    });
  });

  test('terminal physicalization wraps the logical member plan with explicit terminal strategies', () => {
    const members = Types.setIntersect({
      items: [
        Types.explicitCodes({ codes: ['A', 'B'] }),
        Types.fromRows({
          rows: Types.rowFilter({
            input: Types.rowScan({ table: 'concept' }),
            predicate: { kind: 'activeEquals', value: true },
          }),
        }),
      ],
    });
    const physical = physicalizeTerminalPlan(
      buildMaterializePlan(members, { offset: 5, count: 10 })
    );

    expect(physicalPlanStructuralForm(physical)).toEqual({
      kind: 'materialize',
      strategy: 'ordered-materialize',
      selection: { activeOnly: false, text: null },
      members: {
        kind: 'intersect',
        strategy: 'exists-by-key',
        items: [
          {
            kind: 'scan-codes',
            strategy: 'code-in',
            codes: ['A', 'B'],
          },
          {
            kind: 'fromRows',
            strategy: 'row-source',
            key: 'concept_id',
            rows: {
              kind: 'row-filter',
              strategy: 'where-active',
              predicate: { kind: 'activeEquals', value: true },
              input: {
                kind: 'row-scan',
                strategy: 'table-scan',
                table: 'concept',
                as: null,
              },
            },
          },
        ],
      },
      columns: ['active', 'code', 'concept_id', 'definition', 'display'],
      includeTotal: false,
      orderBy: [{ key: 'code', direction: 'asc' }],
      offset: 5,
      count: 10,
    });
  });
});
