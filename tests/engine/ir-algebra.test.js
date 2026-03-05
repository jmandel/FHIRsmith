'use strict';

const IR = require('../../tx/engine/ir');

describe('IR algebra constructors', () => {
  test('intersect absorbs empty', () => {
    const s = IR.selector({ system: 'urn:sys:A', shape: 'whole' });
    const out = IR.intersect([IR.empty(), s]);
    expect(out.kind).toBe('empty');
  });

  test('nested intersect containing empty collapses to empty', () => {
    const s1 = IR.selector({ system: 'urn:sys:A', shape: 'whole' });
    const s2 = IR.selector({ system: 'urn:sys:B', shape: 'whole' });
    const out = IR.intersect([IR.intersect([s1, IR.empty()]), s2]);
    expect(out.kind).toBe('empty');
  });
});
