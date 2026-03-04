'use strict';

const IR = require('../../tx/engine/ir');
const {
  analyzePartitionSafety,
  analyzeProjectedSubtree,
  optimize,
  collectSystems,
  projectToSystem,
} = require('../../tx/engine/rewrite');
const { expandViaIR } = require('../../tx/engine/orchestrator');

function selector(system, version, id, tokens) {
  return IR.selector({
    system,
    version,
    shape: 'concept',
    conceptCodes: [{ code: id }],
    meta: { evalTokens: tokens },
  });
}

function setUnion(a, b) {
  const out = new Set(a);
  for (const v of b) out.add(v);
  return out;
}

function setIntersect(a, b) {
  const out = new Set();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

function setDiff(a, b) {
  const out = new Set();
  for (const v of a) if (!b.has(v)) out.add(v);
  return out;
}

function evalExpr(expr) {
  if (!expr) return new Set();
  switch (expr.kind) {
  case 'empty':
    return new Set();
  case 'selector':
    return new Set(expr.meta?.evalTokens || []);
  case 'import':
    return expr.resolved ? evalExpr(expr.resolved) : new Set();
  case 'union':
    return (expr.items || []).reduce((acc, it) => setUnion(acc, evalExpr(it)), new Set());
  case 'intersect': {
    const items = (expr.items || []);
    if (items.length === 0) return new Set();
    return items.slice(1).reduce((acc, it) => setIntersect(acc, evalExpr(it)), evalExpr(items[0]));
  }
  case 'diff':
    return setDiff(evalExpr(expr.left), evalExpr(expr.right));
  default:
    return new Set();
  }
}

function evalPartitioned(expr) {
  const systems = [...collectSystems(expr).values()];
  return systems.reduce((acc, { system, version }) => {
    const projected = projectToSystem(expr, system, version);
    return setUnion(acc, evalExpr(projected));
  }, new Set());
}

describe('partition safety analysis', () => {
  test('rejects unresolved imports', () => {
    const expr = IR.importRef({ url: 'http://example.org/ValueSet/unresolved' });
    const report = analyzePartitionSafety(expr);
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/unresolved import/i);
  });

  test('rejects selector without system', () => {
    const expr = IR.selector({ system: '', shape: 'whole' });
    const report = analyzePartitionSafety(expr);
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/missing system/i);
  });

  test('projects exact version buckets (null version does not include explicit versions)', () => {
    const expr = IR.union([
      selector('http://example.org/cs', null, 'a', ['A']),
      selector('http://example.org/cs', '1.0', 'b', ['B']),
    ]);
    const projected = projectToSystem(expr, 'http://example.org/cs', null);
    const report = analyzeProjectedSubtree(projected, 'http://example.org/cs', null);
    expect(report.ok).toBe(true);
    expect([...evalExpr(projected)].sort()).toEqual(['A']);
  });
});

