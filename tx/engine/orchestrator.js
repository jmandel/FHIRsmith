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
const { renderIRPlanText } = require('./ir-debug');
const {
  optimize,
  collectSystems,
  projectToSystem,
  analyzePartitionSafety,
  analyzeProjectedSubtree,
  splitDiffRoot,
} = require('./rewrite');
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
 * When text/active filters are active, we can't statically count safely.
 */
function countFromIR(node, text, activeOnly) {
  if (text || activeOnly) return null; // runtime filters may reduce the set
  const staticSet = staticConceptSetFromIR(node);
  return staticSet ? staticSet.size : null;
}

/**
 * Return an exact set of concept codes when an IR subtree can be evaluated
 * statically from concept enumerations/imports only. Returns null when any
 * filter/whole-system selector is present.
 */
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
  if (!node || typeof node !== 'object') return false;
  switch (node.kind) {
    case 'selector':
      return !node.version && !!node.lockedDate;
    case 'import':
      return node.resolved ? hasLockedDateSelectors(node.resolved) : false;
    case 'union':
    case 'intersect':
      return (node.items || []).some(hasLockedDateSelectors);
    case 'diff':
      return hasLockedDateSelectors(node.left) || hasLockedDateSelectors(node.right);
    default:
      return false;
  }
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
    if (!n || typeof n !== 'object') return n;
    switch (n.kind) {
    case 'empty':
      return n;
    case 'selector': {
      if (n.version || !n.lockedDate) return n;
      const resolvedVersion = await resolveOne(n.system, n.lockedDate);
      if (!resolvedVersion) {
        const warnKey = `${n.system}|${n.lockedDate}`;
        if (!warned.has(warnKey)) {
          warned.add(warnKey);
          warnings.push(`Unable to resolve ${n.system} at lockedDate ${n.lockedDate}; using unversioned selector`);
        }
        return n;
      }
      return { ...n, version: resolvedVersion, lockedDate: null };
    }
    case 'import':
      return n.resolved ? { ...n, resolved: await walk(n.resolved) } : n;
    case 'union':
      return { ...n, items: await Promise.all((n.items || []).map(walk)) };
    case 'intersect':
      return { ...n, items: await Promise.all((n.items || []).map(walk)) };
    case 'diff':
      return { ...n, left: await walk(n.left), right: await walk(n.right) };
    default:
      return n;
    }
  }

  return await walk(node);
}

/** Enrich a raw candidate with system metadata. */
function enrichCandidate(c, resolved) {
  // Align with legacy behavior: only emit contains.version when the query
  // was version-pinned for this system branch.
  const emitVersion = !!resolved.version;
  const containsVersion = emitVersion ? (resolved.provVersion || resolved.version) : null;
  const entry = {
    system: resolved.system, version: containsVersion,
    code: c.code, display: c.display, definition: c.definition,
    active: c.active, conceptId: c.conceptId, _provider: resolved.provider,
  };
  if (c._parentCode) entry._parentCode = c._parentCode;
  return entry;
}

/** Flatten a tree of candidates (with _children) into a flat array with _parentCode set. */
function flattenCandidates(candidates, resolved, parentCode) {
  const result = [];
  for (const c of candidates) {
    const entry = enrichCandidate(c, resolved);
    if (parentCode) entry._parentCode = parentCode;
    result.push(entry);
    if (c._children) {
      result.push(...flattenCandidates(c._children, resolved, c.code));
    }
  }
  return result;
}

function appendAll(target, items) {
  for (const item of items) target.push(item);
}

/**
 * Nest flat `contains` entries into a tree using `_parentCode` from candidates.
 * Modifies `contains` in place — replaces content with root entries only,
 * children nested inside their parent's `.contains[]`.
 */
