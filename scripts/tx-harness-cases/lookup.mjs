import { params, getParam, propertyParts, bundleLink, assert, SYS } from './common.mjs';

const LOOKUP_BASE_ID = 202;

const HIGH_CONFIDENCE_LOOKUP_IR_PREFERRED = new Set([
  218, 222, 211, 240, 238, 241, 237, 242, 236, 209, 239,
]);

const HIGH_CONFIDENCE_LOOKUP_NO_DIFF = new Set([
  216, 227, 219,
]);

const BATCH_LOOKUP_NO_DIFF_IDS = new Set([
  203, 204, 205, 213, 212, 228, 206, 231, 208, 232, 235, 230, 210,
]);

function withLookupId(caseDef, index) {
  return {
    ...caseDef,
    id: caseDef.id ?? (LOOKUP_BASE_ID + index),
  };
}

function withHighConfidenceLookupReview(caseDef) {
  if (caseDef.review) {
    return caseDef;
  }
  if (BATCH_LOOKUP_NO_DIFF_IDS.has(caseDef.id)) {
    return {
      ...caseDef,
      review: {
        status: 'reviewed',
        reviewedAt: '2026-03-11',
        note: 'Batch review: no meaningful semantic difference; remaining divergence was timeout/abort noise or other non-semantic variation.',
      },
    };
  }
  if (HIGH_CONFIDENCE_LOOKUP_IR_PREFERRED.has(caseDef.id)) {
    return {
      ...caseDef,
      review: {
        status: 'reviewed',
        reviewedAt: '2026-03-11',
        note: 'High-confidence batch review: IR behavior preferred in the fresh lookup/validate adjudication.',
      },
    };
  }
  if (HIGH_CONFIDENCE_LOOKUP_NO_DIFF.has(caseDef.id)) {
    return {
      ...caseDef,
      review: {
        status: 'reviewed',
        reviewedAt: '2026-03-11',
        note: 'High-confidence batch review: no meaningful semantic difference; remaining divergence was timeout/abort noise or other non-semantic variation.',
      },
    };
  }
  return caseDef;
}

function clearReviewForIrOnly(caseDef) {
  if (Array.isArray(caseDef.engines) && caseDef.engines.length === 1 && caseDef.engines[0] === 'ir' && caseDef.review) {
    const { review, ...rest } = caseDef;
    return rest;
  }
  return caseDef;
}

