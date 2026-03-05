'use strict';

const { trace } = require('../engine/expand-trace');

/**
 * Pure SQL generation for cs-sqlite-v0.js.
 *
 * Compiles IR subtrees into { sql, params } tuples for the v0 schema.
 * Called by the v0 provider's executeIR/countForIR/membershipForIR —
 * no other consumers. Separated for readability (pure functions only,
 * no database access).
 */

// ── Filter config resolution ─────────────────────────────────────────

/**
 * Resolve filter config for a property from runtime cs_config.
 * Returns { sources: string[], linkMatch: string, aliases: object, normalizeCase: boolean }
 */
function resolveFilterConfig(property, propDef, runtime) {
  const filtersCfg = runtime?.filters?.properties;
  if (!filtersCfg) {
    // No filter config — use defaults based on value_kind
    return {
      sources: propDef.value_kind === 'concept' ? ['link'] : ['literal'],
      linkMatch: 'code-only',
      aliases: null,
      normalizeCase: false,
    };
  }
  const byCode = filtersCfg.byCode || {};
  const specific = byCode[property] || null;
  const defaultSources = Array.isArray(filtersCfg.defaultSources)
    ? filtersCfg.defaultSources
    : (propDef.value_kind === 'concept' ? ['link'] : ['literal']);
  const sources = Array.isArray(specific?.sources) && specific.sources.length > 0
    ? specific.sources : defaultSources;
  const linkMatch = specific?.linkMatch || filtersCfg.defaultLinkMatch || 'code-only';
  const valueCfg = { ...(filtersCfg.defaultValue || {}), ...(specific?.value || {}) };
  return {
    sources: [...new Set(sources.filter(s => s === 'literal' || s === 'link'))],
    linkMatch,
    aliases: valueCfg.aliases || null,
    normalizeCase: !!valueCfg.normalizeCase,
  };
}

/**
 * Normalize filter values using aliases and case normalization from config.
 */
function normalizeFilterValues(values, filterCfg) {
  return values.map(v => {
    if (filterCfg.aliases) {
      const lower = v.toLowerCase();
      if (filterCfg.aliases[lower] !== undefined) return filterCfg.aliases[lower];
    }
    if (filterCfg.normalizeCase) {
      return v.charAt(0).toUpperCase() + v.slice(1);
    }
    return v;
  });
}

// ── Fragment builders for individual filter clauses ─────────────────

/**
 * Build SQL fragment for a single filter clause.
 * @param {Object} clause - { property, op, value }
 * @param {string} prefix - unique parameter prefix
 * @param {string} alias - concept table alias (default 'c')
 * @param {number} csId
 * @param {Map} propertyDefs - Map<propertyCode, {property_id, value_kind, is_hierarchy}>
 * @param {Object} runtime - parsed cs_config runtime object
 * @returns {{ sql: string, params: object, joins: string } | null}
 */
