'use strict';

/*
 * Standalone ValueSet IR compiler.
 *
 * Goals:
 * - Pure compile flow for browser/Node use.
 * - Accept ValueSet JSON plus optional FHIR Parameters.
 * - Resolve imports from inline tx-resources first, then injected resolver(s).
 * - Produce:
 *   - basicIR   (direct compile from compose)
 *   - resolvedIR (imports resolved)
 *   - loweredIR (optimized/lowered form)
 *
 * In Node (FHIRSmith context), this module auto-loads current engine builders
 * for behavior parity. In browser, it falls back to local implementations,
 * while still allowing dependency injection.
 */

function detectNodeEngineImpl() {
  if (typeof require !== 'function') return null;
  try {
    const build = require('./build-ir');
    const resolve = require('./resolve-imports');
    const rewrite = require('./rewrite');
    return {
      buildIRFromValueSet: build.buildIRFromValueSet,
      resolveImports: resolve.resolveImports,
      optimize: rewrite.optimize,
    };
  } catch (_err) {
    return null;
  }
}

const NODE_IMPL = detectNodeEngineImpl();

function empty() { return { kind: 'empty' }; }

function selector({
  system,
  version = null,
  shape,
  conceptCodes = null,
  filterClauses = null,
  intersectCodes = null,
  text = null,
  meta = null,
}) {
  return { kind: 'selector', system, version, shape, conceptCodes, filterClauses, intersectCodes, text, meta };
}

function importRef({ url, version = null, meta = null }) {
  return { kind: 'import', url, version, resolved: null, meta };
}

function union(items, meta = null) {
  const flat = [];
  for (const it of items || []) {
    if (!it) continue;
    if (it.kind === 'union') flat.push(...(it.items || []));
    else if (it.kind !== 'empty') flat.push(it);
  }
  if (flat.length === 0) return empty();
  if (flat.length === 1) return flat[0];
  return { kind: 'union', items: flat, meta };
}

function intersect(items, meta = null) {
  const flat = [];
  for (const it of items || []) {
    if (!it) continue;
    if (it.kind === 'intersect') flat.push(...(it.items || []));
    else if (it.kind !== 'empty') flat.push(it);
  }
  if (flat.length === 0) return empty();
  if (flat.length === 1) return flat[0];
  return { kind: 'intersect', items: flat, meta };
}

function diff(left, right, meta = null) {
  if (!left || left.kind === 'empty') return empty();
  if (!right || right.kind === 'empty') return left;
  return { kind: 'diff', left, right, meta };
}

function buildIRFromValueSetLocal(vsJson, opts = {}) {
  const vs = unwrapResource(vsJson);
  const compose = vs?.compose || {};
  return buildIRFromComposeLocal(compose, opts);
}

function buildIRFromComposeLocal(compose, opts = {}) {
  const includes = Array.isArray(compose?.include) ? compose.include : [];
  const excludes = Array.isArray(compose?.exclude) ? compose.exclude : [];

  const includeExprs = includes.map((cset, i) => buildComponentExprLocal(cset, `ValueSet.compose.include[${i}]`, opts));
  const excludeExprs = excludes.map((cset, i) => buildComponentExprLocal(cset, `ValueSet.compose.exclude[${i}]`, opts));

  return diff(union(includeExprs, { role: 'includes' }), union(excludeExprs, { role: 'excludes' }), { role: 'root' });
}

function buildComponentExprLocal(cset, path, opts = {}) {
  const meta = { path };

  if (!cset?.system) {
    const refs = (cset?.valueSet || []).map((u, j) => importRef({
      url: String(u),
      version: null,
      meta: { path: `${path}.valueSet[${j}]` },
    }));
    return union(refs, meta);
  }

  const system = String(cset.system);
  const version = cset.version ? String(cset.version) : null;

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
    leaf = selector({ system, version, shape: 'concept', conceptCodes, meta });
  } else if (Array.isArray(cset.filter) && cset.filter.length > 0) {
    const filterClauses = cset.filter.map((f, j) => ({
      property: String(f.property || ''),
      op: String(f.op || ''),
      value: f.value != null ? String(f.value) : null,
      meta: { path: `${path}.filter[${j}]` },
    }));
    leaf = selector({ system, version, shape: 'filter', filterClauses, meta });
  } else {
    leaf = selector({ system, version, shape: 'whole', meta });
  }

  const imports = (cset.valueSet || []).map((u, j) => importRef({
    url: String(u),
    version: null,
    meta: { path: `${path}.valueSet[${j}]` },
  }));
  if (imports.length === 0) return leaf;
  return intersect([leaf, ...imports], meta);
}

