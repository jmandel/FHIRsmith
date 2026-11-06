'use strict';
// An open sqlite-v2 content file (a package version, or VSAC): one read-only connection and one
// statement map, shared by its code-system blocks.

const Database = require('better-sqlite3');
const { CodeSystem } = require('../../library/codesystem');
const { StoredCodeSystem } = require('./stored-codesystem');

class ContentFile {
  constructor(path) {
    this.path = path;
    this.db = new Database(path, { readonly: true, fileMustExist: true });
    this.db.pragma('query_only = 1');
    const { settings } = require('../settings');
    this.db.pragma(`cache_size = -${settings.sqliteCacheKB}`);
    this.db.pragma(`mmap_size = ${settings.mmapMB * 1048576}`);
    this.stmts = new Map();
  }

  close() { try { this.db.close(); } catch (e) { /* closed */ } }
}

const open = new Map();

function specialised(url) {
  const { FhirCodeSystemProvider, providerClassFor } = require('../../cs/cs-cs');
  return providerClassFor(url) !== FhirCodeSystemProvider;
}

/** the open ContentFile for a path (one connection per file per process) */
function contentFile(path) {
  let f = open.get(path);
  if (!f) open.set(path, f = new ContentFile(path));
  return f;
}

/**
 * The CodeSystems of a content file, as library.js loads a package's: StoredCodeSystem for every
 * stored block; a plain in-memory CodeSystem (from the stored resource) for supplements, for the
 * code systems the importer kept whole ('memory') and for those with a specialised provider (ICF).
 * @param {string} path
 * @param {object} [opts] { sourcePackage }
 * @returns {CodeSystem[]} in package order
 */
function loadStoredCodeSystems(path, opts = {}) {
  const f = contentFile(path);
  const mode = new Map(f.db.prepare("SELECT key, value FROM cs_config WHERE key LIKE 'block.%.mode'").all().map((r) => [Number(r.key.split('.')[1]), r.value]));
  const out = [];
  for (const row of f.db.prepare('SELECT * FROM code_system ORDER BY id').all()) {
    const m = mode.get(row.id) || 'stored';
    let cs;
    if (m !== 'stored') {
      cs = new CodeSystem(JSON.parse(row.resource));
    } else if (specialised(row.uri)) {
      // a code system with its own provider class (ICF, cs-cs.js providerClassFor) is written
      // against the in-memory resource (it compares concept objects by identity): rebuilt whole
      cs = new CodeSystem(JSON.parse(JSON.stringify(new StoredCodeSystem(f, row).jsonObj)));
    } else {
      cs = new StoredCodeSystem(f, row);
    }
    if (opts.sourcePackage) cs.sourcePackage = opts.sourcePackage;
    out.push(cs);
  }
  return out;
}

module.exports = { ContentFile, contentFile, loadStoredCodeSystems };
