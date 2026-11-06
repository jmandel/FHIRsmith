# Display regex on SNOMED CT: cost and the trigram prefilter

**Adopted** (2026-11-02): merged into `sqlite-v2-provider` and deployed on the demo, whose
defaults are unchanged (International 20250201). Prototyped on branch `sqlite-v2-regex`, measured 2026-11-02 on SNOMED CT International 20250201: 519,624
concepts and 1,675,759 designations, of which 1,369,669 are active.

## What the engine does

- **Column.** `display regex` tests `concept.display`: the preferred display, one row per concept,
  in the file's display language. Other designations are not tested. That is the R5 `designation`
  filter, below.
- **Regex.** RE2, through upstream's `library/regex-utilities` (re2js, pure JavaScript). It finds
  the pattern anywhere in the value, as main does.
- **Before.**
  - A paged request scanned concepts in id order, 4,096 at a time, until it had offset + count
    matches. The total was given only if the scan reached the end.
  - `count = 0` asked for 0 matches, so it returned at once with no total. That was a planner
    gap, not the design.
  - A deep page past the last match scanned all 519,624 rows (about 550 ms).
  - `valueset-unclosed` is SNOMED CT's usual flag (the system is not closed), not a sign of
    laziness.
- **Where a full scan's time went** (in process, best of 3):
  - SQLite row iteration: 390 ms (286 ms as raw arrays).
  - RE2 over the rows: 95–118 ms for `^Diabetes.*`, `^Fracture of.*femur.*` and
    `.*[Tt]umou?r.*`; 660 ms for `.*e.*`.
  - V8's own RegExp is faster on `.*e.*` (66 ms) and slower on `.*[Tt]umou?r.*` (803 ms,
    backtracking). It has no linear-time guarantee, so it was not used.

## The change

1. **Trigram prefilter (option 1).**
   - `engine/regex-literals.js` extracts the literals every match must contain, codesearch-style,
     and conservatively: no literal is extracted under a top-level alternation, or inside a class,
     an optional atom or a group.
   - A literal of 3 or more characters is looked up in the FTS5 trigram index on displays
     (`search_display`). Every file already has this index, 54 MiB for International.
   - RE2 then runs on those candidates only. The index is case-insensitive, so the candidate set
     is a superset, and RE2 semantics are unchanged. RE2 makes every decision; the index only
     narrows what it is shown.
   - Checks:
     - full result sets on International for 8 patterns;
     - `tests/tx/sqlite-v2-regex.test.js`:
       - literal extraction (alternation, classes, escapes, anchors, groups, quantifiers, and
         patterns with no 3-character literal, which get no prefilter);
       - soundness against RE2 on sample strings;
       - prefilter on = off = RE2 over every display, on a built fixture and on the SNOMED CT
         test edition (RF2 in `tx/data/snomed`).
     - These tests found one bug before the merge: a class escape's quantifier (`\d+`) was read
       as a literal. It is fixed.
2. **The whole match set per request (option 3).**
   - A prefiltered regex is evaluated whole: exact total, any page, from one bitmap. Nothing is
     cached across requests.
   - `count = 0` is evaluated whole too, so it reports the exact total.
   - A pattern with no usable literal still goes lazy for pages with `count` > 0.
3. **Cheaper full scans.**
   - A leading or trailing `.*` is dropped (`.*e.*` becomes `e`), which gives the same
     find-anywhere result.
   - Rows are iterated raw.
   - `.*e.*` full count: 1,146 ms down to 650 ms.

Cost: about 220 lines (`regex-literals.js` is 147 of them, with tests in addition). There is no
import change and no new index.

**Not prototyped: a native regex in SQLite (option 2).**
- sqlean's `regexp` (MIT) is built on PCRE2 (BSD). That is a backtracking flavour, unlike RE2, so
  it brings ReDoS exposure and different semantics.
- It would mean shipping a per-platform `.so`/`.dylib`/`.dll` (glibc and musl, x64 and arm64,
  macOS, Windows) and loading it with better-sqlite3's `loadExtension`.
