'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { buildDiceSupplementBundle } = require('../../tx/supplements/synthetic');
const { writeSupplementSidecar } = require('../../tx/supplements/sqlite-sidecar');
const {
  buildTempV0DbFile,
  createTempTxApp,
  makeBaseConcepts,
  writeLibraryConfig,
} = require('../support/sqlite-v0-supplement-fixtures');

function paramValue(parameters, name, valueField) {
  return (parameters?.parameter || []).find(param => param.name === name)?.[valueField];
}

describe('ValueSet $validate-code with sqlite-v0 configured supplement sidecars', () => {
  test('validate-code honors supplement-backed filters from a server-loaded sqlite sidecar', async () => {
    const system = 'http://example.org/base';
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
      salt: 'validate-config',
    });
    const d20 = bundle[0].resource;
    const matchingCode = d20.concept.find(concept =>
      (concept.property || []).some(prop => prop.code === 'd20-roll' && prop.valueInteger === 20)
    )?.code;
    const nonMatchingCode = d20.concept.find(concept =>
      !(concept.property || []).some(prop => prop.code === 'd20-roll' && prop.valueInteger === 20)
    )?.code;
    expect(matchingCode).toBeTruthy();
    expect(nonMatchingCode).toBeTruthy();

    const { dir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });
    const d20Path = path.join(dir, 'd20.supp.db');
    const configPath = path.join(dir, 'library.yaml');
    let txModule = null;

    try {
      writeSupplementSidecar(d20Path, d20);
      writeLibraryConfig(configPath, dbPath, ['d20.supp.db']);

      const { app, txModule: loaded } = await createTempTxApp(configPath);
      txModule = loaded;

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

      const positive = await request(app)
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

      const negative = await request(app)
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
    } finally {
      if (txModule) {
        await txModule.shutdown();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test('inline tx-resource supplement is validate-equivalent to the configured sqlite sidecar', async () => {
    const system = 'http://example.org/base';
    const version = '1';
    const baseConcepts = makeBaseConcepts(180);
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
      salt: 'validate-inline-eq',
    });
    const d20 = bundle[0].resource;
    const matchingCode = d20.concept.find(concept =>
      (concept.property || []).some(prop => prop.code === 'd20-roll' && prop.valueInteger === 20)
    )?.code;
    expect(matchingCode).toBeTruthy();

    const { dir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });
    const d20Path = path.join(dir, 'd20.supp.db');
    const configPath = path.join(dir, 'library.yaml');
    let txModule = null;

    try {
      writeSupplementSidecar(d20Path, d20);
      writeLibraryConfig(configPath, dbPath, ['d20.supp.db']);

      const { app, txModule: loaded } = await createTempTxApp(configPath);
      txModule = loaded;

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

      const sidecarRes = await request(app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(requestBody(false));

      const inlineRes = await request(app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(requestBody(true));

      expect(sidecarRes.status).toBe(200);
      expect(inlineRes.status).toBe(200);
      expect(inlineRes.body).toEqual(sidecarRes.body);
    } finally {
      if (txModule) {
        await txModule.shutdown();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
