'use strict';

const { buildIRFromValueSet } = require('../../tx/engine/build-ir');
const { resolveImports } = require('../../tx/engine/resolve-imports');
const { optimize } = require('../../tx/engine/rewrite');
const { interpretScopedIR } = require('../../tx/engine/scoped-ir-interpreter');
const { buildMembershipPlan } = require('../../tx/cs/sqlite-v0-plan-builder');
const { createSqliteV0Compiler } = require('../../tx/cs/sqlite-v0-compiler');
const {
  buildTinyScopedModel,
  makeDefaultSqliteV0PropertyDefs,
  makeDefaultSqliteV0Runtime,
} = require('../support/terminology-model/model');
const { normalizeCodeList } = require('../support/terminology-model/normalize-results');
const { buildRuntimeSqliteV0Db } = require('../support/terminology-model/sqlite-db-builder');
const { evaluateValueSetCompose, evaluateSelectorOnModel } = require('../support/engine/compose-eval');
const { evaluateSetPlanCodes } = require('../support/sqlite-v0/plan-eval');

function makeValueSetCatalog() {
  const chem = {
    resourceType: 'ValueSet',
    url: 'http://example.org/vs/chem',
    compose: {
      include: [{
        system: 'urn:sys:A',
        filter: [{ property: 'CLASS', op: '=', value: 'chemistry' }],
      }],
    },
  };
  const refset = {
    resourceType: 'ValueSet',
    url: 'http://example.org/vs/refset',
    compose: {
      include: [{
        system: 'urn:sys:A',
        filter: [{ property: 'concept', op: 'in', value: 'http://example.org/refset/x' }],
      }],
    },
  };
  const regex = {
    resourceType: 'ValueSet',
    url: 'http://example.org/vs/regex-a',
    compose: {
      include: [{
        system: 'urn:sys:A',
        filter: [{ property: 'code', op: 'regex', value: '^A$' }],
      }],
    },
  };
  const importOnly = {
    resourceType: 'ValueSet',
    url: 'http://example.org/vs/import-only',
    compose: {
      include: [{
        valueSet: [chem.url, refset.url],
      }],
    },
  };
  const wholeMinusB = {
    resourceType: 'ValueSet',
    url: 'http://example.org/vs/whole-minus-b',
    compose: {
      include: [{ system: 'urn:sys:A' }],
      exclude: [{ system: 'urn:sys:A', concept: [{ code: 'B' }] }],
    },
  };
  const wholeIntersectImport = {
    resourceType: 'ValueSet',
    url: 'http://example.org/vs/whole-intersect-import',
    compose: {
      include: [{
        system: 'urn:sys:A',
        valueSet: [refset.url],
      }],
    },
  };
  const byUrl = new Map([
    [chem.url, chem],
    [refset.url, refset],
    [regex.url, regex],
    [importOnly.url, importOnly],
    [wholeMinusB.url, wholeMinusB],
    [wholeIntersectImport.url, wholeIntersectImport],
  ]);
  return { byUrl, roots: [chem, refset, regex, importOnly, wholeMinusB, wholeIntersectImport] };
}

describe('sqlite-v0 four-oracle bounded exhaustive parity', () => {
  const propertyDefs = makeDefaultSqliteV0PropertyDefs();
  const runtime = makeDefaultSqliteV0Runtime();
  const catalog = makeValueSetCatalog();

  test('compose evaluator, scoped IR, logical plan, and runtime SQL agree on tiny exhaustive models', async () => {
    let checked = 0;
    for (let activeMask = 0; activeMask < 4; activeMask++) {
      for (let classMask = 0; classMask < 4; classMask++) {
        for (let refsetMask = 0; refsetMask < 4; refsetMask++) {
          for (const hasEdge of [false, true]) {
            const model = buildTinyScopedModel({ activeMask, classMask, refsetMask, hasEdge });
            const compiler = createSqliteV0Compiler({
              propertyDefs,
              runtime,
              scope: { system: model.system, version: model.version, csId: model.csId },
            });
            const db = buildRuntimeSqliteV0Db(model, {
              csId: model.csId,
              propertyDefs,
              runtime,
            });
            try {
              for (const root of catalog.roots) {
                const expectedCompose = normalizeCodeList(evaluateValueSetCompose(root, model, catalog.byUrl));
                const rawIR = buildIRFromValueSet(root);
                const resolved = await resolveImports(rawIR, async url => catalog.byUrl.get(url) || null);
                const optimized = optimize(resolved);
                const scoped = normalizeCodeList(
                  [...interpretScopedIR(optimized, {
                    evaluateSelector(node) {
                      return evaluateSelectorOnModel(node, model);
                    },
                  })]
                );
                const lowered = buildMembershipPlan(optimized, {
                  propertyDefs,
                  runtime,
                  scope: { system: model.system, version: model.version, csId: model.csId },
                });
                expect(lowered.ok).toBe(true);
                const logical = evaluateSetPlanCodes(lowered.plan, model);
                const compiled = compiler.compileExpand(optimized, { count: 100 });
                const rows = db.prepare(compiled.sql.text).all(compiled.sql.params);
                const sqlCodes = normalizeCodeList(rows.map(row => row.code));

                expect(scoped).toEqual(expectedCompose);
                expect(logical).toEqual(expectedCompose);
                expect(sqlCodes).toEqual(expectedCompose);
                checked++;
              }
            } finally {
              db.close();
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