function buildFilterClauseSql(clause, prefix, alias, csId, propertyDefs, runtime) {
  const { property, op, value } = clause;
  const params = {};

  // ── concept filters ──────────────────────────────────────────────
  if (property === 'concept') {
    if (op === '=') {
      params[`${prefix}_code`] = value;
      return { sql: ` AND ${alias}.code = @${prefix}_code`, params, joins: '' };
    }

    if (op === 'is-a' || op === 'descendent-of') {
      const includeSelf = op === 'is-a'
        ? (runtime?.filters?.concept?.isAIncludesSelf !== false)
        : false;
      params[`${prefix}_anc_code`] = value;
      params[`${prefix}_cs`] = csId;
      const selfClause = includeSelf
        ? ''
        : ` AND cl_${prefix}.descendant_id != cl_${prefix}.ancestor_id`;
      const clAlias = `cl_${prefix}`;
      return {
        sql: selfClause,
        params,
        joins: ` JOIN closure ${clAlias} ON ${clAlias}.descendant_id = ${alias}.concept_id`
          + ` AND ${clAlias}.ancestor_id = (SELECT concept_id FROM concept WHERE code = @${prefix}_anc_code AND cs_id = @${prefix}_cs)`,
        // Metadata for EXISTS rewrite in buildExpandSql
        _closureExists: {
          existsSql: `SELECT 1 FROM closure ${clAlias}`
            + ` WHERE ${clAlias}.descendant_id = ${alias}.concept_id`
            + ` AND ${clAlias}.ancestor_id = (SELECT concept_id FROM concept WHERE code = @${prefix}_anc_code AND cs_id = @${prefix}_cs)`
            + selfClause,
        },
      };
    }

    if (op === 'in') {
      const url = resolveInValueSetUrl(runtime, value);
      params[`${prefix}_vs_url`] = url;
      params[`${prefix}_cs`] = csId;
      return {
        sql: '',
        params,
        joins: ` JOIN value_set_member vsm_${prefix} ON vsm_${prefix}.concept_id = ${alias}.concept_id AND vsm_${prefix}.active = 1`
          + ` JOIN value_set vs_${prefix} ON vs_${prefix}.vs_id = vsm_${prefix}.vs_id`
          + ` AND vs_${prefix}.cs_id = @${prefix}_cs AND vs_${prefix}.url = @${prefix}_vs_url`,
      };
    }

    return null;
  }

  // ── code regex ───────────────────────────────────────────────────
  if (property === 'code' && op === 'regex') {
    params[`${prefix}_re`] = value;
    return { sql: ` AND ${alias}.code REGEXP @${prefix}_re`, params, joins: '' };
  }

  // ── property filters (via property_def lookup) ──────────────────
  const propDef = propertyDefs.get(property);
  if (!propDef) return null;

  // Resolve filter config (sources, linkMatch, aliases) from runtime cs_config.
  // This determines whether to search concept_literal, concept_link, or both,
  // and whether to match link targets by code-only or code-or-display.
  const filterCfg = resolveFilterConfig(property, propDef, runtime);

  if (op === '=' || op === 'in') {
    let rawValues = op === 'in' ? splitFilterValueList(value) : [value];
    const values = normalizeFilterValues(rawValues, filterCfg);
    params[`${prefix}_prop`] = propDef.property_id;

    // Build sub-queries for each source, UNION them if multiple
    const subQueries = [];

    if (filterCfg.sources.includes('literal')) {
      const placeholders = values.map((v, j) => {
        params[`${prefix}_vl${j}`] = v;
        return `@${prefix}_vl${j}`;
      }).join(',');
      subQueries.push(
        `SELECT source_concept_id FROM concept_literal`
        + ` WHERE property_id = @${prefix}_prop AND active = 1`
        + ` AND value_text COLLATE NOCASE IN (${placeholders})`
      );
    }

    if (filterCfg.sources.includes('link')) {
      params[`${prefix}_eset`] = runtime?.hierarchy?.edgeSetId || 1;
      params[`${prefix}_val_cs`] = csId;
      const placeholders = values.map((v, j) => {
        params[`${prefix}_vc${j}`] = v;
        return `@${prefix}_vc${j}`;
      }).join(',');
      let tgtMatch = `tgt.code COLLATE NOCASE IN (${placeholders})`;
      if (filterCfg.linkMatch === 'code-or-display') {
        tgtMatch += ` OR tgt.display COLLATE NOCASE IN (${placeholders})`;
      }
      subQueries.push(
        `SELECT l.source_concept_id FROM concept_link l`
        + ` JOIN concept tgt ON tgt.concept_id = l.target_concept_id`
        + ` WHERE l.property_id = @${prefix}_prop`
        + ` AND l.edge_set_id = @${prefix}_eset`
        + ` AND l.active = 1`
        + ` AND (${tgtMatch})`
      );
    }

    if (subQueries.length === 0) return null;

    const unionSql = subQueries.length === 1
      ? subQueries[0]
      : subQueries.join(' UNION ');

    return {
      sql: ` AND ${alias}.concept_id IN (${unionSql})`,
      params,
      joins: '',
    };
  }

  if (op === 'regex') {
    // Regex only applies to literal/string properties
    if (!filterCfg.sources.includes('literal')) return null;
    params[`${prefix}_prop`] = propDef.property_id;
    params[`${prefix}_re`] = value;
    return {
      sql: '',
      params,
      joins: ` JOIN concept_literal lit_${prefix}`
        + ` ON lit_${prefix}.source_concept_id = ${alias}.concept_id`
        + ` AND lit_${prefix}.property_id = @${prefix}_prop`
        + ` AND lit_${prefix}.active = 1`
        + ` AND lit_${prefix}.value_text REGEXP @${prefix}_re`,
    };
  }

  return null;
}

