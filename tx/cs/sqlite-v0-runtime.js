'use strict';

const BetterSqlite3 = require('better-sqlite3');

const SQLITE_V0_BUDGET_EXCEEDED = 'sqlite-v0 early-stop budget exceeded';

function registerRegexpFunction(db) {
  const regexCache = new Map();
  db.function('regexp', (pattern, value) => {
    if (pattern == null || value == null) return 0;
    const source = String(pattern);
    let re = regexCache.get(source);
    if (!re) {
      try {
        re = new RegExp(source);
      } catch (e) {
        throw new Error(`Invalid regex '${source}': ${e.message}`);
      }
      regexCache.set(source, re);
    }
    re.lastIndex = 0;
    return re.test(String(value)) ? 1 : 0;
  });
}

function registerBudgetFunction(db) {
  const state = {
    limit: null,
    seen: 0,
    exceeded: false,
  };
  db._fhirsmithBudget = state;
  db.function('sqlite_v0_budget', (_value) => {
    if (!Number.isInteger(state.limit) || state.limit <= 0) {
      return 1;
    }
    state.seen++;
    if (state.seen > state.limit) {
      state.exceeded = true;
      throw new Error(SQLITE_V0_BUDGET_EXCEEDED);
    }
    return 1;
  });
  return state;
}

function withSqliteV0Budget(db, limit, fn) {
  const state = db?._fhirsmithBudget || null;
  if (!state || !Number.isInteger(limit) || limit <= 0) {
    return { budgetSupported: false, result: fn() };
  }

  state.limit = limit;
  state.seen = 0;
  state.exceeded = false;
  try {
    const result = fn();
    return {
      budgetSupported: true,
      budgetExceeded: false,
      seen: state.seen,
      result,
    };
  } catch (error) {
    if (state.exceeded || String(error?.message || '').includes(SQLITE_V0_BUDGET_EXCEEDED)) {
      return {
        budgetSupported: true,
        budgetExceeded: true,
        seen: state.seen,
        error,
      };
    }
    throw error;
  } finally {
    state.limit = null;
    state.seen = 0;
    state.exceeded = false;
  }
}

function parsePositiveInteger(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function sqliteProgressOptions(opts = {}) {
  const maxProgressCallbacks = parsePositiveInteger(opts.maxProgressCallbacks)
    ?? parsePositiveInteger(process.env.FHIRSMITH_SQLITE_MAX_PROGRESS_CALLBACKS);
  const progressInterval = parsePositiveInteger(opts.progressInterval)
    ?? parsePositiveInteger(process.env.FHIRSMITH_SQLITE_PROGRESS_INTERVAL)
    ?? 100000;
  return { maxProgressCallbacks, progressInterval };
}

function configureSqliteProgressLimit(db, opts = {}) {
  const { maxProgressCallbacks, progressInterval } = sqliteProgressOptions(opts);
  const supported = typeof db.progressHandler === 'function';
  const state = {
    supported,
    enabled: false,
    progressInterval,
    maxProgressCallbacks,
    callbacks: 0,
  };

  if (!supported || !maxProgressCallbacks) {
    return state;
  }

  db.progressHandler(progressInterval, () => {
    state.callbacks++;
    return state.callbacks > maxProgressCallbacks;
  });
  state.enabled = true;
  return state;
}

function clearSqliteProgressLimit(db) {
  if (db && typeof db.progressHandler === 'function') {
    db.progressHandler();
  }
}

function openSqliteV0Database(dbPath, opts = {}) {
  const readonly = opts.readonly !== false;
  const db = new BetterSqlite3(dbPath, { readonly, fileMustExist: true });
  db.pragma('cache_size = 10000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
  registerRegexpFunction(db);
  registerBudgetFunction(db);
  db._fhirsmithProgressLimit = configureSqliteProgressLimit(db, opts);
  return db;
}

module.exports = {
  SQLITE_V0_BUDGET_EXCEEDED,
  clearSqliteProgressLimit,
  configureSqliteProgressLimit,
  openSqliteV0Database,
  parsePositiveInteger,
  registerBudgetFunction,
  registerRegexpFunction,
  sqliteProgressOptions,
  withSqliteV0Budget,
};
