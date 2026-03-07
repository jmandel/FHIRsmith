'use strict';

const crypto = require('crypto');
const {
  materializeSupplementInAttachedMemory,
  readSupplementSidecarPropertyDefs,
} = require('../supplements/sqlite-sidecar');

function nativeSupplementItemsFromSet(supplementSet) {
  return (supplementSet?.items || []).filter(item =>
    item?.nativeBindingSource?.kind === 'sqlite-sidecar'
      || !!item?.overlaySource
  );
}

function bindingSignature(items) {
  const keys = nativeSupplementItemsFromSet({ items })
    .map((item, index) => {
      if (item?.nativeBindingSource?.kind === 'sqlite-sidecar') {
        return `${item.descriptor?.canonical || ''}\x00${item.nativeBindingSource?.dbPath || ''}`;
      }
      return `${item?.descriptor?.canonical || ''}\x00inline\x00${index}`;
    })
    .sort();
  return keys.join('\x1e');
}

function clonePropertyDef(def, extras = {}) {
  if (!def || typeof def !== 'object') return null;
  return {
    property_id: Number.isInteger(def.property_id) ? def.property_id : null,
    value_kind: def.value_kind === 'concept' ? 'concept' : 'literal',
    is_hierarchy: !!def.is_hierarchy,
    display: def.display || null,
    source_type: def.source_type || null,
    hasBase: def.hasBase === true || Number.isInteger(def.property_id),
    hasSupplement: def.hasSupplement === true,
    ...extras,
  };
}

function mergeSupplementPropertyDefinitions(basePropDefs, bindings = []) {
  const merged = new Map();
  for (const [code, def] of basePropDefs instanceof Map ? basePropDefs.entries() : []) {
    merged.set(String(code), clonePropertyDef(def, { hasBase: true, hasSupplement: !!def?.hasSupplement }));
  }

  for (const binding of bindings || []) {
    for (const rawDef of binding.propertyDefs || []) {
      const code = String(rawDef?.property_code || '');
      if (!code) continue;
      const next = clonePropertyDef(rawDef, { hasBase: false, hasSupplement: true });
      const existing = merged.get(code);
      if (!existing) {
        merged.set(code, next);
        continue;
      }
      if (existing.value_kind !== next.value_kind) {
        throw new Error(
          `Supplement property '${code}' conflicts with base/runtime property kind (${existing.value_kind} vs ${next.value_kind})`
        );
      }
      merged.set(code, {
        ...existing,
        is_hierarchy: existing.is_hierarchy || next.is_hierarchy,
        display: existing.display || next.display || code,
        source_type: existing.source_type || next.source_type || null,
        hasBase: existing.hasBase || next.hasBase,
        hasSupplement: existing.hasSupplement || next.hasSupplement,
      });
    }
  }

  return merged;
}

function bindingPropertyDefinition(binding, propertyCode) {
  const want = String(propertyCode || '');
  if (!want) return null;
  for (const rawDef of binding?.propertyDefs || []) {
    if (String(rawDef?.property_code || '') === want) {
      return clonePropertyDef(rawDef, { hasBase: false, hasSupplement: true });
    }
  }
  return null;
}

function relevantSupplementBindings(bindings = [], propertyCode, opts = {}) {
  const wantKind = opts.valueKind === 'concept' ? 'concept' : (opts.valueKind === 'literal' ? 'literal' : null);
  const wantHierarchy = opts.isHierarchy;
  const matches = [];
  for (const binding of bindings || []) {
    const def = bindingPropertyDefinition(binding, propertyCode);
    if (!def) continue;
    if (wantKind && def.value_kind !== wantKind) continue;
    if (wantHierarchy != null && !!def.is_hierarchy !== !!wantHierarchy) continue;
    matches.push({ binding, propertyDef: def });
  }
  return matches;
}

function ensureAttachedSidecar(db, dbPath, alias) {
  db.prepare('ATTACH DATABASE ? AS ' + quoteIdent(alias)).run(dbPath);
}

function quoteIdent(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function aliasForBinding(item, index) {
  const seed = `${item?.descriptor?.canonical || item?.nativeBindingSource?.dbPath || item?.overlaySource?.url || 'supp'}\x00${index}`;
  const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
  return `supp_${hash}`;
}

function attachmentCacheKey(item, index) {
  if (item?.nativeBindingSource?.kind === 'sqlite-sidecar') {
    return `file:${item.nativeBindingSource.dbPath}`;
  }
  return `inline:${item?.descriptor?.canonical || item?.overlaySource?.url || 'supp'}:${index}`;
}

function bindNativeSupplements(db, supplementSet, attachmentState = new Map()) {
  const items = nativeSupplementItemsFromSet(supplementSet);
  const bindings = [];

  items.forEach((item, index) => {
    const cacheKey = attachmentCacheKey(item, index);
    let attached = attachmentState.get(cacheKey);
    if (!attached) {
      const alias = aliasForBinding(item, index);
      if (item?.nativeBindingSource?.kind === 'sqlite-sidecar') {
        const dbPath = item.nativeBindingSource.dbPath;
        if (!dbPath) return;
        ensureAttachedSidecar(db, dbPath, alias);
        attached = {
          alias,
          dbPath,
          meta: item.nativeBindingSource?.meta || item.descriptor || null,
          propertyDefs: readSupplementSidecarPropertyDefs(dbPath),
          sourceKind: 'sqlite-sidecar',
        };
      } else if (item?.overlaySource) {
        const rows = materializeSupplementInAttachedMemory(db, alias, item.overlaySource);
        attached = {
          alias,
          dbPath: null,
          meta: rows.info || item.descriptor || null,
          propertyDefs: rows.propertyDefs || [],
          sourceKind: 'sqlite-memory',
        };
      } else {
        return;
      }
      attachmentState.set(cacheKey, attached);
    }
    bindings.push({
      alias: attached.alias,
      dbPath: attached.dbPath,
      descriptor: item.descriptor || null,
      meta: attached.meta,
      propertyDefs: attached.propertyDefs,
      sourceKind: attached.sourceKind,
    });
  });

  return {
    signature: bindingSignature(items),
    bindings,
    propertyDefs: mergeSupplementPropertyDefinitions(new Map(), bindings),
  };
}

module.exports = {
  bindingPropertyDefinition,
  bindNativeSupplements,
  mergeSupplementPropertyDefinitions,
  nativeSupplementItemsFromSet,
  relevantSupplementBindings,
};
