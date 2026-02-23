# Proposed Language & Designation Tests for expand-v2 Harness

## Gap Summary

The v2 rewrite introduced several new code paths for display/designation handling:

- **`_canUseDisplayFastPath()`** — short-circuits to `cs.display()` when languages are English/empty and designations aren't requested. Untested.
- **`_listDisplays()`** — two branches (fast path vs full `cs.designations()`). Only the fast path runs in current tests.
- **`_useDesignation()`** — filters designations by use code or language tag. Untested.
- **`_applyConceptOverrides()`** — merges compose-level display/designation overrides. Only partially tested (display override exists, but not inline designations or interaction with `includeDesignations`).
- **`_redundantDisplay()`** — suppresses designations that duplicate the primary display. Untested.

The existing harness has 1 test for `includeDesignations` (on the internal language code system) and 0 tests for `displayLanguage`, designation filtering, or the fast-path/full-path branching.

---

## Test 1: `displayLanguage` selects non-English display

**What it exercises:** When `displayLanguage` is set to a non-English language, `_canUseDisplayFastPath()` must return `false`, forcing `_listDisplays` through the full `cs.designations()` path. The `Designations.preferredDesignation()` logic then picks the best match for that language.

**Why it matters:** If the fast path fires incorrectly for non-English requests, users get English displays regardless of their language preference. This is pure wiring — the `Designations` class is well-tested in isolation, but nobody checks that v2 actually calls it.

```js
test('lang: displayLanguage=es selects non-English display for SNOMED code', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }], // Diabetes mellitus
  }), {
    params: [{ name: 'displayLanguage', valueCode: 'es' }],
  });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length === 1, `expected 1, got ${contains.length}`);
  const dm = contains[0];

  // Display should be non-empty (Spanish if available, English fallback if not)
  assert(typeof dm.display === 'string' && dm.display.length > 0, 'display should be non-empty');

  // The expansion parameters must echo displayLanguage back
  const dlParam = (result.expansion.parameter || []).find(p => p.name === 'displayLanguage');
  assert(dlParam, 'expansion should echo displayLanguage parameter');
});
```

**Expected outcome:** The expansion returns a single code. If the SNOMED data includes a Spanish translation for 73211009, `display` is that translation. If not, it falls back to English. Either way, the `displayLanguage` parameter appears in `expansion.parameter`. The key correctness check is that the request doesn't crash and the parameter propagates — if the fast path incorrectly fires, `cs.display()` returns English and there's no way to detect the language request was honored. A stronger variant (see Test 4) pairs this with `includeDesignations` to inspect what was actually loaded.

---

## Test 2: `displayLanguage` on a filter-based expansion

**What it exercises:** The `_processFilters` → `_listDisplays` path with a non-English language. Filter iteration is a separate code path from concept enumeration — it goes through `_iterateFilterSet` and calls `_listDisplays` inside the callback.

**Why it matters:** A bug where `_listDisplays` uses the fast path during filter iteration (but not during concept enumeration) would only show up in filter-based expansions.

```js
test('lang: displayLanguage=fr on SNOMED is-a filter uses full designation path', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }), {
    count: 5,
    params: [{ name: 'displayLanguage', valueCode: 'fr' }],
  });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'should have results');
  assertContainsShape(contains, SYS.SCT);

  // Verify displayLanguage echoed
  const dlParam = (result.expansion.parameter || []).find(p => p.name === 'displayLanguage');
  assert(dlParam, 'expansion should echo displayLanguage parameter');
});
```

**Expected outcome:** A paginated (count=5) expansion of SNOMED descendants of Diabetes mellitus. All entries have system, code, and non-empty display. The `displayLanguage` parameter is echoed.

---

## Test 3: `includeDesignations` with SNOMED (sqlite-v0 provider)

**What it exercises:** The full designation loading path on the sqlite-v0 provider, which runs `SELECT language_code, use_code, term, preferred, active FROM designation WHERE concept_id = ?`. Then `_useDesignation` (with no filter, so all designations pass) and `_redundantDisplay` (which suppresses duplicates).

**Why it matters:** The existing `includeDesignations` test uses the internal language code system, not the sqlite-v0 provider. The v0 provider has a completely different `designations()` implementation with SQL queries, language-tagged rows, and use codes. This is the most common real-world code path.

