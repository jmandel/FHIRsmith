# Microscope: A Supplement-Aware IR Expansion

This is a worked example of one supplement-aware request moving through the new
engine.

The goal is not to restate the architecture docs. The goal is to make one real
request legible end to end:

1. what the client sends
2. which supplements are resolved
3. what IR gets compiled
4. what the sqlite-v0 execution compiler builds
5. what SQL actually runs
6. what comes back in the response

This document is based on a real traced request run against the current branch.
The example uses a small synthetic sqlite-v0 base system plus a configured
sqlite supplement sidecar so every stage stays readable.

See also:

- [supplement-architecture.md](supplement-architecture.md)
- [sqlite-v0-execution-compiler.md](sqlite-v0-execution-compiler.md)
- [ir-engine.md](ir-engine.md)

## Why this example

This request exercises the important supplement behaviors without dragging in
import resolution or multi-system pagination:

1. a supplement-backed property filter
2. supplement-backed designation text search
3. native sqlite supplement attachment
4. final response designations and `used-supplement`

The base code system is `http://example.org/base|1`.

The configured supplement is:

- canonical: `http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20|1`
- target: `http://example.org/base|1`
- source kind: `sqlite-native`

The supplement adds:

- property `d20-roll` (integer)
- several other additive properties
- designation `"D20 critical success"` for high-roll codes

## Stage 0: what the server has loaded

The sqlite-v0 source is configured with one supplement sidecar:

```yaml
base:
  url: https://storage.googleapis.com/tx-fhir-org
sources:
  - source: sqlite-v0:/tmp/sqlite-v0-supp-config-o2a71h/base.v0.db
    options:
      traceIrCompilerPlans: true
      supplements:
        - d20.supp.db
```

Important point:

- the request still has to opt in with `useSupplement`
- loading a sidecar does not auto-activate it

The sidecar advertises its own descriptor through `registerSqliteSupplements()`
on the sqlite-v0 factory. That descriptor is what the supplement resolver sees.

## Stage 1: the request

The client sends:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "_engine", "valueCode": "ir" },
    { "name": "_trace", "valueBoolean": true },
    {
      "name": "useSupplement",
      "valueString": "http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20"
    },
    { "name": "includeDesignations", "valueBoolean": true },
    { "name": "displayLanguage", "valueCode": "en" },
    { "name": "count", "valueInteger": 5 },
    { "name": "filter", "valueString": "critical success" },
    {
      "name": "valueSet",
      "resource": {
        "resourceType": "ValueSet",
        "status": "active",
        "compose": {
          "include": [
            {
              "system": "http://example.org/base",
              "filter": [
                { "property": "d20-roll", "op": "=", "value": "20" }
              ]
            }
          ]
        }
      }
    }
  ]
}
```

Semantically:

1. base membership is `d20-roll = 20`
2. runtime text filter is `"critical success"`
3. designations should be returned
4. only codes from the explicitly requested supplement are in play

## Stage 2: explicit supplement refs are collected

`ExpandWorker` collects supplement refs from:

1. `useSupplement`
2. `valueset-supplement` extension on the ValueSet

Code path:

- `tx/workers/expand.js`
  - `collectExplicitSupplementRefs(...)`

For this request the result is one explicit ref:

```json
[
  {
    "canonical": "http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20",
    "url": "http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20",
    "version": null,
    "source": "useSupplement",
    "order": 0
  }
]
```

The request is intentionally unversioned. Matching to the concrete
`.../d20|1` descriptor happens during supplement resolution against the base
scope.

## Stage 3: supplement registry and base-scope resolution

`TerminologyWorker.buildSupplementRegistryForIR()` builds a registry from:

1. inline `tx-resource` `CodeSystem`s
2. registered in-memory `CodeSystem`s
3. provider factories
4. provider sqlite sidecars

Code path:

- `tx/workers/worker.js`
  - `buildSupplementRegistryForIR(...)`
- `tx/supplements/registry.js`
  - `buildSupplementRegistry(...)`

For this example the registry contains one entry:

```json
[
  {
    "descriptor": {
      "canonical": "http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20|1",
      "url": "http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20",
      "version": "1",
      "targetSystem": "http://example.org/base",
      "targetVersion": "1",
      "sourceKind": "sqlite-native",
      "displayName": "Synthetic Base D20 synthetic supplement"
    },
    "precedence": 30
  }
]
```

Then `resolveSupplementsForIRBaseScope(...)` binds that registry to the concrete
base scope:

```json
{
  "target": {
    "system": "http://example.org/base",
    "version": "1"
  },
  "matchedRefKeys": [
    "http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20"
  ],
  "unresolvedRefs": [],
  "items": [
    {
      "descriptor": {
        "canonical": "http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20|1",
        "sourceKind": "sqlite-native"
      },
      "requestRef": {
        "canonical": "http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20"
      },
      "overlaySourceKind": "codesystem-resource",
      "nativeBindingSource": {
        "kind": "sqlite-sidecar",
        "dbPath": "/tmp/sqlite-v0-supp-config-o2a71h/d20.supp.db"
      }
    }
  ]
}
```

Important points:

1. the resolved item carries both an overlay source and a native binding source
2. the native sidecar is what sqlite-v0 will use
3. the overlay `CodeSystem` remains available for generic fallback paths
4. sqlite sidecar overlay materialization is lazy in the runtime; it is not
   required for the native sqlite path

The example dump above explicitly materialized the overlay too so both branches
are visible in one place. The native sqlite path does not need that overlay to
run the request.

## Stage 4: semantic IR compilation

The ValueSet itself is supplement-agnostic. The supplement does not appear in
the IR.

Code path:

- `tx/engine/build-ir.js`
- `tx/engine/rewrite.js`

Raw canonical IR:

```text
canonical-ir-hash: 46d1e287ba9188c7a66c3812944032d69160171d
canonical-ir:
  selector filter http://example.org/base d20-roll = 20 [n]
