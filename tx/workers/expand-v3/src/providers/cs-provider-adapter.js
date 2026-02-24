'use strict';

const { BulkLocateResolverV3 } = require('./bulk-locate');
const { collectSpecialEnumerationCodes } = require('./special-enumeration');
const { compileSelectorToQueryIR } = require('../engine/query-ir-compiler');

/**
 * CsEngineAdapter adapts the existing CodeSystemProvider interface into
 * expand-v3's streaming/membership needs.
 *
 * Design rationale:
 * - Adapter report (from negotiate()) is the single routing contract used by
 *   the engine.
 * - report.mode is the primary execution-mode enum:
 *   - query-target
 *   - legacy-filter
 *   - base-only
 * - report.query/membership/decorateMany remain per-feature switches.
 * - Provider hooks are optional; adapter falls back to legacy APIs when needed.
 * - SupplementContext is passed through to provider hooks for provider-owned
 *   supplement handling (native optimization / provider-side filtering /
 *   provider-side decoration).
 * - The adapter does not apply supplement fallbacks itself.
 *
 * Providers can optionally implement:
 * - openStream({ queryIR, exec, supplements })
 * - prepareMembership({ queryIR, exec, supplements })
 * - decorateMany({ codes, opts, supplements })
 *
 * If they don't, v3 falls back to legacy iterator/filter methods.
 */
class CsEngineAdapter {
  constructor(cs, opts = {}) {
    this.cs = cs;
    this.opts = opts;
    this.supplements = opts.supplements || null;
    this.report = this._normalizeReport({});
  }

  async negotiate({ system = null, version = null, supplements = null, params = null, mode = null } = {}) {
    this.supplements = supplements || this.supplements || null;
    const negotiated = await this.cs.negotiate({
      system,
      version,
      supplements: this.supplements,
      params,
      mode,
    });
    this.report = this._normalizeReport(negotiated);
    return this.report;
  }

  system() { return this.cs.system(); }
  version() { return this.cs.version(); }

  _report() {
    return this.report || this._normalizeReport({});
  }

