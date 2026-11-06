'use strict';
// CodeSystem resources -> code-system blocks (docs/sqlite-v2-content-store.md section 3).
//
// Block k is one code_system row (id k) and owns the concept ids id_base+1 .. id_base+concept_count.
//
// Numbering (FHIR blocks): the concepts in main's codeMap order, which is document pre-order of the
// nested concept tree (a depth-first walk; siblings in document order). For a nested hierarchy this
// is the standard sqlite-v2 depth-first numbering; for a hierarchy declared by parent/child
// properties the document order is kept, so whole-system and property-filter results come out in
// the order main lists them. Inactive concepts are NOT moved to the end: `active` is a stored set,
// not a range, in FHIR blocks.
//
// What each concept-level question reads:
//   concept           code, display, definition, active (= not main's isInactive)
//   concept_json      the concept's own JSON without its children; `concept` (if present) is
//                     replaced by the number of children, so the tree and key order round-trip
//   concept_link      hierarchy edges ('$parent', child -> parent) exactly as main's buildMaps()
//                     derives them. group_id carries main's list order of the edge:
//                     (position among the child's parents) * 2^20 + (position among the parent's children)
//   concept_literal   declared properties, keyed by main's filter string form (_getPropertyValue)
//   designation       designations with a value (language, use, term); search_display holds the
//                     folded search texts (code, display, definition, designations) for $expand filter
//   concept_set       kinds 1-3 keyed value = block id (3 = concepts with no children);
//                     descendants; prop sets for the hierarchy (children), declared properties and
//                     the known filter properties, computed with main's own FhirCodeSystemProvider:
//                       '$notSelectable' = String(value of the notSelectable property), '$status' = getStatus(),
//                       '$inactive' / '$deprecated' = 'true' for isInactive() / isDeprecated(),
//                       '$property' = 'true' for concepts with a property array (main's not-in only
//                       selects among those)
//
// Blocks main must keep serving from memory are stored with their whole resource and no concepts,
// and cs_config 'block.<id>.mode' says why: 'supplement' (supplements are resources everywhere in
// main), or 'memory' (duplicate codes, hierarchy edges to codes the system does not define, cycles).

const { SET_KIND, serialize, descendantsFromEdges, RoaringBitmap32 } = require('../sqlite-v2/sets');
const { getValuePrimitive } = require('../../../library/utilities');

const ORD = 1048576; // 2^20
const HIER = '$parent';
const CONCEPT_PROPERTIES = 'http://hl7.org/fhir/concept-properties#';

