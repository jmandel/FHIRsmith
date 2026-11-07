# sqlite-v2 query engine and provider

Code: `tx/sqlite-v2/`. The file format is in `docs/sqlite-v2-schema.md` and the trace format in
`docs/sqlite-v2-trace.md`.

**Rule.** SQLite stores facts. Bitmaps answer membership. Every question of the form "which
concepts" or "is X in" is set algebra over the `concept_set` bitmaps. SQL reads:

- the rows of a result page;
- designations and properties;
- full-text candidates;
- relationship facts, for the few operators that have no stored set.

## Layout

| file | role |
|---|---|
| `store.js` | One open file: prepared statements, batched set loads, batched row reads. The only code that runs SQL |
| `engine/compile.js` | Compose includes, filters and ECL → IR. A per-system dialect adds that system's filters and error messages |
| `engine/evaluate.js` | IR → bitmap: materialise, probe, lazy scan |
| `engine/engine.js` | Selection → ordered result (segments) → pages |
| `dialects.js` | LOINC, RxNorm and SNOMED filter rules, as `cs-loinc.js`, `cs-rxnorm.js` and `cs-snomed.js` accept them |
| `provider.js` | Generic `CodeSystemProvider` and factory |
| `snomed.js` | SNOMED: editions, displays and designations, `$lookup`, ECL errors, `?fhir_vs`, `?fhir_cm` |
| `layers.js` | Supplements as layers |
| `supplement-files.js` | Server-known supplements on disk: their files, and `DiskSupplement` |
| `trace.js` | Traces and the ring buffer |
| `index.js` | Entry point for the `sqlite-v2:` library source |

## IR and set kinds

Leaves are either free or costly.

**Free leaves** cost one batched read and give an exact size:

- `all`, `active`, `inactive`, `leaf`;
- `ids` (explicit codes);
- `set`, a stored set: `descendants(x)`, `prop(p, v)`, `hasProp(p)`, `refset(r)`.

**Costly leaves** read facts:

