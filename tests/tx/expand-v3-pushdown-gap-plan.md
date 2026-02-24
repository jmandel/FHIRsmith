# Expand v3 Pushdown Gap Plan and Checklist

## Scope

This checklist enumerates expression shapes where:
- full-root provider pushdown should be possible but is currently missing, or
- single-provider pushdown is structurally impossible and worker reconciliation is expected.

For each case we add/maintain harness coverage, assert current behavior, and capture timing.

## Case Matrix

### A. Same-system, pushdown-eligible with lowering

1. `Intersect(Selector, Import(Union(Selector, Selector)))` on one system
- Example: LOINC `COMPONENT regex` intersect imported LOINC union (`STATUS=ACTIVE` union `CLASS=CHEM`)
- Expected today: single provider query after lowering
- Harness: `v3-lowering: import-intersect-with-union compiles to single provider pushdown`
- Perf characterization: compare lowering enabled vs disabled (spans + ms)

2. `Diff(Selector, Union(Selector, Selector))` on one system
- Example: LOINC `COMPONENT regex` minus (`STATUS=ACTIVE` union `CLASS=CHEM`)
- Expected today: single provider query after lowering + full-root queryIR path
- Harness: `v3-lowering: include minus union-excludes uses single provider query`
- Perf characterization: compare lowering enabled vs disabled (spans + ms)

### B. Same-system, still unresolved lowering gaps

3. `Diff(Selector, Import(Diff(Selector, Selector)))`
- Example: exclude via imported ValueSet with its own include/exclude
- Expected today: single provider query after `A \ (B \ C)` lowering
- Harness: `v3-lowering: include minus imported diff lowers to single provider query`
- Perf characterization: compare lowering enabled vs disabled (spans + ms)
- Note: unlowered path is not treated as semantic oracle for this case.

### C. External pressure / non-reconcilable partitions

4. Mixed-system import in intersect/union context
- Example: include LOINC selector with import whose compose includes both LOINC and UCUM
- Expected today: no single-provider full-root pushdown; worker must reconcile
- Harness: `v3-gap: mixed-system import pressure prevents single-provider root pushdown`
- Perf characterization: capture spans + ms

### D. Additional cases already covered by existing harness

5. Same-system deep page parity, pushdown on/off
- Harness: `v3-invariant: same-system import+filter deep page matches with pushdown on/off`
- Purpose: optimization must not change membership/page keys

6. Mixed import+peer include/exclude pagination reconstruction
- Harness: `logic: mixed import+peer include/exclude paginates without gaps or duplicates`
- Purpose: worker reconciliation safety across providers

7. High-count mixed import+system page fill behavior
- Harness: `pagination-safety: mixed import+system high-count page is not silently capped`
- Purpose: no silent truncation under mixed-provider plans

8. Complex same-system include/exclude deep pages
- Harness: `high-value: complex same-system include/exclude pages are internally consistent per mode`
- Purpose: adjacent-page stability with and without pushdown

## Implementation Checklist

1. Add env-gated lowering controls
- [x] `EXPAND_V3_DISABLE_QUERYIR_LOWERING=1` disables compiler lowerings
- [x] `EXPAND_V3_DISABLE_FULL_ROOT_PUSHDOWN=1` disables full-root queryIR fast path

2. Keep lowered and unlowered execution comparable
- [x] Harness tests run both modes for cases A1/A2 and assert membership parity
- [x] Harness reports spans + ms for both modes

3. Preserve correctness invariants
- [x] Lowered vs unlowered parity asserted for A1/A2
- [x] Gap tests assert expected split behavior without claiming parity regressions

4. Characterize performance
- [x] A1/A2 return structured timing (lowered vs unlowered)
- [x] B/C return timing and span counts

5. Next lowering candidates
- [ ] Lower `A \\ (B \\ C)` into `(A \\ B) ∪ (A ∩ C)` where same-system-safe
- [ ] Generalized n-ary normal-form pass for nested `except/intersect/union` trees
- [ ] Keep provider queryIR translator contract strict (no semantic drops)

## How to run this slice

```bash
EXPAND_IMPL=v3 EXPAND_TRACE=1 EXPAND_TRACE_FORMAT=summary \
  node tests/tx/expand-harness.js "v3-lowering|v3-gap"
```

This executes only the case-matrix tests and prints timing plus trace summaries for failures.

## Latest local measurements (this workspace)

- `v3-lowering: import-intersect-with-union...`
  - lowered: ~231ms, `v0.expandQuery` spans=1
  - unlowered (env-gated): ~457ms, `v0.expandQuery` spans=2
- `v3-lowering: include minus union-excludes...`
  - lowered: ~162ms, `v0.expandQuery` spans=1
  - unlowered (env-gated): ~417ms, `v0.expandQuery` spans=2
- `v3-gap: imported exclude with nested diff...`
  - lowered: ~195ms, spans=1
  - unlowered: ~396ms, spans=2
- `v3-gap: mixed-system import pressure...`
  - current: ~187ms, systems=`USPS + LOINC`, sqlite spans=1 (plus non-sqlite provider path)