```

Optimized IR with runtime constraints recorded separately:

```text
systems: http://example.org/base
canonical-ir-hash: 46d1e287ba9188c7a66c3812944032d69160171d
runtime-constraints:
  text-filter: "critical success"
  pagination: offset=0 count=5
optimized-ir:
  selector filter http://example.org/base d20-roll = 20 [n]
```

Projected subtree for sqlite-v0:

```text
canonical-ir-hash: 46d1e287ba9188c7a66c3812944032d69160171d
canonical-ir:
  selector filter http://example.org/base d20-roll = 20 [n]
```

Key idea:

- the filter clause is still just `d20-roll = 20`
- nothing in the semantic IR says where that property comes from
- supplement-awareness is introduced later, at provider execution time

## Stage 5: provider resolution and native supplement attachment

The orchestrator resolves the only system bucket:

- system: `http://example.org/base`
- selector version: unversioned
- provider version: `1`

Then `findProvider(...)` returns sqlite-v0, and the worker calls:

- `provider.attachIRSupplements(supplementSet)`

Code path:

- `tx/workers/expand.js`
- `tx/workers/worker.js`
- `tx/cs/cs-sqlite-v0.js`

The sqlite-v0 provider binds the supplement natively:

```json
[
  {
    "alias": "supp_742fac9e0e93",
    "sourceKind": "sqlite-sidecar",
    "descriptor": {
      "canonical": "http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20|1"
    },
    "propertyDefs": [
      {
        "property_code": "d20-roll",
        "value_kind": "literal",
        "source_type": "integer"
      },
      {
        "property_code": "dice-band",
        "value_kind": "literal",
        "source_type": "code"
      },
      {
        "property_code": "damage-type",
        "value_kind": "literal",
        "source_type": "code"
      }
    ]
  }
]
```

Important point:

- the attached alias is an implementation detail
- the important information is the effective property manifest the compiler now
  sees for this request

## Stage 6: provider-private compilation

sqlite-v0 now compiles the scoped subtree.

Code path:

- `tx/cs/sqlite-v0-compiler.js`
- `tx/cs/sqlite-v0-plan-builder.js`
- `tx/cs/sqlite-v0-sql-ast.js`
- `tx/cs/sqlite-v0-sql-emit.js`

### 6.1 Base membership plan

The base `SetPlan` is:

```text
kind: "fromRows"
key: "source_concept_id"
rows:
  kind: "filter"
  input:
    kind: "scan"
    table: "concept_literal"
    as: null
  predicate:
    kind: "literalPropertyMatch"
    property: "d20-roll"
    values:
      - "20"
```

This is the first subtle but important point in the pipeline:

1. the base plan is still expressed over abstract row families like
   `concept_literal`
2. it does **not** mention the sidecar alias yet
3. supplement-aware lowering happens later, when SQL AST generation sees the
   active `supplementBindings`

That separation is intentional. It keeps the provider-private logical plan
small and stable.

### 6.2 Selected membership plan

Runtime text search is then intersected with base membership:

```text
kind: "intersect"
items:
  -
    kind: "fromRows"
    key: "concept_id"
    rows:
      kind: "search"
      text: "critical success"
      spec:
        sources:
          - "designation"
          - "literal"
        activeOnlyConcepts: true
        designationActiveOnly: true
        literalActiveOnly: true
  -
    kind: "fromRows"
    key: "source_concept_id"
    rows:
      kind: "filter"
      input:
        kind: "scan"
        table: "concept_literal"
      predicate:
        kind: "literalPropertyMatch"
        property: "d20-roll"
        values:
          - "20"
```

