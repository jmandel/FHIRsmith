'use strict';

const { buildIRFromValueSet } = require('../../tx/engine/build-ir');
const { resolveImports } = require('../../tx/engine/resolve-imports');
const {
  optimize,
  collectSystems,
  projectToSystem,
  analyzePartitionSafety,
} = require('../../tx/engine/rewrite');
const { expandViaIR } = require('../../tx/engine/orchestrator');

jest.setTimeout(60000);

const SYSTEMS = ['urn:sys:A', 'urn:sys:B'];
const SYSTEM_VERSIONS = {
  'urn:sys:A': ['A.v1', 'A.v2'],
  'urn:sys:B': ['B.v1', 'B.v2'],
};
const KINDS = ['lab', 'diag', 'rx', 'root'];

class RNG {
  constructor(seed) {
    this.state = seed >>> 0 || 1;
  }

  next() {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }

  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }

  chance(p) {
    return this.next() < p;
  }
}

function makeCatalog() {
  const bySystem = new Map();

  function put(system, rows) {
    const byCode = new Map();
    const children = new Map();
    for (const r of rows) {
      byCode.set(r.code, { ...r });
      children.set(r.code, []);
    }
    for (const r of rows) {
      for (const p of r.parents) {
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(r.code);
      }
    }
    const roots = rows.filter(r => r.parents.length === 0).map(r => r.code).sort();
    for (const list of children.values()) list.sort();
    bySystem.set(system, { byCode, children, roots });
  }

  put('urn:sys:A', [
    { code: 'A-100', display: 'Alpha Root', definition: 'alpha root', active: true, kind: 'root', parents: [] },
    { code: 'A-110', display: 'Alpha Lab Child', definition: 'alpha lab', active: true, kind: 'lab', parents: ['A-100'] },
    { code: 'A-120', display: 'Alpha Diag Child', definition: 'alpha diag', active: false, kind: 'diag', parents: ['A-100'] },
    { code: 'A-121', display: 'Alpha Diag Grandchild', definition: 'alpha diag gc', active: true, kind: 'diag', parents: ['A-120'] },
    { code: 'A-130', display: 'Alpha Rx Leaf', definition: 'alpha rx', active: true, kind: 'rx', parents: ['A-110'] },
    { code: 'A-140', display: 'Alpha Lab Solo', definition: 'alpha solo', active: true, kind: 'lab', parents: [] },
    { code: 'A-150', display: 'Alpha Rx Solo', definition: 'alpha rx solo', active: false, kind: 'rx', parents: [] },
    { code: 'A-160', display: 'Alpha Diag Solo', definition: 'alpha diag solo', active: true, kind: 'diag', parents: [] },
  ]);

  put('urn:sys:B', [
    { code: 'B-200', display: 'Beta Root', definition: 'beta root', active: true, kind: 'root', parents: [] },
    { code: 'B-210', display: 'Beta Lab Child', definition: 'beta lab', active: true, kind: 'lab', parents: ['B-200'] },
    { code: 'B-220', display: 'Beta Diag Child', definition: 'beta diag', active: true, kind: 'diag', parents: ['B-200'] },
    { code: 'B-221', display: 'Beta Diag Grandchild', definition: 'beta diag gc', active: true, kind: 'diag', parents: ['B-220'] },
    { code: 'B-230', display: 'Beta Rx Leaf', definition: 'beta rx', active: false, kind: 'rx', parents: ['B-210'] },
    { code: 'B-240', display: 'Beta Lab Solo', definition: 'beta solo', active: true, kind: 'lab', parents: [] },
    { code: 'B-250', display: 'Beta Rx Solo', definition: 'beta rx solo', active: true, kind: 'rx', parents: [] },
    { code: 'B-260', display: 'Beta Diag Solo', definition: 'beta diag solo', active: false, kind: 'diag', parents: [] },
  ]);

  return bySystem;
}

const CATALOG = makeCatalog();

function tokenOf(system, code, version = null) {
  return `${system}|${version || ''}|${code}`;
}

function parseToken(token) {
  const parts = String(token || '').split('|');
  const code = parts.pop() || '';
  const version = parts.pop() || null;
  const system = parts.join('|');
  return { system, version, code };
}

