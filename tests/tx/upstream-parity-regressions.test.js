'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('yaml');
const express = require('express');
const request = require('supertest');

const TXModule = require('../../tx/tx');
const { hasLoinc, hasSnomed, LOINC_DB, SNOMED_DB } = require('../v0-db-config');

async function createTxAppFromConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-upstream-parity-'));
  const configPath = path.join(dir, 'library.yaml');
  fs.writeFileSync(configPath, yaml.stringify(config), 'utf8');

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const txModule = new TXModule();
  await txModule.initialize({
    librarySource: configPath,
    endpoints: [{
      path: '/tx/r4',
      fhirVersion: '4.0',
      context: null,
    }],
  }, app);

  return { dir, app, txModule };
}

function getParam(body, name) {
  return (body?.parameter || []).find(param => param.name === name);
}

describe('upstream parity regressions', () => {
  describe('internal providers', () => {
    let dir;
    let app;
    let txModule;

    beforeAll(async () => {
      const loaded = await createTxAppFromConfig({
        base: { url: 'https://storage.googleapis.com/tx-fhir-org' },
        sources: [
          'internal:usstates',
          'internal:mimetypes',
          'npm:hl7.terminology.r4#7.0.1',
        ],
      });
      ({ dir, app, txModule } = loaded);
    });

    afterAll(async () => {
      if (txModule) await txModule.shutdown();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    test('THO USPS state ValueSet expands through the internal provider implicit ValueSet hook', async () => {
      const res = await request(app)
        .get('/tx/r4/ValueSet/$expand')
        .query({
          url: 'http://terminology.hl7.org/ValueSet/USPS-State',
          'incomplete-ok': 'true',
        })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('ValueSet');
      expect(res.body.expansion?.total).toBe(62);
      const codes = new Set((res.body.expansion?.contains || []).map(item => item.code));
      expect(codes.has('AL')).toBe(true);
      expect(codes.has('AK')).toBe(true);
      expect(codes.has('AS')).toBe(true);
      expect(codes.has('AZ')).toBe(true);
      expect(codes.has('AR')).toBe(true);
    }, 60000);

  });

  const describeIfV0 = hasLoinc && hasSnomed ? describe : describe.skip;
  describeIfV0('sqlite-v0 providers', () => {
    let dir;
    let app;
    let txModule;

    beforeAll(async () => {
      const loaded = await createTxAppFromConfig({
        base: { url: 'https://storage.googleapis.com/tx-fhir-org' },
        sources: [
          `sqlite-v0!:${SNOMED_DB}`,
          `sqlite-v0!:${LOINC_DB}`,
        ],
      });
      ({ dir, app, txModule } = loaded);
    });

    afterAll(async () => {
      if (txModule) await txModule.shutdown();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    test('LOINC implicit answer-list ValueSet LL2201-3 expands through sqlite-v0', async () => {
      const res = await request(app)
        .get('/tx/r4/ValueSet/$expand')
        .query({
          url: 'http://loinc.org/vs/LL2201-3',
        })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('ValueSet');
      expect(res.body.expansion?.total).toBe(8);
      const codes = new Set((res.body.expansion?.contains || []).map(item => item.code));
      expect(codes.has('LA18976-3')).toBe(true);
      expect(codes.has('LA18977-1')).toBe(true);
      expect(codes.has('LA15920-4')).toBe(true);
    }, 60000);

    test('inline IPS procedures ValueSet validates successfully instead of crashing on exclude filters', async () => {
      const inputDisplay = 'Placement of stent in coronary artery (procedure)';
      const res = await request(app)
        .post('/tx/r4/ValueSet/$validate-code')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'codeableConcept',
              valueCodeableConcept: {
                coding: [{
                  system: 'http://snomed.info/sct',
                  code: '36969009',
                  display: inputDisplay,
                }],
              },
            },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                url: 'http://hl7.org/fhir/uv/ips/ValueSet/procedures-uv-ips',
                version: '2.0.0',
                compose: {
                  include: [
                    {
                      system: 'http://snomed.info/sct',
                      filter: [{ property: 'concept', op: 'descendent-of', value: '71388002' }],
                    },
                    {
                      system: 'http://snomed.info/sct',
                      filter: [{ property: 'concept', op: 'is-a', value: '787480003' }],
                    },
                  ],
                  exclude: [
                    {
                      system: 'http://snomed.info/sct',
                      filter: [{ property: 'concept', op: 'is-a', value: '14734007' }],
                    },
                  ],
                },
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(getParam(res.body, 'result')?.valueBoolean).toBe(true);
      expect(getParam(res.body, 'message')).toBeUndefined();

      const display = getParam(res.body, 'display')?.valueString;
      expect(display).toBeTruthy();

      const returnedCC = getParam(res.body, 'codeableConcept')?.valueCodeableConcept;
      expect(returnedCC?.coding?.[0]?.code).toBe('36969009');
      expect(returnedCC?.coding?.[0]?.system).toBe('http://snomed.info/sct');
      expect(returnedCC?.coding?.[0]?.display).toBe(display);
    }, 60000);
  });

});
