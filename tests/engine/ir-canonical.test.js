'use strict';

const IR = require('../../tx/engine/ir');
const { canonicalizeIR, canonicalIRHash } = require('../../tx/engine/rewrite');

function conceptSelector(system, code, extra = {}) {
  return IR.selector({
    system,
    shape: 'concept',
    conceptCodes: [{ code }],
    ...extra,
  });
}

describe('canonical IR utilities', () => {
  test('canonical hash ignores union branch order and nested flattening shape', () => {
    const a = conceptSelector('sys:A', 'A');
    const b = conceptSelector('sys:B', 'B');

    const expr1 = IR.union([b, IR.union([a])]);
    const expr2 = IR.union([a, b]);

    expect(canonicalIRHash(expr1)).toBe(canonicalIRHash(expr2));
  });

  test('canonicalization assigns stable node ids in canonical branch order', () => {
    const expr = IR.union([
      conceptSelector('sys:B', 'B'),
      conceptSelector('sys:A', 'A'),
    ]);

    const canonical = canonicalizeIR(expr);
    expect(canonical.kind).toBe('union');
    expect(canonical.nodeId).toBe('n');
    expect(canonical.items.map(i => i.system)).toEqual(['sys:A', 'sys:B']);
    expect(canonical.items.map(i => i.nodeId)).toEqual(['n.0', 'n.1']);
  });

  test('canonicalization sorts and deduplicates concept codes', () => {
    const expr = IR.selector({
      system: 'sys:A',
      shape: 'concept',
      conceptCodes: [
        { code: 'B', display: 'Bee' },
        { code: 'A', display: 'Aye' },
        { code: 'A', display: 'Aye' },
      ],
      meta: { path: 'ValueSet.compose.include[0]' },
    });

    const canonical = canonicalizeIR(expr, { optimizeExpr: false });
    expect(canonical.kind).toBe('selector');
    expect(canonical.conceptCodes.map(c => c.code)).toEqual(['A', 'B']);
  });

  test('canonicalization preserves metadata paths while hashing ignores them', () => {
    const expr1 = IR.union([
      IR.selector({
        system: 'sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'kind', op: '=', value: 'root', meta: { path: 'ValueSet.compose.include[0].filter[0]' } }],
        meta: { path: 'ValueSet.compose.include[0]' },
      }),
      IR.selector({
        system: 'sys:B',
        shape: 'concept',
        conceptCodes: [{ code: 'B' }],
        meta: { path: 'ValueSet.compose.include[1]' },
      }),
    ], { path: 'ValueSet.compose' });

    const expr2 = IR.union([
      IR.selector({
        system: 'sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'kind', op: '=', value: 'root', meta: { path: 'different.path.filter[0]' } }],
        meta: { path: 'different.path' },
      }),
      IR.selector({
        system: 'sys:B',
        shape: 'concept',
        conceptCodes: [{ code: 'B' }],
        meta: { path: 'different.path.include[1]' },
      }),
    ], { path: 'different.root' });

    const canonical = canonicalizeIR(expr1, { optimizeExpr: false });
    expect(canonical.meta.path).toBe('ValueSet.compose');
    expect(canonical.items[0].meta.path).toBe('ValueSet.compose.include[0]');
    expect(canonical.items[0].filterClauses[0].meta.path).toBe('ValueSet.compose.include[0].filter[0]');
    expect(canonicalIRHash(expr1, { optimizeExpr: false })).toBe(canonicalIRHash(expr2, { optimizeExpr: false }));
  });
});
