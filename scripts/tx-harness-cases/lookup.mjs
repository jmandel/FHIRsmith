import { params, getParam, propertyParts, bundleLink, assert, SYS } from './common.mjs';

export const TX_LOOKUP_CASES = [
{
    category: 'Lookup',
    kind: 'lookup',
    name: 'GET system+code administrative gender male',
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
    name: 'GET instance lookup missing code returns invalid request',
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
    name: 'GET lookup property filter returns requested property only',
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
    name: 'POST lookup inline supplement ambiguity fails explicitly',
    request: {
      method: 'POST',
      path: '/r4/CodeSystem/$lookup',
      body: params([
        { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
        { name: 'code', valueCode: 'male' },
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
      assert(res.status === 422, `expected 422, got ${res.status}`);
      assert(String(res.body?.issue?.[0]?.details?.text || '').match(/ambiguous/i), 'expected ambiguous supplement error');
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    name: 'POST lookup adapter-backed inline supplement returns designation override and typed property',
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
];