function flattenLocal(expr) {
  if (!expr || typeof expr !== 'object') return expr;
  switch (expr.kind) {
  case 'empty':
  case 'selector':
    return expr;
  case 'import':
    return expr.resolved ? { ...expr, resolved: flattenLocal(expr.resolved) } : expr;
  case 'union':
    return union((expr.items || []).map(flattenLocal), expr.meta);
  case 'intersect':
    return intersect((expr.items || []).map(flattenLocal), expr.meta);
  case 'diff':
    return diff(flattenLocal(expr.left), flattenLocal(expr.right), expr.meta);
  default:
    return expr;
  }
}

function optimizeLocal(expr, opts = {}) {
  const flat = flattenLocal(expr);
  if (opts && (opts.disableRewriteOpt === true || opts.rewriteOpt === false)) return flat;
  return simplifyLocal(flat);
}

function simplifyLocal(expr) {
  if (!expr || typeof expr !== 'object') return expr;
  switch (expr.kind) {
  case 'empty':
  case 'selector':
    return expr;
  case 'import':
    return expr.resolved ? simplifyLocal(expr.resolved) : expr;
  case 'union': {
    const items = (expr.items || []).map(simplifyLocal).filter(it => it && it.kind !== 'empty');
    return coalesceUnionItemsLocal(items, expr.meta);
  }
  case 'intersect': {
    const items = (expr.items || []).map(simplifyLocal);
    return coalesceIntersectItemsLocal(items, expr.meta);
  }
  case 'diff': {
    const left = simplifyLocal(expr.left);
    const right = simplifyLocal(expr.right);
    if (!left || left.kind === 'empty') return empty();
    if (!right || right.kind === 'empty') return left;
    const partitioned = partitionDiffBySystemLocal(left, right, expr.meta);
    if (partitioned) return simplifyLocal(partitioned);
    return diff(left, right, expr.meta);
  }
  default:
    return expr;
  }
}

function coalesceUnionItemsLocal(items, meta) {
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
      const ckey = selectorKeyLocal(item, 'concept');
      const wkey = selectorKeyLocal(item, 'whole');
      if (wholeByKey.has(wkey)) continue;
      const idx = conceptByKey.get(ckey);
      if (idx != null) {
        out[idx] = mergeConceptSelectorsLocal(out[idx], item);
      } else {
        conceptByKey.set(ckey, out.length);
        out.push(item);
      }
      continue;
    }

    if (shape === 'whole' || shape === 'all') {
      const wkey = selectorKeyLocal(item, 'whole');
      if (wholeByKey.has(wkey)) continue;

      const ckey = selectorKeyLocal(item, 'concept');
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
      const sig = filterSignatureLocal(item);
      if (filterBySig.has(sig)) continue;
      filterBySig.add(sig);
      out.push(item);
      continue;
    }

    out.push(item);
  }

  return union(out.filter(Boolean), meta);
}

function mergeConceptSelectorsLocal(a, b) {
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
  return { ...a, conceptCodes: merged };
}

function coalesceIntersectItemsLocal(items, meta) {
  const raw = (items || []).filter(Boolean);
  if (raw.length === 0) return empty();
  if (raw.some(it => it.kind === 'empty')) return empty();

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

    const key = intersectSelectorKeyLocal(item);
    const idx = selectorByKey.get(key);
    if (idx == null) {
      selectorByKey.set(key, out.length);
      out.push(item);
      continue;
    }

    const merged = mergeSelectorsForIntersectLocal(out[idx], item);
    if (!merged) {
      out.push(item);
      continue;
    }
    if (merged.kind === 'empty') return empty();
    out[idx] = merged;
  }

  return intersect(out, meta);
}

