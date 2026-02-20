# CodeSystemProvider Interface: Performance Analysis and Evolution

## Background

The `CodeSystemProvider` interface (defined in `tx/cs/cs-api.js`) is the contract
between the terminology expansion/validation workers and the backing data stores
(SNOMED, LOINC, RxNorm, and future SQLite-based providers). The worker drives
expansion by calling a sequence of methods on the provider — locate codes, check
attributes, load designations — assembling the expansion result one code at a time.

This document traces how the current interface plays out for SQL-backed providers,
what we tried, what we measured, and the interface evolution we arrived at.

---

## Part 1: Current Architecture

### The Provider as Iterator + Attribute Oracle

The worker treats a provider as two things:

1. **A code source** — given a filter (e.g., `TTY = SBD`), produce matching codes
   one at a time via `filterMore()`/`filterConcept()` (or in pages via `filterPage()`).
2. **An attribute oracle** — given a code's context handle, answer individual
   questions: `isInactive(ctx)`, `getStatus(ctx)`, `designations(ctx)`, etc.

The context object returned by `locate()` or `filterConcept()` is an opaque handle.
Each provider defines its own context class:

- **SNOMED** (`SnomedExpressionContext`): Reference index into an in-memory binary
  buffer. All attribute lookups are O(1) array reads. No I/O.
- **LOINC** (`LoincProviderContext`): Carries key, code, description, status in
  memory. Designations lazy-loaded from SQLite on first access (1 query, cached).
- **RxNorm** (`RxNormConcept`): code, display, synonyms. Status/suppress required
  separate SQL queries per access (fixed in this branch — see Part 2).

### Concrete Call Trace: RxNorm Filter Expansion (Before Fixes)

Scenario: expand TTY=SBD, offset=1000, count=100, activeOnly=true.

```
WORKER → PROVIDER                          WHAT PROVIDER DOES
──────────────────────────────────────────────────────────────

Setup phase (once):
1. cs.getPrepContext(true)                  Creates empty filter context
2. cs.filter(prep, 'TTY', '=', 'SBD')      Stores SQL fragment: AND TTY = 'SBD'
3. cs.executeFilters(prep)                  Assembles query (not executed yet)

First iteration call:
4. cs.filterMore(ctx, set)                  Executes query via db.all(), loads
                                            ALL ~23k rows into memory. Returns true.

Per-code loop (repeats for EVERY matching code):
5. cs.filterConcept(ctx, set)               Creates bare RxNormConcept(code, display)
6. cs.isInactive(c)                         ** SQL query: SELECT suppress ... **
7. cs.code(c)                               In-memory read
8. cs.designations(c, displays)             In-memory
9. cs.isAbstract(c)                         In-memory (returns false)
10. cs.isInactive(c)                        ** SAME SQL query again **
11. cs.isDeprecated(c)                      In-memory (returns false)
12. cs.getStatus(c)                         ** SAME SQL query a third time **
13. cs.definition(c)                        In-memory (returns null)
14. cs.extensions(c)                        In-memory (returns null)
   → includeCode() appends to fullList

... repeats for 1100 codes ...
Code #1100: fullList.length == offset + count → throws setFinished()
→ Slices fullList[1000..1100] → response is 100 codes.
→ First 1000 codes fully processed then discarded.
```

**Cost: 3301 SQL queries** (1 filter + 1100 × 3 per-code queries).

**What a SQL provider could do:** 1 query, 0 follow-up calls:

```sql
SELECT RXCUI, STR, SUPPRESS FROM rxnconso
WHERE SAB = 'RXNORM' AND TTY = 'SBD' AND SUPPRESS <> '1'
ORDER BY RXCUI
LIMIT 100 OFFSET 1000
```

---

## Part 2: What We Fixed (No Interface Changes)

### Eager context loading in RxNorm

Added `SUPPRESS` to the `locate()` and `executeFilters()` SELECT queries. Cached
the suppress flag on `RxNormConcept`. Rewrote `isInactive()` and `getStatus()` to
read the cached field instead of re-querying.

**Result: 3301 → 1 SQL query.** 45% faster on a 1000-code expansion benchmark.

This required **zero interface changes**. The worker calls the same methods; they
just return cached data instead of hitting the DB.

**Convention:** Any provider can adopt this pattern — make contexts self-sufficient
at creation time by including all attributes the worker will ask for.

### Added ORDER BY to filter queries

The `executeFilters()` query was missing `ORDER BY`. Without it, paging results
are non-deterministic across requests — different offset/count values can return
overlapping or missing codes. Fixed by adding `ORDER BY RXCUI`.

The existing `(SAB, TTY, RXCUI)` index makes this free for TTY equality filters.

---

## Part 3: What We Explored and Rejected

### Batch APIs: locateMany, prefetchAll

