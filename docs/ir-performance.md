# IR Performance And Verification

This document describes how to reason about IR performance, how to reproduce
the current perf matrix, and which optimizations are considered acceptable for
the sqlite-v0 runtime.

## Performance Model

IR performance is determined by four things:

1. The semantic shape of the ValueSet.
2. The terminal operation requested: page, count, or membership probe.
3. The provider backend: native sqlite-v0 or adapter-backed legacy provider.
4. Response requirements such as exact totals, designations, properties, text
   search, and supplements.

The sqlite-v0 native path is optimized for provider-scoped set operations. It
is not simply "run the legacy expander against SQLite." The compiler chooses a
strategy for each terminal operation and emits SQL for that strategy.

## Exact Totals

Exact totals are often the dominant cost for large terminology queries.

IR distinguishes these cases:

- `count=0`: total-only request, so a count is required.
- multi-system expansion: per-system counts are needed to page correctly across
  systems.
- `_exactTotal=true`: exact total requested.
- first or small pages: total may be inferred or lazily counted when useful.
- deep pages without exact total: total may be omitted to avoid expensive lazy
  counts.

The request parameters `_exactTotal` and `_exact-total` opt into exact-total
behavior. Without that request, IR may still return a total if it is already
known, cheap, or safely inferred from the page, but it should not do expensive
work solely to decorate a deep page.

Unclosed expansions omit total. This keeps IR aligned with project policy for
providers such as UCUM where the expansion is intentionally not closed.

## Budgeted Early-Stop Materialization

The sqlite-v0 compiler has an early-stop materialization strategy for small
pages ordered by code. It is useful for cases like "give me 50 rows at a later
offset without exact total."

For offset pages, early stop is guarded by the registered SQLite scalar
function `SQLITE_V0_BUDGET(...)` (`sqlite_v0_budget` at registration time).
The function increments a per-connection counter while SQLite materializes the
candidate stream. If the configured row budget is exceeded, it throws a known
budget error.

That error is not returned to the client. The provider catches it, records a
trace note, recompiles with generic materialization, and reruns the query.

This is safe because:

- the fast path either completes and returns the same ordered page, or
- it returns no partial result and falls back to the generic path
- no cardinality estimate is used as a correctness signal
- fallback is the same semantic path used when early stop is disabled

Early stop is gated by plan shape:

- materialize terminal only
- no exact total
- one `ORDER BY code ASC`
- positive `count`, currently limited to small pages
- supported membership shape
- offset pages require `runtime.planner.enableEarlyStopBudgetFunction`

## Query Progress Guard

sqlite-v0 also detects an optional `better-sqlite3` progress-handler API. This
supports local builds that can interrupt runaway SQLite statements after a
number of progress callbacks.

Configuration is by environment or provider options:

- `FHIRSMITH_SQLITE_MAX_PROGRESS_CALLBACKS`
- `FHIRSMITH_SQLITE_PROGRESS_INTERVAL`

Stock `better-sqlite3` does not currently expose this API. In that case the
runtime records that progress limiting is unsupported and continues normally.

## Optimization Policy

Acceptable optimizations are strict improvements only:

- They must preserve exact membership semantics.
- They must be covered by unit tests or harness cases.
- They must either be shape-gated or fall back to a generic path.
- They must not rely on table statistics or estimated match counts.
- They must be traceable when they affect query strategy.

A broad native literal count shortcut was intentionally not kept. Local timing
showed it was not a strict improvement:

| Count shape | Direct count median | Generic count median | Result |
| --- | ---: | ---: | --- |
| LOINC `STATUS=ACTIVE` | about 332 ms | about 367 ms | direct sometimes helped |
| LOINC `CLASSTYPE=1` | about 277 ms | about 245 ms | direct was slower |

Because the shortcut was shape-broad and not consistently faster, it was backed
out rather than added as another planner branch.

## Reproducing Perf Runs

Use the full terminology matrix when comparing native sqlite-v0 IR, sqlite-v0
legacy compatibility, and upstream-provider legacy behavior:

```bash
source ~/.nvm/nvm.sh
nvm use 25.9.0

V0_DB_DIR=/path/to/sqlite-v0-dbs \
UPSTREAM_DB_DIR=/path/to/upstream-provider-cache \
TX_HARNESS_OUT_DIR=tmp/tx-harness-full-perf \
PERF_RUNS=1 \
npm run test:perf:terminology:full
```

Focused examples:

```bash
TX_HARNESS_OUT_DIR=tmp/tx-harness-loinc-no-exact \
V0_DB_DIR=/path/to/sqlite-v0-dbs \
UPSTREAM_DB_DIR=/path/to/upstream-provider-cache \
PERF_RUNS=1 \
npm run test:perf:terminology:full -- \
  --filter "LOINC STATUS=ACTIVE high offset without exact total" \
  --filter "LOINC CLASSTYPE=1 later page without exact total" \
  --filter "LOINC text creatinine later page without exact total"
```

Harness output is written under `tmp/` by default. The perf report links each
row to input JSON, response JSON, trace payloads, and server logs.

## Current Matrix Snapshot

A focused PR-readiness terminology matrix was run with one sqlite-v0 SNOMED
database, one sqlite-v0 LOINC database, one sqlite-v0 RxNorm database, and the
corresponding upstream-provider legacy caches where available.

Command shape:

```bash
source ~/.nvm/nvm.sh
nvm use 25.9.0

V0_DB_DIR=/path/to/sqlite-v0-dbs \
UPSTREAM_DB_DIR=/path/to/upstream-provider-cache \
TX_HARNESS_OUT_DIR=tmp/tx-harness-full-perf \
PERF_RUNS=1 \
npm run test:perf:terminology:full
```

Result: 325 harness rows passed, with zero failures. The matrix compared:

- sqlite-v0 IR worker
- sqlite-v0 legacy compatibility worker
- upstream-provider legacy worker, where the provider column supported the case

Median timings from that local run:

| Terminology rows | Rows | All-three comparable | sqlite-v0 IR | sqlite-v0 legacy compatibility | upstream-provider legacy |
| --- | ---: | ---: | ---: | ---: | ---: |
| SNOMED-focused | 39 | 29 | 22 ms | 88 ms | 29 ms |
| LOINC-focused | 27 | 17 | 437 ms | 2687 ms | 2302 ms |
| RxNorm-focused | 14 | 11 | 83 ms | 1390 ms | 169 ms |

Exact/count-heavy and no-exact-total subsets should be read separately:

| Terminology rows | Subset | Rows | sqlite-v0 IR | sqlite-v0 legacy compatibility | upstream-provider legacy |
| --- | --- | ---: | ---: | ---: | ---: |
| SNOMED-focused | exact/count-like | 3 | 109 ms | 2016 ms | 515 ms |
| SNOMED-focused | no exact total | 2 | 281 ms | 1173 ms | 3407 ms |
| LOINC-focused | exact/count-like | 4 | 539 ms | 3746 ms | 2302 ms |
| LOINC-focused | no exact total | 4 | 154 ms | 2082 ms | 2829 ms |
| RxNorm-focused | no exact total | 1 | 302 ms | 3912 ms | - |

These are local-machine measurements with `PERF_RUNS=1`. They are useful as
regression sentinels and outlier guides, not as service-level commitments.

Selected rows from the same run:

| Case | sqlite-v0 IR | sqlite-v0 legacy compatibility | upstream-provider legacy | Trace reading |
| --- | ---: | ---: | ---: | --- |
| LOINC `STATUS=ACTIVE` high offset with exact total | 2093 ms | 5570 ms | - | Page SQL was about 34 ms; `countForIR` was about 2040 ms. |
| LOINC `STATUS=ACTIVE` high offset without exact total | 51 ms | 6965 ms | - | Page SQL was about 22 ms; total was omitted and no `countForIR` ran. |
| LOINC `CLASSTYPE=1` later page without exact total | 20 ms | 2082 ms | 2843 ms | Early-stop completed; total was omitted. |
| LOINC text `creatinine` later page without exact total | 257 ms | 1864 ms | 2815 ms | Early-stop budget tripped and fell back; no count ran. |
| Deep LOINC text filter with exact total | 1433 ms | - | - | Generic page query plus about 679 ms `countForIR`. |
| LOINC active quantitative later page without exact total | 807 ms | - | - | No count ran; remaining cost is the generic intersect/order/page query. |
| SNOMED diagnosis search `pain` first 50 | 542 ms | 1472 ms | 2788 ms | Early-stop fell back; lazy count was about 214 ms. |
| RxNorm text aspirin plus `TTY=IN` | 108 ms | 1576 ms | 264 ms | Native IR text/property filtering. |

## Focused Spike Results

The no-exact-total LOINC focused run after the early-stop work showed:

| Case | sqlite-v0 IR | sqlite-v0 legacy compatibility |
| --- | ---: | ---: |
| `STATUS=ACTIVE` high offset without exact total | about 43 ms | about 5031 ms |
| `CLASSTYPE=1` later page without exact total | about 80 ms | about 4360 ms |
| text `creatinine` later page without exact total | about 473 ms | about 2893 ms |

The text case can still fall back from early stop to generic materialization.
The trace should show that fallback explicitly, and it should still avoid
`countForIR` when exact total was not requested.

These values are local-machine measurements, not contractual limits. Use them
as regression sentinels and trend indicators.

The terminology perf matrix is intentionally scoped to focused libraries. The
managed harness rejects more than two SNOMED sources per server by default;
do not use broad local caches that load every available SNOMED version for
PR-readiness runs.

## Reading Traces

When `_trace=true`, useful trace markers include:

- `orchestrate`: high-level IR options, including `exactTotal` and
  `omitLazyTotal`.
- `executeIR:compiler`: selected membership, terminal, physical, and SQL plans.
- `pagination`: offset/count behavior and system count.
- `countForIR` or `countForIR:lazy`: an exact or lazy count was performed.
- `total:omitted`: IR intentionally omitted total for a best-effort deep page.
- sqlite SQL events: SQL text, parameters, row count, and elapsed time.
- early-stop budget notes: fast path attempted, completed, or fell back.

Perf investigation should start from traces, then move to the SQL plan. Avoid
guessing from total wall-clock time alone because server startup, package load,
cache state, response rendering, and count behavior can dominate different
cases.

## Correctness And Perf Together

Perf changes must be tested against correctness:

- unit tests for strategy selection and SQL AST output
- provider tests comparing `executeIR()`, `countForIR()`, and
  `membershipForIR()`
- harness cases comparing native IR, sqlite-v0 legacy compatibility, and
  upstream-provider legacy behavior
- targeted no-exact-total cases to show the optimization effect without hiding
  an exact-count regression

The full PR should include enough matrix output to answer both questions:

- Did IR return the same terminology answer?
- Did the new execution path improve, preserve, or explain performance?
