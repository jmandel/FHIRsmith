'use strict';
// Size and cost limits for engine-backed expansions (modules.tx.sqliteV2 in the server config).
//
//   maxScanRows       planner estimate of fact rows a request may read (text/regex scans,
//                     relation images, per-candidate probes); beyond it the request is
//                     too-costly before any work is done. Default 5,000,000.
//
// Response sizes are upstream's (expand.js limitCount): a provider-selected page is added
// through the same includeCode as every other code. Totals come from set cardinalities and
// pages are by position (cs-api processSelection). The engine adds no caches: every request
// plans and evaluates, reading stored sets from SQLite (SQLite's page cache and the OS page cache under mmap are the only layers).

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

const settings = { maxScanRows: 5000000, sqliteCacheKB: 2048, mmapMB: 256, fhirProcessSelection: false,
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