We tried several approaches to batch per-code operations:

- **`locateMany` with SQL `IN(...)`**: Actually **slower** than individual prepared
  statements for SQLite. The query planner can't optimize large IN() lists as well
  as repeated index lookups with cached plans. Removed from RxNorm.
- **`prefetchAll(contexts[], needs)`**: Unnecessary — if contexts are self-sufficient
  at creation time, there's nothing to prefetch.
- **SNOMED/LOINC `locateMany`**: Just loops over `locate()` — no benefit in-process.

These batch APIs may matter in a future multi-process architecture where IPC
round-trip cost dominates. The stubs remain in cs-api.js for that reason.

### Phase 1: Incremental push-down to executeFilters

We considered adding `{ offset, count, activeOnly }` options to `executeFilters()`,
letting the provider add `LIMIT/OFFSET` and `WHERE SUPPRESS <> '1'` to its query.

**We rejected this** for several reasons:

1. **offset/count is a ValueSet-level concept, not a CodeSystem one.** The final
   expansion is assembled from multiple includes, minus excludes, minus import
   conflicts, minus duplicates. The provider only sees one filter's results. If
   you tell it `OFFSET 1000`, it skips *its* first 1000 codes — but those might
   not be the same 1000 the worker would skip after post-filters.

2. **Post-filters change the count.** Between the provider's output and the final
   result, the worker applies:
   - Exclude sets (codes removed after inclusion)
   - Import filtering (`passesImports`)
   - Deduplication (`this.map.has(s)` across code systems)
   - Text filter (`filter.passesDesignations`)
   
   Any of these can change the effective offset. The provider can't predict how many
   codes will be discarded.

3. **Partially-resolved state.** If the provider handles activeOnly but not excludes,
   the worker still has to do per-code processing for the remaining post-filters.
   The provider did some of the work, the worker does the rest, and the boundary is
   awkward — the worker has to know exactly what the provider handled.

4. **activeOnly alone is marginal.** With rich contexts (already fixed), `isInactive()`
   is a cached field read — ~0 cost. Pushing it to SQL only avoids the JS-side check,
   not any I/O.

**Bottom line:** Piecemeal push-down enters weird partially-resolved states and
doesn't provide enough benefit to justify the complexity.

---

## Part 4: SQLite Microbenchmark Results

We benchmarked the async `sqlite3` package (current) against `better-sqlite3`
(potential migration) using the RxNorm database (1.8GB, ~23k SBD codes,
~288k total non-SY codes). Full benchmark scripts in `scripts/sqlite-microbench.js`
and `scripts/sqlite-exclude-bench.js`.

### Package comparison

| Operation (23k SBD rows) | async `sqlite3` | `better-sqlite3` |
|---------------------------|-----------------|-------------------|
| Load all rows (`all()`)   | 45ms            | **20ms**          |
| Iterate all rows          | N/A (no cursor) | 30ms              |
| Break after 100 rows      | N/A             | **0.10ms**        |
| Break after 1100 rows     | N/A             | **1.05ms**        |

`better-sqlite3` is 2x faster for bulk loads and uniquely enables lazy cursors.
The async `sqlite3` package's `db.each()` cannot abort early — it always fetches
all rows regardless of how many you process in the callback.

### Paging: SQL LIMIT/OFFSET vs iterate+skip+break

Using `better-sqlite3` with `ORDER BY RXCUI` (covered by index for TTY= filters):

| offset | SQL LIMIT/OFFSET | iterate+skip+break | Ratio   |
|--------|-----------------|---------------------|---------|
| 0      | 0.09ms          | 0.12ms              | ~1x     |
| 100    | 0.07ms          | 0.19ms              | 3x      |
| 1000   | 0.09ms          | 1.1ms               | **12x** |
| 5000   | 0.23ms          | 5.8ms               | **25x** |
| 10000  | 0.38ms          | 14ms                | **37x** |
| 20000  | 0.72ms          | 28ms                | **40x** |

SQL LIMIT/OFFSET with the `(SAB, TTY, RXCUI)` index can B-tree seek to the right
position. The iterator must step through every preceding row.

**OFFSET without ORDER BY is unsafe** — SQLite can return rows in any order,
producing inconsistent pages across requests.

**ORDER BY without an appropriate index is expensive** — requires a temp B-tree
sort of all matching rows. With the inequality filter `TTY<>'SY'` (no index
support), `ORDER BY RXCUI LIMIT 100 OFFSET 0` costs 142ms vs 0.07ms with the
covering index. The index must include the ORDER BY column as a suffix.

### Multi-include strategies

| Strategy | Time (SBD+SCD, ~62k rows) |
|----------|---------------------------|
| UNION ALL | 85.6ms |
| IN ('SBD','SCD') | 85.4ms |
| Two separate queries | 85.6ms |