| leaf | what it reads |
|---|---|
| `anc` / `parents` | upward walk over `concept_link` |
| `propOf` | targets of P from a set: reverse attributes, dotted ECL, inverse properties |
| `text` | regex on code or display (upstream's RE2, found anywhere in the value) |
| `litMatch` | regex on literal keys, read as keys of `concept_set` |
| `search` | full text |
| `descFilter` | ECL `{{ D }}`: candidates from FTS, then checked on their designations |
| `group` | ECL role groups: sets first, then `group_id` checked on the survivors; group cardinality counts matching groups |
| `attrCard` | ECL attribute cardinality `[m..n]`: distinct (group, value) occurrences counted on the candidates, as upstream counts them |
| `history` | ECL `{{ + HISTORY }}`: association refset rows, indexed once per file |

The combinators are `and`, `or`, `minus`, `self` (`∪ {id}`), `hier` (a hierarchy operator over a
set), `propIn` (concepts with P → a member of a set) and `refsetOf`.

Some leaves become stored sets at compile time:

- **Literal filters.** `= / in` and ECL concrete values become the stored sets of the matching
  keys.
- **Concept-valued `propIn`** becomes one batched load of all `prop(p, v)` sets.

## Planner

1. **Prefetch.** Before evaluation, every stored-set leaf of the plan is loaded with one
   statement per (kind, property), whatever the number of keys. Real traces showed 80 single-set
   reads taking 0.8 ms of a 1.7 ms request; one statement now covers them.
2. **Intersection is selective-first.** Free inputs are intersected smallest first. Each costly
   input then narrows the candidates:
   - when there are at most 20,000 candidates (`PROBE_MAX`), it probes them: one batched fact
     read;
   - otherwise it materialises the input and intersects.
3. **Membership** (`$validate-code`, `filterLocate` / `filterCheck` without iteration) probes a
   single-member candidate set. It never materialises a costly input.

## Paging

**Eager by default.** The ids are computed in full:

- the total is exact;
- any offset costs a position lookup (`rangeUint32Array`);

**Lazy first page.** A request goes lazy when all of these hold:

- it is paged with `count` > 0 (`count = 0` asks for the total, so it is evaluated whole);
- the plan is a single filter part of the form free driver ∧ costly filters (`text` without
  required literals, `litMatch`, `descFilter`);
- the driver has at least 50,000 members.

The engine then scans the driver in id order, in chunks of 4,096, until it has offset + count
members. The total is omitted, as main does when it stops early.

**Display regex.**
- **SNOMED CT** follows the tx-ecosystem requirement (fhir-tx-ecosystem-ig adc5616; tests
  `snomed-expand-display-regex`, `-nl` and `snomed-validate-display-regex`):
  - A concept matches when one of its active FSNs or synonyms matches. Text definitions and
    inactive descriptions don't count.
  - Only one language is searched: the first one the request names (`displayLanguage`, else
    `Accept-Language`) that the file has descriptions in, else the file's default language.
  - The pattern must match the **whole term** (RE2, case-sensitive).
  - Literal candidates come from the trigram index on designations (`search_designation`). A
    lazy chunk or an `is-a` reads its own concepts' descriptions instead.
  - The worker passes the request's languages to the provider through
    `cs-api useRequestLanguages()`.
- **Other systems** test `concept.display`, the preferred display (one per concept).
- **Every regex filter matches the whole value** (D2): code, display, designation, property and
  relationship-target regexes. The test is `^(?:P)$` in RE2, and `.*X.*` is tested as find(X).
- `regex-literals.js` extracts the literal substrings every match must contain, for example
  `umo` for `.*[Tt]umou?r.*`, or `Fracture of` and `femur` for `^Fracture of.*femur.*`. When there
  is one of 3 characters or more, the FTS5 trigram index on displays (`search_display`, already in
  every file) gives the candidates in one statement, and RE2 runs only on them. Such a filter is
  evaluated whole: exact total, any page.
- A pattern with no such literal (`.*e.*`) is scanned. A leading or trailing `.*` is dropped
  first, which does not change a find-anywhere result.
- Measurements are in `docs/sqlite-v2-regex.md`.

**Rows are only fetched for the page,** with one statement per table:

- `concept`;
- `designation` with its acceptability, but only when the response can use it: with
  `includeDesignations`, a `designation` parameter, `displayLanguage`, or a non-English
  `Accept-Language`. Otherwise the display is the one designation. For a 50-code page, that cut
  the reads from 228 rows to 50, and the time from 0.89 ms to 0.17 ms.

Iteration of a full filter set (expand.js's usual path) fetches rows in batches of 500.

## Order

A result is a list of segments, one per include part: enumerated concepts first, then filters, as
expand.js adds them. Each segment holds the members that are not already in an earlier segment
and not excluded.

- Within a filter, members are in id order, which is depth-first hierarchy order.
- LOINC results are the exception: they are in LOINC release-file order. That is terms, then
  parts, answer lists and answers, each by code with its hyphen removed, compared as text. This is
  the order tx.fhir.org and the ecosystem tests use (owner decision). The rank permutation is
  built when the file loads: about 250 ms, 8 bytes per concept. A result is sorted by rank once,
  about 11 ms for all 257k codes, per request.
- Enumerated concepts keep the order they are listed in.
- LOINC answer lists keep their sequence (`refset_member.fields = [sequence]`).

Main has no single order, so this is a deliberate difference (adjudication D3 in
`docs/sqlite-v2-upstream-findings.md`).

## Limits and cost (`tx/sqlite-v2/settings.js`, `modules.tx.sqliteV2`)

Every `modules.tx.sqliteV2` setting is listed in
[CONFIGURATION.md](../CONFIGURATION.md#the-sqlite-v2-engine-modulestxsqlitev2); the two limits:

| knob | default | effect |
|---|---|---|
| `maxScanRows` | 5,000,000 | The planner's estimate of the fact rows a request reads: text/regex scans, relation images, probes, value-set fan-out. It is added up before each read, and the request is refused (too-costly) once the estimate is over the limit |
| `supplementLayerCacheMB` | 64 | Memory for built supplement layers kept between requests, per process (see "Supplements as layers"). It counts the layers' SQLite pages: about 120 bytes per concept with one designation, about 360 with five. 64 MB holds about 530k such concepts. That is two layers the size of all of LOINC (257k), or hundreds from the IG corpus, where 99% have 1,001 concepts or fewer. The least recently used layers are dropped to stay under it. 0 = keep none. Logged in the startup `Limits:` line |

Response sizes are upstream's. A page the provider selects is added through expand.js's
`includeCode`, like every other code, so expand.js's limit (`limitCount`: the server's external
limit, 3,000 unless `modules.tx.externalLimit` says otherwise, or the client's `limit` when lower)
caps a response. Any page up to that size can be served at any
offset, and its total is exact. A refusal by the planner (`maxScanRows`) is a 422
`VALUESET_TOO_COSTLY`.

## No caches (by design), except supplement layers

The engine adds no caches; this is an owner decision. The one exception is built supplement
layers (`supplementLayerCacheMB`, see "Supplements as layers"): building one costs about 7 µs
per concept on every request that filters on a supplement property. Otherwise every request:

- plans its query;
- reads the stored sets it needs from SQLite: each set once per evaluation, in one statement per
  (kind, property);
- evaluates;
- reads the rows of its page.

Measured on the catalog, this costs nothing at the median and less than the cached build at the
worst case that matters (`docs/sqlite-v2-memory.md`).

**Upstream's caches stay exactly as they are**: the expansion cache, the resource caches and the
tx cache-id protocol.

**What remains is not cache:**

| kept | why |
|---|---|
| SQLite page cache | 2 MiB per connection, `sqliteCacheKB` |
| mmap window | 256 MiB per file, `mmapMB`: file-backed, and the OS page cache serves the reads |
| prepared statements | statement handles, not data |
| data built at load | the LOINC release-order rank (2.0 MiB), the designation languages of each file, SNOMED's display-refset and acceptability ids |
| within one request | the evaluation's working set of sets read so far, the codes resolved while compiling, and the concept handles of the request's provider |
| supplement layers | built layers, in an LRU bounded by `supplementLayerCacheMB` |

Repeat expansions over 250 ms are kept by upstream's expansion cache.

## The hooks in expand.js and validate.js (upstream draft PR #334)

The provider implements the core interfaces of #334 (`tx/cs/cs-api.js`):

- **`processSelection(params, includes, excludes, excludeInactive, offset, count, context)`.**
  `handlesSelecting()` is true. expand.js's `processCodes` calls it for a compose of one system and
  version with no value set imports, no text `filter` and no enumerated concepts. The provider
  compiles the whole compose, evaluates it on the engine, and returns
  `{ sets, total, notClosed }` for the requested page: `offset` -1 means from the start, `count` -1
  means to the end, and `count` 0 means the total only. It reads the page's rows (and its
  designations only when the response can show them) in one statement each.
  - It returns `null` when the engine cannot compile the compose (`Unsupported`) or a filter is
    invalid. expand.js then takes its usual path, which reports the error through `filter()` with
    upstream's message.
  - A refusal by the planner (`maxScanRows`) is thrown as the standard too-costly Issue
    (`VALUESET_TOO_COSTLY`, 422). It names the value set from `context.valueSet` (`url|version`).
  - `notClosed` is SNOMED CT's grammar, unless `expressions = false`.
  - expand.js emits `used-codesystem`, the supplement bookkeeping, `valueset-unclosed` and status
    warnings, as for any provider.
- **`prefetchCodes(codes, withDesignations)`.** Before expand.js or validate.js locates a listed
  code list, the provider resolves the codes and reads their rows and designations in one
  statement each, into the request's working set. `locate()` and `designations()` then read nothing
  per code. A 3,000-code enumerated value set takes a handful of statements instead of about 9,000.

- **Another version in an exclude.** A compose that includes one version of a system and
  excludes other versions of the same system ("US Edition minus International") is handed over too
  (`scanValueSet` sets `crossVersion`), when each excluded version is also a sqlite-v2 file of that
  system. The exclude is evaluated on its own file and its ids are translated by code
  (`store.translateFrom`). Whole US minus whole International takes about 0.9 s; the usual path
  hit the 20 s limit after walking about a fifth of the US edition, locating every code in the
  International file. The expansion carries both `used-codesystem` versions and `versionsMatch`,
  as the usual path's.

Mixed value sets and value set imports use the usual path. Their sqlite-v2
includes still go through the filter API, which is engine-backed. Other systems (FHIR CodeSystem
resources, UCUM, BCP-47, …) stay on their own providers.

The request's languages reach the provider through `useRequestLanguages(languages)`. This is our
interim hook; it will be replaced by `getPrepContext(iterate, languages)` from upstream PR #331 once
that is in main.

## SNOMED CT post-coordination

Expressions, MRCM checks, expression subsumption and membership, and the content-defined
translations (`?fhir_cm=edition/<module>`, `?fhir_cm=<module>`) are answered by
`tx/sqlite-v2/sct-native.js`. `NativeExpressionServices` keeps main's expression algorithms (it
extends `tx/sct/expressions.js`), but answers every data question from the file:
- references are concept ids;
- definitions are the active links, and is-a uses the stored sets;
- normal forms come from `concept_normal_form`, built at import;
- the MRCM rules are parsed from `refset_member` once per file;
- ranges and ECL value sets are evaluated by the engine.

Membership of an expression in an ECL constraint, and both translations, are implemented over the
same data.

Per call on US 20250901, typical / worst, each call a fresh request:

| | native | main |
|---|---|---|
| validate an expression | 0.4 / 6 ms | 2.6 / 13 ms |
| reject an expression (MRCM) | 0.4 / 1 ms | 0.9 / 4 ms |
| expression subsumption | 0.4 / 10 ms | 0.3 / 10 ms |
| expression in an ECL value set | 0.3 / 1.4 ms | 1.6 / 5 ms |
| edition translation | 0.4 / 1.8 ms | 0.1 ms / 2.2 s once |

Memory in the same test process: native 124 MB, main 1,362 MB. The parsed MRCM rules take 55–85 KB
per edition.

(An earlier "adapter" mode, which ran main's `cs-snomed.js` over the file, was removed: native gave
the same tx-ecosystem results at a fraction of the cost.)

## ECL the engine refuses

Some ECL the engine does not evaluate itself is run by main's own ECL code (`tx/cs/cs-snomed.js`) over
the file: some group and attribute cardinality combinations, alternate identifiers, attribute-name
sets and member filters (`tx/sqlite-v2/sct-main-ecl.js`). Main reads
its binary cache through a handful of structure classes (`tx/sct/structures.js`); the module answers
the same calls from the file:
- concept index = (concept_id − 1) × 56, and description index = designation_id × 40;
- relationships are numbered as they are read;
- lists and strings are handles resolved on demand.

It is built per call and keeps nothing between requests. The result is a set of concept ids.

## Supplements as layers

A supplement becomes a SQLite database with the v2 schema: a *layer*. Its concepts carry the
base file's `concept_id`s, so its `prop` and `hasProp` sets combine with base sets by ordinary set
algebra.

**How a supplement arrives.** Two ways, and each has its own kind of layer:

- **loaded with the server**: a `library.yml` `file:`/`folder:` source, or a supplement inside a
  loaded package. When its base is a sqlite-v2 terminology file, it is imported once into a file
  of its own and read from there (below, "Server-known supplements on disk");
- **per request**, through `tx-resource` with `useSupplement`, or the value set's supplement
  extensions. Its layer is an in-memory database, built the first time a filter needs it and
  then kept in the layer cache (below).

Either way it reaches the provider as `supplements`. A request that names a server-known
supplement (`useSupplement`) gets the disk-backed one.

**What a layer adds:**

- a filter on a property only a supplement defines becomes a `{t:'layer'}` leaf, evaluated on the
  layer's store;
- the text `filter` does not search supplement designations, as main (D4); the layer keeps a full-text index for the open spec question.

**Displays, designations and `$validate-code` display checks** use upstream's base-class helpers
on the CodeSystem resource. This keeps upstream's semantics exactly:

- `displayLanguage` picks a supplement display;
- designations are tagged with their source;
- `used-supplement` is reported;
- applicability is all or nothing, and a supplement pinned to another base version is an error
  when it is required.

**Codes the base does not contain** are not imported; the layer counts them
(`info.unknownCodes`). Upstream treats them as unknown codes.

**Build cost (in-memory layers).** A layer costs about 7 µs and 120 bytes per concept (one designation each). The
Uzbek LOINC supplement (24,650 concepts) builds in 120–145 ms, and a 100k-concept synthetic one
in about 0.7 s. The text `filter` does not search layers (D4), so it never builds one.

**The layer cache** (`layers.js` `LayerCache`), for in-memory layers. Built layers are kept in one LRU per process:

- **Key.** The key is the base store, the supplement's `url|version`, and a sha-256 of its
  content (its JSON). The hash is computed once per resource object, about 1 µs per concept. A
  `tx-resource` supplement sent again in a later request, as the IG Publisher does within a
  session, therefore hits. A changed supplement with the same url and version misses, so it
  never reads a layer built from other content.
- **Bound.** The bound is `supplementLayerCacheMB`, counted as the layers' SQLite pages. To stay
  under it, the least recently used layers are dropped. A layer bigger than the whole bound is
  built for its request and closed when the request ends, as before the cache.
- **Sharing.** A cached layer is read-only (`query_only`). The trigram index, built on the first
  text search, is the one write, and it is done synchronously. Each request holds a reference to
  the layers it uses, so a layer evicted while a request is still using it is closed only when
  that request ends.
- **Cluster.** In a cluster, each worker process has its own cache, and each builds a layer once.

Measured on a repeat filtering `$expand` with a 100k-concept synthetic supplement (local
server, LOINC 2.83 base, a different filter value each time so upstream's expansion cache
cannot answer):

| supplement | no cache | cached (repeat) |
|---|---|---|
| server-known | 0.72–0.74 s | 3–4 ms |
| `tx-resource` (18 MB body) | 1.01–1.27 s | 0.52–0.56 s |

The `tx-resource` request that remains is mostly the cost of carrying the resource. The same
request with only a base-property filter, so no layer is used, takes 0.45–0.49 s. The rest is
the content hash, about 0.1 s.

### Server-known supplements on disk

Code: `supplement-files.js`. A supplement the server loads (a `library.yml` `file:` or `folder:`
source, or one inside a loaded package) whose base is a loaded sqlite-v2 terminology file is
imported once into a small SQLite file in the v2 schema. Requests then read it, beside the base
file. Nothing is built per request, and its concepts are not held on the heap. Operators change
nothing: the same `library.yml` entries work.

**The file.** It is `<terminology-cache>/v2/supplements/<url>-<version>-<key>.db`, one per
supplement and base file. The key hashes three things:

- the importer's format (`SUPPLEMENT_FORMAT`);
- the supplement's content (its R5 JSON, hashed concept by concept);
- the base file's identity (its `provenance` rows and its `code_system` row).

A changed supplement, a rebuilt base file (its concept ids may differ) or a new importer
therefore names a new file, and the old one is no longer used. Nothing is compared at request
time. The master removes files that no server has used for 7 days. A supplement for SNOMED CT
gets one file per loaded edition it applies to (`isSupplementFor`, as `loadSupplements` decides).

The file holds:

- **the layer**, written by the same code as an in-memory layer (`layers.js` `fillLayer`):
  - concepts under the base's `concept_id`s;
  - designations and property values as rows;
  - each property value as a stored set (`prop`, `hasProp`).

  The engine opens it read-only, once per process, as a `V2Store`. A filter on a
  supplement-defined property is the same `{t:'layer'}` leaf as before. The file has no trigram
  rows, because the text `filter` does not search layers (D4).
- **the resource**:
  - `supplement_concept`: each concept's own JSON, in main's pre-order, with nesting by
    `nest_parent`;
  - `supplement_code` and `supplement_code_nc`: main's `codeMap` and `codeMapNC`, holding the
    first position of each code and its last concept;
  - `supplement_text`: displays and designations, for the text filter;
  - `supplement_info`: the metadata, and the facts upstream's whole-supplement scans look for
    (any display, the display-use languages, the designation languages).

**DiskSupplement.** In the library, the in-memory `CodeSystem` is replaced by a
`DiskSupplement`. It is main's `CodeSystem` class built from the metadata alone. Its concept
methods read the file and return what main's in-memory object returns, in the same order:

- `getConceptByCode`, `getAllConcepts` and `getAllCodes`;
- `hasCode`, `codeMap` and `codeMapNC`;
- `getConceptByDisplay`;
- `jsonObj.concept`, the nested tree rebuilt on read, for CodeSystem read and search;
- the hierarchy methods, which build main's object for the call.

Upstream's display and designation helpers (`_displayFromSupplements`,
`_listSupplementDesignations`) therefore run unchanged on it. The sqlite-v2 provider answers the
three helpers that scan every concept from `supplement_info` and `supplement_text` instead:
`_hasAnySupplementDisplays`, `_hasSupplementText` and `_supplementSearchCodes`. Each request has
its own view of the supplement (`forRequest`), which keeps the concepts the request has read, so
a code is read once. A result page's codes are read in one statement (`_loadRows` → `prefetch`).

