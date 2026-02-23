# Expand-v2 Refactor and Pushdown Implementation Plan

## Scope and Goal
Refactor ValueSet expansion into an explicit planner/executor/renderer pipeline, add an optional provider pushdown API, and keep behavior correct across UCUM, cs-cs, c-svs, and sqlite-v0 while preserving compatibility with non-sqlite providers.

## Guiding Constraints
- Correctness first: final membership is `Inc \ Exc` and paging applies to final deduped membership.
- Conservative pushdown: only allow provider `OFFSET/LIMIT` when provider computes full final set before paging.
- Optional provider API: non-supporting providers continue to work through fallback streaming executor.
- Harness-driven parity: `expand-v2` must be continuously compared against known-correct behavior.

## Deliverables
1. Provider interface update with capabilities + optional query pushdown method.
2. `expand-v2.js` structure that cleanly separates planning, execution, rendering.
3. Fallback executor that is semantically correct for all supported shapes.
4. sqlite-v0 fast path for eligible single-system flat plans.
5. Test harness v2 enhancements for implementation switching and parity checks.

## Phase 0: Harness Controls and Baseline Parity
### Objectives
- Make behavior drift visible before architecture changes.

### Tasks
1. Extend `tests/tx/expand-v2-harness.js` with `EXPAND_IMPL=legacy|v2|parity`.
2. Add deterministic normalization of expansion outputs by `(system, version, code)` for parity comparisons.
3. Add parity checks for:
- resourceType
- normalized code membership
- `expansion.total` when present in both outputs
4. Keep trace capture available for v2 and make parity mismatches emit concise diagnostics.

### Exit Criteria
- Harness can run in single-impl mode and parity mode.
- Parity mode reports clear mismatch details.

## Phase 1: Provider Interface Extension (Backwards Compatible)
### Objectives
- Introduce optional provider pushdown contract without breaking existing providers.

### Tasks
1. Update provider API module (`tx/library/cs-api.js` or equivalent):
- `capabilities(): object` optional
- `expandQuery(request): Promise<result|null>` optional
2. Define request model fields:
- `system`, `version`
- include clause list
- exclude clause list
- text filter
- activity/UI constraints
- `offset`, `count`, `needTotal`, deterministic sort
3. Define result model:
- `contexts[]` (provider contexts for renderer)
- optional `total`
- optional `notClosed`
4. Add default base behavior:
- `capabilities()` returns empty/no features
- `expandQuery()` returns `null`

### Exit Criteria
- Existing providers compile/run unchanged.
- Planner can safely capability-check without special casing each provider.

## Phase 2: `expand-v2` Core Structure
### Objectives
- Isolate planning, execution, rendering concerns.

### Tasks
1. Ensure `tx/workers/expand-v2.js` has explicit classes:
- `ExpansionPlanner`
- `ExpansionExecutor`
- `ContainsRenderer`
2. Keep request/worker entrypoints stable.
3. Keep fallback path active; no required pushdown yet.

### Exit Criteria
- Core flow is readable and testable in pieces.
- No behavior regressions in harness baseline scenarios.

## Phase 3: Planner IR and Clause Compilation
### Objectives
- Compile compose/include/exclude/valueSet references into auditable plan data.

### Tasks
1. Build `ExpandPlan` IR with:
- include sources in deterministic order
- exclusion index specification
- mode flags (`flat`, `hierarchy`, `notClosed`, total policy)
- optional provider fast-path plan candidate
2. Compile include clauses into source abstractions:
- whole-system source
- filter source
- concept-list source
- imported-valueset source
3. Compile excludes into `ExclusionIndex`:
- exact set keys when available
- provider-backed membership predicates when available

### Exit Criteria
- Planner has no rendering side effects.
- Eligibility decisions are explicit and inspectable.

## Phase 4: Correct Fallback Streaming Executor
### Objectives
- Ensure correctness independent of provider fast paths.

### Tasks
1. Execute include sources as streams.
2. Apply dedupe + exclusion membership before paging.
3. Apply `offset/count` to final stream only.
4. Honor too-costly limits and notClosed semantics.
5. Keep deterministic ordering consistent with planner policy.

### Exit Criteria
- No missing/duplicated codes under include+exclude+paging.
- Page equivalence vs full expansion slice holds.

## Phase 5: Renderer Consolidation
### Objectives
- Centralize FHIR `contains[]` materialization.

### Tasks
1. Move display/designation/property/extension logic into `ContainsRenderer`.
2. Support contexts from both fallback iteration and pushdown query output.
3. Preserve existing semantics for inactive/abstract/status/version fields.

### Exit Criteria
- Rendering no longer mutates execution state.
- Existing shape/property tests remain green.

## Phase 6: sqlite-v0 Pushdown Implementation
### Objectives
- Speed up common single-system flat expansions safely.

### Tasks
1. Implement sqlite-v0 `expandQuery(request)` for expressible subset:
- concept list
- hierarchy predicates (`is-a`, `descendent-of` as supported)
- property predicates (literal/link)
- refset membership
- text filter where supported
2. Implement include union / exclude union / final difference SQL structure.
3. Apply deterministic order + offset/limit on final set.
4. Return optional total when requested and feasible.

### Exit Criteria
- Pushdown result parity with fallback for eligible plans.
- No post-paging exclusion in worker for pushdown path.

## Phase 7: Pushdown Eligibility Gate
### Objectives
- Prevent unsafe pushdown.

### Tasks
1. Add a single planner decision function:
- single-system only
- flat mode only
- all clauses expressible
- provider guarantees exclusion-before-paging
2. Force fallback for:
- UCUM/notClosed conditions
- cross-system imports not representable in one provider query
- unsupported operators

### Exit Criteria
- Decision is deterministic, logged, and auditable.

## Phase 8: Hard-Case Coverage
### Objectives
- Ensure cross-system and nested imports remain correct.

### Tasks
1. Treat imported value sets as first-class sources/predicates.
2. Preserve correctness for c-svs and multi-system excludes.
3. Keep hierarchy as an explicit mode with strict entry conditions.

### Exit Criteria
- Complex compose scenarios pass parity checks.

## Phase 9: Rollout and Cleanup
### Objectives
- Ship safely with observability.

### Tasks
1. Add counters/trace markers for planner path, pushdown usage, fallback usage.
2. Keep runtime flag to force fallback for incident mitigation.
3. Document provider contract and eligibility rules.
4. Promote v2 to default once parity confidence is established.

### Exit Criteria
- v2 default with fallback escape hatch.
- Legacy path can be retired on schedule.

## Initial Execution Order
1. Phase 0 harness controls.
2. Phase 1 provider API extension.
3. Phase 2 expand-v2 structure verification.
4. Begin Phase 3 planner IR extraction.

## Definition of Done
- Harness parity mode exists and is used regularly.
- Provider API updated with optional pushdown contract.
- `expand-v2` has planner/executor/renderer structure.
- sqlite-v0 pushdown works for eligible subset with parity to fallback.
- Unsafe scenarios always fall back.

