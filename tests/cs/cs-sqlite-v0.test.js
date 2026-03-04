'use strict';

const fs = require('fs');
const path = require('path');
const { SqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0');
const { OperationContext } = require('../../tx/operation-context');
const { Designations } = require('../../tx/library/designations');
const { TestUtilities } = require('../test-utilities');

const DB_DIR = '/home/exedev/tx-data';
const SNOMED_DB = path.join(DB_DIR, 'sct_intl_20250201.v0.db');
const LOINC_DB = path.join(DB_DIR, 'loinc_281_full.v0.db');
const RXNORM_DB = path.join(DB_DIR, 'rxnorm_02022026.v0.db');

// Skip all tests if v0 databases are not available
const hasDBs = fs.existsSync(SNOMED_DB) && fs.existsSync(LOINC_DB) && fs.existsSync(RXNORM_DB);
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

describeIfDBs('SqliteV0FactoryProvider', () => {
  describe('SNOMED CT', () => {
    let factory;

    beforeAll(async () => {
      factory = new SqliteV0FactoryProvider(i18n, SNOMED_DB);
      await factory.load();
    });

    test('factory metadata', () => {
      expect(factory.system()).toBe('http://snomed.info/sct');
      expect(factory.version()).toContain('snomed.info/sct');
      expect(factory.name()).toBe('SNOMED CT International');
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
      // SNOMED should have concept-valued properties (is-a)
      const conceptProps = props.filter(p => typeof p.value === 'object');
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
      expect(factory.version()).toContain('loinc.org');
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
});
