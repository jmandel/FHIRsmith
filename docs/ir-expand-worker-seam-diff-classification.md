## Purpose

This note classifies the remaining delta in [tx/workers/expand.js](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js) against `upstream/main` after the first seam extraction that moved IR-only expansion glue into [tx/engine/expand-entry.js](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/engine/expand-entry.js).

Current diff size against `upstream/main`:

- `tx/workers/expand.js`: `161` insertions, `34` deletions

The point of this classification is to separate:

- IR seam residue that should eventually move out of `expand.js`
- independent legacy-side fixes that should stand or fall on their own
- small residual drift that should get dedicated tests before being kept long-term

## Summary

### IR seam residue

- lazy IR/trace loaders at [tx/workers/expand.js:22](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L22)
- trace extension constant at [tx/workers/expand.js:40](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L40)
- engine selection and IR dispatch at [tx/workers/expand.js:1991](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L1991)

### Independent legacy or worker fixes worth keeping for now

- explicit display plumbing in [tx/workers/expand.js:312](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L312) and callsites at [tx/workers/expand.js:790](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L790), [tx/workers/expand.js:818](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L818), [tx/workers/expand.js:876](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L876), [tx/workers/expand.js:1052](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L1052)
- imported ValueSet exclude/hierarchy fixes in [tx/workers/expand.js:582](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L582)
- exclusion matching fix in [tx/workers/expand.js:1493](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L1493)
- `_nocache` cache bypass in [tx/workers/expand.js:1945](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L1945)
- legacy trace wrapper in [tx/workers/expand.js:2049](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L2049)
- `Extensions.addBoolean(...)` call cleanup at [tx/workers/expand.js:1276](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L1276)

## Detailed Classification

### 1. Lazy IR entry and trace loaders

Current code:

- [tx/workers/expand.js:22](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L22)
- [tx/workers/expand.js:28](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L28)

What it is:

- lazy `require()` for `tx/engine/expand-entry`
- lazy `require()` for `tx/engine/expand-trace`

Why it exists:

- avoid eagerly loading IR engine and tracing support into the legacy worker path

Classification:

- `IR seam residue`

Reasoning:

- this is purely about IR dispatch and trace plumbing
- it does not belong to legacy expansion semantics
- after the first extraction it is much smaller, but it is still worker-owned IR knowledge

Recommended next move:

- keep for now
- eventually hide behind one dispatch hook or a worker-to-engine adapter

### 2. Explicit display plumbing in `includeCode(...)`

Current code:

- [tx/workers/expand.js:312](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L312)
- [tx/workers/expand.js:431](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L431)

What changed from upstream:

- `includeCode(...)` accepts `explicitDisplay = null`
- when supplied, that display wins over `preferredDesignation(...)`
- several callsites now pass `await cs.display(...)` or `cc.display`

What this is about:

- preserving an explicit concept display from the source/provider instead of always recomputing the output display from designation preference logic

Concrete example:

- an inline or imported concept may carry `display: "Male"`
- upstream-style legacy logic recomputes display from designations
- current branch can preserve the explicit display value already associated with the included concept

Classification:

- `independent legacy fix`

Reasoning:

- not IR-specific
- lives entirely in legacy `ValueSetExpander`
- appears to be part of parity/correctness cleanup rather than seam leakage

Caution:

- this should have explicit regression coverage of its own if retained long-term
- it should not be justified by “IR needed it”

### 3. Imported ValueSet exclude and hierarchy fixes

Current code:

- [tx/workers/expand.js:582](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L582)

What changed from upstream:

- imported items now honor `isExcluded(...)`
- total is updated when imported items are accepted
- child recursion uses `nextParent` instead of always the original parent
- duplicate imports clear `canBeHierarchy`

What this is about:

- fixing legacy behavior for imported expansions when the importing ValueSet also excludes concepts or when hierarchy has to be reconstructed across imported content

Concrete example:

- imported ValueSet contains `a, b, c, d`
- root ValueSet includes that import but excludes `b`
- current behavior correctly returns `a, c, d`
- old behavior could keep excluded imported codes or attach children to the wrong parent path

Classification:

- `independent legacy fix`

Reasoning:

- not IR-specific
- explicitly covered by parity tests in [tests/tx/expand-valueset.test.js:1591](/home/jmandel/hobby/FHIRsmith-ir-engine/tests/tx/expand-valueset.test.js#L1591) and [tests/tx/expand-valueset.test.js:2040](/home/jmandel/hobby/FHIRsmith-ir-engine/tests/tx/expand-valueset.test.js#L2040)
- this is exactly the sort of change that should stand on its own even if the IR seam were removed entirely

Recommended next move:

- keep

### 4. `Extensions.addBoolean(...)` call cleanup

Current code:

- [tx/workers/expand.js:1276](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L1276)

What changed from upstream:

- call site switched from the old three-argument style to the current helper signature

Classification:

- `independent worker compatibility fix`

Reasoning:

- mechanical API alignment
- not architectural
- not IR-specific

Recommended next move:

- keep

### 5. Version-aware and version-agnostic exclusion matching

Current code:

- [tx/workers/expand.js:1493](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L1493)

What changed from upstream:

- version-specific excluded systems are checked only when a version is present
- when not doing versioned expansion, exclusion matching falls back across any version for the same `system#code`

What this is about:

- making exclusion logic behave sensibly when imported data carries versions but the surrounding expansion is not version-partitioned

Classification:

- `independent legacy fix`

Reasoning:

- not IR-specific
- tied directly to the imported/exclude parity fixes above
- without this, imported exclusions can miss on version-shape mismatches

Recommended next move:

- keep

### 6. `_nocache` cache bypass

Current code:

- [tx/workers/expand.js:1945](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L1945)

What changed from upstream:

- request param `_nocache=true` disables expansion cache lookup/store for this request

What this is about:

- fair benchmarking and deterministic perf measurements

Classification:

- `independent worker feature`

Reasoning:

- not IR-specific
- used by perf tooling and benchmark comparisons
- isolated and low-risk

Recommended next move:

- keep

### 7. Engine selection and IR dispatch in `performExpansion(...)`

Current code:

- [tx/workers/expand.js:1991](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L1991)

What it is:

- `_engine=ir` / `_engine=legacy` override handling
- opportunistic IR enablement via `EXPAND_IR_ENGINE=1`
- dispatch to [tx/engine/expand-entry.js](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/engine/expand-entry.js)

Classification:

- `IR seam residue`

Reasoning:

- this is the remaining IR-specific architecture in `expand.js`
- it is much smaller now because the heavy logic moved out, but it is still the central ownership seam the cleanup plan wants to shrink further

Recommended next move:

- keep in this first slice
- later decide whether even engine selection should move outside `expand.js`, or whether this is the acceptable final dispatch boundary

### 8. Legacy trace wrapper and engine-selection note

Current code:

- [tx/workers/expand.js:2049](/home/jmandel/hobby/FHIRsmith-ir-engine/tx/workers/expand.js#L2049)

What it is:

- `_trace` on the legacy path
- emits an `engine-selection` note and a `legacy-expand` span

Classification:

- `independent worker observability feature`

Reasoning:

- not IR execution logic
- but still additional behavior in `expand.js` relative to upstream
- useful for comparison harnesses and debugging

Recommended next move:

- keep if legacy tracing remains a product/debug requirement
- otherwise this is separable from IR seam work and could be moved or reverted independently

## Practical Next Pass

If the next goal is to get `expand.js` closer to upstream without breaking behavior, the order should be:

1. leave the imported-exclude and exclusion-matching fixes alone
2. leave `_nocache` alone
3. decide explicitly whether legacy trace is a keeper
4. add or find direct coverage for explicit-display behavior, then decide if it stays
5. only then continue shrinking the IR dispatch boundary

That keeps correctness fixes separate from seam cleanup and avoids “rebase cleanup” accidentally reintroducing known legacy regressions.
