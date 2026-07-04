'use strict';

// End-to-end test of the SNOMED CT sqlite-v1 importer against a synthetic
// mini-RF2 Snapshot tree written to a temp directory. No real data required.
//
// The fixture exercises: an is-a diamond, FSN + synonym descriptions, a language
// refset that makes one synonym preferred (so display selection is observable),
// one attribute relationship carrying a relationship group, one concrete value,
// one simple refset with two members, and one inactive concept.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { SnomedSqliteV1Importer } = require('../../tx/importers/import-sct-sqlite-v1.module.js');

// ---- constant ids used by the importer -------------------------------------
const IS_A = '116680003';
const FSN = '900000000000003001';
const SYN = '900000000000013009';
const EN_US_REFSET = '900000000000509007';
const PREFERRED = '900000000000548007';
const ACCEPTABLE = '900000000000549004';
const FINDING_SITE = '363698007'; // an attribute typeId
const NUMERIC_ATTR = '1142139005'; // a concrete-value typeId

const MODULE = '731000124108';
const CORE_MODULE = '900000000000207008';
const DEF_STATUS_PRIMITIVE = '900000000000074008';

const EFF = '20260301';
const VERSION = '20260301';

// ---- fixture concepts ------------------------------------------------------
// Diamond:  ROOT <- A, ROOT <- B, A <- C, B <- C  (C has two parents)
//           plus leaf X under C; inactive concept INACT; attribute target SITE.
const ROOT = '138875005';
const A = '100000001';
const B = '100000002';
const C = '100000003'; // diamond bottom, two parents
const X = '100000004'; // leaf under C
const SITE = '100000005'; // finding-site target
const INACT = '100000006'; // inactive concept
const NUMHOLDER = '100000007'; // carries a concrete value

// concept rows: [id, active, moduleId]
const CONCEPTS = [
  [ROOT, '1', CORE_MODULE],
  [A, '1', MODULE],
  [B, '1', MODULE],
  [C, '1', MODULE],
  [X, '1', MODULE],
  [SITE, '1', MODULE],
  [INACT, '0', MODULE],
  [NUMHOLDER, '1', MODULE],
];

// description rows: [descId, active, conceptId, typeId, term]
// C gets an FSN and a synonym; the synonym is marked preferred in the lang refset
// so it should win the display over the FSN.
const C_FSN_ID = 'd-c-fsn';
const C_SYN_ID = 'd-c-syn';
const DESCRIPTIONS = [
  ['d-root-fsn', '1', ROOT, FSN, 'SNOMED CT Concept (SNOMED RT+CTV3)'],
  ['d-a-fsn', '1', A, FSN, 'Concept A (finding)'],
  ['d-a-syn', '1', A, SYN, 'Concept A'],
  ['d-b-fsn', '1', B, FSN, 'Concept B (finding)'],
  [C_FSN_ID, '1', C, FSN, 'Concept C (finding)'],
  [C_SYN_ID, '1', C, SYN, 'Preferred C synonym'],
  ['d-x-fsn', '1', X, FSN, 'Concept X (finding)'],
  ['d-site-fsn', '1', SITE, FSN, 'Body site (body structure)'],
  ['d-inact-fsn', '1', INACT, FSN, 'Retired concept (finding)'],
  ['d-num-fsn', '1', NUMHOLDER, FSN, 'Numeric holder (finding)'],
];

// language refset rows: [active, refsetId, referencedComponentId(descId), acceptabilityId]
// Mark the C synonym PREFERRED; mark the C FSN acceptable (FSN is preferred anyway).
const LANGUAGE = [
  ['1', EN_US_REFSET, C_SYN_ID, PREFERRED],
  ['1', EN_US_REFSET, C_FSN_ID, ACCEPTABLE],
];

