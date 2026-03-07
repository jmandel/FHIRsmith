# Supplement Architecture

This document defines the supplement architecture we want for the new runtime
path.

It is intentionally implementation-shaped. The goal is to make it possible to
move from this document to incremental code changes without inventing the design
again in each patch.

For a worked request-level walkthrough, see
[supplement-microscope.md](supplement-microscope.md).

## Scope

This design is for the new supplement runtime used by the IR engine and later
reused by other operations such as:

- `$expand`
- `$lookup`
- `$validate-code`
- `locate`
- `subsumes`

It is **not** a refactor of the legacy expander.

The legacy expander should keep its current supplement behavior for now. The new
supplement system is meant to become the correct path we grow into over time,
not a wrenching change to `expand.js`.

One narrow exception is acceptable and now implemented: when a requested
supplement is only resolvable through the new supplement runtime (for example, a
configured sqlite sidecar), legacy `$expand` fails closed with `422` instead of
returning a misleading `200` that omits supplement semantics.

## Problem statement

FHIR supplements are CodeSystems with `content = supplement` that add
designations, properties, and extensions to a base CodeSystem.

Today, the server mostly handles supplements in two narrow ways:

- inline request-scoped `tx-resource` supplements are attached to providers as
  `CodeSystem[]`
- some providers merge supplement designations/properties during decoration

That is not enough for the long term because:

1. supplement activation is request-driven and needs consistent resolution
2. supplement-backed properties are valid in `compose.include.filter`
3. server-loaded supplements need to be usable, not only inline resources
4. sqlite-backed providers should be able to optimize supplement evaluation
5. the same supplement model should later work for lookup/validate as well as
   expand

## Semantics we are committing to

These points are fixed by design.

### 1. Supplements are explicit

Supplements are only active when explicitly requested by the client:

- `useSupplement` parameter
- `valueset-supplement` extension on the ValueSet

The server must not auto-activate supplements just because it knows about them.

### 2. Base system membership stays owned by the base code system

Supplements do not introduce new codes into the base system.

They add overlay content for existing codes:

- designations
- properties
- extensions

### 3. Supplement-backed filters are valid

A filter clause may depend on property values that come entirely from active
supplements.

This is not optional semantics.

If a requested supplement is available and in scope, its property values must be
able to affect membership.

### 4. Pushdown is an optimization, not a semantic gate

If a supplement is available:

- native providers may push supplement logic down
- otherwise the runtime must fall back to correct generic overlay evaluation

Current boundary:

- the generic overlay path supports simple overlay-backed property
  operators: `=`, `in`, `regex`, `exists`
- richer overlay-backed hierarchical operators on concept-valued supplement
  properties remain an explicit TODO
- those unsupported generic cases fail closed rather than silently downgrading
  semantics

Normal operational failures can still happen:

- missing requested supplement
- version mismatch
- general `too-costly`
- malformed data

But "provider cannot natively join supplement values" is not a valid semantic
failure.

### 5. Multiple supplements are additive

If several active supplements contribute values for the same code:

- properties are multi-valued
- designations are additive
- extensions are additive

There is no override model here.

The only place a tie-break matters is when a single display must be chosen for
presentation. In that case, the runtime needs a deterministic tie-break order,
but all underlying designation values remain valid.

### 6. Base version resolves first

If the request or ValueSet uses:

- explicit base version
- or `lockedDate`

then base system version resolution happens first.

Supplements are then bound against that resolved base `(system, version)` scope.

If the base remains unversioned, only supplements that validly target the
unversioned base are in scope.

## Design goals

1. One supplement model across inline and server-loaded sources
2. Correct semantics even without native pushdown
3. Efficient native execution when supplement data is sqlite-attachable
4. Reuse below the operation layer, not owned by `$expand`
5. IR remains supplement-agnostic
6. Deterministic resolution, ordering, and traceability
7. Minimal required change to legacy code paths

## Non-goals

1. Refactoring the legacy expander to use this architecture now
2. Annotating IR nodes with supplement provenance
3. Auto-activating supplements from server config
4. Making supplement semantics depend on storage backend
5. Introducing a new process-wide normalized supplement cache in the first cut

## Initial scope simplification

To keep the first implementation tractable:

- request-scoped inline supplements may stay as JSON `CodeSystem` resources
- server-loaded supplements should start as sqlite-native sidecars only
- we should not add a new process-wide supplement row cache in the first cut

That means:

- inline/request supplements pay parse/materialization cost per request
- raw `tx-resource` supplement JSON is normalized into `CodeSystem` objects at
  the supplement registry boundary, not pre-cached across requests
- generic overlay remains the default semantic path for inline supplements, but
  sqlite-v0 may opportunistically materialize them once per provider/request
  into an attached `:memory:` supplement schema and use the native SQL path
- server-loaded/sqlite supplements are resolved by descriptor and attached for
  the request/provider lifetime
- server-loaded sqlite sidecars resolve their native binding eagerly, but defer
  `CodeSystem` overlay materialization until a generic consumer actually needs
  it
- no new server-global cache invalidation or eviction policy is needed to begin

This is a deliberate narrowing of the initial design, not a permanent
restriction.

## High-level architecture

The supplement runtime should live below any single operation.

```text
request / operation
  -> explicit supplement references
  -> supplement resolution and binding
  -> supplement set for one base scope
  -> supplement-aware code system view
  -> operation-specific use
       - IR expand now
       - lookup / validate later
```

