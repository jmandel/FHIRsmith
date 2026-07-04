'use strict';

// SNOMED CT $lookup conformance for the generic sqlite-v1 provider: the FULL
// LookupWorker response for the official tx-ecosystem fixtures
//   - lookup-procedure(-request/-response).json     367430006 |Repair of tendon of hand|
//   - lookup-procedure-pc-*                          367430006:{272741003=24028007}
// must match the expected response parameter-for-parameter (order-insensitive,
// honoring the fixtures' $optional$ / $optional-properties$ markers).
//
// The reference shape this pins down (all cs_config-driven, see cs-sqlite.js
// extendLookup):
//   - outbound is-a edges  -> `parent` properties with description;
//   - inbound is-a edges   -> `child` properties with description;
//   - defining relationships -> attribute properties (code = attribute SCTID)
//     with code-display + description, DISTINCT (attribute, target) over all
//     relationship rows including historical/inactive ones;
//   - moduleId literal -> `module` + module concept display; definitionStatusId
//     not in $lookup; no duplicated `inactive` literal;
//   - designations = the RF2 descriptions only, use codings carrying the
//     description-type concept's display;
//   - a post-coordinated expression surfaces its (single) focus concept's
//     properties plus each refinement as an attribute property.
//
// Known reference-fixture artifact: the fixtures carry effectiveTime
// 2005-01-30, one day BEFORE the RF2 effectiveTime (20050131), because the
// reference binary converts its day-count through a LOCAL-time Date +
// toISOString() and the fixtures were generated in a UTC+ timezone. Run in a
// UTC- timezone the reference emits 2005-01-31 — which is what this provider
// emits (the actual RF2 date). The comparison below normalizes that one value.
//
// Loud-skips (never a silent green) if the DB or fixtures are absent.

const fs = require('fs');
const path = require('path');

const { SqliteCodeSystemFactory } = require('../../tx/cs/cs-sqlite.js');
const LookupWorker = require('../../tx/workers/lookup.js');
const { OperationContext } = require('../../tx/operation-context.js');
const { LanguageDefinitions } = require('../../library/languages.js');
const { I18nSupport } = require('../../library/i18nsupport.js');
const { TxParameters } = require('../../tx/params.js');

const DB_DIR = path.join(process.env.HOME, 'work', 'tx-dbs');
const SCT_DB = path.join(DB_DIR, 'sct-intl-20250201-v1.db');
const FIX_DIR = path.join(
  process.env.HOME, '.fhir', 'packages',
  'hl7.fhir.uv.tx-ecosystem#current', 'package', 'tests', 'sct'
);
const quietLog = { error: () => {}, debug: () => {}, log: () => {}, info: () => {}, warn: () => {} };

const haveDb = fs.existsSync(SCT_DB);
const haveFix = fs.existsSync(path.join(FIX_DIR, 'lookup-procedure-response.json'));
if (!haveDb || !haveFix) {
  // eslint-disable-next-line no-console
  console.warn(`[sqlite-v1-sct-lookup] SKIPPING — missing ${!haveDb ? SCT_DB : ''} ${!haveFix ? FIX_DIR : ''}`.trim());
}
const describeIf = (haveDb && haveFix) ? describe : describe.skip;

// ---- fixture comparison (order-insensitive, $optional$-aware) -------------

// Does the actual value satisfy the expected one? Object sub-properties listed
// in $optional-properties$ may be absent from actual.
function valueSatisfies(exp, act) {
  if (exp === null || typeof exp !== 'object') return exp === act;
  if (Array.isArray(exp)) {
    return Array.isArray(act) && exp.length === act.length &&
      exp.every((e, i) => valueSatisfies(e, act[i]));
  }
  if (act === null || typeof act !== 'object' || Array.isArray(act)) return false;
  const optionalProps = new Set(exp['$optional-properties$'] || []);
  for (const [k, v] of Object.entries(exp)) {
    if (k.startsWith('$')) continue;
    if (!(k in act)) {
      if (optionalProps.has(k)) continue;
      return false;
    }
    if (!valueSatisfies(v, act[k])) return false;
  }
  return Object.keys(act).every((k) => k in exp);
}

