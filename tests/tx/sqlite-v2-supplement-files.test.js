'use strict';

// Server-known supplements on disk (tx/sqlite-v2/supplement-files.js): the DiskSupplement read
// from its file answers exactly as main's in-memory CodeSystem, and requests through the router
// give the same responses whichever of the two the server holds.

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { V2Builder } = require('../../tx/importers/sqlite-v2/builder');
const { loadSqliteV2Factory } = require('../../tx/sqlite-v2');
const { CodeSystem } = require('../../tx/library/codesystem');
const { Languages, Language } = require('../../library/languages');
const sf = require('../../tx/sqlite-v2/supplement-files');
const { OperationContext } = require('../../tx/operation-context');
const { settings } = require('../../tx/sqlite-v2/settings');
const { FileContentLoader } = require('../../library/folder-content-loader');

const BASE = 'http://example.org/fhir/CodeSystem/v2-supp-base';
const SUPP_URL = 'http://example.org/fhir/CodeSystem/v2-supp-de';

// root ─┬─ A ─┬─ A1
//       │     ├─ A2 (inactive)
//       │     └─ A3
//       └─ B ─── B1
function buildBase(dest) {
  const b = new V2Builder(dest, { overwrite: true, importer: 'test' });
  b.setCodeSystem({ uri: BASE, version: '1' });
  const isa = b.property({ code: 'parent', fhirType: 'code', valueKind: 'concept', isHierarchy: true });
  const c = {};
  for (const code of ['root', 'A', 'A1', 'A2', 'A3', 'B', 'B1']) c[code] = b.concept(code, { active: code !== 'A2', display: `display ${code}` });
  for (const [ch, pa] of [['A', 'root'], ['B', 'root'], ['A1', 'A'], ['A2', 'A'], ['A3', 'A'], ['B1', 'B']]) b.link(c[ch], isa, c[pa]);
  b.finish();
}

const DISPLAY_USE = { system: 'http://terminology.hl7.org/CodeSystem/designation-usage', code: 'display' };
// displays, designations in several languages (with and without a use, one with none), declared and
// undeclared properties, a code the base lacks, a nested concept and a code listed twice
const SUPP = () => ({
  resourceType: 'CodeSystem', url: SUPP_URL, version: '1', status: 'active', content: 'supplement', supplements: BASE, language: 'de',
  property: [{ code: 'tier', type: 'string' }, { code: 'colour', type: 'code' }],
  concept: [
    { code: 'A1', display: 'Anzeige A1', designation: [{ language: 'fr', value: 'Affichage A1' }, { language: 'de-CH', use: DISPLAY_USE, value: 'Anzeige A1 (CH)' }],
      property: [{ code: 'tier', valueString: 'gold' }, { code: 'colour', valueCode: 'red' }] },
    { code: 'A3', designation: [{ language: 'fr', value: 'Affichage A3' }, { value: 'ohne Sprache A3' }], property: [{ code: 'tier', valueString: 'silver' }] },
    { code: 'B', display: 'Anzeige B', property: [{ code: 'tier', valueString: 'gold' }, { code: 'note', valueString: 'x' }],
      concept: [{ code: 'B1', display: 'Anzeige B1', property: [{ code: 'colour', valueCode: 'blue' }] }] },
    { code: 'ZZ', display: 'Anzeige ZZ (not in the base)', property: [{ code: 'tier', valueString: 'gold' }] },
    { code: 'A2', designation: [{ language: 'fr', value: 'Affichage A2' }], property: [{ code: 'tier', valueString: 'bronze' }] },
    { code: 'A1', display: 'Anzeige A1 zweite', property: [{ code: 'tier', valueString: 'gold' }] }
  ]
});

const json = (x) => JSON.stringify(x);

