'use strict';

const {
  EmptyMembership,
  SetMembership,
  UnionMembership,
  IntersectMembership,
  DiffMembership,
} = require('./membership');

function candidateListOf(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.candidates)) return value.candidates;
  return [];
}

function normalizeValueSetMeta(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const vurl = String(item?.vurl || '').trim();
    if (!vurl || seen.has(vurl)) continue;
    seen.add(vurl);
    out.push({
      vurl,
      status: String(item?.status || '').trim(),
      standardsStatus: String(item?.standardsStatus || '').trim(),
      experimental: !!item?.experimental,
    });
  }
  return out;
}

function executionResult(candidates = [], meta = {}) {
  return {
    candidates: Array.isArray(candidates) ? candidates : [],
    unclosed: meta?.unclosed || null,
    limitedExpansion: !!meta?.limitedExpansion,
    tooCostly: !!meta?.tooCostly,
    valueSetMeta: normalizeValueSetMeta(meta?.valueSetMeta),
  };
}

function toExecutionResult(value) {
  if (!value) return executionResult([]);
  if (Array.isArray(value)) {
    return executionResult(value, {
      unclosed: value._unclosed || null,
      limitedExpansion: !!value._limitedExpansion,
      tooCostly: !!value._tooCostly,
      valueSetMeta: value._valueSetMeta || [],
    });
  }
  if (Array.isArray(value.candidates)) {
    return executionResult(value.candidates, {
      unclosed: value.unclosed || null,
      limitedExpansion: !!value.limitedExpansion,
      tooCostly: !!value.tooCostly,
      valueSetMeta: value.valueSetMeta || [],
    });
  }
  return executionResult([]);
}

function mergeExecutionMetadata(target, ...sources) {
  const out = toExecutionResult(target);
  for (const source of sources) {
    const meta = toExecutionResult(source);
    if (meta.unclosed && !out.unclosed) out.unclosed = meta.unclosed;
    if (meta.limitedExpansion && !out.limitedExpansion) out.limitedExpansion = true;
    if (meta.tooCostly && !out.tooCostly) out.tooCostly = true;
    if (meta.valueSetMeta?.length > 0) {
      out.valueSetMeta = normalizeValueSetMeta([...(out.valueSetMeta || []), ...meta.valueSetMeta]);
    }
  }
  return out;
}

function countWithChildren(value) {
  const candidates = candidateListOf(value);
  let n = candidates.length;
  for (const c of candidates || []) {
    if (c._children) n += countWithChildren(c._children);
  }
  return n;
}

