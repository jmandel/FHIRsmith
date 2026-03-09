# NDJSON Replay Findings (All Ops, Current Bucket)

This note captures the fresh replay findings from:

- [report.json](/home/jmandel/hobby/FHIRsmith-ir-engine/tmp/ndjson-replay-20260307/report-allops-inline-recut-replay-current-rerun-fhirjson/report.json)

The replay target was the `current` support bucket under the harness-style YAML.

## Summary

- Raw captured requests: `9206`
- Unique replayable operation requests: `7407`
- Requests classified as supportable now: `5665`
- Local replay results for that `5665` request bucket:
  - `5578` returned `200`
  - `36` returned `422`
  - `8` returned `400`
  - `43` returned `500`

Grouped by `(status, endpoint, outcome details)`, the current local non-200s fall into 10 sub-buckets.

## Sub-Buckets

### 1. `500` `POST /r4/CodeSystem/$validate-code`

- Count: `43`
- Local outcome: `500 exception`
- Local detail: `codeSystemObj.system is not a function`
- Captured status: `prod=200`, `dev=200`
- Sample request id: `a033a387-9617-4bf7-80dd-0f3e8caf1ed2`

Sample request excerpt:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "coding",
      "valueCoding": {
        "system": "http://fhir.de/CodeSystem/dkgev/Fachabteilungsschluessel-erweitert",
        "code": "3600"
      }
    },
    {
      "name": "displayLanguage",
      "valueString": "de"
    },
    {
      "name": "lenient-display-validation",
      "valueBoolean": true
    },
    {
      "name": "default-to-latest-version",
      "valueBoolean": true
    },
    {
      "name": "tx-resource",
      "resource": {
        "resourceType": "CodeSystem",
        "url": "http://fhir.de/CodeSystem/dkgev/Fachabteilungsschluessel-erweitert",
        "version": "1.5.4",
        "content": "fragment",
        "conceptCount": 148
      }
    },
    {
      "name": "system-version",
      "valueCanonical": "http://snomed.info/sct|http://snomed.info/sct/900000000000207008"
    },
    {
      "name": "mode",
      "valueString": "lenient-display-validation"
    }
  ]
}
```

### 2. `422` `POST /r4/ValueSet/$expand`

- Count: `16`
- Local outcome: `422 not-supported`
- Local detail: `IR engine cannot handle this ValueSet (expandViaIR returned null)`
- Captured status: sample `prod=200`, `dev=200`
- Sample request id: `cd702b5d-dd1e-407b-9d13-21b62460773b`

Sample request:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "defaultDisplayLanguage",
      "valueCode": "fr-FR"
    },
    {
      "name": "excludeNested",
      "valueBoolean": true
    },
    {
      "name": "count",
      "valueInteger": 1000
    },
    {
      "name": "offset",
      "valueInteger": 0
    },
    {
      "name": "valueSet",
      "resource": {
        "resourceType": "ValueSet",
        "status": "active",
        "compose": {
          "inactive": true,
          "include": [
            {
              "system": "urn:iso:std:iso:3166:-2"
            }
          ]
        }
      }
    }
  ]
}
```

### 3. `422` `POST /r4/ValueSet/$expand`

- Count: `9`
- Local outcome: `422 too-costly`
- Local detail: `The code System "urn:ietf:bcp:13" has a grammar, and cannot be enumerated directly`
- Captured status: sample `prod=422`, `dev=200`
- Sample request id: `57999ed7-24e6-4939-b62f-716dd8e0eb59`

Sample request:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "defaultDisplayLanguage",
      "valueCode": "en"
    },
    {
      "name": "excludeNested",
      "valueBoolean": true
    },
    {
      "name": "count",
      "valueInteger": 1000
    },
    {
      "name": "offset",
      "valueInteger": 0
    },
    {
      "name": "valueSet",
      "resource": {
        "resourceType": "ValueSet",
        "status": "active",
        "compose": {
          "inactive": true,
          "include": [
            {
              "system": "urn:ietf:bcp:13"
            }
          ]
        }
      }
    }
  ]
}
```

### 4. `400` `POST /r4/ValueSet/$validate-code`

- Count: `8`
- Local outcome: `400 invalid`
- Local detail: `No ValueSet specified - provide url parameter or valueSet resource`
- Captured status: sample `prod=200`, `dev=400`
- Sample request id: `abd1a7d8-3110-4b8a-a14b-267543425ffd`

Sample request:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "codeableConcept",
      "valueCodeableConcept": {
        "coding": [
          {
            "system": "http://loinc.org",
            "version": "2.77",
            "code": "8867-4",
            "display": "Heart rate"
          },
          {
            "system": "http://loinc.org",
            "version": "2.77",
            "code": "8480-6",
            "display": "Systolic blood pressure"
          }
        ]
      }
    }
  ]
}
```

