import { params, getParam, propertyParts, bundleLink, assert, SYS } from './common.mjs';

const VALIDATE_BASE_ID = 243;

function adminGenderCodeSystemR4() {
  return {
    resourceType: 'CodeSystem',
    url: SYS.GENDER,
    version: '4.0.1',
    name: 'AdministrativeGender',
    title: 'AdministrativeGender',
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'male', display: 'Male', definition: 'Male.' },
      { code: 'female', display: 'Female', definition: 'Female.' },
      { code: 'other', display: 'Other', definition: 'Other.' },
      { code: 'unknown', display: 'Unknown', definition: 'Unknown.' },
    ],
  };
}

const HIGH_CONFIDENCE_VALIDATE_IR_PREFERRED = new Set([
  297, 292, 309, 302, 298, 296, 295, 258, 282, 281, 274, 278, 277, 272, 273,
  284, 285, 283, 286, 310, 249, 276, 275, 280, 279, 288, 299,
]);

const HIGH_CONFIDENCE_VALIDATE_NO_DIFF = new Set([
  261, 294,
]);

const BATCH_VALIDATE_NO_DIFF_IDS = new Set([
  300, 244, 254, 265, 306, 304, 305, 303, 263, 267, 266, 250, 251, 268, 269, 271,
]);

function withValidateId(caseDef, index) {
  return {
    ...caseDef,
    id: caseDef.id ?? (VALIDATE_BASE_ID + index),
  };
}

