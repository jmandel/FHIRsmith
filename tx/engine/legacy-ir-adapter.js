'use strict';

/**
 * LegacyIRAdapter — wraps any CodeSystemProvider to implement executeIR().
 *
 * Tree-walks the IR at runtime, calling the provider's existing methods
 * (locate, filter protocol, iteratorAll) at each leaf selector node.
 * Internal nodes (union, intersect, diff) are composed in JS using
 * the membership index types from membership.js.
 *
 * This gives every upstream provider automatic IR support without
 * modifying the provider. The v0 SQLite provider has native executeIR()
 * which bypasses this adapter entirely.
 */

const {
  EmptyMembership,
  SetMembership,
  UnionMembership,
  IntersectMembership,
  DiffMembership,
} = require('./membership');

/**
 * Wrap a CodeSystemProvider so it can participate in IR expansion.
 *
 * @param {CodeSystemProvider} provider - any upstream provider
 * @returns {{ executeIR, membershipForIR, countForIR, hasExecuteIR }}
 */
function wrapWithLegacyIR(provider) {
  return {
    // Proxy all provider methods
    ...proxyProvider(provider),

    hasExecuteIR() { return true; },

    /**
     * Execute an IR subtree by tree-walking and calling legacy methods.
     * Returns { candidates: [{code, display, ...}] }.
     */
    async executeIR(subtree, opts = {}) {
      let candidates = await executeNode(provider, subtree, opts);
      // Apply text filter (legacy providers don't handle FTS natively)
      if (opts.text) {
        const lower = opts.text.toLowerCase();
        candidates = candidates.filter(c =>
          (c.display || '').toLowerCase().includes(lower)
          || (c.code || '').toLowerCase().includes(lower)
        );
      }
      // Sort for deterministic pagination (code order matches SQL behavior)
      candidates.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
      // Apply count/offset after materialization
      if (opts.offset > 0 || opts.count != null) {
        const off = opts.offset || 0;
        const lim = opts.count != null ? opts.count : candidates.length;
        candidates = candidates.slice(off, off + lim);
      }
      return { candidates };
    },

    /**
     * Build a membership checker by tree-walking.
     */
    async membershipForIR(subtree) {
      return await buildMembership(provider, subtree);
    },

    /**
     * Count by materializing.
     */
    async countForIR(subtree, opts = {}) {
      let candidates = await executeNode(provider, subtree, opts);
      if (opts.text) {
        const lower = opts.text.toLowerCase();
        candidates = candidates.filter(c =>
          (c.display || '').toLowerCase().includes(lower)
          || (c.code || '').toLowerCase().includes(lower)
        );
      }
      return candidates.length;
    },
  };
}

/**
 * Recursively execute an IR node against a legacy provider.
 * Returns an array of candidate objects.
 */
async function executeNode(provider, node, opts) {
  if (!node) return [];

  switch (node.kind) {
    case 'empty':
      return [];

    case 'selector':
      return await executeSelector(provider, node, opts);

    case 'union': {
      const results = [];
      const seen = new Set();
      for (const child of node.items || []) {
        for (const c of await executeNode(provider, child, opts)) {
          if (!seen.has(c.code)) {
            seen.add(c.code);
            results.push(c);
          }
        }
      }
      return results;
    }

    case 'intersect': {
      const children = (node.items || []).filter(it => it && it.kind !== 'empty');
      if (children.length === 0) return [];
      if (children.length === 1) return await executeNode(provider, children[0], opts);

      // Enumerate first child, check membership against rest
      const first = await executeNode(provider, children[0], opts);
      const memberships = await Promise.all(children.slice(1).map(c => buildMembership(provider, c)));
      return first.filter(c =>
        memberships.every(m => m.has(c.code))
      );
    }

    case 'diff': {
      const left = await executeNode(provider, node.left, opts);
      if (!node.right || node.right.kind === 'empty') return left;
      const rightMembership = await buildMembership(provider, node.right);
      return left.filter(c => !rightMembership.has(c.code));
    }

    case 'import':
      if (node.resolved) return await executeNode(provider, node.resolved, opts);
      return [];

    default:
      return [];
  }
}

/**
 * Execute a single selector node against a legacy provider.
 */
