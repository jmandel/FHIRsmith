'use strict';

const IR = require('../../tx/engine/ir');
const { createSqliteV0Compiler } = require('../../tx/cs/sqlite-v0-compiler');
const { membershipPlanStructuralForm } = require('../../tx/cs/sqlite-v0-plan-normalize');
const { physicalPlanStructuralForm } = require('../../tx/cs/sqlite-v0-physicalize');

function makeRuntime() {
  return {
    filters: {
      concept: {
        implicitValueSets: {
          'http://example.org/refset/': true,
        },
      },
      properties: {
        defaultSources: ['literal'],
        byCode: {
          CLASS: {
            sources: ['literal'],
            value: {
              aliases: { chemistry: 'CHEM' },
            },
          },
          CATEGORY: {
            sources: ['link'],
            linkMatch: 'code-or-display',
          },
        },
      },
    },
    search: {
      sources: ['display', 'designation'],
      activeOnly: true,
      designationActiveOnly: true,
      literalActiveOnly: true,
    },
  };
}

function makePropertyDefs() {
  return new Map([
    ['CLASS', { property_id: 1, value_kind: 'literal' }],
    ['CATEGORY', { property_id: 2, value_kind: 'concept' }],
  ]);
}

function makeCompiler(opts = {}) {
  return createSqliteV0Compiler({
    propertyDefs: makePropertyDefs(),
    runtime: makeRuntime(),
    scope: { system: 'urn:sys:A', version: null },
    ...opts,
  });
}

