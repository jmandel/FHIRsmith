'use strict';

/**
 * ExpandWorkerV3 / ValueSetExpanderV3
 *
 * This file is intentionally self-contained. It plugs into the existing worker/provider
 * ecosystem via:
 *   - worker.findValueSet(url, version)
 *   - worker.findCodeSystem(system, version, params, ...)
 *
 * If your codebase already has TerminologyWorker + TxParameters, you can adapt this file
 * to match your request plumbing.
 */

const { buildIRFromValueSet } = require('./engine/build-ir');
const { resolveImports } = require('./engine/resolve-imports');
const rewrite = require('./engine/rewrite');
const { executeExpandV3 } = require('./engine/exec');
const { readExpandOptimizationPolicy } = require('./engine/optimization-policy');
const { EngineRegistryV3 } = require('./providers/engine-registry');
const { Extensions } = require('../../../library/extensions');
const { Designations } = require('../../../library/designations');
const { getValuePrimitive } = require('../../../../library/utilities');
const { Issue } = require('../../../library/operation-outcome');
const { trace: T } = require('../../expand-trace');
const {
  normalizeDesignationRows,
  parseDesignationFilters,
  filterDesignationsByRequest,
  suppressRedundantDesignations,
  dedupeProperties,
} = require('./fhir/contains-renderer-helpers');
const crypto = require('crypto');

const SUPPLEMENT_EXT_URL = 'http://hl7.org/fhir/StructureDefinition/valueset-supplement';
const STD_STATUS_EXT_URL = 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status';
const ITEM_WEIGHT_EXT_URL = 'http://hl7.org/fhir/StructureDefinition/itemWeight';
const LARGE_SQLITE_SYSTEMS = new Set([
  'http://snomed.info/sct',
  'http://loinc.org',
  'http://www.nlm.nih.gov/research/umls/rxnorm',
]);

/**
 * Very small text filter helper. Compatible with the engine's expectations:
 * - .filter (raw string)
 * - .passes(str) -> boolean
 */
class SimpleTextFilter {
  constructor(filter) {
    this.filter = String(filter || '').trim();
    this._needle = this.filter.toLowerCase();
  }
  passes(str) {
    if (!this._needle) return true;
    if (str == null) return false;
    return String(str).toLowerCase().includes(this._needle);
  }
}

/**
 * ValueSetExpanderV3: core service class.
 *
 * You can use it directly in tests or wire it into your existing `$expand` route.
 */
class ValueSetExpanderV3 {
  constructor(worker, opts = {}) {
    this.worker = worker;
    this.opts = opts;
  }

