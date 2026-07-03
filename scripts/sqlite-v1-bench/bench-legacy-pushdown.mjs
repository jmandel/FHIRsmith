// Bench legacy vs pushdown in the sqlite-v1 PR branch (~/work/fs2), same
// provider toggled by handlesSelecting. Content: SNOMED US 20260301, LOINC 2.82.
process.chdir('/home/jmandel/work/fs2');
const fs = require('fs');
const { ExpandWorker } = require('/home/jmandel/work/fs2/tx/workers/expand.js');
const { SqliteCodeSystemFactory } = require('/home/jmandel/work/fs2/tx/cs/cs-sqlite.js');
const { OperationContext } = require('/home/jmandel/work/fs2/tx/operation-context.js');
const { TxParameters } = require('/home/jmandel/work/fs2/tx/params.js');
const { LanguageDefinitions } = require('/home/jmandel/work/fs2/library/languages.js');
const { I18nSupport } = require('/home/jmandel/work/fs2/library/i18nsupport.js');
const ValueSet = require('/home/jmandel/work/fs2/tx/library/valueset.js');

const log = { error: () => {}, debug: () => {}, log: () => {}, info: () => {}, warn: () => {} };
const QUERIES = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const HOME = process.env.HOME;

function stub(factory, forceLegacy) {
  return {
    getCodeSystemProvider: async (op, sys, ver, supp) => {
      const f = factory[sys]; if (!f) return null;
      const p = await f.build(op, supp || []);
      if (forceLegacy) p.handlesSelecting = () => false;
      return p;
    },
    createCodeSystemProvider: async () => null,
    loadSupplements: () => [],
    getFhirVersion: () => 'R4',
  };
}

function paramsResource(p) {
  const parameter = [];
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'boolean') parameter.push({ name: k, valueBoolean: v });
    else parameter.push({ name: k, valueInteger: v });
  }
  return { resourceType: 'Parameters', parameter };
}

async function runOne(factory, i18n, langDefs, q, forceLegacy) {
  const op = new OperationContext('en', i18n);
  const worker = new ExpandWorker(op, log, stub(factory, forceLegacy), langDefs, i18n);
  const txp = new TxParameters(i18n.languageDefinitions, i18n, false);
  txp.readParams(paramsResource(q.params));
  const vs = new ValueSet({ resourceType: 'ValueSet', status: 'active', url: 'http://test/' + q.id, compose: q.compose });
  try {
    const r = await worker.performExpansion(vs, txp, null);
    const contains = r.expansion.contains || [];
    return { total: r.expansion.total, n: contains.length, codes: contains.map((c) => c.code).join(','), err: null };
  } catch (e) {
    return { total: null, n: null, codes: null, err: e.msgId || e.cause || e.message || 'error' };
  }
}

function stats(ms) {
  const s = ms.slice().sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)] || s[s.length - 1], min: s[0] };
}

async function bench(factory, i18n, langDefs, q, forceLegacy, iters) {
  for (let i = 0; i < 3; i++) await runOne(factory, i18n, langDefs, q, forceLegacy); // warmup
  const ms = [];
  let last;
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    last = await runOne(factory, i18n, langDefs, q, forceLegacy);
    ms.push(performance.now() - t);
  }
  return { ...stats(ms), total: last.total, n: last.n, codes: last.codes, err: last.err };
}

async function main() {
  const langDefs = await LanguageDefinitions.fromFiles('tx/data');
  const i18n = new I18nSupport('translations', langDefs); await i18n.load();
  const factory = {};
  factory['http://snomed.info/sct'] = new SqliteCodeSystemFactory(i18n, `${HOME}/work/tx-dbs/sct-v1.db`);
  factory['http://loinc.org'] = new SqliteCodeSystemFactory(i18n, `${HOME}/work/tx-dbs/loinc-v1.db`);
  await factory['http://snomed.info/sct'].load();
  await factory['http://loinc.org'].load();

  const out = [];
  for (const q of QUERIES) {
    const iters = q.params.count === 0 ? 15 : 25;
    const legacy = await bench(factory, i18n, langDefs, q, true, iters);
    const push = await bench(factory, i18n, langDefs, q, false, iters);
    const match = legacy.err ? null : legacy.codes === push.codes;
    out.push({ id: q.id, desc: q.desc, legacy_ms: legacy.median, legacy_p95: legacy.p95, legacy_err: legacy.err,
      pushdown_ms: push.median, pushdown_p95: push.p95, pushdown_err: push.err, n: push.n,
      legacy_total: legacy.total, pushdown_total: push.total, codes_match: match });
    const tag = legacy.err ? `legacy=${legacy.err}` : (match ? 'OK ' : 'XX ');
    console.log(`${tag} ${q.id}: legacy ${legacy.median.toFixed(1)}ms -> pushdown ${push.median.toFixed(1)}ms  (n=${push.n}, total L=${legacy.total} P=${push.total})`);
  }
  fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
  console.log('wrote', process.argv[3]);
}
main().catch((e) => { console.error(e); process.exit(1); });
