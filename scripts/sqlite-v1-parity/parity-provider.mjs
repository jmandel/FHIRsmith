#!/usr/bin/env node
/* eslint-disable */
'use strict';

// Differential parity harness: OLD terminology providers vs NEW generic
// sqlite-v1 provider. REPORTS divergences precisely; never adjudicates.
//
// Usage:
//   node scripts/sqlite-v1-parity/parity-provider.mjs --pair rxnorm|loinc \
//        [--samples 40] [--seed 42] [--json /tmp/out.json]
//
// See README.md for normalization rules and how to read output.

import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);

// --- repo modules -----------------------------------------------------------
const { LanguageDefinitions } = require(path.join(REPO, 'library/languages'));
const { I18nSupport } = require(path.join(REPO, 'library/i18nsupport'));
const { OperationContext } = require(path.join(REPO, 'tx/operation-context'));
const { Designations, SearchFilterText } = require(path.join(REPO, 'tx/library/designations'));

const { RxNormServicesFactory } = require(path.join(REPO, 'tx/cs/cs-rxnorm'));
const { LoincServicesFactory } = require(path.join(REPO, 'tx/cs/cs-loinc'));
const { SqliteCodeSystemFactory } = require(path.join(REPO, 'tx/cs/cs-sqlite'));

const Database = require('better-sqlite3');

// --- DB paths ---------------------------------------------------------------
const HOME = process.env.HOME;
const DBS = {
  rxnorm: {
    old: path.join(HOME, 'work/tx-dbs/rxnorm-old.db'),
    new: path.join(HOME, 'work/tx-dbs/rxnorm-v1.db'),
  },
  loinc: {
    old: path.join(HOME, 'work/tx-dbs/loinc-old.db'),
    new: path.join(HOME, 'work/tx-dbs/loinc-v1.db'),
  },
};

// --- CLI --------------------------------------------------------------------
function parseArgs(argv) {
  const a = { pair: null, samples: 40, seed: 42, json: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--pair') a.pair = argv[++i];
    else if (t === '--samples') a.samples = parseInt(argv[++i], 10);
    else if (t === '--seed') a.seed = parseInt(argv[++i], 10);
    else if (t === '--json') a.json = argv[++i];
    else throw new Error('Unknown arg: ' + t);
  }
  if (!['rxnorm', 'loinc'].includes(a.pair)) {
    throw new Error('--pair must be rxnorm or loinc');
  }
  return a;
}

// deterministic PRNG (mulberry32)
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILTER_TIMEOUT_MS = 120000;

// --- outcome helpers --------------------------------------------------------
// Outcome: EXACT | NORM | DIVERGENT | TIMEOUT | ERROR | SKIP
function firstStackLine(e) {
  const s = (e && e.stack) ? String(e.stack) : String(e);
  return s.split('\n')[0];
}

function trimStr(v) {
  return (typeof v === 'string') ? v.trim() : v;
}

// numeric-aware scalar equality (numbers vs numeric strings compare as numbers)
function scalarEqual(a, b) {
  if (a === b) return true;
  const ta = trimStr(a), tb = trimStr(b);
  if (ta === tb) return true;
  // numeric compare
  const na = Number(ta), nb = Number(tb);
  if (ta !== '' && tb !== '' && ta != null && tb != null &&
      !Number.isNaN(na) && !Number.isNaN(nb) &&
      String(ta).trim() !== '' && String(tb).trim() !== '') {
    if (na === nb) return true;
  }
  // boolean Y/true
  const boolMap = (x) => (x === true || x === 'Y' || x === 'true' || x === '1') ? true
                        : (x === false || x === 'N' || x === 'false' || x === '0') ? false : undefined;
  const ba = boolMap(ta), bb = boolMap(tb);
  if (ba !== undefined && bb !== undefined && ba === bb) return true;
  return false;
}

// Compares two scalar values, returns { outcome, note }
function compareScalar(oldV, newV, label) {
  if (oldV === undefined && newV === undefined) return { outcome: 'EXACT' };
  if (oldV === newV) return { outcome: 'EXACT' };
  const to = trimStr(oldV), tn = trimStr(newV);
  if (to === tn) {
    return { outcome: 'NORM', rule: 'trim', old: oldV, new: newV };
  }
  if (scalarEqual(oldV, newV)) {
    return { outcome: 'NORM', rule: 'numeric/boolean-normalize', old: oldV, new: newV };
  }
  return { outcome: 'DIVERGENT', old: oldV, new: newV, label };
}