  /**
   * Enumerate a selector IR node as a stream of candidate objects:
   * { key:{system,version,code}, cs, context?, display?, isInactive?, isAbstract? }
   */
  async *enumerateSelector(selectorNode, execCtx) {
    const cs = this.cs;
    const system = await cs.system();
    const version = await cs.version();
    const report = this._report();
    const legacyCaps = report.legacyFilter || {};

    const shape = selectorNode.shape;
    let pushdownSelector = selectorNode;
    let hasProviderSupplementClauses = false;
    if (shape === 'filter') {
      const split = await this._splitFilterClausesForProvider(
        system,
        version || null,
        selectorNode.filterClauses || [],
        !(execCtx?.disablePushdown === true)
      );
      pushdownSelector = this._selectorForProvider(selectorNode, split.providerClauses);
      hasProviderSupplementClauses = !!split.hasProviderSupplementClauses;
    }

    // Preferred v3 path: provider-native stream from query IR.
    const pushed = await this._tryOpenStream(pushdownSelector, execCtx, {
      hasProviderSupplementClauses,
    });
    const stream = pushed?.rows || null;
    if (stream) {
      if (stream.notClosed) execCtx.notClosed = true;
      const streamTotal = pushed.includeTotal
        ? await this._maybeLoadProviderTotal(pushed.queryIR, stream, execCtx)
        : null;
      if (typeof streamTotal === 'number' && Number.isFinite(streamTotal) && typeof execCtx.onProviderStreamTotal === 'function') {
        execCtx.onProviderStreamTotal({
          source: 'selector',
          system,
          version: version || null,
          total: Number(streamTotal),
        });
      }
      yield* this._iterateProviderRows(stream, execCtx, { system, version: version || null });
      return;
    }

    if (shape === 'concept') {
      const codes = (selectorNode.conceptCodes || []).map(c => String(c.code || '')).filter(Boolean);
      const resolver = new BulkLocateResolverV3(cs, codes, execCtx.allAltCodes);
      for (const ref of selectorNode.conceptCodes || []) {
        const code = String(ref.code || '');
        if (!code) continue;
        if (execCtx.textFilter && !execCtx.textFilter.passes(code) && !(ref.display && execCtx.textFilter.passes(ref.display))) continue;

        const located = await resolver.locate(code);
        if (!located?.context) {
          if (execCtx.activeOnly || execCtx.excludeNotForUI) continue;
          yield {
            key: { system, version: version || null, code },
            cs,
            context: null,
            conceptRef: ref,
            displayHint: ref.display || null,
            isInactive: false,
            isAbstract: false,
          };
          continue;
        }

        const isInactive = execCtx.activeOnly && typeof cs.isInactive === 'function'
          ? await cs.isInactive(located.context)
          : false;
        if (execCtx.activeOnly && isInactive) continue;

        const isAbstract = execCtx.excludeNotForUI && typeof cs.isAbstract === 'function'
          ? await cs.isAbstract(located.context)
          : false;
        if (execCtx.excludeNotForUI && isAbstract) continue;

        yield {
          key: { system, version: version || null, code },
          cs,
          context: located.context,
          conceptRef: ref,
          displayHint: ref.display || null,
          isInactive,
          isAbstract,
        };
      }
      return;
    }

    if (shape === 'whole' && !execCtx.textFilter) {
      let notClosed = false;
      if (typeof cs.isNotClosed === 'function') {
        try {
          notClosed = !!(await cs.isNotClosed(null));
          execCtx.notClosed = execCtx.notClosed || notClosed;
        } catch (e) {
          // ignore and continue with generic iterator path
        }
      }
        if (notClosed) {
          const special = typeof cs.specialEnumeration === 'function' ? cs.specialEnumeration() : null;
          if (special) {
          const codes = await collectSpecialEnumerationCodes(this.opts?.worker, special, system);
          if (codes.length > 0) {
            const resolver = new BulkLocateResolverV3(cs, codes, execCtx.allAltCodes);
            for (const code of codes) {
              const located = await resolver.locate(code);
              const context = located?.context || null;
              const isInactive = execCtx.activeOnly && context && typeof cs.isInactive === 'function'
                ? await cs.isInactive(context)
                : false;
              if (execCtx.activeOnly && isInactive) continue;

              const isAbstract = execCtx.excludeNotForUI && context && typeof cs.isAbstract === 'function'
                ? await cs.isAbstract(context)
                : false;
              if (execCtx.excludeNotForUI && isAbstract) continue;

              yield {
                key: { system, version: version || null, code: String(code) },
                cs,
                context,
                isInactive,
                isAbstract,
              };
            }
            return;
          }
        }
        throw new Error(`The code System "${system}" has a grammar, and cannot be enumerated directly`);
      }
    }

    // Whole system with text filter can use filter/search protocol if available.
    if (shape === 'whole' && execCtx.textFilter && legacyCaps.filterPipeline && legacyCaps.supportsSearchFilter) {
      const prep = await cs.getPrepContext(true);
      try {
        if (typeof cs.isNotClosed === 'function') {
          try { execCtx.notClosed = execCtx.notClosed || await cs.isNotClosed(); } catch (e) { /* ignore */ }
        }
        await cs.searchFilter(prep, execCtx.textFilter.filter, false);
        const sets = await cs.executeFilters(prep);
        if (typeof cs.filtersNotClosed === 'function') {
          try { execCtx.notClosed = execCtx.notClosed || await cs.filtersNotClosed(prep); } catch (e) { /* ignore */ }
        }
        yield* this._iterateFilterSets(prep, sets, execCtx, null);
      } finally {
        if (typeof cs.filterFinish === 'function') {
          try { await cs.filterFinish(prep); } catch (_e) { /* ignore */ }
        }
      }
      return;
    }

    if (shape === 'filter') {
      if (!legacyCaps.filterPipeline) {
        throw new Error(`Provider '${system}' does not support legacy filter pipeline required for filter selectors`);
      }
      const prep = await cs.getPrepContext(true);
      try {
        let localTextFilter = execCtx.textFilter || null;
        if (execCtx.textFilter && legacyCaps.supportsSearchFilter) {
          await cs.searchFilter(prep, execCtx.textFilter.filter, false);
          localTextFilter = null;
        }
        for (const fc of pushdownSelector.filterClauses || []) {
          await cs.filter(prep, fc.property, fc.op, fc.value);
        }
        const sets = await cs.executeFilters(prep);
        if (typeof cs.filtersNotClosed === 'function') {
          try { execCtx.notClosed = execCtx.notClosed || await cs.filtersNotClosed(prep); } catch (e) { /* ignore */ }
        }
        yield* this._iterateFilterSets(prep, sets, execCtx, localTextFilter);
      } finally {
        if (typeof cs.filterFinish === 'function') {
          try { await cs.filterFinish(prep); } catch (_e) { /* ignore */ }
        }
      }
      return;
    }

    // Whole system enumeration
    if (typeof cs.isNotClosed === 'function') {
      try { execCtx.notClosed = execCtx.notClosed || await cs.isNotClosed(); } catch (e) { /* ignore */ }
    }
    const iter = typeof cs.iteratorAll === 'function' ? await cs.iteratorAll() : await cs.iterator(null);
    if (!iter) return;

    let context = await cs.nextContext(iter);
    while (context) {
      const code = await cs.code(context);
      if (!code) { context = await cs.nextContext(iter); continue; }

      if (execCtx.textFilter && !execCtx.textFilter.passes(code)) { context = await cs.nextContext(iter); continue; }

      const isInactive = execCtx.activeOnly && typeof cs.isInactive === 'function'
        ? await cs.isInactive(context)
        : false;
      if (execCtx.activeOnly && isInactive) { context = await cs.nextContext(iter); continue; }

      const isAbstract = execCtx.excludeNotForUI && typeof cs.isAbstract === 'function'
        ? await cs.isAbstract(context)
        : false;
      if (execCtx.excludeNotForUI && isAbstract) { context = await cs.nextContext(iter); continue; }

      yield {
        key: { system, version: version || null, code: String(code) },
        cs,
        context,
        isInactive,
        isAbstract,
      };
      context = await cs.nextContext(iter);
    }
  }

