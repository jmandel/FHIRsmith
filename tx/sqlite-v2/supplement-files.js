'use strict';
// Server-known supplements on disk (docs/sqlite-v2-engine.md, "Supplements as layers").
//
// A supplement the server loads (a library.yml `file:`/`folder:` source, or one inside a loaded
// package) whose base is a sqlite-v2 terminology file is imported once into a small SQLite file
// in the v2 schema: <terminology-cache>/v2/supplements/<name>-<key>.db. The key is a hash of the
// importer's format, the supplement's content and the base file's identity (its provenance), so
// a changed supplement, a rebuilt base file or a new importer gives a new file; nothing is
// compared at request time. One file per (supplement, base file): its concepts carry that base
// file's concept_ids.
//
// The file holds two things:
//   - the layer (layers.js fillLayer): concepts, designations, property values as rows, and the
//     property values as stored sets, keyed by BASE concept_id. The engine opens it read-only
//     once per process (a V2Store) and evaluates supplement-property filters on it, exactly as
//     on an in-memory layer, with nothing built per request.
//   - the resource: supplement_concept (each concept's own JSON, in the resource's pre-order),
//     supplement_text (displays and designations, for the text filter), and supplement_info
//     (metadata JSON, and the facts upstream's helpers scan every concept for).
//
// In the library the in-memory CodeSystem is replaced by a DiskSupplement: main's CodeSystem
// class built from the metadata alone, whose concept methods (getConceptByCode, getAllConcepts,
// hasCode, codeMap, jsonObj.concept ...) read the file. Upstream's display and designation
// helpers (cs-api.js) therefore run unchanged on it; the sqlite-v2 provider answers the three
// helpers that scan every concept (_hasAnySupplementDisplays, _hasSupplementText,
// _supplementSearchCodes) from supplement_info / supplement_text instead (provider.js).
//
// Cluster (cluster.md, #342): the master builds a missing file (in a temporary file, renamed into
// place); a tx-worker (packageCachesReadOnly) only waits for it and opens it read-only.
//
// Per-request supplements (tx-resource) never come here: they keep the in-memory layer and its
// LRU (layers.js LayerCache).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { CodeSystem } = require('../library/codesystem');
const { V2Store } = require('./store');
const { fillLayer, Layer } = require('./layers');
const { settings } = require('./settings');

/** bump when the file layout or the import rules change: every file is then rebuilt */
const SUPPLEMENT_FORMAT = 2;

const DIR = path.join('v2', 'supplements');
// files no server has used for this long are removed by the master at startup
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

const EXTRA = `
CREATE TABLE supplement_info (key TEXT PRIMARY KEY, value TEXT);
-- every concept of the resource in pre-order (pos), as main's CodeSystem walks it; json is the
-- concept without its nested children, which are the rows whose nest_parent is its pos
CREATE TABLE supplement_concept (pos INTEGER PRIMARY KEY, nest_parent INTEGER, code TEXT NOT NULL,
  kids INTEGER NOT NULL, json TEXT NOT NULL);
-- main's codeMap: each code, the pos it is first seen at (the map's order) and the last concept
-- with it (the map's value); and codeMapNC (case-insensitive supplements): the same by lower case
CREATE TABLE supplement_code (code TEXT PRIMARY KEY, first INTEGER NOT NULL, last INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE supplement_code_nc (code TEXT PRIMARY KEY, last INTEGER NOT NULL) WITHOUT ROWID;
-- the texts upstream's text filter reads (_supplementSearchCodes), for the concepts of
-- getAllConcepts() in its order (ord); kind 0 = display, 1 = designation (language as given)
CREATE TABLE supplement_text (ord INTEGER NOT NULL, code TEXT NOT NULL, kind INTEGER NOT NULL, language TEXT, value TEXT NOT NULL);
`;
const EXTRA_INDEXES = `
CREATE INDEX supplement_concept_parent ON supplement_concept(nest_parent) WHERE nest_parent IS NOT NULL;
CREATE INDEX supplement_text_lang ON supplement_text(language, ord);
`;

// ---- identity -------------------------------------------------------------------------------

const baseIds = new WeakMap();

