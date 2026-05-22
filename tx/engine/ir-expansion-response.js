'use strict';

const crypto = require('crypto');
const { decorateCandidatesByBoundScope } = require('./ir-bound-scope');
const { walkIR } = require('./ir-traversal');
const { getValueName } = require('../../library/utilities');

const KNOWN_EXPANSION_PROPERTY_URIS = new Map([
  ['definition', 'http://hl7.org/fhir/concept-properties#definition'],
]);

function serializeExpansionProperty(prop) {
  if (!prop?.code) return null;

  const typedName = getValueName(prop);
  if (typedName) {
    return {
      code: prop.code,
      [typedName]: prop[typedName],
    };
  }

  if (prop.value && typeof prop.value === 'object' && (prop.value.system || prop.value.code)) {
    return {
      code: prop.code,
      valueCoding: prop.value,
    };
  }

  if (prop.value !== undefined && prop.value !== null) {
    return {
      code: prop.code,
      valueString: String(prop.value),
    };
  }

  return null;
}

function mergeExpansionPropertyDefinition(defs, prop) {
  const code = String(prop?.code || '').trim();
  if (!code) return;
  const next = defs.get(code) || { code };
  const uri = prop?.uri || prop?.definition?.uri || KNOWN_EXPANSION_PROPERTY_URIS.get(code) || null;
  const description = prop?.definition?.description || prop?.definition?.display || null;
  const type = prop?.definition?.type || null;
  if (uri && !next.uri) next.uri = uri;
  if (description && !next.description) next.description = description;
  if (type && !next.type) next.type = type;
  defs.set(code, next);
}

function enrichCandidate(c, resolved) {
  const emitVersion = !!resolved.version;
  const containsVersion = emitVersion ? (resolved.provVersion || resolved.version) : null;
  const entry = {
    system: resolved.system,
    version: containsVersion,
    code: c.code,
    display: c.display,
    definition: c.definition,
    active: c.active,
    conceptId: c.conceptId,
    _boundScope: resolved.boundScope,
    _composeOverrideVersion: resolved.provVersion || resolved.version || null,
  };
  if (c._parentCode) entry._parentCode = c._parentCode;
  return entry;
}

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

async function decorateCandidates(candidates, opts = {}) {
  await decorateCandidatesByBoundScope(candidates, opts);
}