  async _tryOpenStream(selectorNode, execCtx, options = {}) {
    if (execCtx?.disablePushdown) return null;
    const cs = this.cs;
    const report = this._report();
    if (!report.query || typeof cs.openStream !== 'function') return null;

    const queryIR = compileSelectorToQueryIR(selectorNode, { textFilter: execCtx.textFilter });
    if (!queryIR) return null;

    const streamWindow = this._computeProviderStreamWindow(execCtx);
    const includeTotal = this._shouldIncludeProviderTotal(execCtx, options);
    const rows = await this._callOpenStream(queryIR, {
      offset: streamWindow.offset,
      count: streamWindow.count,
      includeTotal,
      activeOnly: !!execCtx.activeOnly,
      excludeInactive: !!execCtx.activeOnly,
      includeDesignations: false,
      properties: [],
      displayLanguages: null,
      textFilter: execCtx.textFilter || null,
      filterPageSize: execCtx.filterPageSize || 256,
      limitCount: 0,
      supplements: this.supplements,
    });
    if (!rows) return null;
    return { rows, queryIR, includeTotal };
  }

  async *_iterateProviderRows(rows, execCtx, identity) {
    const cs = this.cs;
    for await (const row of rows) {
      const code = row?.code ? String(row.code) : '';
      if (!code) continue;

      const display = typeof row.display === 'string' ? row.display : null;

      const context = row?.context ?? null;
      const isInactive = (typeof row?.isInactive === 'boolean')
        ? row.isInactive
        : (execCtx.activeOnly && context && typeof cs.isInactive === 'function' ? await cs.isInactive(context) : false);
      if (execCtx.activeOnly && isInactive) continue;

      const isAbstract = (typeof row?.isAbstract === 'boolean')
        ? row.isAbstract
        : (execCtx.excludeNotForUI && context && typeof cs.isAbstract === 'function' ? await cs.isAbstract(context) : false);
      if (execCtx.excludeNotForUI && isAbstract) continue;

      yield {
        key: {
          system: row?.system || identity.system,
          version: (row?.version ?? identity.version ?? null),
          code,
        },
        cs,
        context,
        displayHint: display,
        isInactive,
        isAbstract,
      };
    }
  }

