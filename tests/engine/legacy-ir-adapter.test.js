'use strict';

const fs = require('fs');
const path = require('path');
const { wrapWithLegacyIR } = require('../../tx/engine/legacy-ir-adapter');
const { SqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');
const IR = require('../../tx/engine/ir');

const DB_DIR = '/home/exedev/tx-data';
const SNOMED_DB = path.join(DB_DIR, 'sct_intl_20250201.v0.db');

const hasDBs = fs.existsSync(SNOMED_DB);
const describeIfDBs = hasDBs ? describe : describe.skip;

let i18n, langDefs;

beforeAll(async () => {
  langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
});

function makeOpContext() {
  return new OperationContext('en', i18n);
}

describeIfDBs('LegacyIRAdapter', () => {
  let factory, rawProvider;

  beforeAll(async () => {
    factory = new SqliteV0FactoryProvider(i18n, SNOMED_DB);
    await factory.load();
  });

  beforeEach(async () => {
    rawProvider = await factory.build(makeOpContext(), null);
  });

  afterEach(() => {
    rawProvider?.close();
  });

  test('wrapping preserves system/version', async () => {
    const wrapped = wrapWithLegacyIR(rawProvider);
    expect(wrapped.system()).toBe(rawProvider.system());
    expect(wrapped.version()).toBe(rawProvider.version());
    expect(wrapped.hasExecuteIR()).toBe(true);
  });

  test('executeIR with concept selector', async () => {
    const wrapped = wrapWithLegacyIR(rawProvider);
    const subtree = IR.selector({
      system: 'http://snomed.info/sct',
      shape: 'concept',
      conceptCodes: [{ code: '73211009' }, { code: '44054006' }],
    });

    const result = await wrapped.executeIR(subtree);
    expect(result.candidates.length).toBe(2);
    const codes = new Set(result.candidates.map(c => c.code));
    expect(codes.has('73211009')).toBe(true);
    expect(codes.has('44054006')).toBe(true);
    for (const c of result.candidates) {
      expect(c.display).toBeTruthy();
    }
  });

  test('executeIR with filter selector (is-a)', async () => {
    const wrapped = wrapWithLegacyIR(rawProvider);
    const subtree = IR.selector({
      system: 'http://snomed.info/sct',
      shape: 'filter',
      filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    });

    const result = await wrapped.executeIR(subtree, { activeOnly: true });
    expect(result.candidates.length).toBeGreaterThan(10);
    // All should be active
    for (const c of result.candidates) {
      expect(c.active).toBe(true);
    }
  });

  test('executeIR with union', async () => {
    const wrapped = wrapWithLegacyIR(rawProvider);
    const subtree = IR.union([
      IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'concept',
        conceptCodes: [{ code: '73211009' }],
      }),
      IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'concept',
        conceptCodes: [{ code: '44054006' }, { code: '73211009' }],  // duplicate
      }),
    ]);

    const result = await wrapped.executeIR(subtree);
    // Should deduplicate
    expect(result.candidates.length).toBe(2);
  });

  test('executeIR with diff', async () => {
    const wrapped = wrapWithLegacyIR(rawProvider);
    const subtree = IR.diff(
      IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'concept',
        conceptCodes: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }],
      }),
      IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'concept',
        conceptCodes: [{ code: '44054006' }],
      })
    );

    const result = await wrapped.executeIR(subtree);
    expect(result.candidates.length).toBe(2);
    const codes = new Set(result.candidates.map(c => c.code));
    expect(codes.has('73211009')).toBe(true);
    expect(codes.has('46635009')).toBe(true);
    expect(codes.has('44054006')).toBe(false);
  });

  test('executeIR with intersect', async () => {
    const wrapped = wrapWithLegacyIR(rawProvider);
    // Intersect: is-a Diabetes AND concept set
    const subtree = IR.intersect([
      IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
      }),
      IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'concept',
        conceptCodes: [{ code: '73211009' }, { code: '44054006' }, { code: '404684003' }],
        // 73211009 and 44054006 are both under Diabetes, 404684003 (Clinical finding) is not
      }),
    ]);

    const result = await wrapped.executeIR(subtree);
    const codes = new Set(result.candidates.map(c => c.code));
    expect(codes.has('73211009')).toBe(true);  // is Diabetes itself
    expect(codes.has('44054006')).toBe(true);   // is subtype of Diabetes
    expect(codes.has('404684003')).toBe(false); // is ancestor, not descendant
  });

  test('membershipForIR', async () => {
    const wrapped = wrapWithLegacyIR(rawProvider);
    const subtree = IR.selector({
      system: 'http://snomed.info/sct',
      shape: 'concept',
      conceptCodes: [{ code: '73211009' }, { code: '44054006' }],
    });

    const membership = await wrapped.membershipForIR(subtree);
    expect(membership.has('73211009')).toBe(true);
    expect(membership.has('44054006')).toBe(true);
    expect(membership.has('46635009')).toBe(false);
  });

  test('empty subtree', async () => {
    const wrapped = wrapWithLegacyIR(rawProvider);
    const result = await wrapped.executeIR(IR.empty());
    expect(result.candidates).toEqual([]);
  });

  test('adapter results match native for concept selector', async () => {
    // Compare adapter results with native executeIR
    const subtree = IR.selector({
      system: 'http://snomed.info/sct',
      shape: 'concept',
      conceptCodes: [{ code: '73211009' }, { code: '44054006' }, { code: '46635009' }],
    });

    const nativeResult = rawProvider.executeIR(subtree);
    const wrapped = wrapWithLegacyIR(rawProvider);
    const adapterResult = await wrapped.executeIR(subtree);

    // Same codes
    const nativeCodes = new Set(nativeResult.candidates.map(c => c.code));
    const adapterCodes = new Set(adapterResult.candidates.map(c => c.code));
    expect(adapterCodes).toEqual(nativeCodes);
  });

  test('adapter results match native for is-a filter', async () => {
    const subtree = IR.selector({
      system: 'http://snomed.info/sct',
      shape: 'filter',
      filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
    });

    const nativeResult = rawProvider.executeIR(subtree, { activeOnly: true });
    const wrapped = wrapWithLegacyIR(rawProvider);
    const adapterResult = await wrapped.executeIR(subtree, { activeOnly: true });

    // Same number of results
    expect(adapterResult.candidates.length).toBe(nativeResult.candidates.length);

    // Same codes
    const nativeCodes = new Set(nativeResult.candidates.map(c => c.code));
    const adapterCodes = new Set(adapterResult.candidates.map(c => c.code));
    expect(adapterCodes).toEqual(nativeCodes);
  });

  test('adapter results match native for diff', async () => {
    const subtree = IR.diff(
      IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
      }),
      IR.selector({
        system: 'http://snomed.info/sct',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'is-a', value: '44054006' }],
      })
    );

    const nativeResult = rawProvider.executeIR(subtree, { activeOnly: true });
    const wrapped = wrapWithLegacyIR(rawProvider);
    const adapterResult = await wrapped.executeIR(subtree, { activeOnly: true });

    const nativeCodes = new Set(nativeResult.candidates.map(c => c.code));
    const adapterCodes = new Set(adapterResult.candidates.map(c => c.code));
    expect(adapterCodes).toEqual(nativeCodes);
  });
});
