# v0 SQLite Perf Snapshot (2026-03-04)

Checked-in artifacts for IR vs legacy perf comparison where both paths
use the same v0 SQLite providers.

## Generation command

```bash
scripts/run-ir-harness.sh \
  --perf \
  --db-dir /home/jmandel/hobby/sct/cache \
  --out-dir tmp/ir-harness-runs/20260304-v0-perf \
  --perf-out tmp/ir-harness-runs/20260304-v0-perf/perf-table.html
```

This snapshot is generated from the full IR harness suite (166 tests).

## Included artifacts

- `perf-table.html`
- `perf-table.details/*.html`

Excluded on purpose:
- server logs
- runtime `data/terminology-cache/` downloads
- temporary harness run directories
