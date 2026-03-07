'use strict';

const crypto = require('crypto');
const { buildSupplementOverlay, mergeSupplementOverlayIntoCandidates } = require('../supplements/overlay');
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

function attachPropertyDefinition(prop, propertyDefsByCode) {
  if (!prop || typeof prop !== 'object') return prop;
  if (!propertyDefsByCode || propertyDefsByCode.size === 0) return prop;
  const def = propertyDefsByCode.get(String(prop.code || ''));
  if (!def) return prop;
  if (prop.definition?.type && prop.definition?.description && prop.definition?.uri) return prop;
  return {
    ...prop,
    definition: {
      ...(def.uri ? { uri: def.uri } : {}),
      ...(def.description ? { description: def.description } : {}),
      ...(def.display ? { display: def.display } : {}),
      ...(def.type ? { type: def.type } : {}),
      ...(prop.definition || {}),
    },
  };
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
    _provider: resolved.provider,
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
  const { includeDesignations = false, properties = [] } = opts;
  if (!includeDesignations && properties.length === 0) return;

  const byProvider = new Map();
  for (const c of candidates) {
    if (!c._provider) continue;
    if (!byProvider.has(c._provider)) byProvider.set(c._provider, []);
    byProvider.get(c._provider).push(c);
  }

  for (const [provider, provCandidates] of byProvider) {
    const propertyDefsByCode = typeof provider.propertyDefinitions === 'function'
      ? new Map((provider.propertyDefinitions() || []).map(def => [String(def.code || ''), def]))
      : new Map();

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

    if (!provider.bulkDesignations && typeof provider.designations === 'function' && includeDesignations) {
      for (const c of provCandidates) {
        const ctx = c._context || c.code;
        if (!ctx) continue;
        const collector = makeDesignationCollector();
        try {
          await provider.designations(ctx, collector);
        } catch {
          continue;
        }
        c._designations = collector.result();
      }
    }

    if (typeof provider.bulkProperties === 'function' && properties.length > 0) {
      const conceptIds = provCandidates.filter(c => c.conceptId).map(c => c.conceptId);
      const propMap = provider.bulkProperties(conceptIds);
      const extMap = typeof provider.bulkExtensions === 'function'
        ? provider.bulkExtensions(conceptIds)
        : new Map();

      for (const c of provCandidates) {
        const allProps = propMap.get(c.conceptId) || [];
        c._properties = allProps
          .filter(p => properties.includes(p.code) || properties.includes('*'))
          .map(p => attachPropertyDefinition(p, propertyDefsByCode));

        if (properties.includes('definition') && c.definition) {
          c._properties.push({ code: 'definition', value: c.definition });
        }
        const exts = extMap.get(c.conceptId) || [];
        if (exts.length > 0) {
          if (!c._extensions) c._extensions = [];
          c._extensions.push(...exts);
        }
      }
    } else if (properties.length > 0) {
      for (const c of provCandidates) {
        if (!c._properties) c._properties = [];
        if (properties.includes('definition') && c.definition) {
          c._properties.push({ code: 'definition', value: c.definition });
        }
        const ctx = c._context || c.code;
        if (typeof provider.properties === 'function' && ctx) {
          try {
            const props = await provider.properties(ctx);
            if (props?.length > 0) {
              for (const p of props) {
                if (properties.includes(p.code) || properties.includes('*')) {
                  c._properties.push(attachPropertyDefinition(p, propertyDefsByCode));
                }
              }
            }
          } catch {
            // skip
          }
        }
        if (typeof provider.extensions === 'function' && ctx) {
          try {
            const exts = await provider.extensions(ctx);
            if (exts?.length > 0) {
              if (!c._extensions) c._extensions = [];
              c._extensions.push(...exts);
            }
          } catch {
            // skip
          }
        }
      }
    }

    const supplementSet = provider?._irSupplementSet || null;
    if (supplementSet?.items?.length > 0 && provider?._irAllSupplementsNativeBound !== true) {
      const overlay = buildSupplementOverlay(supplementSet);
      mergeSupplementOverlayIntoCandidates(provCandidates, overlay, {
        includeDesignations,
        properties,
      });
    }
  }
}

function collectComposeOverrides(resolvedList) {
  const overrides = new Map();
  for (const r of resolvedList) {
    walkIR(r.subtree, r.system, r.provVersion || r.version || null, overrides);
  }
  return overrides;
}

function composeOverrideKey(system, version, code) {
  return `${system || ''}\x00${version || ''}\x00${code || ''}`;
}

function walkIR(node, system, version, overrides) {
  if (!node) return;
  if (node.kind === 'selector' && node.shape === 'concept' && node.conceptCodes) {
    const sys = node.system || system;
    const ver = node.version || version || null;
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
  }
  if (node.items) for (const item of node.items) walkIR(item, system, version, overrides);
  if (node.left) walkIR(node.left, system, version, overrides);
  if (node.right) walkIR(node.right, system, version, overrides);
  if (node.resolved) walkIR(node.resolved, system, version, overrides);
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

  if (expansion.total != null) exp.total = expansion.total;
  if (expansion.offset != null) exp.offset = expansion.offset;
  if (expansion.contains && expansion.contains.length > 0) exp.contains = expansion.contains;
  if (expansion.property && expansion.property.length > 0) exp.property = expansion.property;

  exp.parameter = [];
  if (params.offset != null && params.offset > 0) exp.parameter.push({ name: 'offset', valueInteger: params.offset });
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
    for (const msg of expansion.unclosedMessages) {
      if (!exp.extension.some(e => e.url === unclosedUrl && e.valueString === msg)) {
        exp.extension.push({ url: unclosedUrl, valueString: msg });
      }
    }
  }

  result.expansion = exp;
  return result;
}

module.exports = {
  addParamIfAbsent,
  appendAll,
  applyComposeOverrides,
  attachPropertyDefinition,
  buildExpandedValueSet,
  collectComposeOverrides,
  decorateCandidates,
  filterDesignations,
  flattenCandidates,
  mergeExpansionPropertyDefinition,
  nestContains,
  serializeExpansionProperty,
};
