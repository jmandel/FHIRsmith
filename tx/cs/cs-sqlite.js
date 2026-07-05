'use strict';

// Generic sqlite-v1 CodeSystem provider.
//
// This GENERIC provider serves LOINC / RxNorm (and any tabular terminology)
// from the shared sqlite-v1 schema (tx/importers/schema-v1.sql). ALL of its
// behavior is derived from database metadata:
//   - code_system row      -> system/version/description/totalCount/contentMode
//   - cs_config key/value  -> caseSensitive/defaultLanguage/statusProperty/...
//   - property_def rows    -> propertyDefinitions, filter resolution, typing
//   - closure table        -> is-a/descendent-of/generalizes/subsumesTest
// There are NO terminology-specific code paths in this file.
//
// Anything that needs terminology-specific CODE (which cannot be expressed as
// metadata) lives in a SUBCLASS that the factory selects AT RUNTIME by matching
// the DB's code_system.base_uri against each class's static `handledSystems`
// (see the provider-class registry below). SNOMED CT post-coordinated
// expression + ECL handling is exactly such code — see cs-sqlite-snomed.js.
//
// See docs/sqlite-v1-design.md for the config-key registry, the provider-class
// selection rule, and semantics.

const assert = require('assert');
const Database = require('better-sqlite3');

const { CodeSystem, CodeSystemContentMode } = require('../library/codesystem');
const { Language } = require('../../library/languages');
const { CodeSystemFactoryProvider, FilterExecutionContext } = require('./cs-api');
const { BaseCSServices } = require('./cs-base');
const regexUtilities = require('../../library/regex-utilities');

// The provider's EXACT total for a paged expansion (or null when it chooses to
// defer for cost). Never an estimate. Whether the total is actually emitted in
// the response is a separate, limit-based decision the worker makes (see the
// limitCount gate in expand.js) — matching the reference server, which emits a
// total only when the full set fit under the effective limit.
//   - count === 0 (total-only request): the exact total is the ask.
//   - unbounded / short page (pageLen < count): the end was reached, so
//     total = offset + pageLen, exact and free.
//   - full non-active page: an exact count is cheap (index COUNT / free from the
//     materialised set).
//   - full activeOnly page: defer (null) — an exact active count is a full
//     member scan (cost), and a deferred total is never emitted anyway.
function pageTotalPolicy(count, from, pageLen, activeOnly, exactCountFn) {
  if (count === 0) return exactCountFn();
  if (count === -1 || pageLen < count) return from + pageLen;
  if (!activeOnly) return exactCountFn();
  return null;
}

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

// Sorted-id-array set algebra (all inputs/outputs ascending, deduped).
function intersectSorted(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) i++;
    else if (a[i] > b[j]) j++;
    else { out.push(a[i]); i++; j++; }
  }
  return out;
}

function diffSorted(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length) {
    if (j >= b.length || a[i] < b[j]) out.push(a[i++]);
    else if (a[i] > b[j]) j++;
    else { i++; j++; }
  }
  return out;
}

