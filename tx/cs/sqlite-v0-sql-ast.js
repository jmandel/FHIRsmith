'use strict';

function table(name, alias = null) {
  return { kind: 'table', name: String(name || ''), alias: alias != null ? String(alias) : null };
}

function subquery(query, alias) {
  return { kind: 'subquery', query, alias: String(alias || '') };
}

function column(name, tableAlias = null) {
  return { kind: 'column', name: String(name || ''), tableAlias: tableAlias != null ? String(tableAlias) : null };
}

function literal(value) {
  return { kind: 'literal', value };
}

function param(name) {
  return { kind: 'param', name: String(name || '') };
}

function call(name, args = []) {
  return { kind: 'call', name: String(name || ''), args: Array.isArray(args) ? args : [] };
}

function binary(op, left, right) {
  return { kind: 'binary', op: String(op || '='), left, right };
}

function unary(op, expr) {
  return { kind: 'unary', op: String(op || 'NOT'), expr };
}

function list(items = []) {
  return { kind: 'list', items: Array.isArray(items) ? items : [] };
}

function and(items = []) {
  const flat = [];
  for (const item of items || []) {
    if (!item) continue;
    if (item.kind === 'and') flat.push(...(item.items || []));
    else flat.push(item);
  }
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0];
  return { kind: 'and', items: flat };
}

function or(items = []) {
  const flat = [];
  for (const item of items || []) {
    if (!item) continue;
    if (item.kind === 'or') flat.push(...(item.items || []));
    else flat.push(item);
  }
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0];
  return { kind: 'or', items: flat };
}

function select({
  columns = [],
  from = null,
  joins = [],
  where = null,
  distinct = false,
  orderBy = [],
  limit = null,
  offset = null,
} = {}) {
  return {
    kind: 'select',
    columns: Array.isArray(columns) ? columns : [],
    from,
    joins: Array.isArray(joins) ? joins : [],
    where,
    distinct: !!distinct,
    orderBy: Array.isArray(orderBy) ? orderBy : [],
    limit,
    offset,
  };
}

function compound(op, queries = []) {
  return {
    kind: 'compound',
    op: String(op || 'UNION'),
    queries: Array.isArray(queries) ? queries : [],
  };
}

function cte(name, query, columns = []) {
  return {
    kind: 'cte',
    name: String(name || ''),
    query,
    columns: Array.isArray(columns) ? columns.map(String).filter(Boolean) : [],
  };
}

function withQuery({ recursive = false, ctes = [], body = null } = {}) {
  return {
    kind: 'with',
    recursive: !!recursive,
    ctes: Array.isArray(ctes) ? ctes.filter(Boolean) : [],
    body,
  };
}

function join(joinType, source, on) {
  return {
    kind: 'join',
    joinType: String(joinType || 'INNER').toUpperCase(),
    source,
    on,
  };
}

