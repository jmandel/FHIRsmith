#!/usr/bin/env node
/**
 * import-cpt-umls.js -- build the CPT database read by tx/cs/cs-cpt.js from a UMLS
 * Metathesaurus release (requires a UMLS licence; the output is licensed AMA content
 * and must never be published or committed).
 *
 *   node import-cpt-umls.js --meta <dir> --dest CodeSystem-cpt-2023.db \
 *        [--short-from <later MRCONSO.RRF>] [--version 2023]
 *
 * <dir> holds MRCONSO.RRF, MRSAT.RRF and MRHIER.RRF from the release -- either the full
 * files or SAB=CPT extracts (rows from other sources are skipped). Files are streamed.
 *
 * The mapping is tuned to reproduce tx.fhir.org's CPT 2023 (the reference database built
 * from the AMA data files); see the README written next to the db for the evidence:
 *
 *   Designations (sequence order = provider order; the first is the display):
 *     display   = CPT/PT (long descriptor; '>/=' -> '>=', and a trailing ';' restored on
 *                 descriptors that are the stem of indented child codes)
 *     upper     = upper-case of the display
 *     med       = CPT/SY (medium descriptor)
 *     short     = CPT/AB (short descriptor; not in UMLS releases before 2024 -- optionally
 *                 taken from a later release where that release's PT and SY are identical)
 *     consumer  = CPT/ETCF
 *     clinician = CPT/ETCLIN (one row each, sorted by text)
 *   PLA codes (####U) carry consumer/clinician only (AMA ships PLA long descriptors
 *   separately; the reference db has none). Codes created mid-cycle (after
 *   --main-cutoff, before the release year) carry display + consumer/clinician, and are
 *   dropped when they have no consumer/clinician descriptors.
 *   Properties: kind = code (5-digit numeric) | cat-2 (any ####A/F/M/T/U code); modifiers:
 *   general (CPT Level I), cat-1 (Level I approved for ASC), cat-2 (Category II
 *   modifiers), physical-status (P1-P6), hcpcs (the Level II modifiers listed in CPT
 *   Appendix A). Modifier display = name, plus the GUIDELINE text for Level I / Cat II.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

// Level II (HCPCS/National) modifiers listed in CPT Appendix A ("approved for ASC hospital
// outpatient use"). UMLS carries the whole HCPCS Level II list under CPT; the reference
// database has only these.
const APPENDIX_A_LEVEL_II = new Set(['E1', 'E2', 'E3', 'E4', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8',
  'F9', 'FA', 'GG', 'GH', 'LC', 'LD', 'LM', 'LT', 'QM', 'QN', 'RC', 'RI', 'RT', 'T1', 'T2', 'T3', 'T4', 'T5',
  'T6', 'T7', 'T8', 'T9', 'TA', 'XE', 'XS', 'XP', 'XU']);
const PHYSICAL_STATUS = new Set(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
// the July 2022 orthopoxvirus (monkeypox) special release; the reference db tags these with
// a second kind, 'orthopod'
const ORTHOPOD = new Set(['87593', '90611', '90622']);

// UMLS spells the AMA's >= / <= as >/= and </=; the reference db does not
const norm = (s) => s.replace(/>\/=/g, '>=').replace(/<\/=/g, '<=');

function args() {
  const a = { version: '2023', mainCutoff: '20220713' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--meta') a.meta = v();
    else if (k === '--dest') a.dest = v();
    else if (k === '--short-from') a.shortFrom = v();
    else if (k === '--version') a.version = v();
    else if (k === '--main-cutoff') a.mainCutoff = v();
    else throw new Error('unknown argument ' + k);
  }
  if (!a.meta || !a.dest) {
    throw new Error('usage: import-cpt-umls.js --meta <dir> --dest <file.db> [--short-from <MRCONSO.RRF>] [--version 2023]');
  }
  return a;
}

async function eachRow(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line) fn(line.split('|'));
  }
}

// section rank, following the order of the CPT book (and of the reference db)
function sectionRank(code) {
  if (/^\d{4}A$/.test(code)) return 6.5; // vaccine administration, in Medicine
  if (/F$/.test(code)) return 7;
  if (/T$/.test(code)) return 8;
  if (/M$/.test(code)) return 9;
  if (/U$/.test(code)) return 10;
  const n = parseInt(code, 10);
  if (n >= 99202 && n <= 99499) return 1;
  if (n <= 1999 || (n >= 99100 && n <= 99140)) return 2;
  if (n >= 10004 && n <= 69990) return 3;
  if (n >= 70010 && n <= 79999) return 4;
  if (n >= 80047 && n <= 89398) return 5;
  return 6;
}

async function main() {
  const a = args();
  const f = (n) => path.join(a.meta, n);

  // --- MRCONSO: atoms
  const codes = new Map(); // code -> {pt, sy, ab, etcf:[], etclin:[]}
  const mods = new Map(); // code -> {aui, name}
  const ht = new Map(); // aui -> name
  const get = (c) => {
    if (!codes.has(c)) codes.set(c, { etcf: [], etclin: [] });
    return codes.get(c);
  };
  await eachRow(f('MRCONSO.RRF'), (r) => {
    if (r[11] !== 'CPT' || r[1] !== 'ENG') return;
    const [aui, tty, code, str] = [r[7], r[12], r[13], r[14]];
    switch (tty) {
      case 'PT': get(code).pt = str; break;
      case 'SY': get(code).sy = str; break;
      case 'AB': get(code).ab = str; break;
      case 'ETCF': get(code).etcf.push(str); break;
      case 'ETCLIN': get(code).etclin.push(str); break;
      case 'MP': mods.set(code, { aui, name: str }); break;
      case 'HT': ht.set(aui, str); break;
      default: break;
    }
  });

  // --- MRSAT: DATE_CREATED for codes, GUIDELINE text and CPTLINK id for modifiers
  const created = new Map();
  const modAuis = new Map([...mods].map(([c, m]) => [m.aui, c]));
  const guideline = new Map();
  const linkId = new Map();
  await eachRow(f('MRSAT.RRF'), (r) => {
    if (r[9] !== 'CPT') return;
    const [aui, code, atn, atv] = [r[3], r[5], r[8], r[10]];
    if (atn === 'DATE_CREATED') created.set(code, atv);
    if (modAuis.has(aui)) {
      if (atn === 'GUIDELINE') {
        if (!guideline.has(code)) guideline.set(code, new Map());
        const m = /^(\d+): (.*)$/s.exec(atv);
        if (m) guideline.get(code).set(m[1], m[2]); // de-duplicates repeated numbering
      }
      if (atn === 'CPTLINK_CONCEPT_ID') linkId.set(code, parseInt(atv, 10));
    }
  });

  // --- MRHIER: which modifier group(s) each modifier sits under
  const groups = new Map();
  await eachRow(f('MRHIER.RRF'), (r) => {
    if (r[4] !== 'CPT' || !modAuis.has(r[1])) return;
    const code = modAuis.get(r[1]);
    const parents = r[6].split('.').map((x) => ht.get(x));
    if (!groups.has(code)) groups.set(code, new Set());
    groups.get(code).add(parents[parents.length - 1]);
  });

  // --- optional short descriptors from a later release, only where PT is unchanged
  let shortFilled = 0;
  if (a.shortFrom) {
    const later = new Map();
    await eachRow(a.shortFrom, (r) => {
      if (r[11] !== 'CPT') return;
      if (!later.has(r[13])) later.set(r[13], {});
      if (r[12] === 'PT') later.get(r[13]).pt = r[14];
      if (r[12] === 'SY') later.get(r[13]).sy = r[14];
      if (r[12] === 'AB') later.get(r[13]).ab = r[14];
    });
    for (const [code, c] of codes) {
      const l = later.get(code);
      if (!c.ab && c.pt && l && l.ab && l.pt === c.pt && l.sy === c.sy) {
        c.ab = l.ab;
        shortFilled++;
      }
    }
  }

  // --- build
  if (fs.existsSync(a.dest)) fs.unlinkSync(a.dest);
  const db = new Database(a.dest);
  db.exec(`
CREATE TABLE Information (
\`name\` varchar(64) NOT NULL,
\`value\` varchar(64) DEFAULT NULL,
PRIMARY KEY (\`name\`));
CREATE TABLE Concepts (
\`code\` varchar(15) NOT NULL,
\`modifier\` int DEFAULT NULL,
PRIMARY KEY (\`code\`));
CREATE TABLE Designations (
\`code\` varchar(15) NOT NULL,
\`type\` varchar(15) NOT NULL,
\`sequence\` int NOT NULL,
\`value\` text NOT NULL,
PRIMARY KEY (\`code\`, \`type\`, \`sequence\`));
CREATE TABLE Properties (
\`code\` varchar(15) NOT NULL,
\`name\` varchar(15) NOT NULL,
\`sequence\` int NOT NULL,
\`value\` varchar(15) NOT NULL,
PRIMARY KEY (\`code\`, \`name\`, \`sequence\`));`);
  const insInfo = db.prepare('INSERT INTO Information VALUES (?, ?)');
  const insC = db.prepare('INSERT INTO Concepts VALUES (?, ?)');
  const insD = db.prepare('INSERT INTO Designations VALUES (?, ?, ?, ?)');
  const insP = db.prepare('INSERT INTO Properties VALUES (?, ?, ?, ?)');
  const stats = { kinds: {}, dropped: [], displayless: 0 };
  const yearStart = a.version + '0101';

  db.transaction(() => {
    insInfo.run('version', a.version);
    insInfo.run('source', 'UMLS Metathesaurus (SAB=CPT), built by tx/importers/import-cpt-umls.js');
    insInfo.run('built', new Date().toISOString().slice(0, 10));
    if (a.shortFrom) insInfo.run('short-descriptors', 'from a later UMLS release where PT unchanged');

    // a descriptor that is the common stem of indented child codes keeps its trailing ';'
    // in the AMA files (UMLS drops it): detect it from the children's PTs
    const allPts = [...codes.values()].map((c) => c.pt).filter(Boolean).sort();
    const isStem = (pt) => {
      let lo = 0;
      let hi = allPts.length;
      const key = pt + ';';
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (allPts[mid] < key) lo = mid + 1; else hi = mid;
      }
      return lo < allPts.length && allPts[lo].startsWith(key);
    };

    const ordered = [...codes.entries()]
      .filter(([, c]) => c.pt || c.etcf.length || c.etclin.length)
      .sort(([x], [y]) => sectionRank(x) - sectionRank(y) || (x < y ? -1 : x > y ? 1 : 0));
    for (const [code, c] of ordered) {
      const isPla = /^\d{4}U$/.test(code);
      const date = created.get(code) || '';
      const midCycle = /^\d{8}$/.test(date) && date > a.mainCutoff && date < yearStart;
      const hasEtc = c.etcf.length > 0 || c.etclin.length > 0;
      if (midCycle && !hasEtc) {
        stats.dropped.push(code);
        continue;
      }
      const d = [];
      if (!isPla && c.pt) {
        const pt = norm(c.pt) + (isStem(c.pt) ? ';' : '');
        d.push(['display', pt]);
        if (!midCycle) {
          d.push(['upper', pt.toUpperCase()]);
          if (c.sy) d.push(['med', norm(c.sy)]);
          if (c.ab) d.push(['short', norm(c.ab)]);
        }
      }
      if (d.length === 0) stats.displayless++;
      for (const v of c.etcf) d.push(['consumer', norm(v)]);
      for (const v of [...c.etclin].sort()) d.push(['clinician', norm(v)]);
      insC.run(code, 0);
      d.forEach(([t, v], i) => insD.run(code, t, i, v));
      const kind = /^\d{5}$/.test(code) ? 'code' : 'cat-2';
      insP.run(code, 'kind', 0, kind);
      if (ORTHOPOD.has(code)) insP.run(code, 'kind', 1, 'orthopod');
      stats.kinds[kind] = (stats.kinds[kind] || 0) + 1;
    }

    // modifiers, in the reference order: Level I, physical status, ASC-only Level I,
    // Category II, Appendix A Level II
    const modRows = [];
    for (const [code, m] of mods) {
      const g = groups.get(code) || new Set();
      const kinds = [];
      let rank;
      if (g.has('CPT Level I Modifiers')) { kinds.push('general'); rank = 1; }
      if (g.has('CPT Level I Modifiers for ASC')) { kinds.push('cat-1'); rank = rank || 3; }
      if (g.has('Category II Modifiers')) { kinds.push('cat-2'); rank = 4; }
      if (g.has('Level II (HCPCS/National) Modifiers')) {
        if (PHYSICAL_STATUS.has(code)) { kinds.push('physical-status'); rank = 2; }
        else if (APPENDIX_A_LEVEL_II.has(code)) { kinds.push('hcpcs'); rank = 5; }
      }
      if (!kinds.length) continue;
      const gl = guideline.get(code);
      let display = m.name;
      if (gl && gl.size && (rank === 1 || rank === 3)) {
        display = m.name + ': ' + [...gl.keys()].sort().map((k) => gl.get(k)).join(' ');
      } else if (gl && gl.size && rank === 4) {
        display = m.name + ' ' + [...gl.keys()].sort().map((k) => gl.get(k)).join(' ');
      }
      modRows.push({ code, rank, kinds, display, id: linkId.get(code) || 0 });
    }
    // Level I in code order; the other groups in AMA concept-id order (as the reference db)
    modRows.sort((x, y) => x.rank - y.rank ||
      (x.rank === 1 ? (x.code < y.code ? -1 : x.code > y.code ? 1 : 0) : x.id - y.id));
    for (const r of modRows) {
      insC.run(r.code, 1);
      insD.run(r.code, 'display', 0, r.display);
      r.kinds.forEach((k, i) => insP.run(r.code, 'kind', i, k));
      for (const k of r.kinds) stats.kinds['modifier/' + k] = (stats.kinds['modifier/' + k] || 0) + 1;
    }
    stats.modifiers = modRows.length;
  })();
  db.close();
  stats.shortFilled = shortFilled;
  console.log(JSON.stringify(stats, null, 1));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
