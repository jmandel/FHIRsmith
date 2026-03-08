'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const BetterSqlite3 = require('better-sqlite3');
const { SqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0');
const { OperationContext } = require('../../tx/operation-context');
const { Designations } = require('../../tx/library/designations');
const { TestUtilities } = require('../test-utilities');
const IR = require('../../tx/engine/ir');
const { SNOMED_DB, LOINC_DB, RXNORM_DB, hasSnomed, hasLoinc, hasRxnorm } = require('../v0-db-config');

// Skip all tests if v0 databases are not available
const hasDBs = hasSnomed && hasLoinc && hasRxnorm;
const describeIfDBs = hasDBs ? describe : describe.skip;

let i18n;
let langDefs;

beforeAll(async () => {
  langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
});

function makeOpContext() {
  return new OperationContext('en', i18n);
}

function versionDigitsToIso(version) {
  const v = String(version || '').trim();
  if (!/^\d{8}$/.test(v)) return null;

  const y = Number(v.slice(0, 4));
  const mo = Number(v.slice(4, 6));
  const d = Number(v.slice(6, 8));
  if (y >= 1800 && y <= 2400 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }

  const mo2 = Number(v.slice(0, 2));
  const d2 = Number(v.slice(2, 4));
  const y2 = Number(v.slice(4, 8));
  if (y2 >= 1800 && y2 <= 2400 && mo2 >= 1 && mo2 <= 12 && d2 >= 1 && d2 <= 31) {
    return `${v.slice(4, 8)}-${v.slice(0, 2)}-${v.slice(2, 4)}`;
  }

  return null;
}

function makeTempDuplicateCodeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-v0-dup-'));
  const dbPath = path.join(dir, 'dup.v0.db');
  const db = new BetterSqlite3(dbPath);
  try {
    db.exec(`
      CREATE TABLE code_system (
        cs_id INTEGER PRIMARY KEY,
        base_uri TEXT,
        version TEXT,
        canonical_uri TEXT,
        release_date TEXT,
        loaded_at TEXT,
        name TEXT,
        edition_code TEXT
      );
      CREATE TABLE cs_config (
        cs_id INTEGER,
        key TEXT,
        value TEXT
      );
      CREATE TABLE property_def (
        property_id INTEGER PRIMARY KEY,
        cs_id INTEGER,
        property_code TEXT,
        value_kind TEXT,
        is_hierarchy INTEGER,
        display TEXT
      );
      CREATE TABLE concept (
        concept_id INTEGER PRIMARY KEY,
        cs_id INTEGER,
        code TEXT,
        active INTEGER,
        display TEXT,
        definition TEXT
      );
    `);
    db.prepare(`
      INSERT INTO code_system (cs_id, base_uri, version, canonical_uri, release_date, loaded_at, name, edition_code)
      VALUES (1, 'urn:test:dup', '1', 'urn:test:dup|1', '2026-03-05', '2026-03-05T00:00:00Z', 'dup', NULL)
    `).run();
    db.prepare(`
      INSERT INTO concept (concept_id, cs_id, code, active, display, definition)
      VALUES (?, 1, 'DUP', 1, ?, NULL)
    `).run(1, 'Duplicate 1');
    db.prepare(`
      INSERT INTO concept (concept_id, cs_id, code, active, display, definition)
      VALUES (?, 1, 'DUP', 1, ?, NULL)
    `).run(2, 'Duplicate 2');
  } finally {
    db.close();
  }
  return { dbPath, dir };
}

