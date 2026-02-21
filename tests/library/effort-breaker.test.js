'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EffortBreakerDb, EffortLimitExceededError } = require('../../library/effort-breaker');

function tmpDbPath() {
  return path.join(os.tmpdir(), `effort-breaker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// Use better-sqlite3 directly to seed a test database
function seedTestDb(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, value REAL);
  `);
  const insert = db.prepare('INSERT INTO items (name, value) VALUES (?, ?)');
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row.name, row.value);
  });
  const rows = [];
  for (let i = 0; i < 1000; i++) {
    rows.push({ name: `item_${i}`, value: Math.random() * 100 });
  }
  insertMany(rows);
  db.close();
  return dbPath;
}

describe('better-sqlite3 progressHandler (native)', () => {
  test('progressHandler is exposed on Database prototype', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    expect(typeof db.progressHandler).toBe('function');
    db.close();
  });

  test('progress callback counts VM steps during query execution', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    const insert = db.prepare('INSERT INTO t (val) VALUES (?)');
    for (let i = 0; i < 1000; i++) insert.run('item_' + i);

    let stepCount = 0;
    db.progressHandler(1000, () => {
      stepCount += 1000;
      return 0;
    });

    db.prepare('SELECT * FROM t WHERE val LIKE ?').all('%item_5%');
    expect(stepCount).toBeGreaterThan(0);
    db.close();
  });

  test('returning truthy from callback interrupts the query', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    const insert = db.prepare('INSERT INTO t (val) VALUES (?)');
    for (let i = 0; i < 5000; i++) insert.run('item_' + i);

    let stepCount = 0;
    db.progressHandler(1000, () => {
      stepCount += 1000;
      return stepCount > 3000 ? 1 : 0;
    });

    expect(() => {
      db.prepare('SELECT a.val, b.val FROM t a, t b LIMIT 100000000').all();
    }).toThrow(/interrupt/i);
    db.close();
  });

  test('removing the handler allows queries to proceed', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO t VALUES (1)').run();

    // Install then remove handler
    db.progressHandler(1, () => 1); // would always interrupt
    db.progressHandler(); // remove it

    // This should succeed now
    const row = db.prepare('SELECT * FROM t').get();
    expect(row.id).toBe(1);
    db.close();
  });
});

describe('EffortBreakerDb', () => {
  let dbPath;

  beforeAll(() => {
    dbPath = seedTestDb(tmpDbPath());
  });

  afterAll(() => {
    try { fs.unlinkSync(dbPath); } catch (_) { /* ignore */ }
  });

  test('all() returns all matching rows', () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, maxVmSteps: 1000000 });
    try {
      const rows = db.all('SELECT * FROM items WHERE id <= ?', [10]);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(10);
      expect(rows[0]).toHaveProperty('id');
      expect(rows[0]).toHaveProperty('name');
      expect(rows[0]).toHaveProperty('value');
    } finally {
      db.close();
    }
  });

  test('get() returns a single row', () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, maxVmSteps: 1000000 });
    try {
      const row = db.get('SELECT * FROM items WHERE id = ?', [1]);
      expect(row).toBeDefined();
      expect(row.id).toBe(1);
      expect(row.name).toBe('item_0');
    } finally {
      db.close();
    }
  });

  test('get() returns undefined for no match', () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, maxVmSteps: 1000000 });
    try {
      const row = db.get('SELECT * FROM items WHERE id = ?', [99999]);
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('run() executes write statements', () => {
    const writableDbPath = seedTestDb(tmpDbPath());
    const db = new EffortBreakerDb(writableDbPath, { maxVmSteps: 1000000 });
    try {
      const result = db.run(
        'INSERT INTO items (name, value) VALUES (?, ?)',
        ['new_item', 42.0]
      );
      expect(result).toHaveProperty('changes', 1);
      expect(result).toHaveProperty('lastInsertRowid');
    } finally {
      db.close();
      try { fs.unlinkSync(writableDbPath); } catch (_) { /* ignore */ }
    }
  });

  test('iterateWithLimit() respects row limit', () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, maxVmSteps: 1000000 });
    try {
      const rows = db.iterateWithLimit(
        'SELECT * FROM items', [], 5
      );
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(5);
    } finally {
      db.close();
    }
  });

  test('throws after close()', () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true });
    db.close();
    expect(() => db.all('SELECT 1')).toThrow();
  });

  test('throws for invalid SQL', () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, maxVmSteps: 1000000 });
    try {
      expect(() => db.all('SELECT * FROM nonexistent_table')).toThrow();
    } finally {
      db.close();
    }
  });

  test('effort limit triggers EffortLimitExceededError for expensive query', () => {
    const heavyDbPath = tmpDbPath();
    const Database = require('better-sqlite3');
    const heavyDb = new Database(heavyDbPath);
    heavyDb.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, data TEXT)');
    const insert = heavyDb.prepare('INSERT INTO big (data) VALUES (?)');
    const bulkInsert = heavyDb.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        insert.run('x'.repeat(100));
      }
    });
    bulkInsert();
    heavyDb.close();

    const db = new EffortBreakerDb(heavyDbPath, {
      readonly: true,
      maxVmSteps: 5000, // very low limit
      progressInterval: 1000,
    });

    try {
      expect(() => {
        db.all('SELECT b1.data, b2.data FROM big b1, big b2 LIMIT 100000000');
      }).toThrow(EffortLimitExceededError);
    } finally {
      db.close();
      try { fs.unlinkSync(heavyDbPath); } catch (_) { /* ignore */ }
    }
  });

  test('EffortLimitExceededError has expected properties', () => {
    const err = new EffortLimitExceededError(50000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EffortLimitExceededError');
    expect(err.code).toBe('EFFORT_LIMIT_EXCEEDED');
    expect(err.vmSteps).toBe(50000);
    expect(err.message).toContain('50000');
    expect(err.message).toContain('VM steps');
  });

  test('default maxVmSteps allows normal queries to complete', () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true });
    try {
      const rows = db.all('SELECT * FROM items LIMIT 1');
      expect(rows.length).toBe(1);
    } finally {
      db.close();
    }
  });

  test('getDatabase() returns the underlying better-sqlite3 instance', () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true });
    try {
      const inner = db.getDatabase();
      expect(inner.open).toBe(true);
      expect(inner.readonly).toBe(true);
    } finally {
      db.close();
    }
  });
});
