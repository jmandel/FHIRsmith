'use strict';

const path = require('path');
const request = require('supertest');

const {
  buildTempV0DbFile,
  writeLibraryConfig,
} = require('../../support/sqlite-v0-supplement-fixtures');
const {
  createManagedTxFixture,
  destroyManagedTxFixture,
} = require('../../support/tx-integration-fixtures');

function findProperty(resource, conceptCode, propertyCode) {
  const concept = (resource?.expansion?.contains || []).find(item => item.code === conceptCode);
  return (concept?.property || []).find(item => item.code === propertyCode);
}

function buildTypedBaseDb(dir) {
  return buildTempV0DbFile([
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
  ], {
    dir,
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

function makeExpandBody(engine) {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: '_engine', valueCode: engine },
      { name: 'property', valueString: '*' },
      {
        name: 'valueSet',
        resource: {
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://example.org/base',
              concept: [{ code: 'A' }, { code: 'B' }],
            }],
          },
        },
      },
    ],
  };
}

function makeLegacyExpandBody() {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: '_engine', valueCode: 'legacy' },
      { name: 'property', valueString: 'rank' },
      { name: 'property', valueString: 'critical' },
      { name: 'property', valueString: 'damage-type' },
      { name: 'property', valueString: 'parent' },
      {
        name: 'valueSet',
        resource: {
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://example.org/base',
              concept: [{ code: 'A' }, { code: 'B' }],
            }],
          },
        },
      },
    ],
  };
}

describe('sqlite-v0 typed base properties through expand', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await createManagedTxFixture({
      prefix: 'sqlite-v0-supp-config-',
      setup: async ({ dir }) => {
        const built = buildTypedBaseDb(dir);
        const configPath = path.join(dir, 'library.yaml');
        writeLibraryConfig(configPath, built.dbPath, []);
        return { configPath };
      },
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('IR expand preserves typed base sqlite-v0 literal properties and emits expansion.property metadata', async () => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(makeExpandBody('ir'));

      expect(res.status).toBe(200);
      expect(findProperty(res.body, 'A', 'rank')).toEqual({ code: 'rank', valueInteger: 20 });
      expect(findProperty(res.body, 'A', 'critical')).toEqual({ code: 'critical', valueBoolean: true });
      expect(findProperty(res.body, 'A', 'damage-type')).toEqual({ code: 'damage-type', valueCode: 'fire' });
      expect(findProperty(res.body, 'B', 'parent')).toEqual({ code: 'parent', valueCode: 'A' });
      expect((res.body.expansion?.property || []).map(p => p.code)).toEqual(
        expect.arrayContaining(['rank', 'critical', 'damage-type', 'parent'])
      );
      expect((res.body.expansion?.property || []).find(p => p.code === 'parent')).toMatchObject({ type: 'code' });
  }, 60000);

  test('legacy expand still serializes typed base sqlite-v0 literal properties correctly', async () => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(makeLegacyExpandBody());

      expect(res.status).toBe(200);
      expect(findProperty(res.body, 'A', 'rank')).toEqual({ code: 'rank', valueInteger: 20 });
      expect(findProperty(res.body, 'A', 'critical')).toEqual({ code: 'critical', valueBoolean: true });
      expect(findProperty(res.body, 'A', 'damage-type')).toEqual({ code: 'damage-type', valueCode: 'fire' });
      expect(findProperty(res.body, 'B', 'parent')).toEqual({ code: 'parent', valueCode: 'A' });
  }, 60000);
});