async function renderIRExpansionResult(execution, resolved, opts = {}) {
  const {
    offset = 0,
    count = 1000,
    includeDesignations = false,
    properties = [],
    designations = [],
    excludeNested = false,
    warnings = [],
    usedSystems = new Set(),
    usedValueSets = new Set(),
    providerMeta = [],
    planText = null,
  } = opts;

  const {
    candidates: paged,
    total,
    deferredTotal,
  } = execution;

  const composeOverrides = collectComposeOverrides(resolved);

  await decorateCandidates(paged, { includeDesignations, properties });
  applyComposeOverrides(paged, composeOverrides, includeDesignations);

  const expansionPropertyDefs = new Map();
  const contains = paged.map(c => {
    const entry = {
      system: c.system,
      code: c.code,
    };
    if (c.version) entry.version = c.version;
    if (c.display) entry.display = c.display;
    if (c.active === false) entry.inactive = true;

    if (includeDesignations) {
      let allDesigs = [];
      if (c._designations?.length > 0) allDesigs.push(...c._designations);
      if (c._composeDesignations?.length > 0) allDesigs.push(...c._composeDesignations);
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

    if (c._extensions?.length > 0) {
      if (!entry.extension) entry.extension = [];
      entry.extension.push(...c._extensions);
    }

    if (c._properties?.length > 0) {
      for (const prop of c._properties) {
        mergeExpansionPropertyDefinition(expansionPropertyDefs, prop);
        const serialized = serializeExpansionProperty(prop);
        if (!serialized) continue;
        if (!entry.property) entry.property = [];
        entry.property.push(serialized);
      }
    }

    return entry;
  });

  const canNest = !excludeNested && offset === 0
    && (count < 0 || count >= (total ?? deferredTotal ?? contains.length));
  if (canNest && paged.some(c => c._parentCode)) {
    nestContains(contains, paged);
  }

  const usedSupplements = new Set();
  for (const r of resolved) {
    const supps = typeof r.boundScope?.usedSupplements === 'function'
      ? r.boundScope.usedSupplements()
      : [];
    for (const s of supps) usedSupplements.add(s);
  }

  return {
    expansion: {
      total,
      offset: offset > 0 ? offset : undefined,
      contains,
      property: expansionPropertyDefs.size > 0 ? [...expansionPropertyDefs.values()] : undefined,
      usedSystems: [...usedSystems],
      usedValueSets: [...usedValueSets],
      usedSupplements: [...usedSupplements],
      providerMeta,
      valueSetMeta: execution.valueSetMeta || [],
      unclosedMessages: execution.unclosedMessages,
      limitedExpansion: execution.limitedExpansion,
      tooCostly: execution.tooCostly,
    },
    warnings,
    debug: planText ? { planText } : undefined,
  };
}

function collectComposeOverrides(resolvedList) {
  const overrides = new Map();
  for (const r of resolvedList) {
    walkIR(r.subtree, (node) => {
      if (node.kind !== 'selector' || node.shape !== 'concept' || !node.conceptCodes) return;
      const sys = node.system || r.system;
      const ver = node.version || r.provVersion || r.version || null;
      for (const cc of node.conceptCodes) {
        if (!cc.code) continue;
        const key = composeOverrideKey(sys, ver, cc.code);
        if (cc.display || (cc.designation && cc.designation.length > 0)) {
          overrides.set(key, {
            display: cc.display || null,
            designation: cc.designation || [],
          });
        }
      }
    });
  }
  return overrides;
}

function composeOverrideKey(system, version, code) {
  return `${system || ''}\x00${version || ''}\x00${code || ''}`;
}

function applyComposeOverrides(candidates, overrides, includeDesignations) {
  if (!overrides || overrides.size === 0) return;
  for (const c of candidates) {
    const key = composeOverrideKey(
      c.system,
      c._composeOverrideVersion ?? c.version ?? null,
      c.code,
    );
    const ov = overrides.get(key);
    if (!ov) continue;
    if (ov.display) {
      c.display = ov.display;
    }
    if (includeDesignations && ov.designation && ov.designation.length > 0) {
      if (!c._composeDesignations) c._composeDesignations = [];
      c._composeDesignations.push(...ov.designation);
    }
  }
}

function addParamIfAbsent(exp, name, valueUri) {
  if (!exp.parameter) exp.parameter = [];
  if (exp.parameter.some(p => p.name === name && p.valueUri === valueUri)) return;
  exp.parameter.push({ name, valueUri });
}

function filterDesignations(desigs, designationSpecs) {
  if (!designationSpecs || designationSpecs.length === 0) return desigs;
  return desigs.filter(d => {
    for (const spec of designationSpecs) {
      const [sys, code] = spec.split('|');
      if (d.use && d.use.system === sys && d.use.code === code) return true;
      if (sys === 'urn:ietf:bcp:47' && d.language && d.language === code) return true;
    }
    return false;
  });
}

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
  const pagingUsed = (params.offset != null && params.offset >= 0)
    || (params.count != null && params.count >= 0);
  const effectiveOffset = params.offset != null
    ? Math.max(params.offset, 0)
    : 0;

  if (expansion.total != null) exp.total = expansion.total;
  if (expansion.offset != null) exp.offset = Math.max(expansion.offset, 0);
  else if (pagingUsed) exp.offset = effectiveOffset;
  if (expansion.contains && expansion.contains.length > 0) exp.contains = expansion.contains;
  if (expansion.property && expansion.property.length > 0) exp.property = expansion.property;

  exp.parameter = [];
  if (pagingUsed) exp.parameter.push({ name: 'offset', valueInteger: effectiveOffset });
  if (params.count != null && params.count >= 0) exp.parameter.push({ name: 'count', valueInteger: params.count });
  if (params.activeOnly) exp.parameter.push({ name: 'activeOnly', valueBoolean: true });
  if (params.includeDesignations) exp.parameter.push({ name: 'includeDesignations', valueBoolean: true });
  if (params.filter) exp.parameter.push({ name: 'filter', valueString: params.filter });
  if (params.displayLanguage) exp.parameter.push({ name: 'displayLanguage', valueCode: params.displayLanguage });
  if (params.designations?.length > 0) {
    for (const d of params.designations) exp.parameter.push({ name: 'designation', valueString: d });
  }
  if (params.properties?.length > 0) {
    for (const p of params.properties) exp.parameter.push({ name: 'property', valueString: p });
  }

  if (expansion.usedSystems) {
    for (const sys of expansion.usedSystems) exp.parameter.push({ name: 'used-codesystem', valueUri: sys });
  }
  if (expansion.usedValueSets) {
    for (const vs of expansion.usedValueSets) addParamIfAbsent(exp, 'used-valueset', vs);
  }
  if (expansion.usedSupplements) {
    for (const s of expansion.usedSupplements) addParamIfAbsent(exp, 'used-supplement', s);
  }

  if (expansion.providerMeta) {
    const sourceVS = params.sourceVS || vsJson;
    const sourceStatus = sourceVS.status || '';
    const sourceStandardsStatus = sourceVS.extension?.find(
      e => e.url === 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'
    )?.valueCode || '';
    const sourceExperimental = sourceVS.experimental || false;

    for (const meta of expansion.providerMeta) {
      if (meta.contentMode === 'fragment') {
        if (!exp.extension) exp.extension = [];
        const unclosedUrl = 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed';
        if (!exp.extension.some(e => e.url === unclosedUrl)) {
          exp.extension.push({ url: unclosedUrl, valueBoolean: true });
        }
      }

      if (meta.standardsStatus === 'deprecated') {
        addParamIfAbsent(exp, 'warning-deprecated', meta.vurl);
      } else if (meta.standardsStatus === 'withdrawn') {
        addParamIfAbsent(exp, 'warning-withdrawn', meta.vurl);
      } else if (meta.status === 'retired') {
        addParamIfAbsent(exp, 'warning-retired', meta.vurl);
      } else if (meta.experimental && !sourceExperimental) {
        addParamIfAbsent(exp, 'warning-experimental', meta.vurl);
      } else if (
        (meta.status === 'draft' || meta.standardsStatus === 'draft')
        && !(sourceStatus === 'draft' || sourceStandardsStatus === 'draft')
      ) {
        addParamIfAbsent(exp, 'warning-draft', meta.vurl);
      }
    }
  }

  if (expansion.valueSetMeta?.length > 0) {
    const sourceVS = params.sourceVS || vsJson;
    const sourceStatus = sourceVS.status || '';
    const sourceStandardsStatus = sourceVS.extension?.find(
      e => e.url === 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'
    )?.valueCode || '';
    const sourceExperimental = sourceVS.experimental || false;

    for (const meta of expansion.valueSetMeta) {
      if (meta.standardsStatus === 'deprecated') {
        addParamIfAbsent(exp, 'warning-deprecated', meta.vurl);
      } else if (meta.standardsStatus === 'withdrawn') {
        addParamIfAbsent(exp, 'warning-withdrawn', meta.vurl);
      } else if (meta.status === 'retired') {
        addParamIfAbsent(exp, 'warning-retired', meta.vurl);
      } else if (meta.experimental && !sourceExperimental) {
        addParamIfAbsent(exp, 'warning-experimental', meta.vurl);
      } else if (
        (meta.status === 'draft' || meta.standardsStatus === 'draft')
        && !(sourceStatus === 'draft' || sourceStandardsStatus === 'draft')
      ) {
        addParamIfAbsent(exp, 'warning-draft', meta.vurl);
      }
    }
  }

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
  }

  if (expansion.unclosedMessages?.length > 0) {
    if (!exp.extension) exp.extension = [];
    const unclosedUrl = 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed';
    if (!exp.extension.some(e => e.url === unclosedUrl && e.valueBoolean === true)) {
      exp.extension.push({ url: unclosedUrl, valueBoolean: true });
    }
  }

  result.expansion = exp;
  return result;
}

module.exports = {
  addParamIfAbsent,
  appendAll,
  applyComposeOverrides,
  buildExpandedValueSet,
  collectComposeOverrides,
  decorateCandidates,
  filterDesignations,
  flattenCandidates,
  mergeExpansionPropertyDefinition,
  nestContains,
  renderIRExpansionResult,
  serializeExpansionProperty,
};
