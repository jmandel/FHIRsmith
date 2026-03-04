# Two new things: v0 SQLite provider + IR expansion engine

This branch introduces two independent pieces of work. They complement
each other, but each stands on its own:

1. **v0 SQLite code system provider** (`tx/cs/cs-sqlite-v0.js`) — a new
   CodeSystemProvider for SQLite-based terminologies. Works with both
   the original `ValueSetExpander` and the new IR engine, but is
   significantly faster and more complete when paired with the IR engine.

2. **IR expansion engine** (`tx/engine/`) — an alternative `$expand`
   implementation that works with all providers (v0, cs-cs, UCUM,
   country, currency, etc.).

---

## Part 1: The v0 SQLite provider

### Background

Grahame wrote an initial draft SQLite provider (`cs-db.js`) and then
removed it (`e748985`: "remove db draft - Josh will replace"). This is
the replacement. It uses `better-sqlite3` (synchronous, zero-copy reads)
against a normalized schema produced by FHIRsmith's importers. One `.db`
file per code system.

### What it provides

The v0 provider implements the full CodeSystemProvider interface — every
method the original `ValueSetExpander` calls:

- `locate(code)` — find a concept by code
- `code()`, `display()`, `definition()`, `status()`, `isAbstract()` —
  concept properties
- `designations()`, `properties()` — per-concept decoration
- `parent()`, `children()` — hierarchy traversal
- `getPrepContext()`, `filter()`, `executeFilters()`, `filterMore()`,
  `filterConcept()` — the filter protocol
- `iteratorAll()` — enumerate all concepts
- `totalCount()` — total concept count
- `buildKnownValueSet()` — implicit value sets from URL patterns

So it plugs straight into the original expander with no changes to
`expand.js`. SNOMED, LOINC, RxNorm, and any other terminology in v0
format all use the same generic provider — terminology-specific behavior
is driven entirely by a `cs_config` JSON blob in the database.

**It also implements the IR execution interface** — an optional set of
methods any provider can implement to let the IR engine call it directly
instead of going through the filter-protocol adapter:

- `executeIR(subtree, opts)` — execute an expansion plan subtree and
  return matching codes
- `countForIR(subtree, opts)` — count-only (no code materialization)
- `membershipForIR(subtree)` — "does code X belong to this set?" tester

The orchestrator checks for `executeIR` on the provider. If present,
it calls these methods directly. If absent, it wraps the provider in a
filter-protocol adapter that tree-walks the expansion plan and calls the
standard filter protocol methods instead.

The v0 provider is currently the only native implementation — it
compiles the entire subtree to a single SQL query, so unions, intersects,
diffs, hierarchy traversal, property filters, and text search all happen
in one database round-trip. This is where the big performance wins come
from. But any provider could implement the same three methods to get
the same direct-execution benefit.

When the original expander is active, none of this applies — it uses
the standard filter protocol methods listed above.

### Database schema

| Table | Contents |
|-------|----------|
| `code_system` | Base URI, version, name, content mode |
| `concept` | Code, display, active, abstract, definition |
| `concept_link` | Parent→child hierarchy edges |
| `closure` | Precomputed transitive closure (ancestor→descendant) |
| `concept_literal` | Property values (strings) keyed by property ID |
| `designation` | Designations: language, use code, term, active, preferred |
| `property_def` | Property definitions: code, URI, type |
| `cs_config` | JSON configuration blob (see below) |
| `value_set` | Implicit value set definitions |
| `search_fts_*` | FTS5 full-text search indexes |

### cs_config

All terminology-specific behavior comes from this JSON blob:

- **hierarchy** — which property defines parent/child (e.g. SNOMED's
  `Is a`)
- **filters.properties** — maps FHIR filter property names to DB
  property names, with aliases (e.g. SNOMED `concept` → `Is a`), value
  kind (literal vs concept-link), and match rules
- **search** — configures which columns participate in full-text search
  (display, designations, literal properties)
- **languages** — default display language
- **status** — which property holds concept active/inactive status
- **iteration.defaultCodeRegex** — regex filter for `iteratorAll()`
  (excludes metadata-only concepts)

