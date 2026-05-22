'use strict';

function normalizeEdgeSetId(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function hierarchyDescriptor({
  key,
  property,
  operators = ['is-a', 'descendent-of'],
  storage = 'closure',
  edgeSetId = 1,
  includeSelfForIsA = true,
  label = null,
}) {
  return {
    key: String(key || ''),
    property: String(property || ''),
    operators: [...new Set((operators || []).map(String).filter(Boolean))],
    storage: String(storage || 'closure'),
    edgeSetId: normalizeEdgeSetId(edgeSetId),
    includeSelfForIsA: includeSelfForIsA !== false,
    label: label != null ? String(label) : null,
  };
}

function buildHierarchyDescriptors(propertyDefs, runtime = {}) {
  const map = new Map();
  const edgeSetId = normalizeEdgeSetId(runtime?.hierarchy?.edgeSetId);

  map.set('concept', hierarchyDescriptor({
    key: 'concept',
    property: 'concept',
    storage: 'closure',
    edgeSetId,
    includeSelfForIsA: runtime?.filters?.concept?.isAIncludesSelf !== false,
    label: 'Default concept hierarchy',
  }));

  for (const [code, def] of propertyDefs instanceof Map ? propertyDefs.entries() : []) {
    if (!def?.is_hierarchy) continue;
    const property = String(code || '');
    if (!property || property === 'concept') continue;
    map.set(`property:${property}`, hierarchyDescriptor({
      key: `property:${property}`,
      property,
      storage: 'conceptLink',
      edgeSetId,
      includeSelfForIsA: true,
      label: `Hierarchy property ${property}`,
    }));
  }

  return map;
}

function resolveHierarchyDescriptor(property, op, propertyDefs, runtime = {}) {
  const propertyCode = String(property || '');
  const operator = String(op || '');
  if (operator !== 'is-a' && operator !== 'descendent-of') return null;

  const descriptors = buildHierarchyDescriptors(propertyDefs, runtime);
  if (propertyCode === 'concept') return descriptors.get('concept') || null;

  const propDef = propertyDefs.get(propertyCode);
  if (propDef?.is_hierarchy) {
    return descriptors.get(`property:${propertyCode}`) || null;
  }

  return null;
}

module.exports = {
  hierarchyDescriptor,
  buildHierarchyDescriptors,
  resolveHierarchyDescriptor,
};
