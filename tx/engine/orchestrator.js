'use strict';

/**
 * IR Engine Orchestrator.
 *
 * Compiles a FHIR ValueSet into an optimized IR, partitions by code system,
 * dispatches each per-system subtree to its provider's executeIR() method,
 * and aggregates results into a FHIR expansion.
 *
 * Providers with native executeIR() (e.g. SqliteV0Provider) run the subtree
 * as a single SQL query. Providers without it get wrapped in LegacyIRAdapter
 * (Phase 3) for tree-walking execution.
 */

const { splitDiffRoot } = require('./rewrite');
const IR = require('./ir');
const { trace } = require('./expand-trace');
const {
  countFromIR,
  prepareIRPlan,
  resolveLockedDateVersions,
} = require('./ir-expansion-plan');
const {
  executeIRExpansionPage,
  resolveIRExecutionScopes,
} = require('./ir-expansion-execution');
const {
  buildExpandedValueSet,
  renderIRExpansionResult,
} = require('./ir-expansion-response');

function canHandleValueSet(vsJson) {
  if (!vsJson || typeof vsJson !== 'object') return false;
  // Expansion-only ValueSets should preserve their existing expansion
  // (legacy short-circuits these). Let legacy handle this shape.
  if (vsJson?.expansion && !vsJson?.compose) return false;
  const compose = vsJson.compose;
  if (!compose) return true;
  if (compose.lockedDate != null && String(compose.lockedDate).trim() === '') return false;
  if (compose.inactive != null && typeof compose.inactive !== 'boolean') return false;
  const include = compose.include;
  const exclude = compose.exclude;
  if (include != null && !Array.isArray(include)) return false;
  if (exclude != null && !Array.isArray(exclude)) return false;

  const components = [...(include || []), ...(exclude || [])];
  for (const cset of components) {
    if (!cset || typeof cset !== 'object') return false;

    const hasSystem = cset.system != null && String(cset.system) !== '';
    const hasVersion = cset.version != null && String(cset.version) !== '';
    const hasConceptField = cset.concept != null;
    const hasFilterField = cset.filter != null;
    const hasValueSetField = cset.valueSet != null;
    const hasConcept = Array.isArray(cset.concept) && cset.concept.length > 0;
    const hasFilter = Array.isArray(cset.filter) && cset.filter.length > 0;
    const hasValueSet = Array.isArray(cset.valueSet) && cset.valueSet.length > 0;

    if (hasConceptField && !Array.isArray(cset.concept)) return false;
    if (hasFilterField && !Array.isArray(cset.filter)) return false;
    if (hasValueSetField && !Array.isArray(cset.valueSet)) return false;

    // vsd-1
    if (hasConcept && hasFilter) return false;
    // vsd-2
    if ((hasConcept || hasFilter) && !hasSystem) return false;
    // vsd-3
    if (hasVersion && !hasSystem) return false;

    // Strict mode: reject empty components that cannot contribute semantics.
    if (!hasSystem && !hasValueSet && !hasConcept && !hasFilter) return false;
  }
  return true;
}

/**
 * Expand a ValueSet using the IR engine.
 *
 * @param {Object} vsJson - ValueSet JSON (plain object)
 * @param {Object} opts - {
 *   findProvider: async (system, version) => CodeSystemProvider | null,
 *   resolveValueSet: async (url, version) => vsJson | null,
 *   activeOnly?: boolean,
 *   text?: string,
 *   offset?: number,
 *   count?: number,
 *   includeDesignations?: boolean,
 *   properties?: string[],
 *   resolveVersionAtDate?: async (system, lockedDate) => version | null,
 *   allowIncompleteExpansion?: boolean,
 * }
 * @returns {Object} { expansion: { contains: [...], total?, offset?, ... }, warnings: string[] }
 */
async function expandViaIR(vsJson, opts = {}) {
  if (!canHandleValueSet(vsJson)) return null;

  const {
    findProvider,
    resolveValueSet,
    activeOnly = false,
    text = null,
    offset = 0,
    count = 1000,
    includeDesignations = false,
    properties = [],
    designations = [],
    excludeNested = false,
    limit = 0,
    exactTotal = true,
    allowIncompleteExpansion = false,
    debugPlan = false,
    resolveVersionAtDate = null,
  } = opts;

  const composeInactive = vsJson?.compose?.inactive;
  const effectiveActiveOnly = activeOnly || composeInactive === false;

  const warnings = [];
  const shouldOmitLazyTotal = !exactTotal
    && offset > 0
    && count > 0
    && offset >= Math.max(100, count * 5);
  const orchestrateSpan = trace.begin('orchestrate', {
    url: vsJson.url, systems: Object.keys(vsJson.compose?.include || []).length,
    activeOnly: effectiveActiveOnly, text, offset, count, exactTotal,
    omitLazyTotal: shouldOmitLazyTotal,
  });

  try {

  const prepared = await prepareIRPlan(vsJson, {
    resolveValueSet,
    resolveVersionAtDate,
    warnings,
    debugPlan,
    text,
    activeOnly: effectiveActiveOnly,
    offset,
    count,
  });
  if (!prepared) return null;

  const {
    optimizedIR,
    systems,
    usedValueSets,
    planText,
  } = prepared;

  if (systems.size === 0) {
    return {
      expansion: { contains: [], total: 0 },
      warnings,
      debug: planText ? { planText } : undefined,
    };
  }

  const totalOnly = count === 0;
  const executionScopes = await resolveIRExecutionScopes(systems, optimizedIR, {
    findProvider,
    text,
    effectiveActiveOnly,
    count,
    totalOnly,
    allowIncompleteExpansion,
    warnings,
    countFromIR,
  });
  if (!executionScopes) return null;

  const {
    resolved,
    knownTotal,
    usedSystems,
    providerMeta,
  } = executionScopes;

  // count=0 means total-only — return no codes
  if (totalOnly) {
    return {
      expansion: {
        total: knownTotal ?? 0,
        offset: offset > 0 ? offset : undefined,
        contains: [],
        usedSystems: [...usedSystems],
        usedValueSets: [...usedValueSets],
        providerMeta,
      },
      warnings,
      debug: planText ? { planText } : undefined,
    };
  }

  const execution = await executeIRExpansionPage(resolved, {
    text,
    effectiveActiveOnly,
    offset,
    count,
    allowIncompleteExpansion,
    exactTotal,
    shouldOmitLazyTotal,
    limit,
    vsJson,
  });
  const {
    candidates: paged,
    total,
  } = execution;

  const decoSpan = trace.begin('bulkDesignations', { count: paged.length, includeDesignations });
  let finalResult;
  try {
    finalResult = await renderIRExpansionResult(execution, resolved, {
      offset,
      count,
      includeDesignations,
      properties,
      designations,
      excludeNested,
      warnings,
      usedSystems,
      usedValueSets,
      providerMeta,
      planText,
    });
  } finally {
    decoSpan.end({ count: paged.length });
  }
  orchestrateSpan.end({
    total,
    contains: finalResult?.expansion?.contains?.length || 0,
  });
  return finalResult;

  } finally {
    // Ensure orchestrate span is closed even on error
    orchestrateSpan.end();
  }
}

module.exports = {
  canHandleValueSet,
  expandViaIR,
  buildExpandedValueSet,
  resolveLockedDateVersions,
};
