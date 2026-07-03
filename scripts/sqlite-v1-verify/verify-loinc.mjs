#!/usr/bin/env node
// Source-of-truth verification for a LOINC sqlite-v1 database.
//
// Independently re-derives expectations from the raw LOINC CSV distribution
// (LoincTable/Loinc.csv + AccessoryFiles) with its own RFC-4180 CSV parser and
// its own hierarchy BFS. It deliberately shares NO code with the importer
// (tx/importers/import-loinc-sqlite-v1.module.js); it only encodes the
// importer's *declared* mappings so it can catch implementation dishonesty.
//
// Usage:
//   node scripts/sqlite-v1-verify/verify-loinc.mjs \
//     --db <file.db> --source <Loinc_2.82 dir> [--samples N] [--seed S] [--allow-capped]
//
// --allow-capped relaxes ONLY full-count checks for main LOINC codes (the one
// class the importer's --max-rows caps) to "DB <= source" sanity; every
// sampled check stays exact because samples are drawn FROM the DB and then
// verified against the source. Exit code 1 if any check FAILs.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
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
    console.error('Usage: verify-loinc.mjs --db <file> --source <dir> [--samples N] [--seed S] [--allow-capped]');
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

/** Deterministic sample without replacement: sort, then partial Fisher-Yates. */
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
// Own streaming RFC-4180 CSV parser (quoted fields with commas, embedded
// newlines, "" escapes; BOM on first header cell stripped).
// ---------------------------------------------------------------------------

async function* csvRecords(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 16 });
  let field = '';
  let record = [];
  let inQuotes = false;
  let afterQuote = false; // saw '"' while quoted: escaped quote vs field close
  let hadContent = false;
  let skipLf = false;
  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (skipLf) {
        skipLf = false;
        if (ch === '\n') continue;
      }
      if (afterQuote) {
        afterQuote = false;
        if (ch === '"') {
          field += '"';
          continue;
        }
        inQuotes = false; // the quote closed the field; process ch below
      }
      if (inQuotes) {
        if (ch === '"') afterQuote = true;
        else field += ch;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        hadContent = true;
      } else if (ch === ',') {
        record.push(field);
        field = '';
        hadContent = true;
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r') skipLf = true;
        record.push(field);
        field = '';
        yield record;
        record = [];
        hadContent = false;
      } else {
        field += ch;
        hadContent = true;
      }
    }
  }
  if (field.length > 0 || record.length > 0 || hadContent) {
    record.push(field);
    yield record;
  }
}

