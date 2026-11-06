'use strict';
// One sqlite-v2 file (one release of one code system), opened read-only.
//
// The store is the only code that talks SQL. SQLite holds facts (rows); the Roaring bitmaps in
// concept_set answer every membership question. Everything here is batched: sets are loaded per
// (kind, property) with one statement for any number of keys, page rows with one statement per
// table, and every statement is prepared once.
//
// Schema and semantics: docs/sqlite-v2-schema.md.

const Database = require('better-sqlite3');
const { RoaringBitmap32 } = require('roaring');

const KIND = Object.freeze({ all: 1, active: 2, leaf: 3, descendants: 4, prop: 5, hasProp: 6, refset: 7 });

let ownerSeq = 0;

/** every open store and engine, for /sqlite-v2/stats */
const registry = { stores: new Set(), engines: new Set() };

const EMPTY = Object.freeze(new RoaringBitmap32());

/** term -> true when every word's Porter stem is the stem of a word of the term */
function stemMatcher(words) {
  const { PorterStemmer } = require('natural/lib/natural/stemmers');
  const want = words.map((w) => PorterStemmer.stem(w));
  return (term) => {
    const have = new Set(String(term || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => PorterStemmer.stem(w)));
    return want.every((w) => have.has(w));
  };
}

/**
 * Count one statement in a trace's counters (stats is the tracer's; callers check it is set).
 * With a trace, the tracer also records what the statement read: database, table, index and
 * statement shape (trace.js).
 */
function count(stats, store, st, rows) {
  stats.statements++;
  stats.rows += rows;
  if (stats.read) stats.read(store, st, rows);
}

function setKey(kind, pid, value) {
  return kind + ':' + pid + ':' + (typeof value === 'string' ? 's' + value : value);
}

