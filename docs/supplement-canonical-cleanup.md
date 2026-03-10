# Status: `overlaySource` Simplified, Wider Canonical Cleanup Deferred

## Current Status

- `overlaySource` now stores a materialized `CodeSystem | null` directly
- active code and tests no longer use the dead `{ kind: 'codesystem-resource', codeSystem }` wrapper
- wider removal of stored `canonical` fields remains deferred
- supplement-focused regression batch is green after the shape cleanup

The rest of this note explains the scope that was implemented and why the
broader canonical cleanup was intentionally not carried out in the same batch.

# Plan: Simplify `overlaySource` And Narrow Canonical Cleanup

## Context

Resolved supplement items currently store overlay-backed supplement resources in
an unnecessary wrapper:

```js
{
  descriptor,
  requestRef,
  overlaySource: {
    kind: 'codesystem-resource',
    codeSystem: supplementCodeSystem,
  },
  nativeBindingSource,
}
```

That wrapper is created in `tx/supplements/resolver.js`, but consumers do not
use it as a discriminated union. They immediately peel the `CodeSystem` back
out:

- `item?.overlaySource?.codeSystem` in `tx/supplements/overlay.js`
- `item?.overlaySource?.codeSystem` in `tx/cs/sqlite-v0-supplements.js`
- `item?.overlaySource?.codeSystem` in `tx/workers/worker.js`
- test fixtures that construct `{ overlaySource: { codeSystem: supplement } }`

There is no second overlay source kind today, and no current consumer checks
`overlaySource.kind`. The wrapper adds indirection without carrying real
semantic information.

By contrast, the broader proposal to remove stored `canonical` from supplement
refs and descriptors does not yet show the same clear payoff. `canonical` is
currently used as a stable identity string for dedupe, cache/signature keys,
labels, and supplement accounting. Removing it everywhere would move
normalization work outward into many call sites, and it would also spill into
legacy-adjacent worker code and the sqlite sidecar schema.

This doc therefore narrows the cleanup:

- do the `overlaySource` simplification now
- defer wider `canonical` field removal to a later, more targeted follow-up

## Goals

1. Make `overlaySource` mean "the overlay `CodeSystem` resource" instead of
   "a wrapper object that contains a `CodeSystem` resource"
2. Remove the dead `kind: 'codesystem-resource'` wrapper from the IR supplement
   path
3. Keep supplement filtering, decoration, and native sqlite attachment behavior
   unchanged
4. Keep legacy `tx/workers/expand.js` out of scope

## Non-Goals

- Removing `canonical` from `SupplementRef` or `SupplementDescriptor`
- Changing sqlite sidecar schema or dropping `supplement_info.canonical`
- Changing `nativeBindingSource.kind`
- Reworking supplement binding architecture beyond this local shape cleanup
- Touching `tx/workers/expand.js`

## Proposed Shape

### Current

```js
type ResolvedSupplement = {
  descriptor: SupplementDescriptor,
  target: BaseScope,
  requestRef: SupplementRef,
  overlaySource: { kind: 'codesystem-resource', codeSystem: CodeSystem } | null,
  nativeBindingSource?: object | null,
};
```

### Proposed

```js
type ResolvedSupplement = {
  descriptor: SupplementDescriptor,
  target: BaseScope,
  requestRef: SupplementRef,
  overlaySource: CodeSystem | null,
  nativeBindingSource?: object | null,
};
```

## Examples

### Resolver output

Current:

```js
{
  descriptor,
  requestRef,
  overlaySource: { kind: 'codesystem-resource', codeSystem: supplement },
}
```

Proposed:

```js
{
  descriptor,
  requestRef,
  overlaySource: supplement,
}
```

### Overlay builder

Current:

```js
const supplement = item?.overlaySource?.codeSystem;
```

Proposed:

```js
const supplement = item?.overlaySource;
```

### Native sqlite supplement binding

Current:

```js
if (item?.overlaySource?.codeSystem) {
  const rows = materializeSupplementInAttachedMemory(db, alias, item.overlaySource.codeSystem);
}
```

Proposed:

```js
if (item?.overlaySource) {
  const rows = materializeSupplementInAttachedMemory(db, alias, item.overlaySource);
}
```

### Tests

Current:

```js
items: [{ overlaySource: { codeSystem: supplement } }]
```

Proposed:

```js
items: [{ overlaySource: supplement }]
```

## Changes

### 1. `tx/supplements/resolver.js`

Make `overlaySource` store the `CodeSystem` directly.

- `materializeOverlaySource()` should return `CodeSystem | null`
- cached checks become `if (this.overlaySource) return this.overlaySource`
- stop constructing `{ kind: 'codesystem-resource', codeSystem }`
- `materializeSupplementItemOverlaySource()` should return the `CodeSystem`
  directly

This is the source of truth for the shape change.

### 2. `tx/supplements/overlay.js`

Read `item?.overlaySource` directly instead of
`item?.overlaySource?.codeSystem`.

No behavior change is intended. The overlay builder should keep treating the
resource as a `CodeSystem` instance and ignore non-materialized items.

### 3. `tx/cs/sqlite-v0-supplements.js`

Use `item?.overlaySource` directly for inline supplement materialization.

Changes are limited to:

- native supplement item detection
- alias/cache seed fallbacks that currently look through `.codeSystem`
- passing the resource into `materializeSupplementInAttachedMemory()`

This keeps the existing inline supplement native-binding flow intact while
removing one layer of pointless object wrapping.

### 4. `tx/workers/worker.js`

Update worker-side supplement resource collection to use `item?.overlaySource`
directly.

This file is in scope only where it consumes the resolved supplement item shape
used by the IR supplement resolver. No changes are proposed to
`tx/workers/expand.js`.

### 5. Tests

Update supplement tests and fixtures that currently encode the wrapper shape.

Expected changes include:

- `tests/ir-engine/supplements/supplement-ir-provider.test.js`
- `tests/ir-engine/supplements/supplement-ir-adapter-providers.test.js`
- `tests/ir-engine/supplements/supplement-sqlite-source.test.js`
- any other supplement tests that manually construct
  `{ overlaySource: { codeSystem: supplement } }`

### 6. Documentation

Update supplement architecture docs to reflect the simplified shape.

At minimum:

- `docs/supplement-architecture.md`

The docs should describe `overlaySource` as a materialized `CodeSystem`
resource, not a wrapper object.

## Deferred Follow-Up: Canonical Field Cleanup

The wider `canonical` cleanup is deferred.

If we still want to reduce `{ canonical, url, version }` redundancy later, the
safer sequence is:

1. Introduce a small helper such as `supplementCanonical(refOrDescriptor)` for
   runtime reads
2. Convert identity, label, and cache/signature call sites to use that helper
3. Re-evaluate whether the stored `canonical` field is still earning its keep
4. Only then consider removing the field from in-memory shapes
5. Leave sqlite sidecar schema changes for last, if they are still justified

That approach preserves a single read path without forcing a large, branch-wide
representation churn up front.

## Verification

1. Supplement tests still pass with the simplified shape
2. Grep for `kind: 'codesystem-resource'` returns zero hits in active code
3. Grep for `overlaySource?.codeSystem` returns zero hits in active code
4. Inline supplement native binding still works on sqlite-v0
5. Overlay-backed supplement filtering and decoration behavior is unchanged
6. No changes are made to `tx/workers/expand.js`
