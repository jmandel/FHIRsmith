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
const { wrapWithLegacyIR } = require('./legacy-ir-adapter');
const { trace } = require('./expand-trace');

/**
 * Check if a ValueSet can be handled by the IR engine.
 * Returns false for ValueSets that need features we don't support yet.
 */
/**
 * Derive count from IR structure without hitting the database.
 * Returns a number for concept enumerations (known size), null otherwise.
 * When a text filter is active, we can't statically count (text may filter out codes).
 */
function countFromIR(node, text) {
  if (text) return null; // text filter may reduce the set
  if (!node) return 0;
  switch (node.kind) {
    case 'empty': return 0;
    case 'selector':
      if (node.shape === 'concept' && node.conceptCodes?.length > 0) {
        return node.conceptCodes.length;
      }
      return null; // filter or whole-system — need SQL
    case 'union': {
      // Union of concept selectors: sum (may overcount if overlapping,
      // but concept enums within one system don't overlap in practice)
      let total = 0;
      for (const child of node.items || []) {
        const c = countFromIR(child, text);
        if (c == null) return null;
        total += c;
      }
      return total;
    }
    default: return null; // diff, intersect, import — need SQL
  }
}

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
  const orchestrateSpan = trace.begin('orchestrate', {
    url: vsJson.url, systems: Object.keys(vsJson.compose?.include || []).length,
    activeOnly, text, offset, count,
  });

  try {

  // 1. Compile ValueSet to IR
  const rawIR = buildIRFromValueSet(vsJson);

  // 2. Resolve imports (if any)
  let resolvedIR = rawIR;
  const usedValueSets = new Set();
  if (resolveValueSet) {
    try {
      resolvedIR = await resolveImports(rawIR, resolveValueSet, { maxDepth: 10 });
      // Collect used-valueset URLs from import resolution
      if (resolvedIR._usedValueSets) {
        for (const vs of resolvedIR._usedValueSets) usedValueSets.add(vs);
      }
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

  // 5. Resolve providers and project IR per system (canonical order by system|version)
  const sortedSystems = [...systems.entries()]
    .sort(([a], [b]) => a.localeCompare(b));

  const unsupportedSystems = [];
  const usedSystems = new Set();
  const providerMeta = [];  // { vurl, status, standardsStatus, experimental, contentMode }
  const totalOnly = count === 0;

  // Phase 1: resolve providers, project subtrees, get per-system counts.
  // Counts are cheap (~0.1-5ms) and let us stride across systems without
  // materializing candidates we'll skip.
  const resolved = []; // [{ system, version, provVersion, subtree, irProvider, provider, count }]
  for (const [key, { system, version }] of sortedSystems) {
    const subtree = projectToSystem(optimizedIR, system, version);
    if (!subtree || subtree.kind === 'empty') continue;

    const provider = await findProvider(system, version);
    if (!provider) { unsupportedSystems.push(system); continue; }

    const provVersion = (typeof provider.version === 'function' ? provider.version() : provider.version) || version;
    const vurl = provVersion ? `${system}|${provVersion}` : system;
    usedSystems.add(vurl);

    // Collect provider canonical status for expansion metadata warnings
    const provStatus = typeof provider.status === 'function' ? provider.status() : {};
    const contentMode = typeof provider.contentMode === 'function' ? provider.contentMode() : 'complete';
    providerMeta.push({
      vurl,
      status: provStatus?.status || '',
      standardsStatus: provStatus?.standardsStatus || '',
      experimental: provStatus?.experimental || false,
      contentMode: contentMode || 'complete',
    });

    let irProvider = provider;
    if (typeof provider.executeIR !== 'function') {
      try { irProvider = wrapWithLegacyIR(provider); }
      catch { unsupportedSystems.push(system); continue; }
    }

    // Get per-system count for stride pagination.
    // Fast path: concept enumerations have a known count from the IR itself
    // (no SQL needed). Only call countForIR for filters/whole-system shapes.
    let sysCount = null; // null = deferred (will be resolved later if needed)
    const staticCount = countFromIR(subtree, text);
    if (staticCount != null) {
      sysCount = staticCount;
      trace.note('count:static', { system, count: sysCount });
    }

    resolved.push({ system, version, provVersion, subtree, irProvider, provider, count: sysCount });
  }

  if (unsupportedSystems.length > 0) {
    warnings.push(`Systems without IR support: ${unsupportedSystems.join(', ')}`);
    if (unsupportedSystems.length === systems.size) return null;
  }

  // Determine which systems need SQL counts.
  // - count=0 (total-only): every system needs a count, no data fetch.
  // - multi-system: every system needs a count for stride pagination.
  // - single system, count>0: defer count — infer from data query result.
  const needsCounts = totalOnly || resolved.length > 1;
  if (needsCounts) {
    for (const r of resolved) {
      if (r.count != null) continue; // already have static count
      if (typeof r.irProvider.countForIR === 'function') {
        const cntSpan = trace.begin('countForIR', { system: r.system });
        r.count = await r.irProvider.countForIR(r.subtree, { activeOnly, text });
        cntSpan.end({ count: r.count });
      } else {
        r.count = 0;
      }
    }
  }

  const knownTotal = resolved.every(r => r.count != null)
    ? resolved.reduce((s, r) => s + r.count, 0) : null;

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
    };
  }

  // Phase 2: stride pagination — walk systems in canonical order,
  // skip systems whose codes fall before `offset`, fetch only from
  // systems whose codes fall within the [offset, offset+count) window.
  const allCandidates = [];
  let cursor = 0;           // running position across all systems
  let remaining = count;    // how many codes we still need

  // Single-system deferred-count: skip the COUNT query, execute data
  // directly, then resolve total from the result or a lazy COUNT.
  let deferredTotal = null;

  const pagSpan = trace.begin('pagination', { total: knownTotal, offset, count, systems: resolved.length });

  if (!needsCounts && resolved.length === 1) {
    // Single system, count deferred — execute directly with user’s offset/count.
    const r = resolved[0];
    const sysSpan = trace.begin(`system:${r.system}`, { sysOffset: offset, sysCount: count });
    const result = await r.irProvider.executeIR(r.subtree, {
      activeOnly, text, count, offset,
    });
    sysSpan.end({ candidates: result.candidates.length });

    for (const c of result.candidates) {
      allCandidates.push({
        system: r.system, version: r.provVersion,
        code: c.code, display: c.display, definition: c.definition,
        active: c.active, conceptId: c.conceptId, _provider: r.provider,
      });
    }

    // Infer total: if we got fewer rows than requested AND we got at
    // least one row, we’re on the last page → total = offset + rows.
    // If we got 0 rows (offset past end) or a full page (more data
    // exists), fall through to the lazy COUNT.
    if (result.candidates.length > 0 && result.candidates.length < count) {
      deferredTotal = offset + result.candidates.length;
      trace.note('total:inferred', { offset, returned: result.candidates.length, total: deferredTotal });
    } else if (typeof r.irProvider.countForIR === 'function') {
      // Full page or empty page past end — need exact count.
      const cntSpan = trace.begin('countForIR:lazy', { system: r.system });
      deferredTotal = await r.irProvider.countForIR(r.subtree, { activeOnly, text });
      cntSpan.end({ count: deferredTotal });
    }
  } else {
    // Multi-system stride pagination (counts already resolved above).
    for (const r of resolved) {
      if (remaining <= 0) break;

      const sysEnd = cursor + r.count;
      if (sysEnd <= offset) {
        cursor = sysEnd;
        continue;
      }

      const sysOffset = Math.max(offset - cursor, 0);
      const sysCount = Math.min(remaining, r.count - sysOffset);
      if (sysCount <= 0) { cursor = sysEnd; continue; }

      const sysSpan = trace.begin(`system:${r.system}`, { sysOffset, sysCount });
      const result = await r.irProvider.executeIR(r.subtree, {
        activeOnly, text, count: sysCount, offset: sysOffset,
      });
      sysSpan.end({ candidates: result.candidates.length });

      for (const c of result.candidates) {
        allCandidates.push({
          system: r.system, version: r.provVersion,
          code: c.code, display: c.display, definition: c.definition,
          active: c.active, conceptId: c.conceptId, _provider: r.provider,
        });
      }

      remaining -= result.candidates.length;
      cursor = sysEnd;
    }
  }
  pagSpan.end({ paged: allCandidates.length });

  const paged = allCandidates;

  // 8.5. Apply compose-level display/designation overrides from IR
  const composeOverrides = collectComposeOverrides(resolved);
  applyComposeOverrides(paged, composeOverrides, includeDesignations);

  // 9. Decorate candidates (designations + properties)
  const decoSpan = trace.begin('bulkDesignations', { count: paged.length, includeDesignations });
  await decorateCandidates(paged, { includeDesignations, properties });
  decoSpan.end();

  // 10. Build contains entries
  const contains = paged.map(c => {
    const entry = {
      system: c.system,
      code: c.code,
    };
    if (c.version) entry.version = c.version;
    if (c.display) entry.display = c.display;
    if (c.active === false) entry.inactive = true;

    // Designations: merge provider designations with compose-level overrides
    if (includeDesignations) {
      const allDesigs = [];
      if (c._designations?.length > 0) allDesigs.push(...c._designations);
      if (c._composeDesignations?.length > 0) allDesigs.push(...c._composeDesignations);
      if (allDesigs.length > 0) entry.designation = allDesigs;
    }

    // Properties
    if (c._properties?.length > 0) {
      for (const prop of c._properties) {
        if (!entry.property) entry.property = [];
        if (typeof prop.value === 'object' && prop.value.system) {
          // Concept-valued property
          entry.property.push({
            code: prop.code,
            valueCoding: prop.value,
          });
        } else {
          entry.property.push({
            code: prop.code,
            valueString: String(prop.value),
          });
        }
      }
    }

    return entry;
  });

  const total = knownTotal ?? deferredTotal;
  const finalResult = {
    expansion: {
      total,
      offset: offset > 0 ? offset : undefined,
      contains,
      usedSystems: [...usedSystems],
      usedValueSets: [...usedValueSets],
      providerMeta,
    },
    warnings,
  };
  orchestrateSpan.end({ total, contains: contains.length });
  return finalResult;

  } finally {
    // Ensure orchestrate span is closed even on error
    orchestrateSpan.end();
  }
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
  if (params.count != null && params.count >= 0) {
    exp.parameter.push({ name: 'count', valueInteger: params.count });
  }
  if (params.activeOnly) {
    exp.parameter.push({ name: 'activeOnly', valueBoolean: true });
  }
  if (params.filter) {
    exp.parameter.push({ name: 'filter', valueString: params.filter });
  }

  // Report used code systems
  if (expansion.usedSystems) {
    for (const sys of expansion.usedSystems) {
      exp.parameter.push({ name: 'used-codesystem', valueUri: sys });
    }
  }

  // Report used value sets (from import resolution)
  if (expansion.usedValueSets) {
    for (const vs of expansion.usedValueSets) {
      addParamIfAbsent(exp, 'used-valueset', vs);
    }
  }

  // Canonical status warnings for each provider (mirrors legacy checkCanonicalStatus)
  if (expansion.providerMeta) {
    const sourceVS = params.sourceVS || vsJson;
    const sourceStatus = sourceVS.status || '';
    const sourceStandardsStatus = sourceVS.extension?.find(
      e => e.url === 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'
    )?.valueCode || '';
    const sourceExperimental = sourceVS.experimental || false;

    for (const meta of expansion.providerMeta) {
      // Fragment content mode → valueset-unclosed extension
      if (meta.contentMode === 'fragment') {
        if (!exp.extension) exp.extension = [];
        const unclosedUrl = 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed';
        if (!exp.extension.some(e => e.url === unclosedUrl)) {
          exp.extension.push({ url: unclosedUrl, valueBoolean: true });
        }
      }

      // Status warnings (mutually exclusive, checked in priority order)
      if (meta.standardsStatus === 'deprecated') {
        addParamIfAbsent(exp, 'warning-deprecated', meta.vurl);
      } else if (meta.standardsStatus === 'withdrawn') {
        addParamIfAbsent(exp, 'warning-withdrawn', meta.vurl);
      } else if (meta.status === 'retired') {
        addParamIfAbsent(exp, 'warning-retired', meta.vurl);
      } else if (meta.experimental && !sourceExperimental) {
        addParamIfAbsent(exp, 'warning-experimental', meta.vurl);
      } else if (
        (meta.status === 'draft' || meta.standardsStatus === 'draft') &&
        !(sourceStatus === 'draft' || sourceStandardsStatus === 'draft')
      ) {
        addParamIfAbsent(exp, 'warning-draft', meta.vurl);
      }
    }
  }

  // Also check the source ValueSet itself (legacy does this)
  {
    const sourceVS = params.sourceVS || vsJson;
    const vsStatus = sourceVS.status || '';
    const vsStdStatus = sourceVS.extension?.find(
      e => e.url === 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'
    )?.valueCode || '';
    const vsVurl = sourceVS.version ? `${sourceVS.url}|${sourceVS.version}` : sourceVS.url;

    if (vsStdStatus === 'deprecated') {
      addParamIfAbsent(exp, 'warning-deprecated', vsVurl);
    } else if (vsStdStatus === 'withdrawn') {
      addParamIfAbsent(exp, 'warning-withdrawn', vsVurl);
    } else if (vsStatus === 'retired') {
      addParamIfAbsent(exp, 'warning-retired', vsVurl);
    }
    // Note: experimental/draft on the VS itself is checked against itself
    // in legacy, which is a no-op (source == resource). Skip here.
  }

  result.expansion = exp;
  return result;
}

