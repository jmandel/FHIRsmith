'use strict';

const {
  createGenericIRExecutor,
  executionResult,
} = require('../../tx/engine/generic-ir-executor');

describe('generic-ir-executor metadata flow', () => {
  test('preserves execution metadata through text filtering without array sidebands', async () => {
    const countMeta = [];
    const countUnclosed = [];
    const executor = createGenericIRExecutor({
      executeSelector: async () => executionResult([
        { code: 'A', display: 'Alpha' },
        { code: 'B', display: 'Beta' },
      ], {
        unclosed: 'grammar shell',
        limitedExpansion: true,
        tooCostly: true,
      }),
      applyTextFilterCandidates: (candidates, text) =>
        (candidates || []).filter(c => !text || String(c.display || '').includes(text)),
      onCountMetadata: meta => countMeta.push(meta),
      onCountUnclosed: unclosed => countUnclosed.push(unclosed),
    });

    const expanded = await executor.executeIR(
      { kind: 'selector', shape: 'whole', system: 'http://example.org/cs' },
      { text: 'Beta' }
    );

    expect(expanded).toEqual({
      candidates: [{ code: 'B', display: 'Beta' }],
      unclosed: 'grammar shell',
      limitedExpansion: true,
      tooCostly: true,
    });
    expect(expanded.candidates._unclosed).toBeUndefined();
    expect(expanded.candidates._limitedExpansion).toBeUndefined();
    expect(expanded.candidates._tooCostly).toBeUndefined();

    const counted = await executor.countForIR(
      { kind: 'selector', shape: 'whole', system: 'http://example.org/cs' },
      { text: 'Beta' }
    );

    expect(counted).toBe(1);
    expect(countUnclosed).toEqual(['grammar shell']);
    expect(countMeta).toHaveLength(1);
    expect(countMeta[0]).toMatchObject({
      unclosed: 'grammar shell',
      limitedExpansion: true,
      tooCostly: true,
      candidates: [
        { code: 'A', display: 'Alpha' },
        { code: 'B', display: 'Beta' },
      ],
    });
    expect(countMeta[0].candidates._unclosed).toBeUndefined();
    expect(countMeta[0].candidates._limitedExpansion).toBeUndefined();
    expect(countMeta[0].candidates._tooCostly).toBeUndefined();
  });
});
