'use strict';
// Request traces (format fhirsmith-expand-trace/0-draft.3, docs/sqlite-v2-trace.md).
//
// A Tracer exists only when tracing is on for the request. Engine code holds `trace` (or null)
// and `stats` (the tracer's live counters, or null): with tracing off every hook is a null check.

const FORMAT = 'fhirsmith-expand-trace/0-draft.3';
const SETS_PER_SPAN = 8; // stored sets named per span; the rest are counted in setsMore
const EXTENSION_URL = 'http://fhirsmith.org/fhir/StructureDefinition/expansion-trace';

function nowUs() {
  return Number(process.hrtime.bigint()) / 1000;
}

class Tracer {
  constructor(request = {}) {
    this.t0 = nowUs();
    this.trace = {
      traceFormat: FORMAT,
      id: null,
      startedAt: new Date().toISOString(),
      request,
      versions: [],
      spans: [],
      memory: [],
      sources: {},
      result: null,
      summary: null
    };
    // live counters; the store adds to these
    this.stats = { statements: 0, rows: 0, setsLoaded: 0, setBytes: 0, setLoadUs: 0 };
    // hooks the store calls with each statement and each batch of stored sets it read; not
    // enumerable, so the span snapshots ({ ...stats }) copy the counters only
    Object.defineProperty(this.stats, 'read', { value: (store, st, rows) => this._read(store, st, rows) });
    Object.defineProperty(this.stats, 'sets', { value: (store, kind, pid, rows) => this._sets(store, kind, pid, rows) });
    this._src = new Map();   // store -> Map(statement -> source id)
    this._pendingSets = [];  // stored sets to name at finish: [span entry, store, kind, pid, value]
    this._stack = [];
    this._n = 0;
    this.mem('start');
  }

  elapsedUs() { return nowUs() - this.t0; }

  version(system, version) {
    if (!this.trace.versions.some((v) => v.system === system && v.version === version)) {
      this.trace.versions.push({ system, version });
    }
  }

  /**
   * Run fn inside a span. kind: 'op' (the request) | 'vs' (a value set expansion) | 'part'
   * (an include, exclude or import) | 'provider' (an existing provider, opaque) | 'sql' | 'set'
   * | 'rows' (engine steps). fn's return value is passed through;
   * if it is a bitmap, its cardinality and size are recorded.
   */
  span(label, kind, system, fn, extra) {
    const s = this.open(label, kind, system, extra);
    try {
      const r = fn();
      this.close(s, r);
      return r;
    } catch (e) {
      s.error = e.message;
      this.close(s, null);
      throw e;
    }
  }

  /** the innermost open span, or null */
  current() { return this._stack.length ? this._stack[this._stack.length - 1] : null; }

  /** add fields to the innermost open span (e.g. the provider that served an include) */
  annotate(fields) {
    const s = this.current();
    if (s) Object.assign(s, fields);
  }

  open(label, kind, system, extra) {
    const st = this.stats;
    const s = {
      node: 'n' + (++this._n),
      parent: this._stack.length ? this._stack[this._stack.length - 1].node : null,
      label, kind, system: system || null,
      startUs: round(nowUs() - this.t0),
      _c: { ...st, heap: process.memoryUsage().heapUsed }
    };
    if (extra) Object.assign(s, extra);
    this._stack.push(s);
    this.trace.spans.push(s);
    return s;
  }

  close(s, result) {
    const st = this.stats;
    const c = s._c;
    delete s._c;
    s.durUs = round(nowUs() - this.t0 - s.startUs);
    s.sqlStatements = st.statements - c.statements;
    s.sqlRows = st.rows - c.rows;
    s.setsLoaded = st.setsLoaded - c.setsLoaded;
    s.setBytes = st.setBytes - c.setBytes;
    s.setLoadUs = round(st.setLoadUs - c.setLoadUs);
    s.heapDeltaBytes = process.memoryUsage().heapUsed - c.heap;
    if (result && typeof result.size === 'number' && typeof result.has === 'function') {
      s.setCard = result.size;
      if (s.setBytes === 0 && typeof result.getSerializationSizeInBytes === 'function') {
        s.setBytes = result.getSerializationSizeInBytes('portable');
      }
    }
    if (s.cache === undefined) s.cache = null;
    if (s._reads) { s.reads = [...s._reads.values()]; delete s._reads; }
    const i = this._stack.lastIndexOf(s);
    if (i >= 0) this._stack.splice(i, 1);
  }

  /**
   * A statement ran inside the innermost open span: count it against its source (database,
   * tables, index, statement shape). Statements of one shape add up: {src, n, rows}.
   */
  _read(store, st, rows) {
    const s = this.current();
    if (!s) return;
    let byStmt = this._src.get(store);
    if (!byStmt) this._src.set(store, byStmt = new Map());
    let src = byStmt.get(st);
    if (!src) {
      src = 'q' + (Object.keys(this.trace.sources).length + 1);
      byStmt.set(st, src);
      this.trace.sources[src] = { db: dbName(store), ...describeStatement(st) };
    }
    const m = s._reads || (s._reads = new Map());
    const r = m.get(src);
    if (r) { r.n++; r.rows += rows; } else m.set(src, { src, n: 1, rows });
  }

