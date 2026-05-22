'use strict';

const { Extensions } = require('../library/extensions');
const { getValuePrimitive } = require('../../library/utilities');
const { Issue } = require('../library/operation-outcome');
const {
  dedupeSupplementRefs,
  makeSupplementRef,
  supplementRefKey,
} = require('../supplements/types');
const { ExpandTrace, traceStore, formatTraceSummary } = require('./expand-trace');
const { canHandleValueSet, expandViaIR, buildExpandedValueSet } = require('./orchestrator');

const IR_PLAN_EXTENSION_URL = 'https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/ir-plan';

function collectExplicitSupplementRefs(vsJson, params) {
  const refs = [];
  let order = 0;
  for (const canonical of params?.supplements || []) {
    if (canonical) refs.push(makeSupplementRef(canonical, 'useSupplement', order++));
  }
  for (const ext of Extensions.list(vsJson, 'http://hl7.org/fhir/StructureDefinition/valueset-supplement')) {
    const canonical = getValuePrimitive(ext);
    if (canonical) refs.push(makeSupplementRef(canonical, 'valueset-extension', order++));
  }
  return dedupeSupplementRefs(refs);
}

function maybeIssueFromIRError(error) {
  const message = error?.message || String(error);
  const unsupportedFilterMatch = /^Unsupported filter property: (.+)$/.exec(message);
  if (unsupportedFilterMatch) {
    return new Issue('error', 'not-supported', null, null,
      `The filter property "${unsupportedFilterMatch[1]}" is not supported by the IR engine`,
      null, 422);
  }
  const unknownPropertyMatch = /^sqlite-v0 base membership compilation failed: unknown-property (.+)$/.exec(message);
  if (unknownPropertyMatch) {
    try {
      const detail = JSON.parse(unknownPropertyMatch[1]);
      if (detail?.property) {
        return new Issue('error', 'not-supported', null, null,
          `The filter "${detail.property} ${detail.op} ${detail.value}" was not understood by the IR engine`,
          null, 422);
      }
    } catch {
      // Fall through to generic handling below.
    }
    return new Issue('error', 'not-supported', null, null, message, null, 422);
  }
  const genericFilterMatch = /^The filter (.+) was not understood$/.exec(message);
  if (genericFilterMatch) {
    return new Issue('error', 'not-supported', null, null,
      `The filter ${genericFilterMatch[1]} was not understood by the IR engine`,
      null, 422);
  }
  const issueFilterMatch = /^The filter "(.+)" is not understood or supported$/.exec(message);
  if (issueFilterMatch) {
    return new Issue('error', 'not-supported', null, null,
      `The filter ${issueFilterMatch[1]} was not understood by the IR engine`,
      null, 422);
  }
  return null;
}

function providerRuntimeScopeLabel(system, version) {
  const s = String(system || '').trim();
  const v = String(version || '').trim();
  return v ? `${s}|${v}` : s;
}

function issueFromIRProviderRuntimeError(error, system, version) {
  if (error instanceof Issue) return error;
  const message = error?.message || String(error);
  if (message.includes('Ambiguous supplement')) {
    return new Issue('error', 'invalid', null, 'VALUESET_SUPPLEMENT_AMBIGUOUS', message, 'invalid', 422);
  }
  return new Issue(
    'error',
    'processing',
    null,
    'IR_SUPPLEMENT_RUNTIME_FAILURE',
    `IR supplement/provider runtime failed for ${providerRuntimeScopeLabel(system, version)}: ${message}`,
    'processing',
    500
  );
}

function strictIRUnsupported(reason) {
  return new Issue(
    'error',
    'not-supported',
    null,
    null,
    `IR engine cannot handle this ValueSet (${reason || 'ir-returned-null'})`,
    null,
    422
  );
}

