# Supplement Architecture

This document defines the supplement architecture we want for the new runtime
path.

It is intentionally implementation-shaped. The goal is to make it possible to
move from this document to incremental code changes without inventing the design
again in each patch.

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

There must be no special "unsupported supplement filter" failure mode.

If a supplement is available:

- native providers may push supplement logic down
- otherwise the runtime must fall back to correct generic overlay evaluation

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

## Proposed module layout

Add a new lower-level area:

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

- inline temp tables
- attached supplement DBs
- joined views
- provider-local indexed projections

The important rule is:

- native pushdown must produce the same result as generic overlay evaluation

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

## Phased rollout

### Phase 0: freeze semantics and write the seams

Deliverables:

- this design doc
- trace expectations
- basic request parsing tests

Exit:

- agreed semantics for explicit activation, binding, and additive values

### Phase 1: supplement registry + resolver for IR expand

Deliverables:

- `tx/supplements/types.js`
- `tx/supplements/registry.js`
- `tx/supplements/resolver.js`
- IR orchestrator integration
- inline + registered CodeSystem supplement resolution

Scope:

- IR expand only
- no legacy expander changes
- decoration semantics may still route through existing provider behavior while
  the new runtime is introduced

Exit:

- IR path resolves/binds supplements through the new resolver

### Phase 2: generic supplement-aware provider view

Deliverables:

- `tx/supplements/overlay.js`
- `tx/supplements/aware-view.js`
- additive decoration merged by the new view
- deterministic `used-supplement`

Scope:

- inline and registered CodeSystem supplements
- generic overlay keyed by code

Exit:

- IR path no longer relies on ad hoc provider supplement merging for decoration

### Phase 3: generic supplement-aware IR execution

Deliverables:

- `tx/supplements/ir-executor.js`
- supplement-backed filter evaluation
- supplement-backed text evaluation
- correct count/paging semantics before slicing

Scope:

- correctness first
- may be slower for large base scans

Exit:

- supplement-backed filter semantics work even without native pushdown

### Phase 4: sqlite-v0 native supplement bindings

Deliverables:

- `source-sqlite.js`
- provider `bindSupplementSet(...)` hook
- sqlite-v0 native supplement clause lowering/pushdown
- parity tests vs generic overlay path

Scope:

- same semantics as phase 3
- better performance on sqlite-backed supplements

Exit:

- sqlite-v0 native supplement queries outperform generic overlay for large cases

### Phase 5: server-loaded supplement sources

Deliverables:

- library/provider registration path for supplement descriptors
- lazy fill-out/materialization from provider factories
- optional sqlite-backed supplement source loading from config

Exit:

- supplements can be requested by canonical without being supplied inline

### Phase 6: reuse in lookup / validate / subsumes

Deliverables:

- lookup integration
- validate-code integration
- subsumes integration where relevant

Exit:

- supplement resolution and overlay semantics are shared below operations

## Definition of done

This supplement architecture is complete when:

1. supplements are resolved explicitly by canonical for a concrete base scope
2. supplement-backed filters work correctly in the IR path
3. generic overlay evaluation exists as the semantic fallback
4. sqlite native pushdown is an optimization, not a requirement
5. server-loaded supplements can participate without inline `tx-resource`
6. lookup/validate can reuse the same supplement runtime later
7. the legacy expander remains untouched during this migration

## Related documents

- [ir-engine.md](ir-engine.md)
- [sqlite-v0-execution-compiler.md](sqlite-v0-execution-compiler.md)
- [sqlite-v0-provider-compiler-plan.md](sqlite-v0-provider-compiler-plan.md)
