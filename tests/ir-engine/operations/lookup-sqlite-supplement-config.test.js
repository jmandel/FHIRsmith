'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { buildDiceSupplementBundle } = require('../../../tx/supplements/synthetic');
const { writeSupplementSidecar } = require('../../../tx/supplements/sqlite-sidecar');
const {
  buildTempV0DbFile,
  makeBaseConcepts,
  writeLibraryConfig,
} = require('../../support/sqlite-v0-supplement-fixtures');
const {
  createManagedTxFixture,
  destroyManagedTxFixture,
} = require('../../support/tx-integration-fixtures');

function getLookupParams(body) {
  return body?.parameter || [];
}

function propertyParts(params, code) {
  return params
    .filter(param => param.name === 'property')
    .map(param => param.part || [])
    .filter(parts => parts.some(part => part.name === 'code' && part.valueCode === code));
}

describe('CodeSystem $lookup with sqlite-v0 configured supplement sidecars', () => {
  let fixture;
  let system;
  let d20;
  let targetConcept;

  beforeAll(async () => {
    system = 'http://example.org/base';
    const version = '1';
    const baseConcepts = makeBaseConcepts(120);
    const base = {
      system,
      version,
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20'],
      urlRoot: 'http://example.org/fhir/CodeSystem/lookup-dice',
      version,
      salt: 'lookup-shared',
    });
    d20 = bundle[0].resource;
    targetConcept = d20.concept.find(concept =>
      (concept.property || []).some(prop => prop.code === 'd20-roll' && prop.valueInteger === 20)
    );

    fixture = await createManagedTxFixture({
      prefix: 'sqlite-v0-supp-config-',
      setup: async ({ dir }) => {
        const built = buildTempV0DbFile(baseConcepts, { dir, system, version });
        const dbPath = built.dbPath;
        const d20Path = path.join(dir, 'd20.supp.db');
        const configPath = path.join(dir, 'library.yaml');

        writeSupplementSidecar(d20Path, d20);
        writeLibraryConfig(configPath, dbPath, ['d20.supp.db']);
        return { configPath };
      },
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('lookup returns supplement properties and designations from a server-loaded sqlite sidecar', async () => {
    expect(targetConcept).toBeTruthy();

    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$lookup')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: system },
          { name: 'code', valueCode: targetConcept.code },
          { name: 'useSupplement', valueString: d20.url },
        ],
      });

    expect(res.status).toBe(200);
    const params = getLookupParams(res.body);

    expect(params.some(param => param.name === 'designation'
      && (param.part || []).some(part => part.name === 'value' && String(part.valueString || '').includes('critical success'))
    )).toBe(true);

    const d20Roll = propertyParts(params, 'd20-roll');
    expect(d20Roll.length).toBeGreaterThan(0);
    expect(d20Roll.some(parts =>
      parts.some(part => part.name === 'value' && part.valueInteger === 20)
    )).toBe(true);
  }, 60000);

  test('inline tx-resource supplement is lookup-equivalent to the configured sqlite sidecar', async () => {
    expect(targetConcept).toBeTruthy();

    const requestBody = (includeInline) => ({
      resourceType: 'Parameters',
      parameter: [
        { name: 'system', valueUri: system },
        { name: 'code', valueCode: targetConcept.code },
        { name: 'useSupplement', valueString: d20.url },
        ...(includeInline ? [{ name: 'tx-resource', resource: d20 }] : []),
      ],
    });

    const sidecarRes = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$lookup')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(requestBody(false));

    const inlineRes = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$lookup')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(requestBody(true));

    expect(sidecarRes.status).toBe(200);
    expect(inlineRes.status).toBe(200);
    expect(inlineRes.body).toEqual(sidecarRes.body);
  }, 60000);
});
