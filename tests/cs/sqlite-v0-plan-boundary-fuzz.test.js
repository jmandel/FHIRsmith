'use strict';

const IR = require('../../tx/engine/ir');
const { interpretScopedIR } = require('../../tx/engine/scoped-ir-interpreter');
const { buildMembershipPlan, buildSelectionPlan } = require('../../tx/cs/sqlite-v0-plan-builder');
const { normalizeMembershipPlan } = require('../../tx/cs/sqlite-v0-plan-normalize');
const { interpretMembershipPlan } = require('../../tx/cs/sqlite-v0-plan-interpret');
const Types = require('../../tx/cs/sqlite-v0-plan-types');
const {
  buildTinyScopedModel,
  conceptIdsToCodes,
  makeDefaultSqliteV0PropertyDefs,
  makeDefaultSqliteV0Runtime,
} = require('../support/terminology-model/model');
const { normalizeCodeList } = require('../support/terminology-model/normalize-results');
const { evaluateSelectorOnModel } = require('../support/engine/compose-eval');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick(rng, items) {
  return items[randInt(rng, 0, items.length - 1)];
}

function maybe(rng, p) {
  return rng() < p;
}

function buildRandomExpr(seed) {
  const rng = mulberry32(seed);
  const codes = ['A', 'B'];
  const selectors = [];
  const count = randInt(rng, 1, 4);
  for (let i = 0; i < count; i++) {
    const kind = pick(rng, ['whole', 'concept', 'is-a', 'descendent-of', 'refset', 'regex', 'class']);
    if (kind === 'whole') {
      selectors.push(IR.selector({ system: 'urn:sys:A', shape: 'whole' }));
    } else if (kind === 'concept') {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'concept',
        conceptCodes: [{ code: pick(rng, codes) }, { code: pick(rng, codes) }],
      }));
    } else if (kind === 'is-a') {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'is-a', value: 'A' }],
      }));
    } else if (kind === 'descendent-of') {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'descendent-of', value: 'A' }],
      }));
    } else if (kind === 'refset') {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'in', value: 'http://example.org/refset/x' }],
      }));
    } else if (kind === 'regex') {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'code', op: 'regex', value: maybe(rng, 0.5) ? '^A$' : '^B$' }],
      }));
    } else {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'CLASS', op: '=', value: maybe(rng, 0.5) ? 'CHEM' : 'chemistry' }],
      }));
    }
  }

  let expr = selectors[0];
  for (const next of selectors.slice(1)) {
    const op = pick(rng, ['union', 'intersect', 'diff']);
    if (op === 'union') expr = IR.union([expr, next]);
    else if (op === 'intersect') expr = IR.intersect([expr, next]);
    else expr = IR.diff(expr, next);
  }
  return expr;
}

function denormalizePlan(plan) {
  return Types.setUnion({
    scope: plan.scope || null,
    items: [
      Types.emptySet({ scope: plan.scope || null }),
      Types.setIntersect({
        scope: plan.scope || null,
        items: [
          Types.allConcepts({ scope: plan.scope || null }),
          plan,
        ],
      }),
      plan,
    ],
  });
}

describe('sqlite-v0 projected-IR and logical normalization fuzz', () => {
  const propertyDefs = makeDefaultSqliteV0PropertyDefs();
  const runtime = makeDefaultSqliteV0Runtime();

  test('projected scoped IR and lowered SetPlan agree across random seeds', () => {
    for (let seed = 1; seed <= 250; seed++) {
      const model = buildTinyScopedModel({
        activeMask: seed % 4,
        classMask: (seed >> 2) % 4,
        refsetMask: (seed >> 4) % 4,
        hasEdge: (seed % 2) === 0,
      });
      const expr = buildRandomExpr(seed);
      const lowered = buildMembershipPlan(expr, {
        propertyDefs,
        runtime,
        scope: { system: model.system, version: model.version, csId: model.csId },
      });
      expect(lowered.ok).toBe(true);
      const irCodes = normalizeCodeList(
        [...interpretScopedIR(expr, {
          evaluateSelector(node) {
            return evaluateSelectorOnModel(node, model);
          },
        })]
      );
      const planCodes = normalizeCodeList(
        conceptIdsToCodes(model, interpretMembershipPlan(lowered.plan, model))
      );
      expect(planCodes).toEqual(irCodes);
    }
  });

  test('logical normalization preserves selected-membership semantics across random seeds', () => {
    for (let seed = 1; seed <= 250; seed++) {
      const model = buildTinyScopedModel({
        activeMask: seed % 4,
        classMask: (seed >> 2) % 4,
        refsetMask: (seed >> 4) % 4,
        hasEdge: (seed % 2) === 1,
      });
      const expr = buildRandomExpr(seed ^ 0x9e3779b9);
      const lowered = buildMembershipPlan(expr, {
        propertyDefs,
        runtime,
        scope: { system: model.system, version: model.version, csId: model.csId },
      });
      expect(lowered.ok).toBe(true);
      const selected = buildSelectionPlan(denormalizePlan(lowered.plan), {
        activeOnly: (seed % 3) === 0,
        text: (seed % 5) === 0 ? 'alpha' : ((seed % 7) === 0 ? 'beta' : null),
      }, runtime);
      const rawCodes = normalizeCodeList(
        conceptIdsToCodes(model, interpretMembershipPlan(selected, model))
      );
      const normalizedCodes = normalizeCodeList(
        conceptIdsToCodes(model, interpretMembershipPlan(normalizeMembershipPlan(selected), model))
      );
      expect(normalizedCodes).toEqual(rawCodes);
    }
  });
});
