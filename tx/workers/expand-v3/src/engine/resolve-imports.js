'use strict';

const IR = require('./ir');
const { buildIRFromValueSet } = require('./build-ir');

/**
 * Resolve ImportRef nodes into concrete expression subtrees.
 *
 * You must provide a resolver with signature:
 *   async function resolveValueSet(url, version) -> vsJson (plain JSON or wrapper with jsonObj)
 *
 * Options:
 * - maxDepth (default 20)
 * - cache (Map) shared between calls
 * - preferComposeOverExpansion (default true): when both are present, compile compose IR
 *   so imported content can still participate in provider pushdown.
 */
async function resolveImports(expr, resolveValueSet, opts = {}) {
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 20;
  const cache = opts.cache instanceof Map ? opts.cache : new Map();
  const preferComposeOverExpansion = opts.preferComposeOverExpansion !== false;

  const stack = [];

  async function resolveNode(node, depth) {
    if (!node || typeof node !== 'object') return node;
    if (depth > maxDepth) {
      throw new Error(`Import resolution exceeded maxDepth=${maxDepth} at ${node?.meta?.path || '?'}`);
    }

    switch (node.kind) {
    case 'empty':
      return node;

    case 'selector':
      return node;

    case 'union':
      return { ...node, items: await Promise.all((node.items || []).map(n => resolveNode(n, depth + 1))) };

    case 'intersect':
      return { ...node, items: await Promise.all((node.items || []).map(n => resolveNode(n, depth + 1))) };

    case 'diff':
      return { ...node, left: await resolveNode(node.left, depth + 1), right: await resolveNode(node.right, depth + 1) };

    case 'import':
      return await resolveImport(node, depth + 1);

    default:
      return node;
    }
  }

  function parseRef(url) {
    const raw = String(url || '');
    if (!raw.includes('|')) return { url: raw, version: null };
    const [u, v] = raw.split('|');
    return { url: u, version: v || null };
  }

  async function resolveImport(node, depth) {
    if (node.resolved) return node;

    const parsed = parseRef(node.url);
    const url = parsed.url;
    const version = node.version || parsed.version || null;
    const key = version ? `${url}|${version}` : url;

    if (stack.includes(key)) {
      const cycle = [...stack, key].join(' -> ');
      throw new Error(`ValueSet import cycle detected: ${cycle}`);
    }

    if (cache.has(key)) {
      return { ...node, resolved: cache.get(key) };
    }

    stack.push(key);
    try {
      const vs = await resolveValueSet(url, version);
      if (!vs) {
        throw new Error(`Imported ValueSet not found: ${key}`);
      }

      const vsJson = vs.jsonObj || vs;
      let importedExpr;

      // Prefer compose-based IR when available. This preserves set semantics and enables
      // provider pushdown on imported content. Fall back to pre-expanded membership only
      // when compose is absent or explicitly not preferred.
      if (preferComposeOverExpansion && vsJson?.compose) {
        importedExpr = buildIRFromValueSet(vsJson);
      } else if (vsJson.expansion?.contains) {
        importedExpr = buildIRFromExpansion(vsJson);
      } else {
        importedExpr = buildIRFromValueSet(vsJson);
      }

      importedExpr = await resolveNode(importedExpr, depth + 1);
      cache.set(key, importedExpr);
      return { ...node, resolved: importedExpr };
    } finally {
      stack.pop();
    }
  }

  return resolveNode(expr, 0);
}

/**
 * Convert a pre-expanded ValueSet.expansion.contains tree into a Union of concept selectors,
 * grouped by system+version.
 *
 * This preserves membership without requiring re-running expansion.
 */
function buildIRFromExpansion(vsJson) {
  const rows = [];
  function walk(list) {
    for (const c of list || []) {
      if (c && c.system && c.code) {
        rows.push({ system: String(c.system), version: c.version ? String(c.version) : null, code: String(c.code), display: c.display != null ? String(c.display) : null, inactive: !!c.inactive });
      }
      if (c?.contains?.length) walk(c.contains);
    }
  }
  walk(vsJson.expansion?.contains || []);

  const bySys = new Map(); // key -> [{code,display}]
  for (const r of rows) {
    const k = `${r.system}|${r.version || ''}`;
    if (!bySys.has(k)) bySys.set(k, { system: r.system, version: r.version, codes: [] });
    bySys.get(k).codes.push({ code: r.code, display: r.display, inactive: r.inactive });
  }

  const selectors = [];
  for (const g of bySys.values()) {
    selectors.push(IR.selector({
      system: g.system,
      version: g.version,
      shape: 'concept',
      conceptCodes: g.codes.map((c) => ({ code: c.code, display: c.display, inactive: c.inactive, meta: { path: 'ValueSet.expansion.contains' } })),
      meta: { path: 'ValueSet.expansion.contains.group' },
    }));
  }

  return IR.union(selectors, { path: 'ValueSet.expansion.contains.union' });
}

module.exports = {
  resolveImports,
  buildIRFromExpansion,
};
