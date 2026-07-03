'use strict';

//
// Query governor: bound runaway SQLite queries so a single expansion cannot
// burn a worker's CPU/memory without limit.
//
// Design: there is exactly ONE real brake — SQLite's progress handler, which
// fires every N virtual-machine opcodes regardless of query shape (so it
// catches the sort/hash/CTE phases that produce no rows) and, on a truthy
// return, aborts the statement with SQLITE_INTERRUPT, reclaiming resources
// mid-query. It is the only mechanism that can enforce a real opcode budget.
//
// Stock better-sqlite3 does not expose it; a custom build must. Rather than
// bolt on a half-working cooperative fallback (per-query WHERE injection that
// the planner can hoist and that never sees a sort-bomb), the governor is
// binary and honest:
//
//   - fork present  -> install the progress-handler brake for the section.
//   - fork absent   -> behaviour is chosen by POLICY:
//       'require' (production default): fail loudly (GovernorUnavailable) so a
//                 server is never silently running ungoverned.
//       'prefer'  (dev/test): run ungoverned, no brake.
//       'off'     : run ungoverned, no brake, no complaint.
//
// A weak cooperative brake would give false confidence; "governed, or a loud
// refusal to run ungoverned in production" is the contract instead.
//
// Fork contract (feature-detected under any of these method names):
//     db.progressHandler(nOps, cb)     // preferred
//     db.progress_handler(nOps, cb)
//     db.setProgressHandler(nOps, cb)
// where cb() is invoked ~every nOps VM opcodes and returning truthy aborts the
// running statement (maps to sqlite3_progress_handler's non-zero return =>
// SQLITE_INTERRUPT). Calling with cb=null (or nOps=0) clears it.
//

class GovernorAbort extends Error {
  constructor(reason, detail) {
    super(`query governor: aborted (${reason})${detail ? ' — ' + detail : ''}`);
    this.name = 'GovernorAbort';
    this.governorReason = reason; // 'deadline' | 'opcode-budget'
    this.isGovernorAbort = true;
    this.statusCode = 422;
  }
}

class GovernorUnavailable extends Error {
  constructor(detail) {
    super(`query governor required but this better-sqlite3 build exposes no ` +
      `progress handler${detail ? ' — ' + detail : ''}. Install a build with ` +
      `progressHandler(), or set governor policy to 'prefer'/'off' for non-production.`);
    this.name = 'GovernorUnavailable';
    this.isGovernorUnavailable = true;
  }
}

function detectProgressHandler(db) {
  for (const name of ['progressHandler', 'progress_handler', 'setProgressHandler']) {
    if (db && typeof db[name] === 'function') return name;
  }
  return null;
}

function governorCapabilities(db) {
  const name = detectProgressHandler(db);
  return { progressHandler: name, hasRealBrake: name != null };
}

const DEFAULTS = {
  policy: 'require',   // 'require' | 'prefer' | 'off'
  deadlineMs: 30000,   // wall-clock budget for a governed section
  maxOps: null,        // optional hard opcode budget
  opsPerTick: 20000,   // VM opcodes between progress callbacks
};

class QueryGovernor {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.deadline = null;
    this.ticks = 0;
    this._firedReason = null;
    this._installedOn = null;
    this._installedName = null;
  }

  static fromOpContext(opContext, opts = {}) {
    let deadlineMs = DEFAULTS.deadlineMs;
    if (opContext && typeof opContext.timeLimit === 'number' && opContext.timeLimit > 0) {
      deadlineMs = opContext.timeLimit;
    }
    return new QueryGovernor({ deadlineMs, ...opts });
  }

  _abortReason() {
    if (Date.now() >= this.deadline) return 'deadline';
    if (this.opts.maxOps != null && this.ticks * this.opts.opsPerTick >= this.opts.maxOps) return 'opcode-budget';
    return null;
  }

  _install(db) {
    const name = detectProgressHandler(db);
    if (!name) return false;
    this._installedOn = db;
    this._installedName = name;
    db[name](this.opts.opsPerTick, () => {
      this.ticks += 1;
      const reason = this._abortReason();
      if (reason) { this._firedReason = reason; return 1; }
      return 0;
    });
    return true;
  }

  _clear() {
    if (this._installedOn && this._installedName) {
      try { this._installedOn[this._installedName](0, null); }
      catch { try { this._installedOn[this._installedName](null); } catch { /* ignore */ } }
    }
    this._installedOn = null;
    this._installedName = null;
  }

  /**
   * Run a synchronous db section under the governor.
   *   - fork present: install the brake, run, clear in finally, normalise any
   *     interrupt to GovernorAbort.
   *   - fork absent: policy 'require' throws GovernorUnavailable; 'prefer'/'off'
   *     run the section ungoverned.
   */
  run(db, fn) {
    this.deadline = Date.now() + this.opts.deadlineMs;
    this.ticks = 0;
    this._firedReason = null;

    const installed = this._install(db);
    if (!installed) {
      if (this.opts.policy === 'require') throw new GovernorUnavailable();
      return fn(); // 'prefer' / 'off': ungoverned
    }
    try {
      return fn();
    } catch (e) {
      if (this._firedReason) throw new GovernorAbort(this._firedReason, 'progress-handler');
      if (Date.now() >= this.deadline && isInterruptError(e)) throw new GovernorAbort('deadline', 'progress-handler');
      throw e;
    } finally {
      this._clear();
    }
  }
}

function isInterruptError(e) {
  if (!e) return false;
  const c = e.code || '';
  return c === 'SQLITE_INTERRUPT' || c === 'SQLITE_ABORT' || /interrupt/i.test(e.message || '');
}

module.exports = {
  QueryGovernor,
  GovernorAbort,
  GovernorUnavailable,
  governorCapabilities,
  detectProgressHandler,
};
