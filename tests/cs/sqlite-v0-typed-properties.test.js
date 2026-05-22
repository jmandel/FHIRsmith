'use strict';

const fs = require('fs');

const { SqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0');
const { OperationContext } = require('../../tx/operation-context');
const { buildTempV0DbFile } = require('../support/sqlite-v0-supplement-fixtures');
const { TestUtilities } = require('../test-utilities');

function makeBaseConcepts() {
  return [
    {
      concept_id: 1,
      cs_id: 1,
      code: 'A',
      display: 'Alpha',
      active: 1,
      definition: 'Alpha definition',
    },
    {
      concept_id: 2,
      cs_id: 1,
      code: 'B',
      display: 'Beta',
      active: 1,
      definition: 'Beta definition',
    },
  ];
}

describe('sqlite-v0 typed base properties', () => {
  let i18n;

  beforeAll(async () => {
    const langDefs = await TestUtilities.loadLanguageDefinitions();
    i18n = await TestUtilities.loadTranslations(langDefs);
  });

  function buildTypedBaseDb() {
    return buildTempV0DbFile(makeBaseConcepts(), {
      system: 'http://example.org/base',
      version: '1',
      propertyDefs: [
        { property_id: 1, property_code: 'rank', value_kind: 'literal', source_type: 'integer', display: 'Rank' },
        { property_id: 2, property_code: 'critical', value_kind: 'literal', source_type: 'boolean', display: 'Critical' },
        { property_id: 3, property_code: 'damage-type', value_kind: 'literal', source_type: 'code', display: 'Damage Type' },
        { property_id: 4, property_code: 'parent', value_kind: 'concept', display: 'Parent' },
      ],
      literals: [
        { source_concept_id: 1, property_code: 'rank', value_num: 20 },
        { source_concept_id: 1, property_code: 'critical', value_bool: 1 },
        { source_concept_id: 1, property_code: 'damage-type', value_text: 'fire', value_raw: 'fire' },
      ],
      links: [
        { source_concept_id: 2, property_code: 'parent', target_concept_id: 1 },
      ],
    });
  }

  test('propertyDefinitions and property fetchers preserve typed value[x] for base literals and concept-valued links', async () => {
    const { dir, dbPath } = buildTypedBaseDb();
    let factory = null;
    try {
      factory = new SqliteV0FactoryProvider(i18n, dbPath);
      await factory.load();
      const provider = await factory.build(new OperationContext('en', i18n), null);

      expect(provider.propertyDefinitions()).toEqual(expect.arrayContaining([
        { code: 'rank', type: 'integer', description: 'Rank' },
        { code: 'critical', type: 'boolean', description: 'Critical' },
        { code: 'damage-type', type: 'code', description: 'Damage Type' },
        { code: 'parent', type: 'code', description: 'Parent' },
      ]));

      const { context: aContext } = await provider.locate('A');
      const aProps = await provider.properties(aContext);
      expect(aProps).toEqual(expect.arrayContaining([
        { code: 'rank', valueInteger: 20 },
        { code: 'critical', valueBoolean: true },
        { code: 'damage-type', valueCode: 'fire' },
      ]));

      const { context: bContext } = await provider.locate('B');
      const bProps = await provider.properties(bContext);
      expect(bProps).toEqual(expect.arrayContaining([
        { code: 'parent', valueCode: 'A' },
      ]));

      const bulk = provider.bulkProperties([aContext.concept_id, bContext.concept_id]);
      expect(bulk.get(aContext.concept_id)).toEqual(expect.arrayContaining([
        { code: 'rank', valueInteger: 20 },
        { code: 'critical', valueBoolean: true },
        { code: 'damage-type', valueCode: 'fire' },
      ]));
      expect(bulk.get(bContext.concept_id)).toEqual(expect.arrayContaining([
        { code: 'parent', valueCode: 'A' },
      ]));

      provider.close();
    } finally {
      if (factory) factory.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
