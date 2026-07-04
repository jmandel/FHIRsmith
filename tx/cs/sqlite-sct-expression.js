'use strict';

// SNOMED CT post-coordinated expression support for the generic sqlite-v1
// provider.
//
// This is the sqlite analogue of SnomedExpressionServices in
// tx/sct/expressions.js. The reference class there is bound to the binary
// cache's in-memory index structures, so it cannot be reused directly. Instead
// this module PORTS the (data-independent) structural algorithms — expression
// checking, rendering, canonical equivalence, normal-form computation and
// subsumption — and swaps ONLY the leaf operations for sqlite-v1 queries:
//
//   - concept exists / display        -> `concept` table (code, display, active)
//   - concept subsumes concept        -> `closure` table (ancestor -> descendant)
//   - defining relationships          -> `concept_link` (non is-a, active) joined
//                                        to `property_def` for the attribute code
//   - primitive vs. fully-defined     -> `concept_literal` definitionStatusId
//   - designation terms (for |term|)  -> `designation` table
//
// The AST classes (SnomedConcept / SnomedRefinement / SnomedRefinementGroup /
// SnomedExpression) and the parser (SnomedExpressionParser) from
// tx/sct/expressions.js are reused UNMODIFIED. After validation each concept's
// `.reference` field is populated with its sqlite concept_id, so the AST's own
// structural helpers (matches / canonical / compare) operate on concept_ids the
// same way the binary services operate on cache indices.

const {
  SnomedExpressionParser,
  SnomedExpression,
  SnomedConcept,
  SnomedRefinement,
  SnomedRefinementGroup,
  SnomedServicesRenderOption,
  SnomedRefinementGroupMatchState,
  NO_REFERENCE,
} = require('../sct/expressions');

// RF2 definition-status concept: primitive (as opposed to 900000000000073002,
// fully defined).
const PRIMITIVE_STATUS = '900000000000074008';
// SNOMED is-a relationship type.
const IS_A_CODE = '116680003';
const DEFINITION_STATUS_CODE = 'definitionStatusId';
// Concept-model attribute roots an attribute name must be subsumed by. Same
// limit set the binary checkRefinement enforces.
const ATTRIBUTE_LIMIT_CODES = ['410662002', '106237007'];

class SqliteSctExpressionService {
  /**
   * @param {object} factory - the SqliteCodeSystemFactory (owns db, csId,
   *   propByCode). Cached per-factory so prepared statements are built once and
   *   shared across provider instances.
   */
  constructor(factory) {
    this.db = factory.db;
    this.csId = factory.csId;
    const isAProp = factory.propByCode.get(IS_A_CODE);
    this.isAPropId = isAProp ? isAProp.property_id : -1;
    const defStatusProp = factory.propByCode.get(DEFINITION_STATUS_CODE);
    this.defStatusPropId = defStatusProp ? defStatusProp.property_id : -1;

    // Lazily-prepared statements.
    this._stmt = {};

    // Resolve the attribute-limit concept ids once (may be absent in tiny DBs).
    this.attributeLimitIds = [];
    for (const code of ATTRIBUTE_LIMIT_CODES) {
      const row = this._conceptByCode(code);
      if (row) this.attributeLimitIds.push(row.concept_id);
    }
  }

  // ---- prepared statement helpers ----------------------------------------

  _prep(key, sql) {
    if (!this._stmt[key]) this._stmt[key] = this.db.prepare(sql);
    return this._stmt[key];
  }

  _conceptByCode(code) {
    return this._prep('byCode',
      `SELECT concept_id, code, display, active FROM concept WHERE cs_id = ? AND code = ?`
    ).get(this.csId, code);
  }

  _conceptById(id) {
    return this._prep('byId',
      `SELECT concept_id, code, display, active FROM concept WHERE concept_id = ?`
    ).get(id);
  }

  // ---- leaf operations (sqlite-backed) -----------------------------------

  // concept a subsumes concept b (a is an ancestor-or-self of b), by concept_id.
  subsumes(aId, bId) {
    if (aId === bId) return true;
    if (aId === NO_REFERENCE || bId === NO_REFERENCE) return false;
    const row = this._prep('closure',
      `SELECT 1 FROM closure WHERE ancestor_id = ? AND descendant_id = ? LIMIT 1`
    ).get(aId, bId);
    return !!row;
  }

