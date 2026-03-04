'use strict';

/**
 * SQL fragment builder for the v0 SQLite terminology schema.
 *
 * Compiles IR expression subtrees into SQL queries that can be executed
 * against a v0 database via better-sqlite3. All functions are pure —
 * they produce { sql, params } tuples without touching any database.
 *
 * The generated SQL follows the proven inner/outer pattern from the
 * v0 provider's executeFilters():
 *   - Inner SELECT: include filters via JOINs + WHERE
 *   - Outer SELECT: wraps with DISTINCT, excludes (NOT EXISTS),
 *     search (FTS5), pagination (LIMIT/OFFSET)
 */

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
      return {
        sql: selfClause,
        params,
        joins: ` JOIN closure cl_${prefix} ON cl_${prefix}.descendant_id = ${alias}.concept_id`
          + ` AND cl_${prefix}.ancestor_id = (SELECT concept_id FROM concept WHERE code = @${prefix}_anc_code AND cs_id = @${prefix}_cs)`,
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

  if (propDef.value_kind === 'concept') {
    if (op === '=' || op === 'in') {
      const values = op === 'in' ? splitFilterValueList(value) : [value];
      params[`${prefix}_prop`] = propDef.property_id;
      params[`${prefix}_val_cs`] = csId;
      params[`${prefix}_eset`] = runtime?.hierarchy?.edgeSetId || 1;
      const placeholders = values.map((v, j) => {
        params[`${prefix}_vc${j}`] = v;
        return `@${prefix}_vc${j}`;
      }).join(',');
      return {
        sql: '',
        params,
        joins: ` JOIN concept_link lnk_${prefix}`
          + ` ON lnk_${prefix}.source_concept_id = ${alias}.concept_id`
          + ` AND lnk_${prefix}.property_id = @${prefix}_prop`
          + ` AND lnk_${prefix}.edge_set_id = @${prefix}_eset`
          + ` AND lnk_${prefix}.active = 1`
          + ` AND lnk_${prefix}.target_concept_id IN (SELECT concept_id FROM concept WHERE code IN (${placeholders}) AND cs_id = @${prefix}_val_cs)`,
      };
    }
    return null;
  }

  if (propDef.value_kind === 'string' || propDef.value_kind === 'literal') {
    if (op === '=' || op === 'in') {
      const values = op === 'in' ? splitFilterValueList(value) : [value];
      params[`${prefix}_prop`] = propDef.property_id;
      const placeholders = values.map((v, j) => {
        params[`${prefix}_vl${j}`] = v;
        return `@${prefix}_vl${j}`;
      }).join(',');
      return {
        sql: '',
        params,
        joins: ` JOIN concept_literal lit_${prefix}`
          + ` ON lit_${prefix}.source_concept_id = ${alias}.concept_id`
          + ` AND lit_${prefix}.property_id = @${prefix}_prop`
          + ` AND lit_${prefix}.active = 1`
          + ` AND lit_${prefix}.value_text COLLATE NOCASE IN (${placeholders})`,
      };
    }
    return null;
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
    for (let i = 0; i < clauses.length; i++) {
      const frag = buildFilterClauseSql(clauses[i], `${prefix}f${i}`, 'c', csId, propertyDefs, runtime);
      if (!frag) {
        // Unsupported filter — return empty result
        return { sql: 'SELECT NULL AS concept_id, NULL AS code, NULL AS display, NULL AS definition, NULL AS active WHERE 0', params: {} };
      }
      joins += frag.joins;
      where += frag.sql;
      Object.assign(params, frag.params);
    }

    // intersectCodes constraint
    if (sel.intersectCodes && sel.intersectCodes.length > 0) {
      const icPlaceholders = sel.intersectCodes.map((c, j) => {
        params[`${prefix}_ic${j}`] = c;
        return `@${prefix}_ic${j}`;
      }).join(',');
      where += ` AND c.code IN (${icPlaceholders})`;
    }

    return {
      sql: `SELECT c.concept_id, c.code, c.display, c.definition, c.active`
        + ` FROM concept c${joins}`
        + ` WHERE c.cs_id = @${prefix}_csId${where}`,
      params,
    };
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
  let where = '';
  const params = { ...inner.params };
  if (opts.activeOnly) {
    where += ' AND _cnt.active = 1';
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
      ftsParts.push(
        `SELECT c2.concept_id FROM ${table} f2 JOIN concept c2 ON c2.concept_id = f2.rowid WHERE c2.cs_id = @_searchCsId AND f2.term MATCH @_searchMatch`
      );
    } else if (source === 'designation') {
      const table = sqlIdentifier(searchCfg.ftsTables?.designation, 'search_fts_designation');
      ftsParts.push(
        `SELECT d2.concept_id FROM ${table} f2 JOIN designation d2 ON d2.designation_id = f2.rowid WHERE f2.term MATCH @_searchMatch`
      );
    } else if (source === 'literal') {
      const table = sqlIdentifier(searchCfg.ftsTables?.literal, 'search_fts_literal');
      ftsParts.push(
        `SELECT cl2.source_concept_id FROM ${table} f2 JOIN concept_literal cl2 ON cl2.literal_id = f2.rowid WHERE f2.term MATCH @_searchMatch`
      );
    }
  }

  if (ftsParts.length > 0) return ftsParts.join(' UNION ');

  // LIKE fallback
  params._searchLike = `%${text}%`;
  return `SELECT c2.concept_id FROM concept c2 WHERE c2.cs_id = @_searchCsId AND c2.display LIKE @_searchLike`;
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
    return { sources: ['display', 'designation'], ftsTables: {} };
  }
  return {
    sources: Array.isArray(cfg.sources) ? cfg.sources : ['display', 'designation'],
    ftsTables: cfg.ftsTables || {},
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
