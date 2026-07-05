// Controlled in-branch benchmark of all three expansion engines
// (legacy / pushdown / IR) selected via the _engine parameter — same worker,
// same cs-sqlite provider, same DBs (SNOMED US 20260301, LOINC 2.82).
//
//   node scripts/sqlite-v1-bench/bench-engines.mjs <queries.json> <out.json>
//
// Needs ~/work/tx-dbs/{sct-v1,loinc-v1}.db (built by the v1 importers).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.chdir('/home/jmandel/work/fs2');

const { ExpandWorker } = require('/home/jmandel/work/fs2/tx/workers/expand.js');
const { SqliteCodeSystemFactory } = require('/home/jmandel/work/fs2/tx/cs/cs-sqlite.js');
const { OperationContext } = require('/home/jmandel/work/fs2/tx/operation-context.js');
const { TxParameters } = require('/home/jmandel/work/fs2/tx/params.js');
const { LanguageDefinitions } = require('/home/jmandel/work/fs2/library/languages.js');
const { I18nSupport } = require('/home/jmandel/work/fs2/library/i18nsupport.js');
const ValueSet = require('/home/jmandel/work/fs2/tx/library/valueset.js');

const log = { error: () => {}, debug: () => {}, log: () => {}, info: () => {}, warn: () => {} };
const HOME = process.env.HOME;
const QUERIES = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ENGINES = ['legacy', 'pushdown', 'ir'];

function stub(F) {
  return {
    getCodeSystemProvider: async (op, sys, ver, supp) => (F[sys] ? await F[sys].build(op, supp || []) : null),
    createCodeSystemProvider: async () => null, loadSupplements: () => [], getFhirVersion: () => 'R4',
  };
}
function paramsResource(p, engine) {
  const parameter = [{ name: '_engine', valueString: engine }];
  for (const [k, v] of Object.entries(p)) {
    parameter.push(typeof v === 'boolean' ? { name: k, valueBoolean: v } : { name: k, valueInteger: v });
  }
  return { resourceType: 'Parameters', parameter };
}
async function runOne(F, i18n, ld, q, engine) {
  const op = new OperationContext('en', i18n);
  const worker = new ExpandWorker(op, log, stub(F), ld, i18n);
  const txp = new TxParameters(i18n.languageDefinitions, i18n, false);
  txp.readParams(paramsResource(q.params, engine));
  const vs = new ValueSet({ resourceType: 'ValueSet', status: 'active', url: 'http://test/' + q.id, compose: q.compose });
  try {
    const r = await worker.performExpansion(vs, txp, null);
    const c = r.expansion.contains || [];
    return { total: r.expansion.total, n: c.length, codes: c.map((x) => x.code).join(','), err: null };
  } catch (e) { return { total: null, n: null, codes: null, err: e.msgId || e.cause || e.message || 'error' }; }
}
function stats(ms) {
  const s = ms.slice().sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)] || s[s.length - 1] };
}
async function bench(F, i18n, ld, q, engine, iters) {
  for (let i = 0; i < 3; i++) await runOne(F, i18n, ld, q, engine);
  const ms = []; let last;
  for (let i = 0; i < iters; i++) { const t = performance.now(); last = await runOne(F, i18n, ld, q, engine); ms.push(performance.now() - t); }
  return { ...stats(ms), ...last };
}

async function main() {
  const ld = await LanguageDefinitions.fromFiles('tx/data');
  const i18n = new I18nSupport('translations', ld); await i18n.load();
  const F = {};
  F['http://snomed.info/sct'] = new SqliteCodeSystemFactory(i18n, `${HOME}/work/tx-dbs/sct-v1.db`);
  F['http://loinc.org'] = new SqliteCodeSystemFactory(i18n, `${HOME}/work/tx-dbs/loinc-v1.db`);
  await F['http://snomed.info/sct'].load();
  await F['http://loinc.org'].load();

  const out = [];
  for (const q of QUERIES) {
    const iters = q.params.count === 0 ? 15 : 25;
    const row = { id: q.id, desc: q.desc };
    const results = {};
    for (const eng of ENGINES) { const r = await bench(F, i18n, ld, q, eng, iters); results[eng] = r; row[eng + '_ms'] = r.median; row[eng + '_err'] = r.err; row[eng + '_total'] = r.total; row[eng + '_n'] = r.n; }
    // parity: whichever engines returned rows must agree on codes.
    const ok = ENGINES.map((e) => results[e]).filter((r) => !r.err);
    row.codes_match = ok.every((r) => r.codes === ok[0].codes);
    out.push(row);
    const cell = (e) => results[e].err ? `${e}=${results[e].err}` : `${e} ${results[e].median.toFixed(0)}ms`;
    console.log(`${row.codes_match ? 'OK ' : 'XX '} ${q.id}: ${ENGINES.map(cell).join('  |  ')}  (n=${results.ir.n ?? results.pushdown.n}, total=${results.pushdown_total ?? row.pushdown_total})`);
  }
  fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
  console.log('wrote', process.argv[3]);
}
main().catch((e) => { console.error(e); process.exit(1); });
