'use strict';

function loweringEnabled() {
  return process.env.EXPAND_V3_DISABLE_QUERYIR_LOWERING !== '1';
}

function compileSelectorToQueryIR(selectorNode, opts = {}) {
  if (!selectorNode || !selectorNode.system) return null;

  const text = normalizeTextFilter(opts.textFilter);
  const base = {
    system: selectorNode.system,
    version: selectorNode.version || null,
    select: null,
    ops: [],
  };

  switch (selectorNode.shape) {
  case 'all':
  case 'whole':
    base.select = { kind: 'all' };
    break;
  case 'concept':
    base.select = {
      kind: 'concept',
      codes: (selectorNode.conceptCodes || []).map(c => String(c.code || '')).filter(Boolean),
    };
    break;
  case 'filter':
    base.select = {
      kind: 'filter',
      clauses: (selectorNode.filterClauses || []).map(fc => ({
        property: fc.property,
        op: fc.op,
        value: fc.value,
      })),
    };
    break;
  default:
    return null;
  }

  if (text) base.select.text = text;
  return base;
}

function compileExprToQueryIR(expr, opts = {}) {
  const scope = { system: null, version: null };

  function compile(node) {
    if (!node || node.kind === 'empty') return null;

    switch (node.kind) {
    case 'selector': {
      const query = compileSelectorToQueryIR(node, opts);
      if (!query) return null;
      if (!scope.system) {
        scope.system = query.system;
        scope.version = query.version || null;
        return query;
      }
      if (scope.system !== query.system || (scope.version || null) !== (query.version || null)) return null;
      return query;
    }
    case 'import':
      return node.resolved ? compile(node.resolved) : null;
    case 'union':
      return compileNary(node.items || [], 'union');
    case 'intersect': {
      // Lower intersect-over-union at IR level:
      //   Intersect(A, Union(B, C)) -> Union(Intersect(A, B), Intersect(A, C))
      // This avoids nested queryIR ops that provider-core cannot lower into
      // include/exclude component requests.
      if (loweringEnabled()) {
        const distributed = distributeIntersectOverUnion(node);
        if (distributed) return compile(distributed);
      }
      return compileNary(node.items || [], 'intersect');
    }
    case 'diff': {
      const left = compile(node.left);
      const right = compile(node.right);
      if (!left) return null;
      if (!right) return left;
      if (loweringEnabled()) {
        const loweredDiff = lowerExceptOverDiff(left, right);
        if (loweredDiff) return loweredDiff;
      }
      const out = cloneQueryIR(left);
      const rightTerms = loweringEnabled() ? explodeUnionTerms(right) : null;
      if (loweringEnabled() && rightTerms && rightTerms.length > 0) {
        for (const term of rightTerms) {
          out.ops.push({ op: 'except', with: cloneQueryIR(term) });
        }
      } else {
        out.ops.push({ op: 'except', with: cloneQueryIR(right) });
      }
      return out;
    }
    default:
      return null;
    }
  }

  function compileNary(items, opName) {
    const compiled = [];
    for (const item of (items || [])) {
      const c = compile(item);
      if (!c) {
        // Empty members can be dropped, but any non-empty member that cannot
        // compile makes the whole n-ary expression non-compilable.
        if (item && item.kind !== 'empty') return null;
        continue;
      }
      compiled.push(c);
    }
    if (compiled.length === 0) return null;
    let out = cloneQueryIR(compiled[0]);
    for (let i = 1; i < compiled.length; i++) {
      const rhs = cloneQueryIR(compiled[i]);
      if (opName === 'intersect' && loweringEnabled()) {
        const distributed = distributeIntersectQueryIR(out, rhs);
        if (distributed) {
          out = distributed;
          continue;
        }
        const merged = mergeIntersectQueryIR(out, rhs);
        if (merged) {
          out = merged;
          continue;
        }
      }
      out.ops.push({ op: opName, with: rhs });
    }
    return out;
  }

  function distributeIntersectOverUnion(node) {
    if (!node || node.kind !== 'intersect') return null;
    const items = Array.isArray(node.items) ? node.items : [];
    if (items.length < 2) return null;

    const unionIndex = items.findIndex(it => it && it.kind === 'union' && Array.isArray(it.items) && it.items.length > 0);
    if (unionIndex < 0) return null;

    const unionNode = items[unionIndex];
    const others = [...items.slice(0, unionIndex), ...items.slice(unionIndex + 1)];
    if (others.length === 0) return null;

    return {
      kind: 'union',
      items: unionNode.items.map(item => ({
        kind: 'intersect',
        items: [...others, item],
        meta: node.meta || null,
      })),
      meta: node.meta || null,
    };
  }

  function distributeIntersectQueryIR(left, right) {
    const leftTerms = explodeUnionTerms(left);
    const rightTerms = explodeUnionTerms(right);
    if (!leftTerms || !rightTerms) return null;

    const products = [];
    for (const l of leftTerms) {
      for (const r of rightTerms) {
        const merged = mergeIntersectQueryIR(l, r);
        if (!merged) return null;
        products.push(merged);
      }
    }
    if (products.length === 0) return null;
    return foldUnionTerms(products);
  }

  function explodeUnionTerms(query) {
    if (!query) return null;
    const base = cloneQueryIR(query);
    if (!base || !base.select) return null;
    const ops = Array.isArray(base.ops) ? base.ops : [];

    const terms = [{
      system: base.system,
      version: base.version || null,
      select: cloneSelect(base.select),
      ops: [],
    }];

    for (const op of ops) {
      if (!op || op.op !== 'union' || !op.with) return null;
      const rhs = op.with;
      if (Array.isArray(rhs.ops) && rhs.ops.length > 0) return null;
      if ((rhs.system || '') !== (base.system || '')) return null;
      if ((rhs.version || null) !== (base.version || null)) return null;
      terms.push({
        system: rhs.system,
        version: rhs.version || null,
        select: cloneSelect(rhs.select),
        ops: [],
      });
    }
    return terms;
  }

  function foldUnionTerms(terms) {
    if (!Array.isArray(terms) || terms.length === 0) return null;
    const out = cloneQueryIR(terms[0]);
    out.ops = [];
    for (let i = 1; i < terms.length; i++) {
      out.ops.push({ op: 'union', with: cloneQueryIR(terms[i]) });
    }
    return out;
  }

  // QueryIR lowering:
  //   A \ (B \ C1 \ C2 ...)  =>  (A \ B) ∪ (A ∩ C1) ∪ (A ∩ C2) ...
  // Applies only when the right side is a diff-like queryIR encoded as
  // "base select + one-or-more except terms", all same system/version and
  // with non-nested rhs terms.
  function lowerExceptOverDiff(left, right) {
    if (!left || !right || !right.select) return null;
    const ops = Array.isArray(right.ops) ? right.ops : [];
    if (ops.length === 0) return null;
    if (!ops.every(op => op && op.op === 'except' && op.with && (!Array.isArray(op.with.ops) || op.with.ops.length === 0))) {
      return null;
    }

    const baseB = {
      system: right.system,
      version: right.version || null,
      select: cloneSelect(right.select),
      ops: [],
    };
    const outTerms = [];

    const aMinusB = cloneQueryIR(left);
    aMinusB.ops = Array.isArray(aMinusB.ops) ? aMinusB.ops : [];
    aMinusB.ops.push({ op: 'except', with: cloneQueryIR(baseB) });
    outTerms.push(aMinusB);

    for (const op of ops) {
      const c = cloneQueryIR(op.with);
      const aIntersectC = distributeIntersectQueryIR(left, c) || mergeIntersectQueryIR(left, c);
      if (!aIntersectC) return null;
      outTerms.push(aIntersectC);
    }

    return foldUnionTerms(outTerms);
  }

  return compile(expr);
}