describe('partition semantics', () => {
  test('representative expression preserves membership under per-system partition', () => {
    const expr = IR.diff(
      IR.union([
        selector('sys:A', null, 'a1', ['A:1', 'A:2', 'A:3']),
        selector('sys:B', null, 'b1', ['B:2', 'B:3']),
      ]),
      IR.union([
        selector('sys:A', null, 'a2', ['A:2']),
        selector('sys:B', null, 'b2', ['B:3']),
      ]),
    );

    const original = evalExpr(expr);
    const partitioned = evalPartitioned(expr);
    expect([...partitioned].sort()).toEqual([...original].sort());
  });

  test('optimize keeps unconstrained filter union when constrained sibling exists', () => {
    const constrained = IR.selector({
      system: 'sys:B',
      shape: 'filter',
      filterClauses: [{ property: 'kind', op: '=', value: 'root' }],
      intersectCodes: ['B-210'],
      meta: { evalTokens: ['B-210'] },
    });
    const unconstrained = IR.selector({
      system: 'sys:B',
      shape: 'filter',
      filterClauses: [{ property: 'kind', op: '=', value: 'root' }],
      meta: { evalTokens: ['B-200'] },
    });
    const expr = IR.union([constrained, unconstrained]);
    const optimized = optimize(expr);
    expect([...evalExpr(optimized)].sort()).toEqual(['B-200', 'B-210']);
  });

  test('regression: SNOMED is-a branch + imported subset does not collapse to subset', () => {
    const constrained = IR.selector({
      system: 'http://snomed.info/sct',
      shape: 'filter',
      filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
      intersectCodes: ['44054006'],
      // Subset import effectively constrains to this single code.
      meta: { evalTokens: ['http://snomed.info/sct|44054006'] },
    });
    const unconstrained = IR.selector({
      system: 'http://snomed.info/sct',
      shape: 'filter',
      filterClauses: [{ property: 'concept', op: 'is-a', value: '73211009' }],
      // Representative descendants under Diabetes mellitus (disorder).
      meta: {
        evalTokens: [
          'http://snomed.info/sct|44054006',
          'http://snomed.info/sct|46635009',
          'http://snomed.info/sct|73211009',
        ],
      },
    });
    const expr = IR.union([constrained, unconstrained]);
    const optimized = optimize(expr);
    expect([...evalExpr(optimized)].sort()).toEqual([
      'http://snomed.info/sct|44054006',
      'http://snomed.info/sct|46635009',
      'http://snomed.info/sct|73211009',
    ]);
  });

  test('regression: RxNorm TTY filter + imported concept subset does not collapse to subset', () => {
    const constrained = IR.selector({
      system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
      shape: 'filter',
      filterClauses: [{ property: 'tty', op: '=', value: 'IN' }],
      intersectCodes: ['1191'],
      // Subset import effectively constrains to aspirin ingredient.
      meta: { evalTokens: ['http://www.nlm.nih.gov/research/umls/rxnorm|1191'] },
    });
    const unconstrained = IR.selector({
      system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
      shape: 'filter',
      filterClauses: [{ property: 'tty', op: '=', value: 'IN' }],
      // Representative IN codes.
      meta: {
        evalTokens: [
          'http://www.nlm.nih.gov/research/umls/rxnorm|1191',
          'http://www.nlm.nih.gov/research/umls/rxnorm|7052',
          'http://www.nlm.nih.gov/research/umls/rxnorm|5640',
        ],
      },
    });
    const expr = IR.union([constrained, unconstrained]);
    const optimized = optimize(expr);
    expect([...evalExpr(optimized)].sort()).toEqual([
      'http://www.nlm.nih.gov/research/umls/rxnorm|1191',
      'http://www.nlm.nih.gov/research/umls/rxnorm|5640',
      'http://www.nlm.nih.gov/research/umls/rxnorm|7052',
    ]);
  });
});

describe('orchestrator guard', () => {
  function codesFromIR(node) {
    if (!node) return new Set();
    switch (node.kind) {
    case 'empty':
      return new Set();
    case 'selector':
      return new Set((node.conceptCodes || []).map(c => String(c.code || '')).filter(Boolean));
    case 'import':
      return node.resolved ? codesFromIR(node.resolved) : new Set();
    case 'union':
      return (node.items || []).reduce((acc, it) => setUnion(acc, codesFromIR(it)), new Set());
    case 'intersect': {
      const items = node.items || [];
      if (items.length === 0) return new Set();
      return items.slice(1).reduce((acc, it) => setIntersect(acc, codesFromIR(it)), codesFromIR(items[0]));
    }
    case 'diff':
      return setDiff(codesFromIR(node.left), codesFromIR(node.right));
    default:
      return new Set();
    }
  }

  function makeMockProvider(system, version) {
    return {
      system() { return system; },
      version() { return version || null; },
      status() { return {}; },
      contentMode() { return 'complete'; },
      async executeIR(subtree) {
        const codes = [...codesFromIR(subtree)].sort();
        return {
          candidates: codes.map(code => ({
            code,
            display: code,
            active: true,
            definition: `def-${code}`,
          })),
        };
      },
      async countForIR(subtree) {
        return codesFromIR(subtree).size;
      },
    };
  }

  test('handles mixed versioned/unversioned same-system as separate partitions', async () => {
    const vs = {
      resourceType: 'ValueSet',
      url: 'http://example.org/ValueSet/mixed-version',
      compose: {
        include: [
          { system: 'http://example.org/cs', concept: [{ code: 'a' }] },
          { system: 'http://example.org/cs', version: '1.0', concept: [{ code: 'b' }] },
        ],
      },
    };

    let providerCalls = 0;
    const result = await expandViaIR(vs, {
      findProvider: async (system, version) => {
        providerCalls++;
        return makeMockProvider(system, version);
      },
      count: 10,
      offset: 0,
    });

    expect(result).toBeTruthy();
    expect(result.expansion.total).toBe(2);
    const codes = (result.expansion.contains || []).map(c => c.code).sort();
    expect(codes).toEqual(['a', 'b']);
    expect(providerCalls).toBe(2);
  });
});
