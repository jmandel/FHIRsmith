'use strict';
// Value sets from a sqlite-v2 file (docs/sqlite-v2-content-store.md sections 4 and 5).
//
// One provider class for package value sets and VSAC. Nothing is kept between requests: every
// fetch reads its rows and builds a new ValueSet. Version choice, ids, search and the usage scan
// follow PackageValueSetProvider (tx/vs/vs-package.js) and VSACValueSetProvider (tx/vs/vs-vsac.js)
// rule for rule.
//
// Enumerated lists of up to EAGER_MAX (64) codes are read into plain arrays at fetch. A longer list
// stays in its rows: the include's `concept` is an enumerable accessor that reads them on first use
// (kept on this request's object only), and its stored-list handle (tx/library/stored-concepts.js:
// { count, lookup(code) }) answers count and membership with one indexed read (tx/workers/validate.js).

const Database = require('better-sqlite3');
const { AbstractValueSetProvider } = require('../../vs/vs-api');
const ValueSet = require('../../library/valueset');
const { VersionUtilities } = require('../../../library/version-utilities');
const { applyIdPrefix, stripIdPrefix } = require('../../library/resource-ids');
const { keepForPinnedReference, isTHOPackage } = require('../../library/tho-precedence');
const { STORED_CONCEPTS: STORED } = require('../../library/stored-concepts');

const EAGER_MAX = 64;
const PART_EXCLUDE = 1000000;
const INDEXED_COLUMNS = ['id', 'url', 'version', 'date', 'description', 'name', 'publisher', 'status', 'title'];

/** isNewerVersion of tx/vs/vs-database.js */
function isNewerVersion(candidate, current) {
  if (current == null) return true;
  if (candidate == null) return false;
  if (candidate === current) return false;
  if (VersionUtilities.isSemVer(candidate) && VersionUtilities.isSemVer(current)) {
    return VersionUtilities.isThisOrLater(current, candidate);
  }
  if (/^\d+$/.test(candidate) && /^\d+$/.test(current)) return Number(candidate) > Number(current);
  return candidate > current;
}

function majMin(v) {
  try {
    return VersionUtilities.isSemVer(v) ? VersionUtilities.getMajMin(v) : null;
  } catch (e) {
    return null;
  }
}

// Per-request working set (WeakMap keyed by the request's OperationContext, so it goes with the
// request): when a value set imports others (a grouping value set), its children's rows are read
// in a few batched statements instead of four statements each. Nothing outlives the request.
const requestBatches = new WeakMap();

function rowConcept(code, display, json) {
  if (json) return JSON.parse(json);
  return display != null ? { code, display } : { code };
}

class ContentValueSetProvider extends AbstractValueSetProvider {
  /**
   * @param {string} file sqlite-v2 content file
   * @param {object} opts { kind: 'package'|'vsac', source: provider code (package id, or 'vsac') }
   */
  constructor(file, opts = {}) {
    super();
    this.file = file;
    this.kind = opts.kind || 'package';
    this.sourcePackageCode = opts.source;
    this.db = null;
    this.initialized = false;
    this.count = 0;
    this.excludedUrls = new Set(); // keepPinnedOnly: by url
    this.excludedIds = new Set();  //                and by unprefixed id
    this.pinned = new Map();       //                url -> THO's versions
    this.log = opts.log || require('../../../library/logger').getInstance().child({ module: 'tx' });
  }

  code() { return this.sourcePackageCode; }
  sourcePackage() { return this.sourcePackageCode; }

