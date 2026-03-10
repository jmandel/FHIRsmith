'use strict';

const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('../../tx/setup');
const { CodeSystem } = require('../../../tx/library/codesystem');

describe('IR $expand with registered supplements', () => {
  let app;
  let provider;

  beforeAll(async () => {
    app = await getTestApp();
    provider = getTxModule().endpoints[0].provider;
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  function registerSupplement(codeSystem) {
    provider.codeSystems.set(codeSystem.url, codeSystem);
    if (codeSystem.version) {
      provider.codeSystems.set(codeSystem.vurl, codeSystem);
    }
  }

  function unregisterSupplement(codeSystem) {
    if (provider.codeSystems.get(codeSystem.url) === codeSystem) {
      provider.codeSystems.delete(codeSystem.url);
    }
    if (codeSystem.version && provider.codeSystems.get(codeSystem.vurl) === codeSystem) {
      provider.codeSystems.delete(codeSystem.vurl);
    }
  }

  test('resolves registered supplement for tx-resource base system from unversioned request canonical', async () => {
    const seed = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const baseUrl = `http://example.org/supp-base-${seed}`;
    const suppUrl = `http://example.org/supp-reg-${seed}`;
    const supplement = new CodeSystem({
      resourceType: 'CodeSystem',
      url: suppUrl,
      version: '1.0',
      status: 'active',
      content: 'supplement',
      supplements: baseUrl,
      concept: [{
        code: 'apple',
        designation: [{ language: 'fr', value: 'Pomme' }],
      }],
    });
    registerSupplement(supplement);
    try {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: '_engine', valueCode: 'ir' },
            { name: 'useSupplement', valueString: suppUrl },
            { name: 'includeDesignations', valueBoolean: true },
            {
              name: 'tx-resource',
              resource: {
                resourceType: 'CodeSystem',
                url: baseUrl,
                version: '1',
                status: 'active',
                content: 'complete',
                concept: [
                  { code: 'apple', display: 'Apple' },
                  { code: 'banana', display: 'Banana' },
                ],
              },
            },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                url: `http://example.org/supp-vs-${seed}`,
                status: 'active',
                compose: {
                  include: [{ system: baseUrl, concept: [{ code: 'apple' }] }],
                },
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      const apple = (res.body.expansion.contains || []).find(c => c.code === 'apple');
      expect(apple).toBeDefined();
      expect((apple.designation || []).some(d => d.language === 'fr' && d.value === 'Pomme')).toBe(true);
      const usedSupplements = (res.body.expansion.parameter || [])
        .filter(p => p.name === 'used-supplement')
        .map(p => p.valueUri);
      expect(usedSupplements).toContain(`${suppUrl}|1.0`);
    } finally {
      unregisterSupplement(supplement);
    }
  });

  test('fails fast when unversioned requested supplement is ambiguous across registered versions', async () => {
    const seed = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const baseUrl = `http://example.org/supp-amb-base-${seed}`;
    const suppUrl = `http://example.org/supp-amb-${seed}`;
    const supp1 = new CodeSystem({
      resourceType: 'CodeSystem',
      url: suppUrl,
      version: '1.0',
      status: 'active',
      content: 'supplement',
      supplements: baseUrl,
      concept: [{ code: 'apple', designation: [{ language: 'fr', value: 'Pomme v1' }] }],
    });
    const supp2 = new CodeSystem({
      resourceType: 'CodeSystem',
      url: suppUrl,
      version: '2.0',
      status: 'active',
      content: 'supplement',
      supplements: baseUrl,
      concept: [{ code: 'apple', designation: [{ language: 'fr', value: 'Pomme v2' }] }],
    });
    registerSupplement(supp1);
    registerSupplement(supp2);
    try {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: '_engine', valueCode: 'ir' },
            { name: 'useSupplement', valueString: suppUrl },
            {
              name: 'tx-resource',
              resource: {
                resourceType: 'CodeSystem',
                url: baseUrl,
                version: '1',
                status: 'active',
                content: 'complete',
                concept: [{ code: 'apple', display: 'Apple' }],
              },
            },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                url: `http://example.org/supp-amb-vs-${seed}`,
                status: 'active',
                compose: {
                  include: [{ system: baseUrl, concept: [{ code: 'apple' }] }],
                },
              },
            },
          ],
        });

      expect(res.status).toBe(422);
      expect(res.body.issue[0].details.text).toContain(`Ambiguous supplement '${suppUrl}'`);
    } finally {
      unregisterSupplement(supp1);
      unregisterSupplement(supp2);
    }
  });

  test('projects registered supplement extensions through generic overlay merge', async () => {
    const seed = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const baseUrl = `http://example.org/supp-ext-base-${seed}`;
    const suppUrl = `http://example.org/supp-ext-${seed}`;
    const supplement = new CodeSystem({
      resourceType: 'CodeSystem',
      url: suppUrl,
      version: '1.0',
      status: 'active',
      content: 'supplement',
      supplements: baseUrl,
      concept: [{
        code: 'apple',
        extension: [{
          url: 'http://hl7.org/fhir/StructureDefinition/itemWeight',
          valueDecimal: 3.5,
        }],
      }],
    });
    registerSupplement(supplement);
    try {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: '_engine', valueCode: 'ir' },
            { name: 'useSupplement', valueString: suppUrl },
            { name: 'property', valueString: 'http://hl7.org/fhir/StructureDefinition/itemWeight' },
            {
              name: 'tx-resource',
              resource: {
                resourceType: 'CodeSystem',
                url: baseUrl,
                version: '1',
                status: 'active',
                content: 'complete',
                concept: [{ code: 'apple', display: 'Apple' }],
              },
            },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                url: `http://example.org/supp-ext-vs-${seed}`,
                status: 'active',
                compose: {
                  include: [{ system: baseUrl, concept: [{ code: 'apple' }] }],
                },
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      const apple = (res.body.expansion.contains || []).find(c => c.code === 'apple');
      expect(apple).toBeDefined();
      expect((apple.extension || []).some(
        e => e.url === 'http://hl7.org/fhir/StructureDefinition/itemWeight' && e.valueDecimal === 3.5
      )).toBe(true);
    } finally {
      unregisterSupplement(supplement);
    }
  });

  test('supplement-backed property filter drives total and pagination before output shaping', async () => {
    const seed = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const baseUrl = `http://example.org/supp-prop-base-${seed}`;
    const suppUrl = `http://example.org/supp-prop-${seed}`;
    const supplement = new CodeSystem({
      resourceType: 'CodeSystem',
      url: suppUrl,
      version: '1.0',
      status: 'active',
      content: 'supplement',
      supplements: baseUrl,
      concept: [
        { code: 'apple', property: [{ code: 'rank', valueInteger: 1 }] },
        { code: 'banana', property: [{ code: 'rank', valueInteger: 1 }] },
        { code: 'date', property: [{ code: 'rank', valueInteger: 1 }] },
      ],
    });
    registerSupplement(supplement);
    try {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: '_engine', valueCode: 'ir' },
            { name: 'useSupplement', valueString: suppUrl },
            { name: 'count', valueInteger: 1 },
            { name: 'offset', valueInteger: 1 },
            {
              name: 'tx-resource',
              resource: {
                resourceType: 'CodeSystem',
                url: baseUrl,
                version: '1',
                status: 'active',
                content: 'complete',
                concept: [
                  { code: 'apple', display: 'Apple' },
                  { code: 'banana', display: 'Banana' },
                  { code: 'carrot', display: 'Carrot' },
                  { code: 'date', display: 'Date' },
                ],
              },
            },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                url: `http://example.org/supp-prop-vs-${seed}`,
                status: 'active',
                compose: {
                  include: [{
                    system: baseUrl,
                    filter: [{ property: 'rank', op: '=', value: '1' }],
                  }],
                },
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.expansion.total).toBe(3);
      expect((res.body.expansion.contains || []).map(c => c.code)).toEqual(['banana']);
    } finally {
      unregisterSupplement(supplement);
    }
  });

  test('text filter matches supplement designation values', async () => {
    const seed = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const baseUrl = `http://example.org/supp-text-base-${seed}`;
    const suppUrl = `http://example.org/supp-text-${seed}`;
    const supplement = new CodeSystem({
      resourceType: 'CodeSystem',
      url: suppUrl,
      version: '1.0',
      status: 'active',
      content: 'supplement',
      supplements: baseUrl,
      concept: [{
        code: 'apple',
        designation: [{ language: 'fr', value: 'Pomme' }],
      }],
    });
    registerSupplement(supplement);
    try {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: '_engine', valueCode: 'ir' },
            { name: 'useSupplement', valueString: suppUrl },
            { name: 'filter', valueString: 'Pomme' },
            { name: 'includeDesignations', valueBoolean: true },
            {
              name: 'tx-resource',
              resource: {
                resourceType: 'CodeSystem',
                url: baseUrl,
                version: '1',
                status: 'active',
                content: 'complete',
                concept: [
                  { code: 'apple', display: 'Apple' },
                  { code: 'banana', display: 'Banana' },
                ],
              },
            },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                url: `http://example.org/supp-text-vs-${seed}`,
                status: 'active',
                compose: {
                  include: [{ system: baseUrl }],
                },
              },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect((res.body.expansion.contains || []).map(c => c.code)).toEqual(['apple']);
      expect(res.body.expansion.total).toBe(1);
    } finally {
      unregisterSupplement(supplement);
    }
  });
});
