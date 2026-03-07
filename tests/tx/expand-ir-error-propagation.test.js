'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('yaml');
const request = require('supertest');

const { buildDiceSupplementBundle } = require('../../tx/supplements/synthetic');
const { writeSupplementSidecar } = require('../../tx/supplements/sqlite-sidecar');
const { createTempTxApp } = require('../support/sqlite-v0-supplement-fixtures');
const {
  buildTempV0DbFile,
  makeBaseConcepts,
  writeLibraryConfig,
} = require('../support/sqlite-v0-supplement-fixtures');

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
  test.each([
    ['ir'],
    ['ir-strict'],
  ])('%s preserves explicit supplement ambiguity errors instead of falling back', async (engine) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-ir-error-prop-'));
    const configPath = path.join(dir, 'library.yaml');
    let txModule = null;

    try {
      writeAdapterLibraryConfig(configPath);
      const { app, txModule: loaded } = await createTempTxApp(configPath);
      txModule = loaded;

      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(makeRequestBody(engine, ambiguousSupplements()));

      expect(res.status).toBe(422);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue?.[0]?.details?.text || '').toContain('Ambiguous supplement');
      expect(res.body.issue?.[0]?.details?.text || '').toContain('http://example.org/supp/ambiguous-us-states');
      expect(res.body.issue?.[0]?.details?.text || '').not.toContain('IR engine cannot handle this ValueSet');
    } finally {
      if (txModule) {
        await txModule.shutdown();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test.each([
    ['ir'],
    ['ir-strict'],
  ])('%s preserves native supplement attachment failures instead of relabeling them', async (engine) => {
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
    const d20 = bundle[0].resource;

    const { dir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });
    const suppPath = path.join(dir, 'd20.supp.db');
    const configPath = path.join(dir, 'library.yaml');
    let txModule = null;

    try {
      writeSupplementSidecar(suppPath, d20);
      writeLibraryConfig(configPath, dbPath, ['d20.supp.db']);
      const { app, txModule: loaded } = await createTempTxApp(configPath);
      txModule = loaded;

      fs.rmSync(suppPath, { force: true });

      const res = await request(app)
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
                    system,
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
    } finally {
      if (txModule) {
        await txModule.shutdown();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
