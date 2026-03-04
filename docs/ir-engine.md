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

```js
buildIRFromValueSet({ compose: {
  include: [
    { system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
  ],
  exclude: [
    { system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
  ]
}})
// → diff(
//     selector(snomed, shape='filter', filterClauses=[{concept, is-a, 73211009}]),
//     selector(snomed, shape='filter', filterClauses=[{concept, is-a, 44054006}])
//   )
```

### Resolve Imports
`resolveImports()` — async. Recursively inlines `import` nodes via a resolver callback. Cycle detection via URL set.

### Optimize
`optimize()` — pure rewrite passes:

- **flatten** — nested unions/intersects → single level
- **coalesce** — merge selectors with same system/version/shape (e.g., two concept enumerations for the same system become one with combined code lists; filter selectors with identical signatures are deduplicated)
- **eliminateEmpty** — prune empty branches
- **partitionDiff** — split multi-system diff operations into per-system diffs for better dispatch

Utility functions for dispatch: `collectSystems()`, `projectToSystem()`, `splitDiffRoot()`, `countFromIR()`.

### Orchestrate

`expandViaIR()` drives the pipeline:

1. **Resolve providers** — find provider per system, wrap in `LegacyIRAdapter` if no native `executeIR()`. Collect provider metadata.
2. **Count** — `countForIR()` per system (or static count for concept enumerations). Enables `count=0` without materializing codes.
3. **Limit check** — if `limit > 0` and total exceeds it, throw `isTooCostly`. Only applied when client isn't paginating.
4. **Stride pagination** — systems sorted canonically; orchestrator computes which codes from each system fall within `[offset, offset+count)` and pushes per-system offset/count to providers.
5. **Execute** — `executeIR()` per system within its window.
6. **Decorate** — bulk-load designations and properties, apply compose-level overrides, filter by language/use, suppress redundant designations.
7. **Build response** — `buildExpandedValueSet()` emits `used-codesystem`, `used-valueset`, `used-supplement`, `valueset-unclosed`, parameter echo, total.

#### Stride Pagination

Systems are processed in canonical sort order. For a multi-system ValueSet with `offset` and `count`, the orchestrator computes which codes from each system fall within the requested window. No single system ever materializes more than `count` rows.

Example: ValueSet spans SNOMED (124 codes) + LOINC (66K codes), request `offset=120, count=10`:
- SNOMED contributes codes 120–123 (4 codes)
- LOINC contributes codes 0–5 (6 codes)
- Systems entirely before the offset are skipped

#### Unclosed Propagation

Grammar-based providers (UCUM, MIME, language) signal when they can't enumerate all codes. The signal propagates through set operations — if any branch of a union is unclosed, the whole result is marked unclosed with a `valueset-unclosed` extension.

---

## Provider Interface

The orchestrator checks `typeof provider.executeIR === 'function'`. If present, IR methods are called directly. If absent, the provider is wrapped in a `LegacyIRAdapter`.

### Core IR Methods

**`executeIR(subtree, opts)`**
Executes an IR subtree and returns matching codes.
- Input: IR subtree (selector/union/intersect/diff), options (activeOnly, text, offset, count)
- Returns: `{ candidates, unclosed? }`
  - `candidates`: array of `{ code, display, ... }`
  - `unclosed`: optional message when expansion can't enumerate all codes

**`countForIR(subtree, opts)`**
Counts codes without materialization (optimization for `count=0`).
- Input: same as `executeIR`
- Returns: integer count or `null` if not supported

**`membershipForIR(subtree)`**
Returns a membership tester for code-level `∈` operations.
- Input: IR subtree
- Returns: `Membership` object with `.contains(code)` method

### Optional Decoration Methods

| Method | Purpose | Fallback |
|--------|---------|----------|
| `bulkDesignations(ids)` | Batch designation load | Per-code `designations(ctx, collector)` |
| `bulkProperties(ids, props)` | Batch property load | Per-code `properties(ctx, collector)` |
| `extensions(ctx)` | Per-code FHIR extensions | None |
| `listSupplements()` | URLs of active supplements | Empty array |

---

## Execution Modes

### Mode 1: Native IR (v0 SQLite)

The v0 provider compiles IR subtrees to SQL against the v0 schema. Key mappings:

| IR construct | SQL |
|-------------|-----|
| selector(shape=whole) | `SELECT * FROM concept WHERE cs_id=? AND active=1` |
| selector(shape=concept) | `... WHERE code IN (?,?,?)` |
| selector(filter is-a) | `JOIN closure` on transitive closure table |
| selector(filter =) | `JOIN concept_literal` on property value |
| selector(filter in) | `... WHERE value IN (?,?,?)` |
| selector(filter regex on code) | `REGEXP` against `concept.code` |
| selector(filter regex on property) | `JOIN concept_literal` + `REGEXP` against `value_text` |
| union | `UNION` of sub-queries |
| intersect | `INTERSECT` of sub-queries |
| diff | `EXCEPT` or `LEFT JOIN ... WHERE right IS NULL` |