Key point:

- the text filter is runtime state, not semantic IR
- it enters at provider compilation time, not in `build-ir.js`

### 6.3 Terminal and physical plans

Terminal plan:

```text
kind: "materializeConcepts"
columns:
  - "active"
  - "code"
  - "concept_id"
  - "definition"
  - "display"
includeTotal: false
orderBy:
  -
    key: "code"
    direction: "asc"
offset: 0
count: 5
members:
  kind: "fromRows"
  key: "source_concept_id"
  rows:
    kind: "filter"
    input:
      kind: "scan"
      table: "concept_literal"
    predicate:
      kind: "literalPropertyMatch"
      property: "d20-roll"
      values:
        - "20"
```

Physical plan summary:

```text
kind: "materialize"
strategy: "ordered-materialize"
selection:
  activeOnly: false
  text: "critical success"
members:
  kind: "fromRows"
  strategy: "row-source"
  key: "source_concept_id"
  rows:
    kind: "row-filter"
    strategy: "literal-in"
    predicate:
      kind: "literalPropertyMatch"
      property: "d20-roll"
      values:
        - "20"
```

For this request there is no count query because:

1. `count=5`
2. `offset=0`
3. only `2` rows were returned

So the orchestrator infers `total=2` from the returned page.

## Stage 7: SQL AST and emitted SQL

By the time SQL AST lowering runs, the compiler has enough information to make
the abstract plan supplement-aware.

Two things happen:

1. the runtime text search over `designation` and `literal` becomes a union over
   both base tables and supplement FTS tables
2. the abstract `d20-roll = 20` literal-property match becomes a supplement-side
   `supplement_literal` subquery because that property exists only in the active
   sidecar binding

The emitted SQL is:

```sql
SELECT
  "c"."active" AS "active",
  "c"."code" AS "code",
  "c"."concept_id" AS "concept_id",
  "c"."definition" AS "definition",
  "c"."display" AS "display"
FROM "concept" "c"
WHERE (
  ("c"."cs_id" = @cs_id_3)
  AND "c"."concept_id" IN (
    SELECT DISTINCT "d"."concept_id" AS "concept_id"
    FROM "search_fts_designation" "f"
    INNER JOIN "designation" "d" ON ("d"."designation_id" = "f"."rowid")
    INNER JOIN "concept" "c" ON ("c"."concept_id" = "d"."concept_id")
    WHERE (
      ("c"."cs_id" = @designation_cs_id_5)
      AND ("c"."active" = 1)
      AND ("d"."active" = 1)
      AND ("f"."term" MATCH @search_match_4)
    )
    UNION
    SELECT DISTINCT "c"."concept_id" AS "concept_id"
    FROM "supp_742fac9e0e93"."search_fts_designation" "f"
    INNER JOIN "supp_742fac9e0e93"."supplement_designation" "sd"
      ON ("sd"."designation_id" = "f"."rowid")
    INNER JOIN "concept" "c" ON ("c"."code" = "sd"."source_code")
    WHERE (
      ("c"."cs_id" = @supp_designation_cs_id_6)
      AND ("c"."active" = 1)
      AND ("sd"."active" = 1)
      AND ("f"."term" MATCH @search_match_4)
    )
    UNION
    SELECT DISTINCT "cl"."source_concept_id" AS "concept_id"
    FROM "search_fts_literal" "f"
    INNER JOIN "concept_literal" "cl" ON ("cl"."literal_id" = "f"."rowid")
    INNER JOIN "concept" "c" ON ("c"."concept_id" = "cl"."source_concept_id")
    WHERE (
      ("c"."cs_id" = @literal_cs_id_7)
      AND ("c"."active" = 1)
      AND ("cl"."active" = 1)
      AND ("f"."term" MATCH @search_match_4)
    )
    UNION
    SELECT DISTINCT "c"."concept_id" AS "concept_id"
    FROM "supp_742fac9e0e93"."search_fts_literal" "f"
    INNER JOIN "supp_742fac9e0e93"."supplement_literal" "sl"
      ON ("sl"."literal_id" = "f"."rowid")
    INNER JOIN "concept" "c" ON ("c"."code" = "sl"."source_code")
    WHERE (
      ("c"."cs_id" = @supp_literal_cs_id_8)
      AND ("c"."active" = 1)
      AND ("sl"."active" = 1)
      AND ("f"."term" MATCH @search_match_4)
    )
  )
  AND EXISTS (
    SELECT 1 AS "found"
    FROM (
      SELECT
        "src"."concept_id" AS "source_concept_id",
        "sl"."property_code" AS "property_code",
        "sl"."value_raw" AS "value_raw",
        "sl"."value_text" AS "value_text",
        "sl"."value_num" AS "value_num",
        "sl"."value_bool" AS "value_bool",
        "sl"."group_id" AS "group_id",
        "sl"."active" AS "active"
      FROM "supp_742fac9e0e93"."supplement_literal" "sl"
      INNER JOIN "concept" "src" ON ("src"."code" = "sl"."source_code")
      WHERE (
        ("src"."cs_id" = @supp_literal_src_cs_id_2)
        AND ("sl"."active" = 1)
        AND ("sl"."property_code" = @supp_prop_code_0)
        AND (
          "sl"."value_text" COLLATE NOCASE IN (@supp_prop_value_1)
          OR (
            ("sl"."value_text" IS NULL)
            AND "sl"."value_raw" COLLATE NOCASE IN (@supp_prop_value_1)
          )
        )
      )
    ) "r"
    WHERE (
      ("r"."source_concept_id" = "c"."concept_id")
      AND ("r"."source_concept_id" IS NOT NULL)
    )
  )
)
ORDER BY "c"."code" ASC
LIMIT 5
```

