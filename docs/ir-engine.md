# IR-Based ValueSet Expansion Engine

## Overview

The IR expansion engine provides an alternative implementation of FHIR ValueSet `$expand` operations. It sits alongside the existing legacy `ValueSetExpander` in `tx/workers/expand.js` — both paths are available at runtime, selectable per-request via the `_engine` parameter.

The IR engine compiles a ValueSet's `compose` into a tree of semantic nodes, optimizes it, partitions by code system, and dispatches each subtree to the appropriate provider. Providers can implement native IR execution (e.g., compiling to SQL) or be automatically wrapped in an adapter that bridges to their existing filter protocol methods.

### Why

The legacy `ValueSetExpander` interleaves parsing, filtering, hierarchy building, pagination, and output formatting in a single execution path. Adding features like `count=0`, used-codesystem reporting, multi-system stride pagination, and designation filtering requires navigating deeply nested control flow.

The IR approach separates concerns into a clear pipeline:

1. **Parse** — ValueSet JSON → IR tree (pure, no I/O)
2. **Optimize** — flatten, deduplicate, simplify (pure)
3. **Execute** — dispatch to providers (I/O, per-system)
4. **Decorate** — add designations, properties (I/O, bulk)
5. **Format** — build FHIR response (pure)

This separation makes the system more testable, more maintainable, and enables optimizations that aren't possible when concerns are coupled.

### Integration Approach

The IR engine adds minimal changes to upstream code:
- `tx/workers/expand.js` — Single entry point `_tryIRExpansion()` with fallback
- `tx/params.js` — `_engine` parameter parsing
- `tx/library.js` — v0 SQLite database loader
- `package.json` — `better-sqlite3` dependency

All new functionality lives in `tx/engine/` modules and the generic v0 SQLite provider `tx/cs/cs-sqlite-v0.js`. Existing providers require no changes.

---

## Architecture

```
ValueSet JSON
     │
     ▼
┌─────────────┐
│  build-ir   │  ValueSet.compose → IR tree (with compose-level meta)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│resolve-imports│  Inline imported ValueSets
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   rewrite   │  Flatten, coalesce, partition-by-system
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ orchestrator│  Per-system dispatch + aggregation
└──────┬──────┘
       │
       ├──▶ v0 provider: executeIR() → single SQL query
       │
       └──▶ any provider: LegacyIRAdapter → tree-walk + filter protocol
       │
       ▼
┌─────────────────┐
│ decorate + filter │  Bulk designations, properties, compose overrides
└────────┬────────┘
              │
              ▼
       FHIR ValueSet expansion response
```

---

## IR Node Types

The IR is a small algebraic type system representing set operations over code systems. Six node kinds:

| Kind | Fields | Meaning |
|------|--------|---------|
| `empty` | — | No codes (identity for union) |
| `selector` | system, version, shape, conceptCodes, filterClauses, intersectCodes, text | Leaf: single code system component |
| `import` | url, version, resolved? | Reference to another ValueSet |
| `union` | items[] | Set union (include + include) |
| `intersect` | items[] | Set intersection (include with multiple valueSets) |
| `diff` | left, right | Set difference (include minus exclude) |

All nodes carry an optional `meta` field that threads compose-level metadata (display overrides, designation overrides) through the tree. This keeps the IR self-contained — the orchestrator doesn't need to re-walk the original ValueSet to find overrides.

The `selector` node's `shape` field indicates what kind of content:
- `'whole'` — entire code system (no filters)
- `'concept'` — enumerated code list
- `'filter'` — property filters (is-a, =, in, regex, etc.)

`filterClauses` is an array of `{ property, op, value }` objects matching FHIR's `compose.include.filter` structure. `intersectCodes` holds code lists from `compose.include[].valueSet` intersection — when a component references another ValueSet that resolves to a concept enumeration, those codes are captured here for efficient SQL `IN` pushdown. The `text` field holds free-text search terms when present.

---

## Compilation Pipeline

### Step 1: Build IR

Pure function (`buildIRFromValueSet`). Walks `ValueSet.compose.include[]` and `.exclude[]`, producing one IR node per component. Multiple includes become a `union`; excludes produce a `diff(union-of-includes, union-of-excludes)`.

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

