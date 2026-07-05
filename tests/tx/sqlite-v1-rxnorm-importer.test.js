'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const Database = require('better-sqlite3');
const {
  RxNormSqliteV1Importer,
  constants,
} = require('../../tx/importers/import-rxnorm-sqlite-v1.module');

// ---------------------------------------------------------------------------
// Synthetic mini-RRF fixtures. All rows are pipe-delimited with the real RRF
// column counts (RXNCONSO=19, RXNREL=17, RXNSTY=7, RXNSAB has a trailing '|').
//
// Concepts across 3 RXCUIs:
//   100  active   RXNORM atoms: IN "Ibuprofen", SCD "Ibuprofen 200 MG Oral Tablet"
//                 + a MMSL atom that must NOT become a concept/designation
//   200  active   RXNORM atoms: SCD "Aspirin 81 MG Oral Tablet", PSN "Aspirin Rx"
//                 (PSN outranks SCD, so display comes from the PSN atom)
//   300  SUPPRESSED (O) -> concept.active = 0
//
// RXNREL: two rows, both with RELA=has_ingredient:
//   - RXNORM row 200 -> 100 (loaded pair)  => one link, source=200 target=100
//   - MMSL   row 200 -> 100                 => skipped (SAB filter)
//
// RXNSTY: semantic types for 100 and 200.
// RXNSAB: one RXNORM row whose SVER '20AA_260504F' -> version 05042026.
// ---------------------------------------------------------------------------

// RXNCONSO field indexes used by the importer: RXCUI0, SAB11, TTY12, CODE13,
// STR14, SUPPRESS16. Build a full 19-column row.
function conso({ rxcui, sab, tty, code, str, suppress }) {
  const c = new Array(19).fill('');
  c[0] = rxcui;
  c[1] = 'ENG';
  c[7] = `A${rxcui}${tty}`;   // AUI, arbitrary-unique
  c[11] = sab;
  c[12] = tty;
  c[13] = code;
  c[14] = str;
  c[16] = suppress;
  return c.join('|');
}

// RXNREL field indexes: RXCUI1_0, RXCUI2_4, RELA7, SAB10, SUPPRESS14.
function rel({ rxcui1, rxcui2, rela, sab, suppress }) {
  const c = new Array(17).fill('');
  c[0] = rxcui1;
  c[2] = 'CUI';
  c[4] = rxcui2;
  c[6] = 'CUI';
  c[7] = rela;
  c[10] = sab;
  c[14] = suppress;
  return c.join('|');
}

// RXNSTY: RXCUI0, TUI1, STN2, STY3 (+ trailing empties, 7 cols).
function sty({ rxcui, tui, stn, str }) {
  const c = new Array(7).fill('');
  c[0] = rxcui;
  c[1] = tui;
  c[2] = stn;
  c[3] = str;
  return c.join('|');
}