## Core design idea

The IR engine should not try to understand which filter clauses "belong" to
which supplements.

That responsibility belongs at execution time, after the active supplement set
for a concrete base `(system, version)` scope has been resolved.

So:

- IR stays supplement-agnostic
- supplement resolution happens after base version resolution
- providers/execution adapters are told which supplements are in play
- supplement-aware execution decides how to apply them
- supplement/runtime/provider failures in this path are explicit runtime errors,
  not silent downgrades to a generic IR miss

For adapter-backed providers that do not natively execute IR, the generic path
works by wrapping the provider with the IR supplement adapter. That adapter:

- keeps non-supplement clauses in the base query path
- routes supplement-touched semantics through merged base+overlay evaluation
- preserves count and paging correctness before slicing

## Currently demonstrated generality

The current implementation intentionally demonstrates supplements across three
different execution shapes.

### 1. IR + sqlite-v0 + configured sqlite sidecar

This is the native server-loaded supplement path.

What it proves:

- supplement activation by canonical URL
- native sqlite attachment and pushdown
- supplement-backed property filtering
- supplement-backed text/designation matching

Primary tests:

- `tests/tx/expand-sqlite-supplement-config.test.js`
- `tests/tx/lookup-sqlite-supplement-config.test.js`
- `tests/tx/validate-sqlite-supplement-config.test.js`
- `tests/cs/sqlite-v0-native-supplements.test.js`

### 2. IR + sqlite-v0 + inline `tx-resource` supplement

This is the request-scoped supplement path for the same sqlite base provider.

What it proves:

- the same canonical supplement can be supplied inline instead of coming from
  server configuration
- inline and configured sqlite sidecar supplements are semantically equivalent
  for the new runtime

Primary tests:

- `tests/tx/expand-sqlite-supplement-config.test.js`
  - inline-vs-sidecar expansion equivalence
- `tests/tx/lookup-sqlite-supplement-config.test.js`
  - inline-vs-sidecar lookup equivalence
- `tests/tx/validate-sqlite-supplement-config.test.js`
  - inline-vs-sidecar validate-code equivalence

### 3. IR + non-sqlite provider + inline `tx-resource` supplement

This is the generic supplement-aware IR path over adapter-backed providers.

What it proves:

- supplement semantics are not sqlite-specific
- adapter-backed providers can participate through the same supplement runtime
- supplement-backed filtering and text/designation matching still work without
  native sqlite pushdown

Primary tests:

- `tests/tx/expand-adapter-supplement-runtime.test.js`
- `tests/tx/supplement-ir-adapter-providers.test.js`

Current covered providers:

- `internal:usstates`
  - numeric supplement property filtering
  - count/paging correctness
- `ucum`
  - supplement designation text filtering

### Legacy contrast

The legacy expander is not the target supplement path.

Current explicit stance:

- legacy may continue to support the older inline `CodeSystem[]` supplement
  behavior it already had
- legacy is not being upgraded to the new supplement runtime
- when a supplement request depends on configured sqlite sidecars, legacy
  `$expand` now fails closed instead of returning a misleading success

## Proposed module layout

This is an eventual decomposition target, not an instruction to pre-create a
large supplement subtree.

Implementation rule:

- only create files when a phase has real code that needs them
- prefer plain object shapes and functions first
- split modules only when code pressure, test isolation, or provider-specific
  branching makes the seam real

So the list below is a map of likely future seams, not a ceremony-first file
plan.

Add a new lower-level area over time:

```text
tx/
  supplements/
    types.js
    registry.js
    resolver.js
    source-inline.js
    source-registered.js
    source-sqlite.js
    overlay.js
    aware-view.js
    ir-executor.js
    trace.js
```

This is not owned by the IR engine. The IR engine is the first consumer.

## Core runtime artifacts

### 1. `SupplementRef`

Client-stated supplement reference.

```js
type SupplementRef = {
  canonical: string,      // may be url or url|version
  source: 'useSupplement' | 'valueset-extension',
  order: number,
};
```

Why:

- preserves explicit client intent
- preserves request order for deterministic tie-breaks

### 2. `BaseScope`

Concrete base code system target after version resolution.

```js
type BaseScope = {
  system: string,
  version: string | null,
};
```

This is the scope supplements bind against.

### 3. `SupplementDescriptor`

Metadata for a supplement the server knows how to resolve.

```js
type SupplementDescriptor = {
  canonical: string,
  version: string | null,
  targetSystem: string,
  targetVersion: string | null,
  sourceKind: 'inline' | 'registered-codesystem' | 'sqlite-native',
  displayName?: string | null,
};
```

This is light-weight. It should be enough for indexing and matching without
materializing the full supplement content.

### 4. `ResolvedSupplement`

Resolved supplement bound to one base scope.

```js
type ResolvedSupplement = {
  descriptor: SupplementDescriptor,
  target: BaseScope,
  requestRef: SupplementRef,
  overlaySource: SupplementOverlaySource,
  nativeBindingSource?: NativeSupplementBindingSource | null,
};
```

This is the key bridge object.

It says:

- which supplement is active
- why it is active
- which base scope it targets
- how generic overlay data can be obtained
- whether a provider-specific native binding is available

### 5. `SupplementSet`

The ordered supplement collection for one base scope.

```js
type SupplementSet = {
  target: BaseScope,
  items: ResolvedSupplement[],
};
```

This object is passed downward into provider-aware execution.

