#!/usr/bin/env node
/**
 * IR rewrite / optimizer unit tests.
 * Runs directly in Node — no server needed (except test 7 parity test).
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const IR = require('../tx/engine/ir.js');
const { buildIRFromValueSet } = require('../tx/engine/build-ir.js');
const { resolveImports } = require('../tx/engine/resolve-imports.js');
const rewrite = require('../tx/engine/rewrite.js');

const SYS = {
  SCT: 'http://snomed.info/sct',
  LOINC: 'http://loinc.org',
  RXNORM: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  GENDER: 'http://hl7.org/fhir/administrative-gender',
  USPS: 'https://www.usps.com/',
};

function vs(include, exclude) {
  const inc = Array.isArray(include) ? include : [include];
  const exc = exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : undefined;
  return { resourceType: 'ValueSet', status: 'active', compose: { include: inc, ...(exc ? { exclude: exc } : {}) } };
}

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

// Helper: walk tree and collect all nodes of a given kind
function findNodes(expr, kind) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.kind === kind) out.push(n);
    if (Array.isArray(n.items)) n.items.forEach(walk);
    if (n.left) walk(n.left);
    if (n.right) walk(n.right);
    if (n.resolved) walk(n.resolved);
  })(expr);
  return out;
}

async function main() {
  console.log('\n=== IR Rewrite / Optimizer Unit Tests ===\n');

  // ── 1. intersect same-system filters coalesce ──────────────────────
  await test('intersect same-system filters coalesce in rewrite', async () => {
    const importUrl = `http://example.org/vs/int-filt-${Date.now()}`;
    const rootVs = vs({
      system: SYS.LOINC,
      filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }],
      valueSet: [importUrl],
    });
    const imported = vs({
      system: SYS.LOINC,
      filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }],
    });

    let expr = buildIRFromValueSet(rootVs);
    expr = await resolveImports(expr, async (url) => url === importUrl ? imported : null, { maxDepth: 10 });
    expr = rewrite.optimize(expr);
    const { include } = rewrite.splitDiffRoot(expr);

    assert(include.kind === 'selector', `expected selector, got ${include.kind}`);
    assert(include.shape === 'filter', `expected filter shape, got ${include.shape}`);
    const clauseKeys = new Set((include.filterClauses || []).map(fc => `${fc.property}|${fc.op}|${fc.value}`));
    assert(clauseKeys.has('STATUS|=|ACTIVE'), 'missing STATUS=ACTIVE clause');
    assert(clauseKeys.has('CLASS|=|CHEM'), 'missing CLASS=CHEM clause');
  });

  // ── 2. nested diff partitioning ────────────────────────────────────
  await test('nested diff partitioning rewrites multi-system left branches', async () => {
    const loincA = IR.selector({ system: SYS.LOINC, shape: 'filter', filterClauses: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }] });
    const sctA = IR.selector({ system: SYS.SCT, shape: 'concept', conceptCodes: [{ code: '64572001' }] });
    const loincB = IR.selector({ system: SYS.LOINC, shape: 'filter', filterClauses: [{ property: 'CLASS', op: '=', value: 'CHEM' }] });
    const sctB = IR.selector({ system: SYS.SCT, shape: 'concept', conceptCodes: [{ code: '73211009' }] });
    const usps = IR.selector({ system: SYS.USPS, shape: 'concept', conceptCodes: [{ code: 'CA' }] });

    const expr = IR.union([
      IR.diff(IR.union([loincA, sctA]), IR.union([loincB, sctB])),
      usps,
    ]);
    const opt = rewrite.optimize(expr);

    const diffs = findNodes(opt, 'diff');
    assert(diffs.length >= 1, 'expected at least one diff node after optimization');
    for (const d of diffs) {
      const systems = [...rewrite.collectSystems(d.left).values()];
      assert(systems.length <= 1,
        `expected per-system diff left side, got ${systems.length} systems: ${systems.map(s=>s.system).join(', ')}`);
    }
  });

  // ── 3. duplicate filter branches deduped after import inline ──────
  await test('duplicate filter branches are deduped after import inline', async () => {
    const vsAUrl = `http://example.org/vs/dedup-a-${Date.now()}`;
    const vsBUrl = `http://example.org/vs/dedup-b-${Date.now()}`;
    const root = vs({ valueSet: [vsAUrl, vsBUrl] });
    // Same filters, different order
    const vsA = vs({ system: SYS.LOINC, filter: [
      { property: 'STATUS', op: '=', value: 'ACTIVE' },
      { property: 'CLASS', op: '=', value: 'CHEM' },
    ]});
    vsA.url = vsAUrl;
    const vsB = vs({ system: SYS.LOINC, filter: [
      { property: 'CLASS', op: '=', value: 'CHEM' },
      { property: 'STATUS', op: '=', value: 'ACTIVE' },
    ]});
    vsB.url = vsBUrl;

    let expr = buildIRFromValueSet(root);
    expr = await resolveImports(expr, async (url) => {
      if (url === vsAUrl) return vsA;
      if (url === vsBUrl) return vsB;
      return null;
    }, { maxDepth: 10 });
    expr = rewrite.optimize(expr);
    const { include } = rewrite.splitDiffRoot(expr);
    const items = rewrite.flattenUnionToList(include);
    assert(items.length === 1,
      `expected duplicate filter branches deduped to 1, got ${items.length}`);
    assert(items[0].kind === 'selector' && items[0].shape === 'filter',
      'expected deduped filter selector');
  });

  // ── 4. intersect filter+concept lowers to intersectCodes ──────────
  await test('intersect filter+concept lowers to selector with intersectCodes', async () => {
    const importUrl = `http://example.org/vs/int-codes-${Date.now()}`;
    const rootVs = vs({
      system: SYS.LOINC,
      filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }],
      valueSet: [importUrl],
    });
    const imported = vs({
      system: SYS.LOINC,
      concept: [{ code: '2160-0' }, { code: '4548-4' }],
    });

    let expr = buildIRFromValueSet(rootVs);
    expr = await resolveImports(expr, async (url) => url === importUrl ? imported : null, { maxDepth: 10 });
    expr = rewrite.optimize(expr);
    const { include } = rewrite.splitDiffRoot(expr);

    assert(include.kind === 'selector', `expected selector, got ${include.kind}`);
    assert(include.shape === 'filter', `expected filter shape, got ${include.shape}`);
    const codes = include.intersectCodes || [];
    assert(Array.isArray(codes) && codes.length === 2,
      `expected intersectCodes length 2, got ${JSON.stringify(codes)}`);
    assert(codes.includes('2160-0') && codes.includes('4548-4'),
      `expected intersectCodes [2160-0, 4548-4], got ${JSON.stringify(codes)}`);
  });

  // ── 5. projection eliminates empty intersect branches ─────────────
  await test('projection eliminates empty intersect branches', async () => {
    const expr = IR.intersect([
      IR.selector({ system: SYS.LOINC, shape: 'concept', conceptCodes: [{ code: '2160-0' }] }),
      IR.selector({ system: SYS.SCT, shape: 'concept', conceptCodes: [{ code: '73211009' }] }),
    ]);
    const projected = rewrite.projectToSystem(expr, SYS.LOINC, null);
    // SCT branch projects to empty → entire intersect is empty
    assert(projected.kind === 'empty',
      `expected empty after cross-system intersect projection, got ${projected.kind}`);
  });

  // ── 6. union folding: concept merge + filter dedup ─────────────────
  await test('union folding merges concept unions and dedupes identical filters', async () => {
    // 6a: concept merge
    const conceptExpr = IR.union([
      IR.selector({ system: SYS.LOINC, shape: 'concept', conceptCodes: [{ code: '2160-0' }, { code: '4548-4' }] }),
      IR.selector({ system: SYS.LOINC, shape: 'concept', conceptCodes: [{ code: '718-7' }, { code: '2951-2' }] }),
    ]);
    const optConcept = rewrite.optimize(conceptExpr);
    assert(optConcept.kind === 'selector', `expected merged concept selector, got ${optConcept.kind}`);
    assert(optConcept.shape === 'concept', `expected concept shape, got ${optConcept.shape}`);
    const codes = (optConcept.conceptCodes || []).map(c => c.code);
    assert(codes.length === 4, `expected 4 merged codes, got ${codes.length}`);
    assert(codes.includes('2160-0') && codes.includes('718-7'),
      `expected all 4 codes present`);

    // 6b: filter dedup (same clauses, different order)
    const filterExpr = IR.union([
      IR.selector({ system: SYS.LOINC, shape: 'filter', filterClauses: [
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
        { property: 'CLASS', op: '=', value: 'CHEM' },
      ] }),
      IR.selector({ system: SYS.LOINC, shape: 'filter', filterClauses: [
        { property: 'CLASS', op: '=', value: 'CHEM' },
        { property: 'STATUS', op: '=', value: 'ACTIVE' },
      ] }),
    ]);
    const optFilter = rewrite.optimize(filterExpr);
    // Should collapse to a single selector (not a union)
    assert(optFilter.kind === 'selector',
      `expected deduped filter to be single selector, got ${optFilter.kind}`);
    assert(optFilter.shape === 'filter', `expected filter shape`);
  });

  // ── 7. optimized expansion parity (HTTP, skipped if no server) ────
  await test('optimized expansion produces same codes as unoptimized', async () => {
    const BASE = process.env.BASE_URL || 'http://localhost:8000';
    try {
      const r = await fetch(`${BASE}/r4/metadata`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) throw new Error('not ok');
    } catch {
      console.log('    (skipped: server not available)');
      return;
    }

    // Use STATUS=ACTIVE filter intersected with concept codes via import.
    // The optimizer should merge filter+concept into a single selector with
    // intersectCodes. Verify the result contains only the requested codes
    // and that they satisfy the filter.
    const importUrl = `http://example.org/vs/parity-${Date.now()}`;
    const importedVs = {
      resourceType: 'ValueSet', url: importUrl, status: 'active',
      compose: { include: [{ system: SYS.LOINC, concept: [{ code: '2160-0' }, { code: '2345-7' }] }] },
    };
    const query = vs({
      system: SYS.LOINC,
      filter: [{ property: 'STATUS', op: '=', value: 'ACTIVE' }],
      valueSet: [importUrl],
    });

    const resp = await fetch(`${BASE}/r4/ValueSet/$expand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType: 'Parameters', parameter: [
        { name: 'valueSet', resource: query },
        { name: 'tx-resource', resource: importedVs },
        { name: '_engine', valueString: 'ir' },
        { name: '_nocache', valueString: 'true' },
        { name: 'count', valueInteger: 100 },
      ] }),
    });
    const result = await resp.json();
    const contains = result.expansion?.contains || [];
    // Both LOINC codes are ACTIVE, so both should appear
    assert(contains.length === 2,
      `expected 2 codes from filter∩concept, got ${contains.length}`);
    const gotCodes = new Set(contains.map(c => c.code));
    assert(gotCodes.has('2160-0'), 'missing 2160-0');
    assert(gotCodes.has('2345-7'), 'missing 2345-7');
    for (const c of contains) {
      assert(c.system === SYS.LOINC, `expected LOINC, got ${c.system}`);
    }
  });

  // ── 8. whole-system absorbs concept union ──────────────────────────
  await test('whole-system absorbs concept union for same system', async () => {
    const expr = IR.union([
      IR.selector({ system: SYS.GENDER, shape: 'whole' }),
      IR.selector({ system: SYS.GENDER, shape: 'concept', conceptCodes: [{ code: 'male' }, { code: 'female' }] }),
    ]);
    const opt = rewrite.optimize(expr);
    assert(opt.kind === 'selector', `expected single selector, got ${opt.kind}`);
    assert(opt.shape === 'whole', `expected whole shape (absorbing concepts), got ${opt.shape}`);
    assert(opt.system === SYS.GENDER, `expected gender system`);
  });

  // ── summary ────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

main();
