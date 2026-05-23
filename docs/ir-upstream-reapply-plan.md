# IR Engine Reapply Plan

## Baseline

- Upstream base: `upstream/main` at `66d19ca` (`better logging when publishing`).
- Original IR branch point: `dbb01fe`.
- Original IR work: `origin/ir-engine`, 105 commits past the branch point.
- Upstream drift: 323 commits past the branch point.
- The work was reapplied in local stacked worktrees; no fixed local path is
  required to reproduce the branch.
- Runtime: upstream now requires Node `>=24`; this machine uses `nvm` and Node `25.9.0` for importer and test runs.

## Core Decisions

- Keep `better-sqlite3` synchronous. The async shape around terminology operations is an integration contract, but SQLite statement execution is synchronous in-process. That is acceptable here because deployment can scale with a cluster model, for example eight worker processes, each with its own SQLite connections and request CPU budget.
- Do not require a custom `better-sqlite3` fork. If a local fork exposes max-iteration or progress-handler controls, detect and use them to cap runaway queries. If the stock package is installed, continue with normal execution and enforce limits at higher layers where possible.
- Keep the branch stack staged. Apply schema/importers first, then provider, then IR algebra/execution, then operation routing. This keeps each review and regression set small enough to reason about.
- Prefer current upstream package versions and module structure. Upstream already carries newer dependency and importer infrastructure; do not replay old package metadata blindly.
- Use real terminology artifacts for smoke coverage: LOINC 2.81, RxNorm 02022026, and SNOMED CT US 20230301 from local official source archives/directories.

## Worktree And Branch Stack

1. `sqlite-v0-schema-importers`
   - Based directly on `upstream/main`.
   - Adds the normalized v0 SQLite schema and LOINC/RxNorm/SNOMED importers.
   - Adds metadata drift fixes needed by the provider: schema `user_version`, `code_system.release_date`, and `property_def.source_type`.
   - Adds importer smoke tests that validate schema invariants and module registration.

2. `sqlite-v0-provider`
   - Based on `sqlite-v0-schema-importers`.
   - Adds `cs-sqlite-v0` provider support and related sqlite-v0 planning/lowering helpers.
   - Adds optional native supplement sidecar support only after the base provider is stable.
   - Adds a SQLite runtime adapter that opens databases, sets pragmas, registers functions, and optionally applies max-iteration/progress limits when the installed `better-sqlite3` supports them.

3. `ir-core`
   - Based on `sqlite-v0-provider`.
   - Adds the IR algebra, canonicalization, rewrite, traversal, scoped interpreter, execution planner, and trace model.
   - Ports tests in stages: algebra/rewrite first, interpreter/semantics next, then sqlite SQL parity/fuzz tests.

4. `ir-routing`
   - Based on `ir-core`.
   - Wires expand/validate/lookup routing with explicit `_engine=ir` opt-in first.
   - Keeps legacy routing as the default until parity and performance gates pass.
   - Adds feature flags for controlled default expand routing after parity is established.

5. `ir-harness-and-docs`
   - Based on `ir-routing`.
   - Adds harness scripts, parity matrices, trace docs, and operational guidance.
   - This is where broader aspects of the old phase 6 work should land: complex correctness cases, locked dates, supplements, hierarchy edge cases, and performance diagnostics.

## Phase 1: Schema And Importers

Tasks:

- Port `schema-v0.sql` and the three sqlite-v0 importers from `origin/ir-engine`.
- Align schema with provider expectations:
  - `PRAGMA user_version = 1`
  - `code_system.release_date TEXT`
  - `property_def.source_type TEXT`
- Preserve importer compatibility with upstream `tx-import.js` module registration.
- Normalize release dates where available:
  - RxNorm `MMDDYYYY` input to `YYYY-MM-DD`.
  - SNOMED `YYYYMMDD` input to `YYYY-MM-DD`.
  - LOINC release date remains nullable until we add reliable metadata extraction from the archive or a CLI option.
- Keep source-type metadata simple and deterministic:
  - concept-valued properties use `source_type = 'code'`.
  - literal-valued properties use `source_type = 'string'` unless a later importer has stronger typing.

Verification:

- `npx jest tests/tx/sqlite-v0-importers.test.js --runInBand`
- `node tx/importers/tx-import.js list`
- Smoke import LOINC 2.81 with closure skipped.
- Smoke import RxNorm 02022026 with closure skipped.
- Smoke import SNOMED CT US 20230301 from extracted RF2 directory, with refsets skipped for first pass.
- Inspect generated DB counts, `user_version`, code-system metadata, and representative property definitions.