function normalizeTextFilter(textFilter) {
  if (!textFilter) return null;
  if (typeof textFilter === 'string') {
    const t = textFilter.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof textFilter.filter === 'string') {
    const t = textFilter.filter.trim();
    return t.length > 0 ? t : null;
  }
  return null;
}

function mergeIntersectQueryIR(left, right) {
  if (!left || !right) return null;
  if ((left.system || '') !== (right.system || '')) return null;
  if ((left.version || null) !== (right.version || null)) return null;
  if ((left.ops || []).length > 0 || (right.ops || []).length > 0) return null;

  const mergedSelect = mergeSelectForIntersect(left.select, right.select);
  if (!mergedSelect) return null;

  return {
    system: left.system,
    version: left.version || null,
    select: mergedSelect,
    ops: [],
  };
}

function mergeSelectForIntersect(a, b) {
  if (!a || !b) return null;
  if (a.kind === 'all') return mergeAllWithSelect(a, b);
  if (b.kind === 'all') return mergeAllWithSelect(b, a);

  if (a.kind === 'concept' && b.kind === 'concept') {
    const text = combineText(a.text, b.text);
    if (text === null && a.text && b.text) return null;
    const aset = new Set((a.codes || []).map(c => String(c)));
    const bset = new Set((b.codes || []).map(c => String(c)));
    const both = [];
    for (const c of aset) {
      if (bset.has(c)) both.push(c);
    }
    return {
      kind: 'concept',
      codes: both,
      ...(text ? { text } : {}),
    };
  }

  if (a.kind === 'filter' && b.kind === 'filter') {
    const text = combineText(a.text, b.text);
    if (text === null && a.text && b.text) return null;
    return {
      kind: 'filter',
      clauses: [...(a.clauses || []), ...(b.clauses || [])],
      ...(text ? { text } : {}),
    };
  }

  if (a.kind === 'filter' && b.kind === 'concept') {
    return mergeFilterConcept(a, b);
  }
  if (a.kind === 'concept' && b.kind === 'filter') {
    return mergeFilterConcept(b, a);
  }

  return null;
}