/**
 * Decorate candidates with designations and properties from their providers.
 * Groups candidates by provider for bulk fetching.
 */
async function decorateCandidates(candidates, opts = {}) {
  const { includeDesignations = false, properties = [] } = opts;
  if (!includeDesignations && properties.length === 0) return;

  // Group candidates by provider
  const byProvider = new Map();
  for (const c of candidates) {
    if (!c._provider) continue;
    if (!byProvider.has(c._provider)) byProvider.set(c._provider, []);
    byProvider.get(c._provider).push(c);
  }

  for (const [provider, provCandidates] of byProvider) {
    // Use bulk methods if available (v0 SQLite provider)
    if (typeof provider.bulkDesignations === 'function' && includeDesignations) {
      const conceptIds = provCandidates.filter(c => c.conceptId).map(c => c.conceptId);
      const designMap = provider.bulkDesignations(conceptIds);

      for (const c of provCandidates) {
        const desigs = designMap.get(c.conceptId) || [];
        c._designations = desigs
          .filter(d => d.active && d.value)
          .map(d => {
            const obj = {};
            if (d.language) obj.language = d.language;
            if (d.use) obj.use = d.use;
            if (d.value) obj.value = d.value;
            return obj;
          });
      }
    }

    if (typeof provider.bulkProperties === 'function' && properties.length > 0) {
      const conceptIds = provCandidates.filter(c => c.conceptId).map(c => c.conceptId);
      const propMap = provider.bulkProperties(conceptIds);

      for (const c of provCandidates) {
        const allProps = propMap.get(c.conceptId) || [];
        // Filter to requested properties
        c._properties = allProps.filter(p =>
          properties.includes(p.code) || properties.includes('*')
        );

        // Handle 'definition' as a special property
        if (properties.includes('definition') && c.definition) {
          c._properties.push({ code: 'definition', value: c.definition });
        }
      }
    } else if (properties.includes('definition')) {
      // Even without bulk properties, handle definition
      for (const c of provCandidates) {
        if (c.definition) {
          if (!c._properties) c._properties = [];
          c._properties.push({ code: 'definition', value: c.definition });
        }
      }
    }
  }
}

