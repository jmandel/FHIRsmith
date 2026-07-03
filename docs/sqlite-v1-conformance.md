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

## Takeaways

- The engines are effectively in lockstep on the official suite: 1,935 identical
  passes, one documented, understood, defensible delta.
- The official suite's real value here was exposing the ~200 provider-level
  behavioral gaps (lookup/validate output detail) that membership parity cannot
  see — the concrete remaining LOINC/SNOMED conformance backlog.
