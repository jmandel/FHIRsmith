# IR Runtime Cleanup Plan

This document is a cleanup plan for the current IR runtime architecture.

It is not a rewrite proposal.

The goal is to keep the current IR engine direction, preserve the legacy
expander, and tighten the places where responsibility is currently blurred:

- orchestrator phase boundaries
- supplement binding and execution
- manifest-driven supplement routing
- decoration ownership
- wrapper option forwarding

## Status

This file is now a working cleanup/status document, not just a proposal.

Implemented on the current branch:

- request-scoped IR bound scope binding for the expand runtime
- orchestrator response shaping extracted into `tx/engine/ir-expansion-response.js`
- IR planning extracted into `tx/engine/ir-expansion-plan.js`
- IR scope execution extracted into `tx/engine/ir-expansion-execution.js`
- supplement decoration ownership moved behind the bound scope
- wrapper option forwarding locked with focused contract tests
- explicit generic executor result objects instead of array-stapled metadata
- SQL AST node constructors split out of lowering in `sqlite-v0-sql-nodes.js`

Still open here:

- decide whether the proxy wrapper remains acceptable long-term
- continue follow-on reuse of the bound-scope pattern in lookup/validate
  beyond the current tactical seams
- narrow the outward IR execution seam fully to bound scopes once the
  remaining compatibility shims are no longer needed

The standard for success is sparse architecture:

- one clear owner for each runtime concern
- stable semantic boundaries
- minimal cross-layer knowledge
- no duplicate semantic logic unless duplication is deliberate and bounded

This plan assumes the current design intent in:

- [ir-engine.md](/home/jmandel/hobby/FHIRsmith-ir-engine/docs/ir-engine.md)
- [supplement-architecture.md](/home/jmandel/hobby/FHIRsmith-ir-engine/docs/supplement-architecture.md)
- [sqlite-v0-execution-compiler.md](/home/jmandel/hobby/FHIRsmith-ir-engine/docs/sqlite-v0-execution-compiler.md)

## Current Assessment

The core architecture is good:

- semantic IR compilation is separate from provider-native execution
- sqlite-v0 has a credible compiler pipeline
- the shared generic executor is the right direction
- cross-version output conversion is already centralized below the operation layer

Several correctness fixes have already landed in the current worktree:

- native-bound supplements are no longer re-decorated through the late overlay
  merge guard
- supplement property declaration tracking now includes declared supplement
  property definitions
- wrapper passthrough for incomplete-expansion semantics has been tightened
- explicit `_engine=ir` requests are treated as
  fail-closed IR-only paths rather than silent legacy fallback paths

The remaining debt is structural:

1. follow-on reuse of the runtime seam outside IR expand is only partial
2. supplement binding is still spread across worker, wrapper, and provider code
3. `resolveIRExecutionScopes()` still accepts either a raw provider or a bound
   scope as a compatibility seam; the target architecture is one explicit bound
   scope contract
4. decoration ownership still depends on provider side-channel flags instead of
   an explicit bound contract
5. supplement manifest/capability handling is still implicit and distributed
6. wrapper option forwarding is still easy to regress without an explicit
   contract

These are the cleanup targets in this document.

## Relationship To Current Branch Fixes

This plan is not a pre-merge gate for the current branch.

The tactical correctness fixes already present in the worktree are the
merge-relevant items. This document is for the structural cleanup that should
follow, unless a small low-risk piece is deliberately pulled in before merge.

## Goals

1. Keep legacy `$expand` intact
2. Do not change `tx/workers/expand.js` as part of this cleanup
3. Keep the IR semantic model intact
4. Preserve provider-native execution as an optimization boundary
5. Make supplement behavior deterministic and single-owner
6. Improve correctness before adding new planner/runtime complexity

## Non-Goals

1. Rewriting legacy `$expand` to run on IR
2. Refactoring `tx/workers/expand.js`
3. Replacing the sqlite-v0 compiler design
4. Introducing a larger universal provider API than the current IR trio
5. Adding a process-global supplement cache in this pass
6. Refactoring every operation at once

## End State