  async initialize() {
    if (this.initialized) return;
    this.db = new Database(this.file, { readonly: true, fileMustExist: true });
    const { settings } = require('../settings');
    this.db.pragma(`cache_size = -${settings.sqliteCacheKB}`);
    this.db.pragma(`mmap_size = ${settings.mmapMB * 1048576}`);
    const st = (sql) => this.db.prepare(sql);
    this.s = {
      byUrl: st('SELECT vs_id, id, version FROM value_set WHERE url = ? ORDER BY vs_id'),
      byId: st('SELECT vs_id FROM value_set WHERE id = ?'),
      row: st('SELECT vs_id, id, url, version, content_hash, json FROM value_set WHERE vs_id = ?'),
      incs: st('SELECT exclude, idx, concept_count, first_row FROM vs_include WHERE vs_id = ? AND concept_count > 0'),
      rows: st('SELECT code, display, json FROM vs_concept WHERE row BETWEEN ? AND ? ORDER BY row').raw(),
      lookup: st('SELECT code, display, json FROM vs_concept WHERE vs_id = ? AND part = ? AND code = ? ORDER BY row').raw(),
      count: st('SELECT count(*) AS n FROM value_set'),
      urls: st('SELECT url FROM value_set ORDER BY url').pluck(),
      hasCompose: st("SELECT 1 FROM value_set WHERE vs_id = ? AND json_type(json, '$.compose') IS NOT NULL").pluck(),
      batchByUrl: st('SELECT vs_id, id, url, version FROM value_set WHERE url IN (SELECT value FROM json_each(?)) ORDER BY vs_id'),
      batchRows: st('SELECT vs_id, id, url, version, content_hash, json FROM value_set WHERE vs_id IN (SELECT value FROM json_each(?))'),
      batchIncs: st('SELECT vs_id, exclude, idx, concept_count, first_row FROM vs_include WHERE vs_id IN (SELECT value FROM json_each(?)) AND concept_count > 0'),
      batchEager: st(`SELECT c.vs_id, c.part, c.code, c.display, c.json FROM vs_include i
        JOIN vs_concept c ON c.row BETWEEN i.first_row AND i.first_row + i.concept_count - 1
        WHERE i.vs_id IN (SELECT value FROM json_each(?)) AND i.concept_count > 0 AND i.concept_count <= ? ORDER BY c.row`).raw(),
    };
    this.count = this.s.count.get().n;
    // a package file never changes: the set of its urls (data read at load) answers "not here"
    // without a statement; VSAC is written by its sync, so it is always asked
    this.urls = this.kind === 'package' ? new Set(this.db.prepare('SELECT DISTINCT url FROM value_set').pluck().all()) : null;
    this.initialized = true;
  }

  vsCount() { return this.count; }

  async close() {
    if (this.db) { try { this.db.close(); } catch (e) { /* closed */ } }
    this.db = null;
    this.initialized = false;
  }

  prefixIds() { /* ids are prefixed as each value set is built */ }

  // ---- version choice --------------------------------------------------------------------------

  /** the vs_id the (url, version) reference selects, by the rules of the map main builds */
  _candidates(url, version, batch) {
    if (this.urls && !this.urls.has(url)) return []; // an immutable package: a url it does not have
    const rows = (batch && batch.byUrl.get(url)) || this.s.byUrl.all(url);
    if (!rows.length) return [];
    const tho = this.pinned.get(url); // keepPinnedOnly: only pinned references reach this url
    const keep = (key, r) => !tho || keepForPinnedReference(key, r, tho);
    const latest = (list) => {
      // _setIfNewer over the rows in load order: the first of equal versions stays
      let best = null;
      for (const r of list) if (!best || isNewerVersion(r.version || null, best.version || null)) best = r;
      return best;
    };
    const out = [];
    if (version != null) {
      // url|version: the last row with that version (Map.set)
      const exact = rows.filter((r) => r.version === version);
      if (exact.length && keep(url + '|' + version, exact[exact.length - 1])) out.push(exact[exact.length - 1]);
      const mm = majMin(version);
      if (mm) {
        const l = latest(rows.filter((r) => r.version && majMin(r.version) === mm));
        if (l && keep(url + '|' + mm, l)) out.push(l);
      }
      if (this.kind === 'vsac' && !tho) out.push(latest(rows)); // VSAC: the bare url is the last resort
    } else {
      if (this.excludedUrls.has(url)) return [];
      out.push(latest(rows));
    }
    return out.filter(Boolean);
  }

