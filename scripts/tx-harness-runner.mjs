#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { registerHarnessCases } from './tx-harness-cases/index.mjs';
/**
 * TX harness — hits the running server, asserts concrete expectations.
 * Usage: node scripts/tx-harness.mjs [filter ...] [--filter <text> ...] [--legacy] [--trace] [--perf] [--perf-out <file>] [--matrix-out <file>]
 *                                   [--strict-ir-no-fallback]
 *                                   [--semantic-parity] [--strict-total-consistency]
 *
 * --perf   Run each test with both engines (1 run by default), collect median
 *          timings, write tmp/perf-table.html at the end (or --perf-out path).
 */
const BASE = process.env.BASE_URL || 'http://localhost:8000';
const EXPAND = `${BASE}/r4/ValueSet/$expand`;
const argv = process.argv.slice(2);
let PERF_OUT = process.env.PERF_OUT || 'tmp/perf-table.html';
let MATRIX_OUT = process.env.MATRIX_OUT || 'tmp/tx-matrix.html';
const FILTERS = [];
const KIND_FILTERS = [];
const CATEGORY_FILTERS = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--filter') {
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      console.error('Missing value for --filter');
      process.exit(2);
    }
    FILTERS.push(next);
    i++;
    continue;
  }
  if (arg === '--kind') {
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      console.error('Missing value for --kind');
      process.exit(2);
    }
    KIND_FILTERS.push(next);
    i++;
    continue;
  }
  if (arg.startsWith('--kind=')) {
    const value = arg.slice('--kind='.length);
    if (!value.trim()) {
      console.error('--kind requires a non-empty value');
      process.exit(2);
    }
    KIND_FILTERS.push(value);
    continue;
  }
  if (arg === '--category') {
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      console.error('Missing value for --category');
      process.exit(2);
    }
    CATEGORY_FILTERS.push(next);
    i++;
    continue;
  }
  if (arg.startsWith('--category=')) {
    const value = arg.slice('--category='.length);
    if (!value.trim()) {
      console.error('--category requires a non-empty value');
      process.exit(2);
    }
    CATEGORY_FILTERS.push(value);
    continue;
  }
  if (arg.startsWith('--filter=')) {
    const value = arg.slice('--filter='.length);
    if (!value.trim()) {
      console.error('--filter requires a non-empty value');
      process.exit(2);
    }
    FILTERS.push(value);
    continue;
  }
  if (arg === '--perf-out') {
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      console.error('Missing value for --perf-out');
      process.exit(2);
    }
    PERF_OUT = next;
    i++;
    continue;
  }
  if (arg.startsWith('--perf-out=')) {
    PERF_OUT = arg.slice('--perf-out='.length);
    continue;
  }
  if (arg === '--matrix-out') {
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      console.error('Missing value for --matrix-out');
      process.exit(2);
    }
    MATRIX_OUT = next;
    i++;
    continue;
  }
  if (arg.startsWith('--matrix-out=')) {
    MATRIX_OUT = arg.slice('--matrix-out='.length);
    continue;
  }
  if (!arg.startsWith('--')) {
    FILTERS.push(arg);
  }
}
if (!PERF_OUT.trim()) {
  console.error('--perf-out requires a non-empty output path');
  process.exit(2);
}
const RUN_LEGACY = argv.includes('--legacy');
const WANT_TRACE = argv.includes('--trace');
const PERF_MODE = argv.includes('--perf');
const STRICT_IR_NO_FALLBACK = argv.includes('--strict-ir-no-fallback')
  || argv.includes('--strict-ir')
  || process.env.STRICT_IR_NO_FALLBACK === '1';
const SEMANTIC_PARITY = argv.includes('--semantic-parity')
  || process.env.SEMANTIC_PARITY === '1';
const STRICT_TOTAL_CONSISTENCY = argv.includes('--strict-total-consistency')
  || SEMANTIC_PARITY
  || process.env.STRICT_TOTAL_CONSISTENCY === '1';
const CHECK_PARENT_PARITY = process.env.SEMANTIC_PARITY_CHECK_PARENT === '1';
const RUNS = parseInt(process.env.PERF_RUNS || '1', 10);
const PERF_RUNS = parseInt(process.env.PERF_RUNS || '1', 10);
const PERF_PRIMARY_LABEL = process.env.PERF_PRIMARY_LABEL || 'IR Branch + IR Worker';
const PERF_SECONDARY_LABEL = process.env.PERF_SECONDARY_LABEL || 'IR Branch + Legacy Worker';
const PERF_THIRD_BASE_URL = (process.env.PERF_THIRD_BASE_URL || '').trim();
const PERF_THIRD_ENGINE = process.env.PERF_THIRD_ENGINE || 'legacy';
const PERF_THIRD_LABEL = process.env.PERF_THIRD_LABEL || 'Upstream Providers + Legacy Worker';
const PERF_THIRD_ENABLED = PERF_MODE && PERF_THIRD_BASE_URL.length > 0;
const PERF_HTTP_TIMEOUT_MS = parseInt(process.env.PERF_HTTP_TIMEOUT_MS || '30000', 10);
const PERF_THIRD_HTTP_TIMEOUT_MS = parseInt(process.env.PERF_THIRD_HTTP_TIMEOUT_MS || '5000', 10);
const PERF_OUT_PATH = resolve(PERF_OUT);
const PERF_OUT_BASE = basename(PERF_OUT_PATH, extname(PERF_OUT_PATH));
const PERF_DETAILS_DIR = join(dirname(PERF_OUT_PATH), `${PERF_OUT_BASE}.details`);
const PERF_INPUTS_DIR = join(dirname(PERF_OUT_PATH), `${PERF_OUT_BASE}.inputs`);
const PERF_CATALOG_PATH = join(dirname(PERF_OUT_PATH), `${PERF_OUT_BASE}.catalog.json`);
const PERF_ARTIFACT_SCHEMA_VERSION = 1;
const MATRIX_OUT_PATH = resolve(MATRIX_OUT);
const MATRIX_OUT_BASE = basename(MATRIX_OUT_PATH, extname(MATRIX_OUT_PATH));
const MATRIX_DETAILS_DIR = join(dirname(MATRIX_OUT_PATH), `${MATRIX_OUT_BASE}.details`);
const MATRIX_INPUTS_DIR = join(dirname(MATRIX_OUT_PATH), `${MATRIX_OUT_BASE}.inputs`);
const MATRIX_CATALOG_PATH = join(dirname(MATRIX_OUT_PATH), `${MATRIX_OUT_BASE}.catalog.json`);
const TRACE_EXTENSION_URLS = new Set([
  'https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/expand-trace',
  'http://fhirsmith.org/StructureDefinition/expand-trace', // backwards compatibility
]);
const IR_PLAN_EXTENSION_URLS = new Set([
  'https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/ir-plan',
  'http://fhirsmith.org/StructureDefinition/ir-plan', // backwards compatibility
]);
const HARNESS_SQLITE_SUPP_URL_ROOT = (process.env.HARNESS_SQLITE_SUPP_URL_ROOT || '').trim();

const SYS = {
  SCT: 'http://snomed.info/sct',
  LOINC: 'http://loinc.org',
  RXNORM: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  GENDER: 'http://hl7.org/fhir/administrative-gender',
  PUBSTAT: 'http://hl7.org/fhir/publication-status',
  CURRENCY: 'urn:iso:std:iso:4217',
  COUNTRY: 'urn:iso:std:iso:3166',
  LANG: 'urn:ietf:bcp:47',
  CONDVER: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  OBSCAT: 'http://terminology.hl7.org/CodeSystem/observation-category',
  USPS: 'https://www.usps.com/',
  AREACODE: 'http://unstats.un.org/unsd/methods/m49/m49.htm',
  MIME: 'urn:ietf:bcp:13',
  UCUM: 'http://unitsofmeasure.org',
};
const EXACT_TOTAL_PARAM = Object.freeze({ name: '_exactTotal', valueBoolean: true });

function withExactTotal(opts = {}) {
  return {
    ...opts,
    params: [...(opts.params || []), EXACT_TOTAL_PARAM],
  };
}

// ── helpers ────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
let currentTestName = null;
const semanticParityWaivedTests = new Set();

const KNOWN_SEMANTIC_PARITY_EXCEPTIONS = new Map([
  ['Clinical finding first 50: fast with EXISTS pushdown', 'legacy-drain-non-result'],
  ['LOINC STATUS=ACTIVE high offset (1000,20)', 'legacy-drain-non-result'],
  ['LOINC text creatinine first 20', 'legacy-drain-non-result'],
  ['RxNorm TTY=IN first 50', 'legacy-drain-non-result'],
  ['LOINC CLASSTYPE=1 first 50: ~66K total', 'legacy-drain-non-result'],
  ['LOINC STATUS=ACTIVE first 20: ~96K total', 'legacy-drain-non-result'],
  ['Multi-system stride pagination', 'legacy-drain-non-result'],
  ['pagination-safety: deep offset 110K into 124K set returns 10K codes', 'legacy-drain-non-result'],
  ['pagination-safety: last page of 124K set is partial', 'legacy-drain-non-result'],
  ['logic: property regex on literal-valued property (LOINC STATUS regex ^ACT)', 'legacy-drain-non-result'],
  ['logic: total reflects imported excludes without mutating accumulated list', 'legacy-drain-non-result'],
  ['logic: mixed import+peer inc/exc paginates without gaps or duplicates', 'legacy-drain-non-result'],
  ['logic: code regex handled in sqlite-v0', 'legacy-drain-non-result'],
  ['coverage: UCUM whole-system with gender peer include', 'legacy-drain-non-result'],
  ['limit: pagination bypasses limit for large system', 'legacy-drain-non-result'],
  ['unclosed: multi-system with grammar provider reports unclosed on all pages', 'legacy-drain-non-result'],
  ['stress: deep SNOMED is-a pagination stable across adjacent pages', 'legacy-drain-non-result'],
  ['stress: mixed-system text filter with limit boundary', 'legacy-drain-non-result'],
  ['filter: LOINC SCALE_TYP=Doc uses concept_literal + code-or-display', 'legacy-drain-non-result'],
  ['filter: LOINC ORDER_OBS=Observation uses literal source with alias', 'legacy-drain-non-result'],
  ['filter: LOINC CLASS=CHEM via dual sources', 'legacy-drain-non-result'],
  ['filter: RxNorm TTY=SCD uses literal source', 'legacy-drain-non-result'],
]);

function shouldWaiveSemanticParity(testName, err) {
  const expected = KNOWN_SEMANTIC_PARITY_EXCEPTIONS.get(testName);
  if (!expected) return false;
  const msg = String(err?.message || '');
  if (expected === 'legacy-drain-non-result') {
    return msg.includes('SEMANTIC_PARITY drain failed (legacy): non-result response');
  }
  return false;
}

function vs(include, exclude) {
  const inc = Array.isArray(include) ? include : [include];
  const exc = exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : undefined;
  return { resourceType: 'ValueSet', compose: { include: inc, ...(exc ? { exclude: exc } : {}) } };
}

