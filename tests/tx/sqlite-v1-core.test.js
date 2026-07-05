const path = require('path');
const fs = require('fs');
const os = require('os');

const { openV1Database, V1Writer } = require('../../tx/importers/sqlite-v1-core');

// Synthetic terminology with a diamond hierarchy expressed as child->parent
// is-a links (link source = child, target = parent):
//   A -> B, A -> C, B -> D, C -> D, D -> E
// so the ancestors of A are {B, C, D, E}; E is reachable from A via two paths
// (A-B-D-E and A-C-D-E) but must appear exactly once in the closure.
describe('sqlite-v1-core', () => {
  let tmpDir;
  let dbPath;
  let db;
  let writer;
  let csId;
  const cid = {};      // code -> concept_id
  const prop = {};     // property code -> property_id

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-v1-'));
    dbPath = path.join(tmpDir, 'synthetic.db');
    db = openV1Database(dbPath, { overwrite: true });
    writer = new V1Writer(db);

    csId = writer.codeSystem({
      baseUri: 'http://example.org/synth',
      editionCode: 'X1',
      version: '2026-07-03',
      canonicalUri: 'http://example.org/synth|2026-07-03',
      releaseDate: '2026-07-03',
      name: 'Synthetic',
      title: 'Synthetic Terminology',
      description: 'test fixture',
      contentMode: 'complete',
      sourceKind: 'synth-v1',
    });

    writer.setConfig(csId, 'caseSensitive', 1);
    writer.setConfig(csId, 'defaultLanguage', 'en');
    writer.setConfig(csId, 'hierarchyEdgeSet', 1);
    writer.setConfig(csId, 'implicitValueSets', [
      { pattern: '?fhir_vs=isa/{code}', kind: 'isa' },
    ]);

    // property_def: is-a hierarchy + one concept-valued (non-hierarchy)
    // property + one literal property per fhir_type.
    prop.isa = writer.defineProperty(csId, {
      code: 'is-a', uri: 'http://example.org/isa',
      fhirType: 'code', valueKind: 'concept', isHierarchy: true, display: 'Is a',
    });
    prop.assoc = writer.defineProperty(csId, {
      code: 'associated-with',
      fhirType: 'Coding', valueKind: 'concept', isHierarchy: false,
    });
    prop.pStr = writer.defineProperty(csId, { code: 'p-str', fhirType: 'string', valueKind: 'literal' });
    prop.pCode = writer.defineProperty(csId, { code: 'p-code', fhirType: 'code', valueKind: 'literal' });
    prop.pInt = writer.defineProperty(csId, { code: 'p-int', fhirType: 'integer', valueKind: 'literal' });
    prop.pDec = writer.defineProperty(csId, { code: 'p-dec', fhirType: 'decimal', valueKind: 'literal' });
    prop.pBool = writer.defineProperty(csId, { code: 'p-bool', fhirType: 'boolean', valueKind: 'literal' });
    prop.pDate = writer.defineProperty(csId, { code: 'p-date', fhirType: 'dateTime', valueKind: 'literal' });

    // Concepts: A..E in the diamond, plus F..K filler and one inactive (Z).
    const codes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
    for (const code of codes) {
      cid[code] = writer.addConcept(csId, { code, display: `Concept ${code}` });
    }
    cid.Z = writer.addConcept(csId, { code: 'Z', active: false, display: 'Concept Zeta (retired)' });

    // Diamond is-a edges (child -> parent).
    const isaEdges = [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['D', 'E']];
    for (const [child, parent] of isaEdges) {
      writer.addLink({ sourceId: cid[child], propertyId: prop.isa, targetId: cid[parent] });
    }

    // An INACTIVE is-a edge that must NOT contribute to the closure:
    //   F -> E (inactive). F has no other parents, so F must have no ancestors.
    writer.addLink({ sourceId: cid.F, propertyId: prop.isa, targetId: cid.E, active: false });

    // A non-hierarchy concept-valued property (must NOT affect closure).
    writer.addLink({ sourceId: cid.G, propertyId: prop.assoc, targetId: cid.H });

    // Designations: two languages, with use codes; one preferred.
    writer.addDesignation(cid.A, {
      language: 'en', useSystem: 'http://snomed.info/sct', useCode: '900000000000003001',
      term: 'Acetaminophen tablet', preferred: true,
    });
    writer.addDesignation(cid.A, {
      language: 'es', useSystem: 'http://snomed.info/sct', useCode: '900000000000013009',
      term: 'comprimido de paracetamol', preferred: false,
    });

    // Literals of each fhir_type on concept A.
    writer.addLiteral({ sourceId: cid.A, propertyId: prop.pStr, value: 'free text value' });
    writer.addLiteral({ sourceId: cid.A, propertyId: prop.pCode, value: 'ACTIVE' });
    writer.addLiteral({ sourceId: cid.A, propertyId: prop.pInt, value: '42' });
    writer.addLiteral({ sourceId: cid.A, propertyId: prop.pDec, value: '3.14' });
    writer.addLiteral({ sourceId: cid.A, propertyId: prop.pBool, value: 'Y' });
    writer.addLiteral({ sourceId: cid.A, propertyId: prop.pDate, value: '2026-07-03' });

    // Value set with members.
    const vsId = writer.addValueSet(csId, { url: 'http://example.org/vs/diamond', version: '1', name: 'Diamond' });
    writer.addValueSetMember(vsId, cid.A);
    writer.addValueSetMember(vsId, cid.E);

    const runId = writer.beginAudit({
      sourcePath: '/dev/null', targetDb: dbPath, terminology: 'synth',
      editionCode: 'X1', version: '2026-07-03',
    });

    const closureRows = writer.buildClosure(csId, { edgeSetId: 1 });
    writer.buildSearchIndex(csId);

    writer.finishAudit(runId, { status: 'success', stats: { concepts: codes.length + 1, closureRows } });
    writer.finalize({ caseSensitive: true });
  });

  afterAll(() => {
    if (db && db.open) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('closure is exact for the diamond, with no self-rows and E reachable once', () => {
    const rows = db.prepare(
      `SELECT ancestor_id, descendant_id FROM closure ORDER BY descendant_id, ancestor_id`
    ).all();
    const got = new Set(rows.map((r) => `${r.ancestor_id}->${r.descendant_id}`));

    // Expected ancestor sets per descendant.
    const expectedAncestors = {
      A: ['B', 'C', 'D', 'E'],
      B: ['D', 'E'],
      C: ['D', 'E'],
      D: ['E'],
      // E, F..K, Z: no ancestors
    };
    const expected = new Set();
    for (const [desc, anc] of Object.entries(expectedAncestors)) {
      for (const a of anc) expected.add(`${cid[a]}->${cid[desc]}`);
    }

    expect(got).toEqual(expected);

    // No self-rows.
    const selfRows = db.prepare(
      `SELECT COUNT(*) AS n FROM closure WHERE ancestor_id = descendant_id`
    ).get().n;
    expect(selfRows).toBe(0);

    // E is an ancestor of A exactly once (diamond dedupe).
    const eOfA = db.prepare(
      `SELECT COUNT(*) AS n FROM closure WHERE ancestor_id = ? AND descendant_id = ?`
    ).get(cid.E, cid.A).n;
    expect(eOfA).toBe(1);
  });

  test('inactive hierarchy edge is excluded from the closure', () => {
    const fAncestors = db.prepare(
      `SELECT COUNT(*) AS n FROM closure WHERE descendant_id = ?`
    ).get(cid.F).n;
    expect(fAncestors).toBe(0);
  });

  test('non-hierarchy concept links do not affect the closure', () => {
    const gAncestors = db.prepare(
      `SELECT COUNT(*) AS n FROM closure WHERE descendant_id = ?`
    ).get(cid.G).n;
    expect(gAncestors).toBe(0);
  });

  test('typed literal projections land in the right columns', () => {
    const byProp = (propertyId) => db.prepare(
      `SELECT value_raw, value_text, value_num, value_bool
         FROM concept_literal WHERE source_concept_id = ? AND property_id = ?`
    ).get(cid.A, propertyId);

    const str = byProp(prop.pStr);
    expect(str.value_text).toBe('free text value');
    expect(str.value_num).toBeNull();
    expect(str.value_bool).toBeNull();

    const code = byProp(prop.pCode);
    expect(code.value_text).toBe('ACTIVE');

    const int = byProp(prop.pInt);
    expect(int.value_num).toBe(42);
    expect(int.value_text).toBeNull();
    expect(int.value_raw).toBe('42');

    const dec = byProp(prop.pDec);
    expect(dec.value_num).toBeCloseTo(3.14);

    const bool = byProp(prop.pBool);
    expect(bool.value_bool).toBe(1);
    expect(bool.value_raw).toBe('Y');

    const date = byProp(prop.pDate);
    expect(date.value_text).toBe('2026-07-03');
  });

  test('FTS trigram matches a designation substring and misses absent text', () => {
    const hit = db.prepare(
      `SELECT rowid FROM search_fts_designation WHERE term MATCH ?`
    ).all('paracetamol');
    expect(hit.length).toBe(1);

    const miss = db.prepare(
      `SELECT rowid FROM search_fts_designation WHERE term MATCH ?`
    ).all('nonexistentsubstring');
    expect(miss.length).toBe(0);

    // Display FTS should find the diamond concepts too.
    const disp = db.prepare(
      `SELECT rowid FROM search_fts_display WHERE term MATCH ?`
    ).all('Concept');
    expect(disp.length).toBeGreaterThan(0);

    // Literal FTS holds value_text projections only.
    const lit = db.prepare(
      `SELECT rowid FROM search_fts_literal WHERE term MATCH ?`
    ).all('free text');
    expect(lit.length).toBe(1);
  });

  test('config round-trips including JSON values', () => {
    const get = (key) => db.prepare(
      `SELECT value FROM cs_config WHERE cs_id = ? AND key = ?`
    ).get(csId, key).value;

    expect(get('caseSensitive')).toBe('1');
    expect(get('defaultLanguage')).toBe('en');

    const ivs = JSON.parse(get('implicitValueSets'));
    expect(ivs).toEqual([{ pattern: '?fhir_vs=isa/{code}', kind: 'isa' }]);
  });

  test('load_audit row is written with stats', () => {
    const row = db.prepare(
      `SELECT * FROM load_audit ORDER BY run_id DESC LIMIT 1`
    ).get();
    expect(row.status).toBe('success');
    expect(row.started_at).toBeTruthy();
    expect(row.completed_at).toBeTruthy();
    expect(row.terminology).toBe('synth');

    const stats = JSON.parse(row.stats_json);
    expect(stats.closureRows).toBeGreaterThan(0);
    expect(stats.concepts).toBeGreaterThan(0);
  });

  test('finalize integrity check fires on a seeded duplicate-code violation', () => {
    const dupPath = path.join(tmpDir, 'dup.db');
    const dupDb = openV1Database(dupPath, { overwrite: true });
    const w = new V1Writer(dupDb);
    const cs = w.codeSystem({
      baseUri: 'http://example.org/dup',
      canonicalUri: 'http://example.org/dup|1',
    });
    w.addConcept(cs, { code: 'DUP', display: 'first' });
    w.flush();

    // Bypass the unique index by inserting a colliding row directly, so we are
    // testing finalize's own guard rather than the schema constraint.
    dupDb.exec('DROP INDEX IF EXISTS idx_concept_cs_code');
    dupDb.prepare(
      `INSERT INTO concept (cs_id, code, active, display) VALUES (?, 'DUP', 1, 'second')`
    ).run(cs);

    expect(() => w.finalize({ caseSensitive: true })).toThrow(/duplicate \(cs_id,code\)/);

    dupDb.close();
    fs.rmSync(dupPath, { force: true });
  });

  test('openV1Database refuses to clobber an existing file without overwrite', () => {
    const p = path.join(tmpDir, 'exists.db');
    fs.writeFileSync(p, 'not a db');
    expect(() => openV1Database(p, { overwrite: false })).toThrow(/exists/);
    fs.rmSync(p, { force: true });
  });
});