function foldSearchText(text) {
  return String(text).normalize('NFD')
    .replace(/([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu, '$1')
    .toLowerCase();
}

/** main's cs-cs.js _getPropertyValue */
function propertyValueString(p) {
  if (p.valueCode) return p.valueCode;
  if (p.valueString) return p.valueString;
  if (p.valueInteger !== undefined) return p.valueInteger.toString();
  if (p.valueBoolean !== undefined) return p.valueBoolean.toString();
  if (p.valueDecimal !== undefined) return p.valueDecimal.toString();
  if (p.valueDateTime) return p.valueDateTime;
  if (p.valueCoding) return p.valueCoding.code || '';
  return '';
}

/** the resource without its concepts; `concept` (if present) becomes the number of top-level concepts, in place */
function withoutConcepts(json) {
  const out = {};
  for (const k of Object.keys(json)) out[k] = k === 'concept' && Array.isArray(json[k]) ? json[k].length : json[k];
  return out;
}

/** a concept's own JSON: children replaced by their count, same key order */
function ownJson(c) {
  const out = {};
  for (const k of Object.keys(c)) out[k] = k === 'concept' && Array.isArray(c[k]) ? c[k].length : c[k];
  return JSON.stringify(out);
}

function provider(cs) {
  const { FhirCodeSystemProvider } = require('../../cs/cs-cs');
  const { OperationContext } = require('../../operation-context');
  const { Languages } = require('../../../library/languages');
  const op = new OperationContext(Languages.fromAcceptLanguage('en'), null, 'import', 3600);
  return new FhirCodeSystemProvider(op, cs, []);
}

/** why this code system must stay in memory, or null */
function memoryReason(cs) {
  if (cs.jsonObj.content === 'supplement') return 'supplement';
  const all = [];
  const walk = (cl) => { for (const c of cl || []) { all.push(c); walk(c.concept); } };
  walk(cs.jsonObj.concept);
  if (all.length !== cs.codeMap.size) return 'memory'; // duplicate codes
  for (const [child, parents] of cs.childToParentsMap) {
    if (!cs.codeMap.has(child)) return 'memory';
    for (const p of parents) if (!cs.codeMap.has(p)) return 'memory';
  }
  for (const p of cs.parentToChildrenMap.keys()) if (!cs.codeMap.has(p)) return 'memory';
  // a cycle: main walks it with a visited set, the stored descendant sets cannot represent it
  const idx = new Map();
  cs.getAllCodes().forEach((c, i) => idx.set(c, i + 1));
  const ch = [], pa = [];
  for (const [c, ps] of cs.childToParentsMap) for (const p of ps) { ch.push(idx.get(c)); pa.push(idx.get(p)); }
  if (descendantsFromEdges(idx.size, Int32Array.from(ch), Int32Array.from(pa)).cyclic) return 'memory';
  return null;
}

/**
 * @param {Database} db  content file being built
 * @param {Array<{cs: CodeSystem, entry}>} codeSystems  main's CodeSystem objects, in package order
 * @returns {object} counts
 */
async function writeCodeSystemBlocks(db, codeSystems, opts = {}) {
  const log = opts.log || (() => {});
  const counts = { blocks: 0, concepts: 0, memory: 0, supplements: 0, edges: 0, literals: 0, designations: 0, sets: 0 };
  const ins = {
    cs: db.prepare(`INSERT INTO code_system (id, uri, version, name, title, description, content, concept_count, active_count,
      id_base, case_sensitive, hierarchy_meaning, resource) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    cfg: db.prepare('INSERT INTO cs_config VALUES (?, ?)'),
    prop: db.prepare('INSERT INTO property_def (code, uri, fhir_type, value_kind, is_hierarchy, display, cs_id) VALUES (?,?,?,?,?,?,?)'),
    concept: db.prepare('INSERT INTO concept VALUES (?,?,?,?,?)'),
    cjson: db.prepare('INSERT INTO concept_json VALUES (?,?,?)'),
    link: db.prepare('INSERT OR IGNORE INTO concept_link VALUES (?,?,?,?,1)'),
    lit: db.prepare('INSERT OR IGNORE INTO concept_literal VALUES (?,?,0,?,1)'),
    use: db.prepare('INSERT OR IGNORE INTO designation_use (system, code, display) VALUES (?,?,?)'),
    useId: db.prepare('SELECT use_id FROM designation_use WHERE system IS ? AND code = ?'),
    desig: db.prepare('INSERT INTO designation (concept_id, language, use_id, term, active, preferred) VALUES (?,?,?,?,1,0)'),
    fts: db.prepare('INSERT INTO search_display (rowid, term) VALUES (?, ?)'),
    set: db.prepare('INSERT INTO concept_set VALUES (?,?,?,?,?)'),
  };
  const useIds = new Map();
  const useOf = (u) => {
    if (!u || !u.code) return null;
    const k = (u.system || '') + '|' + u.code;
    if (!useIds.has(k)) {
      ins.use.run(u.system ?? null, u.code, u.display ?? null);
      useIds.set(k, ins.useId.get(u.system ?? null, u.code).use_id);
    }
    return useIds.get(k);
  };
  const putSet = (kind, pid, value, bm) => {
    if (!bm.size) return;
    ins.set.run(kind, pid, value, bm.size, serialize(bm));
    counts.sets++;
  };

  let base = 0;
  db.exec('BEGIN');
  for (const [k, { cs }] of codeSystems.entries()) {
    const id = k + 1;
    const json = cs.jsonObj;
    const reason = memoryReason(cs);
    const caseSensitive = json.caseSensitive === undefined ? null : (json.caseSensitive ? 1 : 0);
    if (reason) {
      ins.cs.run(id, json.url || '', json.version || '', json.name ?? null, json.title ?? null,
        typeof json.description === 'string' ? json.description : null, json.content || 'complete', 0, 0, base,
        caseSensitive, json.hierarchyMeaning ?? null, JSON.stringify(json));
      ins.cfg.run(`block.${id}.mode`, reason);
      counts[reason === 'supplement' ? 'supplements' : 'memory']++;
      counts.blocks++;
      continue;
    }
    const codes = cs.getAllCodes();
    const n = codes.length;
    const idOf = new Map();
    codes.forEach((c, i) => idOf.set(c, base + i + 1));

    // properties: the hierarchy, the declared ones, the known filter properties
    const pid = {};
    const addProp = (code, uri, type, kind, hier, display) => {
      const info = ins.prop.run(code, uri ?? null, type, kind, hier ? 1 : 0, display ?? null, id);
      pid[code] = Number(info.lastInsertRowid);
    };
    addProp(HIER, CONCEPT_PROPERTIES + 'parent', 'code', 'concept', true, 'hierarchy (nested concepts, parent/child properties)');
    const declared = [];
    for (const p of json.property || []) {
      if (!p.code || pid[p.code] !== undefined) continue;
      addProp(p.code, p.uri, p.type || 'string', 'literal', false, p.description);
      declared.push(p.code);
    }
    for (const kp of ['$notSelectable', '$status', '$inactive', '$deprecated', '$property']) addProp(kp, null, 'code', 'literal', false, 'computed with main\'s FhirCodeSystemProvider');

    const prov = provider(cs);
    const { FhirCodeSystemProviderContext } = require('../../cs/cs-cs');
    const nsCodes = prov.standardPropertyCodes('notSelectable', ['abstract', 'not-selectable']);
    const inactive = new RoaringBitmap32();
    const lit = new Map(); // pid -> Map(value -> [ids])
    const addLit = (p, v, cid) => {
      let m = lit.get(p);
      if (!m) lit.set(p, m = new Map());
      let l = m.get(v);
      if (!l) m.set(v, l = []);
      l.push(cid);
      ins.lit.run(cid, p, v);
      counts.literals++;
    };

    // concepts, in pre-order with their nesting parent
    let activeCount = 0;
    const visit = async (list, nestParent) => {
      for (const c of list || []) {
        const cid = idOf.get(c.code);
        const ctx = new FhirCodeSystemProviderContext(c.code, c);
        // main's own per-concept logic (all synchronous underneath its async signatures)
        const isInactive = await prov.isInactive(ctx);
        if (isInactive) inactive.add(cid); else activeCount++;
        ins.concept.run(cid, c.code, isInactive ? 0 : 1, c.display ?? null, c.definition ?? null);
        ins.cjson.run(cid, nestParent, ownJson(c));
        const texts = [foldSearchText(c.code)];
        if (c.display) texts.push(foldSearchText(c.display));
        if (c.definition) texts.push(foldSearchText(c.definition));
        for (const d of c.designation || []) {
          if (!d.value) continue;
          ins.desig.run(cid, d.language ?? null, useOf(d.use), d.value);
          texts.push(foldSearchText(d.value));
          counts.designations++;
        }
        ins.fts.run(cid, texts.join('\n'));
        for (const p of c.property || []) {
          if (declared.includes(p.code)) addLit(pid[p.code], propertyValueString(p), cid);
        }
        const ns = (c.property || []).find((p) => nsCodes.has(p.code));
        if (ns) addLit(pid.$notSelectable, String(getValuePrimitive(ns)), cid);
        const st = await prov.getStatus(ctx);
        if (st != null) addLit(pid.$status, String(st), cid);
        if (isInactive) addLit(pid.$inactive, 'true', cid);
        if (Array.isArray(c.property)) addLit(pid.$property, 'true', cid); // main's property filters only see these
        if (await prov.isDeprecated(ctx)) addLit(pid.$deprecated, 'true', cid);
        await visit(c.concept, cid);
      }
    };
    await visit(json.concept, null);

    // hierarchy edges in main's order
    const childOf = [], parentOf = [];
    const children = new Map(); // parent id -> [child ids] in main's order
    for (const [childCode, parents] of cs.childToParentsMap) {
      const c = idOf.get(childCode);
      parents.forEach((pc, pi) => {
        const p = idOf.get(pc);
        const ci = cs.parentToChildrenMap.get(pc).indexOf(childCode);
        ins.link.run(c, pid[HIER], pi * ORD + ci, p);
        childOf.push(c - base); parentOf.push(p - base);
        counts.edges++;
      });
    }
    for (const [pc, kids] of cs.parentToChildrenMap) children.set(idOf.get(pc), kids.map((x) => idOf.get(x)));

    const { desc } = descendantsFromEdges(n, Int32Array.from(childOf), Int32Array.from(parentOf));

    ins.cs.run(id, json.url || '', json.version || '', json.name ?? null, json.title ?? null,
      typeof json.description === 'string' ? json.description : null, json.content || 'complete', n, activeCount, base,
      caseSensitive, json.hierarchyMeaning ?? null, JSON.stringify(withoutConcepts(json)));
    ins.cfg.run(`block.${id}.mode`, 'stored');

    // sets
    const all = new RoaringBitmap32();
    if (n) all.addRange(base + 1, base + n + 1);
    putSet(SET_KIND.all, 0, id, all);
    putSet(SET_KIND.active, 0, id, RoaringBitmap32.andNot(all, inactive));
    const parentsSet = new RoaringBitmap32([...children.keys()]);
    putSet(SET_KIND.leaf, 0, id, RoaringBitmap32.andNot(all, parentsSet));
    for (let i = 1; i <= n; i++) {
      if (!desc[i]) continue;
      const shifted = new RoaringBitmap32(Array.from(desc[i].toUint32Array(), (x) => x + base));
      putSet(SET_KIND.descendants, 0, base + i, shifted);
    }
    const hasChild = new RoaringBitmap32();
    for (const [p, kids] of children) { const b = new RoaringBitmap32(kids); putSet(SET_KIND.prop, pid[HIER], p, b); hasChild.orInPlace(b); }
    putSet(SET_KIND.hasProp, pid[HIER], 0, hasChild);
    for (const [p, m] of lit) {
      const has = new RoaringBitmap32();
      for (const [v, ids] of m) { const b = new RoaringBitmap32(ids); putSet(SET_KIND.prop, p, v, b); has.orInPlace(b); }
      putSet(SET_KIND.hasProp, p, 0, has);
    }
    counts.blocks++;
    counts.concepts += n;
    base += n;
  }
  db.exec('COMMIT');
  // case-insensitive code systems: main looks codes up lower-cased (codeMapNC)
  db.exec('CREATE INDEX IF NOT EXISTS concept_code_lower ON concept(lower(code))');
  log(`code-system blocks: ${JSON.stringify(counts)}`);
  return counts;
}

module.exports = { writeCodeSystemBlocks, propertyValueString, foldSearchText, HIER, ORD, CONCEPT_PROPERTIES };