  /**
   * @param {string} url
   * @param {string} [version]
   * @param {OperationContext} [opContext] the request (tx/provider.js findValueSet passes it): lets a
   *   grouping value set's children be read in batches during this request
   */
  async fetchValueSet(url, version, opContext) {
    await this.initialize();
    this._validateFetchParams(url, version);
    const batch = this._batch(opContext, false);
    const tried = new Set();
    for (const c of this._candidates(url, version || null, batch)) {
      if (tried.has(c.vs_id)) continue;
      tried.add(c.vs_id);
      const vs = this._build(c.vs_id, batch);
      if (vs) {
        this._prefetchImports(vs, opContext);
        return vs;
      }
    }
    return null;
  }

  _batch(opContext, create) {
    if (!opContext || typeof opContext !== 'object') return null;
    let m = requestBatches.get(opContext);
    if (!m && create) requestBatches.set(opContext, m = new Map());
    if (!m) return null;
    let b = m.get(this);
    if (!b && create) m.set(this, b = { byUrl: new Map(), rows: new Map(), incs: new Map(), concepts: new Map() });
    return b || null;
  }

  /**
   * A value set that imports others: read the imported value sets this provider has in five
   * statements (candidate rows, resource rows, include rows, and the codes of the lists read
   * eagerly), for this request. Version choice and building are unchanged; they only read from here.
   */
  _prefetchImports(vs, opContext) {
    if (!opContext) return;
    const refs = [];
    for (const key of ['include', 'exclude']) {
      for (const inc of (vs.jsonObj.compose && vs.jsonObj.compose[key]) || []) {
        for (const u of inc.valueSet || []) if (typeof u === 'string') refs.push(u);
      }
    }
    if (refs.length < 2) return;
    const b = this._batch(opContext, true);
    const urls = [...new Set(refs.map((u) => u.split('|')[0]))].filter((u) => !b.byUrl.has(u) && (!this.urls || this.urls.has(u)));
    if (!urls.length) return;
    for (const u of urls) b.byUrl.set(u, []);
    for (const r of this.s.batchByUrl.all(JSON.stringify(urls))) b.byUrl.get(r.url).push(r);
    const ids = new Set();
    for (const ref of refs) {
      const i = ref.indexOf('|');
      for (const c of this._candidates(i < 0 ? ref : ref.substring(0, i), i < 0 ? null : ref.substring(i + 1), b)) ids.add(c.vs_id);
    }
    const want = [...ids].filter((id) => !b.rows.has(id));
    if (!want.length) return;
    const j = JSON.stringify(want);
    for (const r of this.s.batchRows.all(j)) b.rows.set(r.vs_id, r);
    for (const id of want) b.incs.set(id, []);
    for (const r of this.s.batchIncs.all(j)) b.incs.get(r.vs_id).push(r);
    for (const r of this.s.batchEager.all(j, EAGER_MAX)) {
      const k = r[0] + ':' + r[1];
      let l = b.concepts.get(k);
      if (!l) b.concepts.set(k, l = []);
      l.push(rowConcept(r[2], r[3], r[4]));
    }
  }

  async fetchValueSetById(id) {
    await this.initialize();
    const raw = stripIdPrefix(id, this.spaceId);
    if (raw == null || this.excludedIds.has(raw)) return null;
    const r = this.s.byId.get(raw);
    if (!r) return null;
    const vs = this._build(r.vs_id);
    return vs && vs.id === id ? vs : null;
  }

  // ---- building a ValueSet for one request ----------------------------------------------------

