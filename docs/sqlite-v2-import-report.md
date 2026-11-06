# sqlite-v2 import report

This report covers the four databases built for the public demo with the sqlite-v2 importers. The
schema is in `docs/sqlite-v2-schema.md`.

**Build environment.** AMD Ryzen 5 3600 (12 threads), 62 GB RAM, NVMe SSD, Node v24.16.0,
better-sqlite3 12.x, roaring 2.7.0. Each build ran as a single process, with sources and output on
the same SSD and the OS page cache warm.

## Databases

| file | release | concepts (active / inactive) | size | build time | peak RSS |
|---|---|---|---|---|---|
| `sct-intl-20250201.db` | SNOMED CT International 2025-02-01, `http://snomed.info/sct/900000000000207008/version/20250201` | 519,624 (371,737 / 147,887) | 623.4 MiB | 74 s | 1,762 MiB |
| `sct-us-20250901.db` | SNOMED CT US Edition 2025-09-01, `http://snomed.info/sct/731000124108/version/20250901` | 532,287 (382,170 / 150,117) | 698.9 MiB | 81 s | 1,801 MiB |
| `loinc-2.83.db` | LOINC 2.83 | 257,266 (255,042 / 2,224) | 790.9 MiB | 61 s | 1,166 MiB |
| `loinc-2.82.db` | LOINC 2.82 (the earlier version IG builds still pin; not the default) | 252,207 (250,624 / 1,583) | 776.6 MiB | 61 s | 1,159 MiB |
| `rxnorm-03022026.db` | RxNorm 03022026 | 336,430 (228,042 / 108,388 archived) | 283.7 MiB | 39 s | 1,601 MiB |

The SNOMED and first LOINC/RxNorm files are in `/home/jmandel/hobby/.agent-scratch/tx-dbs-v2/`; `loinc-2.82.db` was built from the local LOINC 2.82 CSV release with the same importer. The SNOMED US package
(`ManagedServiceUS ... 20250901`) is a complete edition: its Snapshot contains 521,576 concepts in
the International module (900000000000207008, at 2025-07-01), 8,785 in the US module, and 1,926 in
the model module. It was imported on its own, with no separate International release.

For comparison, the v1 files take 1.46 GiB for SNOMED International and 1.35 GiB for LOINC 2.82. In
v2, full-text search takes most of each file: 271.7 MiB of 623.4 MiB for International, 454.5 MiB
of 790.9 MiB for LOINC, and 125.6 MiB of 283.7 MiB for RxNorm.

### Rows

| | SNOMED Intl | SNOMED US | LOINC | RxNorm |
|---|---:|---:|---:|---:|
| concept_link (incl. history; hierarchy + attributes) | 4,189,663 | 4,315,844 | 1,043,926 | 1,668,108 |
| concept_literal | 555,745 | 568,432 | 570,125 | 1,259,283 |
| designation | 1,675,759 | 1,717,940 | 1,492,573 | 538,522 |
| designation_acceptability | 2,636,100 | 2,683,183 | – | – |
| refset_member (rows with extra columns) | 1,007,620 | 1,302,411 | – | – |
| external_map | – | – | 15,572 | – |
| sets: descendants (sets / memberships / bytes) | 128,929 / 7,279,668 / 4.96 MB | 133,743 / 7,617,173 / 5.20 MB | 55,847 / 1,042,201 / 1.05 MB | – |
| sets: prop | 185,838 / 2,843,123 / 5.58 MB | 192,194 / 2,928,060 / 5.82 MB | 167,767 / 1,614,051 / 4.28 MB | 811,064 / 2,927,391 / 17.17 MB |
| sets: hasProp | 110 / 0.33 MB | 110 / 0.33 MB | 43 / 0.41 MB | 32 / 0.10 MB |
| sets: refset | 23 / 991,037 / 0.16 MB | 24 / 1,140,704 / 0.19 MB | 4,944 answer lists / 34,184 / 0.13 MB | – |
| sets: all / active / leaf | 117 B / 89 B / 49 KB | 132 B / 89 B / 49 KB | 61 B / 61 B / 25 KB | 89 B / 61 B / 61 B |
| `concept_set` table on disk | 19.8 MiB | 20.6 MiB | 11.4 MiB | 35.9 MiB |

