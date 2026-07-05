#!/usr/bin/env node
// Source-of-truth verification for an RxNorm sqlite-v1 database.
//
// Independently re-derives expectations from the raw RRF files (RXNCONSO,
// RXNSTY, RXNREL, RXNSAB) with its own pipe-splitting reader. It shares NO
// code with the importer (tx/importers/import-rxnorm-sqlite-v1.module.js); it
// only encodes the importer's *declared* mappings:
//   * one concept per RXCUI with >=1 SAB=RXNORM atom
//   * active iff any RXNORM atom has SUPPRESS not in {O,E}
//   * one designation per RXNORM atom with non-empty STR (use_code = TTY)
//   * STY literals store the RXNSTY TUI (T-code), not the STY name
//   * RXNREL rows (SAB=RXNORM, RELA non-empty, both CUIs loaded) become links
//     with source=concept(RXCUI2), target=concept(RXCUI1), property=RELA
//   * one SUPPRESS literal per concept: 'N' if any atom is 'N', else the first
//     atom's SUPPRESS value ('' treated as 'N')
//   * code_system.version/release_date derive from RXNSAB SVER (RSAB=RXNORM)
//
// Usage:
//   node scripts/sqlite-v1-verify/verify-rxnorm.mjs \
//     --db <file.db> --source <rrf dir> [--samples N] [--seed S] [--allow-capped]
//
// --allow-capped: the importer's --max-rows caps the number of RXNCONSO rows
// scanned. That cap is recorded in load_audit.stats_json.scannedConso; in
// capped mode this script limits its own RXNCONSO scan to the same row count
// so per-CUI aggregates stay EXACT. If the audit row is missing, count checks
// degrade to "DB <= source" and membership-only. RXNSTY/RXNREL are never
// capped by the importer (they filter to loaded CUIs), so those checks are
// exact in both modes. Exit code 1 if any check FAILs.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCli(argv) {
  const opts = { samples: 25, seed: 42, allowCapped: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') opts.db = argv[++i];
    else if (a === '--source') opts.source = argv[++i];
    else if (a === '--samples') opts.samples = Number(argv[++i]);
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a === '--allow-capped') opts.allowCapped = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!opts.db || !opts.source) {
    console.error('Usage: verify-rxnorm.mjs --db <file> --source <dir> [--samples N] [--seed S] [--allow-capped]');
    process.exit(2);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Deterministic sampling
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleFrom(items, n, rand) {
  const arr = Array.from(items).sort();
  if (arr.length <= n) return arr;
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(rand() * (arr.length - i));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, n).sort();
}

/** Seeded reservoir sample over a stream (algorithm R). */
class Reservoir {
  constructor(k, rand) {
    this.k = k;
    this.rand = rand;
    this.seen = 0;
    this.items = [];
  }

  offer(item) {
    this.seen += 1;
    if (this.items.length < this.k) {
      this.items.push(item);
      return;
    }
    const j = Math.floor(this.rand() * this.seen);
    if (j < this.k) this.items[j] = item;
  }
}