const DEFAULT_ENGINE = RUN_LEGACY ? 'legacy' : 'ir';
const SUPPORTED_MATRIX_ENGINES = Object.freeze(['ir', 'legacy']);
const OPERATION_DEFAULT_ENGINES = Object.freeze({
  expand: ['ir', 'legacy'],
  lookup: ['ir', 'legacy'],
  validate: ['ir', 'legacy'],
});
function buildExpandParameters(vsJson, opts = {}, engine = DEFAULT_ENGINE, forceTrace = WANT_TRACE) {
  const params = [{ name: 'valueSet', resource: vsJson }];
  params.push({ name: '_engine', valueString: engine });
  if (opts.count !== undefined) params.push({ name: 'count', valueInteger: opts.count });
  if (opts.offset !== undefined) params.push({ name: 'offset', valueInteger: opts.offset });
  if (opts.activeOnly) params.push({ name: 'activeOnly', valueBoolean: true });
  if (opts.excludeNested != null) params.push({ name: 'excludeNested', valueBoolean: opts.excludeNested });
  if (opts.filter) params.push({ name: 'filter', valueString: opts.filter });
  if (opts.includeDesignations) params.push({ name: 'includeDesignations', valueBoolean: true });
  if (forceTrace) params.push({ name: '_trace', valueString: 'true' });
  params.push({ name: '_nocache', valueString: 'true' });
  // Attach inline tx-resource(s) (e.g. custom CodeSystems)
  if (opts.txResources) {
    for (const res of Array.isArray(opts.txResources) ? opts.txResources : [opts.txResources]) {
      params.push({ name: 'tx-resource', resource: res });
    }
  }
  // Generic extra parameters (e.g. designation, useSupplement, displayLanguage)
  if (opts.params) {
    for (const p of opts.params) params.push(p);
  }
  return params;
}

function extractTracePayload(responseJson) {
  const traceText = extractPayloadString(responseJson, TRACE_EXTENSION_URLS, 'trace');
  if (!traceText) return null;
  try {
    return JSON.parse(traceText);
  } catch {
    return { parseError: 'Unable to parse trace JSON', raw: traceText };
  }
}

function extractIRPlanPayload(responseJson) {
  const planText = extractPayloadString(responseJson, IR_PLAN_EXTENSION_URLS, 'irPlan');
  return planText == null ? null : String(planText);
}

function extractPayloadString(responseJson, extensionUrls, parameterName) {
  const topLevelExt = responseJson?.extension || [];
  const foundTopLevelExt = topLevelExt.find(e => extensionUrls.has(e.url));
  if (foundTopLevelExt?.valueString) return foundTopLevelExt.valueString;
  const expansionExt = responseJson?.expansion?.extension || [];
  const foundExt = expansionExt.find(e => extensionUrls.has(e.url));
  if (foundExt?.valueString) return foundExt.valueString;
  const params = responseJson?.parameter || [];
  const acceptedNames = parameterName === 'trace'
    ? new Set(['trace', '_trace'])
    : new Set([parameterName]);
  const foundParam = params.find((param) => acceptedNames.has(param?.name));
  return foundParam?.valueString || null;
}

function collectTraceNotes(spans, out = []) {
  for (const span of spans || []) {
    if (!span) continue;
    if (span.name === 'note' && span.message) out.push(span);
    collectTraceNotes(span.children, out);
  }
  return out;
}

function collectTraceSpans(spans, out = []) {
  for (const span of spans || []) {
    if (!span) continue;
    out.push(span);
    collectTraceSpans(span.children, out);
  }
  return out;
}

function requireTrace(traceJson, label = 'request') {
  if (!traceJson) {
    throw new Error(`Missing structured trace payload for ${label}`);
  }
  if (traceJson.parseError) {
    throw new Error(`Invalid structured trace payload for ${label}: ${traceJson.parseError}`);
  }
  return traceJson;
}

function traceSpansByName(traceJson, name) {
  const trace = requireTrace(traceJson, String(name || 'trace'));
  return collectTraceSpans(trace.spans).filter(span => span?.name === name);
}

function traceHasSpan(traceJson, name) {
  return traceSpansByName(traceJson, name).length > 0;
}

function traceHasAnySpan(traceJson, names) {
  return (names || []).some(name => traceHasSpan(traceJson, name));
}

function assertCompilerMaterializationTrace(traceJson, label = 'request') {
  assert(traceHasSpan(traceJson, 'executeIR:compiler'),
    `${label} should use compiler-backed materialization`);
}

function assertCountOnlyTraceBehavior(result, traceJson, label = 'count-only request') {
  assert(result?.expansion?.total != null, `${label} should report a total`);
  eq(codes(result).length, 0, `${label} should not materialize contains`);
  assert(traceHasAnySpan(traceJson, ['countForIR', 'countForIR:lazy', 'countForIR:compiler']),
    `${label} should include a count trace span`);
  assert(!traceHasSpan(traceJson, 'executeIR:compiler'),
    `${label} should not materialize result rows`);
}

function assertBulkDesignationTrace(result, traceJson, label = 'designation request') {
  assert(codes(result).some(c => Array.isArray(c.designation) && c.designation.length > 0),
    `${label} should return at least one designation`);
  assert(traceHasSpan(traceJson, 'bulkDesignations'),
    `${label} should use bulk designation decoration`);
}

function strictIRTraceCheck(traceJson) {
  if (!traceJson) {
    return { ok: false, message: 'STRICT IR mode: missing structured trace payload for IR request' };
  }
  if (traceJson.parseError) {
    return { ok: false, message: `STRICT IR mode: invalid trace payload (${traceJson.parseError})` };
  }
  const notes = collectTraceNotes(traceJson.spans);
  const selection = notes.find(n => n.message === 'engine-selection');
  if (!selection?.data) {
    // No engine-selection note means IR executed directly (no fallback path).
    return { ok: true };
  }
  const selected = selection.data.selected;
  if (selected === 'legacy') {
    const reason = selection.data.irAttempt?.reason || 'fallback';
    const error = selection.data.irAttempt?.error ? ` (${selection.data.irAttempt.error})` : '';
    return {
      ok: false,
      message: `STRICT IR mode: fallback to legacy detected [${reason}]${error}`,
    };
  }
  return { ok: true };
}

function flatContainsSemantic(contains, parentKey = null, out = []) {
  for (const c of contains || []) {
    const key = `${c.system || ''}\x00${c.version || ''}\x00${c.code || ''}`;
    out.push({
      key,
      parentKey: parentKey || null,
      display: c.display || null,
      inactive: !!c.inactive,
    });
    flatContainsSemantic(c.contains, key, out);
  }
  return out;
}

const semanticUniverseCache = new Map();

function stripPaginationOpts(opts = {}) {
  const out = { ...opts };
  delete out.offset;
  delete out.count;
  return out;
}

function semanticUniverseCacheKey(vsJson, opts = {}, engine = DEFAULT_ENGINE) {
  const baseOpts = stripPaginationOpts(opts);
  return `${engine}\n${JSON.stringify({ vsJson, opts: baseOpts })}`;
}

function semanticConceptFromFlatEntry(entry) {
  const [system, version, code] = String(entry.key || '').split('\x00');
  const concept = { system: system || undefined, code: code || undefined };
  if (version) concept.version = version;
  if (entry.display != null) concept.display = entry.display;
  if (entry.inactive) concept.inactive = true;
  return concept;
}

function compareSemanticUniverse(irUniverse, legacyUniverse) {
  const irContains = [...irUniverse.entryByKey.values()].map(semanticConceptFromFlatEntry);
  const legacyContains = [...legacyUniverse.entryByKey.values()].map(semanticConceptFromFlatEntry);
  const cmp = compareSemanticExpansions(
    { expansion: { total: irUniverse.total, contains: irContains } },
    { expansion: { total: legacyUniverse.total, contains: legacyContains } }
  );
  cmp.irDuplicateCount = irUniverse.duplicates.size;
  cmp.legacyDuplicateCount = legacyUniverse.duplicates.size;
  cmp.anyMismatch = cmp.anyMismatch || cmp.irDuplicateCount > 0 || cmp.legacyDuplicateCount > 0;
  return cmp;
}

async function collectSemanticUniverse(vsJson, opts = {}, engine = DEFAULT_ENGINE) {
  const pageSizeRaw = parseInt(process.env.SEMANTIC_PARITY_DRAIN_COUNT || '1000', 10);
  const maxPagesRaw = parseInt(process.env.SEMANTIC_PARITY_MAX_PAGES || '1000', 10);
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : 1000;
  const maxPages = Number.isFinite(maxPagesRaw) && maxPagesRaw > 0 ? maxPagesRaw : 1000;
  const baseOpts = stripPaginationOpts(opts);
  const entryByKey = new Map();
  const duplicates = new Set();
  let total = null;
  let completed = false;

  for (let page = 0; page < maxPages; page++) {
    const pageOpts = { ...baseOpts, offset: page * pageSize, count: pageSize };
    const { responseJson: body } = await executeExpandRequest(vsJson, pageOpts, engine, false);
    if (!body || body.resourceType === 'OperationOutcome') {
      throw new Error(`SEMANTIC_PARITY drain failed (${engine}): non-result response`);
    }
    const exp = body.expansion || {};
    if (exp.total != null && total == null) total = exp.total;
    const flat = flatContainsSemantic(exp.contains);
    if (flat.length === 0) {
      completed = true;
      break;
    }
    for (const entry of flat) {
      if (entryByKey.has(entry.key)) duplicates.add(entry.key);
      entryByKey.set(entry.key, entry);
    }
    if (exp.total != null && (page + 1) * pageSize >= exp.total) {
      completed = true;
      break;
    }
  }

  if (!completed) {
    throw new Error(`SEMANTIC_PARITY drain exceeded max pages (${maxPages})`);
  }
  if (total == null) total = entryByKey.size;

  return { total, entryByKey, duplicates };
}

async function collectSemanticUniverseCached(vsJson, opts = {}, engine = DEFAULT_ENGINE) {
  const key = semanticUniverseCacheKey(vsJson, opts, engine);
  if (semanticUniverseCache.has(key)) return semanticUniverseCache.get(key);
  const universe = await collectSemanticUniverse(vsJson, opts, engine);
  semanticUniverseCache.set(key, universe);
  return universe;
}

