const HIGH_CONFIDENCE_EXPAND_NO_DIFF_IDS = new Set([
  2, 4, 5, 13, 14, 17, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29, 30, 31, 33, 34,
  37, 38, 39, 40, 41, 42, 46, 47, 48, 50, 51, 52, 53, 54, 55, 56, 57, 59, 61,
  62, 63, 64, 65, 66, 67, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82,
  85, 86, 89, 91, 92, 93, 94, 96, 97, 98, 100, 101, 102, 103, 104, 105, 106,
  107, 108, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123,
  124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 135, 136, 138, 139, 140,
  141, 145, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159,
  160, 161, 162, 163, 164, 165, 166, 170, 171, 186, 188, 189, 190,
]);

const HIGH_CONFIDENCE_EXPAND_IR_PREFERRED_IDS = new Set([
  3, 6, 12, 32, 43, 99, 110, 144, 146, 167, 168, 169, 174, 175, 176, 177,
  179, 181, 185, 187, 191, 193, 194, 195, 196, 198, 199, 201,
]);

const REVIEWED_EXPAND_BY_ID = new Map([
    [1, 'Reviewed after adjudication: primary returns the correct full 124-code SNOMED is-a expansion; the local legacy worker truncates the first page to 90 codes.'],
    [7, 'Reviewed after adjudication: primary returns the correct 108-code diabetes-minus-Type2 set; local legacy loses codes due to an exclude+activeOnly interaction bug.'],
    [8, 'Reviewed after adjudication: primary returns the correct diabetes-minus-Type1/Type2 set; local legacy drops codes due to exclude-set assembly bugs.'],
    [9, 'Reviewed after adjudication: primary correctly expands exclude-by-concept ValueSets; upstream/tx.fhir.org crash on this valid request shape.'],
    [10, 'Reviewed after adjudication: local engines correctly apply the SNOMED text filter; tx.fhir.org/upstream ignore filter for this request shape and return the unfiltered diabetes expansion.'],
    [11, 'Reviewed after adjudication: local engines correctly apply the SNOMED text filter; tx.fhir.org/upstream ignore filter for this request shape and return the unfiltered diabetes expansion.'],
    [15, 'Reviewed after IR response fix: paged expansions now clamp omitted offset to 0 instead of emitting the internal -1 sentinel; remaining differences are ordering and optional total metadata.'],
    [24, {
      status: 'deferred',
      reviewedAt: '2026-03-11',
      note: 'Deferred after adjudication: local leniency for SNOMED concept=in with an implicit refset URL is accepted for now, but should be revisited against future policy/spec decisions.',
    }],
    [35, 'Reviewed after IR adapter ordering fix: whole-system paging now preserves provider iteration order for inline/native CodeSystems.'],
    [36, 'Reviewed after adjudication: local engines correctly treat the SNOMED text filter as restricting the returned expansion; tx.fhir.org/upstream report the unfiltered total for this request shape.'],
    [16, 'Reviewed after sqlite-v0 LOINC importer fix: STATUS=ACTIVE filtering now includes active LP part codes.'],
    [18, 'Reviewed after IR SNOMED designation fix: bulk designation decoration now preserves stored non-empty rows regardless of active flag.'],
    [45, 'Reviewed after adjudication: local engines correctly apply the SNOMED text filter; tx.fhir.org/upstream ignore filter for this request shape and return the unfiltered diabetes expansion.'],
    [49, 'Reviewed after IR SNOMED designation fix: includeDesignations now preserves the missing stored synonym rows.'],
    [68, 'Reviewed after IR SNOMED designation fix and sqlite-v0 designation dedupe cleanup.'],
    [69, 'Reviewed after adjudication: IR correctly supports regex filtering on the LOINC STATUS property, which is allowed by the common FHIR filter semantics.'],
    [84, 'Reviewed after adjudication: IR correctly handles compose include/exclude entries that are valueSet-only references; legacy crashes on this valid request shape.'],
    [87, 'Reviewed after adjudication: IR correctly computes imported include/exclude set differences; legacy and tx.fhir.org crash on the same valid request.'],
    [88, 'Reviewed after adjudication: IR correctly paginates a mixed imported+peer include/exclude expansion; legacy crashes instead of returning the requested page.'],
    [90, 'Reviewed after adjudication: IR correctly serves the SNOMED filter=diabetes expansion; upstream/tx.fhir.org crash with a cursor bug and legacy omits total.'],
    [95, 'Reviewed after IR expansion metadata fix: paged expansions now emit expansion.offset=0 and echo the offset parameter.'],
    [109, 'Reviewed after adjudication: IR correctly supports the common FHIR code regex filter for SNOMED in sqlite-v0.'],
    [134, 'Reviewed after IR supplement-property fix: itemWeight now flows through the expansion property pipeline and R4 backport shape.'],
    [137, 'Reviewed after IR UCUM special-enumeration fix: enumeration is served with valueset-unclosed and warning-draft metadata, and unclosed expansions omit total by project policy.'],
    [142, 'Reviewed after policy decision: efficient paginated expansion of large SNOMED pre-coordinated concept sets is acceptable, and IR should not inherit legacy too-costly behavior when it can serve the page cheaply.'],
    [143, 'Reviewed after IR unclosed-total fix: if any branch is unclosed, the aggregate expansion omits total.'],
    [44, 'Reviewed after policy decision: when IR can cheaply serve a deep final page of a large expansion, it should return the real page instead of inheriting legacy too-costly behavior.'],
    [173, 'Reviewed after adjudication: code+regex is a standard common FHIR filter, so IR is correctly supporting the request; third rejects a valid filter and secondary mishandles count=0 on a large result.'],
    [172, 'Reviewed after IR SNOMED designation fix: bulk decoration no longer collapses matching designation rows per concept.'],
    [178, 'Reviewed after adjudication: IR correctly honors count=0 for imported-diff count-only expansion; legacy crashes in filter validation on this valid request shape.'],
    [180, 'Reviewed after adjudication: IR correctly applies runtime text filtering to imported ValueSet diffs; legacy crashes with a value/null bug.'],
    [182, 'Reviewed after adjudication: sqlite-v0 and legacy cs-loinc return the same full STATUS=ACTIVE code set for LOINC; the observed difference is only first-page ordering, because sqlite-v0 pages by code while cs-loinc pages by legacy CodeKey order with parts imported first.'],
    [184, 'Reviewed after policy decision: IR may leniently accept implicit SNOMED refset URLs in concept=in filters even though the strict form is a bare concept id.'],
    [183, 'Reviewed after adjudication: local engines correctly apply the SNOMED text filter; tx.fhir.org/upstream ignore the filter and return unfiltered descendants.'],
    [197, 'Reviewed after IR text-filter alignment: adapter-backed supplement designation filtering now matches the legacy server OR-style token semantics for multi-word filters.'],
    [200, 'Reviewed after policy decision: once a requested supplement resolves successfully, IR may ignore it if it is irrelevant to the actual expansion instead of erroring.'],
    [192, 'Reviewed after adjudication: local engines correctly apply the SNOMED text filter before pagination; tx.fhir.org/upstream ignore the filter and page the unfiltered set.'],
    [315, 'Reviewed after policy decision: generic common filters such as property in should work for LOINC in IR even if upstream does not support them.'],
    [316, 'Reviewed after adjudication: IR and local legacy correctly implement property exists=false; upstream/tx.fhir.org appear to invert the predicate and return rows that do have the property.'],
    [317, 'Reviewed after adjudication: IR correctly supports the standard designation filter semantics, including counting concept.display as a designation.'],
    [318, 'Reviewed after policy decision: designation regex filters should work where IR can support them, even though upstream currently rejects them as unsupported.'],
]);

function withReviewedExpandCase(def) {
  if (def.review) {
    return def;
  }
  const reviewedMeta = REVIEWED_EXPAND_BY_ID.get(def.id);
  if (reviewedMeta) {
    const review = typeof reviewedMeta === 'string'
      ? {
          status: 'reviewed',
          reviewedAt: '2026-03-11',
          note: reviewedMeta,
        }
      : reviewedMeta;
    return {
      ...def,
      review,
    };
  }
  if (HIGH_CONFIDENCE_EXPAND_IR_PREFERRED_IDS.has(def.id)) {
    return {
      ...def,
      review: {
        status: 'reviewed',
        reviewedAt: '2026-03-11',
        note: 'High-confidence batch review: IR behavior preferred in the latest expand adjudication.',
      },
    };
  }
  if (!HIGH_CONFIDENCE_EXPAND_NO_DIFF_IDS.has(def.id)) {
    return def;
  }
  return {
    ...def,
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-11',
      note: 'Batch review: no meaningful semantic difference; remaining divergence was ordering, metadata noise, or other non-semantic variation.',
    },
  };
}

