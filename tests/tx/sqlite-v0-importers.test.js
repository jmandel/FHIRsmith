const fs = require('fs');
const os = require('os');
const path = require('path');
const BetterSqlite3 = require('better-sqlite3');

describe('SQLite v0 importer schema', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-sqlite-v0-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSchemaDb() {
    const dbPath = path.join(tmpDir, 'schema.db');
    const schema = fs.readFileSync(path.join(__dirname, '../../tx/importers/schema-v0.sql'), 'utf8');
    const db = new BetterSqlite3(dbPath);
    db.exec(schema);
    return db;
  }

  test('declares runtime metadata columns used by sqlite-v0 providers', () => {
    const db = createSchemaDb();
    try {
      const codeSystemColumns = new Set(
        db.pragma('table_info(code_system)').map((row) => row.name)
      );
      const propertyColumns = new Set(
        db.pragma('table_info(property_def)').map((row) => row.name)
      );

      expect(codeSystemColumns.has('release_date')).toBe(true);
      expect(propertyColumns.has('source_type')).toBe(true);
      expect(db.pragma('user_version', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  test('keeps one-code-system-per-version and one-code-per-system invariants explicit', () => {
    const db = createSchemaDb();
    try {
      db.prepare(`
        INSERT INTO code_system (base_uri, version, canonical_uri, release_date, name, source_kind)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('http://example.org/cs', '2026', 'http://example.org/cs|2026', '2026-01-01', 'Example', 'test');

      expect(() => db.prepare(`
        INSERT INTO code_system (base_uri, version, canonical_uri, name, source_kind)
        VALUES (?, ?, ?, ?, ?)
      `).run('http://example.org/cs', '2026', 'http://example.org/cs|2026b', 'Example', 'test')).toThrow();

      db.prepare(`
        INSERT INTO concept (concept_id, cs_id, code, active, display)
        VALUES (?, ?, ?, ?, ?)
      `).run(1, 1, 'A', 1, 'Alpha');

      expect(() => db.prepare(`
        INSERT INTO concept (concept_id, cs_id, code, active, display)
        VALUES (?, ?, ?, ?, ?)
      `).run(2, 1, 'A', 1, 'Alpha duplicate')).toThrow();
    } finally {
      db.close();
    }
  });

  test('loads all sqlite-v0 importer modules', () => {
    const { LoincSqliteV0Module, LoincSqliteV0Importer } = require('../../tx/importers/import-loinc-sqlite-v0.module');
    const { RxNormSqliteV0Module, RxNormSqliteV0Importer } = require('../../tx/importers/import-rxnorm-sqlite-v0.module');
    const { SnomedSqliteV0Module, SnomedSqliteV0Importer } = require('../../tx/importers/import-sct-sqlite-v0.module');

    expect(new LoincSqliteV0Module().getName()).toBe('loinc-sqlite-v0');
    expect(new RxNormSqliteV0Module().getName()).toBe('rxnorm-sqlite-v0');
    expect(new SnomedSqliteV0Module().getName()).toBe('snomed-sqlite-v0');
    expect(typeof LoincSqliteV0Importer).toBe('function');
    expect(typeof RxNormSqliteV0Importer).toBe('function');
    expect(typeof SnomedSqliteV0Importer).toBe('function');
  });
});
