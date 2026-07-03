# Reproducing the three-engine comparison

Results and analysis: `docs/sqlite-v1-engine-comparison.md`.

## legacy vs pushdown (this branch)

Both run in this PR against the sqlite-v1 DBs; the same `cs-sqlite` provider is
toggled between paths via `handlesSelecting()`.

```sh
cd ~/work/fs2
node scripts/sqlite-v1-bench/bench-legacy-pushdown.mjs \
  scripts/sqlite-v1-bench/engine-bench-queries.json /tmp/results-legacy-pushdown.json
```
Needs `~/work/tx-dbs/{sct-v1,loinc-v1}.db` (produced by the v1 importers).

## IR (separate draft branch)

The IR engine is NOT in this PR. `bench-ir.mjs.reference` is the exact script
used, kept for reproducibility; run it from the `ir-sqlite-v0-pr-ready` checkout
against content-matched v0 DBs:

```sh
cd ~/hobby/fhirsmith-ir-pr
node /path/to/bench-ir.mjs.reference \
  ~/work/fs2/scripts/sqlite-v1-bench/engine-bench-queries.json /tmp/results-ir.json
```
Needs the v0-schema DBs (`snomed-2026us-v0.db`, `loinc-v0.db`).

## Notes
- Same query file drives all three, so totals cross-check across schemas/engines.
- total-only (`count:0`) and deep-offset queries make the legacy path throw
  `VALUESET_TOO_COSTLY` — that is the recorded outcome, not a harness error.
