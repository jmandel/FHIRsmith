'use strict';

const { buildIRFromValueSet } = require('../../tx/engine/build-ir');
const { resolveImports } = require('../../tx/engine/resolve-imports');
const { interpretScopedIR } = require('../../tx/engine/scoped-ir-interpreter');
const {
  optimize,
  collectSystems,
  projectToSystem,
  analyzePartitionSafety,
} = require('../../tx/engine/rewrite');

const SYS = {
  A: 'urn:sys:A',
  B: 'urn:sys:B',
};

function cloneJson(x) {
  return JSON.parse(JSON.stringify(x));
}

function tokenOf(system, code, version = null) {
  return `${system}|${version || ''}|${code}`;
}

function normalizeVersion(version) {
  if (version == null || version === '') return null;
  const v = String(version);
  return v === '*' ? null : v;
}

function makeCatalog() {
  const bySystem = new Map();

  function put(system, rows) {
    const byCode = new Map();
    const children = new Map();
    for (const row of rows) {
      byCode.set(row.code, { ...row });
      children.set(row.code, []);
    }
    for (const row of rows) {
      for (const parent of row.parents) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(row.code);
      }
    }
    for (const list of children.values()) list.sort();
    bySystem.set(system, { byCode, children });
  }

  put(SYS.A, [
    { code: 'A-100', kind: 'root', parents: [] },
    { code: 'A-110', kind: 'lab', parents: ['A-100'] },
    { code: 'A-120', kind: 'diag', parents: ['A-100'] },
  ]);

  put(SYS.B, [
    { code: 'B-100', kind: 'root', parents: [] },
    { code: 'B-110', kind: 'lab', parents: ['B-100'] },
    { code: 'B-120', kind: 'diag', parents: ['B-100'] },
  ]);

  return bySystem;
}

const CATALOG = makeCatalog();

function descendants(system, code, includeSelf) {
  const sys = CATALOG.get(system);
  if (!sys || !sys.byCode.has(code)) return new Set();
  const out = new Set();
  const queue = includeSelf ? [code] : [...(sys.children.get(code) || [])];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (out.has(cur)) continue;
    out.add(cur);
    for (const child of sys.children.get(cur) || []) queue.push(child);
  }
  return out;
}

function allTokensForSystem(system, version = null) {
  const sys = CATALOG.get(system);
  if (!sys) return new Set();
  return new Set([...sys.byCode.keys()].map(code => tokenOf(system, code, version)));
}

function tokensForClause(system, clause, version = null) {
  const sys = CATALOG.get(system);
  if (!sys) return new Set();
  const property = String(clause.property || '');
  const op = String(clause.op || '');
  const value = clause.value != null ? String(clause.value) : '';

  if (property === 'concept' && op === 'is-a') {
    return new Set([...descendants(system, value, true)].map(code => tokenOf(system, code, version)));
  }
  if (property === 'concept' && op === 'descendent-of') {
    return new Set([...descendants(system, value, false)].map(code => tokenOf(system, code, version)));
  }
  if (property === 'kind' && op === '=') {
    return new Set(
      [...sys.byCode.values()]
        .filter(row => row.kind === value)
        .map(row => tokenOf(system, row.code, version))
    );
  }
  if (property === 'code' && op === 'regex') {
    let re;
    try {
      re = new RegExp(value);
    } catch {
      return new Set();
    }
    return new Set(
      [...sys.byCode.values()]
        .filter(row => re.test(row.code))
        .map(row => tokenOf(system, row.code, version))
    );
  }
  return new Set();
}

function setUnion(a, b) {
  const out = new Set(a);
  for (const value of b) out.add(value);
  return out;
}

function setIntersect(a, b) {
  const out = new Set();
  for (const value of a) {
    if (b.has(value)) out.add(value);
  }
  return out;
}

function setDiff(a, b) {
  const out = new Set();
  for (const value of a) {
    if (!b.has(value)) out.add(value);
  }
  return out;
}

