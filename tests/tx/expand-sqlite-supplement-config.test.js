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
  test('IR resolves server-loaded sqlite supplement sidecars from library config', async () => {
    const system = 'http://example.org/base';
    const version = '1';
    const baseConcepts = makeBaseConcepts(320);
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
      salt: 'config-ir',
    });
    const d20 = bundle.find(item => item.die === 'd20').resource;
    const d8 = bundle.find(item => item.die === 'd8').resource;
    const { dir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });
    const d20Path = path.join(dir, 'd20.supp.db');
    const d8Path = path.join(dir, 'd8.supp.db');
    const configPath = path.join(dir, 'library.yaml');
    let txModule = null;

    try {
      writeSupplementSidecar(d20Path, d20);
      writeSupplementSidecar(d8Path, d8);
      writeLibraryConfig(configPath, dbPath, ['d20.supp.db', 'd8.supp.db']);

      const { app, txModule: loaded } = await createTempTxApp(configPath);
      txModule = loaded;

      const expectedCodes = baseConcepts
        .map(item => item.code)
        .filter(code =>
          conceptHasInteger(d20, code, 'd20-roll', 20)
          && conceptHasInteger(d8, code, 'd8-roll', 8)
        )
        .sort();

      const res = await request(app)
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
    } finally {
      if (txModule) {
        await txModule.shutdown();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test('IR text filter reaches server-loaded sqlite supplement designation rows from library config', async () => {
    const system = 'http://example.org/base';
    const version = '1';
    const baseConcepts = makeBaseConcepts(160);
    const base = {
      system,
      version,
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d8'],
      urlRoot: 'http://example.org/fhir/CodeSystem/config-dice',
      version,
      salt: 'config-ir-text',
    });
    const d8 = bundle[0].resource;
    const { dir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });
    const d8Path = path.join(dir, 'd8.supp.db');
    const configPath = path.join(dir, 'library.yaml');
    let txModule = null;

    try {
      writeSupplementSidecar(d8Path, d8);
      writeLibraryConfig(configPath, dbPath, ['d8.supp.db']);

      const { app, txModule: loaded } = await createTempTxApp(configPath);
      txModule = loaded;

      const expectedCodes = baseConcepts
        .map(item => item.code)
        .filter(code => conceptHasDesignation(d8, code, 'critical success'))
        .sort();

      const res = await request(app)
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
    } finally {
      if (txModule) {
        await txModule.shutdown();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test('inline tx-resource supplement is expansion-equivalent to the configured sqlite sidecar', async () => {
    const system = 'http://example.org/base';
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
      urlRoot: 'http://example.org/fhir/CodeSystem/config-dice',
      version,
      salt: 'config-ir-inline-eq',
    });
    const d20 = bundle[0].resource;
    const { dir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });
    const d20Path = path.join(dir, 'd20.supp.db');
    const configPath = path.join(dir, 'library.yaml');
    let txModule = null;

    try {
      writeSupplementSidecar(d20Path, d20);
      writeLibraryConfig(configPath, dbPath, ['d20.supp.db']);

      const { app, txModule: loaded } = await createTempTxApp(configPath);
      txModule = loaded;

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

      const sidecarRes = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(requestBody(false));

      const inlineRes = await request(app)
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
    } finally {
      if (txModule) {
        await txModule.shutdown();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test('legacy expand fails closed for configured sqlite supplement sidecars', async () => {
    const system = 'http://example.org/base';
    const version = '1';
    const baseConcepts = makeBaseConcepts(320);
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
      salt: 'config-legacy-guard',
    });
    const d20 = bundle.find(item => item.die === 'd20').resource;
    const d8 = bundle.find(item => item.die === 'd8').resource;
    const { dir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });
    const d20Path = path.join(dir, 'd20.supp.db');
    const d8Path = path.join(dir, 'd8.supp.db');
    const configPath = path.join(dir, 'library.yaml');
    let txModule = null;

    try {
      writeSupplementSidecar(d20Path, d20);
      writeSupplementSidecar(d8Path, d8);
      writeLibraryConfig(configPath, dbPath, ['d20.supp.db', 'd8.supp.db']);

      const { app, txModule: loaded } = await createTempTxApp(configPath);
      txModule = loaded;

      const res = await request(app)
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
    } finally {
      if (txModule) {
        await txModule.shutdown();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
