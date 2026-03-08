# IR Engine Branch — Architecture & Code Review

Review of the `ir-engine` branch against `upstream/main`. Covers ~70 commits
introducing an IR-based `$expand` engine, a generic sqlite-v0 code system
provider, and a supplement runtime. ~8,500 lines of new JS plus ~1,200 lines
of architecture docs.

---

## Executive summary

The architecture is clean and well-documented. The IR is minimal and semantic.
The pipeline stages are well-bounded. The supplement system earns its
complexity. The testing strategy (four-oracle + bounded exhaustive + fuzz) is
best-in-class.

This archived review started with medium/high issues concentrated at the
supplement/runtime boundary and the response-shaping boundary. Those have been
addressed on this branch. The low-priority `Proxy`-based supplement wrapper
(`F6`) was also cleaned up later by replacing the proxy with an explicit IR
execution wrapper.

---

## Part 1: What's well done

### IR design (tx/engine/ir.js — 92 lines)

Six node kinds (`empty`, `selector`, `import`, `union`, `intersect`, `diff`)
with eagerly-simplifying constructors. `union()` flattens nested unions and
drops empties in the constructor itself. `intersect()` short-circuits on any
empty child. This is the right level of abstraction — semantic, not
execution-strategic. Combined with `build-ir.js` (87 lines), the entire
intermediate language and its construction from `ValueSet.compose` is ~180
lines. Hard to cut further.

### Pipeline separation

Build IR → resolve imports → optimize/partition → execute per-system →
decorate → format. Each stage has a clear input/output contract. The
orchestrator coordinates without owning the individual steps. `rewrite.js` is
correctly scoped to structural simplification (coalescing, deduplication,
partitioning by system) — it doesn't try to be a query optimizer.

### Shared generic executor (tx/engine/generic-ir-executor.js — 313 lines)

`createGenericIRExecutor()` is parameterized on exactly the hooks that differ
between consumers: `executeSelector`, `buildSelectorMembership`,
`applyTextFilterCandidates`, `createState`. Both `legacy-ir-adapter.js` and
`ir-provider.js` (supplement wrapper) plug into this shared core for
union/intersect/diff/paging, avoiding the classic "two slightly different
set-algebra implementations" bug.

### Supplement architecture

The layering — `types.js` (132 lines) → `registry.js` (149) → `resolver.js`
(133) → `overlay.js` (112) → `ir-provider.js` (310) — is genuinely needed.
Each layer does one thing: parsing canonical refs, indexing supplement
descriptors, binding to a base scope, materializing overlays, and executing
IR with supplement-aware clause partitioning. The design principle "IR stays
supplement-agnostic" is correctly upheld.

### sqlite-v0 execution compiler

The pipeline (scoped IR → SetPlan → terminal plan → SQL AST → SQL text) is
properly stratified. `sqlite-v0-sql-emit.js` (155 lines) is a pure renderer
with no decisions. The four-oracle testing strategy (compose evaluator →
scoped IR interpreter → logical plan interpreter → runtime SQL execution)
localizes failures to a specific compiler stage.

### Documentation

`ir-engine.md` is a real architecture document that explains what exists.
`supplement-architecture.md` is implementation-shaped on purpose and says so.
`sqlite-v0-execution-compiler.md` explains the multi-oracle testing strategy.
None of these are aspirational boilerplate.

### Things conspicuously NOT found

- No astronaut architecture. No abstract factory factories.
- No backwards-compatibility shims. The IR engine is opt-in; the legacy
  expander is untouched except for a narrow entry point and supplement
  fail-closed guard.
- No unnecessary generality. The specialization system exists for one real
  case (LOINC implicit ValueSets). The pattern is there for growth but not
  over-applied.

---

## Part 2: Findings

### F1 (High) — Supplement decoration ownership is ambiguous

Status: fixed on this branch

**The problem.** The same supplement data can flow through three independent
decoration paths, with no single point deciding which one owns decoration for
a given request:

