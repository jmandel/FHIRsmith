'use strict';

/**
 * Minimal expression IR for ValueSet membership.
 *
 * Nodes:
 * - empty
 * - selector: { system, version, shape, conceptCodes?, filterClauses?, valueSetImports? }
 * - import: { url, version, resolved?: Expr }   // resolved filled during import resolution
 * - union: { items: Expr[] }
 * - intersect: { items: Expr[] }
 * - diff: { left: Expr, right: Expr }
 *
 * The IR is *semantic*; execution strategies are separate.
 */

function empty() { return { kind: 'empty' }; }

function selector({
  system,
  version = null,
  shape,
  conceptCodes = null,
  filterClauses = null,
  intersectCodes = null,
  text = null,
  meta = null,
}) {
  return { kind: 'selector', system, version, shape, conceptCodes, filterClauses, intersectCodes, text, meta };
}

function importRef({ url, version = null, meta = null }) {
  return { kind: 'import', url, version, resolved: null, meta };
}

function union(items, meta = null) {
  const flat = [];
  for (const it of items || []) {
    if (!it) continue;
    if (it.kind === 'union') flat.push(...(it.items || []));
    else if (it.kind !== 'empty') flat.push(it);
  }
  if (flat.length === 0) return empty();
  if (flat.length === 1) return flat[0];
  return { kind: 'union', items: flat, meta };
}

function intersect(items, meta = null) {
  const flat = [];
  for (const it of items || []) {
    if (!it) continue;
    if (it.kind === 'intersect') flat.push(...(it.items || []));
    else if (it.kind !== 'empty') flat.push(it);
  }
  if (flat.length === 0) return empty();
  if (flat.length === 1) return flat[0];
  return { kind: 'intersect', items: flat, meta };
}

function diff(left, right, meta = null) {
  if (!left || left.kind === 'empty') return empty();
  if (!right || right.kind === 'empty') return left;
  return { kind: 'diff', left, right, meta };
}

function isExpr(x) {
  return x && typeof x === 'object' && typeof x.kind === 'string';
}

function cloneExpr(expr) {
  return JSON.parse(JSON.stringify(expr));
}

module.exports = {
  empty,
  selector,
  importRef,
  union,
  intersect,
  diff,
  isExpr,
  cloneExpr,
};
