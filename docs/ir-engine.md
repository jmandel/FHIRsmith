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

### Step 4: orchestrate (`tx/engine/orchestrator.js`)

Async. The main entry point `expandViaIR()` does:

1. Build IR from ValueSet
2. Resolve imports
3. Optimize
4. Collect systems, sort canonically by `system|version`
5. **Phase 1 — count**: `countForIR()` each system (cheap, ~0.1–5ms)
6. **Phase 2 — stride pagination**: walk systems in canonical order,
   compute which systems fall within the `[offset, offset+count)` window,
   fetch only the codes needed from each (with per-system offset/count)
7. Decorate with designations and properties (bulk)
8. Build FHIR response with `buildExpandedValueSet()`

**Stride pagination** means no system ever materializes more than `count`
rows. For a ValueSet spanning SNOMED (124 codes) + LOINC (66K codes) with
`offset=120, count=10`: SNOMED gets `offset=120, count=4` (last 4 codes),
LOINC gets `offset=0, count=6` (first 6). Systems entirely before the
window are skipped without fetching any rows.

Also handles:
- `count=0` — sums per-system counts, returns total only (no SQL rows)
- `used-codesystem` — collected at dispatch time as `system|version`
- Fallback — if any system lacks a provider, returns null (caller
  falls back to legacy)
- Text filter — passed through to both `countForIR()` and `executeIR()`
  so counts and pages are consistent

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

### Mode 2: LegacyIRAdapter (`tx/engine/legacy-ir-adapter.js`)

Wraps any CodeSystemProvider to participate in IR expansion. Tree-walks
the IR at runtime, calling the provider's existing methods (locate, filter
protocol, iteratorAll). Internal nodes (union, intersect, diff) compose
via membership indexes.

The adapter handles:
- **Text filtering**: `display.includes(text)` after materialization
  (legacy providers have no FTS)
- **Pagination**: sorts by code, applies `offset`/`count` slice after
  materialization (legacy providers are small — gender=4, currencies=180)
- **Counting**: materializes + counts (cheap for small providers)

### Mode 2 (original):

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

#### Fallback behavior

When the IR engine is active (either via env var or `_engine=ir`), it
goes through a series of checks before executing:

1. **`canHandleValueSet(vsJson)`** — does the ValueSet have a `compose`
   with at least one include that has a system or valueSet import?
   Returns false for empty/malformed ValueSets.

2. **Provider lookup** — can we find a CodeSystemProvider for every system
   in the IR? If any system has no provider, `expandViaIR()` returns null.

3. **Execution** — if `executeIR()` throws, the error is caught and logged,
   and the legacy path runs instead.

When `_engine=ir` is explicit and IR returns null or throws, the request
still falls through to legacy (the error is logged but not surfaced).
This is arguably a bug — explicit `_engine=ir` should probably error
instead of silently falling back.

#### Using both engines for comparison

The `_engine` parameter makes it easy to compare outputs:

```bash
# Side-by-side comparison
curl 'http://localhost:8000/r4/ValueSet/$expand?url=...&_engine=ir'   > /tmp/ir.json
curl 'http://localhost:8000/r4/ValueSet/$expand?url=...&_engine=legacy' > /tmp/legacy.json

# The e2e comparison test suite does exactly this
npx jest tests/engine/e2e-comparison.test.js
```

This is how the 9 end-to-end comparison tests work — they hit the running
server with both `_engine=ir` and `_engine=legacy` and compare the FHIR
responses structurally.

---

## Legacy Path with v0 Provider

When `_engine=legacy` is used (or the IR engine is not enabled), the
existing `ValueSetExpander` in `expand.js` drives expansion. The v0
provider participates through the upstream **filter protocol** — the same
API that `cs-snomed.js`, `cs-loinc.js`, and all other providers implement.

### How the legacy expander calls the provider

The `ValueSetExpander.includeCodes()` method (line ~800 in `expand.js`)
processes each `compose.include` component. For filter-based includes it
follows this sequence:

```
1. cs.getPrepContext(iterate)       → FilterExecutionContext
2. cs.filter(ctx, prop, op, value)  → accumulate filter clauses  (×N filters)
3. cs.executeFilters(ctx)           → [V0FilterSet]  (SQL runs HERE)
4. loop:
     cs.filterMore(ctx, set)        → bool (cursor < rows.length?)
     cs.filterConcept(ctx, set)     → V0ConceptContext (advance cursor)
     cs.isInactive(concept)         → bool
     cs.code(concept)               → string
     cs.display(concept)            → string
     cs.parent(concept)             → string | null  (for hierarchy)
     cs.designations(concept, ...)  → populate display names
     cs.properties(concept)         → FHIR property array
     expander.includeCode(...)      → add to fullList + rootList
```

For concept-enumeration includes (explicit `concept: [{code: ...}]`), the
expander calls `cs.locate(code)` per code instead of the filter protocol.

### What happens inside the v0 provider

**`getPrepContext()`** creates a `FilterExecutionContext` with an empty
`_v0` object to accumulate filters.

**`filter(ctx, prop, op, value)`** appends `{property, op, value}` to
`ctx._v0.filters[]`. No SQL runs yet.

**`executeFilters(ctx)`** is where the real work happens. It:

1. Iterates accumulated filters, calling `#buildFilterFragment()` per filter
2. Each fragment produces SQL joins/wheres against the v0 schema:
   - `is-a` / `descendent-of` → `JOIN closure` on ancestor concept
   - `=` → `JOIN concept_literal` on property value
   - `in` → splits comma-separated values, `JOIN concept_literal ... IN (...)`
   - `regex` → full concept scan + JS `RegExp` post-filter
   - Text search → multi-source FTS across display/designation/literal tables
3. Assembles a single SQL query: `SELECT ... FROM concept c {joins} WHERE {wheres}`
4. Runs it synchronously via better-sqlite3
5. Applies post-filters (code regex, code-set intersection)
6. Wraps results in a `V0FilterSet` (array of rows + cursor)

So the SQL executes **once**, eagerly materializing all matching concepts.
The subsequent `filterMore()`/`filterConcept()` loop is just cursor
advancement over the in-memory result array — no further SQL.

**`#buildFilterFragment()`** uses `#resolvePropertyFilterConfig()` to map
FHIR property names through the cs_config alias chain. For example,
SNOMED's `concept` property alias resolves to the `Is a` hierarchy
property, which triggers a closure-table join:

```sql
-- is-a filter on SNOMED concept 73211009
JOIN closure cl_f0 ON cl_f0.descendant_id = c.concept_id
WHERE cl_f0.ancestor_id = (
  SELECT concept_id FROM concept WHERE code = '73211009' AND cs_id = 1
)
```

For `=` and `in` operators on literal properties:

```sql
-- LOINC CLASSTYPE = 1
JOIN concept_literal lit_f0
  ON lit_f0.source_concept_id = c.concept_id AND lit_f0.property_id = 42
WHERE lit_f0.value = '1'
```

### Hierarchy building

After `filterConcept()` returns each concept, the legacy expander checks
`cs.hasParents()`. The v0 provider returns `true` when the closure table
is populated. The expander then calls `cs.parent(concept)` which runs:

```sql
SELECT c2.code FROM concept_link cl
JOIN concept c2 ON c2.concept_id = cl.target_concept_id
WHERE cl.source_concept_id = ? AND cl.property_id = ? AND cl.active = 1
LIMIT 1
```

This returns the first parent via the hierarchy property (e.g., SNOMED's
`Is a` edge). The expander uses this to nest child codes inside their
parent's `.contains` array. At finalization, if `canBeHierarchy` is true
and the full list fits in `count`, the response uses `rootList` (top-level
codes with nested children) instead of `fullList` (flat).

