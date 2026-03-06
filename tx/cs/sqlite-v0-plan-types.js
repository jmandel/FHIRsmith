'use strict';

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

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  const csId = Number.isInteger(scope.csId) ? scope.csId : null;
  const system = scope.system != null ? String(scope.system) : '';
  const version = scope.version != null ? String(scope.version) : null;
  if (csId == null && !system) return null;
  return { csId, system, version };
}

function normalizeOrigin(origin) {
  if (!origin || typeof origin !== 'object') return { nodeIds: [], paths: [] };
  return {
    nodeIds: uniqueStrings(origin.nodeIds || []),
    paths: uniqueStrings(origin.paths || []),
  };
}

function mergeOrigins(...origins) {
  const nodeIds = [];
  const paths = [];
  for (const origin of origins) {
    const normalized = normalizeOrigin(origin);
    nodeIds.push(...normalized.nodeIds);
    paths.push(...normalized.paths);
  }
  return {
    nodeIds: uniqueStrings(nodeIds),
    paths: uniqueStrings(paths),
  };
}

function inferOriginFromPlan(plan, out = { nodeIds: new Set(), paths: new Set() }) {
  if (!plan || typeof plan !== 'object') return normalizeOrigin({ nodeIds: [...out.nodeIds], paths: [...out.paths] });
  if (plan.nodeId) out.nodeIds.add(String(plan.nodeId));
  if (plan.meta?.path) out.paths.add(String(plan.meta.path));
  if (Array.isArray(plan.items)) {
    for (const child of plan.items) inferOriginFromPlan(child, out);
  }
  if (Array.isArray(plan.inputs)) {
    for (const child of plan.inputs) inferOriginFromPlan(child, out);
  }
  if (plan.left) inferOriginFromPlan(plan.left, out);
  if (plan.right) inferOriginFromPlan(plan.right, out);
  if (plan.input) inferOriginFromPlan(plan.input, out);
  if (plan.members) inferOriginFromPlan(plan.members, out);
  if (plan.rows) inferOriginFromPlan(plan.rows, out);
  if (plan.seed) inferOriginFromPlan(plan.seed, out);
  return normalizeOrigin({ nodeIds: [...out.nodeIds], paths: [...out.paths] });
}

function allConcepts({ scope = null, origin = null, meta = null } = {}) {
  return { kind: 'allConcepts', scope: normalizeScope(scope), origin: normalizeOrigin(origin), meta: meta || null };
}

