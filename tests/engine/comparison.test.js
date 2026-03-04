'use strict';

/**
 * Comparison tests: IR engine vs legacy expander.
 * Expands the same ValueSets via both paths and compares code sets.
 *
 * These tests use the orchestrator directly (not the server), so we can
 * control which path is used without restarting.
 */

const fs = require('fs');
const path = require('path');
const { expandViaIR } = require('../../tx/engine/orchestrator');
const { SqliteV0FactoryProvider } = require('../../tx/cs/cs-sqlite-v0');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const DB_DIR = '/home/exedev/tx-data';
const SNOMED_DB = path.join(DB_DIR, 'sct_intl_20250201.v0.db');
const LOINC_DB = path.join(DB_DIR, 'loinc_281_full.v0.db');
const RXNORM_DB = path.join(DB_DIR, 'rxnorm_02022026.v0.db');

const hasDBs = fs.existsSync(SNOMED_DB) && fs.existsSync(LOINC_DB);
const describeIfDBs = hasDBs ? describe : describe.skip;

let i18n, langDefs;
let factories = {};
let providerCache = new Map();

beforeAll(async () => {
  langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);

  factories.snomed = new SqliteV0FactoryProvider(i18n, SNOMED_DB);
  await factories.snomed.load();
  factories.loinc = new SqliteV0FactoryProvider(i18n, LOINC_DB);
  await factories.loinc.load();
  if (fs.existsSync(RXNORM_DB)) {
    factories.rxnorm = new SqliteV0FactoryProvider(i18n, RXNORM_DB);
    await factories.rxnorm.load();
  }
});

afterAll(() => {
  for (const p of providerCache.values()) p?.close?.();
});

function makeOpContext() {
  return new OperationContext('en', i18n);
}

async function findProvider(system) {
  if (providerCache.has(system)) return providerCache.get(system);
  let factory;
  if (system === 'http://snomed.info/sct') factory = factories.snomed;
  else if (system === 'http://loinc.org') factory = factories.loinc;
  else if (system === 'http://www.nlm.nih.gov/research/umls/rxnorm') factory = factories.rxnorm;
  if (factory) {
    const p = await factory.build(makeOpContext(), null);
    providerCache.set(system, p);
    return p;
  }
  return null;
}

/**
 * Run IR expansion and legacy filter-protocol expansion, compare code sets.
 */
async function compareExpansion(vs, opts = {}) {
  const { activeOnly = false, count = 500000 } = opts;
  const provider = await findProvider(vs.compose.include[0].system);
  if (!provider) throw new Error('No provider for ' + vs.compose.include[0].system);

  // IR expansion
  const irResult = await expandViaIR(vs, {
    findProvider,
    activeOnly,
    count,
  });

  // Legacy expansion via filter protocol
  const legacyCodes = new Set();
  for (const inc of vs.compose.include || []) {
    if (inc.concept) {
      for (const cc of inc.concept) {
        const loc = await provider.locate(cc.code);
        if (loc.context) {
          if (!activeOnly || !(await provider.isInactive(loc.context))) {
            legacyCodes.add(cc.code);
          }
        }
      }
    } else if (inc.filter) {
      const prep = await provider.getPrepContext(true);
      for (const f of inc.filter) {
        await provider.filter(prep, f.property, f.op, f.value);
      }
      const sets = await provider.executeFilters(prep);
      if (sets && sets.length > 0) {
        while (await provider.filterMore(prep, sets[0])) {
          const ctx = await provider.filterConcept(prep, sets[0]);
          const code = await provider.code(ctx);
          const inactive = await provider.isInactive(ctx);
          if (!activeOnly || !inactive) {
            // Cross-check additional filter sets
            let ok = true;
            for (let i = 1; i < sets.length; i++) {
              const check = await provider.filterCheck(prep, sets[i], ctx);
              if (check !== true) { ok = false; break; }
            }
            if (ok) legacyCodes.add(code);
          }
        }
      }
    } else {
      // Whole system — too many codes, skip
    }
  }

  // Handle excludes
  const excludeCodes = new Set();
  for (const exc of vs.compose.exclude || []) {
    if (exc.concept) {
      for (const cc of exc.concept) excludeCodes.add(cc.code);
    } else if (exc.filter) {
      const prep = await provider.getPrepContext(true);
      for (const f of exc.filter) {
        await provider.filter(prep, f.property, f.op, f.value);
      }
      const sets = await provider.executeFilters(prep);
      if (sets && sets.length > 0) {
        while (await provider.filterMore(prep, sets[0])) {
          const ctx = await provider.filterConcept(prep, sets[0]);
          excludeCodes.add(await provider.code(ctx));
        }
      }
    }
  }
  for (const c of excludeCodes) legacyCodes.delete(c);

  const irCodes = new Set(irResult.expansion.contains.map(c => c.code));

  return {
    ir: irCodes,
    legacy: legacyCodes,
    irOnly: new Set([...irCodes].filter(c => !legacyCodes.has(c))),
    legacyOnly: new Set([...legacyCodes].filter(c => !irCodes.has(c))),
    match: irCodes.size === legacyCodes.size && [...irCodes].every(c => legacyCodes.has(c)),
  };
}

