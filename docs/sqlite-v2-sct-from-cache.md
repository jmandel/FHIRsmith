# SNOMED CT editions from FHIRsmith caches ("reverse loader")

`npm run tx-import -- snomed-v2-from-cache import -s <file.cache> -d <file.db>` converts a FHIRsmith
SNOMED CT cache (the `*.cache` files that main's SNOMED provider reads, `tx/sct/structures.js`) into a
sqlite-v2 file. The output has the same layout as an RF2 import (`snomed-v2 import`). Use it for the
editions we can only get as tx.fhir.org's caches in the public bucket
(https://storage.googleapis.com/tx-fhir-org/).

`npm run tx-import -- snomed-v2-from-cache inspect <files...>` checks caches for the known defects
without importing them.

## Recommendation

- **Serve reverse-loaded editions.** A good cache gives the same facts as RF2 for everything the
  server answers from the file:
  - concepts, status, module, definition status and effectiveTime;
  - every description, with its language, active flag and language-refset acceptability, and
    therefore the same displays;
  - all relationships, active and inactive, with role groups;
  - history associations, simple refsets, MRCM and the other non-map refsets.

  On International 20250201 and US 20250901 the reverse-loaded file and the RF2 file have the same
  `concept_id` numbering, and every stored descendant, property, leaf and active set is
  byte-identical. Replaying the catalog's 102 SNOMED entries gives identical responses, except
  where the content listed below is missing.
- **What only RF2 provides:**
  - **Map refsets.** These are ICD-10, ICD-O, CTV3 and the US ICD-10-CM map
    (`6011000124106`). Main's cache importer skips any refset file whose header mentions "map", so
    the maps are lost in every cache.
  - **Concrete values** (drug strengths and counts) in caches older than format v19. All the v16
    and v17 caches lack them.
  - **Clean content for the defective cache vintages** (see "Cache vintages" below).

  International and US Edition come from RF2 through NLM, as they do today. Every other edition
  can come from its cache. Where an edition matters for ECL over drug strengths or for implicit
  map value sets, prefer RF2 if it can ever be obtained.
- **Do not import the defective caches:**
  - `sct_dk_20260331.cache` and `sct_us_20250901.cache` (the US one without `b`): no modules, no
    primitive flag, and refsets collapsed onto one concept. The US file also has no US English
    refset.
  - `sct_test_20250814a.cache` and `sct_test_20250909a.cache`: no modules and/or no primitive flag.

  The importer refuses these files unless `--force` is given. tx.fhir.org's current metadata lists
  no DK edition. Its loaded versions are International 20240201/20250201, US
  20230301/20240301/20250901, NL 20240930, UK 20230412, IPS 20241216 and test 20250909. Some
  earlier builds did load DK 20260331: error messages from those builds in the IG corpus list it
  as a valid version. Before the cache is used again, it should be rebuilt from RF2 with the
  current importer.
- **The US 20250901 problem is live on tx.fhir.org.** A live check by the coordinator found that
  `$lookup` with `property=*` returns no `module` for the US version but does return one for
  International. That is the symptom of a cache without modules, as in `sct_us_20250901.cache`
  above. The reverse loader reads the US version from the `b` cache or from RF2, which both have
  modules.
- **UK 20230412 is degraded at the source.** Its cache holds 8 refsets (1,149 members). There is
  no UK language refset, and the GB English refset has 1 member. Displays therefore fall back to
  the FSN, and there are no history associations and no UK refsets. tx.fhir.org serves the same
  data, so the reverse-loaded file matches production (179 of 179 UK calls in the IG corpus are
  identical). It is still wrong, and a UK RF2 or a rebuilt cache would fix it.

## Fidelity: cache vs RF2

The table compares a good cache (v16 from the Pascal server, v17–v19 from the JS importer) with
the RF2 import. Content that the v2 schema does not store either way (by the content scope rule)
is marked "n/a".

| content | status | notes |
|---|---|---|
| concepts: code, active | preserved | |
| concept module | preserved | lost in defective v17 vintages (all modules 0) |
| definition status (primitive/defined) | preserved | primitive bit (0x10); lost in defective v17 vintages |
| concept effectiveTime | preserved / derivable | caches built east of UTC before upstream b082f98 are one day early; `--date-shift auto` detects this (no concept on the release date, some on the day before) and adds a day |
| descriptions: term, type, active | preserved | all descriptions, including inactive descriptions and text definitions (TextDefinition files share the header) |
| description language | preserved for en, fr, nl, es, sv, da, de, it, cs | the cache stores a byte. Any other language code was stored as `en` and is lost. None of the bucket's editions uses another language |
| description id, module, case significance, effectiveTime | in cache, n/a | the v2 schema does not store them |
| language refset acceptability | preserved | the language refsets are recognised as descendants of 900000000000506000. `designation.preferred` and the display rule use the edition's display refsets (main's table: US English for International/US, GB English for UK, otherwise US then GB) |
| display | preserved | same rule as the RF2 importer and `cs-snomed.js getDisplayNameEx`; identical on International and US |
| relationships: source, type, target, group, active (incl. inactive history rows) | preserved | the cache importer reads the same non-stated `sct2_Relationship` rows |
| relationship characteristic type (inferred vs additional), modifier, id, module, effectiveTime | n/a | not in the v2 schema (the cache keeps only id, date and a "defining" flag) |
| stated relationships, OWL axioms | n/a | neither importer reads them |
| concrete values | v19 only | lost in v16–v18 caches (36,121 values for International 20250201) |
| alternate identifiers (sct2_Identifier) | v18+ only | only the LOINC Extension uses them |
| history associations (REPLACED BY, SAME AS, ...), inactivation indicators | preserved | concept-referencing association / attribute-value refsets, with their target fields |
| simple refsets, MRCM refsets, module dependency, descriptors | preserved | membership sets and refset_member fields are identical |
| map refsets | **lost** | skipped by the cache importer (a header containing "map") |
| inactive refset members | n/a | both importers keep active members only |
| description-referencing refsets other than language | in cache, n/a | the content scope rule drops them; counted (`descriptionRefsetRowsSkipped`) |
| refset fields naming a concept that is not in the edition | lost | the cache stores the first concept (offset 0). The loader writes `''` and counts it (`unknownFieldValues`). 0 in every bucket edition; 25 rows in the multi-module test fixture |
| refsets whose own concept is not in the edition | n/a | the cache files them under the first concept, and RF2 skips them. The loader skips them too |
| refset member ids, member module/effectiveTime | n/a | not in the v2 schema |

## Validation

### International 20250201 and US 20250901 (RF2 file vs reverse-loaded cache)

`node tx/importers/sqlite-v2/diff.js A.db B.db` compares two v2 files by codes, table by table.
It then compares `concept_set` for every (kind, property code, value): by bytes when the numbering
is identical, and otherwise after translating the members.

| | International: RF2 / cache v16 | US: RF2 / cache v19 (`20250901b`) |
|---|---|---|
| concept | 519,624 / 519,624, 0 differences | 532,287 / 532,287, 0 differences |
| concept_link | 4,189,663 / 4,189,663, 0 | 4,315,844 / 4,315,844, 0 |
| concept_literal | 555,745 / 519,624: 36,121 concrete values only in RF2 | 568,432 / 568,432, 0 |
| designation | 1,675,759 / 1,675,759, 0 | 1,717,940 / 1,717,940, 0 |
| designation_acceptability | 2,636,100 / 2,636,100, 0 | 2,683,183 / 2,683,183, 0 |
| refset_member | 1,007,620 / 314,780: maps 446608001, 447562003, 900000000000497000 only in RF2 | 1,302,411 / 320,766: the same maps + 6011000124106 |
| concept_id numbering | identical | identical |
| sets: descendants, all, active, leaf | 128,929 / 128,929 byte-identical | 133,743 / 133,743 byte-identical |
| sets: prop / hasProp | 185,154 identical; 684 + 6 concrete-value sets only in RF2 | 192,194 + 110 identical |
| sets: refset | 20 identical; 3 maps only in RF2 | 20 identical; 4 maps only in RF2 |

The older US cache `sct_us_20250901.cache` (v17, without `b`) differs everywhere it is defective:

- 532,287 module links missing, and 379,425 concepts that are primitive in RF2 come out as fully
  defined;
- the US English refset is missing (1,352,337 acceptability rows), which changes 45,129 displays
  to GB spelling or to the FSN;
- 12 refsets are collapsed onto concept `100005`;
- effectiveTime is one day early.

The `inspect` command flags it.

**Catalog replay** (`tx/sqlite-v2/catalog/replay.js`, the 102 entries that use SNOMED, same server
code, once with the RF2 files and once with the reverse-loaded files):

- `tools/compare-response-dirs.js` compares the full response bodies (minus ids and timestamps):
  158 of 168 responses are identical. The rest are:
  - 1 concrete-value ECL expand (`sct-ecl-concrete-value`: total 439 → 0);
  - 7 responses that use the ICD-10-CM map refset (`sct-implicit-refset-icd10cm-map` ×4,
    `sct-refset-icd10cm-map-ecl`, `validate-implicit-refset`, `validate-refset-icd10cm-map-ecl`);
  - 2 later pages that the cache run did not request, because the map expansion was empty.
- Against tx.fhir.org's reference answers, the cache-loaded server moves 2 entries from
  "improved" to "both refuse" and 2 from "known difference" to "match". tx.fhir.org's own cache
  lacks the ICD-10-CM map too.

**Round-trip test** (`tests/tx/sqlite-v2-sct-from-cache.test.js`):

1. Build a v19 cache from the test-edition RF2 in `tx/data/snomed` with main's cache importer.
2. Reverse-load that cache.
3. Compare it with the RF2 v2 import of the same files.

Concepts, links, literals (including concrete values), designations, acceptability, alternate
identifiers and every stored set are identical. The only differences are 25 refset rows whose
fields name concepts that are absent from the fixture.

### Cache vintages (all 27 caches in the bucket, `inspect`)

| vintage | files | state |
|---|---|---|
| v16 (Pascal server) | au 20230731, be 20231115, ch 20230607/20260607, intl 20240201/20240801/20250201, ips 20241216, nl 20240930, se 20231130, uk 20230412, us 20230301/20240301 | good except: no concrete values; UK lacks its refsets (see above) |
| v17 (JS importer, early) | dk 20250930, es 20250510, test 20250909b/c | good; no concrete values |
| v17 (JS importer, defective) | dk 20260331, us 20250901, test 20250814a, test 20250909a | refused (see Recommendation). The dk and us files also have dates one day early |
| v18 | test 20250909d | good; alternate identifiers, no concrete values |
| v19 (current) | intl 20260701, loinc 20261021, nl 20260930, us 20250901b, test 20250909e | complete except map refsets |

## Several editions on one server

Test server (`~/hobby/.agent-scratch/sctrev-data`, port 8096, library `lib-multi.yml`):

- 20 SNOMED files: International 20260701 as the default (as in production), RF2 International
  20250201 and US 20250901, and 17 reverse-loaded files: AU, BE, CH ×2, DK, ES, International
  20240201/20240801, IPS, NL ×2, SE, UK, US 20230301/20240301, the LOINC Extension and the test
  edition;
- plus LOINC, RxNorm and the packages, as in the demo.

**Memory.** Startup RSS is 1,065 MiB with 20 SNOMED files and 1,078 MiB with the 2 RF2 files
(the two runs differ only by noise). After 453 replayed IG calls the peak was 1,306 MiB. An extra
edition costs disk, not RAM.

**Edition and version selection:**

| request | result |
|---|---|
| `$lookup` with no version | International 20260701 (default) |
| `version=http://snomed.info/sct/83821000000107` | UK 20230412 |
| `version=…/11000146104` (two NL versions loaded) | NL 20260930, the latest; `displayLanguage=nl` gives `myocardinfarct` |
| `version=…/11000146104/version/20240930` | NL 20240930 |
| `http://snomed.info/sct/11000146104?fhir_vs=isa/22298006` | NL 20260930 (latest). **Fixed in this branch**: the first-registered version used to answer |
| `http://snomed.info/sct/32506021000036107?fhir_vs=isa/22298006` | AU 20230731, 122 codes |
| `http://snomed.info/sct/11000172109?fhir_vs=…&displayLanguage=fr` | BE, French displays (`infarctus du myocarde`) |
| unknown version (UK 20240605) | not-found, listing the loaded versions |

**Behaviour change: edition-only implicit value set URLs.** A URL such as
`http://snomed.info/sct/<module>?fhir_vs=…` now resolves to the latest loaded version of that
edition. The owner kept this change (2026-11-01).

- **Spec basis.** The SNOMED CT on FHIR page (terminology.hl7.org) defines an edition URI without
  `/version/` as the most recent version of that edition known to the server. A `version`
  parameter naming only the edition (`$lookup`, `$validate-code`) already behaves this way.
- **Where the fix is.** `SnomedV2Factory.buildKnownValueSet`: a file declines an edition-only URL
  when a later version of the same edition is loaded.
- **Main's behaviour.** Main resolves the URL to the first-registered file of that edition
  (`tx/provider.js findKnownValueSet` takes the first factory that accepts the URL).
  tx.fhir.org loads three US versions (20230301, 20240301, 20250901), so
  `http://snomed.info/sct/731000124108?fhir_vs=…` resolves to whichever US file the library
  lists first.

This is finding U21 in `docs/sqlite-v2-upstream-findings.md`, with a proposed test.

**IG corpus spot check.** 453 distinct R4 calls from `igcorpus/corpus/unique_calls` carry a SNOMED
code and pin one of these editions or versions: UK, UK 20240605, NL, NL 20240930, AU,
International 20260701, CH, BE, DK, US 20230301/20240301 and the LOINC Extension. They were
replayed without repinning (`txreplay.py --keys`, then `txcompare.py`):

| edition pinned | calls | result vs tx.fhir.org |
|---|---|---|
| UK (edition only) | 181 | 179 exact; 2 call a value set that is not loaded (eHDSI) |
| UK 20240605 (not in bucket) | 27 | both answer "version not found"; only the list of valid versions differs |
| NL 20240930 | 25 | 25 exact |
| NL (edition only) | 101 | 2 exact. 96 are version drift: tx.fhir.org then had NL 20240930, we pick 20260930, so the version differs and 12 codes added since then now validate. 1 is a filter tx.fhir.org could not run (`concept in 41000147108`), which we evaluate. 2 are newer codes |
| AU, CH, BE, DK, International 20260701, LOINC Extension | 116 | 1 exact (CH). Most of the rest pin editions tx.fhir.org had not loaded at the time: it answered "version not found", or a 500 for BE caused by a VSAC error, and we answer. The 13 DK calls differ only in the LOINC version (2.82 vs 2.83) |
| US 20230301 / 20240301 | 3 | All 3 return a different display: we return the preferred term, tx.fhir.org returned the FSN or the submitted synonym. This is the validate-code display rule (TRACKER N1), not data: the stored descriptions and acceptability are right |

Every difference is version drift, an edition that tx.fhir.org did not load, or the validate-code
display rule. None comes from the reverse load.

## Sizes, time and memory

All 23 importable bucket caches were converted, one at a time, under
`systemd-run --user --scope -p MemoryMax=6G nice -n 19` and the measurement lock. Machine: Ryzen 5
3600, NVMe, Node 24, load average 1.8–4.1 from other agents. Outputs are in
`~/hobby/.agent-scratch/tx-dbs-v2-rev/`, and per-file provenance (warnings, counts, timings) is in
each file's `provenance` table.

| file | cache format | concepts | cache MiB | v2 MiB | import s | peak RSS MiB |
|---|---|---:|---:|---:|---:|---:|
| sct-au-20230731 | 16 | 662,362 | 956 | 750 | 75 | 2,528 |
| sct-be-20231115 | 16 | 506,521 | 993 | 738 | 66 | 2,398 |
| sct-ch-20230607 | 16 | 503,197 | 829 | 593 | 52 | 2,227 |
| sct-ch-20260607 | 16 | 532,845 | 926 | 723 | 66 | 2,412 |
| sct-dk-20250930 | 17 | 524,828 | 908 | 671 | 60 | 2,348 |
| sct-es-20250510 | 17 | 521,112 | 1,171 | 958 | 90 | 2,779 |
| sct-intl-20240201 | 16 | 510,326 | 801 | 569 | 50 | 2,064 |
| sct-intl-20240801 | 16 | 515,120 | 813 | 577 | 50 | 2,066 |
| sct-intl-20250201 | 16 | 519,624 | 822 | 593 | 52 | 2,082 |
| sct-intl-20260701 | 19 | 534,402 | 600 | 617 | 55 | 1,914 |
| sct-ips-20241216 | 16 | 19,697 | 27 | 18 | 2 | 275 |
| sct-loinc-20261021 | 19 | 581,630 | 683 | 727 | 63 | 2,087 |
| sct-nl-20240930 | 16 | 530,404 | 1,092 | 837 | 75 | 2,576 |
| sct-nl-20260930 | 19 | 551,496 | 803 | 905 | 79 | 2,314 |
| sct-se-20231130 | 16 | 508,494 | 893 | 646 | 56 | 2,296 |
| sct-test-20250909e | 19 | 2,280 | 2 | 3 | 0 | 142 |
| sct-uk-20230412 | 16 | 1,077,400 | 839 | 1,394 | 120 | 2,612 |
| sct-us-20230301 | 16 | 508,540 | 808 | 562 | 50 | 2,180 |
| sct-us-20240301 | 16 | 517,628 | 829 | 577 | 51 | 2,095 |
| sct-us-20250901b | 19 | 532,287 | 610 | 613 | 55 | 2,056 |

(The table also leaves out test 20250909b/c/d: they are 3 MiB each and have the same version URI
as 20250909e.)

- **Time.** Reading a cache takes about 1 s. Decoding takes 10–20 s. The rest is the shared final
  stage, mostly full-text indexing. Peak RSS is 1.9–2.8 GiB.
- **Size.** v2 files are 20–30% smaller than the v16 caches and 0–13% larger than the v19 caches.
  UK is the outlier at 1.39 GiB: it has 1.08 M concepts and 8.0 M relationships.

**Production set** (`tx/tx.fhir.org.yml`, 9 SNOMED files):

- RF2 International 20250201 and US 20250901 (623 + 699 MiB);
- reverse-loaded International 20260701, NL 20260930, UK 20230412, US 20230301, US 20240301,
  the LOINC Extension 20261021 and test 20250909e.

This is 6.0 GiB of v2 files against 5.9 GiB of caches, and about 8 minutes of import.

**All 20 distinct versions in the bucket** come to 12.8 GiB (v2) against 15.0 GiB (caches), about
20 minutes of import.

**Not covered by the bucket.** The IG corpus also pins these editions:

- CZ 11000279109: 59 calls;
- Canadian French 20611000087101: 30;
- UK 20240605: 27;
- 11000315107: 5;
- Chilean 21000325107 (20250915, 20260315);
- NZ 21000210109.

They need RF2 or new caches.

## Not done / follow-ups

- **Shared ids across versions** (one space per edition, STATE "id spaces") is not attempted. Each
  file is one release, as in the v2 decision.
- **The RF2 v2 importer reads one concept file and one relationship file.** That works for full
  editions (International, US). Extension-only packages split by module need several files per
  kind; the round-trip test merges the split fixture first. RF2 for any other national edition
  would need this.
- Upstream bugs to report for the cache importer and the production set:
  - map refsets are dropped;
  - field values that cannot be resolved become the first concept;
  - the DK 20260331 cache is defective. Older production builds loaded it; the current one does not;
  - US 20250901 on tx.fhir.org has no concept modules (`$lookup property=*`, checked live);
  - edition-only implicit value set URLs resolve to the first-registered version (U21);
  - the UK 20230412 cache has no language refsets.
