'use strict';
// The sqlite-v2 content file of an npm package: <terminology-cache>/v2/<package>#<version>.db,
// built on first load (as main builds .valuesets-2.db) and rebuilt when the package or the
// importer changes (provenance: package files' sha256, contentFormat).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { CONTENT_FORMAT } = require('../../importers/content-v2/import-content-v2');

function provenanceOf(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(db.prepare('SELECT key, value FROM provenance').raw().all());
  } finally {
    db.close();
  }
}

/** the content file is there and was built from these package files by this importer */
function isCurrent(file, srcs) {
  const { sha256File } = require('../../importers/content-v2/content-file');
  if (!fs.existsSync(file)) return false;
  try {
    const p = provenanceOf(file);
    const had = JSON.parse(p.sources || '[]').map((s) => s.sha256).join(',');
    const now = srcs.map((f) => sha256File(f)).join(',');
    return p.contentFormat === CONTENT_FORMAT && had === now;
  } catch (e) {
    return false; // unreadable: rebuild
  }
}

/**
 * @param {string} cacheFolder terminology-cache
 * @param {string} packageFolder the unpacked package (contains package/)
 * @param {string} pid package#version
 * @param {object} [log]
 * @param {object} [opts] { readOnly: a tx-worker (cluster.md) - wait for the master to build
 *   the file, never build it }
 * @returns {Promise<string>} the content file
 */
async function ensurePackageContentFile(cacheFolder, packageFolder, pid, log, opts = {}) {
  const file = path.join(cacheFolder, 'v2', pid.replace(/[^A-Za-z0-9.#_-]/g, '_') + '.db');
  const srcs = ['package/package.json', 'package/.index.json'].map((f) => path.join(packageFolder, f)).filter((f) => fs.existsSync(f));
  if (opts.readOnly) {
    // the master builds it in a temporary file and renames it into place (createContentFile)
    const { waitForCache } = require('../../library/wait-for-cache');
    await waitForCache(async () => isCurrent(file, srcs), `Package ${pid}: sqlite-v2 content file ${file}`);
    return file;
  }
  if (isCurrent(file, srcs)) return file;
  const { importPackage } = require('../../importers/content-v2/import-content-v2');
  const t0 = Date.now();
  await importPackage(packageFolder, file, () => {});
  if (log) log.info(`sqlite-v2 content file for ${pid} built in ${Date.now() - t0} ms: ${file}`);
  return file;
}

module.exports = { ensurePackageContentFile, CONTENT_FORMAT, provenanceOf };
