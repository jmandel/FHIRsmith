'use strict';

const { projectToSystem, analyzeProjectedSubtree } = require('./rewrite');
const { trace } = require('./expand-trace');
const { bindIRScope } = require('./ir-bound-scope');
const { flattenCandidates, appendAll } = require('./ir-expansion-response');

async function resolveIRExecutionScopes(systems, optimizedIR, opts = {}) {
  const {
    findProvider,
    text,
    effectiveActiveOnly,
    count,
    totalOnly,
    allowIncompleteExpansion,
    warnings = [],
    countFromIR,
  } = opts;

  const sortedSystems = [...systems.entries()].sort(([a], [b]) => a.localeCompare(b));
  const unsupportedSystems = [];
  const usedSystems = new Set();
  const providerMeta = [];
  const resolved = [];

  for (const [key, { system, version }] of sortedSystems) {
    const subtree = projectToSystem(optimizedIR, system, version);
    if (!subtree || subtree.kind === 'empty') continue;
    const projected = analyzeProjectedSubtree(subtree, system, version);
    if (!projected.ok) {
      warnings.push(`IR partition projection failed for ${system}|${version || ''}: ${projected.reason}`);
      return null;
    }

    let boundScope = await findProvider(system, version);
    if (!boundScope) {
      unsupportedSystems.push(system);
      continue;
    }
    if (typeof boundScope.decorateCandidates !== 'function'
        || typeof boundScope.usedSupplements !== 'function'
        || typeof boundScope.nativeCoverage !== 'function') {
      boundScope = await bindIRScope(boundScope, null);
    }

    const provider = boundScope.provider || boundScope;
    const irProvider = boundScope.execution || provider;
    if (typeof irProvider.executeIR !== 'function') {
      unsupportedSystems.push(system);
      continue;
    }

    const provVersion = (typeof provider.version === 'function' ? provider.version() : provider.version) || version;
    const vurl = provVersion ? `${system}|${provVersion}` : system;
    usedSystems.add(vurl);

    const provStatus = typeof provider.status === 'function' ? provider.status() : {};
    const contentMode = typeof provider.contentMode === 'function' ? provider.contentMode() : 'complete';
    providerMeta.push({
      vurl,
      status: provStatus?.status || '',
      standardsStatus: provStatus?.standardsStatus || '',
      experimental: provStatus?.experimental || false,
      contentMode: contentMode || 'complete',
    });

    let sysCount = null;
    const staticCount = countFromIR(subtree, text, effectiveActiveOnly);
    if (staticCount != null) {
      sysCount = staticCount;
      trace.note('count:static', { system, count: sysCount });
    }

    resolved.push({ system, version, provVersion, subtree, boundScope, irProvider, provider, count: sysCount });
  }

  if (unsupportedSystems.length > 0) {
    warnings.push(`Systems without IR support: ${unsupportedSystems.join(', ')}`);
    if (unsupportedSystems.length === systems.size) return null;
  }

  const needsCounts = totalOnly || resolved.length > 1;
  if (needsCounts) {
    for (const r of resolved) {
      if (r.count != null) continue;
      if (typeof r.irProvider.countForIR === 'function') {
        const cntSpan = trace.begin('countForIR', { system: r.system });
        r.count = await r.irProvider.countForIR(r.subtree, {
          activeOnly: effectiveActiveOnly,
          text,
          allowIncompleteExpansion,
        });
        cntSpan.end({ count: r.count });
      } else {
        r.count = 0;
      }
    }
  }

  const knownTotal = resolved.every(r => r.count != null)
    ? resolved.reduce((s, r) => s + r.count, 0)
    : null;

  return {
    resolved,
    knownTotal,
    usedSystems,
    providerMeta,
    unsupportedSystems,
  };
}

