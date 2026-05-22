'use strict';

function table(name, alias = null, schema = null) {
  return {
    kind: 'table',
    name: String(name || ''),
    alias: alias != null ? String(alias) : null,
    schema: schema != null ? String(schema) : null,
  };
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
    return {
      kind: 'table',
      name: String(node.name || ''),
      alias: node.alias != null ? String(node.alias) : null,
      schema: node.schema != null ? String(node.schema) : null,
    };
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
};