function explicitCodes({ scope = null, codes = [], origin = null, meta = null } = {}) {
  const items = uniqueStrings(codes);
  if (items.length === 0) return emptySet({ scope, origin, meta });
  return {
    kind: 'explicitCodes',
    scope: normalizeScope(scope),
    codes: items,
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function emptySet({ scope = null, origin = null, meta = null } = {}) {
  return { kind: 'empty', scope: normalizeScope(scope), origin: normalizeOrigin(origin), meta: meta || null };
}

function fromRows({ scope = null, rows, key = 'concept_id', origin = null, meta = null } = {}) {
  if (!rows) return emptySet({ scope, origin, meta });
  return {
    kind: 'fromRows',
    scope: normalizeScope(scope),
    rows,
    key: key === 'concept_id' ? 'concept_id' : String(key || 'concept_id'),
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function setUnion({ scope = null, items = [], origin = null, meta = null } = {}) {
  return {
    kind: 'union',
    scope: normalizeScope(scope),
    items: Array.isArray(items) ? items.filter(Boolean) : [],
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function setIntersect({ scope = null, items = [], origin = null, meta = null } = {}) {
  return {
    kind: 'intersect',
    scope: normalizeScope(scope),
    items: Array.isArray(items) ? items.filter(Boolean) : [],
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function setDiff({ scope = null, left = null, right = null, origin = null, meta = null } = {}) {
  if (!left) return emptySet({ scope, origin, meta });
  return {
    kind: 'diff',
    scope: normalizeScope(scope),
    left,
    right: right || emptySet({ scope, origin, meta }),
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function rowScan({ table, as = null, scope = null, origin = null, meta = null } = {}) {
  return {
    kind: 'scan',
    table: String(table || ''),
    as: as != null ? String(as) : null,
    scope: normalizeScope(scope),
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function rowValues({ columns = [], rows = [], origin = null, meta = null } = {}) {
  return {
    kind: 'values',
    columns: uniqueStringsStable(columns),
    rows: Array.isArray(rows) ? rows.map(r => Array.isArray(r) ? [...r] : [r]) : [],
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function rowProject({ input, columns = [], origin = null, meta = null } = {}) {
  return {
    kind: 'project',
    input,
    columns: uniqueStringsStable(columns),
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function rowFilter({ input, predicate, origin = null, meta = null } = {}) {
  return {
    kind: 'filter',
    input,
    predicate: predicate || null,
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function rowJoin({ joinType = 'inner', left, right, on, origin = null, meta = null } = {}) {
  return {
    kind: 'join',
    joinType: joinType === 'left' ? 'left' : 'inner',
    left,
    right,
    on: on || null,
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function rowSemiJoin({ left, right, on, origin = null, meta = null } = {}) {
  return { kind: 'semiJoin', left, right, on: on || null, origin: normalizeOrigin(origin), meta: meta || null };
}

function rowAntiJoin({ left, right, on, origin = null, meta = null } = {}) {
  return { kind: 'antiJoin', left, right, on: on || null, origin: normalizeOrigin(origin), meta: meta || null };
}

function rowUnionAll({ inputs = [], origin = null, meta = null } = {}) {
  return { kind: 'unionAll', inputs: Array.isArray(inputs) ? inputs.filter(Boolean) : [], origin: normalizeOrigin(origin), meta: meta || null };
}

function rowDistinct({ input, keys = [], origin = null, meta = null } = {}) {
  return { kind: 'distinct', input, keys: uniqueStringsStable(keys), origin: normalizeOrigin(origin), meta: meta || null };
}

function rowReachability({
  relation = null,
  seed = null,
  direction = 'down',
  includeSelf = true,
  minDepth = 0,
  maxDepth = null,
  origin = null,
  meta = null,
} = {}) {
  return {
    kind: 'reachability',
    relation: relation || null,
    seed,
    direction: direction === 'up' ? 'up' : 'down',
    includeSelf: includeSelf !== false,
    minDepth: Number.isInteger(minDepth) && minDepth >= 0 ? minDepth : 0,
    maxDepth: Number.isInteger(maxDepth) && maxDepth >= 0 ? maxDepth : null,
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function rowSearch({ scope = null, text = '', spec = null, origin = null, meta = null } = {}) {
  const query = String(text || '').trim();
  return {
    kind: 'search',
    scope: normalizeScope(scope),
    text: query,
    spec: spec || null,
    origin: normalizeOrigin(origin),
    meta: meta || null,
  };
}

function normalizeTerminalSelection(selection) {
  if (!selection || typeof selection !== 'object') {
    return { activeOnly: false, text: null };
  }
  const text = selection.text != null ? String(selection.text).trim() : '';
  return {
    activeOnly: !!selection.activeOnly,
    text: text || null,
  };
}

function materializeConcepts({
  members,
  columns = ['concept_id', 'code', 'display', 'definition', 'active'],
  orderBy = [{ key: 'code', direction: 'asc' }],
  offset = 0,
  count = null,
  includeTotal = false,
  selection = null,
  scope = null,
  origin = null,
  meta = null,
} = {}) {
  return {
    kind: 'materializeConcepts',
    members,
    columns: uniqueStrings(columns),
    orderBy: Array.isArray(orderBy) ? orderBy.map(o => ({
      key: String(o?.key || 'code'),
      direction: String(o?.direction || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
    })) : [{ key: 'code', direction: 'asc' }],
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
    count: Number.isInteger(count) && count >= 0 ? count : null,
    includeTotal: includeTotal === true,
    selection: normalizeTerminalSelection(selection),
    scope: normalizeScope(scope),
    origin: normalizeOrigin(origin || inferOriginFromPlan(members)),
    meta: meta || null,
  };
}

function countMembers({ members, selection = null, scope = null, origin = null, meta = null } = {}) {
  return {
    kind: 'countMembers',
    members,
    selection: normalizeTerminalSelection(selection),
    scope: normalizeScope(scope),
    origin: normalizeOrigin(origin || inferOriginFromPlan(members)),
    meta: meta || null,
  };
}

function probeMemberByCode({ members, code, scope = null, origin = null, meta = null } = {}) {
  return {
    kind: 'probeMemberByCode',
    members,
    code: String(code || ''),
    scope: normalizeScope(scope),
    origin: normalizeOrigin(origin || inferOriginFromPlan(members)),
    meta: meta || null,
  };
}

function isTerminalPlan(plan) {
  return !!plan && (
    plan.kind === 'materializeConcepts'
    || plan.kind === 'countMembers'
    || plan.kind === 'probeMemberByCode'
  );
}

module.exports = {
  allConcepts,
  countMembers,
  emptySet,
  explicitCodes,
  fromRows,
  inferOriginFromPlan,
  isTerminalPlan,
  materializeConcepts,
  mergeOrigins,
  normalizeOrigin,
  normalizeScope,
  normalizeTerminalSelection,
  probeMemberByCode,
  rowAntiJoin,
  rowDistinct,
  rowFilter,
  rowJoin,
  rowProject,
  rowReachability,
  rowScan,
  rowSearch,
  rowSemiJoin,
  rowUnionAll,
  rowValues,
  setDiff,
  setIntersect,
  setUnion,
};
