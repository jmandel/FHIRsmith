# sqlite-v1 parity harness

Differential parity harness comparing the **OLD** hand-written terminology
providers (`tx/cs/cs-rxnorm.js`, `tx/cs/cs-loinc.js`) against the **NEW** generic
sqlite-v1 provider (`tx/cs/cs-sqlite.js`).

**The harness only REPORTS divergences. It never decides whether a divergence is
acceptable, and it never weakens a comparison to make it pass.** A human
adjudicates every diff. Do not "fix" a reported divergence in the harness —
fix (or accept) it in the importer/provider, or record it as expected.

## Running

```
node scripts/sqlite-v1-parity/parity-provider.mjs --pair rxnorm|loinc \
     [--samples 40] [--seed 42] [--json /tmp/out.json]
```

- `--pair`   which terminology to compare (required).
- `--samples` number of concepts sampled from the NEW db `concept` table
  (default 40). Hand-picked well-known codes are always added on top.
- `--seed`   PRNG seed for reproducible sampling (default 42, mulberry32).
- `--json`   write the full structured report to this path (session scratch;
  not a repo file). stdout always gets the human summary.

Databases are read from `~/work/tx-dbs/{rxnorm,loinc}-{old,v1}.db`. The OLD
factories open the RRF/Pascal-shaped DB; the NEW factory opens the sqlite-v1 DB.
Both providers are built with a fresh `OperationContext('en', i18n)` and the
`LanguageDefinitions.fromFiles('tx/data')` + `I18nSupport('translations', …)`
setup used by the jest tests.

## Corpus

Each comparison yields one of these outcomes:

| Outcome     | Meaning                                                        |
|-------------|----------------------------------------------------------------|
| `EXACT`     | byte-for-byte / value-for-value equal                          |
| `NORM`      | equal only after a normalization rule (rule named in output)   |
| `DIVERGENT` | genuinely different — up to 10 concrete examples shown          |
| `TIMEOUT`   | a filter exceeded the 120s per-filter wall-time cap            |
| `ERROR`     | the provider threw; first stack line recorded                 |

Sections:

- **A. Metadata** — `system`, `version`, `totalCount` (awaited), `hasParents`,
  `isCaseSensitive`, `defLang`; and `propertyDefinitions` compared as *sets of
  property codes* (codes only-in-old / only-in-new).
- **B. Sampled concepts** — N seeded samples + hand-picked codes
  (RxNorm: `1191`, `197361`, `105078`, `311036`, `860975`;
  LOINC: `2160-0`, `718-7`, `LP14082-9`, `LA6115-9`, `LL1162-8`). For each:
  locate hit/miss, `code()`, `display()`, `definition()`, `isInactive()`,
  `getStatus()`, `designations()` (multiset of `(language, use_code, term)`
  collected via the `Designations` class), and `properties()` normalized to
  `{code: sorted [stringified primitive values]}`.
- **C. Not-found** — 3 bogus codes: compares whether `context` is null and
  whether `message` is non-empty. **Message text is never compared.**
- **D. Filters** — result **code-SETS** compared exactly (size + symmetric
  difference samples; sha256 of sorted codes when the combined set is huge).
  Executes the OLD filter protocol faithfully:
  `getPrepContext(true)` → `filter(...)`/`searchFilter(...)` →
  `executeFilters` → iterate ALL results via `filterMore`/`filterConcept`,
  collecting `code()`. 120s wall-time cap per filter (reported as `TIMEOUT`).
- **E. Subsumption** (LOINC only) — `subsumesTest` on 5 ancestor→descendant
  pairs from the old `Closure` table, 2 arbitrary (likely unrelated) pairs, and
  1 equal pair.
- **F. Iteration** — `iteratorAll().total` (or count by exhausting up to 500k)
  and `iterator(null)` root count. Each side is wrapped independently so a
  provider that throws on `iteratorAll()` (e.g. old RxNorm, which does not
  override it) is recorded as an `ERROR` value, not a section crash.

### Filter value-form probing

Some OLD filters require a specific value syntax that the NEW provider does not
(and vice-versa). **Accepted-form differences ARE divergences.** Where known,
the harness probes both forms against both providers and reports each:

- RxNorm relationship filters: OLD requires a `CUI:<cui>` / `AUI:<aui>` prefix;
  NEW treats the value as a raw target concept code. Both forms are run.
- LOINC `CLASSTYPE`: probed as both `1` and `Laboratory`.

## Normalization rules (applied symmetrically)

1. **trim** — leading/trailing whitespace stripped from string scalars before
   comparison. A pair equal only after trimming is reported `NORM [trim]`.
2. **numeric** — a number and a numeric string that parse to the same `Number`
   compare equal (`NORM [numeric/boolean-normalize]`). Applied to scalars and to
   property values.
3. **boolean** — `'Y'`/`'true'`/`'1'`/`true` all map to true; `'N'`/`'false'`/
   `'0'`/`false` map to false; equal after mapping is `NORM`.
4. **designation use_code** — compared **RAW first**. If raw diverges, a second
   **mapped** comparison collapses the display-use coding
   (`preferredForLanguage`) to the token `DISPLAY` and reduces the language tag
   to its primary subtag (`en-US` → `en`). Both raw and mapped outcomes are
   reported. (Old LOINC `LONG_COMMON_NAME` vs new `LONG_COMMON_NAME` are
   expected equal; SNOMED use-codes are out of scope.)
5. **property CODE SETS are compared RAW.** Extra properties present only in the
   new provider (e.g. relationship properties, `TTY`/`STY`/`SAB`) are reported
   once as set differences (`codesOnlyNew`), not as per-concept noise. Per-code
   *values* (for codes present in both) use the numeric/boolean rules above.

## Reading the output

- The `[A]`–`[F]` blocks on stdout are the human summary. `--json` has the full
  detail (every sampled concept, every filter set size, all examples).
- In `[B]`, each metric shows an aggregate count line
  (`EXACT=… NORM=… DIVERGENT=…`) followed by up to 10 concrete divergence
  examples per metric.
- In `[D]`, `|old|`/`|new|` are set sizes; `onlyOld`/`onlyNew` are symmetric
  difference counts with up to 10 sample codes each.
- A **harness bug** (as opposed to a real divergence) looks like: symmetric 100%
  divergence on a filter both providers clearly support, an `ERROR` outcome from
  the harness's own driver, or an empty old-side set for a filter the old
  provider definitely supports. Investigate those before trusting the diff.
  Real divergences (different display picking, different counts, different
  accepted value forms) are the point — leave them reported.