// --- set comparison ---------------------------------------------------------
function sha256Sorted(arr) {
  const h = crypto.createHash('sha256');
  h.update(arr.slice().sort().join('\n'));
  return h.digest('hex');
}

function compareCodeSets(oldSet, newSet) {
  const o = new Set(oldSet);
  const n = new Set(newSet);
  const onlyOld = [];
  const onlyNew = [];
  for (const c of o) if (!n.has(c)) onlyOld.push(c);
  for (const c of n) if (!o.has(c)) onlyNew.push(c);
  const total = o.size + n.size;
  const result = {
    sizeOld: o.size,
    sizeNew: n.size,
    onlyOldCount: onlyOld.length,
    onlyNewCount: onlyNew.length,
  };
  if (total > 200000) {
    result.shaOld = sha256Sorted([...o]);
    result.shaNew = sha256Sorted([...n]);
  }
  if (onlyOld.length === 0 && onlyNew.length === 0) {
    result.outcome = 'EXACT';
  } else {
    result.outcome = 'DIVERGENT';
    result.onlyOldSamples = onlyOld.slice(0, 10);
    result.onlyNewSamples = onlyNew.slice(0, 10);
  }
  return result;
}

// --- multiset comparison for designations ----------------------------------
function multisetDiff(oldArr, newArr) {
  const count = (arr) => {
    const m = new Map();
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
    return m;
  };
  const mo = count(oldArr), mn = count(newArr);
  const onlyOld = [], onlyNew = [];
  for (const [k, c] of mo) {
    const cn = mn.get(k) || 0;
    if (c > cn) for (let i = 0; i < c - cn; i++) onlyOld.push(k);
  }
  for (const [k, c] of mn) {
    const co = mo.get(k) || 0;
    if (c > co) for (let i = 0; i < c - co; i++) onlyNew.push(k);
  }
  return { onlyOld, onlyNew };
}

// wrap corpus item so one crash doesn't kill the run
async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    return { outcome: 'ERROR', error: firstStackLine(e) };
  }
}

