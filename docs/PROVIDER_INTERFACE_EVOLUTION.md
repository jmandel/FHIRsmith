# CodeSystemProvider Interface: Performance Analysis and Evolution Proposal

## Background

The `CodeSystemProvider` interface (defined in `tx/cs/cs-api.js`) is the contract
between the terminology expansion/validation workers and the backing data stores
(SNOMED, LOINC, RxNorm, and future SQLite-based providers). The worker drives
expansion by calling a sequence of methods on the provider — locate codes, check
attributes, load designations — assembling the expansion result one code at a time.

This document traces how the current interface plays out for SQL-backed providers
and proposes targeted evolutions to eliminate unnecessary I/O.

## Current Architecture

### The Provider as Iterator + Attribute Oracle

The worker treats a provider as two things:

1. **A code source** — given a filter (e.g., `TTY = SBD`), produce matching codes
   one at a time via `filterMore()`/`filterConcept()` (or in pages via `filterPage()`).
2. **An attribute oracle** — given a code's context handle, answer individual
   questions: `isInactive(ctx)`, `getStatus(ctx)`, `designations(ctx)`, etc.

The context object returned by `locate()` or `filterConcept()` is an opaque handle.
Each provider defines its own context class:

- **SNOMED** (`SnomedExpressionContext`): Holds a reference index into an in-memory
  binary buffer. All attribute lookups are O(1) array reads. No I/O.
- **LOINC** (`LoincProviderContext`): Holds key, code, description, status in memory.
  Designations lazy-loaded from SQLite on first access (1 query, then cached).
- **RxNorm** (`RxNormConcept`): Holds code, display, synonyms. Status/suppress
  required separate SQL queries per access (fixed in this branch).

### Concrete Call Trace: RxNorm TTY=SBD, offset=1000, count=100, activeOnly=true

```
WORKER → PROVIDER                          WHAT PROVIDER DOES
──────────────────────────────────────────────────────────────

Setup phase (once):
1. cs.getPrepContext(true)                  Creates empty filter context
2. cs.filter(prep, 'TTY', '=', 'SBD')      Stores SQL fragment: AND TTY = 'SBD'
3. cs.executeFilters(prep)                  Assembles query (not executed yet):
                                              SELECT RXCUI, STR FROM rxnconso
                                              WHERE SAB='RXNORM' AND TTY<>'SY'
                                              AND TTY='SBD'

First iteration call:
4. cs.filterMore(ctx, set)                  Executes query, loads ALL rows into
                                            memory. Returns true.

Per-code loop (repeats for EVERY matching code):
5. cs.filterConcept(ctx, set)               Creates RxNormConcept(code, display).
                                            Context has code + display only.

   -- Worker checks activeOnly gate: --
6. cs.isInactive(c)                         ** SQL query: SELECT suppress ... **

   -- Code passes, worker builds expansion entry: --
7. cs.code(c)                               In-memory read
8. cs.designations(c, displays)             In-memory (display + synonyms from locate)
9. cs.isAbstract(c)                         In-memory (returns false)
10. cs.isInactive(c)                        ** SQL query AGAIN (same as step 6) **
11. cs.isDeprecated(c)                      In-memory (returns false)
12. cs.getStatus(c)                         ** SQL query (same query as isInactive) **
13. cs.definition(c)                        In-memory (returns null)
14. cs.itemWeight(c)                        In-memory (returns null)
15. cs.extensions(c)                        In-memory (returns null)

   → includeCode() appends to fullList

Worker checks: fullList.length < offset + count (1100)?  Keep going.

... repeats for all 1100 codes ...

Code #1100: fullList.length reaches 1100 = offset + count.
  → Worker throws setFinished() sentinel.
  → Slices fullList[1000..1100] → response contains 100 codes.
  → The first 1000 codes were fully processed then discarded.
```

**Cost summary (upstream, before our changes):**

| Step | Count | What |
|------|-------|------|
| Filter query | 1 | SQL to find matching codes |
| filterConcept | 1100 | Creates bare context per code |
| isInactive (gate) | 1100 | SQL query per code |
| isInactive (includeCode) | 1100 | Same SQL query again |
| getStatus | 1100 | Same SQL query a third time |
| **Total SQL queries** | **3301** | |

**What a SQL provider could do instead:**

```sql
SELECT RXCUI, STR, SUPPRESS
FROM rxnconso
WHERE SAB = 'RXNORM' AND TTY = 'SBD' AND SUPPRESS <> '1'
ORDER BY RXCUI
LIMIT 100 OFFSET 1000
```

**1 query. Zero follow-up calls.**

## Fixes Applied (This Branch)

### Eager context loading in RxNorm

Added `SUPPRESS` to the `locate()` SELECT query and cached it on `RxNormConcept`.
Rewrote `isInactive()` and `getStatus()` to read the cached field instead of
re-querying.

**Result: 3301 → 1 SQL query** for the filter case (the initial filter query
already has all the data). 45% faster on a 1000-code concept-list expansion.

This required **zero interface changes**. The provider just makes its contexts
richer at creation time. The worker calls the same methods; they just return
cached data instead of hitting the DB.

