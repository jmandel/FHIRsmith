# sqlite-v0 Provider-Private Execution Compiler Plan

## Scope

This document is the implementation plan for the next major step in the IR
engine architecture:

- `tx/engine` remains the semantic compiler for `ValueSet.compose`
- native providers keep the existing public API:
  - `executeIR(subtree, opts)`
  - `countForIR(subtree, opts)`
  - `membershipForIR(subtree)`
- sqlite-v0 gains an internal execution compiler pipeline that is private to
  the provider and does not leak to callers

This plan is intentionally detailed and checklist-driven so it can be used as
the working tracker while implementation proceeds.

## Schema boundary clarification

The provider compiler now targets exactly one SQL schema:

- `runtime schema`:
  - the real on-disk sqlite-v0 database layout used by
    `tx/cs/cs-sqlite-v0.js`
  - tables such as `concept`, `concept_literal`, `concept_link`,
    `designation`, `closure`, `property_def`, `value_set`,
    `value_set_member`, and the real FTS tables
  - this is the schema used in production and in DB-backed parity tests

The remaining synthetic oracle is no longer a second SQLite schema. It is the
pure in-memory terminology model used by compose / scoped-IR / logical-plan
interpreters.

Hard rule:

- [x] We are **not** planning a migration of the real sqlite-v0 DB format
- [x] DB-backed oracle and parity tests should execute against the real runtime
  schema
- [x] The synthetic test model is an abstract fixture model, not an alternate
  stored schema

Related clarification:

- `switch execution paths` means switching the provider's **internal compiler
  implementation** from the current direct `sqlite-v0-sql.js` path to the new
  `SetPlan -> RowPlan -> PhysicalPlan -> SQL AST -> SQL emit` path
- it does **not** mean changing the sqlite-v0 database schema
- it does **not** mean changing caller-visible provider APIs

## Current design decision

We are explicitly pivoting to the RFC's stronger internal model before SQL AST
work proceeds:

- sqlite-v0 should use an explicit `SetPlan` + `RowPlan` split internally
- the planning path now uses `SetPlan` + `RowPlan` as the primary
  internal boundary in `sqlite-v0-plan-builder.js`,
  `sqlite-v0-plan-normalize.js`, `sqlite-v0-plan-interpret.js`, and
  `sqlite-v0-physicalize.js`
- the earlier transitional scaffolding (`sqlite-v0-membership-plan.js` and the
  direct `sqlite-v0-sql.js` builder) has now been retired
- correctness, completeness, and proof-alignment take priority over preserving
  provisional module shapes just because they already exist

## Current baseline

The following pieces already exist in the branch today:

- [x] Semantic ValueSet -> IR compilation in `tx/engine/build-ir.js`
- [x] Import resolution in `tx/engine/resolve-imports.js`
- [x] `lockedDate` binding hook in `tx/engine/orchestrator.js`
- [x] Semantic rewrite / normalization in `tx/engine/rewrite.js`
- [x] Partition safety guard in `tx/engine/orchestrator.js`
- [x] Partitioning by `(system, version)` in `tx/engine/orchestrator.js`
- [x] Native sqlite-v0 provider entrypoints in `tx/cs/cs-sqlite-v0.js`
- [x] Direct SQL-generation seam retired; runtime now goes through the provider-private compiler
- [x] Direct-oracle fuzzing for semantic IR correctness
- [x] Full HTTP harness coverage for current 166 IR tests

The following target capabilities do not exist yet:

- [x] Stable IR node ids and deterministic canonical hashes
- [x] Scoped-IR interpreter owned by `tx/engine`
- [x] Provider-private logical membership kernel for sqlite-v0
- [x] Provider-private logical interpreter for sqlite-v0
- [x] Explicit physical planning layer separated from logical lowering
- [x] SQL AST / structured query representation
- [x] SQL renderer isolated from physical planning
- [x] Bounded exhaustive model-check tests across all transform boundaries
- [x] Provider-boundary comparison tooling for compiler validation

## Problem statement

Today sqlite-v0 does too much in one step.

The current native path effectively combines:

1. projected IR -> provider semantics lowering
2. strategy choice
3. SQL text construction
4. SQL execution

That creates two concrete problems.

First, correctness failures are hard to localize. A mismatch might be caused by:

- semantic IR lowering
- partition projection
- provider-local lowering
- SQL shape choice
- SQL rendering
- SQLite execution behavior

Second, performance work is harder to justify and verify. A rewrite such as
`JOIN` vs `EXISTS` currently looks like a SQL trick, when it should be an
explicit physical optimization with named preconditions and a separate proof
surface.

The design goal is to separate:

- engine-owned semantic compilation
- provider-private logical compilation
- provider-private physical planning
- SQL rendering
- execution

without changing the caller-visible contract.

## Goals

