'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const {
  LoincV1Importer,
  languageFromVariantFilename,
  normalizeLoincStatus,
  isActiveLoincStatus,
  detectVersionFromPath,
  readCsv
} = require('../../tx/importers/import-loinc-sqlite-v1.module');

// ---------------------------------------------------------------------------
// Build a tiny synthetic LOINC source tree that mirrors the real directory
// layout the importer scans for (LoincTable/, AccessoryFiles/...). No real
// LOINC files are required.
//
//   Main codes (Loinc.csv), 6 rows:
//     1000-1  ACTIVE   Sodium [Moles/volume] in Serum   CLASS=CHEM CLASSTYPE=1
//     1001-9  ACTIVE   Potassium in Serum               CLASS=CHEM CLASSTYPE=1
//     2000-0  ACTIVE   Glucose in Blood                 CLASS=CHEM CLASSTYPE=1
//     3000-8  DEPRECATED (inactive)                     CLASS=CHEM
//     4000-5  TRIAL    (active)                          CLASS=DRUG
//     5000-1  ACTIVE   Color of Urine (has answer list) CLASS=UA
//
//   Parts (Part.csv), 2 rows: a COMPONENT part and a CLASS part (CHEM).
//   Answer list AL-1 with 2 answers (LA-1 white, LA-2 yellow), linked to 5000-1.
//   ComponentHierarchy: 2-level chain  ROOT-1 -> 1000-1 (and ROOT-1 -> 2000-0).
//   One linguistic variant language (esES).
// ---------------------------------------------------------------------------