// run with wall-clock timeout (best-effort; the underlying op is not cancelled,
// but we record TIMEOUT and move on)
async function withTimeout(ms, fn, label) {
  let timer;
  const to = new Promise((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error('TIMEOUT:' + label), { __timeout: true })), ms);
  });
  try {
    return await Promise.race([fn(), to]);
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Filter protocol driver (OLD provider): getPrepContext(true) -> filter/searchFilter
//   -> executeFilters -> iterate ALL sets[0] via filterMore/filterConcept -> code()
// Returns { codes: string[] } or throws (timeout bubbles as __timeout).
async function runFilterCollectCodes(cs, applyFilters) {
  const prep = await cs.getPrepContext(true);
  await applyFilters(cs, prep);
  const sets = await cs.executeFilters(prep);
  const codes = [];
  if (sets && sets.length > 0) {
    const set = sets[0];
    // filterMore advances then reports; both old providers use
    //   while (filterMore) { filterConcept }
    // rxnorm: filterMore returns cursor < len (starts 0), filterConcept reads & increments
    // loinc: same pattern with keys
    // sqlite: cursor starts -1; filterMore increments then checks
    while (await cs.filterMore(prep, set)) {
      const ctx = await cs.filterConcept(prep, set);
      if (ctx == null) break;
      const code = await cs.code(ctx);
      if (code != null) codes.push(String(code));
    }
  }
  if (cs.filterFinish) await cs.filterFinish(prep);
  return { codes };
}

// Collect designations as multiset of (language, use_code, term)
async function collectDesignations(cs, langDefs, code) {
  const d = new Designations(langDefs);
  const located = await cs.locate(code);
  if (!located.context) return null;
  await cs.designations(located.context, d);
  const out = [];
  for (const des of d.designations) {
    const lang = des.language ? des.language.code : null;
    const useCode = des.use ? (des.use.code || null) : null;
    const term = trimStr(des.value);
    out.push(JSON.stringify([lang, useCode, term]));
  }
  return out;
}

// map old->new use-code (discovered): DISPLAY use is normalized identically by
// Designations.addDesignation (both call makeUseForDisplay -> preferredForLanguage).
// The only mapping we apply for the "mapped" comparison collapses the DISPLAY
// use coding to the token 'DISPLAY' and drops language region on both sides.
function mapDesignationTuple(tupleJson) {
  const [lang, useCode, term] = JSON.parse(tupleJson);
  const useNorm = (useCode === 'preferredForLanguage') ? 'DISPLAY' : useCode;
  const langNorm = lang ? String(lang).split('-')[0].toLowerCase() : null;
  return JSON.stringify([langNorm, useNorm, term]);
}

// properties() normalized to { code: sorted [stringified primitive values] }
function normalizeProperties(props) {
  const map = {};
  for (const p of props || []) {
    let val;
    if ('valueCoding' in p) val = p.valueCoding.code;
    else if ('valueCode' in p) val = p.valueCode;
    else if ('valueInteger' in p) val = p.valueInteger;
    else if ('valueDecimal' in p) val = p.valueDecimal;
    else if ('valueBoolean' in p) val = p.valueBoolean;
    else if ('valueDateTime' in p) val = p.valueDateTime;
    else if ('valueString' in p) val = p.valueString;
    else {
      // unknown shape: take first value* field
      const k = Object.keys(p).find((x) => x.startsWith('value'));
      val = k ? p[k] : undefined;
    }
    if (!map[p.code]) map[p.code] = [];
    map[p.code].push(String(trimStr(val)));
  }
  for (const k of Object.keys(map)) map[k].sort();
  return map;
}

// compare normalized property maps: CODE SETS raw; per-code values numeric-aware
function comparePropertyMaps(oldMap, newMap) {
  const oldCodes = new Set(Object.keys(oldMap));
  const newCodes = new Set(Object.keys(newMap));
  const codesOnlyOld = [...oldCodes].filter((c) => !newCodes.has(c));
  const codesOnlyNew = [...newCodes].filter((c) => !oldCodes.has(c));
  const valueDivergences = [];
  for (const c of oldCodes) {
    if (!newCodes.has(c)) continue;
    const ov = oldMap[c], nv = newMap[c];
    // multiset numeric-aware compare
    if (ov.length !== nv.length || !ov.every((x, i) => scalarEqual(x, nv[i]))) {
      // try order-insensitive with scalarEqual matching
      const md = multisetDiff(ov, nv);
      const stillOld = md.onlyOld.filter((x) => !md.onlyNew.some((y) => scalarEqual(x, y)));
      const stillNew = md.onlyNew.filter((x) => !md.onlyOld.some((y) => scalarEqual(x, y)));
      if (stillOld.length || stillNew.length) {
        valueDivergences.push({ code: c, onlyOld: stillOld.slice(0, 5), onlyNew: stillNew.slice(0, 5) });
      }
    }
  }
  return { codesOnlyOld, codesOnlyNew, valueDivergences };
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pairName = args.pair;
  const dbPaths = DBS[pairName];

  // boot i18n / langDefs
  const langDefs = await LanguageDefinitions.fromFiles(path.join(REPO, 'tx/data'));
  const i18n = new I18nSupport(path.join(REPO, 'translations'), langDefs);
  await i18n.load();

  const freshOpContext = () => new OperationContext('en', i18n, null, 3600);

  // --- boot factories -------------------------------------------------------
  let oldFactory, newFactory;
  if (pairName === 'rxnorm') {
    oldFactory = new RxNormServicesFactory(i18n, dbPaths.old);
  } else {
    oldFactory = new LoincServicesFactory(i18n, dbPaths.old);
  }
  newFactory = new SqliteCodeSystemFactory(i18n, dbPaths.new);

  await oldFactory.load();
  await newFactory.load();

  const oldCS = await oldFactory.build(freshOpContext(), []);
  const newCS = await newFactory.build(freshOpContext(), []);

  const report = {
    pair: pairName,
    dbs: dbPaths,
    generatedAt: new Date().toISOString(),
    samples: args.samples,
    seed: args.seed,
    sections: {},
  };

  // -------------------------------------------------------------------------
  // SECTION A: Metadata
  // -------------------------------------------------------------------------
  report.sections.A_metadata = await safe(async () => {
    const items = {};
    items.system = compareScalar(oldCS.system(), newCS.system(), 'system');
    items.version = compareScalar(oldCS.version(), newCS.version(), 'version');
    items.totalCount = compareScalar(await oldCS.totalCount(), await newCS.totalCount(), 'totalCount');
    items.hasParents = compareScalar(oldCS.hasParents(), newCS.hasParents(), 'hasParents');
    items.isCaseSensitive = compareScalar(oldCS.isCaseSensitive(), newCS.isCaseSensitive(), 'isCaseSensitive');
    items.defLang = compareScalar(oldCS.defLang(), newCS.defLang(), 'defLang');

    // propertyDefinitions -> compare sets of property codes
    const oldDefs = oldCS.propertyDefinitions() || [];
    const newDefs = newCS.propertyDefinitions() || [];
    const oldCodes = oldDefs.map((d) => d.code);
    const newCodes = newDefs.map((d) => d.code);
    const setCmp = compareCodeSets(oldCodes, newCodes);
    items.propertyDefinitions = {
      outcome: setCmp.outcome,
      onlyOld: [...new Set(oldCodes)].filter((c) => !new Set(newCodes).has(c)),
      onlyNew: [...new Set(newCodes)].filter((c) => !new Set(oldCodes).has(c)),
    };
    return items;
  });

  // -------------------------------------------------------------------------
  // SECTION B: Sampled concepts
  // -------------------------------------------------------------------------
  // Sample N codes seeded from NEW db concept table + hand-picked well-known codes.
  const handPicked = pairName === 'rxnorm'
    ? ['1191', '197361', '105078', '311036', '860975']
    : ['2160-0', '718-7', 'LP14082-9', 'LA6115-9', 'LL1162-8'];

  const sampled = await safe(async () => {
    const db = new Database(dbPaths.new, { readonly: true });
    const csRow = db.prepare('SELECT cs_id FROM code_system ORDER BY cs_id LIMIT 1').get();
    const rows = db.prepare('SELECT code FROM concept WHERE cs_id = ? ORDER BY concept_id').all(csRow.cs_id);
    db.close();
    const rand = mulberry32(args.seed);
    const picks = new Set();
    const n = Math.min(args.samples, rows.length);
    let guard = 0;
    while (picks.size < n && guard < n * 50) {
      picks.add(rows[Math.floor(rand() * rows.length)].code);
      guard++;
    }
    return [...picks];
  });

  const sampleCodes = Array.isArray(sampled) ? [...new Set([...handPicked, ...sampled])] : handPicked;

  report.sections.B_concepts = await safe(async () => {
    const perCode = {};
    const aggregate = {
      hit: { EXACT: 0, DIVERGENT: 0 },
      display: { EXACT: 0, NORM: 0, DIVERGENT: 0 },
      definition: { EXACT: 0, NORM: 0, DIVERGENT: 0 },
      isInactive: { EXACT: 0, DIVERGENT: 0 },
      getStatus: { EXACT: 0, NORM: 0, DIVERGENT: 0 },
      designationsRaw: { EXACT: 0, DIVERGENT: 0 },
      designationsMapped: { EXACT: 0, DIVERGENT: 0 },
      properties: { EXACT: 0, DIVERGENT: 0 },
    };
    const divergExamples = { display: [], definition: [], getStatus: [], designations: [], properties: [], isInactive: [] };

    for (const code of sampleCodes) {
      const rec = { code, handPicked: handPicked.includes(code) };

      const oldLoc = await safe(() => oldCS.locate(code));
      const newLoc = await safe(() => newCS.locate(code));
      const oldHit = oldLoc && oldLoc.context != null;
      const newHit = newLoc && newLoc.context != null;
      rec.hit = { old: !!oldHit, new: !!newHit };
      if (!!oldHit === !!newHit) aggregate.hit.EXACT++;
      else { aggregate.hit.DIVERGENT++; rec.hit.outcome = 'DIVERGENT'; }

      if (!oldHit || !newHit) {
        // can't compare per-concept getters if one side misses
        perCode[code] = rec;
        continue;
      }
      const oc = oldLoc.context, nc = newLoc.context;

      // code()
      rec.codeVal = compareScalar(await oldCS.code(oc), await newCS.code(nc), 'code');
      // display()
      const dCmp = compareScalar(await oldCS.display(oc), await newCS.display(nc), 'display');
      aggregate.display[dCmp.outcome]++;
      if (dCmp.outcome === 'DIVERGENT' && divergExamples.display.length < 10) divergExamples.display.push({ code, old: dCmp.old, new: dCmp.new });
      rec.display = dCmp;
      // definition()
      const defCmp = compareScalar(await oldCS.definition(oc), await newCS.definition(nc), 'definition');
      aggregate.definition[defCmp.outcome]++;
      if (defCmp.outcome === 'DIVERGENT' && divergExamples.definition.length < 10) divergExamples.definition.push({ code, old: defCmp.old, new: defCmp.new });
      rec.definition = defCmp;
      // isInactive()
      const iaCmp = compareScalar(await oldCS.isInactive(oc), await newCS.isInactive(nc), 'isInactive');
      aggregate.isInactive[iaCmp.outcome === 'NORM' ? 'EXACT' : iaCmp.outcome]++;
      if (iaCmp.outcome === 'DIVERGENT' && divergExamples.isInactive.length < 10) divergExamples.isInactive.push({ code, old: iaCmp.old, new: iaCmp.new });
      rec.isInactive = iaCmp;
      // getStatus()
      const gsCmp = compareScalar(await oldCS.getStatus(oc), await newCS.getStatus(nc), 'getStatus');
      aggregate.getStatus[gsCmp.outcome]++;
      if (gsCmp.outcome === 'DIVERGENT' && divergExamples.getStatus.length < 10) divergExamples.getStatus.push({ code, old: gsCmp.old, new: gsCmp.new });
      rec.getStatus = gsCmp;

      // designations() multiset
      const oldDes = await collectDesignations(oldCS, langDefs, code);
      const newDes = await collectDesignations(newCS, langDefs, code);
      const rawDiff = multisetDiff(oldDes || [], newDes || []);
      const rawOutcome = (rawDiff.onlyOld.length === 0 && rawDiff.onlyNew.length === 0) ? 'EXACT' : 'DIVERGENT';
      aggregate.designationsRaw[rawOutcome]++;
      // mapped comparison
      const mappedDiff = multisetDiff((oldDes || []).map(mapDesignationTuple), (newDes || []).map(mapDesignationTuple));
      const mappedOutcome = (mappedDiff.onlyOld.length === 0 && mappedDiff.onlyNew.length === 0) ? 'EXACT' : 'DIVERGENT';
      aggregate.designationsMapped[mappedOutcome]++;
      rec.designations = { rawOutcome, mappedOutcome };
      if (rawOutcome === 'DIVERGENT') {
        rec.designations.rawOnlyOld = rawDiff.onlyOld.slice(0, 5).map(JSON.parse);
        rec.designations.rawOnlyNew = rawDiff.onlyNew.slice(0, 5).map(JSON.parse);
        if (mappedOutcome === 'DIVERGENT' && divergExamples.designations.length < 10) {
          divergExamples.designations.push({ code, onlyOld: mappedDiff.onlyOld.slice(0, 3).map(JSON.parse), onlyNew: mappedDiff.onlyNew.slice(0, 3).map(JSON.parse) });
        }
      }

      // properties()
      const oldProps = normalizeProperties(await oldCS.properties(oc));
      const newProps = normalizeProperties(await newCS.properties(nc));
      const pCmp = comparePropertyMaps(oldProps, newProps);
      const pOutcome = (pCmp.codesOnlyOld.length === 0 && pCmp.codesOnlyNew.length === 0 && pCmp.valueDivergences.length === 0) ? 'EXACT' : 'DIVERGENT';
      aggregate.properties[pOutcome]++;
      rec.properties = { outcome: pOutcome, codesOnlyOld: pCmp.codesOnlyOld, codesOnlyNew: pCmp.codesOnlyNew, valueDivergences: pCmp.valueDivergences.slice(0, 5) };
      if (pOutcome === 'DIVERGENT' && divergExamples.properties.length < 10) {
        divergExamples.properties.push({ code, codesOnlyOld: pCmp.codesOnlyOld, codesOnlyNew: pCmp.codesOnlyNew, valueDivergences: pCmp.valueDivergences.slice(0, 3) });
      }

      perCode[code] = rec;
    }
    return { count: sampleCodes.length, aggregate, divergExamples, perCode };
  });

  // -------------------------------------------------------------------------
  // SECTION C: Not-found behavior
  // -------------------------------------------------------------------------
  report.sections.C_notFound = await safe(async () => {
    const bogus = pairName === 'rxnorm'
      ? ['ZZZ-not-a-code', '999999999999', '__bogus__']
      : ['ZZZ-not-a-code', '999999-9', '__bogus__'];
    const out = [];
    for (const code of bogus) {
      const o = await safe(() => oldCS.locate(code));
      const n = await safe(() => newCS.locate(code));
      const oNull = o && o.context == null;
      const nNull = n && n.context == null;
      const oMsg = o && typeof o.message === 'string' && o.message.length > 0;
      const nMsg = n && typeof n.message === 'string' && n.message.length > 0;
      out.push({
        code,
        contextNull: compareScalar(oNull, nNull, 'contextNull'),
        // do NOT compare message text, only non-emptiness
        messageNonEmpty: { old: !!oMsg, new: !!nMsg, outcome: (!!oMsg === !!nMsg) ? 'EXACT' : 'DIVERGENT' },
      });
    }
    return out;
  });

  // -------------------------------------------------------------------------
  // SECTION D: Filters
  // -------------------------------------------------------------------------
  const filterSpecs = pairName === 'rxnorm'
    ? [
        { name: 'TTY=IN', apply: (cs, p) => cs.filter(p, true, 'TTY', '=', 'IN') },
        { name: 'TTY in IN,PIN', apply: (cs, p) => cs.filter(p, true, 'TTY', 'in', 'IN,PIN') },
        { name: 'STY=T121', apply: (cs, p) => cs.filter(p, true, 'STY', '=', 'T121') },
        { name: 'SAB=RXNORM', apply: (cs, p) => cs.filter(p, true, 'SAB', '=', 'RXNORM') },
        // RELA/relationship filter. OLD provider requires a CUI:/AUI: prefix
        // (see cs-rxnorm.js filter code); NEW provider treats the value as a
        // target concept code (raw CUI). Accepted-form differences ARE
        // divergences, so we probe BOTH forms against BOTH providers and the
        // reporter surfaces which form each accepts.
        { name: 'has_tradename=CUI:854979 (old-form)', apply: (cs, p) => cs.filter(p, true, 'has_tradename', '=', 'CUI:854979') },
        { name: 'has_tradename=854979 (new-form)', apply: (cs, p) => cs.filter(p, true, 'has_tradename', '=', '854979') },
        { name: "searchFilter('aspirin')", apply: (cs, p) => cs.searchFilter(p, new SearchFilterText('aspirin'), false) },
      ]
    : [
        { name: 'CLASSTYPE=1', apply: (cs, p) => cs.filter(p, true, 'CLASSTYPE', '=', '1') },
        { name: 'CLASSTYPE=Laboratory', apply: (cs, p) => cs.filter(p, true, 'CLASSTYPE', '=', 'Laboratory') },
        { name: 'STATUS=ACTIVE', apply: (cs, p) => cs.filter(p, true, 'STATUS', '=', 'ACTIVE') },
        { name: 'ORDER_OBS=Order', apply: (cs, p) => cs.filter(p, true, 'ORDER_OBS', '=', 'Order') },
        { name: 'COMPONENT=__COMP__', apply: (cs, p) => cs.filter(p, true, 'COMPONENT', '=', globalThis.__loincComp), _dynamic: true },
        { name: 'concept is-a __COMP__', apply: (cs, p) => cs.filter(p, true, 'concept', 'is-a', globalThis.__loincComp), _dynamic: true },
        { name: 'concept descendent-of __COMP__', apply: (cs, p) => cs.filter(p, true, 'concept', 'descendent-of', globalThis.__loincComp), _dynamic: true },
        { name: 'SCALE_TYP=Qn', apply: (cs, p) => cs.filter(p, true, 'SCALE_TYP', '=', 'Qn') },
        { name: "searchFilter('glucose')", apply: (cs, p) => cs.searchFilter(p, new SearchFilterText('glucose'), false) },
      ];

  // For LOINC, pick a real COMPONENT part code with decent fanout from old db.
  if (pairName === 'loinc') {
    try {
      const odb = new Database(dbPaths.old, { readonly: true });
      const row = odb.prepare(
        `SELECT c.Code as code, COUNT(*) as n
           FROM Closure cl JOIN Codes c ON c.CodeKey = cl.AncestorKey
          WHERE c.Code LIKE 'LP%'
          GROUP BY cl.AncestorKey ORDER BY n DESC LIMIT 1`
      ).get();
      odb.close();
      globalThis.__loincComp = row ? row.code : 'LP15920-4';
    } catch (e) {
      globalThis.__loincComp = 'LP15920-4';
    }
    for (const fs2 of filterSpecs) {
      if (fs2._dynamic) fs2.name = fs2.name.replace('__COMP__', globalThis.__loincComp);
    }
  }

  report.sections.D_filters = await safe(async () => {
    const out = {};
    for (const spec of filterSpecs) {
      out[spec.name] = await safe(async () => {
        // OLD
        let oldRes;
        try {
          oldRes = await withTimeout(FILTER_TIMEOUT_MS, () => runFilterCollectCodes(oldCS, spec.apply), spec.name + ':old');
        } catch (e) {
          if (e.__timeout) return { outcome: 'TIMEOUT', side: 'old' };
          return { outcome: 'ERROR', side: 'old', error: firstStackLine(e) };
        }
        // NEW
        let newRes;
        try {
          newRes = await withTimeout(FILTER_TIMEOUT_MS, () => runFilterCollectCodes(newCS, spec.apply), spec.name + ':new');
        } catch (e) {
          if (e.__timeout) return { outcome: 'TIMEOUT', side: 'new' };
          return { outcome: 'ERROR', side: 'new', error: firstStackLine(e) };
        }
        return compareCodeSets(oldRes.codes, newRes.codes);
      });
    }
    return out;
  });

  // -------------------------------------------------------------------------
  // SECTION E: Subsumption (LOINC only)
  // -------------------------------------------------------------------------
  if (pairName === 'loinc') {
    report.sections.E_subsumption = await safe(async () => {
      const odb = new Database(dbPaths.old, { readonly: true });
      // 5 (ancestor,descendant) pairs from Closure
      const closurePairs = odb.prepare(
        `SELECT a.Code as anc, d.Code as des
           FROM Closure cl
           JOIN Codes a ON a.CodeKey = cl.AncestorKey
           JOIN Codes d ON d.CodeKey = cl.DescendentKey
          WHERE cl.AncestorKey <> cl.DescendentKey
          LIMIT 5`
      ).all();
      // unrelated: pick two arbitrary codes unlikely related
      const someCodes = odb.prepare(`SELECT Code FROM Codes LIMIT 50`).all().map((r) => r.Code);
      odb.close();
      const pairs = [];
      for (const p of closurePairs) pairs.push({ a: p.anc, b: p.des, kind: 'ancestor->descendant' });
      if (someCodes.length >= 4) {
        pairs.push({ a: someCodes[0], b: someCodes[someCodes.length - 1], kind: 'unrelated?' });
        pairs.push({ a: someCodes[1], b: someCodes[someCodes.length - 2], kind: 'unrelated?' });
      }
      if (closurePairs[0]) pairs.push({ a: closurePairs[0].anc, b: closurePairs[0].anc, kind: 'equal' });

      const results = [];
      for (const p of pairs) {
        const oldR = await safe(() => oldCS.subsumesTest(p.a, p.b));
        const newR = await safe(() => newCS.subsumesTest(p.a, p.b));
        const oldVal = (oldR && oldR.outcome) ? 'ERROR:' + oldR.error : oldR;
        const newVal = (newR && newR.outcome) ? 'ERROR:' + newR.error : newR;
        results.push({
          pair: [p.a, p.b], kind: p.kind, old: oldVal, new: newVal,
          outcome: (oldVal === newVal) ? 'EXACT' : 'DIVERGENT',
        });
      }
      return results;
    });
  }

  // -------------------------------------------------------------------------
  // SECTION F: Iteration
  // -------------------------------------------------------------------------
  report.sections.F_iteration = await safe(async () => {
    const countIter = async (cs, iter, cap = 500000) => {
      if (iter && typeof iter.total === 'number') return iter.total;
      let n = 0;
      while (n < cap) {
        const c = await cs.nextContext(iter);
        if (!c) break;
        n++;
      }
      return n;
    };
    // Each side wrapped independently so one provider throwing (e.g. old
    // rxnorm iteratorAll() is 'Must override' because hasParents()==true) is
    // recorded as an ERROR value rather than crashing the section.
    const sideCount = async (cs, which) => {
      try {
        const it = which === 'all' ? await cs.iteratorAll() : await cs.iterator(null);
        return await countIter(cs, it);
      } catch (e) {
        return 'ERROR:' + firstStackLine(e);
      }
    };
    const oldTotal = await sideCount(oldCS, 'all');
    const newTotal = await sideCount(newCS, 'all');
    const oldRootCount = await sideCount(oldCS, 'root');
    const newRootCount = await sideCount(newCS, 'root');

    const mk = (o, n, label) => {
      if (typeof o === 'string' && o.startsWith('ERROR:')) return { outcome: 'ERROR', side: 'old', old: o, new: n };
      if (typeof n === 'string' && n.startsWith('ERROR:')) return { outcome: 'ERROR', side: 'new', old: o, new: n };
      return compareScalar(o, n, label);
    };
    return {
      iteratorAllTotal: mk(oldTotal, newTotal, 'iteratorAll.total'),
      rootCount: mk(oldRootCount, newRootCount, 'iterator(null) roots'),
    };
  });

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------
  try { if (oldCS.close) oldCS.close(); } catch {}
  try { if (newCS.close) newCS.close(); } catch {}
  try { if (oldFactory.close) await oldFactory.close(); } catch {}
  try { if (newFactory.close) await newFactory.close(); } catch {}

  // --- write JSON -----------------------------------------------------------
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  }

  // --- human report to stdout ----------------------------------------------
  printHuman(report);
}