- [x] Keep `tx/engine` as the sole owner of `ValueSet.compose` semantics
- [x] Keep provider public APIs unchanged
- [x] Add a provider-private logical execution layer for sqlite-v0
- [x] Adopt an explicit `SetPlan` + `RowPlan` split before SQL AST work
- [x] Make unsupported provider-local lowering explicit, never silently empty
- [x] Enable multiple independent correctness oracles at each transform boundary
- [x] Make physical planning decisions explicit, named, and traceable
- [x] Preserve stable provider behavior while tightening internal compiler boundaries
- [x] Improve traceability, caching, and debuggability of native provider execution

## Non-goals

- [x] Do not invent a new caller-visible plan API
- [x] Do not move ValueSet semantics out of `tx/engine`
- [x] Do not build a generic SQL engine
- [x] Do not rewrite every provider at once
- [x] Do not couple output shaping to sqlite-v0 internal plans
- [x] Do not rely only on end-to-end DB execution as the semantic oracle

## Architecture invariants

These are hard constraints for the design and implementation.

- [x] `tx/engine` owns semantic compilation through partition-safe scoped IR
- [x] Native providers see only projected subtrees scoped to a single `(system, version)` bucket
- [x] `lockedDate` is resolved before provider planning when possible; provider planning never invents a version from a date
- [x] unresolved imports do not enter native provider compilation unless fallback policy explicitly allows it
- [x] sqlite-v0 logical planning is provider-private and never exposed outside the provider
- [x] unsupported filter/property/op lowering returns explicit unsupported status, not an empty set
- [x] runtime request filters that affect membership (`activeOnly`, text search) are represented explicitly in provider-private plans
- [x] sqlite-v0 planning is split into `SetPlan` membership semantics and `RowPlan` relational subplans
- [x] terminal plans for materialize/count/probe are explicit and distinct from base/selected membership plans
- [x] output shaping, compose overrides, warnings, supplement decoration, and `contains` nesting stay outside the provider-private membership kernel
- [x] canonical normalization is deterministic and idempotent

## Pipeline overview

The target end-to-end pipeline is:

```text
ValueSet JSON
  -> Semantic IR
  -> Resolved IR
  -> Bound IR (lockedDate resolved)
  -> Canonical IR
  -> Projected Scoped IR
  -> [inside sqlite-v0 only]
       Base SetPlan
       -> Canonical Base SetPlan
       -> Selected SetPlan
       -> Terminal Plan
       -> Physical Plan
       -> SQL AST
       -> SQL text + params
       -> SQLite execution
       -> candidate rows / count / probe result
  -> orchestrator decoration / overrides / warnings / nesting
  -> final FHIR ValueSet expansion
```

The three native sqlite-v0 entrypoints consume different internal artifacts:

```text
membershipForIR: Base SetPlan -> probe terminal plan -> physical plan -> SQL
countForIR:      Selected SetPlan -> count terminal plan -> physical plan -> SQL
executeIR:       Selected SetPlan -> materialize terminal plan -> physical plan -> SQL
```

## Stage-by-stage target design

### Engine-owned stages

#### Stage A: ValueSet JSON -> Semantic IR

Owner:

- `tx/engine/build-ir.js`

Current status:

- [x] Exists
- [x] Stable node ids
- [x] Canonical structural hash

Required outcomes:

- [x] Every IR node gets a stable id
- [x] `meta.path` survives all semantic stages
- [x] Hashing is deterministic for semantically equivalent canonical trees

#### Stage B: Import resolution

Owner:

- `tx/engine/resolve-imports.js`

Current status:

- [x] Exists
- [x] Explicit unresolved-import policy surface for native planning

Required outcomes:

- [x] Imports resolved before native planning unless explicit fallback path is taken
- [x] Used-import tracking remains attached to resolved IR
- [x] Cycle / max-depth / max-node failure surfaces remain explicit

#### Stage C: lockedDate binding

Owner:

- `tx/engine/orchestrator.js`

Current status:

- [x] Exists
- [x] Bound-IR artifact formalized as a first-class stage and exported from `tx/engine`

Required outcomes:

- [x] Bound selectors are explicit about whether version is resolved or intentionally still unversioned
- [x] Warning behavior is preserved
- [x] Downstream native planning never tries to reinterpret `lockedDate`

#### Stage D: Semantic normalization and rewrite

Owner:

- `tx/engine/rewrite.js`

Current status:

- [x] Exists
- [x] Deterministic ordering is guaranteed on canonical rewrite output

Required outcomes:

- [x] Normal form is deterministic
- [x] Rewrites are idempotent
- [x] Canonical ordering is stable for commutative nodes
- [x] Canonical form is suitable for hashing, snapshots, and trace output

#### Stage E: Partitioning and projection

Owner:

- `tx/engine/orchestrator.js`

Current status:

- [x] Exists
- [x] Partition safety guard exists
- [x] Scoped-IR artifact is formalized via projection analysis and first-class interpreter support

Required outcomes:

- [x] Each projected subtree is provably scoped to one `(system, version)` bucket
- [x] Projection failure remains explicit and forces fallback
- [x] Scoped IR can be interpreted independently in tests

### Provider-private sqlite-v0 stages

#### Stage F: Scoped IR -> Base SetPlan

Owner:

- new internal sqlite-v0 modules

Purpose:

- represent membership semantics over sqlite-v0 native identity under a fixed scope

Important design constraint:

- use `concept_id` as provider-native identity under a fixed `(system, version)` scope
- where FHIR semantics require code-level set identity, represent that explicitly instead of assuming it implicitly

Required outcomes:

- [x] Base `SetPlan` exists as a first-class internal artifact
- [x] Unsupported lowering is explicit
- [x] Clause-lowering is centralized in a registry
- [x] Hierarchical reachability is represented explicitly, not buried in SQL snippets
- [x] `fromRows`/row-plan bridge exists for clause-lowered relational semantics

#### Stage F2: RowPlan lowering boundary

Owner:

- new internal sqlite-v0 modules

Purpose:

- represent clause-lowered relational semantics explicitly without jumping
  directly to SQL text

Required outcomes:

- [x] `RowPlan` exists as a first-class internal artifact
- [x] `RowPlan` covers the relational subset sqlite-v0 actually needs
- [x] clause lowering can target `RowPlan` where specialized `SetPlan` leaves are
  not sufficient
- [x] reachability and search can be represented without embedding SQL text

#### Stage G: SetPlan / RowPlan normalization

Owner:

- new internal sqlite-v0 normalization module

Required outcomes:

- [x] Deterministic normalization
- [x] Idempotence
- [x] Dedupe of equivalent commutative children
- [x] Stable hash for normalized kernels
- [x] Debug text for normalized kernels

#### Stage H: Selected SetPlan

Owner:

- new internal sqlite-v0 planning module

Purpose:

- add request-time membership-affecting filters

Required outcomes:

- [x] `activeOnly` represented explicitly
- [x] text search represented explicitly
- [x] membership probe path remains based on base kernel, not selection kernel
- [x] expand/count use selection kernel

#### Stage H2: Terminal plans

Owner:

- new internal sqlite-v0 planning module

Purpose:

- derive consumer-specific terminal plans without exposing them publicly

Required outcomes:

- [x] materialize terminal plan exists
- [x] count terminal plan exists
- [x] probe terminal plan exists
- [x] terminal plans are distinct from base and selected membership plans

#### Stage I: Physical planning

Owner:

- new internal sqlite-v0 physical planning module

Purpose:

- choose execution strategy without changing semantics

Required outcomes:

- [x] Each rule has a name
- [x] Each rule has explicit preconditions
- [x] Each rule is traceable in debug output
- [x] Physical plan can be validated against logical interpretation

#### Stage J: SQL AST / structured query program

Owner:

- new internal sqlite-v0 SQL AST module

Required outcomes:

- [x] SQL construction is structured, not text-first
- [x] The AST covers only the subset sqlite-v0 actually emits
- [x] No semantic decisions happen in the AST builder

#### Stage K: SQL rendering

Owner:

- new internal sqlite-v0 SQL emit module

Required outcomes:

- [x] AST -> SQL text + params is isolated and testable
- [x] Rendering is deterministic
- [x] Alias naming / parameter naming is stable enough for snapshots

#### Stage L: SQL execution and row materialization

Owner:

- `tx/cs/cs-sqlite-v0.js`

Required outcomes:

- [x] Execution consumes only rendered SQL artifacts
- [x] Candidate materialization remains thin and mechanical
- [x] Trace output clearly distinguishes logical plan, physical plan, SQL AST, rendered SQL, and execution timing

### Output shaping stages

These remain outside provider-private planning.

#### Stage M: Candidate enrichment

Owner:

- `tx/engine/orchestrator.js`
- provider bulk methods

Required outcomes:

- [x] Designations, properties, supplements remain outside membership kernel logic
- [x] Output decoration tests stay separate from provider membership tests

#### Stage N: Final expansion shaping

Owner:

- `tx/engine/orchestrator.js`

Required outcomes:

- [x] Compose display/designation overrides remain separate from provider membership compilation
- [x] Used-system / used-valueset / used-supplement metadata remain separate
- [x] Hierarchical `contains` shaping remains separate

## Target sqlite-v0 internal module layout

These module names are the intended target. They do not all need to land in one phase.

- [x] `tx/cs/sqlite-v0-plan-types.js`
- [x] `tx/cs/sqlite-v0-clause-lowering.js`
- [x] `tx/cs/sqlite-v0-hierarchy.js`
- [x] `tx/cs/sqlite-v0-plan-builder.js`
- [x] `tx/cs/sqlite-v0-plan-normalize.js`
- [x] `tx/cs/sqlite-v0-plan-interpret.js`
- [x] `tx/cs/sqlite-v0-selection-builder.js`
- [x] `tx/cs/sqlite-v0-terminal-builder.js`
- [x] `tx/cs/sqlite-v0-physicalize.js`
- [x] `tx/cs/sqlite-v0-sql-ast.js`
- [x] `tx/cs/sqlite-v0-sql-emit.js`
- [x] `tx/cs/sqlite-v0-format-plan.js`
- [x] `tx/cs/sqlite-v0-compiler.js`

