'use strict';

const Database = require('better-sqlite3');

/**
 * Error thrown when a query exceeds the configured effort limit.
 */
class EffortLimitExceededError extends Error {
  constructor(vmSteps) {
    super(`Query exceeded effort limit of ${vmSteps} VM steps`);
    this.name = 'EffortLimitExceededError';
    this.code = 'EFFORT_LIMIT_EXCEEDED';
    this.vmSteps = vmSteps;
  }
}

/**
 * EffortBreakerDb wraps better-sqlite3 to provide effort-based braking of queries.
 *
 * Uses SQLite's native sqlite3_progress_handler to count virtual machine (VDBE)
 * instruction cycles. When a query exceeds the configured step budget, SQLite
 * interrupts the query with SQLITE_INTERRUPT, which is caught and re-thrown as
 * an EffortLimitExceededError.
 *
 * This is a synchronous, in-process mechanism — no worker threads or IPC needed.
 *
 * @example
 *   const db = new EffortBreakerDb('/path/to/db.sqlite', { maxVmSteps: 100000 });
 *   try {
 *     const rows = db.all('SELECT * FROM large_table WHERE complex_condition');
 *   } catch (err) {
 *     if (err instanceof EffortLimitExceededError) {
 *       console.log('Query was too expensive');
 *     }
 *   }
 *   db.close();
 */
class EffortBreakerDb {
  /**
   * @param {string} dbPath - Path to the SQLite database file (or ':memory:')
   * @param {object} [options]
   * @param {number} [options.maxVmSteps=1000000] - Maximum VM instruction steps per query
   * @param {number} [options.progressInterval=1000] - Check interval in VM instructions
   * @param {boolean} [options.readonly=false] - Open database in readonly mode
   * @param {number} [options.timeout=5000] - SQLite busy timeout in ms
   */
  constructor(dbPath, options = {}) {
    this._maxVmSteps = options.maxVmSteps ?? 1000000;
    this._progressInterval = options.progressInterval ?? 1000;
    this._db = new Database(dbPath, {
      readonly: options.readonly ?? false,
      timeout: options.timeout ?? 5000,
    });

    this._installProgressHandler();
  }

  /**
   * Execute a query and return all matching rows.
   * @param {string} sql - SQL query string
   * @param {Array} [params] - Bind parameters
   * @returns {Array<object>} Array of row objects
   * @throws {EffortLimitExceededError} If the query exceeds the VM step budget
   */
  all(sql, params) {
    return this._executeWithEffortLimit(() => {
      const stmt = this._db.prepare(sql);
      return params ? stmt.all(...params) : stmt.all();
    });
  }

  /**
   * Execute a query and return the first matching row.
   * @param {string} sql - SQL query string
   * @param {Array} [params] - Bind parameters
   * @returns {object|undefined} First row or undefined
   * @throws {EffortLimitExceededError} If the query exceeds the VM step budget
   */
  get(sql, params) {
    return this._executeWithEffortLimit(() => {
      const stmt = this._db.prepare(sql);
      return params ? stmt.get(...params) : stmt.get();
    });
  }

  /**
   * Execute a statement (INSERT, UPDATE, DELETE).
   * @param {string} sql - SQL statement
   * @param {Array} [params] - Bind parameters
   * @returns {object} Info object with changes and lastInsertRowid
   * @throws {EffortLimitExceededError} If the query exceeds the VM step budget
   */
  run(sql, params) {
    return this._executeWithEffortLimit(() => {
      const stmt = this._db.prepare(sql);
      return params ? stmt.run(...params) : stmt.run();
    });
  }

  /**
   * Execute a query with both VM step limit and row count limit.
   * Uses better-sqlite3's iterate() to stop after a maximum number of rows.
   * @param {string} sql - SQL query string
   * @param {Array} [params] - Bind parameters
   * @param {number} maxRows - Maximum number of rows to return
   * @returns {Array<object>} Array of row objects (up to maxRows)
   * @throws {EffortLimitExceededError} If the query exceeds the VM step budget
   */
  iterateWithLimit(sql, params, maxRows) {
    return this._executeWithEffortLimit(() => {
      const stmt = this._db.prepare(sql);
      const iterator = params ? stmt.iterate(...params) : stmt.iterate();
      const rows = [];
      for (const row of iterator) {
        rows.push(row);
        if (rows.length >= maxRows) break;
      }
      return rows;
    });
  }

  /**
   * Get the underlying better-sqlite3 Database instance for direct access.
   * The progress handler is already installed on this instance.
   * @returns {Database} The better-sqlite3 Database instance
   */
  getDatabase() {
    return this._db;
  }

  /**
   * Close the database connection.
   */
  close() {
    this._db.close();
  }

  /**
   * Install the progress handler on the database.
   * @private
   */
  _installProgressHandler() {
    this._vmStepCount = 0;
    const maxSteps = this._maxVmSteps;
    const interval = this._progressInterval;
    this._db.progressHandler(interval, () => {
      this._vmStepCount += interval;
      return this._vmStepCount > maxSteps ? 1 : 0;
    });
  }

  /**
   * Execute a function with effort limit tracking.
   * Resets the step counter before execution and converts SQLITE_INTERRUPT
   * errors into EffortLimitExceededError.
   * @private
   */
  _executeWithEffortLimit(fn) {
    this._vmStepCount = 0;
    try {
      return fn();
    } catch (err) {
      if (err.code === 'SQLITE_INTERRUPT') {
        throw new EffortLimitExceededError(this._vmStepCount);
      }
      throw err;
    }
  }
}

module.exports = { EffortBreakerDb, EffortLimitExceededError };
