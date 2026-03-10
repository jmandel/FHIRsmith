'use strict';

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('../../tx/setup');

describe('IR $expand engine-selection behavior', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  test('errors instead of falling back when IR cannot handle shape', async () => {
    const res = await request(app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: '_engine', valueCode: 'ir' },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              expansion: {
                contains: [{ system: 'http://example.org/cs', code: 'x', display: 'X' }],
              },
            },
          },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue[0].code).toBe('not-supported');
    expect(res.body.issue[0].details.text).toContain('IR engine cannot handle this ValueSet');
    expect(res.body.issue[0].details.text).toContain('canHandleValueSet=false');
  });

  test('returns not-supported when IR hits an unsupported filter property', async () => {
    const res = await request(app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: '_engine', valueCode: 'ir' },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              status: 'active',
              compose: {
                include: [{
                  system: 'http://hl7.org/fhir/administrative-gender',
                  filter: [{ property: 'constraint', op: '=', value: 'memberOf 123' }],
                }],
              },
            },
          },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue[0].code).toBe('not-supported');
    expect(res.body.issue[0].details.text).toContain('constraint = memberOf 123');
  });
});
