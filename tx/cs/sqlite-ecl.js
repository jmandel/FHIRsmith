'use strict';

// SNOMED CT ECL (Expression Constraint Language) evaluator for the generic
// sqlite-v1 CodeSystem provider.
//
// This walks the SAME AST produced by tx/sct/ecl.js (ECLLexer + ECLParser) that
// the binary reference provider (tx/cs/cs-snomed.js) evaluates, but resolves
// every node against the sqlite-v1 schema instead of the binary structures.
// Per-node semantics mirror cs-snomed.js's `_evalECLNode` family EXACTLY — that
// file is the reference implementation.
//
// The evaluator is deliberately decoupled from the provider: all data access
// goes through a small `iface` object (see the JSDoc on evaluateEcl), so the
// evaluator can be unit-tested in isolation with an in-memory fake.
//
// Every result — and every intermediate set — is a sorted, de-duplicated
// number[] of concept_ids.

const { ECLLexer, ECLParser, ECLNodeType, ECLTokenType } = require('../sct/ecl');

// ---------------------------------------------------------------------------
// Sorted-set helpers (ascending, de-duplicated). Kept local so this module is
// self-contained and testable without pulling in the provider.
// ---------------------------------------------------------------------------

function sortUniq(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const out = [];
  for (const v of a) {
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

function unionSorted(a, b) {
  return sortUniq(a.concat(b));
}

function intersectSorted(a, b) {
  const s = new Set(a);
  const out = [];
  for (const v of b) if (s.has(v)) out.push(v);
  return sortUniq(out);
}

function diffSorted(a, b) {
  const s = new Set(b);
  return sortUniq(a.filter((v) => !s.has(v)));
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

class EclEvaluator {
  /**
   * @param {object} iface data-access backing (see evaluateEcl JSDoc)
   */
  constructor(iface) {
    this.iface = iface;
  }

  // Resolve a bare concept code to its concept_id, mirroring the reference's
  // "The SNOMED CT Concept X is not known" error for unknown codes.
  _requireId(code) {
    const id = this.iface.locateId(String(code));
    if (id == null) {
      throw new Error(`The SNOMED CT Concept ${code} is not known`);
    }
    return id;
  }

  // Top-level recursive dispatch — mirrors cs-snomed `_evalECLNode`.
  evalNode(node) {
    if (!node) throw new Error('ECL evaluation error: null AST node');

    switch (node.type) {
      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        return this._evalSubExpression(node);

      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT: {
        const left = this.evalNode(node.left);
        const right = this.evalNode(node.right);
        switch (node.operator) {
          case ECLNodeType.CONJUNCTION: return intersectSorted(left, right);
          case ECLNodeType.DISJUNCTION: return unionSorted(left, right);
          case ECLNodeType.EXCLUSION: return diffSorted(left, right);
          default:
            throw new Error(`Unsupported ECL compound operator: ${node.operator}`);
        }
      }

      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        return this._evalRefined(node);

      case ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT:
        return this._evalDotted(node);

      default:
        // A parenthesised sub-expression can resolve directly to one of these.
        if (node.type === ECLNodeType.CONCEPT_REFERENCE ||
            node.type === ECLNodeType.WILDCARD ||
            node.type === ECLNodeType.MEMBER_OF) {
          return this._evalSubExpression({
            type: ECLNodeType.SUB_EXPRESSION_CONSTRAINT, operator: null, focus: node,
          });
        }
        throw new Error(`Unsupported ECL node type: ${node.type}`);
    }
  }

  // SUB_EXPRESSION_CONSTRAINT: optional hierarchy operator + focus. Mirrors
  // cs-snomed `_evalSubExpression`.
  _evalSubExpression(node) {
    const operator = node.operator;
    const focus = node.focus;

    if (focus.type === ECLNodeType.WILDCARD) {
      if (operator) {
        throw new Error('ECL hierarchy operators combined with wildcard (*) are not supported');
      }
      return sortUniq(this.iface.allIds());
    }

    if (focus.type === ECLNodeType.MEMBER_OF) {
      if (operator) {
        throw new Error('ECL hierarchy operators combined with ^ (member-of) are not yet supported');
      }
      return this._evalMemberOf(focus);
    }

    if (focus.type === ECLNodeType.CONCEPT_REFERENCE) {
      return this._evalConceptWithOperator(focus.conceptId, operator);
    }

    // Parenthesised sub-expression: focus is itself a full constraint node.
    return this.evalNode(focus);
  }

  // Concept id + hierarchy operator. Self-inclusion semantics mirror cs-snomed
  // `_evalConceptWithOperator` exactly.
  _evalConceptWithOperator(conceptId, operator) {
    const id = this._requireId(conceptId);
    switch (operator) {
      case null:
      case undefined:
        return [id];                                                    // bare ref
      case ECLTokenType.DESCENDANT_OR_SELF_OF:                          // <<
        return unionSorted([id], this.iface.closureDescendants(id));
      case ECLTokenType.DESCENDANT_OF:                                  // <
        return sortUniq(this.iface.closureDescendants(id));
      case ECLTokenType.CHILD_OR_SELF_OF:                               // <<!
        return unionSorted([id], this.iface.directChildren(id));
      case ECLTokenType.CHILD_OF:                                       // <!
        return sortUniq(this.iface.directChildren(id));
      case ECLTokenType.ANCESTOR_OR_SELF_OF:                            // >>
        return unionSorted([id], this.iface.closureAncestors(id));
      case ECLTokenType.ANCESTOR_OF:                                    // >
        return sortUniq(this.iface.closureAncestors(id));
      case ECLTokenType.PARENT_OR_SELF_OF:                              // >>!
        return unionSorted([id], this.iface.directParents(id));
      case ECLTokenType.PARENT_OF:                                      // >!
        return sortUniq(this.iface.directParents(id));
      default:
        throw new Error(`Unsupported ECL hierarchy operator: ${operator}`);
    }
  }

  // MEMBER_OF (^). Operand resolves to a set of candidate reference-set
  // concepts; result is the union of their members. A bare, named non-refset
  // operand is an error; a computed operand simply skips non-refset concepts.
  // Mirrors cs-snomed `_evalMemberOf`.
  _evalMemberOf(memberOfNode) {
    const operandIsBareRef = memberOfNode.refSet.type === ECLNodeType.CONCEPT_REFERENCE;
    const refsetConcepts = this.evalNode(memberOfNode.refSet);

    const members = [];
    for (const refsetId of refsetConcepts) {
      const m = this.iface.refsetMembers(refsetId);
      if (m == null) {
        if (operandIsBareRef) {
          throw new Error(`The SNOMED CT Concept ${memberOfNode.refSet.conceptId} is not a reference set`);
        }
        continue; // computed operand: ignore non-reference-set concepts
      }
      for (const x of m) members.push(x);
    }
    return sortUniq(members);
  }

  // Dotted: `<base> . attr1 . attr2` — replace the current set with the active
  // relationship targets of the named attribute, chained. Mirrors cs-snomed
  // `_evalDotted`.
  _evalDotted(node) {
    let current = this.evalNode(node.base);
    for (const attr of node.attributes || []) {
      if (attr.type !== ECLNodeType.CONCEPT_REFERENCE) {
        throw new Error('ECL dotted expressions only support plain concept-reference attribute names');
      }
      this._requireId(attr.conceptId); // attribute concept must exist
      current = sortUniq(this.iface.linkTargets(current, String(attr.conceptId)));
    }
    return current;
  }

  // Refined: `<base> : <refinement>`. Mirrors cs-snomed `_evalRefined`.
  _evalRefined(node) {
    const baseSet = this.evalNode(node.base);
    return this._filterByRefinement(baseSet, node.refinement);
  }

  // Filter a base concept set by a refinement node, returning the surviving
  // sorted subset. Mirrors cs-snomed `_refinementMatches`.
  _filterByRefinement(baseSet, refinement) {
    switch (refinement.type) {
      case ECLNodeType.ATTRIBUTE:
        return this._filterByAttribute(baseSet, refinement);
      case ECLNodeType.ATTRIBUTE_SET: {
        // Conjunction: each attribute must match (any group).
        let survivors = baseSet;
        for (const a of refinement.attributes) {
          survivors = this._filterByRefinement(survivors, a);
        }
        return survivors;
      }
      case ECLNodeType.ATTRIBUTE_GROUP:
        return this._filterByGroup(baseSet, refinement);
      default:
        throw new Error(`Unsupported refinement node type: ${refinement.type}`);
    }
  }

  // Validate an ATTRIBUTE node the same way cs-snomed `_attributeMatches` does,
  // then resolve (attrId, valueSet). valueSet === null means "any target"
  // (the `= *` wildcard case).
  _resolveAttribute(attr) {
    if (attr.reverse) {
      throw new Error('ECL reverse attributes (R) are not yet supported');
    }
    if (!attr.comparison) {
      throw new Error('ECL attribute without a comparison is not supported');
    }
    if (attr.comparison.type !== ECLNodeType.EXPRESSION_COMPARISON) {
      throw new Error(`ECL ${attr.comparison.type} in refinements is not yet supported`);
    }
    if (attr.comparison.operator !== ECLTokenType.EQUALS) {
      throw new Error('ECL != in refinements is not yet supported');
    }
    if (attr.name.type !== ECLNodeType.CONCEPT_REFERENCE) {
      throw new Error('ECL refinements only support plain concept-reference attribute names');
    }
    this._requireId(attr.name.conceptId); // attribute concept must exist
    const attrCode = String(attr.name.conceptId);
    const valueSet = this._isWildcardValue(attr.comparison.value)
      ? null
      : new Set(this.evalNode(attr.comparison.value));
    return { attrCode, valueSet };
  }

  _isWildcardValue(node) {
    if (!node) return false;
    if (node.type === ECLNodeType.WILDCARD) return true;
    return node.type === ECLNodeType.SUB_EXPRESSION_CONSTRAINT &&
      !node.operator && node.focus && node.focus.type === ECLNodeType.WILDCARD;
  }

  // Count, per source concept, the DISTINCT matching relationship targets,
  // honouring an optional group filter. Mirrors cs-snomed
  // `_countAttributeMatches` (which counts distinct targets, not raw rows).
  // Returns Map<sourceConceptId, count>.
  _matchCounts(attrCode, valueSet, groupOnly) {
    const rows = this.iface.attrRows(attrCode, valueSet == null ? null : [...valueSet]);
    const perSource = new Map(); // source -> Set(target)
    for (const r of rows) {
      if (groupOnly && !(r.group > 0)) continue;
      if (valueSet != null && !valueSet.has(r.target)) continue;
      let s = perSource.get(r.source);
      if (!s) { s = new Set(); perSource.set(r.source, s); }
      s.add(r.target);
    }
    const counts = new Map();
    for (const [src, tset] of perSource) counts.set(src, tset.size);
    return counts;
  }

  _filterByAttribute(baseSet, attr) {
    const { attrCode, valueSet } = this._resolveAttribute(attr);
    const counts = this._matchCounts(attrCode, valueSet, false);
    const card = attr.cardinality;
    return baseSet.filter((cid) => {
      const n = counts.get(cid) || 0;
      return card ? cardinalityAccepts(card, n) : n >= 1;
    });
  }

  // Attribute group `{ a = v, b = w }`: a concept matches when a SINGLE
  // relationship group satisfies every attribute. Mirrors cs-snomed
  // `_attributeGroupMatches`.
  _filterByGroup(baseSet, group) {
    // For each attribute build source -> Set(group>0 that satisfy it).
    let perSourceGroups = null; // Map<source, Set<group>> intersected so far
    for (const attr of group.attributes) {
      const { attrCode, valueSet } = this._resolveAttribute(attr);
      const rows = this.iface.attrRows(attrCode, valueSet == null ? null : [...valueSet]);
      // source -> Map<group, Set<target>> (group>0 only)
      const sg = new Map();
      for (const r of rows) {
        if (!(r.group > 0)) continue;
        if (valueSet != null && !valueSet.has(r.target)) continue;
        let gm = sg.get(r.source);
        if (!gm) { gm = new Map(); sg.set(r.source, gm); }
        let tset = gm.get(r.group);
        if (!tset) { tset = new Set(); gm.set(r.group, tset); }
        tset.add(r.target);
      }
      // Reduce to source -> Set(group) satisfying this attribute's cardinality.
      const satisfying = new Map();
      for (const [src, gm] of sg) {
        const gset = new Set();
        for (const [g, tset] of gm) {
          const ok = attr.cardinality ? cardinalityAccepts(attr.cardinality, tset.size) : tset.size >= 1;
          if (ok) gset.add(g);
        }
        if (gset.size) satisfying.set(src, gset);
      }
      if (perSourceGroups === null) {
        perSourceGroups = satisfying;
      } else {
        // Intersect the satisfying group sets per source (same group must
        // satisfy every attribute).
        const next = new Map();
        for (const [src, gset] of perSourceGroups) {
          const other = satisfying.get(src);
          if (!other) continue;
          const inter = new Set();
          for (const g of gset) if (other.has(g)) inter.add(g);
          if (inter.size) next.set(src, inter);
        }
        perSourceGroups = next;
      }
    }
    if (perSourceGroups === null) perSourceGroups = new Map();

    const card = group.cardinality;
    return baseSet.filter((cid) => {
      const gset = perSourceGroups.get(cid);
      const count = gset ? gset.size : 0;
      return card ? cardinalityAccepts(card, count) : count >= 1;
    });
  }
}

// Test a count against a parsed cardinality {min, max} where max may be '*'.
// Mirrors cs-snomed `_cardinalityAccepts`.
function cardinalityAccepts(cardinality, count) {
  const { min, max } = cardinality;
  if (min != null && count < min) return false;
  if (max != null && max !== '*' && count > max) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse ECL text into an AST (throws on syntax errors — callers wrap this as
 * INVALID_ECL). Exposed separately so the provider can mirror cs-snomed's
 * two-phase (parse / evaluate) error classification.
 * @param {string} text
 * @returns {object} AST
 */
function parseEcl(text) {
  const tokens = new ECLLexer(text).tokenize();
  return new ECLParser(tokens).parse();
}

/**
 * Evaluate a parsed ECL AST against the sqlite-backed `iface`.
 * @param {object} iface
 * @param {object} ast
 * @returns {number[]} sorted, de-duplicated concept_ids
 */
function evaluateEclAst(iface, ast) {
  return new EclEvaluator(iface).evalNode(ast);
}

/**
 * Evaluate an ECL constraint (text or AST) against the sqlite-v1 tables.
 *
 * `iface` must provide (all ids are numeric concept_ids; all returned arrays
 * need not be sorted — the evaluator normalises):
 *   - locateId(code) -> number|null       resolve a bare SCTID string
 *   - closureDescendants(id) -> number[]   transitive descendants (no self)
 *   - closureAncestors(id) -> number[]     transitive ancestors (no self)
 *   - directChildren(id) -> number[]       direct active is-a children
 *   - directParents(id) -> number[]        direct active is-a parents
 *   - refsetMembers(id) -> number[]|null   refset members, or null if `id` is
 *                                          not a known reference set
 *   - allIds() -> number[]                 the wildcard universe (active concepts)
 *   - linkTargets(sourceIds, attrId) -> number[]   distinct active targets of
 *                                          the attribute from the source set
 *   - attrRows(attrId, valueIds|null) -> Array<{source,group,target}>
 *                                          active attribute links; valueIds
 *                                          null means "any target"
 *
 * @param {object} iface
 * @param {string|object} eclTextOrAst
 * @returns {number[]} sorted concept_ids
 */
function evaluateEcl(iface, eclTextOrAst) {
  const ast = typeof eclTextOrAst === 'string' ? parseEcl(eclTextOrAst) : eclTextOrAst;
  return evaluateEclAst(iface, ast);
}

module.exports = {
  evaluateEcl,
  evaluateEclAst,
  parseEcl,
  EclEvaluator,
  cardinalityAccepts,
};