/** Stream a CSV file as row objects keyed by header names. */
async function* csvRows(filePath) {
  let header = null;
  for await (const rec of csvRecords(filePath)) {
    if (header === null) {
      header = rec.map((h, i) => (i === 0 ? h.replace(/^\uFEFF/, '') : h));
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = rec[i] === undefined ? '' : rec[i];
    yield row;
  }
}

const t = (v) => (v === null || v === undefined ? '' : String(v).trim());

// ---------------------------------------------------------------------------
// The importer's DECLARED status mapping, re-stated here from the design docs
// (docs/sqlite-v1-design.md rule 4 + the importer's documented vocabulary):
// STATUS is preserved as a literal, normalized through a fixed vocabulary with
// fallback 'ACTIVE' for main codes; concept.active = STATUS in {ACTIVE,TRIAL}.
// ---------------------------------------------------------------------------

const LOINC_STATUS_VOCAB = new Map([
  ['NOTSTATED', 'NotStated'],
  ['ACTIVE', 'ACTIVE'],
  ['DEPRECATED', 'DEPRECATED'],
  ['TRIAL', 'TRIAL'],
  ['DISCOURAGED', 'DISCOURAGED'],
  ['EXAMPLE', 'EXAMPLE'],
  ['PREFERRED', 'PREFERRED'],
  ['PRIMARY', 'Primary'],
  ['DOCUMENTONTOLOGY', 'DocumentOntology'],
  ['RADIOLOGY', 'Radiology'],
  ['NORMATIVE', 'NORMATIVE'],
]);

function expectedStatusLiteral(rawStatus, fallback) {
  const key = t(rawStatus).toUpperCase();
  if (!key) return fallback;
  return LOINC_STATUS_VOCAB.get(key) || fallback;
}

function expectedActive(rawStatus, fallback) {
  // Reference (tx.fhir.org / cs-loinc) semantics: only DISCOURAGED is inactive;
  // ACTIVE / TRIAL / DEPRECATED are all active.
  const s = expectedStatusLiteral(rawStatus, fallback);
  return s !== 'DISCOURAGED';
}

// Code shape classes.
const RE_MAIN = /^\d+-\d$/;
const RE_PART = /^LP\d+-\d$/;
const RE_ANSWER = /^LA\d+-\d$/;
const RE_LIST = /^LL\d+-\d$/;
function codeClass(code) {
  if (RE_MAIN.test(code)) return 'main';
  if (RE_PART.test(code)) return 'part';
  if (RE_ANSWER.test(code)) return 'answer';
  if (RE_LIST.test(code)) return 'list';
  return 'other';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseCli(process.argv);
  const srcRoot = path.resolve(opts.source);

  const SRC = {
    loinc: path.join(srcRoot, 'LoincTable', 'Loinc.csv'),
    part: path.join(srcRoot, 'AccessoryFiles', 'PartFile', 'Part.csv'),
    answerList: path.join(srcRoot, 'AccessoryFiles', 'AnswerFile', 'AnswerList.csv'),
    hierarchy: path.join(srcRoot, 'AccessoryFiles', 'ComponentHierarchyBySystem', 'ComponentHierarchyBySystem.csv'),
  };
  for (const [k, p] of Object.entries(SRC)) {
    if (!fs.existsSync(p)) {
      console.error(`Source file missing (${k}): ${p}`);
      process.exit(2);
    }
  }

  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const cs = db.prepare(`SELECT * FROM code_system WHERE base_uri = 'http://loinc.org'`).get();
  if (!cs) {
    console.error('No code_system row with base_uri http://loinc.org');
    process.exit(2);
  }
  const csId = cs.cs_id;
  console.log(`LOINC verify: db=${opts.db}`);
  console.log(`  source=${srcRoot}`);
  console.log(`  version=${cs.version} canonical=${cs.canonical_uri} capped-mode=${opts.allowCapped}`);
  console.log('');

  // ---- read the DB side up front -------------------------------------------

  const dbConcepts = new Map(); // code -> { id, active, display }
  for (const row of db
    .prepare(`SELECT concept_id, code, active, display FROM concept WHERE cs_id = ?`)
    .iterate(csId)) {
    dbConcepts.set(row.code, { id: row.concept_id, active: row.active, display: row.display });
  }

  // Main codes that were loaded from Loinc.csv rows (vs created as bare
  // multiaxial-hierarchy filler nodes under --max-rows): the importer writes a
  // STATUS literal for every Loinc.csv row it loads, and STATUS literals
  // otherwise only exist on Part concepts.
  const mainLoaded = new Set();
  for (const row of db
    .prepare(
      `SELECT DISTINCT c.code AS code
         FROM concept c
         JOIN concept_literal l ON l.source_concept_id = c.concept_id
         JOIN property_def p ON p.property_id = l.property_id
        WHERE c.cs_id = ? AND p.property_code = 'STATUS'`
    )
    .iterate(csId)) {
    if (RE_MAIN.test(row.code)) mainLoaded.add(row.code);
  }

  const literalsForConcept = db.prepare(
    `SELECT p.property_code AS prop, l.value_raw, l.value_text, l.value_num, l.value_bool
       FROM concept_literal l
       JOIN property_def p ON p.property_id = l.property_id
      WHERE l.source_concept_id = ?`
  );
  const designationCount = db.prepare(
    `SELECT COUNT(*) AS n FROM designation WHERE concept_id = ? AND use_code = ? AND term = ?`
  );
  const closureDescendants = db.prepare(
    `SELECT c.code AS code
       FROM closure cl JOIN concept c ON c.concept_id = cl.descendant_id
      WHERE cl.ancestor_id = ?`
  );

  // Deterministic samples, all drawn from the DB.
  const sampleMain = sampleFrom(mainLoaded, opts.samples, mulberry32(opts.seed ^ 0x10c1));
  const sampleMainSet = new Set(sampleMain);

  // ---- scan the sources -----------------------------------------------------

  // Loinc.csv
  const srcMainCodes = new Set();
  const srcStatusByCode = new Map(); // code -> raw STATUS
  const srcSampleRows = new Map(); // sampled code -> row fields we assert on
  let loincDataRows = 0;
  let loincEmptyCodeRows = 0;
  for await (const row of csvRows(SRC.loinc)) {
    loincDataRows += 1;
    const code = t(row.LOINC_NUM);
    if (!code) {
      loincEmptyCodeRows += 1;
      continue;
    }
    srcMainCodes.add(code);
    srcStatusByCode.set(code, t(row.STATUS));
    if (sampleMainSet.has(code)) {
      srcSampleRows.set(code, {
        status: t(row.STATUS),
        longCommonName: t(row.LONG_COMMON_NAME),
        displayName: t(row.DisplayName),
        shortName: t(row.SHORTNAME),
        classType: t(row.CLASSTYPE),
        unitsRequired: t(row.UNITSREQUIRED),
      });
    }
  }

  // Part.csv
  const srcPartCodes = new Set();
  const srcPartStatus = new Map();
  for await (const row of csvRows(SRC.part)) {
    const code = t(row.PartNumber);
    if (!code) continue;
    srcPartCodes.add(code);
    if (!srcPartStatus.has(code)) srcPartStatus.set(code, t(row.Status));
  }

  // AnswerList.csv
  const srcListCodes = new Set();
  const srcAnswerCodes = new Set();
  const srcAnswersByList = new Map(); // listId -> Set(answerId)
  const srcAnswerRowsByList = new Map(); // listId -> [{answerId, seq, idx}] (for sequence-order check)
  let answerRowIdx = 0;
  for await (const row of csvRows(SRC.answerList)) {
    const listId = t(row.AnswerListId);
    const answerId = t(row.AnswerStringId);
    if (listId) srcListCodes.add(listId);
    if (answerId) srcAnswerCodes.add(answerId);
    if (listId && answerId) {
      let set = srcAnswersByList.get(listId);
      if (!set) {
        set = new Set();
        srcAnswersByList.set(listId, set);
        srcAnswerRowsByList.set(listId, []);
      }
      if (!set.has(answerId)) {
        const seqRaw = t(row.SequenceNumber);
        const seq = seqRaw === '' || Number.isNaN(Number(seqRaw)) ? null : Number(seqRaw);
        srcAnswerRowsByList.get(listId).push({ answerId, seq, idx: answerRowIdx });
      }
      set.add(answerId);
      answerRowIdx += 1;
    }
  }
  // Authoritative member order: SequenceNumber ascending (nulls last), file
  // order as tiebreak. Member order is semantic (tier-1 in the ordering
  // contract) — the DB must reproduce it via member_id order.
  const srcAnswerOrderByList = new Map();
  for (const [listId, rows] of srcAnswerRowsByList) {
    const sorted = rows.slice().sort((a, b) => {
      if (a.seq === null && b.seq === null) return a.idx - b.idx;
      if (a.seq === null) return 1;
      if (b.seq === null) return -1;
      return a.seq - b.seq || a.idx - b.idx;
    });
    srcAnswerOrderByList.set(listId, sorted.map((r) => r.answerId));
  }

  // ComponentHierarchyBySystem.csv: child (CODE) -> parent (IMMEDIATE_PARENT).
  const hierNodes = new Set();
  const childrenByParent = new Map(); // parent -> Set(child)
  let hierEdges = 0;
  let hierSelfEdges = 0;
  for await (const row of csvRows(SRC.hierarchy)) {
    const child = t(row.CODE);
    const parent = t(row.IMMEDIATE_PARENT);
    if (child) hierNodes.add(child);
    if (parent) hierNodes.add(parent);
    if (!child || !parent) continue;
    if (child === parent) {
      hierSelfEdges += 1;
      continue;
    }
    let kids = childrenByParent.get(parent);
    if (!kids) {
      kids = new Set();
      childrenByParent.set(parent, kids);
    }
    kids.add(child);
    hierEdges += 1;
  }

  // The expected concept universe: everything the importer declares it loads.
  const expectedAll = new Set([
    ...srcMainCodes,
    ...srcPartCodes,
    ...srcListCodes,
    ...srcAnswerCodes,
    ...hierNodes,
  ]);

  // ---- checks ---------------------------------------------------------------

  await check('1. concept universe: DB concepts vs Loinc.csv/Part.csv/AnswerList.csv/hierarchy', () => {
    const lines = [];
    let pass = true;

    // No DB concept may fall outside the source universe -- exact in both modes.
    const alien = [];
    for (const code of dbConcepts.keys()) {
      if (!expectedAll.has(code)) alien.push(code);
    }
    if (alien.length > 0) {
      pass = false;
      lines.push(`DB has ${alien.length} concept(s) not in any source file: ${firstFew(alien).join(', ')}`);
    }

    lines.push(`Loinc.csv data rows (own quoted-CSV counter): ${loincDataRows}` +
      (loincEmptyCodeRows ? ` (${loincEmptyCodeRows} with empty LOINC_NUM)` : ''));

    // Per code-shape class comparison.
    const expByClass = { main: new Set(), part: new Set(), answer: new Set(), list: new Set(), other: new Set() };
    for (const code of expectedAll) expByClass[codeClass(code)].add(code);
    const dbByClass = { main: new Set(), part: new Set(), answer: new Set(), list: new Set(), other: new Set() };
    for (const code of dbConcepts.keys()) dbByClass[codeClass(code)].add(code);

    for (const cls of ['main', 'part', 'answer', 'list', 'other']) {
      const exp = expByClass[cls];
      const got = dbByClass[cls];
      // Only the main class is capped by --max-rows; parts, answers, lists and
      // hierarchy nodes are always fully loaded by the importer.
      const relaxed = opts.allowCapped && cls === 'main';
      if (relaxed) {
        const ok = got.size <= exp.size;
        if (!ok) pass = false;
        lines.push(`class ${cls}: db=${got.size} <= source=${exp.size} (capped) ${ok ? 'ok' : 'VIOLATION'}`);
      } else {
        const missing = [...exp].filter((c) => !got.has(c));
        const ok = got.size === exp.size && missing.length === 0;
        if (!ok) pass = false;
        lines.push(`class ${cls}: db=${got.size} expected=${exp.size}` +
          (missing.length ? ` missing e.g. ${firstFew(missing).join(', ')}` : ''));
      }
    }

    // Main-code count against the Loinc.csv row count specifically.
    if (!opts.allowCapped) {
      const ok = dbByClass.main.size === srcMainCodes.size
        && srcMainCodes.size === loincDataRows - loincEmptyCodeRows;
      if (!ok) pass = false;
      lines.push(`main concepts ${dbByClass.main.size} vs distinct LOINC_NUM ${srcMainCodes.size} vs data rows ${loincDataRows}`);
    }
    return { pass, lines };
  });

  await check('2. active mapping: STATUS != DISCOURAGED <=> concept.active=1 (main codes)', () => {
    const lines = [];
    let pass = true;

    // Per-STATUS breakdown from the source (report material).
    const breakdown = new Map();
    for (const code of srcMainCodes) {
      const s = (srcStatusByCode.get(code) || '').toUpperCase() || '(empty)';
      breakdown.set(s, (breakdown.get(s) || 0) + 1);
    }
    const unknownStatuses = [...breakdown.keys()].filter(
      (s) => s !== '(empty)' && !LOINC_STATUS_VOCAB.has(s)
    );

    // Exact per-code comparison over every main code the DB loaded from
    // Loinc.csv (exact in capped mode too).
    let mismatches = 0;
    const examples = [];
    for (const code of mainLoaded) {
      const raw = srcStatusByCode.get(code);
      if (raw === undefined) continue; // covered by check 1 (alien concept)
      const exp = expectedActive(raw, 'ACTIVE') ? 1 : 0;
      const got = dbConcepts.get(code)?.active;
      if (got !== exp) {
        mismatches += 1;
        if (examples.length < 8) examples.push(`${code}: STATUS='${raw}' expected active=${exp} got ${got}`);
      }
    }
    if (mismatches > 0) {
      pass = false;
      lines.push(`${mismatches} per-code active mismatches: ${examples.join('; ')}`);
    } else {
      lines.push(`per-code active flags match for all ${mainLoaded.size} loaded main codes`);
    }

    if (!opts.allowCapped) {
      let expActive = 0;
      for (const code of srcMainCodes) if (expectedActive(srcStatusByCode.get(code), 'ACTIVE')) expActive += 1;
      let dbActive = 0;
      for (const [code, c] of dbConcepts) if (RE_MAIN.test(code) && c.active === 1) dbActive += 1;
      const ok = expActive === dbActive;
      if (!ok) pass = false;
      lines.push(`active=1 main concepts: db=${dbActive} expected=${expActive}`);
      if (!ok || unknownStatuses.length > 0) {
        lines.push(`source STATUS breakdown: ${[...breakdown.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
    }
    if (unknownStatuses.length > 0) {
      lines.push(`NOTE: STATUS values outside the declared vocabulary (importer falls back to ACTIVE): ${unknownStatuses.join(', ')}`);
    }
    return { pass, lines };
  });

  await check(`3. sampled main codes (${sampleMain.length}): display / CLASSTYPE / UNITSREQUIRED / STATUS`, () => {
    const lines = [];
    let pass = true;
    let okCount = 0;
    for (const code of sampleMain) {
      const src = srcSampleRows.get(code);
      const dbc = dbConcepts.get(code);
      if (!src || !dbc) {
        pass = false;
        lines.push(`${code}: missing in ${!src ? 'source' : 'db'}`);
        continue;
      }
      const problems = [];

      const expDisplay = src.longCommonName || src.displayName || src.shortName || code;
      if (dbc.display !== expDisplay) {
        problems.push(`display expected '${expDisplay}' got '${dbc.display}'`);
      }

      const lits = literalsForConcept.all(dbc.id);
      const byProp = new Map();
      for (const l of lits) {
        if (!byProp.has(l.prop)) byProp.set(l.prop, []);
        byProp.get(l.prop).push(l);
      }

      // CLASSTYPE / UNITSREQUIRED are string properties (reference emits '1',
      // 'Y', ... as valueString), stored in value_text/value_raw.
      const litStr = (l) => (l.value_text != null ? l.value_text : l.value_raw);
      const classType = byProp.get('CLASSTYPE') || [];
      if (src.classType) {
        if (classType.length !== 1 || String(litStr(classType[0])) !== String(src.classType)) {
          problems.push(`CLASSTYPE expected '${src.classType}' got ${JSON.stringify(classType.map(litStr))}`);
        }
      } else if (classType.length !== 0) {
        problems.push(`CLASSTYPE literal present but source empty`);
      }

      const unitsReq = byProp.get('UNITSREQUIRED') || [];
      if (src.unitsRequired) {
        if (unitsReq.length !== 1 || String(litStr(unitsReq[0])) !== String(src.unitsRequired)) {
          problems.push(`UNITSREQUIRED expected '${src.unitsRequired}' got ${JSON.stringify(unitsReq.map(litStr))}`);
        }
      } else if (unitsReq.length !== 0) {
        problems.push(`UNITSREQUIRED literal present but source empty`);
      }

      const status = byProp.get('STATUS') || [];
      const expStatus = expectedStatusLiteral(src.status, 'ACTIVE');
      if (status.length !== 1 || status[0].value_text !== expStatus) {
        problems.push(`STATUS expected '${expStatus}' got ${JSON.stringify(status.map((l) => l.value_text))}`);
      }

      if (problems.length > 0) {
        pass = false;
        lines.push(`${code}: ${problems.join('; ')}`);
      } else {
        okCount += 1;
      }
    }
    lines.push(`${okCount}/${sampleMain.length} sampled codes fully consistent`);
    return { pass, lines };
  });

  await check(`4. hierarchy closure: BFS over IMMEDIATE_PARENT edges vs closure table`, () => {
    const lines = [];
    let pass = true;

    const selfRows = db.prepare(`SELECT COUNT(*) AS n FROM closure WHERE ancestor_id = descendant_id`).get().n;
    if (selfRows !== 0) {
      pass = false;
      lines.push(`closure has ${selfRows} self-rows (expected 0)`);
    } else {
      lines.push('closure self-rows: 0');
    }
    if (hierSelfEdges > 0) lines.push(`NOTE: source has ${hierSelfEdges} self-edges (child==parent), skipped`);

    // Sample interior nodes (codes that appear as IMMEDIATE_PARENT).
    const parents = [...childrenByParent.keys()].filter((c) => dbConcepts.has(c));
    const sampled = sampleFrom(parents, opts.samples, mulberry32(opts.seed ^ 0x44e5));
    let okCount = 0;
    for (const code of sampled) {
      // Own BFS: all codes reachable downward from `code`.
      const expected = new Set();
      const queue = [code];
      while (queue.length > 0) {
        const cur = queue.pop();
        const kids = childrenByParent.get(cur);
        if (!kids) continue;
        for (const kid of kids) {
          if (kid === code) continue; // a cycle back to the root is not a descendant of itself
          if (!expected.has(kid)) {
            expected.add(kid);
            queue.push(kid);
          }
        }
      }
      const got = new Set(closureDescendants.all(dbConcepts.get(code).id).map((r) => r.code));
      if (got.size !== expected.size
        || [...expected].some((c) => !got.has(c))) {
        pass = false;
        const missing = firstFew([...expected].filter((c) => !got.has(c)));
        const extra = firstFew([...got].filter((c) => !expected.has(c)));
        lines.push(`${code}: expected ${expected.size} descendants, got ${got.size}` +
          (missing.length ? `; missing e.g. ${missing.join(', ')}` : '') +
          (extra.length ? `; extra e.g. ${extra.join(', ')}` : ''));
      } else {
        okCount += 1;
      }
    }
    lines.push(`${okCount}/${sampled.length} sampled ancestors: descendant sets exactly equal (edges parsed: ${hierEdges})`);
    return { pass, lines };
  });

  await check('5. answer lists: AnswerList.csv membership vs value_set_member (url http://loinc.org/vs/{id})', () => {
    const lines = [];
    let pass = true;

    const vsRows = db
      .prepare(`SELECT vs_id, url FROM value_set WHERE cs_id = ? AND url LIKE 'http://loinc.org/vs/%'`)
      .all(csId);
    const vsByList = new Map();
    for (const row of vsRows) vsByList.set(row.url.slice('http://loinc.org/vs/'.length), row.vs_id);

    // Answer lists / answers are never capped, so totals are exact in both modes.
    const expLists = srcAnswersByList.size;
    if (vsByList.size !== expLists) {
      pass = false;
      lines.push(`value_set count: db=${vsByList.size} expected=${expLists} (lists with >=1 answer member)`);
    } else {
      lines.push(`value_set count: ${vsByList.size} (matches lists with >=1 answer member)`);
    }

    const memberStmt = db.prepare(
      `SELECT c.code AS code FROM value_set_member m JOIN concept c ON c.concept_id = m.concept_id WHERE m.vs_id = ? ORDER BY m.member_id`
    );
    const sampled = sampleFrom(vsByList.keys(), opts.samples, mulberry32(opts.seed ^ 0x0a15));
    let okCount = 0;
    let orderOk = 0;
    for (const listId of sampled) {
      const expected = srcAnswersByList.get(listId) || new Set();
      const gotOrdered = memberStmt.all(vsByList.get(listId)).map((r) => r.code);
      const got = new Set(gotOrdered);
      if (got.size !== expected.size || [...expected].some((c) => !got.has(c))) {
        pass = false;
        lines.push(`${listId}: expected ${expected.size} members, got ${got.size}` +
          `; missing e.g. ${firstFew([...expected].filter((c) => !got.has(c))).join(', ') || '-'}` +
          `; extra e.g. ${firstFew([...got].filter((c) => !expected.has(c))).join(', ') || '-'}`);
        continue;
      }
      okCount += 1;
      // Tier-1 ordering: DB member_id order must equal SequenceNumber order.
      const expectedOrder = srcAnswerOrderByList.get(listId) || [];
      const mismatchAt = expectedOrder.findIndex((c, i) => gotOrdered[i] !== c);
      if (mismatchAt !== -1) {
        pass = false;
        lines.push(`${listId}: member ORDER mismatch at index ${mismatchAt}: ` +
          `expected ${expectedOrder[mismatchAt]}, got ${gotOrdered[mismatchAt]}`);
      } else {
        orderOk += 1;
      }
    }
    lines.push(`${okCount}/${sampled.length} sampled answer lists: member sets exactly equal`);
    lines.push(`${orderOk}/${sampled.length} sampled answer lists: SequenceNumber order preserved`);
    return { pass, lines };
  });

  await check('6. designation spot-check: SHORTNAME designations for sampled main codes', () => {
    const lines = [];
    let pass = true;
    let withShort = 0;
    let okCount = 0;
    for (const code of sampleMain) {
      const src = srcSampleRows.get(code);
      if (!src || !src.shortName) continue;
      withShort += 1;
      const dbc = dbConcepts.get(code);
      const n = designationCount.get(dbc.id, 'SHORTNAME', src.shortName).n;
      if (n < 1) {
        pass = false;
        lines.push(`${code}: no designation use_code=SHORTNAME term='${src.shortName}'`);
      } else {
        okCount += 1;
      }
    }
    lines.push(`${okCount}/${withShort} sampled codes with a SHORTNAME have the matching designation`);
    if (withShort === 0) lines.push('NOTE: no sampled code had a SHORTNAME; increase --samples for coverage');
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
