# IR Compilation Tester

This page is the operator guide for validating IR compilation behavior
(lowering, rewrite, partition safety, and execution parity).

## 1) Quick correctness checks

Run the key engine tests:

```bash
npm test -- tests/engine/partition-safety.test.js tests/engine/valueset-semantics-fuzz.test.js --runInBand
```

What it covers:
- rewrite and partition-safety guards
- known regression seeds
- end-to-end request-level checks on synthetic corpora

## 2) Fuzzing (strict mode)

Strict direct-oracle mode compares:
- direct semantic evaluator
- resolved IR
- optimized IR
- partitioned subtree union
- end-to-end `expandViaIR()`

```bash
IR_FUZZ_SEEDS=2000 IR_FUZZ_STRICT_DIRECT=1 npm test -- tests/engine/valueset-semantics-fuzz.test.js
```

For longer runs:

```bash
IR_FUZZ_SEEDS=600000 IR_FUZZ_STRICT_DIRECT=1 npm test -- tests/engine/valueset-semantics-fuzz.test.js
IR_FUZZ_SEEDS=1000000 IR_FUZZ_STRICT_DIRECT=1 npm test -- tests/engine/valueset-semantics-fuzz.test.js
```

## 3) Harness parity + perf

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

## 4) Rewrite-only sanity checks

```bash
node scripts/ir-rewrite-tests.mjs
```

This is the fastest loop for rewrite simplification semantics without
starting the HTTP server.

## 5) Failure triage

- `partition-safe` failures: unresolved imports, missing system, or mixed bucket leakage
- `resolved vs optimized` mismatch: rewrite bug
- `optimized vs partitioned union` mismatch: projection/partition bug
- `expandViaIR` mismatch only: execution-path bug (provider/adapter/orchestrator)

For detailed triage process and semantics notes, see `docs/ir-fuzzing.md`.
