'use strict';

const IR = require('../../tx/engine/ir');
const { buildMembershipPlan, buildSelectionPlan } = require('../../tx/cs/sqlite-v0-plan-builder');
const { interpretMembershipPlan, conceptIdsToCodes } = require('../../tx/cs/sqlite-v0-plan-interpret');
const { buildCountPlan, buildMaterializePlan, buildProbePlan } = require('../../tx/cs/sqlite-v0-terminal-builder');
const { physicalizeTerminalPlan } = require('../../tx/cs/sqlite-v0-physicalize');
const { lowerPhysicalPlanToSqlAst } = require('../../tx/cs/sqlite-v0-sql-ast');
const { emitSqlAst } = require('../../tx/cs/sqlite-v0-sql-emit');
const { buildRuntimeSqliteV0Db } = require('../support/sqlite-v0-runtime-db');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick(rng, items) {
  return items[randInt(rng, 0, items.length - 1)];
}

function maybe(rng, p) {
  return rng() < p;
}

function makeRuntime() {
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

function makePropertyDefs() {
  return new Map([
    ['CLASS', { property_id: 1, value_kind: 'literal' }],
  ]);
}

function buildFixture(seed) {
  const rng = mulberry32(seed);
  const size = randInt(rng, 3, 5);
  const concepts = [];
  const literals = [];
  const designations = [];
  const closureEdges = [];
  const members = [];
  const classValues = ['CHEM', 'DIAG'];

  for (let i = 1; i <= size; i++) {
    const code = `C-${i}`;
    const word = pick(rng, ['alpha', 'beta', 'gamma', 'delta']);
    const active = maybe(rng, 0.8) ? 1 : 0;
    concepts.push({
      concept_id: i,
      code,
      display: `${word} ${i}`,
      definition: `${word} definition ${i}`,
      active,
    });
  }

  for (let i = 1; i <= size; i++) {
    const parent = i === 1 ? 1 : randInt(rng, 1, i);
    closureEdges.push({ ancestor_id: i, descendant_id: i });
    if (i !== parent) closureEdges.push({ ancestor_id: parent, descendant_id: i });
  }
  const closure = transitiveClosure(closureEdges);

  for (const concept of concepts) {
    const classValue = pick(rng, classValues);
    literals.push({
      source_concept_id: concept.concept_id,
      property: 'CLASS',
      value_text: classValue,
      value_raw: classValue,
      active: 1,
    });
    if (maybe(rng, 0.5)) {
      designations.push({
        concept_id: concept.concept_id,
        value_text: `${concept.display} ${pick(rng, ['alpha', 'beta', 'chem', 'diag'])}`,
        active: 1,
      });
    }
    if (maybe(rng, 0.5)) members.push(concept.concept_id);
  }

  return {
    concepts,
    literals,
    designations,
    closure,
    relations: {},
    links: [],
    valueSetMembers: {
      'http://example.org/refset/random': members,
    },
  };
}

function transitiveClosure(edges) {
  const children = new Map();
  for (const edge of edges) {
    if (!children.has(edge.ancestor_id)) children.set(edge.ancestor_id, new Set());
    children.get(edge.ancestor_id).add(edge.descendant_id);
  }
  const nodes = [...new Set(edges.flatMap(e => [e.ancestor_id, e.descendant_id]))].sort((a, b) => a - b);
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

function buildExpr(seed, fixture) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const codes = fixture.concepts.map(c => c.code);
  const roots = fixture.closure.filter(e => e.ancestor_id === e.descendant_id).map(e => fixture.concepts.find(c => c.concept_id === e.ancestor_id)?.code).filter(Boolean);
  const selectors = [];
  const count = randInt(rng, 1, 4);
  for (let i = 0; i < count; i++) {
    const kind = pick(rng, ['whole', 'concept', 'conceptIsA', 'conceptDesc', 'conceptIn', 'codeRegex', 'classEq']);
    if (kind === 'whole') {
      selectors.push(IR.selector({ system: 'urn:sys:A', shape: 'whole' }));
    } else if (kind === 'concept') {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'concept',
        conceptCodes: [{ code: pick(rng, codes) }, { code: pick(rng, codes) }],
      }));
    } else if (kind === 'conceptIsA') {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'is-a', value: pick(rng, roots) }],
      }));
    } else if (kind === 'conceptDesc') {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'descendent-of', value: pick(rng, roots) }],
      }));
    } else if (kind === 'conceptIn') {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'concept', op: 'in', value: 'http://example.org/refset/random' }],
      }));
    } else if (kind === 'codeRegex') {
      const digit = randInt(rng, 1, codes.length);
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'code', op: 'regex', value: `^C-[1-${digit}]$` }],
      }));
    } else {
      selectors.push(IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'CLASS', op: '=', value: maybe(rng, 0.5) ? 'CHEM' : 'chemistry' }],
      }));
    }
  }

  let expr = selectors[0];
  for (const next of selectors.slice(1)) {
    const op = pick(rng, ['union', 'intersect', 'diff']);
    if (op === 'union') expr = IR.union([expr, next]);
    else if (op === 'intersect') expr = IR.intersect([expr, next]);
    else expr = IR.diff(expr, next);
  }
  return expr;
}

