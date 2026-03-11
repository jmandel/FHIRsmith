'use strict';

const { setUnion, setIntersect, setDiff } = require('../engine/scoped-ir-interpreter');

function isRowActive(row) {
  return row?.active !== false && row?.active !== 0;
}

function lowerText(value) {
  return String(value || '').toLowerCase();
}

function normalizeRelationEdges(edges, byCode) {
  const descendantsByAncestor = new Map();
  const ancestorsByDescendant = new Map();
  for (const edge of edges || []) {
    const ancestorId = edge?.ancestor_id ?? byCode.get(String(edge?.ancestor_code || ''))?.concept_id;
    const descendantId = edge?.descendant_id ?? byCode.get(String(edge?.descendant_code || ''))?.concept_id;
    if (ancestorId == null || descendantId == null) continue;
    if (!descendantsByAncestor.has(ancestorId)) descendantsByAncestor.set(ancestorId, new Set());
    if (!ancestorsByDescendant.has(descendantId)) ancestorsByDescendant.set(descendantId, new Set());
    descendantsByAncestor.get(ancestorId).add(descendantId);
    ancestorsByDescendant.get(descendantId).add(ancestorId);
  }
  return { descendantsByAncestor, ancestorsByDescendant };
}

function normalizeFixture(fixture) {
  const concepts = Array.isArray(fixture?.concepts) ? fixture.concepts : [];
  const literals = Array.isArray(fixture?.literals) ? fixture.literals : [];
  const links = Array.isArray(fixture?.links) ? fixture.links : [];
  const designations = Array.isArray(fixture?.designations) ? fixture.designations : [];
  const closure = Array.isArray(fixture?.closure) ? fixture.closure : [];
  const relationSetsRaw = fixture?.relations instanceof Map
    ? fixture.relations
    : new Map(Object.entries(fixture?.relations || {}));
  const valueSetMembersRaw = fixture?.valueSetMembers instanceof Map
    ? fixture.valueSetMembers
    : new Map(Object.entries(fixture?.valueSetMembers || {}));

  const byId = new Map();
  const byCode = new Map();
  const allIds = new Set();
  for (const row of concepts) {
    if (row?.concept_id == null) continue;
    byId.set(row.concept_id, row);
    if (row.code) byCode.set(String(row.code), row);
    allIds.add(row.concept_id);
  }

  const literalsByProperty = new Map();
  for (const row of literals) {
    const property = String(row?.property || '');
    if (!property) continue;
    if (!literalsByProperty.has(property)) literalsByProperty.set(property, []);
    literalsByProperty.get(property).push(row);
  }

  const linksByProperty = new Map();
  for (const row of links) {
    const property = String(row?.property || '');
    if (!property) continue;
    if (!linksByProperty.has(property)) linksByProperty.set(property, []);
    linksByProperty.get(property).push(row);
  }

  const relations = new Map();
  relations.set('concept', normalizeRelationEdges(closure, byCode));
  for (const [key, edges] of relationSetsRaw.entries()) {
    relations.set(String(key), normalizeRelationEdges(edges, byCode));
  }

  const valueSetMemberRows = [];
  for (const [url, members] of valueSetMembersRaw.entries()) {
    for (const member of members || []) {
      const conceptId = byId.has(member)
        ? member
        : byCode.get(String(member))?.concept_id;
      if (conceptId != null) {
        valueSetMemberRows.push({ url: String(url), concept_id: conceptId });
      }
    }
  }

  return {
    concepts,
    literals,
    links,
    designations,
    byId,
    byCode,
    allIds,
    literalsByProperty,
    linksByProperty,
    relations,
    valueSetMemberRows,
  };
}