function parseRef(ref) {
  const raw = String(ref || '');
  if (!raw.includes('|')) return { url: raw, version: null };
  const i = raw.indexOf('|');
  return { url: raw.slice(0, i), version: raw.slice(i + 1) || null };
}

function descendants(system, code, includeSelf) {
  const sys = CATALOG.get(system);
  if (!sys || !sys.byCode.has(code)) return new Set();
  const out = new Set();
  const queue = includeSelf ? [code] : [...(sys.children.get(code) || [])];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (out.has(cur)) continue;
    out.add(cur);
    for (const ch of sys.children.get(cur) || []) queue.push(ch);
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
  const p = String(clause.property || '');
  const op = String(clause.op || '');
  const v = clause.value != null ? String(clause.value) : '';

  if (p === 'concept' && op === 'is-a') {
    const set = descendants(system, v, true);
    return new Set([...set].map(code => tokenOf(system, code, version)));
  }
  if (p === 'concept' && op === 'descendent-of') {
    const set = descendants(system, v, false);
    return new Set([...set].map(code => tokenOf(system, code, version)));
  }
  if (p === 'kind' && op === '=') {
    return new Set(
      [...sys.byCode.values()]
        .filter(c => c.kind === v)
        .map(c => tokenOf(system, c.code, version))
    );
  }
  if (p === 'code' && op === 'regex') {
    let re;
    try { re = new RegExp(v); } catch { return new Set(); }
    return new Set(
      [...sys.byCode.values()]
        .filter(c => re.test(c.code))
        .map(c => tokenOf(system, c.code, version))
    );
  }
  return new Set();
}

function unionInto(target, source) {
  for (const x of source) target.add(x);
  return target;
}

