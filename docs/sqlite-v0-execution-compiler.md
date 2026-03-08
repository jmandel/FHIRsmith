# sqlite-v0 Execution Compiler

This document explains the sqlite-v0 native IR execution path as it exists in
this branch.

It is intentionally narrower than `docs/ir-engine.md` and less checklist-heavy
than `docs/sqlite-v0-provider-compiler-plan.md`.

The goal is to answer one question clearly:

> How does a scoped IR subtree become SQL in sqlite-v0?

For a concrete supplement-aware request flowing through that pipeline, see
[supplement-microscope.md](supplement-microscope.md).

## Why this exists

The old native sqlite-v0 path lowered projected IR directly into SQL strings.
That worked, but it mixed several concerns together:

- semantic lowering from IR into provider-local meaning
- runtime selection (`activeOnly`, text search)
- physical strategy choice
- SQL construction
- SQL rendering

That made correctness bugs harder to localize and performance rewrites harder
to justify.

The current design splits those concerns into explicit stages while keeping the
same public provider API:

- `executeIR(subtree, opts)`
- `countForIR(subtree, opts)`
- `membershipForIR(subtree)`

Callers do not see plans. All planning artifacts are provider-private.

When native supplement attachment is unavailable, the non-native supplement
fallback now reuses the shared generic IR executor core in
`tx/engine/generic-ir-executor.js` rather than maintaining a second copy of the
set/paging/hierarchy executor inside the supplement runtime. That keeps the
sqlite compiler-specific work narrowly focused on native execution.

## Preconditions

By the time sqlite-v0 sees a subtree, `tx/engine` has already done the semantic
compiler work:

1. `build-ir.js`
   - `ValueSet.compose -> semantic IR`
2. `resolve-imports.js`
   - inlines imported ValueSets
3. `orchestrator.js`
   - binds `lockedDate` to explicit versions when possible
4. `rewrite.js`
   - canonicalizes and simplifies the IR
5. `orchestrator.js`
   - partitions by `(system, version)` and hands sqlite-v0 a single-scope subtree

That boundary matters. sqlite-v0 does not own ValueSet semantics. It owns
native execution for one projected code-system bucket.

## Pipeline

Inside sqlite-v0, the execution pipeline is:

```text
scoped IR
  -> base SetPlan
  -> normalized base SetPlan
  -> terminal plan
  -> SQL AST
  -> SQL text + params
  -> SQLite execution
  -> optional strategy view (for traces/tests only)
```

The three public native entrypoints use different slices of that pipeline:

- `membershipForIR`
  - uses the base membership set only
  - no `activeOnly`
  - no runtime text filtering
- `countForIR`
  - uses the base membership set plus terminal-time runtime selection
  - then builds a count terminal plan
- `executeIR`
  - uses the base membership set plus terminal-time runtime selection
  - then builds a materialize terminal plan with ordering/paging
- traces/tests
  - can additionally request debug artifacts such as the selected-membership
    view and strategy view

## Runtime schema only

The SQL compiler now targets exactly one SQLite schema: the real sqlite-v0
runtime schema used by the provider in production.

Relevant tables:

- `concept`
- `property_def`
- `concept_literal`
- `concept_link`
- `designation`
- `closure`
- `value_set`
- `value_set_member`
- `search_fts_display`
- `search_fts_designation`
- `search_fts_literal`

The test suite still uses synthetic in-memory terminology models for semantic
oracles, but DB-backed SQL parity tests also run against this same runtime
schema shape.

## Core artifacts

### 1. SetPlan

`SetPlan` denotes an unordered set of scoped `concept_id` members.

Representative forms:

- `empty`
- `allConcepts`
- `explicitCodes`
- `fromRows`
- `union`
- `intersect`
- `diff`

This is the provider-private membership layer. It answers:

> Which concepts in this one scope are members?

### 2. RowPlan

`RowPlan` is the relational escape hatch used inside `SetPlan`.

Representative forms:

- `row-scan`
- `row-filter`
- `row-project`
- `row-join`
- `row-semiJoin`
- `row-antiJoin`
- `row-unionAll`
- `row-distinct`
- `row-reachability`
- `row-search`
- `row-values`

This lets clause lowering stay complete without pretending every provider
operation can be captured by a tiny closed enum.

### 3. Runtime selection

Request-time filters that apply only to this request are carried separately from
the base membership kernel:

- `activeOnly`
- runtime text search

SQL generation applies these selectors at the terminal stage so hierarchy/set
algebra can keep their cheaper base shapes. The older logical "selected"
membership artifact still exists only as an optional debug/test artifact and is
not built on the hot path unless explicitly requested.

### 4. Terminal plans

Terminal plans are consumer-specific:

- `materializeConcepts`
- `countMembers`
- `probeMemberByCode`

This keeps materialization/count/probe concerns out of the logical membership
layer.

### 5. Physical plan

The "physical plan" is now just a strategy-annotated view used for traces,
snapshots, and tests.

Representative strategy choices:

- closure join vs recursive reachability
- semijoin/antijoin vs other set shapes
- FTS-backed search vs display `LIKE`
- ordered materialization
- count-specialized projection

This is intentionally lighter than a full cost-based physical optimizer. SQL
lowering consumes logical terminal/set/row plans directly and derives any
needed strategy choices inline. The strategy view exists only so runtime traces
and structural tests can still talk about chosen shapes without requiring a
second executable tree, and it is built only when tracing/tests ask for it.

### 6. SQL AST

The SQL AST is a structured representation of the subset of SQL sqlite-v0
actually emits:

- `select`
- `compound`
- `with`
- `join`
- expressions and predicates

No semantic decisions should happen here. By this stage, planning is done.

Implementation split:
- `tx/cs/sqlite-v0-sql-nodes.js` owns AST node constructors and structural-form helpers
- `tx/cs/sqlite-v0-sql-patterns.js` owns shape-detection helpers used by the
  hot terminal paths
- `tx/cs/sqlite-v0-sql-strategies.js` owns terminal strategy choice for
  `materialize` / `count`
- `tx/cs/sqlite-v0-sql-search.js` owns runtime text-search lowering and search
  strategy helpers
- `tx/cs/sqlite-v0-sql-ast.js` owns physical-plan-to-AST lowering once a
  strategy and matching pattern have already been selected

### 7. SQL emit

The emitter renders SQL AST to:

- SQL text
- bound params

This step is intentionally dumb. If a bug appears here, it should be a
rendering bug, not a planning bug.

## Clause lowering

Selector/filter lowering lives in the clause-lowering registry.

Current responsibilities:

- decide whether sqlite-v0 supports a given clause
- lower supported clauses into `SetPlan` / `RowPlan`
- fail explicitly on unsupported clauses

This same lowering surface now also defines `doesFilter()` capability support,
so support checks and lowering semantics do not drift apart.

## Hierarchy handling

Hierarchy is treated as a first-class relation, not a one-off special case.

Two important cases exist:

1. default concept hierarchy
   - uses the runtime `closure` table
2. property-backed hierarchy
   - uses runtime `concept_link`
   - lowers to recursive CTE reachability when needed

The corresponding logical operator is `row-reachability`.

This matters because hierarchy semantics are where SQL compilers often cheat.
The current design makes the relation explicit in the plan rather than hiding
it inside ad hoc SQL snippets.

Two performance notes are now important here:

1. source pruning for supplement-backed property clauses
   - before lowering a property clause, sqlite-v0 now consults the effective
     property manifest across the base DB and active supplement bindings
   - it only scans source families that actually define that property in the
     required value kind
   - this avoids generic "search every possible source" SQL when a clause is
     known to exist only in one supplement or only in the base DB

