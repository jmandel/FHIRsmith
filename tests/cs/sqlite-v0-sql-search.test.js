'use strict';

const {
  inferSearchStrategy,
  runtimeSearchNode,
  __testing,
} = require('../../tx/cs/sqlite-v0-sql-search');

function scope() {
  return { csId: 1, system: 'http://loinc.org', version: '2.81' };
}

describe('sqlite-v0 runtime search helpers', () => {
  test('runtimeSearchNode defaults to display + designation sources', () => {
    const node = runtimeSearchNode('creatinine', { runtime: {} }, scope());

    expect(node).toMatchObject({
      kind: 'row-search',
      text: 'creatinine',
      scope: scope(),
      spec: {
        sources: ['display', 'designation'],
        activeOnlyConcepts: true,
        designationActiveOnly: true,
        literalActiveOnly: true,
      },
      ftsTables: {
        display: 'search_fts_display',
        designation: 'search_fts_designation',
        literal: 'search_fts_literal',
      },
    });
  });

  test('inferSearchStrategy uses display-like when no sources are configured', () => {
    expect(inferSearchStrategy({
      spec: { sources: [] },
    }, {})).toBe('display-like');
  });

  test('inferSearchStrategy distinguishes default and named fts table shapes', () => {
    const node = {
      spec: { sources: ['display', 'designation'] },
    };

    expect(inferSearchStrategy(node, {
      search: {
        ftsTables: {},
      },
    })).toBe('fts-union-default-tables');

    expect(inferSearchStrategy(node, {
      search: {
        ftsTables: {
          display: 'loinc_display_fts',
        },
      },
    })).toBe('fts-union');
  });

  test('search helper quoting keeps fts match text exact', () => {
    expect(__testing.toFtsMatchText('A "quoted" term')).toBe('"A ""quoted"" term"');
  });
});
