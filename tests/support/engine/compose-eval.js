'use strict';

const { allCodes, codeToConceptId, sortStrings } = require('../terminology-model/model');

function evaluateValueSetCompose(rootValueSet, model, byUrl = new Map()) {
  const memo = new Map();
  const stack = [];

  function evalRef(ref) {
    const raw = String(ref || '');
    const url = raw.includes('|') ? raw.slice(0, raw.indexOf('|')) : raw;
    return evalUrl(url);
  }

  function evalUrl(url) {
    if (memo.has(url)) return memo.get(url);
    if (stack.includes(url)) {
      throw new Error(`cycle in compose evaluator: ${[...stack, url].join(' -> ')}`);
    }
    const target = byUrl.get(url);
    if (!target) return new Set();
    stack.push(url);
    try {
      let include = new Set();
      let exclude = new Set();
      for (const component of target.compose?.include || []) {
        include = union(include, evalComponent(component));
      }
      for (const component of target.compose?.exclude || []) {
        exclude = union(exclude, evalComponent(component));
      }
      const out = diff(include, exclude);
      memo.set(url, out);
      return out;
    } finally {
      stack.pop();
    }
  }

  function evalComponent(component) {
    if (!component?.system) {
      const refs = component?.valueSet || [];
      if (refs.length === 0) return new Set();
      let out = new Set(evalRef(refs[0]));
      for (const ref of refs.slice(1)) out = intersect(out, evalRef(ref));
      return out;
    }

    let out;
    if (Array.isArray(component.concept) && component.concept.length > 0) {
      out = new Set(
        component.concept
          .map(entry => String(entry?.code || ''))
          .filter(code => codeToConceptId(model, code) != null)
      );
    } else if (Array.isArray(component.filter) && component.filter.length > 0) {
      out = new Set(allCodes(model));
      for (const clause of component.filter) {
        out = intersect(out, evaluateFilterClause(clause, model));
      }
    } else {
      out = new Set(allCodes(model));
    }

    if (Array.isArray(component.valueSet) && component.valueSet.length > 0) {
      for (const ref of component.valueSet) {
        out = intersect(out, evalRef(ref));
      }
    }
    return out;
  }

  return evalUrl(rootValueSet.url);
}

function evaluateSelectorOnModel(selector, model) {
  if (!selector || selector.kind !== 'selector') return new Set();
  if (selector.shape === 'whole' || selector.shape === 'all') {
    return new Set(allCodes(model));
  }
  if (selector.shape === 'concept') {
    return new Set(
      (selector.conceptCodes || [])
        .map(entry => String(entry?.code || ''))
        .filter(code => codeToConceptId(model, code) != null)
    );
  }
  let out = new Set(allCodes(model));
  for (const clause of selector.filterClauses || []) {
    out = intersect(out, evaluateFilterClause(clause, model));
  }
  if (Array.isArray(selector.intersectCodes) && selector.intersectCodes.length > 0) {
    const allowed = new Set((selector.intersectCodes || []).map(String));
    out = intersect(out, allowed);
  }
  return out;
}

function evaluateFilterClause(clause, fixture) {
  const property = String(clause?.property || '');
  const op = String(clause?.op || '');
  const value = String(clause?.value || '');

  if (property === 'concept' && op === 'is-a') {
    return descendants(fixture, value, true);
  }
  if (property === 'concept' && op === 'descendent-of') {
    return descendants(fixture, value, false);
  }
  if (property === 'concept' && op === 'in') {
    return new Set(
      (fixture?.valueSetMembers?.[value] || [])
        .map(id => fixture.concepts.find(c => c.concept_id === id)?.code)
        .filter(Boolean)
    );
  }
  if (property === 'code' && op === 'regex') {
    let re;
    try {
      re = new RegExp(value);
    } catch {
      return new Set();
    }
    return new Set(allCodes(fixture).filter(code => re.test(code)));
  }
  if (property === 'CLASS' && op === '=') {
    const target = value === 'chemistry' ? 'CHEM' : value;
    return new Set(
      (fixture?.literals || [])
        .filter(row => row.property === 'CLASS' && String(row.value_text || row.value_raw || '') === target)
        .map(row => fixture.concepts.find(c => c.concept_id === row.source_concept_id)?.code)
        .filter(Boolean)
    );
  }
  return new Set();
}

function descendants(model, code, includeSelf) {
  const start = codeToConceptId(model, code);
  if (start == null) return new Set();
  const childMap = new Map();
  for (const edge of model?.closure || []) {
    if (!childMap.has(edge.ancestor_id)) childMap.set(edge.ancestor_id, new Set());
    childMap.get(edge.ancestor_id).add(edge.descendant_id);
  }
  const out = new Set();
  const queue = includeSelf ? [start] : [...(childMap.get(start) || [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (out.has(current)) continue;
    out.add(current);
    for (const next of childMap.get(current) || []) {
      if (!out.has(next)) queue.push(next);
    }
  }
  if (!includeSelf) out.delete(start);
  return new Set(
    sortStrings(
      [...out].map(id => model.concepts.find(c => c.concept_id === id)?.code).filter(Boolean)
    )
  );
}

function union(a, b) {
  return new Set([...a, ...b]);
}

function intersect(a, b) {
  return new Set([...a].filter(value => b.has(value)));
}

function diff(a, b) {
  return new Set([...a].filter(value => !b.has(value)));
}

module.exports = {
  evaluateFilterClause,
  evaluateSelectorOnModel,
  evaluateValueSetCompose,
};