Some staged rows were dropped as exact duplicates under the primary keys:

- SNOMED inferred relationships: the RF2 file has 3,477,838 rows for International (plus 1,039,248
  module and definition-status links). 327,423 rows were identical history rows and were dropped.
- One SNOMED US language-refset row.

## Time against targets

| stage | SNOMED Intl | SNOMED US | LOINC | RxNorm |
|---|---:|---:|---:|---:|
| parse (source-specific, includes staging inserts) | 31.3 s | 34.9 s | 14.1 s | 17.8 s |
| DFS numbering | 0.3 s | 0.3 s | 0.1 s | 0.1 s |
| rewrite to final ids (every table) | 14.7 s | 15.7 s | 5.1 s | 3.8 s |
| sets: descendants | 0.8 s | 0.8 s | 0.9 s | 0.0 s |
| sets: prop / hasProp / refset build | 5.2 s | 5.6 s | 2.4 s | 7.1 s |
| sets: write | 0.5 s | 0.5 s | 0.4 s | 1.2 s |
| FTS (display + designation) | 15.6 s | 16.0 s | 33.2 s | 6.8 s |
| secondary indexes | 0.5 s | 0.5 s | 0.4 s | 0.2 s |
| checks, sha256 of sources, ANALYZE, close, schema | 5.3 s | 6.8 s | 4.7 s | 2.5 s |
| **total** | **74 s** | **81 s** | **61 s** | **39 s** |
| target | 45–75 s | 60–90 s | 40–80 s | 60–120 s |
| verdict | inside, at the top | inside | inside | faster than target |

Peak RSS is 1.2–1.8 GiB for every build, below the 4 GB target.

Each build prints a line per stage with wall time, row count and peak RSS so far, and stores the
same figures in `provenance.timings`.

Two things dominate the remaining time:

- **Trigram FTS.** 12.9 s for 1.68 M SNOMED designations; 31.5 s for 1.49 M LOINC designations, whose
  RELATEDNAMES2 and translations are long.
- **SNOMED parse.** 9–10 s for the 400 MB relationship file.

SNOMED International first came in at 85 s. Writing language-refset acceptability through a text
join took 11.7 s. Acceptability is now held in typed arrays and written in counting-sort order,
which takes 3.8 s plus 1.3 s of staging.

Wasteful patterns checked:

| pattern | how the build handles it |
|---|---|
| per-row autocommit | none. Staging commits every 100 k rows; each rewrite is one `INSERT … SELECT … ORDER BY` inside one transaction |
| indexes before the bulk load | none. Final tables are written in primary-key order; the two secondary indexes are created afterwards; staging tables have no indexes |
| per-row prepare | none. Every statement is prepared once |
| per-row SQL for code → id | none. Codes resolve through an in-memory `Map` |
| millions of row objects | none. Rows stream with `iterate()` into typed arrays (edges, ancestor pairs, acceptability). The SNOMED language-refset strings are held until descriptions have ids (about 0.5 GB of the peak) |
| durable pragmas during the build | `journal_mode=OFF` and `synchronous=OFF`, with a 200 MB cache for staging and 400 MB for the destination; `journal_mode=DELETE` is restored at the end |
| FTS built twice or by trigger | once, with `INSERT … SELECT` |
| VACUUM | none. The destination is a fresh file written in key order; the staging file is deleted |
| one statement per tiny set | sets are serialised in memory and inserted with one prepared statement in one transaction: 315 k SNOMED sets in 0.5 s, 811 k RxNorm sets in 1.2 s |

## Validation

### Descendant sets compared with an independent transitive closure