### Step 2: Resolve Imports

Async (`resolveImports`). Walks the IR tree, finds `import` nodes, calls a resolver callback to fetch the referenced ValueSet, builds its IR recursively, and attaches it as `import.resolved`. Includes cycle detection.

### Step 3: Optimize

The `optimize()` function in `rewrite.js` runs a series of pure rewrite passes over the IR tree:

- **flatten** — nested unions/intersects → single level
- **coalesce** — merge selectors with same system/version/shape (e.g., two concept enumerations for the same system become one with combined code lists; filter selectors with identical signatures are deduplicated)
- **eliminateEmpty** — prune empty branches
- **partitionDiff** — split multi-system diff operations into per-system diffs for better dispatch

Separate utility functions used by the orchestrator during dispatch:

- **collectSystems** — extract the set of code systems in the tree
- **projectToSystem** — extract the subtree for one system (used for per-system dispatch)
- **splitDiffRoot** — separate a top-level diff into include/exclude parts for providers that handle them differently

### Step 4: Orchestrate

The orchestrator (`expandViaIR`) coordinates the expansion pipeline:

1. Build IR from ValueSet (threads compose-level `meta` into IR nodes)
2. Resolve imports (if resolver callback provided)
3. Optimize IR tree
4. Collect systems, sort canonically by `system|version`
5. **Provider lookup**: find provider for each system, wrap in `LegacyIRAdapter` if needed, collect provider metadata (content mode, standards status, etc.)
6. **Counting phase**: call `countForIR()` on each system (or derive statically for concept enumerations)
7. **Stride pagination**: compute which systems fall within `[offset, offset+count)` window
8. **Execution phase**: dispatch `executeIR()` to each system within its pagination window
9. **Decoration**: bulk-load designations and properties per system
10. **Apply overrides**: apply compose-level display/designation overrides from IR `meta`
11. **Filter designations**: apply `designations` parameter filtering, language filtering, redundancy suppression
12. Build FHIR expansion response (including `used-codesystem`, `used-valueset`, unclosed warnings)

#### Stride Pagination

Systems are processed in canonical order. For a multi-system ValueSet with `offset` and `count`, the orchestrator computes which codes from each system fall within the requested window. This means no single system ever materializes more than `count` rows.

Example: ValueSet spans SNOMED (124 codes) + LOINC (66K codes), request `offset=120, count=10`:
- SNOMED contributes codes 120-123 (4 codes)
- LOINC contributes codes 0-5 (6 codes)
- Systems before offset=120 are skipped entirely

#### Special Cases

- **count=0**: Only counting phase runs, returns total without materializing codes
- **count guard**: Negative counts (e.g., -1 from parameter edge cases) are clamped; they never reach providers
- **No provider**: If any system lacks a provider, returns `null` (caller falls back to legacy)
- **Text filter**: Passed to both `countForIR()` and `executeIR()` for consistency
- **activeOnly**: Filters inactive concepts
- **Unclosed expansions**: Grammar-based providers (UCUM, MIME, language) signal when they can't enumerate all codes. The orchestrator accumulates these messages and emits `valueset-unclosed` extensions on the expansion. This signal propagates through set operations — if one branch of a union is unclosed, the union result is unclosed.
- **Too-costly detection**: Providers that can't enumerate at all (e.g., MIME types, language tags without a `specialEnumeration()`) throw `isTooCostly`, which surfaces as an HTTP 4xx rather than silently degrading

---

## Provider Interface

Providers can support IR expansion by implementing one or more of these methods:

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

### Detection

The orchestrator checks `provider.hasExecuteIR()`. If true, IR methods are called directly. If false, the provider is automatically wrapped in a `LegacyIRAdapter`.

## Execution Modes

### Mode 1: Native IR Execution

Providers with `hasExecuteIR() = true` implement the IR interface directly. The v0 SQLite provider compiles IR subtrees into SQL:

The SQL builder translates IR nodes into SQL against the v0 schema:

| IR node | SQL pattern |
|---------|-------------|
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

