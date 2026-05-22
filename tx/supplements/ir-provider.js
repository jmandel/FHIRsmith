'use strict';

const IR = require('../engine/ir');
const { SearchFilterText } = require('../library/designations');
const {
  createGenericIRExecutor,
  executionResult,
  flattenHierarchyCandidates,
  hasHierarchyCandidates,
} = require('../engine/generic-ir-executor');
const { wrapWithLegacyIR } = require('../engine/legacy-ir-adapter');
const { trace } = require('../engine/expand-trace');
const {
  buildSupplementOverlay,
  overlayTouchesProperty,
  valueFromProperty,
} = require('./overlay');
const { requestedExpansionPropertyMatches } = require('../library/expansion-properties');

function wrapIRProviderWithSupplements(provider, supplementSet, opts = {}) {
  if (!provider || !supplementSet?.items?.length) return provider;

  const overlay = buildSupplementOverlay(supplementSet);
  const baseIRProvider = opts.baseIRProvider || (typeof provider.executeIR === 'function'
    ? provider
    : wrapWithLegacyIR(provider, opts));

  const execution = {
    provider,
    baseIRProvider,
    _irSupplementSet: supplementSet,
    _irSupplementOverlay: overlay,
    _discoveredUnclosed: [],
    _discoveredLimitedExpansion: false,
    _discoveredTooCostly: false,
    hasExecuteIR() { return true; },
  };

  const executor = createGenericIRExecutor({
    createState: () => ({ propertyCache: new Map() }),
    executeSelector: (node, opts, state) => executeSelector(provider, baseIRProvider, overlay, node, opts, state),
    buildSelectorMembership: (node, state, defaultBuilder) =>
      buildSelectorMembership(provider, baseIRProvider, overlay, node, state, defaultBuilder),
    applyTextFilterCandidates: (candidates, text) => applySupplementTextFilterCandidates(candidates, overlay, text),
    onCountUnclosed: (unclosed) => {
      execution._discoveredUnclosed.push(unclosed);
    },
    onCountMetadata: (result) => {
      if (result?.limitedExpansion) execution._discoveredLimitedExpansion = true;
      if (result?.tooCostly) execution._discoveredTooCostly = true;
    },
  });

  execution.executeIR = async function executeIR(subtree, opts = {}) {
    const span = trace.begin('supplementIR:execute', {
      system: typeof provider.system === 'function' ? provider.system() : undefined,
      text: opts.text || null,
    });
    try {
      const result = await executor.executeIR(subtree, opts);
      span.end({ candidates: result.candidates.length });
      return result;
    } catch (e) {
      span.end({ error: e.message || String(e) });
      throw e;
    }
  };

  execution.countForIR = async function countForIR(subtree, opts = {}) {
    const span = trace.begin('supplementIR:count', {
      system: typeof provider.system === 'function' ? provider.system() : undefined,
      text: opts.text || null,
    });
    try {
      const count = await executor.countForIR(subtree, opts);
      span.end({ count });
      return count;
    } catch (e) {
      span.end({ error: e.message || String(e) });
      throw e;
    }
  };

  execution.membershipForIR = executor.membershipForIR;

  return execution;
}

async function executeSelector(provider, baseIRProvider, overlay, sel, opts, state) {
  if (sel.shape !== 'filter') {
    return await baseIRProvider.executeIR(sel, {
      activeOnly: !!opts.activeOnly,
      allowIncompleteExpansion: !!opts.allowIncompleteExpansion,
    });
  }

  const supplementClauses = [];
  const supportClauses = [];
  for (const clause of sel.filterClauses || []) {
    if (overlayTouchesProperty(overlay, clause.property)) supplementClauses.push(clause);
    else supportClauses.push(clause);
  }

  if (supplementClauses.length === 0) {
    return await baseIRProvider.executeIR(sel, {
      activeOnly: !!opts.activeOnly,
      allowIncompleteExpansion: !!opts.allowIncompleteExpansion,
    });
  }

  const supportSelector = buildSupportSelector(sel, supportClauses);
  const baseResult = await baseIRProvider.executeIR(supportSelector, {
    activeOnly: !!opts.activeOnly,
    allowIncompleteExpansion: !!opts.allowIncompleteExpansion,
  });
  const baseCandidates = baseResult?.candidates || [];
  const filtered = [];
  const enumerable = hasHierarchyCandidates(baseCandidates)
    ? flattenHierarchyCandidates(baseCandidates)
    : baseCandidates;
  for (const candidate of enumerable) {
    if (await matchesAllSupplementClauses(provider, overlay, candidate, supplementClauses, state.propertyCache)) {
      filtered.push(candidate);
    }
  }
  trace.note('supplementIR:leaf-filter', {
    system: sel.system,
    supportClauses: supportClauses.length,
    supplementClauses: supplementClauses.map(c => `${c.property} ${c.op} ${c.value}`),
    before: enumerable.length,
    after: filtered.length,
  });
  return executionResult(filtered, baseResult);
}

async function buildSelectorMembership(provider, baseIRProvider, overlay, node, state, defaultBuilder) {
  const needsSupplementEvaluation = node.shape === 'filter'
    && (node.filterClauses || []).some(clause => overlayTouchesProperty(overlay, clause.property));
  if (!needsSupplementEvaluation) {
    return await baseIRProvider.membershipForIR(node);
  }
  return await defaultBuilder(node, state);
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
    return {
      code: prop.code,
      value: prop.value,
      ...(prop.uri ? { uri: prop.uri } : {}),
      ...(prop.definition ? { definition: prop.definition } : {}),
    };
  }
  const value = valueFromProperty(prop);
  if (value == null) return null;
  return {
    code: prop.code,
    value,
    ...(prop.uri ? { uri: prop.uri } : {}),
    ...(prop.definition ? { definition: prop.definition } : {}),
  };
}

function matchesPropertyClause(properties, clause) {
  const propCode = String(clause?.property || '');
  const op = String(clause?.op || '');
  const wanted = clause?.value != null ? String(clause.value) : null;
  const values = (properties || [])
    .filter(prop => requestedExpansionPropertyMatches(prop, [propCode]))
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
  const filter = new SearchFilterText(String(text));
  const base = hasHierarchyCandidates(candidates)
    ? flattenHierarchyCandidates(candidates)
    : candidates;
  return base.filter(candidate => candidateMatchesText(candidate, overlay, filter));
}

function candidateMatchesText(candidate, overlay, filter) {
  if (!filter || filter.isNull) return true;
  if (filter.passes(String(candidate.display || ''))) return true;
  if (filter.passes(String(candidate.code || ''))) return true;
  const extra = overlay?.byCode?.get(candidate.code);
  if (!extra) return false;
  return (extra.designations || []).some(designation =>
    filter.passes(String(designation?.value || ''))
  );
}

module.exports = {
  wrapIRProviderWithSupplements,
};
