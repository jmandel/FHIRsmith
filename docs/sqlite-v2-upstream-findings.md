# sqlite-v2: upstream findings

Each row is a behaviour where the sqlite-v2 providers differ on purpose from upstream FHIRsmith
(`main`) or from tx.fhir.org. Anything changed because upstream behaves wrongly should end up as a
tx-ecosystem test case that shows the upstream failure.

**Classification**

| class | meaning |
|---|---|
| **upstream bug → test** | Propose the test that is sketched here. |
| **spec question → adjudicate** | The owner decides. Until then, main's behaviour is the default. Rows marked *decided* have an owner decision. |
| **policy or deployment, no test** | No test is proposed. |

**Test data and sources**

- Proposed tests use the suites' small data in fhir-tx-ecosystem-ig `tx-source/`:
  - the SNOMED test edition `http://snomed.info/xsct/31000003106/version/20250909`, about 2,280
    concepts;
  - the LOINC, RxNorm and NDC subsets.
- Catalog ids refer to `tx/sqlite-v2/catalog/entries/`. "compare" means the side-by-side run of
  main's providers and sqlite-v2 on the same releases (milestone 1).

## Upstream bugs, with proposed tests

| # | catalog | upstream / tx.fhir.org | sqlite-v2 and why | proposed test |
|---|---|---|---|---|
| U1 | `sct-attr-finding-site-eq` | The `363698007 = 39057004` filter returns 212. That is 101 concepts with an active row plus 111 whose matching rows are all inactive. cs-snomed.js checks relationships without their active flag (`filterLocate`/`filterCheck`). | Returns 101. Filters and ECL read the current state. An inactive relationship row is history and is no longer a property of the concept (SNOMED release format: active = 0 means the row is retired). | **snomed suite** (mode snomed). Setup: add an inactive row to the TEST1000003 relationship file, giving test concept X the attribute A = V with active 0, where X has no active A = V. Request: `$expand` of an include with filter `A = V`. Expected: X is not in the expansion. Today the test subset has no inactive relationship rows, so this needs the extra row. |
| U2 | compare: `$lookup` 73211009, 10200004, 128045006 | Defining-relationship properties include inactive rows, for example a 73211009 finding site of "Entire endocrine gonad". | Lists active rows only. The reason is the same as U1. | **snomed suite**. Same setup as U1. Request: `$lookup` X. Expected: no property `A` with value V. |
| U3 | `rxnorm-sty-and-sab` | tx.fhir.org returns ≥1,000 codes for `STY = T121` AND `SAB = CVX`. Its first page has codes with T121 and no CVX atom, so only STY was applied. On rxnorm_03022026: STY alone gives 26,965, SAB alone 353, both 20. main's executeFilters joins the fragments, so this may be specific to tx.fhir.org's deployment. | Returns the 20, the conjunction. FHIR: the filters of an include are ANDed ("all filters must be true"). | **new rxnorm cases in the tx.fhir.org or general suite** (mode tx.fhir.org). Setup: the RxNorm subset. Request: an include with filters `STY = <TUI of 161 acetaminophen>` and `SAB = <a SAB that 161 has no atom in>`. Expected: 161 is not in the expansion. Add a control with a SAB 161 does have: 161 is in it. |
| U4 | `sct-ecl-description-filter` | 400 Invalid ECL for `< 404684003 {{ term = "heart attack" }}`. tx/sct/ecl.js requires `D` after `{{`. | Accepted as a description filter. ECL 2.2 grammar: `descriptionFilterConstraint = "{{" ws ["d" / "D"] ws descriptionFilter …`, so the `D` is optional. The parser change is in `tx/sct/ecl.js`, with a test in tests/cs/cs-snomed-ecl.test.js. | **snomed suite**. Request: `$expand` of `constraint = << 300338006 {{ term = "liver" }}`, a liver concept in the test edition. Expected: the same codes as `{{ D term = "liver" }}`, not 400. |
| U5 | compare: `concept in 73211009,46635009,44054006`; tx-ecosystem `sct/expand-concept-in`, `expand-code-in`, `validate-code-concept-in`, `validate-code-code-in` | For a concept that is not a refset, main (tx.fhir.org and tx-dev.fhir.org, 2026-11-01) returns one fabricated code, `4294967295`. filterIn pushes raw indexes for codes that are not refsets, and iteration reads `.ref`. | Each listed id that is a refset contributes its active members, and any other id contributes the concept itself. `code` is the same filter property as `concept`. An unknown concept is an error ("The SNOMED CT Concept X is not known", as main). terminology.hl7.org's SNOMED CT page defined `concept in` for refsets only. The owner (Grahame, 2026-11-02) decided that bare concepts also count, and THO is being changed to say so. | **snomed suite**: added by the owner in fhir-tx-ecosystem-ig 317c8b0 (PR #100), with `concept in` / `code in` "10200004,50325005,51292008" expected to give exactly those 3 codes (total 3), and `$validate-code` of one of them expected true. All four pass on sqlite-v2. |
| U6 | compare: `http://loinc.org/vs/LP14635-4` | 500. The implicit part value set uses filter `ancestor`, which the LOINC provider does not know. | Expands: the descendants of the part. | **loinc suite**. Request: `$expand` url `http://loinc.org/vs/<a part in the LOINC subset with descendants>`. Expected: 200, with the subset's terms under that part. |
| U7 | `sct-implicit-refset-icd10cm-map` (edition form); `sct-implicit-ecl` | `http://snomed.info/sct/<edition>[/version/<date>]?fhir_vs…` is not recognised: the factory compares against an undefined `this.edition`. `?fhir_vs=ecl/…` gives 422 not-found. | Both resolve. The edition-qualified form expands against that edition. The SNOMED-on-FHIR implicit value set URLs (terminology.hl7.org SNOMED CT page) include the edition/version forms and `?fhir_vs=ecl/`. | **snomed suite**. Requests: `$expand` url `http://snomed.info/xsct/31000003106/version/20250909?fhir_vs=isa/<concept>`, and url `http://snomed.info/sct?fhir_vs=ecl/<url-encoded << concept>` with the test edition as system-version. Expected: the same codes as the inline compose. |
| U8 | `sct-us-minus-intl-whole` | 500 "Must override". A compose that excludes a whole code system calls `iteratorAll()`, which throws for every hierarchical provider. | Answers in the engine: 0.95 s (it was 18 s on the expand.js usual path). The excluded edition is evaluated on its own file and translated by code (N2). | **loinc suite** (or snomed). Request: include a small LOINC filter, and exclude `{system: http://loinc.org}` with no filter. Expected: 200, total 0. |
| U9 | compare: RxNorm `TTY in IN,PIN`, `STY`, `SAB` with `count = 0` | Totals count RXNCONSO atoms, which repeat codes. For example STY T200 gives 254,798. | Totals count distinct concepts. `expansion.total` is "the total number of concepts in the expansion". | **rxnorm cases** (as U3). Request: `$expand` of `TTY = <a TTY with several atoms per code in the subset>`, `count = 0`. Expected: total = number of distinct RXCUIs. |
| U10 | compare: `$lookup` LP14635-4 | One `parent` property appears twice: duplicate rows in the relationship table. | Each property value appears once. | **loinc suite**, low priority. Request: `$lookup` of a subset part with that duplication. Expected: no repeated (code, value) property. This depends on the subset reproducing the duplicate, which needs checking. |
| U11 | `sct-refset-icd10cm-map-ecl`, `validate-refset-icd10cm-map-ecl`, `^ 900000000000497000` (compare) | Map refsets have no members: the cache importer skips refset files whose name mentions "map". | Every refset is loaded (content scope rule). ECL `^` and `?fhir_vs=refset/` can name any refset. | **snomed suite**. Setup: add a tiny `der2_sRefset_SimpleMapSnapshot` with 2 members to tx-source. Request: `$expand` of `constraint = ^ <that refset>`. Expected: total 2. |
| U16 | `sct-ecl-concrete-value` | 400 UNSUPPORTED_ECL: "this edition was imported without its concrete value relationships". tx.fhir.org's 2025-02-01 cache has no concrete values. main's ECL evaluates them on caches that carry them, so this is an import or data gap on tx.fhir.org's side. | Evaluated. The v2 import keeps `sct2_RelationshipConcreteValues`. | **snomed suite** (mode snomed): the test edition ships `sct2_RelationshipConcreteValues_Snapshot_INT_20250909.txt`. Request: `$expand` of `constraint = < 763158003 : 1142135004 = #<a value present in the test data>`. Expected: the products with that value, not 400. This guards against importers that drop concrete values. |
| U17 | `oh-sct-expand-many-properties`, `oh-sct-expand-property-star`, `oh-loinc-expand-many-properties`, `oh-loinc-property-star-1000`, `oh-rxnorm-property-star`, `oh-sct-compose-property` | `$expand` ignores requested properties (`property=…`, `property=*`, `compose.property`). The upstream providers' `properties()` returns `[]`, so `contains.property` is empty (LOINC gets only `status`). | Each code carries the requested properties, with the same values `$lookup` reports. They are read only when the request asks for properties. | **simple or loinc suite**. Request: `$expand` with `property=COMPONENT` (LOINC subset) or `property=parent` (SNOMED test edition). Expected: each contains has that property, declared in `expansion.property`. |
| U18 | `oh-loinc-designation-filter` | The `designation` parameter given as a bare language (`designation=nl-NL`) drops every designation. expand.js only matches `system\|code` tokens. | A token without a system matches a designation's language (BCP 47 prefix, `nl` matches `nl-NL`) or its use code. The change is in `useDesignation` in tx/workers/expand.js, shared by every provider. | **language suite**. Request: `$expand` with `includeDesignations=true` and `designation=nl-NL` on codes with Dutch designations. Expected: the Dutch designations only. |
| U19 | `oh-lookup-rxnorm-sbd-star` | RxNorm `$lookup property=*` returns only `inactive` and `notSelectable`. cs-rxnorm.js's `extendLookup` writes to `params.parameter` on the response array, which is never serialised. | TTY, STY, SAB, SUPPRESS and the relationships (RELA, value = the related RXCUI with its display). | **rxnorm cases** (as U3). Request: `$lookup` of an SBD in the subset with `property=*`. Expected: TTY and its `has_ingredient`/`tradename_of`-type relationships. |
| U20 | `oh-lookup-sct-default`, `oh-lookup-sct-property-star` | SNOMED `property=*` has no `sufficientlyDefined` (and no `normalForm`/`normalFormTerse`). The module is reported as `module`, while SNOMED CT on FHIR (terminology.hl7.org) names it `moduleId`. | `sufficientlyDefined` is reported, from `definitionStatusId`. `moduleId` is reported when asked for by name, and `module` is kept for compatibility. `normalForm` is not implemented yet. | **snomed suite**. Request: `$lookup` of a fully defined test concept with `property=sufficientlyDefined`. Expected: `true`; and a primitive one, `false`. |
| U22 | IG-build corpus B7 (an edition-only `system-version`, sent on almost every IG Publisher call) | With several versions of a SNOMED CT edition loaded, `system-version http://snomed.info/sct|http://snomed.info/sct/731000124108` resolves to the version the library lists **last**: `registerProvider` (tx/library.js) overwrites the partial-version key on every load. tx.fhir.org is right only because tx.fhir.org.yml lists versions oldest-first. Shared code: main and sqlite-v2 alike. | The partial-version key keeps the latest version, whatever the load order (also for semver major.minor keys). Consistent with U21 (edition-only implicit value set URLs). Test: `tests/tx/library-partial-version.test.js`, both load orders. | **snomed suite**, on a server with two versions of one edition loaded. Request: `CodeSystem/$validate-code` of a concept with `system-version` = the edition URI. Expected: `version` = the later version. |
| U23 | tx-ecosystem regex tests whose patterns use alternation (none yet) | The FHIR CodeSystem provider (`cs-cs.js`) and the country provider anchor a regex as `'^' + value + '$'`. For `code1|code3` that means "starts with code1, or ends with code3", so `xcode3` and `code1x` match. | Wrapped as `^(?:value)$`, with a test in `tests/cs/cs-cs.test.js`. | **simple suite**. Request: `$expand` include `code regex "code1|code3"` on the simple code system. Expected: exactly code1 and code3 (no code with a prefix or suffix). |