function withHighConfidenceValidateReview(caseDef) {
  if (caseDef.review) {
    return caseDef;
  }
  if (BATCH_VALIDATE_NO_DIFF_IDS.has(caseDef.id)) {
    return {
      ...caseDef,
      review: {
        status: 'reviewed',
        reviewedAt: '2026-03-11',
        note: 'Batch review: no meaningful semantic difference; remaining divergence was timeout/abort noise or other non-semantic variation.',
      },
    };
  }
  if (HIGH_CONFIDENCE_VALIDATE_IR_PREFERRED.has(caseDef.id)) {
    return {
      ...caseDef,
      review: {
        status: 'reviewed',
        reviewedAt: '2026-03-11',
        note: 'High-confidence batch review: IR behavior preferred in the fresh lookup/validate adjudication.',
      },
    };
  }
  if (HIGH_CONFIDENCE_VALIDATE_NO_DIFF.has(caseDef.id)) {
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

export const TX_VALIDATE_CASES = [
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET canonical CodeSystem validate male',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST CodeSystem validate by canonical url accepts code-only Parameters',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        { name: 'url', valueUri: SYS.GENDER },
        { name: 'code', valueCode: 'male' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'version')?.valueString === '4.0.1', 'expected version 4.0.1');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline official CodeSystem resource rejects bare code without system',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-11',
      note: 'Reviewed spec interpretation: code without system is invalid here even when an inline codeSystem is supplied, so the request should be rejected.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        { name: 'code', valueCode: 'male' },
        {
          name: 'codeSystem',
          resource: adminGenderCodeSystemR4(),
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 400, `expected 400, got ${res.status}`);
      const text = String(res.body?.issue?.[0]?.details?.text || '');
      assert(text.includes('Unable to find code to validate'), 'expected invalid bare-code error');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline CodeSystem resource accepts coding',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; inline codeSystem parameter is applied during validation instead of being ignored.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://hl7.org/fhir/administrative-gender',
            code: 'female',
          },
        },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://hl7.org/fhir/administrative-gender',
            version: '5.0.0',
            status: 'active',
            content: 'complete',
            concept: [
              { code: 'male', display: 'Male' },
              { code: 'female', display: 'Female' },
              { code: 'unknown', display: 'Unknown' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
        assert(getParam(res.body, 'display')?.valueString === 'Female', 'expected inline CodeSystem display Female');
      },
      legacy: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected legacy result=false');
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline CodeSystem resource overrides server-known version via IR',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; when an inline codeSystem is supplied it should be authoritative for this request, even if the server also knows a stored version for the same canonical URL.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://hl7.org/fhir/administrative-gender',
            code: 'female',
          },
        },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://hl7.org/fhir/administrative-gender',
            version: '5.0.0',
            status: 'active',
            content: 'complete',
            concept: [
              { code: 'male', display: 'Male' },
              { code: 'female', display: 'Female' },
              { code: 'unknown', display: 'Unknown' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
        assert(getParam(res.body, 'display')?.valueString === 'Female', 'expected inline CodeSystem display Female');
      },
      legacy: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected legacy result=false');
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate custom inline CodeSystem resource via IR',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; custom inline CodeSystem validation succeeds while legacy/upstream report the system as unknown.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://example.org/cs-inline-validate',
            code: 'A',
          },
        },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-validate',
            version: '1.0.0',
            content: 'complete',
            concept: [
              { code: 'A', display: 'Alpha' },
              { code: 'B', display: 'Beta' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
        assert(getParam(res.body, 'display')?.valueString === 'Alpha', 'expected inline CodeSystem display Alpha');
      },
      legacy: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected legacy result=false');
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline CodeSystem resource honors inline supplement designation language choice via IR',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        { name: 'code', valueCode: 'A' },
        { name: 'system', valueUri: 'http://example.org/cs-inline-validate-supp-base' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'useSupplement', valueString: 'http://example.org/cs-inline-validate-supp-de' },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-validate-supp-base',
            version: '1.0.0',
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
            url: 'http://example.org/cs-inline-validate-supp-de',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://example.org/cs-inline-validate-supp-base',
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
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Alpha Deutsch', 'expected supplement-selected display');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline CodeSystem resource rejects codeableConcept without system',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [
              {
                code: 'A',
                display: 'Alpha',
              },
            ],
          },
        },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-validate-cc',
            version: '1.0.0',
            content: 'complete',
            concept: [
              { code: 'A', display: 'Alpha' },
              { code: 'B', display: 'Beta' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
        assert(String(getParam(res.body, 'message')?.valueString || '').includes('Coding has no system'),
          'expected missing-system warning');
        const returnedCC = getParam(res.body, 'codeableConcept')?.valueCodeableConcept;
        assert(Array.isArray(returnedCC?.coding) && returnedCC.coding[0]?.code === 'A',
          'expected original codeableConcept to be echoed back');
      },
      legacy: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected legacy result=false');
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline CodeSystem resource rejects coding without system',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            code: 'A',
            display: 'Alpha',
          },
        },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-validate-coding-no-system',
            version: '1.0.0',
            content: 'complete',
            concept: [
              { code: 'A', display: 'Alpha' },
              { code: 'B', display: 'Beta' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
        assert(String(getParam(res.body, 'message')?.valueString || '').includes('Coding has no system'),
          'expected missing-system warning');
      },
      legacy: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected legacy result=false');
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET CodeSystem instance validate male',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; instance-by-id official CodeSystem validation succeeds while legacy/upstream still fail.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/administrative-gender/$validate-code',
      query: {
        code: 'male',
      },
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
        assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
      },
      legacy: (res) => {
        assert(res.status === 400, `expected 400, got ${res.status}`);
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST CodeSystem instance validate female',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; instance-by-id POST CodeSystem validation succeeds with code-only Parameters while legacy/upstream still fail.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/administrative-gender/$validate-code',
      body: params([
        { name: 'code', valueCode: 'female' },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
        assert(getParam(res.body, 'display')?.valueString === 'Female', 'expected normalized display Female');
      },
      legacy: (res) => {
        assert(res.status === 400, `expected 400, got ${res.status}`);
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST CodeSystem validate display mismatch returns false with normalized display',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        { name: 'url', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'display', valueString: 'WRONG' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
      const message = getParam(res.body, 'message')?.valueString || '';
      assert(message.length > 0, 'expected display mismatch message');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET CodeSystem validate missing code returns invalid request',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/administrative-gender',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 400, `expected 400, got ${res.status}`);
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET CodeSystem instance validate unknown id returns not-found',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/nonexistent-id/$validate-code',
      query: {
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 422, `expected 422, got ${res.status}`);
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST CodeSystem validate inline supplement designation language choice returns supplement display',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; inline supplement plus displayLanguage correctly returns the German designation from the supplement.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        { name: 'url', valueUri: 'http://hl7.org/fhir/administrative-gender' },
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
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Männlich', 'expected supplement-selected display');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST CodeSystem validate configured sqlite supplement designation language choice returns supplement display',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        { name: 'url', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Kritischer Treffer', 'expected configured supplement-selected display');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST CodeSystem validate allows extra inline supplement that is resolved but irrelevant',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; relevant inline supplements are applied while unrelated inline supplements are ignored rather than causing failure.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        { name: 'url', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'de' },
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
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Männlich', 'expected relevant supplement-selected display');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST CodeSystem validate inline supplement ambiguity chooses newest version',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'Policy decision: unversioned useSupplement resolves to the newest matching supplement version instead of failing ambiguous.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        { name: 'url', valueUri: 'http://hl7.org/fhir/administrative-gender' },
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
            url: 'http://example.org/fhir/CodeSystem/admin-gender-de',
            version: '2.0.0',
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
                    value: 'Männlich V2',
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
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Männlich V2', 'expected newest supplement-selected display');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET canonical ValueSet validate male',
    request: {
      method: 'GET',
      path: '/r4/ValueSet/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET canonical ValueSet url|version validate male',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/ValueSet/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1',
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST inline single-system ValueSet validate infers system from code',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'code', valueCode: 'male' },
        { name: 'inferSystem', valueBoolean: true },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            url: 'http://example.org/vs/infer-gender',
            compose: {
              include: [{
                system: 'http://hl7.org/fhir/administrative-gender',
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'system')?.valueUri === 'http://hl7.org/fhir/administrative-gender', 'expected inferred system');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET ValueSet instance validate male',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/ValueSet/administrative-gender/$validate-code',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST ValueSet instance validate infers system from code',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/administrative-gender/$validate-code',
      body: params([
        { name: 'code', valueCode: 'male' },
        { name: 'inferSystem', valueBoolean: true },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'system')?.valueUri === 'http://hl7.org/fhir/administrative-gender', 'expected inferred system');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate display mismatch returns false with normalized display',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'display', valueString: 'WRONG' },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            url: 'http://example.org/vs/gender-display-check',
            compose: {
              include: [{
                system: 'http://hl7.org/fhir/administrative-gender',
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
      const message = getParam(res.body, 'message')?.valueString || '';
      assert(message.length > 0, 'expected display mismatch message');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate CodeableConcept with one invalid and one valid coding returns false',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [
              { system: 'http://hl7.org/fhir/administrative-gender', code: 'bad' },
              { system: 'http://hl7.org/fhir/administrative-gender', code: 'male' },
            ],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            url: 'http://example.org/vs/gender-multi-coding',
            compose: {
              include: [{
                system: 'http://hl7.org/fhir/administrative-gender',
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
      assert(getParam(res.body, 'code')?.valueCode === 'male', 'expected normalized valid code');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display from valid coding');
      const message = getParam(res.body, 'message')?.valueString || '';
      assert(message.toLowerCase().includes('unknown code'), 'expected unknown code message');
      const returnedCC = getParam(res.body, 'codeableConcept')?.valueCodeableConcept;
      assert(Array.isArray(returnedCC?.coding) && returnedCC.coding.length === 2, 'expected returned codeableConcept');
      assert(returnedCC.coding[0]?.code === 'bad' && returnedCC.coding[1]?.code === 'male',
        'expected original coding order to be preserved');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline supplement designation language choice returns supplement display',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
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
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://hl7.org/fhir/administrative-gender',
                concept: [{ code: 'male' }],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Männlich', 'expected supplement-selected display');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline supplement falls back to base display when language is absent',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'fr' },
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
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://hl7.org/fhir/administrative-gender',
                concept: [{ code: 'male' }],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected base display when requested language is absent');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate allows extra inline supplement that is resolved but irrelevant',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-11',
      note: 'Reviewed policy: relevant supplements should still apply even when an extra irrelevant supplement is also supplied; the irrelevant supplement is a no-op, not a hard error.',
    },
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'de' },
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
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://hl7.org/fhir/administrative-gender',
                concept: [{ code: 'male' }],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Männlich', 'expected relevant inline supplement-selected display');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate repeated inline supplements choose requested language display',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'displayLanguage', valueCode: 'fr' },
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
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
            compose: {
              include: [{
                system: 'http://hl7.org/fhir/administrative-gender',
                concept: [{ code: 'male' }],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Masculin', 'expected french supplement-selected display');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate configured sqlite supplement designation language choice returns supplement display',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://example.org/op-harness-base',
                concept: [{ code: 'C0001' }],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Kritischer Treffer', 'expected configured supplement-selected display');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate configured sqlite supplement falls back to base display when language is absent',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'displayLanguage', valueCode: 'fr' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://example.org/op-harness-base',
                concept: [{ code: 'C0001' }],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Critical Concept', 'expected base display when configured supplement has no matching language');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate allows extra configured sqlite supplement that does not contribute',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'displayLanguage', valueCode: 'de' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d8' },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://example.org/op-harness-base',
                concept: [{ code: 'C0001' }],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Kritischer Treffer', 'expected contributing configured supplement-selected display');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline multi-supplement distinct property filters returns true',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-d20' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-d8' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-d20',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            property: [{ code: 'd20-roll', type: 'integer' }],
            concept: [
              { code: 'male', property: [{ code: 'd20-roll', valueInteger: 20 }] },
              { code: 'female', property: [{ code: 'd20-roll', valueInteger: 1 }] },
            ],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-d8',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            property: [{ code: 'd8-roll', type: 'integer' }],
            concept: [
              { code: 'male', property: [{ code: 'd8-roll', valueInteger: 2 }] },
              { code: 'female', property: [{ code: 'd8-roll', valueInteger: 7 }] },
            ],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://hl7.org/fhir/administrative-gender',
                filter: [
                  { property: 'd20-roll', op: '=', value: '20' },
                  { property: 'd8-roll', op: '=', value: '2' },
                ],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline multi-supplement distinct property filters returns false',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'female' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-d20' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-d8' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-d20',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            property: [{ code: 'd20-roll', type: 'integer' }],
            concept: [
              { code: 'male', property: [{ code: 'd20-roll', valueInteger: 20 }] },
              { code: 'female', property: [{ code: 'd20-roll', valueInteger: 1 }] },
            ],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-d8',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            property: [{ code: 'd8-roll', type: 'integer' }],
            concept: [
              { code: 'male', property: [{ code: 'd8-roll', valueInteger: 2 }] },
              { code: 'female', property: [{ code: 'd8-roll', valueInteger: 7 }] },
            ],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://hl7.org/fhir/administrative-gender',
                filter: [
                  { property: 'd20-roll', op: '=', value: '20' },
                  { property: 'd8-roll', op: '=', value: '2' },
                ],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate configured sqlite multi-supplement distinct property filters returns true',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d8' },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://example.org/op-harness-base',
                filter: [
                  { property: 'd20-roll', op: '=', value: '20' },
                  { property: 'd8-roll', op: '=', value: '2' },
                ],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate configured sqlite multi-supplement distinct property filters returns false',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0002' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d8' },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://example.org/op-harness-base',
                filter: [
                  { property: 'd20-roll', op: '=', value: '20' },
                  { property: 'd8-roll', op: '=', value: '2' },
                ],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline supplement-backed property filter via IR returns true',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; supplement-backed property filters over inline tx-resource content are accepted and evaluated correctly.',
    },
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://hl7.org/fhir/administrative-gender',
            code: 'male',
          },
        },
        {
          name: 'useSupplement',
          valueString: 'http://example.org/fhir/CodeSystem/admin-gender-rolls',
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-rolls',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            concept: [
              { code: 'male', property: [{ code: 'd20-roll', valueInteger: 20 }] },
              { code: 'female', property: [{ code: 'd20-roll', valueInteger: 1 }] },
            ],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [
                {
                  system: 'http://hl7.org/fhir/administrative-gender',
                  filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                },
              ],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline supplement-backed property filter via IR accepts codeableConcept',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-11',
      note: 'Reviewed and accepted: ValueSet validation may rely on supplement-backed property filters, and the supplement here is directly relevant to the validated code system.',
    },
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [{
              system: 'http://hl7.org/fhir/administrative-gender',
              code: 'male',
            }],
          },
        },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/admin-gender-rolls' },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-rolls',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            concept: [
              { code: 'male', property: [{ code: 'd20-roll', valueInteger: 20 }] },
              { code: 'female', property: [{ code: 'd20-roll', valueInteger: 1 }] },
            ],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://hl7.org/fhir/administrative-gender',
                filter: [{ property: 'd20-roll', op: '=', value: '20' }],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate adapter-backed inline supplement-backed property filter via IR returns true',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: SYS.USPS },
        { name: 'code', valueCode: 'TX' },
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
              { code: 'TX', property: [{ code: 'd20-roll', valueInteger: 20 }] },
              { code: 'CA', property: [{ code: 'd20-roll', valueInteger: 1 }] },
            ],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [
                {
                  system: SYS.USPS,
                  filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                },
              ],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate adapter-backed inline supplement-backed property filter via IR returns false',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: SYS.USPS },
        { name: 'code', valueCode: 'CA' },
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
              { code: 'TX', property: [{ code: 'd20-roll', valueInteger: 20 }] },
              { code: 'CA', property: [{ code: 'd20-roll', valueInteger: 1 }] },
            ],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [
                {
                  system: SYS.USPS,
                  filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                },
              ],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate honors configured sqlite supplement-backed property filter',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'system',
          valueUri: 'http://example.org/op-harness-base',
        },
        {
          name: 'code',
          valueCode: 'C0001',
        },
        {
          name: 'useSupplement',
          valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20',
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [
                {
                  system: 'http://example.org/op-harness-base',
                  filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                },
              ],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate configured sqlite supplement-backed property filter accepts Coding',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://example.org/op-harness-base',
            code: 'C0001',
          },
        },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20' },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [{
                system: 'http://example.org/op-harness-base',
                filter: [{ property: 'd20-roll', op: '=', value: '20' }],
              }],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate configured sqlite supplement-backed property filter can fail cleanly',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'system',
          valueUri: 'http://example.org/op-harness-base',
        },
        {
          name: 'code',
          valueCode: 'C0002',
        },
        {
          name: 'useSupplement',
          valueString: 'http://example.org/fhir/CodeSystem/op-harness-d20',
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [
                {
                  system: 'http://example.org/op-harness-base',
                  filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                },
              ],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline supplement-backed property filter via IR returns false',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://hl7.org/fhir/administrative-gender',
            code: 'female',
          },
        },
        {
          name: 'useSupplement',
          valueString: 'http://example.org/fhir/CodeSystem/admin-gender-rolls',
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-rolls',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            concept: [
              { code: 'male', property: [{ code: 'd20-roll', valueInteger: 20 }] },
              { code: 'female', property: [{ code: 'd20-roll', valueInteger: 1 }] },
            ],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [
                {
                  system: 'http://hl7.org/fhir/administrative-gender',
                  filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                },
              ],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline supplement ambiguity chooses newest version',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'Policy decision: unversioned useSupplement resolves to the newest matching supplement version before ValueSet validation applies filters.',
    },
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'system',
          valueUri: 'http://hl7.org/fhir/administrative-gender',
        },
        {
          name: 'code',
          valueCode: 'male',
        },
        {
          name: 'useSupplement',
          valueString: 'http://example.org/fhir/CodeSystem/admin-gender-rolls',
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-rolls',
            version: '1.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            property: [{ code: 'd20-roll', type: 'integer' }],
            concept: [{ code: 'male', property: [{ code: 'd20-roll', valueInteger: 20 }] }],
          },
        },
        {
          name: 'tx-resource',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/fhir/CodeSystem/admin-gender-rolls',
            version: '2.0.0',
            status: 'active',
            content: 'supplement',
            supplements: 'http://hl7.org/fhir/administrative-gender',
            property: [{ code: 'd20-roll', type: 'integer' }],
            concept: [{ code: 'male', property: [{ code: 'd20-roll', valueInteger: 1 }] }],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [
                {
                  system: 'http://hl7.org/fhir/administrative-gender',
                  filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                },
              ],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false after newest supplement changes filtered property');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate missing configured sqlite supplement fails explicitly',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        { name: 'system', valueUri: 'http://example.org/op-harness-base' },
        { name: 'code', valueCode: 'C0001' },
        { name: 'useSupplement', valueString: 'http://example.org/fhir/CodeSystem/op-harness-missing' },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            status: 'active',
            compose: {
              include: [
                {
                  system: 'http://example.org/op-harness-base',
                  filter: [{ property: 'd20-roll', op: '=', value: '20' }],
                },
              ],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 422, `expected 422, got ${res.status}`);
      assert(String(res.body?.issue?.[0]?.details?.text || '').includes('Required supplement not found'), 'expected missing supplement error');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET canonical ValueSet invalid code returns result=false',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/ValueSet/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'not-a-gender',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
      assert(!!getParam(res.body, 'message'), 'expected explanatory message on failed validation');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET canonical ValueSet wrong system returns result=false',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/ValueSet/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
        system: 'http://hl7.org/fhir/publication-status',
        code: 'active',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET CodeSystem validate by url succeeds',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET CodeSystem validate honors explicit version parameter',
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/administrative-gender',
        version: '4.0.1',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'version')?.valueString === '4.0.1', 'expected version 4.0.1');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET CodeSystem validate unknown version returns false with explanatory message',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/administrative-gender',
        version: '0.0.0',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
      assert(getParam(res.body, 'version')?.valueString === '0.0.0', 'expected requested version reflected');
      const message = String(getParam(res.body, 'message')?.valueString || '');
      assert(message.includes('could not be found') || message.includes('Valid versions'),
        'expected explanatory unknown-version message');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET CodeSystem validate missing system/url is invalid request',
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/$validate-code',
      query: {
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 400, `expected 400, got ${res.status}`);
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST CodeSystem instance validate by id via IR succeeds',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/administrative-gender/$validate-code',
      body: params([
        { name: 'code', valueCode: 'male' },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST CodeSystem instance validate by id via IR accepts codeableConcept',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/administrative-gender/$validate-code',
      body: params([
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [{
              system: 'http://hl7.org/fhir/administrative-gender',
              code: 'female',
            }],
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Female', 'expected normalized display Female');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET CodeSystem instance validate missing code is invalid request',
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/administrative-gender/$validate-code',
    },
    assertLocal: (res) => {
      assert(res.status === 400, `expected 400, got ${res.status}`);
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET ValueSet instance validate by id via IR succeeds',
    request: {
      method: 'GET',
      path: '/r4/ValueSet/administrative-gender/$validate-code',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST ValueSet instance validate by id via IR accepts codeableConcept',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/administrative-gender/$validate-code',
      body: params([
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [{
              system: 'http://hl7.org/fhir/administrative-gender',
              code: 'female',
            }],
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET ValueSet instance validate by id via IR returns false for invalid code',
    request: {
      method: 'GET',
      path: '/r4/ValueSet/administrative-gender/$validate-code',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'not-a-gender',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET CodeSystem instance unknown id returns unsupported',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-11',
      note: 'High-confidence review: no meaningful semantic difference; local working implementations and tx.fhir.org agree on the not-found response for an unknown instance id.',
    },
    request: {
      method: 'GET',
      path: '/r4/CodeSystem/unknown/$validate-code',
      query: {
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 422, `expected 422, got ${res.status}`);
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET ValueSet instance unknown id returns unsupported',
    request: {
      method: 'GET',
      path: '/r4/ValueSet/unknown/$validate-code',
      query: {
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 422, `expected 422, got ${res.status}`);
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST coding canonical url|version validate female',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://hl7.org/fhir/administrative-gender',
            code: 'female',
          },
        },
        {
          name: 'url',
          valueCanonical: 'http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1',
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST codeableConcept canonical ValueSet validate male',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [{
              system: 'http://hl7.org/fhir/administrative-gender',
              code: 'male',
            }],
          },
        },
        {
          name: 'url',
          valueUri: 'http://hl7.org/fhir/ValueSet/administrative-gender',
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST codeableConcept canonical ValueSet with two valid codings returns true and preserves the original CodeableConcept',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [
              {
                system: 'http://hl7.org/fhir/administrative-gender',
                code: 'male',
              },
              {
                system: 'http://hl7.org/fhir/administrative-gender',
                code: 'female',
              },
            ],
          },
        },
        {
          name: 'url',
          valueUri: 'http://hl7.org/fhir/ValueSet/administrative-gender',
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'code')?.valueCode === 'female', 'expected normalized winning code');
      assert(getParam(res.body, 'display')?.valueString === 'Female', 'expected normalized winning display');
      const returnedCC = getParam(res.body, 'codeableConcept')?.valueCodeableConcept;
      assert(Array.isArray(returnedCC?.coding) && returnedCC.coding.length === 2, 'expected original CodeableConcept to be preserved');
      assert(returnedCC.coding[0]?.code === 'male' && returnedCC.coding[1]?.code === 'female',
        'expected original coding order to be preserved');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST ValueSet validate with only codeableConcept and no target ValueSet is invalid',
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [{
              system: 'http://hl7.org/fhir/administrative-gender',
              code: 'male',
            }],
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 400, `expected 400, got ${res.status}`);
      const text = String(res.body?.issue?.[0]?.details?.text || '');
      assert(text.includes('No ValueSet specified') || text.includes('provide url parameter') || text.includes('valueSet resource'),
        'expected missing ValueSet message');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET canonical ValueSet validate honors explicit valueSetVersion parameter',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/ValueSet/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
        valueSetVersion: '4.0.1',
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'female',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET canonical ValueSet validate honors explicit system-version parameter',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'GET',
      path: '/r4/ValueSet/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
        'system-version': 'http://hl7.org/fhir/administrative-gender|4.0.1',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'version')?.valueString === '4.0.1', 'expected version 4.0.1');
      assert(getParam(res.body, 'display')?.valueString === 'Male', 'expected normalized display Male');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET validate malformed system-version is rejected structurally',
    request: {
      method: 'GET',
      path: '/r4/ValueSet/$validate-code',
      query: {
        url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
        system: 'http://hl7.org/fhir/administrative-gender',
        code: 'male',
        'system-version': 'urn:iso:std:iso:3166',
      },
    },
    assertLocal: (res) => {
      assert(res.status === 422, `expected 422, got ${res.status}`);
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline CodeSystem abstract=false rejects abstract concept via IR',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://example.org/cs-abstract',
            code: 'A',
          },
        },
        { name: 'abstract', valueBoolean: false },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-abstract',
            version: '1.0.0',
            content: 'complete',
            concept: [
              { code: 'A', display: 'Alpha', property: [{ code: 'abstract', valueBoolean: true }] },
              { code: 'B', display: 'Beta' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected result=false');
        const message = String(getParam(res.body, 'message')?.valueString || '');
        assert(message.toLowerCase().includes('abstract'), 'expected abstract rejection message');
      },
      legacy: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected legacy result=false');
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate inline CodeSystem abstract=true accepts abstract concept via IR',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; inline codeSystem validation honors abstract=true and accepts the abstract concept from the supplied resource.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://example.org/cs-abstract',
            code: 'A',
          },
        },
        { name: 'abstract', valueBoolean: true },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-abstract',
            version: '1.0.0',
            content: 'complete',
            concept: [
              { code: 'A', display: 'Alpha', property: [{ code: 'abstract', valueBoolean: true }] },
              { code: 'B', display: 'Beta' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
        assert(getParam(res.body, 'display')?.valueString === 'Alpha', 'expected inline CodeSystem display Alpha');
      },
      legacy: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected legacy result=false');
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'Inline CodeSystem validate-code with tx-resource',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; inline codeSystem validation via tx-resource succeeds while legacy-style targets ignore the supplied resource.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        {
          name: 'coding',
          valueCoding: {
            system: 'http://example.org/cs-inline-validate',
            code: 'A',
          },
        },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-validate',
            version: '1.0.0',
            content: 'complete',
            concept: [
              { code: 'A', display: 'Alpha' },
              { code: 'B', display: 'Beta' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
        assert(getParam(res.body, 'display')?.valueString === 'Alpha', 'expected inline CodeSystem display Alpha');
      },
      legacy: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected legacy result=false');
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'Inline CodeSystem validate-code with tx-resource accepts codeableConcept with system via IR',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'IR behavior preferred; inline codeSystem plus codeableConcept validation succeeds while legacy/upstream ignore the supplied resource.',
    },
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$validate-code',
      body: params([
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [
              {
                system: 'http://example.org/cs-inline-validate-cc',
                code: 'A',
                display: 'Alpha',
              },
            ],
          },
        },
        {
          name: 'codeSystem',
          resource: {
            resourceType: 'CodeSystem',
            url: 'http://example.org/cs-inline-validate-cc',
            version: '1.0.0',
            content: 'complete',
            concept: [
              { code: 'A', display: 'Alpha' },
              { code: 'B', display: 'Beta' },
            ],
          },
        },
      ]),
    },
    assertByEngine: {
      ir: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
        assert(getParam(res.body, 'display')?.valueString === 'Alpha', 'expected inline CodeSystem display Alpha');
      },
      legacy: (res) => {
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(getParam(res.body, 'result')?.valueBoolean === false, 'expected legacy result=false');
        assert(String(getParam(res.body, 'message')?.valueString || '').includes('could not be found'),
          'expected legacy unknown-CodeSystem message');
      },
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'Inline IPS procedures ValueSet validate survives exclude filters',
    review: {
      status: 'reviewed',
      reviewedAt: '2026-03-10',
      note: 'High-confidence review: no meaningful semantic difference; observed divergence was limited to timeout/abort noise or minor non-semantic response variation.',
    },
    request: {
      method: 'POST',
      path: '/r4/ValueSet/$validate-code',
      body: params([
        {
          name: 'codeableConcept',
          valueCodeableConcept: {
            coding: [{
              system: 'http://snomed.info/sct',
              code: '36969009',
              display: 'Placement of stent in coronary artery (procedure)',
            }],
          },
        },
        {
          name: 'valueSet',
          resource: {
            resourceType: 'ValueSet',
            url: 'http://hl7.org/fhir/uv/ips/ValueSet/procedures-uv-ips',
            version: '2.0.0',
            compose: {
              include: [
                {
                  system: 'http://snomed.info/sct',
                  filter: [{ property: 'concept', op: 'descendent-of', value: '71388002' }],
                },
                {
                  system: 'http://snomed.info/sct',
                  filter: [{ property: 'concept', op: 'is-a', value: '787480003' }],
                },
              ],
              exclude: [
                {
                  system: 'http://snomed.info/sct',
                  filter: [{ property: 'concept', op: 'is-a', value: '14734007' }],
                },
              ],
            },
          },
        },
      ]),
    },
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(!getParam(res.body, 'message'), 'unexpected top-level message on success');
    },
  }
].map(withValidateId).map(withHighConfidenceValidateReview).map(clearReviewForIrOnly);
