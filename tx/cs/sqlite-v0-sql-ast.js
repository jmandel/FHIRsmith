'use strict';

const { relevantSupplementBindings } = require('./sqlite-v0-supplements');
const {
  boundedMembershipUpperLimit,
  extractCodeRegexFilter,
  extractSingleSeedClosureReachability,
  extractSingleSeedClosureReachabilityCodeRegexIntersect,
  extractSingleSeedClosureReachabilityDiff,
  extractSingleSeedClosureReachabilityIntersect,
  extractSupplementLiteralMatchPredicates,
  isScanOf,
  supportsEarlyStopMaterialize,
} = require('./sqlite-v0-sql-patterns');
const {
  chooseCountStrategy,
  chooseMaterializeStrategy,
  chooseTerminalLoweringStrategy: chooseTerminalStrategy,
} = require('./sqlite-v0-sql-strategies');
const {
  lowerCorrelatedRuntimeSearchPredicate,
  lowerRuntimeSearch,
  runtimeSearchNode,
} = require('./sqlite-v0-sql-search');
const {
  aliasExpr,
  and,
  binary,
  call,
  column,
  compound,
  collate,
  cte,
  exists,
  inQuery,
  join,
  list,
  literal,
  order,
  or,
  param,
  select,
  sqlAstStructuralForm,
  subquery,
  table,
  unary,
  withQuery,
} = require('./sqlite-v0-sql-nodes');

function lowerPhysicalPlanToSqlAst(plan, opts = {}) {
  const ctx = createContext(opts, plan);
  const ast = lowerPhysical(plan, ctx, resolveScope(plan?.scope || opts.scope || null));
  return { ast, params: ctx.params, strategy: ctx.lastTerminalStrategy || null };
}

function createContext(opts, plan) {
  const propertyDefs = opts.propertyDefs instanceof Map ? opts.propertyDefs : new Map();
  const runtime = opts.runtime || {};
  return {
    next: 0,
    params: {},
    propertyDefs,
    runtime,
    supplementBindings: Array.isArray(opts.supplementBindings) ? opts.supplementBindings : [],
    fallbackScope: resolveScope(opts.scope || plan?.scope || null),
    add(prefix, value) {
      const name = `${String(prefix || 'p')}_${this.next++}`;
      this.params[name] = value;
      return param(name);
    },
    propertyDef(propertyCode) {
      return this.propertyDefs.get(String(propertyCode || '')) || null;
    },
    supplementBindingsForProperty(propertyCode, opts = {}) {
      return relevantSupplementBindings(this.supplementBindings, propertyCode, opts);
    },
  };
}

function resolveScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  return {
    csId: Number.isInteger(scope.csId) ? scope.csId : null,
    system: scope.system != null ? String(scope.system) : '',
    version: scope.version != null ? String(scope.version) : null,
  };
}

function scopeFor(node, fallback, ctx) {
  return resolveScope(node?.scope || fallback || ctx.fallbackScope || null);
}

function hasNativeSupplements(ctx) {
  return Array.isArray(ctx?.supplementBindings) && ctx.supplementBindings.length > 0;
}

function supplementTable(binding, tableName, alias) {
  return table(tableName, alias, binding?.alias || null);
}

function supplementLiteralQuery(binding, ctx, scope, predicate = null) {
  const where = [
    binary('=', column('cs_id', 'src'), ctx.add('supp_literal_src_cs_id', scope?.csId)),
    binary('=', column('active', 'sl'), literal(1)),
    predicate,
  ];
  return select({
    columns: [
      aliasExpr(column('concept_id', 'src'), 'source_concept_id'),
      aliasExpr(column('property_code', 'sl'), 'property_code'),
      aliasExpr(column('value_raw', 'sl'), 'value_raw'),
      aliasExpr(column('value_text', 'sl'), 'value_text'),
      aliasExpr(column('value_num', 'sl'), 'value_num'),
      aliasExpr(column('value_bool', 'sl'), 'value_bool'),
      aliasExpr(column('group_id', 'sl'), 'group_id'),
      aliasExpr(column('active', 'sl'), 'active'),
    ],
    from: supplementTable(binding, 'supplement_literal', 'sl'),
    joins: [
      join('INNER', table('concept', 'src'), binary('=', column('code', 'src'), column('source_code', 'sl'))),
    ],
    where: and(where),
  });
}

function supplementLinkQuery(binding, ctx, scope, predicate = null) {
  const where = [
    binary('=', column('cs_id', 'src'), ctx.add('supp_link_src_cs_id', scope?.csId)),
    binary('=', column('cs_id', 'tgt'), ctx.add('supp_link_tgt_cs_id', scope?.csId)),
    binary('=', column('active', 'sl'), literal(1)),
    or([
      binary('IS', column('target_system', 'sl'), literal(null)),
      binary('=', column('target_system', 'sl'), ctx.add('supp_target_system', scope?.system || '')),
    ]),
    predicate,
  ];
  return select({
    columns: [
      aliasExpr(column('concept_id', 'src'), 'source_concept_id'),
      aliasExpr(column('property_code', 'sl'), 'property_code'),
      aliasExpr(column('concept_id', 'tgt'), 'target_concept_id'),
      aliasExpr(column('code', 'tgt'), 'target_code'),
      aliasExpr(column('display', 'tgt'), 'target_display'),
      aliasExpr(column('group_id', 'sl'), 'group_id'),
      aliasExpr(column('active', 'sl'), 'active'),
    ],
    from: supplementTable(binding, 'supplement_link', 'sl'),
    joins: [
      join('INNER', table('concept', 'src'), binary('=', column('code', 'src'), column('source_code', 'sl'))),
      join('INNER', table('concept', 'tgt'), binary('=', column('code', 'tgt'), column('target_code', 'sl'))),
    ],
    where: and(where),
  });
}

function supplementDesignationQuery(binding, ctx, scope, extraWhere = null) {
  return select({
    columns: [
      aliasExpr(column('concept_id', 'c'), 'concept_id'),
      aliasExpr(column('active', 'sd'), 'active'),
      aliasExpr(column('language_code', 'sd'), 'language_code'),
      aliasExpr(column('use_code', 'sd'), 'use_code'),
      aliasExpr(column('use_system', 'sd'), 'use_system'),
      aliasExpr(column('term', 'sd'), 'term'),
      aliasExpr(column('preferred', 'sd'), 'preferred'),
    ],
    from: supplementTable(binding, 'supplement_designation', 'sd'),
    joins: [
      join('INNER', table('concept', 'c'), binary('=', column('code', 'c'), column('source_code', 'sd'))),
    ],
    where: and([
      binary('=', column('cs_id', 'c'), ctx.add('supp_designation_cs_id', scope?.csId)),
      extraWhere,
    ]),
  });
}

function lowerPhysical(node, ctx, fallbackScope = null) {
  switch (node?.kind) {
  case 'materialize':
  case 'materializeConcepts':
    return lowerMaterialize(node, ctx, fallbackScope);
  case 'count':
  case 'countMembers':
    return lowerCount(node, ctx, fallbackScope);
  case 'probe':
  case 'probeMemberByCode':
    return lowerProbe(node, ctx, fallbackScope);
  default:
    return lowerSet(node, ctx, fallbackScope);
  }
}

function lowerMaterialize(node, ctx, fallbackScope) {
  const scope = scopeFor(node, fallbackScope, ctx);
  const selected = selectMaterializeLowering(node, ctx, scope);
  if (selected.strategy === 'materialize-with-total') {
    ctx.lastTerminalStrategy = selected.strategy;
    return lowerMaterializeWithTotal(node, ctx, scope);
  }
  if (selected.lowered) {
    ctx.lastTerminalStrategy = selected.strategy;
    return selected.lowered;
  }
  ctx.lastTerminalStrategy = 'generic-materialize';
  return lowerGenericMaterialize(node, ctx, scope);
}

function lowerGenericMaterialize(node, ctx, scope) {
  const members = lowerSet(node.members, ctx, scopeFor(node.members, scope, ctx));
  const fromAlias = 'm';
  const conceptAlias = 'c';
  return select({
    columns: (node.columns || []).map(col => aliasExpr(column(col, conceptAlias), col)),
    from: subquery(members, fromAlias),
    joins: [
      join('INNER', table('concept', conceptAlias), binary('=', column('concept_id', conceptAlias), column('concept_id', fromAlias))),
    ],
    where: lowerTerminalSelectionWhere(node.selection, ctx, scope, conceptAlias, { members: node.members }),
    orderBy: (node.orderBy || []).map(o => order(column(o.key, conceptAlias), o.direction)),
    limit: node.count != null ? literal(node.count) : null,
    offset: node.offset ? literal(node.offset) : null,
  });
}