// ── Selector → SQL ─────────────────────────────────────────────────

/**
 * Build a complete SELECT for a single selector node.
 * @returns {{ sql: string, params: object }}
 */
function buildSelectorSql(sel, csId, prefix, propertyDefs, runtime) {
  const params = {};
  params[`${prefix}_csId`] = csId;

  const shape = String(sel.shape || '');

  if (shape === 'whole' || shape === 'all') {
    return {
      sql: `SELECT c.concept_id, c.code, c.display, c.definition, c.active`
        + ` FROM concept c`
        + ` WHERE c.cs_id = @${prefix}_csId`,
      params,
    };
  }

  if (shape === 'concept') {
    const codes = (sel.conceptCodes || []).map(c => String(c.code || '')).filter(Boolean);
    if (codes.length === 0) return { sql: 'SELECT NULL AS concept_id, NULL AS code, NULL AS display, NULL AS definition, NULL AS active WHERE 0', params: {} };
    const placeholders = codes.map((c, j) => {
      params[`${prefix}_c${j}`] = c;
      return `@${prefix}_c${j}`;
    }).join(',');
    return {
      sql: `SELECT c.concept_id, c.code, c.display, c.definition, c.active`
        + ` FROM concept c`
        + ` WHERE c.cs_id = @${prefix}_csId`
        + ` AND c.code IN (${placeholders})`,
      params,
    };
  }

  if (shape === 'filter') {
    const clauses = sel.filterClauses || [];
    if (clauses.length === 0) {
      // No filters = whole system
      return {
        sql: `SELECT c.concept_id, c.code, c.display, c.definition, c.active`
          + ` FROM concept c`
          + ` WHERE c.cs_id = @${prefix}_csId`,
        params,
      };
    }

    let joins = '';
    let where = '';
    let closureExists = null;
    for (let i = 0; i < clauses.length; i++) {
      const frag = buildFilterClauseSql(clauses[i], `${prefix}f${i}`, 'c', csId, propertyDefs, runtime);
      if (!frag) {
        // Unsupported filter — return empty result
        return { sql: 'SELECT NULL AS concept_id, NULL AS code, NULL AS display, NULL AS definition, NULL AS active WHERE 0', params: {} };
      }
      joins += frag.joins;
      where += frag.sql;
      Object.assign(params, frag.params);
      if (frag._closureExists) closureExists = frag._closureExists;
    }

    // intersectCodes constraint
    if (sel.intersectCodes && sel.intersectCodes.length > 0) {
      const icPlaceholders = sel.intersectCodes.map((c, j) => {
        params[`${prefix}_ic${j}`] = c;
        return `@${prefix}_ic${j}`;
      }).join(',');
      where += ` AND c.code IN (${icPlaceholders})`;
    }

    // Propagate EXISTS rewrite hint for single-closure-filter selectors.
    // Only valid when the closure is the sole join (no other joins).
    const canExistsRewrite = closureExists && clauses.length === 1 && !sel.intersectCodes?.length;

    const result = {
      sql: `SELECT c.concept_id, c.code, c.display, c.definition, c.active`
        + ` FROM concept c${joins}`
        + ` WHERE c.cs_id = @${prefix}_csId${where}`,
      params,
    };
    if (canExistsRewrite) {
      // Provide an alternative query that uses EXISTS instead of JOIN.
      // This lets SQLite scan concept in index order (cs_id, code) and
      // probe closure per row, enabling early termination with LIMIT.
      // Note: `where` contains only the closure selfClause (e.g.,
      // "AND cl.descendant_id != cl.ancestor_id") which references the
      // closure alias — it's already inside the EXISTS subquery, so we
      // omit it from the outer WHERE.
      result._existsRewrite = {
        sql: `SELECT c.concept_id, c.code, c.display, c.definition, c.active`
          + ` FROM concept c`
          + ` WHERE c.cs_id = @${prefix}_csId`
          + ` AND EXISTS (${closureExists.existsSql})`,
        params,
      };
    }
    return result;
  }

  // Unknown shape — empty
  return { sql: 'SELECT NULL AS concept_id, NULL AS code, NULL AS display, NULL AS definition, NULL AS active WHERE 0', params: {} };
}