Order matters for deterministic tie-breaks, not for property validity.

### 6. `SupplementOverlay`

Generic, provider-independent overlay content keyed by base code.

```js
type SupplementOverlay = {
  byCode: Map<string, SupplementOverlayConcept>,
  order: number,
  descriptor: SupplementDescriptor,
};

type SupplementOverlayConcept = {
  code: string,
  designations: Array<{
    language?: string | null,
    use?: object | null,
    value: string,
  }>,
  properties: Array<{
    code: string,
    value: unknown,
    definition?: object | null,
  }>,
  extensions: object[],
};
```

This is the generic correctness representation.

Any supplement source must be able to materialize into this form, even if a
native provider chooses to optimize instead.

### 7. `NativeSupplementBinding`

Provider-specific optimized supplement handle.

```js
type NativeSupplementBinding = {
  providerKind: string,   // e.g. 'sqlite-v0'
  kind: string,           // e.g. 'attached-db', 'temp-table', 'joined-view'
  payload: unknown,
};
```

This exists only for optimization.

The generic overlay representation remains the semantic source of truth.

## Resolution layer

### `SupplementRegistry`

The registry answers:

> What supplement descriptors does the server know about?

It should aggregate from:

1. request-scoped inline `tx-resource` CodeSystems
2. preloaded server CodeSystem resources
3. provider-registered supplement descriptors
4. future sqlite-native supplement sources

Proposed contract:

```js
class SupplementRegistry {
  listDescriptors(targetSystem) {}
  findByCanonical(canonical) {}
  resolveInlineResources(resources) {}
}
```

### `SupplementResolver`

The resolver answers:

> For this concrete base scope and these explicit supplement refs, which
> supplements are in force?

Proposed contract:

```js
class SupplementResolver {
  async resolveForBaseScope({
    target,                // BaseScope
    refs,                  // SupplementRef[]
    inlineResources,       // request-scoped tx-resources
    registry,              // SupplementRegistry
  }) => SupplementSet
}
```

Responsibilities:

1. parse canonical refs (`url` or `url|version`)
2. prefer inline/request-scoped resources over server-scoped descriptors
3. enforce target match against resolved base scope
4. detect ambiguity
5. return deterministic order

### Matching rules

For a supplement to resolve against a base scope:

1. requested canonical must match supplement canonical
   - exact version if request is version-pinned
   - otherwise latest matching descriptor for that canonical is acceptable only
     if unambiguous
2. supplement `supplements` target must match:
   - `system|version` exactly when base version is concrete
   - `system` only when base is unversioned

If several server-loaded descriptors match the same request and target scope,
that is an ambiguity error unless one was explicitly provided inline.

### Recommended precedence

1. inline request resources
2. request cache resources
3. server-registered descriptors

This lets request-scoped data override server defaults without mutating global
state.

## Source adapters

Every source type should satisfy a common conceptual interface.

```js
class SupplementSource {
  descriptor() {}
  async materializeOverlay(targetScope) {}
  async nativeBindingFor(providerKind, targetScope) {}
}
```

### `InlineCodeSystemSupplementSource`

Backed by a full `CodeSystem` supplement resource from `tx-resource`.

Behavior:

- always materializable to generic overlay
- no native binding by default

### `RegisteredCodeSystemSupplementSource`

Backed by a server-known `CodeSystem` supplement resource or provider-registered
descriptor that can be filled out on demand.

Behavior:

- materialize overlay lazily
- may later grow native binding support

This can reuse the existing `registerSupplements()` / `fillOutSupplement()`
seams from factory providers.

### `SqliteSupplementSource`

Backed by a sqlite-native supplement asset.

Behavior:

- materializable to generic overlay
- may also produce native sqlite bindings

Important:

The generic overlay must still exist conceptually even if the normal runtime
path prefers native binding for speed.

## Supplement-aware code system view

This is the core reusable abstraction.

It should sit below operations, above raw providers.

Proposed contract:

```js
class SupplementAwareCodeSystemView {
  constructor(baseProvider, supplementSet) {}

  async display(context) {}
  async designations(context, displays) {}
  async properties(context) {}
  async extensions(context) {}

  async bulkDesignations(conceptIds) {}
  async bulkProperties(conceptIds) {}

  async evaluateSupplementClause(clause, candidateCodes) {}
  async evaluateSupplementText(text, candidateCodes, searchSpec) {}
}
```

Responsibilities:

1. merge decoration from base + supplements
2. provide generic overlay evaluation for supplement-backed filters
3. expose deterministic used-supplement metadata

This should not require changes to legacy providers immediately. It can be a
wrapper around an existing provider.

## IR-specific executor

For the IR path, we need an execution adapter that knows how to preserve
correctness for:

- membership
- count
- ordering
- paging

when supplement filters are active.

Proposed contract:

```js
class SupplementAwareIRExecutor {
  constructor(baseProvider, supplementView) {}

  async executeIR(subtree, opts) {}
  async countForIR(subtree, opts) {}
  async membershipForIR(subtree, code, opts) {}
}
```

This is an IR consumer of the supplement runtime, not the owner of it.

## Clause ownership and dependency analysis

We do **not** try to annotate IR clauses with supplement provenance.

Instead, at execution time the supplement-aware layer decides whether a clause
depends on supplement data.

### Dependency detection

For a clause like:

```js
{ property: 'D20', op: '=', value: '20' }
```

the runtime asks:

- does the base provider know `D20` natively?
- do active supplements define `D20`?
- both?

