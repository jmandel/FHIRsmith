# Implementation Plan: IR-Based Expansion Engine

## Status (2026-03-04)

### CRITICAL REORIENTATION

The previous plan was built on top of the JMandel branch (`rework-expand-codex-2`),
which introduced `expand-v2.js` as a ground-up rewrite of the expander and
`cs-sqlite-runtime-v0.js` as a new generic SQLite-backed code system provider.
**That branch is a dead end.** The correct approach is:

**Branch off `upstream/main` (HealthIntersections/FHIRsmith) and introduce
IR-based expansion alongside the original `expand.js`.** The upstream repo
has no expand-v2, no sqlite-v0 providers, no expand-v3 — just the original
monolith expander and the legacy per-system providers (SNOMED binary, LOINC
custom SQLite, RxNorm custom SQLite, etc.).

### What We're Keeping

The `tx/engine/` core modules are standalone and do NOT depend on expand-v2:

| Module | Lines | Status | Notes |
|--------|-------|--------|-------|
| `ir.js` | 83 | ✅ Done | IR node types, no dependencies |
| `build-ir.js` | 76 | ✅ Done | ValueSet JSON → IR, no dependencies |
| `resolve-imports.js` | 153 | ✅ Done | Import inlining, callback-based resolver |
| `rewrite.js` | 435 | ✅ Done | Optimization passes, pure functions |
| `membership.js` | 176 | ✅ Done | Composable membership types, no dependencies |
| `sqlite-v0-sql.js` | 482 | ✅ Done | IR→SQL compiler for v0 schema |
| `sqlite-v0-executor.js` | 118 | ✅ Done | Wraps better-sqlite3, calls sql builder |
| `engine.js` | ~200 | ✅ Done | Orchestrator, offset/paging fixed |
| `test-integration.js` | 260 | ✅ Done | 28 tests against real v0 databases |

### What Needs Rework

| Module | Status | Issue |
|--------|--------|-------|
| `expand-adapter.js` | ❌ Redo | Wired into expand-v2 infrastructure |
| `legacy-executor.js` | ⚠️ Review | Wraps providers generically, but untested against upstream providers |
| Wiring in `expand-v2.js` | ❌ Delete | Must wire into upstream `expand.js` instead |
| `test-e2e-server.js` | ⚠️ Review | Tests are valid, but ran against expand-v2 server |

## Three Things to Introduce

### 1. IR Rewriting (Standalone Modules)

The IR compiler (`ir.js`, `build-ir.js`, `resolve-imports.js`, `rewrite.js`)
is a standalone JavaScript library with zero server dependencies. It takes
a FHIR ValueSet JSON and produces an optimized intermediate representation
— a tree of set-algebra operations (`union`, `intersect`, `diff`) over
leaf `selector` nodes scoped to a single code system.

After optimization, the IR is partitioned by system. Each system gets
a self-contained IR subtree — no cross-system references, just the
set-algebra for that one system's contribution to the expansion.

These modules can be dropped into any branch as-is. They are tested
independently and have no coupling to any expand worker or provider.

### 2. SQLite v0 Provider + IR Subtree Method

The v0 databases (`sct_intl_20250201.v0.db`, `loinc_281_full.v0.db`,
`rxnorm_02022026.v0.db`) already exist in `/home/exedev/tx-data/`.
The schema is proven and stable:

```
code_system, concept, property_def, concept_link, concept_literal,
closure, designation, value_set, value_set_member,
search_fts_display, search_fts_designation, search_fts_literal
```

The JMandel branch has `cs-sqlite-runtime-v0.js` (~5000 lines) which
implements the full `CodeSystemProvider` interface against this schema.
**We probably can't reuse those JS classes as-is** because:

- They were evolved alongside expand-v2 and have deep coupling to it
- They implement a "provider-core" family API that upstream doesn't have
- They use patterns (negotiate/openStream, expandComponent pushdown)
  that upstream's expand.js doesn't call

**What we need instead** is a simpler v0 SQLite provider that:

1. Implements upstream's `CodeSystemProvider` interface (cs-api.js)
2. Uses `better-sqlite3` (sync) — shared DB connection with IR executor
3. Supports the methods that upstream `expand.js` actually calls
   (locate, code, display, filter protocol, designations, properties, etc.)
