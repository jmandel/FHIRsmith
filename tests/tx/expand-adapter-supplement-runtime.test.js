'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('yaml');
const request = require('supertest');

const { createTempTxApp } = require('../support/sqlite-v0-supplement-fixtures');

function makeSupplement({ url, targetSystem, targetVersion = null, concepts }) {
  return {
    resourceType: 'CodeSystem',
    url,
    version: '1.0',
    status: 'active',
    content: 'supplement',
    supplements: targetVersion ? `${targetSystem}|${targetVersion}` : targetSystem,
    concept: concepts,
  };
}

function writeAdapterLibraryConfig(configPath) {
  const config = {
    base: {
      url: 'https://storage.googleapis.com/tx-fhir-org',
    },
    sources: [
      'internal:usstates',
      'ucum:tx/data/ucum-essence.xml',
    ],
  };
  fs.writeFileSync(configPath, yaml.stringify(config), 'utf8');
}

describe('IR expand with adapter-backed inline supplements', () => {
  let dir;
  let app;
  let txModule;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-adapter-supp-'));
    const configPath = path.join(dir, 'library.yaml');
    writeAdapterLibraryConfig(configPath);
    const loaded = await createTempTxApp(configPath);
    app = loaded.app;
    txModule = loaded.txModule;
  });

  afterAll(async () => {
    if (txModule) {
      await txModule.shutdown();
    }
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('US states inline supplement numeric filter affects membership before paging', async () => {
    const supplement = makeSupplement({
      url: 'http://example.org/supp/us-states-d20',
      targetSystem: 'https://www.usps.com/',
      concepts: [
        { code: 'OK', property: [{ code: 'd20-roll', valueInteger: 20 }] },
        {
          code: 'TX',
          designation: [{ language: 'en', value: 'Lone Star bonus' }],
          property: [{ code: 'd20-roll', valueInteger: 20 }],
        },
      ],
    });

    const res = await request(app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: '_engine', valueCode: 'ir' },
          { name: 'useSupplement', valueString: supplement.url },
          { name: 'tx-resource', resource: supplement },
          { name: 'count', valueInteger: 1 },
          { name: 'offset', valueInteger: 1 },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [{
                  system: 'https://www.usps.com/',
                  filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                }],
              },
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.expansion?.total).toBe(2);
    expect((res.body.expansion?.contains || []).map(item => item.code)).toEqual(['TX']);
  }, 60000);

  test('UCUM inline supplement designation text participates in IR text filtering', async () => {
    const supplement = makeSupplement({
      url: 'http://example.org/supp/ucum-display',
      targetSystem: 'http://unitsofmeasure.org',
      concepts: [
        { code: 'm', designation: [{ language: 'en', value: 'Lone metre bonus' }] },
        { code: 'cm', designation: [{ language: 'en', value: 'Grouped centimetre bonus' }] },
      ],
    });

    const res = await request(app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: '_engine', valueCode: 'ir' },
          { name: 'useSupplement', valueString: supplement.url },
          { name: 'tx-resource', resource: supplement },
          { name: 'filter', valueString: 'Lone metre bonus' },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [{
                  system: 'http://unitsofmeasure.org',
                  concept: [{ code: 'm' }, { code: 'cm' }, { code: 'kg' }],
                }],
              },
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.expansion?.total).toBe(1);
    expect((res.body.expansion?.contains || []).map(item => item.code)).toEqual(['m']);
  }, 60000);
});
