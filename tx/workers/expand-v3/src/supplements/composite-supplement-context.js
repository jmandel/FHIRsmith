'use strict';

const { SupplementContext } = require('./supplement-context');

/**
 * CompositeSupplementContext composes multiple supplement backends.
 *
 * Semantics:
 * - preparePredicate: OR across child contexts (a code is in-scope for a clause
 *   if any backend reports a hit for that code).
 * - decorateMany: deterministic overlay merge in context order (later contexts
 *   can add/override display/definition while designations/properties are unioned).
 */
class CompositeSupplementContext extends SupplementContext {
  constructor(contexts = []) {
    super();
    this.contexts = (Array.isArray(contexts) ? contexts : []).filter(Boolean);
  }

  canonicals() {
    const out = [];
    const seen = new Set();
    for (const ctx of this.contexts) {
      for (const c of (ctx.canonicals ? ctx.canonicals() : [])) {
        const s = String(c || '');
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  markResolved(url) {
    super.markResolved(url);
    for (const ctx of this.contexts) {
      if (ctx.markResolved) ctx.markResolved(url);
    }
  }

  markUsed(url, why = 'unknown') {
    super.markUsed(url, why);
    for (const ctx of this.contexts) {
      if (ctx.markUsed) ctx.markUsed(url, why);
    }
  }

  async preparePredicate(request) {
    const predicates = [];
    for (const ctx of this.contexts) {
      const p = await ctx.preparePredicate?.(request);
      if (p && typeof p.batchHas === 'function') {
        predicates.push(p);
      }
    }
    if (predicates.length === 0) return null;
    if (predicates.length === 1) return predicates[0];
    return {
      batchHas: async (codes) => {
        const keep = new Array(codes.length).fill(false);
        for (const p of predicates) {
          const hits = await p.batchHas(codes);
          for (let i = 0; i < keep.length; i++) {
            if (!keep[i] && hits[i] === true) keep[i] = true;
          }
        }
        return keep;
      },
      close: async () => {
        for (const p of predicates) {
          if (typeof p.close === 'function') await p.close();
        }
      },
    };
  }

  async decorateMany(request = {}) {
    const merged = new Map();
    for (const ctx of this.contexts) {
      const rows = await ctx.decorateMany?.(request);
      if (!(rows instanceof Map)) continue;
      for (const [code, row] of rows.entries()) {
        const key = String(code || '');
        if (!key) continue;
        const existing = merged.get(key) || { code: key };
        const incoming = row || {};
        if (incoming.display != null) existing.display = incoming.display;
        if (incoming.definition != null) existing.definition = incoming.definition;
        if (Array.isArray(incoming.designations) && incoming.designations.length > 0) {
          existing.designations = (existing.designations || []).concat(incoming.designations);
        }
        if (Array.isArray(incoming.properties) && incoming.properties.length > 0) {
          existing.properties = (existing.properties || []).concat(incoming.properties);
        }
        merged.set(key, existing);
      }
    }
    return merged;
  }

  native(request) {
    const out = [];
    for (const ctx of this.contexts) {
      const n = ctx.native?.(request);
      if (n != null) out.push(n);
    }
    if (out.length === 0) return null;
    const providerId = String(request?.providerId || '');
    if (providerId === 'sqlite') {
      const merged = this._mergeSqliteNativeHandles(out);
      if (merged) return merged;
      return null;
    }
    if (out.length === 1) return out[0];
    return { kind: 'composite', items: out };
  }

  async close() {
    for (const ctx of this.contexts) {
      if (typeof ctx.close === 'function') {
        await ctx.close();
      }
    }
  }

  _mergeSqliteNativeHandles(handles) {
    const flattened = [];
    const visit = (h) => {
      if (!h) return;
      if (h.kind === 'sqlite') {
        flattened.push(h);
        return;
      }
      if (h.kind === 'composite' && Array.isArray(h.items)) {
        for (const item of h.items) visit(item);
      }
    };
    for (const h of handles || []) visit(h);
    if (flattened.length === 0) return null;

    const properties = new Set();
    const operators = new Set();
    const attachments = [];
    const byPath = new Set();
    let complete = true;

    for (const h of flattened) {
      complete = complete && h.complete === true;
      for (const p of h.availableProperties || []) properties.add(String(p));
      for (const o of h.availableOperators || []) operators.add(String(o));
      for (const att of h.attachments || []) {
        const p = String(att?.path || '');
        if (!p || byPath.has(p)) continue;
        byPath.add(p);
        attachments.push(att);
      }
    }

    if (attachments.length === 0) return null;
    return {
      kind: 'sqlite',
      complete,
      availableProperties: [...properties],
      availableOperators: [...operators],
      attachments,
    };
  }
}

module.exports = {
  CompositeSupplementContext,
};
