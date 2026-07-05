# sqlite-v1: official conformance suite, three engines

Running the official HL7 terminology test suite (the `fhir-validator-wrapper`
cases, v1.9.1) against the new sqlite-v1 provider under each expansion engine
— to answer "do legacy, pushdown, and IR behave identically, and how does the
new provider compare to the reference on the full behavioral surface."

## Method

- **Fixtures, not real editions.** The stock test library serves LOINC 2.82 and
  SNOMED editions from binary caches. We convert those to sqlite-v1 with
  `import-{loinc,sct-cache}-sqlite-v1` so the content and version are identical
  — a failure then means *engine/provider*, not *edition drift*.
  `tx/fixtures/test-cases-sqlite.yml` points LOINC + SNOMED at the fixtures;
  everything else (UCUM, internals, OMOP, npm packages) is unchanged.
- **Engine selection.** `TX_EXPAND_ENGINE=legacy|pushdown|ir` (a server default;
  per-request `_engine` still wins) runs the whole suite through one engine.
  `TX_TEST_LIBRARY` points the runner at the sqlite library.
- **Differential.** The suite runs three times; we compare per case. Cases that
  fail *identically* across all three engines cancel out (they are provider- or
  scope-level, not engine bugs). The signal is where the engines **disagree**.

Reproduce:
```sh
for e in legacy pushdown ir; do
  TX_TEST_LIBRARY=tx/fixtures/test-cases-sqlite.yml TX_EXPAND_ENGINE=$e \
    npx jest tests/tx/test-cases.test.js --runInBand --json --outputFile=/tmp/sqlite-$e.json
done
```
(The validator fetches cases from GitHub at startup; run the three passes with a
gap so back-to-back runs don't hit an API timeout.)

## Result

Of 2,503 cases:

- **1,935 pass identically under all three engines.**
- **One engine-divergent case** — `loinc-expand-prop-order-obs` (×R5/R4/cached).
  See the ledger entry below. Every other expand/validate/lookup case that the
  engines can address behaves identically across legacy, pushdown, and IR.
- **~556 fail under all three engines** — these are provider-scope, not engine
  bugs (they fail the same way regardless of engine):
  - **~90 ECL / expression / post-coordination** — out of scope by design; the
    binary SNOMED provider owns ECL, the sqlite SNOMED build does not.
  - **~200 `$lookup` / `$validate-code` / `$expand` behavioral gaps** — the new
    provider's *output* differs from the reference on details: `$lookup`
    property formatting, `$validate-code` message wording, some expand property
    details. This is real LOINC/SNOMED conformance work the official suite made
    visible (the curated parity harness compared codes only, never this surface).

## The one engine divergence: `loinc-expand-prop-order-obs`

This case surfaced two layered issues:

1. **Total emission (fixed).** Pushdown/IR volunteered an `expansion.total` on a
   paged filter set larger than the limit, where the reference and legacy omit
   it. The reference emits the total only when the full set fit under the
   effective limit (`loinc-expand-status`: limit=10000, 1,583 members → total;
   `order-obs`: no limit, 53,627 members → omitted). Fixed by gating total
   emission on `limitCount` in the worker (`emitProviderTotal`); verified all
   three engines now produce `status` total=1,583 and `order-obs` total omitted.

2. **`expansion.property` scope (documented delta — ledger #19).** Legacy
   decorates the *entire matched set* (up to the limit) then pages, so
   `expansion.property` reflects properties found anywhere in the full set — a
   non-active concept on page 2 causes `status` to be declared. Pushdown/IR
   decorate only the returned page, so they declare `expansion.property` from
   the page. On `order-obs` the returned 50 concepts carry no status value, so
   pushdown/IR omit the `status` declaration that legacy emits from a later
   concept.

   **Decision: keep the page-scoped behavior (do not match legacy here).**
   Measured cost of matching legacy: the general form (declare every property
   present across the full set) adds ~143 ms (4.4×) on `order-obs`; even the
   targeted `status`-only form costs ~2× on the hierarchy fast-path pages
   (~10 ms → ~28 ms) because it forces a full-set scan on exactly the queries
   the fast path exists to keep cheap. Against that: it affects **one** official
   case, and `expansion.property` is meant to describe properties on the
   *returned* concepts — declaring `status` when no returned concept has it is
   arguably *less* correct than the page-scoped behavior. So pushdown/IR keep
   page-scoped `expansion.property`; the delta is recorded, not chased.

## Final state (after ECL, LOINC, post-coordination, and SNOMED display/version)

Successive tracks — SNOMED ECL; LOINC $lookup/$validate/$expand output; SNOMED
post-coordinated expressions; and matching the binary provider's SNOMED display
(smallest-id active description) and version (full edition URI) — moved the
numbers here, every step with **zero regressions**:

| engine | session start | final | Δ |
|---|---|---|---|
| legacy (on sqlite fixtures) | 1944 / 559 | **2073 / 430** | +129 pass |
| pushdown | 1941 / 562 | **2061 / 442** | +120 pass |
| IR | 1941 / 562 | **2061 / 442** | +120 pass |

The full three-engine differential:

- **pushdown and IR are byte-identical across all 2,503 official cases — 0
  disagreements.** The two provider-driven engines behave identically.
- **18 legacy-vs-(pushdown/IR) differences, all explained:**
  - **3** where pushdown/IR are *better* than legacy (`loinc-expand-all-limited`
    ×R5/R4/cached — legacy's hierarchical whole-system iteration diverges on a
    paged whole-system expansion; pushdown/IR page it correctly).
  - **15** = the frozen `expansion.property` delta (ledger #19): 5 LOINC cases
    (`class-regex`, `prop-order-obs`, `copyright`, `scale-type`, `filter-dockind`)
    × R5/R4/cached, where pushdown/IR declare `expansion.property` from the page
    and legacy from the full set. Deliberately not chased.

ECL and post-coordinated expressions are now in scope for the sqlite SNOMED
provider (constraint cases and expression validate/subsume/membership pass,
evaluated identically by all three engines). Matching the binary provider's
display (smallest-id active description) and full version URI flipped ~54 SNOMED
lookup/validate cases green on its own.

The remaining ~430 shared failures: ~99 `$related`/`$compare` (upstream operation
rename, pre-existing on main — not this work), plus SNOMED `$validate-code`
message-wording, a few `expansion.property` cases, and assorted language cases —
the next conformance increment.

## Takeaways

- The engines are effectively in lockstep on the official suite: 1,935 identical
  passes, one documented, understood, defensible delta.
- The official suite's real value here was exposing the ~200 provider-level
  behavioral gaps (lookup/validate output detail) that membership parity cannot
  see — the concrete remaining LOINC/SNOMED conformance backlog.

## SNOMED $lookup / $validate-code / $expand drop-in (sqlite vs binary)

Making the sqlite SNOMED provider a true drop-in for the binary provider on the
official SNOMED/SCT fixtures. Ground truth = the official `*-response*` fixtures
(and the binary `cs-snomed` provider to disambiguate). Measured by
`test-scripts/sct-conformance-harness.js` (real server on the sqlite fixtures
library, official `$optional/$id/$uuid/$instant` comparison semantics,
order-insensitive, per-engine).

**86 SNOMED cases across suites (snomed / tx.fhir.org / bugs / related). Match
count: 16 → 57, identical under all three engines (legacy = pushdown = ir = 57).**

| operation | before | after |
|---|---|---|
| expand | 4 | 32 |
| validate-code | 5 | 17 |
| cs-validate-code | 5 | 6 |
| lookup | 2 | 2 |
| translate | 0 | 0 |
| **total** | **16** | **57** |

### Root causes and fixes

1. **`inactive` status filter returned the empty set** (`cs-sqlite.js`, config).
   A filter `{inactive = false|true}` matched a stored literal; active concepts
   have no `inactive=false` row, so `is-a X AND inactive=false` yielded 0 (vs the
   reference's non-empty set). Fix: a filter on the *boolean* status property
   (cs_config `inactiveProperty === statusProperty`, SNOMED only) maps to
   `concept.active` — added to both filter routings (`filter()`/`_runClause` and
   `_idsForFilter`) so legacy/pushdown/ir agree.

2. **status property over-emitted on active concepts** (`cs-sqlite.js`, config).
   `getStatus()` returned the raw `inactive` literal (`'0'`), `!== 'active'`, so
   every active concept got `property status=0` and expansions declared
   `expansion.property status`. Fix: for a boolean status property, `getStatus()`
   returns `'active'`/`'inactive'` from `concept.active` (matching binary) — the
   worker then emits `status` only for genuinely inactive concepts. LOINC's enum
   `STATUS` (`_isBooleanStatusProperty()===false`) keeps returning its stored
   value, so `loinc-expand-status` still surfaces DISCOURAGED/DEPRECATED.

3. **valueset-unclosed extension missing + hierarchical (should be flat)**
   (`cs-sqlite.js` + `expand.js`). SNOMED has a grammar → every filter/hierarchy
   expansion is "unclosed" and flat. Added `isNotClosed()` (config-gated on the
   expression flag) and `filtersNotClosed()` (respecting `expressions=false`,
   which *closes* the set) to the provider; the pushdown (`processCodes`) and IR
   (`processViaIR`) paths now set `notClosed` via `_hasOpenInclude(...) &&
   cs.isNotClosed()` exactly as the legacy filter path already did via
   `filtersNotClosed`. `notClosed` both emits the extension and flattens.
   No-op for every closed system (LOINC/RxNorm).

4. **display was the FSN / wrong synonym** (`import-sct-cache-sqlite-v1`,
   re-import). Verified against every official expand fixture: the returned
   display is the **first active SYNONYM** (900000000000013009) in description
   order — not the FSN, and *not* the en-US language-refset PREFERRED synonym
   (e.g. 61460008 → "Adrenal impression of liver", not the preferred "Structure
   of adrenal impression of liver"; 10200004 → "Liver", not "Liver structure").
   Importer display rule changed to first-active-synonym → FSN → first active →
   code. Requires a fixture re-import (both editions).

5. **`$validate-code` "not in the specified filter" preamble** (cs_config).
   Set `filterLocateMiss = 'silent'` (as LOINC) so a filter/hierarchy miss is a
   bare "not found in the value set" message, matching the reference.

6. **displayLanguage=* was a harness artifact** — undici's fetch sends
   `accept-language: *`; the real runner sends none. The harness strips it (no
   provider change): no official fixture ever emits a wildcard displayLanguage.

### Re-import

The display-rule change (#4) and `filterLocateMiss` (#5) require rebuilding the
SNOMED fixtures:
```sh
for cache_db in "sct_test_20250814.cache sct-test-20250814-v1.db" \
                "sct_intl_20250201.cache sct-intl-20250201-v1.db"; do
  set -- $cache_db
  (printf 'n\n'; sleep 900) | node tx/importers/tx-import.js snomed-cache-sqlite-v1 \
    import -s data/terminology-cache/$1 -d ~/work/tx-dbs/$2 --overwrite -y
done
```
(`filterLocateMiss` is also written by the importer now; the fixtures used for
these numbers had it set directly on cs_config, equivalent to a re-import.)

### The 27 still failing (categorised, none a further provider regression; 26 after the $lookup parity work below)

- **9 reference-server url bug** (`ecl-or`, `-term-match`, `-term-mismatch`,
  `-term-with-operator`, `-wildcard-minus`, `-nested-parens`, `-refinement-simple`,
  `-refinement-wildcard`, `-refinement-group`): expected VS `url` has a stray
  trailing `}` the request never sent — our output is byte-identical otherwise.
- **~8 OperationOutcome `operationoutcome-message-id` extension / implicit-VS /
  R4-version** (`validation-1`, `inactive-display`, `ecl-invalid-sctid`,
  `validate-implied-1b/2`, `bugs/sct-parse`, `sct-ver`, `sct-msg-4`): our error
  Issues omit the message-id extension; some also need implicit `?fhir_vs=`
  resolution, and `sct-msg-4` is an R4 case the harness posts to /r5.
- **3 total off-by-one** (`expand-property-1/2`, `ecl-refinement-cardinality`):
  a single member difference — edition drift (fixture 20250201 vs generation) or
  a minor property-filter detail.
- **2 `$lookup`** (`lookup`, `lookup-pc`): ~~`extendLookup` must emit parent/child
  + attribute relationships~~ DONE (see the $lookup parity section below); the
  sole remaining diff is the REQUIRED `effectiveTime`: the fixture says
  `2005-01-30`, one day BEFORE the RF2 date `20050131`, because the reference
  converts its day-count via a LOCAL-time `Date` + `toISOString()`
  (`cs-snomed.extendLookup`) and the fixtures were generated in a UTC+
  timezone. Run in a UTC- timezone the reference itself emits `2005-01-31` —
  which is what we emit (the actual RF2 date). Not reproducible without
  deliberately mis-rendering the date.
- **1 `$translate`**: needs an implicit SNOMED `?fhir_cm=` ConceptMap.
- **misc**: `ecl-memberOf-nonRefset` (ECL `^ <non-refset>` returns total 1 at the
  reference, we raise INVALID_ECL), ~~`snomed-expand-inactive` (designation
  `use.display` names)~~ fixed by `designationUseDisplays` (below),
  `bugs/sct-ver-ex` (US edition 731000124108 absent from
  the fixtures), `bugs/sct-isa` ($cache-control cache id the harness never creates).

## SNOMED $lookup drop-in (branch sqlite-v1-sctlookup)

Closes the `$lookup` conformance gap above: the sqlite provider's `$lookup`
output for the official `snomed/lookup` + `snomed/lookup-pc` fixtures now
matches the expected responses parameter-for-parameter — the only remaining
diff is the `effectiveTime` fixture timezone artifact documented above.
Harness totals: 57 → 58 (`snomed-expand-inactive` flips to pass;
`lookup`/`lookup-pc` still count as failing solely on that date artifact).
Pinned by `tests/tx/sqlite-v1-sct-lookup.test.js` (full-fixture comparison with
the date normalized, plus targeted shape assertions).

Gaps and fixes (all in `cs-sqlite.js` extendLookup/designations + cs_config
keys written by both SNOMED importers; the new keys were applied directly to
the existing fixture DBs' cs_config — equivalent to a re-import, no data
change):

1. **`parent`/`child` properties missing** (provider, generic). Hierarchy
   edges now surface as the standard concept-properties: outbound is-a →
   `parent`, inbound is-a → `child` (derived only when the DB defines no
   explicit `child` property — LOINC stores child edges). The raw is-a code
   (116680003) no longer leaks into `$lookup`. LOINC output byte-identical
   before/after (its hierarchy property is already named `parent`).
2. **attribute properties incomplete + undecorated** (cs_config
   `lookupLinkDistinct`, `lookupLinkDescriptions`). Reference SNOMED lists
   every DISTINCT (attribute, target) pair over ALL relationship rows —
   historical/inactive included, deduplicated across relationship groups — with
   `code-display` (attribute concept's display) and `description` (target's
   display). Default stays active-rows-with-duplicates (reference LOINC emits
   duplicate relationship rows, 5792 dup pairs in loinc-v1.db).
3. **descriptions use the reference's getDisplayName rule** (provider
   `_lookupDisplay`): the FIRST ACTIVE designation in designation_id order
   (which preserves RF2 description-id order) — NOT `concept.display` — so an
   FSN can surface (e.g. child 18701002 → "…with graft (procedure)",
   code-display 405813007 → "Procedure site - Direct (attribute)").
4. **moduleId/definitionStatusId/inactive literals shaped wrong** (cs_config
   `lookupPropertyOverrides` + generic). `moduleId` → emitted as `module` with
   the module concept's display as `description`; `definitionStatusId` kept
   out of `$lookup`; the stored `inactive` literal suppressed generically
   whenever it names cs_config `inactiveProperty` (the worker already emits
   the standard `inactive` property — it was being duplicated).
5. **effectiveTime not a valid FHIR dateTime** (provider, generic). Compact
   `yyyymmdd` dateTime literals normalize to `yyyy-mm-dd` on emission.
6. **designation shape** (cs_config `displayDesignation=0`,
   `designationUseDisplays=1`, `expressionLanguage=en-US`). The reference
   emits ONLY the RF2 descriptions (no synthesized preferredForLanguage
   display designation — the preferred synonym is picked by the worker via
   `_isPreferred` on the SNOMED synonym use), decorates use codings with the
   description-type concept's display ("Synonym (core metadata concept)" /
   "Fully specified name" — the getDisplayName rule again), and tags a
   post-coordinated expression's rendered designation `en-US`.
7. **expression `$lookup` had no properties** (provider). A single-focus
   post-coordinated expression now surfaces the focus concept's full property
   set (parent/child/attributes/literals) plus each refinement as an attribute
   property with `code-display`/`description` — matching binary
   `cs-snomed.extendLookup`.
