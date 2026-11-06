'use strict';
// Per-system filter rules on top of the generic compiler (compile.js), matching what the
// upstream providers (cs-loinc.js, cs-rxnorm.js, cs-snomed.js) accept and report.

const { FilterError, Unsupported, splitList, litSets } = require('./engine/compile');
const { KIND } = require('./store');
const { requiredLiterals } = require('./engine/regex-literals');

const FSN_ID = '900000000000003001';
const SYNONYM_ID = '900000000000013009';

const LOINC = 'http://loinc.org';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const SCT = 'http://snomed.info/sct';

// ---- LOINC ---------------------------------------------------------------------------------

const loinc = {
  name: 'loinc',
  notSupported(prop, op, value) {
    return new FilterError(`The filter "${prop} ${op} ${value}" is not supported for LOINC`);
  },
  /** a relationship filter value may be the target's code or its name (Codes.Description, no case): every match */
  valuesByName(c, v) {
    const S = c.store;
    let ids = null;
    if (String(v).length >= 3) {
      try {
        ids = S.stmt('SELECT concept_id FROM concept WHERE concept_id IN (SELECT rowid FROM search_display WHERE search_display MATCH ?) AND display = ? COLLATE NOCASE AND concept_id BETWEEN ? AND ?')
          .all('"' + String(v).replace(/"/g, '""') + '"', v, S.lo, S.hi).map((r) => r.concept_id);
      } catch (e) { ids = null; }
    }
    if (!ids) ids = S.stmt('SELECT concept_id FROM concept WHERE display = ? COLLATE NOCASE AND concept_id BETWEEN ? AND ?').all(v, S.lo, S.hi).map((r) => r.concept_id);
    return ids;
  },
  searchMode: 'display',
  filter(c, prop, op, value) {
    const S = c.store;
    if (prop === 'LIST' && op === '=') {
      const id = c.id(value);
      return id == null ? { t: 'empty' } : { t: 'set', kind: KIND.refset, pid: 0, value: id };
    }
    if (prop === 'ancestor' && op === '=') {
      // implicit part value sets (http://loinc.org/vs/LP...): the codes below the part
      const id = c.id(value);
      return id == null ? { t: 'empty' } : { t: 'set', kind: KIND.descendants, pid: 0, value: id };
    }
    if (prop === 'ancestor' && op === 'in') {
      // the union over the parts (cs-loinc.js, #331)
      const m = c.ids(splitList(value));
      const ids = [...new Set([...m.values()].filter((x) => x != null))];
      if (!ids.length) return { t: 'empty' };
      const n = ids.map((id) => ({ t: 'set', kind: KIND.descendants, pid: 0, value: id }));
      return n.length === 1 ? n[0] : { t: 'or', items: n };
    }
    if (prop === 'answers-for' && op === '=') {
      const id = c.id(value);
      if (id == null) return { t: 'empty' };
      if (String(value).startsWith('LL')) return { t: 'set', kind: KIND.refset, pid: 0, value: id };
      const p = S.props.get('answers-for');
      return { t: 'refsetOf', of: { t: 'set', kind: KIND.prop, pid: p.id, value: id } };
    }
    if (prop === 'copyright' && op === '=') {
      const p = S.props.get('Copyright');
      const has = { t: 'set', kind: KIND.hasProp, pid: p ? p.id : -1, value: 0 };
      if (value === 'LOINC') return { t: 'minus', a: { t: 'all' }, b: has };
      if (value === '3rdParty') return has;
      throw loinc.notSupported(prop, op, value);
    }
    // CLASSTYPE takes the code (1-4) or its name ("Laboratory class", ...), as upstream does;
    // the generic literal rule maps names through cs_config.propertyValueDescriptions
    return null;
  }
};

// ---- RxNorm --------------------------------------------------------------------------------

const rxnorm = {
  name: 'rxnorm',
  // every upstream query is over RXNCONSO: archived (inactive) concepts are never selected
  domain: 'active',
  notSupported(prop, op, value) {
    return new FilterError(`Unknown filter "${prop} ${op} ${value}"`);
  },
  filter(c, prop, op, value) {
    const S = c.store;
    const up = String(prop).toUpperCase();
    if ((up === 'TTY' || up === 'STY' || up === 'SAB') && !S.props.has(prop)) {
      // property names are case-insensitive upstream
      return c.filter(up, op, value);
    }
    const rels = S.config.relaByRel || {};
    const isRel = !!rels[prop];
    if (isRel || (S.props.has(prop) && S.props.get(prop).kind === 'concept')) {
      // relationship values are CUI:<rxcui> (upstream); a bare RXCUI is accepted too
      const pids = isRel ? rels[prop].map((a) => S.props.get(a)).filter(Boolean).map((p) => p.id) : [S.props.get(prop).id];
      const any = (n) => (n.length === 1 ? n[0] : { t: 'or', items: n });
      if (op === 'exists') {
        const v = String(value).toLowerCase();
        if (v !== 'true' && v !== 'false') throw rxnorm.notSupported(prop, op, value);
        const n = any(pids.map((pid) => ({ t: 'set', kind: KIND.hasProp, pid, value: 0 })));
        return v === 'true' ? n : { t: 'minus', a: { t: 'all' }, b: n };
      }
      if (op !== '=' && op !== 'in' && op !== 'not-in') throw rxnorm.notSupported(prop, op, value);
      const vals = op === '=' ? [String(value)] : splitList(value);
      if (vals.some((v) => v.startsWith('AUI:'))) throw new Unsupported('rxnorm-aui');
      const m = c.ids(vals.map((v) => (v.startsWith('CUI:') ? v.substring(4) : v)));
      const ids = [...new Set([...m.values()].filter((x) => x != null))];
      const n = ids.length ? any(pids.flatMap((pid) => ids.map((id) => ({ t: 'set', kind: KIND.prop, pid, value: id })))) : { t: 'empty' };
      return op === 'not-in' ? { t: 'minus', a: { t: 'all' }, b: n } : n;
    }
    return null; // generic rules: concept/code operators, literal properties (TTY, STY, SAB, ...)
  }
};

// ---- SNOMED CT -----------------------------------------------------------------------------

function sctId(v) {
  return /^\s*\d{6,18}\s*$/.test(String(v));
}

const snomed = {
  name: 'snomed',
  searchMode: 'designation',
  generalizesExcludesSelf: true, // as cs-snomed.js filterGeneralizes(id, false)
  strictIn: true, // concept in X,Y: an unknown concept is an error (cs-snomed.js filterIn)
  notSupported(prop) {
    return new FilterError(`Unsupported filter property: ${prop}`);
  },
  /** ECL the engine refuses: evaluated by main's ECL (cs-snomed.js) over this file, as ids */
  eclFallback(c, text, e) {
    let bm;
    try {
      bm = require('./sct-main-ecl').evaluateEcl(c.store, text, null);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if ((err && err.eclInvalid) || /is not known/.test(msg)) throw new FilterError(msg, { eclUnknown: true });
      throw new Unsupported('ecl-feature', msg);
    }
    void e;
    return { t: 'ids', ids: bm.toArray(), label: 'ECL (main) ' + text.slice(0, 60) };
  },
  rootNode(c) {
    const id = c.id('138875005');
    return id == null ? { t: 'empty' } : { t: 'ids', ids: [id] };
  },
  unknownConcept(c, op, value) {
    throw new FilterError(`The SNOMED CT Concept ${value} is not known`, { unknownConcept: value });
  },
  /**
   * concept in X,Y,…: a refset contributes its active members, any other concept itself (owner and
   * THO, 2026-11-02; tx-ecosystem sct/*-concept-in). An unknown concept is an error (strictIn).
   */
  conceptIn(c, ids) {
    const S = c.store;
    const sets = S.loadSets(KIND.refset, 0, ids, c.stats);
    const items = [];
    const plain = [];
    for (const id of ids) {
      if (sets.get(id) && sets.get(id).size) items.push({ t: 'set', kind: KIND.refset, pid: 0, value: id });
      else plain.push(id);
    }
    if (plain.length) items.push({ t: 'ids', ids: plain });
    return items.length === 1 ? items[0] : { t: 'or', items };
  },
  filter(c, prop, op, value) {
    const S = c.store;
    // code is the same filter property as concept (tx-ecosystem sct/*-code-in); code regex stays a text filter
    if (prop === 'concept' || (prop === 'code' && op !== 'regex')) {
      if (op !== 'in' && op !== 'not-in' && !sctId(value)) throw new FilterError(`Invalid concept ID: ${value}`);
      if (!['=', 'is-a', 'descendent-of', 'child-of', 'generalizes', 'in', 'not-in', 'is-not-a', 'descendent-leaf'].includes(op)) {
        throw new FilterError(`Unsupported filter operation: ${prop} ${op} ${value}`);
      }
      return null; // generic concept rules
    }
    if (prop === 'inactive') {
      if (value !== 'true' && value !== 'false') throw new FilterError(`Invalid filter value: ${value}`);
      if (op !== '=') throw new FilterError(`Unsupported filter operation: inactive ${op} ${value}`);
      return value === 'true' ? { t: 'inactive' } : { t: 'active' };
    }
    if (prop === 'constraint' && op === '=') return c.ecl(value);
    if (prop === 'moduleId') {
      if (!sctId(value)) throw new FilterError(`Invalid concept ID: ${value}`);
      if (op !== '=') throw new FilterError(`Unsupported filter operation: moduleId ${op} ${value}`);
      const id = c.id(value);
      return id == null ? { t: 'empty' } : { t: 'set', kind: KIND.prop, pid: S.props.get('module').id, value: id };
    }
    if (prop === 'expressions' && op === '=') {
      // true: expressions are allowed as well (an expansion still lists only concepts; an
      // expression's membership is decided by main's services over this file, see snomed.js)
      if (value === 'true') return { t: 'all', expressionsTrue: true };
      return { t: 'all', expressionsFalse: true };
    }
    if (String(prop).startsWith('mapped:')) {
      // mapped:<identifier scheme> exists true|false: concepts with (or without) an alternate
      // identifier in that scheme (e.g. 30051010000102: a LOINC code)
      const scheme = String(prop).substring('mapped:'.length);
      if (!sctId(scheme)) throw new FilterError(`Invalid identifier scheme: ${scheme}`);
      if (op !== 'exists') throw new FilterError(`Unsupported filter operation: ${prop} ${op} ${value}`);
      if (value !== 'true' && value !== 'false') throw new FilterError(`Invalid filter value: ${value}`);
      const sid = c.id(scheme);
      const ids = sid == null ? [] : S.stmt('SELECT DISTINCT concept_id FROM alternate_identifier WHERE scheme_id = ? ORDER BY concept_id').pluck().all(sid);
      const has = { t: 'ids', ids, label: `${prop} exists` };
      return value === 'true' ? has : { t: 'minus', a: { t: 'all' }, b: has };
    }
    if (prop === 'display' && op === 'regex') {
      // tx-ecosystem requirements (display regex): any active FSN or synonym in the one language the
      // request chooses (c.term.lang) matches the whole term, case-sensitively
      const lits = S.hasFts ? requiredLiterals(value) : [];
      const lang = c.term.lang || 'en';
      return { t: 'desigRegex', re: String(value), lang, uses: [FSN_ID, SYNONYM_ID], ...(lits.length ? { lits } : {}), label: `display (${lang}) ~ /${value}/` };
    }
    if (prop === 'display' || prop === 'code') return null; // generic text rules
    if (sctId(prop)) {
      if (!sctId(value)) throw new FilterError(`Invalid concept ID: ${value}`);
      if (op !== '=') throw new FilterError(`Unsupported filter operation: ${prop} ${op} ${value}`);
      const p = S.props.get(String(prop).trim());
      const id = c.id(value);
      if (!p || id == null) return { t: 'empty' };
      return { t: 'set', kind: KIND.prop, pid: p.id, value: id };
    }
    return null; // generic rules (supplement properties, ...); unknown properties fail there
  }
};

const generic = { name: 'generic' };

function dialectFor(system) {
  if (system === LOINC) return loinc;
  if (system === RXNORM) return rxnorm;
  if (system === SCT) return snomed;
  return generic;
}

module.exports = { dialectFor, LOINC, RXNORM, SCT };
