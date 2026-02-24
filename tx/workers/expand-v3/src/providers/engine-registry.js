'use strict';

const { CsEngineAdapter } = require('./cs-provider-adapter');
const { trace: T } = require('../../../expand-trace');

/**
 * EngineRegistryV3
 *
 * Responsible for turning (system, version) into a provider adapter.
 * This is where we plug into existing TerminologyWorker.findCodeSystem().
 *
 * v3 supplement model:
 * - Provider construction is intentionally supplement-agnostic in v3 paths.
 * - Request-scoped supplement behavior is supplied through SupplementContext
 *   and passed to adapter/provider hooks during negotiation and execution.
 * - This keeps supplement semantics explicit in v3 and avoids hidden coupling
 *   to provider-owned resource supplements.
 */
class EngineRegistryV3 {
  constructor(worker, params, opts = {}) {
    this.worker = worker;
    this.params = params;
    this.requiredSupplements = opts.requiredSupplements || new Set();
    this.usedSupplements = opts.usedSupplements || new Set();
    this.cache = new Map(); // key -> adapter
    this.supplementContextCache = new Map(); // key -> SupplementContext
  }

  async getAdapter(system, version = null, mode = 'include') {
    const reqSupps = this.requiredSupplements || new Set();
    const suppKey = [...reqSupps].sort().join(',');
    const key = this._buildAdapterKey(system, version, mode, suppKey);
    if (this.cache.has(key)) return this.cache.get(key);

    // Signature (from existing worker codebase):
    //   findCodeSystem(system, version, params, kinds, noAuth, forExclude?, wantProvider, _, requiredSupplements)
    const tried = [];
    const versionCandidates = [];
    if (version == null || version === '') {
      versionCandidates.push(version);
    } else {
      versionCandidates.push(version);
      if (!String(version).includes('|')) {
        versionCandidates.push(`${system}|${version}`);
      }
    }

    let cs = null;
    let lastErr = null;
    for (const v of versionCandidates) {
      tried.push(v);
      try {
        cs = await this.worker.findCodeSystem(
          system,
          v,
          this.params,
          ['complete', 'fragment'],
          false,
          mode === 'exclude',
          true,
          null,
          null
        );
        if (cs) break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!cs && lastErr) throw lastErr;
    if (!cs) {
      throw new Error(`CodeSystem provider not found for ${system}${version ? `|${version}` : ''}; tried versions: ${tried.map(v => v ?? '(none)').join(', ')}`);
    }

    const suppCtxKey = `${system}|${version || ''}|${suppKey}`;
    let supplements = this.supplementContextCache.get(suppCtxKey) || null;
    if (!supplements && typeof this.worker.resolveSupplementContext === 'function') {
      supplements = await this.worker.resolveSupplementContext(reqSupps, {
        system,
        version: version || null,
        providerHint: cs,
        params: this.params,
      });
      if (supplements) {
        this.supplementContextCache.set(suppCtxKey, supplements);
      }
    }
    if (supplements && this.usedSupplements && this.requiredSupplements) {
      const resolved = (typeof supplements.canonicals === 'function') ? supplements.canonicals() : [];
      for (const c of resolved) {
        if (this.requiredSupplements.has(c)) {
          this.usedSupplements.add(c);
        }
      }
    }

    const adapter = new CsEngineAdapter(cs, {
      mode,
      worker: this.worker,
      supplements,
      system,
      version: version || null,
    });
    await adapter.negotiate({
      system,
      version: version || null,
      supplements,
      params: this.params,
      mode,
    });
    if (T.active) {
      T.note('v3.adapter.negotiate', {
        system,
        version: version || null,
        mode,
        report: this._reportForTrace(adapter.report),
      });
    }
    this.cache.set(key, adapter);
    return adapter;
  }

  _buildAdapterKey(system, version, mode, suppKey) {
    return [
      system,
      version || '',
      mode || 'include',
      suppKey || '',
      this._paramsFingerprint(),
    ].join('|');
  }

  _paramsFingerprint() {
    const p = this.params;
    if (!p) return '';
    const get = (name) => {
      if (typeof p.v === 'function') {
        try { return String(p.v(name) ?? ''); } catch (_e) { return ''; }
      }
      return String(p[name] ?? '');
    };
    return [
      get('activeOnly'),
      get('excludeNested'),
      get('excludeNotForUI'),
      get('includeDesignations'),
      get('property'),
      get('useSupplement'),
      get('displayLanguage'),
    ].join(',');
  }

  _reportForTrace(report) {
    const r = report || {};
    const toArray = (v) => (v instanceof Set ? [...v] : Array.isArray(v) ? v : []);
    return {
      mode: r.mode || 'base-only',
      query: r.query === true,
      membership: r.membership === true,
      decorateMany: r.decorateMany === true,
      pagination: r.pagination === true,
      ordering: r.ordering || null,
      legacyFilter: r.legacyFilter || null,
      supplements: {
        handles: r.supplements?.handles || 'none',
        filtering: r.supplements?.filtering || 'none',
        properties: toArray(r.supplements?.properties),
        operators: toArray(r.supplements?.operators),
        unsupported: toArray(r.supplements?.unsupported),
      },
    };
  }

  async close() {
    const seen = new Set();
    for (const ctx of this.supplementContextCache.values()) {
      if (!ctx || seen.has(ctx)) continue;
      seen.add(ctx);
      if (typeof ctx.close === 'function') {
        await ctx.close();
      }
    }
    this.supplementContextCache.clear();
    this.cache.clear();
  }
}

module.exports = { EngineRegistryV3 };
