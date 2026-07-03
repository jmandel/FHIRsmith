'use strict';

// Contract tests for the generic sqlite-v1 CodeSystem provider
// (tx/cs/cs-sqlite.js). Fixtures are built with the import core
// (tx/importers/sqlite-v1-core.js) so the provider is exercised against
// exactly the schema/semantics the importers produce.
//
// Diamond hierarchy (child -> parent is-a links):
//   A -> B, A -> C, B -> D, C -> D, D -> E
// so ancestors(A) = {B,C,D,E}; E reachable from A via two paths but once in
// the closure. Roots (no parent) = E plus the flat filler concepts.

const path = require('path');
const fs = require('fs');
const os = require('os');

const { openV1Database, V1Writer } = require('../../tx/importers/sqlite-v1-core');
const { SqliteCodeSystemFactory, SqliteConceptContext } = require('../../tx/cs/cs-sqlite');
const { CodeSystem } = require('../../tx/library/codesystem');
const { OperationContext } = require('../../tx/operation-context');
const { Designations } = require('../../tx/library/designations');
const { TestUtilities } = require('../test-utilities');

const SYSTEM = 'http://example.org/synth';
const VERSION = '2026-07-03';

function buildMainFixture(dbPath) {
  const db = openV1Database(dbPath, { overwrite: true });
  const writer = new V1Writer(db);
  const cid = {};
  const prop = {};

  const csId = writer.codeSystem({
    baseUri: SYSTEM,
    editionCode: 'X1',
    version: VERSION,
    canonicalUri: `${SYSTEM}|${VERSION}`,
    releaseDate: VERSION,
    name: 'Synthetic',
    title: 'Synthetic Terminology',
    description: 'test fixture',
    contentMode: 'complete',
    sourceKind: 'synth-v1',
  });

  writer.setConfig(csId, 'caseSensitive', 1);
  writer.setConfig(csId, 'defaultLanguage', 'en');
  writer.setConfig(csId, 'hierarchyEdgeSet', 1);
  writer.setConfig(csId, 'versionAlgorithm', 'date');
  writer.setConfig(csId, 'statusProperty', 'status');
  writer.setConfig(csId, 'webSource', 'http://example.org/synth/{code}');
  writer.setConfig(csId, 'searchSources', ['display', 'designation', 'literal']);
  writer.setConfig(csId, 'filterAliases', { 'vsac-parent': 'is-a-prop' });
  writer.setConfig(csId, 'filterValueRewrites',
    JSON.stringify([{ pattern: '^CUI:(\\w+)$', replace: '$1' }]));
  writer.setConfig(csId, 'implicitValueSets', [
    { pattern: '?fhir_vs', kind: 'all' },
    { pattern: '?fhir_vs=isa/{code}', kind: 'isa' },
    { pattern: '?fhir_vs=refset/{id}', kind: 'vs-table' },
  ]);

  // is-a hierarchy + one non-hierarchy concept-valued prop + one literal per type.
  prop.isa = writer.defineProperty(csId, {
    code: 'is-a-prop', uri: 'http://example.org/isa',
    fhirType: 'code', valueKind: 'concept', isHierarchy: true, display: 'Is a',
  });
  prop.assoc = writer.defineProperty(csId, {
    code: 'associated-with', uri: 'http://example.org/assoc',
    fhirType: 'Coding', valueKind: 'concept', isHierarchy: false,
  });
  prop.status = writer.defineProperty(csId, { code: 'status', fhirType: 'code', valueKind: 'literal' });
  prop.pStr = writer.defineProperty(csId, { code: 'p-str', fhirType: 'string', valueKind: 'literal' });
  prop.pCode = writer.defineProperty(csId, { code: 'p-code', fhirType: 'code', valueKind: 'literal' });
  prop.pInt = writer.defineProperty(csId, { code: 'p-int', fhirType: 'integer', valueKind: 'literal' });
  prop.pDec = writer.defineProperty(csId, { code: 'p-dec', fhirType: 'decimal', valueKind: 'literal' });
  prop.pBool = writer.defineProperty(csId, { code: 'p-bool', fhirType: 'boolean', valueKind: 'literal' });
  prop.pDate = writer.defineProperty(csId, { code: 'p-date', fhirType: 'dateTime', valueKind: 'literal' });

  const codes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
  for (const code of codes) {
    cid[code] = writer.addConcept(csId, { code, display: `Concept ${code}` });
  }
  cid.Z = writer.addConcept(csId, { code: 'Z', active: false, display: 'Concept Zeta retired' });

  const isaEdges = [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['D', 'E']];
  for (const [child, parent] of isaEdges) {
    writer.addLink({ sourceId: cid[child], propertyId: prop.isa, targetId: cid[parent] });
  }

  // Non-hierarchy concept-valued property: G associated-with H.
  writer.addLink({ sourceId: cid.G, propertyId: prop.assoc, targetId: cid.H });

  // Designations: en (default) + de (preferred within de) with use codings.
  writer.addDesignation(cid.A, {
    language: 'en', useSystem: 'http://snomed.info/sct', useCode: '900000000000003001',
    term: 'Acetaminophen tablet', preferred: true,
  });
  writer.addDesignation(cid.A, {
    language: 'de', useSystem: 'http://snomed.info/sct', useCode: '900000000000013009',
    term: 'Paracetamol Tablette', preferred: true,
  });

  // Literals of each fhir_type + the status property on concept A.
  writer.addLiteral({ sourceId: cid.A, propertyId: prop.status, value: 'ACTIVE' });
  writer.addLiteral({ sourceId: cid.A, propertyId: prop.pStr, value: 'free text value' });
  writer.addLiteral({ sourceId: cid.A, propertyId: prop.pCode, value: 'CODEVAL' });
  writer.addLiteral({ sourceId: cid.A, propertyId: prop.pInt, value: '42' });
  writer.addLiteral({ sourceId: cid.A, propertyId: prop.pDec, value: '3.14' });
  writer.addLiteral({ sourceId: cid.A, propertyId: prop.pBool, value: 'Y' });
  writer.addLiteral({ sourceId: cid.A, propertyId: prop.pDate, value: '2026-07-03' });
  // status on the inactive concept, to prove getStatus != isInactive.
  writer.addLiteral({ sourceId: cid.Z, propertyId: prop.status, value: 'RETIRED' });

  // Value set (a "refset") with 3 members, exposed via implicit vs-table.
  const vsId = writer.addValueSet(csId, { url: `${SYSTEM}?fhir_vs=refset/123`, name: 'Diamond refset' });
  // Insertion order (E, A, D) is deliberately NOT code order: member order is
  // semantic (source sequence, e.g. LOINC answer lists) and must be preserved.
  writer.addValueSetMember(vsId, cid.E);
  writer.addValueSetMember(vsId, cid.A);
  writer.addValueSetMember(vsId, cid.D);

  const runId = writer.beginAudit({
    sourcePath: '/dev/null', targetDb: dbPath, terminology: 'synth', editionCode: 'X1', version: VERSION,
  });
  const closureRows = writer.buildClosure(csId, { edgeSetId: 1 });
  writer.buildSearchIndex(csId);
  writer.finishAudit(runId, { status: 'success', stats: { concepts: codes.length + 1, closureRows } });
  writer.finalize({ caseSensitive: true });
  db.close();
  return cid;
}

