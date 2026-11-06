# sqlite-v2 query catalog

159 terminology requests that serve three purposes:

1. browsable examples for the demo, showing where the set-based SQLite engine does well and where it does badly;
2. a regression suite;
3. evidence of parity: each request has a reference answer recorded from tx-dev.fhir.org (the
   earlier tx.fhir.org recordings are kept in `reference-tx.fhir.org/`; replay against them with
   `CATALOG_REFERENCE_DIR=tx/sqlite-v2/catalog/reference-tx.fhir.org`).

Target versions, the ones tx.fhir.org serves and the ones in our databases: SNOMED CT International
20250201 (the default) and US Edition 20250901; LOINC 2.83; RxNorm 03022026.

## Layout

| path | what |
|---|---|
| `entries/<id>.json` | one catalog entry per file (format below) |
| `reference/<id>.json` | reference answers from tx-dev.fhir.org, one summary per access pattern and page |
| `reference-tx.fhir.org/<id>.json` | the earlier answers from tx.fhir.org (history) |
| `lib.js` | loads entries, builds requests, calls a server with an on-disk cache, summarises responses |
| `validate.js` | schema check for entries and reference files: `node tx/sqlite-v2/catalog/validate.js` |
| `fetch-reference.js` | records reference answers (sequential, rate-limited, cached; see below) |
| `replay.js` | replays the catalog against any base URL and diffs against `reference/` |
| `tools/generate-entries.py` | generator that wrote the original `entries/` (constructed cases + real value sets from packages); some entries were since edited by hand, so do not rerun it blindly |
| `tools/generate-output-heavy.py` | writes the `oh-*` output-heavy entries only |

## Entry format

```jsonc
{
  "id": "sct-ecl-role-group",              // = file name
  "title": "...",
  "category": "properties-attributes",     // see categories below
  "source": { "kind": "constructed" },     // or vsac | us-core | ips, with package, file, url,
                                           //   packageExpansionTotal and adaptations[]
  "exercises": "what feature it exercises",
  "why": "why it is interesting: expected fast or slow on the engine, and why",
  "expect": "fast | slow | mixed | unsupported",
  "request": {
    "operation": "expand | validate-code | lookup | subsumes",
    "valueSet": { ... },                   // inline ValueSet (compose), or
    "valueSetUrl": "http://...",           // a canonical (implicit value sets etc.)
    "txResources": [ ... ],                // helper ValueSets / CodeSystems / supplements
    "parameters": { "activeOnly": true, "displayLanguage": "nl-NL", "useSupplement": "...", ... }
  },
  "patterns": ["first-page", "pages-1-3", "deep-jump", "first-then-deep", "last-with-total"],
  "paging": { "count": 50, "deepOffset": 100000 },   // count null = send neither offset nor count
  "orderDefined": false,                   // true: order is part of the answer (enumerated lists)
  "systems": ["http://snomed.info/sct"],
  "engine": { "sqlite": [...], "main": [...] },       // which systems run on the SQLite engine
                                                      //   vs main's existing providers
  "expectedDifferences": [                            // optional: known differences from the reference
    { "aspect": "displays", "kind": "reference data gap", "reason": "written explanation" }
  ],
  "variantOf": "id",                                  // optional: main-expressible form of another entry
  "equivalentEntries": ["id"]                         // optional: entries that ask the same question
}
```

**References are evidence, not truth.** Each known difference carries a written reason in
`expectedDifferences`. `aspect` is one of status, total, codes, displays, designations, result,
display, properties, outcome or any. `kind` is one of:

- `reference data gap`: tx.fhir.org lacks the data. For example, it has no zh-CN LOINC designations,
  and its text filters do not search translations or supplements.
- `reference does not support`: main lacks the feature, so the recorded answer is its error.
  Examples are descendent-leaf, is-not-a, SNOMED display regex, RxNorm `concept in`, ECL concrete
  values, and `?fhir_vs=ecl/`. Where main can express the same question differently, a variant
  entry (`variantOf`) carries a real reference answer: one include per brand instead of
  `has_ingredient in`, ECL instead of descendent-leaf or an implicit URL, and concept lists
  instead of `concept in`.
- `reference behaviour`: tx.fhir.org answers, but we believe it is wrong. For example, it applies
  a supplement pinned to LOINC 2.80, and it returns validate-code true for an inactive code under
  activeOnly.

Replay reports these as `differs: <kind> (<reason>)`. They do not fail the run.