| file | method | result |
|---|---|---|
| SNOMED Intl | every set compared with the v1 file `sct-intl-20250201-v1.db` `closure` table, matched by code | 128,929 of 128,929 anchors equal (7,279,668 pairs). Every v1 code is present. No v2 set lacks a v1 anchor |
| SNOMED US | recursive CTE over active is-a links, for the 20 largest sets plus 200 pseudo-random anchors | 220 of 220 equal (1,257,233 memberships) |
| LOINC 2.83 | every set compared with a Python closure over `PATH_TO_ROOT` | 55,847 of 55,847 equal (1,042,201 pairs) |

The invariants are checked on every build:

- The active prefix holds.
- Codes are unique.
- No descendant precedes an active ancestor. 0 inactive ancestors precede a descendant.
- The walk reached every active concept:

  | | roots | concepts reached |
  |---|---:|---:|
  | SNOMED Intl | 1 | 371,737 |
  | SNOMED US | 1 | 382,170 |
  | LOINC | 72,135 (most are terms outside the hierarchy) | 255,042 |
  | RxNorm (no hierarchy) | 228,042 | 228,042 |

### Spot checks against tx.fhir.org

Every check was a `GET /r4/CodeSystem/$lookup` with the matching `version`, with no `property`
parameter. The requests were sequential with a 0.4 s pause. Codes were spread evenly over the
active id range, with 3 more over the inactive range. RxNorm also got 211 (`SUPPRESS=O`) and 103903
(`SUPPRESS=E`).

The comparison covered:

- display;
- inactive;
- the full set of designation terms with their status. Supplement designations and LOINC
  `RELATEDNAMES2`, which is served as a property, were excluded;
- every property the server returned. `parent`, `child` and the LOINC `AnswerList` inverse were
  read from the stored prop sets.

| file | codes | display | inactive | designations | properties |
|---|---:|---|---|---|---|
| SNOMED Intl | 18 | 18/18 | 18/18 | 18/18 | parent 15/15, child 9/9, attributes 50/50, effectiveTime 18/18, module 18/18 (see 1) |
| SNOMED US | 8 | 8/8 | 8/8 | 8/8 | parent 5/5, child 4/4, attributes 22/22, effectiveTime 0/8 (see 2) |
| LOINC 2.83 | 18 | 18/18 | 18/18 | 18/18 | 137/137 property checks across 22 properties, including parent, child, AnswerList, CLASS, COMPONENT … METHOD_TYP, CLASSTYPE, STATUS and document-* |
| RxNorm 03022026 | 18 | 18/18 | 18/18 | 18/18 | – (the server returns only `inactive`) |

1. **SNOMED module.** The first run stored the property as `moduleId`. It was renamed `module`,
   which is the name the server uses, and the values were re-checked offline against the cached
   responses.