This produces one of:

1. base-only
2. supplement-only
3. mixed

The same principle applies to:

- designation-derived display selection
- runtime text search over supplement designations/properties
- supplement-backed concept-valued properties
- supplement-backed hierarchical properties

## Generic correctness algorithm for supplement-backed filters

This is the most important algorithmic part of the design.

If any active clause or runtime text condition depends on supplements, the
system must still return correct count/page membership.

That means supplement evaluation must happen **before** terminal paging.

### Generic algorithm

For a projected subtree:

1. classify which parts can be pushed to the base provider
2. run the base provider without terminal paging when supplement-backed
   membership conditions remain
3. materialize a candidate code set
4. apply supplement-backed clause evaluation and supplement-backed text search
   in memory
5. apply ordering
6. apply count/offset

This may be slower than native pushdown, but it is correct.

### Why paging cannot happen first

If you page the base result first and then post-filter by supplement values, you
can lose matches and report wrong totals.

So generic supplement semantics require unsliced membership evaluation before
terminal paging.

### `membershipForIR`

Probe semantics are simpler:

1. ask whether the code is in the base subtree
2. if yes, apply supplement-backed clause/text evaluation to that code

### `countForIR`

Count semantics must count the fully filtered set, not the base candidate set.

So generic supplement count must operate on the supplement-filtered membership
set before counting.

## Native pushdown

Native pushdown should be opt-in at the provider layer.

For sqlite-v0, supplement pushdown can eventually happen by lowering supplement
data into provider-private query plans:

- inline temp tables for request-scoped supplements
- attached supplement DBs for server-loaded sqlite supplements
- joined views
- provider-local indexed projections

The important rule is:

- native pushdown must produce the same result as generic overlay evaluation

### Supplement-native storage keys

For sqlite-backed supplement sources, the supplement asset must **not** be
stored in base-runtime identifiers such as:

- `concept_id`
- `property_id`
- `designation_id`

Those identifiers are local to one base sqlite-v0 build and are not stable
across external supplement files.

So supplement-native storage must be keyed by stable terminology identity:

- target base `system`
- target base `version`
- source `code`
- `property_code`
- concept-valued `target_code`

At runtime, a concrete base scope binds supplement rows back onto the active
base DB by joining `code -> concept_id` and `property_code -> property_def`.

That gives a clean separation:

- on disk: supplement data is portable across compatible base DB builds
- at runtime: supplement rows can be lowered into the same logical row shapes
  as base `designation`, `concept_literal`, and `concept_link`

This is also what allows a query to ask for property `X` without knowing in
advance whether `X` comes from:

- the base DB
- one active supplement
- several active supplements

The runtime should query the unified logical property/designation relations and
let additive multi-valued semantics fall out naturally.

### Initial server-loaded storage policy

For the first native sqlite supplement slice, server-loaded supplements should
be sqlite sidecars, not server-loaded JSON resources.

That keeps the initial runtime simple:

- registered descriptor -> sqlite supplement file path
- request/provider bind step -> `ATTACH` or equivalent request-lifetime binding
- planner lowers supplement-backed queries against attached supplement tables

Later, if needed, server-loaded JSON supplements can be normalized into a cached
overlay or converted offline into sqlite sidecars. That should be a later
phase, not part of the initial native path.

### Initial sqlite sidecar schema

The first native sidecar schema should stay deliberately small and query-shaped.

Tables:

- `supplement_info`
  - one row per sidecar
  - `url`, `version`, `canonical`
  - `target_system`, `target_version`
  - `name`, `title`, `language`
- `supplement_property_def`
  - keyed by `property_code`
  - `value_kind` (`literal` or `concept`)
  - `is_hierarchy`
  - `display`
  - `source_type`
- `supplement_designation`
  - keyed by `source_code`
  - `language_code`, `use_system`, `use_code`, `term`, `preferred`, `active`
- `supplement_literal`
  - keyed by `source_code` + `property_code`
  - `value_raw`, `value_text`, `value_num`, `value_bool`
  - `group_id`, `active`
- `supplement_link`
  - keyed by `source_code` + `property_code` + `target_code`
  - `target_system`
  - `group_id`, `active`
- `supplement_extension`
  - keyed by `source_code`
  - `url`, `value_json`

Indexes:

- source-oriented indexes for designation/property/extension lookup
- property-oriented indexes for filter pushdown
- target-code index for future concept-valued property joins
- FTS tables for designation/literal text:
  - `search_fts_designation`
  - `search_fts_literal`

This schema is keyed by stable terminology identity:

- source `code`
- `property_code`
- target `code`

It intentionally does **not** store base-runtime identifiers such as
`concept_id` or `property_id`.

### Runtime binding shape

At query time, a sqlite-v0 provider with base scope `(system, version, cs_id)`
binds an attached supplement sidecar by joining codes back to the active base
DB:

- `supplement_designation.source_code -> concept.code`
- `supplement_literal.source_code -> concept.code`
- `supplement_link.source_code -> concept.code`
- `supplement_link.target_code -> concept.code`

So the planner can expose unified logical relations such as:

- base `designation` `UNION ALL` bound supplement designations
- base `concept_literal` `UNION ALL` bound supplement literal properties
- base `concept_link` `UNION ALL` bound supplement concept-valued properties

That is the crucial property of the design:

- queries do not need to know whether a property came from base or supplement
- additive multi-valued semantics fall out of the combined rowsets
- distinct supplement properties and shared supplement/base properties use the
  same query shapes

