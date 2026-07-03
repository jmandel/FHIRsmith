# sqlite-v1 source-of-truth verification

Independent checks that the sqlite-v1 importers (`tx/importers/import-{loinc,rxnorm,sct}-sqlite-v1.module.js`)
faithfully loaded their raw distributions. These scripts deliberately share **no
code** with the importers: they re-parse the raw source files with their own
CSV/RRF/RF2 readers, recompute hierarchy closures with their own BFS, and only
encode the importers' *declared* mappings (from `docs/sqlite-v1-design.md` and
the importer headers). This is layer 2 of the correctness strategy in
`docs/sqlite-v1-design.md`.

## Running

```sh
node scripts/sqlite-v1-verify/verify-loinc.mjs  --db <loinc.db>  --source ~/work/tx/Loinc_2.82
node scripts/sqlite-v1-verify/verify-rxnorm.mjs --db <rxnorm.db> --source ~/work/tx/rrf
node scripts/sqlite-v1-verify/verify-sct.mjs    --db <sct.db>    --source ~/work/tx/SnomedCT_..._20260301T120000Z
```

Common options:

| flag | default | meaning |
|---|---|---|
| `--samples N` | 25 | how many codes each sampled check draws |
| `--seed S` | 42 | RNG seed; sampling is fully deterministic (sorted candidates + seeded shuffle / seeded reservoir over a deterministic stream order) |
| `--allow-capped` | off | verify a smoke DB built with `--max-rows` / `--max-concepts` |

Each script prints a PASS/FAIL line per check with expected-vs-actual detail,
runs every check even after a failure, and exits 1 if any check failed
(2 for usage/setup errors).

### `--allow-capped` semantics

Only the full-count checks that a smoke cap actually truncates are relaxed to
"DB count <= source count". Everything else stays **exact**, because samples
are drawn *from the DB* and verified against the source, and because
"restricted to loaded concepts" checks use the DB's own concept set — the same
filter the importer applied:

* **LOINC**: only main-code counts are relaxed (`--max-rows` caps only
  `Loinc.csv`); parts, answers, answer lists, hierarchy nodes, hierarchy
  closure, and answer-list membership remain exact. Capped main codes are
  identified as "has a STATUS literal" (hierarchy-filler main codes don't get
  one), so field-level checks stay exact.
* **RxNorm**: `--max-rows` caps RXNCONSO rows scanned. The importer records
  that number in `load_audit.stats_json.scannedConso`; the verifier limits its
  own RXNCONSO scan to the same row count, so per-CUI aggregates (active,
  SUPPRESS, designations) stay exact. If the audit row is missing, count checks
  degrade to `<=`. RXNSTY/RXNREL checks are exact in both modes.
* **SNOMED CT**: only the total/active concept counts are relaxed
  (`--max-concepts` caps concept rows); closure, displays, designations,
  refsets, and relationship links are all recomputed over the concepts present
  in the DB, exactly as the importer filters them.

## What each check proves

### verify-loinc.mjs (source: LoincTable/Loinc.csv + AccessoryFiles)

1. **Concept universe** — counts data rows in `Loinc.csv` with its own
   quoted-CSV record counter (embedded newlines/commas handled), then builds
   the full expected code universe (LOINC_NUM ∪ PartNumber ∪ AnswerListId ∪
   AnswerStringId ∪ hierarchy CODE/IMMEDIATE_PARENT) and compares it with the
   DB per code-shape class (`\d+-\d`, `LP*`, `LA*`, `LL*`, other) by exact set
   difference. Also asserts no DB concept exists outside the source universe.
2. **Active mapping** — recomputes `active` from `STATUS` (`ACTIVE`/`TRIAL` →
   active, unknown/empty → the declared `ACTIVE` fallback) for *every* loaded
   main code, plus a total-count comparison and a per-STATUS breakdown when
   uncapped/mismatching.
3. **Sampled field values** — for N sampled main codes: `display ==
   LONG_COMMON_NAME` (fallback `DisplayName`/`SHORTNAME`/code), `CLASSTYPE`
   literal `value_num`, `UNITSREQUIRED` literal `value_bool` (`Y`→1),
   `STATUS` literal `value_text` — each against the raw CSV row.
4. **Hierarchy closure** — own BFS over `IMMEDIATE_PARENT` edges from
   `ComponentHierarchyBySystem.csv` for N sampled interior part codes; the
   recomputed descendant set must equal the DB `closure` descendants
   **exactly**. Also asserts the closure table has zero self-rows globally.