function q(v) {
  // Minimal RFC-4180 field quoting for the fixture writer.
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(file, header, rows) {
  const lines = [header.map(q).join(',')];
  for (const row of rows) {
    lines.push(header.map((h) => q(row[h])).join(','));
  }
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
}

function buildSyntheticSource(root) {
  const loincTable = path.join(root, 'LoincTable');
  const partDir = path.join(root, 'AccessoryFiles', 'PartFile');
  const answerDir = path.join(root, 'AccessoryFiles', 'AnswerFile');
  const hierDir = path.join(root, 'AccessoryFiles', 'ComponentHierarchyBySystem');
  const lingDir = path.join(root, 'AccessoryFiles', 'LinguisticVariants');
  const consumerDir = path.join(root, 'AccessoryFiles', 'ConsumerName');
  for (const d of [loincTable, partDir, answerDir, hierDir, lingDir, consumerDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const loincHeader = [
    'LOINC_NUM', 'COMPONENT', 'PROPERTY', 'TIME_ASPCT', 'SYSTEM', 'SCALE_TYP',
    'METHOD_TYP', 'CLASS', 'STATUS', 'CLASSTYPE', 'UNITSREQUIRED',
    'CONSUMER_NAME', 'SHORTNAME', 'LONG_COMMON_NAME', 'DisplayName',
    'DefinitionDescription', 'RELATEDNAMES2'
  ];
  writeCsv(path.join(loincTable, 'Loinc.csv'), loincHeader, [
    {
      LOINC_NUM: '1000-1', COMPONENT: 'Sodium', PROPERTY: 'SCnc', SYSTEM: 'Ser',
      SCALE_TYP: 'Qn', CLASS: 'CHEM', STATUS: 'ACTIVE', CLASSTYPE: '1',
      UNITSREQUIRED: 'Y', SHORTNAME: 'Sodium SerPl',
      LONG_COMMON_NAME: 'Sodium [Moles/volume] in Serum or Plasma',
      DisplayName: 'Sodium', RELATEDNAMES2: 'Na; Natrium'
    },
    {
      LOINC_NUM: '1001-9', COMPONENT: 'Potassium', SYSTEM: 'Ser', CLASS: 'CHEM',
      STATUS: 'ACTIVE', CLASSTYPE: '1', LONG_COMMON_NAME: 'Potassium in Serum',
      SHORTNAME: 'K SerPl'
    },
    {
      LOINC_NUM: '2000-0', COMPONENT: 'Glucose', SYSTEM: 'Bld', CLASS: 'CHEM',
      STATUS: 'ACTIVE', CLASSTYPE: '1', LONG_COMMON_NAME: 'Glucose in Blood'
    },
    {
      LOINC_NUM: '3000-8', COMPONENT: 'Retired analyte', CLASS: 'CHEM',
      STATUS: 'DEPRECATED', CLASSTYPE: '1', LONG_COMMON_NAME: 'Retired analyte in Serum'
    },
    {
      LOINC_NUM: '4000-5', COMPONENT: 'Trial analyte', CLASS: 'DRUG',
      STATUS: 'TRIAL', CLASSTYPE: '1', LONG_COMMON_NAME: 'Trial analyte in Serum'
    },
    {
      LOINC_NUM: '5000-1', COMPONENT: 'Color', SYSTEM: 'Urine', CLASS: 'UA',
      STATUS: 'ACTIVE', CLASSTYPE: '1', LONG_COMMON_NAME: 'Color of Urine',
      CONSUMER_NAME: 'Urine color'
    },
    {
      LOINC_NUM: '6000-2', COMPONENT: 'Frowned upon', CLASS: 'CHEM',
      STATUS: 'DISCOURAGED', CLASSTYPE: '1', LONG_COMMON_NAME: 'Discouraged analyte in Serum'
    }
  ]);

  // Parts: one COMPONENT part (Sodium) and one CLASS part (CHEM).
  writeCsv(path.join(partDir, 'Part.csv'),
    ['PartNumber', 'PartTypeName', 'PartName', 'PartDisplayName', 'Status'],
    [
      { PartNumber: 'LP1', PartTypeName: 'COMPONENT', PartName: 'Sodium', PartDisplayName: 'Sodium (Na)', Status: 'ACTIVE' },
      { PartNumber: 'LP-CHEM', PartTypeName: 'CLASS', PartName: 'CHEM', PartDisplayName: 'Chemistry', Status: 'ACTIVE' }
    ]);

  // LoincPartLink_Primary: 1000-1 COMPONENT -> LP1.
  writeCsv(path.join(partDir, 'LoincPartLink_Primary.csv'),
    ['LoincNumber', 'LongCommonName', 'PartNumber', 'PartName', 'PartCodeSystem', 'PartTypeName', 'LinkTypeName', 'Property'],
    [
      {
        LoincNumber: '1000-1', LongCommonName: 'Sodium [Moles/volume] in Serum or Plasma',
        PartNumber: 'LP1', PartName: 'Sodium', PartCodeSystem: 'http://loinc.org',
        PartTypeName: 'COMPONENT', LinkTypeName: 'Primary', Property: 'http://loinc.org/property/COMPONENT'
      }
    ]);

  // Answer list AL-1 with two answers, linked to 5000-1.
  writeCsv(path.join(answerDir, 'AnswerList.csv'),
    ['AnswerListId', 'AnswerListName', 'AnswerStringId', 'SequenceNumber', 'DisplayText', 'Description', 'Score'],
    [
      { AnswerListId: 'AL-1', AnswerListName: 'Urine color', AnswerStringId: 'LA-1', SequenceNumber: '1', DisplayText: 'White' },
      { AnswerListId: 'AL-1', AnswerListName: 'Urine color', AnswerStringId: 'LA-2', SequenceNumber: '2', DisplayText: 'Yellow' }
    ]);
  writeCsv(path.join(answerDir, 'LoincAnswerListLink.csv'),
    ['LoincNumber', 'LongCommonName', 'AnswerListId', 'AnswerListName', 'AnswerListLinkType', 'ApplicableContext'],
    [
      { LoincNumber: '5000-1', LongCommonName: 'Color of Urine', AnswerListId: 'AL-1', AnswerListName: 'Urine color', AnswerListLinkType: 'NORMATIVE' }
    ]);

  // ComponentHierarchyBySystem: ROOT-1 is a 2-level parent of 1000-1 and 2000-0.
  writeCsv(path.join(hierDir, 'ComponentHierarchyBySystem.csv'),
    ['PATH_TO_ROOT', 'SEQUENCE', 'IMMEDIATE_PARENT', 'CODE', 'CODE_TEXT'],
    [
      { PATH_TO_ROOT: '', SEQUENCE: '1', IMMEDIATE_PARENT: '', CODE: 'ROOT-1', CODE_TEXT: 'Chemistry root' },
      { PATH_TO_ROOT: 'ROOT-1', SEQUENCE: '2', IMMEDIATE_PARENT: 'ROOT-1', CODE: '1000-1', CODE_TEXT: 'Sodium' },
      { PATH_TO_ROOT: 'ROOT-1', SEQUENCE: '3', IMMEDIATE_PARENT: 'ROOT-1', CODE: '2000-0', CODE_TEXT: 'Glucose' }
    ]);

  // ConsumerName accessory file.
  writeCsv(path.join(consumerDir, 'ConsumerName.csv'),
    ['LoincNumber', 'ConsumerName'],
    [{ LoincNumber: '1000-1', ConsumerName: 'Sodium blood test' }]);

  // One linguistic variant language: esES (Spanish, Spain).
  writeCsv(path.join(lingDir, 'esES12LinguisticVariant.csv'),
    ['LOINC_NUM', 'COMPONENT', 'SHORTNAME', 'LONG_COMMON_NAME', 'LinguisticVariantDisplayName'],
    [
      { LOINC_NUM: '1000-1', COMPONENT: 'Sodio', SHORTNAME: 'Sodio Suero', LONG_COMMON_NAME: 'Sodio [Moles/volumen] en Suero o Plasma', LinguisticVariantDisplayName: 'Sodio' }
    ]);
}

describe('loinc-sqlite-v1 importer', () => {
  let tmpDir;
  let sourceRoot;
  let dbPath;
  let db;
  let result;

  const codeId = {};
  const propId = {};

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loinc-v1-test-'));
    sourceRoot = path.join(tmpDir, 'Loinc_2.82');
    fs.mkdirSync(sourceRoot, { recursive: true });
    buildSyntheticSource(sourceRoot);

    dbPath = path.join(tmpDir, 'loinc-v1.db');
    const importer = new LoincV1Importer({
      source: sourceRoot,
      dest: dbPath,
      version: '2.82',
      releaseDate: '2025-02-01',
      overwrite: true,
      verbose: false
    });
    result = await importer.run();

    db = new Database(dbPath, { readonly: true });
    for (const r of db.prepare('SELECT concept_id, code FROM concept').all()) {
      codeId[r.code] = r.concept_id;
    }
    for (const r of db.prepare('SELECT property_id, property_code FROM property_def').all()) {
      propId[r.property_code] = r.property_id;
    }
  });

  afterAll(() => {
    if (db && db.open) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('code_system row records LOINC identity + version', () => {
    const cs = db.prepare('SELECT * FROM code_system').get();
    expect(cs.base_uri).toBe('http://loinc.org');
    expect(cs.version).toBe('2.82');
    expect(cs.canonical_uri).toBe('http://loinc.org|2.82');
    expect(cs.release_date).toBe('2025-02-01');
    expect(cs.name).toBe('LOINC');
    expect(cs.source_kind).toBe('loinc-sqlite-v1');
  });

  test('concept counts: main codes + parts + answer machinery + hierarchy root', () => {
    // 7 main + 2 parts + 1 answer list + 2 answers + ROOT-1 = 13.
    const total = db.prepare('SELECT COUNT(*) AS n FROM concept').get().n;
    expect(total).toBe(13);
    expect(result.stats.mainCodes).toBe(7);
    expect(result.stats.parts).toBe(2);
    expect(result.stats.answerLists).toBe(1);
    expect(result.stats.answers).toBe(2);
    // ROOT-1 is not a main code, part, or answer: it comes from the hierarchy
    // filler pass (importHierarchyNodes), which materializes CODE/PARENT nodes.
    expect(codeId['ROOT-1']).toBeDefined();
  });

  test('status normalization: only DISCOURAGED is inactive (reference parity)', () => {
    const active = (code) => db.prepare('SELECT active FROM concept WHERE code = ?').get(code).active;
    expect(active('1000-1')).toBe(1);   // ACTIVE
    expect(active('4000-5')).toBe(1);   // TRIAL counts active
    expect(active('3000-8')).toBe(1);   // DEPRECATED stays active (like tx.fhir.org)
    expect(active('6000-2')).toBe(0);   // DISCOURAGED inactive
  });

  test('STATUS preserved as a literal property (statusProperty)', () => {
    const statusProp = db.prepare(
      `SELECT value FROM cs_config WHERE key = 'statusProperty'`
    ).get().value;
    expect(statusProp).toBe('STATUS');

    const lit = db.prepare(
      `SELECT value_raw FROM concept_literal WHERE source_concept_id = ? AND property_id = ?`
    ).get(codeId['3000-8'], propId.STATUS);
    expect(lit.value_raw).toBe('DEPRECATED');
  });

  test('CLASSTYPE literal is a string (reference emits valueString "1")', () => {
    const row = db.prepare(
      `SELECT value_raw, value_text, value_num FROM concept_literal
        WHERE source_concept_id = ? AND property_id = ?`
    ).get(codeId['1000-1'], propId.CLASSTYPE);
    expect(row.value_raw).toBe('1');
    expect(row.value_text).toBe('1');
    expect(row.value_num).toBeNull();

    const def = db.prepare(`SELECT fhir_type FROM property_def WHERE property_code = 'CLASSTYPE'`).get();
    expect(def.fhir_type).toBe('string');

    // Value meanings surface via cs_config for the $lookup description part.
    const meanings = JSON.parse(db.prepare(
      `SELECT value FROM cs_config WHERE key = 'propertyValueDescriptions'`
    ).get().value);
    expect(meanings.CLASSTYPE['1']).toBe('Laboratory class');
  });

  test('UNITSREQUIRED literal is a string (reference emits valueString "Y")', () => {
    const row = db.prepare(
      `SELECT value_raw, value_text, value_bool FROM concept_literal
        WHERE source_concept_id = ? AND property_id = ?`
    ).get(codeId['1000-1'], propId.UNITSREQUIRED);
    expect(row.value_raw).toBe('Y');
    expect(row.value_text).toBe('Y');
    expect(row.value_bool).toBeNull();
  });

  test('designations: preferred LONG_COMMON_NAME with use_system, and a linguistic variant', () => {
    const rows = db.prepare(
      `SELECT language_code, use_system, use_code, term, preferred
         FROM designation WHERE concept_id = ? ORDER BY use_code`
    ).all(codeId['1000-1']);

    const lcn = rows.find((r) => r.use_code === 'LONG_COMMON_NAME');
    expect(lcn.preferred).toBe(1);
    expect(lcn.language_code).toBe('en-US');
    expect(lcn.use_system).toBe('http://loinc.org');
    expect(lcn.term).toBe('Sodium [Moles/volume] in Serum or Plasma');

    // Spanish linguistic variant present with language es-ES.
    const es = db.prepare(
      `SELECT term FROM designation WHERE concept_id = ? AND language_code = 'es-ES' AND use_code = 'LONG_COMMON_NAME'`
    ).get(codeId['1000-1']);
    expect(es.term).toBe('Sodio [Moles/volumen] en Suero o Plasma');
  });

  test('hierarchy links are child->parent and property is is_hierarchy', () => {
    const parentProp = db.prepare(
      `SELECT property_id, is_hierarchy FROM property_def WHERE property_code = 'parent'`
    ).get();
    expect(parentProp.is_hierarchy).toBe(1);

    // 1000-1 (child) -> ROOT-1 (parent)
    const link = db.prepare(
      `SELECT 1 AS ok FROM concept_link
        WHERE source_concept_id = ? AND target_concept_id = ? AND property_id = ?`
    ).get(codeId['1000-1'], codeId['ROOT-1'], parentProp.property_id);
    expect(link).toBeTruthy();
  });

  test('part link (COMPONENT) points 1000-1 -> LP1', () => {
    const link = db.prepare(
      `SELECT 1 AS ok FROM concept_link
        WHERE source_concept_id = ? AND target_concept_id = ? AND property_id = ?`
    ).get(codeId['1000-1'], codeId.LP1, propId.COMPONENT);
    expect(link).toBeTruthy();
  });

  test('CLASS link resolves CHEM name to the CLASS part LP-CHEM', () => {
    const link = db.prepare(
      `SELECT 1 AS ok FROM concept_link
        WHERE source_concept_id = ? AND target_concept_id = ? AND property_id = ?`
    ).get(codeId['1000-1'], codeId['LP-CHEM'], propId.CLASS);
    expect(link).toBeTruthy();
  });

  test('answer list becomes a value_set with its answers as members', () => {
    const vs = db.prepare(`SELECT vs_id, url, name FROM value_set WHERE url = ?`)
      .get('http://loinc.org/vs/AL-1');
    expect(vs).toBeTruthy();
    expect(vs.name).toBe('Urine color');

    const members = db.prepare(
      `SELECT c.code FROM value_set_member m JOIN concept c ON c.concept_id = m.concept_id
        WHERE m.vs_id = ? ORDER BY c.code`
    ).all(vs.vs_id).map((r) => r.code);
    expect(members).toEqual(['LA-1', 'LA-2']);

    // Exactly one value set.
    expect(db.prepare('SELECT COUNT(*) AS n FROM value_set').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM value_set_member').get().n).toBe(2);
  });

  test('answer machinery links: Answer / answers-for / AnswerList orientations', () => {
    // AL-1 -Answer-> LA-1
    const ans = db.prepare(
      `SELECT 1 AS ok FROM concept_link WHERE source_concept_id = ? AND target_concept_id = ? AND property_id = ?`
    ).get(codeId['AL-1'], codeId['LA-1'], propId.Answer);
    expect(ans).toBeTruthy();

    // AL-1 -answers-for-> 5000-1
    const af = db.prepare(
      `SELECT 1 AS ok FROM concept_link WHERE source_concept_id = ? AND target_concept_id = ? AND property_id = ?`
    ).get(codeId['AL-1'], codeId['5000-1'], propId['answers-for']);
    expect(af).toBeTruthy();

    // Reciprocal AnswerList links: LA-1 -AnswerList-> AL-1 (answer to list)
    // and 5000-1 -AnswerList-> AL-1 (loinc code to list).
    const alAnswer = db.prepare(
      `SELECT 1 AS ok FROM concept_link WHERE source_concept_id = ? AND target_concept_id = ? AND property_id = ?`
    ).get(codeId['LA-1'], codeId['AL-1'], propId.AnswerList);
    expect(alAnswer).toBeTruthy();
    const alCode = db.prepare(
      `SELECT 1 AS ok FROM concept_link WHERE source_concept_id = ? AND target_concept_id = ? AND property_id = ?`
    ).get(codeId['5000-1'], codeId['AL-1'], propId.AnswerList);
    expect(alCode).toBeTruthy();
  });

  test('hierarchy child links are reciprocal to parent links', () => {
    const childProp = db.prepare(
      `SELECT property_id, is_hierarchy FROM property_def WHERE property_code = 'child'`
    ).get();
    expect(childProp.is_hierarchy).toBe(0);
    const link = db.prepare(
      `SELECT 1 AS ok FROM concept_link
        WHERE source_concept_id = ? AND target_concept_id = ? AND property_id = ?`
    ).get(codeId['ROOT-1'], codeId['1000-1'], childProp.property_id);
    expect(link).toBeTruthy();
  });

  test('closure: ROOT-1 is an ancestor of 1000-1 and 2000-0, with no self-rows', () => {
    const pair = db.prepare(
      `SELECT 1 AS ok FROM closure WHERE ancestor_id = ? AND descendant_id = ?`
    ).get(codeId['ROOT-1'], codeId['1000-1']);
    expect(pair).toBeTruthy();

    const pair2 = db.prepare(
      `SELECT 1 AS ok FROM closure WHERE ancestor_id = ? AND descendant_id = ?`
    ).get(codeId['ROOT-1'], codeId['2000-0']);
    expect(pair2).toBeTruthy();

    const self = db.prepare(`SELECT COUNT(*) AS n FROM closure WHERE ancestor_id = descendant_id`).get().n;
    expect(self).toBe(0);

    // ROOT-1 has exactly two descendants.
    const descendants = db.prepare(`SELECT COUNT(*) AS n FROM closure WHERE ancestor_id = ?`)
      .get(codeId['ROOT-1']).n;
    expect(descendants).toBe(2);
    expect(result.stats.closureRows).toBe(2);
  });

  test('cs_config registry keys are written', () => {
    const cfg = {};
    for (const r of db.prepare('SELECT key, value FROM cs_config').all()) cfg[r.key] = r.value;

    expect(cfg.caseSensitive).toBe('1');
    expect(cfg.defaultLanguage).toBe('en-US');
    expect(cfg.versionAlgorithm).toBe('natural');
    expect(cfg.hierarchyMeaning).toBe('is-a');
    expect(cfg.statusProperty).toBe('STATUS');

    const ivs = JSON.parse(cfg.implicitValueSets);
    expect(ivs).toEqual(expect.arrayContaining([
      { pattern: 'http://loinc.org/vs', kind: 'all' },
      { pattern: 'http://loinc.org/vs/{code}', kind: 'vs-table', nameTemplate: 'LOINCAnswerList{code}' }
    ]));

    // Reference-parity behavior knobs.
    expect(cfg.name).toBe('LOINC');
    expect(cfg.isAIncludesSelf).toBe('0');
    expect(cfg.locateMissMessage).toBe('');
    expect(cfg.filterLocateMiss).toBe('silent');
    expect(JSON.parse(cfg.membershipFilters)).toEqual({
      LIST: { member: 'Answer' }, 'answers-for': { member: 'Answer' }
    });
    expect(JSON.parse(cfg.existsFilters).copyright.property).toBe('Copyright');
    expect(JSON.parse(cfg.designationsAsProperties)).toEqual(['RELATEDNAMES2']);
  });

  test('search index (FTS) finds a display substring', () => {
    const hits = db.prepare(`SELECT rowid FROM search_fts_display WHERE term MATCH ?`).all('Glucose');
    expect(hits.length).toBeGreaterThan(0);
  });

  test('load_audit records success with stats', () => {
    const row = db.prepare(`SELECT * FROM load_audit ORDER BY run_id DESC LIMIT 1`).get();
    expect(row.status).toBe('success');
    expect(row.terminology).toBe('loinc');
    expect(row.completed_at).toBeTruthy();
    const stats = JSON.parse(row.stats_json);
    expect(stats.concepts).toBe(13);
  });

  test('maxRows caps the number of main concepts loaded', async () => {
    const capPath = path.join(tmpDir, 'loinc-cap.db');
    const importer = new LoincV1Importer({
      source: sourceRoot, dest: capPath, version: '2.82',
      maxRows: 2, overwrite: true, verbose: false
    });
    const capped = await importer.run();
    expect(capped.stats.mainCodes).toBe(2);

    const capDb = new Database(capPath, { readonly: true });
    // 3000-8 is beyond the 2-row cap and must be absent.
    const missing = capDb.prepare(`SELECT 1 AS ok FROM concept WHERE code = '3000-8'`).get();
    expect(missing).toBeUndefined();
    capDb.close();
    fs.rmSync(capPath, { force: true });
  });

  test('helpers: filename language + status classification + version detection', () => {
    expect(languageFromVariantFilename('esES12LinguisticVariant.csv')).toBe('es-ES');
    expect(languageFromVariantFilename('arJO32LinguisticVariant.csv')).toBe('ar-JO');
    expect(normalizeLoincStatus('active', 'ACTIVE')).toBe('ACTIVE');
    expect(normalizeLoincStatus('deprecated', 'ACTIVE')).toBe('DEPRECATED');
    expect(isActiveLoincStatus('ACTIVE')).toBe(true);
    expect(isActiveLoincStatus('DEPRECATED')).toBe(true);   // deprecated stays active
    expect(isActiveLoincStatus('DISCOURAGED')).toBe(false); // only DISCOURAGED is inactive
    expect(detectVersionFromPath('/data/Loinc_2.82')).toBe('2.82');
  });

  test('readCsv parses quoted fields with embedded commas and newlines', async () => {
    const p = path.join(tmpDir, 'embedded.csv');
    fs.writeFileSync(p,
      'A,B,C\r\n' +
      '"has, comma","has ""quote""","line1\nline2"\r\n' +
      'plain,plain2,plain3\r\n', 'utf8');
    const rows = [];
    for await (const row of readCsv(p)) rows.push(row);
    expect(rows.length).toBe(2);
    expect(rows[0].A).toBe('has, comma');
    expect(rows[0].B).toBe('has "quote"');
    expect(rows[0].C).toBe('line1\nline2');
    expect(rows[1].A).toBe('plain');
    fs.rmSync(p, { force: true });
  });
});