function sorted(values) {
  return [...values].sort();
}

function evaluateSelectorDirect(node) {
  const system = String(node.system || '');
  const version = normalizeVersion(node.version);
  if (!CATALOG.has(system)) return new Set();
  if (node.shape === 'concept') {
    const out = new Set();
    for (const cc of node.conceptCodes || []) {
      const code = String(cc.code || '');
      if (CATALOG.get(system).byCode.has(code)) out.add(tokenOf(system, code, version));
    }
    return out;
  }
  if (node.shape === 'filter') {
    let out = allTokensForSystem(system, version);
    for (const clause of node.filterClauses || []) {
      out = setIntersect(out, tokensForClause(system, clause, version));
    }
    if (Array.isArray(node.intersectCodes) && node.intersectCodes.length > 0) {
      const allow = new Set(node.intersectCodes.map(code => tokenOf(system, String(code), version)));
      out = setIntersect(out, allow);
    }
    return out;
  }
  return allTokensForSystem(system, version);
}

function parseRef(ref) {
  const raw = String(ref || '');
  if (!raw.includes('|')) return { url: raw, version: null };
  const i = raw.indexOf('|');
  return { url: raw.slice(0, i), version: raw.slice(i + 1) || null };
}

function evalComponentDirect(cset, evalRef) {
  if (!cset.system) {
    const refs = cset.valueSet || [];
    if (refs.length === 0) return new Set();
    let out = new Set(evalRef(refs[0]));
    for (const ref of refs.slice(1)) {
      out = setIntersect(out, evalRef(ref));
      if (out.size === 0) break;
    }
    return out;
  }

  const system = String(cset.system);
  const version = normalizeVersion(cset.version);
  let set;
  if (Array.isArray(cset.concept) && cset.concept.length > 0) {
    set = new Set();
    for (const cc of cset.concept) {
      const code = String(cc.code || '');
      if (CATALOG.get(system).byCode.has(code)) set.add(tokenOf(system, code, version));
    }
  } else if (Array.isArray(cset.filter) && cset.filter.length > 0) {
    set = allTokensForSystem(system, version);
    for (const clause of cset.filter) {
      set = setIntersect(set, tokensForClause(system, clause, version));
    }
  } else {
    set = allTokensForSystem(system, version);
  }

  if (Array.isArray(cset.valueSet) && cset.valueSet.length > 0) {
    for (const ref of cset.valueSet) {
      set = setIntersect(set, evalRef(ref));
      if (set.size === 0) break;
    }
  }

  return set;
}

function evaluateValueSetDirect(root, byUrl) {
  const memo = new Map();
  const stack = [];

  function evalRef(ref) {
    const { url } = parseRef(ref);
    return evalUrl(url);
  }

  function evalUrl(url) {
    if (memo.has(url)) return memo.get(url);
    if (stack.includes(url)) {
      throw new Error(`cycle in exhaustive test corpus: ${[...stack, url].join(' -> ')}`);
    }
    const target = byUrl.get(url);
    if (!target) return new Set();
    stack.push(url);
    try {
      let includes = new Set();
      let excludes = new Set();
      for (const c of target.compose?.include || []) {
        includes = setUnion(includes, evalComponentDirect(c, evalRef));
      }
      for (const c of target.compose?.exclude || []) {
        excludes = setUnion(excludes, evalComponentDirect(c, evalRef));
      }
      const out = setDiff(includes, excludes);
      memo.set(url, out);
      return out;
    } finally {
      stack.pop();
    }
  }

  return evalUrl(root.url);
}

function combinations(items, maxSize) {
  const out = [];
  function rec(start, chosen, targetSize) {
    if (chosen.length === targetSize) {
      out.push(chosen.map(i => items[i]));
      return;
    }
    for (let i = start; i < items.length; i++) {
      chosen.push(i);
      rec(i + 1, chosen, targetSize);
      chosen.pop();
    }
  }
  for (let size = 1; size <= maxSize; size++) rec(0, [], size);
  return out;
}

