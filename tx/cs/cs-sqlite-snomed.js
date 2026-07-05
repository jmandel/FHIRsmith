'use strict';

// SNOMED CT sqlite-v1 CodeSystem provider.
//
// The generic base provider (cs-sqlite.js SqliteCodeSystemProvider) is driven
// ENTIRELY by database metadata and contains ZERO terminology-specific code.
// SNOMED CT, however, needs behavior that cannot be expressed as metadata:
//   - post-coordinated expression parsing / validation / rendering / equivalence
//     / subsumption (focus : attr = value), and
//   - the ECL `constraint` filter and the `expressions = true|false` filter.
// That CODE lives here, in a SUBCLASS. The factory selects this class at runtime
// by matching the DB's base_uri against `handledSystems` (see cs-sqlite.js's
// provider-class registry) — nothing about the class is stored in the data.
//
// Every override handles the SNOMED-specific case and delegates EVERYTHING
// generic to super, so the base's metadata-driven behavior is reused verbatim.

const {
  SqliteCodeSystemProvider,
  FilterClause,
  sortedIncludes,
  registerSqliteProviderClass,
} = require('./cs-sqlite');
const { CodeSystem } = require('../library/codesystem');
const { evaluateEcl, parseEcl } = require('./sqlite-ecl');
const { SqliteSctExpressionService, isSnomedExpression } = require('./sqlite-sct-expression');
const { SnomedServicesRenderOption, NO_REFERENCE } = require('../sct/expressions');
const { Issue } = require('../library/operation-outcome');
const { debugLog } = require('../operation-context');

/**
 * Context for a validated SNOMED CT post-coordinated expression (as opposed to
 * a single located concept). Carries the source string and the validated AST
 * (all concepts resolved to concept_ids). Shaped so the per-concept getters
 * that only read `.active`/`.definition` behave sensibly: an expression is
 * treated as active with no definition; methods that need real per-concept data
 * branch on `isExpression`.
 */
class SqliteExpressionContext {
  constructor(source, expression) {
    this.conceptId = null;
    this.code = source;
    this.display = null;
    this.active = true;
    this.definition = null;
    this.isExpression = true;
    this.expression = expression;
  }
}

class SnomedSqliteCodeSystemProvider extends SqliteCodeSystemProvider {
  // The code system URL(s) this class handles. The factory matches the DB's
  // code_system.base_uri against this to select the class at runtime.
  static handledSystems = ['http://snomed.info/sct'];

  // Per-factory expression service (prepared statements built once).
  _exprService() {
    if (!this.factory._sctExprService) {
      this.factory._sctExprService = new SqliteSctExpressionService(this.factory);
    }
    return this.factory._sctExprService;
  }

  // ---- context resolution ------------------------------------------------

  // Accept a validated-expression context (which the base does not know about);
  // defer everything else to the generic resolver.
  async _ensure(context) {
    if (context instanceof SqliteExpressionContext) return context;
    return super._ensure(context);
  }

  // ---- lookup ------------------------------------------------------------

  // A plain-code miss may still be a composed expression. Parse + validate all
  // referenced concepts; on success carry the validated AST, on failure return
  // the same not-found shape locate uses (mirrors cs-snomed's "Not a valid
  // expression: ..." information issue). A ':'/'+' code that is a genuine miss
  // (isSnomedExpression false) falls through to the generic miss message.
  async locate(code) {
    const res = await super.locate(code);
    if (res.context || !code || !isSnomedExpression(code)) return res;
    try {
      const expr = this._exprService().parseAndValidate(code);
      return { context: new SqliteExpressionContext(code, expr), message: null };
    } catch (err) {
      return { context: null, message: `Not a valid expression: ${err.message}` };
    }
  }

  async code(context) {
    const c = await this._ensure(context);
    if (c && c.isExpression) {
      return this._exprService().render(c.expression, SnomedServicesRenderOption.Minimal);
    }
    return super.code(context);
  }

  async display(context) {
    const c = await this._ensure(context);
    if (c && c.isExpression) {
      return this._exprService().render(c.expression, SnomedServicesRenderOption.FillMissing);
    }
    return super.display(context);
  }