// ── Expression → SQL (recursive) ──────────────────────────────────

let _exprCounter = 0;

/**
 * Compile an IR expression subtree into SQL.
 * All selectors must target the same csId.
 * @returns {{ sql: string, params: object }}
 */
function buildExprSql(expr, csId, prefix, propertyDefs, runtime) {
  if (!expr) return emptySql();

  switch (expr.kind) {
  case 'empty':
    return emptySql();

  case 'selector':
    return buildSelectorSql(expr, csId, prefix, propertyDefs, runtime);

  case 'union': {
    const children = (expr.items || []).filter(it => it && it.kind !== 'empty');
    if (children.length === 0) return emptySql();
    if (children.length === 1) return buildExprSql(children[0], csId, `${prefix}u0`, propertyDefs, runtime);

    const parts = [];
    const allParams = {};
    for (let i = 0; i < children.length; i++) {
      const child = buildExprSql(children[i], csId, `${prefix}u${i}`, propertyDefs, runtime);
      parts.push(child.sql);
      Object.assign(allParams, child.params);
    }
    return { sql: parts.join('\nUNION ALL\n'), params: allParams };
  }

  case 'intersect': {
    const children = (expr.items || []).filter(it => it && it.kind !== 'empty');
    if (children.length === 0) return emptySql();
    if (children.some(it => it.kind === 'empty')) return emptySql();
    if (children.length === 1) return buildExprSql(children[0], csId, `${prefix}n0`, propertyDefs, runtime);

    const parts = [];
    const allParams = {};
    for (let i = 0; i < children.length; i++) {
      const child = buildExprSql(children[i], csId, `${prefix}n${i}`, propertyDefs, runtime);
      parts.push(child.sql);
      Object.assign(allParams, child.params);
    }
    // Use nested EXISTS for intersection (more flexible than INTERSECT keyword
    // which requires identical column lists)
    const base = parts[0];
    let existsClauses = '';
    for (let i = 1; i < parts.length; i++) {
      existsClauses += ` AND EXISTS (SELECT 1 FROM (${parts[i]}) AS _nx${i} WHERE _nx${i}.code = _n0.code)`;
    }
    return {
      sql: `SELECT _n0.concept_id, _n0.code, _n0.display, _n0.definition, _n0.active`
        + ` FROM (${base}) AS _n0`
        + ` WHERE 1=1${existsClauses}`,
      params: allParams,
    };
  }

  case 'diff': {
    const left = buildExprSql(expr.left, csId, `${prefix}dl`, propertyDefs, runtime);
    const right = buildExprSql(expr.right, csId, `${prefix}dr`, propertyDefs, runtime);

    if (isEmptySql(right.sql)) return left;
    if (isEmptySql(left.sql)) return emptySql();

    const allParams = { ...left.params, ...right.params };
    return {
      sql: `SELECT _dl.concept_id, _dl.code, _dl.display, _dl.definition, _dl.active`
        + ` FROM (${left.sql}) AS _dl`
        + ` WHERE NOT EXISTS (SELECT 1 FROM (${right.sql}) AS _dr WHERE _dr.code = _dl.code)`,
      params: allParams,
    };
  }

  case 'import':
    if (expr.resolved) return buildExprSql(expr.resolved, csId, `${prefix}imp`, propertyDefs, runtime);
    return emptySql();

  default:
    return emptySql();
  }
}

