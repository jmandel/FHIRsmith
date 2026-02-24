# Questions: current provider entrypoint split, mismatches, and unification gaps

## Scope
This note describes the current state of provider entrypoints used by expansion and where behavior diverges across implementations. It is intentionally diagnostic. It does not propose a migration plan.

## Current entrypoint flavors in provider surfaces

Flavor A: v3 query hooks
- `negotiate({ system, version, supplements, params, mode })` (`tx/cs/provider-core.js`)
- `openStream({ queryIR, exec, supplements })`
- `prepareMembership({ queryIR, exec, supplements })`
- `decorateMany({ codes, opts, supplements })`

Flavor B: legacy filter pipeline
- `getPrepContext(iterate)` (`tx/cs/provider-core.js:670`)
- `searchFilter(filterContext, filter, sort)` (`tx/cs/provider-core.js:682`)
- `filter(filterContext, prop, op, value)` (`tx/cs/provider-core.js:694`)
- `executeFilters(filterContext)` (`tx/cs/provider-core.js:705`)
- `filterMore/filterConcept/filterLocate/filterCheck` (`tx/cs/provider-core.js:736`, `tx/cs/provider-core.js:745`, `tx/cs/provider-core.js:754`, `tx/cs/provider-core.js:763`)

Flavor C: iterator-only/minimal providers
- `iterator/nextContext` plus `locate/code/display` with little or no filter support.

## Implementation survey snapshot

Only one provider currently implements full Flavor A negotiation directly:
- `SqliteRuntimeV0Provider` implements `negotiate/openStream/prepareMembership/decorateMany`.

Most providers are Flavor B and/or C:
- `FhirCodeSystemProvider` (cs-cs) uses filter contexts and in-memory ranking for `searchFilter` (`tx/cs/cs-cs.js:1133`) and filter set iteration (`tx/cs/cs-cs.js:1028` onward).
- `UcumCodeSystemProvider` supports a narrow structured filter (`canonical =`) but throws for `searchFilter` (`tx/cs/cs-ucum.js:248`) and is effectively open-ended (`specialEnumeration`, `filtersNotClosed`).
- `CountryCodeServices` supports only `code regex` and throws for `searchFilter` (`tx/cs/cs-country.js:182`, `tx/cs/cs-country.js:191`).
- `USStateServices` provides iteration and lookup but no filter/search hooks (`tx/cs/cs-usstates.js:140`).
- `MimeTypeServices` is not closed (`isNotClosed`) and has no filter/search entrypoints (`tx/cs/cs-mimetypes.js:39` onward).
- Legacy SNOMED provider uses yet another filter/search style where `searchFilter` delegates and ignores `filterContext` (`tx/cs/cs-snomed.js:970`).

## Observed mismatches

1. Capability declaration is sparse
- most providers do not implement `negotiate()` explicitly.
- adapter fallback therefore infers capabilities from method overrides and runtime shape.

2. Text search semantics are not uniform
- Base contract says `searchFilter` executes “whatever that means” (`tx/cs/provider-core.js:674` comment block).
- Some providers implement ranked display/code search (`cs-cs`), some throw (`ucum`, `country`), some are regex/property-first (`sqlite-v0`), and some have no path.
- Legacy SNOMED `searchFilter` ignores `filterContext` shape expected by the generic pipeline.

3. Structured filter execution models differ
- `executeFilters` can mean “return independent sets” or “already combined result”.
- `filterCheck` return contract is mixed (`string | boolean` in API docs), so caller logic must normalize both pass/fail and explanatory strings.
- `iterate=false` is used as a hint, but providers interpret optimization strategy differently.

4. Two fundamentally different “advanced” execution styles coexist
- sqlite-v0 implements queryIR-level set ops + paging + membership preparation.
- non-sqlite providers operate through stateful filter contexts and iterator loops.
- The adapter layer must bridge between declarative queryIR and imperative cursor/filter state.

5. Ordering and paging guarantees are uneven
- Query path can expose deterministic SQL order.
- Iterator/filter pipelines may not expose explicit stable ordering guarantees.
- Safety rules for provider-level pagination depend on ordering and complete membership coverage, which many providers cannot declare explicitly.

6. Not-closed signaling is split across concepts
- `isNotClosed()` at provider level vs `filtersNotClosed(filterContext)` at filter execution level.
- Grammar-based systems and special enumerations (for example UCUM, MIME) surface open-endedness through different paths.

7. Context object shape is provider-specific
- `filterCheck/filterLocate` and decoration depend on provider contexts that differ widely by implementation.
- Some providers treat context as a rich object, others as a raw string/code, others as DB row handles.

## Why bridging is currently hard

- The orchestrator asks for declarative operations (queryIR, set ops, deep paging), while most providers expose imperative state machines (prep context, filter stack, cursor APIs).
- Text filtering and structured filtering are both called “filter” at high level but run through separate, provider-specific semantics.
- The same operation (`membership check`) can be O(1) batch SQL in one provider and per-code iterative checks in another.
- API naming suggests common behavior, but provider contracts allow substantial variation in meaning and output shape.

## Questions for unification (no proposed answers)

1. What is the minimum semantic contract for text filtering that all providers must share, if any?
2. Should unsupported text search be represented as “not supported” or as a best-effort fallback, and where is that declared?
3. What invariants should `executeFilters` guarantee: independent sets, combined set, or either?
4. Should `filterCheck` continue returning `string | boolean`, or should diagnostics be separated from membership truth values?
5. Where should deterministic ordering be declared, and how should the orchestrator reason about it for paging safety?
6. Can not-closed status be represented with one consistent signal across whole-system and filter execution paths?
7. What provider metadata is required so the orchestrator can decide pushdown eligibility without probing by trial/failure?
8. How should context objects be normalized (if at all) for membership and decoration across providers?
9. Is the long-term provider contract one entrypoint family or two explicit families with a formal bridge boundary?
