'use strict';

const { CodeSystem } = require('../library/codesystem');
const { Issue } = require('../library/operation-outcome');
const { buildSupplementRegistry } = require('../supplements/registry');
const {
  materializeSupplementSetOverlaySources,
  resolveSupplementsForBaseScope,
} = require('../supplements/resolver');
const { dedupeSupplementRefs, makeSupplementRef } = require('../supplements/types');
const { bindIRScope } = require('../engine/ir-bound-scope');

function toSupplementRefs(statedSupplements) {
  return dedupeSupplementRefs(
    Array.from(statedSupplements || []).map((canonical, index) =>
      makeSupplementRef(canonical, 'useSupplement', index))
  );
}

function parseISODatePrefix(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d);
}

function parseYYYYMMDD(raw) {
  const s = String(raw || '').trim();
  if (!/^\d{8}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (y < 1800 || y > 2400 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d);
}

function parseMMDDYYYY(raw) {
  const s = String(raw || '').trim();
  if (!/^\d{8}$/.test(s)) return null;
  const mo = Number(s.slice(0, 2));
  const d = Number(s.slice(2, 4));
  const y = Number(s.slice(4, 8));
  if (y < 1800 || y > 2400 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d);
}

function parseVersionDate(version) {
  const v = String(version || '').trim();
  if (!v) return null;
  const directIso = parseISODatePrefix(v);
  if (directIso != null) return directIso;
  const directYmd = parseYYYYMMDD(v);
  if (directYmd != null) return directYmd;
  const directMdy = parseMMDDYYYY(v);
  if (directMdy != null) return directMdy;

  const mIso = v.match(/(\d{4}-\d{2}-\d{2})/);
  if (mIso) {
    const iso = parseISODatePrefix(mIso[1]);
    if (iso != null) return iso;
  }
  const mDigits = v.match(/(\d{8})/);
  if (mDigits) {
    const ymd = parseYYYYMMDD(mDigits[1]);
    if (ymd != null) return ymd;
    const mdy = parseMMDDYYYY(mDigits[1]);
    if (mdy != null) return mdy;
  }
  return null;
}

async function buildSupplementRegistryForIR(worker) {
  const registeredCodeSystems = [];
  const seenResources = new Set();

  if (worker.provider?.codeSystems?.values) {
    for (const resource of worker.provider.codeSystems.values()) {
      if (!resource || seenResources.has(resource)) continue;
      seenResources.add(resource);
      registeredCodeSystems.push(resource);
    }
  }

  const providerFactories = [];
  const seenFactories = new Set();
  if (worker.provider?.codeSystemFactories?.values) {
    for (const factory of worker.provider.codeSystemFactories.values()) {
      if (!factory || seenFactories.has(factory)) continue;
      seenFactories.add(factory);
      providerFactories.push(factory);
    }
  }

  return await buildSupplementRegistry({
    inlineResources: worker.additionalResources || [],
    registeredCodeSystems,
    providerFactories,
  });
}

function setupIRAdditionalResources(worker, params) {
  if (!params || !params.parameter) return;

  const inlineResources = [];
  for (const param of params.parameter) {
    worker.deadCheck('setupIRAdditionalResources');
    if (!param.resource) continue;
    const res = worker.wrapRawResource(param.resource);
    if (res) {
      inlineResources.push(res);
    }
  }

  const cacheIdParam = worker.findParameter(params, 'cache-id');
  const cacheId = cacheIdParam ? worker.getParameterValue(cacheIdParam) : null;

  if (cacheId && worker.opContext.resourceCache) {
    if (inlineResources.length > 0) {
      worker.opContext.resourceCache.add(cacheId, inlineResources);
    }
    worker.additionalResources = worker.opContext.resourceCache.get(cacheId);
  } else {
    worker.additionalResources = inlineResources;
  }
}

async function findCodeSystemWithResolvedSupplements(worker, url, version = '', params, kinds = ['complete'], op, nullOk = false, checkVer = false, noVParams = false, supplements = []) {
  if (!url) {
    return null;
  }

  let resolvedVersion = version;
  if (!noVParams) {
    resolvedVersion = worker.determineVersionBase(url, version, params);
  }

  let codeSystemResource = worker.findInAdditionalResources(url, resolvedVersion, 'CodeSystem', !nullOk);
  let provider = null;

  if (codeSystemResource && codeSystemResource.content === 'complete') {
    provider = await worker.provider.createCodeSystemProvider(worker.opContext, codeSystemResource, supplements);
  }

  if (!provider) {
    provider = await worker.provider.getCodeSystemProvider(worker.opContext, url, resolvedVersion, supplements);
  }

  if (!provider && codeSystemResource && kinds.includes(codeSystemResource.content)) {
    provider = await worker.provider.createCodeSystemProvider(worker.opContext, codeSystemResource, supplements);
  }

  if (!provider && !nullOk) {
    if (!resolvedVersion) {
      throw new Issue('error', 'not-found', null, 'UNKNOWN_CODESYSTEM_EXP', worker.i18n.translate('UNKNOWN_CODESYSTEM_EXP', params.FHTTPLanguages, [url]), 'not-found', 422);
    }
    const versions = await worker.listVersions(url);
    if (versions.length === 0) {
      throw new Issue('error', 'not-found', null, 'UNKNOWN_CODESYSTEM_VERSION_EXP_NONE', worker.i18n.translate('UNKNOWN_CODESYSTEM_VERSION_EXP_NONE', params.FHTTPLanguages, [url, resolvedVersion]), 'not-found', 422);
    }
    throw new Issue('error', 'not-found', null, 'UNKNOWN_CODESYSTEM_VERSION_EXP', worker.i18n.translate('UNKNOWN_CODESYSTEM_VERSION_EXP', params.FHTTPLanguages, [url, resolvedVersion, worker.presentVersionList(versions)]), 'not-found', 422);
  }

  if (provider && checkVer) {
    worker.checkVersion(url, provider.version(), params, provider.versionAlgorithm(), op);
  }

  return provider;
}

async function findBaseCodeSystemProvider(worker, url, version = '', params, kinds = ['complete'], op, nullOk = false, checkVer = false, noVParams = false) {
  return await findCodeSystemWithResolvedSupplements(
    worker, url, version, params, kinds, op, nullOk, checkVer, noVParams, []
  );
}

async function resolveSupplementsForIRBaseScope(worker, target, refs, registry = null) {
  const activeRegistry = registry || await buildSupplementRegistryForIR(worker);
  return await resolveSupplementsForBaseScope({ target, refs, registry: activeRegistry });
}

function assertResolvableSupplements(worker, supplementSet, languages = null, statusCode = 422) {
  const missing = new Set((supplementSet?.missingRefs || []).map((ref) => ref?.canonical).filter(Boolean));
  if (missing.size > 0) {
    throw new Issue(
      'error',
      'not-found',
      null,
      'VALUESET_SUPPLEMENT_MISSING',
      worker.i18n.translatePlural(
        missing.size,
        'VALUESET_SUPPLEMENT_MISSING',
        languages || worker.params?.HTTPLanguages || worker.opContext?.langs,
        [[...missing].join(',')]
      ),
      'not-found',
      statusCode
    );
  }
  const unresolved = new Set((supplementSet?.unresolvedRefs || []).map((ref) => ref?.canonical).filter(Boolean));
  const inapplicable = new Set((supplementSet?.inapplicableRefs || []).map((ref) => ref?.canonical).filter(Boolean));
  if (unresolved.size > 0 && inapplicable.size === 0) {
    throw new Issue(
      'error',
      'not-found',
      null,
      'VALUESET_SUPPLEMENT_MISSING',
      worker.i18n.translatePlural(
        unresolved.size,
        'VALUESET_SUPPLEMENT_MISSING',
        languages || worker.params?.HTTPLanguages || worker.opContext?.langs,
        [[...unresolved].join(',')]
      ),
      'not-found',
      statusCode
    );
  }
}

async function materializeSupplementSetOverlaySourcesForIR(worker, supplementSet) {
  return await materializeSupplementSetOverlaySources(supplementSet);
}

async function bindIRScopeForExpansion(worker, provider, supplementSet) {
  return await bindIRScope(provider, supplementSet, {
    resolveValueSet: async (url, version = '') => {
      const vs = await worker.findValueSet(url, version);
      return vs?.jsonObj || vs || null;
    },
  });
}

async function bindIRScopeForOperation(worker, url, version = '', params, kinds = ['complete'], op, nullOk = false, checkVer = false, noVParams = false, statedSupplements = null) {
  if (!url) return null;

  let resolvedVersion = version;
  if (!noVParams) {
    resolvedVersion = worker.determineVersionBase(url, version, params);
  }

  const baseProvider = await findBaseCodeSystemProvider(
    worker, url, resolvedVersion, params, kinds, op, nullOk, checkVer, true
  );
  if (!baseProvider) return null;

  const refs = toSupplementRefs(statedSupplements);
  const targetVersion = resolvedVersion
    || (typeof baseProvider.version === 'function' ? baseProvider.version() : null)
    || null;
  const supplementSet = refs.length > 0
    ? await resolveSupplementsForIRBaseScope(worker, { system: url, version: targetVersion }, refs)
    : null;
  assertResolvableSupplements(worker, supplementSet, params?.HTTPLanguages, 422);
  return await bindIRScope(baseProvider, supplementSet);
}

async function resolveSupplementCodeSystemsForBaseScope(worker, target, statedSupplements, registry = null) {
  const refs = toSupplementRefs(statedSupplements);
  if (refs.length === 0) return [];
  const supplementSet = await resolveSupplementsForIRBaseScope(worker, target, refs, registry);
  assertResolvableSupplements(worker, supplementSet, worker.params?.HTTPLanguages, 422);
  await materializeSupplementSetOverlaySourcesForIR(worker, supplementSet);
  return (supplementSet?.items || [])
    .map(item => item?.overlaySource)
    .filter(codeSystem => codeSystem instanceof CodeSystem);
}

async function createCodeSystemProviderWithSupplementRuntime(worker, codeSystem, statedSupplements) {
  const codeSystemObj = codeSystem instanceof CodeSystem ? codeSystem : new CodeSystem(codeSystem);
  const system = typeof codeSystemObj.system === 'function' ? codeSystemObj.system() : codeSystemObj.url;
  const version = typeof codeSystemObj.version === 'function' ? codeSystemObj.version() : (codeSystemObj.version || null);
  const supplements = await resolveSupplementCodeSystemsForBaseScope(
    worker,
    { system, version },
    statedSupplements
  );
  return await worker.provider.createCodeSystemProvider(worker.opContext, codeSystemObj, supplements);
}

async function findCodeSystemWithSupplementRuntime(worker, url, version = '', params, kinds = ['complete'], op, nullOk = false, checkVer = false, noVParams = false, statedSupplements = null) {
  if (!url) return null;

  let resolvedVersion = version;
  if (!noVParams) {
    resolvedVersion = worker.determineVersionBase(url, version, params);
  }

  const baseProvider = await findBaseCodeSystemProvider(
    worker, url, resolvedVersion, params, kinds, op, nullOk, checkVer, true
  );
  if (!baseProvider) return null;

  if (!statedSupplements || statedSupplements.size === 0) {
    return baseProvider;
  }

  const targetVersion = resolvedVersion
    || (typeof baseProvider.version === 'function' ? baseProvider.version() : null)
    || null;
  const supplementSet = await resolveSupplementsForIRBaseScope(
    worker,
    { system: url, version: targetVersion },
    toSupplementRefs(statedSupplements)
  );
  assertResolvableSupplements(worker, supplementSet, params?.HTTPLanguages, 422);
  if (typeof baseProvider.attachIRSupplements === 'function') {
    await baseProvider.attachIRSupplements(supplementSet);
    return baseProvider;
  }

  await materializeSupplementSetOverlaySourcesForIR(worker, supplementSet);
  const supplements = (supplementSet?.items || [])
    .map(item => item?.overlaySource)
    .filter(codeSystem => codeSystem instanceof CodeSystem);
  return await findCodeSystemWithResolvedSupplements(
    worker, url, targetVersion, params, kinds, op, nullOk, checkVer, true, supplements
  );
}

async function resolveCodeSystemVersionAtDate(worker, url, lockedDate) {
  if (!url || !lockedDate) return null;
  const targetUtc = parseISODatePrefix(lockedDate);
  if (targetUtc == null) return null;

  const byVersion = new Map();
  const factories = worker.provider?.codeSystemFactories?.values
    ? worker.provider.codeSystemFactories.values()
    : [];
  for (const factory of factories) {
    if (!factory || typeof factory.system !== 'function' || factory.system() !== url) continue;
    const version = typeof factory.version === 'function' ? factory.version() : null;
    if (!version) continue;
    const releaseDate = typeof factory.releaseDate === 'function' ? factory.releaseDate() : null;
    const releaseUtc = parseISODatePrefix(releaseDate);
    if (releaseUtc == null) continue;
    const existing = byVersion.get(version);
    if (!existing || existing.utc < releaseUtc) {
      byVersion.set(version, { version, utc: releaseUtc });
    }
  }
  if (byVersion.size > 0) {
    const datedFactories = [...byVersion.values()]
      .sort((a, b) => (a.utc - b.utc) || String(a.version).localeCompare(String(b.version)));
    let best = null;
    for (const row of datedFactories) {
      if (row.utc <= targetUtc) best = row.version;
      else break;
    }
    if (best) return best;
  }

  const versions = await worker.listVersions(url);
  if (!Array.isArray(versions) || versions.length === 0) return null;

  const dated = versions
    .map(version => ({ version, utc: parseVersionDate(version) }))
    .filter(x => x.utc != null)
    .sort((a, b) => (a.utc - b.utc) || String(a.version).localeCompare(String(b.version)));

  if (dated.length === 0) return null;

  let best = null;
  for (const row of dated) {
    if (row.utc <= targetUtc) best = row.version;
    else break;
  }
  return best;
}

module.exports = {
  assertResolvableSupplements,
  bindIRScopeForExpansion,
  bindIRScopeForOperation,
  buildSupplementRegistryForIR,
  createCodeSystemProviderWithSupplementRuntime,
  findBaseCodeSystemProvider,
  findCodeSystemWithResolvedSupplements,
  findCodeSystemWithSupplementRuntime,
  materializeSupplementSetOverlaySourcesForIR,
  resolveSupplementCodeSystemsForBaseScope,
  resolveSupplementsForIRBaseScope,
  resolveCodeSystemVersionAtDate,
  setupIRAdditionalResources,
};
