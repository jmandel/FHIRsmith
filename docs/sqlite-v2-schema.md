# sqlite-v2 terminology schema

DDL: `tx/importers/sqlite-v2/schema-v2.sql` (`PRAGMA user_version = 3`). Builder and shared final
stage: `tx/importers/sqlite-v2/builder.js`. Importers: `tx/importers/import-{sct,loinc,rxnorm}-v2.module.js`, and
`import-sct-v2-cache.module.js` for SNOMED editions available only as FHIRsmith caches (docs/sqlite-v2-sct-from-cache.md).

**Rule.** SQLite stores facts. Roaring bitmaps in `concept_set` are the index for every membership
question. There is no closure table, no SQL fallback for membership, and one id numbering.

## Files and ids

- One file holds one release of one code system. `code_system` has exactly one row.
- `concept_id` is a dense, 1-based id assigned at import. It is the bit position in every bitmap.
  Ids are local to the file. Never combine bitmaps or ids from two files.
- Numbering (`numbering.js`), in this order:
  1. Active concepts, walked depth-first over the active hierarchy edges between active concepts.
     The walk is topological: a concept is numbered when the last of its parents has been numbered.
     Roots and siblings are visited in order of (importer sort key, code). Codes made only of
     digits compare numerically. The default sort key is 0. LOINC sorts by kind (term, part, answer
     list, answer, hierarchy node). RxNorm sorts by primary TTY rank and then by ingredient group.
  2. Active concepts that the walk could not reach, in order of (key, code). This needs a cycle,
     and none of the four releases has one.
  3. Inactive concepts, in order of (key, code).

## Invariants (checked at import; the build fails if one is broken)

- `concept.active = 1` exactly when `concept_id <= code_system.active_count`. The `active` set is a
  single range.
- If A is active, every member of `descendants(A)` has an id greater than A. The import counts the
  exceptions for inactive ancestors: there are 0 in all four files.
- `concept.code` is unique.
- Each `concept_set.card` equals the cardinality of its bitmap. Empty sets are not stored, so a
  missing row means an empty set.

## Tables

| table | key | holds |
|---|---|---|
| `code_system` | `id = 1` | `uri`, `version` (as served; for SNOMED the edition version URI), `name`, `edition`, `concept_count`, `active_count` |
| `cs_config` | `key` | provider behaviour as JSON or plain strings. Examples: `defaultLanguage`, `implicitValueSets`, `inverseProperties`, `displayRefsets`, `relaByRel` |
| `concept` | `concept_id` (rowid); unique `code` | `active`, `display`, `definition` |
| `property_def` | `property_id`; unique `code` | `fhir_type`, `value_kind` (`concept` or `literal`), `is_hierarchy` |
| `concept_link` | PK `(source_id, property_id, group_id, target_id, active)`, WITHOUT ROWID | concept-valued facts. Hierarchy links go child → parent. `group_id` is the SNOMED role group. `active = 0` rows are history |
| `concept_literal` | PK `(concept_id, property_id, group_id, value, active)`, WITHOUT ROWID | literal facts. `value` has no column affinity: TEXT, INTEGER/REAL for integer/decimal, 0/1 for boolean |
| `designation` | `designation_id` (rowid, assigned in `concept_id` order); index `(concept_id)` | `language`, `use_id` → `designation_use(system, code, display)`, `term`, `active`, `preferred` |
| `designation_acceptability` | PK `(designation_id, refset_id)` | SNOMED language-refset acceptability. Both ids are concept ids |
| `refset_def`, `refset_member` | PK `(refset_id, concept_id, fields)` | every active member row (v4): `fields` is a JSON array of the source's extra columns (`[]` for a simple refset; codes stay codes), with the row's `effective_time` (YYYYMMDD), `module_id` and `seq` (its position in the source, so rules keep RF2 order). LOINC answer lists have one field, `sequence`: the answer's position in the list |
| `external_map` | PK `(concept_id, system, code)` | LOINC part, answer and IEEE mappings, with R4 equivalence from the target side |
| `alternate_identifier` | PK `(concept_id, scheme_id, identifier)` | SNOMED `sct2_Identifier` |
| `concept_set` | PK `(kind, property_id, value)`, WITHOUT ROWID | `card`, and `data` = run-optimised Roaring bitmap in the `portable` serialisation |
| `search_display`, `search_designation` | FTS5 trigram, contentless | `rowid` = `concept_id` / `designation_id` |
| `provenance` | `key` | importer, sources (name, size, sha256), counts, per-stage timings, peak RSS |

`designation.preferred` means "preferred for its language" as the importer defines it. SNOMED:
Preferred in the US English refset (900000000000509007). LOINC: `LONG_COMMON_NAME` in en-US.
RxNorm: never set.

Facts that are pure inverses are not stored. `cs_config.inverseProperties` names them, and their
values come from prop sets (see below):

- SNOMED and LOINC `child`: the inverse of the hierarchy property.
- LOINC `AnswerList`: the inverse of `Answer` and of `answers-for`.

## Set kinds and keys

| kind | name | `property_id` | `value` | members |
|---|---|---|---|---|
| 1 | all | 0 | 0 | every concept (range `1..concept_count`) |
| 2 | active | 0 | 0 | range `1..active_count` |
| 3 | leaf | 0 | 0 | active concepts with no descendants |
| 4 | descendants | 0 | anchor `concept_id` | proper descendants (the anchor itself is excluded) |
| 5 | prop | `property_id` | target `concept_id` (concept-valued) or the literal value (same type as `concept_literal.value`) | concepts with an active fact `property = value`. Role groups are ignored |
| 6 | hasProp | `property_id` | 0 | union of that property's prop sets |
| 7 | refset | 0 | refset or list `concept_id` | active members of a SNOMED refset, or the answers of a LOINC answer list |

