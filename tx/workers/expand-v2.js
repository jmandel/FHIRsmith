//
// Expand Worker v2 — Clean rewrite of ValueSet $expand
//
// Key design principles:
//   1. Include/exclude share a single code-streaming pipeline
//   2. Decoration (display, designations, properties) is separated from set membership
//   3. Provider contract uses only iterator()/nextContext() — no getIterator/getNextContext
//   4. Async generators model code streams naturally
//

const { TerminologyWorker } = require('./worker');
const { TxParameters } = require('../params');
const { Designations, SearchFilterText } = require('../library/designations');
const { Extensions } = require('../library/extensions');
const { getValuePrimitive, getValueName } = require('../../library/utilities');
const { div } = require('../../library/html');
const { Issue, OperationOutcome } = require('../library/operation-outcome');
const { VersionUtilities } = require('../../library/version-utilities');
const crypto = require('crypto');
const ValueSet = require('../library/valueset');

// ── Constants ──────────────────────────────────────────────────────────────────

const UPPER_LIMIT_NO_TEXT = 1000;
const UPPER_LIMIT_TEXT = 1000;
const INTERNAL_LIMIT = 10000;
const EXPANSION_DEAD_TIME_SECS = 30;
const CACHE_WHEN_DEBUGGING = false;
const BULK_LOCATE_THRESHOLD = 50;
const BULK_LOCATE_BATCH_SIZE = 500;
const FILTER_PAGE_SIZE = 256;

// Extensions the expand worker copies from code system concepts
const CS_CONCEPT_EXTENSIONS = [
  'http://hl7.org/fhir/StructureDefinition/coding-sctdescid',
  'http://hl7.org/fhir/StructureDefinition/rendering-style',
  'http://hl7.org/fhir/StructureDefinition/rendering-xhtml',
  'http://hl7.org/fhir/StructureDefinition/codesystem-alternate',
];

const CS_STATUS_EXTENSIONS = [
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
];

const VS_CONCEPT_EXTENSIONS = [
  'http://hl7.org/fhir/StructureDefinition/valueset-supplement',
  'http://hl7.org/fhir/StructureDefinition/valueset-deprecated',
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
  'http://hl7.org/fhir/StructureDefinition/valueset-concept-definition',
  'http://hl7.org/fhir/StructureDefinition/coding-sctdescid',
  'http://hl7.org/fhir/StructureDefinition/rendering-style',
  'http://hl7.org/fhir/StructureDefinition/rendering-xhtml',
];

// ── Helpers ────────────────────────────────────────────────────────────────────

const canonical = (system, version) => version ? `${system}|${version}` : system;

const makeKey = (system, version, code, versioned) =>
  versioned ? `${system}~${version}~${code}` : `${system}~${code}`;

const excludeKey = (system, version, code) => `${system}|${version}#${code}`;

// ── ImportedValueSet ───────────────────────────────────────────────────────────

class ImportedValueSet {
  constructor(valueSet) {
    this.valueSet = valueSet;
    this.url = valueSet.url || '';
    this.version = valueSet.version || '';
    this.codeMap = new Map();
    this.systems = new Set();
    this._indexContains(valueSet.expansion?.contains || []);
  }

  _indexContains(contains) {
    for (const entry of contains) {
      if (entry.system && entry.code) {
        this.codeMap.set(`${entry.system}\x00${entry.code}`, entry);
        this.systems.add(entry.system);
      }
      if (entry.contains?.length) {
        this._indexContains(entry.contains);
      }
    }
  }

  hasCode(system, code) { return this.codeMap.has(`${system}\x00${code}`); }
  getCode(system, code) { return this.codeMap.get(`${system}\x00${code}`) || null; }
  hasSystem(system) { return this.systems.has(system); }
  get count() { return this.codeMap.size; }

  *codes() {
    for (const entry of this.codeMap.values()) {
      yield { system: entry.system, code: entry.code, entry };
    }
  }
}

// ── BulkLocateResolver ─────────────────────────────────────────────────────────
// Efficiently resolves codes via locateMany when available, with lazy batching.

class BulkLocateResolver {
  constructor(cs, orderedCodes, allAltCodes) {
    this._cs = cs;
    this._orderedCodes = orderedCodes;
    this._allAltCodes = allAltCodes;
    this._cache = new Map();
    this._missing = new Set();
    this._cursor = 0;

    const bulkFn = typeof cs.locateMany === 'function' ? cs.locateMany.bind(cs)
      : typeof cs.locateBatch === 'function' ? cs.locateBatch.bind(cs)
      : null;
    this._bulkFn = (bulkFn && orderedCodes.length >= BULK_LOCATE_THRESHOLD) ? bulkFn : null;
  }

  async locate(code) {
    const key = String(code || '');
    if (!key) return null;

    if (this._cache.has(key)) return this._cache.get(key);
    if (this._missing.has(key)) return null;

    if (this._bulkFn) {
      await this._loadUntilFound(key);
    } else {
      const result = await this._cs.locate(key, this._allAltCodes);
      if (result?.context) {
        this._cache.set(key, result);
      } else {
        this._missing.add(key);
      }
    }

    return this._cache.get(key) || null;
  }

  async _loadUntilFound(key) {
    while (this._cursor < this._orderedCodes.length && !this._cache.has(key) && !this._missing.has(key)) {
      const batch = this._orderedCodes.slice(this._cursor, this._cursor + BULK_LOCATE_BATCH_SIZE);
      this._cursor += BULK_LOCATE_BATCH_SIZE;
      const result = await this._bulkFn(batch, this._allAltCodes);
      this._ingest(result, batch);
    }

    // Fallback for codes not in orderedCodes
    if (!this._cache.has(key) && !this._missing.has(key)) {
      const result = await this._cs.locate(key, this._allAltCodes);
      if (result?.context) {
        this._cache.set(key, result);
      } else {
        this._missing.add(key);
      }
    }
  }

  _ingest(bulkResult, requestedCodes) {
    const loaded = new Set();
    if (bulkResult instanceof Map) {
      for (const [code, value] of bulkResult) {
        const k = String(code || '');
        if (k) { this._cache.set(k, value); loaded.add(k); }
      }
    } else if (Array.isArray(bulkResult)) {
      for (const row of bulkResult) {
        if (!row?.code) continue;
        const k = String(row.code);
        this._cache.set(k, row.result ?? row.value ?? row.located ?? row);
        loaded.add(k);
      }
    } else if (bulkResult && typeof bulkResult === 'object') {
      for (const [code, value] of Object.entries(bulkResult)) {
        const k = String(code || '');
        if (k) { this._cache.set(k, value); loaded.add(k); }
      }
    }
    for (const code of requestedCodes) {
      if (!loaded.has(code) && !this._cache.has(code)) {
        this._missing.add(code);
      }
    }
  }
}

// ── ValueSetExpander ───────────────────────────────────────────────────────────
// Core expansion engine. Processes compose includes/excludes via shared pipeline.

class ValueSetExpander {
  constructor(worker, params) {
    this.worker = worker;
    this.params = params;

    // Accumulation state
    this.map = new Map();           // key → contains entry (dedup)
    this.fullList = [];             // all included entries (flat order)
    this.rootList = [];             // root entries for hierarchy output
    this.excluded = new Set();      // excludeKey strings
    this.hasExclusions = false;
    this.canBeHierarchy = !params.excludeNested;
    this.doingVersion = false;

    // Total tracking
    this.total = 0;
    this.totalStatus = 'uninitialised'; // 'uninitialised' | 'set' | 'off'

    // Limits
    this.limitCount = 0;
    this.offset = -1;
    this.count = -1;

    // Per-system counters for expandLimitation
    this.csCounter = new Map();

    // Supplements tracking
    this.requiredSupplements = new Set();
    this.usedSupplements = new Set();
  }

  // ── Public entry point ───────────────────────────────────────────────────────

