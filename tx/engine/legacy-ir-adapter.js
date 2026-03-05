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
  const wrapper = {
    // Proxy all provider methods
    ...proxyProvider(provider),

    /** Unclosed messages discovered during countForIR (before executeIR runs). */
    _discoveredUnclosed: [],

    hasExecuteIR() { return true; },

    /**
     * Execute an IR subtree by tree-walking and calling legacy methods.
     * Returns { candidates: [{code, display, ...}] }.
     */
    async executeIR(subtree, opts = {}) {
      let candidates = await executeNode(provider, subtree, opts);
      candidates = dedupeCandidatesForResult(candidates);
      // Capture unclosed signal from grammar-based providers
      const unclosed = candidates._unclosed || null;
      // Apply text filter (legacy providers don't handle FTS natively)
      candidates = applyTextFilterCandidates(candidates, opts.text);
      // Sort for deterministic pagination (code order matches SQL behavior)
      candidates.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
      // Apply count/offset after materialization.
      // For hierarchical trees, apply paging to the flattened code order.
      if (opts.offset > 0 || opts.count != null) {
        const off = opts.offset || 0;
        if (hasHierarchyCandidates(candidates)) {
          const total = countWithChildren(candidates);
          const lim = opts.count != null ? opts.count : total;
          const fullWindow = off === 0 && lim >= total;
          if (!fullWindow) {
            const flat = flattenHierarchyCandidates(candidates);
            candidates = flat.slice(off, off + lim);
          }
        } else {
          const lim = opts.count != null ? opts.count : candidates.length;
          candidates = candidates.slice(off, off + lim);
        }
      }
      const result = { candidates };
      if (unclosed) result.unclosed = unclosed;
      return result;
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
      candidates = dedupeCandidatesForResult(candidates);
      // Stash unclosed signal discovered during counting (before executeIR runs)
      if (candidates._unclosed) {
        wrapper._discoveredUnclosed.push(candidates._unclosed);
      }
      candidates = applyTextFilterCandidates(candidates, opts.text);
      return countWithChildren(candidates);
    },
  };
  return wrapper;
}

/** Count candidates including any nested _children. */
function countWithChildren(candidates) {
  let n = candidates.length;
  for (const c of candidates) {
    if (c._children) n += countWithChildren(c._children);
  }
  return n;
}

function hasHierarchyCandidates(candidates) {
  return candidates.some(c => c._children && c._children.length > 0);
}

function dedupeCandidatesByCode(candidates) {
  const out = [];
  const seen = new Set();
  for (const c of candidates || []) {
    const code = c?.code;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(c);
  }
  return out;
}

function dedupeHierarchyByCode(nodes, seen = new Set()) {
  const out = [];
  for (const node of nodes || []) {
    const children = node?._children ? dedupeHierarchyByCode(node._children, seen) : [];
    const code = node?.code;
    if (!code || seen.has(code)) {
      // Keep unique descendants even if the parent code is a duplicate.
      out.push(...children);
      continue;
    }
    seen.add(code);
    const entry = { ...node };
    if (children.length > 0) entry._children = children;
    else delete entry._children;
    out.push(entry);
  }
  return out;
}

function dedupeCandidatesForResult(candidates) {
  const unclosed = candidates?._unclosed || null;
  const deduped = hasHierarchyCandidates(candidates)
    ? dedupeHierarchyByCode(candidates)
    : dedupeCandidatesByCode(candidates);
  if (unclosed) deduped._unclosed = unclosed;
  return deduped;
}

/**
 * Flatten a candidate tree to pre-order list, preserving parent links.
 * Used for pagination windows over hierarchical providers.
 */
function flattenHierarchyCandidates(candidates, parentCode = null, out = []) {
  for (const c of candidates) {
    const entry = { ...c };
    if (parentCode && !entry._parentCode) entry._parentCode = parentCode;
    delete entry._children;
    out.push(entry);
    if (c._children) flattenHierarchyCandidates(c._children, c.code, out);
  }
  return out;
}

function normalizeForSetOps(candidates) {
  const out = hasHierarchyCandidates(candidates)
    ? flattenHierarchyCandidates(candidates)
    : [...candidates];
  if (candidates._unclosed && !out._unclosed) out._unclosed = candidates._unclosed;
  return out;
}

function applyTextFilterCandidates(candidates, text) {
  if (!text) return candidates;
  const lower = String(text).toLowerCase();
  const base = hasHierarchyCandidates(candidates)
    ? flattenHierarchyCandidates(candidates)
    : candidates;
  const filtered = base.filter(c =>
    (c.display || '').toLowerCase().includes(lower)
    || (c.code || '').toLowerCase().includes(lower)
  );
  if (candidates._unclosed && !filtered._unclosed) filtered._unclosed = candidates._unclosed;
  return filtered;
}

