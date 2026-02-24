# Expand v3 Supplement Resolution and Attachment Flow

## Goal

Keep supplement semantics explicit and request-scoped while allowing providers to contribute native supplement catalogs.

This flow avoids hidden provider-only supplement state and avoids worker-only global scans as the sole source of truth.

## Core model

For v3 `$expand`, supplement handling is split into two responsibilities:

1. Resolution responsibility (worker):
- Determine which requested supplement canonicals are in scope.
- Build one `SupplementContext` for the request/system/version.
- Enforce missing-supplement failures when requested supplements cannot be satisfied.

2. Execution responsibility (provider):
- Use `SupplementContext` during negotiation and execution (`openStream`, `prepareMembership`, `decorateMany`).
- Pull native handles from `SupplementContext.native(...)` when available.

## Resolution sources

The worker resolves supplement canonicals from two sources:

1. Request resources (`tx-resource` CodeSystem supplements).
2. Provider-declared supplement catalog via:
   - `CodeSystemProvider.knownSupplementEntries({ requiredCanonicals, system, version })`

All discovered entries are merged and deduplicated by sqlite path before building `SqliteSupplementContext`.

## Provider hook for supplement declaration

`CodeSystemProvider` now has:

```js
async knownSupplementEntries({ requiredCanonicals, system, version }) => []
```

Descriptor shape:

```js
{
  path: string,
  canonical: string,
  canonicalVersioned?: string,
  targetSystem: string,
  targetVersion?: string|null,
  availableProperties?: string[],
  availableOperators?: string[]
}
```

Default implementation returns `[]`.

`SqliteRuntimeV0Provider` implements this hook by scanning configured supplement roots and reading `supplement_manifest` from sqlite sidecars.

## Execution flow (per adapter/system)

1. `EngineRegistryV3.getAdapter(system, version, mode)` obtains provider instance.
2. `worker.resolveSupplementContext(requiredCanonicals, { system, version, providerHint })` builds context.
3. Adapter negotiates with provider using that context.
4. Provider uses the same context during v3 hooks.

This guarantees the same supplement scope is used for:
- capability negotiation,
- membership filtering,
- decoration.

## Why this is cleaner

- Single request-scoped supplement abstraction (`SupplementContext`) in v3.
- Provider-native supplement discovery is explicit and testable.
- Worker still enforces global request correctness (missing supplement checks).
- Provider still owns native execution optimizations.

## Current compatibility boundary

Some legacy provider paths still consume provider-owned `CodeSystem[] supplements`. That compatibility path remains for non-v3 consumers.

The v3 target state remains:
- supplement behavior driven by `SupplementContext`,
- provider-side supplement execution through v3 request hooks.