**All equivalent.** Unlike `locateMany` (where large IN() lists hurt), filter-style
queries with small IN sets (2-3 TTY values) work fine. The provider can freely merge
multiple includes into one query.

### Exclude strategies

Without paging (iterating all ~23k rows), exclude method barely matters — the
iteration cost dominates:

| Exclude method | Time (23k rows, 500 excludes) |
|----------------|-------------------------------|
| JS Set.has()   | 33.7ms |
| SQL NOT IN literal | 36.6ms |
| Temp table + NOT IN | 33.0ms |

**But with paging push-down, it matters enormously:**

| Approach (offset=10000, count=100, 500 excludes) | Time |
|--------------------------------------------------|------|
| Temp table + SQL LIMIT/OFFSET | **1.1ms** |
| NOT IN literal + SQL LIMIT/OFFSET | 2.2ms |
| iterate + JS Set.has + skip/break | 15.9ms |

When combined with LIMIT/OFFSET, SQL-side excludes are **15x faster** because
the index can handle the seek + exclude together. Temp table performs best because
SQLite can use an index on the temp table for the NOT IN subquery.

### JS object construction cost

| What | Time (23k rows) |
|------|-----------------|
| Count only (no objects) | 33.7ms |
| Minimal `{code, display, suppress}` | 33.7ms |
| Rich FHIR-like entry | 35.1ms |
| Rich entry + Map dedup | 43.7ms |

**Object construction is negligible** (~1.4ms for 23k rich objects). The cursor
stepping cost dominates. Map-based dedup adds ~10ms due to string concatenation
for keys.

---

## Part 5: Target Design — `expandForValueSet`

### The insight

Instead of threading individual parameters through the existing 10-call-per-code
iterator, **give each CodeSystem provider the full hull of includes and excludes
that apply to it** and let it handle everything in one shot.

The FHIR `compose` structure is flat — no nesting. Each include/exclude block has
a `system` field. The worker can trivially group them by code system:

```js
// In handleCompose, before processing:
const bySystem = new Map();  // system → { includes: [...], excludes: [...] }
for (const c of compose.include) {
  if (c.system) getOrCreate(bySystem, c.system).includes.push(c);
}
for (const c of compose.exclude) {
  if (c.system) getOrCreate(bySystem, c.system).excludes.push(c);
}
```

### The method

```js
// New optional method on CodeSystemProvider
async expandForValueSet(spec) {
  // Returns an AsyncIterable<ExpandedEntry> or null (can't handle it → fall back)
  return null;
}
```

**Input spec:**

```js
{
  includes: [                          // compose.include blocks for this CS
    { concepts: [{code, display?}],    // explicit code list (may be null)
      filters: [{property, op, value}] // property filters (may be empty)
    }, ...
  ],
  excludes: [                          // compose.exclude blocks for this CS
    { concepts: [{code}],
      filters: [{property, op, value}]
    }, ...
  ],
  activeOnly: boolean,                 // exclude inactive codes
  searchText: string | null,           // expansion 'filter' parameter
  includeDesignations: boolean,        // whether designations are needed
  properties: string[],                // which properties to include
  languages: Languages,                // requested display languages

  // Paging hints — safe to apply OR ignore (see below)
  offsetHint: number | null,
  countHint: number | null,
}
```

**Output:** `AsyncIterable<ExpandedEntry>` where each entry is:

```js
{
  code: string,
  display: string,
  isAbstract: boolean,
  isInactive: boolean,
  isDeprecated: boolean,
  status: string | null,
  definition: string | null,
  designations: [{language, use, value}],
  properties: [{code, valueType, value}],
  extensions: [...] | null,
}
```

The worker iterates these entries and feeds them to `includeCode()`, which still
handles dedup across code systems, import filtering, expansion limits, paging,
and FHIR object construction.

### Why paging hints are safe

The hints `offsetHint` and `countHint` are always **safe to apply or ignore**,
provided the result set has a stable total order (which it must for correct paging
regardless):

- **Best case** (single CS, no cross-system dedup/imports): hints are exact. The
  provider returns exactly the right page via `LIMIT/OFFSET`. The worker iterates
  100 rows instead of 20000+.