function intersect(a, b) {
  const out = new Set();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

function diff(a, b) {
  const out = new Set();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}

function sorted(arrOrSet) {
  return [...arrOrSet].sort();
}

function allCodes(system) {
  return sorted(CATALOG.get(system).byCode.keys());
}

function pickDistinct(rng, arr, n) {
  const copy = [...arr];
  const out = [];
  while (copy.length > 0 && out.length < n) {
    const i = rng.int(0, copy.length - 1);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

function randomRegexForSystem(system, rng) {
  const prefix = system.endsWith('A') ? 'A' : 'B';
  const options = [
    `^${prefix}-1`,
    `^${prefix}-2`,
    `^${prefix}-..0$`,
    `^${prefix}-2[12]`,
  ];
  return rng.pick(options);
}

function buildRandomComponent(rng, prevUrls) {
  const canImport = prevUrls.length > 0;
  if (canImport && rng.chance(0.3)) {
    const refs = pickDistinct(rng, prevUrls, rng.int(1, Math.min(2, prevUrls.length)));
    return { valueSet: refs };
  }

  const system = rng.pick(SYSTEMS);
  const mode = rng.pick(['concept', 'filter', 'whole']);
  const comp = { system };
  if (rng.chance(0.35)) {
    comp.version = rng.pick(SYSTEM_VERSIONS[system]);
  }

  if (mode === 'concept') {
    const codes = pickDistinct(rng, allCodes(system), rng.int(1, 4));
    comp.concept = codes.map(code => ({ code }));
  } else if (mode === 'filter') {
    const clauses = [];
    const n = rng.int(1, 2);
    for (let i = 0; i < n; i++) {
      const kind = rng.pick(['isa', 'desc', 'kind', 'regex']);
      if (kind === 'isa') {
        clauses.push({
          property: 'concept',
          op: 'is-a',
          value: rng.pick(allCodes(system)),
        });
      } else if (kind === 'desc') {
        clauses.push({
          property: 'concept',
          op: 'descendent-of',
          value: rng.pick(allCodes(system)),
        });
      } else if (kind === 'kind') {
        clauses.push({
          property: 'kind',
          op: '=',
          value: rng.pick(KINDS),
        });
      } else {
        clauses.push({
          property: 'code',
          op: 'regex',
          value: randomRegexForSystem(system, rng),
        });
      }
    }
    comp.filter = clauses;
  }

  if (!comp.version && canImport && rng.chance(0.35)) {
    comp.valueSet = pickDistinct(rng, prevUrls, rng.int(1, Math.min(2, prevUrls.length)));
  }

  return comp;
}

function buildRandomLibrary(seed) {
  const rng = new RNG(seed);
  const n = rng.int(5, 10);
  const list = [];
  const byUrl = new Map();
  let hasImport = false;

  for (let i = 0; i < n; i++) {
    const url = `http://example.org/fuzz/vs/${seed}/${i}`;
    const prevUrls = list.map(v => v.url);
    const includeN = rng.int(1, 3);
    const excludeN = rng.int(0, 2);
    const include = [];
    const exclude = [];

    for (let j = 0; j < includeN; j++) {
      const c = buildRandomComponent(rng, prevUrls);
      if (c.valueSet && c.valueSet.length > 0) hasImport = true;
      include.push(c);
    }
    for (let j = 0; j < excludeN; j++) {
      const c = buildRandomComponent(rng, prevUrls);
      if (c.valueSet && c.valueSet.length > 0) hasImport = true;
      exclude.push(c);
    }

    const vs = {
      resourceType: 'ValueSet',
      url,
      compose: { include, ...(exclude.length > 0 ? { exclude } : {}) },
    };
    list.push(vs);
    byUrl.set(url, vs);
  }

  // Ensure recursion/import paths are represented in every seed corpus.
  if (!hasImport && list.length > 1) {
    const last = list[list.length - 1];
    last.compose.include.push({ valueSet: [list[list.length - 2].url] });
  }

  return {
    root: list[list.length - 1],
    byUrl,
  };
}

function countVersionedComponents(byUrl) {
  let n = 0;
  for (const vs of byUrl.values()) {
    const include = Array.isArray(vs?.compose?.include) ? vs.compose.include : [];
    const exclude = Array.isArray(vs?.compose?.exclude) ? vs.compose.exclude : [];
    for (const c of [...include, ...exclude]) {
      if (c?.version) n += 1;
    }
  }
  return n;
}

function evalComponentDirect(cset, evalRef) {
  if (!cset.system) {
    const refs = cset.valueSet || [];
    if (refs.length === 0) return new Set();
    let out = new Set(evalRef(refs[0]));
    for (const ref of refs.slice(1)) {
      out = intersect(out, evalRef(ref));
      if (out.size === 0) break;
    }
    return out;
  }

  const system = String(cset.system);
  const version = cset.version ? String(cset.version) : null;
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
      set = intersect(set, tokensForClause(system, clause, version));
    }
  } else {
    set = allTokensForSystem(system, version);
  }

  if (Array.isArray(cset.valueSet) && cset.valueSet.length > 0) {
    // For system-scoped components, multiple imports are conjunctive:
    // include only codes present in each referenced ValueSet.
    for (const ref of cset.valueSet) {
      set = intersect(set, evalRef(ref));
      if (set.size === 0) break;
    }
  }

  return set;
}

function evaluateValueSetDirect(vs, byUrl) {
  const memo = new Map();
  const stack = [];

  function evalRef(ref) {
    const { url } = parseRef(ref);
    return evalUrl(url);
  }

  function evalUrl(url) {
    if (memo.has(url)) return memo.get(url);
    if (stack.includes(url)) throw new Error(`Import cycle in fuzz corpus: ${[...stack, url].join(' -> ')}`);
    const target = byUrl.get(url);
    if (!target) return new Set();
    stack.push(url);
    try {
      const include = target.compose?.include || [];
      const exclude = target.compose?.exclude || [];
      let inc = new Set();
      let exc = new Set();
      for (const c of include) unionInto(inc, evalComponentDirect(c, evalRef));
      for (const c of exclude) unionInto(exc, evalComponentDirect(c, evalRef));
      const out = diff(inc, exc);
      memo.set(url, out);
      return out;
    } finally {
      stack.pop();
    }
  }

  return evalUrl(vs.url);
}

function evaluateIR(node) {
  if (!node) return new Set();
  switch (node.kind) {
  case 'empty':
    return new Set();
  case 'selector': {
    const system = String(node.system || '');
    const version = node.version ? String(node.version) : null;
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
        out = intersect(out, tokensForClause(system, clause, version));
      }
      if (Array.isArray(node.intersectCodes) && node.intersectCodes.length > 0) {
        const allow = new Set(node.intersectCodes.map(code => tokenOf(system, String(code), version)));
        out = intersect(out, allow);
      }
      return out;
    }
    return allTokensForSystem(system, version);
  }
  case 'import':
    return node.resolved ? evaluateIR(node.resolved) : new Set();
  case 'union':
    return (node.items || []).reduce((acc, it) => unionInto(acc, evaluateIR(it)), new Set());
  case 'intersect': {
    const items = node.items || [];
    if (items.length === 0) return new Set();
    return items.slice(1).reduce((acc, it) => intersect(acc, evaluateIR(it)), evaluateIR(items[0]));
  }
  case 'diff':
    return diff(evaluateIR(node.left), evaluateIR(node.right));
  default:
    return new Set();
  }
}

