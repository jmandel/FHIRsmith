'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const BetterSqlite3 = require('better-sqlite3');
const { SqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

let i18n;

beforeAll(async () => {
  const langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
});

function makeOpContext() {
  return new OperationContext('en', i18n);
}

function createTinyV0Db(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-provider-v0-'));
  const dbPath = path.join(dir, 'tiny-v0.db');
  const schema = fs.readFileSync(path.join(__dirname, '../../tx/importers/schema-v0.sql'), 'utf8');
  const db = new BetterSqlite3(dbPath);
  try {
    db.exec(schema);
    db.prepare(`
      INSERT INTO code_system (cs_id, base_uri, edition_code, version, canonical_uri, release_date, name, source_kind)
      VALUES (1, 'http://example.org/tiny', NULL, '2026', 'http://example.org/tiny|2026', ?, 'Tiny', 'test')
    `).run(opts.releaseDate === undefined ? '2026-05-22' : opts.releaseDate);

    const insertConcept = db.prepare(`
      INSERT INTO concept (concept_id, cs_id, code, active, display, definition)
      VALUES (?, 1, ?, ?, ?, ?)
    `);
    insertConcept.run(1, 'A', 1, 'Alpha', 'Root concept');
    insertConcept.run(2, 'B', 1, 'Beta', 'Child concept');
    insertConcept.run(3, 'C', 0, 'Gamma', 'Inactive child');

    const insertProp = db.prepare(`
      INSERT INTO property_def (property_id, cs_id, property_code, value_kind, is_hierarchy, display, source_type)
      VALUES (?, 1, ?, ?, ?, ?, ?)
    `);
    insertProp.run(1, 'parent', 'concept', 1, 'Parent', 'code');
    insertProp.run(2, 'status', 'literal', 0, 'Status', 'string');

    const insertLink = db.prepare(`
      INSERT INTO concept_link (source_concept_id, property_id, target_concept_id, active)
      VALUES (?, ?, ?, 1)
    `);
    insertLink.run(2, 1, 1);
    insertLink.run(3, 1, 1);

    const insertLiteral = db.prepare(`
      INSERT INTO concept_literal (literal_id, source_concept_id, property_id, value_raw, value_text, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    insertLiteral.run(1, 2, 2, 'trial', 'trial');

    const insertDesignation = db.prepare(`
      INSERT INTO designation (designation_id, concept_id, active, language_code, use_code, term, preferred)
      VALUES (?, ?, 1, ?, ?, ?, ?)
    `);
    insertDesignation.run(1, 2, 'en', 'synonym', 'Beta synonym', 0);

    const insertClosure = db.prepare('INSERT INTO closure (ancestor_id, descendant_id) VALUES (?, ?)');
    for (const [ancestor, descendant] of [[1, 1], [2, 2], [3, 3], [1, 2], [1, 3]]) {
      insertClosure.run(ancestor, descendant);
    }

    const insertDisplayFts = db.prepare('INSERT INTO search_fts_display(rowid, term) VALUES (?, ?)');
    insertDisplayFts.run(1, 'Alpha');
    insertDisplayFts.run(2, 'Beta');
    insertDisplayFts.run(3, 'Gamma');
    db.prepare('INSERT INTO search_fts_designation(rowid, term) VALUES (?, ?)').run(1, 'Beta synonym');
    db.prepare('INSERT INTO search_fts_literal(rowid, term) VALUES (?, ?)').run(1, 'trial');
  } finally {
    db.close();
  }
  return { dbPath, dir };
}

describe('SqliteV0FactoryProvider', () => {
  let fixture;

  beforeEach(() => {
    fixture = createTinyV0Db();
  });

  afterEach(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  test('loads metadata and builds a provider', async () => {
    const factory = new SqliteV0FactoryProvider(i18n, fixture.dbPath);
    await factory.load();

    expect(factory.system()).toBe('http://example.org/tiny');
    expect(factory.version()).toBe('2026');
    expect(factory.releaseDate()).toBe('2026-05-22');
    expect(factory.name()).toBe('Tiny');

    const provider = await factory.build(makeOpContext(), null);
    try {
      expect(await provider.totalCount()).toBe(3);
      expect(provider.hasExecuteIR()).toBe(true);

      const loc = await provider.locate('B');
      expect(loc.context).toBeTruthy();
      expect(await provider.code(loc.context)).toBe('B');
      expect(await provider.display(loc.context)).toBe('Beta');
      expect(await provider.definition(loc.context)).toBe('Child concept');
      expect(await provider.isInactive(loc.context)).toBe(false);
      expect(await provider.getStatus(loc.context)).toBe('active');
    } finally {
      provider.close();
    }
  });

  test('does not use database load time as a release date fallback', async () => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    fixture = createTinyV0Db({ releaseDate: null });

    const factory = new SqliteV0FactoryProvider(i18n, fixture.dbPath);
    await factory.load();

    expect(factory.releaseDate()).toBeNull();
  });

  test('returns hierarchy and typed property data', async () => {
    const factory = new SqliteV0FactoryProvider(i18n, fixture.dbPath);
    await factory.load();
    const provider = await factory.build(makeOpContext(), null);
    try {
      const { context } = await provider.locate('B');
      expect(await provider.parent(context)).toBe('A');
      expect(await provider.parents(context)).toEqual(['A']);

      const props = await provider.properties(context);
      expect(props).toEqual(expect.arrayContaining([
        { code: 'parent', valueCode: 'A' },
        { code: 'status', valueString: 'trial' },
      ]));

      const iter = await provider.iterator(await provider.locate('A').then((x) => x.context));
      const childCodes = [];
      while (await provider.nextContext(iter).then((ctx) => {
        if (ctx) childCodes.push(ctx.code);
        return !!ctx;
      })) {}
      expect(childCodes.sort()).toEqual(['B', 'C']);
    } finally {
      provider.close();
    }
  });

  test('executes legacy hierarchy and property filters', async () => {
    const factory = new SqliteV0FactoryProvider(i18n, fixture.dbPath);
    await factory.load();
    const provider = await factory.build(makeOpContext(), null);
    try {
      const isA = await provider.getPrepContext(true);
      await provider.filter(isA, 'concept', 'is-a', 'A');
      const [isASet] = await provider.executeFilters(isA);
      expect(await provider.filterSize(isA, isASet)).toBe(3);

      const descendant = await provider.getPrepContext(true);
      await provider.filter(descendant, 'concept', 'descendent-of', 'A');
      const [descendantSet] = await provider.executeFilters(descendant);
      expect(await provider.filterSize(descendant, descendantSet)).toBe(2);

      const property = await provider.getPrepContext(true);
      await provider.filter(property, 'status', '=', 'trial');
      const [propertySet] = await provider.executeFilters(property);
      expect(await provider.filterSize(property, propertySet)).toBe(1);
      const filtered = await provider.filterConcept(property, propertySet);
      expect(filtered.code).toBe('B');
    } finally {
      provider.close();
    }
  });
});
