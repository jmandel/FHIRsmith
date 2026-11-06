#!/usr/bin/env node
'use strict';
// Replay the catalog against any FHIRsmith (or other FHIR terminology) base URL and diff the
// answers against the recorded reference answers in reference/<id>.json.
//
//   node tx/sqlite-v2/catalog/replay.js --base http://localhost:3000/r4
//        [--only id,id] [--category hierarchy,text] [--cache DIR] [--json out.json] [--verbose]
//
// Per page it compares: HTTP status class, expansion.total, codes, and for $validate-code /
// $lookup / $subsumes the result fields. Codes are compared as system|code (versions are
// reported separately, as a soft difference). Order is compared only where the entry says
// orderDefined. When order is not defined, a page is only checked against the reference's
// complete code set (available when the reference returned the whole expansion in one page);
// otherwise only the page size is compared.
// Verdicts: match; improved (we answer where the reference returned an error); both-refuse (both
// returned errors on every page: not a match); known-diff; DIFF.
// A difference whose aspect is listed in the entry's expectedDifferences (with its written reason)
// is reported as "differs: <kind> (<reason>)" and does not fail the run.
// Exit status: 0 when every compared page matches or differs only in documented ways, 1 otherwise.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function args() {
  const a = { base: null, only: null, category: null, cache: null, json: null, verbose: false, intervalMs: 0 };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i];
    if (k === '--base') a.base = v[++i];
    else if (k === '--only') a.only = new Set(v[++i].split(','));
    else if (k === '--category') a.category = new Set(v[++i].split(','));
    else if (k === '--cache') a.cache = v[++i];
    else if (k === '--json') a.json = v[++i];
    else if (k === '--interval-ms') a.intervalMs = +v[++i];
    else if (k === '--verbose') a.verbose = true;
    else throw new Error('unknown argument ' + k);
  }
  if (!a.base) throw new Error('--base is required, e.g. --base http://localhost:3000/r4');
  return a;
}

const sc = (c) => c.split('|')[0] + '|' + c.split('|').slice(2).join('|'); // system|code
const statusClass = (s) => (s >= 200 && s < 300 ? 'ok' : s === 422 ? '422' : s >= 400 && s < 500 ? '4xx' : String(s));

function fullSetOf(ref) {
  // a reference page that returned everything (total known and codes.length == total, offset 0)
  for (const pages of Object.values(ref.patterns || {})) {
    for (const pg of pages) {
      if (pg.offset === 0 && pg.total != null && pg.codes && pg.codes.length === pg.total) return new Set(pg.codes.map(sc));
    }
  }
  return null;
}

