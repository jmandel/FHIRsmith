'use strict';

const { performance } = require('perf_hooks');
let Database;
try { Database = require('better-sqlite3-with-progress'); } catch (_) { Database = require('better-sqlite3'); }

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function bench(fn, iterations = 30, warmups = 5) {
  for (let i = 0; i < warmups; i++) fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return {
    medianMs: Number(median(times).toFixed(3)),
    minMs: Number(Math.min(...times).toFixed(3)),
    maxMs: Number(Math.max(...times).toFixed(3)),
  };
}

function rowsKey(rows) {
  return rows.map(r => `${r.code || ''}|${r.concept_id || ''}`).join('\n');
}

function runCase(caseDef) {
  const baseRows = caseDef.variants[0].run();
  const baseKey = rowsKey(baseRows);
  const results = [];

  for (const v of caseDef.variants) {
    const rows = v.run();
    const same = rowsKey(rows) === baseKey;
    const perf = bench(v.run, caseDef.iterations || 30, caseDef.warmups || 5);
    results.push({
      name: v.name,
      equivalentToBaseline: same,
      rowCount: rows.length,
      ...perf,
    });
  }

  return {
    id: caseDef.id,
    description: caseDef.description,
    baseline: caseDef.variants[0].name,
    results,
  };
}

function buildCases() {
  const rxDb = new Database('data/terminology-cache/rxnorm_02022026.v0.db', { readonly: false });
  const loDb = new Database('data/terminology-cache/loinc_281_full.v0.db', { readonly: false });
  const snDb = new Database('data/terminology-cache/sct_intl_20250201.v0.db', { readonly: false });

  const rxCs = rxDb.prepare("SELECT cs_id FROM code_system WHERE base_uri='http://www.nlm.nih.gov/research/umls/rxnorm' OR canonical_uri='http://www.nlm.nih.gov/research/umls/rxnorm' LIMIT 1").get().cs_id;
  const loCs = loDb.prepare("SELECT cs_id FROM code_system WHERE base_uri='http://loinc.org' OR canonical_uri='http://loinc.org' LIMIT 1").get().cs_id;
  const snCs = snDb.prepare("SELECT cs_id FROM code_system WHERE base_uri='http://snomed.info/sct' OR canonical_uri='http://snomed.info/sct' LIMIT 1").get().cs_id;

  const rxPropTTY = rxDb.prepare("SELECT property_id FROM property_def WHERE cs_id=? AND property_code='TTY' LIMIT 1").get(rxCs).property_id;
  const loPropStatus = loDb.prepare("SELECT property_id FROM property_def WHERE cs_id=? AND property_code='STATUS' LIMIT 1").get(loCs).property_id;

  const rxCodes1000 = rxDb.prepare('SELECT code FROM concept WHERE cs_id=? AND active=1 ORDER BY code LIMIT 1000').all(rxCs).map(r => r.code);
  const snAncInclude = '73211009';
  const snAncExclude = '44054006';

  const inParams = { cs: rxCs };
  const inPlaceholders = rxCodes1000.map((_, i) => `@c${i}`).join(',');
  for (let i = 0; i < rxCodes1000.length; i++) inParams[`c${i}`] = rxCodes1000[i];

  const qRxIn1000 = rxDb.prepare(`SELECT c.concept_id, c.code FROM concept c WHERE c.cs_id=@cs AND c.code IN (${inPlaceholders}) ORDER BY c.code`);

  function runRxTempFull() {
    const tbl = `_tmp_rx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    rxDb.exec(`CREATE TEMP TABLE ${tbl} (code TEXT PRIMARY KEY)`);
    const ins = rxDb.prepare(`INSERT INTO ${tbl}(code) VALUES (?)`);
    const tx = rxDb.transaction((codes) => { for (const c of codes) ins.run(c); });
    tx(rxCodes1000);
    const rows = rxDb.prepare(`SELECT c.concept_id, c.code FROM concept c JOIN ${tbl} t ON t.code = c.code WHERE c.cs_id=? ORDER BY c.code`).all(rxCs);
    rxDb.exec(`DROP TABLE ${tbl}`);
    return rows;
  }

  const reuseTbl = '_tmp_rx_reuse_1000';
  rxDb.exec(`DROP TABLE IF EXISTS ${reuseTbl}; CREATE TEMP TABLE ${reuseTbl} (code TEXT PRIMARY KEY);`);
  const insReuse = rxDb.prepare(`INSERT INTO ${reuseTbl}(code) VALUES (?)`);
  const txReuse = rxDb.transaction((codes) => { for (const c of codes) insReuse.run(c); });
  txReuse(rxCodes1000);
  const qRxTempReuse = rxDb.prepare(`SELECT c.concept_id, c.code FROM concept c JOIN ${reuseTbl} t ON t.code = c.code WHERE c.cs_id=? ORDER BY c.code`);

  const snParams = { cs: snCs, inc: snAncInclude, exc: snAncExclude };
  const qSnExists = snDb.prepare(`
SELECT t.concept_id, t.code
FROM (
  SELECT c.concept_id, c.code
  FROM concept c
  JOIN closure cl ON cl.descendant_id = c.concept_id
   AND cl.ancestor_id = (SELECT concept_id FROM concept WHERE code=@inc AND cs_id=@cs)
  WHERE c.cs_id = @cs
) t
WHERE NOT EXISTS (
  SELECT 1
  FROM concept x
  JOIN closure clx ON clx.descendant_id = x.concept_id
   AND clx.ancestor_id = (SELECT concept_id FROM concept WHERE code=@exc AND cs_id=@cs)
  WHERE x.cs_id = @cs AND x.concept_id = t.concept_id
)
ORDER BY t.code, t.concept_id
LIMIT 100 OFFSET 100`);

  const qSnExcept = snDb.prepare(`
WITH include_set AS (
  SELECT c.concept_id
  FROM concept c
  JOIN closure cl ON cl.descendant_id = c.concept_id
   AND cl.ancestor_id = (SELECT concept_id FROM concept WHERE code=@inc AND cs_id=@cs)
  WHERE c.cs_id = @cs
),
exclude_set AS (
  SELECT x.concept_id
  FROM concept x
  JOIN closure clx ON clx.descendant_id = x.concept_id
   AND clx.ancestor_id = (SELECT concept_id FROM concept WHERE code=@exc AND cs_id=@cs)
  WHERE x.cs_id = @cs
),
final AS (
  SELECT concept_id FROM include_set
  EXCEPT
  SELECT concept_id FROM exclude_set
)
SELECT c.concept_id, c.code
FROM final f
JOIN concept c ON c.concept_id = f.concept_id
ORDER BY c.code, c.concept_id
LIMIT 100 OFFSET 100`);

  const qSnLeftJoin = snDb.prepare(`
WITH include_set AS (
  SELECT c.concept_id
  FROM concept c
  JOIN closure cl ON cl.descendant_id = c.concept_id
   AND cl.ancestor_id = (SELECT concept_id FROM concept WHERE code=@inc AND cs_id=@cs)
  WHERE c.cs_id = @cs
),
exclude_set AS (
  SELECT x.concept_id
  FROM concept x
  JOIN closure clx ON clx.descendant_id = x.concept_id
   AND clx.ancestor_id = (SELECT concept_id FROM concept WHERE code=@exc AND cs_id=@cs)
  WHERE x.cs_id = @cs
)
SELECT c.concept_id, c.code
FROM include_set i
JOIN concept c ON c.concept_id = i.concept_id
LEFT JOIN exclude_set e ON e.concept_id = i.concept_id
WHERE e.concept_id IS NULL
ORDER BY c.code, c.concept_id
LIMIT 100 OFFSET 100`);

  const rxParams = { cs: rxCs, prop: rxPropTTY, val: 'IN' };
  const qRxJoin = rxDb.prepare(`
SELECT DISTINCT c.concept_id, c.code
FROM concept c
JOIN concept_literal lit ON lit.source_concept_id = c.concept_id
 AND lit.property_id = @prop
 AND lit.active = 1
 AND lit.value_text COLLATE NOCASE = @val
WHERE c.cs_id = @cs
ORDER BY c.code
LIMIT 50`);

  const qRxExists = rxDb.prepare(`
SELECT c.concept_id, c.code
FROM concept c
WHERE c.cs_id = @cs
  AND EXISTS (
    SELECT 1 FROM concept_literal lit
    WHERE lit.source_concept_id = c.concept_id
      AND lit.property_id = @prop
      AND lit.active = 1
      AND lit.value_text COLLATE NOCASE = @val
  )
ORDER BY c.code
LIMIT 50`);

  const loParams = { cs: loCs, prop: loPropStatus, val: 'ACTIVE' };
  const qLoJoin = loDb.prepare(`
SELECT DISTINCT c.concept_id, c.code
FROM concept c
JOIN concept_literal lit ON lit.source_concept_id = c.concept_id
 AND lit.property_id = @prop
 AND lit.active = 1
 AND lit.value_text COLLATE NOCASE = @val
WHERE c.cs_id = @cs
ORDER BY c.code
LIMIT 20`);

  const qLoExists = loDb.prepare(`
SELECT c.concept_id, c.code
FROM concept c
WHERE c.cs_id = @cs
  AND EXISTS (
    SELECT 1 FROM concept_literal lit
    WHERE lit.source_concept_id = c.concept_id
      AND lit.property_id = @prop
      AND lit.active = 1
      AND lit.value_text COLLATE NOCASE = @val
  )
ORDER BY c.code
LIMIT 20`);

  const qUnion = snDb.prepare(`
SELECT concept_id, code FROM (
  SELECT c.concept_id, c.code FROM concept c WHERE c.cs_id=@cs AND c.code IN ('73211009','44054006')
  UNION
  SELECT c.concept_id, c.code FROM concept c WHERE c.cs_id=@cs AND c.code IN ('44054006','46635009')
)
ORDER BY code, concept_id`);

  const qUnionAllDistinct = snDb.prepare(`
SELECT DISTINCT concept_id, code FROM (
  SELECT c.concept_id, c.code FROM concept c WHERE c.cs_id=@cs AND c.code IN ('73211009','44054006')
  UNION ALL
  SELECT c.concept_id, c.code FROM concept c WHERE c.cs_id=@cs AND c.code IN ('44054006','46635009')
)
ORDER BY code, concept_id`);

  return [
    {
      id: 'set-membership-1000-codes',
      description: 'RxNorm 1000-code membership: IN vs temp-table join',
      variants: [
        { name: 'in-list-1000', run: () => qRxIn1000.all(inParams) },
        { name: 'temp-table-full-cycle', run: runRxTempFull },
        { name: 'temp-table-reused', run: () => qRxTempReuse.all(rxCs) },
      ],
    },
    {
      id: 'snomed-include-minus-exclude-paged',
      description: 'SNOMED is-a minus subtree, paged: NOT EXISTS vs EXCEPT vs LEFT JOIN',
      variants: [
        { name: 'not-exists', run: () => qSnExists.all(snParams) },
        { name: 'except', run: () => qSnExcept.all(snParams) },
        { name: 'left-join-null', run: () => qSnLeftJoin.all(snParams) },
      ],
    },
    {
      id: 'rxnorm-property-filter-tty',
      description: 'RxNorm TTY=IN filter: JOIN vs EXISTS',
      variants: [
        { name: 'join-literal', run: () => qRxJoin.all(rxParams) },
        { name: 'exists-literal', run: () => qRxExists.all(rxParams) },
      ],
    },
    {
      id: 'loinc-property-filter-status',
      description: 'LOINC STATUS=ACTIVE filter: JOIN vs EXISTS',
      variants: [
        { name: 'join-literal', run: () => qLoJoin.all(loParams) },
        { name: 'exists-literal', run: () => qLoExists.all(loParams) },
      ],
    },
    {
      id: 'union-dedup-small',
      description: 'Same-system union dedup: UNION vs UNION ALL + DISTINCT',
      variants: [
        { name: 'union', run: () => qUnion.all({ cs: snCs }) },
        { name: 'union-all-distinct', run: () => qUnionAllDistinct.all({ cs: snCs }) },
      ],
      iterations: 100,
      warmups: 20,
    },
  ];
}

function main() {
  const cases = buildCases();
  const out = {
    generatedAt: new Date().toISOString(),
    results: cases.map(runCase),
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
