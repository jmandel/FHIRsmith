'use strict';

const IR = require('./ir');
const rewrite = require('./rewrite');
const { MultiSystemIndex, makeSysVerKey } = require('./membership/index');
const { InMemorySetIndex } = require('./membership/inmem-set');
const { decideTotalOutcome } = require('./total-policy');
const { compileExprToQueryIR } = require('./query-ir-compiler');
const { trace: T } = require('../../../expand-trace');

/**
 * Execute an expand-v3 membership plan.
 *
 * Inputs:
 * - expr: resolved+flattened Expr (usually Diff(Union(includes), Union(excludes)))
 * - registry: { getAdapter(system, version, mode) -> CsEngineAdapter }
 * - execCtx:
 *    - offset (default 0)
 *    - count (default -1 means unpaged)
 *    - useVersion (boolean)
 *    - activeOnly, excludeNotForUI
 *    - textFilter (SearchFilterText-like object with .passes(), .filter)
 *    - allAltCodes (optional)
 *    - batchSize (default 512)
 *
 * Output:
 * - page: Candidate[]
 * - stats
 * - total (number|null) and totalStatus ('known'|'unknown'|'off')
 * - notClosed (boolean)
 */
async function executeExpandV3(expr, registry, execCtx) {
  const ctx = {
    offset: Number.isInteger(execCtx?.offset) ? execCtx.offset : 0,
    count: Number.isInteger(execCtx?.count) ? execCtx.count : -1,
    useVersion: !!execCtx?.useVersion,
    activeOnly: !!execCtx?.activeOnly,
    excludeNotForUI: !!execCtx?.excludeNotForUI,
    textFilter: execCtx?.textFilter || null,
    allAltCodes: execCtx?.allAltCodes || null,
    batchSize: Number.isInteger(execCtx?.batchSize) ? execCtx.batchSize : 512,
    filterPageSize: Number.isInteger(execCtx?.filterPageSize) ? execCtx.filterPageSize : 256,
    limitCount: Number.isInteger(execCtx?.limitCount) && execCtx.limitCount > 0 ? execCtx.limitCount : 0,
    continueAfterPage: !!execCtx?.continueAfterPage,
    needTotal: !!execCtx?.needTotal,
    disablePushdown: !!execCtx?.disablePushdown,
    disableMembership: !!execCtx?.disableMembership,
    notClosed: false,
    requestProviderTotal: false,
    _providerStreamTotals: [],
    onProviderStreamTotal(info) {
      if (!info || typeof info.total !== 'number' || !Number.isFinite(info.total)) return;
      this._providerStreamTotals.push({
        source: info.source || 'unknown',
        system: info.system || null,
        version: info.version || null,
        total: info.total,
      });
    },
    // internal caches
    _indexCache: new Map(),
  };

  const flat = rewrite.flatten(expr);

  // Count-only fast-path: if the full expression compiles to a single-provider
  // query IR, ask the provider for total directly instead of streaming includes
  // and applying excludes/membership in worker space.
  if (ctx.count === 0) {
    const countOnly = await tryCountOnlyByQueryIR(flat, registry, ctx);
    if (countOnly) return countOnly;
  }

  // Partitioned diff fast-path:
  // For multi-system root diffs, rewrite into a union of per-system diffs:
  //   Diff(L, R)  =>  Union_s Diff(project(L,s), project(R,s))
  // This allows same-system include/exclude pushdown while naturally dropping
  // disjoint excludes from other systems.
  const partitioned = buildPartitionedDiffExpr(flat);
  const working = partitioned ? rewrite.flatten(partitioned) : flat;

  // Full-root pushdown fast path:
  // if the entire expression compiles to one provider queryIR, keep it intact
  // so we avoid splitting include/exclude into separate streams + membership.
  const fullRootPushdown = await canUseFullRootPushdown(working, registry, ctx);

  // Count-only component fast-path:
  // when full-expression pushdown is not possible, probe each top-level union
  // component separately and sum provider totals if components are disjoint by
  // system/version.
  if (ctx.count === 0) {
    const countByParts = await tryCountOnlyByComponents(working, registry, ctx);
    if (countByParts) return countByParts;
  }

  const split = fullRootPushdown
    ? { include: IR.union([working], { role: 'root-queryir' }), exclude: IR.empty() }
    : rewrite.splitDiffRoot(working);
  const { include, exclude } = split;

  const spanExclude = T.active && exclude?.kind !== 'empty' ? T.begin('v3.exec.buildExcludeIndex') : null;
  const excludeIndex = await buildMembershipIndex(exclude, registry, ctx);
  if (spanExclude) spanExclude.end();

  const components = rewrite.flattenUnionToList(include);
  const wantPaging = ctx.count >= 0;
  const singleIncludeComponent =
    Array.isArray(components) && components.length === 1;
  const noGlobalMembershipPostFilters =
    exclude?.kind === 'empty'
    && !ctx.activeOnly
    && !ctx.excludeNotForUI;
  const canRequestProviderTotal =
    wantPaging
    && ctx.needTotal
    && singleIncludeComponent
    && noGlobalMembershipPostFilters;
  ctx.requestProviderTotal = canRequestProviderTotal;
  ctx.allowProviderPaging = canRequestProviderTotal;

  const page = [];
  let survivors = 0;
  let scanned = 0;
  let deduped = 0;
  let excluded = 0;
  const seen = new Set();

  let done = false;
  let limitedByCap = false;
  const effectiveLimit = ctx.limitCount > 0
    ? (wantPaging ? Math.max(ctx.limitCount, Math.max(0, ctx.offset) + Math.max(0, ctx.count)) : ctx.limitCount)
    : 0;

  const spanStream = T.active ? T.begin('v3.exec.stream', { components: components.length }) : null;

  for (const comp of components) {
    if (done) break;

    const iter = enumerateExpr(comp, registry, ctx);
    let batch = [];

    for await (const cand of iter) {
      scanned++;

      const kstr = keyToString(cand.key, ctx.useVersion);
      if (seen.has(kstr)) { deduped++; continue; }
      seen.add(kstr);

      batch.push(cand);
      if (batch.length >= ctx.batchSize) {
        const res = await flushBatch(batch);
        survivors += res.survivors;
        excluded += res.excluded;
        limitedByCap = limitedByCap || res.limited;
        batch = [];
        if (limitedByCap) { done = true; break; }
        if (wantPaging && page.length >= ctx.count && !ctx.continueAfterPage) { done = true; break; }
      }
    }

    if (batch.length) {
      const res = await flushBatch(batch);
      survivors += res.survivors;
      excluded += res.excluded;
      limitedByCap = limitedByCap || res.limited;
      batch = [];
      if (limitedByCap) { done = true; break; }
      if (wantPaging && page.length >= ctx.count && !ctx.continueAfterPage) { done = true; }
    }
  }
  if (spanStream) spanStream.end({ scanned, survivors, excluded, deduped });

  if (limitedByCap && !wantPaging && !ctx.textFilter) {
    throw new Error(`VALUESET_TOO_COSTLY: >${ctx.limitCount}`);
  }

  const totalDecision = decideTotalOutcome({
    wantPaging,
    count: ctx.count,
    done,
    limitedByCap,
    textFilter: ctx.textFilter,
    survivors,
  });
  let totalStatus = totalDecision.totalStatus;
  let total = totalDecision.total;

  const providerTotal = pickSafeProviderTotal({
    wantPaging,
    exclude,
    components,
    activeOnly: ctx.activeOnly,
    excludeNotForUI: ctx.excludeNotForUI,
    deduped,
    providerTotals: ctx._providerStreamTotals,
  });
  if (totalStatus !== 'known' && Number.isFinite(providerTotal)) {
    totalStatus = 'known';
    total = providerTotal;
  }

  return {
    page,
    stats: { scanned, survivors, excluded, deduped, returned: page.length },
    total,
    totalStatus,
    notClosed: !!ctx.notClosed,
  };

  async function flushBatch(batchCands) {
    const keys = batchCands.map(c => c.key);
    const excludedMask = excludeIndex.isEmpty() ? new Array(keys.length).fill(false) : await excludeIndex.batchHas(keys);

    let batchSurvivors = 0;
    let batchExcluded = 0;
    let limited = false;

    for (let i = 0; i < batchCands.length; i++) {
      if (excludedMask[i]) { batchExcluded++; continue; }

      const survivorOrdinal = survivors + batchSurvivors;
      if (isSafetyLimitReached(effectiveLimit, survivorOrdinal)) {
        limited = true;
        break;
      }

      const pagingAction = classifyPagingAction({
        wantPaging,
        count: ctx.count,
        offset: ctx.offset,
        pageSize: page.length,
        continueAfterPage: ctx.continueAfterPage,
        survivorOrdinal,
      });

      if (pagingAction === 'countOnly') {
        batchSurvivors++;
        continue;
      }
      if (pagingAction === 'stopPage') {
        break;
      }

      page.push(batchCands[i]);
      batchSurvivors++;
      if (wantPaging && page.length >= ctx.count && !ctx.continueAfterPage) break;
    }

    return { survivors: batchSurvivors, excluded: batchExcluded, limited };
  }
}

