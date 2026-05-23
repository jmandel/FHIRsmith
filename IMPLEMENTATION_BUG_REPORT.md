# FHIRsmith Implementation Bug Report

Date: 2026-05-23

This report covers repo-owned bugs found while making the JSDoc/typecheck branch compile, lint, and pass tests. Static vendored jQuery is intentionally excluded.

Live repro policy: where possible, each issue includes a `curl` request against the public reference server at `https://tx.fhir.org/r4`. These live probes demonstrate the expected behavior or wire shape. Some bugs are internal harness/cache/test bugs and cannot be expressed as a FHIR request to tx.fhir.org; those entries say so explicitly.

Source links point at upstream commit `66d19ca40b1e37045f914c86034d3018991a2154`.

Diff-audit note: after the first pass, the repo-owned JavaScript diff against `upstream/main` was reviewed again with vendored/static jQuery excluded. The additional sections below cover the remaining non-comment runtime fixes found in that audit. Type-only JSDoc annotations are not listed as bugs unless they exposed or required a runtime guard.

## 1. CodeSystem validate routes were routed to the ValueSet handler

Upstream reference:
- [`tx/tx.js` CodeSystem `$validate-code`](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/tx.js#L545-L563)
- [`tx/tx.js` CodeSystem `$batch-validate-code`](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/tx.js#L565-L579)

What was found: the local converted routes accidentally called ValueSet validation handlers for CodeSystem operations. That made CodeSystem `$validate-code` tests fail even for valid CodeSystem requests.

Fix: restored `handleCodeSystem(req, res)` for CodeSystem validate and batch-validate routes.

Live tx.fhir.org repro:

```sh
curl -sS \
  -H 'Accept: application/fhir+json' \
  -H 'Content-Type: application/fhir+json' \
  --data-binary @- \
  'https://tx.fhir.org/r4/CodeSystem/$validate-code' <<'JSON'
{
  "resourceType": "Parameters",
  "parameter": [
    {"name": "url", "valueUri": "http://loinc.org"},
    {"name": "code", "valueCode": "2339-0"}
  ]
}
JSON
```

Expected reference behavior: `Parameters.parameter[name=result].valueBoolean` is `true`. The broken local route sent this CodeSystem request through the ValueSet handler and did not produce the CodeSystem validation result.

## 2. `$related` lost the null version sentinel for versioned SNOMED systems

Upstream reference:
- [`tx/workers/related.js` ValueSet lookup](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/related.js#L188-L191)
- [`tx/workers/worker.js` CodeSystem provider lookup](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/worker.js#L139-L164)

What was found: `$related` and `findCodeSystem` were collapsing an absent version to `''`. For versioned SNOMED keys such as `http://snomed.info/sct|http://snomed.info/sct/.../version/...`, that empty string became an explicit conflicting version and produced `Version inconsistent` failures.

Fix: preserve `null` for "no explicit version" in `$related` and provider lookup, while still using an empty string only where supplement lookup needs that form.

Live tx.fhir.org repro:

```sh
curl -sS \
  -H 'Accept: application/fhir+json' \
  -H 'Content-Type: application/fhir+json' \
  --data-binary @- \
  'https://tx.fhir.org/r4/ValueSet/$related' <<'JSON'
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "thisValueSet",
      "resource": {
        "resourceType": "ValueSet",
        "url": "http://example.org/ValueSet/compare-unk-1a",
        "status": "active",
        "compose": {
          "include": [{
            "system": "http://snomed.info/sct",
            "filter": [{"property": "concept", "op": "is-a", "value": "404684003"}]
          }]
        }
      }
    },
    {
      "name": "otherValueSet",
      "resource": {
        "resourceType": "ValueSet",
        "url": "http://example.org/ValueSet/compare-unk-1b",
        "status": "active",
        "compose": {
          "include": [{
            "system": "http://snomed.info/sct",
            "filter": [{"property": "concept", "op": "is-a", "value": "900000000000442005"}]
          }]
        }
      }
    },
    {"name": "diagnostics", "valueBoolean": true}
  ]
}
JSON
```

Observed reference behavior: tx.fhir.org returns a `Parameters` outcome such as `result=indeterminate` or an expansion-size diagnostic. It does not fail with a `Version inconsistent` provider error.

## 3. Package version resolution ignored the local cache after remote failures

Upstream reference:
- [`library/package-manager.js` version resolution](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/library/package-manager.js#L399-L420)

What was found: if all configured package servers failed while resolving a wildcard or unspecified version, the package manager threw even when a suitable package version already existed in the local terminology cache. This made tests depend on transient package-server availability.

Fix: after remote version lookups fail, scan the local cache for directories matching `packageId#version` and select the best cached version.

Live tx.fhir.org repro: none. This is package-cache behavior before any terminology HTTP operation starts; tx.fhir.org has no endpoint that exercises the local package-manager fallback.

Local repro idea:

```sh
# With hl7.fhir.r4.core#4.0.1 already in data/terminology-cache,
# make package servers unreachable and request hl7.fhir.r4.core with no exact version.
# Before the fix this throws "Could not resolve version"; after the fix it uses 4.0.1.
```

## 4. Terminology test runner startup and cleanup were brittle

Upstream reference:
- [`tx/tests/test-runner.js` summary used validator unconditionally](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/tests/test-runner.js#L35-L40)
- [`tx/tests/test-runner.js` cleanup used stats unconditionally](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/tests/test-runner.js#L105-L123)
- [`tx/tests/test-runner.js` fixed validator timeout](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/tests/test-runner.js#L125-L136)

What was found: cold validator startup can exceed 60 seconds, and startup failures caused cleanup/reporting to dereference `validator` or `stats` before initialization completed.

Fix: added `FHIR_VALIDATOR_STARTUP_TIMEOUT` with a safer default and made summary/cleanup null-safe.

Live tx.fhir.org repro: none. This is a local Jest/validator lifecycle bug, not a terminology operation.

## 5. Display diagnostics used `displayLanguage` as the OperationOutcome language

Upstream reference:
- [`tx/workers/validate.js` display message translation](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/validate.js#L1431-L1436)

What was found: one display-check path translated diagnostic text with `workingLanguages()`. That includes `displayLanguage`, which should constrain display matching, not localize the OperationOutcome message. The public response should stay in the HTTP response language unless `Accept-Language` asks otherwise.

Fix: use `HTTPLanguages` for OperationOutcome/Parameters diagnostic message translation in that path.

Live tx.fhir.org repro:

```sh
curl -sS \
  -H 'Accept: application/fhir+json' \
  -H 'Content-Type: application/fhir+json' \
  --data-binary @- \
  'https://tx.fhir.org/r4/ValueSet/$validate-code' <<'JSON'
{
  "resourceType": "Parameters",
  "parameter": [
    {"name": "url", "valueUri": "http://hl7.org/fhir/ValueSet/administrative-gender"},
    {
      "name": "coding",
      "valueCoding": {
        "system": "http://hl7.org/fhir/administrative-gender",
        "code": "male",
        "display": "XCode1"
      }
    },
    {"name": "displayLanguage", "valueCode": "de"}
  ]
}
JSON
```

Observed reference behavior: the response message is English, for example `Wrong Display Name 'XCode1' ... Valid display is 'Male' (for the language(s) 'de')`. The display language appears in the diagnostic content, but it does not localize the message itself.

## 6. Reverse `$translate` emitted the wrong match-part shape

Upstream reference:
- [`tx/workers/translate.js` reverse group translation](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/translate.js#L406-L481)
- [`tx/workers/translate.js` reverse dispatch](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/translate.js#L566-L579)

What was found: reverse translation produced match parts in the wrong shape for the validator tests, and added `originMap` in cases where the expected response did not include it.

Fix: normalize reverse output to the expected source/concept relationship shape and remove the unintended reverse `originMap`.

Live tx.fhir.org repro:

```sh
curl -sS \
  -H 'Accept: application/fhir+json' \
  -H 'Content-Type: application/fhir+json' \
  --data-binary @- \
  'https://tx.fhir.org/r4/ConceptMap/$translate' <<'JSON'
{
  "resourceType": "Parameters",
  "parameter": [
    {"name": "url", "valueUri": "http://hl7.org/fhir/ConceptMap/cm-administrative-gender-v3"},
    {"name": "sourceSystem", "valueUri": "http://hl7.org/fhir/administrative-gender"},
    {"name": "targetSystem", "valueUri": "http://terminology.hl7.org/CodeSystem/v3-AdministrativeGender"},
    {"name": "targetCode", "valueCode": "M"}
  ]
}
JSON
```

Observed reference behavior: the `match.part` array describes the source-side code and target-side concept, for example `source` is `male`, `concept` is `M`, and R4 reports `equivalence=equal`. There is no unrelated reverse `originMap` part in this explicit ConceptMap call.

## 7. `ValueSetChecker` used methods on the wrong receiver

Upstream reference:
- [`tx/workers/validate.js` logging in `determineSystemFromExpansion`](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/validate.js#L126-L129)
- [`tx/workers/validate.js` provider/source and canonical handling](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/validate.js#L470-L486)
- [`tx/workers/validate.js` version listing](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/validate.js#L584-L587)

What was found: `ValueSetChecker` called `this.log`, `this.canonical`, `this.listVersions`, `this.FLanguages`, and `this.seeSourceProvider` even though those members live on the worker. These were latent runtime failures on validation error paths.

Fix: route those calls through `this.worker` and use the worker's language helpers.

Live tx.fhir.org repro:

```sh
curl -sS \
  -H 'Accept: application/fhir+json' \
  -H 'Content-Type: application/fhir+json' \
  --data-binary @- \
  'https://tx.fhir.org/r4/CodeSystem/$validate-code' <<'JSON'
{
  "resourceType": "Parameters",
  "parameter": [
    {"name": "coding", "valueCoding": {"code": "OBG"}}
  ]
}
JSON
```

Observed reference behavior: tx.fhir.org returns a normal `Parameters` response with `result=false` and a warning such as `Coding has no system...`. A terminology validation error path should produce a FHIR diagnostic response, not throw a JavaScript receiver error. Not every wrong-receiver path has a compact public tx.fhir.org repro; several require local test-package resources.

## 8. Inactive-code state did not consistently carry a path

Upstream reference:
- [`tx/workers/validate.js` inactive holder in `checkSimple`](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/validate.js#L428-L440)
- [`tx/workers/validate.js` inactive holder in `checkSystemCode`](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/validate.js#L1468-L1485)

What was found: some inactive-status holders were initialized as `{value: false}` while later code read both `value` and `path`. That could produce incomplete diagnostics for inactive/deprecated code validation.

Fix: initialize inactive holders with a stable shape, including `path`.

Live tx.fhir.org repro: no compact one identified. This requires a specific inactive-code validation path and is primarily covered by the local terminology validation suite.

## 9. SNOMED provider tests swallowed filter/search failures

Upstream reference:
- [`tests/cs/cs-snomed.test.js` swallowed filter/search failures](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tests/cs/cs-snomed.test.js#L800-L890)

What was found: the SNOMED tests wrapped filter and search assertions in `try/catch` blocks that only logged failures. They also called provider APIs with the wrong filter operator and argument shape. The suite passed while printing failed filter/search diagnostics.

Fix: remove the swallowing `try/catch`, use the provider's actual filter API (`op='='`, correct `filter()` argument order, and `{filter: text}` for text search), and assert active expected search results.

Live tx.fhir.org repro: none. This is a local test correctness bug, not a public FHIR operation.

## 10. Current branch had recursive `errorMessage` helpers

Current branch reference:
- `packages/packages.js:26`
- `xig/xig.js:37`

What was found: while auditing the branch diff, two new helper functions used `return error instanceof Error ? errorMessage(error) : String(error)`. Any normal `Error` object would recurse until stack overflow, exactly on the error paths these helpers were meant to make safer.

Underlying cause: the JSDoc hardening pass copied the error-normalization helper but accidentally called the helper recursively instead of reading `error.message`.

Fix: change both helpers to `return error instanceof Error ? error.message : String(error)`. A repo-wide `rg` check confirmed no remaining `return error instanceof Error ? errorMessage(` pattern outside vendored/static jQuery.

Live tx.fhir.org repro: none. These modules serve package/XIG HTML and package registry support routes, not the public terminology endpoint. Validation was local via `node --check packages/packages.js`, `node --check xig/xig.js`, and the repo-wide recursive-helper search.

## 11. SNOMED expression and ECL edge cases threw raw JavaScript errors

Upstream reference:
- [`tx/sct/expressions.js` incomplete refinement assumptions](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/sct/expressions.js#L136-L162)
- [`tx/sct/expressions.js` refinement merge assumes names exist](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/sct/expressions.js#L1089-L1097)
- [`tx/sct/expressions.js` refinement validation assumes value exists](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/sct/expressions.js#L1625-L1630)
- [`tx/sct/ecl.js` EOF token and error handling](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/sct/ecl.js#L373-L438)
- [`tx/sct/ecl.js` parse result assumes `error.message`](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/sct/ecl.js#L795-L815)

What was found: malformed or partial SNOMED expression/ECL inputs could reach paths where refinements had no `name` or `value`, EOF tokens lacked a stable `value`, or a catch block assumed the thrown value was an `Error`. Those cases produced JavaScript `TypeError`s or incomplete parse diagnostics instead of controlled terminology errors.

Underlying cause: the parser and expression model were written assuming successful full construction. The validation and canonicalization paths then reused those objects without guarding partially constructed states.

Fix: add null checks for incomplete refinement objects, stable EOF token shape, `String(error)` fallback for non-Error throws, and safer descendant/filter matching around missing SNOMED references.

Live tx.fhir.org repro: no compact public repro identified. These paths require specific malformed ECL/expression internals and local SNOMED provider state. Public `ValueSet/$expand` and `$validate-code` calls exercise the area, but the narrow crash state is better covered by the local SNOMED ECL/provider tests. The SNOMED test shards were kept serialized so no process loaded more than two SNOMED versions.

## 12. UCUM parser/converter edge cases could crash instead of reporting invalid units

Upstream reference:
- [`tx/library/ucum-parsers.js` numeric token handling](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/library/ucum-parsers.js#L174-L180)
- [`tx/library/ucum-parsers.js` parser fallback and symbol lookup](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/library/ucum-parsers.js#L240-L275)
- [`tx/library/ucum-parsers.js` regex search logger assumption](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/library/ucum-parsers.js#L762-L770)
- [`tx/library/ucum-parsers.js` special-unit expansion assumptions](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/library/ucum-parsers.js#L866-L900)
- [`tx/library/ucum-parsers.js` validator missing unit values](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/library/ucum-parsers.js#L940-L984)
- [`tx/library/ucum-types.js` Decimal equality and Fahrenheit fallback](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/library/ucum-types.js#L263-L265)

What was found: UCUM error paths could dereference a missing lexer token, return `null` from an impossible parser branch, compose a symbol with no unit, expand a special unit with no handler, compare a Decimal against a null conversion result, or call `this.log.error` before a logger existed.

Underlying cause: the Java port assumed model invariants that TypeScript/JSDoc checking showed were not guaranteed for invalid input, incomplete XML essence rows, or optional special-unit handlers.

Fix: throw `UcumException` for missing numeric/unit values, default parser symbols safely, install a default logger, guard special-unit handlers and unit values, make `Decimal.equals(null)` return false, and keep Fahrenheit conversion returning a `Decimal` fallback instead of null.

Live tx.fhir.org repro: no compact public repro identified. The public server exposes UCUM through terminology operations, but these failures are lower-level parser/model states. They are covered by the local UCUM test shard and `node --check` validation.

## 13. Service lifecycle helpers assumed optional collaborators were always present

Upstream reference:
- [`stats.js` metrics before initialization](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/stats.js#L20-L72)
- [`tx/vs/vs-vsac.js` stats reporter assumption](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/vs/vs-vsac.js#L25-L31)
- [`library/html-server.js` logger/template/error assumptions](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/library/html-server.js#L14-L18)
- [`library/html-server.js` optional template variables](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/library/html-server.js#L72-L83)
- [`utilities/dev-proxy-server.js` request/response normalization](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/utilities/dev-proxy-server.js#L35-L48)

What was found: support services could crash when called before full initialization or when Node supplied optional values. Examples included stats recording before `markStarted`, VSAC created without a stats object, HTML rendering before `useLog`, missing template variables passed to `escape`, proxy chunks that were strings, and optional request/status fields.

Underlying cause: constructors left collaborators undefined and several utility functions treated optional Node/Express properties as required.

Fix: initialize stable defaults (`console`, no-op stats, null event-loop monitor), guard event-loop monitor reset, coerce optional header/status/body values, and render missing template fields as empty strings.

Live tx.fhir.org repro: none. These are local lifecycle and support-service paths, not public terminology operations. They were validated through diff review, syntax checks, and the existing lint/typecheck gates.

## 14. Package/resource indexing assumed complete metadata

Upstream reference:
- [`npmprojector/indexer.js` indexing resources/search params](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/npmprojector/indexer.js#L24-L93)
- [`npmprojector/indexer.js` search intersection and lookup](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/npmprojector/indexer.js#L190-L235)
- [`library/package-manager.js` CI/package fetch helpers](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/library/package-manager.js#L47-L93)
- [`library/package-manager.js` package index loading](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/library/package-manager.js#L700-L745)

What was found: package/indexing code assumed every resource had `resourceType`, every search parameter had an expression, every map lookup returned a map, every package index was loaded before use, and every CI build record had package/url fields. Missing metadata could turn a recoverable "skip or not found" condition into a JavaScript exception.

Underlying cause: local package and FHIR index data is heterogeneous, but the indexing code used non-null map/index/package members without enforcing those invariants at module boundaries.

Fix: skip resources without a type, default missing FHIRPath expressions, guard index/search map lookups, perform set intersection without spread assumptions, add `requireIndex()` and `requirePackage()` checks, and return `null` rather than undefined for incomplete CI build metadata.

Live tx.fhir.org repro: none. These paths run before or beside public terminology operations, using local package cache and npm projector data.

## 15. CodeSystem providers had null context and closed-database failure modes

Upstream reference:
- [`tx/cs/cs-loinc.js` status methods used the original input as context](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/cs/cs-loinc.js#L315-L330)
- [`tx/cs/cs-loinc.js` database access assumes open DB](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/cs/cs-loinc.js#L447-L518)
- [`tx/cs/cs-areacode.js` context conversion](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/cs/cs-areacode.js#L138-L155)
- [`tx/cs/cs-country.js` context conversion](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/cs/cs-country.js#L517-L526)
- [`tx/cs/cs-ndc.js` constructor and database assumptions](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/cs/cs-ndc.js#L22-L30)
- [`tx/cs/cs-rxnorm.js` concept constructor and null contexts](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/cs/cs-rxnorm.js#L9-L15)

What was found: several CodeSystem providers accepted a string or context object but later continued using the original argument after resolving it. Others returned the original falsey input instead of `null`, threw strings instead of `Error`s, assumed lookup-table maps existed, or queried a database connection after close.

Underlying cause: provider APIs expose nullable and polymorphic "context" arguments, but implementations were written as though every caller passed a resolved context object and all factory-loaded database state was present.

Fix: normalize empty context to `null`, throw `Error` instances with fallback messages, add `#requireDb()` guards, default lookup maps/counts, make RxNorm displays default to `''`, and avoid emitting properties/designations with missing values.

Live tx.fhir.org repro: no compact public repro identified. Public `CodeSystem/$lookup` and `$validate-code` exercise these providers for common inputs, but the audited bugs require closed DBs, missing lookup-table state, or null context transitions best reproduced in local provider tests.

## 16. XML/Parameters and batch worker error paths assumed complete FHIR objects

Upstream reference:
- [`tx/library/parameters.js` constructor did not guarantee `parameter` exists](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/library/parameters.js#L1-L20)
- [`tx/xml/parameters-xml.js` parsed resource assignment](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/xml/parameters-xml.js#L1-L80)
- [`tx/xml/xml-base.js` quantity value context and FHIR version guard](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/xml/xml-base.js#L1-L120)
- [`tx/workers/batch.js` error response assumptions](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/batch.js#L1-L80)
- [`tx/workers/batch-validate.js` batch validation error assumptions](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/tx/workers/batch-validate.js#L1-L80)

What was found: constructing `Parameters` from sparse JSON could leave `parameter` undefined, XML parsing could attach a null parsed resource, quantity XML handling could compare an undefined FHIR version/context, and batch workers assumed caught values carried `statusCode`, `issueCode`, and `message`.

Underlying cause: FHIR wire objects are often partial during parsing, conversion, and error handling. The affected modules handled the happy path object shape but not partially converted resources or non-Error throws.

Fix: ensure `Parameters.parameter` is always an array, attach parsed XML resources only when present, guard undefined FHIR version/context values, and normalize batch errors before building OperationOutcome or bundle entries.

Live tx.fhir.org repro: no compact public repro identified. These are malformed/XML/batch error-path states; the public JSON curl probes above validate expected FHIR response shape for the externally reachable worker paths.

## 17. Broad web/importer error handling assumed all thrown values were `Error`s

Upstream reference:
- [`packages/package-crawler.js` feed and fetch errors](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/packages/package-crawler.js#L88-L126)
- [`packages/package-crawler.js` item/package extraction errors](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/packages/package-crawler.js#L360-L407)
- [`library/i18nsupport.js` translation load and phrase helpers](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/library/i18nsupport.js#L39-L61)
- [`library/languages.js` optional language definitions and parse messages](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/library/languages.js#L353-L394)
- [`vcl/vcl-parser.js` parse exception wrapping](https://github.com/HealthIntersections/FHIRsmith/blob/66d19ca40b1e37045f914c86034d3018991a2154/vcl/vcl-parser.js#L1-L80)

What was found: many web, package, registry, publisher, importer, SHL, VCL, and utility paths logged or rethrew `error.message` directly. If a dependency threw a string, null, or library-specific object, the diagnostic itself became misleading or crashed. The audit also found two translation phrase wrappers with argument order reversed.

Underlying cause: JavaScript allows arbitrary thrown values, and several modules were written as if caught values were always native `Error` instances. The translation phrase bug was a wrapper/signature mismatch exposed during the same type pass.

Fix: introduce `errorMessage()` or equivalent guards, preserve stacks only when available, pass phrase arguments in the documented order, and keep module-level HTML/JSON error responses from crashing while reporting the original failure.

Live tx.fhir.org repro: none. These are mostly admin UI, importer, background crawler, registry, and VCL routes rather than public terminology operations. The validation for this class is code review plus lint/typecheck and targeted syntax checks of the touched modules.

## Validation gates after fixes

Because the machine was memory constrained and swap was full, tests were run in fresh serialized shards so no process loaded more than the requested two SNOMED versions.

- `npm run typecheck`: passed
- `npm run lint`: passed
- `git diff --check`: passed
- `git diff upstream/main -- '*.js' ':!static/js/jquery*.js'`: reviewed for repo-owned non-comment runtime changes
- `rg "return error instanceof Error \\? errorMessage\\(" --glob '*.js' --glob '!static/js/jquery*.js'`: no recursive helper matches
- `node --check packages/packages.js`: passed
- `node --check xig/xig.js`: passed
- `npx jest tests/tx/test-cases.test.js --runInBand`: 1649 passed
- Non-SNOMED/non-generated terminology shard: 55 suites passed, 3 expected skipped
- `npx jest tests/cs/cs-snomed.test.js --runInBand`: 39 passed
- `npx jest tests/cs/cs-snomed-ecl.test.js --runInBand`: 72 passed