### Native planner source pruning

Once a concrete supplement set is bound for a request, sqlite-v0 should build a
small per-request manifest for property planning:

- base `property_def`
- each active sidecar's `supplement_property_def`
- each active inline supplement materialized into sqlite for that request

For a clause on property `P`, the planner should ask three static questions
before choosing any SQL shape:

1. does the base DB define `P` at all?
2. which active supplement bindings define `P`?
3. in each relevant source, is `P` `literal` or `concept` valued?

The clause semantics stay the same:

- a concept matches if **any relevant source** has **any value** for `P` that
  satisfies the clause

But the SQL should only touch relevant sources. That means, for example:

- `d20-roll = 20` should touch only the `d20` supplement literal rows
- `CLASS = CHEM` on LOINC should touch only the base DB
- a shared additive property such as `damage-type` should touch base if present
  plus every active supplement that also defines it

The planner should also reject malformed mixed-kind definitions:

- if one active source says `P` is literal-valued and another says `P` is
  concept-valued, that is a configuration/runtime error, not something to guess
  through

Status:

- correctness already works without this pruning because the current native path
  queries unified logical relations
- performance tuning now relies on this manifest as a first planning step,
  because the supplement-sensitive worst cases were caused by touching
  irrelevant source families or irrelevant supplement bindings
- current implementation status:
  - the manifest is now consulted during clause lowering, so impossible source
    branches are not constructed in the first place
  - native SQL lowering also prunes supplement bindings by property presence and
    value kind
  - static manifest lookups are effectively free compared to query execution in
    practice, so this pruning does not need a separate cache
  - on real LOINC `d20` / `d8` sidecars, the best current page/count shapes for
    supplement-only literal equality filters are set-oriented source-code
    queries built from those pruned sources
  - the main remaining performance lever after pruning is SQL shape, not more
    aggressive property-manifest caching
  - extra covering indexes on `supplement_literal` did not materially improve
    the winning pruned shapes in local benchmarks, so index growth should stay
    secondary to shape choice

### Provider hook

Instead of making every provider understand supplement sources directly, expose
an optional hook:

```js
class CodeSystemProvider {
  async bindSupplementSet(supplementSet) {
    return null; // generic path by default
  }
}
```

If implemented, the provider returns a provider-specific optimized view or
binding handle.

If not implemented, the generic supplement-aware wrapper remains correct.

## Old expander relationship

The old expander is out of scope for this refactor.

That means:

1. do not thread this new supplement architecture through `expand.js`
2. do not change legacy `CodeSystemProvider.supplements` behavior just to match
   the new design
3. do build the new supplement runtime below the operation layer so that lookup
   and validate can adopt it later without depending on expansion internals

This keeps review scope manageable and avoids destabilizing the migration path.

## Current code seams we should reuse

These are useful anchors in the current codebase:

1. `worker.resolveCodeSystemVersionAtDate(...)`
   - base version should resolve before supplement binding
2. `worker.loadSupplements(...)`
   - replace over time with the new resolver for the IR path
3. `CodeSystemFactoryProvider.registerSupplements()`
   - good fit for lightweight server-side supplement descriptor registration
4. `CodeSystemFactoryProvider.fillOutSupplement()`
   - good fit for lazy materialization of registered supplement resources

We should reuse these seams where convenient rather than inventing parallel
ones with the same purpose.

## Interface definitions

These are the concrete interfaces proposed for the first implementation pass.

### `tx/supplements/types.js`

```js
type BaseScope = { system: string, version: string | null };

type SupplementRef = {
  canonical: string,
  source: 'useSupplement' | 'valueset-extension',
  order: number,
};

type SupplementDescriptor = {
  canonical: string,
  version: string | null,
  targetSystem: string,
  targetVersion: string | null,
  sourceKind: 'inline' | 'registered-codesystem' | 'sqlite-native',
};

type ResolvedSupplement = {
  descriptor: SupplementDescriptor,
  target: BaseScope,
  requestRef: SupplementRef,
  overlaySource: object,
  nativeBindingSource?: object | null,
};

type SupplementSet = {
  target: BaseScope,
  items: ResolvedSupplement[],
};
```

### `tx/supplements/registry.js`

```js
class SupplementRegistry {
  addInlineCodeSystems(resources) {}
  addRegisteredDescriptors(descriptors) {}
  findCandidates(canonical) {}
}
```

### `tx/supplements/resolver.js`

```js
class SupplementResolver {
  async resolveForBaseScope({ target, refs, inlineResources, registry }) {}
}
```

### `tx/supplements/overlay.js`

```js
class SupplementOverlayBuilder {
  async buildSupplementSetOverlay(supplementSet) {}
  async evaluateClauseOnCodes(clause, codes, overlay) {}
  async evaluateTextOnCodes(text, codes, overlay, searchSpec) {}
}
```

### `tx/supplements/aware-view.js`

```js
class SupplementAwareCodeSystemView {
  constructor(baseProvider, supplementSet, overlayBuilder) {}
}
```

### `tx/supplements/ir-executor.js`

```js
class SupplementAwareIRExecutor {
  constructor(baseProvider, supplementView) {}
}
```

## Operation flows

### IR expand flow

1. resolve base system version
2. for each projected `(system, version)` bucket:
   - resolve supplements for that concrete base scope
   - create supplement-aware provider view
   - execute subtree through supplement-aware executor