function buildPartitionedDiffExpr(expr) {
  if (!expr || expr.kind !== 'diff') return null;
  const leftSystems = [...rewrite.collectSystems(expr.left).values()];
  if (leftSystems.length <= 1) return null;

  const parts = [];
  for (const { system, version } of leftSystems) {
    const left = rewrite.projectToSystem(expr.left, system, version);
    if (!left || left.kind === 'empty') continue;
    const right = rewrite.projectToSystem(expr.right, system, version);
    parts.push(IR.diff(left, right || IR.empty(), {
      role: 'partitioned-diff',
      system,
      version: version || null,
    }));
  }
  if (parts.length === 0) return null;
  return IR.union(parts, { role: 'partitioned-diff-union' });
}

function pickSafeProviderTotal({
  wantPaging,
  exclude,
  components,
  activeOnly,
  excludeNotForUI,
  deduped,
  providerTotals,
}) {
  if (!wantPaging) return null;
  if (!Array.isArray(components) || components.length !== 1) return null;
  if (!components[0] || components[0].kind !== 'selector') return null;
  if (!exclude || exclude.kind !== 'empty') return null;
  if (activeOnly || excludeNotForUI) return null;
  if (deduped > 0) return null;
  if (!Array.isArray(providerTotals) || providerTotals.length !== 1) return null;
  const n = Number(providerTotals[0].total);
  return Number.isFinite(n) ? n : null;
}