function selectMaterializeLowering(node, ctx, scope) {
  const strategy = chooseMaterializeStrategy(node, ctx);
  const lower = {
    'materialize-with-total': null,
    'code-regex-materialize': lowerCodeRegexMaterializeFastPath,
    'supplement-literal-materialize': lowerSupplementLiteralMaterializeFastPath,
    'reachability-code-regex-materialize': lowerReachabilityCodeRegexMaterializeFastPath,
    'reachability-intersect-materialize': lowerReachabilityIntersectMaterializeFastPath,
    'reachability-diff-materialize': lowerReachabilityDiffMaterializeFastPath,
    'early-stop-materialize': lowerEarlyStopMaterialize,
    'reachability-materialize': lowerReachabilityMaterializeFastPath,
    'generic-materialize': null,
  }[strategy];
  return { strategy, lowered: typeof lower === 'function' ? lower(node, ctx, scope) : null };
}

function lowerReachabilityMaterializeFastPath(node, ctx, scope) {
  const selection = node.selection || {};
  const text = selection.text != null ? String(selection.text).trim() : '';
  if (text) return null;

  const reachability = extractSingleSeedClosureReachability(node.members);
  if (!reachability) return null;

  const seed = lowerSet(reachability.seed, ctx, scopeFor(reachability.seed, scope, ctx));
  const conceptAlias = 'c';
  const where = [];
  if (Number.isInteger(scope?.csId)) {
    where.push(binary('=', column('cs_id', conceptAlias), ctx.add('reachability_cs_id', scope.csId)));
  }
  if (selection.activeOnly) {
    where.push(binary('=', column('active', conceptAlias), literal(1)));
  }
  if (reachability.includeSelf === false) {
    where.push(binary('!=', column('descendant_id', 'cl'), column('ancestor_id', 'cl')));
  }

  return select({
    columns: (node.columns || []).map(col => aliasExpr(column(col, conceptAlias), col)),
    from: table('closure', 'cl'),
    joins: [
      join('INNER', subquery(seed, 'seed'), binary('=', column('ancestor_id', 'cl'), column('concept_id', 'seed'))),
      join('INNER', table('concept', conceptAlias), binary('=', column('concept_id', conceptAlias), column('descendant_id', 'cl'))),
    ],
    where: and(where),
    orderBy: (node.orderBy || []).map(o => order(column(o.key, conceptAlias), o.direction)),
    limit: node.count != null ? literal(node.count) : null,
    offset: node.offset ? literal(node.offset) : null,
  });
}

function lowerCodeRegexMaterializeFastPath(node, ctx, scope) {
  const extracted = extractCodeRegexFilter(node.members);
  if (!extracted) return null;
  const regexWhere = lowerCodeRegexConceptWhere(extracted.pattern, ctx, 'c');
  if (!regexWhere) return null;
  const where = [
    Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('code_regex_cs_id', scope.csId)) : null,
    lowerTerminalSelectionWhere(node.selection, ctx, scope, 'c', { members: node.members }),
    regexWhere,
  ];
  return select({
    columns: (node.columns || []).map(col => aliasExpr(column(col, 'c'), col)),
    from: table('concept', 'c'),
    where: and(where),
    orderBy: (node.orderBy || []).map(o => order(column(o.key, 'c'), o.direction)),
    limit: node.count != null ? literal(node.count) : null,
    offset: node.offset ? literal(node.offset) : null,
  });
}

function lowerSeededClosureDescendantRows(reachability, seed) {
  const where = [];
  if (reachability.includeSelf === false) {
    where.push(binary('!=', column('descendant_id', 'cl'), column('ancestor_id', 'cl')));
  }
  return select({
    columns: [aliasExpr(column('descendant_id', 'cl'), 'concept_id')],
    from: table('closure', 'cl'),
    joins: [
      join('INNER', subquery(seed, 'seed'), binary('=', column('ancestor_id', 'cl'), column('concept_id', 'seed'))),
    ],
    where: and(where),
  });
}

function plannerEstimateSingleSeedClosureCount(ctx, reachability) {
  const estimator = ctx.runtime?.planner?.estimateSingleSeedClosureCount;
  const code = Array.isArray(reachability?.seed?.codes) ? reachability.seed.codes[0] : null;
  if (typeof estimator !== 'function' || !code) return null;
  const count = estimator(code, reachability.includeSelf !== false);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function lowerReachabilityCodeRegexBaseQuery(node, ctx, scope, columns) {
  const selection = node.selection || {};
  const text = selection.text != null ? String(selection.text).trim() : '';
  if (text) return null;

  const intersect = extractSingleSeedClosureReachabilityCodeRegexIntersect(node.members);
  if (!intersect) return null;

  const regexWhere = lowerCodeRegexConceptWhere(intersect.pattern, ctx, 'c');
  if (!regexWhere) return null;
  const seed = lowerSet(intersect.reachability.seed, ctx, scopeFor(intersect.reachability.seed, scope, ctx));

  return select({
    columns,
    from: table('closure', 'cl'),
    joins: [
      join('INNER', subquery(seed, 'seed'), binary('=', column('ancestor_id', 'cl'), column('concept_id', 'seed'))),
      join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('descendant_id', 'cl'))),
    ],
    where: and([
      Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('reach_regex_cs_id', scope.csId)) : null,
      selection.activeOnly ? binary('=', column('active', 'c'), literal(1)) : null,
      intersect.reachability.includeSelf === false ? binary('!=', column('descendant_id', 'cl'), column('ancestor_id', 'cl')) : null,
      regexWhere,
    ]),
  });
}

function lowerReachabilityDiffBaseQuery(node, ctx, scope, columns) {
  const selection = node.selection || {};
  const text = selection.text != null ? String(selection.text).trim() : '';
  if (text) return null;

  const diff = extractSingleSeedClosureReachabilityDiff(node.members);
  if (!diff) return null;

  const leftSeed = lowerSet(diff.left.seed, ctx, scopeFor(diff.left.seed, scope, ctx));
  const rightSeed = lowerSet(diff.right.seed, ctx, scopeFor(diff.right.seed, scope, ctx));
  const leftRows = lowerSeededClosureDescendantRows(diff.left, leftSeed);
  const rightRows = lowerSeededClosureDescendantRows(diff.right, rightSeed);

  return select({
    columns,
    from: subquery(leftRows, 'l'),
    joins: [
      join('LEFT', subquery(rightRows, 'r'), binary('=', column('concept_id', 'r'), column('concept_id', 'l'))),
      join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('concept_id', 'l'))),
    ],
    where: and([
      binary('IS', column('concept_id', 'r'), literal(null)),
      Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('reach_diff_cs_id', scope.csId)) : null,
      selection.activeOnly ? binary('=', column('active', 'c'), literal(1)) : null,
    ]),
  });
}

function chooseReachabilityIntersectSides(intersect, ctx) {
  const leftCount = plannerEstimateSingleSeedClosureCount(ctx, intersect.left);
  const rightCount = plannerEstimateSingleSeedClosureCount(ctx, intersect.right);
  if (Number.isInteger(leftCount) && Number.isInteger(rightCount)) {
    return rightCount <= leftCount
      ? { small: intersect.right, large: intersect.left }
      : { small: intersect.left, large: intersect.right };
  }
  return { small: intersect.left, large: intersect.right };
}

function lowerReachabilityIntersectBaseQuery(node, ctx, scope, columns) {
  const selection = node.selection || {};
  const text = selection.text != null ? String(selection.text).trim() : '';
  if (text) return null;

  const intersect = extractSingleSeedClosureReachabilityIntersect(node.members);
  if (!intersect) return null;
  const { small, large } = chooseReachabilityIntersectSides(intersect, ctx);

  const smallSeed = lowerSet(small.seed, ctx, scopeFor(small.seed, scope, ctx));
  const largeSeed = lowerSet(large.seed, ctx, scopeFor(large.seed, scope, ctx));
  const smallRows = lowerSeededClosureDescendantRows(small, smallSeed);
  const largeRows = lowerSeededClosureDescendantRows(large, largeSeed);

  return select({
    columns,
    from: subquery(smallRows, 's'),
    joins: [
      join('INNER', subquery(largeRows, 'l'), binary('=', column('concept_id', 'l'), column('concept_id', 's'))),
      join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('concept_id', 's'))),
    ],
    where: and([
      Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('reach_intersect_cs_id', scope.csId)) : null,
      selection.activeOnly ? binary('=', column('active', 'c'), literal(1)) : null,
    ]),
  });
}