/** a base file's identity: its provenance and code_system row (concept ids are the importer's) */
function baseIdentity(store) {
  let id = baseIds.get(store);
  if (!id) {
    const h = crypto.createHash('sha256');
    let prov = [];
    try { prov = store.db.prepare('SELECT key, value FROM provenance ORDER BY key').raw().all(); } catch (e) { /* no provenance */ }
    if (!prov.length) {
      const st = fs.statSync(store.file);
      prov = [['file', store.file], ['size', st.size], ['mtime', st.mtimeMs]];
    }
    h.update(JSON.stringify(prov));
    h.update(JSON.stringify([store.system, store.version, store.conceptCount, store.activeCount]));
    id = h.digest('hex');
    baseIds.set(store, id);
  }
  return id;
}

/** a hash of a supplement's content: its metadata, then each top-level concept (no 100 MB string) */
function contentHashOf(json) {
  const h = crypto.createHash('sha256');
  const meta = {};
  for (const k of Object.keys(json)) if (k !== 'concept') meta[k] = json[k];
  h.update(JSON.stringify(meta));
  for (const c of json.concept || []) h.update('\n' + JSON.stringify(c));
  return h.digest('hex');
}

/** the file for a supplement over a base file */
function supplementFilePath(cacheFolder, json, base, hash) {
  const key = crypto.createHash('sha256').update(JSON.stringify([SUPPLEMENT_FORMAT, hash, baseIdentity(base)])).digest('hex').substring(0, 24);
  const name = String((json.url || 'supplement').replace(/^[a-z]+:\/\//, '') + (json.version ? '-' + json.version : '')).replace(/[^A-Za-z0-9._-]+/g, '_').substring(0, 120);
  return path.join(cacheFolder, DIR, `${name}-${key}.db`);
}

// ---- import ---------------------------------------------------------------------------------

/**
 * Write the file for one supplement over one base file (to a temporary file, renamed into place).
 * @param {V2Store} base
 * @param {CodeSystem} cs the in-memory supplement, as main loaded it
 * @param {string} dest
 * @param {string} hash its content hash
 * @returns {{ms: number, bytes: number, concepts: number, unknownCodes: number}}
 */
function writeSupplementFile(base, cs, dest, hash) {
  const t0 = Date.now();
  const json = cs.jsonObj;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.building-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  const db = new Database(tmp);
  try {
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    const { concepts, unknown } = fillLayer(db, base, json);
    db.exec(EXTRA);
    const ci = cs.caseInsensitive();
    const insC = db.prepare('INSERT INTO supplement_concept (pos, nest_parent, code, kids, json) VALUES (?, ?, ?, ?, ?)');
    const insK = db.prepare('INSERT INTO supplement_code (code, first, last) VALUES (?, ?, ?)');
    const insNC = db.prepare('INSERT INTO supplement_code_nc (code, last) VALUES (?, ?)');
    const insT = db.prepare('INSERT INTO supplement_text (ord, code, kind, language, value) VALUES (?, ?, ?, ?, ?)');
    const insI = db.prepare('INSERT INTO supplement_info (key, value) VALUES (?, ?)');
    db.transaction(() => {
      // the resource's concepts, in main's pre-order (CodeSystem._collectAllConcepts)
      let pos = 0;
      const keys = new Map(); // code -> [first, last]
      const nc = new Map();   // lower-cased code -> last
      const walk = (list, parent) => {
        for (const c of list || []) {
          const me = pos++;
          const kids = Array.isArray(c.concept) && c.concept.length ? c.concept : null;
          let own = c;
          if (kids) { own = { ...c }; delete own.concept; }
          const code = String(c.code);
          insC.run(me, parent, code, kids ? kids.length : 0, JSON.stringify(own));
          const k = keys.get(code);
          if (k) k[1] = me; else keys.set(code, [me, me]);
          if (ci) nc.set(code.toLowerCase(), me);
          if (kids) walk(kids, me);
        }
      };
      walk(json.concept, null);
      // in key order: compact b-trees
      const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      for (const [code, [first, last]] of [...keys].sort(byKey)) insK.run(code, first, last);
      for (const [code, last] of [...nc].sort(byKey)) insNC.run(code, last);
      // getAllConcepts(): main's codeMap values - one per code, in first-seen order, the last
      // concept with that code. The facts its scans look for are computed over the same list.
      const byCode = new Map();
      for (const c of concepts) byCode.set(c.code, c);
      let anyDisplay = false;
      const displayUses = new Map(); // JSON [language, use] -> true, for designations with a language
      const textLangs = new Set();   // languages of designations with a value (null = none given)
      let ord = 0;
      for (const c of byCode.values()) {
        if (c.display) { anyDisplay = true; insT.run(ord, c.code, 0, null, c.display); }
        for (const d of c.designation || []) {
          if (d.language) displayUses.set(JSON.stringify([d.language, d.use === undefined ? null : d.use]), true);
          if (d.value) { textLangs.add(d.language || null); insT.run(ord, c.code, 1, d.language || null, d.value); }
        }
        ord++;
      }
      const meta = {};
      for (const k of Object.keys(json)) if (k !== 'concept') meta[k] = json[k];
      const info = {
        format: SUPPLEMENT_FORMAT, contentHash: hash, base: baseIdentity(base), baseFile: base.file,
        baseSystem: base.system, baseVersion: base.version, url: json.url, version: json.version || null,
        conceptCount: cs.conceptCount(), distinctCodes: byCode.size, layerConcepts: concepts.length - unknown, unknownCodes: unknown,
        anyDisplay, displayUses: [...displayUses.keys()].map((k) => JSON.parse(k)), textLangs: [...textLangs],
        resource: meta, builtAt: new Date().toISOString()
      };
      for (const [k, v] of Object.entries(info)) insI.run(k, JSON.stringify(v));
    })();
    db.exec(EXTRA_INDEXES);
    db.exec('ANALYZE');
    db.close();
    fs.renameSync(tmp, dest);
    return { ms: Date.now() - t0, bytes: fs.statSync(dest).size, concepts: concepts.length - unknown, unknownCodes: unknown };
  } catch (e) {
    try { db.close(); } catch (e2) { /* closed */ }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** the file exists and is complete (a finished file is only ever renamed into place) */
function isReady(file) {
  if (!fs.existsSync(file)) return false;
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return JSON.parse(db.prepare("SELECT value FROM supplement_info WHERE key = 'format'").get().value) === SUPPLEMENT_FORMAT;
    } finally {
      db.close();
    }
  } catch (e) {
    return false;
  }
}

// ---- the resource, read from the file -------------------------------------------------------

/** one open supplement file: a read-only connection, its layer store, and its statements */
class SupplementFile {
  constructor(file) {
    this.path = file;
    this.store = new V2Store(file); // read-only, query_only, mmap: the same settings as base files
    this.db = this.store.db;
    this.info = Object.fromEntries(this.db.prepare('SELECT key, value FROM supplement_info').raw().all().map(([k, v]) => [k, JSON.parse(v)]));
    this.layer = new Layer(this.store, Object.freeze({ url: this.info.url, version: this.info.version, concepts: this.info.layerConcepts,
      unknownCodes: this.info.unknownCodes, buildMs: 0, bytes: 0, file, properties: Object.freeze([...this.store.props.keys()]) }));
  }

  stmt(sql) { return this.store.stmt(sql); }
}

/**
 * A server-known supplement whose concepts are in its file(s). A CodeSystem (main's class, as
 * provider.js and cs-api.js require), built from the metadata only; every concept method reads
 * the file, per call. What main's in-memory CodeSystem would return, the same objects in the same
 * order: a concept is its own JSON with its nested children rebuilt from the rows.
 */
class DiskSupplement extends CodeSystem {
  /**
   * @param {Map<V2Store, SupplementFile>} files one per base file the supplement applies to
   */
  constructor(files) {
    const first = files.values().next().value;
    super(JSON.parse(JSON.stringify(first.info.resource)), 'R5', true);
    Object.defineProperty(this, 'files', { value: files, enumerable: false });
    Object.defineProperty(this, 'file', { value: first, enumerable: false });
    this._conceptCount = first.info.conceptCount;
    // the maps are the file: own data properties, whether or not CodeSystem defers building its maps
    if (Object.prototype.hasOwnProperty.call(this, '_deferredMaps')) this._deferredMaps = null;
    for (const [k, v] of [['codeMap', new DiskCodeMap(this, false)], ['codeMapNC', this.caseInsensitive() ? new DiskCodeMap(this, true) : undefined]]) {
      Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true });
    }
    // jsonObj.concept: the nested concept tree, rebuilt from the rows whenever it is read (CodeSystem
    // read and search output, supplement-filters.js on providers other than sqlite-v2)
    const self = this;
    Object.defineProperty(this.jsonObj, 'concept', { enumerable: true, configurable: true, get: () => self.conceptTree(),
      set(v) { Object.defineProperty(self.jsonObj, 'concept', { value: v, enumerable: true, configurable: true, writable: true }); } });
  }

  /** the layer of this supplement over a base store, or null (no file for that base) */
  layerFor(base) {
    const f = this.files.get(base);
    return f ? f.layer : null;
  }

  /** load-time facts (supplement_info): see writeSupplementFile */
  get facts() { return this.file.info; }

  stmt(sql) { return this.file.stmt(sql); }

  _concept(row) {
    if (!row) return undefined;
    const c = JSON.parse(row.json);
    if (row.kids) c.concept = this._children(row.pos);
    return c;
  }

  _children(pos) {
    return this.stmt('SELECT pos, kids, json FROM supplement_concept WHERE nest_parent = ? ORDER BY pos').all(pos).map((r) => this._concept(r));
  }

  buildMaps() { /* the maps are the file */ }

  // main: the last concept with that code (codeMap / codeMapNC are filled in pre-order)
  _exact(code) {
    if (code == null) return undefined;
    return this._concept(this.stmt('SELECT c.pos, c.kids, c.json FROM supplement_code k JOIN supplement_concept c ON c.pos = k.last WHERE k.code = ?').get(String(code)));
  }

  _nc(code) {
    if (code == null) return undefined;
    return this._concept(this.stmt('SELECT c.pos, c.kids, c.json FROM supplement_code_nc k JOIN supplement_concept c ON c.pos = k.last WHERE k.code = ?').get(String(code).toLowerCase()));
  }

  getConceptByCode(code) {
    const memo = this._memo;
    if (memo) {
      // a request's view (forRequest): upstream's helpers ask for the same code several times
      let c = memo.get(code);
      if (c === undefined && !memo.has(code)) memo.set(code, c = this.caseInsensitive() ? this._nc(code) : this._exact(code));
      return c;
    }
    return this.caseInsensitive() ? this._nc(code) : this._exact(code);
  }

  /** read the concepts for many codes into this request's view, in one statement (provider.js _loadRows) */
  prefetch(codes) {
    const memo = this._memo;
    if (!memo) return;
    const want = [...new Set(codes.filter((c) => c != null && !memo.has(c)).map(String))];
    if (!want.length) return;
    const ci = this.caseInsensitive();
    const key = (c) => (ci ? c.toLowerCase() : c);
    const found = new Map();
    const st = this.stmt(`SELECT k.code AS k, c.pos, c.kids, c.json FROM ${ci ? 'supplement_code_nc' : 'supplement_code'} k
      JOIN supplement_concept c ON c.pos = k.last WHERE k.code IN (SELECT value FROM json_each(?))`);
    for (const r of st.all(JSON.stringify([...new Set(want.map(key))]))) found.set(r.k, r);
    for (const c of want) {
      const r = found.get(key(c));
      memo.set(c, r ? this._concept(r) : undefined);
    }
  }

  /**
   * This supplement for one request: the same object (its prototype), with the concepts the
   * request has read kept until it ends. main's CodeSystem hands back the same concept object
   * for a code every time; so does this view, within a request.
   */
  forRequest() {
    const view = Object.create(this);
    Object.defineProperty(view, '_memo', { value: new Map(), enumerable: false });
    return view;
  }

  getConceptByDisplay(display) {
    const row = this.stmt("SELECT pos, kids, json FROM supplement_concept WHERE json_extract(json, '$.display') = ? ORDER BY pos DESC LIMIT 1").get(display);
    return this._concept(row);
  }

  hasCode(code) {
    if (code == null) return false;
    return this.caseInsensitive()
      ? !!this.stmt('SELECT 1 FROM supplement_code_nc WHERE code = ?').get(String(code).toLowerCase())
      : !!this.stmt('SELECT 1 FROM supplement_code WHERE code = ?').get(String(code));
  }

  /** main's codeMap order: one per code, first-seen order, the last concept with the code */
  _distinct() {
    return this.stmt('SELECT c.pos, c.kids, c.json FROM supplement_code k JOIN supplement_concept c ON c.pos = k.last ORDER BY k.first');
  }

  getAllCodes() {
    return this.stmt('SELECT code FROM supplement_code ORDER BY first').pluck().all();
  }

  getAllConcepts() {
    return this._distinct().all().map((r) => this._concept(r));
  }

  /** the nested concept tree, as the resource had it */
  conceptTree() {
    const top = [];
    const byPos = new Map();
    for (const r of this.stmt('SELECT pos, nest_parent, kids, json FROM supplement_concept ORDER BY pos').all()) {
      const c = JSON.parse(r.json);
      if (r.kids) { c.concept = []; byPos.set(r.pos, c); }
      if (r.nest_parent == null) top.push(c);
      else byPos.get(r.nest_parent).concept.push(c);
    }
    return top;
  }

  /** main's in-memory CodeSystem for this resource, for the hierarchy methods (built per call) */
  _whole() {
    return new CodeSystem(JSON.parse(JSON.stringify(this.jsonObj)), 'R5');
  }

  getChildren(code) { return this._whole().getChildren(code); }
  getParents(code) { return this._whole().getParents(code); }
  getDescendants(code) { return this._whole().getDescendants(code); }
  getAncestors(code) { return this._whole().getAncestors(code); }
  isDescendantOf(d, a) { return this._whole().isDescendantOf(d, a); }
  getRootConcepts() { return this._whole().getRootConcepts(); }
  getLeafConcepts() { return this._whole().getLeafConcepts(); }
  hasHierarchy() { return this._whole().hasHierarchy(); }

  // ---- the facts upstream's scans look for (provider.js uses these for a DiskSupplement) ------

  /** cs-api _hasAnySupplementDisplays for this supplement alone */
  hasAnyDisplays(provider, languages) {
    const f = this.facts;
    if (f.anyDisplay && provider.resourceLanguageMatches(this.jsonObj, languages, false)) return true;
    const { Language } = require('../../library/languages');
    for (const [language, use] of f.displayUses) {
      if (!CodeSystem.isUseADisplay(use === null ? undefined : use)) continue;
      const designationLang = new Language(language);
      for (const requestedLang of languages) {
        if (designationLang.matchesForDisplay(requestedLang)) return true;
      }
    }
    return false;
  }

  /** cs-api _hasSupplementText for this supplement alone */
  hasText(provider, lang) {
    const { CodeSystemProvider } = require('../cs/cs-api');
    const suppLang = this.jsonObj.language || provider.defLang();
    const f = this.facts;
    if (f.anyDisplay && CodeSystemProvider.inSearchLanguage(suppLang, lang)) return true;
    return f.textLangs.some((l) => CodeSystemProvider.inSearchLanguage(l, lang, suppLang));
  }

  /** cs-api _supplementSearchCodes for this supplement alone: adds to `codes` */
  searchCodes(provider, filter, searchLang, codes) {
    const { CodeSystemProvider } = require('../cs/cs-api');
    const suppLang = this.jsonObj.language || provider.defLang();
    const displays = CodeSystemProvider.inSearchLanguage(suppLang, searchLang);
    const langs = this.facts.textLangs.filter((l) => CodeSystemProvider.inSearchLanguage(l, searchLang, suppLang));
    if (!displays && !langs.length) return;
    const named = langs.filter((l) => l !== null);
    const noLang = langs.includes(null);
    const rows = this.stmt(`SELECT code, value FROM supplement_text
      WHERE (kind = 0 AND ?) OR (kind = 1 AND (language IN (SELECT value FROM json_each(?)) OR (? AND language IS NULL)))
      ORDER BY ord, kind, rowid`).raw().iterate(displays ? 1 : 0, JSON.stringify(named), noLang ? 1 : 0);
    for (const [code, value] of rows) {
      if (!codes.has(code) && filter.passesAll(value)) codes.add(code);
    }
  }
}