function unionSorted(arrays) {
  const nonEmpty = arrays.filter((a) => a && a.length);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return nonEmpty[0];
  const merged = [].concat(...nonEmpty).sort((x, y) => x - y);
  const out = [];
  for (const v of merged) {
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  }
  return out;
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
// Provider-class registry
// ---------------------------------------------------------------------------
//
// The generic base provider is driven ENTIRELY by database metadata (cs_config
// / property_def). A terminology that needs CODE which cannot be expressed as
// metadata (e.g. SNOMED CT post-coordinated expression + ECL handling) lives in
// a SUBCLASS. Each such subclass declares the code system URL(s) it handles via
// a static `handledSystems` array and registers itself here; the factory then
// selects the class at runtime by matching the DB's NATURAL identity
// (`code_system.base_uri`) — no class name is ever stored in the data. When no
// registered class claims a base_uri, the generic base is used.
const providerClassRegistry = [];

function registerSqliteProviderClass(ProviderClass) {
  if (!providerClassRegistry.includes(ProviderClass)) {
    providerClassRegistry.push(ProviderClass);
  }
}

// The concrete provider class for a code system base_uri: the first registered
// class whose static handledSystems includes it, else the generic base.
function providerClassForSystem(baseUri) {
  for (const ProviderClass of providerClassRegistry) {
    const handled = ProviderClass.handledSystems;
    if (Array.isArray(handled) && handled.includes(baseUri)) return ProviderClass;
  }
  return SqliteCodeSystemProvider;
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

  // A code system with a grammar (post-coordination) cannot be fully
  // enumerated, so filter/hierarchy expansions are "unclosed" — the reference
  // marks every such expansion with the valueset-unclosed extension and pages a
  // flat list. Purely metadata-driven: cs_config `notClosed` (set by importers
  // for grammar-bearing terminologies such as SNOMED CT).
  isNotClosed() { return this.cfg.notClosed === true; }
  versionAlgorithm() { return this.cfg.versionAlgorithm || null; }
  hasParents() { return this.factory.hasHierarchy; }

  // Human name for the code system when the DB provides one (cs_config
  // `name`, e.g. 'LOINC' — surfaced as $lookup's `name` output parameter);
  // otherwise the base system|version form.
  name() { return this.cfg.name || super.name(); }

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

    // cs_config locateMissMessage overrides the default miss message; the
    // empty string means "no message" (the reference LOINC provider reports a
    // bare miss, so $validate-code adds no extra information issue).
    const msg = this.cfg.locateMissMessage !== undefined
      ? (this.cfg.locateMissMessage || null)
      : `Unknown code '${code}' in the CodeSystem ${this.vurl()}`;
    return { context: null, message: msg };
  }

  async code(context) {
    const c = await this._ensure(context);
    if (!c) return null;
    return c.code;
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
    const asProps = this._designationsAsProperties();
    const rows = this.db.prepare(
      `SELECT language_code, use_code, term, preferred
         FROM designation WHERE concept_id = ? AND active = 1
        ORDER BY preferred DESC, designation_id`
    ).all(conceptId);
    for (const requested of this.opContext.langs) {
      // preferred first (rows already ordered), exact/for-display match
      for (const r of rows) {
        if (!r.language_code) continue;
        // designation rows that are really property values (cs_config
        // designationsAsProperties, e.g. LOINC RELATEDNAMES2) are not displays
        if (r.use_code && asProps.has(r.use_code)) continue;
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

  // eslint-disable-next-line no-unused-vars
  async incompleteValidationMessage(context) {
    return null;
  }

  async isInactive(context) {
    const c = await this._ensure(context);
    return c ? !c.active : false;
  }

  // The status property is "boolean" when the cs_config statusProperty IS the
  // inactiveProperty (SNOMED: both are `inactive`). Then status is not a stored
  // enum literal but the concept's active flag, and the reference emits the
  // standard status codes 'active'/'inactive' — surfacing `status` in an
  // expansion ONLY for genuinely inactive concepts (includeCode skips the
  // property when getStatus()==='active'). An enum status property (LOINC
  // STATUS) keeps returning its stored literal value.
  _isBooleanStatusProperty() {
    return !!(this.cfg.inactiveProperty && this.cfg.inactiveProperty === this.cfg.statusProperty);
  }

  async getStatus(context) {
    const prop = this.cfg.statusProperty;
    if (!prop) return null;
    const c = await this._ensure(context);
    if (!c) return null;
    if (this._isBooleanStatusProperty()) {
      return c.active ? 'active' : 'inactive';
    }
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
    // code system's default language. cs_config displayDesignation=0 turns
    // this off for systems whose stored designations are already the complete
    // reference set (SNOMED: the reference emits ONLY the RF2 descriptions,
    // and its display is one of them).
    if (c.display && this.cfg.displayDesignation !== false) {
      displays.addDesignation(true, 'active', this.defLang(), CodeSystem.makeUseForDisplay(), c.display);
    }

    // Designation rows whose use is listed in cs_config
    // designationsAsProperties (e.g. LOINC RELATEDNAMES2) are per-language
    // property values, not designations — extendLookup emits them.
    const asProps = this._designationsAsProperties();
    const uses = this.cfg.designationUses || {};
    const rows = this.db.prepare(
      `SELECT language_code, use_system, use_code, term, active, preferred
         FROM designation WHERE concept_id = ? ORDER BY designation_id`
    ).all(c.conceptId);
    for (const r of rows) {
      if (r.use_code && asProps.has(r.use_code)) continue;
      let use = null;
      if (r.use_system || r.use_code) {
        use = { system: r.use_system || undefined, code: r.use_code || undefined };
        if (r.use_code && uses[r.use_code]) {
          use.display = uses[r.use_code];
        } else if (this.cfg.designationUseDisplays === true && r.use_code && r.use_system === this.system()) {
          // The use code names a concept of this system (SNOMED description
          // type); the reference decorates the use coding with that concept's
          // lookup display.
          const d = this._lookupDisplayByCode(r.use_code);
          if (d) use.display = d;
        }
      }
      displays.addDesignation(false, r.active ? 'active' : 'inactive', r.language_code || null, use, r.term);
    }

    this._listSupplementDesignations(c.code, displays);
  }

  _designationsAsProperties() {
    if (!this._asPropsCache) {
      this._asPropsCache = new Set(Array.isArray(this.cfg.designationsAsProperties)
        ? this.cfg.designationsAsProperties : []);
    }
    return this._asPropsCache;
  }

  /**
   * $lookup property emission, all metadata-driven:
   *   - hierarchy concept_link rows -> the standard concept-properties
   *     `parent` (outbound) and `child` (inbound; only derived when the DB has
   *     no explicit `child` property_def — LOINC stores child edges itself);
   *   - non-hierarchy concept_link rows -> code properties (target concept's
   *     code), optionally decorated (`description`/`code-display`) and
   *     deduplicated per the cs_config keys below;
   *   - concept_literal rows (for literal-kind property defs) -> typed values,
   *     with a `description` part from cs_config propertyValueDescriptions,
   *     renamed/suppressed/described per cs_config lookupPropertyOverrides;
   *   - designationsAsProperties rows -> language-tagged string properties.
   * Property codes requested via `props` are honored (_hasProp semantics).
   *
   * cs_config keys (all default off = pre-existing behavior):
   *   - lookupLinkDescriptions=1: parent/child/attribute properties carry a
   *     `description` (target's lookup display) and non-hierarchy ones a
   *     `code-display` (the attribute concept's lookup display) — the
   *     reference SNOMED shape.
   *   - lookupLinkDistinct=1: non-hierarchy links emit DISTINCT
   *     (attribute, target) pairs over ALL rows, historical/inactive
   *     relationships included (reference SNOMED lists every relationship
   *     target ever asserted, once). Default: active rows only, duplicates
   *     preserved (reference LOINC emits duplicate relationship rows).
   *   - lookupPropertyOverrides={code: false | {as, descriptionFromConcept}}:
   *     literal suppression/rename (SNOMED moduleId -> module + display,
   *     definitionStatusId hidden from $lookup).
   */
  async extendLookup(ctxt, props, params) {
    const c = await this._ensure(ctxt);
    if (!c) return;
    this._extendLookupConcept(c.conceptId, props, params);
  }

  _extendLookupConcept(conceptId, props, params) {
    const withDescriptions = this.cfg.lookupLinkDescriptions === true;

    // Hierarchy edges surface under FHIR's standard property codes. For DBs
    // whose hierarchy property is already named `parent` (LOINC) this is a
    // no-op rename; for SNOMED it maps the raw is-a code (116680003).
    if (this.hasParents()) {
      if (this._hasProp(props, 'parent', true)) {
        const parents = this.db.prepare(
          `SELECT tc.code AS code, tc.concept_id AS cid
             FROM concept_link cl
             JOIN concept tc ON tc.concept_id = cl.target_concept_id
            WHERE cl.source_concept_id = ?
              AND cl.property_id IN (${this.factory.hierPropPlaceholders})
              AND cl.edge_set_id = ? AND cl.active = 1
            ORDER BY tc.code`
        ).all(conceptId, ...this.factory.hierPropIds, this.factory.hierarchyEdgeSet);
        for (const p of parents) {
          this._addCodeProperty(params, 'property', 'parent', p.code, null,
            withDescriptions ? this._lookupDisplay(p.cid) : null);
        }
      }
      // Inbound hierarchy edges are the concept's children.
      if (!this.propByCode.has('child') && this._hasProp(props, 'child', true)) {
        const children = this.db.prepare(
          `SELECT sc.code AS code, sc.concept_id AS cid
             FROM concept_link cl
             JOIN concept sc ON sc.concept_id = cl.source_concept_id
            WHERE cl.target_concept_id = ?
              AND cl.property_id IN (${this.factory.hierPropPlaceholders})
              AND cl.edge_set_id = ? AND cl.active = 1
            ORDER BY sc.code`
        ).all(conceptId, ...this.factory.hierPropIds, this.factory.hierarchyEdgeSet);
        for (const ch of children) {
          this._addCodeProperty(params, 'property', 'child', ch.code, null,
            withDescriptions ? this._lookupDisplay(ch.cid) : null);
        }
      }
    }

    // Non-hierarchy concept-valued properties (see cs_config notes above).
    const distinct = this.cfg.lookupLinkDistinct === true;
    const links = this.db.prepare(
      `SELECT pd.property_code AS code, tc.code AS target_code, tc.concept_id AS target_id
         FROM concept_link cl
         JOIN property_def pd ON pd.property_id = cl.property_id
         JOIN concept tc ON tc.concept_id = cl.target_concept_id
        WHERE cl.source_concept_id = ? AND pd.is_hierarchy = 0${distinct ? '' : ' AND cl.active = 1'}
        ORDER BY ${distinct ? 'pd.property_code, tc.code' : 'cl.edge_id'}`
    ).all(conceptId);
    const seen = distinct ? new Set() : null;
    for (const l of links) {
      if (!this._hasProp(props, l.code, true)) continue;
      if (seen) {
        const key = l.code + '|' + l.target_code;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const p = this._addCodeProperty(params, 'property', l.code, l.target_code, null,
        withDescriptions ? this._lookupDisplay(l.target_id) : null);
      if (withDescriptions) {
        const cd = this._propCodeDisplay(l.code);
        if (cd) p.part.push({ name: 'code-display', valueString: cd });
      }
    }

    this._extendLookupLiterals(conceptId, props, params);
    this._extendLookupDesignationProps(conceptId, props, params);
  }

  _extendLookupLiterals(conceptId, props, params) {
    const descriptions = this.cfg.propertyValueDescriptions || {};
    const overrides = this.cfg.lookupPropertyOverrides || {};
    const lits = this.db.prepare(
      `SELECT pd.property_code AS code, pd.fhir_type AS fhir_type, pd.value_kind AS value_kind,
              cl.value_raw, cl.value_text, cl.value_num, cl.value_bool
         FROM concept_literal cl
         JOIN property_def pd ON pd.property_id = cl.property_id
        WHERE cl.source_concept_id = ? AND cl.active = 1
        ORDER BY cl.literal_id`
    ).all(conceptId);
    for (const l of lits) {
      // Literal rows under a concept-kind def are filter-only duplicates of a
      // link (e.g. the textual part name); the link emission above covers them.
      if (l.value_kind !== 'literal') continue;
      // The worker itself emits the standard `inactive` property (from
      // isInactive()); re-emitting the stored inactive literal would duplicate it.
      if (this.cfg.inactiveProperty && l.code === this.cfg.inactiveProperty) continue;
      const ov = overrides[l.code];
      if (ov === false) continue;
      const emitAs = (ov && ov.as) || l.code;
      if (!this._hasProp(props, emitAs, true)) continue;
      const typed = this._literalToProperty(l);
      const part = [{ name: 'code', valueCode: emitAs }];
      const rawValue = l.value_text != null ? l.value_text : l.value_raw;
      const meanings = descriptions[l.code];
      let desc = (meanings && rawValue != null && meanings[rawValue]) ? meanings[rawValue] : null;
      if (!desc && ov && ov.descriptionFromConcept && rawValue != null) {
        // The literal's value names a concept of this system (SNOMED
        // moduleId); describe it with that concept's lookup display.
        desc = this._lookupDisplayByCode(rawValue);
      }
      if (desc) part.push({ name: 'description', valueString: desc });
      for (const [k, v] of Object.entries(typed)) {
        if (k !== 'code') part.push({ name: 'value', [k]: v });
      }
      params.push({ name: 'property', part });
    }
  }

  _extendLookupDesignationProps(conceptId, props, params) {
    for (const useCode of this._designationsAsProperties()) {
      if (!this._hasProp(props, useCode, true)) continue;
      const rows = this.db.prepare(
        `SELECT language_code, term FROM designation
          WHERE concept_id = ? AND active = 1 AND use_code = ?
          ORDER BY designation_id`
      ).all(conceptId, useCode);
      for (const r of rows) {
        this._addProperty(params, 'property', useCode, r.term, r.language_code || null);
      }
    }
  }

  // The reference binary's getDisplayName(): the FIRST ACTIVE stored
  // designation in source order (designation_id preserves RF2 description-id
  // order), falling back to the denormalized display. Lookup property
  // descriptions use this rule — which is why they can surface an FSN even
  // though the concept display is the preferred synonym.
  _lookupDisplay(conceptId) {
    const row = this.db.prepare(
      `SELECT term FROM designation WHERE concept_id = ? AND active = 1
        ORDER BY designation_id LIMIT 1`
    ).get(conceptId);
    if (row && row.term) return row.term.trim();
    const c = this.db.prepare(`SELECT display FROM concept WHERE concept_id = ?`).get(conceptId);
    return c ? c.display : null;
  }

  _lookupDisplayByCode(code) {
    const row = this.db.prepare(
      `SELECT concept_id FROM concept WHERE cs_id = ? AND code = ?`
    ).get(this.csId, code);
    return row ? this._lookupDisplay(row.concept_id) : null;
  }

  // code-display for a concept-valued property: the property_def's own display
  // when the importer recorded one, else the display of the concept the
  // property code names (SNOMED attribute concepts). Cached per provider.
  _propCodeDisplay(code) {
    if (!this._propDisplayCache) this._propDisplayCache = new Map();
    if (!this._propDisplayCache.has(code)) {
      const pd = this.propByCode.get(code);
      this._propDisplayCache.set(code, (pd && pd.display) || this._lookupDisplayByCode(code));
    }
    return this._propDisplayCache.get(code);
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
      case 'dateTime': {
        // Compact yyyymmdd source dates (SNOMED RF2 effectiveTime) are not
        // valid FHIR dateTime values; normalize to yyyy-mm-dd on the way out.
        const raw = l.value_text != null ? l.value_text : l.value_raw;
        p.valueDateTime = (typeof raw === 'string' && /^\d{8}$/.test(raw))
          ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
        break;
      }
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

  // cs_config isAIncludesSelf=0: the is-a filter yields strict descendants
  // (the reference LOINC behavior); default is FHIR's is-a (self included).
  _isAIncludesSelf() {
    return this.cfg.isAIncludesSelf !== false;
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
    if (!disallowParent && cId === pId && this._isAIncludesSelf()) {
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
        ORDER BY sc.concept_id`
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

  // A filter on the boolean status property (SNOMED `inactive = true|false`)
  // must map to concept.active, NOT a stored literal: active concepts carry no
  // `inactive=false` row, so a literal match would yield the empty set (the
  // reference resolves `inactive=false` to the active concepts). Returns the
  // wanted active flag (true/false) or null when this is not that filter.
  _statusFilterActive(prop, op, value) {
    if (op !== '=' || !this._isBooleanStatusProperty()) return null;
    const { name } = this._resolveProp(prop);
    if (name !== this.cfg.inactiveProperty) return null;
    const v = String(value).trim().toLowerCase();
    return !(v === 'true' || v === '1');
  }

  // Concept ids by active flag (sorted), for the boolean status filter.
  _statusActiveIds(wantActive) {
    return this.db.prepare(
      `SELECT concept_id AS id FROM concept
        WHERE cs_id = ? AND active = ? ORDER BY id`
    ).all(this.csId, wantActive ? 1 : 0).map((r) => r.id);
  }

  // Rewrite legacy filter value forms per cs_config filterValueRewrites
  // (array of {pattern, replace}, first match wins) — e.g. RxNorm clients
  // send "CUI:854979" where the stored target code is "854979".
  _rewriteFilterValue(value) {
    const rules = this.cfg.filterValueRewrites;
    if (!Array.isArray(rules) || typeof value !== 'string') return value;
    for (const rule of rules) {
      if (!rule || typeof rule.pattern !== 'string') continue;
      const rx = new RegExp(rule.pattern);
      if (rx.test(value)) return value.replace(rx, rule.replace ?? '');
    }
    return value;
  }

  // Config-declared filter families beyond plain property matching:
  //   membershipFilters[prop] = { member } — collection membership (LOINC
  //     LIST / answers-for): the value resolves to collection concepts and the
  //     result is the targets of their `member` links.
  //   existsFilters[prop] = { property, values: {v: bool} } — enumerated value
  //     mapping onto (not-)exists of another property (LOINC copyright).
  _membershipFilterSpec(prop, op) {
    if (!['=', 'in'].includes(op)) return null;
    const mf = this.cfg.membershipFilters;
    return (mf && typeof mf === 'object' && mf[prop]) ? mf[prop] : null;
  }

  _existsFilterSpec(prop, op, value) {
    if (op !== '=') return null;
    const ef = this.cfg.existsFilters;
    const spec = (ef && typeof ef === 'object') ? ef[prop] : null;
    if (!spec || !spec.values || !(value in spec.values)) return null;
    const def = this.propByCode.get(spec.property);
    return def ? { def, want: !!spec.values[value] } : null;
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
    // Intrinsic value-set membership (e.g. SNOMED refsets): concept in <id>.
    if (op === 'in' && (prop === 'concept' || prop === 'code')) {
      return this.factory.hasValueSets;
    }
    // Config-declared filter families.
    if (this._membershipFilterSpec(prop, op)) return true;
    if (this._existsFilterSpec(prop, op, value)) return true;
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
    value = this._rewriteFilterValue(value);
    // Boolean status property (SNOMED `inactive = true|false`) -> concept.active.
    const wantActive = this._statusFilterActive(prop, op, value);
    if (wantActive !== null) {
      filterContext.clauses.push(new FilterClause('active', { active: wantActive }));
      return;
    }
    // Hierarchy ops.
    if (['is-a', 'descendent-of', 'child-of', 'generalizes'].includes(op)) {
      if (!this.hasParents()) {
        throw new Error(`The filter "${prop} ${op} ${value}" is not supported for ${this.system()} (no hierarchy)`);
      }
      filterContext.clauses.push(new FilterClause('hierarchy', { op, value }));
      return;
    }

    // Intrinsic value-set membership (e.g. SNOMED refsets): concept in <id>.
    if (op === 'in' && (prop === 'concept' || prop === 'code') && this.factory.hasValueSets) {
      filterContext.clauses.push(new FilterClause('vs-member', { value }));
      return;
    }

    // Config-declared filter families (see doesFilter).
    const membership = this._membershipFilterSpec(prop, op);
    if (membership) {
      filterContext.clauses.push(new FilterClause('membership', { prop, spec: membership, op, value }));
      return;
    }
    const existsMap = this._existsFilterSpec(prop, op, value);
    if (existsMap) {
      filterContext.clauses.push(new FilterClause('property', {
        name: existsMap.def.property_code, def: existsMap.def, op: 'exists', value: String(existsMap.want)
      }));
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
    if (clause.kind === 'active') return this._statusActiveIds(clause.spec.active);
    if (clause.kind === 'hierarchy') return this._hierarchyIds(clause.spec.op, clause.spec.value);
    if (clause.kind === 'property') return this._propertyIds(clause.spec);
    if (clause.kind === 'search') return this._searchIds(clause.spec.text);
    if (clause.kind === 'vs-member') return this._valueSetMemberIds(clause.spec.value);
    if (clause.kind === 'membership') {
      return this._membershipIds(clause.spec.prop, clause.spec.spec, clause.spec.op, clause.spec.value);
    }
    return [];
  }

  // Collection-membership filter (cs_config membershipFilters): resolve the
  // value(s) to collection concepts — the value itself when it has outgoing
  // `member` links, plus the sources of <prop> links targeting the value —
  // then return the targets of the collections' `member` links.
  _membershipIds(prop, spec, op, value) {
    const memberDef = this.propByCode.get(spec.member);
    if (!memberDef) return [];
    const values = op === 'in' ? this._splitList(value) : [value];
    const collections = new Set();
    const propDef = this.propByCode.get(prop) || null;
    for (const v of values) {
      const id = this._locateConceptId(v);
      if (id == null) continue;
      const hasMembers = this.db.prepare(
        `SELECT 1 FROM concept_link WHERE source_concept_id = ? AND property_id = ? AND active = 1 LIMIT 1`
      ).get(id, memberDef.property_id);
      if (hasMembers) collections.add(id);
      if (propDef) {
        for (const r of this.db.prepare(
          `SELECT DISTINCT source_concept_id AS id FROM concept_link
            WHERE property_id = ? AND active = 1 AND target_concept_id = ?`
        ).all(propDef.property_id, id)) collections.add(r.id);
      }
    }
    if (collections.size === 0) return [];
    const ph = [...collections].map(() => '?').join(',');
    return this.db.prepare(
      `SELECT DISTINCT target_concept_id AS id FROM concept_link
        WHERE property_id = ? AND active = 1 AND source_concept_id IN (${ph})
        ORDER BY id`
    ).all(memberDef.property_id, ...collections).map((r) => r.id);
  }

  // Members of an intrinsic value set (e.g. a SNOMED refset), identified by
  // full URL or by the bare id via the vs-table implicitValueSets patterns.
  _valueSetMemberIds(value) {
    const urls = [String(value)];
    const patterns = Array.isArray(this.cfg.implicitValueSets) ? this.cfg.implicitValueSets : [];
    for (const p of patterns) {
      if (p.kind !== 'vs-table' || !p.pattern) continue;
      const filled = p.pattern.replace('{id}', String(value)).replace('{code}', String(value));
      urls.push(filled, this.system() + filled);
    }
    const vsStmt = this.db.prepare(`SELECT vs_id FROM value_set WHERE cs_id = ? AND url = ?`);
    for (const url of urls) {
      const row = vsStmt.get(this.csId, url);
      if (row) {
        return this.db.prepare(
          `SELECT concept_id AS id FROM value_set_member
            WHERE vs_id = ? AND active = 1 ORDER BY id`
        ).all(row.vs_id).map((r) => r.id);
      }
    }
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
      if (this._isAIncludesSelf()) {
        // descendants ∪ self
        sql = `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ?
               UNION SELECT ? AS id ORDER BY id`;
        args = [id, id];
      } else {
        sql = `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ? ORDER BY id`;
        args = [id];
      }
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
      if (op === 'regex') {
        // Regex on a concept-valued property matches the TARGET concept's
        // display (the legacy providers regex over the part names), unioned
        // with any filter-only literal duplicates stored under the same
        // property (e.g. the LOINC CLASS column text).
        return unionSorted([this._conceptRegexIds(def, value), this._literalRegexIds(def, value)]);
      }
      // value(s) identify target concepts by code — and, when cs_config
      // conceptFilterMatch = 'code-or-display', also by case-insensitive
      // display/name. The legacy LOINC provider matches relationship filter
      // values against the target Part's name (SCALE_TYP=Qn etc., value case
      // varies in published ValueSets), and dual-stored literal rows under the
      // same property participate too.
      const codes = op === 'in' ? this._splitList(value) : [value];
      let targetIds = codes.map((cd) => this._locateConceptId(cd)).filter((x) => x != null);
      if (this.cfg.conceptFilterMatch === 'code-or-display') {
        const byName = this.db.prepare(
          `SELECT concept_id FROM concept WHERE cs_id = ? AND display = ? COLLATE NOCASE`
        );
        for (const cd of codes) {
          for (const row of byName.all(this.csId, cd)) targetIds.push(row.concept_id);
        }
        targetIds = [...new Set(targetIds)];
      }
      let linkIds = [];
      if (targetIds.length > 0) {
        const ph = targetIds.map(() => '?').join(',');
        linkIds = this.db.prepare(
          `SELECT DISTINCT source_concept_id AS id FROM concept_link
            WHERE property_id = ? AND active = 1 AND target_concept_id IN (${ph})
            ORDER BY id`
        ).all(def.property_id, ...targetIds).map((r) => r.id);
      }
      return unionSorted([linkIds, this._literalValueIds(def, codes)]);
    }

    // Literal-valued property.
    if (op === 'regex') {
      return this._literalRegexIds(def, value);
    }
    let values = op === 'in' ? this._splitList(value) : [value];
    if (values.length === 0) return [];
    // cs_config propertyValueDescriptions maps stored values to their coded
    // meanings (LOINC CLASSTYPE '1' <-> 'Laboratory class'); accept either
    // form as the filter value, like the reference server.
    const meanings = (this.cfg.propertyValueDescriptions || {})[def.property_code];
    if (meanings) {
      const extra = [];
      for (const v of values) {
        if (meanings[v]) extra.push(meanings[v]);
        for (const [stored, meaning] of Object.entries(meanings)) {
          if (String(meaning).toLowerCase() === String(v).toLowerCase()) extra.push(stored);
        }
      }
      values = [...new Set([...values, ...extra])];
    }
    const ph = values.map(() => '?').join(',');
    // A value can live in value_text (typed text projection for code/string
    // types) or value_raw (lexical form, incl. numeric/boolean types), matched
    // case-insensitively like the legacy providers. Splitting into a UNION of
    // two `COLLATE NOCASE IN` seeks lets each arm use its dedicated NOCASE
    // index (idx_concept_literal_prop_active_{text,raw}_nocase); the earlier
    // single `text OR raw` predicate defeated both and scanned the whole
    // property partition. UNION dedups, so no separate DISTINCT is needed.
    // (A type-directed single-column seek was measured — marginal, and it makes
    // correctness depend on fhir_type; the robust two-arm UNION is kept.)
    return this.db.prepare(
      `SELECT source_concept_id AS id FROM concept_literal
        WHERE property_id = ? AND active = 1 AND value_text COLLATE NOCASE IN (${ph})
       UNION
       SELECT source_concept_id AS id FROM concept_literal
        WHERE property_id = ? AND active = 1 AND value_raw COLLATE NOCASE IN (${ph})
       ORDER BY id`
    ).all(def.property_id, ...values, def.property_id, ...values).map((r) => r.id);
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

  // Sources of links under `def` whose TARGET's display matches the regex.
  _conceptRegexIds(def, pattern) {
    const regex = regexUtilities.compile(pattern);
    const targets = this.db.prepare(
      `SELECT DISTINCT tc.concept_id AS id, tc.display AS display
         FROM concept_link cl JOIN concept tc ON tc.concept_id = cl.target_concept_id
        WHERE cl.property_id = ? AND cl.active = 1`
    ).all(def.property_id);
    const hit = [];
    for (const t of targets) {
      if (this.opContext) this.opContext.deadCheck('cs-sqlite:concept-regex');
      if (t.display != null && regex.test(t.display)) hit.push(t.id);
    }
    if (hit.length === 0) return [];
    const ph = hit.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT DISTINCT source_concept_id AS id FROM concept_link
        WHERE property_id = ? AND active = 1 AND target_concept_id IN (${ph})
        ORDER BY id`
    ).all(def.property_id, ...hit).map((r) => r.id);
  }

  // Case-insensitive exact matches over any literal rows stored under `def`
  // (dual-stored filter text for concept-valued properties).
  _literalValueIds(def, values) {
    if (!values || values.length === 0) return [];
    const ph = values.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT source_concept_id AS id FROM concept_literal
        WHERE property_id = ? AND active = 1 AND value_text COLLATE NOCASE IN (${ph})
       UNION
       SELECT source_concept_id AS id FROM concept_literal
        WHERE property_id = ? AND active = 1 AND value_raw COLLATE NOCASE IN (${ph})
        ORDER BY id`
    ).all(def.property_id, ...values, def.property_id, ...values).map((r) => r.id);
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

  // A closed (fully enumerable) code system yields bounded filter sets. A
  // grammar-bearing one (cs_config `notClosed`) is unclosed; a subclass that
  // composes expressions may narrow this per-filter (see the SNOMED subclass).
  // eslint-disable-next-line no-unused-vars
  async filtersNotClosed(filterContext) {
    return this.isNotClosed();
  }

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
    // cs_config filterLocateMiss='silent': report a bare miss (null) instead
    // of a message string — the reference LOINC provider adds no
    // "not in the specified filter" text to $validate-code messages.
    const silent = this.cfg.filterLocateMiss === 'silent';
    const located = await this.locate(code);
    if (!located.context) {
      return silent ? null : (located.message || `Not a valid code: ${code}`);
    }
    if (sortedIncludes(set.ids, located.context.conceptId)) {
      return located.context;
    }
    return silent ? null : `Code ${code} is not in the specified filter`;
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

  // ---- provider-driven bulk selection (cs-api handlesSelecting seam) -------

  handlesSelecting() {
    return true;
  }

  /**
   * Evaluate whole includes/excludes as set algebra over sorted concept_id
   * arrays, with offset/count pushdown. Returns one FilterConceptSet whose
   * `ids` are the requested page (source order) and whose `totalCount` is the
   * exact pre-page total. Enumerated-concept INCLUDES are routed to the
   * legacy path by the worker (listing order is semantic); enumerated
   * excludes are fine (set semantics).
   */
  async processSelection(params, includes, excludes, excludeInactive, offset, count) {
    const activeOnly = excludeInactive || !!(params && params.activeOnly);

    // Fast path: a single filter-only include with no excludes is a fast-source
    // subtree. Page it with early-stop + the shared lazy-total policy, the same
    // way the IR engine's executeIR does — so pushdown and IR return identical
    // pages and totals for this (very common) shape instead of pushdown
    // materialising the whole set.
    const only = includes.length === 1 ? includes[0] : null;
    if (only && (!excludes || excludes.length === 0) &&
        !(only.concept && only.concept.length) && (only.filter && only.filter.length)) {
      const sub = { kind: 'selector', shape: 'filter',
        filterClauses: only.filter.map((f) => ({ property: f.property, op: f.op, value: f.value })) };
      const fast = this._tryFastPage(sub, { offset, count }, activeOnly);
      if (fast) {
        const set = new SqliteFilterSet(fast.rows.map((r) => r.id));
        set.totalCount = fast.total;   // exact, or null when deferred (FHIR-optional)
        return [set];
      }
    }

    let ids = this._selectionUnion(includes);
    if (excludes && excludes.length) {
      const ex = new Set(this._selectionUnion(excludes));
      ids = ids.filter((id) => !ex.has(id));
    }
    if (activeOnly) {
      const act = this._activeIdSet();
      ids = ids.filter((id) => act.has(id));
    }
    const from = offset > 0 ? offset : 0;
    const page = count > -1 ? ids.slice(from, from + count) : (from > 0 ? ids.slice(from) : ids);
    const set = new SqliteFilterSet(page);
    // Same total policy as the fast path: exact when complete/requested, else
    // omitted (the full set is materialised here, so the exact count is free).
    set.totalCount = pageTotalPolicy(count, from, page.length, activeOnly, () => ids.length);
    return [set];
  }

  // Include-order concatenation, deduped on first occurrence: legacy emits
  // multi-include composes include-by-include, and page composition under
  // the default sort is tier-1.5 in the ordering contract. Within one
  // include the ids are source-ordered. NOTE: the result is NOT globally
  // sorted when there are multiple includes — do not binary-search it.
  _selectionUnion(csets) {
    if (!csets || csets.length === 0) return [];
    if (csets.length === 1) return this._selectionIds(csets[0]);
    const seen = new Set();
    const out = [];
    for (const cset of csets) {
      for (const id of this._selectionIds(cset)) {
        if (!seen.has(id)) { seen.add(id); out.push(id); }
      }
    }
    return out;
  }

  _selectionIds(cset) {
    if (cset.concept && cset.concept.length) {
      const ids = [];
      for (const cc of cset.concept) {
        const id = this._locateConceptId(cc.code);
        if (id != null) ids.push(id);
      }
      return unionSorted([ids.sort((a, b) => a - b)]);
    }
    if (cset.filter && cset.filter.length) {
      let ids = null;
      for (const fc of cset.filter) {
        const clauseIds = this._idsForFilter(fc.property, fc.op, fc.value);
        ids = ids == null ? clauseIds : intersectSorted(ids, clauseIds);
        if (ids.length === 0) break;
      }
      return ids || [];
    }
    return this.factory.allConceptIds();
  }

  // One filter triple -> sorted concept_ids; same routing as filter(), no prep.
  _idsForFilter(prop, op, value) {
    value = this._rewriteFilterValue(value);
    const wantActive = this._statusFilterActive(prop, op, value);
    if (wantActive !== null) return this._statusActiveIds(wantActive);
    if (['is-a', 'descendent-of', 'child-of', 'generalizes'].includes(op)) {
      if (!this.hasParents()) {
        throw new Error(`The filter "${prop} ${op} ${value}" is not supported for ${this.system()} (no hierarchy)`);
      }
      return this._hierarchyIds(op, value);
    }
    if (op === 'in' && (prop === 'concept' || prop === 'code') && this.factory.hasValueSets) {
      return this._valueSetMemberIds(value);
    }
    const membership = this._membershipFilterSpec(prop, op);
    if (membership) {
      return this._membershipIds(prop, membership, op, value);
    }
    const existsMap = this._existsFilterSpec(prop, op, value);
    if (existsMap) {
      return this._propertyIds({
        name: existsMap.def.property_code, def: existsMap.def, op: 'exists', value: String(existsMap.want)
      });
    }
    const { name, def } = this._resolveProp(prop);
    if (!def || !['=', 'in', 'exists', 'regex'].includes(op)) {
      throw new Error(`The filter "${prop} ${op} ${value}" is not supported for ${this.system()}`);
    }
    return this._propertyIds({ name, def, op, value });
  }

  _activeIdSet() {
    if (!this.factory._activeIdSetCache) {
      this.factory._activeIdSetCache = new Set(this.db.prepare(
        `SELECT concept_id AS id FROM concept WHERE cs_id = ? AND active = 1`
      ).all(this.csId).map((r) => r.id));
    }
    return this.factory._activeIdSetCache;
  }

  // ---- native IR terminals (tx/engine orchestrator seam) ------------------
  //
  // The orchestrator scopes an IR subtree to ONE (system, version) before
  // calling these. Nodes seen here: selector | union | intersect | diff |
  // empty. Import nodes are resolved away by the orchestrator. Every node
  // lowers to a sorted concept_id array via the same primitives the filter
  // protocol and processSelection use, so IR / legacy / pushdown share one
  // membership definition.

  hasExecuteIR() {
    return true;
  }

  // Evaluate an IR subtree to a sorted, deduped concept_id array.
  _evalIR(node) {
    if (!node || node.kind === 'empty') return [];
    switch (node.kind) {
      case 'selector':
        return this._selectorIds(node);
      case 'union':
        return unionSorted((node.items || []).map((it) => this._evalIR(it)));
      case 'intersect': {
        const parts = (node.items || []).map((it) => this._evalIR(it));
        if (parts.length === 0) return [];
        parts.sort((a, b) => a.length - b.length); // smallest first
        let acc = parts[0];
        for (let i = 1; i < parts.length && acc.length; i++) acc = intersectSorted(acc, parts[i]);
        return acc;
      }
      case 'diff':
        return diffSorted(this._evalIR(node.left), this._evalIR(node.right));
      default:
        throw new Error(`cs-sqlite IR: unsupported node kind '${node.kind}'`);
    }
  }

  // One IR selector -> sorted concept_id array.
  _selectorIds(sel) {
    let ids;
    if (sel.shape === 'concept') {
      const arr = [];
      for (const cc of sel.conceptCodes || []) {
        const id = this._locateConceptId(cc.code);
        if (id != null) arr.push(id);
      }
      ids = unionSorted([arr.sort((a, b) => a - b)]);
    } else if (sel.shape === 'filter') {
      ids = null;
      for (const fc of sel.filterClauses || []) {
        const clauseIds = this._idsForFilter(fc.property, fc.op, fc.value);
        ids = ids == null ? clauseIds : intersectSorted(ids, clauseIds);
        if (ids.length === 0) break;
      }
      ids = ids || [];
    } else {
      // whole code system
      ids = this.factory.allConceptIds();
    }
    // Codes pushed into the selector by rewrite coalescing (intersectCodes).
    if (Array.isArray(sel.intersectCodes) && sel.intersectCodes.length) {
      const codeIds = [];
      for (const code of sel.intersectCodes) {
        const id = this._locateConceptId(code);
        if (id != null) codeIds.push(id);
      }
      ids = intersectSorted(ids, unionSorted([codeIds.sort((a, b) => a - b)]));
    }
    return ids;
  }

  // Page terminal: { candidates: [...], total } for a scoped subtree.
  async executeIR(subtree, opts = {}) {
    const activeOnly = !!opts.activeOnly;
    // Fast path: single hierarchy/value-set selector in one SQL statement.
    // Under activeOnly the exact total needs the concept join either way, and
    // measuring across sizes, SQL COUNT over the active-join (~17ms at 94k)
    // beats materialising every id into JS and filtering through the active-id
    // set (~39ms) — so we keep the fast path for activeOnly too.
    const fast = this._tryFastPage(subtree, opts, activeOnly);
    let candidates, total;
    if (fast) {
      total = fast.total;
      candidates = fast.rows.map((r) => ({ code: r.code, display: r.display || undefined, active: r.active !== 0 }));
    } else {
      let ids = this._evalIR(subtree);
      if (activeOnly) {
        const act = this._activeIdSet();
        ids = ids.filter((id) => act.has(id));
      }
      const from = opts.offset > 0 ? opts.offset : 0;
      const count = opts.count != null && opts.count > -1 ? opts.count : -1;
      const page = count > -1 ? ids.slice(from, from + count) : (from > 0 ? ids.slice(from) : ids);
      total = pageTotalPolicy(count, from, page.length, activeOnly, () => ids.length);
      candidates = page.map((id) => this._candidateFromId(id));
    }
    return { candidates, total, unclosed: null };
  }

  async countForIR(subtree, opts = {}) {
    const c = this._tryFastCount(subtree, !!opts.activeOnly);
    if (c != null) return c;
    let ids = this._evalIR(subtree);
    if (opts.activeOnly) {
      const act = this._activeIdSet();
      ids = ids.filter((id) => act.has(id));
    }
    return ids.length;
  }

  async membershipForIR(subtree, opts = {}) {
    let ids = this._evalIR(subtree);
    if (opts && opts.activeOnly) {
      const act = this._activeIdSet();
      ids = ids.filter((id) => act.has(id));
    }
    const set = new Set(ids);
    const self = this;
    return {
      has(code) {
        const id = self._locateConceptId(code);
        return id != null && set.has(id);
      },
    };
  }

  _candidateFromId(id) {
    const row = this._rowById(id);
    if (!row) return { code: String(id), active: true };
    return { code: row.code, display: row.display || undefined, active: row.active !== 0 };
  }

  // Returns a single sorted-id SQL source (sub-SELECT + params) for a lone
  // selector with exactly one supported clause, else null. Used only to add
  // ORDER BY concept_id LIMIT/OFFSET at the SQL layer.
  _fastSource(subtree) {
    if (!subtree || subtree.kind !== 'selector') return null;
    if (Array.isArray(subtree.intersectCodes) && subtree.intersectCodes.length) return null;
    if (subtree.shape !== 'filter' || (subtree.filterClauses || []).length !== 1) return null;
    const fc = subtree.filterClauses[0];
    const op = fc.op;
    const value = this._rewriteFilterValue(fc.value);
    if (['is-a', 'descendent-of', 'generalizes'].includes(op) && (fc.property === 'concept' || fc.property === 'code')) {
      const seed = this._locateConceptId(value);
      if (seed == null) return { sql: `SELECT 0 AS id WHERE 0`, args: [] };
      if (op === 'descendent-of') {
        return { sql: `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ?`, args: [seed] };
      }
      // UNION ALL (not UNION): the closure stores no self-rows, so the seed is
      // never among its own descendants/ancestors — no dedup needed, which
      // avoids materialising the whole set into a dedup temp b-tree.
      if (op === 'is-a') {
        if (!this._isAIncludesSelf()) {
          return { sql: `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ?`, args: [seed] };
        }
        return { sql: `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ? UNION ALL SELECT ? AS id`, args: [seed, seed] };
      }
      return { sql: `SELECT ancestor_id AS id FROM closure WHERE descendant_id = ? UNION ALL SELECT ? AS id`, args: [seed, seed] };
    }
    if (op === 'in' && (fc.property === 'concept' || fc.property === 'code') && this.factory.hasValueSets) {
      const vsId = this._valueSetIdFor(value);
      if (vsId == null) return { sql: `SELECT 0 AS id WHERE 0`, args: [] };
      return { sql: `SELECT concept_id AS id FROM value_set_member WHERE vs_id = ? AND active = 1`, args: [vsId] };
    }
    return null;
  }

  // Page a fast-source subtree. Returns { rows: [{id, code, display, active}],
  // total } where `total` follows the lazy policy of `_pageTotal` — an exact
  // count or null (never an estimate). Shared by executeIR (IR engine) and
  // processSelection (pushdown), so both agree on page and total by
  // construction.
  _tryFastPage(subtree, opts, activeOnly = false) {
    const src = this._fastSource(subtree);
    if (!src) return null;
    const from = opts.offset > 0 ? opts.offset : 0;
    const count = opts.count != null && opts.count > -1 ? opts.count : -1;
    const limitClause = count > -1 ? 'LIMIT ? OFFSET ?' : (from > 0 ? 'LIMIT -1 OFFSET ?' : '');
    const limitArgs = count > -1 ? [count, from] : (from > 0 ? [from] : []);
    let rows;
    if (activeOnly) {
      // Active filter is a concept-column predicate, so the concept join must
      // precede paging. Order by the SOURCE's own id (`s.id`, == c.concept_id
      // on the join, so identical order) rather than `c.concept_id`: for an
      // index-ordered source (closure by descendant_id, value_set_member by
      // concept_id) SQLite then recognises the stream is already ordered, so it
      // streams the join, filters active, and early-stops at the LIMIT with NO
      // sort — the active page goes from a full 94k scan (~28ms) to ~0.1ms.
      // is-a's UNION ALL is not fully ordered, so it still does a bounded sort.
      rows = this.db.prepare(
        `SELECT c.concept_id AS id, c.code AS code, c.display AS display, c.active AS active
           FROM (${src.sql}) s JOIN concept c ON c.concept_id = s.id
          WHERE c.active = 1 ORDER BY s.id ${limitClause}`
      ).all(...src.args, ...limitArgs);
    } else {
      // Order + page the id set BEFORE joining concept, so only the page's worth
      // of ids reach the join. For an index-ordered source SQLite satisfies
      // `ORDER BY id LIMIT` from the index and early-stops.
      const pagedIds = `SELECT id FROM (${src.sql}) ORDER BY id ${limitClause}`;
      rows = this.db.prepare(
        `SELECT c.concept_id AS id, c.code AS code, c.display AS display, c.active AS active
           FROM (${pagedIds}) s JOIN concept c ON c.concept_id = s.id
          ORDER BY c.concept_id`
      ).all(...src.args, ...limitArgs);
    }
    const total = this._pageTotal(subtree, { from, count, activeOnly, pageLen: rows.length });
    return { rows, total };
  }

  _pageTotal(subtree, { from, count, activeOnly, pageLen }) {
    return pageTotalPolicy(count, from, pageLen, activeOnly, () => this._tryFastCount(subtree, activeOnly));
  }

  // Exact total for a fast-source subtree. Under activeOnly the concept join is
  // required (must touch every member to know which are active) — SQL COUNT
  // over the join beats materialising every id into JS to filter and count.
  _tryFastCount(subtree, activeOnly = false) {
    const src = this._fastSource(subtree);
    if (!src) return null;
    if (activeOnly) {
      return this.db.prepare(
        `SELECT COUNT(*) AS n FROM (${src.sql}) s JOIN concept c ON c.concept_id = s.id WHERE c.active = 1`
      ).get(...src.args).n;
    }
    return this.db.prepare(`SELECT COUNT(*) AS n FROM (${src.sql})`).get(...src.args).n;
  }

  _valueSetIdFor(value) {
    const urls = [String(value)];
    const patterns = Array.isArray(this.cfg.implicitValueSets) ? this.cfg.implicitValueSets : [];
    for (const p of patterns) {
      if (p.kind !== 'vs-table' || !p.pattern) continue;
      const filled = p.pattern.replace('{id}', String(value)).replace('{code}', String(value));
      urls.push(filled, this.system() + filled);
    }
    const stmt = this.db.prepare(`SELECT vs_id FROM value_set WHERE cs_id = ? AND url = ?`);
    for (const url of urls) {
      const row = stmt.get(this.csId, url);
      if (row) return row.vs_id;
    }
    return null;
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

    this.hasValueSets = !!this.db.prepare(
      `SELECT 1 FROM value_set WHERE cs_id = ? LIMIT 1`
    ).get(this.csId);

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
      case 'experimental':
      case 'isAIncludesSelf':
      case 'notClosed':
      case 'lookupLinkDescriptions':
      case 'lookupLinkDistinct':
      case 'designationUseDisplays':
      case 'displayDesignation':
        return value === '1' || value === 'true';
      case 'implicitValueSets':
      case 'filterAliases':
      case 'searchSources':
      case 'filterValueRewrites':
      case 'membershipFilters':
      case 'existsFilters':
      case 'propertyValueDescriptions':
      case 'designationsAsProperties':
      case 'designationUses':
      case 'lookupPropertyOverrides':
        try { return JSON.parse(value); } catch { return value; }
      default:
        return value;
    }
  }

  allConceptIds() {
    if (!this._allIds) {
      this._allIds = this.db.prepare(
        // Source (concept_id) order everywhere: importers insert in source-file
        // order, which reproduces each legacy provider's iteration order
        // (SNOMED numeric SCTID, RxNorm RRF/RXCUI, LOINC CodeKey). Page
        // composition under the default sort depends on this — see the
        // ordering contract in docs/sqlite-v1-design.md.
        `SELECT concept_id FROM concept WHERE cs_id = ? ORDER BY concept_id`
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
          ORDER BY c.concept_id`
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
    // Runtime class selection: match the DB's base_uri against the registered
    // provider classes (SNOMED etc.); fall back to the generic base.
    const ProviderClass = providerClassForSystem(this.meta.base_uri);
    return new ProviderClass(opContext, supplements, this);
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
        return this._buildVsTable(url, version, p, extracted);
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

  _buildVsTable(url, version, pattern = null, extracted = null) {
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
        WHERE m.vs_id = ? ORDER BY m.member_id`
    ).all(vs.vs_id);
    // FHIR name: nameTemplate from the implicitValueSets entry when present
    // ({code} = extracted code, sanitized to a valid FHIR name), else the
    // stored source name.
    let name = vs.name || url;
    if (pattern && pattern.nameTemplate && extracted && extracted.code) {
      name = pattern.nameTemplate.replace('{code}', extracted.code.replace(/[^A-Za-z0-9]/g, '_'));
    }
    return this._vs(url, name, {
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
  SqliteFilterSet,
  FilterClause,
  sortedIncludes,
  registerSqliteProviderClass,
};

// Register the terminology-specific subclasses. Required at the BOTTOM, AFTER
// module.exports, so the subclass module can require the base class (already
// exported by now) without a circular-initialization break. Each subclass calls
// registerSqliteProviderClass() at its own module load.
require('./cs-sqlite-snomed');