4. Registers as a factory with `library.js` via `sqlite-v0:` source type
5. **Adds a new `executeIR(subtree, opts)` method** that accepts a
   single-system IR subtree and returns expansion results directly

This new method is the key innovation. When the IR engine gives a v0
provider an IR subtree like:

```
diff(
  selector({system: 'sct', shape: 'filter', filterClauses: [{prop: 'concept', op: 'is-a', value: '73211009'}]}),
  selector({system: 'sct', shape: 'filter', filterClauses: [{prop: 'concept', op: 'is-a', value: '46635009'}]})
)
```

...the v0 provider compiles it to a single SQL query with JOINs and
NOT EXISTS, executes it, and streams results — far more efficient than
the leaf-by-leaf filter protocol. The existing `sqlite-v0-sql.js`
already knows how to do this compilation.

The legacy filter protocol methods (getPrepContext, filter, executeFilters,
filterMore, etc.) are still implemented so upstream's expand.js can use
the provider directly without the IR engine. The two paths coexist.

### 3. IR Engine + Legacy Adapter

The IR engine orchestrates the full pipeline:

```
ValueSet → compile IR → optimize → partition by system
  → for each system:
      if provider.executeIR exists → call it (native IR execution)
      else → wrap provider in LegacyIRAdapter → adapter.executeIR()
  → cross-system dedup, exclusion, paging
  → FHIR expansion result
```

The **LegacyIRAdapter** wraps any `CodeSystemProvider` and implements
`executeIR(subtree, opts)` by tree-walking the IR and calling the
provider's existing methods at the leaves:

- `selector(concept)` → `locate()` per code
- `selector(filter)` → `getPrepContext()` + `filter()` + `executeFilters()` + iterate
- `selector(whole)` → `iteratorAll()` + `nextContext()` loop
- `union` → enumerate children, concatenate
- `intersect` → enumerate first child, membership-check against rest
- `diff` → enumerate left, membership-check against right

The adapter manages exclusions, intersections, and all set operations
using the existing membership types (`SetMembership`, `FilterCheckMembership`,
etc. from `membership.js`). This means **every** CodeSystemProvider gets
IR support automatically — UCUM, in-memory FhirCS, country codes, etc.
— without those providers knowing anything about IR.

The SQL queries are already proven — `sqlite-v0-sql.js` in the engine
has the complete catalog. The new provider can reuse those patterns.

## How Upstream expand.js Works

### Entry Point

```
ExpandWorker.performExpansion(valueSet, params)
  → ValueSetExpander(worker, params).expand(valueSet, filter)
    → handleCompose(source, filter, expansion)
      → for each include: includeCodes(cset, ...)
      → for each exclude: excludeCodes(cset, ...)
```

### The includeCodes Flow

For each `compose.include` component, the expander:

1. Finds a `CodeSystemProvider` via `worker.findCodeSystem(system, version)`
2. If `cset.concept` — iterates codes:
   ```js
   for (cc of cset.concept) {
     ctx = await cs.locate(cc.code);
     cds = new Designations(...);
     await cs.designations(ctx.context, cds);
     await includeCode(cs, null, system, version, code,
       isAbstract, isInactive, isDeprecated, status,
       cds, definition, itemWeight, expansion, valueSets,
       extensions, cc.extension, properties, null, excludeInactive);
   }
   ```
3. If `cset.filter` — uses the filter protocol:
   ```js
   prep = await cs.getPrepContext(true);
   for (fc of cset.filter) await cs.filter(prep, fc.property, fc.op, fc.value);
   fset = await cs.executeFilters(prep);
   while (await cs.filterMore(prep, fset[0])) {
     c = await cs.filterConcept(prep, fset[0]);
     // cross-check against fset[1..] via filterCheck
     cds = new Designations(...);
     await cs.designations(c, cds);
     await includeCode(cs, parent, system, version, code(c), ...);
   }
   ```
4. If neither concept nor filter (whole system) — iterates all:
   ```js
   iter = await cs.iterator(null);
   c = await cs.nextContext(iter);
   while (c) {
     await includeCodeAndDescendants(cs, c, expansion, ...);
     c = await cs.nextContext(iter);
   }
   ```

