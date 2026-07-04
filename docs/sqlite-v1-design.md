# sqlite-v1: shared SQLite terminology storage

## Goal

One normalized SQLite schema and one generic `CodeSystemProvider` that serve
LOINC, RxNorm, and SNOMED CT (and future tabular terminologies), replacing
three bespoke storage formats and query engines. Per-terminology behavior is
**data** (`cs_config` rows and `property_def` metadata written by importers),
not provider code. The provider implements the existing contract in
`tx/cs/cs-api.js` unchanged; adoption is per-system via library config, so an
operator can run old and new providers side by side and compare.

This is a re-extraction of the `ir-sqlite-v0` branch essence, restaged to land
behind the stable provider contract instead of alongside the workers (which is
where all recent upstream churn lives).

## Schema (`tx/importers/schema-v1.sql`, `PRAGMA user_version = 2`)

Star schema around `concept`:

| Table | Purpose |
|---|---|
| `code_system`, `cs_config` | identity + release metadata; behavior key/value registry |
| `concept` | code, active, display, definition |
| `designation` | terms per language/use (use is a full coding: `use_system` + `use_code`) |
| `property_def` | property registry: `uri`, `fhir_type`, `value_kind` (concept/literal), `is_hierarchy` |
| `concept_link` | concept-valued properties incl. hierarchy edges; `edge_set_id` for alternative edge sets (SCT inferred vs stated), `group_id` for SCT relationship groups |
| `concept_literal` | literal properties: `value_raw` lexical + typed projections |
| `closure` | transitive closure of active hierarchy edges, **no self-rows** |
| `search_fts_*` | contentless trigram FTS5 over display/designations/literals |
| `value_set`, `value_set_member` | intrinsic enumerations (SCT refsets, LOINC answer lists) |
| `load_audit` | import provenance and stats |

Changes vs the v0 draft schema: `property_def.uri` + `fhir_type` (replaces
`source_type`) so `$lookup`/`$expand` property typing and `propertyDefinitions()`
derive from metadata; `designation.use_system` (v0 lost the use system);
`code_system.title/description/content_mode`; `idx_closure_descendant` for
ancestor queries (`generalizes`, `subsumesTest` both directions).

## Semantics decisions (normative for importers and provider)

1. **Identity.** `concept_id` is the internal identity; `(cs_id, code)` is
   unique. One code system version per DB file is the operational convention.
2. **Case.** `cs_config caseSensitive` decides which index lookups use.
   Importers for case-insensitive systems must verify uniqueness under case
   folding and fail the import otherwise.
3. **Hierarchy.** `is-a(X)` = X ∪ descendants(X); `descendent-of(X)` =
   descendants(X). The closure table stores no self-rows; the query layer adds
   the seed for `is-a`. (Note: current `cs-loinc.js` serves both filters
   identically from its Closure table — a known divergence we do not copy.)
   Multi-parent is normal; `parent`/`child` lookup properties come from
   `concept_link` rows whose `property_def.is_hierarchy = 1`, closure is
   derived from those at import time over `edge_set_id` = `hierarchyEdgeSet`.
4. **Status.** Importers normalize source status into `concept.active`
   (RxNorm `SUPPRESS`, LOINC `StatusCodes`, SCT `active`) **and** preserve the
   source vocabulary as a literal property named by `cs_config statusProperty`.
   `isInactive()` reads `active`; `getStatus()` reads the status property.
5. **Versioning.** `code_system.version` is the FHIR-served version string;
   `release_date` (YYYY-MM-DD) supports lockedDate resolution;
   `cs_config versionAlgorithm` ∈ `semver|date|integer|natural`.
6. **Designations.** `preferred` is per-language. The display for the code
   system's `defaultLanguage` is denormalized into `concept.display`.
7. **Out of scope.** Grammar systems (UCUM), SCT post-coordination and full
   ECL. The binary SNOMED provider remains the engine of record for ECL; the
   sqlite SNOMED build covers enumeration, is-a/descendent-of, refset
   membership (`in`), module/property filters.

