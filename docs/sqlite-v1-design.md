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