### includeCode Builds the Full Contains Entry

The `includeCode()` method (line 298 in upstream expand.js) does ALL
decoration in one place:

```js
includeCode(cs, parent, system, version, code, isAbstract, isInactive,
            deprecated, status, displays, definition, itemWeight,
            expansion, imports, csExtList, vsExtList, csProps,
            expProps, excludeInactive, srcURL)
```

It builds `{ system, code, version?, display?, abstract?, inactive?,
designation[]?, property[]?, extension[]? }` and handles:
- Dedup via `this.map`
- Exclusion checking
- Limit enforcement
- Display resolution from the `Designations` object
- Designation attachment if `params.includeDesignations`
- Property attachment for each `params.properties` name
- Extension passthrough from code system and ValueSet
- Status/label/order/weight property generation

## Integration Strategy

### System Diagram

```
ValueSet JSON
    │
    ▼
┌────────────────────────────────┐
│  IR Compiler (pure, no deps)   │
│  build-ir → resolve-imports    │
│  → rewrite/optimize            │
└───────────────┬────────────────┘
                │ Optimized IR (per-system subtrees)
                ▼
┌────────────────────────────────┐
│  Engine Orchestrator            │
│  partition by system            │
│  cross-system exclusion + dedup │
│  paging                         │
└────────┬─────────────┬──────────┘
         │              │
         ▼              ▼
  provider.executeIR()   provider.executeIR()
         │              │
         ▼              ▼
┌───────────────┐ ┌────────────────┐
│ SQLite v0     │ │ LegacyIRAdapter │
│ Provider      │ │                │
│               │ │ wraps any CS   │
│ compiles IR   │ │ Provider;      │
│ subtree to    │ │ tree-walks IR  │
│ single SQL    │ │ calling legacy │
│ query, runs   │ │ locate/filter/ │
│ via better-   │ │ iterate at     │
│ sqlite3       │ │ leaves         │
└───────────────┘ └────────────────┘
```

The engine calls the same `executeIR()` / `membershipForIR()` interface
regardless of what's behind it. For systems with a v0 database, the
provider compiles the IR subtree to one SQL query. For systems without
(UCUM, in-memory FhirCS, etc.), the LegacyIRAdapter wraps the upstream
provider and walks the IR tree using legacy methods.

### The New Method: `executeIR(subtree, opts)`

The key new contract is a method on CodeSystemProvider (or an adapter
wrapping one) that accepts a single-system IR subtree.

**Invariant**: Every selector node in the subtree references only this
provider's system (and version, if the ValueSet specified one). The
engine guarantees this by calling `projectToSystem(optimizedIR, system,
version)` during partitioning — which walks the optimized IR and extracts
only the nodes relevant to that system, replacing everything else with
`empty`. The provider never sees cross-system operations. Cross-system
concerns (multi-system excludes, dedup across systems) are handled
entirely by the engine orchestrator.

The subtree may be arbitrarily complex within that single system —
unions and intersects of filters, diffs of concept sets, etc. — but
it is always scoped to one system.

Contract:

```js
/**
 * Execute an IR subtree scoped to this code system.
 * The subtree may be arbitrarily complex (union, intersect, diff of
 * selectors) but every selector node has the same system.
 *
 * @param {Expr} subtree - optimized IR node from rewrite.js
 * @param {Object} opts - { activeOnly, text, count }
 * @returns {AsyncIterable<Candidate>} stream of {code, display, context?, conceptId?}
 */
async *executeIR(subtree, opts) { ... }

/**
 * Build a membership index for point-checking codes against this subtree.
 * Used by the engine for cross-system exclusions.
 * @param {Expr} subtree
 * @returns {MembershipIndex} with sync .has(code) → boolean
 */
membershipForIR(subtree) { ... }
```

**v0 SQLite provider**: implements `executeIR()` natively by compiling
the IR subtree to SQL (using `sqlite-v0-sql.js`) and streaming results.
The entire subtree — unions, intersects, diffs of filters — becomes one
SQL query. `membershipForIR()` compiles to a prepared `EXISTS` statement.