function lowerReachabilityIntersectMaterializeFastPath(node, ctx, scope) {
  const columns = (node.columns || []).map(col => aliasExpr(column(col, 'c'), col));
  const base = lowerReachabilityIntersectBaseQuery(node, ctx, scope, columns);
  if (!base) return null;
  return {
    ...base,
    orderBy: (node.orderBy || []).map(o => order(column(o.key, 'c'), o.direction)),
    limit: node.count != null ? literal(node.count) : null,
    offset: node.offset ? literal(node.offset) : null,
  };
}

function lowerReachabilityCodeRegexMaterializeFastPath(node, ctx, scope) {
  const columns = (node.columns || []).map(col => aliasExpr(column(col, 'c'), col));
  const base = lowerReachabilityCodeRegexBaseQuery(node, ctx, scope, columns);
  if (!base) return null;
  return {
    ...base,
    orderBy: (node.orderBy || []).map(o => order(column(o.key, 'c'), o.direction)),
    limit: node.count != null ? literal(node.count) : null,
    offset: node.offset ? literal(node.offset) : null,
  };
}

function lowerReachabilityDiffMaterializeFastPath(node, ctx, scope) {
  const selection = node.selection || {};
  const text = selection.text != null ? String(selection.text).trim() : '';
  if (text) return null;

  const diff = extractSingleSeedClosureReachabilityDiff(node.members);
  if (!diff) return null;

  const leftSeed = lowerSet(diff.left.seed, ctx, scopeFor(diff.left.seed, scope, ctx));
  const rightSeed = lowerSet(diff.right.seed, ctx, scopeFor(diff.right.seed, scope, ctx));
  const members = compound('EXCEPT', [
    lowerSeededClosureDescendantRows(diff.left, leftSeed),
    lowerSeededClosureDescendantRows(diff.right, rightSeed),
  ]);

  return select({
    columns: (node.columns || []).map(col => aliasExpr(column(col, 'c'), col)),
    from: subquery(members, 'm'),
    joins: [
      join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('concept_id', 'm'))),
    ],
    where: and([
      Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('reach_diff_page_cs_id', scope.csId)) : null,
      selection.activeOnly ? binary('=', column('active', 'c'), literal(1)) : null,
    ]),
    orderBy: (node.orderBy || []).map(o => order(column(o.key, 'c'), o.direction)),
    limit: node.count != null ? literal(node.count) : null,
    offset: node.offset ? literal(node.offset) : null,
  });
}

function lowerMaterializeWithTotal(node, ctx, scope) {
  const selectedName = 'selected_members';
  const totalName = 'selected_total';
  const selectedColumns = (node.columns || []).map(col => aliasExpr(column(col, 'c'), col));
  const selectedQuery = buildMaterializeBaseQuery(node, ctx, scope, selectedColumns);
  return withQuery({
    ctes: [
      cte(selectedName, selectedQuery, node.columns || []),
      cte(totalName, select({
        columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
        from: table(selectedName, 'sm'),
      }), ['cnt']),
    ],
    body: select({
      columns: [
        ...(node.columns || []).map(col => aliasExpr(column(col, 's'), col)),
        aliasExpr(column('cnt', 't'), 'total'),
      ],
      from: table(selectedName, 's'),
      joins: [
        join('INNER', table(totalName, 't'), literal(true)),
      ],
      orderBy: (node.orderBy || []).map(o => order(column(o.key, 's'), o.direction)),
      limit: node.count != null ? literal(node.count) : null,
      offset: node.offset ? literal(node.offset) : null,
    }),
  });
}

function buildMaterializeBaseQuery(node, ctx, scope, columns) {
  const reachabilityCodeRegexFastPath = lowerReachabilityCodeRegexBaseQuery(node, ctx, scope, columns);
  if (reachabilityCodeRegexFastPath) return reachabilityCodeRegexFastPath;
  const reachabilityIntersectFastPath = lowerReachabilityIntersectBaseQuery(node, ctx, scope, columns);
  if (reachabilityIntersectFastPath) return reachabilityIntersectFastPath;
  const reachabilityDiffFastPath = lowerReachabilityDiffBaseQuery(node, ctx, scope, columns);
  if (reachabilityDiffFastPath) return reachabilityDiffFastPath;
  const members = lowerSet(node.members, ctx, scopeFor(node.members, scope, ctx));
  const fromAlias = 'm';
  const conceptAlias = 'c';
  return select({
    columns,
    from: subquery(members, fromAlias),
    joins: [
      join('INNER', table('concept', conceptAlias), binary('=', column('concept_id', conceptAlias), column('concept_id', fromAlias))),
    ],
    where: lowerTerminalSelectionWhere(node.selection, ctx, scope, conceptAlias, { members: node.members }),
  });
}

function lowerEarlyStopMaterialize(node, ctx, scope) {
  const selection = node.selection || {};
  const orderBy = Array.isArray(node.orderBy) ? node.orderBy : [];
  if (!Number.isInteger(node.count) || node.count <= 0 || node.count > 100) return null;
  if (Number.isInteger(node.offset) && node.offset > 0 && !ctx.runtime?.planner?.enableEarlyStopBudgetFunction) return null;
  if (orderBy.length !== 1) return null;
  if (String(orderBy[0]?.key || '') !== 'code') return null;
  if (String(orderBy[0]?.direction || 'asc').toLowerCase() !== 'asc') return null;
  if (!supportsEarlyStopMaterialize(node.members)) return null;

  const membershipWhere = lowerEarlyStopMembershipPredicate(node.members, ctx, scope, 'c');
  if (!membershipWhere) return null;

  const where = [];
  if (Number.isInteger(scope?.csId)) {
    where.push(binary('=', column('cs_id', 'c'), ctx.add('cs_id', scope.csId)));
  }
  if (ctx.runtime?.planner?.enableEarlyStopBudgetFunction) {
    where.push(call('sqlite_v0_budget', [column('concept_id', 'c')]));
  }
  where.push(lowerTerminalSelectionWhere(node.selection, ctx, scope, 'c', { members: node.members }));
  where.push(membershipWhere);

  return select({
    columns: (node.columns || []).map(col => aliasExpr(column(col, 'c'), col)),
    from: table('concept', 'c'),
    where: and(where),
    orderBy: orderBy.map(o => order(column(o.key, 'c'), o.direction)),
    limit: literal(node.count),
    offset: node.offset ? literal(node.offset) : null,
  });
}

function lowerCount(node, ctx, fallbackScope) {
  const scope = scopeFor(node, fallbackScope, ctx);
  const selected = selectCountLowering(node, ctx, scope);
  if (selected.lowered) {
    ctx.lastTerminalStrategy = selected.strategy;
    return selected.lowered;
  }
  ctx.lastTerminalStrategy = 'generic-count';
  return lowerGenericCount(node, ctx, scope);
}

function lowerGenericCount(node, ctx, scope) {
  const members = lowerSet(node.members, ctx, scopeFor(node.members, scope, ctx));
  const selectionWhere = lowerTerminalSelectionWhere(node.selection, ctx, scope, 'c', { members: node.members });
  if (!selectionWhere) {
    return select({
      columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
      from: subquery(members, 'm'),
    });
  }
  return select({
    columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
    from: subquery(members, 'm'),
    joins: [
      join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('concept_id', 'm'))),
    ],
    where: selectionWhere,
  });
}

function selectCountLowering(node, ctx, scope) {
  const strategy = chooseCountStrategy(node, ctx);
  const lower = {
    'code-regex-count': lowerCodeRegexCountFastPath,
    'supplement-literal-count': lowerSupplementLiteralCountFastPath,
    'reachability-code-regex-count': lowerReachabilityCodeRegexCountFastPath,
    'reachability-intersect-count': lowerReachabilityIntersectCountFastPath,
    'reachability-diff-count': lowerReachabilityDiffCountFastPath,
    'reachability-count': lowerReachabilityCountFastPath,
    'concept-driven-count': lowerConceptDrivenCountFastPath,
    'generic-count': null,
  }[strategy];
  return { strategy, lowered: typeof lower === 'function' ? lower(node, ctx, scope) : null };
}

function chooseTerminalLoweringStrategy(node, opts = {}) {
  return chooseTerminalStrategy(node, createContext(opts, node));
}

