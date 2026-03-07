'use strict';

const { canonicalOf, cleanString } = require('./types');
const { readSupplementSidecarCodeSystem, readSupplementSidecarMeta } = require('./sqlite-sidecar');

function descriptorFromSqliteSidecarMeta(meta) {
  if (!meta?.url || !meta?.target_system) return null;
  return {
    canonical: canonicalOf(meta.url, meta.version || null),
    url: cleanString(meta.url),
    version: cleanString(meta.version),
    versionAlgorithm: null,
    targetSystem: cleanString(meta.target_system),
    targetVersion: cleanString(meta.target_version),
    sourceKind: 'sqlite-native',
    displayName: cleanString(meta.title) || cleanString(meta.name),
  };
}

function normalizeSqliteSidecarSource(source) {
  if (!source) return null;
  if (typeof source === 'string') {
    return { dbPath: source, precedence: 30, meta: null };
  }
  if (typeof source === 'object' && source.dbPath) {
    return {
      dbPath: String(source.dbPath),
      precedence: Number.isFinite(source.precedence) ? Number(source.precedence) : 30,
      meta: source.meta || null,
    };
  }
  return null;
}

function createSqliteSidecarRegistryEntry(source) {
  const normalized = normalizeSqliteSidecarSource(source);
  if (!normalized?.dbPath) return null;
  const meta = normalized.meta || readSupplementSidecarMeta(normalized.dbPath);
  if (!meta) return null;
  const descriptor = descriptorFromSqliteSidecarMeta(meta);
  if (!descriptor) return null;
  return {
    descriptor,
    precedence: normalized.precedence,
    materializeCodeSystem: async () => readSupplementSidecarCodeSystem(normalized.dbPath),
    materializeNativeBinding: async () => ({
      kind: 'sqlite-sidecar',
      dbPath: normalized.dbPath,
      meta,
    }),
  };
}

module.exports = {
  createSqliteSidecarRegistryEntry,
  descriptorFromSqliteSidecarMeta,
  normalizeSqliteSidecarSource,
};
