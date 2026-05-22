'use strict';

const { buildIRFromValueSet } = require('../../tx/engine/build-ir');
const { resolveImports } = require('../../tx/engine/resolve-imports');

describe('resolve-imports depth accounting', () => {
  test('maxDepth counts import edges (not double increments)', async () => {
    const root = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/root',
      compose: { include: [{ valueSet: ['http://example.org/vs/one'] }] },
    };
    const one = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/one',
      compose: { include: [{ valueSet: ['http://example.org/vs/two'] }] },
    };
    const two = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/two',
      compose: { include: [{ system: 'urn:sys:A', concept: [{ code: 'A-100' }] }] },
    };

    const byUrl = new Map([
      [root.url, root],
      [one.url, one],
      [two.url, two],
    ]);

    const ir = buildIRFromValueSet(root);

    await expect(
      resolveImports(ir, async (url) => byUrl.get(url) || null, { maxDepth: 2 })
    ).resolves.toBeTruthy();
  });
});
