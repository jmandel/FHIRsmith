# Proposed Expansion Metadata Tests for expand-v2 Harness

## Gap Summary

The v2 harness thoroughly tests *membership* (which codes appear) and *display* (what text appears), but never inspects `expansion.parameter[]` — the metadata block that FHIR clients use to understand provenance, warnings, and pagination context. The v2 expander emits these parameters across many code paths, and none of them have integration tests.

### What's emitted but never asserted

| Parameter name | When emitted | Purpose |
|---|---|---|
| `used-codesystem` | Every include/exclude touching a code system | Tells clients which CS versions were used |
| `used-supplement` | When a CS has active supplements | Tracks supplement provenance |
| `used-valueset` | ValueSet-only imports | Tracks which imported VSes were used |
| `warning-deprecated` | CS/VS has `standardsStatus=deprecated` | Warns clients about deprecated content |
| `warning-withdrawn` | CS/VS has `standardsStatus=withdrawn` | Warns clients about withdrawn content |
| `warning-retired` | CS/VS has `status=retired` | Warns clients about retired content |
| `warning-experimental` | CS is experimental but source VS isn't | Warns about experimental content |
| `warning-draft` | CS/VS is draft but source VS isn't | Warns about draft content |
| `filter` | Text filter was applied | Echo of input parameter |
| `offset` / `count` | Pagination requested | Echo of input parameters |
| `displayLanguage` | Language preference set | Echo of input parameter |
| `excludeNested` / `activeOnly` / etc. | Boolean params set | Echo of input parameters |

### Other untested metadata behavior

- **Supplement validation**: Required supplements declared via `valueset-supplement` extension must all be found, or expansion fails with `VALUESET_SUPPLEMENT_MISSING` (422)
- **Content mode checking**: `not-present` and `supplement` content modes cause hard failures
- **Fragment mode**: `fragment` content mode adds `valueset-unclosed` extension
- **Deduplication**: `_addParam` skips duplicates — same param name+value shouldn't appear twice

---

## Proposed Test Ideas

### Category A: `used-codesystem` tracking

These verify that expansion correctly records which code system(s) were consulted.

#### A1. Single code system records `used-codesystem`

The simplest case. Expanding a VS that includes concepts from one system should produce exactly one `used-codesystem` parameter with the system's canonical URL (and version if known).

```js
test('meta: single system expansion emits used-codesystem parameter', async () => {
  const { result } = await expand(vs({
    system: SYS.GENDER,
    concept: [{ code: 'male' }],
  }));
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];
  const usedCs = params.filter(p => p.name === 'used-codesystem');
  assert(usedCs.length >= 1, 'expected at least one used-codesystem parameter');
  assert(usedCs.some(p => p.valueUri?.includes('administrative-gender')),
    'used-codesystem should reference administrative-gender');
});
```

**Catches:** Wiring failure where `_recordUsedCodeSystem` or `_addParam` is never called for the include path.

#### A2. Multi-system expansion records each system

When a VS includes from two different code systems, both should appear.

```js
test('meta: multi-system expansion emits used-codesystem for each system', async () => {
  const { result } = await expand(vs([
    { system: SYS.GENDER, concept: [{ code: 'male' }] },
    { system: SYS.PUBSTAT, concept: [{ code: 'active' }] },
  ]));
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];
  const usedCs = params.filter(p => p.name === 'used-codesystem');
  assert(usedCs.some(p => p.valueUri?.includes('administrative-gender')),
    'should record gender system');
  assert(usedCs.some(p => p.valueUri?.includes('publication-status')),
    'should record pubstat system');
});
```

**Catches:** Only the first system being recorded, or the parameter being overwritten instead of appended.

#### A3. Filter-based expansion records `used-codesystem`

The filter iteration path (`_processFilters`) has its own `_recordUsedCodeSystem` call site. Verify it fires.

