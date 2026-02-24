'use strict';

async function collectSpecialEnumerationCodes(worker, vsRef, expectedSystem) {
  if (!worker || typeof worker.findValueSet !== 'function') return [];
  const vs = await worker.findValueSet(String(vsRef), null);
  if (!vs) return [];
  const vsJson = vs?.jsonObj || vs;
  const out = [];
  const seen = new Set();
  const expected = String(expectedSystem || '');

  const addCode = (code) => {
    const c = String(code || '');
    if (!c || seen.has(c)) return;
    seen.add(c);
    out.push(c);
  };

  const walkContains = (list) => {
    for (const c of list || []) {
      if (String(c?.system || '') === expected) {
        addCode(c.code);
      }
      if (Array.isArray(c?.contains) && c.contains.length > 0) walkContains(c.contains);
    }
  };

  if (Array.isArray(vsJson?.expansion?.contains) && vsJson.expansion.contains.length > 0) {
    walkContains(vsJson.expansion.contains);
  } else {
    for (const inc of vsJson?.compose?.include || []) {
      if (String(inc?.system || '') !== expected) continue;
      for (const concept of inc.concept || []) {
        addCode(concept?.code);
      }
    }
  }
  return out;
}

module.exports = {
  collectSpecialEnumerationCodes,
};