function isSafetyLimitReached(effectiveLimit, survivorOrdinal) {
  return effectiveLimit > 0 && survivorOrdinal >= effectiveLimit;
}

function classifyPagingAction({ wantPaging, count, offset, pageSize, continueAfterPage, survivorOrdinal }) {
  if (!wantPaging) return 'emit';
  if (count === 0) return 'countOnly';
  if (survivorOrdinal < offset) return 'countOnly';
  if (pageSize >= count) return continueAfterPage ? 'countOnly' : 'stopPage';
  return 'emit';
}

/**
 * Enumerate an expression as an async generator of Candidate objects.
 * This generator preserves deterministic traversal order:
 * - union: sequential concat
 * - import: depth-first
 * - diff: left stream filtered by membership index of right
 * - intersect: first stream filtered by membership indexes of remaining items
 */
async function* enumerateExpr(expr, registry, ctx) {
  if (!expr || expr.kind === 'empty') return;

  const pushed = await tryEnumerateExprByQueryIR(expr, registry, ctx);
  if (pushed) {
    yield* pushed;
    return;
  }

  switch (expr.kind) {
  case 'selector': {
    const adapter = await registry.getAdapter(expr.system, expr.version || null, 'include');
    yield* adapter.enumerateSelector(expr, ctx);
    return;
  }
  case 'import': {
    if (!expr.resolved) return;
    yield* enumerateExpr(expr.resolved, registry, ctx);
    return;
  }
  case 'union': {
    for (const it of expr.items || []) {
      yield* enumerateExpr(it, registry, ctx);
    }
    return;
  }
  case 'diff': {
    const rightIdx = await buildMembershipIndex(expr.right, registry, ctx);
    const leftIter = enumerateExpr(expr.left, registry, ctx);
    yield* filterByIndex(leftIter, rightIdx, ctx);
    return;
  }
  case 'intersect': {
    const items = expr.items || [];
    if (items.length === 0) return;
    if (items.length === 1) { yield* enumerateExpr(items[0], registry, ctx); return; }

    // Choose the first item as base stream, and build indexes for the rest.
    const base = enumerateExpr(items[0], registry, ctx);
    const indexes = [];
    for (let i = 1; i < items.length; i++) {
      indexes.push(await buildMembershipIndex(items[i], registry, ctx));
    }
    yield* filterByAllIndexes(base, indexes, ctx);
    return;
  }
  default:
    return;
  }
}