/**
 * Collect compose-level display/designation overrides from the IR tree.
 * Returns a Map keyed by `system|code` → { display?, designation? }.
 */
function collectComposeOverrides(resolvedList) {
  const overrides = new Map(); // 'system|code' → { display, designation }
  for (const r of resolvedList) {
    walkIR(r.subtree, r.system, r.version, overrides);
  }
  return overrides;
}

function walkIR(node, system, version, overrides) {
  if (!node) return;
  if (node.kind === 'selector' && node.shape === 'concept' && node.conceptCodes) {
    const sys = node.system || system;
    for (const cc of node.conceptCodes) {
      if (!cc.code) continue;
      const key = `${sys}|${cc.code}`;
      if (cc.display || (cc.designation && cc.designation.length > 0)) {
        overrides.set(key, {
          display: cc.display || null,
          designation: cc.designation || [],
        });
      }
    }
  }
  if (node.items) for (const item of node.items) walkIR(item, system, version, overrides);
  if (node.left) walkIR(node.left, system, version, overrides);
  if (node.right) walkIR(node.right, system, version, overrides);
  if (node.resolved) walkIR(node.resolved, system, version, overrides);
}

/**
 * Apply compose-level display/designation overrides to candidates.
 */
function applyComposeOverrides(candidates, overrides, includeDesignations) {
  if (!overrides || overrides.size === 0) return;
  for (const c of candidates) {
    const key = `${c.system}|${c.code}`;
    const ov = overrides.get(key);
    if (!ov) continue;
    // Compose display overrides provider display
    if (ov.display) {
      c.display = ov.display;
    }
    // Compose designations are appended to provider designations
    if (includeDesignations && ov.designation && ov.designation.length > 0) {
      if (!c._composeDesignations) c._composeDesignations = [];
      c._composeDesignations.push(...ov.designation);
    }
  }
}

/**
 * Add a URI parameter to expansion if not already present (dedup by name+value).
 */
function addParamIfAbsent(exp, name, valueUri) {
  if (!exp.parameter) exp.parameter = [];
  if (exp.parameter.some(p => p.name === name && p.valueUri === valueUri)) return;
  exp.parameter.push({ name, valueUri });
}

module.exports = {
  canHandleValueSet,
  expandViaIR,
  buildExpandedValueSet,
};