function firstFew(iterable, limit = 8) {
  const out = [];
  for (const item of iterable) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function multisetKey(list) {
  return list.map((x) => JSON.stringify(x)).sort().join('\n');
}

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

const results = [];
async function check(name, fn) {
  let res;
  try {
    res = await fn();
  } catch (err) {
    res = { pass: false, lines: [`check threw: ${err && err.stack ? err.stack : err}`] };
  }
  results.push({ name, ...res });
  console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${name}`);
  for (const line of res.lines || []) console.log(`      ${line}`);
}

// ---------------------------------------------------------------------------
// RRF streaming (own reader: pipe-delimited, one record per line)
// ---------------------------------------------------------------------------

async function* rrfLines(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    yield line.split('|');
  }
}

const SUPPRESSED = new Set(['O', 'E']);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseCli(process.argv);
  const srcRoot = path.resolve(opts.source);
  const SRC = {
    rxnconso: path.join(srcRoot, 'RXNCONSO.RRF'),
    rxnsty: path.join(srcRoot, 'RXNSTY.RRF'),
    rxnrel: path.join(srcRoot, 'RXNREL.RRF'),
    rxnsab: path.join(srcRoot, 'RXNSAB.RRF'),
  };
  for (const [k, p] of Object.entries(SRC)) {
    if (!fs.existsSync(p)) {
      console.error(`Source file missing (${k}): ${p}`);
      process.exit(2);
    }
  }

  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const cs = db
    .prepare(`SELECT * FROM code_system WHERE base_uri = 'http://www.nlm.nih.gov/research/umls/rxnorm'`)
    .get();
  if (!cs) {
    console.error('No code_system row with the RxNorm base URI');
    process.exit(2);
  }
  const csId = cs.cs_id;

  // Under --allow-capped, recover the importer's RXNCONSO scan cap from the
  // audit trail so per-CUI aggregates can be recomputed over the same rows.
  let scanLimit = Infinity;
  let scanLimitKnown = true;
  if (opts.allowCapped) {
    scanLimitKnown = false;
    const audit = db
      .prepare(
        `SELECT stats_json FROM load_audit
          WHERE terminology = 'rxnorm' AND status = 'success'
          ORDER BY run_id DESC LIMIT 1`
      )
      .get();
    if (audit && audit.stats_json) {
      try {
        const stats = JSON.parse(audit.stats_json);
        if (Number.isFinite(stats.scannedConso) && stats.scannedConso > 0) {
          scanLimit = stats.scannedConso;
          scanLimitKnown = true;
        }
      } catch {
        /* fall through to relaxed mode */
      }
    }
  }

  console.log(`RxNorm verify: db=${opts.db}`);
  console.log(`  source=${srcRoot}`);
  console.log(`  version=${cs.version} canonical=${cs.canonical_uri} capped-mode=${opts.allowCapped}` +
    (opts.allowCapped ? ` (RXNCONSO scan limit ${scanLimitKnown ? scanLimit : 'UNKNOWN -> relaxed counts'})` : ''));
  console.log('');

  // ---- DB side --------------------------------------------------------------

  const dbConcepts = new Map(); // rxcui -> { id, active }
  const idToCode = new Map();
  for (const row of db
    .prepare(`SELECT concept_id, code, active FROM concept WHERE cs_id = ?`)
    .iterate(csId)) {
    dbConcepts.set(row.code, { id: row.concept_id, active: row.active });
    idToCode.set(row.concept_id, row.code);
  }

  const sampleCuis = sampleFrom(dbConcepts.keys(), opts.samples, mulberry32(opts.seed ^ 0x0c01));
  const sampleCuiSet = new Set(sampleCuis);

  // ---- RXNCONSO scan (single pass, importer-equivalent row accounting) ------

  // RXNCONSO columns: RXCUI|LAT|TS|LUI|STT|SUI|ISPREF|RXAUI|SAUI|SCUI|SDUI|
  //                   SAB(11)|TTY(12)|CODE|STR(14)|SRL|SUPPRESS(16)|CVF
  const agg = new Map(); // rxcui -> { anyUnsuppressed, anyN, first }
  const sampleAtoms = new Map(); // rxcui -> [{ tty, str }]
  let designationRows = 0; // RXNORM atoms with non-empty STR
  let scanned = 0;
  for await (const cols of rrfLines(SRC.rxnconso)) {
    if (cols.length < 17) continue;
    if (scanned >= scanLimit) break;
    scanned += 1;
    const rxcui = cols[0];
    if (cols[11] !== 'RXNORM' || !rxcui) continue;
    const tty = cols[12];
    const str = (cols[14] || '').trim();
    const suppress = cols[16];

    let a = agg.get(rxcui);
    if (!a) {
      a = { anyUnsuppressed: false, anyN: false, first: suppress };
      agg.set(rxcui, a);
    }
    if (!SUPPRESSED.has(suppress)) a.anyUnsuppressed = true;
    if (suppress === 'N') a.anyN = true;

    if (str) {
      designationRows += 1;
      if (sampleCuiSet.has(rxcui)) {
        let atoms = sampleAtoms.get(rxcui);
        if (!atoms) {
          atoms = [];
          sampleAtoms.set(rxcui, atoms);
        }
        atoms.push({ tty: tty || null, str });
      }
    }
  }

  const exactCounts = !opts.allowCapped || scanLimitKnown;

  // ---- checks ---------------------------------------------------------------

  await check('1. concept count: distinct RXCUI with >=1 SAB=RXNORM atom', () => {
    const lines = [];
    let pass = true;
    const alien = [];
    for (const code of dbConcepts.keys()) if (!agg.has(code)) alien.push(code);
    if (alien.length > 0) {
      pass = false;
      lines.push(`DB has ${alien.length} concept(s) with no RXNORM atom in the scanned source: ${firstFew(alien).join(', ')}`);
    }
    if (exactCounts) {
      const missing = [];
      for (const code of agg.keys()) {
        if (!dbConcepts.has(code)) {
          missing.push(code);
          if (missing.length > 8) break;
        }
      }
      const ok = dbConcepts.size === agg.size && missing.length === 0;
      if (!ok) pass = false;
      lines.push(`concepts: db=${dbConcepts.size} expected=${agg.size}` +
        (missing.length ? `; missing e.g. ${missing.slice(0, 8).join(', ')}` : ''));
    } else {
      const ok = dbConcepts.size <= agg.size;
      if (!ok) pass = false;
      lines.push(`concepts: db=${dbConcepts.size} <= source=${agg.size} (relaxed) ${ok ? 'ok' : 'VIOLATION'}`);
    }
    return { pass, lines };
  });

  await check('2. active mapping: CUI active iff any RXNORM atom SUPPRESS not in {O,E}', () => {
    const lines = [];
    let pass = true;
    let mismatches = 0;
    const examples = [];
    let dbActive = 0;
    for (const [code, c] of dbConcepts) {
      if (c.active === 1) dbActive += 1;
      const a = agg.get(code);
      if (!a) continue; // reported by check 1
      const exp = a.anyUnsuppressed ? 1 : 0;
      if (c.active !== exp) {
        mismatches += 1;
        if (examples.length < 8) examples.push(`${code}: expected active=${exp} got ${c.active}`);
      }
    }
    if (mismatches > 0) {
      pass = false;
      lines.push(`${mismatches} per-CUI active mismatches: ${examples.join('; ')}`);
    } else {
      lines.push(`per-CUI active flags match for all ${dbConcepts.size} concepts`);
    }
    if (exactCounts) {
      let expActive = 0;
      for (const a of agg.values()) if (a.anyUnsuppressed) expActive += 1;
      const ok = expActive === dbActive;
      if (!ok) pass = false;
      lines.push(`active=1 totals: db=${dbActive} expected=${expActive}`);
    }
    // Sample-level detail (subset of the full comparison above).
    lines.push(`sampled ${sampleCuis.length} CUIs re-checked: ` +
      sampleCuis.slice(0, 5).map((c) => `${c}=${dbConcepts.get(c).active}`).join(', ') + ', ...');
    return { pass, lines };
  });

  await check('3. designations: one per RXNORM atom with non-empty STR; (TTY, STR) multisets on samples', () => {
    const lines = [];
    let pass = true;

    const dbDesignations = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM designation d JOIN concept c ON c.concept_id = d.concept_id
          WHERE c.cs_id = ?`
      )
      .get(csId).n;
    if (exactCounts) {
      const ok = dbDesignations === designationRows;
      if (!ok) pass = false;
      lines.push(`designation rows: db=${dbDesignations} expected=${designationRows}`);
    } else {
      const ok = dbDesignations <= designationRows;
      if (!ok) pass = false;
      lines.push(`designation rows: db=${dbDesignations} <= source=${designationRows} (relaxed) ${ok ? 'ok' : 'VIOLATION'}`);
    }

    const desigStmt = db.prepare(
      `SELECT use_code AS tty, term AS str FROM designation WHERE concept_id = ?`
    );
    let okCount = 0;
    for (const cui of sampleCuis) {
      const expected = (sampleAtoms.get(cui) || []).map((a) => [a.tty, a.str]);
      const got = desigStmt.all(dbConcepts.get(cui).id).map((r) => [r.tty, r.str]);
      if (multisetKey(expected) !== multisetKey(got)) {
        pass = false;
        lines.push(`${cui}: (TTY,STR) multiset mismatch; expected ${expected.length} rows ${JSON.stringify(expected.slice(0, 4))}, got ${got.length} rows ${JSON.stringify(got.slice(0, 4))}`);
      } else {
        okCount += 1;
      }
    }
    lines.push(`${okCount}/${sampleCuis.length} sampled CUIs: designation (TTY, STR) multisets exactly equal`);
    return { pass, lines };
  });

  await check('4. STY literals: TUI values from RXNSTY (restricted to loaded CUIs)', async () => {
    const lines = [];
    let pass = true;

    // RXNSTY columns: RXCUI|TUI|STN|STY|ATUI|CVF
    const sampleTuis = new Map(); // rxcui -> [tui]
    let expectedTotal = 0;
    for await (const cols of rrfLines(SRC.rxnsty)) {
      if (cols.length < 2) continue;
      const rxcui = cols[0];
      const tui = (cols[1] || '').trim();
      if (!rxcui || !tui) continue;
      if (!dbConcepts.has(rxcui)) continue;
      expectedTotal += 1;
      if (sampleCuiSet.has(rxcui)) {
        let list = sampleTuis.get(rxcui);
        if (!list) {
          list = [];
          sampleTuis.set(rxcui, list);
        }
        list.push(tui);
      }
    }

    // Totals are exact in both modes (RXNSTY is filtered to loaded CUIs).
    const dbTotal = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM concept_literal l
           JOIN property_def p ON p.property_id = l.property_id
          WHERE p.cs_id = ? AND p.property_code = 'STY'`
      )
      .get(csId).n;
    if (dbTotal !== expectedTotal) {
      pass = false;
      lines.push(`STY literal rows: db=${dbTotal} expected=${expectedTotal}`);
    } else {
      lines.push(`STY literal rows: ${dbTotal} (exact)`);
    }

    const styStmt = db.prepare(
      `SELECT l.value_text AS tui
         FROM concept_literal l
         JOIN property_def p ON p.property_id = l.property_id
        WHERE l.source_concept_id = ? AND p.property_code = 'STY'`
    );
    let okCount = 0;
    let tuiShaped = 0;
    for (const cui of sampleCuis) {
      const expected = sampleTuis.get(cui) || [];
      const got = styStmt.all(dbConcepts.get(cui).id).map((r) => r.tui);
      for (const v of got) if (/^T\d{3}$/.test(v)) tuiShaped += 1;
      if (multisetKey(expected.map((x) => [x])) !== multisetKey(got.map((x) => [x]))) {
        pass = false;
        lines.push(`${cui}: STY expected [${expected.join(', ')}] got [${got.join(', ')}]`);
      } else {
        okCount += 1;
      }
    }
    lines.push(`${okCount}/${sampleCuis.length} sampled CUIs: STY multisets equal; ${tuiShaped} db values are TUI-shaped (T###)`);
    return { pass, lines };
  });

  await check('5. RELA links: RXNREL(SAB=RXNORM, RELA set, both CUIs loaded) -> concept_link', async () => {
    const lines = [];
    let pass = true;

    // RXNREL columns: RXCUI1(0)|RXAUI1|STYPE1|REL(3)|RXCUI2(4)|RXAUI2|STYPE2|
    //                 RELA(7)|RUI|SRUI|SAB(10)|SL|RG|DIR|SUPPRESS(14)|CVF
    let qualifying = 0;
    const reservoir = new Reservoir(20, mulberry32(opts.seed ^ 0x4e1a));
    for await (const cols of rrfLines(SRC.rxnrel)) {
      if (cols.length < 15) continue;
      if (cols[10] !== 'RXNORM') continue;
      const rela = cols[7];
      if (!rela) continue;
      const rxcui1 = cols[0];
      const rxcui2 = cols[4];
      if (!dbConcepts.has(rxcui1) || !dbConcepts.has(rxcui2)) continue;
      qualifying += 1;
      reservoir.offer({ rxcui1, rxcui2, rela });
    }

    // Which convention does the DB hold: raw rows or deduped triples?
    const totalLinks = db.prepare(`SELECT COUNT(*) AS n FROM concept_link`).get().n;
    const distinctLinks = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT DISTINCT source_concept_id, property_id, target_concept_id FROM concept_link)`
      )
      .get().n;
    const convention = totalLinks === distinctLinks ? 'no duplicate triples present' : 'duplicate triples present (importer stores one row per RXNREL row, no dedupe)';
    lines.push(`db links=${totalLinks}, distinct (source,property,target)=${distinctLinks} -> ${convention}`);

    // The importer declares one concept_link row per qualifying RXNREL row.
    if (totalLinks !== qualifying) {
      if (distinctLinks === totalLinks && qualifying > totalLinks) {
        pass = false;
        lines.push(`link total: db=${totalLinks} != qualifying source rows=${qualifying}; db matches a DEDUPED convention the importer does not declare`);
      } else {
        pass = false;
        lines.push(`link total: db=${totalLinks} expected=${qualifying} (one row per qualifying RXNREL row)`);
      }
    } else {
      lines.push(`link total: ${totalLinks} == qualifying RXNREL rows (exact; loaded-CUI filter uses the DB's own concept set)`);
    }

    const linkStmt = db.prepare(
      `SELECT COUNT(*) AS n
         FROM concept_link l
         JOIN property_def p ON p.property_id = l.property_id
        WHERE l.source_concept_id = ? AND l.target_concept_id = ? AND p.property_code = ?`
    );
    let okCount = 0;
    for (const s of reservoir.items) {
      // Declared direction: source = concept(RXCUI2), target = concept(RXCUI1).
      const n = linkStmt.get(dbConcepts.get(s.rxcui2).id, dbConcepts.get(s.rxcui1).id, s.rela).n;
      if (n < 1) {
        pass = false;
        lines.push(`missing link: ${s.rxcui2} --${s.rela}--> ${s.rxcui1}`);
      } else {
        okCount += 1;
      }
    }
    lines.push(`${okCount}/${reservoir.items.length} sampled RXNREL rows have the matching link (direction RXCUI2 -> RXCUI1)`);
    return { pass, lines };
  });

  await check('6. SUPPRESS literal: exactly one per concept; value follows the declared rule', () => {
    const lines = [];
    let pass = true;

    const suppressRows = db
      .prepare(
        `SELECT l.source_concept_id AS cid, l.value_text AS v
           FROM concept_literal l
           JOIN property_def p ON p.property_id = l.property_id
          WHERE p.cs_id = ? AND p.property_code = 'SUPPRESS'`
      )
      .all(csId);
    const byConcept = new Map();
    for (const row of suppressRows) {
      byConcept.set(row.cid, (byConcept.get(row.cid) || []).concat(row.v));
    }
    let missing = 0;
    let multiple = 0;
    let valueMismatch = 0;
    const examples = [];
    for (const [code, c] of dbConcepts) {
      const vals = byConcept.get(c.id) || [];
      if (vals.length === 0) {
        missing += 1;
        if (examples.length < 8) examples.push(`${code}: no SUPPRESS literal`);
        continue;
      }
      if (vals.length > 1) {
        multiple += 1;
        if (examples.length < 8) examples.push(`${code}: ${vals.length} SUPPRESS literals`);
        continue;
      }
      const a = agg.get(code);
      if (!a) continue; // reported by check 1
      const expected = a.anyN ? 'N' : (a.first || 'N');
      if (vals[0] !== expected) {
        valueMismatch += 1;
        if (examples.length < 8) examples.push(`${code}: expected '${expected}' got '${vals[0]}'`);
      }
    }
    if (missing || multiple || valueMismatch) {
      pass = false;
      lines.push(`missing=${missing}, multiple=${multiple}, valueMismatch=${valueMismatch}`);
      lines.push(...examples);
    } else {
      lines.push(`all ${dbConcepts.size} concepts carry exactly one SUPPRESS literal with the expected value`);
      lines.push(`(rule verified: 'N' if any atom SUPPRESS='N', else first atom's value; '' -> 'N')`);
    }
    return { pass, lines };
  });

  await check('7. code_system version/release_date derive from RXNSAB SVER (RSAB=RXNORM)', async () => {
    const lines = [];
    let pass = true;
    // RXNSAB columns: VCUI|RCUI|VSAB|RSAB(3)|SON|SF|SVER(6)|...
    let sver = null;
    for await (const cols of rrfLines(SRC.rxnsab)) {
      if (cols.length < 7) continue;
      if (cols[3] !== 'RXNORM') continue;
      sver = cols[6] || '';
      break;
    }
    if (sver === null) {
      return { pass: false, lines: ['no RSAB=RXNORM row found in RXNSAB.RRF'] };
    }
    const m = sver.match(/(\d{6})/); // SVER like 20AA_260504F embeds YYMMDD
    if (!m) {
      return { pass: false, lines: [`RXNSAB SVER '${sver}' does not embed a YYMMDD date`] };
    }
    const yy = m[1].slice(0, 2);
    const mm = m[1].slice(2, 4);
    const dd = m[1].slice(4, 6);
    const expVersion = `${mm}${dd}20${yy}`; // MMDDYYYY
    const expRelease = `20${yy}-${mm}-${dd}`;
    if (cs.version !== expVersion) {
      pass = false;
      lines.push(`version: db='${cs.version}' expected '${expVersion}' (from SVER '${sver}')`);
    } else {
      lines.push(`version: '${cs.version}' matches SVER '${sver}'`);
    }
    if (cs.release_date !== expRelease) {
      pass = false;
      lines.push(`release_date: db='${cs.release_date}' expected '${expRelease}'`);
    } else {
      lines.push(`release_date: '${cs.release_date}'`);
    }
    const expCanonical = `http://www.nlm.nih.gov/research/umls/rxnorm|${expVersion}`;
    if (cs.canonical_uri !== expCanonical) {
      lines.push(`NOTE: canonical_uri '${cs.canonical_uri}' != '${expCanonical}'`);
    }
    return { pass, lines };
  });

  db.close();

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(`Summary: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`Failed: ${failed.map((r) => r.name).join(' | ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
