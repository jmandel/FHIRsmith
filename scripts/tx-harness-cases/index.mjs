import { registerExpandCases } from './expand.mjs';
import { TX_LOOKUP_CASES } from './lookup.mjs';
import { TX_VALIDATE_CASES } from './validate.mjs';

export const TX_HARNESS_CASES = [
  ...TX_LOOKUP_CASES,
  ...TX_VALIDATE_CASES,
];

export async function registerHarnessCases({ test, helpers, setCategory, runTxOperationCase, shouldRunOperationCase, skipCase }) {
  await registerExpandCases({ test, helpers, setCategory });
  for (const caseDef of TX_HARNESS_CASES) {
    if (!shouldRunOperationCase(caseDef)) {
      skipCase();
      continue;
    }
    await test({
      rawName: `${caseDef.kind}: ${caseDef.name}`,
      name: caseDef.name,
      category: caseDef.category,
      kind: caseDef.kind,
    }, async () => {
      await runTxOperationCase(caseDef);
    });
  }
}