At the end of this cleanup, the intended steady state is:

- IR request-time supplement binding is represented by an explicit bound scope,
  not scattered provider mutation
- supplement clause routing is determined from an effective manifest
- supplement decoration runs through one owner per bound scope
- overlay properties are stored as canonical raw FHIR property objects
- R4/R3 crossover continues to live only in the xversion layer

## Delete List

This cleanup should remove or retire the following IR-path patterns:

- direct provider `_irSupplementSet` writes outside the binder/runtime path
- direct provider `_irAllSupplementsNativeBound` reads outside the
  binder/runtime path
- late generic overlay merges in the orchestrator after a runtime has already
  decorated candidates
- newly written overlay property objects that contain both `value` and
  `value[x]`
- supplement routing decisions based on observed overlay rows instead of the
  effective manifest

## Architectural Principles

### 1. Internal shape first, version crossover later

All operation code should build one internal R5-shaped result.

FHIR version adaptation remains centralized in the xversion layer:

- `tx/xversion/xv-valueset.js`
- `tx/tx.js`

No operation-specific code should care whether the request is R4 or R5 when
deciding how to represent expansion properties.

### 2. Bound runtime context over provider mutation

Request-scoped supplement state should not be spread by mutating provider
instances with ad hoc fields.

Instead, request-time binding should produce one explicit bound scope for one
provider in one base scope with one supplement set.

### 3. Decoration has exactly one owner

For any candidate/property/designation/extension, one bound-scope component is
responsible for adding it to the expansion result.

If native decoration is complete, generic overlay merge does not run.
If native decoration is partial, the gap is explicit and testable.

### 4. Routing is schema-driven

Supplement-aware clause routing should depend on the declared effective property
manifest, not on whether a particular supplement currently happens to contain a
row for that property.

### 5. IR cleanup is allowed; legacy duplication is acceptable

If legacy and IR both contain similar output-shaping logic, that duplication is
acceptable for now.

The cleanup should prefer a clean IR-side implementation over any refactor that
would require touching `expand.js`.

## Workstream 1: Split The Orchestrator Into Explicit Phases

Status:
- implemented for the current IR expand path
- phase modules now exist for:
  - planning: `tx/engine/ir-expansion-plan.js`
  - bind/execute: `tx/engine/ir-expansion-execution.js`
  - render/decorate: `tx/engine/ir-expansion-response.js`
- `expandViaIR()` now reads as a phase sequence over those modules

### What

Refactor `tx/engine/orchestrator.js` into smaller modules aligned with the
existing architecture:

- `plan`
  - compile ValueSet to IR
  - resolve imports
  - bind lockedDate
  - optimize
  - check partition safety
- `bind`
  - resolve providers
  - project scoped subtrees
  - bind supplements/runtime context
- `execute`
  - count
  - stride pagination
  - execute per-scope page fetch
- `decorate`
  - bulk designations/properties/extensions
  - compose overrides
- `render`
  - build the internal R5 `ValueSet.expansion`

### Why

Right now `orchestrator.js` acts like a whole subsystem instead of a conductor.
That makes review harder and encourages new logic to accrete in the same file.

The current architecture already thinks in phases. The code should do the same.

### How

Start by extracting pure or mostly-pure helpers without changing behavior:

- `resolveLockedDateVersions`
- provider projection/binding loop
- pagination/count execution
- candidate decoration
- response rendering

Keep `expandViaIR()` as the top-level entrypoint, but turn it into a thin
sequence of phase calls.

### Deliverable

`expandViaIR()` reads as orchestration, not implementation.

### Verification

- no behavior change in existing e2e corpus
- trace output remains equivalent
- extracted modules have direct unit tests where practical

## Workstream 2: Introduce A Bound IR Scope Binder

Status:
- implemented for IR expansion
- current entry seam is `TerminologyWorker.bindIRScopeForExpansion(...)`
- the orchestrator now consumes a bound scope instead of directly reading
  provider supplement side-channel state

### What

Introduce a request-scoped bound scope object for one provider/base scope:

```text
BoundIRScope
  - execution
    - executeIR(subtree, opts)
    - countForIR(subtree, opts)
    - membershipForIR(subtree)
  - decoration
    - decorateCandidates(candidates, opts)
  - usedSupplements()
  - nativeCoverage()
```

This object is created after:

- base provider resolution
- base version resolution
- supplement resolution for that concrete base scope

### Why

Today the same runtime state is spread across:

- `tx/workers/expand.js`
- `tx/supplements/ir-provider.js`
- `tx/cs/cs-sqlite-v0.js`

using mutation and side-channel fields such as:

- `_irSupplementSet`
- `_irAllSupplementsNativeBound`
- wrapper proxy behavior

That works, but it obscures ownership and creates coupling between workers,
wrappers, providers, execution, and decoration code.

### How

Add a binder layer below `expand.js` and above providers:

- input:
  - base provider
  - scoped subtree metadata
  - resolved supplement set
- output:
  - `BoundIRScope`

Two initial execution/decorate combinations are enough:

1. native execution + native decoration
   - for providers that can natively bind supplements and execute/decorate
     correctly for the active supplement set
2. supplement-aware execution + overlay decoration
   - for runtimes that need generic overlay handling for some or all supplement
     semantics

The binder decides which execution facet and which decoration facet to use for
the bound scope.

The orchestrator talks to the bound scope, then separately to:

- `bound.execution` during count/paging/materialization
- `bound.decoration` during post-page decoration

Initial binding decision table:

| Condition | Execution facet | Decoration facet | Responsibilities |
|-----------|-----------------|------------------|------------------|
| provider supports native IR and native supplement binding covers the active supplement set | native | native | execute, count, membership, decorate, used supplement accounting, coverage reporting |
| provider supports native IR but supplement semantics require generic overlay handling | supplement-aware over native base runtime | overlay | supplement-aware execute, decorate, used supplement accounting, coverage reporting |
| provider does not support native IR but can be adapted through the generic executor | supplement-aware over adapter-backed base runtime | overlay | supplement-aware execute, decorate, used supplement accounting, coverage reporting |

The selection rule should be explicit in code and testable in isolation.

### Deliverable

The worker no longer manually decides:

- whether to mutate the provider
- whether to wrap it
- whether to later re-read supplement state from provider fields
- supplement decoration ownership now hangs off the bound scope

### Verification

- no direct writes to provider `_ir*` fields outside the binder/runtime path
- supplement accounting is obtained from the bound scope, not from provider
  inspection

## Workstream 3: Make Supplement Routing And Overlay Representation Manifest-Driven

Status:
- partially complete
- supplement property routing now includes declared supplement property defs
- overlay-backed properties are written as typed `value[x]` objects
- generic fallback capability remains intentionally limited to simple operators

### What

Create one explicit effective supplement manifest for a bound base scope.

It should describe:

- declared supplement property definitions
- property kinds
- hierarchy capability
- which properties are supplement-backed at all
- whether native pushdown exists for each property/operator family
- the canonical raw FHIR property representation used by overlay-backed values

### Why

The current branch now tracks declared supplement property definitions, which is
the right tactical fix.

The remaining structural issue is that the effective manifest and overlay value
representation are still implicit and distributed. They should be one explicit
bound-scope concern.

A declared supplement property with zero current values is still a valid part of
the supplement schema. Routing should not silently change when data sparsity
changes.

At the same seam, overlay property storage should be canonical. The overlay
should store raw FHIR property objects like:

- `{ code: 'rank', valueInteger: 1 }`
- `{ code: 'tag', valueString: 'chem' }`

and stop writing mixed bridge objects like:

- `{ code: 'rank', value: 1, valueInteger: 1 }`

### How

At supplement bind time, compute an effective manifest from:

- inline supplement `CodeSystem.property[]`
- sqlite sidecar property defs
- base provider property defs where needed for merged interpretation

This manifest becomes part of the bound scope.

Then:

- `overlayTouchesProperty(...)` becomes manifest-based
- supplement-aware routing consults the manifest
- unsupported operator combinations fail closed based on manifest capability,
  not incidental data shape
