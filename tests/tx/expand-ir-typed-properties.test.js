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
} = require('../support/sqlite-v0-supplement-fixtures');
const {
  createManagedTxFixture,
  destroyManagedTxFixture,
} = require('../support/tx-integration-fixtures');

function findProperty(resource, conceptCode, propertyCode) {
  const concept = (resource?.expansion?.contains || []).find(item => item.code === conceptCode);
  return (concept?.property || []).find(item => item.code === propertyCode);
}

describe('IR $expand typed property output', () => {
  let fixture;
  let system;
  let d20;
  let targetConcept;
  let expectedDamageType;

  beforeAll(async () => {
    system = 'http://example.org/base';
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
    d20 = bundle[0].resource;
    targetConcept = d20.concept.find(concept =>
      (concept.property || []).some(prop => prop.code === 'd20-roll' && prop.valueInteger === 20)
    );
    expectedDamageType = targetConcept?.property?.find(prop => prop.code === 'damage-type')?.valueCode;

    fixture = await createManagedTxFixture({
      prefix: 'sqlite-v0-supp-config-',
      setup: async ({ dir }) => {
        const built = buildTempV0DbFile(baseConcepts, { dir, system, version });
        const dbPath = built.dbPath;
        const d20Path = path.join(dir, 'd20.supp.db');
        const configPath = path.join(dir, 'library.yaml');
        writeSupplementSidecar(d20Path, d20);
        fs.writeFileSync(configPath, yaml.stringify({
          base: { url: 'https://storage.googleapis.com/tx-fhir-org' },
          sources: [
            {
              source: `sqlite-v0:${dbPath}`,
              options: { supplements: ['d20.supp.db'] },
            },
            'internal:usstates',
          ],
        }), 'utf8');
        return { configPath };
      },
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('configured sqlite supplement properties preserve typed value[x] and emit expansion.property metadata', async () => {
    expect(targetConcept).toBeTruthy();
    expect(expectedDamageType).toBeTruthy();

    const res = await request(fixture.app)
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
  }, 60000);

  test('adapter-backed inline supplement properties preserve typed value[x] and emit expansion.property metadata', async () => {
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

    const res = await request(fixture.app)
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
  }, 60000);
});