export const TX_LOOKUP_CASES = [
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET system+code administrative gender male',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST coding administrative gender female',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://hl7.org/fhir/administrative-gender',
            code: 'female',
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Female', 'expected normalized display Female');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST coding lookup honors explicit version on the coding',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://hl7.org/fhir/administrative-gender',
            version: '4.0.1',
            code: 'male',
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'version')?.valueString === '4.0.1', 'expected version 4.0.1');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST coding lookup unknown version returns not-found',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://hl7.org/fhir/administrative-gender',
            version: '0.0.0',
            code: 'male',
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 422, `expected 422, got ${res.status}`);
      const text = String(res.body?.issue?.[0]?.details?.text || '');
      assert(text.length > 0, 'expected non-empty unknown-version message');
      assert(!text.includes('undefined'), 'expected unknown-version message to name the system');
      assert(text.includes('http://hl7.org/fhir/administrative-gender'), 'expected system url in unknown-version message');
      assert(text.includes('0.0.0'), 'expected requested version in unknown-version message');
      assert(text.includes('4.0.1') || text.includes('Valid versions'), 'expected valid versions guidance in unknown-version message');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup accepts lenient string parameter types',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueString: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueString: 'unknown' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Unknown', 'expected normalized display Unknown');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup inline CodeSystem resource returns typed properties via IR',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; inline CodeSystem $lookup extension returns typed properties while legacy/upstream reject the non-standard request shape.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://example.org/cs-inline-lookup' },
        { name: 'code', valueCode: 'A' },
        { name: 'property', valueCode: '*' },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-lookup',
            version: '1.0.0',
            status: 'active',
            content: 'complete',
            property: [
              { code: 'rank', type: 'integer' },
              { code: 'kind', type: 'code' },
            ],
            concept: [
              {
                code: 'A',
                display: 'Alpha',
                property: [
                  { code: 'rank', valueInteger: 7 },
                  { code: 'kind', valueCode: 'primary' },
                ],
              },
              { code: 'B', display: 'Beta' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'name')?.valueString === 'http://example.org/cs-inline-lookup', 'expected non-empty name fallback');
        assert(getParam(res.body, 'display')?.valueString === 'Alpha', 'expected inline CodeSystem display Alpha');
        assert(getParam(res.body, 'version')?.valueString === '1.0.0', 'expected inline CodeSystem version 1.0.0');
        const rankProps = propertyParts(res.body?.parameter || [], 'rank');
        assert(rankProps.some((parts) =>
          parts.some((part) => part.name === 'value' && part.valueInteger === 7)
        ), 'expected rank integer property');
        const kindProps = propertyParts(res.body?.parameter || [], 'kind');
        assert(kindProps.some((parts) =>
          parts.some((part) => part.name === 'value' && part.valueCode === 'primary')
        ), 'expected kind code property');
      },
      legacy: (res) => {
        assert(res.status === 400, `expected 400, got ${res.status}`);
      },
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup inline CodeSystem resource rejects coding without system',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            code: 'A',
          },
        },
        { name: 'property', valueCode: '*' },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-lookup-coding',
            version: '1.0.0',
            status: 'active',
            content: 'complete',
            property: [
              { code: 'rank', type: 'integer' },
              { code: 'kind', type: 'code' },
            ],
            concept: [
              {
                code: 'A',
                display: 'Alpha Coding',
                property: [
                  { code: 'rank', valueInteger: 9 },
                  { code: 'kind', valueCode: 'coding' },
                ],
              },
              { code: 'B', display: 'Beta' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 400, `expected 400, got ${res.status}`);
        assert(String(res.body?.issue?.[0]?.details?.text || '').includes('Coding parameter must include a system'),
          'expected missing-system lookup error');
      },
      legacy: (res) => {
        assert(res.status === 400, `expected 400, got ${res.status}`);
      },
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup inline CodeSystem resource honors inline supplement designation language choice via IR',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://example.org/cs-inline-lookup-supp-base' },
        { name: 'code', valueCode: 'A' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'property', valueCode: 'designation' },
        { name: 'useSupplement', valueString: 'http://example.org/cs-inline-lookup-supp-de' },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-lookup-supp-base',
            version: '1.0.0',
            status: 'active',
            content: 'complete',
            concept: [
              { code: 'A', display: 'Alpha Base' },
              { code: 'B', display: 'Beta Base' },
            ],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-lookup-supp-de',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://example.org/cs-inline-lookup-supp-base',
            concept: [
              {
                code: 'A',
                designation: [
                  {
                    language: 'de',
                    use: {
                      system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                      code: 'preferredForLanguage',
                    },
                    value: 'Alpha Deutsch',
                  },
                ],
              },
            ],
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Alpha Deutsch', 'expected supplement-selected display');
      const designations = (res.body?.parameter || []).filter((p) => p.name === 'designation');
      const hasGermanDesignation = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && pp.valueString === 'Alpha Deutsch')
      );
      assert(hasGermanDesignation, 'expected inline supplement designation');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST system+code administrative gender other',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'other' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Other', 'expected normalized display Other');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'Instance lookup by administrative-gender id',
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/administrative-gender/$lookup',
      query: { code: 'other' },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Other', 'expected normalized display Other');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST instance lookup by administrative-gender id',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/administrative-gender/$lookup',
      body: params([
        { name: 'code', valueCode: 'female' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Female', 'expected normalized display Female');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST instance lookup accepts explicit property request',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/administrative-gender/$lookup',
      body: params([
        { name: 'code', valueCode: 'male' },
        { name: 'property', valueCode: 'inactive' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const inactiveProps = propertyParts(res.body?.parameter || [], 'inactive');
      assert(inactiveProps.length > 0, 'expected inactive property');
      assert(!getParam(res.body, 'definition'), 'did not expect definition when only inactive requested');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET instance lookup missing code returns invalid request',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/administrative-gender/$lookup',
    },
    assertLocal: (res) => {
      assert(res.status === 400, `expected 400, got ${res.status}`);
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup unknown CodeSystem instance id returns not-found',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/nonexistent-id/$lookup',
      query: { code: 'test' },
    },
    assertLocal: (res) => {
      assert(res.status === 404, `expected 404, got ${res.status}`);
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup missing system returns invalid request',
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: { code: 'male' },
    },
    assertLocal: (res) => {
      assert(res.status === 400, `expected 400, got ${res.status}`);
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup missing code returns invalid request',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: { system: 'http://hl7.org/fhir/administrative-gender' },
    },
    assertLocal: (res) => {
      assert(res.status === 400, `expected 400, got ${res.status}`);
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup unknown system returns not-supported',
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://nonexistent.org/codesystem',
        code: 'test',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 422, `expected 422, got ${res.status}`);
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup unknown code returns not-found',
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'nonexistent-code',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 404, `expected 404, got ${res.status}`);
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup includes version when available',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'female',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const version = getParam(res.body, 'version')?.valueString;
      if (version != null) {
        assert(String(version).length > 0, 'expected non-empty version when present');
      }
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup explicit version returns matching version',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        version: '4.0.1',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'version')?.valueString === '4.0.1', 'expected version 4.0.1');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup unknown version returns not-found',
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        version: '0.0.0',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 422, `expected 422, got ${res.status}`);
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup property filter returns requested property only',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
        property: 'inactive',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const props = (res.body?.parameter || []).filter((p) => p.name === 'property');
      assert(props.length >= 1, 'expected at least one property');
      const hasInactive = props.some((p) => (p.part || []).some((pp) => pp.name === 'code' && pp.valueCode === 'inactive'));
      assert(hasInactive, 'expected inactive property');
      const hasDefinition = !!getParam(res.body, 'definition');
      assert(!hasDefinition, 'did not expect definition when only inactive requested');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup without property parameter returns default description fields',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'name')?.valueString, 'expected name parameter');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
      assert(getParam(res.body, 'definition')?.valueString, 'expected definition parameter');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup without property parameter includes inactive property by default',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const props = (res.body?.parameter || []).filter((p) => p.name === 'property');
      const hasInactive = props.some((p) => (p.part || []).some((pp) => pp.name === 'code' && pp.valueCode === 'inactive'));
      assert(hasInactive, 'expected inactive property by default');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup designation property on SNOMED returns designation parts',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://snomed.info/sct',
        code: '73211009',
        property: 'designation',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const designations = (res.body?.parameter || []).filter((p) => p.name === 'designation');
      assert(designations.length > 0, 'expected designation parameters');
      const hasValue = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && typeof pp.valueString === 'string' && pp.valueString.length > 0)
      );
      assert(hasValue, 'expected at least one designation value');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup SNOMED concept-valued parent property returns valueCode parts',
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: SYS.SCT,
        code: '73211009',
        property: 'parent',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const props = propertyParts(res.body?.parameter || [], 'parent');
      assert(props.length > 0, 'expected parent property parts');
      const parentCodes = [...new Set(props
        .map((parts) => parts.find((part) => part.name === 'value')?.valueCode)
        .filter((code) => typeof code === 'string' && code.length > 0))];
      assert(parentCodes.includes('126877002'), 'expected parent 126877002');
      assert(parentCodes.includes('362969004'), 'expected parent 362969004');
      assert(props.some((parts) => parts.some((part) => part.name === 'value' && typeof part.valueCode === 'string' && part.valueCode.length > 0)), 'expected parent valueCode');
      assert(props.every((parts) => parts.every((part) => !(part.name === 'value' && part.valueCoding))), 'expected no valueCoding for parent property');
      assert(props.some((parts) => parts.some((part) => part.name === 'description' && typeof part.valueString === 'string' && part.valueString.length > 0)), 'expected parent description');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup accepts lenient parameter types',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueString: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueString: 'unknown' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Unknown', 'expected normalized display Unknown');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup wildcard property succeeds',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
        property: '*',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const props = (res.body?.parameter || []).filter((p) => p.name === 'property');
      assert(props.length >= 1, 'expected wildcard property results');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup supports repeating property parameters',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'property', valueCode: 'inactive' },
        { name: 'property', valueCode: 'abstract' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const inactiveProps = propertyParts(res.body?.parameter || [], 'inactive');
      assert(inactiveProps.length > 0, 'expected inactive property');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup honors inline supplement designation language choice',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'property', valueCode: 'designation' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-de' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-de',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            concept: [
              {
                code: 'male',
                designation: [
                  {
                    language: 'de',
                    use: {
                      system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                      code: 'preferredForLanguage',
                    },
                    value: 'Männlich',
                  },
                ],
              },
            ],
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Männlich', 'expected supplement-selected display');
      const designations = (res.body?.parameter || []).filter((p) => p.name === 'designation');
      const hasGermanDesignation = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && pp.valueString === 'Männlich')
      );
      assert(hasGermanDesignation, 'expected german designation in lookup response');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup inline supplement falls back to base display when language is absent',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'fr' },
        { name: 'property', valueCode: 'designation' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-de' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-de',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            concept: [
              {
                code: 'male',
                designation: [
                  {
                    language: 'de',
                    use: {
                      system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                      code: 'preferredForLanguage',
                    },
                    value: 'Männlich',
                  },
                ],
              },
            ],
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected base display when requested language is absent');
      const designations = (res.body?.parameter || []).filter((p) => p.name === 'designation');
      const hasGermanDesignation = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && pp.valueString === 'Männlich')
      );
      assert(hasGermanDesignation, 'expected fallback response to still include designation payload');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup allows extra inline supplement that is resolved but irrelevant',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; relevant inline supplements are applied while unrelated inline supplements are ignored rather than causing failure.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'property', valueCode: 'designation' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-de' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/usps-rolls' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-de',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            concept: [
              {
                code: 'male',
                designation: [
                  {
                    language: 'de',
                    use: {
                      system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                      code: 'preferredForLanguage',
                    },
                    value: 'Männlich',
                  },
                ],
              },
            ],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/usps-rolls',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: SYS.USPS,
            property: [{ code: 'd20-roll', type: 'integer' }],
            concept: [{ code: 'TX', property: [{ code: 'd20-roll', valueInteger: 20 }] }],
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Männlich', 'expected relevant inline supplement-selected display');
      const designations = (res.body?.parameter || []).filter((p) => p.name === 'designation');
      const hasGermanDesignation = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && pp.valueString === 'Männlich')
      );
      assert(hasGermanDesignation, 'expected german designation in lookup response');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup inline supplement ambiguity chooses newest version',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'Policy decision: when useSupplement names multiple matching versions without pinning one, IR resolves to the newest available supplement version.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-de' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-de',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            concept: [{ code: 'male', designation: [{ language: 'de', value: 'Männlich' }] }],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-de',
            version: '2.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            concept: [{ code: 'male', designation: [{ language: 'de', value: 'Mann' }] }],
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Mann', 'expected newest supplement-selected display');
      const designations = (res.body?.parameter || []).filter((p) => p.name === 'designation');
      const hasGermanDesignation = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && pp.valueString === 'Mann')
      );
      assert(hasGermanDesignation, 'expected designation from newest supplement version');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup repeated inline supplements choose requested language and merge designations',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'fr' },
        { name: 'property', valueCode: 'designation' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-de' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-fr' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-de',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            concept: [
              {
                code: 'male',
                designation: [
                  {
                    language: 'de',
                    use: {
                      system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                      code: 'preferredForLanguage',
                    },
                    value: 'Männlich',
                  },
                ],
              },
            ],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-fr',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            concept: [
              {
                code: 'male',
                designation: [
                  {
                    language: 'fr',
                    use: {
                      system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                      code: 'preferredForLanguage',
                    },
                    value: 'Masculin',
                  },
                ],
              },
            ],
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Masculin', 'expected french supplement-selected display');
      const designations = (res.body?.parameter || []).filter((p) => p.name === 'designation');
      const hasGermanDesignation = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && pp.valueString === 'Männlich')
      );
      const hasFrenchDesignation = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && pp.valueString === 'Masculin')
      );
      assert(hasGermanDesignation, 'expected german designation in lookup response');
      assert(hasFrenchDesignation, 'expected french designation in lookup response');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup honors configured sqlite supplement designation language choice',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'property', valueCode: 'designation' },
        { name: 'property', valueCode: 'd20-roll' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Kritischer Treffer', 'expected configured supplement-selected display');
      const designations = (res.body?.parameter || []).filter((p) => p.name === 'designation');
      const hasGermanDesignation = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && pp.valueString === 'Kritischer Treffer')
      );
      assert(hasGermanDesignation, 'expected configured supplement designation');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup configured sqlite supplement falls back to base display when language is absent',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'displayLanguage', valueCode: 'fr' },
        { name: 'property', valueCode: 'designation' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Critical Concept', 'expected base display when configured supplement has no matching language');
      const designations = (res.body?.parameter || []).filter((p) => p.name === 'designation');
      const hasDesignation = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && String(pp.valueString || '').includes('Kritischer Treffer'))
      );
      assert(hasDesignation, 'expected designation payload even when displayLanguage does not match');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup allows extra configured sqlite supplement that does not contribute',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'property', valueCode: 'designation' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d8' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Kritischer Treffer', 'expected contributing configured supplement-selected display');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup missing configured sqlite supplement fails explicitly',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-missing' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 422, `expected 422, got ${res.status}`);
      assert(String(res.body?.issue?.[0]?.details?.text || '').includes('Required supplement not found'),
        'expected missing supplement error');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup adapter-backed inline supplement returns designation override and typed property',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: SYS.USPS },
        { name: 'code', valueCode: 'TX' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'property', valueCode: 'designation' },
        { name: 'property', valueCode: 'd20-roll' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/usps-rolls' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/usps-rolls',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: SYS.USPS,
            property: [{ code: 'd20-roll', type: 'integer' }],
            concept: [
              {
                code: 'TX',
                designation: [
                  {
                    language: 'de',
                    use: {
                      system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
                      code: 'preferredForLanguage',
                    },
                    value: 'Texas Bonus',
                  },
                ],
                property: [{ code: 'd20-roll', valueInteger: 20 }],
              },
              { code: 'CA', property: [{ code: 'd20-roll', valueInteger: 1 }] },
            ],
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'display')?.valueString === 'Texas Bonus', 'expected supplement-selected display');
      const designations = (res.body?.parameter || []).filter((p) => p.name === 'designation');
      const hasDesignation = designations.some((p) =>
        (p.part || []).some((pp) => pp.name === 'value' && pp.valueString === 'Texas Bonus')
      );
      assert(hasDesignation, 'expected adapter-backed supplement designation');
      const d20RollProps = propertyParts(res.body?.parameter || [], 'd20-roll');
      assert(d20RollProps.length > 0, 'expected d20-roll property');
      assert(d20RollProps.some(parts =>
        parts.some(part => part.name === 'value' && part.valueInteger === 20)
      ), 'expected typed integer d20-roll property');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup configured sqlite multi-supplement wildcard properties include both typed values',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'property', valueCode: '*' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d8' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const d20RollProps = propertyParts(res.body?.parameter || [], 'd20-roll');
      const d8RollProps = propertyParts(res.body?.parameter || [], 'd8-roll');
      assert(d20RollProps.length > 0, 'expected d20-roll property');
      assert(d8RollProps.length > 0, 'expected d8-roll property');
      assert(d20RollProps.some(parts =>
        parts.some(part => part.name === 'value' && part.valueInteger === 20)
      ), 'expected typed integer d20-roll property');
      assert(d8RollProps.some(parts =>
        parts.some(part => part.name === 'value' && part.valueInteger === 2)
      ), 'expected typed integer d8-roll property');
    },
  },
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'POST lookup configured sqlite supplement wildcard properties include typed supplement values',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'property', valueCode: '*' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const d20RollProps = propertyParts(res.body?.parameter || [], 'd20-roll');
      assert(d20RollProps.length > 0, 'expected d20-roll property');
      assert(d20RollProps.some(parts =>
        parts.some(part => part.name === 'value' && part.valueInteger === 20)
      ), 'expected typed integer d20-roll property');
    },
  }
,
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET lookup RxNorm aspirin ingredient returns display and version',
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$lookup',
      query: {
        system: SYS.RXNORM,
        code: '1191',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const display = getParam(res.body, 'display')?.valueString || '';
      assert(display.toLowerCase().includes('aspirin'), `expected aspirin display, got ${display}`);
      assert(getParam(res.body, 'version')?.valueString, 'expected RxNorm version');
    },
  }
].map(withLookupId).map(withHighConfidenceLookupReview).map(clearReviewForIrOnly);
