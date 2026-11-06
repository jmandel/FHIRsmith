'use strict';
// A FHIR CodeSystem whose concepts live in a sqlite-v2 block (docs/sqlite-v2-content-store.md §3).
//
// It is a CodeSystem (main's class) built from the block's resource without its concepts, so main's
// version, THO-precedence, supplement and read/search rules see the object they always see. The
// concept-tree methods main's FhirCodeSystemProvider calls are answered from SQLite and the block's
// sets, per call. Nothing is kept between calls: only the metadata and two load-time flags.

const { CodeSystem } = require('../../library/codesystem');
const { V2Store, KIND } = require('../store');
const { RoaringBitmap32 } = require('roaring');

// read from the file when used: the concepts, and the narrative (most of a small code system's size)
const LAZY = new Set(['concept', 'text']);

const ORD = 1048576; // group_id = parent position * ORD + child position (cs-blocks.js)

class StoredCodeSystem extends CodeSystem {
  /**
   * @param {ContentFile} file  the open content file (shared db and statements)
   * @param {object} row        its code_system row
   */
  /**
   * FhirCodeSystemProvider.create asks a CodeSystem for its provider first (cs-cs.js): the provider
   * that reads this block. A code system with its own provider class (cls is a registered subclass)
   * never gets here as a StoredCodeSystem (content-file.js loads those in memory); null then lets
   * the registry decide.
   */
  providerFactory(opContext, supplements, cls) {
    const { FhirCodeSystemProvider } = require('../../cs/cs-cs');
    if (cls !== FhirCodeSystemProvider) return null;
    const { StoredFhirProvider } = require('./stored-cs-provider');
    return new StoredFhirProvider(opContext, this, supplements);
  }

  constructor(file, row) {
    const resource = JSON.parse(row.resource);
    const meta = {};
    for (const k of Object.keys(resource)) if (!LAZY.has(k)) meta[k] = resource[k];
    super(meta, 'R5', true);
    Object.defineProperty(this, 'file', { value: file, enumerable: false });
    this.block = row.id;
    this.store = new V2Store(file.path, { db: file.db, block: row.id, stmts: file.stmts, unregistered: true });
    this._conceptCount = row.concept_count;
    this.lo = this.store.lo;
    this.hi = this.store.hi;
    this.hierPid = this.store.hierarchy ? this.store.hierarchy.id : -1;
    // the resource with `concept` back in its place, rebuilt from the rows whenever it is read
    const self = this;
    const json = {};
    for (const k of Object.keys(resource)) {
      if (LAZY.has(k)) {
        // concepts are rebuilt from their rows, the narrative read from the stored resource
        const get = k === 'concept' ? () => self.conceptTree() : () => JSON.parse(self.stmt('SELECT resource FROM code_system WHERE id = ?').get(self.block).resource)[k];
        Object.defineProperty(json, k, { enumerable: true, configurable: true, get, set(v) { Object.defineProperty(json, k, { value: v, enumerable: true, configurable: true, writable: true }); } });
      } else {
        json[k] = this.jsonObj[k] !== undefined ? this.jsonObj[k] : resource[k];
      }
    }
    for (const k of Object.keys(this.jsonObj)) if (!(k in json)) json[k] = this.jsonObj[k];
    this.jsonObj = json;
    this.codeMap = new StoredCodeMap(this);
    // load-time data (one indexed read each), not cache
    this._hasHierarchy = row.concept_count > 0 && !!this.stmt('SELECT 1 FROM concept_link WHERE property_id = ? LIMIT 1').get(this.hierPid);
    this.hasMultiHierarchy = this._hasHierarchy && !!this.stmt('SELECT 1 FROM concept_link WHERE property_id = ? AND group_id >= ? LIMIT 1').get(this.hierPid, ORD);
    // a hierarchy that is only the nesting: main's depth-first orders are then id order
    this.nestedOnly = !this._hasHierarchy || !this.stmt(`SELECT 1 FROM concept_link l JOIN concept_json j ON j.concept_id = l.source_id
      WHERE l.property_id = ? AND l.source_id BETWEEN ? AND ? AND (j.nest_parent IS NULL OR j.nest_parent != l.target_id) LIMIT 1`).get(this.hierPid, this.lo, this.hi);
  }

  stmt(sql) { return this.store.stmt(sql); }

  // ---- concepts ------------------------------------------------------------------------------

  _parse(json) {
    const c = JSON.parse(json);
    if (typeof c.concept === 'number') delete c.concept;
    return c;
  }

  /** exact (case-sensitive) id of a code, or null */
  idOf(code) {
    if (code == null) return null;
    const r = this.stmt('SELECT concept_id FROM concept WHERE code = ? AND concept_id BETWEEN ? AND ?').get(String(code), this.lo, this.hi);
    return r ? r.concept_id : null;
  }

