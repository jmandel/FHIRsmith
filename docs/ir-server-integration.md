# IR Server Integration

This document describes how the IR engine is exposed by the TX server and how
it coexists with existing terminology behavior.

The current integration is intentionally conservative. Legacy workers remain
the default for normal operation unless the request or environment explicitly
selects IR.

## Operation Routing

The server chooses workers in `tx/tx.js`.

| Operation | Default | Explicit IR | Explicit legacy | Environment default |
| --- | --- | --- | --- | --- |
| `ValueSet/$expand` | legacy | `_engine=ir` | `_engine=legacy` | `EXPAND_IR_ENGINE=1` |
| `ValueSet/{id}/$expand` | legacy | `_engine=ir` | `_engine=legacy` | `EXPAND_IR_ENGINE=1` |
| `ValueSet/$validate-code` | legacy | `_engine=ir` | `_engine=legacy` | none |
| `ValueSet/{id}/$validate-code` | legacy | `_engine=ir` | `_engine=legacy` | none |
| `CodeSystem/$validate-code` | legacy | `_engine=ir` | `_engine=legacy` | none |
| `CodeSystem/{id}/$validate-code` | legacy | `_engine=ir` | `_engine=legacy` | none |
| `CodeSystem/$lookup` | legacy | `_engine=ir` | `_engine=legacy` | none |
| `CodeSystem/{id}/$lookup` | legacy | `_engine=ir` | `_engine=legacy` | none |

`EXPAND_IR_ENGINE=1` affects only expansion. It is a rollout tool for
controlled expand testing, not a global terminology-engine switch.

When `_engine=ir` is explicitly requested, unsupported IR shapes fail with a
clear error. When IR is selected only by `EXPAND_IR_ENGINE=1`, expansion may
fall back to legacy for unsupported shapes.

## Request Parameters

The internal parameters are accepted as URL query parameters or FHIR
`Parameters.parameter` entries.

| Parameter | Values | Effect |
| --- | --- | --- |
| `_engine` | `ir`, `legacy` | Selects operation worker. Unknown values are ignored and normal defaults apply. |
| `_trace` | boolean-ish | Attaches structured trace output and bypasses expansion cache for traceable requests. |
| `_nocache` | boolean-ish | Bypasses expansion cache. |
| `_exactTotal` | boolean-ish | Requests exact IR totals when possible. |
| `_exact-total` | boolean-ish | Alias for `_exactTotal`. |

Example GET expand:

```text
GET /r4/ValueSet/$expand?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=50&_engine=ir&_trace=true
```

Example POST parameter:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "url", "valueUri": "http://snomed.info/sct?fhir_vs=isa/73211009" },
    { "name": "count", "valueInteger": 50 },
    { "name": "_engine", "valueCode": "ir" },
    { "name": "_trace", "valueBoolean": true }
  ]
}
```

## Trace Output

Trace output is attached only when `_trace=true`.

For `ValueSet/$expand`, trace payloads are added as expansion extensions:

- `https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/expand-trace`
- `https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/ir-plan`

For `$validate-code` and `$lookup`, trace payloads are added to the returned
`Parameters` resource as `trace` and `irPlan` parameters when applicable.

Trace is diagnostic data. Tests and harness cases use it to assert which path
ran, whether a lazy count was avoided, and whether sqlite-v0 used a fallback
after a budgeted fast path.

## Library Configuration

sqlite-v0 databases are loaded with the `sqlite-v0:` source type:

```yaml
base:
  url: https://storage.googleapis.com/tx-fhir-org

sources:
  - sqlite-v0!:${V0_DB_DIR}/sct_intl_20250201.v0.db
  - sqlite-v0!:${V0_DB_DIR}/loinc_281_full.v0.db
  - sqlite-v0:${V0_DB_DIR}/rxnorm_02022026.v0.db
  - internal:currency
  - ucum:tx/data/ucum-essence.xml
  - npm:hl7.terminology.r4#7.0.1
