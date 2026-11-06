'use strict';

// Reverse loader (FHIRsmith SNOMED cache -> sqlite-v2): build a cache from the test edition RF2 in
// tx/data/snomed with main's cache importer, reverse-load it, and compare with the RF2 v2 import of
// the same files. Every fact and every stored set must agree, except what the cache cannot carry
// (docs/sqlite-v2-sct-from-cache.md): here, refset fields naming concepts that are not in the edition.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SnomedImporter } = require('../../tx/importers/import-sct.module');
const { importSnomedV2 } = require('../../tx/importers/import-sct-v2.module');
const { importSnomedV2FromCache } = require('../../tx/importers/import-sct-v2-cache.module');
const { diffV2 } = require('../../tx/importers/sqlite-v2/diff');

const SRC = path.resolve(__dirname, '../../tx/data/snomed');
let dir, report, cacheSummary;

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}

// The fixture is split by module (INT, TEST1000003, LO1010000); the RF2 v2 importer reads one
// concept / relationship file, so merge each kind into one Snapshot file first.
function mergeSnapshot(src, dst) {
  const groups = new Map();
  for (const f of walk(src)) {
    if (!f.endsWith('.txt')) continue;
    const rel = path.relative(src, f);
    const key = path.join(path.dirname(rel), path.basename(rel).replace(/_(INT|TEST1000003|LO1010000)_/, '_MERGED_'));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const [k, files] of groups) {
    const out = path.join(dst, k);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const lines = files.flatMap((f, i) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(i ? 1 : 0));
    fs.writeFileSync(out, lines.join('\n') + '\n');
  }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sct-from-cache-'));
  const snap = path.join(dir, 'Snapshot');
  mergeSnapshot(SRC, snap);
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new SnomedImporter({ source: snap, dest: path.join(dir, 't.cache'), edition: '31000003106', version: '20250909',
      uri: 'http://snomed.info/sct/31000003106/version/20250909', language: 'en-US', verbose: false, overwrite: true }).run();
  } finally { quiet.mockRestore(); }
  await importSnomedV2({ source: snap, dest: path.join(dir, 'rf2.db'), edition: '31000003106', version: '20250909', overwrite: true, log: () => {} });
  cacheSummary = await importSnomedV2FromCache({ source: path.join(dir, 't.cache'), dest: path.join(dir, 'rev.db'), overwrite: true, log: () => {} });
  report = diffV2(path.join(dir, 'rf2.db'), path.join(dir, 'rev.db'), { examples: 50 });
}, 120000);

afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('the current cache format carries everything else', () => {
  expect(cacheSummary.importer.cacheVersion).toBe('19');
  expect(cacheSummary.importer.cacheWarnings).toEqual([]);
});

test('concepts, links, literals, designations, acceptability and identifiers are identical', () => {
  for (const f of ['concept', 'link', 'literal', 'designation', 'acceptability', 'alternate_identifier', 'refset_def', 'property_def']) {
    expect([f, report.facts[f].onlyA, report.facts[f].onlyB]).toEqual([f, 0, 0]);
  }
});

test('numbering and every stored set are identical', () => {
  expect(report.sets.identicalNumbering).toBe(true);
  for (const [kind, s] of Object.entries(report.sets.byKind)) {
    expect([kind, s.differ, s.onlyA, s.onlyB]).toEqual([kind, 0, 0, 0]);
  }
});

test('refset members differ only where a field names a concept missing from the edition', () => {
  const r = report.facts.refset_member;
  expect(r.onlyA).toBe(r.onlyB);
  const a = new Map(r.examplesA.map((x) => [`${x.refset}|${x.concept}`, JSON.parse(x.fields)]));
  for (const x of r.examplesB) {
    const fa = a.get(`${x.refset}|${x.concept}`);
    expect(fa).toBeDefined();
    const fb = JSON.parse(x.fields);
    fb.forEach((v, i) => { if (v !== fa[i]) expect(v).toBe(''); });
  }
  expect(cacheSummary.importer.unknownFieldValues).toBe(r.onlyB);
});
