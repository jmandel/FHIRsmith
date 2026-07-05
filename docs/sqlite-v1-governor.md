# Query governor (runaway-query cancellation)

`tx/cs/sqlite-governor.js`. Bounds a single expansion so it cannot burn a
worker's CPU/memory without limit.

## One real brake, no half-measures

There is exactly one mechanism that actually bounds a running SQLite statement:
the **progress handler** (`sqlite3_progress_handler`). It fires a callback every
N virtual-machine opcodes **regardless of query shape** — so it catches the
sort / hash / CTE-build phases that produce no rows — and a truthy return aborts
the statement with `SQLITE_INTERRUPT`, reclaiming CPU/memory mid-query. It is
the only mechanism that can enforce a real opcode budget (the "N machine
instructions" brake).

We deliberately do **not** add a cooperative fallback (injecting a `governor()`
function into query WHEREs). That kind of brake is brittle — the planner can
hoist it, its placement couples to every generated query shape, and it never
sees a sort-bomb — so it delivers *false confidence* rather than governance.
Instead the governor is binary and honest.

## Policy: governed, or a loud refusal to run ungoverned

Stock `better-sqlite3` (12.8.0 here) does not expose the progress handler; a
custom build must. When it is absent, behaviour is chosen by policy:

| policy | fork present | fork absent |
|---|---|---|
| `require` (production default) | brake installed | **throws `GovernorUnavailable`** — never runs ungoverned |
| `prefer` (dev/test) | brake installed | runs ungoverned |
| `off` | brake installed | runs ungoverned, silently |

So production is configured `require`: if the governed build isn't installed the
server fails loudly at first use instead of silently degrading. Dev/test runs
`prefer` and simply goes ungoverned.

## Fork contract

A custom `better-sqlite3` build must expose one method, feature-detected under
any of these names:

```
db.progressHandler(nOps, cb)     // preferred
db.progress_handler(nOps, cb)
db.setProgressHandler(nOps, cb)
```

`cb()` is invoked ~every `nOps` VM opcodes; returning truthy aborts the running
statement (maps to `sqlite3_progress_handler`'s non-zero return →
`SQLITE_INTERRUPT`). Calling with `cb = null` (or `nOps = 0`) clears it. The
governor installs the handler for the duration of a governed section and clears
it in `finally`.

## Rejected alternative: worker.terminate()

Evaluated and rejected. `worker.terminate()` cannot preempt a synchronous native
addon call in progress — it only takes effect at the next return to the JS event
loop. A worker blocked inside one long `db.get()` keeps running that native call
to completion before it dies, so the caller stops waiting but the runaway keeps
burning CPU. Only the progress handler (or a subprocess SIGKILL) actually stops
it mid-flight.

## Prevention is the first line

The governor handles the *residual*. The SQL profiling in
`docs/sqlite-v1-sql-profile.md` identifies the query shapes that go quadratic /
full-scan / JS-materialise-huge, so the engine can cap or reshape them before
executing — the most reliable lever, and it needs no fork.

## Usage

```js
const gov = QueryGovernor.fromOpContext(opContext, {
  policy: 'require',          // production
  maxOps: 500_000_000,        // optional hard opcode budget
});
const rows = gov.run(db, () => db.prepare(sql).all(...args));
```

`fromOpContext` aligns the deadline with the operation's remaining time budget
(`opContext.timeLimit`), complementing the worker's existing `deadCheck` (which
guards JS checkpoints but cannot see into a running SQL statement).