## `cs_config` key registry

| key | value | consumed by |
|---|---|---|
| `caseSensitive` | `0`/`1` | `isCaseSensitive()`, locate strategy |
| `defaultLanguage` | BCP-47 | `defLang()`, display selection |
| `versionAlgorithm` | `semver\|date\|integer\|natural` | `versionAlgorithm()` |
| `hierarchyMeaning` | `is-a\|part-of\|...` | CodeSystem rendering |
| `hierarchyEdgeSet` | integer, default `1` | closure builder, is-a filters |
| `statusProperty` | property_code | `getStatus()` |
| `inactiveProperty` | property_code (optional) | `inactive` property emission |
| `filterAliases` | JSON `{alias: property_code}` (e.g. LOINC VSAC `code` → hierarchy) | filter resolution |
| `implicitValueSets` | JSON array of `{pattern, kind}` where kind ∈ `all\|isa\|vs-table` (e.g. SCT `?fhir_vs=isa/{code}`, `?fhir_vs=refset/{id}`, LOINC `/vs/{code}` answer lists) | `buildKnownValueSet()` |
| `searchSources` | JSON, which FTS surfaces text `filter` uses | `searchFilter()` |
| `webSource` | URL template | factory `webSource()`/`codeLink()` |
| `lookupLinkDescriptions` | `0`/`1` (SCT `1`) | `extendLookup()`: link properties carry `description` (target's first-active-designation display) and non-hierarchy ones `code-display` |
| `lookupLinkDistinct` | `0`/`1` (SCT `1`) | `extendLookup()`: non-hierarchy links emit DISTINCT (attribute, target) pairs over ALL rows incl. inactive (reference SNOMED); default = active rows with duplicates (reference LOINC) |
| `lookupPropertyOverrides` | JSON `{code: false \| {as, descriptionFromConcept}}` (SCT `moduleId`→`module`+display, `definitionStatusId` hidden) | `extendLookup()` literal emission |
| `displayDesignation` | `0`/`1` default `1` (SCT `0`) | `designations()`: whether to synthesize a display-use designation beside the stored ones |
| `designationUseDisplays` | `0`/`1` (SCT `1`) | `designations()`: decorate same-system use codings with the use concept's display |
| `expressionLanguage` | BCP-47 (SCT `en-US`) | `designations()`: language tag on a post-coordinated expression's rendered designation |

`$lookup` always surfaces hierarchy edges as the standard concept-properties
`parent` (outbound) / `child` (inbound, derived only when the DB defines no
explicit `child` property — LOINC stores child edges itself); the raw hierarchy
property code (SCT `116680003`) never appears in `$lookup` output.

Keys are optional with safe defaults; unknown keys are ignored (forward
compatibility). Importers own writing them; the provider only reads.

## Correctness strategy

Three independent layers — each catches what the others can't:

1. **Contract fixture tests.** A tiny synthetic terminology (built through the
   import core, in-memory) exercising every provider method: locate (case
   sensitivity both ways), display/designations/languages, properties typed
   per `fhir_type`, iterator/iteratorAll, the full filter protocol
   (`=`,`in`,`is-a`,`descendent-of`,`exists`,`regex`, text search),
   `filterLocate`/`filterCheck` membership duals, subsumesTest, multi-parent.
2. **Source-of-truth import verification.** Independent scripts (awk/sqlite
   over the raw LOINC CSV / RRF / RF2 files — deliberately *not* sharing
   importer code) recompute: concept counts by status, sampled parent/child
   sets, sampled closure rows (via a separate BFS), designation counts by
   language/type, property value spot checks. Run against the real imports.
3. **Differential parity.** The same operation corpus against the current
   `cs-loinc`/`cs-rxnorm` providers (on DBs built by the *current* importers)
   and the new provider, at two levels: provider-contract calls, and full HTTP
   `$lookup`/`$validate-code`/`$expand` against two server configs. Responses
   normalized (parameter order, timestamps, expansion ids) then diffed.
   SNOMED, lacking a binary cache here, is covered by layer 2 plus
   RF2-derived expectation files.

Intentional differences are recorded in the ledger below — parity means
*explained* deltas, not zero deltas.

## Performance strategy

Benchmark old vs new on the real DBs, reported as a matrix in
`docs/sqlite-v1-perf.md`: locate/lookup latency (hot/cold), filter execution
(SCT `is-a` on large subtrees e.g. 404684003, LOINC `CLASSTYPE`/`COMPONENT`,
RxNorm `TTY`/`RELA`), iterate-all throughput, `$expand` wall time for
representative ValueSets, plus import wall-time and DB size. Budget: new
provider must be ≥ old on every measured operation class or the delta gets a
written justification.

## Version-pinned tests

Official/upstream tests overfit to specific terminology releases are handled
by content, not by version-string games:

1. **Frozen fixture DBs.** The v1 analog of upstream's `tx/data/snomed-testing.cache`:
   convert that binary cache into a v1 SQLite DB (reader already exists in the
   TS port: `import-sct-cache-to-sqlite-v0.ts`, adapt to v1) so version-pinned
   SNOMED tests run against content-identical data on both providers forever.
   LOINC analog: a curated subset DB generated deterministically and stamped
   with the version the tests expect.
2. **Import the real edition when a test needs it.** DBs are cheap (~10 min for
   a SNOMED edition) and factories register per `system|version`, so editions
   coexist. Most historical releases are fetchable from the public bucket
   (`https://storage.googleapis.com/tx-fhir-org`); CPT and NLM-gated sources
   come from local archives (UMLS RRF slices), with draft loaders in the TS
   port to adapt.
3. **Loud skips.** A manifest of available editions (read from the DB files'
   own `code_system` rows) gates version-pinned suites; a missing edition is a
   reported skip, never a silent green.
4. **Structure vs content.** New tests assert structural invariants against
   synthetic fixtures; only frozen-fixture suites assert real-content
   expectations.

## Ordering contract

Three tiers; the parity harness compares sequences only where order is
semantic:

- **Tier 1 — must match:** explicit `compose.include.concept` listing order;
  the `sort` parameter (`code`/`display`/`prop:*`); LOINC answer-list member
  order (AnswerList SEQUENCE). Sequence-compared in parity.
- **Tier 1.5 — first-page composition under the default sort.** The official
  test suites sort *within* a page but multi-page cases implicitly require
  the first page's *contents* to match the reference server — so default
  traversal order is load-bearing even though no test asserts a sequence.
  The v1 provider therefore iterates and materializes everything in **source
  (concept_id) order**, which provably equals each legacy provider's
  effective order: SNOMED's binary cache iterates in numeric SCTID order and
  RF2 concept files are numerically sorted; RxNorm legacy iterates in rowid =
  RRF file order = numeric RXCUI order; LOINC legacy iterates in CodeKey =
  csv insertion order (parts before main codes in both importers). A
  `defaultOrder` cs_config key is reserved for future systems whose source
  order does not match their legacy order.
- **Tier 2 — implementation-defined, deliberately NOT matched:** the exact
  order is uniform source order rather than each legacy engine's incidental
  order in corners where those differ (e.g. old RxNorm has no ORDER BY at
  all and is unstable in principle). Set-compared in parity; first-page
  composition spot-checked for the official-test surfaces.
- **Paging consequence (operator-visible):** offset/count slices differ across
  the old→new migration boundary because tier-2 order differs; after
  migration they are stable across requests (stronger than legacy RxNorm).
  Provider choice is per-system config, wholesale — no client sees mixed
  pages within one deployment, and expansion-cache keys already isolate
  parameter sets.

## Known-divergence ledger

| # | Area | Old behavior | New behavior | Why |
|---|---|---|---|---|
| 1 | LOINC `is-a` filter | identical to `descendent-of` (cs-loinc.js Closure query; no self-row) | `is-a` includes the seed concept | FHIR filter-operator semantics |
| 2 | RxNorm totalCount / iteration | 294,596 — counts one row per non-SY TTY, so multi-TTY CUIs count repeatedly | 228,626 distinct RXCUIs (matches source) | old over-count is a bug |
| 3 | RxNorm version | `??` — old importer never populates RXNVer | `05042026` from RXNSAB SVER | old is a bug |
| 4 | RxNorm isInactive/getStatus | always active / null — provider compares SUPPRESS to `'1'` but the table stores N/O/E (cs-rxnorm.js:159,181), so 152k suppressed concepts serve as active | active = any RXNORM atom with SUPPRESS ∉ {O,E}; getStatus returns the per-CUI SUPPRESS flag | old comparison can never match |
| 5 | RxNorm display | first non-SY RRF row (RRF file order) | TTY-priority (PSN>SCD>SBD>…; may surface Tallman casing) | deliberate; NLM prescribable-name preference; switchable in importer if upstream prefers old rule |
| 6 | RxNorm designations | terms only (display + null-use extras) | each atom carries a TTY use coding; per-language preferred flags | richer, contract-conformant |
| 7 | RxNorm properties | `properties()` returned nothing; no propertyDefinitions | TTY/STY/SAB/SUPPRESS literals + RELA concept links, all in property_def | additive |
| 8 | RxNorm relationship filter value form | requires `CUI:<id>` / `AUI:<id>` | accepts `CUI:<id>` (cs_config filterValueRewrites) and bare code; `AUI:` unsupported (atoms not modeled) | compatibility kept for CUI form |
| 9 | RxNorm REL-only filters (RB/RN/RO… without RELA) | supported via RXNREL.REL | not imported/supported | pending: quantify real-world use before deciding to import ~5.7M REL rows |
| 10 | RxNorm hasParents | hardcoded `true`, but `iteratorAll()` throws "Must override" — hierarchy unusable | `false` (no is_hierarchy properties) | old flag was wrong |
| 11 | locate() not-found message | empty/undefined | populated "unknown code" message | contract expects a message |
| 12 | SCT all-inactive refsets | n/a (no old sqlite baseline) | refsets whose members are all inactive produce no value_set row (vs empty set) | importer imports active members only |
| 13 | LOINC axis filters (SCALE_TYP, PROPERTY, …) | value matches the target Part's NAME only (`Qn`); part codes not accepted | accepts name **and** part code (cs_config conceptFilterMatch=code-or-display); parity: SCALE_TYP=Qn → 43,658 both | published ValueSets use the name form |
| 14 | LOINC isInactive | true only for DISCOURAGED (cs-loinc.js:246) | true only for DISCOURAGED (reverted to match the reference during official-suite conformance — an earlier draft treated DEPRECATED as inactive too, which diverged) | conformance: match tx.fhir.org exactly |
| 15 | LOINC subsumesTest | unimplemented — returns not-subsumed even for equal codes | closure-based; equal → equivalent | new capability |
| 16 | LOINC iterator(null) | all 252k concepts, flat | 70,777 true hierarchy roots | affects whole-system *nested* expansion shape only (whole-LOINC expansion is too-costly in practice); flagged for HTTP-level parity |
| 17 | LOINC text filter | LIKE over Codes.Description (glucose → 1,821) | FTS over display+designations+literals (glucose → 1,878, superset) | richer surface; strict superset in sampling |
| 18 | LOINC lookup content | no definitions, no DisplayName designations, properties() empty | definition, DisplayName designations, full typed properties | additive |
| 19 | `expansion.property` scope (pushdown/IR vs legacy) | legacy decorates the full matched set then pages, so `expansion.property` reflects properties anywhere in the set (a non-active concept on a later page declares `status`) | pushdown/IR decorate only the returned page, so `expansion.property` reflects the page | page-scoped is arguably more correct (describes the *returned* concepts); matching legacy costs ~2× on hierarchy fast-path pages for one official case (`loinc-expand-prop-order-obs`). Measured, documented, not chased — see sqlite-v1-conformance.md |