// relationship rows: [active, sourceId, destId, group, typeId]
// is-a diamond + one attribute (finding-site) on C with group 1.
const RELATIONSHIPS = [
  ['1', A, ROOT, '0', IS_A],
  ['1', B, ROOT, '0', IS_A],
  ['1', C, A, '0', IS_A],
  ['1', C, B, '0', IS_A],
  ['1', X, C, '0', IS_A],
  ['1', SITE, ROOT, '0', IS_A],
  ['1', INACT, ROOT, '0', IS_A],
  ['1', NUMHOLDER, ROOT, '0', IS_A],
  ['1', C, SITE, '1', FINDING_SITE], // attribute with relationship group 1
];

// concrete value rows: [active, sourceId, value, group, typeId]
const CONCRETE = [
  ['1', NUMHOLDER, '#42', '1', NUMERIC_ATTR],
];

// simple refset rows: [active, refsetId, referencedComponentId]
const SIMPLE_REFSET_ID = '723264001';
const SIMPLE = [
  ['1', SIMPLE_REFSET_ID, A],
  ['1', SIMPLE_REFSET_ID, C],
];

// ---- fixture writer --------------------------------------------------------

function tsv(header, rows) {
  return [header, ...rows.map((r) => r.join('\t'))].join('\n') + '\n';
}

function buildFixture(root) {
  const term = path.join(root, 'Snapshot', 'Terminology');
  const lang = path.join(root, 'Snapshot', 'Refset', 'Language');
  const content = path.join(root, 'Snapshot', 'Refset', 'Content');
  fs.mkdirSync(term, { recursive: true });
  fs.mkdirSync(lang, { recursive: true });
  fs.mkdirSync(content, { recursive: true });

  fs.writeFileSync(
    path.join(term, 'sct2_Concept_Snapshot_TEST_20260301.txt'),
    tsv('id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId',
      CONCEPTS.map(([id, active, mod]) => [id, EFF, active, mod, DEF_STATUS_PRIMITIVE]))
  );

  fs.writeFileSync(
    path.join(term, 'sct2_Description_Snapshot-en_TEST_20260301.txt'),
    tsv('id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId',
      DESCRIPTIONS.map(([did, active, cid, typeId, t]) =>
        [did, EFF, active, MODULE, cid, 'en', typeId, t, '900000000000448009']))
  );

  fs.writeFileSync(
    path.join(lang, 'der2_cRefset_LanguageSnapshot-en_TEST_20260301.txt'),
    tsv('id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tacceptabilityId',
      LANGUAGE.map(([active, refset, comp, acc], i) =>
        [`l-${i}`, EFF, active, MODULE, refset, comp, acc]))
  );

  fs.writeFileSync(
    path.join(term, 'sct2_Relationship_Snapshot_TEST_20260301.txt'),
    tsv('id\teffectiveTime\tactive\tmoduleId\tsourceId\tdestinationId\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId',
      RELATIONSHIPS.map(([active, src, dst, grp, typeId], i) =>
        [`r-${i}`, EFF, active, MODULE, src, dst, grp, typeId, '900000000000011006', '900000000000451002']))
  );

  fs.writeFileSync(
    path.join(term, 'sct2_RelationshipConcreteValues_Snapshot_TEST_20260301.txt'),
    tsv('id\teffectiveTime\tactive\tmoduleId\tsourceId\tvalue\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId',
      CONCRETE.map(([active, src, val, grp, typeId], i) =>
        [`cv-${i}`, EFF, active, MODULE, src, val, grp, typeId, '900000000000011006', '900000000000451002']))
  );

  fs.writeFileSync(
    path.join(content, 'der2_Refset_SimpleSnapshot_TEST_20260301.txt'),
    tsv('id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId',
      SIMPLE.map(([active, refset, comp], i) => [`s-${i}`, EFF, active, MODULE, refset, comp]))
  );

  return root;
}

// ---- test ------------------------------------------------------------------