- **Worst case** (multi-CS, post-filters discard some codes): the provider's OFFSET
  skips too many or too few codes. But the worker's own `includeCode()` →
  `fullList` → `setFinished()` is the final authority. If the provider returned too
  few (because post-filters didn't discard any after all), the worker would ask for
  more — this is handled by the iterable: the worker simply keeps pulling.

**The hints can produce wrong page boundaries but never wrong results.** The worker's
dedup/exclude/paging logic is authoritative. The hints just let the provider skip
work that will probably be discarded.

In practice, the common case (single CS, no excludes, no imports) is exact, and the
benchmarks show a 40x speedup at offset=20000.

### Why the provider gets excludes too

Earlier we benchmarked SQL-side excludes vs JS-side Set.has() filtering. When
iterating all rows, JS filtering is slightly faster. But when combined with
LIMIT/OFFSET push-down, SQL-side excludes are **15x faster** (1.1ms vs 15.9ms
at offset=10000) because the B-tree index handles the seek + exclude together.

Since paging hints work best when the provider has handled excludes (fewer
discarded codes = more accurate hints), the provider should see both includes
and excludes. The temp table approach works well: load exclude codes once per
request, use them in `NOT IN (SELECT ...)` subqueries.

### Fallback protocol

1. Worker calls `cs.expandForValueSet(spec)`. Provider returns null or an iterable.
2. If **null**: worker falls back to the current iterator-oracle pattern unchanged.
   SNOMED, LOINC, and any provider that doesn't implement this method are unaffected.
3. If **iterable**: worker iterates entries, calling `includeCode()` for each. The
   worker still handles dedup, imports, paging, FHIR construction.
4. If the iterable is exhausted before the worker has enough codes (because paging
   hints caused the provider to return too few), the worker can:
   - Request another batch (provider exposes a continuation method), or
   - Fall back to the iterator-oracle pattern for remaining codes.

### What this enables for RxNorm with `better-sqlite3`

With `better-sqlite3` (lazy cursors, 2x faster bulk loads), the RxNorm provider
can implement `expandForValueSet` as:

```js
async *expandForValueSet(spec) {
  // 1. Load exclude codes into temp table (once)
  // 2. Build SQL from includes' filters: WHERE TTY IN ('SBD','SCD') ...
  // 3. Add activeOnly: AND SUPPRESS <> '1'
  // 4. Add searchText: AND STR LIKE '%...'
  // 5. Add exclude: AND RXCUI NOT IN (SELECT rxcui FROM exclude_temp)
  // 6. Add ORDER BY RXCUI
  // 7. Add LIMIT/OFFSET from hints
  // 8. stmt.iterate() → yield entries
  
  for (const row of stmt.iterate(...params)) {
    yield {
      code: row.RXCUI,
      display: row.STR,
      isInactive: row.SUPPRESS === '1',
      status: row.SUPPRESS === '1' ? 'inactive' : 'active',
      isAbstract: false,
      isDeprecated: false,
      definition: null,
      designations: [{ language: 'en', value: row.STR }],
      properties: [],
      extensions: null,
    };
  }
}
```

**Benchmark expectations (offset=10000, count=100, TTY=SBD, 500 excludes):**

| Approach | Time |
|----------|------|
| Current (iterate all + per-code SQL) | ~150ms+ |
| Eager contexts (this branch, no paging) | ~14ms |
| expandForValueSet with LIMIT/OFFSET | **~1ms** |

### Package migration: `better-sqlite3`

The benchmarks strongly favor migrating SQL-backed providers to `better-sqlite3`:

| Feature | async `sqlite3` | `better-sqlite3` |
|---------|-----------------|-------------------|
| Bulk load speed | 45ms / 23k rows | **20ms** |
| Lazy cursor | ❌ (`db.each` can't abort) | ✅ (`stmt.iterate()` + break) |
| Prepared statement reuse | Manual | Automatic |
| Sync API | ❌ (callback hell) | ✅ |
| LIMIT/OFFSET + break | N/A | ~0.1ms for 100 rows |

The sync API is actually an advantage in this codebase — the provider methods are
already `async` but the underlying SQLite operations are synchronous (single-writer,
single-threaded, in-process). The async `sqlite3` package adds callback/promise
overhead for no benefit.

Migration path: introduce `better-sqlite3` as a dependency, use it in new provider
code (`expandForValueSet`), migrate existing query methods incrementally.

---

## Summary

| Issue | Impact | Fix | Status |
|-------|--------|-----|--------|
| Redundant per-code SQL | 3x overhead (3301 queries) | Eager context loading | ✅ Done |
| Missing ORDER BY on filters | Non-deterministic paging | Add `ORDER BY RXCUI` | ✅ Done |
| Thin filter contexts | Follow-up queries | Add columns to filter SELECT | ✅ Done |
| Batch locate (`locateMany`) | Mixed — worse for SQL | Keep stub, don't force | ✅ Evaluated |
| No paging push-down | Process N to return M | `expandForValueSet` with hints | 🎯 Target |
| No activeOnly push-down | Per-code check | `expandForValueSet` spec | 🎯 Target |
| No exclude push-down | JS-side filtering | `expandForValueSet` spec | 🎯 Target |
| async `sqlite3` limitations | No lazy cursors, 2x slower | Migrate to `better-sqlite3` | 🎯 Target |
| Phase 1 (incremental push-down) | Unsafe / partial state | Rejected | ❌ Rejected |