function order(key, direction = 'asc') {
  return {
    key,
    direction: String(direction || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC',
  };
}

function aliasExpr(expr, alias) {
  return { kind: 'alias', expr, alias: String(alias || '') };
}

function collate(expr, collation) {
  return {
    kind: 'collate',
    expr,
    collation: String(collation || '').toUpperCase(),
  };
}

function exists(query) {
  return { kind: 'exists', query };
}

function inQuery(expr, query) {
  return { kind: 'inQuery', expr, query };
}

function lowerPhysicalPlanToSqlAst(plan, opts = {}) {
  const ctx = createContext(opts, plan);
  const ast = lowerPhysical(plan, ctx, resolveScope(plan?.scope || opts.scope || null));
  return { ast, params: ctx.params };
}

function createContext(opts, plan) {
  const propertyDefs = opts.propertyDefs instanceof Map ? opts.propertyDefs : new Map();
  const runtime = opts.runtime || {};
  return {
    next: 0,
    params: {},
    propertyDefs,
    runtime,
    fallbackScope: resolveScope(opts.scope || plan?.scope || null),
    add(prefix, value) {
      const name = `${String(prefix || 'p')}_${this.next++}`;
      this.params[name] = value;
      return param(name);
    },
    propertyDef(propertyCode) {
      return this.propertyDefs.get(String(propertyCode || '')) || null;
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
  if (node.includeTotal === true) {
    return lowerMaterializeWithTotal(node, ctx, scope);
  }
  const fastPath = lowerEarlyStopMaterialize(node, ctx, scope);
  if (fastPath) return fastPath;
  const members = lowerSet(node.members, ctx, scopeFor(node.members, scope, ctx));
  const fromAlias = 'm';
  const conceptAlias = 'c';
  return select({
    columns: (node.columns || []).map(col => aliasExpr(column(col, conceptAlias), col)),
    from: subquery(members, fromAlias),
    joins: [
      join('INNER', table('concept', conceptAlias), binary('=', column('concept_id', conceptAlias), column('concept_id', fromAlias))),
    ],
    where: lowerTerminalSelectionWhere(node.selection, ctx, scope, conceptAlias),
    orderBy: (node.orderBy || []).map(o => order(column(o.key, conceptAlias), o.direction)),
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
  const members = lowerSet(node.members, ctx, scopeFor(node.members, scope, ctx));
  const fromAlias = 'm';
  const conceptAlias = 'c';
  return select({
    columns,
    from: subquery(members, fromAlias),
    joins: [
      join('INNER', table('concept', conceptAlias), binary('=', column('concept_id', conceptAlias), column('concept_id', fromAlias))),
    ],
    where: lowerTerminalSelectionWhere(node.selection, ctx, scope, conceptAlias),
  });
}

function lowerEarlyStopMaterialize(node, ctx, scope) {
  const selection = node.selection || {};
  const orderBy = Array.isArray(node.orderBy) ? node.orderBy : [];
  if (!Number.isInteger(node.count) || node.count <= 0 || node.count > 200) return null;
  if (Number.isInteger(node.offset) && node.offset > 0) return null;
  if (orderBy.length !== 1) return null;
  if (String(orderBy[0]?.key || '') !== 'code') return null;
  if (String(orderBy[0]?.direction || 'asc').toLowerCase() !== 'asc') return null;

  const membershipWhere = lowerEarlyStopMembershipPredicate(node.members, ctx, scope, 'c');
  if (!membershipWhere) return null;

  const where = [];
  if (Number.isInteger(scope?.csId)) {
    where.push(binary('=', column('cs_id', 'c'), ctx.add('cs_id', scope.csId)));
  }
  where.push(lowerTerminalSelectionWhere(node.selection, ctx, scope, 'c'));
  where.push(membershipWhere);

  return select({
    columns: (node.columns || []).map(col => aliasExpr(column(col, 'c'), col)),
    from: table('concept', 'c'),
    where: and(where),
    orderBy: orderBy.map(o => order(column(o.key, 'c'), o.direction)),
    limit: literal(node.count),
  });
}

function lowerCount(node, ctx, fallbackScope) {
  const scope = scopeFor(node, fallbackScope, ctx);
  const fastPath = lowerReachabilityCountFastPath(node, ctx, scope);
  if (fastPath) return fastPath;
  const conceptDrivenFastPath = lowerConceptDrivenCountFastPath(node, ctx, scope);
  if (conceptDrivenFastPath) return conceptDrivenFastPath;
  const members = lowerSet(node.members, ctx, scopeFor(node.members, scope, ctx));
  const selectionWhere = lowerTerminalSelectionWhere(node.selection, ctx, scope, 'c');
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

function lowerConceptDrivenCountFastPath(node, ctx, scope) {
  const text = node?.selection?.text != null ? String(node.selection.text).trim() : '';
  if (!text) return null;
  const membershipWhere = lowerEarlyStopMembershipPredicate(node.members, ctx, scopeFor(node.members, scope, ctx), 'c');
  if (!membershipWhere) return null;

  const where = [];
  if (Number.isInteger(scope?.csId)) {
    where.push(binary('=', column('cs_id', 'c'), ctx.add('count_cs_id', scope.csId)));
  }
  where.push(lowerTerminalSelectionWhere(node.selection, ctx, scope, 'c'));
  where.push(membershipWhere);

  return select({
    columns: [aliasExpr(call('COUNT', [literal('*')]), 'cnt')],
    from: table('concept', 'c'),
    where: and(where),
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

function lowerProbe(node, ctx, fallbackScope) {
  const scope = scopeFor(node, fallbackScope, ctx);
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

function lowerTerminalSelectionWhere(selection, ctx, scope, conceptAlias = 'c') {
  if (!selection || typeof selection !== 'object') return null;
  const text = selection.text != null ? String(selection.text).trim() : '';
  return and([
    selection.activeOnly ? binary('=', column('active', conceptAlias), literal(1)) : null,
    text ? inQuery(column('concept_id', conceptAlias), lowerRuntimeSearch(runtimeSearchNode(text, ctx, scope), ctx, scope)) : null,
  ]);
}

function runtimeSearchNode(text, ctx, scope) {
  return {
    kind: 'row-search',
    text,
    spec: runtimeSearchSpec(ctx.runtime?.search),
    ftsTables: runtimeFtsTables(ctx.runtime?.search?.ftsTables),
    scope,
  };
}

function runtimeSearchSpec(searchCfg) {
  const cfg = searchCfg && typeof searchCfg === 'object' ? searchCfg : {};
  return {
    sources: Array.isArray(cfg.sources) ? cfg.sources : ['display', 'designation'],
    activeOnlyConcepts: cfg.activeOnly !== false,
    designationActiveOnly: cfg.designationActiveOnly !== false,
    literalActiveOnly: cfg.literalActiveOnly !== false,
  };
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

function extractSingleSeedClosureReachability(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind !== 'fromRows' || String(node.key || 'concept_id') !== 'concept_id') return null;
  const rows = node.rows || null;
  if (!rows || (rows.kind !== 'reachability' && rows.kind !== 'row-reachability')) return null;
  if (String(rows.direction || 'down') !== 'down') return null;
  if ((rows.relation?.storage || 'closure') !== 'closure') return null;
  const seed = rows.seed || null;
  const seedKind = String(seed?.kind || '');
  const codes = Array.isArray(seed?.codes) ? seed.codes : [];
  if ((seedKind !== 'explicitCodes' && seedKind !== 'scan-codes') || codes.length !== 1) return null;
  return rows;
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
    const rows = lowerRow(node.rows, ctx, scope);
    return select({
      distinct: true,
      columns: [aliasExpr(column(node.key || 'concept_id', 'r'), 'concept_id')],
      from: subquery(rows, 'r'),
      where: binary('IS NOT', column(node.key || 'concept_id', 'r'), literal(null)),
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
    const propDef = requirePropertyDef(ctx, predicate.property);
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
    return select({
      columns: [aliasExpr(literal('*'), '*')],
      from: table('concept_literal', 'cl'),
      joins: [
        join('INNER', table('concept', 'src'), binary('=', column('concept_id', 'src'), column('source_concept_id', 'cl'))),
      ],
      where: and(conditions),
    });
  }

  if (predicate.kind === 'linkPropertyMatch' && isScanOf(input, 'concept_link')) {
    const propDef = requirePropertyDef(ctx, predicate.property);
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
    return select({
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
    });
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
  const propDef = requirePropertyDef(ctx, relationProperty);
  const edgeSetId = normalizeEdgeSetId(node.relation?.edgeSetId);
  const seedName = 'seed_rel';
  const walkName = 'walk_rel';
  const stepLeft = node.direction === 'up' ? 'source_concept_id' : 'target_concept_id';
  const stepOut = node.direction === 'up' ? 'target_concept_id' : 'source_concept_id';
  const scopeFilters = [
    binary('=', column('property_id', 'l'), ctx.add('reach_prop_id', propDef.property_id)),
    binary('=', column('edge_set_id', 'l'), ctx.add('reach_edge_set_id', edgeSetId)),
    binary('=', column('active', 'l'), literal(1)),
  ];
  if (Number.isInteger(node.scope?.csId)) {
    scopeFilters.push(binary('=', column('cs_id', 'src'), ctx.add('reach_src_cs_id', node.scope.csId)));
    scopeFilters.push(binary('=', column('cs_id', 'tgt'), ctx.add('reach_tgt_cs_id', node.scope.csId)));
  }

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
          from: table('concept_link', 'l'),
          joins: [
            join('INNER', table(walkName, 'w'), binary('=', column(stepLeft, 'l'), column('concept_id', 'w'))),
            join('INNER', table('concept', 'src'), binary('=', column('concept_id', 'src'), column('source_concept_id', 'l'))),
            join('INNER', table('concept', 'tgt'), binary('=', column('concept_id', 'tgt'), column('target_concept_id', 'l'))),
          ],
          where: and(scopeFilters),
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

function lowerRuntimeSearch(node, ctx, scope) {
  const spec = node.spec || {};
  const sources = Array.isArray(spec.sources) ? spec.sources : [];
  const strategy = node.strategy || inferSearchStrategy(node, ctx.runtime);
  if (sources.length === 0 || strategy === 'display-like') {
    const likeParam = ctx.add('search_like', `%${String(node.text || '').toLowerCase()}%`);
    return select({
      distinct: true,
      columns: [aliasExpr(column('concept_id', 'c'), 'concept_id')],
      from: table('concept', 'c'),
      where: and([
        Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('search_cs_id', scope.csId)) : null,
        spec.activeOnlyConcepts !== false ? binary('=', column('active', 'c'), literal(1)) : null,
        binary('LIKE', call('LOWER', [column('display', 'c')]), likeParam),
      ]),
    });
  }

  const matchParam = ctx.add('search_match', toFtsMatchText(node.text || ''));
  const queries = [];
  const tables = runtimeFtsTables(node.ftsTables || ctx.runtime?.search?.ftsTables);

  if (sources.includes('display')) {
    queries.push(select({
      distinct: true,
      columns: [aliasExpr(column('concept_id', 'c'), 'concept_id')],
      from: table(tables.display, 'f'),
      joins: [
        join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('rowid', 'f'))),
      ],
      where: and([
        Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('display_cs_id', scope.csId)) : null,
        spec.activeOnlyConcepts !== false ? binary('=', column('active', 'c'), literal(1)) : null,
        binary('MATCH', column('term', 'f'), matchParam),
      ]),
    }));
  }

  if (sources.includes('designation')) {
    queries.push(select({
      distinct: true,
      columns: [aliasExpr(column('concept_id', 'd'), 'concept_id')],
      from: table(tables.designation, 'f'),
      joins: [
        join('INNER', table('designation', 'd'), binary('=', column('designation_id', 'd'), column('rowid', 'f'))),
        join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('concept_id', 'd'))),
      ],
      where: and([
        Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('designation_cs_id', scope.csId)) : null,
        spec.activeOnlyConcepts !== false ? binary('=', column('active', 'c'), literal(1)) : null,
        spec.designationActiveOnly !== false ? binary('=', column('active', 'd'), literal(1)) : null,
        binary('MATCH', column('term', 'f'), matchParam),
      ]),
    }));
  }

  if (sources.includes('literal')) {
    queries.push(select({
      distinct: true,
      columns: [aliasExpr(column('source_concept_id', 'cl'), 'concept_id')],
      from: table(tables.literal, 'f'),
      joins: [
        join('INNER', table('concept_literal', 'cl'), binary('=', column('literal_id', 'cl'), column('rowid', 'f'))),
        join('INNER', table('concept', 'c'), binary('=', column('concept_id', 'c'), column('source_concept_id', 'cl'))),
      ],
      where: and([
        Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('literal_cs_id', scope.csId)) : null,
        spec.activeOnlyConcepts !== false ? binary('=', column('active', 'c'), literal(1)) : null,
        spec.literalActiveOnly !== false ? binary('=', column('active', 'cl'), literal(1)) : null,
        binary('MATCH', column('term', 'f'), matchParam),
      ]),
    }));
  }

  if (queries.length === 0) {
    return select({
      columns: [aliasExpr(literal(null), 'concept_id')],
      where: literal(false),
    });
  }
  if (queries.length === 1) return queries[0];
  return compound('UNION', queries);
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

function isScanOf(node, tableName) {
  return !!node
    && (node.kind === 'row-scan' || node.kind === 'scan')
    && String(node.table || '') === String(tableName || '');
}

function isLeftJoinNode(node) {
  return String(node?.joinType || '') === 'left' || String(node?.strategy || '') === 'left-join';
}

function inferSearchStrategy(node, runtime) {
  const sources = [...new Set(((node?.spec?.sources || []).map(String)).filter(Boolean))];
  if (sources.length === 0) return 'display-like';
  const configuredTables = runtime?.search?.ftsTables && typeof runtime.search.ftsTables === 'object'
    ? runtime.search.ftsTables
    : {};
  const hasNamedTable = Object.values(configuredTables).some(Boolean);
  return hasNamedTable ? 'fts-union' : 'fts-union-default-tables';
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

function runtimeFtsTables(tables) {
  const cfg = tables && typeof tables === 'object' ? tables : {};
  return {
    display: cfg.display ? String(cfg.display) : 'search_fts_display',
    designation: cfg.designation ? String(cfg.designation) : 'search_fts_designation',
    literal: cfg.literal ? String(cfg.literal) : 'search_fts_literal',
  };
}

function toFtsMatchText(text) {
  return `"${String(text || '').replace(/"/g, '""')}"`;
}

function sqlAstStructuralForm(node) {
  if (!node || typeof node !== 'object') return null;
  switch (node.kind) {
  case 'select':
    return {
      kind: 'select',
      distinct: !!node.distinct,
      columns: (node.columns || []).map(sqlAstStructuralForm),
      from: sqlAstStructuralForm(node.from),
      joins: (node.joins || []).map(sqlAstStructuralForm),
      where: sqlAstStructuralForm(node.where),
      orderBy: (node.orderBy || []).map(sqlAstStructuralForm),
      limit: sqlAstStructuralForm(node.limit),
      offset: sqlAstStructuralForm(node.offset),
    };
  case 'compound':
    return {
      kind: 'compound',
      op: String(node.op || ''),
      queries: (node.queries || []).map(sqlAstStructuralForm),
    };
  case 'with':
    return {
      kind: 'with',
      recursive: !!node.recursive,
      ctes: (node.ctes || []).map(sqlAstStructuralForm),
      body: sqlAstStructuralForm(node.body),
    };
  case 'cte':
    return {
      kind: 'cte',
      name: String(node.name || ''),
      columns: (node.columns || []).map(String),
      query: sqlAstStructuralForm(node.query),
    };
  case 'join':
    return {
      kind: 'join',
      joinType: String(node.joinType || ''),
      source: sqlAstStructuralForm(node.source),
      on: sqlAstStructuralForm(node.on),
    };
  case 'table':
    return { kind: 'table', name: String(node.name || ''), alias: node.alias != null ? String(node.alias) : null };
  case 'subquery':
    return { kind: 'subquery', alias: String(node.alias || ''), query: sqlAstStructuralForm(node.query) };
  case 'column':
    return { kind: 'column', name: String(node.name || ''), tableAlias: node.tableAlias != null ? String(node.tableAlias) : null };
  case 'literal':
    return { kind: 'literal', value: node.value };
  case 'param':
    return { kind: 'param', name: String(node.name || '') };
  case 'call':
    return { kind: 'call', name: String(node.name || ''), args: (node.args || []).map(sqlAstStructuralForm) };
  case 'collate':
    return {
      kind: 'collate',
      expr: sqlAstStructuralForm(node.expr),
      collation: String(node.collation || ''),
    };
  case 'binary':
    return { kind: 'binary', op: String(node.op || ''), left: sqlAstStructuralForm(node.left), right: sqlAstStructuralForm(node.right) };
  case 'unary':
    return { kind: 'unary', op: String(node.op || ''), expr: sqlAstStructuralForm(node.expr) };
  case 'and':
  case 'or':
    return { kind: node.kind, items: (node.items || []).map(sqlAstStructuralForm) };
  case 'list':
    return { kind: 'list', items: (node.items || []).map(sqlAstStructuralForm) };
  case 'exists':
    return { kind: 'exists', query: sqlAstStructuralForm(node.query) };
  case 'in':
    return { kind: 'in', expr: sqlAstStructuralForm(node.expr), items: (node.items || []).map(sqlAstStructuralForm) };
  case 'inQuery':
    return { kind: 'inQuery', expr: sqlAstStructuralForm(node.expr), query: sqlAstStructuralForm(node.query) };
  case 'alias':
    return { kind: 'alias', expr: sqlAstStructuralForm(node.expr), alias: String(node.alias || '') };
  default:
    return node;
  }
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
};
