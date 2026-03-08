# IR Architecture Hotspots: SQL AST and IR Traversal

This note captures two residual architecture issues extracted from a larger IR
review set. These are the ones that still meaningfully apply in the current
codebase:

1. `tx/cs/sqlite-v0-sql-ast.js` remains a large, high-pressure terminal SQL
   lowering module.
2. IR tree traversal is still open-coded in many places instead of flowing
   through one shared helper.

The goal here is not a full redesign. The goal is to explain what the issues
actually are, why they matter, and what a narrow cleanup path looks like.

## Current Status

As of March 7, 2026:

- Issue 1 is substantially addressed:
  - terminal `materialize` / `count` strategy choice is now centralized in
    `tx/cs/sqlite-v0-sql-strategies.js` and covered by strategy-contract tests
  - IR/sqlite shape detection lives in `tx/cs/sqlite-v0-sql-patterns.js`
    instead of being duplicated inline inside `sqlite-v0-sql-ast.js`
  - runtime text-search lowering now lives in `tx/cs/sqlite-v0-sql-search.js`
    instead of being open-coded inside the main AST lowering module
  - `sqlite-v0-sql-ast.js` is still a hot-path lowering module, but it now
    reads as a SQL builder over chosen strategies and imported pattern/search
    helpers
- Issue 2 is addressed:
  - `tx/engine/ir-traversal.js` now provides shared `irChildren`, `walkIR`,
    `mapIR`, and `mapIRAsync` helpers
  - active low-risk callers have been migrated off bespoke child recursion

## Issue 1: `sqlite-v0-sql-ast.js` Monolith

### What It Is

`tx/cs/sqlite-v0-sql-ast.js` is the terminal SQL lowering layer for sqlite-v0.
It is where many concerns meet:

- selected membership lowering
- count vs materialize terminals
- text/designation/property predicate lowering
- supplement-native query fragments
- first-page and count fast paths
- pagination/count execution heuristics

One important clarification: the AST-node-constructor split has already
happened. Low-level AST node construction lives in
`tx/cs/sqlite-v0-sql-nodes.js`, so the remaining concern is not "AST node
constructors and lowering are mixed together." The remaining concern is that
plan-to-AST lowering, execution-shape choice, and fast-path strategy logic are
still concentrated in one file.

That concentration is understandable because this is where performance is won
or lost. The problem is not merely file length. The problem is that structural
lowering, execution strategy selection, and SQL fragment construction are still
mixed together in one place.

### Why It Is A Problem

The architectural risk is that plan-shape changes in earlier stages can change
the emitted SQL shape without an obvious contract failure.

This can happen even when semantics are unchanged.

Example:

- one query may arrive at lowering time as a single selector with
  `intersectCodes`
- another semantically equivalent query may arrive as an `intersect` of two
  selectors

If one shape triggers a fast path and the other falls back to a generic path,
performance changes dramatically even though the IR still means the same thing.

That makes the SQL emitter sensitive to normalization details that are only
implicitly documented.

The more specific hazard is that current fast-path extractors do not only
inspect terminal plan intent; they also unwrap normalization layers in order to
pattern-match the underlying membership structure. In practice this means the
normalization layer and the fast-path layer have an implicit co-evolution
contract:

- `plan-normalize.js` decides how membership/row wrappers are formed
- `sqlite-v0-sql-ast.js` fast paths reach back through those wrappers to detect
  cases such as single-seed reachability, regex lowering opportunities, or
  supplement-native predicate shapes

If normalization changes how those wrappers are arranged, fast-path detection
can silently stop matching even though semantics remain correct. That is a more
serious hazard than ordinary "big file" pressure, and it is exactly why
strategy-choice tests are needed.

### Concrete Example

Suppose a request means:

- start with a large LOINC subset
- apply an exact property filter
- apply text search
- return the first page

In the current design, one file is responsible for deciding all of the
following:

- whether this should use a concept-driven first-page path
- whether count can use a specialized path
- how text matches are expressed
- how property equality gets lowered
- whether supplement-native fragments are needed

That is too much decision power for one layer unless the internal contracts are
made more explicit.

### Proposal

Do not split the file into many modules immediately. First, impose stronger
structure inside the existing module.

#### Step 1: Extract terminal strategy selection first

The first cleanup should not assume the final strategy taxonomy up front.
Instead, pull the existing strategy choice into one explicit chooser and name
the strategies that actually fall out of current behavior.

The likely result will be a small set of named execution shapes, for example:

- `count`
- `materialize-page`
- one or more specialized count fast paths
- one or more specialized first-page fast paths
- supplement-native variants where they are truly distinct

But the recommendation is to extract the chooser first, then name what it is
already doing, rather than predicting the final list too early.

The important improvement is that strategy choice happens in one place instead
of being inferred across many helper branches.

#### Step 2: Keep fragment builders narrow and dumb

After strategy selection, fragment builders should only build SQL for a known
shape. They should not also decide whether that shape should have been chosen.

Examples of fragment-builder responsibilities:

- membership source builder
- text predicate builder
- property predicate builder
- designation predicate builder
- supplement query builder

