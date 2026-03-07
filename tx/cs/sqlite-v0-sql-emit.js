'use strict';

function emitSqlAst(ast, params = {}) {
  return {
    text: renderQuery(ast),
    params: { ...params },
  };
}

function renderQuery(node) {
  if (!node || typeof node !== 'object') throw new Error('Cannot render missing SQL AST');
  switch (node.kind) {
  case 'select':
    return renderSelect(node);
  case 'compound':
    return (node.queries || []).map(q => {
      const rendered = renderQuery(q);
      return q?.kind === 'compound' ? `SELECT * FROM (${rendered})` : rendered;
    }).join(` ${String(node.op || 'UNION').toUpperCase()} `);
  case 'with':
    return renderWith(node);
  default:
    throw new Error(`Unknown SQL AST query kind ${String(node.kind || '(missing)')}`);
  }
}

function renderWith(node) {
  const ctes = (node.ctes || []).map(renderCte).join(', ');
  const prefix = node.recursive ? 'WITH RECURSIVE' : 'WITH';
  return `${prefix} ${ctes} ${renderQuery(node.body)}`;
}

function renderCte(node) {
  const name = quoteIdent(node.name);
  const columns = Array.isArray(node.columns) && node.columns.length > 0
    ? `(${node.columns.map(quoteIdent).join(', ')})`
    : '';
  return `${name}${columns} AS (${renderQuery(node.query)})`;
}

function renderSelect(node) {
  const parts = [];
  parts.push(`SELECT${node.distinct ? ' DISTINCT' : ''} ${renderColumns(node.columns || [])}`);
  if (node.from) parts.push(`FROM ${renderSource(node.from)}`);
  for (const join of node.joins || []) {
    parts.push(`${String(join.joinType || 'INNER').toUpperCase()} JOIN ${renderSource(join.source)} ON ${renderExpr(join.on)}`);
  }
  if (node.where) parts.push(`WHERE ${renderExpr(node.where)}`);
  if (Array.isArray(node.orderBy) && node.orderBy.length > 0) {
    parts.push(`ORDER BY ${(node.orderBy || []).map(renderOrder).join(', ')}`);
  }
  if (node.limit) parts.push(`LIMIT ${renderExpr(node.limit)}`);
  if (node.offset) parts.push(`OFFSET ${renderExpr(node.offset)}`);
  return parts.join(' ');
}

function renderColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) return '*';
  return columns.map(renderExpr).join(', ');
}

function renderSource(source) {
  switch (source?.kind) {
  case 'table':
    return renderTableSource(source);
  case 'subquery':
    return `(${renderQuery(source.query)}) ${quoteIdent(source.alias)}`;
  default:
    throw new Error(`Unknown SQL AST source kind ${String(source?.kind || '(missing)')}`);
  }
}

function renderTableSource(source) {
  const tableName = source.schema
    ? `${quoteIdent(source.schema)}.${quoteIdent(source.name)}`
    : quoteIdent(source.name);
  return source.alias ? `${tableName} ${quoteIdent(source.alias)}` : tableName;
}

function renderOrder(item) {
  return `${renderExpr(item.key)} ${String(item.direction || 'ASC').toUpperCase()}`;
}

function renderExpr(expr) {
  if (!expr || typeof expr !== 'object') {
    if (typeof expr === 'boolean') return expr ? '1' : '0';
    if (expr == null) return 'NULL';
    return String(expr);
  }

  switch (expr.kind) {
  case 'column':
    return expr.tableAlias
      ? `${quoteIdent(expr.tableAlias)}.${quoteIdent(expr.name)}`
      : quoteIdent(expr.name);
  case 'literal':
    if (expr.value === '*') return '*';
    if (typeof expr.value === 'boolean') return expr.value ? '1' : '0';
    if (expr.value == null) return 'NULL';
    if (typeof expr.value === 'number') return String(expr.value);
    return quoteString(String(expr.value));
  case 'param':
    return `@${String(expr.name || '')}`;
  case 'call':
    if (String(expr.name || '').toUpperCase() === 'DISTINCT') {
      return `DISTINCT ${(expr.args || []).map(renderExpr).join(', ')}`;
    }
    return `${String(expr.name || '').toUpperCase()}(${(expr.args || []).map(renderExpr).join(', ')})`;
  case 'collate':
    return `${renderExpr(expr.expr)} COLLATE ${String(expr.collation || '').toUpperCase()}`;
  case 'binary':
    return renderBinary(expr);
  case 'unary':
    return `${String(expr.op || 'NOT').toUpperCase()} (${renderExpr(expr.expr)})`;
  case 'and':
    return `(${(expr.items || []).map(renderExpr).join(' AND ')})`;
  case 'or':
    return `(${(expr.items || []).map(renderExpr).join(' OR ')})`;
  case 'exists':
    return `EXISTS (${renderQuery(expr.query)})`;
  case 'in':
    return `${renderExpr(expr.expr)} IN (${(expr.items || []).map(renderExpr).join(', ')})`;
  case 'inQuery':
    return `${renderExpr(expr.expr)} IN (${renderQuery(expr.query)})`;
  case 'alias':
    if (expr.alias === '*' && expr.expr?.kind === 'literal' && expr.expr.value === '*') return '*';
    return `${renderExpr(expr.expr)} AS ${quoteIdent(expr.alias)}`;
  case 'list':
    return `(${(expr.items || []).map(renderExpr).join(', ')})`;
  default:
    throw new Error(`Unknown SQL AST expr kind ${String(expr.kind || '(missing)')}`);
  }
}

function renderBinary(expr) {
  const op = String(expr.op || '=').toUpperCase();
  if (op === 'LIKE' || op === 'REGEXP' || op === '=' || op === '!=' || op === '<>' || op === 'IS NOT' || op === 'IS') {
    return `(${renderExpr(expr.left)} ${op} ${renderExpr(expr.right)})`;
  }
  return `(${renderExpr(expr.left)} ${op} ${renderExpr(expr.right)})`;
}

function quoteIdent(name) {
  const raw = String(name || '');
  if (raw === '*') return '*';
  return `"${raw.replace(/"/g, '""')}"`;
}

function quoteString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

module.exports = {
  emitSqlAst,
};
