'use strict';

const { getValueDT, getValueName, getValuePrimitive } = require('../../library/utilities');

const KNOWN_EXPANSION_EXTENSION_PROPERTIES = Object.freeze([
  {
    extensionUrl: 'http://hl7.org/fhir/StructureDefinition/codesystem-label',
    code: 'label',
    uri: 'http://hl7.org/fhir/concept-properties#label',
    type: 'string',
  },
  {
    extensionUrl: 'http://hl7.org/fhir/StructureDefinition/valueset-label',
    code: 'label',
    uri: 'http://hl7.org/fhir/concept-properties#label',
    type: 'string',
  },
  {
    extensionUrl: 'http://hl7.org/fhir/StructureDefinition/codesystem-conceptOrder',
    code: 'order',
    uri: 'http://hl7.org/fhir/concept-properties#order',
    type: 'decimal',
  },
  {
    extensionUrl: 'http://hl7.org/fhir/StructureDefinition/valueset-conceptOrder',
    code: 'order',
    uri: 'http://hl7.org/fhir/concept-properties#order',
    type: 'decimal',
  },
  {
    extensionUrl: 'http://hl7.org/fhir/StructureDefinition/itemWeight',
    code: 'weight',
    uri: 'http://hl7.org/fhir/concept-properties#itemWeight',
    type: 'decimal',
  },
  {
    extensionUrl: 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
    code: 'status',
    uri: 'http://hl7.org/fhir/concept-properties#status',
    type: 'code',
  },
]);

const KNOWN_PROPERTY_ALIASES = new Map();
for (const def of KNOWN_EXPANSION_EXTENSION_PROPERTIES) {
  for (const key of [def.extensionUrl, def.code, def.uri]) {
    if (!key) continue;
    let aliases = KNOWN_PROPERTY_ALIASES.get(key);
    if (!aliases) {
      aliases = new Set();
      KNOWN_PROPERTY_ALIASES.set(key, aliases);
    }
    aliases.add(def.extensionUrl);
    aliases.add(def.code);
    aliases.add(def.uri);
  }
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function addKnownAliases(target, value) {
  const key = String(value || '').trim();
  if (!key) return;
  target.add(key);
  const aliases = KNOWN_PROPERTY_ALIASES.get(key);
  if (!aliases) return;
  for (const alias of aliases) target.add(alias);
}

function expansionPropertyAliases(value) {
  const aliases = new Set();
  if (typeof value === 'string') {
    addKnownAliases(aliases, value);
    return aliases;
  }
  if (!value || typeof value !== 'object') return aliases;
  addKnownAliases(aliases, value.code);
  addKnownAliases(aliases, value.uri);
  addKnownAliases(aliases, value.definition?.uri);
  addKnownAliases(aliases, value.sourceExtensionUrl);
  return aliases;
}

function requestedExpansionPropertyMatches(prop, requestedProperties = []) {
  if ((requestedProperties || []).includes('*')) return true;
  const propAliases = expansionPropertyAliases(prop);
  if (propAliases.size === 0) return false;
  return (requestedProperties || []).some(requested => {
    const requestedAliases = expansionPropertyAliases(requested);
    for (const alias of requestedAliases) {
      if (propAliases.has(alias)) return true;
    }
    return false;
  });
}

function normalizeKnownExpansionExtension(ext) {
  const url = String(ext?.url || '').trim();
  if (!url) return null;
  const def = KNOWN_EXPANSION_EXTENSION_PROPERTIES.find(item => item.extensionUrl === url);
  if (!def) return null;

  const valueName = getValueName(ext);
  if (!valueName) return null;

  const primitive = getValuePrimitive(ext);
  const typed = getValueDT(ext);
  const typedValue = cloneJson(ext[valueName]);
  const value = primitive !== null ? primitive : (typed != null ? cloneJson(typed) : typedValue);

  return {
    code: def.code,
    uri: def.uri,
    sourceExtensionUrl: def.extensionUrl,
    definition: {
      uri: def.uri,
      type: def.type,
    },
    [valueName]: typedValue,
    ...(value !== undefined ? { value } : {}),
  };
}

module.exports = {
  expansionPropertyAliases,
  normalizeKnownExpansionExtension,
  requestedExpansionPropertyMatches,
};