/** Propagate _unclosed from child results onto a new array. */
function propagateUnclosed(target, ...sources) {
  for (const s of sources) {
    if (s._unclosed && !target._unclosed) {
      target._unclosed = s._unclosed;
    }
  }
  return target;
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
        const childResultRaw = await executeNode(provider, child, opts);
        const childResult = normalizeForSetOps(childResultRaw);
        propagateUnclosed(results, childResultRaw, childResult);
        for (const c of childResult) {
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
      const firstRaw = await executeNode(provider, children[0], opts);
      const first = normalizeForSetOps(firstRaw);
      const memberships = await Promise.all(children.slice(1).map(c => buildMembership(provider, c)));
      const result = first.filter(c =>
        memberships.every(m => m.has(c.code))
      );
      return propagateUnclosed(result, firstRaw, first);
    }

    case 'diff': {
      const leftRaw = await executeNode(provider, node.left, opts);
      const left = normalizeForSetOps(leftRaw);
      if (!node.right || node.right.kind === 'empty') return left;
      const rightMembership = await buildMembership(provider, node.right);
      const result = left.filter(c => !rightMembership.has(c.code));
      return propagateUnclosed(result, leftRaw, left);
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
  const wantParent = typeof provider.hasParents === 'function' && provider.hasParents()
    && typeof provider.parent === 'function';

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
      const entry = {
        code,
        display,
        active: !inactive,
        definition: await provider.definition(ctx),
        _context: ctx,
      };
      results.push(entry);
    }
    return dedupeCandidatesByCode(results);
  }

  if (sel.shape === 'filter') {
    // Filter protocol
    const intersectCodes = Array.isArray(sel.intersectCodes) && sel.intersectCodes.length > 0
      ? new Set(sel.intersectCodes.map(code => String(code)))
      : null;
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
      if (intersectCodes && !intersectCodes.has(String(code))) continue;
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
      const entry = {
        code,
        display,
        active: !inactive,
        definition: await provider.definition(ctx),
        _context: ctx,
      };
      if (wantParent) entry._parentCode = await provider.parent(ctx);
      results.push(entry);
    }
    return dedupeCandidatesByCode(results);
  }

  if (sel.shape === 'whole' || sel.shape === 'all') {
    // Hierarchical provider — walk the tree via iterator(null) → children
    if (wantParent && typeof provider.iterator === 'function') {
      const tree = await iterateHierarchy(provider, null, activeOnly);
      return dedupeHierarchyByCode(tree);
    }

    // Flat provider or no hierarchy — iterate all concepts
    const iter = await provider.iteratorAll();
    if (!iter) {
      // Grammar-based provider — cannot enumerate directly.
      // Check for specialEnumeration (e.g. UCUM common units).
      const specUrl = typeof provider.specialEnumeration === 'function'
        ? provider.specialEnumeration() : null;
      if (specUrl && provider.commonUnits?.units?.length > 0) {
        // Expand the common-units list and signal unclosed.
        const results = [];
        for (const cu of provider.commonUnits.units) {
          const ctx = await provider.locate(cu.code);
          if (!ctx?.context) continue;
          const inactive = await provider.isInactive(ctx.context);
          if (activeOnly && inactive) continue;
          results.push({
            code: cu.code,
            display: cu.display || cu.code,
            active: !inactive,
            definition: await provider.definition(ctx.context),
            _context: ctx.context,
          });
        }
        // Tag results so orchestrator can emit valueset-unclosed
        results._unclosed = `The code System "${provider.system()}" has a grammar`
          + ` and so has infinite members. This extension is based on ${specUrl}`;
        return results;
      }
      // No special enumeration — grammar-based, not enumerable
      const tc = typeof provider.totalCount === 'function' ? provider.totalCount() : null;
      if (tc === -1) {
        const err = new Error(
          `The code System "${provider.system()}" has a grammar, and cannot be enumerated directly`
        );
        err.isTooCostly = true;
        throw err;
      }
      return [];
    }

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
    return dedupeCandidatesByCode(results);
  }

  return [];
}

/**
 * Build a membership index for a node against a legacy provider.
 */
/**
 * Walk a hierarchical provider's tree via iterator(), producing candidates
 * with `_children` arrays that mirror the code system's structure.
 * Returns an array of root-level candidates; each may have nested `_children`.
 */
async function iterateHierarchy(provider, parentCtx, activeOnly) {
  const iter = await provider.iterator(parentCtx);
  if (!iter) return [];
  const results = [];
  let ctx = await provider.nextContext(iter);
  while (ctx) {
    const code = await provider.code(ctx);
    const inactive = await provider.isInactive(ctx);
    if (!activeOnly || !inactive) {
      const display = await provider.display(ctx);
      const entry = {
        code,
        display,
        active: !inactive,
        definition: await provider.definition(ctx),
        _context: ctx,
      };
      const children = await iterateHierarchy(provider, ctx, activeOnly);
      if (children.length > 0) entry._children = children;
      results.push(entry);
    } else {
      // Skip inactive parent, reparent active descendants
      const children = await iterateHierarchy(provider, ctx, activeOnly);
      results.push(...children);
    }
    ctx = await provider.nextContext(iter);
  }
  return results;
}

async function buildMembership(provider, node) {
  if (!node) return new EmptyMembership();

  switch (node.kind) {
    case 'empty':
      return new EmptyMembership();

    case 'selector': {
      // Materialize and build a Set
      const candidatesRaw = await executeSelector(provider, node, {});
      const candidates = normalizeForSetOps(candidatesRaw);
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
    'contentMode', 'isNotClosed', 'hasParents', 'parent',
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
