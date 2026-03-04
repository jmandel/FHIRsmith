'use strict';

/**
 * Generic SQLite v0 terminology provider.
 *
 * Implements upstream's CodeSystemProvider / CodeSystemFactoryProvider
 * against the normalised v0 SQLite schema (concept, closure, designation,
 * concept_link, concept_literal, property_def, …).
 *
 * Two layers:
 *   Layer 1 – CodeSystemProvider for the legacy expand.js filter protocol
 *   Layer 2 – executeIR() for the IR engine (Phase 1, stubbed here)
 *
 * Loaded via the `sqlite-v0:` source type in library.js.
 */

const BetterSqlite3 = require('better-sqlite3');
const { CodeSystem, CodeSystemContentMode } = require('../library/codesystem');
const { CodeSystemFactoryProvider, FilterExecutionContext } = require('./cs-api');
const { BaseCSServices } = require('./cs-base');
const { DesignationUse } = require('../library/designations');
const { VersionUtilities } = require('../../library/version-utilities');
const { buildExpandSql, buildMembershipSql, buildCountSql } = require('../engine/sqlite-v0-sql');

// ── Helper functions (ported from codex) ────────────────────────────

function normalizedFilterCandidates(value, valueCfg) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const cfg = valueCfg || {};
  const aliases = cfg.aliases || {};
  const out = new Set();
  out.add(raw);
  const rawKey = (cfg.normalizeCase !== false) ? raw.toLowerCase() : raw;
  let alias = aliases[raw];
  if (alias === undefined) alias = aliases[rawKey];
  if (alias !== undefined && alias !== null && String(alias).trim() !== '')
    out.add(String(alias).trim());
  return Array.from(out);
}

function splitFilterValueList(value) {
  if (Array.isArray(value)) return value.map(v => String(v ?? '').trim()).filter(Boolean);
  return String(value ?? '').split(',').map(v => v.trim()).filter(Boolean);
}

function inferSourcesFromValueKind(valueKind) {
  if (valueKind === 'literal') return ['literal'];
  if (valueKind === 'concept') return ['link'];
  return ['literal', 'link'];
}

function dedupSources(sources, valueKind) {
  const input = Array.isArray(sources) && sources.length > 0 ? sources : inferSourcesFromValueKind(valueKind);
  const cleaned = [...new Set(input.filter(s => s === 'literal' || s === 'link'))];
  return cleaned.length > 0 ? cleaned : inferSourcesFromValueKind(valueKind);
}

function toFtsMatchText(text) {
  return `"${String(text || '').replace(/"/g, '""')}"`;
}

function sanitizeName(system) {
  return (system || 'CS').replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'CS';
}

function buildRuntimeConfig(rawCfg, system) {
  const cfg = rawCfg || {};
  const searchRaw = cfg['search'] || {};
  const sources = Array.isArray(searchRaw.sources) && searchRaw.sources.length > 0
    ? searchRaw.sources.filter(s => ['display', 'designation', 'literal'].includes(s))
    : ['designation'];
  const search = {
    mode: searchRaw.mode || 'like',
    activeOnly: searchRaw.activeOnly !== false,
    designationActiveOnly: searchRaw.designationActiveOnly !== false,
    literalActiveOnly: searchRaw.literalActiveOnly !== false,
    sources,
    ftsTables: {
      display: searchRaw.ftsTables?.display || 'search_fts_display',
      designation: searchRaw.ftsTables?.designation || 'search_fts_designation',
      literal: searchRaw.ftsTables?.literal || 'search_fts_literal',
    },
    likeFallback: { enabled: searchRaw.likeFallback?.enabled !== false, caseInsensitive: searchRaw.likeFallback?.caseInsensitive !== false },
  };
  const runtime = {
    versioning: cfg['versioning'] || { algorithm: 'string', partialMatch: true },
    languages: cfg['languages'] || { default: 'en' },
    designations: cfg['designations'] || {},
    hierarchy: cfg['hierarchy'] || { propertyCode: null, edgeSetId: 1, closure: { enabled: true, fallbackRecursive: false } },
    filters: cfg['filters'] || { concept: { operators: ['=', 'is-a', 'descendent-of', 'in'] }, code: { operators: ['regex'] } },
    implicitValueSets: cfg['implicitValueSets'] || {
      all: { queries: ['fhir_vs', 'fhir_vs=all'] },
      isa: { queryPrefix: 'fhir_vs=isa/', filter: { property: 'concept', op: 'is-a', valueFromSuffix: true } },
      refset: { queryPrefix: 'fhir_vs=refset/', filter: { property: 'concept', op: 'in', valueFromSuffix: true } },
    },
    status: cfg['status'] || { inactive: { source: 'concept.active', invert: true }, deprecated: { source: 'constant', value: false }, abstract: { source: 'constant', value: false } },
    iteration: cfg['iteration'] || {},
    search,
    behaviorFlags: cfg['behaviorFlags'] || {},
  };
  if (!runtime.hierarchy.edgeSetId) runtime.hierarchy.edgeSetId = 1;
  if (!runtime.languages.default) runtime.languages.default = 'en';
  return runtime;
}

// ── Context wrappers ────────────────────────────────────────────────

/** Context returned by locate() and used by all per-concept methods. */
class V0ConceptContext {
  constructor(row) {
    this.concept_id = row.concept_id;
    this.code = row.code;
    this.display = row.display;
    this.definition = row.definition;
    this.active = row.active;
  }
}

/** Opaque wrapper for filter iteration. */
class V0FilterSet {
  constructor(rows) {
    this.rows = rows;   // Array of concept rows
    this.cursor = 0;
  }
}

// ── Provider (per-request) ──────────────────────────────────────────

class SqliteV0Provider extends BaseCSServices {
  /** @type {import('better-sqlite3').Database} */
  #db;
  #meta;       // { csId, baseUri, canonicalUri, version, name }
  #runtime;    // parsed cs_config values
  #propDefs;   // Map<propertyCode, {property_id, value_kind, is_hierarchy}>
  #closureOk;  // boolean — is the closure table populated?
  #stmts;      // prepared statements cache

  constructor(opContext, supplements, db, meta, runtime, propDefs) {
    super(opContext, supplements);
    this.#db = db;
    this.#meta = meta;
    this.#runtime = runtime;
    this.#propDefs = propDefs;
    this.#closureOk = !!runtime.hierarchy?.closure?.enabled;
    this.#stmts = {};
  }