**LegacyIRAdapter**: wraps any CodeSystemProvider. Implements `executeIR()`
by tree-walking: at each leaf selector, calls the provider's locate/filter/
iterator methods. At internal nodes (union/intersect/diff), composes
results using the membership index types from `membership.js`.

### Engine Orchestration

The engine is a new alternative expander that lives alongside the
existing `ValueSetExpander` in upstream's `expand.js`:

```
ExpandWorker.performExpansion()
  │
  ├─ if IR engine enabled:
  │     1. Compile ValueSet → optimized IR
  │     2. Partition IR by system
  │     3. For each system, get provider:
  │        - if provider has native executeIR → use it
  │        - else → wrap in LegacyIRAdapter
  │     4. Call executeIR(subtree) on each provider
  │     5. Cross-system dedup, exclusion (via membershipForIR), paging
  │     6. Decorate candidates (designations, properties)
  │     7. Build FHIR expansion result
  │     (falls back to legacy on failure)
  │
  └─ else: legacy ValueSetExpander (unchanged)
```

Upstream already has precedent for this pattern: `handlesSelecting()` /
`processSelection()` in cs-api.js lets a provider handle entire
include/exclude sets. Our `executeIR()` is the same idea taken further
— the provider handles an optimized IR subtree of arbitrary complexity.

### Decoration

The engine produces candidates with `{code, display, conceptId, context}`.
Decoration (designations, properties, extensions) happens after the
candidate set is computed:

- **v0 SQLite**: bulk-fetch by concept_id:
  ```sql
  SELECT * FROM designation WHERE concept_id IN (...)
  SELECT * FROM concept_literal WHERE source_concept_id IN (...)
  ```
- **Legacy providers**: call `cs.designations(ctx, displays)`,
  `cs.properties(ctx)`, `cs.extensions(ctx)` per candidate

In both cases, the decorated candidates are fed to the existing
`includeCode()` method (or its logic) for final FHIR formatting.
This preserves upstream's supplement overlays, language filtering,
property selection, etc.

## Implementation Phases (Revised)

### Phase 0: Create upstream-based branch + v0 provider

1. Create new branch from `upstream/main`
2. Add `better-sqlite3` dependency
3. Write the SQLite v0 provider in two layers:

   **Layer 1 — CodeSystemProvider for upstream expand.js**:
   - Factory class that loads a v0.db, registers with `library.js`
   - Provider class implementing upstream's `CodeSystemProvider` interface
   - Uses `better-sqlite3` (sync) against the v0 schema
   - Implements: locate, code, display, definition, isAbstract,
     isInactive, getPrepContext, filter, executeFilters, filterMore,
     filterConcept, filterCheck, iteratorAll, nextContext,
     designations, properties, searchFilter
   - This lets the legacy expand.js use v0 databases without IR

   **Layer 2 — `executeIR()` for the IR engine**:
   - Compiles IR subtree to SQL via `sqlite-v0-sql.js`
   - Streams results from `better-sqlite3`
   - `membershipForIR()` builds prepared `EXISTS` statement
   - This is what the IR engine calls for v0 systems

4. Add `sqlite-v0:` source type to `library.js`
5. Verify: server starts, loads v0 databases, legacy expand.js works
   with v0 provider for SNOMED/LOINC/RxNorm expansions

### Phase 1: Port standalone IR modules + LegacyIRAdapter

1. Copy the standalone IR modules (ir.js, build-ir.js, resolve-imports.js,
   rewrite.js, membership.js) — zero dependencies
2. Copy sqlite-v0-sql.js (the IR→SQL compiler) — used by the provider's
   executeIR() from Phase 0
3. Build the LegacyIRAdapter:
   - Wraps any CodeSystemProvider
   - Implements executeIR() by tree-walking IR, calling provider
     methods at leaves
   - Implements membershipForIR() using composable membership types
   - Handles union/intersect/diff via enumeration + membership
4. Verify integration tests pass (both v0 executor and legacy adapter)

### Phase 2: Engine orchestrator + wiring into expand.js