Examples of responsibilities they should not own:

- whether a first-page optimization is allowed
- whether to switch to a count fast path
- whether a normalized plan shape qualifies for a specialized route

#### Step 3: Add stage-contract tests around strategy choice

Tests should assert not only result parity, but strategy stability where it
matters.

Example contract:

- two semantically equivalent normalized plans that are intended to share a
  fast path should choose the same terminal strategy
- changes in plan normalization should not silently disable an intended fast
  path unless the strategy-choice contract test is updated deliberately

This is stronger than today’s “output still correct” coverage and helps catch
silent performance regressions caused by harmless-looking earlier rewrites.

### Acceptance Criteria

- A reader can answer "why did this query use this SQL shape?" from one small
  strategy chooser.
- Fast paths are selected in one place.
- SQL builders stop reaching back into higher-level normalization assumptions.
- Equivalent intended shapes have explicit strategy-choice tests.

### Priority

This was one of the highest-value cleanup targets because it sits on the
runtime hot path and directly affects performance stability.

That first cleanup has now landed:

- strategy selection is separated from SQL building
- shape detection is separated from both
- the remaining work here is optional deeper decomposition, not a missing
  architectural seam

## Issue 2: Repeated IR Tree Walks / No Shared Traversal Helper

### What It Is

IR traversal is still open-coded in many places with local recursion and
`switch (node.kind)` logic.

Examples include:

- `tx/engine/rewrite.js`
- `tx/engine/ir-expansion-plan.js` (itself a newer extraction from the old
  orchestrator blob)
- `tx/engine/generic-ir-executor.js`
- `tx/engine/ir-expansion-response.js`
- `tx/engine/resolve-imports.js`
- `tx/engine/scoped-ir-interpreter.js`
- `tx/engine/ir-debug.js`

In practice this is more than a handful of isolated recursions. There are
double-digit `switch (node.kind)` sites and inline `.kind` checks across these
files, plus local recursive helpers. This is manageable with six IR node kinds,
but it scales badly. Every new node kind or child-bearing field becomes a
grep-and-remember exercise.

### Why It Is A Problem

The main risk is incomplete traversal.

A local collector or transformer may know how to recurse through:

- `items`
- `left`
- `right`
- `resolved`

but if a future IR shape adds another child reference, every handwritten walker
must be updated manually.

That creates a weak maintenance contract:

- correctness depends on remembering all the tree walkers
- not on one authoritative traversal definition

### Concrete Example

`tx/engine/ir-expansion-response.js` has a local `walkIR()` used to collect
compose display/designation overrides for explicit `concept` entries.

That function manually descends through:

- `items`
- `left`
- `right`
- `resolved`

The logic itself is fine. In fact, this local helper is close to the helper the
codebase likely wants. The smell is that child traversal is duplicated there
instead of flowing through a shared helper.

### Proposal

Add one tiny shared traversal utility for IR. Do not build a large visitor
framework.

A small helper layer is enough:

- `walkIR(node, fn)`
- `mapIR(node, fn)`

Optional later, if it becomes clearly useful:

- `reduceIR(node, reducer, seed)`

### How It Would Work

`walkIR(node, fn)`:

- visits the current node
- handles child traversal centrally
- passes minimal context as needed

`mapIR(node, fn)`:

- recursively maps children first or last, depending on chosen convention
- rebuilds the tree structurally in one place
- allows transforms without every caller rewriting child recursion

This is enough for most existing patterns, which fall into three buckets:

- collect something
- test for something
- rewrite something

### Why Not A Bigger Framework

The IR is still intentionally small and simple. A full visitor framework would
solve a real problem with too much machinery.

The goal is only to centralize child traversal and make new node kinds safer to
add.

One important tension should be stated explicitly: `rewrite.js` is the hard
case. Its switches do not just walk the tree; they perform different structural
transforms such as simplification, canonicalization, and partition analysis.
A shared helper would centralize child enumeration, but the per-kind transform
logic would still live in those callers. That is fine. The value of the helper
is reducing duplicated recursion, not removing per-kind transform logic.

### Acceptance Criteria

- child traversal shape is defined in one place
- simple collectors stop open-coding recursion
- adding a new IR node kind requires updating one traversal helper first
- low-risk users like debug/render/collector code switch over before deeper
  rewrite logic does

### Priority

This is cheaper and lower risk than the SQL AST cleanup, so it is a good
precursor cleanup.

Recommended order:

1. add the shared traversal helper
2. migrate low-risk collectors/debug/render helpers first
3. leave deeper rewrite/execution callers for later

That lowers future refactor risk before touching more sensitive SQL/runtime
paths.

## Suggested Sequencing

If these are addressed incrementally, the most practical order is:

1. add shared IR traversal helpers and migrate low-risk tree walks
2. add explicit terminal strategy selection inside `sqlite-v0-sql-ast.js`
3. only then consider deeper file-splitting or larger compiler refactors

This order favors low-risk contract cleanup first, then higher-value hot-path
cleanup with clearer internal assumptions.
