'use strict';

// Focused regression tests for the two SNOMED status root-cause fixes in the
// generic sqlite-v1 provider:
//
//   1. A filter on the boolean status property (`inactive = false|true`) must
//      map to concept.active — active concepts carry no stored `inactive=false`
//      literal, so a literal match yields the empty set. `inactive=false`
//      resolves to the active concepts (root cause: is-a X AND inactive=false
//      returned 0 instead of the reference's non-empty set).
//
//   2. The status/`inactive` property is surfaced in an expansion ONLY for
//      genuinely INACTIVE concepts (getStatus() === 'active' for active ones,
//      so includeCode skips the property). Active concepts must NOT be
//      decorated with a status property, and expansion.property must not
//      declare `status` when no returned concept is inactive.
//
// Both are config-driven: they fire only when cs_config statusProperty ===
// inactiveProperty (SNOMED), leaving enum status properties (LOINC STATUS)
// untouched. Loud-skip (never a silent green) if the SNOMED fixture is absent.

const fs = require('fs');
const path = require('path');

const { ExpandWorker } = require('../../tx/workers/expand.js');
const { SqliteCodeSystemFactory } = require('../../tx/cs/cs-sqlite.js');
const { OperationContext } = require('../../tx/operation-context.js');
const { TxParameters } = require('../../tx/params.js');
const { LanguageDefinitions } = require('../../library/languages.js');
const { I18nSupport } = require('../../library/i18nsupport.js');
const ValueSet = require('../../tx/library/valueset.js');

const DB_DIR = path.join(process.env.HOME, 'work', 'tx-dbs');
const SCT_DB = path.join(DB_DIR, 'sct-intl-20250201-v1.db');
const SCT = 'http://snomed.info/sct';
const quietLog = { error: () => {}, debug: () => {}, log: () => {}, info: () => {}, warn: () => {} };

const haveDb = fs.existsSync(SCT_DB);
if (!haveDb) {
  // eslint-disable-next-line no-console
  console.warn(`[sqlite-v1-sct-status] SKIPPING — missing DB: ${SCT_DB}`);
}
const describeIf = haveDb ? describe : describe.skip;

describeIf('sqlite-v1 SNOMED status property + inactive-filter mapping', () => {
  jest.setTimeout(120000);
  let factory, prov, i18n, langDefs, opc;

  beforeAll(async () => {
    langDefs = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
    i18n = new I18nSupport(path.join(__dirname, '../../translations'), langDefs);
    await i18n.load();
    opc = new OperationContext('en', i18n);
    factory = new SqliteCodeSystemFactory(i18n, SCT_DB);
    await factory.load();
    prov = await factory.build(opc, []);
  });

  afterAll(() => { if (factory) factory.close(); });

  function stub() {
    return {
      getCodeSystemProvider: async (op, sys) => (sys === SCT ? await factory.build(op, []) : null),
      createCodeSystemProvider: async () => null,
      loadSupplements: () => [],
      getFhirVersion: () => 'R4',
    };
  }
  function paramsResource(p, engine) {
    const parameter = [{ name: '_engine', valueString: engine }];
    for (const [k, v] of Object.entries(p || {})) {
      parameter.push(typeof v === 'boolean' ? { name: k, valueBoolean: v } : { name: k, valueInteger: v });
    }
    return { resourceType: 'Parameters', parameter };
  }
  async function expand(compose, engine, extra) {
    const worker = new ExpandWorker(new OperationContext('en', i18n), quietLog, stub(), langDefs, i18n);
    const txp = new TxParameters(i18n.languageDefinitions, i18n, false);
    txp.readParams(paramsResource(extra, engine));
    const vs = new ValueSet({ resourceType: 'ValueSet', status: 'active', url: 'http://test/vs', compose });
    const r = await worker.performExpansion(vs, txp, null);
    return r.expansion;
  }

  // ---- root cause 1: inactive filter -> concept.active -------------------

  test('getStatus maps the boolean status property to active/inactive', async () => {
    expect(await prov.getStatus('102613000')).toBe('active');   // active concept
    expect(await prov.getStatus('100005')).toBe('inactive');    // retired concept
  });

  test('inactive=false filter resolves to active concepts (not the empty set)', async () => {
    // The exact reference case: is-a 15230009 AND inactive=false -> 6 members
    // (snomed-expand-active). Before the fix this returned total 0 because the
    // literal `inactive=false` row does not exist for active concepts.
    const compose = { include: [{ system: SCT, filter: [
      { property: 'concept', op: 'is-a', value: '15230009' },
      { property: 'inactive', op: '=', value: 'false' },
    ] }] };
    for (const engine of ['legacy', 'pushdown', 'ir']) {
      const exp = await expand(compose, engine, { count: 0 });
      expect(exp.total).toBe(6);
    }
  });

  test('inactive=true and inactive=false partition the same is-a set', async () => {
    const base = { property: 'concept', op: 'is-a', value: '73211009' }; // Diabetes mellitus
    const total = (exp) => exp.total;
    const all = await expand({ include: [{ system: SCT, filter: [base] }] }, 'pushdown', { count: 0 });
    const active = await expand({ include: [{ system: SCT, filter: [base, { property: 'inactive', op: '=', value: 'false' }] }] }, 'pushdown', { count: 0 });
    const inactive = await expand({ include: [{ system: SCT, filter: [base, { property: 'inactive', op: '=', value: 'true' }] }] }, 'pushdown', { count: 0 });
    expect(active.total).toBeGreaterThan(0);
    expect(total(active) + total(inactive)).toBe(total(all));
  });

  // ---- root cause 2: status property only on inactive concepts -----------

  test('an all-active expansion emits NO status property and no status declaration', async () => {
    const compose = { include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '15230009' }, { property: 'inactive', op: '=', value: 'false' }] }] };
    for (const engine of ['legacy', 'pushdown', 'ir']) {
      const exp = await expand(compose, engine, { count: 50 });
      const decls = (exp.property || []).map((p) => p.code);
      expect(decls).not.toContain('status');
      for (const c of exp.contains || []) {
        const codes = (c.property || []).map((p) => p.code);
        expect(codes).not.toContain('status');
      }
    }
  });

  test('an inactive member IS decorated with status=inactive; active siblings are not', async () => {
    // Concept list mixing an active (102613000) and an inactive (100005) code,
    // expanded without activeOnly so the inactive one is retained.
    const compose = { include: [{ system: SCT, concept: [{ code: '102613000' }, { code: '100005' }] }] };
    const exp = await expand(compose, 'pushdown', { count: 50 });
    const byCode = Object.fromEntries((exp.contains || []).map((c) => [c.code, c]));
    expect(byCode['100005']).toBeTruthy();
    const inactiveStatus = (byCode['100005'].property || []).find((p) => p.code === 'status');
    expect(inactiveStatus && inactiveStatus.valueCode).toBe('inactive');
    const activeStatus = (byCode['102613000'].property || []).find((p) => p.code === 'status');
    expect(activeStatus).toBeUndefined();
  });
});
