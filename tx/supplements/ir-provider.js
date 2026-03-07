'use strict';

const IR = require('../engine/ir');
const {
  EmptyMembership,
  SetMembership,
  UnionMembership,
  IntersectMembership,
  DiffMembership,
} = require('../engine/membership');
const { wrapWithLegacyIR } = require('../engine/legacy-ir-adapter');
const { trace } = require('../engine/expand-trace');
const {
  buildSupplementOverlay,
  overlayTouchesProperty,
  valueFromProperty,
} = require('./overlay');

function wrapIRProviderWithSupplements(provider, supplementSet) {
  if (!provider || !supplementSet?.items?.length) return provider;

  const overlay = buildSupplementOverlay(supplementSet);
  const baseIRProvider = typeof provider.executeIR === 'function'
    ? provider
    : wrapWithLegacyIR(provider);

  const extras = {
    _wrappedProvider: provider,
    _wrappedIRProvider: baseIRProvider,
    _irSupplementSet: supplementSet,
    _irSupplementOverlay: overlay,
    _discoveredUnclosed: [],

    hasExecuteIR() { return true; },

    async executeIR(subtree, opts = {}) {
      const span = trace.begin('supplementIR:execute', {
        system: typeof provider.system === 'function' ? provider.system() : undefined,
        text: opts.text || null,
      });
      try {
        let candidates = await executeNode(provider, baseIRProvider, overlay, subtree, opts, new Map());
        candidates = dedupeCandidatesForResult(candidates);
        const unclosed = candidates._unclosed || null;
        candidates = applySupplementTextFilterCandidates(candidates, overlay, opts.text);
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
        span.end({ candidates: candidates.length });
        return result;
      } catch (e) {
        span.end({ error: e.message || String(e) });
        throw e;
      }
    },

    async countForIR(subtree, opts = {}) {
      const span = trace.begin('supplementIR:count', {
        system: typeof provider.system === 'function' ? provider.system() : undefined,
        text: opts.text || null,
      });
      try {
        let candidates = await executeNode(provider, baseIRProvider, overlay, subtree, opts, new Map());
        candidates = dedupeCandidatesForResult(candidates);
        if (candidates._unclosed) {
          extras._discoveredUnclosed.push(candidates._unclosed);
        }
        candidates = applySupplementTextFilterCandidates(candidates, overlay, opts.text);
        const count = countWithChildren(candidates);
        span.end({ count });
        return count;
      } catch (e) {
        span.end({ error: e.message || String(e) });
        throw e;
      }
    },

    async membershipForIR(subtree) {
      return await buildMembership(provider, baseIRProvider, overlay, subtree, new Map());
    },
  };

  return new Proxy(extras, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      const value = provider[prop];
      return typeof value === 'function' ? value.bind(provider) : value;
    },
    set(target, prop, value) {
      if (Reflect.has(target, prop) || !(prop in provider)) {
        target[prop] = value;
      } else {
        provider[prop] = value;
      }
      return true;
    },
    has(target, prop) {
      return Reflect.has(target, prop) || prop in provider;
    },
  });
}

async function executeNode(provider, baseIRProvider, overlay, node, opts, propertyCache) {
  if (!node) return [];
  switch (node.kind) {
    case 'empty':
      return [];
    case 'selector':
      return await executeSelector(provider, baseIRProvider, overlay, node, opts, propertyCache);
    case 'union': {
      const results = [];
      const seen = new Set();
      for (const child of node.items || []) {
        const childRaw = await executeNode(provider, baseIRProvider, overlay, child, opts, propertyCache);
        const childResult = normalizeForSetOps(childRaw);
        propagateUnclosed(results, childRaw, childResult);
        for (const candidate of childResult) {
          if (seen.has(candidate.code)) continue;
          seen.add(candidate.code);
          results.push(candidate);
        }
      }
      return results;
    }
    case 'intersect': {
      const items = (node.items || []).filter(Boolean);
      if (items.length === 0) return [];
      if (items.some(it => it.kind === 'empty')) return [];
      if (items.length === 1) return await executeNode(provider, baseIRProvider, overlay, items[0], opts, propertyCache);
      const firstRaw = await executeNode(provider, baseIRProvider, overlay, items[0], opts, propertyCache);
      const first = normalizeForSetOps(firstRaw);
      const memberships = await Promise.all(
        items.slice(1).map(child => buildMembership(provider, baseIRProvider, overlay, child, propertyCache))
      );
      const result = first.filter(candidate => memberships.every(m => m.has(candidate.code)));
      return propagateUnclosed(result, firstRaw, first);
    }
    case 'diff': {
      const leftRaw = await executeNode(provider, baseIRProvider, overlay, node.left, opts, propertyCache);
      const left = normalizeForSetOps(leftRaw);
      if (!node.right || node.right.kind === 'empty') return left;
      const right = await buildMembership(provider, baseIRProvider, overlay, node.right, propertyCache);
      const result = left.filter(candidate => !right.has(candidate.code));
      return propagateUnclosed(result, leftRaw, left);
    }
    case 'import':
      if (node.resolved) return await executeNode(provider, baseIRProvider, overlay, node.resolved, opts, propertyCache);
      return [];
    default:
      return [];
  }
}

