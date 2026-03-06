'use strict';

const Types = require('../../tx/cs/sqlite-v0-plan-types');
const { physicalizeMembershipPlan, physicalPlanStructuralForm } = require('../../tx/cs/sqlite-v0-physicalize');

function conceptDescriptor(extra = {}) {
  return {
    key: 'concept',
    property: 'concept',
    storage: 'closure',
    edgeSetId: 1,
    includeSelfForIsA: true,
    label: 'Default concept hierarchy',
    ...extra,
  };
}

describe('sqlite-v0 physicalizer', () => {
  test('normalizes first, then assigns deterministic set strategies', () => {
    const raw = Types.setUnion({
      items: [
        Types.explicitCodes({ codes: ['B'] }),
        Types.setUnion({
          items: [
            Types.explicitCodes({ codes: ['A'] }),
            Types.explicitCodes({ codes: ['B'] }),
          ],
        }),
      ],
    });

    const physical = physicalizeMembershipPlan(raw);
    expect(physicalPlanStructuralForm(physical)).toEqual({
      kind: 'scan-codes',
      strategy: 'code-in',
      codes: ['A', 'B'],
    });
  });

  test('labels concept reachability via a row reachability source', () => {
    const physical = physicalizeMembershipPlan(
      Types.fromRows({
        rows: Types.rowReachability({
          relation: conceptDescriptor(),
          seed: Types.explicitCodes({ codes: ['404684003'] }),
          direction: 'down',
          includeSelf: true,
        }),
      })
    );

    expect(physicalPlanStructuralForm(physical)).toEqual({
      kind: 'fromRows',
      strategy: 'row-source',
      key: 'concept_id',
      rows: {
        kind: 'row-reachability',
        strategy: 'closure-join',
        relation: {
          key: 'concept',
          property: 'concept',
          storage: 'closure',
          edgeSetId: 1,
          includeSelfForIsA: true,
          label: 'Default concept hierarchy',
        },
        seed: {
          kind: 'scan-codes',
          strategy: 'code-in',
          codes: ['404684003'],
        },
        direction: 'down',
        includeSelf: true,
      },
    });
  });

  test('labels property reachability through concept-link recursion', () => {
    const physical = physicalizeMembershipPlan(
      Types.fromRows({
        rows: Types.rowReachability({
          relation: conceptDescriptor({
            key: 'property:PART_OF',
            property: 'PART_OF',
            storage: 'conceptLink',
            label: 'Hierarchy property PART_OF',
          }),
          seed: Types.explicitCodes({ codes: ['A-100'] }),
          direction: 'down',
          includeSelf: true,
        }),
      })
    );

    expect(physicalPlanStructuralForm(physical)).toEqual({
      kind: 'fromRows',
      strategy: 'row-source',
      key: 'concept_id',
      rows: {
        kind: 'row-reachability',
        strategy: 'relation-conceptLink',
        relation: {
          key: 'property:PART_OF',
          property: 'PART_OF',
          storage: 'conceptLink',
          edgeSetId: 1,
          includeSelfForIsA: true,
          label: 'Hierarchy property PART_OF',
        },
        seed: {
          kind: 'scan-codes',
          strategy: 'code-in',
          codes: ['A-100'],
        },
        direction: 'down',
        includeSelf: true,
      },
    });
  });

  test('chooses row-filter strategies based on configured sources', () => {
    const literal = physicalizeMembershipPlan(
      Types.fromRows({
        key: 'source_concept_id',
        rows: Types.rowFilter({
          input: Types.rowScan({ table: 'concept_literal' }),
          predicate: { kind: 'literalPropertyMatch', property: 'CLASS', values: ['CHEM'] },
        }),
      })
    );
    const link = physicalizeMembershipPlan(
      Types.fromRows({
        key: 'source_concept_id',
        rows: Types.rowFilter({
          input: Types.rowScan({ table: 'concept_link' }),
          predicate: { kind: 'linkPropertyMatch', property: 'CATEGORY', values: ['root'], linkMatch: 'code-or-display' },
        }),
      })
    );

    expect(literal.rows.strategy).toBe('literal-in');
    expect(link.rows.strategy).toBe('link-code-or-display');
  });

  test('chooses text-search strategy from available FTS config', () => {
    const withConfiguredTables = physicalizeMembershipPlan(
      Types.fromRows({
        rows: Types.rowSearch({
          text: 'diabetes',
          spec: { sources: ['display', 'designation'] },
        }),
      }),
      { runtime: { search: { ftsTables: { display: 'search_fts_display' } } } }
    );
    const withDefaultTables = physicalizeMembershipPlan(
      Types.fromRows({
        rows: Types.rowSearch({
          text: 'diabetes',
          spec: { sources: ['display'] },
        }),
      })
    );
    const likeFallback = physicalizeMembershipPlan(
      Types.fromRows({
        rows: Types.rowSearch({
          text: 'diabetes',
          spec: { sources: [] },
        }),
      })
    );

    expect(withConfiguredTables.rows.strategy).toBe('fts-union');
    expect(withDefaultTables.rows.strategy).toBe('fts-union-default-tables');
    expect(likeFallback.rows.strategy).toBe('display-like');
  });
});
