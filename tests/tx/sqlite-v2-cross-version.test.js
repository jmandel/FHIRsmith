'use strict';

// One version of a sqlite-v2 system minus another version of it ("US Edition minus
// International"): expand.js hands the compose to the provider (scanValueSet crossVersion,
// processCodes), the compiler evaluates the exclude on the other version's file and translates
// its ids by code (engine/compile.js otherVersion, store.js translateFrom). The usual path walks
// the whole include and locates every code in the other version: on SNOMED CT that took over
// 20 s and ended in the time limit (catalog entry sct-us-minus-intl-whole).

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { V2Builder } = require('../../tx/importers/sqlite-v2/builder');
const { loadSqliteV2Factory } = require('../../tx/sqlite-v2');
const traces = require('../../tx/sqlite-v2/trace');

const SYS = 'http://example.org/fhir/CodeSystem/v2-editions';
const EXPAND = '/tx/r5/ValueSet/$expand';

// version 1: root ─┬─ A ─── A1
//                  └─ B
// version 2 adds N1 (under A), N2 (under B) and N3 (inactive, under root). The new concepts are
// created first, so the same code has a different concept_id in each file.
function build(dest, version, codes) {
  const b = new V2Builder(dest, { overwrite: true, importer: 'test' });
  b.setCodeSystem({ uri: SYS, version });
  const isa = b.property({ code: 'parent', fhirType: 'code', valueKind: 'concept', isHierarchy: true });
  const c = {};
  for (const code of codes) c[code] = b.concept(code, { active: code !== 'N3', display: `display ${code}` });
  const parents = { A: 'root', B: 'root', A1: 'A', N1: 'A', N2: 'B', N3: 'root' };
  for (const code of codes) if (parents[code]) b.link(c[code], isa, c[parents[code]]);
  b.finish();
}

const minus = (include = { system: SYS, version: '2' }) => ({
  resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/v2-minus-v1', status: 'active',
  compose: { include: [include], exclude: [{ system: SYS, version: '1' }] }
});
const codes = (body) => (body.expansion.contains || []).map(c => c.code).sort();

describe('sqlite-v2: an include of one version minus another version of the same system', () => {
  let app, dir, savedTrace;

  async function expand(vs, extra = []) {
    const res = await request(app).post(EXPAND).set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [{ name: 'valueSet', resource: vs }, ...extra] });
    expect(res.status).toBe(200);
    return res.body;
  }

  beforeAll(async () => {
    app = await getTestApp();
    const tx = getTxModule();
    dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-xver-'));
    build(path.join(dir, 'v1.db'), '1', ['root', 'A', 'B', 'A1']);
    build(path.join(dir, 'v2.db'), '2', ['N3', 'N2', 'N1', 'root', 'A', 'B', 'A1']);
    const provider = tx.endpoints[0].provider;
    for (const file of ['v1.db', 'v2.db']) {
      const f = await loadSqliteV2Factory(tx.i18n, path.join(dir, file));
      provider.codeSystemFactories.set(f.system() + '|' + f.version(), f);
      if (f.version() === '2') provider.codeSystemFactories.set(f.system(), f);
    }
    savedTrace = traces.settings.mode;
    traces.settings.mode = 'request';
  }, 120000);

  afterAll(async () => {
    traces.settings.mode = savedTrace;
    await shutdownTestApp();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the provider takes the compose and translates the exclude by code: no walk of the include', async () => {
    const body = await expand(minus(), [{ name: '_trace', valueString: 'true' }]);
    const ext = (body.expansion.extension || []).find(e => e.url === traces.EXTENSION_URL);
    const spans = JSON.parse(ext.valueString).spans;
    expect(spans.find(s => s.label === 'compose via processSelection').handled).toBe(true);
    expect(spans.some(s => s.label === 'from 1')).toBe(true);
    expect(spans.some(s => s.walk)).toBe(false);
    expect(codes(body)).toEqual(['N1', 'N2', 'N3']);
    expect(body.expansion.total).toBe(3);
    const used = (body.expansion.parameter || []).filter(p => p.name === 'used-codesystem').map(p => p.valueUri);
    expect(used).toEqual(expect.arrayContaining([SYS + '|1', SYS + '|2']));
    expect((body.expansion.parameter || []).filter(p => p.name === 'versionsMatch').map(p => p.valueBoolean)).toEqual([true]);
  });

  test('activeOnly, pages and count=0', async () => {
    expect(codes(await expand(minus(), [{ name: 'activeOnly', valueBoolean: true }]))).toEqual(['N1', 'N2']);
    const page = await expand(minus(), [{ name: 'offset', valueInteger: 1 }, { name: 'count', valueInteger: 1 }]);
    expect(page.expansion.contains.length).toBe(1);
    expect(page.expansion.total).toBe(3);
    const counted = await expand(minus(), [{ name: 'count', valueInteger: 0 }]);
    expect(counted.expansion.total).toBe(3);
    expect(counted.expansion.contains).toBeUndefined();
  });

  test('a filtered include minus the other version', async () => {
    const body = await expand(minus({ system: SYS, version: '2', filter: [{ property: 'concept', op: 'is-a', value: 'A' }] }));
    expect(codes(body)).toEqual(['N1']);
  });
});
