const { CodeSystem } = require('../../../tx/library/codesystem');
const {
  buildSupplementOverlay,
  mergeSupplementOverlayIntoCandidates,
  overlayTouchesProperty,
} = require('../../../tx/supplements/overlay');

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
        { overlaySource: supp1 },
        { overlaySource: supp2 },
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
        { code: 'rank', value: 1, valueInteger: 1 },
        { code: 'tag', value: 'chem', valueString: 'chem' },
        expect.objectContaining({
          code: 'weight',
          uri: 'http://hl7.org/fhir/concept-properties#itemWeight',
          value: 1.5,
          valueDecimal: 1.5,
        }),
      ])
    );
    expect(candidates[0]._extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: 'http://example.org/ext', valueString: 'x' }),
      ])
    );
    expect(candidates[0]._extensions).toHaveLength(1);
  });

  test('tracks declared property definitions even when no concept currently carries a value', () => {
    const supp = new CodeSystem({
      resourceType: 'CodeSystem',
      url: 'http://example.org/supp-def-only',
      status: 'active',
      content: 'supplement',
      supplements: 'http://example.org/base',
      property: [{ code: 'rank', type: 'integer' }],
      concept: [{ code: 'A' }],
    });

    const overlay = buildSupplementOverlay({
      items: [{ overlaySource: supp }],
    });

    expect(overlayTouchesProperty(overlay, 'rank')).toBe(true);
    expect(overlay.byCode.get('A')?.properties || []).toEqual([]);
  });

  test('recognizes known expansion property aliases by URL and concept-properties URI', () => {
    const supp = supplement('http://example.org/supp-item-weight', [{
      code: 'A',
      extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/itemWeight', valueDecimal: 1.5 }],
    }]);

    const overlay = buildSupplementOverlay({
      items: [{ overlaySource: supp }],
    });

    expect(overlayTouchesProperty(overlay, 'http://hl7.org/fhir/StructureDefinition/itemWeight')).toBe(true);
    expect(overlayTouchesProperty(overlay, 'http://hl7.org/fhir/concept-properties#itemWeight')).toBe(true);
    expect(overlayTouchesProperty(overlay, 'weight')).toBe(true);
  });
});