  async incompleteValidationMessage(context) {
    const c = await this._ensure(context);
    if (c && c.isExpression) {
      // Same process-note the binary provider emits: the expression is
      // grammatically valid and its concepts exist, but it has not been checked
      // against the SNOMED concept model (MRCM).
      return 'The expression is grammatically correct and the concepts are valid, ' +
        'but the expression has not been checked against the SNOMED CT concept model (MRCM)';
    }
    return super.incompleteValidationMessage(context);
  }

  async getStatus(context) {
    const c = await this._ensure(context);
    if (c && c.isExpression) return null;
    return super.getStatus(context);
  }

  async sameConcept(a, b) {
    const ca = await this._ensure(a);
    const cb = await this._ensure(b);
    if (!ca || !cb) return false;
    // Post-coordinated expressions compare by STRUCTURAL equivalence, not by
    // string: `128241005:{363698007=181268008}` equals a whitespace- or
    // order-different rendering of the same composition. Falls back to the
    // generic code comparison when neither side is an expression.
    if (ca.isExpression || cb.isExpression) {
      const svc = this._exprService();
      const ea = ca.isExpression ? ca.expression : svc.parseAndValidate(ca.code);
      const eb = cb.isExpression ? cb.expression : svc.parseAndValidate(cb.code);
      return svc.expressionsEquivalent(ea, eb);
    }
    return super.sameConcept(a, b);
  }

  // ---- designations ------------------------------------------------------

  async designations(context, displays) {
    const c = await this._ensure(context);
    if (c && c.isExpression) {
      // No stored designations for a composed expression; surface the rendered
      // (FillMissing) form as the display designation, like the binary provider
      // (which tags it with a fixed language — cs_config expressionLanguage).
      const disp = this._exprService().render(c.expression, SnomedServicesRenderOption.FillMissing);
      if (disp) {
        displays.addDesignation(true, 'active', this.cfg.expressionLanguage || this.defLang(),
          CodeSystem.makeUseForDisplay(), disp);
      }
      return;
    }
    return super.designations(context, displays);
  }

  // ---- $lookup -----------------------------------------------------------

  async extendLookup(ctxt, props, params) {
    const c = await this._ensure(ctxt);
    if (c && c.isExpression) {
      this._extendLookupExpression(c, props, params);
      return;
    }
    return super.extendLookup(ctxt, props, params);
  }

  // Post-coordinated expression $lookup: the reference surfaces the FOCUS
  // concept's own lookup properties (single-focus expressions only), then each
  // refinement as an attribute property with code-display + description. Reuses
  // the base's _extendLookupConcept / _lookupDisplay / _addCodeProperty.
  _extendLookupExpression(c, props, params) {
    const expr = c.expression;
    if (expr.concepts.length === 1 && expr.concepts[0].reference !== NO_REFERENCE) {
      this._extendLookupConcept(expr.concepts[0].reference, props, params);
    }
    const addRefinement = (refinement) => {
      const valueCode = refinement.value.describe();
      const value = refinement.value;
      const simple = value.concepts.length === 1 &&
        !value.hasRefinements() && !value.hasRefinementGroups();
      const description = simple && value.concepts[0].reference !== NO_REFERENCE
        ? this._lookupDisplay(value.concepts[0].reference)
        : this._exprService().render(value, SnomedServicesRenderOption.FillMissing);
      const p = this._addCodeProperty(params, 'property', refinement.name.code, valueCode, null, description);
      const cd = refinement.name.reference !== NO_REFERENCE
        ? this._lookupDisplay(refinement.name.reference) : null;
      if (cd) p.part.push({ name: 'code-display', valueString: cd });
    };
    for (const refinement of expr.refinements) addRefinement(refinement);
    for (const group of expr.refinementGroups) {
      for (const refinement of group.refinements) addRefinement(refinement);
    }
  }

  // ---- properties --------------------------------------------------------

  async properties(context) {
    const c = await this._ensure(context);
    if (c && c.isExpression) return [];
    return super.properties(context);
  }

  // ---- hierarchy ---------------------------------------------------------