async function executeIRExpansionPage(resolved, opts = {}) {
  const {
    text,
    effectiveActiveOnly,
    offset,
    count,
    allowIncompleteExpansion,
    exactTotal = true,
    shouldOmitLazyTotal = false,
    limit = 0,
    vsJson,
  } = opts;

  const totalOnly = count === 0;
  const needsCounts = totalOnly || resolved.length > 1;
  const knownTotal = resolved.every(r => r.count != null)
    ? resolved.reduce((s, r) => s + r.count, 0)
    : null;

  if (limit > 0 && knownTotal != null && knownTotal > limit) {
    const e = new Error(`Expansion of ${vsJson.url || 'ValueSet'} would produce ${knownTotal} codes (limit = ${limit})`);
    e.isTooCostly = true;
    throw e;
  }

  if (totalOnly) {
    return {
      total: knownTotal ?? 0,
      candidates: [],
      knownTotal,
      deferredTotal: null,
      unclosedMessages: [],
      limitedExpansion: false,
      tooCostly: false,
    };
  }

  const allCandidates = [];
  let cursor = 0;
  let remaining = count;
  let deferredTotal = null;
  const unclosedMessages = [];
  let limitedExpansion = false;
  let tooCostly = false;

  for (const r of resolved) {
    if (r.irProvider._discoveredUnclosed) {
      for (const msg of r.irProvider._discoveredUnclosed) unclosedMessages.push(msg);
    }
    if (r.irProvider._discoveredLimitedExpansion) limitedExpansion = true;
    if (r.irProvider._discoveredTooCostly) tooCostly = true;
  }

  const pagSpan = trace.begin('pagination', { total: knownTotal, offset, count, systems: resolved.length });

  if (!needsCounts && resolved.length === 1) {
    const r = resolved[0];
    const sysSpan = trace.begin(`system:${r.system}`, { sysOffset: offset, sysCount: count });
    const result = await r.irProvider.executeIR(r.subtree, {
      activeOnly: effectiveActiveOnly, text, count, offset, allowIncompleteExpansion,
    });
    sysSpan.end({ candidates: result.candidates.length });
    if (result.unclosed) unclosedMessages.push(result.unclosed);
    if (result.limitedExpansion) limitedExpansion = true;
    if (result.tooCostly) tooCostly = true;

    appendAll(allCandidates, flattenCandidates(result.candidates, r, null));

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
    } else if (shouldOmitLazyTotal) {
      trace.note('total:omitted', { offset, returned: flatCount, exactTotal: false });
    } else if (typeof r.irProvider.countForIR === 'function') {
      const cntSpan = trace.begin('countForIR:lazy', { system: r.system });
      deferredTotal = await r.irProvider.countForIR(r.subtree, { activeOnly: effectiveActiveOnly, text });
      if (r.irProvider._discoveredUnclosed) {
        for (const msg of r.irProvider._discoveredUnclosed) unclosedMessages.push(msg);
      }
      if (r.irProvider._discoveredLimitedExpansion) limitedExpansion = true;
      if (r.irProvider._discoveredTooCostly) tooCostly = true;
      cntSpan.end({ count: deferredTotal });
    }

    if (limit > 0 && deferredTotal != null && deferredTotal > limit) {
      const e = new Error(`Expansion of ${vsJson.url || 'ValueSet'} would produce ${deferredTotal} codes (limit = ${limit})`);
      e.isTooCostly = true;
      throw e;
    }
  } else {
    for (const r of resolved) {
      if (remaining <= 0) break;

      const sysEnd = cursor + r.count;
      if (sysEnd <= offset) {
        cursor = sysEnd;
        continue;
      }

      const sysOffset = Math.max(offset - cursor, 0);
      const sysCount = Math.min(remaining, r.count - sysOffset);
      if (sysCount <= 0) {
        cursor = sysEnd;
        continue;
      }

      const sysSpan = trace.begin(`system:${r.system}`, { sysOffset, sysCount });
      const result = await r.irProvider.executeIR(r.subtree, {
        activeOnly: effectiveActiveOnly, text, count: sysCount, offset: sysOffset, allowIncompleteExpansion,
      });
      sysSpan.end({ candidates: result.candidates.length });
      if (result.unclosed) unclosedMessages.push(result.unclosed);
      if (result.limitedExpansion) limitedExpansion = true;
      if (result.tooCostly) tooCostly = true;

      appendAll(allCandidates, flattenCandidates(result.candidates, r, null));

      remaining -= result.candidates.length;
      cursor = sysEnd;
    }
  }
  pagSpan.end({ paged: allCandidates.length });

  return {
    total: knownTotal ?? deferredTotal,
    knownTotal,
    deferredTotal,
    candidates: allCandidates,
    unclosedMessages,
    limitedExpansion,
    tooCostly,
  };
}

module.exports = {
  executeIRExpansionPage,
  resolveIRExecutionScopes,
};
