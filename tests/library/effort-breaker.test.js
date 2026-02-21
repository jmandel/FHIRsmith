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

describe('EffortBreakerDb', () => {
  let dbPath;

  beforeAll(() => {
    dbPath = seedTestDb(tmpDbPath());
  });

  afterAll(() => {
    try { fs.unlinkSync(dbPath); } catch (_) { /* ignore */ }
  });

  test('all() returns all matching rows', async () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, effortLimitMs: 10000 });
    try {
      const rows = await db.all('SELECT * FROM items WHERE id <= ?', [10]);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(10);
      expect(rows[0]).toHaveProperty('id');
      expect(rows[0]).toHaveProperty('name');
      expect(rows[0]).toHaveProperty('value');
    } finally {
      db.close();
    }
  });

  test('get() returns a single row', async () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, effortLimitMs: 10000 });
    try {
      const row = await db.get('SELECT * FROM items WHERE id = ?', [1]);
      expect(row).toBeDefined();
      expect(row.id).toBe(1);
      expect(row.name).toBe('item_0');
    } finally {
      db.close();
    }
  });

  test('get() returns undefined for no match', async () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, effortLimitMs: 10000 });
    try {
      const row = await db.get('SELECT * FROM items WHERE id = ?', [99999]);
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('run() executes write statements', async () => {
    const writableDbPath = seedTestDb(tmpDbPath());
    const db = new EffortBreakerDb(writableDbPath, { effortLimitMs: 10000 });
    try {
      const result = await db.run(
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

  test('iterateWithLimit() respects row limit', async () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, effortLimitMs: 10000 });
    try {
      const rows = await db.iterateWithLimit(
        'SELECT * FROM items', [], 5
      );
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(5);
    } finally {
      db.close();
    }
  });

  test('rejects after close()', async () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, effortLimitMs: 10000 });
    db.close();
    await expect(db.all('SELECT 1')).rejects.toThrow('Database is closed');
  });

  test('rejects with error for invalid SQL', async () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true, effortLimitMs: 10000 });
    try {
      await expect(db.all('SELECT * FROM nonexistent_table'))
        .rejects.toThrow();
    } finally {
      db.close();
    }
  });

  test('effort limit triggers EffortLimitExceededError', async () => {
    // Create a db with a very expensive query and a very short timeout
    const heavyDbPath = tmpDbPath();
    const Database = require('better-sqlite3');
    const heavyDb = new Database(heavyDbPath);
    heavyDb.exec(`
      CREATE TABLE big (id INTEGER PRIMARY KEY, data TEXT);
    `);
    const insert = heavyDb.prepare('INSERT INTO big (data) VALUES (?)');
    const bulkInsert = heavyDb.transaction(() => {
      for (let i = 0; i < 50000; i++) {
        insert.run('x'.repeat(200));
      }
    });
    bulkInsert();
    heavyDb.close();

    const db = new EffortBreakerDb(heavyDbPath, {
      readonly: true,
      effortLimitMs: 1, // 1ms - virtually impossible for any query to complete
    });

    try {
      await expect(
        db.all('SELECT b1.data, b2.data FROM big b1, big b2 LIMIT 100000000')
      ).rejects.toThrow();
    } finally {
      db.close();
      try { fs.unlinkSync(heavyDbPath); } catch (_) { /* ignore */ }
    }
  }, 15000);

  test('EffortLimitExceededError has expected properties', () => {
    const err = new EffortLimitExceededError(5000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EffortLimitExceededError');
    expect(err.code).toBe('EFFORT_LIMIT_EXCEEDED');
    expect(err.limitMs).toBe(5000);
    expect(err.message).toContain('5000ms');
  });

  test('default effortLimitMs allows queries to complete', async () => {
    const db = new EffortBreakerDb(dbPath, { readonly: true });
    try {
      const rows = await db.all('SELECT * FROM items LIMIT 1');
      expect(rows.length).toBe(1);
    } finally {
      db.close();
    }
  });
});
