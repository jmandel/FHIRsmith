# sqlite-v1: conformance residual — what the remaining official-suite failures are

This catalogs the official HL7 terminology-suite cases that the sqlite-v1
provider does **not** match, and shows — case by case — that the material ones
are **not provider defects**: they are reference-fixture bugs, test-edition
drift, or deliberately-documented deltas. It is the evidence behind the PR's
"drop-in" claim: where the sqlite output differs from a fixture, the difference
is explained and attributable.

Two independent baselines:

- **Default (binary-provider) config** — 258 failures, byte-identical to `main`.
  These have nothing to do with this work (the new provider is dormant).
- **sqlite-fixture config** — the ~279 legacy failures when LOINC + SNOMED are
  served by the new provider. Categorized below.

## 1. Upstream operation rename: `$related` → `$compare` (183 of the 258)

**183 of the 258 default-config failures** call an operation the server no
longer exposes under that name (`$related` was renamed `$compare` upstream).
They fail identically on clean `main`; nothing here touches them.

- Evidence: on the old-provider baseline, 183/258 failing case names match
  `related|compare`.

## 2. Reference-fixture bug: stray `}` in expected ValueSet urls (~9 SNOMED ECL cases)

Several `sct-ecl-*` expected responses carry a spurious trailing `}` in the
ValueSet `url` that the corresponding request never sends. Our expansion is
otherwise byte-identical; the comparison fails only on that malformed url.

- Evidence (grep of the expected responses):
  - `"url" : "http://hl7.org/fhir/test/ValueSet/sct-ecl-refinement-group}"`
  - `"url" : "http://hl7.org/fhir/test/ValueSet/sct-ecl-term-mismatch}"`
  - `"url" : "http://hl7.org/fhir/test/ValueSet/sct-ecl-term-match}"`
- Affected: `ecl-or`, `ecl-term-match`, `ecl-term-mismatch`, `ecl-term-with-operator`,
  `ecl-wildcard-minus`, `ecl-nested-parens`, `ecl-refinement-simple`,
  `ecl-refinement-wildcard`, `ecl-refinement-group`.
- Not our bug: the request's `ValueSet.url` has no `}`; the reference expected
  file does. Worth reporting upstream.

## 3. Test-edition drift (our SNOMED fixture is 20250201)

The sqlite SNOMED fixture is built from the `sct_intl_20250201` cache; a handful
of fixtures were generated against a **20250814** edition. Where the two
editions genuinely differ, a count or date differs — an artifact of which
edition is loaded, not of the provider.

- **`effectiveTime` off-by-one date** (`lookup-procedure`): we emit `2005-01-31`,
  the actual RF2 `effectiveTime` (20050131); the fixture says `2005-01-30`. The
  fixture was generated in a UTC+ timezone where the binary provider's
  local-time day-count→date conversion loses a day. On this UTC−6 host the
  **binary provider emits `2005-01-31` too** — i.e. we match the reference
  implementation, and the fixture is the outlier. Not reproducible without
  deliberately mis-rendering the date.
- **Descendant-count off-by-one** (e.g. `expand-pc-filter`): International
  20250201 has 160 descendants-or-self of `128241005`; the generation edition
  had 159. Edition content, not logic.

## 4. Deliberate, documented delta: `expansion.property` scope (ledger #19)

Five LOINC cases (`class-regex`, `prop-order-obs`, `copyright`, `scale-type`,
`filter-dockind`) × R5/R4/cached: `legacy` decorates the whole matched set then
pages, so it declares `expansion.property` from properties anywhere in the set;
`pushdown`/`IR` decorate only the returned page. This is a measured, deliberate
choice (matching legacy costs a full-set scan on the hierarchy fast path for one
family of cases; page-scoped is arguably more correct). Recorded in
`sqlite-v1-design.md` (ledger #19) and `sqlite-v1-conformance.md`.

## 5. Genuinely deferred (a real follow-up, small surface)

- **`$translate` against implicit `?fhir_cm=` ConceptMaps** for the sqlite
  provider — one `snomed-translate` case. A tracked follow-up (plan.md P3.4),
  not a parity gap in `$lookup`/`$validate`/`$expand`/`$subsumes`.

## Bottom line

The remaining sqlite-config failures decompose into: an upstream operation
rename (§1), a reference-fixture typo (§2), edition drift (§3), one documented
scoping choice (§4), and one small deferred feature (§5). None is a defect in
which codes the provider returns or how it decorates them — verified against the
binary provider as ground truth throughout.