function lowerConceptDrivenCountFastPath(node, ctx, scope) {
  const text = node?.selection?.text != null ? String(node.selection.text).trim() : '';
  if (!text) return null;
  const membershipWhere = lowerEarlyStopMembershipPredicate(node.members, ctx, scopeFor(node.members, scope, ctx), 'c');
  if (!membershipWhere) return null;

  const where = [];
  if (Number.isInteger(scope?.csId)) {
    where.push(binary('=', column('cs_id', 'c'), ctx.add('count_cs_id', scope.csId)));
  }
  where.push(lowerTerminalSelectionWhere(node.selection, ctx, scope, 'c', { members: node.members }));
  where.push(membershipWhere);

  return select({
    columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
    from: table('concept', 'c'),
    where: and(where),
  });
}

function lowerCodeRegexCountFastPath(node, ctx, scope) {
  const extracted = extractCodeRegexFilter(node.members);
  if (!extracted) return null;
  const regexWhere = lowerCodeRegexConceptWhere(extracted.pattern, ctx, 'c');
  if (!regexWhere) return null;
  return select({
    columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
    from: table('concept', 'c'),
    where: and([
      Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('code_regex_count_cs_id', scope.csId)) : null,
      lowerTerminalSelectionWhere(node.selection, ctx, scope, 'c', { members: node.members }),
      regexWhere,
    ]),
  });
}

function lowerReachabilityCountFastPath(node, ctx, scope) {
  const selection = node.selection || {};
  const text = selection.text != null ? String(selection.text).trim() : '';
  if (text) return null;

  const reachability = extractSingleSeedClosureReachability(node.members);
  if (!reachability) return null;

  const seed = lowerSet(reachability.seed, ctx, scopeFor(reachability.seed, scope, ctx));
  const joins = [
    join('INNER', subquery(seed, 'seed'), binary('=', column('ancestor_id', 'cl'), column('concept_id', 'seed'))),
  ];
  const where = [
    reachability.includeSelf === false ? binary('!=', column('descendant_id', 'cl'), column('ancestor_id', 'cl')) : null,
  ];
  if (selection.activeOnly) {
    joins.push(join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('descendant_id', 'cl'))));
    where.push(binary('=', column('active', 'c'), literal(1)));
  }

  return select({
    columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
    from: table('closure', 'cl'),
    joins,
    where: and(where),
  });
}

function lowerReachabilityDiffCountFastPath(node, ctx, scope) {
  const selection = node.selection || {};
  const text = selection.text != null ? String(selection.text).trim() : '';
  if (text) return null;

  const diff = extractSingleSeedClosureReachabilityDiff(node.members);
  if (!diff) return null;

  const leftSeed = lowerSet(diff.left.seed, ctx, scopeFor(diff.left.seed, scope, ctx));
  const rightSeed = lowerSet(diff.right.seed, ctx, scopeFor(diff.right.seed, scope, ctx));
  const leftRows = lowerSeededClosureDescendantRows(diff.left, leftSeed);
  const rightRows = lowerSeededClosureDescendantRows(diff.right, rightSeed);

  const joins = [
    join('LEFT', subquery(rightRows, 'r'), binary('=', column('concept_id', 'r'), column('concept_id', 'l'))),
  ];
  const where = [
    binary('IS', column('concept_id', 'r'), literal(null)),
  ];
  if (selection.activeOnly) {
    joins.push(join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('concept_id', 'l'))));
    where.push(binary('=', column('active', 'c'), literal(1)));
    if (Number.isInteger(scope?.csId)) {
      where.push(binary('=', column('cs_id', 'c'), ctx.add('reach_diff_count_cs_id', scope.csId)));
    }
  }

  return select({
    columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
    from: subquery(leftRows, 'l'),
    joins,
    where: and(where),
  });
}

function lowerReachabilityIntersectCountFastPath(node, ctx, scope) {
  const selection = node.selection || {};
  const text = selection.text != null ? String(selection.text).trim() : '';
  if (text) return null;

  const intersect = extractSingleSeedClosureReachabilityIntersect(node.members);
  if (!intersect) return null;
  const { small, large } = chooseReachabilityIntersectSides(intersect, ctx);

  const smallSeed = lowerSet(small.seed, ctx, scopeFor(small.seed, scope, ctx));
  const largeSeed = lowerSet(large.seed, ctx, scopeFor(large.seed, scope, ctx));
  const smallRows = lowerSeededClosureDescendantRows(small, smallSeed);
  const largeRows = lowerSeededClosureDescendantRows(large, largeSeed);

  return select({
    columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
    from: subquery(smallRows, 's'),
    joins: [
      join('INNER', subquery(largeRows, 'l'), binary('=', column('concept_id', 'l'), column('concept_id', 's'))),
      join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('concept_id', 's'))),
    ],
    where: and([
      Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('reach_intersect_count_cs_id', scope.csId)) : null,
      selection.activeOnly ? binary('=', column('active', 'c'), literal(1)) : null,
    ]),
  });
}

function lowerReachabilityCodeRegexCountFastPath(node, ctx, scope) {
  return lowerReachabilityCodeRegexBaseQuery(node, ctx, scope, [
    aliasExpr(call('COUNT', [literal('*')]), 'cnt'),
  ]);
}

function lowerProbe(node, ctx, fallbackScope) {
  ctx.lastTerminalStrategy = 'probe';
  const scope = scopeFor(node, fallbackScope, ctx);
  const membershipWhere = lowerEarlyStopMembershipPredicate(
    node.members,
    ctx,
    scopeFor(node.members, scope, ctx),
    'c'
  );
  if (membershipWhere) {
    return select({
      columns: [aliasExpr(literal(1), 'found')],
      from: table('concept', 'c'),
      where: and([
        Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('probe_cs_id', scope.csId)) : null,
        binary('=', column('code', 'c'), ctx.add('check_code', String(node.code || ''))),
        membershipWhere,
      ]),
      limit: literal(1),
    });
  }

  const members = lowerSet(node.members, ctx, scopeFor(node.members, scope, ctx));
  return select({
    columns: [aliasExpr(literal(1), 'found')],
    from: subquery(members, 'm'),
    joins: [
      join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('concept_id', 'm'))),
    ],
    where: binary('=', column('code', 'c'), ctx.add('check_code', String(node.code || ''))),
    limit: literal(1),
  });
}

function lowerSupplementLiteralMaterializeFastPath(node, ctx, scope) {
  const selection = node.selection || {};
  const text = selection.text != null ? String(selection.text).trim() : '';
  if (text) return null;
  const sourceQuery = lowerSupplementLiteralSourceQuery(node.members, ctx, scope);
  if (!sourceQuery) return null;
  const conceptAlias = 'c';
  const where = [];
  if (Number.isInteger(scope?.csId)) {
    where.push(binary('=', column('cs_id', conceptAlias), ctx.add('supp_fast_cs_id', scope.csId)));
  }
  if (selection.activeOnly) {
    where.push(binary('=', column('active', conceptAlias), literal(1)));
  }
  return select({
    columns: (node.columns || []).map(col => aliasExpr(column(col, conceptAlias), col)),
    from: subquery(sourceQuery, 'sm'),
    joins: [
      join('INNER', table('concept', conceptAlias), binary('=', column('code', conceptAlias), column('source_code', 'sm'))),
    ],
    where: and(where),
    orderBy: (node.orderBy || []).map(o => order(column(o.key, conceptAlias), o.direction)),
    limit: node.count != null ? literal(node.count) : null,
    offset: node.offset ? literal(node.offset) : null,
  });
}

function lowerSupplementLiteralCountFastPath(node, ctx, scope) {
  const selection = node.selection || {};
  const text = selection.text != null ? String(selection.text).trim() : '';
  if (text) return null;
  const sourceQuery = lowerSupplementLiteralSourceQuery(node.members, ctx, scope);
  if (!sourceQuery) return null;
  if (selection.activeOnly) {
    return select({
      columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
      from: subquery(sourceQuery, 'sm'),
      joins: [
        join('INNER', table('concept', 'c'), binary('=', column('code', 'c'), column('source_code', 'sm'))),
      ],
      where: and([
        Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('supp_fast_count_cs_id', scope.csId)) : null,
        binary('=', column('active', 'c'), literal(1)),
      ]),
    });
  }
  return select({
    columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
    from: subquery(sourceQuery, 'sm'),
  });
}