  _build(vsId, batch) {
    const r = (batch && batch.rows.get(vsId)) || this.s.row.get(vsId);
    if (!r) return null;
    const json = JSON.parse(r.json);
    const lazy = [];
    const comp = json.compose;
    if (comp) {
      const byPart = new Map(((batch && batch.incs.get(vsId)) || this.s.incs.all(vsId)).map((i) => [i.exclude * PART_EXCLUDE + i.idx, i]));
      for (const [exclude, key] of [[0, 'include'], [1, 'exclude']]) {
        (comp[key] || []).forEach((inc, idx) => {
          if (!inc.concept || !Object.prototype.hasOwnProperty.call(inc.concept, '$rows')) return;
          const info = byPart.get(exclude * PART_EXCLUDE + idx);
          const n = info ? info.concept_count : 0;
          if (n <= EAGER_MAX) {
            const pre = batch && batch.concepts.get(vsId + ':' + (exclude * PART_EXCLUDE + idx));
            // a batched list is handed out once (a request may build the same value set twice)
            if (pre) batch.concepts.delete(vsId + ':' + (exclude * PART_EXCLUDE + idx));
            inc.concept = n ? (pre || this.s.rows.all(info.first_row, info.first_row + n - 1).map((x) => rowConcept(x[0], x[1], x[2]))) : [];
          } else {
            delete inc.concept; // installed after construction (the constructor counts concepts)
            lazy.push({ key, idx, info, vsId, part: exclude * PART_EXCLUDE + idx });
          }
        });
      }
    }
    let vs;
    try {
      vs = new ValueSet(json);
    } catch (e) {
      // as the map loader: one unacceptable value set is skipped (the next candidate is tried)
      this.log.warn(`${this.sourcePackage() || 'ValueSet database'}: skipping ValueSet ${r.url || r.id}${r.version ? '|' + r.version : ''}: ${e.message}`);
      return null;
    }
    let extra = 0;
    for (const l of lazy) {
      const list = vs.jsonObj.compose[l.key];
      list[l.idx] = this._lazyInclude(list[l.idx], l);
      if (l.key === 'include' || l.key === 'exclude') extra += l.info.concept_count;
    }
    if (extra) vs._conceptCount += extra;
    if (this.kind === 'vsac' && vs.jsonObj.compose) {
      // as VSACValueSetProvider._reloadMap
      for (const inc of vs.jsonObj.compose.include || []) if (inc.version) delete inc.version;
      for (const inc of vs.jsonObj.compose.exclude || []) if (inc.version) delete inc.version;
    }
    vs.sourcePackage = this.sourcePackage();
    vs.contentHash = r.content_hash || null;
    if (this.kind === 'package') {
      Object.defineProperty(vs, 'isCached', { value: true, enumerable: false, configurable: true, writable: true });
    }
    applyIdPrefix(vs, this.spaceId);
    return vs;
  }

  /** the include with `concept` as an accessor over its rows, in its original key position */
  _lazyInclude(inc, l) {
    const self = this;
    const { first_row: first, concept_count: n } = l.info;
    let arr = null;
    const out = {};
    let placed = false;
    const place = () => {
      Object.defineProperty(out, 'concept', {
        enumerable: true, configurable: true,
        get() {
          if (!arr) arr = self.s.rows.all(first, first + n - 1).map((x) => rowConcept(x[0], x[1], x[2]));
          return arr;
        },
        set(v) { arr = v; }
      });
      placed = true;
    };
    // the skeleton kept the key order; concept was deleted, so put it back after system/version
    for (const [k, v] of Object.entries(inc)) {
      if (!placed && k !== 'system' && k !== 'version') place();
      out[k] = v;
    }
    if (!placed) place();
    Object.defineProperty(out, STORED, {
      enumerable: false,
      value: {
        count: n,
        /** the listed concepts with this code, in list order (usually 0 or 1): one indexed read */
        lookup(code) {
          if (arr) return arr.filter((cc) => cc.code === code);
          return self.s.lookup.all(l.vsId, l.part, String(code)).map((x) => rowConcept(x[0], x[1], x[2]));
        }
      }
    });
    return out;
  }

  // ---- search ----------------------------------------------------------------------------------

