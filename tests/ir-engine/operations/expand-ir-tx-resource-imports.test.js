'use strict';

const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('../../tx/setup');

describe('IR $expand tx-resource import flows', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  test('resolves nested tx-resource ValueSet imports with IR engine', async () => {
    const importedVsUrl = 'http://example.org/txr/imported';
    const rootVsUrl = 'http://example.org/txr/root';
    const csUrl = 'http://example.org/txr/colors';

    const res = await request(app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: '_engine', valueCode: 'ir' },
          { name: '_trace', valueBoolean: true },
          {
            name: 'tx-resource',
            resource: {
              resourceType: 'CodeSystem',
              url: csUrl,
              version: '1',
              status: 'active',
              content: 'complete',
              concept: [
                { code: 'red', display: 'Red' },
                { code: 'green', display: 'Green' },
                { code: 'blue', display: 'Blue' },
              ],
            },
          },
          {
            name: 'tx-resource',
            resource: {
              resourceType: 'ValueSet',
              url: importedVsUrl,
              status: 'active',
              compose: {
                include: [{
                  system: csUrl,
                  concept: [{ code: 'red' }, { code: 'green' }],
                }],
              },
            },
          },
          {
            name: 'valueSet',
            resource: {
              resourceType: 'ValueSet',
              url: rootVsUrl,
              status: 'active',
              compose: {
                include: [
                  { valueSet: [importedVsUrl] },
                  { system: csUrl, concept: [{ code: 'blue' }] },
                ],
                exclude: [{
                  system: csUrl,
                  concept: [{ code: 'green' }],
                }],
              },
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    const expansion = res.body.expansion;
    expect(expansion).toBeDefined();
    expect(expansion.total).toBe(2);
    const codes = (expansion.contains || []).map(c => c.code).sort();
    expect(codes).toEqual(['blue', 'red']);

    const usedVS = (expansion.parameter || [])
      .filter(p => p.name === 'used-valueset')
      .map(p => p.valueUri);
    expect(usedVS).toContain(importedVsUrl);

    const traceExt = (expansion.extension || []).find(
      e => e.url === 'https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/expand-trace'
    );
    expect(traceExt).toBeDefined();
  });

  test('import+exclude parity: legacy and IR both exclude imported and peer codes', async () => {
    const seed = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const csUrl = `http://example.org/txr/import-cs-${seed}`;
    const peerUrl = `http://example.org/txr/peer-cs-${seed}`;
    const importedVsUrl = `http://example.org/txr/import-vs-${seed}`;
    const rootVsUrl = `http://example.org/txr/root-vs-${seed}`;
    const expected = [
      `${csUrl}|a`,
      `${csUrl}|c`,
      `${csUrl}|d`,
      `${peerUrl}|male`,
      `${peerUrl}|female`,
    ].sort();

    const makeParamsBody = (engine) => ({
      resourceType: 'Parameters',
      parameter: [
        { name: '_engine', valueCode: engine },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: csUrl,
            version: '1',
            status: 'active',
            content: 'complete',
            concept: [
              { code: 'a', display: 'A' },
              { code: 'b', display: 'B' },
              { code: 'c', display: 'C' },
              { code: 'd', display: 'D' },
            ],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: peerUrl,
            version: '1',
            status: 'active',
            content: 'complete',
            concept: [
              { code: 'male', display: 'Male' },
              { code: 'female', display: 'Female' },
              { code: 'unknown', display: 'Unknown' },
            ],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'ValueSet',
            url: importedVsUrl,
            status: 'active',
            compose: {
              include: [{ system: csUrl }],
            },
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            url: rootVsUrl,
            status: 'active',
            compose: {
              include: [
                { valueSet: [importedVsUrl] },
                { system: peerUrl },
              ],
              exclude: [
                { system: csUrl, concept: [{ code: 'b' }] },
                { system: peerUrl, concept: [{ code: 'unknown' }] },
              ],
            },
          },
        },
      ],
    });

    const collectKeys = (expansion) => (expansion.contains || [])
      .map(c => `${c.system}|${c.code}`)
      .sort();

    const legacyRes = await request(app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(makeParamsBody('legacy'));
    expect(legacyRes.status).toBe(200);

    const irRes = await request(app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(makeParamsBody('ir'));
    expect(irRes.status).toBe(200);

    const legacyExpansion = legacyRes.body.expansion;
    const irExpansion = irRes.body.expansion;
    const legacyKeys = collectKeys(legacyExpansion);
    const irKeys = collectKeys(irExpansion);

    expect(legacyKeys).toEqual(expected);
    expect(irKeys).toEqual(expected);
    expect(legacyExpansion.total).toBe(expected.length);
    expect(irExpansion.total).toBe(expected.length);
  });

  test('import+exclude pagination parity: pages reconstruct same full result in legacy and IR', async () => {
    const seed = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const csUrl = `http://example.org/txr/pg-cs-${seed}`;
    const peerUrl = `http://example.org/txr/pg-peer-${seed}`;
    const importedVsUrl = `http://example.org/txr/pg-import-vs-${seed}`;
    const rootVsUrl = `http://example.org/txr/pg-root-vs-${seed}`;
    const expected = [
      `${csUrl}|a`,
      `${csUrl}|c`,
      `${csUrl}|d`,
      `${peerUrl}|male`,
      `${peerUrl}|female`,
    ].sort();

    const makeParamsBody = (engine, count, offset) => ({
      resourceType: 'Parameters',
      parameter: [
        { name: '_engine', valueCode: engine },
        { name: 'count', valueInteger: count },
        { name: 'offset', valueInteger: offset },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: csUrl,
            version: '1',
            status: 'active',
            content: 'complete',
            concept: [
              { code: 'a', display: 'A' },
              { code: 'b', display: 'B' },
              { code: 'c', display: 'C' },
              { code: 'd', display: 'D' },
            ],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: peerUrl,
            version: '1',
            status: 'active',
            content: 'complete',
            concept: [
              { code: 'male', display: 'Male' },
              { code: 'female', display: 'Female' },
              { code: 'unknown', display: 'Unknown' },
            ],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'ValueSet',
            url: importedVsUrl,
            status: 'active',
            compose: {
              include: [{ system: csUrl }],
            },
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            url: rootVsUrl,
            status: 'active',
            compose: {
              include: [
                { valueSet: [importedVsUrl] },
                { system: peerUrl },
              ],
              exclude: [
                { system: csUrl, concept: [{ code: 'b' }] },
                { system: peerUrl, concept: [{ code: 'unknown' }] },
              ],
            },
          },
        },
      ],
    });

    const collectPaged = async (engine) => {
      const seen = new Set();
      const totals = new Set();
      let sawEmptyPage = false;
      for (let offset = 0; offset < expected.length + 10; offset++) {
        const res = await request(app)
          .post('/tx/r5/ValueSet/$expand')
          .set('Accept', 'application/json')
          .set('Content-Type', 'application/json')
          .send(makeParamsBody(engine, 1, offset));
        expect(res.status).toBe(200);

        const expansion = res.body.expansion;
        totals.add(expansion.total);
        const keys = (expansion.contains || []).map(c => `${c.system}|${c.code}`);

        if (keys.length === 0) {
          sawEmptyPage = true;
          break;
        }

        expect(keys.length).toBeLessThanOrEqual(1);
        for (const key of keys) {
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
      expect(sawEmptyPage).toBe(true);
      return { keys: [...seen].sort(), totals: [...totals].sort((a, b) => a - b) };
    };

    const legacyPaged = await collectPaged('legacy');
    const irPaged = await collectPaged('ir');

    expect(legacyPaged.keys).toEqual(expected);
    expect(irPaged.keys).toEqual(expected);
    expect(legacyPaged.totals).toEqual([expected.length]);
    expect(irPaged.totals).toEqual([expected.length]);
  });
});
