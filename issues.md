# tx.fhir.org calibration issues (bug report draft)

Date: 2026-02-22
Scope: `$expand` behavior seen while calibrating `expand-v2` test expectations.

## 1) `$expand` text `filter` on POSTed ValueSet can fail with `toLowerCase` errors

### Repro A (custom compose + filter query)

```bash
curl -sS -X POST \
  'https://tx.fhir.org/r5/ValueSet/$expand?filter=insulin&count=20' \
  -H 'content-type: application/fhir+json' \
  -H 'accept: application/fhir+json' \
  -d '{
    "resourceType":"ValueSet",
    "status":"active",
    "compose":{
      "include":[{
        "system":"http://snomed.info/sct",
        "filter":[{"property":"concept","op":"is-a","value":"73211009"}]
      }]
    }
  }'
```

### Repro B (canonical URL + filter query)

```bash
curl -sS \
  'https://tx.fhir.org/r5/ValueSet/$expand?url=http://hl7.org/fhir/ValueSet/administrative-gender&filter=male'
```

### Expected
- Successful expansion response with `expansion.contains` filtered by text.

### Actual
- OperationOutcome / server error variants including:
  - `filter.toLowerCase is not a function`
  - `Cannot read properties of undefined (reading 'toLowerCase')`

### Notes
- Similar requests **without** `filter` succeeded during calibration.

---

## 2) Shape-D custom compose (`system` + `valueSet`) can fail with `pinValueSet` error

### Repro

```bash
curl -sS -X POST \
  'https://tx.fhir.org/r5/ValueSet/$expand' \
  -H 'content-type: application/fhir+json' \
  -H 'accept: application/fhir+json' \
  -d '{
    "resourceType":"ValueSet",
    "status":"active",
    "compose":{
      "include":[{
        "system":"http://hl7.org/fhir/administrative-gender",
        "concept":[{"code":"male"},{"code":"female"},{"code":"other"}],
        "valueSet":["http://hl7.org/fhir/ValueSet/administrative-gender"]
      }]
    }
  }'
```

### Expected
- Expansion succeeds using intersection semantics for `system + valueSet` include component.

### Actual
- Server error:
  - `this.pinValueSet is not a function`

---

## Impact on our calibration workflow

- These two tx.fhir.org behaviors blocked external calibration for affected tests.
- We marked those tests as **locally assessed** (not externally calibrated) in:
  - `tests/tx/fixtures/expand-v2-assessment-status.json`
- All tests still pass locally in parity mode; current state is tracked in:
  - `tests/tx/assessment-status.json`
  - `expand-v2-implementation-plan.md`
