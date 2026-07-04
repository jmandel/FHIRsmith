'use strict';

// Focused test for the sqlite-v1 provider-class SELECTION mechanism.
//
// The generic base provider (SqliteCodeSystemProvider) is driven entirely by DB
// metadata. Terminology-specific CODE lives in a subclass that declares the code
// system URL(s) it handles via `static handledSystems`. The factory selects the
// class at runtime by matching the DB's NATURAL identity (code_system.base_uri)
// against the registered classes — no class name is stored in the data.
//
// Asserts:
//   - a DB whose base_uri is http://snomed.info/sct yields the SNOMED subclass;
//   - a generic (LOINC/RxNorm-shaped) DB yields the plain base class;
//   - and NO providerClass cs_config key is written by either fixture.

const path = require('path');
const fs = require('fs');
const os = require('os');

const { openV1Database, V1Writer } = require('../../tx/importers/sqlite-v1-core');
const { SqliteCodeSystemFactory, SqliteCodeSystemProvider } = require('../../tx/cs/cs-sqlite');
const { SnomedSqliteCodeSystemProvider } = require('../../tx/cs/cs-sqlite-snomed');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

function buildMinimalDb(dbPath, baseUri) {
  const db = openV1Database(dbPath, { overwrite: true });
  const writer = new V1Writer(db);
  const csId = writer.codeSystem({
    baseUri,
    version: '1',
    canonicalUri: `${baseUri}|1`,
    name: 'Minimal',
    description: 'selection fixture',
  });
  writer.setConfig(csId, 'caseSensitive', 1);
  writer.setConfig(csId, 'defaultLanguage', 'en');
  writer.addConcept(csId, { code: 'X', display: 'Concept X' });
  const runId = writer.beginAudit({ targetDb: dbPath, terminology: 'min', version: '1' });
  writer.buildClosure(csId, { edgeSetId: 1 });
  writer.buildSearchIndex(csId);
  writer.finishAudit(runId, { status: 'success' });
  writer.finalize({ caseSensitive: true });
  db.close();
}

describe('sqlite-v1 provider-class selection (by base_uri)', () => {
  let tmpDir, opContext, i18n;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-v1-selection-'));
    const langDefs = await TestUtilities.loadLanguageDefinitions();
    i18n = await TestUtilities.loadTranslations(langDefs);
    opContext = new OperationContext('en', i18n);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function providerFor(baseUri, name) {
    const dbPath = path.join(tmpDir, `${name}.db`);
    buildMinimalDb(dbPath, baseUri);
    const factory = new SqliteCodeSystemFactory(i18n, dbPath);
    await factory.load();
    const provider = await factory.build(opContext, []);
    // No class name is stored in the data.
    const hasProviderClass = factory.db
      .prepare('SELECT 1 FROM cs_config WHERE cs_id = ? AND key = ?')
      .get(factory.csId, 'providerClass');
    return { provider, factory, hasProviderClass };
  }

  test('a SNOMED CT DB (base_uri http://snomed.info/sct) yields the SNOMED subclass', async () => {
    const { provider, factory, hasProviderClass } = await providerFor('http://snomed.info/sct', 'snomed');
    expect(provider).toBeInstanceOf(SnomedSqliteCodeSystemProvider);
    expect(provider).toBeInstanceOf(SqliteCodeSystemProvider); // subclass IS-A base
    expect(hasProviderClass).toBeUndefined();
    provider.close();
    await factory.close();
  });

  test('a generic LOINC DB yields the plain base provider (no subclass)', async () => {
    const { provider, factory, hasProviderClass } = await providerFor('http://loinc.org', 'loinc');
    expect(provider).toBeInstanceOf(SqliteCodeSystemProvider);
    expect(provider).not.toBeInstanceOf(SnomedSqliteCodeSystemProvider);
    expect(hasProviderClass).toBeUndefined();
    provider.close();
    await factory.close();
  });

  test('a generic RxNorm DB yields the plain base provider (no subclass)', async () => {
    const { provider, factory, hasProviderClass } = await providerFor('http://www.nlm.nih.gov/research/umls/rxnorm', 'rxnorm');
    expect(provider).toBeInstanceOf(SqliteCodeSystemProvider);
    expect(provider).not.toBeInstanceOf(SnomedSqliteCodeSystemProvider);
    expect(hasProviderClass).toBeUndefined();
    provider.close();
    await factory.close();
  });
});
