# expand-v3

This folder contains a **new** ValueSet `$expand` engine (v3) designed to be:

- **Semantically simple**: one set-contract, independent of execution strategy.
- **Provider-optimized**: can push work into engines like SQLite when available.
- **Streaming-friendly**: does not require full materialization of nested imports by default.
- **Pagination-safe**: `offset`/`count` are applied to the final (deduped, excluded) membership stream.

> Ordering note  
> expand-v3 does **not** promise a canonical global ordering. It only promises an order that is:
> 1) deterministic for a given ValueSet definition + database snapshot + request parameters, and  
> 2) therefore **consistent across pages** (different `offset`/`count` calls produce disjoint contiguous slices of the same underlying order).

The deterministic ordering used by v3 is:

1. Compose include components are processed **in the order they appear** in `ValueSet.compose.include[]`.
2. Within a component, the provider’s **stable native iteration order** is used (for SQLite: `ORDER BY code` or equivalent).
3. For imported ValueSets, their internal includes are traversed in a stable, documented order.

## What’s in here

- `design.md` — mental model, invariants, algorithms, and decision points.
- `provider-contract.md` — the provider-facing interfaces v3 wants (with a safe adapter for legacy providers).
- `src/` — the actual engine.

## Integration

The easiest integration pattern is:

1. Add a new worker entrypoint (see `src/expand-v3-worker.js`).
2. Wire it behind a feature flag (e.g. `EXPAND_V3=1`) or new route.
3. Incrementally teach providers (especially SQLite) to implement the optional v3 pushdown hooks.

No new npm dependencies are required.