function selectText(seed, fixture) {
  const rng = mulberry32(seed ^ 0x85ebca6b);
  const options = ['alpha', 'beta', 'gamma', 'delta', 'chem', 'diag', ''];
  return pick(rng, options.filter(Boolean).concat(['']));
}

describe('sqlite-v0 logical-plan -> SQL parity fuzz', () => {
  const propertyDefs = makePropertyDefs();
  const runtime = makeRuntime();

  test('randomized runtime-schema SQL parity holds across generated fixtures', () => {
    const seeds = 75;
    for (let seed = 1; seed <= seeds; seed++) {
      const fixture = buildFixture(seed);
      const expr = buildExpr(seed, fixture);
      const scope = { csId: 1, system: 'urn:sys:A', version: null };
      const lowered = buildMembershipPlan(expr, { propertyDefs, runtime, scope });
      expect(lowered.ok).toBe(true);

      const text = selectText(seed, fixture);
      const activeOnly = (seed % 2) === 0;
      const selected = buildSelectionPlan(lowered.plan, {
        activeOnly,
        text,
      }, runtime);

      const db = buildRuntimeSqliteV0Db(fixture, { propertyDefs, runtime, csId: scope.csId });
      try {
        const expectedCodes = conceptIdsToCodes(interpretMembershipPlan(selected, fixture), fixture);
        const expectedCount = expectedCodes.length;
        const probeCode = fixture.concepts[(seed - 1) % fixture.concepts.length].code;
        const expectedProbe = interpretMembershipPlan(lowered.plan, fixture).has(fixture.concepts[(seed - 1) % fixture.concepts.length].concept_id);

        const expandPhysical = physicalizeTerminalPlan(buildMaterializePlan(selected, { scope }), { runtime });
        const expandSqlAst = lowerPhysicalPlanToSqlAst(expandPhysical, { propertyDefs, runtime, scope });
        const expandSql = emitSqlAst(expandSqlAst.ast, expandSqlAst.params);
        const expandRows = db.prepare(expandSql.text).all(expandSql.params);
        expect(expandRows.map(r => r.code)).toEqual(expectedCodes);

        const countPhysical = physicalizeTerminalPlan(buildCountPlan(selected, { scope }), { runtime });
        const countSqlAst = lowerPhysicalPlanToSqlAst(countPhysical, { propertyDefs, runtime, scope });
        const countSql = emitSqlAst(countSqlAst.ast, countSqlAst.params);
        const countRow = db.prepare(countSql.text).get(countSql.params);
        expect(countRow.cnt).toBe(expectedCount);

        const probePhysical = physicalizeTerminalPlan(buildProbePlan(lowered.plan, probeCode, { scope }), { runtime });
        const probeSqlAst = lowerPhysicalPlanToSqlAst(probePhysical, { propertyDefs, runtime, scope });
        const probeSql = emitSqlAst(probeSqlAst.ast, probeSqlAst.params);
        const probeRow = db.prepare(probeSql.text).get(probeSql.params);
        expect(!!probeRow).toBe(expectedProbe);
      } finally {
        db.close();
      }
    }
  });
});
