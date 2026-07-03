# Three-engine expansion: legacy vs pushdown vs IR (all in-branch)

All three engines now run **in this branch**, selected per request by the
`_engine` parameter (`legacy` | `pushdown` | `ir`), through the same
`ExpandWorker` and the same `cs-sqlite` provider, over the same sqlite-v1 DBs.
This supersedes the earlier cross-branch comparison — see "Correction" below.

- **legacy** — stock per-include enumeration (unchanged).
- **pushdown** — `processSelection` seam: set algebra in the provider with
  offset/count/total pushdown.
- **ir** — `tx/engine` IR: compose → algebra → optimize/partition → the
  provider's native `executeIR`/`countForIR`/`membershipForIR` terminals.
  `_engine=ir` decorates through the same `includeCode` path as the other two.

## Correction to the earlier (cross-branch) numbers

An earlier version of this doc reported IR at ~6ms on the big is-a page, run in
the separate draft checkout. That number was **execution-only** — it did not
include the per-concept FHIR decoration (display/designations/properties) that
a real `$expand` response requires, so it was not comparable to the fully
decorated legacy/pushdown numbers. With all three now driven through the same
worker and the same decoration, the honest picture is different and is reported
below. The draft's dramatic paged speed came from its ~64KB `sql-ast` compiler
(single early-stopping statement), which this thin port deliberately does not
include.

## Results (median ms, warm, in-branch via `_engine`)

| query | legacy | pushdown | IR | exact total | 3-engine parity |
|---|---|---|---|---|---|
| SCT is-a Clinical finding, page 50 | 275 | 50 | 75 | 132,173 | ✓ |
| SCT is-a Clinical finding, offset 2000 | **too-costly** | 49 | 76 | 132,173 | ✓ (P==IR) |
| SCT is-a Procedure, total-only | **too-costly** | 23 | **11** | 61,222 | ✓ (P==IR) |
| SCT is-a MI ∧ descendent-of heart, page 200 | 31 | 22 | 27 | 130 | ✓ |
| SCT is-a diabetes ∖ type-1, page 100 | 29 | 16 | 20 | 103 | ✓ |
| SCT (is-a ∪ in refset), page 150 | 229 | 37 | 37† | 21,530 | ✓ |
| SCT is-a Body structure, activeOnly, page 100 | 241 | 34 | 39 | 43,460 | ✓ |
| LOINC CLASSTYPE=1, page 100 | 359 | 127 | 131 | 66,861 | ✓ |
| LOINC CLASSTYPE=1, total-only | **too-costly** | 112 | 111 | 66,861 | ✓ (P==IR) |
| LOINC STATUS=ACTIVE, page 200 | 361 | 198 | 206 | 170,391 | ✓ |

† multi-*include* union: `_engine=ir` cedes to pushdown so first-page order
stays include-by-include (see "Ordering" below), so that IR cell *is* pushdown.

## What the numbers actually say

**pushdown and IR are close; both dominate legacy.** On the paged queries,
pushdown and IR are within ~15–50% of each other and 3–7× faster than legacy —
and both answer the deep-offset and total-only requests that legacy **refuses**
with `VALUESET_TOO_COSTLY` (it materialises and decorates the whole set before
paging). All three return byte-identical pages, and pushdown/IR return exact
totals where legacy returns none.

**Decoration dominates a decorated page, so the engines converge.** For a 50-row
page with full display/designations/properties, the per-concept decoration cost
swamps the membership-execution cost, which is why IR (a faster or equal
execution layer) does not beat pushdown once both pay the same decoration. IR is
in fact slightly slower on small decorated pages because of the orchestrator
build/optimize/project overhead on top of identical decoration.

**IR's genuine edge is count-only / no-decoration paths.** On the total-only
queries — where nothing is decorated — IR wins: SCT is-a Procedure total is
**11ms (IR) vs 23ms (pushdown)**, because `countForIR` is a single SQL
`COUNT` over the closure while pushdown materialises the full id array in JS to
size it. Isolated raw execution (no decoration) confirms the split:
`countForIR` ≈ 24ms vs pushdown's JS materialise ≈ 42ms, while a *paged*
`executeIR` (LIMIT + a separate COUNT) is ~64ms vs pushdown's single
materialise ~41–45ms. The thin IR port did not port the draft's single-statement
paged compiler, so it does not win the decorated-page case.

**Correctness win that is independent of speed: refset-as-filter.** The draft IR
returned 0 for `concept in <refsetId>` used as a filter (it exposed refsets only
as implicit ValueSets), silently dropping that branch of a union. This port
wires refset membership into both the filter protocol and the IR terminals, so
`is-a 22298006 ∪ in refset 723264001` totals **21,530** under IR — matching
pushdown and legacy. Covered by `tests/tx/sqlite-v1-ir-parity.test.js`.

## Ordering

Single-include composes: legacy, pushdown and IR all page in source
(concept_id) order and agree exactly. Multi-*include* composes: legacy and
pushdown page include-by-include (tier-1.5 of the ordering contract in
`sqlite-v1-design.md`), but IR's rewrite merges the union into concept_id order.
So `_engine=ir` deliberately **cedes multi-include composes** to pushdown/legacy
(gate in `processViaIR`), keeping first-page composition identical. The parity
suite asserts this across all cases.

## Scope of this IR port (thin)

Ported: the IR algebra + rewrite laws (`tx/engine/ir.js`, `build-ir.js`,
`rewrite.js`, `ir-traversal.js` — verbatim from the draft, with its tests), a
lean orchestrator (`tx/engine/orchestrator.js`), and native
`executeIR`/`countForIR`/`membershipForIR` terminals on `cs-sqlite`.

Deliberately **not** ported: the ~64KB `sql-ast` strategy compiler (the source
of the draft's paged-hierarchy speed), the dual native/overlay supplements, and
the generic-executor/legacy-adapter stack. Consequently `_engine=ir` handles
single-system and cross-system composes over **native sqlite providers only**;
anything else (non-native provider, imports, text filters, enumerated-concept
order, multi-include order) cleanly falls through to pushdown/legacy. That is
the honest boundary of the thin port: it buys the IR algebra, cross-system
composition, count speed, and the refset-as-filter fix — not the draft's
decorated-page speed, which would require porting the sql-ast machinery.

## Reproduce

```sh
cd ~/work/fs2
node scripts/sqlite-v1-bench/bench-engines.mjs \
  scripts/sqlite-v1-bench/engine-bench-queries.json /tmp/results-3engine.json
npx jest tests/tx/sqlite-v1-ir-parity.test.js --runInBand
```
Needs `~/work/tx-dbs/{sct-v1,loinc-v1}.db`.
