'use strict';

const crypto = require('crypto');
const IR = require('./ir');

function rewriteOptEnabled() {
  return process.env.EXPAND_V3_DISABLE_REWRITE_OPT !== '1';
}

function flatten(expr) {
  if (!expr || typeof expr !== 'object') return expr;
  switch (expr.kind) {
  case 'empty':
  case 'selector':
    return expr;
  case 'import':
    return expr.resolved ? { ...expr, resolved: flatten(expr.resolved) } : expr;
  case 'union':
    return IR.union((expr.items || []).map(flatten), expr.meta);
  case 'intersect':
    return IR.intersect((expr.items || []).map(flatten), expr.meta);
  case 'diff':
    return IR.diff(flatten(expr.left), flatten(expr.right), expr.meta);
  default:
    return expr;
  }
}

function optimize(expr) {
  const flat = flatten(expr);
  if (!rewriteOptEnabled()) return flat;
  return simplify(flat);
}

function canonicalizeIR(expr, opts = {}) {
  const optimizeExpr = opts.optimizeExpr !== false;
  const assignNodeIds = opts.assignNodeIds !== false;
  const base = optimizeExpr ? simplify(flatten(IR.cloneExpr(expr))) : IR.cloneExpr(expr);
  const canonical = canonicalizeNode(base);
  return assignNodeIds ? annotateNodeIds(canonical) : canonical;
}

function canonicalIRHash(expr, opts = {}) {
  const canonical = canonicalizeIR(expr, { ...opts, assignNodeIds: false });
  return crypto.createHash('sha1')
    .update(JSON.stringify(canonicalStructuralForm(canonical)))
    .digest('hex');
}

function simplify(expr) {
  if (!expr || typeof expr !== 'object') return expr;
  switch (expr.kind) {
  case 'empty':
  case 'selector':
    return expr;
  case 'import':
    // Once imports are resolved, inline them into the working expression tree.
    // This enables downstream union coalescing across former import boundaries
    // (e.g., deep mixed include graphs collapsing to one selector per system).
    return expr.resolved ? simplify(expr.resolved) : expr;
  case 'union': {
    const items = (expr.items || []).map(simplify).filter(it => it && it.kind !== 'empty');
    return coalesceUnionItems(items, expr.meta);
  }
  case 'intersect': {
    const items = (expr.items || []).map(simplify);
    return coalesceIntersectItems(items, expr.meta);
  }
  case 'diff': {
    const left = simplify(expr.left);
    const right = simplify(expr.right);
    if (!left || left.kind === 'empty') return IR.empty();
    if (!right || right.kind === 'empty') return left;
    const partitioned = partitionDiffBySystem(left, right, expr.meta);
    if (partitioned) return simplify(partitioned);
    return IR.diff(left, right, expr.meta);
  }
  default:
    return expr;
  }
}

function coalesceUnionItems(items, meta) {
  const out = [];
  const conceptByKey = new Map();
  const wholeByKey = new Set();
  const filterBySig = new Set();

  for (const item of items || []) {
    if (!item) continue;
    if (item.kind !== 'selector') {
      out.push(item);
      continue;
    }

    const shape = String(item.shape || '');
    if (shape === 'concept') {
      const ckey = selectorKey(item, 'concept');
      const wkey = selectorKey(item, 'whole');
      if (wholeByKey.has(wkey)) continue;
      const idx = conceptByKey.get(ckey);
      if (idx != null) {
        out[idx] = mergeConceptSelectors(out[idx], item);
      } else {
        conceptByKey.set(ckey, out.length);
        out.push(item);
      }
      continue;
    }

    if (shape === 'whole' || shape === 'all') {
      const wkey = selectorKey(item, 'whole');
      if (wholeByKey.has(wkey)) continue;

      const ckey = selectorKey(item, 'concept');
      const idx = conceptByKey.get(ckey);
      if (idx != null) {
        out[idx] = null;
        conceptByKey.delete(ckey);
      }

      wholeByKey.add(wkey);
      out.push(shape === 'whole' ? item : { ...item, shape: 'whole' });
      continue;
    }

    if (shape === 'filter') {
      const sig = filterSignature(item);
      if (filterBySig.has(sig)) continue;
      filterBySig.add(sig);
      out.push(item);
      continue;
    }

    out.push(item);
  }

  return IR.union(out.filter(Boolean), meta);
}

