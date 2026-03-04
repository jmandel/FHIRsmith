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
 * - maxDepth (default 50): maximum import-chain depth (legacy option name)
 * - maxNodes (default 200000): maximum IR nodes visited during resolution
 * - cache (Map) shared between calls
 * - preferComposeOverExpansion (default true): when both are present, compile compose IR
 *   so imported content can still participate in provider pushdown.
 */
async function resolveImports(expr, resolveValueSet, opts = {}) {
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 50;
  const maxNodes = Number.isInteger(opts.maxNodes) ? opts.maxNodes : 200000;
  const cache = opts.cache instanceof Map ? opts.cache : new Map();
  const preferComposeOverExpansion = opts.preferComposeOverExpansion !== false;
  const usedValueSets = new Set(); // Tracks resolved import URLs for metadata
  let visitedNodes = 0;

  async function resolveNode(node, importDepth, stack = []) {
    if (!node || typeof node !== 'object') return node;
    visitedNodes += 1;
    if (visitedNodes > maxNodes) {
      throw new Error(`Import resolution exceeded maxNodes=${maxNodes}`);
    }
    if (importDepth > maxDepth) {
      throw new Error(`Import resolution exceeded maxDepth=${maxDepth} at ${node?.meta?.path || '?'}`);
    }

    switch (node.kind) {
    case 'empty':
      return node;

    case 'selector':
      return node;

    case 'union':
      return { ...node, items: await Promise.all((node.items || []).map(n => resolveNode(n, importDepth, stack))) };

    case 'intersect':
      return { ...node, items: await Promise.all((node.items || []).map(n => resolveNode(n, importDepth, stack))) };

    case 'diff':
      return { ...node, left: await resolveNode(node.left, importDepth, stack), right: await resolveNode(node.right, importDepth, stack) };

    case 'import':
      return await resolveImport(node, importDepth + 1, stack);

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

  async function resolveImport(node, depth, stack) {
    if (node.resolved) return node;

    const parsed = parseRef(node.url);
    const url = parsed.url;
    const version = node.version || parsed.version || null;
    const key = version ? `${url}|${version}` : url;

    if (cache.has(key)) {
      return { ...node, resolved: cache.get(key) };
    }

    if (stack.includes(key)) {
      const cycle = [...stack, key].join(' -> ');
      throw new Error(`ValueSet import cycle detected: ${cycle}`);
    }

    const vs = await resolveValueSet(url, version);
    if (!vs) {
      throw new Error(`Imported ValueSet not found: ${key}`);
    }

    const vsJson = vs.jsonObj || vs;
    // Track the resolved URL (with version if available) for used-valueset metadata
    const resolvedVersion = vsJson.version || version;
    usedValueSets.add(resolvedVersion ? `${url}|${resolvedVersion}` : url);
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

    importedExpr = await resolveNode(importedExpr, depth + 1, [...stack, key]);
    cache.set(key, importedExpr);
    return { ...node, resolved: importedExpr };
  }

  const resolved = await resolveNode(expr, 0, []);
  resolved._usedValueSets = usedValueSets;
  return resolved;
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