  async *_iterateFilterSets(prep, sets, execCtx, textFilter = null) {
    const cs = this.cs;
    const system = await cs.system();
    const version = await cs.version();
    const primary = Array.isArray(sets) ? sets[0] : sets;
    if (!primary) return;

    // Prefer filterPage when available (paged iteration)
    if (typeof cs.filterPage === 'function') {
      while (true) {
        const page = await cs.filterPage(prep, primary, execCtx.filterPageSize || 256);
        if (!Array.isArray(page) || page.length === 0) break;
        for (const context of page) {
          const code = await cs.code(context);
          if (!code) continue;
          if (textFilter && !(await this._passesTextFilter(cs, textFilter, code, context))) continue;

          const isInactive = execCtx.activeOnly && typeof cs.isInactive === 'function'
            ? await cs.isInactive(context)
            : false;
          if (execCtx.activeOnly && isInactive) continue;

          const isAbstract = execCtx.excludeNotForUI && typeof cs.isAbstract === 'function'
            ? await cs.isAbstract(context)
            : false;
          if (execCtx.excludeNotForUI && isAbstract) continue;

          // Secondary sets are membership constraints
          let ok = true;
          if (Array.isArray(sets) && sets.length > 1) {
            for (let i = 1; i < sets.length; i++) {
              if (await cs.filterCheck(prep, sets[i], context) !== true) { ok = false; break; }
            }
          }
          if (!ok) continue;

          yield { key: { system, version: version || null, code: String(code) }, cs, context, isInactive, isAbstract };
        }
      }
      return;
    }

    while (await cs.filterMore(prep, primary)) {
      const context = await cs.filterConcept(prep, primary);
      const code = await cs.code(context);
      if (!code) continue;
      if (textFilter && !(await this._passesTextFilter(cs, textFilter, code, context))) continue;

      const isInactive = execCtx.activeOnly && typeof cs.isInactive === 'function'
        ? await cs.isInactive(context)
        : false;
      if (execCtx.activeOnly && isInactive) continue;

      const isAbstract = execCtx.excludeNotForUI && typeof cs.isAbstract === 'function'
        ? await cs.isAbstract(context)
        : false;
      if (execCtx.excludeNotForUI && isAbstract) continue;

      let ok = true;
      if (Array.isArray(sets) && sets.length > 1) {
        for (let i = 1; i < sets.length; i++) {
          if (await cs.filterCheck(prep, sets[i], context) !== true) { ok = false; break; }
        }
      }
      if (!ok) continue;

      yield { key: { system, version: version || null, code: String(code) }, cs, context, isInactive, isAbstract };
    }
  }

  async _passesTextFilter(cs, textFilter, code, context) {
    if (!textFilter) return true;
    if (textFilter.passes(code)) return true;
    if (!context || typeof cs.display !== 'function') return false;
    try {
      const display = await cs.display(context);
      return !!(display && textFilter.passes(display));
    } catch (e) {
      return false;
    }
  }

