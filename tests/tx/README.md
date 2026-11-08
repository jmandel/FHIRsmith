# TX Module Tests

Integration tests for the TX (Terminology) Module.

## Prerequisites

```bash
npm install --save-dev jest supertest
```

## Running Tests

```bash
# Run all TX tests
npx jest tests/tx

# Run specific test file
npx jest tests/tx/lookup.test.js

# Run with verbose output
npx jest tests/tx --verbose

# Run with coverage
npx jest tests/tx --coverage
```

## Test Files

- **setup.js** - Test configuration and Express app setup
- **tx-module.test.js** - Basic module initialization, metadata, CORS, request IDs
- **read.test.js** - `GET /CodeSystem/{id}` and `GET /ValueSet/{id}` operations
- **search.test.js** - Search operations with pagination, filtering, sorting
- **lookup.test.js** - `$lookup` operation with various parameter formats

## Test Data

Tests use the R5 core package which is automatically loaded when calling `cloneWithFhirVersion('5')`. This provides standard FHIR code systems and value sets like:

- `http://hl7.org/fhir/administrative-gender` (CodeSystem and ValueSet)
- `http://hl7.org/fhir/publication-status`
- And many others from the R5 specification

## Test Structure

Each test file follows this pattern:

```javascript
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

describe('Worker Name', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000); // 60s timeout for initialization

  afterAll(async () => {
    await shutdownTestApp();
  });

  // Tests...
});
```

The `getTestApp()` function returns a shared Express app instance, so initialization only happens once across all test files when run together.

## Timeout Configuration

Library initialization can take time, so tests use a 60-second timeout in `beforeAll`. You may need to adjust Jest's default timeout:

```javascript
// In jest.config.js or package.json
{
  "testTimeout": 60000
}
```

## Notes

- Tests make actual HTTP requests to the Express app using supertest
- No mocking of the provider layer - uses real R5 core data
- Tests verify both success cases and error handling
- Request IDs are validated to ensure logging infrastructure works

## Engine runs

A branch with the sqlite-v2 engine still serves SNOMED CT, LOINC and RxNorm from main's classic
providers when its library lists them that way (`snomed:` `.cache` files, `loinc:`, `rxnorm:`).
The default `tests/tx/test-cases.test.js` run uses `tx/fixtures/test-cases.yml`, which is classic,
so on an engine branch it tests the engine's content store (packages) and nothing of its SNOMED CT
or LOINC. Run the suite with a named engine instead:

```bash
test-scripts/test-cases-engine.sh --engine classic|v2|both --seed <dir with the terminology files>
```

| engine | setup | SNOMED CT | LOINC | content store |
|---|---|---|---|---|
| `classic` | `tx/fixtures/test-cases-setup-classic.json` | `Snomed_Intl_20260701.cache`, `sct_test_20250909i.cache` | `Loinc_2.83b.db` | off |
| `v2` | `tx/fixtures/test-cases-setup-v2.json` (`test-cases-v2.yml`) | `sct-intl-20260701.db`, `sct-test-20250909-nl.db` | `loinc-2.83.db` | on |

`both` runs classic, then v2, and writes `COMPARE.md` (tests failing with one engine only). Each
run's folder has the jest log, the summary (which now names the engine), the TestReport, and
`test-cases-engine.json`: the provider class and file that served each system. The suite loads no
RxNorm, so neither run tests the engine's RxNorm.

**The check.** Every server start logs one line, e.g.
`Engines: v2 | SNOMED CT v2 x2 | LOINC v2 x1 | RxNorm none | content store VS on, CS on`, and each
code system row of the load table ends with its provider class (`[SnomedV2Factory]`,
`[SnomedServicesFactory]`, ...). With `FHIRSMITH_ENGINE=v2` (or `modules.tx.expectEngine`) the
server stops at the first SNOMED CT, LOINC or RxNorm file served by a classic provider, and also
when the content store is off; with `classic` it stops on any sqlite-v2 file or the content store
on. `FHIRSMITH_ENGINE_ALLOW_CLASSIC=loinc-2.77-a.db` names classic files a v2 run may keep (the
demo has no v2 build of LOINC 2.77). See `tx/engine-report.js` and `tests/tx/engine-report.test.js`.