## Spec-defined filters main refuses (R5 CodeSystem 4.8.15, "Filters")

R5 and R6 define these filters for all code systems, with the is-a group for systems that have
is-a relationships, so main refusing them is an upstream bug. The R6 build page has the same
table.

| # | catalog | upstream | sqlite-v2 | proposed test |
|---|---|---|---|---|
| U12 | `sct-descendent-leaf-diabetes`, `sct-is-not-a` | 500: "Unsupported filter operation: concept descendent-leaf / is-not-a" | supported for every system | **snomed suite**. Request: `$expand` include `concept descendent-leaf <test concept with leaf descendants>`. Expected: its leaf descendants. Same for `is-not-a`: everything except the concept and its descendants, paged with a total. |
| U13 | `rxnorm-sbd-by-brand-in-list` | relationship `in`: 500 "Unknown filter" | `[property] in` on relationship properties (`CUI:x` or a bare RXCUI) | **rxnorm cases** (as U3). Request: `has_ingredient in CUI:161,CUI:<another IN in the subset>`. Expected: the union of the two `=` filters. |
| U14 | none yet (engine tests) | main does not support `designation =` or `designation regex` | supported: the display, or any active designation | **simple/snomed suite**. Request: include filter `designation = <a synonym of a test concept>`. Expected: that concept. |
| U15 | none yet | search prefixes on `=` for integer, dateTime and decimal properties (4.8.15.1) are not supported | `eq/ne/gt/lt/ge/le/sa/eb/ap` on literal properties (e.g. SNOMED `effectiveTime`, concrete values) | **snomed suite**. Request: include filter `effectiveTime = ge2025`. Expected: the test concepts with an effectiveTime in 2025. |
| U21 | multi-edition server (docs/sqlite-v2-sct-from-cache.md) | `http://snomed.info/sct/<module>?fhir_vs=…` is answered by the first-registered file of that edition. `findKnownValueSet` takes the first factory that accepts the URL. tx.fhir.org loads US 20230301, 20240301 and 20250901, so the US edition URL resolves to whichever US file the library lists first. | Resolves to the latest loaded version of that edition (**adjudicated by the owner 2026-11-01: keep**). The SNOMED CT on FHIR page defines an edition URI without `/version/` as the most recent version of that edition known to the server. `$lookup` with `version=<edition URI>` already picks the latest. | **snomed suite**, needs two versions of one edition (e.g. the test edition at two dates, the later one adding a child of concept X). Request: `$expand` url `http://snomed.info/xsct/31000003106?fhir_vs=isa/X`. Expected: `used-codesystem` is the later version, and the new child is in the expansion. |

