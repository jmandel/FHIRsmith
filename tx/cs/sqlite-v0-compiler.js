'use strict';

const Types = require('./sqlite-v0-plan-types');
const { buildMembershipPlan, buildSelectionPlan } = require('./sqlite-v0-plan-builder');
const { membershipPlanHash, normalizeMembershipPlan } = require('./sqlite-v0-plan-normalize');
const { buildMaterializePlan, buildCountPlan, buildProbePlan } = require('./sqlite-v0-terminal-builder');
const { physicalizeTerminalPlan } = require('./sqlite-v0-physicalize');
const { lowerPhysicalPlanToSqlAst } = require('./sqlite-v0-sql-ast');
const { emitSqlAst } = require('./sqlite-v0-sql-emit');
const { mergeSupplementPropertyDefinitions } = require('./sqlite-v0-supplements');
const { analyzePartitionSafety, canonicalIRHash, collectSystems } = require('../engine/rewrite');

class SqliteV0Compiler {
  constructor(opts = {}) {
    const basePropertyDefs = opts.propertyDefs instanceof Map ? opts.propertyDefs : new Map();
    this.runtime = opts.runtime || {};
    this.scope = Types.normalizeScope(opts.scope || null);
    this.supplementBindings = Array.isArray(opts.supplementBindings) ? opts.supplementBindings : [];
    this.propertyDefs = this.supplementBindings.length > 0
      ? mergeSupplementPropertyDefinitions(basePropertyDefs, this.supplementBindings)
      : basePropertyDefs;
    this.includeDebugArtifacts = opts.includeDebugArtifacts === true;
    this.cacheLimit = Number.isInteger(opts.cacheLimit) && opts.cacheLimit > 0 ? opts.cacheLimit : 256;
    this.baseCache = new Map();
    this.selectedCache = new Map();
  }

  compileBaseMembership(subtree, opts = {}) {
    return this.#compileBaseMembership(subtree, opts).plan;
  }

  compileSelectedMembership(base, opts = {}) {
    return this.#compileSelectedMembership(base, opts).plan;
  }

  compileExpand(subtree, opts = {}) {
    const includeDebugArtifacts = this.#includeDebugArtifacts(opts);
    const baseCompiled = this.#compileBaseMembership(subtree, opts);
    const selectedCompiled = includeDebugArtifacts ? this.#compileSelectedMembership(baseCompiled.plan, opts) : null;
    const selected = selectedCompiled?.plan || null;
    const base = baseCompiled.plan;
    const includeTotal = this.#includeExpandTotal(base, opts);
    const terminal = buildMaterializePlan(base, {
      activeOnly: opts.activeOnly,
      text: opts.text,
      offset: opts.offset,
      count: opts.count,
      includeTotal,
      scope: base.scope || this.scope,
    });
    const physical = includeDebugArtifacts ? physicalizeTerminalPlan(terminal, { runtime: this.runtime }) : null;
    const { ast: sqlAst, params } = lowerPhysicalPlanToSqlAst(terminal, {
      propertyDefs: this.propertyDefs,
      runtime: this.runtime,
      scope: base.scope || this.scope,
      supplementBindings: this.supplementBindings,
    });
    const sql = emitSqlAst(sqlAst, params);
    return {
      base,
      selected,
      logical: selected || base,
      terminal,
      physical,
      sqlAst,
      sql,
      traceInfo: {
        scope: base.scope || this.scope,
        baseCacheKey: baseCompiled.cacheKey,
        baseCacheHit: baseCompiled.cacheHit,
        selectedCacheKey: selectedCompiled?.cacheKey || null,
        selectedCacheHit: !!selectedCompiled?.cacheHit,
      },
    };
  }

  compileCount(subtree, opts = {}) {
    const includeDebugArtifacts = this.#includeDebugArtifacts(opts);
    const baseCompiled = this.#compileBaseMembership(subtree, opts);
    const selectedCompiled = includeDebugArtifacts ? this.#compileSelectedMembership(baseCompiled.plan, opts) : null;
    const selected = selectedCompiled?.plan || null;
    const base = baseCompiled.plan;
    const terminal = buildCountPlan(base, {
      activeOnly: opts.activeOnly,
      text: opts.text,
      scope: base.scope || this.scope,
    });
    const physical = includeDebugArtifacts ? physicalizeTerminalPlan(terminal, { runtime: this.runtime }) : null;
    const { ast: sqlAst, params } = lowerPhysicalPlanToSqlAst(terminal, {
      propertyDefs: this.propertyDefs,
      runtime: this.runtime,
      scope: base.scope || this.scope,
      supplementBindings: this.supplementBindings,
    });
    const sql = emitSqlAst(sqlAst, params);
    return {
      base,
      selected,
      logical: selected || base,
      terminal,
      physical,
      sqlAst,
      sql,
      traceInfo: {
        scope: base.scope || this.scope,
        baseCacheKey: baseCompiled.cacheKey,
        baseCacheHit: baseCompiled.cacheHit,
        selectedCacheKey: selectedCompiled?.cacheKey || null,
        selectedCacheHit: !!selectedCompiled?.cacheHit,
      },
    };
  }

