# Unified TX Harness 3-column snapshot

This snapshot was generated from the unified TX harness and includes the current
branch-relevant operation corpus:

- `$expand`
- `$lookup`
- `$validate-code`

Corpus size:

- `271` rows total
- `199` `$expand`
- `25` `$lookup`
- `47` `$validate-code`

Generation command:

```bash
node scripts/tx-harness.mjs \
  --perf \
  --perf-third-upstream \
  --perf-runs 1 \
  --db-dir /home/jmandel/hobby/sct/cache \
  --upstream-db-dir /home/jmandel/hobby/FHIRsmith/data/terminology-cache \
  --out-dir docs/perf/tx-harness-20260309-3col
```

Notes:

- third column is the local upstream-style comparison stack
- synthetic supplement rows are included by default in perf mode
- only report artifacts are checked in here: the HTML matrix, catalog, inputs, and details