Descendants are built in one of two ways:

- **Edge closure.** By default they are the transitive closure of the active `is_hierarchy` links
  (SNOMED 116680003).
- **Explicit pairs.** An importer that supplies ancestor pairs replaces the edge closure. LOINC does
  this with `PATH_TO_ROOT`. 666 LOINC nodes have more than one parent, so the edge closure would
  give 46,622 codes 130,636 extra (ancestor, descendant) pairs that tx.fhir.org does not serve.

## Questions mapped onto sets

All ids are `concept_id`. `D(x)` is `descendants(x)`, and `P(p, v)` is the prop set.

| question | answer |
|---|---|
| is B subsumed by A (`$subsumes`, `is-a`, `<<`) | `B = A` or `D(A).has(B)` |
| `descendent-of`, `<` | `D(A)` |
| `is-a`, `<<` | `D(A) ∪ {A}` |
| `generalizes`, `>>`, ancestors of B | walk `concept_link` upward from B over `is_hierarchy` links. With explicit pairs (LOINC), keep only the A where `D(A).has(B)` |
| children, `<!` | `P(hierarchy property, A)` |
| `property = value`, `attr = X` (ECL refinement without groups) | `P(p, X)`; `attr = << X` is the OR of `P(p, y)` over `y ∈ {X} ∪ D(X)` |
| `property exists` / `*: attr = *` | `hasProp(p)` |
| `property in` / regex / concrete `> #n` | read the keys `(5, p, v)` (a range scan of the `concept_set` primary key), keep the matching v, OR their sets |
| `inactive = false`, active filter | `active` (a range) |
| leaf / `notSelectable` style questions | `leaf` |
| SNOMED `^ R`, `?fhir_vs=refset/R`; LOINC `http://loinc.org/vs/LL…`, `LIST = L` | `refset(R)` |
| LOINC `answers-for = X` | `refset(L)` when X is a list; otherwise the OR of `refset(L)` over `L ∈ P(answers-for, X)` |
| RxNorm `TTY` / `STY` / `SAB` / RELA `= CUI:x` | `P(TTY, v)` etc.; RELA = `P(rela, x)`. REL = OR over `cs_config.relaByRel[REL]`; a RELA found under several RELs is listed there as its REL-qualified property `<RELA>@<REL>` |
| `$expand` of a filter, paged | evaluate the bitmap, then page with `rangeUint32Array(offset, count)`. This is dense depth-first (hierarchy) order |
| counts (`expansion.total`) | `card` for a stored set; `andCardinality` etc. for a combination |

Role-grouped ECL refinements (`{ a = x, b = y }`) and attribute-group cardinality need the group
facts. Narrow with the sets first, then check `concept_link.group_id` for the candidates.

## Small sets: every set is stored

Most sets are tiny. One-member sets are 36% of the SNOMED sets, 66% of the LOINC sets and 67% of the
RxNorm sets (counted as the rows a threshold of 1 removes).

We measured two options on the four built files. The script is in the report.

- **(a) store all.** Store every set in the compact WITHOUT ROWID table above.
- **(b) threshold T.** Drop the sets with `card <= T` and answer them from reverse indexes
  `concept_link(property_id, target_id, source_id) WHERE active = 1` and
  `concept_literal(property_id, value, concept_id) WHERE active = 1`. Counts for the dropped sets
  are cheap: an index range count of at most T rows.

| file | (a) `concept_set` | (b) T=1 | (b) T=8 | (b) T=64 |
|---|---|---|---|---|
| SNOMED Intl | 19.8 MiB | +20.9 MiB | +15.1 MiB | +12.6 MiB |
| SNOMED US | 20.6 MiB | +17.6 MiB | +11.6 MiB | +9.0 MiB |
| LOINC 2.83 | 11.4 MiB | +19.7 MiB | +17.1 MiB | +16.6 MiB |
| RxNorm | 35.9 MiB | +14.9 MiB | +4.2 MiB | +3.5 MiB |

The (b) columns show the change in whole-file size.

Option (a) is smaller in every case. The two reverse indexes cost 30–49 MiB, which is more than the
5.6–35 MiB of `concept_set` rows they replace. Option (a) is also simpler to explain: one lookup
path, and the count is always `card`. A stored row costs about 25–31 B plus its bitmap; a one-member
bitmap is 18 B.

### v4 (2026-11-02)

- `refset_member` holds every member row, simple refsets included, with `effective_time`, `module_id` and
  `seq`. ECL member filters (`{{ M effectiveTime ... }}`, `moduleId`) read them. International 20260701:
  +15 MiB (refset_member 41 → 57 MiB).
- `concept_normal_form (concept_id, nf)`: the normal form of each active, fully defined SNOMED CT concept
  whose normal form is not just its id, in the minimal compositional grammar, indexed by `nf`. Built at
  import (`sct-native.js buildNormalForms`; 20 s for US 20250901), about 40 MiB per edition (US 20250901:
  152,862 rows, 18 MiB table + 21 MiB index).
- SNOMED CT module dependencies (the ModuleDependency refset, with each row's own module) are in
  `cs_config.moduleDependencies` (edition translation reads them).