### 5. `422` `POST /r5/ValueSet/$expand`

- Count: `5`
- Local outcome: `422 not-supported`
- Local detail: `IR engine cannot handle this ValueSet (expandViaIR returned null)`
- Captured status: sample `prod=422`, `dev=422`
- Sample request id: `1d21154e-9b1f-4ebf-a9fe-b361fc4bf340`

Sample request:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "defaultDisplayLanguage",
      "valueCode": "en-US"
    },
    {
      "name": "excludeNested",
      "valueBoolean": true
    },
    {
      "name": "count",
      "valueInteger": 1000
    },
    {
      "name": "offset",
      "valueInteger": 0
    },
    {
      "name": "valueSet",
      "resource": {
        "resourceType": "ValueSet",
        "status": "active",
        "compose": {
          "inactive": false,
          "include": [
            {
              "system": "urn:ietf:bcp:47",
              "version": "2.0.0",
              "concept": [
                { "code": "ar", "display": "Araabia" },
                { "code": "en-US", "display": "Inglise (Ameerika Ühendriigid)" },
                { "code": "et-EE", "display": "Eesti (Eesti)" }
              ]
            }
          ]
        }
      }
    }
  ]
}
```

Note: the real request contains a much longer inline `concept` list; this excerpt shows the relevant structure.

### 6. `422` `POST /r5/ValueSet/$expand`

- Count: `2`
- Local outcome: `422 too-costly`
- Local detail: `The code System "urn:ietf:bcp:47" has a grammar, and cannot be enumerated directly`
- Captured status: sample `prod=422`, `dev=400`
- Sample request id: `1ec135b0-c799-4daf-b06c-7e1c044c30ff`

Sample request:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "defaultDisplayLanguage",
      "valueCode": "en-US"
    },
    {
      "name": "excludeNested",
      "valueBoolean": true
    },
    {
      "name": "count",
      "valueInteger": 1000
    },
    {
      "name": "offset",
      "valueInteger": 0
    },
    {
      "name": "valueSet",
      "resource": {
        "resourceType": "ValueSet",
        "status": "active",
        "compose": {
          "inactive": true,
          "include": [
            {
              "system": "urn:ietf:bcp:47"
            }
          ]
        }
      }
    }
  ]
}
```

### 7. `422` `POST /r4/ValueSet/$expand`

- Count: `1`
- Local outcome: `422 not-supported`
- Local detail: `IR engine cannot handle this ValueSet (systems-without-ir-support)`
- Captured status: `prod=422`, `dev=500`
- Sample request id: `ed2aa13b-b5c7-4581-ae18-e06aff92d4e8`

