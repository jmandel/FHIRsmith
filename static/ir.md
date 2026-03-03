# ValueSet Expand IR: Format and Capabilities

This document defines the IR used by the expand engine and standalone compiler.

## Purpose

The IR captures **membership semantics** only:

- `Final = Union(includes) - Union(excludes)`
- decoration (display/designations/properties) is handled later
- execution strategy (pushdown vs fallback) is separate from IR shape

## Core Node Types

### `empty`

Represents an empty set.

```json
{ "kind": "empty" }
```

### `selector`

Represents a system-scoped selection.

```json
{
  "kind": "selector",
  "system": "http://loinc.org",
  "version": "2.81",
  "shape": "filter",
  "filterClauses": [{ "property": "STATUS", "op": "=", "value": "ACTIVE" }],
  "intersectCodes": ["2160-0", "4548-4"],
  "text": null,
  "meta": { "path": "ValueSet.compose.include[0]" }
}
```

Supported `shape` values:

- `whole` (entire system/version slice)
- `concept` (explicit concept code list)
- `filter` (property/op/value filter clauses)

Optional fields:

- `conceptCodes` for `shape=concept`
- `filterClauses` for `shape=filter`
- `intersectCodes` for post-filter code intersection lowering
- `text` for request text filter when bound to selector
- `meta` for trace/debug source location

### `import`

Reference to an imported ValueSet (`compose.include.valueSet` or `exclude.valueSet`).

```json
{
  "kind": "import",
  "url": "http://example.org/vs/root",
  "version": null,
  "resolved": null,
  "meta": { "path": "ValueSet.compose.include[0].valueSet[0]" }
}
```

After import resolution, `resolved` contains an IR subtree.

### `union`

Set union across child expressions.

```json
{ "kind": "union", "items": [ ... ] }
```

### `intersect`

Set intersection across child expressions.

```json
{ "kind": "intersect", "items": [ ... ] }
```

### `diff`

Set difference (`left - right`).

```json
{ "kind": "diff", "left": { ... }, "right": { ... } }
```

## IR Pipeline

## 1) Basic IR

Compiled from `ValueSet.compose`:

- includes become a union
- excludes become a union
- root is `diff(includeUnion, excludeUnion)`

## 2) Resolved IR

All import refs are resolved recursively:

- inline tx-resources first (if provided)
- then injected resolver(s)
- cycle detection and depth limits are enforced

## 3) Lowered IR

Rewrite/optimization passes normalize structure to improve pushdown and fallback efficiency.

## Current Lowering Capabilities

- flatten nested `union` / `intersect`
- remove empty branches
- inline resolved imports
- coalesce compatible selectors in union/intersect
- concept-concept intersection collapse
- filter+concept intersection lowered via `intersectCodes`
- duplicate filter branch dedupe
- nested diff partitioning by system/version where valid
- dead-branch elimination during projection

## Query IR (Provider Pushdown Target)

Expression IR may be lowered/compiled to provider query IR when possible.
That is a **separate representation** used for provider execution.

Pushdown eligibility depends on:

- provider mode/capabilities (e.g. full-query provider)
- whether the expression can be represented as one provider query slice
- semantics safety (paging/excludes/intersections)

If not fully compilable for a provider, engine uses fallback streaming and membership indexes.

## Invariants

- IR preserves set semantics independent of execution mode.
- Pushdown and fallback are optimization choices; membership must match.
- Paging is applied on final deduped results unless proven safe to delegate.

## Standalone Compiler API

The standalone module compiles to all three forms:

```js
const out = await ValueSetIRCompiler.compileValueSetIR({
  valueSet,          // FHIR ValueSet JSON
  parameters,        // optional FHIR Parameters
  additionalResources // optional tx-resources
});

// out.basicIR
// out.resolvedIR
// out.loweredIR
```

It can resolve imports from:

- inline `tx-resource` / `valueSet` resources
- injected resolver functions
- optional fetch-based resolver helper