```js
test('lang: includeDesignations returns synonym designations for SNOMED code', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }], // Diabetes mellitus — has synonyms + FSN
  }), {
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const dm = findCode(result.expansion.contains, '73211009');
  assert(dm, 'missing 73211009');
  assert(dm.display, 'should have display');

  // SNOMED concepts have at least FSN + preferred term.
  // With includeDesignations, the non-primary ones should appear as designation[].
  assert(Array.isArray(dm.designation) && dm.designation.length > 0,
    'expected at least one designation beyond the primary display');

  // Each designation must have a value
  for (const d of dm.designation) {
    assert(d.value, `designation missing value: ${JSON.stringify(d)}`);
  }
});
```

**Expected outcome:** The entry for 73211009 has `display` set to the preferred term ("Diabetes mellitus") and `designation[]` populated with at least the FSN ("Diabetes mellitus (disorder)") and possibly synonyms. Each designation object has a `value` string.

---

## Test 4: `includeDesignations` + `displayLanguage` combined

**What it exercises:** The interaction between language selection and designation inclusion. When both are set: `_canUseDisplayFastPath()` returns false (non-trivial language), `_listDisplays` loads full designations, `preferredDesignation()` picks the best match for the requested language as the primary display, and remaining designations appear in `designation[]`.

**Why it matters:** This is the most realistic clinical use case — a French-speaking user wants to see French displays with all available designations. If the wiring is wrong, they get English displays with French designations, or no designations at all.

```js
test('lang: includeDesignations + displayLanguage=en returns English display with designations', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }), {
    params: [
      { name: 'includeDesignations', valueBoolean: true },
      { name: 'displayLanguage', valueCode: 'en' },
    ],
  });
  assertExpansionStructure(result);
  const dm = findCode(result.expansion.contains, '73211009');
  assert(dm, 'missing code');
  assert(dm.display === 'Diabetes mellitus',
    `expected English preferred display, got '${dm.display}'`);
  assert(Array.isArray(dm.designation) && dm.designation.length > 0,
    'designations should be present when includeDesignations=true');
});
```

**Expected outcome:** Primary display is "Diabetes mellitus" (English preferred term). `designation[]` contains at least the FSN and/or synonyms.

---

## Test 5: `designation` parameter filters by use code

**What it exercises:** The `_useDesignation()` method's first matching branch: `cd.use.system === l && cd.use.code === r`. When a `designation` parameter like `http://snomed.info/sct|900000000000003001` is provided, only designations with that specific use code (FSN in SNOMED's case) should appear.

**Why it matters:** This is completely untested. A bug here means designation filtering silently returns all designations regardless of the filter, or returns none. The `_useDesignation` method is simple, but nobody has verified the v2 expander wires the `params.designations` list through to the rendering loop correctly.

```js
test('lang: designation param filters to specific SNOMED use code (FSN)', async () => {
  // 900000000000003001 = Fully Specified Name in SNOMED
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }), {
    params: [
      { name: 'includeDesignations', valueBoolean: true },
      { name: 'designation', valueString: 'http://snomed.info/sct|900000000000003001' },
    ],
  });
  assertExpansionStructure(result);
  const dm = findCode(result.expansion.contains, '73211009');
  assert(dm, 'missing code');

  // Every returned designation must match the requested use code
  for (const d of dm.designation || []) {
    assert(d.use?.system === 'http://snomed.info/sct'
        && d.use?.code === '900000000000003001',
      `designation should match FSN filter, got use=${JSON.stringify(d.use)}`);
  }

  // Verify the designation param is echoed in expansion.parameter
  const desigParam = (result.expansion.parameter || [])
    .find(p => p.name === 'designation');
  assert(desigParam, 'expansion should echo designation parameter');
});
```

**Expected outcome:** Only FSN-typed designations appear. Synonyms and preferred terms with other use codes are excluded. The `designation` parameter is echoed in `expansion.parameter`.

---

## Test 6: `designation` parameter filters by language tag

**What it exercises:** The `_useDesignation()` method's second matching branch: `cd.language?.code && l === 'urn:ietf:bcp:47' && r === cd.language.code`. This lets callers request only designations in a specific language.

**Why it matters:** Language-based designation filtering is a different branch from use-code filtering in `_useDesignation`. Both need coverage.

