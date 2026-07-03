'use strict';

//
// Query governor: bound runaway SQLite queries so a single expansion cannot
// burn a worker's CPU/memory indefinitely.
//
// Three layers, strongest first:
//
//   1. Progress-handler brake (REAL brake; needs a better-sqlite3 build that
//      exposes it). Fires every N virtual-machine opcodes regardless of query
//      shape, so it catches sort/hash/CTE phases that produce no rows. The
//      callback returns truthy to abort; SQLite unwinds with SQLITE_INTERRUPT.
//      This is the only layer that reclaims resources mid-statement and the
//      only one that can enforce a true opcode budget.
//
//      Fork contract (feature-detected, any one of these method names):
//        db.progressHandler(nOps, cb)     // preferred
//        db.progress_handler(nOps, cb)
//        db.setProgressHandler(nOps, cb)
//      where `cb()` is called every ~nOps opcodes and returning truthy aborts
//      the running statement; calling with cb=null (or nOps=0) clears it.
//
//   2. Cooperative SQL function `governor()` (stock fallback). Registered on
//      the connection; the provider injects it into the hot-path WHERE of
//      generated queries. SQLite evaluates it per candidate row (incl. join
//      probes), and it throws when the deadline/opcode-proxy is exceeded.
//      Catches filter/join runaways but NOT pure sort/hash phases.
//
//   3. iterate() deadline (stock fallback for output-producing queries). Pull
//      rows via Statement.iterate() and stop at the deadline without needing
//      any injection. Bounds anything that streams rows.
//
// Correctness never depends on the fork: if layer 1 is absent, layers 2+3
// still bound the common cases; only an adversarial no-output sort-bomb can
// outlast a stock build (documented, and G1 profiling is meant to let the
// engine refuse such shapes before they run).
//

class GovernorAbort extends Error {
  constructor(reason, detail) {
    super(`query governor: ${reason}${detail ? ' (' + detail + ')' : ''}`);
    this.name = 'GovernorAbort';
    this.governorReason = reason; // 'deadline' | 'opcode-budget' | 'row-budget'
    this.isGovernorAbort = true;
  }
}

// Which progress-handler installer (if any) this connection exposes.
function detectProgressHandler(db) {
  for (const name of ['progressHandler', 'progress_handler', 'setProgressHandler']) {
    if (db && typeof db[name] === 'function') return name;
  }
  return null;
}

function governorCapabilities(db) {
  return {
    progressHandler: detectProgressHandler(db),
    hasRealBrake: detectProgressHandler(db) != null,
  };
}

const DEFAULTS = {
  deadlineMs: 30000,   // wall-clock budget for a single governed section
  maxOps: null,        // optional hard opcode budget (progress-handler only)
  opsPerTick: 20000,   // VM opcodes between progress callbacks
  rowBudget: null,     // optional cap on rows pulled via runIterate()
};

