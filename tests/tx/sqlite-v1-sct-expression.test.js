'use strict';

// SNOMED CT post-coordinated expression support over the generic sqlite-v1
// provider (tx/cs/sqlite-sct-expression.js + the expression hooks in
// tx/cs/cs-sqlite.js).
//
// Two layers:
//   1. Provider-level operations against the real International edition DB:
//      locate/validate, FillMissing display render, minimal code render,
//      structural equivalence, and subsumption — the same leaf operations the
//      binary reference provider exposes, checked for shape and self-consistency.
//   2. Full ValueSet membership through the real ValidateWorker against the two
//      official pc-list ValueSets (concept lists containing expressions):
//      structural membership is true for the list that contains the expression,
//      false for the one that does not.
//
// Loud-skips (never a silent green) if the DB or fixtures are absent.

const fs = require('fs');
const path = require('path');

const { SqliteCodeSystemFactory } = require('../../tx/cs/cs-sqlite.js');
const { ValidateWorker } = require('../../tx/workers/validate.js');
const { OperationContext } = require('../../tx/operation-context.js');
const { LanguageDefinitions } = require('../../library/languages.js');
const { I18nSupport } = require('../../library/i18nsupport.js');
const ValueSet = require('../../tx/library/valueset.js');

const DB_DIR = path.join(process.env.HOME, 'work', 'tx-dbs');
const SCT_DB = path.join(DB_DIR, 'sct-intl-20250201-v1.db');
const SCT = 'http://snomed.info/sct';
const FIX_DIR = path.join(
  process.env.HOME, '.fhir', 'packages',
  'hl7.fhir.uv.tx-ecosystem#current', 'package', 'tests', 'sct'
);
const quietLog = { error: () => {}, debug: () => {}, log: () => {}, info: () => {}, warn: () => {} };

const haveDb = fs.existsSync(SCT_DB);
const haveFix = fs.existsSync(FIX_DIR);
if (!haveDb || !haveFix) {
  // eslint-disable-next-line no-console
  console.warn(`[sqlite-v1-sct-expression] SKIPPING — missing ${!haveDb ? SCT_DB : ''} ${!haveFix ? FIX_DIR : ''}`.trim());
}
const describeIf = (haveDb && haveFix) ? describe : describe.skip;

