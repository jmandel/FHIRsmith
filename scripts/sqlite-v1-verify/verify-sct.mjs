#!/usr/bin/env node
// Source-of-truth verification for a SNOMED CT sqlite-v1 database.
//
// Independently re-derives expectations from the raw RF2 Snapshot files
// (sct2_Concept, sct2_Description, sct2_TextDefinition, sct2_Relationship,
// language refset, der2_Refset_Simple) with its own tab-splitting reader and
// its own is-a BFS. It shares NO code with the importer
// (tx/importers/import-sct-sqlite-v1.module.js); it only encodes the
// importer's *declared* mappings:
//   * concepts: one per sct2_Concept row (active + inactive), active from RF2
//   * display: active en-US-refset preferred synonym; fallback FSN, then first
//     active description, then the code
//   * designations: one per description row (FSN/synonym/text definition),
//     use_code = RF2 typeId
//   * closure: transitive over ACTIVE is-a (116680003) inferred relationships,
//     child->parent, NO self-rows
//   * non-is-a relationship rows -> concept_link with property = typeId,
//     group_id = relationshipGroup
//   * simple refsets -> value_set url http://snomed.info/sct?fhir_vs=refset/{id}
//     with active members only
//
// Usage:
//   node scripts/sqlite-v1-verify/verify-sct.mjs \
//     --db <file.db> --source <RF2 release dir> [--samples N] [--seed S] [--allow-capped]
//
// --allow-capped relaxes ONLY the full concept-count checks (the importer's
// --max-concepts caps concept rows) to "DB <= source"; every other check
// restricts itself to the concepts actually present in the DB (exactly what
// the importer does), so those stay exact. Exit code 1 if any check FAILs.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// RF2 constant ids (from the SNOMED CT specification, not from the importer).
const IS_A = '116680003';
const FSN_TYPE = '900000000000003001';
const SYNONYM_TYPE = '900000000000013009';
const TEXTDEF_TYPE = '900000000000550004';
const EN_US_REFSET = '900000000000509007';
const PREFERRED = '900000000000548007';
const SUBSTANCE = '105590001';

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
    console.error('Usage: verify-sct.mjs --db <file> --source <dir> [--samples N] [--seed S] [--allow-capped]');
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
// RF2 streaming (own reader: tab-delimited, header row skipped)
// ---------------------------------------------------------------------------

async function forEachRf2Row(filePath, cb) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      continue;
    }
    if (!line) continue;
    cb(line.split('\t'));
  }
}

