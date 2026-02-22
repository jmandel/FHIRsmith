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

