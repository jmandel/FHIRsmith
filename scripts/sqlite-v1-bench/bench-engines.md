# Reproducing the three-engine comparison

All three engines run **in this branch**, selected by the `_engine` parameter.
Results and analysis: `docs/sqlite-v1-engine-comparison.md`.

```sh
cd ~/work/fs2
node scripts/sqlite-v1-bench/bench-engines.mjs \
  scripts/sqlite-v1-bench/engine-bench-queries.json /tmp/results-3engine.json
npx jest tests/tx/sqlite-v1-ir-parity.test.js --runInBand
```

Needs `~/work/tx-dbs/{sct-v1,loinc-v1}.db` (built by the v1 importers).

Notes:
- `_engine=legacy|pushdown|ir` picks the engine; the harness runs all three and
  checks their pages/totals agree.
- total-only (`count:0`) and deep-offset queries make the legacy path throw
  `VALUESET_TOO_COSTLY` — that is the recorded outcome, not a harness error.