**Which supplements.** Every server-known supplement whose base is a loaded sqlite-v2
terminology file goes to disk, whatever its size. There is no size threshold: a file costs about
0.5 KiB of disk per concept, built once. Kept in memory, a 250k-concept supplement costs
135 MiB of heap in every process. Two kinds keep the in-memory layer:

- supplements of other code systems (FHIR CodeSystem resources, package blocks);
- per-request supplements (`tx-resource`), which also use the layer cache above.

**The setting.** `modules.tx.sqliteV2.supplementFiles` defaults to true. With false,
server-known supplements stay in memory, as main keeps them. The startup limits line reports it
(`sqliteV2.supplementFiles=on`).

**Cluster** (cluster.md, #342). The master builds a missing file into a temporary file and
renames it into place. A tx-worker (`packageCachesReadOnly`) never builds one: it waits for the
master's file (`waitForCache`) and opens it read-only.

**Startup without the source** (`folder:` and `file:` sources). When the master builds the
file(s) for a supplement it parsed from a source file, it also writes a sidecar,
`v2/supplements/source-<sha256 of the source file's bytes>.json`. The sidecar holds the
supplement's content hash, its metadata (the resource without `concept`) and its loader index
entry. At the next startup the folder loader hashes each source file, streamed, before it parses
anything. A file whose hash has a sidecar is indexed from the sidecar and becomes a stub
`CodeSystem` made from the metadata alone. The library pass opens the stub's files as a
`DiskSupplement`, so the source JSON is never read into the heap.

- A changed source has other bytes, so it has no sidecar. It is parsed and its file is built, as
  for a new supplement.
- When a stub's file is missing (a rebuilt base file, a new `SUPPLEMENT_FORMAT`), the stub is
  parsed then, and the file is built as before. It is also parsed when no sqlite-v2 base applies
  or `supplementFiles` is off.
- The check hashes the bytes on every startup: 44 MB takes about 50 ms. It is not cached by
  size and mtime, because a change that keeps both would then serve the old content. It needs no
  index from source path to file either, because the hash is the lookup key.
- The startup log line counts the stubs (`2 not parsed`).
- Supplements inside packages are still parsed at startup.

**Same answers.** `tests/tx/sqlite-v2-supplement-files.test.js` compares the two forms, the
in-memory `CodeSystem` and the `DiskSupplement`:

- method by method: case-sensitive and case-insensitive supplements, a nested concept, a code
  listed twice, and a code the base lacks;
- through the router: 66 `$expand`, `$lookup` and `$validate-code` requests, each answered with
  the supplement in memory and on disk. They cover `displayLanguage` (de, de-CH, fr, en, none),
  designations, the text filter, and `=`, `in`, `not-in`, `regex` and `exists` filters on
  supplement properties, alone and with `is-a`;
- the three scan helpers, in five request languages.

The responses are identical. On the Uzbek LOINC supplement and on a 250k-concept SNOMED CT
supplement (below), the benchmark's responses were the same with the supplement in memory and
on disk.

**Measured.** The supplement is synthetic, on SNOMED CT International 20250201: 250,000 active
concepts, each with 1–2 Uzbek designations and one supplement property (`synthprop`, 5 values).
The Uzbek LOINC supplement (24,650 concepts) was loaded beside it. One process, on a shared
machine (load average 7–11).

Import and memory:

| | no supplements | in memory (`supplementFiles: false`) | on disk |
|---|---|---|---|
| import, first startup | — | — | 4.6 s, 117 MiB file (LOINC uz: 0.4 s, 14.5 MiB) |
| later startups | — | — | 0.4 s, to hash the content and find the files (since the sources are no longer parsed: below) |
| heap after startup (after GC) | 80 MiB | 215 MiB | 81 MiB |
| RssAnon after startup | 300 MiB | 475 MiB | 465 MiB (since the sources are no longer parsed: below) |
| RssAnon after the requests below | 381 MiB | 667 MiB | 474 MiB |

Requests, first / repeat (`count` changes each time, so upstream's expansion cache does not
answer):

| request | in memory | on disk |
|---|---|---|
| `$expand` `synthprop = v3`, 100 codes | 2,588 ms / 4 ms (layer build, then the LRU) | 7 ms / 6 ms |
| `$expand` `is-a` and `synthprop = v3`, `displayLanguage=uz` | 6 / 5 ms | 8 / 8 ms |
| `$expand` `is-a 404684003`, `displayLanguage=uz`, 100 codes | 31 / 10 ms | 20 / 8 ms |
| the same, 2,500 codes | 88 / 70 ms | 119 / 105 ms |
| LOINC `CLASS = CHEM`, `displayLanguage=uz`, 2,500 codes | 218 / 210 ms | 300 / 285 ms |
| `$expand` with a text `filter`, `displayLanguage=uz` | 5.1 / 4.9 s | 5.5 / 5.2 s |
| `hasAnyDisplays` for a language the supplement lacks | 66–97 ms per request | 0 ms |

- **Memory.** The heap saving is the supplement's concepts: 135 MiB per process. Parsing the
  source JSON at startup left about 170 MiB of V8 pages behind after the objects were freed, so
  RssAnon after startup stayed near the in-memory figure. Since startup no longer parses the
  source (above), that figure is gone. Each server below was started on its own, with files
  already built, and measured after GC. The figures are the mean of 3 startups. "Loading" is the
  library's Loading Time; "up" is time until `/metadata` answers, polled every 0.5 s.

  | library (SNOMED CT and LOINC v2 files, plus) | parsing the source: loading / up / RssAnon | not parsing it |
  |---|---|---|
  | no supplements | — | 0.66 s / 2.0 s / 336 MiB |
  | Uzbek LOINC supplement (4.9 MB, 24,650 concepts) | 1.25 s / 2.9 s / 348 MiB | 1.16 s / 2.6 s / 339 MiB |
  | the same and the 250k SNOMED CT supplement (44.6 MB) | 2.95 s / 4.6 s / 495 MiB | 1.65 s / 3.1 s / 385 MiB |

  The library pass itself takes 3–6 ms, down from 30–290 ms.
- **Request times.** A filter on a supplement property no longer pays a first-request build. A
  large display page is about 30 µs per code slower than a hash lookup, so a 2,500-code page
  takes 30–80 ms longer. The text filter's 5 s is upstream's `passesAll` over 333k supplement
  texts, in both forms.

**Open.**

- Supplements inside packages are still parsed at every startup (only `folder:` and `file:`
  sources skip it).
- Supplements of package code-system blocks stay in memory.

## Fallbacks and what is not supported

These return `null` from `processSelection` and take expand.js's usual path. Through `filter()`
they then raise upstream's error:

- ECL `^ *`, reference set field selection `^ [fields]`, member filters `{{ M }}`, and alternate
  identifiers;
- cardinality on reverse attributes and on concrete-value comparisons;
- `!=` on reverse attributes;
- SNOMED `expressions = true`, `mapped:*`, and post-coordinated expressions in `$lookup` and
  `$validate-code`;
- RxNorm `AUI:` filter values (the file stores no atoms).

## Where we differ from main deliberately

Parity means matching main where main is right. Where the FHIR specification, or ECL, defines
something that main refuses and the stored data can answer, the engine answers. Main's error
messages are kept only for requests that are actually invalid, such as an unknown property, a
malformed value or bad ECL.

- **Filters.** The generic filters of R5 CodeSystem §4.8.15 work for SNOMED CT, LOINC and RxNorm:
  - `code regex`;
  - `[property] = / in / not-in / regex / exists` on every property in the file, relationships
    included (RxNorm `RELA`/`REL` take `CUI:x` or a bare RXCUI), with the FHIR search prefixes
    on integer, dateTime and decimal properties;
  - `designation = / regex`, where the display counts as a designation;
  - `concept is-a / descendent-of / is-not-a / generalizes / child-of / descendent-leaf`, plus
    `= / in / not-in`.

  Beyond that table, by the owner's decision: `display = / in / regex` and properties a
  supplement defines.
- **Order and limits.** See Order and Limits and cost.
- **Text `filter`.** As main: no other-language or supplement designations.
- **ECL.** ECL 2.0 description filters without the `D` (`{{ term = "…" }}`) are accepted
  (`tx/sct/ecl.js`). Concrete values, attribute and group cardinality, and history supplements are
  evaluated, as are `?fhir_vs=ecl/…` and edition-qualified `?fhir_vs` URLs.
- **Paging.** A page of a whole-compose selection can start at any offset, and its total is
  exact. Value set imports are expanded as main expands them.

## Known differences from the upstream providers

These were found by comparing the same releases side by side: SNOMED International 2025-02-01,
LOINC 2.83 and RxNorm 03022026, on both servers. In each case the sqlite-v2 answer is kept.

| area | upstream | sqlite-v2 |
|---|---|---|
| SNOMED `<attribute> = X` filter and `$lookup` defining relationships | include inactive (historical) relationship rows | active relationships only |
| SNOMED map refsets (`^ 900000000000497000`) | not loaded (the cache skips map refsets) | loaded (content scope rule) |
| order of `$lookup` properties and children | the order queries complete in, or stored order | grouped by kind |

## Running

Library source lines:

```yaml
- sqlite-v2!:sct-intl-20250201.db   # default SNOMED edition
- sqlite-v2:sct-us-20250901.db      # by version: http://snomed.info/sct/731000124108[/version/20250901]
- sqlite-v2!:loinc-2.83.db
- sqlite-v2!:rxnorm-03022026.db
```

Optional `modules.tx.sqliteV2Trace: "request"` enables `_trace=true` and the trace endpoint.
