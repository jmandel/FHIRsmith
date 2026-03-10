import { params, getParam, propertyParts, bundleLink, assert, SYS } from './common.mjs';

export const TX_VALIDATE_CASES = [
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET canonical CodeSystem validate male',
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
    name: 'POST validate inline CodeSystem resource accepts coding',
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
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
      assert(getParam(res.body, 'display')?.valueString === 'Female', 'expected inline CodeSystem display Female');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'GET CodeSystem instance validate male',
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
    name: 'GET CodeSystem validate missing code returns invalid request',
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
    engines: ['ir'],
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
    name: 'GET ValueSet instance validate male',
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    name: 'POST validate inline multi-supplement distinct property filters returns true',
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    name: 'POST validate inline supplement ambiguity fails explicitly',
    engines: ['ir'],
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
      assert(res.status === 422, `expected 422, got ${res.status}`);
      assert(String(res.body?.issue?.[0]?.details?.text || '').match(/ambiguous/i), 'expected ambiguous supplement error');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'POST validate missing configured sqlite supplement fails explicitly',
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    name: 'GET ValueSet instance validate by id via IR succeeds',
    engines: ['ir'],
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
    engines: ['ir'],
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
    engines: ['ir'],
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
    name: 'Inline CodeSystem validate-code with tx-resource',
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
    assertLocal: (res) => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(getParam(res.body, 'result')?.valueBoolean === true, 'expected result=true');
    },
  },
{
    category: 'Validate',
    kind: 'validate',
    name: 'Inline IPS procedures ValueSet validate survives exclude filters',
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
];
