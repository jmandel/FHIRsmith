# tx.fhir.org vs Ontoserver

This document tracks known behavioral differences between `tx.fhir.org` and public Ontoserver instances.

## LOINC whole-system expansion and LP part codes

### Summary

For whole-system LOINC expansion with `STATUS=ACTIVE`:

- `tx.fhir.org` enumerates active `LP*` LOINC Part codes
- Ontoserver does not enumerate `LP*` codes in the expansion
- both servers do recognize LP codes as valid `http://loinc.org` codes for `$lookup`

This is a meaningful behavior gap because it changes expansion membership, paging, and totals.

### Sample query

```bash
curl -sS 'https://tx.fhir.org/r4/ValueSet/$expand' \
  -H 'content-type: application/fhir+json' \
  --data-binary @- <<'JSON' | jq '{first20:[.expansion.contains[0:20][]|.code]}'
{
  "resourceType":"Parameters",
  "parameter":[
    {
      "name":"valueSet",
      "resource":{
        "resourceType":"ValueSet",
        "compose":{
          "include":[
            {
              "system":"http://loinc.org",
              "filter":[{"property":"STATUS","op":"=","value":"ACTIVE"}]
            }
          ]
        }
      }
    },
    {"name":"count","valueInteger":20}
  ]
}
JSON
```

Observed first page from `tx.fhir.org`:

```json
[
  "LP101394-7",
  "LP101907-6",
  "LP115711-6",
  "LP147359-6",
  "LP173483-1"
]
```

Equivalent Ontoserver request does not enumerate LP codes on the expansion page.

### Why this is surprising

Ontoserver does know about LP codes as valid LOINC codes:

```bash
curl -sS 'https://r4.ontoserver.csiro.au/fhir/CodeSystem/$lookup?system=http://loinc.org&code=LP31755-9'
```

Observed:

- `display = Microbiology`
- `system = http://loinc.org`
- `version = 2.81`

So the disagreement is not about LP-code validity. It is specifically about whether whole-system LOINC expansion should enumerate LP parts.

### Spec / THO context

The HL7 Terminology LOINC page says:

- LOINC part codes "can be used where appropriate"
- "Part codes are the same LOINC system (`http://loinc.org`)"

Source:

- <https://build.fhir.org/ig/HL7/UTG/en/LOINC.html>

That makes LP-code inclusion in whole-system `http://loinc.org` expansion defensible. There is no obvious THO text requiring them to be excluded from whole-system expansion.

### Current interpretation

This looks like a server-policy/content-scope divergence:

- `tx.fhir.org` treats LP parts as enumerable members of whole-system LOINC expansion
- Ontoserver treats LP parts as valid lookup targets but does not enumerate them in this expansion shape

### Local note

We also had a separate local bug in our sqlite-v0 LOINC importer: LP part codes originally did not get `STATUS` populated, so local `STATUS=ACTIVE` filtering under-returned LP parts. That importer bug has been fixed.

Our older harness rows for this area were too weak to catch the policy distinction directly:

- [expand.mjs](/home/jmandel/hobby/FHIRsmith-ir-engine/scripts/tx-harness-cases/expand.mjs#L187)
- [expand.mjs](/home/jmandel/hobby/FHIRsmith-ir-engine/scripts/tx-harness-cases/expand.mjs#L280)

Those assertions only checked "large total" and page size, not whether LP codes were present or absent.

## UCUM unclosed expansion handling

### Summary

For expansions that include unfiltered `http://unitsofmeasure.org`:

- local IR returns a useful UCUM subset
- local IR marks the expansion as unclosed
- Ontoserver either drops the UCUM branch or reports a finite-looking result without an unclosed signal

This is the clearest Ontoserver behavior gap we found so far, because it can make an inherently unbounded expansion look complete.

### Representative query

```bash
curl -sS 'https://r4.ontoserver.csiro.au/fhir/ValueSet/$expand' \
  -H 'content-type: application/fhir+json' \
  --data-binary @- <<'JSON' | jq '{total:(.expansion.total // null), contains:(.expansion.contains | length), extensions:(.expansion.extension // [])}'
{
  "resourceType":"Parameters",
  "parameter":[
    {
      "name":"valueSet",
      "resource":{
        "resourceType":"ValueSet",
        "compose":{
          "include":[
            { "system":"http://unitsofmeasure.org" },
            {
              "system":"http://hl7.org/fhir/administrative-gender",
              "concept":[{"code":"male"}]
            }
          ]
        }
      }
    },
    {"name":"count","valueInteger":2000}
  ]
}
JSON
```

Observed behavior:

- local IR returns `male` plus the curated `ucum-common` subset and marks the result with `valueset-unclosed`
- Ontoserver returns only `male`, reports a finite total, and gives no unclosed signal

Related rows:

- `110`
- `137`
- `143`

### Why this matters

UCUM is grammar-based and not finitely enumerable in the same way as a normal closed code system. If a server chooses to return a pragmatic subset rather than error, it should still make the incompleteness obvious. Returning a finite `total` with no unclosed indication is misleading.

### Current interpretation

This looks like a real Ontoserver concern:

- local IR behavior is more transparent
- Ontoserver behavior is potentially confusing to clients because it suppresses or under-signals the UCUM branch

## Inline supplement support and request typing

### Summary

A number of Ontoserver comparison rows are not independent issues. They are the same product boundary showing up repeatedly:

- Ontoserver appears stricter about `useSupplement` parameter typing
- Ontoserver does not appear to support inline `tx-resource` supplement workflows the way our local IR does

This should be treated as one grouped capability note, not many separate bugs.

### Rows covered by this note

- `126`
- `128`
- `129`
- `130`
- `132`
- `134`
- `135`
- `136`

### Current interpretation

This is mostly an interoperability/capability mismatch:

- local IR supports inline/request-supplied supplement resolution and application
- Ontoserver often rejects the request shape or fails to resolve the inline supplement

One row in this family still stands out as potentially wrong on Ontoserver's side:

- `127`: treating a provided-but-unrequested supplement as if it were requested

That row should still be considered separately.

## Draft warning suppression when the source ValueSet is also draft

### Summary

We are **not** treating this as a bug.

When the source ValueSet is itself `draft`, local IR suppresses `warning-draft` for draft dependencies. This is intentional and matches our local harness expectation and the tx-style local comparison run.

Related row:

- `57`

### Current interpretation

Ontoserver is simply more verbose here. That may be a valid convention, but it is not evidence that our current behavior is wrong.