  async enumerateQueryIR(queryIR, execCtx) {
    if (execCtx?.disablePushdown) return;
    const cs = this.cs;
    const report = this._report();
    if (!report.query || typeof cs.openStream !== 'function') return null;
    if (!queryIR) return null;

    const streamWindow = this._computeProviderStreamWindow(execCtx);
    const includeTotal = this._shouldIncludeProviderTotal(execCtx, null);
    const rows = await this._callOpenStream(queryIR, {
      offset: streamWindow.offset,
      count: streamWindow.count,
      includeTotal,
      activeOnly: !!execCtx.activeOnly,
      excludeInactive: !!execCtx.activeOnly,
      includeDesignations: false,
      properties: [],
      displayLanguages: null,
      textFilter: execCtx.textFilter || null,
      filterPageSize: execCtx.filterPageSize || 256,
      limitCount: 0,
      supplements: this.supplements,
    });
    if (!rows) return null;
    if (rows.notClosed) execCtx.notClosed = true;

    const system = queryIR.system || await cs.system();
    const version = (queryIR.version ?? await cs.version()) || null;
    const streamTotal = includeTotal
      ? await this._maybeLoadProviderTotal(queryIR, rows, execCtx)
      : null;
    if (typeof streamTotal === 'number' && Number.isFinite(streamTotal) && typeof execCtx.onProviderStreamTotal === 'function') {
      execCtx.onProviderStreamTotal({
        source: 'queryIR',
        system,
        version,
        total: Number(streamTotal),
      });
    }
    return this._iterateProviderRows(rows, execCtx, { system, version });
  }

  async _maybeLoadProviderTotal(queryIR, rows, execCtx) {
    const raw = rows?.total;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (!execCtx?.requestProviderTotal || !queryIR) return null;

    const cs = this.cs;
    const report = this._report();
    if (!report.pagination || typeof cs.openStream !== 'function') return null;

    const probe = await this._callOpenStream(queryIR, {
      offset: 0,
      count: 0,
      activeOnly: !!execCtx.activeOnly,
      excludeInactive: !!execCtx.activeOnly,
      includeDesignations: false,
      properties: [],
      displayLanguages: null,
      textFilter: execCtx.textFilter || null,
      filterPageSize: execCtx.filterPageSize || 256,
      limitCount: 0,
      supplements: this.supplements,
    });
    const probeTotal = probe?.total;
    return (typeof probeTotal === 'number' && Number.isFinite(probeTotal)) ? probeTotal : null;
  }

  _computeProviderStreamWindow(execCtx) {
    const wantPaging = Number.isInteger(execCtx?.count) && execCtx.count >= 0;
    const pagingSafe = !!execCtx?.allowProviderPaging;
    if (!wantPaging || !pagingSafe) {
      return { offset: -1, count: -1 };
    }
    const offset = Math.max(0, Number.isInteger(execCtx?.offset) ? execCtx.offset : 0);
    const count = Math.max(0, Number.isInteger(execCtx?.count) ? execCtx.count : 0);
    const windowCount = offset + count;
    return { offset: 0, count: windowCount };
  }

  _shouldIncludeProviderTotal(execCtx, options = null) {
    const wantsTotal = !!execCtx?.requestProviderTotal;
    if (!wantsTotal) return false;
    if (options?.hasProviderSupplementClauses) return false;
    return true;
  }

  // Optional: provider-native membership checker from query IR
  async prepareMembership(queryIR) {
    const report = this._report();
    if (report.membership && typeof this.cs.prepareMembership === 'function') {
      return this._callPrepareMembership(queryIR);
    }
    return null;
  }

  // Optional: provider-native bulk decoration
  async decorateMany(codes, opts, contextsByCode = null) {
    const report = this._report();
    if (report.decorateMany && typeof this.cs.decorateMany === 'function') {
      return this._callDecorateMany(codes, opts, contextsByCode);
    }
    return null;
  }

  async _providerCanFilterClause(fc) {
    if (!fc || typeof this.cs.doesFilter !== 'function') return null;
    try {
      return await this.cs.doesFilter(fc.property, fc.op, fc.value);
    } catch (_e) {
      return false;
    }
  }