async function executeSelector(provider, baseIRProvider, overlay, sel, opts, propertyCache) {
  if (sel.shape !== 'filter') {
    const result = await baseIRProvider.executeIR(sel, { activeOnly: !!opts.activeOnly });
    const candidates = result?.candidates || [];
    if (result?.unclosed && !candidates._unclosed) candidates._unclosed = result.unclosed;
    return candidates;
  }

  const supplementClauses = [];
  const supportClauses = [];
  for (const clause of sel.filterClauses || []) {
    if (overlayTouchesProperty(overlay, clause.property)) supplementClauses.push(clause);
    else supportClauses.push(clause);
  }

  if (supplementClauses.length === 0) {
    const result = await baseIRProvider.executeIR(sel, { activeOnly: !!opts.activeOnly });
    const candidates = result?.candidates || [];
    if (result?.unclosed && !candidates._unclosed) candidates._unclosed = result.unclosed;
    return candidates;
  }

  const supportSelector = buildSupportSelector(sel, supportClauses);
  const baseResult = await baseIRProvider.executeIR(supportSelector, { activeOnly: !!opts.activeOnly });
  const baseCandidates = baseResult?.candidates || [];
  const filtered = [];
  for (const candidate of baseCandidates) {
    if (await matchesAllSupplementClauses(provider, overlay, candidate, supplementClauses, propertyCache)) {
      filtered.push(candidate);
    }
  }
  trace.note('supplementIR:leaf-filter', {
    system: sel.system,
    supportClauses: supportClauses.length,
    supplementClauses: supplementClauses.map(c => `${c.property} ${c.op} ${c.value}`),
    before: baseCandidates.length,
    after: filtered.length,
  });
  return propagateUnclosed(filtered, baseCandidates);
}

function buildSupportSelector(sel, supportClauses) {
  if (supportClauses.length > 0) {
    return IR.selector({
      system: sel.system,
      version: sel.version || null,
      lockedDate: sel.lockedDate || null,
      shape: 'filter',
      filterClauses: supportClauses,
      intersectCodes: Array.isArray(sel.intersectCodes) ? [...sel.intersectCodes] : null,
      meta: sel.meta || null,
    });
  }
  if (Array.isArray(sel.intersectCodes) && sel.intersectCodes.length > 0) {
    return IR.selector({
      system: sel.system,
      version: sel.version || null,
      lockedDate: sel.lockedDate || null,
      shape: 'concept',
      conceptCodes: sel.intersectCodes.map((code, index) => ({
        code: String(code),
        display: null,
        designation: [],
        extension: [],
        meta: { path: `${sel.meta?.path || 'supplement'}.intersectCodes[${index}]` },
      })),
      meta: sel.meta || null,
    });
  }
  return IR.selector({
    system: sel.system,
    version: sel.version || null,
    lockedDate: sel.lockedDate || null,
    shape: 'whole',
    meta: sel.meta || null,
  });
}

async function buildMembership(provider, baseIRProvider, overlay, node, propertyCache) {
  if (!node) return new EmptyMembership();
  switch (node.kind) {
    case 'empty':
      return new EmptyMembership();
    case 'selector': {
      const needsSupplementEvaluation = node.shape === 'filter'
        && (node.filterClauses || []).some(clause => overlayTouchesProperty(overlay, clause.property));
      if (!needsSupplementEvaluation) {
        return await baseIRProvider.membershipForIR(node);
      }
      const candidates = normalizeForSetOps(
        await executeSelector(provider, baseIRProvider, overlay, node, {}, propertyCache)
      );
      return new SetMembership(new Set(candidates.map(candidate => candidate.code)));
    }
    case 'union':
      return new UnionMembership(
        await Promise.all((node.items || []).map(child => buildMembership(provider, baseIRProvider, overlay, child, propertyCache)))
      );
    case 'intersect':
      return new IntersectMembership(
        await Promise.all((node.items || []).map(child => buildMembership(provider, baseIRProvider, overlay, child, propertyCache)))
      );
    case 'diff':
      return new DiffMembership(
        await buildMembership(provider, baseIRProvider, overlay, node.left, propertyCache),
        await buildMembership(provider, baseIRProvider, overlay, node.right, propertyCache)
      );
    case 'import':
      if (node.resolved) return await buildMembership(provider, baseIRProvider, overlay, node.resolved, propertyCache);
      return new EmptyMembership();
    default:
      return new EmptyMembership();
  }
}

async function matchesAllSupplementClauses(provider, overlay, candidate, clauses, propertyCache) {
  if (!clauses?.length) return true;
  const properties = await getMergedProperties(provider, overlay, candidate, propertyCache);
  return clauses.every(clause => matchesPropertyClause(properties, clause));
}