  /**
   * Expand a ValueSet resource (or wrapper with .jsonObj) given parsed params.
   *
   * params is expected to have at least:
   * - offset (number)
   * - count (number)
   * - filter (string)
   * - activeOnly (boolean)
   * - doingVersion (boolean)  (or includeVersion)
   * - excludeNotForUI (boolean)
   * - supplements (array of urls) (optional)
   * - expandOptimizationProfile (default|baseline|no-pushdown|no-membership|no-decorate-many)
   * - disablePushdown / disableMembership / disableDecorateMany (optional booleans)
   */
  async expand(valueSet, params, ctx = {}) {
    const vsJson = valueSet?.jsonObj || valueSet;
    if (!vsJson) throw new Error('ValueSet is required');

    // 1) Build semantic IR
    let expr = buildIRFromValueSet(vsJson);
    if (T.active) T.note('v3.buildIR', { kind: expr.kind });

    // 2) Resolve imports via worker.findValueSet()
    const importedValueSets = collectImportRefs(expr);
    const importCache = new Map();
    const spanResolve = T.active ? T.begin('v3.resolveImports', { importCount: importedValueSets.length }) : null;
    expr = await resolveImports(expr, async (url, version) => {
      if (typeof this.worker.findValueSet !== 'function') throw new Error('worker.findValueSet is required for imports');
      const vs = await this.worker.findValueSet(url, version);
      return vs?.jsonObj || vs;
    }, { cache: importCache, maxDepth: 30, preferComposeOverExpansion: true });
    if (spanResolve) spanResolve.end({ resolvedCount: importCache.size });

    // 3) Rewrite (flatten + selector coalescing)
    expr = rewrite.optimize(expr);
    if (T.active) T.note('v3.rewrite', { kind: expr.kind });

    // 4) Engine registry (providers)
    const requiredSupplements = new Set(params?.supplements || []);
    for (const ext of Extensions.list(vsJson, SUPPLEMENT_EXT_URL)) {
      const s = getValuePrimitive(ext);
      if (s) requiredSupplements.add(String(s));
    }
    const usedSupplements = new Set();
    const providerParams = params?.providerParams || params;
    const registry = new EngineRegistryV3(this.worker, providerParams, { requiredSupplements, usedSupplements });
    try {
      const spanPreflight = T.active ? T.begin('v3.preflight') : null;
      const preflight = await this._collectCodeSystemMetadata(expr, registry, vsJson);
      if (spanPreflight) spanPreflight.end({ systems: preflight.usedSystems.length });

      // 5) Execute membership (paging-safe)
      const textFilter = params?.filter ? new SimpleTextFilter(params.filter) : null;
      const count = Number.isInteger(params?.count) ? params.count : -1;
      const needTotal = params?.needTotal === true || count === 0;
      const hasLargeSystems = preflight.usedSystems.some(s => LARGE_SQLITE_SYSTEMS.has(s));
      const optimization = readExpandOptimizationPolicy(params);
      const execCtx = {
        offset: Number.isInteger(params?.offset) ? params.offset : 0,
        count,
        needTotal,
        useVersion: !!(params?.doingVersion || params?.includeVersion),
        activeOnly: !!params?.activeOnly,
        excludeNotForUI: !!params?.excludeNotForUI,
        textFilter,
        allAltCodes: ctx?.allAltCodes || null,
        batchSize: 512,
        filterPageSize: 256,
        limitCount: Number.isInteger(params?.limit) && params.limit > 0 ? params.limit : 0,
        continueAfterPage: (count === 0) || (needTotal && count > 0 && !hasLargeSystems),
        disablePushdown: optimization.disablePushdown,
        disableMembership: optimization.disableMembership,
        disableDecorateMany: optimization.disableDecorateMany,
      };

      const spanExec = T.active ? T.begin('v3.execute', { count, offset: execCtx.offset }) : null;
      const membership = await executeExpandV3(expr, registry, execCtx);
      if (spanExec) spanExec.end({ scanned: membership.stats?.scanned, returned: membership.page?.length });

      // 6) Decorate page and build FHIR expansion output
      const spanDecorate = T.active ? T.begin('v3.decorate', { pageSize: membership.page?.length }) : null;
      const contains = await this._decorateToContains(membership.page, registry, execCtx, params);
      if (spanDecorate) spanDecorate.end({ containsCount: contains.length });

      const out = cloneValueSetForReturn(vsJson);
      out.expansion = out.expansion || {};
      out.expansion.timestamp = new Date().toISOString();
      out.expansion.identifier = `urn:uuid:${crypto.randomUUID()}`;
      out.expansion.contains = contains;
      if (Number.isInteger(params?.offset)) {
        out.expansion.offset = params.offset;
        this._addParam(out.expansion, 'offset', 'valueInteger', params.offset);
      }
      if (Number.isInteger(params?.count)) {
        this._addParam(out.expansion, 'count', 'valueInteger', params.count);
      }
      if (params?.filter) {
        this._addParam(out.expansion, 'filter', 'valueString', String(params.filter));
      }
      for (const d of params?.designations || []) {
        const v = String(d || '').trim();
        if (v) this._addParam(out.expansion, 'designation', 'valueString', v);
      }
      for (const cs of preflight.usedCodeSystems) {
        this._addParam(out.expansion, 'used-codesystem', 'valueUri', cs);
      }
      for (const u of importedValueSets) {
        this._addParam(out.expansion, 'used-valueset', 'valueUri', u);
      }
      for (const u of importCache.keys()) {
        this._addParam(out.expansion, 'used-valueset', 'valueUri', String(u));
      }
      for (const p of preflight.warningParams) {
        this._addParam(out.expansion, p.name, 'valueUri', p.valueUri);
      }
      for (const s of usedSupplements) {
        this._addParam(out.expansion, 'used-supplement', 'valueUri', s);
      }
      if (membership.totalStatus === 'known' && typeof membership.total === 'number') out.expansion.total = membership.total;

      // Surface notClosed if present.
      if (membership.notClosed || preflight.notClosed) {
        out.expansion.extension = out.expansion.extension || [];
        out.expansion.extension.push({
          url: 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed',
          valueBoolean: true,
        });
      }

      // Optional debug stats extension (comment out if not wanted)
      if (this.opts.includeDebugStats) {
        out.expansion.extension = out.expansion.extension || [];
        out.expansion.extension.push({
          url: 'http://example.org/fhir/StructureDefinition/expand-v3-stats',
          valueString: JSON.stringify(membership.stats),
        });
      }

      const unused = [...requiredSupplements].filter(s => !usedSupplements.has(s));
      if (unused.length > 0) {
        throw new Issue('error', 'not-found', null, 'VALUESET_SUPPLEMENT_MISSING',
          `Required supplement not found: ${unused.join(', ')}`, 'not-found', 422);
      }
      return out;
    } finally {
      if (registry && typeof registry.close === 'function') {
        await registry.close();
      }
    }
  }