function vs(url, compose) {
  return { resourceType: 'ValueSet', url, compose };
}

function buildReferenceLibrary() {
  const refs = [
    vs('http://example.org/exhaustive/import/a-whole', {
      include: [{ system: SYS.A }],
    }),
    vs('http://example.org/exhaustive/import/a-lab', {
      include: [{ system: SYS.A, filter: [{ property: 'kind', op: '=', value: 'lab' }] }],
    }),
    vs('http://example.org/exhaustive/import/a-root-v1', {
      include: [{ system: SYS.A, version: 'A.v1', filter: [{ property: 'concept', op: 'is-a', value: 'A-100' }] }],
    }),
    vs('http://example.org/exhaustive/import/b-lab', {
      include: [{ system: SYS.B, concept: [{ code: 'B-110' }] }],
    }),
    vs('http://example.org/exhaustive/import/nested-mix', {
      include: [
        { valueSet: ['http://example.org/exhaustive/import/a-whole', 'http://example.org/exhaustive/import/a-lab'] },
        { system: SYS.B, concept: [{ code: 'B-110' }] },
      ],
      exclude: [{ system: SYS.A, concept: [{ code: 'A-110' }] }],
    }),
  ];
  return new Map(refs.map(r => [r.url, r]));
}

function buildComponentCatalog(refsByUrl) {
  const refUrls = [...refsByUrl.keys()];
  return [
    { name: 'a-whole', cset: { system: SYS.A } },
    { name: 'a-whole-v1', cset: { system: SYS.A, version: 'A.v1' } },
    { name: 'b-whole', cset: { system: SYS.B } },
    { name: 'a-concept-root', cset: { system: SYS.A, concept: [{ code: 'A-100' }] } },
    { name: 'a-concept-pair', cset: { system: SYS.A, concept: [{ code: 'A-100' }, { code: 'A-110' }] } },
    { name: 'a-concept-v1', cset: { system: SYS.A, version: 'A.v1', concept: [{ code: 'A-110' }] } },
    { name: 'b-concept-lab', cset: { system: SYS.B, concept: [{ code: 'B-110' }] } },
    { name: 'a-filter-lab', cset: { system: SYS.A, filter: [{ property: 'kind', op: '=', value: 'lab' }] } },
    { name: 'a-filter-isa', cset: { system: SYS.A, filter: [{ property: 'concept', op: 'is-a', value: 'A-100' }] } },
    { name: 'a-filter-desc-v1', cset: { system: SYS.A, version: 'A.v1', filter: [{ property: 'concept', op: 'descendent-of', value: 'A-100' }] } },
    { name: 'b-filter-regex', cset: { system: SYS.B, filter: [{ property: 'code', op: 'regex', value: '^B-1' }] } },
    { name: 'import-a-whole', cset: { valueSet: [refUrls[0]] } },
    { name: 'import-intersect-a', cset: { valueSet: [refUrls[0], refUrls[1]] } },
    { name: 'import-a-v1', cset: { valueSet: [refUrls[2]] } },
    { name: 'a-whole-and-import-lab', cset: { system: SYS.A, valueSet: [refUrls[1]] } },
    { name: 'a-filter-and-import-lab', cset: { system: SYS.A, filter: [{ property: 'kind', op: '=', value: 'lab' }], valueSet: [refUrls[1]] } },
    { name: 'b-concept-and-nested-import', cset: { system: SYS.B, concept: [{ code: 'B-110' }], valueSet: [refUrls[4]] } },
  ];
}