  isPrimitive(id) {
    if (id === NO_REFERENCE) return true;
    if (this.defStatusPropId === -1) return true;
    const row = this._prep('defStatus',
      `SELECT value_raw FROM concept_literal
        WHERE source_concept_id = ? AND property_id = ? AND active = 1 LIMIT 1`
    ).get(id, this.defStatusPropId);
    if (!row) return true; // unknown -> treat as primitive (binary fallback)
    return row.value_raw === PRIMITIVE_STATUS;
  }

  getConceptId(id) {
    const row = this._conceptById(id);
    return row ? row.code : String(id);
  }

  // Active is-a parents of a concept, as concept_ids.
  getConceptParents(id) {
    return this._prep('parents',
      `SELECT DISTINCT target_concept_id AS id FROM concept_link
        WHERE source_concept_id = ? AND property_id = ? AND active = 1`
    ).all(id, this.isAPropId).map((r) => r.id);
  }

  // Active defining (non is-a) relationships of a concept:
  // { attrConceptId, attrCode, targetId, targetCode, group }. The attribute's
  // CONCEPT_ID (not its property_id) is resolved by joining the attribute
  // SCTID (property_code) back to the concept table, so refinement names carry
  // the same reference a parsed expression's attribute name does — otherwise
  // group merging in normalisation never matches names.
  getDefiningRelationships(id) {
    return this._prep('defrels',
      `SELECT DISTINCT ac.concept_id AS attrConceptId, pd.property_code AS attrCode,
              cl.target_concept_id AS targetId, tc.code AS targetCode, cl.group_id AS grp
         FROM concept_link cl
         JOIN property_def pd ON pd.property_id = cl.property_id
         JOIN concept tc ON tc.concept_id = cl.target_concept_id
         JOIN concept ac ON ac.cs_id = ? AND ac.code = pd.property_code
        WHERE cl.source_concept_id = ? AND cl.active = 1 AND cl.property_id != ?`
    ).all(this.csId, id, this.isAPropId).map((r) => ({
      attrConceptId: r.attrConceptId, attrCode: r.attrCode, targetId: r.targetId,
      targetCode: r.targetCode, group: r.grp,
    }));
  }

  // Preferred display for a concept, identified by concept_id or by code.
  getDisplayName(idOrCode) {
    let row;
    if (typeof idOrCode === 'string') row = this._conceptByCode(idOrCode);
    else row = this._conceptById(idOrCode);
    return row ? (row.display || '') : '';
  }

  // Active designation terms for a concept (for |term| validation).
  designationTerms(id) {
    return this._prep('designations',
      `SELECT term, preferred FROM designation
        WHERE concept_id = ? AND active = 1 ORDER BY preferred DESC, designation_id`
    ).all(id).map((r) => r.term);
  }

  // ---- parse + validate --------------------------------------------------

  /**
   * Parse an expression string and validate all referenced concepts against the
   * database (mirrors cs-snomed locate: bare parser, then checkExpression). On
   * success every concept in the tree has `.reference` set to its concept_id.
   * Throws on syntax error or unknown/invalid concept (message parity with the
   * binary services: `Concept <code> not found`).
   */
  parseAndValidate(source) {
    const expr = new SnomedExpressionParser().parse(source);
    this.checkExpression(expr);
    return expr;
  }

  checkExpression(expression) {
    for (const concept of expression.concepts) {
      this.checkConcept(concept, null);
    }
    if (expression.hasRefinements()) {
      for (const refinement of expression.refinements) this.checkRefinement(refinement);
    }
    if (expression.hasRefinementGroups()) {
      for (const group of expression.refinementGroups) {
        for (const refinement of group.refinements) this.checkRefinement(refinement);
      }
    }
  }

  checkRefinement(refinement) {
    this.checkConcept(refinement.name, this.attributeLimitIds);
    this.checkExpression(refinement.value);
  }