function comparePage(entry, refPg, gotPg, full) {
  const diffs = [];
  const D = (aspect, msg) => diffs.push({ aspect, msg });
  const soft = [];
  if (!refPg) return { diffs: [{ aspect: 'status', msg: 'no reference page' }], soft };
  const rc = statusClass(refPg.status), gc = statusClass(gotPg.status);
  // the reference refused (error) and we answer: improved. Both refuse: its own verdict, never
  // a match (the request may be invalid, or both servers may lack the feature)
  if (rc !== 'ok' && gc === 'ok') { soft.push(`improved: reference was ${refPg.status}`); return { diffs, soft, improved: true }; }
  if (rc !== 'ok' && gc !== 'ok') {
    if (rc !== gc) soft.push(`status ${refPg.status} -> ${gotPg.status}`);
    return { diffs, soft, bothRefuse: true };
  }
  if (rc !== gc) D('status', `status ${refPg.status} -> ${gotPg.status}`);
  if (rc !== 'ok' || gc !== 'ok') return { diffs, soft };
  const op = entry.request.operation;
  if (op === 'expand') {
    if (refPg.total != null && gotPg.total != null && refPg.total !== gotPg.total) D('total', `total ${refPg.total} -> ${gotPg.total}`);
    if (refPg.total == null && gotPg.total != null) soft.push(`improved: total given (${gotPg.total}); reference had none`);
    if (refPg.total != null && gotPg.total == null) D('total', `total missing (reference ${refPg.total})`);
    const r = (refPg.codes || []).map(sc), g = (gotPg.codes || []).map(sc);
    if (entry.orderDefined) {
      if (r.join('\n') !== g.join('\n')) D('codes', `ordered codes differ (${r.length} vs ${g.length}; first difference at ${firstDiff(r, g)})`);
    } else {
      const rs = new Set(r), gs = new Set(g);
      if (full) {
        const extra = g.filter((c) => !full.has(c));
        if (extra.length) D('codes', `${extra.length} codes not in the reference set, e.g. ${extra.slice(0, 3).join(', ')}`);
        if (r.length === full.size) { // the page was the whole set
          const missing = r.filter((c) => !gs.has(c));
          if (missing.length) D('codes', `${missing.length} codes missing, e.g. ${missing.slice(0, 3).join(', ')}`);
        }
      } else if (r.length !== g.length) D('codes', `page size ${r.length} -> ${g.length}`);
      else if ([...rs].some((c) => !gs.has(c))) soft.push('page content differs (order not defined, full set unknown)');
    }
    const rv = new Set((refPg.codes || []).map((c) => c.split('|')[1]).filter(Boolean));
    const gv = new Set((gotPg.codes || []).map((c) => c.split('|')[1]).filter(Boolean));
    if ([...rv].join() !== [...gv].join()) soft.push(`contains versions ${[...rv].join(',') || '-'} -> ${[...gv].join(',') || '-'}`);
    if ((refPg.usedCodeSystems || []).join() !== (gotPg.usedCodeSystems || []).join()) soft.push(`used-codesystem ${(refPg.usedCodeSystems || []).join(' ')} -> ${(gotPg.usedCodeSystems || []).join(' ')}`);
    if (refPg.designations && gotPg.designations && refPg.designations.languages.join() !== gotPg.designations.languages.join()) D('designations', `designation languages ${refPg.designations.languages.join(',')} -> ${gotPg.designations.languages.join(',')}`);
    if (refPg.output && gotPg.output) {
      const ro = refPg.output, go = gotPg.output;
      if (ro.propertyCodes.join() !== go.propertyCodes.join()) D('properties', `property codes ${ro.propertyCodes.join(',') || '-'} -> ${go.propertyCodes.join(',') || '-'}`);
      if (ro.designationLanguages.join() !== go.designationLanguages.join()) D('designations', `designation languages ${ro.designationLanguages.join(',') || '-'} -> ${go.designationLanguages.join(',') || '-'}`);
      if ((ro.definitions > 0) !== (go.definitions > 0)) D('definitions', `definitions ${ro.definitions} -> ${go.definitions}`);
      soft.push(`output: bytes ${ro.responseBytes} -> ${go.responseBytes}, properties ${ro.propertiesTotal} -> ${go.propertiesTotal}, designations ${ro.designationsTotal} -> ${go.designationsTotal}`);
    }
    if (refPg.displays && gotPg.displays && refPg.displays.join('\n') !== gotPg.displays.join('\n') && entry.orderDefined) D('displays', 'displays differ');
  } else if (op === 'validate-code') {
    if (refPg.result !== gotPg.result) D('result', `result ${refPg.result} -> ${gotPg.result}`);
    if (refPg.display !== gotPg.display) soft.push(`display ${refPg.display} -> ${gotPg.display}`);
  } else if (op === 'lookup') {
    if (refPg.display !== gotPg.display) D('display', `display ${refPg.display} -> ${gotPg.display}`);
    const rp = new Set(refPg.properties || []), gp = new Set(gotPg.properties || []);
    const miss = [...rp].filter((x) => !gp.has(x)), extra = [...gp].filter((x) => !rp.has(x));
    if (miss.length || extra.length) D('properties', `properties: ${miss.length} missing, ${extra.length} extra`);
    if ((refPg.designations || []).join('\n') !== (gotPg.designations || []).join('\n')) soft.push('designations differ');
    if (refPg.propertyCount != null && gotPg.propertyCount != null && refPg.propertyCount !== gotPg.propertyCount) soft.push(`property count ${refPg.propertyCount} -> ${gotPg.propertyCount}`);
  } else if (op === 'subsumes') {
    if (refPg.outcome !== gotPg.outcome) D('outcome', `outcome ${refPg.outcome} -> ${gotPg.outcome}`);
  }
  return { diffs, soft };
}
function firstDiff(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i; return -1; }

