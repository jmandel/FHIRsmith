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
 *   Layer 2 – executeIR() for the IR engine, when the IR compiler is present
 *
 * Loaded via the `sqlite-v0:` source type in library.js.
 */

const path = require('path');
const { CodeSystem, CodeSystemContentMode } = require('../library/codesystem');
const { CodeSystemFactoryProvider, FilterExecutionContext } = require('./cs-api');
const { BaseCSServices } = require('./cs-base');
const { DesignationUse } = require('../library/designations');
const { VersionUtilities } = require('../../library/version-utilities');
const { supportsFilterClause } = require('./sqlite-v0-clause-lowering');
const { bindNativeSupplements, mergeSupplementPropertyDefinitions } = require('./sqlite-v0-supplements');
const { clearSqliteProgressLimit, openSqliteV0Database } = require('./sqlite-v0-runtime');

let trace;
try {
  trace = require('../engine/expand-trace').trace;
} catch {
  trace = {
    begin() { return { end() {} }; },
    note() {},
    sql() {},
  };
}

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
  const tokens = String(text || '').match(/[0-9A-Za-z]+/g) || [];
  if (tokens.length === 0) {
    return `"${String(text || '').replace(/"/g, '""')}"`;
  }
  return tokens
    .map(token => `${token.toLowerCase()}*`)
    .join(' OR ');
}

function typedLiteralProperty(code, row, propDef) {
  const sourceType = String(propDef?.source_type || '').trim().toLowerCase();
  if (sourceType === 'boolean' && row.value_bool != null) {
    return { code, valueBoolean: !!row.value_bool };
  }
  if (sourceType === 'integer' && row.value_num != null) {
    return { code, valueInteger: Number(row.value_num) };
  }
  if (sourceType === 'decimal' && row.value_num != null) {
    return { code, valueDecimal: Number(row.value_num) };
  }
  if (sourceType === 'code') {
    return { code, valueCode: row.value_text ?? row.value_raw ?? '' };
  }
  if (sourceType === 'uri') {
    return { code, valueUri: row.value_text ?? row.value_raw ?? '' };
  }
  if (sourceType === 'canonical') {
    return { code, valueCanonical: row.value_text ?? row.value_raw ?? '' };
  }
  if (sourceType === 'date') {
    return { code, valueDate: row.value_text ?? row.value_raw ?? '' };
  }
  if (sourceType === 'datetime') {
    return { code, valueDateTime: row.value_text ?? row.value_raw ?? '' };
  }
  return { code, valueString: row.value_text ?? row.value_raw ?? (row.value_num != null ? String(row.value_num) : '') };
}

function propertyDefinitionType(propDef) {
  if (propDef?.value_kind === 'concept') return 'code';
  const sourceType = String(propDef?.source_type || '').trim().toLowerCase();
  switch (sourceType) {
    case 'boolean':
      return 'boolean';
    case 'integer':
      return 'integer';
    case 'decimal':
      return 'decimal';
    case 'code':
      return 'code';
    case 'uri':
      return 'uri';
    case 'canonical':
      return 'canonical';
    case 'date':
      return 'date';
    case 'datetime':
      return 'dateTime';
    default:
      return 'string';
  }
}

function sanitizeName(system) {
  return (system || 'CS').replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'CS';
}

function openV0Database(dbPath, opts = {}) {
  return openSqliteV0Database(dbPath, opts);
}

function sqliteV0VersionToken(meta) {
  const baseUri = meta?.baseUri || '';
  const canonicalUri = meta?.canonicalUri || '';
  if (canonicalUri) {
  // v0 DBs may store canonical_uri either as "system|version"
  // or as a canonical version URI with an embedded release date.
    const prefix = `${baseUri}|`;
    if (prefix !== '|' && canonicalUri.startsWith(prefix)) {
      return canonicalUri.slice(prefix.length);
    }
    return canonicalUri;
  }
  return meta?.version || null;
}

