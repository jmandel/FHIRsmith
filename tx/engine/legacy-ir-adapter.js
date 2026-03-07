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
  createGenericIRExecutor,
  dedupeCandidatesByCode,
  dedupeHierarchyByCode,
  executionResult,
  flattenHierarchyCandidates,
  hasHierarchyCandidates,
} = require('./generic-ir-executor');

/**
 * Wrap a CodeSystemProvider so it can participate in IR expansion.
 *
 * @param {CodeSystemProvider} provider - any upstream provider
 * @returns {{ executeIR, membershipForIR, countForIR, hasExecuteIR }}
 */
function wrapWithLegacyIR(provider) {
  const wrapper = {
    ...proxyProvider(provider),
    _discoveredUnclosed: [],
    _discoveredLimitedExpansion: false,
    _discoveredTooCostly: false,
    hasExecuteIR() { return true; },
  };

  const executor = createGenericIRExecutor({
    executeSelector: (node, opts) => executeSelector(provider, node, opts),
    applyTextFilterCandidates,
    onCountUnclosed: (unclosed) => {
      wrapper._discoveredUnclosed.push(unclosed);
    },
    onCountMetadata: (result) => {
      if (result?.limitedExpansion) wrapper._discoveredLimitedExpansion = true;
      if (result?.tooCostly) wrapper._discoveredTooCostly = true;
    },
  });

  wrapper.executeIR = executor.executeIR;
  wrapper.membershipForIR = executor.membershipForIR;
  wrapper.countForIR = executor.countForIR;
  return wrapper;
}

function applyTextFilterCandidates(candidates, text) {
  if (!text) return candidates;
  const lower = String(text).toLowerCase();
  const base = hasHierarchyCandidates(candidates)
    ? flattenHierarchyCandidates(candidates)
    : candidates;
  return base.filter(c =>
    (c.display || '').toLowerCase().includes(lower)
    || (c.code || '').toLowerCase().includes(lower)
  );
}

/**
 * Execute a single selector node against a legacy provider.
 */
async function executeSelector(provider, sel, opts) {
  const { activeOnly = false, allowIncompleteExpansion = false } = opts;
  const wantParent = typeof provider.hasParents === 'function' && provider.hasParents()
    && typeof provider.parent === 'function';

  if (sel.shape === 'concept') {
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
    return dedupeCandidatesByCode(results);
  }

  if (sel.shape === 'filter') {
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
    if (wantParent && typeof provider.iterator === 'function') {
      const tree = await iterateHierarchy(provider, null, activeOnly);
      return dedupeHierarchyByCode(tree);
    }

    const iter = await provider.iteratorAll();
    if (!iter) {
      const specUrl = typeof provider.specialEnumeration === 'function'
        ? provider.specialEnumeration() : null;
      if (specUrl && provider.commonUnits?.units?.length > 0) {
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
        return executionResult(results, {
          unclosed: `The code System "${provider.system()}" has a grammar`
            + ` and so has infinite members. This extension is based on ${specUrl}`,
        });
      }
      const tc = typeof provider.totalCount === 'function' ? provider.totalCount() : null;
      if (tc === -1) {
        if (allowIncompleteExpansion) {
          return executionResult([], {
            unclosed: `The code System "${provider.system()}" has a grammar, and cannot be enumerated directly`,
            limitedExpansion: true,
            tooCostly: true,
          });
        }
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
      const children = await iterateHierarchy(provider, ctx, activeOnly);
      results.push(...children);
    }
    ctx = await provider.nextContext(iter);
  }
  return results;
}

function proxyProvider(provider) {
  const proxy = {};
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
  proxy._wrapped = provider;
  return proxy;
}

module.exports = {
  wrapWithLegacyIR,
};
