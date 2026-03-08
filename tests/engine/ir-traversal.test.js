'use strict';

const IR = require('../../tx/engine/ir');
const { irChildren, walkIR, mapIR, mapIRAsync } = require('../../tx/engine/ir-traversal');

describe('IR traversal helpers', () => {
  test('irChildren yields children in stable structural order', () => {
    const tree = IR.diff(
      IR.union([
        IR.selector({ system: 'urn:sys:A', shape: 'whole' }),
        IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'A' }] }),
      ]),
      IR.importRef({ url: 'http://example.org/vs/x' })
    );
    tree.right.resolved = IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'B' }] });

    expect(irChildren(tree).map(n => n.kind)).toEqual(['union', 'import']);
    expect(irChildren(tree.left).map(n => n.kind)).toEqual(['selector', 'selector']);
    expect(irChildren(tree.right).map(n => n.kind)).toEqual(['selector']);
  });

  test('walkIR visits all nodes including resolved imports', () => {
    const tree = IR.union([
      IR.selector({ system: 'urn:sys:A', shape: 'whole' }),
      IR.importRef({ url: 'http://example.org/vs/x' }),
    ]);
    tree.items[1].resolved = IR.diff(
      IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'A' }] }),
      IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'B' }] })
    );

    const seen = [];
    walkIR(tree, node => seen.push(node.kind));
    expect(seen).toEqual(['union', 'selector', 'import', 'diff', 'selector', 'selector']);
  });

  test('mapIR rewrites structurally while preserving shape', () => {
    const tree = IR.union([
      IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'A' }] }),
      IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'B' }] }),
    ]);

    const mapped = mapIR(tree, node => {
      if (node.kind !== 'selector' || node.shape !== 'concept') return node;
      return {
        ...node,
        conceptCodes: (node.conceptCodes || []).map(cc => ({ ...cc, code: `${cc.code}1` })),
      };
    });

    expect(mapped.kind).toBe('union');
    expect(mapped.items[0].conceptCodes[0].code).toBe('A1');
    expect(mapped.items[1].conceptCodes[0].code).toBe('B1');
  });

  test('mapIRAsync supports async selector rebinding', async () => {
    const tree = IR.union([
      IR.selector({ system: 'urn:sys:A', shape: 'whole', lockedDate: '2025-01-01' }),
      IR.selector({ system: 'urn:sys:A', shape: 'whole' }),
    ]);

    const mapped = await mapIRAsync(tree, async node => {
      if (node.kind !== 'selector' || !node.lockedDate) return node;
      return { ...node, version: '2025', lockedDate: null };
    });

    expect(mapped.items[0].version).toBe('2025');
    expect(mapped.items[0].lockedDate).toBeNull();
    expect(mapped.items[1].version).toBeNull();
  });
});
