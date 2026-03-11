# TX Review Workflow

This note documents the workflow for turning a fresh harness run into
agent-reviewable analysis packages.

Use it when you want to:

- run a fresh 3-column terminology matrix
- package saved inputs and outputs into per-issue folders
- run external CLI agents over those folders
- capture adjudication reports back into the repo workflow

## Overview

The flow is:

1. run a fresh harness matrix
2. analyze the saved row outputs for semantic differences
3. package selected rows into a review batch
4. run an external agent over each issue folder
5. convert good adjudications into `review` markers or code fixes

Important:

- a review batch is a snapshot of one harness run
- if code changes after the run, the batch does not auto-refresh
- rerun the harness and rebuild the batch when you want current evidence

## 1. Run a fresh harness matrix

For the full 3-column comparison across `$expand`, `$lookup`, and
`$validate-code`:

```bash
node scripts/tx-harness.mjs \
  --perf \
  --perf-third-upstream \
  --db-dir /home/jmandel/hobby/sct/cache \
  --upstream-db-dir /home/jmandel/hobby/FHIRsmith-ir-engine/data/terminology-cache \
  --out-dir tmp/tx-harness-runs/my-run
```

The run directory will contain:

- `perf-table.html`
- `perf-table.catalog.json`
- `perf-table.inputs/`
- `perf-table.details/`
- `perf-table.failures.json`
- `harness-perf.log`

The HTML table is useful for browsing, but the JSON artifacts are the
source for downstream analysis packaging.

## 2. Analyze the run

The diff analyzer reads the saved detail JSON and classifies cross-target
differences:

```bash
node scripts/analyze-tx-harness-diffs.mjs tmp/tx-harness-runs/my-run
```

Useful variants:

```bash
node scripts/analyze-tx-harness-diffs.mjs tmp/tx-harness-runs/my-run --kind validate
node scripts/analyze-tx-harness-diffs.mjs tmp/tx-harness-runs/my-run --unreviewed
node scripts/analyze-tx-harness-diffs.mjs tmp/tx-harness-runs/my-run --include-aligned --unreviewed --json
```

Notes:

- `--unreviewed` filters out rows that already carry a `review` marker in
  the harness case definitions
- `--include-aligned` keeps rows that are semantically aligned but still
  worth reviewing, for example to confirm unsupported-path noise or route
  parity
- without `--include-aligned`, the source set is focused on divergent rows

## 3. Build a review batch

Package selected rows into per-issue folders with prompts, saved inputs,
and saved outputs:

```bash
node scripts/build-tx-review-batch.mjs tmp/tx-harness-runs/my-run \
  --unreviewed \
  --include-aligned \
  --limit 9999 \
  --out-dir tmp/tx-review-batches/my-batch \
  --batch-name my-batch
```

Useful variants:

```bash
node scripts/build-tx-review-batch.mjs tmp/tx-harness-runs/my-run --kind lookup,validate --unreviewed --limit 9999
node scripts/build-tx-review-batch.mjs tmp/tx-harness-runs/my-run --flag issue-text-mismatch --unreviewed
node scripts/build-tx-review-batch.mjs tmp/tx-harness-runs/my-run --ids 205,227,270
```

The generated batch contains:

- `manifest.json`
- `selected-analysis.json`
- `README.md`
- `run-agents.sh`
- `run-with-copilot.sh`
- `issues/<row-id>-<slug>/...`

Each issue folder contains:

- `issue.json`
- `input.json`
- `detail.json`
- `detail.html`
- `request-source.json`
- `outputs/<target>/summary.json`
- `outputs/<target>/request.json`
- `outputs/<target>/response.json`
- `outputs/<target>/trace.json` when available
- `outputs/<target>/plan.txt` when available
- `prompt.md`
- `report-template.md`

`report.md` is not precreated. The external agent is expected to create
or update it.

## 4. Run external agents

Every batch gets a generic runner and a Copilot-specific wrapper.

Copilot wrapper:

```bash
./tmp/tx-review-batches/my-batch/run-with-copilot.sh --parallel 4
```

The generated wrapper currently runs:

```bash
copilot --model claude-sonnet-4.6 --yolo --no-ask-user --no-custom-instructions < prompt.md
```

from inside each issue directory, so the agent can create `report.md`
with its own file tools.

Generic runner:

```bash
./scripts/run-tx-review-agent-batch.sh tmp/tx-review-batches/my-batch \
  --parallel 4 \
  --cmd 'copilot --model claude-sonnet-4.6 --yolo --no-ask-user --no-custom-instructions < prompt.md'
```

Useful runner options:

- `--parallel <n>` controls concurrency
- `--only <csv>` restricts to specific row ids or issue prefixes
- `--force` reruns folders with an existing non-empty `report.md`
- `--dry-run` prints the expanded command without executing it

Examples:

```bash
./tmp/tx-review-batches/my-batch/run-with-copilot.sh --only 205,227 --parallel 2
./tmp/tx-review-batches/my-batch/run-with-copilot.sh --parallel 6 --force
./tmp/tx-review-batches/my-batch/run-with-copilot.sh --dry-run --only 270,280
```

## 5. Read and apply adjudications

The external reports are advisory. They still need local review.

Typical outcomes:

- add a `review` marker to the harness case when IR is clearly preferred
- mark a row reviewed as `no meaningful difference`
- leave a row unreviewed when the policy is still undecided
- fix a real code bug and rerun the affected cases

Good reports usually answer:

- is the difference actually meaningful?
- which target is preferred, if any?
- what does `tx.fhir.org` do?
- what does `build.fhir.org` imply?
- is the row suitable for future automatic adjudication?

## Practical guidance

- prefer building batches from fresh runs after code changes
- do not trust an old `report.md` if the source run predates a behavior fix
- use `--unreviewed` for new batches so review markers remove settled rows
- include aligned rows only when you want broader route/support review, not
  just semantic diff triage
- if a row is fenced `engines: ['ir']`, it will not tell you anything about
  legacy or upstream columns until that fence is removed and the harness is
  rerun

## Related files

- [testing.md](testing.md)
- [tx-harness-plan.md](tx-harness-plan.md)
- [scripts/tx-harness.mjs](../scripts/tx-harness.mjs)
- [scripts/analyze-tx-harness-diffs.mjs](../scripts/analyze-tx-harness-diffs.mjs)
- [scripts/build-tx-review-batch.mjs](../scripts/build-tx-review-batch.mjs)
- [scripts/run-tx-review-agent-batch.sh](../scripts/run-tx-review-agent-batch.sh)