  async _collectCodeSystemMetadata(expr, registry, sourceVs) {
    const usedCodeSystems = new Set();
    const warningParams = [];
    const usedSystems = [];
    let notClosed = false;

    const systems = rewrite.collectSystems(expr);
    for (const { system, version } of systems.values()) {
      const adapter = await registry.getAdapter(system, version, 'include');
      const cs = adapter.cs;
      const csSystem = await cs.system();
      const csVersion = await cs.version();
      const vurl = canonical(csSystem, csVersion);
      usedCodeSystems.add(vurl);
      usedSystems.push(csSystem);

      const content = typeof cs.contentMode === 'function' ? cs.contentMode() : null;
      if (content && content !== 'complete') {
        notClosed = true;
      }

      const statusInfo = typeof cs.status === 'function' ? (cs.status() || {}) : {};
      addCanonicalStatusWarnings(warningParams, vurl, statusInfo, sourceVs);
    }

    return {
      usedCodeSystems: [...usedCodeSystems],
      warningParams,
      usedSystems,
      notClosed,
    };
  }

  async _decorateToContains(pageCandidates, registry, execCtx, params) {
    const out = [];
    const settings = this._buildDecorationSettings(params);
    const bySys = this._groupPageCandidatesBySystem(pageCandidates);

    for (const row of bySys.values()) {
      const decoratedRows = await this._decorateSystemCandidates(row, registry, execCtx, settings, params);
      out.push(...decoratedRows);
    }
    return out;
  }

  _buildDecorationSettings(params) {
    const requestedProps = Array.isArray(params?.properties)
      ? params.properties.map(p => String(p || '')).filter(Boolean)
      : [];
    const allProps = requestedProps.includes('*');
    return {
      includeDesignations: !!params?.includeDesignations,
      requestedProps,
      allProps,
      wantProps: allProps || requestedProps.length > 0,
      designationFilters: parseDesignationFilters(params?.designations || []),
    };
  }

  _groupPageCandidatesBySystem(pageCandidates) {
    const bySys = new Map();
    for (const cand of pageCandidates || []) {
      const key = cand?.key;
      if (!key?.system || !key?.code) continue;
      const k = makeSysVerKey(key.system, key.version);
      if (!bySys.has(k)) bySys.set(k, { system: key.system, version: key.version || null, cands: [] });
      bySys.get(k).cands.push(cand);
    }
    return bySys;
  }

