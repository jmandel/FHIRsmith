'use strict';

const crypto = require('crypto');
const Types = require('./sqlite-v0-plan-types');

function normalizeMembershipPlan(plan) {
  return normalizeSetPlan(plan);
}

function membershipPlanHash(plan) {
  const normalized = normalizeMembershipPlan(plan);
  return crypto.createHash('sha1')
    .update(planKey(normalized))
    .digest('hex');
}

function normalizeSetPlan(node) {
  if (!node || typeof node !== 'object') return Types.emptySet();
  switch (node.kind) {
  case 'empty':
    return Types.emptySet({
      scope: node.scope || null,
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'allConcepts':
    return Types.allConcepts({
      scope: node.scope || null,
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'explicitCodes':
    return Types.explicitCodes({
      scope: node.scope || null,
      codes: node.codes || [],
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'fromRows':
    return Types.fromRows({
      scope: node.scope || null,
      rows: normalizeRowPlan(node.rows),
      key: node.key || 'concept_id',
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'union':
    return normalizeUnion(node);
  case 'intersect':
    return normalizeIntersect(node);
  case 'diff':
    return normalizeDiff(node);
  default:
    throw new Error(`Unknown set plan kind ${String(node.kind || '(missing)')}`);
  }
}

function normalizeRowPlan(node) {
  if (!node || typeof node !== 'object') return null;

  switch (node.kind) {
  case 'scan':
    return Types.rowScan({
      table: node.table || '',
      as: node.as || null,
      scope: node.scope || null,
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'values': {
    const columns = uniqueStringsStable(node.columns || []);
    const rows = Array.isArray(node.rows)
      ? node.rows.map(r => Array.isArray(r) ? [...r] : [r]).sort(compareJson)
      : [];
    return Types.rowValues({
      columns,
      rows,
      origin: node.origin || null,
      meta: node.meta || null,
    });
  }
  case 'project':
    return Types.rowProject({
      input: normalizeRowPlan(node.input),
      columns: uniqueStringsStable(node.columns || []),
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'filter':
    return Types.rowFilter({
      input: normalizeRowPlan(node.input),
      predicate: normalizePredicate(node.predicate),
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'join':
    return Types.rowJoin({
      joinType: node.joinType || 'inner',
      left: normalizeRowPlan(node.left),
      right: normalizeRowPlan(node.right),
      on: normalizeJoinExpr(node.on),
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'semiJoin':
    return Types.rowSemiJoin({
      left: normalizeRowPlan(node.left),
      right: normalizeRowPlan(node.right),
      on: normalizeJoinExpr(node.on),
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'antiJoin':
    return Types.rowAntiJoin({
      left: normalizeRowPlan(node.left),
      right: normalizeRowPlan(node.right),
      on: normalizeJoinExpr(node.on),
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'unionAll': {
    const inputs = []
      .concat((node.inputs || []).map(normalizeRowPlan))
      .filter(Boolean)
      .sort((a, b) => compareJson(rowPlanStructuralForm(a), rowPlanStructuralForm(b)));
    return Types.rowUnionAll({
      inputs,
      origin: node.origin || null,
      meta: node.meta || null,
    });
  }
  case 'distinct':
    return Types.rowDistinct({
      input: normalizeRowPlan(node.input),
      keys: uniqueStringsStable(node.keys || []),
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'reachability':
    return Types.rowReachability({
      relation: normalizeRelation(node.relation),
      seed: normalizeSetPlan(node.seed),
      direction: node.direction || 'down',
      includeSelf: node.includeSelf !== false,
      minDepth: Number.isInteger(node.minDepth) ? node.minDepth : 0,
      maxDepth: Number.isInteger(node.maxDepth) ? node.maxDepth : null,
      origin: node.origin || null,
      meta: node.meta || null,
    });
  case 'search':
    return Types.rowSearch({
      scope: node.scope || null,
      text: node.text || '',
      spec: normalizeSearchSpec(node.spec),
      origin: node.origin || null,
      meta: node.meta || null,
    });
  default:
    throw new Error(`Unknown row plan kind ${String(node.kind || '(missing)')}`);
  }
}

function normalizeUnion(node) {
  const scope = node.scope || null;
  const flattened = [];
  for (const child of node.items || []) {
    const normalized = normalizeSetPlan(child);
    if (!normalized || normalized.kind === 'empty') continue;
    if (normalized.kind === 'union') {
      flattened.push(...(normalized.items || []));
      continue;
    }
    flattened.push(normalized);
  }
  if (flattened.some(item => item.kind === 'allConcepts')) {
    return Types.allConcepts({ scope, origin: node.origin || null, meta: node.meta || null });
  }

  const codes = new Set();
  const other = [];
  for (const item of flattened) {
    if (item.kind === 'explicitCodes') {
      for (const code of item.codes || []) codes.add(String(code));
    } else {
      other.push(item);
    }
  }
  if (codes.size > 0) {
    other.push(Types.explicitCodes({ scope, codes: [...codes], meta: null }));
  }

  const deduped = dedupeAndSortPlans(other);
  if (deduped.length === 0) return Types.emptySet({ scope, origin: node.origin || null, meta: node.meta || null });
  if (deduped.length === 1) return deduped[0];
  return Types.setUnion({
    scope,
    items: deduped,
    origin: node.origin || null,
    meta: node.meta || null,
  });
}

function normalizeIntersect(node) {
  const scope = node.scope || null;
  const rawItems = node.items || [];
  if (rawItems.length === 0) return Types.allConcepts({ scope, origin: node.origin || null, meta: node.meta || null });

  const flattened = [];
  for (const child of rawItems) {
    const normalized = normalizeSetPlan(child);
    if (!normalized) continue;
    if (normalized.kind === 'empty') return Types.emptySet({ scope, origin: node.origin || null, meta: node.meta || null });
    if (normalized.kind === 'intersect') {
      flattened.push(...(normalized.items || []));
      continue;
    }
    flattened.push(normalized);
  }

  const explicit = [];
  const other = [];
  for (const item of flattened) {
    if (item.kind === 'allConcepts') continue;
    if (item.kind === 'explicitCodes') explicit.push(item);
    else other.push(item);
  }
  if (explicit.length > 0) {
    let allowed = new Set((explicit[0].codes || []).map(String));
    for (const item of explicit.slice(1)) {
      const next = new Set((item.codes || []).map(String));
      allowed = new Set([...allowed].filter(code => next.has(code)));
      if (allowed.size === 0) return Types.emptySet({ scope, origin: node.origin || null, meta: node.meta || null });
    }
    other.push(Types.explicitCodes({ scope, codes: [...allowed], meta: null }));
  }

  const deduped = dedupeAndSortPlans(other);
  if (deduped.length === 0) return Types.allConcepts({ scope, origin: node.origin || null, meta: node.meta || null });
  if (deduped.length === 1) return deduped[0];
  const rowLowered = maybeLowerIntersectToRowSet(deduped, scope, node.origin || null, node.meta || null);
  if (rowLowered) return rowLowered;
  return Types.setIntersect({
    scope,
    items: deduped,
    origin: node.origin || null,
    meta: node.meta || null,
  });
}

function normalizeDiff(node) {
  const scope = node.scope || null;
  const left = normalizeSetPlan(node.left);
  const right = normalizeSetPlan(node.right);

  if (!left || left.kind === 'empty') return Types.emptySet({ scope, origin: node.origin || null, meta: node.meta || null });
  if (!right || right.kind === 'empty') return left;
  if (samePlan(left, right)) return Types.emptySet({ scope, origin: node.origin || null, meta: node.meta || null });
  if (right.kind === 'allConcepts') return Types.emptySet({ scope, origin: node.origin || null, meta: node.meta || null });
  const rowLowered = maybeLowerDiffToRowSet(left, right, scope, node.origin || null, node.meta || null);
  if (rowLowered) return rowLowered;

  return Types.setDiff({
    scope,
    left,
    right,
    origin: node.origin || null,
    meta: node.meta || null,
  });
}

function normalizePredicate(predicate) {
  if (!predicate || typeof predicate !== 'object') return null;
  switch (predicate.kind) {
  case 'activeEquals':
    return { kind: 'activeEquals', value: predicate.value !== false };
  case 'codeRegex':
    return { kind: 'codeRegex', pattern: String(predicate.pattern || '') };
  case 'valueSetUrlEq':
    return { kind: 'valueSetUrlEq', url: String(predicate.url || '') };
  case 'literalPropertyMatch':
    return {
      kind: 'literalPropertyMatch',
      property: String(predicate.property || ''),
      values: uniqueStrings(predicate.values || []),
    };
  case 'literalPropertyRegex':
    return {
      kind: 'literalPropertyRegex',
      property: String(predicate.property || ''),
      pattern: String(predicate.pattern || ''),
    };
  case 'literalPropertyExists':
    return {
      kind: 'literalPropertyExists',
      property: String(predicate.property || ''),
    };
  case 'linkPropertyMatch':
    return {
      kind: 'linkPropertyMatch',
      property: String(predicate.property || ''),
      values: uniqueStrings(predicate.values || []),
      linkMatch: String(predicate.linkMatch || 'code-only'),
    };
  case 'linkPropertyExists':
    return {
      kind: 'linkPropertyExists',
      property: String(predicate.property || ''),
    };
  default:
    return canonicalJson(predicate);
  }
}

function normalizeJoinExpr(expr) {
  if (!expr || typeof expr !== 'object') return null;
  if (expr.kind === 'eq') {
    return {
      kind: 'eq',
      leftField: String(expr.leftField || ''),
      rightField: String(expr.rightField || ''),
    };
  }
  return canonicalJson(expr);
}

function maybeLowerIntersectToRowSet(items, scope, origin, meta) {
  const keyed = items.map(extractRowBackedSet);
  if (keyed.some(item => !item)) return null;
  const key = keyed[0].key;
  if (!keyed.every(item => item.key === key)) return null;

  let rows = keyed[0].rows;
  for (const item of keyed.slice(1)) {
    rows = Types.rowSemiJoin({
      left: rows,
      right: item.rows,
      on: { kind: 'eq', leftField: key, rightField: item.key },
      origin,
      meta,
    });
  }
  rows = Types.rowDistinct({
    input: rows,
    keys: [key],
    origin,
    meta,
  });
  return Types.fromRows({
    scope,
    rows,
    key,
    origin,
    meta,
  });
}

function maybeLowerDiffToRowSet(left, right, scope, origin, meta) {
  const leftRows = extractRowBackedSet(left);
  const rightRows = extractRowBackedSet(right);
  if (!leftRows || !rightRows || leftRows.key !== rightRows.key) return null;
  return Types.fromRows({
    scope,
    rows: Types.rowDistinct({
      input: Types.rowAntiJoin({
        left: leftRows.rows,
        right: rightRows.rows,
        on: { kind: 'eq', leftField: leftRows.key, rightField: rightRows.key },
        origin,
        meta,
      }),
      keys: [leftRows.key],
      origin,
      meta,
    }),
    key: leftRows.key,
    origin,
    meta,
  });
}

function extractRowBackedSet(node) {
  if (!node || node.kind !== 'fromRows' || !node.rows) return null;
  return {
    rows: node.rows,
    key: String(node.key || 'concept_id'),
  };
}

function normalizeRelation(relation) {
  if (!relation || typeof relation !== 'object') return relation || null;
  return {
    key: relation.key != null ? String(relation.key) : null,
    property: relation.property != null ? String(relation.property) : null,
    operators: Array.isArray(relation.operators) ? uniqueStrings(relation.operators) : null,
    storage: relation.storage != null ? String(relation.storage) : null,
    edgeSetId: Number.isInteger(relation.edgeSetId) ? relation.edgeSetId : null,
    includeSelfForIsA: relation.includeSelfForIsA !== false,
    label: relation.label != null ? String(relation.label) : null,
  };
}

function normalizeSearchSpec(spec) {
  if (!spec || typeof spec !== 'object') return {
    sources: ['designation', 'display'],
    activeOnlyConcepts: true,
    designationActiveOnly: true,
    literalActiveOnly: true,
  };
  return {
    sources: uniqueStrings(spec.sources || ['display', 'designation']),
    activeOnlyConcepts: spec.activeOnlyConcepts !== false,
    designationActiveOnly: spec.designationActiveOnly !== false,
    literalActiveOnly: spec.literalActiveOnly !== false,
  };
}

function membershipPlanStructuralForm(node) {
  return setPlanStructuralForm(node);
}

function setPlanStructuralForm(node) {
  if (!node || typeof node !== 'object') return null;
  switch (node.kind) {
  case 'empty':
    return { kind: 'empty' };
  case 'allConcepts':
    return { kind: 'allConcepts' };
  case 'explicitCodes':
    return { kind: 'explicitCodes', codes: uniqueStrings(node.codes || []) };
  case 'fromRows':
    return {
      kind: 'fromRows',
      key: String(node.key || 'concept_id'),
      rows: rowPlanStructuralForm(node.rows),
    };
  case 'union':
    return {
      kind: 'union',
      items: (node.items || []).map(setPlanStructuralForm),
    };
  case 'intersect':
    return {
      kind: 'intersect',
      items: (node.items || []).map(setPlanStructuralForm),
    };
  case 'diff':
    return {
      kind: 'diff',
      left: setPlanStructuralForm(node.left),
      right: setPlanStructuralForm(node.right),
    };
  default:
    throw new Error(`Unknown set plan kind ${String(node.kind || '(missing)')}`);
  }
}

function rowPlanStructuralForm(node) {
  if (!node || typeof node !== 'object') return null;
  switch (node.kind) {
  case 'scan':
    return {
      kind: 'scan',
      table: String(node.table || ''),
      as: node.as != null ? String(node.as) : null,
    };
  case 'values':
    return {
      kind: 'values',
      columns: uniqueStringsStable(node.columns || []),
      rows: Array.isArray(node.rows) ? node.rows.map(r => Array.isArray(r) ? [...r] : [r]).sort(compareJson) : [],
    };
  case 'project':
    return {
      kind: 'project',
      input: rowPlanStructuralForm(node.input),
      columns: uniqueStringsStable(node.columns || []),
    };
  case 'filter':
    return {
      kind: 'filter',
      input: rowPlanStructuralForm(node.input),
      predicate: normalizePredicate(node.predicate),
    };
  case 'join':
    return {
      kind: 'join',
      joinType: String(node.joinType || 'inner'),
      left: rowPlanStructuralForm(node.left),
      right: rowPlanStructuralForm(node.right),
      on: normalizeJoinExpr(node.on),
    };
  case 'semiJoin':
    return {
      kind: 'semiJoin',
      left: rowPlanStructuralForm(node.left),
      right: rowPlanStructuralForm(node.right),
      on: normalizeJoinExpr(node.on),
    };
  case 'antiJoin':
    return {
      kind: 'antiJoin',
      left: rowPlanStructuralForm(node.left),
      right: rowPlanStructuralForm(node.right),
      on: normalizeJoinExpr(node.on),
    };
  case 'unionAll':
    return {
      kind: 'unionAll',
      inputs: (node.inputs || []).map(rowPlanStructuralForm),
    };
  case 'distinct':
    return {
      kind: 'distinct',
      input: rowPlanStructuralForm(node.input),
      keys: uniqueStringsStable(node.keys || []),
    };
  case 'reachability':
    return {
      kind: 'reachability',
      relation: normalizeRelation(node.relation),
      seed: setPlanStructuralForm(node.seed),
      direction: String(node.direction || 'down'),
      includeSelf: node.includeSelf !== false,
      minDepth: Number.isInteger(node.minDepth) ? node.minDepth : 0,
      maxDepth: Number.isInteger(node.maxDepth) ? node.maxDepth : null,
    };
  case 'search':
    return {
      kind: 'search',
      text: String(node.text || ''),
      spec: normalizeSearchSpec(node.spec),
    };
  default:
    throw new Error(`Unknown row plan kind ${String(node.kind || '(missing)')}`);
  }
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(v => String(v || '')).filter(Boolean))].sort();
}

function uniqueStringsStable(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const str = String(value || '');
    if (!str || seen.has(str)) continue;
    seen.add(str);
    out.push(str);
  }
  return out;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalJson(value[key]);
  }
  return out;
}

function compareJson(a, b) {
  const left = JSON.stringify(canonicalJson(a));
  const right = JSON.stringify(canonicalJson(b));
  return left.localeCompare(right);
}

function dedupeAndSortPlans(items) {
  const seen = new Map();
  for (const item of items || []) {
    const normalized = normalizeSetPlan(item);
    const key = planKey(normalized);
    if (!seen.has(key)) seen.set(key, normalized);
  }
  return [...seen.values()].sort((a, b) => planKey(a).localeCompare(planKey(b)));
}

function samePlan(left, right) {
  return planKey(left) === planKey(right);
}

function planKey(node) {
  return JSON.stringify(canonicalJson(setPlanStructuralForm(node)));
}

module.exports = {
  membershipPlanHash,
  membershipPlanStructuralForm,
  normalizeMembershipPlan,
  normalizePredicate,
  normalizeRowPlan,
  normalizeSetPlan,
  rowPlanStructuralForm,
  setPlanStructuralForm,
};
