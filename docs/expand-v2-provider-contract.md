# Expand v2 design: provider interface and worker architecture

This document describes the current contract between `expand-v2` and code system providers, and the execution design of the worker itself. The intent is to make correctness rules explicit, keep provider responsibilities narrow, and let pushdown and fallback coexist without semantic drift.

## Purpose and scope

The expand worker now treats `$expand` as a planning and execution problem with one semantic contract and multiple execution strategies. The semantic contract is that expansion membership is computed as the union of all includes minus the union of all excludes, with deduplication by `(system, version?, code)` and paging applied to the final deduped stream.

Providers can accelerate parts of this computation, but they do not own semantics for the whole compose unless the worker explicitly delegates a safe subset.

## CS provider interface changes

The provider base contract in `tx/cs/provider-core.js` now has two key extension points for expand orchestration.

`capabilities()` is the planning handshake. It lets a provider describe whether it supports grouped pushdown, and which request shapes it can evaluate. The worker uses capabilities to decide when pushdown is possible and when fallback is required.

`expandQuery(request)` is the grouped execution API. The worker sends one system-group request containing include and exclude component shapes for that system, optional text filter, intersection constraints, and optional pagination. The provider either returns a normalized result or returns `null` to decline, in which case the worker continues through fallback streaming.

The existing filter APIs remain in place for fallback and membership predicates. `getPrepContext(iterate)` is explicitly part of this model: providers can optimize differently for iterate-oriented flows versus membership-check-oriented flows.

This replaces the earlier direction of one-off orchestration hooks. The design goal is fewer special-purpose API switches and one explicit grouped contract.

## Request shape for `expandQuery`

The request is intentionally scoped to one `(system, version)` group, not the whole compose. It contains:

- grouped include component entries
- grouped exclude component entries
- optional top-level text filter
- active/inactive policy flags
- requested expansion decorations (properties/designations/languages)
- optional pagination when the planner proves provider-side pagination is safe
- a provider work cap (`limitCount`)

Each include/exclude entry is one compose shape: concept list, filter set, or whole system. Optional `intersectCodes` constrains that entry to precomputed import intersections.

The response is normalized for ingestion:

- `codes`: rows with code/display/status and optional designations/properties
- `total`: exact cardinality when known
- `notClosed`: open-set signal
- optional provider-specific flags such as `tooCostly`

## Expand worker architecture

`expand-v2` is structured as planner plus executor with a single ingestion path.

The planner compiles compose into `ExpandPlan` groups. System groups are pushdown candidates; import-only groups are executed as nested ValueSet expansion sources. Grouping is deterministic and keeps system-local optimization possible without losing global semantics.

Execution is hybrid. For each system group, the worker attempts pushdown based on provider capabilities and plan constraints. If pushdown is not supported or declined, the worker executes fallback iteration for that group. Import groups are handled by nested expansion and then merged into the same membership flow.

All candidate rows, regardless of source, go through shared ingestion logic for dedupe, exclusion coverage, paging state, and rendering into `expansion.contains`. This is the core reason pushdown and fallback can be compared safely: they do not produce separate output semantics.

Rendering concerns remain downstream of membership. Display/designations/properties are attached in a controlled output path rather than driving membership decisions.

## Semantic safety rules

The worker enforces three invariants.

First, excludes are global. A provider may apply a subset in pushdown, but the worker remains responsible for ensuring uncovered excludes are still enforced before final membership is accepted.

Second, pagination must operate on final membership. Provider-side pagination is used only when the planner can prove that provider results already represent the relevant final membership for that stream. Otherwise pagination is applied by the worker after reconciliation.

Third, totals are not fabricated. Exact totals are included when known; otherwise totals are omitted rather than estimated from partial progress.

## Fallback and pushdown as complementary engines

Fallback is the correctness baseline and interoperability path. It works across providers that do not implement grouped pushdown and across mixed-provider compose structures.

Pushdown is a targeted optimization path. It is used when the provider can evaluate the grouped request faithfully and return rows in a form the worker can ingest without changing semantics.

Because both paths feed one ingestion and output model, the system can optimize aggressively where safe while preserving one behavioral contract.

## Implementation guidance for provider authors

A provider implementing `expandQuery` should treat the request as set logic over one system group and return a membership-complete row set for that delegated scope. If a request shape cannot be represented safely, returning `null` is the correct behavior and lets the worker fall back.

Capability declarations should be conservative and truthful. Overstating capability is dangerous because it can force unsafe delegation; understating capability only reduces optimization opportunities.

## Summary

The new interface is intentionally small: capability signaling plus grouped query delegation. The new worker design is intentionally layered: plan, execute, ingest, render. That combination gives a cleaner separation of concerns and a stable place to evolve provider performance without changing expansion semantics.
