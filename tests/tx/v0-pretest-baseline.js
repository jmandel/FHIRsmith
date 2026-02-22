'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const folders = require('../../library/folder-setup');
folders.init(path.join(__dirname, '../../data'));

const { Library } = require('../../tx/library');
const { OperationContext } = require('../../tx/operation-context');
const { TxParameters } = require('../../tx/params');
const { SearchFilterText } = require('../../tx/library/designations');
const ValueSet = require('../../tx/library/valueset');
const { ExpandWorker, ValueSetExpander } = require('../../tx/workers/expand-v2');

const SYS = {
  SCT: 'http://snomed.info/sct',
  LOINC: 'http://loinc.org',
  RXNORM: 'http://www.nlm.nih.gov/research/umls/rxnorm',
};

const log = {
  info: () => {},
  debug: () => {},
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERR]', ...a),
};

function flattenContains(contains, out = []) {
  for (const c of contains || []) {
    out.push(c);
    if (c.contains) flattenContains(c.contains, out);
  }
  return out;
}

function normalizeKeys(result) {
  const out = [];
  flattenContains(result?.expansion?.contains || [], out);
  const keys = out.map(c => `${c.system || ''}|${c.version || ''}|${c.code || ''}`);
  keys.sort();
  return keys;
}

function summarizeDiff(a, b, max = 5) {
  const as = new Set(a);
  const bs = new Set(b);
  const onlyA = [];
  const onlyB = [];
  for (const k of as) {
    if (!bs.has(k)) {
      onlyA.push(k);
      if (onlyA.length >= max) break;
    }
  }
  for (const k of bs) {
    if (!as.has(k)) {
      onlyB.push(k);
      if (onlyB.length >= max) break;
    }
  }
  return { onlyA, onlyB };
}

function makeValueSet(include, exclude) {
  return {
    resourceType: 'ValueSet',
    url: `http://test.fhirsmith.org/vs/pretest/${Date.now()}-${Math.random().toString(36).slice(2)}`,
    status: 'active',
    compose: {
      include: Array.isArray(include) ? include : [include],
      ...(exclude ? { exclude: Array.isArray(exclude) ? exclude : [exclude] } : {}),
    },
  };
}

function buildScenarios() {
  return [
    {
      id: 'snomed_is_a_diabetes',
      description: 'SNOMED is-a diabetes (full result)',
      include: { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      opts: {},
    },
    {
      id: 'snomed_is_a_minus_type2',
      description: 'SNOMED is-a diabetes minus Type2 subtree',
      include: { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      exclude: { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
      opts: {},
    },
    {
      id: 'snomed_is_a_minus_type1',
      description: 'SNOMED is-a diabetes minus Type1 subtree',
      include: { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      exclude: { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '46635009' }] },
      opts: {},
    },
    {
      id: 'snomed_refset_723560006',
      description: 'SNOMED concept in refset/723560006',
      include: { system: SYS.SCT, filter: [{ property: 'concept', op: 'in', value: 'http://snomed.info/sct?fhir_vs=refset/723560006' }] },
      opts: {},
    },
    {
      id: 'snomed_exclude_enumerated_from_is_a',
      description: 'SNOMED is-a diabetes minus 2 explicit concepts',
      include: { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      exclude: { system: SYS.SCT, concept: [{ code: '44054006' }, { code: '46635009' }] },
      opts: {},
    },
    {
      id: 'snomed_paged_include_exclude',
      description: 'SNOMED is-a diabetes minus Type2 subtree (offset/count)',
      include: { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '73211009' }] },
      exclude: { system: SYS.SCT, filter: [{ property: 'concept', op: 'is-a', value: '44054006' }] },
      opts: { count: 30, offset: 30 },
      criticalInvariant: true,
    },
    {
      id: 'rxnorm_tty_in_page50',
      description: 'RxNorm TTY=IN (count=50)',
      include: { system: SYS.RXNORM, filter: [{ property: 'TTY', op: '=', value: 'IN' }] },
      opts: { count: 50 },
    },
    {
      id: 'loinc_status_active_page20',
      description: 'LOINC STATUS=ACTIVE (count=20)',
      include: { system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] },
      opts: { count: 20 },
    },
    {
      id: 'snomed_text_diabetes_page50',
      description: 'SNOMED text filter diabetes (count=50)',
      include: { system: SYS.SCT },
      opts: { filter: 'diabetes', count: 50 },
    },
    {
      id: 'rxnorm_text_aspirin_page20',
      description: 'RxNorm text filter aspirin (count=20)',
      include: { system: SYS.RXNORM },
      opts: { filter: 'aspirin', count: 20 },
    },
    {
      id: 'rxnorm_tty_in_page1000',
      description: 'RxNorm TTY=IN page (count=1000)',
      include: { system: SYS.RXNORM, filter: [{ property: 'TTY', op: '=', value: 'IN' }] },
      opts: { count: 1000 },
      criticalInvariant: true,
    },
    {
      id: 'loinc_status_active_page10000',
      description: 'LOINC STATUS=ACTIVE page (count=10000, limit=10000)',
      include: { system: SYS.LOINC, filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] },
      opts: { count: 10000, limit: 10000 },
      criticalInvariant: true,
    },
  ];
}

