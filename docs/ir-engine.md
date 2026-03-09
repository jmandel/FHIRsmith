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

<table>
  <thead>
    <tr>
      <th>Table</th>
      <th>Contents</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>code_system</code></td>
      <td>Base URI, version, name, content mode</td>
    </tr>
    <tr>
      <td><code>concept</code></td>
      <td>Code, display, active, abstract, definition</td>
    </tr>
    <tr>
      <td><code>concept_link</code></td>
      <td>Parent→child hierarchy edges</td>
    </tr>
    <tr>
      <td><code>closure</code></td>
      <td>Precomputed transitive closure (ancestor→descendant)</td>
    </tr>
    <tr>
      <td><code>concept_literal</code></td>
      <td>Property values (strings) keyed by property ID</td>
    </tr>
    <tr>
      <td><code>designation</code></td>
      <td>Designations: language, use code, term, active, preferred</td>
    </tr>
    <tr>
      <td><code>property_def</code></td>
      <td>Property definitions: code, URI, type</td>
    </tr>
    <tr>
      <td><code>cs_config</code></td>
      <td>JSON configuration blob (see below)</td>
    </tr>
    <tr>
      <td><code>value_set</code></td>
      <td>Implicit value set definitions</td>
    </tr>
    <tr>
      <td><code>search_fts_*</code></td>
      <td>FTS5 full-text search indexes</td>
    </tr>
  </tbody>
</table>

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

<table>
  <thead>
    <tr>
      <th>FHIR filter</th>
      <th>What the v0 provider does</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>is-a</code></td>
      <td><code>JOIN closure</code> on precomputed transitive closure table</td>
    </tr>
    <tr>
      <td><code>descendent-of</code></td>
      <td>Same join, minus the root concept</td>
    </tr>
    <tr>
      <td>Property <code>=</code></td>
      <td><code>JOIN concept_literal WHERE value = ?</code> (or <code>JOIN concept_link</code> for concept-valued properties)</td>
    </tr>
    <tr>
      <td>Property <code>in</code></td>
      <td><code>JOIN concept_literal WHERE value IN (...)</code></td>
    </tr>
    <tr>
      <td>Property <code>regex</code></td>
      <td><code>REGEXP</code> on code or on <code>concept_literal.value_text</code></td>
    </tr>
    <tr>
      <td><code>concept-in</code> (refsets)</td>
      <td><code>JOIN concept_link</code> to refset members</td>
    </tr>
    <tr>
      <td>Text search (<code>filter</code> param)</td>
      <td>FTS5 full-text search across display, designations, properties</td>
    </tr>
  </tbody>
</table>

With the original expander, these run as individual filter protocol
calls. With the IR engine, they're composed into a single SQL query per
system that can also handle unions, intersects, and excludes at the SQL
level.

### Specialization system

Some terminologies need behavior beyond the generic provider (e.g.
SNOMED post-coordinated expressions, LOINC implicit value set generation
from URL patterns). The generic `SqliteV0FactoryProvider` stays system-
agnostic; code-system-specific behavior lives in registered subclasses.

The registration flow is:

1. Subclass modules call
   `SqliteV0FactoryProvider.registerSpecialization(...)` at require-time.
2. `tx/library.js` loads `tx/cs/cs-sqlite-v0-specializations.js` during
   startup.
3. That bootstrap file requires the concrete specialization modules
   (currently `tx/cs/cs-sqlite-v0-loinc.js`).
4. When a `sqlite-v0:` source is opened, `createFromMetadata()` probes
   the DB metadata and returns either:
   - a matching specialized subclass, or
   - the generic base provider if nothing matches.

This keeps the base sqlite-v0 provider generic while still allowing
terminology-specific hooks where they are genuinely needed.

Current concrete example:

- `tx/cs/cs-sqlite-v0-loinc.js` registers a LOINC specialization that
  owns `http://loinc.org/vs...` implicit ValueSet behavior, including
  answer-list ValueSets like `http://loinc.org/vs/LL2201-3`.

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

