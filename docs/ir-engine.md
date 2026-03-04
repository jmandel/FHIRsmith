# IR-Based ValueSet Expansion Engine

## Overview

The `ir-engine` branch adds an intermediate representation (IR) compiler and
execution engine for FHIR ValueSet `$expand` operations. It sits alongside
the existing legacy `ValueSetExpander` in `tx/workers/expand.js` — both
paths are available at runtime, selectable per-request.

The IR engine compiles a ValueSet's `compose` into a tree of semantic nodes,
optimizes it, partitions by code system, and dispatches each subtree to the
appropriate provider. Providers with native SQL support (v0 SQLite) execute
the entire subtree as a single query. All other providers are wrapped in a
tree-walking adapter that calls their existing filter protocol methods.

### Why

The legacy `ValueSetExpander` is a 2000-line monolith that interleaves
parsing, filtering, hierarchy building, pagination, and output formatting.
Adding features (count=0, used-codesystem reporting, multi-system support)
requires modifying deeply nested control flow. The IR approach separates
concerns:

1. **Parse** — ValueSet JSON → IR tree (pure, no I/O)
2. **Optimize** — flatten, deduplicate, simplify (pure)
3. **Execute** — dispatch to providers (I/O, per-system)
4. **Decorate** — add designations, properties (I/O, bulk)
5. **Format** — build FHIR response (pure)

### What changed from upstream/main

18 commits, ~6000 lines added across 22 files. Zero upstream files modified
except:
- `tx/workers/expand.js` — 71 lines added: `_tryIRExpansion()` entry point
- `tx/params.js` — 4 lines: `_engine` parameter parsing
- `tx/library.js` — 21 lines: v0 SQLite database loader
- `package.json` — `better-sqlite3` dependency

All new code lives in `tx/engine/` (8 modules) and `tx/cs/cs-sqlite-v0.js`
(1230-line provider). Five test suites with 79 tests.

---

## Architecture

```
ValueSet JSON
     │
     ▼
┌─────────────┐
│  build-ir   │  ValueSet.compose → IR tree
└──────┬──────┘
       │
       ▼
┌─────────────┐
│resolve-imports│  Inline imported ValueSets
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   rewrite   │  Flatten, dedupe, project-to-system
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
       ┌─────────────┐
       │  decorate    │  Bulk designations + properties
       └──────┬──────┘
              │
              ▼
       FHIR ValueSet expansion response
```

---

## IR Node Types (`tx/engine/ir.js`, 83 lines)

The IR is a small algebraic type system. Six node kinds:

| Kind | Fields | Meaning |
|------|--------|---------|
| `empty` | — | No codes |
| `selector` | system, version, shape, conceptCodes, filterClauses, text | Leaf: one code system component |
| `import` | url, version, resolved? | Reference to another ValueSet |
| `union` | items[] | Set union (include + include) |
| `intersect` | items[] | Set intersection (include with multiple valueSets) |
| `diff` | left, right | Set difference (include minus exclude) |

The `selector` node's `shape` field indicates what kind of content:
- `'all'` — entire code system
- `'concepts'` — enumerated code list
- `'filter'` — property filters (is-a, =, in, regex, etc.)

`filterClauses` is an array of `{ property, op, value }` objects matching
FHIR's `compose.include.filter` structure.

---

## Compilation Pipeline

### Step 1: build-ir (`tx/engine/build-ir.js`, 76 lines)

Pure function. Walks `ValueSet.compose.include[]` and `.exclude[]`,
producing one IR node per component. Multiple includes become a `union`;
excludes produce a `diff(union-of-includes, union-of-excludes)`.

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

### Step 2: resolve-imports (`tx/engine/resolve-imports.js`, 153 lines)

Async. Walks the IR tree, finds `import` nodes, calls a resolver callback
to fetch the referenced ValueSet, builds its IR recursively, and attaches
it as `import.resolved`. Cycle detection via URL set.

### Step 3: rewrite (`tx/engine/rewrite.js`, 435 lines)

Pure optimization passes:

- **flatten** — nested unions/intersects → single level
- **eliminateEmpty** — prune empty branches
- **collectSystems** — extract the set of code systems in the tree
- **projectToSystem** — extract the subtree for one system (used for
  per-system dispatch)
- **splitDiffRoot** — if the root is `diff(A, B)`, split into include/
  exclude subtrees for providers that handle exclusion natively

### Step 4: orchestrate (`tx/engine/orchestrator.js`, 391 lines)

Async. The main entry point `expandViaIR()` does:

1. Build IR from ValueSet
2. Resolve imports
3. Optimize
4. Collect systems → for each system, find provider
5. Per-system: project IR, dispatch to provider's `executeIR()`
6. Aggregate candidates across systems (union, respecting diff)
7. Apply text filter, activeOnly, offset/count pagination
8. Decorate with designations and properties (bulk)
9. Build FHIR response with `buildExpandedValueSet()`

Also handles:
- `count=0` — uses `countForIR()` for efficient total-only
- `used-codesystem` — collected at dispatch time as `system|version`
- Multi-system ValueSets — each system dispatched independently
- Fallback — if any system lacks a provider, returns null (caller
  falls back to legacy)

---

## Execution Modes

### Mode 1: Native SQL (v0 SQLite provider)

The `SqliteV0Provider` in `tx/cs/cs-sqlite-v0.js` implements three IR
methods directly:

- **`executeIR(subtree, opts)`** — compiles the IR subtree into a single
  SQL query via `sqlite-v0-sql.js`, runs it against the v0 database.
  Handles union/intersect/diff at the SQL level. Returns `{ candidates }`.

- **`countForIR(subtree, opts)`** — same SQL compilation but wraps in
  `SELECT COUNT(*)` for efficient total-only mode.

- **`membershipForIR(subtree)`** — returns a `Membership` object (from
  `membership.js`) for code-level `∈` testing without materializing the
  full expansion.

The SQL builder (`sqlite-v0-sql.js`, 482 lines) translates IR nodes into
SQL against the v0 schema:

| IR node | SQL pattern |
|---------|-------------|
| selector(shape=all) | `SELECT * FROM concept WHERE cs_id=? AND active=1` |
| selector(shape=concepts) | `... WHERE code IN (?,?,?)` |
| selector(filter is-a) | `JOIN closure ON descendant_id = concept_id WHERE ancestor_id = (SELECT concept_id FROM concept WHERE code=?)` |
| selector(filter =) | `JOIN concept_literal ON ... WHERE value = ?` |
| selector(filter in) | `... WHERE value IN (?,?,?)` |
| selector(filter regex) | Full scan + JS regex via `concept_literal` |
| union | `UNION` of sub-queries |
| intersect | `INTERSECT` of sub-queries |
| diff | `EXCEPT` or `LEFT JOIN ... WHERE right IS NULL` |