function buildTokenMeta() {
  const map = new Map();
  for (const [system, data] of CATALOG.entries()) {
    for (const c of data.byCode.values()) {
      map.set(tokenOf(system, c.code, null), c);
      for (const version of SYSTEM_VERSIONS[system] || []) {
        map.set(tokenOf(system, c.code, version), c);
      }
    }
  }
  return map;
}

const TOKEN_META = buildTokenMeta();

function applyRequestFilters(tokens, opts) {
  let out = new Set(tokens);
  if (opts.activeOnly) {
    out = new Set([...out].filter(t => TOKEN_META.get(t)?.active));
  }
  if (opts.text) {
    const q = String(opts.text).toLowerCase();
    out = new Set([...out].filter(t => {
      const { system, code } = parseToken(t);
      const meta = TOKEN_META.get(t);
      if (!meta) return false;
      return code.toLowerCase().includes(q)
        || (meta.display || '').toLowerCase().includes(q)
        || system.toLowerCase().includes(q);
    }));
  }
  return out;
}

function pageTokens(tokens, offset, count) {
  const ordered = sorted(tokens).sort((a, b) => {
    const ta = parseToken(a);
    const tb = parseToken(b);
    const sa = ta.system;
    const sb = tb.system;
    const va = ta.version || '';
    const vb = tb.version || '';
    const ca = ta.code;
    const cb = tb.code;
    if (sa !== sb) return sa < sb ? -1 : 1;
    if (va !== vb) return va < vb ? -1 : 1;
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
  if (count === 0) return [];
  const off = Math.max(0, offset || 0);
  const lim = count != null ? Math.max(0, count) : ordered.length;
  return ordered.slice(off, off + lim);
}

function flattenContains(contains, out = []) {
  for (const c of contains || []) {
    if (c.system && c.code) out.push(tokenOf(c.system, c.code, c.version || null));
    flattenContains(c.contains, out);
  }
  return out;
}

class ToyProvider {
  constructor(system) {
    this._system = system;
    this._data = CATALOG.get(system);
  }

  system() { return this._system; }
  version() { return null; }
  name() { return `Toy ${this._system}`; }
  contentMode() { return 'complete'; }
  status() { return { status: 'active', standardsStatus: 'normative', experimental: false }; }
  hasParents() { return true; }

  async locate(input) {
    const code = typeof input === 'string' ? input : input?.code;
    const ctx = this._data.byCode.get(code);
    return ctx ? { context: ctx } : { context: null };
  }

  async code(ctx) { return ctx.code; }
  async display(ctx) { return ctx.display; }
  async definition(ctx) { return ctx.definition; }
  async isInactive(ctx) { return !ctx.active; }
  async parent(ctx) { return (ctx.parents && ctx.parents[0]) || null; }

  async iterator(parentCtx) {
    const codes = parentCtx
      ? [...(this._data.children.get(parentCtx.code) || [])]
      : [...this._data.roots];
    return { codes, index: 0 };
  }

  async iteratorAll() {
    return { codes: sorted(this._data.byCode.keys()), index: 0 };
  }

  async nextContext(iter) {
    if (!iter || iter.index >= iter.codes.length) return null;
    const code = iter.codes[iter.index++];
    return this._data.byCode.get(code) || null;
  }

  async getPrepContext() {
    return { clauses: [] };
  }

  async filter(prep, property, op, value) {
    prep.clauses.push({ property, op, value });
  }

  async executeFilters(prep) {
    const sets = [];
    for (const clause of prep.clauses || []) {
      const tokSet = tokensForClause(this._system, clause);
      const codeSet = new Set([...tokSet].map(t => parseToken(t).code));
      sets.push({ codes: sorted(codeSet), index: 0, codeSet });
    }
    return sets;
  }

  async filterMore(prep, set) {
    return set.index < set.codes.length;
  }

  async filterConcept(prep, set) {
    const code = set.codes[set.index++];
    return this._data.byCode.get(code) || null;
  }

  async filterCheck(prep, set, ctx) {
    return set.codeSet.has(ctx.code);
  }
}

describe('direct oracle semantics', () => {
  test('systemless include with multiple imports is conjunctive', () => {
    const a = {
      resourceType: 'ValueSet',
      url: 'http://example.org/a',
      compose: { include: [{ system: 'urn:sys:A', concept: [{ code: 'A-110' }, { code: 'A-120' }] }] },
    };
    const b = {
      resourceType: 'ValueSet',
      url: 'http://example.org/b',
      compose: { include: [{ system: 'urn:sys:A', concept: [{ code: 'A-120' }, { code: 'A-121' }] }] },
    };
    const root = {
      resourceType: 'ValueSet',
      url: 'http://example.org/root',
      compose: { include: [{ valueSet: [a.url, b.url] }] },
    };
    const byUrl = new Map([
      [a.url, a],
      [b.url, b],
      [root.url, root],
    ]);

    const out = sorted(evaluateValueSetDirect(root, byUrl));
    expect(out).toEqual([tokenOf('urn:sys:A', 'A-120', null)]);
  });
});

describe('IR semantic fuzz (recursive compositional ValueSets)', () => {
  const seedCount = Math.max(10, parseInt(process.env.IR_FUZZ_SEEDS || '120', 10));
  const seedOnly = process.env.IR_FUZZ_SEED_ONLY ? parseInt(process.env.IR_FUZZ_SEED_ONLY, 10) : null;
  const strictDirectOracle = process.env.IR_FUZZ_STRICT_DIRECT === '1';

  test('random corpus generation includes versioned include/exclude components', () => {
    let versioned = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { byUrl } = buildRandomLibrary(seed);
      versioned += countVersionedComponents(byUrl);
    }
    expect(versioned).toBeGreaterThan(0);
  });

  test(`fuzzes ${seedCount} random seeds with independent reference semantics`, async () => {
    const start = Number.isInteger(seedOnly) ? seedOnly : 1;
    const end = Number.isInteger(seedOnly) ? seedOnly : seedCount;
    for (let seed = start; seed <= end; seed++) {
      const { root, byUrl } = buildRandomLibrary(seed);
      const expectedRaw = strictDirectOracle ? evaluateValueSetDirect(root, byUrl) : null;

      const rawIR = buildIRFromValueSet(root);
      const resolvedIR = await resolveImports(rawIR, async (url) => byUrl.get(url) || null, { maxDepth: 50 });
      const optimizedIR = optimize(resolvedIR);

      const safety = analyzePartitionSafety(optimizedIR);
      if (!safety.ok) {
        throw new Error(`seed ${seed}: expected partition-safe IR but got ${safety.reason}`);
      }

      const evalResolved = evaluateIR(resolvedIR);
      const evalOptimized = evaluateIR(optimizedIR);
      if (strictDirectOracle && JSON.stringify(sorted(evalResolved)) !== JSON.stringify(sorted(expectedRaw))) {
        const corpus = [...byUrl.values()].map(v => ({ url: v.url, compose: v.compose }));
        throw new Error(
          `seed ${seed}: resolved IR semantics mismatch vs direct evaluator\n`
          + `corpus=${JSON.stringify(corpus)}\n`
          + `root=${JSON.stringify(root)}\n`
          + `resolvedIR=${JSON.stringify(resolvedIR)}\n`
          + `expected=${JSON.stringify(sorted(expectedRaw))}\n`
          + `resolved=${JSON.stringify(sorted(evalResolved))}`
        );
      }
      if (JSON.stringify(sorted(evalOptimized)) !== JSON.stringify(sorted(evalResolved))) {
        throw new Error(
          `seed ${seed}: optimized IR semantics mismatch vs resolved IR\n`
          + `root=${JSON.stringify(root)}\n`
          + `resolved=${JSON.stringify(sorted(evalResolved))}\n`
          + `optimized=${JSON.stringify(sorted(evalOptimized))}`
        );
      }

      // Partition theorem check:
      // eval(E) == union over systems of eval(projectToSystem(E, s)).
      const projectedUnion = new Set();
      for (const { system, version } of collectSystems(optimizedIR).values()) {
        const projected = projectToSystem(optimizedIR, system, version);
        unionInto(projectedUnion, evaluateIR(projected));
      }
      if (JSON.stringify(sorted(projectedUnion)) !== JSON.stringify(sorted(evalOptimized))) {
        throw new Error(`seed ${seed}: partitioned union mismatch`);
      }

      // End-to-end IR expansion check against independent evaluator semantics.
      const rng = new RNG(seed * 7919 + 17);
      const req = {
        activeOnly: rng.chance(0.5),
        text: rng.chance(0.4) ? rng.pick(['alpha', 'beta', 'lab', 'diag', 'rx', 'solo']) : null,
      };

      const expectedFiltered = applyRequestFilters(evalOptimized, req);

      const providers = new Map([
        ['urn:sys:A', new ToyProvider('urn:sys:A')],
        ['urn:sys:B', new ToyProvider('urn:sys:B')],
      ]);

      const totalOnly = await expandViaIR(root, {
        findProvider: async (system) => providers.get(system) || null,
        resolveValueSet: async (url) => byUrl.get(url) || null,
        activeOnly: req.activeOnly,
        text: req.text,
        offset: 0,
        count: 0,
      });

      if (!totalOnly) {
        throw new Error(`seed ${seed}: expandViaIR returned null unexpectedly`);
      }

      const fullResult = await expandViaIR(root, {
        findProvider: async (system) => providers.get(system) || null,
        resolveValueSet: async (url) => byUrl.get(url) || null,
        activeOnly: req.activeOnly,
        text: req.text,
        offset: 0,
        count: 1000,
      });
      if (!fullResult) {
        throw new Error(`seed ${seed}: expandViaIR full fetch returned null unexpectedly`);
      }
      const actualTotal = totalOnly.expansion.total;
      const actualFull = sorted(flattenContains(fullResult.expansion.contains || []));
      if (actualTotal !== expectedFiltered.size) {
        throw new Error(
          `seed ${seed}: total mismatch expected ${expectedFiltered.size} got ${actualTotal}\n`
          + `req=${JSON.stringify(req)}\n`
          + `root=${JSON.stringify(root)}\n`
          + `expectedFiltered=${JSON.stringify(sorted(expectedFiltered))}\n`
          + `actualTotalOnlyContains=${JSON.stringify(sorted(flattenContains(totalOnly.expansion.contains || [])))}\n`
          + `actualFull=${JSON.stringify(actualFull)}\n`
          + `optimizedIR=${JSON.stringify(optimizedIR)}`
        );
      }
      if (JSON.stringify(actualFull) !== JSON.stringify(sorted(expectedFiltered))) {
        throw new Error(
          `seed ${seed}: full membership mismatch\n`
          + `req=${JSON.stringify(req)}\n`
          + `root=${JSON.stringify(root)}\n`
          + `expectedFiltered=${JSON.stringify(sorted(expectedFiltered))}\n`
          + `actualFull=${JSON.stringify(actualFull)}\n`
          + `optimizedIR=${JSON.stringify(optimizedIR)}`
        );
      }
    }
  });
});