  async searchValueSets(searchParams, elements = null) {
    await this.initialize();
    this._validateSearchParams(searchParams);
    if (this.kind === 'vsac' && searchParams.length === 0) return [];
    const canOptimize = elements && elements.length > 0 && elements.every((e) => INDEXED_COLUMNS.includes(e));
    // as main (ValueSetDatabase.search): the version too when the results are matched on it
    const versionAsked = searchParams.filter((p) => p.name.toLowerCase() === 'version').map((p) => p.value);
    let columns = canOptimize ? (elements.includes('id') ? elements : ['id', ...elements]) : null;
    if (columns && versionAsked.length > 0 && !columns.includes('version')) columns = [...columns, 'version'];
    const { query, params } = this._buildSearchQuery(searchParams, columns);
    const rows = this.db.prepare(query).all(...params);
    let results;
    if (canOptimize) {
      results = rows.map((row) => {
        const obj = { resourceType: 'ValueSet' };
        for (const c of columns) {
          if (row[c] !== null && row[c] !== undefined) obj[c] = c === 'id' && this.spaceId ? `${this.spaceId}-${row[c]}` : row[c];
        }
        return obj;
      });
    } else if (versionAsked.length === 0) {
      // as VSACValueSetProvider (#333): each match carries what a search is sorted by, and load()
      // builds the value set; the search worker builds only the page it returns (SearchWorker.loadPage).
      // Building every match - a left-matched url can match thousands - costs memory for nothing
      const meta = this.db.prepare('SELECT id, url, version, date, name FROM value_set WHERE vs_id = ?');
      results = rows.map((row) => this._searchMatch(row.vs_id, meta.get(row.vs_id)));
    } else {
      results = rows.map((row) => this._build(row.vs_id)).filter(Boolean);
    }
    for (const criteria of versionAsked) {
      results = results.filter((r) => {
        const json = r.jsonObj || r;
        return VersionUtilities.versionSearchMatches(criteria, json.version, VersionUtilities.versionAlgorithmOf(json));
      });
    }
    if (this.excludedIds.size) {
      results = results.filter((r) => !this.excludedIds.has(stripIdPrefix((r.jsonObj || r).id, this.spaceId)));
    }
    return results;
  }

  /** a deferred search match (see searchValueSets): the sort fields, and load() for the value set */
  _searchMatch(vsId, row) {
    const match = { resourceType: 'ValueSet', id: this.spaceId ? `${this.spaceId}-${row.id}` : row.id };
    for (const name of ['url', 'version', 'date', 'name']) {
      if (row[name] != null) match[name] = row[name];
    }
    // the value set as search would have returned it (its JSON, as SearchWorker keeps it); null if
    // it can't be built
    Object.defineProperty(match, 'load', { value: async () => { const vs = this._build(vsId); return vs ? vs.jsonObj : null; } });
    return match;
  }