1. **Legacy `CodeSystem[]` path** — `provider.supplements` array, merged
   during `bulkDesignations()` at `cs-sqlite-v0.js:1703-1735` and
   `bulkProperties()` at `cs-sqlite-v0.js:1798-1820`.
2. **Native sqlite attachment** — supplement rows queried via
   `#nativeSupplementDesignationRowsForConceptIds()` at
   `cs-sqlite-v0.js:1738-1747` and `#nativeSupplementPropertyRowsForConceptIds()`
   at `cs-sqlite-v0.js:1822+`.
3. **Generic overlay merge** — `mergeSupplementOverlayIntoCandidates()` called
   at `orchestrator.js:1054-1061` whenever `provider._irSupplementSet` has
   items and the overlay contains materialized `CodeSystem` instances.

Supplement resolution (`resolveSupplementsForBaseScope` at `resolver.js:24`)
eagerly materializes both native bindings (`resolver.js:33`) and overlay
sources for non-sqlite-native entries (`resolver.js:34-35`). So inline
supplements DO get `overlaySource.codeSystem` populated, and
`nativeSupplementItemsFromSet()` at `sqlite-v0-supplements.js:9-13` picks
them up correctly for native binding.

**The ownership gap.** When sqlite-v0 successfully native-binds all
supplements, it sets `_irAllSupplementsNativeBound = true` at
`cs-sqlite-v0.js:433`. But the orchestrator's decoration path at
`orchestrator.js:1054-1061` does not check this flag — it unconditionally
builds and merges the overlay for any provider with `_irSupplementSet` items.
Since overlay sources are already materialized, the overlay merge runs and
can re-apply designations and properties that the native sqlite path already
handled.

**Resolution.** `decorateCandidates()` now skips generic overlay merge when
the provider signals `_irAllSupplementsNativeBound === true`, so native-bound
sqlite supplement decoration is not re-applied on the IR response path.

---

### F2 (High) — Supplement wrapper drops `allowIncompleteExpansion`

Status: fixed on this branch

**The problem.** In `ir-provider.js`, delegation to
`baseIRProvider.executeIR()` passes only `{ activeOnly: !!opts.activeOnly }`,
dropping `allowIncompleteExpansion`, `text`, `count`, `offset`, and other
opts. This occurs at three call sites:

- Line 106: non-filter selectors
- Line 122: selectors with no supplement clauses
- Line 131: base provider call with only support clauses

Compare to the orchestrator at `orchestrator.js:591-593` which passes the
full opts set.

**Impact.** Grammar-backed providers (UCUM, MIME types) that use
`allowIncompleteExpansion` to return limited expansions instead of throwing
`too-costly` will fail closed when wrapped in the supplement layer. The same
provider works correctly when used directly through `legacy-ir-adapter.js`.

**Resolution.** `allowIncompleteExpansion` is now forwarded at the three
delegation sites. `text`, `count`, and `offset` are still intentionally not
forwarded — the generic executor
intentionally applies text filtering and paging after set algebra at
`generic-ir-executor.js:222-224`. Passing count/offset to leaf providers
would page too early; passing text would double-filter. ~3 line changes.

---

### F3 (Medium) — Supplement clause routing is data-driven, not schema-driven

Status: fixed on this branch

**The problem.** `buildSupplementOverlay()` at `overlay.js:53-56` populates
`propertyCodes` from observed `concept.property` values — only property codes
that appear on actual concept rows. `overlayTouchesProperty()` at
`overlay.js:71-73` uses that set to decide whether a filter clause is
supplement-backed.

A supplement that declares `property: [{code: 'rank', type: 'integer'}]` in
its `CodeSystem.property` definitions but has no concepts with `rank` values
will have `propertyCodes` not including `'rank'`. A filter `rank = 1` routes
to the base provider, which either does not understand the property (error) or
ignores it (wrong result set). The correct answer — "no concepts match" — is
never evaluated.

**Comparison.** The native sqlite-v0 path gets this right through
`mergeSupplementPropertyDefinitions()` in `sqlite-v0-supplements.js`, which
consults `supplement_property_def` (the schema, not the data rows).