  // ── metadata ─────────────────────────────────────────────────────

  system()      { return this.#meta.baseUri; }
  version()     { return this.#meta.canonicalUri; }
  name()        { return this.#meta.name || this.#meta.baseUri; }
  description() { return this.#meta.name || ''; }

  async totalCount() {
    return this.#prep('totalCount',
      'SELECT count(*) AS cnt FROM concept WHERE cs_id = @cs')
      .get({ cs: this.#meta.csId }).cnt;
  }

  contentMode() { return CodeSystemContentMode.Complete; }
  isNotClosed() { return false; }
  hasParents()  { return this.#closureOk; }

  // Cached concept count for EXISTS rewrite density heuristic
  #conceptCountCache = null;
  #getConceptCount() {
    if (this.#conceptCountCache == null) {
      this.#conceptCountCache = this.#prep('conceptCount',
        'SELECT COUNT(*) AS cnt FROM concept WHERE cs_id = @cs')
        .get({ cs: this.#meta.csId }).cnt;
    }
    return this.#conceptCountCache;
  }

  // Quick closure count for a single is-a/descendent-of selector
  #getClosureCount(subtree) {
    if (subtree?.kind !== 'selector' || subtree.shape !== 'filter') return 0;
    const clause = (subtree.filterClauses || [])[0];
    if (!clause || (clause.op !== 'is-a' && clause.op !== 'descendent-of')) return 0;
    if ((subtree.filterClauses || []).length !== 1) return 0;
    const row = this.#prep('closureCount',
      `SELECT COUNT(*) AS cnt FROM closure WHERE ancestor_id = (
        SELECT concept_id FROM concept WHERE code = @code AND cs_id = @cs)`)
      .get({ code: clause.value, cs: this.#meta.csId });
    return row?.cnt || 0;
  }

  propertyDefinitions() {
    const defs = [];
    for (const [code, pd] of this.#propDefs) {
      defs.push({
        code,
        type: pd.value_kind === 'concept' ? 'Coding' : 'string',
        description: pd.display || code,
      });
    }
    return defs;
  }

  // ── concept access ──────────────────────────────────────────────

  async locate(code) {
    const row = this.#prep('locate',
      'SELECT concept_id, code, display, definition, active FROM concept WHERE cs_id = @cs AND code = @code')
      .get({ cs: this.#meta.csId, code });
    if (!row) return { context: null, message: `Code ${code} not found in ${this.name()}` };
    return { context: new V0ConceptContext(row) };
  }

  async code(context)       { return (await this.#ctx(context)).code; }
  async display(context) {
    const ctx = await this.#ctx(context);
    const supp = this._displayFromSupplements(ctx.code);
    if (supp) return supp;
    return ctx.display;
  }
  async definition(context) { return (await this.#ctx(context)).definition; }

  async isAbstract(context) {
    const statusCfg = this.#runtime.status;
    if (statusCfg?.abstract?.source === 'constant') return statusCfg.abstract.value;
    return false;
  }

  async isInactive(context) {
    const ctx = await this.#ctx(context);
    const statusCfg = this.#runtime.status;
    if (statusCfg?.inactive?.source === 'concept.active') {
      return statusCfg.inactive.invert ? !ctx.active : !!ctx.active;
    }
    return !ctx.active;
  }

  async isDeprecated(context) {
    const statusCfg = this.#runtime.status;
    if (statusCfg?.deprecated?.source === 'constant') return statusCfg.deprecated.value;
    return false;
  }

  async getStatus(context) {
    const ctx = await this.#ctx(context);
    // Check statusProperty config (e.g. LOINC stores STATUS in concept_literal)
    const statusPropCode = this.#runtime.status?.statusProperty;
    if (statusPropCode) {
      const propDef = this.#propDefs.get(statusPropCode);
      if (propDef) {
        const row = this.#prep('statusProp',
          `SELECT COALESCE(value_text, value_raw) AS value FROM concept_literal
           WHERE source_concept_id = @cid AND property_id = @pid AND active = 1 LIMIT 1`)
          .get({ cid: ctx.concept_id, pid: propDef.property_id });
        if (row?.value) return row.value;
      }
    }
    return ctx.active ? 'active' : 'inactive';
  }

  versionIsMoreDetailed(checkVersion, actualVersion) {
    if (!checkVersion || !actualVersion) return false;
    const partialMatch = this.#runtime.versioning?.partialMatch !== false;
    if (!partialMatch) return checkVersion === actualVersion;
    return actualVersion.startsWith(checkVersion);
  }

  async subsumesTest(codeA, codeB) {
    const a = await this.#ctx(codeA);
    const b = await this.#ctx(codeB);
    if (!a || !b) return 'not-subsumed';
    if (a.code === b.code) return 'equivalent';
    if (this.#isA(a.concept_id, b.concept_id)) return 'subsumes';
    if (this.#isA(b.concept_id, a.concept_id)) return 'subsumed-by';
    return 'not-subsumed';
  }

  #isA(ancestorId, descendantId) {
    if (!this.#closureOk || !ancestorId || !descendantId) return false;
    if (ancestorId === descendantId) return true;
    const row = this.#prep('isA',
      'SELECT 1 AS found FROM closure WHERE ancestor_id = @anc AND descendant_id = @desc LIMIT 1')
      .get({ anc: ancestorId, desc: descendantId });
    return !!row;
  }

  async itemWeight() { return null; }

  async parent(context) {
    if (!this.#closureOk) return null;
    const ctx = await this.#ctx(context);
    const hierProp = this.#getHierarchyPropertyId();
    if (hierProp == null) return null;
    const row = this.#prep('parent',
      `SELECT c2.code FROM concept_link cl
       JOIN concept c2 ON c2.concept_id = cl.target_concept_id
       WHERE cl.source_concept_id = @cid AND cl.property_id = @pid AND cl.active = 1
       LIMIT 1`)
      .get({ cid: ctx.concept_id, pid: hierProp });
    return row ? row.code : null;
  }

  // ── designations ────────────────────────────────────────────────

  async designations(context, displays) {
    const ctx = await this.#ctx(context);

    // Add primary display as a display designation
    if (ctx.display) {
      const defaultLang = this.#runtime.languages?.default || 'en';
      displays.addDesignation(true, 'active', defaultLang, null, ctx.display);
    }

    // Get designations from DB
    const rows = this.#prep('designations',
      `SELECT language_code, use_code, term, active, preferred
       FROM designation WHERE concept_id = @cid`)
      .all({ cid: ctx.concept_id });

    const useMapping = this.#runtime.designations?.useMapping || {};

    for (const row of rows) {
      const use = useMapping[row.use_code]
        ? { system: useMapping[row.use_code].system, code: useMapping[row.use_code].code, display: useMapping[row.use_code].display }
        : row.use_code ? { system: this.system(), code: row.use_code } : null;
      const status = row.active ? 'active' : 'inactive';
      displays.addDesignation(false, status, row.language_code, use, row.term);
    }

    // Supplement designations
    this._listSupplementDesignations(ctx.code, displays);
  }

  // ── properties ──────────────────────────────────────────────────

  async properties(context) {
    const ctx = await this.#ctx(context);
    const props = [];

    // Concept-valued properties (concept_link)
    const links = this.#prep('propLinks',
      `SELECT pd.property_code, c2.code AS target_code, c2.display AS target_display
       FROM concept_link cl
       JOIN property_def pd ON pd.property_id = cl.property_id
       JOIN concept c2 ON c2.concept_id = cl.target_concept_id
       WHERE cl.source_concept_id = @cid AND cl.active = 1`)
      .all({ cid: ctx.concept_id });
    for (const link of links) {
      props.push({
        code: link.property_code,
        value: { system: this.system(), code: link.target_code, display: link.target_display },
      });
    }

    // Literal-valued properties (concept_literal)
    const lits = this.#prep('propLits',
      `SELECT pd.property_code, cl.value_raw, cl.value_text, cl.value_num, cl.value_bool
       FROM concept_literal cl
       JOIN property_def pd ON pd.property_id = cl.property_id
       WHERE cl.source_concept_id = @cid AND cl.active = 1`)
      .all({ cid: ctx.concept_id });
    for (const lit of lits) {
      const value = lit.value_text ?? lit.value_raw ?? (lit.value_num != null ? String(lit.value_num) : null);
      if (value != null) {
        props.push({ code: lit.property_code, value });
      }
    }

    return props;
  }

  async extensions() { return null; }

  // ── filter protocol ─────────────────────────────────────────────

  async doesFilter(prop, op, value) {
    const filtersCfg = this.#runtime.filters || {};
    if (prop === 'concept' && filtersCfg.concept?.operators?.includes(op)) return true;
    if (prop === 'code' && op === 'regex') return true;
    if (filtersCfg[prop]?.operators?.includes(op)) return true;
    // Regex on any literal property
    if (op === 'regex' && prop !== 'concept') {
      const propDef = this.#propDefs.get(prop);
      if (propDef && propDef.value_kind !== 'concept') return true;
    }
    // Check property config with alias resolution
    const resolved = this.#resolvePropertyFilterConfig(prop);
    if (resolved?.operators?.includes(op)) return true;
    return false;
  }

  async getPrepContext(iterate) {
    const ctx = new FilterExecutionContext(iterate);
    ctx._v0 = { filters: [], search: null };
    return ctx;
  }

  async filter(filterContext, prop, op, value) {
    filterContext._v0.filters.push({ property: prop, op, value });
  }

  async searchFilter(filterContext, text, sort) {
    // text is a SearchFilterText object; extract the raw string for FTS
    filterContext._v0.search = text?.filter || (typeof text === 'string' ? text : null);
  }

  async executeFilters(filterContext) {
    const { filters, search } = filterContext._v0;
    const params = { cs: this.#meta.csId };
    const joins = [];
    const wheres = [`c.cs_id = @cs`];
    let idx = 0;
    const codeSetFilters = [];  // property filters that produce code sets
    let codeRegex = null;

    for (const f of filters) {
      const frag = this.#buildFilterFragment(f, `f${idx}`, 'c', params);
      if (frag) {
        if (frag._codeSet) { codeSetFilters.push(frag._codeSet); }
        else if (frag._codeRegex) { codeRegex = frag._codeRegex; }
        else {
          if (frag.joins) joins.push(frag.joins);
          if (frag.sql) wheres.push(frag.sql);
        }
      }
      idx++;
    }

    // Multi-source text search (display + designation + literal FTS)
    if (search) {
      const searchCfg = this.#runtime.search;
      if (searchCfg?.mode?.startsWith('fts')) {
        const matchText = toFtsMatchText(search);
        const searchCodes = this.#searchCodesWithFts(matchText, searchCfg);
        if (searchCodes.length === 0) {
          filterContext._v0.resultSet = new V0FilterSet([]);
          return [filterContext._v0.resultSet];
        }
        codeSetFilters.push(searchCodes);
      } else {
        // LIKE fallback on display only
        params.search_like = `%${search}%`;
        wheres.push(`c.display LIKE @search_like`);
      }
    }

    const sql = `SELECT c.concept_id, c.code, c.display, c.definition, c.active
      FROM concept c ${joins.join(' ')}
      WHERE ${wheres.join(' AND ')}
      ORDER BY c.code`;

    let rows = this.#db.prepare(sql).all(params);

    // Apply code regex filter (JS-side)
    if (codeRegex) {
      try {
        const re = new RegExp(codeRegex);
        rows = rows.filter(r => re.test(r.code));
      } catch (e) {
        throw new Error(`Invalid code regex '${codeRegex}': ${e.message}`);
      }
    }

    // Intersect with all code-set filters
    if (codeSetFilters.length > 0) {
      let allowed = new Set(codeSetFilters[0]);
      for (let i = 1; i < codeSetFilters.length; i++) {
        const next = new Set(codeSetFilters[i]);
        allowed = new Set([...allowed].filter(c => next.has(c)));
      }
      rows = rows.filter(r => allowed.has(r.code));
    }

    filterContext._v0.resultSet = new V0FilterSet(rows);
    return [filterContext._v0.resultSet];
  }

  /** Multi-source FTS search across display/designation/literal tables. */
  #searchCodesWithFts(matchText, searchCfg) {
    const codeSet = new Set();
    const activeClause = searchCfg.activeOnly ? ' AND c.active = 1' : '';
    for (const source of searchCfg.sources) {
      if (source === 'display') {
        const tbl = searchCfg.ftsTables.display;
        const rows = this.#db.prepare(
          `SELECT c.code FROM ${tbl} f JOIN concept c ON c.concept_id = f.rowid
           WHERE c.cs_id = @cs${activeClause} AND f.term MATCH @mt`
        ).all({ cs: this.#meta.csId, mt: matchText });
        for (const r of rows) codeSet.add(r.code);
      } else if (source === 'designation') {
        const tbl = searchCfg.ftsTables.designation;
        const dClause = searchCfg.designationActiveOnly ? ' AND d.active = 1' : '';
        const rows = this.#db.prepare(
          `SELECT c.code FROM ${tbl} f JOIN designation d ON d.designation_id = f.rowid
           JOIN concept c ON c.concept_id = d.concept_id
           WHERE c.cs_id = @cs${activeClause}${dClause} AND f.term MATCH @mt`
        ).all({ cs: this.#meta.csId, mt: matchText });
        for (const r of rows) codeSet.add(r.code);
      } else if (source === 'literal') {
        const tbl = searchCfg.ftsTables.literal;
        const lClause = searchCfg.literalActiveOnly ? ' AND cl.active = 1' : '';
        const rows = this.#db.prepare(
          `SELECT c.code FROM ${tbl} f JOIN concept_literal cl ON cl.literal_id = f.rowid
           JOIN concept c ON c.concept_id = cl.source_concept_id
           WHERE c.cs_id = @cs${activeClause}${lClause} AND f.term MATCH @mt`
        ).all({ cs: this.#meta.csId, mt: matchText });
        for (const r of rows) codeSet.add(r.code);
      }
    }
    return [...codeSet];
  }

  async filterSize(filterContext, set) {
    return set.rows.length;
  }

  async filterMore(filterContext, set) {
    return set.cursor < set.rows.length;
  }

  async filterConcept(filterContext, set) {
    const row = set.rows[set.cursor++];
    return new V0ConceptContext(row);
  }

  async filterLocate(filterContext, set, code) {
    const found = set.rows.find(r => r.code === code);
    if (!found) return `Code ${code} not found in filter result`;
    return new V0ConceptContext(found);
  }

  async filterCheck(filterContext, set, concept) {
    const ctx = await this.#ctx(concept);
    const found = set.rows.some(r => r.code === ctx.code);
    return found ? true : `Code ${ctx.code} not in filter set`;
  }

  // ── iteration ───────────────────────────────────────────────────

  async iteratorAll() {
    const iterCfg = this.#runtime.iteration;
    const sql = 'SELECT concept_id, code, display, definition, active FROM concept WHERE cs_id = @cs ORDER BY code';
    let rows = this.#db.prepare(sql).all({ cs: this.#meta.csId });

    // Apply code regex filter if configured (e.g. LOINC: only codes matching ^[0-9]{3,}.*)
    if (iterCfg?.defaultCodeRegex) {
      try {
        const re = new RegExp(iterCfg.defaultCodeRegex);
        rows = rows.filter(r => re.test(r.code));
      } catch { /* ignore bad regex */ }
    }

    return new V0FilterSet(rows);
  }

  async iterator(context) {
    if (!context) return await this.iteratorAll();
    // Children of a concept
    if (!this.#closureOk) return null;
    const ctx = await this.#ctx(context);
    const hierProp = this.#getHierarchyPropertyId();
    if (hierProp == null) return null;
    const rows = this.#db.prepare(
      `SELECT c.concept_id, c.code, c.display, c.definition, c.active
       FROM concept_link cl
       JOIN concept c ON c.concept_id = cl.source_concept_id
       WHERE cl.target_concept_id = @cid AND cl.property_id = @pid AND cl.active = 1
       ORDER BY c.code`)
      .all({ cid: ctx.concept_id, pid: hierProp });
    return new V0FilterSet(rows);
  }

  async nextContext(iter) {
    if (!iter || iter.cursor >= iter.rows.length) return null;
    return new V0ConceptContext(iter.rows[iter.cursor++]);
  }

  // ── private helpers ─────────────────────────────────────────────

  /** Ensure we have a V0ConceptContext. Locate by code string if needed. */
  async #ctx(input) {
    if (input instanceof V0ConceptContext) return input;
    if (typeof input === 'string') {
      const { context } = await this.locate(input);
      if (!context) throw new Error(`Cannot find concept ${input} in ${this.name()}`);
      return context;
    }
    if (input && input.context instanceof V0ConceptContext) return input.context;
    if (input && typeof input.code === 'string') {
      const { context } = await this.locate(input.code);
      if (!context) throw new Error(`Cannot find concept ${input.code} in ${this.name()}`);
      return context;
    }
    throw new Error(`Invalid context: ${JSON.stringify(input)}`);
  }

  /** Get or prepare a statement. */
  #prep(name, sql) {
    if (!this.#stmts[name]) {
      this.#stmts[name] = this.#db.prepare(sql);
    }
    return this.#stmts[name];
  }

  /** Get the hierarchy property id. */
  #getHierarchyPropertyId() {
    for (const [, pd] of this.#propDefs) {
      if (pd.is_hierarchy) return pd.property_id;
    }
    return null;
  }

  /** Build a SQL filter fragment for a single filter clause. */
  #buildFilterFragment(clause, prefix, alias, params) {
    const { property, op, value } = clause;
    const filtersCfg = this.#runtime.filters || {};

    // ── concept hierarchy filters ──
    if (property === 'concept') {
      if (op === '=') {
        params[`${prefix}_code`] = value;
        return { sql: `${alias}.code = @${prefix}_code`, joins: '' };
      }
      if (op === 'is-a' || op === 'descendent-of') {
        if (!this.#closureOk) return null;
        const includeSelf = op === 'is-a'
          ? (filtersCfg.concept?.isAIncludesSelf !== false)
          : false;
        params[`${prefix}_anc_code`] = value;
        params[`${prefix}_cs`] = this.#meta.csId;
        const selfClause = includeSelf
          ? ''
          : ` AND cl_${prefix}.descendant_id != cl_${prefix}.ancestor_id`;
        return {
          sql: `1=1${selfClause}`,
          joins: `JOIN closure cl_${prefix} ON cl_${prefix}.descendant_id = ${alias}.concept_id`
            + ` AND cl_${prefix}.ancestor_id = (SELECT concept_id FROM concept WHERE code = @${prefix}_anc_code AND cs_id = @${prefix}_cs)`,
        };
      }
      if (op === 'in') {
        // Value set membership
        const url = this.#resolveInValueSetUrl(value);
        params[`${prefix}_vs_url`] = url;
        params[`${prefix}_cs`] = this.#meta.csId;
        return {
          sql: '1=1',
          joins: `JOIN value_set_member vsm_${prefix} ON vsm_${prefix}.concept_id = ${alias}.concept_id AND vsm_${prefix}.active = 1`
            + ` JOIN value_set vs_${prefix} ON vs_${prefix}.vs_id = vsm_${prefix}.vs_id AND vs_${prefix}.url = @${prefix}_vs_url AND vs_${prefix}.cs_id = @${prefix}_cs`,
        };
      }
    }

    // ── code regex filter (eager JS-side matching) ──
    if (property === 'code' && op === 'regex') {
      // Return null here — handled via _v0CodeRegex on the filter context
      return { _codeRegex: value };
    }

    // ── generic property filters (with full alias/config resolution) ──
    const propCfg = this.#resolvePropertyFilterConfig(property);
    if (!propCfg) return null;

    const propDef = this.#propDefs.get(propCfg.propertyCode);
    if (!propDef) return null;

    if (op === '=') {
      const candidates = normalizedFilterCandidates(value, propCfg.value);
      if (candidates.length === 0) return { sql: '0=1', joins: '' };
      // Use codeSet approach: eagerly compute matching codes
      const codes = this.#propertyEqualsCodes(propCfg, candidates);
      return { _codeSet: codes };
    }
    if (op === 'in') {
      const members = splitFilterValueList(value);
      const aggregate = new Set();
      for (const member of members) {
        const candidates = normalizedFilterCandidates(member, propCfg.value);
        if (candidates.length === 0) continue;
        for (const code of this.#propertyEqualsCodes(propCfg, candidates)) aggregate.add(code);
      }
      return { _codeSet: [...aggregate] };
    }
    if (op === 'regex') {
      const codes = this.#propertyRegexCodes(propCfg, value);
      return { _codeSet: codes };
    }
    if (op === 'exists') {
      const codes = this.#propertyExistsCodes(propCfg, value);
      return { _codeSet: codes };
    }

    return null;
  }

  /** Find codes matching property = candidates (literal + link sources). */
  #propertyEqualsCodes(propCfg, candidates) {
    const codeSet = new Set();
    if (propCfg.sources.includes('literal')) {
      const placeholders = candidates.map((_, i) => `@pc${i}`).join(',');
      const p = { pid: propCfg.propertyId, cs: this.#meta.csId };
      candidates.forEach((c, i) => { p[`pc${i}`] = c; });
      const rows = this.#db.prepare(
        `SELECT DISTINCT c.code FROM concept_literal cl
         JOIN concept c ON c.concept_id = cl.source_concept_id
         WHERE cl.property_id = @pid AND cl.active = 1 AND c.cs_id = @cs
         AND (cl.value_text COLLATE NOCASE IN (${placeholders}) OR (cl.value_text IS NULL AND cl.value_raw COLLATE NOCASE IN (${placeholders})))`
      ).all(p);
      for (const r of rows) codeSet.add(r.code);
    }
    if (propCfg.sources.includes('link')) {
      const placeholders = candidates.map((_, i) => `@lc${i}`).join(',');
      const p = { pid: propCfg.propertyId, cs: this.#meta.csId };
      candidates.forEach((c, i) => { p[`lc${i}`] = c; });
      let tgtSql = `tgt.code COLLATE NOCASE IN (${placeholders})`;
      if (propCfg.linkMatch === 'code-or-display') {
        tgtSql += ` OR tgt.display COLLATE NOCASE IN (${placeholders})`;
      }
      const rows = this.#db.prepare(
        `SELECT DISTINCT src.code FROM concept_link l
         JOIN concept src ON src.concept_id = l.source_concept_id
         JOIN concept tgt ON tgt.concept_id = l.target_concept_id
         WHERE l.property_id = @pid AND l.active = 1 AND src.cs_id = @cs AND (${tgtSql})`
      ).all(p);
      for (const r of rows) codeSet.add(r.code);
    }
    return [...codeSet].sort();
  }

  /** Find codes matching property regex. */
  #propertyRegexCodes(propCfg, pattern) {
    let regex;
    try { regex = new RegExp(String(pattern || '')); }
    catch (e) { throw new Error(`Invalid regex '${pattern}': ${e.message}`); }
    const codeSet = new Set();
    if (propCfg.sources.includes('literal')) {
      const rows = this.#db.prepare(
        `SELECT c.code, COALESCE(cl.value_text, cl.value_raw) AS value FROM concept_literal cl
         JOIN concept c ON c.concept_id = cl.source_concept_id
         WHERE cl.property_id = @pid AND cl.active = 1 AND c.cs_id = @cs AND COALESCE(cl.value_text, cl.value_raw) IS NOT NULL`
      ).all({ pid: propCfg.propertyId, cs: this.#meta.csId });
      for (const r of rows) if (regex.test(r.value)) codeSet.add(r.code);
    }
    if (propCfg.sources.includes('link')) {
      const rows = this.#db.prepare(
        `SELECT src.code, tgt.code AS tc, tgt.display AS td FROM concept_link l
         JOIN concept src ON src.concept_id = l.source_concept_id
         JOIN concept tgt ON tgt.concept_id = l.target_concept_id
         WHERE l.property_id = @pid AND l.active = 1 AND src.cs_id = @cs`
      ).all({ pid: propCfg.propertyId, cs: this.#meta.csId });
      for (const r of rows) {
        if ((r.tc && regex.test(r.tc)) || (propCfg.linkMatch === 'code-or-display' && r.td && regex.test(r.td)))
          codeSet.add(r.code);
      }
    }
    return [...codeSet].sort();
  }

  /** Find codes where property exists/not-exists. */
  #propertyExistsCodes(propCfg, value) {
    const expectExists = String(value ?? 'true').toLowerCase() !== 'false';
    const codeSet = new Set();
    if (propCfg.sources.includes('literal')) {
      const rows = this.#db.prepare(
        `SELECT DISTINCT c.code FROM concept_literal cl JOIN concept c ON c.concept_id = cl.source_concept_id
         WHERE cl.property_id = @pid AND cl.active = 1 AND c.cs_id = @cs`
      ).all({ pid: propCfg.propertyId, cs: this.#meta.csId });
      for (const r of rows) codeSet.add(r.code);
    }
    if (propCfg.sources.includes('link')) {
      const rows = this.#db.prepare(
        `SELECT DISTINCT src.code FROM concept_link l JOIN concept src ON src.concept_id = l.source_concept_id
         WHERE l.property_id = @pid AND l.active = 1 AND src.cs_id = @cs`
      ).all({ pid: propCfg.propertyId, cs: this.#meta.csId });
      for (const r of rows) codeSet.add(r.code);
    }
    if (expectExists) return [...codeSet].sort();
    // Invert: all codes minus those that have the property
    const all = this.#db.prepare('SELECT code FROM concept WHERE cs_id = @cs').all({ cs: this.#meta.csId });
    return all.map(r => r.code).filter(c => !codeSet.has(c)).sort();
  }

  /** Run special property handler (e.g. LOINC answers-for derived-link-filter). */
  #runSpecialPropertyHandler(propCfg, op, value) {
    const handler = propCfg.specialHandler;
    if (!handler || handler.kind !== 'derived-link-filter') throw new Error(`Unsupported special handler: ${JSON.stringify(handler)}`);
    const values = op === 'in' ? splitFilterValueList(value) : [String(value ?? '').trim()];
    const allCandidates = new Set();
    for (const v of values) for (const c of normalizedFilterCandidates(v, propCfg.value)) allCandidates.add(c);
    if (allCandidates.size === 0) return [];
    // Seed: direct codes + inverse lookups
    const seedCfg = handler.seed || {};
    const seedCodes = new Set();
    const directPrefixes = Array.isArray(seedCfg.directCodePrefixes) ? seedCfg.directCodePrefixes : [];
    for (const raw of allCandidates) {
      if (seedCfg.allowAnyDirect === true || directPrefixes.some(p => raw.startsWith(p))) seedCodes.add(raw);
    }
    if (seedCfg.inversePropertyCode) {
      const invProp = this.#propDefs.get(seedCfg.inversePropertyCode);
      if (invProp) {
        const codes = [...allCandidates];
        const ph = codes.map((_, i) => `@s${i}`).join(',');
        const p = { cs: this.#meta.csId, pid: invProp.property_id };
        codes.forEach((c, i) => { p[`s${i}`] = c; });
        const rows = this.#db.prepare(
          `SELECT DISTINCT src.code FROM concept_link l
           JOIN concept src ON src.concept_id = l.source_concept_id
           JOIN concept tgt ON tgt.concept_id = l.target_concept_id
           WHERE src.cs_id = @cs AND l.property_id = @pid AND l.active = 1 AND tgt.code IN (${ph})`
        ).all(p);
        for (const r of rows) seedCodes.add(r.code);
      }
    }
    if (seedCodes.size === 0) return [];
    // Projection
    const projCfg = handler.projection || {};
    const projProp = this.#propDefs.get(projCfg.propertyCode);
    if (!projProp) return [];
    const side = projCfg.side === 'source' ? 'source' : 'target';
    const seeds = [...seedCodes];
    const ph = seeds.map((_, i) => `@p${i}`).join(',');
    const p = { cs: this.#meta.csId, pid: projProp.property_id };
    seeds.forEach((c, i) => { p[`p${i}`] = c; });
    const rows = this.#db.prepare(
      `SELECT DISTINCT ${side === 'source' ? 'src' : 'tgt'}.code FROM concept_link l
       JOIN concept src ON src.concept_id = l.source_concept_id
       JOIN concept tgt ON tgt.concept_id = l.target_concept_id
       WHERE src.cs_id = @cs AND l.property_id = @pid AND l.active = 1 AND src.code IN (${ph})`
    ).all(p);
    return rows.map(r => r.code).sort();
  }

  /** Resolve property filter config with alias resolution (ported from codex). */
  #resolvePropertyFilterConfig(propertyCode) {
    if (!propertyCode) return null;
    const filtersCfg = this.#runtime.filters?.properties;
    if (!filtersCfg) {
      const propDef = this.#propDefs.get(propertyCode);
      if (!propDef) return null;
      return {
        propertyId: propDef.property_id, propertyCode,
        operators: ['=', 'in'], sources: inferSourcesFromValueKind(propDef.value_kind),
        linkMatch: 'code-only', value: {}, specialHandler: null,
      };
    }
    const aliases = filtersCfg.aliases || {};
    const rawCode = String(propertyCode);
    const aliasTarget = aliases[rawCode] ?? aliases[rawCode.toLowerCase()];
    const resolvedCode = aliasTarget || rawCode;
    const byCode = filtersCfg.byCode || {};
    const specific = byCode[resolvedCode] || byCode[rawCode] || null;
    if (!specific && filtersCfg.allPropertiesFilterable !== true) return null;
    const propDef = this.#propDefs.get(resolvedCode);
    if (!propDef) return null;
    const operators = Array.isArray(specific?.operators) && specific.operators.length > 0
      ? specific.operators
      : (Array.isArray(filtersCfg.defaultOperators) && filtersCfg.defaultOperators.length > 0 ? filtersCfg.defaultOperators : ['=']);
    const defaultSources = Array.isArray(filtersCfg.defaultSources) ? filtersCfg.defaultSources : inferSourcesFromValueKind(propDef.value_kind);
    const sources = Array.isArray(specific?.sources) && specific.sources.length > 0 ? specific.sources : defaultSources;
    const linkMatch = specific?.linkMatch || filtersCfg.defaultLinkMatch || 'code-only';
    const valueCfg = { ...(filtersCfg.defaultValue || {}), ...(specific?.value || {}) };
    return {
      propertyId: propDef.property_id, propertyCode: resolvedCode,
      operators, sources: dedupSources(sources, propDef.value_kind),
      linkMatch, value: valueCfg, specialHandler: specific?.specialHandler || null,
    };
  }

  /** Normalize filter values (case, aliases) based on runtime config. */
  #normalizeFilterValue(property, value) {
    const propCfg = this.#runtime.filters?.properties?.byCode?.[property];
    if (propCfg?.value?.aliases) {
      const lower = value.toLowerCase();
      if (propCfg.value.aliases[lower] !== undefined) {
        return propCfg.value.aliases[lower];
      }
    }
    if (propCfg?.value?.normalizeCase || this.#runtime.filters?.properties?.defaultValue?.normalizeCase) {
      // Capitalize first letter
      return value.charAt(0).toUpperCase() + value.slice(1);
    }
    return value;
  }

  /** Resolve a value for concept-in filter to a value set URL. */
  #resolveInValueSetUrl(value) {
    const implicitVS = this.#runtime.implicitValueSets;
    if (implicitVS?.refset?.queryPrefix) {
      // SNOMED refset pattern: value is a concept code, URL is the VS URL
      return `${this.system()}?fhir_vs=refset/${value}`;
    }
    // Default: value is already a URL or we construct one
    return value;
  }

  // ── IR engine integration (Phase 1) ────────────────────────────────

  /**
   * Execute an IR subtree scoped to this code system.
   * Compiles the IR to a single SQL query via sqlite-v0-sql.js and
   * returns results as an array of candidates.
   *
   * @param {Object} subtree - optimized IR node from rewrite.js
   * @param {Object} opts - { activeOnly, text, count, offset }
   * @returns {Object} { candidates: [{code, display, definition, active, conceptId}], total?: number }
   */
  executeIR(subtree, opts = {}) {
    if (!subtree || subtree.kind === 'empty') {
      return { candidates: [], total: 0 };
    }

    // Supply density hints for the EXISTS rewrite optimization.
    // Quick closure count (0.1-5ms) lets the SQL builder choose between
    // EXISTS (fast for dense sets) and JOIN+sort (fast for sparse sets).
    const enrichedOpts = { ...opts };
    enrichedOpts._conceptCount = this.#getConceptCount();
    enrichedOpts._closureCount = this.#getClosureCount(subtree);

    const { sql, params } = buildExpandSql(
      subtree, this.#meta.csId, enrichedOpts, this.#propDefs, this.#runtime
    );

    if (sql.includes('WHERE 0')) {
      return { candidates: [], total: 0 };
    }

    const rows = this.#db.prepare(sql).all(params);
    const candidates = rows
      .filter(r => r.code != null)
      .map(r => ({
        code: r.code,
        display: r.display,
        definition: r.definition,
        active: !!r.active,
        conceptId: r.concept_id,
      }));

    return { candidates };
  }

  /**
   * Build a membership checker for an IR subtree.
   * Returns an object with a .has(code) method for point-checking.
   *
   * @param {Object} subtree - optimized IR node
   * @returns {{ has: (code: string) => boolean }}
   */
  membershipForIR(subtree) {
    if (!subtree || subtree.kind === 'empty') {
      return { has: () => false };
    }

    const { sql, params } = buildMembershipSql(
      subtree, this.#meta.csId, '_mbr', this.#propDefs, this.#runtime
    );

    if (sql.includes('WHERE 0')) {
      return { has: () => false };
    }

    const stmt = this.#db.prepare(sql);
    return {
      has(code) {
        const result = stmt.get({ ...params, _checkCode: code });
        return !!result;
      }
    };
  }

  /**
   * Count results for an IR subtree without fetching them.
   * @param {Object} subtree - optimized IR node
   * @param {Object} opts - { activeOnly }
   * @returns {number}
   */
  countForIR(subtree, opts = {}) {
    if (!subtree || subtree.kind === 'empty') return 0;

    const enrichedOpts = { ...opts,
      _conceptCount: this.#getConceptCount(),
      _closureCount: this.#getClosureCount(subtree),
    };
    const { sql, params } = buildCountSql(
      subtree, this.#meta.csId, '_cnt', this.#propDefs, this.#runtime, enrichedOpts
    );

    const row = this.#db.prepare(sql).get(params);
    return row?.cnt ?? 0;
  }

  /** Whether this provider supports native IR execution. */
  hasExecuteIR() { return true; }

  /**
   * Bulk-fetch designations for a set of concept IDs.
   * Returns Map<conceptId, Array<{language, use, value, active}>>.
   */
  bulkDesignations(conceptIds) {
    if (!conceptIds || conceptIds.length === 0) return new Map();
    const result = new Map();
    const useMapping = this.#runtime.designations?.useMapping || {};

    // SQLite has a limit on compound SELECT terms; batch if needed
    const batchSize = 500;
    for (let i = 0; i < conceptIds.length; i += batchSize) {
      const batch = conceptIds.slice(i, i + batchSize);
      const placeholders = batch.map((_, j) => `@id${i + j}`).join(',');
      const params = {};
      batch.forEach((id, j) => { params[`id${i + j}`] = id; });

      const sql = `SELECT concept_id, language_code, use_code, term, active, preferred
        FROM designation WHERE concept_id IN (${placeholders})`;
      const rows = this.#db.prepare(sql).all(params);

      for (const row of rows) {
        if (!result.has(row.concept_id)) result.set(row.concept_id, []);
        const use = useMapping[row.use_code]
          ? { system: useMapping[row.use_code].system, code: useMapping[row.use_code].code, display: useMapping[row.use_code].display }
          : row.use_code ? { system: this.system(), code: row.use_code } : null;
        result.get(row.concept_id).push({
          language: row.language_code,
          use,
          value: row.term,
          active: !!row.active,
          preferred: !!row.preferred,
        });
      }
    }
    return result;
  }

  /**
   * Bulk-fetch concept-valued properties for a set of concept IDs.
   * Returns Map<conceptId, Array<{code, value}>>.
   */
  bulkProperties(conceptIds) {
    if (!conceptIds || conceptIds.length === 0) return new Map();
    const result = new Map();
    const batchSize = 500;

    for (let i = 0; i < conceptIds.length; i += batchSize) {
      const batch = conceptIds.slice(i, i + batchSize);
      const placeholders = batch.map((_, j) => `@id${i + j}`).join(',');
      const params = {};
      batch.forEach((id, j) => { params[`id${i + j}`] = id; });

      // Concept-valued properties
      const linkSql = `SELECT cl.source_concept_id, pd.property_code, c2.code AS target_code, c2.display AS target_display
        FROM concept_link cl
        JOIN property_def pd ON pd.property_id = cl.property_id
        JOIN concept c2 ON c2.concept_id = cl.target_concept_id
        WHERE cl.source_concept_id IN (${placeholders}) AND cl.active = 1`;
      for (const row of this.#db.prepare(linkSql).all(params)) {
        if (!result.has(row.source_concept_id)) result.set(row.source_concept_id, []);
        result.get(row.source_concept_id).push({
          code: row.property_code,
          value: { system: this.system(), code: row.target_code, display: row.target_display },
        });
      }

      // Literal-valued properties
      const litSql = `SELECT cl.source_concept_id, pd.property_code, cl.value_raw, cl.value_text, cl.value_num
        FROM concept_literal cl
        JOIN property_def pd ON pd.property_id = cl.property_id
        WHERE cl.source_concept_id IN (${placeholders}) AND cl.active = 1`;
      for (const row of this.#db.prepare(litSql).all(params)) {
        const value = row.value_text ?? row.value_raw ?? (row.value_num != null ? String(row.value_num) : null);
        if (value != null) {
          if (!result.has(row.source_concept_id)) result.set(row.source_concept_id, []);
          result.get(row.source_concept_id).push({ code: row.property_code, value });
        }
      }
    }
    return result;
  }

  close() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
  }
}

// ── Factory (long-lived, loaded at startup) ─────────────────────────

class SqliteV0FactoryProvider extends CodeSystemFactoryProvider {
  #dbPath;
  #meta;       // { csId, baseUri, canonicalUri, version, name, editionCode }
  #runtime;    // parsed cs_config values
  #propDefs;   // Map<propertyCode, {property_id, value_kind, is_hierarchy}>
  #loaded = false;

  constructor(i18n, dbPath) {
    super(i18n);
    this.#dbPath = dbPath;
  }

  async load() {
    const db = new BetterSqlite3(this.#dbPath, { readonly: true });
    try {
      // Apply perf pragmas
      db.pragma('cache_size = 10000');
      db.pragma('temp_store = MEMORY');
      db.pragma('mmap_size = 268435456');

      // Load code_system metadata
      const cs = db.prepare('SELECT * FROM code_system LIMIT 1').get();
      if (!cs) throw new Error(`No code_system row in ${this.#dbPath}`);
      this.#meta = {
        csId: cs.cs_id,
        baseUri: cs.base_uri,
        editionCode: cs.edition_code,
        version: cs.version,
        canonicalUri: cs.canonical_uri,
        name: cs.name,
      };

      // Load runtime config with defaults
      const rawCfg = {};
      const configs = db.prepare('SELECT key, value FROM cs_config WHERE cs_id = @cs').all({ cs: cs.cs_id });
      for (const cfg of configs) {
        const shortKey = cfg.key.replace(/^runtime\./, '');
        try { rawCfg[shortKey] = JSON.parse(cfg.value); }
        catch { rawCfg[shortKey] = cfg.value; }
      }
      this.#runtime = buildRuntimeConfig(rawCfg, cs.base_uri);

      // Load property definitions
      this.#propDefs = new Map();
      const props = db.prepare('SELECT * FROM property_def WHERE cs_id = @cs').all({ cs: cs.cs_id });
      for (const p of props) {
        this.#propDefs.set(p.property_code, {
          property_id: p.property_id,
          value_kind: p.value_kind,
          is_hierarchy: !!p.is_hierarchy,
          display: p.display,
        });
      }

      this.#loaded = true;
    } finally {
      db.close();
    }
  }

  system() {
    return this.#meta?.baseUri || 'unknown';
  }

  version() {
    return this.#meta?.canonicalUri || null;
  }

  name() {
    return this.#meta?.name || 'sqlite-v0';
  }

  defaultVersion() {
    return this.#meta?.version || 'unknown';
  }

  id() {
    return `sqlite-v0-${this.#meta?.baseUri}-${this.#meta?.version}`;
  }

  iteratable() {
    return true;
  }

  async build(opContext, supplements) {
    this.recordUse();
    const db = new BetterSqlite3(this.#dbPath, { readonly: true });
    db.pragma('cache_size = 10000');
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 268435456');
    return new SqliteV0Provider(opContext, supplements, db, this.#meta, this.#runtime, this.#propDefs);
  }

  /** Build implicit value sets from URL patterns (like SNOMED's fhir_vs=isa/X). */
  async buildKnownValueSet(url, vsVersion) {
    if (vsVersion && this.#meta.version && vsVersion !== this.#meta.version) {
      return null;
    }

    const implicitVS = this.#runtime.implicitValueSets;
    if (!implicitVS) return null;

    const base = this.system();

    // Check for "all codes" value set
    if (implicitVS.all?.queries) {
      for (const q of implicitVS.all.queries) {
        if (url === `${base}?${q}`) {
          return {
            resourceType: 'ValueSet',
            url,
            version: this.version(),
            status: 'active',
            name: `AllCodesFor${this.name()}`,
            compose: { include: [{ system: base }] },
          };
        }
      }
    }

    // Check all implicit VS patterns (isa, refset, etc.) generically
    for (const [name, cfg] of Object.entries(implicitVS)) {
      if (!cfg || !cfg.queryPrefix || !cfg.filter) continue;
      const prefix = `${base}?${cfg.queryPrefix}`;
      if (!url.startsWith(prefix)) continue;
      const suffix = url.substring(prefix.length);
      const filterValue = cfg.filter.valueFromSuffix ? suffix : cfg.filter.value;
      return {
        resourceType: 'ValueSet',
        url,
        version: this.version(),
        status: 'active',
        name: `${sanitizeName(base)}${name}${suffix}`,
        compose: { include: [{ system: base, filter: [{ property: cfg.filter.property, op: cfg.filter.op, value: filterValue }] }] },
      };
    }

    // Check value_set table for explicit value sets
    const db = new BetterSqlite3(this.#dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT * FROM value_set WHERE url = @url AND cs_id = @cs').get({ url, cs: this.#meta.csId });
      if (row) {
        // Fetch member codes
        const members = db.prepare(
          `SELECT c.code FROM value_set_member vsm
           JOIN concept c ON c.concept_id = vsm.concept_id
           WHERE vsm.vs_id = @vsId AND vsm.active = 1`)
          .all({ vsId: row.vs_id });
        return {
          resourceType: 'ValueSet',
          url: row.url,
          version: row.version || this.version(),
          status: 'active',
          name: row.name || url,
          compose: {
            include: [{
              system: base,
              concept: members.map(m => ({ code: m.code })),
            }],
          },
        };
      }
    } finally {
      db.close();
    }

    return null;
  }

  getPartialVersion() {
    const ver = this.#meta?.version;
    if (ver && VersionUtilities.isSemVer(ver)) {
      return VersionUtilities.getMajMin(ver);
    }
    return ver;
  }
}

module.exports = {
  SqliteV0Provider,
  SqliteV0FactoryProvider,
  V0ConceptContext,
};