  async subsumesTest(codeA, codeB) {
    // Post-coordinated expressions: normalise + compare structurally via the
    // expression service (mirrors cs-snomed subsumesTest's complex branch).
    if (isSnomedExpression(codeA) || isSnomedExpression(codeB)) {
      const svc = this._exprService();
      const exprA = svc.parseAndValidate(codeA);
      const exprB = svc.parseAndValidate(codeB);
      const b1 = svc.expressionSubsumes(exprA, exprB);
      const b2 = svc.expressionSubsumes(exprB, exprA);
      if (b1 && b2) return 'equivalent';
      if (b1) return 'subsumes';
      if (b2) return 'subsumed-by';
      return 'not-subsumed';
    }
    return super.subsumesTest(codeA, codeB);
  }

  // ---- filters -----------------------------------------------------------

  // eslint-disable-next-line no-unused-vars
  async doesFilter(prop, op, value) {
    // SNOMED CT ECL constraint: concept/code satisfying an ECL expression. Same
    // filter shape the binary reference provider (cs-snomed) registers.
    if (prop === 'constraint' && op === '=') return this.factory.hasHierarchy;
    // SNOMED CT `expressions = true|false`: whether an include permits
    // post-coordinated expressions as members. A no-op for enumeration; it only
    // gates expression membership in validate.
    if (prop === 'expressions' && op === '=') return true;
    return super.doesFilter(prop, op, value);
  }

  async filter(filterContext, forIteration, prop, op, value) {
    // SNOMED CT ECL constraint. Parse eagerly (mirrors cs-snomed, which parses
    // in filter()) so syntax errors surface as INVALID_ECL up front; evaluation
    // is deferred to _runClause.
    if (prop === 'constraint' && op === '=') {
      const ast = this._parseEclOrThrow(value);
      filterContext.clauses.push(new FilterClause('ecl', { value, ast }));
      return;
    }
    // SNOMED CT `expressions = true|false`: gates post-coordinated expression
    // membership. For plain-concept enumeration it matches everything (a no-op
    // that intersects to the other clauses); the want flag is consumed by
    // filterLocate/filterCheck for expression contexts.
    if (prop === 'expressions' && op === '=') {
      filterContext.clauses.push(new FilterClause('expressions', {
        want: String(value).toLowerCase() === 'true',
      }));
      return;
    }
    return super.filter(filterContext, forIteration, prop, op, value);
  }

  async executeFilters(filterContext) {
    const sets = await super.executeFilters(filterContext);
    // Tag expression-membership sets so filterCheck/filterLocate can gate
    // post-coordinated expression contexts (which carry no concept_id). super
    // builds one set per clause, in clause order, so sets[i] <-> clauses[i].
    const clauses = (filterContext && filterContext.clauses) || [];
    for (let i = 0; i < clauses.length; i++) {
      if (clauses[i].kind === 'expressions') sets[i].expressionsWant = clauses[i].spec.want;
    }
    return sets;
  }

  _runClause(clause) {
    if (clause.kind === 'ecl') return this._evalEclOrThrow(clause.spec.value, clause.spec.ast);
    // Expressions filter is a no-op over plain concepts (matches all); the want
    // flag rides on the set for expression-context gating.
    if (clause.kind === 'expressions') return this.factory.allConceptIds();
    return super._runClause(clause);
  }

  // A grammar-bearing code system yields an unclosed filter set unless the
  // include explicitly excludes post-coordinated expressions
  // (`expressions = false`), which bounds it. Mirrors the binary provider.
  async filtersNotClosed(filterContext) {
    if (!this.isNotClosed()) return false;
    const clauses = filterContext && filterContext.clauses;
    if (Array.isArray(clauses)) {
      for (const c of clauses) {
        if (c.kind === 'expressions' && c.spec && c.spec.want === false) return false;
      }
    }
    return true;
  }

  async filterLocate(filterContext, set, code) {
    const located = await this.locate(code);
    if (located.context && located.context.isExpression) {
      const silent = this.cfg.filterLocateMiss === 'silent';
      return this._expressionInFilter(filterContext, set, located.context)
        ? located.context
        : (silent ? null : `Code ${code} is not in the specified filter`);
    }
    return super.filterLocate(filterContext, set, code);
  }

  async filterCheck(filterContext, set, concept) {
    if (concept instanceof SqliteExpressionContext) {
      return this._expressionInFilter(filterContext, set, concept);
    }
    return super.filterCheck(filterContext, set, concept);
  }

