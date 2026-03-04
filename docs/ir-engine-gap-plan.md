# IR Engine Gap Analysis & Porting Plan

> Produced by comparing `rework-expand-codex-2` (155 tests) against
> `ir-engine` (61 tests, commit `7229055`). Covers functional gaps,
> testability, and rewrite/optimization verification.

## Current test fixture

The running server loads `tests/tx/fixtures/v0-test-library.yaml`:

| Provider type | Systems loaded |
|---|---|
| v0 SQLite | SNOMED, LOINC, RxNorm |
| cs-cs (npm) | administrative-gender, publication-status, condition-ver-status, observation-category, and ~80 others from hl7.terminology.r4#6.2.0 |
| internal | country (`urn:iso:std:iso:3166`), currency (`urn:iso:std:iso:4217`) |
| ucum | UCUM (`http://unitsofmeasure.org`) |
| cs-cs (inline) | Any CodeSystem submitted via `tx-resource` |
| **NOT loaded** | language (`urn:ietf:bcp:47`), MIME (`urn:ietf:bcp:13`), USPS/US states, M49 area codes |

---

## Phase 1 — Functional fixes (engine changes needed)

These are behaviors the IR engine should have but doesn't. Each needs
code changes before tests can pass.

### 1.1 Compose-level display override

**What**: When `compose.include[].concept[].display` provides a display,
the expansion should use it instead of the provider's display.  FHIR R4
§5.8.2: "If a display is provided, it overrides the display from the
code system." (Actually nuanced — the spec says servers may still use
the CS display, but tx.fhir.org uses the compose display.)

**Where to fix**: `tx/engine/orchestrator.js` — after `executeIR` returns
candidates, overlay compose display from IR `subtree.conceptCodes[].display`.

**How to verify**: Expand `{system: GENDER, concept: [{code: "male", display: "Masculin"}]}` → entry has `display: "Masculin"` (or "Male" — test accepts either, per codex-2).

**Stash status**: Fix already implemented in stashed work.

**Tests to port**:
- `shape-B: enumerated with user-supplied display override` (codex-2 L2451)

### 1.2 Compose-level inline designations

**What**: When `compose.include[].concept[]` carries a `designation` array,
those designations should appear in the expansion when `includeDesignations=true`.

**Where to fix**: Same orchestrator post-processing as 1.1 — thread
`conceptCodes[].designation` through to the `_composeDesignations` on
each candidate, merge into final `entry.designation`.

**How to verify**: Expand gender `male` with inline designation
`{language: "de", value: "Maennlich"}` + `includeDesignations=true` →
designation array includes the German entry.

**Stash status**: Fix already implemented in stashed work.

**Tests to port**:
- `lang: compose inline designation override is included with includeDesignations` (codex-2 L2762)

### 1.3 `used-valueset` expansion parameter

**What**: When a ValueSet import is resolved, the expansion should emit
a `used-valueset` parameter with the imported VS's canonical URL.

**Where to fix**: `tx/engine/resolve-imports.js` — track resolved URLs
in a `usedValueSets` Set, attach to resolved IR. `orchestrator.js` —
thread through to `buildExpandedValueSet` which emits the parameters.

**How to verify**: Expand `{valueSet: ["http://hl7.org/fhir/ValueSet/administrative-gender"]}` →
expansion parameters include `{name: "used-valueset", valueUri: "…/administrative-gender|4.0.1"}`.

**Stash status**: Fix already implemented in stashed work.

**Tests to port**:
- `meta: ValueSet import emits used-valueset parameter` (codex-2 L2240)

### 1.4 `count` parameter should not emit `-1`

**What**: When no `count` is requested, the IR engine emits
`{name: "count", valueInteger: -1}`. Should be omitted.

**Where to fix**: `tx/engine/orchestrator.js` `buildExpandedValueSet` —
guard `params.count >= 0` before emitting.

**Stash status**: Fix already implemented in stashed work.

**Tests to port**: Existing meta tests already implicitly cover this.

### 1.5 `designation` parameter filter

**What**: The `designation` parameter (e.g. `http://snomed.info/sct|900000000000003001`)
should filter which designations appear in the expansion. Currently IR
returns all designations unfiltered.

**Where to fix**: `tx/engine/orchestrator.js` — in `buildExpandedValueSet`
or `decorateCandidates`, parse the designation param and filter
`c._designations` to only those matching the `system|code` use filter.
Alternatively, pass the filter down to `bulkDesignations` so it can
SELECT only matching rows.

**How to verify**: SNOMED concept `73211009` with
`designation=http://snomed.info/sct|900000000000003001` +
`includeDesignations=true` → only FSN designations returned (legacy
returns 1, IR currently returns 3).

**Stash status**: NOT yet implemented.

**Tests to port**:
- `lang: designation parameter filters SNOMED designations by FSN use code` (codex-2 L2716)

### 1.6 `displayLanguage` parameter

**What**: The `displayLanguage` parameter should influence which display
is chosen for each code, and be echoed in expansion parameters.

**Where to fix**: The `_tryIRExpansion` wrapper needs to read
`params.DisplayLanguages` and pass it into `expandViaIR` options.
The orchestrator needs to pass it to `decorateCandidates`. The display
selection logic in `bulkDesignations` or the orchestrator needs to
pick the best display for the requested language.

**How to verify**: SNOMED concept `73211009` with `displayLanguage=en` →
display matches default English display; expansion parameters include
`{name: "displayLanguage", valueCode: "en"}`.

**Stash status**: NOT yet implemented.

**Tests to port**:
- `lang: displayLanguage=en matches default display for SNOMED concept` (codex-2 L2739)

### 1.7 Redundant designation suppression

**What**: When `includeDesignations=true`, a designation whose `value`
equals the primary `display` and has no special `use` should be
suppressed to avoid redundancy.

**Where to fix**: `tx/engine/orchestrator.js` in the contains builder —
filter out designations where `d.value === entry.display` and
`(!d.use || d.use.code === 'display')` and lang is English/absent.

**How to verify**: SNOMED `73211009` with `includeDesignations=true` →
no designation entry has `value === display` with display-typed use.