async function tryEnumerateExprByQueryIR(expr, registry, ctx) {
  if (ctx?.disablePushdown) return null;
  const queryIR = compileExprToQueryIR(expr, { textFilter: ctx.textFilter });
  if (!queryIR || !queryIR.system) return null;

  const adapter = await registry.getAdapter(queryIR.system, queryIR.version || null, 'include');
  if (!adapter || typeof adapter.enumerateQueryIR !== 'function') return null;
  const report = adapter.report || {};
  if (!report.query) return null;
  if (hasSupplementsButNoNativeFiltering(adapter, report)) return null;

  const iter = await adapter.enumerateQueryIR(queryIR, ctx);
  return iter || null;
}

async function tryCountOnlyByQueryIR(expr, registry, ctx) {
  if (ctx?.disablePushdown) return null;
  const queryIR = compileExprToQueryIR(expr, { textFilter: ctx.textFilter });
  if (!queryIR || !queryIR.system) return null;

  const adapter = await registry.getAdapter(queryIR.system, queryIR.version || null, 'include');
  if (!adapter || typeof adapter.enumerateQueryIR !== 'function') return null;
  const report = adapter.report || {};
  if (!report.query) return null;
  if (hasSupplementsButNoNativeFiltering(adapter, report)) return null;

  const probeCtx = {
    ...ctx,
    offset: 0,
    count: 0,
    allowProviderPaging: true,
    requestProviderTotal: true,
    continueAfterPage: false,
    _providerStreamTotals: [],
    onProviderStreamTotal(info) {
      if (!info || typeof info.total !== 'number' || !Number.isFinite(info.total)) return;
      this._providerStreamTotals.push({
        source: info.source || 'unknown',
        system: info.system || null,
        version: info.version || null,
        total: info.total,
      });
    },
  };

  try {
    const iter = await adapter.enumerateQueryIR(queryIR, probeCtx);
    if (!iter) return null;
    if (typeof iter.return === 'function') {
      try { await iter.return(); } catch (_e) { /* noop */ }
    }
  } catch (_e) {
    return null;
  }

  if (probeCtx.notClosed) ctx.notClosed = true;
  const totals = Array.isArray(probeCtx._providerStreamTotals) ? probeCtx._providerStreamTotals : [];
  if (totals.length === 0) return null;
  const n = Number(totals[0].total);
  if (!Number.isFinite(n)) return null;

  return {
    page: [],
    stats: { scanned: 0, survivors: 0, excluded: 0, deduped: 0, returned: 0 },
    total: n,
    totalStatus: 'known',
    notClosed: !!ctx.notClosed,
  };
}