/** the parts of main's codeMap (a Map) that callers use: get / has / size / keys / values */
class DiskCodeMap {
  constructor(cs, nc) { this.cs = cs; this.nc = nc; }
  get(code) { return this.nc ? this.cs._nc(code) : this.cs._exact(code); }
  has(code) { return this.get(code) !== undefined; }
  get size() { return this.cs.facts.distinctCodes; }
  keys() { return this.cs.getAllCodes()[Symbol.iterator](); }
  values() { return this.cs.getAllConcepts()[Symbol.iterator](); }
  [Symbol.iterator]() { return this.cs.getAllConcepts().map((x) => [x.code, x])[Symbol.iterator](); }
}

// ---- the library pass -----------------------------------------------------------------------

// the fields a DiskSupplement has its own of; every other field of the loaded resource is copied
const OWN = new Set(['jsonObj', 'codeMap', 'codeMapNC', 'displayMap', 'parentToChildrenMap', 'childToParentsMap', 'hasMultiHierarchy', '_conceptCount']);

const open = new Map(); // path -> SupplementFile (one connection per file per process)

function openFile(file) {
  let f = open.get(file);
  if (!f) open.set(file, f = new SupplementFile(file));
  return f;
}

/** the sqlite-v2 terminology factories a library has loaded, each once */
function v2Factories(library) {
  const { SqliteV2Factory } = require('./provider');
  return [...new Set(library.codeSystemFactories.values())].filter((f) => f instanceof SqliteV2Factory && f.store && f.layers);
}