Sample request excerpt:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "_limit",
      "valueInteger": 10000
    },
    {
      "name": "_incomplete",
      "valueBoolean": true
    },
    {
      "name": "displayLanguage",
      "valueCode": "en"
    },
    {
      "name": "count",
      "valueInteger": 1000
    },
    {
      "name": "offset",
      "valueInteger": 0
    },
    {
      "name": "tx-resource",
      "resource": {
        "resourceType": "CodeSystem",
        "url": "https://fhir.progyny.com/CodeSystem/identifier-type-cs",
        "version": "1.4.1",
        "content": "fragment"
      }
    },
    {
      "name": "tx-resource",
      "resource": {
        "resourceType": "CodeSystem",
        "url": "http://terminology.hl7.org/CodeSystem/v2-0203",
        "version": "5.0.0",
        "content": "complete"
      }
    },
    {
      "name": "valueSet",
      "resource": {
        "resourceType": "ValueSet",
        "url": "https://fhir.progyny.com/ValueSet/identifier-type-vs",
        "version": "1.4.1",
        "compose": {
          "include": [
            {
              "system": "https://fhir.progyny.com/CodeSystem/identifier-type-cs"
            },
            {
              "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
              "concept": [
                { "code": "AN", "display": "Account number" },
                { "code": "PN", "display": "Person Number" },
                { "code": "MR", "display": "Medical Record Number" },
                { "code": "MB", "display": "Member Number" },
                { "code": "EI", "display": "Employee Number" }
              ]
            },
            {
              "system": "http://hl7.org/fhir/us/identity-matching/CodeSystem/Identity-Identifier-c",
              "concept": [
                { "code": "SSN4", "display": "SSN Last 4" }
              ]
            }
          ]
        }
      }
    }
  ]
}
```

### 8. `422` `POST /r4/ValueSet/$validate-code`

- Count: `1`
- Local outcome: `422 not-found`
- Local detail: `A definition for the value Set 'http://hl7.org/fhir/ValueSet/designation-use--0|4.0.1' could not be found`
- Captured status: `prod=200`, `dev=400`
- Sample request id: `95b3e3c8-f514-47c5-b24c-1bb6ba07d80d`

Sample request:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "coding",
      "valueCoding": {
        "system": "http://snomed.info/sct",
        "code": "900000000000550004"
      }
    },
    {
      "name": "valueSetMode",
      "valueString": "CHECK_MEMERSHIP_ONLY"
    },
    {
      "name": "default-to-latest-version",
      "valueBoolean": true
    },
    {
      "name": "url",
      "valueUri": "http://hl7.org/fhir/ValueSet/designation-use--0|4.0.1"
    },
    {
      "name": "system-version",
      "valueString": "http://snomed.info/sct|http://snomed.info/sct/900000000000207008"
    }
  ]
}
```

### 9. `422` `POST /r5/ValueSet/$expand`

- Count: `1`
- Local outcome: `422 too-costly`
- Local detail: `The code System "urn:ietf:bcp:13" has a grammar, and cannot be enumerated directly`
- Captured status: `prod=422`, `dev=200`
- Sample request id: `091d521b-4839-4968-902e-c1e0d8f95a0d`

Sample request:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "defaultDisplayLanguage",
      "valueCode": "ru-RU"
    },
    {
      "name": "excludeNested",
      "valueBoolean": true
    },
    {
      "name": "count",
      "valueInteger": 1000
    },
    {
      "name": "offset",
      "valueInteger": 0
    },
    {
      "name": "valueSet",
      "resource": {
        "resourceType": "ValueSet",
        "status": "active",
        "compose": {
          "inactive": true,
          "include": [
            {
              "system": "urn:ietf:bcp:13"
            }
          ]
        }
      }
    }
  ]
}
```

### 10. `422` `POST /r5/ValueSet/$validate-code`

- Count: `1`
- Local outcome: `422 not-found`
- Local detail: `Required supplement not found: https://fhir.ee/CodeSystem/olemi-seos|1.0.0`
- Captured status: `prod=422`, `dev=400`
- Sample request id: `187f889e-ba9e-46ff-8019-e3c1c49ba586`

