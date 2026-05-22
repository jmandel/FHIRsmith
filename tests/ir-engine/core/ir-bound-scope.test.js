const { CodeSystem } = require('../../../tx/library/codesystem');
const { bindIRScope } = require('../../../tx/engine/ir-bound-scope');

function makeSupplement(concepts) {
  return new CodeSystem({
    resourceType: 'CodeSystem',
    url: 'http://example.org/supp',
    version: '1.0',
    status: 'active',
    content: 'supplement',
    supplements: 'http://example.org/base',
    concept: concepts,
  });
}

describe('IR bound scope binder', () => {
  test('reports native-complete coverage and avoids overlay re-decoration when native binding is complete', async () => {
    const supplement = makeSupplement([
      { code: 'A', property: [{ code: 'rank', valueInteger: 1 }] },
    ]);
    const provider = {
      _irAllSupplementsNativeBound: false,
      system() { return 'http://example.org/base'; },
      version() { return '1'; },
      async attachIRSupplements() {
        this._irAllSupplementsNativeBound = true;
        return this;
      },
      propertyDefinitions() {
        return [{ code: 'rank', type: 'integer' }];
      },
      bulkProperties() {
        return new Map([[1, [{ code: 'rank', valueInteger: 1 }]]]);
      },
      bulkExtensions() { return new Map(); },
      executeIR: async () => ({ candidates: [] }),
      membershipForIR: async () => ({ has: () => false }),
      countForIR: async () => 0,
    };

    const bound = await bindIRScope(provider, {
      items: [{
        descriptor: { canonical: 'http://example.org/supp|1.0' },
        overlaySource: supplement,
      }],
    });

    expect(bound.nativeCoverage()).toBe('native-complete');
    expect(bound.usedSupplements()).toEqual(['http://example.org/supp|1.0']);

    const candidates = [{ code: 'A', conceptId: 1 }];
    await bound.decorateCandidates(candidates, { properties: ['rank'] });

    expect(candidates[0]._properties).toEqual([{
      code: 'rank',
      valueInteger: 1,
      definition: { type: 'integer' },
    }]);
  });

  test('reports overlay-complete coverage when supplements require generic overlay handling', async () => {
    const supplement = makeSupplement([
      { code: 'A', property: [{ code: 'rank', valueInteger: 1 }] },
    ]);
    const provider = {
      system() { return 'http://example.org/base'; },
      version() { return '1'; },
      async properties() { return []; },
      executeIR: async () => ({ candidates: [] }),
      membershipForIR: async () => ({ has: () => false }),
      countForIR: async () => 0,
    };

    const bound = await bindIRScope(provider, {
      items: [{
        descriptor: { canonical: 'http://example.org/supp|1.0' },
        overlaySource: supplement,
      }],
    });

    expect(bound.nativeCoverage()).toBe('overlay-complete');
    expect(bound.execution).not.toBe(provider);
  });
});
