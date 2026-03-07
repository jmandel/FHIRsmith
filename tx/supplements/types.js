'use strict';

const { VersionUtilities } = require('../../library/version-utilities');
const { CodeSystem } = require('../library/codesystem');

function cleanString(value) {
  const s = String(value || '').trim();
  return s || null;
}

function canonicalOf(url, version = null) {
  const cleanUrl = cleanString(url);
  const cleanVersion = cleanString(version);
  if (!cleanUrl) return null;
  return cleanVersion ? `${cleanUrl}|${cleanVersion}` : cleanUrl;
}

function parseCanonical(canonical) {
  const clean = cleanString(canonical);
  if (!clean) return { canonical: null, url: null, version: null };
  const bar = clean.indexOf('|');
  if (bar < 0) {
    return { canonical: clean, url: clean, version: null };
  }
  const url = cleanString(clean.slice(0, bar));
  const version = cleanString(clean.slice(bar + 1));
  return { canonical: canonicalOf(url, version), url, version };
}

function makeBaseScope(system, version = null) {
  return {
    system: cleanString(system),
    version: cleanString(version),
  };
}

function makeSupplementRef(canonical, source = 'useSupplement', order = 0) {
  const parsed = parseCanonical(canonical);
  return {
    canonical: parsed.canonical,
    url: parsed.url,
    version: parsed.version,
    source,
    order,
  };
}

function supplementRefKey(ref) {
  return cleanString(ref?.canonical);
}

function dedupeSupplementRefs(refs) {
  const out = [];
  const seen = new Set();
  for (const raw of refs || []) {
    const ref = raw?.url ? raw : makeSupplementRef(raw?.canonical || raw, raw?.source, raw?.order);
    const key = supplementRefKey(ref);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  out.sort((a, b) => (a.order - b.order) || String(a.canonical).localeCompare(String(b.canonical)));
  return out;
}

function isSupplementCodeSystem(resource) {
  return resource instanceof CodeSystem
    && resource.resourceType === 'CodeSystem'
    && resource.jsonObj?.content === 'supplement'
    && !!cleanString(resource.jsonObj?.supplements);
}

function descriptorFromCodeSystem(codeSystem, sourceKind = 'inline') {
  if (!isSupplementCodeSystem(codeSystem)) return null;
  const target = parseCanonical(codeSystem.jsonObj.supplements);
  return {
    canonical: canonicalOf(codeSystem.url, codeSystem.version),
    url: cleanString(codeSystem.url),
    version: cleanString(codeSystem.version),
    versionAlgorithm: typeof codeSystem.versionAlgorithm === 'function'
      ? cleanString(codeSystem.versionAlgorithm())
      : null,
    targetSystem: target.url,
    targetVersion: target.version,
    sourceKind,
    displayName: cleanString(codeSystem.title) || cleanString(codeSystem.name),
  };
}

function requestMatchesDescriptor(ref, descriptor) {
  if (!ref?.url || !descriptor?.url) return false;
  if (ref.url !== descriptor.url) return false;
  if (!ref.version) return true;
  if (!descriptor.version) return false;
  const algo = descriptor.versionAlgorithm || null;
  return VersionUtilities.versionMatchesByAlgorithm(ref.version, descriptor.version, algo)
    || ref.version === descriptor.version;
}

function targetMatchesDescriptor(target, descriptor) {
  if (!target?.system || !descriptor?.targetSystem) return false;
  if (target.system !== descriptor.targetSystem) return false;
  if (!descriptor.targetVersion) return true;
  if (!target.version) return false;
  return descriptor.targetVersion === target.version
    || VersionUtilities.versionMatches(descriptor.targetVersion, target.version);
}

function descriptorKey(descriptor) {
  if (!descriptor) return null;
  return [
    descriptor.canonical || '',
    descriptor.targetSystem || '',
    descriptor.targetVersion || '',
    descriptor.sourceKind || '',
  ].join('\x00');
}

module.exports = {
  canonicalOf,
  cleanString,
  dedupeSupplementRefs,
  descriptorFromCodeSystem,
  descriptorKey,
  isSupplementCodeSystem,
  makeBaseScope,
  makeSupplementRef,
  parseCanonical,
  requestMatchesDescriptor,
  supplementRefKey,
  targetMatchesDescriptor,
};
