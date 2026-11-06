'use strict';
// Request traces (format fhirsmith-expand-trace/0-draft.2, docs/sqlite-v2-trace.md).
//
// A Tracer exists only when tracing is on for the request. Engine code holds `trace` (or null)
// and `stats` (the tracer's live counters, or null): with tracing off every hook is a null check.

const FORMAT = 'fhirsmith-expand-trace/0-draft.2';
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
      result: null,
      summary: null
    };
    // live counters; the store adds to these
    this.stats = { statements: 0, rows: 0, setsLoaded: 0, setBytes: 0, setLoadUs: 0 };
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
    const i = this._stack.lastIndexOf(s);
    if (i >= 0) this._stack.splice(i, 1);
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
        extra.push({ node: s.node + '.other', parent: s.node, label: 'other (outside named steps)', kind: 'rows', system: s.system || null,
          startUs: s.startUs, durUs: Math.max(0, round((s.durUs || 0) - sum('durUs'))), sqlStatements: stmts, sqlRows: rows,
          setsLoaded: Math.max(0, (s.setsLoaded || 0) - sum('setsLoaded')), setBytes: 0, setLoadUs: 0, heapDeltaBytes: null, cache: null, synthetic: true });
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

module.exports = { Tracer, TraceRing, ring, settings, wanted, FORMAT, EXTENSION_URL, nowUs };
