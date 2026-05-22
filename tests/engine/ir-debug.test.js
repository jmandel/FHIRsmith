'use strict';

const IR = require('../../tx/engine/ir');
const { collectSystems } = require('../../tx/engine/rewrite');
const { renderCanonicalIRText, renderIRPlanText } = require('../../tx/engine/ir-debug');

describe('IR debug rendering', () => {
  test('canonical IR text is stable for semantically equivalent branch orderings', () => {
    const expr1 = IR.union([
      IR.selector({
        system: 'sys:B',
        shape: 'filter',
        filterClauses: [{ property: 'kind', op: '=', value: 'lab' }],
      }),
      IR.selector({
        system: 'sys:A',
        shape: 'concept',
        conceptCodes: [{ code: 'A-2' }, { code: 'A-1' }],
      }),
    ]);

    const expr2 = IR.union([
      IR.selector({
        system: 'sys:A',
        shape: 'concept',
        conceptCodes: [{ code: 'A-1' }, { code: 'A-2' }],
      }),
      IR.selector({
        system: 'sys:B',
        shape: 'filter',
        filterClauses: [{ property: 'kind', op: '=', value: 'lab' }],
      }),
    ]);

    const text1 = renderCanonicalIRText(expr1);
    const text2 = renderCanonicalIRText(expr2);

    expect(text1).toBe(text2);
    expect(text1).toMatchInlineSnapshot(`
"canonical-ir-hash: 57ebc6b3f086ab0f9a8fda57ba41dec794b65dbe
canonical-ir:
  union [2] [n]
    selector concept sys:A [2] A-1, A-2 [n.0]
    selector filter sys:B kind = lab [n.1]"
`);
  });

  test('plan text includes canonical tree, systems, and runtime constraints', () => {
    const expr = IR.diff(
      IR.union([
        IR.selector({
          system: 'sys:B',
          version: '2',
          shape: 'whole',
        }),
        IR.selector({
          system: 'sys:A',
          shape: 'filter',
          filterClauses: [{ property: 'concept', op: 'is-a', value: 'root' }],
        }),
      ]),
      IR.selector({
        system: 'sys:A',
        shape: 'concept',
        conceptCodes: [{ code: 'A-9' }],
      }),
    );

    const systems = collectSystems(expr);
    const text = renderIRPlanText(expr, systems, {
      text: 'alpha',
      activeOnly: true,
      offset: 10,
      count: 25,
    });

    expect(text).toMatchInlineSnapshot(`
"systems: sys:A, sys:B|2
canonical-ir-hash: 5a02834317a0ca1df667bc1fb85ecdb87793f6f8
runtime-constraints:
  text-filter: "alpha"
  active-only: true
  pagination: offset=10 count=25
optimized-ir:
  diff [n]
    union [2] [n.l]
      selector filter sys:A concept is-a root [n.l.0]
      selector whole sys:B|2 [n.l.1]
    selector concept sys:A [1] A-9 [n.r]"
`);
  });
});