async function tryCountOnlyByComponents(expr, registry, ctx) {
  if (ctx?.disablePushdown) return null;

  const components = rewrite.flattenUnionToList(expr);
  if (!Array.isArray(components) || components.length < 2) return null;

  // Safety: only sum when components are disjoint by (system,version).
  const seen = new Set();
  for (const comp of components) {
    const systems = [...rewrite.collectSystems(comp).values()];
    if (systems.length !== 1) return null;
    const sv = makeSysVerKey(systems[0].system, systems[0].version || null);
    if (seen.has(sv)) return null;
    seen.add(sv);
  }

  let sum = 0;
  for (const comp of components) {
    const queryIR = compileExprToQueryIR(comp, { textFilter: ctx.textFilter });
    if (!queryIR || !queryIR.system) return null;

    const adapter = await registry.getAdapter(queryIR.system, queryIR.version || null, 'include');
    if (!adapter || typeof adapter.enumerateQueryIR !== 'function') return null;
    const report = adapter.report || {};
    if (!report.query) return null;
    if (hasSupplementsButNoNativeFiltering(adapter, report)) return null;

    const probeCtx = {
      ...ctx,
      offset: 0,
      count: 0,
      allowProviderPaging: true,
      requestProviderTotal: true,
      continueAfterPage: false,
      _providerStreamTotals: [],
      onProviderStreamTotal(info) {
        if (!info || typeof info.total !== 'number' || !Number.isFinite(info.total)) return;
        this._providerStreamTotals.push({
          source: info.source || 'unknown',
          system: info.system || null,
          version: info.version || null,
          total: info.total,
        });
      },
    };

    try {
      const iter = await adapter.enumerateQueryIR(queryIR, probeCtx);
      if (!iter) return null;
      if (typeof iter.return === 'function') {
        try { await iter.return(); } catch (_e) { /* noop */ }
      }
    } catch (_e) {
      return null;
    }

    if (probeCtx.notClosed) ctx.notClosed = true;
    const totals = Array.isArray(probeCtx._providerStreamTotals) ? probeCtx._providerStreamTotals : [];
    if (totals.length === 0) return null;
    const n = Number(totals[0].total);
    if (!Number.isFinite(n)) return null;
    sum += n;
  }

  return {
    page: [],
    stats: { scanned: 0, survivors: 0, excluded: 0, deduped: 0, returned: 0 },
    total: sum,
    totalStatus: 'known',
    notClosed: !!ctx.notClosed,
  };
}

async function* filterByIndex(baseIter, index, ctx) {
  if (!index || index.isEmpty()) {
    yield* baseIter;
    return;
  }
  let batch = [];
  for await (const cand of baseIter) {
    batch.push(cand);
    if (batch.length >= ctx.batchSize) {
      yield* await flush(batch);
      batch = [];
    }
  }
  if (batch.length) yield* await flush(batch);

  async function* flush(batchCands) {
    const keys = batchCands.map(c => c.key);
    const mask = await index.batchHas(keys);
    for (let i = 0; i < batchCands.length; i++) {
      if (!mask[i]) yield batchCands[i];
    }
  }
}

async function* filterByAllIndexes(baseIter, indexes, ctx) {
  const active = (indexes || []).filter(idx => idx && !idx.isEmpty());
  if (active.length === 0) { yield* baseIter; return; }

  let batch = [];
  for await (const cand of baseIter) {
    batch.push(cand);
    if (batch.length >= ctx.batchSize) {
      yield* await flush(batch);
      batch = [];
    }
  }
  if (batch.length) yield* await flush(batch);

  async function* flush(batchCands) {
    const keys = batchCands.map(c => c.key);
    let keep = new Array(keys.length).fill(true);
    for (const idx of active) {
      const hits = await idx.batchHas(keys);
      for (let i = 0; i < keep.length; i++) {
        if (keep[i] && hits[i] !== true) keep[i] = false;
      }
    }
    for (let i = 0; i < batchCands.length; i++) {
      if (keep[i]) yield batchCands[i];
    }
  }
}