class V2Store {
  /**
   * @param {string} file path, or ':memory:' style handle for a layer
   * @param {object} [opts] { db: an already open better-sqlite3 handle, setCacheBytes, readonly,
   *   block: the code_system id this store serves (default 1; a package file has one block per
   *   CodeSystem), stmts: a statement map shared by the blocks of one file }
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.db = opts.db || new Database(file, { readonly: true, fileMustExist: true });
    if (!opts.db) {
      this.db.pragma('query_only = 1');
      // a small SQLite page cache per connection; reads go through mmap and the OS page cache
      const { settings } = require('./settings');
      this.db.pragma(`cache_size = -${settings.sqliteCacheKB}`);
      this.db.pragma(`mmap_size = ${settings.mmapMB * 1048576}`);
    }
    this._stmts = opts.stmts || new Map();
    this.block = opts.block || 1;
    this.uid = ++ownerSeq;
    this._loadMeta();
    if (!opts.unregistered) registry.stores.add(this);
  }

  close() {
    registry.stores.delete(this);
    try { this.db.close(); } catch (e) { /* already closed */ }
  }

  /**
   * Run a whole-table read (load-time data) through SQLite's page cache instead of the mmap
   * window, so it does not leave hundreds of MiB of the file mapped into the process.
   */
  withoutMmap(fn) {
    const before = this.db.pragma('mmap_size', { simple: true });
    this.db.pragma('mmap_size = 0');
    try {
      return fn();
    } finally {
      this.db.pragma(`mmap_size = ${before}`);
    }
  }

  stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  // ---- metadata ---------------------------------------------------------------------------

  _loadMeta() {
    const cs = this.db.prepare('SELECT * FROM code_system WHERE id = ?').get(this.block);
    if (!cs) throw new Error(`${this.file}: no code_system row ${this.block} (not a sqlite-v2 file?)`);
    this.cs = cs;
    this.system = cs.uri;
    this.version = cs.version;
    this.conceptCount = cs.concept_count;
    this.activeCount = cs.active_count;
    // block bounds: this store's concepts are lo..hi. A terminology file is one block (lo = 1).
    // Package blocks (FHIR CodeSystems, `resource` set) key their all/active/leaf sets by block id.
    this.lo = (cs.id_base || 0) + 1;
    this.hi = (cs.id_base || 0) + cs.concept_count;
    this.blockKey = cs.resource != null ? this.block : 0;
    this.fhirBlock = cs.resource != null;
    delete cs.resource; // the resource JSON is read when needed (StoredCodeSystem), not kept per store
    this.config = {};
    for (const r of (this.fhirBlock ? [] : this.db.prepare('SELECT key, value FROM cs_config').all())) {
      let v = r.value;
      if (/^[[{]/.test(v)) { try { v = JSON.parse(v); } catch (e) { /* keep text */ } }
      this.config[r.key] = v;
    }
    // LOINC CLASSTYPE 3: main names it 'Claims attachment' (cs-loinc.js classTypes, as the HL7
    // tests expect); files built before the importer said so carry 'Claims attachments'. Both
    // spellings are accepted in filters, as main accepts them.
    const ct = this.config.propertyValueDescriptions && this.config.propertyValueDescriptions.CLASSTYPE;
    if (ct && ct['3'] === 'Claims attachments') {
      ct['3'] = 'Claims attachment';
      this.config.propertyValueAliases = { ...(this.config.propertyValueAliases || {}), CLASSTYPE: { 'claims attachments': '3' } };
    }
    this.props = new Map();     // code -> def
    this.propsById = new Map(); // id -> def
    const perBlock = this.db.prepare('PRAGMA table_info(property_def)').all().some((c) => c.name === 'cs_id');
    const propRows = perBlock
      ? this.db.prepare('SELECT * FROM property_def WHERE cs_id = ? ORDER BY property_id').all(this.block)
      : this.db.prepare('SELECT * FROM property_def ORDER BY property_id').all();
    for (const p of propRows) {
      const def = { id: p.property_id, code: p.code, uri: p.uri, type: p.fhir_type, kind: p.value_kind, isHierarchy: !!p.is_hierarchy, display: p.display };
      this.props.set(p.code, def);
      this.propsById.set(def.id, def);
    }
    this.hierarchy = [...this.props.values()].find((p) => p.isHierarchy) || null;
    this.uses = new Map();
    for (const u of this.db.prepare('SELECT * FROM designation_use').all()) {
      this.uses.set(u.use_id, { system: u.system, code: u.code, display: u.display });
    }
    const hasTable = (n) => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(n);
    this.hasFts = hasTable('search_display');
    this.hasAcceptability = hasTable('designation_acceptability');
  }

  // ---- sets -------------------------------------------------------------------------------

  /**
   * Load sets for many keys of one (kind, property): one statement whatever the number of keys.
   * Missing rows are empty sets. Returns Map(value -> bitmap). Nothing is kept between requests:
   * `local` is the caller's working set for one evaluation (each set read once per evaluation).
   * @param {object} [stats] counters to add to (statements, rows, bytes, loaded, us)
   * @param {Map} [local] key -> bitmap already read in this evaluation
   */
  loadSets(kind, pid, values, stats, local) {
    const out = new Map();
    const miss = [];
    for (const v of values) {
      const b = local && local.get(setKey(kind, pid, v));
      if (b) out.set(v, b);
      else miss.push(v);
    }
    if (miss.length) {
      const t0 = stats ? process.hrtime.bigint() : 0n;
      let rows;
      let q;
      if (miss.length === 1) {
        q = this.stmt('SELECT value, data FROM concept_set WHERE kind = ? AND property_id = ? AND value = ?');
        const r = q.get(kind, pid, miss[0]);
        rows = r ? [r] : [];
      } else {
        q = this.stmt('SELECT value, data FROM concept_set WHERE kind = ? AND property_id = ? AND value IN (SELECT value FROM json_each(?))');
        rows = q.all(kind, pid, JSON.stringify(miss));
      }
      let bytes = 0;
      const named = stats && stats.sets ? [] : null;
      for (const r of rows) {
        const b = RoaringBitmap32.deserialize(r.data, 'portable');
        bytes += r.data.length;
        out.set(r.value, b);
        if (local) local.set(setKey(kind, pid, r.value), b);
        if (named) named.push({ value: r.value, card: b.size, bytes: r.data.length });
      }
      for (const v of miss) {
        if (!out.has(v)) {
          out.set(v, EMPTY);
          if (local) local.set(setKey(kind, pid, v), EMPTY);
        }
      }
      if (stats) {
        count(stats, this, q, rows.length);
        if (named) stats.sets(this, kind, pid, named);
        stats.setsLoaded += rows.length;
        stats.setBytes += bytes;
        stats.setLoadUs += Number(process.hrtime.bigint() - t0) / 1000;
      }
    }
    return out;
  }

  getSet(kind, pid, value, stats, local) {
    return this.loadSets(kind, pid, [value], stats, local).get(value);
  }

  all(stats, local) { return this.getSet(KIND.all, 0, this.blockKey, stats, local); }
  active(stats, local) { return this.getSet(KIND.active, 0, this.blockKey, stats, local); }
  leaf(stats, local) { return this.getSet(KIND.leaf, 0, this.blockKey, stats, local); }

  /** keys (values) of the stored prop sets of one property, with their cardinalities */
  propValues(pid, stats) {
    const q = this.stmt('SELECT value, card FROM concept_set WHERE kind = 5 AND property_id = ?');
    const r = q.all(pid);
    if (stats) count(stats, this, q, r.length);
    return r;
  }

  // ---- codes ------------------------------------------------------------------------------

  /** code -> concept_id for many codes in one statement (null when unknown) */
  resolveCodes(codes, stats) {
    const out = new Map();
    const want = [...new Set(codes.filter((c) => c != null).map(String))];
    if (!want.length) return out;
    const q = want.length === 1
      ? this.stmt('SELECT concept_id, code FROM concept WHERE code = ? AND concept_id BETWEEN ? AND ?')
      : this.stmt('SELECT concept_id, code FROM concept WHERE code IN (SELECT value FROM json_each(?)) AND concept_id BETWEEN ? AND ?');
    const rows = want.length === 1 ? [q.get(want[0], this.lo, this.hi)].filter(Boolean) : q.all(JSON.stringify(want), this.lo, this.hi);
    for (const r of rows) out.set(r.code, r.concept_id);
    for (const c of want) if (!out.has(c)) out.set(c, null);
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  idOf(code, stats) {
    return this.resolveCodes([code], stats).get(code);
  }

  /** case-insensitive code match (for case-insensitive systems), or null */
  idOfNoCase(code) {
    const r = this.stmt('SELECT concept_id FROM concept WHERE code = ? COLLATE NOCASE AND concept_id BETWEEN ? AND ? LIMIT 1').get(code, this.lo, this.hi);
    return r ? r.concept_id : null;
  }

  // ---- rows (facts) -----------------------------------------------------------------------

  /** concepts whose display matches an FTS5 trigram query (one statement); a bitmap */
  ftsDisplayIds(query, stats) {
    const q = this.stmt('SELECT rowid FROM search_display WHERE search_display MATCH ? AND rowid BETWEEN ? AND ?');
    const ids = q.pluck().all(query, this.lo, this.hi);
    if (stats) count(stats, this, q, ids.length);
    return new RoaringBitmap32(ids);
  }

  /** concept rows for ids, in one statement; Map(id -> row) */
  conceptRows(ids, stats) {
    const out = new Map();
    if (!ids.length) return out;
    const q = ids.length === 1
      ? this.stmt('SELECT concept_id, code, active, display, definition FROM concept WHERE concept_id = ?')
      : this.stmt('SELECT concept_id, code, active, display, definition FROM concept WHERE concept_id IN (SELECT value FROM json_each(?))');
    const rows = ids.length === 1 ? [q.get(ids[0])].filter(Boolean) : q.all(JSON.stringify(Array.from(ids)));
    for (const r of rows) out.set(r.concept_id, r);
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  /** designations for ids, in one statement; Map(id -> [{id, language, use, term, active, preferred, acceptability?}]) */
  designationRows(ids, stats) {
    const out = new Map();
    if (!ids.length) return out;
    const sql = this.hasAcceptability
      ? `SELECT d.designation_id, d.concept_id, d.language, d.use_id, d.term, d.active, d.preferred,
                (SELECT group_concat(a.refset_id || ':' || a.acceptability_id) FROM designation_acceptability a WHERE a.designation_id = d.designation_id) AS acc
         FROM designation d WHERE d.concept_id IN (SELECT value FROM json_each(?)) ORDER BY d.designation_id`
      : `SELECT d.designation_id, d.concept_id, d.language, d.use_id, d.term, d.active, d.preferred, NULL AS acc
         FROM designation d WHERE d.concept_id IN (SELECT value FROM json_each(?)) ORDER BY d.designation_id`;
    const q = this.stmt(sql);
    const rows = q.all(JSON.stringify(Array.from(ids)));
    for (const r of rows) {
      let l = out.get(r.concept_id);
      if (!l) out.set(r.concept_id, l = []);
      l.push({
        id: r.designation_id, language: r.language, use: r.use_id != null ? this.uses.get(r.use_id) : null,
        term: r.term, active: !!r.active, preferred: !!r.preferred, acc: r.acc
      });
    }
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  /** concept-valued facts from sources (one statement); rows {s, p, g, t, active} */
  linksFrom(ids, pids = null, activeOnly = true, stats) {
    if (!ids.length) return [];
    const q = this.stmt(`SELECT source_id AS s, property_id AS p, group_id AS g, target_id AS t, active FROM concept_link
       WHERE source_id IN (SELECT value FROM json_each(?)) ${activeOnly ? 'AND active = 1' : ''}`);
    const rows = q.all(JSON.stringify(Array.from(ids)));
    if (stats) count(stats, this, q, rows.length);
    return pids ? rows.filter((r) => pids.has(r.p)) : rows;
  }

  /** literal facts for ids (one statement); rows {c, p, g, v, active} */
  literalsOf(ids, activeOnly = true, stats) {
    if (!ids.length) return [];
    const q = this.stmt(`SELECT concept_id AS c, property_id AS p, group_id AS g, value AS v, active FROM concept_literal
       WHERE concept_id IN (SELECT value FROM json_each(?)) ${activeOnly ? 'AND active = 1' : ''}`);
    const rows = q.all(JSON.stringify(Array.from(ids)));
    if (stats) count(stats, this, q, rows.length);
    return rows;
  }

  /** direct parents over the hierarchy property (active links) */
  parentsOf(id, stats) {
    if (!this.hierarchy) return [];
    const q = this.stmt('SELECT target_id FROM concept_link WHERE source_id = ? AND property_id = ? AND active = 1');
    const rows = q.all(id, this.hierarchy.id);
    if (stats) count(stats, this, q, rows.length);
    return rows.map((r) => r.target_id);
  }

  /** all ancestors: walk direct links upward. With explicit-pair hierarchies (LOINC) keep only A with D(A).has(id). */
  ancestorsOf(id, stats) {
    const seen = new Set();
    let frontier = [id];
    while (frontier.length) {
      const next = [];
      const rows = this.linksFrom(frontier, new Set([this.hierarchy ? this.hierarchy.id : -1]), true, stats);
      for (const r of rows) if (!seen.has(r.t)) { seen.add(r.t); next.push(r.t); }
      frontier = next;
    }
    if (this.config.hierarchyPairs || this.system === 'http://loinc.org') {
      const sets = this.loadSets(KIND.descendants, 0, [...seen], stats);
      for (const a of [...seen]) if (!sets.get(a).has(id)) seen.delete(a);
    }
    return [...seen];
  }

  /**
   * Map a set of another file's ids (same system, other release) to this file's ids by code:
   * the members' codes there, then one batched lookup here. Per request (nothing is kept): the
   * cost follows the size of the set, not of the files.
   */
  translateFrom(other, bm, stats) {
    // chunks of 20,000 ids, codes only: the transient working set stays a few MiB
    const out = new RoaringBitmap32();
    const codesOf = other.stmt('SELECT code FROM concept WHERE concept_id IN (SELECT value FROM json_each(?))').raw();
    const idsOf = this.stmt('SELECT concept_id FROM concept WHERE code IN (SELECT value FROM json_each(?))').raw();
    for (let i = 0; i < bm.size; i += 20000) {
      const chunk = bm.rangeUint32Array(i, 20000);
      const codes = codesOf.all(JSON.stringify(Array.from(chunk))).map((r) => r[0]);
      for (const r of idsOf.all(JSON.stringify(codes))) out.add(r[0]);
      if (stats) { count(stats, other, codesOf, chunk.length); count(stats, this, idsOf, codes.length); }
    }
    return out;
  }

  /** members of an ordered list (refset_def field `sequence`, e.g. LOINC answer lists) in order, or null */
  sequenceOf(refsetId) {
    const def = this.stmt('SELECT field_names FROM refset_def WHERE refset_id = ?').get(refsetId);
    if (!def || JSON.parse(def.field_names)[0] !== 'sequence') return null;
    return this.stmt("SELECT concept_id FROM refset_member WHERE refset_id = ? ORDER BY json_extract(fields, '$[0]'), concept_id").all(refsetId).map((r) => r.concept_id);
  }

  /** refset member rows (fields) for a concept */
  refsetRows(refsetId, conceptId) {
    return this.stmt('SELECT fields FROM refset_member WHERE refset_id = ? AND concept_id = ?').all(refsetId, conceptId).map((r) => JSON.parse(r.fields));
  }

  /**
   * Text search ($expand filter), on the trigram indexes, then checked exactly.
   *   mode 'display'     : the display contains the text (LOINC)
   *   mode 'designation' : every word is in one active designation; active concepts (SNOMED)
   *   default            : every word is in the display or in one designation
   * Words of fewer than 3 characters cannot use a trigram index: they are checked on the rows
   * the longer words select, or by a scan when there is no longer word.
   */
  /**
   * Text filter ($expand filter): the concepts with a matching display or designation.
   * `lang` (a primary language subtag, or null for every language) is the one language a text
   * filter searches (CodeSystemProvider.searchLanguage, as main since #335): with mode 'display'
   * (LOINC) English searches the displays, and another language the designations in it except
   * RELATEDNAMES2 (a keyword list, not a name); with mode 'designation' (SNOMED CT) only
   * designations in that language take part. A designation with no language is in `defLang`.
   */
  searchText(text, stats, mode, lang = null, defLang = 'en') {
    const t = String(text).toLowerCase().trim();
    const words = t.split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    if (this.ensureFts) this.ensureFts();
    const primary = (l) => String(l || defLang || 'en').toLowerCase().split('-')[0];
    // LOINC in another language: its designations in that language, matched as the display is
    const otherLang = mode === 'display' && lang && lang !== 'en';
    const phrase = mode === 'display';
    const fts = (phrase ? [t] : words).filter((w) => w.length >= 3).map((w) => '"' + w.replace(/"/g, '""') + '"').join(' AND ');
    const bm = new RoaringBitmap32();
    const has = (term) => { const x = String(term || '').toLowerCase(); return phrase ? x.includes(t) : words.every((w) => x.includes(w)); };
    if (mode !== 'designation' && !otherLang) {
      const q = fts && this.hasFts
        ? this.stmt('SELECT c.concept_id, c.display FROM search_display s JOIN concept c ON c.concept_id = s.rowid WHERE search_display MATCH ? AND s.rowid BETWEEN ? AND ?')
        : this.stmt('SELECT concept_id, display FROM concept WHERE concept_id BETWEEN ? AND ?');
      const rows = fts && this.hasFts ? q.all(fts, this.lo, this.hi) : q.all(this.lo, this.hi);
      if (stats) count(stats, this, q, rows.length);
      for (const r of rows) if (has(r.display)) bm.add(r.concept_id);
    }
    if (mode !== 'display' || otherLang) {
      const q = fts && this.hasFts
        ? this.stmt('SELECT d.concept_id, d.term, d.active, d.use_id, d.language FROM search_designation s JOIN designation d ON d.designation_id = s.rowid WHERE search_designation MATCH ? AND d.concept_id BETWEEN ? AND ?')
        : this.stmt('SELECT concept_id, term, active, use_id, language FROM designation WHERE concept_id BETWEEN ? AND ?');
      const rows = fts && this.hasFts ? q.all(fts, this.lo, this.hi) : q.all(this.lo, this.hi);
      if (stats) count(stats, this, q, rows.length);
      const related = otherLang ? [...this.uses].filter(([, u]) => u.code === 'RELATEDNAMES2').map(([id]) => id) : [];
      // SNOMED (as upstream): every filter word, stemmed, is a word of one active description
      const match = mode === 'designation' ? stemMatcher(words) : has;
      for (const r of rows) {
        if (mode === 'designation' && !r.active) continue;
        if (lang && primary(r.language) !== lang) continue;
        if (related.includes(r.use_id)) continue;
        if (match(r.term)) bm.add(r.concept_id);
      }
      if (mode === 'designation') bm.andInPlace(this.active());
    }
    return bm;
  }
}

module.exports = { V2Store, KIND, EMPTY, setKey, registry, count };
