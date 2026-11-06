'use strict';
// The engine dialect for FHIR CodeSystem blocks: the filter rules of main's cs-cs.js
// (FhirCodeSystemProvider.filter), as IR over the block's sets. Every filter shape main accepts
// gives the same members; a shape main refuses raises the same issue.
//
//   concept|code  is-a, descendent-of, is-not-a, child-of, in, =, regex (code matches ^re$)
//   child         exists (value 'true' = has children, anything else = has none)
//   <declared property>  =, in, not-in, regex (main's string form of the value); other ops select nothing
//   notSelectable, status  =, in, not-in (unless the code system redefines the code); other ops select nothing
//   inactive, deprecated   any op: value 'true' selects isInactive()/isDeprecated(), anything else the rest
//   anything else         FILTER_NOT_UNDERSTOOD (422)
//
// Order: nodes carry `fhirOrder` so the provider can list members as main does: 'list' (the given
// order, duplicates kept: concept in / =), 'dfs' (root first, then depth first over the children:
// is-a / descendent-of / child-of), else id order (= main's codeMap order).

const { KIND } = require('../store');
const regexUtilities = require('../../../library/regex-utilities');

const KNOWN = ['notSelectable', 'status', 'inactive', 'deprecated'];

class FhirFilterIssue extends Error {
  constructor(msgId, args, extra = {}) {
    super(msgId);
    this.fhirIssue = msgId;
    this.args = args;
    Object.assign(this, extra);
    this.filterError = true;
  }
}

function standardPropertyCodes(cs, name, aliases) {
  const { FhirCodeSystemProvider } = require('../../cs/cs-cs');
  return FhirCodeSystemProvider.prototype.standardPropertyCodes.call({ propertyDefinitions: () => cs.jsonObj.property || null }, name, aliases);
}

function redefines(cs, name) {
  const { FhirCodeSystemProvider } = require('../../cs/cs-cs');
  return FhirCodeSystemProvider.prototype.redefinesStandardProperty.call({ propertyDefinitions: () => cs.jsonObj.property || null }, name);
}

const split = (v) => String(v).split(',').map((x) => x.trim());
const EMPTY = { t: 'empty' };

function propSet(S, code, value) {
  const p = S.props.get(code);
  return p ? { t: 'set', kind: KIND.prop, pid: p.id, value } : EMPTY;
}

function any(items) {
  const real = items.filter((i) => i.t !== 'empty');
  if (!real.length) return EMPTY;
  return real.length === 1 ? real[0] : { t: 'or', items: real };
}

function conceptFilter(c, cs, prop, op, value) {
  const S = c.store;
  const hier = S.hierarchy;
  if (op === 'is-a' || op === 'descendent-of') {
    const root = cs.lookupId(value);
    if (root == null) return EMPTY;
    const exact = cs.idOf(value);
    const items = [];
    if (op === 'is-a') items.push({ t: 'ids', ids: [root] });
    if (exact != null) items.push({ t: 'set', kind: KIND.descendants, pid: 0, value: exact });
    const n = any(items);
    return { ...(n.t === 'or' ? n : { t: 'or', items: [n] }), fhirOrder: 'dfs', root, exact, self: op === 'is-a' };
  }
  if (op === 'child-of') {
    const root = cs.lookupId(value);
    const exact = cs.idOf(value);
    if (root == null || exact == null || !hier) return EMPTY;
    return { t: 'set', kind: KIND.prop, pid: hier.id, value: exact, fhirOrder: 'children', exact };
  }
  if (op === 'is-not-a') {
    const exact = cs.idOf(value);
    if (exact == null) return { t: 'all' };
    return { t: 'minus', a: { t: 'all' }, b: { t: 'or', items: [{ t: 'ids', ids: [exact] }, { t: 'set', kind: KIND.descendants, pid: 0, value: exact }] } };
  }
  if (op === 'in' || op === '=') {
    const codes = op === 'in' ? split(value) : [value];
    const list = [];
    for (const code of codes) { const id = cs.lookupId(code); if (id != null) list.push(id); }
    return { t: 'ids', ids: [...new Set(list)].sort((a, b) => a - b), fhirOrder: 'list', list };
  }
  if (op === 'regex') {
    let re;
    try {
      re = regexUtilities.compile('^' + value + '$');
    } catch (e) {
      throw new FhirFilterIssue('INVALID_REGEX', [value, e.message], { issueType: 'exception' });
    }
    const ids = [];
    for (const [id, code] of S.stmt('SELECT concept_id, code FROM concept WHERE concept_id BETWEEN ? AND ? ORDER BY concept_id').raw().iterate(S.lo, S.hi)) {
      if (re.test(code)) ids.push(id);
    }
    return { t: 'ids', ids };
  }
  throw new FhirFilterIssue('FILTER_NOT_UNDERSTOOD', [prop, op, value]);
}