async function executeSelector(provider, sel, opts) {
  const { activeOnly = false } = opts;

  if (sel.shape === 'concept') {
    // Enumerated concept codes
    const results = [];
    for (const cc of sel.conceptCodes || []) {
      const located = await provider.locate(cc.code);
      if (!located?.context) continue;
      const ctx = located.context;
      const code = await provider.code(ctx);
      const display = await provider.display(ctx);
      const inactive = await provider.isInactive(ctx);
      if (activeOnly && inactive) continue;
      results.push({
        code,
        display,
        active: !inactive,
        definition: await provider.definition(ctx),
        _context: ctx,
      });
    }
    return results;
  }

  if (sel.shape === 'filter') {
    // Filter protocol
    const prep = await provider.getPrepContext(true);
    for (const clause of sel.filterClauses || []) {
      await provider.filter(prep, clause.property, clause.op, clause.value);
    }
    const sets = await provider.executeFilters(prep);
    if (!sets || sets.length === 0) return [];

    const results = [];
    while (await provider.filterMore(prep, sets[0])) {
      const ctx = await provider.filterConcept(prep, sets[0]);
      const code = await provider.code(ctx);
      const inactive = await provider.isInactive(ctx);
      if (activeOnly && inactive) continue;

      // Cross-check against additional filter sets
      if (sets.length > 1) {
        let passes = true;
        for (let i = 1; i < sets.length; i++) {
          const check = await provider.filterCheck(prep, sets[i], ctx);
          if (check !== true) { passes = false; break; }
        }
        if (!passes) continue;
      }

      const display = await provider.display(ctx);
      results.push({
        code,
        display,
        active: !inactive,
        definition: await provider.definition(ctx),
        _context: ctx,
      });
    }
    return results;
  }

  if (sel.shape === 'whole' || sel.shape === 'all') {
    // Iterate all concepts
    const iter = await provider.iteratorAll();
    if (!iter) return [];

    const results = [];
    let ctx = await provider.nextContext(iter);
    while (ctx) {
      const code = await provider.code(ctx);
      const inactive = await provider.isInactive(ctx);
      if (!activeOnly || !inactive) {
        const display = await provider.display(ctx);
        results.push({
          code,
          display,
          active: !inactive,
          definition: await provider.definition(ctx),
          _context: ctx,
        });
      }
      ctx = await provider.nextContext(iter);
    }
    return results;
  }

  return [];
}

/**
 * Build a membership index for a node against a legacy provider.
 */
async function buildMembership(provider, node) {
  if (!node) return new EmptyMembership();

  switch (node.kind) {
    case 'empty':
      return new EmptyMembership();

    case 'selector': {
      // Materialize and build a Set
      const candidates = await executeSelector(provider, node, {});
      return new SetMembership(new Set(candidates.map(c => c.code)));
    }

    case 'union':
      return new UnionMembership(
        await Promise.all((node.items || []).map(c => buildMembership(provider, c)))
      );

    case 'intersect':
      return new IntersectMembership(
        await Promise.all((node.items || []).map(c => buildMembership(provider, c)))
      );

    case 'diff':
      return new DiffMembership(
        await buildMembership(provider, node.left),
        await buildMembership(provider, node.right)
      );

    case 'import':
      if (node.resolved) return await buildMembership(provider, node.resolved);
      return new EmptyMembership();

    default:
      return new EmptyMembership();
  }
}

/**
 * Create a proxy that delegates all property access to the underlying provider.
 * This ensures the adapter can be used as a drop-in replacement.
 */
function proxyProvider(provider) {
  const proxy = {};
  // Copy over commonly-needed methods
  for (const method of [
    'system', 'version', 'name', 'description', 'totalCount',
    'contentMode', 'isNotClosed', 'hasParents',
    'locate', 'code', 'display', 'definition',
    'isAbstract', 'isInactive', 'isDeprecated', 'getStatus',
    'designations', 'properties', 'extensions',
    'close',
  ]) {
    if (typeof provider[method] === 'function') {
      proxy[method] = provider[method].bind(provider);
    }
  }
  // Keep the original provider accessible
  proxy._wrapped = provider;
  return proxy;
}

module.exports = {
  wrapWithLegacyIR,
};
