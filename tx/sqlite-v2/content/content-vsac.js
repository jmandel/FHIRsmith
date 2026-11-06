'use strict';
// VSAC on a sqlite-v2 content file (docs/sqlite-v2-content-store.md section 6).
//
// The sync is VSACValueSetProvider's, unchanged: it writes through ContentVsacDatabase, which
// keeps ValueSetDatabase's write interface over the content file (one transaction per value set,
// WAL, so readers see the old or the new value set and are never blocked). Reads go to
// ContentValueSetProvider on the same file. Nothing is held in memory: the sync's "seen this
// url|version / same hash" test is one indexed read.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { VSACValueSetProvider } = require('../../vs/vs-vsac');
const { ContentValueSetProvider } = require('./content-vs-provider');

const CACHE_COMPLETE_KEY = 'cache-complete';
const GENERATION_KEY = 'generation';

class ContentVsacDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.vsCount = 0;
  }

  _open() {
    if (!this.db) {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      const { ValueSetWriter } = require('../../importers/content-v2/vs-writer');
      this.writer = new ValueSetWriter(this.db);
      this.vsCount = this.db.prepare('SELECT count(*) AS n FROM value_set').get().n;
    }
    return this.db;
  }

  async exists() { return fs.existsSync(this.dbPath); }

  _writable() {
    return this._open();
  }

  async create() {
    const { createContentFile } = require('../../importers/content-v2/content-file');
    createContentFile(this.dbPath, { wal: true }).finish({ importer: 'content-v2 vsac (empty)', kind: 'vsac' });
    fs.chmodSync(this.dbPath, 0o600); // licensed content (UMLS): owner-only
    this._open();
  }

  async close() { if (this.db) { try { this.db.close(); } catch (e) { /* closed */ } this.db = null; } }

  // ---- sync bookkeeping (ValueSetDatabase) ----------------------------------------------------
  async startRun() {
    return Number(this._writable().prepare("INSERT INTO vsac_runs (started_at, status) VALUES (strftime('%s','now'), 'running')").run().lastInsertRowid);
  }
  async finishRun(id, totalFetched, totalNew, totalUpdated = 0) {
    this._writable().prepare(`UPDATE vsac_runs SET finished_at = strftime('%s','now'), status = 'ok',
      total_fetched = ?, total_new = ?, total_updated = ? WHERE id = ?`).run(totalFetched, totalNew, totalUpdated, id);
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }
  async failRun(id, message) {
    this._writable().prepare(`UPDATE vsac_runs SET finished_at = strftime('%s','now'), status = 'error', error_message = ? WHERE id = ?`).run(message, id);
  }
  async recordEvent(eventType, url, version, detail = null) {
    this._writable().prepare(`INSERT INTO vsac_events (timestamp, event_type, url, version, detail) VALUES (strftime('%s','now'), ?, ?, ?, ?)`)
      .run(eventType, url, version ?? null, detail);
  }
  async getSetting(key) {
    const r = this._open().prepare('SELECT value FROM vsac_settings WHERE key = ?').get(key);
    return r ? r.value : null;
  }
  async setSetting(key, value) {
    this._writable().prepare('INSERT INTO vsac_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  async deleteSetting(key) {
    this._writable().prepare('DELETE FROM vsac_settings WHERE key = ?').run(key);
  }
  async getLastRun() {
    return this._open().prepare('SELECT id, status, started_at, finished_at FROM vsac_runs ORDER BY id DESC LIMIT 1').get() || null;
  }
  async markInterruptedRuns() {
    return this._writable().prepare(`UPDATE vsac_runs SET finished_at = strftime('%s','now'), status = 'error',
      error_message = 'interrupted (server stopped during the sync)' WHERE status = 'running'`).run().changes;
  }
  async isComplete() { return (await this.getSetting(CACHE_COMPLETE_KEY)) != null; }
  async markComplete() { await this.setSetting(CACHE_COMPLETE_KEY, new Date().toISOString()); }

  // ---- value sets -------------------------------------------------------------------------------
  async upsertValueSet(valueSet, contentHash = null) {
    this._writable();
    const existed = this.writer.s.byId.get(valueSet.id);
    this.writer.put(valueSet, { contentHash });
    if (!existed) this.vsCount++;
  }
  async seeValueSet(valueSet) {
    this._writable().prepare("UPDATE value_set SET last_seen = strftime('%s','now') WHERE url = ? AND version = ?").run(valueSet.url, valueSet.version);
  }
  async setContentHash(id, hash) {
    this._writable().prepare('UPDATE value_set SET content_hash = ? WHERE id = ?').run(hash, id);
  }
  async deleteOldValueSets(cutoffTimestamp) {
    this._writable();
    const ids = this.db.prepare('SELECT id FROM value_set WHERE last_seen < ?').pluck().all(cutoffTimestamp);
    for (const id of ids) this.writer.remove(id);
    this.vsCount -= ids.length;
    return ids.length;
  }
  /** the sync's "have we got this url|version" test: undefined, or { id, content_hash } */
  async getVersion(url, version) {
    return this._open().prepare('SELECT id, content_hash FROM value_set WHERE url = ? AND version = ?').get(url, version);
  }
  /** every url|version held (phase 1 of the sync queues the ones VSAC has and this hasn't) */
  async listVersionKeys() {
    return new Set(this._open().prepare('SELECT url, version FROM value_set WHERE version IS NOT NULL').raw().all()
      .map(([url, version]) => `${url}|${version}`));
  }
  async countValueSets() {
    const row = this._open().prepare('SELECT COUNT(*) AS total, COUNT(DISTINCT url) AS urls FROM value_set').get();
    this.vsCount = row.total;
    return row;
  }
  async getStatistics() {
    const db = this._open();
    const byStatus = {};
    for (const r of db.prepare('SELECT status, COUNT(*) AS count FROM value_set GROUP BY status').all()) byStatus[r.status || 'null'] = r.count;
    return {
      totalValueSets: db.prepare('SELECT COUNT(*) AS total FROM value_set').get().total,
      byStatus,
      totalSystems: db.prepare('SELECT COUNT(DISTINCT system) AS systems FROM vs_system').get().systems,
    };
  }
  async listAllValueSets() { return this._open().prepare('SELECT url FROM value_set ORDER BY url').pluck().all(); }

  /** sqlite3-style handle for VSACValueSetProvider.info() (it reads vsac_events / vsac_runs) */
  async _getReadConnection() {
    const db = this._open();
    // the callback runs once, outside the try: one that throws must not be called again with
    // its own error (as guarded() keeps sqlite3 callbacks, PR #347)
    const call = (fn, cb) => {
      let rows;
      try {
        rows = fn();
      } catch (e) {
        return cb(e);
      }
      return cb(null, rows);
    };
    return {
      all: (sql, params, cb) => call(() => db.prepare(sql).all(...(params || [])), cb),
      get: (sql, params, cb) => call(() => db.prepare(sql).get(...(params || [])), cb),
    };
  }
}