function compareSemanticExpansions(irResult, legacyResult, opts = {}) {
  const ignoreContains = !!opts.ignoreContains;
  const irExp = irResult?.expansion || {};
  const legacyExp = legacyResult?.expansion || {};

  let irOnly = [];
  let legacyOnly = [];
  let displayDiff = [];
  let parentDiff = [];
  let inactiveDiff = [];
  if (!ignoreContains) {
    const irFlat = flatContainsSemantic(irExp.contains);
    const legacyFlat = flatContainsSemantic(legacyExp.contains);
    const irByKey = new Map(irFlat.map(c => [c.key, c]));
    const legacyByKey = new Map(legacyFlat.map(c => [c.key, c]));

    irOnly = [...irByKey.keys()].filter(k => !legacyByKey.has(k));
    legacyOnly = [...legacyByKey.keys()].filter(k => !irByKey.has(k));

    for (const [key, irEntry] of irByKey.entries()) {
      const legacyEntry = legacyByKey.get(key);
      if (!legacyEntry) continue;
      if (irEntry.display !== legacyEntry.display) {
        displayDiff.push({ key, ir: irEntry.display, legacy: legacyEntry.display });
      }
      if (irEntry.parentKey !== legacyEntry.parentKey) {
        parentDiff.push({ key, ir: irEntry.parentKey, legacy: legacyEntry.parentKey });
      }
      if (irEntry.inactive !== legacyEntry.inactive) {
        inactiveDiff.push({ key, ir: irEntry.inactive, legacy: legacyEntry.inactive });
      }
    }
  }

  const totalMismatch = irExp.total != null && legacyExp.total != null && irExp.total !== legacyExp.total;
  const membershipMismatch = !ignoreContains && (irOnly.length > 0 || legacyOnly.length > 0);
  const parentMismatch = CHECK_PARENT_PARITY && parentDiff.length > 0;
  const anyMismatch = totalMismatch || membershipMismatch || displayDiff.length > 0 || parentMismatch || inactiveDiff.length > 0;

  return {
    anyMismatch,
    totalMismatch,
    membershipMismatch,
    displayDiff,
    parentDiff,
    inactiveDiff,
    irOnly,
    legacyOnly,
    irTotal: irExp.total,
    legacyTotal: legacyExp.total,
  };
}

function formatSemanticParityMismatch(cmp) {
  const details = [];
  if (cmp.totalMismatch) details.push(`total legacy=${cmp.legacyTotal} ir=${cmp.irTotal}`);
  if (cmp.membershipMismatch) {
    details.push(`membership legacyOnly=${cmp.legacyOnly.slice(0, 3).join(', ') || '-'} irOnly=${cmp.irOnly.slice(0, 3).join(', ') || '-'}`);
  }
  if (cmp.displayDiff.length > 0) {
    const d = cmp.displayDiff[0];
    details.push(`display sample ${d.key} legacy=${JSON.stringify(d.legacy)} ir=${JSON.stringify(d.ir)}`);
  }
  if (cmp.parentDiff.length > 0) {
    const d = cmp.parentDiff[0];
    details.push(`parent sample ${d.key} legacy=${d.legacy || '-'} ir=${d.ir || '-'}`);
  }
  if (cmp.inactiveDiff.length > 0) {
    const d = cmp.inactiveDiff[0];
    details.push(`inactive sample ${d.key} legacy=${d.legacy} ir=${d.ir}`);
  }
  if (cmp.legacyDuplicateCount > 0 || cmp.irDuplicateCount > 0) {
    details.push(`duplicates legacy=${cmp.legacyDuplicateCount || 0} ir=${cmp.irDuplicateCount || 0}`);
  }
  return details.join(' | ');
}

function assertTotalConsistency(result, opts = {}, engine = DEFAULT_ENGINE) {
  const total = result?.expansion?.total;
  if (total == null) return;
  const flatCount = codes(result).length;
  if (flatCount > total) {
    throw new Error(
      `TOTAL_CONSISTENCY(${engine}): contains(${flatCount}) > total(${total})`
    );
  }

  const offsetRaw = opts.offset;
  const offset = (offsetRaw == null || offsetRaw < 0) ? 0 : offsetRaw;
  const count = opts.count;
  if (typeof count === 'number' && count >= 0 && offset === 0 && total <= count && flatCount !== total) {
    throw new Error(
      `TOTAL_CONSISTENCY(${engine}): expected full-page equality (count=${count}, total=${total}) but contains=${flatCount}`
    );
  }
}

async function assertSemanticParity(vsJson, opts = {}, irResult) {
  const hasExplicitPagination = (opts.offset != null && opts.offset >= 0)
    || (typeof opts.count === 'number' && opts.count >= 0);
  if (hasExplicitPagination && !(typeof opts.count === 'number' && opts.count === 0)) {
    // For paginated queries, compare full semantics by draining all pages
    // with a fixed page size to avoid order-dependent page-window noise.
    const irUniverse = await collectSemanticUniverseCached(vsJson, opts, 'ir');
    const legacyUniverse = await collectSemanticUniverseCached(vsJson, opts, 'legacy');
    const cmp = compareSemanticUniverse(irUniverse, legacyUniverse);
    if (!cmp.anyMismatch) return;
    throw new Error(`SEMANTIC_PARITY mismatch: ${formatSemanticParityMismatch(cmp)}`);
  }

  const { responseJson: legacyBody } = await executeExpandRequest(vsJson, opts, 'legacy', false);
  if (!legacyBody || legacyBody.resourceType === 'OperationOutcome') return;
  const cmp = compareSemanticExpansions(irResult, legacyBody, { ignoreContains: hasExplicitPagination });
  if (!cmp.anyMismatch) return;
  throw new Error(`SEMANTIC_PARITY mismatch: ${formatSemanticParityMismatch(cmp)}`);
}

async function executeExpandRequest(vsJson, opts = {}, engine = DEFAULT_ENGINE, forceTrace = WANT_TRACE, baseUrl = BASE, timeoutMs = PERF_HTTP_TIMEOUT_MS) {
  const expandUrl = baseUrl === BASE ? EXPAND : expandUrlForBase(baseUrl);
  const params = buildExpandParameters(vsJson, opts, engine, forceTrace);
  const requestBody = { resourceType: 'Parameters', parameter: params };
  const request = {
    method: 'POST',
    url: expandUrl,
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  let resp;
  try {
    resp = await fetch(expandUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (e) {
    return {
      ms: performance.now() - t0,
      request,
      response: null,
      responseText: null,
      responseJson: null,
      traceJson: null,
      irPlanText: null,
      error: e?.message || String(e),
    };
  } finally {
    clearTimeout(timeoutId);
  }
  const ms = performance.now() - t0;
  const responseText = await resp.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }
  const traceJson = extractTracePayload(responseJson);
  const irPlanText = extractIRPlanPayload(responseJson);
  return {
    ms,
    request,
    response: {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers.entries()),
      body: responseJson ?? responseText,
    },
    responseText,
    responseJson,
    traceJson,
    irPlanText,
    error: null,
  };
}

function buildRequestUrl(baseUrl, spec) {
  const url = new URL(spec.path, baseUrl);
  if (spec.query) {
    for (const [k, v] of Object.entries(spec.query)) {
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url;
}

async function executeOperationRequest(spec, baseUrl = BASE, timeoutMs = PERF_HTTP_TIMEOUT_MS) {
  const url = buildRequestUrl(baseUrl, spec);
  const request = {
    method: spec.method,
    url: url.toString(),
    headers: {
      Accept: 'application/fhir+json',
      ...(spec.body ? { 'Content-Type': 'application/fhir+json' } : {}),
      ...(spec.headers || {}),
    },
    body: spec.body ?? null,
  };
  const requestBody = spec.body == null
    ? undefined
    : typeof spec.body === 'string'
      ? spec.body
      : JSON.stringify(spec.body);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: spec.method,
      headers: request.headers,
      body: requestBody,
      signal: controller.signal,
    });
  } catch (e) {
    return {
      ms: performance.now() - t0,
      request,
      response: null,
      responseText: null,
      responseJson: null,
      traceJson: null,
      irPlanText: null,
      error: e?.message || String(e),
    };
  } finally {
    clearTimeout(timeoutId);
  }
  const ms = performance.now() - t0;
  const responseText = await resp.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = { parseError: true, raw: responseText };
  }
  const traceJson = extractTracePayload(responseJson);
  const irPlanText = extractIRPlanPayload(responseJson);
  return {
    ms,
    request,
    response: {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers.entries()),
      body: responseJson,
    },
    responseText,
    responseJson,
    traceJson,
    irPlanText,
    error: null,
  };
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function extractRequestEngineHint(spec = {}) {
  if (typeof spec?.query?._engine === 'string' && spec.query._engine.trim()) {
    return String(spec.query._engine).trim().toLowerCase();
  }
  const body = spec?.body;
  if (body?.resourceType === 'Parameters' && Array.isArray(body.parameter)) {
    for (const param of body.parameter) {
      if (param?.name !== '_engine') continue;
      for (const key of ['valueString', 'valueCode', 'valueUri', 'valueCanonical']) {
        const value = param?.[key];
        if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
      }
    }
  }
  return null;
}

function normalizeCaseEngines(caseDef = {}) {
  if (Array.isArray(caseDef.engines) && caseDef.engines.length > 0) {
    return [...new Set(caseDef.engines.map((engine) => String(engine).trim().toLowerCase()).filter(Boolean))];
  }
  const kindDefault = OPERATION_DEFAULT_ENGINES[String(caseDef.kind || '').trim().toLowerCase()];
  if (Array.isArray(kindDefault) && kindDefault.length > 0) {
    return [...kindDefault];
  }
  const hinted = extractRequestEngineHint(caseDef.request);
  if (hinted === 'ir') return ['ir'];
  if (hinted === 'legacy') return ['legacy'];
  return [...SUPPORTED_MATRIX_ENGINES];
}

function caseSupportsEngine(caseDef = {}, engine) {
  return normalizeCaseEngines(caseDef).includes(String(engine || '').trim().toLowerCase());
}

function stripEngineFromOperationSpec(spec = {}) {
  const next = cloneJson(spec);
  if (next?.query && typeof next.query === 'object') {
    delete next.query._engine;
  }
  if (next?.body?.resourceType === 'Parameters' && Array.isArray(next.body.parameter)) {
    next.body.parameter = next.body.parameter.filter((param) => param?.name !== '_engine');
  } else if (next?.body && typeof next.body === 'object') {
    delete next.body._engine;
  }
  return next;
}

function injectEngineIntoOperationSpec(spec = {}, engine) {
  const next = stripEngineFromOperationSpec(spec);
  const normalizedEngine = String(engine || '').trim().toLowerCase();
  if (!normalizedEngine) return next;
  if (next?.body?.resourceType === 'Parameters' && Array.isArray(next.body.parameter)) {
    next.body.parameter.push({ name: '_engine', valueString: normalizedEngine });
    return next;
  }
  next.query = { ...(next.query || {}), _engine: normalizedEngine };
  return next;
}

function injectTraceIntoOperationSpec(spec = {}) {
  const next = cloneJson(spec);
  if (next?.body?.resourceType === 'Parameters' && Array.isArray(next.body.parameter)) {
    const already = next.body.parameter.some((param) => param?.name === '_trace');
    if (!already) next.body.parameter.push({ name: '_trace', valueBoolean: true });
    return next;
  }
  next.query = { ...(next.query || {}), _trace: 'true' };
  return next;
}

function operationAssertion(caseDef = {}, engine = DEFAULT_ENGINE) {
  return caseDef.assertByEngine?.[engine] || caseDef.assertLocal;
}