  async expand(source, filter, noCacheThisOne) {
    this.noCacheThisOne = noCacheThisOne;
    this.valueSet = source;

    Extensions.checkNoImplicitRules(source, 'ValueSetExpander.Expand', 'ValueSet');
    Extensions.checkNoModifiers(source, 'ValueSetExpander.Expand', 'ValueSet');
    this.worker.seeValueSet(source, this.params);

    const result = structuredClone(source.jsonObj);
    result.id = undefined;

    if (!this.params.includeDefinition) {
      Object.assign(result, {
        purpose: undefined, compose: undefined, description: undefined,
        contactList: undefined, copyright: undefined, publisher: undefined,
        extension: undefined, text: undefined,
      });
    }

    for (const s of this.params.supplements) this.requiredSupplements.add(s);
    for (const ext of Extensions.list(source.jsonObj, 'http://hl7.org/fhir/StructureDefinition/valueset-supplement')) {
      this.requiredSupplements.add(getValuePrimitive(ext));
    }

    // Already expanded — return as-is
    if (result.expansion) return result;

    // Narrative
    let div_ = null, table = null;
    if (this.params.generateNarrative) {
      div_ = div();
      table = div_.table('grid');
    } else {
      result.text = undefined;
    }

    // Initialize limits
    this.limitCount = this.params.limit > 0
      ? Math.min(this.params.limit, INTERNAL_LIMIT)
      : (filter.isNull ? UPPER_LIMIT_NO_TEXT : UPPER_LIMIT_TEXT);
    this.offset = this.params.offset;
    this.count = this.params.count;
    if (this.offset > 0) this.canBeHierarchy = false;

    // Build expansion
    const exp = {
      timestamp: new Date().toISOString(),
      identifier: 'urn:uuid:' + crypto.randomUUID(),
    };
    result.expansion = exp;

    this._addExpansionParams(exp, filter, source);
    this.checkResourceCanonicalStatus(exp, source, source);

    if (this.offset > -1) {
      this._addParam(exp, 'offset', 'valueInteger', this.offset);
      exp.offset = this.offset;
    }
    if (this.count > -1) {
      this._addParam(exp, 'count', 'valueInteger', this.count);
    }
    if (this.count > 0 && this.offset === -1) {
      this.offset = 0;
    }

    this.worker.opContext.log('start working');
    this.worker.deadCheck('expand');

    const notClosed = { value: false };

    try {
      const compose = source.jsonObj.compose;
      if (compose && Extensions.checkNoModifiers(compose, 'ValueSetExpander.Expand', 'compose')
          && this.worker.checkNoLockedDate(source.url, compose)) {
        await this._handleCompose(source, filter, exp, notClosed);
      }

      const unused = [...this.requiredSupplements].filter(s => !this.usedSupplements.has(s));
      if (unused.length > 0) {
        throw new Issue('error', 'not-found', null, 'VALUESET_SUPPLEMENT_MISSING',
          this.worker.i18n.translatePlural(unused.length, 'VALUESET_SUPPLEMENT_MISSING', this.params.HTTPLanguages, [unused.join(',')]),
          'not-found').handleAsOO(422);
      }
    } catch (e) {
      if (!(e instanceof Issue)) throw e;
      if (e.finished) {
        if (this.totalStatus === 'uninitialised') this.totalStatus = 'off';
      } else if (e.toocostly) {
        Extensions.addBoolean(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-toocostly', true);
        if (div_) div_.p().style('color: Maroon').tx(e.message);
      } else {
        throw e;
      }
    }

    // Assemble output
    this.worker.opContext.log('finish up');
    this._assembleOutput(result, exp, notClosed, table, div_, source);

    for (const s of this.worker.foundParameters) {
      const [l, r] = s.split('=');
      if (r !== source.vurl) this._addParam(exp, l, 'valueUri', r);
    }

    return result;
  }

  // ── Compose processing ───────────────────────────────────────────────────────

  async _handleCompose(source, filter, expansion, notClosed) {
    this.worker.opContext.log('compose: preflight');

    const systemVersions = new Map();
    const includes = source.jsonObj.compose.include || [];
    const excludes = source.jsonObj.compose.exclude || [];

    // Pre-flight: validate all sources
    for (const c of includes) {
      this.worker.deadCheck('compose:preflight');
      await this._checkSource(c, expansion, filter, source.url, systemVersions);
    }
    for (const c of excludes) {
      this.worker.deadCheck('compose:preflight');
      this.hasExclusions = true;
      await this._checkSource(c, expansion, filter, source.url, systemVersions);
    }

    // Group components by system for pushdown opportunities
    const groups = this._groupBySystem(includes, excludes);
    const excludeInactive = this._excludeInactives(source);

    for (const group of groups) {
      this.worker.deadCheck('compose:group');

      // Attempt pushdown for system-based groups with a capable provider
      if (group.system && await this._tryPushdown(group, source, filter, expansion,
          excludeInactive, notClosed)) {
        continue; // provider handled it
      }

      // Fallback: process excludes then includes via streaming
      for (const { cset, index } of group.excludes) {
        this.worker.deadCheck('compose:exclude');
        await this._processComponent(cset, `ValueSet.compose.exclude[${index}]`, source, filter,
          expansion, excludeInactive, notClosed, 'exclude');
      }
      for (const { cset, index } of group.includes) {
        this.worker.deadCheck('compose:include');
        await this._processComponent(cset, `ValueSet.compose.include[${index}]`, source, filter,
          expansion, excludeInactive, notClosed, 'include');
      }
    }
  }

  // ── Group components by system ───────────────────────────────────────────────
  // Components targeting the same system+version are grouped together so a
  // capable provider can handle includes and excludes in a single query.
  // Components without a system (pure ValueSet imports) get their own group.

  _groupBySystem(includes, excludes) {
    const map = new Map();      // "system|version" → group
    const noSystemGroups = [];   // pure VS-import components

    const addToGroup = (cset, index, role) => {
      if (!cset.system) {
        // Pure ValueSet import — always its own group, can't be pushed down
        noSystemGroups.push({
          system: null,
          version: null,
          includes: role === 'include' ? [{ cset, index }] : [],
          excludes: role === 'exclude' ? [{ cset, index }] : [],
        });
        return;
      }

      const key = `${cset.system}|${cset.version || ''}`;
      if (!map.has(key)) {
        map.set(key, {
          system: cset.system,
          version: cset.version || null,
          includes: [],
          excludes: [],
        });
      }
      map.get(key)[role === 'include' ? 'includes' : 'excludes'].push({ cset, index });
    };

    for (let i = 0; i < includes.length; i++) addToGroup(includes[i], i, 'include');
    for (let i = 0; i < excludes.length; i++) addToGroup(excludes[i], i, 'exclude');

    // Return system groups first (pushdown candidates), then no-system groups
    return [...map.values(), ...noSystemGroups];
  }

  // ── Provider pushdown ────────────────────────────────────────────────────────
  //
  // If a provider implements expandComponent(), we pass it the full group of
  // includes and excludes for its system, along with pre-expanded ValueSet
  // import codes as intersection constraints. The provider can handle filters,
  // exclusions, intersections, and optionally pagination in a single native query.
  //
  // Per FHIR ValueSet compose invariants (vsd-1, vsd-2, vsd-3):
  //   - Each component has system XOR is a pure valueSet import (vsd-1)
  //   - concept/filter requires system (vsd-2)
  //   - concept and filter are mutually exclusive (vsd-3)
  //
  // So each component passed to the provider has exactly one shape:
  //   A: {system}                          → whole system
  //   B: {system, concept:[...]}           → enumerated codes
  //   C: {system, filter:[...]}            → filtered codes
  //   D–F: any of A–C + intersectCodes     → same, intersected with ValueSet(s)

  async _tryPushdown(group, vsSrc, filter, expansion, excludeInactive, notClosed) {
    if (group.includes.length === 0) return false;

    const cs = await this.worker.findCodeSystem(group.system, group.version, this.params,
      ['complete', 'fragment'], false, false, true, null, this.requiredSupplements);
    if (!cs || typeof cs.expandComponent !== 'function') return false;

    // Pre-expand any ValueSet imports into code lists for intersection pushdown.
    // Each component with valueSet[] gets an intersectCodes array.
    const buildComponentRequest = async ({ cset }) => {
      let intersectCodes = null;

      if (cset.valueSet?.length) {
        // Expand each imported VS and intersect their code sets
        const codeSets = [];
        for (const u of cset.valueSet) {
          this.worker.deadCheck('pushdown:expand-vs-import');
          const s = this.worker.pinValueSet(u);
          const expanded = await this._expandNestedValueSet(s, '', filter, notClosed);
          const ivs = new ImportedValueSet(expanded);
          this.checkResourceCanonicalStatus(expansion, ivs.valueSet, this.valueSet);
          this._addParam(expansion, 'used-valueset', 'valueUri', this.worker.makeVurl(ivs.valueSet));
          codeSets.push(ivs);
        }

        // Intersect: a code must be in ALL imported ValueSets
        if (codeSets.length === 1) {
          intersectCodes = [...codeSets[0].codeMap.values()]
            .filter(e => e.system === group.system)
            .map(e => e.code);
        } else {
          intersectCodes = [...codeSets[0].codeMap.values()]
            .filter(e => e.system === group.system
              && codeSets.slice(1).every(vs => vs.hasCode(e.system, e.code)))
            .map(e => e.code);
        }
      }

      return {
        concept: cset.concept || null,    // enumerated codes (shape B/E) or null
        filter: cset.filter || null,      // filter clauses (shape C/F) or null
        // null = whole system (shape A/D). concept/filter are mutually exclusive (vsd-3).
        intersectCodes,                   // string[] from expanded ValueSets, or null
      };
    };

    const includeRequests = await Promise.all(group.includes.map(buildComponentRequest));
    const excludeRequests = await Promise.all(group.excludes.map(buildComponentRequest));

    // Determine if pagination can be pushed to the provider.
    // Safe when: this is the sole source of codes, nothing else is accumulated,
    // and there are no cross-system interactions.
    const canPushPagination = this.fullList.length === 0
      && this.excluded.size === 0
      && !this.hasExclusions;

    // Compute a limit ceiling. If any component has intersectCodes, the result
    // can't exceed the smallest intersection set.
    const intersectSizes = includeRequests
      .filter(r => r.intersectCodes)
      .map(r => r.intersectCodes.length);
    const intersectCeiling = intersectSizes.length > 0
      ? Math.min(...intersectSizes)
      : null;
    const effectiveLimit = intersectCeiling != null
      ? Math.min(this.limitCount, intersectCeiling)
      : this.limitCount;

    const request = {
      includes: includeRequests,
      excludes: excludeRequests,
      textFilter: filter.isNull ? null : filter.filter,
      activeOnly: this.params.activeOnly || false,
      excludeInactive,
      properties: this.params.properties || [],
      includeDesignations: this.params.includeDesignations || false,
      displayLanguages: this.params.workingLanguages?.() || null,
      pagination: canPushPagination && (this.offset > -1 || this.count > -1)
        ? { offset: Math.max(this.offset, 0), count: this.count }
        : null,
      limitCount: effectiveLimit,
    };

    this.worker.opContext.log(`pushdown expand for ${group.system}`);
    const result = await cs.expandComponent(request);

    if (!result) return false;

    // Ingest the pushdown result
    this.worker.checkSupplements(cs, group.includes[0].cset, this.requiredSupplements, this.usedSupplements);
    this.checkProviderCanonicalStatus(expansion, cs, this.valueSet);
    this._addParam(expansion, 'used-codesystem', 'valueUri', canonical(await cs.system(), await cs.version()));

    for (const v of cs.listSupplements()) {
      this._addParam(expansion, 'used-supplement', 'valueUri', v);
    }

    await this._ingestPushdownResult(result, cs, expansion, vsSrc);
    return true;
  }

  // ── Ingest pushdown results ──────────────────────────────────────────────────
  // The provider has already applied filters, exclusions, intersections, and
  // optionally pagination. We trust the result set but still build proper FHIR
  // contains entries and enforce the server-side limit as a safety net.

  async _ingestPushdownResult(result, cs, expansion, vsSrc) {
    const system = await cs.system();
    const version = await cs.version();

    if (result.total != null && result.total > -1) {
      this._incrementTotal(result.total);
    }

    for (const row of result.codes || []) {
      this.worker.deadCheck('ingestPushdown');

      const key = makeKey(system, version, row.code, this.doingVersion);
      if (this.map.has(key)) continue;

      if (this.limitCount > 0 && this.fullList.length >= this.limitCount) {
        throw new Issue('error', 'too-costly', null, 'VALUESET_TOO_COSTLY',
          this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages,
            [vsSrc.vurl || '??', '>' + this.limitCount]), null, 422)
          .withDiagnostics(this.worker.opContext.diagnostics());
      }

      const entry = { system, code: row.code };
      if (this.doingVersion) entry.version = version;
      if (row.isAbstract) entry.abstract = true;
      if (row.isInactive) entry.inactive = true;
      if (row.display) entry.display = row.display;

      if (row.designations?.length && this.params.includeDesignations) {
        entry.designation = row.designations;
      }

      if (row.properties?.length) {
        for (const prop of row.properties) {
          this._defineProperty(expansion, entry, prop.uri, prop.code, prop.valueName, prop.value);
        }
      }

      if (row.status && row.status.toLowerCase() !== 'active') {
        this._defineProperty(expansion, entry, 'http://hl7.org/fhir/concept-properties#status',
          'status', 'valueCode', row.status);
      } else if (row.isDeprecated) {
        this._defineProperty(expansion, entry, 'http://hl7.org/fhir/concept-properties#status',
          'status', 'valueCode', 'deprecated');
      }

      this.fullList.push(entry);
      this.map.set(key, entry);
      this.rootList.push(entry);
    }

    this.canBeHierarchy = false;
  }

