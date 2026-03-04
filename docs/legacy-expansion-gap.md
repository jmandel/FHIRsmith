# Legacy vs IR Expansion: Hierarchy Nesting Difference

## Summary

The legacy `ValueSetExpander` and IR engine both return 124 codes for
SNOMED `is-a` Diabetes mellitus (73211009), matching tx.fhir.org exactly.
However, when backed by the v0 SQLite provider (`cs-sqlite-v0.js`), legacy
returns them as a **hierarchy tree** (90 top-level entries with 34 nested
in `.contains` sub-arrays), while the IR engine and tx.fhir.org return a
**flat list** of all 124.

This is not a bug — it's a valid difference in output structure. FHIR
allows nested `.contains` in expansions to represent hierarchy.

## Reproduction

```
GET /r4/ValueSet/$expand?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=1000&activeOnly=true
```

SNOMED version: `http://snomed.info/sct/900000000000207008/version/20250201`

## Results

| Server | total | Top-level `.contains` | Total including nested |
|--------|-------|-----------------------|------------------------|
| tx.fhir.org (FHIRsmith + cs-snomed.js) | 124 | 124 (flat) | 124 |
| IR engine (`_engine=ir`) | 124 | 124 (flat) | 124 |
| Legacy expander + v0 (`_engine=legacy`) | 124 | 90 (hierarchy) | 124 |

## Root cause: `parent()` implementation difference

The nesting difference comes from whether the code system provider
implements the `parent(context)` method.

The legacy `ValueSetExpander.includeCodes()` (line ~854 in expand.js)
checks `cs.hasParents()` on the provider. When true, it calls
`cs.parent(c)` for each code to build a tree — child codes are nested
inside their parent's `.contains` array.

**Two providers, two behaviors:**

| Provider | `hasParents()` | `parent()` | Effect |
|----------|---------------|------------|--------|
| `cs-snomed.js` (used by tx.fhir.org) | `true` | inherited default → `null` | No nesting possible; all 124 go to rootList |
| `cs-sqlite-v0.js` (our v0 provider) | `true` | walks `concept_link` table | 34 codes nest under their parents |

`cs-snomed.js` has `hasParents() = true` (line 485) but never overrides
the base `parent()` method from `cs-api.js` (which returns `null`). It
*does* have the data — `getConceptParents()` is used for `$lookup`
property output — but it's not wired into the legacy expander's hierarchy
building path.

Our v0 provider (`cs-sqlite-v0.js` line 263) implements `parent()` using
the `concept_link` table with the hierarchy property, returning the actual
parent code. This lets the legacy expander build a real tree.

## How the hierarchy is built

At finalization (line ~1300 in expand.js), when `canBeHierarchy` is true
and `count > fullList.length`, it outputs `rootList` (top-level only)
with nested codes inside `.contains`. The `total` field reflects
`fullList` (all 124), but only 90 entries appear at the top level.

Example nesting:
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

## Verification

tx.fhir.org runs FHIRsmith 0.5.6 with the `cs-snomed.js` provider.
Code-for-code comparison (all 124 codes):
- tx.fhir.org == IR engine: ✅ identical flat set
- tx.fhir.org == Legacy (counting nested): ✅ identical code set
- All three return the same 124 SNOMED codes

## Implications

- Both engines produce correct, complete expansions
- The v0 provider's hierarchy output is arguably *more correct* than
  tx.fhir.org's accidental flatness (tx.fhir.org is flat only because
  cs-snomed.js doesn't wire up `parent()`)
- The IR engine returns flat output matching tx.fhir.org's format
- Clients counting codes must recursively walk `.contains` for legacy v0
- `excludeNested=true` makes legacy also return a flat list
