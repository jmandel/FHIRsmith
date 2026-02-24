# expand-v3 supplements implementation checklist

Status: proposed and execution-ready.

## 1) Spec lock and invariants

- Finalize supplement semantics doc:
  - scope resolution (params + ValueSet extension)
  - decoration precedence (display, designation, property)
  - when supplements affect membership
  - supported predicate ops in phase 1 (`=`, `in`, `exists`)
  - deterministic supplement ordering
- Lock invariants:
  - pushdown/fallback parity for membership
  - paging after final membership and dedupe
  - `total` only when exact

## 2) Interfaces and capability surface

- Add request-scoped supplement interface (`SupplementContext`):
  - `canonicals()`
  - `markResolved(url)`
  - `markUsed(url, why)`
  - `preparePredicate({ system, version, clause })`
  - `native({ providerId, system, version })`
  - `close()`
- Extend `capabilitiesV3()` with supplement support:
  - `supplements.decoration`
  - `supplements.filtering`
  - `supplements.filterableProperties`
  - `supplements.filterableOps`
- Keep legacy providers working without capability changes.

## 3) Worker responsibilities

- Implement `resolveSupplementContext(requiredCanonicals, { system, version, providerHint, params })`.
- Resolver loads from:
  - additional resources (`CodeSystem` supplements)
  - optional native backends (sqlite, future)
- Add cache keyed by:
  - required canonical set
  - `(system, version)`
  - provider/backend kind
- Preserve existing `loadSupplements(...)` for compatibility.

## 4) Supplement context implementations

- `ResourceSupplementContext`:
  - lazy indexes for concept properties
  - `preparePredicate` batch matcher for `=`, `in`, `exists`
- `SqliteSupplementContext`:
  - `native({ providerId: 'sqlite' })` handles
  - optional SQL-backed `preparePredicate`
- `CompositeSupplementContext`:
  - deterministic order
  - merged `native(...)`
  - first-available or combined predicate strategy

## 5) Engine wiring

- `EngineRegistryV3`:
  - request supplement context per adapter acquisition
  - pass supplement context into `CsEngineAdapter`
  - keep required/used supplement tracking surfaced to expander
- `CsEngineAdapter`:
  - split filter clauses:
    - provider-evaluable clauses
    - supplement-predicate clauses
    - unsupported clauses (422)
  - enumerate via provider, then batch-AND supplement predicates
  - plumb supplement context into v3 provider hook option objects

## 6) Membership index integration

- In membership index build:
  - if provider membership index exists, AND it with supplement predicate indexes
  - preserve batch `batchHas` API
  - close all index resources in `finally`

## 7) Pushdown strategy

- Allow native supplement pushdown only when provider advertises support.
- If not fully covered by provider:
  - enforce supplement predicates in engine fallback layer
- Never change membership semantics based on optimization path.

## 8) Decoration strategy

- Keep provider-owned supplement decoration as baseline.
- Pass supplement context to `decorateMany(...)`.
- Continue legacy resource supplements for providers not using native backends.
- Dedupe designation/property rows in renderer boundary if needed.

## 9) Error model

- Missing required supplement:
  - `VALUESET_SUPPLEMENT_MISSING` (422)
- Unsupported supplement filter clause:
  - unsupported filter error with property/op/value details
- Provider misdeclared capability:
  - fallback to engine predicates when possible; otherwise explicit failure

## 10) Observability

- Trace:
  - requested/resolved/used supplement canonicals
  - filtering mode (`native` vs `engine`)
- Counters:
  - predicates prepared
  - predicate batch calls
  - codes checked
  - native supplement pushdown usage
- Output:
  - `expansion.parameter` entries for used supplements

## 11) Compatibility and migration

- Keep existing provider constructors/signatures valid.
- Add supplement context as additive plumbing first.
- Enable engine-side supplement predicates before native sqlite pushdown.
- Promote native support per provider only after parity tests pass.

## 12) Test plan

- Unit:
  - predicate correctness by op
  - clause splitter behavior
  - index composition (AND)
  - precedence/collision behavior
- Integration:
  - supplement filter parity pushdown on/off
  - include/exclude/intersect with supplements
  - mixed providers and deep paging
- Performance:
  - no per-candidate supplement scans on large sets
  - batch checks only

## 13) Rollout phases

- Phase A:
  - interfaces, worker resolver, engine fallback predicate support
- Phase B:
  - sqlite native supplement filtering pushdown
- Phase C:
  - expand ops/property support and optimize caching
- Phase D:
  - tighten capability assertions and remove fallback workarounds where safe