3. decorate output using the same supplement-aware view
4. emit `used-supplement`

### Later lookup flow

1. resolve base system version
2. resolve supplements for base scope
3. create supplement-aware provider view
4. answer display/designation/property/extension queries through the view

### Later validate-code flow

1. resolve base system version
2. resolve supplements for base scope
3. create supplement-aware provider view
4. use base membership semantics
5. use supplement-aware display/property/designation results in the response
6. when validating ValueSet membership, supplement-backed filters must be
   applied through the same generic/native supplement-aware evaluation path

## Trace requirements

Supplement handling must be visible in trace output.

For each projected bucket, record:

- requested supplement refs
- resolved supplements
- unresolved supplement refs
- binding target `(system, version)`
- whether native supplement binding was used
- whether generic overlay filtering was used
- whether supplement-backed text search was active

This is required both for debugging and for perf interpretation.

## Testing strategy

This design needs layered tests from the start.

### 1. Resolution tests

Cover:

- `useSupplement`
- `valueset-supplement` extension
- inline resource precedence
- raw inline `CodeSystem` JSON normalization
- ambiguity errors
- version-pinned resolution
- binding to lockedDate-resolved base versions

### 2. Overlay semantics tests

Cover:

- additive properties
- additive designations
- deterministic display tie-break
- extension projection
- exact duplicate handling policy

### 3. Generic supplement filter tests

Cover:

- literal property `=`, `in`, `regex`
- concept-valued property filters
- hierarchical property filters
- text search over supplement designations/properties
- count/paging correctness when supplement filters are active

### 4. Native sqlite parity tests

Compare:

- generic overlay execution
- native sqlite supplement pushdown

for the same fixtures.

### 5. Full harness tests

Expand current supplement coverage to include:

- request-scoped inline supplements
- server-loaded registered supplements
- sqlite-native supplement-backed property filtering
- mixed multiple supplements
- count/paging parity
- adapter-backed providers using the generic supplement IR path

### 6. Synthetic scale fixtures

We should keep at least one large deterministic supplement generator around so
native pushdown work is exercised against something closer to real scale than
handwritten toy fixtures.

Current direction:

- a D20 supplement and a D8 supplement generated over a real base sqlite-v0 DB
- distinct properties such as `d20-roll` and `d8-roll`
- shared additive properties such as `dice-band`, `damage-type`, and sparse
  `party-role`
- generator entrypoint: `scripts/generate-dice-supplements.mjs`

This is useful because it gives:

- guaranteed fractional selectivity such as roughly `1/20` for `d20-roll = 20`
- mixed multi-supplement queries using both distinct and shared properties
- a realistic way to compare generic overlay execution with later native
  pushdown strategies

## Phased rollout

### Phase 0: freeze semantics and write the seams

Status: complete

Deliverables:

- this design doc
- trace expectations
- basic request parsing tests

Exit:

- agreed semantics for explicit activation, binding, and additive values

### Phase 1: supplement registry + resolver for IR expand

Status: complete

Implemented notes:

- `tx/supplements/types.js`
- `tx/supplements/registry.js`
- `tx/supplements/resolver.js`
- worker-side IR integration in `tx/workers/worker.js` and
  `tx/workers/expand.js`
- request-level tests for inline, registered, version-pinned, and ambiguous
  supplement resolution
- raw inline `CodeSystem` JSON resources are normalized at registry ingress, so
  request-scoped `tx-resource` supplements resolve the same way as in-memory
  `CodeSystem` instances

Deliverables:

- `tx/supplements/types.js`
- `tx/supplements/registry.js`
- `tx/supplements/resolver.js`
- IR orchestrator integration
- inline + registered CodeSystem supplement resolution

Implementation shape:

- keep this phase intentionally small
- plain object contracts are preferred over class hierarchies
- do not pre-create later-phase modules in this phase

Scope:

- IR expand only
- no legacy expander changes
- decoration semantics may still route through existing provider behavior while
  the new runtime is introduced

Exit:

- IR path resolves/binds supplements through the new resolver

### Phase 2: generic supplement-aware provider view

Status: effectively complete for IR expand

Implemented notes:

- `tx/supplements/overlay.js`
- orchestrator decoration now merges supplement designations, properties, and
  extensions from resolved supplement sets instead of relying on ad hoc
  provider-specific supplement decoration
- deterministic `used-supplement` reporting on the IR path

Implementation note:

- the seam exists in code, but it is intentionally flatter than the original
  document sketch; there is no separate `aware-view.js` yet because the real
  code pressure has not justified another layer

Deliverables:

- `tx/supplements/overlay.js`
- `tx/supplements/aware-view.js`
- additive decoration merged by the new view
- deterministic `used-supplement`

Scope:

- inline and registered CodeSystem supplements
- generic overlay keyed by code

Implementation rule:

- only add these files once Phase 1 code has shown the need for them
- if the real code collapses some of these seams, collapse the design too

Exit:

- IR path no longer relies on ad hoc provider supplement merging for decoration

### Phase 3: generic supplement-aware IR execution

Status: complete for the generic simple-operator correctness path

Implemented notes:

- `tx/supplements/ir-provider.js`
- `tx/engine/generic-ir-executor.js`
- supplement-backed property filters now affect membership before count/paging
- supplement designation text is visible to IR-path text filtering
- IR `$expand` response shaping now preserves typed base and supplement
  `value[x]` properties and emits `expansion.property` metadata instead of
  degrading typed values to strings
