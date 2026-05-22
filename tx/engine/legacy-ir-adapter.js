'use strict';

const { SearchFilterText } = require('../library/designations');
const { Designations } = require('../library/designations');

/**
 * LegacyIRAdapter — wraps any CodeSystemProvider to implement executeIR().
 *
 * Tree-walks the IR at runtime, calling the provider's existing methods
 * (locate, filter protocol, iteratorAll) at each leaf selector node.
 * Internal nodes (union, intersect, diff) are composed in JS using
 * the membership index types from membership.js.
 *
 * This gives every upstream provider automatic IR support without
 * modifying the provider. The v0 SQLite provider has native executeIR()
 * which bypasses this adapter entirely.
 */

const {
  createGenericIRExecutor,
  dedupeCandidatesByCode,
  dedupeHierarchyByCode,
  executionResult,
  flattenHierarchyCandidates,
  hasHierarchyCandidates,
} = require('./generic-ir-executor');

/**
 * Wrap a CodeSystemProvider so it can participate in IR expansion.
 *
 * @param {CodeSystemProvider} provider - any upstream provider
 * @returns {{ executeIR, membershipForIR, countForIR, hasExecuteIR }}
 */
function wrapWithLegacyIR(provider, opts = {}) {
  const { resolveValueSet = null } = opts;
  const wrapper = {
    ...proxyProvider(provider),
    _discoveredUnclosed: [],
    _discoveredLimitedExpansion: false,
    _discoveredTooCostly: false,
    _discoveredValueSetMeta: [],
    hasExecuteIR() { return true; },
  };

  const executor = createGenericIRExecutor({
    executeSelector: (node, execOpts) => executeSelector(provider, node, execOpts, { resolveValueSet }),
    applyTextFilterCandidates,
    onCountUnclosed: (unclosed) => {
      wrapper._discoveredUnclosed.push(unclosed);
    },
    onCountMetadata: (result) => {
      if (result?.limitedExpansion) wrapper._discoveredLimitedExpansion = true;
      if (result?.tooCostly) wrapper._discoveredTooCostly = true;
      mergeDiscoveredValueSetMeta(wrapper._discoveredValueSetMeta, result?.valueSetMeta);
    },
  });

  wrapper.executeIR = executor.executeIR;
  wrapper.membershipForIR = executor.membershipForIR;
  wrapper.countForIR = executor.countForIR;
  return wrapper;
}

function applyTextFilterCandidates(candidates, text) {
  if (!text) return candidates;
  const filter = new SearchFilterText(String(text));
  const base = hasHierarchyCandidates(candidates)
    ? flattenHierarchyCandidates(candidates)
    : candidates;
  return base.filter(c =>
    filter.passes(String(c.display || ''))
    || filter.passes(String(c.code || ''))
  );
}

function selectorCandidates(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.candidates)) return value.candidates;
  return [];
}

async function collectCandidateDesignationTexts(provider, candidate) {
  const values = new Set();
  const addValue = (text) => {
    if (typeof text === 'string' && text.trim().length > 0) {
      values.add(text.trim());
    }
  };

  addValue(candidate?.display);

  if (candidate?._context && typeof provider.designations === 'function') {
    const languageDefinitions = provider?.opContext?.i18n?.languageDefinitions;
    if (languageDefinitions) {
      const displays = new Designations(languageDefinitions);
      await provider.designations(candidate._context, displays);
      for (const designation of displays) {
        addValue(designation?.value);
      }
    }
  }

  return [...values];
}

async function applyDesignationFilterCandidates(provider, candidates, clauses) {
  if (!Array.isArray(clauses) || clauses.length === 0) {
    return candidates;
  }

  const regexCache = new Map();
  const out = [];

  for (const candidate of candidates || []) {
    const texts = await collectCandidateDesignationTexts(provider, candidate);
    if (texts.length === 0) continue;

    let keep = true;
    for (const clause of clauses) {
      if (clause?.op === '=') {
        if (!texts.includes(clause.value)) {
          keep = false;
          break;
        }
        continue;
      }

      if (clause?.op === 'regex') {
        let regex = regexCache.get(clause.value);
        if (!regex) {
          regex = new RegExp(`^${String(clause.value || '')}$`);
          regexCache.set(clause.value, regex);
        }
        if (!texts.some(text => regex.test(text))) {
          keep = false;
          break;
        }
        continue;
      }

      keep = false;
      break;
    }

    if (keep) out.push(candidate);
  }

  return out;
}

/**
 * Execute a single selector node against a legacy provider.
 */