This is why legacy+v0 produces hierarchical output with 90 top-level
entries for Diabetes mellitus, while the IR engine (and tx.fhir.org where
`cs-snomed.js` doesn't implement `parent()`) returns a flat 124. See
`docs/legacy-expansion-gap.md`.

### Performance characteristics

Both paths use the same v0 SQLite database. The key difference:

| Aspect | Legacy + v0 | IR engine + v0 |
|--------|-------------|----------------|
| SQL queries | 1 for filters + 1 per code for `parent()` | 1 total (or 1 COUNT) |
| Concept iteration | Row-by-row via filterMore/filterConcept | Bulk SQL result |
| Designation loading | Per-concept during iteration | Bulk batch after selection |
| Hierarchy | Built during iteration (N parent queries) | Not built (flat output) |
| count=0 | Full expansion, then count | `SELECT COUNT(*)` only |
| Pagination | Materializes all, then slices | `LIMIT/OFFSET` in SQL |

For a 124-code SNOMED is-a expansion, legacy makes ~125 SQL calls (1
filter query + 124 parent lookups). The IR engine makes 1. For count=0,
legacy still materializes all codes; IR runs a single `COUNT(*)` query.

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

## Tracing (`tx/engine/expand-trace.js`)

Ambient structured tracing using `AsyncLocalStorage`. Any code in the
expand call chain can log trace events without explicit argument threading.
Zero-cost when inactive (all calls hit frozen `NOOP_TRACE`/`NOOP_SPAN`).

Activated by `_trace=true` query parameter. The trace JSON is attached
to the expansion response as a FHIR extension:

```
expansion.extension[].url = "http://fhirsmith.org/StructureDefinition/expand-trace"
expansion.extension[].valueString = <JSON>
```

### Trace structure

```json
{
  "totalMs": 183.72,
  "sqlCount": 2,
  "sqlMs": 154.77,
  "counters": {},
  "spans": [
    {
      "name": "orchestrate",
      "children": [
        { "name": "countForIR", "ms": 154, "sql": [...] },
        { "name": "system:http://snomed.info/sct", "children": [
          { "name": "executeIR", "ms": 0.4, "sql": [...] }
        ]},
        { "name": "pagination", "ms": 0.01, "args": { "pushDown": true } },
        { "name": "bulkDesignations", "ms": 0.01 }
      ]
    }
  ]
}
```

### Instrumented points

| Location | Span/Event | Data |
|----------|-----------|------|
| orchestrator | `orchestrate` | top-level with args |
| orchestrator | `countForIR` | per-system count |
| orchestrator | `system:{url}` | per-system execution |
| orchestrator | `pagination` | total, offset, count, systems |
| orchestrator | `bulkDesignations` | candidate count |
| cs-sqlite-v0 | `executeIR:sql` | SQL text, params, rows, ms |
| cs-sqlite-v0 | `countForIR:sql` | SQL text, params, count, ms |
| sqlite-v0-sql | note: EXISTS rewrite | closureCount, conceptCount, ratio |

### API

```js
const { trace } = require('./expand-trace');
trace.begin('myMethod', { arg: 'x' }).end({ result: 42 });
trace.sql(sql, params, rowCount, elapsedMs, label);
trace.note('message', { detail: 'y' });
trace.count('counterName', 1);
```

---

## Performance Results

Median of 5 runs, cache disabled (`_nocache=true`), Node 24, single-threaded.
Generate a fresh HTML table with `node scripts/ir-harness.mjs --perf`
→ `tmp/perf-table.html`.

### IR wins: large sets, property filters, text search (7–30×)

| Query | IR | Legacy | Winner |
|-------|---:|-------:|--------|
| LOINC CLASSTYPE=1 (c=50, 66K total) | 76ms | 695ms | **IR ×9.1** |
| LOINC STATUS=ACTIVE (c=20, 96K total) | 108ms | 732ms | **IR ×6.8** |
| LOINC text=creatinine (c=20) | 63ms | 694ms | **IR ×11.0** |
| RxNorm TTY=IN (c=50, 14K total) | 24ms | 423ms | **IR ×17.6** |
| RxNorm text=aspirin TTY=IN | 12ms | 354ms | **IR ×29.5** |
| SNOMED Clinical finding 124K (c=50) | 188ms | 295ms | **IR ×1.6** |
| Multi-system stride: SCT is-a+LOINC (c=10,off=120) | 95ms | 720ms | **IR ×7.6** |

### IR wins: excludes (3–4×)

| Query | IR | Legacy | Winner |
|-------|---:|-------:|--------|
| Diabetes minus Type2 subtree (108) | 4ms | 14ms | **IR ×3.5** |
| Diabetes minus Type1+Type2 (86) | 4ms | 15ms | **IR ×3.8** |
| Diabetes exclude 2 enumerated codes | 3ms | 15ms | **IR ×5.0** |

### IR only: legacy errors on these

| Query | IR | Legacy |
|-------|---:|--------|
| SNOMED Clinical finding count=0 (124K) | 182ms | ❌ too-costly (>1000) |
| LOINC STATUS=ACTIVE off=1000 (96K) | 109ms | ❌ too-costly (>1000) |

### Near parity (≤200 codes)

| Query | IR | Legacy | Ratio |
|-------|---:|-------:|-------|
| SNOMED is-a Diabetes (124 codes) | 25ms | 18ms | Leg ×1.4 |
| SNOMED descendent-of Diabetes (123) | 22ms | 16ms | Leg ×1.4 |
| SNOMED is-a + text gestational (8) | 41ms | 29ms | Leg ×1.4 |
| SNOMED is-a + text insulin (24) | 17ms | 15ms | ≈ |
| SNOMED 3-code enum + designations | 2ms | 3ms | ≈ |
| SNOMED+LOINC+RxNorm enum (3) | 3ms | 7ms | IR ×2.3 |
| Mixed gender+SCT enum (5) | 2ms | 3ms | ≈ |
| Gender whole-system (4) | 1ms | 2ms | ≈ |

### Analysis

IR has a fixed ~2ms floor (orchestrator setup, IR compile, SQL build).
The remaining overhead for small SNOMED queries is the closure count
SQL (~8ms for `countForIR`). For large sets, IR's SQL pushdown
(LIMIT/OFFSET, EXISTS rewrite, FTS5) avoids materializing the full
result. Legacy must iterate all matching codes, build hierarchy, then
paginate — or error at the 1000-code limit.

IR now wins on excludes (3–5×) because SQL `EXCEPT` is cheaper than
legacy's N parent queries plus post-filter. The crossover point where
IR starts dominating is roughly **200 result codes**; below that the
two engines are within 1.5× of each other.

---

## Test Harness (`scripts/ir-harness.mjs`)

Standalone Node.js script that hits the running server and asserts concrete
expectations. 32 tests covering all provider types and query patterns.

```bash
node scripts/ir-harness.mjs              # run all 32
node scripts/ir-harness.mjs "refset"     # filter by name
node scripts/ir-harness.mjs --trace      # attach trace to each request
node scripts/ir-harness.mjs --perf       # run both engines, write tmp/perf-table.html
```

### Coverage matrix

| Category | Tests | Provider(s) |
|----------|-------|-------------|
| SNOMED is-a / descendent-of / count=0 | 4 | sqlite-v0 |
| Pagination (reconstruct, high offset) | 2 | sqlite-v0 |
| Excludes (subtree, multi, enum) | 3 | sqlite-v0 |
| Text search (FTS) | 4 | sqlite-v0 |
| Property filters (CLASSTYPE, STATUS, TTY) | 3 | sqlite-v0 |
| Concept enumeration + designations | 2 | sqlite-v0 |
| Whole-system cs-cs / legacy adapter | 4 | cs-cs (legacy) |
| Cross-provider enum (LOINC, RxNorm) | 2 | sqlite-v0 |
| Refset concept-in | 1 | sqlite-v0 |
| Same-system dedup | 1 | cs-cs (legacy) |
| Cross-system exclude | 1 | cs-cs × 2 |
| Text filter cross cs-cs | 1 | cs-cs × 2 |
| Mixed v0 + cs-cs | 4 | sqlite-v0 + legacy |

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
