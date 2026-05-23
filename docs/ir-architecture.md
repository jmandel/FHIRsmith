# Terminology IR Architecture

This document explains the intermediate representation (IR) used by the
terminology engine. It is intended for reviewers and maintainers who need to
reason about correctness before looking at individual SQL plans or worker
routing details.

The short version: a FHIR `ValueSet.compose` is converted into a small algebra
of set operations. The algebra is optimized, split by code system, bound to a
provider plus any requested supplements, and then executed by the best runtime
available for that provider.

## Why IR Exists

The legacy expander grew around operation-specific traversal. That makes it
hard to answer simple questions consistently:

- Is this request a membership test, a page, or a total-only expansion?
- Which code-system version is being used after canonical and locked-date
  resolution?
- Does an exclude apply before or after an imported value set?
- Can a provider answer the whole request natively, or do we need a fallback?
- Are supplements participating in membership, display decoration, or both?

The IR approach separates those concerns:

1. Parse FHIR request shape into a terminology set expression.
2. Normalize and optimize the expression without provider details.
3. Bind each system-scoped part of the expression to a concrete provider.
4. Execute through native SQL where possible, or through a generic adapter.
5. Render the FHIR response using the same response-shaping layer.

This gives us a stable semantic surface for tests and a smaller execution
surface for performance work.

## Core Mental Model

Think of IR as a set expression over `(system, version, code)` members.

The important operations are:

- `selector`: codes from one code-system scope, optionally constrained by
  explicit codes, filters, active status, text, or imported value-set members.
- `union`: members from any child expression.
- `intersect`: members common to all child expressions.
- `diff`: members from the left expression with the right expression removed.
- `empty`: no members.

FHIR `compose.include` entries become selectors and unions. FHIR
`compose.exclude` entries become differences. Imported value sets are resolved
and represented as nested expressions before execution.

The IR does not try to preserve legacy traversal order as semantics. Ordering is
a terminal concern. Native sqlite-v0 expansion pages order by code unless a
specific strategy says otherwise.

## Pipeline

### 1. Build

`prepareIRPlan()` reads the `ValueSet` JSON and produces a raw IR tree. This
step also resolves imported value sets and records which value sets were used.

Important inputs:

- `compose.include`
- `compose.exclude`
- imported `valueSet` canonicals
- `compose.lockedDate`
- request-level text filter
- request-level active-only behavior

### 2. Resolve Versions

The build phase keeps system and version information explicit. When
`compose.lockedDate` is present, the runtime can ask
`resolveCodeSystemVersionAtDate()` for the newest loaded code-system release at
or before that date. Providers expose `releaseDate()` where they can do so
reliably.

If no version is resolved, normal provider default-version behavior still
applies. The IR should not invent a version that the provider did not select.

### 3. Rewrite

The rewrite layer simplifies the IR without changing membership semantics.
Examples:

- remove empty branches
- collapse nested unions/intersections
- split root-level differences where it helps execution
- project a tree to a single code-system scope

Rewrite laws are tested independently because every execution backend depends
on them.

### 4. Scope Binding

Execution is scoped by code system. Each scoped subtree is bound to:

- a base `CodeSystemProvider`
- a concrete version, when known
- a supplement set, if requested
- a native or generic execution object

Supplements are resolved before execution because they can affect displays,
designations, properties, and in some cases filter membership. Native sqlite-v0
supplement sidecars can be attached directly to the SQLite connection. Other
supplements are materialized as normal supplement `CodeSystem` overlays.

### 5. Execute

The execution layer asks the bound scope for one of three terminal operations:

- `executeIR()` for a page of candidates
- `countForIR()` for a total
- `membershipForIR()` for point membership checks

Native sqlite-v0 providers compile the scoped subtree into SQL. Providers
without native support can be wrapped by the legacy IR adapter where the request
shape is supported.

### 6. Render

Candidate rows are rendered into FHIR expansion output after execution. This is
where display language, designations, properties, nested expansion shape,
warning parameters, used systems, and used value sets are applied.

For validation and lookup, the IR path reuses the existing worker response
contracts where possible, with IR used to resolve membership and provider
decoration consistently.

## sqlite-v0 Native Execution

The sqlite-v0 provider is the first full native IR runtime.

The schema is normalized around these tables:

- `code_system`: one code-system scope and metadata
- `concept`: code, display, definition, active flag
- `closure`: transitive hierarchy closure
- `concept_link`: concept-valued properties and hierarchy edges
- `concept_literal`: typed literal properties
- `designation`: language/use display terms
- `value_set` and `value_set_member`: explicit imported memberships
- FTS tables for display, designation, and literal text search

The native compiler pipeline is:

1. lower IR selectors and filters to membership plans
2. normalize plan shape
3. choose a terminal plan: materialize, count, or probe
4. physicalize the terminal plan
5. lower to a SQL AST
6. emit SQL and parameters
7. execute through `better-sqlite3`

The compiler is deliberately provider-private. It receives only one scoped
system/version at a time. Cross-system orchestration stays in `tx/engine`.

## Supplements

Supplements use a two-level model:

1. Request references are normalized and deduped as supplement refs.
2. Refs are resolved against a registry into a supplement set for the current
   base system/version.

The resolver classifies refs as:

- matched and applicable
- missing
- ambiguous
- present but inapplicable to the current base scope

Unversioned ambiguous supplements resolve by a deterministic newest-version
policy when enough version information is available. Otherwise they fail
explicitly instead of silently choosing an arbitrary overlay.

Execution can consume supplements in two ways:

- Native sidecar binding for sqlite-v0 sidecar databases.
- Overlay materialization into supplement `CodeSystem` resources.

Both paths must produce the same externally visible designations, properties,
and lookup decoration.

## Correctness Guardrails

The IR layer is allowed to change implementation strategy, not terminology
semantics. The important guardrails are:

- Explicit `_engine=legacy` must keep the legacy path available.
- Explicit `_engine=ir` should fail clearly when the IR cannot support a shape.
- Default IR expand routing is allowed to fall back when IR is enabled by
  environment rather than requested explicitly.
- Provider-native execution must match the IR semantics, not merely current SQL
  output.
- Optimizations must either preserve exact semantics directly or abandon the
  fast path and rerun the generic path.
- No statistics-based estimates are used as correctness signals.
- Exact totals are returned only when requested, required, known cheaply, or
  inferred safely from the returned page.

## Test Layers

The branch uses several layers of tests because no single layer proves enough:

- IR algebra and rewrite tests under `tests/engine` and `tests/ir-engine/core`.
- sqlite-v0 compiler and SQL strategy tests under `tests/cs/sqlite-v0-*`.
- sqlite-v0 provider tests for lookup, hierarchy, filters, bulk helpers, and IR
  terminals.
- operation tests for `$expand`, `$validate-code`, `$lookup`, supplements,
  locked dates, request parsing, and response shape.
- the TX harness for end-to-end local legacy-vs-IR-vs-upstream-provider
  comparison over SNOMED, LOINC, RxNorm, and built-in systems.

The mental model for adding coverage is: prove the algebra first, prove the
provider contract next, then prove HTTP behavior and performance through the
harness.