async function executeSelector(provider, sel, opts, runtime = {}) {
  const { activeOnly = false, allowIncompleteExpansion = false } = opts;
  const { resolveValueSet = null } = runtime;
  const wantParent = typeof provider.hasParents === 'function' && provider.hasParents()
    && typeof provider.parent === 'function';

  if (sel.shape === 'concept') {
    const results = [];
    for (const cc of sel.conceptCodes || []) {
      const located = await provider.locate(cc.code);
      if (!located?.context) continue;
      const ctx = located.context;
      const code = await provider.code(ctx);
      const display = await provider.display(ctx);
      const inactive = await provider.isInactive(ctx);
      if (activeOnly && inactive) continue;
      results.push({
        code,
        display,
        active: !inactive,
        definition: await provider.definition(ctx),
        _context: ctx,
      });
    }
    return dedupeCandidatesByCode(results);
  }

  if (sel.shape === 'filter') {
    const intersectCodes = Array.isArray(sel.intersectCodes) && sel.intersectCodes.length > 0
      ? new Set(sel.intersectCodes.map(code => String(code)))
      : null;
    const designationClauses = [];
    const providerClauses = [];
    for (const clause of sel.filterClauses || []) {
      if (clause?.property === 'designation' && (clause?.op === '=' || clause?.op === 'regex')) {
        designationClauses.push(clause);
      } else {
        providerClauses.push(clause);
      }
    }

    let baseResult = [];
    if (providerClauses.length === 0 && designationClauses.length > 0) {
      baseResult = await executeSelector(provider, { shape: 'whole' }, opts, runtime);
    } else {
      const prep = await provider.getPrepContext(true);
      for (const clause of providerClauses) {
        if (provider.filter.length >= 5) {
          await provider.filter(prep, true, clause.property, clause.op, clause.value);
        } else {
          await provider.filter(prep, clause.property, clause.op, clause.value);
        }
      }
      const sets = await provider.executeFilters(prep);
      if (!sets || sets.length === 0) return [];

      const results = [];
      while (await provider.filterMore(prep, sets[0])) {
        const ctx = await provider.filterConcept(prep, sets[0]);
        const code = await provider.code(ctx);
        if (intersectCodes && !intersectCodes.has(String(code))) continue;
        const inactive = await provider.isInactive(ctx);
        if (activeOnly && inactive) continue;

        if (sets.length > 1) {
          let passes = true;
          for (let i = 1; i < sets.length; i++) {
            const check = await provider.filterCheck(prep, sets[i], ctx);
            if (check !== true) { passes = false; break; }
          }
          if (!passes) continue;
        }

        const display = await provider.display(ctx);
        const entry = {
          code,
          display,
          active: !inactive,
          definition: await provider.definition(ctx),
          _context: ctx,
        };
        if (wantParent) entry._parentCode = await provider.parent(ctx);
        results.push(entry);
      }
      baseResult = dedupeCandidatesByCode(results);
    }

    let finalCandidates = selectorCandidates(baseResult);
    if (designationClauses.length > 0) {
      finalCandidates = await applyDesignationFilterCandidates(provider, finalCandidates, designationClauses);
    }

    if (Array.isArray(baseResult?.candidates)) {
      return executionResult(dedupeCandidatesByCode(finalCandidates), baseResult);
    }
    return dedupeCandidatesByCode(finalCandidates);
  }

  if (sel.shape === 'whole' || sel.shape === 'all') {
    if (wantParent && typeof provider.iterator === 'function') {
      const tree = await iterateHierarchy(provider, null, activeOnly);
      return dedupeHierarchyByCode(tree);
    }

    const iter = await provider.iteratorAll();
    if (!iter) {
      const specUrl = typeof provider.specialEnumeration === 'function'
        ? provider.specialEnumeration() : null;
      const specialEnumeration = specUrl
        ? await loadSpecialEnumeration(resolveValueSet, specUrl)
        : null;
      const fallbackUnits = provider.commonUnits?.units?.length > 0
        ? provider.commonUnits.units
        : null;
      const units = specialEnumeration?.units?.length > 0 ? specialEnumeration.units : fallbackUnits;
      if (specUrl && units?.length > 0) {
        const results = [];
        for (let i = 0; i < units.length; i++) {
          const cu = units[i];
          results.push({
            code: cu.code,
            display: cu.display || cu.code,
            active: true,
            definition: null,
            _context: null,
            _order: i,
          });
        }
        return executionResult(results, {
          unclosed: `The code System "${provider.system()}" has a grammar`
            + ` and so has infinite members. This extension is based on ${specUrl}`,
          valueSetMeta: specialEnumeration?.meta ? [specialEnumeration.meta] : [],
        });
      }
      const tc = typeof provider.totalCount === 'function' ? provider.totalCount() : null;
      if (tc === -1) {
        if (allowIncompleteExpansion) {
          return executionResult([], {
            unclosed: `The code System "${provider.system()}" has a grammar, and cannot be enumerated directly`,
            limitedExpansion: true,
            tooCostly: true,
          });
        }
        const err = new Error(
          `The code System "${provider.system()}" has a grammar, and cannot be enumerated directly`
        );
        err.isTooCostly = true;
        throw err;
      }
      return [];
    }

    const results = [];
    let orderIndex = 0;
    let ctx = await provider.nextContext(iter);
    while (ctx) {
      const code = await provider.code(ctx);
      const inactive = await provider.isInactive(ctx);
      if (!activeOnly || !inactive) {
        const display = await provider.display(ctx);
        results.push({
          code,
          display,
          active: !inactive,
          definition: await provider.definition(ctx),
          _context: ctx,
          _order: orderIndex,
        });
        orderIndex += 1;
      }
      ctx = await provider.nextContext(iter);
    }
    return dedupeCandidatesByCode(results);
  }

  return [];
}