async function executeOperationCase(caseDef, engine = DEFAULT_ENGINE, baseUrl = BASE, timeoutMs = PERF_HTTP_TIMEOUT_MS) {
  const spec = injectTraceIntoOperationSpec(injectEngineIntoOperationSpec(caseDef.request, engine));
  const outcome = await executeOperationRequest(spec, baseUrl, timeoutMs);
  if (outcome.error) {
    throw new Error(outcome.error);
  }
  const local = {
    status: outcome.response?.status ?? null,
    body: outcome.responseJson,
    headers: outcome.response?.headers || {},
    responseText: outcome.responseText,
    url: outcome.request?.url,
    method: outcome.request?.method,
  };
  const assertion = operationAssertion(caseDef, engine);
  if (typeof assertion !== 'function') {
    throw new Error(`No assertion configured for ${caseDef.kind}:${caseDef.name} engine=${engine}`);
  }
  assertion(local, { engine });
  return outcome;
}

async function validateExpandOutcome(outcome, vsJson, opts = {}, engine = DEFAULT_ENGINE) {
  const {
    responseJson: body,
    ms,
    traceJson,
    irPlanText,
    error,
  } = outcome;
  if (error) {
    throw new Error(error);
  }
  if (!body) {
    throw new Error('Non-JSON response from terminology server');
  }
  if (body.resourceType === 'OperationOutcome') {
    throw new Error(body.issue?.[0]?.details?.text || JSON.stringify(body));
  }
  if (STRICT_TOTAL_CONSISTENCY) {
    assertTotalConsistency(body, opts, engine);
  }
  if (STRICT_IR_NO_FALLBACK && engine === 'ir') {
    const strictCheck = strictIRTraceCheck(traceJson);
    if (!strictCheck.ok) throw new Error(strictCheck.message);
  }
  if (SEMANTIC_PARITY && engine === 'ir') {
    try {
      await assertSemanticParity(vsJson, opts, body);
    } catch (e) {
      if (!shouldWaiveSemanticParity(currentTestName, e)) throw e;
      semanticParityWaivedTests.add(currentTestName);
    }
  }
  return { result: body, ms, traceJson, irPlanText };
}

function buildDebugSample(outcome, error = null) {
  return {
    ok: !error,
    ms: Math.round(outcome?.ms ?? 0),
    error: error ? (error.message || String(error)) : undefined,
    request: outcome?.request || null,
    response: outcome?.response || null,
    trace: outcome?.traceJson || null,
    traceAvailable: !!outcome?.traceJson,
    irPlanText: outcome?.irPlanText || null,
  };
}

async function expand(vsJson, opts = {}, engine = DEFAULT_ENGINE, forceTrace = null, baseUrl = BASE, timeoutMs = PERF_HTTP_TIMEOUT_MS) {
  lastPerfTarget = { kind: 'expand', vsJson, opts };
  const shouldForceTrace = forceTrace ?? (WANT_TRACE || (STRICT_IR_NO_FALLBACK && engine === 'ir'));
  const outcome = await executeExpandRequest(vsJson, opts, engine, shouldForceTrace, baseUrl, timeoutMs);
  if (!PERF_MODE) {
    setCaseArtifact({
      kind: 'expand',
      engine,
      baseUrl,
      request: outcome.request,
      response: outcome.response,
      responseJson: outcome.responseJson,
      trace: outcome.traceJson,
      irPlanText: outcome.irPlanText,
      ms: Math.round(outcome.ms ?? 0),
      error: outcome.error,
    });
  }
  return validateExpandOutcome(outcome, vsJson, opts, engine);
}

function codes(result) {
  const out = [];
  const walk = (c) => { for (const x of c || []) { out.push(x); walk(x.contains); } };
  walk(result.expansion?.contains);
  return out;
}

function findCode(result, code) {
  return codes(result).find(c => c.code === code);
}

function containsProperties(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.property)) return entry.property;
  const propExtUrl = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.expansion.contains.property';
  const out = [];
  for (const ext of entry.extension || []) {
    if (ext?.url !== propExtUrl || !Array.isArray(ext.extension)) continue;
    const code = ext.extension.find(e => e?.url === 'code')?.valueCode;
    const valueExt = ext.extension.find(e => e?.url === 'value');
    if (!code || !valueExt) continue;
    const prop = { code };
    for (const [k, v] of Object.entries(valueExt)) {
      if (k.startsWith('value') && k !== 'value') {
        prop[k] = v;
      }
    }
    out.push(prop);
  }
  return out;
}

function expansionParams(result, name) {
  return (result.expansion?.parameter || []).filter(p => p.name === name);
}

function hasExpansionParam(result, name, value) {
  const params = expansionParams(result, name);
  if (value === undefined) return params.length > 0;
  return params.some(p => (p.valueUri || p.valueString || p.valueCode || p.valueBoolean) === value);
}

function expansionExtensions(result, url) {
  return (result.expansion?.extension || []).filter(e => e.url === url);
}

async function runTxOperationCase(caseDef) {
  setOperationPerfTarget(caseDef);
  const supported = normalizeCaseEngines(caseDef);
  const engine = supported.includes(DEFAULT_ENGINE) ? DEFAULT_ENGINE : supported[0];
  if (!engine) {
    throw new Error(`No supported engines declared for ${caseDef.kind}:${caseDef.name}`);
  }
  const outcome = await executeOperationCase(caseDef, engine);
  setCaseArtifact({
    kind: caseDef.kind,
    engine,
    baseUrl: BASE,
    request: outcome.request,
    response: outcome.response,
    responseJson: outcome.responseJson,
    trace: outcome.traceJson,
    irPlanText: outcome.irPlanText,
    ms: Math.round(outcome.ms ?? 0),
    error: outcome.error,
  });
  if (outcome.error) {
    throw new Error(outcome.error);
  }
}

function inlineVS(url, include, exclude = null, overrides = {}) {
  const includeList = Array.isArray(include) ? include : [include];
  const excludeList = exclude == null ? null : (Array.isArray(exclude) ? exclude : [exclude]);
  return {
    resourceType: 'ValueSet',
    url,
    status: 'active',
    compose: {
      include: includeList,
      ...(excludeList ? { exclude: excludeList } : {}),
    },
    ...overrides,
  };
}

const ALLOWED_TEST_CATEGORIES = new Set([
  'Baseline Fixtures',
  'Compose Overrides',
  'Composition Semantics',
  'Concept Enumerations',
  'Clinical Workloads',
  'Cross-Source Coverage',
  'Designations & Language',
  'Exclusions',
  'Expansion Metadata',
  'Filter Semantics',
  'Hierarchy',
  'Lab Workloads',
  'Lookup',
  'Multi-System Composition',
  'Medication Workloads',
  'Pagination',
  'Pagination Safety',
  'Parameter Handling',
  'Property Filters',
  'Provider Execution',
  'Safety Limits',
  'Single-System Composition',
  'Stress & Scale',
  'Search',
  'Read',
  'Subsumes',
  'Subsumption',
  'Supplements',
  'Text Search',
  'Translate',
  'txResources',
  'Unclosed Expansion',
  'Validate',
  'ValueSet Imports',
]);

function validateTestMeta(meta) {
  if (!meta.name || !meta.rawName || !meta.category) {
    throw new Error(`Invalid test metadata: ${JSON.stringify(meta)}`);
  }
  if (!ALLOWED_TEST_CATEGORIES.has(meta.category)) {
    throw new Error(`Unknown test category "${meta.category}" for test "${meta.name}"`);
  }
  const weakPrefix = /^(meta|params|stress|shape|coverage|infra|filter|logic|combined|exclude|lang|compose|notClosed|limit|pagination-bug|unclosed):/i;
  if (weakPrefix.test(meta.name)) {
    throw new Error(`Weak test title prefix in "${meta.name}"`);
  }
}

function normalizeTestDef(def) {
  if (typeof def === 'string') {
    return {
      id: null,
      rawName: def,
      name: def,
      category: currentCategory || 'Uncategorized',
      perfOnly: false,
    };
  }
  const rawName = String(def?.rawName || def?.name || '').trim();
  const name = String(def?.name || rawName).trim();
  return {
    id: Number.isInteger(def?.id) ? def.id : null,
    rawName: rawName || name,
    name: name || rawName,
    category: String(def?.category || currentCategory || 'Uncategorized').trim(),
    perfOnly: !!def?.perfOnly,
  };
}