**Stash status**: NOT yet implemented.

**Tests to port**:
- `lang: redundant designation equal to primary display is suppressed` (codex-2 L2813)

### 1.8 Property-value `regex` filter in SQL

**What**: The IR SQL builder (`sqlite-v0-sql.js`) only handles
`code` regex (`property === 'code' && op === 'regex'`). It doesn't
handle regex on literal/string properties like LOINC's `STATUS`.
The legacy v0 provider handles this via the filter protocol, which
the LegacyIRAdapter wraps — so it works via fallback, but native
IR SQL gets 0 results.

**Where to fix**: `tx/engine/sqlite-v0-sql.js` — add a branch for
`op === 'regex'` on `propDef.value_kind === 'string'/'literal'`,
using `REGEXP` against `concept_literal.value_text`.

**How to verify**: `{system: LOINC, filter: [{property: "STATUS", op: "regex", value: "^ACT"}]}` →
returns results (currently returns 0).

**Tests to port**:
- `logic: regex filter works for literal-valued property in sqlite-v0` (codex-2 L3958) — adapted

---

## Phase 2 — Portworthy tests (no engine changes needed)

These codex-2 tests exercise behaviors the IR engine already handles
correctly. They just haven't been ported to `scripts/ir-harness.mjs`.

### 2.1 tx-resource infrastructure
- `infra: tx-resource injected CodeSystem can be expanded` (L1240)
- `infra: tx-resource injected ValueSet import resolves against injected CodeSystem` (L1264)

### 2.2 Inline FHIR cs-cs filters
- `filter: gender regex [mf].* (inline FHIR cs-cs)` (L2587) — verified working
- `filter: inline FHIR is-a with hierarchy (condition-ver-status)` (L2638) — verified working
- `filter: inline FHIR descendent-of (condition-ver-status)` (L2655) — verified working
- `filter: inline FHIR concept = exact code (cs-cs)` (L2669) — verified working
- `filter: country code regex A.* (cs-country)` (L2569) — internal:country is loaded

### 2.3 Shape A: whole-system expansions
- `shape-A: administrative-gender (inline FHIR cs-cs)` (L1196)
- `shape-A: publication-status (inline FHIR cs-cs)` (L1212)
- `shape-A: currency full expansion (preloaded map)` (L1181) — internal:currency loaded

### 2.4 Shape B: additional enumerated
- `shape-B: single concept exact match (v0)` (L2470)
- `shape-B: SNOMED enumerated (v0 pushdown)` (L2401) — already covered but this has tighter assertions
- `shape-B: LOINC enumerated (v0 pushdown)` (L2418)
- `shape-B: RxNorm enumerated (v0 pushdown)` (L2434)
- `shape-B: gender enumerated subset (inline FHIR cs-cs)` (L2387) — overlaps existing

### 2.5 Filter: property filters on non-v0 providers
- `filter: currency decimals=0 (property =)` (L2548) — if internal:currency supports property filters

### 2.6 Additional exclude patterns
- `exclude: inline FHIR filter-based exclude (condition-ver-status)` (L3100)

### 2.7 Additional pagination tests
- `pagination: count=0 returns total only` (L3254) — we have similar but codex-2 is more specific

### 2.8 Import & intersection logic
- `logic: same-system valueSet intersections constrain final include membership` (L3911) — verified working via curl
- `logic: imported include/exclude valueSets (no system) apply Inc/Exc semantics` (L4033)
- `logic: total includes direct and imported include contributions` (L4080)
- `logic: whole-system descendant traversal keeps exact total` (L4115) — for inline CS
- `logic: total reflects imported excludes without mutating accumulated list` (L4150)
- `logic: mixed import+peer include/exclude paginates without gaps or duplicates` (L4290)
- `logic: bulk locate resolver handles >50 unique concepts in fallback mode` (L4358)

### 2.9 Provider-specific behaviors (working via legacy adapter)
- `provider: cs-cs hierarchy iteration (condition-ver-status)` (L3557)
- `provider: v0 RxNorm text search + property filter combined` (L3602)

### 2.10 Coverage: multi-provider combinations
- `coverage: tx-resource whole include with cs-cs peer` (L3647)
- `coverage: tx-resource concept include + exclude with cs-cs peer` (L3671)
- `coverage: valueset-import include with cs-cs peer` (adapt L3700 to use gender instead of USPS)

### 2.11 Pagination safety (import-aware)
- `pagination-safety: valueset-import peer with excludes reconstructs full set` (L3832)
- `pagination-safety: mixed import+system high-count page is not silently capped` (L4959)

### 2.12 params: property=definition
- `params: property=definition includes definition property on contains entries` (L2171) — verified working

### 2.13 Designations on cs-cs whole-system
- `lang: includeDesignations on package cs-cs whole-system is structurally valid` (L2782)

---

## Phase 3 — IR rewrite/optimizer verification

These tests verify that the IR compiler, rewriter, and optimizer
produce correct and optimal trees. They're NOT testing end-to-end
expansion behavior — they're testing the IR layer directly by
calling `buildIRFromValueSet`, `resolveImports`, `optimize`, and
inspecting the resulting tree structure.

Our engine has all these modules (`tx/engine/build-ir.js`,
`tx/engine/rewrite.js`, `tx/engine/resolve-imports.js`). The codex-2
tests exercise optimizations that our `rewrite.js` implements:

| Optimization | Our code | Codex-2 test |
|---|---|---|
| Union concept coalescing (same-system concepts merge) | `coalesceUnionItems` / `mergeConceptSelectors` | L4898 (union folding) |
| Union filter dedup (identical filter selectors collapse) | `coalesceUnionItems` / `filterSignature` | L4823 (duplicate filter dedup), L4898 |
| Intersect filter coalescing (same-system filters merge clauses) | `coalesceIntersectItems` / `mergeSelectorsForIntersect` | L4765 (intersect same-system filters) |
| Intersect filter+concept → intersectCodes | `mergeSelectorsForIntersect` | L4863 (intersect filter+concept) |
| Cross-system intersect projection → empty | `projectToSystem` | L4889 (projection eliminates empty) |
| Diff partitioning by system | `partitionDiffBySystem` | L4793 (nested diff partitioning) |
| Import inlining (resolved imports become concrete subtrees) | `simplify` case `'import'` | All import tests |