The earlier direct `tx/cs/sqlite-v0-sql.js` builder has been removed. Runtime
sqlite-v0 execution now goes only through the provider-private compiler
modules.

## Interface contracts to lock down

The plan should be explicit about the internal contracts we are designing
toward. These do not need to be final code yet, but they do need to be stable
enough that the workstreams can be judged against a real target instead of a
moving intuition.

### Core references

```js
/**
 * One projected provider scope.
 */
type ScopeRef = {
  csId: number,
  system: string,
  version: string | null,
};

/**
 * Provenance for debugging and traceability.
 */
type OriginRef = {
  nodeIds: string[],
  paths: string[],
};

/**
 * One hierarchical relation known to sqlite-v0.
 */
type HierarchyRelationRef = {
  id: string,
  storage: 'closure' | 'conceptLink' | 'recursiveCte',
  edgeSetId: number | null,
  propertyId: number | null,
  defaultDirection: 'down' | 'up',
  transitive: boolean,
  supportsIncludeSelf: boolean,
  sourceColumn: string,
  targetColumn: string,
};

/**
 * Search semantics independent of SQL implementation details.
 */
type SearchSpec = {
  sources: ('display' | 'designation' | 'literal')[],
  activeOnlyConcepts: boolean,
  designationActiveOnly: boolean,
  literalActiveOnly: boolean,
};

/**
 * Provider-private predicate subset used inside RowPlan.
 */
type Predicate =
  | { kind: 'eq', left: string, right: unknown }
  | { kind: 'in', left: string, right: unknown[] }
  | { kind: 'regex', left: string, pattern: string }
  | { kind: 'and', items: Predicate[] }
  | { kind: 'or', items: Predicate[] };

/**
 * Provider-private join expression subset used inside RowPlan.
 */
type JoinExpr =
  | { kind: 'eqCols', left: string, right: string }
  | { kind: 'and', items: JoinExpr[] };
```

Current concrete sqlite-v0 mapping:

- the default `concept` hierarchy uses the runtime `closure` table
- property-specific hierarchy descriptors use `conceptLink` storage and lower
  to recursive CTE execution over `concept_link` edges in the runtime schema
- bounded exhaustive and parity tests execute SQL against the runtime schema;
  the only remaining synthetic layer here is the in-memory model used by the
  non-SQL oracles

### SetPlan

`SetPlan` denotes an unordered set of scoped `concept_id` values.

```js
type SetPlan =
  | { kind: 'empty', scope: ScopeRef, origin: OriginRef }
  | { kind: 'allConcepts', scope: ScopeRef, origin: OriginRef }
  | { kind: 'explicitCodes', scope: ScopeRef, codes: string[], origin: OriginRef }
  | { kind: 'fromRows', scope: ScopeRef, rows: RowPlan, key: 'concept_id', origin: OriginRef }
  | { kind: 'union', scope: ScopeRef, items: SetPlan[], origin: OriginRef }
  | { kind: 'intersect', scope: ScopeRef, items: SetPlan[], origin: OriginRef }
  | { kind: 'diff', scope: ScopeRef, left: SetPlan, right: SetPlan, origin: OriginRef };
```

Notes:

- `fromRows` is required. It is the escape hatch that prevents sqlite-v0
  semantics from collapsing back into SQL strings too early.
- `explicitCodes` is semantic, not physical. It should survive normalization.
- all `SetPlan` variants are scope-fixed.

### RowPlan

`RowPlan` denotes a small relational subset, still provider-private and still
pre-SQL.

```js
type RowPlan =
  | { kind: 'scan', table: string, as: string, scope: ScopeRef, origin: OriginRef }
  | { kind: 'values', columns: string[], rows: unknown[][], origin: OriginRef }
  | { kind: 'project', input: RowPlan, columns: string[], origin: OriginRef }
  | { kind: 'filter', input: RowPlan, predicate: Predicate, origin: OriginRef }
  | { kind: 'join', joinType: 'inner'|'left', left: RowPlan, right: RowPlan, on: JoinExpr, origin: OriginRef }
  | { kind: 'semiJoin', left: RowPlan, right: RowPlan, on: JoinExpr, origin: OriginRef }
  | { kind: 'antiJoin', left: RowPlan, right: RowPlan, on: JoinExpr, origin: OriginRef }
  | { kind: 'unionAll', inputs: RowPlan[], origin: OriginRef }
  | { kind: 'distinct', input: RowPlan, keys: string[], origin: OriginRef }
  | { kind: 'reachability', relation: HierarchyRelationRef, seed: SetPlan, direction: 'down'|'up', includeSelf: boolean, minDepth: number, maxDepth: number | null, origin: OriginRef }
  | { kind: 'search', scope: ScopeRef, text: string, spec: SearchSpec, origin: OriginRef };
```