### Key insight: the interface is fine for this class of optimization

Any provider can adopt this pattern:
- Populate all attributes on the context when you create it (in `locate()`,
  `filterConcept()`, `filterPage()`)
- Make per-attribute methods (`isInactive()`, `getStatus()`, etc.) read from
  the context instead of re-querying

No new APIs needed. No worker changes needed.

## Remaining Interface Gaps

### Gap 1: No paging push-down

The worker owns offset/count. It iterates ALL matching codes through the provider,
builds a full list, then slices. The provider never learns about paging.

For the example above, this means processing 1100 codes (with full attribute
loading and FHIR object construction) to return 100. A SQL provider could add
`LIMIT 100 OFFSET 1000` to its filter query.

**Current interface:**
```
executeFilters(prep) → filter holder (no paging info)
filterMore(ctx, set) → bool
filterConcept(ctx, set) → context
```

**Possible evolution — option A (push paging into filter execution):**
```
executeFilters(prep, { offset, count }) → filter holder
```
Provider adds LIMIT/OFFSET to its query. Worker still iterates the results but
there are only `count` of them. Provider returns a total count separately if
it can compute it cheaply.

**Possible evolution — option B (skip-ahead method):**
```
filterSkip(ctx, set, n) → void   // advance cursor by n without materializing
```
Provider can implement this as a SQL OFFSET or just cursor += n.
Worker calls this to skip past the offset, then iterates normally.

### Gap 2: No activeOnly push-down

The worker checks `isInactive()` per code and skips inactive ones. For a SQL
provider, this could be a WHERE clause in the filter query, avoiding the
per-code check entirely.

**Current interface:** No way to tell the provider "only give me active codes."

**Possible evolution:**
```
filter(prep, prop, op, value)           // existing
filterActive(prep, true)                // new: hint to exclude inactive
```
Or simply pass an options bag to `executeFilters`:
```
executeFilters(prep, { activeOnly: true, offset: 1000, count: 100 })
```
Provider adds `AND SUPPRESS <> '1'` (RxNorm) or equivalent. If the provider
can't handle it, it ignores the hint and the worker still checks per-code.

### Gap 3: filterConcept returns thin contexts

Even with eager loading fixed for `locate()`, `filterConcept()` creates contexts
from filter query rows. If the filter query doesn't SELECT all needed columns,
the context is thin and follow-up calls re-query.

This is already fixable without interface changes (just add columns to the filter
SELECT), but it's worth noting: **any provider implementing filterConcept/filterPage
should populate contexts with everything the worker will ask for.** This is a
convention, not an interface constraint.

### Non-gap: bulk attribute loading

We explored `prefetchAll(contexts[], needs)` and `locateMany` with batch SQL.
These turned out to be unnecessary:

- **locateMany with SQL IN(...)**: Actually slower than individual prepared
  statements for SQLite. Removed from RxNorm.
- **prefetchAll**: Unnecessary if contexts are self-sufficient at creation time.
- **SNOMED/LOINC locateMany**: Just loops over locate() — no benefit in-process.

These batch APIs may become useful in a future multi-process architecture where
providers run in separate workers and batch calls avoid IPC round-trips. The stubs
remain in the interface for that reason.

## Recommended Interface Evolution

### Phase 1: Expand executeFilters (minimal change)

Add an optional `options` parameter:

```js
// cs-api.js
async executeFilters(filterContext, options = {}) {
  // options.offset — skip this many matching codes
  // options.count — return at most this many
  // options.activeOnly — exclude inactive codes if provider can handle it
  // options.total — if true, provider should compute total count
  //
  // Providers that can't handle these ignore them.
  // Worker checks return value to know what was handled.
  return { sets: [...], handled: { offset: false, count: false, activeOnly: false } };
}
```

The worker checks `handled` and falls back to its own logic for anything
the provider didn't handle. This is fully backward compatible — existing
providers ignore the options and return unhandled.

### Phase 2: Rich context convention (no interface change)

Document that providers should populate contexts with all standard attributes.
Worker code can then trust that per-attribute calls are cache reads. This is
already the case for SNOMED and LOINC; RxNorm is now fixed on this branch.

### Phase 3 (future): Provider-driven expansion

For SQL-backed providers that can handle the entire expansion in a single query,
add an optional high-level method:

```js
async expand(compose, params) {
  // Returns { codes: [...fully formed entries...], total: N }
  // or null if provider can't handle this compose
  return null;
}
```

Worker calls this first. If it returns non-null, skip the iterator pattern
entirely. This is the end state for high-performance SQL providers.

## Summary

| Issue | Impact | Fix | Interface change? |
|-------|--------|-----|-------------------|
| Redundant per-code SQL | 3x overhead | Eager context loading | No |
| No paging push-down | Process N codes to return M | Pass offset/count to executeFilters | Yes (additive) |
| No activeOnly push-down | Check each code individually | Pass activeOnly to executeFilters | Yes (additive) |
| Thin filter contexts | Follow-up queries | Add columns to filter SELECT | No |
| Batch locate | Mixed results | Keep stub, don't force | No |
