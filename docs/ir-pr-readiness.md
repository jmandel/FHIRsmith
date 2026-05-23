# IR PR Readiness Notes

This is the PR-facing summary for the sqlite-v0 and IR branch. It is meant to
sit next to the architecture, integration, and performance docs as the concise
review checklist.

## What This Enables

- A normalized sqlite-v0 terminology storage format for SNOMED, LOINC, RxNorm,
  and supplement sidecars.
- A sqlite-v0 `CodeSystemProvider` that supports legacy terminology worker
  compatibility and native IR execution.
- An IR algebra and execution path for ValueSet expansion, filtered membership,
  paging, counting, imports, excludes, text search, active-only behavior,
  locked-date version resolution, and supplement-aware decoration.
- Conservative routing for `$expand`, `$validate-code`, and `$lookup` through
  `_engine=ir`, with legacy defaults retained.
- A shared harness that compares sqlite-v0 IR, sqlite-v0 legacy compatibility,
  and upstream-provider legacy behavior.

## Why sqlite-v0 Exists

The legacy terminology providers are specialized in-memory or provider-specific
implementations. sqlite-v0 gives the IR compiler one normalized backend with:

- stable concept identity within a code-system scope
- typed literal and concept-valued properties
- hierarchy links and closure tables
- designation and text-search indexes
- value-set membership tables
- release-date metadata for locked-date resolution
- native supplement sidecar binding

The provider still exposes the existing async terminology API shape. SQLite
execution itself is synchronous via `better-sqlite3`; deployment can scale by
running multiple Node worker processes, each with its own SQLite connections.

## Routing And Defaults

`ValueSet/$expand` and `ValueSet/{id}/$expand` use legacy by default.
`_engine=ir` opts into IR, `_engine=legacy` forces legacy, and
`EXPAND_IR_ENGINE=1` can make expand default to IR in controlled environments.

`$validate-code` and `$lookup` remain legacy by default and only use IR when
`_engine=ir` is explicitly requested. This is intentional because their IR
coverage is real but narrower than expansion coverage.

## Current Test Gates

Use Node from `nvm`:

```bash
source ~/.nvm/nvm.sh
nvm use 25.9.0
```

Focused gates run for this branch:

```bash
npm run test:engine
npm run test:ir
npm run test:cs
V0_DB_DIR=/path/to/sqlite-v0-dbs npm run test:tx:ir-pr
```

The focused TX PR gate currently covers:

- sqlite-v0 importer behavior
- upstream parity regressions
- validate-code behavior that exercises IR/shared-provider interactions

The broad `npm run test:tx` command is still available, but it is not the
default branch gate because broad local terminology libraries can load too many
large SNOMED versions.

## Terminology Matrix

Use focused libraries for the matrix:

```bash
V0_DB_DIR=/path/to/sqlite-v0-dbs \
UPSTREAM_DB_DIR=/path/to/upstream-provider-cache \
TX_HARNESS_OUT_DIR=tmp/tx-harness-full-perf \
PERF_RUNS=1 \
npm run test:perf:terminology:full
```

Managed harness servers reject more than two SNOMED sources by default. The
PR-readiness matrix should load at most one sqlite-v0 SNOMED source and one
upstream-provider SNOMED cache per comparison run unless a narrower investigation
explicitly needs a second version.

Latest local focused matrix:

- 325 rows passed
- 0 failures
- SNOMED, LOINC, and RxNorm all exercised across sqlite-v0 IR, sqlite-v0 legacy
  compatibility, and upstream-provider legacy where supported
- no current correctness mismatches are left open in the matrix

Median local timings from that run:

| Terminology rows | Rows | All-three comparable | sqlite-v0 IR | sqlite-v0 legacy compatibility | upstream-provider legacy |
| --- | ---: | ---: | ---: | ---: | ---: |
| SNOMED-focused | 39 | 29 | 22 ms | 88 ms | 29 ms |
| LOINC-focused | 27 | 17 | 437 ms | 2687 ms | 2302 ms |
| RxNorm-focused | 14 | 11 | 83 ms | 1390 ms | 169 ms |

## Known Performance Shape

Exact totals can dominate large terminology pages. The LOINC
`STATUS=ACTIVE` high-offset row shows the clearest split:

- with exact total: page SQL about 34 ms, `countForIR` about 2040 ms
- without exact total: page SQL about 22 ms, no `countForIR`, total omitted

This is the intended behavior. Exact total is returned when requested or
required; otherwise deep pages may omit total to avoid work that does not change
membership.

Some text and compound property pages still fall back to generic
materialization. Those are correctness-preserving paths and are visible in the
trace. They are future tuning targets, not blockers.

## Current Coverage Boundary

The IR path currently tests and supports:

- explicit concepts
- include and exclude compose semantics
- imported ValueSets
- provider-supported filters
- text search
- active-only behavior and `compose.inactive=false`
- locked-date version resolution when release dates are available
- offset/count paging
- count-only and exact-total requests
- supplement-driven displays, designations, properties, and supported filters
- IR-selected expand, validate-code, and lookup workers

Not currently promised by this PR:

- every malformed or non-standard legacy compose shape
- every provider-specific filter without an IR lowering
- operations outside expand, validate-code, and lookup
- broad default routing for validate-code and lookup
- default rollout of IR for all expansion traffic

## Review Notes

Shared legacy-file edits are intentionally small and are audited in
`docs/ir-upstream-audit.md`. Incidental behavior fixes are tied to harness
parity cases or required shared contracts, not broad replay of old branch churn.

The next review pass should focus on:

- whether the sqlite-v0 schema/importer contract is acceptable as a durable
  backend format
- whether the IR lowering boundaries are named clearly enough
- whether exact-total policy matches server expectations
- whether shared worker/provider hooks are small enough for upstream acceptance
- whether any remaining performance target should become a follow-up issue
  instead of expanding this PR