## Adjudicated (owner decisions, 2026-11-01)

| # | catalog | question | decision and reason |
|---|---|---|---|
| D0 | — | Caching. | **The design adds no caches** (owner decision, 2026-11-01). The engine plans and evaluates every request from SQLite. Upstream's expansion cache, resource caches and cache-id protocol are unchanged. Measurements are in `docs/sqlite-v2-memory.md`. |
| D1 | `ips-results-coded-values`, `sct-union-findings-procedures-deep`, `*-whole-system*`, `sct-large-no-count` | Size caps: main allows 1,000 codes per response and 10,000 for nested imports, gives no page beyond the limit, and omits the total when it stops early. | **Cost-based** for engine-backed value sets. Totals are exact and any page is served. A request is refused (too-costly) only when (a) the planner's estimated cost exceeds `maxScanRows`, or (b) one response would carry more than `maxResponseCodes` codes (an unpaged large set, or a large `count`). The client's `limit` still applies. Main's caps do not apply to engine-backed parts. Knobs: `modules.tx.sqliteV2 { maxResponseCodes: 10000, maxScanRows: 5000000 }` (`tx/sqlite-v2/settings.js`). No test: policy. |
| D2 | `loinc-component-regex`; tx-ecosystem `simple-expand-regex`, `simple-expand-regex2`, `simple-expand-regexp-prop`, `simple-expand-regex-none`, `validation-simple-code-good-regex` / `-bad-regex` / `-regex-none`, `loinc-expand-class-regex`, `loinc-validate-filter-class-regex-good` / `-bad`, `related-regex-1` / `-2`, `expand-regex-bad(-2)`, `validate-regex-bad(-2)`, `snomed-*-display-regex*` | Regex anchoring. | **Whole term, for every system** (revised 2026-11-02; this replaces "keep main's match-anywhere"). Every regex test in the tx-ecosystem suite (adc5616) is consistent with whole-term matching, and six require it: `simple-expand-regex`, `simple-expand-regex2`, `validation-simple-code-bad-regex`, `expand-regex-bad`, `expand-regex-bad-2` and `validate-regex-bad-2`. None requires match-anywhere. The requirements state it for SNOMED CT display regex ("the pattern SHALL match the whole term"). In main, the FHIR CodeSystem and country providers anchor (`^` + value + `$`, see U23), LOINC finds anywhere, and SNOMED CT refuses display regex. sqlite-v2 tests `^(?:P)$` with RE2 for code, display, designation, property and relationship-target regexes. The catalog's `loinc-component-regex` was written against main's match-anywhere. |
| D3 | all paged expansions | Result order. | **Hierarchy (depth-first id) order** within a filter. Enumerated lists keep their listed order, and LOINC answer lists keep their sequence. **LOINC results** use LOINC release-file order: terms, parts, lists, answers, each by code with the hyphen removed (amended 2026-11-01). That is the order tx.fhir.org returns, and the 7 LOINC ecosystem tests below depend on it. Elsewhere main has no single order, so matching it is neither cheap nor well defined. A deliberate difference; no test. |
| D4 | `loinc-text-filter-german`, `uz-supplement-text-search`, `sct-text-filter-heart-attack` | Text `filter`: which designations it searches. | **Match main**: LOINC searches the display (as a phrase). SNOMED requires every word's stem to be a word of one active description. RxNorm searches the atoms. Other-language and supplement designations are not searched. Whether they should be goes to HL7 as a spec question. |
| D5 | `sct-regex-display-*`, `vsac-diabetes-medications`, `supplement-added-property-filter` | Filters outside the R5 generic table: `display` as a property, RxNorm `concept in`, properties a supplement defines. | **Supported** (owner, earlier this round). `display` is the R5 `designation` filter restricted to the display, and supplement properties are "defined properties" while the supplement is in use. `concept in` is used by published VSAC value sets. |

