'use strict';

/**
 * Interpret a resolved, scoped semantic IR tree over an abstract member domain.
 *
 * The interpreter owns only the set algebra semantics of IR composition.
 * Leaf selector semantics are supplied by the caller via evaluateSelector().
 *
 * This is intentionally provider-agnostic and is used as a semantic oracle in
 * unit/fuzz tests before any provider-private lowering occurs.
 */

function setUnion(a, b) {
  const out = new Set(a);
  for (const value of b) out.add(value);
  return out;
}

function setIntersect(a, b) {
  const out = new Set();
  for (const value of a) {
    if (b.has(value)) out.add(value);
  }
  return out;
}

function setDiff(a, b) {
  const out = new Set();
  for (const value of a) {
    if (!b.has(value)) out.add(value);
  }
  return out;
}

function toMemberSet(value, label) {
  if (value == null) return new Set();
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value);
  if (typeof value === 'string') {
    throw new Error(`${label} must return a Set/Array/iterable, not a string`);
  }
  if (typeof value?.[Symbol.iterator] === 'function') return new Set(value);
  throw new Error(`${label} must return a Set/Array/iterable`);
}

/**
 * @param {object} expr
 * @param {object} opts
 * @param {(selector: object, opts?: object) => Set<any>|Array<any>|Iterable<any>} opts.evaluateSelector
 * @param {(importNode: object, opts?: object) => Set<any>|Array<any>|Iterable<any>} [opts.evaluateImport]
 * @returns {Set<any>}
 */
function interpretScopedIR(expr, opts = {}) {
  const evaluateSelector = opts.evaluateSelector;
  if (typeof evaluateSelector !== 'function') {
    throw new Error('interpretScopedIR requires opts.evaluateSelector(selector)');
  }

  function evalNode(node) {
    if (!node) return new Set();
    switch (node.kind) {
    case 'empty':
      return new Set();
    case 'selector':
      return toMemberSet(evaluateSelector(node, opts), 'evaluateSelector');
    case 'import':
      if (node.resolved) return evalNode(node.resolved);
      if (typeof opts.evaluateImport === 'function') {
        return toMemberSet(opts.evaluateImport(node, opts), 'evaluateImport');
      }
      throw new Error(`interpretScopedIR cannot evaluate unresolved import ${node.url || '(unknown url)'}`);
    case 'union':
      return (node.items || []).reduce((acc, item) => setUnion(acc, evalNode(item)), new Set());
    case 'intersect': {
      const items = node.items || [];
      if (items.length === 0) return new Set();
      let out = evalNode(items[0]);
      for (const item of items.slice(1)) {
        out = setIntersect(out, evalNode(item));
        if (out.size === 0) break;
      }
      return out;
    }
    case 'diff':
      return setDiff(evalNode(node.left), evalNode(node.right));
    default:
      throw new Error(`interpretScopedIR does not recognize node kind ${String(node.kind || '(missing)')}`);
    }
  }

  return evalNode(expr);
}

module.exports = {
  interpretScopedIR,
  setUnion,
  setIntersect,
  setDiff,
};