  checkConcept(concept, limits) {
    if (concept.code) {
      const row = this._conceptByCode(concept.code);
      if (row) {
        concept.reference = row.concept_id;
      } else if (concept.code !== '111115') { // reserved extension placeholder
        throw new Error(`Concept ${concept.code} not found`);
      }
    }

    if (limits && limits.length && concept.reference !== NO_REFERENCE) {
      let ok = false;
      for (const limitId of limits) {
        if (this.subsumes(limitId, concept.reference)) { ok = true; break; }
      }
      if (!ok) {
        if (ATTRIBUTE_LIMIT_CODES.length === 1) {
          throw new Error(`Concept ${concept.code} is not valid in this context (must be a ${ATTRIBUTE_LIMIT_CODES[0]})`);
        }
        throw new Error(`Concept ${concept.code} is not valid in this context (must be a descendent of one of ${ATTRIBUTE_LIMIT_CODES})`);
      }
    }

    if (concept.reference !== NO_REFERENCE && concept.description) {
      const terms = this.designationTerms(concept.reference);
      const want = this._normalizeText(concept.description);
      let ok = false;
      for (const t of terms) {
        if (this._normalizeText(t) === want) { ok = true; break; }
      }
      if (!ok) {
        const valid = terms.join('", "');
        throw new Error(`Term "${concept.description}" doesn't match a defined term at position ${concept.start} (valid terms would be from this list: "${valid}")`);
      }
    }
  }