## Phase 2: sqlite-v0 Provider

Tasks:

- Port the generic sqlite-v0 `CodeSystemProvider` and factory.
- Add a small SQLite open/runtime module instead of scattering connection setup:
  - opens read-only by default for provider requests.
  - applies `cache_size`, `temp_store`, and `mmap_size` pragmas.
  - registers `regexp`.
  - detects optional max-iteration/progress-handler support from a custom `better-sqlite3` build.
  - exposes a no-op fallback on stock `better-sqlite3`.
- Keep provider API additions small:
  - `releaseDate()`
  - multi-parent `parents()`
  - `registerSqliteSupplements()` only when supplement sidecars are in scope.
- Validate direct operations before IR:
  - locate/display/definition/status.
  - parent/parents/children.
  - properties/designations/extensions.
  - legacy filter protocol behavior.
  - implicit LOINC answer-list value sets where the v0 specialization supports them.

Verification:

- Port focused `tests/cs/cs-sqlite-v0*.test.js` suites incrementally.
- Run provider tests against both tiny generated fixtures and the official smoke DBs.
- Add a targeted test proving stock `better-sqlite3` works when no max-iteration API exists.
- Add a mocked/fake capability test for the custom-fork max-iteration path so it does not depend on local native binaries.

## Phase 3: IR Core

Tasks:

- Port IR node model, canonicalization, traversal, build, rewrite, and scoped interpreter.
- Rebase planner assumptions against current upstream ValueSet and CodeSystem behavior.
- Keep each rewrite law backed by tests before enabling SQL execution.
- Reintroduce trace output as an optional diagnostic, not a default response shape.

Verification:

- Algebra and traversal unit tests.
- Bounded exhaustive tests over synthetic terminology models.
- Metamorphic tests for include/exclude, imports, active-only, filters, and locked dates.
- Compare scoped interpreter output against legacy expansion for small deterministic fixtures.

## Phase 4: IR SQL Execution

Tasks:

- Port sqlite-v0 clause lowering, physical plan construction, SQL AST, SQL emit, and terminal selection.
- Keep execution scoped per CodeSystem bucket.
- Apply optional SQLite max-iteration/progress limits at the statement boundary when available.
- Prefer exact totals only when the plan can provide them cheaply or the request requires them.

Verification:

- SQL parity tests against the interpreter.
- Fuzz tests for property filters, hierarchy filters, value-set membership, text search, and supplements.
- Mutation sentinel tests for known tricky plan boundaries.
- Performance smoke tests on official LOINC/RxNorm/SNOMED DBs.

## Phase 5: IR Routing For Operations

Tasks:

- Wire `_engine=ir` for expand, validate, and lookup.
- Keep legacy as default initially.
- Reuse upstream request parameter parsing and resource cache behavior.
- Preserve legacy diagnostics and errors unless there is a deliberate IR-specific improvement.
- Handle supplements consistently across inline CodeSystems, registered CodeSystems, native sidecars, and sqlite-v0 providers.

Verification:

- Expand E2E comparison tests for explicit concepts, filters, imports, text search, offset/count, total, inactive handling, and excludes.
- Validate tests for CodeSystem and ValueSet paths, including CodeableConcept failure echoing and membership-only behavior.
- Lookup tests for display, designations, parent/child properties, requested property filtering, and supplement-provided data.
- Harness matrix comparing legacy and IR responses on upstream fixtures and official DB smoke cases.

## Upstream Audit Focus

Audit these before porting each phase:

- Upstream importer framework changes since `dbb01fe`.
- Current package versions and Node engine requirements.
- CodeSystem provider API changes and new capabilities.
- Current expand/validate/lookup worker request parsing, diagnostics, and cache behavior.
- Existing OCL and upstream terminology-provider changes that may overlap provider routing.
- Current supplement handling in legacy workers.
- Any upstream fixes in LOINC/RxNorm/SNOMED providers that should be mirrored in sqlite-v0 behavior rather than replaying older IR branch assumptions.

## Risk Controls

- Each branch must pass its own focused test set before the next branch starts.
- Official large DB imports are smoke tests, not the only correctness proof.
- Keep generated DBs outside the repository.
- Do not make IR default until explicit IR routing has parity coverage.
- Treat max-iteration support as a runtime enhancement. Query correctness must not depend on the custom fork being installed.