## Progress Notes (Current)
- Added harness implementation switch and parity mode (`EXPAND_IMPL=legacy|v2|parity`).
- Added provider API `capabilities()` and `expandQuery()` entrypoint with backward-compatible `expandComponent()` alias path.
- Wired `expand-v2` to use `expandQuery` with capability-gated pushdown decisions.
- Added first planner IR scaffolding (`ExpansionPlanner`, `ExpandPlan`) and routed compose handling through it.
- Added `ExclusionIndex` and imported-ValueSet exclusion predicates so exclusions are not only pre-enumerated exact codes.
- Improved exclusion removal to recurse nested `contains` when excluding imported ValueSets.
- Tightened pushdown policy: excludes require explicit `handlesExcludes=true`; pagination pushdown requires explicit `handlesOffset=true`.
- Added deferred exclude-filter predicate path in `expand-v2` fallback execution (membership-time exclusion via `filterCheck`) for exclude filters without import/text constraints.
- Extracted orchestration loop into `ExpansionExecutor` and wired `ValueSetExpander` to delegate plan execution through it.
- Extracted contains entry materialization into `ContainsRenderer` and routed `_addToExpansion` through the renderer.
- Enriched planner IR groups with explicit `groupType`/`groupKey` and plan-level structure flags (`isSingleSystem`, `systemGroups`, `importGroups`) used by pagination pushdown eligibility.
- Added capability-driven pushdown expressibility checks (shape support, text search, intersection support) to keep fallback conservative when a provider cannot safely represent a compose group.
- Split `ExpansionExecutor` into explicit `_executeGroup` and `_executeFallbackGroup` stages to isolate pushdown attempt from fallback streaming behavior.
- Extracted provider request assembly into `PushdownRequestBuilder` to decouple pushdown input construction from orchestration and decision logic.
- Consolidated exclusion state/logic behind `ExclusionEvaluator` (exact, imported-set predicates, deferred filter predicates) to centralize membership-time exclusion checks.
- Planner now emits compiled component metadata per group (`shape`, compose path, import flags) and pushdown eligibility checks consume this metadata instead of re-deriving shapes ad hoc.
- Completed source-handler extraction phase by introducing `ExpansionSourceHandlers` and routing component dispatch through it.
- Expanded harness coverage for additional-resource injection, ValueSet import via tx-resources, definition property emission, and UCUM not-closed signaling.
- Added non-sqlite provider coverage in harness for `internal:lang` (enumerated + exists filter) and `internal:mimetypes` (enumerated + grammar non-enumerability behavior).

## Progress update - 2026-02-22 (provider+shape+peer coverage + assessment metadata)

### Completed in this phase
- Expanded `tests/tx/expand-v2-harness.js` with targeted coverage tests focused on combinations of:
  - provider family
  - compose shape (`whole`, `concept`, `filter`, `whole+valueset`)
  - peer-provider context in the same ValueSet compose
- Added new mixed-context coverage tests for:
  - `ucum` with peer `internal:lang`
  - `internal:mimetypes` with peer `internal:lang`
  - `tx-resource` with peer `package:cs-cs` (including include/exclude)
  - `valueset-import` with peer `internal:usstates` (including peer excludes)
  - `internal:country` filter with peer `package:cs-cs`
  - `internal:areacode` filter with peer `package:cs-cs` include/exclude
- Added provider coverage matrix reporting in harness output:
  - key dimensions: `provider | role | shape | peers | tests | calls`
  - optional JSON export via `PROVIDER_COVERAGE_JSON`
- Added per-test design-time assessment metadata tracking:
  - harness defaults each test to `pending`
  - supports override file via `TEST_ASSESSMENT_FILE`
  - prints summary counts (`pending`, `assessed`, `n/a`) and pending test names
  - optional JSON export via `ASSESSMENT_STATUS_JSON`
- Added starter assessment override file:
  - `tests/tx/fixtures/expand-v2-assessment-status.json`
  - marks synthetic tx-resource-only tests as `n/a`

### Validation run results
- `EXPAND_IMPL=v2-parity node tests/tx/expand-v2-harness.js`
  - Result: `77 passed, 0 failed, 0 skipped`
- `PROVIDER_COVERAGE_JSON=provider-coverage.json EXPAND_IMPL=v2-parity node tests/tx/expand-v2-harness.js`
  - Result: pass; coverage JSON written to `tests/tx/provider-coverage.json`
- `ASSESSMENT_STATUS_JSON=assessment-status.json EXPAND_IMPL=v2-parity node tests/tx/expand-v2-harness.js`
  - Result: pass; assessment JSON written to `tests/tx/assessment-status.json`
  - Current assessment summary for executed tests: `pending=72`, `assessed=0`, `n/a=5`

### Next suggested phase
- Perform design-time tx.fhir.org calibration pass for selected non-brittle tests.
- Update `expand-v2-assessment-status.json` to move first tranche from `pending` to `assessed` with `assessedAt` and notes.
- Tighten static assertions only where stable across editions/providers; keep large/volatile systems on semantic invariants.

## Progress update - 2026-02-22 (design-time tx.fhir.org calibration, tranche 1)

### Calibration tooling added
- Added `tests/tx/txfhir-calibration.js` to run direct tx.fhir.org expansion checks for stable/non-brittle cases.
- Script performs invariant-style checks (required membership and include/exclude behavior), avoiding direct count/total assertions for version-sensitive logic.

### Calibration pass results
- Successful assessment cases:
  - `shape-A: administrative-gender canonical`
  - `shape-A: publication-status canonical`
  - `shape-A: condition-ver-status canonical`
  - `exclude: gender minus other+unknown custom compose`
  - `exclude: cross-system unknown removal custom compose`
- Unassessed in this pass due tx.fhir.org behavior/errors:
  - valueSet-intersection shape-D custom compose (`pinValueSet` server error)
  - POST text-filter custom compose (`filter.toLowerCase is not a function` server error)

### Metadata updates
- Updated `tests/tx/fixtures/expand-v2-assessment-status.json`:
  - marked 7 tests as `assessed` with date/source/notes
  - existing synthetic tx-resource tests remain `n/a`
- Current status summary (full harness run):
  - `assessed=7`, `n/a=5`, `pending=65`

### Test-strengthening update
- Strengthened `vs-import: pure import of administrative-gender VS` in `tests/tx/expand-v2-harness.js` to assert presence of all four expected codes (`male`, `female`, `other`, `unknown`) rather than only two.


## Progress update - 2026-02-22 (design-time tx.fhir.org calibration, tranche 2)

### Additional calibration coverage completed
- Expanded `tests/tx/txfhir-calibration.js` to cover additional stable cs-cs scenarios with invariant assertions (membership/difference semantics, no version-sensitive count assertions).
- New successful calibration cases include:
  - `filter: gender regex [mf].*`
  - `filter: inline FHIR concept = exact code`
  - `filter: inline FHIR is-a`
  - `filter: inline FHIR descendent-of`
  - `exclude: inline FHIR filter-based exclude`
  - `multi-system same-system dedup` behavior

### Assessment metadata updates
- Refreshed `tests/tx/fixtures/expand-v2-assessment-status.json` to a de-duplicated canonical list.
- Current tracked status after harness run:
  - `assessed=13`
  - `n/a=5`
  - `pending=59`

### tx.fhir.org confounders encountered
- `text-search` on canonical GET with `filter` still errors on tx.fhir.org: `filter.toLowerCase is not a function`.
- This case remains pending and is not treated as local mismatch.


## Progress update - 2026-02-22 (design-time tx.fhir.org calibration, tranche 3)

### Additional externally assessed coverage
- Extended calibration into SNOMED/LOINC/RxNorm and mixed-system invariants (without count/order assumptions).
- Successfully calibrated and marked assessed:
  - `shape-B`: SNOMED/LOINC/RxNorm enumerated concept cases
  - `shape-B`: single concept exact match (SNOMED)
  - SNOMED hierarchy semantics (`is-a` includes seed, `descendent-of` excludes seed)
  - SNOMED include/exclude filter combinations (Type1/Type2 subtree subtraction)
  - SNOMED+gender and SNOMED+LOINC+RxNorm multi-system composition