  /** id as main's getConceptByCode finds it: lower-cased for case-insensitive systems (last one wins, as codeMapNC) */
  lookupId(code) {
    if (code == null) return null;
    if (!this.caseInsensitive()) return this.idOf(code);
    const lc = String(code).toLowerCase();
    let rows = this.stmt('SELECT concept_id, code FROM concept WHERE lower(code) = ? AND concept_id BETWEEN ? AND ?').all(lc, this.lo, this.hi);
    // SQLite's lower() folds ASCII only: a code with other letters is found by a scan of the
    // block's non-ASCII codes (rare: one THO v2 table has one)
    if (/[^\x00-\x7f]/.test(lc)) {
      rows = rows.concat(this.stmt("SELECT concept_id, code FROM concept WHERE code GLOB '*[^ -~]*' AND concept_id BETWEEN ? AND ?").all(this.lo, this.hi));
    }
    rows.sort((a, b) => b.concept_id - a.concept_id);
    const r = rows.find((x) => x.code.toLowerCase() === lc);
    return r ? r.concept_id : null;
  }

  conceptById(id) {
    if (id == null) return undefined;
    const r = this.stmt('SELECT json FROM concept_json WHERE concept_id = ?').get(id);
    return r ? this._parse(r.json) : undefined;
  }

