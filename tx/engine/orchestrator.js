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

const crypto = require('crypto');
const { buildIRFromValueSet } = require('./build-ir');
const { resolveImports } = require('./resolve-imports');
const { optimize, collectSystems, projectToSystem, splitDiffRoot } = require('./rewrite');
const IR = require('./ir');

/**
 * Check if a ValueSet can be handled by the IR engine.
 * Returns false for ValueSets that need features we don't support yet.
 */
function canHandleValueSet(vsJson) {
  const compose = vsJson?.compose;
  if (!compose) return false;

  const includes = compose.include || [];
  const excludes = compose.exclude || [];

  // Must have at least one include
  if (includes.length === 0) return false;

  // Check all components have a system (pure-import only components need
  // import resolution which we support, but let's be conservative)
  for (const cset of [...includes, ...excludes]) {
    // Components with only valueSet imports and no system need import resolution
    // which we support, but skip components with neither system nor valueSet
    if (!cset.system && (!cset.valueSet || cset.valueSet.length === 0)) {
      return false;
    }
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
 * }
 * @returns {Object} { expansion: { contains: [...], total?, offset?, ... }, warnings: string[] }
 */
async function expandViaIR(vsJson, opts = {}) {
  const {
    findProvider,
    resolveValueSet,
    activeOnly = false,
    text = null,
    offset = 0,
    count = 1000,
    includeDesignations = false,
    properties = [],
  } = opts;

  const warnings = [];

  // 1. Compile ValueSet to IR
  const rawIR = buildIRFromValueSet(vsJson);

  // 2. Resolve imports (if any)
  let resolvedIR = rawIR;
  if (resolveValueSet) {
    try {
      resolvedIR = await resolveImports(rawIR, resolveValueSet, { maxDepth: 10 });
    } catch (e) {
      warnings.push(`Import resolution failed: ${e.message}`);
      // Fall through with unresolved IR — some imports might still work
    }
  }

  // 3. Optimize
  const optimizedIR = optimize(resolvedIR);

  // 4. Collect systems and partition
  const systems = collectSystems(optimizedIR);

  if (systems.size === 0) {
    return {
      expansion: { contains: [], total: 0 },
      warnings,
    };
  }

  // 5. For each system, project the IR and execute
  const allCandidates = [];
  const unsupportedSystems = [];

  for (const [key, { system, version }] of systems) {
    const subtree = projectToSystem(optimizedIR, system, version);
    if (!subtree || subtree.kind === 'empty') continue;

    const provider = await findProvider(system, version);
    if (!provider) {
      unsupportedSystems.push(system);
      continue;
    }

    if (typeof provider.executeIR === 'function') {
      // Native IR execution (v0 SQLite provider)
      const result = provider.executeIR(subtree, {
        activeOnly,
        text,
        // Don't paginate per-system — collect all, paginate at the end
        count: undefined,
        offset: undefined,
      });
      for (const c of result.candidates) {
        allCandidates.push({
          system,
          version: provider.version?.() || version,
          code: c.code,
          display: c.display,
          definition: c.definition,
          active: c.active,
          conceptId: c.conceptId,
          _provider: provider,
        });
      }
    } else {
      // No native IR — system not supported by IR engine yet
      unsupportedSystems.push(system);
    }
  }

  if (unsupportedSystems.length > 0) {
    warnings.push(`Systems without IR support: ${unsupportedSystems.join(', ')}`);
    // If any system is unsupported, we can't produce a complete expansion
    // The caller should fall back to legacy
    if (unsupportedSystems.length === systems.size) {
      return null; // Signal: can't handle at all
    }
  }

  // 6. Cross-system dedup (by system|code)
  const seen = new Set();
  const deduped = [];
  for (const c of allCandidates) {
    const key = `${c.system}|${c.code}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(c);
    }
  }

  // 7. Apply active-only filter (in case provider didn't)
  let filtered = deduped;
  if (activeOnly) {
    filtered = deduped.filter(c => c.active !== false);
  }

  // 8. Pagination
  const total = filtered.length;
  const paged = filtered.slice(offset, offset + count);

  // 9. Build contains entries
  const contains = paged.map(c => {
    const entry = {
      system: c.system,
      code: c.code,
    };
    if (c.version) entry.version = c.version;
    if (c.display) entry.display = c.display;
    if (c.active === false) entry.inactive = true;
    if (c.definition && properties.includes('definition')) {
      entry.definition = c.definition;
    }
    return entry;
  });

  return {
    expansion: {
      total,
      offset: offset > 0 ? offset : undefined,
      contains,
    },
    warnings,
  };
}

/**
 * Build a full FHIR ValueSet result from IR expansion.
 * Mirrors the output format of upstream's ValueSetExpander.expand().
 */
function buildExpandedValueSet(vsJson, expansion, params = {}) {
  const result = { ...vsJson };
  delete result.id;

  if (!params.includeDefinition) {
    delete result.purpose;
    delete result.compose;
    delete result.description;
    delete result.copyright;
    delete result.publisher;
    delete result.extension;
    delete result.text;
  }

  const exp = {
    timestamp: new Date().toISOString(),
    identifier: 'urn:uuid:' + crypto.randomUUID(),
  };

  if (expansion.total != null) {
    exp.total = expansion.total;
  }
  if (expansion.offset != null) {
    exp.offset = expansion.offset;
  }
  if (expansion.contains && expansion.contains.length > 0) {
    exp.contains = expansion.contains;
  }

  // Add parameters
  exp.parameter = [];
  if (params.offset != null && params.offset > 0) {
    exp.parameter.push({ name: 'offset', valueInteger: params.offset });
  }
  if (params.count != null) {
    exp.parameter.push({ name: 'count', valueInteger: params.count });
  }
  if (params.activeOnly) {
    exp.parameter.push({ name: 'activeOnly', valueBoolean: true });
  }
  if (params.filter) {
    exp.parameter.push({ name: 'filter', valueString: params.filter });
  }

  result.expansion = exp;
  return result;
}

module.exports = {
  canHandleValueSet,
  expandViaIR,
  buildExpandedValueSet,
};
