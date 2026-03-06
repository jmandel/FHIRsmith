'use strict';

const { normalizeMembershipPlan } = require('./sqlite-v0-plan-normalize');
const { isTerminalPlan, normalizeTerminalSelection } = require('./sqlite-v0-plan-types');

function physicalizeMembershipPlan(plan, opts = {}) {
  const logical = opts.normalize === false ? plan : normalizeMembershipPlan(plan);
  return membershipStrategyForm(logical, opts.runtime || {});
}

function physicalizeTerminalPlan(plan, opts = {}) {
  if (!isTerminalPlan(plan)) {
    throw new Error(`Expected terminal plan, got ${String(plan?.kind || '(missing)')}`);
  }
  return terminalStrategyForm(normalizeTerminalPlan(plan), opts.runtime || {});
}

function normalizeTerminalPlan(plan) {
  if (!isTerminalPlan(plan)) return plan;
  return {
    ...plan,
    selection: normalizeTerminalSelection(plan.selection),
    members: normalizeMembershipPlan(plan.members),
  };
}

function terminalStrategyForm(plan, runtime) {
  switch (plan.kind) {
  case 'materializeConcepts':
    return {
      kind: 'materialize',
      strategy: 'ordered-materialize',
      selection: normalizeTerminalSelection(plan.selection),
      members: membershipStrategyForm(plan.members, runtime),
      columns: Array.isArray(plan.columns) ? [...plan.columns].map(String).sort() : [],
      includeTotal: plan.includeTotal === true,
      orderBy: Array.isArray(plan.orderBy) ? plan.orderBy.map(o => ({
        key: String(o?.key || ''),
        direction: String(o?.direction || '').toLowerCase(),
      })) : [],
      offset: Number.isInteger(plan.offset) ? plan.offset : 0,
      count: Number.isInteger(plan.count) ? plan.count : null,
    };
  case 'countMembers':
    return {
      kind: 'count',
      strategy: 'count-distinct-codes',
      selection: normalizeTerminalSelection(plan.selection),
      members: membershipStrategyForm(plan.members, runtime),
    };
  case 'probeMemberByCode':
    return {
      kind: 'probe',
      strategy: 'probe-by-code',
      code: String(plan.code || ''),
      members: membershipStrategyForm(plan.members, runtime),
    };
  default:
    throw new Error(`Unknown terminal plan kind ${String(plan?.kind || '(missing)')}`);
  }
}

function membershipStrategyForm(node, runtime) {
  if (!node || typeof node !== 'object') return null;
  if (node.strategy) return node;

  switch (node.kind) {
  case 'empty':
    return { kind: 'empty', strategy: 'empty-result' };
  case 'allConcepts':
    return { kind: 'scan-all', strategy: 'concept-scan' };
  case 'explicitCodes':
    return {
      kind: 'scan-codes',
      strategy: 'code-in',
      codes: [...new Set((node.codes || []).map(String).filter(Boolean))].sort(),
    };
  case 'fromRows':
    return {
      kind: 'fromRows',
      strategy: 'row-source',
      key: String(node.key || 'concept_id'),
      rows: rowStrategyForm(node.rows, runtime),
    };
  case 'union':
    return {
      kind: 'union',
      strategy: 'union-all',
      items: (node.items || []).map(item => membershipStrategyForm(item, runtime)),
    };
  case 'intersect':
    return {
      kind: 'intersect',
      strategy: 'exists-by-key',
      items: (node.items || []).map(item => membershipStrategyForm(item, runtime)),
    };
  case 'diff':
    return {
      kind: 'diff',
      strategy: 'anti-exists-by-key',
      left: membershipStrategyForm(node.left, runtime),
      right: membershipStrategyForm(node.right, runtime),
    };
  default:
    throw new Error(`Unknown set plan kind ${String(node.kind || '(missing)')}`);
  }
}

function rowStrategyForm(node, runtime) {
  if (!node || typeof node !== 'object') return null;
  if (node.strategy) return node;

  switch (node.kind) {
  case 'scan':
    return {
      kind: 'row-scan',
      strategy: 'table-scan',
      table: String(node.table || ''),
      as: node.as != null ? String(node.as) : null,
    };
  case 'values':
    return {
      kind: 'row-values',
      strategy: 'inline-values',
      columns: Array.isArray(node.columns) ? [...node.columns].map(String).sort() : [],
      rowCount: Array.isArray(node.rows) ? node.rows.length : 0,
    };
  case 'project':
    return {
      kind: 'row-project',
      strategy: 'project-columns',
      columns: Array.isArray(node.columns) ? [...node.columns].map(String).sort() : [],
      input: rowStrategyForm(node.input, runtime),
    };
  case 'filter':
    return {
      kind: 'row-filter',
      strategy: filterStrategy(node.predicate),
      predicate: normalizePredicate(node.predicate),
      input: rowStrategyForm(node.input, runtime),
    };
  case 'join':
    return {
      kind: 'row-join',
      strategy: String(node.joinType || 'inner') === 'left' ? 'left-join' : 'inner-join',
      left: rowStrategyForm(node.left, runtime),
      right: rowStrategyForm(node.right, runtime),
      on: normalizeJoinExpr(node.on),
    };
  case 'semiJoin':
    return {
      kind: 'row-semiJoin',
      strategy: 'semi-join',
      left: rowStrategyForm(node.left, runtime),
      right: rowStrategyForm(node.right, runtime),
      on: normalizeJoinExpr(node.on),
    };
  case 'antiJoin':
    return {
      kind: 'row-antiJoin',
      strategy: 'anti-join',
      left: rowStrategyForm(node.left, runtime),
      right: rowStrategyForm(node.right, runtime),
      on: normalizeJoinExpr(node.on),
    };
  case 'unionAll':
    return {
      kind: 'row-unionAll',
      strategy: 'union-all',
      inputs: (node.inputs || []).map(input => rowStrategyForm(input, runtime)),
    };
  case 'distinct':
    return {
      kind: 'row-distinct',
      strategy: 'distinct',
      keys: Array.isArray(node.keys) ? [...node.keys].map(String).sort() : [],
      input: rowStrategyForm(node.input, runtime),
    };
  case 'reachability':
    return {
      kind: 'row-reachability',
      strategy: selectReachabilityStrategy(node),
      relation: physicalRelation(node.relation),
      seed: membershipStrategyForm(node.seed, runtime),
      direction: node.direction === 'up' ? 'up' : 'down',
      includeSelf: node.includeSelf !== false,
    };
  case 'search':
    return {
      kind: 'row-search',
      strategy: selectTextSearchStrategy(node, runtime),
      text: String(node.text || ''),
      spec: normalizeSearchSpec(node.spec),
      ftsTables: normalizeFtsTables(runtime?.search?.ftsTables),
    };
  default:
    throw new Error(`Unknown row plan kind ${String(node.kind || '(missing)')}`);
  }
}

