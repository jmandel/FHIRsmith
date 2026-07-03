# Three-engine expansion performance: legacy vs pushdown vs IR

Compares three ways of evaluating a `ValueSet/$expand` over the same
terminology content, on identical hard/mixed queries:

- **legacy** — the stock per-include enumeration path (`ValueSetExpander`,
  provider filter protocol iterated concept-by-concept). In this PR branch.
- **pushdown** — the new `processSelection` seam: simple composes evaluated
  as set algebra in the provider with offset/count/total pushdown. In this
  PR branch, same `cs-sqlite` provider, toggled by `handlesSelecting()`.
- **IR** — the older `ir-sqlite-v0` draft's IR engine (compose → set-algebra
  IR → compiled SQL). Lives on the separate `ir-sqlite-v0-pr-ready` branch,
  **not** in this PR.

## Honesty caveats (read first)

1. **The IR column is cross-branch and cross-schema.** legacy and pushdown run
   in this PR (`~/work/fs2`) on the sqlite-v1 DBs. IR runs in the draft branch
   checkout (`~/hobby/fhirsmith-ir-pr`) on its own v0-schema DBs. The
   **terminology content is matched** (SNOMED CT US 20260301, LOINC 2.82; the
   refset table is populated identically — 21,400 members both sides), but the
   schema, provider code, and checkout differ. IR numbers are therefore
   **indicative, not a controlled A/B** against the other two.
2. **IR is not invokable inside this PR branch.** The user's framing assumed
   all three could run here; only legacy and pushdown can. The IR column was
   produced by driving `expandViaIR` in the draft branch against content-matched
   DBs. Landing IR in this server is the separate, larger Stage-F effort.
3. Single-run medians on one warm machine; treat sub-5ms values as "fast," not
   as precise. Reproduce with `scripts/sqlite-v1-bench/bench-engines.md`.

## Results (median ms, warm; 25 iters, 15 for total-only)

| query | legacy | pushdown | IR | exact total | totals agree (P/IR) |
|---|---|---|---|---|---|
| SCT is-a Clinical finding (404684003), page 50 | 285 | 50 | 6 | 132,173 | ✓ |
| SCT is-a Clinical finding, offset 2000 page 50 | **too-costly** | 50 | 42 | 132,173 | ✓ |
| SCT is-a Procedure (71388002), total-only | **too-costly** | 19 | 3 | 61,222 | ✓ |
| SCT is-a 22298006 ∧ descendent-of 56265001, page 200 | 31 | 22 | 2 | 130 | ✓ |
| SCT is-a diabetes ∖ is-a T1DM, page 100 | 29 | 17 | 2 | 103 | ✓ |
| SCT (is-a 22298006 ∪ in refset 723264001), page 150 | 236 | 38 | 1 | 21,530 | ✗ (IR 130 — see note) |
| SCT is-a Body structure (123037004) activeOnly, page 100 | 240 | 34 | 24 | 43,460 | ✓ |
| LOINC CLASSTYPE=1, page 100 | 360 | 130 | 30 | 66,861 | ✓ |
| LOINC CLASSTYPE=1, total-only | **too-costly** | 114 | 30 | 66,861 | ✓ |
| LOINC STATUS=ACTIVE, page 200 | 368 | 203 | 153 | 170,391 | ✓ |

## Reading the numbers

**Pushdown vs legacy (the controlled comparison — same branch, same provider,
same DB).** Pushdown is faster on every query (1.4×–7× on the paged cases) and,
more importantly, **answers three queries legacy refuses outright**: deep-offset
paging and total-only counts throw `VALUESET_TOO_COSTLY` on the legacy path
because it materializes and decorates the whole set before paging, tripping the
expansion limit. Pushdown computes the total from the id-set and slices the page,
so `count=0` total-only and `offset=2000` are cheap. Pushdown also returns an
**exact total** on every query; legacy returns `total=undefined` for the big
filtered sets (it stops counting at the limit).

**IR is faster still on the hierarchy queries** — 6ms vs pushdown's 50ms on the
132k-descendant is-a page, 2–3ms on the bounded ones. The reason is structural:
IR compiles the whole filter+page into a single SQL statement and lets SQLite
apply `LIMIT`, whereas pushdown materializes the full sorted id array in JS and
then slices. For a small page off a huge set that JS materialization is the cost.
Where the result set is genuinely large and mostly returned (LOINC STATUS=ACTIVE,
170k rows, page 200) the three converge (368/203/153ms) — everyone pays to
produce the rows.

**Cross-engine correctness cross-check (the valuable by-product).** pushdown
(v1 schema, this branch) and IR (v0 schema, other branch) are independent
implementations over independently-built databases, yet their **exact totals
agree on 9 of 10 queries** — including the exact SNOMED subtree counts (132,173 /
61,222 / 43,460) and LOINC filter counts (66,861 / 170,391). That agreement across
two schemas and two engines is strong evidence both compute the right membership.

**The one disagreement is an IR-draft coverage gap, not a data difference.** On
the union-with-refset query, pushdown returns 21,530 and IR returns 130 (exactly
the is-a branch alone). The refset table holds the same 21,400 members in both
DBs; the IR draft simply doesn't resolve `concept in <refsetId>` as a **filter**
operand (it exposes refsets only as implicit ValueSets), so it silently drops
that union branch. Verified directly: `concept in 723264001` as a filter returns
0 through the IR draft. This PR's pushdown handles it in both the filter protocol
and `processSelection`.

## Takeaways for the PR

- Pushdown is a strict win over legacy on the controlled comparison: faster,
  exact totals, and it turns three "too-costly" refusals into cheap answers —
  with byte-identical membership to legacy where legacy produces a result
  (verified separately, `scripts/` pushdown-vs-legacy check).
- IR's single-SQL-statement model is the further prize on deep-set/small-page
  hierarchy queries; adopting it here is Stage F. Its draft also has real
  coverage gaps (refset-as-filter) that a productionization would need to close
  — which the pushdown provider already covers.
- The independent v0-IR-vs-v1-pushdown total agreement (9/10, the 10th
  explained) doubles as a correctness oracle for both.
