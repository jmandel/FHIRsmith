# sqlite-v1: a normalized SQLite terminology store and its execution engines

This is the primary design document for the `sqlite-v1` work. It explains what
we are building, the principles behind it, how the pieces fit, and the
intuition and rationale for the important decisions. Companion documents hold
the exhaustive detail:

- `sqlite-v1-design.md` — schema DDL rationale, the `cs_config` key registry,
  semantics decisions, the ordering contract, and the **known-divergence
  ledger**.
- `sqlite-v1-engine-comparison.md` — the three-engine (legacy / pushdown / IR)
  controlled benchmark and analysis.
- `sqlite-v1-perf.md` — old-provider vs new-provider performance matrix.
- `sqlite-v1-governor.md` — the runaway-query governor and its fork contract.
- `sqlite-v1-sql-profile.md` — broad SQL-level profiling of the generated
  queries on large vocabularies (where it works, where it breaks down).

---

## 1. The problem

A FHIR terminology server has to answer `$expand`, `$validate-code`, and
`$lookup` over code systems that are wildly different in shape and size:
SNOMED CT (~540k concepts, deep poly-hierarchy, reference sets, ECL), LOINC
(~250k concepts, six-axis parts, answer lists, many languages), RxNorm (~230k
concepts, no hierarchy, dense relationship graph), plus dozens of small
built-in systems.

Historically each big system had its **own storage format and its own query
engine**: SNOMED a hand-packed binary cache read entirely into memory; LOINC
and RxNorm each a bespoke SQLite schema with a provider full of
system-specific SQL. Three formats, three importers, three query engines, three
sets of bugs — and every new capability had to be built three times.

The goal of `sqlite-v1` is **one normalized SQLite store and one generic
provider** that serve all tabular terminologies, with the per-system behavior
expressed as **data**, not code. On top of that store we build a spectrum of
execution strategies for `$expand` — from the stock per-concept path to a
set-algebra IR — that all share one definition of membership and one decoration
surface, so they are provably interchangeable.

---

## 2. Principles

Six ideas carry the whole design. Everything else follows from them.

### 2.1 Behavior is data, not code

The single most important principle. A provider should not contain
`if (system === 'snomed')`. Instead the database carries its own behavior:

- `property_def` rows declare each property's `uri`, FHIR `fhir_type`,
  `value_kind` (concept- vs literal-valued), and whether it `is_hierarchy`.
  From these the provider **derives** `propertyDefinitions()`, which filters it
  supports (`doesFilter`), and how to type `$lookup` output — no per-system code.
- `cs_config` key/value rows declare case sensitivity, default language,
  version algorithm, the hierarchy edge set, the status property, implicit
  value-set URL patterns (SNOMED `?fhir_vs=isa/…`, LOINC answer lists), text
  search surfaces, and more.

The importers own writing this metadata; the provider only reads it. SNOMED's
refsets, LOINC's answer lists, RxNorm's relationship filters — all become
generic operations over generic tables, configured by rows.

**And when behavior genuinely needs code, not data?** Some capabilities cannot
be reduced to a config row — SNOMED CT post-coordinated expressions and ECL need
a parser and an evaluator. Those do **not** become `if (system === 'snomed')`
branches in the generic class. They live in a **subclass**
(`SnomedSqliteCodeSystemProvider extends SqliteCodeSystemProvider`) that owns the
terminology-specific code and calls `super` for everything generic. The factory
selects the subclass **at runtime from the DB's own identity**: each subclass
declares a `static handledSystems = [...baseUris]`, and the factory matches the
database's `code_system.base_uri` against them (no class name is ever stored in
the data; a plain vocabulary matches nothing and gets the generic base). So the
rule is complete: *metadata-driven in the base; a URL-selected subclass for the
irreducibly code-shaped parts* — the generic provider itself stays free of any
per-system branch or hardcoded URI.

**Why it matters:** capability discovery, filter support, and typing stop being
folklore restated per provider and become a single, inspectable, testable fact
about each database.

