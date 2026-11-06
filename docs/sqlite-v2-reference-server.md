# Reference server: tx-dev.fhir.org

tx-dev.fhir.org runs ahead of tx.fhir.org and is the better correctness reference (Grahame,
2026-11-01). Both report FHIRsmith 0.18.2. The catalog's reference answers now come from tx-dev
(`tx/sqlite-v2/catalog/reference/`). The earlier tx.fhir.org recordings are kept in
`reference-tx.fhir.org/` for history.

tx-dev's library config is not in the repository. Its code systems and versions below come from
`https://tx-dev.fhir.org/r4/metadata?mode=terminology` and `/r5`, read on 2026-11-01. They are
compared with tx.fhir.org's (same request), `tx/tx.fhir.org.yml` and `tx/sqlite-v2/demo.yml`.

## Code systems and versions

r4 lists 1,308 code systems on all three servers (tx-dev, tx.fhir.org, our demo) and r5 lists
1,448, with the same URIs. Only SNOMED CT and LOINC differ in their versions:

| system | tx-dev | tx.fhir.org | `tx/tx.fhir.org.yml` | demo (before) | tx-dev-equivalent (`tx/sqlite-v2/demo-tx-dev.yml`) |
|---|---|---|---|---|---|
| SNOMED CT International | **20260701** (default), 20250201 | 20250201 (default), 20240201 | 20260701 (default), 20250201 | 20250201 (default) | **20260701 (default, J3)**, 20250201 |
| SNOMED CT US | 20230301, 20240301, 20250901 | same | same | 20250901 | 20230301, 20240301, 20250901 |
| SNOMED CT UK (83821000000107) | 20230412 | same | same | — | 20230412 |
| SNOMED CT Netherlands (11000146104) | **20260930** | 20240930 | 20260930 | — | 20260930 |
| SNOMED CT LOINC extension (11010000107) | **20261021** | — | 20261021 | — | 20261021 |
| SNOMED CT IPS (827022005) | — | 20241216 | — | — | — |
| SNOMED CT test (xsct 31000003106) | 20250909 | same | same (`sct_test_20250909e.cache`) | — | 20250909 |
| LOINC | 2.83 (default), 2.77 | same | same | 2.83 (default), 2.82 | 2.83 (default), 2.82, 2.77 (main's provider) |

Everything else (RxNorm 03022026, ICD-10-CM 2026-04-01, ICD-11 MMS 2026-01, UCUM 2.2, NDC
2021-11-01, CPT 2023, the npm packages' code systems, …) has the same versions on all three.
tx.fhir.org.yml in the repository already describes tx-dev's terminology set; production
tx.fhir.org runs an older library.

**Defaults now match tx-dev** (owner decision J3, 2026-11-02). Checked on both servers with
`$validate-code`:

| request | tx-dev | demo |
|---|---|---|
| unpinned SNOMED CT | International 20260701 | same |
| `system-version` = US edition only | US 20250901 (the latest) | same |
| `system-version` = International edition only | 20260701 | same |
| `http://snomed.info/sct?fhir_vs=…` | International 20260701 | same |
| unpinned LOINC | 2.83 | same |
| unpinned RxNorm | 03022026 | same |

`tx/sqlite-v2/demo-tx-dev.yml` is the demo's library: the VM's `library.yml` follows it, and the
earlier one is saved as `library.yml.bak-j3`. `demo.yml` stays the smaller set, with International
20250201 as its default. LOINC 2.82 is not on tx-dev; the demo keeps it because IG builds still
pin it.

## Files for the new versions

| file | source | concepts | size | build | notes |
|---|---|---|---|---|---|
| `sct-intl-20260701.db` | RF2 `SnomedCT_InternationalRF2_PRODUCTION_20260701T120000Z` (NLM, UMLS licence) | 534,402 | 648 MiB | 78 s, peak RSS 1,817 MiB | the cache `Snomed_Intl_20260701.cache` also has 534,402 concepts |
| `sct-us-20240301.db` | RF2 `SnomedCT_ManagedServiceUS_PRODUCTION_US1000124_20240301T120000Z` (NLM) | 517,628 | 659 MiB | 79 s, 1,664 MiB | |
| `sct-us-20230301.db` | RF2 `…US1000124_20230301T120000Z` (in `~/work/tx`) | 508,540 | 637 MiB | 78 s, 1,750 MiB | |
| `sct-nl-20260930.db` | reverse loader, `snomed-nl-20260930.cache` (cache v19, no warnings) | 551,496 | 905 MiB | 79 s, 2,314 MiB | map refsets lost, as in every cache |
| `sct-loinc-20261021.db` | reverse loader, `Snomed_loinc_20261021.cache` (v19, no warnings) | 581,630 | 727 MiB | 63 s, 2,087 MiB | 46,981 alternate identifiers (the LOINC codes) |
| `sct-uk-20230412.db` | reverse loader, `sct_uk_20230412.cache` (v16) | 1,077,400 | 1,394 MiB | 120 s, 2,612 MiB | **degraded**: the cache's display language refset 900000000000508004 has 1 member, so displays fall back to the FSN; no concrete values (v16); 8 refsets. No UK RF2 locally (TRUD needs a login) |
| `sct-test-20250909-nl.db` | RF2 `tx-source/snomed` of fhir-tx-ecosystem-ig adc5616, which adds Dutch descriptions and a Dutch language refset (`--version-uri http://snomed.info/xsct/31000003106/version/20250909`) | 2,281 | 3 MiB | 1 s | the tx-ecosystem test edition; engine-backed, so `concept in` (U5) and display regex follow the test owner's rules. It replaces `sct-test-20250909e.db`, reverse-loaded from the bucket cache, which has no Dutch |

All builds ran one at a time, under a 6 GB memory cap and `nice`, behind `MEASURE.lock`. With the
seven new files (nine SNOMED CT files in all) the local server's RSS after start is 1.30 GB
(1.23 GB anonymous), against 1.27 GB before.

LOINC 2.77: no release files are available locally (only main's `loinc-2.77-a.db` in the bucket),
so 2.77 is served by main's LOINC provider from that file.

## Catalog against tx-dev

The references were fetched on 2026-11-01 with `fetch-reference.js`: 237 requests to
`https://tx-dev.fhir.org/r4`, one at a time and 1.1 s apart, into their own disk cache. tx-dev
answered International 20260701 in 92 SNOMED expansions, US 20250901 in 15, and International
20250201 in 2. The local server was replayed against both reference folders, with the
tx-dev-equivalent library and unchanged defaults:

| reference | match | improved | both refuse | documented | DIFF |
|---|---|---|---|---|---|
| tx.fhir.org (`reference-tx.fhir.org/`) | 106 | 36 | 2 | 15 | 0 |
| tx-dev, our default International 20250201 | 82 | 35 | 2 | 13 | 27 |
| tx-dev, `system-version` = International 20260701 (tx-dev's default) | 106 | 35 | 2 | 15 | 1 |

**Every verdict change comes from tx-dev's SNOMED default.** The 27 DIFFs are unpinned
International requests that tx-dev answers from 20260701 and we answer from 20250201. With
`system-version` set to 20260701 they all match again:

- Totals and codes that differ between releases (25 entries): `ips-medication`, `ips-procedures`,
  `mixed-sct-icd10cm`, `multi-sct-loinc-rxnorm`, the `nested-*` entries, `sct-isa-diabetes`,
  `sct-implicit-*`, `sct-ecl-*` (cardinality, dotted, reverse, role group, nested, small value),
  `sct-child-of-diabetes`, `sct-findings-minus-disease-exclude`, `sct-text-filter-heart-attack`,
  `sct-display-language-unavailable`, `oh-sct-include-definition` and others.
- Two of the 15 documented differences (`oh-sct-expand-*`, `oh-sct-compose-property`) become
  DIFFs for the same reason, and are back to documented differences with the 2026 default.
- `sct-ecl-concrete-value`: improved → known-diff with our default, match with the 2026 default.
  tx-dev's cache carries concrete values; tx.fhir.org's 20250201 cache did not.
- With the extra parameter, `sct-system-version-param` returns 500. That is an artefact of the
  run: the parameter is sent twice with different versions ("Version inconsistent"). Unpinned, it
  matches.

So, against tx-dev, the engine differed only in its default version.

**After J3** (default International 20260701; local server and demo VM, same result on both):

| reference | match | improved | both refuse | documented | DIFF |
|---|---|---|---|---|---|
| tx-dev (`reference/`) | 107 | 35 | 2 | 15 | 0 |
| tx.fhir.org (`reference-tx.fhir.org/`, history) | 82 | 36 | 2 | 12 | 27 |

The 27 DIFFs now sit against tx.fhir.org's 20250201 answers, as expected. Against tx-dev there
are none: `sct-system-version-param` matches, since its DIFF came only from the duplicated
parameter in the simulation run.