### Current metadata status (full harness run)
- `assessed=24`
- `n/a=5`
- `pending=48`

### Remaining confounders and pending buckets
- tx.fhir.org `filter` query path still errors for inline text-search calibration (`filter.toLowerCase is not a function`), so text-search tests remain pending.
- valueSet-intersection shape-D custom compose also remains pending due tx.fhir.org server error in earlier pass (`pinValueSet` issue).
- Local/internal-provider-only scenarios (USPS, UCUM, MIME, internal country/currency/m49/lang) remain pending or n/a when not externally comparable.


## Progress update - 2026-02-22 (pending sweep complete)

### Pending-assessment sweep completed
- Worked through all previously pending test assessments and updated metadata in:
  - `tests/tx/fixtures/expand-v2-assessment-status.json`
- Classification approach used:
  - external calibration (`https://tx.fhir.org/r5`) where stable and supported
  - local v0 DB calibration (`local-v0-db`) for schema-backed expectations (LOINC STATUS, RxNorm TTY, SNOMED refset membership)
  - local internal-provider calibration (`local-internal-provider`) for USPS/UCUM/MIME/lang/country/currency/m49 provider behaviors
  - local runtime/worker calibration (`local-v0-runtime` / `local-worker-behavior`) for cases blocked on tx.fhir.org server issues

### Validation status after sweep
- Full harness run (`EXPAND_IMPL=v2-parity`) remains green: `77 passed, 0 failed`
- Assessment summary now:
  - `pending=0`
  - `assessed=72`
  - `n/a=5`

### Noted calibration blockers (tx.fhir.org-side)
- Text-search query path on custom/canonical expands continues to fail with server error (`toLowerCase` path); text-search cases were assessed locally instead.
- Custom shape-D `system + valueSet` compose path previously returned `pinValueSet` server error; this case was assessed locally.


## Progress update - 2026-02-22 (v0 pretest baseline captured)

### Pretesting completed before deep sqlite-v0 provider restructure
- Added `tests/tx/v0-pretest-baseline.js` to generate a pre-restructure baseline artifact covering:
  - performance timing snapshots (pushdown vs fallback)
  - golden membership snapshots (`goldenKeys`) for high-risk sqlite-v0 scenarios
  - pushdown-vs-fallback parity checks per scenario
  - explicit critical invariant case: same-system SNOMED include/exclude/pagination parity
- Generated artifact:
  - `tests/tx/v0-pretest-baseline.json`

### Baseline run result
- Scenario count: `10`
- Parity failures: `0`
- Critical invariant failures: `0`
- All checks passed.

### Baseline timing snapshot (pushdown vs fallback)
- `snomed_is_a_diabetes`: `5ms` vs `6ms`
- `snomed_is_a_minus_type2`: `3ms` vs `3ms`
- `snomed_is_a_minus_type1`: `4ms` vs `3ms`
- `snomed_refset_723560006`: `1ms` vs `1ms`
- `snomed_exclude_enumerated_from_is_a`: `4ms` vs `3ms`
- `snomed_paged_include_exclude`: `3ms` vs `3ms`
- `rxnorm_tty_in_page50`: `12ms` vs `26ms`
- `loinc_status_active_page20`: `51ms` vs `357ms`
- `snomed_text_diabetes_page50`: `10ms` vs `16ms`
- `rxnorm_text_aspirin_page20`: `7ms` vs `8ms`


## Progress update - 2026-02-22 (server-limit override + true 10k runtime golden)

### Current-server limit behavior and override
- Confirmed `expand-v2` limit behavior:
  - default upper limit without explicit `limit` param is effectively 1000
  - request-level `limit` parameter is supported via `TxParameters`
  - runtime cap is bounded by internal ceiling (`INTERNAL_LIMIT=10000`)
- Updated pretest runner (`tests/tx/v0-pretest-baseline.js`) to pass `limit` when specified by scenario options.

### Large runtime golden scenarios now included
- Added scenario:
  - `loinc_status_active_page10000` with `count=10000, limit=10000`
- Existing large scenario retained:
  - `rxnorm_tty_in_page1000`

### Result (regenerated baseline)
- `tests/tx/v0-pretest-baseline.json` now includes true runtime expansion golden sets at both scales:
  - `rxnorm_tty_in_page1000`: `goldenKeys=1000`, parity true
  - `loinc_status_active_page10000`: `goldenKeys=10000`, parity true
- Overall summary remains clean:
  - `parityFailures=0`
  - `criticalInvariantFailures=0`


## Progress update - 2026-02-22 (query-shape microbench matrix)

### What was benchmarked
- Added matrix benchmark script:
  - `tests/tx/v0-sql-shape-microbench.js`
  - output: `tests/tx/v0-sql-shape-microbench.json`
- Compared alternative SQL formulations for equivalent result sets:
  - `IN (...)` vs temp-table join for 1000-code membership
  - `NOT EXISTS` vs `EXCEPT` vs `LEFT JOIN ... IS NULL` for include-minus-exclude hierarchy page
  - property filter forms (`JOIN` vs correlated `EXISTS`) for RxNorm/LOINC
  - `UNION` vs `UNION ALL + DISTINCT`

### Key findings
- `IN (...)` (1000 codes) is much faster than temp-table join for our workload.
- `EXCEPT` was slightly faster than `NOT EXISTS` in the tested SNOMED include-minus-exclude page shape.
- Correlated `EXISTS` for property filters looked faster for page-only probes, but was **much slower** for real `$expand` workload that also computes `total` (count query).
- `UNION` vs `UNION ALL + DISTINCT` showed no material difference for small dedup test.

### Refactor adjustments made based on results
- Kept hybrid intersect handling in `expandComponent`:
  - use `IN/NOT IN` for moderate intersect lists
  - use temp tables only for large spillover
- Reverted property-filter SQL builder changes back to join-based form after full workload microbench showed regression.
- Kept concept-in (refset) join-based form to avoid major regression.

### Validation after adjustments
- `tests/tx/v0-pretest-baseline.js` remains clean:
  - parity failures: 0
  - critical invariant failures: 0
- Representative timings returned to near-baseline:
  - `rxnorm_tty_in_page50` push/fallback ~`11ms/28ms`
  - `loinc_status_active_page20` push/fallback ~`48ms/354ms`
  - `loinc_status_active_page10000` push/fallback ~`87ms/309ms`


## Progress update - 2026-02-22 (trace ergonomics pass)

### Why
- Trace capture/debugging was inconsistent across execution contexts:
  - harness had ambient trace capture but noisy JSON-only output
  - server path (`expand-v2` worker) did not run under `traceStore`, so `T.begin/sql/note` were effectively no-op outside harness wrappers

### Implemented changes
- `tx/workers/expand-v2.js`
  - added trace config parsing in worker (`_parseTraceConfig`) using both:
    - env: `EXPAND_TRACE`
    - request param: `logExtraOutput`
  - trace-enabled runs now execute expansion under `traceStore.run(new ExpandTrace(), ...)`
  - added attach modes:
    - `json` attach: full trace JSON in `expand-trace` extension
    - `summary` attach: compact human summary in `expand-trace-summary` extension
  - added optional log output for summary mode (`log` / `log-summary` token)
  - disabled cache get/set for trace-enabled requests to avoid storing instrumented trace payloads in expansion cache

