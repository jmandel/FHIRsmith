'use strict';

const { buildIRFromValueSet } = require('./build-ir');
const { resolveImports } = require('./resolve-imports');
const { renderIRPlanText } = require('./ir-debug');
const { mapIRAsync, walkIR } = require('./ir-traversal');
const {
  optimize,
  collectSystems,
  analyzePartitionSafety,
} = require('./rewrite');

function countFromIR(node, text, activeOnly) {
  if (text || activeOnly) return null;
  const staticSet = staticConceptSetFromIR(node);
  return staticSet ? staticSet.size : null;
}

function staticConceptSetFromIR(node) {
  if (!node) return new Set();
  switch (node.kind) {
    case 'empty':
      return new Set();
    case 'selector': {
      if (node.shape !== 'concept') return null;
      const set = new Set();
      for (const cc of node.conceptCodes || []) {
        const code = String(cc?.code || '');
        if (code) set.add(code);
      }
      return set;
    }
    case 'import':
      return node.resolved ? staticConceptSetFromIR(node.resolved) : null;
    case 'union': {
      const out = new Set();
      for (const child of node.items || []) {
        const c = staticConceptSetFromIR(child);
        if (!c) return null;
        for (const code of c) out.add(code);
      }
      return out;
    }
    case 'intersect': {
      const children = (node.items || []);
      if (children.length === 0) return new Set();
      const first = staticConceptSetFromIR(children[0]);
      if (!first) return null;
      const out = new Set(first);
      for (let i = 1; i < children.length; i++) {
        const c = staticConceptSetFromIR(children[i]);
        if (!c) return null;
        for (const code of [...out]) {
          if (!c.has(code)) out.delete(code);
        }
      }
      return out;
    }
    case 'diff': {
      const left = staticConceptSetFromIR(node.left);
      const right = staticConceptSetFromIR(node.right);
      if (!left || !right) return null;
      const out = new Set(left);
      for (const code of right) out.delete(code);
      return out;
    }
    default:
      return null;
  }
}

function hasLockedDateSelectors(node) {
  let found = false;
  walkIR(node, (n) => {
    if (found) return;
    if (n.kind === 'selector' && !n.version && !!n.lockedDate) found = true;
  });
  return found;
}

async function resolveLockedDateVersions(node, resolveVersionAtDate, warnings = []) {
  const cache = new Map();
  const warned = new Set();

  async function resolveOne(system, lockedDate) {
    const key = `${String(system || '')}\x00${String(lockedDate || '')}`;
    if (cache.has(key)) return cache.get(key);
    const resolved = await resolveVersionAtDate(system, lockedDate);
    const clean = resolved == null ? null : String(resolved).trim();
    cache.set(key, clean || null);
    return cache.get(key);
  }

  async function walk(n) {
    return mapIRAsync(n, async (mapped) => {
      if (mapped.kind !== 'selector' || mapped.version || !mapped.lockedDate) return mapped;
      const resolvedVersion = await resolveOne(mapped.system, mapped.lockedDate);
      if (!resolvedVersion) {
        const warnKey = `${mapped.system}|${mapped.lockedDate}`;
        if (!warned.has(warnKey)) {
          warned.add(warnKey);
          warnings.push(`Unable to resolve ${mapped.system} at lockedDate ${mapped.lockedDate}; using unversioned selector`);
        }
        return mapped;
      }
      return { ...mapped, version: resolvedVersion, lockedDate: null };
    });
  }

  return await walk(node);
}

async function prepareIRPlan(vsJson, opts = {}) {
  const {
    resolveValueSet,
    resolveVersionAtDate,
    warnings = [],
    debugPlan = false,
    text = null,
    activeOnly = false,
    offset = 0,
    count = 1000,
  } = opts;

  const rawIR = buildIRFromValueSet(vsJson);

  let resolvedIR = rawIR;
  const usedValueSets = new Set();
  if (resolveValueSet) {
    try {
      resolvedIR = await resolveImports(rawIR, resolveValueSet, { maxDepth: 50 });
      if (resolvedIR._usedValueSets) {
        for (const vs of resolvedIR._usedValueSets) usedValueSets.add(vs);
      }
    } catch (e) {
      warnings.push(`Import resolution failed: ${e.message}`);
    }
  }

  let boundIR = resolvedIR;
  if (hasLockedDateSelectors(boundIR)) {
    if (typeof resolveVersionAtDate === 'function') {
      boundIR = await resolveLockedDateVersions(boundIR, resolveVersionAtDate, warnings);
    } else {
      warnings.push('lockedDate present but no resolveVersionAtDate callback provided; using unversioned selectors');
    }
  }

  const optimizedIR = optimize(boundIR);
  const partitionSafety = analyzePartitionSafety(optimizedIR);
  if (!partitionSafety.ok) {
    warnings.push(`IR partition safety failed: ${partitionSafety.reason}`);
    return null;
  }

  const systems = collectSystems(optimizedIR);
  const planText = debugPlan ? renderIRPlanText(optimizedIR, systems, {
    text,
    activeOnly,
    offset,
    count,
  }) : null;

  return {
    rawIR,
    resolvedIR,
    boundIR,
    optimizedIR,
    systems,
    usedValueSets,
    planText,
  };
}

module.exports = {
  countFromIR,
  hasLockedDateSelectors,
  prepareIRPlan,
  resolveLockedDateVersions,
  staticConceptSetFromIR,
};
