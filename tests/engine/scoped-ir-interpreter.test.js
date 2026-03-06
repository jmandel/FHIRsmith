'use strict';

const IR = require('../../tx/engine/ir');
const { interpretScopedIR } = require('../../tx/engine/scoped-ir-interpreter');

function evalTokens(node) {
  return new Set(node.meta?.evalTokens || []);
}

describe('scoped IR interpreter', () => {
  test('evaluates selector algebra over an abstract member domain', () => {
    const expr = IR.diff(
      IR.union([
        IR.selector({
          system: 'sys:A',
          shape: 'concept',
          conceptCodes: [{ code: 'a' }],
          meta: { evalTokens: ['A:1', 'A:2'] },
        }),
        IR.selector({
          system: 'sys:A',
          shape: 'filter',
          filterClauses: [{ property: 'kind', op: '=', value: 'root' }],
          meta: { evalTokens: ['A:2', 'A:3'] },
        }),
      ]),
      IR.intersect([
        IR.selector({
          system: 'sys:A',
          shape: 'whole',
          meta: { evalTokens: ['A:2', 'A:3', 'A:4'] },
        }),
        IR.selector({
          system: 'sys:A',
          shape: 'concept',
          conceptCodes: [{ code: 'a4' }],
          meta: { evalTokens: ['A:3'] },
        }),
      ]),
    );

    const out = interpretScopedIR(expr, { evaluateSelector: evalTokens });
    expect([...out].sort()).toEqual(['A:1', 'A:2']);
  });

  test('follows resolved imports transparently', () => {
    const expr = IR.union([
      IR.selector({
        system: 'sys:A',
        shape: 'concept',
        conceptCodes: [{ code: 'direct' }],
        meta: { evalTokens: ['A:1'] },
      }),
      {
        kind: 'import',
        url: 'http://example.org/imported',
        version: null,
        resolved: IR.selector({
          system: 'sys:A',
          shape: 'concept',
          conceptCodes: [{ code: 'imported' }],
          meta: { evalTokens: ['A:2'] },
        }),
      },
    ]);

    const out = interpretScopedIR(expr, { evaluateSelector: evalTokens });
    expect([...out].sort()).toEqual(['A:1', 'A:2']);
  });

  test('throws on unresolved imports unless caller supplies import semantics', () => {
    const expr = IR.importRef({ url: 'http://example.org/unresolved' });

    expect(() => interpretScopedIR(expr, { evaluateSelector: evalTokens }))
      .toThrow(/unresolved import/i);
  });

  test('can use caller-supplied import semantics when needed in tests', () => {
    const expr = IR.intersect([
      IR.selector({
        system: 'sys:A',
        shape: 'whole',
        meta: { evalTokens: ['A:1', 'A:2', 'A:3'] },
      }),
      IR.importRef({ url: 'http://example.org/subset' }),
    ]);

    const out = interpretScopedIR(expr, {
      evaluateSelector: evalTokens,
      evaluateImport(node) {
        if (node.url === 'http://example.org/subset') return ['A:2', 'A:3'];
        return [];
      },
    });

    expect([...out].sort()).toEqual(['A:2', 'A:3']);
  });
});
