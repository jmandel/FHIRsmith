// Value sets in a sqlite-v2 content file: ContentValueSetProvider answers as main's
// PackageValueSetProvider (same package), and ContentVsacDatabase keeps ValueSetDatabase's write
// interface for the VSAC sync.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PackageContentLoader } = require('../../library/package-manager');
const { PackageValueSetProvider } = require('../../tx/vs/vs-package');
const { importPackage } = require('../../tx/importers/content-v2/import-content-v2');
const { ContentValueSetProvider, STORED, EAGER_MAX } = require('../../tx/sqlite-v2/content/content-vs-provider');
const { ContentVsacDatabase } = require('../../tx/sqlite-v2/content/content-vsac');
const { storedList, hasConcepts } = require('../../tx/library/stored-concepts');
const ConceptUsageTracker = require('../../tx/usage-tracker');

const BIG = EAGER_MAX + 36;
const codes = (n, p) => Array.from({ length: n }, (_, i) => ({ code: `${p}${i}`, display: `${p} ${i}` }));
const vs = (id, url, version, compose, extra = {}) => ({ resourceType: 'ValueSet', id, url, version, status: 'active', name: id, title: 'T ' + id, compose, ...extra });
const U = 'http://example.org/vs/';
const resources = [
  vs('small', U + 'small', '1.0.0', { include: [{ system: 'http://loinc.org', concept: codes(3, 'L') }] },
    { identifier: [{ system: 'urn:ietf:rfc:3986', value: 'urn:oid:1.2.3' }], jurisdiction: [{ coding: [{ system: 'urn:iso:std:iso:3166', code: 'US' }] }] }),
  vs('small-110', U + 'small', '1.1.0', { include: [{ system: 'http://loinc.org', concept: codes(4, 'L') }] }),
  vs('small-102', U + 'small', '1.0.2', { include: [{ system: 'http://loinc.org', concept: codes(2, 'L') }] }),
  vs('big', U + 'big', '2', {
    include: [{ system: 'http://snomed.info/sct', version: 'http://snomed.info/sct/900000000000207008',
      concept: [...codes(BIG, 'S'), { code: 'S0', display: 'duplicate' }, { display: 'first display', code: 'X1', designation: [{ language: 'fr', value: 'x' }] }] }],
    exclude: [{ system: 'http://snomed.info/sct', concept: codes(BIG, 'E') }]
  }),
  vs('filter', U + 'filter', '3', { include: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }] }),
  vs('group', U + 'group', '4', { include: [{ valueSet: [U + 'small'] }, { valueSet: [U + 'big|2'] }, { valueSet: [U + 'filter', U + 'missing'] }] }),
  vs('noversion', U + 'noversion', undefined, { include: [{ system: 'http://loinc.org', concept: codes(1, 'N') }] }),
];

let dir, pkgDir, file, main, ours;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-content-vs-'));
  pkgDir = path.join(dir, 'example.vs#0.1.0');
  fs.mkdirSync(path.join(pkgDir, 'package'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package', 'package.json'), JSON.stringify({ name: 'example.vs', version: '0.1.0', fhirVersions: ['4.0.1'] }));
  const files = [];
  for (const r of resources) {
    const f = `ValueSet-${r.id}.json`;
    fs.writeFileSync(path.join(pkgDir, 'package', f), JSON.stringify(r));
    files.push({ filename: f, resourceType: 'ValueSet', id: r.id, url: r.url, version: r.version });
  }
  fs.writeFileSync(path.join(pkgDir, 'package', '.index.json'), JSON.stringify({ 'index-version': 2, files }));
  file = path.join(dir, 'example.db');
  await importPackage(pkgDir, file, () => {});
  const loader = new PackageContentLoader(pkgDir);
  await loader.initialize();
  main = new PackageValueSetProvider(loader);
  await main.initialize();
  main.assignIds('ex');
  ours = new ContentValueSetProvider(file, { kind: 'package', source: loader.id() });
  await ours.initialize();
  ours.assignIds('ex');
});