### How it maps FHIR filter operations to SQL

| FHIR filter | What the v0 provider does |
|-------------|---------------------------|
| `is-a` | `JOIN closure` on precomputed transitive closure table |
| `descendent-of` | Same join, minus the root concept |
| Property `=` | `JOIN concept_literal WHERE value = ?` (or `JOIN concept_link` for concept-valued properties) |
| Property `in` | `JOIN concept_literal WHERE value IN (...)` |
| Property `regex` | `REGEXP` on code or on `concept_literal.value_text` |
| `concept-in` (refsets) | `JOIN concept_link` to refset members |
| Text search (`filter` param) | FTS5 full-text search across display, designations, properties |

With the original expander, these run as individual filter protocol
calls. With the IR engine, they're composed into a single SQL query per
system that can also handle unions, intersects, and excludes at the SQL
level.

### Specialization system

Some terminologies need behavior beyond the generic provider (e.g.
SNOMED post-coordinated expressions, LOINC implicit value set generation
from URL patterns). A specialization registry lets modules declare
interest in specific terminologies. At startup, the library checks the
registry and returns a specialized factory subclass when one matches.
With no specializations registered (the current state), you get the
generic provider.

### Loading

Configured in `library.js` via the `sqlite-v0:` source type. The YAML
config points to a `.db` file path:

```yaml
sources:
  - sqlite-v0:/path/to/snomed.db
  - sqlite-v0:/path/to/loinc.db
```

---

## Part 2: The IR expansion engine

### What it is

An alternative `$expand` implementation that runs alongside the existing
`ValueSetExpander`. Both are available at runtime — you pick which one
handles a request via the `_engine` query parameter, or via an
environment variable for the whole server.

### Why

The original `ValueSetExpander` does everything in one ~1,300-line pass:
parsing the compose, calling filters, building hierarchy, paginating,
formatting output. The IR engine breaks this into a pipeline of small,
independent steps:

1. **Read the compose** — turn `include[]`/`exclude[]` into an expansion
   plan (a tree that says "get these codes from SNOMED, union with those
   codes from LOINC, minus these exclusions")
2. **Resolve imports** — if any include references another ValueSet,
   fetch it and inline its compose (with cycle detection)
3. **Simplify** — merge redundant branches, deduplicate, split
   multi-system operations so each code system can be handled
   independently
4. **Execute** — hand each code system's piece to its provider; get back
   codes
5. **Decorate** — bulk-load designations and properties for the selected
   codes
6. **Build response** — assemble the FHIR `ValueSet.expansion`

Each step is independent, testable, and debuggable in isolation.

### How it integrates

Minimal changes to existing code:

- **`tx/workers/expand.js`** — new `_tryIRExpansion()` method, called
  before the original path. If the IR engine can't handle the ValueSet,
  it returns null and the original expander takes over.
- **`tx/params.js`** — parses the `_engine` parameter.

All the new pipeline logic lives in `tx/engine/`. Existing providers
(cs-cs, UCUM, country, currency, etc.) don't need any changes.

### Turning it on

| `EXPAND_IR_ENGINE` env | `_engine` param | What happens |
|------------------------|-----------------|--------------|
| not set | _(none)_ | Original expander only (status quo) |
| not set | `ir` | IR engine; error if it can't handle the VS |
| `1` | _(none)_ | Try IR first, fall back to original |
| `1` | `ir` | IR engine; error if it can't handle the VS |
| `1` | `legacy` | Original expander only |

The systemd service on tx-dev.fhir.org sets `EXPAND_IR_ENGINE=1`.
Per-request `_engine=ir` or `_engine=legacy` overrides. (The parameter
value `legacy` refers to the original expander.)

### Fallback rules

1. Does the ValueSet have a usable `compose`? If not → original
   expander.
2. Can we find a provider for every code system in the compose? If not
   → original expander.
3. If execution throws a `too-costly` error, that propagates to the
   caller (same as the original expander). Any other error is logged,
   and we fall back to the original expander.

So with `EXPAND_IR_ENGINE=1`, the IR engine handles what it can and the
original expander handles the rest.

---

## The expansion plan

The IR engine turns a ValueSet compose into a small tree before executing
anything. The tree has six kinds of node, each mapping directly to FHIR
compose concepts:

| Node | What it represents |
|------|--------------------|
| **selector** | A single `compose.include` component — one code system, with its concepts or filters |
| **import** | A `valueSet` reference (resolved before execution) |
| **union** | Multiple includes combined (logical OR) |
| **diff** | Include minus exclude |
| **intersect** | `include.valueSet[]` intersection (logical AND) |
| **empty** | No codes (used during simplification) |

A **selector** is the leaf node — one code system component in three
shapes:

- **whole** — the entire code system (no filter, no concept list)
- **concept** — an explicit list of codes (`include.concept[]`)
- **filter** — one or more filter clauses (`include.filter[]`)

### Example

```json
{
  "include": [
    { "system": "http://snomed.info/sct",
      "filter": [{ "property": "concept", "op": "is-a", "value": "73211009" }] }
  ],
  "exclude": [
    { "system": "http://snomed.info/sct",
      "filter": [{ "property": "concept", "op": "is-a", "value": "44054006" }] }
  ]
}
```

becomes:

```
diff(
  selector(SNOMED, filter: concept is-a 73211009),
  selector(SNOMED, filter: concept is-a 44054006)
)
```

"Diabetes mellitus minus Type 2 diabetes."

### Simplification

Before execution, the engine cleans up the tree:

- **Merge duplicate concept lists** — two includes pulling different
  codes from the same system become one list.
- **Merge duplicate filters** — same filter appearing twice (e.g. after
  inlining two imports that reference the same base) → keep one copy.
- **Split multi-system diffs** — if an include spans SNOMED + LOINC and
  the exclude only touches SNOMED, split so the SNOMED diff runs
  independently and LOINC passes through untouched.
- **Drop empty branches** — remove branches that can't produce codes
  (e.g. an intersect between two different code systems).

The goal: give each code system provider a self-contained piece of the
expansion, with no cross-system dependencies.

---

## How providers are called

The orchestrator walks the simplified tree system by system. For each
code system it finds the provider, then asks it to execute its subtree.

### v0 SQLite providers (fast path)

If the provider has `executeIR()`, the orchestrator calls it directly.
The v0 provider compiles the entire subtree to a single SQL query —
unions, intersects, diffs, hierarchy, property filters, text search all
happen in SQL. This is the fast path.

### All other providers (automatic wrapping)

Providers without `executeIR()` — cs-cs (FHIR package CodeSystems),
UCUM, country, currency, area codes, etc. — are automatically wrapped
in a filter-protocol adapter (`LegacyIRAdapter` in the code). The
adapter walks the tree and calls the provider's standard filter protocol
methods:

- **concept** → `locate(code)` for each code
- **filter** → `filter()` / `executeFilters()`
- **whole** → `iteratorAll()`
- **grammar-based** (UCUM, MIME, language) → `specialEnumeration()` if
  available (returns common units for UCUM), otherwise signals too-costly
- **union/intersect/diff** → executed in memory

The orchestrator doesn't care which path a provider takes. Both return
the same thing: a list of `{ code, display }` candidates.

---

## Pagination

### Multi-system stride

For a ValueSet spanning multiple code systems, the orchestrator sorts
systems in canonical URI order and "strides" the pagination window
across them.

Example: ValueSet includes SNOMED (124 codes) + LOINC (66,000 codes).
Client requests `offset=120, count=10`:

- SNOMED contributes codes 120–123 → 4 codes
- LOINC contributes codes 0–5 → 6 codes
- Systems whose entire range falls before the offset are skipped

No system ever materializes more than `count` rows. For `count=0`,
the engine runs count-only queries and returns just the total.

### Hierarchy and pagination

When pagination is active (explicit `offset` or `count < total`),
the expansion is always flat — no nested `contains`. This matches FHIR
spec guidance that paging applies to flat lists.

When the full result set fits in one page and the code system has
hierarchy, the engine nests children under parents (matching the original
expander's behavior). `excludeNested=true` forces flat regardless.

### Limits and too-costly

Unpaginated expansion exceeding the server limit (default 1,000) throws
a `too-costly` OperationOutcome. Paginated requests bypass this check.

---

## Designations and properties

After selecting candidates, designations and properties are loaded in
bulk — one batch per system, not per concept:

1. **`designation` parameter** — filters to matching use codes only
2. **`displayLanguage`** — filters to the requested language
3. **Redundancy suppression** — designations matching the primary display
   are omitted
4. **Compose-level overrides** — `include.concept[].display` and
   `.designation[]` replace or supplement code system values

### Supplements

Inline supplements (submitted via `tx-resource`) flow through the
existing provider supplement machinery. The IR engine wires the
`useSupplement` parameter and `valueset-supplement` extension to the
provider's supplement loading, and emits `used-supplement` parameters in
the response.

---

## What's different from the original expander

| | IR engine | Original expander |
|---|-----------|-------------------|
| **Architecture** | Pipeline: parse → simplify → execute → decorate → format | Single pass, ~1,300 lines |
| **v0 provider usage** | Compiles expansion plan to single SQL query | Calls filter protocol methods one at a time |
| **Pagination** | Stride per system — only materializes the requested page | Materializes all codes, then slices |
| **`count=0`** | SQL `COUNT(*)` — no codes materialized | Full expansion, then counts |
| **Hierarchy** | Flat when paginating; nested when full result fits in one page | May be nested always |
| **Designations** | Bulk-loaded after code selection | Loaded per-concept during iteration |
| **Property filter matching** | Matches by code only (per FHIR R4 spec) | Matches by code or display (original quirk) |
| **Limit enforcement** | Checks total before expanding | Safety valve during iteration |
| **Tracing** | Structured trace via `_trace=true` | None |

---

## Structured tracing

Add `_trace=true` to any `$expand` request to get a structured execution
trace as an extension on the response:

```
expansion.extension[].url = "http://fhirsmith.org/StructureDefinition/expand-trace"
expansion.extension[].valueString = <JSON>
```

Includes timing per pipeline phase, SQL queries with parameters and row
counts, and pagination decisions. Zero overhead when not requested.

---

## Testing

### HTTP test harness — 166 tests (`scripts/ir-harness.mjs`)

The primary test suite. Runs against a live server, exercising real
`$expand` calls:

| Area | What it covers |
|------|---------------|
| **Hierarchy filters** | SNOMED is-a, descendent-of, concept-in refsets |
| **Property filters** | LOINC STATUS, CLASSTYPE, SCALE_TYP; RxNorm TTY; SNOMED concept properties |
| **Text search** | Free-text `filter` parameter across systems |
| **Concept enumeration** | Explicit code lists for SNOMED, LOINC, RxNorm, gender, language |
| **Whole-system** | Full expansion of gender, publication-status, currency, US states, area codes |
| **Excludes** | Enumerated excludes, filter-based excludes, cross-system excludes |
| **Multi-system** | Unions across v0 + cs-cs + preloaded-map providers |
| **ValueSet imports** | Pure import, import + system intersection, imported excludes |
| **Pagination** | Disjoint pages, last-page partial, offset-beyond-end, deep offsets (50K+), count=0 |
| **Pagination safety** | Full-set reconstruction across pages (no gaps, no duplicates) |
| **Designations** | includeDesignations, displayLanguage, designation use filter, compose overrides, redundancy suppression |
| **Properties** | property=definition, wildcard properties, concept-valued properties |
| **Supplements** | useSupplement, valueset-supplement extension, display overrides, missing supplement validation |
| **Hierarchy nesting** | Conditional nesting, excludeNested, pagination forces flat, IR-vs-original parity |
| **Grammar-based** | UCUM unclosed expansion, MIME too-costly, language codes |
| **Limits** | Default limit enforcement, explicit limit, pagination bypasses limit |
| **Stress tests** | Deep SNOMED pagination (50K offset into 124K), complex inc/exc, mixed-system text+limit |
| **IR vs original comparison** | Side-by-side comparison of both engines for hierarchy output |

```
node scripts/ir-harness.mjs              # all tests, IR engine
node scripts/ir-harness.mjs --legacy     # all tests, original expander
node scripts/ir-harness.mjs "SNOMED"     # filter by name
node scripts/ir-harness.mjs --perf       # performance comparison table
scripts/run-ir-harness.sh --all --db-dir /home/jmandel/hobby/sct/cache
# one-command start/wait/run/teardown wrapper; writes logs + perf artifacts under tmp/ir-harness-runs/
```

### Simplification unit tests — 8 tests (`scripts/ir-rewrite-tests.mjs`)

Tests the expansion plan simplification logic directly (no server
needed): concept-list merging, filter deduplication, multi-system diff
splitting, cross-system empty elimination.

### Jest unit tests (`tests/engine/`, `tests/cs/`)

| File | Tests | What |
|------|-------|------|
| `cs-sqlite-v0.test.js` | 31 | v0 provider: locate, filter, iterate, IR execution, designations, properties |
| `orchestrator.test.js` | 19 | Full pipeline: expansion, pagination, count=0, designations, properties, metadata |
| `legacy-ir-adapter.test.js` | 11 | Filter-protocol adapter: concept, filter, union, diff, intersect; parity with native |
| `comparison.test.js` | 7 | IR vs original expander code-for-code parity on real SNOMED/LOINC data |
| `e2e-comparison.test.js` | 8 | HTTP-level IR vs original expander comparison (requires running server) |
| `hierarchy-regressions.test.js` | 2 | Edge cases: pagination window order, cross-system identity |
| `partition-safety.test.js` | 6 | Validates expansion plan before execution (rejects unsafe partitions) |
| `library-error-handling.test.js` | 6 | Library config loading, error reporting, env var substitution |

### IR Fuzz + Direct Oracle

Property-based and direct-oracle guidance lives in:
`docs/ir-fuzzing.md`.

Use it for:
1. run commands and env vars (`IR_FUZZ_SEEDS`, `IR_FUZZ_SEED_ONLY`, `IR_FUZZ_STRICT_DIRECT`)
2. what each fuzz mode proves
3. failure triage (partitioning vs lowering vs execution vs oracle mismatch)
4. generator limits and expected coverage boundaries

---

## File map

### v0 SQLite provider (`tx/cs/`)

| File | What it does |
|------|-------------|
| `cs-sqlite-v0.js` | Generic code system provider — implements both the standard filter protocol and `executeIR()` for the IR engine |
| `sqlite-v0-sql.js` | Builds SQL queries from expansion plan subtrees (used only by the IR engine path) |

### IR expansion engine (`tx/engine/`)

| File | What it does |
|------|-------------|
| `build-ir.js` | Reads a ValueSet compose and builds the expansion plan tree |
| `resolve-imports.js` | Fetches imported ValueSets and inlines them into the tree |
| `rewrite.js` | Simplifies the tree: merge, deduplicate, partition by system |
| `orchestrator.js` | Runs the pipeline: count → paginate → execute → decorate → build response |
| `legacy-ir-adapter.js` | Wraps filter-protocol providers so they can execute expansion plan trees |
| `ir.js` | Node constructors for the expansion plan tree |
| `membership.js` | "Does code X belong to set Y?" testers for intersect/diff |
| `expand-trace.js` | Structured tracing infrastructure |
| `index.js` | Public exports |

### Modified upstream files

| File | Change |
|------|--------|
| `tx/workers/expand.js` | Added `_tryIRExpansion()` entry point with fallback |
| `tx/params.js` | Parses `_engine` parameter |
| `tx/library.js` | Loads v0 SQLite databases via `sqlite-v0:` source type |

---

## See also

- `docs/ir-engine-gap-plan.md` — Phase-by-phase implementation history
  and test cross-reference
- `docs/ir-fuzzing.md` — Detailed fuzz/direct-oracle workflow and diagnostics
- `docs/legacy-expansion-gap.md` — Hierarchical vs flat expansion
  differences
- `scripts/ir-harness.mjs` — HTTP test harness (source of truth)
- `scripts/ir-rewrite-tests.mjs` — Simplification unit tests