<table>
  <thead>
    <tr>
      <th><code>EXPAND_IR_ENGINE</code> env</th>
      <th><code>_engine</code> param</th>
      <th>What happens</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>not set</td>
      <td><em>(none)</em></td>
      <td>Original expander only (status quo)</td>
    </tr>
    <tr>
      <td>not set</td>
      <td><code>ir</code></td>
      <td>IR engine only; <code>422</code> if it can't handle the VS</td>
    </tr>
    <tr>
      <td><code>1</code></td>
      <td><em>(none)</em></td>
      <td>Opportunistic IR: try IR first, fall back to original</td>
    </tr>
    <tr>
      <td><code>1</code></td>
      <td><code>ir</code></td>
      <td>IR engine only; <code>422</code> if it can't handle the VS</td>
    </tr>
    <tr>
      <td><code>1</code></td>
      <td><code>legacy</code></td>
      <td>Original expander only</td>
    </tr>
  </tbody>
</table>

The systemd service on tx-dev.fhir.org sets `EXPAND_IR_ENGINE=1`.
Per-request `_engine=ir` or `_engine=legacy` overrides. (`legacy` refers to
the original expander.)

`_engine=ir-strict` is still accepted as a deprecated alias for compatibility,
but it is not a distinct mode anymore.

For cutover/readiness work, use `_engine=ir`. We do not want silent fallback
when we are explicitly asking whether the IR path is ready.

### Fallback rules

Fallback only applies in the opportunistic mode (`EXPAND_IR_ENGINE=1`
with no explicit `_engine=ir` override):

1. Does the ValueSet have a usable `compose`? If not → original
   expander.
2. Can we find a provider for every code system in the compose? If not
   → original expander.
3. If execution throws a `too-costly` error, that propagates to the
   caller (same as the original expander). Any other runtime failure is
   treated as an error when IR was explicitly requested.

So with `EXPAND_IR_ENGINE=1` and no explicit engine override, the IR
engine handles what it can and the original expander handles the rest.
With `_engine=ir`, no silent fallback is acceptable.

---

## The expansion plan

The IR engine turns a ValueSet compose into a small tree before executing
anything. The tree has six kinds of node, each mapping directly to FHIR
compose concepts:

<table>
  <thead>
    <tr>
      <th>Node</th>
      <th>What it represents</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>selector</strong></td>
      <td>A single <code>compose.include</code> component — one code system, with its concepts or filters</td>
    </tr>
    <tr>
      <td><strong>import</strong></td>
      <td>A <code>valueSet</code> reference (resolved before execution)</td>
    </tr>
    <tr>
      <td><strong>union</strong></td>
      <td>Multiple includes combined (logical OR)</td>
    </tr>
    <tr>
      <td><strong>diff</strong></td>
      <td>Include minus exclude</td>
    </tr>
    <tr>
      <td><strong>intersect</strong></td>
      <td><code>include.valueSet[]</code> intersection (logical AND)</td>
    </tr>
    <tr>
      <td><strong>empty</strong></td>
      <td>No codes (used during simplification)</td>
    </tr>
  </tbody>
</table>

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
   `.designation[]` replace or supplement code system values, keyed by
   `(system, version, code)` so same-code results from different versions
   do not leak across each other

### Supplements

Supplements now go through an explicit supplement runtime before
provider execution:

1. resolve requested supplement canonicals against the base
   `(system, version)` scope
2. bind one request-scoped IR runtime scope for that base provider and
   supplement set
3. run the IR expand phases through dedicated modules:
   - `ir-expansion-plan.js`
   - `ir-expansion-execution.js`
   - `ir-expansion-response.js`
   so `expandViaIR()` remains orchestration rather than a monolithic
   implementation
4. if the bound provider supports native attachment (currently
   sqlite-v0), the bound scope uses native execution and native-complete
   decoration
5. otherwise the bound scope uses supplement-aware execution plus
   overlay-complete decoration

This keeps supplement semantics consistent across:

- inline `tx-resource` supplements
- configured server-side sqlite supplement sidecars
- sqlite-backed and non-sqlite providers

