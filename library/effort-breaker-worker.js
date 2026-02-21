'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

const { dbPath, dbOptions, sql, params, method, effortLimit } = workerData;

let db;
try {
  db = new Database(dbPath, dbOptions);

  // Register an effort-checking function that SQLite calls during query execution.
  // This leverages better-sqlite3's custom function support to inject periodic
  // effort checks into the query via a trigger or explicit call.
  // However, for the primary mechanism we rely on the main thread timeout +
  // worker termination, which works for any query without modification.

  const stmt = db.prepare(sql);
  let result;

  const start = Date.now();

  switch (method) {
    case 'all':
      result = stmt.all(...(params || []));
      break;
    case 'get':
      result = stmt.get(...(params || []));
      break;
    case 'run':
      result = stmt.run(...(params || []));
      break;
    case 'iterate': {
      // Row-count based effort limiting via iterate
      const rows = [];
      const maxRows = effortLimit || Infinity;
      for (const row of stmt.iterate(...(params || []))) {
        rows.push(row);
        if (rows.length >= maxRows) {
          break;
        }
      }
      result = rows;
      break;
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }

  const elapsed = Date.now() - start;
  parentPort.postMessage({ success: true, result, elapsed });
} catch (err) {
  parentPort.postMessage({
    success: false,
    error: { message: err.message, code: err.code, stack: err.stack }
  });
} finally {
  if (db) {
    try { db.close(); } catch (_) { /* ignore close errors */ }
  }
}
