'use strict';

const {
  EmptyMembership,
  SetMembership,
  UnionMembership,
  IntersectMembership,
  DiffMembership,
} = require('./membership');

function countWithChildren(candidates) {
  let n = candidates.length;
  for (const c of candidates || []) {
    if (c._children) n += countWithChildren(c._children);
  }
  return n;
}

function hasHierarchyCandidates(candidates) {
  return (candidates || []).some(c => c._children && c._children.length > 0);
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
  const limitedExpansion = !!candidates?._limitedExpansion;
  const tooCostly = !!candidates?._tooCostly;
  const deduped = hasHierarchyCandidates(candidates)
    ? dedupeHierarchyByCode(candidates)
    : dedupeCandidatesByCode(candidates);
  if (unclosed) deduped._unclosed = unclosed;
  if (limitedExpansion) deduped._limitedExpansion = true;
  if (tooCostly) deduped._tooCostly = true;
  return deduped;
}

function flattenHierarchyCandidates(candidates, parentCode = null, out = []) {
  for (const c of candidates || []) {
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
    : [...(candidates || [])];
  if (candidates?._unclosed && !out._unclosed) out._unclosed = candidates._unclosed;
  if (candidates?._limitedExpansion && !out._limitedExpansion) out._limitedExpansion = true;
  if (candidates?._tooCostly && !out._tooCostly) out._tooCostly = true;
  return out;
}

function propagateUnclosed(target, ...sources) {
  for (const s of sources) {
    if (s?._unclosed && !target._unclosed) {
      target._unclosed = s._unclosed;
    }
    if (s?._limitedExpansion && !target._limitedExpansion) {
      target._limitedExpansion = true;
    }
    if (s?._tooCostly && !target._tooCostly) {
      target._tooCostly = true;
    }
  }
  return target;
}

function createGenericIRExecutor({
  executeSelector,
  buildSelectorMembership = null,
  applyTextFilterCandidates = candidates => candidates,
  createState = () => ({}),
  onCountUnclosed = null,
  onCountMetadata = null,
}) {
  if (typeof executeSelector !== 'function') {
    throw new Error('createGenericIRExecutor requires executeSelector');
  }

  async function executeNode(node, opts, state) {
    if (!node) return [];

    switch (node.kind) {
      case 'empty':
        return [];

      case 'selector':
        return await executeSelector(node, opts, state);

      case 'union': {
        const results = [];
        const seen = new Set();
        for (const child of node.items || []) {
          const childResultRaw = await executeNode(child, opts, state);
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
        const items = (node.items || []).filter(Boolean);
        if (items.length === 0) return [];
        if (items.some(it => it.kind === 'empty')) return [];
        if (items.length === 1) return await executeNode(items[0], opts, state);

        const firstRaw = await executeNode(items[0], opts, state);
        const first = normalizeForSetOps(firstRaw);
        const memberships = await Promise.all(
          items.slice(1).map(child => buildMembership(child, state))
        );
        const result = first.filter(c => memberships.every(m => m.has(c.code)));
        return propagateUnclosed(result, firstRaw, first);
      }

      case 'diff': {
        const leftRaw = await executeNode(node.left, opts, state);
        const left = normalizeForSetOps(leftRaw);
        if (!node.right || node.right.kind === 'empty') return left;
        const rightMembership = await buildMembership(node.right, state);
        const result = left.filter(c => !rightMembership.has(c.code));
        return propagateUnclosed(result, leftRaw, left);
      }

      case 'import':
        if (node.resolved) return await executeNode(node.resolved, opts, state);
        return [];

      default:
        return [];
    }
  }

  async function defaultBuildSelectorMembership(node, state) {
    const candidatesRaw = await executeSelector(node, {}, state);
    const candidates = normalizeForSetOps(candidatesRaw);
    return new SetMembership(new Set(candidates.map(c => c.code)));
  }

  async function buildMembership(node, state) {
    if (!node) return new EmptyMembership();

    switch (node.kind) {
      case 'empty':
        return new EmptyMembership();

      case 'selector':
        if (buildSelectorMembership) return await buildSelectorMembership(node, state, defaultBuildSelectorMembership);
        return await defaultBuildSelectorMembership(node, state);

      case 'union':
        return new UnionMembership(
          await Promise.all((node.items || []).map(child => buildMembership(child, state)))
        );

      case 'intersect':
        return new IntersectMembership(
          await Promise.all((node.items || []).map(child => buildMembership(child, state)))
        );

      case 'diff':
        return new DiffMembership(
          await buildMembership(node.left, state),
          await buildMembership(node.right, state)
        );

      case 'import':
        if (node.resolved) return await buildMembership(node.resolved, state);
        return new EmptyMembership();

      default:
        return new EmptyMembership();
    }
  }

  return {
    async executeIR(subtree, opts = {}) {
      const state = createState();
      let candidates = await executeNode(subtree, opts, state);
      candidates = dedupeCandidatesForResult(candidates);
      const unclosed = candidates._unclosed || null;
      candidates = applyTextFilterCandidates(candidates, opts.text, state);
      candidates.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
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
      if (candidates._limitedExpansion) result.limitedExpansion = true;
      if (candidates._tooCostly) result.tooCostly = true;
      return result;
    },

    async countForIR(subtree, opts = {}) {
      const state = createState();
      let candidates = await executeNode(subtree, opts, state);
      candidates = dedupeCandidatesForResult(candidates);
      if (typeof onCountUnclosed === 'function' && candidates._unclosed) {
        onCountUnclosed(candidates._unclosed);
      }
      if (typeof onCountMetadata === 'function') {
        onCountMetadata(candidates);
      }
      candidates = applyTextFilterCandidates(candidates, opts.text, state);
      return countWithChildren(candidates);
    },

    async membershipForIR(subtree) {
      const state = createState();
      return await buildMembership(subtree, state);
    },
  };
}

module.exports = {
  countWithChildren,
  createGenericIRExecutor,
  dedupeCandidatesByCode,
  dedupeCandidatesForResult,
  dedupeHierarchyByCode,
  flattenHierarchyCandidates,
  hasHierarchyCandidates,
  normalizeForSetOps,
  propagateUnclosed,
};