afterAll(async () => {
  await main.close();
  await ours.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// contentHash is left out: main's package database fills it in on the next open of the file, so a
// freshly built one has none in its first process (the content file always has it)
const ser = (v) => (v == null ? null : JSON.stringify({ json: v.jsonObj || v, id: v.id, src: v.sourcePackage, cached: !!v.isCached, n: v.conceptCount ? v.conceptCount() : null }));

describe('sqlite-v2 content: value sets', () => {
  test('every url, version form and id gives what main gives', async () => {
    const refs = [];
    for (const r of resources) {
      refs.push([r.url], [r.url, r.version], [r.url, '1.0'], [r.url, '9.9.9'], [r.url, 'nonsense']);
    }
    refs.push([U + 'missing']);
    for (const [u, v] of refs) {
      expect([u, v, ser(await ours.fetchValueSet(u, v))]).toEqual([u, v, ser(await main.fetchValueSet(u, v))]);
    }
    for (const r of resources) {
      expect(ser(await ours.fetchValueSetById('ex-' + r.id))).toEqual(ser(await main.fetchValueSetById('ex-' + r.id)));
      expect(await ours.fetchValueSetById(r.id)).toBeNull();
    }
  });

  test('searches give what main gives, in the same order', async () => {
    const searches = [
      [], [{ name: 'url', value: U + 'small' }], [{ name: 'version', value: '1.0' }], [{ name: 'title', value: 'T s' }],
      [{ name: 'system', value: 'http://loinc.org' }], [{ name: 'identifier', value: 'urn:oid:1.2.3' }],
      [{ name: 'jurisdiction', value: 'US' }], [{ name: 'status', value: 'active' }]
    ];
    for (const p of searches) {
      for (const el of [null, ['url', 'version']]) {
        // what the search worker keeps of each match (its JSON); a match of ours may be deferred,
        // and is built when the worker puts it on a page (SearchWorker.loadPage)
        const json = async (x) => JSON.stringify(x.load ? await x.load() : (x.jsonObj || x));
        const a = await Promise.all((await main.searchValueSets(p, el)).map(json));
        const b = await Promise.all((await ours.searchValueSets(p, el)).map(json));
        expect(b).toEqual(a);
      }
    }
    expect(await ours.listAllValueSets()).toEqual(await main.listAllValueSets());
  });

  test('a big list stays in its rows until read, and answers membership without being read', async () => {
    const v = await ours.fetchValueSet(U + 'big');
    const inc = v.jsonObj.compose.include[0];
    const h = storedList(inc);
    expect(h).not.toBeNull();
    expect(h.count).toBe(BIG + 2);
    expect(hasConcepts(inc)).toBe(true);
    expect(h.lookup('S0').map((c) => c.display)).toEqual(['S 0', 'duplicate']);
    expect(h.lookup('X1')).toEqual([{ display: 'first display', code: 'X1', designation: [{ language: 'fr', value: 'x' }] }]);
    expect(h.lookup('nope')).toEqual([]);
    expect(storedList(v.jsonObj.compose.exclude[0])).not.toBeNull();
    // reading it gives the list, and the key order of the include
    expect(Object.keys(inc)).toEqual(['system', 'version', 'concept']);
    expect(inc.concept.length).toBe(BIG + 2);
    // the handle stays (tx/library/stored-concepts.js): it answers from the list once read
    expect(storedList(inc)).not.toBeNull();
    expect(inc[STORED].lookup('S1')).toEqual([{ code: 'S1', display: 'S 1' }]);
  });

  test('a grouping value set read with a request context builds the same children', async () => {
    const opContext = {};
    const g = await ours.fetchValueSet(U + 'group', null, opContext);
    expect(ser(g)).toEqual(ser(await main.fetchValueSet(U + 'group')));
    for (const [u, v] of [[U + 'small'], [U + 'big', '2'], [U + 'filter'], [U + 'missing']]) {
      const a = ser(await main.fetchValueSet(u, v));
      expect(ser(await ours.fetchValueSet(u, v, opContext))).toEqual(a);
      expect(ser(await ours.fetchValueSet(u, v, opContext))).toEqual(a); // twice in one request
    }
  });

  test('the usage scan counts what main counts', async () => {
    const dump = (t) => JSON.stringify([...t.map].map(([s, m]) => [s, [...m].map(([c, x]) => [c, x.count]).sort()]).sort());
    const a = new ConceptUsageTracker();
    const b = new ConceptUsageTracker();
    const na = await a.scanValueSets({ valueSetProviders: [main] });
    const nb = await b.scanValueSets({ valueSetProviders: [ours] });
    expect(nb).toBe(na);
    expect(dump(b)).toBe(dump(a));
  });

  test('THO precedence: the url -> versions of the value sets served', async () => {
    // only an hl7.terminology package adds its value sets (AbstractValueSetProvider.thoVersions)
    expect(ours.thoVersions(new Map()).size).toBe(0);
    const tho = new ContentValueSetProvider(file, { kind: 'package', source: 'hl7.terminology#7.5.0' });
    await tho.initialize();
    const m = tho.thoVersions(new Map());
    expect([...m.get(U + 'small')].sort()).toEqual(['1.0.0', '1.0.2', '1.1.0']);
    expect(m.get(U + 'noversion').size).toBe(0);
  });
});

describe('sqlite-v2 content: VSAC write interface', () => {
  test('upsert, see, hash, delete, settings, runs and events', async () => {
    const f = path.join(dir, 'vsac.db');
    const d = new ContentVsacDatabase(f);
    expect(await d.exists()).toBe(false);
    await d.create();
    const run = await d.startRun();
    await d.upsertValueSet(resources[0], 'h1');
    await d.upsertValueSet(resources[3], 'h2');
    expect(d.vsCount).toBe(2);
    expect(await d.getVersion(U + 'small', '1.0.0')).toEqual({ id: 'small', content_hash: 'h1' });
    expect(await d.getVersion(U + 'small', '9')).toBeUndefined();
    expect(await d.listVersionKeys()).toEqual(new Set(resources.filter((r, i) => i === 0 || i === 3).map((r) => r.url + '|' + r.version)));
    expect(await d.countValueSets()).toEqual({ total: 2, urls: 2 });
    await d.upsertValueSet({ ...resources[0], title: 'changed' }, 'h3');
    expect(d.vsCount).toBe(2);
    expect((await d.getVersion(U + 'small', '1.0.0')).content_hash).toBe('h3');
    await d.setContentHash('small', 'h4');
    expect((await d.getVersion(U + 'small', '1.0.0')).content_hash).toBe('h4');
    await d.recordEvent('updated', U + 'small', '1.0.0');
    await d.setSetting('k', 'v');
    expect(await d.getSetting('k')).toBe('v');
    await d.deleteSetting('k');
    expect(await d.getSetting('k')).toBeNull();
    expect(await d.getGeneration()).toBe(0);
    await d.bumpGeneration();
    expect(await d.getGeneration()).toBe(1);
    expect((await d.getLastRun()).status).toBe('running');
    await d.finishRun(run, 2, 1, 1);
    expect((await d.getLastRun()).status).toBe('ok');
    expect(await d.markInterruptedRuns()).toBe(0);
    // a tx-worker (cluster.md) reads the master's file and never writes it
    const ro = new ContentVsacDatabase(f, { readOnly: true });
    expect(await ro.getGeneration()).toBe(1);
    expect((await ro.countValueSets()).total).toBe(2);
    await expect(ro.bumpGeneration()).rejects.toThrow(/a tx-worker does not write it/);
    await expect(ro.upsertValueSet(resources[0], 'hx')).rejects.toThrow(/a tx-worker does not write it/);
    await ro.close();
    const stats = await d.getStatistics();
    expect(stats.totalValueSets).toBe(2);
    // a reader on its own connection sees the rows, with the big list intact
    const r = new ContentValueSetProvider(f, { kind: 'vsac', source: 'vsac' });
    await r.initialize();
    r.assignIds('vsac');
    const big = await r.fetchValueSet(U + 'big', '1'); // VSAC: an unknown version falls back to the url
    expect(big.jsonObj.compose.include[0].concept.length).toBe(BIG + 2);
    expect(big.jsonObj.compose.include[0].version).toBeUndefined(); // stripped, as VSACValueSetProvider
    expect((await r.fetchValueSet(U + 'small')).jsonObj.title).toBe('changed');
    const n = await d.deleteOldValueSets(Math.floor(Date.now() / 1000) + 10);
    expect(n).toBe(2);
    expect(await r.fetchValueSet(U + 'small')).toBeNull();
    await r.close();
    await d.close();
  });
});