**Resolution.** `buildSupplementOverlay()` now also populates `propertyCodes`
from `CodeSystem.property` definitions, so schema-declared supplement
properties route correctly even when no concept currently carries a value.

---

### F4 (Medium) — Sideband metadata propagation via array properties

Status: fixed on this branch

**The problem.** Execution metadata (`_unclosed`, `_limitedExpansion`,
`_tooCostly`) is stapled onto candidate arrays as ad-hoc properties.
`propagateUnclosed()` in `generic-ir-executor.js:87-99` copies these
properties across set operations. Wrapper objects carry `_discoveredUnclosed`
/ `_discoveredLimitedExpansion` / `_discoveredTooCostly` fields that are
mutated during execution and read later by the orchestrator.

This pattern was introduced entirely in this branch (the upstream `expand.js`
on `main` has zero occurrences).

**Why it matters:**

- Array-as-bag is invisible to linting, type checking, and grep for call
  sites.
- Every new set operation in `executeNode` must remember to call
  `propagateUnclosed`.
- `_discoveredUnclosed` is read once at `orchestrator.js:578-580` (before
  pagination), but NOT re-checked after lazy `countForIR` at line 620.
  `_discoveredLimitedExpansion` and `_discoveredTooCostly` are correctly
  checked in both places (lines 581-582 and 621-622). Unclosed messages
  discovered during lazy counting are silently lost.

**Resolution.** The lazy `countForIR` path now re-checks
`_discoveredUnclosed` after counting, matching the existing re-checks for
`_discoveredLimitedExpansion` and `_discoveredTooCostly`. More importantly,
`generic-ir-executor.js` now uses an explicit `{ candidates, unclosed,
limitedExpansion, tooCostly }` result object internally instead of stapling
metadata onto candidate arrays. The executor still accepts the old array
shape at compatibility boundaries, but the branch-local array-sideband
pattern is no longer the internal execution contract.

---

### F5 (Low) — sqlite-v0-sql-ast.js mixes two abstraction levels

Status: fixed on this branch

`sqlite-v0-sql-ast.js` had contained
both SQL AST algebra (24 exported constructors like `table()`, `column()`,
`select()`) and physical plan lowering (~80 internal helper functions that
translate plans into AST nodes). These serve different purposes and have
different change frequencies.

The rest of the sqlite-v0 compiler is well-decomposed into 14 files with
clean boundaries, but the granularity is uneven — some files are 50 lines,
this one is 2,342.

Note: the physical plan and selected plan are only built as debug artifacts
when explicitly requested (`sqlite-v0-compiler.js:37`, `:51`, `:78`, `:88`).
So this is a maintenance-surface concern, not a runtime-path concern.

**Resolution.** The AST node constructors and structural-form utilities now
live in `sqlite-v0-sql-nodes.js`, while `sqlite-v0-sql-ast.js` retains the
physical-plan-to-AST lowering logic. Public compiler entry points are
unchanged.

---

### F6 (Low) — Proxy-based provider wrapping

Status: fixed on this branch

The supplement wrapper previously used `new Proxy()` to transparently delegate
unknown properties to the underlying provider. That made stack traces and
surface ownership less explicit than necessary.

**Resolution.** `ir-provider.js` now returns a small explicit IR execution
wrapper exposing only `executeIR`, `countForIR`, `membershipForIR`, and the
small amount of execution metadata the orchestrator consumes.

---

### F7 (Low) — Orphaned JSDoc at orchestrator.js:33-36

Status: fixed on this branch

A `/** Check if a ValueSet can be handled... */` doc comment that described
`canHandleValueSet` had been left stranded above `countFromIR`. Removed.

---

### F8 (Low) — orchestrator.js expandViaIR approaching density limit

Status: fixed on this branch

`expandViaIR` had been handling both pipeline execution and response shaping.