  /** ValueSetDatabase._buildSearchQuery on the content tables */
  _buildSearchQuery(searchParams, elements) {
    const conditions = [];
    const params = [];
    const joins = new Map(); // alias -> table, in first-use order
    for (const { name, value } of searchParams) {
      switch (name.toLowerCase()) {
        // as main: a left match (case-sensitive) on the url
        case 'url': conditions.push('substr(v.url, 1, length(?)) = ?'); params.push(value, value); break;
        // as main: narrowed to the versions that could match, matched on the results (versionSearchMatches)
        case 'version':
          conditions.push("v.version LIKE ? ESCAPE '\\'");
          params.push(VersionUtilities.versionSearchPrefix(value).replace(/[\\%_]/g, (c) => '\\' + c) + '%'); break;
        case 'name': case 'title': case 'status': case 'publisher': case 'description': case 'date':
          conditions.push(`v.${name.toLowerCase()} LIKE ?`); params.push(`%${value}%`); break;
        case 'identifier':
          joins.set('vi', 'vs_identifier');
          conditions.push('(vi.system = ? OR vi.value LIKE ?)'); params.push(value, `%${value}%`); break;
        case 'jurisdiction':
          joins.set('vj', 'vs_jurisdiction');
          conditions.push('(vj.system = ? OR vj.code LIKE ?)'); params.push(value, `%${value}%`); break;
        case 'system':
          joins.set('vsys', 'vs_system');
          if (value.includes('|')) {
            conditions.push('vsys.system = ?'); params.push(value.substring(0, value.indexOf('|')));
            conditions.push('vsys.version = ?'); params.push(value.substring(value.indexOf('|') + 1));
          } else {
            conditions.push('vsys.system = ?'); params.push(value);
          }
          break;
        default:
          // main: LIKE over the whole resource JSON; here the skeleton plus the listed codes
          conditions.push(`(v.json LIKE ? OR EXISTS (SELECT 1 FROM vs_concept c WHERE c.vs_id = v.vs_id
            AND (c.code LIKE ? OR c.display LIKE ? OR c.json LIKE ?)))`);
          params.push(`%${value}%`, `%${value}%`, `%${value}%`, `%${value}%`);
          break;
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const select = elements ? `SELECT DISTINCT ${elements.map((e) => `v.${e}`).join(', ')}, v.url AS _url` : 'SELECT DISTINCT v.vs_id, v.url AS _url';
    // main's plan drives a joined search from the joined table, so equal urls come out in that
    // table's order; CROSS JOIN makes SQLite keep that order here
    let from = 'value_set v';
    const js = [...joins];
    if (js.length) {
      from = `${js[0][1]} ${js[0][0]} CROSS JOIN value_set v ON v.vs_id = ${js[0][0]}.vs_id`
        + js.slice(1).map(([a, t]) => ` JOIN ${t} ${a} ON ${a}.vs_id = v.vs_id`).join('');
    }
    return { query: `${select} FROM ${from} ${where} ORDER BY v.url`, params };
  }

  async listAllValueSets() {
    await this.initialize();
    const urls = this.s.urls.all();
    return this.excludedUrls.size === 0 ? urls : urls.filter((u) => !this.excludedUrls.has(u));
  }

  // ---- THO precedence (tx/provider.js applyTHOPrecedence) ---------------------------------------

  /** AbstractValueSetProvider.thoVersions: url -> Set(version), when this is a THO package */
  thoVersions(map) {
    if (!isTHOPackage(this.sourcePackage())) return map;
    for (const r of this.db.prepare('SELECT url, version FROM value_set WHERE url IS NOT NULL').iterate()) {
      if (!map.has(r.url)) map.set(r.url, new Set());
      if (r.version) map.get(r.url).add(r.version);
    }
    return map;
  }

  /** AbstractValueSetProvider.yieldToTHO: a FHIR core package keeps only pinned references */
  yieldToTHO(thoValueSets) {
    if (VersionUtilities.isCorePackage(this.sourcePackage())) this.keepPinnedOnly(thoValueSets);
  }

  keepPinnedOnly(thoValueSets) {
    // as PackageValueSetProvider.keepPinnedOnly, by rows instead of map keys (core packages only)
    for (const r of this.db.prepare('SELECT id, url FROM value_set').iterate()) {
      const tho = thoValueSets.get(r.url);
      if (!tho) continue;
      this.excludedUrls.add(r.url);
      this.excludedIds.add(r.id);
      this.pinned.set(r.url, tho);
    }
  }

  // ---- usage scan (tx/usage-tracker.js) ---------------------------------------------------------

  /**
   * What ConceptUsageTracker.scanValueSets does with this provider (fetchValueSet(url) for every
   * listed url, then every include's codes), read from the rows without building value sets.
   * @returns {number} the value sets it would count
   */
  async scanUsage(tracker) {
    await this.initialize();
    const listed = new Map();
    for (const u of await this.listAllValueSets()) listed.set(u, (listed.get(u) || 0) + 1);
    const codes = this.db.prepare(`SELECT i.system, c.code FROM vs_include i JOIN vs_concept c
      ON c.row BETWEEN i.first_row AND i.first_row + i.concept_count - 1
      WHERE i.vs_id = ? AND i.exclude = 0 AND i.system IS NOT NULL AND i.concept_count > 0 ORDER BY c.row`).raw();
    let c = 0;
    for (const [url, times] of listed) {
      if (url == null) continue;
      const cand = this._candidates(url, null)[0];
      if (!cand) continue;
      if (!this.s.hasCompose.get(cand.vs_id)) continue;
      const rows = codes.all(cand.vs_id);
      let ok = false;
      for (let k = 0; k < times; k++) {
        for (const [system, code] of rows) {
          if (code) { ok = true; tracker.seeConcept(system, code); }
        }
      }
      if (ok) c += times;
    }
    return c;
  }
}

module.exports = { ContentValueSetProvider, STORED, EAGER_MAX, isNewerVersion };
