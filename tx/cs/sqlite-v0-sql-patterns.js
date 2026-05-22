'use strict';

function isScanOf(node, tableName) {
  return !!node
    && (node.kind === 'row-scan' || node.kind === 'scan')
    && String(node.table || '') === String(tableName || '');
}

function supportsEarlyStopMaterialize(node) {
  if (!node || typeof node !== 'object') return false;
  switch (node.kind) {
  case 'empty':
  case 'allConcepts':
  case 'scan-all':
  case 'explicitCodes':
  case 'scan-codes':
    return true;
  case 'fromRows':
    return supportsEarlyStopRows(node.rows);
  case 'union':
  case 'intersect':
  case 'diff':
    return false;
  default:
    return false;
  }
}

function supportsEarlyStopRows(node) {
  if (!node || typeof node !== 'object') return false;
  switch (node.kind) {
  case 'scan':
  case 'row-scan':
    return true;
  case 'filter':
  case 'row-filter':
    return supportsEarlyStopRows(node.input) && !isHierarchyRowFilter(node);
  case 'project':
  case 'row-project':
    return supportsEarlyStopRows(node.input);
  case 'values':
  case 'row-values':
    return true;
  case 'reachability':
  case 'row-reachability':
    return true;
  case 'distinct':
  case 'row-distinct':
    return supportsEarlyStopRows(node.input);
  case 'join':
  case 'row-join':
  case 'semiJoin':
  case 'row-semiJoin':
  case 'antiJoin':
  case 'row-antiJoin':
  case 'unionAll':
  case 'row-unionAll':
  case 'search':
  case 'row-search':
    return false;
  default:
    return false;
  }
}

function isHierarchyRowFilter(node) {
  if (!node || typeof node !== 'object') return false;
  const predicate = node.predicate || {};
  if (predicate.kind === 'linkPropertyMatch' && String(predicate.property || '') === 'concept') {
    return true;
  }
  return false;
}

function boundedMembershipUpperLimit(node, ceiling = 32) {
  if (!node || typeof node !== 'object') return null;
  switch (node.kind) {
  case 'empty':
    return 0;
  case 'explicitCodes':
  case 'scan-codes': {
    const size = Array.isArray(node.codes) ? node.codes.length : 0;
    return size <= ceiling ? size : null;
  }
  case 'union': {
    let total = 0;
    for (const item of node.items || []) {
      const next = boundedMembershipUpperLimit(item, ceiling - total);
      if (!Number.isInteger(next)) return null;
      total += next;
      if (total > ceiling) return null;
    }
    return total;
  }
  case 'intersect': {
    let best = null;
    for (const item of node.items || []) {
      const next = boundedMembershipUpperLimit(item, ceiling);
      if (!Number.isInteger(next)) return null;
      best = best == null ? next : Math.min(best, next);
    }
    return best == null ? 0 : best;
  }
  case 'diff':
    return boundedMembershipUpperLimit(node.left, ceiling);
  default:
    return null;
  }
}

function extractSingleSeedClosureReachability(node) {
  if (!node || typeof node !== 'object') return null;
  let rows = null;
  if (node.kind === 'fromRows') {
    if (String(node.key || 'concept_id') !== 'concept_id') return null;
    rows = node.rows || null;
  } else {
    rows = node;
  }
  if ((rows?.kind === 'distinct' || rows?.kind === 'row-distinct')
      && Array.isArray(rows.keys)
      && rows.keys.length === 1
      && rows.keys[0] === 'concept_id') {
    rows = rows.input || null;
  }
  if (!rows || (rows.kind !== 'reachability' && rows.kind !== 'row-reachability')) return null;
  if (String(rows.direction || 'down') !== 'down') return null;
  if ((rows.relation?.storage || 'closure') !== 'closure') return null;
  const seed = rows.seed || null;
  const seedKind = String(seed?.kind || '');
  const codes = Array.isArray(seed?.codes) ? seed.codes : [];
  if ((seedKind !== 'explicitCodes' && seedKind !== 'scan-codes') || codes.length !== 1) return null;
  return rows;
}

function extractSingleSeedClosureReachabilityDiff(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'diff') {
    const left = extractSingleSeedClosureReachability(node.left);
    const right = extractSingleSeedClosureReachability(node.right);
    if (!left || !right) return null;
    return { left, right };
  }
  if (node.kind === 'fromRows' && String(node.key || '') === 'concept_id') {
    return extractSingleSeedClosureReachabilityDiff(node.rows);
  }
  if ((node.kind === 'distinct' || node.kind === 'row-distinct')
      && Array.isArray(node.keys)
      && node.keys.length === 1
      && node.keys[0] === 'concept_id') {
    return extractSingleSeedClosureReachabilityDiff(node.input);
  }
  if (node.kind === 'antiJoin' || node.kind === 'row-antiJoin') {
    if (node.on?.kind !== 'eq' || node.on?.leftField !== 'concept_id' || node.on?.rightField !== 'concept_id') {
      return null;
    }
    const left = extractSingleSeedClosureReachability(node.left);
    const right = extractSingleSeedClosureReachability(node.right);
    if (!left || !right) return null;
    return { left, right };
  }
  return null;
}

