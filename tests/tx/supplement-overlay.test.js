const { CodeSystem } = require('../../tx/library/codesystem');
const { buildSupplementOverlay, mergeSupplementOverlayIntoCandidates } = require('../../tx/supplements/overlay');

function supplement(url, concepts) {
  return new CodeSystem({
    resourceType: 'CodeSystem',
    url,
    status: 'active',
    content: 'supplement',
    supplements: 'http://example.org/base',
    concept: concepts,
  });
}

describe('supplement overlay', () => {
  test('merges additive designations, properties, and extensions by code', () => {
    const supp1 = supplement('http://example.org/supp-1', [{
      code: 'A',
      designation: [{ language: 'fr', value: 'Alpha FR' }],
      property: [{ code: 'rank', valueInteger: 1 }],
      extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/itemWeight', valueDecimal: 1.5 }],
    }]);
    const supp2 = supplement('http://example.org/supp-2', [{
      code: 'A',
      designation: [{ language: 'de', value: 'Alpha DE' }],
      property: [{ code: 'tag', valueString: 'chem' }],
      extension: [{ url: 'http://example.org/ext', valueString: 'x' }],
    }]);

    const overlay = buildSupplementOverlay({
      items: [
        { overlaySource: { codeSystem: supp1 } },
        { overlaySource: { codeSystem: supp2 } },
      ],
    });

    const candidates = [{ code: 'A' }];
    mergeSupplementOverlayIntoCandidates(candidates, overlay, {
      includeDesignations: true,
      properties: ['rank', 'tag', 'http://hl7.org/fhir/StructureDefinition/itemWeight'],
    });

    expect(candidates[0]._designations).toHaveLength(2);
    expect(candidates[0]._designations.map(d => d.value).sort()).toEqual(['Alpha DE', 'Alpha FR']);
    expect(candidates[0]._properties).toEqual(
      expect.arrayContaining([
        { code: 'rank', value: 1 },
        { code: 'tag', value: 'chem' },
      ])
    );
    expect(candidates[0]._extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: 'http://hl7.org/fhir/StructureDefinition/itemWeight', valueDecimal: 1.5 }),
        expect.objectContaining({ url: 'http://example.org/ext', valueString: 'x' }),
      ])
    );
  });
});
