'use strict';

// Builds a sqlite-v1 DB from the SMALL SNOMED CT .cache fixture and asserts the
// cache-sourced fixture matches what the RF2 importer would produce: concept
// count equals the cache's, no closure self-rows, a root concept resolves with a
// display, designations carry the SNOMED use_system, and cs_config carries the
// '?'-prefixed implicitValueSets patterns. Skips loudly if the cache is absent.

const path = require('path');
const fs = require('fs');
const os = require('os');

const Database = require('better-sqlite3');
const { SnomedFileReader, SnomedServices } = (() => ({
  SnomedFileReader: require('../../tx/sct/structures').SnomedFileReader,
  SnomedServices: require('../../tx/cs/cs-snomed').SnomedServices,
}))();
const {
  SnomedCacheSqliteV1Importer,
} = require('../../tx/importers/import-sct-cache-sqlite-v1.module');

const CACHE_FILE = path.resolve(
  __dirname, '../../data/terminology-cache/sct_test_20250814.cache'
);

const describeOrSkip = fs.existsSync(CACHE_FILE) ? describe : describe.skip;
if (!fs.existsSync(CACHE_FILE)) {
  // eslint-disable-next-line no-console
  console.warn(`\n[SKIP] SNOMED cache fixture missing: ${CACHE_FILE}\n`);
}

describeOrSkip('sqlite-v1 SNOMED .cache importer', () => {
  let tmpDir;
  let dbPath;
  let cacheConceptCount;
  let db;

  beforeAll(async () => {
    // Count concepts straight from the cache to compare against the DB.
    const reader = new SnomedFileReader(CACHE_FILE);
    const shared = await reader.loadSnomedData();
    const sct = new SnomedServices(shared);
    cacheConceptCount = sct.concepts.count();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sct-cache-v1-'));
    dbPath = path.join(tmpDir, 'sct-cache.db');

    const importer = new SnomedCacheSqliteV1Importer({
      source: CACHE_FILE,
      dest: dbPath,
      overwrite: true,
      verbose: false,
    });
    await importer.run();

    db = new Database(dbPath, { readonly: true });
  }, 120000);

  afterAll(() => {
    if (db) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('concept count > 0 and equals the cache count', () => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM concept').get().n;
    expect(cacheConceptCount).toBeGreaterThan(0);
    expect(n).toBe(cacheConceptCount);
  });

  test('closure has no self-rows', () => {
    const selfRows = db
      .prepare('SELECT COUNT(*) AS n FROM closure WHERE ancestor_id = descendant_id')
      .get().n;
    expect(selfRows).toBe(0);
    // and the closure is non-trivial
    expect(db.prepare('SELECT COUNT(*) AS n FROM closure').get().n).toBeGreaterThan(0);
  });

  test('a root concept has a non-empty display', () => {
    const root = db
      .prepare("SELECT display FROM concept WHERE code = '138875005'")
      .get();
    expect(root).toBeTruthy();
    expect(typeof root.display).toBe('string');
    expect(root.display.trim().length).toBeGreaterThan(0);
  });

  test('a designation uses the SNOMED CT use_system', () => {
    const d = db
      .prepare("SELECT COUNT(*) AS n FROM designation WHERE use_system = 'http://snomed.info/sct'")
      .get();
    expect(d.n).toBeGreaterThan(0);
  });

  test("cs_config has the '?'-prefixed implicitValueSets patterns", () => {
    const row = db
      .prepare("SELECT value FROM cs_config WHERE key = 'implicitValueSets'")
      .get();
    expect(row).toBeTruthy();
    const patterns = JSON.parse(row.value).map((p) => p.pattern);
    expect(patterns).toEqual(
      expect.arrayContaining(['?fhir_vs', '?fhir_vs=isa/{code}', '?fhir_vs=refset/{id}'])
    );
    // status/inactive property wiring copied from the RF2 importer.
    const inactive = db.prepare("SELECT value FROM cs_config WHERE key = 'inactiveProperty'").get();
    expect(inactive.value).toBe('inactive');
  });
});
