'use strict';

const BetterSqlite3 = require('better-sqlite3');

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
  db._fhirsmithProgressLimit = configureSqliteProgressLimit(db, opts);
  return db;
}

module.exports = {
  clearSqliteProgressLimit,
  configureSqliteProgressLimit,
  openSqliteV0Database,
  parsePositiveInteger,
  registerRegexpFunction,
  sqliteProgressOptions,
};
