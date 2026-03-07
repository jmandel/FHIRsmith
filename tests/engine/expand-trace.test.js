'use strict';

const { ExpandTrace } = require('../../tx/engine/expand-trace');

describe('ExpandTrace', () => {
  test('stores full SQL text in structured trace payload', () => {
    const trace = new ExpandTrace();
    const sql = `SELECT ${'x'.repeat(1200)} FROM concept WHERE code = @code`;
    const span = trace.begin('sql-test');

    trace.sql(sql, { code: '123' }, 1, 12.34, 'test');
    span.end();
    const json = trace.toJSON();

    expect(json.sqlCount).toBe(1);
    expect(json.spans[0].sql[0].sql).toBe(sql);
    expect(json.spans[0].sql[0].sql.length).toBe(sql.length);
  });
});