```js
test('lang: designation param filters by language tag (en)', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }), {
    params: [
      { name: 'includeDesignations', valueBoolean: true },
      { name: 'designation', valueString: 'urn:ietf:bcp:47|en' },
    ],
  });
  assertExpansionStructure(result);
  const dm = findCode(result.expansion.contains, '73211009');
  assert(dm, 'missing code');

  // All returned designations should be English-tagged
  for (const d of dm.designation || []) {
    const lang = d.language || '';
    assert(lang.startsWith('en'),
      `designation language should be English, got '${lang}'`);
  }
});
```

**Expected outcome:** Only English-language designations are returned. Any Spanish, French, etc. designations in the data are filtered out.

---

## Test 7: `displayLanguage=en` stays on fast path (parity check)

**What it exercises:** `_canUseDisplayFastPath()` returning `true` for English, confirming the fast path produces the same display as the default (no `displayLanguage`).

**Why it matters:** The fast path calls `cs.display(context)` which returns a single string, while the full path calls `cs.designations(context, displays)` and then runs `preferredDesignation()`. If these two paths disagree on what the "preferred" display is, English-language users see different results depending on whether they explicitly pass `displayLanguage=en` vs omit it. This test would catch such a divergence.

```js
test('lang: displayLanguage=en matches default display (fast path parity)', async () => {
  const { result: withLang } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }), {
    params: [{ name: 'displayLanguage', valueCode: 'en' }],
  });
  const { result: noLang } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }));

  const a = findCode(withLang.expansion.contains, '73211009');
  const b = findCode(noLang.expansion.contains, '73211009');
  assert(a && b, 'both should return the code');
  assert(a.display === b.display,
    `English displayLanguage should match default: '${a.display}' vs '${b.display}'`);
});
```

**Expected outcome:** Both expansions return `display: "Diabetes mellitus"`. If the fast path and full path disagree, this test fails.

---

## Test 8: Concept display override + `includeDesignations`

**What it exercises:** `_applyConceptOverrides()` adding a compose-level display, combined with `includeDesignations=true` so we can see whether the override interacts correctly with the designation list. The override should become the primary display; the original CS display may appear as a designation.

**Why it matters:** v1 and v2 handle this differently — v1 calls `listDisplaysFromIncludeConcept` directly inside `includeCode`, while v2 separates it into `_applyConceptOverrides` called before rendering. If the override isn't applied before `preferredDesignation()` runs, the compose display is ignored.

```js
test('lang: concept display override interacts with includeDesignations', async () => {
  const { result } = await expand(vs({
    system: SYS.GENDER,
    concept: [
      { code: 'male', display: 'Masculin' },
    ],
  }), {
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const male = findCode(result.expansion.contains, 'male');
  assert(male, 'missing male');

  // The compose display should win as primary display (or at minimum appear somewhere)
  assert(male.display === 'Masculin' || male.display === 'Male',
    `display should be override or CS default, got '${male.display}'`);

  // If the CS has other designations, they should appear in designation[]
  // (this tests that includeDesignations works alongside overrides without crashing)
});
```

**Expected outcome:** The primary display is either "Masculin" (the override) or "Male" (CS default, depending on R4/R5 behavior). No crash from the interaction of override + designation loading.

---

## Test 9: Inline designation overrides from compose

**What it exercises:** `_applyConceptOverrides()` processing `conceptRef.designation[]` — the path where a ValueSet author provides explicit designation translations inline in the compose.

**Why it matters:** This is a distinct code path from the display override. The method calls `displays.addDesignationFromConcept(cd)` for each inline designation. If this wiring is broken, author-provided translations silently vanish.

```js
test('lang: compose concept with inline designation overrides are included', async () => {
  const { result } = await expand(vs({
    system: SYS.GENDER,
    concept: [{
      code: 'male',
      display: 'Masculin',
      designation: [{
        language: 'de',
        value: 'Männlich',
      }],
    }],
  }), {
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const male = findCode(result.expansion.contains, 'male');
  assert(male, 'missing male');

  const deDesignation = (male.designation || []).find(d => d.language === 'de');
  assert(deDesignation, 'expected German designation from compose');
  assert(deDesignation.value === 'Männlich',
    `expected 'Männlich', got '${deDesignation.value}'`);
});
```