- overlay-backed property storage remains raw FHIR `value[x]` objects
- matcher logic derives comparable values at read time
- transitional `{ code, value }` bridge reads are tolerated temporarily, but no
  new writer should emit that shape

### Deliverable

Clause routing depends on declared schema, not on row presence, and overlay
property storage is canonical.

### Verification

Add focused tests for:

- declared property with zero rows
- supplement-only property absent from base provider
- concept-valued property with unsupported hierarchy operator
- explicit fail-closed behavior
- overlay/unit tests assert typed-only property objects
- supplement-backed `=`, `in`, `regex`, and `exists` filters still pass
- outward `$expand` still returns typed `value[x]` only
- permissive read compatibility for transitional `{ code, value }` inputs

## Workstream 4: Establish One Decoration Owner

Status:
- implemented for the current runtime modes
- the orchestrator no longer performs late supplement overlay merges by reading
  provider `_ir*` flags
- decoration is now delegated through the bound scope

### What

Make supplement decoration ownership explicit.

For each bound scope, decoration coverage should be one of:

- `native-complete`
- `native-execute-only`
- `overlay-complete`
- `mixed-explicit`

### Why

The current branch has the right tactical guard: native-bound supplements are no
longer re-decorated through the late overlay merge.

The remaining structural issue is that decoration ownership is still inferred
through provider side-channel flags and orchestrator branching. That is still
more implicit than it should be.

Decoration should not be inferred by a late caller.

### How

Move supplement-aware decoration behind the bound scope interface:

- `decorateCandidates(candidates, opts)` becomes the only supplement-aware
  decoration call
- the orchestrator stops independently merging overlays based on provider state

For sqlite-v0:

- if native supplement decoration is complete for the active supplement set,
  return `native-complete`
- do not apply generic overlay merge after native decoration

For generic overlay runtimes:

- decoration is `overlay-complete`

If mixed mode exists, it must report exactly what the native path did not
cover.

### Deliverable

No candidate can receive the same supplement property/designation from both a
native provider path and a generic overlay path.

### Verification

Add targeted tests for:

- native-bound supplements do not get overlay re-decoration
- configured sqlite sidecar supplement
- non-native provider with overlay supplement
- no duplicate designations/properties/extensions

## Workstream 5: Define Explicit Option Forwarding Contracts

Status:
- implemented for the current supplement-aware wrapper path
- focused contract tests now pin:
  - incomplete-expansion forwarding
  - top-level text/paging staying top-level
  - leaf delegation only receiving the safe subset of options

### What

Make wrapper/runtime delegation explicit about which options are:

- forwarded to leaf execution
- retained only at the top-level executor
- explicitly stripped before leaf delegation

### Why

The current wrapper shape makes it easy to accidentally drop semantics when a
supplement-aware wrapper delegates to a base runtime.

This is a correctness issue, not just a style issue.

### How

Document two distinct layers of options:

1. top-level execution options
   - paging
   - text filtering
   - total/count behavior
   - incomplete-expansion behavior
2. leaf/provider delegation options
   - only the subset that is semantically safe to forward

Add a small contract test suite that encodes:

- which options must be forwarded
- which options must remain top-level only
- which options must never be forwarded through wrapper delegation

### Deliverable

Wrapper logic can no longer accidentally narrow runtime semantics by omitting an
option or by forwarding a top-level-only option to the wrong layer.

### Verification

Direct contract tests around:

- incomplete expansion passthrough
- text forwarding rules
- pagination/top-level slicing rules

## Deferred Item: IR Property Emission Consolidation

The current plan does not treat an IR-local expansion-property builder as a
core cleanup workstream.

That refactor should be reconsidered only if:

- IR property emission gains another substantial call site
- the current orchestrator shaping logic becomes materially harder to maintain
- repeated bugs show that the current helper split is not holding

## Proposed Sequence

### Phase 0: Characterization

Add narrow tests for the known seam failures:

- incomplete-expansion passthrough through supplement wrappers
- manifest-driven routing for declared-but-empty supplement properties
- native-bound supplements do not get re-decorated through the overlay merge