function extractSingleSeedClosureReachabilityIntersect(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'intersect') {
    const items = Array.isArray(node.items) ? node.items : [];
    if (items.length !== 2) return null;
    const left = extractSingleSeedClosureReachability(items[0]);
    const right = extractSingleSeedClosureReachability(items[1]);
    if (!left || !right) return null;
    return { left, right };
  }
  if (node.kind === 'fromRows' && String(node.key || '') === 'concept_id') {
    return extractSingleSeedClosureReachabilityIntersect(node.rows);
  }
  if ((node.kind === 'distinct' || node.kind === 'row-distinct')
      && Array.isArray(node.keys)
      && node.keys.length === 1
      && node.keys[0] === 'concept_id') {
    return extractSingleSeedClosureReachabilityIntersect(node.input);
  }
  if (node.kind === 'semiJoin' || node.kind === 'row-semiJoin') {
    if (node.on?.kind !== 'eq' || node.on?.leftField !== 'concept_id' || node.on?.rightField !== 'concept_id') {
      return null;
    }
    const left = extractSingleSeedClosureReachability(node.left);
    const right = extractSingleSeedClosureReachability(node.right);
    if (!left || !right) return null;
    return { left, right };
  }
  return null;
}

function extractCodeRegexFilter(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'fromRows' && String(node.key || 'concept_id') === 'concept_id') {
    return extractCodeRegexFilter(node.rows);
  }
  if ((node.kind === 'distinct' || node.kind === 'row-distinct')
      && Array.isArray(node.keys)
      && node.keys.length === 1
      && node.keys[0] === 'concept_id') {
    return extractCodeRegexFilter(node.input);
  }
  if (node.kind === 'filter' || node.kind === 'row-filter') {
    if (!isScanOf(node.input, 'concept')) return null;
    if (node.predicate?.kind !== 'codeRegex') return null;
    return { pattern: String(node.predicate.pattern || '') };
  }
  return null;
}

function extractSingleSeedClosureReachabilityCodeRegexIntersect(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'fromRows' && String(node.key || '') === 'concept_id') {
    return extractSingleSeedClosureReachabilityCodeRegexIntersect(node.rows);
  }
  if ((node.kind === 'distinct' || node.kind === 'row-distinct')
      && Array.isArray(node.keys)
      && node.keys.length === 1
      && node.keys[0] === 'concept_id') {
    return extractSingleSeedClosureReachabilityCodeRegexIntersect(node.input);
  }
  if (node.kind === 'intersect') {
    const items = Array.isArray(node.items) ? node.items : [];
    if (items.length !== 2) return null;
    const leftReachability = extractSingleSeedClosureReachability(items[0]);
    const rightReachability = extractSingleSeedClosureReachability(items[1]);
    const leftRegex = extractCodeRegexFilter(items[0]);
    const rightRegex = extractCodeRegexFilter(items[1]);
    if (leftReachability && rightRegex) return { reachability: leftReachability, pattern: rightRegex.pattern };
    if (rightReachability && leftRegex) return { reachability: rightReachability, pattern: leftRegex.pattern };
    return null;
  }
  if (node.kind === 'semiJoin' || node.kind === 'row-semiJoin') {
    if (node.on?.kind !== 'eq' || node.on?.leftField !== 'concept_id' || node.on?.rightField !== 'concept_id') {
      return null;
    }
    const leftReachability = extractSingleSeedClosureReachability(node.left);
    const rightReachability = extractSingleSeedClosureReachability(node.right);
    const leftRegex = extractCodeRegexFilter(node.left);
    const rightRegex = extractCodeRegexFilter(node.right);
    if (leftReachability && rightRegex) return { reachability: leftReachability, pattern: rightRegex.pattern };
    if (rightReachability && leftRegex) return { reachability: rightReachability, pattern: leftRegex.pattern };
  }
  return null;
}

function extractSupplementLiteralMatchPredicates(node, ctx) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'fromRows' && String(node.key || '') === 'source_concept_id') {
    return extractSupplementLiteralMatchPredicates(node.rows, ctx);
  }
  if ((node.kind === 'distinct' || node.kind === 'row-distinct')
      && Array.isArray(node.keys) && node.keys.length === 1 && node.keys[0] === 'source_concept_id') {
    return extractSupplementLiteralMatchPredicates(node.input, ctx);
  }
  if (node.kind === 'semiJoin' || node.kind === 'row-semiJoin') {
    if (node.on?.kind !== 'eq' || node.on?.leftField !== 'source_concept_id' || node.on?.rightField !== 'source_concept_id') {
      return null;
    }
    const left = extractSupplementLiteralMatchPredicates(node.left, ctx);
    const right = extractSupplementLiteralMatchPredicates(node.right, ctx);
    if (!left || !right) return null;
    return [...left, ...right];
  }
  if (node.kind === 'filter' || node.kind === 'row-filter') {
    if (!isScanOf(node.input, 'concept_literal')) return null;
    if (node.predicate?.kind !== 'literalPropertyMatch') return null;
    const property = String(node.predicate.property || '');
    const propDef = ctx.propertyDef(property);
    if (!propDef || Number.isInteger(propDef.property_id)) return null;
    const literalBindings = ctx.supplementBindingsForProperty(property, { valueKind: 'literal' });
    const linkBindings = ctx.supplementBindingsForProperty(property, { valueKind: 'concept' });
    if (literalBindings.length === 0 || linkBindings.length > 0) return null;
    return [node.predicate];
  }
  return null;
}

module.exports = {
  boundedMembershipUpperLimit,
  extractCodeRegexFilter,
  extractSingleSeedClosureReachability,
  extractSingleSeedClosureReachabilityCodeRegexIntersect,
  extractSingleSeedClosureReachabilityDiff,
  extractSingleSeedClosureReachabilityIntersect,
  extractSupplementLiteralMatchPredicates,
  isScanOf,
  supportsEarlyStopMaterialize,
};
