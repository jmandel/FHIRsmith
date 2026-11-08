// tx/engine-report.js: which engine served SNOMED CT, LOINC and RxNorm, and the startup check
// that stops a run labelled with one engine when the other serves any of them.

const { Library } = require('../../tx/library');
const { SqliteV2Factory } = require('../../tx/sqlite-v2/provider');
const { SnomedV2Factory } = require('../../tx/sqlite-v2/snomed');
const { engineReport, formatEngineReport, engineProblems, expectedEngine, allowedClassic } = require('../../tx/engine-report');

const SCT = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';
const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';

// factories as the library sees them: only system(), version(), getPartialVersion() and the class
function fake(Cls, system, version) {
  const f = Object.create(Cls.prototype);
  f.system = () => system;
  f.version = () => version;
  f.getPartialVersion = () => null;
  return f;
}
class SnomedServicesFactory {}
class LoincServicesFactory {}
class RxNormServicesFactory {}

const quiet = { info() {}, warn() {}, error() {} };
const ON = { valueSets: true, codeSystems: true };
const OFF = { valueSets: false, codeSystems: false };

function libraryWith(entries) {
  const lib = new Library(null, null, quiet, null);
  lib.lastTime = Date.now();
  for (const [source, factory] of entries) lib.registerProvider(source, factory);
  return lib;
}

const v2Library = () => libraryWith([
  ['/d/sct-intl-20260701.db', fake(SnomedV2Factory, SCT, 'http://snomed.info/sct/900000000000207008/version/20260701')],
  ['/d/loinc-2.83.db', fake(SqliteV2Factory, LOINC, '2.83')],
  ['/d/rxnorm-03022026.db', fake(SqliteV2Factory, RX, '03022026')]
]);
// the chaos and test-cases libraries: classic files, whatever branch runs them
const classicLibrary = () => libraryWith([
  ['/d/Snomed_Intl_20260701.cache', fake(SnomedServicesFactory, SCT, 'http://snomed.info/sct/900000000000207008/version/20260701')],
  ['/d/Loinc_2.83b.db', fake(LoincServicesFactory, LOINC, '2.83')],
  ['/d/rxnorm_03022026.db', fake(RxNormServicesFactory, RX, '03022026')]
]);

describe('engine report', () => {
  test('the library records provider class and file per registration', () => {
    const lib = classicLibrary();
    expect(lib.providerRegistrations.map(r => [r.provider, r.engine])).toEqual([
      ['SnomedServicesFactory', 'classic'], ['LoincServicesFactory', 'classic'], ['RxNormServicesFactory', 'classic']]);
    expect(v2Library().providerRegistrations.map(r => r.engine)).toEqual(['v2', 'v2', 'v2']);
  });

  test('labels: v2, classic, and mixed for an engine branch running classic files', () => {
    expect(engineReport(v2Library().providerRegistrations, ON).label).toBe('v2');
    expect(engineReport(classicLibrary().providerRegistrations, OFF).label).toBe('classic');
    // test-cases / chaos on sqlite-v2-next: classic SNOMED/LOINC/RxNorm, content store on by default
    expect(engineReport(classicLibrary().providerRegistrations, ON).label).toBe('mixed');
  });

  test('one startup line names every guarded system and the classic files', () => {
    const lib = libraryWith([
      ['/d/sct-intl-20260701.db', fake(SnomedV2Factory, SCT, 'x')],
      ['/d/loinc-2.83.db', fake(SqliteV2Factory, LOINC, '2.83')],
      ['/d/loinc-2.77-a.db', fake(LoincServicesFactory, LOINC, '2.77')]
    ]);
    expect(formatEngineReport(engineReport(lib.providerRegistrations, ON, 'ContentVsacProvider'))).toBe(
      'Engines: mixed | SNOMED CT v2 x1 | LOINC v2 x1 + classic x1 (loinc-2.77-a.db) | RxNorm none | ' +
      'content store VS on, CS on | VSAC ContentVsacProvider');
  });
});