1. Port engine.js (orchestrator):
   - Compile → optimize → partition by system
   - For each system: check if provider has native executeIR,
     else wrap in LegacyIRAdapter
   - Cross-system exclusion via membershipForIR
   - Dedup + paging
2. Wire into upstream expand.js:
   - Add `_shouldUseIREngine()` / `_expandViaIREngine()` to ExpandWorker
   - Discover providers from `codeSystemFactories`
   - Env var opt-in: `EXPAND_IR_ENGINE=1`
   - Graceful fallback to legacy ValueSetExpander on failure

### Phase 3: Decoration pipeline

Engine produces candidates. Decorate from provider:
- **v0 SQLite**: bulk SQL by concept_id for designations, properties
- **Legacy**: call cs.designations(ctx), cs.properties(ctx) per code
- Feed decorated candidates into upstream's `includeCode()` logic
  or equivalent for final FHIR formatting (supplements, language
  filtering, property selection)

### Phase 4: Comparison testing

Expand a suite of ValueSets with both IR engine and legacy expander.
Compare results code-for-code, designation-for-designation.

### Phase 5: Advanced features
- Supplement handling
- Text search
- Hierarchy/count/total

## Upstream Provider API Summary

The `CodeSystemProvider` (cs-api.js) interface that the v0 provider
must implement:

### Metadata
```js
system()           → string  // e.g. 'http://snomed.info/sct'
version()          → string  // e.g. 'http://snomed.info/sct/900000000000207008/version/20250201'
name()             → string  // system|version
description()      → string
totalCount()       → integer
propertyDefinitions() → CodeSystem.property[]
contentMode()      → CodeSystemContentMode
isNotClosed()      → boolean
hasParents()       → boolean
specialEnumeration() → string|null  // URL of VS for grammar-based systems
```

### Concept Access (all async, take code:string or context:object)
```js
locate(code)       → {context, message}
code(ctx)          → string
display(ctx)       → string
definition(ctx)    → string
isAbstract(ctx)    → boolean
isInactive(ctx)    → boolean
isDeprecated(ctx)  → boolean
getStatus(ctx)     → string|null
itemWeight(ctx)    → string|null
parent(ctx)        → string|null
designations(ctx, displays) → void (populates Designations object)
properties(ctx)    → CodeSystem.concept.property[]
extensions(ctx)    → Extension[]
```

### Filter Protocol (all async)
```js
getPrepContext(iterate)           → FilterExecutionContext
filter(prep, prop, op, value)     → void (adds filter to context)
searchFilter(prep, filter, sort)  → void (adds text search)
executeFilters(prep)              → FilterConceptSet[]
filterMore(prep, set)             → boolean
filterConcept(prep, set)          → context
filterCheck(prep, set, context)   → true | string_error
filterLocate(prep, set, code)     → context | string_error
filterSize(prep, set)             → integer
filterFinish(prep)                → void
```

### Iteration (all async)
```js
iteratorAll()     → iterator
nextContext(iter) → context|null
```

### Factory Pattern

Upstream uses a two-tier pattern: **factory** (one per code system,
long-lived, registered at startup) and **provider** (per-request,
created by the factory).

**Factory** (extends `AbstractCodeSystemProvider`, registered in
`library.codeSystemFactories` keyed by system URI):
```js
system()          → string          // e.g. 'http://snomed.info/sct'
version()         → string|null     // e.g. 'http://snomed.info/sct/...20250201'
getPartialVersion() → string|null
assignIds(ids)    → void
listCodeSystems(fhirVersion, context) → Map<string, CodeSystem>
```

The factory is looked up by `worker.findCodeSystem(url, version, ...)` in
the expand worker via `provider.getCodeSystemProvider(opContext, url,
version, supplements)`. This call constructs a per-request
`CodeSystemProvider` from the factory.

For the v0 SQLite provider, the factory holds the `better-sqlite3` DB
connection (opened once at load time, shared across requests since
better-sqlite3 is thread-safe for reads). The per-request provider
gets the DB handle, opContext, and supplements from the factory.

**Registration** in `library.js`:
```js
case 'sqlite-v0':
  await this.loadSqliteV0(details, isDefault, mode);
  break;
```
`loadSqliteV0()` opens the DB, reads `code_system` metadata, creates
the factory, and calls `this.registerProvider(path, factory, isDefault)`.

