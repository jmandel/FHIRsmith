'use strict';
// Expansion engine for one store: compiled selection -> ordered result -> pages.
//
// A selection is { includes: [Include], excludes: [Include], activeOnly }, where an Include is
// { parts: [{ node, order }] } in the order upstream expand.js would add codes (enumerated
// concepts first, then filters); order = explicit id order (enumerated concepts) or null
// (id order = depth-first hierarchy order).
//
// The result is a list of segments, one per part, each with the members not already in an
// earlier segment and not excluded. Paging is by position across segments. Nothing is cached:
// every request plans and evaluates. Ids are eager unless the plan has a costly unselective input
// (text/regex scan) and the request is paged: then only the members up to offset+count are
// produced (lazy first page, no total).

const { RoaringBitmap32 } = require('roaring');
const { Evaluator } = require('./evaluate');
const { KIND, registry } = require('../store');

const LAZY_MIN_DRIVER = 50000; // a costly filter over at least this many candidates goes lazy when paged

class Result {
  constructor() {
    this.segments = []; // { bm } (id order) or { list } (explicit order)
    this.total = 0;
    this.complete = true; // false: lazy, total unknown
    this.bytes = 0;
  }

  add(seg) {
    const n = seg.bm ? seg.bm.size : seg.list.length;
    if (!n) return;
    seg.n = n;
    this.segments.push(seg);
    this.total += n;
    this.bytes += seg.bm ? seg.bm.getSerializationSizeInBytes('portable') + 352 : seg.list.length * 16 + 64;
  }

  /** ids at positions [offset, offset+count) */
  page(offset, count) {
    const out = [];
    let pos = 0;
    const end = count < 0 ? Infinity : offset + count;
    for (const s of this.segments) {
      if (pos + s.n <= offset) { pos += s.n; continue; }
      if (pos >= end) break;
      const from = Math.max(0, offset - pos);
      const take = Math.min(s.n - from, end - pos - from);
      if (s.bm) {
        for (const id of s.bm.rangeUint32Array(from, take)) out.push(id);
      } else {
        for (let i = from; i < from + take; i++) out.push(s.list[i]);
      }
      pos += s.n;
    }
    return out;
  }

  has(id) {
    for (const s of this.segments) if (s.bm ? s.bm.has(id) : s.list.includes(id)) return true;
    return false;
  }
}

class Engine {
  constructor(store, opts = {}) {
    this.store = store;
    registry.engines.add(this);
    this.lazyMinDriver = opts.lazyMinDriver || LAZY_MIN_DRIVER;
    // optional system order (LOINC release-file order): { rank[id], ids[rank] }, data built at load
    this._order = opts.order || null;
  }

  /**
   * @param {object} sel compiled selection
   * @param {object} opts { offset, count, trace }
   * @returns {Result}
   */
  run(sel, opts = {}) {
    // every request plans and evaluates: the design keeps no caches (docs/sqlite-v2-engine.md)
    const trace = opts.trace || null;
    const want = opts.count >= 0 ? Math.max(opts.offset, 0) + opts.count : -1;
    const ev = new Evaluator(this.store, { trace });
    const run = () => this._evaluate(ev, sel, want);
    return trace ? trace.span('evaluate selection', 'set', this.store.system, run) : run();
  }