### 2.2 Land behind the stable contract, not the churny workers

We studied 85 commits of upstream drift. The `CodeSystemProvider` contract
(`tx/cs/cs-api.js`) and the importer framework changed **zero times**; all the
churn was in the workers and the caching/parameter plumbing. So the design
front-loads everything that sits behind the stable provider contract (schema,
importers, provider) and touches the workers as little and as late as possible.
The new provider is adopted per-system through library config, so old and new
providers run side by side and can be compared request-for-request.

**Why it matters:** it minimizes merge pain against a moving upstream and makes
the risky part (worker changes) small and independently reviewable.

### 2.3 One membership definition, three engines

`$expand` can be evaluated three ways in this branch, chosen per request by the
`_engine` parameter:

- **legacy** — the stock per-include, concept-by-concept enumeration.
- **pushdown** — the provider's `processSelection` seam: whole includes/excludes
  evaluated as set algebra with offset/count/total pushdown.
- **ir** — the `tx/engine` IR: the compose is lowered to a set-algebra
  intermediate representation, optimized, partitioned by system, and executed
  through the provider's native `executeIR`/`countForIR`/`membershipForIR`
  terminals.

The critical discipline: **all three compute the same membership** (the same
sorted `concept_id` set algebra) and **all three decorate through the same
`includeCode` path**. The engines differ only in *how* they compute and page a
set, never in *what* the set is or how a concept is rendered. That is what makes
them interchangeable and what makes parity testing meaningful rather than
approximate.

### 2.4 Parity means explained deltas, not bug-for-bug

When the new provider disagrees with the old one, we do not blindly reproduce
the old behavior — some old behavior is buggy (old RxNorm counts a CUI once per
term row; its `isInactive` compares a suppress flag to `'1'` when the column
stores `N`/`O`/`E`, so it never flags suppressed codes; LOINC serves DEPRECATED
codes as active). Every divergence is investigated and recorded in the
**known-divergence ledger** with a root cause: old-bug, deliberate improvement,
or a compatibility shim we added. "Transparent behavior" means *documented*
deltas, not silent bug-compatibility.

### 2.5 Correctness before speed, verified independently

Three independent layers, because no single one proves enough:

1. **Contract fixture tests** — a synthetic terminology exercising every
   provider method (case sensitivity both ways, the full filter protocol,
   typed properties, subsumption, multi-parent).
2. **Source-of-truth verification** — scripts that re-derive expected counts,
   closures, and samples directly from the raw LOINC CSV / RRF / RF2 files with
   their *own* parsers and BFS, deliberately sharing no code with the importers.
3. **Differential parity** — the same operation corpus against old and new
   providers, and across the three engines, with results normalized and diffed.

Only after correctness is established do we measure and optimize.

### 2.6 Governed, or a loud refusal to run ungoverned

A terminology server takes untrusted value-set definitions; some expansions can
be pathologically expensive. The resource governor is binary: either the real
brake is installed (a SQLite progress handler) or, in production, the server
**fails loudly** rather than silently running without bounds. No half-working
cooperative brake that gives false confidence.

---

## 3. Architecture at a glance

```
  raw sources (LOINC CSV, RxNorm RRF, SNOMED RF2)
        │   importers (share one import core)
        ▼
  ┌──────────────────────────────────────────┐
  │  sqlite-v1 database  (one per CS version) │
  │  concept · designation · property_def     │
  │  concept_link · concept_literal · closure │
  │  value_set(_member) · FTS · cs_config     │
  └──────────────────────────────────────────┘
        │   SqliteCodeSystemProvider (metadata-driven)
        ▼
  ┌──────────── one membership definition ────────────┐
  │  sorted concept_id set algebra: union/intersect/   │
  │  diff over closure / property / vs-member sources  │
  └────────────────────────────────────────────────────┘
        │                │                   │
     legacy          pushdown               IR
  (enumerate)   (processSelection)   (tx/engine orchestrator)
        └────────────────┴───────────────────┘
                         │  shared includeCode decoration
                         ▼
                  FHIR expansion
                         ▲
             query governor wraps heavy SQL
             (progress-handler brake or fail-loud)
```