The IR path emits `used-supplement` parameters in the response. Legacy
`$expand` is intentionally not upgraded to this full runtime; for
configured sqlite sidecars it now fails closed instead of silently
ignoring the request. Supplement/runtime/provider failures in the IR
path now also fail closed instead of being downgraded into a generic
\"IR cannot handle this ValueSet\" miss. `$lookup` and `$validate-code`
also reuse this supplement runtime seam; resource-backed code system
operations now share one worker helper for supplement-aware provider
construction instead of duplicating supplement materialization logic.
On the IR path, typed
property values from both base sqlite-v0 data and supplements now survive
response shaping as proper FHIR `value[x]` fields. Current boundary: the
generic supplement fallback supports simple overlay-backed property
operators (`=`, `in`, `regex`, `exists`), while richer overlay-backed
hierarchical operators remain an explicit fail-closed TODO.
`ValueSet.expansion.property` is emitted when expansion properties are
requested.

---

## What's different from the original expander

<table>
  <thead>
    <tr>
      <th></th>
      <th>IR engine</th>
      <th>Original expander</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Architecture</strong></td>
      <td>Pipeline: parse → simplify → execute → decorate → format</td>
      <td>Single pass, ~1,300 lines</td>
    </tr>
    <tr>
      <td><strong>v0 provider usage</strong></td>
      <td>Compiles expansion plan to single SQL query</td>
      <td>Calls filter protocol methods one at a time</td>
    </tr>
    <tr>
      <td><strong>Pagination</strong></td>
      <td>Stride per system — only materializes the requested page</td>
      <td>Materializes all codes, then slices</td>
    </tr>
    <tr>
      <td><strong><code>count=0</code></strong></td>
      <td>SQL <code>COUNT(*)</code> — no codes materialized</td>
      <td>Full expansion, then counts</td>
    </tr>
    <tr>
      <td><strong>Hierarchy</strong></td>
      <td>Flat when paginating; nested when full result fits in one page</td>
      <td>May be nested always</td>
    </tr>
    <tr>
      <td><strong>Designations</strong></td>
      <td>Bulk-loaded after code selection</td>
      <td>Loaded per-concept during iteration</td>
    </tr>
    <tr>
      <td><strong>Property filter matching</strong></td>
      <td>Matches by code only (per FHIR R4 spec)</td>
      <td>Matches by code or display (original quirk)</td>
    </tr>
    <tr>
      <td><strong>Limit enforcement</strong></td>
      <td>Checks total before expanding</td>
      <td>Safety valve during iteration</td>
    </tr>
    <tr>
      <td><strong>Tracing</strong></td>
      <td>Structured trace via <code>_trace=true</code></td>
      <td>None</td>
    </tr>
  </tbody>
</table>

---

## Structured tracing

Add `_trace=true` to any `$expand` request to get a structured execution
trace as an extension on the response:

```
expansion.extension[].url = "https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/expand-trace"
expansion.extension[].valueString = <JSON>
```

Includes timing per pipeline phase, SQL queries with parameters and row
counts, and pagination decisions. Zero overhead when not requested.

---

## Testing

### HTTP test harness — 166 tests (`scripts/ir-harness.mjs`)

The primary test suite. Runs against a live server, exercising real
`$expand` calls:

<table>
  <thead>
    <tr>
      <th>Area</th>
      <th>What it covers</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>Hierarchy filters</strong></td>
      <td>SNOMED is-a, descendent-of, concept-in refsets</td>
    </tr>
    <tr>
      <td><strong>Property filters</strong></td>
      <td>LOINC STATUS, CLASSTYPE, SCALE_TYP; RxNorm TTY; SNOMED concept properties</td>
    </tr>
    <tr>
      <td><strong>Text search</strong></td>
      <td>Free-text <code>filter</code> parameter across systems</td>
    </tr>
    <tr>
      <td><strong>Concept enumeration</strong></td>
      <td>Explicit code lists for SNOMED, LOINC, RxNorm, gender, language</td>
    </tr>
    <tr>
      <td><strong>Whole-system</strong></td>
      <td>Full expansion of gender, publication-status, currency, US states, area codes</td>
    </tr>
    <tr>
      <td><strong>Excludes</strong></td>
      <td>Enumerated excludes, filter-based excludes, cross-system excludes</td>
    </tr>
    <tr>
      <td><strong>Multi-system</strong></td>
      <td>Unions across v0 + cs-cs + preloaded-map providers</td>
    </tr>
    <tr>
      <td><strong>ValueSet imports</strong></td>
      <td>Pure import, import + system intersection, imported excludes</td>
    </tr>
    <tr>
      <td><strong>Pagination</strong></td>
      <td>Disjoint pages, last-page partial, offset-beyond-end, deep offsets (50K+), count=0</td>
    </tr>
    <tr>
      <td><strong>Pagination safety</strong></td>
      <td>Full-set reconstruction across pages (no gaps, no duplicates)</td>
    </tr>
    <tr>
      <td><strong>Designations</strong></td>
      <td>includeDesignations, displayLanguage, designation use filter, compose overrides, redundancy suppression</td>
    </tr>
    <tr>
      <td><strong>Properties</strong></td>
      <td>property=definition, wildcard properties, concept-valued properties</td>
    </tr>
    <tr>
      <td><strong>Supplements</strong></td>
      <td>useSupplement, valueset-supplement extension, display overrides, missing supplement validation</td>
    </tr>
    <tr>
      <td><strong>Hierarchy nesting</strong></td>
      <td>Conditional nesting, excludeNested, pagination forces flat, IR-vs-original parity</td>
    </tr>
    <tr>
      <td><strong>Grammar-based</strong></td>
      <td>UCUM unclosed expansion, MIME too-costly, language codes</td>
    </tr>
    <tr>
      <td><strong>Limits</strong></td>
      <td>Default limit enforcement, explicit limit, pagination bypasses limit</td>
    </tr>
    <tr>
      <td><strong>Stress tests</strong></td>
      <td>Deep SNOMED pagination (50K offset into 124K), complex inc/exc, mixed-system text+limit</td>
    </tr>
    <tr>
      <td><strong>IR vs original comparison</strong></td>
      <td>Side-by-side comparison of both engines for hierarchy output</td>
    </tr>
  </tbody>
</table>

```
node scripts/ir-harness.mjs              # all tests, IR engine
node scripts/ir-harness.mjs --legacy     # all tests, original expander
node scripts/ir-harness.mjs "SNOMED"     # filter by name
node scripts/ir-harness.mjs --perf       # performance comparison table
scripts/run-ir-harness.sh --all --db-dir /home/jmandel/hobby/sct/cache
# one-command start/wait/run/teardown wrapper; writes logs + perf artifacts under tmp/ir-harness-runs/
npm run test:perf:matrix                 # default 2-column perf matrix, synthetic supplement rows included
npm run test:perf:matrix:3col            # opt-in third upstream-providers column
```

### v0 SQLite perf snapshots

Measured on this branch with the current full harness corpus:

- `199` rows
- synthetic supplement rows included by default
- default perf repeat count: `1`
- default local matrix: `2` columns
- opt-in full comparison matrix: `3` columns

For day-to-day local iteration, use the default `2`-column matrix:

```bash
npm run test:perf:matrix
```

For the full checked-in comparison matrix, use the `3`-column run:

```bash
scripts/run-ir-harness.sh \
  --perf \
  --perf-third-upstream \
  --perf-runs 1 \
  --db-dir /home/jmandel/hobby/sct/cache \
  --upstream-db-dir /home/jmandel/hobby/FHIRsmith/data/terminology-cache \
  --out-dir docs/perf/v0-sqlite-20260309-3col
```

Notes:
- Winner labels are suppressed for near-ties (absolute diff `<= 5ms`).
- Each detail page includes split execution details and, on the IR side, a compact IR plan tree.
- The `3`-column run compares:
  - IR branch + new expander
  - IR branch + upstream expander
  - upstream-style providers + upstream expander

Latest checked-in static-site snapshot:

- [perf/v0-sqlite-20260309-3col/perf-table.html](perf/v0-sqlite-20260309-3col/perf-table.html)

To build the docs landing site (used by GitHub Pages workflow):

```bash
npm run build:docs-site
```

Published docs include:
- `tools/expand-explorer-lite.html` — simplified IR compile explorer
- `perf/v0-sqlite-20260309-3col/perf-table.html` — latest checked-in 3-column perf matrix

### Simplification unit tests — 8 tests (`scripts/ir-rewrite-tests.mjs`)

Tests the expansion plan simplification logic directly (no server
needed): concept-list merging, filter deduplication, multi-system diff
splitting, cross-system empty elimination.

