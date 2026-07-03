'use strict';

//
// Lean IR orchestrator for the sqlite-v1 branch.
//
// Compiles a ValueSet.compose into the IR algebra (build-ir), optimizes it
// (rewrite), resolves imports, partitions by code system, and executes each
// per-system subtree through the provider's NATIVE terminals
// (executeIR/countForIR/membershipForIR — see cs-sqlite.js). It returns raw
// candidates ({system, version, code}); FHIR decoration/rendering is the
// caller's job (the expand worker reuses its own includeCode path, so IR,
// pushdown and legacy share one decoration surface and stay at parity).
//
// Scope is deliberately thin: it fully supports selector/union/intersect/diff
// over one or more sqlite systems. Shapes it does not natively cover
// (non-native providers, cross-system imports) return { expansion: null,
// reason } so the caller falls back to the legacy expander. Nothing here
// changes membership semantics — every set is the same sorted concept_id
// algebra the other two engines use.
//

const IR = require('./ir');
const { buildIRFromValueSet } = require('./build-ir');
const { optimize, collectSystems, projectToSystem } = require('./rewrite');
const { walkIR } = require('./ir-traversal');

// Shape gate: which composes IR will attempt. Mirrors the draft's intent —
// reject malformed compose and expansion-only value sets (legacy owns those).
function canHandleValueSet(vsJson) {
  if (!vsJson || typeof vsJson !== 'object') return false;
  if (vsJson.expansion && !vsJson.compose) return false;
  const compose = vsJson.compose;
  if (!compose) return true;
  if (compose.lockedDate != null && String(compose.lockedDate).trim() === '') return false;
  if (compose.inactive != null && typeof compose.inactive !== 'boolean') return false;
  if (compose.include != null && !Array.isArray(compose.include)) return false;
  if (compose.exclude != null && !Array.isArray(compose.exclude)) return false;
  for (const cset of [...(compose.include || []), ...(compose.exclude || [])]) {
    if (!cset || typeof cset !== 'object') return false;
    if (cset.concept != null && !Array.isArray(cset.concept)) return false;
    if (cset.filter != null && !Array.isArray(cset.filter)) return false;
    if (cset.valueSet != null && !Array.isArray(cset.valueSet)) return false;
    if (!cset.system && !(Array.isArray(cset.valueSet) && cset.valueSet.length)) return false;
  }
  return true;
}

function bail(reason, extra) {
  return { expansion: null, reason, ...(extra || {}) };
}

/**
 * @param {object} vsJson  ValueSet resource (jsonObj or plain)
 * @param {object} opts
 *   findProvider(system, version) -> provider | null   (must expose hasExecuteIR/executeIR/countForIR)
 *   resolveValueSet(url, version) -> { codesBySystem: Map<system, Set<code>> } | null
 *   activeOnly, offset, count, exactTotal
 * @returns {Promise<{ candidates, total, usedSystems, usedValueSets, warnings } | { expansion:null, reason }>}
 */
async function expandViaIR(vsJson, opts = {}) {
  if (!canHandleValueSet(vsJson)) return bail('unhandled-compose-shape');

  const warnings = [];
  const usedValueSets = [];
  let ir = buildIRFromValueSet(vsJson);

  // Resolve imports up front. Each importRef is replaced by a same-system
  // concept selector; cross-system or unresolved imports bail to legacy.
  let importFailure = null;
  ir = await resolveImports(ir, opts, usedValueSets, (reason) => { importFailure = importFailure || reason; });
  if (importFailure) return bail(importFailure);

  ir = optimize(ir);
  if (!ir || ir.kind === 'empty') {
    return { candidates: [], total: 0, usedSystems: [], usedValueSets, warnings };
  }

  // collectSystems -> Map<"system|version", {system, version}>; each entry is
  // an exact (system, version) execution bucket (null version is distinct).
  const buckets = [...collectSystems(ir).values()];
  if (buckets.length === 0) return { candidates: [], total: 0, usedSystems: [], usedValueSets, warnings };

  // Bind each bucket to a native provider.
  const scopes = [];
  for (const { system, version } of buckets) {
    const provider = await opts.findProvider(system, version);
    if (!provider || typeof provider.hasExecuteIR !== 'function' || !provider.hasExecuteIR()) {
      return bail('non-native-provider', { warnings: [`Systems without IR support: ${system}`] });
    }
    const subtree = projectToSystem(ir, system, version);
    if (!subtree || subtree.kind === 'empty') continue;
    scopes.push({ system, version: version || providerVersion(provider), provider, subtree });
  }
  if (scopes.length === 0) {
    return { candidates: [], total: 0, usedSystems: [], usedValueSets, warnings };
  }

  const activeOnly = !!opts.activeOnly;
  const offset = opts.offset > 0 ? opts.offset : 0;
  const count = opts.count != null && opts.count > -1 ? opts.count : -1;

  const usedSystems = scopes.map((s) => vurl(s.system, s.version));

  // Single system: native paging + exact total straight from the provider.
  if (scopes.length === 1) {
    const s = scopes[0];
    const res = await s.provider.executeIR(s.subtree, { activeOnly, offset, count });
    return {
      candidates: (res.candidates || []).map((c) => ({ system: s.system, version: s.version, code: c.code })),
      total: res.total != null ? res.total : null,
      usedSystems, usedValueSets, warnings,
    };
  }

  // Multi-system: concatenate per system in system order, page globally.
  // Totals sum. (Cross-system composes are small and rare; materialize.)
  let all = [];
  let total = 0;
  for (const s of scopes) {
    const res = await s.provider.executeIR(s.subtree, { activeOnly, offset: 0, count: -1 });
    total += res.total != null ? res.total : (res.candidates || []).length;
    for (const c of res.candidates || []) all.push({ system: s.system, version: s.version, code: c.code });
  }
  const from = offset;
  const page = count > -1 ? all.slice(from, from + count) : (from > 0 ? all.slice(from) : all);
  return { candidates: page, total, usedSystems, usedValueSets, warnings };
}

function providerVersion(provider) {
  try { return typeof provider.version === 'function' ? provider.version() : null; }
  catch { return null; }
}

function vurl(system, version) {
  return version ? `${system}|${version}` : system;
}

// Replace importRef nodes with same-system concept selectors, using the
// injected resolveValueSet. Signals bail via onFail() for shapes IR won't own.
async function resolveImports(ir, opts, usedValueSets, onFail) {
  const imports = [];
  walkIR(ir, (node) => { if (node.kind === 'import') imports.push(node); });
  if (imports.length === 0) return ir;
  if (typeof opts.resolveValueSet !== 'function') { onFail('imports-unsupported'); return ir; }

  for (const node of imports) {
    let resolved;
    try {
      resolved = await opts.resolveValueSet(node.url, node.version);
    } catch {
      onFail('import-resolve-error');
      return ir;
    }
    if (!resolved || !resolved.codesBySystem) { onFail('import-unresolved'); return ir; }
    usedValueSets.push(node.url);
    const map = resolved.codesBySystem;
    if (map.size !== 1) { onFail('import-cross-system'); return ir; }
    const [system, codes] = [...map.entries()][0];
    node.resolved = IR.selector({
      system,
      shape: 'concept',
      conceptCodes: [...codes].map((code) => ({ code: String(code) })),
      meta: { importUrl: node.url },
    });
  }
  return ir;
}

module.exports = {
  canHandleValueSet,
  expandViaIR,
};
