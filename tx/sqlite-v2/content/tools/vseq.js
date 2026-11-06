// Provider-level equivalence: main's PackageValueSetProvider / VSACValueSetProvider vs
// ContentValueSetProvider on the content file built from the same source.
//   node vseq.js package <pkgfolder> <content.db> <out.json>
//   node vseq.js vsac <datadir with terminology-cache/vsac/vsac-valuesets.db> <content.db> <out.json>
'use strict';
const REPO = process.env.REPO;
const fs = require('fs');
const [kind, src, file, outFile] = process.argv.slice(2);
const stats = { addTask() {}, task() {}, taskDone() {}, taskError() {} };
const ctx = (a, b) => {
  if (a == null || b == null) return [a && a.slice(0, 300), b && b.slice(0, 300)];
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [a.slice(Math.max(0, i - 150), i + 250), b.slice(Math.max(0, i - 150), i + 250)];
};
const ser = (vs) => vs == null ? null : JSON.stringify({ json: vs.jsonObj || vs, id: vs.id, url: vs.url, version: vs.version, src: vs.sourcePackage, hash: vs.contentHash ?? null, cached: !!vs.isCached, n: typeof vs.conceptCount === 'function' ? vs.conceptCount() : null });

(async () => {
  const { ContentValueSetProvider } = require(REPO + '/tx/sqlite-v2/content/content-vs-provider');
  let main, prefix, rows;
  const Database = require(REPO + '/node_modules/better-sqlite3');
  const cdb = new Database(file, { readonly: true });
  rows = cdb.prepare('SELECT id, url, version FROM value_set ORDER BY vs_id').all();
  if (kind === 'package') {
    const { PackageContentLoader } = require(REPO + '/library/package-manager');
    const { PackageValueSetProvider } = require(REPO + '/tx/vs/vs-package');
    const loader = new PackageContentLoader(src);
    await loader.initialize();
    main = new PackageValueSetProvider(loader);
    await main.initialize();
    prefix = 'p';
  } else {
    process.env.FHIRSMITH_DATA_DIR = src;
    const { VSACValueSetProvider } = require(REPO + '/tx/vs/vs-vsac');
    main = new VSACValueSetProvider({ apiKey: 'not-used-the-db-is-preloaded', refreshIntervalHours: 500 }, stats);
    await main.initialize();
    main.stopRefreshTimer && main.stopRefreshTimer();
    prefix = 'vsac';
  }
  main.assignIds(prefix);
  const ours = new ContentValueSetProvider(file, { kind, source: main.sourcePackage() });
  await ours.initialize();
  ours.assignIds(prefix);
  const urls = [...new Set(rows.map((r) => r.url))];
  const diffs = []; let n = 0;
  const t = { main: 0, ours: 0 };
  const cmp = async (what, f) => {
    n++;
    let t0 = process.hrtime.bigint();
    const a = ser(await f(main));
    t.main += Number(process.hrtime.bigint() - t0) / 1e6; t0 = process.hrtime.bigint();
    const b = ser(await f(ours));
    t.ours += Number(process.hrtime.bigint() - t0) / 1e6;
    if (a !== b) { const [x, y] = ctx(a, b); diffs.push({ what, main: x, ours: y }); }
  };
  for (const u of urls) {
    await cmp(['url', u], (p) => p.fetchValueSet(u));
    await cmp(['url|1.0.0', u], (p) => p.fetchValueSet(u, '1.0.0'));
    await cmp(['url|1.0', u], (p) => p.fetchValueSet(u, '1.0'));
    await cmp(['url|nonsense', u], (p) => p.fetchValueSet(u, '99990101'));
  }
  for (const r of rows) {
    await cmp(['url|version', r.url, r.version], (p) => p.fetchValueSet(r.url, r.version));
    if (r.version && /^\d+\.\d+\.\d+/.test(r.version)) {
      const mm = r.version.split('.').slice(0, 2).join('.');
      await cmp(['url|mm', r.url, mm], (p) => p.fetchValueSet(r.url, mm));
    }
    await cmp(['id', r.id], (p) => p.fetchValueSetById(prefix + '-' + r.id));
    await cmp(['raw id', r.id], (p) => p.fetchValueSetById(r.id));
  }
  for (const u of ['http://example.org/none', rows[0].id]) await cmp(['miss', u], (p) => p.fetchValueSet(u));
  const sser = (l) => JSON.stringify(l.map((x) => JSON.parse(ser(x))));
  let sn = 0;
  const scmp = async (what, params, elements) => {
    sn++;
    const [a, b] = [sser(await main.searchValueSets(params, elements)), sser(await ours.searchValueSets(params, elements))];
    if (a !== b) { const [x, y] = ctx(a, b); diffs.push({ what, main: x, ours: y }); }
  };
  for (let i = 0; i < urls.length; i += (kind === 'vsac' ? 5 : 1)) await scmp(['search url', urls[i]], [{ name: 'url', value: urls[i] }], null);
  for (let i = 0; i < rows.length; i += 7) await scmp(['search url+version', rows[i].url, rows[i].version], [{ name: 'url', value: rows[i].url }, { name: 'version', value: rows[i].version || '' }], null);
  for (let i = 0; i < urls.length; i += 50) await scmp(['search url elements', urls[i]], [{ name: 'url', value: urls[i] }], ['url', 'version', 'title']);
  const terms = kind === 'vsac'
    ? [['title', 'Cohort'], ['name', 'Diabetes'], ['publisher', 'NCQA'], ['status', 'draft'], ['system', 'http://loinc.org'], ['identifier', '2.16.840.1.113883.3.464.1003.103.12.1001'], ['description', 'asthma'], ['date', '2024-01'], ['version', '2025'], ['code', '44054006']]
    : [['title', 'Race'], ['name', 'Status'], ['publisher', 'HL7'], ['status', 'active'], ['system', 'http://snomed.info/sct'], ['system', 'http://loinc.org'], ['identifier', 'urn:ietf:rfc:3986'], ['jurisdiction', 'US'], ['description', 'code'], ['version', '1.0'], ['code', '1002-5'], ['code', 'PHVS']];
  for (const [nm, v] of terms) {
    await scmp(['search ' + nm, v], [{ name: nm, value: v }], null);
    await scmp(['search ' + nm + ' elements', v], [{ name: nm, value: v }], ['id', 'url', 'version', 'name']);
  }
  if (kind === 'package') await scmp(['search all'], [], ['id', 'url']);
  // usage scan
  const Tracker = require(REPO + '/tx/usage-tracker');
  const ta = new Tracker(), tb = new Tracker();
  const lib = (vsp) => ({ valueSetProviders: [vsp] });
  let t0 = Date.now(); const ca = await ta.scanValueSets(lib(main)); const ma = Date.now() - t0;
  t0 = Date.now(); const cb = await tb.scanValueSets(lib(ours)); const mb = Date.now() - t0;
  const dump = (tr) => JSON.stringify([...tr.map].sort().map(([s, m]) => [s, [...m].sort().map(([c, v]) => [c, v.count])]));
  const usageSame = ca === cb && dump(ta) === dump(tb);
  if (!usageSame) diffs.push({ what: ['usage scan'], main: ca, ours: cb });
  const out = { kind, rows: rows.length, urls: urls.length, fetchChecks: n, searchChecks: sn, diffs: diffs.length, fetchMs: t, usage: { same: usageSame, count: [ca, cb], ms: [ma, mb] }, listAll: [(await main.listAllValueSets()).length, (await ours.listAllValueSets()).length] };
  console.log(JSON.stringify(out));
  fs.writeFileSync(outFile, JSON.stringify({ ...out, list: diffs }, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