describe('bounded exhaustive compose semantics', () => {
  test('direct compose evaluator matches scoped IR interpretation and partitioned union', async () => {
    const refsByUrl = buildReferenceLibrary();
    const componentCatalog = buildComponentCatalog(refsByUrl);
    const includeCases = combinations(componentCatalog, 2);
    const excludeCases = [[]].concat(combinations(componentCatalog.slice(0, 10), 1));
    let caseCount = 0;

    for (let i = 0; i < includeCases.length; i++) {
      for (let j = 0; j < excludeCases.length; j++) {
        caseCount += 1;
        const includeItems = includeCases[i];
        const excludeItems = excludeCases[j];
        const root = vs(`http://example.org/exhaustive/root/${i}/${j}`, {
          include: includeItems.map(item => cloneJson(item.cset)),
          ...(excludeItems.length > 0 ? { exclude: excludeItems.map(item => cloneJson(item.cset)) } : {}),
        });
        const byUrl = new Map(refsByUrl);
        byUrl.set(root.url, root);

        const direct = sorted(evaluateValueSetDirect(root, byUrl));
        const rawIR = buildIRFromValueSet(root);
        const resolvedIR = await resolveImports(rawIR, async (url) => byUrl.get(url) || null, { maxDepth: 20, maxNodes: 10000 });
        const optimizedIR = optimize(resolvedIR);
        const safety = analyzePartitionSafety(optimizedIR);

        if (!safety.ok) {
          throw new Error(
            `unexpected partition-unsafe exhaustive case ${i}/${j}: ${safety.reason}\n`
            + `include=${JSON.stringify(includeItems.map(x => x.name))}\n`
            + `exclude=${JSON.stringify(excludeItems.map(x => x.name))}\n`
            + `root=${JSON.stringify(root)}`
          );
        }

        const resolvedEval = sorted(interpretScopedIR(resolvedIR, { evaluateSelector: evaluateSelectorDirect }));
        const optimizedEval = sorted(interpretScopedIR(optimizedIR, { evaluateSelector: evaluateSelectorDirect }));

        if (JSON.stringify(direct) !== JSON.stringify(resolvedEval)) {
          throw new Error(
            `direct vs resolved mismatch on exhaustive case ${i}/${j}\n`
            + `include=${JSON.stringify(includeItems.map(x => x.name))}\n`
            + `exclude=${JSON.stringify(excludeItems.map(x => x.name))}\n`
            + `root=${JSON.stringify(root)}\n`
            + `direct=${JSON.stringify(direct)}\n`
            + `resolved=${JSON.stringify(resolvedEval)}`
          );
        }

        if (JSON.stringify(resolvedEval) !== JSON.stringify(optimizedEval)) {
          throw new Error(
            `resolved vs optimized mismatch on exhaustive case ${i}/${j}\n`
            + `include=${JSON.stringify(includeItems.map(x => x.name))}\n`
            + `exclude=${JSON.stringify(excludeItems.map(x => x.name))}\n`
            + `root=${JSON.stringify(root)}\n`
            + `resolved=${JSON.stringify(resolvedEval)}\n`
            + `optimized=${JSON.stringify(optimizedEval)}`
          );
        }

        const projectedUnion = new Set();
        for (const { system, version } of collectSystems(optimizedIR).values()) {
          const projected = projectToSystem(optimizedIR, system, version);
          const projectedEval = interpretScopedIR(projected, { evaluateSelector: evaluateSelectorDirect });
          for (const token of projectedEval) projectedUnion.add(token);
        }
        const projectedSorted = sorted(projectedUnion);
        if (JSON.stringify(projectedSorted) !== JSON.stringify(optimizedEval)) {
          throw new Error(
            `partitioned union mismatch on exhaustive case ${i}/${j}\n`
            + `include=${JSON.stringify(includeItems.map(x => x.name))}\n`
            + `exclude=${JSON.stringify(excludeItems.map(x => x.name))}\n`
            + `root=${JSON.stringify(root)}\n`
            + `optimized=${JSON.stringify(optimizedEval)}\n`
            + `partitioned=${JSON.stringify(projectedSorted)}`
          );
        }
      }
    }

    expect(caseCount).toBeGreaterThan(1000);
  });
});
