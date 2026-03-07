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

function paramValue(parameters, name, valueField) {
  return (parameters?.parameter || []).find(param => param.name === name)?.[valueField];
}

describe('ValueSet $validate-code with sqlite-v0 configured supplement sidecars', () => {
  let fixture;
  let system;
  let d20;
  let matchingCode;
  let nonMatchingCode;

  beforeAll(async () => {
    system = 'http://example.org/base';
    const version = '1';
    const baseConcepts = makeBaseConcepts(240);
    const base = {
      system,
      version,
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20'],
      urlRoot: 'http://example.org/fhir/CodeSystem/validate-dice',
      version,
      salt: 'validate-shared',
    });
    d20 = bundle[0].resource;
    matchingCode = d20.concept.find(concept =>
      (concept.property || []).some(prop => prop.code === 'd20-roll' && prop.valueInteger === 20)
    )?.code;
    nonMatchingCode = d20.concept.find(concept =>
      !(concept.property || []).some(prop => prop.code === 'd20-roll' && prop.valueInteger === 20)
    )?.code;

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

  test('validate-code honors supplement-backed filters from a server-loaded sqlite sidecar', async () => {
    expect(matchingCode).toBeTruthy();
    expect(nonMatchingCode).toBeTruthy();

    const valueSetResource = {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system,
          filter: [
            { property: 'd20-roll', op: '=', value: '20' },
          ],
        }],
      },
    };

    const positive = await request(fixture.app)
      .post('/tx/r5/ValueSet/$validate-code')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: system },
          { name: 'code', valueCode: matchingCode },
          { name: 'useSupplement', valueString: d20.url },
          { name: 'valueSet', resource: valueSetResource },
        ],
      });

    expect(positive.status).toBe(200);
    expect(paramValue(positive.body, 'result', 'valueBoolean')).toBe(true);

    const negative = await request(fixture.app)
      .post('/tx/r5/ValueSet/$validate-code')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: system },
          { name: 'code', valueCode: nonMatchingCode },
          { name: 'useSupplement', valueString: d20.url },
          { name: 'valueSet', resource: valueSetResource },
        ],
      });

    expect(negative.status).toBe(200);
    expect(paramValue(negative.body, 'result', 'valueBoolean')).toBe(false);
  }, 60000);

  test('inline tx-resource supplement is validate-equivalent to the configured sqlite sidecar', async () => {
    expect(matchingCode).toBeTruthy();

    const valueSetResource = {
      resourceType: 'ValueSet',
      status: 'active',
      compose: {
        include: [{
          system,
          filter: [{ property: 'd20-roll', op: '=', value: '20' }],
        }],
      },
    };

    const requestBody = (includeInline) => ({
      resourceType: 'Parameters',
      parameter: [
        { name: 'system', valueUri: system },
        { name: 'code', valueCode: matchingCode },
        { name: 'useSupplement', valueString: d20.url },
        ...(includeInline ? [{ name: 'tx-resource', resource: d20 }] : []),
        { name: 'valueSet', resource: valueSetResource },
      ],
    });

    const sidecarRes = await request(fixture.app)
      .post('/tx/r5/ValueSet/$validate-code')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(requestBody(false));

    const inlineRes = await request(fixture.app)
      .post('/tx/r5/ValueSet/$validate-code')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(requestBody(true));

    expect(sidecarRes.status).toBe(200);
    expect(inlineRes.status).toBe(200);
    expect(inlineRes.body).toEqual(sidecarRes.body);
  }, 60000);
});
