'use strict';

const { buildIRFromValueSet } = require('../../tx/engine/build-ir');

describe('build-ir semantics', () => {
  test('systemless include with multiple valueSet refs compiles as intersection', () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/root',
      compose: {
        include: [
          {
            valueSet: [
              'http://example.org/vs/a',
              'http://example.org/vs/b',
            ],
          },
        ],
      },
    };

    const ir = buildIRFromValueSet(vs);
    expect(ir.kind).toBe('intersect');
    expect(ir.items).toHaveLength(2);
    expect(ir.items.every(i => i.kind === 'import')).toBe(true);
  });

  test('system-scoped include with imports remains leaf ∩ imports', () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/root',
      compose: {
        include: [
          {
            system: 'urn:sys:A',
            concept: [{ code: 'A-100' }],
            valueSet: [
              'http://example.org/vs/a',
              'http://example.org/vs/b',
            ],
          },
        ],
      },
    };

    const ir = buildIRFromValueSet(vs);
    expect(ir.kind).toBe('intersect');
    expect(ir.items).toHaveLength(3);
    expect(ir.items[0].kind).toBe('selector');
    expect(ir.items.slice(1).every(i => i.kind === 'import')).toBe(true);
  });
});