describe('sqlite-v2 supplement files', () => {
  let app, dir, factory, provider, mem, disk;

  beforeAll(async () => {
    app = await getTestApp();
    const tx = getTxModule();
    dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-suppfiles-'));
    buildBase(path.join(dir, 'base.db'));
    factory = await loadSqliteV2Factory(tx.i18n, path.join(dir, 'base.db'));
    provider = tx.endpoints[0].provider;
    provider.codeSystemFactories.set(factory.system(), factory);
    provider.codeSystemFactories.set(factory.system() + '|' + factory.version(), factory);
    mem = new CodeSystem(SUPP());
    // the library pass, on a library of one supplement
    const library = { codeSystemFactories: new Map([[BASE, factory]]), codeSystemProviders: [{ codeSystems: [new CodeSystem(SUPP())] }], cacheFolder: dir };
    const r = await sf.useSupplementFiles(library);
    expect(r).toMatchObject({ supplements: 1, files: 1, built: 1 });
    disk = library.codeSystemProviders[0].codeSystems[0];
    expect(disk).toBeInstanceOf(sf.DiskSupplement);
  }, 120000);

  afterAll(async () => {
    await shutdownTestApp();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the DiskSupplement answers as the in-memory CodeSystem', () => {
    expect(disk).toBeInstanceOf(CodeSystem);
    for (const code of ['A1', 'A2', 'A3', 'B', 'B1', 'ZZ', 'a1', 'nope']) {
      expect(json(disk.getConceptByCode(code))).toBe(json(mem.getConceptByCode(code)));
      expect(disk.hasCode(code)).toBe(mem.hasCode(code));
      expect(json(disk.codeMap.get(code))).toBe(json(mem.codeMap.get(code)));
    }
    expect(json(disk.getAllConcepts())).toBe(json(mem.getAllConcepts()));
    expect(disk.getAllCodes()).toEqual(mem.getAllCodes());
    expect(disk.conceptCount()).toBe(mem.conceptCount());
    expect(disk.codeMap.size).toBe(mem.codeMap.size);
    expect(json(disk.jsonObj)).toBe(json(mem.jsonObj));
    expect(json(disk.getConceptByDisplay('Anzeige B1'))).toBe(json(mem.getConceptByDisplay('Anzeige B1')));
    expect(disk.getChildren('B')).toEqual(mem.getChildren('B'));
    expect([disk.url, disk.vurl, disk.version, disk.isSupplementFor(BASE, '1'), disk.isGlobalSupplement()])
      .toEqual([mem.url, mem.vurl, mem.version, mem.isSupplementFor(BASE, '1'), mem.isGlobalSupplement()]);
  });

  test('a case-insensitive supplement finds codes as main does (the last of each lower-cased code)', async () => {
    const ci = { ...SUPP(), url: SUPP_URL + '-ci', caseSensitive: false };
    ci.concept.push({ code: 'b1', display: 'klein b1' });
    const m = new CodeSystem(JSON.parse(json(ci)));
    const library = { codeSystemFactories: new Map([[BASE, factory]]), codeSystemProviders: [{ codeSystems: [new CodeSystem(ci)] }], cacheFolder: dir };
    await sf.useSupplementFiles(library);
    const d = library.codeSystemProviders[0].codeSystems[0];
    for (const code of ['A1', 'a1', 'B1', 'b1', 'zz', 'nope']) {
      expect(json(d.getConceptByCode(code))).toBe(json(m.getConceptByCode(code)));
      expect(d.hasCode(code)).toBe(m.hasCode(code));
    }
  });

  test('upstream helpers that scan every concept: the same answers from the file facts', async () => {
    const tx = getTxModule();
    const ctx = (langs) => new OperationContext(Languages.fromAcceptLanguage(langs), tx.i18n);
    for (const langs of ['de', 'de-CH', 'fr', 'en', 'it', 'de-AT,fr']) {
      const a = await factory.build(ctx(langs), [mem]);
      const b = await factory.build(ctx(langs), [disk]);
      const l = Languages.fromAcceptLanguage(langs);
      expect(b._hasAnySupplementDisplays(l)).toBe(a._hasAnySupplementDisplays(l));
      for (const one of langs.split(',')) {
        expect(b._hasSupplementText(new Language(one))).toBe(a._hasSupplementText(new Language(one)));
        for (const text of ['anzeige', 'affichage', 'ohne', 'a1', 'zz']) {
          const filter = { passesAll: (t) => String(t).toLowerCase().includes(text) };
          expect([...b._supplementSearchCodes(filter, new Language(one))]).toEqual([...a._supplementSearchCodes(filter, new Language(one))]);
        }
      }
      // both kinds together, in either order
      const c = await factory.build(ctx(langs), [disk, new CodeSystem({ ...SUPP(), url: SUPP_URL + '-2' })]);
      const d = await factory.build(ctx(langs), [mem, new CodeSystem({ ...SUPP(), url: SUPP_URL + '-2' })]);
      expect(c._hasAnySupplementDisplays(l)).toBe(d._hasAnySupplementDisplays(l));
      await Promise.all([a, b, c, d].map((p) => p.close()));
    }
  });

  test('a rebuilt base, a changed supplement or a new format give a new file; the same inputs reuse it', async () => {
    const lib = (cs) => ({ codeSystemFactories: new Map([[BASE, factory]]), codeSystemProviders: [{ codeSystems: [cs] }], cacheFolder: dir });
    const again = await sf.useSupplementFiles(lib(new CodeSystem(SUPP())));
    expect(again).toMatchObject({ supplements: 1, built: 0 });
    const changed = SUPP();
    changed.concept[0].display = 'geändert';
    const l2 = lib(new CodeSystem(changed));
    expect(await sf.useSupplementFiles(l2)).toMatchObject({ supplements: 1, built: 1 });
    expect(l2.codeSystemProviders[0].codeSystems[0].getConceptByCode('A1').display).toBe('Anzeige A1 zweite');
    expect(l2.codeSystemProviders[0].codeSystems[0].getConceptByCode('B').display).toBe('Anzeige B');
    expect(sf.supplementFilePath(dir, changed, factory.store, 'h1')).not.toBe(sf.supplementFilePath(dir, changed, factory.store, 'h2'));
  });

  test('a tx-worker never builds a file: it waits for the master, and says so when none comes', async () => {
    const other = { ...SUPP(), version: '9' };
    const library = { codeSystemFactories: new Map([[BASE, factory]]), codeSystemProviders: [{ codeSystems: [new CodeSystem(other)] }], cacheFolder: dir };
    const saved = process.env.FHIRSMITH_CACHE_WAIT_MS;
    process.env.FHIRSMITH_CACHE_WAIT_MS = '600';
    try {
      await expect(sf.useSupplementFiles(library, { readOnly: true })).rejects.toThrow(/the master builds it/);
    } finally {
      if (saved === undefined) delete process.env.FHIRSMITH_CACHE_WAIT_MS; else process.env.FHIRSMITH_CACHE_WAIT_MS = saved;
    }
    expect(library.codeSystemProviders[0].codeSystems[0]).not.toBeInstanceOf(sf.DiskSupplement);
  });

  test('supplementFiles = false keeps server-known supplements in memory', async () => {
    const saved = settings.supplementFiles;
    settings.supplementFiles = false;
    try {
      const library = { codeSystemFactories: new Map([[BASE, factory]]), codeSystemProviders: [{ codeSystems: [new CodeSystem(SUPP())] }], cacheFolder: dir };
      expect((await sf.useSupplementFiles(library)).supplements).toBe(0);
      expect(library.codeSystemProviders[0].codeSystems[0]).not.toBeInstanceOf(sf.DiskSupplement);
    } finally {
      settings.supplementFiles = saved;
    }
  });

  // ---- folder:/file: sources: a supplement whose file the server has is not parsed at startup ----

  describe('a file: source', () => {
    let src, cache;
    beforeAll(() => {
      src = path.join(dir, 'src', 'supp.json');
      cache = path.join(dir, 'src-cache');
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, JSON.stringify(SUPP(), null, 1));
    });

    /** what the library does for a file: source, then its supplement pass; counts the parses of the source */
    async function startup(opts = {}) {
      const content = fs.readFileSync(src, 'utf8');
      const spy = jest.spyOn(JSON, 'parse');
      let loads = 0;
      try {
        const loader = new FileContentLoader(src, path.join(dir, 'src-loader'));
        loader.sourceIndex = sf.sourceIndex(cache);
        await loader.initialize();
        const [entry] = await loader.getResourcesByType('CodeSystem');
        const cs = await sf.codeSystemForEntry(entry, async () => { loads++; return new CodeSystem(await loader.loadFile(entry, loader.fhirVersion())); });
        cs.sourcePackage = loader.pid();
        const library = { codeSystemFactories: new Map([[BASE, opts.base || factory]]), codeSystemProviders: [{ codeSystems: [cs] }], cacheFolder: cache };
        const r = await sf.useSupplementFiles(library, opts);
        const parses = spy.mock.calls.filter(([a]) => a === content).length;
        return { r, cs: library.codeSystemProviders[0].codeSystems[0], loads, parses };
      } finally {
        spy.mockRestore();
      }
    }

    const sidecars = () => fs.readdirSync(path.join(cache, 'v2', 'supplements')).filter((n) => n.startsWith('source-'));

    test('first startup parses and builds; the next opens the file without parsing the source', async () => {
      const first = await startup();
      expect(first.r).toMatchObject({ supplements: 1, built: 1, unparsed: 0 });
      expect(first.parses).toBeGreaterThan(0);
      expect(sidecars()).toHaveLength(1);

      const next = await startup();
      expect(next.r).toMatchObject({ supplements: 1, built: 0, unparsed: 1 });
      expect([next.parses, next.loads]).toEqual([0, 0]);
      const d = next.cs;
      expect(d).toBeInstanceOf(sf.DiskSupplement);
      expect(d.sourcePackage).toBe(first.cs.sourcePackage);
      expect(json(d.jsonObj)).toBe(json(first.cs.jsonObj));
      expect(json(d.jsonObj)).toBe(json(mem.jsonObj));
      expect(json(d.getAllConcepts())).toBe(json(mem.getAllConcepts()));
      for (const code of ['A1', 'B1', 'ZZ', 'nope']) expect(json(d.getConceptByCode(code))).toBe(json(mem.getConceptByCode(code)));
      expect([d.url, d.vurl, d.version, d.conceptCount(), d.isSupplementFor(BASE, '1')]).toEqual([mem.url, mem.vurl, mem.version, mem.conceptCount(), true]);
      // a tx-worker opens it the same way
      expect((await startup({ readOnly: true })).r).toMatchObject({ supplements: 1, built: 0, unparsed: 1 });
    });

    test('a changed source is parsed and its file rebuilt', async () => {
      const changed = SUPP();
      changed.concept[2].display = 'Anzeige B geändert';
      fs.writeFileSync(src, JSON.stringify(changed, null, 1));
      const r = await startup();
      expect(r.r).toMatchObject({ supplements: 1, built: 1, unparsed: 0 });
      expect([r.parses > 0, r.loads]).toEqual([true, 1]);
      expect(r.cs.getConceptByCode('B').display).toBe('Anzeige B geändert');
      const again = await startup();
      expect(again.r).toMatchObject({ built: 0, unparsed: 1 });
      expect(again.parses).toBe(0);
      expect(again.cs.getConceptByCode('B').display).toBe('Anzeige B geändert');
    });

    test('a rebuilt base (no file for it yet) parses the source and builds its file', async () => {
      await new Promise((r) => setTimeout(r, 5)); // another builtAt: another base identity
      buildBase(path.join(dir, 'base2.db'));
      const base = await loadSqliteV2Factory(getTxModule().i18n, path.join(dir, 'base2.db'));
      expect(sf.baseIdentity(base.store)).not.toBe(sf.baseIdentity(factory.store));
      const r = await startup({ base });
      expect(r.r).toMatchObject({ supplements: 1, built: 1, unparsed: 0 });
      expect(r.loads).toBe(1);
      expect(r.cs.getConceptByCode('B').display).toBe('Anzeige B geändert');
      expect((await startup({ base })).r).toMatchObject({ built: 0, unparsed: 1 });
    });

    test('with supplementFiles = false, a source known from its bytes is parsed and kept in memory', async () => {
      const saved = settings.supplementFiles;
      try {
        // indexed while on, then the pass is off: the stub is loaded as main loads it
        const loader = new FileContentLoader(src, path.join(dir, 'src-loader'));
        loader.sourceIndex = sf.sourceIndex(cache);
        await loader.initialize();
        const [entry] = await loader.getResourcesByType('CodeSystem');
        const cs = await sf.codeSystemForEntry(entry, async () => new CodeSystem(await loader.loadFile(entry, loader.fhirVersion())));
        expect(cs.conceptCount()).toBe(0);
        settings.supplementFiles = false;
        const library = { codeSystemFactories: new Map([[BASE, factory]]), codeSystemProviders: [{ codeSystems: [cs] }], cacheFolder: cache };
        expect((await sf.useSupplementFiles(library)).supplements).toBe(0);
        const m = library.codeSystemProviders[0].codeSystems[0];
        expect(m).not.toBeInstanceOf(sf.DiskSupplement);
        expect(m.conceptCount()).toBe(mem.conceptCount());
        expect(m.getConceptByCode('B').display).toBe('Anzeige B geändert');
        // and off from the start, nothing is skipped
        const off = await startup();
        expect([off.r.supplements, off.loads, off.parses > 0]).toEqual([0, 1, true]);
      } finally {
        settings.supplementFiles = saved;
      }
    });
  });

  // ---- through the router: the same responses with the supplement in memory and on disk ----

  const vsAll = (filters) => ({ resourceType: 'ValueSet', status: 'active', compose: { include: [Object.assign({ system: BASE }, filters ? { filter: filters.map(([property, op, value]) => ({ property, op, value })) } : {})] } });
  const use = [{ name: 'useSupplement', valueCanonical: SUPP_URL }];
  const REQUESTS = [];
  for (const lang of ['de', 'de-CH', 'fr', 'en', null]) {
    const dl = lang ? [{ name: 'displayLanguage', valueCode: lang }] : [];
    REQUESTS.push(['/ValueSet/$expand', [{ name: 'valueSet', resource: vsAll() }, ...use, ...dl]]);
    REQUESTS.push(['/ValueSet/$expand', [{ name: 'valueSet', resource: vsAll() }, ...use, ...dl, { name: 'includeDesignations', valueBoolean: true }]]);
    REQUESTS.push(['/ValueSet/$expand', [{ name: 'valueSet', resource: vsAll() }, ...use, ...dl, { name: 'filter', valueString: 'anzeige' }]]);
    REQUESTS.push(['/ValueSet/$expand', [{ name: 'valueSet', resource: vsAll() }, ...use, ...dl, { name: 'filter', valueString: 'affich' }]]);
    REQUESTS.push(['/CodeSystem/$lookup', [{ name: 'system', valueUri: BASE }, { name: 'code', valueCode: 'A1' }, { name: 'property', valueCode: '*' }, ...use, ...dl]]);
    REQUESTS.push(['/CodeSystem/$validate-code', [{ name: 'url', valueUri: BASE }, { name: 'code', valueCode: 'A1' }, { name: 'display', valueString: 'Anzeige A1 zweite' }, ...use, ...dl]]);
    REQUESTS.push(['/CodeSystem/$validate-code', [{ name: 'url', valueUri: BASE }, { name: 'code', valueCode: 'A3' }, { name: 'display', valueString: 'Affichage A3' }, ...use, ...dl]]);
  }
  for (const f of [[['tier', '=', 'gold']], [['tier', 'in', 'gold,silver']], [['tier', 'exists', 'true']], [['tier', 'exists', 'false']], [['tier', 'regex', 'g.*']],
    [['colour', '=', 'red']], [['note', '=', 'x']], [['tier', '=', 'gold'], ['concept', 'is-a', 'A']], [['tier', 'not-in', 'gold']], [['concept', 'is-a', 'root'], ['tier', '=', 'bronze']]]) {
    REQUESTS.push(['/ValueSet/$expand', [{ name: 'valueSet', resource: vsAll(f) }, ...use, { name: 'displayLanguage', valueCode: 'de' }]]);
    REQUESTS.push(['/ValueSet/$validate-code', [{ name: 'valueSet', resource: vsAll(f) }, { name: 'system', valueUri: BASE }, { name: 'code', valueCode: 'A1' }, ...use]]);
    REQUESTS.push(['/ValueSet/$validate-code', [{ name: 'valueSet', resource: vsAll(f) }, { name: 'system', valueUri: BASE }, { name: 'code', valueCode: 'B1' }, ...use]]);
  }
  REQUESTS.push(['/ValueSet/$expand', [{ name: 'valueSet', resource: vsAll([['tier', '=', 'gold']]) }, ...use, { name: 'count', valueInteger: 1 }, { name: 'offset', valueInteger: 1 }]]);

  /** the responses, without what differs from one request to the next */
  async function run() {
    const out = [];
    for (const [op, parameter] of REQUESTS) {
      const res = await request(app).post('/tx/r5' + op).set('Content-Type', 'application/json').send({ resourceType: 'Parameters', parameter });
      const body = JSON.parse(JSON.stringify(res.body, (k, v) => (['id', 'timestamp', 'identifier', 'lastUpdated', 'meta'].includes(k) ? undefined : v)));
      out.push([op, res.status, body]);
    }
    return out;
  }

  function register(cs) {
    provider.codeSystems.delete(SUPP_URL);
    provider.codeSystems.delete(SUPP_URL + '|1');
    provider.addCodeSystem(cs);
  }

  test('expand, lookup and validate-code: the same responses from the in-memory and the disk-backed supplement', async () => {
    register(new CodeSystem(SUPP()));
    const inMemory = await run();
    register(disk);
    const onDisk = await run();
    provider.codeSystems.delete(SUPP_URL);
    provider.codeSystems.delete(SUPP_URL + '|1');
    expect(onDisk.length).toBe(inMemory.length);
    for (let i = 0; i < inMemory.length; i++) expect([i, ...onDisk[i]]).toEqual([i, ...inMemory[i]]);
    // and they are the answers wanted
    const de = inMemory[0][2];
    expect(de.expansion.contains.find((c) => c.code === 'A1').display).toBe('Anzeige A1 zweite');
    const gold = inMemory.find(([op, , b]) => op === '/ValueSet/$expand' && b.expansion && b.expansion.total === 2 && b.expansion.contains.some((c) => c.code === 'B'));
    expect(gold).toBeDefined();
  });

  test('a disk-backed layer is the file: nothing is built for a request', async () => {
    const { layerCache } = require('../../tx/sqlite-v2/layers');
    const before = { ...layerCache.stats };
    const p = await factory.build(new OperationContext(Languages.fromAcceptLanguage('en'), getTxModule().i18n), [disk]);
    const node = p.layers.filterNode(p._compiler(), 'tier', '=', 'gold');
    expect(node.t).toBe('layer');
    expect(node.layer.info.file).toBeDefined();
    expect(layerCache.stats.misses).toBe(before.misses);
    await p.close();
  });
});
