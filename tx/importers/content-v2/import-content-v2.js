'use strict';
// sqlite-v2 content files from FHIR packages and from VSAC (docs/sqlite-v2-content-store.md).
//
//   node tx/importers/content-v2/import-content-v2.js package <package folder> <out.db>
//   node tx/importers/content-v2/import-content-v2.js vsac <vsac-valuesets.db> <out.db>
//
// A package folder is what the package manager unpacks (it has package/package.json). Resources are
// read with main's PackageContentLoader, and accepted or skipped by main's rules, so the file holds
// exactly what main would load.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createContentFile, sha256File } = require('./content-file');
const { ValueSetWriter } = require('./vs-writer');
const { writeCodeSystemBlocks } = require('./cs-blocks');

// bumped when the importer's output changes; package files built by an older importer are rebuilt
const CONTENT_FORMAT = '2';

function peakRssMiB() { return Math.round(process.resourceUsage().maxRSS / 1024); }

async function importPackage(folder, dest, log = console.log, extraProv = {}) {
  const { PackageContentLoader } = require('../../../library/package-manager');
  const { CodeSystem } = require('../../library/codesystem');
  const { assertNoActiveContent } = require('../../../library/narrative-check');
  const { checkContained } = require('../../library/canonical-resource');
  const t0 = Date.now();
  const loader = new PackageContentLoader(path.resolve(folder));
  await loader.initialize();
  const out = createContentFile(dest);
  const { db } = out;
  const skipped = [];

  // CodeSystems: as library.js #loadPackageFromPath
  const codeSystems = [];
  for (const entry of await loader.getResourcesByType('CodeSystem')) {
    try {
      const json = await loader.loadFile(entry, loader.fhirVersion());
      assertNoActiveContent(json);
      const cs = new CodeSystem(json);
      cs.sourcePackage = loader.pid();
      codeSystems.push({ cs, entry });
    } catch (e) {
      skipped.push({ type: 'CodeSystem', id: entry.id || entry.filename, reason: e.message });
    }
  }
  const t1 = Date.now();
  const csCounts = await writeCodeSystemBlocks(db, codeSystems, { log });
  const t2 = Date.now();

  // ValueSets: as vs-package.js _populateDatabase
  const w = new ValueSetWriter(db);
  db.exec('BEGIN');
  for (const entry of await loader.getResourcesByType('ValueSet')) {
    const vs = await loader.loadFile(entry);
    if (!vs.url) continue;
    try {
      checkContained(vs);
      assertNoActiveContent(vs);
    } catch (e) {
      skipped.push({ type: 'ValueSet', id: vs.url, reason: e.message });
      continue;
    }
    w._put(vs, {});
  }
  db.exec('COMMIT');
  const t3 = Date.now();
  const src = ['package/package.json', 'package/.index.json'].map((f) => path.join(folder, f)).filter((f) => fs.existsSync(f));
  const res = out.finish({
    importer: 'content-v2 package',
    contentFormat: CONTENT_FORMAT,
    ...extraProv,
    kind: 'package',
    packageId: loader.id(),
    packageVersion: loader.version(),
    fhirVersion: loader.fhirVersion() || '',
    sources: JSON.stringify(src.map((f) => ({ name: path.relative(folder, f), size: fs.statSync(f).size, sha256: sha256File(f) }))),
    summary: JSON.stringify({ codeSystems: csCounts, valueSets: w.counts, skipped }),
    timings: { codeSystems: (t2 - t1) / 1000, parse: (t1 - t0) / 1000, valueSets: (t3 - t2) / 1000, total: (Date.now() - t0) / 1000 },
  });
  res.peakRssMiB = peakRssMiB();
  res.codeSystems = csCounts;
  res.valueSets = w.counts;
  res.skipped = skipped.length;
  log(JSON.stringify(res));
  return res;
}

function importVsac(srcFile, dest, log = console.log) {
  const t0 = Date.now();
  const src = new Database(srcFile, { readonly: true, fileMustExist: true });
  const out = createContentFile(dest, { wal: true });
  const { db } = out;
  const w = new ValueSetWriter(db);
  let n = 0, rejected = 0;
  db.exec('BEGIN');
  for (const r of src.prepare('SELECT id, content, content_hash, last_seen, date_first_seen FROM valuesets ORDER BY rowid').iterate()) {
    let vs;
    try { vs = JSON.parse(r.content); } catch (e) { rejected++; continue; }
    if (!vs.id) vs.id = r.id;
    w._put(vs, { contentHash: r.content_hash, lastSeen: r.last_seen, dateFirstSeen: r.date_first_seen, related: false });
    if (++n % 5000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
  }
  db.exec('COMMIT');
  // the search tables in the source's row order: ValueSetDatabase rewrites them on every upsert,
  // and a search that joins one returns equal urls in that table's order
  const vsIds = new Map(db.prepare('SELECT id, vs_id FROM value_set').raw().all());
  const rel = [
    ['valueset_identifiers', 'vs_identifier', ['system', 'value', 'use_code', 'type_system', 'type_code']],
    ['valueset_jurisdictions', 'vs_jurisdiction', ['system', 'code', 'display']],
    ['valueset_systems', 'vs_system', ['system', 'version']],
  ];
  for (const [from, to, cols] of rel) {
    const ins = db.prepare(`INSERT INTO ${to} (vs_id, ${cols.join(', ')}) VALUES (${['?', ...cols.map(() => '?')].join(', ')})`);
    db.transaction(() => {
      for (const r of src.prepare(`SELECT valueset_id, ${cols.join(', ')} FROM ${from} ORDER BY rowid`).raw().iterate()) {
        const id = vsIds.get(r[0]);
        if (id != null) ins.run(id, ...r.slice(1));
      }
    })();
  }
  // sync bookkeeping, unchanged
  const copy = (t) => {
    const cols = src.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols.length) return 0;
    const rows = src.prepare(`SELECT ${cols.join(',')} FROM ${t}`).all();
    const ins = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    db.transaction(() => { for (const row of rows) ins.run(cols.map((c) => row[c])); })();
    return rows.length;
  };
  const copied = { vsac_runs: copy('vsac_runs'), vsac_settings: copy('vsac_settings'), vsac_events: copy('vsac_events') };
  src.close();
  const t1 = Date.now();
  const res = out.finish({
    importer: 'content-v2 vsac', kind: 'vsac',
    sources: JSON.stringify([{ name: path.basename(srcFile), size: fs.statSync(srcFile).size }]),
    summary: JSON.stringify({ valueSets: w.counts, rejected, copied }),
    timings: { valueSets: (t1 - t0) / 1000, total: (Date.now() - t0) / 1000 },
  });
  fs.chmodSync(dest, 0o600); // VSAC content is licensed (UMLS): owner-only, as the data dir should be
  res.peakRssMiB = peakRssMiB();
  res.valueSets = w.counts;
  res.rejected = rejected;
  log(JSON.stringify(res));
  return res;
}

if (require.main === module) {
  const [kind, src, dest] = process.argv.slice(2);
  (async () => {
    if (kind === 'package') await importPackage(src, dest);
    else if (kind === 'vsac') importVsac(src, dest);
    else { console.error('usage: import-content-v2.js package|vsac <source> <out.db>'); process.exit(2); }
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { importPackage, importVsac, CONTENT_FORMAT };
