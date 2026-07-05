# sqlite-v1 SQL profile — where the generated SQL works and where it breaks down

Profiling of the raw SQL that `tx/cs/cs-sqlite.js` generates, run against the
**large real vocabularies** on the `sqlite-v1` branch:

| DB | system | concepts | closure rows | link rows | literal rows |
|---|---|--:|--:|--:|--:|
| `sct-v1.db` | SNOMED CT US 20260301 | 537,781 | 7,774,767 | 3,614,587 | 2,188,456 |
| `loinc-v1.db` | LOINC 2.82 | 252,207 | 1,146,563 | 962,477 | 1,432,573 |
| `rxnorm-v1.db` | RxNorm 05042026 | 228,626 | 0 (no hierarchy) | 1,672,546 | 1,050,462 |

Harness: `scripts/sqlite-v1-profile/profile-sql.mjs` (read-only, own connections
with the provider's pragmas). Machine-readable output:
`scripts/sqlite-v1-profile/results.json` (78 records). For each shape it captures
the exact SQL + params reconstructed from the provider templates, `EXPLAIN QUERY
PLAN`, adaptive wall-clock median (warmup + N iters), rows, and a SCAN/SEARCH/
temp-b-tree verdict; it also drives the provider terminals (`executeIR`,
`processSelection`) for the true end-to-end JS path. Numbers are medians on a
warm page cache; treat them as *relative* signal, not absolute SLAs.

---

## 1. Headline synthesis

**The schema is well-indexed. There is not a single un-indexed base-table scan in
the entire matrix** — every table access is a `SEARCH … USING INDEX`, a
`USING COVERING INDEX`, an integer-primary-key probe, or an FTS `VIRTUAL TABLE
INDEX`. (The `SCAN` tokens the parser flags are all either a 1-row `SCAN CONSTANT
ROW` from the `UNION SELECT ? AS id` in `is-a`/`generalizes`, or `SCAN s` /
`SCAN (subquery-N)` co-routine nodes that materialize a compound `INTERSECT`/
`UNION` result — inherent to the operation, not table scans.)

So cost does **not** come from missing indexes. It comes from three things:

1. **`USE TEMP B-TREE` sorts** — `SELECT DISTINCT … ORDER BY id` and
   `ORDER BY concept_id` clauses that the index order does not satisfy, forcing a
   full sort of the *entire* candidate set before any `LIMIT` applies.
2. **Full-partition covering scans** — literal `=`/`in`/`exists` filters seek the
   index on `(property_id, active)` but **cannot push the value into the index**,
   so they read every row of the property partition and post-filter in memory.
3. **JS full-array materialization** — every filter clause, multi-clause set
   operation, `activeOnly` page, regex, and whole-system iteration pulls the
   complete sorted `concept_id[]` into JavaScript.

### Where it works (fast, index-bound, LIMIT-friendly)
- **`descendent-of` at any subtree size** — the star of the schema. The
  `closure` `WITHOUT ROWID` PK `(ancestor_id, descendant_id)` makes
  `WHERE ancestor_id=? ORDER BY id` a pure covering range scan with **no sort**
  (`SEARCH closure USING PRIMARY KEY`). 132k rows in ~52 ms, and that is just JS
  row marshalling; `COUNT(*)` of the same is **3.7 ms**.
- **`child-of`, `generalizes`, `is-a`** — same closure/edge indexes; `is-a`'s
  extra `UNION SELECT ?` is a cheap 1-row `MERGE (UNION)`, timing indistinguishable
  from `descendent-of`.
- **Refset `in`** — `SEARCH value_set_member USING INDEX idx_vsm_unique (vs_id=?)`;
  the 21,400-member refset in 9.9 ms.
- **FTS trigram search** — `SCAN sf VIRTUAL TABLE INDEX` is the fast trigram path.
  "heart" over 537k SNOMED displays = 2.9 ms; the 3-table designation join = 10 ms.
  This is the healthiest search path in the system.
- **Selective concept-valued property `=`** — `has_ingredient=<x>` 0.5 ms,
  `COMPONENT=<x>` 0.6 ms, SNOMED finding-site `=` 4 ms. The
  `idx_concept_link_prop_active_target` covering index does the work.

### Where it breaks down
- **Literal `=`/`in` — the value is never pushed into the index.** The template
  ORs two NOCASE columns: `(value_text IN (…) COLLATE NOCASE OR value_raw IN (…)
  COLLATE NOCASE)`. That OR defeats *both* value indexes, so SQLite seeks only on
  `(property_id, active)` and **scans the whole property partition**, then adds a
  `USE TEMP B-TREE FOR DISTINCT`. Cost scales with **partition size, not
  selectivity**: RxNorm `TTY=SCD` (17k hits) still reads all 189k TTY rows → 78 ms;
  LOINC `CLASSTYPE=3` (1,161 hits) reads all 109k → 75 ms.
- **`regex` on a literal property is pathological by construction.**
  `_literalRegexIds` fetches **every** candidate row of the partition into JS and
  runs `RegExp.test` on each. LOINC `RELATEDNAMES2 ~ /sodium/` returns 42 rows but
  fetches 109,325 (269 ms); `STATUS ~ /ACT/` fetches 183,412 (301 ms). No index,
  no LIMIT, cost = O(partition).
- **`exists` / `NOT EXISTS` over near-whole-system properties.** `exists moduleId`
  sorts 386k distinct sources (261 ms). `NOT EXISTS finding-site` is the slowest
  shape in the whole matrix (**402 ms**): full `concept` covering scan + bloom-
  filtered `NOT IN` subquery + `USE TEMP B-TREE FOR ORDER BY` over 445,952 rows.
- **Paging never early-stops in any non-trivial path.** Even the "fast" IR page
  (`_tryFastPage`) wraps the closure source in `… JOIN concept c … ORDER BY
  c.concept_id LIMIT 100`, and that outer `ORDER BY` triggers `USE TEMP B-TREE FOR
  ORDER BY` over the **full** 132k set before the LIMIT — 22 ms to return 100 rows,
  vs 0.1 ms if the LIMIT is pushed down (see §4).
- **`<3`-char search falls back to `%term%` LIKE** — a covering scan of every
  display in the system (82k/537k match, 78 ms), O(concept count), no LIMIT.
- **Whole-system materializations** — `all concept_ids ORDER BY concept_id`
  (314 ms for 537k) and `is-a`/`descendent-of` of the root (~185 ms for 386k).

---

## 2. Results by category

Verdict legend: `SEARCH(index)` = index/covering seek or scan; `+TEMP-BTREE` = a
`USE TEMP B-TREE` sort of the candidate set; `JS` = provider materializes arrays
and does the set op / regex / slice in JavaScript.

### Hierarchy (SNOMED + LOINC `descendent-of` / `is-a` across subtree sizes)
| db | query | ms | rows | plan |
|---|---|--:|--:|---|
| sct | descendent-of ~10 / ~100 / ~1k | 0.0–0.2 | 10–1000 | SEARCH(index) |
| sct | descendent-of ~10k | 3.1 | 10,006 | SEARCH(index) |
| sct | descendent-of Clinical finding | 51.6 | 132,172 | SEARCH(index) |
| sct | descendent-of ROOT | 184.0 | 386,109 | SEARCH(index) |
| sct | is-a Clinical finding (UNION+sort) | 46.3 | 132,173 | SEARCH(index), 1-row MERGE |
| sct | child-of Clinical finding | 0.1 | 221 | SEARCH(index) |
| sct | generalizes deep leaf (ancestors) | 0.0 | 11 | SEARCH(index) |
| loinc | descendent-of ~10k / 181k | 2.3 / 62.9 | 10,278 / 181,430 | SEARCH(index) |

**Verdict: works well.** Linear in subtree size, index-only, no sort. `COUNT` is
sub-4 ms even for 132k. The only cost above ~50 ms is legitimately returning
100k+ rows into JS.

### Paging (fast-path page + count, small vs deep offset)
| db | query | ms | rows | plan |
|---|---|--:|--:|---|
| sct | fast page LIMIT 100 OFFSET 0 | 22.0 | 100 | SEARCH(index) **+TEMP-BTREE** |
| sct | fast page LIMIT 100 OFFSET 130000 | 56.0 | 100 | SEARCH(index) **+TEMP-BTREE** |
| sct | fast COUNT(*) | 3.7 | 132,172 | SEARCH(index) |
| sct | fast page + total (two queries) | 25.5 | — | SEARCH(index) **+TEMP-BTREE** |

**Verdict: the "fast path" is not fast for the first page.** The outer
`ORDER BY c.concept_id` forces a temp-b-tree sort of all 132k rows regardless of
LIMIT (the code comment *"ORDER BY concept_id lets SQLite early-stop"* is **not
true** for a closure source — the optimizer cannot see that `s.id` is already
sorted). COUNT is cheap; the page is not. Deep offset adds only the cost of
walking the extra output rows on top of the fixed full sort.

### Property filters
| db | query | ms | rows | plan |
|---|---|--:|--:|---|
| sct | finding-site `=` (concept, 1 target) | 4.1 | 3,577 | SEARCH(index) +TEMP-BTREE |
| sct | finding-site `IN` (50 targets) | 31.0 | 24,028 | SEARCH(index) +TEMP-BTREE |
| sct | exists finding-site (concept) | 78.6 | 91,829 | SEARCH(index) +TEMP-BTREE |
| sct | **moduleId `=` (literal, 377k hits)** | **345.5** | 376,649 | SEARCH(index) +TEMP-BTREE |
| sct | exists moduleId (literal) | 260.9 | 386,110 | SEARCH(index) +TEMP-BTREE |
| loinc | CLASSTYPE `=` 1 (literal) | 108.0 | 66,861 | SEARCH(index) +TEMP-BTREE |
| loinc | STATUS `=` ACTIVE (literal) | 171.6 | 170,391 | SEARCH(index) +TEMP-BTREE |
| loinc | SCALE_TYP `=` Qn (code-or-display) | 51.3 | 43,658 | SEARCH(index) |
| loinc | COMPONENT `=` <top> (concept) | 0.6 | 892 | SEARCH(index) +TEMP-BTREE |
| rxnorm | **TTY `=` SCD (literal, 17k hits)** | **74.4** | 17,547 | SEARCH(index) +TEMP-BTREE |
| rxnorm | STY `=` T200 (literal) | 145.2 | 192,492 | SEARCH(index) +TEMP-BTREE |
| rxnorm | exists STY (literal) | 151.6 | 228,626 | SEARCH(index) +TEMP-BTREE |
| rxnorm | has_ingredient `=` <top> (concept) | 0.5 | 983 | SEARCH(index) +TEMP-BTREE |

**Verdict: concept-valued property filters are fast; literal property filters are
not, and the cost is independent of selectivity** (see §5 opportunity #1). The
LOINC `conceptFilterMatch = code-or-display` display-join leg (`display = 'Qn'`)
is a clean 17 ms indexed lookup — not a problem.

### Regex (literal, `_literalRegexIds`)
| db | query | ms | rows | note |
|---|---|--:|--:|---|
| loinc | RELATEDNAMES2 ~ /sodium/ | 268.6 | 42 | fetches **109,325** rows into JS |
| loinc |  ↳ candidate fetch (SQL only) | 233.0 | 109,325 | the SQL portion alone |
| loinc | STATUS ~ /ACT/ | 301.3 | 170,391 | fetches **183,412** rows into JS |

**Verdict: worst shape class.** Unindexed, unbounded, and JS-bound. The RegExp
loop itself is cheap (~35 ms over 109k); the killer is fetching the whole
partition. Returns 42 rows after touching 109,325.

### Text search — FTS trigram (healthy) and the LIKE fallback (not)
| db | query | ms | rows | plan |
|---|---|--:|--:|---|
| sct | FTS display "heart" | 2.9 | 1,926 | SEARCH(index) |
| sct | FTS display "diabetes mellitus" | 6.6 | 801 | SEARCH(index) |
| sct | FTS designation "heart" (3-table join) | 10.0 | 6,705 | SEARCH(index) |
| sct | `_searchIds("heart")` 3 sources + JS Set | 14.4 | 2,404 | SEARCH(index) |
| loinc/rxnorm | FTS "glucose"/"sodium"/"aspirin" | 0.9–4.7 | 305–1,821 | SEARCH(index) |
| sct | **LIKE display `%ca%` (<3-char fallback)** | **78.2** | 82,356 | SEARCH(index) (full covering scan) |

**Verdict: FTS is excellent** across all selectivities and all three DBs. The only
weak spot is the sub-3-char LIKE fallback, which reads every display.

### Refset membership
| db | query | ms | rows | plan |
|---|---|--:|--:|---|
| sct | in refset 723264001 | 9.9 | 21,400 | SEARCH(index) |

**Verdict: works well.**

### Set algebra — provider JS path vs single-statement SQL
| db | operation | provider (SQL×N + JS) | single-SQL full set | single-SQL + LIMIT 100 |
|---|---|--:|--:|--:|
| sct | INTERSECT finding ∩ disease (out 94,701) | **68.3** | 84.5 | 71.5 |
| sct | DIFF finding \ disease (out 37,471) | **68.3** | 47.3 | 47.9 |
| sct | UNION proc ∪ body ∪ subst (out 133,914) | **45.7** | 65.7 | 53.2 |
| loinc | CLASSTYPE=1 ∩ SCALE_TYP=Qn (out 34,646) | 162.6 | — (mixed literal/concept, not expressible) | — |
| rxnorm | TTY=SCD ∩ STY=T200 (out 17,547) | 216.8 | 192.8 | 191.7 |

Per-clause breakdown (provider path), median ms:

| operation | fetch A | fetch B | **JS set op** |
|---|--:|--:|--:|
| sct INTERSECT (132k ∩ ~90k) | 37.3 | 35.2 | **1.7** |
| sct DIFF | 37.3 | 34.2 | **1.0** |
| sct UNION (three closures) | — | — | **7.6** |
| loinc literal ∩ concept | 108.8 | 51.6 | **0.6** |
| rxnorm literal ∩ literal | 81.0 | 139.1 | **0.4** |

**Verdict: this is the surprising result.** See §3.

### IR terminals — fast path vs forced-slow (`activeOnly`)
| db | terminal | ms | note |
|---|---|--:|---|
| sct | executeIR fast page LIMIT 100 | 26.4 | `_tryFastPage` (page SQL + COUNT SQL) |
| sct | executeIR **slow** page (`activeOnly`) | 48.2 | `_evalIR` materializes 132k + active-set filter + slice |
| loinc | executeIR fast page LIMIT 100 | 22.3 | fast source |
| loinc | executeIR **slow** page (`activeOnly`) | 71.5 | materializes 181k, then slices to 100 |

**Verdict: `activeOnly` (and any multi-clause) defeats the LIMIT pushdown** and
falls back to full materialization — 1.8×–3.2× slower to return the same 100 rows.

### Pathological / whole-system
| db | query | ms | rows | why |
|---|---|--:|--:|---|
| sct | NOT EXISTS finding-site | 402.2 | 445,952 | full concept scan + bloom NOT IN + sort |
| sct | all concept_ids ORDER BY | 313.8 | 537,781 | whole-system sort into JS |
| sct | is-a ROOT (whole system) | 188.3 | 386,110 | returns the whole hierarchy |
| rxnorm | NOT EXISTS STY | 117.3 | 0 | full concept scan + anti-join + sort |

---

## 3. The JS set-algebra materialization tax (the "perf left on the table")

The task framed the JS-materialization path as *"where the thin port likely leaves
perf on the table vs a single all-SQL statement."* The data says something more
precise, and partly counter-intuitive:

**The JS merge itself is essentially free. The tax is upstream, and a single
all-SQL statement does not recover it.**

- `intersectSorted` / `diffSorted` / `unionSorted` over 90k–130k-element arrays
  cost **0.4–7.6 ms** — a rounding error next to the per-clause SQL.
- For the closure-based SNOMED ops, the provider's SQL×N + JS path is at parity
  with or **faster than** a hand-written single `INTERSECT`/`EXCEPT`/`UNION`
  statement (68 vs 71–84 ms intersect; 46 vs 53–66 ms union). Reason: each clause
  is an index-ordered closure scan, so the JS is a linear merge of two already-
  sorted streams, whereas SQL's compound operator builds its own `INTERSECT USING
  TEMP B-TREE` **plus** a `USE TEMP B-TREE FOR ORDER BY` for the page.
- **`LIMIT` buys the single-SQL page almost nothing** (sct: 71.5 vs 84.5 full;
  rxnorm: 191.7 vs 192.8 full), because paging still needs `ORDER BY concept_id`,
  which forces the full temp-b-tree sort before the LIMIT — the same wall the
  fast-path page hits.

**So the measurable "materialization tax" of the JS path over all-SQL is:**
- SNOMED closure intersect/union: **negative** (provider is ~15–20% faster).
- RxNorm literal ∩ literal: **+24 ms (~13%)** — the one case where pulling two
  large literal arrays (17k + 192k) fully into JS costs more than an all-SQL
  `INTERSECT` that streams. This is the real, if modest, tax.
- LOINC literal ∩ concept: **not expressible as one SQL statement at all** with
  the current code-or-display concept resolution, so there is no single-SQL
  baseline — the JS path is the only option.

**The genuine waste is not JS-vs-SQL; it is that the non-fast paths materialize the
FULL set for every clause even to return a 100-row page.** Concretely:
- A 2-clause intersect that returns a 100-row page does 68 ms (SNOMED) / 217 ms
  (RxNorm) of work, **all of it** producing complete clause sets and sorting —
  none of it bounded by the page size.
- The `activeOnly` flag alone converts the 26 ms fast page into a 48 ms full
  materialize (§ IR terminals). Any second clause does the same.
- The upstream cost for RxNorm/LOINC intersects is dominated by the **literal
  filter SQL** (§5 #1), not the set op — fix that and the intersect drops with it.

---

## 4. Which shapes are unindexed / full scans

**None are un-indexed base-table scans.** Reclassified honestly:

| symptom | shapes | root cause |
|---|---|---|
| `USE TEMP B-TREE FOR DISTINCT` | every literal & concept property `=`/`in`/`exists` | `SELECT DISTINCT` where index order (…, target, source) ≠ source order |
| `USE TEMP B-TREE FOR ORDER BY` | every paged JOIN, `NOT EXISTS`, whole-system list | outer `ORDER BY concept_id` not served by any post-JOIN index |
| full-partition covering scan | literal `=`/`in`/`exists`/`regex` | value not pushed into the value index (§5 #1) |
| covering scan of all displays | `<3`-char LIKE fallback | substring `%x%` is not sargable |
| `SCAN CONSTANT ROW` (harmless) | `is-a`, `generalizes` | the `UNION SELECT ? AS id` literal row |
| `SCAN s` / `SCAN (subquery)` (inherent) | single-SQL `INTERSECT`/`UNION` | co-routine materialization of the compound |

---

## 5. Governor-relevant runaway shapes

Shapes whose cost is **not bounded by any `count`/`LIMIT`** — the expensive work
happens before the page is taken. A resource governor must catch these by
estimated result/partition size, not trust the page size.

| # | shape | example | ms | why it runs long |
|--:|---|---|--:|---|
| 1 | **literal `regex`** | LOINC `RELATEDNAMES2 ~ /…/` | 269–301 | **JS blowup**: fetches the ENTIRE property partition into JS, `RegExp.test` each; returns 42 of 109,325. O(partition), no index, no LIMIT. |
| 2 | **`NOT EXISTS` over whole system** | SNOMED `finding-site exists=false` | 402 | full `concept` covering scan + bloom `NOT IN` + temp-b-tree sort of 445k. O(system). |
| 3 | **low-selectivity literal `=`/`in`** | LOINC `STATUS=ACTIVE`; SNOMED `moduleId=…` | 172–346 | full-partition covering scan (value not indexed) + DISTINCT sort. Cost = partition size regardless of hits. |
| 4 | **`exists` on near-whole-system property** | RxNorm `exists STY`; SNOMED `exists moduleId` | 152–261 | DISTINCT temp-b-tree over the whole partition. |
| 5 | **multi-clause set algebra / `activeOnly` page** | any 2-clause intersect; `activeOnly` expansion | 48–217 | materializes EVERY clause's full array + JS/SQL sort; page size is ignored. |
| 6 | **`is-a`/`descendent-of` of a huge subtree via the filter/IR-eval path** | is-a ROOT; descendent-of finding when NOT the single-selector fast path | 46–188 | full `concept_id[]` into JS (`_evalIR`/filter protocol) with no LIMIT pushdown. |
| 7 | **`<3`-char search (LIKE fallback)** | search "ca" | 78 | covering scan of every display, substring test. O(concept count). |
| 8 | **whole-system iteration** | `iteratorAll` / `allConceptIds` | 314 | sorts all 537k ids into JS. |
| 9 | **deep `OFFSET` paging** | LIMIT 100 OFFSET 130000 | 56 | fixed full temp-b-tree sort + walk O(offset) output rows. |

Governor signals available cheaply *before* running the heavy statement:
`COUNT(*)` of a closure source is 3.7 ms (bounded); property-partition size is a
single indexed `COUNT`; regex/`NOT EXISTS`/`<3`-char are statically detectable
shape flags.

---

## 6. Ranked improvement opportunities

**#1 — Push the literal value into the index (biggest, broadest win).**
The template `(value_text IN (…) COLLATE NOCASE OR value_raw IN (…) COLLATE NOCASE)`
defeats both value indexes. Rewriting a single-value/`IN` filter as a **UNION of
two index-seekable legs**
```sql
SELECT source_concept_id FROM concept_literal
  WHERE property_id=? AND active=1 AND value_text IN (…) COLLATE NOCASE
UNION
SELECT source_concept_id FROM concept_literal
  WHERE property_id=? AND active=1 AND value_raw  IN (…) COLLATE NOCASE
```
lets each leg use its covering index `(property_id, active, value_* , source)`.
Measured on the real DBs (single-column form):

| filter | current | rewritten | speedup |
|---|--:|--:|--:|
| RxNorm `TTY=SCD` (17k of 189k) | 78.5 ms | **5.5 ms** | 14× |
| LOINC `CLASSTYPE=3` (1,161) | 75.5 ms | **0.4 ms** | ~190× |
| LOINC `CLASSTYPE=1` (66,861) | 102.2 ms | **21.4 ms** | 5× |

The covering seek also eliminates the `DISTINCT` temp-b-tree. This is the single
highest-leverage change: it collapses opportunity-class #3/#4 and the upstream
cost of every literal-clause set operation (RxNorm/LOINC intersects).

**#2 — Push `LIMIT` into the ordered fast-path source (huge paging win).**
The fast page's outer `ORDER BY c.concept_id` hides that the closure PK scan
already yields `descendant_id` (= `concept_id`) ascending. Ordering the source and
pushing the LIMIT inward:
```sql
SELECT c.code, c.display, c.active
  FROM (SELECT descendant_id AS id FROM closure WHERE ancestor_id=?
        ORDER BY descendant_id LIMIT :count OFFSET :offset) s
  JOIN concept c ON c.concept_id = s.id
 ORDER BY s.id
```
turns the first-page cost from a full 132k sort into an index early-stop:

| | current | pushed-down LIMIT |
|---|--:|--:|
| descendent-of finding, LIMIT 100 OFFSET 0 | 22.1 ms | **0.1 ms** |

(~220×). Applies to both fast sources — `closure` and `value_set_member` both
emit `concept_id`-ordered ids. Deep offset becomes O(offset) index-walk instead of
a fixed full sort.

**#3 — Give `exists`/property filters a source-ordered index to drop the DISTINCT
sort.** An index `(property_id, active, source_concept_id)` on `concept_link` and
`concept_literal` makes `SELECT DISTINCT source … ORDER BY id` a de-duped ordered
covering scan (no temp-b-tree). Removes the sort from `exists` (78–261 ms class)
and from concept-valued `=`/`in`.

**#4 — Bound `regex` before materializing.** Either (a) statically extract a
required literal substring from the pattern and pre-filter via FTS/`LIKE` (or the
value index) before the JS RegExp, or (b) governor-cap candidate count. Today it
is unconditionally O(partition).

**#5 — Push page bound through multi-clause set algebra where the ordering
contract allows.** The JS merge is free; the waste is materializing full clauses
to emit a small page. For the count-less first page under a relaxed ordering, an
all-SQL `INTERSECT … LIMIT` (or streaming k-way merge with early-stop) avoids
building both full arrays. Lower priority than #1 — for closure clauses the JS
path is already at/above parity, and #1 removes most of the literal-clause cost.

**#6 — `activeOnly` should not disable the fast path.** Fold an `active=1`
predicate into the fast-source SQL (or pre-compute an active-flag column on the
closure/candidate join) so `activeOnly` keeps LIMIT pushdown instead of routing to
full `_evalIR` materialization (26 ms → 48 ms today).

**#7 — Whole-system / `NOT EXISTS` / `<3`-char are governor territory**, not
query-tuning territory: cap by system size and reject/stream rather than sort
hundreds of thousands of ids into JS.

---

## 7. Reproduce

```bash
node scripts/sqlite-v1-profile/profile-sql.mjs            # full run (~3–4 min), writes results.json
node scripts/sqlite-v1-profile/profile-sql.mjs --quick    # 1 iter per shape, fast sanity
```
Requires `~/work/tx-dbs/{sct,loinc,rxnorm}-v1.db`. Read-only; no existing files are
modified. Single-query soft timeout 30 s (recorded, never hangs — nothing in the
matrix approached it; slowest shape 402 ms).
