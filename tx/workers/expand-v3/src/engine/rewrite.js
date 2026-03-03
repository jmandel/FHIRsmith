'use strict';

const IR = require('./ir');

function flatten(expr) {
  if (!expr || typeof expr !== 'object') return expr;
  switch (expr.kind) {
  case 'empty':
  case 'selector':
    return expr;
  case 'import':
    return expr.resolved ? { ...expr, resolved: flatten(expr.resolved) } : expr;
  case 'union':
    return IR.union((expr.items || []).map(flatten), expr.meta);
  case 'intersect':
    return IR.intersect((expr.items || []).map(flatten), expr.meta);
  case 'diff':
    return IR.diff(flatten(expr.left), flatten(expr.right), expr.meta);
  default:
    return expr;
  }
}

function optimize(expr) {
  return simplify(flatten(expr));
}

function simplify(expr) {
  if (!expr || typeof expr !== 'object') return expr;
  switch (expr.kind) {
  case 'empty':
  case 'selector':
    return expr;
  case 'import':
    // Once imports are resolved, inline them into the working expression tree.
    // This enables downstream union coalescing across former import boundaries
    // (e.g., deep mixed include graphs collapsing to one selector per system).
    return expr.resolved ? simplify(expr.resolved) : expr;
  case 'union': {
    const items = (expr.items || []).map(simplify).filter(it => it && it.kind !== 'empty');
    return coalesceUnionItems(items, expr.meta);
  }
  case 'intersect':
    return IR.intersect((expr.items || []).map(simplify), expr.meta);
  case 'diff':
    return IR.diff(simplify(expr.left), simplify(expr.right), expr.meta);
  default:
    return expr;
  }
}

function coalesceUnionItems(items, meta) {
  const out = [];
  const conceptByKey = new Map();
  const wholeByKey = new Set();
  const filterBySig = new Set();

  for (const item of items || []) {
    if (!item) continue;
    if (item.kind !== 'selector') {
      out.push(item);
      continue;
    }

    const shape = String(item.shape || '');
    if (shape === 'concept') {
      const ckey = selectorKey(item, 'concept');
      const wkey = selectorKey(item, 'whole');
      if (wholeByKey.has(wkey)) continue;
      const idx = conceptByKey.get(ckey);
      if (idx != null) {
        out[idx] = mergeConceptSelectors(out[idx], item);
      } else {
        conceptByKey.set(ckey, out.length);
        out.push(item);
      }
      continue;
    }

    if (shape === 'whole' || shape === 'all') {
      const wkey = selectorKey(item, 'whole');
      if (wholeByKey.has(wkey)) continue;

      const ckey = selectorKey(item, 'concept');
      const idx = conceptByKey.get(ckey);
      if (idx != null) {
        out[idx] = null;
        conceptByKey.delete(ckey);
      }

      wholeByKey.add(wkey);
      out.push(shape === 'whole' ? item : { ...item, shape: 'whole' });
      continue;
    }

    if (shape === 'filter') {
      const sig = filterSignature(item);
      if (filterBySig.has(sig)) continue;
      filterBySig.add(sig);
      out.push(item);
      continue;
    }

    out.push(item);
  }

  return IR.union(out.filter(Boolean), meta);
}

function mergeConceptSelectors(a, b) {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set();
  const merged = [];
  for (const c of a.conceptCodes || []) {
    const code = String(c?.code || '');
    if (!code || seen.has(code)) continue;
    seen.add(code);
    merged.push(c);
  }
  for (const c of b.conceptCodes || []) {
    const code = String(c?.code || '');
    if (!code || seen.has(code)) continue;
    seen.add(code);
    merged.push(c);
  }
  return {
    ...a,
    conceptCodes: merged,
  };
}

function selectorKey(sel, shapeOverride = null) {
  return JSON.stringify([
    String(sel?.system || ''),
    sel?.version || null,
    String(shapeOverride || sel?.shape || ''),
    normalizeText(sel?.text),
  ]);
}

function normalizeText(text) {
  const t = text == null ? '' : String(text).trim();
  return t.length > 0 ? t : null;
}

function filterSignature(sel) {
  const clauses = (sel?.filterClauses || []).map(c => ({
    property: c?.property ?? null,
    op: c?.op ?? null,
    value: c?.value ?? null,
  }));
  return JSON.stringify([
    String(sel?.system || ''),
    sel?.version || null,
    normalizeText(sel?.text),
    clauses,
  ]);
}

function collectSystems(expr, out = new Map()) {
  if (!expr) return out;
  switch (expr.kind) {
  case 'selector': {
    const k = `${expr.system}|${expr.version || ''}`;
    if (!out.has(k)) out.set(k, { system: expr.system, version: expr.version || null });
    break;
  }
  case 'import':
    if (expr.resolved) collectSystems(expr.resolved, out);
    break;
  case 'union':
  case 'intersect':
    for (const it of expr.items || []) collectSystems(it, out);
    break;
  case 'diff':
    collectSystems(expr.left, out);
    collectSystems(expr.right, out);
    break;
  default:
    break;
  }
  return out;
}

function projectToSystem(expr, system, version = null) {
  if (!expr) return IR.empty();
  switch (expr.kind) {
  case 'empty':
    return expr;
  case 'selector': {
    if (String(expr.system) !== String(system)) return IR.empty();
    if (version != null && (expr.version || null) !== version) {
      // Version-specific projection (optional)
      return IR.empty();
    }
    return expr;
  }
  case 'import':
    if (expr.resolved) return projectToSystem(expr.resolved, system, version);
    // unresolved import: keep it, projection will happen after resolution
    return { ...expr };
  case 'union':
    return IR.union((expr.items || []).map(it => projectToSystem(it, system, version)), expr.meta);
  case 'intersect':
    return IR.intersect((expr.items || []).map(it => projectToSystem(it, system, version)), expr.meta);
  case 'diff':
    return IR.diff(projectToSystem(expr.left, system, version), projectToSystem(expr.right, system, version), expr.meta);
  default:
    return IR.empty();
  }
}

function splitDiffRoot(expr) {
  if (expr && expr.kind === 'diff') return { include: expr.left, exclude: expr.right };
  return { include: expr || IR.empty(), exclude: IR.empty() };
}

function flattenUnionToList(expr) {
  const out = [];
  function walk(e) {
    if (!e || e.kind === 'empty') return;
    if (e.kind === 'union') {
      for (const it of e.items || []) walk(it);
    } else {
      out.push(e);
    }
  }
  walk(expr);
  return out;
}

module.exports = {
  flatten,
  optimize,
  collectSystems,
  projectToSystem,
  splitDiffRoot,
  flattenUnionToList,
};