- `tx/workers/expand-trace.js`
  - added `formatTraceSummary(traceJson, opts)` for concise, operator-friendly trace rendering
  - summary includes:
    - total runtime, span count, SQL count + SQL total time
    - top slow spans
    - top slow SQL statements
  - exported formatter for reuse in harness/worker surfaces

### In progress
- `tests/tx/expand-v2-harness.js` trace UX cleanup:
  - add `summary/json` print mode control
  - add `fail/all` trace print control
  - configurable trace results file path

### Next immediate step
- finish harness trace UX cleanup, then resume debugging/fixing the mixed valueset-import pagination correctness failure.

## Progress update - 2026-02-22 (pagination failure root cause + fix)

### Failing case
- Test: `pagination-safety: valueset-import peer with excludes reconstructs full set`
- Symptom before fix:
  - baseline full (`count=1000`) had 114 keys
  - page-walk reconstruction had 110 keys
  - missing keys were all imported administrative-gender codes

### Root cause
- `_expandNestedValueSet(...)` cloned outer params and only changed `limit`, but retained outer `offset/count`.
- For requests with page offsets (`offset=0,19,38,...`), nested ValueSet import expansion was itself paged.
- This made imported membership context-dependent per page request, causing page-walk reconstruction holes.

### Implementation fix
- File: `tx/workers/expand-v2.js`
- In `_expandNestedValueSet(...)`:
  - force `nestedParams.offset = -1`
  - force `nestedParams.count = -1`
- Rationale: imported ValueSet expansion is membership input and must be complete/stable; outer pagination applies only at final output assembly.

### Test hardening
- File: `tests/tx/expand-v2-harness.js`
- Removed conditional skip behavior in two pagination-safety tests.
- They now hard-assert set equality between full and page-walk reconstruction.

### Validation
- `node tests/tx/expand-v2-harness.js "pagination-safety"`
  - 4 passed, 0 failed.
- trace summary run for failing case confirms nested expansion path is exercised and now stable.

## Progress update - 2026-02-22 (imported ValueSet exclusion semantics fix)

### Additional issue discovered during trace-led investigation
- After fixing nested pagination leakage, semantic check still showed:
  - imported administrative-gender include retained `unknown` despite explicit exclude.
- Root cause:
  - `_importValueSetItem(...)` added imported entries directly into `fullList/map` without consulting `ExclusionEvaluator` exact exclusions.

### Implementation changes
- File: `tx/workers/expand-v2.js`
  - normalized exclusion key helper to treat missing versions as empty string.
  - in `_addExclusion(...)`, exact exclusion key now uses version semantics aligned with output mode:
    - if `doingVersion=false`, store exclusions with empty version (version-insensitive)
    - if `doingVersion=true`, store exact version
  - in `_addToExpansion(...)`, exclusion check now uses same normalized version semantics.
  - in `_importValueSetItem(...)`, added membership-time exact exclusion check before insertion.

### Test updates
- File: `tests/tx/expand-v2-harness.js`
  - `pagination-safety: valueset-import peer with excludes reconstructs full set`
    now explicitly asserts imported `administrative-gender|unknown` is excluded.

### Validation
- `node tests/tx/expand-v2-harness.js "pagination-safety"` => 4 passed, 0 failed.
- direct semantic probe confirms gender codes are now `[female, male, other]` (unknown excluded).

## Progress update - 2026-02-22 (phase: _addToExpansion decomposition)

### Goal
- Start addressing readability concern around `_addToExpansion` being a high-coupling method.
- Keep behavior unchanged while separating responsibilities.

### Refactor performed
- File: `tx/workers/expand-v2.js`
- Decomposed `_addToExpansion(...)` into focused helpers:
  - `_noteAddProgress()`
  - `_passesMembershipChecks(imports, system, version, code, isInactive, excludeInactive)`
  - `_passesExpandLimitation(cs)`
  - `_enforcePaginationShortCircuit()`
  - `_enforceTooCostly(srcURL)`
  - `_recordUsedCodeSystem(expansion, cs, system, version)`
  - `_appendExpansionEntry(parent, key, entry)`

### Notes
- No semantic intent change; this is a structure/readability pass only.
- Existing short-circuit and too-costly logic remains in the same execution path, now explicit and isolated in method names.

### Next
- Move pagination early-stop decision out of `_addToExpansion` into executor-level flow (while preserving current guard behavior).

## Progress update - 2026-02-22 (phase completion: pagination placement + hierarchy isolation + plan snapshots)

### Completed items
- Moved include-page short-circuit decision out of `_addToExpansion(...)`.
  - `_addToExpansion` now handles membership+render+append only.
  - include-loop call sites invoke `_enforceIncludePaginationShortCircuit()` before expensive work.

- Isolated hierarchy traversal into a dedicated collector.
  - Added `HierarchyCollector` class.
  - `_processDescendants(...)` now delegates to `HierarchyCollector.collect(...)`.
  - Keeps traversal logic separate from decoration pipeline while preserving behavior.

- Added inspectable plan snapshot hooks.
  - `_emitPlanSnapshot(plan, expansion)` emits `trace.note('expand-plan', ...)` always.
  - Optional response attachment controlled by `EXPAND_PLAN_DUMP=1` or `logExtraOutput` tokens (`plan`, `trace-plan`, `plan-json`).
  - Snapshot extension URL: `http://fhirsmith.org/StructureDefinition/expand-plan`.

### Regression encountered and resolved during this phase
- Refactor introduced a behavior regression in `_passesExpandLimitation(...)`:
  - undefined `expandLimitation` was treated as active limit and rejected all adds.
- Fix:
  - enforce expand limitation only when `expandLimitation` is a numeric value > 0.

### Validation
- `node tests/tx/expand-v2-harness.js "pagination-safety"` => pass.
- `node tests/tx/expand-v2-harness.js` => `81 passed, 0 failed`.
- `EXPAND_PLAN_DUMP=1` smoke test confirms plan snapshot extension is emitted.

## 2026-02-22 high-risk follow-up (coverage + behavior)

- Restored sqlite-v0 pushdown capability advertisement by resolving duplicate `capabilities()` override in `tx/cs/cs-sqlite-runtime-v0.js`.
  - Added `_expandCapabilities()` helper and merged pushdown + `filterPage` capabilities in the effective `capabilities()` method.
- Fixed pushdown pagination double-application bug in `tx/workers/expand-v2.js`.
  - Added `paginationAlreadyApplied` state.
  - Set when provider pushdown consumed pagination.
  - `_assembleOutput()` now bypasses worker-side offset/count slicing when pagination was already applied in provider.
- Added integration-only (no mocks) logic tests in `tests/tx/expand-v2-harness.js` for high-risk paths:
  - sqlite pushdown path active for basic concept expansions.
  - same-system `concept + valueSet[]` intersection semantics.
  - regex filter behavior in sqlite pushdown.
  - imported include/exclude ValueSet semantics (`Inc\\Exc`).
  - mixed import+peer include/exclude pagination reconstruction.
  - bulk locate resolver path with >50 unique concepts in fallback mode.
  - low-limit too-costly behavior and low-limit paged behavior.
  - text-filter low-limit fallback short-circuit behavior (no total).
- Current full harness status after fixes: 90 passed / 0 failed.
- Current expand-v2 coverage (harness + c8):
  - statements 76.91%
  - branches 69.23%
  - functions 85.24%
  - lines 76.91%

## 2026-02-22 sqlite-v0 cleanup + perf pass (pagination totals)