  async _decorateSystemCandidates(row, registry, execCtx, settings, params) {
    const { system, version, cands } = row;
    const adapter = await registry.getAdapter(system, version, 'include');
    const cs = adapter.cs;
    const codes = cands.map(c => String(c?.key?.code || '')).filter(Boolean);
    const contextsByCode = this._buildContextMapByCode(cands);
    const canSkipDecorateMany = this._canSkipProviderDecorateMany(cands, settings, cs);
    const providerDecoratedByCode = canSkipDecorateMany
      ? null
      : await this._tryProviderDecorateMany(adapter, codes, contextsByCode, execCtx, settings, params);
    const supplementDecoratedByCode = await this._trySupplementDecorateMany(adapter, system, version, codes, settings);
    const decoratedByCode = this._mergeDecoratedMaps(providerDecoratedByCode, supplementDecoratedByCode);
    const needsContext = this._needsContextResolution(cands, decoratedByCode, settings, cs);
    const locatedMap = needsContext
      ? await this._tryBulkLocateMissing(cs, cands, execCtx.allAltCodes)
      : null;

    const out = [];
    for (const cand of cands) {
      const code = String(cand?.key?.code || '');
      if (!code) continue;
      const decorated = decoratedByCode?.get(code) || null;
      const context = needsContext
        ? await this._resolveCandidateContext(cand, decorated, locatedMap, cs, execCtx.allAltCodes)
        : null;
      const entry = await this._buildContainsEntry({
        system,
        version,
        code,
        cand,
        decorated,
        context,
        cs,
        execCtx,
        settings,
      });
      out.push(entry);
    }
    return out;
  }

  async _trySupplementDecorateMany(adapter, system, version, codes, settings) {
    const supplements = adapter?.supplements || null;
    if (!supplements || typeof supplements.decorateMany !== 'function') return null;
    if (!Array.isArray(codes) || codes.length === 0) return null;
    try {
      const rows = await supplements.decorateMany({
        system,
        version: version || null,
        codes,
        opts: {
          includeDesignations: settings.includeDesignations,
          properties: settings.requestedProps,
        },
      });
      return rows instanceof Map ? rows : null;
    } catch (_e) {
      return null;
    }
  }

  _mergeDecoratedMaps(primary, overlay) {
    if (!(primary instanceof Map) && !(overlay instanceof Map)) return null;
    const out = new Map();
    if (primary instanceof Map) {
      for (const [code, row] of primary.entries()) {
        if (!code || !row) continue;
        out.set(String(code), { ...row });
      }
    }
    if (overlay instanceof Map) {
      for (const [code, row] of overlay.entries()) {
        const key = String(code || '');
        if (!key || !row) continue;
        const existing = out.get(key) || { code: key };
        const incoming = row || {};
        // Keep provider/base display resolution as authoritative in v3.
        // Supplement overlays contribute designations/properties/definition.
        if (incoming.definition != null) existing.definition = incoming.definition;
        if (Array.isArray(incoming.designations) && incoming.designations.length > 0) {
          existing.designations = (existing.designations || []).concat(incoming.designations);
        }
        if (Array.isArray(incoming.properties) && incoming.properties.length > 0) {
          existing.properties = (existing.properties || []).concat(incoming.properties);
        }
        if (incoming.context != null && existing.context == null) {
          existing.context = incoming.context;
        }
        out.set(key, existing);
      }
    }
    return out;
  }

  _buildContextMapByCode(cands) {
    const map = new Map();
    for (const cand of cands || []) {
      const code = String(cand?.key?.code || '');
      if (!code || map.has(code) || !cand?.context) continue;
      map.set(code, cand.context);
    }
    return map;
  }

