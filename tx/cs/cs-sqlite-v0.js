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

  contentMode() { return CodeSystemContentMode.COMPLETE; }
  isNotClosed() { return false; }
  hasParents()  { return this.#closureOk; }

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
    return ctx.active ? 'active' : 'inactive';
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
    if (prop === 'code' && filtersCfg.code?.operators?.includes(op)) return true;
    // Check per-property config
    if (filtersCfg.properties?.byCode?.[prop]) {
      return filtersCfg.properties.byCode[prop].operators?.includes(op) ?? false;
    }
    if (filtersCfg.properties?.allPropertiesFilterable) return true;
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
    filterContext._v0.search = text;
  }

  async executeFilters(filterContext) {
    const { filters, search } = filterContext._v0;
    const params = { cs: this.#meta.csId };
    const joins = [];
    const wheres = [`c.cs_id = @cs`];
    let idx = 0;

    for (const f of filters) {
      const frag = this.#buildFilterFragment(f, `f${idx}`, 'c', params);
      if (frag) {
        if (frag.joins) joins.push(frag.joins);
        if (frag.sql) wheres.push(frag.sql);
      }
      idx++;
    }

    if (search) {
      const searchCfg = this.#runtime.search;
      if (searchCfg?.mode?.startsWith('fts')) {
        // FTS5 search on display table
        const ftsTable = searchCfg.ftsTables?.display || 'search_fts_display';
        params.search_term = `"${search.replace(/"/g, '""')}"*`;
        joins.push(`JOIN ${ftsTable} fts ON fts.rowid = c.concept_id`);
        wheres.push(`${ftsTable} MATCH @search_term`);
      } else {
        // LIKE fallback
        params.search_like = `%${search}%`;
        wheres.push(`c.display LIKE @search_like`);
      }
    }

    const sql = `SELECT c.concept_id, c.code, c.display, c.definition, c.active
      FROM concept c ${joins.join(' ')}
      WHERE ${wheres.join(' AND ')}
      ORDER BY c.code`;

    const rows = this.#db.prepare(sql).all(params);
    filterContext._v0.resultSet = new V0FilterSet(rows);
    return [filterContext._v0.resultSet];
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
    let sql = 'SELECT concept_id, code, display, definition, active FROM concept WHERE cs_id = @cs';
    const params = { cs: this.#meta.csId };

    // Apply code regex filter if configured (like LOINC's "only codes matching X")
    if (iterCfg?.defaultCodeRegex) {
      // SQLite doesn't natively support regex, so we do GLOB-style or filter in JS
      // For now, fetch all and let the caller deal with it
    }

    sql += ' ORDER BY code';
    const rows = this.#db.prepare(sql).all(params);
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

    // ── code regex filter ──
    if (property === 'code' && op === 'regex') {
      // SQLite doesn't support REGEXP natively; use GLOB or load all + filter in JS
      // For now, fall through to property-based approach
    }

    // ── generic property filters ──
    const propDef = this.#propDefs.get(property);
    if (!propDef) return null;

    if (propDef.value_kind === 'concept') {
      // Property that points to another concept
      const propCfg = filtersCfg.properties?.byCode?.[property];
      const linkMatch = propCfg?.linkMatch || filtersCfg.properties?.defaultLinkMatch || 'code';

      if (op === '=') {
        params[`${prefix}_pid`] = propDef.property_id;
        params[`${prefix}_val`] = this.#normalizeFilterValue(property, value);
        if (linkMatch === 'code-or-display') {
          return {
            sql: `(tgt_${prefix}.code = @${prefix}_val OR tgt_${prefix}.display = @${prefix}_val)`,
            joins: `JOIN concept_link lnk_${prefix} ON lnk_${prefix}.source_concept_id = ${alias}.concept_id AND lnk_${prefix}.property_id = @${prefix}_pid AND lnk_${prefix}.active = 1`
              + ` JOIN concept tgt_${prefix} ON tgt_${prefix}.concept_id = lnk_${prefix}.target_concept_id`,
          };
        }
        return {
          sql: `tgt_${prefix}.code = @${prefix}_val`,
          joins: `JOIN concept_link lnk_${prefix} ON lnk_${prefix}.source_concept_id = ${alias}.concept_id AND lnk_${prefix}.property_id = @${prefix}_pid AND lnk_${prefix}.active = 1`
            + ` JOIN concept tgt_${prefix} ON tgt_${prefix}.concept_id = lnk_${prefix}.target_concept_id`,
        };
      }
    }

    if (propDef.value_kind !== 'concept') {
      // Literal property
      if (op === '=') {
        params[`${prefix}_pid`] = propDef.property_id;
        params[`${prefix}_val`] = this.#normalizeFilterValue(property, value);
        return {
          sql: `lit_${prefix}.value_text = @${prefix}_val`,
          joins: `JOIN concept_literal lit_${prefix} ON lit_${prefix}.source_concept_id = ${alias}.concept_id AND lit_${prefix}.property_id = @${prefix}_pid AND lit_${prefix}.active = 1`,
        };
      }
      if (op === 'regex') {
        // SQLite REGEXP requires extension; for now match via LIKE if pattern is simple
        params[`${prefix}_pid`] = propDef.property_id;
        // Convert simple regex to LIKE (basic heuristic)
        const likeValue = value.replace(/\.\*/g, '%').replace(/\./g, '_');
        params[`${prefix}_val`] = likeValue;
        return {
          sql: `lit_${prefix}.value_text LIKE @${prefix}_val`,
          joins: `JOIN concept_literal lit_${prefix} ON lit_${prefix}.source_concept_id = ${alias}.concept_id AND lit_${prefix}.property_id = @${prefix}_pid AND lit_${prefix}.active = 1`,
        };
      }
      if (op === 'exists') {
        params[`${prefix}_pid`] = propDef.property_id;
        if (value === 'true') {
          return {
            sql: '1=1',
            joins: `JOIN concept_literal lit_${prefix} ON lit_${prefix}.source_concept_id = ${alias}.concept_id AND lit_${prefix}.property_id = @${prefix}_pid AND lit_${prefix}.active = 1`,
          };
        } else {
          return {
            sql: `NOT EXISTS (SELECT 1 FROM concept_literal lit2 WHERE lit2.source_concept_id = ${alias}.concept_id AND lit2.property_id = @${prefix}_pid AND lit2.active = 1)`,
            joins: '',
          };
        }
      }
    }

    return null;
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

      // Load runtime config
      this.#runtime = {};
      const configs = db.prepare('SELECT key, value FROM cs_config WHERE cs_id = @cs').all({ cs: cs.cs_id });
      for (const cfg of configs) {
        const shortKey = cfg.key.replace(/^runtime\./, '');
        try {
          this.#runtime[shortKey] = JSON.parse(cfg.value);
        } catch {
          this.#runtime[shortKey] = cfg.value;
        }
      }

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

    // Check for is-a pattern (e.g., ?fhir_vs=isa/73211009)
    if (implicitVS.isa?.queryPrefix) {
      const prefix = `${base}?${implicitVS.isa.queryPrefix}`;
      if (url.startsWith(prefix)) {
        const code = url.substring(prefix.length);
        const filter = { ...implicitVS.isa.filter };
        if (filter.valueFromSuffix) {
          filter.value = code;
          delete filter.valueFromSuffix;
        }
        return {
          resourceType: 'ValueSet',
          url,
          version: this.version(),
          status: 'active',
          name: `IsA_${code}`,
          compose: { include: [{ system: base, filter: [filter] }] },
        };
      }
    }

    // Check for refset pattern (e.g., ?fhir_vs=refset/447566000)
    if (implicitVS.refset?.queryPrefix) {
      const prefix = `${base}?${implicitVS.refset.queryPrefix}`;
      if (url.startsWith(prefix)) {
        const code = url.substring(prefix.length);
        const filter = { ...implicitVS.refset.filter };
        if (filter.valueFromSuffix) {
          filter.value = code;
          delete filter.valueFromSuffix;
        }
        return {
          resourceType: 'ValueSet',
          url,
          version: this.version(),
          status: 'active',
          name: `Refset_${code}`,
          compose: { include: [{ system: base, filter: [filter] }] },
        };
      }
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