```js
test('meta: SNOMED filter expansion emits used-codesystem', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }), { count: 5 });
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];
  const usedCs = params.filter(p => p.name === 'used-codesystem');
  assert(usedCs.some(p => p.valueUri?.startsWith('http://snomed.info/sct')),
    'filter expansion should record SNOMED as used-codesystem');
});
```

#### A4. No duplicate `used-codesystem` entries

`_addParam` deduplicates. When multiple concepts reference the same system, the parameter should appear only once.

```js
test('meta: used-codesystem is not duplicated for same system', async () => {
  const { result } = await expand(vs({
    system: SYS.GENDER,
    concept: [{ code: 'male' }, { code: 'female' }, { code: 'other' }],
  }));
  const params = result.expansion.parameter || [];
  const usedCs = params.filter(p =>
    p.name === 'used-codesystem' && p.valueUri?.includes('administrative-gender'));
  assert(usedCs.length === 1,
    `expected exactly 1 used-codesystem for gender, got ${usedCs.length}`);
});
```

**Catches:** Deduplication in `_addParam` being broken — each code would add a duplicate parameter.

---

### Category B: `used-valueset` tracking

#### B1. ValueSet import records `used-valueset`

When a VS compose includes another VS, the imported VS's canonical should appear as `used-valueset`.

```js
test('meta: ValueSet import emits used-valueset parameter', async () => {
  const csUrl = `http://example.org/cs/meta-b1-${Date.now()}`;
  const vsUrl = `http://example.org/vs/meta-b1-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem', url: csUrl, status: 'active', content: 'complete',
    concept: [{ code: 'a', display: 'A' }, { code: 'b', display: 'B' }],
  };
  const importedVs = {
    resourceType: 'ValueSet', url: vsUrl, status: 'active',
    compose: { include: [{ system: csUrl, concept: [{ code: 'a' }] }] },
  };

  const { result } = await expand(
    vs({ valueSet: [vsUrl] }),
    { txResources: [cs, importedVs] },
  );
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];
  const usedVs = params.filter(p => p.name === 'used-valueset');
  assert(usedVs.length >= 1, 'expected used-valueset parameter');
  assert(usedVs.some(p => p.valueUri?.includes(vsUrl)),
    `used-valueset should reference ${vsUrl}`);
});
```

---

### Category C: Canonical status warnings

These test `_checkCanonicalStatus`, which inspects the `status` and `standardsStatus` of referenced code systems and value sets, and emits appropriate warning parameters.

#### C1. Draft code system produces `warning-draft`

When the source VS is `active` but includes a code system with `status: 'draft'`, the expansion should carry `warning-draft`.