describe('sqlite-v0 compiler facade', () => {
  const compiler = makeCompiler({ includeDebugArtifacts: true });

  test('compileBaseMembership returns normalized SetPlan output', () => {
    const subtree = IR.union([
      IR.selector({
        system: 'urn:sys:A',
        shape: 'concept',
        conceptCodes: [{ code: 'A-100' }],
      }),
      IR.selector({
        system: 'urn:sys:A',
        shape: 'concept',
        conceptCodes: [{ code: 'A-100' }, { code: 'A-110' }],
      }),
    ]);

    expect(membershipPlanStructuralForm(compiler.compileBaseMembership(subtree))).toEqual({
      kind: 'explicitCodes',
      codes: ['A-100', 'A-110'],
    });
  });

  test('compileBaseMembership rejects unprojected multi-system IR explicitly', () => {
    const subtree = IR.union([
      IR.selector({ system: 'urn:sys:A', shape: 'whole' }),
      IR.selector({ system: 'urn:sys:B', shape: 'whole' }),
    ]);

    expect(() => compiler.compileBaseMembership(subtree)).toThrow(
      'sqlite-v0 native planning requires projected scoped IR'
    );
  });

  test('compileBaseMembership rejects unresolved imports explicitly', () => {
    const subtree = IR.importRef({ url: 'http://example.org/vs/missing' });
    expect(() => compiler.compileBaseMembership(subtree)).toThrow(
      'sqlite-v0 native planning requires projected scoped IR'
    );
  });

  test('compileExpand omits selected and physical debug artifacts by default', () => {
    const plainCompiler = makeCompiler();
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
    });

    const compiled = plainCompiler.compileExpand(subtree, {
      activeOnly: true,
      text: 'alpha',
      offset: 5,
      count: 10,
    });

    expect(compiled.selected).toBeNull();
    expect(compiled.logical).toBe(compiled.base);
    expect(compiled.physical).toBeNull();
    expect(compiled.traceInfo.selectedCacheKey).toBeNull();
    expect(compiled.traceInfo.selectedCacheHit).toBe(false);
  });

  test('compileExpand carries base, selected, terminal, and physical artifacts', () => {
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
    });

    const compiled = compiler.compileExpand(subtree, {
      activeOnly: true,
      text: 'alpha',
      offset: 5,
      count: 10,
    });

    expect(compiled.base).toBeTruthy();
    expect(compiled.selected).toBeTruthy();
    expect(compiled.logical).toBe(compiled.selected);
    expect(compiled.terminal.members).toBe(compiled.base);
    expect(compiled.terminal.kind).toBe('materializeConcepts');
    expect(compiled.sqlAst).toBeTruthy();
    expect(compiled.sql).toEqual(expect.objectContaining({
      text: expect.stringContaining('SELECT'),
      params: expect.any(Object),
    }));
    expect(compiled.traceInfo).toEqual(expect.objectContaining({
      scope: { system: 'urn:sys:A', version: null, csId: null },
      baseCacheKey: expect.any(String),
      baseCacheHit: false,
      selectedCacheKey: expect.any(String),
      selectedCacheHit: false,
    }));
    expect(physicalPlanStructuralForm(compiled.physical)).toEqual({
      kind: 'materialize',
      strategy: 'ordered-materialize',
      selection: { activeOnly: true, text: 'alpha' },
      members: expect.any(Object),
      columns: ['active', 'code', 'concept_id', 'definition', 'display'],
      includeTotal: false,
      orderBy: [{ key: 'code', direction: 'asc' }],
      offset: 5,
      count: 10,
    });
  });

  test('compileProbe uses base membership only, not runtime selection', () => {
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'whole',
    });

    const compiled = compiler.compileProbe(subtree, 'A-100', {
      activeOnly: true,
      text: 'alpha',
    });

    expect(compiled.selected).toBeNull();
    expect(membershipPlanStructuralForm(compiled.logical)).toEqual({ kind: 'allConcepts' });
    expect(compiled.sqlAst).toBeTruthy();
    expect(compiled.sql.text).toContain('LIMIT 1');
    expect(physicalPlanStructuralForm(compiled.physical)).toEqual({
      kind: 'probe',
      strategy: 'probe-by-code',
      code: 'A-100',
      members: {
        kind: 'scan-all',
        strategy: 'concept-scan',
      },
    });
  });

  test('compiler reuses cached normalized base and selected membership kernels', () => {
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
    });

    const first = compiler.compileExpand(subtree, { activeOnly: true, text: 'alpha' });
    const second = compiler.compileExpand(subtree, { activeOnly: true, text: 'alpha' });

    expect(second.base).toBe(first.base);
    expect(second.selected).toBe(first.selected);
    expect(second.traceInfo.baseCacheHit).toBe(true);
    expect(second.traceInfo.selectedCacheHit).toBe(true);
  });

  test('compileExpand keeps hierarchy text filtering at the terminal while using concept-driven EXISTS on the first page', () => {
    const scopedCompiler = makeCompiler({
      includeDebugArtifacts: true,
      scope: { csId: 1, system: 'urn:sys:A', version: null },
    });
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'concept', op: 'is-a', value: 'ROOT' }],
    });

    const compiled = scopedCompiler.compileExpand(subtree, {
      activeOnly: true,
      text: 'alpha',
      count: 10,
    });

    expect(compiled.sql.text).toContain('FROM "concept" "c"');
    expect(compiled.sql.text).toContain('EXISTS (SELECT 1 AS "found" FROM "closure" "cl"');
    expect(compiled.sql.text).toContain('"c"."active" = 1');
    expect(compiled.sql.text).toContain('MATCH @search_match_');
    expect(compiled.sql.text).toContain('IN (SELECT');
  });

  test('compileExpand uses concept-driven EXISTS for first-page hierarchy materialization without text', () => {
    const scopedCompiler = makeCompiler({
      includeDebugArtifacts: true,
      scope: { csId: 1, system: 'urn:sys:A', version: null },
    });
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'concept', op: 'is-a', value: 'ROOT' }],
    });

    const compiled = scopedCompiler.compileExpand(subtree, {
      activeOnly: true,
      count: 10,
    });

    expect(compiled.sql.text).toContain('FROM "concept" "c"');
    expect(compiled.sql.text).toContain('EXISTS (SELECT 1 AS "found" FROM "closure" "cl"');
    expect(compiled.sql.text).toContain('"c"."active" = 1');
    expect(compiled.sql.text).not.toContain('FROM (SELECT DISTINCT "r"."concept_id"');
  });

  test('compileCount counts the deduped membership stream directly', () => {
    const scopedCompiler = makeCompiler({
      includeDebugArtifacts: true,
      scope: { csId: 1, system: 'urn:sys:A', version: null },
    });
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'concept', op: 'is-a', value: 'ROOT' }],
    });

    const compiled = scopedCompiler.compileCount(subtree, { activeOnly: true });

    expect(compiled.sql.text).toContain('COUNT(*)');
    expect(compiled.sql.text).not.toContain('COUNT(DISTINCT');
  });

  test('compileCount uses direct closure counting for single-seed hierarchy filters', () => {
    const scopedCompiler = makeCompiler({
      includeDebugArtifacts: true,
      scope: { csId: 1, system: 'urn:sys:A', version: null },
    });
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'concept', op: 'is-a', value: 'ROOT' }],
    });

    const compiled = scopedCompiler.compileCount(subtree, { activeOnly: true });

    expect(compiled.sql.text).toContain('FROM "closure" "cl"');
    expect(compiled.sql.text).toContain('INNER JOIN "concept" "c" ON ("c"."concept_id" = "cl"."descendant_id")');
    expect(compiled.sql.text).not.toContain('FROM (SELECT DISTINCT "r"."concept_id"');
  });

  test('compileExpand lowers literal property equality without LOWER(COALESCE)', () => {
    const scopedCompiler = makeCompiler({
      includeDebugArtifacts: true,
      scope: { csId: 1, system: 'urn:sys:A', version: null },
    });
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
    });

    const compiled = scopedCompiler.compileExpand(subtree, { count: 10 });

    expect(compiled.sql.text).toContain('"cl"."value_text" COLLATE NOCASE IN');
    expect(compiled.sql.text).toContain('"cl"."value_raw" COLLATE NOCASE IN');
    expect(compiled.sql.text).not.toContain('LOWER(COALESCE');
  });

  test('compileExpand lowers concept-valued property equality without LOWER on target concept fields', () => {
    const scopedCompiler = makeCompiler({
      includeDebugArtifacts: true,
      scope: { csId: 1, system: 'urn:sys:A', version: null },
    });
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CATEGORY', op: '=', value: 'root' }],
    });

    const compiled = scopedCompiler.compileExpand(subtree, { count: 10 });

    expect(compiled.sql.text).toContain('"tgt"."code" COLLATE NOCASE IN');
    expect(compiled.sql.text).toContain('"tgt"."display" COLLATE NOCASE IN');
    expect(compiled.sql.text).not.toContain('LOWER("tgt"."code")');
    expect(compiled.sql.text).not.toContain('LOWER("tgt"."display")');
  });

  test('compileExpand uses concept-driven EXISTS for first-page concept-valued property materialization with text', () => {
    const scopedCompiler = makeCompiler({
      includeDebugArtifacts: true,
      scope: { csId: 1, system: 'urn:sys:A', version: null },
    });
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CATEGORY', op: '=', value: 'root' }],
    });

    const compiled = scopedCompiler.compileExpand(subtree, {
      activeOnly: true,
      text: 'alpha',
      count: 10,
    });

    expect(compiled.sql.text).toContain('FROM "concept" "c"');
    expect(compiled.sql.text).toContain('EXISTS (SELECT 1 AS "found"');
    expect(compiled.sql.text).toContain('MATCH @search_match_');
    expect(compiled.sql.text).not.toContain('FROM (SELECT * FROM (SELECT DISTINCT "r"."source_concept_id"');
  });

  test('compileCount uses concept-driven EXISTS for concept-valued property counting with text', () => {
    const scopedCompiler = makeCompiler({
      includeDebugArtifacts: true,
      scope: { csId: 1, system: 'urn:sys:A', version: null },
    });
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CATEGORY', op: '=', value: 'root' }],
    });

    const compiled = scopedCompiler.compileCount(subtree, {
      activeOnly: true,
      text: 'alpha',
    });

    expect(compiled.sql.text).toContain('FROM "concept" "c"');
    expect(compiled.sql.text).toContain('COUNT(*)');
    expect(compiled.sql.text).toContain('EXISTS (SELECT 1 AS "found"');
    expect(compiled.sql.text).toContain('MATCH @search_match_');
    expect(compiled.sql.text).not.toContain('FROM (SELECT DISTINCT "r"."source_concept_id"');
  });

  test('compileExpand can inline total into offset-0 materialization', () => {
    const scopedCompiler = makeCompiler({
      includeDebugArtifacts: true,
      scope: { csId: 1, system: 'urn:sys:A', version: null },
    });
    const subtree = IR.selector({
      system: 'urn:sys:A',
      shape: 'filter',
      filterClauses: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
    });

    const compiled = scopedCompiler.compileExpand(subtree, { count: 10, includeTotal: true });

    expect(compiled.terminal.includeTotal).toBe(true);
    expect(compiled.sql.text).toContain('WITH');
    expect(compiled.sql.text).toContain('COUNT(*) AS "cnt"');
    expect(compiled.sql.text).toContain('"t"."cnt" AS "total"');
  });
});
