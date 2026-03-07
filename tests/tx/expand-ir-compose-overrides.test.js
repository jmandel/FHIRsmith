'use strict';

const path = require('path');
const request = require('supertest');

const {
  createManagedTxFixture,
  destroyManagedTxFixture,
} = require('../support/tx-integration-fixtures');

describe('IR $expand compose overrides', () => {
  let fixture;

  beforeAll(async () => {
    process.env.V0_DB_DIR = process.env.V0_DB_DIR || '/home/jmandel/hobby/sct/cache';
    fixture = await createManagedTxFixture({
      prefix: 'ir-compose-overrides-',
      setup: async () => ({
        configPath: path.resolve(__dirname, 'fixtures', 'v0-test-library.yaml'),
      }),
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('compose display overrides provider display', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: '_engine', valueString: 'ir' },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              compose: {
                include: [{
                  system: 'http://hl7.org/fhir/administrative-gender',
                  concept: [
                    { code: 'male', display: 'Masculin' },
                    { code: 'female' },
                  ],
                }],
              },
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    const contains = res.body.expansion.contains || [];
    expect(contains.find(c => c.code === 'male')?.display).toBe('Masculin');
    expect(contains.find(c => c.code === 'female')?.display).toBe('Female');
  });

  test('compose designations are preserved when includeDesignations is enabled', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: '_engine', valueString: 'ir' },
          { name: 'includeDesignations', valueBoolean: true },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              compose: {
                include: [{
                  system: 'http://hl7.org/fhir/administrative-gender',
                  concept: [{
                    code: 'male',
                    designation: [
                      { language: 'de', value: 'Männlich' },
                      { language: 'fr', value: 'Masculin' },
                    ],
                  }],
                }],
              },
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    const male = (res.body.expansion.contains || []).find(c => c.code === 'male');
    expect(male).toBeTruthy();
    const designations = male.designation || [];
    expect(designations).toEqual(expect.arrayContaining([
      expect.objectContaining({ language: 'de', value: 'Männlich' }),
      expect.objectContaining({ language: 'fr', value: 'Masculin' }),
    ]));
  });
});
