# Unified TX Harness 3-column snapshot

This snapshot was generated from the unified TX harness and includes the current
shared operation corpus for:

- `$expand`
- `$lookup`
- `$validate-code`

Generation command:

```bash
node scripts/tx-harness.mjs \
  --perf \
  --perf-third-upstream \
  --perf-runs 1 \
  --db-dir /home/jmandel/hobby/sct/cache \
  --upstream-db-dir /home/jmandel/hobby/FHIRsmith-ir-engine/data/terminology-cache \
  --out-dir docs/perf/tx-harness-20260311-3col
```

Notes:

- third column is the local upstream-style comparison stack
- synthetic supplement rows are included by default in perf mode
- checked-in artifacts include the HTML matrix, catalog, failures file, inputs, details, and perf log
