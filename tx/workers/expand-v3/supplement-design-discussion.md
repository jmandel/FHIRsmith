# Supplement Interface Design Discussion (V3)

## Purpose

This document frames the supplement-interface problem for expand v3.

It captures:
- goals,
- constraints,
- tensions,
- unanswered questions.

It intentionally does **not** propose solutions.

## Scope

In scope:
- ValueSet `$expand` behavior when supplements are in play.
- How supplement information reaches CodeSystem providers.
- Supplement participation in membership filtering and decoration.
- Performance and correctness boundaries for pushdown vs fallback execution.

Out of scope:
- Concrete API signatures.
- Concrete sqlite schema decisions.
- Migration rollout plan details.

## Current Baseline (as implemented today)

- v3 collects required supplement canonicals from params and ValueSet extensions.
- v3 asks the worker for a CodeSystem provider, passing required supplement canonicals.
- worker supplement loading currently resolves from `additionalResources` and yields `CodeSystem` supplement resources.
- provider constructors receive `supplements` as `CodeSystem[]` context.
- v3 engine/provider interfaces (`openStream`, `prepareMembership`, `decorateMany`) do not expose supplement handles explicitly.
- sqlite-v0 currently supports supplement projection for display/designations/properties via in-memory supplement CodeSystem resources.
- sqlite-v0 does not currently treat arbitrary supplement properties as filterable server-side properties.

## Problem Statement

We need a supplement interface that allows providers to evaluate supplement-aware behavior in a first-class way during expansion, including filters and decoration, without forcing all supplement content through in-memory `CodeSystem` resources.

## Goals

1. Functional completeness
- Supplements can contribute to expansion output (display, designations, properties, extensions).
- Supplement-driven filtering can participate in server-side membership evaluation.
- Behavior is defined for both include and exclude filter contexts.

2. Provider interoperability
- Non-sqlite providers can participate without requiring sqlite-specific concepts.
- Legacy providers remain operable.

3. Execution consistency
- Pushdown and fallback paths preserve expansion membership semantics.
- Supplement-aware filtering does not create mode-dependent membership drift.

4. Performance
- Large supplements do not require mandatory full in-memory materialization for routine expansion paths.
- Providers that can execute supplement-aware queries natively can do so.

5. Observability
- Tracing and diagnostics can show when supplements are used for filtering, projection, or both.

## Non-Goals

- Guaranteeing identical performance across providers.
- Encoding all provider-specific supplement mechanics in the core expander.
- Eliminating all legacy APIs in the same phase.

## Hard Constraints

1. FHIR semantics
- Expansion membership remains set algebra over includes/excludes.
- Paging applies to final membership, not pre-exclusion candidates.

2. Compatibility
- Existing CodeSystem providers must continue to function.
- Existing parameter semantics (`useSupplement`, `valueset-supplement`) must remain valid.

3. Correctness boundary
- If supplement filters affect membership, they must be applied consistently regardless of execution path.

## Tensions and Tradeoffs

1. Supplement representation
- Resource-centric representation (`CodeSystem` supplement resources) is interoperable but can be expensive at scale.
- Provider-native representation is efficient but provider-specific.
- A single representation may not fit all providers.

2. Ownership boundary
- Worker currently resolves supplement context.
- Providers currently own execution details.
- Unclear boundary for supplement capability discovery vs execution policy.

3. Membership vs decoration coupling
- Decoration-only supplement usage is straightforward.
- Membership-affecting supplement filters require integration with filter planning.
- Mixing both can blur where correctness guarantees are enforced.

4. Pushdown eligibility
- Supplement-aware pushdown can be fast for aligned provider/supplement backends.
- Mixed backends may require fallback handling.
- Partial pushdown creates coverage accounting complexity.

5. Filter vocabulary surface
- ValueSet filter clauses are generic (`property`, `op`, `value`).
- Providers vary in property availability and operator support.
- Supplement properties may collide with base properties or be backend-specific.

6. Capability signaling
- Current v3 capability model is coarse.
- Supplement-aware filtering/projection support is not explicitly represented.
- Missing capability granularity can force runtime failures instead of planned routing.

7. Error semantics
- Unsupported supplement filter behavior can fail early or late.
- Different timing changes user-visible outcomes and diagnostics.

8. Lifecycle and caching
- Supplement context is request-scoped.
- Provider instances may be cached by system/version/supplement set.
- Cache keying and reuse semantics become more complex with richer supplement handles.

9. Memory vs latency
- Materializing supplement data can simplify semantics but increase memory and startup latency.
- On-demand retrieval reduces memory but can amplify per-candidate cost.

10. Testability
- Need deterministic tests that exercise supplement-aware filtering and projection.
- Need parity checks across pushdown-enabled and fallback modes.
- Fixture size and realism can conflict with test runtime.

## Behavioral Questions (Open)

1. Membership semantics
- When supplement-defined properties appear in filter clauses, are they always part of membership semantics?
- How are collisions between base and supplement property codes interpreted?

2. Scope and precedence
- How are multiple supplements over the same base system composed?
- How is precedence defined for conflicting designations/properties?

3. Capability expression
- How can a provider express supplement-aware support for:
  - filtering,
  - projection,
  - membership indexes,
  - pushdown paging safety?

4. Planning and execution
- At what stage is supplement participation decided:
  - during IR planning,
  - provider selection,
  - runtime fallback?

5. Error model
- What are required vs optional supplement failure modes?
- Which failures are hard errors vs unsupported-operation signals?

6. Observability contract
- What supplement usage details must be trace-visible for debugging parity/perf issues?

7. Backward compatibility
- How long must legacy supplement paths (`CodeSystem[]`) remain first-class?
- What compatibility guarantees are required for non-sqlite providers during transition?

## Validation and Risk Areas to Cover in Test Design

1. Supplement-aware filtering correctness
- include/exclude filters involving supplement properties.
- mixed include sources with supplement constraints.

2. Pushdown/fallback parity
- identical membership under pushdown on/off for supplement-aware queries.

3. Pagination correctness
- deep offsets with supplement-aware filters and excludes.

4. Cross-provider compositions
- supplement-aware clauses alongside providers that cannot evaluate supplement filters natively.

5. Failure diagnostics
- unsupported supplement filter/operator/property behaviors produce clear, stable errors.

## Decision Log Placeholder

- (none yet)