```

The `!` default marker has the same meaning as other loadable code-system
sources: when several versions of a system are loaded, the marked source is the
default for unversioned requests.

The test harness uses `tests/tx/fixtures/v0-test-library.yaml` as the default
sqlite-v0 local library.

## Runtime Model

The sqlite-v0 provider uses `better-sqlite3`, which executes SQLite statements
synchronously in the Node process. The surrounding terminology APIs remain
`async` because workers and providers share an async integration contract, but
SQLite itself is synchronous.

That is intentional for this branch:

- each request runs in one Node worker process
- deployment can scale with a cluster model
- each process has its own SQLite connections
- correctness does not rely on fake async behavior

If a local `better-sqlite3` build exposes `db.progressHandler`, sqlite-v0 can
install a progress callback limit. Stock `better-sqlite3` does not expose that
API, and the provider falls back cleanly.

## Supplements

IR routing reads supplements from both request parameters and value-set
extensions:

- request `useSupplement` parameters
- `http://hl7.org/fhir/StructureDefinition/valueset-supplement`

The supplement resolver builds a per-base-scope supplement set. For sqlite-v0,
configured sidecar databases can be bound natively. Other supplement sources are
materialized into supplement `CodeSystem` overlays and passed through the normal
provider decoration path.

Missing supplements fail explicitly. Ambiguous unversioned supplements are
resolved by newest-version policy when the resolver has enough metadata to do so
deterministically.

## Worker Responsibilities

`ExpandIRWorker`:

- delegates to `maybeExpandValueSetViaIR()`
- resolves base providers and supplements
- binds IR scope for expansion
- renders expansion output with normal FHIR shape

`ValidateIRWorker`:

- uses IR for filtered ValueSet membership checks
- reuses legacy validation response contracts where possible
- preserves CodeSystem validation behavior with supplement-aware providers

`LookupIRWorker`:

- uses supplement-aware provider resolution
- preserves normal `$lookup` response shape
- merges provider and supplement properties without duplicating existing
  response parameters

Workers not listed above remain legacy-only.

## Current Coverage Boundary

The IR path is intended to cover:

- `ValueSet.compose.include` and `compose.exclude`
- explicit `concept` includes
- provider-supported `filter` includes and excludes
- imported `valueSet` canonicals
- request text filters
- active-only behavior and `compose.inactive=false`
- `compose.lockedDate` when loaded providers expose release dates
- paging with `offset` and `count`
- total-only requests with `count=0`
- exact totals when `_exactTotal=true`
- supplement-driven displays, designations, properties, and supported
  supplement-backed filters
- CodeSystem and ValueSet validation paths selected with `_engine=ir`
- CodeSystem lookup paths selected with `_engine=ir`

The IR path is not currently a promise to handle every legacy operation shape.
Legacy remains the owner for:

- expansion-only ValueSets with no `compose`
- malformed or non-standard compose shapes that `canHandleValueSet()` rejects
- terminology operations other than expand, validate-code, and lookup
- provider-specific filters that have no IR lowering or adapter support
- broad default routing for validate-code and lookup

This boundary is intentional. New behavior should expand the boundary with a
test first, then routing or performance changes.

## Operational Commands

Use Node from `nvm` on this machine:

```bash
source ~/.nvm/nvm.sh
nvm use 25.9.0
```

Focused unit suites:

```bash
npm run test:engine
npm run test:ir
npm run test:cs
npm run test:tx
```

Shared TX harness:

```bash
npm run test:harness
npm run test:harness:legacy
npm run test:perf:matrix
```

Full local terminology perf matrix:

```bash
V0_DB_DIR=/path/to/sqlite-v0-dbs \
UPSTREAM_DB_DIR=/path/to/upstream-provider-cache \
TX_HARNESS_OUT_DIR=tmp/tx-harness-full-perf \
PERF_RUNS=1 \
npm run test:perf:terminology:full
```

The full matrix starts local managed servers and compares sqlite-v0 IR,
sqlite-v0 legacy compatibility, and upstream-provider legacy behavior where the
case supports all three columns.

## Rollout Guidance

Use this sequence for rollout:

1. Run focused unit suites.
2. Run the harness with `_engine=ir` and `_engine=legacy` comparison.
3. Review trace output for any slow or surprising cases.
4. Use `EXPAND_IR_ENGINE=1` only for controlled expand environments.
5. Leave validate and lookup on explicit `_engine=ir` until their harness
   coverage is broad enough for the target deployment.

The routing shape is designed so a deployment can test IR without removing the
legacy path.