5. **Answer lists** — for N sampled `AnswerListId`s: the member set from
   `AnswerList.csv` must equal the `value_set_member` codes for
   `http://loinc.org/vs/{id}`; plus total value_set count == lists with ≥1
   member (exact even when capped — answers are never capped).
6. **Designation spot-check** — sampled codes with a `SHORTNAME` must have a
   `use_code='SHORTNAME'` designation with exactly that term.

### verify-rxnorm.mjs (source: RRF directory)

1. **Concept count** — distinct RXCUI with ≥1 `SAB=RXNORM` atom, exact set
   difference both directions.
2. **Active mapping** — CUI active iff any RXNORM atom `SUPPRESS ∉ {O,E}`;
   verified per-CUI for *every* concept plus totals.
3. **Designations** — total == RXNORM atoms with non-empty STR; for N sampled
   CUIs the DB `(use_code, term)` multiset must equal the source `(TTY, STR)`
   multiset.
4. **STY** — literals must store the RXNSTY **TUI** (T-code): total row count
   restricted to loaded CUIs, plus per-sample multiset equality and a
   TUI-shape (`T###`) report.
5. **RELA links** — total `concept_link` count == RXNREL rows with
   `SAB=RXNORM`, non-empty RELA, both CUIs loaded (the script first probes the
   DB for duplicate `(source, property, target)` triples and reports which
   convention holds — the importer declares one row per RXNREL row, no
   dedupe). 20 seeded-reservoir-sampled rows must exist with the declared
   direction `source=concept(RXCUI2), target=concept(RXCUI1), property=RELA`.
6. **SUPPRESS literal** — every concept has exactly one; value must be `'N'`
   if any atom is `'N'`, else the first atom's value (`''`→`'N'`). Verified
   for every concept.
7. **Version** — `code_system.version`/`release_date` re-derived from the
   RXNSAB `SVER` of the `RSAB=RXNORM` row (`20AA_260504F` → `05042026` /
   `2026-05-04`).

### verify-sct.mjs (source: RF2 release root with Snapshot files)

1. **Concept counts** — DB total/active vs `sct2_Concept` snapshot rows, plus
   per-concept active flags for every DB concept (exact even when capped).
2. **Closure** — own BFS over active is-a rows (`typeId=116680003`) from
   `sct2_Relationship` (inferred snapshot only; both endpoints loaded) for N
   sampled concepts; ancestor sets must equal the DB closure **exactly**
   (remember: no self-rows — asserted globally too). Descendant COUNT compared
   for 105590001 *Substance* (or, on capped DBs where it is absent, the loaded
   concept with the most direct children).
3. **Display** — for N sampled active concepts: display must be the term of an
   active en-US preferred synonym (description in refset 900000000000509007
   with acceptability 900000000000548007, active member rows, non-FSN), with
   the importer's documented fallbacks (FSN → first active term → code);
   fallback usage is reported, as is any display sourced from a preferred
   *text definition* (the importer accepts any preferred non-FSN).
4. **Designations** — total designation count == description+text-definition
   rows for loaded concepts; sampled concepts' DB `(use_code, term)` active
   multiset must cover every active description row; FSN rows checked for
   `use_code=900000000000003001`.
5. **Refsets** — 5 sampled refset ids from `der2_Refset_Simple`: active member
   rows (restricted to loaded concepts) must equal the `value_set_member`
   codes for `http://snomed.info/sct?fhir_vs=refset/{id}`; total value_set
   count checked too.
6. **Relationship links** — 20 seeded-reservoir-sampled active non-is-a rows
   must exist as `concept_link` with `source=sourceId`, `target=destinationId`,
   `property=typeId`, `group_id=relationshipGroup`, `active=1`.
7. **code_system row** — `canonical_uri ==
   http://snomed.info/sct/{module}/version/{YYYYMMDD}` and `release_date`,
   re-derived from the release directory name (e.g. `..._US1000124_20260301T120000Z`
   → module 731000124108, version 20260301, release date 2026-03-01).

## Notes

* Requires `better-sqlite3` (resolved from the repo's `node_modules`).
* The scripts open the DB read-only; do not run them against a DB an import is
  still writing.
* Full-source scans stream line-by-line; the SNOMED script holds the is-a
  adjacency in memory (~a few hundred MB for a full US edition). If node runs
  out of heap, re-run with `NODE_OPTIONS=--max-old-space-size=4096`.