Replay verdicts per entry: `match`; `improved` (we answer where the reference returned an error);
`both-refuse` (both returned errors on every page: reported on its own, never counted as a match);
`known-diff` (only documented differences); `DIFF`.

Parameter values are turned into FHIR `Parameters` by `lib.typedParam` (booleans, codes, canonicals;
arrays repeat the parameter). `offset`/`count` never appear in `parameters`; they come from the pattern.

Access patterns (`count` = `paging.count`):

| pattern | requests |
|---|---|
| `first-page` | offset 0 |
| `pages-1-3` | offsets 0, count, 2*count |
| `deep-jump` | offset `deepOffset` straight away |
| `first-then-deep` | offset 0, then `deepOffset` |
| `last-with-total` | offset 0 to learn the total, then offset total-count; if there is no total, only the first page is recorded |

Categories: `hierarchy`, `exclusion-inactive`, `properties-attributes`, `refsets-implicit-ecl`, `text`,
`enumerated-nested`, `multi-system-versions`, `mixed-providers`, `limits-paging`,
`validate-lookup-subsumes`, `languages-supplements`, `output-heavy`.

`output-heavy` entries (`oh-*`) cost little to compute membership for but a lot to build rows for.
They cover many or all properties (`property=*`, `compose.property`), `includeDesignations` on
1,000-row pages in every language, weighted `displayLanguage`, the `designation` filter,
`includeDefinition`, `$lookup` with `property=*`, and designations and properties on deep pages.
Each entry has a `stresses` field: rows built, properties and designations per code, and
response size. Their reference summaries add an `output` block: responseBytes, rows, property
codes and counts, designation counts, languages and uses, and definitions. Replay compares the
property codes, designation languages and the presence of definitions, and notes the sizes.

Real value sets (VSAC 0.24.0, US Core 9.0.0, IPS 2.0.1) are used as published, with these
adaptations, which are listed in `source.adaptations`: SNOMED include versions are moved to the
target releases (US -> 20250901, International -> 20250201); LOINC, RxNorm and other include versions are
dropped so the server default applies; value sets they import are attached as `tx-resource` when the
packages contain them; enumerated lists over 1,000 codes lose their displays (request size); a few
grouping value sets lose includes of code systems neither server has (ICD-9-CM, ICD-10-PCS).

### Code systems served by main's existing providers

The `mixed-providers` entries pair SNOMED/LOINC/RxNorm with code systems that main already serves
and that tx.fhir.org has loaded (checked 2026-11-01 with `CodeSystem?url=`):

- FHIR CodeSystem resources: `administrative-gender` (FHIR core), THO `v3-NullFlavor`,
  CDC Race & Ethnicity `urn:oid:2.16.840.1.113883.6.238`, ICD-10-CM (a complete CodeSystem resource
  in `fhir.tx.support`), US Core category code systems, and a request-supplied CodeSystem (tx-resource).
  These need only npm packages, so a default local setup has them.
- Internal providers: ISO 3166 (`internal:country`), BCP-47 (`internal:lang`), UCUM (grammar).
- Database providers: NDC (`ndc-20211101.db`), CPT (a 2023 fragment on tx.fhir.org), CVX.
  A local setup has these only if the databases are configured.

## Reference answers

```sh
node tx/sqlite-v2/catalog/fetch-reference.js            # all entries, default server tx-dev.fhir.org/r4
node tx/sqlite-v2/catalog/fetch-reference.js --only sct-isa-diabetes --dry-run
```

POST `$expand` / `$validate-code` / `$lookup` / `$subsumes` with a `Parameters` body,
`Accept: application/fhir+json`. One request at a time, at least 1.1 s apart, at most
`--max-requests` (default 500) network requests per run, and back-off on 429/5xx. Raw responses are
cached by request hash in `--cache` (default `~/hobby/.agent-scratch/catalog-txcache`, or
`$CATALOG_CACHE`), so a rerun only fetches what is new. A ledger of every network request is
kept in the cache as `requests.log`.

**The raw response cache is never committed.** It contains SNOMED CT and LOINC display text and
designations. To regenerate it, run `fetch-reference.js` with an empty `--cache`: about 230
requests, about 10 minutes at the default pacing. Only the compact `reference/` summaries are
committed. They hold: HTTP status, total, codes (`system|version|code`) per page in order,
used-codesystem / used-supplement, displays (when a language or supplement is involved), designation
counts, OperationOutcome issues (severity, code, text, message id), and for the other operations
result/display/properties/outcome. A 422 too-costly or a missing total is a recorded outcome.

