'use strict';

const {
  analyzeFilterClauseSupport,
  lowerFilterClauseToSetPlan,
} = require('../../tx/cs/sqlite-v0-clause-lowering');
const { membershipPlanStructuralForm } = require('../../tx/cs/sqlite-v0-plan-normalize');

function makeRuntime() {
  return {
    hierarchy: {
      edgeSetId: 7,
    },
    filters: {
      concept: {
        isAIncludesSelf: true,
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
    ['PART_OF', { property_id: 3, value_kind: 'concept', is_hierarchy: true }],
  ]);
}

describe('sqlite-v0 clause lowering', () => {
  const runtime = makeRuntime();
  const propertyDefs = makePropertyDefs();

  test('lowers concept hierarchy filters to SetPlan/fromRows reachability', () => {
    const lowered = lowerFilterClauseToSetPlan({
      property: 'concept',
      op: 'is-a',
      value: 'ROOT',
      meta: { path: 'ValueSet.compose.include[0].filter[0]' },
    }, propertyDefs, runtime);

    expect(lowered.ok).toBe(true);
    expect(membershipPlanStructuralForm(lowered.plan)).toEqual({
      kind: 'fromRows',
      key: 'concept_id',
      rows: {
        kind: 'reachability',
        relation: {
          key: 'concept',
          property: 'concept',
          operators: ['descendent-of', 'is-a'],
          storage: 'closure',
          edgeSetId: 7,
          includeSelfForIsA: true,
          label: 'Default concept hierarchy',
        },
        seed: {
          kind: 'explicitCodes',
          codes: ['ROOT'],
        },
        direction: 'down',
        includeSelf: true,
        minDepth: 0,
        maxDepth: null,
      },
    });
  });

  test('normalizes aliased literal filters into literal row predicates', () => {
    const lowered = lowerFilterClauseToSetPlan({
      property: 'CLASS',
      op: 'in',
      value: 'chemistry,DIAG',
    }, propertyDefs, runtime);

    expect(lowered.ok).toBe(true);
    expect(membershipPlanStructuralForm(lowered.plan)).toEqual({
      kind: 'fromRows',
      key: 'source_concept_id',
      rows: {
        kind: 'filter',
        input: {
          kind: 'scan',
          table: 'concept_literal',
          as: null,
        },
        predicate: {
          kind: 'literalPropertyMatch',
          property: 'CLASS',
          values: ['CHEM', 'DIAG'],
        },
      },
    });
  });

  test('lowers property hierarchy filters to a concept-link relation descriptor', () => {
    const lowered = lowerFilterClauseToSetPlan({
      property: 'PART_OF',
      op: 'is-a',
      value: 'ROOT',
    }, propertyDefs, runtime);

    expect(lowered.ok).toBe(true);
    expect(membershipPlanStructuralForm(lowered.plan)).toEqual({
      kind: 'fromRows',
      key: 'concept_id',
      rows: {
        kind: 'reachability',
        relation: {
          key: 'property:PART_OF',
          property: 'PART_OF',
          operators: ['descendent-of', 'is-a'],
          storage: 'conceptLink',
          edgeSetId: 7,
          includeSelfForIsA: true,
          label: 'Hierarchy property PART_OF',
        },
        seed: {
          kind: 'explicitCodes',
          codes: ['ROOT'],
        },
        direction: 'down',
        includeSelf: true,
        minDepth: 0,
        maxDepth: null,
      },
    });
  });

  test('fails explicitly when regex is requested for a link-only property', () => {
    const lowered = lowerFilterClauseToSetPlan({
      property: 'CATEGORY',
      op: 'regex',
      value: 'root',
      meta: { path: 'ValueSet.compose.include[0].filter[0]' },
    }, propertyDefs, runtime);

    expect(lowered.ok).toBe(false);
    expect(lowered.reason).toBe('regex-requires-literal-source');
    expect(lowered.meta?.path).toBe('ValueSet.compose.include[0].filter[0]');
  });

  test('fails explicitly for unknown properties', () => {
    const lowered = lowerFilterClauseToSetPlan({
      property: 'UNKNOWN',
      op: '=',
      value: 'x',
    }, propertyDefs, runtime);

    expect(lowered.ok).toBe(false);
    expect(lowered.reason).toBe('unknown-property');
  });

  test('support analysis is derived from the same lowering rules', () => {
    const supported = analyzeFilterClauseSupport({
      property: 'CLASS',
      op: '=',
      value: 'CHEM',
    }, propertyDefs, runtime);
    const unsupported = analyzeFilterClauseSupport({
      property: 'CATEGORY',
      op: 'regex',
      value: 'root',
    }, propertyDefs, runtime);

    expect(supported).toEqual({
      supported: true,
      reason: null,
      detail: null,
      meta: null,
    });
    expect(unsupported.supported).toBe(false);
    expect(unsupported.reason).toBe('regex-requires-literal-source');
  });
});