  async _splitFilterClausesForProvider(system, version, clauses, allowNativeSupplementProviderClauses = true) {
    void system;
    void version;
    const providerClauses = [];
    let hasProviderSupplementClauses = false;
    const report = this.report || {};
    for (const fc of clauses || []) {
      const providerCanHandle = await this._providerCanFilterClause(fc);
      if (providerCanHandle === true) {
        providerClauses.push(fc);
        continue;
      }
      if (allowNativeSupplementProviderClauses && this._reportSupportsSupplementClause(fc, report)) {
        providerClauses.push(fc);
        hasProviderSupplementClauses = true;
        continue;
      }
      throw new Error(`Unsupported filter clause '${fc.property} ${fc.op} ${fc.value}' for ${system}`);
    }
    return { providerClauses, hasProviderSupplementClauses };
  }

  _selectorForProvider(selectorNode, providerClauses) {
    if (!selectorNode || selectorNode.shape !== 'filter') return selectorNode;
    if (!Array.isArray(providerClauses) || providerClauses.length === 0) {
      return {
        ...selectorNode,
        shape: 'whole',
        filterClauses: [],
      };
    }
    return {
      ...selectorNode,
      shape: 'filter',
      filterClauses: providerClauses,
    };
  }

  async _callOpenStream(queryIR, execOpts) {
    const cs = this.cs;
    const req = { queryIR, exec: execOpts, supplements: this.supplements };
    return cs.openStream(req);
  }

  async _callPrepareMembership(queryIR) {
    const cs = this.cs;
    const req = { queryIR, exec: null, supplements: this.supplements };
    return cs.prepareMembership(req);
  }

  async _callDecorateMany(codes, opts, contextsByCode = null) {
    const cs = this.cs;
    const req = { codes, opts: opts || {}, supplements: this.supplements, contextsByCode };
    return cs.decorateMany(req);
  }

  _toSet(value) {
    if (!value) return new Set();
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value.map(v => String(v || '')).filter(Boolean));
    return new Set();
  }

  _normalizeReport(report) {
    const r = report || {};
    const mode = this._normalizeMode(r.mode, r);
    const supplements = r.supplements || {};
    const handles = supplements.handles || 'none';
    const filtering = supplements.filtering || (handles === 'none' ? 'none' : 'native');
    const queryEnabled = r.query === true || mode === 'query-target';
    const legacyFilterPipeline = r.legacyFilter?.filterPipeline === true || mode === 'legacy-filter';
    return {
      mode,
      query: queryEnabled,
      membership: r.membership === true,
      decorateMany: r.decorateMany === true,
      ordering: r.ordering || { stable: false, kind: 'unspecified' },
      pagination: r.pagination === true,
      legacyFilter: {
        filterPipeline: legacyFilterPipeline,
        supportsSearchFilter: r.legacyFilter?.supportsSearchFilter === true,
        supportsFilterPage: r.legacyFilter?.supportsFilterPage === true,
      },
      supplements: {
        handles,
        filtering,
        properties: this._toSet(supplements.properties),
        operators: this._toSet(supplements.operators),
        unsupported: this._toSet(supplements.unsupported),
        attachments: supplements.attachments || null,
      },
      system: r.system || null,
      version: r.version || null,
    };
  }

  _normalizeMode(mode, report) {
    const m = String(mode || '').trim();
    if (m === 'query-target' || m === 'legacy-filter' || m === 'base-only') {
      return m;
    }
    if (report?.query === true) return 'query-target';
    if (report?.legacyFilter?.filterPipeline === true) return 'legacy-filter';
    return 'base-only';
  }

  _reportSupportsSupplementClause(fc, report) {
    if (!fc || !report?.supplements) return false;
    const supp = report.supplements;
    if (supp.handles === 'none') return false;
    if (supp.filtering !== 'native') return false;
    const prop = String(fc.property || '');
    const op = String(fc.op || '');
    if (!prop || !op) return false;
    return supp.properties.has(prop) && supp.operators.has(op);
  }
}

module.exports = { CsEngineAdapter };