async function test(def, fn) {
  const meta = normalizeTestDef(def);
  validateTestMeta(meta);
  const filterHaystack = `${meta.rawName} ${meta.name} ${meta.category}`.toLowerCase();
  if (FILTERS.length > 0 && !FILTERS.some(f => filterHaystack.includes(f.toLowerCase()))) {
    skipped++;
    return;
  }
  const defKind = String(def?.kind || '').trim().toLowerCase();
  if (KIND_FILTERS.length > 0 && !KIND_FILTERS.some(kind => defKind === String(kind).trim().toLowerCase())) {
    skipped++;
    return;
  }
  const metaCategory = String(meta.category || '').trim().toLowerCase();
  if (CATEGORY_FILTERS.length > 0 && !CATEGORY_FILTERS.some(category => metaCategory === String(category).trim().toLowerCase())) {
    skipped++;
    return;
  }
  if (meta.perfOnly && !PERF_MODE) {
    skipped++;
    return;
  }
  lastPerfTarget = null;
  resetCaseArtifact();
  currentTestName = meta.rawName;
  try {
    const t0 = performance.now();
    await fn();
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`  \x1b[32m✓\x1b[0m ${meta.name} (${ms}ms)`);
    passed++;

    // In perf mode, re-run the last recorded target with configured engine columns.
    if (PERF_MODE && lastPerfTarget) {
      const ir = await timePerfTarget(lastPerfTarget, 'ir', PERF_RUNS);
      const upstream = await timePerfTarget(lastPerfTarget, 'legacy', PERF_RUNS);
      const third = PERF_THIRD_ENABLED
        ? await timePerfTargetAtBase(lastPerfTarget, PERF_THIRD_ENGINE, PERF_RUNS, PERF_THIRD_BASE_URL)
        : null;
      const rowIndex = meta.id ?? (perfRows.length + 1);
      let detailHref = null;
      let inputHref = null;
      let detailJsonHref = null;
      let detailError = null;
      try {
        const detail = await capturePerfDetails(rowIndex, meta.name, meta.category, lastPerfTarget, ir, upstream, third);
        detailHref = detail.href;
        inputHref = detail.inputHref;
        detailJsonHref = detail.detailJsonHref;
      } catch (e) {
        detailError = e.message || String(e);
      }
      perfRows.push({
        id: rowIndex,
        rawName: meta.rawName,
        name: meta.name,
        category: meta.category,
        kind: lastPerfTarget.kind,
        irMs: ir.ms,
        upstreamMs: upstream.ms,
        thirdMs: third?.ms ?? null,
        irErr: ir.err,
        upstreamErr: upstream.err,
        thirdErr: third?.err ?? null,
        irSupported: ir.supported !== false,
        upstreamSupported: upstream.supported !== false,
        thirdSupported: third == null ? null : third.supported !== false,
        detailHref,
        detailJsonHref,
        inputHref,
        detailError,
      });
      const fmt = (result) => {
        if (!result || result.supported === false) return 'n/a';
        return result.err ? '❌' : `${result.ms}ms`;
      };
      const irStr = fmt(ir);
      const upstreamStr = fmt(upstream);
      const thirdStr = fmt(third);
      console.log(`    perf: ${PERF_PRIMARY_LABEL}=${irStr}  ${PERF_SECONDARY_LABEL}=${upstreamStr}  ${PERF_THIRD_LABEL}=${thirdStr}`);
      if (detailError) console.log(`    details: ❌ ${detailError}`);
    }
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${meta.name}`);
    console.log(`    ${e.message}`);
    failed++;
    if (!PERF_MODE) {
      const artifact = lastCaseArtifact || {};
      const rowIndex = meta.id ?? (matrixRows.length + 1);
      let detail = null;
      try {
        detail = await writeMatrixArtifacts(rowIndex, meta, lastPerfTarget, artifact, e);
      } catch {
        // keep summary even if artifact writing fails
      }
      matrixRows.push({
        id: rowIndex,
        rawName: meta.rawName,
        name: meta.name,
        category: meta.category,
        kind: artifact.kind || lastPerfTarget?.kind || defKind || 'unknown',
        ok: false,
        primaryMs: detail?.primaryMs ?? null,
        primarySummary: detail?.primarySummary || 'n/a',
        secondaryMs: detail?.secondaryMs ?? null,
        secondarySummary: detail?.secondarySummary || 'n/a',
        thirdMs: detail?.thirdMs ?? null,
        thirdSummary: detail?.thirdSummary ?? null,
        detailHref: detail?.href || null,
        detailJsonHref: detail?.detailJsonHref || null,
        inputHref: detail?.inputHref || null,
      });
    }
  } finally {
    if (!PERF_MODE && lastCaseArtifact && failed >= 0) {
      const alreadyRecorded = matrixRows.length > 0
        && matrixRows[matrixRows.length - 1].rawName === meta.rawName;
      if (!alreadyRecorded) {
        const artifact = lastCaseArtifact;
        const rowIndex = meta.id ?? (matrixRows.length + 1);
        let detail = null;
        try {
          detail = await writeMatrixArtifacts(rowIndex, meta, lastPerfTarget, artifact, null);
        } catch {
          // keep summary even if artifact writing fails
        }
        matrixRows.push({
          id: rowIndex,
          rawName: meta.rawName,
          name: meta.name,
          category: meta.category,
          kind: artifact.kind || lastPerfTarget?.kind || defKind || 'unknown',
          ok: true,
          primaryMs: detail?.primaryMs ?? null,
          primarySummary: detail?.primarySummary || 'n/a',
          secondaryMs: detail?.secondaryMs ?? null,
          secondarySummary: detail?.secondarySummary || 'n/a',
          thirdMs: detail?.thirdMs ?? null,
          thirdSummary: detail?.thirdSummary ?? null,
          detailHref: detail?.href || null,
          detailJsonHref: detail?.detailJsonHref || null,
          inputHref: detail?.inputHref || null,
        });
      }
    }
    currentTestName = null;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`); }
function findParams(result, name) {
  return (result?.expansion?.parameter || []).filter(p => p.name === name);
}
function params(parameter) {
  return { resourceType: 'Parameters', parameter };
}

function getParam(body, name) {
  return (body?.parameter || []).find((param) => param.name === name);
}

// ── perf collection ────────────────────────────────────────────────────
const perfRows = [];  // { name, category, irMs, upstreamMs, thirdMs, irErr, upstreamErr, thirdErr, detailHref, inputHref }
const matrixRows = []; // { id, name, category, kind, summary, request, local, detailHref, inputHref, detailJsonHref }
let currentCategory = '';
let lastPerfTarget = null;  // generic matrix target for expand/op cases
let lastCaseArtifact = null;

function setPerfTarget(vsJson, opts = {}) {
  lastPerfTarget = { kind: 'expand', vsJson, opts };
}

function setOperationPerfTarget(caseDef) {
  lastPerfTarget = { kind: caseDef.kind, requestFamily: 'tx-op', caseDef };
}

function setCaseArtifact(artifact) {
  lastCaseArtifact = artifact;
}

function resetCaseArtifact() {
  lastCaseArtifact = null;
}