## Noted, not changed

| # | catalog | question | current behaviour and basis |
|---|---|---|---|
| N1 | `sct-ecl-description-filter` (`{{ term = "heart" }}`) | Can a term filter match through text definitions only? For example "Mosaic trisomy 9 syndrome" matches only through its definition. | **Yes, as specified.** ECL 6.8: when a description filter names no `type` or `typeId`, no description type is excluded (`fsn`, `syn` and `def` are all types). By default only active descriptions are searched. main also searches its cache's descriptions, text definitions included. A client that wants terms only adds `type = syn` (or `type != def`). Spec question for SNOMED International if the intent differs. |
| N2 | `sct-us-minus-intl-whole` | What does a whole-system include mean, and how does an exclude of another version match? | **Now in the engine.** The excluded version is evaluated on its own file and translated by code within the request (no cached id map). This takes 0.95 s, where the expand.js usual path took 18 s and kept an RSS peak of +930 MiB. The total is 12,663, not the usual path's 11,374: a whole-system include contains inactive concepts too (CodeSystem content; `activeOnly` and `inactive = false` remove them), and the usual path's walk from the roots reaches active concepts only. tx.fhir.org returns 500 here. |
| N4 | IG-build corpus B6 (69 batch calls) | UCUM `%/100` with display "percent / 100": tx.fhir.org returns "Wrong Display Name"; FHIRsmith returns `result = true` with no issue. | **Main's behaviour, unchanged here.** This branch does not touch `tx/cs/cs-ucum.js`, and upstream main has not changed it since. The UCUM provider lists the common-units display ("percent / 100") as an English synonym, and main's display check accepts any designation. Whether a common-units display is a valid UCUM display is a spec question for HL7 (UCUM has no display names; the common-units value set supplies them). Proposed test if adjudicated: **ucum suite**, `$validate-code` of `%/100` with display "percent / 100", expecting the adjudicated severity. |
| N5 | VSAC replay: 6 corpus calls, for example `$validate-code` of SNOMED CT 10632007 (inactive, not in VSAC 2.16.840.1.113762.1.4.1010.4) as a `codeableConcept` | tx.fhir.org's recorded answer adds `inactive = true` when no code is returned (`result = false`). FHIRsmith omits it. | **Main's behaviour, not changed here.** Upstream `validate.js` (0e77ec7, 2026-10-06, "fix bug around handling inactive codes") reports `inactive`/`status` only for the code being returned. In a CodeableConcept where no coding is returned, that means none; the INACTIVE_CONCEPT_FOUND warning is still issued. The recordings predate that change. The tx-ecosystem tests agree with it: `inactive-4-validate` (the inactive coding is not the returned one, no `inactive`) and `inactive-5-validate` (it is, `inactive = true`). No test covers a CodeableConcept that is not in the value set. Spec question; main's behaviour is kept until it is adjudicated. Proposed test: **inactive suite**, `$validate-code` of a CodeableConcept with one inactive coding not in the value set; expected: adjudicated presence of `inactive`. |
| N6 | deploy check: `$validate-code` of `73211009 : 363698007 = 73211009` (a disorder as a Finding site value) | The top-level `message` says "Unknown code '73211009 : 363698007 = 73211009' in the CodeSystem …". The MRCM reason (`does not allow 73211009 \|Diabetes mellitus\| as the value of the attribute 363698007 \|Finding site\| (the value must satisfy "<< 442083009 …")`) is only the second issue. tx-dev.fhir.org answers the same. | **As main** (adapter and native alike). The tx-ecosystem `validate-code-pc-mrcm-*` tests expect exactly this pair of issues. Request for Grahame: should the message, or the first issue, carry the MRCM reason rather than "Unknown code", since the code is a syntactically valid expression that the concept model rejects? |
| N7 | deploy check: implicit whole-system value sets for LOINC and RxNorm | `http://loinc.org?fhir_vs` and `http://www.nlm.nih.gov/research/umls/rxnorm?fhir_vs`: "ValueSet not found" on tx-dev.fhir.org and on main. `?fhir_vs` is SNOMED CT's implicit value set syntax. | **No change.** LOINC's own form `http://loinc.org/vs` (and `/vs/<code>`) works on tx-dev and on sqlite-v2. sqlite-v2 also answers `http://www.nlm.nih.gov/research/umls/rxnorm/vs`, which tx-dev does not. Request: does THO/FHIR define an implicit all-codes value set for RxNorm? |
| N8 | rebuilt UK 20230412 | *Withdrawn (2026-11-02).* UK 20230412 → International translates on every server: `ConceptMap/$translate`, sourceCoding `http://snomed.info/sct\|22298006` version `http://snomed.info/sct/83821000000107/version/20230412`, targetSystem `http://snomed.info/sct\|http://snomed.info/sct/900000000000207008` gives 22298006, equivalent, International 20230131, on sqlite-v2 native, sqlite-v2 adapter, main's own `sct_uk_20230412.cache` and tx-dev.fhir.org. The UK edition module 83821000000107 depends on 900000000000207008 directly. The earlier claim came from a truncated check. | No upstream bug; no test needed. |

