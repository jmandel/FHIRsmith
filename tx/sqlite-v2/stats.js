'use strict';
// /<endpoint>/sqlite-v2/stats: process memory, per-file SQLite settings, and the data built at load.
// (sqlite-v2 keeps no caches.)

const { registry } = require('./store');
const { settings } = require('./settings');

function procStatus() {
  const out = {};
  try {
    for (const line of require('fs').readFileSync('/proc/self/status', 'utf8').split('\n')) {
      const m = /^(VmRSS|RssAnon|RssFile|RssShmem|VmHWM):\s+(\d+) kB/.exec(line);
      if (m) out[m[1]] = Number(m[2]) * 1024;
    }
  } catch (e) { /* not Linux */ }
  return out;
}

function stats(opts = {}) {
  if (opts.gc && typeof global.gc === 'function') global.gc();
  const m = process.memoryUsage();
  const stores = [];
  for (const s of registry.stores) {
    let cachePages = null;
    let mmap = null;
    try {
      cachePages = s.db.pragma('cache_size', { simple: true });
      mmap = s.db.pragma('mmap_size', { simple: true });
    } catch (e) { /* closed */ }
    stores.push({ file: s.file, system: s.system, version: s.version, sqliteCacheSize: cachePages, sqliteMmapBytes: mmap });
  }
  let orderBytes = 0;
  for (const e of registry.engines) orderBytes += e._order ? e._order.rank.byteLength + e._order.ids.byteLength : 0;
  return {
    settings,
    process: { rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, ...procStatus() },
    // data built at load (not caches): LOINC release-order rank arrays
    data: { orderArraysBytes: orderBytes },
    stores
  };
}

module.exports = { stats };