function interpretMembershipPlan(plan, fixture) {
  const state = normalizeFixture(fixture);

  function inScopeConcept(row, scope) {
    if (!scope || !Number.isInteger(scope.csId)) return true;
    if (row?.cs_id == null) return true;
    return row.cs_id === scope.csId;
  }

  function conceptForCodeInScope(code, scope) {
    const wanted = String(code || '');
    for (const row of state.concepts) {
      if (String(row?.code || '') !== wanted) continue;
      if (!inScopeConcept(row, scope)) continue;
      return row;
    }
    return null;
  }

  function evalSet(node) {
    if (!node) return new Set();
    const scope = node.scope || null;
    switch (node.kind) {
    case 'empty':
      return new Set();
    case 'allConcepts':
      return new Set(
        state.concepts
          .filter(row => inScopeConcept(row, scope))
          .map(row => row.concept_id)
      );
    case 'explicitCodes': {
      const out = new Set();
      for (const code of node.codes || []) {
        const row = conceptForCodeInScope(code, scope);
        if (row) out.add(row.concept_id);
      }
      return out;
    }
    case 'fromRows': {
      const out = new Set();
      for (const row of evalRows(node.rows)) {
        const key = row?.[node.key || 'concept_id'];
        if (key != null) out.add(key);
      }
      return out;
    }
    case 'union':
      return (node.items || []).reduce((acc, item) => setUnion(acc, evalSet(item)), new Set());
    case 'intersect': {
      const items = node.items || [];
      if (items.length === 0) {
        return new Set(
          state.concepts
            .filter(row => inScopeConcept(row, scope))
            .map(row => row.concept_id)
        );
      }
      let out = evalSet(items[0]);
      for (const item of items.slice(1)) {
        out = setIntersect(out, evalSet(item));
        if (out.size === 0) break;
      }
      return out;
    }
    case 'diff':
      return setDiff(evalSet(node.left), evalSet(node.right));
    default:
      throw new Error(`Unknown set plan kind ${String(node.kind || '(missing)')}`);
    }
  }

  function evalRows(node) {
    if (!node) return [];
    const scope = node.scope || null;
    switch (node.kind) {
    case 'scan':
      return scanTable(node.table, scope);
    case 'values':
      return (node.rows || []).map(valuesRow => {
        const out = {};
        for (let i = 0; i < (node.columns || []).length; i++) {
          out[node.columns[i]] = valuesRow[i];
        }
        return out;
      });
    case 'project':
      return evalRows(node.input).map(row => projectRow(row, node.columns || []));
    case 'filter':
      return evalRows(node.input).filter(row => matchPredicate(node.predicate, row));
    case 'join':
      return joinRows(evalRows(node.left), evalRows(node.right), node.on, node.joinType || 'inner');
    case 'semiJoin':
      return semiJoinRows(evalRows(node.left), evalRows(node.right), node.on);
    case 'antiJoin':
      return antiJoinRows(evalRows(node.left), evalRows(node.right), node.on);
    case 'unionAll':
      return (node.inputs || []).flatMap(evalRows);
    case 'distinct':
      return distinctRows(evalRows(node.input), node.keys || []);
    case 'reachability':
      return evalReachability(node);
    case 'search':
      return evalSearch(node);
    default:
      throw new Error(`Unknown row plan kind ${String(node.kind || '(missing)')}`);
    }
  }

  function scanTable(table, scope) {
    switch (String(table || '')) {
    case 'concept':
      return state.concepts
        .filter(row => inScopeConcept(row, scope))
        .map(row => ({ ...row }));
    case 'concept_literal':
      return state.literals.map(row => ({ ...row }));
    case 'concept_link':
      return state.links.map(row => ({ ...row }));
    case 'value_set_member':
      return state.valueSetMemberRows.map(row => ({ ...row }));
    default:
      return [];
    }
  }

  function projectRow(row, columns) {
    const out = {};
    for (const column of columns || []) {
      out[column] = row?.[column];
    }
    return out;
  }

  function matchPredicate(predicate, row) {
    if (!predicate || typeof predicate !== 'object') return true;
    switch (predicate.kind) {
    case 'activeEquals':
      return (isRowActive(row) ? 1 : 0) === (predicate.value !== false ? 1 : 0);
    case 'codeRegex':
      return safeRegexTest(predicate.pattern, row?.code);
    case 'valueSetUrlEq':
      return String(row?.url || '') === String(predicate.url || '');
    case 'literalPropertyMatch':
      return String(row?.property || '') === String(predicate.property || '')
        && isRowActive(row)
        && new Set((predicate.values || []).map(lowerText)).has(lowerText(row?.value_text ?? row?.value_raw ?? row?.value));
    case 'literalPropertyRegex':
      return String(row?.property || '') === String(predicate.property || '')
        && isRowActive(row)
        && safeRegexTest(predicate.pattern, row?.value_text ?? row?.value_raw ?? row?.value);
    case 'literalPropertyExists':
      return String(row?.property || '') === String(predicate.property || '')
        && isRowActive(row);
    case 'linkPropertyMatch': {
      if (String(row?.property || '') !== String(predicate.property || '') || !isRowActive(row)) return false;
      const targetId = row.target_concept_id ?? state.byCode.get(String(row.target_code || ''))?.concept_id;
      const target = targetId == null ? null : state.byId.get(targetId);
      if (!target) return false;
      const values = new Set((predicate.values || []).map(lowerText));
      const codeMatch = values.has(lowerText(target.code));
      const displayMatch = values.has(lowerText(target.display));
      return codeMatch || (String(predicate.linkMatch || 'code-only') === 'code-or-display' && displayMatch);
    }
    case 'linkPropertyExists':
      return String(row?.property || '') === String(predicate.property || '')
        && isRowActive(row);
    default:
      throw new Error(`Unknown predicate kind ${String(predicate.kind || '(missing)')}`);
    }
  }

  function safeRegexTest(pattern, value) {
    try {
      return new RegExp(String(pattern || '')).test(String(value || ''));
    } catch {
      return false;
    }
  }

  function joinMatches(on, left, right) {
    if (!on || typeof on !== 'object') return false;
    if (on.kind === 'eq') {
      return left?.[on.leftField] === right?.[on.rightField];
    }
    throw new Error(`Unknown join expr kind ${String(on.kind || '(missing)')}`);
  }

  function joinRows(leftRows, rightRows, on, joinType) {
    const out = [];
    for (const left of leftRows) {
      let matched = false;
      for (const right of rightRows) {
        if (!joinMatches(on, left, right)) continue;
        matched = true;
        out.push({ ...left, ...right });
      }
      if (!matched && String(joinType || 'inner') === 'left') {
        out.push({ ...left });
      }
    }
    return out;
  }

  function semiJoinRows(leftRows, rightRows, on) {
    return leftRows.filter(left => rightRows.some(right => joinMatches(on, left, right)));
  }

  function antiJoinRows(leftRows, rightRows, on) {
    return leftRows.filter(left => !rightRows.some(right => joinMatches(on, left, right)));
  }

  function distinctRows(rows, keys) {
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const key = JSON.stringify((keys || []).map(field => row?.[field]));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out;
  }

  function evalReachability(node) {
    const relation = node?.relation?.key || node?.relation?.property || 'concept';
    const graph = state.relations.get(String(relation)) || { descendantsByAncestor: new Map(), ancestorsByDescendant: new Map() };
    const seeds = evalSet(node.seed);
    const out = new Set();
    const queue = [...seeds];
    const visited = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      const adjacent = node.direction === 'up'
        ? (graph.ancestorsByDescendant.get(current) || new Set())
        : (graph.descendantsByAncestor.get(current) || new Set());
      for (const next of adjacent) {
        if (next == null) continue;
        if (!visited.has(next)) queue.push(next);
      }
    }
    for (const seed of seeds) {
      if (node.includeSelf !== false) out.add(seed);
      else visited.delete(seed);
    }
    for (const id of visited) out.add(id);
    if (node.includeSelf === false) {
      for (const seed of seeds) out.delete(seed);
    }
    return [...out].map(concept_id => ({ concept_id }));
  }

  function evalSearch(node) {
    const query = lowerText(node.text);
    if (!query) return [];
    const spec = node.spec || {};
    const sources = new Set(spec.sources || []);
    const scope = node.scope || null;
    const out = new Set();

    if (sources.has('display')) {
      for (const row of state.byId.values()) {
        if (!inScopeConcept(row, scope)) continue;
        if (spec.activeOnlyConcepts !== false && !isRowActive(row)) continue;
        if (lowerText(row.display).includes(query)) out.add(row.concept_id);
      }
    }

    if (sources.has('designation')) {
      for (const row of state.designations || []) {
        if (spec.designationActiveOnly !== false && !isRowActive(row)) continue;
        const concept = state.byId.get(row.concept_id);
        if (!concept) continue;
        if (!inScopeConcept(concept, scope)) continue;
        if (spec.activeOnlyConcepts !== false && !isRowActive(concept)) continue;
        if (lowerText(row.value_text ?? row.value).includes(query)) out.add(row.concept_id);
      }
    }

    if (sources.has('literal')) {
      for (const row of state.literals || []) {
        if (spec.literalActiveOnly !== false && !isRowActive(row)) continue;
        const concept = state.byId.get(row.source_concept_id);
        if (!concept) continue;
        if (!inScopeConcept(concept, scope)) continue;
        if (spec.activeOnlyConcepts !== false && !isRowActive(concept)) continue;
        if (lowerText(row.value_text ?? row.value).includes(query)) out.add(row.source_concept_id);
      }
    }

    return [...out].sort((a, b) => a - b).map(concept_id => ({ concept_id }));
  }

  return evalSet(plan);
}

function conceptIdsToCodes(ids, fixture) {
  const concepts = Array.isArray(fixture?.concepts) ? fixture.concepts : [];
  const byId = new Map(concepts.map(row => [row.concept_id, row]));
  return [...ids]
    .map(id => byId.get(id)?.code)
    .filter(Boolean)
    .sort();
}

module.exports = {
  conceptIdsToCodes,
  interpretMembershipPlan,
};