function filterStrategy(predicate) {
  switch (predicate?.kind) {
  case 'activeEquals':
    return 'where-active';
  case 'codeRegex':
    return 'code-regexp';
  case 'valueSetUrlEq':
    return 'value-set-member-join';
  case 'literalPropertyMatch':
    return 'literal-in';
  case 'literalPropertyRegex':
    return 'literal-regexp-join';
  case 'linkPropertyMatch':
    return String(predicate.linkMatch || 'code-only') === 'code-or-display'
      ? 'link-code-or-display'
      : 'link-code-only';
  default:
    return 'row-filter';
  }
}

function selectReachabilityStrategy(node) {
  if (node?.relation?.storage === 'closure' || !node?.relation?.storage) {
    return 'closure-join';
  }
  return `relation-${String(node.relation.storage)}`;
}

function selectTextSearchStrategy(node, runtime) {
  const sources = [...new Set((node?.spec?.sources || []).map(String).filter(Boolean))];
  if (sources.length === 0) return 'display-like';
  const configuredTables = runtime?.search?.ftsTables && typeof runtime.search.ftsTables === 'object'
    ? runtime.search.ftsTables
    : {};
  const hasNamedTable = Object.values(configuredTables).some(Boolean);
  return hasNamedTable ? 'fts-union' : 'fts-union-default-tables';
}

function normalizeFtsTables(tables) {
  const cfg = tables && typeof tables === 'object' ? tables : {};
  return {
    display: cfg.display ? String(cfg.display) : null,
    designation: cfg.designation ? String(cfg.designation) : null,
    literal: cfg.literal ? String(cfg.literal) : null,
  };
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
      values: [...new Set((predicate.values || []).map(String).filter(Boolean))].sort(),
    };
  case 'literalPropertyRegex':
    return {
      kind: 'literalPropertyRegex',
      property: String(predicate.property || ''),
      pattern: String(predicate.pattern || ''),
    };
  case 'linkPropertyMatch':
    return {
      kind: 'linkPropertyMatch',
      property: String(predicate.property || ''),
      values: [...new Set((predicate.values || []).map(String).filter(Boolean))].sort(),
      linkMatch: String(predicate.linkMatch || 'code-only'),
    };
  default:
    return predicate;
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
  return expr;
}

function normalizeSearchSpec(spec) {
  if (!spec || typeof spec !== 'object') return {
    sources: ['designation', 'display'],
    activeOnlyConcepts: true,
    designationActiveOnly: true,
    literalActiveOnly: true,
  };
  return {
    sources: [...new Set((spec.sources || []).map(String).filter(Boolean))].sort(),
    activeOnlyConcepts: spec.activeOnlyConcepts !== false,
    designationActiveOnly: spec.designationActiveOnly !== false,
    literalActiveOnly: spec.literalActiveOnly !== false,
  };
}

function physicalRelation(relation) {
  if (!relation || typeof relation !== 'object') return null;
  return {
    key: relation.key != null ? String(relation.key) : null,
    property: relation.property != null ? String(relation.property) : null,
    storage: relation.storage != null ? String(relation.storage) : null,
    edgeSetId: Number.isInteger(relation.edgeSetId) ? relation.edgeSetId : null,
    includeSelfForIsA: relation.includeSelfForIsA !== false,
    label: relation.label != null ? String(relation.label) : null,
  };
}

function physicalPlanStructuralForm(node, opts = {}) {
  if (!node || typeof node !== 'object') return null;
  if (node.strategy) return node;
  if (isTerminalPlan(node)) return terminalStrategyForm(normalizeTerminalPlan(node), opts.runtime || {});
  return membershipStrategyForm(opts.normalize === false ? node : normalizeMembershipPlan(node), opts.runtime || {});
}

module.exports = {
  physicalizeMembershipPlan,
  physicalizeTerminalPlan,
  physicalPlanStructuralForm,
};
