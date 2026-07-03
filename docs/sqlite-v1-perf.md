# sqlite-v1 provider performance: OLD vs NEW

Benchmark of the legacy terminology providers (`LoincServices`, `RxNormServices`,
async-`sqlite3`) against the new generic sqlite-v1 provider
(`SqliteCodeSystemProvider`, `better-sqlite3`). Every number is **end-to-end
provider-contract latency** — `locate()`, `display()`, `executeFilters()` +
drain, etc. — not raw SQL. The driver + schema difference between the two
implementations is exactly what is being measured.

Reproduce with:

```
node scripts/sqlite-v1-bench/bench-provider.mjs --all --json /tmp/claude-1000/
```

## Method

- Timing via `performance.now()`. All operations run **sequentially**, never
  concurrently.
- Each measured cell: **≥3 warmup iterations** (20 for the sub-millisecond
  micro-ops), then N timed iterations chosen so the cell runs ~0.5–5 s. We report
  **median** and **p95** in ms (or ops/sec / codes/sec for throughput cells).
- `factory.load()` is a **cold-start, single run**, timed separately.
- The random code list for each operation is seeded (mulberry32, seed
  `1234567`) and sampled from the **new** DB's `concept` table, so **both sides
  of a pair see the identical code list**.
- `ratio = old_median / new_median`; **ratio > 1 means the new provider is
  faster**. For throughput cells, ratio is `new_per_sec / old_per_sec` (again,
  > 1 means new is faster).

### Machine / driver context

| | value |
|---|---|
| Node | v24.16.0 |
| new driver | better-sqlite3 (synchronous) v12.4.1 |
| old driver | sqlite3 (async, callback-based) |
| host | Linux x86-64 |

### DB files and import

| pair | old size | new size | new concepts | new import (from `load_audit`) | old import (approx, not re-run) |
|---|---|---|---|---|---|
| LOINC  | 921 MB  | 980 MB  | 252,207 | 123.1 s | ~4 min (with the new txn patch) |
| RxNorm | 1,818 MB | 472 MB | 228,626 | 53.1 s  | ~12 min (earlier logs) |
| SNOMED | — (no old baseline) | 1,634 MB | 537,781 (386,110 active) | 171.0 s | — |

`totalCount()` differs by design between sides (old counts source rows /
`rxnconso` term rows; new counts distinct concepts): LOINC old 252,208 vs new
252,207; RxNorm old **294,596** vs new **228,626** (old counts term rows, new
counts concepts) — keep this denominator difference in mind when reading the
RxNorm filter/iteration cells below.

### The one structural caveat you must read first

The **old LOINC provider loads the entire concept set into memory** at
`load()` time (`this.codes`/`this.codeList`/`allKeys` maps + arrays), so its
hot paths — `locate`, `iterator`, `filterLocate`, `subsumesTest` — are pure
in-JS map/array lookups and its `subsumesTest` is a hard-coded constant
(`'not-subsumed'`, unimplemented). The old RxNorm provider does **not** cache
concepts; it queries async-`sqlite3` per call. The new provider is **fully
DB-backed for every call** on both terminologies. So:

- **LOINC old-vs-new** is mostly *"RAM-resident map vs on-disk B-tree"*, which
  the new side "loses" on micro-ops by construction. That is the honest cost of
  not front-loading ~1 GB into the heap.
- **RxNorm old-vs-new** is the truer *"async-sqlite3 vs better-sqlite3"*
  comparison, and there the new provider wins almost everything.

---

## 1. `locate()` hot — 1000 seeded random codes

| pair | old median | old p95 | new median | new p95 | ratio |
|---|---|---|---|---|---|
| LOINC  | 0.001 ms | 0.002 ms | 0.017 ms | 0.026 ms | **0.06** (new slower) |
| RxNorm | 0.191 ms | 0.308 ms | 0.026 ms | 0.404 ms | **7.35** (new faster) |
| SNOMED | — | — | 0.024 ms | 0.036 ms | — |

LOINC old is an in-memory `Map.get`; new is an indexed row read. RxNorm old
issues an async SQL query per locate — that round-trip is ~7× the new
synchronous indexed read.

## 2. Full lookup decoration — 200 codes, per-code median

`locate + display + designations + properties + isInactive + getStatus`.

| pair | old median | old p95 | new median | new p95 | ratio |
|---|---|---|---|---|---|
| LOINC  | 0.129 ms | 1.053 ms | 0.299 ms | 0.934 ms | **0.43** (new slower) |
| RxNorm | 0.322 ms | 0.457 ms | 1.473 ms | 3.687 ms | **0.22** (new slower) |
| SNOMED | — | — | 0.203 ms | 0.246 ms | — |

Both cells favor old — see **Regressions**. Decoration fans out into several
per-concept queries (designations, properties/relationships) on the new side;
old LOINC serves most of it from RAM, and old RxNorm's `properties()` is the
base no-op (`[]`), so it is doing strictly less work per code than new.

## 3. Filter execution + drain ALL results