**Expected outcome:** The German designation from the compose appears in `designation[]` with `language: "de"` and `value: "Männlich"`.

---

## Test 10: `includeDesignations` on whole-system expansion (package CS)

**What it exercises:** `_listDisplays` full path on a package-backed code system (cs-cs provider) during whole-system enumeration via `_processWholeSystem`. This is a different provider type from sqlite-v0.

**Why it matters:** Package-backed code systems have their own `designations()` implementation in `cs-cs.js`. If the wiring works for v0 but not for package CS, whole-system expansions of HL7 code systems would silently drop designations.

```js
test('lang: includeDesignations on whole-system package CS (administrative-gender)', async () => {
  const { result } = await expand(vs({ system: SYS.GENDER }), {
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length >= 3, `gender should have at least 3 codes, got ${contains.length}`);
  assertContainsShape(contains, SYS.GENDER);

  // Validates the wiring doesn't crash on package-backed CS designations.
  // Package CS may or may not have designations beyond the primary display —
  // the key assertion is structural correctness.
  for (const c of contains) {
    if (c.designation) {
      for (const d of c.designation) {
        assert(d.value, `designation for ${c.code} missing value`);
      }
    }
  }
});
```

**Expected outcome:** All gender codes expand with display. Any designations that exist are structurally valid. No crash.

---

## Test 11: `includeDesignations` on SNOMED filter expansion

**What it exercises:** The filter iteration path (`_processFilters` → `_iterateFilterSet` callback → `_listDisplays`) with `includeDesignations=true`. This is a different call site from concept enumeration.

**Why it matters:** Filter iteration constructs `Designations` objects inside a tight loop. If the `includeDesignations` flag isn't checked at the right point, or if designations are loaded but not rendered, this path silently drops them.

```js
test('lang: includeDesignations on SNOMED is-a filter returns designations', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }), {
    count: 5,
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  assertExpansionStructure(result);
  const contains = result.expansion.contains || [];
  assert(contains.length > 0, 'should have results');

  // At least one entry should carry designations (SNOMED codes have synonyms)
  const withDesig = contains.filter(c => c.designation?.length > 0);
  assert(withDesig.length > 0,
    'at least one code from is-a filter should have designations');
});
```

**Expected outcome:** Paginated expansion returns codes with designations populated. At least one code has `designation.length > 0`.

---

## Test 12: Redundant display suppression

**What it exercises:** `_redundantDisplay()` — when `includeDesignations=true`, a designation that exactly matches the primary `display` (with matching or absent language/use) should be suppressed to avoid duplication.

**Why it matters:** Without this check, every SNOMED code would have its preferred term appearing both as `display` and as a `designation[]` entry, which is confusing for consumers. The logic is subtle (it checks language prefix matching and use code), and v2 reimplemented it from scratch.

```js
test('lang: redundant designation matching primary display is suppressed', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    concept: [{ code: '73211009' }],
  }), {
    params: [{ name: 'includeDesignations', valueBoolean: true }],
  });
  const dm = findCode(result.expansion.contains, '73211009');
  assert(dm, 'missing code');

  // The primary display should NOT also appear as a designation
  // with no use (or use.code='display') and matching/absent language.
  for (const d of dm.designation || []) {
    const isRedundant = d.value === dm.display
      && (!d.use || d.use?.code === 'display')
      && (!d.language || d.language.startsWith('en'));
    assert(!isRedundant,
      `designation '${d.value}' duplicates primary display '${dm.display}' — `
      + `_redundantDisplay should have suppressed it`);
  }
});
```

**Expected outcome:** No designation entry is an exact duplicate of the primary display (when use is absent/display and language matches).

---

## Priority Order

| Priority | Tests | Rationale |
|----------|-------|-----------|
| **P0 — must have** | 1, 3, 5, 6, 12 | Exercise completely untested code paths (`_canUseDisplayFastPath` branching, `_useDesignation` filtering, `_redundantDisplay`). Most likely to catch v1→v2 regressions. |
| **P1 — should have** | 2, 4, 7, 11 | Cover additional call sites (filter iteration, combined params, fast-path parity). Catch wiring bugs in less-common but important paths. |
| **P2 — nice to have** | 8, 9, 10 | Cover compose overrides and package CS interaction. Lower risk of regression but good for completeness. |
