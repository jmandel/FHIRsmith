# Query governor (runaway-query cancellation)

`tx/cs/sqlite-governor.js`. Bounds a single expansion so it cannot burn a
worker's CPU/memory without limit. Three layers, strongest first; correctness
never depends on the native fork.

## Layer 1 — progress-handler brake (the real brake; needs a fork)

`sqlite3_progress_handler` fires a callback every N virtual-machine opcodes
**regardless of query shape**, so it catches the sort / hash / CTE-build phases
that produce no rows and that the other layers cannot see. Returning truthy
from the callback aborts the statement with `SQLITE_INTERRUPT`, reclaiming
resources mid-query. It is also the only layer that can enforce a true opcode
budget (the "N machine instructions" brake).

Stock `better-sqlite3` (12.8.0 here) does **not** expose it. A custom build
must add one method, feature-detected under any of these names:

```
db.progressHandler(nOps, cb)     // preferred
db.progress_handler(nOps, cb)
db.setProgressHandler(nOps, cb)
```

Contract: `cb()` is invoked roughly every `nOps` VM opcodes; returning a truthy
value aborts the running statement (maps to `sqlite3_progress_handler`'s
non-zero return → `SQLITE_INTERRUPT`). Calling with `cb = null` (or `nOps = 0`)
clears the handler. The governor installs the handler for the duration of a
governed section and clears it in `finally`.

## Layer 2 — cooperative `governor()` SQL function (stock fallback)

Registered on the connection; the provider injects it into the hot-path
`WHERE` of generated queries (`QueryGovernor.injectWhere`). SQLite evaluates it
per candidate row — including intermediate **join probes**, so it fires
mid-join before any output (measured: a 100k self-join aborts in ~70ms). It is
marked non-deterministic so the planner cannot hoist or cache it. It does
**not** see pure sort/hash phases (they never call it).

## Layer 3 — `iterate()` deadline (stock fallback)

Pull rows via `Statement.iterate()` and stop at the wall-clock deadline (or a
row budget) with no SQL injection needed. Bounds anything that streams rows.

## What each layer cannot do

- Layer 2/3 are **cooperative**: an adversarial no-output sort-bomb (huge
  `ORDER BY`/`GROUP BY` before any predicate) can outlast them on a stock
  build. Only layer 1 (fork) or a subprocess SIGKILL stops that mid-flight.
- `worker.terminate()` was evaluated and rejected as a backstop: it cannot
  preempt a synchronous native call in progress, so the runaway keeps burning
  CPU until the native call returns even though the caller stops waiting.

## Prevention is the first line

The governor handles the *residual*. The SQL profiling in
`docs/sqlite-v1-sql-profile.md` identifies the query shapes that go quadratic /
full-scan / JS-materialise-huge, so the engine can cap or reshape them before
executing — the most reliable lever without a fork.

## Usage

```js
const gov = QueryGovernor.fromOpContext(opContext, { maxOps: 500_000_000 });
const rows = gov.run(db, () => db.prepare(sql).all(...args));
// or, to bound a streaming read without a brake installed:
const rows = gov.runIterate(db.prepare(sql), args);
```

`fromOpContext` aligns the deadline with the operation's remaining time budget
(`opContext.timeLimit`), complementing the worker's existing `deadCheck` (which
guards JS checkpoints but cannot see into a running SQL statement).
