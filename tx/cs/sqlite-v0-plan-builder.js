'use strict';

const Types = require('./sqlite-v0-plan-types');
const { fail, lowerFilterClauseToSetPlan, ok } = require('./sqlite-v0-clause-lowering');
const { buildSelectionPlan } = require('./sqlite-v0-selection-builder');

function originFromIrNode(node) {
  const nodeIds = [];
  if (node?.nodeId) nodeIds.push(String(node.nodeId));
  const paths = [];
  if (node?.meta?.path) paths.push(String(node.meta.path));
  return Types.normalizeOrigin({ nodeIds, paths });
}

function mergeScopes(left, right) {
  const a = Types.normalizeScope(left);
  const b = Types.normalizeScope(right);
  if (!a) return b;
  if (!b) return a;
  if (a.system && b.system && a.system !== b.system) return null;
  if ((a.version || null) !== (b.version || null)) return null;
  if (a.csId != null && b.csId != null && a.csId !== b.csId) return null;
  return {
    csId: a.csId != null ? a.csId : b.csId,
    system: a.system || b.system || '',
    version: a.version != null ? a.version : b.version,
  };
}

function inferScopeFromIr(node) {
  if (!node || typeof node !== 'object') return null;
  switch (node.kind) {
  case 'selector':
    return Types.normalizeScope({
      csId: null,
      system: node.system || '',
      version: node.version || null,
    });
  case 'import':
    return node.resolved ? inferScopeFromIr(node.resolved) : null;
  case 'union':
  case 'intersect': {
    let scope = null;
    for (const item of node.items || []) {
      scope = mergeScopes(scope, inferScopeFromIr(item));
    }
    return scope;
  }
  case 'diff':
    return mergeScopes(inferScopeFromIr(node.left), inferScopeFromIr(node.right));
  default:
    return null;
  }
}

function buildSelectorMembershipPlan(selector, propertyDefs, runtime, scopeOverride = null) {
  const meta = selector?.meta || null;
  const origin = originFromIrNode(selector);
  const scope = Types.normalizeScope(scopeOverride || inferScopeFromIr(selector));
  const shape = String(selector?.shape || '');

  if (shape === 'whole' || shape === 'all') {
    return ok(Types.allConcepts({ scope, origin, meta }));
  }

  if (shape === 'concept') {
    return ok(Types.explicitCodes({
      scope,
      codes: (selector.conceptCodes || []).map(cc => cc?.code),
      origin,
      meta,
    }));
  }

  if (shape === 'filter') {
    const clauses = selector.filterClauses || [];
    if (clauses.length === 0) return ok(Types.allConcepts({ scope, origin, meta }));
    const items = [];
    for (const clause of clauses) {
      const lowered = lowerFilterClauseToSetPlan(clause, propertyDefs, runtime, { scope });
      if (!lowered.ok) return lowered;
      items.push(lowered.plan);
    }
    if (Array.isArray(selector.intersectCodes) && selector.intersectCodes.length > 0) {
      items.push(Types.explicitCodes({
        scope,
        codes: selector.intersectCodes,
        origin,
        meta,
      }));
    }
    return ok(Types.setIntersect({ scope, items, origin, meta }));
  }

  return fail('unknown-selector-shape', { shape }, meta);
}

function buildMembershipPlan(expr, opts = {}) {
  const propertyDefs = opts.propertyDefs instanceof Map ? opts.propertyDefs : new Map();
  const runtime = opts.runtime || {};
  const rootScope = Types.normalizeScope(opts.scope || inferScopeFromIr(expr));

  function build(node, scope = rootScope) {
    if (!node) return ok(Types.emptySet({ scope }));
    const meta = node.meta || null;
    const origin = originFromIrNode(node);
    switch (node.kind) {
    case 'empty':
      return ok(Types.emptySet({ scope, origin, meta }));
    case 'selector':
      return buildSelectorMembershipPlan(node, propertyDefs, runtime, scope || inferScopeFromIr(node));
    case 'import':
      if (!node.resolved) {
        return fail('unresolved-import', { url: node.url || null, version: node.version || null }, meta);
      }
      return build(node.resolved, scope || inferScopeFromIr(node.resolved));
    case 'union': {
      const items = [];
      for (const child of node.items || []) {
        const lowered = build(child, scope || inferScopeFromIr(child));
        if (!lowered.ok) return lowered;
        items.push(lowered.plan);
      }
      return ok(Types.setUnion({ scope, items, origin, meta }));
    }
    case 'intersect': {
      const items = [];
      for (const child of node.items || []) {
        const lowered = build(child, scope || inferScopeFromIr(child));
        if (!lowered.ok) return lowered;
        items.push(lowered.plan);
      }
      return ok(Types.setIntersect({ scope, items, origin, meta }));
    }
    case 'diff': {
      const left = build(node.left, scope || inferScopeFromIr(node.left));
      if (!left.ok) return left;
      const right = build(node.right, scope || inferScopeFromIr(node.right));
      if (!right.ok) return right;
      return ok(Types.setDiff({ scope, left: left.plan, right: right.plan, origin, meta }));
    }
    default:
      return fail('unknown-ir-kind', { kind: node.kind || null }, meta);
    }
  }

  return build(expr, rootScope);
}

module.exports = {
  buildMembershipPlan,
  buildSelectionPlan,
  buildSelectorMembershipPlan,
};
