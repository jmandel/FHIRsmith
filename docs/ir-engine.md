# IR-Based ValueSet Expansion Engine

## Overview

The IR expansion engine provides an alternative implementation of FHIR ValueSet `$expand` operations. It sits alongside the existing legacy `ValueSetExpander` in `tx/workers/expand.js` — both paths are available at runtime, selectable per-request via the `_engine` parameter.

The IR engine compiles a ValueSet's `compose` into a tree of semantic nodes, optimizes it, partitions by code system, and dispatches each subtree to the appropriate provider. Providers can implement native IR execution (e.g., compiling to SQL) or be automatically wrapped in an adapter that bridges to their existing filter protocol methods.

### Why

The legacy `ValueSetExpander` interleaves parsing, filtering, hierarchy building, pagination, and output formatting in a single ~1,300-line execution path. The IR approach separates concerns into a clear pipeline:

1. **Parse** — ValueSet JSON → IR tree (pure, no I/O)
2. **Optimize** — flatten, deduplicate, simplify (pure)
3. **Execute** — dispatch to providers (I/O, per-system)
4. **Decorate** — add designations, properties, extensions (I/O, bulk)
5. **Format** — build FHIR response (pure)

Each phase can be tested, optimized, and reasoned about independently.

### Integration Approach

The IR engine adds minimal changes to upstream code:
- `tx/workers/expand.js` — `_tryIRExpansion()` entry point with fallback
- `tx/params.js` — `_engine` parameter parsing
- `tx/library.js` — v0 SQLite database loader
- `package.json` — `better-sqlite3` dependency

All new functionality lives in `tx/engine/` modules and `tx/cs/cs-sqlite-v0.js`. Existing providers require no changes.

---

## Architecture

```
ValueSet JSON
     │
     ▼
┌─────────────┐
│  build-ir   │  ValueSet.compose → IR tree
└──────┬──────┘
       ▼
┌────────────────┐
│resolve-imports │  Inline imported ValueSets (cycle-safe)
└──────┬─────────┘
       ▼
┌─────────────┐
│   rewrite   │  Flatten, coalesce, partition-by-system
└──────┬──────┘
       ▼
┌────────────────┐
│  orchestrator  │  Count → limit-check → paginate → execute → decorate
└──────┬─────────┘
       │
       ├──▶ v0 SQLite: executeIR() → compiled SQL
       ├──▶ cs-cs providers: LegacyIRAdapter → filter protocol
       └──▶ grammar providers: LegacyIRAdapter → specialEnumeration / too-costly
       │
       ▼
  FHIR ValueSet expansion response
```

---

## IR Node Types

Six node kinds form a small algebraic type system over code sets:

| Kind | Meaning |
|------|---------|
| `empty` | No codes (identity for union) |
| `selector` | Leaf: one code system component (whole / concept / filter) |
| `import` | Reference to another ValueSet |
| `union` | Set union (multiple includes) |
| `intersect` | Set intersection (include with multiple valueSets) |
| `diff` | Set difference (include minus exclude) |

All nodes carry optional `meta` for compose-level overrides (display, designations). The `selector` node is the workhorse:

- **`shape`**: `'whole'` | `'concept'` | `'filter'`
- **`filterClauses`**: `[{ property, op, value }]` matching FHIR filter syntax
- **`intersectCodes`**: codes from resolved valueSet intersection (enables SQL `IN` pushdown)
- **`text`**: free-text search term (from `filter` parameter)

---

## Compilation Pipeline

### Build IR
`buildIRFromValueSet()` — pure. Walks `compose.include[]`/`.exclude[]`, producing union/diff trees of selectors and imports.

### Resolve Imports
`resolveImports()` — async. Recursively inlines `import` nodes via a resolver callback. Cycle detection via URL set.

### Optimize
`optimize()` — pure rewrite passes: flatten nested unions, coalesce same-system selectors, eliminate empties, partition multi-system diffs into per-system diffs.

Utility functions for dispatch: `collectSystems()`, `projectToSystem()`, `countFromIR()`.

### Orchestrate

`expandViaIR()` drives the pipeline. The key phases:

1. **Resolve providers** — find provider per system, wrap in `LegacyIRAdapter` if no native `executeIR()`. Collect provider metadata.
2. **Count** — `countForIR()` per system (or static count for concept enumerations). Enables `count=0` without materializing codes.
3. **Limit check** — if `limit > 0` and total exceeds it, throw `isTooCostly`. Only applied when client isn't paginating.
4. **Stride pagination** — systems sorted canonically; orchestrator computes which codes from each system fall within `[offset, offset+count)` and pushes per-system offset/count to providers.
5. **Execute** — `executeIR()` per system within its window.
6. **Decorate** — bulk-load designations and properties, apply compose-level overrides, filter by language/use, suppress redundant designations.
7. **Build response** — `buildExpandedValueSet()` emits `used-codesystem`, `used-valueset`, `used-supplement`, `valueset-unclosed`, parameter echo, total.

**Unclosed propagation**: grammar-based providers signal unclosed expansion (e.g., UCUM can enumerate common units but not all valid expressions). The signal propagates through union/diff/intersect — if any branch is unclosed, the whole result is marked unclosed.

---

## Provider Interface

The orchestrator checks `typeof provider.executeIR === 'function'`. If present, IR methods are called directly. If absent, the provider is wrapped in a `LegacyIRAdapter`.

### Required for native IR

| Method | Purpose |
|--------|---------|
| `executeIR(subtree, opts)` | Execute IR subtree → `{ candidates[], unclosed? }` |
| `countForIR(subtree, opts)` | Count without materializing |
| `membershipForIR(subtree)` | Code-level `∈` tester for set operations |

### Optional decoration

| Method | Purpose | Fallback |
|--------|---------|----------|
| `bulkDesignations(ids)` | Batch designation load | Per-code `designations(ctx, collector)` |
| `bulkProperties(ids, props)` | Batch property load | Per-code `properties(ctx, collector)` |
| `extensions(ctx)` | Per-code FHIR extensions | None |
| `listSupplements()` | URLs of active supplements | Empty array |

---

## Execution Modes

### Native IR (v0 SQLite)

The v0 provider compiles IR subtrees to SQL against the v0 schema (`concept`, `closure`, `concept_literal`, `designation`, FTS5 tables). Key mappings:

| IR construct | SQL |
|-------------|-----|
| concept enumeration | `WHERE code IN (...)` |
| is-a filter | `JOIN closure` |
| property = / in | `JOIN concept_literal` |
| regex | `REGEXP` |
| union / intersect / diff | `UNION` / `INTERSECT` / `EXCEPT` |