  /** stored sets read from concept_set ({value, card, bytes} each): named on the span at finish */
  _sets(store, kind, pid, rows) {
    const s = this.current();
    if (!s) return;
    const list = s.sets || (s.sets = []);
    for (const r of rows) {
      if (list.length >= SETS_PER_SPAN) { s.setsMore = (s.setsMore || 0) + 1; continue; }
      const e = { key: null, card: r.card, bytes: r.bytes };
      list.push(e);
      this._pendingSets.push([e, store, kind, pid, r.value]);
    }
  }

  /** name the stored sets: descendants(<code>), <property> = <value>, refset(<code>), ... (kinds: KIND in store.js) */
  _nameSets() {
    const ids = new Map(); // store -> Set(concept ids to name)
    const want = (store, id) => { (ids.get(store) || ids.set(store, new Set()).get(store)).add(id); };
    for (const [, store, kind, pid, value] of this._pendingSets) {
      const def = pid ? store.propsById.get(pid) : null;
      if (kind === 4 || kind === 7 || (kind === 5 && def && def.kind === 'concept')) want(store, value);
    }
    const rows = new Map();
    for (const [store, set] of ids) {
      try { rows.set(store, store.conceptRows([...set], null)); } catch (e) { rows.set(store, new Map()); }
    }
    const SHORT = 48;
    for (const [e, store, kind, pid, value] of this._pendingSets) {
      const def = pid ? store.propsById.get(pid) : null;
      const r = rows.has(store) ? rows.get(store).get(value) : null;
      const code = r ? r.code : String(value);
      if (r && r.display) e.display = r.display.length > SHORT ? r.display.slice(0, SHORT - 1) + '…' : r.display;
      const pcode = def ? def.code : 'p' + pid;
      switch (kind) {
        case 1: e.key = 'all concepts'; break;
        case 2: e.key = 'active concepts'; break;
        case 3: e.key = 'leaf concepts'; break;
        case 4: e.key = `descendants(${code})`; break;
        case 5: e.key = def && def.isHierarchy ? `children(${code})` : `${pcode} = ${def && def.kind === 'concept' ? code : value}`; break;
        case 6: e.key = `has ${pcode}`; break;
        case 7: e.key = `refset(${code})`; break;
        default: e.key = `kind ${kind}: ${pcode} = ${value}`;
      }
    }
    this._pendingSets = [];
  }

  mem(label, setBytesLive) {
    const m = process.memoryUsage();
    this.trace.memory.push({ label, tUs: round(this.elapsedUs()), heapUsed: m.heapUsed, rss: m.rss, setBytesLive: setBytesLive ?? null });
  }

  /**
   * Make each span's children account for all of it: where a span's own counters exceed the sum
   * of its children's, add a child "other (outside named steps)" with the difference, so the row
   * and statement counts of the steps add up to the summary.
   */
  addRemainders() {
    const kids = new Map();
    for (const s of this.trace.spans) if (s.parent) (kids.get(s.parent) || kids.set(s.parent, []).get(s.parent)).push(s);
    const extra = [];
    for (const s of this.trace.spans) {
      const ch = kids.get(s.node);
      if (!ch) continue;
      const sum = (f) => ch.reduce((n, c) => n + (c[f] || 0), 0);
      const rows = (s.sqlRows || 0) - sum('sqlRows');
      const stmts = (s.sqlStatements || 0) - sum('sqlStatements');
      if (rows > 0 || stmts > 0) {
        const o = { node: s.node + '.other', parent: s.node, label: 'other (outside named steps)', kind: 'rows', system: s.system || null,
          startUs: s.startUs, durUs: Math.max(0, round((s.durUs || 0) - sum('durUs'))), sqlStatements: stmts, sqlRows: rows,
          setsLoaded: Math.max(0, (s.setsLoaded || 0) - sum('setsLoaded')), setBytes: 0, setLoadUs: 0, heapDeltaBytes: null, cache: null, synthetic: true };
        // the span's own reads are the ones outside its named steps: they move to this child
        for (const f of ['reads', 'sets', 'setsMore']) if (s[f] !== undefined) { o[f] = s[f]; delete s[f]; }
        extra.push(o);
      }
    }
    this.trace.spans.push(...extra);
  }

  /** run an async fn inside a span */
  async spanAsync(label, kind, system, fn, extra) {
    const s = this.open(label, kind, system, extra);
    try {
      const r = await fn(s);
      this.close(s, null);
      return r;
    } catch (e) {
      s.error = e.message;
      this.close(s, null);
      throw e;
    }
  }

