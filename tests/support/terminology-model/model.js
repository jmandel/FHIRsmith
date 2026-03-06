'use strict';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortStrings(values) {
  return [...new Set((values || []).map(String).filter(Boolean))].sort();
}

function transitiveClosure(edges) {
  const children = new Map();
  for (const edge of edges || []) {
    if (!children.has(edge.ancestor_id)) children.set(edge.ancestor_id, new Set());
    children.get(edge.ancestor_id).add(edge.descendant_id);
  }
  const nodes = [...new Set((edges || []).flatMap(e => [e.ancestor_id, e.descendant_id]))].sort((a, b) => a - b);
  const result = [];
  for (const node of nodes) {
    const seen = new Set();
    const queue = [node];
    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of children.get(current) || []) {
        if (!seen.has(next)) queue.push(next);
      }
    }
    for (const descendant of seen) {
      result.push({ ancestor_id: node, descendant_id: descendant });
    }
  }
  return result;
}

function buildTinyScopedModel({ activeMask = 3, classMask = 3, refsetMask = 0, hasEdge = false } = {}) {
  const concepts = [
    { concept_id: 1, code: 'A', display: 'Alpha', definition: 'Alpha definition', active: activeMask & 1 ? 1 : 0, cs_id: 1 },
    { concept_id: 2, code: 'B', display: 'Beta', definition: 'Beta definition', active: activeMask & 2 ? 1 : 0, cs_id: 1 },
  ];
  const directEdges = [
    { ancestor_id: 1, descendant_id: 1 },
    { ancestor_id: 2, descendant_id: 2 },
  ];
  if (hasEdge) directEdges.push({ ancestor_id: 1, descendant_id: 2 });
  const closure = transitiveClosure(directEdges);
  const literals = [
    { source_concept_id: 1, property: 'CLASS', value_text: classMask & 1 ? 'CHEM' : 'DIAG', value_raw: classMask & 1 ? 'CHEM' : 'DIAG', active: 1 },
    { source_concept_id: 2, property: 'CLASS', value_text: classMask & 2 ? 'CHEM' : 'DIAG', value_raw: classMask & 2 ? 'CHEM' : 'DIAG', active: 1 },
  ];
  const designations = [
    { concept_id: 1, value_text: 'Alpha designation', term: 'Alpha designation', active: 1 },
    { concept_id: 2, value_text: 'Beta designation', term: 'Beta designation', active: 1 },
  ];
  const members = [];
  if (refsetMask & 1) members.push(1);
  if (refsetMask & 2) members.push(2);
  return {
    system: 'urn:sys:A',
    version: null,
    csId: 1,
    concepts,
    literals,
    designations,
    links: [],
    closure,
    relations: {},
    valueSetMembers: {
      'http://example.org/refset/x': members,
    },
  };
}

function makeDefaultSqliteV0Runtime() {
  return {
    filters: {
      concept: {
        implicitValueSets: {
          'http://example.org/refset/': true,
        },
      },
      properties: {
        defaultSources: ['literal'],
        byCode: {
          CLASS: {
            sources: ['literal'],
            value: {
              aliases: { chemistry: 'CHEM' },
            },
          },
        },
      },
    },
    search: {
      sources: ['display', 'designation', 'literal'],
      activeOnly: true,
      designationActiveOnly: true,
      literalActiveOnly: true,
    },
  };
}

function makeDefaultSqliteV0PropertyDefs() {
  return new Map([
    ['CLASS', { property_id: 1, value_kind: 'literal' }],
  ]);
}

function conceptIdsToCodes(model, conceptIds) {
  const byId = new Map((model?.concepts || []).map(c => [c.concept_id, c.code]));
  return sortStrings([...conceptIds].map(id => byId.get(id)).filter(Boolean));
}

function codeToConceptId(model, code) {
  return (model?.concepts || []).find(c => c.code === code)?.concept_id ?? null;
}

function allCodes(model) {
  return sortStrings((model?.concepts || []).map(c => c.code));
}

module.exports = {
  allCodes,
  buildTinyScopedModel,
  cloneJson,
  codeToConceptId,
  conceptIdsToCodes,
  makeDefaultSqliteV0PropertyDefs,
  makeDefaultSqliteV0Runtime,
  sortStrings,
  transitiveClosure,
};
