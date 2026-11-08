'use strict';
// Which engine serves each code system (tests/tx/README.md "Engine runs").
//
// The library records every code system factory it registers. A branch with the sqlite-v2
// engine still serves SNOMED CT, LOINC or RxNorm from main's classic providers when its library
// lists them that way (`snomed:` .cache, `loinc:`, `rxnorm:` sources), so a run's label says
// nothing about what served it. This module turns the registrations into one startup line and,
// when FHIRSMITH_ENGINE (or modules.tx.expectEngine) names the engine the run is meant to test,
// stops the server if anything else serves those systems.
//
//   FHIRSMITH_ENGINE=v2       every SNOMED CT, LOINC and RxNorm factory is a sqlite-v2 one, at
//                             least one is registered, and the content store serves package
//                             value sets and code systems (and VSAC)
//   FHIRSMITH_ENGINE=classic  no sqlite-v2 factory and the content store off: main's providers only
//   FHIRSMITH_ENGINE_ALLOW_CLASSIC=<file>[,<file>]  classic files a v2 run may keep (by base name),
//                             e.g. loinc-2.77-a.db on the demo, which has no v2 build of LOINC 2.77

const path = require('path');

const GUARDED = {
  'http://snomed.info/sct': 'SNOMED CT',
  'http://loinc.org': 'LOINC',
  'http://www.nlm.nih.gov/research/umls/rxnorm': 'RxNorm'
};
const ENGINES = ['v2', 'classic'];

function isV2Factory(factory) {
  // lazy: the engine module isn't loaded by servers that never register a v2 file
  const { SqliteV2Factory } = require('./sqlite-v2/provider');
  return factory instanceof SqliteV2Factory;
}

/** One registration record, as Library.registerProvider keeps them. */
function registration(source, factory) {
  return {
    system: factory.system(),
    version: factory.version() ?? null,
    source: String(source),
    provider: factory.constructor && factory.constructor.name || 'unknown',
    engine: isV2Factory(factory) ? 'v2' : 'classic'
  };
}

/**
 * @param {object[]} registrations - Library.providerRegistrations
 * @param {{valueSets: boolean, codeSystems: boolean}} content - sqlite-v2 content store settings
 * @param {string|null} vsacProvider - class name of the VSAC value set provider, if VSAC is loaded
 */
function engineReport(registrations, content, vsacProvider = null) {
  const systems = {};
  for (const name of Object.values(GUARDED)) systems[name] = { v2: [], classic: [] };
  for (const r of registrations) {
    const name = GUARDED[r.system];
    if (name) systems[name][r.engine].push({ file: path.basename(r.source), version: r.version, provider: r.provider });
  }
  const used = Object.values(systems).flatMap(s => [...s.v2.map(() => 'v2'), ...s.classic.map(() => 'classic')]);
  const contentOn = !!(content && (content.valueSets || content.codeSystems));
  let label;
  if (!used.length) label = contentOn ? 'v2-content-only' : 'none';
  else if (used.every(e => e === 'v2')) label = contentOn ? 'v2' : 'mixed';
  else if (used.every(e => e === 'classic')) label = contentOn ? 'mixed' : 'classic';
  else label = 'mixed';
  return {
    label,
    systems,
    content: { valueSets: !!(content && content.valueSets), codeSystems: !!(content && content.codeSystems) },
    vsac: vsacProvider
  };
}

/** One line for the startup log and run headers. */
function formatEngineReport(report) {
  const parts = Object.entries(report.systems).map(([name, s]) => {
    if (!s.v2.length && !s.classic.length) return `${name} none`;
    const bits = [];
    if (s.v2.length) bits.push(`v2 x${s.v2.length}`);
    if (s.classic.length) bits.push(`classic x${s.classic.length} (${s.classic.map(c => c.file).join(', ')})`);
    return `${name} ${bits.join(' + ')}`;
  });
  const c = report.content;
  parts.push(`content store ${c.valueSets || c.codeSystems ? `VS ${c.valueSets ? 'on' : 'off'}, CS ${c.codeSystems ? 'on' : 'off'}` : 'off'}`);
  if (report.vsac) parts.push(`VSAC ${report.vsac}`);
  return `Engines: ${report.label} | ${parts.join(' | ')}`;
}

/**
 * Problems that make the run not the one `expected` names; [] when it is.
 * @param {object} report - engineReport()
 * @param {string} expected - 'v2' | 'classic'
 * @param {string[]} [allowClassic] - base names of classic files a v2 run may keep
 */
function engineProblems(report, expected, allowClassic = []) {
  if (!ENGINES.includes(expected)) {
    return [`FHIRSMITH_ENGINE must be one of ${ENGINES.join(', ')}, not '${expected}'`];
  }
  const problems = [];
  const allow = new Set(allowClassic);
  if (expected === 'v2') {
    let v2Count = 0;
    for (const [name, s] of Object.entries(report.systems)) {
      v2Count += s.v2.length;
      const classic = s.classic.filter(c => !allow.has(c.file));
      if (classic.length) {
        problems.push(`${name} is served by classic ${classic.map(c => `${c.provider} (${c.file})`).join(', ')}`);
      }
    }
    if (!v2Count) problems.push('no sqlite-v2 file is registered for SNOMED CT, LOINC or RxNorm');
    if (!report.content.valueSets || !report.content.codeSystems) {
      problems.push('the sqlite-v2 content store is not on for both value sets and code systems (modules.tx.sqliteV2.content)');
    }
  } else {
    for (const [name, s] of Object.entries(report.systems)) {
      if (s.v2.length) problems.push(`${name} is served by sqlite-v2 ${s.v2.map(c => c.file).join(', ')}`);
    }
    if (report.content.valueSets || report.content.codeSystems) {
      problems.push('the sqlite-v2 content store is on (set modules.tx.sqliteV2.content to false for a classic run)');
    }
  }
  return problems;
}

/** The problem with one registration in a run that expects `expected`, or null. */
function registrationProblem(reg, expected, allowClassic = []) {
  const name = GUARDED[reg.system];
  if (!name || !ENGINES.includes(expected) || reg.engine === expected) return null;
  const file = path.basename(reg.source);
  if (expected === 'v2' && allowClassic.includes(file)) return null;
  return `${name} is served by ${reg.engine} ${reg.provider} (${file})`;
}

/** The engine a run asks for: config first, then FHIRSMITH_ENGINE; null = no check. */
function expectedEngine(config = {}, env = process.env) {
  const value = config.expectEngine || env.FHIRSMITH_ENGINE || null;
  return value ? String(value).trim() : null;
}

function allowedClassic(config = {}, env = process.env) {
  const value = config.expectEngineAllowClassic || env.FHIRSMITH_ENGINE_ALLOW_CLASSIC || '';
  return (Array.isArray(value) ? value : String(value).split(',')).map(s => s.trim()).filter(Boolean);
}

module.exports = { GUARDED, registration, registrationProblem, engineReport, formatEngineReport, engineProblems, expectedEngine, allowedClassic };
