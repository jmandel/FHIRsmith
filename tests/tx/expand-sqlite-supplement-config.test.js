'use strict';

const fs = require('fs');
const path = require('path');
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

function conceptHasInteger(resource, code, propertyCode, expectedValue) {
  const concept = (resource?.concept || []).find(item => item.code === code);
  const prop = concept?.property?.find(item => item.code === propertyCode);
  return prop?.valueInteger === expectedValue;
}

function conceptHasDesignation(resource, code, fragment) {
  const concept = (resource?.concept || []).find(item => item.code === code);
  return (concept?.designation || []).some(item =>
    String(item.value || '').toLowerCase().includes(String(fragment || '').toLowerCase())
  );
}

describe('ValueSet $expand with sqlite-v0 configured supplement sidecars', () => {
  let fixture;
  let system;
  let baseConcepts;
  let d20;
  let d8;

  beforeAll(async () => {
    system = 'http://example.org/base';
    const version = '1';
    baseConcepts = makeBaseConcepts(320);
    const base = {
      system,
      version,
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20', 'd8'],
      urlRoot: 'http://example.org/fhir/CodeSystem/config-dice',
      version,
      salt: 'config-shared',
    });
    d20 = bundle.find(item => item.die === 'd20').resource;
    d8 = bundle.find(item => item.die === 'd8').resource;

    fixture = await createManagedTxFixture({
      prefix: 'sqlite-v0-supp-config-',
      setup: async ({ dir }) => {
        const built = buildTempV0DbFile(baseConcepts, { dir, system, version });
        const dbPath = built.dbPath;
        const d20Path = path.join(dir, 'd20.supp.db');
        const d8Path = path.join(dir, 'd8.supp.db');
        const configPath = path.join(dir, 'library.yaml');

        writeSupplementSidecar(d20Path, d20);
        writeSupplementSidecar(d8Path, d8);
        writeLibraryConfig(configPath, dbPath, ['d20.supp.db', 'd8.supp.db']);
        return { configPath };
      },
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('IR resolves server-loaded sqlite supplement sidecars from library config', async () => {
    const expectedCodes = baseConcepts
      .map(item => item.code)
      .filter(code =>
        conceptHasInteger(d20, code, 'd20-roll', 20)
        && conceptHasInteger(d8, code, 'd8-roll', 8)
      )
      .sort();

    const res = await request(fixture.app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: '_engine', valueCode: 'ir' },
          { name: 'useSupplement', valueString: d20.url },
          { name: 'useSupplement', valueString: d8.url },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [{
                  system,
                  filter: [
                    { property: 'd20-roll', op: '=', value: '20' },
                    { property: 'd8-roll', op: '=', value: '8' },
                  ],
                }],
              },
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    const actualCodes = (res.body.expansion?.contains || []).map(item => item.code).sort();
    expect(actualCodes).toEqual(expectedCodes);
    expect(res.body.expansion?.total).toBe(expectedCodes.length);
  }, 60000);

  test('IR text filter reaches server-loaded sqlite supplement designation rows from library config', async () => {
    const expectedCodes = baseConcepts
      .map(item => item.code)
      .filter(code => conceptHasDesignation(d8, code, 'critical success'))
      .sort();

    const res = await request(fixture.app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: '_engine', valueCode: 'ir' },
          { name: 'useSupplement', valueString: d8.url },
          { name: 'filter', valueString: 'critical success' },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [{ system }],
              },
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    const actualCodes = (res.body.expansion?.contains || []).map(item => item.code).sort();
    expect(actualCodes).toEqual(expectedCodes);
    expect(res.body.expansion?.total).toBe(expectedCodes.length);
  }, 60000);

  test('inline tx-resource supplement is expansion-equivalent to the configured sqlite sidecar', async () => {
    const requestBody = (includeInline) => ({
      resourceType: 'Parameters',
      parameter: [
        { name: '_engine', valueCode: 'ir' },
        { name: 'useSupplement', valueString: d20.url },
        ...(includeInline ? [{ name: 'tx-resource', resource: d20 }] : []),
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system,
                filter: [{ property: 'd20-roll', op: '=', value: '20' }],
              }],
            },
          },
        },
      ],
    });

    const sidecarRes = await request(fixture.app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(requestBody(false));

    const inlineRes = await request(fixture.app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(requestBody(true));

    expect(sidecarRes.status).toBe(200);
    expect(inlineRes.status).toBe(200);

    const sidecarCodes = (sidecarRes.body.expansion?.contains || []).map(item => item.code).sort();
    const inlineCodes = (inlineRes.body.expansion?.contains || []).map(item => item.code).sort();
    expect(inlineCodes).toEqual(sidecarCodes);
    expect(inlineRes.body.expansion?.total).toBe(sidecarRes.body.expansion?.total);
  }, 60000);

  test('legacy expand fails closed for configured sqlite supplement sidecars', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: '_engine', valueCode: 'legacy' },
          { name: 'useSupplement', valueString: d20.url },
          { name: 'useSupplement', valueString: d8.url },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [{
                  system,
                  filter: [
                    { property: 'd20-roll', op: '=', value: '20' },
                    { property: 'd8-roll', op: '=', value: '8' },
                  ],
                }],
              },
            },
          },
        ],
      });

    expect(res.status).toBe(422);
    const text = JSON.stringify(res.body);
    expect(text).toContain('Required supplements not found');
    expect(text).toContain(d20.url);
    expect(text).toContain(d8.url);
  }, 60000);
});