describeIfDBs('IR vs Legacy comparison', () => {

  test('SNOMED is-a Diabetes mellitus (73211009)', async () => {
    const result = await compareExpansion({
      resourceType: 'ValueSet',
      compose: {
        include: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }],
      },
    }, { activeOnly: true });

    if (!result.match) {
      console.log(`  IR: ${result.ir.size}, Legacy: ${result.legacy.size}`);
      if (result.irOnly.size > 0) console.log(`  IR-only (first 5): ${[...result.irOnly].slice(0, 5).join(', ')}`);
      if (result.legacyOnly.size > 0) console.log(`  Legacy-only (first 5): ${[...result.legacyOnly].slice(0, 5).join(', ')}`);
    }
    expect(result.match).toBe(true);
  });

  test('SNOMED is-a minus descendent-of (diff)', async () => {
    const result = await compareExpansion({
      resourceType: 'ValueSet',
      compose: {
        include: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] }],
        exclude: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] }],
      },
    }, { activeOnly: true });

    if (!result.match) {
      console.log(`  IR: ${result.ir.size}, Legacy: ${result.legacy.size}`);
      if (result.irOnly.size > 0) console.log(`  IR-only (first 5): ${[...result.irOnly].slice(0, 5).join(', ')}`);
      if (result.legacyOnly.size > 0) console.log(`  Legacy-only (first 5): ${[...result.legacyOnly].slice(0, 5).join(', ')}`);
    }
    expect(result.match).toBe(true);
  });

  test('SNOMED concept enumeration', async () => {
    const result = await compareExpansion({
      resourceType: 'ValueSet',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [
            { code: '73211009' },
            { code: '44054006' },
            { code: '46635009' },
            { code: '999999999' },  // non-existent
          ],
        }],
      },
    });

    if (!result.match) {
      console.log(`  IR: ${result.ir.size}, Legacy: ${result.legacy.size}`);
      if (result.irOnly.size > 0) console.log(`  IR-only: ${[...result.irOnly].join(', ')}`);
      if (result.legacyOnly.size > 0) console.log(`  Legacy-only: ${[...result.legacyOnly].join(', ')}`);
    }
    expect(result.match).toBe(true);
  });

  test('SNOMED descendent-of (excludes self)', async () => {
    const result = await compareExpansion({
      resourceType: 'ValueSet',
      compose: {
        include: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'descendent-of', value: '73211009' }] }],
      },
    }, { activeOnly: true });

    if (!result.match) {
      console.log(`  IR: ${result.ir.size}, Legacy: ${result.legacy.size}`);
      if (result.irOnly.size > 0) console.log(`  IR-only (first 5): ${[...result.irOnly].slice(0, 5).join(', ')}`);
      if (result.legacyOnly.size > 0) console.log(`  Legacy-only (first 5): ${[...result.legacyOnly].slice(0, 5).join(', ')}`);
    }
    expect(result.match).toBe(true);
  });

  test('SNOMED is-a Clinical finding (large set)', async () => {
    // Clinical finding: 404684003 — ~120K codes
    const result = await compareExpansion({
      resourceType: 'ValueSet',
      compose: {
        include: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '404684003' }] }],
      },
    }, { activeOnly: true });

    if (!result.match) {
      console.log(`  IR: ${result.ir.size}, Legacy: ${result.legacy.size}`);
      console.log(`  IR-only: ${result.irOnly.size}, Legacy-only: ${result.legacyOnly.size}`);
    }
    expect(result.match).toBe(true);
  }, 30000);

  test('LOINC CLASSTYPE=1 (laboratory)', async () => {
    const result = await compareExpansion({
      resourceType: 'ValueSet',
      compose: {
        include: [{ system: 'http://loinc.org', filter: [{ property: 'CLASSTYPE', op: '=', value: '1' }] }],
      },
    });

    if (!result.match) {
      console.log(`  IR: ${result.ir.size}, Legacy: ${result.legacy.size}`);
      if (result.irOnly.size > 0) console.log(`  IR-only (first 5): ${[...result.irOnly].slice(0, 5).join(', ')}`);
      if (result.legacyOnly.size > 0) console.log(`  Legacy-only (first 5): ${[...result.legacyOnly].slice(0, 5).join(', ')}`);
    }
    expect(result.match).toBe(true);
  }, 30000);

  test('LOINC hierarchy is-a', async () => {
    const result = await compareExpansion({
      resourceType: 'ValueSet',
      compose: {
        include: [{ system: 'http://loinc.org', filter: [{ property: 'concept', op: 'is-a', value: 'LP7839-6' }] }],
      },
    });

    if (!result.match) {
      console.log(`  IR: ${result.ir.size}, Legacy: ${result.legacy.size}`);
      if (result.irOnly.size > 0) console.log(`  IR-only (first 5): ${[...result.irOnly].slice(0, 5).join(', ')}`);
      if (result.legacyOnly.size > 0) console.log(`  Legacy-only (first 5): ${[...result.legacyOnly].slice(0, 5).join(', ')}`);
    }
    expect(result.match).toBe(true);
  });

  test('SNOMED concept enumeration with exclude', async () => {
    const result = await compareExpansion({
      resourceType: 'ValueSet',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [
            { code: '73211009' },
            { code: '44054006' },
            { code: '46635009' },
          ],
        }],
        exclude: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '44054006' }],
        }],
      },
    });

    expect(result.match).toBe(true);
    expect(result.ir.size).toBe(2);
  });

  test('SNOMED activeOnly filters inactive concepts', async () => {
    // 100005 is an inactive SNOMED concept
    const withInactive = await compareExpansion({
      resourceType: 'ValueSet',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '100005' }, { code: '73211009' }],
        }],
      },
    }, { activeOnly: false });
    expect(withInactive.ir.size).toBe(2);

    const withoutInactive = await compareExpansion({
      resourceType: 'ValueSet',
      compose: {
        include: [{
          system: 'http://snomed.info/sct',
          concept: [{ code: '100005' }, { code: '73211009' }],
        }],
      },
    }, { activeOnly: true });
    expect(withoutInactive.ir.size).toBe(1);
    expect(withoutInactive.ir.has('73211009')).toBe(true);
  });
});