Each layer is developed and committed independently, and each is separately
valuable: the schema+importers alone give a portable store; the provider alone
replaces two bespoke query engines; the pushdown seam alone speeds up
single-system expansion; the IR adds cross-system composition.

---

## 4. The store: a star schema around `concept`

`schema-v1.sql`, `PRAGMA user_version = 2`. The shape is a star: one central
`concept` table, satellites for everything else.

| table | holds | intuition |
|---|---|---|
| `code_system`, `cs_config` | identity, release metadata, behavior rows | the DB describes itself |
| `concept` | code, active, display, definition | the star center; `concept_id` is the internal join identity, `(cs_id, code)` unique |
| `designation` | terms per language + use coding | all the ways to name a concept |
| `property_def` | property registry: uri, fhir_type, value_kind, is_hierarchy | typing + capability, as data |
| `concept_link` | concept-valued properties **and** hierarchy edges | one table for "points at another concept" (parent, SNOMED attributes, RxNorm relations) |
| `concept_literal` | literal properties, raw + typed projections | one table for "has a scalar value" |
| `closure` | transitive closure of hierarchy edges, **no self-rows** | precomputed ancestry for fast is-a/descendent-of |
| `value_set`, `value_set_member` | intrinsic enumerations | SNOMED refsets, LOINC answer lists |
| `search_fts_*` | trigram FTS over display/designations/literals | substring text search |

The load-bearing schema decisions and their rationale:

- **`concept_id` surrogate identity, `(cs_id, code)` unique.** Everything joins
  on the integer id; the code is the external key. One code system version per
  file is the operating convention (matching the factory-per-version
  registration) while the `cs_id` scoping keeps multi-version-per-file possible.
- **Closure stores no self-rows.** `is-a(X)` = X ∪ descendants(X);
  `descendent-of(X)` = descendants(X). The query layer adds the seed for `is-a`.
  This makes the two operators genuinely different (the old LOINC provider
  conflated them — a ledger entry, not a behavior we copy) and halves closure
  size.
- **Hierarchy is just concept-links flagged `is_hierarchy`.** Closure is built
  at import time from those edges. Multi-parent is normal; alternative edge sets
  (SNOMED inferred vs stated) are distinguished by `edge_set_id`.
- **Property typing lives in `property_def`.** `fhir_type` + `value_kind` decide
  which satellite table holds a property and how `$lookup`/`$expand` type it, so
  the provider never hard-codes that a property is an integer or a Coding.
- **Status is normalized twice.** Importers fold source status into
  `concept.active` (so `isInactive` is uniform) *and* preserve the source
  vocabulary as a literal property named by `cs_config statusProperty` (so
  `getStatus` returns the real code).

Grammar systems (UCUM), SNOMED post-coordination, and full ECL are explicitly
out of scope — they do not fit a static-table model; the binary SNOMED provider
remains the engine of record for ECL, while the sqlite SNOMED build covers
enumeration, is-a/descendent-of, refset membership, and property filters.

---

## 5. The generic provider

`SqliteCodeSystemProvider` (+ its factory) implements the existing
`CodeSystemProvider` contract unchanged, so it works with the current workers
as-is. Its defining feature is that **every capability is read from the DB**:
`system`/`version`/`totalCount` from `code_system`; case sensitivity, default
language, version algorithm, hierarchy presence, status semantics from
`cs_config`; property definitions and filter support from `property_def`. A
concept context is fetched once by `locate()` and threaded through the ~ten
accessor calls, so decoration doesn't re-resolve the code.

