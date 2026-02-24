# expand-v3 provider contract

expand-v3 can run purely on the legacy `CodeSystemProvider` interface, but it becomes fast
(especially for excludes/import intersections) when providers implement **optional** v3 hooks.

The goal is to let providers (SQLite) do:

- set operations (UNION / INTERSECT / EXCEPT)
- paging (LIMIT/OFFSET) *when safe*
- membership checks for excludes/imports in **batches**
- bulk decoration

## Minimal legacy compatibility

If a provider implements only the legacy `CodeSystemProvider` methods, v3 can still run by:
- enumerating codes via iterator/filter iteration, and
- materializing constraint sets in memory.

That is correct but not always fast.

## Optional v3 hooks

### 1) negotiate(request)

Providers should negotiate capabilities once per adapter/request context:

```js
async negotiate({ system, version, supplements, params, mode }) {
  return {
    mode: 'query-target', // query-target | legacy-filter | base-only
    query: true,
    membership: true,
    decorateMany: true,
    ordering: { stable: true, kind: 'code' },
    pagination: true,
    legacyFilter: {
      filterPipeline: true,
      supportsSearchFilter: true,
      supportsFilterPage: true,
    },
    supplements: {
      handles: 'none',
      filtering: 'none',
      properties: [],
      operators: [],
      unsupported: [],
      attachments: null,
    },
  };
}
```

`mode` is the primary execution-shape signal:
- `query-target`: provider can execute compiled query requests (`openStream`)
- `legacy-filter`: provider uses legacy filter pipeline
- `base-only`: lookup/iterator only

`query`, `membership`, and `decorateMany` remain independent feature flags.

### 2) openStream({ queryIR, exec, supplements })

Stream candidate codes in stable order:

```js
async *openStream({ queryIR, exec, supplements }) {
  // exec: { offset, count, activeOnly, textFilter, ... }
  // supplements: resolved supplement context for this adapter
  // yield objects like: { code, context?, isInactive?, isAbstract?, display? }
}
```

### 3) prepareMembership({ queryIR, exec, supplements })

Build a reusable membership checker for a query:

```js
const idx = await provider.prepareMembership({ queryIR, exec: null, supplements });
await idx.batchHas(['123', '456']);  // -> [true, false]
await idx.close?.();
```

SQLite implementation should use one SQL query per batch with `IN (...)`
(or a temp table join for large batches).

### 4) decorateMany({ codes, opts, supplements })

Bulk decoration for a page:

```js
const rows = await provider.decorateMany({
  codes: ['123', '456'],
  opts: { properties, includeDesignations, languages },
  supplements,
});
/*
rows: [{
  code: '123',
  display: '...',
  inactive: false,
  abstract: false,
  designations: [...],
  properties: [...],
}]
*/
```

### 5) Query IR shape

expand-v3 uses a small provider-agnostic query IR:

```js
// A query yields codes for exactly one system+version.
{
  system: 'http://snomed.info/sct',
  version: '20240101' | null,

  // One of:
  select: { kind: 'all' }
  select: { kind: 'concept', codes: ['...'] }
  select: { kind: 'filter', clauses: [{property, op, value}, ...], text: '...' | null }

  // Optional set ops on top of select:
  ops: [
    { op: 'intersect', with: <queryIR> },
    { op: 'except',    with: <queryIR> },
    { op: 'union',     with: <queryIR> },
  ]
}
```

SQLite providers should compile this into SQL using:
- temp tables for `codes[]` lists,
- joins for `intersect`,
- `NOT EXISTS` for `except`,
- and an explicit `ORDER BY` to guarantee paging stability.

## Supplements

A provider that can be supplemented dynamically should accept a “supplement bundle”:

- either via constructor (like the existing `supplements` parameter),
- or via a `withSupplements(supps)` method that returns a derived provider.

SQLite approach:
- open the supplement sqlite DB(s) and attach them (`ATTACH DATABASE ...`),
- join supplement tables in `decorateMany` (or in the main query when needed).

v3 itself treats supplements as decoration-only; membership must not change.
