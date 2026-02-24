# Expand v3 Unified Capability Negotiation: Implementation Checklist

## Objective
Replace split capability discovery (`capabilitiesV3()` + per-clause supplement interrogation) with one adapter-scoped negotiation report created once per `(system, version, request supplement context)` and consumed everywhere in expand-v3 routing.

## Design Constraints
- Single source of truth per adapter: `adapter.report`.
- Registry constructs adapter and triggers negotiation; engine consults report only.
- Provider pulls supplement-native handles itself from `SupplementContext`.
- Legacy providers remain functional via conservative adapter-built fallback report.
- No pushdown behavior regressions: when uncertain, route to fallback.

## Report Contract (target)
- Core execution:
  - `query: boolean`
  - `membership: boolean`
  - `decorateMany: boolean`
  - `supportsTextFilter: boolean`
  - `supportsSetOps: boolean`
  - `supportsPagination: boolean`
- Ordering/paging:
  - `ordering: { stable: boolean, kind: string }`
  - `pagination: boolean` (provider-native pagination safety for this request)
- Legacy pipeline:
  - `legacyFilter: { filterPipeline: boolean, supportsSearchFilter: boolean, supportsFilterPage: boolean }`
- Supplements:
  - `supplements: {
      handles: 'none'|'partial'|'full',
      filtering: 'none'|'native',
      properties: Set<string>,
      operators: Set<string>,
      unsupported: Set<string>,
      attachments: any
    }`

## Phase 1: Adapter Negotiation Foundation
1. Add `adapter.report` and `adapter.negotiate(...)`.
2. Add `adapter._buildLegacyReport(...)` using prototype-comparison (not `typeof` checks).
3. Add `adapter._normalizeReport(...)` to enforce defaults and coerce arrays to sets.
4. Make `capabilitiesV3()` and `capabilitiesLegacyFilter()` return data from `adapter.report`.
5. Keep method-level behavior unchanged except where report now drives decisions.

Acceptance:
- Adapter always has a usable report even when provider has no `negotiate` method.
- Existing call sites can keep calling capability accessors.

## Phase 2: Registry Wiring and Cache Keying
1. In `EngineRegistryV3.getAdapter(...)`, include supplement canonical fingerprint in adapter cache key.
2. Build adapter, then `await adapter.negotiate({ system, version, supplements, params, mode })`.
3. Keep supplement resolution in registry; remove provider-specific prefetch assumptions.
4. Keep supplement usage accounting (`usedSupplements`) from resolved context canonicals.

Acceptance:
- Negotiation happens once per cached adapter.
- Different supplement sets produce different cached adapters.

## Phase 3: Engine and Adapter Routing via Report
1. Replace direct provider capability probing in adapter paths with `adapter.report`.
2. Route legacy filter usage only when `report.legacyFilter.filterPipeline`.
3. Gate query/membership pushdown by report booleans and query shape:
   - text requires `supportsTextFilter`
   - set ops require `supportsSetOps`
4. Keep supplement-native gating centralized:
   - native-only when `report.supplements.filtering === 'native'`.

Acceptance:
- No `instanceof`-based family inference remains in expand-v3 adapter paths.
- Pushdown gates are explicit and auditable.

## Phase 4: Supplement Clause Classification via Negotiated Report
1. In `_splitFilterClausesForProvider(...)`, classification order:
   - provider base clause support (`doesFilter === true`)
   - negotiated supplement-native support (`report.supplements.properties/operators`)
   - engine fallback `supplementCtx.preparePredicate(...)`
2. Keep unsupported-clause errors explicit.

Acceptance:
- No per-clause provider negotiation calls.
- Same classification behavior is reused for selector streaming and membership index routes.

## Phase 5: Provider Implementations (start with sqlite-v0)
1. Add `async negotiate({ system, version, supplements, params, mode })` to sqlite-v0 provider.
2. Inside provider negotiation:
   - pull native handle via `supplements.native(...)`.
   - compute supplement-native coverage (`handles/properties/operators/unsupported/attachments`).
   - return integrated report with request-sensitive pagination decision.
3. Keep v3 execution hooks (`openStream`, `prepareMembership`, `decorateMany`) unchanged functionally.

Acceptance:
- sqlite-v0 report reflects actual supplement context (native vs none).
- negotiation can be async without changing engine logic.

## Phase 6: Remove Transitional Surfaces
1. Stop relying on `cs.capabilitiesV3()` inside expand-v3 routing.
2. Keep provider capability methods only as compatibility fallback (if needed outside expand-v3).
3. Document deprecation path: provider-level `capabilitiesV3()` eventually replaced by `negotiate()` in expand-v3 usage.

Acceptance:
- expand-v3 capability/routing reads only `adapter.report`.

## Phase 7: Observability
1. Add trace payload per adapter:
   - system/version/mode
   - negotiated report summary
2. Add counters:
   - `negotiation.count`
   - `supplement.native_supported_clauses`
   - `supplement.fallback_predicates`

Acceptance:
- Trace makes pushdown/fallback decisions explainable from one report object.

## Phase 8: Correctness Test Additions
1. Supplement clause classification parity tests:
   - native supported clause
   - fallback predicate clause
   - unsupported clause error
2. Pushdown-on/off parity tests for same value set where report allows/disallows native filtering.
3. Pagination safety tests where `report.pagination=false` forces worker paging.

Acceptance:
- behavior parity holds; negotiation only changes routing, not semantics.

## Phase 9: Performance Validation
1. Benchmark with supplements absent vs present.
2. Benchmark native supplement filtering vs engine fallback predicate batches.
3. Verify no per-clause capability round-trips at runtime.

Acceptance:
- No regression in baseline no-supplement runs.
- native supplement path shows reduced fallback predicate overhead.

## Out of Scope for This Pass
- Full supplement-native SQL filtering implementation for all providers.
- Global removal of legacy filter pipeline from non-v3 providers.
- Final serialization contract for report in API responses.

## Immediate Execution Plan
1. Implement Phases 1–5 in code now.
2. Leave tests/perf runs for explicit follow-up command.