Parameters:

```json
{
  "supp_prop_code_0": "d20-roll",
  "supp_prop_value_1": "20",
  "supp_literal_src_cs_id_2": 1,
  "cs_id_3": 1,
  "search_match_4": "\"critical success\"",
  "designation_cs_id_5": 1,
  "supp_designation_cs_id_6": 1,
  "literal_cs_id_7": 1,
  "supp_literal_cs_id_8": 1
}
```

Why this is a good example:

1. the text filter is applied against both base and supplement FTS sources
2. the property filter is applied only against the supplement-side literal rows
3. no caller-visible logic needed to say "this property came from the supplement"

That source selection happens inside the provider-private compiler and SQL
lowering.

## Stage 8: response shaping

The response contains two codes:

```json
{
  "contains": [
    {
      "code": "C0015",
      "display": "Code 15",
      "designation": [
        {
          "language": "en",
          "value": "D20 critical success"
        }
      ]
    },
    {
      "code": "C0020",
      "display": "Code 20",
      "designation": [
        {
          "language": "en",
          "value": "D20 critical success"
        }
      ]
    }
  ]
}
```

And the expansion parameters include:

```json
[
  { "name": "used-codesystem", "valueUri": "http://example.org/base|1" },
  {
    "name": "used-supplement",
    "valueUri": "http://example.org/fhir/CodeSystem/microscope-dice/example-org-base/d20|1"
  }
]
```

That is the final semantic contract:

1. filter matched against supplement property values
2. runtime text matched against supplement designations
3. output contains supplement designations
4. response declares which supplement was actually used

## What the trace is good for now

With `_trace=true` and `traceIrCompilerPlans: true`, the request now records:

1. per-system execution spans
2. full emitted SQL with params and timings
3. full compiler note payloads:
   - base plan
   - selected plan
   - terminal plan
   - physical plan
   - SQL AST summary

That matters because the compiler plan strings are no longer truncated in the
structured trace payload.

## What would happen without native attachment

The same request can still work when the resolved provider does not support
native supplement attachment.

In that case:

1. the resolver materializes supplement `CodeSystem` overlays
2. the worker falls back into the existing `CodeSystem[]` supplement provider
   machinery
3. the IR path wraps the provider with `wrapIRProviderWithSupplements(...)`
4. supplement-touched clauses are evaluated generically over merged base +
   overlay values

That path is slower but semantically equivalent. The important design boundary
is that the request-level supplement resolution is the same either way.

## Files worth reading after this example

- `tx/workers/expand.js`
  - `collectExplicitSupplementRefs(...)`
  - `_tryIRExpansion(...)`
- `tx/workers/worker.js`
  - `buildSupplementRegistryForIR(...)`
  - `resolveSupplementsForIRBaseScope(...)`
  - `findCodeSystemWithSupplementRuntime(...)`
- `tx/cs/cs-sqlite-v0.js`
  - `attachIRSupplements(...)`
  - compiler tracing hook
- `tx/cs/sqlite-v0-compiler.js`
- `tx/cs/sqlite-v0-sql-ast.js`
- `tx/supplements/resolver.js`
- `tx/supplements/ir-provider.js`

Related tests:

- `tests/tx/expand-sqlite-supplement-config.test.js`
- `tests/tx/lookup-sqlite-supplement-config.test.js`
- `tests/tx/validate-sqlite-supplement-config.test.js`
- `tests/cs/sqlite-v0-native-supplements.test.js`
