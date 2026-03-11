'use strict';

const path = require('path');
const request = require('supertest');

const {
  createManagedTxFixture,
  destroyManagedTxFixture,
} = require('../../support/tx-integration-fixtures');
const { DB_DIR, hasSnomed } = require('../../v0-db-config');

const describeIfSnomed = hasSnomed ? describe : describe.skip;

function propertyParts(parameters, code) {
  return (parameters || [])
    .filter((param) => param.name === 'property')
    .map((param) => param.part || [])
    .filter((parts) => parts.some((part) => part.name === 'code' && part.valueCode === code));
}

describeIfSnomed('IR lookup on sqlite-v0 concept-valued properties', () => {
  let fixture;

  beforeAll(async () => {
    process.env.V0_DB_DIR = DB_DIR;
    fixture = await createManagedTxFixture({
      prefix: 'lookup-ir-snomed-',
      setup: async () => ({
        configPath: path.join(__dirname, '..', '..', 'tx', 'fixtures', 'v0-test-library.yaml'),
      }),
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('returns parent as valueCode property parts for SNOMED lookup', async () => {
    const res = await request(fixture.app)
      .get('/tx/r5/CodeSystem/$lookup')
      .query({
        _engine: 'ir',
        system: 'http://snomed.info/sct',
        code: '73211009',
        property: 'parent',
      });

    expect(res.status).toBe(200);
    const params = res.body?.parameter || [];
    const parentProps = propertyParts(params, 'parent');
    expect(parentProps.length).toBeGreaterThan(0);
    expect(parentProps.some((parts) =>
      parts.some((part) => part.name === 'value' && typeof part.valueCode === 'string' && part.valueCode.length > 0)
    )).toBe(true);
    expect(parentProps.some((parts) =>
      parts.some((part) => part.name === 'description' && typeof part.valueString === 'string' && part.valueString.length > 0)
    )).toBe(true);
  }, 60000);
});
