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
  collectSystems,
  projectToSystem,
  splitDiffRoot,
  flattenUnionToList,
};
