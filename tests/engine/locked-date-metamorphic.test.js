'use strict';

const { expandViaIR, resolveLockedDateVersions } = require('../../tx/engine/orchestrator');
const { buildIRFromValueSet } = require('../../tx/engine/build-ir');
const { interpretScopedIR } = require('../../tx/engine/scoped-ir-interpreter');
const { buildTinyScopedModel } = require('../support/terminology-model/model');
const { evaluateSelectorOnModel } = require('../support/engine/compose-eval');
const { normalizeCodeList } = require('../support/terminology-model/normalize-results');

function makeProvider(model, version, seenVersions) {
  return {
    system() { return model.system; },
    version() { return version; },
    contentMode() { return 'complete'; },
    status() { return { status: 'active' }; },
    async executeIR(subtree, opts = {}) {
      seenVersions.push(subtree?.version || null);
      const allCodes = [...interpretScopedIR(subtree, {
        evaluateSelector(node) {
          return evaluateSelectorOnModel(node, model);
        },
      })].sort();
      const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
      const count = Number.isInteger(opts.count) ? opts.count : allCodes.length;
      const slice = allCodes.slice(offset, offset + count);
      return {
        candidates: slice.map(code => {
          const row = model.concepts.find(c => c.code === code);
          return {
            code,
            display: row?.display ?? null,
            definition: row?.definition ?? null,
            active: !!row?.active,
            conceptId: row?.concept_id ?? null,
          };
        }),
      };
    },
    async countForIR(subtree) {
      seenVersions.push(subtree?.version || null);
      return [...interpretScopedIR(subtree, {
        evaluateSelector(node) {
          return evaluateSelectorOnModel(node, model);
        },
      })].length;
    },
  };
}

describe('lockedDate metamorphic equivalence', () => {
  test('lockedDate binding is exposed as a first-class engine stage', async () => {
    const raw = buildIRFromValueSet({
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/locked-stage',
      compose: {
        lockedDate: '2025-01-01',
        include: [{ system: 'urn:sys:A' }],
      },
    });
    const warnings = [];
    const bound = await resolveLockedDateVersions(raw, async () => 'A.v1', warnings);
    expect(bound.version || bound.items?.[0]?.version || bound.left?.version).toBeTruthy();
    expect(JSON.stringify(bound)).not.toContain('"lockedDate":"2025-01-01"');
    expect(warnings).toEqual([]);
  });

  test('replacing lockedDate with the resolved explicit version preserves expansion semantics', async () => {
    const model = buildTinyScopedModel({ activeMask: 3, classMask: 3, refsetMask: 0, hasEdge: true });
    const seenVersions = [];
    const provider = makeProvider(model, 'A.v1', seenVersions);

    const lockedVs = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/locked',
      compose: {
        lockedDate: '2025-01-01',
        include: [{ system: 'urn:sys:A' }],
      },
    };
    const explicitVs = {
      resourceType: 'ValueSet',
      url: 'http://example.org/vs/explicit',
      compose: {
        include: [{ system: 'urn:sys:A', version: 'A.v1' }],
      },
    };

    const commonOpts = {
      resolveValueSet: async () => null,
      findProvider: async (system, version) => {
        expect(system).toBe('urn:sys:A');
        if (version != null) expect(version).toBe('A.v1');
        return provider;
      },
      count: 50,
      resolveVersionAtDate: async (system, lockedDate) => {
        expect(system).toBe('urn:sys:A');
        expect(lockedDate).toBe('2025-01-01');
        return 'A.v1';
      },
    };

    const locked = await expandViaIR(lockedVs, commonOpts);
    const explicit = await expandViaIR(explicitVs, commonOpts);

    expect(normalizeCodeList((locked.expansion?.contains || []).map(c => c.code))).toEqual(
      normalizeCodeList((explicit.expansion?.contains || []).map(c => c.code))
    );
    expect((locked.expansion?.contains || []).every(c => c.version === 'A.v1')).toBe(true);
    expect((explicit.expansion?.contains || []).every(c => c.version === 'A.v1')).toBe(true);
    expect(seenVersions).toContain('A.v1');
  });
});