  finish(result) {
    this.mem('end');
    this.addRemainders();
    if (this._pendingSets.length) this._nameSets();
    this._src.clear();
    this.trace.result = result;
    const st = this.stats;
    const byKind = {};
    for (const s of this.trace.spans) {
      if (s.parent) continue;
      byKind[s.kind] = round((byKind[s.kind] || 0) + s.durUs);
    }
    this.trace.summary = {
      wallUs: round(this.elapsedUs()),
      sqlStatements: st.statements,
      sqlRows: st.rows,
      setsLoaded: st.setsLoaded,
      setBytes: st.setBytes,
      setLoadUs: round(st.setLoadUs),
      topLevelUsByKind: byKind,
      longestSyncUs: this.trace.spans.reduce((m, s) => (!s.parent && s.durUs > m ? s.durUs : m), 0)
    };
    return this.trace;
  }
}

/** the logical name of a store's database: "SNOMED CT International 20260701", "LOINC 2.83" */
function dbName(store) {
  if (store._dbName) return store._dbName;
  const cs = store.cs || {};
  const name = String(cs.name || cs.title || store.system || 'database').replace(/ Edition$/, '');
  const m = String(store.version || '').match(/\/version\/(\d+)$/);
  const v = m ? m[1] : store.version;
  store._dbName = v && !name.includes(v) ? name + ' ' + v : name;
  return store._dbName;
}

// statement -> { access: [{table, index}], sql }, once per prepared statement for the process.
// The index comes from EXPLAIN QUERY PLAN (about 0.1 ms, once per statement; parameters bound
// as null, which SQLite's planner does not look at without STAT4).
const described = new WeakMap();
const SQL_MAX = 160;

function describeStatement(st) {
  let d = described.get(st);
  if (d) return d;
  const sql = String(st.source || '');
  d = { access: planAccess(st, sql), sql: shapeSql(sql) };
  described.set(st, d);
  return d;
}

/** one short line: whitespace collapsed, id lists as (…), long statements cut */
function shapeSql(sql) {
  let s = sql.replace(/\s+/g, ' ').trim()
    .replace(/\(SELECT value FROM json_each\(\?\)\)/gi, '(…)')
    .replace(/\(SELECT group_concat\([^)]*\) FROM (\w+)[^)]*\)/gi, '(…$1…)');
  if (s.length > SQL_MAX) s = s.slice(0, SQL_MAX - 1) + '…';
  return s;
}

function planAccess(st, sql) {
  const alias = new Map();
  const KW = /^(WHERE|JOIN|ON|ORDER|GROUP|LIMIT|AND|LEFT|INNER|CROSS|USING)$/i;
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    alias.set(m[1], m[1]);
    if (m[2] && !KW.test(m[2])) alias.set(m[2], m[1]);
  }
  const out = [];
  try {
    const n = (sql.match(/\?/g) || []).length;
    for (const r of st.database.prepare('EXPLAIN QUERY PLAN ' + sql).all(...new Array(n).fill(null))) {
      const m = String(r.detail).match(/^(SEARCH|SCAN) (\w+)(?: USING (.*?))?(?: \((.*)\))?$/);
      if (!m || m[2] === 'json_each' || /^(pragma_|sqlite_)/.test(m[2])) continue;
      const table = alias.get(m[2]) || m[2];
      const how = m[3] || '';
      let index;
      if (/VIRTUAL TABLE/.test(how)) index = 'full-text';
      else if (/INTEGER PRIMARY KEY/.test(how)) index = /[<>]/.test(m[4] || '') ? 'rowid range' : 'rowid';
      else if (/PRIMARY KEY/.test(how)) index = 'primary key';
      else if ((index = (how.match(/INDEX (\w+)/) || [])[1])) { /* a named index */ }
      else index = m[1] === 'SCAN' ? 'full scan' : 'search';
      if (!out.some((a) => a.table === table && a.index === index)) out.push({ table, index });
    }
  } catch (e) {
    // no plan (e.g. a closed handle): name the tables only
  }
  if (!out.length) for (const t of new Set(alias.values())) if (t !== 'json_each') out.push({ table: t, index: null });
  return out;
}

function round(x) {
  return Math.round(x * 10) / 10;
}

/** bounded ring buffer of finished traces, for the debug endpoint */
class TraceRing {
  constructor(size = 200) {
    this.size = size;
    this.items = [];
    this.seq = 0;
  }
  push(trace) {
    trace.id = trace.id || 't' + (++this.seq);
    this.items.push(trace);
    if (this.items.length > this.size) this.items.shift();
    return trace.id;
  }
  list() {
    return this.items.map((t) => ({ id: t.id, startedAt: t.startedAt, url: t.request && t.request.url, wallUs: t.summary && t.summary.wallUs, total: t.result && t.result.total }));
  }
  get(id) { return this.items.find((t) => t.id === id) || null; }
}

const ring = new TraceRing();

/** mode: 'off' (default), 'request' (_trace=true requests), 'all' (every engine expansion) */
const settings = { mode: 'off' };

function wanted(params) {
  if (settings.mode === 'all') return true;
  return settings.mode === 'request' && !!(params && params.trace);
}

module.exports = { Tracer, TraceRing, ring, settings, wanted, FORMAT, EXTENSION_URL, nowUs, describeStatement, dbName };
