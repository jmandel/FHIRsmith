# sqlite-v2 request traces

A trace records what the server did for one request, for any operation (`$expand`,
`$validate-code`, `$lookup`, `$subsumes`, …):

- a root span for the request;
- a span for each value set expansion, include, exclude and import;
- an engine sub-trace wherever a sqlite-v2 provider ran: each plan step, its SQL, the stored sets
  it read, time and memory.

Other providers (FHIR CodeSystem resources, UCUM, NDC, …) are opaque spans: their time and the
codes they added. Traces drive the request log, the viewer and the regression catalogue.

Code:

- `tx/sqlite-v2/trace.js`: the tracer and the ring buffer;
- `tx/sqlite-v2/request-trace.js`: the request middleware;
- spans in `tx/workers/expand.js` and in the sqlite-v2 providers.

## Turning traces on

| setting | effect |
|---|---|
| `modules.tx.sqliteV2Trace` absent or `"off"` | no traces. `_trace` is ignored. The engine holds `null` for the tracer and skips every counter. |
| `"request"` | a request with `_trace=true` or `_trace=cold` is traced. The trace is returned with the response and kept in the ring buffer. |
| `"all"` | every engine expansion is traced into the ring buffer. A request still gets the trace back only with `_trace=true`. |

`_trace` is a request parameter (GET query or `Parameters`).

- **Cache key.** `_trace` is part of the expansion cache key, so a traced and an untraced
  request never share a cached expansion.
- **The trace is not cached.** The trace is added to a copy of the response, so a cached object
  never carries a trace.

**`_trace=cold`** (debug only; ignored unless traces are enabled) bypasses upstream's expansion
cache for the request. sqlite-v2 itself has no caches, so every request already plans and
evaluates from SQLite. The trace lists what is not cache in `request.notCaches`: SQLite's page
cache, the OS page cache under mmap, prepared statements, and data built at load.

**Zero cost when off.** With tracing off, the middleware does a single comparison per request,
`opContext.sqliteTrace` is unset, and every span site checks for null.

## Where traces go

- **With the response**, as JSON in `valueString`:

  | response | where the trace goes |
  |---|---|
  | `ValueSet` | the extension `http://fhirsmith.org/fhir/StructureDefinition/expansion-trace` on `expansion` |
  | `Parameters` (`$lookup`, `$validate-code`, `$subsumes`) | a parameter named `_trace` |
  | `OperationOutcome` | the same extension, on the resource |
- **Ring buffer.** The last 200 traces are kept in memory:
  - `GET /<endpoint>/sqlite-v2/traces` lists them as `{id, startedAt, wallUs, total}`;
  - `GET /<endpoint>/sqlite-v2/traces/<id>` returns one trace.

  Both routes are registered only when `sqliteV2Trace` is `"request"` or `"all"`.

## Format `fhirsmith-expand-trace/0-draft.2`

0-draft.2 adds the request-level span kinds and fields. Engine spans are unchanged from 0-draft.

```json
{
  "traceFormat": "fhirsmith-expand-trace/0-draft",
  "id": "t12",
  "startedAt": "2026-11-01T16:20:00.000Z",
  "request": { "count": 10, "offset": 0, "activeOnly": false, "filter": null },
  "versions": [{ "system": "http://snomed.info/sct", "version": "http://snomed.info/sct/900000000000207008/version/20250201" }],
  "spans": [
    { "node": "n1", "parent": null, "label": "compile compose", "kind": "sql", "system": "...",
      "startUs": 2.1, "durUs": 410.3, "sqlStatements": 2, "sqlRows": 3, "setsLoaded": 0, "setBytes": 0,
      "setLoadUs": 0, "setCard": null, "cache": null, "heapDeltaBytes": 18240 }
  ],
  "memory": [{ "label": "start", "tUs": 0, "heapUsed": 81234567, "rss": 312345678, "setBytesLive": null }],
  "result": { "total": 130, "returned": 10, "complete": true },
  "summary": { "wallUs": 2410.5, "sqlStatements": 5, "sqlRows": 25, "setsLoaded": 7, "setBytes": 236,
               "setLoadUs": 241.5, "topLevelUsByKind": { "sql": 410.3, "set": 862.3, "rows": 1102.0 },
               "longestSyncUs": 1102.0 }
}
```

### Spans

There is one span per plan step. Spans nest through `parent`.

| field | meaning |
|---|---|
| `node`, `parent` | span id, and the id of the enclosing span (`null` at top level) |
| `label` | the step, e.g. `load stored sets (12 keys, 2 statements)`, `propIn`, `probe text on 132 candidates`, `fetch page rows (10)`, `result cache hit (130 ids)` |
| `kind` | Request level: `op` (the request), `vs` (one value set expansion: the requested one, and each import), `part` (an include, exclude or import; also `compose via processSelection`). Engine: `sql` (compiling, resolving codes, locating), `set` (set algebra, stored-set reads, membership), `rows` (reading facts: page rows, probes, lookup properties) |
| `system`, `version` | on `part` spans: the code system and version |
| `provider`, `engine` | on include and exclude spans: the provider class that served them, and whether it was engine-backed. Spans of other providers are opaque: they carry time and `codesAdded`, and SQL counters are 0 |
| `codesAdded`, `codes`, `total`, `handled` | codes this part added; codes and total of a `vs` span; whether `processSelection` handled the compose (false: expand.js took its usual path) |
| `expansionCache` | `"hit"` on the root span when the server's expansion cache answered |
| `startUs`, `durUs` | start offset from the beginning of the request, and duration, in microseconds |
| `sqlStatements`, `sqlRows` | statements run and rows read inside the span, including child spans |
| `setsLoaded`, `setBytes`, `setLoadUs` | stored bitmaps read from `concept_set`, their serialised bytes, and the time spent reading and deserialising them |
| `setCard` | cardinality of the set the step produced, when it produced one |
| `heapDeltaBytes` | change in `process.memoryUsage().heapUsed` over the span. This is noisy because of GC; use it for orders of magnitude only |
| `error` | present when the step threw |

### Memory, result and summary

- **`memory`** holds points (`start` and `end`) with `heapUsed` and `rss` in bytes.
- **`result`**:
  - `total`: `null` when the result is lazy, that is, when the first page was produced without
    counting the rest;
  - `returned`: codes on this page;
  - `complete`.
- **`summary`**:
  - `wallUs`;
  - the totals of the counters;
  - `topLevelUsByKind`: time per kind over top-level spans;
  - `longestSyncUs`: the longest top-level span. Everything is synchronous, so this is the
    longest stretch without yielding.

## Cost when off

With tracing off, the provider passes `null` for the tracer and the stats object. Every hook in
the engine is a `null` check: no timers, no `memoryUsage()` calls and no counters.