// Does an actual parameter/part satisfy the expected one? Parts marked
// $optional$ may be absent; actual may not carry unexpected extra parts.
function paramSatisfies(exp, act) {
  const expKeys = Object.keys(exp).filter((k) => !k.startsWith('$') && k !== 'part');
  const actKeys = Object.keys(act).filter((k) => k !== 'part');
  if (expKeys.length !== actKeys.length) return false;
  for (const k of expKeys) {
    if (!(k in act) || !valueSatisfies(exp[k], act[k])) return false;
  }
  if ((exp.part == null) !== (act.part == null)) return false;
  const actParts = (act.part || []).slice();
  for (const ep of exp.part || []) {
    const i = actParts.findIndex((ap) => paramSatisfies(ep, ap));
    if (i >= 0) actParts.splice(i, 1);
    else if (ep['$optional$'] !== true) return false;
  }
  return actParts.length === 0;
}

function diffParameters(expected, actual) {
  const remaining = actual.parameter.slice();
  const missing = [];
  for (const ep of expected.parameter) {
    const i = remaining.findIndex((ap) => paramSatisfies(ep, ap));
    if (i >= 0) remaining.splice(i, 1);
    else if (ep['$optional$'] !== true) missing.push(ep);
  }
  return { missing, extra: remaining };
}

function propsOf(result, code) {
  return result.parameter
    .filter((p) => p.name === 'property' &&
      p.part.some((q) => q.name === 'code' && q.valueCode === code));
}

function partVal(prop, name) {
  const p = prop.part.find((q) => q.name === name);
  if (!p) return undefined;
  return p.valueCode ?? p.valueString ?? p.valueDateTime ?? p.valueBoolean;
}