  _excludeInactives(source) {
    return source.jsonObj.compose?.inactive !== undefined && !source.jsonObj.compose.inactive;
  }

  // ── Unified component processing ─────────────────────────────────────────────
  // This is the single code path for both include and exclude components.

  async _processComponent(cset, path, vsSrc, filter, expansion, excludeInactive, notClosed, mode) {
    this.worker.deadCheck('processComponent');
    Extensions.checkNoModifiers(cset, 'ValueSetExpander.processComponent', 'set');

    if (cset.valueSet || cset.concept || (cset.filter || []).length > 1) {
      this.canBeHierarchy = false;
    }

    // Case 1: Pure ValueSet import (no system)
    if (!cset.system) {
      await this._processValueSetOnly(cset, filter, expansion, notClosed, vsSrc, mode);
      return;
    }

    // Case 2: System-based (may also have ValueSet, concept, filter)
    const cs = await this.worker.findCodeSystem(cset.system, cset.version, this.params,
      ['complete', 'fragment'], false, mode === 'include' ? false : true, true, null, this.requiredSupplements);

    if (!cs) return;

    this.worker.checkSupplements(cs, cset, this.requiredSupplements, this.usedSupplements);
    this.checkProviderCanonicalStatus(expansion, cs, this.valueSet);
    this._addParam(expansion, 'used-codesystem', 'valueUri', canonical(await cs.system(), await cs.version()));

    // Resolve ValueSet import constraints
    const importedSets = [];
    for (const u of cset.valueSet || []) {
      this.worker.deadCheck('processComponent:vs-import');
      const s = this.worker.pinValueSet(u);
      this.worker.opContext.log(`import value set ${s}`);
      importedSets.push(new ImportedValueSet(await this._expandNestedValueSet(s, '', filter, notClosed)));
    }

    // Dispatch to the appropriate stream handler
    if (cset.concept) {
      await this._processConcepts(cs, cset.concept, filter, expansion, importedSets,
        excludeInactive, vsSrc, mode);
    } else if (cset.filter) {
      await this._processFilters(cs, cset.filter, path, filter, expansion, importedSets,
        excludeInactive, notClosed, vsSrc, mode);
    } else {
      await this._processWholeSystem(cs, filter, expansion, importedSets,
        excludeInactive, notClosed, vsSrc, mode);
    }
  }

  // ── Case 1: Pure ValueSet import ─────────────────────────────────────────────

  async _processValueSetOnly(cset, filter, expansion, notClosed, vsSrc, mode) {
    const importedSets = [];
    for (const u of cset.valueSet || []) {
      this.worker.deadCheck('processValueSetOnly');
      const s = this.worker.pinValueSet(u);
      this.worker.opContext.log(`import value set ${s}`);
      const ivs = new ImportedValueSet(await this._expandNestedValueSet(s, '', filter, notClosed));
      this.checkResourceCanonicalStatus(expansion, ivs.valueSet, this.valueSet);
      this._addParam(expansion, 'used-valueset', 'valueUri', this.worker.makeVurl(ivs.valueSet));
      importedSets.push(ivs);
    }

    if (importedSets.length === 0) return;

    if (mode === 'exclude') {
      this._noTotal();
      this._excludeFromExpansion(importedSets[0].valueSet, expansion, importedSets, 1);
    } else {
      this.canBeHierarchy = false;
      // Import the first set, filtered by subsequent sets
      await this._importValueSet(importedSets[0].valueSet, expansion, importedSets, 1);
    }
  }

