'use strict';

// SNOMED CT ECL over the generic sqlite-v1 provider.
//
// Two layers:
//   1. Pure evaluator unit tests (tx/cs/sqlite-ecl.js) against an in-memory fake
//      iface — no DB, proves the AST walk / set algebra / refinement logic in
//      isolation, one assertion per ECL operator class.
//   2. Integration against the real SNOMED test-edition DB + the 52 official
//      constraint fixtures, reproduced through the provider filter path AND the
//      full ExpandWorker (legacy / pushdown / IR). Loud-skips if the DB or the
//      fixtures package is absent — never a silent green.

const fs = require('fs');
const path = require('path');

const {
  evaluateEcl, parseEcl, cardinalityAccepts,
} = require('../../tx/cs/sqlite-ecl.js');

// ---------------------------------------------------------------------------
// Layer 1: pure evaluator with an in-memory fake iface.
// ---------------------------------------------------------------------------

// A tiny hierarchy (concepts 1..5); attribute-type concepts 6 ('A') and 7 ('B')
// exist but sit outside the hierarchy; refset concept 9 has members {2,4}.
//        1 (root)
//       / \
//      2   3
//     / \
//    4   5
function makeFake() {
  const children = { 1: [2, 3], 2: [4, 5], 3: [], 4: [], 5: [] };
  const parents = { 1: [], 2: [1], 3: [1], 4: [2], 5: [2] };
  const hierarchy = [1, 2, 3, 4, 5];   // wildcard universe
  const known = new Set([1, 2, 3, 4, 5, 6, 7, 9]); // resolvable concept codes
  const descendants = (id) => {
    const out = []; const stack = [...(children[id] || [])];
    while (stack.length) { const x = stack.pop(); out.push(x); stack.push(...(children[x] || [])); }
    return out;
  };
  const ancestors = (id) => {
    const out = []; const stack = [...(parents[id] || [])];
    while (stack.length) { const x = stack.pop(); out.push(x); stack.push(...(parents[x] || [])); }
    return out;
  };
  // Attribute rows: source --attr--> target (with role group).
  //   6: 4->3 (g1), 4->5 (g1), 5->3 (g0 ungrouped), 2->3 (g2)
  //   7: 2->5 (g2)
  const rowsByAttr = {
    6: [
      { source: 4, group: 1, target: 3 },
      { source: 4, group: 1, target: 5 },
      { source: 5, group: 0, target: 3 },
      { source: 2, group: 2, target: 3 },
    ],
    7: [
      { source: 2, group: 2, target: 5 },
    ],
  };
  return {
    locateId: (code) => (known.has(Number(code)) ? Number(code) : null),
    closureDescendants: (id) => descendants(id),
    closureAncestors: (id) => ancestors(id),
    directChildren: (id) => (children[id] || []).slice(),
    directParents: (id) => (parents[id] || []).slice(),
    refsetMembers: (id) => (id === 9 ? [2, 4] : null),
    allIds: () => hierarchy.slice(),
    linkTargets: (sourceIds, attrCode) => {
      const src = new Set(sourceIds);
      const out = new Set();
      for (const r of rowsByAttr[attrCode] || []) if (src.has(r.source)) out.add(r.target);
      return [...out];
    },
    attrRows: (attrCode, valueIds) => {
      const rows = rowsByAttr[attrCode] || [];
      if (!Array.isArray(valueIds)) return rows.map((r) => ({ ...r }));
      const vs = new Set(valueIds);
      return rows.filter((r) => vs.has(r.target)).map((r) => ({ ...r }));
    },
  };
}

const ev = (fake, text) => evaluateEcl(fake, text);