function summarizeMatrixArtifact(kind, local) {
  if (!local) return 'n/a';
  const status = local.response?.status ?? local.status ?? 'n/a';
  const body = local.response?.body ?? local.body ?? null;
  if (kind === 'expand') {
    if (!body || body.resourceType === 'OperationOutcome') {
      const text = body?.issue?.[0]?.details?.text || local.error || '-';
      return `${status} ${text}`;
    }
    const total = body?.expansion?.total;
    const count = codes(body).length;
    return `${status} total=${total == null ? '-' : total} contains=${count}`;
  }
  if (kind === 'lookup') {
    const display = getParam(body, 'display')?.valueString || '-';
    const props = (body?.parameter || []).filter((p) => p.name === 'property').length;
    return `${status} display=${display} props=${props}`;
  }
  if (kind === 'validate') {
    const result = getParam(body, 'result')?.valueBoolean;
    const display = getParam(body, 'display')?.valueString || '-';
    const message = getParam(body, 'message')?.valueString;
    return `${status} result=${String(result)} display=${display}${message ? ` message=${message}` : ''}`;
  }
  return String(status);
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function timeExpandEngine(vsJson, opts, engine, runs, baseUrl = BASE, timeoutMs = PERF_HTTP_TIMEOUT_MS) {
  const times = [];
  let sample = null;
  for (let i = 0; i < runs; i++) {
    const wantTrace = i === 0;
    const outcome = await executeExpandRequest(vsJson, opts, engine, wantTrace, baseUrl, timeoutMs);
    try {
      const { ms } = await validateExpandOutcome(outcome, vsJson, opts, engine);
      times.push(ms);
      if (!sample) sample = buildDebugSample(outcome);
    } catch (e) {
      if (!sample) sample = buildDebugSample(outcome, e);
      if (STRICT_IR_NO_FALLBACK && engine === 'ir') throw e;
      return { ms: null, err: true, sample };
    }
  }
  return { ms: Math.round(median(times)), err: false, sample };
}

async function timeOperationCaseEngine(caseDef, engine, runs, baseUrl = BASE, timeoutMs = PERF_HTTP_TIMEOUT_MS) {
  if (!caseSupportsEngine(caseDef, engine)) {
    return { ms: null, err: false, sample: null, supported: false };
  }
  const times = [];
  let sample = null;
  for (let i = 0; i < runs; i++) {
    const spec = injectEngineIntoOperationSpec(caseDef.request, engine);
    const outcome = await executeOperationRequest(spec, baseUrl, timeoutMs);
    try {
      if (outcome.error) throw new Error(outcome.error);
      const local = {
        status: outcome.response?.status ?? null,
        body: outcome.responseJson,
        headers: outcome.response?.headers || {},
        responseText: outcome.responseText,
        url: outcome.request?.url,
        method: outcome.request?.method,
      };
      const assertion = operationAssertion(caseDef, engine);
      if (typeof assertion !== 'function') {
        throw new Error(`No assertion configured for ${caseDef.kind}:${caseDef.name} engine=${engine}`);
      }
      assertion(local, { engine });
      times.push(outcome.ms);
      if (!sample) sample = buildDebugSample(outcome);
    } catch (e) {
      if (!sample) sample = buildDebugSample(outcome, e);
      return { ms: null, err: true, sample, supported: true };
    }
  }
  return { ms: Math.round(median(times)), err: false, sample, supported: true };
}

async function timePerfTarget(target, engine, runs, baseUrl = BASE) {
  if (!target) return { ms: null, err: true, sample: null, supported: false };
  const timeoutMs = baseUrl === PERF_THIRD_BASE_URL ? PERF_THIRD_HTTP_TIMEOUT_MS : PERF_HTTP_TIMEOUT_MS;
  if (target.requestFamily === 'tx-op') {
    return timeOperationCaseEngine(target.caseDef, engine, runs, baseUrl, timeoutMs);
  }
  return timeExpandEngine(target.vsJson, target.opts, engine, runs, baseUrl, timeoutMs);
}

function expandUrlForBase(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/r4/ValueSet/$expand`;
}

async function timePerfTargetAtBase(target, engine, runs, baseUrl) {
  return timePerfTarget(target, engine, runs, baseUrl);
}

function safeSlug(name) {
  return String(name || 'test')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'test';
}

function summarizePerfResult(result) {
  return {
    ms: result?.ms ?? null,
    err: !!result?.err,
    supported: result?.supported !== false,
  };
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

function serializeJsonForHtml(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildPerfDetailHtml(detailDoc) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Perf Detail: ${escHtml(detailDoc.name)}</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #f7f8fa; color: #111; }
  header { padding: 14px 18px; background: #fff; border-bottom: 1px solid #ddd; position: sticky; top: 0; z-index: 2; }
  h1 { margin: 0 0 4px 0; font-size: 1.05rem; }
  .meta { color: #555; font-size: 0.9rem; }
  .links { margin-top: 6px; font-size: 0.9rem; }
  .links a { margin-right: 10px; }
  .grid { display: grid; gap: 10px; padding: 10px; align-items: stretch; }
  .engine-card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 10px; min-width: 0; }
  .engine-card h3 { margin: 0 0 4px 0; }
  .meta-mini { margin: 0; color: #666; font-size: 0.85rem; }
  .cell { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 10px; min-width: 0; }
  details { margin: 0; border: 1px solid #e2e2e2; border-radius: 6px; padding: 6px 8px; background: #fafafa; }
  summary { cursor: pointer; font-weight: 600; }
  pre { margin: 8px 0 0; max-height: 42vh; overflow: auto; background: #fff; border: 1px solid #e8e8e8; padding: 8px; border-radius: 6px; }
  @media (max-width: 1280px) { .grid { grid-template-columns: 1fr !important; } }
</style></head><body>
<header>
  <h1 id="perf-detail-title"></h1>
  <div class="meta" id="perf-detail-meta"></div>
  <div class="links" id="perf-detail-links"></div>
</header>
<main class="grid" id="perf-detail-grid"></main>
<script type="application/json" id="perf-detail-data">${serializeJsonForHtml(detailDoc)}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('perf-detail-data').textContent);
  const esc = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const stringify = (value) => {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };
  const perfStr = (perf) => {
    if (!perf || perf.supported === false) return 'n/a';
    return perf.err ? '❌' : \`\${perf.ms}ms\`;
  };
  const targets = data.targets || [];
  const summaryPerf = targets.map((target) => \`\${target.label}=\${perfStr(target.perf)}\`).join(' | ');
  document.title = \`Perf Detail: \${data.name}\`;
  document.getElementById('perf-detail-title').textContent = \`#\${data.rowIndex} \${data.name}\`;
  document.getElementById('perf-detail-meta').textContent = \`Category: \${data.category} · Median perf: \${summaryPerf}\`;

  const links = [];
  for (const target of targets) {
    links.push(\`<a href="#\${target.key}-query">\${esc(target.label)} query</a>\`);
    links.push(\`<a href="#\${target.key}-plan">\${esc(target.label)} plan</a>\`);
    links.push(\`<a href="#\${target.key}-trace">\${esc(target.label)} trace</a>\`);
    links.push(\`<a href="#\${target.key}-http">\${esc(target.label)} response</a>\`);
  }
  if (data.hrefs?.input) {
    links.push(\`<a href="\${esc(data.hrefs.input)}" target="_blank" rel="noopener">Input payload</a>\`);
  }
  if (data.hrefs?.detailJson) {
    links.push(\`<a href="\${esc(data.hrefs.detailJson)}" target="_blank" rel="noopener">Detail JSON</a>\`);
  }
  document.getElementById('perf-detail-links').innerHTML = links.join(' ');

  const grid = document.getElementById('perf-detail-grid');
  grid.style.gridTemplateColumns = targets.length === 3 ? '1fr 1fr 1fr' : '1fr 1fr';

  const cardsHtml = targets.map((target) => {
    const debug = target.debug || {};
    const traceMs = debug?.trace?.totalMs;
    const timing = target.supported === false ? 'not exercised for this case' : (debug?.ok ? \`\${debug.ms}ms capture wall\` : 'capture failed');
    const status = target.supported === false ? 'n/a' : (debug?.response ? \`\${debug.response.status} \${debug.response.statusText || ''}\`.trim() : 'n/a');
    return \`<section class="engine-card">
      <h3>\${esc(target.label)}</h3>
      <p class="meta-mini">capture: \${esc(timing)}\${traceMs != null ? \` · trace: \${esc(String(traceMs))}ms\` : ''} · response: \${esc(status)}</p>
    </section>\`;
  }).join('');

  const sectionRows = ['query', 'plan', 'trace', 'http'].map((section) => {
    return targets.map((target) => {
      const debug = target.debug || {};
      let label = '';
      let content = '';
      if (section === 'query') {
        label = 'Query / HTTP Request';
        content = target.supported === false ? 'N/A for this case' : stringify(debug?.request || {});
      } else if (section === 'plan') {
        label = 'IR Plan';
        content = target.supported === false ? 'N/A for this case' : (debug?.irPlanText || 'N/A for this target');
      } else if (section === 'trace') {
        label = 'Structured Trace';
        content = target.supported === false ? 'N/A for this case' : (debug?.traceAvailable ? stringify(debug.trace) : 'No structured trace payload returned.');
      } else {
        label = 'HTTP Response';
        content = target.supported === false ? 'N/A for this case' : stringify(debug?.response || { error: debug?.error || 'No response captured' });
      }
      return \`<section class="cell">
        <details id="\${target.key}-\${section}" open>
          <summary>\${esc(label)}</summary>
          <pre>\${esc(content)}</pre>
        </details>
      </section>\`;
    }).join('');
  }).join('');

  grid.innerHTML = cardsHtml + sectionRows;
})();
</script>
</body></html>`;
}

async function capturePerfDetails(rowIndex, name, category, target, primaryPerf, secondaryPerf, thirdPerf = null) {
  const slug = `${String(rowIndex).padStart(3, '0')}-${safeSlug(name)}`;
  const filename = `${slug}.html`;
  const absPath = join(PERF_DETAILS_DIR, filename);
  const relPath = `${PERF_OUT_BASE}.details/${filename}`;
  const detailJsonFilename = `${slug}.json`;
  const detailJsonAbsPath = join(PERF_DETAILS_DIR, detailJsonFilename);
  const detailJsonRelPath = `${PERF_OUT_BASE}.details/${detailJsonFilename}`;
  const inputFilename = `${slug}.json`;
  const inputAbsPath = join(PERF_INPUTS_DIR, inputFilename);
  const inputRelPath = `${PERF_OUT_BASE}.inputs/${inputFilename}`;
  const primaryDebug = primaryPerf?.sample || null;
  const secondaryDebug = secondaryPerf?.sample || null;
  const thirdDebug = thirdPerf?.sample || null;
  const targetSource = target?.requestFamily === 'tx-op'
    ? {
        shape: 'request',
        kind: target.caseDef?.kind || null,
        request: stripEngineFromOperationSpec(target.caseDef?.request || {}),
        engines: normalizeCaseEngines(target.caseDef || {}),
      }
    : {
        shape: 'request',
        kind: 'expand',
        valueSet: target?.vsJson || null,
        options: target?.opts || {},
      };
  const payloadDoc = {
    schemaVersion: PERF_ARTIFACT_SCHEMA_VERSION,
    id: rowIndex,
    slug,
    name,
    category,
    source: targetSource,
    requests: {
      primary: primaryDebug?.request || null,
      secondary: secondaryDebug?.request || null,
      third: thirdDebug?.request || null,
    },
  };
  const detailDoc = {
    schemaVersion: PERF_ARTIFACT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    rowIndex,
    slug,
    name,
    category,
    hrefs: {
      input: `../${PERF_OUT_BASE}.inputs/${inputFilename}`,
      detailJson: detailJsonFilename,
    },
    targets: [
      {
        key: 'primary',
        label: PERF_PRIMARY_LABEL,
        hasPlan: target?.kind === 'expand',
        perf: summarizePerfResult(primaryPerf),
        debug: primaryDebug,
        supported: primaryPerf?.supported !== false,
      },
      {
        key: 'secondary',
        label: PERF_SECONDARY_LABEL,
        hasPlan: false,
        perf: summarizePerfResult(secondaryPerf),
        debug: secondaryDebug,
        supported: secondaryPerf?.supported !== false,
      },
      ...(thirdPerf
        ? [{
            key: 'third',
            label: PERF_THIRD_LABEL,
            hasPlan: false,
            perf: summarizePerfResult(thirdPerf),
            debug: thirdDebug,
            supported: thirdPerf?.supported !== false,
          }]
        : []),
    ],
  };
  writeFileSync(inputAbsPath, JSON.stringify(payloadDoc, null, 2));
  writeFileSync(detailJsonAbsPath, JSON.stringify(detailDoc, null, 2));
  writeFileSync(absPath, buildPerfDetailHtml(detailDoc));
  return { href: relPath, inputHref: inputRelPath, detailJsonHref: detailJsonRelPath };
}

// ── tests ──────────────────────────────────────────────────────────────
async function run() {
  if (PERF_MODE) {
    mkdirSync(PERF_DETAILS_DIR, { recursive: true });
    mkdirSync(PERF_INPUTS_DIR, { recursive: true });
  }

  // Check server is up
  try {
    const r = await fetch(`${EXPAND}?url=${SYS.SCT}?fhir_vs=isa/73211009&count=1&_engine=ir`);
    if (!r.ok) throw new Error();
  } catch { console.error('Server not reachable at', BASE); process.exit(1); }

  const harnessHelpers = {
    expand,
    vs,
    withExactTotal,
    codes,
    findCode,
    containsProperties,
    expansionParams,
    hasExpansionParam,
    expansionExtensions,
    setPerfTarget,
    assert,
    eq,
    findParams,
    params,
    inlineVS,
    SYS,
    EXACT_TOTAL_PARAM,
    HARNESS_SQLITE_SUPP_URL_ROOT,
    assertBulkDesignationTrace,
    assertCompilerMaterializationTrace,
    assertCountOnlyTraceBehavior,
    traceHasSpan,
  };
  const setCategory = (value) => {
    currentCategory = value;
  };
  const shouldRunOperationCase = (caseDef) => PERF_MODE || caseSupportsEngine(caseDef, DEFAULT_ENGINE);
  const skipCase = () => {
    skipped++;
  };

  await registerHarnessCases({
    test,
    helpers: harnessHelpers,
    setCategory,
    runTxOperationCase,
    shouldRunOperationCase,
    skipCase,
  });

  // ── summary ──────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);

  console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, ${skipped} skipped`);
  if (SEMANTIC_PARITY && semanticParityWaivedTests.size > 0) {
    console.log(`  semantic parity waived for ${semanticParityWaivedTests.size} known legacy-drain cases`);
  }
  console.log('='.repeat(50));

  if (PERF_MODE && perfRows.length > 0) {
    mkdirSync(dirname(PERF_OUT_PATH), { recursive: true });
    const generatedAt = new Date();
    const generatedAtDisplay = generatedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const hasThird = perfRows.some(r => r.thirdMs != null || r.thirdErr != null);
    const catalog = {
      schemaVersion: PERF_ARTIFACT_SCHEMA_VERSION,
      generatedAt: generatedAt.toISOString(),
      generatedAtDisplay,
      perfRuns: PERF_RUNS,
      hasThird,
      labels: {
        primary: PERF_PRIMARY_LABEL,
        secondary: PERF_SECONDARY_LABEL,
        third: PERF_THIRD_LABEL,
      },
      catalogHref: `${PERF_OUT_BASE}.catalog.json`,
      detailsDirLabel: `${PERF_OUT_BASE}.details/`,
      inputsDirLabel: `${PERF_OUT_BASE}.inputs/`,
      rows: perfRows.map(r => ({
        id: r.id,
        category: r.category,
        name: r.name,
        rawName: r.rawName,
        kind: r.kind,
        irMs: r.irMs,
        upstreamMs: r.upstreamMs,
        thirdMs: r.thirdMs,
        irError: !!r.irErr,
        upstreamError: !!r.upstreamErr,
        thirdError: r.thirdErr == null ? null : !!r.thirdErr,
        irSupported: r.irSupported !== false,
        upstreamSupported: r.upstreamSupported !== false,
        thirdSupported: r.thirdSupported,
        detailHref: r.detailHref || null,
        detailJsonHref: r.detailJsonHref || null,
        inputHref: r.inputHref || null,
        detailError: r.detailError || null,
      })),
    };
    writeFileSync(PERF_CATALOG_PATH, JSON.stringify(catalog, null, 2));
    writeFileSync(PERF_OUT_PATH, buildPerfHtml(catalog));
    console.log(`\nPerf table written to ${PERF_OUT_PATH} (${perfRows.length} rows)`);
    console.log(`Perf detail pages written to ${PERF_DETAILS_DIR}`);
    console.log(`Perf input payloads written to ${PERF_INPUTS_DIR}`);
    console.log(`Perf catalog written to ${PERF_CATALOG_PATH}`);
  }

  if (!PERF_MODE && matrixRows.length > 0) {
    mkdirSync(dirname(MATRIX_OUT_PATH), { recursive: true });
    const generatedAt = new Date();
    const generatedAtDisplay = generatedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const catalog = {
      generatedAt: generatedAt.toISOString(),
      generatedAtDisplay,
      hasThird: matrixRows.some((row) => row.thirdSummary != null),
      labels: {
        primary: PERF_PRIMARY_LABEL,
        secondary: PERF_SECONDARY_LABEL,
        third: PERF_THIRD_LABEL,
      },
      rows: matrixRows.map((row) => ({
        id: row.id,
        rawName: row.rawName,
        name: row.name,
        category: row.category,
        kind: row.kind,
        ok: row.ok,
        primaryMs: row.primaryMs ?? null,
        primarySummary: row.primarySummary || 'n/a',
        secondaryMs: row.secondaryMs ?? null,
        secondarySummary: row.secondarySummary || 'n/a',
        thirdMs: row.thirdMs ?? null,
        thirdSummary: row.thirdSummary ?? null,
        detailHref: row.detailHref || null,
        detailJsonHref: row.detailJsonHref || null,
        inputHref: row.inputHref || null,
      })),
    };
    writeFileSync(MATRIX_CATALOG_PATH, JSON.stringify(catalog, null, 2));
    writeFileSync(MATRIX_OUT_PATH, buildMatrixHtml(catalog));
    console.log(`Matrix written to ${MATRIX_OUT_PATH} (${matrixRows.length} rows)`);
    console.log(`Matrix detail pages written to ${MATRIX_DETAILS_DIR}`);
    console.log(`Matrix input payloads written to ${MATRIX_INPUTS_DIR}`);
    console.log(`Matrix catalog written to ${MATRIX_CATALOG_PATH}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

function buildMatrixDetailHtml(detailDoc) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Execution details: ${escHtml(detailDoc.name)}</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #f7f8fa; color: #111; }
  header { padding: 14px 18px; background: #fff; border-bottom: 1px solid #ddd; position: sticky; top: 0; z-index: 2; }
  h1 { margin: 0 0 4px 0; font-size: 1.05rem; }
  .meta { color: #555; font-size: 0.9rem; }
  .links { margin-top: 6px; font-size: 0.9rem; }
  .links a { margin-right: 10px; }
  .grid { display: grid; gap: 10px; padding: 10px; align-items: stretch; }
  .engine-card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 10px; min-width: 0; }
  .engine-card h3 { margin: 0 0 4px 0; }
  .meta-mini { margin: 0; color: #666; font-size: 0.85rem; }
  .cell { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 10px; min-width: 0; }
  details { margin: 0; border: 1px solid #e2e2e2; border-radius: 6px; padding: 6px 8px; background: #fafafa; }
  summary { cursor: pointer; font-weight: 600; }
  pre { margin: 8px 0 0; max-height: 42vh; overflow: auto; background: #fff; border: 1px solid #e8e8e8; padding: 8px; border-radius: 6px; }
  @media (max-width: 1280px) { .grid { grid-template-columns: 1fr !important; } }
</style></head><body>
<header>
  <h1 id="tx-detail-title"></h1>
  <div class="meta" id="tx-detail-meta"></div>
  <div class="links" id="tx-detail-links"></div>
</header>
<main class="grid" id="tx-detail-grid"></main>
<script type="application/json" id="tx-detail-data">${serializeJsonForHtml(detailDoc)}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('tx-detail-data').textContent);
  const esc = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const stringify = (value) => {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };
  const targets = data.targets || [];
  document.title = \`Execution details: \${data.name}\`;
  document.getElementById('tx-detail-title').textContent = \`#\${data.rowIndex} \${data.name}\`;
  document.getElementById('tx-detail-meta').textContent = \`Category: \${data.category} · Kind: \${data.kind} · Result: \${targets.map((target) => \`\${target.label}=\${target.summary || 'n/a'}\`).join(' | ')}\`;

  const links = [];
  for (const target of targets) {
    links.push(\`<a href="#\${target.key}-query">\${esc(target.label)} query</a>\`);
    links.push(\`<a href="#\${target.key}-plan">\${esc(target.label)} plan</a>\`);
    links.push(\`<a href="#\${target.key}-trace">\${esc(target.label)} trace</a>\`);
    links.push(\`<a href="#\${target.key}-http">\${esc(target.label)} response</a>\`);
  }
  if (data.hrefs?.input) {
    links.push(\`<a href="\${esc(data.hrefs.input)}" target="_blank" rel="noopener">Input payload</a>\`);
  }
  if (data.hrefs?.detailJson) {
    links.push(\`<a href="\${esc(data.hrefs.detailJson)}" target="_blank" rel="noopener">Detail JSON</a>\`);
  }
  document.getElementById('tx-detail-links').innerHTML = links.join(' ');

  const grid = document.getElementById('tx-detail-grid');
  grid.style.gridTemplateColumns = targets.length === 3 ? '1fr 1fr 1fr' : (targets.length === 2 ? '1fr 1fr' : '1fr');

  const cardsHtml = targets.map((target) => {
    const debug = target.debug || {};
    const traceMs = debug?.trace?.totalMs;
    const timing = target.supported === false ? 'not exercised for this case' : (debug?.ok ? \`\${debug.ms}ms capture wall\` : 'capture failed');
    const status = target.supported === false ? 'n/a' : (debug?.response ? \`\${debug.response.status} \${debug.response.statusText || ''}\`.trim() : 'n/a');
    return \`<section class="engine-card">
      <h3>\${esc(target.label)}</h3>
      <p class="meta-mini">summary: \${esc(target.summary || 'n/a')}</p>
      <p class="meta-mini">capture: \${esc(timing)}\${traceMs != null ? \` · trace: \${esc(String(traceMs))}ms\` : ''} · response: \${esc(status)}</p>
    </section>\`;
  }).join('');

  const sectionRows = ['query', 'plan', 'trace', 'http'].map((section) => {
    return targets.map((target) => {
      const debug = target.debug || {};
      let label = '';
      let content = '';
      if (section === 'query') {
        label = 'Query / HTTP Request';
        content = target.supported === false ? 'N/A for this case' : stringify(debug?.request || {});
      } else if (section === 'plan') {
        label = 'IR Plan';
        content = target.supported === false ? 'N/A for this case' : (debug?.irPlanText || 'N/A for this target');
      } else if (section === 'trace') {
        label = 'Structured Trace';
        content = target.supported === false ? 'N/A for this case' : (debug?.traceAvailable ? stringify(debug.trace) : 'No structured trace payload returned.');
      } else {
        label = 'HTTP Response';
        content = target.supported === false ? 'N/A for this case' : stringify(debug?.response || { error: debug?.error || 'No response captured' });
      }
      return \`<section class="cell">
        <details id="\${target.key}-\${section}" open>
          <summary>\${esc(label)}</summary>
          <pre>\${esc(content)}</pre>
        </details>
      </section>\`;
    }).join('');
  }).join('');

  grid.innerHTML = cardsHtml + sectionRows;
})();
</script>
</body></html>`;
}

function buildMatrixHtml(catalogDoc) {
  const hasThird = !!catalogDoc.hasThird;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>TX Matrix</title>
<style>
body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 1400px; margin: 2em auto; padding: 0 1em; }
h1 { font-size: 1.3em; }
.meta { color: #666; font-size: 0.85em; margin-bottom: 1em; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 6px 10px; border: 1px solid #ddd; text-align: left; vertical-align: top; }
th { background: #f5f5f5; }
.ok { background: #e8f5e9; }
.err { background: #fff3e0; }
.muted { color: #777; }
</style></head><body>
<h1>TX Matrix</h1>
<p class="meta">Generated ${escHtml(catalogDoc.generatedAtDisplay)}</p>
<table>
<thead><tr><th>Category</th><th>Operation</th><th>Case</th><th>${escHtml(catalogDoc.labels?.primary || 'Primary')} time</th><th>${escHtml(catalogDoc.labels?.primary || 'Primary')} result</th><th>${escHtml(catalogDoc.labels?.secondary || 'Secondary')} time</th><th>${escHtml(catalogDoc.labels?.secondary || 'Secondary')} result</th>${hasThird ? `<th>${escHtml(catalogDoc.labels?.third || 'Third')} time</th><th>${escHtml(catalogDoc.labels?.third || 'Third')} result</th>` : ''}<th>Details</th><th>Inputs</th></tr></thead>
<tbody>
${(catalogDoc.rows || []).map((row) => `<tr class="${row.ok ? 'ok' : 'err'}"><td>${escHtml(row.category)}</td><td>${escHtml(row.kind)}</td><td>${escHtml(row.name)}</td><td>${escHtml(row.primaryMs != null ? `${row.primaryMs}ms` : 'n/a')}</td><td>${escHtml(row.primarySummary || 'n/a')}</td><td>${escHtml(row.secondaryMs != null ? `${row.secondaryMs}ms` : 'n/a')}</td><td>${escHtml(row.secondarySummary || 'n/a')}</td>${hasThird ? `<td>${escHtml(row.thirdMs != null ? `${row.thirdMs}ms` : 'n/a')}</td><td>${escHtml(row.thirdSummary || 'n/a')}</td>` : ''}<td>${row.detailHref ? `<a href="${escHtml(row.detailHref)}" target="_blank" rel="noopener">Execution details</a>` : '<span class="muted">n/a</span>'}</td><td>${row.inputHref ? `<a href="${escHtml(row.inputHref)}" target="_blank" rel="noopener">Input JSON</a>` : '<span class="muted">n/a</span>'}</td></tr>`).join('')}
</tbody></table>
</body></html>`;
}

function matrixTargetSpecs(target) {
  const requestFamily = target?.requestFamily;
  const supports = (engine) => {
    if (requestFamily !== 'tx-op') return true;
    return caseSupportsEngine(target.caseDef, engine);
  };
  return [
    {
      key: 'primary',
      label: PERF_PRIMARY_LABEL,
      engine: 'ir',
      baseUrl: BASE,
      hasPlan: requestFamily !== 'tx-op',
      supported: supports('ir'),
    },
    {
      key: 'secondary',
      label: PERF_SECONDARY_LABEL,
      engine: 'legacy',
      baseUrl: BASE,
      hasPlan: false,
      supported: supports('legacy'),
    },
    ...(PERF_THIRD_BASE_URL
      ? [{
          key: 'third',
          label: PERF_THIRD_LABEL,
          engine: PERF_THIRD_ENGINE,
          baseUrl: PERF_THIRD_BASE_URL,
          hasPlan: false,
          supported: supports(PERF_THIRD_ENGINE),
        }]
      : []),
  ];
}

function buildSampleFromArtifact(artifact, assertionError = null) {
  return {
    ok: !artifact?.error && !assertionError,
    ms: Math.round(artifact?.ms ?? 0),
    error: assertionError ? (assertionError.message || String(assertionError)) : (artifact?.error || undefined),
    request: artifact?.request || null,
    response: artifact?.response || null,
    trace: artifact?.trace || null,
    traceAvailable: !!artifact?.trace,
    irPlanText: artifact?.irPlanText || null,
  };
}

function artifactMatchesTarget(artifact, spec) {
  if (!artifact || !spec) return false;
  return (artifact.engine || null) === spec.engine && (artifact.baseUrl || BASE) === spec.baseUrl;
}

function summarizeSample(kind, sample) {
  return summarizeMatrixArtifact(kind, {
    status: sample?.response?.status ?? null,
    response: sample?.response || null,
    body: sample?.response?.body,
    error: sample?.error || null,
  });
}

async function captureMatrixTargetDebug(target, spec, currentArtifact, currentAssertionError) {
  if (spec.supported === false) {
    return {
      key: spec.key,
      label: spec.label,
      hasPlan: spec.hasPlan,
      supported: false,
      summary: 'n/a',
      debug: null,
    };
  }

  if (artifactMatchesTarget(currentArtifact, spec)) {
    const debug = buildSampleFromArtifact(currentArtifact, currentAssertionError);
    return {
      key: spec.key,
      label: spec.label,
      hasPlan: spec.hasPlan,
      supported: true,
      summary: summarizeSample(target.kind, debug),
      debug,
    };
  }

  if (target.requestFamily === 'tx-op') {
    const specWithEngine = injectTraceIntoOperationSpec(injectEngineIntoOperationSpec(target.caseDef.request, spec.engine));
    const timeoutMs = spec.baseUrl === PERF_THIRD_BASE_URL ? PERF_THIRD_HTTP_TIMEOUT_MS : PERF_HTTP_TIMEOUT_MS;
    const outcome = await executeOperationRequest(specWithEngine, spec.baseUrl, timeoutMs);
    let assertionError = null;
    try {
      if (outcome.error) throw new Error(outcome.error);
      const response = {
        status: outcome.response?.status ?? null,
        body: outcome.responseJson,
        headers: outcome.response?.headers || {},
        responseText: outcome.responseText,
        url: outcome.request?.url,
        method: outcome.request?.method,
      };
      const assertion = operationAssertion(target.caseDef, spec.engine);
      if (typeof assertion === 'function') assertion(response, { engine: spec.engine });
    } catch (e) {
      assertionError = e;
    }
    const debug = buildDebugSample(outcome, assertionError);
    return {
      key: spec.key,
      label: spec.label,
      hasPlan: false,
      supported: true,
      summary: summarizeSample(target.caseDef.kind, debug),
      debug,
    };
  }

  const timeoutMs = spec.baseUrl === PERF_THIRD_BASE_URL ? PERF_THIRD_HTTP_TIMEOUT_MS : PERF_HTTP_TIMEOUT_MS;
  const outcome = await executeExpandRequest(target.vsJson, target.opts, spec.engine, true, spec.baseUrl, timeoutMs);
  let assertionError = null;
  try {
    await validateExpandOutcome(outcome, target.vsJson, target.opts, spec.engine);
  } catch (e) {
    assertionError = e;
  }
  const debug = buildDebugSample(outcome, assertionError);
  return {
    key: spec.key,
    label: spec.label,
    hasPlan: spec.hasPlan,
    supported: true,
    summary: summarizeSample('expand', debug),
    debug,
  };
}

async function writeMatrixArtifacts(rowIndex, meta, target, artifact, assertionError) {
  mkdirSync(MATRIX_DETAILS_DIR, { recursive: true });
  mkdirSync(MATRIX_INPUTS_DIR, { recursive: true });
  const slug = `${String(rowIndex).padStart(3, '0')}-${slugify(meta.name)}`;
  const detailFilename = `${slug}.html`;
  const detailJsonFilename = `${slug}.json`;
  const inputFilename = `${slug}.json`;
  const detailRel = `${MATRIX_OUT_BASE}.details/${detailFilename}`;
  const detailJsonRel = `${MATRIX_OUT_BASE}.details/${detailJsonFilename}`;
  const inputRel = `${MATRIX_OUT_BASE}.inputs/${inputFilename}`;
  const source = target?.requestFamily === 'tx-op'
    ? {
        shape: 'request',
        kind: target.caseDef?.kind || null,
        request: stripEngineFromOperationSpec(target.caseDef?.request || {}),
        engines: normalizeCaseEngines(target.caseDef || {}),
      }
    : {
        shape: 'request',
        kind: 'expand',
        valueSet: target?.vsJson || null,
        options: target?.opts || {},
      };
  const targets = [];
  for (const spec of matrixTargetSpecs(target || {})) {
    targets.push(await captureMatrixTargetDebug(target || {}, spec, artifact, artifactMatchesTarget(artifact, spec) ? assertionError : null));
  }
  const payloadDoc = {
    schemaVersion: PERF_ARTIFACT_SCHEMA_VERSION,
    id: rowIndex,
    slug,
    name: meta.name,
    category: meta.category,
    source,
    requests: Object.fromEntries(targets.map((target) => [target.key, target.debug?.request || null])),
  };
  const detailDoc = {
    schemaVersion: PERF_ARTIFACT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    rowIndex,
    slug,
    category: meta.category,
    name: meta.name,
    rawName: meta.rawName,
    kind: artifact?.kind || target?.kind || 'unknown',
    hrefs: {
      input: `../${MATRIX_OUT_BASE}.inputs/${inputFilename}`,
      detailJson: detailJsonFilename,
    },
    targets,
  };
  const detailAbs = join(MATRIX_DETAILS_DIR, detailFilename);
  const detailJsonAbs = join(MATRIX_DETAILS_DIR, detailJsonFilename);
  const inputAbs = join(MATRIX_INPUTS_DIR, inputFilename);
  writeFileSync(inputAbs, JSON.stringify(payloadDoc, null, 2));
  writeFileSync(detailJsonAbs, JSON.stringify(detailDoc, null, 2));
  writeFileSync(detailAbs, buildMatrixDetailHtml(detailDoc));
  return {
    href: detailRel,
    detailJsonHref: detailJsonRel,
    inputHref: inputRel,
    primaryMs: targets[0]?.debug?.ms ?? null,
    primarySummary: targets[0]?.summary || 'n/a',
    secondaryMs: targets[1]?.debug?.ms ?? null,
    secondarySummary: targets[1]?.summary || 'n/a',
    thirdMs: targets[2]?.debug?.ms ?? null,
    thirdSummary: targets[2]?.summary ?? null,
  };
}

// ── perf HTML builder ──────────────────────────────────────────────────
function buildPerfHtml(catalogDoc) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Perf Comparison Matrix</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 1300px; margin: 2em auto; padding: 0 1em; }
  h1 { font-size: 1.3em; }
  .meta { color: #666; font-size: 0.85em; margin-bottom: 1em; }
  .meta a { margin-right: 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 6px 10px; border: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .ir-win { background: #e8f5e9; }
  .leg-win { background: #fff3e0; }
  .ir-only { background: #e3f2fd; }
  .err { color: #c62828; }
  .muted { color: #777; }
</style></head><body>
<h1>Performance Comparison Matrix</h1>
<p class="meta" id="perf-table-meta"></p>
<p class="meta" id="perf-table-links"></p>
<table>
<thead><tr id="perf-table-head"></tr></thead>
<tbody id="perf-table-body"></tbody></table>
<script type="application/json" id="perf-table-data">${serializeJsonForHtml(catalogDoc)}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('perf-table-data').textContent);
  const esc = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const hasThird = !!data.hasThird;
  const renderPerf = (ms, err, supported = true) => {
    if (!supported) return '<span class="muted">n/a</span>';
    if (err) return '<span class="err">❌</span>';
    return \`\${esc(String(ms))}ms\`;
  };
  const ratioForRow = (row) => {
    if (!row.irSupported && row.upstreamSupported) return { text: 'Legacy only', cls: 'leg-win' };
    if (row.irSupported && !row.upstreamSupported) return { text: 'IR only', cls: 'ir-only' };
    if (!row.irSupported && !row.upstreamSupported) return { text: '', cls: 'even' };
    if (!row.irError && !row.upstreamError && row.irMs > 0 && row.upstreamMs > 0) {
      const deltaMs = Math.abs(row.irMs - row.upstreamMs);
      if (deltaMs <= 5) return { text: '≈', cls: 'even' };
      if (row.irMs < row.upstreamMs) {
        const x = (row.upstreamMs / row.irMs).toFixed(1);
        return { text: x === '1.0' ? '≈' : \`IR ×\${x}\`, cls: x === '1.0' ? 'even' : 'ir-win' };
      }
      const x = (row.irMs / row.upstreamMs).toFixed(1);
      return { text: x === '1.0' ? '≈' : \`Upstream ×\${x}\`, cls: x === '1.0' ? 'even' : 'leg-win' };
    }
    if (row.upstreamError && !row.irError) return { text: 'IR only', cls: 'ir-only' };
    return { text: '', cls: 'even' };
  };

  const labels = data.labels || {};
  document.getElementById('perf-table-meta').innerHTML =
    \`Generated \${esc(data.generatedAtDisplay)} &middot; median of \${esc(String(data.perfRuns))} runs &middot; _nocache=true &middot; details in \${esc(data.detailsDirLabel)} &middot; inputs in \${esc(data.inputsDirLabel)}\`;
  document.getElementById('perf-table-links').innerHTML = data.catalogHref
    ? \`<a href="\${esc(data.catalogHref)}" target="_blank" rel="noopener">Catalog JSON</a>\`
    : '';

  document.getElementById('perf-table-head').innerHTML =
    \`<th>Category</th><th>Test</th><th>\${esc(labels.primary || '')}</th><th>\${esc(labels.secondary || '')}</th>\${hasThird ? \`<th>\${esc(labels.third || '')}</th>\` : ''}<th>Winner (\${esc(labels.primary || '')} vs \${esc(labels.secondary || '')})</th><th>Details</th><th>Inputs</th>\`;

  document.getElementById('perf-table-body').innerHTML = (data.rows || []).map((row) => {
    const ratio = ratioForRow(row);
    const detailCell = row.detailHref
      ? \`<a href="\${esc(row.detailHref)}" target="_blank" rel="noopener">Execution details</a>\`
      : (row.detailError ? \`<span class="err">\${esc(row.detailError)}</span>\` : '<span class="muted">n/a</span>');
    const inputCell = row.inputHref
      ? \`<a href="\${esc(row.inputHref)}" target="_blank" rel="noopener">Input JSON</a>\`
      : '<span class="muted">n/a</span>';
    const thirdCell = hasThird
      ? \`<td class="num">\${renderPerf(row.thirdMs, row.thirdError, row.thirdSupported !== false)}</td>\`
      : '';
    return \`<tr class="\${ratio.cls}"><td>\${esc(row.category)}</td><td>\${esc(row.name)}</td><td class="num">\${renderPerf(row.irMs, row.irError, row.irSupported !== false)}</td><td class="num">\${renderPerf(row.upstreamMs, row.upstreamError, row.upstreamSupported !== false)}</td>\${thirdCell}<td>\${esc(ratio.text)}</td><td>\${detailCell}</td><td>\${inputCell}</td></tr>\`;
  }).join('');
})();
</script>
</body></html>`;
}

run().catch(e => { console.error('Fatal:', e); process.exit(2); });
