#!/usr/bin/env node
'use strict';
// Schema check for catalog entries (and, when present, their reference answers).
// Usage: node tx/sqlite-v2/catalog/validate.js   -> exit 1 on any problem.

const fs = require('fs');
const path = require('path');
const { loadEntries, OPERATIONS, PATTERNS, REFERENCE_DIR } = require('./lib');

const CATEGORIES = [
  'hierarchy', 'exclusion-inactive', 'properties-attributes', 'refsets-implicit-ecl', 'text',
  'enumerated-nested', 'multi-system-versions', 'mixed-providers', 'limits-paging',
  'validate-lookup-subsumes', 'languages-supplements', 'output-heavy'
];
const SOURCES = ['constructed', 'vsac', 'us-core', 'ips'];
const EXPECT = ['fast', 'slow', 'mixed', 'unsupported'];
const SQLITE_SYSTEMS = ['http://snomed.info/sct', 'http://loinc.org', 'http://www.nlm.nih.gov/research/umls/rxnorm'];

function check(file, e) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  const str = (v) => typeof v === 'string' && v.trim().length > 0;
  need(str(e.id) && /^[a-z0-9][a-z0-9-]*$/.test(e.id), 'id: lower-case kebab string');
  need(file === e.id + '.json', `file name must be <id>.json (${file})`);
  for (const k of ['title', 'exercises', 'why']) need(str(e[k]), k + ': non-empty string');
  need(CATEGORIES.includes(e.category), 'category: one of ' + CATEGORIES.join(', '));
  need(EXPECT.includes(e.expect), 'expect: one of ' + EXPECT.join(', '));
  need(e.source && SOURCES.includes(e.source.kind), 'source.kind: one of ' + SOURCES.join(', '));
  if (e.source && e.source.kind !== 'constructed') need(str(e.source.url), 'source.url for a real value set');
  need(Array.isArray(e.systems) && e.systems.length > 0 && e.systems.every(str), 'systems: non-empty string array');
  need(e.engine && Array.isArray(e.engine.sqlite) && Array.isArray(e.engine.main), 'engine.sqlite / engine.main arrays');
  if (e.engine && Array.isArray(e.engine.sqlite)) need(e.engine.sqlite.every((s) => SQLITE_SYSTEMS.includes(s)), 'engine.sqlite only lists SNOMED/LOINC/RxNorm');
  need(typeof e.orderDefined === 'boolean', 'orderDefined: boolean');
  const r = e.request;
  need(r && OPERATIONS.includes(r.operation), 'request.operation: one of ' + OPERATIONS.join(', '));
  if (r) {
    if (r.valueSet) {
      need(r.valueSet.resourceType === 'ValueSet', 'request.valueSet.resourceType = ValueSet');
      need(r.valueSet.compose && Array.isArray(r.valueSet.compose.include) && r.valueSet.compose.include.length > 0, 'request.valueSet.compose.include non-empty');
    }
    need(!(r.valueSet && r.valueSetUrl), 'request: valueSet OR valueSetUrl, not both');
    if (r.operation === 'expand') need(r.valueSet || r.valueSetUrl, 'expand needs valueSet or valueSetUrl');
    if (r.operation === 'lookup' || r.operation === 'subsumes') need(r.parameters && r.parameters.system, r.operation + ' needs parameters.system');
    if (r.operation === 'validate-code') need(r.parameters && (r.parameters.code || r.parameters.coding), 'validate-code needs parameters.code or coding');
    for (const t of r.txResources || []) need(t && ['ValueSet', 'CodeSystem'].includes(t.resourceType) && str(t.url), 'txResources: ValueSet/CodeSystem with url');
    need(r.parameters == null || (typeof r.parameters === 'object' && !Array.isArray(r.parameters)), 'request.parameters: object');
    if (r.parameters) need(r.parameters.offset == null && r.parameters.count == null, 'offset/count belong in paging/patterns, not parameters');
  }
  if (r && r.operation === 'expand') {
    need(Array.isArray(e.patterns) && e.patterns.length > 0 && e.patterns.every((p) => PATTERNS.includes(p)), 'patterns: subset of ' + PATTERNS.join(', '));
    need(e.paging && (e.paging.count === null || (Number.isInteger(e.paging.count) && e.paging.count >= 0)), 'paging.count: integer >= 0, or null to omit offset/count');
    if ((e.patterns || []).some((p) => /deep/.test(p))) need(e.paging && Number.isInteger(e.paging.deepOffset), 'paging.deepOffset needed by deep patterns');
  } else if (r) {
    need(!e.patterns || e.patterns.length === 0, 'patterns only for expand');
  }
  const ASPECTS = ['status', 'total', 'codes', 'displays', 'designations', 'definitions', 'result', 'display', 'properties', 'outcome', 'any'];
  if (e.expectedDifferences != null) {
    need(Array.isArray(e.expectedDifferences) && e.expectedDifferences.every((d) => ASPECTS.includes(d.aspect) && str(d.kind) && str(d.reason) && d.reason.length > 20),
      'expectedDifferences: [{aspect (' + ASPECTS.join('|') + '), kind, reason (a written explanation)}]');
  }
  if (e.category === 'output-heavy') need(str(e.stresses), 'stresses: what the request stresses (rows, designations, properties, size)');
  if (e.variantOf != null) need(str(e.variantOf), 'variantOf: id string');
  if (e.equivalentEntries != null) need(Array.isArray(e.equivalentEntries) && e.equivalentEntries.every(str), 'equivalentEntries: id array');
  // reference answers, if any
  const ref = path.join(REFERENCE_DIR, e.id + '.json');
  if (fs.existsSync(ref)) {
    try {
      const j = JSON.parse(fs.readFileSync(ref, 'utf8'));
      need(j.id === e.id && j.patterns && typeof j.patterns === 'object', 'reference: id and patterns');
    } catch (x) { errs.push('reference does not parse: ' + x.message); }
  }
  return errs;
}

function main() {
  const entries = loadEntries();
  const ids = new Set();
  let bad = 0;
  const byCat = {};
  for (const { file, entry } of entries) {
    const errs = check(file, entry);
    if (ids.has(entry.id)) errs.push('duplicate id');
    ids.add(entry.id);
    byCat[entry.category] = (byCat[entry.category] || 0) + 1;
    for (const ref of [entry.variantOf, ...(entry.equivalentEntries || [])].filter(Boolean)) {
      if (!entries.some((x) => x.entry.id === ref)) errs.push('unknown entry referenced: ' + ref);
    }
    if (errs.length) { bad++; console.log(file + ':\n  - ' + errs.join('\n  - ')); }
  }
  console.log(`${entries.length} entries, ${bad} with problems`);
  console.log(Object.entries(byCat).sort().map(([k, v]) => `  ${k}: ${v}`).join('\n'));
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();
module.exports = { check, CATEGORIES };
