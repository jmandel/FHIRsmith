'use strict';

const IR = require('./ir');

/**
 * Build a semantic IR tree from a ValueSet resource (jsonObj or plain JSON).
 *
 * This does NOT expand imports; it creates ImportRef nodes.
 */
function buildIRFromValueSet(vsJson, opts = {}) {
  const vs = vsJson?.jsonObj || vsJson;
  const compose = vs?.compose || {};
  const lockedDate = compose?.lockedDate != null
    ? String(compose.lockedDate)
    : (opts?.lockedDate != null ? String(opts.lockedDate) : null);
  return buildIRFromCompose(compose, { ...opts, lockedDate });
}

function buildIRFromCompose(compose, opts = {}) {
  const includes = Array.isArray(compose?.include) ? compose.include : [];
  const excludes = Array.isArray(compose?.exclude) ? compose.exclude : [];

  const includeExprs = includes.map((cset, i) => buildComponentExpr(cset, `ValueSet.compose.include[${i}]`, opts));
  const excludeExprs = excludes.map((cset, i) => buildComponentExpr(cset, `ValueSet.compose.exclude[${i}]`, opts));

  const includeUnion = IR.union(includeExprs, { role: 'includes' });
  const excludeUnion = IR.union(excludeExprs, { role: 'excludes' });

  return IR.diff(includeUnion, excludeUnion, { role: 'root' });
}

function buildComponentExpr(cset, path, opts = {}) {
  const meta = { path };

  // Pure import component (no system)
  if (!cset?.system) {
    const refs = (cset?.valueSet || []).map((u, j) => IR.importRef({ url: String(u), version: null, meta: { path: `${path}.valueSet[${j}]` } }));
    return IR.intersect(refs, meta);
  }

  const system = String(cset.system);
  // Treat wildcard version as unversioned selector in current IR execution.
  // (Provider-specific "all versions" semantics are handled outside IR.)
  const rawVersion = cset.version ? String(cset.version) : null;
  const version = rawVersion === '*' ? null : rawVersion;
  // lockedDate is a compose-level qualifier for otherwise-unversioned selectors.
  // Do not attach lockedDate when component supplied explicit version (including '*').
  const lockedDate = (!rawVersion && opts?.lockedDate != null)
    ? String(opts.lockedDate)
    : null;

  // Leaf selector for this component
  let leaf;
  if (Array.isArray(cset.concept) && cset.concept.length > 0) {
    const conceptCodes = cset.concept
      .map((cc, j) => ({
        code: String(cc.code || ''),
        display: cc.display != null ? String(cc.display) : null,
        designation: Array.isArray(cc.designation) ? cc.designation : [],
        extension: Array.isArray(cc.extension) ? cc.extension : [],
        meta: { path: `${path}.concept[${j}]` },
      }))
      .filter(x => x.code);
    leaf = IR.selector({ system, version, lockedDate, shape: 'concept', conceptCodes, meta });
  } else if (Array.isArray(cset.filter) && cset.filter.length > 0) {
    const filterClauses = cset.filter.map((f, j) => ({
      property: String(f.property || ''),
      op: String(f.op || ''),
      value: f.value != null ? String(f.value) : null,
      meta: { path: `${path}.filter[${j}]` },
    }));
    leaf = IR.selector({ system, version, lockedDate, shape: 'filter', filterClauses, meta });
  } else {
    leaf = IR.selector({ system, version, lockedDate, shape: 'whole', meta });
  }

  // Optional imports constrain the leaf via intersection.
  const imports = (cset.valueSet || []).map((u, j) => IR.importRef({ url: String(u), version: null, meta: { path: `${path}.valueSet[${j}]` } }));
  if (imports.length === 0) return leaf;
  return IR.intersect([leaf, ...imports], meta);
}

module.exports = {
  buildIRFromValueSet,
  buildIRFromCompose,
  buildComponentExpr,
};
