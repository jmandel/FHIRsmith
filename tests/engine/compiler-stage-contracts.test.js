'use strict';

const { buildIRFromValueSet } = require('../../tx/engine/build-ir');
const { resolveImports } = require('../../tx/engine/resolve-imports');
const { optimize, projectToSystem, analyzeProjectedSubtree } = require('../../tx/engine/rewrite');

describe('engine compiler stage contracts', () => {
  test('resolved and projected IR preserves semantic metadata paths and used import tracking', async () => {
    const imported = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/imported',
      version: '1',
      compose: {
        include: [{
          system: 'urn:sys:A',
          filter: [{ property: 'kind', op: '=', value: 'lab' }],
        }],
      },
    };
    const root = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/root',
      compose: {
        include: [{
          system: 'urn:sys:A',
          valueSet: [imported.url],
        }],
      },
    };

    const raw = buildIRFromValueSet(root);
    const resolved = await resolveImports(raw, async url => (url === imported.url ? imported : null));
    const optimized = optimize(resolved);
    const projected = projectToSystem(optimized, 'urn:sys:A', null);

    expect([...resolved._usedValueSets]).toEqual(['http://example.org/vs/imported|1']);
    expect(projected.meta).toEqual(expect.objectContaining({ path: 'ValueSet.compose.include[0]' }));
    expect(JSON.stringify(projected)).toContain('ValueSet.compose.include[0]');
    expect(JSON.stringify(projected)).toContain('ValueSet.compose.include[0].filter[0]');
  });

  test('import-cycle and projection-leak failures remain explicit', async () => {
    const a = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/a',
      compose: { include: [{ valueSet: ['http://example.org/vs/b'] }] },
    };
    const b = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/b',
      compose: { include: [{ valueSet: ['http://example.org/vs/a'] }] },
    };
    await expect(
      resolveImports(buildIRFromValueSet(a), async url => (url === a.url ? a : (url === b.url ? b : null)))
    ).rejects.toThrow(/cycle detected/);

    const leaking = optimize(buildIRFromValueSet({
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/leaking',
      compose: {
        include: [
          { system: 'urn:sys:A', concept: [{ code: 'A' }] },
          { system: 'urn:sys:B', concept: [{ code: 'B' }] },
        ],
      },
    }));
    const projected = projectToSystem(leaking, 'urn:sys:A', null);
    expect(analyzeProjectedSubtree(projected, 'urn:sys:A', null).ok).toBe(true);
    expect(analyzeProjectedSubtree(leaking, 'urn:sys:A', null).ok).toBe(false);
  });
});