`SqliteCodeSystemProvider` is the metadata-driven base; the factory instantiates
it — or a registered subclass whose `static handledSystems` includes the DB's
`base_uri` (§2.1). Today that is `SnomedSqliteCodeSystemProvider` for
`http://snomed.info/sct`; every other database gets the base. This is the single
seam where terminology-specific code is allowed, and it is chosen from data, not
configured by hand.

The provider is registered through a new `sqlite:` library source type, so a
server config can run, say, `snomed:` (old, cached) and `sqlite:` (new) for the
same system at once for comparison.

---

## 6. The three engines, and the one idea under all of them

The unifying insight: **a filter, a hierarchy query, or a value-set membership
all reduce to a sorted array of `concept_id`s, and compose is set algebra over
those arrays.** `is-a` is a closure join; a property `=` is a link/literal join;
a refset is a `value_set_member` scan; union/intersect/diff are merges of sorted
arrays. Once you see membership this way, the three engines are three ways to
drive the same algebra.

### 6.1 legacy — enumerate and decorate interleaved

The stock path walks concepts one at a time through the filter protocol,
decorating as it goes, materializing a full list, then paging by slicing at the
end. Correct and general (it handles cross-system, imports, text, everything),
but it cannot answer "give me page 40" or "just the total" without walking
everything first — so deep offsets and total-only requests hit the expansion
limit and fail `too-costly`.

### 6.2 pushdown — the provider does the set algebra

Upstream left a designed-but-empty seam: `handlesSelecting()` /
`processSelection(includes, excludes, excludeInactive, offset, count)`. We
filled it. For a "simple" compose (one system, no imports) the provider takes
the whole includes/excludes, evaluates them as sorted-id set algebra, computes
the exact total from the array, and returns just the requested page. Deep
offsets and total-only requests become cheap; membership stays byte-identical to
legacy. This is the 99% case (single-system filtered value sets) and needs no
new worker engine — `scanValueSet` already routes to the seam.

### 6.3 IR — an algebra you can optimize and partition

The compose is lowered to a small IR: `selector` / `union` / `intersect` /
`diff` / `empty`, where `compose = diff(union(includes), union(excludes))`. A
rewrite pass normalizes and optimizes it (flatten, coalesce, partition a
multi-system diff into per-system pieces), then it is projected per
`(system, version)` bucket and executed through the provider's native terminals:

- `executeIR(subtree, {offset, count})` → a page + exact total,
- `countForIR(subtree)` → a total,
- `membershipForIR(subtree)` → a `has(code)` probe.

Inside the provider these terminals lower a scoped subtree to the same sorted-id
algebra, with a guarded SQL-`LIMIT` fast path for single-selector queries. A
lean orchestrator (no heavy SQL-compiler port) handles cross-system composition;
anything it can't own natively (non-native providers, imports, text) bails
cleanly to legacy.

**Where IR earns its keep, honestly.** Once all three run through the same
worker with the same FHIR decoration, IR ≈ pushdown on decorated pages — because
per-concept decoration (display/designations/properties) dominates a page's
cost, and both pay it identically. Both crush legacy (3–7×) and answer the
requests legacy refuses. IR's genuine edge is **count-only / no-decoration**
paths (`countForIR` is one SQL `COUNT`; pushdown materializes the id array in JS
to size it) and **cross-system** composition. It also fixes a real correctness
gap the old IR draft had: `concept in <refset>` as a *filter* now returns the
right set. The draft's dramatic paged-hierarchy speed lived in a ~64KB SQL-AST
compiler we deliberately did **not** port; that is the honest boundary of this
thin IR — it buys the algebra, cross-system, count speed, and the refset fix,
not the decorated-page speed. See `sqlite-v1-engine-comparison.md`.

---

## 7. The ordering contract

"The original order" is three different things with different standing, so we
tier it:

- **Tier 1 — semantic, must match:** explicit `compose.include.concept` listing
  order; the `sort` parameter; LOINC answer-list sequence. Compared as
  sequences.
