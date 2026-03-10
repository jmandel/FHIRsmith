'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const yaml = require('yaml');

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

function params(parameter) {
  return { resourceType: 'Parameters', parameter };
}

function resultValue(body) {
  return (body?.parameter || []).find((param) => param.name === 'result')?.valueBoolean;
}

function paramValueString(body, name) {
  return (body?.parameter || []).find((param) => param.name === name)?.valueString || null;
}

function displayValue(body) {
  return paramValueString(body, 'display');
}

describe('ValueSet $validate-code through ValidateIRWorker', () => {
  describe('inline supplement-backed filters on generic CodeSystem providers', () => {
    let fixture;

    const inlineSupplement = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/fhir/CodeSystem/admin-gender-rolls',
      version: '1.0.0',
      status: 'active',
      content: 'supplement',
      supplements: 'http://hl7.org/fhir/administrative-gender',
      property: [
        { code: 'd20-roll', type: 'integer' },
      ],
      concept: [
        { code: 'male', property: [{ code: 'd20-roll', valueInteger: 20 }] },
        { code: 'female', property: [{ code: 'd20-roll', valueInteger: 1 }] },
      ],
    };

    beforeAll(async () => {
      fixture = await createManagedTxFixture({
        prefix: 'validate-ir-generic-',
        setup: async ({ dir }) => {
          const configPath = path.join(dir, 'library.yaml');
          fs.writeFileSync(configPath, yaml.stringify({
            base: { url: 'https://storage.googleapis.com/tx-fhir-org' },
            sources: [],
          }), 'utf8');
          return { configPath };
        },
      });
    });

    afterAll(async () => {
      await destroyManagedTxFixture(fixture);
    });

    test('returns result=true for a matching inline supplement-backed property filter', async () => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(params([
          { name: '_engine', valueCode: 'ir' },
          {
            name: 'coding',
            valueCoding: {
              system: 'http://hl7.org/fhir/administrative-gender',
              code: 'male',
            },
          },
          {
            name: 'useSupplement',
            valueString: inlineSupplement.url,
          },
          {
            name: 'tx-resource',
            resource: inlineSupplement,
          },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [
                  {
                    system: 'http://hl7.org/fhir/administrative-gender',
                    filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                  },
                ],
              },
            },
          },
        ]));

      expect(res.status).toBe(200);
      expect(resultValue(res.body)).toBe(true);
    }, 60000);

    test('returns result=false for a non-matching inline supplement-backed property filter', async () => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(params([
          { name: '_engine', valueCode: 'ir' },
          {
            name: 'coding',
            valueCoding: {
              system: 'http://hl7.org/fhir/administrative-gender',
              code: 'female',
            },
          },
          {
            name: 'useSupplement',
            valueString: inlineSupplement.url,
          },
          {
            name: 'tx-resource',
            resource: inlineSupplement,
          },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [
                  {
                    system: 'http://hl7.org/fhir/administrative-gender',
                    filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                  },
                ],
              },
            },
          },
        ]));

      expect(res.status).toBe(200);
      expect(resultValue(res.body)).toBe(false);
    }, 60000);

    test('accepts codeableConcept for a matching inline supplement-backed property filter', async () => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(params([
          { name: '_engine', valueCode: 'ir' },
          {
            name: 'codeableConcept',
            valueCodeableConcept: {
              coding: [{
                system: 'http://hl7.org/fhir/administrative-gender',
                code: 'male',
              }],
            },
          },
          {
            name: 'useSupplement',
            valueString: inlineSupplement.url,
          },
          {
            name: 'tx-resource',
            resource: inlineSupplement,
          },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [
                  {
                    system: 'http://hl7.org/fhir/administrative-gender',
                    filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                  },
                ],
              },
            },
          },
        ]));

      expect(res.status).toBe(200);
      expect(resultValue(res.body)).toBe(true);
    }, 60000);

    test('emits structured trace and IR plan payloads for IR validate', async () => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(params([
          { name: '_engine', valueCode: 'ir' },
          { name: '_trace', valueBoolean: true },
          {
            name: 'coding',
            valueCoding: {
              system: 'http://hl7.org/fhir/administrative-gender',
              code: 'male',
            },
          },
          {
            name: 'useSupplement',
            valueString: inlineSupplement.url,
          },
          {
            name: 'tx-resource',
            resource: inlineSupplement,
          },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [
                  {
                    system: 'http://hl7.org/fhir/administrative-gender',
                    filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                  },
                ],
              },
            },
          },
        ]));

      expect(res.status).toBe(200);
      expect(resultValue(res.body)).toBe(true);

      const traceText = paramValueString(res.body, 'trace');
      expect(traceText).toBeTruthy();
      const traceJson = JSON.parse(traceText);
      expect(JSON.stringify(traceJson)).toContain('validateIR:checkConceptSet');

      const irPlanText = paramValueString(res.body, 'irPlan');
      expect(irPlanText).toContain('optimized-ir');
    }, 60000);
  });

  describe('configured sqlite supplement sidecars on sqlite-v0 providers', () => {
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
        codes: baseConcepts.map((c) => ({ code: c.code })),
      };
      const bundle = buildDiceSupplementBundle(base, {
        dice: ['d20'],
        urlRoot: 'http://example.org/fhir/CodeSystem/validate-ir-dice',
        version,
        salt: 'validate-ir',
      });
      d20 = bundle[0].resource;
      matchingCode = d20.concept.find((concept) =>
        (concept.property || []).some((prop) => prop.code === 'd20-roll' && prop.valueInteger === 20)
      )?.code;
      nonMatchingCode = d20.concept.find((concept) =>
        !(concept.property || []).some((prop) => prop.code === 'd20-roll' && prop.valueInteger === 20)
      )?.code;

      fixture = await createManagedTxFixture({
        prefix: 'validate-ir-sqlite-',
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

    test('returns result=true for a configured sqlite supplement-backed property filter', async () => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(params([
          { name: '_engine', valueCode: 'ir' },
          { name: 'system', valueUri: system },
          { name: 'code', valueCode: matchingCode },
          { name: 'useSupplement', valueString: d20.url },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [
                  {
                    system,
                    filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                  },
                ],
              },
            },
          },
        ]));

      expect(res.status).toBe(200);
      expect(resultValue(res.body)).toBe(true);
    }, 60000);

    test('returns result=false for a non-matching configured sqlite supplement-backed property filter', async () => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(params([
          { name: '_engine', valueCode: 'ir' },
          { name: 'system', valueUri: system },
          { name: 'code', valueCode: nonMatchingCode },
          { name: 'useSupplement', valueString: d20.url },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [
                  {
                    system,
                    filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                  },
                ],
              },
            },
          },
        ]));

      expect(res.status).toBe(200);
      expect(resultValue(res.body)).toBe(false);
    }, 60000);

    test('accepts Coding for a matching configured sqlite supplement-backed property filter', async () => {
      const res = await request(fixture.app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send(params([
          { name: '_engine', valueCode: 'ir' },
          {
            name: 'coding',
            valueCoding: {
              system,
              code: matchingCode,
            },
          },
          { name: 'useSupplement', valueString: d20.url },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [
                  {
                    system,
                    filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                  },
                ],
              },
            },
          },
        ]));

      expect(res.status).toBe(200);
      expect(resultValue(res.body)).toBe(true);
    }, 60000);
  });