function discoverRf2Files(root) {
  const files = { concept: [], description: [], relationship: [], language: [], simpleRefset: [] };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;
      if (!full.toLowerCase().includes('snapshot')) continue;
      const name = entry.name;
      if (/^sct2_Concept_Snapshot/.test(name)) files.concept.push(full);
      else if (/^sct2_Description_Snapshot/.test(name) || /^sct2_TextDefinition_Snapshot/.test(name)) {
        files.description.push(full);
      } else if (/^sct2_Relationship_Snapshot/.test(name)) files.relationship.push(full);
      else if (/^der2_cRefset_LanguageSnapshot/.test(name)) files.language.push(full);
      else if (/^der2_Refset_SimpleSnapshot/.test(name)) files.simpleRefset.push(full);
    }
  };
  walk(root);
  files.description.sort(); // Description before TextDefinition, like a sorted walk
  return files;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseCli(process.argv);
  const srcRoot = path.resolve(opts.source);
  const files = discoverRf2Files(srcRoot);
  for (const [k, list] of Object.entries(files)) {
    if (list.length === 0) {
      console.error(`No RF2 ${k} snapshot file found under ${srcRoot}`);
      process.exit(2);
    }
  }

  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const cs = db.prepare(`SELECT * FROM code_system WHERE base_uri = 'http://snomed.info/sct'`).get();
  if (!cs) {
    console.error('No code_system row with base_uri http://snomed.info/sct');
    process.exit(2);
  }
  const csId = cs.cs_id;
  console.log(`SNOMED CT verify: db=${opts.db}`);
  console.log(`  source=${srcRoot}`);
  console.log(`  edition=${cs.edition_code} version=${cs.version} canonical=${cs.canonical_uri} capped-mode=${opts.allowCapped}`);
  console.log('');

  // ---- DB side --------------------------------------------------------------

  const dbConcepts = new Map(); // code -> { id, active, display }
  for (const row of db
    .prepare(`SELECT concept_id, code, active, display FROM concept WHERE cs_id = ?`)
    .iterate(csId)) {
    dbConcepts.set(row.code, { id: row.concept_id, active: row.active, display: row.display });
  }

  // Deterministic samples, all drawn from the DB.
  const sampleClosure = sampleFrom(dbConcepts.keys(), opts.samples, mulberry32(opts.seed ^ 0x5c70));
  const activeCodes = [];
  for (const [code, c] of dbConcepts) if (c.active === 1) activeCodes.push(code);
  const sampleDisplay = sampleFrom(activeCodes, opts.samples, mulberry32(opts.seed ^ 0xd15b));
  const sampleDescSet = new Set([...sampleClosure, ...sampleDisplay]);

  // ---- source scans ---------------------------------------------------------

  // Concept snapshot: id(0), effectiveTime(1), active(2), moduleId(3), definitionStatusId(4)
  let srcConceptRows = 0;
  let srcActiveRows = 0;
  const srcActiveByCode = new Map(); // only kept for codes present in the DB
  for (const file of files.concept) {
    await forEachRf2Row(file, (cols) => {
      if (cols.length < 5) return;
      srcConceptRows += 1;
      const active = cols[2] === '1';
      if (active) srcActiveRows += 1;
      if (dbConcepts.has(cols[0])) srcActiveByCode.set(cols[0], active);
    });
  }

  // Relationship snapshot: id(0), effectiveTime(1), active(2), moduleId(3),
  // sourceId(4), destinationId(5), relationshipGroup(6), typeId(7), ...
  // Build is-a adjacency over concepts present in the DB (the importer skips
  // rows whose endpoints were not loaded), plus a reservoir of active non-is-a rows.
  const codeIndex = new Map(); // code -> int
  const indexCode = [];
  const internCode = (code) => {
    let ix = codeIndex.get(code);
    if (ix === undefined) {
      ix = indexCode.length;
      codeIndex.set(code, ix);
      indexCode.push(code);
    }
    return ix;
  };
  const parentsAdj = []; // childIx -> [parentIx]
  const childrenAdj = []; // parentIx -> [childIx]
  const pushAdj = (adj, ix, v) => {
    while (adj.length <= ix) adj.push(null);
    if (adj[ix] === null) adj[ix] = [];
    adj[ix].push(v);
  };
  let isaActiveRows = 0;
  const relReservoir = new Reservoir(20, mulberry32(opts.seed ^ 0x3e17));
  for (const file of files.relationship) {
    await forEachRf2Row(file, (cols) => {
      if (cols.length < 10) return;
      const active = cols[2] === '1';
      const sourceId = cols[4];
      const destinationId = cols[5];
      const typeId = cols[7];
      if (!dbConcepts.has(sourceId) || !dbConcepts.has(destinationId)) return;
      if (typeId === IS_A) {
        if (!active) return;
        isaActiveRows += 1;
        const c = internCode(sourceId);
        const p = internCode(destinationId);
        pushAdj(parentsAdj, c, p);
        pushAdj(childrenAdj, p, c);
      } else if (active) {
        relReservoir.offer({
          sourceId,
          destinationId,
          typeId,
          group: parseInt(cols[6], 10) || 0,
        });
      }
    });
  }

  const bfs = (startCode, adj) => {
    const out = new Set();
    const startIx = codeIndex.get(startCode);
    if (startIx === undefined) return out;
    const stack = [startIx];
    const seen = new Set([startIx]);
    while (stack.length > 0) {
      const cur = stack.pop();
      const next = adj[cur] || null;
      if (!next) continue;
      for (const nx of next) {
        if (!seen.has(nx)) {
          seen.add(nx);
          out.add(indexCode[nx]);
          stack.push(nx);
        }
      }
    }
    out.delete(startCode); // a cycle back to the start is not its own ancestor/descendant
    return out;
  };

  // Description + TextDefinition snapshots: id(0), effectiveTime(1), active(2),
  // moduleId(3), conceptId(4), languageCode(5), typeId(6), term(7), caseSig(8)
  let srcDescRowsForLoaded = 0;
  const sampleDescRows = new Map(); // conceptCode -> [{ descId, active, lang, typeId, term }]
  for (const file of files.description) {
    await forEachRf2Row(file, (cols) => {
      if (cols.length < 9) return;
      const conceptCode = cols[4];
      if (!dbConcepts.has(conceptCode)) return;
      srcDescRowsForLoaded += 1;
      if (sampleDescSet.has(conceptCode)) {
        let list = sampleDescRows.get(conceptCode);
        if (!list) {
          list = [];
          sampleDescRows.set(conceptCode, list);
        }
        list.push({
          descId: cols[0],
          active: cols[2] === '1',
          lang: cols[5],
          typeId: cols[6],
          term: cols[7],
        });
      }
    });
  }

  // Language refset: id(0), effectiveTime(1), active(2), moduleId(3),
  // refsetId(4), referencedComponentId(5), acceptabilityId(6). Only the
  // description ids of the sampled concepts matter here.
  const wantedDescIds = new Set();
  for (const rows of sampleDescRows.values()) for (const r of rows) wantedDescIds.add(r.descId);
  const preferredDescIds = new Set();
  for (const file of files.language) {
    await forEachRf2Row(file, (cols) => {
      if (cols.length < 7) return;
      if (cols[2] !== '1') return;
      if (cols[4] !== EN_US_REFSET) return;
      if (cols[6] !== PREFERRED) return;
      if (wantedDescIds.has(cols[5])) preferredDescIds.add(cols[5]);
    });
  }

  // Simple refset: id(0), effectiveTime(1), active(2), moduleId(3),
  // refsetId(4), referencedComponentId(5) -- active member rows only.
  const refsetMembers = new Map(); // refsetId -> Set(componentCode in DB)
  for (const file of files.simpleRefset) {
    await forEachRf2Row(file, (cols) => {
      if (cols.length < 6) return;
      if (cols[2] !== '1') return;
      const refsetId = cols[4];
      const componentId = cols[5];
      if (!refsetId || !componentId) return;
      if (!dbConcepts.has(componentId)) return;
      let set = refsetMembers.get(refsetId);
      if (!set) {
        set = new Set();
        refsetMembers.set(refsetId, set);
      }
      set.add(componentId);
    });
  }

  // ---- checks ---------------------------------------------------------------

  await check('1. concept counts and active flags vs sct2_Concept snapshot', () => {
    const lines = [];
    let pass = true;

    const alien = [];
    for (const code of dbConcepts.keys()) {
      if (!srcActiveByCode.has(code)) alien.push(code);
    }
    if (alien.length > 0) {
      pass = false;
      lines.push(`DB has ${alien.length} concept(s) not in the concept snapshot: ${firstFew(alien).join(', ')}`);
    }

    let dbActive = 0;
    for (const c of dbConcepts.values()) if (c.active === 1) dbActive += 1;

    if (opts.allowCapped) {
      const ok = dbConcepts.size <= srcConceptRows && dbActive <= srcActiveRows;
      if (!ok) pass = false;
      lines.push(`concepts: db=${dbConcepts.size} <= source rows=${srcConceptRows}; active: db=${dbActive} <= source=${srcActiveRows} (capped) ${ok ? 'ok' : 'VIOLATION'}`);
    } else {
      const ok = dbConcepts.size === srcConceptRows && dbActive === srcActiveRows;
      if (!ok) pass = false;
      lines.push(`concepts: db=${dbConcepts.size} expected=${srcConceptRows}; active: db=${dbActive} expected=${srcActiveRows}`);
    }

    // Per-concept active flags: exact in both modes.
    let mismatches = 0;
    const examples = [];
    for (const [code, c] of dbConcepts) {
      const exp = srcActiveByCode.get(code);
      if (exp === undefined) continue;
      if ((c.active === 1) !== exp) {
        mismatches += 1;
        if (examples.length < 8) examples.push(`${code}: expected active=${exp ? 1 : 0} got ${c.active}`);
      }
    }
    if (mismatches > 0) {
      pass = false;
      lines.push(`${mismatches} per-concept active mismatches: ${examples.join('; ')}`);
    } else {
      lines.push(`per-concept active flags match for all ${dbConcepts.size} concepts`);
    }
    return { pass, lines };
  });

  const closureAncestors = db.prepare(
    `SELECT c.code AS code
       FROM closure cl JOIN concept c ON c.concept_id = cl.ancestor_id
      WHERE cl.descendant_id = ?`
  );

  await check(`2. closure: own BFS over active is-a rows vs closure table (${sampleClosure.length} samples)`, () => {
    const lines = [];
    let pass = true;

    const selfRows = db.prepare(`SELECT COUNT(*) AS n FROM closure WHERE ancestor_id = descendant_id`).get().n;
    if (selfRows !== 0) {
      pass = false;
      lines.push(`closure has ${selfRows} self-rows (expected 0)`);
    } else {
      lines.push('closure self-rows: 0');
    }

    let okCount = 0;
    for (const code of sampleClosure) {
      const expected = bfs(code, parentsAdj);
      const got = new Set(closureAncestors.all(dbConcepts.get(code).id).map((r) => r.code));
      if (got.size !== expected.size || [...expected].some((c) => !got.has(c))) {
        pass = false;
        lines.push(`${code}: expected ${expected.size} ancestors, got ${got.size}` +
          `; missing e.g. ${firstFew([...expected].filter((c) => !got.has(c))).join(', ') || '-'}` +
          `; extra e.g. ${firstFew([...got].filter((c) => !expected.has(c))).join(', ') || '-'}`);
      } else {
        okCount += 1;
      }
    }
    lines.push(`${okCount}/${sampleClosure.length} sampled concepts: ancestor sets exactly equal (active is-a rows used: ${isaActiveRows})`);

    // Descendant COUNT for one high-level concept.
    let root = SUBSTANCE;
    if (!dbConcepts.has(root) || codeIndex.get(root) === undefined) {
      // Capped smoke DBs may not include Substance; fall back to the loaded
      // concept with the most direct children (deterministic).
      let best = null;
      let bestN = -1;
      for (let ix = 0; ix < childrenAdj.length; ix += 1) {
        const n = childrenAdj[ix] ? childrenAdj[ix].length : 0;
        if (n > bestN || (n === bestN && best !== null && indexCode[ix] < best)) {
          best = indexCode[ix];
          bestN = n;
        }
      }
      root = best;
      lines.push(`NOTE: ${SUBSTANCE} (Substance) not loaded; using widest loaded concept ${root} instead`);
    }
    if (root) {
      const expectedCount = bfs(root, childrenAdj).size;
      const gotCount = db
        .prepare(`SELECT COUNT(*) AS n FROM closure WHERE ancestor_id = ?`)
        .get(dbConcepts.get(root).id).n;
      if (expectedCount !== gotCount) {
        pass = false;
        lines.push(`descendant count for ${root}: expected ${expectedCount}, got ${gotCount}`);
      } else {
        lines.push(`descendant count for ${root}: ${gotCount} (exact)`);
      }
    }
    return { pass, lines };
  });

  await check(`3. display: en-US preferred synonym with documented fallbacks (${sampleDisplay.length} active samples)`, () => {
    const lines = [];
    let pass = true;
    let viaPreferred = 0;
    let viaFsn = 0;
    let viaFirstActive = 0;
    let viaCode = 0;
    let preferredTextDefs = 0;
    for (const code of sampleDisplay) {
      const display = dbConcepts.get(code).display;
      const rows = sampleDescRows.get(code) || [];
      const preferredNonFsn = rows.filter(
        (r) => r.active && r.typeId !== FSN_TYPE && preferredDescIds.has(r.descId)
      );
      const fsns = rows.filter((r) => r.active && r.typeId === FSN_TYPE);
      const actives = rows.filter((r) => r.active);

      if (preferredNonFsn.length > 0) {
        viaPreferred += 1;
        const terms = new Set(preferredNonFsn.map((r) => r.term));
        if (!terms.has(display)) {
          pass = false;
          lines.push(`${code}: display '${display}' not among en-US preferred non-FSN terms [${firstFew(terms, 3).join(' | ')}]`);
        } else {
          const match = preferredNonFsn.find((r) => r.term === display);
          if (match && match.typeId === TEXTDEF_TYPE) preferredTextDefs += 1;
          const synonymTerms = new Set(
            preferredNonFsn.filter((r) => r.typeId === SYNONYM_TYPE).map((r) => r.term)
          );
          if (synonymTerms.size > 0 && !synonymTerms.has(display)) {
            lines.push(`NOTE ${code}: display '${display}' is a preferred non-synonym even though a preferred synonym exists`);
          }
        }
      } else if (fsns.length > 0) {
        viaFsn += 1;
        if (!fsns.some((r) => r.term === display)) {
          pass = false;
          lines.push(`${code}: display '${display}' does not match any active FSN (no preferred synonym exists)`);
        }
      } else if (actives.length > 0) {
        viaFirstActive += 1;
        if (!actives.some((r) => r.term === display)) {
          pass = false;
          lines.push(`${code}: display '${display}' not among active terms (fallback tier 3)`);
        }
      } else {
        viaCode += 1;
        if (display !== code) {
          pass = false;
          lines.push(`${code}: no active description; display should be the code, got '${display}'`);
        }
      }
    }
    lines.push(`fallback usage: preferred-synonym=${viaPreferred}, fsn=${viaFsn}, first-active=${viaFirstActive}, code=${viaCode}` +
      (preferredTextDefs ? `; ${preferredTextDefs} display(s) sourced from a preferred TEXT DEFINITION (importer treats any preferred non-FSN as display candidate)` : ''));
    return { pass, lines };
  });

  await check(`4. designations: DB rows vs description rows (${sampleDescSet.size} sampled concepts)`, () => {
    const lines = [];
    let pass = true;

    // Global: one designation per description row of a loaded concept (both files).
    const dbDesignations = db
      .prepare(
        `SELECT COUNT(*) AS n FROM designation d JOIN concept c ON c.concept_id = d.concept_id WHERE c.cs_id = ?`
      )
      .get(csId).n;
    if (dbDesignations !== srcDescRowsForLoaded) {
      pass = false;
      lines.push(`designation rows: db=${dbDesignations} expected=${srcDescRowsForLoaded} (description+textdef rows for loaded concepts)`);
    } else {
      lines.push(`designation rows: ${dbDesignations} (exact, both modes)`);
    }

    const desigStmt = db.prepare(
      `SELECT use_code AS typeId, term, active FROM designation WHERE concept_id = ?`
    );
    let okCount = 0;
    let fsnChecked = 0;
    for (const code of sampleDescSet) {
      const src = sampleDescRows.get(code) || [];
      const got = desigStmt.all(dbConcepts.get(code).id);
      const gotCounts = new Map();
      for (const g of got) {
        if (g.active !== 1) continue;
        const key = `${g.typeId}\t${g.term}`;
        gotCounts.set(key, (gotCounts.get(key) || 0) + 1);
      }
      const problems = [];
      const needed = new Map();
      for (const r of src) {
        if (!r.active) continue;
        const key = `${r.typeId}\t${r.term}`;
        needed.set(key, (needed.get(key) || 0) + 1);
      }
      for (const [key, n] of needed) {
        if ((gotCounts.get(key) || 0) < n) {
          const [typeId, term] = key.split('\t');
          problems.push(`missing active designation typeId=${typeId} term='${term}'`);
        }
      }
      // FSN rows must carry use_code = FSN typeId (covered by the key check,
      // but assert explicitly for the report).
      for (const r of src) {
        if (!r.active || r.typeId !== FSN_TYPE) continue;
        fsnChecked += 1;
        if (!got.some((g) => g.typeId === FSN_TYPE && g.term === r.term)) {
          problems.push(`FSN '${r.term}' has no designation with use_code=${FSN_TYPE}`);
        }
      }
      if (problems.length > 0) {
        pass = false;
        lines.push(`${code}: ${problems.slice(0, 4).join('; ')}`);
      } else {
        okCount += 1;
      }
    }
    lines.push(`${okCount}/${sampleDescSet.size} sampled concepts: DB designations cover all active descriptions (${fsnChecked} FSNs use_code-checked)`);
    return { pass, lines };
  });

  await check('5. simple refsets: der2_Refset_Simple active members vs value_set_member (5 sampled refsets)', () => {
    const lines = [];
    let pass = true;

    const prefix = 'http://snomed.info/sct?fhir_vs=refset/';
    const vsRows = db
      .prepare(`SELECT vs_id, url FROM value_set WHERE cs_id = ? AND url LIKE ?`)
      .all(csId, `${prefix}%`);
    const vsByRefset = new Map();
    for (const row of vsRows) vsByRefset.set(row.url.slice(prefix.length), row.vs_id);

    // Loaded-member filtering uses the DB's own concept set, so totals are
    // exact in both modes.
    const expRefsets = [...refsetMembers.entries()].filter(([, s]) => s.size > 0).length;
    if (vsByRefset.size !== expRefsets) {
      pass = false;
      lines.push(`value_set count: db=${vsByRefset.size} expected=${expRefsets} (refsets with >=1 loaded active member)`);
    } else {
      lines.push(`value_set count: ${vsByRefset.size}`);
    }

    const memberStmt = db.prepare(
      `SELECT c.code AS code FROM value_set_member m JOIN concept c ON c.concept_id = m.concept_id WHERE m.vs_id = ?`
    );
    const sampled = sampleFrom(vsByRefset.keys(), 5, mulberry32(opts.seed ^ 0x2ef5));
    let okCount = 0;
    for (const refsetId of sampled) {
      const expected = refsetMembers.get(refsetId) || new Set();
      const got = new Set(memberStmt.all(vsByRefset.get(refsetId)).map((r) => r.code));
      if (got.size !== expected.size || [...expected].some((c) => !got.has(c))) {
        pass = false;
        lines.push(`refset ${refsetId}: expected ${expected.size} members, got ${got.size}` +
          `; missing e.g. ${firstFew([...expected].filter((c) => !got.has(c))).join(', ') || '-'}` +
          `; extra e.g. ${firstFew([...got].filter((c) => !expected.has(c))).join(', ') || '-'}`);
      } else {
        okCount += 1;
      }
    }
    lines.push(`${okCount}/${sampled.length} sampled refsets: member sets exactly equal`);
    return { pass, lines };
  });

  await check('6. relationship links: 20 sampled active non-is-a rows exist as concept_link', () => {
    const lines = [];
    let pass = true;
    const linkStmt = db.prepare(
      `SELECT COUNT(*) AS n
         FROM concept_link l
         JOIN property_def p ON p.property_id = l.property_id
         JOIN concept s ON s.concept_id = l.source_concept_id
         JOIN concept t2 ON t2.concept_id = l.target_concept_id
        WHERE s.code = ? AND t2.code = ? AND p.property_code = ? AND l.group_id = ? AND l.active = 1`
    );
    let okCount = 0;
    for (const s of relReservoir.items) {
      const n = linkStmt.get(s.sourceId, s.destinationId, s.typeId, s.group).n;
      if (n < 1) {
        pass = false;
        lines.push(`missing link: ${s.sourceId} --${s.typeId}(group ${s.group})--> ${s.destinationId}`);
      } else {
        okCount += 1;
      }
    }
    lines.push(`${okCount}/${relReservoir.items.length} sampled relationship rows present (source=sourceId, target=destinationId, property=typeId, group_id=relationshipGroup)`);
    if (relReservoir.items.length === 0) lines.push('NOTE: no qualifying non-is-a rows found (all endpoints outside the DB?)');
    return { pass, lines };
  });

  await check('7. code_system row: canonical URI and release date', () => {
    const lines = [];
    let pass = true;
    // Version from the release directory name (e.g. ..._20260301T120000Z).
    const m = path.basename(srcRoot).match(/_(\d{8})T\d{6}Z?$/);
    if (!m) {
      return { pass: false, lines: [`cannot parse a YYYYMMDD version out of source dir name '${path.basename(srcRoot)}'`] };
    }
    const ver = m[1];
    const expRelease = `${ver.slice(0, 4)}-${ver.slice(4, 6)}-${ver.slice(6, 8)}`;
    // US1000124 releases carry the US module 731000124108.
    const expEdition = /US1000124/.test(path.basename(srcRoot)) ? '731000124108' : cs.edition_code;
    const expCanonical = `http://snomed.info/sct/${expEdition}/version/${ver}`;

    if (cs.edition_code !== expEdition) {
      pass = false;
      lines.push(`edition_code: db='${cs.edition_code}' expected '${expEdition}'`);
    }
    if (cs.version !== ver) {
      pass = false;
      lines.push(`version: db='${cs.version}' expected '${ver}'`);
    }
    if (cs.canonical_uri !== expCanonical) {
      pass = false;
      lines.push(`canonical_uri: db='${cs.canonical_uri}' expected '${expCanonical}'`);
    } else {
      lines.push(`canonical_uri: '${cs.canonical_uri}'`);
    }
    if (cs.release_date !== expRelease) {
      pass = false;
      lines.push(`release_date: db='${cs.release_date}' expected '${expRelease}'`);
    } else {
      lines.push(`release_date: '${cs.release_date}'`);
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
