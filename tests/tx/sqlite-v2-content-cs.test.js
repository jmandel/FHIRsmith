// Package CodeSystems as sqlite-v2 blocks: the stored provider answers as main's in-memory one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodeSystem } = require('../../tx/library/codesystem');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const { OperationContext } = require('../../tx/operation-context');
const { Languages } = require('../../library/languages');
const { createContentFile } = require('../../tx/importers/content-v2/content-file');
const { writeCodeSystemBlocks } = require('../../tx/importers/content-v2/cs-blocks');
const { loadStoredCodeSystems } = require('../../tx/sqlite-v2/content/content-file');
const { StoredFhirProvider } = require('../../tx/sqlite-v2/content/stored-cs-provider');
const { TestUtilities } = require('../test-utilities');

const nested = {
  resourceType: 'CodeSystem', id: 'nested', url: 'http://example.org/cs/nested', version: '1.0.0', status: 'active',
  content: 'complete', caseSensitive: true, hierarchyMeaning: 'is-a',
  property: [
    { code: 'status', uri: 'http://hl7.org/fhir/concept-properties#status', type: 'code' },
    { code: 'notSelectable', uri: 'http://hl7.org/fhir/concept-properties#notSelectable', type: 'boolean' },
    { code: 'colour', type: 'string' },
    { code: 'weight', type: 'integer' }
  ],
  concept: [
    { code: 'A', display: 'Alpha', property: [{ code: 'notSelectable', valueBoolean: true }, { code: 'colour', valueString: 'red' }],
      concept: [
        { code: 'A1', display: 'Alpha one', definition: 'first', property: [{ code: 'colour', valueString: 'blue' }, { code: 'weight', valueInteger: 3 }],
          designation: [{ language: 'fr', value: 'Alpha un' }] },
        { code: 'A2', display: 'Alpha two', property: [{ code: 'status', valueCode: 'retired' }],
          concept: [{ code: 'A2x', display: 'Alpha two x', extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/itemWeight', valueDecimal: 2.5 }] }] }
      ] },
    { code: 'B', display: 'Beta', property: [{ code: 'status', valueCode: 'deprecated' }] },
    { code: 'C', display: 'Gamma', concept: [] }
  ]
};
const flat = {
  resourceType: 'CodeSystem', id: 'flat', url: 'http://example.org/cs/flat', status: 'active', content: 'fragment',
  property: [{ code: 'parent', uri: 'http://hl7.org/fhir/concept-properties#parent', type: 'code' }],
  concept: [
    { code: 'x', display: 'Ex' },
    { code: 'y', display: 'Why', property: [{ code: 'parent', valueCode: 'x' }] },
    { code: 'z', display: 'Zed', property: [{ code: 'parent', valueCode: 'y' }, { code: 'parent', valueCode: 'x' }, { code: 'inactive', valueBoolean: true }] }
  ]
};
const supplement = {
  resourceType: 'CodeSystem', id: 'supp', url: 'http://example.org/cs/supp', status: 'active', content: 'supplement',
  supplements: 'http://example.org/cs/nested', concept: [{ code: 'A', designation: [{ language: 'de', value: 'Alfa' }] }]
};

describe('sqlite-v2 content: CodeSystem blocks', () => {
  let file, stored, mains, i18n;
  const op = () => new OperationContext(Languages.fromAcceptLanguage('en'), i18n);

  beforeAll(async () => {
    i18n = await TestUtilities.loadTranslations();
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v2cs-')), 'pkg.db');
    mains = [nested, flat, supplement].map((j) => new CodeSystem(JSON.parse(JSON.stringify(j))));
    const out = createContentFile(file);
    await writeCodeSystemBlocks(out.db, [nested, flat, supplement].map((j) => ({ cs: new CodeSystem(JSON.parse(JSON.stringify(j))) })));
    out.finish({});
    stored = loadStoredCodeSystems(file, { sourcePackage: 'test#1' });
  });

  test('blocks and supplements', () => {
    expect(stored.map((c) => c.constructor.name)).toEqual(['StoredCodeSystem', 'StoredCodeSystem', 'CodeSystem']);
    expect(stored[2].isSupplementFor('http://example.org/cs/nested', '1.0.0')).toBe(true);
    expect(stored[0].sourcePackage).toBe('test#1');
  });

  test('the resource round-trips, key order included', () => {
    for (let i = 0; i < 3; i++) expect(JSON.stringify(stored[i].jsonObj)).toBe(JSON.stringify(mains[i].jsonObj));
  });

  test('tree methods answer as main', () => {
    for (let i = 0; i < 2; i++) {
      const m = mains[i], s = stored[i];
      expect(s.getAllCodes()).toEqual(m.getAllCodes());
      expect(s.getRootConcepts()).toEqual(m.getRootConcepts());
      expect(s.getLeafConcepts()).toEqual(m.getLeafConcepts());
      expect(s.hasHierarchy()).toBe(m.hasHierarchy());
      expect(s.hasMultiHierarchy).toBe(m.hasMultiHierarchy);
      for (const c of m.getAllCodes()) {
        expect(s.getChildren(c)).toEqual(m.getChildren(c));
        expect(s.getParents(c)).toEqual(m.getParents(c));
        expect(s.getAncestors(c)).toEqual(m.getAncestors(c));
        expect(s.getDescendants(c)).toEqual(m.getDescendants(c));
      }
    }
  });

  test('per-concept answers as main', async () => {
    for (let i = 0; i < 2; i++) {
      const mp = new FhirCodeSystemProvider(op(), mains[i], []), sp = new StoredFhirProvider(op(), stored[i], []);
      for (const c of mains[i].getAllCodes()) {
        const a = (await mp.locate(c)).context, b = (await sp.locate(c)).context;
        for (const f of ['display', 'definition', 'isAbstract', 'isInactive', 'isDeprecated', 'getStatus', 'itemWeight', 'extensions', 'properties', 'parent']) {
          expect([f, c, await sp[f](b)]).toEqual([f, c, await mp[f](a)]);
        }
      }
      expect(await sp.subsumesTest(mains[i].getAllCodes()[0], mains[i].getAllCodes()[2])).toBe(await mp.subsumesTest(mains[i].getAllCodes()[0], mains[i].getAllCodes()[2]));
    }
  });

  const run = async (p, prop, o, v) => {
    const prep = await p.getPrepContext(true);
    try {
      const set = await p.filter(prep, true, prop, o, v);
      const codes = [];
      while (await p.filterMore(prep, set)) codes.push((await p.filterConcept(prep, set)).code);
      return { size: await p.filterSize(prep, set), codes };
    } catch (e) { return { err: e.msgId || e.message }; }
  };

  test.each([
    ['concept', 'is-a', 'A'], ['concept', 'descendent-of', 'A'], ['concept', 'child-of', 'A'], ['concept', 'is-not-a', 'A2'],
    ['concept', 'in', 'B,A,B,nope'], ['concept', '=', 'A2x'], ['concept', 'regex', 'A.*'], ['concept', 'regex', '['],
    ['child', 'exists', 'true'], ['child', 'exists', 'false'], ['colour', '=', 'blue'], ['colour', 'in', 'red,blue'],
    ['colour', 'not-in', 'red'], ['colour', 'regex', 'b.*'], ['weight', '=', '3'], ['notSelectable', '=', 'true'],
    ['status', '=', 'retired'], ['status', 'in', 'retired,deprecated'], ['inactive', '=', 'true'], ['deprecated', '=', 'true'],
    ['deprecated', '=', 'false'], ['nope', '=', 'x'], ['concept', 'generalizes', 'A']
  ])('filter %s %s %s on the nested system', async (prop, o, v) => {
    const mp = new FhirCodeSystemProvider(op(), mains[0], []), sp = new StoredFhirProvider(op(), stored[0], []);
    expect(await run(sp, prop, o, v)).toEqual(await run(mp, prop, o, v));
  });

  test.each([['concept', 'is-a', 'x'], ['concept', 'child-of', 'x'], ['inactive', '=', 'true'], ['parent', '=', 'x']])(
    'filter %s %s %s on the property hierarchy', async (prop, o, v) => {
      const mp = new FhirCodeSystemProvider(op(), mains[1], []), sp = new StoredFhirProvider(op(), stored[1], []);
      expect(await run(sp, prop, o, v)).toEqual(await run(mp, prop, o, v));
    });

  test('text search ranks as main', async () => {
    const mp = new FhirCodeSystemProvider(op(), mains[0], []), sp = new StoredFhirProvider(op(), stored[0], []);
    for (const w of ['alpha', 'alpha t', 'a', 'un']) {
      const go = async (p) => { const prep = await p.getPrepContext(true); const set = await p.searchFilter(prep, { filter: w }, true); const o = []; while (await p.filterMore(prep, set)) o.push((await p.filterConcept(prep, set)).code); return o; };
      expect(await go(sp)).toEqual(await go(mp));
    }
  });
});