function writeFixtures(dir) {
  const conso = [
    consoRow('100', 'RXNORM', 'IN', '100', 'Ibuprofen', 'N'),
    consoRow('100', 'RXNORM', 'SCD', '100', 'Ibuprofen 200 MG Oral Tablet', 'N'),
    consoRow('100', 'MMSL', 'SY', 'd001', 'Motrin flavor (non-RXNORM)', 'N'),
    consoRow('200', 'RXNORM', 'SCD', '200', 'Aspirin 81 MG Oral Tablet', 'N'),
    consoRow('200', 'RXNORM', 'PSN', '200', 'Aspirin (Rx prescribable name)', 'N'),
    consoRow('300', 'RXNORM', 'IN', '300', 'Obsolete substance', 'O'),
  ].join('\n') + '\n';

  const rxnrel = [
    rel({ rxcui1: '100', rxcui2: '200', rela: 'has_ingredient', sab: 'RXNORM', suppress: 'N' }),
    rel({ rxcui1: '100', rxcui2: '200', rela: 'has_ingredient', sab: 'MMSL', suppress: 'N' }),
  ].join('\n') + '\n';

  const rxnsty = [
    sty({ rxcui: '100', tui: 'T109', stn: 'A1.4.1', str: 'Organic Chemical' }),
    sty({ rxcui: '200', tui: 'T121', stn: 'A1.4.1', str: 'Pharmacologic Substance' }),
    // A semantic type for a CUI that was never loaded -> must be ignored.
    sty({ rxcui: '999', tui: 'T121', stn: 'A1.4.1', str: 'Orphan Substance' }),
  ].join('\n') + '\n';

  // RXNSAB row: RSAB (col3)=RXNORM, SVER (col6)=20AA_260504F -> 05042026.
  const sabCols = new Array(25).fill('');
  sabCols[3] = 'RXNORM';
  sabCols[4] = 'RxNorm Vocabulary';
  sabCols[5] = 'RXNORM';
  sabCols[6] = '20AA_260504F';
  const rxnsab = sabCols.join('|') + '|\n';

  fs.writeFileSync(path.join(dir, 'RXNCONSO.RRF'), conso);
  fs.writeFileSync(path.join(dir, 'RXNREL.RRF'), rxnrel);
  fs.writeFileSync(path.join(dir, 'RXNSTY.RRF'), rxnsty);
  fs.writeFileSync(path.join(dir, 'RXNSAB.RRF'), rxnsab);
}

// small local alias so the fixture list reads cleanly
function consoRow(rxcui, sab, tty, code, str, suppress) {
  return conso({ rxcui, sab, tty, code, str, suppress });
}

