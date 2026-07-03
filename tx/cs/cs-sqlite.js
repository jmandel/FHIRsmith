'use strict';

// Generic sqlite-v1 CodeSystem provider.
//
// ONE provider class serves LOINC / RxNorm / SNOMED CT (and any tabular
// terminology) from the shared sqlite-v1 schema (tx/importers/schema-v1.sql).
// ALL per-terminology behavior is derived from database metadata:
//   - code_system row      -> system/version/description/totalCount/contentMode
//   - cs_config key/value  -> caseSensitive/defaultLanguage/statusProperty/...
//   - property_def rows    -> propertyDefinitions, filter resolution, typing
//   - closure table        -> is-a/descendent-of/generalizes/subsumesTest
// There are NO terminology-specific code paths in this file.
//
// See docs/sqlite-v1-design.md for the config-key registry and semantics.

const assert = require('assert');
const Database = require('better-sqlite3');

const { CodeSystem, CodeSystemContentMode } = require('../library/codesystem');
const { Language } = require('../../library/languages');
const { CodeSystemFactoryProvider, FilterExecutionContext } = require('./cs-api');
const { BaseCSServices } = require('./cs-base');
const regexUtilities = require('../../library/regex-utilities');

// ---------------------------------------------------------------------------
// Small value objects
// ---------------------------------------------------------------------------

/**
 * Opaque concept handle returned by locate() and the iteration/filter
 * machinery. Carries everything the per-concept getters need so a single
 * row fetch by locate() serves the whole request.
 */
class SqliteConceptContext {
  constructor(row) {
    this.conceptId = row.concept_id;
    this.code = row.code;
    this.display = row.display;
    this.active = row.active !== 0;
    this.definition = row.definition;
  }
}

/**
 * Cursor over an ordered list of concept_ids. Used for iterator() /
 * iteratorAll() (roots, children, or all concepts). Carries .total when
 * cheaply known because expand.js reads iter.total.
 */
class SqliteIterator {
  constructor(ids) {
    this.ids = ids;          // number[]
    this.cursor = 0;
    this.total = ids.length;
  }
}

/**
 * A resolved filter result set. `ids` is a sorted number[] of concept_ids;
 * `cursor` supports forward iteration; membership tests binary-search `ids`.
 */
class SqliteFilterSet {
  constructor(ids) {
    this.ids = ids;          // sorted number[]
    this.cursor = -1;
    this._batch = null;      // prefetched {conceptId -> context} for iteration
    this._batchStart = -1;
  }
}

/** A single pending filter clause, compiled to SQL by executeFilters. */
class FilterClause {
  constructor(kind, spec) {
    this.kind = kind;        // 'set' (SQL yielding ids) — always, here
    this.spec = spec;
  }
}

class SqlitePrep extends FilterExecutionContext {
  constructor(forIterate) {
    super(forIterate);
    this.clauses = [];       // FilterClause[]
  }
}

