'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('yaml');
const request = require('supertest');

const { buildDiceSupplementBundle } = require('../../tx/supplements/synthetic');
const { writeSupplementSidecar } = require('../../tx/supplements/sqlite-sidecar');
const {
  buildTempV0DbFile,
  createTempTxApp,
  makeBaseConcepts,
  writeLibraryConfig,
} = require('../support/sqlite-v0-supplement-fixtures');

function findProperty(resource, conceptCode, propertyCode) {
  const concept = (resource?.expansion?.contains || []).find(item => item.code === conceptCode);
  return (concept?.property || []).find(item => item.code === propertyCode);
}

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

describe('IR $expand typed property output', () => {
  test('configured sqlite supplement properties preserve typed value[x] and emit expansion.property metadata', async () => {
    const system = 'http://example.org/base';
    const version = '1';
    const baseConcepts = makeBaseConcepts(80);
    const base = {
      system,
      version,
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20'],
      urlRoot: 'http://example.org/fhir/CodeSystem/typed-prop-dice',
      version,
      salt: 'typed-expand',
    });
    const d20 = bundle[0].resource;
    const targetConcept = d20.concept.find(concept =>
      (concept.property || []).some(prop => prop.code === 'd20-roll' && prop.valueInteger === 20)
    );
    expect(targetConcept).toBeTruthy();

    const expectedDamageType = targetConcept.property.find(prop => prop.code === 'damage-type')?.valueCode;
    expect(expectedDamageType).toBeTruthy();

    const { dir, dbPath } = buildTempV0DbFile(baseConcepts, { system, version });
    const d20Path = path.join(dir, 'd20.supp.db');
    const configPath = path.join(dir, 'library.yaml');
    let txModule = null;

    try {
      writeSupplementSidecar(d20Path, d20);
      writeLibraryConfig(configPath, dbPath, ['d20.supp.db']);

      const { app, txModule: loaded } = await createTempTxApp(configPath);
      txModule = loaded;

      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: '_engine', valueCode: 'ir' },
            { name: 'useSupplement', valueString: d20.url },
            { name: 'property', valueString: '*' },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                status: 'active',
                compose: {
                  include: [{
                    system,
                    concept: [{ code: targetConcept.code }],
                  }],
                },
              },
            },
          ],
        });

      expect(res.status).toBe(200);

      const intProp = findProperty(res.body, targetConcept.code, 'd20-roll');
      expect(intProp).toEqual({ code: 'd20-roll', valueInteger: 20 });

      const codeProp = findProperty(res.body, targetConcept.code, 'damage-type');
      expect(codeProp).toEqual({ code: 'damage-type', valueCode: expectedDamageType });

      expect((res.body.expansion?.contains || [])[0].property.some(prop => prop.valueString === 'undefined')).toBe(false);
      expect((res.body.expansion?.property || []).some(prop => prop.code === 'd20-roll')).toBe(true);
      expect((res.body.expansion?.property || []).some(prop => prop.code === 'damage-type')).toBe(true);
    } finally {
      if (txModule) {
        await txModule.shutdown();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test('adapter-backed inline supplement properties preserve typed value[x] and emit expansion.property metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-ir-typed-prop-'));
    const configPath = path.join(dir, 'library.yaml');
    let txModule = null;

    const supplement = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/supp/us-states-typed',
      version: '1.0',
      status: 'active',
      content: 'supplement',
      supplements: 'https://www.usps.com/',
      concept: [{
        code: 'OK',
        property: [
          { code: 'd20-roll', valueInteger: 20 },
          { code: 'damage-type', valueCode: 'fire' },
        ],
      }],
    };

    try {
      writeAdapterLibraryConfig(configPath);
      const { app, txModule: loaded } = await createTempTxApp(configPath);
      txModule = loaded;

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
            { name: 'property', valueString: '*' },
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
        });

      expect(res.status).toBe(200);

      const intProp = findProperty(res.body, 'OK', 'd20-roll');
      expect(intProp).toEqual({ code: 'd20-roll', valueInteger: 20 });

      const codeProp = findProperty(res.body, 'OK', 'damage-type');
      expect(codeProp).toEqual({ code: 'damage-type', valueCode: 'fire' });

      expect((res.body.expansion?.contains || [])[0].property.some(prop => prop.valueString === 'undefined')).toBe(false);
      expect((res.body.expansion?.property || []).some(prop => prop.code === 'd20-roll')).toBe(true);
      expect((res.body.expansion?.property || []).some(prop => prop.code === 'damage-type')).toBe(true);
    } finally {
      if (txModule) {
        await txModule.shutdown();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