  _normalizeText(text) {
    if (!text) return '';
    let result = '';
    let wasWs = false;
    for (const ch of text) {
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        if (!wasWs) { result += ' '; wasWs = true; }
      } else {
        result += ch.toLowerCase();
        wasWs = false;
      }
    }
    return result.trim();
  }

  // ---- rendering ---------------------------------------------------------

  render(expr, option = SnomedServicesRenderOption.FillMissing) {
    const parts = [];
    this._renderParts(parts, expr, option);
    return parts.join('');
  }

  renderExpression(expr, option) { return this.render(expr, option); }

  _renderParts(parts, expr, option) {
    for (let i = 0; i < expr.concepts.length; i++) {
      if (i > 0) parts.push('+');
      this._renderConcept(parts, expr.concepts[i], option);
    }
    if (expr.hasRefinements() || expr.hasRefinementGroups()) {
      parts.push(':');
      if (expr.hasRefinements()) {
        for (let i = 0; i < expr.refinements.length; i++) {
          if (i > 0) parts.push(',');
          this._renderRefinement(parts, expr.refinements[i], option);
        }
      }
      if (expr.hasRefinementGroups()) {
        for (let j = 0; j < expr.refinementGroups.length; j++) {
          if (j > 0) parts.push(',');
          parts.push('{');
          const g = expr.refinementGroups[j];
          for (let i = 0; i < g.refinements.length; i++) {
            if (i > 0) parts.push(',');
            this._renderRefinement(parts, g.refinements[i], option);
          }
          parts.push('}');
        }
      }
    }
  }

  _renderConcept(parts, concept, option) {
    if (concept.reference !== NO_REFERENCE && concept.code === '') {
      concept.code = this.getConceptId(concept.reference);
    }
    parts.push(concept.describe());

    let description = '';
    switch (option) {
      case SnomedServicesRenderOption.Minimal:
        description = '';
        break;
      case SnomedServicesRenderOption.AsIs:
        description = concept.description;
        break;
      case SnomedServicesRenderOption.FillMissing:
        description = concept.description;
        if (description === '') {
          if (concept.reference !== NO_REFERENCE) description = this.getDisplayName(concept.reference);
          else if (concept.code) description = this.getDisplayName(concept.code);
        }
        break;
      case SnomedServicesRenderOption.ReplaceAll:
        if (concept.code) description = this.getDisplayName(concept.code);
        break;
      default:
        description = concept.description;
    }

    if (description) {
      parts.push('|');
      parts.push(description);
      parts.push('|');
    }
  }

  _renderRefinement(parts, refinement, option) {
    this._renderConcept(parts, refinement.name, option);
    parts.push('=');
    this._renderParts(parts, refinement.value, option);
  }

  // ---- equivalence -------------------------------------------------------

  expressionsEquivalent(a, b) {
    const e1 = a.canonical();
    const e2 = b.canonical();
    return e1.matches(e2) === '';
  }

  // ---- subsumption -------------------------------------------------------

  expressionSubsumes(a, b) {
    if (a.isSimple() && b.isSimple()) {
      return this.subsumes(a.concepts[0].reference, b.concepts[0].reference);
    }
    const e1 = this.normaliseExpression(a);
    const e2 = this.normaliseExpression(b);

    for (const c of e1.concepts) {
      let ok = false;
      for (const ct of e2.concepts) {
        if (this.subsumesConcept(c, ct)) { ok = true; break; }
      }
      if (!ok) return false;
    }
    for (const r of e1.refinementGroups) {
      const rt = this.findMatchingGroup(r, e2);
      if (!rt || !this.subsumesGroup(r, rt)) return false;
    }
    return true;
  }

  subsumesConcept(a, b) {
    if (a.matches(b)) return true;
    return (a.reference !== NO_REFERENCE) && (b.reference !== NO_REFERENCE) &&
      this.subsumes(a.reference, b.reference);
  }

  subsumesGroup(a, b) {
    for (const refA of a.refinements) {
      let refB = null;
      for (const testRef of b.refinements) {
        if (refA.name.matches(testRef.name)) { refB = testRef; break; }
      }
      if (!refB) return false;
      if (!this.expressionSubsumes(refA.value, refB.value)) return false;
    }
    return true;
  }

  groupsMatch(a, b) {
    for (const refA of a.refinements) {
      let refB = null;
      for (const testRef of b.refinements) {
        if (refA.name.matches(testRef.name)) { refB = testRef; break; }
      }
      if (!refB) return false;
      if (!this.expressionsEquivalent(refA.value, refB.value)) return false;
    }
    return true;
  }

  findMatchingGroup(r, exp) {
    for (const t of exp.refinementGroups) {
      let all = true;
      for (const refs of r.refinements) {
        let match = false;
        for (const reft of t.refinements) {
          if (refs.name.matches(reft.name)) { match = true; break; }
        }
        if (!match) { all = false; break; }
      }
      if (all) return t;
    }
    return null;
  }

  // ---- normal form -------------------------------------------------------

  createNormalForm(reference) {
    const exp = new SnomedExpression();
    this.createDefinedExpression(reference, exp, false);
    return this.normaliseExpression(exp);
  }

  createDefinedExpression(reference, exp, ancestor = false) {
    if (this.isPrimitive(reference)) {
      if (!exp.hasConcept(reference)) {
        const concept = new SnomedConcept(reference);
        concept.code = this.getConceptId(reference);
        exp.concepts.push(concept);
      }
      return;
    }

    const parents = this.getConceptParents(reference);
    for (const parent of parents) {
      this.createDefinedExpression(parent, exp, true);
    }

    if (!ancestor) {
      const groups = new Map();
      const definingRels = this.getDefiningRelationships(reference);
      for (const rel of definingRels) {
        const ref = new SnomedRefinement();
        ref.name = new SnomedConcept(rel.attrConceptId);
        ref.name.code = rel.attrCode;

        ref.value = new SnomedExpression();
        const target = new SnomedConcept(rel.targetId);
        target.code = rel.targetCode;
        ref.value.concepts.push(target);

        if (rel.group === 0) {
          if (!exp.hasRefinement(ref)) exp.refinements.push(ref);
        } else {
          const key = String(rel.group);
          if (!groups.has(key)) groups.set(key, new SnomedRefinementGroup());
          groups.get(key).refinements.push(ref);
        }
      }
      for (const grp of groups.values()) {
        if (!exp.hasRefinementGroup(grp)) exp.refinementGroups.push(grp);
      }
    }
  }

  normaliseExpression(exp) {
    const work = new SnomedExpression();

    for (const concept of exp.concepts) {
      if (concept.reference === NO_REFERENCE || this.isPrimitive(concept.reference)) {
        work.concepts.push(concept);
      } else {
        work.merge(this.createNormalForm(concept.reference));
      }
    }

    for (const refSrc of exp.refinements) {
      const refDst = new SnomedRefinement();
      work.refinements.push(refDst);
      refDst.name = refSrc.name;
      refDst.value = this.normaliseExpression(refSrc.value);
    }

    for (const grpSrc of exp.refinementGroups) {
      const grpDst = new SnomedRefinementGroup();
      work.refinementGroups.push(grpDst);
      for (const refSrc of grpSrc.refinements) {
        const refDst = new SnomedRefinement();
        grpDst.refinements.push(refDst);
        refDst.name = refSrc.name;
        refDst.value = this.normaliseExpression(refSrc.value);
      }
    }

    const work2 = work.canonical();
    this.rationaliseExpression(work2);
    return work2.canonical();
  }

  rationaliseExpression(exp) {
    // Merge subsumable concepts.
    let i = 0;
    while (i < exp.concepts.length) {
      const c1 = exp.concepts[i];
      let j = i + 1;
      while (j < exp.concepts.length) {
        const c2 = exp.concepts[j];
        if (c1.reference !== NO_REFERENCE && c2.reference !== NO_REFERENCE) {
          if (this.subsumes(c1.reference, c2.reference)) {
            c1.copyFrom(c2);
            exp.concepts.splice(j, 1);
          } else if (this.subsumes(c2.reference, c1.reference)) {
            exp.concepts.splice(j, 1);
          } else { j++; }
        } else { j++; }
      }
      i++;
    }

    this.mergeRefinements(exp.refinements);
    for (const group of exp.refinementGroups) this.mergeRefinements(group.refinements);

    i = 0;
    while (i < exp.refinementGroups.length) {
      const grp1 = exp.refinementGroups[i];
      let j = i + 1;
      while (j < exp.refinementGroups.length) {
        if (this.mergeGroups(grp1, exp.refinementGroups[j])) exp.refinementGroups.splice(j, 1);
        else j++;
      }
      i++;
    }
  }

  mergeGroups(grp1, grp2) {
    const matches = [];
    const targets = [];
    for (const ref1 of grp1.refinements) {
      for (const ref2 of grp2.refinements) {
        if (ref1.name.reference === ref2.name.reference) { matches.push(ref1.name.reference); break; }
      }
    }
    if (matches.length === 0) return false;

    let canMerge = true;
    for (const nameRef of matches) {
      const ref1 = this._refByName(nameRef, grp1.refinements);
      const ref2 = this._refByName(nameRef, grp2.refinements);
      if (!ref1 || !ref2) { canMerge = false; break; }
      if (this.expressionSubsumes(ref1.value, ref2.value)) targets.push(true);
      else if (this.expressionSubsumes(ref2.value, ref1.value)) targets.push(false);
      else { canMerge = false; break; }
    }

    if (canMerge) {
      for (let i = 0; i < matches.length; i++) {
        if (targets[i]) {
          const ref1 = this._refByName(matches[i], grp1.refinements);
          const ref2 = this._refByName(matches[i], grp2.refinements);
          ref1.value = ref2.value;
        }
      }
      for (const ref2 of grp2.refinements) {
        if (!matches.includes(ref2.name.reference)) grp1.refinements.push(ref2);
      }
    }
    return canMerge;
  }

  _refByName(nameRef, refinements) {
    for (const ref of refinements) {
      if (ref.name.reference === nameRef) return ref;
    }
    return null;
  }

  mergeRefinements(list) {
    let i = 0;
    while (i < list.length) {
      const ref1 = list[i];
      let j = i + 1;
      while (j < list.length) {
        const ref2 = list[j];
        if (ref1.name.matches(ref2.name)) {
          if (this.expressionSubsumes(ref1.value, ref2.value)) {
            ref1.value = ref2.value;
            list.splice(j, 1);
          } else if (this.expressionSubsumes(ref2.value, ref1.value)) {
            list.splice(j, 1);
          } else { j++; }
        } else { j++; }
      }
      i++;
    }
  }
}

// Detect whether a code string is a post-coordinated expression rather than a
// plain SCTID (mirrors cs-snomed: presence of ':' or '+'). A '+' or ':' never
// occurs in a bare SCTID, so this is unambiguous.
function isSnomedExpression(code) {
  return typeof code === 'string' && (code.includes(':') || code.includes('+'));
}

module.exports = {
  SqliteSctExpressionService,
  isSnomedExpression,
  SnomedRefinementGroupMatchState,
};