### Jest unit tests (`tests/engine/`, `tests/cs/`)

<table>
  <thead>
    <tr>
      <th>File</th>
      <th>Tests</th>
      <th>What</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>cs-sqlite-v0.test.js</code></td>
      <td>30</td>
      <td>v0 provider: locate, filter, iterate, IR execution, designations, properties</td>
    </tr>
    <tr>
      <td><code>orchestrator.test.js</code></td>
      <td>21</td>
      <td>Full pipeline: expansion, pagination, count=0, designations, properties, metadata</td>
    </tr>
    <tr>
      <td><code>legacy-ir-adapter.test.js</code></td>
      <td>11</td>
      <td>Filter-protocol adapter: concept, filter, union, diff, intersect; parity with native</td>
    </tr>
    <tr>
      <td><code>comparison.test.js</code></td>
      <td>10</td>
      <td>IR vs original expander code-for-code parity on real SNOMED/LOINC data</td>
    </tr>
    <tr>
      <td><code>e2e-comparison.test.js</code></td>
      <td>8</td>
      <td>HTTP-level IR vs original expander comparison (requires running server)</td>
    </tr>
    <tr>
      <td><code>hierarchy-regressions.test.js</code></td>
      <td>2</td>
      <td>Edge cases: pagination window order, cross-system identity</td>
    </tr>
    <tr>
      <td><code>partition-safety.test.js</code></td>
      <td>8</td>
      <td>Validates expansion plan before execution (rejects unsafe partitions)</td>
    </tr>
    <tr>
      <td><code>library-error-handling.test.js</code></td>
      <td>6</td>
      <td>Library config loading, error reporting, env var substitution</td>
    </tr>
  </tbody>
</table>

Test-layer guidance, batched run commands, and the shared TX integration
fixture pattern live in [testing.md](testing.md).

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

<table>
  <thead>
    <tr>
      <th>File</th>
      <th>What it does</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>cs-sqlite-v0.js</code></td>
      <td>Generic code system provider — implements both the standard filter protocol and <code>executeIR()</code> for the IR engine</td>
    </tr>
    <tr>
      <td><code>cs-sqlite-v0-specializations.js</code></td>
      <td>Bootstrap that loads registered sqlite-v0 specializations at startup</td>
    </tr>
    <tr>
      <td><code>cs-sqlite-v0-loinc.js</code></td>
      <td>LOINC-specific sqlite-v0 subclass; owns <code>http://loinc.org/vs...</code> implicit ValueSet behavior</td>
    </tr>
    <tr>
      <td><code>sqlite-v0-compiler.js</code></td>
      <td>Provider-private compiler from scoped IR to normalized plans, SQL AST, rendered SQL, and execution-ready queries</td>
    </tr>
    <tr>
      <td><code>sqlite-v0-sql-patterns.js</code></td>
      <td>Reusable sqlite-v0 shape-detection helpers for fast-path planning</td>
    </tr>
    <tr>
      <td><code>sqlite-v0-sql-strategies.js</code></td>
      <td>Centralized sqlite-v0 terminal strategy choice for materialize/count paths</td>
    </tr>
    <tr>
      <td><code>sqlite-v0-sql-search.js</code></td>
      <td>Runtime text-search lowering and search strategy helpers for sqlite-v0</td>
    </tr>
    <tr>
      <td><code>sqlite-v0-sql-ast.js</code></td>
      <td>Physical plan to SQL AST lowering for sqlite-v0 once strategy/pattern choice is made</td>
    </tr>
    <tr>
      <td><code>sqlite-v0-sql-nodes.js</code></td>
      <td>SQL AST node constructors and structural-form helpers</td>
    </tr>
    <tr>
      <td><code>sqlite-v0-sql-emit.js</code></td>
      <td>Deterministic SQL renderer for sqlite-v0 SQL AST</td>
    </tr>
  </tbody>
</table>

### IR expansion engine (`tx/engine/`)

