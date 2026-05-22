'use strict';

const IR = require('../../tx/engine/ir');
const { createSqliteV0Compiler } = require('../../tx/cs/sqlite-v0-compiler');
const {
  buildTinyScopedModel,
  makeDefaultSqliteV0PropertyDefs,
  makeDefaultSqliteV0Runtime,
} = require('../support/terminology-model/model');
const { normalizeCodeList } = require('../support/terminology-model/normalize-results');
const { buildRuntimeSqliteV0Db } = require('../support/terminology-model/sqlite-db-builder');

function runCodes(db, compiled) {
  return normalizeCodeList(db.prepare(compiled.sql.text).all(compiled.sql.params).map(row => row.code));
}

describe('sqlite-v0 metamorphic invariants', () => {
  const model = buildTinyScopedModel({ activeMask: 3, classMask: 1, refsetMask: 1, hasEdge: true });
  const propertyDefs = makeDefaultSqliteV0PropertyDefs();
  const runtime = makeDefaultSqliteV0Runtime();
  const compiler = createSqliteV0Compiler({
    propertyDefs,
    runtime,
    scope: { system: model.system, version: model.version, csId: model.csId },
  });

  test('reordering commutative IR children preserves materialized results', () => {
    const db = buildRuntimeSqliteV0Db(model, { csId: model.csId, propertyDefs, runtime });
    try {
      const left = IR.union([
        IR.selector({ system: 'urn:sys:A', shape: 'concept', conceptCodes: [{ code: 'A' }] }),
        IR.selector({ system: 'urn:sys:A', shape: 'filter', filterClauses: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }),
      ]);
      const right = IR.union([...left.items].reverse());

      expect(runCodes(db, compiler.compileExpand(left, { count: 50 }))).toEqual(
        runCodes(db, compiler.compileExpand(right, { count: 50 }))
      );
    } finally {
      db.close();
    }
  });

  test('page concatenation equals full ordered expansion', () => {
    const db = buildRuntimeSqliteV0Db(model, { csId: model.csId, propertyDefs, runtime });
    try {
      const expr = IR.selector({ system: 'urn:sys:A', shape: 'whole' });
      const full = runCodes(db, compiler.compileExpand(expr, { count: 50 }));
      const pageA = runCodes(db, compiler.compileExpand(expr, { offset: 0, count: 1 }));
      const pageB = runCodes(db, compiler.compileExpand(expr, { offset: 1, count: 1 }));
      expect(normalizeCodeList([...pageA, ...pageB])).toEqual(full);
    } finally {
      db.close();
    }
  });

  test('membership probe agrees with materialized membership', () => {
    const db = buildRuntimeSqliteV0Db(model, { csId: model.csId, propertyDefs, runtime });
    try {
      const expr = IR.selector({
        system: 'urn:sys:A',
        shape: 'filter',
        filterClauses: [{ property: 'CLASS', op: '=', value: 'CHEM' }],
      });
      const materialized = new Set(runCodes(db, compiler.compileExpand(expr, { count: 50 })));
      const probeA = db.prepare(compiler.compileProbe(expr, 'A').sql.text).get(compiler.compileProbe(expr, 'A').sql.params);
      const probeB = db.prepare(compiler.compileProbe(expr, 'B').sql.text).get(compiler.compileProbe(expr, 'B').sql.params);
      expect(!!probeA).toBe(materialized.has('A'));
      expect(!!probeB).toBe(materialized.has('B'));
    } finally {
      db.close();
    }
  });
});