// Binary search: is `id` present in the sorted array `ids`?
function sortedIncludes(ids, id) {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ids[mid];
    if (v < id) lo = mid + 1;
    else if (v > id) hi = mid - 1;
    else return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class SqliteCodeSystemProvider extends BaseCSServices {
  constructor(opContext, supplements, factory) {
    super(opContext, supplements);
    this.factory = factory;
    this.db = factory.db;          // shared read-only connection
    this.cfg = factory.cfg;        // parsed config object
    this.meta = factory.meta;      // code_system row
    this.propByCode = factory.propByCode;
    this.propById = factory.propById;
    this.csId = factory.csId;
  }

  close() {
    // The connection is owned by the factory; provider instances are cheap
    // wrappers and must not close the shared connection.
    this.db = null;
  }

  // ---- metadata (data-driven) --------------------------------------------

  system() { return this.meta.base_uri; }
  version() { return this.meta.version || null; }
  description() { return this.meta.description || this.meta.title || this.meta.name || null; }
  async totalCount() { return this.factory.totalCount; }
  contentMode() { return this.meta.content_mode || CodeSystemContentMode.Complete; }

  defLang() { return this.cfg.defaultLanguage || 'en'; }
  isCaseSensitive() { return this.cfg.caseSensitive !== false; }
  versionAlgorithm() { return this.cfg.versionAlgorithm || null; }
  hasParents() { return this.factory.hasHierarchy; }

  status() {
    const s = {};
    if (this.cfg.status) s.status = this.cfg.status;
    if (this.cfg.standardsStatus) s.standardsStatus = this.cfg.standardsStatus;
    if (this.cfg.experimental !== undefined) s.experimental = this.cfg.experimental;
    return s;
  }

  propertyDefinitions() {
    // CodeSystem.property[] derived from property_def rows.
    const out = [];
    for (const p of this.propById.values()) {
      const def = { code: p.property_code, type: p.fhir_type };
      if (p.uri) def.uri = p.uri;
      if (p.display) def.description = p.display;
      out.push(def);
    }
    return out.length ? out : null;
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) return true;
    if (langs.isEnglishOrNothing() && this.defLang().startsWith('en')) return true;

    const defL = new Language(this.defLang());
    for (const requested of langs) {
      if (defL.matchesForDisplay(requested)) return true;
    }
    // Designation languages present in the DB (cached DISTINCT at load).
    for (const code of this.factory.designationLangs) {
      const dl = new Language(code);
      for (const requested of langs) {
        if (dl.matchesForDisplay(requested)) return true;
      }
    }
    return super.hasAnyDisplays(langs);
  }

  // ---- concept context resolution ----------------------------------------

  _rowById(conceptId) {
    return this.db.prepare(
      `SELECT concept_id, code, active, display, definition
         FROM concept WHERE cs_id = ? AND concept_id = ?`
    ).get(this.csId, conceptId);
  }

  _lookupRow(code) {
    if (this.isCaseSensitive()) {
      return this.db.prepare(
        `SELECT concept_id, code, active, display, definition
           FROM concept WHERE cs_id = ? AND code = ?`
      ).get(this.csId, code);
    }
    // Case-insensitive: use the NOCASE index.
    return this.db.prepare(
      `SELECT concept_id, code, active, display, definition
         FROM concept WHERE cs_id = ? AND code = ? COLLATE NOCASE`
    ).get(this.csId, code);
  }

  async _ensure(context) {
    if (!context) return null;
    if (typeof context === 'string') {
      const res = await this.locate(context);
      if (!res.context) throw new Error(res.message || `Code '${context}' not found`);
      return res.context;
    }
    if (context instanceof SqliteConceptContext) return context;
    throw new Error('Unknown context type in cs-sqlite: ' + (typeof context));
  }

  // ---- lookup ------------------------------------------------------------

  async locate(code) {
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const row = this._lookupRow(code);
    if (row) {
      return { context: new SqliteConceptContext(row), message: null };
    }
    return {
      context: null,
      message: `Unknown code '${code}' in the CodeSystem ${this.vurl()}`,
    };
  }

  async code(context) {
    const c = await this._ensure(context);
    return c ? c.code : null;
  }

  async display(context) {
    const c = await this._ensure(context);
    if (!c) return null;

    // Supplements override first (per cs-api base helper semantics).
    const supp = this._displayFromSupplements(c.code);
    if (supp) return supp;

    // If a non-English/other language is preferred, choose the best
    // designation for that language (preferred flag first).
    if (this.opContext.langs && !this.opContext.langs.isEnglishOrNothing()) {
      const best = this._bestDesignationForLangs(c.conceptId);
      if (best) return best;
    }
    return c.display || '';
  }

  _bestDesignationForLangs(conceptId) {
    const rows = this.db.prepare(
      `SELECT language_code, term, preferred
         FROM designation WHERE concept_id = ? AND active = 1
        ORDER BY preferred DESC`
    ).all(conceptId);
    for (const requested of this.opContext.langs) {
      // preferred first (rows already ordered), exact/for-display match
      for (const r of rows) {
        if (!r.language_code) continue;
        const dl = new Language(r.language_code);
        if (dl.matchesForDisplay(requested)) return r.term;
      }
    }
    return null;
  }

  async definition(context) {
    const c = await this._ensure(context);
    return c ? (c.definition || null) : null;
  }

  async isAbstract() { return false; }
  async isDeprecated() { return false; }
  async itemWeight() { return null; }
  async extensions() { return null; }
  async incompleteValidationMessage() { return null; }

  async isInactive(context) {
    const c = await this._ensure(context);
    return c ? !c.active : false;
  }

  async getStatus(context) {
    const prop = this.cfg.statusProperty;
    if (!prop) return null;
    const c = await this._ensure(context);
    if (!c) return null;
    const def = this.propByCode.get(prop);
    if (!def) return null;
    const row = this.db.prepare(
      `SELECT value_raw, value_text FROM concept_literal
        WHERE source_concept_id = ? AND property_id = ? AND active = 1 LIMIT 1`
    ).get(c.conceptId, def.property_id);
    if (!row) return null;
    return row.value_text != null ? row.value_text : row.value_raw;
  }

  async sameConcept(a, b) {
    const ca = await this._ensure(a);
    const cb = await this._ensure(b);
    if (!ca || !cb) return false;
    if (this.isCaseSensitive()) return ca.code === cb.code;
    return ca.code.toLowerCase() === cb.code.toLowerCase();
  }

  // ---- designations ------------------------------------------------------

  async designations(context, displays) {
    const c = await this._ensure(context);
    if (!c) return;

    // The denormalized display counts as a display-use designation in the
    // code system's default language.
    if (c.display) {
      displays.addDesignation(true, 'active', this.defLang(), CodeSystem.makeUseForDisplay(), c.display);
    }

    const rows = this.db.prepare(
      `SELECT language_code, use_system, use_code, term, active, preferred
         FROM designation WHERE concept_id = ?`
    ).all(c.conceptId);
    for (const r of rows) {
      let use = null;
      if (r.use_system || r.use_code) {
        use = { system: r.use_system || undefined, code: r.use_code || undefined };
      }
      displays.addDesignation(false, r.active ? 'active' : 'inactive', r.language_code || null, use, r.term);
    }

    this._listSupplementDesignations(c.code, displays);
  }

  // ---- properties --------------------------------------------------------

  async properties(context) {
    const c = await this._ensure(context);
    if (!c) return [];
    const result = [];

    // Concept-valued properties (concept_link): target concept code.
    const links = this.db.prepare(
      `SELECT pd.property_code AS code, pd.fhir_type AS fhir_type, tc.code AS target_code
         FROM concept_link cl
         JOIN property_def pd ON pd.property_id = cl.property_id
         JOIN concept tc ON tc.concept_id = cl.target_concept_id
        WHERE cl.source_concept_id = ? AND cl.active = 1`
    ).all(c.conceptId);
    for (const l of links) {
      if (l.fhir_type === 'Coding') {
        result.push({ code: l.code, valueCoding: { system: this.system(), code: l.target_code } });
      } else {
        result.push({ code: l.code, valueCode: l.target_code });
      }
    }

    // Literal-valued properties (concept_literal): typed per fhir_type.
    const lits = this.db.prepare(
      `SELECT pd.property_code AS code, pd.fhir_type AS fhir_type,
              cl.value_raw, cl.value_text, cl.value_num, cl.value_bool
         FROM concept_literal cl
         JOIN property_def pd ON pd.property_id = cl.property_id
        WHERE cl.source_concept_id = ? AND cl.active = 1`
    ).all(c.conceptId);
    for (const l of lits) {
      result.push(this._literalToProperty(l));
    }
    return result;
  }

  _literalToProperty(l) {
    const p = { code: l.code };
    switch (l.fhir_type) {
      case 'integer':
        p.valueInteger = l.value_num != null ? Math.trunc(l.value_num) : parseInt(l.value_raw, 10);
        break;
      case 'decimal':
        p.valueDecimal = l.value_num != null ? l.value_num : parseFloat(l.value_raw);
        break;
      case 'boolean':
        p.valueBoolean = l.value_bool != null ? l.value_bool === 1
          : (l.value_raw === 'true' || l.value_raw === 'Y' || l.value_raw === '1');
        break;
      case 'dateTime':
        p.valueDateTime = l.value_text != null ? l.value_text : l.value_raw;
        break;
      case 'code':
        p.valueCode = l.value_text != null ? l.value_text : l.value_raw;
        break;
      default:
        p.valueString = l.value_text != null ? l.value_text : l.value_raw;
    }
    return p;
  }

  // ---- hierarchy ---------------------------------------------------------

  async parent(context) {
    if (!this.hasParents()) return null;
    const c = await this._ensure(context);
    if (!c) return null;
    const row = this.db.prepare(
      `SELECT tc.code AS code
         FROM concept_link cl
         JOIN concept tc ON tc.concept_id = cl.target_concept_id
        WHERE cl.source_concept_id = ?
          AND cl.property_id IN (${this.factory.hierPropPlaceholders})
          AND cl.edge_set_id = ?
          AND cl.active = 1
        ORDER BY cl.edge_id LIMIT 1`
    ).get(c.conceptId, ...this.factory.hierPropIds, this.factory.hierarchyEdgeSet);
    return row ? row.code : null;
  }

  // Additive helper: all active hierarchy parent codes.
  async parents(context) {
    if (!this.hasParents()) return [];
    const c = await this._ensure(context);
    if (!c) return [];
    return this.db.prepare(
      `SELECT tc.code AS code
         FROM concept_link cl
         JOIN concept tc ON tc.concept_id = cl.target_concept_id
        WHERE cl.source_concept_id = ?
          AND cl.property_id IN (${this.factory.hierPropPlaceholders})
          AND cl.edge_set_id = ?
          AND cl.active = 1`
    ).all(c.conceptId, ...this.factory.hierPropIds, this.factory.hierarchyEdgeSet).map((r) => r.code);
  }

  // closure ancestor test: is `ancestorId` a proper ancestor of `descendantId`?
  _closureHas(ancestorId, descendantId) {
    const row = this.db.prepare(
      `SELECT 1 FROM closure WHERE ancestor_id = ? AND descendant_id = ? LIMIT 1`
    ).get(ancestorId, descendantId);
    return !!row;
  }

  async locateIsA(code, parent, disallowParent) {
    if (!this.hasParents()) {
      return { context: null, message: `The CodeSystem ${this.name()} does not have parents` };
    }
    const located = await this.locate(code);
    if (!located.context) return located;
    const parentRow = this._lookupRow(parent);
    if (!parentRow) {
      return { context: null, message: `Parent code '${parent}' not found` };
    }
    const cId = located.context.conceptId;
    const pId = parentRow.concept_id;
    if (!disallowParent && cId === pId) {
      return { context: located.context, message: null };
    }
    if (this._closureHas(pId, cId)) {
      return { context: located.context, message: null };
    }
    return { context: null, message: `Code '${code}' is not a descendant of '${parent}'` };
  }

  async subsumesTest(codeA, codeB) {
    const a = await this._ensure(codeA);
    const b = await this._ensure(codeB);
    if (!a || !b) return 'not-subsumed';
    if (a.conceptId === b.conceptId) return 'equivalent';
    if (this._closureHas(a.conceptId, b.conceptId)) return 'subsumes';
    if (this._closureHas(b.conceptId, a.conceptId)) return 'subsumed-by';
    return 'not-subsumed';
  }

  // ---- iteration ---------------------------------------------------------

  async iterator(context) {
    if (!context) {
      if (!this.hasParents()) {
        // flat: all concepts
        return new SqliteIterator(this.factory.allConceptIds());
      }
      // roots: concepts with no active hierarchy parent
      return new SqliteIterator(this.factory.rootConceptIds());
    }
    const c = await this._ensure(context);
    if (!c) return new SqliteIterator([]);
    // active hierarchy children of ctx
    const rows = this.db.prepare(
      `SELECT DISTINCT cl.source_concept_id AS id
         FROM concept_link cl
         JOIN concept sc ON sc.concept_id = cl.source_concept_id
        WHERE cl.target_concept_id = ?
          AND cl.property_id IN (${this.factory.hierPropPlaceholders})
          AND cl.edge_set_id = ?
          AND cl.active = 1
        ORDER BY sc.code`
    ).all(c.conceptId, ...this.factory.hierPropIds, this.factory.hierarchyEdgeSet);
    return new SqliteIterator(rows.map((r) => r.id));
  }

  async iteratorAll() {
    return new SqliteIterator(this.factory.allConceptIds());
  }

  async nextContext(iter) {
    if (!iter || iter.cursor >= iter.ids.length) return null;
    const id = iter.ids[iter.cursor++];
    const row = this._rowById(id);
    return row ? new SqliteConceptContext(row) : null;
  }

  // ---- filters -----------------------------------------------------------

  // Resolve a filter property through cs_config filterAliases then property_def.
  _resolveProp(prop) {
    const aliased = (this.cfg.filterAliases && this.cfg.filterAliases[prop]) || prop;
    return { name: aliased, def: this.propByCode.get(aliased) };
  }

  // eslint-disable-next-line no-unused-vars
  async doesFilter(prop, op, value) {
    // Hierarchy operators require a hierarchy.
    if (['is-a', 'descendent-of', 'child-of', 'generalizes'].includes(op)) {
      if (!this.hasParents()) return false;
      // 'concept'/'code' or an aliased hierarchy prop are all acceptable.
      if (prop === 'concept' || prop === 'code') return true;
      const { def } = this._resolveProp(prop);
      return !!(def && def.is_hierarchy);
    }
    // Property operators on any defined property (after alias mapping).
    if (['=', 'in', 'exists', 'regex'].includes(op)) {
      const { def } = this._resolveProp(prop);
      return !!def;
    }
    return false;
  }

  async getPrepContext(iterate) {
    return new SqlitePrep(iterate);
  }

  async filter(filterContext, forIteration, prop, op, value) {
    // Hierarchy ops.
    if (['is-a', 'descendent-of', 'child-of', 'generalizes'].includes(op)) {
      if (!this.hasParents()) {
        throw new Error(`The filter "${prop} ${op} ${value}" is not supported for ${this.system()} (no hierarchy)`);
      }
      filterContext.clauses.push(new FilterClause('hierarchy', { op, value }));
      return;
    }

    const { name, def } = this._resolveProp(prop);
    if (!def) {
      throw new Error(`The filter "${prop} ${op} ${value}" is not supported for ${this.system()}`);
    }
    if (!['=', 'in', 'exists', 'regex'].includes(op)) {
      throw new Error(`The filter operator "${op}" is not supported for property ${name} in ${this.system()}`);
    }
    filterContext.clauses.push(new FilterClause('property', { name, def, op, value }));
  }

  // eslint-disable-next-line no-unused-vars
  async searchFilter(filterContext, filterText, sort) {
    // `sort` is ignored: executeFilters returns a concept_id-sorted set and the
    // expansion engine applies ordering, matching the other sqlite providers.
    const text = (filterText && filterText.filter) ? filterText.filter : (filterText || '');
    filterContext.clauses.push(new FilterClause('search', { text: String(text) }));
  }

  async executeFilters(filterContext) {
    // Each clause compiles to its own set of concept_ids (sorted). The engine
    // joins across sets via filterCheck; we do not join here.
    const sets = [];
    for (const clause of filterContext.clauses) {
      const ids = this._runClause(clause);
      sets.push(new SqliteFilterSet(ids));
    }
    return sets;
  }

  _runClause(clause) {
    if (clause.kind === 'hierarchy') return this._hierarchyIds(clause.spec.op, clause.spec.value);
    if (clause.kind === 'property') return this._propertyIds(clause.spec);
    if (clause.kind === 'search') return this._searchIds(clause.spec.text);
    return [];
  }

  _locateConceptId(code) {
    const row = this._lookupRow(code);
    return row ? row.concept_id : null;
  }

  _hierarchyIds(op, value) {
    const id = this._locateConceptId(value);
    if (id == null) return [];
    let sql;
    let args;
    if (op === 'is-a') {
      // descendants ∪ self
      sql = `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ?
             UNION SELECT ? AS id ORDER BY id`;
      args = [id, id];
    } else if (op === 'descendent-of') {
      sql = `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ? ORDER BY id`;
      args = [id];
    } else if (op === 'generalizes') {
      // ancestors ∪ self
      sql = `SELECT ancestor_id AS id FROM closure WHERE descendant_id = ?
             UNION SELECT ? AS id ORDER BY id`;
      args = [id, id];
    } else if (op === 'child-of') {
      // direct active children
      sql = `SELECT DISTINCT cl.source_concept_id AS id
               FROM concept_link cl
              WHERE cl.target_concept_id = ?
                AND cl.property_id IN (${this.factory.hierPropPlaceholders})
                AND cl.edge_set_id = ?
                AND cl.active = 1
              ORDER BY id`;
      args = [id, ...this.factory.hierPropIds, this.factory.hierarchyEdgeSet];
    } else {
      return [];
    }
    return this.db.prepare(sql).all(...args).map((r) => r.id);
  }

  _propertyIds(spec) {
    const { def, op, value } = spec;
    const isConcept = def.value_kind === 'concept';
    if (op === 'exists') {
      const table = isConcept ? 'concept_link' : 'concept_literal';
      const want = String(value).toLowerCase() !== 'false';
      if (want) {
        return this.db.prepare(
          `SELECT DISTINCT source_concept_id AS id FROM ${table}
            WHERE property_id = ? AND active = 1 ORDER BY id`
        ).all(def.property_id).map((r) => r.id);
      }
      // NOT EXISTS: all concepts in this cs lacking the property.
      return this.db.prepare(
        `SELECT concept_id AS id FROM concept
          WHERE cs_id = ? AND concept_id NOT IN
            (SELECT source_concept_id FROM ${table} WHERE property_id = ? AND active = 1)
          ORDER BY id`
      ).all(this.csId, def.property_id).map((r) => r.id);
    }

    if (isConcept) {
      // value(s) identify target concepts by code.
      const codes = op === 'in' ? this._splitList(value) : [value];
      const targetIds = codes.map((cd) => this._locateConceptId(cd)).filter((x) => x != null);
      if (targetIds.length === 0) return [];
      const ph = targetIds.map(() => '?').join(',');
      return this.db.prepare(
        `SELECT DISTINCT source_concept_id AS id FROM concept_link
          WHERE property_id = ? AND active = 1 AND target_concept_id IN (${ph})
          ORDER BY id`
      ).all(def.property_id, ...targetIds).map((r) => r.id);
    }

    // Literal-valued property.
    if (op === 'regex') {
      return this._literalRegexIds(def, value);
    }
    const values = op === 'in' ? this._splitList(value) : [value];
    if (values.length === 0) return [];
    const ph = values.map(() => '?').join(',');
    // Compare against value_text (typed text projection) with NOCASE, like the
    // legacy providers do for property value comparison; fall back to value_raw.
    return this.db.prepare(
      `SELECT DISTINCT source_concept_id AS id FROM concept_literal
        WHERE property_id = ? AND active = 1
          AND (value_text IN (${ph}) COLLATE NOCASE OR value_raw IN (${ph}) COLLATE NOCASE)
        ORDER BY id`
    ).all(def.property_id, ...values, ...values).map((r) => r.id);
  }

  _literalRegexIds(def, pattern) {
    const regex = regexUtilities.compile(pattern);
    const rows = this.db.prepare(
      `SELECT source_concept_id AS id, value_text, value_raw
         FROM concept_literal WHERE property_id = ? AND active = 1`
    ).all(def.property_id);
    const ids = new Set();
    for (const r of rows) {
      if (this.opContext) this.opContext.deadCheck('cs-sqlite:regex');
      const v = r.value_text != null ? r.value_text : r.value_raw;
      if (v != null && regex.test(v)) ids.add(r.id);
    }
    return [...ids].sort((a, b) => a - b);
  }

  _splitList(value) {
    return String(value).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }

  _searchIds(text) {
    const sources = this.cfg.searchSources || ['display', 'designation'];
    const ids = new Set();
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    const useFts = trimmed.length >= 3;

    const addDisplay = () => {
      if (useFts) {
        for (const r of this.db.prepare(
          `SELECT sf.rowid AS id FROM search_fts_display sf
             JOIN concept c ON c.concept_id = sf.rowid
            WHERE c.cs_id = ? AND sf.term MATCH ?`
        ).all(this.csId, this._ftsQuery(trimmed))) ids.add(r.id);
      } else {
        for (const r of this.db.prepare(
          `SELECT concept_id AS id FROM concept
            WHERE cs_id = ? AND display LIKE ? COLLATE NOCASE`
        ).all(this.csId, `%${trimmed}%`)) ids.add(r.id);
      }
    };
    const addDesignation = () => {
      if (useFts) {
        for (const r of this.db.prepare(
          `SELECT d.concept_id AS id FROM search_fts_designation sf
             JOIN designation d ON d.designation_id = sf.rowid
             JOIN concept c ON c.concept_id = d.concept_id
            WHERE c.cs_id = ? AND sf.term MATCH ?`
        ).all(this.csId, this._ftsQuery(trimmed))) ids.add(r.id);
      } else {
        for (const r of this.db.prepare(
          `SELECT d.concept_id AS id FROM designation d
             JOIN concept c ON c.concept_id = d.concept_id
            WHERE c.cs_id = ? AND d.term LIKE ? COLLATE NOCASE`
        ).all(this.csId, `%${trimmed}%`)) ids.add(r.id);
      }
    };
    const addLiteral = () => {
      if (useFts) {
        for (const r of this.db.prepare(
          `SELECT l.source_concept_id AS id FROM search_fts_literal sf
             JOIN concept_literal l ON l.literal_id = sf.rowid
             JOIN concept c ON c.concept_id = l.source_concept_id
            WHERE c.cs_id = ? AND sf.term MATCH ?`
        ).all(this.csId, this._ftsQuery(trimmed))) ids.add(r.id);
      } else {
        for (const r of this.db.prepare(
          `SELECT l.source_concept_id AS id FROM concept_literal l
             JOIN concept c ON c.concept_id = l.source_concept_id
            WHERE c.cs_id = ? AND l.value_text LIKE ? COLLATE NOCASE`
        ).all(this.csId, `%${trimmed}%`)) ids.add(r.id);
      }
    };

    if (sources.includes('display')) addDisplay();
    if (sources.includes('designation')) addDesignation();
    if (sources.includes('literal')) addLiteral();

    return [...ids].sort((a, b) => a - b);
  }

  // Wrap a trigram FTS search string as a MATCH phrase literal.
  _ftsQuery(text) {
    return '"' + text.replace(/"/g, '""') + '"';
  }

  async filterSize(filterContext, set) {
    return set.ids.length;
  }

  async filtersNotClosed() { return false; }

  async filterMore(filterContext, set) {
    set.cursor += 1;
    return set.cursor < set.ids.length;
  }

  async filterConcept(filterContext, set) {
    if (set.cursor < 0 || set.cursor >= set.ids.length) return null;
    const id = set.ids[set.cursor];
    // Batch-prefetch rows in chunks of 500 for the iterated set.
    if (!set._batch || set.cursor < set._batchStart || set.cursor >= set._batchStart + 500) {
      set._batchStart = set.cursor;
      const chunk = set.ids.slice(set.cursor, set.cursor + 500);
      const ph = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT concept_id, code, active, display, definition
           FROM concept WHERE cs_id = ? AND concept_id IN (${ph})`
      ).all(this.csId, ...chunk);
      set._batch = new Map();
      for (const r of rows) set._batch.set(r.concept_id, new SqliteConceptContext(r));
    }
    return set._batch.get(id) || null;
  }

  async filterLocate(filterContext, set, code) {
    const located = await this.locate(code);
    if (!located.context) {
      return located.message || `Not a valid code: ${code}`;
    }
    if (sortedIncludes(set.ids, located.context.conceptId)) {
      return located.context;
    }
    return `Code ${code} is not in the specified filter`;
  }

  async filterCheck(filterContext, set, concept) {
    if (!(concept instanceof SqliteConceptContext)) return false;
    return sortedIncludes(set.ids, concept.conceptId);
  }

  async filterFinish(filterContext) {
    for (const clause of filterContext.clauses || []) {
      clause.spec = null;
    }
    filterContext.clauses = [];
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

class SqliteCodeSystemFactory extends CodeSystemFactoryProvider {
  constructor(i18n, dbPath) {
    super(i18n);
    this.dbPath = dbPath;
    this._loaded = false;
    this.db = null;
  }

  async load() {
    if (this._loaded) return;

    this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma('cache_size = -64000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 268435456');

    // code_system row (one per DB by operational convention).
    this.meta = this.db.prepare(`SELECT * FROM code_system ORDER BY cs_id LIMIT 1`).get();
    if (!this.meta) {
      throw new Error(`No code_system row in ${this.dbPath}`);
    }
    this.csId = this.meta.cs_id;

    // cs_config -> parsed config object.
    this.cfg = {};
    for (const r of this.db.prepare(`SELECT key, value FROM cs_config WHERE cs_id = ?`).all(this.csId)) {
      this.cfg[r.key] = this._parseConfig(r.key, r.value);
    }

    // property_def rows -> Maps by code and by id.
    this.propByCode = new Map();
    this.propById = new Map();
    for (const p of this.db.prepare(`SELECT * FROM property_def WHERE cs_id = ?`).all(this.csId)) {
      this.propByCode.set(p.property_code, p);
      this.propById.set(p.property_id, p);
    }

    // Hierarchy metadata.
    this.hierPropIds = [...this.propById.values()].filter((p) => p.is_hierarchy).map((p) => p.property_id);
    this.hasHierarchy = this.hierPropIds.length > 0;
    this.hierPropPlaceholders = this.hierPropIds.length
      ? this.hierPropIds.map(() => '?').join(',') : '-1';
    this.hierarchyEdgeSet = this.cfg.hierarchyEdgeSet != null ? Number(this.cfg.hierarchyEdgeSet) : 1;

    this.totalCount = this.db.prepare(
      `SELECT COUNT(*) AS n FROM concept WHERE cs_id = ?`
    ).get(this.csId).n;

    // Root concept_ids (no active hierarchy parent) — cached if hierarchy exists.
    this._roots = null;
    this._allIds = null;

    // Distinct designation languages present (cheap, cached).
    this.designationLangs = this.db.prepare(
      `SELECT DISTINCT d.language_code AS lang FROM designation d
         JOIN concept c ON c.concept_id = d.concept_id
        WHERE c.cs_id = ? AND d.language_code IS NOT NULL`
    ).all(this.csId).map((r) => r.lang);

    this._loaded = true;
  }

  _parseConfig(key, value) {
    switch (key) {
      case 'caseSensitive':
        return value === '1' || value === 'true';
      case 'experimental':
        return value === '1' || value === 'true';
      case 'implicitValueSets':
      case 'filterAliases':
      case 'searchSources':
        try { return JSON.parse(value); } catch { return value; }
      default:
        return value;
    }
  }

  allConceptIds() {
    if (!this._allIds) {
      this._allIds = this.db.prepare(
        `SELECT concept_id FROM concept WHERE cs_id = ? ORDER BY code`
      ).all(this.csId).map((r) => r.concept_id);
    }
    return this._allIds;
  }

  rootConceptIds() {
    if (!this.hasHierarchy) return this.allConceptIds();
    if (!this._roots) {
      this._roots = this.db.prepare(
        `SELECT c.concept_id FROM concept c
          WHERE c.cs_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM concept_link cl
               WHERE cl.source_concept_id = c.concept_id
                 AND cl.property_id IN (${this.hierPropPlaceholders})
                 AND cl.edge_set_id = ?
                 AND cl.active = 1)
          ORDER BY c.code`
      ).all(this.csId, ...this.hierPropIds, this.hierarchyEdgeSet).map((r) => r.concept_id);
    }
    return this._roots;
  }

  async #ensureLoaded() {
    if (!this._loaded) await this.load();
  }

  async build(opContext, supplements) {
    await this.#ensureLoaded();
    this.recordUse();
    return new SqliteCodeSystemProvider(opContext, supplements, this);
  }

  // ---- factory metadata --------------------------------------------------

  system() { return this.meta.base_uri; }
  name() { return this.meta.name || this.meta.title || this.meta.base_uri; }
  version() { return this.meta.version || null; }
  defaultVersion() { return this.version(); }
  content() { return this.meta.content_mode || 'complete'; }
  iteratable() { return true; }

  id() {
    return 'sqlite:' + this.meta.base_uri + (this.version() ? '|' + this.version() : '');
  }

  describeVersion(version) {
    if (this.cfg && this.cfg.versionAlgorithm === 'date') return version;
    return 'v' + version;
  }

  webSource() {
    return (this.cfg && this.cfg.webSource) ? this.cfg.webSource : undefined;
  }

  codeLink(code) {
    const tmpl = this.cfg && this.cfg.webSource;
    if (!tmpl || !code) return undefined;
    if (tmpl.includes('{code}')) return tmpl.replace('{code}', encodeURIComponent(code));
    return tmpl;
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ---- implicit value sets ----------------------------------------------

  async buildKnownValueSet(url, version) {
    if (version && this.version() && version !== this.version()) return null;
    const patterns = this.cfg.implicitValueSets;
    if (!Array.isArray(patterns)) return null;

    for (const p of patterns) {
      const extracted = this._matchPattern(p.pattern, url);
      if (extracted == null) continue;

      if (p.kind === 'all') {
        return this._vs(url, 'All ' + this.system() + ' codes', {
          include: [{ system: this.system() }],
        });
      }
      if (p.kind === 'isa') {
        const code = extracted.code;
        if (!code) continue;
        return this._vs(url, 'Codes subsumed by ' + code, {
          include: [{ system: this.system(), filter: [{ property: 'concept', op: 'is-a', value: code }] }],
        });
      }
      if (p.kind === 'vs-table') {
        return this._buildVsTable(url, version);
      }
    }
    return null;
  }

  // Match a template pattern (with {code}/{id} placeholder) against a URL,
  // relative to the system base. Returns extracted params or {} on plain match.
  _matchPattern(pattern, url) {
    if (!pattern) return null;
    // Try the pattern both as-is and appended to the base uri.
    const candidates = [pattern, this.system() + pattern];
    for (const cand of candidates) {
      const rx = new RegExp('^' + cand
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\{code\\\}/g, '([^/]+)')
        .replace(/\\\{id\\\}/g, '([^/]+)') + '$');
      const m = url.match(rx);
      if (m) {
        return { code: m[1], id: m[1] };
      }
    }
    return null;
  }

  _buildVsTable(url, version) {
    const vs = this.db.prepare(
      `SELECT * FROM value_set WHERE cs_id = ? AND url = ?
        ORDER BY (version IS NULL) DESC LIMIT 1`
    ).get(this.csId, url);
    if (!vs) return null;
    const count = this.db.prepare(
      `SELECT COUNT(*) AS n FROM value_set_member WHERE vs_id = ?`
    ).get(vs.vs_id).n;
    const CAP = 50000;
    if (count > CAP) {
      throw new Error(`Value set ${url} has ${count} members, exceeding the enumeration cap of ${CAP}`);
    }
    const members = this.db.prepare(
      `SELECT c.code AS code, c.display AS display
         FROM value_set_member m JOIN concept c ON c.concept_id = m.concept_id
        WHERE m.vs_id = ? ORDER BY c.code`
    ).all(vs.vs_id);
    return this._vs(url, vs.name || url, {
      include: [{ system: this.system(), concept: members.map((m) => ({ code: m.code, display: m.display || undefined })) }],
    }, vs.version || version);
  }

  _vs(url, name, compose, version) {
    return {
      resourceType: 'ValueSet',
      url,
      version: version || this.version() || undefined,
      status: 'active',
      name,
      description: name,
      date: new Date().toISOString(),
      experimental: false,
      compose,
    };
  }
}

module.exports = {
  SqliteCodeSystemFactory,
  SqliteCodeSystemProvider,
  SqliteConceptContext,
};