async function setupLibrary() {
  const preferredConfig = path.join(__dirname, 'fixtures', 'expand-v2-test-library.yaml');
  const fallbackConfig = path.join(__dirname, 'fixtures', 'test-library.yaml');
  const configFile = fs.existsSync(preferredConfig) ? preferredConfig : fallbackConfig;
  const lib = new Library(configFile, null, log, null, {});
  await lib.load();
  const provider = await lib.cloneWithFhirVersion('5.0', null, '/r5');
  return { lib, provider };
}

function setPushdownDisabled(disabled) {
  const prev = process.env.EXPAND_V2_DISABLE_PUSHDOWN;
  if (disabled) process.env.EXPAND_V2_DISABLE_PUSHDOWN = '1';
  else delete process.env.EXPAND_V2_DISABLE_PUSHDOWN;
  return () => {
    if (prev === undefined) delete process.env.EXPAND_V2_DISABLE_PUSHDOWN;
    else process.env.EXPAND_V2_DISABLE_PUSHDOWN = prev;
  };
}

async function expandOnce(provider, i18n, langDefs, scenario, disablePushdown) {
  const restoreEnv = setPushdownDisabled(disablePushdown);
  try {
    const opContext = new OperationContext('en', i18n, null, 30);
    const worker = new ExpandWorker(opContext, log, provider, langDefs, i18n);
    const txp = new TxParameters(langDefs, i18n, false);
    const params = { resourceType: 'Parameters', parameter: [] };
    if (scenario.opts?.count !== undefined) params.parameter.push({ name: 'count', valueInteger: scenario.opts.count });
    if (scenario.opts?.offset !== undefined) params.parameter.push({ name: 'offset', valueInteger: scenario.opts.offset });
    if (scenario.opts?.limit !== undefined) params.parameter.push({ name: 'limit', valueInteger: scenario.opts.limit });
    if (scenario.opts?.filter) params.parameter.push({ name: 'filter', valueString: scenario.opts.filter });
    txp.readParams(params);

    const vsJson = makeValueSet(scenario.include, scenario.exclude);
    const vs = new ValueSet(vsJson);
    const textFilter = new SearchFilterText(scenario.opts?.filter || null);
    const expander = new ValueSetExpander(worker, txp);

    const t0 = performance.now();
    const result = await expander.expand(vs, textFilter, false);
    const ms = Math.round(performance.now() - t0);
    const keys = normalizeKeys(result);

    return {
      ms,
      keys,
      total: result?.expansion?.total ?? null,
      count: (result?.expansion?.contains || []).length,
      usedCodeSystems: (result?.expansion?.parameter || [])
        .filter(p => p.name === 'used-codesystem')
        .map(p => p.valueUri)
        .filter(Boolean),
    };
  } finally {
    restoreEnv();
  }
}

async function expandScenario(provider, i18n, langDefs, scenario, disablePushdown) {
  if (!scenario.pagedAggregate) {
    return expandOnce(provider, i18n, langDefs, scenario, disablePushdown);
  }

  const { pageSize, pages } = scenario.pagedAggregate;
  const allKeys = [];
  let msTotal = 0;
  let firstTotal = null;
  const used = new Set();

  for (let i = 0; i < pages; i++) {
    const pageScenario = {
      ...scenario,
      opts: {
        ...(scenario.opts || {}),
        count: pageSize,
        offset: i * pageSize,
      },
    };
    const page = await expandOnce(provider, i18n, langDefs, pageScenario, disablePushdown);
    msTotal += page.ms;
    if (firstTotal === null) firstTotal = page.total;
    for (const u of page.usedCodeSystems || []) used.add(u);
    allKeys.push(...page.keys);
    if (page.keys.length < pageSize) break;
  }

  const uniq = [...new Set(allKeys)].sort();
  return {
    ms: msTotal,
    keys: uniq,
    total: firstTotal,
    count: uniq.length,
    usedCodeSystems: [...used].sort(),
  };
}

