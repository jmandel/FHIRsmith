'use strict';

const { readFileSync } = require('fs');
const IR = require('../../../tx/engine/ir');
const { CodeSystem } = require('../../../tx/library/codesystem');
const { wrapIRProviderWithSupplements } = require('../../../tx/supplements/ir-provider');
const { OperationContext } = require('../../../tx/operation-context');
const { USStateFactoryProvider } = require('../../../tx/cs/cs-usstates');
const { UcumCodeSystemFactory } = require('../../../tx/cs/cs-ucum');
const { UcumService } = require('../../../tx/library/ucum-service');
const { TestUtilities } = require('../../test-utilities');

let i18n;

beforeAll(async () => {
  i18n = await TestUtilities.loadTranslations();
});

function makeSupplement({ url, targetSystem, targetVersion = null, concepts }) {
  return new CodeSystem({
    resourceType: 'CodeSystem',
    url,
    version: '1.0',
    status: 'active',
    content: 'supplement',
    supplements: targetVersion ? `${targetSystem}|${targetVersion}` : targetSystem,
    concept: concepts,
  });
}

describe('supplement-aware IR adapter-backed providers', () => {
  test('US states adapter provider honors inline supplement numeric filters before paging', async () => {
    const opContext = new OperationContext('en', i18n);
    const factory = new USStateFactoryProvider(opContext.i18n);
    await factory.load();
    const provider = factory.build(opContext, []);

    const supplement = makeSupplement({
      url: 'http://example.org/supp/us-states-d20',
      targetSystem: provider.system(),
      concepts: [
        { code: 'OK', property: [{ code: 'd20-roll', valueInteger: 20 }] },
        {
          code: 'TX',
          designation: [{ language: 'en', value: 'Lone Star bonus' }],
          property: [{ code: 'd20-roll', valueInteger: 20 }],
        },
      ],
    });

    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [{ overlaySource: supplement }],
    });

    const subtree = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'filter',
      filterClauses: [{ property: 'd20-roll', op: '=', value: '20' }],
    });

    const result = await wrapped.executeIR(subtree, { offset: 1, count: 1 });
    expect(result.candidates.map(candidate => candidate.code)).toEqual(['TX']);
    expect(await wrapped.countForIR(subtree)).toBe(2);

    const membership = await wrapped.membershipForIR(subtree);
    expect(membership.has('OK')).toBe(true);
    expect(membership.has('TX')).toBe(true);
    expect(membership.has('CA')).toBe(false);
  });

  test('UCUM adapter provider honors inline supplement designation text matching on explicit concept subsets', async () => {
    const ucumEssenceXml = readFileSync('./tx/data/ucum-essence.xml', 'utf8');
    const ucumService = new UcumService();
    ucumService.init(ucumEssenceXml);

    const opContext = new OperationContext('en', i18n);
    const factory = new UcumCodeSystemFactory(opContext.i18n, ucumService);
    const provider = factory.build(opContext, null);

    const supplement = makeSupplement({
      url: 'http://example.org/supp/ucum-display',
      targetSystem: provider.system(),
      concepts: [
        { code: 'm', designation: [{ language: 'en', value: 'Lone metre bonus' }] },
        { code: 'cm', designation: [{ language: 'en', value: 'Grouped centimetre bonus' }] },
      ],
    });

    const wrapped = wrapIRProviderWithSupplements(provider, {
      items: [{ overlaySource: supplement }],
    });

    const subtree = IR.selector({
      system: provider.system(),
      version: provider.version(),
      shape: 'concept',
      conceptCodes: [
        { code: 'm' },
        { code: 'cm' },
        { code: 'kg' },
      ],
    });

    const result = await wrapped.executeIR(subtree, { text: 'Lone metre bonus' });
    expect(result.candidates.map(candidate => candidate.code).sort()).toEqual(['cm', 'm']);
    expect(await wrapped.countForIR(subtree, { text: 'Lone metre bonus' })).toBe(2);
  });
});