Notes:

- `RowPlan` is not a generic SQL IR. It should only cover the subset sqlite-v0
  actually needs.
- hierarchy and search belong here when they are not adequately represented by a
  specialized `SetPlan` leaf.
- inline `values` rows are carried through the physical plan and lower to
  deterministic SQL as a union-all of literal row selects

### Terminal plans

Terminal plans are derived from normalized base/selected `SetPlan`s.

```js
type MaterializePlan = {
  kind: 'materializeConcepts',
  members: SetPlan,
  columns: string[],
  orderBy: { key: 'code', direction: 'asc' }[],
  offset: number,
  count: number | null,
  scope: ScopeRef,
  origin: OriginRef,
};

type CountPlan = {
  kind: 'countMembers',
  members: SetPlan,
  scope: ScopeRef,
  origin: OriginRef,
};

type ProbePlan = {
  kind: 'probeMemberByCode',
  members: SetPlan,
  code: string,
  scope: ScopeRef,
  origin: OriginRef,
};
```

### Clause-registry contract

The clause registry is the provider-local semantic support boundary.

```js
type ClauseLoweringContext = {
  scope: ScopeRef,
  propertyDefs: Map<string, unknown>,
  runtime: unknown,
  hierarchy: Map<string, HierarchyRelationRef>,
  specialHandlers: Map<string, unknown>,
};

type ClauseLoweringResult =
  | { supported: true, plan: SetPlan }
  | { supported: false, reason: string, detail?: unknown };

type ClauseResolver = {
  name: string,
  supports: (clause: unknown, ctx: ClauseLoweringContext) => boolean,
  lower: (clause: unknown, ctx: ClauseLoweringContext) => ClauseLoweringResult,
};
```

Requirements:

- resolver names must be stable enough for trace/debug output
- `doesFilter` must delegate to this registry or be parity-tested against it
- unsupported must stay explicit; it must never silently compile to `empty`

### Compiler facade contract

This is the internal pipeline entrypoint used by `cs-sqlite-v0.js`.

```js
type SqliteV0Compiler = {
  compileBaseMembership(subtree: unknown): SetPlan,
  compileSelectedMembership(base: SetPlan, opts: { activeOnly?: boolean, text?: string | null }): SetPlan,
  compileExpand(subtree: unknown, opts: unknown): CompiledQuery,
  compileCount(subtree: unknown, opts: unknown): CompiledQuery,
  compileProbe(subtree: unknown, code: string): CompiledQuery,
};
```

Requirements:

- `membershipForIR` compiles from base membership only
- `countForIR` and `executeIR` compile from selected membership
- the facade remains private to sqlite-v0; callers still only see the current
  provider API

### Physical plan and compiled-query contracts

Physical planning is where named strategy choices become explicit. SQL emission
must happen after this layer, not during logical lowering.

```js
type PhysicalPlan =
  | { kind: 'materialize', strategy: string, members: SetPlan | RowPlan, orderBy: unknown[], offset: number, count: number | null, scope: ScopeRef, origin: OriginRef }
  | { kind: 'count', strategy: string, members: SetPlan | RowPlan, scope: ScopeRef, origin: OriginRef }
  | { kind: 'probe', strategy: string, members: SetPlan | RowPlan, code: string, scope: ScopeRef, origin: OriginRef }
  | { kind: 'setOp', strategy: string, op: 'union' | 'intersect' | 'diff', items?: PhysicalPlan[], left?: PhysicalPlan, right?: PhysicalPlan, scope: ScopeRef, origin: OriginRef }
  | { kind: 'rowOp', strategy: string, rowPlan: RowPlan, scope: ScopeRef, origin: OriginRef };

type CompiledQuery = {
  logical: SetPlan | RowPlan,
  terminal: MaterializePlan | CountPlan | ProbePlan,
  physical: PhysicalPlan,
  sqlAst: unknown | null,
  sql: { text: string, params: Record<string, unknown> } | null,
};
```

Requirements:

- physical strategy names must be stable enough for tests and trace output
- `CompiledQuery` should retain intermediate artifacts for debugging, even if
  some are initially `null` during the staged migration

## Core logical artifacts

### Semantic IR

Owner:

- `tx/engine`

Definition:

- complete semantic representation of `ValueSet.compose`

Checklist:

- [x] Stable ids
- [x] Stable hashes
- [x] Deterministic normalized order

### Scoped IR

Owner:

- `tx/engine`

Definition:

- semantic IR after import resolution, `lockedDate` binding, rewrite, and projection to one `(system, version)` bucket

Checklist:

- [x] First-class interpreter
- [x] Snapshot tests
- [x] Projection theorem tests

### Base SetPlan

Owner:

- sqlite-v0 private compiler

