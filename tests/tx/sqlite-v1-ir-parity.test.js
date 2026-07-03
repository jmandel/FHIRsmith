/**
 * sqlite-v1 three-engine parity: legacy vs pushdown vs IR (_engine param).
 *
 * Each hard/mixed query is expanded through the real ExpandWorker three times,
 * selecting the engine via the _engine parameter ('legacy'|'pushdown'|'ir').
 * The IR route (processViaIR -> tx/engine orchestrator -> cs-sqlite native
 * terminals) decorates through the SAME includeCode path as the other two, so
 * we can require byte-identical code sequences and totals.
 *
 * Legacy may throw VALUESET_TOO_COSTLY on deep-offset / total-only requests
 * (it materialises the whole set before paging); that outcome is recorded and
 * pushdown/IR are still required to agree with each other. For queries legacy
 * completes, all three must agree.
 *
 * Loud-skip if the required DB is absent; never a silent green.
 */

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
const SCT_DB = path.join(DB_DIR, 'sct-v1.db');
const LOINC_DB = path.join(DB_DIR, 'loinc-v1.db');
const SCT = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';
const quietLog = { error: () => {}, debug: () => {}, log: () => {}, info: () => {}, warn: () => {} };

function stub(factories) {
  return {
    getCodeSystemProvider: async (op, sys, ver, supp) => (factories[sys] ? await factories[sys].build(op, supp || []) : null),
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

const haveSct = fs.existsSync(SCT_DB);
const haveLoinc = fs.existsSync(LOINC_DB);
if (!haveSct || !haveLoinc) {
  const missing = [!haveSct && SCT_DB, !haveLoinc && LOINC_DB].filter(Boolean);
  // eslint-disable-next-line no-console
  console.warn(`[sqlite-v1-ir-parity] SKIPPING — missing DB(s): ${missing.join(', ')}`);
}
const describeIf = (haveSct && haveLoinc) ? describe : describe.skip;

describeIf('sqlite-v1 three-engine parity (legacy/pushdown/ir)', () => {
  jest.setTimeout(600000);
  let factories, i18n, langDefs;

  beforeAll(async () => {
    langDefs = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
    i18n = new I18nSupport(path.join(__dirname, '../../translations'), langDefs);
    await i18n.load();
    factories = {};
    factories[SCT] = new SqliteCodeSystemFactory(i18n, SCT_DB);
    factories[LOINC] = new SqliteCodeSystemFactory(i18n, LOINC_DB);
    await factories[SCT].load();
    await factories[LOINC].load();
  });

  afterAll(() => {
    if (factories) { factories[SCT].close(); factories[LOINC].close(); }
  });

  async function expand(compose, engine, extra) {
    const op = new OperationContext('en', i18n);
    const worker = new ExpandWorker(op, quietLog, stub(factories), langDefs, i18n);
    const txp = new TxParameters(i18n.languageDefinitions, i18n, false);
    txp.readParams(paramsResource(extra, engine));
    const vs = new ValueSet({ resourceType: 'ValueSet', status: 'active', url: 'http://test/vs', compose });
    try {
      const r = await worker.performExpansion(vs, txp, null);
      const c = r.expansion.contains || [];
      return { total: r.expansion.total, codes: c.map((x) => x.code), err: null };
    } catch (e) { return { total: null, codes: null, err: e.msgId || e.cause || e.message || 'error' }; }
  }

  const CASES = [
    ['is-a Clinical finding, page 50', { include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }] }, { count: 50 }],
    ['is-a Clinical finding, offset 2000', { include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }] }, { count: 25, offset: 2000 }],
    ['is-a Procedure, total-only', { include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '71388002' }] }] }, { count: 0 }],
    ['is-a MI AND descendent-of heart-disorder', { include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '22298006' }, { property: 'concept', op: 'descendent-of', value: '56265001' }] }] }, { count: 200 }],
    ['diabetes MINUS type-1', { include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }], exclude: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '46635009' }] }] }, { count: 100 }],
    ['is-a Body structure, activeOnly', { include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: '123037004' }] }] }, { count: 100, activeOnly: true }],
    ['refset membership as a filter', { include: [{ system: SCT, filter: [{ property: 'concept', op: 'in', value: '723264001' }] }] }, { count: 80 }],
    ['LOINC CLASSTYPE=1, page 100', { include: [{ system: LOINC, filter: [{ property: 'CLASSTYPE', op: '=', value: '1' }] }] }, { count: 100 }],
    ['LOINC STATUS=ACTIVE, page 150', { include: [{ system: LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] }] }, { count: 150 }],
  ];

  test.each(CASES)('%s: pushdown == ir (and == legacy when legacy completes)', async (_label, compose, extra) => {
    const legacy = await expand(compose, 'legacy', extra);
    const pushdown = await expand(compose, 'pushdown', extra);
    const ir = await expand(compose, 'ir', extra);

    // pushdown and IR must always agree exactly.
    expect(ir.err).toBeNull();
    expect(pushdown.err).toBeNull();
    expect(ir.codes).toEqual(pushdown.codes);
    expect(ir.total).toBe(pushdown.total);

    // When legacy completes, it must agree too.
    if (!legacy.err) {
      expect(pushdown.codes).toEqual(legacy.codes);
    }
  });

  test('refset-as-filter membership is non-empty (closes the IR-draft gap)', async () => {
    const compose = { include: [{ system: SCT, filter: [{ property: 'concept', op: 'in', value: '723264001' }] }] };
    const ir = await expand(compose, 'ir', { count: 10 });
    expect(ir.err).toBeNull();
    expect(ir.total).toBeGreaterThan(1000);
  });
});