describeIfDBs('SqliteV0FactoryProvider', () => {
  function uniqueCodes(result) {
    return [...new Set((result?.candidates || []).map(c => c.code))].sort();
  }

  describe('SNOMED CT', () => {
    let factory;

    beforeAll(async () => {
      factory = new SqliteV0FactoryProvider(i18n, SNOMED_DB);
      await factory.load();
    });

    test('factory metadata', () => {
      expect(factory.system()).toBe('http://snomed.info/sct');
      expect(factory.version()).toMatch(/^http:\/\/snomed\.info\/sct\/.+\/version\/\d{8}$/);
      expect(factory.name()).toBe('SNOMED CT International');
      expect(factory.releaseDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const m = factory.version().match(/\/version\/(\d{8})$/);
      expect(m).toBeTruthy();
      expect(factory.releaseDate()).toBe(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`);
    });

    test('locate concept', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const loc = await provider.locate('73211009');
      expect(loc.context).toBeTruthy();
      expect(loc.context.code).toBe('73211009');
      expect(loc.context.display).toBe('Diabetes mellitus');
      provider.close();
    });

    test('locate unknown code', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const loc = await provider.locate('NONEXISTENT');
      expect(loc.context).toBeNull();
      expect(loc.message).toBeTruthy();
      provider.close();
    });

    test('code/display/status methods', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const { context } = await provider.locate('73211009');
      expect(await provider.code(context)).toBe('73211009');
      expect(await provider.display(context)).toBe('Diabetes mellitus');
      expect(await provider.isAbstract(context)).toBe(false);
      expect(await provider.isInactive(context)).toBe(false);
      expect(await provider.getStatus(context)).toBe('active');
      provider.close();
    });

    test('designations', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const { context } = await provider.locate('73211009');
      const displays = new Designations(langDefs);
      await provider.designations(context, displays);
      expect(displays.designations.length).toBeGreaterThan(0);
      provider.close();
    });

    test('properties', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const { context } = await provider.locate('73211009');
      const props = await provider.properties(context);
      expect(props.length).toBeGreaterThan(0);
      // SNOMED concept-valued properties are represented as valueCode.
      const conceptProps = props.filter(p => typeof p.valueCode === 'string' && p.valueCode.length > 0);
      expect(conceptProps.length).toBeGreaterThan(0);
      provider.close();
    });

    test('totalCount', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const count = await provider.totalCount();
      expect(count).toBeGreaterThan(100000);
      provider.close();
    });

    test('is-a filter', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const prep = await provider.getPrepContext(true);
      await provider.filter(prep, 'concept', 'is-a', '73211009'); // Diabetes mellitus
      const sets = await provider.executeFilters(prep);
      expect(sets.length).toBe(1);
      const size = await provider.filterSize(prep, sets[0]);
      expect(size).toBeGreaterThan(10); // Many subtypes of diabetes

      // Iterate first result
      expect(await provider.filterMore(prep, sets[0])).toBe(true);
      const concept = await provider.filterConcept(prep, sets[0]);
      expect(concept.code).toBeTruthy();
      provider.close();
    });

    test('descendent-of filter', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const prep = await provider.getPrepContext(true);
      await provider.filter(prep, 'concept', 'descendent-of', '73211009');
      const sets = await provider.executeFilters(prep);
      const size = await provider.filterSize(prep, sets[0]);
      expect(size).toBeGreaterThan(10);

      // descendent-of should NOT include self
      let foundSelf = false;
      while (await provider.filterMore(prep, sets[0])) {
        const c = await provider.filterConcept(prep, sets[0]);
        if (c.code === '73211009') foundSelf = true;
      }
      expect(foundSelf).toBe(false);
      provider.close();
    });

    test('iteratorAll', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const iter = await provider.iteratorAll();
      expect(iter).toBeTruthy();
      const first = await provider.nextContext(iter);
      expect(first).toBeTruthy();
      expect(first.code).toBeTruthy();
      provider.close();
    });

    test('filterCheck', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const prep = await provider.getPrepContext(true);
      await provider.filter(prep, 'concept', 'is-a', '73211009');
      const sets = await provider.executeFilters(prep);

      // Check that Diabetes mellitus itself is in the is-a set
      const { context: dm } = await provider.locate('73211009');
      const check = await provider.filterCheck(prep, sets[0], dm);
      expect(check).toBe(true);

      provider.close();
    });

    test('buildKnownValueSet - all codes', async () => {
      const vs = await factory.buildKnownValueSet('http://snomed.info/sct?fhir_vs', null);
      expect(vs).toBeTruthy();
      expect(vs.compose.include).toHaveLength(1);
      expect(vs.compose.include[0].system).toBe('http://snomed.info/sct');
    });

    test('buildKnownValueSet - is-a', async () => {
      const vs = await factory.buildKnownValueSet('http://snomed.info/sct?fhir_vs=isa/73211009', null);
      expect(vs).toBeTruthy();
      expect(vs.compose.include[0].filter).toEqual([{
        property: 'concept', op: 'is-a', value: '73211009'
      }]);
    });
  });

  describe('LOINC', () => {
    let factory;

    beforeAll(async () => {
      factory = new SqliteV0FactoryProvider(i18n, LOINC_DB);
      await factory.load();
    });

    test('factory metadata', () => {
      expect(factory.system()).toBe('http://loinc.org');
      // LOINC version token should be numeric/dotted (e.g. 2.81), not a URI.
      expect(factory.version()).toMatch(/^\d+(?:\.\d+)*$/);
      expect(factory.releaseDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('locate and code/display', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const { context } = await provider.locate('2160-0');
      expect(context).toBeTruthy();
      expect(await provider.code(context)).toBe('2160-0');
      expect(await provider.display(context)).toContain('Creatinine');
      provider.close();
    });

    test('property filter (CLASSTYPE=1)', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const prep = await provider.getPrepContext(true);
      await provider.filter(prep, 'CLASSTYPE', '=', '1');
      const sets = await provider.executeFilters(prep);
      const size = await provider.filterSize(prep, sets[0]);
      expect(size).toBeGreaterThan(1000);
      provider.close();
    });

    test('hierarchy filter (is-a)', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const prep = await provider.getPrepContext(true);
      // LOINC parent hierarchy filter
      await provider.filter(prep, 'concept', 'is-a', 'LP7839-6');
      const sets = await provider.executeFilters(prep);
      const size = await provider.filterSize(prep, sets[0]);
      expect(size).toBeGreaterThan(0);
      provider.close();
    });

    test('designations include multiple', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const { context } = await provider.locate('2160-0');
      const displays = new Designations(langDefs);
      await provider.designations(context, displays);
      // LOINC has many designations per concept
      expect(displays.designations.length).toBeGreaterThan(3);
      provider.close();
    });
  });

  describe('RxNorm', () => {
    let factory;

    beforeAll(async () => {
      factory = new SqliteV0FactoryProvider(i18n, RXNORM_DB);
      await factory.load();
    });

    test('factory metadata', () => {
      expect(factory.system()).toBe('http://www.nlm.nih.gov/research/umls/rxnorm');
      expect(factory.releaseDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const expectedFromVersion = versionDigitsToIso(factory.defaultVersion());
      if (expectedFromVersion) {
        expect(factory.releaseDate()).toBe(expectedFromVersion);
      }
    });

    test('locate and code/display', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const { context } = await provider.locate('161');
      expect(context).toBeTruthy();
      expect(await provider.code(context)).toBe('161');
      expect(await provider.display(context)).toBe('acetaminophen');
      provider.close();
    });

    test('properties', async () => {
      const provider = await factory.build(makeOpContext(), null);
      const { context } = await provider.locate('161');
      const props = await provider.properties(context);
      expect(props.length).toBeGreaterThan(0);
      provider.close();
    });
  });

  describe('IR execution', () => {
    let sctFactory, loincFactory;

    beforeAll(async () => {
      sctFactory = new SqliteV0FactoryProvider(i18n, SNOMED_DB);
      await sctFactory.load();
      loincFactory = new SqliteV0FactoryProvider(i18n, LOINC_DB);
      await loincFactory.load();
    });

    test('executeIR with is-a filter selector', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
      });
      const result = provider.executeIR(subtree, { activeOnly: true });
      expect(result.candidates.length).toBeGreaterThan(10);
      // All should be active
      for (const c of result.candidates) {
        expect(c.active).toBe(true);
      }
      // Should include Diabetes mellitus itself
      expect(result.candidates.some(c => c.code === '73211009')).toBe(true);
      provider.close();
    });

    test('executeIR with diff (exclude subtypes)', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      // All diabetes minus Type 2 diabetes (44054006)
      const subtree = IR.diff(
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }),
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'is-a', value: '44054006' }],
        })
      );
      const result = provider.executeIR(subtree, { activeOnly: true });
      expect(result.candidates.length).toBeGreaterThan(0);
      // Should NOT include Type 2 diabetes mellitus
      expect(result.candidates.some(c => c.code === '44054006')).toBe(false);
      provider.close();
    });

    test('executeIR with union', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.union([
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'concept',
          conceptCodes: [{ code: '73211009' }, { code: '44054006' }],
        }),
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'concept',
          conceptCodes: [{ code: '46635009' }],
        }),
      ]);
      const result = provider.executeIR(subtree);
      expect(result.candidates.length).toBe(3);
      const codes = new Set(result.candidates.map(c => c.code));
      expect(codes.has('73211009')).toBe(true);
      expect(codes.has('44054006')).toBe(true);
      expect(codes.has('46635009')).toBe(true);
      provider.close();
    });

    test('executeIR with whole system (limited)', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'whole',
      });
      const result = provider.executeIR(subtree, { count: 10 });
      expect(result.candidates.length).toBe(10);
      provider.close();
    });

    test('executeIR with empty subtree', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const result = provider.executeIR(IR.empty());
      expect(result.candidates).toEqual([]);
      expect(result.total).toBe(0);
      provider.close();
    });

    test('membershipForIR', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
      });
      const membership = provider.membershipForIR(subtree);
      expect(membership.has('73211009')).toBe(true);   // DM itself
      expect(membership.has('44054006')).toBe(true);   // Type 2 DM (subtype)
      expect(membership.has('404684003')).toBe(false);  // Clinical finding (ancestor)
      provider.close();
    });

    test('countForIR', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
      });
      const total = provider.countForIR(subtree, { activeOnly: true });
      expect(total).toBeGreaterThan(10);

      // Count should match executeIR result length
      const result = provider.executeIR(subtree, { activeOnly: true });
      expect(total).toBe(result.candidates.length);
      provider.close();
    });

    test('deep pagination on same-system reachability diff preserves semantics', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.diff(
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'is-a', value: '404684003' }],
        }),
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        })
      );
      const total = provider.countForIR(subtree, { activeOnly: true });
      expect(total).toBeGreaterThan(100000);
      const result = provider.executeIR(subtree, { activeOnly: true, offset: total - 20, count: 20 });
      expect(result.total == null || result.total === total).toBe(true);
      expect(result.candidates).toHaveLength(20);
      const codes = result.candidates.map(c => c.code);
      expect([...codes].sort()).toEqual(codes);
      expect(new Set(codes).has('73211009')).toBe(false);
      expect(new Set(codes).has('44054006')).toBe(false);
      expect(new Set(codes).has('46635009')).toBe(false);
      provider.close();
    });

    test('same-system reachability intersection preserves subset semantics', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.intersect([
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'is-a', value: '404684003' }],
        }),
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        }),
      ]);
      const total = provider.countForIR(subtree, { activeOnly: true });
      expect(total).toBeGreaterThan(100);
      const membership = provider.membershipForIR(subtree);
      expect(membership.has('73211009')).toBe(true);
      expect(membership.has('44054006')).toBe(true);
      expect(membership.has('46635009')).toBe(true);
      const result = provider.executeIR(subtree, { activeOnly: true, offset: total - 20, count: 20 });
      const codes = result.candidates.map(c => c.code);
      expect(result.candidates).toHaveLength(20);
      expect([...codes].sort()).toEqual(codes);
      provider.close();
    });

    test('same-system reachability intersected with code regex preserves semantics', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.intersect([
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'is-a', value: '404684003' }],
        }),
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'filter',
          filterClauses: [{ property: 'code', op: 'regex', value: '^7[0-9]{4,}$' }],
        }),
      ]);

      const total = provider.countForIR(subtree, { activeOnly: true });
      expect(total).toBeGreaterThan(1000);

      const result = provider.executeIR(subtree, { activeOnly: true, offset: Math.floor(total / 2), count: 25 });
      expect(result.candidates).toHaveLength(25);
      for (const c of result.candidates) {
        expect(c.code.startsWith('7')).toBe(true);
      }
      const codes = result.candidates.map(c => c.code);
      expect([...codes].sort()).toEqual(codes);
      provider.close();
    });

    test('same-system reachability diff with runtime text preserves deep-page semantics', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.diff(
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'is-a', value: '404684003' }],
        }),
        IR.selector({
          system: 'http://snomed.info/sct',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
        })
      );

      const plainTotal = provider.countForIR(subtree, { activeOnly: true });
      const textTotal = provider.countForIR(subtree, { activeOnly: true, text: 'disease' });
      expect(textTotal).toBeGreaterThan(1000);
      expect(textTotal).toBeLessThan(plainTotal);

      const result = provider.executeIR(subtree, {
        activeOnly: true,
        text: 'disease',
        offset: Math.floor(textTotal / 2),
        count: 25,
      });
      expect(result.candidates).toHaveLength(25);
      const codes = result.candidates.map(c => c.code);
      expect([...codes].sort()).toEqual(codes);
      expect(new Set(codes).has('73211009')).toBe(false);
      expect(new Set(codes).has('44054006')).toBe(false);
      provider.close();
    });

    test('executeIR LOINC with property filter', async () => {
      const provider = await loincFactory.build(makeOpContext(), null);
      const subtree = IR.selector({
        system: 'http://loinc.org',
        shape: 'filter',
        filterClauses: [{ property: 'CLASSTYPE', op: '=', value: '1' }],
      });
      const result = provider.executeIR(subtree, { count: 20 });
      expect(result.candidates.length).toBe(20);
      expect(result.total == null || result.total > result.candidates.length).toBe(true);
      for (const c of result.candidates) {
        expect(c.code).toBeTruthy();
        expect(c.display).toBeTruthy();
      }
      provider.close();
    });

    test('same-system mixed property intersections preserve semantics', async () => {
      const provider = await loincFactory.build(makeOpContext(), null);
      const subtree = IR.selector({
        system: 'http://loinc.org',
        shape: 'filter',
        filterClauses: [
          { property: 'SCALE_TYP', op: '=', value: 'Qn' },
          { property: 'STATUS', op: '=', value: 'ACTIVE' },
        ],
      });

      const total = provider.countForIR(subtree, { activeOnly: true });
      expect(total).toBeGreaterThan(10000);

      const result = provider.executeIR(subtree, { activeOnly: true, count: 100 });
      expect(result.candidates).toHaveLength(100);
      const codes = result.candidates.map(c => c.code);
      expect([...codes].sort()).toEqual(codes);
      provider.close();
    });

    test('executeIR with text search', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
      });
      const result = provider.executeIR(subtree, { activeOnly: true, text: 'type 2', count: 50 });
      expect(result.candidates.length).toBeGreaterThan(0);
      // Should find type 2 diabetes concepts
      const hasType2 = result.candidates.some(c =>
        c.display?.toLowerCase().includes('type 2') ||
        c.display?.toLowerCase().includes('type ii')
      );
      expect(hasType2).toBe(true);
      provider.close();
    });

    test('executeIR text search matches legacy filter semantics', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
      });

      const irResult = provider.executeIR(subtree, { activeOnly: true, text: 'insulin', count: 500 });
      const irCodes = [...new Set(irResult.candidates.map(c => c.code))].sort();

      const prep = await provider.getPrepContext(true);
      await provider.filter(prep, 'concept', 'is-a', '73211009');
      await provider.searchFilter(prep, { filter: 'insulin' }, true);
      const sets = await provider.executeFilters(prep);
      const legacyCodes = new Set();
      while (await provider.filterMore(prep, sets[0])) {
        const concept = await provider.filterConcept(prep, sets[0]);
        if (!await provider.isInactive(concept)) {
          legacyCodes.add(await provider.code(concept));
        }
      }
      const legacySortedCodes = [...legacyCodes].sort();

      expect(irCodes).toEqual(legacySortedCodes);
      expect(irResult.candidates.length).toBe(legacySortedCodes.length);
      provider.close();
    });

    test('executeIR explicit concept membership with text search matches legacy filter semantics', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const codes = ['73211009', '44054006', '46635009'];
      const subtree = IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'concept',
        conceptCodes: codes.map(code => ({ code })),
      });

      const irResult = provider.executeIR(subtree, { text: 'type', count: 50 });
      const irCodes = [...new Set(irResult.candidates.map(c => c.code))].sort();
      expect(irCodes).toEqual(['44054006', '46635009']);
      provider.close();
    });

    test('executeIR with code regex filter uses sqlite regexp function', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'filter',
        filterClauses: [{ property: 'code', op: 'regex', value: '^7[0-9]{4,}$' }],
      });
      const result = provider.executeIR(subtree, { count: 25 });
      expect(result.candidates.length).toBe(25);
      for (const c of result.candidates) {
        expect(c.code.startsWith('7')).toBe(true);
      }
      provider.close();
    });

    test('countForIR with code regex filter', async () => {
      const provider = await sctFactory.build(makeOpContext(), null);
      const subtree = IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'filter',
        filterClauses: [{ property: 'code', op: 'regex', value: '^7[0-9]{4,}$' }],
      });
      const total = provider.countForIR(subtree, {});
      expect(total).toBeGreaterThan(1000);
      const sample = provider.executeIR(subtree, { count: 50 });
      expect(total).toBeGreaterThanOrEqual(sample.candidates.length);
      provider.close();
    });

  });
});

describe('SqliteV0FactoryProvider invariants', () => {
  test('load rejects duplicate codes within one scoped code system', async () => {
    const { dbPath, dir } = makeTempDuplicateCodeDb();
    try {
      const factory = new SqliteV0FactoryProvider(i18n, dbPath);
      await expect(factory.load()).rejects.toThrow(/duplicate code 'DUP'/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