Definition:

- provider-private set semantics over scoped `concept_id` membership for one
  projected subtree

Checklist:

- [x] Explicit unsupported status
- [x] Explicit set ops
- [x] Explicit reachability operator
- [x] Explicit code-identity boundary where required
- [x] `fromRows` escape hatch to `RowPlan` where specialized leaves are not enough

### RowPlan

Owner:

- sqlite-v0 private compiler

Definition:

- provider-private relational plan used as the lowering target for clause and
  search semantics that should not be encoded directly as SQL text

Checklist:

- [x] First-class `RowPlan` type exists
- [x] Minimal relational operator surface is defined explicitly
- [x] Reachability can be represented as `RowPlan` input, not SQL text
- [x] Search can be represented as `RowPlan` input, not SQL text

### Selected SetPlan

Owner:

- sqlite-v0 private compiler

Definition:

- base membership kernel plus runtime set filters such as `activeOnly` and text search

Checklist:

- [x] Explicit active-only subset
- [x] Explicit search subset
- [x] Separate expand/count from membership probe

### Terminal Plans

Owner:

- sqlite-v0 private compiler

Definition:

- consumer-specific plans for materialization, counting, and membership probing

Checklist:

- [x] `materializeConcepts` terminal plan exists
- [x] `countMembers` terminal plan exists
- [x] `probeMemberByCode` terminal plan exists
- [x] terminal plans lower from base/selected `SetPlan`, not directly from IR

### Physical Plan

Owner:

- sqlite-v0 private compiler

Definition:

- implementation-oriented plan with strategy choices named and justified by preconditions

Checklist:

- [x] Strategy-labeled physical-plan nodes exist
- [x] Rewrite rules documented
- [x] Rule-precondition tests
- [x] Trace spans include chosen rule names

### SQL AST

Owner:

- sqlite-v0 private compiler

Definition:

- structured query representation suitable for deterministic rendering

Checklist:

- [x] Minimal operator surface
- [x] Snapshot tests
- [x] Rendering parity tests

## Critical semantic decisions to lock down early

- [x] Unsupported provider-local lowering must never silently become `empty`
- [x] Identity semantics must be explicit:
  - [x] `concept_id` is sufficient under scope and runtime load rejects duplicate codes within one scoped code system
  - [x] code-level terminal semantics remain explicit where required (`COUNT(DISTINCT code)`, probe-by-code)
- [x] Reachability must be a first-class internal operator
- [x] `doesFilter` must delegate to or be parity-checked against the clause registry
- [x] Text search semantic layer and SQLite FTS parity layer remain separate
- [x] Output shaping must remain outside provider-private membership semantics

## Testing strategy

The design depends on multiple independent oracles, not one giant end-to-end suite.

### Oracle 1: reference compose evaluator

Purpose:

- validate `ValueSet.compose` semantics independently of IR and provider logic

Checklist:

- [x] Exists
- [x] Covers imports used by fuzz subset
- [x] Covers include/exclude semantics
- [x] Covers supported filter subset used by engine fuzz

### Oracle 2: scoped-IR interpreter

Purpose:

- validate semantic compilation, rewrite, and projection before provider lowering

Checklist:

- [x] Exists
- [x] Proves optimized IR == scoped IR == partitioned union
- [x] Has snapshot-friendly debug output

### Oracle 3: provider logical-plan interpreter

Purpose:

- validate sqlite-v0 provider lowering independent of SQLite

Checklist:

- [x] Exists
- [x] Runs on synthetic in-memory v0-shaped fixtures
- [x] Covers hierarchy, properties, literals, and links
- [x] Covers search subset semantics

### Oracle 4: SQLite execution parity

Purpose:

- validate physical planning and SQL emission against actual SQLite behavior

Checklist:

- [x] Exists for generated fixtures
- [x] Compares plan interpreter vs emitted SQL
- [x] Supports sampled fuzz and targeted regression seeds

### Shared synthetic fixture model

Checklist:

- [x] One synthetic terminology model feeds all four oracles
- [x] The same model can populate temp SQLite fixtures
- [x] Result normalization helpers exist so oracle diffs are directly comparable

### Bounded exhaustive model checking

Checklist:

- [x] Tiny synthetic universes enumerated
- [x] Compose evaluator vs scoped IR interpreter parity
- [x] Scoped IR interpreter vs provider logical interpreter parity
- [x] Provider logical interpreter vs SQLite parity

### Property-based fuzz split by boundary

Checklist:

- [x] Fuzzer A: compose -> IR
- [x] Fuzzer B: projected IR -> provider plan
- [x] Fuzzer C: logical rewrite equivalence
- [x] Fuzzer D: plan -> SQL parity

### Metamorphic tests

Checklist:

- [x] Reorder includes/excludes
- [x] Duplicate and flatten commutative branches
- [x] Inline imports vs resolved imports
- [x] Replace `lockedDate` with resolved explicit version
- [x] Page concatenation == full ordered expansion
- [x] `membership(code)` agrees with full materialization membership