async function getMergedProperties(provider, overlay, candidate, propertyCache) {
  const code = String(candidate?.code || '');
  if (!code) return [];
  if (propertyCache.has(code)) return propertyCache.get(code);

  const baseRaw = typeof provider.properties === 'function'
    ? await provider.properties(candidate?._context || code)
    : [];
  const base = [];
  for (const prop of baseRaw || []) {
    const normalized = normalizeBaseProperty(prop);
    if (normalized) base.push(normalized);
  }
  const supplement = overlay?.byCode?.get(code)?.properties || [];
  const merged = [...base, ...supplement];
  propertyCache.set(code, merged);
  return merged;
}

function normalizeBaseProperty(prop) {
  if (!prop || typeof prop !== 'object' || !prop.code) return null;
  if (Object.prototype.hasOwnProperty.call(prop, 'value')) {
    return { code: prop.code, value: prop.value };
  }
  const value = valueFromProperty(prop);
  if (value == null) return null;
  return { code: prop.code, value };
}

function matchesPropertyClause(properties, clause) {
  const propCode = String(clause?.property || '');
  const op = String(clause?.op || '');
  const wanted = clause?.value != null ? String(clause.value) : null;
  const values = (properties || [])
    .filter(prop => String(prop.code || '') === propCode)
    .flatMap(prop => valueTokens(prop.value));

  switch (op) {
    case '=':
      return wanted != null && values.includes(wanted);
    case 'in': {
      const wantedValues = splitValueList(wanted);
      return wantedValues.some(value => values.includes(value));
    }
    case 'regex':
      if (wanted == null) return false;
      try {
        const re = new RegExp(wanted);
        return values.some(value => re.test(value));
      } catch {
        return false;
      }
    case 'exists': {
      const expectExists = wanted == null ? true : !/^(false|0)$/i.test(wanted);
      return expectExists ? values.length > 0 : values.length === 0;
    }
    default:
      throw new Error(`Supplement filter op '${op}' is not supported for property '${propCode}'`);
  }
}

function valueTokens(value) {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value === 'object') {
    const tokens = [];
    if (value.system && value.code) tokens.push(`${value.system}|${value.code}`);
    if (value.code) tokens.push(String(value.code));
    if (value.value != null) tokens.push(...valueTokens(value.value));
    return tokens;
  }
  return [String(value)];
}

function splitValueList(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function applySupplementTextFilterCandidates(candidates, overlay, text) {
  if (!text) return candidates;
  const lower = String(text).toLowerCase();
  const base = hasHierarchyCandidates(candidates)
    ? flattenHierarchyCandidates(candidates)
    : candidates;
  const filtered = base.filter(candidate => candidateMatchesText(candidate, overlay, lower));
  if (candidates._unclosed && !filtered._unclosed) filtered._unclosed = candidates._unclosed;
  return filtered;
}

function candidateMatchesText(candidate, overlay, lower) {
  if (!lower) return true;
  if ((candidate.display || '').toLowerCase().includes(lower)) return true;
  if ((candidate.code || '').toLowerCase().includes(lower)) return true;
  const extra = overlay?.byCode?.get(candidate.code);
  if (!extra) return false;
  return (extra.designations || []).some(designation =>
    String(designation?.value || '').toLowerCase().includes(lower)
  );
}

function countWithChildren(candidates) {
  let total = candidates.length;
  for (const candidate of candidates) {
    if (candidate._children) total += countWithChildren(candidate._children);
  }
  return total;
}

function hasHierarchyCandidates(candidates) {
  return candidates.some(candidate => candidate._children && candidate._children.length > 0);
}

function dedupeCandidatesByCode(candidates) {
  const out = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    const code = candidate?.code;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(candidate);
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
  const deduped = hasHierarchyCandidates(candidates)
    ? dedupeHierarchyByCode(candidates)
    : dedupeCandidatesByCode(candidates);
  if (unclosed) deduped._unclosed = unclosed;
  return deduped;
}

function flattenHierarchyCandidates(candidates, parentCode = null, out = []) {
  for (const candidate of candidates || []) {
    const entry = { ...candidate };
    if (parentCode && !entry._parentCode) entry._parentCode = parentCode;
    delete entry._children;
    out.push(entry);
    if (candidate._children) flattenHierarchyCandidates(candidate._children, candidate.code, out);
  }
  return out;
}

function normalizeForSetOps(candidates) {
  const out = hasHierarchyCandidates(candidates)
    ? flattenHierarchyCandidates(candidates)
    : [...(candidates || [])];
  if (candidates?._unclosed && !out._unclosed) out._unclosed = candidates._unclosed;
  return out;
}

function propagateUnclosed(target, ...sources) {
  for (const source of sources) {
    if (source?._unclosed && !target._unclosed) {
      target._unclosed = source._unclosed;
    }
  }
  return target;
}

module.exports = {
  wrapIRProviderWithSupplements,
};