async function maybeExpandValueSetViaIR(opts = {}) {
  const {
    valueSet,
    params,
    strictIR = false,
    externalDefaultLimit = 1000,
    traceExtensionUrl = null,
    services = {},
  } = opts;

  const vsJson = valueSet?.jsonObj || valueSet;
  const {
    findBaseProvider,
    buildSupplementRegistry,
    resolveSupplementSet,
    bindIRScope,
    resolveValueSet,
    resolveVersionAtDate,
    log,
    diagnostics,
  } = services;

  const wantTrace = !!params?._trace;
  const irStartedAt = performance.now();

  try {
    if (!canHandleValueSet(vsJson)) {
      if (strictIR) throw strictIRUnsupported('canHandleValueSet=false');
      return {
        expansion: null,
        irAttempt: {
          attempted: true,
          used: false,
          ms: Math.round((performance.now() - irStartedAt) * 100) / 100,
          reason: 'canHandleValueSet=false',
        },
      };
    }

    const traceObj = wantTrace ? new ExpandTrace() : null;

    const runExpansion = async () => {
      const supplementRefs = collectExplicitSupplementRefs(vsJson, params);
      const supplementRegistry = supplementRefs.length > 0
        ? await buildSupplementRegistry()
        : null;
      const matchedSupplementRefKeys = new Set();
      const supplementSetCache = new Map();

      async function getSupplementSet(system, version) {
        if (!supplementRegistry) return { items: [], matchedRefKeys: [] };
        const key = `${String(system || '')}\x00${String(version || '')}`;
        if (supplementSetCache.has(key)) return supplementSetCache.get(key);
        const supplementSet = await resolveSupplementSet(
          { system, version: version || null },
          supplementRefs,
          supplementRegistry
        );
        for (const refKey of supplementSet.matchedRefKeys || []) {
          matchedSupplementRefKeys.add(refKey);
        }
        for (const ref of supplementSet.inapplicableRefs || []) {
          const refKey = supplementRefKey(ref);
          if (refKey) matchedSupplementRefKeys.add(refKey);
        }
        supplementSetCache.set(key, supplementSet);
        return supplementSet;
      }

      const result = await expandViaIR(vsJson, {
        findProvider: async (system, version) => {
          try {
            const provider = await findBaseProvider(system, version);
            if (!provider) return provider;
            const resolvedSystem = system || (typeof provider.system === 'function' ? provider.system() : null);
            const resolvedVersion = version || (typeof provider.version === 'function' ? provider.version() : null) || null;
            const supplementSet = await getSupplementSet(resolvedSystem, resolvedVersion);
            return await bindIRScope(provider, supplementSet);
          } catch (e) {
            throw issueFromIRProviderRuntimeError(e, system, version);
          }
        },
        resolveValueSet,
        resolveVersionAtDate,
        activeOnly: !!params.activeOnly,
        text: params.filter || null,
        offset: Math.max(params.offset || 0, 0),
        count: params.count >= 0 ? params.count : (params.limit > 0 ? params.limit : externalDefaultLimit),
        includeDesignations: !!params.includeDesignations,
        excludeNested: !!params.excludeNested,
        properties: params.properties || [],
        designations: params.designations || [],
        exactTotal: params.exactTotal !== false,
        allowIncompleteExpansion: !!params.incompleteOK || !!params.limitedExpansion,
        limit: (params.offset < 0 && params.count < 0)
          ? (params.limit > 0 ? Math.min(params.limit, externalDefaultLimit) : externalDefaultLimit)
          : 0,
        debugPlan: wantTrace,
      });

      if (!result) {
        return { expansion: null, reason: 'expandViaIR returned null' };
      }
      if (result.warnings?.some(w => w.includes('Systems without IR support'))) {
        return {
          expansion: null,
          reason: 'systems-without-ir-support',
          warnings: result.warnings,
        };
      }

      if (supplementRefs.length > 0) {
        const unresolved = supplementRefs.filter(ref => !matchedSupplementRefKeys.has(supplementRefKey(ref)))
          .map(ref => ref.canonical)
          .filter(Boolean);
        if (unresolved.length > 0) {
          throw new Issue('error', 'not-found', null, 'VALUESET_SUPPLEMENT_MISSING',
            `Required supplement(s) not found: ${unresolved.join(', ')}`,
            'not-found', 422);
        }
      }

      const expansion = buildExpandedValueSet(vsJson, result.expansion, {
        offset: params.offset,
        count: params.count,
        activeOnly: params.activeOnly,
        filter: params.filter,
        includeDefinition: params.includeDefinition,
        includeDesignations: params.includeDesignations,
        designations: params.designations || [],
        displayLanguage: params.DisplayLanguages?.asString?.(true) || null,
        properties: params.properties || [],
        sourceVS: vsJson,
      });

      if (wantTrace && result?.debug?.planText && expansion?.expansion) {
        expansion.expansion.extension = expansion.expansion.extension || [];
        expansion.expansion.extension.push({
          url: IR_PLAN_EXTENSION_URL,
          valueString: String(result.debug.planText),
        });
      }

      if (wantTrace && traceObj && expansion?.expansion && traceExtensionUrl) {
        const traceJson = traceObj.toJSON();
        expansion.expansion.extension = expansion.expansion.extension || [];
        expansion.expansion.extension.push({
          url: traceExtensionUrl,
          valueString: JSON.stringify(traceJson),
        });
        log?.(`[IR trace] ${formatTraceSummary(traceJson)}`);
      }

      return { expansion };
    };

    const irResult = wantTrace && traceObj
      ? await traceStore.run(traceObj, runExpansion)
      : await runExpansion();

    const irMs = performance.now() - irStartedAt;
    if (irResult?.expansion) {
      return {
        expansion: irResult.expansion,
        irAttempt: {
          attempted: true,
          used: true,
          ms: Math.round(irMs * 100) / 100,
        },
      };
    }

    if (strictIR) throw strictIRUnsupported(irResult?.reason || 'ir-returned-null');

    const irAttempt = {
      attempted: true,
      used: false,
      ms: Math.round(irMs * 100) / 100,
      reason: irResult?.reason || 'ir-returned-null',
    };
    if (irResult?.warnings?.length) irAttempt.warnings = irResult.warnings;
    return { expansion: null, irAttempt };
  } catch (e) {
    const irMs = performance.now() - irStartedAt;
    if (e.isTooCostly) {
      throw new Issue('error', 'too-costly', null, null, e.message, null, 422)
        .withDiagnostics(diagnostics?.());
    }
    const normalizedIRError = maybeIssueFromIRError(e);
    if (strictIR && normalizedIRError) throw normalizedIRError;
    if (e instanceof Issue) throw e;
    if (strictIR) throw e;
    log?.(`IR engine failed, falling back to legacy: ${e.message}`);
    return {
      expansion: null,
      irAttempt: {
        attempted: true,
        used: false,
        ms: Math.round(irMs * 100) / 100,
        reason: 'ir-error',
        error: e?.message || String(e),
      },
    };
  }
}

module.exports = {
  maybeExpandValueSetViaIR,
};