2. narrow reachability fast paths for large same-system set algebra
   - simple single-seed closure expansion already has a direct closure-join
     terminal shape
   - for small first-page materializations (`count<=100`, `offset=0`,
     `ORDER BY code ASC`), sqlite-v0 now prefers a concept-driven early-stop
     shape over full closure materialization when that is cheaper
   - keyed row semijoins/antijoins feeding membership sets now lower as set
     `INTERSECT` / `EXCEPT`, instead of correlated `EXISTS` / `NOT EXISTS`
   - same-system reachability `diff` now lowers to a direct anti-join between
     two seeded closure descendant sets for counts, and to `EXCEPT` for page
     materialization
   - same-system reachability `intersect` now lowers to a direct join between
     two seeded closure descendant sets
   - same-system `reachability ∩ anchored code-regex` now lowers to a direct
     closure join against `concept`, with regex range pruning on `concept.code`,
     instead of a correlated `EXISTS` over the regex branch
   - for the `intersect` case only, sqlite-v0 uses a narrow planner hint:
     two cheap descendant-count probes to choose the smaller seeded closure set
     as the driving side

That probe is intentionally narrow. It exists because SQLite does not reliably
reorder those derived closure joins on its own, and the difference between the
wrong and right driving side can be orders of magnitude on real SNOMED cases.

We also tried two additional general planner ideas and left them out because
they did not show stable wins on the real v0 databases:

- treating runtime text search as a separate concept-id set to intersect before
  the final `concept` join
- pushing `src.active=1` into property-source scans for `activeOnly=true`

## Example

Suppose the scoped subtree means:

- include descendants of `A`
- intersect with `CLASS = CHEM`
- exclude `B`
- then apply `activeOnly=true` and text filter `alpha`

The pipeline shape is:

```text
scoped IR
  -> diff(
       intersect(
         fromRows(reachability(concept hierarchy, seed=A)),
         fromRows(literal CLASS matcher)
       ),
       explicitCodes(B)
     )
  -> intersect(
       <base>,
       fromRows(active concepts),
       fromRows(search(alpha))
     )
  -> materializeConcepts(order by code, offset/count)
  -> physical plan
  -> SQL AST
  -> SQL
```

The important property is that the meaning is explicit before SQL rendering.

## Important invariants

- sqlite-v0 only accepts single-scope projected IR
- provider-local unsupported lowering is an explicit error, not an empty result
- `membershipForIR` uses base membership only
- `countForIR` and `executeIR` use selected membership
- ordering/paging are terminal concerns, not logical membership concerns
- DB-backed SQL parity tests execute against the real runtime schema

## Main files

Core provider/compiler files:

- `tx/cs/cs-sqlite-v0.js`
- `tx/cs/sqlite-v0-compiler.js`
- `tx/cs/sqlite-v0-clause-lowering.js`
- `tx/cs/sqlite-v0-hierarchy.js`
- `tx/cs/sqlite-v0-plan-types.js`
- `tx/cs/sqlite-v0-plan-builder.js`
- `tx/cs/sqlite-v0-selection-builder.js`
- `tx/cs/sqlite-v0-terminal-builder.js`
- `tx/cs/sqlite-v0-plan-normalize.js`
- `tx/cs/sqlite-v0-physicalize.js`
- `tx/cs/sqlite-v0-sql-nodes.js`
- `tx/cs/sqlite-v0-sql-patterns.js`
- `tx/cs/sqlite-v0-sql-strategies.js`
- `tx/cs/sqlite-v0-sql-ast.js`
- `tx/cs/sqlite-v0-sql-emit.js`
- `tx/cs/sqlite-v0-format-plan.js`

Relevant test/support files:

- `tests/cs/sqlite-v0-compiler.test.js`
- `tests/cs/sqlite-v0-sql-parity.test.js`
- `tests/cs/sqlite-v0-four-oracle-bounded-exhaustive.test.js`
- `tests/support/terminology-model/`
- `tests/support/sqlite-v0-runtime-db.js`

## Testing strategy

This compiler is not tested with only one giant end-to-end suite.

That would be weaker than it sounds, because if one test fails you still do not
know whether the bug is in:

- engine semantic lowering
- sqlite-v0 logical lowering
- physical planning
- SQL generation
- or the database execution itself

Instead, the test strategy uses several independent checks at different
boundaries.

### The four-oracle idea