Sample request excerpt:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "codeableConcept",
      "valueCodeableConcept": {
        "coding": [
          {
            "system": "http://snomed.info/sct",
            "code": "72705000",
            "display": "Mother"
          }
        ]
      }
    },
    {
      "name": "displayLanguage",
      "valueString": "en-US"
    },
    {
      "name": "default-to-latest-version",
      "valueBoolean": true
    },
    {
      "name": "valueSet",
      "resource": {
        "resourceType": "ValueSet",
        "url": "https://fhir.ee/ValueSet/isiku-suhte-tyybid-hl7-ja-snomed",
        "version": "1.0.0",
        "supplement": "https://fhir.ee/CodeSystem/olemi-seos|1.0.0",
        "compose": {
          "include": [
            {
              "system": "http://snomed.info/sct",
              "version": "http://snomed.info/sct/11000181102",
              "concept": [
                { "code": "72705000" },
                { "code": "66839005" },
                { "code": "67822003" }
              ]
            },
            {
              "system": "http://terminology.hl7.org/CodeSystem/v3-RoleClass",
              "concept": [
                { "code": "GUARD" },
                { "code": "DEPEN" }
              ]
            }
          ]
        }
      }
    },
    {
      "name": "tx-resource",
      "resource": {
        "resourceType": "CodeSystem",
        "url": "http://terminology.hl7.org/CodeSystem/v3-RoleClass",
        "version": "4.0.0",
        "content": "complete"
      }
    }
  ]
}
```

Note: the real request contains a longer inline SNOMED concept list; this excerpt shows the supplement dependency and the mixed-system structure that matters for the failure.

## Notes

- The sample requests above are taken from the original capture files under `/home/jmandel/hobby/fhirsmith-triage/triage/...`.
- Large inline `tx-resource` bodies were shortened in this note when the omitted portions were not needed to understand the sub-bucket.
- The grouping used here is the concrete replay grouping from the fresh rerun: `(local status, endpoint, first OperationOutcome.details text)`.

## Current Assessment

### Fixed local defects

1. `POST /r4/CodeSystem/$validate-code` inline `codeSystem` requests
   - The local `500 codeSystemObj.system is not a function` failure was a real worker bug.
   - Root cause: `createCodeSystemProviderWithSupplementRuntime()` assumed method-style canonical accessors on our library `CodeSystem` wrapper instead of its `url` / `version` getters.
   - Status: fixed locally, with unit coverage in [tests/tx/validate.test.js](/home/jmandel/hobby/FHIRsmith-ir-engine/tests/tx/validate.test.js).

2. `POST /r4/ValueSet/$validate-code` with `url=http://...|version`
   - The local `422 ... designation-use--0|4.0.1 could not be found` failure was also a real local bug.
   - Root cause: `ValidateWorker.resolveValueSet()` had a thinner, duplicated lookup path that did not normalize `url|version` the same way as the shared worker-level `findValueSet()` flow.
   - Status: fixed locally, with unit coverage in [tests/tx/validate.test.js](/home/jmandel/hobby/FHIRsmith-ir-engine/tests/tx/validate.test.js).
   - Note: the historical replay capture says `prod=200`, but a fresh spot-check against current `tx.fhir.org` did not reproduce that exact success response, so the old capture likely reflects older server behavior. The local bug was still worth fixing because the validate path was objectively divergent from the shared worker resolver.

### Fixed local source-set mismatch

3. `POST /r4/ValueSet/$expand` whole-system `urn:iso:std:iso:3166:-2`
   - Fresh `tx.fhir.org` spot-check succeeds (`200`).
   - The local replay failure came from using the harness-style fixture YAML, not the public `tx.fhir.org.yml` source set.
   - Public production config includes `npm:fhir.tx.support.r4`; the replay/current fixture did not.
   - Adding `npm:fhir.tx.support.r4` to the local harness-style source set makes the same request return `200` locally with real subdivision codes such as `AF-BAL`, `AF-BAM`, `AF-BDG`, `AF-BDS`, and `AF-BGL`.
   - Status: fixed locally in the replay/current fixture YAMLs, with integration coverage in [tests/tx/upstream-parity-regressions.test.js](/home/jmandel/hobby/FHIRsmith-ir-engine/tests/tx/upstream-parity-regressions.test.js).

### Not current local defects

4. Grammar-backed whole-system expansion (`urn:ietf:bcp:13`, `urn:ietf:bcp:47`)
   - Current `tx.fhir.org` behavior is already non-200 / too-costly for these whole-system requests.
   - The replay captures mix older `prod` / `dev` behavior here.
   - Current assessment: not an IR-engine regression.

5. `POST /r4/ValueSet/$validate-code` with only `codeableConcept`
   - Current `tx.fhir.org` and local behavior both return `400 No ValueSet specified - provide url parameter or valueSet resource`.
   - Current assessment: not an active difference; older replay captures were stale here.

6. Mixed-system / unsupported-system expand failures
   - Buckets 5, 7, and 10 are already non-200 on upstream captures or depend on unsupported systems/supplements.
   - Current assessment: not priority local IR regressions.