class ContentVsacProvider extends VSACValueSetProvider {
  constructor(config, stats) {
    super(config, stats);
    this.legacyPath = this.dbPath;
    this.dbPath = path.join(this.cacheFolder, 'vsac-v2.db');
    this.database = new ContentVsacDatabase(this.dbPath);
    this.reader = new ContentValueSetProvider(this.dbPath, { kind: 'vsac', source: 'vsac' });
  }

  async initialize() {
    if (this.initialized) return;
    if (!fs.existsSync(this.dbPath) && fs.existsSync(this.legacyPath)) {
      // one-time conversion of an existing ValueSetDatabase (e.g. a seeded master copy)
      const { importVsac } = require('../../importers/content-v2/import-content-v2');
      importVsac(this.legacyPath, this.dbPath, (m) => this.log.info(`VSAC content file: ${m}`));
    }
    await super.initialize();
  }

  /** before a read */
  async _ready() {
    await this.initialize();
    return true;
  }

  /** after a sync: the reader asks the file every time; only its count is held */
  async _refreshFromDatabase() {
    if (this.reader.initialized) {
      this.reader.count = this.reader.s.count.get().n;
    }
    await this._recount();
  }

  prefixIds() { this.reader.spaceId = this.spaceId; }

  async fetchValueSet(url, version, opContext) {
    if (!(await this._ready())) return null;
    return this.reader.fetchValueSet(url, version, opContext);
  }
  async fetchValueSetById(id) {
    if (!(await this._ready())) return null;
    return this.reader.fetchValueSetById(id);
  }
  async searchValueSets(searchParams, elements) {
    if (!(await this._ready())) return [];
    this._validateSearchParams(searchParams);
    if (searchParams.length === 0) return [];
    return this.reader.searchValueSets(searchParams, elements);
  }
  async listAllValueSets() {
    if (!(await this._ready())) return [];
    return this.reader.listAllValueSets();
  }
  async scanAllValueSets(fn) {
    if (!(await this._ready())) return;
    await this.reader.scanAllValueSets(fn);
  }
  async scanUsage(tracker) {
    if (!(await this._ready())) return 0;
    await this.reader.initialize();
    return this.reader.scanUsage(tracker);
  }
  count() { return this.database.vsCount; }
  vsCount() { return this.database.vsCount; }
  getMapSize() { return this.reader.initialized ? this.reader.db.prepare('SELECT count(DISTINCT url) AS n FROM value_set').get().n : this.urlCount; }
  async close() { this.stopRefreshTimer(); await this.reader.close(); await this.database.close(); }
}

module.exports = { ContentVsacProvider, ContentVsacDatabase };
