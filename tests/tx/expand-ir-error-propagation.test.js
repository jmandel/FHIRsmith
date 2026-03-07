'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const request = require('supertest');

const { buildDiceSupplementBundle } = require('../../tx/supplements/synthetic');
const { writeSupplementSidecar } = require('../../tx/supplements/sqlite-sidecar');
const {
  buildTempV0DbFile,
  makeBaseConcepts,
  writeLibraryConfig,
} = require('../support/sqlite-v0-supplement-fixtures');
const {
  createManagedTxFixture,
  destroyManagedTxFixture,
} = require('../support/tx-integration-fixtures');

function writeAdapterLibraryConfig(configPath) {
  const config = {
    base: {
      url: 'https://storage.googleapis.com/tx-fhir-org',
    },
    sources: [
      'internal:usstates',
    ],
  };
  fs.writeFileSync(configPath, yaml.stringify(config), 'utf8');
}

function ambiguousSupplements() {
  const common = {
    resourceType: 'CodeSystem',
    url: 'http://example.org/supp/ambiguous-us-states',
    status: 'active',
    content: 'supplement',
    supplements: 'https://www.usps.com/',
    concept: [
      { code: 'OK', property: [{ code: 'd20-roll', valueInteger: 20 }] },
    ],
  };

  return [
    { ...common, version: '1.0.0' },
    { ...common, version: '2.0.0' },
  ];
}

function makeRequestBody(engine, supplements) {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: '_engine', valueCode: engine },
      { name: 'useSupplement', valueString: 'http://example.org/supp/ambiguous-us-states' },
      ...supplements.map(resource => ({ name: 'tx-resource', resource })),
      {
        name: 'valueSet',
        resource: {
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'https://www.usps.com/',
              concept: [{ code: 'OK' }],
            }],
          },
        },
      },
    ],
  };
}

describe('IR supplement runtime error propagation', () => {
  describe('supplement ambiguity', () => {
    let fixture;

    beforeAll(async () => {
      fixture = await createManagedTxFixture({
        prefix: 'tx-ir-error-prop-',
        setup: async ({ dir }) => {
          const configPath = path.join(dir, 'library.yaml');
          writeAdapterLibraryConfig(configPath);
          return { configPath };
        },
      });
    });

    afterAll(async () => {
      await destroyManagedTxFixture(fixture);
    });

    test.each([
      ['ir'],
      ['ir-strict'],
    ])('%s preserves explicit supplement ambiguity errors instead of falling back', async (engine) => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(makeRequestBody(engine, ambiguousSupplements()));

      expect(res.status).toBe(422);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue?.[0]?.details?.text || '').toContain('Ambiguous supplement');
      expect(res.body.issue?.[0]?.details?.text || '').toContain('http://example.org/supp/ambiguous-us-states');
      expect(res.body.issue?.[0]?.details?.text || '').not.toContain('IR engine cannot handle this ValueSet');
    }, 60000);
  });

  describe('native attachment failures', () => {
    let fixture;
    let d20;

    beforeAll(async () => {
      fixture = await createManagedTxFixture({
        prefix: 'sqlite-v0-supp-config-',
        setup: async ({ dir }) => {
          const system = 'http://example.org/base';
          const version = '1';
          const baseConcepts = makeBaseConcepts(60);
          const base = {
            system,
            version,
            name: 'Synthetic Base',
            codes: baseConcepts.map(c => ({ code: c.code })),
          };
          const bundle = buildDiceSupplementBundle(base, {
            dice: ['d20'],
            urlRoot: 'http://example.org/fhir/CodeSystem/error-prop-dice',
            version,
            salt: 'ir-error-prop',
          });
          d20 = bundle[0].resource;

          const built = buildTempV0DbFile(baseConcepts, { dir, system, version });
          const dbPath = built.dbPath;
          const suppPath = path.join(dir, 'd20.supp.db');
          const configPath = path.join(dir, 'library.yaml');
          writeSupplementSidecar(suppPath, d20);
          writeLibraryConfig(configPath, dbPath, ['d20.supp.db']);
          fs.rmSync(suppPath, { force: true });
          return { configPath };
        },
      });
    });

    afterAll(async () => {
      await destroyManagedTxFixture(fixture);
    });

    test.each([
      ['ir'],
      ['ir-strict'],
    ])('%s preserves native supplement attachment failures instead of relabeling them', async (engine) => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: '_engine', valueCode: engine },
            { name: 'useSupplement', valueString: d20.url },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                status: 'active',
                compose: {
                  include: [{
                    system: 'http://example.org/base',
                    concept: [{ code: 'C0001' }],
                  }],
                },
              },
            },
          ],
        });

      expect(res.status).toBe(500);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue?.[0]?.code).toBe('exception');
      expect(res.body.issue?.[0]?.details?.text || '').toContain('unable to open database file');
      expect(res.body.issue?.[0]?.details?.text || '').not.toContain('IR engine cannot handle this ValueSet');
    }, 60000);
  });
});
