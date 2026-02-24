# Expand v3 perf problem statement (default vs baseline)

Date: 2026-02-24

## Goal

Understand why `default` optimization profile can underperform `baseline` on some `$expand` requests, especially with supplement-backed property retrieval.

## Repro workloads

All runs used:
- `count=1000`
- `offset=0`
- `impl=v3`

Queries:
1. `LOINC STATUS=ACTIVE` (no supplement)
2. `LOINC d20=1` (supplement filter only)
3. `LOINC d20=1` + request `property=d20`

Supplement canonical used:
- `http://example.org/fhir/CodeSystem/supplement-loinc-d20|2026.02`

Raw traces captured under:
- `/tmp/v3perf/*.trace.json`
- `/tmp/v3perf/*.run.json`

## Measured results

| Query | Profile | wall ms | trace total ms | sql ms | non-sql ms |
|---|---:|---:|---:|---:|---:|
| LOINC STATUS=ACTIVE | default | 226 | 226.38 | 193.30 | 33.08 |
| LOINC STATUS=ACTIVE | baseline | 217 | 217.06 | 165.44 | 51.62 |
| LOINC STATUS=ACTIVE | no-decorate-many | 235 | 234.47 | 199.61 | 34.86 |
| LOINC d20=1 | default | 252 | 252.36 | 230.52 | 21.84 |
| LOINC d20=1 | baseline | 299 | 299.02 | 261.50 | 37.52 |
| LOINC d20=1 | no-decorate-many | 272 | 271.97 | 248.26 | 23.71 |
| LOINC d20=1 + property=d20 | default | 546 | 546.00 | 252.77 | 293.23 |
| LOINC d20=1 + property=d20 | baseline | 337 | 336.77 | 231.38 | 105.39 |
| LOINC d20=1 + property=d20 | no-decorate-many | 363 | 363.29 | 257.27 | 106.02 |

## Key observation

The regression is concentrated in:
- `LOINC d20=1 + property=d20`
- `default` profile only

SQL time is not the cause (252.77 ms default vs 231.38 ms baseline).
The extra cost is JS/non-SQL (`~293 ms` vs `~105 ms`).

`no-decorate-many` nearly matches baseline in this case, which isolates the expensive path to `decorateMany`-based decoration in default mode.

## What is currently happening

### 1) Membership pushdown is working

For supplement filter `d20=1`, sqlite-v0 generates SQL with supplement `EXISTS` predicate and returns the right set size (`12234`) quickly.

So membership/pushdown is not the bottleneck.

### 2) Default path decorates page entries via provider `decorateMany`

In v3 worker flow (`tx/workers/expand-v3/src/expand-v3-worker.js`), requesting `property=d20` drives the system down provider bulk decoration path.

### 3) sqlite-v0 `decorateMany` is over-fetching and per-code serialized

In `tx/cs/cs-sqlite-runtime-v0.js`, `decorateMany` currently:
- runs `locateMany(codes)`
- loops code-by-code
- for each code always fetches:
  - `display`
  - `isInactive`
  - `isAbstract`
  - `isDeprecated`
  - `status`
- then conditionally fetches designations/properties

For a request that only needs one property (`d20`), this is unnecessary work and creates a per-code async waterfall.

## Why baseline can be faster

`baseline` disables `decorateMany`, so it avoids this heavy bulk-decoration implementation path.
It still does fallback property handling, but without the same over-fetch pattern, yielding lower non-SQL overhead on this workload.

## Problem statement

Our default optimized path is not consistently optimized because provider `decorateMany` performs broad per-code decoration regardless of requested output shape.

This creates a mode where:
- membership pushdown is fast,
- but decoration overwork erases the gain.

## Concrete fix targets

1. Make `decorateMany` field-selective
- Only compute fields explicitly required by request:
  - if only `property=d20`, do not fetch status/inactive/abstract/deprecated/display unless needed.

2. Batch property retrieval for page codes
- Fetch requested properties for all page codes in one query (or a small fixed number), not one code at a time.

3. Avoid unnecessary locate/display fallback
- If candidate already has display/context from enumeration, avoid extra calls.

4. Add explicit trace spans
- Add spans in v3 worker and sqlite provider for:
  - decorateMany total
  - locateMany phase
  - display/status flags phase
  - properties phase
  - designations phase

Without these spans, non-SQL time is visible but not attributable by stage.

## Success criteria

For `LOINC d20=1 + property=d20` (`count=1000`, `offset=0`):
- default wall-time <= baseline wall-time
- non-SQL overhead reduced from ~293 ms to near ~100 ms band
- result parity unchanged

## Repro commands

```bash
# no supplement
node tests/tx/expand-adhoc.js --impl v3 \
  --vs-json '{"resourceType":"ValueSet","status":"active","compose":{"include":[{"system":"http://loinc.org","filter":[{"property":"STATUS","op":"=","value":"ACTIVE"}]}]}}' \
  --count 1000 --offset 0 --opt-profile default --trace json

# supplement filter only
node tests/tx/expand-adhoc.js --impl v3 \
  --vs-json '{"resourceType":"ValueSet","status":"active","compose":{"include":[{"system":"http://loinc.org","filter":[{"property":"d20","op":"=","value":"1"}]}]}}' \
  --param '{"name":"useSupplement","valueCanonical":"http://example.org/fhir/CodeSystem/supplement-loinc-d20|2026.02"}' \
  --count 1000 --offset 0 --opt-profile default --trace json

# supplement filter + requested property
node tests/tx/expand-adhoc.js --impl v3 \
  --vs-json '{"resourceType":"ValueSet","status":"active","compose":{"include":[{"system":"http://loinc.org","filter":[{"property":"d20","op":"=","value":"1"}]}]}}' \
  --param '{"name":"useSupplement","valueCanonical":"http://example.org/fhir/CodeSystem/supplement-loinc-d20|2026.02"}' \
  --param '{"name":"property","valueCode":"d20"}' \
  --count 1000 --offset 0 --opt-profile default --trace json
```