export async function registerExpandCases({ test, helpers, setCategory, log = console.log }) {
  const {
    expand,
    vs,
    withExactTotal,
    codes,
    findCode,
    containsProperties,
    expansionParams,
    hasExpansionParam,
    expansionExtensions,
    setPerfTarget,
    assert,
    eq,
    findParams,
    params,
    inlineVS,
    SYS,
    EXACT_TOTAL_PARAM,
    HARNESS_SQLITE_SUPP_URL_ROOT,
    assertBulkDesignationTrace,
    assertCompilerMaterializationTrace,
    assertCountOnlyTraceBehavior,
    traceHasSpan,
  } = helpers;

  async function expandTest(def, fn) {
    await test({ ...withReviewedExpandCase(def), kind: 'expand' }, fn);
  }

  log('\n=== SNOMED is-a ==='); setCategory('SNOMED is-a');

  await expandTest({ id: 1, rawName: 'is-a Diabetes: 124 codes, includes self+children', name: 'is-a Diabetes: 124 codes, includes self+children', category: 'Subsumption' }, async () => {
    const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 124, 'total');
    assert(findCode(result, '73211009'), 'is-a includes self');
    assert(findCode(result, '44054006'), 'includes Type 2');
    assert(findCode(result, '46635009'), 'includes Type 1');
    assert(codes(result).every(c => c.display?.length > 0), 'all have display');
  });

  await expandTest({ id: 2, rawName: 'descendent-of Diabetes: 123 codes, excludes self', name: 'descendent-of Diabetes: 123 codes, excludes self', category: 'Subsumption' }, async () => {
    const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'descendent-of', value: '73211009' }] }),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 123, 'total');
    assert(!findCode(result, '73211009'), 'descendent-of excludes self');
    assert(findCode(result, '44054006'), 'includes Type 2');
  });

  await expandTest({ id: 3, rawName: 'Clinical finding count=0: total=124412', name: 'Clinical finding count=0: total=124412', category: 'Subsumption' }, async () => {
    const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }),
      { count: 0, activeOnly: true });
    eq(result.expansion.total, 124412, 'total');
    eq(codes(result).length, 0, 'no codes returned');
  });

  await expandTest({ id: 4, rawName: 'Clinical finding first 50: fast with EXISTS pushdown', name: 'Clinical finding first 50: fast with EXISTS pushdown', category: 'Subsumption' }, async () => {
    const { result, ms } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }),
      { count: 50, activeOnly: true });
    eq(result.expansion.total, 124412, 'total');
    eq(codes(result).length, 50, 'page size');
    assert(ms < 500, `expected <500ms, got ${ms.toFixed(0)}ms`);
  });

  log('\n=== Pagination ==='); setCategory('Pagination');

  await expandTest({ id: 5, rawName: 'Diabetes pages are disjoint and reconstruct full set', name: 'Diabetes pages are disjoint and reconstruct full set', category: 'Pagination' }, async () => {
    const allCodes = new Set();
    for (let off = 0; off < 200; off += 30) {
      const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }),
        withExactTotal({ count: 30, offset: off, activeOnly: true }));
      eq(result.expansion.total, 124, 'total stable across pages');
      for (const c of codes(result)) {
        assert(!allCodes.has(c.code), `duplicate code ${c.code} at offset ${off}`);
        allCodes.add(c.code);
      }
    }
    eq(allCodes.size, 124, 'all codes covered');
  });

  await expandTest({ id: 6, rawName: 'LOINC STATUS=ACTIVE high offset (1000,20)', name: 'LOINC STATUS=ACTIVE high offset (1000,20)', category: 'Pagination' }, async () => {
    const { result } = await expand(vs({ system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] }),
      withExactTotal({ count: 20, offset: 1000 }));
    assert(result.expansion.total > 90000, `total ${result.expansion.total}`);
    eq(codes(result).length, 20, 'page size');
  });

  await expandTest({ id: 320, rawName: 'perf: LOINC STATUS=ACTIVE high offset without exact total', name: 'LOINC STATUS=ACTIVE high offset without exact total', category: 'Pagination', perfOnly: true }, async () => {
    const loincActive = vs({ system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] });
    const targetOpts = { count: 20, offset: 1000 };
    const { result, traceJson } = await expand(loincActive, targetOpts, 'ir', true);

    assert(result.expansion.total == null, `best-effort page should omit total, got ${result.expansion.total}`);
    eq(codes(result).length, 20, 'page size');
    assertCompilerMaterializationTrace(traceJson, 'LOINC STATUS=ACTIVE high-offset no-total benchmark');
    assert(!traceHasSpan(traceJson, 'countForIR'), 'no-total benchmark should not do eager count');
    assert(!traceHasSpan(traceJson, 'countForIR:lazy'), 'no-total benchmark should not do lazy count');
    setPerfTarget(loincActive, targetOpts);
  });

  log('\n=== Excludes ==='); setCategory('Excludes');

  await expandTest({ id: 7, rawName: 'Diabetes minus Type2 subtree: 108 codes', name: 'Diabetes minus Type2 subtree: 108 codes', category: 'Exclusions' }, async () => {
    const { result } = await expand(
      vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
         { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] }),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 108, 'total');
    assert(!findCode(result, '44054006'), 'Type 2 excluded');
    assert(findCode(result, '73211009'), 'self remains');
    assert(findCode(result, '46635009'), 'Type 1 remains');
  });

  await expandTest({ id: 8, rawName: 'Diabetes minus Type1+Type2: ~86 codes', name: 'Diabetes minus Type1+Type2: ~86 codes', category: 'Exclusions' }, async () => {
    const { result } = await expand(
      vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
         [{ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
          { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '46635009' }] }]),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 86, 'total');
    assert(!findCode(result, '44054006'), 'Type 2 excluded');
    assert(!findCode(result, '46635009'), 'Type 1 excluded');
    assert(findCode(result, '73211009'), 'self remains');
  });

  await expandTest({ id: 9, rawName: 'Diabetes exclude 2 enumerated codes', name: 'Diabetes exclude 2 enumerated codes', category: 'Exclusions' }, async () => {
    const { result } = await expand(
      vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
         { system: SYS.SCT, concept: [{ code: '44054006' }, { code: '46635009' }] }),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 122, 'total');
    assert(!findCode(result, '44054006'), '44054006 excluded');
    assert(!findCode(result, '46635009'), '46635009 excluded');
    assert(findCode(result, '73211009'), 'self remains');
  });

  log('\n=== Text search ==='); setCategory('Text search');

  await expandTest({ id: 10, rawName: 'is-a Diabetes + text gestational: 8 codes', name: 'is-a Diabetes + text gestational: 8 codes', category: 'Text Search' }, async () => {
    const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }),
      { count: 200, activeOnly: true, filter: 'gestational' });
    eq(result.expansion.total, 8, 'total');
    assert(codes(result).every(c => c.display.toLowerCase().includes('gestational')), 'all match');
  });

  await expandTest({ id: 11, rawName: 'is-a Diabetes + text insulin: results match text', name: 'is-a Diabetes + text insulin: results match text', category: 'Text Search' }, async () => {
    const { result } = await expand(vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }),
      { count: 200, activeOnly: true, filter: 'insulin' });
    assert(result.expansion.total > 10, `total ${result.expansion.total}`);
    // FTS may match on designations not just display — just check we get results
    assert(codes(result).length > 0, 'has results');
  });

  await expandTest({ id: 12, rawName: 'LOINC text creatinine first 20', name: 'LOINC text creatinine first 20', category: 'Text Search' }, async () => {
    const { result } = await expand(vs({ system: SYS.LOINC }),
      { count: 20, filter: 'creatinine' });
    assert(codes(result).length > 0, 'has results');
    assert(codes(result).length <= 20, 'respects count');
  });

  await expandTest({ id: 319, rawName: 'LOINC text filter honors activeOnly=false for enumerated inactive concepts', name: 'LOINC text filter honors activeOnly=false for enumerated inactive concepts', category: 'Text Search' }, async () => {
    const { result } = await expand(vs({
      system: SYS.LOINC,
      concept: [
        { code: '11214-4' },
        { code: '12571-6' },
        { code: '13445-2' },
        { code: '14400-6' },
      ],
    }), {
      count: 20,
      activeOnly: false,
      filter: 'Deprecated',
    });
    eq(result.expansion.total, 4, 'total');
    assert(findCode(result, '11214-4'), 'includes inactive code 11214-4');
    assert(findCode(result, '12571-6'), 'includes inactive code 12571-6');
    assert(findCode(result, '13445-2'), 'includes inactive code 13445-2');
    assert(findCode(result, '14400-6'), 'includes inactive code 14400-6');
  });

  await expandTest({ id: 13, rawName: 'RxNorm text aspirin + TTY=IN: finds aspirin 1191', name: 'RxNorm text aspirin + TTY=IN: finds aspirin 1191', category: 'Text Search' }, async () => {
    const { result } = await expand(vs({ system: SYS.RXNORM, filter: [{ property: 'TTY', op: '=', value: 'IN' }] }),
      { count: 20, filter: 'aspirin' });
    assert(findCode(result, '1191'), 'aspirin 1191 present');
  });

  log('\n=== Property filters ==='); setCategory('Property filters');

  await expandTest({ id: 14, rawName: 'RxNorm TTY=IN first 50', name: 'RxNorm TTY=IN first 50', category: 'Property Filters' }, async () => {
    const { result } = await expand(vs({ system: SYS.RXNORM, filter: [{ property: 'TTY', op: '=', value: 'IN' }] }),
      { count: 50 });
    assert(result.expansion.total > 14000, `total ${result.expansion.total}`);
    eq(codes(result).length, 50, 'page size');
    assert(codes(result).every(c => c.display?.length > 0), 'all have display');
  });

  await expandTest({ id: 15, rawName: 'LOINC CLASSTYPE=1 first 50: ~66K total', name: 'LOINC CLASSTYPE=1 first 50: ~66K total', category: 'Property Filters' }, async () => {
    const { result } = await expand(vs({ system: SYS.LOINC, filter: [{ property: 'CLASSTYPE', op: '=', value: '1' }] }),
      { count: 50 });
    assert(result.expansion.total > 60000, `total ${result.expansion.total}`);
    eq(codes(result).length, 50, 'page size');
    assert(result.expansion.offset === 0, `expected expansion.offset=0, got ${result.expansion.offset}`);
    const offsetP = findParams(result, 'offset')[0];
    assert(offsetP?.valueInteger === 0, `expected offset param=0, got ${offsetP?.valueInteger}`);
  });

  await expandTest({ id: 16, rawName: 'LOINC STATUS=ACTIVE first 20: ~96K total', name: 'LOINC STATUS=ACTIVE first 20: ~96K total', category: 'Property Filters' }, async () => {
    const { result } = await expand(vs({ system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] }),
      { count: 20 });
    assert(result.expansion.total > 90000, `total ${result.expansion.total}`);
    eq(codes(result).length, 20, 'page size');
  });

  await expandTest({ id: 321, rawName: 'perf: LOINC CLASSTYPE=1 later page without exact total', name: 'LOINC CLASSTYPE=1 later page without exact total', category: 'Property Filters', perfOnly: true }, async () => {
    const loincClassType = vs({ system: SYS.LOINC, filter: [{ property: 'CLASSTYPE', op: '=', value: '1' }] });
    const targetOpts = { count: 50, offset: 1000 };
    const { result, traceJson } = await expand(loincClassType, targetOpts, 'ir', true);

    assert(result.expansion.total == null, `best-effort page should omit total, got ${result.expansion.total}`);
    eq(codes(result).length, 50, 'page size');
    assertCompilerMaterializationTrace(traceJson, 'LOINC CLASSTYPE later-page no-total benchmark');
    assert(!traceHasSpan(traceJson, 'countForIR'), 'no-total benchmark should not do eager count');
    assert(!traceHasSpan(traceJson, 'countForIR:lazy'), 'no-total benchmark should not do lazy count');
    setPerfTarget(loincClassType, targetOpts);
  });

  await expandTest({ id: 322, rawName: 'perf: LOINC text creatinine later page without exact total', name: 'LOINC text creatinine later page without exact total', category: 'Text Search', perfOnly: true }, async () => {
    const loincAll = vs({ system: SYS.LOINC });
    const targetOpts = { count: 20, offset: 1000, filter: 'creatinine' };
    const { result, traceJson } = await expand(loincAll, targetOpts, 'ir', true);

    assert(result.expansion.total == null, `best-effort page should omit total, got ${result.expansion.total}`);
    assert(codes(result).length <= 20, 'respects count');
    assertCompilerMaterializationTrace(traceJson, 'LOINC creatinine later-page no-total benchmark');
    assert(!traceHasSpan(traceJson, 'countForIR'), 'no-total benchmark should not do eager count');
    assert(!traceHasSpan(traceJson, 'countForIR:lazy'), 'no-total benchmark should not do lazy count');
    setPerfTarget(loincAll, targetOpts);
  });

  await expandTest({ id: 315, rawName: 'common-filter: sqlite-v0 property in matches ACTIVE and DEPRECATED LOINC status', name: 'SQLite v0 property in matches ACTIVE and DEPRECATED LOINC status', category: 'Property Filters' }, async () => {
    const { result } = await expand(vs({
      system: SYS.LOINC,
      filter: [{ property: 'STATUS', op: 'in', value: 'ACTIVE,DEPRECATED' }],
    }), { count: 5000 });
    assert(result.expansion.total > 100000, `expected large ACTIVE/DEPRECATED total, got ${result.expansion.total}`);
    assert(findCode(result, '1-8'), 'ACTIVE exemplar 1-8 should be present');
    assert(findCode(result, '1009-0'), 'DEPRECATED exemplar 1009-0 should be present');
  });

  await expandTest({ id: 316, rawName: 'common-filter: sqlite-v0 property exists partitions LOINC METHOD_TYP', name: 'SQLite v0 property exists partitions LOINC METHOD_TYP', category: 'Property Filters' }, async () => {
    const { result: existsTrue } = await expand(vs({
      system: SYS.LOINC,
      filter: [{ property: 'METHOD_TYP', op: 'exists', value: 'true' }],
    }), { count: 50 });
    assert(existsTrue.expansion.total > 50000, `expected many METHOD_TYP rows, got ${existsTrue.expansion.total}`);
    assert(findCode(existsTrue, '10-9'), 'METHOD_TYP=true should include 10-9');
    assert(!findCode(existsTrue, '1-8'), 'METHOD_TYP=true should exclude 1-8');

    const { result: existsFalse } = await expand(vs({
      system: SYS.LOINC,
      filter: [{ property: 'METHOD_TYP', op: 'exists', value: 'false' }],
    }), { count: 50 });
    assert(existsFalse.expansion.total > 100000, `expected many METHOD_TYP-missing rows, got ${existsFalse.expansion.total}`);
    assert(findCode(existsFalse, '1-8'), 'METHOD_TYP=false should include 1-8');
    assert(!findCode(existsFalse, '10-9'), 'METHOD_TYP=false should exclude 10-9');
  });

  await expandTest({ id: 317, rawName: 'common-filter: designation equals counts display as designation via IR adapter', name: 'designation = counts display as a designation via IR adapter', category: 'Property Filters' }, async () => {
    const cs = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/cs/common-designation-equals',
      status: 'active',
      content: 'complete',
      concept: [
        { code: 'alpha', display: 'Alpha Base' },
        { code: 'beta', display: 'Beta Base', designation: [{ language: 'de', value: 'Beta Deutsch' }] },
      ],
    };
    const { result } = await expand(vs({
      system: cs.url,
      filter: [{ property: 'designation', op: '=', value: 'Alpha Base' }],
    }), { txResources: [cs] });
    eq(result.expansion.total, 1, 'total');
    assert(findCode(result, 'alpha'), 'display-backed designation match should include alpha');
    assert(!findCode(result, 'beta'), 'designation exact match should exclude beta');
  });

  await expandTest({ id: 318, rawName: 'common-filter: designation regex matches explicit designations via IR adapter', name: 'designation regex matches explicit designations via IR adapter', category: 'Property Filters' }, async () => {
    const cs = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/cs/common-designation-regex',
      status: 'active',
      content: 'complete',
      concept: [
        { code: 'alpha', display: 'Alpha Base' },
        { code: 'beta', display: 'Beta Base', designation: [{ language: 'de', value: 'Beta Deutsch' }] },
      ],
    };
    const { result } = await expand(vs({
      system: cs.url,
      filter: [{ property: 'designation', op: 'regex', value: '.*Deutsch' }],
    }), { txResources: [cs] });
    eq(result.expansion.total, 1, 'total');
    assert(findCode(result, 'beta'), 'designation regex should match explicit designation on beta');
    assert(!findCode(result, 'alpha'), 'designation regex should exclude alpha');
  });

  log('\n=== Concept enumeration ==='); setCategory('Concept enum');

  await expandTest({ id: 17, rawName: 'SNOMED 3 codes: correct displays', name: 'SNOMED 3 codes: correct displays', category: 'Concept Enumerations' }, async () => {
    const { result } = await expand(vs({ system: SYS.SCT, concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }] }));
    eq(result.expansion.total, 3, 'total');
    // v0 provider returns preferred term; cs-snomed returns FSN without suffix
    assert(findCode(result, '73211009')?.display?.startsWith('Diabetes mellitus'), 'DM display');
  });

  await expandTest({ id: 18, rawName: 'SNOMED enum + designations', name: 'SNOMED enum + designations', category: 'Concept Enumerations' }, async () => {
    const { result } = await expand(vs({ system: SYS.SCT, concept: [{ code: '73211009' }] }),
      { includeDesignations: true });
    const entry = findCode(result, '73211009');
    assert(entry?.designation?.length > 0, 'has designations');
    assert(entry.designation.some(d => d.value === 'Diabetes mellitus, NOS'),
      'includes inactive-but-stored SNOMED synonym "Diabetes mellitus, NOS"');
  });

  log('\n=== Whole-system (cs-cs / legacy adapter) ==='); setCategory('Whole-system');

  await expandTest({ id: 19, rawName: 'gender whole-system: 4 codes', name: 'gender whole-system: 4 codes', category: 'Single-System Composition' }, async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }));
    eq(result.expansion.total, 4, 'total');
    assert(findCode(result, 'male')?.display === 'Male', 'male');
    assert(findCode(result, 'female')?.display === 'Female', 'female');
    assert(findCode(result, 'other')?.display === 'Other', 'other');
    assert(findCode(result, 'unknown')?.display === 'Unknown', 'unknown');
  });

  await expandTest({ id: 20, rawName: 'gender enumerated subset: male+female only', name: 'gender enumerated subset: male+female only', category: 'Single-System Composition' }, async () => {
    const { result } = await expand(vs({ system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] }));
    eq(result.expansion.total, 2, 'total');
    assert(findCode(result, 'male'), 'male present');
    assert(!findCode(result, 'unknown'), 'unknown absent');
  });

  await expandTest({ id: 21, rawName: 'gender exclude: minus other+unknown = male+female', name: 'gender exclude: minus other+unknown = male+female', category: 'Single-System Composition' }, async () => {
    const { result } = await expand(
      vs({ system: SYS.GENDER },
         { system: SYS.GENDER, concept: [{ code: 'other' }, { code: 'unknown' }] }));
    eq(result.expansion.total, 2, 'total');
    assert(findCode(result, 'male'), 'male remains');
    assert(findCode(result, 'female'), 'female remains');
    assert(!findCode(result, 'other'), 'other excluded');
    assert(!findCode(result, 'unknown'), 'unknown excluded');
  });

  await expandTest({ id: 22, rawName: 'LOINC enumerated: 2160-0 + 2345-7', name: 'LOINC enumerated: 2160-0 + 2345-7', category: 'Single-System Composition' }, async () => {
    const { result } = await expand(vs({ system: SYS.LOINC, concept: [{ code: '2160-0' }, { code: '2345-7' }] }));
    eq(result.expansion.total, 2, 'total');
    assert(findCode(result, '2160-0')?.display?.includes('Creatinine'), 'Creatinine');
    assert(findCode(result, '2345-7')?.display?.includes('Glucose'), 'Glucose');
  });

  await expandTest({ id: 23, rawName: 'RxNorm enumerated: aspirin + ibuprofen + acetaminophen', name: 'RxNorm enumerated: aspirin + ibuprofen + acetaminophen', category: 'Single-System Composition' }, async () => {
    const { result } = await expand(vs({ system: SYS.RXNORM, concept: [{ code: '161' }, { code: '5640' }, { code: '1191' }] }));
    eq(result.expansion.total, 3, 'total');
    assert(findCode(result, '1191')?.display === 'aspirin', 'aspirin');
    assert(findCode(result, '5640')?.display === 'ibuprofen', 'ibuprofen');
    assert(findCode(result, '161')?.display === 'acetaminophen', 'acetaminophen');
  });

  await expandTest({ id: 24, rawName: 'SNOMED concept-in refset 723560006: 19 top-level categories', name: 'SNOMED concept-in refset 723560006: 19 top-level categories', category: 'Single-System Composition' }, async () => {
    const { result } = await expand(vs({ system: SYS.SCT,
      filter: [{ property: 'concept', op: 'in', value: 'http://snomed.info/sct?fhir_vs=refset/723560006' }] }));
    eq(result.expansion.total, 19, 'total');
    assert(findCode(result, '404684003'), 'Clinical finding');
    assert(findCode(result, '71388002'), 'Procedure');
    assert(findCode(result, '123037004'), 'Body structure');
  });

  await expandTest({ id: 25, rawName: 'same-system dedup: gender male+female \u222a female+other = 3', name: 'Same-system dedup returns 3 unique gender codes', category: 'Single-System Composition' }, async () => {
    const { result } = await expand(vs([
      { system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] },
      { system: SYS.GENDER, concept: [{ code: 'female' }, { code: 'other' }] },
    ]));
    eq(result.expansion.total, 3, 'total (female deduped)');
    assert(findCode(result, 'male'), 'male');
    assert(findCode(result, 'female'), 'female');
    assert(findCode(result, 'other'), 'other');
  });

  await expandTest({ id: 26, rawName: 'cross-system exclude: gender+pubstat minus both unknowns = 6', name: 'Cross-system exclude removes unknown from both systems', category: 'Single-System Composition' }, async () => {
    const { result } = await expand(vs(
      [{ system: SYS.GENDER }, { system: SYS.PUBSTAT }],
      [{ system: SYS.GENDER, concept: [{ code: 'unknown' }] },
       { system: SYS.PUBSTAT, concept: [{ code: 'unknown' }] }]));
    eq(result.expansion.total, 6, 'total');
    assert(!codes(result).some(c => c.code === 'unknown'), 'no unknowns');
    eq(codes(result).filter(c => c.system === SYS.GENDER).length, 3, 'gender count');
    eq(codes(result).filter(c => c.system === SYS.PUBSTAT).length, 3, 'pubstat count');
  });

  await expandTest({ id: 27, rawName: 'text filter across cs-cs systems: gender+pubstat filter=unknown', name: 'Text filter across single-system peers (gender + publication-status)', category: 'Single-System Composition' }, async () => {
    const { result } = await expand(vs([{ system: SYS.GENDER }, { system: SYS.PUBSTAT }]),
      { filter: 'unknown' });
    assert(codes(result).length >= 2, 'at least 2 matches');
    const systems = new Set(codes(result).map(c => c.system));
    eq(systems.size, 2, 'matches from both systems');
  });

  log('\n=== Multi-system ==='); setCategory('Multi-system');

  await expandTest({ id: 28, rawName: 'SNOMED+LOINC+RxNorm enum: 3 codes, 3 systems', name: 'SNOMED+LOINC+RxNorm enum: 3 codes, 3 systems', category: 'Multi-System Composition' }, async () => {
    const { result } = await expand(vs([
      { system: SYS.SCT, concept: [{ code: '73211009' }] },
      { system: SYS.LOINC, concept: [{ code: '2160-0' }] },
      { system: SYS.RXNORM, concept: [{ code: '1191' }] },
    ]));
    eq(result.expansion.total, 3, 'total');
    const systems = new Set(codes(result).map(c => c.system));
    eq(systems.size, 3, 'system count');
    assert(findCode(result, '1191')?.display === 'aspirin', 'RxNorm display');
  });

  await expandTest({ id: 29, rawName: 'Mixed v0+cs-cs: gender (4) + SNOMED enum (1) = 5', name: 'Mixed SQLite v0 + single-system peer: gender (4) + SNOMED enum (1) = 5', category: 'Multi-System Composition' }, async () => {
    const { result, ms } = await expand(vs([
      { system: 'http://hl7.org/fhir/administrative-gender' },
      { system: SYS.SCT, concept: [{ code: '73211009' }] },
    ]));
    eq(result.expansion.total, 5, 'total');
    const systems = new Set(codes(result).map(c => c.system));
    eq(systems.size, 2, 'system count');
    assert(findCode(result, 'male')?.display === 'Male', 'gender display');
    assert(findCode(result, '73211009')?.display?.startsWith('Diabetes mellitus'), 'SNOMED display');
  });

  await expandTest({ id: 30, rawName: 'Mixed v0+cs-cs: gender (4) + SNOMED is-a (124), stride across boundary', name: 'Mixed SQLite v0 + single-system peer: gender (4) + SNOMED is-a (124)', category: 'Multi-System Composition' }, async () => {
    // Canonical order: gender first (http://hl7...), SNOMED second (http://snomed...)
    // offset=2 count=5 → 2 gender + 3 SNOMED
    const { result } = await expand(vs([
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: 'http://hl7.org/fhir/administrative-gender' },
    ]), { count: 5, offset: 2, activeOnly: true });
    eq(result.expansion.total, 128, 'total');
    eq(codes(result).length, 5, 'page size');
    const systems = new Set(codes(result).map(c => c.system));
    eq(systems.size, 2, 'page spans both systems');
  });

  await expandTest({ id: 31, rawName: 'Mixed v0+cs-cs + text filter', name: 'Mixed SQLite v0 + single-system peer with text filter', category: 'Multi-System Composition' }, async () => {
    const { result } = await expand(vs([
      { system: 'http://hl7.org/fhir/administrative-gender' },
      { system: SYS.SCT, concept: [{ code: '73211009' }, { code: '44054006' }] },
    ]), { filter: 'male' });
    // 'male' matches gender code; SNOMED diabetes doesn't match
    assert(findCode(result, 'male'), 'male found');
    assert(codes(result).length >= 1, 'at least male');
  });

  await expandTest({ id: 32, rawName: 'Multi-system stride pagination', name: 'Stride pagination crosses system boundaries correctly', category: 'Multi-System Composition' }, async () => {
    // Pick an offset that straddles the true canonical boundary between the 2 systems.
    const sctBranch = { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] };
    const loincBranch = { system: SYS.LOINC, filter: [{ property: 'CLASSTYPE', op: '=', value: '1' }] };
    const { result: sctCountRes } = await expand(vs(sctBranch), { count: 0, activeOnly: true });
    const { result: loincCountRes } = await expand(vs(loincBranch), { count: 0, activeOnly: true });
    const counts = {
      [SYS.SCT]: sctCountRes.expansion.total,
      [SYS.LOINC]: loincCountRes.expansion.total,
    };
    const ordered = [SYS.SCT, SYS.LOINC].sort();
    const firstCount = counts[ordered[0]];
    // Window of 10 crossing the boundary: 4 from first system + 6 from second.
    const offset = Math.max(firstCount - 4, 0);

    const query = vs([sctBranch, loincBranch]);
    const { result } = await expand(query, { count: 10, offset, activeOnly: true });
    eq(codes(result).length, 10, 'page size');
    const systems = new Set(codes(result).map(c => c.system));
    // Should span the boundary between the two systems
    eq(systems.size, 2, 'page spans both systems');
    assert(result.expansion.total > 60000, `total ${result.expansion.total}`);
  });

  // ── meta: expansion parameters ──────────────────────────────────────────
  log('\n=== Meta ==='); setCategory('Meta');

  await expandTest({ id: 33, rawName: 'meta: multi-system emits used-codesystem for each system', name: 'usedCodeSystem emitted once per system in multi-system expansion', category: 'Expansion Metadata' }, async () => {
    const { result } = await expand(vs([
      { system: SYS.GENDER, concept: [{ code: 'male' }] },
      { system: SYS.PUBSTAT, concept: [{ code: 'active' }] },
    ]));
    const usedCs = findParams(result, 'used-codesystem').map(p => p.valueUri || '');
    assert(usedCs.some(v => v.startsWith(SYS.GENDER)), 'gender in used-codesystem');
    assert(usedCs.some(v => v.startsWith(SYS.PUBSTAT)), 'pubstat in used-codesystem');
  });

  await expandTest({ id: 34, rawName: 'meta: used-codesystem dedupes repeated same-system', name: 'usedCodeSystem deduplicates repeated references to one system', category: 'Expansion Metadata' }, async () => {
    const { result } = await expand(vs([
      { system: SYS.GENDER, concept: [{ code: 'male' }, { code: 'female' }] },
      { system: SYS.GENDER, concept: [{ code: 'other' }] },
    ]));
    const usedCs = findParams(result, 'used-codesystem')
      .filter(p => typeof p.valueUri === 'string' && p.valueUri.startsWith(SYS.GENDER));
    eq(usedCs.length, 1, 'exactly 1 used-codesystem for gender');
  });

  await expandTest({ id: 35, rawName: 'meta: offset/count are echoed in expansion parameters', name: 'offset and count echoed in expansion parameters', category: 'Expansion Metadata' }, async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }), { count: 2, offset: 1 });
    const offsetP = findParams(result, 'offset')[0];
    const countP = findParams(result, 'count')[0];
    assert(offsetP?.valueInteger === 1, `expected offset=1, got ${offsetP?.valueInteger}`);
    assert(countP?.valueInteger === 2, `expected count=2, got ${countP?.valueInteger}`);
    assert(
      JSON.stringify(codes(result).map((concept) => concept.code)) === JSON.stringify(['female', 'other']),
      `paged codes preserve provider iteration order: expected female,other, got ${codes(result).map((concept) => concept.code).join(',')}`
    );
  });

  await expandTest({ id: 36, rawName: 'meta: text filter is echoed in expansion parameters', name: 'text filter is echoed in expansion parameters', category: 'Expansion Metadata' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    }), { filter: 'mell', count: 5, activeOnly: true });
    const filterP = findParams(result, 'filter')[0];
    eq(filterP?.valueString, 'mell', 'filter echoed');
  });

  await expandTest({ id: 37, rawName: 'meta: v0 used-codesystem includes version', name: 'SQLite v0 usedCodeSystem includes version', category: 'Expansion Metadata' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT, concept: [{ code: '73211009' }],
    }));
    const usedCs = findParams(result, 'used-codesystem').map(p => p.valueUri || '');
    const sctEntry = usedCs.find(v => v.startsWith(SYS.SCT));
    assert(sctEntry, 'SNOMED in used-codesystem');
    assert(/^http:\/\/snomed\.info\/sct\|http:\/\/snomed\.info\/sct\/.+\/version\/\d{8}$/.test(sctEntry),
      `expected SNOMED used-codesystem in system|canonical-version-uri form, got ${sctEntry}`);

    // LOINC uses a numeric/dotted version token (e.g. 2.81).
    const { result: loincResult } = await expand(vs({
      system: SYS.LOINC, concept: [{ code: '2160-0' }],
    }));
    const loincUsed = findParams(loincResult, 'used-codesystem').map(p => p.valueUri || '');
    const loincEntry = loincUsed.find(v => v.startsWith(SYS.LOINC));
    assert(loincEntry, 'LOINC in used-codesystem');
    const loincVersion = loincEntry.slice((`${SYS.LOINC}|`).length);
    assert(/^\d+(?:\.\d+)*$/.test(loincVersion),
      `expected LOINC numeric/dotted version token, got ${loincVersion}`);

    // RxNorm uses a non-URI token version (typically numeric/date-like).
    const { result: rxResult } = await expand(vs({
      system: SYS.RXNORM, concept: [{ code: '1191' }],
    }));
    const rxUsed = findParams(rxResult, 'used-codesystem').map(p => p.valueUri || '');
    const rxEntry = rxUsed.find(v => v.startsWith(SYS.RXNORM));
    assert(rxEntry, 'RxNorm in used-codesystem');
    const rxVersion = rxEntry.slice((`${SYS.RXNORM}|`).length);
    assert(/^[0-9][0-9A-Za-z._-]*$/.test(rxVersion),
      `expected RxNorm token version, got ${rxVersion}`);
  });

  // ── vs-import ────────────────────────────────────────────────────────
  log('\n=== ValueSet imports ==='); setCategory('VS import');

  await expandTest({ id: 38, rawName: 'vs-import: pure import of administrative-gender', name: 'Pure ValueSet import of administrative-gender', category: 'ValueSet Imports' }, async () => {
    const { result } = await expand(vs({ valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'] }));
    eq(result.expansion.total, 4, 'total');
    assert(findCode(result, 'male'), 'male');
    assert(findCode(result, 'female'), 'female');
    assert(findCode(result, 'other'), 'other');
    assert(findCode(result, 'unknown'), 'unknown');
  });

  await expandTest({ id: 39, rawName: 'vs-import: system + valueSet intersection', name: 'System and ValueSet intersection', category: 'ValueSet Imports' }, async () => {
    const { result } = await expand(vs({
      system: SYS.GENDER,
      concept: [{ code: 'male' }, { code: 'female' }, { code: 'other' }],
      valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'],
    }));
    eq(result.expansion.total, 3, 'intersection total');
    assert(findCode(result, 'male'), 'male in intersection');
    assert(findCode(result, 'female'), 'female in intersection');
    assert(findCode(result, 'other'), 'other in intersection');
    assert(!findCode(result, 'unknown'), 'unknown not in intersection');
  });

  // ── pagination-safety ──────────────────────────────────────────────
  log('\n=== Pagination safety ==='); setCategory('Pagination safety');

  await expandTest({ id: 40, rawName: 'pagination-safety: mixed v0+cs-cs reconstruct full set', name: 'Mixed SQLite v0 + single-system peer reconstructs full set', category: 'Pagination Safety' }, async () => {
    const query = vs([
      { system: SYS.GENDER },
      { system: SYS.SCT, concept: [{ code: '73211009' }] },
    ]);
    const allCodes = new Set();
    for (let off = 0; off < 10; off += 2) {
      const { result } = await expand(query, { count: 2, offset: off });
      eq(result.expansion.total, 5, `total stable at offset ${off}`);
      for (const c of codes(result)) {
        assert(!allCodes.has(c.code), `dup ${c.code} at offset ${off}`);
        allCodes.add(c.code);
      }
    }
    eq(allCodes.size, 5, 'all codes covered');
  });

  await expandTest({ id: 41, rawName: 'pagination-safety: v0 filter+cs-cs pages are disjoint', name: 'SQLite v0 filter + single-system peer pages are disjoint', category: 'Pagination Safety' }, async () => {
    const query = vs([
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: SYS.GENDER },
    ]);
    const allCodes = new Set();
    const pageSize = 20;
    for (let off = 0; off < 128; off += pageSize) {
      const { result } = await expand(query, { count: pageSize, offset: off, activeOnly: true });
      eq(result.expansion.total, 128, `total stable at offset ${off}`);
      for (const c of codes(result)) {
        assert(!allCodes.has(`${c.system}|${c.code}`), `dup ${c.code} at offset ${off}`);
        allCodes.add(`${c.system}|${c.code}`);
      }
    }
    eq(allCodes.size, 128, 'all codes covered without gaps');
  });

  await expandTest({ id: 42, rawName: 'pagination-safety: offset beyond end returns empty', name: 'Offset beyond end returns empty page', category: 'Pagination Safety' }, async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }), withExactTotal({ count: 10, offset: 100 }));
    eq(result.expansion.total, 4, 'total');
    eq(codes(result).length, 0, 'no codes past end');
  });

  await expandTest({ id: 43, rawName: 'pagination-safety: deep offset 110K into 124K set returns 10K codes', name: 'Deep offset into 124K set returns expected 10K page', category: 'Pagination Safety' }, async () => {
    const { result, ms } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    }), withExactTotal({ count: 10000, offset: 110000, activeOnly: true }));
    eq(result.expansion.total, 124412, 'total');
    eq(codes(result).length, 10000, 'page size');
    assert(codes(result).every(c => c.code && c.display), 'all have code+display');
    // Verify codes are sorted (pagination determinism)
    const sorted = codes(result).map(c => c.code);
    const expected = [...sorted].sort();
    assert(JSON.stringify(sorted) === JSON.stringify(expected), 'codes are sorted');
  });

  await expandTest({ id: 44, rawName: 'pagination-safety: last page of 124K set is partial', name: 'Last page of large expansion is partial', category: 'Pagination Safety' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    }), withExactTotal({ count: 10000, offset: 120000, activeOnly: true }));
    eq(result.expansion.total, 124412, 'total');
    eq(codes(result).length, 4412, 'partial last page');
  });

  // ── combined ─────────────────────────────────────────────────────────
  log('\n=== Combined ==='); setCategory('Combined');

  await expandTest({ id: 45, rawName: 'combined: SNOMED is-a + text filter', name: 'SNOMED is-a combined with text filter', category: 'Composition Semantics' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    }), { filter: 'insulin', activeOnly: true });
    assert(codes(result).length > 0, 'has results');
    assert(codes(result).every(c => c.system === SYS.SCT), 'all SNOMED');
  });

  await expandTest({ id: 46, rawName: 'combined: include filter + exclude filter same system', name: 'Include and exclude filters combine within one system', category: 'Composition Semantics' }, async () => {
    const { result } = await expand(
      vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
         [{ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
          { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '46635009' }] }]),
      { count: 200, activeOnly: true });
    eq(result.expansion.total, 86, 'Diabetes minus Type1+Type2');
    assert(!findCode(result, '44054006'), 'Type2 excluded');
    assert(!findCode(result, '46635009'), 'Type1 excluded');
  });

  await expandTest({ id: 47, rawName: 'combined: enumerated + text filter', name: 'Enumerated include combined with text filter', category: 'Composition Semantics' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      concept: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }],
    }), { filter: 'type' });
    assert(codes(result).length >= 1, 'at least 1 match');
    assert(codes(result).every(c => c.display.toLowerCase().includes('type')), 'all match text');
  });

  await expandTest({ id: 48, rawName: 'combined: multi-system + exclude + pagination', name: 'Multi-system expansion with exclude remains pagination-safe', category: 'Composition Semantics' }, async () => {
    const query = vs(
      [{ system: SYS.GENDER }, { system: SYS.PUBSTAT }],
      [{ system: SYS.GENDER, concept: [{ code: 'unknown' }] },
       { system: SYS.PUBSTAT, concept: [{ code: 'unknown' }] }]);
    const allCodes = new Set();
    for (let off = 0; off < 6; off += 2) {
      const { result } = await expand(query, { count: 2, offset: off });
      eq(result.expansion.total, 6, `total at offset ${off}`);
      for (const c of codes(result)) {
        assert(c.code !== 'unknown', `unknown at offset ${off}`);
        allCodes.add(`${c.system}|${c.code}`);
      }
    }
    eq(allCodes.size, 6, 'all 6 codes covered');
  });

  // ── lang / designations ───────────────────────────────────────────
  log('\n=== Designations ==='); setCategory('Designations');

  await expandTest({ id: 49, rawName: 'lang: SNOMED includeDesignations returns entries', name: 'SNOMED includeDesignations returns designation entries', category: 'Designations & Language' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT, concept: [{ code: '73211009' }],
    }), { includeDesignations: true });
    const entry = findCode(result, '73211009');
    assert(entry?.designation?.length > 0, 'has designations');
    assert(entry.designation.every(d => d.value?.length > 0), 'all have value');
    assert(entry.designation.some(d => d.value === 'Diabetes mellitus, NOS'),
      'includes inactive-but-stored SNOMED synonym "Diabetes mellitus, NOS"');
  });

  await expandTest({ id: 50, rawName: 'lang: SNOMED is-a filter includeDesignations', name: 'SNOMED is-a filter with includeDesignations', category: 'Designations & Language' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    }), { count: 5, activeOnly: true, includeDesignations: true });
    assert(codes(result).length > 0, 'has results');
    assert(codes(result).every(c => c.designation?.length > 0), 'all have designations');
  });

  await expandTest({ id: 51, rawName: 'lang: LOINC includeDesignations returns entries', name: 'LOINC includeDesignations returns designation entries', category: 'Designations & Language' }, async () => {
    const { result } = await expand(vs({
      system: SYS.LOINC, concept: [{ code: '2160-0' }],
    }), { includeDesignations: true });
    const entry = findCode(result, '2160-0');
    assert(entry?.designation?.length > 0, 'has designations');
  });

  // ── Expansion metadata & canonical status warnings ───────────────────
  log('\n── Expansion metadata & canonical status warnings ──');

  // Helper: build a complete inline CodeSystem
  function inlineCS(url, overrides = {}) {
    return {
      resourceType: 'CodeSystem',
      url,
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [
        { code: 'A', display: 'Alpha' },
        { code: 'B', display: 'Bravo' },
        { code: 'C', display: 'Charlie' },
      ],
      ...overrides,
    };
  }

  // Helper: build a VS referencing an inline CS
  function vsForCS(csUrl) {
    return {
      resourceType: 'ValueSet',
      url: 'http://example.org/test-vs',
      status: 'active',
      compose: { include: [{ system: csUrl }] },
    };
  }

  await expandTest({ id: 52, rawName: 'meta: used-codesystem emitted for single system', name: 'usedCodeSystem emitted for single-system expansion', category: 'Expansion Metadata' }, async () => {
    const cs = inlineCS('http://example.org/cs/meta-used-1');
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    const usedParams = expansionParams(result, 'used-codesystem');
    assert(usedParams.length >= 1, 'expected at least one used-codesystem parameter');
    assert(usedParams.some(p => p.valueUri?.includes('example.org/cs/meta-used-1')),
      `used-codesystem should reference the inline CS, got: ${JSON.stringify(usedParams)}`);
  });

  await expandTest({ id: 53, rawName: 'meta: used-codesystem emitted for multi-system', name: 'usedCodeSystem emitted for multi-system expansion', category: 'Expansion Metadata' }, async () => {
    const cs1 = inlineCS('http://example.org/cs/multi-1');
    const cs2 = inlineCS('http://example.org/cs/multi-2', {
      concept: [{ code: 'X', display: 'Xray' }],
    });
    const vsJson = {
      resourceType: 'ValueSet',
      url: 'http://example.org/test-vs-multi',
      status: 'active',
      compose: { include: [
        { system: cs1.url },
        { system: cs2.url },
      ] },
    };
    const { result } = await expand(vsJson, { txResources: [cs1, cs2] });
    assert(codes(result).length === 4, `expected 4 codes, got ${codes(result).length}`);
    const usedParams = expansionParams(result, 'used-codesystem');
    assert(usedParams.some(p => p.valueUri?.includes('multi-1')),
      'should record cs/multi-1');
    assert(usedParams.some(p => p.valueUri?.includes('multi-2')),
      'should record cs/multi-2');
  });

  await expandTest({ id: 54, rawName: 'meta: warning-draft for draft CodeSystem', name: 'Draft CodeSystem emits warning for non-draft ValueSet', category: 'Expansion Metadata' }, async () => {
    const cs = inlineCS('http://example.org/cs/draft-1', { status: 'draft' });
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(hasExpansionParam(result, 'warning-draft'),
      `expected warning-draft parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  await expandTest({ id: 55, rawName: 'meta: warning-retired for retired CodeSystem', name: 'Retired CodeSystem emits warning', category: 'Expansion Metadata' }, async () => {
    const cs = inlineCS('http://example.org/cs/retired-1', { status: 'retired' });
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(hasExpansionParam(result, 'warning-retired'),
      `expected warning-retired parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  await expandTest({ id: 56, rawName: 'meta: warning-experimental for experimental CodeSystem (non-experimental VS)', name: 'Experimental CodeSystem emits warning for non-experimental ValueSet', category: 'Expansion Metadata' }, async () => {
    const cs = inlineCS('http://example.org/cs/experimental-1', { experimental: true });
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(hasExpansionParam(result, 'warning-experimental'),
      `expected warning-experimental parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  await expandTest({ id: 57, rawName: 'meta: NO warning-draft when VS is also draft', name: 'No draft warning when ValueSet is also draft', category: 'Expansion Metadata' }, async () => {
    const cs = inlineCS('http://example.org/cs/draft-2', { status: 'draft' });
    const vsJson = {
      resourceType: 'ValueSet',
      url: 'http://example.org/test-vs-draft',
      status: 'draft',  // VS is also draft — should suppress warning
      compose: { include: [{ system: cs.url }] },
    };
    const { result } = await expand(vsJson, { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(!hasExpansionParam(result, 'warning-draft'),
      `should NOT have warning-draft when VS is also draft, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  // Note: legacy engine has a bug here — ValueSet wrapper doesn't expose .experimental,
  // so it always emits warning-experimental. IR engine correctly suppresses it.
  await expandTest({ id: 58, rawName: 'meta: NO warning-experimental when VS is also experimental', name: 'No experimental warning when ValueSet is also experimental', category: 'Expansion Metadata' }, async () => {
    const cs = inlineCS('http://example.org/cs/experimental-2', { experimental: true });
    const vsJson = {
      resourceType: 'ValueSet',
      url: 'http://example.org/test-vs-experimental',
      status: 'active',
      experimental: true,  // VS is also experimental — should suppress warning
      compose: { include: [{ system: cs.url }] },
    };
    const { result } = await expand(vsJson, { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(!hasExpansionParam(result, 'warning-experimental'),
      `should NOT have warning-experimental when VS is also experimental`);
  });

  await expandTest({ id: 59, rawName: 'meta: warning-deprecated via standardsStatus extension', name: 'Deprecated standards-status extension emits warning', category: 'Expansion Metadata' }, async () => {
    const cs = inlineCS('http://example.org/cs/deprecated-1', {
      extension: [{
        url: 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
        valueCode: 'deprecated',
      }],
    });
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    assert(hasExpansionParam(result, 'warning-deprecated'),
      `expected warning-deprecated parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  await expandTest({ id: 60, rawName: 'meta: fragment CodeSystem sets valueset-unclosed extension', name: 'Fragment CodeSystem sets valueset-unclosed extension', category: 'Expansion Metadata' }, async () => {
    const cs = inlineCS('http://example.org/cs/fragment-1', { content: 'fragment' });
    const { result } = await expand(vsForCS(cs.url), { txResources: cs });
    assert(codes(result).length === 3, `expected 3 codes, got ${codes(result).length}`);
    const unclosed = expansionExtensions(result, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
    eq(unclosed.length, 1,
      `expected exactly one valueset-unclosed extension, got ${JSON.stringify(result.expansion?.extension)}`);
    eq(unclosed[0].valueBoolean, true,
      `expected valueset-unclosed valueBoolean=true, got ${JSON.stringify(unclosed[0])}`);
    assert(unclosed[0].valueString == null,
      `valueset-unclosed must not use valueString, got ${JSON.stringify(unclosed[0])}`);
  });

  await expandTest({ id: 61, rawName: 'meta: SNOMED expansion emits used-codesystem with version', name: 'SNOMED expansion emits usedCodeSystem with version', category: 'Expansion Metadata' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    }), { count: 5 });
    const usedParams = expansionParams(result, 'used-codesystem');
    assert(usedParams.some(p => p.valueUri?.startsWith('http://snomed.info/sct')),
      `SNOMED expansion should have used-codesystem, got: ${JSON.stringify(usedParams)}`);
  });

  // ── Phase 1.1–1.4: compose overrides, used-valueset, count guard ─────

  await expandTest({ id: 62, rawName: 'compose: display override from compose replaces provider display', name: 'Compose display override replaces provider display', category: 'Compose Overrides' }, async () => {
    // Gender 'male' has provider display 'Male' — compose overrides to 'Masculin'
    const { result } = await expand(vs({
      system: SYS.GENDER,
      concept: [{ code: 'male', display: 'Masculin' }, { code: 'female' }],
    }));
    const male = findCode(result, 'male');
    assert(male, 'missing code male');
    assert(male.display === 'Masculin',
      `expected display 'Masculin', got '${male.display}'`);
    // female should retain provider display
    const female = findCode(result, 'female');
    assert(female, 'missing code female');
    assert(female.display === 'Female',
      `expected display 'Female', got '${female.display}'`);
  });

  await expandTest({ id: 63, rawName: 'compose: inline designation from compose appears with includeDesignations', name: 'Compose designation appears when includeDesignations is enabled', category: 'Compose Overrides' }, async () => {
    const { result } = await expand(vs({
      system: SYS.GENDER,
      concept: [{
        code: 'male',
        designation: [
          { language: 'de', value: 'Männlich' },
          { language: 'fr', value: 'Masculin' },
        ],
      }],
    }), { includeDesignations: true });
    const male = findCode(result, 'male');
    assert(male, 'missing code male');
    const desigs = male.designation || [];
    assert(desigs.some(d => d.language === 'de' && d.value === 'Männlich'),
      `expected German designation, got: ${JSON.stringify(desigs)}`);
    assert(desigs.some(d => d.language === 'fr' && d.value === 'Masculin'),
      `expected French designation, got: ${JSON.stringify(desigs)}`);
  });

  await expandTest({ id: 64, rawName: 'meta: ValueSet import emits used-valueset parameter', name: 'ValueSet import emits used-valueset parameter', category: 'Expansion Metadata' }, async () => {
    // Pure import of administrative-gender VS — should emit used-valueset
    const { result } = await expand(vs({
      valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'],
    }));
    const usedVS = expansionParams(result, 'used-valueset');
    assert(usedVS.length > 0,
      `expected used-valueset parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
    assert(usedVS.some(p => (p.valueUri || '').includes('administrative-gender')),
      `expected used-valueset for administrative-gender, got: ${JSON.stringify(usedVS)}`);
  });

  await expandTest({ id: 65, rawName: 'meta: count parameter is omitted when not requested (no count=-1)', name: 'No count=-1 parameter when count is not requested', category: 'Expansion Metadata' }, async () => {
    // Expand without specifying count — should NOT emit count=-1
    const { result } = await expand(vs({
      system: SYS.GENDER,
    }));
    const countParams = expansionParams(result, 'count');
    const negative = countParams.filter(p => p.valueInteger < 0);
    assert(negative.length === 0,
      `should not emit negative count, got: ${JSON.stringify(countParams)}`);
  });


  // ── Phase 1.5: designation parameter filter ────────────────────────

  await expandTest({ id: 66, rawName: 'lang: designation parameter filters SNOMED designations by FSN use code', name: 'designation parameter filters SNOMED designations by FSN use', category: 'Designations & Language' }, async () => {
    // SNOMED 73211009 has 3 designations: 2 synonyms + 1 FSN
    // designation=http://snomed.info/sct|900000000000003001 should keep only FSN
    const { result } = await expand(vs({
      system: SYS.SCT,
      concept: [{ code: '73211009' }],
    }), {
      includeDesignations: true,
      params: [
        { name: 'designation', valueString: 'http://snomed.info/sct|900000000000003001' },
      ],
    });
    const entry = findCode(result, '73211009');
    assert(entry, 'missing code 73211009');
    const desigs = entry.designation || [];
    assert(desigs.length > 0, 'expected at least one designation after filter');
    // All returned designations should have FSN use code
    for (const d of desigs) {
      assert(d.use?.code === '900000000000003001',
        `expected only FSN designations, got use.code=${d.use?.code} value=${d.value}`);
    }
    // Should have exactly 1 FSN
    assert(desigs.length === 1,
      `expected 1 FSN designation, got ${desigs.length}: ${JSON.stringify(desigs)}`);
  });

  await expandTest({ id: 67, rawName: 'lang: displayLanguage=en echoed and matches default display for SNOMED', name: 'displayLanguage=en echoed and display remains SNOMED default', category: 'Designations & Language' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      concept: [{ code: '73211009' }],
    }), {
      params: [{ name: 'displayLanguage', valueCode: 'en' }],
    });
    const entry = findCode(result, '73211009');
    assert(entry, 'missing code 73211009');
    assert(entry.display === 'Diabetes mellitus',
      `expected English display, got '${entry.display}'`);
    // displayLanguage should be echoed in expansion parameters
    assert(hasExpansionParam(result, 'displayLanguage', 'en'),
      `expected displayLanguage=en in params, got: ${JSON.stringify(expansionParams(result, 'displayLanguage'))}`);
  });

  await expandTest({ id: 68, rawName: 'lang: redundant designation equal to primary display is suppressed', name: 'Redundant designation equal to primary display is suppressed', category: 'Designations & Language' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT,
      concept: [{ code: '73211009' }],
    }), { includeDesignations: true });
    const dm = findCode(result, '73211009');
    assert(dm, 'missing 73211009');
    assert(dm.designation?.some(d => d.value === 'Diabetes mellitus, NOS'),
      'missing SNOMED synonym "Diabetes mellitus, NOS"');
    for (const d of dm.designation || []) {
      const redundant = d.value === dm.display
        && (!d.use || d.use?.code === 'display')
        && (!d.language || d.language.startsWith('en'));
      assert(!redundant,
        `redundant designation should be suppressed for display '${dm.display}'`);
    }
  });

  // ── Phase 1.8: property-value regex in SQL ─────────────────────────

  await expandTest({ id: 69, rawName: 'logic: property regex on literal-valued property (LOINC STATUS regex ^ACT)', name: 'Regex filter applies to literal-valued LOINC STATUS property', category: 'Composition Semantics' }, async () => {
    // LOINC STATUS is a literal property. regex should work like = but with pattern matching.
    const { result } = await expand(vs({
      system: SYS.LOINC,
      filter: [{ property: 'STATUS', op: 'regex', value: '^ACT' }],
    }), { count: 5 });
    assert(codes(result).length > 0,
      `expected results for STATUS regex ^ACT, got ${codes(result).length}`);
    assert(result.expansion.total > 0 || codes(result).length > 0,
      `expected non-zero total or results`);
  });

  // ── Phase 2: baseline fixtures + filter/txResources tests ───────────
  log('\n=== Phase 2: baselines / txResources / filters ==='); setCategory('Phase 2');

  await expandTest({ id: 70, rawName: 'baseline: currency full expansion (preloaded map)', name: 'Currency full expansion baseline (preloaded map)', category: 'Baseline Fixtures' }, async () => {
    const { result } = await expand(vs({ system: SYS.CURRENCY }), { count: 500 });
    const all = codes(result);
    assert(all.length >= 150, `expected ≥150 currency codes, got ${all.length}`);
    const usd = findCode(result, 'USD');
    assert(usd, 'USD not found');
    assert(usd.display && usd.display.length > 0, 'USD missing display');
    const eur = findCode(result, 'EUR');
    assert(eur, 'EUR not found');
    assert(eur.display && eur.display.length > 0, 'EUR missing display');
    const jpy = findCode(result, 'JPY');
    assert(jpy, 'JPY not found');
    assert(jpy.display && jpy.display.length > 0, 'JPY missing display');
  });

  await expandTest({ id: 71, rawName: 'baseline: administrative-gender (inline CodeSystem) strict shape', name: 'Administrative-gender inline CodeSystem baseline expansion', category: 'Baseline Fixtures' }, async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }));
    eq(result.expansion.total, 4, 'total');
    eq(codes(result).length, 4, 'exactly 4 codes returned');
    assert(findCode(result, 'male')?.display === 'Male', 'male display');
    assert(findCode(result, 'female')?.display === 'Female', 'female display');
    assert(findCode(result, 'other')?.display === 'Other', 'other display');
    assert(findCode(result, 'unknown')?.display === 'Unknown', 'unknown display');
  });

  await expandTest({ id: 72, rawName: 'baseline: publication-status (inline CodeSystem)', name: 'Publication-status inline CodeSystem baseline expansion', category: 'Baseline Fixtures' }, async () => {
    const { result } = await expand(vs({ system: SYS.PUBSTAT }));
    eq(result.expansion.total, 4, 'total');
    eq(codes(result).length, 4, 'exactly 4 codes returned');
    assert(findCode(result, 'draft')?.display === 'Draft', 'draft display');
    assert(findCode(result, 'active')?.display === 'Active', 'active display');
    assert(findCode(result, 'retired')?.display === 'Retired', 'retired display');
    assert(findCode(result, 'unknown')?.display === 'Unknown', 'unknown display');
  });

  await expandTest({ id: 73, rawName: 'infra: tx-resource injected CodeSystem can be expanded', name: 'txResources-injected CodeSystem can be expanded', category: 'txResources' }, async () => {
    const cs = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/cs/colors',
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [
        { code: 'red', display: 'Red' },
        { code: 'green', display: 'Green' },
        { code: 'blue', display: 'Blue' },
      ],
    };
    const { result } = await expand(vs({ system: cs.url }), { txResources: cs });
    eq(codes(result).length, 3, 'expected 3 codes');
    assert(findCode(result, 'red')?.display === 'Red', 'red present');
    assert(findCode(result, 'green')?.display === 'Green', 'green present');
    assert(findCode(result, 'blue')?.display === 'Blue', 'blue present');
  });

  await expandTest({ id: 74, rawName: 'infra: tx-resource injected ValueSet import resolves', name: 'txResources-injected ValueSet import resolves', category: 'txResources' }, async () => {
    const cs = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/cs/shapes',
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [
        { code: 'circle', display: 'Circle' },
        { code: 'square', display: 'Square' },
        { code: 'triangle', display: 'Triangle' },
      ],
    };
    const importedVS = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/two-shapes',
      status: 'active',
      compose: { include: [{ system: cs.url, concept: [{ code: 'circle' }, { code: 'square' }] }] },
    };
    const outerVS = {
      resourceType: 'ValueSet',
      status: 'active',
      compose: { include: [{ valueSet: [importedVS.url] }] },
    };
    const { result } = await expand(outerVS, { txResources: [cs, importedVS] });
    eq(codes(result).length, 2, 'expected 2 codes from import');
    assert(findCode(result, 'circle'), 'circle present');
    assert(findCode(result, 'square'), 'square present');
    assert(!findCode(result, 'triangle'), 'triangle should be absent');
  });

  await expandTest({ id: 75, rawName: 'baseline: single concept exact match (SQLite v0)', name: 'Single concept exact match on SQLite v0', category: 'Baseline Fixtures' }, async () => {
    const { result } = await expand(vs({ system: SYS.SCT, concept: [{ code: '73211009' }] }));
    eq(result.expansion.total, 1, 'total');
    const dm = findCode(result, '73211009');
    assert(dm, 'code 73211009 not found');
    assert(dm.display?.startsWith('Diabetes mellitus'), `unexpected display: ${dm.display}`);
  });

  await expandTest({ id: 76, rawName: 'filter: gender regex [mf].* (inline FHIR cs-cs)', name: 'Gender regex [mf].* on inline FHIR CodeSystem', category: 'Filter Semantics' }, async () => {
    const { result } = await expand(vs({
      system: SYS.GENDER,
      filter: [{ property: 'code', op: 'regex', value: '[mf].*' }],
    }));
    eq(codes(result).length, 2, 'expected 2 codes');
    assert(findCode(result, 'male'), 'male present');
    assert(findCode(result, 'female'), 'female present');
    assert(!findCode(result, 'other'), 'other should be absent');
    assert(!findCode(result, 'unknown'), 'unknown should be absent');
  });

  await expandTest({ id: 77, rawName: 'filter: inline FHIR is-a with hierarchy (condition-ver-status)', name: 'Inline FHIR is-a filter with hierarchy (condition-ver-status)', category: 'Filter Semantics' }, async () => {
    // condition-ver-status hierarchy: unconfirmed → {provisional, differential}, confirmed, refuted, entered-in-error
    // is-a "unconfirmed" = unconfirmed + provisional + differential = 3 codes
    const { result } = await expand(vs({
      system: SYS.CONDVER,
      filter: [{ property: 'concept', op: 'is-a', value: 'unconfirmed' }],
    }));
    eq(codes(result).length, 3, 'is-a unconfirmed = 3 codes');
    assert(findCode(result, 'unconfirmed'), 'unconfirmed present (self)');
    assert(findCode(result, 'provisional'), 'provisional present (child)');
    assert(findCode(result, 'differential'), 'differential present (child)');
    assert(!findCode(result, 'confirmed'), 'confirmed should be absent');
    assert(!findCode(result, 'refuted'), 'refuted should be absent');
    assert(!findCode(result, 'entered-in-error'), 'entered-in-error should be absent');
  });

  await expandTest({ id: 78, rawName: 'filter: inline FHIR descendent-of (condition-ver-status)', name: 'Inline FHIR descendent-of filter (condition-ver-status)', category: 'Filter Semantics' }, async () => {
    // descendent-of "unconfirmed" = provisional + differential = 2 codes (excludes self)
    const { result } = await expand(vs({
      system: SYS.CONDVER,
      filter: [{ property: 'concept', op: 'descendent-of', value: 'unconfirmed' }],
    }));
    eq(codes(result).length, 2, 'descendent-of unconfirmed = 2 codes');
    assert(!findCode(result, 'unconfirmed'), 'unconfirmed excluded (self)');
    assert(findCode(result, 'provisional'), 'provisional present');
    assert(findCode(result, 'differential'), 'differential present');
  });

  await expandTest({ id: 79, rawName: 'filter: inline FHIR concept = exact code (cs-cs)', name: 'Inline FHIR concept filter exact-code match', category: 'Filter Semantics' }, async () => {
    const { result } = await expand(vs({
      system: SYS.CONDVER,
      filter: [{ property: 'concept', op: '=', value: 'confirmed' }],
    }));
    eq(codes(result).length, 1, 'expected exactly 1 code');
    assert(findCode(result, 'confirmed'), 'confirmed present');
  });

  await expandTest({ id: 80, rawName: 'filter: country code regex A.* (cs-country)', name: 'Country code regex A.* filter on inline CodeSystem', category: 'Filter Semantics' }, async () => {
    const { result } = await expand(vs({
      system: SYS.COUNTRY,
      filter: [{ property: 'code', op: 'regex', value: 'A.*' }],
    }), { count: 500 });
    assert(codes(result).length > 10, `expected >10 country codes starting with A, got ${codes(result).length}`);
    assert(codes(result).every(c => c.code.startsWith('A')),
      'all codes should start with A');
  });

  await expandTest({ id: 81, rawName: 'filter: currency decimals=0 (property =)', name: 'Currency decimals=0 property filter', category: 'Filter Semantics' }, async () => {
    const { result } = await expand(vs({
      system: SYS.CURRENCY,
      filter: [{ property: 'decimals', op: '=', value: '0' }],
    }), { count: 500 });
    assert(codes(result).length > 5, `expected >5 zero-decimal currencies, got ${codes(result).length}`);
    assert(findCode(result, 'JPY'), 'JPY should be zero-decimal');
  });

  await expandTest({ id: 82, rawName: 'params: property=definition includes definition property', name: 'property=definition parameter includes definition property', category: 'Parameter Handling' }, async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }), {
      params: [{ name: 'property', valueString: 'definition' }],
    });
    const all = codes(result);
    assert(all.length > 0, 'should have codes');
    for (const c of all) {
      const props = containsProperties(c);
      const defProp = props.find(p => p.code === 'definition');
      assert(defProp, `code ${c.code} should have a definition property, got props: ${JSON.stringify(props)}`);
      assert(defProp.valueString && defProp.valueString.length > 0,
        `code ${c.code} definition should have non-empty valueString`);
    }
  });

  await expandTest({ id: 83, rawName: 'lang: includeDesignations on package cs-cs whole-system is structurally valid', name: 'includeDesignations on package inline CodeSystem is structurally valid', category: 'Designations & Language' }, async () => {
    const { result } = await expand(vs({ system: SYS.GENDER }), { includeDesignations: true });
    const all = codes(result);
    assert(all.length === 4, `expected 4 gender codes, got ${all.length}`);
    let totalDesignations = 0;
    for (const c of all) {
      if (c.designation && c.designation.length > 0) {
        totalDesignations += c.designation.length;
        for (const d of c.designation) {
          // Each designation must have at least a value
          assert(d.value && d.value.length > 0,
            `designation for ${c.code} missing value: ${JSON.stringify(d)}`);
          // Structural validity: must have language, use, or value
          assert(d.language || d.use || d.value,
            `designation for ${c.code} missing language/use/value: ${JSON.stringify(d)}`);
        }
      }
    }
    assert(totalDesignations >= 0, 'designation check completed');
  });

  // ── Phase 2 batch 2: logic, provider, pagination, text-search, exclude ──

  await expandTest({ id: 84, rawName: 'logic: imported inc/exc valueSets apply Inc/Exc semantics', name: 'Imported include/exclude ValueSets preserve include/exclude semantics', category: 'Composition Semantics' }, async () => {
    const csUrl = `http://example.org/cs/palette-${Date.now()}`;
    const incVsUrl = `http://example.org/vs/palette-inc-${Date.now()}`;
    const excVsUrl = `http://example.org/vs/palette-exc-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'red',display:'Red'},{code:'blue',display:'Blue'},{code:'green',display:'Green'},{code:'yellow',display:'Yellow'}]};
    const incVs = {resourceType:'ValueSet',url:incVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'red'},{code:'blue'},{code:'green'}]}]}};
    const excVs = {resourceType:'ValueSet',url:excVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'blue'}]}]}};
    const { result } = await expand(vs([{valueSet:[incVsUrl]}],[{valueSet:[excVsUrl]}]),
      {txResources:[cs,incVs,excVs]});
    assert(codes(result).length === 2, `expected 2 codes, got ${codes(result).length}`);
    assert(findCode(result,'red'), 'red should remain');
    assert(findCode(result,'green'), 'green should remain');
    assert(!findCode(result,'blue'), 'blue should be excluded');
  });

  await expandTest({ id: 85, rawName: 'logic: total includes direct and imported include contributions', name: 'Total includes direct and imported include contributions', category: 'Composition Semantics' }, async () => {
    const csUrl = `http://example.org/cs/total-${Date.now()}`;
    const impVsUrl = `http://example.org/vs/total-imp-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'red',display:'Red'},{code:'blue',display:'Blue'},{code:'green',display:'Green'},{code:'yellow',display:'Yellow'}]};
    const impVs = {resourceType:'ValueSet',url:impVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'green'},{code:'yellow'}]}]}};
    const { result } = await expand(vs([
      {system:csUrl,concept:[{code:'red'},{code:'blue'}]},
      {valueSet:[impVsUrl]},
    ]),{txResources:[cs,impVs]});
    assert(codes(result).length === 4, `expected 4 codes, got ${codes(result).length}`);
    assert(result.expansion.total === 4, `expected total=4, got ${result.expansion.total}`);
  });

  await expandTest({ id: 86, rawName: 'logic: whole-system descendant traversal keeps exact total', name: 'Whole-system descendant traversal preserves exact total', category: 'Composition Semantics' }, async () => {
    const csUrl = `http://example.org/cs/hier-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[
        {code:'root-a',display:'Root A',concept:[{code:'child-a1',display:'Child A1'},{code:'child-a2',display:'Child A2'}]},
        {code:'root-b',display:'Root B',concept:[{code:'child-b1',display:'Child B1'}]},
      ]};
    const { result } = await expand(vs({system:csUrl}),{txResources:[cs]});
    const all = codes(result);
    assert(all.length === 5, `expected 5 flattened codes, got ${all.length}`);
    assert(result.expansion.total === 5, `expected total=5, got ${result.expansion.total}`);
  });

  await expandTest({ id: 87, rawName: 'logic: total reflects imported excludes without mutating accumulated list', name: 'Total reflects imported excludes without list mutation', category: 'Composition Semantics' }, async () => {
    const csUrl = `http://example.org/cs/exc-total-${Date.now()}`;
    const incVsUrl = `http://example.org/vs/exc-total-inc-${Date.now()}`;
    const excVsUrl = `http://example.org/vs/exc-total-exc-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'red',display:'Red'},{code:'blue',display:'Blue'},{code:'green',display:'Green'},{code:'yellow',display:'Yellow'}]};
    const incVs = {resourceType:'ValueSet',url:incVsUrl,status:'active',
      compose:{include:[{system:csUrl}]}};
    const excVs = {resourceType:'ValueSet',url:excVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'blue'},{code:'yellow'}]}]}};
    const { result: full } = await expand(vs([{valueSet:[incVsUrl]}],[{valueSet:[excVsUrl]}]),
      {txResources:[cs,incVs,excVs]});
    assert(codes(full).length === 2, `expected 2 survivors, got ${codes(full).length}`);
    assert(findCode(full,'red'), 'red should remain');
    assert(findCode(full,'green'), 'green should remain');
    if (full.expansion.total != null) {
      assert(full.expansion.total === 2, `expected total=2, got ${full.expansion.total}`);
    }
    // Paginated: total should still be 2
    const { result: page } = await expand(vs([{valueSet:[incVsUrl]}],[{valueSet:[excVsUrl]}]),
      {txResources:[cs,incVs,excVs], count:1, offset:0});
    if (page.expansion.total != null) {
      assert(page.expansion.total === 2, `paged total should be 2, got ${page.expansion.total}`);
    }
  });

  await expandTest({ id: 88, rawName: 'logic: mixed import+peer inc/exc paginates without gaps or duplicates', name: 'Mixed import+peer include/exclude paginates without gaps', category: 'Composition Semantics' }, async () => {
    const csUrl = `http://example.org/cs/page-${Date.now()}`;
    const incVsUrl = `http://example.org/vs/page-inc-${Date.now()}`;
    const excVsUrl = `http://example.org/vs/page-exc-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'red',display:'Red'},{code:'blue',display:'Blue'},{code:'green',display:'Green'}]};
    const incVs = {resourceType:'ValueSet',url:incVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'red'},{code:'blue'},{code:'green'}]}]}};
    const excVs = {resourceType:'ValueSet',url:excVsUrl,status:'active',
      compose:{include:[{system:csUrl,concept:[{code:'blue'}]}]}};
    const query = vs(
      [{valueSet:[incVsUrl]},{system:SYS.GENDER,concept:[{code:'male'},{code:'female'}]}],
      [{valueSet:[excVsUrl]},{system:SYS.GENDER,concept:[{code:'female'}]}]);
    const txR = [cs,incVs,excVs];
    const { result: full } = await expand(query, {txResources:txR, count:100});
    const fullCodes = codes(full).map(c => `${c.system}|${c.code}`);
    const fullSet = new Set(fullCodes);
    assert(fullSet.size === 3, `expected 3 final codes, got ${fullSet.size}`);
    // Page through with count=1
    const pagedCodes = [];
    for (let off = 0; off < 10; off++) {
      const { result: p } = await expand(query, {txResources:txR, count:1, offset:off});
      const pc = codes(p).map(c => `${c.system}|${c.code}`);
      if (pc.length === 0) break;
      pagedCodes.push(...pc);
    }
    const pagedSet = new Set(pagedCodes);
    assert(pagedCodes.length === pagedSet.size, 'paged should not duplicate');
    assert(pagedSet.size === fullSet.size, `paged ${pagedSet.size} != full ${fullSet.size}`);
  });

  await expandTest({ id: 89, rawName: 'logic: bulk locate handles >50 unique concepts', name: 'Bulk locate handles more than 50 unique concepts', category: 'Composition Semantics' }, async () => {
    // Seed from SNOMED is-a diabetes
    const { result: seed } = await expand(vs({
      system: SYS.SCT, filter: [{property:'concept',op:'is-a',value:'73211009'}],
    }), {count:150});
    const seedCodes = [...new Set(codes(seed).map(c=>c.code))].slice(0,60);
    assert(seedCodes.length >= 50, `need >=50 seed codes, got ${seedCodes.length}`);
    const { result } = await expand(vs({
      system: SYS.SCT, concept: seedCodes.map(code=>({code})),
    }), {count:200});
    const gotSet = new Set(codes(result).map(c=>c.code));
    assert(gotSet.size === seedCodes.length,
      `expected ${seedCodes.length} codes, got ${gotSet.size}`);
  });

  await expandTest({ id: 90, rawName: 'text-search: SNOMED filter=diabetes no pagination', name: 'SNOMED filter=diabetes without pagination', category: 'Text Search' }, async () => {
    // count: 2000 to bypass default limit (diabetes returns ~1179 codes > 1000 limit)
    const { result } = await expand(vs({system:SYS.SCT}), {filter:'diabetes', count: 2000});
    const c = codes(result);
    assert(c.length > 0, `expected results, got ${c.length}`);
    assert(c.length >= 100, `expected many results, got ${c.length}`);
  });

  await expandTest({ id: 91, rawName: 'logic: system exclude global when import include is present', name: 'System exclude is global when import include is present', category: 'Composition Semantics' }, async () => {
    const impVsUrl = `http://example.org/vs/exc-guard-${Date.now()}`;
    const impVs = {resourceType:'ValueSet',url:impVsUrl,status:'active',
      compose:{include:[{system:SYS.SCT,concept:[{code:'44054006'}]}]}};
    const { result } = await expand(vs(
      [{system:SYS.SCT,filter:[{property:'concept',op:'is-a',value:'73211009'}]},{valueSet:[impVsUrl]}],
      [{system:SYS.SCT,concept:[{code:'44054006'}]}]
    ), {txResources:[impVs], count:200});
    assert(!findCode(result,'44054006'), 'excluded code should not appear despite import');
  });

  await expandTest({ id: 92, rawName: 'exclude: inline FHIR filter-based exclude (condition-ver-status)', name: 'Inline FHIR filter-based exclude (condition-ver-status)', category: 'Exclusions' }, async () => {
    const { result } = await expand(vs(
      [{system:SYS.CONDVER}],
      [{system:SYS.CONDVER,filter:[{property:'concept',op:'is-a',value:'unconfirmed'}]}]
    ));
    const c = codes(result);
    // Total is 6, minus unconfirmed subtree (3) = 3
    assert(c.length === 3, `expected 3 after exclude, got ${c.length}`);
    assert(!findCode(result,'unconfirmed'), 'unconfirmed excluded');
    assert(!findCode(result,'provisional'), 'provisional excluded');
    assert(!findCode(result,'differential'), 'differential excluded');
    assert(findCode(result,'confirmed'), 'confirmed should remain');
  });

  await expandTest({ id: 93, rawName: 'provider: preloaded map iteration (currency full + filter)', name: 'Preloaded-map provider iteration (currency full + filter)', category: 'Provider Execution' }, async () => {
    const { result: full } = await expand(vs({system:SYS.CURRENCY}));
    assert(codes(full).length >= 150, `expected >=150 currencies, got ${codes(full).length}`);
    const { result: filtered } = await expand(vs({
      system:SYS.CURRENCY, filter:[{property:'decimals',op:'=',value:'0'}],
    }));
    assert(codes(filtered).length === 18,
      `expected 18 zero-decimal currencies, got ${codes(filtered).length}`);
  });

  await expandTest({ id: 94, rawName: 'provider: cs-cs hierarchy iteration (condition-ver-status)', name: 'Inline CodeSystem hierarchy iteration (condition-ver-status)', category: 'Provider Execution' }, async () => {
    const { result } = await expand(vs({system:SYS.CONDVER}));
    const c = codes(result);
    assert(c.length === 6, `expected 6 condition-ver-status codes, got ${c.length}`);
    assert(findCode(result,'unconfirmed'), 'missing unconfirmed');
    assert(findCode(result,'provisional'), 'missing provisional');
    assert(findCode(result,'differential'), 'missing differential');
    assert(findCode(result,'confirmed'), 'missing confirmed');
    assert(findCode(result,'refuted'), 'missing refuted');
    assert(findCode(result,'entered-in-error'), 'missing entered-in-error');
  });

  // ── Phase 2 batch 3: pagination, multi-system, coverage, pagination-safety ──

  await expandTest({ id: 95, rawName: 'pagination: currency count=10 offset=0', name: 'Currency pagination with count=10 and offset=0', category: 'Pagination' }, async () => {
    const { result } = await expand(vs({system:SYS.CURRENCY}), {count:10, offset:0});
    assert(codes(result).length === 10, `expected 10 codes, got ${codes(result).length}`);
    assert(result.expansion.total >= 150, `expected total>=150, got ${result.expansion.total}`);
    assert(result.expansion.offset === 0, `expected expansion.offset=0, got ${result.expansion.offset}`);
    const offsetP = findParams(result, 'offset')[0];
    assert(offsetP?.valueInteger === 0, `expected offset param=0, got ${offsetP?.valueInteger}`);
  });

  await expandTest({ id: 96, rawName: 'pagination-bug: preloaded map total matches full expansion when paged', name: 'Preloaded-map pagination total matches full expansion', category: 'Pagination Safety' }, async () => {
    // Full expansion
    const { result: full } = await expand(vs({system:SYS.CURRENCY}));
    const fullCount = codes(full).length;
    // Paged — total should match
    const { result: page } = await expand(vs({system:SYS.CURRENCY}), {count:10, offset:0});
    assert(page.expansion.total === fullCount,
      `paged total ${page.expansion.total} != full count ${fullCount}`);
  });

  await expandTest({ id: 97, rawName: 'multi-system: v0 filter + preloaded whole + cs-cs enumerated', name: 'SQLite v0 filter + preloaded whole + single-system enumerated', category: 'Multi-System Composition' }, async () => {
    const { result } = await expand(vs([
      {system:SYS.SCT, filter:[{property:'concept',op:'is-a',value:'73211009'}]},
      {system:SYS.CURRENCY},
      {system:SYS.GENDER, concept:[{code:'male'}]},
    ]), {count:5, offset:0});
    const c = codes(result);
    assert(c.length === 5, `expected 5 codes, got ${c.length}`);
    // total should be diabetes codes + all currencies + 1 gender
    assert(result.expansion.total > 200, `expected large total, got ${result.expansion.total}`);
  });

  await expandTest({ id: 98, rawName: 'provider: v0 SNOMED large is-a pagination consistency', name: 'SQLite v0 SNOMED large is-a preserves pagination consistency', category: 'Provider Execution' }, async () => {
    const q = vs({system:SYS.SCT, filter:[{property:'concept',op:'is-a',value:'73211009'}]});
    const { result: p1 } = await expand(q, {count:50, offset:0});
    const { result: p2 } = await expand(q, {count:50, offset:50});
    const set1 = new Set(codes(p1).map(c=>c.code));
    const set2 = new Set(codes(p2).map(c=>c.code));
    assert(set1.size === 50, `page1 expected 50, got ${set1.size}`);
    assert(set2.size === 50, `page2 expected 50, got ${set2.size}`);
    // No overlap
    for (const code of set2) {
      assert(!set1.has(code), `code ${code} in both pages`);
    }
  });

  await expandTest({ id: 99, rawName: 'provider: v0 RxNorm text search + property filter combined', name: 'SQLite v0 RxNorm text search combined with property filter', category: 'Provider Execution' }, async () => {
    const { result } = await expand(vs({
      system:SYS.RXNORM, filter:[{property:'TTY',op:'=',value:'IN'}],
    }), {filter:'aspirin', count:20});
    const c = codes(result);
    assert(c.length > 0, 'expected aspirin results');
    assert(c.some(x => x.code === '1191'), 'expected aspirin code 1191');
  });

  await expandTest({ id: 100, rawName: 'coverage: tx-resource whole include with cs-cs peer', name: 'txResources whole include with inline CodeSystem peer', category: 'Cross-Source Coverage' }, async () => {
    const csUrl = `http://example.org/cs/cov-whole-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'a',display:'A'},{code:'b',display:'B'}]};
    const { result } = await expand(vs([
      {system:csUrl},
      {system:SYS.GENDER, concept:[{code:'male'}]},
    ]),{txResources:[cs]});
    const c = codes(result);
    assert(c.length === 3, `expected 3, got ${c.length}`);
    assert(findCode(result,'a'), 'missing a');
    assert(findCode(result,'male'), 'missing male');
  });

  await expandTest({ id: 101, rawName: 'coverage: tx-resource concept include + exclude with cs-cs peer', name: 'txResources concept include/exclude with inline CodeSystem peer', category: 'Cross-Source Coverage' }, async () => {
    const csUrl = `http://example.org/cs/cov-exc-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'x',display:'X'},{code:'y',display:'Y'},{code:'z',display:'Z'}]};
    const { result } = await expand(vs(
      [{system:csUrl,concept:[{code:'x'},{code:'y'},{code:'z'}]},{system:SYS.GENDER,concept:[{code:'male'},{code:'female'}]}],
      [{system:csUrl,concept:[{code:'y'}]},{system:SYS.GENDER,concept:[{code:'female'}]}]
    ),{txResources:[cs]});
    const c = codes(result);
    assert(c.length === 3, `expected 3 (x,z,male), got ${c.length}`);
    assert(findCode(result,'x'), 'missing x');
    assert(findCode(result,'z'), 'missing z');
    assert(findCode(result,'male'), 'missing male');
    assert(!findCode(result,'y'), 'y should be excluded');
    assert(!findCode(result,'female'), 'female should be excluded');
  });

  await expandTest({ id: 102, rawName: 'coverage: valueset-import include with gender peer', name: 'Imported ValueSet include with gender peer', category: 'Cross-Source Coverage' }, async () => {
    // Adapted from codex-2 USPS test — use gender import instead
    const { result } = await expand(vs([
      {valueSet:['http://hl7.org/fhir/ValueSet/administrative-gender']},
      {system:SYS.PUBSTAT, concept:[{code:'active'}]},
    ]));
    const c = codes(result);
    assert(c.length === 5, `expected 5 (4 gender + 1 pubstat), got ${c.length}`);
    assert(findCode(result,'male'), 'missing male');
    assert(findCode(result,'active'), 'missing active');
  });

  await expandTest({ id: 103, rawName: 'coverage: valueset-import include with gender peer and exclude', name: 'Imported ValueSet include with gender peer plus exclude', category: 'Cross-Source Coverage' }, async () => {
    const { result } = await expand(vs(
      [{valueSet:['http://hl7.org/fhir/ValueSet/administrative-gender']},{system:SYS.PUBSTAT,concept:[{code:'active'}]}],
      [{system:SYS.GENDER,concept:[{code:'other'},{code:'unknown'}]}]
    ));
    const c = codes(result);
    assert(c.length === 3, `expected 3 (male,female,active), got ${c.length}`);
    assert(!findCode(result,'other'), 'other excluded');
    assert(!findCode(result,'unknown'), 'unknown excluded');
  });

  await expandTest({ id: 104, rawName: 'coverage: country regex filter with cs-cs peer include', name: 'Country regex filter with inline CodeSystem peer include', category: 'Cross-Source Coverage' }, async () => {
    const { result } = await expand(vs([
      {system:SYS.COUNTRY, filter:[{property:'code',op:'regex',value:'A.*'}]},
      {system:SYS.GENDER, concept:[{code:'male'}]},
    ]));
    const c = codes(result);
    assert(c.length > 10, `expected >10, got ${c.length}`);
    assert(findCode(result,'male'), 'missing gender peer code');
  });

  await expandTest({ id: 105, rawName: 'pagination-safety: mixed v0 + preloaded reconstruct full set', name: 'Mixed SQLite v0 + preloaded reconstructs full set', category: 'Pagination Safety' }, async () => {
    const q = vs([
      {system:SYS.SCT, concept:[{code:'73211009'},{code:'44054006'},{code:'46635009'}]},
      {system:SYS.CURRENCY},
    ]);
    const { result: full } = await expand(q, {count:500});
    const fullSet = new Set(codes(full).map(c=>`${c.system}|${c.code}`));
    // Page through
    const pagedKeys = [];
    for (let off = 0; off < fullSet.size + 10; off += 50) {
      const { result: p } = await expand(q, {count:50, offset:off});
      const pc = codes(p).map(c=>`${c.system}|${c.code}`);
      if (pc.length === 0) break;
      pagedKeys.push(...pc);
    }
    const pagedSet = new Set(pagedKeys);
    assert(pagedSet.size === fullSet.size,
      `paged ${pagedSet.size} != full ${fullSet.size}`);
  });

  await expandTest({ id: 106, rawName: 'pagination-safety: valueset-import peer with excludes reconstruct', name: 'Imported ValueSet peer with excludes reconstructs complete set', category: 'Pagination Safety' }, async () => {
    const csUrl = `http://example.org/cs/pgsafe-${Date.now()}`;
    const vsUrl = `http://example.org/vs/pgsafe-${Date.now()}`;
    const cs = {resourceType:'CodeSystem',url:csUrl,status:'active',content:'complete',
      concept:[{code:'a',display:'A'},{code:'b',display:'B'},{code:'c',display:'C'},{code:'d',display:'D'}]};
    const impVs = {resourceType:'ValueSet',url:vsUrl,status:'active',
      compose:{include:[{system:csUrl}]}};
    const q = vs([{valueSet:[vsUrl]},{system:SYS.GENDER}],
      [{system:csUrl,concept:[{code:'b'}]},{system:SYS.GENDER,concept:[{code:'unknown'}]}]);
    const { result: full } = await expand(q, {txResources:[cs,impVs], count:100});
    const fullSet = new Set(codes(full).map(c=>`${c.system}|${c.code}`));
    const pagedKeys = [];
    for (let off = 0; off < 20; off++) {
      const { result: p } = await expand(q, {txResources:[cs,impVs], count:1, offset:off});
      const pc = codes(p).map(c=>`${c.system}|${c.code}`);
      if (pc.length === 0) break;
      pagedKeys.push(...pc);
    }
    const pagedSet = new Set(pagedKeys);
    assert(pagedKeys.length === pagedSet.size, 'no duplicates in paged');
    assert(pagedSet.size === fullSet.size,
      `paged ${pagedSet.size} != full ${fullSet.size}`);
  });

  await expandTest({ id: 107, rawName: 'pagination-safety: mixed import+system high-count page not capped', name: 'Mixed import + system high-count page is not capped', category: 'Pagination Safety' }, async () => {
    // Expand gender import + currency peer — high count should return all
    const { result } = await expand(vs([
      {valueSet:['http://hl7.org/fhir/ValueSet/administrative-gender']},
      {system:SYS.CURRENCY},
    ]), {count:500});
    const c = codes(result);
    assert(c.length >= 160, `expected >=160 (4 gender + ~178 currency), got ${c.length}`);
  });

  await expandTest({ id: 108, rawName: 'logic: same-system valueSet intersections constrain membership', name: 'Same-system ValueSet intersections constrain membership', category: 'Composition Semantics' }, async () => {
    // System + valueSet[] intersection: only codes in both the system filter AND the imported VS
    const { result } = await expand(vs({
      system: SYS.GENDER,
      valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'],
      concept: [{code:'male'},{code:'female'}],
    }));
    const c = codes(result);
    assert(c.length === 2, `expected 2 (male+female intersection), got ${c.length}`);
  });

  await expandTest({ id: 109, rawName: 'logic: code regex handled in sqlite-v0', name: 'Code regex is handled in SQLite v0', category: 'Composition Semantics' }, async () => {
    const { result } = await expand(vs({
      system: SYS.SCT, filter:[{property:'code',op:'regex',value:'^7[0-9]{4,}'}],
    }), {count:20});
    const c = codes(result);
    assert(c.length > 0, 'expected code regex results');
    for (const x of c) {
      assert(x.code.startsWith('7'), `expected code starting with 7, got ${x.code}`);
    }
  });

  // ── Phase 2 batch 4: remaining green tests ──

  await expandTest({ id: 110, rawName: 'coverage: UCUM whole-system with gender peer include', name: 'UCUM whole-system with gender peer include', category: 'Cross-Source Coverage' }, async () => {
    // UCUM whole-system uses specialEnumeration (ucum-common) — returns common units + unclosed
    // count: 2000 to bypass default limit (UCUM common = 1364 + 1 gender > 1000)
    const { result } = await expand(vs([
      {system:SYS.UCUM},
      {system:SYS.GENDER, concept:[{code:'male'}]},
    ]), { count: 2000 });
    const c = codes(result);
    assert(findCode(result,'male'), 'gender peer code should be present');
    assert(c.length > 100, `expected many UCUM common units + peer, got ${c.length}`);
    assert(result.expansion.total == null, `unclosed expansion should omit total, got ${result.expansion.total}`);
    const unclosed = expansionExtensions(result, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
    eq(unclosed.length, 1, `expected exactly one valueset-unclosed extension, got ${JSON.stringify(unclosed)}`);
    eq(unclosed[0].valueBoolean, true, `expected valueset-unclosed valueBoolean=true, got ${JSON.stringify(unclosed[0])}`);
    assert(unclosed[0].valueString == null, `valueset-unclosed must not use valueString, got ${JSON.stringify(unclosed[0])}`);
  });

  // ── Phase 4: fixture expansion (US states, area codes, MIME, language) ──

  // ── Phase 4.1: US states (preloaded map, 62 codes) ──

  await expandTest({ id: 111, rawName: 'baseline: US states full expansion', name: 'US states full-expansion baseline', category: 'Baseline Fixtures' }, async () => {
    const { result } = await expand(vs({system:SYS.USPS}));
    assert(result.expansion.total === 62, `expected 62 US states, got ${result.expansion.total}`);
    assert(findCode(result,'CA'), 'California should be present');
    assert(findCode(result,'TX'), 'Texas should be present');
    const ca = findCode(result,'CA');
    assert(ca.display === 'California', `expected California, got ${ca.display}`);
  });

  await expandTest({ id: 112, rawName: 'baseline: US states enumerated', name: 'US states enumerated baseline', category: 'Baseline Fixtures' }, async () => {
    const { result } = await expand(vs({system:SYS.USPS,
      concept:[{code:'CA'},{code:'NY'},{code:'TX'}]}));
    assert(result.expansion.total === 3, `expected 3, got ${result.expansion.total}`);
    assert(findCode(result,'CA')?.display === 'California');
    assert(findCode(result,'NY')?.display === 'New York');
    assert(findCode(result,'TX')?.display === 'Texas');
  });

  await expandTest({ id: 113, rawName: 'exclude: US states subtract 2 from 4 enumerated', name: 'US states subtract 2 from 4 enumerated', category: 'Exclusions' }, async () => {
    const { result } = await expand(vs(
      {system:SYS.USPS, concept:[{code:'CA'},{code:'NY'},{code:'TX'},{code:'FL'}]},
      {system:SYS.USPS, concept:[{code:'CA'},{code:'FL'}]}
    ));
    assert(result.expansion.total === 2, `expected 2 after exclude, got ${result.expansion.total}`);
    assert(findCode(result,'NY'), 'NY should remain');
    assert(findCode(result,'TX'), 'TX should remain');
    assert(!findCode(result,'CA'), 'CA should be excluded');
    assert(!findCode(result,'FL'), 'FL should be excluded');
  });

  await expandTest({ id: 114, rawName: 'exclude: exclude from whole system (preloaded map)', name: 'Whole-system exclude on preloaded map', category: 'Exclusions' }, async () => {
    const { result } = await expand(vs(
      {system:SYS.USPS},
      {system:SYS.USPS, concept:[{code:'CA'},{code:'NY'}]}
    ));
    assert(result.expansion.total === 60, `expected 60, got ${result.expansion.total}`);
    assert(!findCode(result,'CA'), 'CA should be excluded');
    assert(!findCode(result,'NY'), 'NY should be excluded');
    assert(findCode(result,'TX'), 'TX should remain');
  });

  await expandTest({ id: 115, rawName: 'pagination: US states disjoint pages', name: 'US states pagination pages are disjoint', category: 'Pagination' }, async () => {
    const { result: p1 } = await expand(vs({system:SYS.USPS}), {count:30, offset:0});
    const { result: p2 } = await expand(vs({system:SYS.USPS}), {count:30, offset:30});
    const { result: p3 } = await expand(vs({system:SYS.USPS}), {count:30, offset:60});
    const c1 = codes(p1), c2 = codes(p2), c3 = codes(p3);
    assert(c1.length === 30, `page 1 should have 30, got ${c1.length}`);
    assert(c2.length === 30, `page 2 should have 30, got ${c2.length}`);
    assert(c3.length === 2, `page 3 should have 2, got ${c3.length}`);
    const allKeys = [...c1, ...c2, ...c3].map(c => `${c.system}|${c.code}`);
    assert(new Set(allKeys).size === 62, `pages should be disjoint (got ${new Set(allKeys).size} unique)`);
  });

  await expandTest({ id: 116, rawName: 'pagination: US states last page partial', name: 'US states final page is partial', category: 'Pagination' }, async () => {
    const { result } = await expand(vs({system:SYS.USPS}), {count:20, offset:50});
    const c = codes(result);
    assert(c.length === 12, `expected 12 on last page, got ${c.length}`);
    assert(result.expansion.total === 62, `total should be 62, got ${result.expansion.total}`);
  });

  await expandTest({ id: 117, rawName: 'pagination: US states offset beyond end', name: 'US states offset beyond end returns empty', category: 'Pagination' }, async () => {
    const { result } = await expand(vs({system:SYS.USPS}), withExactTotal({count:10, offset:100}));
    const c = codes(result);
    assert(c.length === 0, `expected 0, got ${c.length}`);
    assert(result.expansion.total === 62, `total should be 62, got ${result.expansion.total}`);
  });

  await expandTest({ id: 118, rawName: 'multi-system: gender + US states union', name: 'Gender and US states union across systems', category: 'Multi-System Composition' }, async () => {
    const { result } = await expand(vs([
      {system:SYS.GENDER},
      {system:SYS.USPS},
    ]));
    assert(result.expansion.total === 66, `expected 4+62=66, got ${result.expansion.total}`);
    assert(findCode(result,'male'), 'gender male should be present');
    assert(findCode(result,'CA'), 'CA should be present');
  });

  // ── Phase 4.2: area codes (M49, 270 codes) ──

  await expandTest({ id: 119, rawName: 'baseline: area codes full expansion', name: 'Area codes full-expansion baseline', category: 'Baseline Fixtures' }, async () => {
    const { result } = await expand(vs({system:SYS.AREACODE}));
    assert(result.expansion.total === 270, `expected 270, got ${result.expansion.total}`);
  });

  await expandTest({ id: 120, rawName: 'filter: area codes class=region', name: 'Area codes class=region filter', category: 'Filter Semantics' }, async () => {
    const { result } = await expand(vs({system:SYS.AREACODE,
      filter:[{property:'class', op:'=', value:'region'}]}));
    assert(result.expansion.total === 29, `expected 29 regions, got ${result.expansion.total}`);
    // Spot check: World (001) should be present
    assert(findCode(result,'001'), 'World (001) should be present');
  });

  await expandTest({ id: 121, rawName: 'filter: area codes class=country', name: 'Area codes class=country filter', category: 'Filter Semantics' }, async () => {
    const { result } = await expand(vs({system:SYS.AREACODE,
      filter:[{property:'class', op:'=', value:'country'}]}));
    assert(result.expansion.total === 241, `expected 241 countries, got ${result.expansion.total}`);
  });

  await expandTest({ id: 122, rawName: 'coverage: areacode class filter with cs-cs peer', name: 'Area-code class filter with inline CodeSystem peer', category: 'Cross-Source Coverage' }, async () => {
    const { result } = await expand(vs([
      {system:SYS.AREACODE, filter:[{property:'class', op:'=', value:'region'}]},
      {system:SYS.GENDER, concept:[{code:'male'}]},
    ]));
    assert(result.expansion.total === 30, `expected 29+1=30, got ${result.expansion.total}`);
    assert(findCode(result,'male'), 'gender should be present');
    assert(findCode(result,'001'), 'World should be present');
  });

  // ── Phase 4.3: MIME types (grammar-based, concept-include only) ──

  await expandTest({ id: 123, rawName: 'baseline: MIME types enumerated', name: 'MIME types enumerated baseline', category: 'Baseline Fixtures' }, async () => {
    const { result } = await expand(vs({system:SYS.MIME,
      concept:[{code:'text/html'},{code:'application/json'},{code:'image/png'}]}));
    assert(result.expansion.total === 3, `expected 3, got ${result.expansion.total}`);
    assert(findCode(result,'text/html'), 'text/html should be present');
    assert(findCode(result,'application/json'), 'application/json should be present');
    assert(findCode(result,'image/png'), 'image/png should be present');
  });

  // ── Phase 4.4: Language codes (grammar-based, concept-include) ──

  await expandTest({ id: 124, rawName: 'baseline: language codes enumerated', name: 'Language codes enumerated baseline', category: 'Baseline Fixtures' }, async () => {
    const { result } = await expand(vs({system:SYS.LANG,
      concept:[{code:'en'},{code:'fr'},{code:'de'}]}));
    assert(result.expansion.total === 3, `expected 3, got ${result.expansion.total}`);
    assert(findCode(result,'en')?.display === 'English', `expected English, got ${findCode(result,'en')?.display}`);
    assert(findCode(result,'fr')?.display === 'French', `expected French, got ${findCode(result,'fr')?.display}`);
    assert(findCode(result,'de')?.display === 'German', `expected German, got ${findCode(result,'de')?.display}`);
  });

  await expandTest({ id: 125, rawName: 'params: language code includeDesignations', name: 'displayLanguage parameter with includeDesignations', category: 'Parameter Handling' }, async () => {
    const { result } = await expand(vs({system:SYS.LANG,
      concept:[{code:'en'}]}), {includeDesignations:true});
    assert(findCode(result,'en'), 'en should be present');
    // Language provider may or may not have extra designations.
    // Verify structure is valid (no crash, display present).
    assert(findCode(result,'en').display === 'English');
  });

  // ── Phase 5: inline supplement plumbing ──

  // Helper: inline CS + supplement fixture
  function suppFixture(csUrl, suppUrl, concepts, suppConcepts, opts = {}) {
    const cs = {
      resourceType: 'CodeSystem', url: csUrl, content: 'complete',
      concept: concepts,
    };
    const supp = {
      resourceType: 'CodeSystem', url: suppUrl, content: 'supplement',
      supplements: opts.supplements || csUrl,
      concept: suppConcepts,
    };
    if (opts.suppVersion) supp.version = opts.suppVersion;
    return [cs, supp];
  }

  await expandTest({ id: 126, rawName: 'supplement: useSupplement applies content + records used-supplement', name: 'useSupplement applies content and records used-supplement', category: 'Supplements' }, async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s1', 'http://example.org/supp-s1',
      [{code:'A', display:'Alpha'}, {code:'B', display:'Bravo'}],
      [{code:'A', designation:[{language:'de', value:'Anfang'}]}]
    );
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'A'},{code:'B'}]}),
      { txResources: [cs, supp], includeDesignations: true,
        params: [{name:'useSupplement', valueString: supp.url}] }
    );
    // Designation from supplement appears
    const a = findCode(result, 'A');
    assert(a, 'code A missing');
    const deDes = (a.designation||[]).find(d => d.language === 'de');
    assert(deDes?.value === 'Anfang', `expected Anfang, got ${deDes?.value}`);
    // used-supplement emitted
    const usedSupp = expansionParams(result, 'used-supplement');
    assert(usedSupp.length > 0, 'used-supplement param missing');
    assert(usedSupp[0].valueUri === supp.url, `expected ${supp.url}, got ${usedSupp[0].valueUri}`);
  });

  await expandTest({ id: 127, rawName: 'supplement: provided but not requested is ignored', name: 'Provided supplement is ignored unless requested', category: 'Supplements' }, async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s2', 'http://example.org/supp-s2',
      [{code:'X', display:'Xray'}],
      [{code:'X', designation:[{language:'fr', value:'Rayon'}]}]
    );
    // Provide supplement as tx-resource but DON'T request via useSupplement
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'X'}]}),
      { txResources: [cs, supp], includeDesignations: true }
    );
    const x = findCode(result, 'X');
    assert(x, 'code X missing');
    // Supplement designation should NOT appear (supplement not requested)
    const frDes = (x.designation||[]).find(d => d.language === 'fr');
    assert(!frDes, 'unrequested supplement designation should not leak');
    // No used-supplement param
    const usedSupp = expansionParams(result, 'used-supplement');
    assert(usedSupp.length === 0, 'used-supplement should not be emitted');
  });

  await expandTest({ id: 200, rawName: 'supplement: extra requested inline supplement may be irrelevant without error', name: 'Extra requested inline supplement may be irrelevant without error', category: 'Supplements' }, async () => {
    const [cs, relSupp] = suppFixture(
      'http://example.org/cs-s2b', 'http://example.org/supp-s2b-rel',
      [{code:'X', display:'Xray'}],
      [{code:'X', designation:[{language:'de', value:'Rontgen'}]}]
    );
    const [, irrSupp] = suppFixture(
      'http://example.org/cs-s2c', 'http://example.org/supp-s2b-irr',
      [{code:'Y', display:'Yankee'}],
      [{code:'Y', designation:[{language:'de', value:'Ypsilon'}]}]
    );
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'X'}]}),
      {
        txResources: [cs, relSupp, irrSupp],
        includeDesignations: true,
        displayLanguage: 'de',
        params: [
          {name:'useSupplement', valueString: relSupp.url},
          {name:'useSupplement', valueString: irrSupp.url},
        ],
      }
    );
    const x = findCode(result, 'X');
    assert(x, 'code X missing');
  });

  await expandTest({ id: 128, rawName: 'supplement: valueset-supplement extension activates', name: 'ValueSet supplement extension activates supplement application', category: 'Supplements' }, async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s3', 'http://example.org/supp-s3',
      [{code:'M', display:'Mike'}],
      [{code:'M', designation:[{language:'es', value:'Miguel'}]}]
    );
    // Use VS extension instead of useSupplement parameter
    const vsJson = vs({system:cs.url, concept:[{code:'M'}]});
    vsJson.extension = [{
      url: 'http://hl7.org/fhir/StructureDefinition/valueset-supplement',
      valueCanonical: supp.url,
    }];
    const { result } = await expand(vsJson,
      { txResources: [cs, supp], includeDesignations: true });
    const m = findCode(result, 'M');
    const esDes = (m?.designation||[]).find(d => d.language === 'es');
    assert(esDes?.value === 'Miguel', `expected Miguel, got ${esDes?.value}`);
  });

  await expandTest({ id: 129, rawName: 'supplement: used-supplement deduped', name: 'used-supplement parameter is deduplicated', category: 'Supplements' }, async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s4', 'http://example.org/supp-s4',
      [{code:'P', display:'Papa'}, {code:'Q', display:'Quebec'}],
      [{code:'P', designation:[{language:'de', value:'Pp'}]},
       {code:'Q', designation:[{language:'de', value:'Qq'}]}]
    );
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'P'},{code:'Q'}]}),
      { txResources: [cs, supp], includeDesignations: true,
        params: [{name:'useSupplement', valueString: supp.url}] }
    );
    const usedSupp = expansionParams(result, 'used-supplement');
    assert(usedSupp.length === 1, `used-supplement should appear once, got ${usedSupp.length}`);
  });

  await expandTest({ id: 130, rawName: 'supplement: missing required fails', name: 'Missing required supplement fails expansion', category: 'Supplements' }, async () => {
    const cs = {
      resourceType: 'CodeSystem', url: 'http://example.org/cs-s5',
      content: 'complete', concept: [{code:'Z', display:'Zulu'}],
    };
    try {
      await expand(
        vs({system:cs.url, concept:[{code:'Z'}]}),
        { txResources: [cs],
          params: [{name:'useSupplement', valueString:'http://example.org/nonexistent'}] }
      );
      assert(false, 'expected error for missing supplement');
    } catch (e) {
      assert(e.message.includes('not found') || e.message.includes('supplement'),
        `expected supplement error, got: ${e.message}`);
    }
  });

  await expandTest({ id: 131, rawName: 'supplement: missing VS extension supplement fails', name: 'Missing ValueSet supplement extension fails expansion', category: 'Supplements' }, async () => {
    const cs = {
      resourceType: 'CodeSystem', url: 'http://example.org/cs-s6',
      content: 'complete', concept: [{code:'Y', display:'Yankee'}],
    };
    const vsJson = vs({system:cs.url, concept:[{code:'Y'}]});
    vsJson.extension = [{
      url: 'http://hl7.org/fhir/StructureDefinition/valueset-supplement',
      valueCanonical: 'http://example.org/missing-supp',
    }];
    try {
      await expand(vsJson, { txResources: [cs] });
      assert(false, 'expected error for missing VS extension supplement');
    } catch (e) {
      assert(e.message.includes('not found') || e.message.includes('supplement'),
        `expected supplement error, got: ${e.message}`);
    }
  });

  await expandTest({ id: 132, rawName: 'supplement: designation filter selects supplement use-coded designation', name: 'Designation filter selects supplement use-coded designation', category: 'Supplements' }, async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s7', 'http://example.org/supp-s7',
      [{code:'D', display:'Delta'}],
      [{code:'D', designation:[{
        language:'en',
        use:{system:'http://example.org/use', code:'abbrev'},
        value:'DLT'
      }]}]
    );
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'D'}]}),
      { txResources: [cs, supp], includeDesignations: true,
        params: [
          {name:'useSupplement', valueString: supp.url},
          {name:'designation', valueString:'http://example.org/use|abbrev'},
        ]}
    );
    const d = findCode(result, 'D');
    const desigs = d?.designation || [];
    assert(desigs.length === 1, `expected 1 filtered designation, got ${desigs.length}`);
    assert(desigs[0].value === 'DLT', `expected DLT, got ${desigs[0].value}`);
  });

  await expandTest({ id: 133, rawName: 'supplement: version-pinned canonical accepted', name: 'Version-pinned supplement canonical is accepted', category: 'Supplements' }, async () => {
    const [cs, supp] = suppFixture(
      'http://example.org/cs-s8', 'http://example.org/supp-s8',
      [{code:'V', display:'Victor'}],
      [{code:'V', designation:[{language:'ja', value:'\u30D3\u30AF\u30BF\u30FC'}]}],
      { suppVersion: '1.0' }
    );
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'V'}]}),
      { txResources: [cs, supp], includeDesignations: true,
        params: [{name:'useSupplement', valueString: supp.url + '|1.0'}] }
    );
    const v = findCode(result, 'V');
    const jaDes = (v?.designation||[]).find(d => d.language === 'ja');
    assert(jaDes, 'version-pinned supplement designation should appear');
  });

  await expandTest({ id: 201, rawName: 'supplement: extra requested configured sqlite supplement may be irrelevant without error', name: 'Extra requested configured sqlite supplement may be irrelevant without error', category: 'Supplements' }, async () => {
    const { result } = await expand(
      vs({ system: 'http://example.org/op-harness-base', concept: [{ code: 'C0001' }] }),
      {
        includeDesignations: true,
        displayLanguage: 'de',
        params: [
          { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
          { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d8' },
        ],
      }
    );
    const concept = findCode(result, 'C0001');
    assert(concept, 'code C0001 missing');
  });

  await expandTest({ id: 134, rawName: 'supplement: itemWeight extension projected', name: 'itemWeight supplement extension is projected', category: 'Supplements' }, async () => {
    const cs = {
      resourceType: 'CodeSystem', url: 'http://example.org/cs-s9',
      content: 'complete',
      concept: [{code:'W', display:'Whiskey'}],
    };
    const supp = {
      resourceType: 'CodeSystem', url: 'http://example.org/supp-s9',
      content: 'supplement', supplements: cs.url,
      concept: [{
        code: 'W',
        extension: [{
          url: 'http://hl7.org/fhir/StructureDefinition/itemWeight',
          valueDecimal: 3.5,
        }],
      }],
    };
    const { result } = await expand(
      vs({system:cs.url, concept:[{code:'W'}]}),
      { txResources: [cs, supp],
        params: [
          {name:'useSupplement', valueString: supp.url},
          {name:'property', valueString:'http://hl7.org/fhir/StructureDefinition/itemWeight'},
        ]}
    );
    const w = findCode(result, 'W');
    const propExt = (w?.extension || []).find(
      e => e.url === 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.expansion.contains.property'
        && (e.extension || []).some(part => part.url === 'code' && part.valueCode === 'weight')
    );
    assert(propExt, 'itemWeight should be projected as contains.property backport');
    const valuePart = (propExt.extension || []).find((part) => part.url === 'value');
    assert(valuePart?.valueDecimal === 3.5, `expected 3.5, got ${valuePart?.valueDecimal}`);
    assert(!(w?.extension || []).some(
      e => e.url === 'http://hl7.org/fhir/StructureDefinition/itemWeight'
    ), 'raw itemWeight extension should not be emitted');
    const expansionPropExt = (result?.expansion?.extension || []).find(
      e => e.url === 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.expansion.property'
        && (e.extension || []).some(part => part.url === 'code' && part.valueCode === 'weight')
    );
    assert(expansionPropExt, 'itemWeight property definition should be declared on the expansion');
  });

  // ── Phase 5: v0 supplement paths ──

  await expandTest({ id: 135, rawName: 'supplement: inline supplement adds designation to SNOMED v0 code', name: 'Inline supplement adds designation to SNOMED v0 concept', category: 'Supplements' }, async () => {
    const supp = {
      resourceType: 'CodeSystem', url: 'http://example.org/sct-supp-test',
      content: 'supplement', supplements: SYS.SCT,
      concept: [{code:'73211009', designation:[{language:'de', value:'Zuckerkrankheit'}]}],
    };
    const { result } = await expand(
      vs({system:SYS.SCT, concept:[{code:'73211009'}]}),
      { txResources: [supp], includeDesignations: true,
        params: [{name:'useSupplement', valueString: supp.url}] }
    );
    const dm = findCode(result, '73211009');
    assert(dm, 'missing 73211009');
    const deDes = (dm.designation||[]).find(d => d.language === 'de' && d.value === 'Zuckerkrankheit');
    assert(deDes, 'German designation from supplement should appear');
  });

  await expandTest({ id: 136, rawName: 'supplement: inline supplement designation appears on LOINC v0 code', name: 'Inline supplement designation appears on LOINC v0 concept', category: 'Supplements' }, async () => {
    const supp = {
      resourceType: 'CodeSystem', url: 'http://example.org/loinc-supp-test',
      content: 'supplement', supplements: SYS.LOINC,
      concept: [{
        code: '2160-0',
        designation: [{
          language: 'en',
          use: {
            system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
            code: 'preferredForLanguage',
          },
          value: 'Creatinine [Custom Override]',
        }],
      }],
    };
    const { result } = await expand(
      vs({system:SYS.LOINC, concept:[{code:'2160-0'}]}),
      { txResources: [supp], includeDesignations: true,
        params: [
          {name:'useSupplement', valueString: supp.url},
        ] }
    );
    const cr = findCode(result, '2160-0');
    assert(cr, 'missing 2160-0');
    const enDes = (cr.designation || []).find(d => d.language === 'en' && d.value === 'Creatinine [Custom Override]');
    assert(enDes, 'expected supplement designation to be present');
  });

  await expandTest({ id: 195, rawName: 'supplement: inline supplement property filter paginates on LOINC v0', name: 'Inline supplement property filter paginates correctly on SQLite v0', category: 'Supplements' }, async () => {
    const supp = {
      resourceType: 'CodeSystem', url: 'http://example.org/loinc-supp-roll',
      content: 'supplement', supplements: SYS.LOINC,
      concept: [
        { code: '2160-0', property: [{ code: 'd20-roll', valueInteger: 20 }] },
        { code: '2345-7', property: [{ code: 'd20-roll', valueInteger: 20 }] },
      ],
    };
    const { result } = await expand(
      vs({ system: SYS.LOINC, filter: [{ property: 'd20-roll', op: '=', value: '20' }] }),
      {
        txResources: [supp],
        count: 1,
        offset: 1,
        params: [{ name: 'useSupplement', valueString: supp.url }],
      }
    );
    eq(result.expansion.total, 2, 'total');
    eq(codes(result).length, 1, 'page size');
    eq(codes(result)[0]?.code, '2345-7', 'second paged code');
  });

  await expandTest({ id: 196, rawName: 'supplement: inline supplement numeric filter paginates on US states adapter', name: 'Inline supplement numeric filter paginates correctly on adapter-backed US states', category: 'Supplements' }, async () => {
    const supp = {
      resourceType: 'CodeSystem', url: 'http://example.org/usps-supp-roll',
      content: 'supplement', supplements: SYS.USPS,
      concept: [
        { code: 'OK', property: [{ code: 'd20-roll', valueInteger: 20 }] },
        { code: 'TX', property: [{ code: 'd20-roll', valueInteger: 20 }] },
      ],
    };
    const { result } = await expand(
      vs({ system: SYS.USPS, filter: [{ property: 'd20-roll', op: '=', value: '20' }] }),
      {
        txResources: [supp],
        count: 1,
        offset: 1,
        params: [{ name: 'useSupplement', valueString: supp.url }],
      }
    );
    eq(result.expansion.total, 2, 'total');
    eq(codes(result).length, 1, 'page size');
    eq(codes(result)[0]?.code, 'TX', 'second paged code');
  });

  await expandTest({ id: 197, rawName: 'supplement: inline supplement text filter applies on UCUM adapter', name: 'Inline supplement designation text filter works on adapter-backed UCUM', category: 'Supplements' }, async () => {
    const supp = {
      resourceType: 'CodeSystem', url: 'http://example.org/ucum-supp-text',
      content: 'supplement', supplements: SYS.UCUM,
      concept: [
        { code: 'm', designation: [{ language: 'en', value: 'Lone metre bonus' }] },
        { code: 'cm', designation: [{ language: 'en', value: 'Grouped centimetre bonus' }] },
      ],
    };
    const { result } = await expand(
      vs({ system: SYS.UCUM, concept: [{ code: 'm' }, { code: 'cm' }, { code: 'kg' }] }),
      {
        filter: 'Lone metre bonus',
        txResources: [supp],
        params: [{ name: 'useSupplement', valueString: supp.url }],
      }
    );
    eq(result.expansion.total, 2, 'total');
    eq(codes(result).length, 2, 'filtered code count');
    assert(findCode(result, 'm'), 'includes metre');
    assert(findCode(result, 'cm'), 'includes centimetre via OR token match');
  });

  if (HARNESS_SQLITE_SUPP_URL_ROOT) {
    const harnessSuppUrl = (die) => `${HARNESS_SQLITE_SUPP_URL_ROOT}/loinc-org/${die}`;
    const harnessSuppCanonical = (die) => `${harnessSuppUrl(die)}|1`;

    await expandTest({ id: 198, rawName: 'supplement: configured sqlite sidecars support multi-supplement distinct filters on LOINC v0', name: 'Configured sqlite sidecars support multi-supplement distinct filters on SQLite v0', category: 'Supplements' }, async () => {
      const { result } = await expand(
        vs({
          system: SYS.LOINC,
          filter: [
            { property: 'd20-roll', op: '=', value: '20' },
            { property: 'd8-roll', op: '=', value: '2' },
          ],
        }),
        {
          count: 5,
          offset: 10,
          includeDesignations: true,
          params: [
            { name: 'useSupplement', valueString: harnessSuppUrl('d20') },
            { name: 'useSupplement', valueString: harnessSuppUrl('d8') },
          ],
        }
      );
      assert(result.expansion.total > 5000, `expected large intersected supplement total, got ${result.expansion.total}`);
      const page = codes(result);
      eq(page.length, 5, 'page size');
      const usedSupp = expansionParams(result, 'used-supplement').map(p => p.valueUri).sort();
      eq(JSON.stringify(usedSupp), JSON.stringify([harnessSuppCanonical('d20'), harnessSuppCanonical('d8')].sort()), 'used-supplement canonicals');
      for (const concept of page) {
        assert((concept.designation || []).some(d => d.value === 'D20 critical success'),
          `expected D20 critical success designation on ${concept.code}`);
      }
    });

    await expandTest({ id: 199, rawName: 'supplement: configured sqlite sidecar designation text filter works on LOINC v0', name: 'Configured sqlite sidecar designation text filter works on SQLite v0', category: 'Supplements' }, async () => {
      const { result } = await expand(
        vs({ system: SYS.LOINC }),
        {
          filter: 'critical',
          count: 5,
          params: [
            { name: 'useSupplement', valueString: harnessSuppUrl('d20') },
          ],
        }
      );
      assert(result.expansion.total > 10000, `expected many supplement text matches, got ${result.expansion.total}`);
      eq(codes(result).length, 5, 'page size');
      const usedSupp = expansionParams(result, 'used-supplement');
      assert(usedSupp.some(p => p.valueUri === harnessSuppCanonical('d20')),
        `expected used-supplement ${harnessSuppCanonical('d20')}`);
    });
  }

  // ── Phase 6: grammar-based provider handling ──

  await expandTest({ id: 137, rawName: 'notClosed: UCUM expansion reports valueset-unclosed', name: 'UCUM expansion reports valueset-unclosed', category: 'Unclosed Expansion' }, async () => {
    const { result } = await expand(vs({system:SYS.UCUM}), {count:5});
    const c = codes(result);
    assert(c.length === 5, `expected 5, got ${c.length}`);
    assert(result.expansion.total == null, `unclosed expansion should omit total, got ${result.expansion.total}`);
    const unclosed = expansionExtensions(result, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
    eq(unclosed.length, 1, `expected exactly one valueset-unclosed extension, got ${JSON.stringify(unclosed)}`);
    eq(unclosed[0].valueBoolean, true, `expected valueset-unclosed valueBoolean=true, got ${JSON.stringify(unclosed[0])}`);
    assert(unclosed[0].valueString == null, `valueset-unclosed must not use valueString, got ${JSON.stringify(unclosed[0])}`);
    assert(hasExpansionParam(result, 'warning-draft'),
      `expected warning-draft parameter, got params: ${JSON.stringify(result.expansion?.parameter)}`);
  });

  await expandTest({ id: 138, rawName: 'notClosed: MIME whole-system not enumerable', name: 'MIME whole-system expansion is not enumerable', category: 'Unclosed Expansion' }, async () => {
    // Should return an OperationOutcome with too-costly (expand() throws on OO)
    try {
      await expand(vs({system:SYS.MIME}));
      assert(false, 'expected too-costly error');
    } catch (e) {
      assert(e.message.includes('grammar'), `error should mention grammar, got: ${e.message}`);
    }
  });

  await expandTest({ id: 139, rawName: 'coverage: MIME concept + language peer', name: 'MIME concept include with language peer', category: 'Cross-Source Coverage' }, async () => {
    const { result } = await expand(vs([
      {system:SYS.MIME, concept:[{code:'text/html'},{code:'application/json'}]},
      {system:SYS.LANG, concept:[{code:'en'}]},
    ]));
    assert(result.expansion.total === 3, `expected 3, got ${result.expansion.total}`);
    assert(findCode(result,'text/html'), 'MIME text/html should be present');
    assert(findCode(result,'en'), 'language en should be present');
  });

  // ── Phase 7: limit enforcement ──

  await expandTest({ id: 140, rawName: 'limit: SNOMED whole-system exceeds default limit → too-costly', name: 'SNOMED whole-system exceeds default limit -> too-costly', category: 'Safety Limits' }, async () => {
    try {
      await expand(vs({system:SYS.SCT}));
      assert(false, 'expected too-costly error');
    } catch (e) {
      assert(e.message.includes('too-costly') || e.message.includes('limit') || e.message.includes('codes'),
        `error should mention limit/too-costly, got: ${e.message}`);
    }
  });

  await expandTest({ id: 141, rawName: 'limit: explicit limit=50 rejects US states (62 codes)', name: 'Explicit limit=50 rejects US states (62 codes)', category: 'Safety Limits' }, async () => {
    try {
      await expand(vs({system:SYS.USPS}), {
        params: [{ name: 'limit', valueInteger: 50 }],
      });
      assert(false, 'expected too-costly error');
    } catch (e) {
      assert(e.message.includes('62') || e.message.includes('limit'),
        `error should mention count or limit, got: ${e.message}`);
    }
  });

  await expandTest({ id: 142, rawName: 'limit: pagination bypasses limit for large system', name: 'Pagination bypasses expansion limit for large systems', category: 'Safety Limits' }, async () => {
    const { result } = await expand(vs({system:SYS.SCT}), { offset: 0, count: 10 });
    assert(result.expansion.total > 1000, `SNOMED total should be >1000, got ${result.expansion.total}`);
    assert(result.expansion.contains.length === 10, `expected 10 codes, got ${result.expansion.contains.length}`);
  });

  // ── Phase 8: high-value stress tests ──

  await expandTest({ id: 143, rawName: 'unclosed: multi-system with grammar provider reports unclosed on all pages', name: 'Unclosed multi-system grammar provider reports unclosed on all pages', category: 'Unclosed Expansion' }, async () => {
    // UCUM (grammar-based, unclosed) + SNOMED hand parts.
    // SNOMED sorts first alphabetically, so page 1 is all SNOMED.
    // The unclosed signal must still appear even when UCUM isn't on this page.
    const mixedVS = vs([
      {system:SYS.UCUM},
      {system:SYS.SCT, filter:[{property:'concept',op:'is-a',value:'85562004'}]}, // hand structure
    ]);
    const { result } = await expand(mixedVS, { offset: 0, count: 10 });
    // Page should be all SNOMED (it sorts before UCUM)
    const systems = new Set(codes(result).map(c => c.system));
    assert(systems.has(SYS.SCT), 'first page should have SNOMED codes');
    assert(!systems.has(SYS.UCUM), 'first page should not yet have UCUM codes');
    // But unclosed must still be reported
    const unclosed = expansionExtensions(result, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
    eq(unclosed.length, 1, `expected exactly one valueset-unclosed extension, got ${JSON.stringify(unclosed)}`);
    eq(unclosed[0].valueBoolean, true, `expected valueset-unclosed valueBoolean=true, got ${JSON.stringify(unclosed[0])}`);
    assert(unclosed[0].valueString == null, `valueset-unclosed must not use valueString, got ${JSON.stringify(unclosed[0])}`);
    assert(result.expansion.total == null, `unclosed multi-system expansion should omit total, got ${result.expansion.total}`);
  });

  await expandTest({ id: 144, rawName: 'stress: deep SNOMED is-a pagination stable across adjacent pages', name: 'Deep SNOMED is-a pagination stable across adjacent pages', category: 'Stress & Scale' }, async () => {
    // Two overlapping pages deep into Clinical finding hierarchy
    const isA404684003 = vs({system:SYS.SCT, filter:[{property:'concept',op:'is-a',value:'404684003'}]});
    const { result: p1 } = await expand(isA404684003, withExactTotal({ offset: 50000, count: 20 }));
    const { result: p2 } = await expand(isA404684003, withExactTotal({ offset: 50010, count: 20 }));

    assert(p1.expansion.total === p2.expansion.total, `totals should match: ${p1.expansion.total} vs ${p2.expansion.total}`);
    assert(p1.expansion.total > 100000, `Clinical finding total should be >100k, got ${p1.expansion.total}`);
    assert(p1.expansion.contains.length === 20, `p1 should have 20 codes, got ${p1.expansion.contains.length}`);

    // p1's last 10 codes should equal p2's first 10 codes (overlap region)
    const p1Last10 = p1.expansion.contains.slice(10).map(c => c.code);
    const p2First10 = p2.expansion.contains.slice(0, 10).map(c => c.code);
    assert(JSON.stringify(p1Last10) === JSON.stringify(p2First10),
      'overlapping region should be identical across adjacent pages');
  });

  await expandTest({ id: 145, rawName: 'stress: complex same-system inc/exc with pagination', name: 'Complex same-system include/exclude remains pagination-safe', category: 'Stress & Scale' }, async () => {
    // Include is-a diabetes, exclude two specific codes, paginate
    const complexVS = vs(
      [{system:SYS.SCT, filter:[{property:'concept',op:'is-a',value:'73211009'}]}],
      [{system:SYS.SCT, concept:[{code:'44054006'},{code:'46635009'}]}]
    );
    const { result: full } = await expand(complexVS, { count: 0 });
    assert(full.expansion.total > 100, `expected >100 diabetes descendants, got ${full.expansion.total}`);

    // Paginate and verify excludes are absent
    const { result: p1 } = await expand(complexVS, { offset: 0, count: full.expansion.total });
    const allCodes = codes(p1).map(c => c.code);
    assert(!allCodes.includes('44054006'), 'excluded code 44054006 must not appear');
    assert(!allCodes.includes('46635009'), 'excluded code 46635009 must not appear');
    assert(allCodes.length === full.expansion.total, `all codes should match total: ${allCodes.length} vs ${full.expansion.total}`);
  });

  await expandTest({ id: 146, rawName: 'stress: mixed-system text filter with limit boundary', name: 'Mixed-system text filter respects limit boundary', category: 'Stress & Scale' }, async () => {
    // SNOMED + LOINC filtered by 'glucose' — total > 1000, so unpaginated triggers limit
    const mixedVS = vs([{system:SYS.SCT},{system:SYS.LOINC}]);

    // Unpaginated should fail with too-costly
    try {
      await expand(mixedVS, { filter: 'glucose' });
      assert(false, 'expected too-costly error for mixed-system glucose without pagination');
    } catch (e) {
      assert(e.message.includes('too-costly') || e.message.includes('limit') || e.message.includes('codes'),
        `error should mention limit/too-costly, got: ${e.message}`);
    }

    // With explicit count, should succeed and contain both systems
    const { result } = await expand(mixedVS, { filter: 'glucose', offset: 0, count: 2000 });
    assert(result.expansion.total > 1000, `mixed-system glucose total should be >1000, got ${result.expansion.total}`);
    const systems = new Set(codes(result).map(c => c.system));
    assert(systems.has(SYS.LOINC), 'LOINC codes should be present');
    assert(systems.has(SYS.SCT), 'SNOMED codes should be present');
  });

  await expandTest({ id: 147, rawName: 'stress: include.valueSet + sibling filter at scale', name: 'include.valueSet plus sibling filter scales correctly', category: 'Stress & Scale' }, async () => {
    // Import a published VS (observation-codes = LOINC whole-system) with a SNOMED filter peer
    const { result } = await expand(vs([
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      { system: SYS.LOINC, concept: [{ code: '2339-0' }, { code: '2345-7' }] },
    ]), { count: 200 });
    const c = codes(result);
    assert(c.length > 10, `expected many codes, got ${c.length}`);
    const systems = new Set(c.map(x => x.system));
    assert(systems.has(SYS.SCT), 'SNOMED codes should be present');
    assert(systems.has(SYS.LOINC), 'LOINC codes should be present');
    assert(findCode(result, '2339-0'), 'LOINC 2339-0 should be present');
  });

  // ── Property filter config (sources, linkMatch, aliases) ──

  await expandTest({ id: 148, rawName: 'filter: LOINC SCALE_TYP=Doc uses concept_literal + code-or-display', name: 'LOINC SCALE_TYP=Doc uses concept_literal plus code-or-display', category: 'Filter Semantics' }, async () => {
    // SCALE_TYP is concept-valued but LOINC stores filterable values in
    // both concept_literal (value_text) and concept_link (target display).
    // The filter value 'Doc' matches target concept LP32888-7's display.
    const { result } = await expand(vs({
      system: SYS.LOINC,
      filter: [{ property: 'SCALE_TYP', op: '=', value: 'Doc' }],
    }), { count: 5 });
    assert(result.expansion.total > 10000,
      `LOINC SCALE_TYP=Doc should have >10k codes, got ${result.expansion.total}`);
  });

  await expandTest({ id: 149, rawName: 'filter: LOINC ORDER_OBS=Observation uses literal source with alias', name: 'LOINC ORDER_OBS=Observation uses literal source with alias', category: 'Filter Semantics' }, async () => {
    // ORDER_OBS config: sources=["literal"], value.aliases={"observation":"Observation"}
    const { result } = await expand(vs({
      system: SYS.LOINC,
      filter: [{ property: 'ORDER_OBS', op: '=', value: 'Observation' }],
    }), { count: 5 });
    assert(result.expansion.total > 100,
      `LOINC ORDER_OBS=Observation should have many codes, got ${result.expansion.total}`);
  });

  await expandTest({ id: 150, rawName: 'filter: LOINC CLASS=CHEM via dual sources', name: 'LOINC CLASS=CHEM via dual sources', category: 'Filter Semantics' }, async () => {
    // CLASS config: sources=["literal","link"], linkMatch=code-or-display
    const { result } = await expand(vs({
      system: SYS.LOINC,
      filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }],
    }), { count: 5 });
    assert(result.expansion.total > 100,
      `LOINC CLASS=CHEM should have many codes, got ${result.expansion.total}`);
  });

  await expandTest({ id: 151, rawName: 'filter: RxNorm TTY=SCD uses literal source', name: 'RxNorm TTY=SCD uses literal source', category: 'Filter Semantics' }, async () => {
    // RxNorm TTY config: sources=["literal"]
    const { result } = await expand(vs({
      system: SYS.RXNORM,
      filter: [{ property: 'TTY', op: '=', value: 'SCD' }],
    }), { count: 5 });
    assert(result.expansion.total > 100,
      `RxNorm TTY=SCD should have many codes, got ${result.expansion.total}`);
  });

  // ── Phase 9: hierarchical expansion ──────────────────────────────────
  // These test that the IR engine produces hierarchical (nested .contains)
  // output matching the legacy engine for cs-cs providers with hierarchy.

  // Helper: collect only top-level contains (no recursion)
  function topLevel(result) {
    return (result.expansion?.contains || []);
  }

  // Helper: check if result has any nested .contains
  function hasNesting(result) {
    for (const c of result.expansion?.contains || []) {
      if (c.contains && c.contains.length > 0) return true;
    }
    return false;
  }

  // Helper: collect all codes from nested structure, with depth info
  function codesWithDepth(result) {
    const out = [];
    const walk = (items, depth) => {
      for (const c of items || []) {
        out.push({ code: c.code, display: c.display, depth });
        walk(c.contains, depth + 1);
      }
    };
    walk(result.expansion?.contains, 0);
    return out;
  }

  // Helper: get children of a specific code in the expansion
  function childrenOf(result, parentCode) {
    const find = (items) => {
      for (const c of items || []) {
        if (c.code === parentCode) return (c.contains || []).map(x => x.code);
        const sub = find(c.contains);
        if (sub) return sub;
      }
      return null;
    };
    return find(result.expansion?.contains) || [];
  }

  // ── 9.1: whole-system hierarchy (default, excludeNested not set) ──

  await expandTest({ id: 152, rawName: 'hierarchy: condition-clinical whole-system has nested structure', name: 'Condition-clinical whole-system preserves nested structure', category: 'Hierarchy' }, async () => {
    // Current upstream resolution selects the R4 core CodeSystem:
    // active→[recurrence,relapse], inactive→[remission,resolved].
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }),
    );
    eq(result.expansion.total, 6, 'total');
    assert(hasNesting(result), 'should have nested .contains');
    // Top-level should be roots only
    const roots = topLevel(result).map(c => c.code);
    assert(roots.includes('active'), 'active is root');
    assert(roots.includes('inactive'), 'inactive is root');
    assert(!roots.includes('recurrence'), 'recurrence should be nested, not root');
    assert(!roots.includes('remission'), 'remission should be nested, not root');
    // Check parent-child relationships
    const activeKids = childrenOf(result, 'active');
    assert(activeKids.includes('recurrence'), 'recurrence is child of active');
    assert(activeKids.includes('relapse'), 'relapse is child of active');
    const inactiveKids = childrenOf(result, 'inactive');
    assert(inactiveKids.includes('remission'), 'remission is child of inactive');
    assert(inactiveKids.includes('resolved'), 'resolved is child of inactive');
  });

  await expandTest({ id: 153, rawName: 'hierarchy: condition-ver-status whole-system has nested structure', name: 'Condition-ver-status whole-system preserves nested structure', category: 'Hierarchy' }, async () => {
    // unconfirmed→[provisional,differential], confirmed, refuted, entered-in-error
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }),
    );
    eq(result.expansion.total, 6, 'total');
    assert(hasNesting(result), 'should have nested .contains');
    const roots = topLevel(result).map(c => c.code);
    assert(!roots.includes('provisional'), 'provisional should be nested');
    assert(!roots.includes('differential'), 'differential should be nested');
    const kids = childrenOf(result, 'unconfirmed');
    assert(kids.includes('provisional'), 'provisional is child of unconfirmed');
    assert(kids.includes('differential'), 'differential is child of unconfirmed');
  });

  await expandTest({ id: 154, rawName: 'hierarchy: goal-achievement multi-level nesting preserved', name: 'Goal-achievement preserves multi-level nesting', category: 'Hierarchy' }, async () => {
    // in-progress→[improving,worsening,no-change], achieved→[sustaining],
    // not-achieved→[no-progress,not-attainable]
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/goal-achievement' }),
    );
    eq(result.expansion.total, 9, 'total');
    assert(hasNesting(result), 'should have nested .contains');
    const roots = topLevel(result).map(c => c.code);
    eq(roots.length, 3, 'three root codes');
    const ipKids = childrenOf(result, 'in-progress');
    eq(ipKids.length, 3, 'in-progress has 3 children');
    const naKids = childrenOf(result, 'not-achieved');
    eq(naKids.length, 2, 'not-achieved has 2 children');
  });

  await expandTest({ id: 155, rawName: 'hierarchy: total counts all codes including nested', name: 'Total counts all codes including nested descendants', category: 'Hierarchy' }, async () => {
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }),
    );
    // total should be 6 (all codes), not 2 (root count)
    eq(result.expansion.total, 6, 'total includes nested codes');
    // Recursive walk should also find 6
    eq(codes(result).length, 6, 'recursive walk finds all 6');
  });

  // ── 9.2: excludeNested=true → flat output ──

  await expandTest({ id: 156, rawName: 'hierarchy: excludeNested=true returns flat condition-clinical', name: 'excludeNested=true flattens condition-clinical expansion', category: 'Hierarchy' }, async () => {
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }),
      { excludeNested: true },
    );
    eq(result.expansion.total, 6, 'total');
    assert(!hasNesting(result), 'should NOT have nested .contains');
    // All 6 codes at top level
    eq(topLevel(result).length, 6, 'all codes at top level');
    const allCodes = topLevel(result).map(c => c.code);
    assert(allCodes.includes('recurrence'), 'recurrence at top level');
    assert(allCodes.includes('remission'), 'remission at top level');
  });

  await expandTest({ id: 157, rawName: 'hierarchy: excludeNested=true on goal-achievement is flat', name: 'excludeNested=true flattens goal-achievement expansion', category: 'Hierarchy' }, async () => {
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/goal-achievement' }),
      { excludeNested: true },
    );
    eq(result.expansion.total, 9, 'total');
    assert(!hasNesting(result), 'should NOT have nested .contains');
    eq(topLevel(result).length, 9, 'all 9 codes flat');
  });

  // ── 9.3: pagination forces flat ──

  await expandTest({ id: 158, rawName: 'hierarchy: offset > 0 forces flat even on hierarchical CS', name: 'Offset > 0 flattens hierarchical expansion', category: 'Hierarchy' }, async () => {
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }),
      { offset: 1, count: 3 },
    );
    assert(!hasNesting(result), 'paginated result should be flat');
    eq(result.expansion.total, 6, 'total still 6');
  });

  await expandTest({ id: 159, rawName: 'hierarchy: count < total forces flat', name: 'count < total flattens hierarchical expansion', category: 'Hierarchy' }, async () => {
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }),
      { count: 3 },
    );
    assert(!hasNesting(result), 'partial page should be flat');
    eq(result.expansion.total, 6, 'total still 6');
  });

  await expandTest({ id: 160, rawName: 'hierarchy: count >= total allows nesting', name: 'count >= total preserves hierarchical nesting', category: 'Hierarchy' }, async () => {
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }),
      { count: 100 },
    );
    assert(hasNesting(result), 'count >= total should allow nesting');
    eq(result.expansion.total, 6, 'total');
  });

  // ── 9.4: non-hierarchical CS is unaffected ──

  await expandTest({ id: 161, rawName: 'hierarchy: non-hierarchical CS (gender) is always flat', name: 'Non-hierarchical CodeSystem (gender) is always flat', category: 'Hierarchy' }, async () => {
    const { result } = await expand(
      vs({ system: 'http://hl7.org/fhir/administrative-gender' }),
    );
    eq(result.expansion.total, 4, 'total');
    assert(!hasNesting(result), 'gender has no hierarchy');
    eq(topLevel(result).length, 4, 'all 4 at top level');
  });

  // ── 9.5: concept enumeration (not whole-system) ──

  await expandTest({ id: 162, rawName: 'hierarchy: concept enumeration from hierarchical CS is flat', name: 'Concept enumeration from hierarchical CodeSystem is flat', category: 'Hierarchy' }, async () => {
    // Requesting specific codes — no hierarchy regardless
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
           concept: [{ code: 'active' }, { code: 'recurrence' }, { code: 'inactive' }] }),
    );
    eq(codes(result).length, 3, 'three codes returned');
    // Even though active→recurrence in the full system, concept enumeration
    // should not nest (only whole-system iteration walks the tree)
    assert(!hasNesting(result), 'concept enumeration should be flat');
  });

  // ── 9.6: filter on hierarchical CS ──

  await expandTest({ id: 163, rawName: 'hierarchy: filter on hierarchical CS uses parent() for nesting', name: 'Filtered hierarchical expansion nests children under parent', category: 'Hierarchy' }, async () => {
    // Use is-a filter on condition-clinical to get a subtree
    // is-a 'active' should return: active, recurrence, relapse
    const { result } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
           filter: [{ property: 'concept', op: 'is-a', value: 'active' }] }),
    );
    eq(result.expansion.total, 3, 'active subtree has 3 codes');
    const allCodes = codes(result).map(c => c.code);
    assert(allCodes.includes('active'), 'has active');
    assert(allCodes.includes('recurrence'), 'has recurrence');
    assert(allCodes.includes('relapse'), 'has relapse');
    // Should be nested: active → [recurrence, relapse]
    assert(hasNesting(result), 'is-a filter result should be nested');
    const activeKids = childrenOf(result, 'active');
    assert(activeKids.includes('recurrence'), 'recurrence under active');
    assert(activeKids.includes('relapse'), 'relapse under active');
  });

  // ── 9.7: IR matches legacy for hierarchical output ──

  await expandTest({ id: 164, rawName: 'hierarchy: IR matches legacy for condition-clinical', name: 'IR matches legacy for condition-clinical hierarchy', category: 'Hierarchy' }, async () => {
    const { result: ir } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }),
      {}, 'ir',
    );
    const { result: legacy } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }),
      {}, 'legacy',
    );
    // Same total
    eq(ir.expansion.total, legacy.expansion.total, 'totals match');
    // Same set of codes
    const irCodes = codes(ir).map(c => c.code).sort();
    const legCodes = codes(legacy).map(c => c.code).sort();
    eq(JSON.stringify(irCodes), JSON.stringify(legCodes), 'same code sets');
    // Same nesting structure
    const irNested = hasNesting(ir);
    const legNested = hasNesting(legacy);
    eq(irNested, legNested, 'both have same nesting');
    // Same root codes
    const irRoots = topLevel(ir).map(c => c.code).sort();
    const legRoots = topLevel(legacy).map(c => c.code).sort();
    eq(JSON.stringify(irRoots), JSON.stringify(legRoots), 'same root codes');
  });

  await expandTest({ id: 165, rawName: 'hierarchy: IR matches legacy for goal-achievement', name: 'IR matches legacy for goal-achievement hierarchy', category: 'Hierarchy' }, async () => {
    const { result: ir } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/goal-achievement' }),
      {}, 'ir',
    );
    const { result: legacy } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/goal-achievement' }),
      {}, 'legacy',
    );
    eq(ir.expansion.total, legacy.expansion.total, 'totals match');
    const irRoots = topLevel(ir).map(c => c.code).sort();
    const legRoots = topLevel(legacy).map(c => c.code).sort();
    eq(JSON.stringify(irRoots), JSON.stringify(legRoots), 'same root codes');
    // Check a specific subtree matches
    const irIpKids = childrenOf(ir, 'in-progress').sort();
    const legIpKids = childrenOf(legacy, 'in-progress').sort();
    eq(JSON.stringify(irIpKids), JSON.stringify(legIpKids), 'in-progress children match');
  });

  await expandTest({ id: 166, rawName: 'hierarchy: IR matches legacy excludeNested=true', name: 'IR matches legacy when excludeNested=true', category: 'Hierarchy' }, async () => {
    const { result: ir } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }),
      { excludeNested: true }, 'ir',
    );
    const { result: legacy } = await expand(
      vs({ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }),
      { excludeNested: true }, 'legacy',
    );
    assert(!hasNesting(ir), 'IR flat');
    assert(!hasNesting(legacy), 'legacy flat');
    const irCodes = codes(ir).map(c => c.code).sort();
    const legCodes = codes(legacy).map(c => c.code).sort();
    eq(JSON.stringify(irCodes), JSON.stringify(legCodes), 'same codes when flat');
  });

  // ── imported scale / runtime-shape coverage ───────────────────────────
  log('\n=== Imported Scale & Runtime Shape ==='); setCategory('Imported scale');

  await expandTest({ id: 167, rawName: 'stress: imported same-system intersection matches direct diabetes subset', name: 'Imported SNOMED intersection scales like direct diabetes subset', category: 'Stress & Scale' }, async () => {
    const importedClinical = inlineVS('http://example.org/vs/imported-sct-clinical-finding', {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });
    const importedDiabetes = inlineVS('http://example.org/vs/imported-sct-diabetes', {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    });
    const importedRoot = vs({
      system: SYS.SCT,
      valueSet: [importedClinical.url, importedDiabetes.url],
    });
    const directDiabetes = vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    });

    const { result: directTotal } = await expand(directDiabetes, { activeOnly: true, count: 0 });
    const { result: directPage } = await expand(directDiabetes, { activeOnly: true, count: 20 });
    const targetOpts = { txResources: [importedClinical, importedDiabetes], activeOnly: true, count: 20 };
    const { result } = await expand(
      importedRoot,
      targetOpts,
    );
    eq(result.expansion.total, directTotal.expansion.total, 'imported intersection total matches direct');
    eq(codes(result).length, 20, 'page size');
    eq(
      JSON.stringify(codes(result).map(c => c.code)),
      JSON.stringify(codes(directPage).map(c => c.code)),
      'imported first page matches direct first page',
    );
    setPerfTarget(importedRoot, targetOpts);
  });

  await expandTest({ id: 168, rawName: 'stress: imported same-system diff preserves deep pagination', name: 'Imported SNOMED diff preserves deep pagination', category: 'Stress & Scale', perfOnly: true }, async () => {
    const importedClinical = inlineVS('http://example.org/vs/imported-sct-clinical-finding-deep', {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });
    const importedDiabetes = inlineVS('http://example.org/vs/imported-sct-diabetes-deep', {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    });
    const importedDiff = vs(
      { valueSet: [importedClinical.url] },
      { valueSet: [importedDiabetes.url] },
    );
    const directDiff = vs(
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] },
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    );

    const fullOpts = {
      txResources: [importedClinical, importedDiabetes],
      activeOnly: true,
      count: 0,
    };
    const { result: full } = await expand(importedDiff, fullOpts);
    assert(full.expansion.total > 40, `expected imported diff to return enough rows for deep pagination, got ${full.expansion.total}`);

    const offset = Math.max(0, full.expansion.total - 40);
    const targetOpts = withExactTotal({ txResources: [importedClinical, importedDiabetes], activeOnly: true, offset, count: 20 });
    const { result: importedPage, traceJson } = await expand(
      importedDiff,
      targetOpts,
      'ir',
      true,
    );
    const { result: directPage } = await expand(directDiff, { activeOnly: true, offset, count: 20 });

    eq(importedPage.expansion.total, full.expansion.total, 'paged total stable');
    eq(codes(importedPage).length, 20, 'deep page size');
    eq(
      JSON.stringify(codes(importedPage).map(c => c.code)),
      JSON.stringify(codes(directPage).map(c => c.code)),
      'imported diff page matches direct diff page',
    );
    assertCompilerMaterializationTrace(traceJson, 'imported diff benchmark');
    setPerfTarget(importedDiff, targetOpts);
  });

  await expandTest({ id: 169, rawName: 'stress: imported multi-system union crosses large-system boundary', name: 'Imported large-system union crosses pagination boundary cleanly', category: 'Stress & Scale', perfOnly: true }, async () => {
    const importedLoincActive = inlineVS('http://example.org/vs/imported-loinc-active', {
      system: SYS.LOINC,
      filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }],
    });
    const importedClinical = inlineVS('http://example.org/vs/imported-sct-clinical-finding-boundary', {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });
    const importedUnion = vs([
      { valueSet: [importedLoincActive.url] },
      { valueSet: [importedClinical.url] },
    ]);

    const { result: loincOnly } = await expand(
      vs({ system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] }),
      { activeOnly: true, count: 0 },
    );
    const { result: snomedOnly } = await expand(
      vs({ system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }),
      { activeOnly: true, count: 0 },
    );

    const boundaryOffset = Math.max(0, loincOnly.expansion.total - 50);
    const targetOpts = {
      txResources: [importedLoincActive, importedClinical],
      activeOnly: true,
      offset: boundaryOffset,
      count: 120,
    };
    const { result, traceJson } = await expand(
      importedUnion,
      targetOpts,
      'ir',
      true,
    );

    eq(result.expansion.total, loincOnly.expansion.total + snomedOnly.expansion.total, 'union total matches direct totals');
    eq(codes(result).length, 120, 'boundary page size');
    const systems = new Set(codes(result).map(c => c.system));
    assert(systems.has(SYS.LOINC), 'boundary page should include LOINC tail');
    assert(systems.has(SYS.SCT), 'boundary page should include SNOMED head');
    assertCompilerMaterializationTrace(traceJson, 'multi-system imported union benchmark');
    setPerfTarget(importedUnion, targetOpts);
  });

  await expandTest({ id: 170, rawName: 'stress: multi-clause LOINC filter scales without fallback', name: 'Multi-clause LOINC filter scales without fallback', category: 'Stress & Scale', perfOnly: true }, async () => {
    const loincCombo = vs({
      system: SYS.LOINC,
      filter: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'CLASS', op: '=', value: 'CHEM' },
      ],
    });

    const { result: totalOnly } = await expand(loincCombo, { count: 0 });
    const targetOpts = { count: 100 };
    const { result, traceJson } = await expand(loincCombo, targetOpts, 'ir', true);
    eq(result.expansion.total, totalOnly.expansion.total, 'paged total matches count=0');
    eq(codes(result).length, Math.min(100, totalOnly.expansion.total), 'page size');
    assert(codes(result).every(c => c.system === SYS.LOINC), 'all results should be LOINC');
    assertCompilerMaterializationTrace(traceJson, 'multi-clause LOINC benchmark');
    setPerfTarget(loincCombo, targetOpts);
  });

  await expandTest({ id: 171, rawName: 'stress: large LOINC designation page hits bulk decoration', name: 'Large LOINC designation page hits bulk decoration', category: 'Designations & Language', perfOnly: true }, async () => {
    const loincActive = vs({
      system: SYS.LOINC,
      filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }],
    });
    const targetOpts = { count: 100, includeDesignations: true };
    const { result, traceJson } = await expand(
      loincActive,
      targetOpts,
      'ir',
      true,
    );
    eq(codes(result).length, 100, 'page size');
    assertBulkDesignationTrace(result, traceJson, 'LOINC designation benchmark');
    setPerfTarget(loincActive, targetOpts);
  });

  await expandTest({ id: 172, rawName: 'stress: large SNOMED designation filter page uses displayLanguage and bulk decoration', name: 'Large SNOMED designation-filter page uses displayLanguage and bulk decoration', category: 'Designations & Language', perfOnly: true }, async () => {
    const targetVS = vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });
    const targetOpts = {
      activeOnly: true,
      count: 50,
      includeDesignations: true,
      params: [
        { name: 'designation', valueString: 'http://snomed.info/sct|900000000000003001' },
        { name: 'displayLanguage', valueCode: 'en' },
      ],
    };
    const { result, traceJson } = await expand(
      targetVS,
      targetOpts,
      'ir',
      true,
    );
    eq(codes(result).length, 50, 'page size');
    assert(hasExpansionParam(result, 'displayLanguage', 'en'), 'displayLanguage should be echoed');
    for (const entry of codes(result)) {
      const desigs = entry.designation || [];
      assert(desigs.length >= 1, `expected FSN designation for ${entry.code}`);
      assert(desigs.every(d => d.use?.code === '900000000000003001'),
        `designation filter should keep only FSNs for ${entry.code}`);
    }
    for (const code of ['10001005', '100191000119105', '100211000119106']) {
      const entry = findCode(result, code);
      assert(entry, `expected ${code} on first page`);
      assert((entry.designation || []).length >= 2,
        `expected multiple matching FSN designations for ${code}`);
    }
    assertBulkDesignationTrace(result, traceJson, 'SNOMED designation benchmark');
    setPerfTarget(targetVS, targetOpts);
  });

  await expandTest({ id: 173, rawName: 'stress: compose.inactive on large SNOMED set matches request-level semantics', name: 'compose.inactive on large SNOMED set matches request-level semantics', category: 'Parameter Handling' }, async () => {
    const baseComponent = { system: SYS.SCT, filter: [{ property: 'code', op: 'regex', value: '^7[0-9]{4,}' }] };
    const baseVS = vs(baseComponent);
    const composeInactiveFalse = inlineVS(
      'http://example.org/vs/compose-inactive-false-large',
      baseComponent,
      null,
      { compose: { inactive: false, include: [baseComponent] } },
    );
    const composeInactiveTrue = inlineVS(
      'http://example.org/vs/compose-inactive-true-large',
      baseComponent,
      null,
      { compose: { inactive: true, include: [baseComponent] } },
    );

    const { result: allCodesResult } = await expand(baseVS, { count: 0, activeOnly: false });
    const { result: requestActiveOnly } = await expand(baseVS, { count: 0, activeOnly: true });
    const { result: composeFalse } = await expand(composeInactiveFalse, { count: 0, activeOnly: false });
    const { result: composeTrue } = await expand(composeInactiveTrue, { count: 0, activeOnly: false });

    assert(allCodesResult.expansion.total > requestActiveOnly.expansion.total,
      `expected inactive concepts in the large SNOMED set, got all=${allCodesResult.expansion.total} active=${requestActiveOnly.expansion.total}`);
    eq(composeFalse.expansion.total, requestActiveOnly.expansion.total, 'compose.inactive=false should match activeOnly=true');
    eq(composeTrue.expansion.total, allCodesResult.expansion.total, 'compose.inactive=true should preserve unfiltered total');
  });

  await expandTest({ id: 174, rawName: 'stress: imported valueSet plus sibling filter scales like direct same-component intersection', name: 'Imported valueSet + sibling filter scales like direct same-component intersection', category: 'Stress & Scale' }, async () => {
    const importedClinical = inlineVS('http://example.org/vs/imported-sct-clinical-finding-sibling-filter', {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });
    const importedFiltered = inlineVS('http://example.org/vs/imported-sct-clinical-finding-regex', {
      system: SYS.SCT,
      valueSet: [importedClinical.url],
      filter: [{ property: 'code', op: 'regex', value: '^7[0-9]{4,}' }],
    });
    const direct = vs({
      system: SYS.SCT,
      filter: [
        { property: 'concept', op: 'is-a', value: '404684003' },
        { property: 'code', op: 'regex', value: '^7[0-9]{4,}' },
      ],
    });

    const { result: directTotal } = await expand(direct, { activeOnly: true, count: 0 });
    const offset = Math.max(0, Math.floor(directTotal.expansion.total / 2) - 10);
    const targetOpts = withExactTotal({ txResources: [importedClinical], activeOnly: true, offset, count: 20 });
    const { result } = await expand(
      importedFiltered,
      targetOpts,
    );
    const { result: directPage } = await expand(direct, { activeOnly: true, offset, count: 20 });

    eq(result.expansion.total, directTotal.expansion.total, 'imported sibling filter total matches direct');
    eq(codes(result).length, Math.min(20, directTotal.expansion.total - offset), 'page size');
    eq(
      JSON.stringify(codes(result).map(c => c.code)),
      JSON.stringify(codes(directPage).map(c => c.code)),
      'imported sibling-filter page matches direct page',
    );
    setPerfTarget(importedFiltered, targetOpts);
  });

  await expandTest({ id: 175, rawName: 'stress: deep same-system text filter pagination stays stable under large offset', name: 'Deep same-system text filter pagination stays stable under large offset', category: 'Stress & Scale', perfOnly: true }, async () => {
    const clinicalFinding = vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });

    const { result: filteredCount } = await expand(clinicalFinding, {
      activeOnly: true,
      filter: 'disease',
      count: 0,
    });

    const offset = Math.max(0, Math.floor(filteredCount.expansion.total / 2) - 25);
    const targetOpts = withExactTotal({ activeOnly: true, filter: 'disease', offset, count: 50 });
    const { result: p1, traceJson } = await expand(
      clinicalFinding,
      targetOpts,
      'ir',
      true,
    );
    const { result: p2 } = await expand(clinicalFinding, {
      activeOnly: true,
      filter: 'disease',
      offset: offset + 25,
      count: 50,
    });

    eq(p1.expansion.total, filteredCount.expansion.total, 'paged total matches count=0 total');
    eq(codes(p1).length, 50, 'first page size');
    eq(codes(p2).length, 50, 'second page size');
    eq(
      JSON.stringify(codes(p1).slice(25).map(c => c.code)),
      JSON.stringify(codes(p2).slice(0, 25).map(c => c.code)),
      'adjacent deep pages should overlap exactly on the shared slice',
    );
    assertCompilerMaterializationTrace(traceJson, 'deep SNOMED text benchmark');
    setPerfTarget(clinicalFinding, targetOpts);
  });

  await expandTest({ id: 176, rawName: 'stress: large overlapping same-system union deduplicates without changing the superset page', name: 'Large overlapping same-system union deduplicates without changing the superset page', category: 'Stress & Scale', perfOnly: true }, async () => {
    const largeUnion = vs([
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] },
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    ]);
    const directClinical = vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });

    const { result: directTotal } = await expand(directClinical, { activeOnly: true, count: 0 });
    const offset = Math.max(0, Math.floor(directTotal.expansion.total / 2) - 50);
    const targetOpts = withExactTotal({ activeOnly: true, offset, count: 100 });
    const { result, traceJson } = await expand(
      largeUnion,
      targetOpts,
      'ir',
      true,
    );
    const { result: directPage } = await expand(directClinical, { activeOnly: true, offset, count: 100 });

    eq(result.expansion.total, directTotal.expansion.total, 'overlapping union total should collapse to the superset total');
    eq(codes(result).length, 100, 'page size');
    eq(new Set(codes(result).map(c => c.code)).size, codes(result).length, 'deduplicated union page should not contain duplicate codes');
    eq(
      JSON.stringify(codes(result).map(c => c.code)),
      JSON.stringify(codes(directPage).map(c => c.code)),
      'overlapping union page should match the superset page',
    );
    assertCompilerMaterializationTrace(traceJson, 'overlapping union benchmark');
    setPerfTarget(largeUnion, targetOpts);
  });

  await expandTest({ id: 177, rawName: 'stress: count-only large SNOMED regex stays on count path', name: 'Count-only large SNOMED regex stays on the count path', category: 'Stress & Scale', perfOnly: true }, async () => {
    const regexVS = vs({
      system: SYS.SCT,
      filter: [{ property: 'code', op: 'regex', value: '^7[0-9]{4,}' }],
    });
    const targetOpts = { activeOnly: true, count: 0 };
    const { result, traceJson } = await expand(regexVS, targetOpts, 'ir', true);

    assertCountOnlyTraceBehavior(result, traceJson, 'SNOMED regex count benchmark');
    setPerfTarget(regexVS, targetOpts);
  });

  await expandTest({ id: 178, rawName: 'stress: count-only imported diff stays on count path', name: 'Count-only imported diff stays on the count path', category: 'Stress & Scale', perfOnly: true }, async () => {
    const importedClinical = inlineVS('http://example.org/vs/imported-sct-clinical-finding-count-only', {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });
    const importedDiabetes = inlineVS('http://example.org/vs/imported-sct-diabetes-count-only', {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    });
    const importedDiff = vs(
      { valueSet: [importedClinical.url] },
      { valueSet: [importedDiabetes.url] },
    );

    const targetOpts = { txResources: [importedClinical, importedDiabetes], activeOnly: true, count: 0 };
    const { result, traceJson } = await expand(
      importedDiff,
      targetOpts,
      'ir',
      true,
    );

    assertCountOnlyTraceBehavior(result, traceJson, 'imported diff count benchmark');
    setPerfTarget(importedDiff, targetOpts);
  });

  await expandTest({ id: 179, rawName: 'stress: count-only multi-clause LOINC filter stays on count path', name: 'Count-only multi-clause LOINC filter stays on the count path', category: 'Stress & Scale', perfOnly: true }, async () => {
    const loincCombo = vs({
      system: SYS.LOINC,
      filter: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'CLASS', op: '=', value: 'CHEM' },
      ],
    });
    const targetOpts = { count: 0 };
    const { result, traceJson } = await expand(loincCombo, targetOpts, 'ir', true);

    assertCountOnlyTraceBehavior(result, traceJson, 'multi-clause LOINC count benchmark');
    setPerfTarget(loincCombo, targetOpts);
  });

  await expandTest({ id: 180, rawName: 'stress: imported diff plus runtime text filter preserves deep pagination', name: 'Imported diff plus runtime text filter preserves deep pagination', category: 'Stress & Scale', perfOnly: true }, async () => {
    const importedClinical = inlineVS('http://example.org/vs/imported-sct-clinical-finding-text-diff', {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });
    const importedDiabetes = inlineVS('http://example.org/vs/imported-sct-diabetes-text-diff', {
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    });
    const importedDiff = vs(
      { valueSet: [importedClinical.url] },
      { valueSet: [importedDiabetes.url] },
    );
    const directDiff = vs(
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] },
      { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
    );

    const { result: filteredCount } = await expand(importedDiff, {
      txResources: [importedClinical, importedDiabetes],
      activeOnly: true,
      filter: 'disease',
      count: 0,
    });

    const offset = Math.max(0, Math.floor(filteredCount.expansion.total / 2) - 25);
    const targetOpts = withExactTotal({
      txResources: [importedClinical, importedDiabetes],
      activeOnly: true,
      filter: 'disease',
      offset,
      count: 50,
    });
    const { result, traceJson } = await expand(
      importedDiff,
      targetOpts,
      'ir',
      true,
    );
    const { result: directPage } = await expand(directDiff, {
      activeOnly: true,
      filter: 'disease',
      offset,
      count: 50,
    });

    eq(result.expansion.total, filteredCount.expansion.total, 'paged total matches count-only filtered total');
    eq(codes(result).length, 50, 'page size');
    eq(
      JSON.stringify(codes(result).map(c => c.code)),
      JSON.stringify(codes(directPage).map(c => c.code)),
      'imported diff text-filtered page matches direct diff page',
    );
    assertCompilerMaterializationTrace(traceJson, 'text-filtered imported diff benchmark');
    setPerfTarget(importedDiff, targetOpts);
  });

  await expandTest({ id: 181, rawName: 'stress: deep LOINC text filter pagination stays stable under large offset', name: 'Deep LOINC text filter pagination stays stable under large offset', category: 'Stress & Scale', perfOnly: true }, async () => {
    const loincActive = vs({
      system: SYS.LOINC,
      filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }],
    });

    const { result: filteredCount } = await expand(loincActive, {
      filter: 'blood',
      count: 0,
    });

    const offset = Math.max(0, Math.floor(filteredCount.expansion.total / 2) - 25);
    const targetOpts = withExactTotal({ filter: 'blood', offset, count: 50 });
    const { result: p1, traceJson } = await expand(
      loincActive,
      targetOpts,
      'ir',
      true,
    );
    const { result: p2 } = await expand(loincActive, {
      filter: 'blood',
      offset: offset + 25,
      count: 50,
    });

    eq(p1.expansion.total, filteredCount.expansion.total, 'paged total matches count-only total');
    eq(codes(p1).length, 50, 'first page size');
    eq(codes(p2).length, 50, 'second page size');
    eq(
      JSON.stringify(codes(p1).slice(25).map(c => c.code)),
      JSON.stringify(codes(p2).slice(0, 25).map(c => c.code)),
      'adjacent deep pages should overlap exactly on the shared slice',
    );
    assertCompilerMaterializationTrace(traceJson, 'deep LOINC text benchmark');
    setPerfTarget(loincActive, targetOpts);
  });

  await expandTest({ id: 182, rawName: 'stress: very large LOINC designation page hits bulk decoration once', name: 'Very large LOINC designation page hits bulk decoration once', category: 'Designations & Language', perfOnly: true }, async () => {
    const loincActive = vs({
      system: SYS.LOINC,
      filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }],
    });
    const targetOpts = { count: 1000, includeDesignations: true };
    const { result, traceJson } = await expand(
      loincActive,
      targetOpts,
      'ir',
      true,
    );

    eq(codes(result).length, 1000, 'page size');
    assertBulkDesignationTrace(result, traceJson, 'very large LOINC designation benchmark');
    setPerfTarget(loincActive, targetOpts);
  });

  // ── real-world workload bench tranche ─────────────────────────────────

  await expandTest({ id: 183, rawName: 'clinical workload: SNOMED diagnosis search pain first 50', name: 'SNOMED diagnosis search "pain" first 50', category: 'Clinical Workloads', perfOnly: true }, async () => {
    const diagnosisPicker = vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });
    const countOpts = { activeOnly: true, filter: 'pain', count: 0 };
    const { result: totalOnly } = await expand(diagnosisPicker, countOpts);
    const targetOpts = { activeOnly: true, filter: 'pain', count: 50 };
    const { result, traceJson } = await expand(diagnosisPicker, targetOpts, 'ir', true);

    eq(result.expansion.total, totalOnly.expansion.total, 'paged total matches count-only total');
    eq(codes(result).length, Math.min(50, totalOnly.expansion.total), 'page size');
    assert(codes(result).every(c => c.system === SYS.SCT), 'all results should be SNOMED');
    assertCompilerMaterializationTrace(traceJson, 'diagnosis pain search benchmark');
    setPerfTarget(diagnosisPicker, targetOpts);
  });

  await expandTest({ id: 184, rawName: 'clinical workload: SNOMED anatomy refset arm search first 50', name: 'SNOMED anatomy refset "arm" search first 50', category: 'Clinical Workloads', perfOnly: true }, async () => {
    const anatomySubset = vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'in', value: 'http://snomed.info/sct?fhir_vs=refset/723264001' }],
    });
    const countOpts = { activeOnly: true, filter: 'arm', count: 0 };
    const { result: totalOnly } = await expand(anatomySubset, countOpts);
    const targetOpts = { activeOnly: true, filter: 'arm', count: 50 };
    const { result, traceJson } = await expand(anatomySubset, targetOpts, 'ir', true);

    assert(totalOnly.expansion.total >= 50, `expected anatomy refset arm search to be bench-sized, got ${totalOnly.expansion.total}`);
    eq(result.expansion.total, totalOnly.expansion.total, 'paged total matches count-only total');
    eq(codes(result).length, 50, 'page size');
    assert(codes(result).every(c => c.system === SYS.SCT), 'all results should be SNOMED');
    assertCompilerMaterializationTrace(traceJson, 'anatomy refset search benchmark');
    setPerfTarget(anatomySubset, targetOpts);
  });

  await expandTest({ id: 185, rawName: 'lab workload: active chemistry glucose search first 50', name: 'LOINC active chemistry "glucose" search first 50', category: 'Lab Workloads', perfOnly: true }, async () => {
    const activeChemLabs = vs({
      system: SYS.LOINC,
      filter: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'CLASS', op: '=', value: 'CHEM' },
      ],
    });
    const countOpts = { activeOnly: true, filter: 'glucose', count: 0 };
    const { result: totalOnly } = await expand(activeChemLabs, countOpts);
    const targetOpts = { activeOnly: true, filter: 'glucose', count: 50 };
    const { result, traceJson } = await expand(activeChemLabs, targetOpts, 'ir', true);

    assert(totalOnly.expansion.total >= 50, `expected active chemistry glucose search to be bench-sized, got ${totalOnly.expansion.total}`);
    eq(result.expansion.total, totalOnly.expansion.total, 'paged total matches count-only total');
    eq(codes(result).length, 50, 'page size');
    assert(codes(result).every(c => c.system === SYS.LOINC), 'all results should be LOINC');
    assertCompilerMaterializationTrace(traceJson, 'active chemistry glucose benchmark');
    setPerfTarget(activeChemLabs, targetOpts);
  });

  await expandTest({ id: 186, rawName: 'lab workload: active quantitative LOINC browse first 100', name: 'LOINC active quantitative browse first 100', category: 'Lab Workloads', perfOnly: true }, async () => {
    const quantitativeLabs = vs({
      system: SYS.LOINC,
      filter: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'SCALE_TYP', op: '=', value: 'Qn' },
      ],
    });
    const { result: totalOnly } = await expand(quantitativeLabs, { activeOnly: true, count: 0 });
    const targetOpts = { activeOnly: true, count: 100 };
    const { result, traceJson } = await expand(quantitativeLabs, targetOpts, 'ir', true);

    eq(result.expansion.total, totalOnly.expansion.total, 'paged total matches count-only total');
    eq(codes(result).length, 100, 'page size');
    assert(codes(result).every(c => c.system === SYS.LOINC), 'all results should be LOINC');
    assertCompilerMaterializationTrace(traceJson, 'quantitative lab browse benchmark');
    setPerfTarget(quantitativeLabs, targetOpts);
  });

  await expandTest({ id: 187, rawName: 'lab workload: imported active chemistry glucose search matches direct page', name: 'Imported active chemistry lab set "glucose" search matches direct page', category: 'ValueSet Imports', perfOnly: true }, async () => {
    const importedChemLabs = inlineVS('http://example.org/vs/imported-active-chem-labs', {
      system: SYS.LOINC,
      filter: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'CLASS', op: '=', value: 'CHEM' },
      ],
    });
    const importedRoot = vs({ valueSet: [importedChemLabs.url] });
    const directLabs = vs({
      system: SYS.LOINC,
      filter: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'CLASS', op: '=', value: 'CHEM' },
      ],
    });
    const { result: directTotal } = await expand(directLabs, { activeOnly: true, filter: 'glucose', count: 0 });
    const { result: directPage } = await expand(directLabs, { activeOnly: true, filter: 'glucose', count: 50 });
    const targetOpts = { txResources: [importedChemLabs], activeOnly: true, filter: 'glucose', count: 50 };
    const { result, traceJson } = await expand(importedRoot, targetOpts, 'ir', true);

    eq(result.expansion.total, directTotal.expansion.total, 'imported total matches direct total');
    eq(codes(result).length, 50, 'page size');
    eq(
      JSON.stringify(codes(result).map(c => c.code)),
      JSON.stringify(codes(directPage).map(c => c.code)),
      'imported page matches direct page',
    );
    assertCompilerMaterializationTrace(traceJson, 'imported chemistry glucose benchmark');
    setPerfTarget(importedRoot, targetOpts);
  });

  await expandTest({ id: 188, rawName: 'medication workload: RxNorm SCD browse first 100 active', name: 'RxNorm clinical drug browse first 100 active', category: 'Medication Workloads', perfOnly: true }, async () => {
    const clinicalDrugs = vs({
      system: SYS.RXNORM,
      filter: [{ property: 'TTY', op: '=', value: 'SCD' }],
    });
    const { result: totalOnly } = await expand(clinicalDrugs, { activeOnly: true, count: 0 });
    const targetOpts = { activeOnly: true, count: 100 };
    const { result, traceJson } = await expand(clinicalDrugs, targetOpts, 'ir', true);

    eq(result.expansion.total, totalOnly.expansion.total, 'paged total matches count-only total');
    eq(codes(result).length, 100, 'page size');
    assert(codes(result).every(c => c.system === SYS.RXNORM), 'all results should be RxNorm');
    assertCompilerMaterializationTrace(traceJson, 'RxNorm clinical drug browse benchmark');
    setPerfTarget(clinicalDrugs, targetOpts);
  });

  await expandTest({ id: 189, rawName: 'medication workload: RxNorm SCD metformin search first 50 active', name: 'RxNorm clinical drug "metformin" search first 50 active', category: 'Medication Workloads', perfOnly: true }, async () => {
    const clinicalDrugs = vs({
      system: SYS.RXNORM,
      filter: [{ property: 'TTY', op: '=', value: 'SCD' }],
    });
    const countOpts = { activeOnly: true, filter: 'metformin', count: 0 };
    const { result: totalOnly } = await expand(clinicalDrugs, countOpts);
    const targetOpts = { activeOnly: true, filter: 'metformin', count: 50 };
    const { result, traceJson } = await expand(clinicalDrugs, targetOpts, 'ir', true);

    assert(totalOnly.expansion.total >= 50, `expected metformin SCD search to be bench-sized, got ${totalOnly.expansion.total}`);
    eq(result.expansion.total, totalOnly.expansion.total, 'paged total matches count-only total');
    eq(codes(result).length, 50, 'page size');
    assert(codes(result).every(c => c.system === SYS.RXNORM), 'all results should be RxNorm');
    assertCompilerMaterializationTrace(traceJson, 'RxNorm metformin benchmark');
    setPerfTarget(clinicalDrugs, targetOpts);
  });

  await expandTest({ id: 190, rawName: 'medication workload: RxNorm SCD insulin search first 50 active', name: 'RxNorm clinical drug "insulin" search first 50 active', category: 'Medication Workloads', perfOnly: true }, async () => {
    const clinicalDrugs = vs({
      system: SYS.RXNORM,
      filter: [{ property: 'TTY', op: '=', value: 'SCD' }],
    });
    const countOpts = { activeOnly: true, filter: 'insulin', count: 0 };
    const { result: totalOnly } = await expand(clinicalDrugs, countOpts);
    const targetOpts = { activeOnly: true, filter: 'insulin', count: 50 };
    const { result, traceJson } = await expand(clinicalDrugs, targetOpts, 'ir', true);

    assert(totalOnly.expansion.total >= 50, `expected insulin SCD search to be bench-sized, got ${totalOnly.expansion.total}`);
    eq(result.expansion.total, totalOnly.expansion.total, 'paged total matches count-only total');
    eq(codes(result).length, 50, 'page size');
    assert(codes(result).every(c => c.system === SYS.RXNORM), 'all results should be RxNorm');
    assertCompilerMaterializationTrace(traceJson, 'RxNorm insulin benchmark');
    setPerfTarget(clinicalDrugs, targetOpts);
  });

  await expandTest({ id: 191, rawName: 'clinical workload: SNOMED clinical finding browse later page without exact total', name: 'SNOMED clinical finding browse later page without exact total', category: 'Clinical Workloads', perfOnly: true }, async () => {
    const clinicalFinding = vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });
    const targetOpts = {
      activeOnly: true,
      offset: 5000,
      count: 100,
    };
    const { result, traceJson } = await expand(clinicalFinding, targetOpts, 'ir', true);

    assert(result.expansion.total == null, 'later-page best-effort browse should omit total');
    eq(codes(result).length, 100, 'page size');
    assert(codes(result).every(c => c.system === SYS.SCT), 'all results should be SNOMED');
    assertCompilerMaterializationTrace(traceJson, 'clinical finding later-page browse benchmark');
    assert(!traceHasSpan(traceJson, 'countForIR:lazy'), 'later-page best-effort browse should skip lazy count');
    setPerfTarget(clinicalFinding, targetOpts);
  });

  await expandTest({ id: 192, rawName: 'clinical workload: SNOMED diagnosis search pain later page without exact total', name: 'SNOMED diagnosis search \"pain\" later page without exact total', category: 'Clinical Workloads', perfOnly: true }, async () => {
    const diagnosisPicker = vs({
      system: SYS.SCT,
      filter: [{ property: 'concept', op: 'is-a', value: '404684003' }],
    });
    const targetOpts = {
      activeOnly: true,
      filter: 'pain',
      offset: 500,
      count: 50,
    };
    const { result, traceJson } = await expand(diagnosisPicker, targetOpts, 'ir', true);

    assert(result.expansion.total == null, 'later-page diagnosis search should omit total');
    eq(codes(result).length, 50, 'page size');
    assert(codes(result).every(c => c.system === SYS.SCT), 'all results should be SNOMED');
    assertCompilerMaterializationTrace(traceJson, 'diagnosis pain later-page benchmark');
    assert(!traceHasSpan(traceJson, 'countForIR:lazy'), 'later-page diagnosis search should skip lazy count');
    setPerfTarget(diagnosisPicker, targetOpts);
  });

  await expandTest({ id: 193, rawName: 'lab workload: active quantitative LOINC browse later page without exact total', name: 'LOINC active quantitative browse later page without exact total', category: 'Lab Workloads', perfOnly: true }, async () => {
    const quantitativeLabs = vs({
      system: SYS.LOINC,
      filter: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'SCALE_TYP', op: '=', value: 'Qn' },
      ],
    });
    const targetOpts = {
      activeOnly: true,
      offset: 5000,
      count: 100,
    };
    const { result, traceJson } = await expand(quantitativeLabs, targetOpts, 'ir', true);

    assert(result.expansion.total == null, 'later-page quantitative browse should omit total');
    eq(codes(result).length, 100, 'page size');
    assert(codes(result).every(c => c.system === SYS.LOINC), 'all results should be LOINC');
    assertCompilerMaterializationTrace(traceJson, 'quantitative lab later-page benchmark');
    assert(!traceHasSpan(traceJson, 'countForIR:lazy'), 'later-page quantitative browse should skip lazy count');
    setPerfTarget(quantitativeLabs, targetOpts);
  });

  await expandTest({ id: 194, rawName: 'medication workload: RxNorm SCD browse later page without exact total', name: 'RxNorm clinical drug browse later page without exact total', category: 'Medication Workloads', perfOnly: true }, async () => {
    const clinicalDrugs = vs({
      system: SYS.RXNORM,
      filter: [{ property: 'TTY', op: '=', value: 'SCD' }],
    });
    const targetOpts = {
      activeOnly: true,
      offset: 1000,
      count: 100,
    };
    const { result, traceJson } = await expand(clinicalDrugs, targetOpts, 'ir', true);

    assert(result.expansion.total == null, 'later-page RxNorm browse should omit total');
    eq(codes(result).length, 100, 'page size');
    assert(codes(result).every(c => c.system === SYS.RXNORM), 'all results should be RxNorm');
    assertCompilerMaterializationTrace(traceJson, 'RxNorm later-page browse benchmark');
    assert(!traceHasSpan(traceJson, 'countForIR:lazy'), 'later-page RxNorm browse should skip lazy count');
    setPerfTarget(clinicalDrugs, targetOpts);
  });
}

export async function collectExpandCaseDefs() {
  const cases = [];
  await registerExpandCases({
    test: async (meta) => {
      cases.push(meta);
    },
    helpers: {
      HARNESS_SQLITE_SUPP_URL_ROOT: '__collect__',
    },
    setCategory: () => {},
    log: () => {},
  });
  return cases;
}
