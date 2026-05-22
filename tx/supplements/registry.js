'use strict';

const { CodeSystem } = require('../library/codesystem');
const {
  descriptorFromCodeSystem,
  descriptorKey,
  isSupplementCodeSystem,
  makeSupplementRef,
  requestMatchesDescriptor,
} = require('./types');
const { createSqliteSidecarRegistryEntry } = require('./source-sqlite');

function cloneCodeSystem(codeSystem) {
  return new CodeSystem(JSON.parse(JSON.stringify(codeSystem.jsonObj)), codeSystem.fhirVersion || 'R5');
}

function normalizeCodeSystem(codeSystem) {
  if (codeSystem instanceof CodeSystem) return codeSystem;
  if (codeSystem && codeSystem.resourceType === 'CodeSystem') {
    return new CodeSystem(codeSystem);
  }
  return null;
}

function createSupplementRegistry() {
  return {
    entries: [],
    _keys: new Set(),
  };
}

function addCodeSystem(registry, codeSystem, sourceKind = 'registered-codesystem', precedence = 10, materializeCodeSystem = null) {
  if (!registry) return registry;
  const normalized = normalizeCodeSystem(codeSystem);
  if (!(normalized instanceof CodeSystem)) return registry;
  const descriptor = descriptorFromCodeSystem(normalized, sourceKind);
  if (!descriptor) return registry;
  const key = `${descriptorKey(descriptor)}\x00${precedence}`;
  if (registry._keys.has(key)) return registry;
  registry._keys.add(key);
  registry.entries.push({
    descriptor,
    precedence,
    materializeCodeSystem: materializeCodeSystem || (async () => normalized),
    materializeNativeBinding: null,
  });
  return registry;
}

function addSqliteSidecars(registry, sources = []) {
  for (const source of sources || []) {
    const entry = createSqliteSidecarRegistryEntry(source);
    if (!entry) continue;
    const key = `${descriptorKey(entry.descriptor)}\x00${entry.precedence}`;
    if (registry._keys.has(key)) continue;
    registry._keys.add(key);
    registry.entries.push(entry);
  }
  return registry;
}

function addInlineCodeSystems(registry, resources = []) {
  for (const resource of resources || []) {
    addCodeSystem(registry, resource, 'inline', 0);
  }
  return registry;
}

function addRegisteredCodeSystems(registry, resources = []) {
  for (const resource of resources || []) {
    addCodeSystem(registry, resource, 'registered-codesystem', 10);
  }
  return registry;
}

async function addFactorySupplements(registry, factories = []) {
  const seen = new Set();
  for (const factory of factories || []) {
    if (!factory || seen.has(factory)) continue;
    seen.add(factory);
    if (typeof factory.registerSupplements !== 'function') continue;
    const registered = await factory.registerSupplements();
    for (const supplement of registered || []) {
      if (!(supplement instanceof CodeSystem) || !isSupplementCodeSystem(supplement)) continue;
      addCodeSystem(registry, supplement, 'registered-codesystem', 20, async () => {
        const resolved = cloneCodeSystem(supplement);
        if (typeof factory.fillOutSupplement === 'function') {
          await factory.fillOutSupplement(resolved);
          if (typeof resolved.buildMaps === 'function') {
            resolved.buildMaps();
          }
        }
        return resolved;
      });
    }
  }
  return registry;
}

async function addFactorySqliteSupplements(registry, factories = []) {
  const seen = new Set();
  for (const factory of factories || []) {
    if (!factory || seen.has(factory)) continue;
    seen.add(factory);
    if (typeof factory.registerSqliteSupplements !== 'function') continue;
    const registered = await factory.registerSqliteSupplements();
    addSqliteSidecars(registry, registered || []);
  }
  return registry;
}

function listDescriptors(registry, targetSystem = null) {
  return (registry?.entries || [])
    .filter(entry => !targetSystem || entry.descriptor.targetSystem === targetSystem)
    .map(entry => entry.descriptor);
}

function findCandidates(registry, ref) {
  const request = ref?.url ? ref : makeSupplementRef(ref);
  return (registry?.entries || []).filter(entry => requestMatchesDescriptor(request, entry.descriptor));
}

async function buildSupplementRegistry({
  inlineResources = [],
  registeredCodeSystems = [],
  providerFactories = [],
  sqliteSidecars = [],
} = {}) {
  const registry = createSupplementRegistry();
  addInlineCodeSystems(registry, inlineResources);
  addRegisteredCodeSystems(registry, registeredCodeSystems);
  addSqliteSidecars(registry, sqliteSidecars);
  await addFactorySupplements(registry, providerFactories);
  await addFactorySqliteSupplements(registry, providerFactories);
  return registry;
}

module.exports = {
  addCodeSystem,
  addFactorySupplements,
  addFactorySqliteSupplements,
  addInlineCodeSystems,
  addRegisteredCodeSystems,
  addSqliteSidecars,
  buildSupplementRegistry,
  createSupplementRegistry,
  findCandidates,
  listDescriptors,
};
