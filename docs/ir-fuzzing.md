# IR Fuzzing And Direct Oracle Guide

This guide documents the property/fuzz testing workflow for the IR engine.
It is intentionally detailed and operational; `docs/ir-engine.md` stays
high-level and approachable.

## Purpose

The fuzz suite (`tests/engine/valueset-semantics-fuzz.test.js`) generates
random nested/importing ValueSet corpora and validates behavior across:

1. compile (`buildIRFromValueSet`)
2. import resolution (`resolveImports`)
3. rewrite/lowering (`optimize`)
4. partitioning (`collectSystems`, `projectToSystem`, safety checks)
5. execution (`expandViaIR`)

## Run Commands

```bash
# Default mode (fast): partition safety + IR consistency + end-to-end totals/membership
npm test -- tests/engine/valueset-semantics-fuzz.test.js

# More seeds
IR_FUZZ_SEEDS=1000 npm test -- tests/engine/valueset-semantics-fuzz.test.js

# Single-seed repro
IR_FUZZ_SEED_ONLY=326 npm test -- tests/engine/valueset-semantics-fuzz.test.js

# Strict direct-oracle mode (independent compose evaluator)
IR_FUZZ_STRICT_DIRECT=1 npm test -- tests/engine/valueset-semantics-fuzz.test.js

# Deep strict run
IR_FUZZ_SEEDS=1000 IR_FUZZ_STRICT_DIRECT=1 npm test -- tests/engine/valueset-semantics-fuzz.test.js
```

## What Each Mode Proves

1. Default mode (`IR_FUZZ_STRICT_DIRECT` unset):
   - each optimized IR is partition-safe,
   - partition theorem holds:
     `eval(E) == union(eval(projectToSystem(E,s)))`,
   - `optimize()` preserves resolved-IR semantics,
   - `expandViaIR` totals + full membership match IR-evaluator semantics.

2. Strict direct-oracle mode (`IR_FUZZ_STRICT_DIRECT=1`):
   - all default guarantees, plus
   - resolved IR semantics must match an independent direct evaluator for
     compose/include/exclude/import/filter semantics.

## Direct Oracle Scope

The direct oracle covers the fuzz subset:

1. include/exclude set algebra
2. concept enumerations
3. filter ops used in fuzz:
   - `concept is-a`
   - `concept descendent-of`
   - `kind =`
   - `code regex`
4. nested imports, including system+valueSet conjunctive semantics
5. request-level checks for `activeOnly` and text filter on end-to-end comparison

Not covered here:

1. every FHIR filter property/operator
2. all version-resolution edge cases
3. non-membership output semantics (designation/property/displayLanguage formatting)

## Failure Interpretation

- `expected partition-safe IR but got ...`
  - partition-safety rejection; runtime should fail-closed to legacy.
- `partitioned union mismatch`
  - partitioning/projection/lowering bug.
- `optimized IR semantics mismatch vs resolved IR`
  - rewrite/lowering bug.
- `resolved IR semantics mismatch vs direct evaluator`
  - either compiler semantic bug or oracle semantic bug; requires triage.
- `total mismatch` or `full membership mismatch`
  - execution/orchestration bug (counting/filtering/pagination/adapter behavior).

## Generator Limits (Current)

1. corpus size per seed: 5-10 ValueSets
2. max import-chain depth by construction: 9 (acyclic generator)
3. resolver guards:
   - `maxDepth` (import-chain depth)
   - `maxNodes` (visited-node budget)

## Recent Notes

1. Legacy adapter now enforces lowered `selector.intersectCodes` constraints.
2. Strict direct-oracle import semantics were corrected for system-scoped
   components with multiple `valueSet` imports:
   - correct behavior is conjunctive intersection across imports, not union.