describe('engine check', () => {
  test('a run labelled v2 with classic SNOMED CT fails, naming the provider and file', () => {
    const problems = engineProblems(engineReport(classicLibrary().providerRegistrations, ON), 'v2');
    expect(problems).toEqual([
      'SNOMED CT is served by classic SnomedServicesFactory (Snomed_Intl_20260701.cache)',
      'LOINC is served by classic LoincServicesFactory (Loinc_2.83b.db)',
      'RxNorm is served by classic RxNormServicesFactory (rxnorm_03022026.db)',
      'no sqlite-v2 file is registered for SNOMED CT, LOINC or RxNorm'
    ]);
  });

  test('a v2 run passes; the content store must be on', () => {
    expect(engineProblems(engineReport(v2Library().providerRegistrations, ON), 'v2')).toEqual([]);
    expect(engineProblems(engineReport(v2Library().providerRegistrations, { valueSets: true, codeSystems: false }), 'v2'))
      .toEqual([expect.stringMatching(/content store is not on/)]);
  });

  test('classic files a v2 run may keep are named explicitly', () => {
    const lib = libraryWith([
      ['/d/loinc-2.83.db', fake(SqliteV2Factory, LOINC, '2.83')],
      ['/d/loinc-2.77-a.db', fake(LoincServicesFactory, LOINC, '2.77')]
    ]);
    const report = engineReport(lib.providerRegistrations, ON);
    expect(engineProblems(report, 'v2')).toHaveLength(1);
    expect(engineProblems(report, 'v2', ['loinc-2.77-a.db'])).toEqual([]);
  });

  test('a classic run fails with any v2 file or the content store on', () => {
    expect(engineProblems(engineReport(classicLibrary().providerRegistrations, OFF), 'classic')).toEqual([]);
    expect(engineProblems(engineReport(classicLibrary().providerRegistrations, ON), 'classic'))
      .toEqual([expect.stringMatching(/content store is on/)]);
    expect(engineProblems(engineReport(v2Library().providerRegistrations, OFF), 'classic')).toHaveLength(3);
  });

  test('the expected engine comes from config, then FHIRSMITH_ENGINE; unknown names fail', () => {
    expect(expectedEngine({}, {})).toBeNull();
    expect(expectedEngine({}, { FHIRSMITH_ENGINE: 'v2' })).toBe('v2');
    expect(expectedEngine({ expectEngine: 'classic' }, { FHIRSMITH_ENGINE: 'v2' })).toBe('classic');
    expect(allowedClassic({}, { FHIRSMITH_ENGINE_ALLOW_CLASSIC: 'a.db, b.db' })).toEqual(['a.db', 'b.db']);
    expect(engineProblems(engineReport([], ON), 'sqlite')).toEqual([expect.stringMatching(/must be one of v2, classic/)]);
  });
});

describe('engine check at registration', () => {
  test('a v2 run stops at the first classic SNOMED CT file', () => {
    const lib = new Library(null, null, quiet, null);
    lib.lastTime = Date.now();
    lib.expectEngine = { expected: 'v2', allowClassic: [] };
    lib.registerProvider('/d/sct-intl-20260701.db', fake(SnomedV2Factory, SCT, 'x'));
    expect(() => lib.registerProvider('/d/Snomed_Intl_20260701.cache', fake(SnomedServicesFactory, SCT, 'y')))
      .toThrow('Engine check failed (expected v2): SNOMED CT is served by classic SnomedServicesFactory (Snomed_Intl_20260701.cache)');
  });

  test('other systems and allowed files pass', () => {
    const lib = new Library(null, null, quiet, null);
    lib.lastTime = Date.now();
    lib.expectEngine = { expected: 'v2', allowClassic: ['loinc-2.77-a.db'] };
    lib.registerProvider('/d/loinc-2.77-a.db', fake(LoincServicesFactory, LOINC, '2.77'));
    lib.registerProvider('ucum', fake(class UcumCodeSystemFactory {}, 'http://unitsofmeasure.org', '2.2'));
    expect(lib.providerRegistrations).toHaveLength(2);
  });
});
