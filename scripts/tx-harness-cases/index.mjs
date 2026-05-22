import { collectExpandCaseDefs, registerExpandCases } from './expand.mjs';
import { TX_LOOKUP_CASES } from './lookup.mjs';
import { TX_VALIDATE_CASES } from './validate.mjs';

export const TX_EXPAND_CASES = await collectExpandCaseDefs();
export const TX_OPERATION_CASES = [
  ...TX_LOOKUP_CASES,
  ...TX_VALIDATE_CASES,
];

export const TX_HARNESS_CASES = [
  ...TX_EXPAND_CASES,
  ...TX_OPERATION_CASES,
];

export async function registerHarnessCases({ test, helpers, setCategory, runTxOperationCase, shouldRunOperationCase, skipCase }) {
  await registerExpandCases({ test, helpers, setCategory });
  for (const caseDef of TX_OPERATION_CASES) {
    if (!shouldRunOperationCase(caseDef)) {
      skipCase();
      continue;
    }
    await test({
      id: caseDef.id,
      rawName: `${caseDef.kind}: ${caseDef.name}`,
      name: caseDef.name,
      category: caseDef.category,
      kind: caseDef.kind,
      review: caseDef.review || null,
    }, async () => {
      await runTxOperationCase(caseDef);
    });
  }
}
