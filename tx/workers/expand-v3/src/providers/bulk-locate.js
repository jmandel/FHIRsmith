'use strict';

/**
 * BulkLocateResolverV3
 *
 * Resolves code -> provider locate() context efficiently using locateMany/locateBatch when available.
 *
 * This is intentionally small and provider-agnostic.
 */
class BulkLocateResolverV3 {
  constructor(cs, orderedCodes, allAltCodes = null) {
    this._cs = cs;
    this._orderedCodes = Array.isArray(orderedCodes) ? orderedCodes : [];
    this._allAltCodes = allAltCodes;
    this._cache = new Map();
    this._missing = new Set();
    this._cursor = 0;

    const bulkFn = typeof cs.locateMany === 'function' ? cs.locateMany.bind(cs)
      : typeof cs.locateBatch === 'function' ? cs.locateBatch.bind(cs)
      : null;

    this._bulkFn = (bulkFn && this._orderedCodes.length >= 50) ? bulkFn : null;
  }

  async locate(code) {
    const key = String(code || '');
    if (!key) return null;

    if (this._cache.has(key)) return this._cache.get(key);
    if (this._missing.has(key)) return null;

    if (this._bulkFn) {
      await this._loadUntilFound(key);
    } else {
      const res = await this._cs.locate(key, this._allAltCodes);
      if (res?.context) this._cache.set(key, res);
      else this._missing.add(key);
    }

    return this._cache.get(key) || null;
  }

  async locateMany(codes) {
    const out = new Map();
    for (const c of codes || []) {
      const res = await this.locate(c);
      if (res?.context) out.set(String(c), res);
    }
    return out;
  }

  async _loadUntilFound(key) {
    while (this._cursor < this._orderedCodes.length && !this._cache.has(key) && !this._missing.has(key)) {
      const batch = this._orderedCodes.slice(this._cursor, this._cursor + 500);
      this._cursor += 500;
      const result = await this._bulkFn(batch, this._allAltCodes);
      this._ingest(result, batch);
    }

    if (!this._cache.has(key) && !this._missing.has(key)) {
      const res = await this._cs.locate(key, this._allAltCodes);
      if (res?.context) this._cache.set(key, res);
      else this._missing.add(key);
    }
  }

  _ingest(bulkResult, requestedCodes) {
    const loaded = new Set();
    if (bulkResult instanceof Map) {
      for (const [code, value] of bulkResult) {
        const k = String(code || '');
        if (k) { this._cache.set(k, value); loaded.add(k); }
      }
    } else if (Array.isArray(bulkResult)) {
      for (const row of bulkResult) {
        if (!row?.code) continue;
        const k = String(row.code);
        this._cache.set(k, row.result ?? row.value ?? row.located ?? row);
        loaded.add(k);
      }
    } else if (bulkResult && typeof bulkResult === 'object') {
      for (const [code, value] of Object.entries(bulkResult)) {
        const k = String(code || '');
        if (k) { this._cache.set(k, value); loaded.add(k); }
      }
    }
    for (const code of requestedCodes) {
      if (!loaded.has(code) && !this._cache.has(code)) this._missing.add(code);
    }
  }
}

module.exports = { BulkLocateResolverV3 };
