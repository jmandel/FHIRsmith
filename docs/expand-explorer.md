# Expand Explorer — Pipeline Tutorial and Capability Showcase

This explorer is a practical way to execute full-strength FHIR `$expand`
requests and inspect not only the expansion results, but the internal pipeline
used to produce them.

It is intended for readers who already understand FHIR terminology semantics
and want visibility into execution strategy: IR construction, import
reconciliation, lowering, provider partitioning, pushdown, and trace-level SQL.

Hosted explorer:

- `https://valueset-expander.exe.xyz/expand-explorer.html`

## What this tool lets you do

You can run complex `ValueSet` definitions with real parameters:

- `count`, `offset`, `filter`
- `property` selection
- `includeDesignations`, `activeOnly`
- `useSupplement`
- `txResources` (inline CodeSystem / ValueSet resources for imports and overlays)

And you can inspect the resulting pipeline artifacts:

1. `Results`:
The final expansion output (`contains`, `total`, properties/designations).

2. `Semantic IR`:
The direct algebra from compose-level semantics (`Union`, `Intersect`, `Diff`,
`Selector`, `Import`).

3. `Resolved IR`:
IR after resolving imported ValueSets and reconciling nested include/exclude
graphs.

4. `Query IR`:
Provider-compilable representation when lowering succeeds for a target slice.

5. `Trace`:
Execution spans and SQL calls, with enough detail to see pushdown vs fallback
behavior and timing hotspots.

6. `Raw Response`:
Full debug payload from the expand endpoint.

## Pipeline tutorial: from request to result

### Stage 1: Build semantic set algebra from compose

Start by understanding that the engine models expansion as global set algebra:

- includes as unions/intersections
- excludes as a global subtraction

Use:

- [SNOMED complex include/exclude](https://valueset-expander.exe.xyz/expand-explorer.html#SNOMED%20complex%20include%2Fexclude)

What to look at:

- `Semantic IR` should clearly show a `Diff` whose left/right sides are unions.
- `Results` should align with the expected final set semantics.

### Stage 2: Resolve imports across resource boundaries

Next, inspect how imported ValueSets are expanded into the working expression.

Use:

- [Deep import include graph](https://valueset-expander.exe.xyz/expand-explorer.html#Deep%20import%20include%20graph)
- [Deep import include minus exclude graph](https://valueset-expander.exe.xyz/expand-explorer.html#Deep%20import%20include%20minus%20exclude%20graph)

What to look at:

- `Resolved IR` should show flattened/reconciled structure from nested
  `txResources` imports.
- You should see how deep include/exclude graphs become executable set
  operations.

### Stage 3: Partition by system/provider and lower where possible

After resolution, the engine partitions work by system/provider boundaries and
lowers eligible slices toward query-target execution.

Use:

- [Deep mixed import graph (SNOMED+LOINC)](https://valueset-expander.exe.xyz/expand-explorer.html#Deep%20mixed%20import%20graph%20(SNOMED%2BLOINC))
- [Deep mixed include-minus-exclude (SNOMED+LOINC)](https://valueset-expander.exe.xyz/expand-explorer.html#Deep%20mixed%20include-minus-exclude%20(SNOMED%2BLOINC))

What to look at:

- `Resolved IR` should still reflect global semantics.
- `Trace` should reflect separate execution slices for SNOMED and LOINC work.
- `Query IR` should appear where a slice is compilable for provider pushdown.

### Stage 4: Execute pushdown-capable slices at SQL scale

For query-target providers, large filters and paging should stay provider-local.

Use:

- [SNOMED is-a deep page](https://valueset-expander.exe.xyz/expand-explorer.html#SNOMED%20is-a%20deep%20page)
- [LOINC STATUS=ACTIVE deep page](https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20STATUS%3DACTIVE%20deep%20page)
- [RxNorm TTY=SBD](https://valueset-expander.exe.xyz/expand-explorer.html#RxNorm%20TTY%3DSBD)
- [SNOMED code regex 7.*](https://valueset-expander.exe.xyz/expand-explorer.html#SNOMED%20code%20regex%207.*)

What to look at:

- `Trace` timing and SQL cards should show bounded/paged database execution.
- Returned page sizes should match requested `count` where available.

### Stage 5: Evaluate count behavior and total policy

Count-only is a useful way to inspect total computation without result payload.

Use:

- [SNOMED complex count-only](https://valueset-expander.exe.xyz/expand-explorer.html#SNOMED%20complex%20count-only)

What to look at:

- `Results` intentionally has empty `contains` for `count=0`.
- `total` should be present when the count path can be computed.

### Stage 6: Apply supplements for filtering and decoration

Supplements are first-class in execution and output: they can influence
membership (via filter clauses) and decoration (properties/designations).

Use:

- [LOINC supplement d20 filter](https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20supplement%20d20%20filter)
- [LOINC supplement d20+d8 filter](https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20supplement%20d20%2Bd8%20filter)
- [LOINC supplement decoration-only](https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20supplement%20decoration-only)
- [RxNorm filter + supplement decoration](https://valueset-expander.exe.xyz/expand-explorer.html#RxNorm%20filter%20%2B%20supplement%20decoration)

What to look at:

- `Results` should include requested supplement properties and designations.
- `Trace` should show whether supplement predicates were handled natively in the
  provider execution path.

### Stage 7: Mix execution families safely

The same expansion can combine query-target, legacy/internal, and base-only
providers while preserving global semantics.

Use:

- [LOINC + USPS mixed providers](https://valueset-expander.exe.xyz/expand-explorer.html#LOINC%20%2B%20USPS%20mixed%20providers)
- [Cross-provider excludes](https://valueset-expander.exe.xyz/expand-explorer.html#Cross-provider%20excludes)
- [UCUM base-only path](https://valueset-expander.exe.xyz/expand-explorer.html#UCUM%20base-only%20path)
- [TX-resource import + sqlite peer](https://valueset-expander.exe.xyz/expand-explorer.html#TX-resource%20import%20%2B%20sqlite%20peer)

What to look at:

- `Results` should still reflect one global include-minus-exclude contract.
- `Trace` should make partitioned execution visible across provider families.

### Stage 8: Observe rewrite-specific optimizations

These cases are useful for showing optimizer behavior, not only correctness.

Use:

- [Import+filter intersection lowering](https://valueset-expander.exe.xyz/expand-explorer.html#Import%2Bfilter%20intersection%20lowering)
- [Import exclude lowering](https://valueset-expander.exe.xyz/expand-explorer.html#Import%20exclude%20lowering)
- [Union merge lowering](https://valueset-expander.exe.xyz/expand-explorer.html#Union%20merge%20lowering)
- [Provider-disjoint exclude pruning](https://valueset-expander.exe.xyz/expand-explorer.html#Provider-disjoint%20exclude%20pruning)

What to look at:

- Compare `Semantic IR` and `Resolved IR`.
- Confirm pruning/merging/lowering intent in `Query IR` and `Trace`.

## Suggested demo flow (15–20 minutes)

1. `SNOMED complex include/exclude`
2. `Deep mixed include-minus-exclude (SNOMED+LOINC)`
3. `LOINC STATUS=ACTIVE deep page`
4. `LOINC supplement d20+d8 filter`
5. `LOINC + USPS mixed providers`
6. `Cross-provider excludes`

This sequence gives a coherent narrative:

- semantics,
- import reconciliation,
- lowering and partitioning,
- high-scale pushdown,
- supplements,
- hybrid execution correctness.