  /** concepts for ids, in one statement: Map(id -> concept JSON) */
  conceptsByIds(ids) {
    const out = new Map();
    if (!ids.length) return out;
    for (const r of this.stmt('SELECT concept_id, json FROM concept_json WHERE concept_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(Array.from(ids)))) {
      out.set(r.concept_id, this._parse(r.json));
    }
    return out;
  }

  codesByIds(ids) {
    const out = new Map();
    if (!ids.length) return out;
    for (const r of this.stmt('SELECT concept_id, code FROM concept WHERE concept_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(Array.from(ids)))) out.set(r.concept_id, r.code);
    return out;
  }

  getConceptByCode(code) {
    return this.conceptById(this.lookupId(code));
  }

  getConceptByDisplay(display) {
    // main: the last concept with that display (displayMap)
    const r = this.stmt('SELECT concept_id FROM concept WHERE display = ? AND concept_id BETWEEN ? AND ? ORDER BY concept_id DESC LIMIT 1').get(display, this.lo, this.hi);
    return r ? this.conceptById(r.concept_id) : undefined;
  }

  hasCode(code) { return this.lookupId(code) != null; }

  conceptCount() { return this._conceptCount; }

  // ---- hierarchy (main's childToParentsMap / parentToChildrenMap order) ---------------------

  _parentIds(id) {
    return this.stmt('SELECT target_id, group_id FROM concept_link WHERE source_id = ? AND property_id = ? AND active = 1').all(id, this.hierPid)
      .sort((a, b) => a.group_id - b.group_id).map((r) => r.target_id);
  }

  _childIds(id) {
    const bm = this.store.getSet(KIND.prop, this.hierPid, id);
    if (!bm || !bm.size) return [];
    const ids = bm.toArray();
    const ord = new Map();
    for (const r of this.stmt('SELECT source_id, group_id FROM concept_link WHERE source_id IN (SELECT value FROM json_each(?)) AND property_id = ? AND target_id = ?').all(JSON.stringify(ids), this.hierPid, id)) {
      ord.set(r.source_id, r.group_id % ORD);
    }
    return ids.sort((a, b) => ord.get(a) - ord.get(b));
  }

  getChildren(parentCode) {
    const id = this.idOf(parentCode);
    if (id == null) return [];
    const kids = this._childIds(id);
    const codes = this.codesByIds(kids);
    return kids.map((k) => codes.get(k));
  }

  /** first parent code (main's parent(): getParents()[0]) for many ids, in one statement: Map(id -> code|null) */
  firstParentCodes(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const best = new Map();
    for (const r of this.stmt(`SELECT l.source_id AS s, l.group_id AS g, c.code AS code FROM concept_link l JOIN concept c ON c.concept_id = l.target_id
        WHERE l.source_id IN (SELECT value FROM json_each(?)) AND l.property_id = ? AND l.active = 1`).all(JSON.stringify(ids), this.hierPid)) {
      const b = best.get(r.s);
      if (!b || r.g < b.g) best.set(r.s, r);
    }
    for (const id of ids) out.set(id, best.has(id) ? best.get(id).code : null);
    return out;
  }

  getParents(childCode) {
    const id = this.idOf(childCode);
    if (id == null) return [];
    const ps = this._parentIds(id);
    const codes = this.codesByIds(ps);
    return ps.map((p) => codes.get(p));
  }

  /** main's getAncestors: the same walk (a stack over the parents lists) */
  getAncestors(code) {
    const ancestors = new Set();
    const visited = new Set([code]);
    const toProcess = [code];
    while (toProcess.length > 0) {
      const current = toProcess.pop();
      for (const parent of this.getParents(current)) {
        if (!visited.has(parent)) {
          visited.add(parent);
          ancestors.add(parent);
          toProcess.push(parent);
        }
      }
    }
    return Array.from(ancestors);
  }

  isDescendantOf(descendantCode, ancestorCode) {
    const a = this.idOf(ancestorCode);
    const d = this.idOf(descendantCode);
    if (a == null || d == null || a === d) return false;
    const bm = this.store.getSet(KIND.descendants, 0, a);
    return !!bm && bm.has(d);
  }

  /**
   * Descendant ids of `id` in main's getDescendants order (depth first over the children lists,
   * each concept once): the stored descendant set, and one read of the edges among its members.
   */
  descendantIdsInOrder(id) {
    const d = this.store.getSet(KIND.descendants, 0, id);
    if (!d || !d.size) return [];
    if (this.nestedOnly) return d.toArray(); // pre-order ids: the walk below gives the same list
    const members = d.toArray();
    const kids = new Map();
    const st = this.stmt('SELECT source_id, target_id, group_id FROM concept_link WHERE source_id IN (SELECT value FROM json_each(?)) AND property_id = ?');
    for (let i = 0; i < members.length; i += 20000) {
      for (const r of st.all(JSON.stringify(members.slice(i, i + 20000)), this.hierPid)) {
        let l = kids.get(r.target_id);
        if (!l) kids.set(r.target_id, l = []);
        l.push([r.group_id % ORD, r.source_id]);
      }
    }
    for (const l of kids.values()) l.sort((a, b) => a[0] - b[0]);
    const out = [];
    const seen = new Set([id]);
    const walk = (n) => {
      for (const [, c] of kids.get(n) || []) {
        if (seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        walk(c);
      }
    };
    walk(id);
    return out;
  }

  getDescendants(code) {
    const id = this.idOf(code);
    if (id == null) return [];
    const ids = this.descendantIdsInOrder(id);
    const codes = this.codesByIds(ids);
    return ids.map((i) => codes.get(i));
  }

  _codesOf(bm) {
    const ids = bm.toArray();
    const out = [];
    const st = this.stmt('SELECT code FROM concept WHERE concept_id IN (SELECT value FROM json_each(?)) ORDER BY concept_id').pluck();
    for (let i = 0; i < ids.length; i += 20000) out.push(...st.all(JSON.stringify(ids.slice(i, i + 20000))));
    return out;
  }

  getRootConcepts() {
    const has = this.store.getSet(KIND.hasProp, this.hierPid, 0);
    return this._codesOf(RoaringBitmap32.andNot(this.store.all(), has || new RoaringBitmap32()));
  }

  getLeafConcepts() {
    return this._codesOf(this.store.leaf());
  }

  getAllCodes() {
    return this.stmt('SELECT code FROM concept WHERE concept_id BETWEEN ? AND ? ORDER BY concept_id').pluck().all(this.lo, this.hi);
  }

  getAllConcepts() {
    return this.stmt('SELECT json FROM concept_json WHERE concept_id BETWEEN ? AND ? ORDER BY concept_id').pluck().all(this.lo, this.hi).map((j) => this._parse(j));
  }

  hasHierarchy() { return this._hasHierarchy; }

  buildMaps() { /* the maps are the block */ }

  /** the nested concept tree, as the resource had it */
  conceptTree() {
    const top = [];
    const byId = new Map();
    for (const r of this.stmt('SELECT concept_id, nest_parent, json FROM concept_json WHERE concept_id BETWEEN ? AND ? ORDER BY concept_id').all(this.lo, this.hi)) {
      const c = JSON.parse(r.json);
      if (typeof c.concept === 'number') c.concept = [];
      byId.set(r.concept_id, c);
      if (r.nest_parent == null) top.push(c);
      else byId.get(r.nest_parent).concept.push(c);
    }
    return top;
  }
}

/** the parts of main's codeMap (a Map) that callers use: get / has / size / keys / values */
class StoredCodeMap {
  constructor(cs) { this.cs = cs; }
  get(code) { const id = this.cs.idOf(code); return id == null ? undefined : this.cs.conceptById(id); }
  has(code) { return this.cs.idOf(code) != null; }
  get size() { return this.cs.conceptCount(); }
  keys() { return this.cs.getAllCodes()[Symbol.iterator](); }
  values() { return this.cs.getAllConcepts()[Symbol.iterator](); }
  [Symbol.iterator]() { const c = this.cs.getAllConcepts(); return c.map((x) => [x.code, x])[Symbol.iterator](); }
}

module.exports = { StoredCodeSystem, ORD };
