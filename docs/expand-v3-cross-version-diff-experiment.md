# Cross-version diff via `$expand` include/exclude

Test case: `is-a 76505004 | Thumb |` across SNOMED International `20240201` vs `20250201`.

Baseline from two separate expansions: **281 → 303 concepts** (22 added, 0 removed).

## Attempt: single-expand cross-version diff

Include the 2025 filter, exclude the 2024 filter:

```json
{
  "compose": {
    "include": [{
      "system": "http://snomed.info/sct",
      "version": "http://snomed.info/sct/900000000000207008/version/20250201",
      "filter": [{ "property": "concept", "op": "is-a", "value": "76505004" }]
    }],
    "exclude": [{
      "system": "http://snomed.info/sct",
      "version": "http://snomed.info/sct/900000000000207008/version/20240201",
      "filter": [{ "property": "concept", "op": "is-a", "value": "76505004" }]
    }]
  }
}
```

**Expected:** 22 concepts. **Got:** 303 — the exclude had no effect.

The response confirms both versions were loaded (`used-codesystem` lists both),
but the exclude subtracted nothing. The server matches by `(system, version, code)`,
so codes from version `20240201` don't match codes from version `20250201`.

**Control:** same-version exclude works fine — `is-a Thumb` minus `is-a Proximal
phalanx of thumb` within `20250201` correctly returns 287 (= 303 − 16).

## What the spec says

Searched the following pages across R4, R4B, R5, and the current build
(`build.fhir.org`): `valueset.html` (including the embedded notes sections on
expansion algorithm, uniqueness, and composition rules), `valueset-definitions.html`,
and `valueset-operation-expand.html`. The relevant passages are consistent across
all versions.

**Expansion algorithm** ([build.fhir.org/valueset.html §4.9.10](https://build.fhir.org/valueset.html#expansion)):

> Otherwise: For each *compose.include*:
>
> 1. If there is a system, identify the correct version of the code system, and then:
>    - If there are no codes or filters, add every code in the code system to the result set.
>    - If codes are listed, check that they are valid [...] add them to the result set
>    - If any filters are present, process them in order [...] add the intersection of their results to the result set.
> 2. For each `valueSet`, find the referenced value set [...] expand that [...]
> 3. Add the intersection of the result set from the system (step 1) and all of the result sets from the value sets (step 2) to the expansion
>
> For each *compose.exclude*, follow the same process as for *compose.include*, but remove codes from the expansion in step 3 instead of adding them.

Each exclude independently "identifies the correct version of the code system"
(step 1) — so when a version is specified on the exclude component, it resolves
codes from that version specifically.

**Uniqueness rule** ([build.fhir.org/valueset.html §4.9.10.2](https://build.fhir.org/valueset.html#uniqueness)):

> Note that uniqueness is based on system/version/code; it is possible to include
> the same concept from different versions of a code system in the same expansion,
> though this is generally confusing for users and should be avoided.

**`expansion.contains.version`** ([build.fhir.org/valueset-definitions.html](https://build.fhir.org/valueset-definitions.html#ValueSet.expansion.contains.version)):

> The version of the code system from this code was taken.

So each entry in the expansion carries its own version. The uniqueness key is the
full `(system, version, code)` tuple.

**What this means for cross-version exclude:** The include adds entries with version
`20250201`. The exclude resolves codes from version `20240201`. The spec says the
exclude should "remove codes from the expansion" — and since the expansion's identity
key is `(system, version, code)`, codes from `20240201` don't match entries from
`20250201`. The exclude has nothing to remove.

This isn't an ambiguity or a gap in the spec — the behavior follows directly from
the stated rules. The expansion algorithm says each component resolves its own
version; the uniqueness rule says identity is `(system, version, code)`; removal
operates on the expansion which is keyed by that tuple.

The `$expand` operation definition pages (all versions) define parameters like
`system-version`, `force-system-version`, and `check-system-version` but don't
add anything to the include/exclude matching semantics — those are covered by
the ValueSet notes above.

## Workaround: enumerated exclude (two calls)

1. Expand `is-a 76505004` against `20240201` → collect 281 codes
2. Expand `is-a 76505004` against `20250201` with those 281 codes as enumerated exclude (no `version` on the exclude component)

Result: **22 concepts** — the correct diff. Works because the unversioned enumerated
exclude matches the resolved include codes.