function lowerTerminalSelectionWhere(selection, ctx, scope, conceptAlias = 'c', opts = {}) {
  if (!selection || typeof selection !== 'object') return null;
  const text = selection.text != null ? String(selection.text).trim() : '';
  const correlatedText =
    text && shouldUseCorrelatedRuntimeSearch(opts.members)
      ? lowerCorrelatedRuntimeSearchPredicate(text, ctx, scope, conceptAlias)
      : null;
  return and([
    selection.activeOnly ? binary('=', column('active', conceptAlias), literal(1)) : null,
    text
      ? (correlatedText || inQuery(column('concept_id', conceptAlias), lowerRuntimeSearch(runtimeSearchNode(text, ctx, scope), ctx, scope)))
      : null,
  ]);
}

function shouldUseCorrelatedRuntimeSearch(members, ceiling = 32) {
  const bound = boundedMembershipUpperLimit(members, ceiling);
  return Number.isInteger(bound) && bound >= 0 && bound <= ceiling;
}

function lowerSupplementLiteralSourceQuery(node, ctx, scope) {
  const predicates = extractSupplementLiteralMatchPredicates(node, ctx);
  if (!predicates || predicates.length === 0) return null;
  const queries = predicates.map(predicate => lowerSupplementLiteralSourceSet(predicate, ctx, scope));
  if (queries.some(q => !q)) return null;
  if (queries.length === 1) return queries[0];
  return compound('INTERSECT', queries);
}

function lowerSupplementLiteralSourceSet(predicate, ctx, scope) {
  const property = String(predicate?.property || '');
  const matches = ctx.supplementBindingsForProperty(property, { valueKind: 'literal' });
  if (matches.length === 0) return null;
  const queries = matches.map(({ binding, propertyDef }) => select({
    distinct: true,
    columns: [aliasExpr(column('source_code', 'sl'), 'source_code')],
    from: supplementTable(binding, 'supplement_literal', 'sl'),
    where: and([
      binary('=', column('active', 'sl'), literal(1)),
      binary('=', column('property_code', 'sl'), ctx.add('supp_fast_prop_code', property)),
      lowerTypedLiteralSupplementPredicate(predicate, propertyDef, 'sl', ctx),
    ]),
  }));
  if (queries.length === 1) return queries[0];
  return compound('UNION', queries);
}

function lowerEarlyStopMembershipPredicate(node, ctx, scope, conceptAlias) {
  if (!node || typeof node !== 'object') return null;
  switch (node.kind) {
  case 'empty':
    return literal(false);
  case 'allConcepts':
  case 'scan-all':
    return literal(true);
  case 'explicitCodes':
  case 'scan-codes':
    if (!Array.isArray(node.codes) || node.codes.length === 0) return literal(false);
    return {
      kind: 'in',
      expr: column('code', conceptAlias),
      items: node.codes.map(code => ctx.add('code', code)),
    };
  case 'union': {
    const items = (node.items || []).map(item => lowerEarlyStopMembershipPredicate(item, ctx, scopeFor(item, scope, ctx), conceptAlias));
    return items.some(item => !item) ? null : or(items);
  }
  case 'intersect': {
    const items = (node.items || []).map(item => lowerEarlyStopMembershipPredicate(item, ctx, scopeFor(item, scope, ctx), conceptAlias));
    return items.some(item => !item) ? null : and(items);
  }
  case 'diff': {
    const left = lowerEarlyStopMembershipPredicate(node.left, ctx, scopeFor(node.left, scope, ctx), conceptAlias);
    const right = lowerEarlyStopMembershipPredicate(node.right, ctx, scopeFor(node.right, scope, ctx), conceptAlias);
    if (!left || !right) return null;
    return and([left, unary('NOT', right)]);
  }
  case 'fromRows':
    if (extractKeyedRowSetOperation(node.rows, String(node.key || 'concept_id'))) {
      return inQuery(column('concept_id', conceptAlias), lowerSet(node, ctx, scope));
    }
    return lowerEarlyStopRowPredicate(
      node.rows,
      String(node.key || 'concept_id'),
      ctx,
      scopeFor(node.rows, scope, ctx),
      conceptAlias
    );
  default:
    return null;
  }
}

function lowerEarlyStopRowPredicate(node, membershipKey, ctx, scope, conceptAlias) {
  if (!node || typeof node !== 'object') return null;
  const specialized = lowerSpecialEarlyStopRowPredicate(node, membershipKey, ctx, scope, conceptAlias);
  if (specialized) return specialized;

  const rows = lowerRow(node, ctx, scope);
  return exists(select({
    columns: [aliasExpr(literal(1), 'found')],
    from: subquery(rows, 'r'),
    where: and([
      binary('=', column(membershipKey, 'r'), column('concept_id', conceptAlias)),
      binary('IS NOT', column(membershipKey, 'r'), literal(null)),
    ]),
  }));
}

function lowerSpecialEarlyStopRowPredicate(node, membershipKey, ctx, scope, conceptAlias) {
  if (membershipKey !== 'concept_id') return null;
  if (node.kind !== 'reachability' && node.kind !== 'row-reachability') return null;
  if (String(node.direction || 'down') !== 'down') return null;
  if ((node.relation?.storage || 'closure') !== 'closure') return null;

  const seed = lowerSet(node.seed, ctx, scopeFor(node.seed, scope, ctx));
  return exists(select({
    columns: [aliasExpr(literal(1), 'found')],
    from: table('closure', 'cl'),
    joins: [
      join('INNER', subquery(seed, 'seed'), binary('=', column('ancestor_id', 'cl'), column('concept_id', 'seed'))),
    ],
    where: and([
      binary('=', column('descendant_id', 'cl'), column('concept_id', conceptAlias)),
      node.includeSelf === false ? binary('!=', column('descendant_id', 'cl'), column('ancestor_id', 'cl')) : null,
    ]),
  }));
}

function lowerCodeRegexConceptWhere(pattern, ctx, alias = 'c') {
  const conditions = [];
  const range = codeRegexPrefixRange(pattern);
  if (range) {
    conditions.push(binary('>=', column('code', alias), ctx.add('code_regex_lo', range.lo)));
    conditions.push(binary('<', column('code', alias), ctx.add('code_regex_hi', range.hi)));
  }
  conditions.push(binary('REGEXP', column('code', alias), ctx.add('code_regex_pattern', String(pattern || ''))));
  return and(conditions);
}

function codeRegexPrefixRange(pattern) {
  const prefix = extractAnchoredRegexLiteralPrefix(pattern);
  if (!prefix) return null;
  const hi = nextLexicographicString(prefix);
  if (!hi) return null;
  return { lo: prefix, hi };
}

function extractAnchoredRegexLiteralPrefix(pattern) {
  const text = String(pattern || '');
  if (!text.startsWith('^')) return null;
  let prefix = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (!next) break;
      if (/^[^A-Za-z0-9]$/.test(next)) {
        prefix += next;
        i++;
        continue;
      }
      break;
    }
    if ('[](){}.+*?|$^'.includes(ch)) break;
    prefix += ch;
  }
  return prefix || null;
}

function nextLexicographicString(value) {
  const chars = Array.from(String(value || ''));
  if (chars.length === 0) return null;
  const last = chars.pop();
  const code = last.codePointAt(0);
  if (!Number.isInteger(code) || code >= 0x10ffff) return null;
  chars.push(String.fromCodePoint(code + 1));
  return chars.join('');
}

function unwrapDistinctKeyedRows(node, key) {
  let rows = node || null;
  while (rows
      && (rows.kind === 'distinct' || rows.kind === 'row-distinct')
      && Array.isArray(rows.keys)
      && rows.keys.length === 1
      && rows.keys[0] === key) {
    rows = rows.input || null;
  }
  return rows;
}

function extractKeyedRowSetOperation(node, key) {
  const rows = unwrapDistinctKeyedRows(node, key);
  if (!rows || typeof rows !== 'object') return null;
  if ((rows.kind !== 'semiJoin' && rows.kind !== 'row-semiJoin'
      && rows.kind !== 'antiJoin' && rows.kind !== 'row-antiJoin')
      || rows.on?.kind !== 'eq'
      || rows.on?.leftField !== key
      || rows.on?.rightField !== key) {
    return null;
  }
  return {
    op: rows.kind === 'antiJoin' || rows.kind === 'row-antiJoin' ? 'EXCEPT' : 'INTERSECT',
    left: rows.left,
    right: rows.right,
  };
}

