'use strict';

/**
 * In-memory membership index. Codes are compared as exact strings.
 */
class InMemorySetIndex {
  constructor(codeSet) {
    this._set = codeSet instanceof Set ? codeSet : new Set(codeSet || []);
  }

  async batchHas(codes) {
    if (!Array.isArray(codes) || codes.length === 0) return [];
    return codes.map(c => this._set.has(String(c)));
  }

  async close() { /* nothing */ }
}

module.exports = { InMemorySetIndex };
