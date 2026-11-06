'use strict';
// Creating a sqlite-v2 content file: the schema of every sqlite-v2 file (schema-v2.sql), file
// identity (file_uuid) and provenance. Used by the package and VSAC importers.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { SCHEMA_VERSION } = require('../sqlite-v2/builder');

const SCHEMA_PATH = path.join(__dirname, '..', 'sqlite-v2', 'schema-v2.sql');

function schemaParts() {
  const ddl = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const [tables, indexes] = ddl.split(/^-- @indexes.*$/m);
  return { tables, indexes };
}

/**
 * A new content file at `dest` (replaced). Tables are created now, indexes by finish().
 * @returns {{db, finish(prov): object}}
 */
function createContentFile(dest, { overwrite = true, wal = false } = {}) {
  dest = path.resolve(dest);
  if (fs.existsSync(dest)) {
    if (!overwrite) throw new Error(`Destination exists: ${dest}`);
    for (const ext of ['', '-wal', '-shm', '-journal']) fs.rmSync(dest + ext, { force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.building';
  for (const ext of ['', '-wal', '-shm', '-journal']) fs.rmSync(tmp + ext, { force: true });
  const db = new Database(tmp);
  db.pragma('page_size = 4096');
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -200000');
  const { tables, indexes } = schemaParts();
  db.exec(tables);
  const t0 = Date.now();
  return {
    db,
    /** indexes, provenance, ANALYZE */
    finish(prov = {}) {
      const t1 = Date.now();
      db.exec(indexes);
      const timings = { load: (t1 - t0) / 1000, indexes: (Date.now() - t1) / 1000 };
      const ins = db.prepare('INSERT OR REPLACE INTO provenance VALUES (?, ?)');
      const all = {
        schemaVersion: String(SCHEMA_VERSION),
        fileUuid: crypto.randomUUID(),
        builtAt: new Date().toISOString(),
        node: process.version,
        roaringFormat: 'portable',
        ...prov,
        timings: JSON.stringify({ ...timings, ...(prov.timings || {}) }),
      };
      for (const [k, v] of Object.entries(all)) ins.run(k, typeof v === 'string' ? v : JSON.stringify(v));
      db.exec('ANALYZE');
      // VSAC is written in place by its sync (WAL: readers never blocked); a package file never changes
      db.pragma(`journal_mode = ${wal ? 'WAL' : 'DELETE'}`);
      db.close();
      fs.renameSync(tmp, dest);
      return { file: dest, bytes: fs.statSync(dest).size, timings };
    }
  };
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

module.exports = { createContentFile, schemaParts, sha256File, SCHEMA_PATH };