describe('CodeSystem instance $validate-code through ValidateIRWorker', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await createManagedTxFixture({
      prefix: 'validate-ir-cs-instance-',
      setup: async ({ dir }) => {
        const configPath = path.join(dir, 'library.yaml');
        fs.writeFileSync(configPath, yaml.stringify({
          base: { url: 'https://storage.googleapis.com/tx-fhir-org' },
          sources: [],
        }), 'utf8');
        return { configPath };
      },
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('accepts code-only Parameters for a CodeSystem instance validate request', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/administrative-gender/$validate-code')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        { name: 'code', valueCode: 'male' },
      ]));

    expect(res.status).toBe(200);
    expect(resultValue(res.body)).toBe(true);
    expect((res.body.parameter || []).find((param) => param.name === 'display')?.valueString).toBe('Male');
  }, 60000);

  test('accepts codeableConcept for a CodeSystem instance validate request', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/administrative-gender/$validate-code')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [{
              system: 'http://hl7.org/fhir/administrative-gender',
              code: 'female',
            }],
          },
        },
      ]));

    expect(res.status).toBe(200);
    expect(resultValue(res.body)).toBe(true);
    expect((res.body.parameter || []).find((param) => param.name === 'display')?.valueString).toBe('Female');
  }, 60000);
});