function mergeConceptSelectors(a, b) {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set();
  const merged = [];
  for (const c of a.conceptCodes || []) {
    const code = String(c?.code || '');
    if (!code || seen.has(code)) continue;
    seen.add(code);
    merged.push(c);
  }
  for (const c of b.conceptCodes || []) {
    const code = String(c?.code || '');
    if (!code || seen.has(code)) continue;
    seen.add(code);
    merged.push(c);
  }
  return {
    ...a,
    conceptCodes: merged,
  };
}

function coalesceIntersectItems(items, meta) {
  const raw = (items || []).filter(Boolean);
  if (raw.length === 0) return IR.empty();
  if (raw.some(it => it.kind === 'empty')) return IR.empty();

  const out = [];
  const selectorByKey = new Map();
  const seenNonSelectors = new Set();

  for (const item of raw) {
    if (item.kind !== 'selector') {
      const sig = JSON.stringify(item);
      if (!seenNonSelectors.has(sig)) {
        seenNonSelectors.add(sig);
        out.push(item);
      }
      continue;
    }

    const key = intersectSelectorKey(item);
    const idx = selectorByKey.get(key);
    if (idx == null) {
      selectorByKey.set(key, out.length);
      out.push(item);
      continue;
    }

    const merged = mergeSelectorsForIntersect(out[idx], item);
    if (!merged) {
      // Not mergeable (e.g. unknown shape combination), retain both terms.
      out.push(item);
      continue;
    }
    if (merged.kind === 'empty') return IR.empty();
    out[idx] = merged;
  }

  return IR.intersect(out, meta);
}

function mergeSelectorsForIntersect(a, b) {
  if (!a || !b) return null;
  const ak = canonicalShape(a.shape);
  const bk = canonicalShape(b.shape);
  if (ak === 'whole') return b;
  if (bk === 'whole') return a;

  if (ak === 'concept' && bk === 'concept') {
    const amap = conceptCodeMap(a.conceptCodes || []);
    const both = [];
    for (const c of b.conceptCodes || []) {
      const code = String(c?.code || '');
      if (!code || !amap.has(code)) continue;
      both.push(amap.get(code));
    }
    if (both.length === 0) return IR.empty();
    return { ...a, conceptCodes: dedupeConceptCodes(both) };
  }

  if (ak === 'filter' && bk === 'filter') {
    const clauses = dedupeFilterClauses([...(a.filterClauses || []), ...(b.filterClauses || [])]);
    const intersectCodes = intersectCodeLists(a.intersectCodes || null, b.intersectCodes || null);
    if (Array.isArray(intersectCodes) && intersectCodes.length === 0) return IR.empty();
    return {
      ...a,
      filterClauses: clauses,
      ...(intersectCodes ? { intersectCodes } : {}),
    };
  }

  if (ak === 'filter' && bk === 'concept') {
    const codes = dedupeConceptCodes(b.conceptCodes || []).map(c => String(c.code));
    if (codes.length === 0) return IR.empty();
    const intersectCodes = intersectCodeLists(a.intersectCodes || null, codes);
    if (Array.isArray(intersectCodes) && intersectCodes.length === 0) return IR.empty();
    return {
      ...a,
      ...(intersectCodes ? { intersectCodes } : { intersectCodes: codes }),
    };
  }

  if (ak === 'concept' && bk === 'filter') {
    return mergeSelectorsForIntersect(b, a);
  }

  return null;
}

function partitionDiffBySystem(left, right, meta) {
  const leftSystems = [...collectSystems(left).values()];
  if (leftSystems.length <= 1) return null;

  const parts = [];
  for (const { system, version } of leftSystems) {
    const l = projectToSystem(left, system, version);
    if (!l || l.kind === 'empty') continue;
    const r = projectToSystem(right, system, version);
    parts.push(IR.diff(l, r || IR.empty(), {
      ...(meta || {}),
      role: 'partitioned-diff',
      system,
      version: version || null,
    }));
  }
  if (parts.length === 0) return IR.empty();
  return IR.union(parts, { ...(meta || {}), role: 'partitioned-diff-union' });
}

function selectorKey(sel, shapeOverride = null) {
  return JSON.stringify([
    String(sel?.system || ''),
    sel?.version || null,
    sel?.lockedDate || null,
    String(shapeOverride || sel?.shape || ''),
    normalizeText(sel?.text),
  ]);
}

function intersectSelectorKey(sel) {
  return JSON.stringify([
    String(sel?.system || ''),
    sel?.version || null,
    sel?.lockedDate || null,
    normalizeText(sel?.text),
  ]);
}

function normalizeText(text) {
  const t = text == null ? '' : String(text).trim();
  return t.length > 0 ? t : null;
}