function buildCaseInsensitiveFixture(dbPath) {
  const db = openV1Database(dbPath, { overwrite: true });
  const writer = new V1Writer(db);
  const csId = writer.codeSystem({
    baseUri: 'http://example.org/ci',
    version: '1',
    canonicalUri: 'http://example.org/ci|1',
    name: 'CaseInsensitive',
    description: 'ci fixture',
  });
  writer.setConfig(csId, 'caseSensitive', 0);
  writer.setConfig(csId, 'defaultLanguage', 'en');
  writer.addConcept(csId, { code: 'AbC', display: 'Mixed case concept' });
  writer.addConcept(csId, { code: 'xyz', display: 'Lower concept' });
  // Inserted last but sorts between the others in code order: pins that
  // iteration is source (concept_id) order, not code order (tier 1.5).
  writer.addConcept(csId, { code: 'aaa', display: 'Late-inserted concept' });
  const runId = writer.beginAudit({ targetDb: dbPath, terminology: 'ci', version: '1' });
  writer.buildClosure(csId, { edgeSetId: 1 });
  writer.buildSearchIndex(csId);
  writer.finishAudit(runId, { status: 'success' });
  writer.finalize({ caseSensitive: false });
  db.close();
}

describe('SqliteCodeSystemProvider (sqlite-v1 contract)', () => {
  let tmpDir;
  let dbPath;
  let ciPath;
  let factory;
  let ciFactory;
  let opContext;
  let provider;
  let ciProvider;
  let langDefs;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sqlite-'));
    dbPath = path.join(tmpDir, 'main.db');
    ciPath = path.join(tmpDir, 'ci.db');
    buildMainFixture(dbPath);
    buildCaseInsensitiveFixture(ciPath);

    langDefs = await TestUtilities.loadLanguageDefinitions();
    const i18n = await TestUtilities.loadTranslations(langDefs);
    opContext = new OperationContext('en', i18n);

    factory = new SqliteCodeSystemFactory(i18n, dbPath);
    await factory.load();
    provider = await factory.build(opContext, []);

    ciFactory = new SqliteCodeSystemFactory(i18n, ciPath);
    await ciFactory.load();
    ciProvider = await ciFactory.build(opContext, []);
  });

  afterAll(async () => {
    if (provider) provider.close();
    if (ciProvider) ciProvider.close();
    if (factory) await factory.close();
    if (ciFactory) await ciFactory.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const desigs = () => new Designations(langDefs);

  // ---- metadata ----------------------------------------------------------

  describe('metadata', () => {
    test('system/version/description/contentMode from code_system', async () => {
      expect(provider.system()).toBe(SYSTEM);
      expect(provider.version()).toBe(VERSION);
      expect(provider.description()).toBe('test fixture');
      expect(provider.contentMode()).toBe('complete');
      expect(await provider.totalCount()).toBe(12);
    });

    test('config-driven flags', () => {
      expect(provider.isCaseSensitive()).toBe(true);
      expect(provider.defLang()).toBe('en');
      expect(provider.versionAlgorithm()).toBe('date');
      expect(provider.hasParents()).toBe(true);
      expect(ciProvider.isCaseSensitive()).toBe(false);
      expect(ciProvider.hasParents()).toBe(false);
    });

    test('propertyDefinitions from property_def', () => {
      const defs = provider.propertyDefinitions();
      const byCode = Object.fromEntries(defs.map((d) => [d.code, d]));
      expect(byCode['p-int'].type).toBe('integer');
      expect(byCode['is-a-prop'].type).toBe('code');
      expect(byCode['is-a-prop'].uri).toBe('http://example.org/isa');
      expect(byCode['associated-with'].type).toBe('Coding');
    });

    test('hasAnyDisplays considers default + designation languages + supplements', () => {
      expect(provider.hasAnyDisplays('en')).toBe(true);
      expect(provider.hasAnyDisplays('de')).toBe(true);   // de designation present
      expect(provider.hasAnyDisplays('zh')).toBe(false);
    });

    test('name/vurl', () => {
      expect(provider.name()).toBe(`${SYSTEM}|${VERSION}`);
      expect(provider.vurl()).toBe(`${SYSTEM}|${VERSION}`);
    });
  });

  // ---- locate ------------------------------------------------------------

  describe('locate', () => {
    test('case-sensitive fixture: exact match only', async () => {
      const hit = await provider.locate('A');
      expect(hit.context).toBeInstanceOf(SqliteConceptContext);
      expect(hit.context.code).toBe('A');
      expect(hit.message).toBeNull();

      const miss = await provider.locate('a');
      expect(miss.context).toBeNull();
      expect(miss.message).toMatch(/Unknown code/);

      const miss2 = await provider.locate('NOPE');
      expect(miss2.context).toBeNull();
    });

    test('case-insensitive fixture: folds case', async () => {
      const exact = await ciProvider.locate('AbC');
      expect(exact.context.code).toBe('AbC');
      const folded = await ciProvider.locate('abc');
      expect(folded.context).not.toBeNull();
      expect(folded.context.code).toBe('AbC');
      const upper = await ciProvider.locate('XYZ');
      expect(upper.context.code).toBe('xyz');
    });

    test('code() returns canonical code from context', async () => {
      const res = await provider.locate('B');
      expect(await provider.code(res.context)).toBe('B');
      expect(await provider.code('C')).toBe('C');
    });
  });

  // ---- display / designations -------------------------------------------

  describe('display and designations', () => {
    test('display defaults to concept.display for en', async () => {
      expect(await provider.display('A')).toBe('Concept A');
    });

    test('display selects best designation for a preferred non-default language', async () => {
      const i18n = await TestUtilities.loadTranslations(langDefs);
      const deCtx = new OperationContext('de', i18n);
      const deProvider = await factory.build(deCtx, []);
      try {
        expect(await deProvider.display('A')).toBe('Paracetamol Tablette');
      } finally {
        deProvider.close();
      }
    });

    test('designations include display-use + all designation rows with use codings', async () => {
      const d = desigs();
      await provider.designations('A', d);
      const terms = d.designations.map((x) => x.value);
      expect(terms).toContain('Concept A');               // display-use, default lang
      expect(terms).toContain('Acetaminophen tablet');    // en designation
      expect(terms).toContain('Paracetamol Tablette');    // de designation

      const de = d.designations.find((x) => x.value === 'Paracetamol Tablette');
      expect(de.language.code).toBe('de');
      expect(de.use.system).toBe('http://snomed.info/sct');
      expect(de.use.code).toBe('900000000000013009');
    });
  });

  // ---- properties --------------------------------------------------------

  describe('properties (typed per fhir_type)', () => {
    test('literal properties typed correctly', async () => {
      const props = await provider.properties('A');
      const by = (code) => props.find((p) => p.code === code);
      expect(by('p-str').valueString).toBe('free text value');
      expect(by('p-code').valueCode).toBe('CODEVAL');
      expect(by('p-int').valueInteger).toBe(42);
      expect(by('p-dec').valueDecimal).toBeCloseTo(3.14);
      expect(by('p-bool').valueBoolean).toBe(true);
      expect(by('p-date').valueDateTime).toBe('2026-07-03');
    });

    test('concept-valued property emits valueCoding for Coding-typed prop', async () => {
      const props = await provider.properties('G');
      const assoc = props.find((p) => p.code === 'associated-with');
      expect(assoc.valueCoding).toEqual({ system: SYSTEM, code: 'H' });
    });

    test('getStatus reads statusProperty literal; isInactive reads active flag', async () => {
      expect(await provider.getStatus('A')).toBe('ACTIVE');
      expect(await provider.isInactive('A')).toBe(false);
      expect(await provider.isInactive('Z')).toBe(true);
      expect(await provider.getStatus('Z')).toBe('RETIRED');
      // A concept with no status literal yields null.
      expect(await provider.getStatus('B')).toBeNull();
    });

    test('definition/isAbstract/isDeprecated/itemWeight defaults', async () => {
      expect(await provider.definition('A')).toBeNull();
      expect(await provider.isAbstract('A')).toBe(false);
      expect(await provider.isDeprecated('A')).toBe(false);
      expect(await provider.itemWeight('A')).toBeNull();
    });
  });

  // ---- hierarchy ---------------------------------------------------------

  describe('hierarchy', () => {
    test('parent / parents (multi-parent)', async () => {
      expect(await provider.parent('A')).toMatch(/^[BC]$/);
      expect((await provider.parents('A')).sort()).toEqual(['B', 'C']);
      expect(await provider.parent('E')).toBeNull();
    });

    test('locateIsA', async () => {
      const ok = await provider.locateIsA('A', 'E', false);
      expect(ok.context).not.toBeNull();
      const self = await provider.locateIsA('E', 'E', false);
      expect(self.context).not.toBeNull();
      const selfDisallowed = await provider.locateIsA('E', 'E', true);
      expect(selfDisallowed.context).toBeNull();
      const notDesc = await provider.locateIsA('E', 'A', false);
      expect(notDesc.context).toBeNull();
    });

    test('subsumesTest all four outcomes', async () => {
      expect(await provider.subsumesTest('E', 'E')).toBe('equivalent');
      expect(await provider.subsumesTest('E', 'A')).toBe('subsumes');
      expect(await provider.subsumesTest('A', 'E')).toBe('subsumed-by');
      expect(await provider.subsumesTest('F', 'A')).toBe('not-subsumed');
    });
  });

  // ---- iteration ---------------------------------------------------------

  describe('iteration', () => {
    async function drain(iter) {
      const out = [];
      let c;
      while ((c = await provider.nextContext(iter)) !== null) out.push(c.code);
      return out;
    }

    test('iterator(null) returns roots; iteratorAll returns everything', async () => {
      const roots = await drain(await provider.iterator(null));
      // Roots = concepts with no active parent: E + flat fillers + Z.
      expect(roots).toContain('E');
      expect(roots).not.toContain('A');
      expect(roots).not.toContain('D');

      const allIter = await provider.iteratorAll();
      expect(allIter.total).toBe(12);
      const all = await drain(allIter);
      expect(all.length).toBe(12);
      expect(all).toContain('A');
      expect(all).toContain('Z');
    });

    test('iterator(ctx) returns active hierarchy children', async () => {
      const dRes = await provider.locate('D');
      const kids = await drain(await provider.iterator(dRes.context));
      expect(kids.sort()).toEqual(['B', 'C']);
      const eKids = await drain(await provider.iterator((await provider.locate('E')).context));
      expect(eKids).toEqual(['D']);
    });

    test('ci fixture iterator(null) = all concepts, in source (insertion) order', async () => {
      const iter = await ciProvider.iterator(null);
      const out = [];
      let c;
      while ((c = await ciProvider.nextContext(iter)) !== null) out.push(c.code);
      // Source order, NOT code order (which would put 'aaa' second).
      expect(out).toEqual(['AbC', 'xyz', 'aaa']);
    });
  });

  // ---- filters -----------------------------------------------------------

  describe('filters', () => {
    async function runFilter(prop, op, value) {
      const ctx = await provider.getPrepContext(true);
      await provider.filter(ctx, true, prop, op, value);
      const sets = await provider.executeFilters(ctx);
      const codes = [];
      while (await provider.filterMore(ctx, sets[0])) {
        codes.push((await provider.filterConcept(ctx, sets[0])).code);
      }
      const size = await provider.filterSize(ctx, sets[0]);
      await provider.filterFinish(ctx);
      return { codes: codes.sort(), size };
    }

    test('doesFilter honesty', async () => {
      expect(await provider.doesFilter('concept', 'is-a', 'A')).toBe(true);
      expect(await provider.doesFilter('concept', 'descendent-of', 'A')).toBe(true);
      expect(await provider.doesFilter('concept', 'child-of', 'A')).toBe(true);
      expect(await provider.doesFilter('concept', 'generalizes', 'A')).toBe(true);
      expect(await provider.doesFilter('p-code', '=', 'CODEVAL')).toBe(true);
      expect(await provider.doesFilter('p-code', 'in', 'x,y')).toBe(true);
      expect(await provider.doesFilter('p-code', 'exists', 'true')).toBe(true);
      expect(await provider.doesFilter('p-str', 'regex', '.*')).toBe(true);
      expect(await provider.doesFilter('vsac-parent', 'is-a', 'A')).toBe(true); // alias
      expect(await provider.doesFilter('nope', '=', 'x')).toBe(false);
      expect(await provider.doesFilter('p-code', 'blah', 'x')).toBe(false);
      expect(await ciProvider.doesFilter('concept', 'is-a', 'x')).toBe(false); // no hierarchy
    });

    test('is-a includes the seed; descendent-of does not', async () => {
      const isa = await runFilter('concept', 'is-a', 'E');
      expect(isa.codes).toEqual(['A', 'B', 'C', 'D', 'E']);
      const desc = await runFilter('concept', 'descendent-of', 'E');
      expect(desc.codes).toEqual(['A', 'B', 'C', 'D']);
    });

    test('child-of returns direct children; generalizes returns ancestors + self', async () => {
      const child = await runFilter('concept', 'child-of', 'D');
      expect(child.codes).toEqual(['B', 'C']);
      const gen = await runFilter('concept', 'generalizes', 'A');
      expect(gen.codes).toEqual(['A', 'B', 'C', 'D', 'E']);
    });

    test('= on literal and concept-valued property', async () => {
      const lit = await runFilter('p-code', '=', 'CODEVAL');
      expect(lit.codes).toEqual(['A']);
      const conc = await runFilter('associated-with', '=', 'H');
      expect(conc.codes).toEqual(['G']);
    });

    test('filterValueRewrites maps legacy value forms (CUI: prefix)', async () => {
      const rewritten = await runFilter('associated-with', '=', 'CUI:H');
      expect(rewritten.codes).toEqual(['G']);
    });

    test('in / exists / regex', async () => {
      const inF = await runFilter('p-code', 'in', 'CODEVAL,OTHER');
      expect(inF.codes).toEqual(['A']);
      const existsTrue = await runFilter('status', 'exists', 'true');
      expect(existsTrue.codes).toEqual(['A', 'Z']);
      const existsFalse = await runFilter('status', 'exists', 'false');
      expect(existsFalse.codes).not.toContain('A');
      expect(existsFalse.codes).toContain('B');
      const rx = await runFilter('p-str', 'regex', 'free.*value');
      expect(rx.codes).toEqual(['A']);
    });

    test('searchFilter matches display / designation / literal text', async () => {
      const ctx = await provider.getPrepContext(true);
      await provider.searchFilter(ctx, { filter: 'Paracetamol' }, false);
      const sets = await provider.executeFilters(ctx);
      const codes = [];
      while (await provider.filterMore(ctx, sets[0])) {
        codes.push((await provider.filterConcept(ctx, sets[0])).code);
      }
      expect(codes).toContain('A');
      await provider.filterFinish(ctx);
    });

    test('multi-clause executeFilters returns multiple sets; engine joins via filterCheck', async () => {
      const ctx = await provider.getPrepContext(true);
      await provider.filter(ctx, true, 'concept', 'is-a', 'E');   // A,B,C,D,E
      await provider.filter(ctx, true, 'concept', 'child-of', 'E'); // D
      const sets = await provider.executeFilters(ctx);
      expect(sets.length).toBe(2);

      // Iterate first set, probe the second via filterCheck (join = {D}).
      const joined = [];
      while (await provider.filterMore(ctx, sets[0])) {
        const c = await provider.filterConcept(ctx, sets[0]);
        if ((await provider.filterCheck(ctx, sets[1], c)) === true) joined.push(c.code);
      }
      expect(joined).toEqual(['D']);
      await provider.filterFinish(ctx);
    });

    test('filterLocate hit and miss; filterSize', async () => {
      const ctx = await provider.getPrepContext(false);
      await provider.filter(ctx, false, 'concept', 'is-a', 'E');
      const sets = await provider.executeFilters(ctx);
      expect(await provider.filterSize(ctx, sets[0])).toBe(5);

      const hit = await provider.filterLocate(ctx, sets[0], 'B');
      expect(hit).toBeInstanceOf(SqliteConceptContext);

      const miss = await provider.filterLocate(ctx, sets[0], 'F');
      expect(typeof miss).toBe('string');

      const badCode = await provider.filterLocate(ctx, sets[0], 'NOPE');
      expect(typeof badCode).toBe('string');
      await provider.filterFinish(ctx);
    });

    test('filters do not exclude inactive concepts (worker applies activeOnly)', async () => {
      const existsStatus = await runFilter('status', 'exists', 'true');
      expect(existsStatus.codes).toContain('Z'); // Z is inactive but has status
    });
  });

  // ---- buildKnownValueSet ------------------------------------------------

  describe('buildKnownValueSet', () => {
    test('kind all', async () => {
      const vs = await factory.buildKnownValueSet(`${SYSTEM}?fhir_vs`, null);
      expect(vs.resourceType).toBe('ValueSet');
      expect(vs.compose.include).toEqual([{ system: SYSTEM }]);
    });

    test('kind isa', async () => {
      const vs = await factory.buildKnownValueSet(`${SYSTEM}?fhir_vs=isa/E`, null);
      expect(vs.compose.include[0].filter).toEqual([{ property: 'concept', op: 'is-a', value: 'E' }]);
    });

    test('kind vs-table enumerates members in source (member_id) order', async () => {
      const vs = await factory.buildKnownValueSet(`${SYSTEM}?fhir_vs=refset/123`, null);
      const codes = vs.compose.include[0].concept.map((c) => c.code);
      expect(codes).toEqual(['E', 'A', 'D']);
    });

    test('unknown url returns null', async () => {
      expect(await factory.buildKnownValueSet('http://other/vs', null)).toBeNull();
    });
  });

  // ---- factory extras ----------------------------------------------------

  describe('factory extras', () => {
    test('defaultVersion / iteratable / id / webSource / codeLink', () => {
      expect(factory.defaultVersion()).toBe(VERSION);
      expect(factory.iteratable()).toBe(true);
      expect(factory.id()).toContain(SYSTEM);
      expect(factory.webSource()).toBe('http://example.org/synth/{code}');
      expect(factory.codeLink('A')).toBe('http://example.org/synth/A');
    });
  });

  // ---- supplements -------------------------------------------------------

  describe('supplements', () => {
    function makeSupplement() {
      return new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://example.org/synth-supp',
        version: '1',
        status: 'active',
        content: 'supplement',
        language: 'en',
        supplements: `${SYSTEM}|${VERSION}`,
        concept: [
          {
            code: 'A',
            display: 'Supplemented display for A',
            designation: [
              { language: 'en', use: { system: 'http://example.org', code: 'alt' }, value: 'Extra A designation' },
            ],
          },
        ],
      });
    }

    test('display override + designation merge + hasSupplement/listSupplements', async () => {
      const supp = makeSupplement();
      const suppProvider = await factory.build(opContext, [supp]);
      try {
        expect(await suppProvider.display('A')).toBe('Supplemented display for A');
        expect(suppProvider.hasSupplement('http://example.org/synth-supp')).toBe(true);
        expect(suppProvider.hasSupplement('http://nope')).toBe(false);
        expect(suppProvider.listSupplements(true).length).toBe(1);

        const d = desigs();
        await suppProvider.designations('A', d);
        const terms = d.designations.map((x) => x.value);
        expect(terms).toContain('Supplemented display for A');
        expect(terms).toContain('Extra A designation');
        // base designations still present
        expect(terms).toContain('Acetaminophen tablet');
      } finally {
        suppProvider.close();
      }
    });
  });
});
