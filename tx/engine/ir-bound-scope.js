'use strict';

const { wrapWithLegacyIR } = require('./legacy-ir-adapter');
const { wrapIRProviderWithSupplements } = require('../supplements/ir-provider');
const { buildSupplementOverlay, mergeSupplementOverlayIntoCandidates } = require('../supplements/overlay');

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

async function bindIRScope(provider, supplementSet = null) {
  if (!provider) return null;

  let execution = typeof provider.executeIR === 'function'
    ? provider
    : wrapWithLegacyIR(provider);

  const items = supplementSet?.items || [];
  const hasSupplements = items.length > 0;

  if (hasSupplements && typeof provider.attachIRSupplements === 'function') {
    await provider.attachIRSupplements(supplementSet);
  }

  const overlay = hasSupplements ? buildSupplementOverlay(supplementSet) : null;
  const hasOverlaySupplements = !!(overlay?.byCode?.size);
  const nativeComplete = !hasSupplements || provider._irAllSupplementsNativeBound === true;

  if (hasOverlaySupplements && !nativeComplete) {
    execution = wrapIRProviderWithSupplements(provider, supplementSet);
  }

  const coverage = nativeComplete ? 'native-complete' : 'overlay-complete';

  return {
    provider,
    execution,
    supplementSet,
    nativeCoverage() {
      return coverage;
    },
    usedSupplements() {
      if (items.length > 0) {
        return items
          .map(item => item?.descriptor?.canonical || item?.descriptor?.url)
          .filter(Boolean);
      }
      return typeof provider.listSupplements === 'function'
        ? provider.listSupplements()
        : [];
    },
    async decorateCandidates(candidates, opts = {}) {
      const { includeDesignations = false, properties = [] } = opts;
      if (!includeDesignations && properties.length === 0) return;

      const propertyDefsByCode = typeof provider.propertyDefinitions === 'function'
        ? new Map((provider.propertyDefinitions() || []).map(def => [String(def.code || ''), def]))
        : new Map();

      if (typeof provider.bulkDesignations === 'function' && includeDesignations) {
        const conceptIds = candidates.filter(c => c.conceptId).map(c => c.conceptId);
        const designMap = provider.bulkDesignations(conceptIds);

        for (const c of candidates) {
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
        for (const c of candidates) {
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
        const conceptIds = candidates.filter(c => c.conceptId).map(c => c.conceptId);
        const propMap = provider.bulkProperties(conceptIds);
        const extMap = typeof provider.bulkExtensions === 'function'
          ? provider.bulkExtensions(conceptIds)
          : new Map();

        for (const c of candidates) {
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
        for (const c of candidates) {
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

      if (coverage !== 'native-complete' && overlay?.byCode?.size > 0) {
        mergeSupplementOverlayIntoCandidates(candidates, overlay, {
          includeDesignations,
          properties,
        });
      }
    },
  };
}

async function decorateCandidatesByBoundScope(candidates, opts = {}) {
  const byBound = new Map();
  for (const c of candidates) {
    if (!c._boundScope) continue;
    if (!byBound.has(c._boundScope)) byBound.set(c._boundScope, []);
    byBound.get(c._boundScope).push(c);
  }
  for (const [bound, scopedCandidates] of byBound) {
    await bound.decorateCandidates(scopedCandidates, opts);
  }
}

module.exports = {
  bindIRScope,
  decorateCandidatesByBoundScope,
};
