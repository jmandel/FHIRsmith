const { CodeSystem } = require('../../tx/library/codesystem');
const {
  addInlineCodeSystems,
  addRegisteredCodeSystems,
  buildSupplementRegistry,
  createSupplementRegistry,
} = require('../../tx/supplements/registry');
const { resolveSupplementsForBaseScope } = require('../../tx/supplements/resolver');
const { makeSupplementRef } = require('../../tx/supplements/types');

function makeSupplement({
  url,
  version = null,
  targetSystem,
  targetVersion = null,
  language = null,
  concepts = [{ code: 'A', designation: [{ language: 'en', value: 'Alpha' }] }],
}) {
  const json = {
    resourceType: 'CodeSystem',
    url,
    status: 'active',
    content: 'supplement',
    supplements: targetVersion ? `${targetSystem}|${targetVersion}` : targetSystem,
    concept: concepts,
  };
  if (version) json.version = version;
  if (language) json.language = language;
  return new CodeSystem(json);
}

describe('SupplementRegistry and SupplementResolver', () => {
  test('resolves inline supplement for matching unversioned base scope', async () => {
    const supplement = makeSupplement({
      url: 'http://example.org/supp-inline',
      targetSystem: 'http://example.org/base',
    });
    const registry = createSupplementRegistry();
    addInlineCodeSystems(registry, [supplement]);

    const result = await resolveSupplementsForBaseScope({
      target: { system: 'http://example.org/base', version: null },
      refs: [makeSupplementRef(supplement.url, 'useSupplement', 0)],
      registry,
    });

    expect(result.unresolvedRefs).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].descriptor.sourceKind).toBe('inline');
    expect(result.items[0].overlaySource).toBe(supplement);
  });

  test('normalizes raw inline CodeSystem JSON resources before supplement resolution', async () => {
    const supplement = makeSupplement({
      url: 'http://example.org/supp-inline-raw',
      targetSystem: 'http://example.org/base',
    });
    const registry = createSupplementRegistry();
    addInlineCodeSystems(registry, [supplement.jsonObj]);

    const result = await resolveSupplementsForBaseScope({
      target: { system: 'http://example.org/base', version: null },
      refs: [makeSupplementRef(supplement.url, 'useSupplement', 0)],
      registry,
    });

    expect(result.unresolvedRefs).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].descriptor.sourceKind).toBe('inline');
    expect(result.items[0].overlaySource).toBeInstanceOf(CodeSystem);
    expect(result.items[0].overlaySource.url).toBe(supplement.url);
  });

  test('prefers inline supplement over registered supplement for the same canonical', async () => {
    const inline = makeSupplement({
      url: 'http://example.org/supp-shared',
      version: '1.0',
      targetSystem: 'http://example.org/base',
      concepts: [{ code: 'A', designation: [{ language: 'en', value: 'Inline Alpha' }] }],
    });
    const registered = makeSupplement({
      url: 'http://example.org/supp-shared',
      version: '1.0',
      targetSystem: 'http://example.org/base',
      concepts: [{ code: 'A', designation: [{ language: 'en', value: 'Registered Alpha' }] }],
    });

    const registry = createSupplementRegistry();
    addRegisteredCodeSystems(registry, [registered]);
    addInlineCodeSystems(registry, [inline]);
    const result = await resolveSupplementsForBaseScope({
      target: { system: 'http://example.org/base', version: null },
      refs: [makeSupplementRef(inline.url, 'useSupplement', 0)],
      registry,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].overlaySource).toBe(inline);
  });

  test('resolves registered supplement without inline tx-resource', async () => {
    const supplement = makeSupplement({
      url: 'http://example.org/supp-registered',
      version: '1.0',
      targetSystem: 'http://example.org/base',
    });
    const registry = createSupplementRegistry();
    addRegisteredCodeSystems(registry, [supplement]);

    const result = await resolveSupplementsForBaseScope({
      target: { system: 'http://example.org/base', version: null },
      refs: [makeSupplementRef(supplement.url, 'useSupplement', 0)],
      registry,
    });

    expect(result.unresolvedRefs).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].descriptor.sourceKind).toBe('registered-codesystem');
    expect(result.items[0].descriptor.canonical).toBe('http://example.org/supp-registered|1.0');
  });

  test('requires exact concrete base version target match', async () => {
    const supplement = makeSupplement({
      url: 'http://example.org/supp-versioned',
      targetSystem: 'http://example.org/base',
      targetVersion: '2.0.0',
    });
    const registry = createSupplementRegistry();
    addRegisteredCodeSystems(registry, [supplement]);

    const result = await resolveSupplementsForBaseScope({
      target: { system: 'http://example.org/base', version: '1.0.0' },
      refs: [makeSupplementRef(supplement.url, 'useSupplement', 0)],
      registry,
    });

    expect(result.items).toHaveLength(0);
    expect(result.unresolvedRefs).toHaveLength(1);
    expect(result.unresolvedRefs[0].canonical).toBe(supplement.url);
  });

  test('accepts version-pinned supplement canonical', async () => {
    const supplement = makeSupplement({
      url: 'http://example.org/supp-pinned',
      version: '1.2.3',
      targetSystem: 'http://example.org/base',
    });
    const registry = createSupplementRegistry();
    addRegisteredCodeSystems(registry, [supplement]);

    const result = await resolveSupplementsForBaseScope({
      target: { system: 'http://example.org/base', version: null },
      refs: [makeSupplementRef(`${supplement.url}|1.2.3`, 'useSupplement', 0)],
      registry,
    });

    expect(result.unresolvedRefs).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].descriptor.canonical).toBe('http://example.org/supp-pinned|1.2.3');
  });

  test('treats multiple matching registered supplement versions as ambiguous for unversioned request', async () => {
    const s1 = makeSupplement({
      url: 'http://example.org/supp-ambiguous',
      version: '1.0',
      targetSystem: 'http://example.org/base',
    });
    const s2 = makeSupplement({
      url: 'http://example.org/supp-ambiguous',
      version: '2.0',
      targetSystem: 'http://example.org/base',
    });
    const registry = createSupplementRegistry();
    addRegisteredCodeSystems(registry, [s1, s2]);

    await expect(resolveSupplementsForBaseScope({
      target: { system: 'http://example.org/base', version: null },
      refs: [makeSupplementRef(s1.url, 'useSupplement', 0)],
      registry,
    })).rejects.toThrow("Ambiguous supplement 'http://example.org/supp-ambiguous'");
  });

  test('materializes factory-registered supplements through fillOutSupplement', async () => {
    const placeholder = makeSupplement({
      url: 'http://example.org/supp-factory',
      version: '1.0',
      targetSystem: 'http://example.org/base',
      concepts: [],
    });
    const factory = {
      registerSupplements: jest.fn().mockResolvedValue([placeholder]),
      fillOutSupplement: jest.fn(async (supplement) => {
        supplement.jsonObj.concept = [
          { code: 'A', designation: [{ language: 'en', value: 'Factory Alpha' }] },
        ];
      }),
    };

    const registry = await buildSupplementRegistry({ providerFactories: [factory] });
    const result = await resolveSupplementsForBaseScope({
      target: { system: 'http://example.org/base', version: null },
      refs: [makeSupplementRef('http://example.org/supp-factory|1.0', 'useSupplement', 0)],
      registry,
    });

    expect(factory.registerSupplements).toHaveBeenCalledTimes(1);
    expect(factory.fillOutSupplement).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].overlaySource.getConceptByCode('A')).toBeDefined();
  });
});