**Resolution.** Response-shaping helpers (`buildExpandedValueSet`,
`decorateCandidates`, compose overrides, expansion-property serialization,
candidate flattening/nesting) now live in `ir-expansion-response.js`.
`expandViaIR` remains the execution coordinator, but `orchestrator.js` is down
to ~670 lines and the expansion-response contract now has its own module.

---

## Part 3: Module size inventory

### tx/engine/ (3,545 lines total)

| File | Lines | Role |
|------|------:|------|
| orchestrator.js | 669 | Pipeline coordinator |
| ir-expansion-response.js | 461 | Expansion response shaping |
| rewrite.js | 773 | IR optimizer/partitioner |
| expand-trace.js | 286 | Structured tracing |
| generic-ir-executor.js | 313 | Shared set-algebra executor |
| legacy-ir-adapter.js | 261 | Filter-protocol → IR bridge |
| membership.js | 176 | Composable membership testers |
| resolve-imports.js | 159 | Import resolution + cycle detection |
| ir-debug.js | 105 | Debug plan rendering |
| scoped-ir-interpreter.js | 99 | IR interpreter (for testing) |
| ir.js | 92 | IR node constructors |
| build-ir.js | 87 | ValueSet → IR |
| index.js | 64 | Public exports |

### tx/supplements/ (1,710 lines total)

| File | Lines | Role |
|------|------:|------|
| sqlite-sidecar.js | 541 | Sidecar schema + read/write |
| ir-provider.js | 310 | Supplement-aware IR executor |
| synthetic.js | 275 | Test fixture generator |
| registry.js | 149 | Supplement descriptor registry |
| resolver.js | 133 | Canonical → resolved binding |
| types.js | 132 | Types + matching |
| overlay.js | 112 | Generic overlay build + merge |
| source-sqlite.js | 58 | Sqlite source adapter |

### tx/cs/sqlite-v0-* (new, ~7,800 lines total)

| File | Lines | Role |
|------|------:|------|
| sqlite-v0-sql-ast.js | 2,129 | Physical plan → SQL AST lowering |
| sqlite-v0-sql-nodes.js | 263 | SQL AST node constructors |
| cs-sqlite-v0.js | 2,171 | Provider + factory |
| sqlite-v0-plan-normalize.js | 587 | Plan normalization |
| sqlite-v0-plan-interpret.js | 404 | Plan interpreter (testing) |
| sqlite-v0-clause-lowering.js | 354 | IR → plan lowering |
| sqlite-v0-plan-types.js | 336 | SetPlan/RowPlan types |
| sqlite-v0-physicalize.js | 331 | Strategy annotation |
| sqlite-v0-compiler.js | 243 | Compilation coordinator |
| sqlite-v0-supplements.js | 180 | Native supplement attachment |
| sqlite-v0-plan-builder.js | 160 | Plan construction |
| sqlite-v0-sql-emit.js | 155 | SQL renderer |
| sqlite-v0-format-plan.js | 91 | Debug formatting |
| sqlite-v0-selection-builder.js | 89 | Runtime selection |
| cs-sqlite-v0-loinc.js | 89 | LOINC specialization |
| sqlite-v0-hierarchy.js | 77 | Hierarchy utilities |
| sqlite-v0-terminal-builder.js | 50 | Terminal plan builder |
| cs-sqlite-v0-specializations.js | 3 | Bootstrap loader |

---

## Part 4: Prioritized recommendations

### Fix now (before merge)

Completed:

1. **F2**: `allowIncompleteExpansion` is forwarded in `ir-provider.js`
   delegation calls.
2. **F3**: `propertyCodes` are populated from supplement
   `CodeSystem.property` definitions, not just observed values.
3. **F4 (concrete bug)**: the lazy `countForIR` path now re-checks
   `_discoveredUnclosed`.
4. **F7**: removed the orphaned JSDoc comment.

### Fix soon (next iteration)

Completed:

5. **F1**: the orchestrator overlay merge now skips when the provider signals
   native-bound supplement decoration.

### Remaining open item

None from this review remain urgent. The earlier `F6` proxy-wrapper note has
been addressed by switching to an explicit execution wrapper.
