'use strict';

// Reverse loader (FHIRsmith classic LOINC db -> sqlite-v2, import-loinc-v2-classic.module.js): build
// a classic db from the LOINC test fixture in tx/data/loinc with main's importer, reverse-load it,
// and compare with the CSV v2 import of the same release. Every concept, link, literal, designation
// and stored set must agree; what a classic file cannot carry is the answers' SequenceNumber (the
// list order stands in for it, so the order of each list agrees). Then the shape of older classic
// files (loinc-2.77-a.db): a blank Answer code '' shared by the externally defined lists, and
// CLASSTYPE stored as its description.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { importLoincV2 } = require('../../tx/importers/import-loinc-v2.module');
const { importLoincV2FromClassic } = require('../../tx/importers/import-loinc-v2-classic.module');
const { LoincDataMigrator } = require('../../tx/importers/import-loinc.module');
const { diffV2 } = require('../../tx/importers/sqlite-v2/diff');

const SRC = path.resolve(__dirname, '../../tx/data/loinc');
const VERSION = '2.80-test';
let dir, report, summary;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'loinc-from-classic-'));
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new LoincDataMigrator().migrate(SRC, path.join(dir, 'classic.db'), VERSION, { verbose: false, mainOnly: false });
  } finally { quiet.mockRestore(); }
  await importLoincV2({ source: SRC, dest: path.join(dir, 'csv.db'), version: VERSION, overwrite: true, log: () => {} });
  summary = await importLoincV2FromClassic({ source: path.join(dir, 'classic.db'), dest: path.join(dir, 'rev.db'), overwrite: true, log: () => {} });
  report = diffV2(path.join(dir, 'csv.db'), path.join(dir, 'rev.db'), { examples: 20 });
}, 120000);

afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('the same concepts, numbered the same, with the version from the classic Config', () => {
  expect(summary.concepts).toBe(report.codeSystem_a.concept_count);
  expect(summary.concepts).toBe(483); // 322 terms + 147 parts + 3 answer lists + 8 answers + 3 hierarchy-only nodes
  expect(report.codeSystem_b).toEqual(report.codeSystem_a);
  expect(report.codeSystem_b.version).toBe(VERSION);
  expect(report.facts.concept.onlyA + report.facts.concept.onlyB).toBe(0);
  expect(report.sets.identicalNumbering).toBe(true);
});

test.each(['link', 'literal', 'designation', 'refset_def', 'property_def'])('%s: every row agrees', (name) => {
  const f = report.facts[name];
  expect([f.onlyA, f.onlyB, f.countA]).toEqual([0, 0, f.countB]);
});

test('external maps agree (main stores them in ExternalCodes / ExternalMappings)', () => {
  const f = report.facts.external_map || { onlyA: 0, onlyB: 0 };
  expect([report.tables.external_map.a, report.tables.external_map.b]).toEqual([report.tables.external_map.b, report.tables.external_map.a]);
  expect([f.onlyA, f.onlyB]).toEqual([0, 0]);
});

test('every stored set agrees: descendants (path closure), properties, refsets', () => {
  for (const [kind, s] of Object.entries(report.sets.byKind)) {
    expect({ kind, differ: s.differ, onlyA: s.onlyA, onlyB: s.onlyB }).toEqual({ kind, differ: 0, onlyA: 0, onlyB: 0 });
  }
});

test('answer lists keep their order (the classic file has no SequenceNumber)', () => {
  const order = (file) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.prepare(`SELECT r.code list, group_concat(c.code) members FROM (SELECT * FROM refset_member ORDER BY refset_id, json_extract(fields, '$[0]'), concept_id) m
        JOIN concept r ON r.concept_id = m.refset_id JOIN concept c ON c.concept_id = m.concept_id GROUP BY r.code ORDER BY r.code`).all();
    } finally { db.close(); }
  };
  const a = order(path.join(dir, 'csv.db'));
  expect(a.length).toBeGreaterThan(0);
  expect(order(path.join(dir, 'rev.db'))).toEqual(a);
});

test('an older classic file: the blank Answer code is dropped with its links, CLASSTYPE comes back as its code', async () => {
  const old = path.join(dir, 'old.db');
  fs.copyFileSync(path.join(dir, 'classic.db'), old);
  const db = new Database(old);
  const k = db.prepare('SELECT max(CodeKey) + 1 FROM Codes').pluck().get();
  db.prepare("INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, '', 4, NULL, 0, '')").run(k);
  const list = db.prepare("SELECT CodeKey FROM Codes WHERE Type = 3 ORDER BY CodeKey LIMIT 1").pluck().get();
  const rk = db.prepare('SELECT max(RelationshipKey) + 1 FROM Relationships').pluck().get();
  const rel = (t) => db.prepare('SELECT RelationshipTypeKey FROM RelationshipTypes WHERE Description = ?').pluck().get(t);
  db.prepare('INSERT INTO Relationships VALUES (?, ?, ?, ?, 0)').run(rk, rel('Answer'), list, k);
  db.prepare('INSERT INTO Relationships VALUES (?, ?, ?, ?, 0)').run(rk + 1, rel('AnswerList'), k, list);
  // CLASSTYPE as the older importer stored it
  const ct = db.prepare("SELECT PropertyTypeKey FROM PropertyTypes WHERE Description = 'CLASSTYPE'").pluck().get();
  const names = { 1: 'Laboratory class', 2: 'Clinical class', 3: 'Claims attachment', 4: 'Surveys' };
  for (const [code, name] of Object.entries(names)) {
    db.prepare(`UPDATE PropertyValues SET Value = ? WHERE Value = ? AND PropertyValueKey IN (SELECT PropertyValueKey FROM Properties WHERE PropertyTypeKey = ?)`).run(name, code, ct);
  }
  db.close();
  const s = await importLoincV2FromClassic({ source: old, dest: path.join(dir, 'old-rev.db'), overwrite: true, log: () => {} });
  expect([s.concepts, s.importer.blankCodesDropped, s.importer.linksToDropped]).toEqual([483, 1, 1]);
  const r = diffV2(path.join(dir, 'csv.db'), path.join(dir, 'old-rev.db'));
  for (const name of ['concept', 'link', 'literal', 'designation']) expect([name, r.facts[name].onlyA, r.facts[name].onlyB]).toEqual([name, 0, 0]);
  for (const s2 of Object.values(r.sets.byKind)) expect([s2.differ, s2.onlyA, s2.onlyB]).toEqual([0, 0, 0]);
});

test('a version that does not match the classic Config is refused', async () => {
  await expect(importLoincV2FromClassic({ source: path.join(dir, 'classic.db'), dest: path.join(dir, 'x.db'), version: '9.99', overwrite: true, log: () => {} }))
    .rejects.toThrow(/classic db says 2.80-test/);
});