// ── Top-level expansion SQL ───────────────────────────────────────

/**
 * Build the full expansion SQL with optional activeOnly, text search,
 * and pagination.
 * @param {Object} expr - IR expression subtree
 * @param {number} csId
 * @param {Object} opts - { activeOnly, text, offset, count }
 * @param {Map} propertyDefs
 * @param {Object} runtime
 * @returns {{ sql: string, params: object }}
 */
function buildExpandSql(expr, csId, opts, propertyDefs, runtime) {
  const inner = buildExprSql(expr, csId, '_x', propertyDefs, runtime);
  if (isEmptySql(inner.sql)) return inner;

  const params = { ...inner.params };

  // ── EXISTS rewrite for closure-based queries ──────────────────
  // When the inner query is a simple closure join (is-a / descendent-of),
  // rewrite to EXISTS so SQLite can scan the concept index in code order
  // and probe closure per row. This avoids materializing the full closure
  // result set for ORDER BY, giving ~170x speedup on large hierarchies.
  // EXISTS rewrite: for simple closure-based selectors (is-a / descendent-of),
  // rewrite so SQLite scans the concept index in code order and probes closure
  // per row. This avoids materializing the entire closure result for ORDER BY,
  // giving ~170x speedup on large hierarchies (124K Clinical finding: 0.5ms
  // vs 86ms). Falls back to the standard path for text search, unions, diffs.
  //
  // Heuristic: EXISTS scans the entire concept index (~520K for SNOMED) and
  // probes closure per row. This beats JOIN+sort when the result set is large
  // (>~1K) but loses badly for small sets (124 Diabetes codes: 190ms vs 0.7ms).
  // Use EXISTS only when the requested page size (count) suggests the caller
  // expects a large set, or when count is not specified (full expansion).
  // Threshold: use EXISTS when count <= 500 (paginating a likely-large set)
  // or count is null (unbounded). Skip EXISTS for large counts that suggest
  // a small total where JOIN+sort would be faster.
  // Use EXISTS rewrite only for dense result sets (many descendants relative
  // to total concepts). For sparse sets (e.g., 124 Diabetes codes out of 520K
  // concepts), EXISTS scans the entire concept index and is ~200x slower than
  // JOIN+sort. For dense sets (124K Clinical findings), EXISTS is ~170x faster.
  // Threshold: use EXISTS when descendants > 1% of total concepts.
  // The caller passes an optional conceptCount; if unavailable, skip rewrite.
  const useExistsRewrite = inner._existsRewrite && !opts.text
    && opts._conceptCount > 0 && opts._closureCount > 0
    && (opts._closureCount / opts._conceptCount) > 0.01;
  if (useExistsRewrite) {
    trace.note('EXISTS rewrite chosen', {
      closureCount: opts._closureCount,
      conceptCount: opts._conceptCount,
      ratio: Math.round((opts._closureCount / opts._conceptCount) * 10000) / 100,
    });
    let sql = inner._existsRewrite.sql;
    if (opts.activeOnly) {
      sql += ' AND c.active = 1';
    }
    sql += ' ORDER BY c.code';
    if (opts.count != null && opts.count > 0) {
      params._limit = opts.count;
      sql += ' LIMIT @_limit';
    }
    if (opts.offset != null && opts.offset > 0) {
      params._offset = opts.offset;
      sql += ' OFFSET @_offset';
    }
    return { sql, params };
  }

  if (inner._existsRewrite) {
    trace.note('standard path chosen (EXISTS rewrite skipped)', {
      closureCount: opts._closureCount,
      conceptCount: opts._conceptCount,
      hasText: !!opts.text,
    });
  }

  // ── Standard inner/outer pattern ──────────────────────────────
  let outerWhere = '';

  // Active-only filter
  if (opts.activeOnly) {
    outerWhere += ' AND t.active = 1';
  }

  // Text search via FTS5
  if (opts.text) {
    const searchSql = buildFtsSearchSql(csId, opts.text, params, runtime);
    if (searchSql) {
      outerWhere += ` AND t.concept_id IN (${searchSql})`;
    }
  }

  let sql = `SELECT DISTINCT t.concept_id, t.code, t.display, t.definition, t.active`
    + ` FROM (${inner.sql}) AS t`
    + ` WHERE 1=1${outerWhere}`
    + ` ORDER BY t.code`;

  if (opts.count != null && opts.count > 0) {
    params._limit = opts.count;
    sql += ` LIMIT @_limit`;
  }
  if (opts.offset != null && opts.offset > 0) {
    params._offset = opts.offset;
    sql += ` OFFSET @_offset`;
  }

  return { sql, params };
}