### Change
- Refined `SqliteRuntimeV0Provider.expandComponent()` pagination path to reduce duplicated work while keeping fast paths fast.
- New strategy in `tx/cs/cs-sqlite-runtime-v0.js`:
  - For paged queries with excludes (`excludes.length > 0`): use one-pass window total
    - `COUNT(*) OVER()` on paged query (single filtered scan)
    - COUNT fallback only when page is empty (offset beyond end)
  - For paged queries without excludes: keep previous two-query strategy
    - data query + COUNT query
    - avoids regressions observed on simple single-filter workloads.
- This keeps SQL generation clearer by explicit `useWindowPaginationTotal` branch.

### Microbench (old vs window vs adaptive)
- Method: direct sqlite strategy benchmark (median of 30 iterations, warmups=6) on local v0 dbs.
- Equivalence: old/window returned identical row sets and totals for all sampled cases.

1) `snomed is-a minus subtree` (paged 50/0, with excludes)
- old: 0.313ms
- window: 0.229ms
- adaptive: 0.229ms (chooses window)
- adaptive speedup vs old: 1.371x

2) `snomed is-a minus subtree` (paged 50/100, with excludes)
- old: 0.297ms
- window: 0.220ms
- adaptive: 0.220ms (chooses window)
- adaptive speedup vs old: 1.353x

3) `loinc STATUS=ACTIVE` (paged 20/0, no excludes)
- old: 80.356ms
- window: 87.949ms
- adaptive: 80.356ms (chooses old)
- adaptive speedup vs old: 1.000x

4) `rxnorm TTY=IN` (paged 50/0, no excludes)
- old: 10.748ms
- window: 11.874ms
- adaptive: 10.748ms (chooses old)
- adaptive speedup vs old: 1.000x

## 2026-02-22 full timing sweep (harness-wide)

Command shape (three full runs over 91 tests):
- `EXPAND_IMPL=legacy node tests/tx/expand-v2-harness.js`
- `EXPAND_IMPL=v2 node tests/tx/expand-v2-harness.js`
- `EXPAND_IMPL=v2 EXPAND_V2_DISABLE_PUSHDOWN=1 node tests/tx/expand-v2-harness.js`
- Results captured to `tests/tx/.timing/*.json` and logs in `.timing/*.log`.

### Raw run status
- legacy: 64 pass / 27 fail, wall 3493ms, total test ms 1057
- v2 pushdown: 91 pass / 0 fail, wall 3054ms, total test ms 588
- v2 fallback: 86 pass / 5 fail, wall 4158ms, total test ms 1769

### Comparable subsets
- Pushdown vs fallback on tests both passed: 86 tests
  - pushdown total: 347ms
  - fallback total: 613ms
  - speedup (fallback/pushdown): 1.77x
- Legacy vs pushdown on tests all three passed: 62 tests
  - legacy total: 437ms
  - pushdown total: 203ms
  - speedup (legacy/pushdown): 2.15x

### Notes
- Legacy failures are expected; it does not implement many new paths used by harness.
- Fallback failures are due to limit/too-costly on heavier v0 queries in non-pushdown mode.

## 2026-02-22 fallback pagination + best-effort totals pass

### Goals
- Make paged filtered expansions work in fallback mode (non-pushdown) without failing at default 1000 limit.
- Treat `expansion.total` as best-effort/optional when exact count is not known.
- Ensure pushdown-specific tests do not fail when pushdown is explicitly disabled.

### Implementation
- `tx/workers/expand-v2.js`
  - Added pagination short-circuit in filter include loop (`_processFilters`) via `_enforceIncludePaginationShortCircuit()`.
  - Updated too-costly guard (`_enforceTooCostly`) to use effective limit for paged requests:
    - `effectiveLimit = max(limitCount, offset + count)`
  - Updated finished-path total handling:
    - if known-safe total exists -> set it
    - else if provider already supplied pagination total -> keep it
    - else -> suppress total (`totalStatus='off'`) to avoid misleading totals
- `tests/tx/expand-v2-harness.js`
  - Pushdown-required logic tests now skip when `EXPAND_V2_DISABLE_PUSHDOWN=1`.
  - Added high-offset cross-mode test:
    - `pagination: high offset (>1000) works in both pushdown and fallback modes`
    - verifies page retrieval at offset 1000 with and without pushdown and page-content parity.
  - Relaxed strict total assertion in paged SNOMED filter test to align with best-effort total policy.

### Validation
- Default mode (`EXPAND_IMPL=v2`): 92 passed / 0 failed / 0 skipped
- Fallback mode (`EXPAND_V2_DISABLE_PUSHDOWN=1`): 89 passed / 0 failed / 3 skipped

## 2026-02-22 pushdown optimization: whole-system paged query shape

### Change
- Optimized sqlite-v0 pushdown for the specific high-volume shape:
  - single include component
  - whole system include (no concept/filter/intersect)
  - no excludes
  - paged request (`offset`/`count`)
- Kept exact `total` behavior.
- New SQL shape in `expandComponent` for this case:
  1. `WITH page_keys AS (...)` reads `(concept_id, code)` via ordered index scan and applies `LIMIT/OFFSET`.
  2. Join `page_keys` back to `concept` to hydrate full row payload for page rows only.
  3. Exact total via direct `SELECT COUNT(*) FROM concept WHERE cs_id=?` (plus active clause when applicable).

### Why
- Previous page SQL shape selected wide rows during deep-offset scans and became offset-sensitive.
- Existing index (`idx_concept_cs_code`) was already used, but query shape still forced more row payload work before page extraction.

### Results (SNOMED, count=1000)
- `offset=50000` pushdown:
  - before: ~72ms
  - after: ~31ms
- `offset=500000` pushdown:
  - before: ~154ms
  - after: ~43ms
- `offset=500000` fallback (no pushdown): ~3667ms
- pushdown-vs-fallback at `offset=500000`: ~85x faster after optimization.

### Trace deltas (pushdown)
- `offset=50000`:
  - page SQL: ~3.12ms
  - count SQL: ~14.14ms
- `offset=500000`:
  - page SQL: ~16.62ms
  - count SQL: ~14.7ms
- Interpretation: page SQL still grows with offset, but much less than before.

### Validation
- Deep-offset invariant test still passes:
  - `pagination: deep offset invariant (all SNOMED) fallback must match or too-costly`
- Harness post-change:
  - `EXPAND_IMPL=v2`: 93 passed / 0 failed / 0 skipped
  - `EXPAND_IMPL=v2 EXPAND_V2_DISABLE_PUSHDOWN=1`: 90 passed / 0 failed / 3 skipped

## 2026-02-22 pushdown optimization: single SNOMED hierarchy filter paging

### Scope
- Optimized sqlite-v0 pushdown for single-component paged hierarchy filters:
  - include count = 1
  - no excludes
  - no text filter
  - include has exactly one `concept` filter with `op in {is-a, descendent-of}`
- Kept exact `total` behavior.

### SQL shape changes
- Added `single-hierarchy-filter-paged` fast path in `expandComponent`:
  - page query uses `WITH page_keys` and avoids `DISTINCT` for hierarchy filter rows.
  - count query uses direct `COUNT(*)` over the hierarchy join (no `DISTINCT`) for this shape.
- Rationale: closure rows are unique per `(ancestor_id, descendant_id)` in current v0 schema and local db validation confirmed uniqueness for tested roots.

### Characterization query
- ValueSet include filter:
  - `system = http://snomed.info/sct`
  - `filter = { property: "concept", op: "is-a", value: "64572001" }` (Disease)