async function main() {
  const outPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, 'v0-pretest-baseline.json');

  console.log('Loading library/provider...');
  const { lib, provider } = await setupLibrary();
  console.log('Library/provider ready.');

  const scenarios = buildScenarios();
  const report = {
    generatedAt: new Date().toISOString(),
    note: 'Pre-restructure baseline for sqlite-v0-oriented expansion behavior.',
    scenarios: [],
    summary: {
      scenarios: scenarios.length,
      parityFailures: 0,
      criticalInvariantFailures: 0,
      paritySkipped: 0,
    },
    dbLargeGoldens: [],
  };

  function dbLargeGolden({ id, dbFile, system, whereSql = 'active=1', limit = 10000 }) {
    const sql = `SELECT code FROM concept WHERE ${whereSql} ORDER BY code LIMIT ${limit};`;
    const out = execFileSync('sqlite3', [dbFile, sql], { encoding: 'utf8' });
    const codes = out.split('\n').map(s => s.trim()).filter(Boolean);
    const keys = codes.map(code => `${system}||${code}`);
    return { id, dbFile, system, whereSql, limit, size: keys.length, keys };
  }

  const dbDir = path.join(__dirname, '../../data/terminology-cache');
  report.dbLargeGoldens.push(
    dbLargeGolden({
      id: 'db-loinc-first-10000-active',
      dbFile: path.join(dbDir, 'loinc_281_full.v0.db'),
      system: SYS.LOINC,
      whereSql: 'active=1',
      limit: 10000,
    })
  );
  report.dbLargeGoldens.push(
    dbLargeGolden({
      id: 'db-rxnorm-first-10000-active',
      dbFile: path.join(dbDir, 'rxnorm_02022026.v0.db'),
      system: SYS.RXNORM,
      whereSql: 'active=1',
      limit: 10000,
    })
  );
  report.dbLargeGoldens.push(
    dbLargeGolden({
      id: 'db-snomed-first-10000-active',
      dbFile: path.join(dbDir, 'sct_intl_20250201.v0.db'),
      system: SYS.SCT,
      whereSql: 'active=1',
      limit: 10000,
    })
  );

  for (const scenario of scenarios) {
    console.log(`Running: ${scenario.id}`);
    const push = await expandScenario(provider, lib.i18n, lib.languageDefinitions, scenario, false);
    let fallback = null;
    let parityOk = null;
    let diff = null;
    let paritySkippedReason = null;

    if (scenario.pushdownOnly) {
      report.summary.paritySkipped += 1;
      paritySkippedReason = 'pushdown-only scenario (fallback exceeds safety cap for whole-system >1000)';
    } else {
      fallback = await expandScenario(provider, lib.i18n, lib.languageDefinitions, scenario, true);
      parityOk = JSON.stringify(push.keys) === JSON.stringify(fallback.keys);
      diff = parityOk ? null : summarizeDiff(push.keys, fallback.keys);
      if (!parityOk) report.summary.parityFailures += 1;
      if (scenario.criticalInvariant && !parityOk) report.summary.criticalInvariantFailures += 1;
    }

    report.scenarios.push({
      id: scenario.id,
      description: scenario.description,
      criticalInvariant: !!scenario.criticalInvariant,
      pushdownOnly: !!scenario.pushdownOnly,
      pushdown: {
        ms: push.ms,
        total: push.total,
        count: push.count,
        usedCodeSystems: push.usedCodeSystems,
      },
      fallback: fallback ? {
        ms: fallback.ms,
        total: fallback.total,
        count: fallback.count,
        usedCodeSystems: fallback.usedCodeSystems,
      } : null,
      parity: {
        ok: parityOk,
        skippedReason: paritySkippedReason,
        diff,
      },
      goldenKeys: push.keys,
    });
  }

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote baseline: ${outPath}`);

  if (report.summary.parityFailures > 0) {
    console.error(`Parity failures: ${report.summary.parityFailures}`);
    process.exit(1);
  }

  console.log('All pushdown-vs-fallback checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