function mergeSelectorsForIntersectLocal(a, b) {
  if (!a || !b) return null;
  const ak = canonicalShapeLocal(a.shape);
  const bk = canonicalShapeLocal(b.shape);
  if (ak === 'whole') return b;
  if (bk === 'whole') return a;

  if (ak === 'concept' && bk === 'concept') {
    const amap = conceptCodeMapLocal(a.conceptCodes || []);
    const both = [];
    for (const c of b.conceptCodes || []) {
      const code = String(c?.code || '');
      if (!code || !amap.has(code)) continue;
      both.push(amap.get(code));
    }
    if (both.length === 0) return empty();
    return { ...a, conceptCodes: dedupeConceptCodesLocal(both) };
  }

  if (ak === 'filter' && bk === 'filter') {
    const clauses = dedupeFilterClausesLocal([...(a.filterClauses || []), ...(b.filterClauses || [])]);
    const intersectCodes = intersectCodeListsLocal(a.intersectCodes || null, b.intersectCodes || null);
    if (Array.isArray(intersectCodes) && intersectCodes.length === 0) return empty();
    return { ...a, filterClauses: clauses, ...(intersectCodes ? { intersectCodes } : {}) };
  }

  if (ak === 'filter' && bk === 'concept') {
    const codes = dedupeConceptCodesLocal(b.conceptCodes || []).map(c => String(c.code));
    if (codes.length === 0) return empty();
    const intersectCodes = intersectCodeListsLocal(a.intersectCodes || null, codes);
    if (Array.isArray(intersectCodes) && intersectCodes.length === 0) return empty();
    return { ...a, ...(intersectCodes ? { intersectCodes } : { intersectCodes: codes }) };
  }

  if (ak === 'concept' && bk === 'filter') return mergeSelectorsForIntersectLocal(b, a);
  return null;
}

function partitionDiffBySystemLocal(left, right, meta) {
  const leftSystems = [...collectSystemsLocal(left).values()];
  if (leftSystems.length <= 1) return null;

  const parts = [];
  for (const { system, version } of leftSystems) {
    const l = projectToSystemLocal(left, system, version);
    if (!l || l.kind === 'empty') continue;
    const r = projectToSystemLocal(right, system, version);
    parts.push(diff(l, r || empty(), {
      ...(meta || {}),
      role: 'partitioned-diff',
      system,
      version: version || null,
    }));
  }
  if (parts.length === 0) return empty();
  return union(parts, { ...(meta || {}), role: 'partitioned-diff-union' });
}

function selectorKeyLocal(sel, shapeOverride = null) {
  return JSON.stringify([
    String(sel?.system || ''),
    sel?.version || null,
    String(shapeOverride || sel?.shape || ''),
    normalizeTextLocal(sel?.text),
  ]);
}

function intersectSelectorKeyLocal(sel) {
  return JSON.stringify([
    String(sel?.system || ''),
    sel?.version || null,
    normalizeTextLocal(sel?.text),
  ]);
}

function normalizeTextLocal(text) {
  const t = text == null ? '' : String(text).trim();
  return t.length > 0 ? t : null;
}

function filterSignatureLocal(sel) {
  const clauses = dedupeFilterClausesLocal((sel?.filterClauses || []).map(c => ({
    property: c?.property ?? null,
    op: c?.op ?? null,
    value: c?.value ?? null,
  })));
  return JSON.stringify([
    String(sel?.system || ''),
    sel?.version || null,
    normalizeTextLocal(sel?.text),
    clauses,
  ]);
}