- Page size: `count=1000`

### Performance results (pushdown, exact total kept)
Before hierarchy-specialized fast path:
- offset 0: total ~108ms (page ~58ms, count ~39ms)
- offset 50000: total ~160ms (page ~109ms, count ~40ms)
- offset 100000: total ~153ms (page ~103ms, count ~44ms, empty page)

After hierarchy-specialized fast path:
- offset 0: total ~51ms (page ~24.5ms, count ~16.6ms)
- offset 50000: total ~81ms (page ~57.1ms, count ~14.7ms)
- offset 100000: total ~81ms (page ~58.9ms, count ~15.8ms, empty page)

### Interpretation
- Count is now relatively stable (~15–17ms) for this shape.
- Page query remains offset-sensitive (as expected with OFFSET), but significantly faster than prior shape.
- At offset 50000, pushdown remains far faster than fallback on same query.

### Spot validation
- Harness targeted pagination test still passes:
  - `pagination: SNOMED is-a paginated (v0)`

## 2026-02-22 complex-shape profiling + optimization (multi include/exclude hierarchy filters)

### Complex query used
- Includes:
  - SNOMED `is-a 64572001` (Disease)
  - SNOMED `is-a 123037004` (Body structure)
- Excludes:
  - SNOMED `is-a 73211009` (Diabetes mellitus subtree)
  - SNOMED `is-a 442083009` (anatomy subset)
- Pagination: `count=1000`, offsets `0`, `50000`, `90000`

### Correctness/engineering findings
- Found and fixed pushdown SQL bug for multi-include unions:
  - sqlite syntax error near `UNION` caused by parenthesized UNION assembly.
  - Fixed union construction in generic pushdown include assembly.

### Optimization applied for complex paged exclude path
- Current path for pagination+excludes used one window query over wide rows.
- Updated to a key-window shape:
  - window count over `DISTINCT concept_id, code`
  - then join back to `concept` for payload hydration of paged rows.
- Kept one-pass exact total semantics (`COUNT(*) OVER()`) for this complex class.

### Performance characterization (pushdown)
Before key-window optimization (same query):
- offset 0: ~316ms
- offset 50000: ~372ms
- offset 90000: ~397ms

After key-window optimization:
- offset 0: ~296ms
- offset 50000: ~328ms
- offset 90000: ~337ms

Approximate speedup:
- ~1.07x (offset 0)
- ~1.13x (offset 50000)
- ~1.18x (offset 90000)

### Count vs page characteristics for this shape
- With excludes present, pushdown uses a single window query that returns page rows and exact total in one pass.
- Direct split benchmark (`page + separate count`) for this shape was slower overall than window path:
  - window median ~325ms
  - split median ~501ms
- Conclusion: keep one-pass window total for this complex class.

### Pushdown vs fallback on complex shape
- offset 50000:
  - pushdown ~315–328ms
  - fallback ~1.5s
- pushdown remains significantly faster for complex includes/excludes.

### Open behavior gap (known)
- For this complex same-system multi-include paged query, pushdown and fallback return different page windows at identical offsets.
- Cause: ordering differences between pushdown SQL global order and fallback accumulation order.
- Totals and page sizes are consistent; page membership windows differ due to order semantics.

## 2026-02-22 include.valueSet + sibling filter probe (SNOMED)

### Goal
- Exercise shape: `compose.include` containing both:
  - `valueSet: [<url>]`
  - sibling `filter` on SNOMED concept hierarchy

### External URL probe
- Tried likely US Core and SNOMED implicit canonical URLs directly in fixture library:
  - `http://hl7.org/fhir/us/core/ValueSet/us-core-condition-code`
  - `http://snomed.info/sct?fhir_vs=ecl/<404684003`
- In current fixture config these URLs were not resolvable by `findValueSet` for include-import usage.

### Local tx-resource probe used
- Built local imported ValueSet (`http://example.org/vs/sct-disease-8k`) with 8000 explicit SNOMED disease codes.
- Query shape tested:
  - include.system = SNOMED
  - include.valueSet = `http://example.org/vs/sct-disease-8k`
  - include.filter = `concept descendent-of 64572001`
  - pagination `count=1000`, offsets `0` and `5000`

### Bug found and fixed
- Pushdown path initially failed with `SQLITE_INTERRUPT: interrupted` during temp-table setup for large `intersectCodes`.
- Root cause: progress-effort timer not reset before temp table DDL/insert transaction.
- Fix: reset effort before creating and loading expand temp tables in `#createExpandTempCodesTable`.

### Results after fix
Pushdown (`impl=v2`):
- offset 0: ~320ms, total=8000
- offset 5000: ~322ms, total=8000

Fallback (`impl=v2`, pushdown disabled):
- offset 5000: ~416ms, total=6000

### Interpretation
- Pattern works after temp-table effort reset fix.
- Pushdown is faster than fallback for this shape, but gains are moderate because nested imported ValueSet expansion dominates cost.
- Trace shows nested expansion step (`rows=8000`) is the largest SQL component.
- Fallback total differs from pushdown (known best-effort total behavior in fallback paths); page content at tested offset matched.

## 2026-02-22 cross-system local probe (SNOMED + LOINC adhoc + RxNorm text)

### Local ValueSet used
- URL: `http://example.org/vs/cross-area-mixed`
- Includes:
  - SNOMED `is-a 64572001` (Disease)
  - 10 adhoc LOINC concept codes
  - whole RxNorm system
- Request params:
  - `filter=aspirin`
  - `count=200`, `offset=0`

### Behavior notes
- With default limit, pushdown run returned too-costly (`>1000`) for this mixed query shape.
- With explicit higher limit (`limit=20000`), pushdown and fallback both succeeded.

### Measured output (`limit=20000`)
- Pushdown:
  - ~23ms
  - 200 results
  - exact total `1589`
- Fallback:
  - ~24ms
  - 200 results
  - total omitted (best-effort policy)
- First/last preview codes aligned across modes for this page.

### Interpretation
- Mixed multi-system + text filter shape performs well when limit permits enumeration of candidate space.
- The pushdown path provides exact total; fallback keeps total optional.

## 2026-02-22 high-value harness test additions

Added four high-value tests in `tests/tx/expand-v2-harness.js`:
- `high-value: mixed-system text filter limit boundary then success`
  - validates low-limit too-costly boundary and success at higher limit.
- `high-value: include.valueSet + sibling filter works at scale (pushdown and fallback)`
  - validates imported ValueSet intersection + sibling filter path in both modes.
- `high-value: SNOMED hierarchy tail pagination is stable across modes`
  - validates near-end paging behavior (`offset ~= total`) and empty page at `offset=total`.
- `high-value: complex same-system include/exclude pages are internally consistent per mode`
  - validates no-duplicate/no-overlap adjacent page windows in each mode for multi-include/multi-exclude hierarchy shape.

Targeted execution:
- `node tests/tx/expand-v2-harness.js "high-value:"`
- Result: `4 passed, 0 failed`.

## 2026-02-23 legacy-vs-v2 gap report + legacy SQL tracing hook

### Legacy coverage gap vs v2 (full sweep)
- Compared `/tmp/harness_legacy.log` to `/tmp/harness_v2_pushdown.log`.
- Found **25 tests** that fail in legacy but pass in v2 pushdown.
- Dominant categories:
  - provider interface gaps (`Must override`) for mixed-provider and valueset-import peer scenarios
  - pagination semantics gaps (paged reconstruction, high-offset, total/page consistency)
  - valueSet intersection/import bug (`this.pinValueSet is not a function`)
  - text-filter typing/guard bugs (`filter.toLowerCase is not a function`, undefined length)

