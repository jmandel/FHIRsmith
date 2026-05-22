'use strict';

const IR = require('../../tx/engine/ir');
const { interpretScopedIR } = require('../../tx/engine/scoped-ir-interpreter');
const { buildMembershipPlan, buildSelectionPlan } = require('../../tx/cs/sqlite-v0-plan-builder');
const { interpretMembershipPlan, conceptIdsToCodes } = require('../../tx/cs/sqlite-v0-plan-interpret');
const { createSqliteV0Compiler } = require('../../tx/cs/sqlite-v0-compiler');
const {
  buildTinyScopedModel,
  makeDefaultSqliteV0PropertyDefs,
  makeDefaultSqliteV0Runtime,
} = require('../support/terminology-model/model');
const { normalizeCodeList } = require('../support/terminology-model/normalize-results');
const { evaluateSelectorOnModel } = require('../support/engine/compose-eval');
const { buildRuntimeSqliteV0Db } = require('../support/terminology-model/sqlite-db-builder');

function evalIr(expr, model) {
  return normalizeCodeList(
    [...interpretScopedIR(expr, {
      evaluateSelector(node) {
        return evaluateSelectorOnModel(node, model);
      },
    })]
  );
}

function evalPlan(expr, model, propertyDefs, runtime, opts = {}) {
  const lowered = buildMembershipPlan(expr, {
    propertyDefs,
    runtime,
    scope: { system: model.system, version: model.version, csId: model.csId },
  });
  expect(lowered.ok).toBe(true);
  const plan = opts.selection ? buildSelectionPlan(lowered.plan, opts.selection, runtime) : lowered.plan;
  return normalizeCodeList(conceptIdsToCodes(interpretMembershipPlan(plan, model), model));
}

describe('sqlite-v0 mutation sentinels', () => {
  const model = buildTinyScopedModel({ activeMask: 3, classMask: 1, refsetMask: 1, hasEdge: true });
  const propertyDefs = makeDefaultSqliteV0PropertyDefs();
  const runtime = makeDefaultSqliteV0Runtime();

  test('union/intersect polarity swap would be caught', () => {
    const a = IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'B' }] });
    const chem = IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'CLASS', op: '=', value: 'CHEM' }] });
    expect(evalIr(IR.union([a, chem]), model)).not.toEqual(evalIr(IR.intersect([a, chem]), model));
  });

  test('is-a vs descendent-of include-self mutation would be caught', () => {
    const isa = IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'concept', op: 'is-a', value: 'A' }] });
    const desc = IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'concept', op: 'descendent-of', value: 'A' }] });
    expect(evalPlan(isa, model, propertyDefs, runtime)).not.toEqual(evalPlan(desc, model, propertyDefs, runtime));
  });

  test('dropping diff-right branch would be caught', () => {
    const whole = IR.selector({ system: 'urn:sys:A', shape: 'whole' });
    const bOnly = IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'B' }] });
    expect(evalIr(IR.diff(whole, bOnly), model)).not.toEqual(evalIr(whole, model));
  });

  test('missing DISTINCT/dedupe would be caught', () => {
    const explicitA = IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'A' }] });
    const chem = IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'CLASS', op: '=', value: 'CHEM' }] });
    const correct = evalIr(IR.union([explicitA, chem]), model);
    const mutatedNoDedupe = [...evalIr(explicitA, model), ...evalIr(chem, model)];
    expect(correct).toEqual(['A']);
    expect(mutatedNoDedupe).toEqual(['A', 'A']);
  });

  test('wrong sort-key-before-pagination would be caught', () => {
    const weirdDisplayModel = {
      ...model,
      concepts: model.concepts.map(row => ({
        ...row,
        display: row.code === 'A' ? 'Zulu' : 'Alpha',
      })),
    };
    const compiler = createSqliteV0Compiler({
      propertyDefs,
      runtime,
      scope: { system: weirdDisplayModel.system, version: weirdDisplayModel.version, csId: weirdDisplayModel.csId },
    });
    const db = buildRuntimeSqliteV0Db(weirdDisplayModel, {
      csId: weirdDisplayModel.csId,
      propertyDefs,
      runtime,
    });
    try {
      const expr = IR.selector({ system: 'urn:sys:A', shape: 'whole' });
      const correct = normalizeCodeList(
        db.prepare(compiler.compileExpand(expr, { offset: 0, count: 1 }).sql.text)
          .all(compiler.compileExpand(expr, { offset: 0, count: 1 }).sql.params)
          .map(row => row.code)
      );
      const mutatedDisplaySort = [...weirdDisplayModel.concepts]
        .sort((a, b) => String(a.display).localeCompare(String(b.display)))
        .slice(0, 1)
        .map(row => row.code);
      expect(correct).toEqual(['A']);
      expect(mutatedDisplaySort).toEqual(['B']);
    } finally {
      db.close();
    }
  });

  test('wrong search source wiring would be caught', () => {
    const designationOnlyModel = {
      ...model,
      concepts: model.concepts.map(row => ({
        ...row,
        display: row.code === 'A' ? 'Generic display' : row.display,
      })),
      designations: [
        { concept_id: 1, value_text: 'renal term', term: 'renal term', active: 1 },
        { concept_id: 2, value_text: 'other term', term: 'other term', active: 1 },
      ],
    };
    const expr = IR.selector({ system: 'urn:sys:A', shape: 'whole' });
    const designationSearch = evalPlan(expr, designationOnlyModel, propertyDefs, runtime, {
      selection: { text: 'renal' },
    });
    const displayOnlyRuntime = {
      ...runtime,
      search: {
        ...runtime.search,
        sources: ['display'],
      },
    };
    const displayOnlySearch = evalPlan(expr, designationOnlyModel, propertyDefs, displayOnlyRuntime, {
      selection: { text: 'renal' },
    });
    expect(designationSearch).not.toEqual(displayOnlySearch);
  });
});