describeIf('sqlite-v1 SNOMED $lookup conformance', () => {
  jest.setTimeout(120000);
  let factory, prov, worker, txp;

  beforeAll(async () => {
    const langDefs = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
    const i18n = new I18nSupport(path.join(__dirname, '../../translations'), langDefs);
    await i18n.load();
    const opc = new OperationContext('en', i18n);
    factory = new SqliteCodeSystemFactory(i18n, SCT_DB);
    await factory.load();
    prov = await factory.build(opc, []);
    worker = new LookupWorker(opc, quietLog, null, langDefs, i18n);
    txp = new TxParameters(langDefs, i18n);
  });

  afterAll(() => { if (factory) factory.close(); });

  async function runFixture(name) {
    const req = JSON.parse(fs.readFileSync(path.join(FIX_DIR, `${name}-request.json`)));
    const expected = JSON.parse(fs.readFileSync(path.join(FIX_DIR, `${name}-response.json`)));
    const code = req.parameter.find((p) => p.name === 'code').valueCode;
    const actual = await worker.doLookup(prov, code, txp, null);
    // Known fixture artifact (see header): expected effectiveTime is one day
    // behind the RF2 date because of the reference's local-time conversion.
    for (const p of expected.parameter) {
      if (p.name !== 'property') continue;
      if (p.part.some((q) => q.name === 'code' && q.valueCode === 'effectiveTime')) {
        const v = p.part.find((q) => q.name === 'value');
        if (v.valueDateTime === '2005-01-30') v.valueDateTime = '2005-01-31';
      }
    }
    return { expected, actual };
  }

  test('367430006 $lookup matches lookup-procedure-response exactly', async () => {
    const { expected, actual } = await runFixture('lookup-procedure');
    const d = diffParameters(expected, actual);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([]);
  });

  test('367430006 parent properties: each outbound is-a, with description', async () => {
    const { actual } = await runFixture('lookup-procedure');
    const parents = propsOf(actual, 'parent')
      .map((p) => [partVal(p, 'value'), partVal(p, 'description')]).sort();
    expect(parents).toEqual([
      ['119657005', 'Hand repair'],
      ['274059009', 'Hand tendon operation'],
      ['281760001', 'Repair of tendon of upper limb'],
    ]);
    // The raw is-a property code never leaks into $lookup.
    expect(propsOf(actual, '116680003')).toEqual([]);
  });

  test('367430006 child properties: each inbound is-a, with description', async () => {
    const { actual } = await runFixture('lookup-procedure');
    const children = propsOf(actual, 'child').map((p) => partVal(p, 'value')).sort();
    expect(children).toEqual([
      '18701002', '214433003', '243234005', '26731003', '27106001', '45810006',
      '709291000', '712638006', '76340004', '90650008', '90907001', '91092007',
    ].sort());
    // Descriptions use the reference's first-active-description rule — for
    // 18701002 that is the FSN, not the preferred synonym.
    const graft = propsOf(actual, 'child').find((p) => partVal(p, 'value') === '18701002');
    expect(partVal(graft, 'description')).toBe('Repair of tendon of hand with graft (procedure)');
  });

  test('367430006 attribute properties: distinct targets with code-display/description', async () => {
    const { actual } = await runFixture('lookup-procedure');
    const method = propsOf(actual, '260686004');
    expect(method.map((p) => partVal(p, 'value')).sort())
      .toEqual(['129284003', '129342008', '257903006']);
    for (const p of method) expect(partVal(p, 'code-display')).toBe('Method');
    expect(partVal(method.find((p) => partVal(p, 'value') === '257903006'), 'description'))
      .toBe('Repair - action');

    const site = propsOf(actual, '363704007');
    expect(site.map((p) => partVal(p, 'value')).sort())
      .toEqual(['118632007', '13024002', '245098002', '85562004']);
    for (const p of site) expect(partVal(p, 'code-display')).toBe('Procedure site');

    const direct = propsOf(actual, '405813007');
    expect(direct.map((p) => partVal(p, 'value')).sort())
      .toEqual(['118632007', '245098002']);
    for (const p of direct) {
      expect(partVal(p, 'code-display')).toBe('Procedure site - Direct (attribute)');
    }
  });

  test('367430006 metadata literals: module renamed+described, others shaped', async () => {
    const { actual } = await runFixture('lookup-procedure');
    const mod = propsOf(actual, 'module');
    expect(mod).toHaveLength(1);
    expect(partVal(mod[0], 'value')).toBe('900000000000207008');
    expect(partVal(mod[0], 'description')).toBe('SNOMED CT core module');
    expect(propsOf(actual, 'moduleId')).toEqual([]);
    expect(propsOf(actual, 'definitionStatusId')).toEqual([]);
    // exactly one inactive property (the worker's), no duplicate literal
    expect(propsOf(actual, 'inactive')).toHaveLength(1);
    const et = propsOf(actual, 'effectiveTime');
    expect(et).toHaveLength(1);
    expect(partVal(et[0], 'value')).toBe('2005-01-31'); // dashed FHIR dateTime
  });

  test('pc expression $lookup matches lookup-procedure-pc-response exactly', async () => {
    const { expected, actual } = await runFixture('lookup-procedure-pc');
    const d = diffParameters(expected, actual);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([]);
  });

  test('pc expression surfaces focus concept properties plus the refinement', async () => {
    const { actual } = await runFixture('lookup-procedure-pc');
    // focus concept's hierarchy comes through
    expect(propsOf(actual, 'parent')).toHaveLength(3);
    expect(propsOf(actual, 'child')).toHaveLength(12);
    // the refinement itself: Laterality = Right
    const lat = propsOf(actual, '272741003');
    expect(lat).toHaveLength(1);
    expect(partVal(lat[0], 'value')).toBe('24028007');
    expect(partVal(lat[0], 'code-display')).toBe('Laterality');
    expect(partVal(lat[0], 'description')).toBe('Right');
  });
});
