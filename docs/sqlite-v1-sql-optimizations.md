# sqlite-v1 SQL optimizations (applied) and the heuristics behind them

Driven by the broad SQL profiling (`sqlite-v1-sql-profile.md`) and a
shapes × sizes × constraints benchmark matrix on the real SNOMED (537k),
LOINC (252k), and RxNorm (228k) databases. Every change was measured before and
after on the real data, with the provider/IR parity suites kept green
throughout. Query-shape fixes only — no reimport, no schema change.

## Applied

### A. Literal value filters: UNION of two indexed seeks

`_propertyIds`. The predicate `value_text … OR value_raw … COLLATE NOCASE`
defeated both NOCASE indexes and scanned the whole property partition plus a
`DISTINCT` temp b-tree, so cost tracked partition size, not selectivity. Split
into a `UNION` of two `COLLATE NOCASE IN` seeks, each of which uses its
dedicated index; the `UNION` dedups so `DISTINCT` is gone.

| filter | before | after | speedup |
|---|---|---|---|
| RxNorm TTY=SCD (17k) | 82 ms | 7.8 ms | 10.6× |
| LOINC CLASSTYPE=3 (1k) | 78 ms | 1.0 ms | 78× |
| LOINC CLASSTYPE=1 (66k) | 111 ms | 21 ms | 5.3× |
| LOINC STATUS=ACTIVE (170k) | 171 ms | 80 ms | 2.1× |

Benefits **all three engines** (the filter protocol, pushdown, and IR all route
through `_propertyIds`).

### B. Hierarchy/value-set paging: LIMIT pushdown + `UNION ALL`

`_fastSource` / `_tryFastPage`. Two parts:

1. Order and page the id set **before** joining `concept`, so only a page's
   worth of ids reach the join. For an index-ordered source (closure by
   `descendant_id`, `value_set_member` by `concept_id`) SQLite satisfies
   `ORDER BY id LIMIT` from the index and early-stops instead of sorting the
   whole set into a temp b-tree.
2. `is-a`/`generalizes` seed the set with `UNION ALL` (not `UNION`): the closure
   stores no self-rows, so the seed is never among its own descendants — no
   dedup needed, which avoids materialising the whole set into a dedup b-tree.

| query | before | after | speedup |
|---|---|---|---|
| SCT is-a (94k) page 50 | 65 ms | 10.5 ms | 6.2× |
| SCT is-a (94k) count | 23 ms | 3.6 ms | 6.4× |
| SCT descendent-of (94k) page 50 | 25 ms | 2.6 ms | 9.7× |

### C. activeOnly exact total via SQL, not JS

`_tryFastCount(subtree, activeOnly)`. Under `activeOnly` the exact total must
touch every member to know which are active. A SQL `COUNT` over the
member→concept active-join does that in ~17 ms at 94k; the previous JS path
materialised every id and filtered through a cached active-id set at ~39 ms.

| query | JS path | SQL count | speedup |
|---|---|---|---|
| SCT is-a (94k) activeOnly count | 39 ms | 19 ms | 2.1× |
| SCT descendent-of (94k) activeOnly count | 35 ms | 17.5 ms | 2.0× |

## Rejected (measured, then reverted)

### D. Type-directed single-column literal seek

Using `property_def.fhir_type` to seek only `value_text` (code/string types) or
`value_raw` (numeric/boolean), avoiding A's second arm. Measured **mixed**:
STATUS=ACTIVE 80→71 ms (helped), but integer CLASSTYPE 21→25 ms (the `DISTINCT`
single-arm planned worse than the `UNION` merge), a net wash. It also makes
correctness depend on `fhir_type` being accurate (a mistyped property would
silently miss matches). The robust two-arm `UNION` (A) is kept.

## Heuristics learned (some non-obvious)

- **Page cost and total cost are separate and respond to different tricks.** A
  page can early-stop off an index; an exact total generally cannot. Two of the
  optimizations above (B page, C count) are different mechanisms for the same
  query because of this split.
- **`activeOnly` is the expensive axis, and the total is the expensive half.**
  An active filter is a `concept`-column predicate, so it forces a join and a
  scan of every member to *count* actives — the page can still early-stop, but
  the exact total cannot. SQL does that count ~2× faster than materialising ids
  into JS (C). *First mistake:* I reverted C on two page numbers before seeing
  (from the matrix) that the page number is dominated by the total it computes,
  and that SQL wins the total.
- **A cached JS set is not automatically cheaper than SQL.** The active-id set
  is built once and reused, which *sounds* like it should beat re-querying — but
  materialising 94k ids into JS to filter is slower than a SQL `COUNT` over an
  indexed join. Measure, don't assume.
- **The JS set-merge is genuinely cheap** (`intersect`/`diff`/`union` over
  100k-element sorted arrays: 0.4–7.6 ms), so pushing set algebra into SQL is
  *not* where the wins are — a correction to an earlier assumption. The wins are
  in the per-clause SQL (A) and in paging (B).
- **Robustness can outweigh a marginal speedup** (D): a fragile dependency on
  metadata is not worth a wash.

## Remaining opportunities (deliberately not taken here)

These show real impact but need a contract or schema change, so they are their
own considered work, not a query-shape tweak:

- **Lazy / inferred total.** For `activeOnly` big sets and large property
  filters, the page is cheap but the exact total is a full scan. Legacy already
  returns no total for these, so omitting it (or inferring `offset + pageLen`
  when the page is short) would be legacy-consistent and drop those pages to a
  few ms — but it changes the total policy across pushdown and IR together and
  needs the parity suite reworked to match. The single highest-value remaining
  win.
- **`(property_id, active, source_concept_id)` index** to make `exists` and the
  property `DISTINCT` index-only (drops the temp b-tree) — a one-line schema
  addition, but needs a reimport.
- **Regex pre-filtering** (extract a required literal substring → FTS/index
  probe before the JS `RegExp`) — the one unbounded property shape; otherwise
  governor territory.
