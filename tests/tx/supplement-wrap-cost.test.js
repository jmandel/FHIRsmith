/**
 * A large tx-resource supplement costs its parse and little else:
 * - one content digest per resource serves both the expansion cache key
 *   (CanonicalResource.expansionKeyHash, its first 16 characters) and the sqlite-v2
 *   supplement layer key (SupplementLayers.keyOf), and both keys are what they were;
 * - a supplement's maps are built on first use, codeMap / codeMapNC alone for a code
 *   lookup, and are then the maps an eager build makes.
 */

const crypto = require('crypto');
const { CanonicalResource } = require('../../tx/library/canonical-resource');
const { CodeSystem } = require('../../tx/library/codesystem');
const { SupplementLayers, contentHash } = require('../../tx/sqlite-v2/layers');

const supplement = (extra = {}) => ({
  resourceType: 'CodeSystem', url: 'http://example.org/sup', version: '1', status: 'active',
  content: 'supplement', supplements: 'http://loinc.org',
  concept: [
    { code: 'A', display: 'a', property: [{ code: 'parent', valueCode: 'C' }], concept: [{ code: 'B', display: 'b' }] },
    { code: 'b', display: 'second b' },
    { code: 'C', display: 'c' }
  ],
  ...extra
});

const entries = (m) => (m === undefined ? undefined : [...m]);
function sameMaps(cs, ref) {
  expect(entries(cs.codeMap)).toEqual(entries(ref.codeMap));
  expect(entries(cs.codeMapNC)).toEqual(entries(ref.codeMapNC));
  expect(entries(cs.displayMap)).toEqual(entries(ref.displayMap));
  expect(entries(cs.parentToChildrenMap)).toEqual(entries(ref.parentToChildrenMap));
  expect(entries(cs.childToParentsMap)).toEqual(entries(ref.childToParentsMap));
  expect(cs.hasMultiHierarchy).toBe(ref.hasMultiHierarchy);
}

describe('one content digest per resource', () => {
  test('the expansion key hash is the digest\'s first 16 characters, computed once', () => {
    const cs = new CodeSystem(supplement());
    const sha = crypto.createHash('sha256').update(JSON.stringify(cs.jsonObj)).digest('hex');
    const spy = jest.spyOn(CanonicalResource, 'computeContentDigest');
    expect(cs.expansionKeyHash()).toBe(sha.substring(0, 16));
    expect(cs.contentDigest()).toBe(sha);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('the layer key is the one the raw JSON gives, from the wrapper\'s digest', () => {
    const cs = new CodeSystem(supplement());
    const layers = new SupplementLayers({ uid: 'base' });
    cs.expansionKeyHash();
    const spy = jest.spyOn(CanonicalResource, 'computeContentDigest');
    expect(layers.keyOf(cs.jsonObj, cs)).toBe(layers.keyOf(cs.jsonObj));
    expect(layers.keyOf(cs.jsonObj, cs)).toBe('base|http://example.org/sup|1|' + contentHash(cs.jsonObj));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('a recorded 16-character hash gets its digest computed when a layer needs it', () => {
    const cs = new CodeSystem(supplement());
    const known = CanonicalResource.computeExpansionKeyHash(cs.jsonObj);
    cs.setExpansionKeyHash(known);
    expect(cs.contentDigest()).toBe(contentHash(cs.jsonObj));
    expect(cs.expansionKeyHash()).toBe(known);
  });

  test('different content, or a replaced jsonObj, gets a different digest', () => {
    const a = new CodeSystem(supplement());
    const b = new CodeSystem(supplement({ version: '2' }));
    expect(a.contentDigest()).not.toBe(b.contentDigest());
    const before = a.contentDigest();
    a.jsonObj = { ...a.jsonObj, name: 'changed' };
    expect(a.contentDigest()).not.toBe(before);
    expect(a.expansionKeyHash()).toBe(a.contentDigest().substring(0, 16));
  });
});

describe('a supplement\'s maps are built on first use', () => {
  for (const [label, extra] of [['case-insensitive', {}], ['case-sensitive', { caseSensitive: true }]]) {
    describe(label, () => {
      const eager = () => new CodeSystem({ ...supplement(extra), content: 'complete' });

      test('a code lookup builds only the code map it reads', () => {
        const cs = new CodeSystem(supplement(extra));
        const ref = eager();
        expect(cs.getConceptByCode('B')).toEqual(ref.getConceptByCode('B'));
        expect(cs.getConceptByCode('b')).toEqual(ref.getConceptByCode('b'));
        expect(cs.hasCode('c')).toBe(ref.hasCode('c'));
        expect(cs._deferredMaps).not.toBeNull();
        sameMaps(cs, ref);
        expect(cs._deferredMaps).toBeNull();
      });

      test('a hierarchy read builds everything', () => {
        const cs = new CodeSystem(supplement(extra));
        const ref = eager();
        expect(cs.getChildren('C')).toEqual(ref.getChildren('C'));
        expect(cs._deferredMaps).toBeNull();
        sameMaps(cs, ref);
      });

      test('own keys are the same as an eagerly built resource\'s', () => {
        expect(Object.keys(new CodeSystem(supplement(extra)))).toEqual(Object.keys(eager()));
      });
    });
  }

  test('a subclass that sets its own maps (noMaps) is not deferred', () => {
    class OwnMaps extends CodeSystem {
      constructor(json) {
        super(json, 'R5', true);
        this.codeMap = new Map([['X', { code: 'X' }]]);
      }
    }
    const cs = new OwnMaps(supplement());
    expect(cs._deferredMaps).toBeUndefined();
    expect([...cs.codeMap.keys()]).toEqual(['X']);
  });
});