/**
 * Build a membership index for an expression.
 *
 * Current implementation:
 * - Per system+version, materialize the projected expr into an in-memory Set.
 * - Hook point: if provider report supports membership, compile expr to queryIR and use adapter.prepareMembership().
 */
async function buildMembershipIndex(expr, registry, ctx) {
  if (!expr || expr.kind === 'empty') return new MultiSystemIndex();

  const key = JSON.stringify(expr); // simple structural cache
  if (ctx._indexCache.has(key)) return ctx._indexCache.get(key);

  const systems = rewrite.collectSystems(expr);
  const sets = new Map();

  for (const { system, version } of systems.values()) {
    const projected = rewrite.projectToSystem(expr, system, version);
    const adapter = await registry.getAdapter(system, version, 'exclude');

    // Try provider-native membership if available
    const idx = await tryProviderMembershipIndex(projected, adapter, ctx);
    if (idx) {
      // Wrap idx to accept codes only
      const wrapped = {
        async batchHas(codes) { return idx.batchHas(codes); },
        async close() { if (idx.close) await idx.close(); },
      };
      sets.set(makeSysVerKey(system, version), { system, version: version || null, index: wrapped });
      continue;
    }

    // Fallback: materialize into in-memory set
    const codeSet = new Set();
    for await (const cand of enumerateExpr(projected, registry, ctx)) {
      if (cand?.key?.code) codeSet.add(String(cand.key.code));
    }
    sets.set(makeSysVerKey(system, version), {
      system,
      version: version || null,
      index: new InMemorySetIndex(codeSet),
    });
  }

  const msIndex = new MultiSystemIndex();
  for (const row of sets.values()) {
    msIndex.set(row.system, row.version, row.index);
  }

  ctx._indexCache.set(key, msIndex);
  return msIndex;
}

async function tryProviderMembershipIndex(expr, adapter, ctx) {
  if (ctx?.disablePushdown || ctx?.disableMembership) return null;
  // Only attempt if provider supports prepareMembership, and expr can be compiled into a provider query IR.
  if (!adapter || typeof adapter.prepareMembership !== 'function') return null;
  const report = adapter.report || {};
  if (!report.membership) return null;
  const queryIR = compileExprToQueryIR(expr, { textFilter: ctx?.textFilter });
  if (!queryIR) return null;
  if (hasSupplementsButNoNativeFiltering(adapter, report)) return null;

  try {
    const idx = await adapter.prepareMembership(queryIR);
    if (!idx || typeof idx.batchHas !== 'function') return null;
    return idx;
  } catch (e) {
    return null;
  }
}

function hasSupplementsButNoNativeFiltering(adapter, report) {
  const supp = adapter?.supplements;
  const hasSupplements = !!(supp && typeof supp.canonicals === 'function' && (supp.canonicals() || []).length > 0);
  if (!hasSupplements) return false;
  const filtering = report?.supplements?.filtering || 'none';
  return filtering !== 'native';
}

async function canUseFullRootPushdown(expr, registry, ctx) {
  if (process.env.EXPAND_V3_DISABLE_FULL_ROOT_PUSHDOWN === '1') return false;
  if (ctx?.disablePushdown) return false;
  const queryIR = compileExprToQueryIR(expr, { textFilter: ctx?.textFilter });
  if (!queryIR || !queryIR.system) return false;
  const adapter = await registry.getAdapter(queryIR.system, queryIR.version || null, 'include');
  if (!adapter || typeof adapter.enumerateQueryIR !== 'function') return false;
  const report = adapter.report || {};
  if (!report.query) return false;
  if (hasSupplementsButNoNativeFiltering(adapter, report)) return false;
  return true;
}

function keyToString(key, useVersion) {
  const system = key?.system || '';
  const code = key?.code || '';
  const version = key?.version || '';
  if (useVersion) return `${system}|${version}#${code}`;
  return `${system}#${code}`;
}

module.exports = {
  executeExpandV3,
  enumerateExpr,
  buildMembershipIndex,
  compileExprToQueryIR,
};