describeIf('sqlite-v1 SNOMED post-coordinated expressions', () => {
  jest.setTimeout(120000);
  let factory, prov, i18n, langDefs, opc;

  beforeAll(async () => {
    langDefs = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
    i18n = new I18nSupport(path.join(__dirname, '../../translations'), langDefs);
    await i18n.load();
    opc = new OperationContext('en', i18n);
    factory = new SqliteCodeSystemFactory(i18n, SCT_DB);
    await factory.load();
    prov = await factory.build(opc, []);
  });

  afterAll(() => { if (factory) factory.close(); });

  // ---- parse + validate --------------------------------------------------

  test('simple (ungrouped) refinement validates and renders (FillMissing)', async () => {
    const code = '22298006:363698007=80891009';
    const loc = await prov.locate(code);
    expect(loc.context).toBeTruthy();
    expect(loc.context.isExpression).toBe(true);
    expect(await prov.code(loc.context)).toBe(code);
    expect(await prov.display(loc.context)).toBe(
      '22298006|Myocardial infarction|:363698007|Finding site|=80891009|Heart structure|'
    );
    // Grammatically-valid-but-unchecked (MRCM) process note.
    expect(await prov.incompleteValidationMessage(loc.context)).toMatch(/MRCM/);
    // An expression is active, not abstract, not inactive.
    expect(await prov.isInactive(loc.context)).toBe(false);
  });

  test('grouped refinement validates and renders with braces', async () => {
    const code = '128241005:{363698007=181268008}';
    const loc = await prov.locate(code);
    expect(loc.context).toBeTruthy();
    expect(await prov.display(loc.context)).toBe(
      '128241005|Inflammatory disease of liver|:{363698007|Finding site|=181268008|Entire liver|}'
    );
  });

  test('multiple focus concepts (a + b) validate and render', async () => {
    const code = '10200004+22298006';
    const loc = await prov.locate(code);
    expect(loc.context).toBeTruthy();
    expect(await prov.display(loc.context)).toBe(
      '10200004|Liver structure|+22298006|Myocardial infarction|'
    );
    expect(await prov.code(loc.context)).toBe('10200004+22298006');
  });

  test('invalid focus concept -> not located, invalid-expression message', async () => {
    const loc = await prov.locate('367430006:{272741003=240280071}');
    expect(loc.context).toBeNull();
    expect(loc.message).toMatch(/Not a valid expression: Concept 240280071 not found/);
  });

  test('non-attribute used as an attribute name -> invalid', async () => {
    // 24028007 |Right| is a value, not a concept-model attribute.
    const loc = await prov.locate('367430006:{24028007=272741003}');
    expect(loc.context).toBeNull();
    expect(loc.message).toMatch(/not valid in this context/);
  });

  // ---- equivalence (VS membership primitive) -----------------------------

  test('structural equivalence ignores whitespace / is not string equality', async () => {
    expect(await prov.sameConcept(
      '128241005:{363698007=181268008}',
      '128241005:{ 363698007 = 181268008 }'
    )).toBe(true);
    // Different refinement value -> not equivalent.
    expect(await prov.sameConcept(
      '128241005:{363698007=181268008}',
      '128241005:{363698007=362185005}'
    )).toBe(false);
  });

  // ---- subsumption -------------------------------------------------------

  test('subsumesTest: a refined expression is subsumed by its focus concept', async () => {
    // Adding a refinement makes the concept more specific.
    expect(await prov.subsumesTest('128241005', '128241005:{363698007=181268008}')).toBe('subsumes');
    expect(await prov.subsumesTest('128241005:{363698007=181268008}', '128241005')).toBe('subsumed-by');
  });

  test('subsumesTest: sibling refinements are not comparable', async () => {
    expect(await prov.subsumesTest(
      '128241005:{363698007=181268008}',
      '128241005:{363698007=362185005}'
    )).toBe('not-subsumed');
  });

  test('subsumesTest: a redundant refinement is equivalent to the focus concept', async () => {
    // 22298006 (Myocardial infarction) already has finding site = Myocardium,
    // which |Heart structure| subsumes; adding it is redundant.
    expect(await prov.subsumesTest('22298006:363698007=80891009', '22298006')).toBe('equivalent');
  });

  // ---- ValueSet membership through the ValidateWorker --------------------

  describe('ValueSet membership (concept lists containing expressions)', () => {
    const loadVs = (file) => JSON.parse(fs.readFileSync(path.join(FIX_DIR, file), 'utf8'));

    const makeProvider = (vsByUrl) => ({
      async getCodeSystemProvider(oc, url, version, supps) {
        return url === SCT ? await factory.build(oc, supps || []) : null;
      },
      async createCodeSystemProvider() { return null; },
      loadSupplements() { return []; },
      async findValueSet(oc, url) { return vsByUrl[url] ? new ValueSet(vsByUrl[url]) : null; },
      async getValueSetById() { return null; },
      findInAdditionalResources() { return null; },
      async listValueSets() { return []; },
    });

    const validateVs = async (code, url, vsByUrl) => {
      const worker = new ValidateWorker(opc, quietLog, makeProvider(vsByUrl), langDefs, i18n);
      let captured = null;
      const req = {
        method: 'POST', query: {}, params: {},
        body: {
          resourceType: 'Parameters',
          parameter: [
            { name: 'system', valueUri: SCT },
            { name: 'code', valueCode: code },
            { name: 'url', valueUri: url },
          ],
        },
      };
      const res = { status: () => res, json: (j) => { captured = j; return res; } };
      await worker.handleValueSet(req, res);
      return captured.parameter.find((p) => p.name === 'result').valueBoolean;
    };

    test('expression IS a member of the list that structurally contains it', async () => {
      const vs = loadVs('valueset-pc-list.json');
      const result = await validateVs('128241005:{363698007=181268008}', vs.url, { [vs.url]: vs });
      expect(result).toBe(true);
    });

    test('expression is NOT a member of a list that does not contain it', async () => {
      const vs = loadVs('valueset-pc-list-no-pc.json');
      const result = await validateVs('128241005:{363698007=181268008}', vs.url, { [vs.url]: vs });
      expect(result).toBe(false);
    });
  });

  // ---- gate: only SNOMED composes expressions ----------------------------

  test('expression support is enabled for SNOMED (flag or base-URI fallback)', () => {
    expect(prov._supportsExpressions()).toBe(true);
  });
});