// ── Membership SQL ────────────────────────────────────────────────

/**
 * Build a membership-check SQL that accepts @_checkCode.
 * @returns {{ sql: string, params: object }}
 */
function buildMembershipSql(expr, csId, prefix, propertyDefs, runtime) {
  const inner = buildExprSql(expr, csId, prefix, propertyDefs, runtime);
  if (isEmptySql(inner.sql)) {
    return { sql: 'SELECT NULL WHERE 0', params: {} };
  }
  return {
    sql: `SELECT 1 AS found FROM (${inner.sql}) AS _mbr WHERE _mbr.code = @_checkCode LIMIT 1`,
    params: inner.params,
  };
}

// ── Count SQL ─────────────────────────────────────────────────────

/**
 * Build a count SQL for the expression.
 * @returns {{ sql: string, params: object }}
 */
function buildCountSql(expr, csId, prefix, propertyDefs, runtime, opts = {}) {
  const inner = buildExprSql(expr, csId, prefix, propertyDefs, runtime);
  if (isEmptySql(inner.sql)) {
    return { sql: 'SELECT 0 AS cnt', params: {} };
  }
  const params = { ...inner.params };

  // EXISTS rewrite for count — same density heuristic as buildExpandSql
  if (inner._existsRewrite
      && opts._conceptCount > 0 && opts._closureCount > 0
      && (opts._closureCount / opts._conceptCount) > 0.01) {
    let sql = inner._existsRewrite.sql;
    if (opts.activeOnly) sql += ' AND c.active = 1';
    if (opts.text) {
      const searchSql = buildFtsSearchSql(csId, opts.text, params, runtime);
      if (searchSql) sql += ` AND c.concept_id IN (${searchSql})`;
    }
    return {
      sql: `SELECT COUNT(*) AS cnt FROM (${sql})`,
      params,
    };
  }

  let where = '';
  if (opts.activeOnly) {
    where += ' AND _cnt.active = 1';
  }
  if (opts.text) {
    const searchSql = buildFtsSearchSql(csId, opts.text, params, runtime);
    if (searchSql) where += ` AND _cnt.concept_id IN (${searchSql})`;
  }
  return {
    sql: `SELECT COUNT(DISTINCT _cnt.code) AS cnt FROM (${inner.sql}) AS _cnt WHERE 1=1${where}`,
    params,
  };
}

// ── FTS5 search ───────────────────────────────────────────────────