- **Tier 1.5 — first-page composition:** the official test suites sort *within*
  a page but multi-page cases implicitly depend on the first page's *contents*
  matching the reference server. So the provider iterates in **source
  (concept_id) order**, which we verified equals each legacy engine's effective
  order (SNOMED numeric SCTID, RxNorm RRF/RXCUI, LOINC CodeKey). This is why the
  IR path cedes multi-*include* composes to pushdown — IR's rewrite merges the
  union and would reorder the first page.
- **Tier 2 — incidental, deliberately not matched:** filter/whole-system
  traversal order is uniform source order, not each legacy engine's accident.
  Compared as sets.

The operator-visible consequence — page composition differs across the old→new
boundary but is stable after it — is documented rather than hidden.

---

## 8. Correctness and how it is proven

Beyond the three verification layers of §2.5, the concrete artifacts:

- Contract fixture suites for the provider and the import core.
- `scripts/sqlite-v1-verify/` — independent source-of-truth checks; 20/20 pass
  on the full LOINC 2.82, RxNorm 05042026, SNOMED US 20260301 imports
  (concept/active counts, sampled closures recomputed by BFS, designation and
  property spot checks, answer-list sequence).
- `tests/tx/sqlite-v1-selection.test.js` — pushdown vs legacy parity (18 cases).
- `tests/tx/sqlite-v1-ir-parity.test.js` — three-engine parity (10 cases);
  pushdown == IR always, == legacy when legacy completes.
- The known-divergence ledger — every old/new delta with a root cause.

The rule throughout: a divergence is either explained in the ledger or it is a
bug to fix; it is never left unexplained.

---

## 9. Performance: where the cost actually lives

Broad SQL profiling on the real vocabularies (`sqlite-v1-sql-profile.md`)
sharpened — and in one place corrected — our intuition:

1. **Decoration dominates a decorated page.** For a 50-row page with full
   properties, the per-concept display/designations/properties cost swamps the
   membership-execution cost. This is why the engines converge on decorated
   pages and why a big lever is decoration batching, not a cleverer membership
   query.
2. **The JS set-merge is essentially free — that was not where the tax lived.**
   `intersect`/`diff`/`union` over 90k–130k sorted `concept_id` arrays cost
   0.4–7.6 ms; for SNOMED closure set-ops the per-clause-SQL-plus-JS path is
   actually *faster* than a single all-SQL `INTERSECT`/`UNION`. The real costs
   are elsewhere:
   - **Literal value filters don't use their index.** The generated predicate
     ORs `value_text … OR value_raw … COLLATE NOCASE`, which defeats both value
     indexes and scans the whole property partition plus a `DISTINCT`
     temp-b-tree — so cost tracks partition size, not selectivity. Splitting
     the OR into a `UNION` of two indexed seeks is the biggest, broadest win
     (measured 5–190×; e.g. LOINC `CLASSTYPE=3` 75 ms → 0.4 ms).
   - **Paging never early-stops.** The single-selector page sorts the full
     membership (`ORDER BY concept_id`) before `LIMIT`; pushing the `LIMIT`
     into the ordered closure/value-set subquery takes a first page from 22 ms
     to ~0.1 ms.
   - **Non-fast paths materialize the full set even for a 100-row page** — and
     `activeOnly` drops off the fast path and forces a full materialize.
   The hierarchy, refset, FTS, and selective concept-property queries are
   already index-tight (a 132k-descendant closure page in 52 ms, its `COUNT` in
   3.7 ms); there is not one un-indexed base-table scan in the matrix. So the
   near-term roadmap is SQL-shape fixes (indexed value seeks, `LIMIT`
   pushdown), not a wholesale port of the draft's SQL-AST.
3. **A few shapes are unbounded and belong to the governor, not the optimizer:**
   literal `regex` (pulls the whole partition into JS to `RegExp.test`),
   `NOT EXISTS`/whole-system scans, `<3`-char text (LIKE fallback), and deep
   offsets. These are the residual the resource governor exists to catch.

