'use strict';

const { Worker } = require('worker_threads');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'effort-breaker-worker.js');

/**
 * Error thrown when a query exceeds the configured effort limit.
 */
class EffortLimitExceededError extends Error {
  constructor(limitMs) {
    super(`Query exceeded effort limit of ${limitMs}ms`);
    this.name = 'EffortLimitExceededError';
    this.code = 'EFFORT_LIMIT_EXCEEDED';
    this.limitMs = limitMs;
  }
}

/**
 * EffortBreakerDb wraps better-sqlite3 to provide effort-based braking of queries.
 *
 * Queries run in a worker thread. If a query exceeds the configured time budget
 * (effortLimitMs), the worker is terminated and an EffortLimitExceededError is thrown.
 *
 * For row-count-based effort limiting, use iterateWithLimit() which uses
 * better-sqlite3's iterate() to stop after a maximum number of rows.
 *
 * @example
 *   const db = new EffortBreakerDb('/path/to/db.sqlite', { effortLimitMs: 5000 });
 *   const rows = await db.all('SELECT * FROM table WHERE condition = ?', [value]);
 *   db.close();
 */
class EffortBreakerDb {
  /**
   * @param {string} dbPath - Path to the SQLite database file (or ':memory:')
   * @param {object} [options]
   * @param {number} [options.effortLimitMs=30000] - Maximum wall-clock time per query in ms
   * @param {boolean} [options.readonly=false] - Open database in readonly mode
   * @param {number} [options.timeout=5000] - SQLite busy timeout in ms
   */
  constructor(dbPath, options = {}) {
    this._dbPath = dbPath;
    this._effortLimitMs = options.effortLimitMs ?? 30000;
    this._dbOptions = {
      readonly: options.readonly ?? false,
      timeout: options.timeout ?? 5000,
    };
    this._closed = false;
  }

  /**
   * Execute a query and return all matching rows.
   * @param {string} sql - SQL query string
   * @param {Array} [params] - Bind parameters
   * @returns {Promise<Array<object>>} Array of row objects
   */
  all(sql, params) {
    return this._execute('all', sql, params);
  }

  /**
   * Execute a query and return the first matching row.
   * @param {string} sql - SQL query string
   * @param {Array} [params] - Bind parameters
   * @returns {Promise<object|undefined>} First row or undefined
   */
  get(sql, params) {
    return this._execute('get', sql, params);
  }

  /**
   * Execute a statement (INSERT, UPDATE, DELETE).
   * @param {string} sql - SQL statement
   * @param {Array} [params] - Bind parameters
   * @returns {Promise<object>} Info object with changes and lastInsertRowid
   */
  run(sql, params) {
    return this._execute('run', sql, params);
  }

  /**
   * Execute a query with a row-count limit. Returns at most maxRows rows.
   * Uses better-sqlite3's iterate() internally to avoid loading all results.
   * @param {string} sql - SQL query string
   * @param {Array} [params] - Bind parameters
   * @param {number} maxRows - Maximum number of rows to return
   * @returns {Promise<Array<object>>} Array of row objects (up to maxRows)
   */
  iterateWithLimit(sql, params, maxRows) {
    return this._execute('iterate', sql, params, maxRows);
  }

  /**
   * Close the database wrapper. No further queries can be executed.
   */
  close() {
    this._closed = true;
  }

  /**
   * Run a query in a worker thread with effort-based braking.
   * @private
   */
  _execute(method, sql, params, effortLimit) {
    if (this._closed) {
      return Promise.reject(new Error('Database is closed'));
    }

    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: {
          dbPath: this._dbPath,
          dbOptions: this._dbOptions,
          sql,
          params: params || [],
          method,
          effortLimit,
        },
      });

      const timer = setTimeout(() => {
        worker.terminate().then(() => {
          reject(new EffortLimitExceededError(this._effortLimitMs));
        });
      }, this._effortLimitMs);

      worker.on('message', (msg) => {
        clearTimeout(timer);
        if (msg.success) {
          resolve(msg.result);
        } else {
          const err = new Error(msg.error.message);
          err.code = msg.error.code;
          reject(err);
        }
      });

      worker.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      worker.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== 1) {
          reject(new EffortLimitExceededError(this._effortLimitMs));
        }
      });
    });
  }
}

module.exports = { EffortBreakerDb, EffortLimitExceededError };