Property alias resolution uses the `cs_config` table's
`filters.properties.aliases` to map FHIR property names to database
column names (e.g., SNOMED's `concept` → `Is a` hierarchy property).

### Mode 2: LegacyIRAdapter (any provider)

`tx/engine/legacy-ir-adapter.js` (281 lines) wraps any `CodeSystemProvider`
to give it IR support without modification. It tree-walks the IR at runtime:

- **selector(shape=concepts)** — calls `provider.locate(code)` per code
- **selector(shape=filter)** — calls `getPrepContext()` → `filter()` →
  `executeFilters()` → `filterMore()`/`filterConcept()` loop
- **selector(shape=all)** — calls `iteratorAll()`
- **union/intersect/diff** — composed in JS using membership index types

The adapter returns candidates in the same `{ candidates }` format as
native providers. The orchestrator doesn't know or care which mode ran.

### Mode selection

The orchestrator checks `provider.hasExecuteIR()`. If true, calls
`provider.executeIR()` directly. If false, wraps with
`wrapWithLegacyIR(provider)` first. The v0 provider always returns true;
upstream providers (cs-snomed.js, cs-loinc.js, etc.) return false and
get the adapter.

---

## The v0 SQLite Provider (`tx/cs/cs-sqlite-v0.js`, 1230 lines)

A generic code system provider for the v0 SQLite database schema used by
FHIRsmith's importers. Supports SNOMED, LOINC, RxNorm, and any other
terminology stored in v0 format.

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

### Two layers

**Layer 1 — Legacy filter protocol.** The provider implements the full
upstream `CodeSystemProvider` API so the legacy `ValueSetExpander` can
use it as a drop-in:

- `locate(code)` / `locateIsA(code, parent)` — concept lookup
- `getPrepContext()` / `filter()` / `executeFilters()` / `filterMore()` /
  `filterConcept()` — filter iteration protocol
- `hasParents()` / `parent()` — hierarchy for nested expansion
- `designations()` / `display()` / `definition()` — display data
- `properties()` / `isAbstract()` / `isInactive()` — concept metadata
- `iteratorAll()` / `iteratorFilter()` — full enumeration
- `doesFilter()` — capability declaration per property/op
- `buildKnownValueSet()` — implicit value sets from cs_config
- `subsumesTest()` — bidirectional closure-table subsumption

**Layer 2 — Native IR execution.** Three methods that compile IR subtrees
into SQL (see "Mode 1" above). These bypass the filter protocol entirely.

### Runtime configuration

`buildRuntimeConfig(rawCfg, system)` reads the `cs_config` table's JSON
and builds a normalized runtime config:

- **hierarchy** — which property defines parent→child edges (e.g.,
  SNOMED's `Is a`)
- **filters.properties.aliases** — maps FHIR property codes to DB
  property codes (e.g., `concept` → `Is a` for SNOMED)
- **filters.properties.defaults** — default supported operators per
  property type
- **search** — multi-source search config (display, designation, literal)
- **languages** — default language for display designations
- **status** — which property holds concept status (e.g., LOINC's `STATUS`)
- **defaultCodeRegex** — regex filter for `iteratorAll()` (excludes
  metadata concepts)
- **version.partialMatch** — enables prefix-matching for SNOMED
  date-based versions

Property filter resolution (`#resolvePropertyFilterConfig`) merges
per-property config with defaults, resolving aliases to find the actual
DB property. `normalizedFilterCandidates()` generates all possible
match candidates (raw, aliased, case-normalized) for flexible matching.

---

## Integration with expand.js

The IR engine is wired into the existing `expand.js` via a single method:

```js
// tx/workers/expand.js, line ~1961
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

### Activation

| Mechanism | Scope | Effect |
|-----------|-------|--------|
| `EXPAND_IR_ENGINE=1` env var | Server-wide default | IR first, legacy fallback |
| `_engine=ir` query param | Per-request | Force IR, fail if unsupported |
| `_engine=legacy` query param | Per-request | Force legacy, skip IR |
| Neither env var nor param | Per-request | Legacy only (current default) |

The systemd service at `/etc/systemd/system/fhirsmith.service` sets
`EXPAND_IR_ENGINE=1` so the running server uses IR by default.

### Fallback

If `_tryIRExpansion()` returns null (unsupported ValueSet shape, missing
provider, etc.), `performExpansion()` silently falls through to the legacy
path. The `_engine=ir` override bypasses this fallback — it returns null
which becomes an error.

---

## Behavioral Differences: IR vs Legacy

### Output structure

The IR engine always returns a **flat** expansion (no nested `.contains`).
The legacy expander may return a **hierarchy** when the provider implements
`parent()` — currently only the v0 SQLite provider does this.

| Behavior | IR engine | Legacy + v0 | Legacy + cs-snomed.js (tx.fhir.org) |
|----------|-----------|-------------|-------------------------------------|
| Output shape | Always flat | Hierarchical (nested `.contains`) | Flat (accidental¹) |
| `excludeNested=true` | No effect (already flat) | Flattens output | No effect (already flat) |
| `excludeNested=false` | No effect | Preserves hierarchy | No effect |
| Pagination | Always works | Only for flat expansions (per spec) | Always works |
| `count=0` | Efficient `COUNT(*)` SQL | Full expansion then count | Full expansion then count |
| `used-codesystem` | Collected at dispatch | Set by legacy expander | Set by legacy expander |

¹ `cs-snomed.js` has `hasParents()=true` but never overrides `parent()`
(returns null from base class), so no nesting is possible. See
`docs/legacy-expansion-gap.md` for details.

### Code-for-code parity

The e2e comparison tests verify that IR and legacy return identical code
sets for:
- SNOMED `is-a` filter (closure table traversal)
- SNOMED include-minus-exclude (set difference)
- SNOMED concept enumeration (explicit code list)
- LOINC property filter (`CLASSTYPE = 1`)
- Pagination (same codes per page, no overlap)
- Designations (IR subset of legacy²)

² IR bulk decoration filters inactive designations; legacy may include them.

### FHIR `excludeNested` parameter

FHIR R4 defines `excludeNested` (boolean, 0..1) as:
> Controls whether or not the value set expansion nests codes or not
> (i.e. ValueSet.expansion.contains.contains)

The spec says expansions MAY be hierarchical, and hierarchy is purely for
navigational assistance (no logical meaning). Paging only applies to flat
expansions.

Currently the IR engine does not echo `excludeNested` in response
parameters. This is a minor compliance gap — since IR output is always
flat, the parameter is effectively always honored, but it should be echoed
when provided.

---

## Membership Types (`tx/engine/membership.js`, 176 lines)

Composable set-membership objects for code-level `∈` testing without
materializing full expansions. Used by `membershipForIR()` and the
legacy adapter for intersect/diff operations.

| Type | Behavior |
|------|----------|
| `EmptyMembership` | Always returns false |
| `SetMembership` | O(1) lookup in a `Set` of codes |
| `SqlMembership` | Runs a parameterized SQL query per lookup |
| `UnionMembership` | True if any child membership is true |
| `IntersectMembership` | True if all child memberships are true |
| `DiffMembership` | True if left is true and right is false |

These are used when the orchestrator needs to check whether a code from
one system's expansion should be excluded by another system's diff clause.

---

## Test Suites

79 tests across 5 suites. All pass.

### `tests/cs/cs-sqlite-v0.test.js` (30 tests)

Unit tests for the v0 provider against real SNOMED/LOINC/RxNorm databases:
- Provider lifecycle (load, system, version, content mode)
- Concept lookup (locate, display, definition, isAbstract, isInactive)
- Hierarchy (hasParents, parent, subsumesTest)
- Filter protocol (getPrepContext, filter, doesFilter, executeFilters)
- Designations and properties
- Iterator (iteratorAll with defaultCodeRegex)
- Known value sets (buildKnownValueSet from cs_config)
- LOINC status property, search configuration
- RxNorm basic operations

### `tests/engine/orchestrator.test.js` (19 tests)

Integration tests for the full IR pipeline with mock and real providers:
- Single-system filter expansion
- Concept enumeration
- Include/exclude (diff)
- Pagination (offset + count)
- count=0 total-only mode
- used-codesystem parameter reporting
- Multi-system ValueSets
- Import resolution
- Text filter
- activeOnly filtering

### `tests/engine/comparison.test.js` (10 tests)

Code-for-code parity between IR `executeIR()` and legacy filter protocol:
- SNOMED is-a: same codes from both paths
- SNOMED concept enumeration: same lookup results
- Filter protocol round-trip: getPrepContext → filter → execute
- Count parity: `countForIR()` matches materialized count
- Empty results for non-existent concepts

### `tests/engine/legacy-ir-adapter.test.js` (11 tests)

Adapter wrapping upstream providers for IR support:
- Concept selector execution
- Filter selector execution via filter protocol
- All-codes selector execution
- Union/intersect/diff composition
- Membership testing
- Empty results for missing codes
- activeOnly filtering through adapter

### `tests/engine/e2e-comparison.test.js` (9 tests)

Full HTTP round-trip tests comparing `_engine=ir` vs `_engine=legacy`
responses from the running server:
- SNOMED is-a: same code set (legacy hierarchy flattened for comparison)
- SNOMED is-a: same displays
- SNOMED diff: same code set
- SNOMED concept enumeration: same codes and displays
- count=0: both return total only
- Pagination: same totals, no page overlap
- Designations: IR subset of legacy
- LOINC property filter: same code set
- used-codesystem parameter present in both

E2E tests require the server running on localhost:8000; they skip
automatically if the server is unavailable.

---

## Files Changed from upstream/main

### New files

| File | Lines | Purpose |
|------|-------|---------|
| `tx/engine/ir.js` | 83 | IR node type constructors |
| `tx/engine/build-ir.js` | 76 | ValueSet JSON → IR compiler |
| `tx/engine/resolve-imports.js` | 153 | Async import inlining with cycle detection |
| `tx/engine/rewrite.js` | 435 | IR optimization passes |
| `tx/engine/membership.js` | 176 | Composable set-membership types |
| `tx/engine/sqlite-v0-sql.js` | 482 | IR → SQL compiler for v0 schema |
| `tx/engine/orchestrator.js` | 391 | Pipeline orchestrator |
| `tx/engine/legacy-ir-adapter.js` | 281 | Tree-walking adapter for any provider |
| `tx/engine/index.js` | 48 | Public API re-exports |
| `tx/cs/cs-sqlite-v0.js` | 1230 | Generic v0 SQLite code system provider |
| `tests/cs/cs-sqlite-v0.test.js` | 416 | Provider unit tests |
| `tests/engine/orchestrator.test.js` | 504 | Orchestrator integration tests |
| `tests/engine/comparison.test.js` | 344 | IR vs legacy parity tests |
| `tests/engine/legacy-ir-adapter.test.js` | 232 | Adapter tests |
| `tests/engine/e2e-comparison.test.js` | 336 | E2E HTTP comparison tests |
| `tests/tx/fixtures/v0-test-library.yaml` | ~20 | Test database config |
| `docs/ir-engine.md` | this file | Architecture documentation |
| `docs/legacy-expansion-gap.md` | ~70 | Hierarchy nesting analysis |
| `PLAN-ir-engine.md` | 651 | Implementation plan (historical) |

### Modified upstream files

| File | Change |
|------|--------|
| `tx/workers/expand.js` | +71 lines: `_tryIRExpansion()`, `_engine` routing |
| `tx/params.js` | +4 lines: `_engine` parameter parsing |
| `tx/library.js` | +21 lines: `loadSqliteV0()` database loader |
| `package.json` | Added `better-sqlite3` dependency |

---

## Design Decisions

**IR over direct SQL.** The IR tree is an abstraction boundary. Providers
can execute it however they want — SQL, in-memory scan, API call. The v0
provider compiles to SQL; the adapter tree-walks. Future providers could
use different strategies.

**Adapter over rewrite.** Rather than modifying every upstream provider to
add `executeIR()`, the LegacyIRAdapter wraps them. This means zero changes
to cs-snomed.js, cs-loinc.js, etc. When a provider wants better
performance, it can add native `executeIR()` and the adapter is bypassed.

**Flat output.** The IR engine always returns flat expansions. This matches
tx.fhir.org's output and simplifies pagination. Hierarchy building could
be added as a post-processing step if needed, but the FHIR spec says
hierarchy is optional and purely navigational.

**Opt-in activation.** The IR engine is off by default (no env var = legacy
only). This makes it safe to merge — existing behavior is unchanged unless
you explicitly enable IR. Per-request `_engine` overrides allow A/B testing.

**Bulk decoration.** Designations and properties are added in a bulk pass
after candidate selection, not during iteration. This allows the SQL query
to focus on filtering and the decoration pass to batch lookups efficiently.

**better-sqlite3 over async SQLite.** The v0 databases are local files.
Synchronous access via better-sqlite3 is simpler, faster (no event loop
overhead), and matches the v0 schema's design for single-connection reads.

**cs_config driven.** The v0 provider reads all its behavior from the
`cs_config` table — hierarchy property, filter aliases, search sources,
status property, version matching. No terminology-specific code; the same
provider handles SNOMED, LOINC, and RxNorm identically.