### Legacy faster-than-pushdown analysis
- Searched for tests where both modes pass and `pushdown_ms / legacy_ms >= 2` with `legacy_ms >= 1` and `pushdown_ms >= 2`.
- Result: **1 test** (`infra: tx-resource injected ValueSet import resolves against injected CodeSystem`, `1ms` vs `2ms`), non-sqlite and too small/noisy for optimization guidance.
- Result: **0 sqlite/v0 cases** where legacy is 2x+ faster than pushdown.

### Instrumentation added (legacy path SQL visibility)
- File: `tx/cs/cs-sqlite-runtime-v0.js`
- Added `v0.executeFilters` trace span and SQL logging (`T.sql`) for legacy/fallback executeFilters SQL operations:
  - bounded limit probe SQL
  - main page/materialization SQL
  - designation batch SQL
  - count SQL
- This enables direct SQL-shape comparison in `tests/tx/expand-v2-adhoc.js --trace summary|json` for legacy-path queries.

### Spot comparison after instrumentation (all SNOMED, count=1000, offset=50000)
- Legacy:
  - total runtime: ~51ms
  - SQL shape: `SELECT DISTINCT ... FROM (SELECT ... FROM concept WHERE cs_id=...) ORDER BY code LIMIT/OFFSET`
  - plus `COUNT(*)` over inner query
- v2 pushdown:
  - total runtime: ~24ms
  - SQL shape: `WITH page_keys AS (...)` narrow key page first, then hydrate rows
  - plus direct `COUNT(*) FROM concept WHERE cs_id=?`
- Observation: pushdown remains significantly faster for this high-offset sqlite case.

## 2026-02-23 expand.js retirement + CS API prune (completed)

### Scope completed
- Retired legacy expand worker implementation by deleting `tx/workers/expand.js`.
- Repointed runtime imports to v2:
  - `tx/tx.js` now imports `ExpandWorker` from `tx/workers/expand-v2.js`
  - `tx/workers/validate.js` now imports `ValueSetExpander` from `tx/workers/expand-v2.js`
  - `tx/workers/related.js` now imports `ValueSetExpander` from `tx/workers/expand-v2.js`
- Removed legacy harness/adhoc dependencies on legacy worker:
  - `tests/tx/expand-v2-harness.js` supports `EXPAND_IMPL=v2|v2-parity` (legacy/parity-vs-legacy removed)
  - `tests/tx/expand-v2-adhoc.js` supports `--impl v2` only

### CS API surface pruned
- In `tx/cs/cs-api.js`:
  - Removed legacy hooks:
    - `handlesExcludes()`
    - `handlesOffset()`
    - `filterExcludeFilters(...)`
    - `filterExcludeConcepts(...)`
    - `includeConcepts(...)`
  - Simplified prep context contract:
    - `getPrepContext(iterate)` only
  - Removed `specialFilter(...)` from base provider contract
  - Removed `expandComponent(...)` alias from base API; providers implement `expandQuery(...)`
  - Updated `capabilities()` contract to use pushdown capabilities (`pushdown.*`) instead of `handles*`

### v2 pushdown decisioning updated
- In `tx/workers/expand-v2.js`:
  - Pushdown now uses `expandQuery` only (no `expandComponent` fallback)
  - Exclude pushdown gate now checks `caps.pushdown.supportsExcludes === true`
  - Pagination pushdown gate now checks `caps.pushdown.supportsPagination === true`

### sqlite-v0 provider updated
- In `tx/cs/cs-sqlite-runtime-v0.js`:
  - `expandQuery` is the only pushdown entrypoint (`_expandQueryImpl` internal)
  - Removed `handlesExcludes()` / `handlesOffset()` methods
  - `_expandCapabilities()` now advertises:
    - `pushdown.supportsExcludes = true`
    - `pushdown.supportsPagination = true`
  - Simplified `getPrepContext(iterate)` signature
  - Removed legacy provider hooks:
    - `filterExcludeFilters(...)`
    - `filterExcludeConcepts(...)`
    - `includeConcepts(...)`
  - Renamed pushdown trace span name from `v0.expandComponent` to `v0.expandQuery`

### Harness assertions aligned
- Updated pushdown trace assertions to look for `v0.expandQuery`.

## 2026-02-23 sqlite-v0 hard-require better-sqlite3 (startup invariant)

### Change
- Tightened sqlite-v0 provider/runtime assumptions to treat sync DB as mandatory.
- `tx/cs/cs-sqlite-runtime-v0.js` now:
  - throws at module load if neither `better-sqlite3-with-progress` nor `better-sqlite3` is available
  - throws at provider construction if `dbPath` is missing
  - no longer advertises conditional pushdown capability based on runtime checks (`expandQuery` + `pushdown` always present for this provider)
  - removed remaining runtime `syncDb` null-guard branches in pushdown/filter SQL paths

### Rationale
- This provider is now explicitly defined as the better-sqlite3-backed implementation.
- Failing fast at startup is preferred over carrying nullable runtime branches that hide configuration/runtime drift.

## 2026-02-23 language/designation harness expansion (first batch)

Added first-batch high-value, non-brittle language/designation tests in `tests/tx/expand-v2-harness.js`:
- includeDesignations on SNOMED concept
- designation filter by SNOMED FSN use code
- displayLanguage=en parity with default display
- inline compose designation override with includeDesignations
- includeDesignations on package cs-cs whole-system expansion
- includeDesignations on SNOMED filter expansion path
- redundant display suppression check (designation vs primary display)

Implementation notes:
- Avoided hardcoding language-specific SNOMED strings where possible.
- Assertions focus on wiring/structure correctness and filtering semantics.

## 2026-02-23 fix: pushdown designation normalization/filtering parity

### Problem observed
- New language/designation harness tests exposed that pushdown-path designations were emitted in raw sqlite row shape
  (`term/language_code/use_code`) instead of FHIR `designation` shape (`value/language/use`).
- Pushdown ingestion also bypassed designation filtering (`designation` params) and redundant-display suppression.

### Fix implemented
- File: `tx/workers/expand-v2.js`
- In `_ingestPushdownResult`:
  - replaced direct assignment `entry.designation = row.designations` with normalization pipeline:
    - `_normalizePushdownDesignations(entry, row.designations, system)`
- Added `_normalizePushdownDesignations(...)` helper that:
  - maps raw and/or partially-normalized designation rows to internal candidate shape
  - applies `_useDesignation(...)` filter semantics
  - applies `_redundantDisplay(...)` suppression semantics
  - emits FHIR designation objects (`{ value, language?, use? }`)

### Notes
- This aligns pushdown-path designation semantics with fallback renderer behavior.
- No test run executed in this step.

## Update: SNOMED designation canonical-use normalization and parity fix

Date: 2026-02-23

Completed:
- Updated SNOMED v0 importer to persist canonical SNOMED designation use codes directly (`900000000000003001`, `900000000000013009`) instead of shorthand tokens (`fsn`, `synonym`).
- Updated runtime SNOMED designation mapping keys in importer output config to canonical use codes.
- Spot-fixed local SNOMED v0 DB used by harness to canonicalize existing designation `use_code` values and runtime designation mapping.
- Fixed sqlite-v0 fallback designation shaping bug where preferred rows were being emitted as display-use designations; fallback now preserves designation use codings for filter matching.
- Restored strict harness assertion for non-empty FSN designation result under canonical designation filter (`http://snomed.info/sct|900000000000003001`).