### Mutation tests

Checklist:

- [x] Union/intersect swap mutation
- [x] Include-self / exclude-self hierarchy mutation
- [x] Dropped diff-right mutation
- [x] Missing `DISTINCT` mutation
- [x] Wrong sort-key-before-pagination mutation
- [x] Wrong search source mutation

## Phase plan

### Phase 0: Freeze baseline and invariants

Objective:

- make today’s behavior explicit enough to compare the new implementation against it

Deliverables:

- [x] New design doc accepted as the working plan
- [x] Current public/native contract documented
- [x] Stable list of invariants for partitioning, count, pagination, and search
- [x] Golden corpus of representative real ValueSets captured
- [x] Trace fields required for future differential comparison identified

Exit criteria:

- [x] Current behavior is pinned well enough that future diffs are attributable

### Phase 1: Engine-side semantic hardening

Objective:

- make engine semantic outputs deterministic and independently interpretable

Deliverables:

- [x] Stable IR node ids
- [x] Deterministic ordering for canonical rewrite output
- [x] Optional canonical hash for normalized IR
- [x] Scoped-IR interpreter
- [x] Additional projection theorem tests
- [x] Snapshot/debug format for canonical IR

Suggested file targets:

- [x] `tx/engine/ir.js`
- [x] `tx/engine/rewrite.js`
- [x] `tx/engine/orchestrator.js`
- [x] `tests/engine/*`

Exit criteria:

- [x] Direct compose evaluator == scoped IR interpreter on bounded exhaustive tests
- [x] Existing fuzz remains green
- [x] Existing HTTP harness remains green

### Phase 2: sqlite-v0 logical compiler

Objective:

- introduce provider-private logical planning without changing runtime behavior
  yet, with an explicit `SetPlan` + `RowPlan` split

Deliverables:

- [x] Membership kernel node definitions
- [x] Formal `SetPlan` type definitions
- [x] Formal `RowPlan` type definitions
- [x] Clause-lowering registry
- [x] Hierarchy descriptor model
- [x] Reachability operator
- [x] Plan builder from scoped IR -> base membership kernel
- [x] `fromRows` / row-plan escape hatch
- [x] Selection-kernel builder for `activeOnly` and text search
- [x] Selection builder extracted as its own module
- [x] Terminal builder extracted as its own module
- [x] Logical normalization
- [x] Plan interpreter over synthetic fixtures
- [x] Explicit unsupported result surface

Suggested file targets:

- [x] `tx/cs/sqlite-v0-plan-types.js`
- [x] `tx/cs/sqlite-v0-clause-lowering.js`
- [x] `tx/cs/sqlite-v0-hierarchy.js`
- [x] `tx/cs/sqlite-v0-plan-builder.js`
- [x] `tx/cs/sqlite-v0-plan-normalize.js`
- [x] `tx/cs/sqlite-v0-plan-interpret.js`
- [x] `tx/cs/sqlite-v0-selection-builder.js`
- [x] `tx/cs/sqlite-v0-terminal-builder.js`
- [x] `tests/cs/*`

Exit criteria:

- [x] Scoped IR interpreter == sqlite-v0 plan interpreter on synthetic fixtures
- [x] Unsupported clause behavior is explicit and tested
- [x] `SetPlan` and `RowPlan` boundaries are explicit in code and tests
- [x] `doesFilter` parity with the clause registry is explicit and tested
- [x] No public API changes

### Phase 3: Physical planning and SQL AST

Objective:

- separate logical/terminal semantics from execution strategy and SQL rendering

Deliverables:

- [x] Physical-plan node definitions
- [x] Named rewrite/strategy rules with preconditions
- [x] SQL AST
- [x] SQL renderer
- [x] Terminal plans lower through physical planning, not directly to SQL
- [x] Default sqlite-v0 runtime path expressed through the new compiler internally; the former direct SQL path has been retired
- [x] Snapshot tests for logical plan, physical plan, and SQL AST
- [x] SQL parity tests on generated fixtures

Suggested file targets:

- [x] `tx/cs/sqlite-v0-physicalize.js`
- [x] `tx/cs/sqlite-v0-sql-ast.js`
- [x] `tx/cs/sqlite-v0-sql-emit.js`
- [x] `tx/cs/sqlite-v0-compiler.js`

Exit criteria:

- [x] Plan interpreter == emitted SQL on generated SQLite fixtures
- [x] Current provider tests remain green
- [x] Current harness remains green

### Phase 4: Provider-boundary validation

Objective:

- validate the provider-private compiler against representative corpora before declaring the architecture complete

Deliverables:

- [x] Provider-boundary comparison harness
- [x] Trace output for compiler artifacts
- [x] Diff tooling for candidate membership, totals, and ordering at the provider boundary
- [x] Warning/output-shaping parity is validated at the orchestrator/harness layer after the provider switch
- [x] Representative real harness corpus
- [x] Strict harness coverage for the compiler path; automatic perf sampling is not required for completion