class QueryGovernor {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.deadline = null;
    this.ticks = 0;
    this._installedOn = null;
    this._installedName = null;
  }

  static fromOpContext(opContext, opts = {}) {
    // Align the governor deadline with the operation's remaining time budget.
    let deadlineMs = DEFAULTS.deadlineMs;
    if (opContext && typeof opContext.timeLimit === 'number' && opContext.timeLimit > 0) {
      deadlineMs = opContext.timeLimit;
    }
    return new QueryGovernor({ deadlineMs, ...opts });
  }

  _start() {
    this.deadline = Date.now() + this.opts.deadlineMs;
    this.ticks = 0;
  }

  // The predicate every layer consults. Returns a reason string to abort, or null.
  _abortReason() {
    if (Date.now() >= this.deadline) return 'deadline';
    if (this.opts.maxOps != null && this.ticks * this.opts.opsPerTick >= this.opts.maxOps) return 'opcode-budget';
    return null;
  }

  // ---- Layer 1: progress-handler brake -----------------------------------

  _installProgressHandler(db) {
    const name = detectProgressHandler(db);
    if (!name) return false;
    this._installedOn = db;
    this._installedName = name;
    db[name](this.opts.opsPerTick, () => {
      this.ticks += 1;
      const reason = this._abortReason();
      if (reason) { this._firedReason = reason; return 1; } // truthy => abort
      return 0;
    });
    return true;
  }

  _clearProgressHandler() {
    if (this._installedOn && this._installedName) {
      try { this._installedOn[this._installedName](0, null); } catch { /* some forks: (null) */
        try { this._installedOn[this._installedName](null); } catch { /* ignore */ }
      }
    }
    this._installedOn = null;
    this._installedName = null;
  }

  // ---- Layer 2: cooperative SQL function ---------------------------------

  // Register governor() on a connection. Idempotent per connection.
  installFunction(db) {
    if (db.__governorFnInstalled) return;
    db.function('governor', { deterministic: false, varargs: false }, () => {
      const reason = this._abortReason();
      if (reason) throw new GovernorAbort(reason, 'sql-function');
      return 1;
    });
    db.__governorFnInstalled = true;
    db.__governor = this; // the active governor the function consults
  }

  // Inject the cooperative brake into a WHERE-bearing query. Only used on the
  // stock fallback path; a no-op string when a real brake is installed.
  static injectWhere(sql) {
    // Wrap: ... WHERE (governor()) AND (<original predicate>) — governor() first
    // and non-deterministic so the planner cannot hoist or cache it.
    return sql.replace(/\bWHERE\b/i, 'WHERE governor() AND ');
  }

  // ---- Orchestration ------------------------------------------------------

  /**
   * Run a synchronous db section under the governor. Installs the strongest
   * available brake for the duration and normalises any abort to GovernorAbort.
   * @param {Database} db
   * @param {() => T} fn  synchronous work (prepare/all/get/iterate)
   * @returns {T}
   */
  run(db, fn) {
    this._start();
    this._firedReason = null;
    const usedProgress = this._installProgressHandler(db);
    if (!usedProgress) this.installFunction(db); // ensure governor() exists for injected SQL
    try {
      return fn();
    } catch (e) {
      if (e && e.isGovernorAbort) throw e;
      // A progress-handler abort surfaces as an SQLite interrupt/error; if our
      // brake fired, normalise it.
      if (this._firedReason) throw new GovernorAbort(this._firedReason, 'progress-handler');
      if (this.deadline != null && Date.now() >= this.deadline && isInterruptError(e)) {
        throw new GovernorAbort('deadline', 'progress-handler');
      }
      throw e;
    } finally {
      if (usedProgress) this._clearProgressHandler();
    }
  }

  /**
   * Pull rows from a prepared statement under a per-row deadline (layer 3).
   * Bounds output-producing queries even with no brake installed.
   * @param {Statement} stmt (already bound or pass args)
   * @param {any[]} args
   * @returns {any[]}
   */
  runIterate(stmt, args = []) {
    this._start();
    const out = [];
    let checked = 0;
    for (const row of stmt.iterate(...args)) {
      out.push(row);
      // Cheap: only consult the clock every 256 rows.
      if ((++checked & 0xff) === 0) {
        const reason = this._abortReason();
        if (reason) throw new GovernorAbort(reason, 'iterate');
      }
      if (this.opts.rowBudget != null && out.length > this.opts.rowBudget) {
        throw new GovernorAbort('row-budget', 'iterate');
      }
    }
    return out;
  }
}

function isInterruptError(e) {
  if (!e) return false;
  const c = e.code || '';
  const m = e.message || '';
  return c === 'SQLITE_INTERRUPT' || /interrupt/i.test(m) || /SQLITE_ABORT/.test(c);
}

module.exports = {
  QueryGovernor,
  GovernorAbort,
  governorCapabilities,
  detectProgressHandler,
};