The core trick is to compare four different ways of answering the same question:

1. **compose evaluator**
   - a simple reference evaluator for `ValueSet.compose`
   - this is the plainest semantic oracle
2. **scoped IR interpreter**
   - interprets projected IR directly, without SQL
3. **sqlite-v0 logical-plan interpreter**
   - interprets `SetPlan` / `RowPlan` directly, without SQLite
4. **runtime-schema SQL execution**
   - executes emitted SQL against an in-memory SQLite database built with the
     real sqlite-v0 schema

Why this is useful:

- if 1 and 2 disagree, the engine compiler is wrong
- if 2 and 3 disagree, sqlite-v0 lowering is wrong
- if 3 and 4 disagree, physical planning or SQL generation is wrong

That makes failures localizable instead of mysterious.

### Planner lessons so far

Two concrete planner rules turned out to matter a lot in practice:

1. Same-system reachability `diff` and `intersect` cases need dedicated
   set-oriented SQL shapes rather than generic correlated membership checks.
2. Anchored code-regex filters should not go through generic membership
   lowering. When a safe literal prefix can be extracted from a regex such as
   `^7[0-9]{4,}`, sqlite-v0 now constrains the query with an indexable code
   range first and applies `REGEXP` only inside that narrowed slice.

### Bounded exhaustive tests

Another unusual part of the suite is **bounded exhaustive testing**.

This means:

- build very small fake terminology universes
- enumerate many or all possible combinations within that small universe
- compare all four oracles on every case

For example:

- 2 concepts instead of millions
- several active/inactive combinations
- several small hierarchy shapes
- several refset membership combinations
- several small ValueSet shapes

This works well because many correctness bugs are small logic bugs:

- wrong include-self behavior
- union vs intersection mistakes
- off-by-one paging logic
- exclusion applied in the wrong order

Those bugs do not require huge terminologies to reproduce. Small exhaustive
spaces often catch them better than large random tests.

### Fuzzing

The suite also uses randomized fuzzing.

Here the idea is:

- generate many small random fixtures
- generate many small random IR trees / ValueSets
- compare interpreters and SQL results

Fuzzing is good at finding combinations humans do not think to write by hand.
It complements bounded exhaustive testing:

- bounded exhaustive is systematic over very small spaces
- fuzzing explores broader, messier spaces

### Metamorphic tests

A metamorphic test starts with one valid input, then changes it in a way that
should not change the answer.

Examples:

- reorder commutative branches
- normalize a plan twice
- split a concept list and union it back together
- compare a full result to the concatenation of its pages

These tests are good at catching normalization and pagination bugs.

### Mutation sentinels

The suite also includes mutation-style sentinel tests.

The point is to make sure the tests would notice if a common bug were introduced
later, such as:

- `is-a` accidentally excluding self
- `descendent-of` accidentally including self
- missing `DISTINCT`
- wrong sort key before paging
- wrong join key in property matching

This does not prove perfection, but it does prove the suite is watching for the
right kinds of mistakes.

### Why the SQL tests use the runtime schema

The SQL parity tests now execute against the same schema shape the real provider
uses in production.

That matters because a “simpler test schema” can accidentally hide mistakes in:

- property lookup joins
- `property_id` handling
- `edge_set_id` handling
- FTS table wiring
- `value_set` / `value_set_member` joins

Using the real schema shape keeps the SQL compiler honest.

## How to read a failure

When a test fails, use the boundary where it failed to localize the bug:

- compose evaluator vs scoped IR interpreter
  - engine semantic compiler bug
- scoped IR interpreter vs sqlite-v0 logical interpreter
  - provider-local lowering bug
- logical interpreter vs runtime-schema SQL parity
  - physical planning or SQL AST / SQL emit bug
- harness-only mismatch
  - likely output shaping, orchestration, or integration behavior

## Related docs

- [ir-engine.md](ir-engine.md)
- [sqlite-v0-provider-compiler-plan.md](sqlite-v0-provider-compiler-plan.md)
- [ir-fuzzing.md](ir-fuzzing.md)