  _canSkipProviderDecorateMany(cands, settings, cs) {
    void cs;
    if (settings.includeDesignations || settings.wantProps) return false;
    for (const cand of cands || []) {
      const displayHint = cand?.displayHint;
      if (typeof displayHint !== 'string' || displayHint.length === 0) return false;
    }
    return true;
  }

  _needsContextResolution(cands, decoratedByCode, settings, cs) {
    const byCode = decoratedByCode || null;
    for (const cand of cands || []) {
      if (cand?.context) return true;
      const code = String(cand?.key?.code || '');
      const decorated = (byCode && code) ? byCode.get(code) : null;
      if (decorated?.context) return true;

      const displayHint = cand?.displayHint || decorated?.display || null;
      if (!displayHint) return true;

      if (settings.includeDesignations) {
        const hasConceptRefDesignations = Array.isArray(cand?.conceptRef?.designation) && cand.conceptRef.designation.length > 0;
        const hasDecoratedDesignations = Array.isArray(decorated?.designations) && decorated.designations.length > 0;
        if (!hasConceptRefDesignations && !hasDecoratedDesignations) return true;
      }

      if (settings.wantProps) {
        const hasDecoratedProps = Array.isArray(decorated?.properties) && decorated.properties.length > 0;
        if (!hasDecoratedProps) return true;
      }
    }
    return false;
  }

  async _tryProviderDecorateMany(adapter, codes, contextsByCode, execCtx, settings, params) {
    if (execCtx?.disableDecorateMany) return null;
    if (typeof adapter.decorateMany !== 'function' || codes.length === 0) return null;
    try {
      const decorated = await adapter.decorateMany(codes, {
        includeDesignations: settings.includeDesignations,
        properties: settings.requestedProps,
        allAltCodes: execCtx.allAltCodes,
        displayLanguages: params?.displayLanguages || null,
      }, contextsByCode);
      if (!Array.isArray(decorated)) return null;
      const byCode = new Map();
      for (const d of decorated) {
        const code = String(d?.code || '');
        if (!code || byCode.has(code)) continue;
        byCode.set(code, d);
      }
      return byCode;
    } catch (_e) {
      return null;
    }
  }

  async _tryBulkLocateMissing(cs, cands, allAltCodes) {
    const missingCodes = cands.filter(c => !c.context).map(c => c.key.code);
    if (!missingCodes.length || typeof cs.locateMany !== 'function') return null;
    try {
      return await cs.locateMany(missingCodes, allAltCodes);
    } catch (_e) {
      return null;
    }
  }

  async _resolveCandidateContext(cand, decorated, locatedMap, cs, allAltCodes) {
    let context = cand?.context || null;
    if (!context && decorated?.context) context = decorated.context;
    if (!context && locatedMap instanceof Map && locatedMap.get(cand.key.code)?.context) {
      context = locatedMap.get(cand.key.code).context;
    }
    if (!context && typeof cs.locate === 'function') {
      const located = await cs.locate(cand.key.code, allAltCodes);
      context = located?.context || null;
    }
    return context;
  }

  async _buildContainsEntry({ system, version, code, cand, decorated, context, cs, execCtx, settings }) {
    const entry = { system, code };
    if (execCtx.useVersion && version) entry.version = version;

    const display = await this._resolveEntryDisplay(cand, decorated, context, cs);
    entry.display = display || code;

    if (settings.includeDesignations) {
      const designations = await this._resolveEntryDesignations({
        cand, decorated, context, cs, display: entry.display, settings,
      });
      if (designations.length > 0) entry.designation = designations;
    }

    const entryProps = [];
    if (settings.wantProps) {
      const props = await this._resolveEntryProperties({
        decorated, context, cs, settings,
      });
      entryProps.push(...props);
    }
    const weightProp = await this._resolveItemWeightProperty(cand, decorated, context, cs);
    if (weightProp) entryProps.push(weightProp);

    const dedupedProps = dedupeProperties(entryProps);
    if (dedupedProps.length > 0) entry.property = dedupedProps;

    return entry;
  }