function lowerRowKeySet(node, key, ctx, scope) {
  const rows = lowerRow(node, ctx, scopeFor(node, scope, ctx));
  return select({
    distinct: true,
    columns: [aliasExpr(column(key, 'r'), 'concept_id')],
    from: subquery(rows, 'r'),
    where: binary('IS NOT', column(key, 'r'), literal(null)),
  });
}

function lowerSet(node, ctx, fallbackScope) {
  const scope = scopeFor(node, fallbackScope, ctx);
  switch (node?.kind) {
  case 'empty':
    return select({
      columns: [aliasExpr(literal(null), 'concept_id')],
      where: literal(false),
    });
  case 'allConcepts':
  case 'scan-all':
    return scopedConceptSelect(scope, [aliasExpr(column('concept_id', 'c'), 'concept_id')], null, ctx);
  case 'explicitCodes':
  case 'scan-codes': {
    if (!Array.isArray(node.codes) || node.codes.length === 0) {
      return lowerSet({ kind: 'empty' }, ctx, scope);
    }
    return scopedConceptSelect(scope, [aliasExpr(column('concept_id', 'c'), 'concept_id')], {
      kind: 'in',
      expr: column('code', 'c'),
      items: node.codes.map(code => ctx.add('code', code)),
    }, ctx);
  }
  case 'fromRows': {
    const key = String(node.key || 'concept_id');
    const setOp = extractKeyedRowSetOperation(node.rows, key);
    if (setOp) {
      return compound(setOp.op, [
        lowerRowKeySet(setOp.left, key, ctx, scope),
        lowerRowKeySet(setOp.right, key, ctx, scope),
      ]);
    }
    const rows = lowerRow(node.rows, ctx, scope);
    return select({
      distinct: true,
      columns: [aliasExpr(column(key, 'r'), 'concept_id')],
      from: subquery(rows, 'r'),
      where: binary('IS NOT', column(key, 'r'), literal(null)),
    });
  }
  case 'union':
    return compound('UNION', (node.items || []).map(item => lowerSet(item, ctx, scopeFor(item, scope, ctx))));
  case 'intersect':
    return compound('INTERSECT', (node.items || []).map(item => lowerSet(item, ctx, scopeFor(item, scope, ctx))));
  case 'diff':
    return compound('EXCEPT', [
      lowerSet(node.left, ctx, scopeFor(node.left, scope, ctx)),
      lowerSet(node.right, ctx, scopeFor(node.right, scope, ctx)),
    ]);
  default:
    throw new Error(`Unknown physical set plan kind ${String(node?.kind || '(missing)')}`);
  }
}

function lowerRow(node, ctx, fallbackScope) {
  const scope = scopeFor(node, fallbackScope, ctx);
  switch (node?.kind) {
  case 'row-empty':
    return select({
      columns: [aliasExpr(literal(null), 'concept_id')],
      where: literal(false),
    });
  case 'scan':
  case 'row-scan':
    return lowerRowScan(node, ctx, scope);
  case 'filter':
  case 'row-filter':
    return lowerRuntimeRowFilter(node, ctx, scope);
  case 'project':
  case 'row-project':
    return select({
      columns: (node.columns || []).map(col => aliasExpr(column(col, 'rp'), col)),
      from: subquery(lowerRow(node.input, ctx, scopeFor(node.input, scope, ctx)), 'rp'),
    });
  case 'join':
  case 'row-join':
  case 'semiJoin':
  case 'row-semiJoin':
  case 'antiJoin':
  case 'row-antiJoin':
    return lowerRowJoin(node, ctx, scope);
  case 'unionAll':
  case 'row-unionAll':
    return compound('UNION ALL', (node.inputs || []).map(input => lowerRow(input, ctx, scopeFor(input, scope, ctx))));
  case 'distinct':
  case 'row-distinct':
    return select({
      distinct: true,
      columns: (node.keys || []).map(key => aliasExpr(column(key, 'rd'), key)),
      from: subquery(lowerRow(node.input, ctx, scopeFor(node.input, scope, ctx)), 'rd'),
    });
  case 'reachability':
  case 'row-reachability':
    return lowerRuntimeReachability(node, ctx, scope);
  case 'search':
  case 'row-search':
    return lowerRuntimeSearch(node, ctx, scope);
  case 'values':
  case 'row-values':
    return lowerRowValues(node);
  default:
    throw new Error(`Unknown physical row plan kind ${String(node?.kind || '(missing)')}`);
  }
}

function scopedConceptSelect(scope, columns, extraWhere, ctx) {
  const where = [];
  if (Number.isInteger(scope?.csId)) {
    where.push(binary('=', column('cs_id', 'c'), ctx.add('cs_id', scope.csId)));
  }
  if (extraWhere) where.push(extraWhere);
  return select({
    columns,
    from: table('concept', 'c'),
    where: and(where),
  });
}

function lowerRowScan(node, ctx, scope) {
  const alias = scanAlias(node.table);
  const where = [];
  if (Number.isInteger(scope?.csId) && node.table === 'concept') {
    where.push(binary('=', column('cs_id', alias), ctx.add('cs_id', scope.csId)));
  }
  return select({
    columns: [aliasExpr(literal('*'), '*')],
    from: table(node.table, alias),
    where: and(where),
  });
}