// -----------------------------------------------------------------------------
function printHuman(r) {
  const L = [];
  const p = (s) => L.push(s);
  p('='.repeat(78));
  p(`PARITY REPORT: ${r.pair}   (samples=${r.samples}, seed=${r.seed})`);
  p(`OLD: ${r.dbs.old}`);
  p(`NEW: ${r.dbs.new}`);
  p(`generated: ${r.generatedAt}`);
  p('='.repeat(78));

  const S = r.sections;

  // A
  p('\n[A] METADATA');
  if (S.A_metadata && S.A_metadata.outcome === 'ERROR') { p('  ERROR: ' + S.A_metadata.error); }
  else if (S.A_metadata) {
    for (const [k, v] of Object.entries(S.A_metadata)) {
      if (k === 'propertyDefinitions') {
        p(`  propertyDefinitions: ${v.outcome}`);
        if (v.onlyOld.length) p(`    onlyOld: ${v.onlyOld.join(', ')}`);
        if (v.onlyNew.length) p(`    onlyNew: ${v.onlyNew.join(', ')}`);
      } else {
        let line = `  ${k}: ${v.outcome}`;
        if (v.outcome !== 'EXACT') line += `   old=${JSON.stringify(v.old)}  new=${JSON.stringify(v.new)}`;
        if (v.rule) line += `  [${v.rule}]`;
        p(line);
      }
    }
  }

  // B
  p('\n[B] SAMPLED CONCEPTS');
  if (S.B_concepts && S.B_concepts.outcome === 'ERROR') { p('  ERROR: ' + S.B_concepts.error); }
  else if (S.B_concepts) {
    const a = S.B_concepts.aggregate;
    p(`  count=${S.B_concepts.count}`);
    for (const [metric, counts] of Object.entries(a)) {
      const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([o, n]) => `${o}=${n}`);
      p(`    ${metric}: ${parts.join('  ')}`);
    }
    const ex = S.B_concepts.divergExamples;
    for (const [metric, arr] of Object.entries(ex)) {
      if (arr.length) {
        p(`    -- ${metric} divergence examples (up to 10) --`);
        for (const e of arr) p('       ' + JSON.stringify(e));
      }
    }
  }

  // C
  p('\n[C] NOT-FOUND BEHAVIOR');
  if (S.C_notFound && S.C_notFound.outcome === 'ERROR') { p('  ERROR: ' + S.C_notFound.error); }
  else if (S.C_notFound) {
    for (const e of S.C_notFound) {
      p(`  ${e.code}: contextNull=${e.contextNull.outcome} messageNonEmpty=${e.messageNonEmpty.outcome} (old=${e.messageNonEmpty.old} new=${e.messageNonEmpty.new})`);
    }
  }

  // D
  p('\n[D] FILTERS (code-set comparison)');
  if (S.D_filters && S.D_filters.outcome === 'ERROR') { p('  ERROR: ' + S.D_filters.error); }
  else if (S.D_filters) {
    for (const [name, res] of Object.entries(S.D_filters)) {
      let line = `  ${name}: ${res.outcome}`;
      if (res.side) line += ` (${res.side})`;
      if (res.error) line += ` ${res.error}`;
      if (res.sizeOld != null) line += `   |old|=${res.sizeOld} |new|=${res.sizeNew}`;
      if (res.outcome === 'DIVERGENT') {
        line += `  onlyOld=${res.onlyOldCount} onlyNew=${res.onlyNewCount}`;
      }
      p(line);
      if (res.outcome === 'DIVERGENT') {
        if (res.onlyOldSamples && res.onlyOldSamples.length) p(`      onlyOld e.g.: ${res.onlyOldSamples.join(', ')}`);
        if (res.onlyNewSamples && res.onlyNewSamples.length) p(`      onlyNew e.g.: ${res.onlyNewSamples.join(', ')}`);
      }
    }
  }

  // E
  if (S.E_subsumption) {
    p('\n[E] SUBSUMPTION');
    if (S.E_subsumption.outcome === 'ERROR') { p('  ERROR: ' + S.E_subsumption.error); }
    else {
      for (const e of S.E_subsumption) {
        p(`  ${e.pair[0]} vs ${e.pair[1]} (${e.kind}): ${e.outcome}  old=${e.old} new=${e.new}`);
      }
    }
  }

  // F
  p('\n[F] ITERATION');
  if (S.F_iteration && S.F_iteration.outcome === 'ERROR') { p('  ERROR: ' + S.F_iteration.error); }
  else if (S.F_iteration) {
    for (const [k, v] of Object.entries(S.F_iteration)) {
      let line = `  ${k}: ${v.outcome}`;
      if (v.outcome !== 'EXACT') line += `   old=${JSON.stringify(v.old)} new=${JSON.stringify(v.new)}`;
      p(line);
    }
  }

  p('\n' + '='.repeat(78));
  console.log(L.join('\n'));
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e);
  process.exit(1);
});