  _evaluate(ev, sel, want) {
    const allNodes = [];
    for (const inc of [...sel.includes, ...sel.excludes]) for (const p of inc.parts) allNodes.push(p.node);
    ev.prefetch(allNodes);

    let excl = null;
    for (const inc of sel.excludes) {
      for (const p of inc.parts) {
        const b = ev.mat(p.node);
        excl = excl ? RoaringBitmap32.or(excl, b) : b;
      }
    }
    const active = sel.activeOnly ? ev.mat({ t: 'active' }) : null;

    const parts = [];
    for (const inc of sel.includes) for (const p of inc.parts) parts.push(p);

    // lazy only for a single filter part whose plan is driver ∧ costly filters over a large driver
    // lazy needs a page to stop at: count = 0 asks for the total, which only a full evaluation gives
    if (want > 0 && parts.length === 1 && !parts[0].order && !this._order) {
      const plan = this._lazyPlan(ev, parts[0].node, active, excl);
      if (plan) {
        const r = new Result();
        const got = ev.lazy(plan.driver, plan.filters, want, 0);
        let ids = got.ids;
        if (excl) ids = RoaringBitmap32.andNot(ids, excl);
        {
          r.add({ bm: ids });
          if (!r.segments.length) r.segments.push({ bm: ids, n: 0 });
        }
        r.complete = got.done;
        return r;
      }
    }

    const r = new Result();
    let seen = null;
    for (const p of parts) {
      let b = ev.mat(p.node);
      if (active) b = RoaringBitmap32.and(b, active);
      if (excl) b = RoaringBitmap32.andNot(b, excl);
      if (seen) b = RoaringBitmap32.andNot(b, seen);
      if (p.order) {
        const list = [];
        const dup = new Set();
        for (const id of p.order) if (b.has(id) && !dup.has(id)) { dup.add(id); list.push(id); }
        r.add({ list });
      } else if (p.node.t === 'set' && p.node.kind === KIND.refset && this.store.sequenceOf(p.node.value)) {
        // an ordered list (LOINC answer list): its own order
        const seqd = this.store.sequenceOf(p.node.value).filter((id) => b.has(id));
        const rest = RoaringBitmap32.andNot(b, new RoaringBitmap32(seqd));
        r.add({ list: [...seqd, ...(this._order ? this._ordered(rest) : rest.toArray())] });
      } else if (this._order) {
        r.add({ list: this._ordered(b) });
      } else {
        r.add({ bm: b });
      }
      seen = seen ? RoaringBitmap32.or(seen, b) : b;
    }
    return r;
  }

  /** members of b in the system's order: sort their ranks (typed arrays) */
  _ordered(b) {
    const { rank, ids } = this._order;
    const arr = b.toUint32Array();
    const ranks = new Uint32Array(arr.length);
    for (let i = 0; i < arr.length; i++) ranks[i] = rank[arr[i]];
    ranks.sort();
    const out = new Array(ranks.length);
    for (let k = 0; k < ranks.length; k++) out[k] = ids[ranks[k]];
    return out;
  }

  /** driver (free) and costly filters, if this node is worth evaluating lazily */
  _lazyPlan(ev, node, active, excl) {
    const items = node.t === 'and' ? node.items : [node];
    const free = items.filter((i) => ev.isFree(i));
    const costly = items.filter((i) => !ev.isFree(i) && ((i.t === 'text' && !i.lits) || (i.t === 'desigRegex' && !i.lits) || i.t === 'litMatch' || i.t === 'descFilter' || (i.t === 'desigMatch' && i.re != null)));
    if (!costly.length || free.length + costly.length !== items.length) return null; // (a prefiltered text node is neither: evaluated whole)
    let driver = free.length ? (free.length === 1 ? free[0] : { t: 'and', items: free }) : { t: 'all' };
    if (active) driver = { t: 'and', items: [driver, { t: 'active' }] };
    const size = ev.mat(driver).size;
    if (size < this.lazyMinDriver) return null;
    void excl;
    return { driver, filters: costly };
  }

  /** membership of one id in a node (validate-code): probes, never materialises costly inputs */
  contains(node, id, trace) {
    const ev = new Evaluator(this.store, { trace });
    ev.prefetch([node]);
    return ev.filter(node, new RoaringBitmap32([id])).has(id);
  }

  /** materialise one node (filter API) */
  evaluate(node, trace) {
    const ev = new Evaluator(this.store, { trace });
    ev.prefetch([node]);
    return ev.mat(node);
  }
}

module.exports = { Engine, Result };
