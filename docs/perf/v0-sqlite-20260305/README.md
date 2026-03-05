# v0 SQLite Perf Snapshot (2026-03-05)

Checked-in artifacts for the 3-column perf comparison:

- IR Branch + New Expander
- IR Branch + Upstream Expander
- Upstream Providers + Upstream Expander

## Generation command

```bash
scripts/run-ir-harness.sh \
  --perf \
  --perf-third-upstream \
  --db-dir /home/jmandel/hobby/sct/cache \
  --upstream-db-dir /home/jmandel/hobby/FHIRsmith/data/terminology-cache \
  --out-dir docs/perf/v0-sqlite-20260305 \
  --perf-out docs/perf/v0-sqlite-20260305/perf-table.html
```

This snapshot is generated from the full IR harness suite (166 tests).

## Included artifacts

- `perf-table.html`
- `perf-table.catalog.json`
- `perf-table.details/*.html`
- `perf-table.inputs/*.json`

Excluded on purpose:

- server logs
- harness run logs
- temporary capture directories (`data/`, `data-third/`)