function normalizeIsoDate(raw) {
  const v = String(raw || '').trim();
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1800 || y > 2400 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function digitsDateToIso(raw) {
  const v = String(raw || '').trim();
  if (!/^\d{8}$/.test(v)) return null;
  const y = Number(v.slice(0, 4));
  const mo = Number(v.slice(4, 6));
  const d = Number(v.slice(6, 8));
  if (y < 1800 || y > 2400 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

function mmddyyyyToIso(raw) {
  const v = String(raw || '').trim();
  if (!/^\d{8}$/.test(v)) return null;
  const mo = Number(v.slice(0, 2));
  const d = Number(v.slice(2, 4));
  const y = Number(v.slice(4, 8));
  if (y < 1800 || y > 2400 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${v.slice(4, 8)}-${v.slice(0, 2)}-${v.slice(2, 4)}`;
}

function normalizeInlineTotal(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeSqliteSupplementSources(sources, dbPath) {
  const baseDir = dbPath ? path.dirname(dbPath) : process.cwd();
  const out = [];
  for (const source of sources || []) {
    if (!source) continue;
    if (typeof source === 'string') {
      out.push(path.isAbsolute(source) ? source : path.resolve(baseDir, source));
      continue;
    }
    if (typeof source === 'object' && source.dbPath) {
      out.push({
        ...source,
        dbPath: path.isAbsolute(source.dbPath) ? source.dbPath : path.resolve(baseDir, source.dbPath),
      });
    }
  }
  return out;
}

function extractReleaseDate(meta) {
  const explicit = normalizeIsoDate(meta?.releaseDate)
    || digitsDateToIso(meta?.releaseDate)
    || mmddyyyyToIso(meta?.releaseDate);
  if (explicit) return explicit;

  const canonical = String(meta?.canonicalUri || '');
  const version = String(meta?.version || '');

  const snomed = canonical.match(/\/version\/(\d{8})(?:$|[/?#])/);
  if (snomed) {
    const iso = digitsDateToIso(snomed[1]);
    if (iso) return iso;
  }

  // Generic 8-digit date token from version.
  // Prefer YYYYMMDD; fallback to MMDDYYYY when needed.
  const eight = version.match(/(\d{8})/);
  if (eight) {
    const iso = digitsDateToIso(eight[1]) || mmddyyyyToIso(eight[1]);
    if (iso) return iso;
  }

  // ISO date token in version string.
  const isoToken = version.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoToken) {
    const iso = normalizeIsoDate(isoToken[1]);
    if (iso) return iso;
  }

  return null;
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
  #compiler = null;
  #options;
  #nativeSupplementBindings = [];
  #nativeSupplementAttachmentState = new Map();
  #supplementSignature = '';
  #reachabilityEstimateCache = new Map();
  _irSupplementSet = null;
  _irAllSupplementsNativeBound = false;

  constructor(opContext, supplements, db, meta, runtime, propDefs, options = {}) {
    super(opContext, supplements);
    this.#db = db;
    this.#meta = meta;
    this.#runtime = {
      ...runtime,
      planner: {
        ...(runtime?.planner || {}),
        estimateSingleSeedClosureCount: (code, includeSelf = true) =>
          this.#estimateSingleSeedClosureCount(code, includeSelf),
      },
    };
    this.#propDefs = propDefs;
    this.#closureOk = !!runtime.hierarchy?.closure?.enabled;
    this.#stmts = {};
    this.#options = options || {};
  }

  #estimateSingleSeedClosureCount(code, includeSelf = true) {
    const normalizedCode = String(code || '');
    const key = `${normalizedCode}|${includeSelf !== false ? 'self' : 'no-self'}`;
    if (this.#reachabilityEstimateCache.has(key)) {
      return this.#reachabilityEstimateCache.get(key);
    }
    const stmtKey = includeSelf === false ? 'estimateReachabilityCountNoSelf' : 'estimateReachabilityCount';
    const sql = includeSelf === false
      ? `SELECT COUNT(*) AS cnt
           FROM closure cl
           INNER JOIN concept seed ON seed.concept_id = cl.ancestor_id
          WHERE seed.cs_id = @cs
            AND seed.code = @code
            AND cl.descendant_id != cl.ancestor_id`
      : `SELECT COUNT(*) AS cnt
           FROM closure cl
           INNER JOIN concept seed ON seed.concept_id = cl.ancestor_id
          WHERE seed.cs_id = @cs
            AND seed.code = @code`;
    const count = this.#prep(stmtKey, sql).get({ cs: this.#meta.csId, code: normalizedCode }).cnt;
    this.#reachabilityEstimateCache.set(key, count);
    return count;
  }

  // ── metadata ─────────────────────────────────────────────────────

  system()      { return this.#meta.baseUri; }
  version() {
    return sqliteV0VersionToken(this.#meta);
  }
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

  hasSupplement(url) {
    if (super.hasSupplement(url)) return true;
    return (this._irSupplementSet?.items || []).some(item =>
      item?.descriptor?.canonical === url
      || item?.descriptor?.url === url
    );
  }

  listSupplements() {
    const out = new Set(super.listSupplements());
    for (const item of this._irSupplementSet?.items || []) {
      if (item?.descriptor?.canonical) out.add(item.descriptor.canonical);
      else if (item?.descriptor?.url) out.add(item.descriptor.url);
    }
    return Array.from(out);
  }

  async attachIRSupplements(supplementSet) {
    this._irSupplementSet = supplementSet || { items: [] };
    const { signature, bindings } = bindNativeSupplements(
      this.#db,
      supplementSet,
      this.#nativeSupplementAttachmentState
    );
    const requested = (supplementSet?.items || []).length;
    this._irAllSupplementsNativeBound = requested === 0 || bindings.length === requested;
    if (signature !== this.#supplementSignature) {
      this.#nativeSupplementBindings = bindings;
      this.#supplementSignature = signature;
      this.#compiler = null;
    }
    return this;
  }

  #irCompilerConfig() {
    const flags = this.#runtime?.behaviorFlags?.irCompiler || {};
    return {
      tracePlans: this.#options.traceIrCompilerPlans != null ? !!this.#options.traceIrCompilerPlans : !!flags.tracePlans,
    };
  }

  #compilerFor() {
    if (!this.#compiler) {
      const { createSqliteV0Compiler } = require('./sqlite-v0-compiler');
      const effectivePropDefs = this.#effectivePropDefs();
      this.#compiler = createSqliteV0Compiler({
        propertyDefs: effectivePropDefs,
        runtime: this.#runtime,
        scope: {
          csId: this.#meta.csId,
          system: this.#meta.baseUri,
          version: this.version(),
        },
        supplementBindings: this.#nativeSupplementBindings,
      });
    }
    return this.#compiler;
  }

  #effectivePropDefs() {
    if (!this.#nativeSupplementBindings.length) return this.#propDefs;
    return mergeSupplementPropertyDefinitions(this.#propDefs, this.#nativeSupplementBindings);
  }

  #traceCompiledArtifacts(label, compiled, cfg) {
    if (!cfg?.tracePlans || !compiled) return;
    const { formatMembershipPlan, formatPhysicalPlan, formatSqlAst, formatTerminalPlan } = require('./sqlite-v0-format-plan');
    trace.note(`${label}:compiler`, {
      scope: compiled.traceInfo?.scope || null,
      cache: compiled.traceInfo ? {
        baseCacheKey: compiled.traceInfo.baseCacheKey || null,
        baseCacheHit: !!compiled.traceInfo.baseCacheHit,
        selectedCacheKey: compiled.traceInfo.selectedCacheKey || null,
        selectedCacheHit: !!compiled.traceInfo.selectedCacheHit,
      } : null,
      base: formatMembershipPlan(compiled.base),
      selected: compiled.selected ? formatMembershipPlan(compiled.selected) : null,
      terminal: compiled.terminal ? formatTerminalPlan(compiled.terminal) : null,
      physical: formatPhysicalPlan(compiled.physical),
      sqlAst: formatSqlAst(compiled.sqlAst),
    });
  }

  #executeCompiledSql(compiled, label) {
    const tPrep = performance.now();
    const stmt = this.#db.prepare(compiled.sql.text);
    const prepMs = performance.now() - tPrep;
    const tExec = performance.now();
    const rows = stmt.all(compiled.sql.params);
    const execMs = performance.now() - tExec;
    trace.sql(compiled.sql.text, compiled.sql.params, rows.length, execMs, label);
    return { rows, prepMs, execMs };
  }

  #executeIRNew(subtree, opts = {}, cfg = null) {
    if (!subtree || subtree.kind === 'empty') return { candidates: [], total: 0 };
    if (opts.count === 0) return { candidates: [] };
    const compiler = this.#compilerFor();
    const span = trace.begin('executeIR:compiler', { system: this.#meta.baseUri });
    const compiled = compiler.compileExpand(subtree, {
      ...opts,
      includeDebugArtifacts: !!cfg?.tracePlans,
    });
    this.#traceCompiledArtifacts('executeIR', compiled, cfg);
    const { rows, prepMs, execMs } = this.#executeCompiledSql(compiled, 'executeIR');
    trace.note('executeIR:breakdown', { prepMs: +prepMs.toFixed(2), execMs: +execMs.toFixed(2) });
    const total = rows.length > 0
      ? normalizeInlineTotal(rows[0]?.total)
      : ((compiled.terminal?.includeTotal && (!Number.isInteger(opts.offset) || opts.offset <= 0)) ? 0 : null);
    const candidates = rows
      .filter(r => r.code != null)
      .map(r => ({
        code: r.code,
        display: this._displayFromSupplements(r.code) || r.display,
        definition: r.definition,
        active: !!r.active,
        conceptId: r.concept_id,
      }));
    span.end({ candidates: candidates.length, total });
    return { candidates, total, compiled };
  }

  #countIRNew(subtree, opts = {}, cfg = null) {
    if (!subtree || subtree.kind === 'empty') return { count: 0 };
    const compiler = this.#compilerFor();
    const span = trace.begin('countForIR:compiler', { system: this.#meta.baseUri });
    const compiled = compiler.compileCount(subtree, {
      ...opts,
      includeDebugArtifacts: !!cfg?.tracePlans,
    });
    this.#traceCompiledArtifacts('countForIR', compiled, cfg);
    const t0 = performance.now();
    const row = this.#db.prepare(compiled.sql.text).get(compiled.sql.params);
    const elapsedMs = performance.now() - t0;
    const count = row?.cnt ?? 0;
    trace.sql(compiled.sql.text, compiled.sql.params, count, elapsedMs, 'countForIR');
    span.end({ count });
    return { count, compiled };
  }

  #membershipIRNew(subtree, cfg = null) {
    if (!subtree || subtree.kind === 'empty') {
      return { has: () => false };
    }
    const compiler = this.#compilerFor();
    const compiled = compiler.compileProbe(subtree, '__probe__', {
      includeDebugArtifacts: !!cfg?.tracePlans,
    });
    this.#traceCompiledArtifacts('membershipForIR', compiled, cfg);
    const stmt = this.#db.prepare(compiled.sql.text);
    const probeKey = Object.keys(compiled.sql.params).find(k => k.startsWith('check_code_')) || 'check_code_0';
    return {
      has(code) {
        const result = stmt.get({ ...compiled.sql.params, [probeKey]: code });
        return !!result;
      }
    };
  }

  propertyDefinitions() {
    const defs = [];
    for (const [code, pd] of this.#effectivePropDefs()) {
      defs.push({
        code,
        type: propertyDefinitionType(pd),
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
    // Check configured statusProperty in concept_literal when present.
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

  async parents(context) {
    if (!this.#closureOk) return [];
    const ctx = await this.#ctx(context);
    const hierProp = this.#getHierarchyPropertyId();
    if (hierProp == null) return [];
    const rows = this.#prep('parents',
      `SELECT c2.code FROM concept_link cl
       JOIN concept c2 ON c2.concept_id = cl.target_concept_id
       WHERE cl.source_concept_id = @cid AND cl.property_id = @pid AND cl.active = 1
       ORDER BY c2.code`)
      .all({ cid: ctx.concept_id, pid: hierProp });
    return rows.map((row) => row.code);
  }

  #conceptIdBatchParams(prefix, ids) {
    const params = {};
    const placeholders = ids.map((id, index) => {
      const key = `${prefix}${index}`;
      params[key] = id;
      return `@${key}`;
    }).join(',');
    return { params, placeholders };
  }

  #nativeSupplementDesignationRowsForConceptIds(conceptIds) {
    if (!this.#nativeSupplementBindings.length || !conceptIds?.length) return [];
    const rows = [];
    const batchSize = 500;
    for (let i = 0; i < conceptIds.length; i += batchSize) {
      const batch = conceptIds.slice(i, i + batchSize);
      const { params, placeholders } = this.#conceptIdBatchParams('sid', batch);
      for (const binding of this.#nativeSupplementBindings) {
        rows.push(...this.#db.prepare(`
          SELECT c.concept_id, sd.language_code, sd.use_system, sd.use_code, sd.term, sd.active, sd.preferred
            FROM "${binding.alias}".supplement_designation sd
            JOIN concept c
              ON c.code = sd.source_code
           WHERE c.concept_id IN (${placeholders})
        `).all(params));
      }
    }
    return rows;
  }

  #nativeSupplementPropertyRowsForConceptIds(conceptIds) {
    if (!this.#nativeSupplementBindings.length || !conceptIds?.length) {
      return { links: [], literals: [] };
    }
    const links = [];
    const literals = [];
    const batchSize = 500;
    for (let i = 0; i < conceptIds.length; i += batchSize) {
      const batch = conceptIds.slice(i, i + batchSize);
      const { params, placeholders } = this.#conceptIdBatchParams('spid', batch);
      for (const binding of this.#nativeSupplementBindings) {
        links.push(...this.#db.prepare(`
          SELECT src.concept_id AS source_concept_id,
                 sl.property_code,
                 tgt.code AS target_code
            FROM "${binding.alias}".supplement_link sl
            JOIN concept src
              ON src.code = sl.source_code
            JOIN concept tgt
              ON tgt.code = sl.target_code
             AND tgt.cs_id = src.cs_id
           WHERE src.concept_id IN (${placeholders})
             AND (sl.target_system IS NULL OR sl.target_system = @system)
             AND sl.active = 1
        `).all({ ...params, system: this.system() }));
        literals.push(...this.#db.prepare(`
          SELECT src.concept_id AS source_concept_id,
                 sl.property_code,
                 sl.value_raw,
                 sl.value_text,
                 sl.value_num,
                 sl.value_bool
            FROM "${binding.alias}".supplement_literal sl
            JOIN concept src
              ON src.code = sl.source_code
           WHERE src.concept_id IN (${placeholders})
             AND sl.active = 1
        `).all(params));
      }
    }
    return { links, literals };
  }

  #nativeSupplementExtensionRowsForConceptIds(conceptIds) {
    if (!this.#nativeSupplementBindings.length || !conceptIds?.length) return [];
    const rows = [];
    const batchSize = 500;
    for (let i = 0; i < conceptIds.length; i += batchSize) {
      const batch = conceptIds.slice(i, i + batchSize);
      const { params, placeholders } = this.#conceptIdBatchParams('seid', batch);
      for (const binding of this.#nativeSupplementBindings) {
        rows.push(...this.#db.prepare(`
          SELECT c.concept_id, se.value_json
            FROM "${binding.alias}".supplement_extension se
            JOIN concept c
              ON c.code = se.source_code
           WHERE c.concept_id IN (${placeholders})
        `).all(params));
      }
    }
    return rows;
  }

  // ── designations ────────────────────────────────────────────────

  async designations(context, displays) {
    const ctx = await this.#ctx(context);
    const defaultLang = this.#runtime.languages?.default || 'en';

    // Get designations from DB first so we can avoid synthesizing a duplicate
    // preferredForLanguage designation when the same text already exists.
    const rows = this.#prep('designations',
      `SELECT language_code, use_code, term, active, preferred
       FROM designation WHERE concept_id = @cid`)
      .all({ cid: ctx.concept_id });

    const nativeSupplementRows = this.#nativeSupplementBindings.length > 0
      ? this.#nativeSupplementDesignationRowsForConceptIds([ctx.concept_id])
      : [];

    // Add primary display as a display designation
    if (ctx.display && !this.#hasEquivalentDisplayDesignation(ctx.code, ctx.display, defaultLang, rows, nativeSupplementRows)) {
      displays.addDesignation(true, 'active', defaultLang, null, ctx.display);
    }

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

    for (const row of nativeSupplementRows) {
      const use = row.use_system
        ? { system: row.use_system, code: row.use_code || null }
        : (row.use_code ? { system: this.system(), code: row.use_code } : null);
      displays.addDesignation(false, row.active ? 'active' : 'inactive', row.language_code, use, row.term);
    }
  }

  #hasEquivalentDisplayDesignation(code, display, defaultLang, rows, nativeSupplementRows) {
    const normalizedDisplay = String(display || '').trim();
    if (!normalizedDisplay) return false;

    const matchesDisplay = (language, term) => {
      if (String(term || '').trim() !== normalizedDisplay) return false;
      return !language || language === defaultLang;
    };

    if ((rows || []).some((row) => matchesDisplay(row.language_code, row.term))) {
      return true;
    }
    if ((nativeSupplementRows || []).some((row) => matchesDisplay(row.language_code, row.term))) {
      return true;
    }
    if (this.supplements) {
      for (const supplement of this.supplements) {
        const concept = supplement.getConceptByCode(code);
        if (!concept?.designation) continue;
        for (const designation of concept.designation) {
          if (matchesDisplay(designation.language, designation.value)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // ── properties ──────────────────────────────────────────────────

  async properties(context) {
    const ctx = await this.#ctx(context);
    const props = [];
    const effectivePropDefs = this.#effectivePropDefs();

    // Concept-valued properties (concept_link)
    const links = this.#prep('propLinks',
      `SELECT pd.property_code, c2.code AS target_code
       FROM concept_link cl
       JOIN property_def pd ON pd.property_id = cl.property_id
       JOIN concept c2 ON c2.concept_id = cl.target_concept_id
       WHERE cl.source_concept_id = @cid AND cl.active = 1`)
      .all({ cid: ctx.concept_id });
    for (const link of links) {
      props.push({
        code: link.property_code,
        valueCode: link.target_code,
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
      const property = typedLiteralProperty(
        lit.property_code,
        lit,
        effectivePropDefs.get(lit.property_code)
      );
      if (property) props.push(property);
    }

    if (this.supplements?.length > 0) {
      for (const supplement of this.supplements) {
        const concept = supplement.getConceptByCode(ctx.code);
        if (!concept) continue;
        for (const prop of concept.property || []) {
          props.push({ ...prop });
        }
      }
    }

    if (this.#nativeSupplementBindings.length > 0) {
      const suppRows = this.#nativeSupplementPropertyRowsForConceptIds([ctx.concept_id]);
      for (const link of suppRows.links) {
        props.push({
          code: link.property_code,
          valueCode: link.target_code,
        });
      }
      for (const lit of suppRows.literals) {
        const property = typedLiteralProperty(
          lit.property_code,
          lit,
          effectivePropDefs.get(lit.property_code)
        );
        if (property) props.push(property);
      }
    }

    return props;
  }

  async extensions(context) {
    const ctx = await this.#ctx(context);
    const result = [];
    if (this.supplements?.length > 0) {
      for (const supplement of this.supplements) {
        const concept = supplement.getConceptByCode(ctx.code);
        if (concept?.extension) {
          result.push(...concept.extension);
        }
      }
    }
    if (!this.#nativeSupplementBindings.length) return result.length > 0 ? result : null;
    const rows = this.#nativeSupplementExtensionRowsForConceptIds([ctx.concept_id]);
    for (const row of rows) {
      try {
        result.push(JSON.parse(row.value_json));
      } catch {
        // ignore malformed extension payloads in native supplements
      }
    }
    return result.length > 0 ? result : null;
  }

  async extendLookup(ctxt, props, params) {
    if (!this._hasProp(props, 'property', true)
      && !this._hasProp(props, 'parent', true)
      && !this._hasProp(props, 'child', true)) {
      return;
    }
    if (this._hasProp(props, 'property', true)) {
      const properties = await this.properties(ctxt);
      for (const property of properties || []) {
        const parts = [{ name: 'code', valueCode: property.code }];

        if (property.valueCoding) {
          parts.push({ name: 'value', valueCoding: property.valueCoding });
        } else if (property.valueCode != null) {
          parts.push({ name: 'value', valueCode: property.valueCode });
        } else if (property.valueString != null) {
          parts.push({ name: 'value', valueString: property.valueString });
        } else if (property.valueInteger != null) {
          parts.push({ name: 'value', valueInteger: property.valueInteger });
        } else if (property.valueDecimal != null) {
          parts.push({ name: 'value', valueDecimal: property.valueDecimal });
        } else if (property.valueBoolean != null) {
          parts.push({ name: 'value', valueBoolean: property.valueBoolean });
        } else if (property.valueDateTime) {
          parts.push({ name: 'value', valueDateTime: property.valueDateTime });
        } else if (property.valueDate) {
          parts.push({ name: 'value', valueDate: property.valueDate });
        } else if (property.valueUri) {
          parts.push({ name: 'value', valueUri: property.valueUri });
        } else if (property.valueCanonical) {
          parts.push({ name: 'value', valueCanonical: property.valueCanonical });
        } else if (property.value && typeof property.value === 'object' && property.value.code) {
          parts.push({
            name: 'value',
            valueCoding: {
              system: property.value.system || this.system(),
              code: property.value.code,
              ...(property.value.display ? { display: property.value.display } : {}),
            },
          });
        } else if (property.value != null) {
          parts.push({ name: 'value', valueString: String(property.value) });
        } else {
          continue;
        }

        params.push({ name: 'property', part: parts });
      }
    }

    if (this._hasProp(props, 'parent', true)) {
      const parentCodes = await this.parents(ctxt);
      for (const parentCode of parentCodes) {
        params.push({
          name: 'property',
          part: [
            { name: 'code', valueCode: 'parent' },
            { name: 'value', valueCode: parentCode },
            { name: 'description', valueString: await this.display(parentCode) },
          ],
        });
      }
    }

    if (this._hasProp(props, 'child', true)) {
      const iter = await this.iterator(ctxt);
      while (iter) {
        const child = await this.nextContext(iter);
        if (!child) break;
        const childCode = await this.code(child);
        if (!childCode) continue;
        params.push({
          name: 'property',
          part: [
            { name: 'code', valueCode: 'child' },
            { name: 'value', valueCode: childCode },
            { name: 'description', valueString: await this.display(child) },
          ],
        });
      }
    }
  }

  // ── filter protocol ─────────────────────────────────────────────

  async doesFilter(prop, op, value) {
    return supportsFilterClause({
      property: prop,
      op,
      value,
    }, this.#effectivePropDefs(), this.#runtime);
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
    const span = trace.begin('legacy:executeFilters', {
      system: this.#meta.baseUri,
      filterCount: filterContext?._v0?.filters?.length || 0,
      hasTextSearch: !!filterContext?._v0?.search,
    });
    let rowsForSpan = 0;
    try {
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

      const sqlStartedAt = performance.now();
      let rows = this.#db.prepare(sql).all(params);
      const sqlMs = performance.now() - sqlStartedAt;
      trace.sql(sql, params, rows.length, sqlMs, 'legacy:executeFilters');

      // Apply code regex filter (JS-side)
      if (codeRegex) {
        const regexStartedAt = performance.now();
        const before = rows.length;
        try {
          const re = new RegExp(codeRegex);
          rows = rows.filter(r => re.test(r.code));
        } catch (e) {
          throw new Error(`Invalid code regex '${codeRegex}': ${e.message}`);
        }
        trace.note('legacy:codeRegex', {
          pattern: codeRegex,
          before,
          after: rows.length,
          ms: Math.round((performance.now() - regexStartedAt) * 100) / 100,
        });
      }

      // Intersect with all code-set filters
      if (codeSetFilters.length > 0) {
        let allowed = new Set(codeSetFilters[0]);
        for (let i = 1; i < codeSetFilters.length; i++) {
          const next = new Set(codeSetFilters[i]);
          allowed = new Set([...allowed].filter(c => next.has(c)));
        }
        rows = rows.filter(r => allowed.has(r.code));
        trace.note('legacy:codeSetIntersection', {
          filters: codeSetFilters.length,
          after: rows.length,
        });
      }

      filterContext._v0.resultSet = new V0FilterSet(rows);
      rowsForSpan = rows.length;
      return [filterContext._v0.resultSet];
    } finally {
      span.end({ rows: rowsForSpan });
    }
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

    // Apply configured code-regex filter when present.
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

    const propDef = this.#effectivePropDefs().get(propCfg.propertyCode);
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
    if (propCfg.sources.includes('literal') && Number.isInteger(propCfg.propertyId)) {
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
    if (propCfg.sources.includes('link') && Number.isInteger(propCfg.propertyId)) {
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
    for (const code of this.#nativePropertyEqualsCodes(propCfg, candidates)) codeSet.add(code);
    return [...codeSet].sort();
  }

  /** Find codes matching property regex. */
  #propertyRegexCodes(propCfg, pattern) {
    let regex;
    try { regex = new RegExp(String(pattern || '')); }
    catch (e) { throw new Error(`Invalid regex '${pattern}': ${e.message}`); }
    const codeSet = new Set();
    if (propCfg.sources.includes('literal') && Number.isInteger(propCfg.propertyId)) {
      const rows = this.#db.prepare(
        `SELECT c.code, COALESCE(cl.value_text, cl.value_raw) AS value FROM concept_literal cl
         JOIN concept c ON c.concept_id = cl.source_concept_id
         WHERE cl.property_id = @pid AND cl.active = 1 AND c.cs_id = @cs AND COALESCE(cl.value_text, cl.value_raw) IS NOT NULL`
      ).all({ pid: propCfg.propertyId, cs: this.#meta.csId });
      for (const r of rows) if (regex.test(r.value)) codeSet.add(r.code);
    }
    if (propCfg.sources.includes('link') && Number.isInteger(propCfg.propertyId)) {
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
    for (const code of this.#nativePropertyRegexCodes(propCfg, regex)) codeSet.add(code);
    return [...codeSet].sort();
  }

  /** Find codes where property exists/not-exists. */
  #propertyExistsCodes(propCfg, value) {
    const expectExists = String(value ?? 'true').toLowerCase() !== 'false';
    const codeSet = new Set();
    if (propCfg.sources.includes('literal') && Number.isInteger(propCfg.propertyId)) {
      const rows = this.#db.prepare(
        `SELECT DISTINCT c.code FROM concept_literal cl JOIN concept c ON c.concept_id = cl.source_concept_id
         WHERE cl.property_id = @pid AND cl.active = 1 AND c.cs_id = @cs`
      ).all({ pid: propCfg.propertyId, cs: this.#meta.csId });
      for (const r of rows) codeSet.add(r.code);
    }
    if (propCfg.sources.includes('link') && Number.isInteger(propCfg.propertyId)) {
      const rows = this.#db.prepare(
        `SELECT DISTINCT src.code FROM concept_link l JOIN concept src ON src.concept_id = l.source_concept_id
         WHERE l.property_id = @pid AND l.active = 1 AND src.cs_id = @cs`
      ).all({ pid: propCfg.propertyId, cs: this.#meta.csId });
      for (const r of rows) codeSet.add(r.code);
    }
    for (const code of this.#nativePropertyExistsCodes(propCfg)) codeSet.add(code);
    if (expectExists) return [...codeSet].sort();
    // Invert: all codes minus those that have the property
    const all = this.#db.prepare('SELECT code FROM concept WHERE cs_id = @cs').all({ cs: this.#meta.csId });
    return all.map(r => r.code).filter(c => !codeSet.has(c)).sort();
  }

  #nativePropertyEqualsCodes(propCfg, candidates) {
    if (!this.#nativeSupplementBindings.length) return [];
    const codeSet = new Set();
    const normalized = candidates.map(v => String(v ?? '').trim()).filter(Boolean);
    if (normalized.length === 0) return [];
    const placeholders = normalized.map((_, i) => `@nv${i}`).join(',');
    for (const binding of this.#nativeSupplementBindings) {
      if (propCfg.sources.includes('literal')) {
        const rows = this.#db.prepare(
          `SELECT DISTINCT c.code
             FROM "${binding.alias}".supplement_literal sl
             JOIN concept c ON c.code = sl.source_code
            WHERE c.cs_id = @cs
              AND sl.property_code = @prop
              AND sl.active = 1
              AND COALESCE(
                sl.value_text,
                sl.value_raw,
                CASE WHEN sl.value_num IS NOT NULL THEN CAST(sl.value_num AS TEXT) ELSE NULL END,
                CASE WHEN sl.value_bool = 1 THEN 'true' WHEN sl.value_bool = 0 THEN 'false' ELSE NULL END
              ) COLLATE NOCASE IN (${placeholders})`
        ).all({
          cs: this.#meta.csId,
          prop: propCfg.propertyCode,
          ...Object.fromEntries(normalized.map((value, i) => [`nv${i}`, value])),
        });
        for (const row of rows) codeSet.add(row.code);
      }
      if (propCfg.sources.includes('link')) {
        let targetSql = `sl.target_code COLLATE NOCASE IN (${placeholders})`;
        if (propCfg.linkMatch === 'code-or-display') {
          targetSql += ` OR tgt.display COLLATE NOCASE IN (${placeholders})`;
        }
        const rows = this.#db.prepare(
          `SELECT DISTINCT src.code
             FROM "${binding.alias}".supplement_link sl
             JOIN concept src ON src.code = sl.source_code
             LEFT JOIN concept tgt ON tgt.code = sl.target_code AND tgt.cs_id = @cs
            WHERE src.cs_id = @cs
              AND sl.property_code = @prop
              AND sl.active = 1
              AND (${targetSql})`
        ).all({
          cs: this.#meta.csId,
          prop: propCfg.propertyCode,
          ...Object.fromEntries(normalized.map((value, i) => [`nv${i}`, value])),
        });
        for (const row of rows) codeSet.add(row.code);
      }
    }
    return [...codeSet].sort();
  }

  #nativePropertyRegexCodes(propCfg, regex) {
    if (!this.#nativeSupplementBindings.length) return [];
    const codeSet = new Set();
    for (const binding of this.#nativeSupplementBindings) {
      if (propCfg.sources.includes('literal')) {
        const rows = this.#db.prepare(
          `SELECT c.code,
                  COALESCE(
                    sl.value_text,
                    sl.value_raw,
                    CASE WHEN sl.value_num IS NOT NULL THEN CAST(sl.value_num AS TEXT) ELSE NULL END,
                    CASE WHEN sl.value_bool = 1 THEN 'true' WHEN sl.value_bool = 0 THEN 'false' ELSE NULL END
                  ) AS value
             FROM "${binding.alias}".supplement_literal sl
             JOIN concept c ON c.code = sl.source_code
            WHERE c.cs_id = @cs
              AND sl.property_code = @prop
              AND sl.active = 1`
        ).all({ cs: this.#meta.csId, prop: propCfg.propertyCode });
        for (const row of rows) if (row.value && regex.test(row.value)) codeSet.add(row.code);
      }
      if (propCfg.sources.includes('link')) {
        const rows = this.#db.prepare(
          `SELECT src.code, sl.target_code AS tc, tgt.display AS td
             FROM "${binding.alias}".supplement_link sl
             JOIN concept src ON src.code = sl.source_code
             LEFT JOIN concept tgt ON tgt.code = sl.target_code AND tgt.cs_id = @cs
            WHERE src.cs_id = @cs
              AND sl.property_code = @prop
              AND sl.active = 1`
        ).all({ cs: this.#meta.csId, prop: propCfg.propertyCode });
        for (const row of rows) {
          if ((row.tc && regex.test(row.tc)) || (propCfg.linkMatch === 'code-or-display' && row.td && regex.test(row.td))) {
            codeSet.add(row.code);
          }
        }
      }
    }
    return [...codeSet].sort();
  }

  #nativePropertyExistsCodes(propCfg) {
    if (!this.#nativeSupplementBindings.length) return [];
    const codeSet = new Set();
    for (const binding of this.#nativeSupplementBindings) {
      if (propCfg.sources.includes('literal')) {
        const rows = this.#db.prepare(
          `SELECT DISTINCT c.code
             FROM "${binding.alias}".supplement_literal sl
             JOIN concept c ON c.code = sl.source_code
            WHERE c.cs_id = @cs
              AND sl.property_code = @prop
              AND sl.active = 1`
        ).all({ cs: this.#meta.csId, prop: propCfg.propertyCode });
        for (const row of rows) codeSet.add(row.code);
      }
      if (propCfg.sources.includes('link')) {
        const rows = this.#db.prepare(
          `SELECT DISTINCT src.code
             FROM "${binding.alias}".supplement_link sl
             JOIN concept src ON src.code = sl.source_code
            WHERE src.cs_id = @cs
              AND sl.property_code = @prop
              AND sl.active = 1`
        ).all({ cs: this.#meta.csId, prop: propCfg.propertyCode });
        for (const row of rows) codeSet.add(row.code);
      }
    }
    return [...codeSet].sort();
  }

  /** Run configured special property handler. */
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
    const effectivePropDefs = this.#effectivePropDefs();
    if (!filtersCfg) {
      const propDef = effectivePropDefs.get(propertyCode);
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
    const propDef = effectivePropDefs.get(resolvedCode);
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
    const raw = String(value || '').trim();
    if (!raw) return raw;

    // Already a canonical/implicit ValueSet URL; do not rewrite.
    if (raw.includes('?fhir_vs=')
      || raw.startsWith('http://')
      || raw.startsWith('https://')
      || raw.startsWith('urn:')) {
      return raw;
    }

    if (implicitVS?.refset?.queryPrefix) {
      return `${this.system()}?${implicitVS.refset.queryPrefix}${raw}`;
    }
    // Default: value is already a URL or we construct one
    return raw;
  }

  // ── IR engine integration (Phase 1) ────────────────────────────────

  /**
   * Execute an IR subtree scoped to this code system.
   * Compiles the IR through the sqlite-v0 provider-private execution compiler
   * and returns results as an array of candidates.
   *
   * @param {Object} subtree - optimized IR node from rewrite.js
   * @param {Object} opts - { activeOnly, text, count, offset }
   * @returns {Object} { candidates: [{code, display, definition, active, conceptId}], total?: number }
   */
  executeIR(subtree, opts = {}) {
    const cfg = this.#irCompilerConfig();
    const result = this.#executeIRNew(subtree, opts, cfg);
    return { candidates: result.candidates, total: result.total };
  }

  /**
   * Build a membership checker for an IR subtree.
   * Returns an object with a .has(code) method for point-checking.
   *
   * @param {Object} subtree - optimized IR node
   * @returns {{ has: (code: string) => boolean }}
   */
  membershipForIR(subtree) {
    const cfg = this.#irCompilerConfig();
    return this.#membershipIRNew(subtree, cfg);
  }

  /**
   * Count results for an IR subtree without fetching them.
   * @param {Object} subtree - optimized IR node
   * @param {Object} opts - { activeOnly }
   * @returns {number}
   */
  countForIR(subtree, opts = {}) {
    const cfg = this.#irCompilerConfig();
    return this.#countIRNew(subtree, opts, cfg).count;
  }

  /** Whether this provider supports native IR execution. */
  hasExecuteIR() {
    try {
      require.resolve('./sqlite-v0-compiler');
      return true;
    } catch {
      return false;
    }
  }

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
    // Merge supplement designations (inline supplements not in the DB)
    if (this.supplements?.length > 0 && conceptIds.length > 0) {
      // Build conceptId→code map from a lightweight query
      const codeBatch = 500;
      const codeMap = new Map();
      for (let i = 0; i < conceptIds.length; i += codeBatch) {
        const batch = conceptIds.slice(i, i + codeBatch);
        const ph = batch.map((_, j) => `@cid${i + j}`).join(',');
        const pr = {};
        batch.forEach((id, j) => { pr[`cid${i + j}`] = id; });
        const rows = this.#db.prepare(
          `SELECT concept_id, code FROM concept WHERE concept_id IN (${ph})`
        ).all(pr);
        for (const r of rows) codeMap.set(r.concept_id, r.code);
      }
      for (const [cid, code] of codeMap) {
        for (const supplement of this.supplements) {
          const concept = supplement.getConceptByCode(code);
          if (!concept) continue;
          if (!result.has(cid)) result.set(cid, []);
          const arr = result.get(cid);
          if (concept.designation) {
            for (const d of concept.designation) {
              arr.push({
                language: d.language || null,
                use: d.use || null,
                value: d.value,
                active: true,
              });
            }
          }
        }
      }
    }

    for (const row of this.#nativeSupplementDesignationRowsForConceptIds(conceptIds)) {
      if (!result.has(row.concept_id)) result.set(row.concept_id, []);
      result.get(row.concept_id).push({
        language: row.language_code || null,
        use: row.use_system ? { system: row.use_system, code: row.use_code || null } : (row.use_code ? { system: this.system(), code: row.use_code } : null),
        value: row.term,
        active: !!row.active,
        preferred: !!row.preferred,
      });
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
    const effectivePropDefs = this.#effectivePropDefs();

    for (let i = 0; i < conceptIds.length; i += batchSize) {
      const batch = conceptIds.slice(i, i + batchSize);
      const placeholders = batch.map((_, j) => `@id${i + j}`).join(',');
      const params = {};
      batch.forEach((id, j) => { params[`id${i + j}`] = id; });

      // Concept-valued properties
      const linkSql = `SELECT cl.source_concept_id, pd.property_code, c2.code AS target_code
        FROM concept_link cl
        JOIN property_def pd ON pd.property_id = cl.property_id
        JOIN concept c2 ON c2.concept_id = cl.target_concept_id
        WHERE cl.source_concept_id IN (${placeholders}) AND cl.active = 1`;
      for (const row of this.#db.prepare(linkSql).all(params)) {
        if (!result.has(row.source_concept_id)) result.set(row.source_concept_id, []);
        result.get(row.source_concept_id).push({
          code: row.property_code,
          valueCode: row.target_code,
        });
      }

      // Literal-valued properties
      const litSql = `SELECT cl.source_concept_id, pd.property_code, cl.value_raw, cl.value_text, cl.value_num, cl.value_bool
        FROM concept_literal cl
        JOIN property_def pd ON pd.property_id = cl.property_id
        WHERE cl.source_concept_id IN (${placeholders}) AND cl.active = 1`;
      for (const row of this.#db.prepare(litSql).all(params)) {
        const property = typedLiteralProperty(
          row.property_code,
          row,
          effectivePropDefs.get(row.property_code)
        );
        if (!property) continue;
        if (!result.has(row.source_concept_id)) result.set(row.source_concept_id, []);
        result.get(row.source_concept_id).push(property);
      }
    }
    if (this.supplements?.length > 0 && conceptIds.length > 0) {
      const batchSize = 500;
      const codeMap = new Map();
      for (let i = 0; i < conceptIds.length; i += batchSize) {
        const batch = conceptIds.slice(i, i + batchSize);
        const placeholders = batch.map((_, j) => `@cid${i + j}`).join(',');
        const params = {};
        batch.forEach((id, j) => { params[`cid${i + j}`] = id; });
        const rows = this.#db.prepare(
          `SELECT concept_id, code FROM concept WHERE concept_id IN (${placeholders})`
        ).all(params);
        for (const row of rows) codeMap.set(row.concept_id, row.code);
      }
      for (const [conceptId, code] of codeMap) {
        for (const supplement of this.supplements) {
          const concept = supplement.getConceptByCode(code);
          if (!concept) continue;
          if (!result.has(conceptId)) result.set(conceptId, []);
          for (const prop of concept.property || []) {
            result.get(conceptId).push({ ...prop });
          }
        }
      }
    }
    const suppRows = this.#nativeSupplementPropertyRowsForConceptIds(conceptIds);
    for (const row of suppRows.links) {
      if (!result.has(row.source_concept_id)) result.set(row.source_concept_id, []);
      result.get(row.source_concept_id).push({
        code: row.property_code,
        valueCode: row.target_code,
      });
    }
    for (const row of suppRows.literals) {
      const property = typedLiteralProperty(
        row.property_code,
        row,
        effectivePropDefs.get(row.property_code)
      );
      if (property) {
        if (!result.has(row.source_concept_id)) result.set(row.source_concept_id, []);
        result.get(row.source_concept_id).push(property);
      }
    }
    return result;
  }

  bulkExtensions(conceptIds) {
    if (!conceptIds || conceptIds.length === 0) return new Map();
    const result = new Map();
    if (this.supplements?.length > 0) {
      const batchSize = 500;
      const codeMap = new Map();
      for (let i = 0; i < conceptIds.length; i += batchSize) {
        const batch = conceptIds.slice(i, i + batchSize);
        const placeholders = batch.map((_, j) => `@cid${i + j}`).join(',');
        const params = {};
        batch.forEach((id, j) => { params[`cid${i + j}`] = id; });
        const rows = this.#db.prepare(
          `SELECT concept_id, code FROM concept WHERE concept_id IN (${placeholders})`
        ).all(params);
        for (const row of rows) codeMap.set(row.concept_id, row.code);
      }
      for (const [conceptId, code] of codeMap) {
        for (const supplement of this.supplements) {
          const concept = supplement.getConceptByCode(code);
          if (!concept?.extension?.length) continue;
          if (!result.has(conceptId)) result.set(conceptId, []);
          result.get(conceptId).push(...concept.extension);
        }
      }
    }
    if (!this.#nativeSupplementBindings.length) return result;
    for (const row of this.#nativeSupplementExtensionRowsForConceptIds(conceptIds)) {
      try {
        const ext = JSON.parse(row.value_json);
        if (!result.has(row.concept_id)) result.set(row.concept_id, []);
        result.get(row.concept_id).push(ext);
      } catch {
        // ignore malformed extension payloads
      }
    }
    return result;
  }

  close() {
    if (this.#db) {
      clearSqliteProgressLimit(this.#db);
      this.#db.close();
      this.#db = null;
    }
  }
}

// ── Factory (long-lived, loaded at startup) ─────────────────────────

// ── Specialization registry ─────────────────────────────────────────
// Subclass modules call SqliteV0FactoryProvider.registerSpecialization()
// at require-time to declare interest in specific terminologies.
// See createFromMetadata() for the matching algorithm.
const V0_SPECIALIZATION_REGISTRY = [];

class SqliteV0FactoryProvider extends CodeSystemFactoryProvider {
  _dbPath;
  _meta;       // { csId, baseUri, canonicalUri, version, releaseDate, name, editionCode }
  _runtime;    // parsed cs_config values
  _propDefs;   // Map<propertyCode, {property_id, value_kind, is_hierarchy}>
  _loaded = false;

  /**
   * Register a v0 specialization. Subclass modules call this at require-time.
   *
   * @param {Object} def
   * @param {string} def.id - Unique identifier (e.g. 'snomed-expressions')
   * @param {Function} def.FactoryClass - Subclass of SqliteV0FactoryProvider
   * @param {string} [def.systemPrefix] - URL prefix to match against the DB's canonical URI
   * @param {string[]} [def.tags] - All listed tags must be present in the DB's behaviorFlags.tags
   * @param {number} [def.priority=0] - Higher priority wins on conflict
   */
  static registerSpecialization(def) {
    if (!def || typeof def !== 'object') throw new Error('registerSpecialization requires an object');
    if (typeof def.FactoryClass !== 'function') throw new Error('registerSpecialization requires a FactoryClass');
    if (!def.systemPrefix && (!def.tags || def.tags.length === 0)) {
      throw new Error('registerSpecialization requires systemPrefix and/or tags');
    }
    V0_SPECIALIZATION_REGISTRY.push({
      id: String(def.id || `v0-spec-${V0_SPECIALIZATION_REGISTRY.length + 1}`),
      priority: Number.isFinite(def.priority) ? def.priority : 0,
      systemPrefix: def.systemPrefix || null,
      tags: Array.isArray(def.tags) ? def.tags : [],
      FactoryClass: def.FactoryClass,
    });
    V0_SPECIALIZATION_REGISTRY.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Load a v0 database and return the appropriate factory instance.
   * Probes db metadata (canonical URI + behaviorFlags.tags), checks the
   * specialization registry, and returns a specialized factory if one
   * matches — otherwise the generic base.
   *
   * @param {Object} i18n
   * @param {string} dbPath
   * @param {Object} [options]
   * @param {string} [options.specialization] - 'none' to force generic base,
   *   or a specific id to select from the registry. Omit for auto-detection.
   */
  static async createFromMetadata(i18n, dbPath, options = {}) {
    const base = new SqliteV0FactoryProvider(i18n, dbPath, options);
    await base.load();

    const { specialization } = options;
    if (specialization === 'none' || V0_SPECIALIZATION_REGISTRY.length === 0) {
      return base;
    }

    const system = base.system() || '';
    const flags = base._runtime?.behaviorFlags || {};
    const dbTags = new Set(Array.isArray(flags.tags) ? flags.tags : []);

    for (const entry of V0_SPECIALIZATION_REGISTRY) {
      if (specialization && entry.id !== specialization) continue;
      const urlMatch = !entry.systemPrefix || system.startsWith(entry.systemPrefix);
      const tagMatch = entry.tags.length === 0 || entry.tags.every(t => dbTags.has(t));
      if (urlMatch && tagMatch) {
        // Matched — construct the specialized factory instead
        const resolved = new entry.FactoryClass(i18n, dbPath, options);
        await resolved.load();
        return resolved;
      }
    }

    return base;
  }

  constructor(i18n, dbPath, options = {}) {
    super(i18n);
    this._dbPath = dbPath;
    this._options = {
      ...options,
      supplements: normalizeSqliteSupplementSources(options.supplements, dbPath),
    };
  }

  async load() {
    const db = openV0Database(this._dbPath);
    try {
      // Load code_system metadata
      const cs = db.prepare('SELECT * FROM code_system LIMIT 1').get();
      if (!cs) throw new Error(`No code_system row in ${this._dbPath}`);
      this._meta = {
        csId: cs.cs_id,
        baseUri: cs.base_uri,
        editionCode: cs.edition_code,
        version: cs.version,
        canonicalUri: cs.canonical_uri,
        releaseDate: cs.release_date || null,
        loadedAt: cs.loaded_at || null,
        name: cs.name,
      };
      this._meta.releaseDate = extractReleaseDate(this._meta);

      // Load runtime config with defaults
      const rawCfg = {};
      const configs = db.prepare('SELECT key, value FROM cs_config WHERE cs_id = @cs').all({ cs: cs.cs_id });
      for (const cfg of configs) {
        const shortKey = cfg.key.replace(/^runtime\./, '');
        try { rawCfg[shortKey] = JSON.parse(cfg.value); }
        catch { rawCfg[shortKey] = cfg.value; }
      }
      this._runtime = buildRuntimeConfig(rawCfg, cs.base_uri);

      // Load property definitions
      this._propDefs = new Map();
      const props = db.prepare('SELECT * FROM property_def WHERE cs_id = @cs').all({ cs: cs.cs_id });
      for (const p of props) {
        this._propDefs.set(p.property_code, {
          property_id: p.property_id,
          value_kind: p.value_kind,
          is_hierarchy: !!p.is_hierarchy,
          display: p.display,
          source_type: p.source_type || null,
        });
      }

      // Native IR planning treats concept_id as sufficient identity within one
      // scoped provider bucket. Make that runtime invariant explicit.
      const dupCode = db.prepare(
        `SELECT code, COUNT(*) AS cnt
           FROM concept
          WHERE cs_id = @cs
          GROUP BY code
         HAVING COUNT(*) > 1
          LIMIT 1`
      ).get({ cs: cs.cs_id });
      if (dupCode) {
        throw new Error(
          `sqlite-v0 invariant violated: duplicate code '${dupCode.code}' appears ${dupCode.cnt} times within cs_id=${cs.cs_id}`
        );
      }

      this._loaded = true;
    } finally {
      db.close();
    }
  }

  system() {
    return this._meta?.baseUri || 'unknown';
  }

  version() {
    return sqliteV0VersionToken(this._meta);
  }

  name() {
    return this._meta?.name || 'sqlite-v0';
  }

  defaultVersion() {
    return this._meta?.version || 'unknown';
  }

  releaseDate() {
    return this._meta?.releaseDate || null;
  }

  id() {
    return `sqlite-v0-${this._meta?.baseUri}-${this._meta?.version}`;
  }

  iteratable() {
    return true;
  }

  async registerSqliteSupplements() {
    return this._options?.supplements || [];
  }

  async build(opContext, supplements) {
    this.recordUse();
    const db = openV0Database(this._dbPath, { readonly: false });
    return new SqliteV0Provider(opContext, supplements, db, this._meta, this._runtime, this._propDefs, this._options);
  }

  /** Build implicit value sets from configured URL patterns and explicit value_set rows. */
  async buildKnownValueSet(url, vsVersion) {
    if (vsVersion && this._meta.version && vsVersion !== this._meta.version) {
      return null;
    }

    const implicitVS = this._runtime.implicitValueSets;
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
    const db = openV0Database(this._dbPath);
    try {
      const row = db.prepare('SELECT * FROM value_set WHERE url = @url AND cs_id = @cs').get({ url, cs: this._meta.csId });
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
    const ver = this._meta?.version;
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
  openV0Database,
};