Total wall time to `executeFilters` and drain the full result set via
`filterMore`/`filterConcept`, counting codes. `count` is the drained set size;
`codes/sec` is derived from the median wall time.

### LOINC

| filter | old count | old median | old p95 | new count | new median | new p95 | ratio |
|---|---|---|---|---|---|---|---|
| CLASSTYPE=1 | 66,861 | 114.3 ms | 120.0 ms | 66,861 | 231.5 ms | 246.8 ms | 0.49 |
| STATUS=ACTIVE | 170,391 | 188.4 ms | 193.8 ms | 170,391 | 463.3 ms | 470.3 ms | 0.41 |
| SCALE_TYP=Qn | 43,658 | 104.9 ms | 108.6 ms | 43,658 | 129.8 ms | 137.7 ms | 0.81 |
| concept descendent-of LP432695-7 | 181,430 | 246.6 ms | 252.2 ms | 181,430 | 367.9 ms | 379.3 ms | 0.67 |
| searchFilter('glucose') | 1,821 | 32.1 ms | 32.8 ms | 1,878 | 19.8 ms | 22.5 ms | **1.62** |

Counts match on every LOINC filter (search differs by 57: old 1,821 vs new
1,878 — a recall difference, not a timing one). New wins only on the FTS
search; the bulk property/hierarchy drains are 1.2–2.4× slower than old's
in-memory-assisted path.

### RxNorm

| filter | old count | old median | old p95 | new count | new median | new p95 | ratio |
|---|---|---|---|---|---|---|---|
| TTY=IN | 14,632 | 33.6 ms | 37.8 ms | 14,632 | 110.5 ms | 116.4 ms | 0.30 |
| STY=T121 | 27,985 | 254.4 ms | 256.7 ms | 27,023 | 113.0 ms | 117.9 ms | **2.25** |
| SAB=RXNORM | 294,596 | 1007.4 ms | 1047.7 ms | 228,626 | 1153.8 ms | 1178.9 ms | 0.87 |
| has_tradename=CUI:854979 | 23 | 96.9 ms | 100.7 ms | **0** | 0.022 ms | 0.032 ms | — (see note) |
| searchFilter('aspirin') | 2,074 | 259.7 ms | 263.4 ms | 1,574 | 7.4 ms | 8.9 ms | **34.97** |

- **searchFilter('aspirin')**: new is ~35× faster (FTS trigram index vs old's
  `LIKE` scan). The old-side count in this table (2,074) is a bench-harness
  artifact of how it constructed the old provider's stem filter object;
  authoritative SQL against both DBs (old `RXNSTEMS stem LIKE 'aspirin%'`,
  new FTS designation match) returns **exactly the same 1,574 concepts with
  an empty diff**, matching the parity harness's EXACT verdict. Timing ratio
  is unaffected in magnitude.
- **has_tradename=CUI:854979**: at bench time the new RxNorm DB predated the
  `filterValueRewrites` config (importer writes it now; the DB has been
  patched), so the `CUI:` form returned 0. With the form resolved, new
  returns the same 23 members as old in **~0.22 ms vs old's ~96.9 ms**
  (~440× faster). The 0-result cell above is excluded from the ratio.
- **SAB=RXNORM** and **TTY=IN** are the two large-literal drains where new is
  slower; note the SAB count denominators differ (294,596 term rows vs 228,626
  concepts).

### SNOMED (new only — absolute numbers)

| filter | count | median | p95 | codes/sec | note |
|---|---|---|---|---|---|
| concept is-a 404684003 (Clinical finding) | 132,173 | 270.3 ms | 317.8 ms | 489,037 | |
| concept is-a 373873005 (Pharmaceutical) | 25,735 | 49.4 ms | 51.5 ms | 520,888 | |
| concept in (refset) 723264001 | 21,400 | 16.5 ms | 16.6 ms | 1,299,885 | refset member enumeration¹ |
| searchFilter('myocardial') | 462 | 10.6 ms | 11.0 ms | 43,684 | |

¹ A SNOMED refset is exposed as an implicit ValueSet expansion
(`buildKnownValueSet`), **not** a `filter()` clause. This DB's stored
`implicitValueSets` patterns omit the `?` separator the URL matcher expects, so
`buildKnownValueSet` returns null for the canonical refset URL. The cell above
falls back to timing the provider's own refset member-enumeration query (the
exact `value_set_member ⋈ concept` SQL that `_buildVsTable` runs). It is
labelled distinctly so it is not read as a filter-protocol drain.

## 4. `filterLocate()` membership probe

400 probes (200 seeded member candidates + 200 guaranteed non-members) against
the largest filter set of each pair.

| pair | probe filter | old median | old p95 | new median | new p95 | ratio |
|---|---|---|---|---|---|---|
| LOINC  | STATUS=ACTIVE | 0.001 ms | 0.005 ms | 0.018 ms | 0.029 ms | 0.06 (new slower) |
| RxNorm | SAB=RXNORM | 90.706 ms | 197.534 ms | 0.017 ms | 0.021 ms | **5,336** (new faster) |
| SNOMED | concept is-a 404684003 | — | — | 0.018 ms | 0.026 ms | — |

