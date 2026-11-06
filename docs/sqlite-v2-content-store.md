# sqlite-v2 content store: package CodeSystems, package ValueSets and VSAC

Status: design + prototype (branch `sqlite-v2-content`, off `sqlite-v2-provider`; the CodeSystem half
was built on `sqlite-v2-content-cs` and merged). Local only. Measurements and parity results: section 9.

On `sqlite-v2-aligned` the core hooks this design needed are upstream draft PR #334's: the stored-list
handle (`tx/library/stored-concepts.js`), `thoVersions`/`yieldToTHO` on value-set providers,
`CodeSystem.providerFactory` (`StoredCodeSystem` supplies `StoredFhirProvider`), and `prefetchCodes`.
Both halves are on by default (`modules.tx.sqliteV2.content`).

## 1. Recommendation

1. **One file format for everything sqlite-v2 serves.** A sqlite-v2 file holds *code-system
   blocks* and, optionally, *value sets*. Today's SNOMED CT, LOINC, RxNorm and CPT files are the
   one-block, no-value-set case and keep working unchanged. A package version becomes one file
   (`hl7.terminology#7.5.0` → one file with its 935 code systems and 2,540 value sets). VSAC is one
   file of value sets that its sync updates in place.
2. **Value sets are stored as text, never as ids.** Each include/exclude is a row (system,
   version, filters, imported value sets). Each enumerated code is a row (code, display, and the
   concept's own JSON only when it carries more than code and display). Codes are resolved
   against the code-system files at request time, by the same engine and the same batched reads
   as every other request. Nothing in a value-set row refers to another file's concept ids, so a
   new SNOMED/LOINC/RxNorm release or a VSAC sync never invalidates anything.
3. **Value sets first.** Package value sets plus VSAC are ~1.3 GB of heap per process today
   (VSAC ~1.07 GB, PHIN VADS 196 MB); moving them to rows takes that to near zero, and big
   enumerated lists become cheaper, not dearer: `$validate-code` against a 57,017-code list is one
   indexed lookup instead of a scan (main) or a 6 MB JSON parse (the on-demand JSON prototype).
4. **Package CodeSystems second, through `StoredCodeSystem`.** A package CodeSystem's concepts
   live in its block. The server keeps a small `StoredCodeSystem` (a `CodeSystem` with the
   metadata and property/filter definitions, no concepts) in the same places main keeps the
   full resource, so main's version, THO-precedence, supplement and read/search rules are
   untouched. Main's own `FhirCodeSystemProvider` still answers every per-concept question
   (display, designations, properties, status, abstract, extensions), fed one concept at a time
   from SQLite; the sqlite-v2 engine answers every set question (filters, subsumption,
   iteration, `processSelection`) with a `fhir` dialect that reproduces `cs-cs.js`'s filter
   rules. The payoff is concentrated in `fhir.tx.support` (ICD-10-CM, ICD-10-PCS, ISO 11073,
   RadLex, ICD-9-CM: 224 MB of heap) and in engine-backed ICD-10-CM `is-a` filters (2,658 VSAC
   includes use one); the other ~2,500 package code systems hold ~45 MB, and are moved for
   uniformity, not for memory.
5. **What stays on main's in-memory path:** CodeSystems that arrive with a request
   (`tx-resource`, inline `codeSystem`), supplements (the layer mechanism and upstream's display
   helpers work on the resource), and, in this prototype, the FHIR core packages
   (`hl7.fhir.r4.core`/`r5.core`, loaded per endpoint by `provider.loadNpm`; 17 MB) and package
   ConceptMaps.

## 2. One model across all sqlite-v2 content

| aspect | SNOMED / LOINC / RxNorm / CPT files today | package and VSAC content (this design) |
|---|---|---|
| file | one release of one system | one package version (many systems + value sets), or VSAC (value sets) |
| identity | `provenance` (sources + sha256) | same, plus `fileUuid` (prototype: written); per-block `watermark` (= concept count when written) is design only — nothing in a value set refers to ids, so nothing needs it yet |
| code-system block | the whole file (`code_system` row 1, `id_base` 0) | one `code_system` row per CodeSystem, ids `id_base+1 … id_base+concept_count` |
| concept ids | dense DFS ids, local to the file | the same rule, per block (siblings in document order) |
| sets | `concept_set` bitmaps | the same table and kinds; kinds 1–3 keyed by block |
| value sets | — | `value_set`, `vs_include`, `vs_concept` (text) |
| provider | `SqliteV2Factory` + dialect | `StoredCodeSystem` + `StoredFhirProvider` (main's per-concept logic) + engine with the `fhir` dialect |
| value-set provider | — | `ContentValueSetProvider` (packages and VSAC) |
| library syntax | `sqlite-v2[!]:<file>` | `sqlite-v2:<file>`, `sqlite-v2:npm:<pkg>#<ver>[=prefix]`, `sqlite-v2:vsac[=prefix]` |
| supplements | in-memory layers over base ids | the same mechanism for every block |
| traces | `fhirsmith-expand-trace` spans | the same spans for engine work on blocks; value-set row reads are not yet traced (prototype gap) |
| caches | none of ours (owner rule) | none of ours; per-request objects only |

### What changes in the existing schema and importers

- `code_system` loses `CHECK (id = 1)` and gains `id_base` (default 0), `case_sensitive`,
  `hierarchy_meaning` and `resource` (the CodeSystem JSON without its concepts). Existing files
  read as `id_base = 0` with one row: **no rebuild, no importer change**.
- `property_def` gains `cs_id` (default 1). Existing files: all rows are block 1.
- Set kinds 1–3 (`all`, `active`, `leaf`) are keyed `value = cs_id` in multi-block files; the
  store reads `value = 0` when the file has one block (today's key). A one-line rule, no rebuild.
- The `active` set stops being assumed to be a range. In a FHIR block, inactive concepts can sit
  anywhere in document order; the engine already reads `active` as a stored set everywhere except
  `countAllCodes`, which now uses `card`.
- `V2Store` gets block bounds (`lo`, `hi`): code lookups and the few whole-file scans
  (`SELECT … FROM concept`, FTS) add `concept_id BETWEEN lo AND hi`. For one-block files this is
  the whole range and costs nothing measurable.
- New tables `concept_json` (a concept's own JSON, for round-trip and for main's per-concept
  logic) and the value-set tables. Files without them behave as today.

Worth it: yes. The changes to the existing path are a schema version bump with defaults and a
range predicate; SNOMED/LOINC/RxNorm importers and files are untouched.

## 3. CodeSystem resources → blocks

The importer reads the package with main's `PackageContentLoader` and builds main's `CodeSystem`
object for each resource, so normalisation (R4→R5, versioned canonicals, contained-resource and
narrative checks, nesting limits) is exactly main's. It then writes one block per CodeSystem:

| FHIR | stored as |
|---|---|
| `url`, `version`, `name`, `title`, `status`, `content`, `caseSensitive`, `hierarchyMeaning`, `supplements`, `valueSet`, `versionNeeded`, all other metadata | `code_system` columns + `resource` (the resource JSON minus `concept`) |
| `concept` (any nesting) | one `concept` row per concept, in document pre-order; `concept_json(concept_id, nest_parent, json)` keeps the concept's own JSON minus its children, so the resource round-trips exactly |
| nesting and `parent`/`child` properties | `concept_link` hierarchy rows (child → parent), exactly the edges main's `buildMaps()` derives (nested, `parent`, `child`, by code or by `http://hl7.org/fhir/concept-properties#parent/child` uri) |
| `hierarchyMeaning` (`is-a`, `grouped-by`, `part-of`, `classified-with`, absent) | stored; main treats them alike for `is-a`/`descendent-of`, and so does the `fhir` dialect |
| `property` definitions (code, uri, type, description) | `property_def` (`cs_id`, `fhir_type`; `value_kind = concept` for `code`-typed properties whose values are codes of the system, else `literal`) |
| concept property values | `concept_literal` (code/string/boolean/integer/decimal/dateTime), `concept_link` (code values that are concepts of the block); Coding values and anything else stay in `concept_json` |
| `designation` (language, use, value, extensions) | `designation` rows (language, use, term) for search; the full designation JSON stays in `concept_json` |
| status / deprecated / inactive / notSelectable | sets computed at import **with main's own logic**: the importer asks main's `FhirCodeSystemProvider` `isInactive`, `isAbstract`, `isDeprecated`, `getStatus` for each concept and stores `active`, `prop(notSelectable)`, `prop(status=v)`, `prop(deprecated)`, so the filters select exactly the concepts main would |
| declared `filter` entries | in `resource`; the dialect accepts what `cs-cs.js doesFilter` accepts (declared filters are documentation there too) |
| `content` = complete / fragment / example | stored and reported as main reports them (`contentMode()`); fragment/example keep main's `UNKNOWN_CODE_IN_FRAGMENT` behaviour because `validate.js` asks `contentMode()` |
| `content` = not-present | block with no concepts: metadata only, as main |
| `content` = supplement | stored for round trip, **served as a normal in-memory `CodeSystem`** (supplements must be resources for `loadSupplements`, layers and the display helpers); one whose base is a sqlite-v2 terminology file (the Uzbek LOINC one in `fhir.tx.support`) is then moved to its own file (`docs/sqlite-v2-engine.md`, "Server-known supplements on disk") |
| versions | each resource is its own block; two versions of one url are two blocks (in one file or two). Registration goes through main's `Provider.addCodeSystem`, so default-version, `url|version`, major.minor and THO precedence are main's |
| reserved code spaces, extension-codes | `resource` keeps the extensions; `CodeSystem.isInReservedCodeSpace` works on the metadata |

**Request-time (tx-resource) CodeSystems** keep main's path: `new CodeSystem(json)` +
`FhirCodeSystemProvider`. A future step is an in-memory v2 block (as supplements already are);
nothing in this design depends on it.

### StoredCodeSystem

`StoredCodeSystem extends CodeSystem` is built with `noMaps` from the block's `resource`. It
overrides the concept-tree methods main's provider calls, each answered from SQLite or the sets,
per call, with nothing retained:

| method | answer |
|---|---|
| `getConceptByCode(code)` | `concept` by code (NOCASE for case-insensitive systems, as `codeMapNC`), its `concept_json` parsed |
| `getChildren`, `getParents` | hierarchy `concept_link` rows, in document order |
| `getAncestors`, `isDescendantOf` | upward walk / `descendants(A).has(B)` |
| `getRootConcepts`, `getAllCodes`, `getAllConcepts`, `hasCode`, `conceptCount`, `hasHierarchy` | block scans / stored counts |
| `codeMap.get(code)` (used by `Provider.resolveCode`) | a tiny map-like object over the same lookup |
| `jsonObj.concept` | an enumerable accessor that rebuilds the nested concept tree from rows (read, search output, `$expand` cache keys of an included CodeSystem). Built on access, not kept |

`StoredFhirProvider extends FhirCodeSystemProvider` overrides only the set side: `filter`,
`executeFilters`, `filterSize/More/Concept/Locate/Check`, `iterator`, `iteratorAll`,
`subsumesTest`, `locateIsA`, `handlesSelecting`/`processSelection`, `searchFilter`.
`Provider.createCodeSystemProvider` picks it when the code system is a `StoredCodeSystem`.

## 4. ValueSet resources → rows

| table | content |
|---|---|
| `value_set` | `vs_id`, resource `id`, `url`, `version`, `name`, `title`, `status`, `publisher`, `date`, `description`, `effective_start/end`, `expansion_identifier`, `content_hash`, `last_seen`, `date_first_seen`, `json` (the resource with each stored concept list replaced by a placeholder) |
| `vs_identifier`, `vs_jurisdiction`, `vs_system` | as `ValueSetDatabase`, for search parity |
| `vs_include` | `vs_id`, `idx`, `exclude` (0/1), `system`, `version`, `concept_count`, `first_row` |
| `vs_concept` | rowid = position (contiguous per include), `vs_id`, `inc_idx`, `code`, `display`, `json` (only when the concept has more than code and display); index `(vs_id, inc_idx, code)` |

- The original JSON round-trips: placeholders are replaced by the rows in order.
- Filters and imported value sets stay in the include JSON (they are small).
- **Search** keeps `ValueSetDatabase._buildSearchQuery` semantics exactly (LIKE `%v%` on
  version/name/title/status/publisher/description/date, exact url, identifier/jurisdiction/system
  joins, `ORDER BY url`, `_elements` from columns).
- **Version selection.**
  - packages (`PackageValueSetProvider.fetchValueSet`): exact `url|version`; then
    `url|major.minor` (latest patch); bare url only when no version is asked for, latest by
    `isNewerVersion` (semver, then numeric, then lexical);
  - VSAC (`VSACValueSetProvider.fetchValueSet`): the same, but the bare url is also the fallback
    when the asked version is not found; include/exclude `version` stripped on read (as
    `_reloadMap`);
  - THO precedence: `applyTHOPrecedence` asks each provider for its THO url → versions map
    (`thoVersions()`), so a content-store THO package hides core-package value sets exactly as
    today; `keepPinnedOnly` is unchanged for the core packages.
- **Ids:** served in the provider's id space (`applyIdPrefix`), as today. A url that is really a
  raw id finds nothing (the on-demand VSAC prototype's documented change).
- **Rejected resources:** a row whose JSON fails `new ValueSet()` is skipped and the next
  candidate version is used, as the map loader does.

## 5. How the engine uses them

- **Fetch.** `ContentValueSetProvider.fetchValueSet` reads one `value_set` row and its
  `vs_include` rows and builds a new `ValueSet` for this request. Lists of up to 1,000 codes are
  read eagerly into plain arrays: nothing downstream sees a difference. (Measured: the threshold is 64,
  see 9.5 — a grouping value set fetches every child.) Larger lists stay rows:
  the include gets an enumerable `concept` accessor (rows read on first use, kept on this
  request's object only) and a non-enumerable handle with `count` and `lookup(code)`.
- **Membership (`$validate-code`).** `validate.js` asks the handle instead of scanning: one
  indexed `(vs_id, inc_idx, code)` read. The code is then located in its code system as before
  (one SQL read in a v2 file, a map lookup in main's providers). The ICD-11 "same concept,
  other form" check only runs when the code system says the code has another form, as now; for
  every other system the per-concept `locate` loop main runs on a miss is skipped because its
  first test can never pass (pure optimisation, same answer).
- **Expansion.** `expand.js` iterates the list as today; the accessor reads the rows once
  (`ORDER BY rowid`, one statement), and the existing `prefetchCodes` batching resolves them
  against v2 code-system files 1,000 at a time — the request-time join. Mixed value sets (a VSAC
  list of SNOMED + LOINC + RxNorm codes, a THO value set mixing THO systems and v2 systems)
  follow the same path, one provider per system.
- **Grouping value sets.** Imports are fetched per child (one row read each, no JSON of the big
  lists); membership in a 331-child grouping set is 331 indexed lookups.
- **Filters on package code systems** (`is-a` on ICD-10-CM, property filters on THO) compile to
  the same IR as SNOMED/LOINC filters and evaluate on the block's sets.
- **Per-request only.** Nothing is retained between requests: no value-set map, no parsed JSON,
  no stored-set cache. Upstream's caches (expansion cache, resource caches, cache-id sessions)
  are untouched. Package value sets lose the `isCached` filter memo of `cs-cs.js` (an upstream
  cross-request memo keyed on the loaded object); engine-backed filters do not need it.

### Behaviour parity points

| point | main | content store |
|---|---|---|
| version choice, ids, search, THO precedence | as described | identical rules, same SQL |
| raw VSAC id used as a url | found (map keyed by id) | not found (id-space rule; also on-demand prototype) |
| sync visibility | at the end of a sync | per value set, as each transaction commits |
| debug notes for big lists | every code listed in the note | `(N codes)` for stored lists (diagnostics text only) |
| order of expansions | include order, then main's per-provider order | include order; FHIR blocks in DFS/document order (D3) |
| filter memo on package value sets | `isCached` memo | none (engine) |

## 6. Refresh and sync

- **VSAC.** The sync writes into the content file: per value set, one transaction replaces its
  `value_set`, `vs_include` and `vs_concept` rows (delete + insert; rowids stay contiguous per
  include). The file is in WAL mode, so readers always see either the old or the new value set,
  never a mixture, and are never blocked. No in-memory map means no second copy during a sync
  (main: +1.0 GB heap). Run/event/settings tables (`vsac_runs`, `vsac_events`, `vsac_settings`)
  move into the same file unchanged. A periodic `wal_checkpoint(TRUNCATE)` after a run bounds the
  WAL.
- **Packages.** A package version is immutable: a new version is a new file, built on first
  load (as main builds `.valuesets-2.db` today) or ahead of time with the importer. The file
  records the package id, version and the sha256 of `package.tgz`/`.index.json`; a mismatch
  means rebuild.
- **Code-system releases.** Nothing to do: value sets hold codes as text.

### 6.1 With a master and tx-workers (cluster.md)

The content files follow the same rule as main's package caches under `--role`: the master
builds and writes them; a tx-worker only reads them.

- **Package files** (`terminology-cache/v2/<package>.db`). The master builds a missing or stale
  file as a single process does: into `<file>.building`, renamed into place when complete. A
  tx-worker never builds one. It waits (`waitForCache`, the same wait and timeout as the package
  caches) until the file is there and its recorded package hashes and format match, then opens it
  read-only.
- **VSAC** (`terminology-cache/vsac/vsac-v2.db`). Only the master (`vsacCfg.cluster` =
  `leader`, set by `--role`) creates, converts (from `vsac-valuesets.db`) and syncs the file. After
  each sync, a failed one included, and after a single-url resync, it moves the file's generation
  (`vsac_settings`). A tx-worker (`follower`) opens the file read-only, and every write method
  throws. On a request that uses VSAC, at most once a second, a worker compares the generation with
  the one it last saw (`VSACValueSetProvider.catchUp`, as for main's VSAC database). When the
  generation has moved, the worker refreshes its count. It does not reopen the reader: in WAL mode,
  each read already sees the last committed sync. Until the master has made the file, a worker's
  VSAC provider answers as if it had no value sets.
- **SNOMED CT, LOINC and RxNorm** (`sqlite-v2:` sources). These are always opened read-only, by
  every process.

## 7. Effort, risks, upstream

| piece | effort | risk |
|---|---|---|
| schema bump + block bounds in `V2Store` | small | low (one-block files unchanged) |
| value-set tables, importer (package + VSAC), `ContentValueSetProvider`, search port | medium | low: rules are copied, parity is testable by replay |
| `validate.js` / `renderer` / `usage-tracker` hooks for stored lists | small (≈40 lines) | medium: every site that reads `include.concept` still works through the accessor; only the hot sites change |
| VSAC sync writing to the content file | medium | medium: run bookkeeping moves |
| `StoredCodeSystem` + `StoredFhirProvider` + `fhir` dialect | large | medium–high: `cs-cs.js` has many small rules; mitigated by delegating per-concept logic to main's class |
| library syntax + switch | small | low |

Upstream (FHIRsmith) candidates, independent of the engine:
- value sets as rows with lazy big lists and the indexed membership hook (helps main's VSAC and
  PHIN VADS memory on its own; uses `better-sqlite3`/`sqlite3` as main already does);
- `thoVersions()` on value-set providers (a cleanup of `applyTHOPrecedence`'s `instanceof`);
- the "same concept, other form" hoist in `checkConceptSet` (main pays one `locate` per listed
  code on every miss today).
Stays in our PR: blocks, `StoredCodeSystem`, the `fhir` dialect and the shared file format.

## 8. Prototype scope

- importer `tx/importers/import-content-v2.js`: `package <folder> <out.db>` and `vsac <ValueSetDatabase> <out.db>`;
- runtime `tx/sqlite-v2/content/`: `content-file.js`, `stored-codesystem.js`,
  `stored-cs-provider.js`, `fhir-dialect.js`, `content-vs-provider.js`;
- switch: `modules.tx.sqliteV2Content: true` routes `npm:` (non-core) and `internal:vsac`
  sources to content files (built on first load into `terminology-cache/v2/`); explicit
  `sqlite-v2:npm:…` / `sqlite-v2:vsac` syntax always does.

## 9. Results (prototype, 2026-11-02)

Setup: the demo library (`tx/sqlite-v2/demo.yml` sources: v2 SNOMED CT Intl + US, LOINC 2.83 + 2.82,
RxNorm, CPT, the 8 npm packages, ICD-11) plus VSAC (snapshot of 40,267 value sets). "main" = branch
`sqlite-v2-provider` (8b33d12) unchanged; "content" = this branch with
`modules.tx.sqliteV2.content = { valueSets: true, codeSystems: true }`. Each server ran in its own
6 GB scope at `nice 19`; timings and memory were taken under the shared measurement lock, one server
at a time, load average 1–3 on a 12-core machine. Tools: `~/hobby/.agent-scratch/content-store/tools/`.

### 9.1 Answers: identical

| check | scope | result |
|---|---|---|
| HL7 tx-ecosystem suite (`tests/tx/test-cases.test.js`, all 9 modes, R4 + R5 + forced caching) | 4,565 tests | main 4,565 pass; content value sets only 4,565 pass; content value sets + code systems 4,565 pass (after the ICF fix below) |
| IG-corpus replay, every distinct R4/R5 call whose request or referenced resources name a value set or code system served from these packages or VSAC | 48,002 calls (6,022 CodeSystem/$validate-code, 21,005 ValueSet/$validate-code, 16,188 $expand with paged results completed, 158 $batch-validate-code, 2,327 reads, 2,265 searches) | **48,002 identical** to main after removing timestamps, ids of Bundles/Parameters/OperationOutcomes, diagnostics and ports; list order included |
| the same replay with code systems still on main's path | 7,931 value-set calls | 7,931 identical |
| provider level, value sets (`tools/vseq.js`) | every url, url\|version, url\|major.minor, url\|absent version, id and raw id of THO, PHIN VADS, fhir.tx.support, DICOM and VSAC (193,508 VSAC fetches), plus 9,773 VSAC / 2,979 THO searches with and without `_elements`, and the usage scan | identical except one documented case per source (below) |
| provider level, code systems (`tools/cs-parity.js`) | every concept of THO, r4.core, r5.core, DICOM, us.core, SDC, IHE; up to 3,000 per code system in fhir.tx.support; locate (case variants), displays (en, fr), designations, properties, extensions, abstract/inactive/deprecated/status, parents/children/ancestors, subsumes, iteration order, every filter shape (result and order; 45,801 filter checks for THO alone), resource round trip | 0 differences left (2 found and fixed, below) |
| VSAC sync (`tools/synctest.js`, mock VSAC: 300 recent urls, 10 changed) | final state of all 40,267 rows | same content hashes, titles and events as main's sync |

**Every difference found, and what happened to it:**

| # | difference | status |
|---|---|---|
| 1 | A raw value-set id used as a url (`ValueSet?url=POAIndicators`, `fetchValueSet('2.16.840.1.114222.4.11.4220')`) finds nothing; main finds it because its map is keyed by id and url together | kept: the id-space rules (`resource-ids.js`) say a raw id is not a url; same decision as the on-demand VSAC prototype. Not seen in the 48,002 replayed calls |
| 2 | Search on a parameter main does not index (default branch: `LIKE` over the whole JSON) now matches the skeleton JSON or any listed code / display / concept JSON | equivalent for the tested `code=` searches; a pattern that spans JSON syntax around a listed code (e.g. `"code":"123"`) would no longer match |
| 3 | Debug notes for lists over 64 codes say `(N codes)` instead of listing every code | diagnostics text only (main builds a string of all 57,017 codes on every check) |
| 4 | Sync changes become visible per value set as each transaction commits, not at the end of the sync | intended (WAL); a second process read 71,960 times during a sync: 0 partial or broken value sets |
| 5 | The `isCached` filter memo of `cs-cs.js` does not survive between requests for package value sets | intended (no cross-request caches); engine-backed filters don't need it |
| 6 | ICF (`http://hl7.org/fhir/sid/icf`) as a stored block failed `icf-vs-noloc-plain` / `icf-vs-noqual-plain` (×6 with R4/R5/cached): `IcfCodeSystemProvider` compares concept objects by identity | **fixed**: code systems with a specialised provider class load as in-memory resources from the file |
| 7 | Property `not-in` selected concepts with no `property` array (main skips them) | **fixed** (CS parity harness) |
| 8 | Case-insensitive lookup missed codes with non-ASCII letters (`lower()` folds ASCII only; r4.core v2-0550 `"CHESTÂ "`) | **fixed** |
| 9 | Whole-compose evaluation (`processSelection`) for FHIR blocks would flatten hierarchical expansions that main nests | kept off (`fhirProcessSelection: false`); expand.js drives the filters, the engine evaluates each one |
| 10 | A `status` filter whose answer depends on `deprecationDate` is fixed at import time | open: per-concept status is still computed per request; only the filter set can drift as dates pass |

Main itself: with Node's default heap limit, main's server **died (JavaScript heap out of memory) at
about call 17,000 of the replay**; the content server ran the whole replay with the default heap. The
comparison above used main with `--max-old-space-size=4096`.

### 9.2 Memory per process (after start-up and a forced GC; anonymous resident memory = what the process owns)

| server | heap | anonymous RSS | after the 48,002-call replay (anon / heap) |
|---|---:|---:|---:|
| main | 1,268–1,271 MiB | 1,863–2,198 MiB | 4,184 / 2,094 MiB |
| content, value sets only | 507 MiB | 763 MiB | — |
| content, value sets + code systems | **280 MiB** | **626 MiB** | 2,181 / 1,113 MiB |

So **about −1.0 GB heap and −1.2 to −1.6 GB per process**, in line with the measured parts (VSAC
map ~0.6–1.0 GB, package value sets 230 MB, package code systems 270 MB). File-backed memory grows by
~0.4 GB (page cache of the content files, shared between processes and reclaimable).
Start-up: main 13.4 s, content 7.5–7.9 s (content files already built; the first start builds them:
+21 s, fhir.tx.support 13 s of it).

VSAC sync against the mock: main 11.4 s and **+544 MiB heap**; content 3.0 s and +28 MiB.

### 9.3 Import time and file sizes

| source | content file | time | peak RSS | main's equivalent |
|---|---:|---:|---:|---|
| VSAC (40,267 value sets, 3.4 M codes) | 518 MiB | 9.3 s | 0.55 GiB | `vsac-valuesets.db` 468 MiB |
| PHIN VADS (1,967 value sets, 1.49 M codes) | 131 MiB | 3.8 s | 0.49 GiB | `.valuesets-2.db` 124 MiB |
| hl7.terminology (935 CS, 2,540 VS) | 44 MiB | 2.6 s | 0.3 GiB | 15 MiB value-set db + JSON in heap |
| fhir.tx.support (36 CS, 342,810 concepts) | 259 MiB | 13.4 s | 0.9 GiB | 5 MiB + 224 MiB heap |
| r4.core / r5.core / DICOM | 21 / 10 / 9 MiB | 1.3 / 0.9 / 0.7 s | | |
| us.core, SDC, IHE, IPS | < 0.5 MiB each | ~0.2 s | | |

Code-system files are ~3× the package JSON. In fhir.tx.support the two largest parts are each
concept's own JSON (87 MiB) and the text-search index (87 MiB); both can be slimmed (store only the
parts not already in rows; build the FTS index only for large blocks).

### 9.4 Latency of representative calls (server round trip, ms: first call / median of 10 repeats)

Repeats of an `$expand` that took over 250 ms come from upstream's expansion cache in both servers,
so for expansions read the first-call number. All 70 responses identical between the servers.

| call | main | content |
|---|---:|---:|
| VSAC Medical Cohort (57,017 ICD-10-CM), $validate-code, code in list | 16 / 13.8 | **2 / 1.1** |
| … code not in list | 88 / 44.2 | **1 / 1.2** |
| VSAC Medication Brand Name (33,341 RxNorm), code not in list | 295 / 218 | **1 / 1.1** |
| VSAC Common LOINC Lab Codes (18,566), code not in list | 131 / 125 | **1 / 1.1** |
| VSAC 9,497-code SNOMED list, code in list | 6 / 2.2 | 2 / 1.1 |
| PHIN VADS Problem (122,476 SNOMED), code in list | 4 / 3.8 | 3 / 2.7 |
| VSAC Medical Cohort, $expand count=10 | 136 / 88 | 157 / 131 |
| … offset=500 | 86 / 85 | 125 / 125 |
| VSAC Medication Brand Name, $expand count=10 | 160 / 86 | 139 / 100 |
| VSAC Common LOINC Lab Codes, $expand count=10 | 403 | 335 |
| `ValueSet?url=` Medical Cohort (full 57,017-code resource) | 124 / 65 | 142 / 104 |
| `ValueSet?url=` with `_elements` | 1–4 | 1 |
| VSAC grouping, 331 children (COVID-19), $validate-code | 22 / 21 | 56 / 57 |
| VSAC grouping, 51 children / 8 systems (Acumen), $validate-code in / not in | 17 / 13, 32 / 27 | 26 / 25, 46 / 48 |
| VSAC grouping, 57 children / 7 systems (C2S), $validate-code in / not in | 5 / 4, 6 / 6 | 11 / 10, 16 / 17 |
| VSAC grouping Acumen, $expand count=10 | 504 | 471 |
| VSAC ASCVD (ICD-10-CM `is-a` filters), $expand count=10 | 10 / 4.5 | 46 / 40 |
| VSAC small (Diabetes), $validate-code / $expand | 2 / 1.0, 30 / 19 | 2 / 1.5, 29 / 22 |
| THO gender-identity (SNOMED + THO), $validate-code / $expand | 1 / 0.8, 1 / 0.9 | 2 / 1.3, 2 / 1.6 |
| THO v3-KnowledgeSubjectObservationValue (7 systems incl. SNOMED, LOINC, RxNorm, ICD), $expand | 103 / 97 | 110 / 95 |
| THO CodeSystem/$validate-code v3-ActCode AMB; $lookup | 0.6; 0.5 | 0.8; 0.7 |
| ICD-10-CM $lookup E11.9; CodeSystem/$validate-code | 0.4; 0.5 | 0.7; 0.8 |

Provider-level (fork measurements, `tools/cs-measure.js`): ICD-10-CM `is-a` Chapter 19 (54,285 codes),
"is S72.001A a member": main 28.6 ms, content **0.08 ms**; iterating `is-a E11` (117 codes): 0.11 → 0.43 ms;
single lookups +0.02–0.1 ms.

Whole replay, 48,002 calls one server at a time (3 concurrent clients): total server round-trip
time **1,441 s main → 1,559 s content (+8%)**; median per call 6.3 → 7.0 ms, 9 in 10 under 47 → 51 ms.
By operation: $validate-code +5%, $expand +4–8%, reads +1 ms, ValueSet searches −15%.

**Where it is slower, and why:**
- **Grouping value sets** (2–3×, +10 to +35 ms): every child is a row read, a JSON parse and a
  `new ValueSet()` per request (0.05–0.08 ms each), twice per validate (prepare + check). Main has
  them pre-parsed. Follow-up: answer "which children list this code" with one SQL statement across
  the children before building any of them.
- **Expanding a whole big list** (+20–45%): 57,017 rows read and turned into objects per request where
  main holds the objects. Inherent to "nothing kept between requests"; paging does not help because
  expand.js builds the whole list.
- **ICD-10-CM `is-a` filter expansion** (ASCVD: 4.5 → 40 ms): the engine path for FHIR blocks reads
  each member's concept JSON one by one while iterating. Follow-up: batch per page, as the SNOMED/LOINC
  provider does.
- **Small calls** +0.2–0.5 ms (SQLite reads instead of map lookups).

### 9.5 Prototype choices made from measurements

- Enumerated lists stay in rows above **64 codes** (not 1,000): eager reads of mid-size lists were
  ~30% of a grouping's child fetch.
- `prefetchCodes` for stored code systems: expand.js's 1,000-code runs resolve in two statements
  (Medical Cohort `offset=500` 228 → 125 ms).
- Package files are written in rollback-journal mode (immutable); only VSAC uses WAL.

### 9.6 What this means for the recommendation

The value-set half delivers what section 1 claims with no answer changes: ~1 GB less per process, a
sync that no longer needs a second copy, `$validate-code` against big lists 10–200× faster. The
code-system half also holds parity on every check, and removes another ~250 MB, but costs a little
on every small call and needs the two follow-ups above (grouping membership in one statement,
batched filter iteration) before it is a clear win on latency. Both are local to the content
provider; neither needs new caches.

## 10. Round 2 (2026-11-02): value-set half finished, code-system speed fixes, three configurations

### 10.1 What changed since section 9

- **Value-set half:** jest suite `tests/tx/sqlite-v2-content-vs.test.js` (versions, ids, search order,
  stored lists, request batches, usage scan, VSAC writer); `tests/vs` + `tests/tx` unit suites pass
  (1,216 tests).
- **Grouping value sets:** `Provider.findValueSet` passes the request's `OperationContext` to
  `fetchValueSet`. When a content-store value set imports others, its children are read in five
  batched statements (candidate rows, resources, includes, the codes of short lists), kept in a
  `WeakMap` keyed by that request object, so nothing outlives the request. Package files answer
  "not here" from the set of their urls (immutable data read at load), so a VSAC child no longer
  costs one statement per package provider. Skipping children that cannot contain the code was
  considered and rejected: each child's preparation looks up its code systems and can add warnings
  or errors, so building every child is part of the answer.
- **Package code systems:**
  - iteration (`iterator`/`iteratorAll`/`nextContext`) reads concepts 500 at a time, in main's order,
    with no statement for a concept without children;
  - filter iteration reads the chunk's first parents in one statement (`parent()` was 3 statements per
    concept);
  - expand.js's enumerated runs resolve in two statements (`prefetchCodes`).
- **validate.js, both configurations:** main runs `sameConceptDifferentForm` (one `locate` of the
  requested code) for *every* listed concept when the code is not in the list. That can only succeed
  when the code has another form (ICD-11), so it is now asked once per include. Same answers.

### 10.2 Method

One machine (12 cores, 62 GB), one server at a time under the shared measurement lock, each server
started fresh with `--max-old-space-size=4096` (main needs it, see 10.6), load average 1–3.
Same calls for every configuration:
- **main** = branch `sqlite-v2-provider` unchanged;
- **value sets only** = this branch, `content: { valueSets: true }`;
- **value sets + code systems** = this branch, `content: { valueSets: true, codeSystems: true }`.

The whole IG replay (48,002 calls) ran with one client at a time. A call counts as "slower" only if it
was more than 2× **and** more than 10 ms slower than main in the full replay **and** again in two
isolated re-runs of the flagged calls (main re-run alongside), so one-off pauses don't count.

### 10.3 Answers

| check | value sets only | value sets + code systems |
|---|---|---|
| IG replay, 48,002 calls, compared with main | **48,002 identical** | **48,002 identical** |
| HL7 tx-ecosystem suite, 4,565 tests | all pass | all pass |
| 73 representative calls (10.5) | identical | identical |
| code-system parity harness (THO, fhir.tx.support, incl. iteration order flat and as a tree) | — | 0 differences |

### 10.4 Whole IG replay, per call type (ms; one client at a time)

Value sets only vs main:

| operation | calls | typical (median) main → new | worst main → new | total s | >2× and >10 ms slower (confirmed) |
|---|---:|---|---|---|---:|
| CodeSystem/$validate-code | 6,022 | 0.8 → 0.7 | 363 → 76 | 8 → 7 | 0 |
| CodeSystem?search | 108 | 2.5 → 2.5 | 654 → 508 | 2 → 2 | 0 |
| ValueSet/$batch-validate-code | 158 | 2.5 → 2.1 | 366 → 384 | 8 → 7 | 0 |
| ValueSet/$expand | 16,188 | 2.0 → 2.0 | 845 → 725 | 306 → 289 | 0 |
| ValueSet/$validate-code | 21,005 | 1.9 → 1.8 | 305 → 109 | 64 → 57 | 0 |
| ValueSet/read | 2,327 | 0.4 → 0.4 | 23 → 33 | 1 → 1 | 0 |
| ValueSet?search | 2,157 | 2.1 → 1.3 | 67 → 95 | 5 → 3 | 0 |
| **all** | **48,002** | **1.6 → 1.4** | **845 → 725** | **394 → 367** | **0** (286 were >2× and >10 ms *faster* in the full replay) |

Value sets + code systems vs main:

| operation | calls | typical main → new | worst main → new | total s | >2× and >10 ms slower (confirmed) |
|---|---:|---|---|---|---:|
| CodeSystem/$validate-code | 6,022 | 0.8 → 0.9 | 363 → 71 | 8 → 9 | 0 |
| CodeSystem?search | 108 | 2.5 → 2.6 | 654 → 864 | 2 → 3 | 2 |
| ValueSet/$batch-validate-code | 158 | 2.5 → 3.4 | 366 → 518 | 8 → 11 | 1 |
| ValueSet/$expand | 16,188 | 2.0 → 2.1 | 845 → 664 | 306 → 290 | 6 |
| ValueSet/$validate-code | 21,005 | 1.9 → 2.2 | 305 → 187 | 64 → 63 | 0 |
| ValueSet/read | 2,327 | 0.4 → 0.4 | 23 → 21 | 1 → 1 | 0 |
| ValueSet?search | 2,157 | 2.1 → 1.1 | 67 → 87 | 5 → 3 | 0 |
| **all** | **48,002** | **1.6 → 1.7** | **845 → 864** | **394 → 380** | **9** (352 faster) |

The 9 calls (all three rounds main → new): a whole ISO 3166-2 / provider-taxonomy style expansion
28 → 59–68 ms (×2), three small expansions of stored code systems 3–7 → 18–21 ms, a 1,000-code page of a
stored code system 31–94 → 65–114 ms, a `$batch-validate-code` 70–81 → 148–153 ms, and two
`CodeSystem?url=` searches returning a whole stored code system 13–36 → 46–64 ms (the resource is rebuilt
from rows). Before the round-2 fixes this list had 148 calls, 126 of them expansions of whole stored code
systems at ~200 ms.

### 10.5 The calls asked about (ms: first call / median of 10)

| call | main | value sets only | value sets + code systems |
|---|---:|---:|---:|
| VSAC grouping, 331 children (COVID-19), $validate-code in / not in | 22 / 19, 19 / 19 | 33 / 28, 35 / 27 | 40 / 34, 32 / 34 |
| VSAC grouping, 51 children, 8 systems (Acumen), in / not in | 15 / 14, 28 / 28 | 16 / 15, 35 / 27 | 21 / 19, 35 / 34 |
| VSAC grouping, 57 children, 7 systems (C2S), in / not in | 7 / 4, 6 / 6 | 6 / 6, 7 / 7 | 8 / 7, 9 / 9 |
| ICD-10-CM `is-a` filters (VSAC ASCVD), $expand | 13 / 9 | 11 / 8.5 | 16 / 12 |
| ICD-10-CM `is-a E11` inline, $expand all 117 | 5 / 2.2 | 5 / 2.4 | 5 / 2.9 |
| ICD-10-CM `is-a Chapter-4`, $expand count=1000 | 19 / 17 | 22 / 18 | 21 / 20 |
| ICD-10-CM `is-a Chapter-19` (54,285 codes), $expand count=10 | 58 / 56 | 57 / 56 | 45 / 45 |
| ICD-10-CM: is S72.001A in `is-a Chapter-19` ($validate-code) | 31 / 30 | 31 / 31 | **2 / 0.9** |
| Medical Cohort (57,017 ICD-10-CM), code in list / not in list | 21 / 11, 81 / 32 | 9 / 1.2, 1 / 1.1 | 10 / 1.4, 2 / 1.5 |
| Medication Brand Name (33,341 RxNorm), code in / not in | 7 / 6, 289 / 215 | 2 / 1.0, 1 / 0.9 | 2 / 1.0, 1 / 1.0 |
| Common LOINC Lab Codes (18,566), code not in list | 114 / 122 | 1 / 1.0 | 1 / 1.0 |
| PHIN VADS Problem (122,476 SNOMED), code in / not in | 5 / 4, 4 / 4 | 3 / 1.2, 1 / 1.2 | 3 / 1.3, 1 / 1.2 |
| Medical Cohort, $expand count=10 (first call) | 133 | 141 | 151 |
| Medication Brand Name, $expand count=10 (first call) | 110 | 119 | 120 |

The grouping set is still slower than main: each child is read and parsed per request, and its
preparation looks up its code systems. In main that lookup also scans every loaded code system for
supplements (`Provider.loadSupplements`, ~5 ms per grouping request; see 10.7).

### 10.6 Memory per process (after a forced GC)

| | main | value sets only | value sets + code systems |
|---|---:|---:|---:|
| heap after start-up | 1,271 MiB | 508 MiB | **281 MiB** |
| anonymous RSS after start-up | 2,165 MiB | 801 MiB | **606 MiB** |
| heap / anonymous RSS after the 48,002-call replay | 2,609 / 4,251 MiB | 1,855 / 3,419 MiB | 1,617 / 3,280 MiB |
| start-up time (content files already built) | 11.2 s | 10.7 s | 9.7 s |

After the replay most of every heap is upstream's expansion cache (10.7, K6), which this work does not
change.

**Main running out of default heap — the request pattern.** With Node's default heap (~2 GB) and the
replay at 3 concurrent clients, main died at about call 16,400 in two of two runs; this branch with value
sets + code systems finished all 48,002 with the default heap (heap peak 1,782 MiB). Memory samples every
2 s show the cause: main starts at 1.27 GB (VSAC map + package resources), and upstream's expansion cache
then grows by ~0.8 MB per entry: 25 entries → 1.53 GB, 589 entries → 2.0 GB → crash after 7.4 minutes.
Entries come from `$expand` requests that take over 250 ms (here 265 such client requests plus their
nested value-set expansions; most are 1,000-code pages of large expansions, e.g. whole SNOMED CT
`include` with `count=1000`). See K6 for why the memory threshold setting did not prevent it.

### 10.7 Latent bugs found (K = this report; the IG report already uses B1–B7) (main = `sqlite-v2-provider`; tx-dev = https://tx-dev.fhir.org, 2026-11-02)

| # | bug | request that reproduces it | main | tx-dev |
|---|---|---|---|---|
| K1 | A value-set "not in list" check calls `locate` once per listed code (validate.js `sameConceptDifferentForm` loop) | `GET /r4/ValueSet/$validate-code?url=http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.88.12.80.16&system=http://www.nlm.nih.gov/research/umls/rxnorm&code=999999999` (33,341-code VSAC list) | 215 ms (v2 RxNorm: cheap locates); in-list 6 ms | **no answer in 600 s**; a 219-code RxNorm list takes 18 s and a 1,185-code list 99 s then 422 (≈80 ms per listed code); in-list 0.16 s. Fixed here (asked once per include) |
| K2 | `$expand` of a value set listing codes of a `content: not-present` code system answers **500** | `POST /r4/ValueSet/$expand` with `compose.include = [{system: http://terminology.hl7.org/CodeSystem/time-period-ranges, concept: [{code: P10Y--P15Y}]}]` | 500 "has no content, so this expansion cannot be performed" | same 500 |
| K3 | SNOMED `concept in <unknown concept>` answers **500** | `POST $expand` with include `{system: http://snomed.info/sct, filter: [{property: concept, op: in, value: 41000147108}]}` | 500 "The SNOMED CT Concept 41000147108 is not known" | same 500 |
| K4 | `$validate-code` with `inferSystem` answers **500** when an include's code system is unknown | `POST $validate-code`, `code=WI`, `inferSystem=true`, value set includes `[{valueSet:[http://terminology.hl7.org/ValueSet/USPS-State]}, {system: http://example.org/no-such-code-system}]` | 500 "Exception expanding value set in order to infer system: A definition for CodeSystem … could not be found" | same 500 |
| K5 | `$validate-code` with `inferSystem` answers **500** when the value set is large | `POST $validate-code`, `code=%`, `inferSystem=true`, includes `[{system: urn:iso:std:iso:11073:10101}, {valueSet:[http://hl7.org/fhir/ValueSet/ucum-units]}]` | 500 "… expansion has too many codes to produce (>10000)" | same 500 |
| K6 | The expansion cache's memory threshold is only checked every 5 minutes, against the whole heap, and evicts in every endpoint's cache | replay above with `expansionCacheMemoryThreshold: 1700`: one eviction at 5 min (345 → 212 entries), refilled, crashed at 9.6 min with 637 entries | heap out of memory | (config not observable) |
| K7 | A VSAC value set asked for at a version it does not have is silently answered from the latest version; a package value set at an unknown version is "not found" | `GET $validate-code?url=http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.103.12.1001&valueSetVersion=19990101&system=http://snomed.info/sct&code=44054006` | result=true (latest version used) | result=true; the THO equivalent with `valueSetVersion=0.0.1` → "could not be found" on both |
| K8 | `ValueSet?version=` matches by substring (`LIKE %v%`); FHIR `version` is a token (exact) | `GET /r4/ValueSet?url=http://terminology.hl7.org/ValueSet/v3-ActEncounterCode&version=0` | returns version 3.0.0 | returns version 3.0.0 |

K1, K2–K5 (500 → 4xx) and K6 are candidates for upstream fixes with tx-ecosystem tests; K7 and K8 are
behaviour questions for the owner/Grahame. The content store keeps K7 and K8 exactly as main (parity),
and fixes K1 in the shared validate.js code.

Bugs of ours found and fixed during this round: ICF as a stored block (identity comparison in
`IcfCodeSystemProvider`, 6 tx-ecosystem failures), whole-system iteration of stored code systems
(~200 ms per ISO 3166-2 expansion, 126 slower replay calls), per-concept parent lookups during filter
iteration (ICD-10-CM `is-a` expansions 4× slower).
