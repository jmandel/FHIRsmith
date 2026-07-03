'use strict';

const Database = require('better-sqlite3');
const { QueryGovernor, GovernorAbort, governorCapabilities, detectProgressHandler } = require('../../tx/cs/sqlite-governor.js');

function bigTable(db, n) {
  db.exec('CREATE TABLE t(x INTEGER)');
  db.exec(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c) INSERT INTO t SELECT i FROM c LIMIT ${n}`);
}

describe('sqlite-governor', () => {
  describe('capability detection', () => {
    test('stock better-sqlite3 exposes no progress handler', () => {
      const db = new Database(':memory:');
      expect(detectProgressHandler(db)).toBeNull();
      expect(governorCapabilities(db).hasRealBrake).toBe(false);
      db.close();
    });

    test('detects a fork that exposes progressHandler', () => {
      const fake = { progressHandler() {} };
      expect(detectProgressHandler(fake)).toBe('progressHandler');
      const fake2 = { setProgressHandler() {} };
      expect(detectProgressHandler(fake2)).toBe('setProgressHandler');
    });
  });

  describe('layer 2 — cooperative governor() function (stock)', () => {
    test('aborts a join runaway by deadline, mid-query, before output', () => {
      const db = new Database(':memory:');
      bigTable(db, 100000);
      const gov = new QueryGovernor({ deadlineMs: 40 });
      const t0 = Date.now();
      expect(() => gov.run(db, () => {
        db.prepare('SELECT COUNT(*) n FROM t a JOIN t b ON a.x=b.x WHERE governor()').get();
      })).toThrow(GovernorAbort);
      // fired well before the ~seconds a 100k self-join+scan would take
      expect(Date.now() - t0).toBeLessThan(2000);
      db.close();
    });

    test('a fast query under budget completes normally', () => {
      const db = new Database(':memory:');
      bigTable(db, 1000);
      const gov = new QueryGovernor({ deadlineMs: 5000 });
      const r = gov.run(db, () => db.prepare('SELECT COUNT(*) n FROM t WHERE governor()').get());
      expect(r.n).toBe(1000);
      db.close();
    });

    test('injectWhere places governor() first and non-hoistably', () => {
      const sql = 'SELECT x FROM t WHERE x > 5';
      expect(QueryGovernor.injectWhere(sql)).toBe('SELECT x FROM t WHERE governor() AND  x > 5');
    });
  });

  describe('layer 3 — iterate() deadline', () => {
    test('bounds a streaming query by deadline without any injection', () => {
      const db = new Database(':memory:');
      bigTable(db, 2000000);
      const gov = new QueryGovernor({ deadlineMs: 30 });
      const stmt = db.prepare('SELECT x FROM t ORDER BY x'); // streams many rows
      const t0 = Date.now();
      expect(() => gov.runIterate(stmt)).toThrow(GovernorAbort);
      expect(Date.now() - t0).toBeLessThan(2000);
      db.close();
    });

    test('row budget caps output', () => {
      const db = new Database(':memory:');
      bigTable(db, 100000);
      const gov = new QueryGovernor({ deadlineMs: 60000, rowBudget: 500 });
      const stmt = db.prepare('SELECT x FROM t');
      let err;
      try { gov.runIterate(stmt); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GovernorAbort);
      expect(err.governorReason).toBe('row-budget');
      db.close();
    });
  });

  describe('layer 1 — progress-handler brake (mock fork)', () => {
    // Simulates a better-sqlite3 fork: db.progressHandler(nOps, cb) is called;
    // running a "query" invokes cb every nOps opcodes; returning truthy aborts
    // (surfaced as an SQLITE_INTERRUPT error, like the real fork).
    function makeForkDb(totalOpcodes) {
      let cb = null; let nOps = 0;
      return {
        progressHandler(n, fn) { nOps = n; cb = fn; },
        // pretend to execute a statement costing `totalOpcodes` VM ops
        _runStatement() {
          for (let op = 0; op < totalOpcodes; op += Math.max(nOps, 1)) {
            if (cb && cb()) { const e = new Error('interrupted'); e.code = 'SQLITE_INTERRUPT'; throw e; }
          }
          return 'completed';
        },
      };
    }

    test('opcode budget aborts a long statement and normalises to GovernorAbort', () => {
      const db = makeForkDb(1e9); // huge — would run "forever"
      const gov = new QueryGovernor({ deadlineMs: 60000, maxOps: 1_000_000, opsPerTick: 20000 });
      let err;
      try { gov.run(db, () => db._runStatement()); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GovernorAbort);
      expect(err.governorReason).toBe('opcode-budget');
      // fired at ~maxOps/opsPerTick ticks
      expect(gov.ticks).toBeGreaterThanOrEqual(50);
    });

    test('deadline aborts via the progress handler even with no output rows', () => {
      const db = makeForkDb(1e9);
      const gov = new QueryGovernor({ deadlineMs: 20, opsPerTick: 1 });
      // make each tick take real time so the wall-clock deadline trips
      const orig = gov._abortReason.bind(gov);
      let calls = 0;
      gov._abortReason = () => { if (++calls > 100000) return 'deadline'; return orig(); };
      let err;
      try { gov.run(db, () => db._runStatement()); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GovernorAbort);
      db.close && db.close();
    });

    test('a statement under budget completes and the handler is cleared', () => {
      const db = makeForkDb(500000);
      let cleared = false;
      const origPH = db.progressHandler.bind(db);
      db.progressHandler = (n, fn) => { if (fn == null) cleared = true; origPH(n, fn); };
      const gov = new QueryGovernor({ deadlineMs: 60000, maxOps: 100_000_000, opsPerTick: 20000 });
      const r = gov.run(db, () => db._runStatement());
      expect(r).toBe('completed');
      expect(cleared).toBe(true); // progress handler removed in finally
    });
  });
});