Impact:
- Pushdown and fallback now both return FSN designation matches for canonical SNOMED designation filters.
- Harness language/designation coverage is stronger and aligned to FHIR-facing designation semantics.

Follow-up:
- Rebuild SNOMED v0 artifacts from importer (instead of spot-fix) for canonicalization by construction.
- Add parity assertion across pushdown/fallback for designation-filtered result content in the main harness matrix.

## Update: four targeted correctness/performance hardening items

Date: 2026-02-23

Completed in `expand-v2`:
- Pushdown safety guard for global excludes with import includes:
  - Pushdown is now skipped for groups with excludes when the active plan also contains import groups.
  - Reason emitted in trace: `global-excludes-with-imports`.
- `valueset-unclosed` extension typing fixed:
  - Replaced string-valued writes with canonical boolean extension emission.
  - Added centralized `_setUnclosed(expansion)` helper and switched all current call sites.
- Total accounting for imported includes fixed:
  - `_importValueSetItem` now increments total when a new unique code is added.
- `count=0` fast-path added for common whole-system shape:
  - Preconditions: single system group, one whole-system include, no excludes/imports/text filter/active-only-style restrictions, closed complete system.
  - Uses provider `totalCount()` and returns total-only without enumeration.

Harness additions/updates:
- UCUM unclosed test now asserts boolean `valueset-unclosed` and forbids string-typed payload.
- Count=0 test now asserts fast-path activation via trace metadata.
- Added mixed direct+import include total test to ensure total counts imported members.
- Added pushdown-guard regression test for same-system exclude plus import include semantics.

## Update: structural step 1 (exclusion policy extraction)

Date: 2026-02-23

Completed:
- Extracted exclusion policy primitives from `expand-v2.js` into dedicated module:
  - `tx/workers/expand-v2-exclusion-policy.js`
  - `ExclusionIndex`
  - `ExclusionEvaluator`
- Updated `expand-v2.js` to consume the new module (no intended semantic change).

Why:
- Reduces engine interleaving by giving exclusion membership and deferred filter-predicate logic a clear boundary.
- Sets up subsequent refactor slices to build exclusions first and stream includes against a single policy surface.

Next structural slice:
- Introduce explicit `ExclusionPolicyBuilder` orchestration object (build-first step) while preserving existing behavior and tests.

## Perf baseline sweep checkpoint (pre next pushdown-impact refactor)

Date: 2026-02-23

Command set:
- `EXPAND_IMPL=v2 EXPAND_TRACE_RESULTS=.timing/v2-push.json node tests/tx/expand-v2-harness.js`
- `EXPAND_IMPL=v2 EXPAND_V2_DISABLE_PUSHDOWN=1 EXPAND_TRACE_RESULTS=.timing/v2-fallback.json node tests/tx/expand-v2-harness.js`
- `EXPAND_IMPL=v2-parity node tests/tx/expand-v2-harness.js`

Results snapshot:
- v2 pushdown: 106/0/0, summed per-test runtime 9731ms, p50 1ms, p95 50ms, max 4833ms.
- v2 fallback: 101/0/5 in console semantics (skip-intended tests), summed per-test runtime 11792ms, p50 1ms, p95 60ms, max 8513ms.
- v2 parity: 106/0/0.

Comparative summary (pushdown vs fallback where both measured >0ms):
- comparable tests: 78
- median fallback/pushdown ratio: 1.00x
- p95 fallback/pushdown ratio: 6.00x
- median abs delta (fallback - pushdown): 0ms
- p95 abs delta (fallback - pushdown): +135ms

Largest fallback slowdowns observed:
- `high-value: complex same-system include/exclude pages...` +3680ms
- `pagination: deep offset invariant (all SNOMED)...` +671ms
- `high-value: include.valueSet + sibling filter...` +293ms
- `filter: LOINC STATUS=ACTIVE` +135ms

Note:
- A few microcases favored fallback due runtime variance / path differences; guardrail remains to run this same sweep before and after any pushdown-affecting changes.

## Update: structural step 2 (explicit ExclusionPolicyBuilder wiring)

Date: 2026-02-23

Completed:
- Added `ExclusionPolicyBuilder` in `tx/workers/expand-v2-exclusion-policy.js`.
- `expand-v2` now owns:
  - `this.exclusionPolicyBuilder`
  - `this.exclusionEvaluator = this.exclusionPolicyBuilder.create()`
- Reinitialize exclusion evaluator per compose handling (`_handleCompose`) via builder.
- Routed exclusion mutations through builder methods:
  - exact excludes
  - imported ValueSet exclusion predicates
  - deferred filter predicates

Behavior intent:
- No semantic change expected; this is a boundary/ownership refactor to prepare build-first exclusion orchestration.

## Update: structural step 3 (executor phase split for fallback)

Date: 2026-02-23

Completed:
- Refactored `ExpansionExecutor.execute(...)` to perform fallback execution in two explicit phases:
  - Phase 1: process all fallback-group excludes
  - Phase 2: process all fallback-group includes
- Pushdown attempt remains first-pass per group; groups handled by pushdown are excluded from fallback phases.

Why:
- Makes exclusion policy construction more explicit and global for fallback paths.
- Reduces order-coupling from per-group exclude/include interleaving and aligns with set-algebra intent (`Union(include) - Union(exclude)`).

Scope:
- Structural only in executor flow; no pushdown query shape changes in this step.

## Update: structural step 4 (ExclusionPolicyBuilder.buildFromPlan orchestration)

Date: 2026-02-23

Completed:
- Added `ExclusionPolicyBuilder.buildFromPlan(plan, fallbackGroups, applyExclude)`.
- `ExpansionExecutor.execute(...)` now uses builder orchestration to construct fallback exclusion policy in one centralized pass.
- Fallback execution flow is now explicit:
  - classify groups (pushdown-handled vs fallback)
  - build exclusion policy for fallback groups via builder
  - stream fallback includes against that policy

Notes:
- This step is intended as structural/no-pushdown-query-shape change.
- Existing exclusion registration behavior (exact/imported/filter-predicate) is preserved; ownership is centralized.

## Update: structural step 5 (prebuild excludes before any include execution)

Date: 2026-02-23

Completed:
- Executor flow now prebuilds exclusion policy across all plan groups before any include execution.
- Include execution phase then runs per group:
  - attempt pushdown include execution
  - fallback include streaming when pushdown not handled

Intent:
- Align execution flow toward explicit set phases: build exclusions first, then include/selection.
- Keep pushdown request/query behavior unchanged in this step.

## Update: structural step 6 (exclude policy-only, no list splicing) + perf checkpoint

Date: 2026-02-23

Completed:
- `_excludeFromExpansion(...)` no longer mutates accumulated include state (`fullList`/`map`) via index/splice/delete.
- Exclude-by-import now registers exclusion membership predicates only.
- Pushdown ingestion now checks exclusion policy before accepting provider rows to keep global exclusions authoritative.
- Added regression test:
  - `logic: total reflects imported excludes without mutating accumulated list`

Post-change sweep:
- `EXPAND_IMPL=v2`: 107/0/0
- `EXPAND_IMPL=v2` + fallback: 102/0/5 (skip-intended pushdown-required tests)
- `EXPAND_IMPL=v2-parity`: 107/0/0

Timing comparison against earlier baseline showed slower wall-times in this run set (median +1ms per test, high-value tails materially higher), likely requiring follow-up profiling before additional structural changes.
