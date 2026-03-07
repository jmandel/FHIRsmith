'use strict';

require('../../tx/cs/cs-sqlite-v0-specializations');

const { SqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0');
const { LoincSqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0-loinc');
const { TestUtilities } = require('../test-utilities');
const { LOINC_DB, SNOMED_DB, hasLoinc, hasSnomed } = require('../v0-db-config');

const describeIfDBs = hasLoinc && hasSnomed ? describe : describe.skip;

let i18n;

beforeAll(async () => {
  const langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
});

describeIfDBs('sqlite-v0 specializations', () => {
  test('LOINC v0 databases resolve to the LOINC specialization', async () => {
    const factory = await SqliteV0FactoryProvider.createFromMetadata(i18n, LOINC_DB);
    expect(factory).toBeInstanceOf(LoincSqliteV0FactoryProvider);

    const vs = await factory.buildKnownValueSet('http://loinc.org/vs/LL2201-3', null);
    expect(vs?.compose?.include?.[0]?.concept?.length).toBe(8);
  });

  test('non-LOINC v0 databases stay on the generic sqlite-v0 factory', async () => {
    const factory = await SqliteV0FactoryProvider.createFromMetadata(i18n, SNOMED_DB);
    expect(factory).toBeInstanceOf(SqliteV0FactoryProvider);
    expect(factory).not.toBeInstanceOf(LoincSqliteV0FactoryProvider);
  });
});