## Replay

```sh
node tx/sqlite-v2/catalog/replay.js --base http://localhost:3000/r4
node tx/sqlite-v2/catalog/replay.js --base http://localhost:3000/r4 --category hierarchy --verbose
node tx/sqlite-v2/catalog/replay.js --base http://localhost:3000/r4 --only sct-ecl-role-group --json /path/out.json
```

For each entry, pattern and page it compares the status class, `total`, and the codes as
`system|code`. Order is compared only when `orderDefined` is true. Otherwise a page is checked
against the reference's complete code set when the reference returned the whole expansion in one
page; if it did not, only the page size is compared, because page contents depend on the server's
order. Code versions, used-codesystem and displays are reported as notes. Validate-code compares
`result`, lookup compares display and properties, and subsumes compares `outcome`. The exit status
is 1 if any page differs.

Where tx.fhir.org returned 422 (too costly) or no total, the engine is expected to do better. Replay
reports a 200 where the reference was 422, or a total where the reference had none, as an
`improved:` note rather than a difference. Pages the reference never reached (it stopped at 422)
cannot be checked for content.

## tx.fhir.org behaviours observed (recorded 2026-11-01)

261 network requests in all (including 21 probes). Reference page statuses: 264 × 200,
40 × 422, 16 × 500, 2 × 400 and 1 × 404.

- **Limits.** Paging stops at offset+count > 3,000 with a 422 too-costly. Expansions with no
  count, with count=0, or imported in full are capped at 10,000. 30 expansions return no
  `total` on the first page, including every large hierarchy, whole-system include and large
  enumerated VSAC list. Deep and last-page patterns can therefore only be recorded as 422.
- **Unsupported (500):** `descendent-leaf` and `is-not-a` on SNOMED; `display regex` on SNOMED;
  RxNorm `concept in` (so the real VSAC *Diabetes Medications* value set fails); relationship
  filters with `in`; filters on supplement-added properties; and the whole-US-minus-whole-Intl
  diff, which fails with "Must override".
- **400:** ECL concrete values (`= #500`) and ECL description filters (`{{ term = }}`).
- **Not found (422):** `?fhir_vs=ecl/...`, and `?fhir_vs=refset/` for the US ICD-10-CM complex map
  refset (simple International refsets resolve).
- **Languages.** nl-NL displays work. zh-CN falls back to English: tx.fhir.org's LOINC has no
  zh-CN (nor it-IT, el-GR or ru-RU) designations, which our DB does have. With includeDesignations,
  the server-known Uzbek lang-pack supplement is applied unasked, and `used-supplement` is reported.
  Text filters match neither German designations nor Uzbek supplement designations (0 results).
- **Supplements.** A supplement that pins `http://loinc.org|2.80` is still applied to 2.83 and
  reported as used. A tx-resource copy of the Uzbek supplement at version `2.82-catalog-subset`
  is reported as `|2.82`. A supplement-only code (99999-9) gives a 404 from `$lookup`.
- **Refsets.** ECL `^ 6011000124106` (the US ICD-10-CM complex map refset) returns 0 members on the
  US Edition. Our import has 138,383.
- **Output (oh-* entries).**
  - tx.fhir.org returns no requested properties from `$expand`: it ignores the `property`
    parameter and `compose.property` on /r4 and /r5, whether given as valueCode, valueString or
    `*`. It adds only `status` to non-active LOINC codes.
  - `includeDefinition` returns no definitions, although SNOMED has 8,252 text definitions.
  - `designation=nl-NL&designation=fr-FR` returns no LOINC designations at all, while the
    SNOMED FSN use filter works (one per code).
  - SNOMED pages carry 2 designations per code. LOINC pages carry about 6.5 per code in
    12 languages, plus the Uzbek supplement added unasked.
  - The largest page is 1.38 MB: 845 LOINC codes with designations. 1,000-row pages are
    accepted, and offset 100,000 is a 422.
  - RxNorm `$lookup property=*` returns only inactive and notSelectable. SNOMED `property=*`
    returns parents, children, attributes, module and effectiveTime, but not normalForm or
    sufficientlyDefined.
- **Other.** `activeOnly=true` does not make validate-code reject an inactive enumerated code: it
  returns result=true with a warning. Malformed NDC codes are silently dropped.
