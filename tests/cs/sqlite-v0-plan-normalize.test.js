'use strict';

const Types = require('../../tx/cs/sqlite-v0-plan-types');
const {
  normalizeMembershipPlan,
  membershipPlanStructuralForm,
  membershipPlanHash,
} = require('../../tx/cs/sqlite-v0-plan-normalize');
const { interpretMembershipPlan, conceptIdsToCodes } = require('../../tx/cs/sqlite-v0-plan-interpret');

function makeFixture() {
  return {
    concepts: [
      { concept_id: 1, code: 'A', display: 'Alpha', active: 1 },
      { concept_id: 2, code: 'B', display: 'Beta', active: 1 },
      { concept_id: 3, code: 'C', display: 'Dormant Alpha', active: 0 },
      { concept_id: 4, code: 'D', display: 'Delta', active: 1 },
    ],
    literals: [
      { source_concept_id: 1, property: 'CLASS', value_text: 'CHEM', active: 1 },
      { source_concept_id: 2, property: 'CLASS', value_text: 'DIAG', active: 1 },
      { source_concept_id: 3, property: 'CLASS', value_text: 'CHEM', active: 1 },
      { source_concept_id: 4, property: 'CLASS', value_text: 'CHEM', active: 1 },
    ],
    designations: [
      { concept_id: 2, value_text: 'Sugar beta', active: 1 },
    ],
    closure: [
      { ancestor_id: 1, descendant_id: 1 },
      { ancestor_id: 2, descendant_id: 2 },
      { ancestor_id: 3, descendant_id: 3 },
      { ancestor_id: 4, descendant_id: 4 },
    ],
  };
}

function classMatch(values) {
  return Types.fromRows({
    rows: Types.rowFilter({
      input: Types.rowScan({ table: 'concept_literal' }),
      predicate: { kind: 'literalPropertyMatch', property: 'CLASS', values },
    }),
    key: 'source_concept_id',
  });
}

describe('sqlite-v0 logical plan normalization', () => {
  const fixture = makeFixture();

  test('normalizes union structure into deterministic merged form', () => {
    const rawA = Types.setUnion({
      items: [
        classMatch(['DIAG']),
        Types.explicitCodes({ codes: ['B'] }),
        Types.setUnion({
          items: [
            Types.explicitCodes({ codes: ['A'] }),
            classMatch(['CHEM']),
            classMatch(['DIAG']),
          ],
        }),
        Types.explicitCodes({ codes: ['A'] }),
      ],
      meta: { path: 'raw-a' },
    });

    const rawB = Types.setUnion({
      items: [
        Types.explicitCodes({ codes: ['A'] }),
        classMatch(['CHEM']),
        Types.setUnion({
          items: [
            classMatch(['DIAG']),
            Types.explicitCodes({ codes: ['B'] }),
          ],
        }),
      ],
      meta: { path: 'raw-b' },
    });

    const normA = normalizeMembershipPlan(rawA);
    const normB = normalizeMembershipPlan(rawB);

    expect(membershipPlanStructuralForm(normA)).toEqual(membershipPlanStructuralForm(normB));
    expect(membershipPlanHash(rawA)).toBe(membershipPlanHash(rawB));
    expect(normA.meta?.path).toBe('raw-a');
    expect(normB.meta?.path).toBe('raw-b');
    expect(membershipPlanStructuralForm(normA)).toEqual({
      kind: 'union',
      items: [
        { kind: 'explicitCodes', codes: ['A', 'B'] },
        {
          kind: 'fromRows',
          key: 'source_concept_id',
          rows: {
            kind: 'filter',
            input: { kind: 'scan', table: 'concept_literal', as: null },
            predicate: { kind: 'literalPropertyMatch', property: 'CLASS', values: ['CHEM'] },
          },
        },
        {
          kind: 'fromRows',
          key: 'source_concept_id',
          rows: {
            kind: 'filter',
            input: { kind: 'scan', table: 'concept_literal', as: null },
            predicate: { kind: 'literalPropertyMatch', property: 'CLASS', values: ['DIAG'] },
          },
        },
      ],
    });
  });

  test('normalizes intersection by merging explicit codes and dropping all-concepts', () => {
    const raw = Types.setIntersect({
      items: [
        Types.allConcepts(),
        Types.explicitCodes({ codes: ['A', 'B'] }),
        Types.explicitCodes({ codes: ['B', 'C'] }),
      ],
    });

    const normalized = normalizeMembershipPlan(raw);
    expect(membershipPlanStructuralForm(normalized)).toEqual({
      kind: 'explicitCodes',
      codes: ['B'],
    });
  });

  test('simplifies diff of equal branches to empty', () => {
    expect(membershipPlanStructuralForm(normalizeMembershipPlan(Types.setDiff({
      left: Types.explicitCodes({ codes: ['A', 'B'] }),
      right: Types.explicitCodes({ codes: ['B', 'A'] }),
    })))).toEqual({ kind: 'empty' });
  });

  test('normalization preserves interpreter semantics on synthetic fixtures', () => {
    const raw = Types.setUnion({
      items: [
        Types.setIntersect({
          items: [
            Types.allConcepts(),
            classMatch(['CHEM']),
          ],
        }),
        Types.setDiff({
          left: Types.setUnion({
            items: [
              Types.explicitCodes({ codes: ['B'] }),
              Types.explicitCodes({ codes: ['B', 'A'] }),
              Types.emptySet(),
            ],
          }),
          right: Types.setIntersect({
            items: [
              Types.explicitCodes({ codes: ['A'] }),
              Types.explicitCodes({ codes: ['A', 'C'] }),
            ],
          }),
        }),
      ],
    });

    const normalized = normalizeMembershipPlan(raw);
    const rawCodes = conceptIdsToCodes(interpretMembershipPlan(raw, fixture), fixture);
    const normalizedCodes = conceptIdsToCodes(interpretMembershipPlan(normalized, fixture), fixture);

    expect(normalizedCodes).toEqual(rawCodes);
    expect(normalizedCodes).toEqual(['A', 'B', 'C', 'D']);
  });
});
