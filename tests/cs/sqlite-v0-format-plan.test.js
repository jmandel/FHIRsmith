'use strict';

const IR = require('../../tx/engine/ir');
const { createSqliteV0Compiler } = require('../../tx/cs/sqlite-v0-compiler');
const {
  formatMembershipPlan,
  formatPhysicalPlan,
  formatTerminalPlan,
  formatSqlAst,
} = require('../../tx/cs/sqlite-v0-format-plan');

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
          PART_OF: {
            sources: ['link'],
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
}

function makePropertyDefs() {
  return new Map([
    ['CLASS', { property_id: 1, value_kind: 'literal' }],
    ['PART_OF', { property_id: 2, value_kind: 'concept', is_hierarchy: true }],
  ]);
}

describe('sqlite-v0 plan formatting', () => {
  test('formats logical, physical, and SQL AST artifacts', () => {
    const compiler = createSqliteV0Compiler({
      propertyDefs: makePropertyDefs(),
      runtime: makeRuntime(),
      scope: { system: 'urn:sys:A', version: null },
      includeDebugArtifacts: true,
    });

    const compiled = compiler.compileExpand(
      IR.diff(
        IR.union([
          IR.selector({
            system: 'urn:sys:A',
            shape: 'filter',
            filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
          }),
          IR.selector({
            system: 'urn:sys:A',
            shape: 'filter',
            filterClauses: [{ property: 'PART_OF', op: 'is-a', value: 'A-100' }],
          }),
        ]),
        IR.selector({
          system: 'urn:sys:A',
          shape: 'concept',
          conceptCodes: [{ code: 'A-110' }],
        })
      ),
      { activeOnly: true, text: 'alpha', count: 10 }
    );

    expect(formatMembershipPlan(compiled.logical)).toMatchSnapshot('logical');
    expect(formatTerminalPlan(compiled.terminal)).toMatchSnapshot('terminal');
    expect(formatPhysicalPlan(compiled.physical)).toMatchSnapshot('physical');
    expect(formatSqlAst(compiled.sqlAst)).toMatchSnapshot('sql-ast');
  });
});