function mergeAllWithSelect(allSel, otherSel) {
  const text = combineText(allSel.text, otherSel.text);
  if (text === null && allSel.text && otherSel.text) return null;
  const out = cloneSelect(otherSel);
  if (text) out.text = text;
  return out;
}

function mergeFilterConcept(filterSel, conceptSel) {
  const text = combineText(filterSel.text, conceptSel.text);
  if (text === null && filterSel.text && conceptSel.text) return null;
  const codes = (conceptSel.codes || []).map(c => String(c)).filter(Boolean);
  return {
    kind: 'filter',
    clauses: [...(filterSel.clauses || [])],
    intersectCodes: codes,
    ...(text ? { text } : {}),
  };
}

function combineText(a, b) {
  const ta = typeof a === 'string' && a.trim().length > 0 ? a.trim() : null;
  const tb = typeof b === 'string' && b.trim().length > 0 ? b.trim() : null;
  if (!ta && !tb) return null;
  if (ta && !tb) return ta;
  if (!ta && tb) return tb;
  return ta === tb ? ta : null;
}

function cloneSelect(sel) {
  if (!sel) return null;
  const out = { ...sel };
  if (Array.isArray(sel.clauses)) out.clauses = sel.clauses.map(c => ({ ...c }));
  if (Array.isArray(sel.codes)) out.codes = [...sel.codes];
  if (Array.isArray(sel.intersectCodes)) out.intersectCodes = [...sel.intersectCodes];
  return out;
}

function cloneQueryIR(query) {
  if (!query) return query;
  return {
    system: query.system,
    version: query.version || null,
    select: cloneSelect(query.select),
    ops: (query.ops || []).map(op => ({ op: op.op, with: cloneQueryIR(op.with) })),
  };
}

module.exports = {
  compileExprToQueryIR,
  compileSelectorToQueryIR,
};
