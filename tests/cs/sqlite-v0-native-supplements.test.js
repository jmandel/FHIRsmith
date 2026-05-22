'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const BetterSqlite3 = require('better-sqlite3');
const { SqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0');
const { bindNativeSupplements, relevantSupplementBindings } = require('../../tx/cs/sqlite-v0-supplements');
const { OperationContext } = require('../../tx/operation-context');
const { Designations } = require('../../tx/library/designations');
const { TestUtilities } = require('../test-utilities');
const IR = require('../../tx/engine/ir');
const { wrapIRProviderWithSupplements } = require('../../tx/supplements/ir-provider');
const { buildDiceSupplementBundle } = require('../../tx/supplements/synthetic');
const { writeSupplementSidecar } = require('../../tx/supplements/sqlite-sidecar');
const { createSupplementRegistry, addInlineCodeSystems, addSqliteSidecars } = require('../../tx/supplements/registry');
const { resolveSupplementsForBaseScope } = require('../../tx/supplements/resolver');
const { makeSupplementRef } = require('../../tx/supplements/types');

let i18n;
let langDefs;

beforeAll(async () => {
  langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
});

function makeOpContext() {
  return new OperationContext('en', i18n);
}

function makeBaseConcepts(count = 64) {
  return Array.from({ length: count }, (_, index) => ({
    concept_id: index + 1,
    cs_id: 1,
    code: `C${String(index + 1).padStart(4, '0')}`,
    display: `Code ${index + 1}`,
    active: 1,
    definition: `Definition ${index + 1}`,
  }));
}

function buildTempV0DbFile(baseConcepts, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-v0-supp-native-'));
  const dbPath = path.join(dir, 'base.v0.db');
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
        cs_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        active INTEGER NOT NULL,
        display TEXT,
        definition TEXT
      );
      CREATE TABLE concept_literal (
        literal_id INTEGER PRIMARY KEY,
        edge_set_id INTEGER NOT NULL,
        source_concept_id INTEGER NOT NULL,
        property_id INTEGER NOT NULL,
        value_raw TEXT,
        value_text TEXT,
        value_num REAL,
        value_bool INTEGER,
        group_id INTEGER NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE TABLE concept_link (
        edge_id INTEGER PRIMARY KEY,
        edge_set_id INTEGER NOT NULL,
        source_concept_id INTEGER NOT NULL,
        property_id INTEGER NOT NULL,
        target_concept_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE TABLE designation (
        designation_id INTEGER PRIMARY KEY,
        concept_id INTEGER NOT NULL,
        active INTEGER NOT NULL,
        language_code TEXT,
        use_code TEXT,
        term TEXT NOT NULL,
        preferred INTEGER NOT NULL
      );
      CREATE TABLE closure (
        ancestor_id INTEGER NOT NULL,
        descendant_id INTEGER NOT NULL
      );
      CREATE TABLE value_set (
        vs_id INTEGER PRIMARY KEY,
        cs_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        version TEXT,
        name TEXT
      );
      CREATE TABLE value_set_member (
        member_id INTEGER PRIMARY KEY,
        vs_id INTEGER NOT NULL,
        concept_id INTEGER NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE search_fts_display USING fts5(term);
      CREATE VIRTUAL TABLE search_fts_designation USING fts5(term);
      CREATE VIRTUAL TABLE search_fts_literal USING fts5(term);
    `);

    const system = opts.system || 'http://example.org/base';
    const version = opts.version || '1';
    db.prepare(`
      INSERT INTO code_system
        (cs_id, base_uri, version, canonical_uri, release_date, loaded_at, name, edition_code)
      VALUES
        (1, @system, @version, @canonical, '2026-03-06', '2026-03-06T00:00:00Z', 'Synthetic Base', NULL)
    `).run({
      system,
      version,
      canonical: `${system}|${version}`,
    });

    db.prepare(`
      INSERT INTO cs_config (cs_id, key, value)
      VALUES (1, 'runtime.search', @value)
    `).run({
      value: JSON.stringify({
        mode: 'fts',
        sources: ['designation', 'literal'],
        activeOnly: true,
        designationActiveOnly: true,
        literalActiveOnly: true,
        ftsTables: {
          display: 'search_fts_display',
          designation: 'search_fts_designation',
          literal: 'search_fts_literal',
        },
      }),
    });

    const insConcept = db.prepare(`
      INSERT INTO concept (concept_id, cs_id, code, active, display, definition)
      VALUES (@concept_id, @cs_id, @code, @active, @display, @definition)
    `);
    const insDisplayFts = db.prepare('INSERT INTO search_fts_display(rowid, term) VALUES (@rowid, @term)');
    for (const concept of baseConcepts) {
      insConcept.run(concept);
      insDisplayFts.run({ rowid: concept.concept_id, term: concept.display });
    }
  } finally {
    db.close();
  }
  return { dir, dbPath };
}

async function resolveNativeSupplementSet(dbPaths, canonicalOrCanonicals, target) {
  const registry = createSupplementRegistry();
  addSqliteSidecars(registry, dbPaths);
  const canonicals = Array.isArray(canonicalOrCanonicals) ? canonicalOrCanonicals : [canonicalOrCanonicals];
  return await resolveSupplementsForBaseScope({
    target,
    refs: canonicals.map((canonical, index) => makeSupplementRef(canonical, 'useSupplement', index)),
    registry,
  });
}

async function resolveInlineSupplementSet(resources, canonical, target) {
  const registry = createSupplementRegistry();
  addInlineCodeSystems(registry, resources);
  return await resolveSupplementsForBaseScope({
    target,
    refs: [makeSupplementRef(canonical, 'useSupplement', 0)],
    registry,
  });
}

function uniqueCodes(result) {
  return [...new Set((result?.candidates || []).map(c => c.code))].sort();
}

function canonicalOf(resource) {
  return resource?.version ? `${resource.url}|${resource.version}` : resource?.url;
}

describe('sqlite-v0 native supplements', () => {
  test('native supplement manifest prunes bindings by property code and value kind', async () => {
    const baseConcepts = makeBaseConcepts(24);
    const system = 'http://example.org/base';
    const version = '1';
    const base = {
      system,
      version,
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20', 'd8'],
      urlRoot: 'http://example.org/fhir/CodeSystem/test-dice',
      version,
      salt: 'binding-prune',
    });
    const d20 = bundle.find(item => item.die === 'd20').resource;
    const d8 = bundle.find(item => item.die === 'd8').resource;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-v0-native-prune-'));
    const d20Path = path.join(dir, 'd20.supp.db');
    const d8Path = path.join(dir, 'd8.supp.db');
    const { dir: dbDir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });

    try {
      writeSupplementSidecar(d20Path, d20);
      writeSupplementSidecar(d8Path, d8);
      const supplementSet = await resolveNativeSupplementSet([d20Path, d8Path], [canonicalOf(d20), canonicalOf(d8)], { system, version });
      const db = new BetterSqlite3(dbPath);
      try {
        const native = bindNativeSupplements(db, supplementSet);
        expect(relevantSupplementBindings(native.bindings, 'd20-roll', { valueKind: 'literal' })).toHaveLength(1);
        expect(relevantSupplementBindings(native.bindings, 'd8-roll', { valueKind: 'literal' })).toHaveLength(1);
        expect(relevantSupplementBindings(native.bindings, 'damage-type', { valueKind: 'literal' })).toHaveLength(2);
        expect(relevantSupplementBindings(native.bindings, 'd20-roll', { valueKind: 'concept' })).toHaveLength(0);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test('native sqlite supplement filters and text search match generic overlay semantics', async () => {
    const baseConcepts = makeBaseConcepts(80);
    const system = 'http://example.org/base';
    const version = '1';
    const base = {
      system,
      version,
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20', 'd8'],
      urlRoot: 'http://example.org/fhir/CodeSystem/test-dice',
      version,
      salt: 'native-parity',
    });
    const d20 = bundle.find(item => item.die === 'd20').resource;
    const d8 = bundle.find(item => item.die === 'd8').resource;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-v0-native-supp-'));
    const d20Path = path.join(dir, 'd20.supp.db');
    const d8Path = path.join(dir, 'd8.supp.db');
    const { dir: dbDir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });

    try {
      writeSupplementSidecar(d20Path, d20);
      writeSupplementSidecar(d8Path, d8);

      const factory = new SqliteV0FactoryProvider(i18n, dbPath);
      await factory.load();

      const nativeProvider = await factory.build(makeOpContext(), []);
      const genericProvider = await factory.build(makeOpContext(), []);
      const nativeSet = await resolveNativeSupplementSet([d20Path, d8Path], canonicalOf(d20), { system, version });
      const inlineSet = await resolveInlineSupplementSet([d20, d8], canonicalOf(d20), { system, version });
      await nativeProvider.attachIRSupplements(nativeSet);
      expect(nativeProvider.propertyDefinitions().some(p => p.code === 'd20-roll')).toBe(true);
      expect(await nativeProvider.doesFilter('d20-roll', '=', '20')).toBe(true);
      const wrappedGeneric = wrapIRProviderWithSupplements(genericProvider, inlineSet);

      const targetCode = d20.concept.find(concept => {
        const roll = concept.property?.find(p => p.code === 'd20-roll')?.valueInteger;
        const damage = concept.property?.find(p => p.code === 'damage-type')?.valueCode;
        return roll === 20 && damage;
      })?.code;
      expect(targetCode).toBeTruthy();
      const targetDamage = d20.concept.find(concept => concept.code === targetCode)
        ?.property?.find(p => p.code === 'damage-type')?.valueCode;
      expect(targetDamage).toBeTruthy();

      const numericAndShared = IR.selector({
        system,
        version,
        shape: 'filter',
        filterClauses: [
          { property: 'd20-roll', op: '=', value: '20' },
          { property: 'damage-type', op: '=', value: targetDamage },
        ],
      });

      const nativeResult = nativeProvider.executeIR(numericAndShared, { count: 200 });
      const genericResult = await wrappedGeneric.executeIR(numericAndShared, { count: 200 });
      expect(uniqueCodes(nativeResult)).toEqual(uniqueCodes(genericResult));
      expect(nativeProvider.countForIR(numericAndShared)).toBe(await wrappedGeneric.countForIR(numericAndShared));

      const textSubtree = IR.selector({
        system,
        version,
        shape: 'whole',
      });
      const nativeText = nativeProvider.executeIR(textSubtree, { text: 'D20 critical success', count: 200 });
      const genericText = await wrappedGeneric.executeIR(textSubtree, { text: 'D20 critical success', count: 200 });
      expect(uniqueCodes(nativeText)).toEqual(uniqueCodes(genericText));

      const membership = nativeProvider.membershipForIR(numericAndShared);
      expect(membership.has(targetCode)).toBe(true);
      expect(membership.has('C0001')).toBe(uniqueCodes(nativeResult).includes('C0001'));

      nativeProvider.close();
      genericProvider.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test('native sqlite supplement bulk decoration methods expose supplement properties and designations', async () => {
    const baseConcepts = makeBaseConcepts(80);
    const system = 'http://example.org/base';
    const version = '1';
    const base = {
      system,
      version,
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20'],
      urlRoot: 'http://example.org/fhir/CodeSystem/test-dice',
      version,
      salt: 'native-decoration',
    });
    const d20 = bundle[0].resource;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-v0-native-deco-'));
    const d20Path = path.join(dir, 'd20.supp.db');
    const { dir: dbDir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });

    try {
      writeSupplementSidecar(d20Path, d20);
      const factory = new SqliteV0FactoryProvider(i18n, dbPath);
      await factory.load();
      const provider = await factory.build(makeOpContext(), []);
      const nativeSet = await resolveNativeSupplementSet([d20Path], canonicalOf(d20), { system, version });
      await provider.attachIRSupplements(nativeSet);

      const criticalConcept = d20.concept.find(concept => (concept.designation || []).length > 0);
      const criticalCode = criticalConcept?.code;
      const criticalLabel = criticalConcept?.designation?.[0]?.value;
      expect(criticalCode).toBeTruthy();
      expect(criticalLabel).toBeTruthy();
      const { context } = await provider.locate(criticalCode);
      expect(context).toBeTruthy();

      const displays = new Designations(langDefs);
      await provider.designations(context, displays);
      expect(displays.designations.some(d => d.value === criticalLabel)).toBe(true);

      const props = await provider.properties(context);
      expect(props.some(p => p.code === 'd20-roll')).toBe(true);
      expect(provider.propertyDefinitions().some(p => p.code === 'd20-roll')).toBe(true);
      expect(await provider.doesFilter('d20-roll', '=', '20')).toBe(true);

      const bulkDesignations = provider.bulkDesignations([context.concept_id]);
      expect((bulkDesignations.get(context.concept_id) || []).some(d => d.value === criticalLabel)).toBe(true);

      const bulkProperties = provider.bulkProperties([context.concept_id]);
      expect((bulkProperties.get(context.concept_id) || []).some(p => p.code === 'd20-roll')).toBe(true);

      provider.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test('inline supplement CodeSystem resources can be materialized into native sqlite attachments', async () => {
    const baseConcepts = makeBaseConcepts(80);
    const system = 'http://example.org/base';
    const version = '1';
    const base = {
      system,
      version,
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20', 'd8'],
      urlRoot: 'http://example.org/fhir/CodeSystem/test-dice',
      version,
      salt: 'inline-native',
    });
    const d20 = bundle.find(item => item.die === 'd20').resource;
    const d8 = bundle.find(item => item.die === 'd8').resource;
    const { dir: dbDir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });

    try {
      const factory = new SqliteV0FactoryProvider(i18n, dbPath);
      await factory.load();

      const nativeProvider = await factory.build(makeOpContext(), []);
      const genericProvider = await factory.build(makeOpContext(), []);
      const inlineSet = await resolveInlineSupplementSet([d20, d8], canonicalOf(d20), { system, version });
      await nativeProvider.attachIRSupplements(inlineSet);
      expect(nativeProvider._irAllSupplementsNativeBound).toBe(true);
      expect(nativeProvider.propertyDefinitions().some(p => p.code === 'd20-roll')).toBe(true);
      const wrappedGeneric = wrapIRProviderWithSupplements(genericProvider, inlineSet);

      const targetCode = d20.concept.find(concept => {
        const roll = concept.property?.find(p => p.code === 'd20-roll')?.valueInteger;
        const damage = concept.property?.find(p => p.code === 'damage-type')?.valueCode;
        return roll === 20 && damage;
      })?.code;
      const targetDamage = d20.concept.find(concept => concept.code === targetCode)
        ?.property?.find(p => p.code === 'damage-type')?.valueCode;
      expect(targetCode).toBeTruthy();
      expect(targetDamage).toBeTruthy();

      const numericAndShared = IR.selector({
        system,
        version,
        shape: 'filter',
        filterClauses: [
          { property: 'd20-roll', op: '=', value: '20' },
          { property: 'damage-type', op: '=', value: targetDamage },
        ],
      });

      const nativeResult = nativeProvider.executeIR(numericAndShared, { count: 200 });
      const genericResult = await wrappedGeneric.executeIR(numericAndShared, { count: 200 });
      expect(uniqueCodes(nativeResult)).toEqual(uniqueCodes(genericResult));
      expect(nativeProvider.countForIR(numericAndShared)).toBe(await wrappedGeneric.countForIR(numericAndShared));

      const textSubtree = IR.selector({
        system,
        version,
        shape: 'whole',
      });
      const nativeText = nativeProvider.executeIR(textSubtree, { text: 'D20 critical success', count: 200 });
      const genericText = await wrappedGeneric.executeIR(textSubtree, { text: 'D20 critical success', count: 200 });
      expect(uniqueCodes(nativeText)).toEqual(uniqueCodes(genericText));

      nativeProvider.close();
      genericProvider.close();
    } finally {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
