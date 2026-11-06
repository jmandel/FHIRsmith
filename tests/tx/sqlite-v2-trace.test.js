'use strict';

// Request traces (tx/sqlite-v2/request-trace.js) through the real router.

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const traces = require('../../tx/sqlite-v2/trace');

const EXPAND = '/tx/r5/ValueSet/$expand';

describe('sqlite-v2 request traces', () => {
  let app;
  let saved;
  beforeAll(async () => {
    app = await getTestApp();
    saved = traces.settings.mode;
    traces.settings.mode = 'request';
  }, 120000);
  afterAll(async () => {
    traces.settings.mode = saved;
    await shutdownTestApp();
  });

  test('_trace=cold on a value set that carries its expansion: 200 with a trace', async () => {
    const vs = {
      resourceType: 'ValueSet', url: 'http://example.org/pre', status: 'active',
      compose: { include: [{ system: 'http://hl7.org/fhir/administrative-gender', concept: [{ code: 'male' }] }] },
      expansion: { timestamp: '2025-01-01T00:00:00Z', total: 1, contains: [{ system: 'http://hl7.org/fhir/administrative-gender', code: 'male' }] }
    };
    const res = await request(app).post(EXPAND).set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [{ name: '_trace', valueString: 'cold' }, { name: 'valueSet', resource: vs }] });
    expect(res.status).toBe(200);
    const ext = (res.body.expansion.extension || []).find((e) => e.url === traces.EXTENSION_URL);
    expect(ext).toBeTruthy();
    expect(JSON.parse(ext.valueString).traceFormat).toBe(traces.FORMAT);
  });

  test('?_trace=cold on a POSTed Parameters body reaches the parameters (the expansion cache is bypassed)', () => {
    const { middleware } = require('../../tx/sqlite-v2/request-trace');
    const body = { resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: 'http://example.org/vs' }] };
    const req = { path: '/ValueSet/$expand', method: 'POST', originalUrl: '/r4/ValueSet/$expand?_trace=cold', query: { _trace: 'cold' }, body, txOpContext: {} };
    const res = { json: () => {} };
    let called = false;
    middleware()(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(body.parameter).toContainEqual({ name: '_trace', valueString: 'cold' });
  });
});
