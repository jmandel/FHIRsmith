# Expand Explorer — V3 Tutorial, Showcase, and Deep-Link Catalog

This guide is for terminology architects and implementers who want to inspect
how this `$expand` engine behaves under realistic workloads, not just toy
examples.

The explorer shows:

- expansion output,
- semantic IR,
- resolved IR (after import/rewrites),
- query IR (when compilable),
- SQL + trace spans.

Use this document as:

- a tutorial for how to read the explorer,
- a curated manifest of advanced demos,
- a set of deep links you can share directly.

## Hosted Explorer

- `https://valueset-expander.exe.xyz/expand-explorer.html`

Deep links use the hash fragment with the test name. Example:

- `https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20%2B%20USPS%20mixed%20providers`

The explorer resolves deep links by exact name, case-insensitive name, and a
slug-style fallback so links remain robust across punctuation differences.

## How to Read a Run

1. Open a deep link from the catalog below.
2. Inspect `Semantic IR` to confirm the request-level algebra.
3. Inspect `Resolved IR` to confirm import expansion and reconciliation.
4. Inspect `Query IR` to see if the expression lowered to provider-level query form.
5. Inspect `Trace` for timings and SQL shape to confirm pushdown/partition behavior.
6. Inspect `Results` to verify membership and returned metadata.

## Capability Areas and Why Each Example Exists

### 1) SQL Pushdown Core

Use these to show that large-system work can stay provider-local and fast.

- [SNOMED is-a deep page](https://valueset-expander.exe.xyz/expand-explorer.html#SNOMED%20is-a%20deep%20page)
- [SNOMED complex include/exclude](https://valueset-expander.exe.xyz/expand-explorer.html#SNOMED%20complex%20include%2Fexclude)
- [SNOMED complex count-only](https://valueset-expander.exe.xyz/expand-explorer.html#SNOMED%20complex%20count-only)
- [LOINC STATUS=ACTIVE deep page](https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20STATUS%3DACTIVE%20deep%20page)
- [RxNorm TTY=SBD](https://valueset-expander.exe.xyz/expand-explorer.html#RxNorm%20TTY%3DSBD)
- [SNOMED code regex 7.*](https://valueset-expander.exe.xyz/expand-explorer.html#SNOMED%20code%20regex%207.*)
- [LOINC supplement d20 filter](https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20supplement%20d20%20filter)
- [LOINC supplement d20+d8 filter](https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20supplement%20d20%2Bd8%20filter)
- [LOINC supplement decoration-only](https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20supplement%20decoration-only)
- [RxNorm filter + supplement decoration](https://valueset-expander.exe.xyz/expand-explorer.html#RxNorm%20filter%20%2B%20supplement%20decoration)

What these demonstrate:

- deep pagination on large code systems,
- same-provider include/exclude algebra,
- `count=0` count retrieval path,
- property and regex filters in query-target providers,
- supplement-aware filtering and decoration in the same execution path.

### 2) IR Rewriting and Lowering

Use these to show import reconciliation, set-algebra lowering, and partitioning.

- [Import+filter intersection lowering](https://valueset-expander.exe.xyz/expand-explorer.html#Import%2Bfilter%20intersection%20lowering)
- [Import exclude lowering](https://valueset-expander.exe.xyz/expand-explorer.html#Import%20exclude%20lowering)
- [Deep import include graph](https://valueset-expander.exe.xyz/expand-explorer.html#Deep%20import%20include%20graph)
- [Deep import include minus exclude graph](https://valueset-expander.exe.xyz/expand-explorer.html#Deep%20import%20include%20minus%20exclude%20graph)
- [Deep mixed import graph (SNOMED+LOINC)](https://valueset-expander.exe.xyz/expand-explorer.html#Deep%20mixed%20import%20graph%20(SNOMED%2BLOINC))
- [Deep mixed include-minus-exclude (SNOMED+LOINC)](https://valueset-expander.exe.xyz/expand-explorer.html#Deep%20mixed%20include-minus-exclude%20(SNOMED%2BLOINC))
- [Union merge lowering](https://valueset-expander.exe.xyz/expand-explorer.html#Union%20merge%20lowering)
- [Provider-disjoint exclude pruning](https://valueset-expander.exe.xyz/expand-explorer.html#Provider-disjoint%20exclude%20pruning)

What these demonstrate:

- IR reconciliation across tx-resource ValueSet boundaries,
- include/exclude lowering from imports into executable set operations,
- multi-system partitioning (`SNOMED` and `LOINC`) under deep import graphs,
- provider-disjoint pruning (excludes that cannot affect a given system slice).

### 3) Hybrid Execution (Query-Target + Legacy/Base)

Use these to show one request can mix execution families safely.

- [LOINC + USPS mixed providers](https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20%2B%20USPS%20mixed%20providers)
- [Cross-provider excludes](https://valueset-expander.exe.xyz/expand-explorer.html#Cross-provider%20excludes)
- [UCUM base-only path](https://valueset-expander.exe.xyz/expand-explorer.html#UCUM%20base-only%20path)
- [TX-resource import + sqlite peer](https://valueset-expander.exe.xyz/expand-explorer.html#TX-resource%20import%20%2B%20sqlite%20peer)

What these demonstrate:

- system-partitioned execution with different provider families,
- global include/exclude semantics across providers,
- base-only grammar-backed systems beside query-target systems,
- tx-resource imports coexisting with sqlite-backed provider slices.

## Suggested Walkthrough Sequence

Use this sequence when demoing to terminology-server engineers:

1. `SNOMED complex include/exclude` for set algebra and SQL pushdown.
2. `SNOMED complex count-only` for count optimization behavior.
3. `LOINC supplement d20+d8 filter` for supplement-aware filtering.
4. `Deep mixed include-minus-exclude (SNOMED+LOINC)` for deep import reconciliation and partitioning.
5. `LOINC + USPS mixed providers` for hybrid execution across provider families.
6. `Cross-provider excludes` for global semantics confirmation.

## Notes

- `SNOMED complex count-only` intentionally returns empty `contains` because `count=0` requests total-only behavior.
- If a link stops matching after a future rename, hash matching still attempts
  slug fallback; update this document when test names materially change.
