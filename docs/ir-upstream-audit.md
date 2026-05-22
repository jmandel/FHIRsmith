# IR Upstream Reapply Audit

This audit records how the old `origin/ir-engine` work was reapplied on top of
the current upstream mainline. The branch stack is deliberately split so each
phase can be reviewed independently.

## Branch Stack

| Branch | Commit | Scope |
| --- | --- | --- |
| `sqlite-v0-schema-importers` | `8f060fa` | v0 schema plus SNOMED, LOINC, and RxNorm importers |
| `sqlite-v0-provider` | `4ac949c` | sqlite-v0 CodeSystem provider, runtime helpers, native supplement sidecars |
| `ir-core` | `f005c99` | IR algebra, rewrites, planning, sqlite-v0 compiler, supplement resolver |
| `ir-routing` | `a79cbec` | `_engine` routing for `$expand`, `$validate-code`, and `$lookup` |
| `ir-harness-and-docs` | pending | shared TX harness, parity tests, and audit docs |

## Port Decisions

| Area | Decision | Evidence |
| --- | --- | --- |
| v0 SQLite schema/importers | Rewritten and ported. The current schema is `PRAGMA user_version=1`, carries `release_date` and typed property source metadata, and imports SNOMED, LOINC, and RxNorm through `tx/importers/tx-import.js`. | `tests/tx/sqlite-v0-importers.test.js`; generated official smoke DBs for LOINC 2.81, RxNorm 02022026, and SNOMED US 20230301. |
| sqlite-v0 provider | Rewritten and ported. Provider exposes lookup, iteration, hierarchy, filters, native IR execution, native sqlite supplement binding, and optional progress-handler support. | `tests/cs/cs-sqlite-v0-provider.test.js`; `tests/cs/sqlite-v0-runtime.test.js`; sqlite-v0 compiler/provider tests. |
| better-sqlite3 max-iteration fork | Ported as an optional runtime capability. If a local `better-sqlite3` build exposes `db.progressHandler`, sqlite-v0 installs a query step guard; stock `better-sqlite3` falls back cleanly. | `tx/cs/sqlite-v0-runtime.js`; `tests/cs/sqlite-v0-runtime.test.js`. |
| CodeSystem API surface | Ported only the shared API needed by v0 and IR: `releaseDate()`, `parents()`, and sqlite supplement source registration. | `tx/cs/cs-api.js`; provider and operation tests. |
| FHIR CodeSystem provider | Ported the safe multi-parent lookup behavior and stronger name fallback. | `tx/cs/cs-cs.js`; lookup and provider tests. |
| IR algebra/rewrite/execution | Rewritten and ported. The current implementation keeps IR construction, normalization, rewrite, scope binding, counting, paging, SQL lowering, and debug formatting under `tx/engine` and `tx/cs/sqlite-v0-*`. | `tests/engine`; `tests/ir-engine/core`; `tests/cs/sqlite-v0-*.test.js`. |
| IR operation routing | Ported with conservative defaults. `$expand` can opt into IR with `_engine=ir` or `EXPAND_IR_ENGINE=1`; `$validate-code` and `$lookup` use IR only when `_engine=ir` is requested. | `tx/workers/engine-selection.js`; `tx/workers/expand-ir.js`; `tx/workers/validate-ir.js`; `tx/workers/lookup-ir.js`; operation tests. |
| Supplements | Ported and tightened. Inline supplements, configured sqlite sidecars, native binding, typed property decoration, designation decoration, ambiguity handling, and missing-supplement errors are covered. | `tx/supplements/*`; `tests/ir-engine/supplements`; operation tests. |
| Trace/debug output | Ported. `_trace` attaches structured trace payloads and optional IR plan text without changing normal responses. | `tx/engine/expand-trace.js`; `tx/workers/ir-worker-trace.js`; harness cases. |
| Shared TX harness | Ported into this follow-on branch. The harness covers `$expand`, `$validate-code`, and `$lookup`, can run local IR/legacy matrices, and can optionally collect perf artifacts. | `scripts/tx-harness.mjs`; `scripts/tx-harness-runner.mjs`; `scripts/tx-harness-cases/*`; `docs/tx-harness-plan.md`. |

## Intentionally Not Ported

| Old IR branch item | Reason |
| --- | --- |
| Generated `docs/perf/*` outputs | Historical generated artifacts are not source. The new harness can regenerate current artifacts under ignored `tmp/`. |
| Docs-site build pipeline | It is unrelated to v0/IR correctness and was not needed to reapply the terminology stack. |
| Package-manager cache preference | Useful but orthogonal to v0 import/provider/IR routing. It should be handled as a separate offline-test hardening change if still desired. |
| Broad legacy provider fixes not required by this stack | Currency, LOINC, RxNorm, SNOMED, and search-worker changes from the old branch were not blindly replayed. Only behavior needed by the current v0/IR work was ported or rewritten. |

## Verification Snapshot

The following gates passed before the harness/doc follow-on branch:

- importer command/unit coverage for the v0 schema and importers
- sqlite-v0 provider/runtime coverage
- IR core, rewrite, execution, and sqlite-v0 compiler coverage
- supplement resolver/native sidecar coverage
- IR operation routing coverage for expand, validate, and lookup
- combined targeted regression suite: 63 suites, 305 tests

Official imported smoke databases were generated and inspected on disk:

| DB | Concepts | Properties | Closure rows |
| --- | ---: | ---: | ---: |
| LOINC 2.81 | 248,426 | 49 | 0 |
| RxNorm 02022026 | 227,845 | 43 | 0 |
| SNOMED US 20230301 | 508,540 | 138 | 7,549,806 |