2. **SNOMED US effectiveTime.** For every US code, tx.fhir.org reports effectiveTime one day earlier
   than RF2 (for example 22298006: 2002-01-30, where RF2 has 20020131). International matches. This
   looks like the timezone bug fixed upstream in b082f98 ("fix timezone import bug in SCT
   importer"), still present in the cache that tx.fhir.org serves. The v2 files keep the RF2 date.

The first spot-check runs found three semantic differences, now fixed:

- LOINC designations of DISCOURAGED codes and RxNorm atoms of archived RXCUIs are served as active.
  They are now stored active, and the concept carries the inactive status.
- RxNorm display is the first non-SY atom in file order, not the TTY-priority rule from v1.
- tx.fhir.org treats every RXNCONSO concept as active, including `SUPPRESS=O` and `E`.

In total about 103 requests went to tx.fhir.org, more than the planned few dozen, because the
LOINC and RxNorm sets were run twice. Responses are now cached in the check script.

### Tests

`npx jest tests/tx/sqlite-v2-builder.test.js` runs 12 tests in about 0.5 s. It covers:

- numbering: topological depth-first order, the sort key, the active prefix, and descendants
  following ancestors;
- descendant sets equal to a recursive CTE for every concept of a polyhierarchy fixture with
  inactive concepts and history links;
- leaf, prop and hasProp sets equal to a recomputation from the facts, including role groups and
  `'1'` versus `1`;
- refset sets and `refset_member`;
- designation renumbering and FTS;
- provenance;
- explicit-pair (path) descendants.

## Small-set decision

The full table is in `docs/sqlite-v2-schema.md`. Every set is stored.

**Method.** Each built file was copied with `VACUUM INTO`. On the copy, sets with `card <= T` were
deleted for T = 1, 8 and 64, the partial reverse indexes
`concept_link(property_id, target_id, source_id)` and
`concept_literal(property_id, value, concept_id)` were added, and the copy was vacuumed. The
resulting file was then compared with the original.

**Result.** The threshold option is larger for every file and every T:

| file | growth |
|---|---|
| SNOMED International | +12.6 MiB to +20.9 MiB |
| RxNorm | +3.5 MiB to +14.9 MiB |

The reverse indexes alone cost 30–49 MiB.

## What upstream carries, and what v2 does

**Carried.** These are the features the current upstream importers handle:

- SNOMED alternate identifiers (`sct2_Identifier`; the International and US files have 0 active
  rows);
- concrete values: active inferred rows, typed;
- the module as a property;
- definition status, as a concept-valued property `definitionStatusId`;
- display chosen from the US English preferred synonym, as in `cs-snomed.js`;
- LOINC 2.83 `ComponentHierarchyBySystem`, which is required;
- LOINC external mappings: PartRelatedCodeMapping without RadLex, the AnswerList `ExtCode*`
  columns, and the IEEE table with equivalence flipped to the target side;
- RxNorm `RXNATOMARCHIVE` concepts.

**Broader than upstream.** The SNOMED map refsets (SimpleMap, ExtendedMap) are kept in
`refset_member`, together with their membership sets; the upstream binary skips any refset file
whose header mentions "map". This accounts for most of the 97 MiB `refset_member` in the US file,
which carries the ICD-10-CM map. Dropping them is a one-line filter if the demo does not need them.

**Deferred or not read:**

- SNOMED stated relationships and the OWL refset (neither v1 nor upstream reads them);
- refset rows that reference descriptions: 488,092 International and 501,689 US rows, such as
  description inactivation indicators. Language refsets are not affected; they become
  `designation_acceptability`;
- LOINC `LoincPartLink_Supplementary`, Loinc.csv `DisplayName` (tx.fhir.org does not serve it as a
  designation) and RSNA playbook groups;
- RxNorm `RXNSAT`, AUI-level relationships, and `MERGED_TO_RXCUI` of archived atoms.

## Caveats and open problems

1. **RxNorm REL filters (fixed).** `has_precise_ingredient` and `precise_ingredient_of` occur under
   two RELs each (RN/RO, RB/RO). Their links are now also stored under REL-qualified properties
   (`has_precise_ingredient@RN`, …) and `relaByRel` names those, so a REL filter is exact
   (RN: 7,142 rows, RO: 5,091, as in RXNREL). The files in `tx-dbs-v2/` predate this; rebuild
   RxNorm to get it.
2. **FTS.** The trigram indexes are 40–57% of each file. Whether the provider needs trigram
   substring search rather than unicode61 word search has not been decided here.
3. **cs_config keys** (`inverseProperties`, `displayRefsets`, `implicitValueSets`, `relaByRel`, …)
   are a proposal for the provider rewrite. No provider reads these files yet.
4. **Native dependency.** `roaring` 2.7.0 installs a prebuilt binary for glibc x64. An Alpine (musl)
   build would compile it with node-gyp; this was not tested.
5. **Timings.** All timings are warm-cache, single runs. SNOMED International at 74 s sits at the top
   of its range. The next lever would be the parse of the relationship file (9 s); it was not
   pursued because the build is inside the target.
