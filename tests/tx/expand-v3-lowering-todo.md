# expand-v3 lowering TODO (gap closure checklist)

Status: tracked in harness with dedicated `v3-lowering-gap-*` tests.

## 1) Intersect selector coalescing in rewrite

- Goal: collapse same-system `intersect` selector chains before execution.
- Expected outcome:
  - fewer selector components in `v3.exec.stream`
  - fewer `v0.expandQuery` calls when queryIR lowering is disabled
- Harness coverage:
  - `v3-lowering-gap: intersect same-system filters coalesce in rewrite`

## 2) Nested diff partitioning (not only root diff)

- Goal: partition any `diff` node by `(system, version)` when left side spans multiple systems.
- Expected outcome:
  - mixed-system deep import trees push down one query per system slice, not per branch.
- Harness coverage:
  - `v3-lowering-gap: nested diff partitioning reduces mixed import query fanout`

## 3) Cross-branch filter dedupe after import inlining

- Goal: dedupe equivalent filter selectors from different import branches (order-insensitive clause signatures).
- Expected outcome:
  - duplicate filter branches do not create duplicate pushdown queries.
- Harness coverage:
  - `v3-lowering-gap: duplicate filter branches are deduped after import inline`

## 4) Intersect filter+concept coalescing via `intersectCodes`

- Goal: lower `intersect(filter, concept)` to one filter selector + `intersectCodes`.
- Expected outcome:
  - single provider query for the intersect term
  - no membership-index secondary query for concept term
- Harness coverage:
  - `v3-lowering-gap: intersect filter+concept lowers to single query with intersectCodes`

## 5) Dead-branch elimination after projection

- Goal: projected `intersect` terms with any empty branch collapse to empty (annihilator semantics).
- Expected outcome:
  - partitioned diff does not keep impossible projected branches
  - no spurious scans from impossible intersections
- Harness coverage:
  - `v3-lowering-gap: projection eliminates empty intersect branches`

## 6) QueryIR union folding

- Goal: fold safe union shapes in compiler:
  - concept+concept -> single concept select (code union)
  - filter+filter identical -> dedupe
  - `all` dominates
- Expected outcome:
  - simpler queryIR (`ops` reduced)
  - fewer provider calls where unions were split upstream
- Harness coverage:
  - `v3-lowering-gap: queryIR union folding merges concept unions`
  - `v3-lowering-gap: queryIR union folding dedupes identical filters`