/**
 * After a library has loaded every source: replace each server-known supplement whose base is a
 * loaded sqlite-v2 terminology file with a DiskSupplement over its file(s), building the files
 * that are missing (the master; a tx-worker waits for them). Returns what it did, for the log.
 *
 * @param {Library} library
 * @param {object} [opts] { readOnly (a tx-worker), log }
 */
async function useSupplementFiles(library, opts = {}) {
  const done = { files: 0, built: 0, supplements: 0, ms: 0 };
  if (!settings.supplementFiles) return done;
  const factories = v2Factories(library);
  if (!factories.length) return done;
  const t0 = Date.now();
  const used = new Set();
  for (const cp of library.codeSystemProviders) {
    const list = cp && cp.codeSystems;
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const cs = list[i];
      if (!(cs instanceof CodeSystem) || cs instanceof DiskSupplement || !cs.jsonObj || cs.jsonObj.content !== 'supplement') continue;
      if (!cs.jsonObj.supplements || !cs.conceptCount()) continue;
      const bases = factories.filter((f) => cs.isSupplementFor(f.system(), f.version()));
      if (!bases.length) continue;
      const hash = contentHashOf(cs.jsonObj);
      const files = new Map();
      for (const f of bases) {
        const file = supplementFilePath(library.cacheFolder, cs.jsonObj, f.store, hash);
        used.add(path.basename(file));
        if (!open.has(file)) {
          if (opts.readOnly) {
            const { waitForCache } = require('../library/wait-for-cache');
            await waitForCache(async () => isReady(file), `Supplement ${cs.vurl || cs.url}: sqlite-v2 supplement file ${file}`);
          } else if (!isReady(file)) {
            const r = writeSupplementFile(f.store, cs, file, hash);
            done.built++;
            if (opts.log) opts.log.info(`sqlite-v2 supplement file for ${cs.vurl || cs.url} over ${f.system()}|${f.version()}: ` +
              `${r.concepts} concepts (${r.unknownCodes} not in the base), ${(r.bytes / 1048576).toFixed(1)} MiB, built in ${r.ms} ms: ${file}`);
          } else {
            touch(file);
          }
        }
        files.set(f.store, openFile(file));
        done.files++;
      }
      const disk = new DiskSupplement(files);
      // what the library set on the resource it loaded (sourcePackage, ...)
      for (const k of Object.keys(cs)) if (!OWN.has(k)) disk[k] = cs[k];
      list[i] = disk;
      done.supplements++;
    }
  }
  if (!opts.readOnly) prune(library.cacheFolder, used, opts.log);
  done.ms = Date.now() - t0;
  return done;
}

function touch(file) {
  try { const now = new Date(); fs.utimesSync(file, now, now); } catch (e) { /* read-only cache */ }
}

/** the master: remove supplement files no server has used for STALE_MS, and abandoned builds */
function prune(cacheFolder, used, log) {
  const dir = path.join(cacheFolder, DIR);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (e) { return; }
  const cutoff = Date.now() - STALE_MS;
  for (const name of entries) {
    if (used.has(name)) continue;
    const file = path.join(dir, name);
    try {
      const building = /\.building-(\d+)$/.exec(name);
      const stale = building ? !pidAlive(Number(building[1])) : fs.statSync(file).mtimeMs < cutoff;
      if (stale) {
        fs.rmSync(file, { force: true });
        if (log) log.info(`Removed unused sqlite-v2 supplement file ${file}`);
      }
    } catch (e) { /* gone already */ }
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

module.exports = { useSupplementFiles, writeSupplementFile, DiskSupplement, SupplementFile, supplementFilePath, baseIdentity, contentHashOf,
  isReady, openFile, SUPPLEMENT_FORMAT };