## Not a bug

| # | catalog | claim | finding |
|---|---|---|---|
| N3 | `oh-sct-include-definition`, `oh-loinc-include-definition` | "`$expand` with `includeDefinition` returns no definitions." | `includeDefinition` asks for the **value set's** definition (compose, description, …) in the result, and both servers return it. Concept definitions are requested with `property=definition`; that works on sqlite-v2 (SNOMED text definitions). LOINC 2.83 as imported has no concept definitions. The catalog entries test the wrong parameter for concept definitions. |

## Policy or deployment (no test)

| # | catalog | upstream / tx.fhir.org | sqlite-v2 | why no test |
|---|---|---|---|---|
| P1 | see D1 | limits | see D1 | policy |
| P4 | compare: US Edition `effectiveTime` | One day earlier than RF2 (the time-zone bug fixed upstream in b082f98, still in tx.fhir.org's cache). | The RF2 date. | Deployment (stale cache). |

## Proposal to the tx-ecosystem test owners: pages and totals

**Affected tests** (loinc suite):

- `loinc-expand-all-limited`
- `loinc-expand-class-regex`
- `loinc-expand-copyright`
- `loinc-expand-scale-type`
- `loinc-expand-prop-order-obs`
- `loinc-expand-filter-dockind-request-parameters`
- `loinc-expand-filter-no-method`

Each asks for a paged expansion of more than 1,000 codes.

**Observed.** The expected responses fix three things that `$expand` leaves to the server:

1. **No `total`.** The server stops at its limit and does not count. A server that knows the
   total and reports it fails on "unexpected property total".
2. **The exact codes on the page.** TxTester sorts `contains`, but which codes are on a page
   still depends on the server's order, which `$expand` does not define. A server returning a
   correct page in another order fails.
3. **`expansion.property` declaring `status`** when no code on the page carries it. Five of the
   seven (all but `-all-limited` and `-filter-no-method`) expect it. The server walked the first
   1,000 codes, beyond the page, and declared the property for codes it then dropped. A server
   that declares only what the page uses fails on "missing property property".

**Proposal.**

- **(a)** Mark `expansion.total` as `$optional$` in these responses. When present, it must equal
  the number of codes in the value set.
- **(b)** Check the page by size and membership instead of listing its codes:
  - `count` codes, or fewer on the last page;
  - every code a member of the value set, checked with a membership check or a reference set in
    the test;
  - no duplicates.
- **(c)** Where order is the point of a test, use an enumerated (`orderDefined`) value set:
  enumerated concepts keep their listed order on every server.
- **(d)** Make `expansion.property` declarations for properties no returned code uses
  `$optional$`.

**Status, IG 1.10.1.** With LOINC release-file order (D3), the pages hold the same codes. All
7 tests (21 runs) still fail, on the exact total (D1) and, in 5 of them, on the `status`
declaration. That is 91 failing runs against main's 70. (a) and (d) would make them pass.