Property alias resolution is data-driven via `cs_config` (e.g., SNOMED's `concept` → `Is a`). The same provider handles SNOMED, LOINC, RxNorm — all terminology-specific behavior is in `cs_config`.

### Mode 2: Legacy Adapter

`LegacyIRAdapter` wraps any provider by tree-walking the IR and calling filter protocol methods:

- **concept** → `locate(code)` per code
- **filter** → `getPrepContext()` → `filter()` → `executeFilters()`
- **whole** → `iteratorAll()`
- **grammar-based** → when `iteratorAll()` returns null: try `specialEnumeration()` for common units (→ unclosed), else throw `isTooCostly`
- **union/intersect/diff** → composed in JS using membership indexes

Returns `{ candidates, unclosed? }` — orchestrator treats both modes uniformly.

---

## Decoration and Overrides

### Bulk Designation Loading

After candidate selection, designations are loaded in bulk per system rather than per-concept during iteration. Filtering is applied in order:

1. **By use**: filter to specific `use` system|code pairs (via `designations` parameter)
2. **By language**: filter to requested `displayLanguage` or HTTP `Accept-Language`
3. **Redundancy suppression**: omit designations where `designation.value === concept.display`

### Compose-Level Overrides

FHIR allows `compose.include[].concept[].display` and `.designation[]` to override code system values. The orchestrator carries these overrides through the IR tree in `meta` fields, then applies them after bulk decoration:

1. `collectComposeOverrides()` — walks the resolved IR tree to extract per-code display and designation overrides
2. `applyComposeOverrides()` — patches the decorated candidates, replacing displays and adding designations
3. Designation overrides only apply when `includeDesignations` is active

---

## Integration with expand.js

The IR engine integrates via `_tryIRExpansion()` in the existing expand worker:

```js
async performExpansion(valueSet, params) {
  const engineOverride = params._engine;
  const useIR = engineOverride === 'ir'
    || (engineOverride !== 'legacy' && process.env.EXPAND_IR_ENGINE === '1');

  if (useIR) {
    const irResult = await this._tryIRExpansion(valueSet, params);
    if (irResult) return irResult;
  }
  // Fall through to legacy ValueSetExpander
  return this._legacyExpansion(valueSet, params);
}
```

The IR engine receives two callbacks and all standard expansion parameters:

- **findProvider(system, version)** — locate provider for a code system
- **resolveValueSet(url)** — fetch imported ValueSets
- **Parameters**: `activeOnly`, `text`, `offset`, `count`, `includeDesignations`, `properties`, `designations`, `displayLanguage`

### Activation

| `EXPAND_IR_ENGINE` env | `_engine` param | Behavior |
|------------------------|-----------------|----------|
| unset or `!=1` | (none) | Legacy only |
| unset or `!=1` | `ir` | IR, error if unsupported |
| `1` | (none) | IR first, legacy fallback |
| `1` | `ir` | IR, error if unsupported |
| `1` | `legacy` | Legacy only |

The systemd service sets `EXPAND_IR_ENGINE=1`. Per-request `_engine=ir|legacy` overrides.

### Fallback Behavior

1. **`canHandleValueSet(vsJson)`** — does the ValueSet have a valid `compose`?
2. **Provider lookup** — can we find a provider for every system? If not, returns `null` (legacy fallback)
3. **Execution** — if execution throws:
   - `isTooCostly` errors are re-thrown (not caught)
   - Other errors are logged and trigger legacy fallback

This allows the IR engine to gracefully decline ValueSets it can't handle, while ensuring resource-intensive errors surface properly.

---

## The v0 SQLite Provider

A generic code system provider for the v0 SQLite database schema used by FHIRsmith's importers. Supports SNOMED, LOINC, RxNorm, and any other terminology stored in v0 format.

### Database Schema (v0)

```
code_system      ─ base_uri, version, name, content_mode
concept          ─ code, display, active, abstract, definition
concept_link     ─ source_concept_id → target_concept_id (hierarchy edges)
concept_literal  ─ property_id, value (code properties as strings)
closure          ─ ancestor_id → descendant_id (transitive closure)
designation      ─ concept_id, language, use_code, term, active, preferred
property_def     ─ property_id, code, uri, type
cs_config        ─ JSON blob: hierarchy, filters, search, languages, behaviorFlags
value_set        ─ url, JSON definition for implicit value sets
search_fts_*     ─ FTS5 tables for text search
```

### Dual-Mode Support

The v0 provider implements both the legacy filter protocol and native IR:

- **Legacy protocol**: `locate()`, `getPrepContext()`, `filter()`, `executeFilters()`, `filterMore()`, `filterConcept()`, `parent()`, `designations()`, `properties()`, etc.
- **IR methods**: `executeIR()`, `countForIR()`, `membershipForIR()`

Both modes return identical results for the same inputs.

### Runtime Configuration

The provider reads `cs_config` to build a runtime configuration. All terminology-specific behavior is data-driven:

- **hierarchy** — which property defines parent→child edges
- **filters.properties.aliases** — FHIR property → DB property mapping
- **search** — multi-source FTS configuration (display, designation, literal)
- **languages** — default language for displays
- **status** — which property holds concept status
- **iteration.defaultCodeRegex** — filter for `iteratorAll()` (excludes metadata)
- **behaviorFlags.tags** — tags for specialization matching (see below)

### Specialization System

Some terminologies need behavior beyond what the generic provider offers (e.g., SNOMED post-coordinated expressions, LOINC implicit value set generation from URL patterns). Rather than hardcoding these, a specialization registry allows subclass modules to declare interest in specific terminologies:

```js
// In a hypothetical cs-sqlite-snomed-v0.js
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

Subclasses override factory methods like `build()` (to return a specialized per-request provider) and `buildKnownValueSet()` (to handle terminology-specific implicit value sets). The per-request `SqliteV0Provider` and its IR execution methods remain unchanged.

With no specializations registered (the current state), `createFromMetadata()` behaves identically to direct construction.

---

## Membership Types

Composable set-membership objects for code-level `∈` testing without materializing full expansions. Used by `membershipForIR()` and the legacy adapter for intersect/diff operations.

| Type | Behavior |
|------|----------|
| `EmptyMembership` | Always false |
| `SetMembership` | O(1) lookup in memory |
| `SqlMembership` | Parameterized query per lookup |
| `UnionMembership` | True if any child is true |
| `IntersectMembership` | True if all children are true |
| `DiffMembership` | True if left and not right |

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

## Structured Tracing

The IR engine includes structured tracing (`tx/engine/expand-trace.js`) using `AsyncLocalStorage`. Zero-cost when inactive.

Activated via `_trace=true` query parameter. Trace data is attached to the expansion response as a FHIR extension:

```
expansion.extension[].url = "http://fhirsmith.org/StructureDefinition/expand-trace"
expansion.extension[].valueString = <JSON trace>
```

Trace output includes:
- Hierarchical span tree (orchestration phases, per-system dispatch)
- SQL query details (text, params, row counts, timing)
- Pagination decisions

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

The HTTP harness is the source of truth. It covers core set operations, all selector shapes, pagination (including deep offsets), text search, designation/property decoration, compose overrides, inline supplements, grammar-based providers (UCUM unclosed, MIME too-costly), limit enforcement, and stress tests.

Run with `--legacy` for legacy-engine comparison, `--perf` for an HTML performance table.

Jest tests in `tests/engine/` and `tests/cs/` cover individual modules for fast iteration.

---

## Design Decisions

### Separation of Concerns

The IR approach separates parsing (pure), optimization (pure), execution (I/O), decoration (I/O), and formatting (pure). Each phase can be tested, optimized, and reasoned about independently.

### IR as Abstraction Boundary

The IR tree is provider-agnostic. Providers can execute it however they want: SQL compilation, in-memory iteration, API calls, lazy evaluation. This enables provider-specific optimizations without changing the orchestrator.

### Adapter Pattern over Rewrite

Rather than modifying every provider to add `executeIR()`, the adapter wraps them automatically. Zero changes to existing providers. When a provider wants better performance, it can opt into native IR execution.

### Flat Output

The IR engine always returns flat expansions. This matches tx.fhir.org behavior, simplifies pagination (FHIR spec says paging only applies to flat), and keeps the orchestrator focused on set operations rather than hierarchy building.

### Opt-in Activation

IR engine is off by default. Existing behavior is unchanged unless explicitly enabled. Per-request `_engine` parameter allows A/B testing and gradual migration.

### Bulk Decoration

Designations and properties are loaded in a bulk pass after candidate selection. This separates filtering from decoration and enables efficient batch loading.

### Data-Driven Configuration

The v0 provider reads all behavior from `cs_config`. No terminology-specific code; the same provider handles SNOMED, LOINC, RxNorm, etc. identically. Terminology-specific extensions are supported via the specialization registry.

---

## See Also

- `docs/ir-engine-gap-plan.md` — Phase-by-phase implementation history
- `docs/legacy-expansion-gap.md` — Hierarchical vs. flat expansion analysis
- `scripts/ir-harness.mjs` — HTTP test harness
- `scripts/ir-rewrite-tests.mjs` — IR optimizer unit tests