  // ── Case 2a: Enumerated concepts ─────────────────────────────────────────────

  async _processConcepts(cs, concepts, filter, expansion, importedSets, excludeInactive, vsSrc, mode) {
    this.worker.opContext.log('iterate concepts');

    const resolver = new BulkLocateResolver(
      cs,
      [...new Set(concepts.map(c => String(c?.code || '')).filter(Boolean))],
      this.allAltCodes,
    );

    const cds = new Designations(this.worker.i18n.languageDefinitions);

    for (const cc of concepts) {
      this.worker.deadCheck('processConcepts');
      cds.clear();
      Extensions.checkNoModifiers(cc, 'ValueSetExpander.processConcepts', 'set concept reference');

      const located = await resolver.locate(cc.code);
      if (!located?.context) continue;
      if (this.params.activeOnly && await cs.isInactive(located.context)) continue;

      await this._listDisplays(cds, cs, located.context);
      this._applyConceptOverrides(cds, cc, vsSrc);

      if (!filter.passesDesignations(cds) && !filter.passes(cc.code)) continue;
      if (!this._passesImports(importedSets, await cs.system(), cc.code, 0)) continue;

      if (mode === 'exclude') {
        this._addExclusion(cs, await cs.system(), await cs.version(), cc.code, expansion, importedSets, vsSrc.url);
      } else {
        let itemWeight = Extensions.readString(cc, 'http://hl7.org/fhir/StructureDefinition/itemWeight')
          || await cs.itemWeight(located.context);
        const csProperties = await this._loadProperties(cs, located.context);
        const added = this._addToExpansion(cs, null, await cs.system(), await cs.version(), cc.code,
          await cs.isAbstract(located.context), await cs.isInactive(located.context),
          await cs.isDeprecated(located.context), await cs.getStatus(located.context),
          cds, await cs.definition(located.context), itemWeight,
          expansion, importedSets, await cs.extensions(located.context), cc.extension,
          csProperties, null, excludeInactive, vsSrc.url);
        if (added) this._incrementTotal();
      }
    }
    this.worker.opContext.log('iterate concepts done');
  }

  // ── Case 2b: Filter-based ────────────────────────────────────────────────────

  async _processFilters(cs, filterClauses, path, textFilter, expansion, importedSets,
                         excludeInactive, notClosed, vsSrc, mode) {
    this.worker.opContext.log('prepare filters');

    const prep = await cs.getPrepContext(true);

    if (!textFilter.isNull) {
      await cs.searchFilter(prep, textFilter, mode === 'exclude');
    }

    if (cs.specialEnumeration()) {
      Extensions.addString(expansion, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed',
        `The code System "${cs.system()}" has a grammar and so has infinite members. This extension is based on ${cs.specialEnumeration()}`);
      notClosed.value = true;
    }

    for (let i = 0; i < filterClauses.length; i++) {
      this.worker.deadCheck('processFilters:apply');
      const fc = filterClauses[i];
      if (!fc.value) {
        throw new Issue('error', 'invalid', `${path}.filter[${i}]`,
          'UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE',
          this.worker.i18n.translate('UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE',
            this.params.httpLanguages, [cs.system(), fc.property, fc.op]),
          'vs-invalid', 400);
      }
      Extensions.checkNoModifiers(fc, 'ValueSetExpander.processFilters', 'filter');
      await cs.filter(prep, fc.property, fc.op, fc.value);
    }

    const filterSets = await cs.executeFilters(prep);
    if (await cs.filtersNotClosed(prep)) {
      notClosed.value = true;
    }

    this.worker.opContext.log('iterate filters');
    await this._iterateFilterSet(cs, prep, filterSets, async (context) => {
      if (this.params.activeOnly && await cs.isInactive(context)) return;
      if (!await this._passesSecondaryFilters(cs, context, prep, filterSets, 1)) return;
      if (!this._passesImports(importedSets, cs.system(), await cs.code(context), 0)) return;

      if (mode === 'exclude') {
        this._addExclusion(cs, await cs.system(), await cs.version(), await cs.code(context),
          expansion, null, vsSrc.url);
      } else {
        const cds = new Designations(this.worker.i18n.languageDefinitions);
        await this._listDisplays(cds, cs, context);
        const csProperties = await this._loadProperties(cs, context);
        let parent = null;
        if (cs.hasParents()) {
          parent = this.map.get(makeKey(cs.system(), cs.version(), await cs.parent(context), this.doingVersion));
        } else {
          this.canBeHierarchy = false;
        }
        const added = this._addToExpansion(cs, parent, await cs.system(), await cs.version(),
          await cs.code(context), await cs.isAbstract(context), await cs.isInactive(context),
          await cs.isDeprecated(context), await cs.getStatus(context),
          cds, await cs.definition(context), await cs.itemWeight(context),
          expansion, null, await cs.extensions(context), null,
          csProperties, null, excludeInactive, vsSrc.url);
        if (added) this._incrementTotal();
      }
    }, 'processFilters');
    this.worker.opContext.log('iterate filters done');
  }

  // ── Case 2c: Whole system ────────────────────────────────────────────────────

  async _processWholeSystem(cs, textFilter, expansion, importedSets, excludeInactive, notClosed, vsSrc, mode) {
    // Grammar-based systems with specialEnumeration
    if (cs.specialEnumeration() && importedSets.length === 0) {
      this.worker.opContext.log(`import special value set ${cs.specialEnumeration()}`);
      const base = await this._expandNestedValueSet(cs.specialEnumeration(), '', textFilter, notClosed);
      Extensions.addString(expansion, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed',
        `The code System "${cs.system()}" has a grammar and so has infinite members. This extension is based on ${cs.specialEnumeration()}`);
      notClosed.value = true;

      if (mode === 'exclude') {
        this._excludeFromExpansion(base, expansion, importedSets, 0);
      } else {
        await this._importValueSet(base, expansion, importedSets, 0);
      }
      return;
    }

    // Text filter present — use search/filter protocol
    if (!textFilter.isNull) {
      this._noTotal();
      if (cs.isNotClosed(textFilter)) notClosed.value = true;

      const prep = await cs.getPrepContext(true);
      await cs.searchFilter(prep, textFilter, false);
      const filterSets = await cs.executeFilters(prep);

      this.worker.opContext.log('iterate text filter results');
      await this._iterateFilterSet(cs, prep, filterSets, async (context) => {
        if (!await this._passesSecondaryFilters(cs, context, prep, filterSets, 1)) return;
        if (!this._passesImports(importedSets, cs.system(), await cs.code(context), 0)) return;

        if (mode === 'exclude') {
          this._addExclusion(cs, await cs.system(), await cs.version(), await cs.code(context),
            expansion, importedSets, vsSrc.url);
        } else {
          const cds = new Designations(this.worker.i18n.languageDefinitions);
          await this._listDisplays(cds, cs, context);
          const csProperties = await this._loadProperties(cs, context);
          this._addToExpansion(cs, null, await cs.system(), await cs.version(),
            await cs.code(context), await cs.isAbstract(context), await cs.isInactive(context),
            await cs.isDeprecated(context), await cs.getStatus(context),
            cds, await cs.definition(context), await cs.itemWeight(context),
            expansion, importedSets, await cs.extensions(context), null,
            csProperties, null, excludeInactive, vsSrc.url);
        }
      }, 'wholeSystem:textFilter');
      this.worker.opContext.log('iterate text filter done');
      return;
    }

    // No filter — full enumeration
    this.worker.opContext.log('enumerate whole system');

    if (cs.isNotClosed()) {
      if (cs.specialEnumeration()) {
        Extensions.addString(expansion, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed',
          `The code System "${cs.system()}" has a grammar and so has infinite members. This extension is based on ${cs.specialEnumeration()}`);
      } else {
        throw new Issue('error', 'too-costly', null, null,
          `The code System "${cs.system()}" has a grammar, and cannot be enumerated directly`, null, 422)
          .withDiagnostics(this.worker.opContext.diagnostics());
      }
      notClosed.value = true;
    }

    const iter = await cs.iterator(null);

    // Pre-flight size check for includes
    if (mode === 'include' && importedSets.length === 0 && this.limitCount > 0 &&
        iter && iter.total > this.limitCount && this.offset < 0) {
      throw new Issue('error', 'too-costly', null, 'VALUESET_TOO_COSTLY',
        this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages,
          [vsSrc.vurl, '>' + this.limitCount]), null, 422)
        .withDiagnostics(this.worker.opContext.diagnostics());
    }

