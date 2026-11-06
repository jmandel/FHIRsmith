'use strict';
// Size and cost limits for engine-backed expansions (modules.tx.sqliteV2 in the server config).
//
//   maxScanRows       planner estimate of fact rows a request may read (text/regex scans,
//                     relation images, per-candidate probes); beyond it the request is
//                     too-costly before any work is done. Default 5,000,000.
//
// Response sizes are upstream's (expand.js limitCount): a provider-selected page is added
// through the same includeCode as every other code. Totals come from set cardinalities and
// pages are by position (cs-api processSelection). The engine adds one cache, of built supplement
// layers (supplementLayerCacheMB); otherwise every request plans and evaluates, reading stored
// sets from SQLite (SQLite's page cache and the OS page cache under mmap).

//   supplementLayerCacheMB  memory for built supplement layers kept between requests (layers.js
//                     LayerCache, one per process): their SQLite pages, about 120 bytes per
//                     concept with one designation, 360 with five. Default 64: about 530k such
//                     concepts, two layers the size of all of LOINC (257k) or hundreds of the IG
//                     corpus's (99% have 1,001 concepts or fewer). Least recently used layers are
//                     dropped to stay under it; a layer bigger than the whole bound is built per
//                     request and not kept. 0 = keep none.
//   supplementFiles   server-known supplements of sqlite-v2 terminology files (library.yml sources
//                     and loaded packages) are imported once into a small v2 file each and read from
//                     there (supplement-files.js): no per-request build, and their concepts are not
//                     held on the heap. Default true, whatever the supplement's size (no threshold):
//                     a file costs about 0.5 KiB of disk per concept, built once and kept, where a
//                     250k-concept supplement held in memory costs 135 MiB of heap in every process.
//                     false = keep them in memory as main does (the in-memory layer and its LRU, as
//                     for tx-resource supplements).
//   sqliteCacheKB     SQLite page cache per connection. Default 2,048 (2 MiB): reads use mmap.
//   mmapMB            SQLite mmap window per file. Default 256 (file-backed, OS page cache).

//   content           { valueSets, codeSystems }: serve npm-package value sets / code systems and
//                     VSAC from sqlite-v2 content files (docs/sqlite-v2-content-store.md). With no
//                     `content` key: both on. A given object means exactly what it says (an omitted
//                     half is off): { valueSets: true } = value sets only; false, {} or
//                     { valueSets: false, codeSystems: false } = off (packages and VSAC as main
//                     loads them). `sqlite-v2:npm:<package>#<version>` sources always use them.
//   fhirProcessSelection  FHIR CodeSystem blocks (package code systems) evaluate whole composes on the
//                     engine (processSelection). Default false: expand.js then flattens the expansion,
//                     where main nests it by the code system's hierarchy.

const settings = { maxScanRows: 5000000, supplementLayerCacheMB: 64, supplementFiles: true, sqliteCacheKB: 2048, mmapMB: 256, fhirProcessSelection: false,
  content: { valueSets: true, codeSystems: true } };

function configure(cfg) {
  if (!cfg) return;
  for (const k of Object.keys(settings)) {
    if (typeof settings[k] === 'boolean') { if (typeof cfg[k] === 'boolean') settings[k] = cfg[k]; }
    else if (Number.isFinite(cfg[k]) && cfg[k] >= 0) settings[k] = cfg[k];
  }
  if (cfg.content === false) {
    settings.content = { valueSets: false, codeSystems: false };
  } else if (cfg.content && typeof cfg.content === 'object') {
    // a given object means exactly what it says: an omitted half is off
    settings.content = { valueSets: !!cfg.content.valueSets, codeSystems: !!cfg.content.codeSystems };
  }
}

class TooCostly extends Error {
  constructor(message) {
    super(message);
    this.tooCostly = true;
  }
}

module.exports = { settings, configure, TooCostly };