```js
test('meta: draft code system emits warning-draft parameter', async () => {
  const csUrl = `http://example.org/cs/draft-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem', url: csUrl, status: 'draft', content: 'complete',
    concept: [{ code: 'x', display: 'X' }],
  };
  const vsJson = {
    resourceType: 'ValueSet',
    url: `http://test.fhirsmith.org/vs/draft-test-${Date.now()}`,
    status: 'active',
    compose: { include: [{ system: csUrl, concept: [{ code: 'x' }] }] },
  };

  const { result } = await expand(vsJson, { txResources: [cs] });
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];
  const warnings = params.filter(p => p.name === 'warning-draft');
  assert(warnings.length >= 1,
    'expected warning-draft parameter for draft code system');
});
```

#### C2. Retired code system produces `warning-retired`

```js
test('meta: retired code system emits warning-retired parameter', async () => {
  const csUrl = `http://example.org/cs/retired-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem', url: csUrl, status: 'retired', content: 'complete',
    concept: [{ code: 'y', display: 'Y' }],
  };
  const vsJson = {
    resourceType: 'ValueSet',
    url: `http://test.fhirsmith.org/vs/retired-test-${Date.now()}`,
    status: 'active',
    compose: { include: [{ system: csUrl, concept: [{ code: 'y' }] }] },
  };

  const { result } = await expand(vsJson, { txResources: [cs] });
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];
  const warnings = params.filter(p => p.name === 'warning-retired');
  assert(warnings.length >= 1,
    'expected warning-retired parameter for retired code system');
});
```

#### C3. Draft VS referencing draft CS suppresses `warning-draft`

The warning is suppressed when the source VS itself is draft — there's no point warning about draft content if the VS is already draft.

```js
test('meta: draft CS referenced by draft VS does NOT emit warning-draft', async () => {
  const csUrl = `http://example.org/cs/draft-suppress-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem', url: csUrl, status: 'draft', content: 'complete',
    concept: [{ code: 'z', display: 'Z' }],
  };
  const vsJson = {
    resourceType: 'ValueSet',
    url: `http://test.fhirsmith.org/vs/draft-suppress-${Date.now()}`,
    status: 'draft',  // <-- source is also draft
    compose: { include: [{ system: csUrl, concept: [{ code: 'z' }] }] },
  };

  const { result } = await expand(vsJson, { txResources: [cs] });
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];
  const warnings = params.filter(p => p.name === 'warning-draft');
  assert(warnings.length === 0,
    'warning-draft should be suppressed when source VS is also draft');
});
```

**Catches:** The conditional `!(source.status === 'draft' || ...)` in `_checkCanonicalStatus` being wrong.

#### C4. Experimental code system produces `warning-experimental`

```js
test('meta: experimental code system emits warning-experimental parameter', async () => {
  const csUrl = `http://example.org/cs/experimental-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem', url: csUrl, status: 'active',
    experimental: true, content: 'complete',
    concept: [{ code: 'e', display: 'E' }],
  };
  const vsJson = {
    resourceType: 'ValueSet',
    url: `http://test.fhirsmith.org/vs/experimental-test-${Date.now()}`,
    status: 'active',
    experimental: false,
    compose: { include: [{ system: csUrl, concept: [{ code: 'e' }] }] },
  };

  const { result } = await expand(vsJson, { txResources: [cs] });
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];
  const warnings = params.filter(p => p.name === 'warning-experimental');
  assert(warnings.length >= 1,
    'expected warning-experimental for experimental CS used by non-experimental VS');
});
```

#### C5. Imported ValueSet status also checked

When a VS imports another VS that is draft/retired, the imported VS should trigger a warning too.

```js
test('meta: importing a draft ValueSet emits warning-draft', async () => {
  const csUrl = `http://example.org/cs/meta-c5-${Date.now()}`;
  const vsUrl = `http://example.org/vs/meta-c5-draft-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem', url: csUrl, status: 'active', content: 'complete',
    concept: [{ code: 'q', display: 'Q' }],
  };
  const importedVs = {
    resourceType: 'ValueSet', url: vsUrl, status: 'draft',
    compose: { include: [{ system: csUrl, concept: [{ code: 'q' }] }] },
  };
  const vsJson = {
    resourceType: 'ValueSet',
    url: `http://test.fhirsmith.org/vs/meta-c5-${Date.now()}`,
    status: 'active',
    compose: { include: [{ valueSet: [vsUrl] }] },
  };

  const { result } = await expand(vsJson, { txResources: [cs, importedVs] });
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];
  const warnings = params.filter(p => p.name === 'warning-draft');
  assert(warnings.length >= 1,
    'importing a draft VS should produce warning-draft');
});
```

---

### Category D: Parameter echo-back

The expansion should echo the parameters that were used to produce it, so consumers can verify what options were in effect.

#### D1. Pagination parameters are echoed

```js
test('meta: offset and count are echoed in expansion parameters', async () => {
  const { result } = await expand(vs({ system: SYS.USPS }), { count: 5, offset: 2 });
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];

  const offsetP = params.find(p => p.name === 'offset');
  const countP = params.find(p => p.name === 'count');
  assert(offsetP?.valueInteger === 2, `expected offset=2, got ${offsetP?.valueInteger}`);
  assert(countP?.valueInteger === 5, `expected count=5, got ${countP?.valueInteger}`);
  assert(result.expansion.offset === 2, 'expansion.offset should be set');
});
```

#### D2. Text filter is echoed

```js
test('meta: text filter is echoed in expansion parameters', async () => {
  const { result } = await expand(vs({
    system: SYS.SCT,
    filter: [{ property: 'concept', op: 'is-a', value: '73211009' }],
  }), { filter: 'mell', count: 5 });
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];
  const filterP = params.find(p => p.name === 'filter');
  assert(filterP?.valueString === 'mell', `expected filter='mell', got '${filterP?.valueString}'`);
});
```

#### D3. Boolean parameters are echoed when explicitly set

```js
test('meta: boolean params (activeOnly, excludeNested, includeDesignations) are echoed', async () => {
  const { result } = await expand(vs({
    system: SYS.GENDER,
  }), {
    params: [
      { name: 'activeOnly', valueBoolean: true },
      { name: 'excludeNested', valueBoolean: true },
      { name: 'includeDesignations', valueBoolean: true },
    ],
  });
  assertExpansionStructure(result);
  const params = result.expansion.parameter || [];

  const findBool = (name) => params.find(p => p.name === name);
  assert(findBool('activeOnly')?.valueBoolean === true, 'activeOnly should be echoed');
  assert(findBool('excludeNested')?.valueBoolean === true, 'excludeNested should be echoed');
  assert(findBool('includeDesignations')?.valueBoolean === true, 'includeDesignations should be echoed');
});
```

---

### Category E: Supplement validation

#### E1. Missing required supplement fails with 422

When a ValueSet declares a required supplement via the `valueset-supplement` extension, and that supplement isn't found, expansion must fail.

```js
test('meta: missing required supplement fails with VALUESET_SUPPLEMENT_MISSING', async () => {
  const csUrl = `http://example.org/cs/supp-test-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem', url: csUrl, status: 'active', content: 'complete',
    concept: [{ code: 's', display: 'S' }],
  };
  const vsJson = {
    resourceType: 'ValueSet',
    url: `http://test.fhirsmith.org/vs/supp-test-${Date.now()}`,
    status: 'active',
    extension: [{
      url: 'http://hl7.org/fhir/StructureDefinition/valueset-supplement',
      valueCanonical: 'http://example.org/cs/nonexistent-supplement',
    }],
    compose: { include: [{ system: csUrl, concept: [{ code: 's' }] }] },
  };

  let failed = false;
  try {
    await expand(vsJson, { txResources: [cs] });
  } catch (e) {
    failed = true;
    const msg = String(e?.message || e?.msgId || '');
    assert(msg.includes('SUPPLEMENT') || msg.includes('supplement'),
      `expected supplement-missing error, got: ${msg}`);
  }
  assert(failed, 'expansion should fail when required supplement is missing');
});
```

**Catches:** The `requiredSupplements` / `usedSupplements` tracking being broken, or the final check at line 706-710 not firing.

---

### Category F: Content mode errors

#### F1. `not-present` content mode is rejected

```js
test('meta: code system with content=not-present is rejected', async () => {
  const csUrl = `http://example.org/cs/not-present-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem', url: csUrl, status: 'active',
    content: 'not-present',
    concept: [],
  };
  const vsJson = {
    resourceType: 'ValueSet',
    url: `http://test.fhirsmith.org/vs/not-present-${Date.now()}`,
    status: 'active',
    compose: { include: [{ system: csUrl }] },
  };

  let failed = false;
  try {
    await expand(vsJson, { txResources: [cs] });
  } catch (e) {
    failed = true;
    const msg = String(e?.message || '');
    assert(msg.includes('no content') || msg.includes('not-present'),
      `expected not-present error, got: ${msg}`);
  }
  assert(failed, 'expansion should fail for content=not-present');
});
```

#### F2. `fragment` content mode adds `valueset-unclosed`

```js
test('meta: fragment content mode produces valueset-unclosed extension', async () => {
  const csUrl = `http://example.org/cs/fragment-${Date.now()}`;
  const cs = {
    resourceType: 'CodeSystem', url: csUrl, status: 'active',
    content: 'fragment',
    concept: [{ code: 'f1', display: 'Fragment 1' }],
  };
  const vsJson = {
    resourceType: 'ValueSet',
    url: `http://test.fhirsmith.org/vs/fragment-${Date.now()}`,
    status: 'active',
    compose: { include: [{ system: csUrl, concept: [{ code: 'f1' }] }] },
  };

  const { result } = await expand(vsJson, { txResources: [cs] });
  assertExpansionStructure(result);
  // Fragment CS should produce valueset-unclosed on the expansion
  const unclosed = (result.expansion.extension || [])
    .find(e => e.url === 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
  // Also, the expansion.parameter should indicate the fragment content mode
  const params = result.expansion.parameter || [];
  const fragmentParam = params.find(p => p.name === 'fragment');
  assert(unclosed || fragmentParam,
    'fragment content mode should produce valueset-unclosed or fragment parameter');
});
```

---

### Category G: Cross-cutting — harness infrastructure

Rather than only testing specific parameters one at a time, it may be worth adding a **structural assertion helper** that many tests can use.

#### G1. Helper: `assertExpansionParams`

A reusable helper that validates the basic shape of expansion parameters. Could be used by existing tests as a lightweight additional check.

```js
/**
 * Assert expansion.parameter entries are well-formed.
 * Each entry must have a `name` (string) and exactly one value[x] property.
 */
function assertExpansionParams(result) {
  const params = result?.expansion?.parameter || [];
  for (const p of params) {
    assert(typeof p.name === 'string' && p.name.length > 0,
      `parameter missing name: ${JSON.stringify(p)}`);
    const valueKeys = Object.keys(p).filter(k => k.startsWith('value'));
    assert(valueKeys.length === 1,
      `parameter '${p.name}' should have exactly 1 value[x], got ${valueKeys.length}: ${valueKeys.join(', ')}`);
  }
}
```

#### G2. Helper: `findParam` / `findParams`

Convenient lookup to reduce boilerplate in parameter assertions.

```js
function findParam(result, name, value) {
  return (result?.expansion?.parameter || []).find(p =>
    p.name === name && (value === undefined || Object.values(p).includes(value)));
}

function findParams(result, name) {
  return (result?.expansion?.parameter || []).filter(p => p.name === name);
}
```

---

## Priority

| Priority | Category | Tests | Rationale |
|----------|----------|-------|-----------|
| **P0** | A (used-codesystem) | A1, A2, A4 | Most fundamental metadata — emitted on every expansion, never checked |
| **P0** | C (warnings) | C1, C2, C3 | Client-facing safety warnings. A regression means silent use of retired/draft content |
| **P0** | D (echo) | D1, D2 | Pagination and filter echo are required for correct FHIR paging |
| **P1** | B (used-valueset) | B1 | Important for import provenance but narrower scope |
| **P1** | C (warnings) | C4, C5 | Experimental and imported-VS warnings — less common but still important |
| **P1** | D (echo) | D3 | Boolean param echo — less critical but good completeness |
| **P1** | E (supplements) | E1 | Error path testing. Supplements are rare but the failure mode is important |
| **P2** | F (content mode) | F1, F2 | Error/edge paths for unusual content modes |
| **P2** | G (helpers) | G1, G2 | Infrastructure improvements that make parameter assertions easy to add everywhere |

The G-category helpers are arguably P0 from a leverage standpoint — once they exist, it's trivial to add `assertExpansionParams(result)` to every existing test, which would catch structural regressions across the board.