    let tcount = 0;
    let context = await cs.nextContext(iter);
    while (context) {
      this.worker.deadCheck('wholeSystem:enumerate');
      if (mode === 'exclude') {
        tcount += await this._processDescendants(cs, context, expansion, importedSets,
          null, excludeInactive, vsSrc.url, 'exclude');
      } else {
        tcount += await this._processDescendants(cs, context, expansion, importedSets,
          null, excludeInactive, vsSrc.url, 'include');
      }
      context = await cs.nextContext(iter);
    }
    if (mode === 'include') this._incrementTotal(tcount);
  }

  // ── Recursive hierarchy traversal (shared) ───────────────────────────────────

  async _processDescendants(cs, context, expansion, imports, parent, excludeInactive, srcUrl, mode) {
    let count = 0;
    this.worker.deadCheck('processDescendants');

    const system = await cs.system();
    const version = await cs.version();

    if (expansion) {
      this._addParam(expansion, 'used-codesystem', 'valueUri', canonical(system, version));
      for (const v of cs.listSupplements()) {
        this.worker.deadCheck('processDescendants:supplements');
        this._addParam(expansion, 'used-supplement', 'valueUri', v);
      }
    }

    const isAbstract = await cs.isAbstract(context);
    const isInactive = await cs.isInactive(context);
    const shouldInclude = (!this.params.excludeNotForUI || !isAbstract)
      && (!this.params.activeOnly || !isInactive);

    let treeParent = parent;

    if (shouldInclude) {
      if (mode === 'exclude') {
        this._addExclusion(cs, system, version, context.code, expansion, imports, srcUrl);
      } else {
        const cds = new Designations(this.worker.i18n.languageDefinitions);
        await this._listDisplays(cds, cs, context);
        const csProperties = await this._loadProperties(cs, context);
        const added = this._addToExpansion(cs, parent, system, version, context.code,
          isAbstract, isInactive, await cs.isDeprecated(context), await cs.getStatus(context),
          cds, await cs.definition(context), await cs.itemWeight(context),
          expansion, imports, await cs.extensions(context), null,
          csProperties, null, excludeInactive, srcUrl);
        if (added) {
          count++;
          treeParent = added;
        }
      }
    }

    if (!this.canBeHierarchy) return count;

    const childIter = await cs.iterator(context);
    if (childIter) {
      let child = await cs.nextContext(childIter);
      while (child) {
        this.worker.deadCheck('processDescendants:children');
        count += await this._processDescendants(cs, child, expansion, imports,
          treeParent, excludeInactive, srcUrl, mode);
        child = await cs.nextContext(childIter);
      }
    }
    return count;
  }

  // ── Filter iteration ─────────────────────────────────────────────────────────
  // Uses filterPage (preferred) or filterMore/filterConcept (legacy).

  async _iterateFilterSet(cs, prep, filterSets, onConcept, tag = 'iterateFilters') {
    const primary = Array.isArray(filterSets) ? filterSets[0] : filterSets;
    if (!primary) return;

    if (typeof cs.filterPage === 'function') {
      while (true) {
        this.worker.deadCheck(tag);
        const page = await cs.filterPage(prep, primary, FILTER_PAGE_SIZE);
        if (!Array.isArray(page) || page.length === 0) break;
        for (const c of page) {
          this.worker.deadCheck(tag);
          await onConcept(c);
        }
      }
      return;
    }

    while (await cs.filterMore(prep, primary)) {
      this.worker.deadCheck(tag);
      const c = await cs.filterConcept(prep, primary);
      await onConcept(c);
    }
  }

  async _passesSecondaryFilters(cs, context, prep, filterSets, offset) {
    for (let j = offset; j < filterSets.length; j++) {
      if (await cs.filterCheck(prep, filterSets[j], context) !== true) return false;
    }
    return true;
  }

  // ── Nested ValueSet expansion ────────────────────────────────────────────────

  async _expandNestedValueSet(uri, version, filter, notClosed) {
    let vs = await this.worker.findValueSet(uri, version);
    if (!vs) {
      if (version) {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK_PINNED',
          this.worker.i18n.translate('VS_EXP_IMPORT_UNK_PINNED', this.params.httpLanguages,
            [uri.includes('|') ? uri.substring(0, uri.indexOf('|')) : uri,
             version || uri.substring(uri.indexOf('|') + 1)]),
          'not-found', 422);
      }
      throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK',
        this.worker.i18n.translate('VS_EXP_IMPORT_UNK', this.params.httpLanguages, [uri]),
        'not-found', 422);
    }

    const nestedWorker = new ExpandWorker(this.worker.opContext, this.worker.log,
      this.worker.provider, this.worker.languages, this.worker.i18n);
    nestedWorker.additionalResources = this.worker.additionalResources;

    const nestedParams = this.params.clone();
    nestedParams.limit = INTERNAL_LIMIT;
    const nestedExpander = new ValueSetExpander(nestedWorker, nestedParams);
    const result = await nestedExpander.expand(vs, filter, false);

    if (!result) {
      throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK',
        this.worker.i18n.translate('VS_EXP_IMPORT_UNK', this.params.httpLanguages, [uri]), 'unknown');
    }

    if (Extensions.has(result.expansion, 'http://hl7.org/fhir/params/questionnaire-extensions#closed')) {
      notClosed.value = true;
    }
    return result;
  }

  async _checkCanExpandValueSet(uri, version) {
    const vs = await this.worker.findValueSet(uri, version);
    if (!vs) {
      if (!version && uri.includes('|')) {
        version = uri.substring(uri.indexOf('|') + 1);
        uri = uri.substring(0, uri.indexOf('|'));
      }
      if (!version) {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK',
          this.worker.i18n.translate('VS_EXP_IMPORT_UNK', this.params.httpLanguages, [uri]), 'unknown', 422);
      }
      throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK_PINNED',
        this.worker.i18n.translate('VS_EXP_IMPORT_UNK_PINNED', this.params.httpLanguages, [uri, version]), 'not-found', 422);
    }
    this.worker.seeSourceVS(vs, uri);
  }

  // ── ValueSet import / exclude ────────────────────────────────────────────────

  async _importValueSet(vs, expansion, imports, offset) {
    this.canBeHierarchy = false;
    for (const p of vs.expansion.parameter || []) {
      this._addParam(expansion, p.name, getValueName(p), getValuePrimitive(p));
    }
    this.checkResourceCanonicalStatus(expansion, vs, this.valueSet);

    for (const c of vs.expansion.contains || []) {
      this.worker.deadCheck('importValueSet');
      await this._importValueSetItem(null, c, imports, offset);
    }
  }

  async _importValueSetItem(parent, c, imports, offset) {
    this.worker.deadCheck('importValueSetItem');
    const key = makeKey(c.system, c.version, c.code, this.doingVersion);
    if (this._passesImports(imports, c.system, c.code, offset) && !this.map.has(key)) {
      this.fullList.push(c);
      if (parent) {
        parent.contains = parent.contains || [];
        parent.contains.push(c);
      } else {
        this.rootList.push(c);
      }
      this.map.set(key, c);
    }
    for (const cc of c.contains || []) {
      await this._importValueSetItem(c, cc, imports, offset);
    }
  }

  _excludeFromExpansion(vs, expansion, imports, offset) {
    for (const c of vs.expansion.contains || []) {
      this.worker.deadCheck('excludeFromExpansion');
      const key = makeKey(c.system, c.version, c.code, this.doingVersion);
      if (this._passesImports(imports, c.system, c.code, offset) && this.map.has(key)) {
        const idx = this.fullList.indexOf(this.map.get(key));
        if (idx >= 0) this.fullList.splice(idx, 1);
        this.map.delete(key);
        this._decrementTotal();
      }
    }
  }

  // ── Pre-flight source validation ─────────────────────────────────────────────

  async _checkSource(cset, exp, filter, srcURL, systemVersions) {
    this.worker.deadCheck('checkSource');
    Extensions.checkNoModifiers(cset, 'ValueSetExpander.checkSource', 'set');

    let hasImport = false;
    for (const u of cset.valueSet || []) {
      this.worker.deadCheck('checkSource:vs');
      const s = this.worker.pinValueSet(u);
      await this._checkCanExpandValueSet(s, '');
      hasImport = true;
    }

    if (systemVersions.has(cset.system)) {
      if (systemVersions.get(cset.system) !== cset.version) this.doingVersion = true;
    } else {
      systemVersions.set(cset.system, cset.version);
    }

    if (!cset.system) return;

    const cs = await this.worker.findCodeSystem(cset.system, cset.version, this.params,
      ['complete', 'fragment'], false, true, true, null, this.requiredSupplements);
    this.worker.seeSourceProvider(cs, cset.system);

    if (!cs) return;

    const content = cs.contentMode();
    if (content !== 'complete') {
      if (content === 'not-present') {
        throw new Issue('error', 'business-rule', null, null,
          `The code system definition for ${cset.system} has no content, so this expansion cannot be performed`, 'invalid');
      }
      if (content === 'supplement') {
        throw new Issue('error', 'business-rule', null, null,
          `The code system definition for ${cset.system} defines a supplement, so this expansion cannot be performed`, 'invalid');
      }
      this._addParam(exp, content, 'valueUri', `${cs.system()}|${cs.version()}`);
      Extensions.addString(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed',
        `This extension is based on a fragment of the code system ${cset.system}`);
    }

    if (!cset.concept && !cset.filter) {
      if (cs.specialEnumeration()) {
        await this._checkCanExpandValueSet(cs.specialEnumeration(), '');
      } else if (filter.isNull) {
        if (cs.isNotClosed()) {
          if (cs.specialEnumeration()) {
            Extensions.addString(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed',
              `The code System "${cs.system()}" has a grammar and so has infinite members. This extension is based on ${cs.specialEnumeration()}`);
          } else {
            throw new Issue('error', 'too-costly', null, null,
              `The code System "${cs.system()}" has a grammar, and cannot be enumerated directly`, null, 422)
              .withDiagnostics(this.worker.opContext.diagnostics());
          }
        }
        if (!hasImport && this.limitCount > 0 && cs.totalCount > this.limitCount) {
          const canReturnPartial = this.offset > -1 || this.count > -1 || this.params.limitedExpansion || this.params.incompleteOK;
          if (canReturnPartial) {
            this._noTotal();
          } else {
            throw new Issue('error', 'too-costly', null, 'VALUESET_TOO_COSTLY',
              this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages,
                [srcURL, '>' + this.limitCount]), null, 422)
              .withDiagnostics(this.worker.opContext.diagnostics());
          }
        }
      }
    }
  }

  // ── Display / designation loading ────────────────────────────────────────────

  _canUseDisplayFastPath() {
    if (this.params.includeDesignations || this.params.hasDesignations) return false;
    const wl = this.params.workingLanguages?.();
    if (!wl || !Array.isArray(wl.languages) || wl.languages.length === 0) return true;
    return wl.languages.every(lang => {
      const code = String(lang?.code || '').toLowerCase();
      return code === '' || code === '*' || code.startsWith('en');
    });
  }

  async _listDisplays(displays, cs, context) {
    if (this._canUseDisplayFastPath() && typeof cs.display === 'function') {
      const display = await cs.display(context);
      if (display != null) {
        const inactive = typeof cs.isInactive === 'function' ? await cs.isInactive(context) : false;
        displays.addDesignation(true, inactive ? 'inactive' : 'active', null, null, display);
      }
      displays.source = cs;
      return;
    }
    await cs.designations(context, displays);
    displays.source = cs;
  }

  _applyConceptOverrides(displays, conceptRef, vsSrc) {
    if (conceptRef.display) {
      if (!VersionUtilities.isR4Plus(this.worker.provider.getFhirVersion())) {
        displays.clear();
      }
      const lang = vsSrc.language ? this.worker.languages.parse(vsSrc.language) : null;
      displays.addDesignation(true, 'active', lang, null, conceptRef.display);
    }
    for (const cd of conceptRef.designation || []) {
      displays.addDesignationFromConcept(cd);
    }
  }

  // ── Designation filtering ────────────────────────────────────────────────────

  _useDesignation(cd) {
    if (!this.params.hasDesignations) return true;
    for (const s of this.params.designations) {
      const [l, r] = s.split('|');
      if (cd.use?.system === l && cd.use?.code === r) return true;
      if (cd.language?.code && l === 'urn:ietf:bcp:47' && r === cd.language.code) return true;
    }
    return false;
  }

  _redundantDisplay(entry, lang, use, value) {
    if (!((!lang && !this.valueSet.language) || (lang && lang.code.startsWith(this.valueSet.language)))) return false;
    if (!(!use || use.code === 'display')) return false;
    return value.asString === entry.display;
  }

  // ── Property loading ─────────────────────────────────────────────────────────

  _shouldLoadProperties() {
    return Array.isArray(this.params.properties) && this.params.properties.length > 0;
  }

  async _loadProperties(cs, context) {
    if (!this._shouldLoadProperties()) return null;
    if (typeof cs.getProperties === 'function') return cs.getProperties(context);
    if (typeof cs.properties === 'function') return cs.properties(context);
    return null;
  }

  // ── Core accumulation: add to / exclude from expansion ───────────────────────

  _addToExpansion(cs, parent, system, version, code, isAbstract, isInactive, deprecated, status,
                   displays, definition, itemWeight, expansion, imports, csExtList, vsExtList,
                   csProps, expProps, excludeInactive, srcURL) {
    this.worker.deadCheck('addToExpansion');

    if (!this._passesImports(imports, system, code, 0)) return null;
    if (isInactive && excludeInactive) return null;
    if (this.excluded.has(excludeKey(system, version, code))) return null;

    // Per-system expansion cap
    if (cs?.expandLimitation > 0) {
      let counter = this.csCounter.get(cs.system);
      if (!counter) { counter = { count: 0 }; this.csCounter.set(cs.system, counter); }
      counter.count++;
      if (counter.count > cs.expandLimitation) return null;
    }

    // Pagination short-circuit (only when no exclusions to process)
    if (!this.hasExclusions && this.count > -1 && this.offset > -1
        && this.count + this.offset > 0 && this.fullList.length >= this.count + this.offset) {
      this._noTotal();
      throw new Issue('information', 'informational', null, null, null, null).setFinished();
    }

    // Too-costly check
    if (this.limitCount > 0 && this.fullList.length >= this.limitCount && !this.hasExclusions) {
      throw new Issue('error', 'too-costly', null, 'VALUESET_TOO_COSTLY',
        this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages,
          [srcURL || '??', '>' + this.limitCount]), null, 422)
        .withDiagnostics(this.worker.opContext.diagnostics());
    }

    // Track used code systems
    if (expansion) {
      this._addParam(expansion, 'used-codesystem', 'valueUri', canonical(system, version));
      if (cs) {
        for (const v of cs.listSupplements()) {
          this._addParam(expansion, 'used-supplement', 'valueUri', v);
        }
      }
    }

    const key = makeKey(system, version, code, this.doingVersion);
    if (this.map.has(key)) return null;

    // Build the contains entry
    const entry = { system, code };
    if (this.doingVersion) entry.version = version;
    if (isAbstract) entry.abstract = isAbstract;
    if (isInactive) entry.inactive = true;

    // Status / deprecated properties
    if (status && status.toLowerCase() !== 'active') {
      this._defineProperty(expansion, entry, 'http://hl7.org/fhir/concept-properties#status', 'status', 'valueCode', status);
    } else if (deprecated) {
      this._defineProperty(expansion, entry, 'http://hl7.org/fhir/concept-properties#status', 'status', 'valueCode', 'deprecated');
    }

    // Extension-driven properties
    this._applyExtensionProperties(expansion, entry, csExtList, vsExtList);

    // Display
    const pref = displays.preferredDesignation(this.params.workingLanguages());
    if (pref?.value) entry.display = pref.value;

    // Designations
    if (this.params.includeDesignations) {
      for (const t of displays.designations) {
        if (t !== pref && this._useDesignation(t) && t.value != null
            && !this._redundantDisplay(entry, t.language, t.use, t.value)) {
          entry.designation = entry.designation || [];
          entry.designation.push(t.asObject());
        }
      }
    }

    // Requested properties
    for (const pn of this.params.properties) {
      if (pn === 'definition') {
        if (definition) {
          this._defineProperty(expansion, entry, 'http://hl7.org/fhir/concept-properties#definition', pn, 'valueString', definition);
        }
      } else if (csProps && cs) {
        for (const cp of csProps) {
          if (cp.code === pn) {
            const vn = getValueName(cp);
            this._defineProperty(expansion, entry, this._getPropUrl(cs, pn), pn, vn, cp[vn]);
          }
        }
      }
    }

    // Add to expansion
    this.fullList.push(entry);
    this.map.set(key, entry);
    if (parent) {
      parent.contains = parent.contains || [];
      parent.contains.push(entry);
    } else {
      this.rootList.push(entry);
    }

    return entry;
  }

  _addExclusion(cs, system, version, code, expansion, imports, srcURL) {
    this.worker.deadCheck('addExclusion');
    if (imports && !this._passesImports(imports, system, code, 0)) return;

    if (expansion) {
      this._addParam(expansion, 'used-codesystem', 'valueUri', canonical(system, version));
      if (cs) {
        for (const v of cs.listSupplements()) {
          this._addParam(expansion, 'used-supplement', 'valueUri', v);
        }
      }
    }

    this.excluded.add(excludeKey(system, version, code));
  }

  // ── Import filter helpers ────────────────────────────────────────────────────

  _passesImports(imports, system, code, offset) {
    if (!imports) return true;
    for (let i = offset; i < imports.length; i++) {
      if (!imports[i].hasCode(system, code)) return false;
    }
    return true;
  }

  // ── Extension-driven property helpers ────────────────────────────────────────

  _applyExtensionProperties(expansion, entry, csExtList, vsExtList) {
    if (csExtList) {
      for (const ext of csExtList) {
        if (CS_CONCEPT_EXTENSIONS.includes(ext.url)) {
          entry.extension = entry.extension || [];
          entry.extension.push(ext);
        }
        if (CS_STATUS_EXTENSIONS.includes(ext.url)) {
          this._defineProperty(expansion, entry, 'http://hl7.org/fhir/concept-properties#status', 'status', 'valueCode', getValuePrimitive(ext));
        }
      }
    }

    if (vsExtList) {
      for (const ext of vsExtList) {
        if (VS_CONCEPT_EXTENSIONS.includes(ext.url)) {
          entry.extension = entry.extension || [];
          entry.extension.push(ext);
        }
      }
    }

    // Label
    const csLabel = Extensions.readString(csExtList, 'http://hl7.org/fhir/StructureDefinition/codesystem-label');
    const vsLabel = Extensions.readString(vsExtList, 'http://hl7.org/fhir/StructureDefinition/valueset-label');
    if (csLabel || vsLabel) {
      this._defineProperty(expansion, entry, 'http://hl7.org/fhir/concept-properties#label', 'label', 'valueString', vsLabel || csLabel);
    }

    // Order
    const csOrder = Extensions.readNumber(csExtList, 'http://hl7.org/fhir/StructureDefinition/codesystem-conceptOrder', undefined);
    const vsOrder = Extensions.readNumber(vsExtList, 'http://hl7.org/fhir/StructureDefinition/valueset-conceptOrder', undefined);
    if (csOrder !== undefined || vsOrder !== undefined) {
      this._defineProperty(expansion, entry, 'http://hl7.org/fhir/concept-properties#order', 'order', 'valueDecimal', vsOrder ?? csOrder);
    }

    // Weight
    const csWeight = Extensions.readNumber(csExtList, 'http://hl7.org/fhir/StructureDefinition/itemWeight', undefined);
    const vsWeight = Extensions.readNumber(vsExtList, 'http://hl7.org/fhir/StructureDefinition/itemWeight', undefined);
    if (csWeight !== undefined || vsWeight !== undefined) {
      this._defineProperty(expansion, entry, 'http://hl7.org/fhir/concept-properties#itemWeight', 'weight', 'valueDecimal', vsWeight ?? csWeight);
    }
  }

  // ── Property definition ──────────────────────────────────────────────────────

  _defineProperty(expansion, entry, url, code, valueName, value) {
    if (value === undefined || value == null) return;

    if (url && expansion) {
      expansion.property = expansion.property || [];
      let pd = expansion.property.find(t => t.uri === url || t.code === code);
      if (!pd) {
        pd = { uri: url, code };
        expansion.property.push(pd);
      } else if (!pd.uri) {
        pd.uri = url;
      }
      if (pd.uri !== url) {
        throw new Error(`URL mismatch on expansion: ${pd.uri} vs ${url} for code ${code}`);
      }
      code = pd.code;
    }

    entry.property = entry.property || [];
    let pdv = entry.property.find(t => t.code === code);
    if (!pdv) {
      pdv = { code };
      entry.property.push(pdv);
    }
    pdv[valueName] = value;
  }

  _getPropUrl(cs, pn) {
    for (const p of cs.propertyDefinitions()) {
      if (pn === p.code) return p.uri;
    }
    return undefined;
  }

  // ── Total tracking ───────────────────────────────────────────────────────────

  _incrementTotal(n = 1) {
    if (this.total > -1 && this.totalStatus !== 'off') {
      this.total += n;
      this.totalStatus = 'set';
    }
  }

  _decrementTotal(n = 1) {
    if (this.total > -1 && this.totalStatus !== 'off') {
      this.total -= n;
      this.totalStatus = 'set';
    }
  }

  _noTotal() {
    this.total = -1;
    this.totalStatus = 'off';
  }

  // ── Expansion parameter helpers ──────────────────────────────────────────────

  _addExpansionParams(exp, filter, source) {
    if (!filter.isNull) this._addParam(exp, 'filter', 'valueString', filter.filter);

    if (this.params.DisplayLanguages) {
      this._addParam(exp, 'displayLanguage', 'valueCode', this.params.DisplayLanguages.asString(true));
    } else if (this.params.HTTPLanguages) {
      this._addParam(exp, 'displayLanguage', 'valueCode', this.params.HTTPLanguages.asString(true));
    }

    for (const s of this.params.designations || []) {
      this._addParam(exp, 'designation', 'valueString', s);
    }

    const boolParams = [
      ['hasExcludeNested', 'excludeNested'],
      ['hasActiveOnly', 'activeOnly'],
      ['hasIncludeDesignations', 'includeDesignations'],
      ['hasIncludeDefinition', 'includeDefinition'],
      ['hasExcludeNotForUI', 'excludeNotForUI'],
      ['hasExcludePostCoordinated', 'excludePostCoordinated'],
    ];
    for (const [flag, name] of boolParams) {
      if (this.params[flag]) {
        this._addParam(exp, name, 'valueBoolean', this.params[name]);
      }
    }
  }

  _addParam(exp, name, valueName, value) {
    if (!exp) return;
    const existing = (exp.parameter || []).find(p => p.name === name && getValuePrimitive(p) === value);
    if (existing) return;
    exp.parameter = exp.parameter || [];
    const p = { name };
    p[valueName] = value;
    exp.parameter.push(p);
  }

  // ── Canonical status checking ────────────────────────────────────────────────

  checkResourceCanonicalStatus(exp, resource, source) {
    const r = resource.jsonObj || resource;
    this._checkCanonicalStatus(exp, this.worker.makeVurl(r), r.status,
      Extensions.readString(r, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'),
      r.experimental, source);
  }

  checkProviderCanonicalStatus(exp, cs, source) {
    const status = cs.status();
    this._checkCanonicalStatus(exp, cs.vurl(), status.status, status.standardsStatus, status.experimental, source);
  }

  _checkCanonicalStatus(exp, vurl, status, standardsStatus, experimental, source) {
    if (standardsStatus === 'deprecated')      { this._addParam(exp, 'warning-deprecated', 'valueUri', vurl); }
    else if (standardsStatus === 'withdrawn')   { this._addParam(exp, 'warning-withdrawn', 'valueUri', vurl); }
    else if (status === 'retired')              { this._addParam(exp, 'warning-retired', 'valueUri', vurl); }
    else if (experimental && !source.experimental) { this._addParam(exp, 'warning-experimental', 'valueUri', vurl); }
    else if ((status === 'draft' || standardsStatus === 'draft')
      && !(source.status === 'draft' || Extensions.readString(source, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status') === 'draft')) {
      this._addParam(exp, 'warning-draft', 'valueUri', vurl);
    }
  }

  // ── Output assembly ──────────────────────────────────────────────────────────

  _assembleOutput(result, exp, notClosed, table, div_, source) {
    let list;

    if (notClosed.value) {
      if (!Extensions.has(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed')) {
        Extensions.addBoolean(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed', true);
      }
      if (this.totalStatus === 'set' && this.total > -1) exp.total = this.total;
      list = this.fullList;
      for (const c of this.fullList) c.contains = undefined;
      if (div_) {
        div_.addTag('p').setAttribute('style', 'color: Navy')
          .tx('Because of the way that this value set is defined, not all the possible codes can be listed in advance');
      }
    } else {
      if (this.totalStatus === 'off' || this.total === -1) {
        this.canBeHierarchy = false;
      } else if (this.total > 0) {
        exp.total = this.total;
      } else {
        exp.total = this.fullList.length;
      }

      if (this.canBeHierarchy && (this.count < 0 || this.count > this.fullList.length)) {
        list = this.rootList;
      } else {
        list = this.fullList;
        for (const c of this.fullList) c.contains = undefined;
      }
    }

    // Apply pagination
    if (this.offset + this.count < 0 && this.fullList.length > this.limitCount) {
      throw new Issue('error', 'too-costly', null, 'VALUESET_TOO_COSTLY',
        this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages,
          [source.vurl, '>' + this.limitCount]), null, 422)
        .withDiagnostics(this.worker.opContext.diagnostics());
    }

    let t = 0, o = 0;
    for (const c of list) {
      this.worker.deadCheck('assembleOutput');
      const key = makeKey(c.system, c.version, c.code, this.doingVersion);
      if (this.map.has(key)) {
        o++;
        if (o > this.offset && (this.count < 0 || t < this.count)) {
          t++;
          exp.contains = exp.contains || [];
          exp.contains.push(c);
          if (table) {
            const tr = table.tr();
            tr.td().tx(c.system);
            tr.td().tx(c.code);
            tr.td().tx(c.display);
          }
        }
      }
    }
  }
}

// ── ExpandWorker ───────────────────────────────────────────────────────────────
// HTTP handler layer. Parses requests, manages caching, delegates to ValueSetExpander.

class ExpandWorker extends TerminologyWorker {
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
  }

  opName() { return 'expand'; }

  // ── HTTP handlers ────────────────────────────────────────────────────────────

  async handle(req, res) {
    try {
      await this._handleTypeLevelExpand(req, res);
    } catch (error) {
      req.logInfo = this.usedSources.join('|') + ' - error' + (error.msgId ? ' ' + error.msgId : '');
      this.log.error(error);
      if (error instanceof Issue) {
        const oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      }
      return res.status(error.statusCode || 500).json(this._operationOutcome('error', error.issueCode || 'exception', error.message));
    }
  }

  async handleInstance(req, res) {
    try {
      await this._handleInstanceLevelExpand(req, res);
    } catch (error) {
      req.logInfo = this.usedSources.join('|') + ' - error' + (error.msgId ? ' ' + error.msgId : '');
      this.log.error(error);
      return res.status(error.statusCode || 500).json(
        this._operationOutcome('error', error.issueCode || 'exception', error.message));
    }
  }

  // ── Type-level: /ValueSet/$expand ────────────────────────────────────────────

  async _handleTypeLevelExpand(req, res) {
    this.deadCheck('expand-type-level');

    let valueSet = null;
    let params = null;

    if (req.method === 'POST' && req.body) {
      if (req.body.resourceType === 'ValueSet') {
        valueSet = new ValueSet(req.body);
        params = this.queryToParameters(req.query);
        this.seeSourceVS(valueSet);
      } else if (req.body.resourceType === 'Parameters') {
        params = req.body;
        const vsParam = this.findParameter(params, 'valueSet');
        if (vsParam?.resource) {
          valueSet = new ValueSet(vsParam.resource);
          this.seeSourceVS(valueSet);
        }
      } else {
        params = this.formToParameters(req.body, req.query);
      }
    } else {
      params = this.queryToParameters(req.query);
    }
    this.addHttpParams(req, params);

    if (this.findParameter(params, 'context')) {
      return res.status(400).json(this._operationOutcome('error', 'not-supported', 'The context parameter is not yet supported'));
    }

    this.setupAdditionalResources(params);
    const logExtraOutput = this.findParameter(params, 'logExtraOutput');

    const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n, false);
    txp.readParams(params);

    if (!valueSet) {
      const urlParam = this.findParameter(params, 'url');
      const versionParam = this.findParameter(params, 'valueSetVersion');

      if (!urlParam) {
        return res.status(400).json(this._operationOutcome('error', 'invalid', 'Must provide either a ValueSet resource or a url parameter'));
      }

      const url = this.getParameterValue(urlParam);
      const version = versionParam ? this.getParameterValue(versionParam) : null;

      valueSet = await this.findValueSet(url, version);
      this.seeSourceVS(valueSet, url);
      if (!valueSet) {
        return res.status(422).json(this._operationOutcome('error', 'not-found',
          version ? `ValueSet not found: ${url} version ${version}` : `ValueSet not found: ${url}`));
      }
    }

    const result = await this._doExpand(valueSet, txp, logExtraOutput);
    req.logInfo = this.usedSources.join('|') + txp.logInfo();
    return res.json(result);
  }

  // ── Instance-level: /ValueSet/{id}/$expand ───────────────────────────────────

  async _handleInstanceLevelExpand(req, res) {
    this.deadCheck('expand-instance-level');

    const { id } = req.params;
    const valueSet = await this.provider.getValueSetById(this.opContext, id);
    if (!valueSet) {
      return res.status(422).json(this._operationOutcome('error', 'not-found', `ValueSet/${id} not found`));
    }

    let params;
    if (req.method === 'POST' && req.body) {
      params = req.body.resourceType === 'Parameters' ? req.body : this.formToParameters(req.body, req.query);
    } else {
      params = this.queryToParameters(req.query);
    }

    if (this.findParameter(params, 'context')) {
      return res.status(400).json(this._operationOutcome('error', 'not-supported', 'The context parameter is not yet supported'));
    }

    this.setupAdditionalResources(params);
    const logExtraOutput = this.findParameter(params, 'logExtraOutput');

    const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n, false);
    txp.readParams(params);

    const result = await this._doExpand(valueSet, txp, logExtraOutput);
    req.logInfo = this.usedSources.join('|') + txp.logInfo();
    return res.json(result);
  }

  // ── Expansion with caching ───────────────────────────────────────────────────

  async _doExpand(valueSet, params, logExtraOutput) {
    this.deadCheck('doExpand');

    const cache = this.opContext.expansionCache;
    let cacheKey = null;
    if (cache && (CACHE_WHEN_DEBUGGING || !this.opContext.debugging)) {
      cacheKey = cache.computeKey(valueSet, params, this.additionalResources);
      const cached = cache.get(cacheKey);
      if (cached) {
        this.log.debug('Using cached expansion');
        return cached;
      }
    }

    const start = performance.now();
    const result = await this._performExpansion(valueSet, params, logExtraOutput);
    const durationMs = performance.now() - start;

    if (cacheKey && cache && (CACHE_WHEN_DEBUGGING || !this.opContext.debugging)) {
      if (cache.set(cacheKey, result, durationMs)) {
        this.log.debug(`Cached expansion (took ${Math.round(durationMs)}ms)`);
      }
    }

    return result;
  }

  async _performExpansion(valueSet, params, logExtraOutput) {
    this.deadCheck('performExpansion');
    this.params = params;

    if (params.limit < -1) params.limit = -1;
    else if (params.limit > UPPER_LIMIT_TEXT) params.limit = UPPER_LIMIT_TEXT;

    const filter = new SearchFilterText(params.filter);
    const expander = new ValueSetExpander(this, params);
    expander.logExtraOutput = logExtraOutput;
    return expander.expand(valueSet, filter);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _operationOutcome(severity, code, message) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{ severity, code, diagnostics: message }],
    };
  }
}

module.exports = {
  ExpandWorker,
  ValueSetExpander,
  ImportedValueSet,
  UPPER_LIMIT_NO_TEXT,
  UPPER_LIMIT_TEXT,
  INTERNAL_LIMIT,
  EXPANSION_DEAD_TIME_SECS,
};