  // Membership of a post-coordinated expression in one resolved filter set.
  // A PC expression is a member of an include ONLY when the include explicitly
  // permits expressions (an `expressions = true` clause); an `expressions =
  // false` clause (or the absence of any `expressions` clause) rejects it —
  // mirroring the binary provider's pc-filter/pc-none semantics. Against a
  // plain concept_id set (is-a / refset / ECL), the expression matches when
  // every focus concept is in the set (focus subsumed by the constraint).
  _expressionInFilter(filterContext, set, ctx) {
    const clauses = (filterContext && filterContext.clauses) || [];
    const denies = clauses.some((c) => c.kind === 'expressions' && c.spec && c.spec.want === false);
    const permits = clauses.some((c) => c.kind === 'expressions' && c.spec && c.spec.want === true);
    if (denies || !permits) return false;
    if (set.expressionsWant !== undefined) return set.expressionsWant;
    for (const c of ctx.expression.concepts) {
      if (c.reference === NO_REFERENCE || !sortedIncludes(set.ids, c.reference)) return false;
    }
    return true;
  }

  // One filter triple -> sorted concept_ids for the pushdown / IR engines; the
  // SNOMED-only clauses first, else the generic routing.
  _idsForFilter(prop, op, value) {
    if (prop === 'constraint' && op === '=') {
      return this._evalEclOrThrow(value);
    }
    // Expressions filter is a no-op for plain-concept enumeration (matches all,
    // so intersects to the sibling clauses).
    if (prop === 'expressions' && op === '=') {
      return this.factory.allConceptIds();
    }
    return super._idsForFilter(prop, op, value);
  }

  // ---- ECL (SNOMED CT Expression Constraint Language) --------------------
  //
  // Parsing and evaluation are split to mirror cs-snomed's two-phase error
  // classification: a syntax error is INVALID_ECL; a well-formed expression the
  // evaluator cannot resolve (unknown concept, unsupported construct) is
  // UNSUPPORTED_ECL. Both surface as an `invalid`/`vs-invalid` OperationOutcome,
  // byte-for-byte the same shape the binary reference provider produces.

  _parseEclOrThrow(value) {
    try {
      return parseEcl(value);
    } catch (err) {
      debugLog(err);
      throw new Issue('error', 'invalid', null, 'INVALID_ECL',
        this.opContext.i18n.translate('INVALID_ECL', this.opContext.langs, [value, err.message]),
        'vs-invalid').handleAsOO(400);
    }
  }

  _evalEclOrThrow(value, ast) {
    if (!ast) ast = this._parseEclOrThrow(value);
    try {
      return evaluateEcl(this._eclIface(), ast);
    } catch (err) {
      if (err instanceof Issue || err.isOperationOutcome) throw err;
      debugLog(err);
      throw new Issue('error', 'invalid', null, 'UNSUPPORTED_ECL',
        this.opContext.i18n.translate('UNSUPPORTED_ECL', this.opContext.langs, [value, err.message]),
        'vs-invalid').handleAsOO(400);
    }
  }

  // The small data-access object the ECL evaluator (tx/cs/sqlite-ecl.js) walks
  // the AST against. Every method is backed by a sqlite-v1 query; ids are
  // numeric concept_ids.
  _eclIface() {
    const self = this;
    const hp = this.factory.hierPropPlaceholders;
    const hpIds = this.factory.hierPropIds;
    const edge = this.factory.hierarchyEdgeSet;
    return {
      locateId: (code) => self._locateConceptId(code),

      closureDescendants: (id) => self.db.prepare(
        `SELECT descendant_id AS id FROM closure WHERE ancestor_id = ?`
      ).all(id).map((r) => r.id),

      closureAncestors: (id) => self.db.prepare(
        `SELECT ancestor_id AS id FROM closure WHERE descendant_id = ?`
      ).all(id).map((r) => r.id),

      directChildren: (id) => self.db.prepare(
        `SELECT DISTINCT source_concept_id AS id FROM concept_link
          WHERE target_concept_id = ? AND property_id IN (${hp})
            AND edge_set_id = ? AND active = 1`
      ).all(id, ...hpIds, edge).map((r) => r.id),

      directParents: (id) => self.db.prepare(
        `SELECT DISTINCT target_concept_id AS id FROM concept_link
          WHERE source_concept_id = ? AND property_id IN (${hp})
            AND edge_set_id = ? AND active = 1`
      ).all(id, ...hpIds, edge).map((r) => r.id),

      refsetMembers: (id) => self._eclRefsetMembers(id),

      allIds: () => self._eclActiveIds(),

      linkTargets: (sourceIds, attrCode) => self._eclLinkTargets(sourceIds, attrCode),

      attrRows: (attrCode, valueIds) => self._eclAttrRows(attrCode, valueIds),
    };
  }