Property alias resolution is data-driven via `cs_config` (e.g., SNOMED's `concept` → `Is a`). The same provider handles SNOMED, LOINC, RxNorm — all terminology-specific behavior is in `cs_config`.

**Supplement support**: when loaded with `statedSupplements`, the v0 provider overlays supplement content — display replacement in `executeIR()`, designation merge in `bulkDesignations()`, extension projection via `extensions()`. The orchestrator validates stated vs. used supplements and emits `used-supplement` parameters.

### Legacy Adapter

`LegacyIRAdapter` wraps any provider by tree-walking the IR and calling filter protocol methods:

- **concept** → `locate(code)` per code
- **filter** → `getPrepContext()` → `filter()` → `executeFilters()`
- **whole** → `iteratorAll()`
- **grammar-based** → when `iteratorAll()` returns null: try `specialEnumeration()` for common units (→ unclosed), else `totalCount() === -1` → throw `isTooCostly`
- **union/intersect/diff** → composed in JS using membership indexes

Returns `{ candidates, unclosed? }` — orchestrator treats both modes uniformly.

---

## Activation

| `EXPAND_IR_ENGINE` env | `_engine` param | Behavior |
|------------------------|-----------------|----------|
| unset or `!=1` | (none) | Legacy only |
| unset or `!=1` | `ir` | IR, error if unsupported |
| `1` | (none) | IR first, legacy fallback |
| `1` | `ir` | IR, error if unsupported |
| `1` | `legacy` | Legacy only |

The systemd service sets `EXPAND_IR_ENGINE=1`. Per-request `_engine=ir|legacy` overrides the default. Fallback logic: `canHandleValueSet()` check → provider lookup → execute. `Issue` and `isTooCostly` errors are re-thrown; other errors fall back to legacy.

---

## Key Behavioral Differences vs Legacy

| Aspect | IR engine | Legacy |
|--------|-----------|--------|
| Output shape | Always flat | May be hierarchical |
| Pagination | Stride dispatch per system | Materialize all, slice |
| count=0 | `SELECT COUNT(*)` | Full expansion then count |
| Designations | Bulk load after selection | Per-concept during iteration |
| Limit | Pre-check total vs limit | Mid-enumeration safety valve |
| Property filter matching | Code only (FHIR R4 §5.8.2) | Code or display (legacy bug) |

See `docs/legacy-expansion-gap.md` for hierarchy behavior details.

---

## Module Map

### `tx/engine/`

| Module | Role |
|--------|------|
| `ir.js` | IR node constructors |
| `build-ir.js` | ValueSet JSON → IR compiler |
| `resolve-imports.js` | Async import inlining |
| `rewrite.js` | IR optimization passes |
| `orchestrator.js` | Pipeline orchestrator — pagination, decoration, response building |
| `legacy-ir-adapter.js` | Adapter wrapping legacy providers for IR execution |
| `membership.js` | Composable set-membership types (Set, Sql, Union, Intersect, Diff) |
| `sqlite-v0-sql.js` | IR → SQL compiler for v0 schema |
| `expand-trace.js` | Structured tracing (`_trace=true`) via AsyncLocalStorage |
| `index.js` | Public API exports |

### `tx/cs/cs-sqlite-v0.js`

Generic v0 SQLite provider — dual-mode (legacy filter protocol + native IR), supplement-aware. All terminology-specific behavior is data-driven via `cs_config`.

#### Specialization system

Some terminologies need behavior beyond what the generic provider offers (e.g., SNOMED post-coordinated expressions, LOINC implicit value set generation from URL patterns). Rather than hardcoding these, a specialization registry allows subclass modules to declare interest in specific terminologies:

```js
// In cs-sqlite-snomed-v0.js (hypothetical)
SqliteV0FactoryProvider.registerSpecialization({
  id: 'snomed-expressions',
  systemPrefix: 'http://snomed.info/sct',
  FactoryClass: SnomedSqliteV0Factory,
});
```

At startup, `library.js` calls `SqliteV0FactoryProvider.createFromMetadata(i18n, dbPath)` instead of constructing the factory directly. This method:

1. Opens the database and loads metadata (canonical URI, `behaviorFlags.tags` from `cs_config`)
2. Checks the specialization registry for a matching entry (by URL prefix and/or tags)
3. Returns a specialized factory subclass if one matches, otherwise the generic base

Matching rules:
- **`systemPrefix`**: prefix-matched against the DB's canonical URI
- **`tags`**: all listed tags must be present in the DB's `behaviorFlags.tags`
- **`priority`**: higher wins when multiple entries match

With no specializations registered (the current state), `createFromMetadata()` behaves identically to direct construction — zero overhead, but the seam is in place for future extensions.

Subclasses override factory methods like `build()` (to return a specialized per-request provider) and `buildKnownValueSet()` (to handle terminology-specific implicit value sets). The per-request `SqliteV0Provider` and its IR execution methods remain unchanged.

### Integration points in upstream code
- `tx/workers/expand.js` — `_tryIRExpansion()`, supplement collection, limit wiring
- `tx/params.js` — `_engine` parsing
- `tx/library.js` — v0 database loader (calls `createFromMetadata()`)

---

## Testing

| Suite | Count | Runs against |
|-------|-------|--------------|
| `scripts/ir-harness.mjs` | 146 | Running server (HTTP) |
| `scripts/ir-rewrite-tests.mjs` | 9 | No server (pure) |

The HTTP harness is the source of truth. It covers core set operations, all selector shapes, pagination (including deep offsets), text search, designation/property decoration, compose overrides, inline supplements, grammar-based providers (UCUM unclosed, MIME too-costly), limit enforcement, and stress tests (adjacent-page stability at offset 50K, complex inc/exc, mixed-system filter + limit boundary).

Run with `--legacy` for legacy-engine comparison, `--perf` for an HTML performance table.

Jest tests in `tests/engine/` and `tests/cs/` cover individual modules for fast iteration.

---

## See Also

- `docs/ir-engine-gap-plan.md` — Phase-by-phase implementation history
- `docs/legacy-expansion-gap.md` — Hierarchical vs. flat expansion analysis
- `scripts/ir-harness.mjs` — HTTP test harness
- `scripts/ir-rewrite-tests.mjs` — IR optimizer unit tests