function filterSignature(sel) {
  const clauses = dedupeFilterClauses((sel?.filterClauses || []).map(c => ({
    property: c?.property ?? null,
    op: c?.op ?? null,
    value: c?.value ?? null,
  })));
  const intersectCodes = normalizeIntersectCodes(sel?.intersectCodes);
  return JSON.stringify([
    String(sel?.system || ''),
    sel?.version || null,
    sel?.lockedDate || null,
    normalizeText(sel?.text),
    clauses,
    intersectCodes,
  ]);
}

function normalizeIntersectCodes(codes) {
  if (!Array.isArray(codes)) return null;
  const out = [];
  const seen = new Set();
  for (const c of codes) {
    const code = String(c || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  out.sort();
  return out;
}

function dedupeFilterClauses(clauses) {
  const out = [];
  const seen = new Set();
  for (const c of clauses || []) {
    if (!c) continue;
    const sig = JSON.stringify([
      c.property ?? null,
      c.op ?? null,
      c.value ?? null,
    ]);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
  }
  // Canonical order for stable signatures/dedup across import branches.
  out.sort((a, b) => {
    const ak = `${a.property || ''}\u0000${a.op || ''}\u0000${a.value || ''}`;
    const bk = `${b.property || ''}\u0000${b.op || ''}\u0000${b.value || ''}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return out;
}

function dedupeConceptCodes(codes) {
  const out = [];
  const seen = new Set();
  for (const c of codes || []) {
    const code = String(c?.code || '');
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(c);
  }
  out.sort(compareConceptEntries);
  return out;
}

function conceptCodeMap(codes) {
  const map = new Map();
  for (const c of dedupeConceptCodes(codes || [])) {
    map.set(String(c.code), c);
  }
  return map;
}

function canonicalShape(shape) {
  const s = String(shape || '').toLowerCase();
  if (s === 'all') return 'whole';
  return s;
}

function intersectCodeLists(a, b) {
  const aArr = Array.isArray(a) ? a.map(x => String(x || '')).filter(Boolean) : null;
  const bArr = Array.isArray(b) ? b.map(x => String(x || '')).filter(Boolean) : null;
  if (!aArr && !bArr) return null;
  if (!aArr) return [...new Set(bArr)];
  if (!bArr) return [...new Set(aArr)];
  const aset = new Set(aArr);
  const out = [];
  for (const c of bArr) if (aset.has(c)) out.push(c);
  return [...new Set(out)];
}

function collectSystems(expr, out = new Map()) {
  if (!expr) return out;
  switch (expr.kind) {
  case 'selector': {
    const k = `${expr.system}|${expr.version || ''}`;
    if (!out.has(k)) out.set(k, { system: expr.system, version: expr.version || null });
    break;
  }
  case 'import':
    if (expr.resolved) collectSystems(expr.resolved, out);
    break;
  case 'union':
  case 'intersect':
    for (const it of expr.items || []) collectSystems(it, out);
    break;
  case 'diff':
    collectSystems(expr.left, out);
    collectSystems(expr.right, out);
    break;
  default:
    break;
  }
  return out;
}

function projectToSystem(expr, system, version = null) {
  if (!expr) return IR.empty();
  switch (expr.kind) {
  case 'empty':
    return expr;
  case 'selector': {
    if (String(expr.system) !== String(system)) return IR.empty();
    // Always project by exact (system, version) bucket.
    // `null` version is a distinct bucket from any explicit version.
    const exprVersion = expr.version || null;
    const targetVersion = version || null;
    if (exprVersion !== targetVersion) {
      return IR.empty();
    }
    return expr;
  }
  case 'import':
    if (expr.resolved) return projectToSystem(expr.resolved, system, version);
    // unresolved import: keep it, projection will happen after resolution
    return { ...expr };
  case 'union':
    return IR.union((expr.items || []).map(it => projectToSystem(it, system, version)), expr.meta);
  case 'intersect': {
    const projected = (expr.items || []).map(it => projectToSystem(it, system, version));
    if (projected.some(it => !it || it.kind === 'empty')) return IR.empty();
    return IR.intersect(projected, expr.meta);
  }
  case 'diff':
    return IR.diff(projectToSystem(expr.left, system, version), projectToSystem(expr.right, system, version), expr.meta);
  default:
    return IR.empty();
  }
}

function splitDiffRoot(expr) {
  if (expr && expr.kind === 'diff') return { include: expr.left, exclude: expr.right };
  return { include: expr || IR.empty(), exclude: IR.empty() };
}

function analyzePartitionSafety(expr) {
  const problems = [];

  function walk(node, path) {
    if (!node || typeof node !== 'object') {
      problems.push(`${path}: invalid node`);
      return;
    }

    switch (node.kind) {
    case 'empty':
      return;
    case 'selector':
      if (!node.system || String(node.system).trim() === '') {
        problems.push(`${path}: selector missing system`);
      }
      return;
    case 'import':
      if (!node.resolved) {
        const url = node.url ? ` (${node.url})` : '';
        problems.push(`${path}: unresolved import${url}`);
        return;
      }
      walk(node.resolved, `${path}.resolved`);
      return;
    case 'union':
    case 'intersect':
      for (let i = 0; i < (node.items || []).length; i++) {
        walk(node.items[i], `${path}.items[${i}]`);
      }
      return;
    case 'diff':
      walk(node.left, `${path}.left`);
      walk(node.right, `${path}.right`);
      return;
    default:
      problems.push(`${path}: unknown node kind "${node.kind}"`);
    }
  }

  walk(expr, 'root');
  return {
    ok: problems.length === 0,
    reason: problems[0] || null,
    problems,
  };
}

function analyzeProjectedSubtree(expr, expectedSystem, expectedVersion = null) {
  const base = analyzePartitionSafety(expr);
  if (!base.ok) return base;

  const expectedKey = `${String(expectedSystem || '')}|${expectedVersion || ''}`;
  const foundSystems = [...collectSystems(expr).values()];
  const mismatches = [];
  for (const s of foundSystems) {
    const key = `${String(s.system || '')}|${s.version || ''}`;
    if (key !== expectedKey) {
      mismatches.push(`expected ${expectedKey}, found ${key}`);
    }
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: `projected subtree leaks outside target system/version: ${mismatches[0]}`,
      problems: mismatches,
    };
  }
  return { ok: true, reason: null, problems: [] };
}

function flattenUnionToList(expr) {
  const out = [];
  function walk(e) {
    if (!e || e.kind === 'empty') return;
    if (e.kind === 'union') {
      for (const it of e.items || []) walk(it);
    } else {
      out.push(e);
    }
  }
  walk(expr);
  return out;
}

function canonicalizeNode(node) {
  if (!node || typeof node !== 'object') return node;
  switch (node.kind) {
  case 'empty':
    return { kind: 'empty' };
  case 'selector':
    return canonicalizeSelector(node);
  case 'import':
    return {
      kind: 'import',
      url: String(node.url || ''),
      version: node.version || null,
      resolved: node.resolved ? canonicalizeNode(node.resolved) : null,
      meta: canonicalJsonValue(node.meta),
    };
  case 'union':
  case 'intersect': {
    const items = (node.items || []).map(canonicalizeNode);
    items.sort(compareExprCanonical);
    return {
      kind: node.kind,
      items,
      meta: canonicalJsonValue(node.meta),
    };
  }
  case 'diff':
    return {
      kind: 'diff',
      left: canonicalizeNode(node.left),
      right: canonicalizeNode(node.right),
      meta: canonicalJsonValue(node.meta),
    };
  default:
    return canonicalJsonValue(node);
  }
}

function canonicalizeSelector(node) {
  return {
    kind: 'selector',
    system: String(node.system || ''),
    version: node.version || null,
    lockedDate: node.lockedDate || null,
    shape: canonicalShape(node.shape),
    conceptCodes: canonicalizeConceptCodeList(node.conceptCodes),
    filterClauses: canonicalizeFilterClauseList(node.filterClauses),
    intersectCodes: normalizeIntersectCodes(node.intersectCodes),
    text: normalizeText(node.text),
    meta: canonicalJsonValue(node.meta),
  };
}

function canonicalizeConceptCodeList(codes) {
  if (!Array.isArray(codes) || codes.length === 0) return null;
  const byCode = new Map();
  for (const raw of codes) {
    const entry = canonicalizeConceptEntry(raw);
    if (!entry || !entry.code) continue;
    const prev = byCode.get(entry.code);
    if (!prev || compareCanonicalJson(entry, prev) < 0) {
      byCode.set(entry.code, entry);
    }
  }
  const out = [...byCode.values()];
  out.sort(compareConceptEntries);
  return out.length > 0 ? out : null;
}

function canonicalizeConceptEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const code = String(entry.code || '').trim();
  if (!code) return null;
  return {
    code,
    display: entry.display != null ? String(entry.display) : null,
    designation: canonicalArray(entry.designation),
    extension: canonicalArray(entry.extension),
    meta: canonicalJsonValue(entry.meta),
  };
}

function canonicalizeFilterClauseList(clauses) {
  if (!Array.isArray(clauses) || clauses.length === 0) return null;
  const bySig = new Map();
  for (const raw of clauses) {
    if (!raw || typeof raw !== 'object') continue;
    const clause = {
      property: raw.property != null ? String(raw.property) : null,
      op: raw.op != null ? String(raw.op) : null,
      value: raw.value != null ? String(raw.value) : null,
      meta: canonicalJsonValue(raw.meta),
    };
    const sig = JSON.stringify([clause.property, clause.op, clause.value]);
    const prev = bySig.get(sig);
    if (!prev || compareCanonicalJson(clause, prev) < 0) {
      bySig.set(sig, clause);
    }
  }
  const out = [...bySig.values()];
  out.sort((a, b) => compareCanonicalJson(
    [a.property, a.op, a.value, a.meta],
    [b.property, b.op, b.value, b.meta]
  ));
  return out.length > 0 ? out : null;
}

function canonicalArray(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const out = value.map(canonicalJsonValue);
  out.sort(compareCanonicalJson);
  return out;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return canonicalArray(value);
  if (value == null || typeof value !== 'object') return value ?? null;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = canonicalJsonValue(value[key]);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

function canonicalStructuralForm(node) {
  if (!node || typeof node !== 'object') return node;
  switch (node.kind) {
  case 'empty':
    return { kind: 'empty' };
  case 'selector':
    return {
      kind: 'selector',
      system: String(node.system || ''),
      version: node.version || null,
      lockedDate: node.lockedDate || null,
      shape: canonicalShape(node.shape),
      conceptCodes: (node.conceptCodes || []).map(c => ({
        code: String(c.code || ''),
        display: c.display != null ? String(c.display) : null,
        designation: canonicalJsonValue(c.designation),
        extension: canonicalJsonValue(c.extension),
      })),
      filterClauses: (node.filterClauses || []).map(c => ({
        property: c.property != null ? String(c.property) : null,
        op: c.op != null ? String(c.op) : null,
        value: c.value != null ? String(c.value) : null,
      })),
      intersectCodes: normalizeIntersectCodes(node.intersectCodes),
      text: normalizeText(node.text),
    };
  case 'import':
    return {
      kind: 'import',
      url: String(node.url || ''),
      version: node.version || null,
      resolved: node.resolved ? canonicalStructuralForm(node.resolved) : null,
    };
  case 'union':
  case 'intersect':
    return {
      kind: node.kind,
      items: (node.items || []).map(canonicalStructuralForm),
    };
  case 'diff':
    return {
      kind: 'diff',
      left: canonicalStructuralForm(node.left),
      right: canonicalStructuralForm(node.right),
    };
  default:
    return canonicalJsonValue(node);
  }
}

function annotateNodeIds(node, path = 'n') {
  if (!node || typeof node !== 'object') return node;
  switch (node.kind) {
  case 'empty':
  case 'selector':
    return { ...node, nodeId: path };
  case 'import':
    return {
      ...node,
      nodeId: path,
      resolved: node.resolved ? annotateNodeIds(node.resolved, `${path}.r`) : null,
    };
  case 'union':
  case 'intersect':
    return {
      ...node,
      nodeId: path,
      items: (node.items || []).map((item, i) => annotateNodeIds(item, `${path}.${i}`)),
    };
  case 'diff':
    return {
      ...node,
      nodeId: path,
      left: annotateNodeIds(node.left, `${path}.l`),
      right: annotateNodeIds(node.right, `${path}.r`),
    };
  default:
    return { ...node, nodeId: path };
  }
}

function compareExprCanonical(a, b) {
  return compareCanonicalJson(canonicalStructuralForm(a), canonicalStructuralForm(b));
}

function compareCanonicalJson(a, b) {
  const aj = JSON.stringify(a);
  const bj = JSON.stringify(b);
  return aj < bj ? -1 : aj > bj ? 1 : 0;
}

function compareConceptEntries(a, b) {
  const ac = String(a?.code || '');
  const bc = String(b?.code || '');
  if (ac < bc) return -1;
  if (ac > bc) return 1;
  return compareCanonicalJson(a, b);
}

module.exports = {
  flatten,
  optimize,
  canonicalizeIR,
  canonicalIRHash,
  collectSystems,
  projectToSystem,
  analyzePartitionSafety,
  analyzeProjectedSubtree,
  splitDiffRoot,
  flattenUnionToList,
};