describe('SNOMED CT sqlite-v1 importer', () => {
  let tmp;
  let dbPath;
  let db;
  let stats;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sct-v1-test-'));
    buildFixture(tmp);
    dbPath = path.join(tmp, 'out.db');

    const importer = new SnomedSqliteV1Importer({
      source: tmp,
      dest: dbPath,
      edition: MODULE,
      version: VERSION,
      overwrite: true,
      verbose: false,
    });
    const result = await importer.run();
    stats = result.stats;
    db = new Database(dbPath, { readonly: true });
  });

  afterAll(() => {
    if (db) db.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function conceptId(code) {
    return db.prepare('SELECT concept_id FROM concept WHERE code = ?').get(code).concept_id;
  }

  test('imports all concepts, active + inactive', () => {
    const rows = db.prepare('SELECT code, active, display FROM concept').all();
    expect(rows.length).toBe(CONCEPTS.length);
    expect(stats.concepts).toBe(CONCEPTS.length);
    const inact = db.prepare('SELECT active FROM concept WHERE code = ?').get(INACT);
    expect(inact.active).toBe(0);
    const active = db.prepare('SELECT active FROM concept WHERE code = ?').get(A);
    expect(active.active).toBe(1);
  });

  test('code system + version URI', () => {
    const cs = db.prepare('SELECT * FROM code_system').get();
    expect(cs.base_uri).toBe('http://snomed.info/sct');
    expect(cs.edition_code).toBe(MODULE);
    // FHIR version for SNOMED is the full versioned edition URI (matches the
    // binary provider's versionUri), not the bare date.
    expect(cs.version).toBe(`http://snomed.info/sct/${MODULE}/version/${VERSION}`);
    expect(cs.canonical_uri).toBe(`http://snomed.info/sct/${MODULE}/version/${VERSION}`);
    expect(cs.release_date).toBe('2026-03-01');
  });

  test('preferred synonym is chosen for display over FSN', () => {
    const c = db.prepare('SELECT display FROM concept WHERE code = ?').get(C);
    expect(c.display).toBe('Preferred C synonym');
    // A has no preferred synonym marker -> falls back to FSN.
    const a = db.prepare('SELECT display FROM concept WHERE code = ?').get(A);
    expect(a.display).toBe('Concept A (finding)');
  });

  test('designations carry use_system and typeId as use_code, preferred flag', () => {
    const cId = conceptId(C);
    const desigs = db.prepare(
      'SELECT term, use_system, use_code, preferred FROM designation WHERE concept_id = ? ORDER BY term'
    ).all(cId);
    expect(desigs.length).toBe(2);
    for (const d of desigs) {
      expect(d.use_system).toBe('http://snomed.info/sct');
    }
    const fsn = desigs.find((d) => d.use_code === FSN);
    const syn = desigs.find((d) => d.use_code === SYN);
    expect(fsn.preferred).toBe(1); // FSN always preferred
    expect(syn.preferred).toBe(1); // marked preferred in language refset
    expect(syn.term).toBe('Preferred C synonym');
  });

  test('is-a links use child->parent direction with hierarchy property', () => {
    const hierProp = db.prepare(
      'SELECT property_id FROM property_def WHERE property_code = ? AND is_hierarchy = 1'
    ).get(IS_A);
    expect(hierProp).toBeTruthy();
    const cId = conceptId(C);
    const parents = db.prepare(
      'SELECT target_concept_id FROM concept_link WHERE source_concept_id = ? AND property_id = ?'
    ).all(cId, hierProp.property_id).map((r) => r.target_concept_id);
    expect(parents.sort()).toEqual([conceptId(A), conceptId(B)].sort());
  });

  test('closure pairs exactly (no self-rows, transitive diamond)', () => {
    const pairs = db.prepare('SELECT ancestor_id, descendant_id FROM closure').all()
      .map((r) => `${r.ancestor_id}>${r.descendant_id}`)
      .sort();

    // Expected ancestor->descendant pairs over the inferred is-a graph.
    // Edges: A<ROOT, B<ROOT, C<A, C<B, X<C, SITE<ROOT, INACT<ROOT, NUM<ROOT.
    const id = {};
    for (const code of [ROOT, A, B, C, X, SITE, INACT, NUMHOLDER]) id[code] = conceptId(code);
    const expected = [
      // direct
      [id[ROOT], id[A]], [id[ROOT], id[B]],
      [id[A], id[C]], [id[B], id[C]],
      [id[C], id[X]],
      [id[ROOT], id[SITE]], [id[ROOT], id[INACT]], [id[ROOT], id[NUMHOLDER]],
      // transitive: ROOT ancestor of C (via A and B) and X
      [id[ROOT], id[C]], [id[ROOT], id[X]],
      // A and B ancestors of X (via C)
      [id[A], id[X]], [id[B], id[X]],
    ].map(([a, d]) => `${a}>${d}`).sort();

    expect(pairs).toEqual(expected);
    // no self-rows
    expect(pairs.some((p) => { const [a, d] = p.split('>'); return a === d; })).toBe(false);
  });

  test('attribute relationship becomes a concept-valued property with group', () => {
    const prop = db.prepare('SELECT property_id, value_kind, is_hierarchy FROM property_def WHERE property_code = ?')
      .get(FINDING_SITE);
    expect(prop.value_kind).toBe('concept');
    expect(prop.is_hierarchy).toBe(0);
    const link = db.prepare(
      'SELECT source_concept_id, target_concept_id, group_id FROM concept_link WHERE property_id = ?'
    ).get(prop.property_id);
    expect(link.source_concept_id).toBe(conceptId(C));
    expect(link.target_concept_id).toBe(conceptId(SITE));
    expect(link.group_id).toBe(1);
  });

  test('concrete value stored as a literal with numeric projection', () => {
    const prop = db.prepare('SELECT property_id, value_kind, fhir_type FROM property_def WHERE property_code = ?')
      .get(`concrete:${NUMERIC_ATTR}`);
    expect(prop.value_kind).toBe('literal');
    const lit = db.prepare(
      'SELECT value_raw, value_num, group_id FROM concept_literal WHERE property_id = ? AND source_concept_id = ?'
    ).get(prop.property_id, conceptId(NUMHOLDER));
    expect(lit.value_raw).toBe('42');
    expect(lit.value_num).toBe(42);
    expect(lit.group_id).toBe(1);
  });

  test('simple refset becomes a value set with its members', () => {
    const vs = db.prepare('SELECT vs_id, url, name FROM value_set WHERE url = ?')
      .get(`http://snomed.info/sct?fhir_vs=refset/${SIMPLE_REFSET_ID}`);
    expect(vs).toBeTruthy();
    const members = db.prepare('SELECT concept_id FROM value_set_member WHERE vs_id = ?')
      .all(vs.vs_id).map((r) => r.concept_id);
    expect(members.sort()).toEqual([conceptId(A), conceptId(C)].sort());
    expect(stats.refsetMembers).toBe(2);
  });

  test('per-concept metadata properties (module, definitionStatus, effectiveTime, inactive)', () => {
    const cId = conceptId(INACT);
    const modProp = db.prepare('SELECT property_id FROM property_def WHERE property_code = ?').get('moduleId');
    const mod = db.prepare('SELECT value_raw FROM concept_literal WHERE property_id = ? AND source_concept_id = ?')
      .get(modProp.property_id, cId);
    expect(mod.value_raw).toBe(MODULE);
    const inactProp = db.prepare('SELECT property_id FROM property_def WHERE property_code = ?').get('inactive');
    const inact = db.prepare('SELECT value_bool FROM concept_literal WHERE property_id = ? AND source_concept_id = ?')
      .get(inactProp.property_id, cId);
    expect(inact.value_bool).toBe(1); // INACT is inactive
  });

  test('cs_config registry keys written', () => {
    const cfg = {};
    for (const r of db.prepare('SELECT key, value FROM cs_config').all()) cfg[r.key] = r.value;
    expect(cfg.caseSensitive).toBe('1');
    expect(cfg.defaultLanguage).toBe('en');
    expect(cfg.versionAlgorithm).toBe('date');
    expect(cfg.hierarchyMeaning).toBe('is-a');
    expect(cfg.hierarchyEdgeSet).toBe('1');
    const ivs = JSON.parse(cfg.implicitValueSets);
    expect(Array.isArray(ivs)).toBe(true);
    expect(ivs.some((p) => p.kind === 'vs-table')).toBe(true);
  });
});
