# Legacy ValueSetExpander Gap: Missing Codes in is-a Expansion

## Summary

The legacy `ValueSetExpander` in `tx/workers/expand.js` returns fewer codes
than expected for SNOMED is-a filter expansions. The IR engine matches
tx.fhir.org exactly; the legacy path misses 34 of 124 codes.

## Reproduction

### ValueSet

SNOMED CT `is-a` Diabetes mellitus (73211009), `activeOnly=true`.

SNOMED version: `http://snomed.info/sct/900000000000207008/version/20250201`

### Query

```
GET /r4/ValueSet/$expand?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=1000&activeOnly=true
```

### Results

| Server | Total | Codes returned |
|--------|-------|----------------|
| tx.fhir.org | 124 | 124 |
| IR engine (`_engine=ir`) | 124 | 124 |
| Legacy expander (`_engine=legacy`) | 124 | 90 |

The `total` field is correct in all three (124), but legacy only emits 90
codes in `expansion.contains`.

### Missing codes (34)

All are active SNOMED concepts, confirmed as descendants of 73211009 by
both local `$subsumes` and tx.fhir.org `$subsumes`:

| Code | Display |
|------|--------|
| 8801005 | Secondary diabetes mellitus |
| 40791000119105 | Postpartum gestational diabetes mellitus |
| 40801000119106 | Gestational diabetes mellitus complicating pregnancy |
| 445353002 | Brittle type II diabetes mellitus |
| 46894009 | Gestational diabetes mellitus class A2 |
| 609562003 | Maturity onset diabetes of the young, type 1 |
| 609563008 | Pre-existing diabetes mellitus in pregnancy |
| 609564002 | Pre-existing type 1 diabetes mellitus in pregnancy |
| 609565001 | Permanent neonatal diabetes mellitus |
| 609566000 | Pregnancy and type 1 diabetes mellitus |
| 609567009 | Pre-existing type 2 diabetes mellitus in pregnancy |
| 609570008 | Maturity-onset diabetes of the young, type 3 |
| 609571007 | Maturity-onset diabetes of the young, type 4 |
| 609572000 | Maturity-onset diabetes of the young, type 5 |
| 609573005 | Maturity-onset diabetes of the young, type 6 |
| 609574004 | Maturity-onset diabetes of the young, type 7 |
| 609575003 | Diabetes-pancreatic exocrine dysfunction syndrome |
| 609576002 | Maturity-onset diabetes of the young, type 9 |
| 609577006 | Maturity-onset diabetes of the young, type 10 |
| 609578001 | Maturity-onset diabetes of the young, type 11 |
| 609579009 | Diabetes mellitus, transient neonatal 1 |
| 609580007 | Diabetes mellitus, transient neonatal 2 |
| 609581006 | Diabetes mellitus, transient neonatal 3 |
| 703137001 | Type I diabetes mellitus in remission |
| 703138006 | Type II diabetes mellitus in remission |
| 721088003 | Developmental delay, epilepsy, neonatal diabetes syndrome |
| 722454003 | Intellectual disability, craniofacial dysmorphism, hypogonadism, diabetes mellitus syndrome |
| 734022008 | Wolfram-like syndrome |
| 75022004 | Gestational diabetes mellitus class A1 |
| 75682002 | Diabetes mellitus caused by insulin receptor antibodies |
| 81531005 | Diabetes mellitus type 2 in obese |
| 870528001 | Newly diagnosed diabetes mellitus type 1 |
| 890171006 | Ketosis-prone diabetes mellitus |
| 91352004 | Insulinopathy |

### Proof the codes are valid

**$lookup** on the local server confirms each code exists and resolves:
```
GET /r4/CodeSystem/$lookup?system=http://snomed.info/sct&code=8801005
→ display: "Secondary diabetes mellitus"

GET /r4/CodeSystem/$lookup?system=http://snomed.info/sct&code=609562003
→ display: "Maturity onset diabetes of the young, type 1 (disorder)"
```

**$subsumes** on both local and tx.fhir.org confirms subsumption:
```
GET /r4/CodeSystem/$subsumes?system=http://snomed.info/sct&codeA=73211009&codeB=8801005
→ outcome: subsumes    (both local and tx.fhir.org)

GET /r4/CodeSystem/$subsumes?system=http://snomed.info/sct&codeA=73211009&codeB=609562003
→ outcome: subsumes    (both local and tx.fhir.org)

GET /r4/CodeSystem/$subsumes?system=http://snomed.info/sct&codeA=73211009&codeB=75022004
→ outcome: subsumes    (both local and tx.fhir.org)
```

**Direct SQL** confirms all 124 codes in the closure table:
```sql
SELECT COUNT(DISTINCT c.code)
FROM closure cl
JOIN concept c ON c.concept_id = cl.descendant_id
WHERE cl.ancestor_id = (
  SELECT concept_id FROM concept WHERE code = '73211009' AND cs_id = 1
) AND c.active = 1;
-- Result: 124
```

## Root cause

The legacy `ValueSetExpander.includeCodes()` in `tx/workers/expand.js`
uses the CodeSystemProvider's filter protocol:

```
getPrepContext → filter(concept, is-a, 73211009) → executeFilters → filterMore/filterConcept loop
```

The v0 provider's `executeFilters` builds correct SQL (returns 124 rows).
However, the legacy expander further processes results through
`includeCodeAndDescendants()` which traverses the hierarchy tree using
`cs.iterator(context)` — walking parent→child edges. This tree traversal
misses codes that are in the closure table but not reachable via the
single-parent-property walk (codes with non-standard hierarchy paths, or
codes whose parent edges use a different property/edge-set than what the
iterator follows).

The IR engine bypasses this entirely by querying the closure table directly
via SQL `JOIN closure`, which is both correct and faster.

## Verification against tx.fhir.org

tx.fhir.org uses a Java-based SNOMED provider (not the same JS legacy
path) and returns 124 codes — matching the IR engine exactly.

```
https://tx.fhir.org/r4/ValueSet/$expand?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=200&activeOnly=true
→ total: 124, contains: 124 codes
→ used-codesystem: http://snomed.info/sct|http://snomed.info/sct/900000000000207008/version/20250201
```

Code-for-code comparison:
- tx.fhir.org == IR engine: ✅ (identical 124-code set)
- tx.fhir.org == legacy: ❌ (legacy missing 34 codes)
- legacy ⊂ tx.fhir.org: ✅ (legacy's 90 codes are all in tx.fhir.org's 124)

## Impact

This affects any SNOMED `is-a` or `descendent-of` expansion through the
legacy `ValueSetExpander` pathway when backed by a v0 SQLite database.
The IR engine produces correct results matching the reference server.