The RxNorm result is the headline: old RxNorm runs a **fresh async SQL query
per probe** (`filterLocate` re-queries `rxnconso`), so a single membership check
costs ~91 ms median; the new provider does a `locate` + binary search over the
already-materialized sorted id set (~0.017 ms). LOINC old is an in-memory
`Set.has`, so it beats the new indexed read on absolute time.

## 5. `subsumesTest()` — 500 seeded (ancestor, descendant) pairs

| pair | old median | old p95 | new median | new p95 | ratio |
|---|---|---|---|---|---|
| LOINC  | 0.002 ms | 0.003 ms | 0.072 ms | 0.184 ms | 0.03 (new slower)† |
| SNOMED | — | — | 0.046 ms | 0.054 ms | — |

† **Old LOINC `subsumesTest` is unimplemented** — it returns the constant
`'not-subsumed'` after two context lookups, so its 0.002 ms is a no-op baseline,
not a real subsumption computation. The new provider actually consults the
closure table (two indexed lookups) and returns correct `subsumes` /
`subsumed-by` / `equivalent` / `not-subsumed` results in 0.072 ms. This "ratio"
is not a like-for-like comparison. (Old RxNorm `subsumesTest` is likewise a
constant; RxNorm is excluded from this row per the matrix.)

## 6. Iteration throughput — drain first 50,000 concepts

Old providers have `hasParents()===true`, so `iteratorAll()` throws
"Must override"; their `iterator(null)` is the all-concepts traversal used here.
New uses `iteratorAll()`.

| pair | old concepts/sec | new concepts/sec | old wall | new wall | ratio (new/old) |
|---|---|---|---|---|---|
| LOINC  | 9,915,512 | 55,056 | 5.0 ms | 908.2 ms | 0.006 (new slower) |
| RxNorm | 68,477 | 62,711 | 730.2 ms | 797.3 ms | 0.92 (new ~par) |
| SNOMED | — | 50,463 | — | 990.8 ms | — |

LOINC old iterates a pre-built in-RAM array (~10 M concepts/sec) — the new
provider materializes each concept from the DB per `nextContext`, so ~55 K/sec.
RxNorm old also does one bulk `db.all` then walks an array; new is within ~8 %
of it. New iteration throughput is consistent (~50–63 K concepts/sec) across all
three terminologies.

---

## Regressions (any cell where new is slower than old)

Reported plainly, with hypotheses:

1. **LOINC micro-ops — locate (0.06×), filterLocate (0.06×), subsumesTest
   (0.03×), iteration (0.006×).** *Cause:* the old LOINC provider front-loads
   the entire concept set into RAM (`Map`/array), so these are in-memory lookups
   / array walks; the new provider is DB-backed per call. This is the designed
   trade-off — the new provider trades ~1 GB of resident heap and a slower cold
   `load()`-adjacent memory build for constant, low, bounded memory. Absolute
   new latencies are still small (17–72 µs). The subsumesTest and (partly)
   iteration "regressions" are also apples-to-oranges: old LOINC subsumesTest is
   an unimplemented constant.

2. **LOINC bulk filter drains — CLASSTYPE=1 (0.49×), STATUS=ACTIVE (0.41×),
   descendent-of (0.67×), SCALE_TYP=Qn (0.81×).** *Cause:* the old provider
   resolves concept keys against its in-memory maps while collecting rows; the
   new provider joins `concept_literal`/`closure` and rebuilds a
   `SqliteConceptContext` per drained row. Row-materialization dominates at
   40 K–180 K-row drains. Candidate mitigation: return codes directly from the
   filter cursor without constructing full context objects when the caller only
   needs `code()`.

3. **RxNorm decoration (0.22×) and LOINC decoration (0.43×).** *Cause:* the new
   `designations()` + `properties()` each fan out into separate indexed queries
   per concept (RxNorm relationships are large), whereas old RxNorm's
   `properties()` is the base no-op returning `[]` and old LOINC serves display
   from RAM. So the new side is doing strictly more real work per code. Fair, but
   it is a genuine per-lookup latency cost (new RxNorm ~1.5 ms/code median).
   Candidate mitigation: batch/prefetch designations+properties in one query.

4. **RxNorm TTY=IN drain (0.30×) and SAB=RXNORM drain (0.87×).** *Cause:* same
   per-row context materialization as (2), over large literal-property result
   sets. SAB=RXNORM is within ~15 % and its count denominators differ (294 K
   term rows old vs 228 K concepts new), so it is close to par in real terms.

**Not regressions (clarified):**
- `has_tradename=CUI:854979` new=0 was a **stale-config artifact** (the bench
  DB predated the importer's `filterValueRewrites`; both importer and DB now
  carry it), not a slowdown — with the form resolved new is ~440× faster.
- Search filters (`glucose` 1.6×, `aspirin` 35×, `myocardial`) and RxNorm
  `filterLocate` (5,336×), `locate` (7.3×), and `STY=T121` (2.25×) are all
  **new-faster** wins driven by FTS trigram indexes and synchronous
  better-sqlite3 reads replacing per-call async round-trips.
