'use strict';

const BetterSqlite3 = require('better-sqlite3');
const {
  clearSqliteProgressLimit,
  configureSqliteProgressLimit,
  parsePositiveInteger,
  registerRegexpFunction,
} = require('../../tx/cs/sqlite-v0-runtime');

describe('sqlite-v0 runtime helpers', () => {
  test('parsePositiveInteger accepts only positive safe integers', () => {
    expect(parsePositiveInteger('12')).toBe(12);
    expect(parsePositiveInteger(3)).toBe(3);
    expect(parsePositiveInteger('0')).toBeNull();
    expect(parsePositiveInteger('-1')).toBeNull();
    expect(parsePositiveInteger('1.5')).toBeNull();
    expect(parsePositiveInteger('abc')).toBeNull();
  });

  test('regexp function is registered for stock better-sqlite3 databases', () => {
    const db = new BetterSqlite3(':memory:');
    try {
      registerRegexpFunction(db);
      expect(db.prepare('SELECT regexp(?, ?) AS ok').get('^A', 'Alpha').ok).toBe(1);
      expect(db.prepare('SELECT regexp(?, ?) AS ok').get('^B', 'Alpha').ok).toBe(0);
    } finally {
      db.close();
    }
  });

  test('progress limit no-ops when stock better-sqlite3 has no progressHandler API', () => {
    const db = new BetterSqlite3(':memory:');
    try {
      const state = configureSqliteProgressLimit(db, { maxProgressCallbacks: 1, progressInterval: 1 });
      expect(state.supported).toBe(false);
      expect(state.enabled).toBe(false);
    } finally {
      db.close();
    }
  });

  test('progress limit uses custom better-sqlite3 progressHandler when available', () => {
    let intervalSeen = null;
    let handler = null;
    const fakeDb = {
      progressHandler(interval, fn) {
        if (arguments.length === 0) {
          intervalSeen = 0;
          handler = null;
          return this;
        }
        intervalSeen = interval;
        handler = fn;
        return this;
      },
    };

    const state = configureSqliteProgressLimit(fakeDb, { maxProgressCallbacks: 2, progressInterval: 50 });
    expect(state.supported).toBe(true);
    expect(state.enabled).toBe(true);
    expect(intervalSeen).toBe(50);
    expect(handler()).toBe(false);
    expect(handler()).toBe(false);
    expect(handler()).toBe(true);
    expect(state.callbacks).toBe(3);

    clearSqliteProgressLimit(fakeDb);
    expect(intervalSeen).toBe(0);
    expect(handler).toBeNull();
  });
});