function buildFtsSearchSql(csId, text, params, runtime) {
  if (!text) return null;
  const searchCfg = normalizedSearchConfig(runtime?.search);
  const matchText = toFtsMatchText(text);

  params._searchMatch = matchText;
  params._searchCsId = csId;

  const ftsParts = [];
  for (const source of searchCfg.sources) {
    if (source === 'display') {
      const table = sqlIdentifier(searchCfg.ftsTables?.display, 'search_fts_display');
      const conceptActiveClause = searchCfg.activeOnly ? ' AND c2.active = 1' : '';
      ftsParts.push(
        `SELECT c2.concept_id FROM ${table} f2 JOIN concept c2 ON c2.concept_id = f2.rowid WHERE c2.cs_id = @_searchCsId${conceptActiveClause} AND f2.term MATCH @_searchMatch`
      );
    } else if (source === 'designation') {
      const table = sqlIdentifier(searchCfg.ftsTables?.designation, 'search_fts_designation');
      const conceptActiveClause = searchCfg.activeOnly ? ' AND c2.active = 1' : '';
      const designationActiveClause = searchCfg.designationActiveOnly ? ' AND d2.active = 1' : '';
      ftsParts.push(
        `SELECT d2.concept_id FROM ${table} f2 JOIN designation d2 ON d2.designation_id = f2.rowid JOIN concept c2 ON c2.concept_id = d2.concept_id WHERE c2.cs_id = @_searchCsId${conceptActiveClause}${designationActiveClause} AND f2.term MATCH @_searchMatch`
      );
    } else if (source === 'literal') {
      const table = sqlIdentifier(searchCfg.ftsTables?.literal, 'search_fts_literal');
      const conceptActiveClause = searchCfg.activeOnly ? ' AND c2.active = 1' : '';
      const literalActiveClause = searchCfg.literalActiveOnly ? ' AND cl2.active = 1' : '';
      ftsParts.push(
        `SELECT cl2.source_concept_id FROM ${table} f2 JOIN concept_literal cl2 ON cl2.literal_id = f2.rowid JOIN concept c2 ON c2.concept_id = cl2.source_concept_id WHERE c2.cs_id = @_searchCsId${conceptActiveClause}${literalActiveClause} AND f2.term MATCH @_searchMatch`
      );
    }
  }

  if (ftsParts.length > 0) return ftsParts.join(' UNION ');

  // LIKE fallback
  params._searchLike = `%${text}%`;
  const conceptActiveClause = searchCfg.activeOnly ? ' AND c2.active = 1' : '';
  return `SELECT c2.concept_id FROM concept c2 WHERE c2.cs_id = @_searchCsId${conceptActiveClause} AND c2.display LIKE @_searchLike`;
}

// ── Helpers ───────────────────────────────────────────────────────

function emptySql() {
  return { sql: 'SELECT NULL AS concept_id, NULL AS code, NULL AS display, NULL AS definition, NULL AS active WHERE 0', params: {} };
}

function isEmptySql(sql) {
  return sql.includes('WHERE 0');
}

function splitFilterValueList(value) {
  if (!value) return [];
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function resolveInValueSetUrl(runtime, value) {
  // The v0 provider resolves implicit VS URLs via runtime config
  const implicitVs = runtime?.filters?.concept?.implicitValueSets;
  if (implicitVs && typeof implicitVs === 'object') {
    for (const [prefix, base] of Object.entries(implicitVs)) {
      if (value.startsWith(prefix)) return value;
    }
  }
  return value;
}

function normalizedSearchConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    return {
      sources: ['display', 'designation'],
      ftsTables: {},
      activeOnly: true,
      designationActiveOnly: true,
      literalActiveOnly: true,
    };
  }
  return {
    sources: Array.isArray(cfg.sources) ? cfg.sources : ['display', 'designation'],
    ftsTables: cfg.ftsTables || {},
    activeOnly: cfg.activeOnly !== false,
    designationActiveOnly: cfg.designationActiveOnly !== false,
    literalActiveOnly: cfg.literalActiveOnly !== false,
  };
}

function toFtsMatchText(text) {
  // Quote for FTS5 phrase matching, escape internal double-quotes
  const escaped = String(text).replace(/"/g, '""');
  return `"${escaped}"`;
}

function sqlIdentifier(value, fallback) {
  const v = value || fallback;
  // Basic safety: only allow alphanumeric + underscore
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) return fallback;
  return v;
}

module.exports = {
  buildFilterClauseSql,
  buildSelectorSql,
  buildExprSql,
  buildExpandSql,
  buildMembershipSql,
  buildCountSql,
};