Exit gate:

- each seam failure has a focused reproducer test
- at least one test covers the bridge property compatibility read

### Phase 1: Orchestrator Extraction

Refactor `orchestrator.js` into explicit phase modules with no behavior change.

Exit gate:

- `expandViaIR()` is phase-oriented and materially smaller
- no semantic changes in existing IR e2e corpus

Current note:
- achieved for the current IR expand runtime
- future extraction should only happen if new runtime responsibilities appear

### Phase 2: Bound Scope Binder

Introduce the request-scoped bound scope binder and switch IR execution over to
it, initially as a thin compatibility layer.

Exit gate:

- no direct provider `_ir*` writes outside the binder/runtime path
- runtime selection follows the documented decision table
- supplement accounting is obtained from the bound scope

Current note:
- implemented for IR expansion path
- lookup/validate reuse is still follow-on work rather than a full migration
- resource-backed lookup/validate code-system provider creation now reuses one
  shared worker helper for supplement-aware provider construction

### Phase 3: Manifest-Driven Supplement Routing

Move supplement property relevance, capability checks, and canonical overlay
property representation to the effective manifest/bound-scope layer.

Exit gate:

- routing no longer depends on observed overlay rows
- declared-but-empty supplement property tests pass
- unsupported operator cases fail closed based on manifest capability
- no newly written overlay property object contains both `value` and `value[x]`
- bridge-shape reads remain temporary compatibility behavior only

### Phase 4: Decoration Ownership

Move supplement-aware decoration behind the bound scope and remove late
overlay merges from the orchestrator.

Exit gate:

- native-bound supplement re-decoration guard is covered by a seam test
- orchestrator no longer performs supplement overlay merges after runtime
  decoration
- native-vs-overlay coverage is explicit per bound scope

Current note:
- achieved for current runtime modes
- the remaining work is documenting and extending mixed-mode coverage only if a
  real mixed decoration mode is introduced later

### Phase 5: Option Forwarding Contracts

Make execution/delegation option forwarding explicit and lock it with contract
tests.

Exit gate:

- forwarding/stripping behavior is documented and tested
- wrapper delegation no longer relies on implicit option passing assumptions

Current note:
- achieved for the current supplement-aware wrapper/delegation path

### Phase 6: Follow-On Reuse

After the runtime seams are clean, revisit:

- lookup/validate reuse of the same bound-scope pattern
- further consolidation of metadata rendering helpers

Exit gate:

- reuse work is scoped as deliberate follow-on patches, not folded back into
  the runtime seam cleanup

Current note:
- partially started
- lookup/validate now share a worker helper for supplement-aware
  `CodeSystemProvider` construction from resource-backed code systems
- they do not yet consume the full bound-scope object used by IR expand

## Risks And Mitigations

### Risk: Too much structure for too little gain

Mitigation:

- extract only where a runtime boundary already exists conceptually
- do not invent new planning layers

### Risk: Breaking legacy behavior

Mitigation:

- keep legacy execution fully untouched
- avoid any cleanup step that depends on modifying `expand.js`

### Risk: Supplement performance regressions

Mitigation:

- keep native sqlite supplement execution intact
- move ownership, not semantics, first
- measure before and after on current perf corpus

### Risk: Hidden coupling in decoration

Mitigation:

- make coverage explicit
- add duplicate-detection tests

## Success Criteria

The cleanup is successful when all of the following are true:

1. `expandViaIR()` is phase-oriented and small enough to read linearly
2. supplement runtime state is bound once, not rediscovered later
3. supplement clause routing and overlay representation are manifest-driven
4. overlay properties are stored canonically as raw FHIR property objects
5. native and generic decoration cannot both decorate the same supplement data
   by accident
6. wrapper option forwarding is explicit and protected by contract tests
7. R4/R3 crossover still lives only in the xversion layer

## Recommended First Step

Start with the seam tests and the bound scope binder skeleton.

That gives immediate correctness protection and creates the structure needed for
the rest of the cleanup without forcing a large first patch.
