'use strict';

const {
  aliasExpr,
  and,
  binary,
  call,
  column,
  compound,
  exists,
  join,
  literal,
  or,
  order,
  select,
  table,
} = require('./sqlite-v0-sql-nodes');

function supplementTable(binding, tableName, alias) {
  return table(tableName, alias, binding?.alias || null);
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

function lowerCorrelatedRuntimeSearchPredicate(text, ctx, scope, conceptAlias = 'c') {
  const spec = runtimeSearchSpec(ctx.runtime?.search);
  const sources = Array.isArray(spec.sources) ? spec.sources : [];
  if (sources.length === 0) {
    return binary('LIKE', call('LOWER', [column('display', conceptAlias)]), ctx.add('search_like', `%${String(text || '').toLowerCase()}%`));
  }

  const matchParam = ctx.add('search_match', toFtsMatchText(text || ''));
  const guards = [];
  const matchClauses = [];
  const tables = runtimeFtsTables(ctx.runtime?.search?.ftsTables);

  if (spec.activeOnlyConcepts !== false) {
    guards.push(binary('=', column('active', conceptAlias), literal(1)));
  }

  if (sources.includes('display')) {
    matchClauses.push(exists(select({
      columns: [aliasExpr(literal(1), 'found')],
      from: table(tables.display, 'f'),
      where: and([
        binary('=', column('rowid', 'f'), column('concept_id', conceptAlias)),
        binary('MATCH', column('term', 'f'), matchParam),
      ]),
    })));
  }

  if (sources.includes('designation')) {
    matchClauses.push(exists(select({
      columns: [aliasExpr(literal(1), 'found')],
      from: table(tables.designation, 'f'),
      joins: [
        join('INNER', table('designation', 'd'), binary('=', column('designation_id', 'd'), column('rowid', 'f'))),
      ],
      where: and([
        binary('=', column('concept_id', 'd'), column('concept_id', conceptAlias)),
        spec.designationActiveOnly !== false ? binary('=', column('active', 'd'), literal(1)) : null,
        binary('MATCH', column('term', 'f'), matchParam),
      ]),
    })));

    for (const binding of ctx.supplementBindings || []) {
      matchClauses.push(exists(select({
        columns: [aliasExpr(literal(1), 'found')],
        from: supplementTable(binding, 'search_fts_designation', 'f'),
        joins: [
          join('INNER', supplementTable(binding, 'supplement_designation', 'sd'), binary('=', column('designation_id', 'sd'), column('rowid', 'f'))),
        ],
        where: and([
          binary('=', column('source_code', 'sd'), column('code', conceptAlias)),
          spec.designationActiveOnly !== false ? binary('=', column('active', 'sd'), literal(1)) : null,
          binary('MATCH', column('term', 'f'), matchParam),
        ]),
      })));
    }
  }

  if (sources.includes('literal')) {
    matchClauses.push(exists(select({
      columns: [aliasExpr(literal(1), 'found')],
      from: table(tables.literal, 'f'),
      joins: [
        join('INNER', table('concept_literal', 'cl'), binary('=', column('literal_id', 'cl'), column('rowid', 'f'))),
      ],
      where: and([
        binary('=', column('source_concept_id', 'cl'), column('concept_id', conceptAlias)),
        spec.literalActiveOnly !== false ? binary('=', column('active', 'cl'), literal(1)) : null,
        binary('MATCH', column('term', 'f'), matchParam),
      ]),
    })));

    for (const binding of ctx.supplementBindings || []) {
      matchClauses.push(exists(select({
        columns: [aliasExpr(literal(1), 'found')],
        from: supplementTable(binding, 'search_fts_literal', 'f'),
        joins: [
          join('INNER', supplementTable(binding, 'supplement_literal', 'sl'), binary('=', column('literal_id', 'sl'), column('rowid', 'f'))),
        ],
        where: and([
          binary('=', column('source_code', 'sl'), column('code', conceptAlias)),
          spec.literalActiveOnly !== false ? binary('=', column('active', 'sl'), literal(1)) : null,
          binary('MATCH', column('term', 'f'), matchParam),
        ]),
      })));
    }
  }

  if (matchClauses.length === 0) return and(guards);
  return and([...guards, or(matchClauses)]);
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
    for (const binding of ctx.supplementBindings || []) {
      queries.push(select({
        distinct: true,
        columns: [aliasExpr(column('concept_id', 'c'), 'concept_id')],
        from: supplementTable(binding, 'search_fts_designation', 'f'),
        joins: [
          join('INNER', supplementTable(binding, 'supplement_designation', 'sd'), binary('=', column('designation_id', 'sd'), column('rowid', 'f'))),
          join('INNER', table('concept', 'c'), binary('=', column('code', 'c'), column('source_code', 'sd'))),
        ],
        where: and([
          Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('supp_designation_cs_id', scope.csId)) : null,
          spec.activeOnlyConcepts !== false ? binary('=', column('active', 'c'), literal(1)) : null,
          spec.designationActiveOnly !== false ? binary('=', column('active', 'sd'), literal(1)) : null,
          binary('MATCH', column('term', 'f'), matchParam),
        ]),
      }));
    }
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
    for (const binding of ctx.supplementBindings || []) {
      queries.push(select({
        distinct: true,
        columns: [aliasExpr(column('concept_id', 'c'), 'concept_id')],
        from: supplementTable(binding, 'search_fts_literal', 'f'),
        joins: [
          join('INNER', supplementTable(binding, 'supplement_literal', 'sl'), binary('=', column('literal_id', 'sl'), column('rowid', 'f'))),
          join('INNER', table('concept', 'c'), binary('=', column('code', 'c'), column('source_code', 'sl'))),
        ],
        where: and([
          Number.isInteger(scope?.csId) ? binary('=', column('cs_id', 'c'), ctx.add('supp_literal_cs_id', scope.csId)) : null,
          spec.activeOnlyConcepts !== false ? binary('=', column('active', 'c'), literal(1)) : null,
          spec.literalActiveOnly !== false ? binary('=', column('active', 'sl'), literal(1)) : null,
          binary('MATCH', column('term', 'f'), matchParam),
        ]),
      }));
    }
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

function inferSearchStrategy(node, runtime) {
  const sources = [...new Set(((node?.spec?.sources || []).map(String)).filter(Boolean))];
  if (sources.length === 0) return 'display-like';
  const configuredTables = runtime?.search?.ftsTables && typeof runtime.search.ftsTables === 'object'
    ? runtime.search.ftsTables
    : {};
  const hasNamedTable = Object.values(configuredTables).some(Boolean);
  return hasNamedTable ? 'fts-union' : 'fts-union-default-tables';
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
  const tokens = String(text || '').match(/[0-9A-Za-z]+/g) || [];
  if (tokens.length === 0) {
    return `"${String(text || '').replace(/"/g, '""')}"`;
  }
  return tokens
    .map(token => `${token.toLowerCase()}*`)
    .join(' OR ');
}

module.exports = {
  inferSearchStrategy,
  lowerCorrelatedRuntimeSearchPredicate,
  lowerRuntimeSearch,
  runtimeSearchNode,
  __testing: {
    runtimeFtsTables,
    runtimeSearchSpec,
    toFtsMatchText,
  },
};
