# expand-v3 design

## Philosophy

We want one semantic contract that always holds, while allowing multiple execution engines:

**Semantic contract:**
1. Final membership is:  
   **Final = Union(Includes) − Union(Excludes)**  
   after applying any import/intersection constraints.
2. Deduplication happens on the final stream (same system+code, and optionally version).
3. `offset`/`count` apply to the **final** deduped+excluded stream.
4. If two execution modes succeed (pushdown vs fallback), they must not disagree on **membership**.

**Non-goal:** canonical global ordering across unrelated requests/providers.  
**Goal:** stable ordering **within a given request definition**, so pages are consistent.

## Core mental model

Think of the expansion definition as an **expression tree**:

- `Selector(system, shape)` — leaf that can produce codes (whole system / filter / enumerated concepts / text-search).
- `Import(ValueSetRef)` — subtree (another ValueSet expression).
- `Union([A, B, ...])`
- `Intersect([A, B, ...])`
- `Diff(A, B)`  (A \ B)

The top-level is always:

```
Diff(
  Union(all include components),
  Union(all exclude components)
)
```

An include component with `system` and `valueSet[]` imports is:

```
Intersect(
  Selector(system, ...),
  Import(vs1),
  Import(vs2),
  ...
)
```

A “pure import” component (`include.valueSet[]` but no `include.system`) is:

```
Union( Import(vs1), Import(vs2), ... )
```

## Execution strategy

### Big picture

expand-v3 executes in three conceptual phases:

1. **Plan/IR build**
   - Parse `ValueSet.compose` into an expression tree.
   - Resolve imports (recursively) into expression subtrees (with cycle detection).
   - Optional rewrite passes (flatten unions, inline simple imports, per-system projections).

2. **Membership streaming (pagination-safe)**
   - Build a fast **global exclusion index** from the exclude subtree.
   - Stream include candidates in deterministic order.
   - Apply:
     - intersection constraints (membership indexes) in **batches**
     - global exclusions in **batches**
     - global dedupe
   - Collect exactly the requested page slice (`offset`/`count`) without materializing everything.

3. **Decoration**
   - For codes on the final page, fetch display/designations/properties via the provider.
   - This is the only stage that must “touch” expensive metadata.

### Deterministic ordering

Because we only need “consistent across pages”, we define ordering as:

- **Primary order**: the order of include components in `compose.include[]`.
- **Secondary order**: stable provider order for that selector (SQLite should guarantee stable `ORDER BY`).
- **Tie handling**: when a code appears in multiple sources, the earliest source wins (because dedupe keeps the first sighting).

This is easy to reason about and stable across repeated requests.

## Key performance idea: batch membership checks

The single biggest performance trap is doing:

- `filterCheck()` **per candidate** during streaming, especially when exclude constraints are expressed as filters.

v3’s approach:

- Convert constraint subtrees (excludes and intersections) into **membership indexes** that can answer:
  - `batchHas(keys[]) -> boolean[]`  
    ideally in one SQL query per batch.

Providers can implement membership indexes natively (SQLite), or the engine can fall back to materializing an in-memory set.

### Membership index types

- **InMemorySetIndex**
  - built by enumerating the constraint subtree once, storing keys in a JS `Set`.
  - fast checks, but may be expensive to build for huge excludes/imports.

- **ProviderQueryIndex** (preferred for SQLite)
  - built by compiling the constraint subtree into a provider-native query plan.
  - `batchHas()` performs `SELECT code FROM ... WHERE code IN (...)` style checks.

- **Hybrid**
  - small sets are materialized; large sets become provider indexes.

## Pushdown

Providers can optionally implement a v3 negotiated query interface so v3 can:

- stream candidates directly from SQL (`openStream({ queryIR, exec, supplements })`)
- check membership in batches (`prepareMembership({ queryIR, exec, supplements }).batchHas(keys)`)
- bulk-decorate (`decorateMany({ codes, opts, supplements })`)

Pushdown is used when:
- the expression projected to a system can be expressed in the provider’s query language, and
- it’s safe with respect to paging and global semantics.

Pagination pushdown is only used when the entire result set is known to be produced by **a single query** (no union across sources, no global excludes, no cross-system dedupe). Otherwise paging is applied after membership.

## Supplements

Supplements are **decoration-only** for expand. They must be applied consistently regardless of execution path.

v3 supports “supplements on the fly” by:
- computing `requiredSupplements` from request params + ValueSet extensions, then
- constructing provider contexts that include supplement sources for the request.

For SQLite-backed supplements:
- treat supplements as additional attached DBs (or additional tables),
- join supplement data in `decorateMany` rather than per-row lookups.

See `provider-contract.md` for the preferred provider hooks.

## Correctness edge cases

- Nested imports with excludes: handled naturally by import resolution building a full subtree.
- Excludes containing ValueSet imports: also handled naturally (exclude subtree can import too).
- Providers with open-ended code systems (“not closed”): v3 must surface `valueset-unclosed`.
- Totals:
  - If full enumeration completes, v3 can set `expansion.total`.
  - If pagination short-circuits, v3 omits total unless it can compute it safely.

## Testing strategy

Unit-testable seams:
- IR building from compose JSON
- import resolution with cycles + caching
- rewrite passes (flatten, projection)
- membership enumeration invariants:
  - Union/Diff/Intersect set laws
  - paging stability
  - dedupe semantics
- provider adapter behaviour against a fake provider

Integration tests:
- SQLite provider with large excludes to ensure batch membership (not per-candidate filterCheck)
- mixed provider request with imports + excludes + paging