function lowerRuntimeRowFilter(node, ctx, scope) {
  const predicate = node.predicate || {};
  const input = node.input || null;

  if (predicate.kind === 'valueSetUrlEq' && isScanOf(input, 'value_set_member')) {
    const conditions = [
      binary('=', column('active', 'vsm'), literal(1)),
      binary('=', column('url', 'vs'), ctx.add('vs_url', String(predicate.url || ''))),
    ];
    if (Number.isInteger(scope?.csId)) {
      conditions.push(binary('=', column('cs_id', 'vs'), ctx.add('vs_cs_id', scope.csId)));
    }
    return select({
      columns: [
        aliasExpr(column('concept_id', 'vsm'), 'concept_id'),
        aliasExpr(column('vs_id', 'vsm'), 'vs_id'),
        aliasExpr(column('active', 'vsm'), 'active'),
      ],
      from: table('value_set_member', 'vsm'),
      joins: [
        join('INNER', table('value_set', 'vs'), binary('=', column('vs_id', 'vs'), column('vs_id', 'vsm'))),
      ],
      where: and(conditions),
    });
  }

  if ((predicate.kind === 'literalPropertyMatch' || predicate.kind === 'literalPropertyRegex')
      && isScanOf(input, 'concept_literal')) {
    const propDef = ctx.propertyDef(predicate.property) || null;
    const queries = [];
    if (Number.isInteger(propDef?.property_id)) {
      const conditions = [
        binary('=', column('property_id', 'cl'), ctx.add('prop_id', propDef.property_id)),
        binary('=', column('active', 'cl'), literal(1)),
        Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'src'), ctx.add('literal_cs_id', scope.csId)) : null,
      ];
      if (predicate.kind === 'literalPropertyMatch') {
        conditions.push(lowerLiteralPropertyMatchPredicate(predicate, 'cl', ctx));
      } else {
        conditions.push(binary('REGEXP', call('COALESCE', [column('value_text', 'cl'), column('value_raw', 'cl'), literal('')]), ctx.add('regex', String(predicate.pattern || ''))));
      }
      queries.push(select({
        columns: [aliasExpr(literal('*'), '*')],
        from: table('concept_literal', 'cl'),
        joins: [
          join('INNER', table('concept', 'src'), binary('=', column('concept_id', 'src'), column('source_concept_id', 'cl'))),
        ],
        where: and(conditions),
      }));
    }
    const literalBindings = ctx.supplementBindingsForProperty(predicate.property, { valueKind: 'literal' });
    if (literalBindings.length > 0) {
      const suppPredicate = predicate.kind === 'literalPropertyMatch'
        ? and([
          binary('=', column('property_code', 'sl'), ctx.add('supp_prop_code', String(predicate.property || ''))),
          lowerLiteralSupplementMatchPredicate(predicate, 'sl', ctx),
        ])
        : and([
          binary('=', column('property_code', 'sl'), ctx.add('supp_prop_code', String(predicate.property || ''))),
          binary('REGEXP', call('COALESCE', [column('value_text', 'sl'), column('value_raw', 'sl'), literal('')]), ctx.add('supp_regex', String(predicate.pattern || ''))),
        ]);
      for (const { binding } of literalBindings) {
        queries.push(supplementLiteralQuery(binding, ctx, scope, suppPredicate));
      }
    }
    if (queries.length === 0) {
      if (propDef) {
        return select({
          columns: [aliasExpr(literal('*'), '*')],
          where: literal(false),
        });
      }
      throw new Error(`Missing sqlite-v0 property definition for ${String(predicate.property || '(missing)')}`);
    }
    if (queries.length === 1) return queries[0];
    return compound('UNION ALL', queries);
  }

  if (predicate.kind === 'linkPropertyMatch' && isScanOf(input, 'concept_link')) {
    const propDef = ctx.propertyDef(predicate.property) || null;
    const queries = [];
    const values = (predicate.values || []).map(v => ctx.add('prop_value', String(v)));
    const codeMatch = {
      kind: 'in',
      expr: collate(column('code', 'tgt'), 'NOCASE'),
      items: values,
    };
    const displayMatch = {
      kind: 'in',
      expr: collate(column('display', 'tgt'), 'NOCASE'),
      items: values,
    };
    if (Number.isInteger(propDef?.property_id)) {
      queries.push(select({
        columns: [aliasExpr(literal('*'), '*')],
        from: table('concept_link', 'l'),
        joins: [
          join('INNER', table('concept', 'src'), binary('=', column('concept_id', 'src'), column('source_concept_id', 'l'))),
          join('INNER', table('concept', 'tgt'), binary('=', column('concept_id', 'tgt'), column('target_concept_id', 'l'))),
        ],
        where: and([
          binary('=', column('property_id', 'l'), ctx.add('prop_id', propDef.property_id)),
          binary('=', column('edge_set_id', 'l'), ctx.add('edge_set_id', normalizeEdgeSetId(ctx.runtime?.hierarchy?.edgeSetId))),
          binary('=', column('active', 'l'), literal(1)),
          Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'src'), ctx.add('link_cs_id', scope.csId)) : null,
          predicate.linkMatch === 'code-or-display' ? or([codeMatch, displayMatch]) : codeMatch,
        ]),
      }));
    }
    const linkBindings = ctx.supplementBindingsForProperty(predicate.property, { valueKind: 'concept' });
    if (linkBindings.length > 0) {
      const suppValues = (predicate.values || []).map(v => ctx.add('supp_prop_value', String(v)));
      const suppCodeMatch = {
        kind: 'in',
        expr: collate(column('target_code', 'sl'), 'NOCASE'),
        items: suppValues,
      };
      const suppDisplayMatch = {
        kind: 'in',
        expr: collate(column('display', 'tgt'), 'NOCASE'),
        items: suppValues,
      };
      const suppPredicate = and([
        binary('=', column('property_code', 'sl'), ctx.add('supp_link_prop_code', String(predicate.property || ''))),
        predicate.linkMatch === 'code-or-display' ? or([suppCodeMatch, suppDisplayMatch]) : suppCodeMatch,
      ]);
      for (const { binding } of linkBindings) {
        queries.push(supplementLinkQuery(binding, ctx, scope, suppPredicate));
      }
    }
    if (queries.length === 0) {
      if (propDef) {
        return select({
          columns: [aliasExpr(literal('*'), '*')],
          where: literal(false),
        });
      }
      throw new Error(`Missing sqlite-v0 property definition for ${String(predicate.property || '(missing)')}`);
    }
    if (queries.length === 1) return queries[0];
    return compound('UNION ALL', queries);
  }

  return select({
    columns: [aliasExpr(literal('*'), '*')],
    from: subquery(lowerRow(node.input, ctx, scopeFor(node.input, scope, ctx)), 'rf'),
    where: lowerPredicate(node.predicate, 'rf', ctx),
  });
}

function lowerRowJoin(node, ctx, scope) {
  const left = lowerRow(node.left, ctx, scopeFor(node.left, scope, ctx));
  const right = lowerRow(node.right, ctx, scopeFor(node.right, scope, ctx));
  if (node.kind === 'row-semiJoin' || node.kind === 'semiJoin') {
    return select({
      columns: [aliasExpr(literal('*'), '*')],
      from: subquery(left, 'sjl'),
      where: exists(select({
        columns: [aliasExpr(literal(1), 'found')],
        from: subquery(right, 'sjr'),
        where: lowerJoinExpr(node.on, 'sjl', 'sjr'),
      })),
    });
  }
  if (node.kind === 'row-antiJoin' || node.kind === 'antiJoin') {
    return select({
      columns: [aliasExpr(literal('*'), '*')],
      from: subquery(left, 'ajl'),
      where: unary('NOT', exists(select({
        columns: [aliasExpr(literal(1), 'found')],
        from: subquery(right, 'ajr'),
        where: lowerJoinExpr(node.on, 'ajl', 'ajr'),
      }))),
    });
  }
  return select({
    columns: [aliasExpr(literal('*'), '*')],
    from: subquery(left, 'jl'),
    joins: [
      join(isLeftJoinNode(node) ? 'LEFT' : 'INNER', subquery(right, 'jr'), lowerJoinExpr(node.on, 'jl', 'jr')),
    ],
  });
}

function lowerUnifiedLinkRelation(propertyCode, ctx, scope, relation = null) {
  const propDef = ctx.propertyDef(propertyCode) || null;
  const queries = [];
  if (Number.isInteger(propDef?.property_id)) {
    const filters = [
      binary('=', column('property_id', 'l'), ctx.add('reach_prop_id', propDef.property_id)),
      binary('=', column('edge_set_id', 'l'), ctx.add('reach_edge_set_id', normalizeEdgeSetId(relation?.edgeSetId ?? ctx.runtime?.hierarchy?.edgeSetId))),
      binary('=', column('active', 'l'), literal(1)),
    ];
    if (Number.isInteger(scope?.csId)) {
      filters.push(binary('=', column('cs_id', 'src'), ctx.add('reach_src_cs_id', scope.csId)));
      filters.push(binary('=', column('cs_id', 'tgt'), ctx.add('reach_tgt_cs_id', scope.csId)));
    }
    queries.push(select({
      columns: [
        aliasExpr(column('source_concept_id', 'l'), 'source_concept_id'),
        aliasExpr(column('target_concept_id', 'l'), 'target_concept_id'),
        aliasExpr(column('active', 'l'), 'active'),
      ],
      from: table('concept_link', 'l'),
      joins: [
        join('INNER', table('concept', 'src'), binary('=', column('concept_id', 'src'), column('source_concept_id', 'l'))),
        join('INNER', table('concept', 'tgt'), binary('=', column('concept_id', 'tgt'), column('target_concept_id', 'l'))),
      ],
      where: and(filters),
    }));
  }
  const linkBindings = ctx.supplementBindingsForProperty(propertyCode, { valueKind: 'concept' });
  if (linkBindings.length > 0) {
    const suppPredicate = binary('=', column('property_code', 'sl'), ctx.add('supp_reach_prop_code', String(propertyCode || '')));
    for (const { binding } of linkBindings) {
      queries.push(supplementLinkQuery(binding, ctx, scope, suppPredicate));
    }
  }
  if (queries.length === 0) {
    throw new Error(`Missing sqlite-v0 property definition for ${String(propertyCode || '(missing)')}`);
  }
  if (queries.length === 1) return queries[0];
  return compound('UNION ALL', queries);
}

function lowerRuntimeReachability(node, ctx) {
  const seed = lowerSet(node.seed, ctx, scopeFor(node.seed, node.scope, ctx));
  if ((node.relation?.key || node.relation?.property) === 'concept') {
    const leftField = node.direction === 'up' ? 'descendant_id' : 'ancestor_id';
    const outField = node.direction === 'up' ? 'ancestor_id' : 'descendant_id';
    const filters = [];
    if (node.includeSelf === false) {
      filters.push(binary('!=', column(outField, 'cl'), column(leftField, 'cl')));
    }
    return select({
      distinct: true,
      columns: [aliasExpr(column(outField, 'cl'), 'concept_id')],
      from: table('closure', 'cl'),
      joins: [
        join('INNER', subquery(seed, 'seed'), binary('=', column(leftField, 'cl'), column('concept_id', 'seed'))),
      ],
      where: and(filters),
    });
  }

  const relationProperty = String(node.relation?.property || '');
  if (!relationProperty) {
    throw new Error(`Runtime reachability requires a property-backed relation, got ${String(node.relation?.key || '(missing)')}`);
  }
  const seedName = 'seed_rel';
  const walkName = 'walk_rel';
  const stepLeft = node.direction === 'up' ? 'source_concept_id' : 'target_concept_id';
  const stepOut = node.direction === 'up' ? 'target_concept_id' : 'source_concept_id';
  const relationRows = lowerUnifiedLinkRelation(relationProperty, ctx, node.scope, node.relation);

  return withQuery({
    recursive: true,
    ctes: [
      cte(seedName, select({
        distinct: true,
        columns: [aliasExpr(column('concept_id', 'seed'), 'concept_id')],
        from: subquery(seed, 'seed'),
      }), ['concept_id']),
      cte(walkName, compound('UNION', [
        select({
          columns: [aliasExpr(column('concept_id', 's'), 'concept_id')],
          from: table(seedName, 's'),
        }),
        select({
          columns: [aliasExpr(column(stepOut, 'l'), 'concept_id')],
          from: subquery(relationRows, 'l'),
          joins: [
            join('INNER', table(walkName, 'w'), binary('=', column(stepLeft, 'l'), column('concept_id', 'w'))),
          ],
        }),
      ]), ['concept_id']),
    ],
    body: select({
      distinct: true,
      columns: [aliasExpr(column('concept_id', 'w'), 'concept_id')],
      from: table(walkName, 'w'),
      where: node.includeSelf === false
        ? unary('NOT', exists(select({
          columns: [aliasExpr(literal(1), 'found')],
          from: table(seedName, 's'),
          where: binary('=', column('concept_id', 's'), column('concept_id', 'w')),
        })))
        : null,
    }),
  });
}