  async _resolveEntryDisplay(cand, decorated, context, cs) {
    let display = cand?.displayHint || decorated?.display || null;
    if (!display && context && typeof cs.display === 'function') {
      try { display = await cs.display(context); } catch (_e) { display = null; }
    }
    return display;
  }

  async _resolveEntryDesignations({ cand, decorated, context, cs, display, settings }) {
    let designations = normalizeDesignationRows(decorated?.designations);
    if (Array.isArray(cand?.conceptRef?.designation) && cand.conceptRef.designation.length > 0) {
      designations.push(...normalizeDesignationRows(cand.conceptRef.designation));
    }
    if (designations.length === 0 && context && typeof cs.designations === 'function') {
      try {
        const collector = new Designations(this.worker.languages);
        await cs.designations(context, collector);
        designations = normalizeDesignationRows(collector.designations);
      } catch (_e) {
        designations = [];
      }
    }
    designations = filterDesignationsByRequest(designations, settings.designationFilters);
    designations = suppressRedundantDesignations(designations, display);
    return designations;
  }

  async _resolveEntryProperties({ decorated, context, cs, settings }) {
    let props = Array.isArray(decorated?.properties) ? [...decorated.properties] : [];
    if (props.length === 0 && context && typeof cs.properties === 'function') {
      try { props = await cs.properties(context) || []; } catch (_e) { props = []; }
    }

    if (settings.requestedProps.includes('definition')) {
      const hasDef = props.some(p => p && p.code === 'definition');
      if (!hasDef) {
        let def = null;
        if (decorated?.definition) def = decorated.definition;
        else if (context && typeof cs.definition === 'function') {
          try { def = await cs.definition(context); } catch (_e) { def = null; }
        }
        if (def) props.push({ code: 'definition', valueString: String(def) });
      }
    }

    if (!settings.allProps) {
      const allowed = new Set(settings.requestedProps);
      props = props.filter(p => p && allowed.has(String(p.code || '')));
    }
    return props;
  }

  async _resolveItemWeightProperty(cand, decorated, context, cs) {
    let itemWeight = Extensions.readNumber(cand?.conceptRef?.extension || [], ITEM_WEIGHT_EXT_URL, undefined);
    if (itemWeight == null && Array.isArray(decorated?.properties)) {
      const p = decorated.properties.find(x => x?.code === 'weight');
      if (p?.valueDecimal != null) itemWeight = Number(p.valueDecimal);
      else if (p?.valueInteger != null) itemWeight = Number(p.valueInteger);
      else if (p?.valueString != null) itemWeight = Number(p.valueString);
    }
    if (itemWeight == null && context && cs && typeof cs.itemWeight === 'function') {
      try {
        const w = await cs.itemWeight(context);
        if (w != null && w !== '') itemWeight = Number(w);
      } catch (_e) {
        // ignore and continue
      }
    }
    if (itemWeight == null) return null;

    const n = Number(itemWeight);
    if (Number.isFinite(n)) return { code: 'weight', valueDecimal: n };
    return { code: 'weight', valueString: String(itemWeight) };
  }

  _addParam(expansion, name, valueName, value) {
    if (!expansion) return;
    expansion.parameter = expansion.parameter || [];
    const exists = expansion.parameter.some(p => p.name === name && getValuePrimitive(p) === value);
    if (exists) return;
    const p = { name };
    p[valueName] = value;
    expansion.parameter.push(p);
  }
}

class ValueSetExpanderCompatV3 {
  constructor(worker, txParams, opts = {}) {
    this.worker = worker;
    this.txParams = txParams;
    this.v3 = new ValueSetExpanderV3(worker, opts);
  }

  async expand(valueSet, searchFilter, _noCacheThisOne) {
    const params = normalizeLegacyExpandParams(this.txParams, searchFilter);
    return this.v3.expand(valueSet, params, {});
  }
}

