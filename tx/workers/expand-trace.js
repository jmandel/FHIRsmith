/**
 * Expand Trace — ambient structured tracing for expand-v2 debugging.
 *
 * Uses AsyncLocalStorage so any code in the expand call chain can write
 * trace events without explicit argument threading.
 *
 * Usage from expand-v2 (the entry point):
 *   const { traceStore, ExpandTrace } = require('./expand-trace');
 *   const trace = new ExpandTrace();
 *   await traceStore.run(trace, async () => {
 *     // ... expansion work ...
 *   });
 *   trace.attachTo(expansion);
 *
 * Usage from anywhere in the call chain (providers, workers, etc.):
 *   const { trace } = require('path/to/expand-trace');
 *   trace.begin('myMethod', { arg1: 'x' }).end({ result: 42 });
 *   trace.sql('SELECT ...', params, rowCount, elapsedMs);
 *   trace.note('something happened', { detail: 'y' });
 *
 * When no trace is active (called outside an expand), all calls are no-ops.
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const traceStore = new AsyncLocalStorage();

// ── Ambient accessors (call from anywhere) ─────────────────────────────────

/** Get the current trace, or a no-op stub. */
function currentTrace() {
  return traceStore.getStore() || NOOP_TRACE;
}

const trace = {
  begin(name, args) { return currentTrace().begin(name, args); },
  sql(sql, params, rows, ms) { currentTrace().sql(sql, params, rows, ms); },
  count(name, delta) { currentTrace().count(name, delta); },
  note(message, data) { currentTrace().note(message, data); },
  get active() { return traceStore.getStore() != null; },
};

// ── ExpandTrace ────────────────────────────────────────────────────────────

class ExpandTrace {
  constructor() {
    this.root = { name: 'expand', children: [], t0: performance.now() };
    this.stack = [this.root];
    this.sqlQueries = [];
    this.counters = Object.create(null);
  }

  begin(name, args) {
    const span = {
      name,
      args: summarize(args),
      t0: performance.now(),
      children: [],
    };
    this.stack[this.stack.length - 1].children.push(span);
    this.stack.push(span);
    return new Span(this, span);
  }

  sql(sql, params, rows, ms) {
    const entry = {
      sql: trunc(sql, 500),
      params: summarize(params),
      rows: typeof rows === 'number' ? rows : undefined,
      ms: typeof ms === 'number' ? rnd(ms) : undefined,
    };
    const cur = this.stack[this.stack.length - 1];
    cur.sql = cur.sql || [];
    cur.sql.push(entry);
    this.sqlQueries.push(entry);
  }

  count(name, delta = 1) {
    if (!name) return;
    const n = Number(delta);
    if (!Number.isFinite(n) || n === 0) return;
    this.counters[name] = (this.counters[name] || 0) + n;
  }

  note(message, data) {
    this.stack[this.stack.length - 1].children.push({
      name: 'note', message,
      data: data !== undefined ? summarize(data) : undefined,
      t: rnd(performance.now() - this.root.t0),
    });
  }

  _pop(result) {
    if (this.stack.length <= 1) return;
    const span = this.stack.pop();
    span.ms = rnd(performance.now() - span.t0);
    if (result !== undefined) span.result = summarize(result);
    delete span.t0;
  }

  toJSON() {
    while (this.stack.length > 1) this._pop({ _unclosed: true });
    this.root.ms = rnd(performance.now() - this.root.t0);
    delete this.root.t0;
    return {
      totalMs: this.root.ms,
      sqlCount: this.sqlQueries.length,
      sqlMs: rnd(this.sqlQueries.reduce((s, q) => s + (q.ms || 0), 0)),
      counters: summarize(this.counters),
      spans: this.root.children,
    };
  }

  attachTo(expansion) {
    const json = this.toJSON();
    expansion.extension = expansion.extension || [];
    expansion.extension.push({
      url: 'http://fhirsmith.org/StructureDefinition/expand-trace',
      valueString: JSON.stringify(json),
    });
  }
}

// ── Span ───────────────────────────────────────────────────────────────────

class Span {
  constructor(owner, data) {
    this._owner = owner;
    this._data = data;
    this._ended = false;
  }

  end(result) {
    if (this._ended) return;
    this._ended = true;
    const stack = this._owner.stack;
    if (stack[stack.length - 1] === this._data) {
      this._owner._pop(result);
    } else {
      // Out-of-order close — annotate in place
      this._data.ms = rnd(performance.now() - this._data.t0);
      if (result !== undefined) this._data.result = summarize(result);
      delete this._data.t0;
    }
  }

