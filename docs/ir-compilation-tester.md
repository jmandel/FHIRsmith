# IR Compilation Tester

## Problem Statement

The IR compiler is only useful if it preserves ValueSet semantics while
lowering into partitioned `(system, version)` subtrees.

This guide answers one operational question:

Can we demonstrate, with repeatable tests, that compile -> resolve -> optimize
-> partition -> execute stays semantically correct, and fails closed when it
cannot be proven safe?

For an interactive browser view of compile output, use
`tools/expand-explorer-lite.html` on the published docs site.

## Quick Start

Run the core compile/parity checks:

```bash
npm test -- tests/engine/partition-safety.test.js tests/engine/valueset-semantics-fuzz.test.js --runInBand
```

This covers:
- rewrite and partition-safety guards
- known regression seeds
- end-to-end request-level checks on synthetic corpora

## Fuzzing And Direct Oracle

The fuzz suite (`tests/engine/valueset-semantics-fuzz.test.js`) generates
random nested/importing ValueSet corpora and validates behavior across:

1. compile (`buildIRFromValueSet`)
2. import resolution (`resolveImports`)
3. rewrite/lowering (`optimize`)
4. partitioning (`collectSystems`, `projectToSystem`, safety checks)
5. execution (`expandViaIR`)

Run commands:

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

Strict direct-oracle mode compares:
- direct semantic evaluator
- resolved IR
- optimized IR
- partitioned subtree union
- end-to-end `expandViaIR()`

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

## Harness Parity And Perf

Run live HTTP harness checks:

```bash
scripts/run-ir-harness.sh --all --db-dir /home/jmandel/hobby/sct/cache --out-dir tmp/ir-harness-runs/manual-all
```

Run perf matrix output:

```bash
scripts/run-ir-harness.sh \
  --perf \
  --db-dir /home/jmandel/hobby/sct/cache \
  --out-dir tmp/ir-harness-runs/manual-perf \
  --perf-out tmp/ir-harness-runs/manual-perf/perf-table.html
```

## Rewrite-Only Sanity Check

```bash
node scripts/ir-rewrite-tests.mjs
```

This is the fastest loop for rewrite simplification semantics without
starting the HTTP server.

## Failure Triage

- `partition-safe` failures: unresolved imports, missing system, or mixed bucket leakage
- `resolved vs optimized` mismatch: rewrite/lowering bug
- `optimized vs partitioned union` mismatch: projection/partition bug
- `resolved IR semantics mismatch vs direct evaluator`: compiler semantic bug or oracle semantic bug
- `total mismatch` or `full membership mismatch`: execution/orchestration bug (counting/filtering/pagination/adapter behavior)

## Generator Limits (Current)

1. corpus size per seed: 5-10 ValueSets
2. max import-chain depth by construction: 9 (acyclic generator)
3. resolver guards:
   - `maxDepth` (import-chain depth)
   - `maxNodes` (visited-node budget)