function lowerRowValues(node) {
  const columns = Array.isArray(node.columns) ? node.columns.map(String).filter(Boolean) : [];
  const rows = Array.isArray(node.rows) ? node.rows : [];
  if (columns.length === 0 || rows.length === 0) {
    return select({
      columns: columns.map(col => aliasExpr(literal(null), col)),
      where: literal(false),
    });
  }
  const queries = rows.map(row => select({
    columns: columns.map((col, idx) => aliasExpr(literal(Array.isArray(row) ? row[idx] : null), col)),
  }));
  if (queries.length === 1) return queries[0];
  return compound('UNION ALL', queries);
}


function lowerPredicate(predicate, alias, ctx) {
  if (!predicate || typeof predicate !== 'object') return null;
  switch (predicate.kind) {
  case 'activeEquals':
    return binary('=', column('active', alias), literal(predicate.value !== false ? 1 : 0));
  case 'codeRegex':
    return binary('REGEXP', column('code', alias), ctx.add('regex', String(predicate.pattern || '')));
  case 'valueSetUrlEq':
    return binary('=', column('url', alias), ctx.add('vs_url', String(predicate.url || '')));
  case 'literalPropertyMatch': {
    const propDef = requirePropertyDef(ctx, predicate.property);
    return and([
      binary('=', column('property_id', alias), ctx.add('prop_id', propDef.property_id)),
      binary('=', column('active', alias), literal(1)),
      lowerLiteralPropertyMatchPredicate(predicate, alias, ctx),
    ]);
  }
  case 'literalPropertyRegex': {
    const propDef = requirePropertyDef(ctx, predicate.property);
    return and([
      binary('=', column('property_id', alias), ctx.add('prop_id', propDef.property_id)),
      binary('=', column('active', alias), literal(1)),
      binary('REGEXP', call('COALESCE', [column('value_text', alias), column('value_raw', alias), literal('')]), ctx.add('regex', String(predicate.pattern || ''))),
    ]);
  }
  case 'literalPropertyExists': {
    const propDef = requirePropertyDef(ctx, predicate.property);
    return and([
      binary('=', column('property_id', alias), ctx.add('prop_id', propDef.property_id)),
      binary('=', column('active', alias), literal(1)),
    ]);
  }
  case 'linkPropertyMatch': {
    const values = (predicate.values || []).map(v => ctx.add('prop_value', String(v)));
    const codeMatch = {
      kind: 'in',
      expr: collate(column('code', alias), 'NOCASE'),
      items: values,
    };
    const displayMatch = {
      kind: 'in',
      expr: collate(column('display', alias), 'NOCASE'),
      items: values,
    };
    return and([
      binary('=', column('property_id', alias), ctx.add('prop_id', requirePropertyDef(ctx, predicate.property).property_id)),
      binary('=', column('active', alias), literal(1)),
      predicate.linkMatch === 'code-or-display' ? or([codeMatch, displayMatch]) : codeMatch,
    ]);
  }
  case 'linkPropertyExists':
    return and([
      binary('=', column('property_id', alias), ctx.add('prop_id', requirePropertyDef(ctx, predicate.property).property_id)),
      binary('=', column('active', alias), literal(1)),
    ]);
  default:
    throw new Error(`Unknown predicate kind ${String(predicate.kind || '(missing)')}`);
  }
}

function lowerJoinExpr(expr, leftAlias, rightAlias) {
  if (!expr || typeof expr !== 'object') return null;
  switch (expr.kind) {
  case 'eq':
    return binary('=', column(expr.leftField, leftAlias), column(expr.rightField, rightAlias));
  default:
    throw new Error(`Unknown join expression kind ${String(expr.kind || '(missing)')}`);
  }
}

function lowerLiteralPropertyMatchPredicate(predicate, alias, ctx) {
  const values = (predicate.values || []).map(v => ctx.add('prop_value', String(v)));
  return or([
    {
      kind: 'in',
      expr: collate(column('value_text', alias), 'NOCASE'),
      items: values,
    },
    and([
      binary('IS', column('value_text', alias), literal(null)),
      {
        kind: 'in',
        expr: collate(column('value_raw', alias), 'NOCASE'),
        items: values,
      },
    ]),
  ]);
}

function lowerLiteralSupplementMatchPredicate(predicate, alias, ctx) {
  const values = (predicate.values || []).map(v => ctx.add('supp_prop_value', String(v)));
  return or([
    {
      kind: 'in',
      expr: collate(column('value_text', alias), 'NOCASE'),
      items: values,
    },
    and([
      binary('IS', column('value_text', alias), literal(null)),
      {
        kind: 'in',
        expr: collate(column('value_raw', alias), 'NOCASE'),
        items: values,
      },
    ]),
  ]);
}

function lowerTypedLiteralSupplementPredicate(predicate, propertyDef, alias, ctx) {
  const sourceType = String(propertyDef?.source_type || '').trim().toLowerCase();
  const rawValues = (predicate.values || []).map(v => String(v));
  if ((sourceType === 'integer' || sourceType === 'decimal') && rawValues.length > 0) {
    const nums = rawValues.map(v => Number(v));
    if (nums.every(v => Number.isFinite(v))) {
      return {
        kind: 'in',
        expr: column('value_num', alias),
        items: nums.map(v => ctx.add('supp_prop_num', v)),
      };
    }
  }
  if (sourceType === 'boolean' && rawValues.length > 0) {
    const bools = rawValues.map(v => {
      const lowered = v.trim().toLowerCase();
      if (lowered === 'true' || lowered === '1') return 1;
      if (lowered === 'false' || lowered === '0') return 0;
      return null;
    });
    if (bools.every(v => v === 0 || v === 1)) {
      return {
        kind: 'in',
        expr: column('value_bool', alias),
        items: bools.map(v => ctx.add('supp_prop_bool', v)),
      };
    }
  }
  return lowerLiteralSupplementMatchPredicate(predicate, alias, ctx);
}

function isLeftJoinNode(node) {
  return String(node?.joinType || '') === 'left' || String(node?.strategy || '') === 'left-join';
}


function scanAlias(tableName) {
  switch (String(tableName || '')) {
  case 'concept':
    return 'c';
  case 'concept_literal':
    return 'cl';
  case 'concept_link':
    return 'l';
  case 'designation':
    return 'd';
  case 'value_set_member':
    return 'vsm';
  case 'value_set':
    return 'vs';
  default:
    return 't';
  }
}

function requirePropertyDef(ctx, propertyCode) {
  const propDef = ctx.propertyDef(propertyCode);
  if (!propDef || !Number.isInteger(propDef.property_id)) {
    throw new Error(`Missing sqlite-v0 property definition for ${String(propertyCode || '(missing)')}`);
  }
  return propDef;
}

function normalizeEdgeSetId(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

module.exports = {
  aliasExpr,
  and,
  binary,
  call,
  column,
  compound,
  collate,
  exists,
  inQuery,
  join,
  list,
  literal,
  lowerPhysicalPlanToSqlAst,
  order,
  or,
  param,
  select,
  sqlAstStructuralForm,
  subquery,
  table,
  cte,
  unary,
  withQuery,
  __testing: {
    chooseTerminalLoweringStrategy,
  },
};