describe('CodeSystem $validate-code through ValidateIRWorker with supplements', () => {
  let fixture;

  const inlineSupplement = {
    resourceType: 'CodeSystem',
    url: 'http://example.org/fhir/CodeSystem/admin-gender-de',
    version: '1.0.0',
    status: 'active',
    content: 'supplement',
    supplements: 'http://hl7.org/fhir/administrative-gender',
    concept: [
      {
        code: 'male',
        designation: [
          {
            language: 'de',
            use: {
              system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
              code: 'preferredForLanguage',
            },
            value: 'Männlich',
          },
        ],
      },
    ],
  };

  const unrelatedSupplement = {
    resourceType: 'CodeSystem',
    url: 'http://example.org/fhir/CodeSystem/other-unused',
    version: '1.0.0',
    status: 'active',
    content: 'supplement',
    supplements: 'http://example.org/other-system',
    concept: [{ code: 'x', display: 'Unused' }],
  };

  beforeAll(async () => {
    fixture = await createManagedTxFixture({
      prefix: 'validate-ir-cs-supplements-',
      setup: async ({ dir }) => {
        const configPath = path.join(dir, 'library.yaml');
        fs.writeFileSync(configPath, yaml.stringify({
          base: { url: 'https://storage.googleapis.com/tx-fhir-org' },
          sources: [],
        }), 'utf8');
        return { configPath };
      },
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('uses inline supplement designation for displayLanguage on CodeSystem validate', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$validate-code')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        { name: 'url', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'useSupplement', valueString: inlineSupplement.url },
        { name: 'tx-resource', resource: inlineSupplement },
      ]));

    expect(res.status).toBe(200);
    expect(resultValue(res.body)).toBe(true);
    expect(displayValue(res.body)).toBe('Männlich');
  }, 60000);

  test('allows an extra resolved-but-unused supplement without failing validation', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$validate-code')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        { name: 'url', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'useSupplement', valueString: inlineSupplement.url },
        { name: 'useSupplement', valueString: unrelatedSupplement.url },
        { name: 'tx-resource', resource: inlineSupplement },
        { name: 'tx-resource', resource: unrelatedSupplement },
      ]));

    expect(res.status).toBe(200);
    expect(resultValue(res.body)).toBe(true);
    expect(displayValue(res.body)).toBe('Männlich');
  }, 60000);
});

describe('CodeSystem $validate-code through ValidateIRWorker with configured sqlite supplements', () => {
  let fixture;
  let system;
  let supplement;
  let code;

  beforeAll(async () => {
    system = 'http://example.org/validate-cs-base';
    const version = '1';
    code = 'C0001';
    const baseConcepts = [{ code, display: 'Base Display' }, { code: 'C0002', display: 'Other' }];
    supplement = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/fhir/CodeSystem/validate-cs-de',
      version: '1.0.0',
      status: 'active',
      content: 'supplement',
      supplements: `${system}|${version}`,
      concept: [
        {
          code,
          designation: [
            {
              language: 'de',
              use: {
                system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                code: 'preferredForLanguage',
              },
              value: 'Kritischer Treffer',
            },
          ],
        },
      ],
    };

    fixture = await createManagedTxFixture({
      prefix: 'validate-ir-cs-sqlite-supp-',
      setup: async ({ dir }) => {
        const built = buildTempV0DbFile(baseConcepts, { dir, system, version });
        const dbPath = built.dbPath;
        const suppPath = path.join(dir, 'validate-cs-de.supp.db');
        const configPath = path.join(dir, 'library.yaml');
        writeSupplementSidecar(suppPath, supplement);
        writeLibraryConfig(configPath, dbPath, ['validate-cs-de.supp.db']);
        return { configPath };
      },
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('uses configured sqlite supplement designation for displayLanguage on CodeSystem validate', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/CodeSystem/$validate-code')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        { name: 'url', valueUri: system },
        { name: 'code', valueCode: code },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'useSupplement', valueString: supplement.url },
      ]));

    expect(res.status).toBe(200);
    expect(resultValue(res.body)).toBe(true);
    expect(displayValue(res.body)).toBe('Kritischer Treffer');
  }, 60000);
});

describe('supplement runtime failures remain explicit in ValidateIRWorker', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await createManagedTxFixture({
      prefix: 'validate-ir-ambiguity-',
      setup: async ({ dir }) => {
        const configPath = path.join(dir, 'library.yaml');
        fs.writeFileSync(configPath, yaml.stringify({
          base: { url: 'https://storage.googleapis.com/tx-fhir-org' },
          sources: [],
        }), 'utf8');
        return { configPath };
      },
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('returns 422 for ambiguous inline supplement selection', async () => {
    const supplementBase = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/fhir/CodeSystem/admin-gender-rolls',
      status: 'active',
      content: 'supplement',
      supplements: 'http://hl7.org/fhir/administrative-gender',
      property: [{ code: 'd20-roll', type: 'integer' }],
    };

    const res = await request(fixture.app)
      .post('/tx/r5/ValueSet/$validate-code')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(params([
        { name: '_engine', valueCode: 'ir' },
        {
          name: 'system',
          valueUri: 'http://hl7.org/fhir/administrative-gender',
        },
        {
          name: 'code',
          valueCode: 'male',
        },
        {
          name: 'useSupplement',
          valueString: supplementBase.url,
        },
        {
          name: 'tx-resource',
          resource: {
            ...supplementBase,
            version: '1.0.0',
            concept: [{ code: 'male', property: [{ code: 'd20-roll', valueInteger: 20 }] }],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            ...supplementBase,
            version: '2.0.0',
            concept: [{ code: 'male', property: [{ code: 'd20-roll', valueInteger: 1 }] }],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [
                {
                  system: 'http://hl7.org/fhir/administrative-gender',
                  filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                },
              ],
            },
          },
        },
      ]));

    expect(res.status).toBe(422);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue?.[0]?.details?.text || '').toContain('Ambiguous supplement');
  }, 60000);
});

});
