'use strict';

const { buildIRFromValueSet } = require('../../tx/engine/build-ir');
const { resolveImports } = require('../../tx/engine/resolve-imports');
const { optimize } = require('../../tx/engine/rewrite');
const { interpretScopedIR } = require('../../tx/engine/scoped-ir-interpreter');
const {
  buildTinyScopedModel,
} = require('../support/terminology-model/model');
const { normalizeCodeList } = require('../support/terminology-model/normalize-results');
const { evaluateSelectorOnModel } = require('../support/engine/compose-eval');

function codeSet(expr, model) {
  return normalizeCodeList(
    [...interpretScopedIR(expr, {
      evaluateSelector(node) {
        return evaluateSelectorOnModel(node, model);
      },
    })]
  );
}

describe('IR metamorphic invariants', () => {
  const model = buildTinyScopedModel({ activeMask: 3, classMask: 1, refsetMask: 1, hasEdge: true });

  test('reordering include/exclude components preserves semantics', async () => {
    const left = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/reordered-left',
      compose: {
        include: [
          { system: 'urn:sys:A', filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] },
          { system: 'urn:sys:A', concept: [{ code: 'B' }] },
        ],
        exclude: [
          { system: 'urn:sys:A', filter: [{ property: 'code', op: 'regex', value: '^B$' }] },
        ],
      },
    };
    const right = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/reordered-right',
      compose: {
        include: [...left.compose.include].reverse(),
        exclude: [...left.compose.exclude].reverse(),
      },
    };

    const leftExpr = optimize(await resolveImports(buildIRFromValueSet(left), async () => null));
    const rightExpr = optimize(await resolveImports(buildIRFromValueSet(right), async () => null));

    expect(codeSet(leftExpr, model)).toEqual(codeSet(rightExpr, model));
  });

  test('inline imports and resolved imports preserve semantics', async () => {
    const imported = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/imported',
      compose: {
        include: [{ system: 'urn:sys:A', filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }],
      },
    };
    const withImport = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/with-import',
      compose: {
        include: [{ system: 'urn:sys:A', valueSet: [imported.url] }],
      },
    };
    const inlineEquivalent = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/inline-equivalent',
      compose: {
        include: [{ system: 'urn:sys:A', filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }],
      },
    };
    const byUrl = new Map([[imported.url, imported]]);

    const importedExpr = optimize(await resolveImports(buildIRFromValueSet(withImport), async url => byUrl.get(url) || null));
    const inlineExpr = optimize(await resolveImports(buildIRFromValueSet(inlineEquivalent), async () => null));

    expect(codeSet(importedExpr, model)).toEqual(codeSet(inlineExpr, model));
  });

  test('duplicating and re-nesting commutative branches preserves semantics after optimization', async () => {
    const base = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/duplicate-base',
      compose: {
        include: [
          { system: 'urn:sys:A', concept: [{ code: 'A' }] },
          { system: 'urn:sys:A', concept: [{ code: 'B' }] },
        ],
      },
    };
    const duplicated = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/duplicate-nested',
      compose: {
        include: [
          { system: 'urn:sys:A', concept: [{ code: 'A' }] },
          { system: 'urn:sys:A', concept: [{ code: 'A' }] },
          { system: 'urn:sys:A', concept: [{ code: 'B' }] },
        ],
      },
    };

    const baseExpr = optimize(await resolveImports(buildIRFromValueSet(base), async () => null));
    const dupExpr = optimize(await resolveImports(buildIRFromValueSet(duplicated), async () => null));

    expect(codeSet(baseExpr, model)).toEqual(codeSet(dupExpr, model));
  });
});