async function main() {
  const a = args();
  let entries = lib.loadEntries().map((x) => x.entry);
  if (a.only) entries = entries.filter((e) => a.only.has(e.id));
  if (a.category) entries = entries.filter((e) => a.category.has(e.category));
  const report = [];
  let pass = 0, fail = 0, noref = 0, known = 0, improved = 0, refused = 0;
  for (const e of entries) {
    const refFile = path.join(lib.REFERENCE_DIR, e.id + '.json');
    const ref = fs.existsSync(refFile) ? JSON.parse(fs.readFileSync(refFile, 'utf8')) : null;
    const t0 = Date.now();
    const got = await lib.runEntry(e, a.base, { cacheDir: a.cache, minIntervalMs: a.intervalMs });
    const ms = Date.now() - t0;
    const full = ref ? fullSetOf(ref) : null;
    const res = { id: e.id, category: e.category, ms, patterns: {} };
    let bad = false, knownDiff = false, anyImproved = false, nPages = 0, refusedPages = 0;
    for (const [pattern, pages] of Object.entries(got.patterns)) {
      const refPages = ref && ref.patterns[pattern];
      res.patterns[pattern] = pages.map((pg, i) => {
        const rp = refPages && (refPages.find((x) => x.offset === pg.offset) || refPages[i]);
        // a page the reference has no answer for (e.g. the last page, when it gave no total)
        // that we serve successfully: improved
        const c = !ref ? { diffs: [], soft: ['no reference'] }
          : !rp && pg.status >= 200 && pg.status < 300 ? { diffs: [], soft: ['improved: page the reference could not serve'], improved: true }
            : comparePage(e, rp, pg, full);
        // known differences carry a written reason: reported, but not a failure
        const listed = e.expectedDifferences || [];
        const diffs = [], expected = [];
        for (const d of c.diffs) {
          const k = listed.find((x) => x.aspect === d.aspect || x.aspect === 'any');
          if (k) expected.push(`${d.msg} [differs: ${k.kind || 'reference data gap'} (${k.reason})]`); else diffs.push(d.msg);
        }
        if (diffs.length) bad = true;
        if (expected.length) knownDiff = true;
        nPages++;
        if (c.improved) anyImproved = true;
        if (c.bothRefuse) refusedPages++;
        return { offset: pg.offset, status: pg.status, total: pg.total, returned: (pg.codes || []).length, ms: pg.ms, diffs, expected, soft: c.soft };
      });
    }
    const allRefused = nPages > 0 && refusedPages === nPages;
    res.verdict = !ref ? 'no-reference' : bad ? 'DIFF' : allRefused ? 'both-refuse' : anyImproved ? 'improved' : knownDiff ? 'known-diff' : 'match';
    ({ 'no-reference': () => noref++, DIFF: () => fail++, 'both-refuse': () => refused++, improved: () => improved++, 'known-diff': () => known++, match: () => pass++ })[res.verdict]();
    report.push(res);
    const line = `${res.verdict.padEnd(12)} ${e.id} (${ms} ms)`;
    console.log(line);
    if (bad || knownDiff || a.verbose) {
      for (const [pattern, pages] of Object.entries(res.patterns)) {
        for (const pg of pages) {
          const msgs = [...pg.diffs.map((d) => 'DIFF ' + d), ...pg.expected, ...(a.verbose ? pg.soft.map((s) => 'note ' + s) : [])];
          if (msgs.length) console.log(`    ${pattern} @${pg.offset}: ${msgs.join('; ')}`);
        }
      }
    }
  }
  console.log(`\n${pass} match, ${improved} improved (we answer where the reference refused), ${refused} both refuse, ${known} differ only in documented ways (expectedDifferences), ${fail} differ, ${noref} without reference (of ${entries.length})`);
  if (a.json) fs.writeFileSync(a.json, JSON.stringify(report, null, 1));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e.message || e); process.exit(2); });