<table>
  <thead>
    <tr>
      <th>File</th>
      <th>What it does</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>build-ir.js</code></td>
      <td>Reads a ValueSet compose and builds the expansion plan tree</td>
    </tr>
    <tr>
      <td><code>resolve-imports.js</code></td>
      <td>Fetches imported ValueSets and inlines them into the tree</td>
    </tr>
    <tr>
      <td><code>rewrite.js</code></td>
      <td>Simplifies the tree: merge, deduplicate, partition by system</td>
    </tr>
    <tr>
      <td><code>orchestrator.js</code></td>
      <td>Runs the pipeline: count → paginate → execute → decorate → build response</td>
    </tr>
    <tr>
      <td><code>ir-bound-scope.js</code></td>
      <td>Binds one request-scoped IR runtime scope: execution facet, decoration facet, supplement accounting</td>
    </tr>
    <tr>
      <td><code>ir-traversal.js</code></td>
      <td>Shared IR child traversal helpers (<code>walkIR</code>, <code>mapIR</code>, <code>mapIRAsync</code>) used by planning, debug, and response utilities</td>
    </tr>
    <tr>
      <td><code>ir-expansion-response.js</code></td>
      <td>IR expansion response shaping: candidate decoration, compose overrides, FHIR expansion building</td>
    </tr>
    <tr>
      <td><code>legacy-ir-adapter.js</code></td>
      <td>Wraps filter-protocol providers so they can execute expansion plan trees</td>
    </tr>
    <tr>
      <td><code>ir.js</code></td>
      <td>Node constructors for the expansion plan tree</td>
    </tr>
    <tr>
      <td><code>membership.js</code></td>
      <td>"Does code X belong to set Y?" testers for intersect/diff</td>
    </tr>
    <tr>
      <td><code>expand-trace.js</code></td>
      <td>Structured tracing infrastructure</td>
    </tr>
    <tr>
      <td><code>index.js</code></td>
      <td>Public exports</td>
    </tr>
  </tbody>
</table>

### Modified upstream files

<table>
  <thead>
    <tr>
      <th>File</th>
      <th>Change</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>tx/workers/expand.js</code></td>
      <td>Added <code>_tryIRExpansion()</code> entry point with fallback</td>
    </tr>
    <tr>
      <td><code>tx/workers/worker.js</code></td>
      <td>Added supplement registry/resolution runtime, native attachment seam, and fallback to materialized <code>CodeSystem[]</code> overlays</td>
    </tr>
    <tr>
      <td><code>tx/workers/lookup.js</code></td>
      <td>Routes supplement-aware lookup through the new supplement runtime</td>
    </tr>
    <tr>
      <td><code>tx/workers/validate.js</code></td>
      <td>Reuses the supplement runtime for supplement-aware <code>$validate-code</code></td>
    </tr>
    <tr>
      <td><code>tx/params.js</code></td>
      <td>Parses <code>_engine</code> parameter</td>
    </tr>
    <tr>
      <td><code>tx/library.js</code></td>
      <td>Loads v0 SQLite databases via <code>sqlite-v0:</code> source type and initializes sqlite-v0 specializations</td>
    </tr>
  </tbody>
</table>

---

## See also

- [supplement-architecture.md](supplement-architecture.md) — Detailed design
  for explicit supplement resolution, overlay semantics, generic fallback, and
  native optimization in the new runtime path
- [supplement-microscope.md](supplement-microscope.md) — Worked end-to-end
  example of a supplement-aware IR request, from request parameters through
  supplement resolution, IR, provider-private plans, SQL, and final response
- [sqlite-v0-execution-compiler.md](sqlite-v0-execution-compiler.md) —
  Standalone architecture note for how sqlite-v0 lowers scoped IR into plans,
  SQL AST, and runtime SQL, including the multi-oracle testing strategy
- [ir-engine-gap-plan.md](ir-engine-gap-plan.md) — Phase-by-phase
  implementation history and test cross-reference
- [sqlite-v0-provider-compiler-plan.md](sqlite-v0-provider-compiler-plan.md)
  — Detailed staged design and checklist for the sqlite-v0
  provider-private execution compiler
- [ir-fuzzing.md](ir-fuzzing.md) — Detailed fuzz/direct-oracle workflow and
  diagnostics
- [legacy-expansion-gap.md](legacy-expansion-gap.md) — Hierarchical vs flat
  expansion differences
- `scripts/ir-harness.mjs` — HTTP test harness (source of truth)
- `scripts/ir-rewrite-tests.mjs` — Simplification unit tests