## v0 Schema Tables (for reference)

```sql
code_system (cs_id, canonical, version, ...)
concept (concept_id, cs_id, code, display, definition, active, ...)
property_def (property_id, cs_id, property_code, value_kind, is_hierarchy)
concept_link (source_concept_id, property_id, target_concept_id)  -- concept-valued props
concept_literal (source_concept_id, property_id, value_text, ...)  -- literal-valued props
closure (cs_id, ancestor, descendant, depth)
designation (concept_id, language, use_system, use_code, value, ...)
value_set (vs_id, url, ...)
value_set_member (vs_id, concept_id)
search_fts_display, search_fts_designation, search_fts_literal  -- FTS5
```

## Concrete Starting Point

### Branches
- `upstream/main` — the base we branch from (remote: `github.com/HealthIntersections/FHIRsmith`)
- `rework-expand-codex-2` — dead-end JMandel branch, but has the portable `tx/engine/` modules
- New branch: `ir-engine` (created from `upstream/main`)

### Existing v0 Databases (ready to use)
```
/home/exedev/tx-data/sct_intl_20250201.v0.db    (919MB, 519K concepts)
/home/exedev/tx-data/loinc_281_full.v0.db        (817MB, 248K concepts)
/home/exedev/tx-data/rxnorm_02022026.v0.db       (441MB, 228K concepts)
```
These are also cached at `/home/exedev/FHIRsmith/data/terminology-cache/`.
The library YAML references them as `sqlite-v0:sct_intl_20250201.v0.db` etc.

### Node Version
The systemd service runs Node v24.13.1 (via fnm). The shell default is
Node v18.19.1. `better-sqlite3@12.x` requires Node 20+; it works with
Node 24. The v0 provider and IR engine must target Node 24 (matching
the server runtime). Use `/home/exedev/.local/share/fnm/aliases/default/bin/node`
for running tests.

### Files Ported from rework-expand-codex-2
These files have zero expand-v2 dependencies and are copied as-is:
```
tx/engine/ir.js              83 lines  - IR node types
tx/engine/build-ir.js        76 lines  - ValueSet JSON → IR
tx/engine/resolve-imports.js 153 lines - Import inlining
tx/engine/rewrite.js         435 lines - Optimization passes
tx/engine/membership.js      176 lines - Composable membership types
tx/engine/sqlite-v0-sql.js   482 lines - IR→SQL compiler
tx/engine/index.js            52 lines - Public API
```

These files have useful code but need rework for the new architecture:
```
tx/engine/sqlite-v0-executor.js  → becomes part of v0 provider's executeIR()
tx/engine/legacy-executor.js     → becomes LegacyIRAdapter
tx/engine/engine.js              → orchestrator, needs provider-based dispatch
tx/engine/expand-adapter.js      → rewrite for upstream expand.js
tx/engine/test-integration.js    → update to use provider API
tx/engine/test-e2e-server.js     → update for upstream server
```

## Research Provenance

| File | Contents |
|------|----------|
| `RESEARCH-upstream-expand.md` | Analysis of upstream expand.js, provider interface |
| `RESEARCH-sqlite-v0-sql-patterns.md` | SQL pattern catalog from v0 provider |
| `SQLITE_PROVIDER_ANALYSIS.md` | v0 provider architecture analysis |

## Commits (on rework-expand-codex-2, for reference only)

These are on the dead-end branch but contain useful code to port:

```
1394de6 Fix IR adapter output and add end-to-end server tests
33852d4 Fix offset/paging bugs in engine coordinator
6c85baf Update plan with current status, known issues, and handoff notes
e160264 Make legacy executor async-compatible, wire IR engine into expand-v2
ca46f21 Add IRExpandAdapter for integration with existing expand worker
f062797 Add integration tests for IR engine against real v0 databases
e690f14 Implement IR-based expansion engine (tx/engine/)
1fb3386 Add research provenance to plan, commit all research artifacts
1886967 Add detailed implementation plan for IR-based expansion engine
02d11bf SQLite v0 terminology providers with unified filter pipeline  ← v0 provider origin
```
