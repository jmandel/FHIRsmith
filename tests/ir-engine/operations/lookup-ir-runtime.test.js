'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const yaml = require('yaml');

const {
  createManagedTxFixture,
  destroyManagedTxFixture,
} = require('../../support/tx-integration-fixtures');

function params(parameter) {
  return { resourceType: 'Parameters', parameter };
}

function propertyParts(parameters, code) {
  return (parameters || [])
    .filter((param) => param.name === 'property')
    .map((param) => param.part || [])
    .filter((parts) => parts.some((part) => part.name === 'code' && part.valueCode === code));
}

function paramValueString(parameters, name) {
  return (parameters || []).find((param) => param.name === name)?.valueString || null;
}

describe('CodeSystem $lookup through supplement runtime', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await createManagedTxFixture({
      prefix: 'lookup-ir-generic-',
      setup: async ({ dir }) => {
        const configPath = path.join(dir, 'library.yaml');
        fs.writeFileSync(configPath, yaml.stringify({
          base: { url: 'https://storage.googleapis.com/tx-fhir-org' },
          sources: ['internal:usstates'],
        }), 'utf8');
        return { configPath };
      },
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('returns a specifically requested typed supplement property on an adapter-backed provider', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$lookup')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        { name: 'system', valueUri: 'https://www.usps.com/' },
        { name: 'code', valueCode: 'TX' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'property', valueCode: 'designation' },
        { name: 'property', valueCode: 'd20-roll' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/usps-rolls' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/usps-rolls',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'https://www.usps.com/',
            property: [{ code: 'd20-roll', type: 'integer' }],
            concept: [
              {
                code: 'TX',
                designation: [
                  {
                    language: 'de',
                    use: {
                      system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                      code: 'preferredForLanguage',
                    },
                    value: 'Texas Bonus',
                  },
                ],
                property: [{ code: 'd20-roll', valueInteger: 20 }],
              },
              { code: 'CA', property: [{ code: 'd20-roll', valueInteger: 1 }] },
            ],
          },
        },
      ]));

    expect(res.status).toBe(200);
    const parameters = res.body?.parameter || [];

    expect(parameters.some((param) =>
      param.name === 'display' && param.valueString === 'Texas Bonus'
    )).toBe(true);

    expect(parameters.some((param) =>
      param.name === 'designation'
      && (param.part || []).some((part) => part.name === 'value' && part.valueString === 'Texas Bonus')
    )).toBe(true);

    const d20RollProps = propertyParts(parameters, 'd20-roll');
    expect(d20RollProps.length).toBeGreaterThan(0);
    expect(d20RollProps.some((parts) =>
      parts.some((part) => part.name === 'value' && part.valueInteger === 20)
    )).toBe(true);
  }, 60000);

  test('falls back to the base display when no requested supplement language matches', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$lookup')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        { name: 'system', valueUri: 'https://www.usps.com/' },
        { name: 'code', valueCode: 'TX' },
        { name: 'displayLanguage', valueCode: 'fr' },
        { name: 'property', valueCode: 'designation' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/usps-rolls' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/usps-rolls',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'https://www.usps.com/',
            property: [{ code: 'd20-roll', type: 'integer' }],
            concept: [
              {
                code: 'TX',
                designation: [
                  {
                    language: 'de',
                    use: {
                      system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                      code: 'preferredForLanguage',
                    },
                    value: 'Texas Bonus',
                  },
                ],
                property: [{ code: 'd20-roll', valueInteger: 20 }],
              },
            ],
          },
        },
      ]));

    expect(res.status).toBe(200);
    const parameters = res.body?.parameter || [];

    expect(parameters.some((param) =>
      param.name === 'display' && param.valueString === 'Texas'
    )).toBe(true);

    expect(parameters.some((param) =>
      param.name === 'designation'
      && (param.part || []).some((part) => part.name === 'value' && part.valueString === 'Texas Bonus')
    )).toBe(true);
  }, 60000);

  test('emits structured trace for IR lookup requests', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$lookup')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        { name: '_trace', valueBoolean: true },
        { name: 'system', valueUri: 'https://www.usps.com/' },
        { name: 'code', valueCode: 'TX' },
        { name: 'property', valueCode: 'designation' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/usps-rolls' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/usps-rolls',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'https://www.usps.com/',
            concept: [
              {
                code: 'TX',
                designation: [
                  {
                    language: 'de',
                    use: {
                      system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                      code: 'preferredForLanguage',
                    },
                    value: 'Texas Bonus',
                  },
                ],
              },
            ],
          },
        },
      ]));

    expect(res.status).toBe(200);
    const parameters = res.body?.parameter || [];
    const traceText = paramValueString(parameters, 'trace');
    expect(traceText).toBeTruthy();
    const traceJson = JSON.parse(traceText);
    expect(JSON.stringify(traceJson)).toContain('lookupIR:doLookup');
  }, 60000);

  test('supports type-level lookup against an inline CodeSystem resource', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$lookup')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        { name: 'code', valueCode: 'A' },
        { name: 'property', valueCode: '*' },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-lookup',
            version: '1.0.0',
            status: 'active',
            content: 'complete',
            property: [
              { code: 'rank', type: 'integer' },
              { code: 'kind', type: 'code' },
            ],
            concept: [
              {
                code: 'A',
                display: 'Alpha',
                property: [
                  { code: 'rank', valueInteger: 7 },
                  { code: 'kind', valueCode: 'primary' },
                ],
              },
              { code: 'B', display: 'Beta' },
            ],
          },
        },
      ]));

    expect(res.status).toBe(200);
    const parameters = res.body?.parameter || [];
    expect(parameters.some((param) =>
      param.name === 'display' && param.valueString === 'Alpha'
    )).toBe(true);
    expect(parameters.some((param) =>
      param.name === 'version' && param.valueString === '1.0.0'
    )).toBe(true);

    const rankProps = propertyParts(parameters, 'rank');
    expect(rankProps.some((parts) =>
      parts.some((part) => part.name === 'value' && part.valueInteger === 7)
    )).toBe(true);

    const kindProps = propertyParts(parameters, 'kind');
    expect(kindProps.some((parts) =>
      parts.some((part) => part.name === 'value' && part.valueCode === 'primary')
    )).toBe(true);
  }, 60000);

  test('rejects inline CodeSystem lookup when coding has no system', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$lookup')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        {
          name: 'coding',
          valueCoding: {
            code: 'A',
          },
        },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-lookup-coding',
            version: '1.0.0',
            status: 'active',
            content: 'complete',
            concept: [
              { code: 'A', display: 'Alpha Coding' },
            ],
          },
        },
      ]));

    expect(res.status).toBe(400);
    expect(String(res.body?.issue?.[0]?.details?.text || '')).toContain('Coding parameter must include a system');
  }, 60000);
});