The old-vs-new matrix (`sqlite-v1-perf.md`) shows the new provider winning on
the true async-vs-sync comparison (RxNorm: locate 7×, membership probes
1000×+, search 35×), with a smaller RxNorm DB (472 MB vs 1.8 GB). LOINC
micro-ops are slower *by design* — the old LOINC provider holds all concepts in
RAM; the new one is disk-backed with bounded memory.

---

## 10. Resource governance

The governor bounds a single expansion so it cannot burn a worker without limit.
There is exactly one mechanism that actually stops a running SQLite statement:
the **progress handler**, which fires every N VM opcodes regardless of query
shape and, on a truthy return, aborts with `SQLITE_INTERRUPT` — reclaiming
resources mid-query and enforcing a true opcode budget. Stock `better-sqlite3`
doesn't expose it; a custom build must (contract in `sqlite-v1-governor.md`).

We rejected a cooperative fallback (injecting a `governor()` function into query
WHEREs): the planner can hoist it, its placement couples to every query shape,
and it never sees a sort-bomb — false confidence. We also rejected
`worker.terminate()`: it can't preempt an in-progress native call, so the
runaway keeps burning CPU after the caller gives up. So the governor is binary,
by policy: `require` (production) fails loudly if the governed build is absent;
`prefer`/`off` run ungoverned for dev/test.

**Prevention is the first line.** The governor handles the residual; the SQL
profiling identifies the shapes that go quadratic / full-scan / materialize-huge
so the engine can cap or reshape them before executing — the most reliable lever,
and it needs no fork.

---

## 11. Migration and adoption

Three independent dials, adopted in order:

1. **Per-system config** — a `sqlite:` source runs the new provider alongside the
   old one under unchanged workers; the parity harness compares them.
2. **Pushdown** — `handlesSelecting()` engages the provider seam for simple
   composes; toggleable, byte-identical membership.
3. **`_engine=ir`** — opt-in IR routing, folded into the expansion cache key so
   engines don't cross-contaminate cached results.

At every dial the fallback is the previous, proven path, and the divergence
ledger records any observable difference.

---

## 12. Deliberately out of scope (and why)

- The IR **SQL-AST strategy compiler** (the draft's ~64KB) — where the paged
  speed lived; omitted to keep the port thin and reviewable. Future work if the
  decorated-page or JS-materialization numbers justify it.
- **Native supplement sidecars** — the overlay path suffices; the dual native/JS
  supplement machinery doubles the test surface.
- **Non-native IR execution** (generic executor + legacy adapter) — the
  orchestrator bails to legacy for non-sqlite providers instead.
- **CPT / NLM-gated imports** — staged as follow-ups; draft loaders exist.

Since the first draft of this doc, three items listed here as out of scope were
brought **in**: SNOMED **ECL** and **post-coordinated expressions** are now
evaluated by the sqlite provider itself (against `closure` / `concept_link` /
`value_set_member`, reusing the existing parsers — see `sqlite-v1-conformance.md`),
and the **binary-cache→v1 fixture converter** (`import-sct-cache-sqlite-v1`) is
built and is what produces the SNOMED conformance fixtures. What still remains
with the binary provider are the ECL/expression corners neither side needs here
(reverse attributes, `!=` refinements, numeric/string comparison) — the sqlite
provider raises the same informative "unsupported" the binary one does.

---

## 13. Summary

`sqlite-v1` replaces three bespoke terminology stores and query engines with one
normalized SQLite schema whose behavior is data, one metadata-driven provider,
and a spectrum of `$expand` engines that share a single membership definition
and decoration surface. It lands behind the stable provider contract to survive
upstream churn, proves itself against independent source-of-truth checks and a
divergence ledger rather than bug-compatibility, and bounds runaway queries with
a real progress-handler brake or a loud refusal to run ungoverned. The result is
a smaller, faster, inspectable foundation on which the remaining performance
(pushing set algebra fully into SQL) and coverage (ECL, supplements, more
editions) can be grown incrementally, each step measured and reversible.
