# Unified TX Harness Plan

This note defines the unified matrix-harness goals for the terminology
operations we are actively changing on the IR branch:

- `$expand`
- `$validate-code`
- `$lookup`

The goal is one harness, one case model, and one output surface. The
discipline stays the same:

- broad request-shape coverage
- explicit edge-case coverage
- parity checks where they are useful
- captured-request replay for regressions
- clear separation between provider/unit tests and HTTP integration

## Why this matters

Recent IR and supplement work touched shared runtime seams below
multiple operations:

- provider resolution
- supplement resolution and attachment
- typed property handling
- canonical/version parsing
- worker response shaping

`$expand` already had the strongest matrix coverage. The other
operations now need to live in the same harness so we do not keep
separate runners, duplicated infrastructure, or divergent case models.

## Priority operations in the shared harness

### 1. `$validate-code`

Highest priority after `$expand`.

Why:

- many parameter shapes
- easy to regress success vs error shaping
- shared supplement/runtime logic now applies here
- often used as a semantic truth check for terminology support

### 2. `$lookup`

Second priority.

Why:

- shares code-system resolution and supplement seams
- exposes typed properties, designations, and display normalization
- easy to regress response structure even when membership logic is fine

We are not expanding the active harness to cover unrelated legacy-only or
unchanged operations just for uniformity. If another operation later gets
its own IR-dispatched/runtime-specific behavior, it should be added to the
same harness framework at that time.

## Cross-cutting dimensions to test

These dimensions matter across multiple operations and should be used to
build a real matrix of cases, not a bag of one-off tests.

### Request form

- `GET` query parameters vs `POST Parameters`
- `code` + `system`
- `Coding`
- `CodeableConcept`
- inline `ValueSet`
- canonical `url`
- canonical with `|version`
- explicit `systemVersion` / `valueSetVersion` where relevant

### Resource source

- preloaded package resource
- provider-backed implicit resource
- inline `tx-resource`
- configured sqlite-v0 source
- adapter-backed non-sqlite provider

### Supplement mode

- no supplements
- inline supplement `CodeSystem`
- configured sqlite supplement sidecar
- missing supplement
- ambiguous supplement canonical

### Provider class

- sqlite-v0 native provider
- adapter-backed provider
- cs-cs / package-backed code system provider
- grammar-backed provider where the operation is valid

### Version and identity

- unversioned canonical
- version-pinned canonical
- same `system + code` across multiple versions
- request-scoped version binding vs provider default version

### Output shape

- normalized display
- designations
- typed `value[x]` properties
- issue vs message handling
- success payloads that should stay quiet

## `$validate-code` dimensions

This operation needs the richest matrix.

### Inputs

- `code + system`
- `Coding`
- `CodeableConcept`
- inline `ValueSet`
- canonical `url`
- canonical `url|version`
- instance-level code system validation
- implicit value set validation

### Semantic cases

- code in include
- code excluded by `compose.exclude`
- inline imported value set
- filter-based include
- filter-based exclude
- multi-system include
- version-pinned include
- inactive code

### Response-shaping cases

- success without noisy `message`
- expected warnings only when there is a real concern
- normalized display returned from terminology data, not just echoed input
- returned coding/concept shape remains stable across equivalent parameter forms

### Supplement-specific cases

- supplement adds designation only
- supplement adds typed property
- supplement changes lookup/validate decoration but not membership
- supplement-backed filter semantics where supported
- missing or ambiguous supplement fails explicitly

## `$lookup` dimensions

### Inputs

- type-level lookup by `system`
- instance-level lookup by `CodeSystem/{id}`
- `code` only where system is implied
- display language and designation-use parameters

### Output cases

- normalized display
- typed properties
- designations
- supplement-added decorations
- same result for configured sqlite supplement vs equivalent inline supplement

## Test layers

Use the same layering discipline we settled on for the rest of the
branch.

### 1. Provider/unit

Use for:

- typed property contracts
- display/designation/property retrieval
- provider-specific version handling
- hierarchy semantics

Keep these out of HTTP when possible.

### 2. Worker/request integration

Use for:

- parameter parsing
- canonical/version resolution
- supplement resolution and attachment
- success/error payload shaping

These should use shared per-file TX fixtures, not per-test app startup.

### 3. Matrix/replay corpus

Use for:

- historical regressions from real captured traffic
- current local-vs-`tx.fhir.org` spot checks
- ensuring request forms seen in production keep working

This is now the shared TX harness:

- grouped by operation
- one case definition model
- one matrix/detail output format
- capture request, status, key output fields, and issue/message shape
- perf uses the same shared matrix surface across covered operations

The shared TX harness is the live matrix for `$expand`, `$lookup`, and
`$validate-code`. Treat the current case files and generated artifacts as
the source of truth for row inventory instead of duplicating counts here.

Legacy expectations in the shared harness should follow current
`tx.fhir.org` behavior:

- inline supplement cases can run in both IR and legacy when
  `tx.fhir.org` demonstrates that the legacy path works
- configured sqlite supplement cases stay IR-only unless there is a
  real legacy/server-loaded support path to compare against

## What “good coverage” should mean

For each high-priority operation, we should have:

1. a small provider/unit layer for core semantics
2. request-level integration cases for every important parameter form
3. supplement-aware coverage where runtime seams changed
4. a replay corpus of real regressions and edge requests

That is enough to keep the branch honest without creating a second
harness framework beside the shared TX harness.

## Suggested implementation order

1. Keep deepening `$validate-code`
   - request-shape matrix
   - supplement cases
   - replay corpus
2. Keep strengthening `$lookup`
   - typed property and designation matrix
   - sqlite-sidecar vs inline supplement equivalence
3. Add replay-driven cases for any remaining expand/lookup/validate
   requests that show up in captured traffic

## Harness shape and DRY follow-on

The shared TX harness should be the only matrix runner.

Existing focused validate/lookup tests can still provide source material
for new harness rows, but they should not grow a second matrix surface
beside the shared harness.

Follow-on cleanup target:

1. keep request capture, detail-json, catalog, and HTML matrix helpers
   in one harness implementation
2. keep operation-specific case definitions in the shared TX harness
3. avoid duplicating managed-harness defaults and output conventions
4. keep parity/replay semantics comparable across operations