Exit criteria:

- [x] Zero unexplained semantic diffs on the chosen corpus
- [x] Performance regressions are understood and either fixed or accepted

### Phase 5: Switch sqlite-v0 default

Objective:

- make the new provider-private compiler the default sqlite-v0 implementation

Deliverables:

- [x] Default path flipped
- [x] Trace output documented for the compiler path
- [x] Transitional compatibility code retired

Exit criteria:

- [x] All provider tests green
- [x] All engine tests green
- [x] All 166 HTTP IR harness tests green
- [x] Perf behavior acceptable on representative corpus

### Phase 6: Optional convergence and reuse

Objective:

- decide what parts should be reused beyond sqlite-v0 after the architecture stabilizes

Deliverables:

- [x] Decide whether legacy adapter or other native backends should reuse clause-lowering concepts
- [x] Decide whether scoped-IR interpreter should be generalized further
- [x] Decide whether provider-private plan tracing should surface in docs/explorer tools

Exit criteria:

- [x] Reuse decisions documented

## Workstream checklist

### Workstream A: semantic compiler hardening

- [x] Stable IR ids
- [x] Stable canonical hashes
- [x] Deterministic rewrite ordering
- [x] Scoped-IR interpreter
- [x] Additional projection theorem tests

### Workstream B: sqlite-v0 logical compiler

- [x] Membership kernel
- [x] Formal `SetPlan`
- [x] Formal `RowPlan`
- [x] Clause-lowering registry
- [x] Explicit unsupported results
- [x] Hierarchy descriptors
- [x] Reachability operator
- [x] Selection kernel
- [x] Extracted selection builder
- [x] Extracted terminal builder
- [x] Logical normalization
- [x] Logical interpreter

### Workstream C: physical compiler

- [x] Physical-plan layer
- [x] Rule preconditions
- [x] SQL AST
- [x] SQL renderer
- [x] Trace output for all intermediate artifacts

### Workstream D: correctness suite

- [x] Bounded exhaustive compose tests
- [x] Bounded exhaustive provider-plan tests
- [x] Property-based fuzz split by boundary
- [x] Metamorphic tests
- [x] Mutation tests
- [x] SQLite parity tests

### Workstream E: rollout and diagnostics

- [x] Provider-boundary comparison completed
- [x] Differential comparison tooling
- [x] Perf comparison on representative corpus
- [x] Transitional scaffolding retired

## Risks and decisions to revisit

- [x] Confirm exact identity boundary for logical set operations:
  - [x] always `concept_id` under scope, with runtime duplicate-code rejection enforcing the invariant
  - [x] explicit code-level terminal semantics remain where required
- [x] Confirm how far hierarchy descriptors must generalize in phase 2 vs later phases
- [x] Confirm how provider capability failures surface:
  - [x] hard error on unsupported native lowering in the runtime compiler path
  - [x] no alternate SQL target or compatibility path remains in the runtime compiler
- [x] Confirm cache-key composition for canonical IR and provider-private normalized kernels
- [x] Confirm whether rendered SQL snapshots should normalize alias names for stability
- [x] Confirm how much trace output should be exposed in harness/docs pages
- [x] Confirm whether to keep flat `tx/cs/sqlite-v0-*.js` modules or move to a
  nested `tx/cs/sqlite-v0/` directory once the type boundaries settle

## Definition of done

This migration is complete only when all of the following are true:

- [x] `ValueSet.compose -> IR` is validated against an independent compose evaluator
- [x] canonical/projected IR is validated by a scoped-IR interpreter
- [x] scoped IR -> sqlite-v0 logical plan is validated by a provider-private interpreter
- [x] physical rewrites are validated by equivalence tests
- [x] logical/physical plan -> SQL is validated by SQLite parity tests on generated fixtures
- [x] HTTP harness remains green
- [x] runtime path has no alternate SQL-schema target
- [x] correctness claims can be stated stage-by-stage instead of relying on end-to-end SQLite behavior alone
- [x] `doesFilter` support is derived from or parity-checked against clause-lowering support
- [x] terminal plan boundaries are explicit in code and traces

## Near-term correctness-first sequence

If implementation continues immediately, the next sequence should prioritize
proof-alignment and internal completeness over preserving prototype structure:

- [x] Phase 0 baseline freeze
- [x] Phase 1 deterministic IR + scoped-IR interpreter
- [x] Formalize `SetPlan` + `RowPlan` types and migrate current prototype nodes
- [x] Add extracted selection-builder and terminal-builder modules
- [x] Make `doesFilter` parity with clause-lowering explicit
- [x] Phase 3 SQL AST after the `SetPlan`/`RowPlan` boundary is real
- [x] Phase 4 provider-boundary validation before declaring the compiler complete

That sequence aligns the implementation with the intended proof target before
adding more SQL-specific machinery.
