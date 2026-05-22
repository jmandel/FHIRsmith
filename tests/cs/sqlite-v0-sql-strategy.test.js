'use strict';

const Types = require('../../tx/cs/sqlite-v0-plan-types');
const { __testing } = require('../../tx/cs/sqlite-v0-sql-ast');

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

function scope() {
  return { csId: 1, system: 'urn:sys:A', version: null };
}

function reachabilitySet(code, includeSelf = true) {
  return Types.fromRows({
    scope: scope(),
    rows: Types.rowReachability({
      relation: conceptDescriptor(),
      seed: Types.explicitCodes({ scope: scope(), codes: [code] }),
      direction: 'down',
      includeSelf,
    }),
  });
}

function materializeNode(members, extra = {}) {
  return Types.materializeConcepts({
    members,
    scope: scope(),
    columns: ['concept_id', 'code', 'display'],
    count: 10,
    ...extra,
  });
}

function countNode(members, extra = {}) {
  return Types.countMembers({
    members,
    scope: scope(),
    ...extra,
  });
}

describe('sqlite-v0 terminal strategy selection', () => {
  test('chooses code-regex materialize for anchored concept-code filters', () => {
    const node = materializeNode(Types.fromRows({
      scope: scope(),
      rows: Types.rowFilter({
        input: Types.rowScan({ table: 'concept', scope: scope() }),
        predicate: { kind: 'codeRegex', pattern: '^7[0-9]{4,}' },
      }),
    }));

    expect(__testing.chooseTerminalLoweringStrategy(node, { scope: scope() }))
      .toBe('code-regex-materialize');
  });

  test('keeps reachability-diff materialize strategy stable across row wrappers', () => {
    const direct = materializeNode(Types.setDiff({
      scope: scope(),
      left: reachabilitySet('404684003'),
      right: reachabilitySet('73211009'),
    }));
    const wrapped = materializeNode(Types.fromRows({
      scope: scope(),
      rows: Types.rowDistinct({
        keys: ['concept_id'],
        input: Types.rowAntiJoin({
          left: reachabilitySet('404684003').rows,
          right: reachabilitySet('73211009').rows,
          on: { kind: 'eq', leftField: 'concept_id', rightField: 'concept_id' },
        }),
      }),
    }));

    expect(__testing.chooseTerminalLoweringStrategy(direct, { scope: scope() }))
      .toBe('reachability-diff-materialize');
    expect(__testing.chooseTerminalLoweringStrategy(wrapped, { scope: scope() }))
      .toBe('reachability-diff-materialize');
  });

  test('chooses supplement-literal materialize only for supplement-only literal properties', () => {
    const node = materializeNode(Types.fromRows({
      scope: scope(),
      key: 'source_concept_id',
      rows: Types.rowFilter({
        input: Types.rowScan({ table: 'concept_literal', scope: scope() }),
        predicate: { kind: 'literalPropertyMatch', property: 'd20-roll', values: ['20'] },
      }),
    }));

    expect(__testing.chooseTerminalLoweringStrategy(node, {
      scope: scope(),
      propertyDefs: new Map([
        ['d20-roll', { property_id: null, value_kind: 'literal', source_type: 'integer' }],
      ]),
      supplementBindings: [
        {
          alias: 'supp_d20',
          propertyDefs: [
            {
              property_code: 'd20-roll',
              value_kind: 'literal',
              source_type: 'integer',
            },
          ],
        },
      ],
    })).toBe('supplement-literal-materialize');
  });

  test('chooses concept-driven count for bounded membership plus runtime text', () => {
    const node = countNode(
      Types.explicitCodes({ scope: scope(), codes: ['A-100', 'A-110', 'A-120'] }),
      { selection: { text: 'alpha' } }
    );

    expect(__testing.chooseTerminalLoweringStrategy(node, {
      scope: scope(),
      runtime: {
        search: {
          sources: ['display', 'designation'],
          activeOnly: true,
        },
      },
    })).toBe('concept-driven-count');
  });
});
