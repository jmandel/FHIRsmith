'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const BetterSqlite3 = require('better-sqlite3');
const IR = require('../../tx/engine/ir');
const { SqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0');
const { OperationContext } = require('../../tx/operation-context');
const { Designations } = require('../../tx/library/designations');
const { TestUtilities } = require('../test-utilities');

let i18n;
let langDefs;

beforeAll(async () => {
  langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
});

function makeOpContext() {
  return new OperationContext('en', i18n);
}

function insertJsonConfig(db, key, value) {
  db.prepare('INSERT INTO cs_config (cs_id, key, value) VALUES (1, ?, ?)').run(key, JSON.stringify(value));
}

function createDeviousV0Db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-provider-v0-devious-'));
  const dbPath = path.join(dir, 'devious-v0.db');
  const schema = fs.readFileSync(path.join(__dirname, '../../tx/importers/schema-v0.sql'), 'utf8');
  const db = new BetterSqlite3(dbPath);
  try {
    db.exec(schema);
    db.prepare(`
      INSERT INTO code_system (cs_id, base_uri, edition_code, version, canonical_uri, release_date, name, source_kind)
      VALUES (1, 'http://example.org/devious', NULL, '2026', 'http://example.org/devious|2026', '2026-05-22', 'Devious', 'test')
    `).run();

    insertJsonConfig(db, 'runtime.search', {
      mode: 'fts',
      sources: ['display', 'designation', 'literal'],
      activeOnly: true,
      designationActiveOnly: true,
      literalActiveOnly: true,
      ftsTables: {
        display: 'search_fts_display',
        designation: 'search_fts_designation',
        literal: 'search_fts_literal',
      },
    });
    insertJsonConfig(db, 'runtime.filters', {
      concept: {
        operators: ['=', 'is-a', 'descendent-of', 'in'],
        implicitValueSets: { 'http://example.org/vs/': true },
      },
      code: { operators: ['regex'] },
      properties: {
        aliases: { state: 'status' },
        defaultSources: ['literal'],
        defaultOperators: ['=', 'in', 'regex', 'exists'],
        defaultLinkMatch: 'code-only',
        byCode: {
          parent: { sources: ['link'] },
          status: { sources: ['literal'], value: { aliases: { current: 'active' } } },
          kind: { sources: ['link'], linkMatch: 'code-or-display' },
          rank: { sources: ['literal'] },
          weight: { sources: ['literal'] },
          flag: { sources: ['literal'] },
          urlprop: { sources: ['literal'] },
          canonicalprop: { sources: ['literal'] },
          dateprop: { sources: ['literal'] },
          momentprop: { sources: ['literal'] },
          codeprop: { sources: ['literal'] },
          note: { sources: ['literal'] },
        },
      },
    });
    insertJsonConfig(db, 'runtime.status', {
      inactive: { source: 'concept.active', invert: true },
      deprecated: { source: 'constant', value: false },
      abstract: { source: 'constant', value: false },
      statusProperty: 'status',
    });
    insertJsonConfig(db, 'runtime.designations', {
      useMapping: {
        synonym: {
          system: 'http://terminology.hl7.org/CodeSystem/designation-usage',
          code: 'synonym',
          display: 'Synonym',
        },
      },
    });

    const concepts = [
      [1, 'ROOT', 1, 'Root Display', 'Root definition'],
      [2, 'ALPHA', 1, 'Alpha Display', 'Alpha definition'],
      [3, 'BETA', 1, 'Beta Display', 'Beta definition'],
      [4, 'GAMMA', 0, 'Gamma Display', 'Inactive but still coded'],
      [5, 'DELTA', 1, 'Delta Display', 'Kidney chemistry result'],
      [6, 'OMEGA', 1, 'Omega Display', 'Multiple parent concept'],
      [7, 'TYPE-LAB', 1, 'Laboratory', 'Lab type'],
      [8, 'TYPE-DOC', 1, 'Document', 'Document type'],
      [9, 'TYPE-RAD', 1, 'Radiology', 'Radiology type'],
      [10, 'ORPHAN', 1, 'Orphan Display', 'No parent and sparse properties'],
    ];
    const insertConcept = db.prepare(`
      INSERT INTO concept (concept_id, cs_id, code, active, display, definition)
      VALUES (?, 1, ?, ?, ?, ?)
    `);
    const insertDisplayFts = db.prepare('INSERT INTO search_fts_display(rowid, term) VALUES (?, ?)');
    for (const concept of concepts) {
      insertConcept.run(...concept);
      insertDisplayFts.run(concept[0], concept[3]);
    }

    const props = [
      [1, 'parent', 'concept', 1, 'Parent', 'code'],
      [2, 'status', 'literal', 0, 'Status', 'string'],
      [3, 'kind', 'concept', 0, 'Kind', 'code'],
      [4, 'rank', 'literal', 0, 'Rank', 'integer'],
      [5, 'weight', 'literal', 0, 'Weight', 'decimal'],
      [6, 'flag', 'literal', 0, 'Flag', 'boolean'],
      [7, 'urlprop', 'literal', 0, 'URL', 'uri'],
      [8, 'canonicalprop', 'literal', 0, 'Canonical', 'canonical'],
      [9, 'dateprop', 'literal', 0, 'Date', 'date'],
      [10, 'momentprop', 'literal', 0, 'Moment', 'datetime'],
      [11, 'codeprop', 'literal', 0, 'Code', 'code'],
      [12, 'note', 'literal', 0, 'Note', 'string'],
    ];
    const insertProp = db.prepare(`
      INSERT INTO property_def (property_id, cs_id, property_code, value_kind, is_hierarchy, display, source_type)
      VALUES (?, 1, ?, ?, ?, ?, ?)
    `);
    for (const prop of props) insertProp.run(...prop);

    const insertLink = db.prepare(`
      INSERT INTO concept_link (source_concept_id, property_id, target_concept_id, active)
      VALUES (?, ?, ?, ?)
    `);
    for (const row of [
      [2, 1, 1, 1],
      [3, 1, 1, 1],
      [4, 1, 1, 1],
      [5, 1, 2, 1],
      [6, 1, 2, 1],
      [6, 1, 3, 1],
      [2, 3, 7, 1],
      [3, 3, 8, 1],
      [4, 3, 9, 1],
      [5, 3, 7, 1],
      [6, 3, 7, 1],
    ]) {
      insertLink.run(...row);
    }

    const insertLiteral = db.prepare(`
      INSERT INTO concept_literal
        (source_concept_id, property_id, value_raw, value_text, value_num, value_bool, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const literals = [
      [1, 2, 'active', 'active', null, null, 1],
      [2, 2, 'active', 'active', null, null, 1],
      [3, 2, 'draft', 'draft', null, null, 1],
      [4, 2, 'active', 'active', null, null, 1],
      [5, 2, 'active', 'active', null, null, 1],
      [5, 2, 'retired', 'retired', null, null, 0],
      [6, 2, 'active', 'active', null, null, 1],
      [10, 2, 'retired', 'retired', null, null, 1],
      [2, 4, '1', '1', 1, null, 1],
      [3, 4, '2', '2', 2, null, 1],
      [5, 4, '10', '10', 10, null, 1],
      [6, 4, '20', '20', 20, null, 1],
      [5, 5, '2.5', '2.5', 2.5, null, 1],
      [5, 6, 'true', 'true', null, 1, 1],
      [5, 7, 'http://example.org/u', 'http://example.org/u', null, null, 1],
      [5, 8, 'http://example.org/cs|1', 'http://example.org/cs|1', null, null, 1],
      [5, 9, '2026-01-02', '2026-01-02', null, null, 1],
      [5, 10, '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z', null, null, 1],
      [5, 11, 'blue', 'blue', null, null, 1],
      [5, 12, 'creatinine kidney panel', 'creatinine kidney panel', null, null, 1],
      [3, 12, 'beta nickname marker', 'beta nickname marker', null, null, 1],
    ];
    const insertLiteralFts = db.prepare('INSERT INTO search_fts_literal(rowid, term) VALUES (?, ?)');
    let literalId = 1;
    for (const literal of literals) {
      insertLiteral.run(...literal);
      insertLiteralFts.run(literalId++, literal[3] || literal[2]);
    }

    const insertDesignation = db.prepare(`
      INSERT INTO designation (designation_id, concept_id, active, language_code, use_code, term, preferred)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDesignationFts = db.prepare('INSERT INTO search_fts_designation(rowid, term) VALUES (?, ?)');
    const designations = [
      [1, 2, 1, 'en', 'synonym', 'Alpha Display', 1],
      [2, 2, 1, 'en', 'synonym', 'Alpha alias', 0],
      [3, 3, 1, 'en', 'synonym', 'Beta nickname', 1],
      [4, 4, 1, 'en', 'synonym', 'Gamma inactive synonym', 1],
    ];
    for (const designation of designations) {
      insertDesignation.run(...designation);
      insertDesignationFts.run(designation[0], designation[5]);
    }

    const insertClosure = db.prepare('INSERT INTO closure (ancestor_id, descendant_id) VALUES (?, ?)');
    for (const row of [
      [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9], [10, 10],
      [1, 2], [1, 3], [1, 4], [1, 5], [1, 6],
      [2, 5], [2, 6],
      [3, 6],
    ]) {
      insertClosure.run(...row);
    }

    db.prepare('INSERT INTO value_set (vs_id, cs_id, url, version, name) VALUES (1, 1, ?, ?, ?)')
      .run('http://example.org/vs/labish', '1', 'Lab-ish');
    const insertVsMember = db.prepare('INSERT INTO value_set_member (vs_id, concept_id, active) VALUES (1, ?, ?)');
    insertVsMember.run(2, 1);
    insertVsMember.run(5, 1);
    insertVsMember.run(3, 0);
  } finally {
    db.close();
  }
  return { dbPath, dir };
}

async function makeFactory(dbPath) {
  const factory = new SqliteV0FactoryProvider(i18n, dbPath);
  await factory.load();
  return factory;
}

async function withProvider(dbPath, fn) {
  const factory = await makeFactory(dbPath);
  const provider = await factory.build(makeOpContext(), null);
  try {
    return await fn(provider, factory);
  } finally {
    provider.close();
  }
}

async function collectFilterCodes(provider, clauses, search = null) {
  const prep = await provider.getPrepContext(true);
  for (const [property, op, value] of clauses) {
    await provider.filter(prep, property, op, value);
  }
  if (search) {
    await provider.searchFilter(prep, search, true);
  }
  const [set] = await provider.executeFilters(prep);
  const codes = [];
  while (await provider.filterMore(prep, set)) {
    codes.push((await provider.filterConcept(prep, set)).code);
  }
  return codes.sort();
}

function irFilter(property, op, value) {
  return IR.selector({
    system: 'http://example.org/devious',
    shape: 'filter',
    filterClauses: [{ property, op, value }],
  });
}

function irCodes(result) {
  return (result?.candidates || []).map(c => c.code).sort();
}

describe('SqliteV0Provider devious behavior cases', () => {
  let fixture;

  beforeAll(() => {
    fixture = createDeviousV0Db();
  });

  afterAll(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  test.each([
    ['system', async (provider, factory) => factory.system(), 'http://example.org/devious'],
    ['version', async (provider, factory) => factory.version(), '2026'],
    ['releaseDate', async (provider, factory) => factory.releaseDate(), '2026-05-22'],
    ['name', async (provider, factory) => factory.name(), 'Devious'],
    ['totalCount', async (provider) => await provider.totalCount(), 10],
    ['contentMode', async (provider) => provider.contentMode(), 'complete'],
    ['hasParents', async (provider) => provider.hasParents(), true],
    ['isNotClosed', async (provider) => provider.isNotClosed(), false],
  ])('metadata %s', async (name, read, expected) => {
    await withProvider(fixture.dbPath, async (provider, factory) => {
      expect(await read(provider, factory)).toBe(expected);
    });
  });

  test.each([
    ['ALPHA', 'Alpha Display', 'Alpha definition', false, 'active'],
    ['BETA', 'Beta Display', 'Beta definition', false, 'draft'],
    ['GAMMA', 'Gamma Display', 'Inactive but still coded', true, 'active'],
    ['ORPHAN', 'Orphan Display', 'No parent and sparse properties', false, 'retired'],
  ])('locate/read/status for %s', async (code, display, definition, inactive, status) => {
    await withProvider(fixture.dbPath, async (provider) => {
      const { context } = await provider.locate(code);
      expect(context).toBeTruthy();
      expect(await provider.code(context)).toBe(code);
      expect(await provider.display(context)).toBe(display);
      expect(await provider.definition(context)).toBe(definition);
      expect(await provider.isInactive(context)).toBe(inactive);
      expect(await provider.getStatus(context)).toBe(status);
    });
  });

  test.each([
    ['ROOT', null, []],
    ['ALPHA', 'ROOT', ['ROOT']],
    ['DELTA', 'ALPHA', ['ALPHA']],
    ['OMEGA', 'ALPHA', ['ALPHA', 'BETA']],
  ])('parents for %s', async (code, firstParent, parents) => {
    await withProvider(fixture.dbPath, async (provider) => {
      const { context } = await provider.locate(code);
      expect(await provider.parent(context)).toBe(firstParent);
      expect(await provider.parents(context)).toEqual(parents);
    });
  });

  test.each([
    ['ROOT', ['ALPHA', 'BETA', 'GAMMA']],
    ['ALPHA', ['DELTA', 'OMEGA']],
    ['BETA', ['OMEGA']],
    ['DELTA', []],
  ])('iterator children for %s', async (code, expected) => {
    await withProvider(fixture.dbPath, async (provider) => {
      const { context } = await provider.locate(code);
      const iter = await provider.iterator(context);
      const codes = [];
      let next;
      while ((next = await provider.nextContext(iter))) {
        codes.push(next.code);
      }
      expect(codes.sort()).toEqual(expected);
    });
  });

  test('propertyDefinitions exposes native typed property metadata', async () => {
    await withProvider(fixture.dbPath, async (provider) => {
      expect(provider.propertyDefinitions()).toEqual(expect.arrayContaining([
        { code: 'parent', type: 'code', description: 'Parent' },
        { code: 'rank', type: 'integer', description: 'Rank' },
        { code: 'weight', type: 'decimal', description: 'Weight' },
        { code: 'flag', type: 'boolean', description: 'Flag' },
        { code: 'urlprop', type: 'uri', description: 'URL' },
        { code: 'canonicalprop', type: 'canonical', description: 'Canonical' },
        { code: 'dateprop', type: 'date', description: 'Date' },
        { code: 'momentprop', type: 'dateTime', description: 'Moment' },
        { code: 'codeprop', type: 'code', description: 'Code' },
      ]));
    });
  });

  test('properties returns concept links and typed literal values', async () => {
    await withProvider(fixture.dbPath, async (provider) => {
      const { context } = await provider.locate('DELTA');
      expect(await provider.properties(context)).toEqual(expect.arrayContaining([
        { code: 'parent', valueCode: 'ALPHA' },
        { code: 'kind', valueCode: 'TYPE-LAB' },
        { code: 'status', valueString: 'active' },
        { code: 'rank', valueInteger: 10 },
        { code: 'weight', valueDecimal: 2.5 },
        { code: 'flag', valueBoolean: true },
        { code: 'urlprop', valueUri: 'http://example.org/u' },
        { code: 'canonicalprop', valueCanonical: 'http://example.org/cs|1' },
        { code: 'dateprop', valueDate: '2026-01-02' },
        { code: 'momentprop', valueDateTime: '2026-01-02T03:04:05Z' },
        { code: 'codeprop', valueCode: 'blue' },
      ]));
    });
  });

  test('designations does not synthesize a duplicate display designation', async () => {
    await withProvider(fixture.dbPath, async (provider) => {
      const { context } = await provider.locate('ALPHA');
      const displays = new Designations(langDefs);
      await provider.designations(context, displays);
      const values = displays.designations.map(d => d.value);
      expect(values.filter(v => v === 'Alpha Display')).toHaveLength(1);
      expect(values).toContain('Alpha alias');
    });
  });

  test.each([
    ['concept equals', [['concept', '=', 'ALPHA']], ['ALPHA']],
    ['concept is-a root includes self and inactive descendants', [['concept', 'is-a', 'ROOT']], ['ALPHA', 'BETA', 'DELTA', 'GAMMA', 'OMEGA', 'ROOT']],
    ['concept descendent-of root excludes self', [['concept', 'descendent-of', 'ROOT']], ['ALPHA', 'BETA', 'DELTA', 'GAMMA', 'OMEGA']],
    ['concept in explicit value set ignores inactive member rows', [['concept', 'in', 'http://example.org/vs/labish']], ['ALPHA', 'DELTA']],
    ['code regex uses JS-side post-filtering', [['code', 'regex', '^(ALPHA|OMEGA)$']], ['ALPHA', 'OMEGA']],
    ['literal equals', [['status', '=', 'active']], ['ALPHA', 'DELTA', 'GAMMA', 'OMEGA', 'ROOT']],
    ['literal value alias', [['status', '=', 'current']], ['ALPHA', 'DELTA', 'GAMMA', 'OMEGA', 'ROOT']],
    ['property alias', [['state', '=', 'current']], ['ALPHA', 'DELTA', 'GAMMA', 'OMEGA', 'ROOT']],
    ['literal in list trims values', [['status', 'in', 'draft, active']], ['ALPHA', 'BETA', 'DELTA', 'GAMMA', 'OMEGA', 'ROOT']],
    ['literal regex', [['status', 'regex', '^act']], ['ALPHA', 'DELTA', 'GAMMA', 'OMEGA', 'ROOT']],
    ['literal exists true', [['note', 'exists', 'true']], ['BETA', 'DELTA']],
    ['literal exists false', [['note', 'exists', 'false']], ['ALPHA', 'GAMMA', 'OMEGA', 'ORPHAN', 'ROOT', 'TYPE-DOC', 'TYPE-LAB', 'TYPE-RAD']],
    ['link equals by target code', [['kind', '=', 'TYPE-LAB']], ['ALPHA', 'DELTA', 'OMEGA']],
    ['link equals by target display', [['kind', '=', 'Laboratory']], ['ALPHA', 'DELTA', 'OMEGA']],
    ['link regex by target code', [['kind', 'regex', '^TYPE-D']], ['BETA']],
    ['link regex by target display', [['kind', 'regex', '^Radio']], ['GAMMA']],
    ['link exists true', [['kind', 'exists', 'true']], ['ALPHA', 'BETA', 'DELTA', 'GAMMA', 'OMEGA']],
    ['link exists false', [['kind', 'exists', 'false']], ['ORPHAN', 'ROOT', 'TYPE-DOC', 'TYPE-LAB', 'TYPE-RAD']],
    ['intersection of hierarchy and link filter', [['concept', 'is-a', 'ALPHA'], ['kind', '=', 'TYPE-LAB']], ['ALPHA', 'DELTA', 'OMEGA']],
    ['intersection can become empty', [['concept', 'is-a', 'BETA'], ['kind', '=', 'Document']], ['BETA']],
  ])('legacy filter: %s', async (name, clauses, expected) => {
    await withProvider(fixture.dbPath, async (provider) => {
      expect(await collectFilterCodes(provider, clauses)).toEqual(expected);
    });
  });

  test.each([
    ['display text excludes inactive concepts', [], 'gamma', []],
    ['designation text search', [], 'nickname', ['BETA']],
    ['literal text search', [], 'creatinine', ['DELTA']],
    ['text plus property filter intersects', [['status', '=', 'draft']], 'nickname', ['BETA']],
    ['text plus property filter can empty', [['status', '=', 'active']], 'nickname', []],
  ])('legacy search filter: %s', async (name, clauses, text, expected) => {
    await withProvider(fixture.dbPath, async (provider) => {
      expect(await collectFilterCodes(provider, clauses, text)).toEqual(expected);
    });
  });

  test('filterLocate and filterCheck report membership against materialized filter sets', async () => {
    await withProvider(fixture.dbPath, async (provider) => {
      const prep = await provider.getPrepContext(true);
      await provider.filter(prep, 'kind', '=', 'Laboratory');
      const [set] = await provider.executeFilters(prep);
      expect((await provider.filterLocate(prep, set, 'DELTA')).code).toBe('DELTA');
      expect(await provider.filterLocate(prep, set, 'BETA')).toBe('Code BETA not found in filter result');
      expect(await provider.filterCheck(prep, set, (await provider.locate('OMEGA')).context)).toBe(true);
      expect(await provider.filterCheck(prep, set, (await provider.locate('BETA')).context)).toBe('Code BETA not in filter set');
    });
  });

  test('invalid code regex fails with a useful message', async () => {
    await withProvider(fixture.dbPath, async (provider) => {
      const prep = await provider.getPrepContext(true);
      await provider.filter(prep, 'code', 'regex', '[');
      await expect(provider.executeFilters(prep)).rejects.toThrow("Invalid code regex '['");
    });
  });

  test.each([
    ['whole system', IR.selector({ system: 'http://example.org/devious', shape: 'whole' }), {}, ['ALPHA', 'BETA', 'DELTA', 'GAMMA', 'OMEGA', 'ORPHAN', 'ROOT', 'TYPE-DOC', 'TYPE-LAB', 'TYPE-RAD']],
    ['whole system activeOnly', IR.selector({ system: 'http://example.org/devious', shape: 'whole' }), { activeOnly: true }, ['ALPHA', 'BETA', 'DELTA', 'OMEGA', 'ORPHAN', 'ROOT', 'TYPE-DOC', 'TYPE-LAB', 'TYPE-RAD']],
    ['status active includes inactive unless activeOnly requested', irFilter('status', '=', 'active'), {}, ['ALPHA', 'DELTA', 'GAMMA', 'OMEGA', 'ROOT']],
    ['status active activeOnly removes inactive concept', irFilter('status', '=', 'active'), { activeOnly: true }, ['ALPHA', 'DELTA', 'OMEGA', 'ROOT']],
    ['concept is-a alpha', irFilter('concept', 'is-a', 'ALPHA'), {}, ['ALPHA', 'DELTA', 'OMEGA']],
    ['concept descendent-of alpha', irFilter('concept', 'descendent-of', 'ALPHA'), {}, ['DELTA', 'OMEGA']],
    ['link display match', irFilter('kind', '=', 'Laboratory'), {}, ['ALPHA', 'DELTA', 'OMEGA']],
    ['explicit value set membership', irFilter('concept', 'in', 'http://example.org/vs/labish'), {}, ['ALPHA', 'DELTA']],
    ['text selection over whole system', IR.selector({ system: 'http://example.org/devious', shape: 'whole' }), { text: 'creatinine' }, ['DELTA']],
    ['bounded count page', irFilter('status', 'in', 'active,draft'), { count: 3 }, ['ALPHA', 'BETA', 'DELTA']],
  ])('IR execute: %s', async (name, subtree, opts, expectedCodes) => {
    await withProvider(fixture.dbPath, async (provider) => {
      expect(irCodes(provider.executeIR(subtree, { count: 100, ...opts }))).toEqual(expectedCodes);
    });
  });

  test.each([
    ['whole system count', IR.selector({ system: 'http://example.org/devious', shape: 'whole' }), {}, 10],
    ['activeOnly count', IR.selector({ system: 'http://example.org/devious', shape: 'whole' }), { activeOnly: true }, 9],
    ['status count includes inactive concept', irFilter('status', '=', 'active'), {}, 5],
    ['status activeOnly count removes inactive concept', irFilter('status', '=', 'active'), { activeOnly: true }, 4],
    ['descendent-of count', irFilter('concept', 'descendent-of', 'ALPHA'), {}, 2],
    ['text count', IR.selector({ system: 'http://example.org/devious', shape: 'whole' }), { text: 'nickname' }, 1],
  ])('IR count: %s', async (name, subtree, opts, expected) => {
    await withProvider(fixture.dbPath, async (provider) => {
      expect(provider.countForIR(subtree, opts)).toBe(expected);
    });
  });

  test.each([
    ['kind lab contains DELTA', irFilter('kind', '=', 'Laboratory'), 'DELTA', true],
    ['kind lab excludes BETA', irFilter('kind', '=', 'Laboratory'), 'BETA', false],
    ['root hierarchy contains OMEGA', irFilter('concept', 'is-a', 'ROOT'), 'OMEGA', true],
    ['root descendants exclude ROOT', irFilter('concept', 'descendent-of', 'ROOT'), 'ROOT', false],
    ['explicit value set excludes inactive member row', irFilter('concept', 'in', 'http://example.org/vs/labish'), 'BETA', false],
  ])('IR membership: %s', async (name, subtree, code, expected) => {
    await withProvider(fixture.dbPath, async (provider) => {
      expect(provider.membershipForIR(subtree).has(code)).toBe(expected);
    });
  });

  test.each([
    ['ROOT subsumes DELTA', 'ROOT', 'DELTA', 'subsumes'],
    ['DELTA is subsumed by ROOT', 'DELTA', 'ROOT', 'subsumed-by'],
    ['ALPHA and ALPHA equivalent', 'ALPHA', 'ALPHA', 'equivalent'],
    ['ALPHA and BETA unrelated', 'ALPHA', 'BETA', 'not-subsumed'],
  ])('subsumesTest: %s', async (name, a, b, expected) => {
    await withProvider(fixture.dbPath, async (provider) => {
      expect(await provider.subsumesTest(a, b)).toBe(expected);
    });
  });

  test('bulk helpers return designations and properties without changing per-concept semantics', async () => {
    await withProvider(fixture.dbPath, async (provider) => {
      const bulkDesignations = provider.bulkDesignations([2, 5]);
      expect(bulkDesignations.get(2).map(d => d.value)).toEqual(expect.arrayContaining(['Alpha Display', 'Alpha alias']));
      const bulkProperties = provider.bulkProperties([5]);
      expect(bulkProperties.get(5)).toEqual(expect.arrayContaining([
        { code: 'rank', valueInteger: 10 },
        { code: 'kind', valueCode: 'TYPE-LAB' },
      ]));
      expect(provider.bulkExtensions([5]).size).toBe(0);
      expect(await provider.extensions((await provider.locate('DELTA')).context)).toBeNull();
    });
  });

  test('extendLookup emits requested native properties, parents, and children', async () => {
    await withProvider(fixture.dbPath, async (provider) => {
      const { context } = await provider.locate('ALPHA');
      const params = [];
      await provider.extendLookup(context, ['property', 'parent', 'child'], params);
      const rendered = params.map(param => ({
        name: param.name,
        code: param.part?.find(part => part.name === 'code')?.valueCode,
        value: param.part?.find(part => part.name === 'value')?.valueCode
          ?? param.part?.find(part => part.name === 'value')?.valueString,
      }));
      expect(rendered).toEqual(expect.arrayContaining([
        { name: 'property', code: 'parent', value: 'ROOT' },
        { name: 'property', code: 'kind', value: 'TYPE-LAB' },
        { name: 'property', code: 'status', value: 'active' },
        { name: 'property', code: 'child', value: 'DELTA' },
        { name: 'property', code: 'child', value: 'OMEGA' },
      ]));
    });
  });

  test.each([
    ['all codes implicit valueset', 'http://example.org/devious?fhir_vs', null, {
      compose: { include: [{ system: 'http://example.org/devious' }] },
    }],
    ['isa implicit valueset', 'http://example.org/devious?fhir_vs=isa/ALPHA', null, {
      compose: { include: [{ system: 'http://example.org/devious', filter: [{ property: 'concept', op: 'is-a', value: 'ALPHA' }] }] },
    }],
    ['explicit table valueset', 'http://example.org/vs/labish', null, {
      compose: { include: [{ system: 'http://example.org/devious', concept: [{ code: 'ALPHA' }, { code: 'DELTA' }] }] },
    }],
    ['version mismatch rejects known valueset', 'http://example.org/vs/labish', 'wrong', null],
  ])('buildKnownValueSet: %s', async (name, url, version, expected) => {
    const factory = await makeFactory(fixture.dbPath);
    const valueSet = await factory.buildKnownValueSet(url, version);
    if (expected == null) {
      expect(valueSet).toBeNull();
    } else {
      expect(valueSet).toEqual(expect.objectContaining(expected));
    }
  });
});
