# Legacy vs IR Expansion: Hierarchy Nesting Difference

## Summary

All three servers return the same 124 codes for SNOMED `is-a` Diabetes
mellitus (73211009). The difference is structural: the v0 provider
produces hierarchy nesting in the legacy path because it correctly
implements `parent()`, while `cs-snomed.js` (used by tx.fhir.org and
tx-dev.fhir.org) has a gap — `hasParents()=true` but `parent()` is
never overridden, so it always returns `null` and output is accidentally
flat.

## Provider comparison

| Provider | Used by | `hasParents()` | `parent()` | Output |
|----------|---------|---------------|------------|--------|
| `cs-snomed.js` | tx.fhir.org, tx-dev.fhir.org | `true` (line 485) | base default → `null` | flat (accidental) |
| `cs-sqlite-v0.js` | local v0 databases | `true` (line 164) | `concept_link` lookup (line 263) | hierarchical |

`cs-snomed.js` *has* the parent data — `getConceptParents()` (line 749)
is used for `$lookup` property output — but it's not wired into the
`parent()` method that `ValueSetExpander.includeCodes()` calls at
line 854 of `expand.js` for hierarchy building.

## Expansion results

```
GET /r4/ValueSet/$expand?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=1000&activeOnly=true
```

SNOMED version: `http://snomed.info/sct/900000000000207008/version/20250201`

| Server | total | Top-level `.contains` | Total including nested |
|--------|-------|-----------------------|------------------------|
| tx.fhir.org (cs-snomed.js) | 124 | 124 (flat) | 124 |
| tx-dev.fhir.org (cs-snomed.js) | 124 | 124 (flat) | 124 |
| IR engine (`_engine=ir`) | 124 | 124 (flat) | 124 |
| Legacy + v0 (`_engine=legacy`) | 124 | 90 (hierarchy) | 124 |

All four return the identical 124-code set.

## How the legacy expander builds hierarchy

`ValueSetExpander.includeCodes()` (line ~854 in `expand.js`) checks
`cs.hasParents()`. When true, it calls `cs.parent(c)` per code and
nests children inside their parent's `.contains` array.

At finalization (line ~1300), when `canBeHierarchy` is true and
`count > fullList.length`, it outputs `rootList` (top-level only) with
nested codes in `.contains`. The `total` reflects `fullList` (all 124).

Example:
```json
{
  "code": "44054006",
  "display": "Diabetes mellitus type 2",
  "contains": [
    { "code": "445353002", "display": "Brittle type II diabetes mellitus" },
    { "code": "81531005", "display": "Diabetes mellitus type 2 in obese" }
  ]
}
```

## Implications

- The v0 provider's hierarchy output is correct FHIR behavior
- `cs-snomed.js`'s flat output is accidental (missing `parent()` override)
- The IR engine returns flat, matching tx.fhir.org's current format
- Clients counting codes must recursively walk `.contains` for v0 legacy
- `excludeNested=true` makes legacy v0 also return a flat list