/**
 * ExpandWorkerV3: optional wrapper that matches the legacy worker shape.
 *
 * You can remove this class if your routing layer calls ValueSetExpanderV3 directly.
 */
class ExpandWorkerV3 {
  constructor(worker, opts = {}) {
    this.worker = worker;
    this.expander = new ValueSetExpanderV3(worker, opts);
  }

  async expand(valueSet, params, ctx) {
    return this.expander.expand(valueSet, params, ctx);
  }
}

function cloneValueSetForReturn(vsJson) {
  // Avoid mutating the original resource.
  const out = JSON.parse(JSON.stringify(vsJson));
  // Spec allows expansion on the returned ValueSet; keep compose intact.
  return out;
}

function normalizeLegacyExpandParams(txp, searchFilter) {
  const supplements = txp?.supplements
    ? (txp.supplements instanceof Set ? [...txp.supplements] : Array.from(txp.supplements))
    : [];
  const sf = searchFilter && !searchFilter.isNull ? String(searchFilter.filter || '') : null;
  return {
    offset: Number.isInteger(txp?.offset) ? txp.offset : 0,
    count: Number.isInteger(txp?.count) ? txp.count : -1,
    needTotal: !!txp?.needTotal,
    filter: sf || (txp?.filter ? String(txp.filter) : null),
    activeOnly: !!txp?.activeOnly,
    excludeNotForUI: !!txp?.excludeNotForUI,
    includeVersion: !!txp?.includeVersion,
    includeDesignations: !!txp?.includeDesignations,
    properties: Array.isArray(txp?.properties) ? [...txp.properties] : [],
    designations: Array.isArray(txp?.designations) ? [...txp.designations] : [],
    displayLanguages: txp?.workingLanguages ? txp.workingLanguages() : null,
    supplements,
    limit: Number.isInteger(txp?.limit) ? txp.limit : 0,
    providerParams: txp || null,
  };
}

function makeSysVerKey(system, version) {
  return JSON.stringify([String(system || ''), version || null]);
}

module.exports = {
  ValueSetExpander: ValueSetExpanderCompatV3,
  ValueSetExpanderCompatV3,
  ExpandWorkerV3,
  ValueSetExpanderV3,
  SimpleTextFilter,
};

function collectImportRefs(expr, out = new Set()) {
  if (!expr || typeof expr !== 'object') return out;
  switch (expr.kind) {
  case 'import': {
    const url = String(expr.url || '');
    if (url) {
      const v = expr.version ? `${url}|${expr.version}` : url;
      out.add(v);
    }
    if (expr.resolved) collectImportRefs(expr.resolved, out);
    break;
  }
  case 'union':
  case 'intersect':
    for (const it of expr.items || []) collectImportRefs(it, out);
    break;
  case 'diff':
    collectImportRefs(expr.left, out);
    collectImportRefs(expr.right, out);
    break;
  default:
    break;
  }
  return out;
}

function canonical(system, version) {
  const s = String(system || '');
  if (!s) return s;
  return version ? `${s}|${version}` : s;
}

function addCanonicalStatusWarnings(out, vurl, info, source) {
  const status = info?.status || null;
  const standardsStatus = info?.standardsStatus || null;
  const experimental = !!info?.experimental;
  const srcStatus = source?.status || null;
  const srcStdStatus = Extensions.readString(source, STD_STATUS_EXT_URL);

  if (standardsStatus === 'deprecated') out.push({ name: 'warning-deprecated', valueUri: vurl });
  else if (standardsStatus === 'withdrawn') out.push({ name: 'warning-withdrawn', valueUri: vurl });
  else if (status === 'retired') out.push({ name: 'warning-retired', valueUri: vurl });
  else if (experimental && !source?.experimental) out.push({ name: 'warning-experimental', valueUri: vurl });
  else if ((status === 'draft' || standardsStatus === 'draft') && !(srcStatus === 'draft' || srcStdStatus === 'draft')) {
    out.push({ name: 'warning-draft', valueUri: vurl });
  }
}