**These should be unit tests**, not HTTP harness tests. They call
the IR functions directly and inspect tree shapes. We should create
a separate test file (e.g. `scripts/ir-rewrite-tests.mjs` or add
a section to the harness) that imports our `tx/engine` modules and
verifies these rewrite properties.

**Tests to port (as unit tests):**
1. `v3-lowering-gap: intersect same-system filters coalesce in rewrite` (L4765)
2. `v3-lowering-gap: nested diff partitioning rewrites multi-system left branches` (L4793)
3. `v3-lowering-gap: duplicate filter branches are deduped after import inline` (L4823)
4. `v3-lowering-gap: intersect filter+concept lowers to selector with intersectCodes` (L4863)
5. `v3-lowering-gap: projection eliminates empty intersect branches` (L4889)
6. `v3-lowering-gap: queryIR union folding merges concept unions and dedupes identical filters` (L4898) — adapted (we don't have `compileExprToQueryIR` but the union folding happens in `coalesceUnionItems`)

**Tests to port (as e2e parity tests):**

The `v3-lowering:` tests verify that the *optimized* path produces
the same results as the *unoptimized* path. We can do the same by
running with `EXPAND_V3_DISABLE_REWRITE_OPT=1` vs without and
comparing membership:

7. `v3-lowering: import-intersect-with-union compiles to single provider pushdown` (L4637) — adapted: verify optimized and unoptimized produce same codes
8. `v3-lowering: include minus union-excludes uses single provider query` (L4686) — adapted
9. `v3-lowering: include minus imported diff lowers to single provider query` (L4722) — adapted

---

## Phase 4 — Fixture expansion

Several codex-2 tests use providers not in our test fixture. Most can
be enabled by adding one line to `tests/tx/fixtures/v0-test-library.yaml`.

### 4.1 Add `internal:usstates` to fixture (7 tests unblocked)

**Prerequisite**: Add `- internal:usstates` to the YAML sources list.
No code changes needed—the `USStateFactoryProvider` is already
implemented in `tx/cs/cs-usstates.js` and registered in `tx/library.js`
case `"usstates"`. 57 US states/territories, preloaded map provider.

**Tests unblocked**:
- `shape-A: US states full expansion` (L1163)
- `shape-B: US states enumerated` (L2372)
- `exclude: US states subtract 2 from 4 enumerated` (L3040)
- `exclude: exclude from whole system (preloaded map)` (L3151)
- `pagination: US states disjoint pages` (L3198)
- `pagination: US states last page partial` (L3218)
- `pagination: US states offset beyond end` (L3226)

Also unblocks coverage/multi-system tests that pair USPS with other systems:
- `multi-system: gender + US states union` (L3341)
- `coverage: valueset-import include with USPS peer` (L3700, L3712)
- `pagination-safety: mixed v0 + preloaded reconstruct` (L3796)

### 4.2 Add `internal:areacode` to fixture (3 tests unblocked)

**Prerequisite**: Add `- internal:areacode` to YAML. Provider is
`AreaCodeFactoryProvider` in `tx/cs/cs-areacode.js`, system
`http://unstats.un.org/unsd/methods/m49/m49.htm`. Has property
filters (`class` = region/country).

**Tests unblocked**:
- `shape-A: area codes full expansion` (L1225)
- `filter: area codes class=region` (L2517)
- `filter: area codes class=country` (L2533)
- `coverage: areacode class filter with cs-cs peer` (L3740)

### 4.3 Add `internal:mimetypes` to fixture (2 tests unblocked)

**Prerequisite**: Add `- internal:mimetypes` to YAML. Provider is
`MimeTypeServicesFactory` in `tx/cs/cs-mimetypes.js`, system
`urn:ietf:bcp:13`. Grammar-based (`totalCount()` returns -1), so
whole-system expansion should fail or return unclosed.

**Tests unblocked**:
- `shape-B: MIME types enumerated` (L2497) — concept-include, not whole-system
- `notClosed: MIME whole-system not enumerable` (L2832)
- `coverage: MIME concept + language peer` (L3636)

### 4.4 Language provider (already loaded)

`internal:lang` IS in the fixture. `urn:ietf:bcp:47` concept-include
works (verified: `en`, `fr-CA` resolve). Whole-system throws because
`cs-lang.js` line 299: `"Language valuesets cannot be expanded…"`.

**Tests already unblocked**:
- `shape-B: language codes enumerated` (L2483) — uses concept include, should work
- `params: language code includeDesignations` (L2681) — concept include + designations

---

## Phase 5 — Inline supplement plumbing (~11 tests)

Supplements that are represented as inline CodeSystem resources
(submitted via `tx-resource` with `content: "supplement"`) should
flow through the IR expansion path. The provider layer already
handles supplement merging — once `findCodeSystem` receives the
correct `statedSupplements`, designations and display overrides
from supplements appear automatically via `_displayFromSupplements()`
and `_listSupplementDesignations()`.

All supplement fixtures are inline CodeSystem resources — no SQLite
supplement DBs needed. Each test constructs a CS + supplement CS
with unique URLs and submits both via `tx-resource`.

**What already works**:
- `_tryIRExpansion` calls `worker.findCodeSystem()` which calls
  `loadSupplements()`. Language packs (auto-detected via
  `cs.isLangPack()`) are loaded automatically.
- The provider returned to the IR engine is already supplement-aware.
- `FhirCodeSystemProvider` (cs-cs) merges supplement concepts by code.
- `SqliteV0Provider` merges supplement designations/properties via
  `_displayFromSupplements()` and `_listSupplementDesignations()`.

**What to fix** (orchestration plumbing only — no SQL changes):

1. **`useSupplement` parameter**: IR passes `statedSupplements=null`
   to `findCodeSystem`. Legacy passes `this.requiredSupplements`
   (populated from `params.supplements`). Fix: read `useSupplement`
   params and pass as `statedSupplements` in `_tryIRExpansion`.

2. **`valueset-supplement` extension**: Legacy reads this from the VS
   at line 1161 and adds to `requiredSupplements`. Fix: read the
   extension from `vsJson` in `_tryIRExpansion` and merge into the
   supplement set.

3. **`used-supplement` parameter**: IR's `buildExpandedValueSet`
   doesn't emit it. Fix: after expansion, check which providers
   loaded supplements (e.g. `provider.supplements` array) and emit
   `used-supplement` parameter for each.

4. **Missing supplement validation**: Legacy checks that all required
   supplements were used and throws `VALUESET_SUPPLEMENT_MISSING` if
   not. Fix: port the validation check.

**Implementation**: All 4 fixes are in `_tryIRExpansion` and
`buildExpandedValueSet` — ~30 lines of orchestration plumbing.
No IR compiler, SQL builder, or provider changes needed.

**Tests ported from codex-2 (9)**:
| # | Test | What it covers |
|---|---|---|
| 1 | `supplement: useSupplement applies content + records used-supplement` (L1300) | Wire useSupplement, designation projection, used-supplement emission |
| 2 | `supplement: provided but not requested is ignored` (L1355) | Negative: unrequested supplement must not leak |
| 3 | `supplement: valueset-supplement extension activates` (L1391) | VS extension reads supplement canonical |
| 4 | `supplement: used-supplement deduped` (L1433) | Metadata: used-supplement appears once even if multiple codes match |
| 5 | `supplement: missing required fails` (L1472) | Validation: throws when useSupplement can't be resolved |
| 6 | `supplement: missing VS extension fails` (L1498) | Validation: throws when VS extension supplement can't be resolved |
| 7 | `supplement: designation filter selects supplement use-coded designation` (L1526) | Designation param filter works on supplement-provided designations |
| 8 | `supplement: version-pinned canonical accepted` (L1610) | Version-qualified useSupplement canonical resolves correctly |
| 9 | `supplement: itemWeight extension projected` (L1573) | Property projection from inline supplement (not filtering) |

Note: test 7 also depends on Phase 1.5 (designation parameter filter)
being implemented, since it filters designations by use code.

**New tests for v0 supplement path (~2)**:

The codex-2 tests above all use inline toy CodeSystems (cs-cs path).
We should also verify supplements work against real v0 providers:

| # | Test | What it covers |
|---|---|---|
| 10 | `supplement: inline supplement adds designation to SNOMED v0 code` | Submit supplement for 73211009 with German designation, verify with includeDesignations |
| 11 | `supplement: inline supplement display override on LOINC v0 code` | Submit supplement for 2160-0 with overridden display, verify in expansion |

---

## Phase 5-advanced — Supplement property projection and filtering (deferred)

These tests require deeper integration: sqlite supplement fixture DBs,
property projection from supplement-defined properties, filtering by
supplement property values at the SQL level, and codex-2-internal
tracing infrastructure (`patchWorker`). Deferred until the basic
supplement plumbing is proven and we need property-filter optimization.

**Property projection** (supplement adds properties to output, no filtering):
- `supplement: itemWeight extension projected` (L1573) — may work once
  basic plumbing is done if cs-cs merges extensions, but untested

**Sqlite-native D20 tests** (require fixture DBs + property filter pushdown):
- `supplement-sqlite: D20 LOINC projects property/designation` (L1646)
- `supplement-sqlite: D20 LOINC full-page parity` (L1692)
- `supplement-sqlite: D20 RxNorm projects property/designation` (L1765)
- `supplement-sqlite: D20 LOINC + RxNorm both apply` (L1811)
- `supplement-sqlite: D20 SNOMED projects property/designation` (L1852)
- `supplement-sqlite: SNOMED D20 + designation filter` (L1898)
- `supplement-sqlite: SNOMED D20 concept filter + property` (L1943)
- `supplement-sqlite: filter by supplement property value (fallback)` (L1984)
- `supplement-sqlite: tx-resource negotiated as sqlite-native` (L2009)

**Codex-2-internal tracing** (use `patchWorker` — not portable):
- `supplement-report: provider-owned filtering avoids fallback` (L2088)
- `supplement-report: unsupported supplement clause fails` (L2139)

**Multi-supplement property filtering**:
- `supplement d20+d8 loinc: d20=20,d8=8` (L5132)
- `supplement d20+d8 loinc: d20=4,d8=8` (L5186)

---

## Phase 6 — Grammar-based providers (UCUM, MIME, language)

### 6.1 UCUM whole-system: specialEnumeration handling

**Problem**: UCUM whole-system returns 0 codes in IR. Legacy handles
this via `specialEnumeration()`—when a provider returns a VS URL
from `specialEnumeration()`, legacy expands that VS instead of
iterating the code system. UCUM returns
`http://hl7.org/fhir/ValueSet/ucum-common` which has ~300 common units.

The IR engine's `LegacyIRAdapter` calls `iteratorAll()` which
delegates to `iterator(null)` on UCUM, which returns null→empty.
The adapter doesn't know about `specialEnumeration()`.

**Fix**: In `LegacyIRAdapter.executeSelector()`, when `shape==='whole'`
and `provider.specialEnumeration()` returns a URL, resolve and expand
that VS instead of calling `iteratorAll()`. Also set the
`valueset-unclosed` flag on the expansion.

**Tests**: `notClosed: UCUM expansion reports valueset-unclosed` (L2195)

### 6.2 MIME/language grammar errors

MIME and language whole-system should throw "cannot be enumerated"
errors. Currently the IR engine returns empty instead of erroring.

**Fix**: `LegacyIRAdapter.executeSelector()` for `shape==='whole'`
should check `provider.totalCount() === -1` (grammar-based) and
either throw or return a signal that triggers the error.

**Tests**: `notClosed: MIME whole-system not enumerable` (L2832)

---

## Phase 7 — Limit enforcement and too-costly errors

The IR engine doesn't implement the `limit` parameter's too-costly
check. Legacy throws `VALUESET_TOO_COSTLY` when total > limit and
no pagination is used.

Currently, IR silently truncates to `EXTERNAL_DEFAULT_LIMIT` (1000)
when no count is specified. With pagination (`count` + `offset`),
users can page through any result set.

**What to implement**:
1. When `params.limit > 0` and no pagination (`offset < 0`), check
   total against limit before returning. Throw too-costly if exceeded.
2. When `params.limit > 0` with pagination, allow partial pages
   (current behavior is correct).
3. Text filter + limit: skip total computation, just cap results.

**Tests**:
- `logic: low limit without pagination returns too-costly` (L4389)
- `logic: low limit with pagination allows partial page` (L4404)
- `logic: text-filter low-limit fallback short-circuits without total` (L4419)

---

## Phase 8 — High-value stress tests (4 codex-2 tests)

These are expensive integration tests verifying behavior at scale.
No engine changes needed—they test pagination stability and parity.

- `high-value: mixed-system text filter limit boundary` (L4437) —
  needs Phase 7 (limit enforcement) first
- `high-value: include.valueSet + sibling filter at scale` (L4513) —
  portworthy after Phase 2; tests import + filter pagination
- `high-value: SNOMED hierarchy tail pagination stable` (L5014) —
  portworthy now; tests deep offset on large is-a
- `high-value: complex same-system inc/exc pages consistent` (L5070) —
  portworthy now; tests multi-include with excludes

---

## Codex-2-internal tests (not applicable)

These test codex-2-specific internals that don't exist in our engine:

| Test | Why N/A |
|---|---|
| `logic: total policy decision table` (L3987) | Tests `decideTotalOutcome()` function from codex-2's `expand-v3/` |
| `logic: display fast path exercised` (L4025) | Tests codex-2 trace counter `display_fastpath_hits` |
| `logic: sqlite-v0 pushdown active` (L3899) | Tests codex-2 trace span `v0.expandQuery` |
| `logic: fallback deep-offset no partial total` (L4210) | Tests codex-2 pushdown-off fallback behavior |
| `v3-gap: mixed-system import prevents root pushdown` (L4931) | Tests codex-2 root pushdown guard |

These 5 tests are truly N/A. Our engine's equivalent behaviors are
tested via e2e parity (Phase 3) and functional tests (Phases 1–2).
The trace/pushdown-toggle infrastructure doesn't exist in our engine.

---

## Execution order

1. ✅ **Phase 1.1–1.4** (dfedbd0): compose display/designation overrides,
   used-valueset, count≥0 guard. Tests: 1508e12.
2. ✅ **Phase 1.5** (991ed82): designation parameter filter +
   comprehensive param echoing (designations, displayLanguage, properties).
3. ✅ **Phase 1.6–1.8** (99be2ca): displayLanguage echoed, redundant
   designation test (passes as-is), property regex in sqlite-v0-sql.
4. ✅ **Phase 2 batches 1-3** (7c1c316, 6f5516c, 67d8fe0): 40 ported
   tests covering shape-A/B, infra, filters, logic, pagination,
   multi-system, coverage, pagination-safety. 109 total tests.
6. **Create `scripts/ir-rewrite-tests.mjs`** for Phase 3 unit tests
7. **Add e2e rewrite parity tests** to the harness
8. **Phase 4**: Add missing providers to fixture YAML (usstates,
   areacode, mimetypes) + port unblocked tests
9. **Phase 5**: Wire useSupplement + valueset-supplement extension
   into IR findProvider callback, emit used-supplement, validate
   missing supplements. All inline CS — no SQL changes.
   Port 9 codex-2 tests + 2 new v0 supplement tests.
10. **Phase 6**: Grammar-based provider handling (UCUM specialEnumeration,
    MIME/lang too-costly errors)
11. **Phase 7**: Limit enforcement + too-costly errors
12. **Phase 8**: High-value stress tests
13. **Phase 5-adv** (deferred): Supplement property filter pushdown,
    SQLite supplement fixture DBs, codex-2-internal tracing tests

## Test count projection

| Phase | New tests | Running total | Notes |
|---|---|---|---|
| Current | 61 | 61 | |
| Phase 1 fixes + tests | ~8 | ~69 | Engine changes (4 already committed) |
| Phase 2 ports | ~25 | ~94 | No engine changes |
| Phase 3 rewrite tests | ~9 | ~103 | Unit + parity |
| Phase 4 fixture | ~14 | ~117 | YAML change only |
| Phase 5 inline supplements | ~11 | ~128 | Inline CS plumbing (9 codex-2 + 2 new v0) |
| Phase 6 grammar providers | ~3 | ~131 | Adapter changes |
| Phase 7 limit/too-costly | ~3 | ~134 | |
| Phase 8 high-value | ~4 | ~138 | |
| Phase 5-adv supplement filters | ~13 | ~151 | SQLite fixtures, property filter pushdown |
| **N/A** | | | 6 codex-2-internal / v3-only |

## Committed Phase 1 work

Commit `dfedbd0` implements Phase 1 items 1.1–1.4:
- `tx/engine/orchestrator.js`: compose display/designation override,
  used-valueset emission, count≥0 guard, collectComposeOverrides/
  applyComposeOverrides/walkIR helpers, addParamIfAbsent helper
- `tx/engine/resolve-imports.js`: usedValueSets tracking in
  resolveImports, attached as `_usedValueSets` on resolved IR

---

## Appendix: Full codex-2 cross-reference

Every codex-2 test mapped to a disposition. Legend:
- ✅ = already ported (equivalent test exists in ir-harness)
- 🟢 = port now (works today, no engine change needed) — Phase 2
- 🟡 = port after fix (needs engine change) — Phase 1
- 🟠 = rewrite unit test — Phase 3
- 🟣 = supplement system — Phase 5
- 🟫 = fixture expansion — Phase 4 (add to YAML then port)
- 🟥 = grammar/limit handling — Phase 6–7
- 🟧 = high-value stress test — Phase 8
- ⚫ = codex-2-internal (5 tests, not applicable)

### shape-A (whole system)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 1 | shape-A: US states full expansion | 🟫 | USPS not loaded |
| 2 | shape-A: currency full expansion | 🟢 | internal:currency loaded |
| 3 | shape-A: administrative-gender (cs-cs) | 🟢 | covered by `gender whole-system: 4 codes` but codex-2 has tighter assertions |
| 4 | shape-A: publication-status (cs-cs) | 🟢 | |
| 5 | shape-A: area codes full expansion | 🟫 | M49 not loaded |

### infra
| # | Test | Disposition | Notes |
|---|---|---|---|
| 6 | infra: tx-resource injected CodeSystem | 🟢 | verified via curl; already works |
| 7 | infra: tx-resource injected VS import | 🟢 | verified via curl; already works |

### supplement (22 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 8 | supplement: useSupplement applies content + records used-supplement | 🟣 | Phase 5: inline CS plumbing |
| 9 | supplement: provided but not requested is ignored | 🟣 | Phase 5: negative test |
| 10 | supplement: valueset-supplement extension activates | 🟣 | Phase 5: VS extension |
| 11 | supplement: used-supplement deduped | 🟣 | Phase 5: metadata |
| 12 | supplement: missing required fails | 🟣 | Phase 5: validation |
| 13 | supplement: missing VS extension fails | 🟣 | Phase 5: validation |
| 14 | supplement: designation filter selects supplement use | 🟣 | Phase 5 + Phase 1.5 (designation filter) |
| 15 | supplement: itemWeight extension projected | 🟣 | Phase 5: property projection (inline CS, no filtering) |
| 16 | supplement: version-pinned canonical accepted | 🟣 | Phase 5: version-qualified canonical |
| 17–25 | supplement-sqlite: * (9 tests) | 🟤 | Phase 5-adv: sqlite fixtures + property filter |
| 26–27 | supplement-report: * (2 tests) | ⚫ | Phase 5-adv: codex-2 patchWorker internals |
| 154–155 | supplement d20+d8 loinc: * (2 tests) | 🟤 | Phase 5-adv: multi-supplement property filter |

### params
| # | Test | Disposition | Notes |
|---|---|---|---|
| 30 | params: property=definition | 🟢 | verified working via curl |
| 31 | params: language code includeDesignations (internal:lang) | 🟫 | bcp:47 concept include works but whole-system doesn't |

### notClosed
| # | Test | Disposition | Notes |
|---|---|---|---|
| 32 | notClosed: UCUM valueset-unclosed | 🟥 | Phase 6: needs specialEnumeration handling |
| 33 | notClosed: MIME whole-system not enumerable | 🟫 | MIME provider not loaded |

### meta (9 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 34 | meta: multi-system used-codesystem | ✅ | `meta: multi-system emits used-codesystem for each system` |
| 35 | meta: used-codesystem dedupes | ✅ | `meta: used-codesystem dedupes repeated same-system` |
| 36 | meta: ValueSet import used-valueset | 🟡 | needs 1.3 (stashed) |
| 37 | meta: offset/count echoed | ✅ | `meta: offset/count are echoed in expansion parameters` |
| 38 | meta: text filter echoed | ✅ | `meta: text filter is echoed in expansion parameters` |
| 39 | meta: draft warning | ✅ | `meta: warning-draft for draft CodeSystem` |
| 40 | meta: retired warning | ✅ | `meta: warning-retired for retired CodeSystem` |
| 41 | meta: draft suppressed when VS is draft | ✅ | `meta: NO warning-draft when VS is also draft` |
| 42 | meta: fragment valueset-unclosed | ✅ | `meta: fragment CodeSystem sets valueset-unclosed extension` |

### shape-B (enumerated)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 43 | shape-B: US states enumerated | 🟫 | USPS not loaded |
| 44 | shape-B: gender enumerated subset | ✅ | `gender enumerated subset: male+female only` |
| 45 | shape-B: SNOMED enumerated | ✅ | `SNOMED 3 codes: correct displays` |
| 46 | shape-B: LOINC enumerated | ✅ | `LOINC enumerated: 2160-0 + 2345-7` |
| 47 | shape-B: RxNorm enumerated | ✅ | `RxNorm enumerated: aspirin + ibuprofen + acetaminophen` |
| 48 | shape-B: user-supplied display override | 🟡 | needs 1.1 (stashed) |
| 49 | shape-B: single concept exact match (v0) | 🟢 | |
| 50 | shape-B: language codes enumerated | 🟫 | bcp:47 not enumerable as whole system |
| 51 | shape-B: MIME types enumerated | 🟫 | MIME not loaded |

### filter (13 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 52 | filter: area codes class=region | 🟫 | M49 not loaded |
| 53 | filter: area codes class=country | 🟫 | M49 not loaded |
| 54 | filter: currency decimals=0 | 🟢 | internal:currency loaded |
| 55 | filter: country code regex A.* | 🟢 | internal:country loaded |
| 56 | filter: gender regex [mf].* | 🟢 | verified working |
| 57 | filter: SNOMED is-a diabetes | ✅ | `is-a Diabetes: 124 codes` |
| 58 | filter: SNOMED descendent-of diabetes | ✅ | `descendent-of Diabetes: 123 codes` |
| 59 | filter: inline FHIR is-a (condition-ver-status) | 🟢 | verified working |
| 60 | filter: inline FHIR descendent-of | 🟢 | verified working |
| 61 | filter: inline FHIR concept = exact | 🟢 | verified working |
| 62 | filter: SNOMED concept-in refset | ✅ | `SNOMED concept-in refset 723560006` |
| 63 | filter: RxNorm TTY=IN | ✅ | `RxNorm TTY=IN first 50` |
| 64 | filter: LOINC STATUS=ACTIVE | ✅ | `LOINC STATUS=ACTIVE first 20` |

### lang (7 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 65 | lang: includeDesignations SNOMED concept | ✅ | `lang: SNOMED includeDesignations returns entries` |
| 66 | lang: designation filter by FSN | 🟡 | needs 1.5 |
| 67 | lang: displayLanguage=en | 🟡 | needs 1.6 |
| 68 | lang: compose inline designation | 🟡 | needs 1.2 (stashed) |
| 69 | lang: includeDesignations cs-cs whole-system | 🟢 | |
| 70 | lang: includeDesignations SNOMED is-a filter | ✅ | `lang: SNOMED is-a filter includeDesignations` |
| 71 | lang: redundant designation suppressed | 🟡 | needs 1.7 |

### text-search (7 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 72 | text-search: SNOMED filter=diabetes | ✅ | covered by `is-a Diabetes + text` tests |
| 73 | text-search: SNOMED filter=diabetes no pagination | 🟢 | good regression test |
| 74 | text-search: SNOMED filter + is-a combined | ✅ | `combined: SNOMED is-a + text filter` |
| 75 | text-search: RxNorm filter=aspirin | ✅ | `RxNorm text aspirin + TTY=IN` |
| 76 | text-search: LOINC filter=creatinine | ✅ | `LOINC text creatinine first 20` |
| 77 | text-search: inline FHIR filter=male | ✅ | `text filter across cs-cs systems` |
| 78 | text-search: multi-system with filter | ✅ | `Mixed v0+cs-cs + text filter` |

### exclude (8 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 79 | exclude: gender minus other+unknown | ✅ | `gender exclude: minus other+unknown = male+female` |
| 80 | exclude: US states subtract 2 from 4 | 🟫 | USPS not loaded |
| 81 | exclude: SNOMED exclude enumerated from is-a | ✅ | `Diabetes exclude 2 enumerated codes` |
| 82 | exclude: SNOMED is-a minus Type2 | ✅ | `Diabetes minus Type2 subtree: 108 codes` |
| 83 | exclude: SNOMED is-a minus Type1 | ✅ | covered by `Diabetes minus Type1+Type2` |
| 84 | exclude: inline FHIR filter-based exclude | 🟢 | condition-ver-status loaded |
| 85 | exclude: cross-system multi-exclude | ✅ | `cross-system exclude: gender+pubstat minus both unknowns` |
| 86 | exclude: exclude from whole system | 🟫 | USPS not loaded |

### pagination (8 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 87 | pagination: currency count=10 offset=0 | 🟢 | currency loaded |
| 88 | pagination-bug: preloaded map total consistency | 🟢 | use currency instead of USPS |
| 89 | pagination: US states disjoint pages | 🟫 | USPS not loaded |
| 90 | pagination: US states last page partial | 🟫 | USPS not loaded |
| 91 | pagination: US states offset beyond end | 🟫 | USPS not loaded (but covered by existing) |
| 92 | pagination: SNOMED is-a paginated | ✅ | `Diabetes pages are disjoint` |
| 93 | pagination: count=0 returns total only | ✅ | `Clinical finding count=0: total=124412` |
| 94 | pagination: high offset (>1000) | ✅ | `LOINC STATUS=ACTIVE high offset (1000,20)` |
| 95 | pagination: deep offset invariant | ✅ | `deep offset 110K into 124K set` |

### multi-system (5 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 96 | multi-system: gender + US states | 🟫 | USPS not loaded |
| 97 | multi-system: SNOMED + gender (mixed) | ✅ | `Mixed v0+cs-cs: gender (4) + SNOMED enum (1) = 5` |
| 98 | multi-system: three systems | ✅ | `SNOMED+LOINC+RxNorm enum: 3 codes, 3 systems` |
| 99 | multi-system: v0 filter + preloaded + cs-cs | 🟢 | substitute currency for USPS |
| 100 | multi-system: same system dedup | ✅ | `same-system dedup: gender male+female ∪ female+other = 3` |

### vs-import (2 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 101 | vs-import: pure import admin-gender | ✅ | `vs-import: pure import of administrative-gender` |
| 102 | vs-import: system + valueSet intersection | ✅ | `vs-import: system + valueSet intersection` |

### combined (4 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 103 | combined: SNOMED is-a + text | ✅ | `combined: SNOMED is-a + text filter` |
| 104 | combined: include + exclude filter same system | ✅ | `combined: include filter + exclude filter same system` |
| 105 | combined: enumerated + text filter | ✅ | `combined: enumerated + text filter` |
| 106 | combined: multi-system + exclude + pagination | ✅ | `combined: multi-system + exclude + pagination` |

### provider (4 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 107 | provider: preloaded map iteration (currency) | 🟢 | currency loaded |
| 108 | provider: cs-cs hierarchy iteration | 🟢 | condition-ver-status loaded |
| 109 | provider: v0 SNOMED large is-a pagination | 🟢 | port as pagination consistency test |
| 110 | provider: v0 RxNorm text + property combined | 🟢 | |

### coverage (8 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 111 | coverage: UCUM whole-system + lang peer | 🟢 | UCUM + gender peer (skip lang peer) |
| 112 | coverage: MIME concept + lang peer | 🟫 | MIME not loaded |
| 113 | coverage: tx-resource whole + cs-cs peer | 🟢 | |
| 114 | coverage: tx-resource concept + exclude + peer | 🟢 | |
| 115 | coverage: valueset-import + USPS peer | 🟢 | substitute gender for USPS |
| 116 | coverage: valueset-import + USPS peer + exclude | 🟢 | substitute gender for USPS |
| 117 | coverage: country regex + cs-cs peer | 🟢 | country + gender |
| 118 | coverage: areacode class filter + cs-cs peer | 🟫 | M49 not loaded |

### pagination-safety (5 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 119 | pagination-safety: mixed v0 + cs-cs reconstruct | ✅ | `pagination-safety: mixed v0+cs-cs reconstruct full set` |
| 120 | pagination-safety: mixed v0 + preloaded reconstruct | 🟢 | use currency instead of USPS |
| 121 | pagination-safety: valueset-import + excludes | 🟢 | |
| 122 | pagination-safety: mixed providers disjoint windows | ✅ | `pagination-safety: v0 filter+cs-cs pages are disjoint` |
| 123 | pagination-safety: import+system high-count not capped | 🟢 | |

### logic (17 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 124 | logic: sqlite-v0 pushdown active | ⚫ | trace assertion; behavior covered |
| 125 | logic: same-system VS intersections | 🟢 | verified working |
| 126 | logic: regex filter in v0 pushdown | 🟢 | code regex works; port behavior part |
| 127 | logic: property regex in v0 | 🟡 | needs 1.8 |
| 128 | logic: total policy decision table | ⚫ | tests codex-2-only function |
| 129 | logic: display fast path | ⚫ | tests codex-2-only trace counter |
| 130 | logic: imported inc/exc VS semantics | 🟢 | |
| 131 | logic: total includes imported contributions | 🟢 | |
| 132 | logic: whole-system descendant total | 🟢 | |
| 133 | logic: total reflects imported excludes | 🟢 | |
| 134 | logic: fallback deep-offset no partial total | ⚫ | tests codex-2 fallback mode |
| 135 | logic: system exclude global with imports | 🟢 | adapt: drop trace assertions, test behavior only |
| 136 | logic: mixed import+peer pagination | 🟢 | |
| 137 | logic: bulk locate >50 concepts | 🟢 | |
| 138 | logic: low limit returns too-costly | 🟥 | Phase 7: limit enforcement |
| 139 | logic: low limit + pagination partial | 🟥 | Phase 7: limit enforcement |
| 140 | logic: text-filter low-limit short-circuits | 🟥 | Phase 7: limit enforcement |

### high-value (4 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 141 | high-value: mixed-system text filter limit | 🟧 | Phase 8, needs Phase 7 first |
| 142 | high-value: include.valueSet + sibling filter | 🟧 | Phase 8 |
| 143 | high-value: SNOMED hierarchy tail pagination | 🟧 | Phase 8 |
| 144 | high-value: complex same-system inc/exc pages | 🟧 | Phase 8 |

### v3-lowering (3 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 145 | v3-lowering: import-intersect-union single pushdown | 🟠 | parity test: optimized vs unoptimized |
| 146 | v3-lowering: include minus union-excludes | 🟠 | parity test |
| 147 | v3-lowering: include minus imported diff | 🟠 | parity test |

### v3-lowering-gap (6 tests)
| # | Test | Disposition | Notes |
|---|---|---|---|
| 148 | v3-lowering-gap: intersect same-system filters coalesce | 🟠 | unit test on our rewrite.js |
| 149 | v3-lowering-gap: nested diff partitioning | 🟠 | unit test |
| 150 | v3-lowering-gap: duplicate filter dedup | 🟠 | unit test |
| 151 | v3-lowering-gap: intersect filter+concept → intersectCodes | 🟠 | unit test |
| 152 | v3-lowering-gap: projection eliminates empty intersect | 🟠 | unit test |
| 153 | v3-lowering-gap: union folding concept+filter dedup | 🟠 | unit test (adapted; no queryIR) |

### v3-invariant / v3-gap
| # | Test | Disposition | Notes |
|---|---|---|---|
| 154 | v3-invariant: import+filter deep page parity | ⚫ | N/A: explicitly v3-only (`EXPAND_IMPL !== 'v3'` guard) |
| 155 | v3-gap: mixed-system import prevents root pushdown | ⚫ | N/A: codex-2-internal |

---

## Summary by disposition

| Disposition | Count | Phase | Description |
|---|---|---|---|
| ✅ Already ported | 41 | — | Equivalent test in ir-harness |
| 🟢 Port now | ~30 | 2 | Works today, just needs test |
| 🟡 Port after fix | ~7 | 1 | Needs engine change (4 committed) |
| 🟠 Rewrite unit test | ~9 | 3 | IR optimizer verification |
| 🟫 Fixture expansion | ~14 | 4 | Add providers to YAML, then port |
| 🟣 Inline supplements | 9 | 5 | Inline CS plumbing (designations + property projection) |
| 🟤 Advanced supplements | 13 | 5-adv | SQLite supplement DBs, property filtering, codex-2 internals |
| 🟥 Grammar/limit | ~6 | 6–7 | UCUM specialEnumeration, too-costly |
| 🟧 High-value stress | ~4 | 8 | Large-scale pagination/parity |
| ⚫ Codex-2-internal | 6 | N/A | Trace assertions, decision tables, v3-only guards |
| **Total** | **~139** | | 6 N/A + ~133 eventually testable |

Phase 5 also adds ~2 new tests (v0 supplement path) not from codex-2.

---

## Known gaps discovered during implementation

### Concept-valued property filters: code-or-display matching (won't fix)

The legacy v0 provider supports `linkMatch: "code-or-display"` for
concept-valued property filters (e.g. LOINC CLASS, COMPONENT, etc.).
When filtering `CLASS = CHEM`, the legacy provider matches against
both the target concept's code (`LP7786-9`) AND its display (`CHEM`).

The IR SQL builder (`sqlite-v0-sql.js`) only matches against `code IN (...)`,
which is the correct FHIR behavior — the `=` operator on a Coding-valued
property should match by code, not display text.

**The legacy `code-or-display` behavior is probably wrong.** FHIR R4
§5.8.2 defines property filter `=` as matching the property value,
which for a Coding-typed property means the code. Matching on display
text conflates two distinct axes (code identity vs. human label) and
produces fragile results that break when displays change.

**Disposition: intentionally deferred / won't replicate in IR engine.**
The IR engine's code-only matching is the correct behavior. If backward
compatibility with old ValueSets that assumed display matching is ever
needed, the right approach would be to register a small number of
value aliases in the CodeSystem's runtime metadata (e.g. mapping the
string `"CHEM"` → `"LP7786-9"` for LOINC CLASS). This keeps the
matching semantics clean while accommodating legacy content.

**Current impact**: LOINC CLASS, COMPONENT, PROPERTY, TIME_ASPCT,
SYSTEM, SCALE_TYP, METHOD_TYP filters using display-text values
return 0 results via native IR SQL pushdown but still work via the
LegacyIRAdapter fallback path (which delegates to the legacy provider).
No tests depend on this behavior — all existing LOINC property filter
tests use correct code values or literal-valued properties like STATUS.