function hasHierarchyCandidates(value) {
  const candidates = candidateListOf(value);
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

function dedupeCandidatesForResult(value) {
  const result = toExecutionResult(value);
  const deduped = hasHierarchyCandidates(result)
    ? dedupeHierarchyByCode(result.candidates)
    : dedupeCandidatesByCode(result.candidates);
  return executionResult(deduped, result);
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

function normalizeForSetOps(value) {
  const result = toExecutionResult(value);
  const out = hasHierarchyCandidates(result)
    ? flattenHierarchyCandidates(result.candidates)
    : [...result.candidates];
  return executionResult(out, result);
}

function propagateUnclosed(target, ...sources) {
  return mergeExecutionMetadata(target, ...sources);
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
    if (!node) return executionResult([]);

    switch (node.kind) {
      case 'empty':
        return executionResult([]);

      case 'selector':
        return toExecutionResult(await executeSelector(node, opts, state));

      case 'union': {
        const results = executionResult([]);
        const seen = new Set();
        for (const child of node.items || []) {
          const childResult = normalizeForSetOps(await executeNode(child, opts, state));
          mergeExecutionMetadata(results, childResult);
          for (const c of childResult.candidates) {
            if (!seen.has(c.code)) {
              seen.add(c.code);
              results.candidates.push(c);
            }
          }
        }
        return results;
      }

      case 'intersect': {
        const items = (node.items || []).filter(Boolean);
        if (items.length === 0) return executionResult([]);
        if (items.some(it => it.kind === 'empty')) return executionResult([]);
        if (items.length === 1) return await executeNode(items[0], opts, state);

        const first = normalizeForSetOps(await executeNode(items[0], opts, state));
        const memberships = await Promise.all(
          items.slice(1).map(child => buildMembership(child, state))
        );
        const result = executionResult(
          first.candidates.filter(c => memberships.every(m => m.has(c.code))),
          first
        );
        return result;
      }

      case 'diff': {
        const left = normalizeForSetOps(await executeNode(node.left, opts, state));
        if (!node.right || node.right.kind === 'empty') return left;
        const rightMembership = await buildMembership(node.right, state);
        return executionResult(
          left.candidates.filter(c => !rightMembership.has(c.code)),
          left
        );
      }

      case 'import':
        if (node.resolved) return await executeNode(node.resolved, opts, state);
        return executionResult([]);

      default:
        return executionResult([]);
    }
  }

  async function defaultBuildSelectorMembership(node, state) {
    const candidates = normalizeForSetOps(await executeSelector(node, {}, state));
    return new SetMembership(new Set(candidates.candidates.map(c => c.code)));
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
      let result = dedupeCandidatesForResult(await executeNode(subtree, opts, state));
      const filtered = toExecutionResult(applyTextFilterCandidates(result.candidates, opts.text, state));
      result = executionResult(filtered.candidates, {
        unclosed: filtered.unclosed || result.unclosed,
        limitedExpansion: filtered.limitedExpansion || result.limitedExpansion,
        tooCostly: filtered.tooCostly || result.tooCostly,
      });
      const preserveSourceOrder = result.candidates.length > 0
        && result.candidates.every(c => Number.isInteger(c?._order));
      if (preserveSourceOrder) {
        result.candidates.sort((a, b) => a._order - b._order);
      } else {
        result.candidates.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
      }
      if (opts.offset > 0 || opts.count != null) {
        const off = opts.offset || 0;
        if (hasHierarchyCandidates(result)) {
          const total = countWithChildren(result);
          const lim = opts.count != null ? opts.count : total;
          const fullWindow = off === 0 && lim >= total;
          if (!fullWindow) {
            const flat = flattenHierarchyCandidates(result.candidates);
            result = executionResult(flat.slice(off, off + lim), result);
          }
        } else {
          const lim = opts.count != null ? opts.count : result.candidates.length;
          result = executionResult(result.candidates.slice(off, off + lim), result);
        }
      }
      return result;
    },

    async countForIR(subtree, opts = {}) {
      const state = createState();
      let result = dedupeCandidatesForResult(await executeNode(subtree, opts, state));
      if (typeof onCountUnclosed === 'function' && result.unclosed) {
        onCountUnclosed(result.unclosed);
      }
      if (typeof onCountMetadata === 'function') {
        onCountMetadata(result);
      }
      const filtered = toExecutionResult(applyTextFilterCandidates(result.candidates, opts.text, state));
      result = executionResult(filtered.candidates, {
        unclosed: filtered.unclosed || result.unclosed,
        limitedExpansion: filtered.limitedExpansion || result.limitedExpansion,
        tooCostly: filtered.tooCostly || result.tooCostly,
      });
      return countWithChildren(result);
    },

    async membershipForIR(subtree) {
      const state = createState();
      return await buildMembership(subtree, state);
    },
  };
}

module.exports = {
  candidateListOf,
  countWithChildren,
  createGenericIRExecutor,
  dedupeCandidatesByCode,
  dedupeCandidatesForResult,
  dedupeHierarchyByCode,
  executionResult,
  flattenHierarchyCandidates,
  hasHierarchyCandidates,
  normalizeForSetOps,
  propagateUnclosed,
  toExecutionResult,
};