- the current path is correctness-first and generic: it runs the base scoped IR
  normally, then evaluates supplement-touched semantics against merged
  base+supplement values by code
- when a provider reports `_irAllSupplementsNativeBound === true`, the
  orchestrator skips generic overlay decoration so native-bound supplement
  properties/designations are not applied twice
- the supplement wrapper no longer carries its own duplicate union/intersect/
  diff/paging/hierarchy executor; it now reuses the shared generic IR executor
  core from `tx/engine/generic-ir-executor.js`, with supplement-specific hooks
  for clause partitioning, merged property lookup, and supplement-aware text
  matching
- adapter-backed providers are covered through the same path via the IR
  supplement wrapper over legacy/provider filter protocols; current targeted
  coverage includes US states numeric property filtering and UCUM designation
  text filtering
- explicit current boundary: overlay-backed hierarchical/property operators such
  as `is-a` / `descendent-of` on supplement concept-valued properties are not
  yet implemented in the generic path; they fail closed and remain a documented
  TODO
  text matching
- unsupported overlay-backed property operators remain explicit failures in the
  generic path instead of silently drifting or relabeling as an IR miss

Deliverables:

- `tx/supplements/ir-provider.js`
- `tx/engine/generic-ir-executor.js`
- supplement-backed filter evaluation
- supplement-backed text evaluation
- correct count/paging semantics before slicing

Scope:

- correctness first
- may be slower for large base scans

Exit:

- supplement-backed filter semantics work even without native pushdown

### Phase 4: sqlite-v0 native supplement bindings

Status: complete for the first sqlite-native slice

Current target:

- keep Phase 3 as the semantic oracle
- add a native sqlite-v0 supplement binding seam
- push supplement-backed property filters and supplement designation text into
  sqlite-v0 execution when the provider can do so without changing semantics

Implementation notes:

- this phase should not replace the generic supplement path
- the generic path remains the parity reference and fallback
- the first native slice should stay narrow:
  - inline/request JSON supplements are still request-scoped, but sqlite-v0 may
    materialize them into attached `:memory:` supplement DBs for native
    execution
  - server-loaded supplements start as sqlite sidecars
  - sidecars bind by `code` / `property_code`, not base row ids
- concrete work already in place:
  - `tx/supplements/sqlite-sidecar.js`
  - `tx/supplements/source-sqlite.js`
  - `tx/cs/sqlite-v0-supplements.js`
  - `scripts/generate-dice-supplements.mjs --formats sqlite`
  - sqlite-v0 provider attachment via `attachIRSupplements(...)`
  - inline supplement `CodeSystem` resources can be materialized into attached
    in-memory supplement schemas on sqlite-v0
  - merged property-definition view for planner support and `doesFilter(...)`
  - unified base+supplement literal/link/designation/search sources in the
    sqlite-v0 compiler path
  - parity tests proving server-side sqlite supplement filters and text search
    match the generic overlay path for the same supplement content
  - parity tests proving inline `CodeSystem` supplements can take either the
    generic overlay path or the sqlite-v0 in-memory native path with the same
    results
  - strict IR harness coverage now includes inline supplement-backed property
    filtering on sqlite-v0 with paging, so the native path is exercised in the
    same no-fallback matrix as the rest of the execution engine
  - strict IR harness coverage now also includes configured server-loaded
    sqlite sidecars on real LOINC v0 data via `scripts/run-ir-harness.sh
    --with-synthetic-supplements`
  - attached-query tests proving distinct-property and multi-supplement
    shared-property query shapes
  - manual attached-query probes against full LOINC synthetic sidecars,
    including `EXPLAIN QUERY PLAN` checks for numeric and text property filters
- the current harness-side distinct-property query uses a known intersecting
  pair from the deterministic generator:
  - `d20-roll = 20`
  - `d8-roll = 2`
  This avoids depending on an accidental empty intersection.
- sqlite-native supplement resolution now keeps sidecar overlay materialization
  lazy:
  - native sqlite bindings are resolved eagerly
  - full overlay `CodeSystem` materialization happens only when a generic
    consumer such as lookup/validate explicitly asks for it
- current native supplement performance work is centered on static
  property/source pruning from base `property_def` plus active
  `supplement_property_def`
- clause lowering now uses that manifest to avoid constructing impossible
  literal/link branches for supplement-backed property filters
- for supplement-only literal equality filters, the winning native shapes so
  far are:
  - page/materialize: intersect pruned `source_code` sets first, then join back
    to `concept` for ordering and paging
  - count: count from the same pruned set-oriented membership, rather than
    reintroducing unrelated source families
- next implementation step is broader performance characterization, not more
  speculative storage design

Deliverables:

- `tx/supplements/sqlite-sidecar.js`
- `source-sqlite.js`
- provider `bindSupplementSet(...)` hook
- sqlite-v0 native supplement clause lowering/pushdown
- parity tests vs generic overlay path

Scope:

- same semantics as phase 3
- better performance on sqlite-backed supplements

Exit:

- sqlite-v0 native supplement queries are semantically aligned with the generic
  overlay path and can now be tuned further for performance

### Phase 5: server-loaded supplement sources

Status: complete for the first sqlite-sidecar cut

Implemented notes:

- registered `CodeSystem` supplements can already be requested by canonical
- lazy factory fill-out/materialization already works through
  `registerSupplements()` / `fillOutSupplement()`