function propertyFilter(c, def, op, value) {
  const S = c.store;
  const p = S.props.get(def.code);
  // main tests a concept only when it has a property array (cs-cs.js _conceptMatchesPropertyFilter)
  const withProps = propSet(S, '$property', 'true');
  if (!p) return op === 'not-in' ? withProps : EMPTY;
  if (op === '=') return { t: 'set', kind: KIND.prop, pid: p.id, value: String(value) };
  if (op === 'in' || op === 'not-in') {
    const n = any(split(value).map((v) => ({ t: 'set', kind: KIND.prop, pid: p.id, value: v })));
    return op === 'in' ? n : { t: 'minus', a: withProps, b: n };
  }
  if (op === 'regex') {
    let re;
    try { re = regexUtilities.compile('^' + value + '$'); } catch (e) { return EMPTY; }
    return any(S.propValues(p.id).filter((r) => re.test(String(r.value))).map((r) => ({ t: 'set', kind: KIND.prop, pid: p.id, value: r.value })));
  }
  return EMPTY;
}

function knownFilter(c, prop, op, value) {
  const S = c.store;
  if (prop === 'inactive' || prop === 'deprecated') {
    const n = propSet(S, '$' + prop, 'true');
    return value === 'true' ? n : { t: 'minus', a: { t: 'all' }, b: n };
  }
  // notSelectable: String(value of the property); status: getStatus()
  const key = '$' + prop;
  if (op === '=') return propSet(S, key, String(value));
  if (op === 'in' || op === 'not-in') {
    const n = any(split(value).map((v) => propSet(S, key, v)));
    return op === 'in' ? n : { t: 'minus', a: { t: 'all' }, b: n };
  }
  return EMPTY;
}

const fhir = {
  name: 'fhir',
  searchMode: 'fhir',
  notSupported(prop, op, value) {
    return new FhirFilterIssue('FILTER_NOT_UNDERSTOOD', [prop, op, value]);
  },
  /** main's FhirCodeSystemProvider.filter dispatch, in its order */
  filter(c, prop, op, value) {
    const cs = c.term.cs;
    let node = null;
    if (prop === 'concept' || prop === 'code') node = conceptFilter(c, cs, prop, op, value);
    if (prop === 'child' && op === 'exists') {
      node = value === 'true' ? { t: 'minus', a: { t: 'all' }, b: { t: 'leaf' } } : { t: 'leaf' };
    }
    const def = (cs.jsonObj.property || []).find((p) => p.code === prop);
    if (def) node = propertyFilter(c, def, op, value);
    if (KNOWN.includes(prop) && !redefines(cs, prop)) node = knownFilter(c, prop, op, value);
    if (!node) throw new FhirFilterIssue('FILTER_NOT_UNDERSTOOD', [prop, op, value]);
    return node;
  }
};

module.exports = { fhir, FhirFilterIssue, standardPropertyCodes };