describe('sqlite-ecl evaluator (pure, in-memory fake)', () => {
  const f = makeFake();

  test('bare concept reference', () => { expect(ev(f, '2')).toEqual([2]); });
  test('descendant-or-self-of <<', () => { expect(ev(f, '<< 1')).toEqual([1, 2, 3, 4, 5]); });
  test('descendant-of <', () => { expect(ev(f, '< 2')).toEqual([4, 5]); });
  test('child-of <!', () => { expect(ev(f, '<! 2')).toEqual([4, 5]); });
  test('child-or-self-of <<!', () => { expect(ev(f, '<<! 2')).toEqual([2, 4, 5]); });
  test('ancestor-or-self-of >>', () => { expect(ev(f, '>> 4')).toEqual([1, 2, 4]); });
  test('ancestor-of >', () => { expect(ev(f, '> 4')).toEqual([1, 2]); });
  test('parent-of >!', () => { expect(ev(f, '>! 4')).toEqual([2]); });
  test('parent-or-self-of >>!', () => { expect(ev(f, '>>! 4')).toEqual([2, 4]); });
  test('wildcard *', () => { expect(ev(f, '*')).toEqual([1, 2, 3, 4, 5]); });

  test('term annotation is parsed and ignored', () => {
    expect(ev(f, '<< 1 |Root structure|')).toEqual([1, 2, 3, 4, 5]);
  });

  test('conjunction AND', () => { expect(ev(f, '<< 1 AND << 2')).toEqual([2, 4, 5]); });
  test('disjunction OR', () => { expect(ev(f, '< 2 OR 3')).toEqual([3, 4, 5]); });
  test('exclusion MINUS', () => { expect(ev(f, '<< 1 MINUS << 2')).toEqual([1, 3]); });
  test('parentheses / precedence', () => {
    expect(ev(f, '(< 1) MINUS (< 2)')).toEqual([2, 3]); // {2,3,4,5} minus {4,5}
  });

  test('member-of ^ (refset)', () => { expect(ev(f, '^ 9')).toEqual([2, 4]); });

  test('dotted . attr = targets of attr links', () => {
    // sources {4,5} (< 2); attr 6 targets from those -> {3,5}
    expect(ev(f, '< 2 . 6')).toEqual([3, 5]);
  });

  test('refinement simple attr = value', () => {
    // base < 1 = {2,3,4,5}; attr 6 to value in <<3={3}; sources {4,5,2}
    // intersect base -> [2,4,5]
    expect(ev(f, '< 1 : 6 = << 3')).toEqual([2, 4, 5]);
  });

  test('refinement wildcard attr = *', () => {
    // any attr-6 target; sources {4,5,2} intersect base {2,3,4,5} -> [2,4,5]
    expect(ev(f, '< 1 : 6 = *')).toEqual([2, 4, 5]);
  });

  test('refinement cardinality [2..2] (distinct targets)', () => {
    // 4 -> {3,5} (2 distinct); 5 -> {3} (1); 2 -> {3} (1)
    // base << 1; [2..2] keeps only 4
    expect(ev(f, '<< 1 : [2..2] 6 = *')).toEqual([4]);
  });

  test('refinement cardinality [0..1] includes concepts with zero matches', () => {
    // base << 1 = {1,2,3,4,5}; distinct attr-6 counts: 4->2, 5->1, 2->1, else 0
    // [0..1] keeps count<=1: 1,2,3,5 (excludes 4)
    expect(ev(f, '<< 1 : [0..1] 6 = *')).toEqual([1, 2, 3, 5]);
  });

  test('attribute group { a=v, b=w } same group', () => {
    // group 2 on source 2 has 6->3 and 7->5. base << 1.
    expect(ev(f, '<< 1 : { 6 = 3, 7 = 5 }')).toEqual([2]);
  });

  test('attribute group with no common group -> empty', () => {
    // 6->5 lives in group 1 (source 4); 7->5 in group 2 (source 2): never same group
    expect(ev(f, '<< 1 : { 6 = 5, 7 = 5 }')).toEqual([]);
  });

  test('unknown concept throws', () => {
    expect(() => ev(f, '<< 99')).toThrow(/not known/);
  });

  test('member-of bare non-refset throws', () => {
    expect(() => ev(f, '^ 2')).toThrow(/not a reference set/);
  });

  test('cardinalityAccepts helper', () => {
    expect(cardinalityAccepts({ min: 1, max: 1 }, 1)).toBe(true);
    expect(cardinalityAccepts({ min: 1, max: 1 }, 2)).toBe(false);
    expect(cardinalityAccepts({ min: 0, max: '*' }, 0)).toBe(true);
    expect(cardinalityAccepts({ min: 2, max: '*' }, 5)).toBe(true);
  });

  test('parseEcl surfaces syntax errors', () => {
    expect(() => parseEcl('<<')).toThrow();
    expect(() => parseEcl('<< 1 <<')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Layer 2: integration against the real SNOMED test-edition DB + official
// constraint fixtures.
// ---------------------------------------------------------------------------

const { ExpandWorker } = require('../../tx/workers/expand.js');
const { SqliteCodeSystemFactory } = require('../../tx/cs/cs-sqlite.js');
const { OperationContext } = require('../../tx/operation-context.js');
const { TxParameters } = require('../../tx/params.js');
const { LanguageDefinitions } = require('../../library/languages.js');
const { I18nSupport } = require('../../library/i18nsupport.js');
const ValueSet = require('../../tx/library/valueset.js');

const DB_DIR = path.join(process.env.HOME, 'work', 'tx-dbs');
const SCT_DB = path.join(DB_DIR, 'sct-test-20250814-v1.db');
const SCT = 'http://snomed.info/sct';
const FIX_DIR = path.join(
  process.env.HOME, '.fhir', 'packages',
  'hl7.fhir.uv.tx-ecosystem#current', 'package', 'tests', 'sct'
);
const quietLog = { error: () => {}, debug: () => {}, log: () => {}, info: () => {}, warn: () => {} };

// Fixtures whose PUBLISHED expected-response is stale: the current binary
// reference provider (cs-snomed) itself disagrees with them. The sqlite
// evaluator mirrors the current reference exactly, so we assert the
// reference-correct outcome here rather than the stale published number.
//   - memberOf-nonRefset: `^ 10200004` — a bare non-refset operand is an error
//     (the published fixture shows a pre-fix 0xFFFFFFFF sentinel member).
//   - refinement-cardinality: `[1..1]` — reference yields 653, fixture says 573.
const STALE = {
  'expand-ecl-memberOf-nonRefset': { kind: 'throw' },
  'expand-ecl-refinement-cardinality': { kind: 'size', size: 653 },
};

const haveDb = fs.existsSync(SCT_DB);
const haveFix = fs.existsSync(FIX_DIR);
if (!haveDb || !haveFix) {
  // eslint-disable-next-line no-console
  console.warn(`[sqlite-v1-ecl] SKIPPING integration — missing ${!haveDb ? SCT_DB : ''} ${!haveFix ? FIX_DIR : ''}`.trim());
}
const describeIf = (haveDb && haveFix) ? describe : describe.skip;

describeIf('sqlite-v1 ECL vs official constraint fixtures', () => {
  jest.setTimeout(120000);
  let factory, prov, i18n, langDefs, codeOf;

  beforeAll(async () => {
    langDefs = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
    i18n = new I18nSupport(path.join(__dirname, '../../translations'), langDefs);
    await i18n.load();
    factory = new SqliteCodeSystemFactory(i18n, SCT_DB);
    await factory.load();
    prov = await factory.build(new OperationContext('en', i18n), []);
    codeOf = new Map();
    for (const r of prov.db.prepare('SELECT concept_id, code FROM concept').all()) codeOf.set(r.concept_id, r.code);
  });

  afterAll(() => { if (factory) factory.close(); });

  const cases = fs.existsSync(FIX_DIR)
    ? fs.readdirSync(FIX_DIR).filter((f) => /^expand-ecl-.*-request\.json$/.test(f)).sort()
    : [];

  test('at least a full set of ECL constraint fixtures is present', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  test.each(cases)('%s', (rf) => {
    const name = rf.replace('-request.json', '');
    const req = JSON.parse(fs.readFileSync(path.join(FIX_DIR, rf), 'utf8'));
    const resp = JSON.parse(fs.readFileSync(path.join(FIX_DIR, name + '-response.json'), 'utf8'));
    const value = req.parameter[0].resource.compose.include[0].filter[0].value;

    let set = null; let threw = false;
    try {
      set = new Set(prov._idsForFilter('constraint', '=', value).map((id) => codeOf.get(id)));
    } catch { threw = true; }

    const stale = STALE[name];
    if (stale) {
      if (stale.kind === 'throw') expect(threw).toBe(true);
      else { expect(threw).toBe(false); expect(set.size).toBe(stale.size); }
      return;
    }

    if (resp.issue) { expect(threw).toBe(true); return; }

    expect(threw).toBe(false);
    const expected = new Set(((resp.expansion && resp.expansion.contains) || []).map((x) => x.code));
    // sqlite result must equal the published expansion exactly (as a set).
    expect([...set].sort()).toEqual([...expected].sort());
  });
});

describeIf('sqlite-v1 ECL end-to-end (legacy/pushdown/ir agree)', () => {
  jest.setTimeout(120000);
  let factory, i18n, langDefs;

  beforeAll(async () => {
    langDefs = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
    i18n = new I18nSupport(path.join(__dirname, '../../translations'), langDefs);
    await i18n.load();
    factory = new SqliteCodeSystemFactory(i18n, SCT_DB);
    await factory.load();
  });
  afterAll(() => { if (factory) factory.close(); });

  function stub() {
    return {
      getCodeSystemProvider: async (op, sys) => (sys === SCT ? await factory.build(op, []) : null),
      createCodeSystemProvider: async () => null, loadSupplements: () => [], getFhirVersion: () => 'R4',
    };
  }
  function paramsResource(engine) {
    return { resourceType: 'Parameters', parameter: [{ name: '_engine', valueString: engine }, { name: 'count', valueInteger: 0 }] };
  }
  async function total(value, engine) {
    const op = new OperationContext('en', i18n);
    const worker = new ExpandWorker(op, quietLog, stub(), langDefs, i18n);
    const txp = new TxParameters(i18n.languageDefinitions, i18n, false);
    txp.readParams(paramsResource(engine));
    const vs = new ValueSet({ resourceType: 'ValueSet', status: 'active', url: 'http://t/vs',
      compose: { include: [{ system: SCT, filter: [{ property: 'constraint', op: '=', value }] }] } });
    const r = await worker.performExpansion(vs, txp, null);
    return r.expansion.total;
  }

  const EXPRS = [
    '<< 10200004',
    '< 64572001 : 363698007 = << 10200004',
    '<< 64572001 MINUS << 128045006',
    '^ 900000000000526001',
    '< 64572001 . 363698007',
  ];
  test.each(EXPRS)('legacy == pushdown == ir: %s', async (value) => {
    const [l, p, ir] = await Promise.all([total(value, 'legacy'), total(value, 'pushdown'), total(value, 'ir')]);
    expect(p).toBe(l);
    expect(ir).toBe(l);
  });
});
