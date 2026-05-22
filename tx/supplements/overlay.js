'use strict';

const { CodeSystem } = require('../library/codesystem');
const {
  expansionPropertyAliases,
  normalizeKnownExpansionExtension,
  requestedExpansionPropertyMatches,
} = require('../library/expansion-properties');
const { getValueName, getValuePrimitive, getValueDT } = require('../../library/utilities');

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function valueFromProperty(prop) {
  if (!prop || typeof prop !== 'object') return null;
  const primitive = getValuePrimitive(prop);
  if (primitive !== null) return primitive;
  const typed = getValueDT(prop);
  if (typed != null) return cloneJson(typed);
  const valueName = getValueName(prop);
  if (!valueName) return null;
  return cloneJson(prop[valueName]);
}

function makeDisplayDesignation(concept, supplement) {
  if (!concept?.display) return null;
  return {
    language: supplement?.jsonObj?.language || null,
    use: CodeSystem.makeUseForDisplay(),
    value: concept.display,
  };
}

function buildSupplementOverlay(supplementSet) {
  const byCode = new Map();
  const propertyCodes = new Set();
  for (const item of supplementSet?.items || []) {
    const supplement = item?.overlaySource;
    if (!(supplement instanceof CodeSystem)) continue;
    for (const def of supplement.property || supplement.jsonObj?.property || []) {
      if (def?.code) propertyCodes.add(String(def.code));
    }
    for (const concept of supplement.getAllConcepts?.() || []) {
      if (!concept?.code) continue;
      let entry = byCode.get(concept.code);
      if (!entry) {
        entry = { designations: [], properties: [], extensions: [] };
        byCode.set(concept.code, entry);
      }
      const displayDesignation = makeDisplayDesignation(concept, supplement);
      if (displayDesignation) entry.designations.push(displayDesignation);
      for (const designation of concept.designation || []) {
        entry.designations.push({
          language: designation.language || null,
          use: cloneJson(designation.use || null),
          value: designation.value,
          extension: designation.extension ? cloneJson(designation.extension) : undefined,
        });
      }
      for (const prop of concept.property || []) {
        const value = valueFromProperty(prop);
        if (value == null) continue;
        for (const alias of expansionPropertyAliases(prop)) propertyCodes.add(alias);
        entry.properties.push({
          ...cloneJson(prop),
          code: prop.code,
          value,
        });
      }
      for (const ext of concept.extension || []) {
        const normalized = normalizeKnownExpansionExtension(ext);
        if (normalized) {
          for (const alias of expansionPropertyAliases(normalized)) propertyCodes.add(alias);
          entry.properties.push(normalized);
        } else {
          entry.extensions.push(cloneJson(ext));
        }
      }
    }
  }
  return { byCode, propertyCodes };
}

function overlayTouchesProperty(overlay, property) {
  if (!overlay?.propertyCodes || overlay.propertyCodes.size === 0) return false;
  for (const alias of expansionPropertyAliases(property)) {
    if (overlay.propertyCodes.has(alias)) return true;
  }
  return false;
}

function mergeSupplementOverlayIntoCandidates(candidates, overlay, opts = {}) {
  const { includeDesignations = false, properties = [] } = opts;
  if (!overlay?.byCode || overlay.byCode.size === 0) return;
  const wantAllProperties = properties.includes('*');
  const wantExtensions = properties.length > 0;

  for (const candidate of candidates || []) {
    const extra = overlay.byCode.get(candidate.code);
    if (!extra) continue;

    if (includeDesignations && extra.designations.length > 0) {
      if (!candidate._designations) candidate._designations = [];
      candidate._designations.push(...extra.designations.map(cloneJson));
    }

    if ((wantAllProperties || properties.length > 0) && extra.properties.length > 0) {
      if (!candidate._properties) candidate._properties = [];
      for (const prop of extra.properties) {
        if (wantAllProperties || requestedExpansionPropertyMatches(prop, properties)) {
          candidate._properties.push(cloneJson(prop));
        }
      }
    }

    if (wantExtensions && extra.extensions.length > 0) {
      if (!candidate._extensions) candidate._extensions = [];
      candidate._extensions.push(...extra.extensions.map(cloneJson));
    }
  }
}

module.exports = {
  buildSupplementOverlay,
  mergeSupplementOverlayIntoCandidates,
  overlayTouchesProperty,
  valueFromProperty,
};