  compileProbe(subtree, code, opts = {}) {
    const includeDebugArtifacts = this.#includeDebugArtifacts(opts);
    const baseCompiled = this.#compileBaseMembership(subtree, opts);
    const base = baseCompiled.plan;
    const terminal = buildProbePlan(base, code, {
      scope: base.scope || this.scope,
    });
    const physical = includeDebugArtifacts ? physicalizeTerminalPlan(terminal, { runtime: this.runtime }) : null;
    const { ast: sqlAst, params } = lowerPhysicalPlanToSqlAst(terminal, {
      propertyDefs: this.propertyDefs,
      runtime: this.runtime,
      scope: base.scope || this.scope,
      supplementBindings: this.supplementBindings,
    });
    const sql = emitSqlAst(sqlAst, params);
    return {
      base,
      selected: null,
      logical: base,
      terminal,
      physical,
      sqlAst,
      sql,
      traceInfo: {
        scope: base.scope || this.scope,
        baseCacheKey: baseCompiled.cacheKey,
        baseCacheHit: baseCompiled.cacheHit,
        selectedCacheKey: null,
        selectedCacheHit: false,
      },
    };
  }

  #compileBaseMembership(subtree, opts = {}) {
    const scope = Types.normalizeScope(opts.scope || this.scope);
    this.#assertScopedSubtree(subtree, scope);
    const cacheKey = `base:${scopeKey(scope)}:${canonicalIRHash(subtree, { optimizeExpr: false })}`;
    if (this.baseCache.has(cacheKey)) {
      return { plan: this.baseCache.get(cacheKey), cacheKey, cacheHit: true };
    }
    const lowered = buildMembershipPlan(subtree, {
      propertyDefs: this.propertyDefs,
      runtime: this.runtime,
      scope,
      supplementBindings: this.supplementBindings,
    });
    if (!lowered.ok) {
      const detail = lowered.detail ? ` ${JSON.stringify(lowered.detail)}` : '';
      throw new Error(`sqlite-v0 base membership compilation failed: ${lowered.reason}${detail}`);
    }
    const plan = normalizeMembershipPlan(lowered.plan);
    this.#remember(this.baseCache, cacheKey, plan);
    return { plan, cacheKey, cacheHit: false };
  }

  #compileSelectedMembership(base, opts = {}) {
    const selectionKey = JSON.stringify({
      activeOnly: !!opts.activeOnly,
      text: opts.text != null ? String(opts.text) : null,
    });
    const cacheKey = `selected:${membershipPlanHash(base)}:${selectionKey}`;
    if (this.selectedCache.has(cacheKey)) {
      return { plan: this.selectedCache.get(cacheKey), cacheKey, cacheHit: true };
    }
    const plan = normalizeMembershipPlan(buildSelectionPlan(base, opts, this.runtime));
    this.#remember(this.selectedCache, cacheKey, plan);
    return { plan, cacheKey, cacheHit: false };
  }

  #assertScopedSubtree(subtree, scope) {
    if (!scope?.system) {
      throw new Error('sqlite-v0 native planning requires an explicit single-system scope');
    }
    const safety = analyzePartitionSafety(subtree);
    if (!safety.ok) {
      throw new Error(`sqlite-v0 native planning requires projected scoped IR: ${safety.reason}`);
    }
    const systems = [...collectSystems(subtree).values()];
    if (systems.length > 1) {
      throw new Error('sqlite-v0 native planning requires projected scoped IR: multiple systems remain in subtree');
    }
    const found = systems[0] || null;
    if (!found) return;
    if (String(found.system || '') !== String(scope.system || '')) {
      throw new Error(`sqlite-v0 native planning requires projected scoped IR: expected ${scope.system}, found ${found.system || '(missing)'}`);
    }
    if (found.version != null && String(found.version) !== String(scope.version || '')) {
      throw new Error(
        `sqlite-v0 native planning requires projected scoped IR: expected version ${scope.version || '(unversioned)'}, found ${found.version}`
      );
    }
  }

  #remember(cache, key, value) {
    cache.set(key, value);
    while (cache.size > this.cacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }

  #includeDebugArtifacts(opts = {}) {
    if (opts.includeDebugArtifacts != null) return !!opts.includeDebugArtifacts;
    return this.includeDebugArtifacts;
  }

  #includeExpandTotal(base, opts = {}) {
    if (opts.includeTotal != null) return !!opts.includeTotal;
    return false;
  }
}

function createSqliteV0Compiler(opts = {}) {
  return new SqliteV0Compiler(opts);
}

function scopeKey(scope) {
  const normalized = Types.normalizeScope(scope);
  return JSON.stringify({
    csId: normalized?.csId ?? null,
    system: normalized?.system || '',
    version: normalized?.version || null,
  });
}

module.exports = {
  createSqliteV0Compiler,
  SqliteV0Compiler,
};
