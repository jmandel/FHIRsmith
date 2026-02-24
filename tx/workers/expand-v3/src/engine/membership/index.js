'use strict';

const { InMemorySetIndex } = require('./inmem-set');

/**
 * MultiSystemIndex dispatches batchHas calls by system|version.
 * Keys are objects: { system, version, code }.
 */
class MultiSystemIndex {
  constructor() {
    this.bySystem = new Map(); // key -> index
  }

  set(system, version, index) {
    const k = makeSysVerKey(system, version);
    this.bySystem.set(k, index);
  }

  get(system, version) {
    const k = makeSysVerKey(system, version);
    return this.bySystem.get(k) || null;
  }

  isEmpty() {
    return this.bySystem.size === 0;
  }

  async batchHas(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const out = new Array(keys.length).fill(false);

    // Group by canonical system|version
    const groups = new Map(); // k -> { idx, positions, codes }
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const sys = k?.system;
      const ver = k?.version || null;
      if (!sys || !k?.code) continue;
      const key = `${sys}|${ver || ''}`;
      if (!groups.has(key)) groups.set(key, { sys, ver, positions: [], codes: [] });
      groups.get(key).positions.push(i);
      groups.get(key).codes.push(k.code);
    }

    for (const g of groups.values()) {
      let idx = this.get(g.sys, g.ver);
      if (!idx && g.ver != null) {
        idx = this.get(g.sys, null);
      }
      if (!idx) continue;
      const hits = await idx.batchHas(g.codes);
      for (let j = 0; j < g.positions.length; j++) {
        out[g.positions[j]] = hits[j] === true;
      }
    }

    return out;
  }

  async close() {
    for (const idx of this.bySystem.values()) {
      if (idx && typeof idx.close === 'function') {
        await idx.close();
      }
    }
  }
}

/**
 * Utility: build a multi-system index from a map of system keys -> Set of codes.
 */
function buildMultiFromSets(map) {
  const ms = new MultiSystemIndex();
  for (const [k, set] of map.entries()) {
    const [system, version] = parseSysVerKey(k);
    ms.set(system, version, new InMemorySetIndex(set));
  }
  return ms;
}

function makeSysVerKey(system, version) {
  return JSON.stringify([String(system || ''), version || null]);
}

function parseSysVerKey(key) {
  const parsed = JSON.parse(key);
  return [parsed[0], parsed[1] || null];
}

module.exports = {
  MultiSystemIndex,
  buildMultiFromSets,
  makeSysVerKey,
};