- It would save at most the JavaScript per-row cost. SQLite's iteration alone is 286–390 ms of
  the worst case. With the prefilter, only literal-free patterns like `.*e.*` would still gain.

## Server time, ms (trace, `_trace=cold`: first run / median of the next 2)

| pattern | page | demo VM, before | local, before | total before | local, after | total after | rows read before → after | demo VM, after |
|---|---|---|---|---|---|---|---|---|
| `.*[Tt]umou?r.*` | first (count 20) | 92 / 61 | 95 / 52 | — | 58 / 15 | 2,990 | 40,981 → 9,350 | 62 / 264 |
| `.*[Tt]umou?r.*` | deep (offset 5,000, count 20) | 557 / 529 | 606 / 583 | 2,990 | 14 / 14 | 2,990 | 519,625 → 9,330 | 14 / 23 |
| `.*[Tt]umou?r.*` | count = 0 | 5.1 / 7.7 | 5.1 / 5.0 | — | 14 / 14 | 2,990 | 4,097 → 9,330 | 21 / 21 |
| `.*e.*` | first (count 20) | 8.0 / 17 | 8.8 / 8.8 | — | 9.7 / 7.6 | — | 4,117 → 4,117 | 22 / 19 |
| `.*e.*` | deep (offset 5,000, count 20) | 37 / 17 | 18 / 18 | — | 13 / 13 | — | 8,213 → 8,213 | 18 / 22 |
| `.*e.*` | count = 0 | 13 / 8.0 | 9.0 / 8.4 | — | 627 / 628 | 473,205 | 4,097 → 519,624 | 628 / 651 |
| `^Fracture of.*femur.*` | first (count 20) | 257 / 257 | 279 / 278 | — | 6.3 / 4.6 | 30 | 266,261 → 470 | 16 / 12 |
| `^Fracture of.*femur.*` | deep (offset 5,000, count 20) | 496 / 498 | 541 / 552 | 30 | 4.2 / 4.2 | 30 | 519,625 → 450 | 11 / 4.8 |
| `^Fracture of.*femur.*` | count = 0 | 4.5 / 10 | 5.0 / 4.8 | — | 4.2 / 4.2 | 30 | 4,097 → 450 | 11 / 8.7 |
| `^Diabetes.*` | first (count 20) | 143 / 133 | 147 / 145 | — | 5.2 / 3.7 | 187 | 139,285 → 2,046 | 6.0 / 11 |
| `^Diabetes.*` | deep (offset 5,000, count 20) | 513 / 452 | 548 / 543 | 187 | 3.2 / 3.3 | 187 | 519,625 → 2,026 | 3.7 / 5.3 |
| `^Diabetes.*` | count = 0 | 10 / 10 | 5.0 / 4.8 | — | 3.2 / 3.2 | 187 | 4,097 → 2,026 | 4.0 / 6.1 |
| `is-a 404684003` + `.*[Tt]umou?r.*` | first (count 20) | 14 / 16 | 10 / 10 | — | 16 / 16 | 1,065 | 8,215 → 9,353 | 28 / 22 |
| `is-a 404684003` + `.*[Tt]umou?r.*` | deep (offset 5,000, count 20) | 151 / 134 | 142 / 140 | 1,065 | 17 / 16 | 1,065 | 124,415 → 9,333 | 12 / 27 |
| `is-a 404684003` + `.*[Tt]umou?r.*` | count = 0 | 4.5 / 9.6 | 5.3 / 5.1 | — | 16 / 16 | 1,065 | 4,099 → 9,333 | 16 / 20 |

All runs were taken under `MEASURE.lock`:
- local before: load 1.22, 23.7 GB free;
- local after: load 0.61, 23.5 GB free;
- demo VM: load 0.54 before and 0.39 after.

On the VM, single requests now and then take 0.3–0.5 s (the 264 ms warm median above). Of 6 more
first-page runs of `.*[Tt]umou?r.*`, five took 12–33 ms and one took 458 ms. The VM also runs a
VSAC sync, and these spikes did not occur locally; GC or I/O there is likely, but it was not
traced.