function nestContains(contains, candidates) {
  if (!candidates.some(c => c._parentCode)) return;
  const keyOf = (system, version, code) => `${system || ''}\x00${version || ''}\x00${code || ''}`;
  const entryByCode = new Map();
  for (const e of contains) entryByCode.set(keyOf(e.system, e.version, e.code), e);
  const roots = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const entry = contains[i];
    if (!entry) continue;
    const parentEntry = c._parentCode
      ? entryByCode.get(keyOf(c.system, c.version, c._parentCode))
      : null;
    if (parentEntry) {
      if (!parentEntry.contains) parentEntry.contains = [];
      parentEntry.contains.push(entry);
    } else {
      roots.push(entry);
    }
  }
  if (roots.length > 0) {
    contains.length = 0;
    contains.push(...roots);
  }
}

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
    debugPlan = false,
    resolveVersionAtDate = null,
  } = opts;

  const composeInactive = vsJson?.compose?.inactive;
  const effectiveActiveOnly = activeOnly || composeInactive === false;

  const warnings = [];
  const orchestrateSpan = trace.begin('orchestrate', {
    url: vsJson.url, systems: Object.keys(vsJson.compose?.include || []).length,
    activeOnly: effectiveActiveOnly, text, offset, count,
  });

  try {

  // 1. Compile ValueSet to IR
  const rawIR = buildIRFromValueSet(vsJson);

  // 2. Resolve imports (if any)
  let resolvedIR = rawIR;
  const usedValueSets = new Set();
  if (resolveValueSet) {
    try {
      resolvedIR = await resolveImports(rawIR, resolveValueSet, { maxDepth: 50 });
      // Collect used-valueset URLs from import resolution
      if (resolvedIR._usedValueSets) {
        for (const vs of resolvedIR._usedValueSets) usedValueSets.add(vs);
      }
    } catch (e) {
      warnings.push(`Import resolution failed: ${e.message}`);
      // Fall through with unresolved IR — some imports might still work
    }
  }

  // 3. Bind lockedDate selectors to concrete versions when resolver is provided.
  let boundIR = resolvedIR;
  if (hasLockedDateSelectors(boundIR)) {
    if (typeof resolveVersionAtDate === 'function') {
      boundIR = await resolveLockedDateVersions(boundIR, resolveVersionAtDate, warnings);
    } else {
      warnings.push('lockedDate present but no resolveVersionAtDate callback provided; using unversioned selectors');
    }
  }

  // 4. Optimize
  const optimizedIR = optimize(boundIR);

  // 3.5 Guardrail: IR execution requires provably partition-safe expressions.
  // If this invariant fails, return null so caller can fall back to legacy.
  const partitionSafety = analyzePartitionSafety(optimizedIR);
  if (!partitionSafety.ok) {
    warnings.push(`IR partition safety failed: ${partitionSafety.reason}`);
    return null;
  }

  // 5. Collect systems and partition
  const systems = collectSystems(optimizedIR);
  const planText = debugPlan ? renderIRPlanText(optimizedIR, systems, {
    text,
    activeOnly: effectiveActiveOnly,
    offset,
    count,
  }) : null;

  if (systems.size === 0) {
    return {
      expansion: { contains: [], total: 0 },
      warnings,
      debug: planText ? { planText } : undefined,
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
    const projected = analyzeProjectedSubtree(subtree, system, version);
    if (!projected.ok) {
      warnings.push(`IR partition projection failed for ${system}|${version || ''}: ${projected.reason}`);
      return null;
    }

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
    const staticCount = countFromIR(subtree, text, effectiveActiveOnly);
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
        r.count = await r.irProvider.countForIR(r.subtree, { activeOnly: effectiveActiveOnly, text });
        cntSpan.end({ count: r.count });
      } else {
        r.count = 0;
      }
    }
  }

  const knownTotal = resolved.every(r => r.count != null)
    ? resolved.reduce((s, r) => s + r.count, 0) : null;

  // Limit enforcement: reject expansion when total exceeds limit (no pagination)
  if (limit > 0 && knownTotal != null && knownTotal > limit) {
    const e = new Error(`Expansion of ${vsJson.url || 'ValueSet'} would produce ${knownTotal} codes (limit = ${limit})`);
    e.isTooCostly = true;
    throw e;
  }

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

  // Phase 2: stride pagination — walk systems in canonical order,
  // skip systems whose codes fall before `offset`, fetch only from
  // systems whose codes fall within the [offset, offset+count) window.
  const allCandidates = [];
  let cursor = 0;           // running position across all systems
  let remaining = count;    // how many codes we still need

  // Single-system deferred-count: skip the COUNT query, execute data
  // directly, then resolve total from the result or a lazy COUNT.
  let deferredTotal = null;
  const unclosedMessages = [];  // grammar-based providers signal unclosed expansion

  // Collect unclosed signals discovered during counting phase (before executeIR).
  // This ensures unclosed is reported even for systems skipped by pagination.
  for (const r of resolved) {
    if (r.irProvider._discoveredUnclosed) {
      for (const msg of r.irProvider._discoveredUnclosed) unclosedMessages.push(msg);
    }
  }

  const pagSpan = trace.begin('pagination', { total: knownTotal, offset, count, systems: resolved.length });

  if (!needsCounts && resolved.length === 1) {
    // Single system, count deferred — execute directly with user’s offset/count.
    const r = resolved[0];
    const sysSpan = trace.begin(`system:${r.system}`, { sysOffset: offset, sysCount: count });
    const result = await r.irProvider.executeIR(r.subtree, {
      activeOnly: effectiveActiveOnly, text, count, offset,
    });
    sysSpan.end({ candidates: result.candidates.length });
    if (result.unclosed) unclosedMessages.push(result.unclosed);

    appendAll(allCandidates, flattenCandidates(result.candidates, r, null));

    // Infer total: if we got fewer rows than requested AND we got at
    // least one row, we’re on the last page → total = offset + rows.
    // If we got 0 rows (offset past end) or a full page (more data
    // exists), fall through to the lazy COUNT.
    const flatCount = allCandidates.length;
    if (Number.isInteger(result.total) && result.total >= 0) {
      deferredTotal = result.total;
      trace.note('total:provider', { offset, returned: flatCount, total: deferredTotal });
    } else if (flatCount === 0 && offset === 0) {
      deferredTotal = 0;
      trace.note('total:inferred-empty', { offset, returned: flatCount, total: deferredTotal });
    } else if (flatCount > 0 && flatCount < count) {
      deferredTotal = offset + flatCount;
      trace.note('total:inferred', { offset, returned: flatCount, total: deferredTotal });
    } else if (typeof r.irProvider.countForIR === 'function') {
      // Full page or empty page past end — need exact count.
      const cntSpan = trace.begin('countForIR:lazy', { system: r.system });
      deferredTotal = await r.irProvider.countForIR(r.subtree, { activeOnly: effectiveActiveOnly, text });
      cntSpan.end({ count: deferredTotal });
    }

    // Limit enforcement for single-system deferred path
    if (limit > 0 && deferredTotal != null && deferredTotal > limit) {
      const e = new Error(`Expansion of ${vsJson.url || 'ValueSet'} would produce ${deferredTotal} codes (limit = ${limit})`);
      e.isTooCostly = true;
      throw e;
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
        activeOnly: effectiveActiveOnly, text, count: sysCount, offset: sysOffset,
      });
      sysSpan.end({ candidates: result.candidates.length });
      if (result.unclosed) unclosedMessages.push(result.unclosed);

      appendAll(allCandidates, flattenCandidates(result.candidates, r, null));

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

    // Designations: merge provider designations with compose-level overrides,
    // suppress redundant display-typed designations, then filter
    if (includeDesignations) {
      let allDesigs = [];
      if (c._designations?.length > 0) allDesigs.push(...c._designations);
      if (c._composeDesignations?.length > 0) allDesigs.push(...c._composeDesignations);
      // Suppress designations that duplicate the primary display
      const primaryDisplay = entry.display;
      allDesigs = allDesigs.filter(d => {
        if (!d.value || d.value !== primaryDisplay) return true;
        const isDisplayUse = !d.use
          || (d.use.system === 'http://terminology.hl7.org/CodeSystem/designation-usage'
              && d.use.code === 'display');
        const isEnOrEmpty = !d.language || d.language.startsWith('en');
        return !(isDisplayUse && isEnOrEmpty);
      });
      if (designations.length > 0) {
        allDesigs = filterDesignations(allDesigs, designations);
      }
      if (allDesigs.length > 0) entry.designation = allDesigs;
    }

    // Extensions (e.g. itemWeight from supplements)
    if (c._extensions?.length > 0) {
      if (!entry.extension) entry.extension = [];
      entry.extension.push(...c._extensions);
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

  // 11. Nest hierarchy when conditions allow.
  // Candidates carry _parentCode from adapter (tree walk or parent() calls).
  // Nest when: not excluded, not paginating, all codes fit in response.
  const canNest = !excludeNested && offset === 0
    && (count < 0 || count >= (knownTotal ?? deferredTotal ?? contains.length));
  if (canNest && paged.some(c => c._parentCode)) {
    nestContains(contains, paged);
  }

  // Collect used supplements from all resolved providers
  const usedSupplements = new Set();
  for (const r of resolved) {
    const supps = typeof r.provider.listSupplements === 'function'
      ? r.provider.listSupplements() : [];
    for (const s of supps) usedSupplements.add(s);
  }

  const total = knownTotal ?? deferredTotal;
  const finalResult = {
    expansion: {
      total,
      offset: offset > 0 ? offset : undefined,
      contains,
      usedSystems: [...usedSystems],
      usedValueSets: [...usedValueSets],
      usedSupplements: [...usedSupplements],
      providerMeta,
      unclosedMessages,
    },
    warnings,
    debug: planText ? { planText } : undefined,
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
  if (params.includeDesignations) {
    exp.parameter.push({ name: 'includeDesignations', valueBoolean: true });
  }
  if (params.filter) {
    exp.parameter.push({ name: 'filter', valueString: params.filter });
  }
  if (params.displayLanguage) {
    exp.parameter.push({ name: 'displayLanguage', valueCode: params.displayLanguage });
  }
  if (params.designations?.length > 0) {
    for (const d of params.designations) {
      exp.parameter.push({ name: 'designation', valueString: d });
    }
  }
  if (params.properties?.length > 0) {
    for (const p of params.properties) {
      exp.parameter.push({ name: 'property', valueString: p });
    }
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

  // Report used supplements
  if (expansion.usedSupplements) {
    for (const s of expansion.usedSupplements) {
      addParamIfAbsent(exp, 'used-supplement', s);
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

  // Grammar-based providers signal unclosed expansion (e.g. UCUM common units)
  if (expansion.unclosedMessages?.length > 0) {
    if (!exp.extension) exp.extension = [];
    const unclosedUrl = 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed';
    for (const msg of expansion.unclosedMessages) {
      if (!exp.extension.some(e => e.url === unclosedUrl && e.valueString === msg)) {
        exp.extension.push({ url: unclosedUrl, valueString: msg });
      }
    }
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

    // Fallback: per-code designations for providers without bulkDesignations
    if (!provider.bulkDesignations && typeof provider.designations === 'function' && includeDesignations) {
      for (const c of provCandidates) {
        const ctx = c._context || c.code;
        if (!ctx) continue;
        const collector = makeDesignationCollector();
        try {
          await provider.designations(ctx, collector);
        } catch { continue; }
        c._designations = collector.result();
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
    } else if (properties.length > 0) {
      // Fallback: per-code properties + extensions for non-bulk providers
      for (const c of provCandidates) {
        if (!c._properties) c._properties = [];
        if (properties.includes('definition') && c.definition) {
          c._properties.push({ code: 'definition', value: c.definition });
        }
        // Fetch properties from provider if available
        const ctx = c._context || c.code;
        if (typeof provider.properties === 'function' && ctx) {
          try {
            const props = await provider.properties(ctx);
            if (props?.length > 0) {
              for (const p of props) {
                if (properties.includes(p.code) || properties.includes('*')) {
                  c._properties.push(p);
                }
              }
            }
          } catch { /* skip */ }
        }
        // Fetch extensions (e.g. itemWeight) from provider
        if (typeof provider.extensions === 'function' && ctx) {
          try {
            const exts = await provider.extensions(ctx);
            if (exts?.length > 0) {
              if (!c._extensions) c._extensions = [];
              c._extensions.push(...exts);
            }
          } catch { /* skip */ }
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
/**
 * Filter designations by the designation parameter specs.
 * Each spec is "system|code" (filter by use) or "urn:ietf:bcp:47|lang" (filter by language).
 */
function filterDesignations(desigs, designationSpecs) {
  if (!designationSpecs || designationSpecs.length === 0) return desigs;
  return desigs.filter(d => {
    for (const spec of designationSpecs) {
      const [sys, code] = spec.split('|');
      // Match by use system+code
      if (d.use && d.use.system === sys && d.use.code === code) return true;
      // Match by language
      if (sys === 'urn:ietf:bcp:47' && d.language && d.language === code) return true;
    }
    return false;
  });
}

function addParamIfAbsent(exp, name, valueUri) {
  if (!exp.parameter) exp.parameter = [];
  if (exp.parameter.some(p => p.name === name && p.valueUri === valueUri)) return;
  exp.parameter.push({ name, valueUri });
}

/**
 * Lightweight designation collector that mimics the Designations class
 * interface (just addDesignation) without pulling in the full library.
 */
function makeDesignationCollector() {
  const list = [];
  return {
    addDesignation(isDisplay, status, lang, use, value, extensions) {
      if (!value) return;
      const obj = {};
      if (lang) obj.language = typeof lang === 'string' ? lang : lang.code || String(lang);
      if (use) obj.use = use;
      obj.value = value;
      if (extensions?.length > 0) obj.extension = extensions;
      list.push(obj);
    },
    result() { return list; },
  };
}

module.exports = {
  canHandleValueSet,
  expandViaIR,
  buildExpandedValueSet,
  resolveLockedDateVersions,
};