Property alias resolution uses the `cs_config` table to map FHIR property names to database columns (e.g., SNOMED's `concept` → `Is a` hierarchy property).

### Mode 2: Legacy Adapter

Providers without native IR support are automatically wrapped in a `LegacyIRAdapter`. The adapter tree-walks the IR at runtime, calling the provider's existing filter protocol methods:

- **selector(shape=concept)** — calls `provider.locate(code)` per code
- **selector(shape=filter)** — calls filter protocol: `getPrepContext()` → `filter()` → `executeFilters()`
- **selector(shape=whole)** — calls `iteratorAll()`
- **union/intersect/diff** — composed in JavaScript using membership indexes

The adapter handles:
- **Text filtering**: Applied as post-filter (legacy providers lack FTS)
- **Pagination**: Sort + slice after materialization
- **Counting**: Materializes then counts (acceptable for small providers)
- **Grammar-based providers**: When `iteratorAll()` returns `null` (grammar-based systems can't enumerate), the adapter checks `specialEnumeration()` for a common-units ValueSet (e.g., UCUM). If one exists, it expands that ValueSet and tags the result as unclosed. If none exists, it throws `isTooCostly`.
- **Unclosed propagation**: A `propagateUnclosed()` helper threads the unclosed signal through union/diff/intersect — if any child is unclosed, the composed result carries the signal forward.

The adapter returns `{ candidates, unclosed? }` in the same format as native providers. The orchestrator treats both modes uniformly.

---

## The v0 SQLite Provider

A generic code system provider for the v0 SQLite database schema used by FHIRsmith's importers. Supports SNOMED, LOINC, RxNorm, and any other terminology stored in v0 format.

### Database schema (v0)

```
code_system      ─ base_uri, version, name, content_mode
concept          ─ code, display, active, abstract, definition
concept_link     ─ source_concept_id → target_concept_id (hierarchy edges)
concept_literal  ─ property_id, value (code properties as strings)
closure          ─ ancestor_id → descendant_id (transitive closure)
designation      ─ concept_id, language, use_code, term, active, preferred
property_def     ─ property_id, code, uri, type
cs_config        ─ JSON blob: hierarchy, filters, search, languages
value_set        ─ url, JSON definition for implicit value sets
search_fts_*     ─ FTS5 tables for text search
```

### Dual-Mode Support

The v0 provider implements both the legacy filter protocol and native IR methods:

**Legacy protocol** — Full `CodeSystemProvider` API for compatibility with legacy `ValueSetExpander`:
- Concept lookup: `locate()`, `locateIsA()`
- Filter protocol: `getPrepContext()`, `filter()`, `executeFilters()`, `filterMore()`, `filterConcept()`
- Hierarchy: `hasParents()`, `parent()`
- Metadata: `display()`, `definition()`, `designations()`, `properties()`
- Capabilities: `doesFilter()`, `buildKnownValueSet()`, `subsumesTest()`

**IR methods** — Native compilation to SQL (see "Mode 1" above):
- `executeIR()` — full IR subtree execution
- `countForIR()` — optimized counting
- `membershipForIR()` — membership testing

### Runtime Configuration

The provider reads `cs_config` table JSON to build a normalized runtime configuration:

- **hierarchy** — which property defines parent→child edges
- **filters.properties.aliases** — FHIR property → DB property mapping
- **search** — multi-source FTS configuration
- **languages** — default language for displays
- **status** — which property holds concept status
- **defaultCodeRegex** — filter for `iteratorAll()` (excludes metadata)
- **version.partialMatch** — enables prefix-matching for date-based versions

This approach makes the provider generic: the same code handles SNOMED, LOINC, RxNorm, etc. All terminology-specific behavior is data-driven.

---

## Decoration and Overrides

### Bulk Designation Loading

After candidate selection, designations are loaded in bulk per system. This is more efficient than loading per-concept during iteration.

Designation filtering (applied in this order):
1. **By use**: Filter to specific `use` system|code pairs (via `designations` parameter)
2. **By language**: Filter to requested `displayLanguage` or HTTP `Accept-Language`
3. **Redundancy suppression**: Omit designations where `designation.value === concept.display` (avoids echoing the display as a designation)

### Compose-Level Overrides

FHIR allows `compose.include[].concept[].display` and `.designation[]` to override code system values. The orchestrator carries these overrides through the IR tree in `meta` fields, then applies them after bulk decoration:

1. **`collectComposeOverrides()`** — walks the resolved IR tree to extract per-code display and designation overrides from compose components
2. **`applyComposeOverrides()`** — patches the decorated candidates, replacing provider-sourced displays and adding compose-sourced designations
3. Designation overrides only apply when `includeDesignations` is active

This pattern centralizes override logic and keeps it separate from provider concerns.

### Property Decoration

When the `properties` parameter is present, the orchestrator requests specific properties from providers and includes them in the expansion response.

### Expansion Response Metadata

The `buildExpandedValueSet()` function emits standard FHIR expansion parameters and extensions:

- **`used-codesystem`** — one per system, with version when known
- **`used-valueset`** — URLs of all transitively resolved imports
- **`valueset-unclosed`** extension — when any system signals unclosed (grammar-based providers) or has fragment content mode
- **Parameter echo** — reflects `includeDesignations`, `displayLanguage`, `offset`, `count`, `activeOnly` back in the expansion parameters
- **`total`** — always present (even when `count=0`)

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

**Callbacks:**
- **findProvider(system, version)** — locate provider for a code system
- **resolveValueSet(url)** — fetch imported ValueSets

**Parameters passed through:** `activeOnly`, `text`, `offset`, `count`, `includeDesignations`, `properties`, `designations`, `displayLanguage`. These map directly to the FHIR `$expand` operation parameters. The orchestrator doesn't interpret them beyond threading them to the right pipeline stage.

### Activation and mode control

The decision between IR and legacy happens in `performExpansion()` at
line ~1961 of `expand.js`:

```js
const engineOverride = params._engine;
const useIR = engineOverride === 'ir'
  || (engineOverride !== 'legacy' && process.env.EXPAND_IR_ENGINE === '1');
```

Three inputs feed this decision:

#### 1. Server-wide default: `EXPAND_IR_ENGINE` env var

Set in the process environment. When `=1`, the IR engine is tried first
for every `$expand` request, with automatic fallback to legacy if the IR
engine can't handle the ValueSet.

The systemd service sets this:

```ini
# /etc/systemd/system/fhirsmith.service
[Service]
Environment=EXPAND_IR_ENGINE=1
ExecStart=/.../node server.js
```

To disable IR server-wide, remove the env var or set it to any value
other than `1`, then `sudo systemctl restart fhirsmith`.

#### 2. Per-request override: `_engine` query parameter

Clients can override the server default on any `$expand` request:

```
# Force IR engine (no legacy fallback)
GET /r4/ValueSet/$expand?url=...&_engine=ir

# Force legacy expander (skip IR entirely)
GET /r4/ValueSet/$expand?url=...&_engine=legacy

# Use server default
GET /r4/ValueSet/$expand?url=...
```

Also works in POST bodies as a Parameters resource:
```json
{ "name": "_engine", "valueString": "ir" }
```

The `_engine` parameter is parsed in `tx/params.js` (the underscore
prefix marks it as a non-standard extension parameter).

#### 3. Decision matrix

| `EXPAND_IR_ENGINE` env | `_engine` param | Behavior |
|------------------------|-----------------|----------|
| unset or `!=1` | (none) | Legacy only |
| unset or `!=1` | `ir` | IR, error if unsupported |
| unset or `!=1` | `legacy` | Legacy only |
| `1` | (none) | IR first, legacy fallback |
| `1` | `ir` | IR, error if unsupported |
| `1` | `legacy` | Legacy only (overrides env) |

#### Fallback Behavior

The IR engine performs these checks:

1. **`canHandleValueSet(vsJson)`** — does the ValueSet have a valid `compose`?
2. **Provider lookup** — can we find a provider for every system? If not, returns `null` (legacy fallback)
3. **Execution** — if execution throws:
   - `isTooCostly` errors are re-thrown (not caught)
   - Other errors are logged and trigger legacy fallback

This allows the IR engine to gracefully decline ValueSets it can't handle, while ensuring resource-intensive errors surface properly.

#### Comparison Testing

The `_engine` parameter enables side-by-side comparison:

```bash
curl '.../$expand?url=...&_engine=ir'   > /tmp/ir.json
curl '.../$expand?url=...&_engine=legacy' > /tmp/legacy.json
```

End-to-end comparison tests use this to verify structural parity between engines.

---

## Legacy Path with v0 Provider

When `_engine=legacy` is used, the existing `ValueSetExpander` drives expansion. The v0 provider participates through the standard **filter protocol** — the same API all providers implement.

### Filter Protocol Sequence

```
1. cs.getPrepContext()              → create filter context
2. cs.filter(ctx, prop, op, value)  → accumulate filters (×N)
3. cs.executeFilters(ctx)           → run SQL, return result set
4. loop:
     cs.filterMore(ctx, set)        → check if more rows
     cs.filterConcept(ctx, set)     → return next concept
     cs.parent(concept)             → get parent (for hierarchy)
     expander.includeCode(...)      → add to expansion
```

For concept enumeration, the expander calls `cs.locate(code)` per code instead.

### Key Differences

| Aspect | Legacy + v0 | IR + v0 |
|--------|-------------|----------|
| SQL queries | 1 filter + N parent lookups | 1 total |
| Designation loading | Per-concept during iteration | Bulk after selection |
| Hierarchy | Built via `parent()` calls | Not built (flat) |
| count=0 | Full expansion, then count | `SELECT COUNT(*)` |
| Pagination | Materialize all, slice | `LIMIT/OFFSET` in SQL |

For details on hierarchical vs. flat expansion behavior, see `docs/legacy-expansion-gap.md`.

---

## Behavioral Differences: IR vs Legacy

### Output Structure

The IR engine always returns **flat** expansions (no nested `.contains`). The legacy expander may return **hierarchical** output when the provider implements `parent()` (currently only v0 SQLite).

| Behavior | IR engine | Legacy + v0 |
|----------|-----------|-------------|
| Output shape | Always flat | May be hierarchical |
| `excludeNested` | Always honored (flat) | Controls nesting |
| Pagination | Always works | Only for flat (per spec) |
| `count=0` | Efficient `COUNT(*)` | Full expansion then count |

See `docs/legacy-expansion-gap.md` for details on hierarchy behavior.

### Code-for-Code Parity

Comparison tests verify IR and legacy return identical code sets for standard operations (is-a filters, set difference, concept enumeration, property filters, pagination). Minor differences:
- Designation filtering: IR applies bulk filters, legacy may include inactive
- Display values: Both respect compose-level overrides
- Properties: Both support property decoration

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

These enable efficient set operations without materializing intermediate results.

---

## Testing Strategy

### Primary: HTTP Test Harness

**`scripts/ir-harness.mjs`** is the primary test artifact — 128 HTTP tests that exercise the IR engine end-to-end against a running server. Tests are organized by development phase:

- **Core operations** — all selector shapes (whole, concept, filter), set operations (union, intersect, diff), multi-system ValueSets
- **Pagination** — stride dispatch, deep offsets, count=0, page reconstruction
- **Decoration** — compose-level display/designation overrides, designation filtering by use/language, redundancy suppression, property decoration, displayLanguage
- **Text search** — FTS across SNOMED, LOINC, RxNorm
- **Grammar-based providers** — UCUM (unclosed via specialEnumeration), MIME types (too-costly), language tags, US states, area codes
- **Parameter echoing** — used-codesystem, used-valueset, includeDesignations, count/offset

The harness supports `--legacy` to run the same suite against the legacy engine, and `--perf` to generate an HTML performance comparison table.

### IR Optimizer Tests

**`scripts/ir-rewrite-tests.mjs`** — unit tests for the rewrite passes (coalescing, partitioning, deduplication). These run without a server.

### Jest Unit Tests

The `tests/engine/` and `tests/cs/` directories contain Jest tests for individual modules:

- `tests/cs/cs-sqlite-v0.test.js` — v0 provider: both legacy filter protocol and native IR methods
- `tests/engine/orchestrator.test.js` — pipeline coordination, pagination, special cases
- `tests/engine/legacy-ir-adapter.test.js` — adapter bridging, set operations, membership
- `tests/engine/comparison.test.js` — IR vs legacy code-set parity
- `tests/engine/e2e-comparison.test.js` — full HTTP response structural comparison

These remain useful for fast iteration on individual components, but the HTTP harness is the source of truth for overall correctness.

---

## Module Organization

### Core IR Engine

| Module | Purpose |
|--------|---------|
| `tx/engine/ir.js` | IR node type constructors |
| `tx/engine/build-ir.js` | ValueSet JSON → IR compiler |
| `tx/engine/resolve-imports.js` | Async import inlining with cycle detection |
| `tx/engine/rewrite.js` | IR optimization passes |
| `tx/engine/orchestrator.js` | Pipeline orchestrator and coordination |
| `tx/engine/legacy-ir-adapter.js` | Adapter bridging legacy providers to IR |
| `tx/engine/membership.js` | Composable set-membership types |
| `tx/engine/sqlite-v0-sql.js` | IR → SQL compiler for v0 schema |
| `tx/engine/expand-trace.js` | Structured tracing support |
| `tx/engine/index.js` | Public API exports |

### Providers

| Module | Purpose |
|--------|---------|
| `tx/cs/cs-sqlite-v0.js` | Generic v0 SQLite provider (dual-mode) |
| Existing providers | Unchanged, automatically wrapped by adapter |

### Integration Points

| File | Change |
|------|--------|
| `tx/workers/expand.js` | Added `_tryIRExpansion()` entry point |
| `tx/params.js` | Added `_engine` parameter parsing |
| `tx/library.js` | Added v0 SQLite database loader |
| `package.json` | Added `better-sqlite3` dependency |

### Documentation

- `docs/ir-engine.md` — This document (architecture)
- `docs/ir-engine-gap-plan.md` — Phase-by-phase implementation history
- `docs/legacy-expansion-gap.md` — Behavioral differences analysis

---

## Structured Tracing

The IR engine includes structured tracing support (`tx/engine/expand-trace.js`) using `AsyncLocalStorage`. Zero-cost when inactive.

Activated via `_trace=true` query parameter. Trace data is attached to the expansion response as a FHIR extension:

```
expansion.extension[].url = "http://fhirsmith.org/StructureDefinition/expand-trace"
expansion.extension[].valueString = <JSON trace>
```

Trace output includes:
- Hierarchical span tree (orchestration phases, per-system dispatch)
- SQL query details (text, params, row counts, timing)
- Pagination decisions
- Optimization notes

This enables debugging and performance analysis without modifying code.

---

## Performance Characteristics

### Where IR Wins

**Large result sets** (>200 codes)  
SQL pushdown (LIMIT/OFFSET, FTS5, set operations) avoids materializing full result. Legacy must iterate all codes and build hierarchy.

**Property filters on large code systems**  
Single SQL query vs. legacy's per-concept iteration.

**Text search**  
FTS5 index vs. legacy's post-filter.

**Excludes**  
SQL `EXCEPT` vs. legacy's N parent queries.

**count=0 queries**  
`SELECT COUNT(*)` vs. full expansion then count.

**Multi-system stride pagination**  
Per-system offset/count pushdown vs. materialize-all-then-slice.

### Where They're Close

Small expansions (<200 codes) show near-parity. IR has ~2ms orchestrator overhead; legacy has per-concept designation loading. Net difference typically <1.5×.

### Measurement

Run `node scripts/ir-harness.mjs --perf` to generate fresh performance comparison table.

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

The v0 provider reads all behavior from `cs_config` table. No terminology-specific code; the same provider handles SNOMED, LOINC, RxNorm, etc. identically.


---

## See Also

- **docs/ir-engine-gap-plan.md** — Phase-by-phase implementation history and test porting plan
- **docs/legacy-expansion-gap.md** — Analysis of hierarchical vs. flat expansion behavior
- **scripts/ir-harness.mjs** — HTTP test harness for IR engine verification
- **scripts/ir-rewrite-tests.mjs** — Unit tests for IR optimizer passes