function dedupeFilterClausesLocal(clauses) {
  const out = [];
  const seen = new Set();
  for (const c of clauses || []) {
    if (!c) continue;
    const sig = JSON.stringify([c.property ?? null, c.op ?? null, c.value ?? null]);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
  }
  out.sort((a, b) => {
    const ak = `${a.property || ''}\u0000${a.op || ''}\u0000${a.value || ''}`;
    const bk = `${b.property || ''}\u0000${b.op || ''}\u0000${b.value || ''}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return out;
}

function dedupeConceptCodesLocal(codes) {
  const out = [];
  const seen = new Set();
  for (const c of codes || []) {
    const code = String(c?.code || '');
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(c);
  }
  return out;
}

function conceptCodeMapLocal(codes) {
  const map = new Map();
  for (const c of dedupeConceptCodesLocal(codes || [])) map.set(String(c.code), c);
  return map;
}

function canonicalShapeLocal(shape) {
  const s = String(shape || '').toLowerCase();
  if (s === 'all') return 'whole';
  return s;
}

function intersectCodeListsLocal(a, b) {
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

function collectSystemsLocal(expr, out = new Map()) {
  if (!expr) return out;
  switch (expr.kind) {
  case 'selector': {
    const k = `${expr.system}|${expr.version || ''}`;
    if (!out.has(k)) out.set(k, { system: expr.system, version: expr.version || null });
    break;
  }
  case 'import':
    if (expr.resolved) collectSystemsLocal(expr.resolved, out);
    break;
  case 'union':
  case 'intersect':
    for (const it of expr.items || []) collectSystemsLocal(it, out);
    break;
  case 'diff':
    collectSystemsLocal(expr.left, out);
    collectSystemsLocal(expr.right, out);
    break;
  default:
    break;
  }
  return out;
}

function projectToSystemLocal(expr, system, version = null) {
  if (!expr) return empty();
  switch (expr.kind) {
  case 'empty':
    return expr;
  case 'selector':
    if (String(expr.system) !== String(system)) return empty();
    if (version != null && (expr.version || null) !== version) return empty();
    return expr;
  case 'import':
    if (expr.resolved) return projectToSystemLocal(expr.resolved, system, version);
    return { ...expr };
  case 'union':
    return union((expr.items || []).map(it => projectToSystemLocal(it, system, version)), expr.meta);
  case 'intersect': {
    const projected = (expr.items || []).map(it => projectToSystemLocal(it, system, version));
    if (projected.some(it => !it || it.kind === 'empty')) return empty();
    return intersect(projected, expr.meta);
  }
  case 'diff':
    return diff(projectToSystemLocal(expr.left, system, version), projectToSystemLocal(expr.right, system, version), expr.meta);
  default:
    return empty();
  }
}

async function resolveImportsLocal(expr, resolveValueSet, opts = {}) {
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 20;
  const cache = opts.cache instanceof Map ? opts.cache : new Map();
  const preferComposeOverExpansion = opts.preferComposeOverExpansion !== false;
  const stack = [];

  async function resolveNode(node, depth) {
    if (!node || typeof node !== 'object') return node;
    if (depth > maxDepth) {
      throw new Error(`Import resolution exceeded maxDepth=${maxDepth} at ${node?.meta?.path || '?'}`);
    }

    switch (node.kind) {
    case 'empty':
    case 'selector':
      return node;
    case 'union':
      return { ...node, items: await Promise.all((node.items || []).map(n => resolveNode(n, depth + 1))) };
    case 'intersect':
      return { ...node, items: await Promise.all((node.items || []).map(n => resolveNode(n, depth + 1))) };
    case 'diff':
      return { ...node, left: await resolveNode(node.left, depth + 1), right: await resolveNode(node.right, depth + 1) };
    case 'import':
      return await resolveImport(node, depth + 1);
    default:
      return node;
    }
  }

  function parseRef(url) {
    const raw = String(url || '');
    if (!raw.includes('|')) return { url: raw, version: null };
    const i = raw.indexOf('|');
    return { url: raw.slice(0, i), version: raw.slice(i + 1) || null };
  }

  async function resolveImport(node, depth) {
    if (node.resolved) return node;

    const parsed = parseRef(node.url);
    const url = parsed.url;
    const version = node.version || parsed.version || null;
    const key = version ? `${url}|${version}` : url;

    if (stack.includes(key)) {
      const cycle = [...stack, key].join(' -> ');
      throw new Error(`ValueSet import cycle detected: ${cycle}`);
    }

    if (cache.has(key)) return { ...node, resolved: cache.get(key) };

    stack.push(key);
    try {
      const vs = await resolveValueSet(url, version);
      if (!vs) throw new Error(`Imported ValueSet not found: ${key}`);

      const vsJson = unwrapResource(vs);
      let importedExpr;
      if (preferComposeOverExpansion && vsJson?.compose) {
        importedExpr = buildIRFromValueSetLocal(vsJson);
      } else if (vsJson?.expansion?.contains) {
        importedExpr = buildIRFromExpansionLocal(vsJson);
      } else {
        importedExpr = buildIRFromValueSetLocal(vsJson);
      }

      importedExpr = await resolveNode(importedExpr, depth + 1);
      cache.set(key, importedExpr);
      return { ...node, resolved: importedExpr };
    } finally {
      stack.pop();
    }
  }

  return resolveNode(expr, 0);
}

function buildIRFromExpansionLocal(vsJson) {
  const rows = [];
  function walk(list) {
    for (const c of list || []) {
      if (c && c.system && c.code) {
        rows.push({
          system: String(c.system),
          version: c.version ? String(c.version) : null,
          code: String(c.code),
          display: c.display != null ? String(c.display) : null,
          inactive: !!c.inactive,
        });
      }
      if (c?.contains?.length) walk(c.contains);
    }
  }
  walk(vsJson?.expansion?.contains || []);

  const bySys = new Map();
  for (const r of rows) {
    const k = `${r.system}|${r.version || ''}`;
    if (!bySys.has(k)) bySys.set(k, { system: r.system, version: r.version, codes: [] });
    bySys.get(k).codes.push({ code: r.code, display: r.display, inactive: r.inactive });
  }

  const selectors = [];
  for (const g of bySys.values()) {
    selectors.push(selector({
      system: g.system,
      version: g.version,
      shape: 'concept',
      conceptCodes: g.codes.map((c) => ({
        code: c.code,
        display: c.display,
        inactive: c.inactive,
        meta: { path: 'ValueSet.expansion.contains' },
      })),
      meta: { path: 'ValueSet.expansion.contains.group' },
    }));
  }

  return union(selectors, { path: 'ValueSet.expansion.contains.union' });
}

function normalizeInput(input = {}) {
  if (input?.resourceType === 'ValueSet') return { valueSet: input };
  if (input?.resourceType === 'Parameters') return { parameters: input };
  return input || {};
}

function unwrapResource(resource) {
  return resource?.jsonObj || resource;
}

function parseCanonicalRef(raw) {
  const text = String(raw || '').trim();
  if (!text) return { url: '', version: null };
  const pipe = text.indexOf('|');
  if (pipe < 0) return { url: text, version: null };
  return {
    url: text.slice(0, pipe),
    version: text.slice(pipe + 1) || null,
  };
}

function addValueSetToIndex(index, valueSetResource) {
  const vs = unwrapResource(valueSetResource);
  if (!vs || vs.resourceType !== 'ValueSet') return;
  const url = String(vs.url || '').trim();
  if (!url) return;
  const version = vs.version ? String(vs.version) : null;
  if (!index.has(url)) index.set(url, new Map());
  index.get(url).set(version || '', vs);
}

function buildInlineValueSetIndex({ valueSet, parameters, additionalResources = [] }) {
  const index = new Map();
  addValueSetToIndex(index, valueSet);

  for (const r of additionalResources || []) addValueSetToIndex(index, r);

  const params = unwrapResource(parameters);
  const parts = Array.isArray(params?.parameter) ? params.parameter : [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const name = String(p.name || '');
    if (name === 'tx-resource' || name === 'valueSet') {
      if (p.resource?.resourceType === 'ValueSet') addValueSetToIndex(index, p.resource);
    }
  }

  return index;
}

function makeInlineResolver(index) {
  return async function resolveInline(url, version = null) {
    const byVersion = index.get(String(url || ''));
    if (!byVersion) return null;
    if (version != null) {
      const v = String(version || '');
      if (byVersion.has(v)) return byVersion.get(v);
      return null;
    }
    if (byVersion.size === 1) return byVersion.values().next().value;
    if (byVersion.has('')) return byVersion.get('');
    return byVersion.values().next().value;
  };
}

function pickRootValueSetInline(valueSet, parameters) {
  if (valueSet) return unwrapResource(valueSet);

  const params = unwrapResource(parameters);
  const parts = Array.isArray(params?.parameter) ? params.parameter : [];

  for (const p of parts) {
    if (String(p?.name || '') !== 'valueSet') continue;
    if (p.resource?.resourceType === 'ValueSet') return unwrapResource(p.resource);
  }
  return null;
}

function pickRootCanonical(parameters) {
  const params = unwrapResource(parameters);
  const parts = Array.isArray(params?.parameter) ? params.parameter : [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const name = String(p.name || '');
    if (name !== 'url') continue;
    if (p.valueUri) return parseCanonicalRef(p.valueUri);
    if (p.valueCanonical) return parseCanonicalRef(p.valueCanonical);
    if (p.valueString) return parseCanonicalRef(p.valueString);
  }
  return null;
}

function normalizeResolverDeps(deps = {}) {
  const out = [];
  if (typeof deps.resolveValueSet === 'function') out.push(deps.resolveValueSet);
  if (typeof deps.resolver === 'function') out.push(deps.resolver);
  if (typeof deps.resolve === 'function') out.push(deps.resolve);
  return out;
}

function createFetchValueSetResolver(opts = {}) {
  const fetchFn = opts.fetchFn || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchFn) {
    throw new Error('createFetchValueSetResolver requires fetchFn in this environment');
  }

  const buildUrl = typeof opts.buildUrl === 'function'
    ? opts.buildUrl
    : (url, version) => {
      const base = String(opts.endpoint || '').trim();
      if (!base) {
        throw new Error('createFetchValueSetResolver requires endpoint or buildUrl');
      }
      const u = new URL(base, typeof window !== 'undefined' ? window.location?.origin : undefined);
      u.searchParams.set('url', String(url || ''));
      if (version) u.searchParams.set('valueSetVersion', String(version));
      return String(u);
    };

  const headers = opts.headers || {};

  return async function fetchResolveValueSet(url, version = null) {
    if (!url) return null;
    const target = buildUrl(url, version);
    const res = await fetchFn(target, { headers });
    if (!res || !res.ok) return null;
    const json = await res.json();
    if (!json || json.resourceType !== 'ValueSet') return null;
    return json;
  };
}

async function compileValueSetIR(input = {}, deps = {}) {
  const normalized = normalizeInput(input);
  const inlineIndex = buildInlineValueSetIndex({
    valueSet: normalized.valueSet,
    parameters: normalized.parameters,
    additionalResources: normalized.additionalResources || [],
  });

  const resolveInline = makeInlineResolver(inlineIndex);
  const resolverFns = normalizeResolverDeps(deps);

  const resolveValueSet = async (url, version = null) => {
    const inline = await resolveInline(url, version);
    if (inline) return inline;

    for (const fn of resolverFns) {
      const out = await fn(url, version, {
        valueSet: normalized.valueSet,
        parameters: normalized.parameters,
        additionalResources: normalized.additionalResources || [],
      });
      if (out) return unwrapResource(out);
    }

    return null;
  };

  let root = pickRootValueSetInline(normalized.valueSet, normalized.parameters);
  if (!root) {
    const ref = pickRootCanonical(normalized.parameters);
    if (ref?.url) {
      root = await resolveValueSet(ref.url, ref.version || null);
    }
  }

  if (!root || root.resourceType !== 'ValueSet') {
    throw new Error('compileValueSetIR requires a ValueSet input (direct JSON, Parameters.valueSet resource, or Parameters.url resolvable via resolver)');
  }

  const impl = {
    buildIRFromValueSet: deps.buildIRFromValueSet || NODE_IMPL?.buildIRFromValueSet || buildIRFromValueSetLocal,
    resolveImports: deps.resolveImports || NODE_IMPL?.resolveImports || resolveImportsLocal,
    optimize: deps.optimize || NODE_IMPL?.optimize || optimizeLocal,
  };

  const buildOpts = normalized.buildOptions || normalized.buildOpts || {};
  const resolveOpts = normalized.resolveOptions || normalized.resolveOpts || {};
  const optimizeOpts = normalized.optimizeOptions || normalized.loweringOptions || {};

  const basicIR = impl.buildIRFromValueSet(root, buildOpts);
  const resolvedIR = await impl.resolveImports(basicIR, resolveValueSet, resolveOpts);
  const loweredIR = impl.optimize.length >= 2
    ? impl.optimize(resolvedIR, optimizeOpts)
    : impl.optimize(resolvedIR);

  return {
    rootValueSet: root,
    basicIR,
    resolvedIR,
    loweredIR,
    diagnostics: {
      inlineValueSetCount: [...inlineIndex.values()].reduce((n, byV) => n + byV.size, 0),
      hasExternalResolver: resolverFns.length > 0,
    },
  };
}

const api = {
  compileValueSetIR,
  createFetchValueSetResolver,

  // Exported for optional advanced embedding and testing.
  _local: {
    buildIRFromValueSetLocal,
    resolveImportsLocal,
    optimizeLocal,
    buildIRFromComposeLocal,
    buildComponentExprLocal,
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof globalThis !== 'undefined') {
  const key = 'ValueSetIRCompiler';
  if (!globalThis[key]) globalThis[key] = api;
}