describe('rxnorm-sqlite-v1 importer', () => {
  let tmpDir;
  let srcDir;
  let dbPath;
  let db;
  let result;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rxnorm-v1-test-'));
    srcDir = path.join(tmpDir, 'rrf');
    fs.mkdirSync(srcDir, { recursive: true });
    dbPath = path.join(tmpDir, 'rxnorm-v1.db');

    writeFixtures(srcDir);

    const importer = new RxNormSqliteV1Importer({
      source: srcDir,
      dest: dbPath,
      overwrite: true,
      verbose: false,
    });
    result = await importer.run();

    db = new Database(dbPath, { readonly: true });
  });

  afterAll(() => {
    if (db && db.open) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('version is detected from RXNSAB SVER', () => {
    expect(result.version).toBe('05042026');
    const cs = db.prepare('SELECT * FROM code_system').get();
    expect(cs.version).toBe('05042026');
    expect(cs.release_date).toBe('2026-05-04');
    expect(cs.canonical_uri).toBe(`${constants.BASE_URI}|05042026`);
    expect(cs.base_uri).toBe(constants.BASE_URI);
    expect(cs.source_kind).toBe('rxnorm-sqlite-v1');
  });

  test('exactly 3 concepts (SAB filter drops the MMSL atom)', () => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM concept').get().n;
    expect(n).toBe(3);
    expect(result.stats.concepts).toBe(3);

    const codes = db.prepare('SELECT code FROM concept ORDER BY code').all().map((r) => r.code);
    expect(codes).toEqual(['100', '200', '300']);
  });

  test('suppressed CUI 300 becomes active=0; others active=1', () => {
    const rows = db.prepare('SELECT code, active FROM concept ORDER BY code').all();
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r.active]));
    expect(byCode['100']).toBe(1);
    expect(byCode['200']).toBe(1);
    expect(byCode['300']).toBe(0);
  });

  test('display is chosen by TTY priority (PSN outranks SCD for CUI 200)', () => {
    const c200 = db.prepare('SELECT display FROM concept WHERE code = ?').get('200');
    expect(c200.display).toBe('Aspirin (Rx prescribable name)');

    // CUI 100 has IN + SCD; SCD (priority index 1) outranks IN (index 5).
    const c100 = db.prepare('SELECT display FROM concept WHERE code = ?').get('100');
    expect(c100.display).toBe('Ibuprofen 200 MG Oral Tablet');
  });

  test('designations: only RXNORM atoms, exact count, use=TTY coding', () => {
    // 6 RXNORM atoms with STR (2 for 100, 2 for 200, 1 for 300). The MMSL atom
    // is excluded.
    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM designation d
         JOIN concept c ON c.concept_id = d.concept_id`
    ).get().n;
    expect(n).toBe(5);
    expect(result.stats.designations).toBe(5);

    // No designation carries a non-RXNORM term.
    const mmsl = db.prepare(
      `SELECT COUNT(*) AS n FROM designation WHERE term LIKE '%Motrin%'`
    ).get().n;
    expect(mmsl).toBe(0);

    // The PSN designation for 200 is preferred, uses the RxNorm use system and
    // TTY use code, and is en-US.
    const cid200 = db.prepare('SELECT concept_id FROM concept WHERE code = ?').get('200').concept_id;
    const psn = db.prepare(
      `SELECT use_system, use_code, language_code, preferred
         FROM designation WHERE concept_id = ? AND term LIKE 'Aspirin (Rx%'`
    ).get(cid200);
    expect(psn.use_system).toBe(constants.TTY_USE_SYSTEM);
    expect(psn.use_code).toBe('PSN');
    expect(psn.language_code).toBe('en-US');
    expect(psn.preferred).toBe(1);
  });

  test('TTY / SAB / STY literal properties are typed and populated', () => {
    const propRows = db.prepare('SELECT property_code, fhir_type, value_kind, is_hierarchy FROM property_def').all();
    const props = Object.fromEntries(propRows.map((r) => [r.property_code, r]));

    expect(props.TTY).toMatchObject({ fhir_type: 'code', value_kind: 'literal', is_hierarchy: 0 });
    expect(props.SAB).toMatchObject({ fhir_type: 'code', value_kind: 'literal', is_hierarchy: 0 });
    expect(props.STY).toMatchObject({ fhir_type: 'code', value_kind: 'literal', is_hierarchy: 0 });
    expect(props.SUPPRESS).toMatchObject({ fhir_type: 'code', value_kind: 'literal', is_hierarchy: 0 });

    // TTY literals: 100 has {IN, SCD}; 200 has {SCD, PSN}; 300 has {IN} = 5.
    const ttyId = db.prepare('SELECT property_id FROM property_def WHERE property_code = ?').get('TTY').property_id;
    const ttyCount = db.prepare('SELECT COUNT(*) AS n FROM concept_literal WHERE property_id = ?').get(ttyId).n;
    expect(ttyCount).toBe(5);

    // SAB literal: one 'RXNORM' per concept.
    const sabId = db.prepare('SELECT property_id FROM property_def WHERE property_code = ?').get('SAB').property_id;
    const sabRows = db.prepare('SELECT value_text FROM concept_literal WHERE property_id = ?').all(sabId);
    expect(sabRows.length).toBe(3);
    expect(new Set(sabRows.map((r) => r.value_text))).toEqual(new Set(['RXNORM']));

    // STY literals: only for loaded CUIs (100, 200); the orphan 999 is dropped.
    const styId = db.prepare('SELECT property_id FROM property_def WHERE property_code = ?').get('STY').property_id;
    const styRows = db.prepare(
      `SELECT c.code, l.value_text FROM concept_literal l
         JOIN concept c ON c.concept_id = l.source_concept_id
        WHERE l.property_id = ? ORDER BY c.code`
    ).all(styId);
    // Values are TUIs (what the legacy provider's STY filter matches), not names.
    expect(styRows).toEqual([
      { code: '100', value_text: 'T109' },
      { code: '200', value_text: 'T121' },
    ]);

    // SUPPRESS status literal: one per concept; suppressed CUI 300 carries its flag.
    const supId = db.prepare('SELECT property_id FROM property_def WHERE property_code = ?').get('SUPPRESS').property_id;
    const supRows = db.prepare(
      `SELECT c.code, l.value_text FROM concept_literal l
         JOIN concept c ON c.concept_id = l.source_concept_id
        WHERE l.property_id = ? ORDER BY c.code`
    ).all(supId);
    expect(supRows.length).toBe(3);
    const supByCode = Object.fromEntries(supRows.map((r) => [r.code, r.value_text]));
    expect(supByCode['100']).toBe('N');
    expect(supByCode['300']).not.toBe('N');

    // statusProperty points at SUPPRESS.
    const statusProp = db.prepare(
      `SELECT value FROM cs_config WHERE key = 'statusProperty'`
    ).get();
    expect(statusProp.value).toBe('SUPPRESS');
  });

  test('RELA link: exactly one has_ingredient edge, source=200 target=100', () => {
    // Only one RELA property defined (has_ingredient), concept-valued, non-hierarchy.
    const relaProp = db.prepare(
      `SELECT property_id, fhir_type, value_kind, is_hierarchy
         FROM property_def WHERE property_code = ?`
    ).get('has_ingredient');
    expect(relaProp).toMatchObject({ fhir_type: 'code', value_kind: 'concept', is_hierarchy: 0 });

    const links = db.prepare(
      `SELECT source_concept_id, target_concept_id, active
         FROM concept_link WHERE property_id = ?`
    ).all(relaProp.property_id);
    expect(links.length).toBe(1);
    expect(result.stats.relationships).toBe(1);

    const cid100 = db.prepare('SELECT concept_id FROM concept WHERE code = ?').get('100').concept_id;
    const cid200 = db.prepare('SELECT concept_id FROM concept WHERE code = ?').get('200').concept_id;

    // Direction convention (mirrors v0): source = concept(RXCUI2=200),
    // target = concept(RXCUI1=100).
    expect(links[0].source_concept_id).toBe(cid200);
    expect(links[0].target_concept_id).toBe(cid100);
    expect(links[0].active).toBe(1);

    // The MMSL RELA row was filtered out: no other concept_link rows exist.
    const total = db.prepare('SELECT COUNT(*) AS n FROM concept_link').get().n;
    expect(total).toBe(1);
  });

  test('no hierarchy properties and an empty closure (RxNorm v1 has no hierarchy)', () => {
    const hier = db.prepare('SELECT COUNT(*) AS n FROM property_def WHERE is_hierarchy = 1').get().n;
    expect(hier).toBe(0);
    const closure = db.prepare('SELECT COUNT(*) AS n FROM closure').get().n;
    expect(closure).toBe(0);
  });

  test('cs_config carries the flat sqlite-v1 keys', () => {
    const cfg = Object.fromEntries(
      db.prepare('SELECT key, value FROM cs_config').all().map((r) => [r.key, r.value])
    );
    expect(cfg.caseSensitive).toBe('1');
    expect(cfg.defaultLanguage).toBe('en-US');
    expect(cfg.versionAlgorithm).toBe('date');
    expect(cfg.statusProperty).toBe('SUPPRESS');
  });

  test('search FTS and audit are populated', () => {
    const disp = db.prepare(
      `SELECT rowid FROM search_fts_display WHERE term MATCH ?`
    ).all('Aspirin');
    expect(disp.length).toBeGreaterThan(0);

    const desig = db.prepare(
      `SELECT rowid FROM search_fts_designation WHERE term MATCH ?`
    ).all('Ibuprofen');
    expect(desig.length).toBeGreaterThan(0);

    const audit = db.prepare('SELECT * FROM load_audit ORDER BY run_id DESC LIMIT 1').get();
    expect(audit.status).toBe('success');
    expect(audit.terminology).toBe('rxnorm');
    expect(audit.completed_at).toBeTruthy();
    const stats = JSON.parse(audit.stats_json);
    expect(stats.concepts).toBe(3);
    expect(stats.relationships).toBe(1);
  });
});