- initial native direction is now explicit:
  - server-loaded native supplements start as sqlite sidecars
  - server-loaded JSON supplements are not required in the first cut
- sqlite sidecars are now a real supplement source type in the registry and
  resolver via `tx/supplements/source-sqlite.js`
- factories can advertise sqlite sidecars through
  `registerSqliteSupplements()`
- native sqlite sidecars are now consumable by the sqlite-v0 provider at IR
  execution time through `attachIRSupplements(...)`
- library/provider config wiring is now live for sqlite-v0 via
  `options.supplements` on the `sqlite-v0:` source
- sqlite sidecars now materialize back into `CodeSystem` overlays as well as
  native bindings, so the same descriptor can be reused outside the IR-native
  path
- sqlite sidecar overlay materialization is now explicit and lazy:
  - native sqlite-v0 expand/lookup/validate can stay on the native binding path
    without paying sidecar -> `CodeSystem` conversion
  - generic consumers can still request the overlay on demand
  - targeted tests pin this behavior in:
    - `tests/tx/supplement-sqlite-source.test.js`
    - `tests/tx/supplements-resolver.test.js`
- legacy `$expand` now fails closed for requested configured sqlite sidecars
  instead of returning a misleading success that omits supplement semantics
- request-level tests now cover server-loaded sqlite supplement resolution from
  config in `$expand`, `$lookup`, and `$validate-code`
- harness/perf runner support is now live for generated server-loaded sqlite
  supplements:
  - `scripts/run-ir-harness.sh --with-synthetic-supplements`
  - generates deterministic LOINC `d20` / `d8` sidecars under the run output
  - patches the active library YAML so the LOINC `sqlite-v0:` source gets
    `options.supplements`
  - exposes the generated supplement canonical root to the harness through
    `HARNESS_SQLITE_SUPP_URL_ROOT`
- a full supplement-aware perf run now exists at:
  - `tmp/ir-harness-runs/perf-supp-20260306/perf-table.html`
  - that run covers both inline supplement rows and configured sqlite-sidecar
    rows in the same matrix

Still missing:

- nothing essential for the initial server-loaded sqlite-sidecar scope
- later work can add non-sqlite server-loaded supplement source kinds if needed

Deliverables:

- library/provider registration path for supplement descriptors
- lazy fill-out/materialization from provider factories
- optional sqlite-backed supplement source loading from config

Exit:

- supplements can be requested by canonical without being supplied inline

### Phase 6: reuse in lookup / validate / subsumes

Status: complete for the current supplement-sensitive operation scope

Implementation note:

- this phase should consume the supplement runtime below the operation layer;
  it should not recreate supplement-specific logic inside each operation

Implemented notes:

- `findCodeSystemWithSupplementRuntime(...)` now resolves the full supplement
  set for a concrete base scope and:
  - attaches it natively for sqlite-v0 providers through `attachIRSupplements`
  - falls back to classic `CodeSystem[]` supplement attachment for providers
    that do not support native attachment
- `$lookup` now uses the supplement runtime below the operation layer
- `$validate-code` now uses the supplement runtime below the operation layer
- sqlite-v0 legacy filter execution now unions supplement-backed literal/link
  rows into property filtering, so `$validate-code` sees supplement-backed
  membership correctly
- sqlite-v0 reports native-attached supplements through `hasSupplement()` /
  `listSupplements()` so shared supplement guards work the same way for native
  and non-native attachment
- request-level tests now prove configured sqlite sidecars and inline
  `tx-resource` supplements of the same canonical are equivalent through:
  - `$expand`
  - `$lookup`
  - `$validate-code`
- request-level IR tests now prove adapter-backed providers also participate
  through the same supplement runtime:
  - `internal:usstates` inline supplement numeric filters affect membership
    before paging
  - `ucum` inline supplement designations affect IR text filtering
- strict IR harness coverage now includes those same adapter-backed supplement
  query shapes

Deliberate non-work in this phase:

- `$subsumes` is intentionally unchanged
  - current supplement semantics do not alter code identity or hierarchy
  - additive designations/properties/extensions cannot change a subsumption
    result
  - if we ever introduce a supplement form that can alter hierarchy semantics,
    this assumption must be revisited explicitly
- `$related` does not need separate supplement wiring because it delegates to
  ValueSet comparison/expansion logic, which already uses the new supplement
  runtime on the IR path
- `locate` is an internal provider surface rather than a separate request
  operation; supplement-aware locate behavior is already exercised through
  expand/lookup/validate flows

Deliverables:

- lookup integration
- validate-code integration
- explicit decision on subsumes non-integration

Exit:

- supplement resolution and overlay semantics are shared below the operation
  layer for all supplement-sensitive request flows in current scope

## Definition of done

This supplement architecture is complete when:

1. supplements are resolved explicitly by canonical for a concrete base scope
2. supplement-backed filters work correctly in the IR path
3. generic overlay evaluation exists as the semantic fallback
4. sqlite native pushdown is an optimization, not a requirement
5. server-loaded supplements can participate without inline `tx-resource`
6. lookup/validate can reuse the same supplement runtime later
7. the legacy expander is not refactored during this migration, aside from
   narrow fail-closed guards that prevent silent wrong answers

## Related documents

- [ir-engine.md](ir-engine.md)
- [sqlite-v0-execution-compiler.md](sqlite-v0-execution-compiler.md)
- [sqlite-v0-provider-compiler-plan.md](sqlite-v0-provider-compiler-plan.md)
