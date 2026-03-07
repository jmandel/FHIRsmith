# IR Review Follow-up Checklist

Working checklist for the project-level review items that remain after the
sqlite-v0 compiler and supplement runtime work.

## 1. Explicit IR Runtime Error Propagation

Goal: supplement/runtime/provider failures in the IR path must fail closed and
survive with their specific meaning. Legacy fallback should happen only for
true IR handleability misses, not because a runtime error was swallowed.

### Tests

- [x] Add `_engine=ir` request-level test for ambiguous supplement canonical.
  Expected: specific `422` supplement ambiguity error, no legacy fallback.
- [x] Add `_engine=ir-strict` request-level test for the same ambiguity case.
  Expected: same specific `422`, not generic “IR cannot handle this ValueSet”.
- [x] Add request-level test for native supplement attachment/materialization
  failure.
  Expected: explicit failure survives; it is not relabeled as “no IR support”.

### Implementation

- [x] Narrow the blanket catch in [tx/workers/expand.js](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js)
  around IR provider resolution.
- [x] Distinguish:
  - handleability miss -> may return `null` and permit legacy fallback
  - runtime/provider/supplement failure -> must throw
- [x] Preserve explicit `Issue` objects through both normal IR mode and
  `_engine=ir-strict`.
- [x] Keep legacy fallback behavior unchanged for genuine unsupported-shape
  cases.

### Documentation

- [x] Update [docs/ir-engine.md](/home/jmandel/hobby/FHIRsmith-ir-engine/docs/ir-engine.md)
  with the explicit fail-closed boundary.
- [x] Update [docs/supplement-architecture.md](/home/jmandel/hobby/FHIRsmith-ir-engine/docs/supplement-architecture.md)
  to state that supplement/runtime failures are not downgraded to “IR miss”.

## 2. Collapse Duplicated Generic Supplement Executor Logic

Goal: avoid maintaining a second set/paging/hierarchy executor in
[tx/supplements/ir-provider.js](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/supplements/ir-provider.js).
The supplement path should reuse one shared generic IR executor story.

### Characterization Tests

- [x] Add parity tests around the current supplement generic path for:
  - union
  - intersect
  - diff
  - count
  - paging
  - hierarchy carry-through
  - text filtering
- [x] Add an explicit unsupported overlay-backed operator test
  (for example `is-a` / `descendent-of` on an overlay-backed property).
  Expected near-term behavior: fail closed, not silent drift.

### Refactor

- [x] Extract a shared generic IR executor core from
  [tx/engine/legacy-ir-adapter.js](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/engine/legacy-ir-adapter.js).
- [x] Give the shared executor pluggable selector hooks:
  - selector execution
  - selector membership
- [x] Rewrite
  [tx/supplements/ir-provider.js](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/supplements/ir-provider.js)
  so it only owns supplement-specific responsibilities:
  - clause partitioning
  - merged base+overlay property lookup
  - supplement-aware text matching
- [x] Remove duplicated set-op / paging / hierarchy execution logic from the
  supplement wrapper.

### Post-refactor Verification

- [x] Prove parity between the old supplement wrapper behavior and the new
  shared-executor path on the characterization corpus.
- [x] Keep unsupported overlay-backed operators explicit and documented.

### Documentation

- [x] Update [docs/supplement-architecture.md](/home/jmandel/hobby/FHIRsmith-ir-engine/docs/supplement-architecture.md)
  so it describes one shared generic executor story, not two.
- [x] Update [docs/sqlite-v0-execution-compiler.md](/home/jmandel/hobby/FHIRsmith-ir-engine/docs/sqlite-v0-execution-compiler.md)
  if the generic fallback boundary changes.

## Order

- [x] Finish item 1 first.
- [x] Start item 2 only after item 1 is green and documented.
