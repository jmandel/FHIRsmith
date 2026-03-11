# Testing Guide

This branch has three distinct test layers. They serve different purposes and should be run differently.

## 1. Fast Jest suites

Use these for day-to-day development. They cover:

- engine semantics
- IR-engine-specific runtime and request-flow coverage
- sqlite-v0 compiler behavior
- provider contracts
- targeted worker/runtime behavior

Typical commands:

```bash
npm run test:engine
npm run test:ir
npm run test:cs
npm run test:tx

# or target a specific file/batch when you are iterating
npm test -- tests/ir-engine/operations/expand-ir-typed-properties.test.js --runInBand
```

Notes:

- Jest is currently serialized in [`jest.config.js`](../jest.config.js), so many small invocations cost more wall-clock than one batched invocation.
- Prefer batching related suites into one command instead of running `npm test -- <single-file>` repeatedly.

Example batched command for supplement/runtime integration work:

```bash
npm test -- \
  tests/ir-engine/operations/expand-sqlite-supplement-config.test.js \
  tests/ir-engine/operations/lookup-sqlite-supplement-config.test.js \
  tests/ir-engine/operations/validate-sqlite-supplement-config.test.js \
  tests/ir-engine/operations/expand-adapter-supplement-runtime.test.js \
  tests/ir-engine/operations/expand-ir-error-propagation.test.js \
  tests/ir-engine/operations/expand-ir-typed-properties.test.js \
  tests/ir-engine/operations/expand-ir-compose-overrides.test.js \
  tests/ir-engine/operations/validate-ir-runtime.test.js \
  --runInBand
```

## 2. HTTP integration suites under `tests/tx/` and `tests/ir-engine/operations/`

These tests start a temporary TX app and send real HTTP requests through the worker layer.

They are appropriate when the thing being tested is:

- request parsing
- operation routing
- supplement resolution/attachment
- end-to-end response shaping

They are **not** the right place for every provider/compiler assertion. If the behavior can be checked directly against a provider or engine module, prefer `tests/cs/` or `tests/engine/`.

### Shared app fixture pattern

For new HTTP integration suites, do not start and stop a TX app per test unless isolation is the thing being tested.

Use the shared helper in [`tests/support/tx-integration-fixtures.js`](../tests/support/tx-integration-fixtures.js):

```js
const {
  createManagedTxFixture,
  destroyManagedTxFixture,
} = require('../support/tx-integration-fixtures');

describe('...', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await createManagedTxFixture({
      prefix: 'tx-example-',
      setup: async ({ dir }) => {
        const configPath = path.join(dir, 'library.yaml');
        // write temp DBs, sidecars, config, etc
        return { configPath };
      },
    });
  });

  afterAll(async () => {
    await destroyManagedTxFixture(fixture);
  });

  test('...', async () => {
    const res = await request(fixture.app)
      .post('/tx/r5/ValueSet/$expand')
      .send(...);
    expect(res.status).toBe(200);
  });
});
```

Why:

- TX module startup is the main fixed cost in these suites
- sharing one app per file keeps coverage the same while cutting wall-clock noticeably
- `buildTempV0DbFile(..., { dir })` lets the managed fixture own the whole temp tree for cleanup

## 3. Unified HTTP harness and perf matrix

The broad request matrix and the 3-column performance comparison are **not** part of the Jest refactor. They stay in the harness.

Main entry points:

- [`scripts/tx-harness.mjs`](../scripts/tx-harness.mjs)

Common commands:

```bash
# unified local matrix (expand + validate + lookup rows)
npm run test:harness

# legacy-default matrix
npm run test:harness:legacy

# one-shot managed harness: start server(s), run matrix cases, collect artifacts
node scripts/tx-harness.mjs --ir --db-dir /home/jmandel/hobby/sct/cache

# default perf matrix: 2 columns, 1 repeat, synthetic supplement sidecars enabled
npm run test:perf:matrix

# 3-column perf matrix (adds upstream providers column)
npm run test:perf:matrix:3col
```

The harness auto-selects free local ports for the primary and optional third
server. You do not need to pass `--port` or `--third-port` unless you want to
prefer a specific starting port.

The harness keeps a persistent package cache under `tmp/tx-harness-cache/` by
default, so repeated runs do not need to cold-fetch terminology packages unless
you point `--cache-root` somewhere else.

Useful perf tuning flags:

```bash
# focus on a subset
node scripts/tx-harness.mjs --perf --db-dir /home/jmandel/hobby/sct/cache --filter "supplement|diabetes"

# disable generated sqlite supplement sidecars if you only want the base corpus
node scripts/tx-harness.mjs --perf --db-dir /home/jmandel/hobby/sct/cache --without-synthetic-supplements
```

Important:

- The 3-column HTML matrix and per-row detail pages remain the broad benchmark/parity layer.
- The harness now uses one matrix runner and one output format for:
  - `$expand`
  - `$validate-code`
  - `$lookup`
- Reorganizing Jest suites should not change harness coverage.
- Perf mode now avoids a second debug request for rows that already have a captured perf sample.
- The third column is opt-in and uses a shorter timeout budget than the primary/local columns.

The unified harness covers `$expand`, `$lookup`, and `$validate-code`
through one shared matrix runner. Prefer checking the current harness
artifacts or the case files when you need the live row inventory.

Legacy expectations inside the shared harness are parity-driven:

- inline supplement cases are enabled for legacy only when current
  `tx.fhir.org` supports them
- configured sqlite supplement cases remain IR-only unless there is real
  legacy support to compare against

See also:

- [tx-harness-plan.md](tx-harness-plan.md) — unified harness coverage plan for `$expand`, `$validate-code`, and `$lookup`
- [tx-review-workflow.md](tx-review-workflow.md) — fresh harness run -> analysis batch -> external agent review workflow

## Choosing the right layer

Use this rule of thumb:

- `tests/engine/`: shared engine semantics and long-running semantic/model checks
- `tests/ir-engine/core/`: branch-specific IR runtime and execution seams
- `tests/ir-engine/supplements/`: new supplement runtime unit/integration coverage
- `tests/ir-engine/operations/`: request-level IR operation flows (`$expand`, `$validate-code`, `$lookup`)
- `tests/cs/`: provider contracts, sqlite-v0 planner/compiler behavior
- `tests/tx/`: HTTP worker integration and request/response behavior
- harness/perf: broad expand corpus, matrix comparison, traces, and performance artifacts

If a test only needs a provider object or direct function call, keep it out of `tests/tx/`.

## When to rerun perf

Do a full perf rerun when changes affect:

- sqlite-v0 planning or SQL emission
- orchestrator paging/count/materialization behavior
- harness inputs or perf rendering

Do **not** default to a full perf rerun for changes isolated to:

- docs
- validate-only behavior
- lookup-only behavior
- pure test refactors