  // Map an ECL attribute SCTID (relationship type) to its property_def id. A
  // concept that is not a defined relationship type has no property_id, so it
  // can have no attribute links — the evaluator gets an empty row set (0 matches),
  // matching the reference (no relationships of that type).
  _eclAttrPropId(attrCode) {
    const def = this.propByCode.get(String(attrCode));
    return def ? def.property_id : null;
  }

  // Active concept ids (the ECL wildcard universe), cached on the factory.
  _eclActiveIds() {
    if (!this.factory._eclActiveIds) {
      this.factory._eclActiveIds = this.db.prepare(
        `SELECT concept_id AS id FROM concept WHERE cs_id = ? AND active = 1 ORDER BY id`
      ).all(this.csId).map((r) => r.id);
    }
    return this.factory._eclActiveIds;
  }

  // Refset members for `^ id`. Returns null when `id` is not a known reference
  // set (no value_set row) — the evaluator turns that into the reference's
  // "is not a reference set" error for a bare operand. An imported-but-empty
  // refset returns []. Refset membership is sourced from value_set_member; a
  // refset not imported as a value set is treated as a non-refset.
  _eclRefsetMembers(id) {
    const row = this._rowById(id);
    if (!row) return null;
    const vsId = this._valueSetIdFor(row.code);
    if (vsId == null) return null;
    return this.db.prepare(
      `SELECT concept_id AS id FROM value_set_member WHERE vs_id = ? AND active = 1`
    ).all(vsId).map((r) => r.id);
  }

  // Distinct active relationship targets of `attrId` from a set of source
  // concepts (dotted expressions). Batched to stay under SQLite's parameter cap.
  _eclLinkTargets(sourceIds, attrCode) {
    const propId = this._eclAttrPropId(attrCode);
    if (propId == null) return [];
    const out = new Set();
    for (let i = 0; i < sourceIds.length; i += 900) {
      const chunk = sourceIds.slice(i, i + 900);
      const ph = chunk.map(() => '?').join(',');
      for (const r of this.db.prepare(
        `SELECT DISTINCT target_concept_id AS id FROM concept_link
          WHERE property_id = ? AND active = 1 AND source_concept_id IN (${ph})`
      ).all(propId, ...chunk)) out.add(r.id);
    }
    return [...out];
  }

  // Active attribute-relationship rows for `attrId`, as {source, group, target}.
  // When `valueIds` is a small array the target filter is pushed into SQL;
  // otherwise all rows are returned and the evaluator filters by value in JS
  // (it re-checks membership regardless, so correctness never depends on this).
  _eclAttrRows(attrCode, valueIds) {
    const propId = this._eclAttrPropId(attrCode);
    if (propId == null) return [];
    let sql = `SELECT source_concept_id AS source, group_id AS grp, target_concept_id AS target
                 FROM concept_link WHERE property_id = ? AND active = 1`;
    const args = [propId];
    if (Array.isArray(valueIds) && valueIds.length > 0 && valueIds.length <= 900) {
      sql += ` AND target_concept_id IN (${valueIds.map(() => '?').join(',')})`;
      args.push(...valueIds);
    }
    return this.db.prepare(sql).all(...args).map((r) => ({ source: r.source, group: r.grp, target: r.target }));
  }
}

// Register at module load so the factory can select this class by base_uri.
registerSqliteProviderClass(SnomedSqliteCodeSystemProvider);

module.exports = {
  SnomedSqliteCodeSystemProvider,
  SqliteExpressionContext,
};