`count = 0` is the full-count cost. The catalog replay is unchanged after the merge: against tx.fhir.org's references, 106 match,
36 improved, 2 both refuse, 15 documented, 0 DIFF, on the local server and on the demo. The
display-regex entries are "improved", since main refuses them.

The `.*e.*` deep page stays lazy: its 473,205 matches leave
no literal to use, and offset 5,020 is reached after about 8,000 rows.

## All designations instead of the display

The R5 `designation regex` filter tests the display and every active designation. Without a
prefilter (this branch does not add one yet) it reads the designation table:

| pattern | first page | deep page | count = 0 |
|---|---|---|---|
| `.*[Tt]umou?r.*` (4,679 concepts) | 267 / 223 ms | 4,199 / 4,108 ms | 2,021 / 2,026 ms |
| `^Fracture of.*femur.*` (31 concepts) | 2,097 / 2,113 ms | 4,087 / 4,089 ms | 1,893 / 1,936 ms |

That is about 3.2× the rows of the display alone. `search_designation` is also a trigram index,
so the same prefilter applies; that is the obvious next step.

## SNOMED CT: descriptions in one language, whole term (2026-11-02)

The tx-ecosystem requirement (adc5616) redefines SNOMED CT `display regex`:
- **What is searched:** every active FSN and synonym in one language, chosen as `displayLanguage`,
  else `Accept-Language`, else the edition default.
- **How it matches:** the whole term, case-sensitively.

sqlite-v2 now implements this. The trigram prefilter moves to `search_designation`. Server time
on International 20250201 (1,675,759 designations), in ms, first run / median of the next 2:

| pattern | first page | deep page (offset 5,000) | count = 0 (total) |
|---|---|---|---|
| `.*[Tt]umou?r.*` | 66 / 53 | 51 / 48 | 48 / 48 (4,593) |
| `.*e.*` (no literal) | 20 / 15 | 30 / 30 | 2,016 / 2,058 (520,966) |
| `^Fracture of.*femur.*` | 13 / 11 | 11 / 10 | 10 / 12 (31) |
| `^Diabetes.*` | 46 / 10 | 9 / 9 | 9 / 9 (235) |
| `is-a 404684003` + `.*[Tt]umou?r.*` | 59 / 52 | 45 / 45 | 50 / 47 (2,060) |

- Totals are larger than with the display alone, because synonyms count: 4,593 concepts against
  2,990 for the tumour pattern.
- The literal-free full count reads 1.42 million descriptions (2.0 s, against 0.65 s for displays
  only). This is the cost the requirement's one-language rule limits.

All five tests pass on the test edition rebuilt from the new RF2: `expand-display-regex`, `-nl`,
`validate-code-display-regex`, and the ECL description-filter wildcard tests in all languages and
in `nl`.

## Every regex matches the whole value (2026-11-02)

- **What the tests require.** Every regex test in the tx-ecosystem suite (adc5616) is consistent
  with whole-term matching. Six require it:
  - `simple-expand-regex` and `simple-expand-regex2`: `[^ \t\r\n\f]{4}[0-9]` gives code1,
    code2 and code3, not code2a…;
  - `validation-simple-code-bad-regex`: code2a is not in the set;
  - `expand-regex-bad`, `expand-regex-bad-2` and `validate-regex-bad-2`: `(a+)+` matches only
    the code that is all a's.

  None requires match-anywhere. The LOINC CLASS tests pass either way, because their pattern
  anchors `^PATH` and `^MOLPATH` itself.
- **Main.** The FHIR CodeSystem and country providers anchor, with a precedence bug for
  alternation (fixed: U23). LOINC finds anywhere, and SNOMED CT refuses display regex.
- **sqlite-v2.** Every regex filter now tests `^(?:P)$`, one rule for all systems. The prefilter is
  unchanged: the literals of a whole-term match are the same.
