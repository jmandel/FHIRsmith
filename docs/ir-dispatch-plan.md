# IR Dispatch Plan

## Intent

Keep engine selection at the route seam in `tx/tx.js`.

That gives us:

- one explicit dispatch point for `_engine`
- legacy workers that stay close to upstream behavior
- IR workers that own new runtime behavior without contaminating the legacy workers
- clear cutover confidence because `_engine=ir` means "new worker path"

## Current state

Implemented:

- `tx/tx.js` dispatches `$expand` between:
  - `ExpandWorker`
  - `ExpandIRWorker`
- `tx/tx.js` dispatches `$validate-code` between:
  - `ValidateWorker`
  - `ValidateIRWorker`
- `_engine=ir` is the only documented strict IR mode

Files:

- `tx/tx.js`
- `tx/workers/engine-selection.js`
- `tx/workers/expand-ir.js`
- `tx/workers/validate-ir.js`

## Why this structure stays

This is the right boundary for the branch:

- route dispatch owns worker selection
- legacy workers remain legacy
- IR workers can evolve around the new runtime seam
- runtime comparison is straightforward because the worker choice is explicit

This is better than:

- hiding engine selection inside legacy workers
- retrofitting old provider contracts to satisfy new supplement/runtime behavior

## Expand

`ExpandIRWorker` owns the IR expansion path.

It delegates into the IR engine/runtime stack and is the only expand
worker used when `_engine=ir` is requested.

Important contract:

- `_engine=ir` is strict
- unsupported/runtime failures should stay explicit
- legacy fallback is only acceptable when the route did not explicitly
  request IR

## Validate

`ValidateIRWorker` owns IR-path `$validate-code`.

It exists so we do not have to widen the legacy validate worker or old
provider filter protocol just to satisfy new supplement/runtime
semantics.

Important contract:

- supplement/runtime-aware validate behavior belongs in the IR worker
- legacy validate remains legacy
- supplement/runtime failures stay explicit

## Related operations

`$lookup` is now split the same way:

- `tx/tx.js` dispatches `$lookup` between:
  - `LookupWorker`
  - `LookupIRWorker`

If more operations need new runtime semantics, they should follow the
same pattern:

- keep old worker
- add IR/new-runtime worker
- dispatch in `tx/tx.js`

## Harness implications

The unified TX harness should exercise these dispatch rules directly.

That means:

- `_engine=ir` rows go through the IR workers
- `_engine=legacy` rows go through the legacy workers
- operation coverage for `$expand`, `$validate-code`, and `$lookup`
  lives in one harness surface, not separate runners

## Success criteria

Current success criteria are met:

- `_engine=ir` dispatch for expand, validate, and lookup happens in `tx/tx.js`
- old workers no longer need to own new runtime semantics
- IR validate supplement/runtime behavior is covered through
  `ValidateIRWorker`
- the route seam is the authoritative engine-selection boundary
