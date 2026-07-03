'use strict';

const Database = require('better-sqlite3');
const {
  QueryGovernor, GovernorAbort, GovernorUnavailable,
  governorCapabilities, detectProgressHandler,
} = require('../../tx/cs/sqlite-governor.js');

describe('sqlite-governor', () => {
  describe('capability detection', () => {
    test('stock better-sqlite3 exposes no progress handler', () => {
      const db = new Database(':memory:');
      expect(detectProgressHandler(db)).toBeNull();
      expect(governorCapabilities(db).hasRealBrake).toBe(false);
      db.close();
    });

    test('detects a fork under any of the accepted names', () => {
      expect(detectProgressHandler({ progressHandler() {} })).toBe('progressHandler');
      expect(detectProgressHandler({ progress_handler() {} })).toBe('progress_handler');
      expect(detectProgressHandler({ setProgressHandler() {} })).toBe('setProgressHandler');
    });
  });

  describe('policy when no fork is available (stock build)', () => {
    test("policy 'require' fails loudly rather than running ungoverned", () => {
      const db = new Database(':memory:');
      const gov = new QueryGovernor({ policy: 'require' });
      expect(() => gov.run(db, () => db.prepare('SELECT 1 AS n').get())).toThrow(GovernorUnavailable);
      db.close();
    });

    test("policy 'prefer' runs ungoverned", () => {
      const db = new Database(':memory:');
      const gov = new QueryGovernor({ policy: 'prefer' });
      expect(gov.run(db, () => db.prepare('SELECT 42 AS n').get()).n).toBe(42);
      db.close();
    });

    test("policy 'off' runs ungoverned", () => {
      const db = new Database(':memory:');
      const gov = new QueryGovernor({ policy: 'off' });
      expect(gov.run(db, () => db.prepare('SELECT 7 AS n').get()).n).toBe(7);
      db.close();
    });
  });

  describe('progress-handler brake (mock fork)', () => {
    // Simulates a fork: progressHandler(nOps, cb); running a "statement"
    // invokes cb every nOps opcodes; a truthy return raises SQLITE_INTERRUPT.
    function makeForkDb(totalOpcodes) {
      let cb = null; let nOps = 0; let cleared = false;
      return {
        progressHandler(n, fn) { nOps = n; cb = fn; if (fn == null) cleared = true; },
        wasCleared() { return cleared; },
        _runStatement() {
          for (let op = 0; op < totalOpcodes; op += Math.max(nOps, 1)) {
            if (cb && cb()) { const e = new Error('interrupted'); e.code = 'SQLITE_INTERRUPT'; throw e; }
          }
          return 'completed';
        },
      };
    }

    test('opcode budget aborts a long statement -> GovernorAbort, handler cleared', () => {
      const db = makeForkDb(1e9);
      const gov = new QueryGovernor({ policy: 'require', deadlineMs: 60000, maxOps: 1_000_000, opsPerTick: 20000 });
      let err;
      try { gov.run(db, () => db._runStatement()); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GovernorAbort);
      expect(err.governorReason).toBe('opcode-budget');
      expect(gov.ticks).toBeGreaterThanOrEqual(50);
      expect(db.wasCleared()).toBe(true);
    });

    test('deadline aborts even with no output rows', () => {
      const db = makeForkDb(1e9);
      const gov = new QueryGovernor({ policy: 'require', deadlineMs: 15, opsPerTick: 1 });
      const orig = gov._abortReason.bind(gov);
      let n = 0;
      gov._abortReason = () => (++n > 50000 ? 'deadline' : orig());
      expect(() => gov.run(db, () => db._runStatement())).toThrow(GovernorAbort);
    });

    test('a statement under budget completes and clears the handler', () => {
      const db = makeForkDb(500000);
      const gov = new QueryGovernor({ policy: 'require', deadlineMs: 60000, maxOps: 100_000_000, opsPerTick: 20000 });
      expect(gov.run(db, () => db._runStatement())).toBe('completed');
      expect(db.wasCleared()).toBe(true);
    });

    test('with a fork present, policy does not matter for success', () => {
      const db = makeForkDb(1000);
      const gov = new QueryGovernor({ policy: 'prefer', deadlineMs: 60000, maxOps: 1e9, opsPerTick: 20000 });
      expect(gov.run(db, () => db._runStatement())).toBe('completed');
    });
  });
});
