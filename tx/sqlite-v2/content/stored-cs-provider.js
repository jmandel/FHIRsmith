'use strict';
// The provider for a StoredCodeSystem: main's FhirCodeSystemProvider for every per-concept question
// (display, designations, properties, status, abstract, extensions, $lookup), fed concepts from the
// block one at a time; the sqlite-v2 engine (fhir dialect) for every set question (filters,
// membership, text search). Nothing is kept beyond the request.

const { FhirCodeSystemProvider, FhirCodeSystemProviderContext } = require('../../cs/cs-cs');
const { Issue } = require('../../library/operation-outcome');
const { CodeSystemProvider } = require('../../cs/cs-api');
const { Language } = require('../../../library/languages');
const { Evaluator } = require('../engine/evaluate');
const { Compiler } = require('../engine/compile');
const { Engine } = require('../engine/engine');
const { fhir } = require('./fhir-dialect');
const { RoaringBitmap32 } = require('roaring');

const CHUNK = 500;
const { KIND } = require('../store');

function foldSearchText(text) {
  return text.normalize('NFD')
    .replace(/([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu, '$1')
    .toLowerCase();
}

/** a filter result: members as a bitmap, listed in main's order on demand */
class StoredFilterSet {
  constructor(provider, node, bm) {
    this.p = provider;
    this.node = node;
    this.bm = bm;
    this.list = null;   // ordered ids (duplicates possible for concept in)
    this.ratings = null;
    this.pos = -1;
    this.buf = null;
    this.bufStart = 0;
  }

  ordered() {
    if (this.list) return this.list;
    const n = this.node;
    const cs = this.p.codeSystem;
    if (n.fhirOrder === 'list') this.list = n.list;
    else if (n.fhirOrder === 'dfs') {
      const out = n.self ? [n.root] : [];
      if (n.exact != null) for (const id of cs.descendantIdsInOrder(n.exact)) if (id !== n.root || !n.self) out.push(id);
      this.list = out;
    } else if (n.fhirOrder === 'children') this.list = cs.nestedOnly ? this.bm.toArray() : cs._childIds(n.exact);
    else this.list = this.bm.toArray();
    return this.list;
  }

  size() { return this.node.fhirOrder === 'list' ? this.node.list.length : this.bm.size; }
}

class StoredFhirProvider extends FhirCodeSystemProvider {
  constructor(opContext, codeSystem, supplements) {
    super(opContext, codeSystem, supplements);
    this.store = codeSystem.store;
    this.dialect = fhir;
  }

  // ---- per-concept ------------------------------------------------------------------------------

  _ctx(id, concept) {
    const c = new FhirCodeSystemProviderContext(concept.code, concept);
    c.id = id;
    return c;
  }

  /**
   * expand.js offers an include's enumerated codes in runs of 1,000 (cs-api prefetchCodes): they are
   * resolved with two statements and kept on this provider, which lives for one request. Codes with
   * non-ASCII letters keep the one-by-one lookup (lookupId's fallback).
   */
  async prefetchCodes(codes) {
    const cs = this.codeSystem;
    const want = [...new Set((codes || []).filter((c) => typeof c === 'string' && !/[^\x00-\x7f]/.test(c)))];
    if (!want.length) return;
    const ci = cs.caseInsensitive();
    const keys = ci ? [...new Set(want.map((c) => c.toLowerCase()))] : want;
    const rows = cs.stmt(ci
      ? 'SELECT concept_id, lower(code) AS k FROM concept WHERE lower(code) IN (SELECT value FROM json_each(?)) AND concept_id BETWEEN ? AND ?'
      : 'SELECT concept_id, code AS k FROM concept WHERE code IN (SELECT value FROM json_each(?)) AND concept_id BETWEEN ? AND ?')
      .all(JSON.stringify(keys), cs.lo, cs.hi);
    rows.sort((a, b) => a.concept_id - b.concept_id);
    const idByKey = new Map();
    for (const r of rows) idByKey.set(r.k, r.concept_id); // the last one wins, as lookupId
    const concepts = cs.conceptsByIds([...new Set(idByKey.values())]);
    if (!this._prefetched) this._prefetched = new Map();
    for (const c of want) {
      const id = idByKey.get(ci ? c.toLowerCase() : c);
      if (id != null && concepts.get(id)) this._prefetched.set(c, { id, concept: concepts.get(id) });
    }
  }

  // ---- iteration (expand.js walks a whole code system root by root, then each concept's children) --
  // Same order as main (roots and children in document order); concepts are read 500 at a time and
  // a concept without children costs no statement. The id sets live on this provider (one request).

  _parentIds() {
    if (!this._parents) {
      const cs = this.codeSystem;
      this._parents = new Set(cs.store.stmt('SELECT value FROM concept_set WHERE kind = ? AND property_id = ?').pluck().all(KIND.prop, cs.hierPid));
    }
    return this._parents;
  }

  async iterator(context) {
    const cs = this.codeSystem;
    if (!context) {
      const has = cs.store.getSet(KIND.hasProp, cs.hierPid, 0);
      const ids = RoaringBitmap32.andNot(cs.store.all(), has || new RoaringBitmap32()).toArray();
      return { type: 'all', ids, current: 0, total: ids.length };
    }
    const ctxt = typeof context === 'string' ? (await this.locate(context)).context : context;
    if (!ctxt) return null;
    const id = ctxt.id != null ? ctxt.id : cs.idOf(ctxt.code);
    const ids = id != null && this._parentIds().has(id) ? cs._childIds(id) : [];
    return { type: 'children', parentCode: ctxt.code, ids, current: 0, total: ids.length };
  }

  async iteratorAll() {
    const ids = this.codeSystem.store.all().toArray();
    return { type: 'all', ids, current: 0, total: ids.length };
  }

  async nextContext(it) {
    if (!it || !it.ids) return super.nextContext(it);
    if (it.current >= it.total) return null;
    if (!it.buf || it.current >= it.bufStart + it.buf.length) {
      const ids = it.ids.slice(it.current, it.current + CHUNK);
      const concepts = this.codeSystem.conceptsByIds(ids);
      it.buf = ids.map((id) => (concepts.get(id) ? this._ctx(id, concepts.get(id)) : null));
      it.bufStart = it.current;
    }
    const c = it.buf[it.current - it.bufStart];
    it.current++;
    return c; // main stops at a code it cannot find; every id here exists
  }

  async parent(context) {
    if (context && typeof context === 'object' && context.parentCode !== undefined) return context.parentCode;
    return super.parent(context);
  }

  async locate(code) {
    const p = this._prefetched && typeof code === 'string' ? this._prefetched.get(code) : undefined;
    if (p) return { context: this._ctx(p.id, p.concept), message: null };
    return super.locate(code);
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) return true;
    if (langs.isEnglishOrNothing()) return true;
    if (this.defaultLanguage) {
      for (const requestedLang of langs) if (this.defaultLanguage.matchesForDisplay(requestedLang)) return true;
    }
    // main walks every concept's designations; here: the distinct designation languages of the block
    const cs = this.codeSystem;
    const ls = cs.stmt('SELECT DISTINCT language FROM designation WHERE language IS NOT NULL AND concept_id BETWEEN ? AND ?').pluck().all(cs.lo, cs.hi);
    for (const l of ls) {
      const dl = new Language(l);
      for (const requestedLang of langs) if (dl.matchesForDisplay(requestedLang)) return true;
    }
    return false;
  }

  /**
   * As main's FhirCodeSystemProvider.searchLanguage (#335): the first language the request names
   * that the code system has text in (its own language, a designation in it, or a supplement's),
   * else the code system's language. Main walks every concept's designations to know; here the
   * block's distinct designation languages answer it.
   */
  searchLanguage(languages) {
    const csLang = this.defLang();
    let have = null;
    for (const lang of (languages && languages.languages) || []) {
      if (!lang || !lang.language || lang.code === '*') continue;
      if (CodeSystemProvider.inSearchLanguage(csLang, lang)) return lang;
      if (!have) {
        const cs = this.codeSystem;
        have = cs.stmt('SELECT DISTINCT language FROM designation WHERE language IS NOT NULL AND concept_id BETWEEN ? AND ?').pluck().all(cs.lo, cs.hi);
      }
      if (have.some((l) => CodeSystemProvider.inSearchLanguage(l, lang, csLang)) || this._hasSupplementText(lang)) return lang;
    }
    return new Language(csLang);
  }

  // ---- filters -----------------------------------------------------------------------------------

  _compiler() {
    return new Compiler({ store: this.store, dialect: this.dialect, cs: this.codeSystem }, {});
  }

  _issue(e) {
    if (e && e.fhirIssue) {
      return new Issue('error', e.issueType || 'exception', null, e.fhirIssue,
        this.opContext.i18n.translate(e.fhirIssue, this.opContext.langs, e.args), 'vs-invalid', 422);
    }
    return e;
  }

  async filter(filterContext, forIteration, prop, op, value) {
    let node;
    try {
      node = this.dialect.filter(this._compiler(), prop, op, value);
    } catch (e) {
      throw this._issue(e);
    }
    const bm = new Evaluator(this.store, {}).mat(node);
    const set = new StoredFilterSet(this, node, bm);
    if (!filterContext.filters) filterContext.filters = [];
    filterContext.filters.push(set);
    return set;
  }

  async filterSize(filterContext, set) { return set ? set.size() : 0; }

  async filterMore(filterContext, set) {
    if (!set) return false;
    const list = set.ordered();
    set.pos++;
    if (set.pos >= list.length) return false;
    if (!set.buf || set.pos >= set.bufStart + set.buf.length) {
      const ids = list.slice(set.pos, set.pos + CHUNK);
      const uniq = [...new Set(ids)];
      const concepts = this.codeSystem.conceptsByIds(uniq);
      // expand.js asks each member for its parent (to nest the expansion): read them for the chunk
      const parents = this.codeSystem.hierPid != null ? this.codeSystem.firstParentCodes(uniq) : null;
      set.buf = ids.map((id) => {
        const c = this._ctx(id, concepts.get(id));
        if (parents) c.parentCode = parents.get(id);
        return c;
      });
      set.bufStart = set.pos;
    }
    return true;
  }

  async filterConcept(filterContext, set) {
    if (!set || !set.buf) return null;
    return set.buf[set.pos - set.bufStart] || null;
  }

  async filterLocate(filterContext, set, code) {
    if (!set) return `Code '${code}' not found: no filter results`;
    // main: the result's concept with exactly this code
    const id = this.codeSystem.idOf(code);
    if (id == null || !set.bm.has(id)) return null;
    return this._ctx(id, this.codeSystem.conceptById(id));
  }

  async filterCheck(filterContext, set, concept) {
    if (!set || !concept) return 'Invalid filter set or concept';
    const id = concept.id != null ? concept.id : this.codeSystem.idOf(concept.code);
    return id != null && set.bm.has(id) ? true : `Concept '${concept.code}' not found in filter results`;
  }

  async filterFinish(filterContext) {
    if (filterContext.filters) filterContext.filters.length = 0;
  }

  /**
   * main's text search and its ratings, on the candidates the trigram index gives: every word of
   * three or more characters must occur in one of the concept's texts for any rating to apply.
   */
  async searchFilter(filterContext, filter, sort) {
    const cs = this.codeSystem;
    const searchTerm = foldSearchText(filter.filter);
    const searchWords = searchTerm.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
    const long = searchWords.filter((w) => w.length >= 3);
    let rows;
    // the index holds the block's own texts: a supplement's designations can match a concept the
    // index doesn't offer, so with supplements in use every concept is a candidate
    if (long.length && !(this.supplements && this.supplements.length)) {
      const q = long.map((w) => '"' + w.replace(/"/g, '""') + '"').join(' AND ');
      rows = cs.stmt('SELECT j.concept_id, j.json FROM search_display s JOIN concept_json j ON j.concept_id = s.rowid WHERE search_display MATCH ? AND s.rowid BETWEEN ? AND ? ORDER BY s.rowid').all(q, cs.lo, cs.hi);
    } else {
      rows = cs.stmt('SELECT concept_id, json FROM concept_json WHERE concept_id BETWEEN ? AND ? ORDER BY concept_id').all(cs.lo, cs.hi);
    }
    // one language only, as main (#335): the display, definition and designations in it, and
    // the supplements' designations in it
    const lang = this.searchLanguage(filterContext && filterContext.languages);
    const hits = [];
    for (const r of rows) {
      const c = cs._parse(r.json);
      const rating = this._calculateSearchRating(c, searchTerm, searchWords, lang);
      if (rating > 0) hits.push({ id: r.concept_id, rating });
    }
    if (sort) hits.sort((a, b) => b.rating - a.rating);
    const node = { t: 'ids', ids: hits.map((h) => h.id).sort((a, b) => a - b), fhirOrder: 'list', list: hits.map((h) => h.id) };
    const set = new StoredFilterSet(this, node, new RoaringBitmap32(node.ids));
    if (!filterContext.filters) filterContext.filters = [];
    filterContext.filters.push(set);
    return set;
  }

  // ---- whole composes ------------------------------------------------------------------------------

  /**
   * Off by default: expand.js flattens a provider-selected expansion (canBeHierarchy = false), and
   * main nests FHIR code system expansions by their hierarchy. Set
   * modules.tx.sqliteV2.fhirProcessSelection to evaluate whole composes on the engine instead.
   */
  handlesSelecting() {
    const { settings } = require('../settings');
    return !!settings.fhirProcessSelection;
  }

  /** cs-api processSelection: { sets, total, notClosed } or null (see SqliteV2Provider) */
  async processSelection(params, includes, excludes, excludeInactive, offset, count) {
    let sel;
    try {
      sel = this._compiler().selection(includes, excludes, excludeInactive || (params && params.activeOnly));
    } catch (e) {
      return null;
    }
    const start = Math.max(offset, 0);
    const engine = new Engine(this.store, {});
    const result = engine.run(sel, { offset: start, count });
    const page = result.page(start, count);
    const node = { t: 'ids', ids: [...page].sort((a, b) => a - b), fhirOrder: 'list', list: page };
    const set = new StoredFilterSet(this, node, new RoaringBitmap32(page));
    set.total = result.complete ? result.total : null;
    return { sets: [set], total: result.complete ? result.total : -1, notClosed: false };
  }
}

module.exports = { StoredFhirProvider, StoredFilterSet };