async function loadSpecialEnumeration(resolveValueSet, specUrl) {
  if (typeof resolveValueSet !== 'function' || !specUrl) return null;
  try {
    const vsJson = await resolveValueSet(specUrl, null);
    const units = collectValueSetConcepts(vsJson);
    if (!units || units.length === 0) return null;
    return {
      units,
      meta: extractValueSetMeta(vsJson),
    };
  } catch {
    return null;
  }
}

function extractValueSetMeta(vsJson) {
  if (!vsJson || typeof vsJson !== 'object' || !vsJson.url) return null;
  const standardsStatus = (vsJson.extension || []).find(
    e => e?.url === 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'
  )?.valueCode || '';
  return {
    vurl: vsJson.version ? `${vsJson.url}|${vsJson.version}` : vsJson.url,
    status: vsJson.status || '',
    standardsStatus,
    experimental: !!vsJson.experimental,
  };
}

function collectValueSetConcepts(vsJson) {
  if (!vsJson || typeof vsJson !== 'object') return null;

  const fromExpansion = [];
  collectExpansionContains(vsJson.expansion?.contains || [], fromExpansion);
  if (fromExpansion.length > 0) return fromExpansion;

  const fromCompose = [];
  for (const include of vsJson.compose?.include || []) {
    for (const concept of include?.concept || []) {
      if (!concept?.code) continue;
      fromCompose.push({
        code: concept.code,
        display: concept.display || concept.code,
      });
    }
  }
  return fromCompose.length > 0 ? fromCompose : null;
}

function collectExpansionContains(contains, out) {
  for (const item of contains || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.code) {
      out.push({
        code: item.code,
        display: item.display || item.code,
      });
    }
    if (Array.isArray(item.contains) && item.contains.length > 0) {
      collectExpansionContains(item.contains, out);
    }
  }
}

function mergeDiscoveredValueSetMeta(target, items) {
  if (!Array.isArray(target) || !Array.isArray(items)) return;
  const seen = new Set(target.map(item => item?.vurl).filter(Boolean));
  for (const item of items) {
    const vurl = String(item?.vurl || '').trim();
    if (!vurl || seen.has(vurl)) continue;
    seen.add(vurl);
    target.push(item);
  }
}

async function iterateHierarchy(provider, parentCtx, activeOnly) {
  const iter = await provider.iterator(parentCtx);
  if (!iter) return [];
  const results = [];
  let ctx = await provider.nextContext(iter);
  while (ctx) {
    const code = await provider.code(ctx);
    const inactive = await provider.isInactive(ctx);
    if (!activeOnly || !inactive) {
      const display = await provider.display(ctx);
      const entry = {
        code,
        display,
        active: !inactive,
        definition: await provider.definition(ctx),
        _context: ctx,
      };
      const children = await iterateHierarchy(provider, ctx, activeOnly);
      if (children.length > 0) entry._children = children;
      results.push(entry);
    } else {
      const children = await iterateHierarchy(provider, ctx, activeOnly);
      results.push(...children);
    }
    ctx = await provider.nextContext(iter);
  }
  return results;
}

function proxyProvider(provider) {
  const proxy = {};
  for (const method of [
    'system', 'version', 'name', 'description', 'totalCount',
    'contentMode', 'isNotClosed', 'hasParents', 'parent',
    'locate', 'code', 'display', 'definition',
    'isAbstract', 'isInactive', 'isDeprecated', 'getStatus',
    'designations', 'properties', 'extensions',
    'close',
  ]) {
    if (typeof provider[method] === 'function') {
      proxy[method] = provider[method].bind(provider);
    }
  }
  proxy._wrapped = provider;
  return proxy;
}

module.exports = {
  wrapWithLegacyIR,
};