  begin(name, args) { return this._owner.begin(name, args); }
  sql(sql, params, rows, ms) { this._owner.sql(sql, params, rows, ms); }
  count(name, delta) { this._owner.count(name, delta); }
  note(msg, data) { this._owner.note(msg, data); }
}

// ── No-ops ─────────────────────────────────────────────────────────────────

const NOOP_SPAN = Object.freeze({
  end() {}, begin() { return NOOP_SPAN; },
  sql() {}, count() {}, note() {},
});

const NOOP_TRACE = Object.freeze({
  begin() { return NOOP_SPAN; },
  sql() {}, count() {}, note() {},
  toJSON() { return null; },
  attachTo() {},
});

// ── Helpers ────────────────────────────────────────────────────────────────

function rnd(n) { return Math.round(n * 100) / 100; }
function trunc(s, max) {
  return typeof s === 'string' && s.length > max ? s.slice(0, max) + '…' : s;
}

function formatMs(ms) {
  if (typeof ms !== 'number') return '?ms';
  return `${rnd(ms)}ms`;
}

function collectSpanRows(spans, out = [], depth = 0, parent = '') {
  for (const span of spans || []) {
    if (!span || span.name === 'note') continue;
    const path = parent ? `${parent} > ${span.name}` : span.name;
    out.push({ span, depth, path });
    collectSpanRows(span.children || [], out, depth + 1, path);
  }
  return out;
}

function collectSqlRows(spans, out = []) {
  for (const span of spans || []) {
    if (!span || span.name === 'note') continue;
    for (const q of span.sql || []) {
      out.push({ span: span.name, sql: q.sql, ms: q.ms, rows: q.rows });
    }
    collectSqlRows(span.children || [], out);
  }
  return out;
}

function formatTraceSummary(traceJson, opts = {}) {
  if (!traceJson) return 'trace unavailable';
  const maxSpans = Number.isInteger(opts.maxSpans) && opts.maxSpans > 0 ? opts.maxSpans : 12;
  const maxSql = Number.isInteger(opts.maxSql) && opts.maxSql > 0 ? opts.maxSql : 6;
  const includeSql = opts.includeSql !== false;
  const lines = [];
  const spans = collectSpanRows(traceJson.spans || []);
  lines.push(`trace total=${formatMs(traceJson.totalMs)} spans=${spans.length} sql=${traceJson.sqlCount || 0} (${formatMs(traceJson.sqlMs || 0)})`);

  if (spans.length > 0) {
    lines.push(`slow spans (top ${Math.min(maxSpans, spans.length)}):`);
    const top = [...spans]
      .sort((a, b) => (b.span.ms || 0) - (a.span.ms || 0))
      .slice(0, maxSpans);
    for (const row of top) {
      lines.push(`  - ${row.path}: ${formatMs(row.span.ms || 0)}`);
    }
  }

  if (includeSql) {
    const sqlRows = collectSqlRows(traceJson.spans || [])
      .sort((a, b) => (b.ms || 0) - (a.ms || 0))
      .slice(0, maxSql);
    if (sqlRows.length > 0) {
      lines.push(`slow SQL (top ${sqlRows.length}):`);
      for (const q of sqlRows) {
        const rowsTxt = typeof q.rows === 'number' ? ` rows=${q.rows}` : '';
        lines.push(`  - [${q.span}] ${formatMs(q.ms || 0)}${rowsTxt} ${trunc(q.sql || '', 180)}`);
      }
    }
  }

  const counters = traceJson.counters || {};
  const counterRows = Object.entries(counters)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v !== 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  if (counterRows.length > 0) {
    lines.push(`counters (top ${counterRows.length}):`);
    for (const [k, v] of counterRows) {
      lines.push(`  - ${k}: ${v}`);
    }
  }

  return lines.join('\n');
}

function summarize(val, depth = 0) {
  if (val == null) return val;
  if (typeof val === 'string') return trunc(val, 200);
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (depth > 2) return '…';
  if (Array.isArray(val)) {
    if (val.length <= 5) return val.map(v => summarize(v, depth + 1));
    return { _arr: val.length, head: val.slice(0, 3).map(v => summarize(v, depth + 1)) };
  }
  if (typeof val === 'object') {
    const out = {};
    const keys = Object.keys(val);
    for (const k of keys.slice(0, 12)) out[k] = summarize(val[k], depth + 1);
    if (keys.length > 12) out._more = keys.length - 12;
    return out;
  }
  return String(val).slice(0, 80);
}

module.exports = { ExpandTrace, traceStore, trace, formatTraceSummary };
