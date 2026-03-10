/**
 * ValueSet $expand - Comprehensive Integration Tests
 *
 * Tests real-world expansion patterns against R5 core FHIR packages.
 * Covers enumerated concept lists, text filters, pagination, excludes,
 * multiple includes, ValueSet imports, expand parameters, inline compose
 * patterns, error handling, and response structure validation.
 */

const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { CodeSystem } = require('../../tx/library/codesystem');

describe('ValueSet $expand - Real-World Patterns', () => {
  let app;
  let provider;

  beforeAll(async () => {
    app = await getTestApp();
    provider = getTxModule().endpoints[0].provider;
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  function registerSupplement(codeSystem) {
    provider.codeSystems.set(codeSystem.url, codeSystem);
    if (codeSystem.version) {
      provider.codeSystems.set(codeSystem.vurl, codeSystem);
    }
  }

  function unregisterSupplement(codeSystem) {
    if (provider.codeSystems.get(codeSystem.url) === codeSystem) {
      provider.codeSystems.delete(codeSystem.url);
    }
    if (codeSystem.version && provider.codeSystems.get(codeSystem.vurl) === codeSystem) {
      provider.codeSystems.delete(codeSystem.vurl);
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Enumerated Concept Lists
  // ---------------------------------------------------------------------------
  describe('Enumerated Concept Lists', () => {
    test('should expand observation-status with all known codes', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/observation-status/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('ValueSet');

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(8);

      // Flatten nested contains (corrected is nested under amended)
      const allCodes = [];
      function flatten(items) {
        if (!items) return;
        for (const item of items) {
          allCodes.push(item.code);
          if (item.contains) flatten(item.contains);
        }
      }
      flatten(expansion.contains);

      expect(allCodes).toHaveLength(8);
      expect(allCodes).toContain('registered');
      expect(allCodes).toContain('preliminary');
      expect(allCodes).toContain('final');
      expect(allCodes).toContain('amended');
      expect(allCodes).toContain('corrected');
      expect(allCodes).toContain('cancelled');
      expect(allCodes).toContain('entered-in-error');
      expect(allCodes).toContain('unknown');

      // All codes should be from the same system
      const allEntries = [];
      function flattenFull(items) {
        if (!items) return;
        for (const item of items) {
          allEntries.push(item);
          if (item.contains) flattenFull(item.contains);
        }
      }
      flattenFull(expansion.contains);
      for (const entry of allEntries) {
        expect(entry.system).toBe('http://hl7.org/fhir/observation-status');
      }
    });

    test('should expand observation-status with hierarchy (corrected nested under amended)', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/observation-status/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);
      const contains = res.body.expansion.contains;

      // Top-level should have 7 entries (corrected is nested)
      expect(contains).toHaveLength(7);

      const amended = contains.find(c => c.code === 'amended');
      expect(amended).toBeDefined();
      expect(amended.contains).toBeDefined();
      expect(amended.contains).toHaveLength(1);
      expect(amended.contains[0].code).toBe('corrected');
      expect(amended.contains[0].display).toBe('Corrected');
    });

    test('should expand immunization-status with exactly 3 codes', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/immunization-status/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(3);
      expect(expansion.contains).toHaveLength(3);

      const codes = expansion.contains.map(c => c.code);
      expect(codes).toContain('completed');
      expect(codes).toContain('entered-in-error');
      expect(codes).toContain('not-done');

      // These come from event-status, not immunization-status
      for (const entry of expansion.contains) {
        expect(entry.system).toBe('http://hl7.org/fhir/event-status');
        expect(entry.display).toBeDefined();
        expect(typeof entry.display).toBe('string');
      }
    });

    test('should expand link-type with exactly 4 codes', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/link-type/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.contains).toHaveLength(4);

      const codes = expansion.contains.map(c => c.code);
      expect(codes).toContain('replaced-by');
      expect(codes).toContain('replaces');
      expect(codes).toContain('refer');
      expect(codes).toContain('seealso');
    });

    test('should expand inline ValueSet with concept subset', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://hl7.org/fhir/administrative-gender',
              concept: [
                { code: 'male' },
                { code: 'other' }
              ]
            }]
          }
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(2);
      expect(expansion.contains).toHaveLength(2);

      const codes = expansion.contains.map(c => c.code);
      expect(codes).toContain('male');
      expect(codes).toContain('other');
      // Should NOT include female or unknown
      expect(codes).not.toContain('female');
      expect(codes).not.toContain('unknown');
    });

    test('should expand inline ValueSet including whole system', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://hl7.org/fhir/administrative-gender'
            }]
          }
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.contains).toHaveLength(4);

      const codes = expansion.contains.map(c => c.code);
      expect(codes).toEqual(['male', 'female', 'other', 'unknown']);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Filter Text Search
  // ---------------------------------------------------------------------------
  describe('Filter Text Search', () => {
    test('should match "male" and "female" when filter=mal on admin-gender', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ filter: 'mal' })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const contains = res.body.expansion.contains;
      expect(contains).toHaveLength(2);

      const codes = contains.map(c => c.code);
      expect(codes).toContain('male');
      expect(codes).toContain('female');
    });

    test('should match "unknown" when filter=unk on admin-gender', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ filter: 'unk' })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const contains = res.body.expansion.contains;
      expect(contains).toHaveLength(1);
      expect(contains[0].code).toBe('unknown');
      expect(contains[0].display).toBe('Unknown');
    });

    test('should return empty contains when filter=zzz matches nothing', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ filter: 'zzz' })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      // No contains at all when nothing matches
      expect(expansion.contains).toBeUndefined();
    });

    test('should echo the filter parameter back in expansion.parameter', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ filter: 'mal' })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const filterParam = res.body.expansion.parameter.find(
        p => p.name === 'filter'
      );
      expect(filterParam).toBeDefined();
      expect(filterParam.valueString).toBe('mal');
    });

    test('should filter observation-status with filter=fin', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/observation-status/$expand')
        .query({ filter: 'fin' })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const codes = res.body.expansion.contains.map(c => c.code);
      expect(codes).toContain('final');
    });

    test('should filter observation-status with filter=reg to match registered only', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/observation-status/$expand')
        .query({ filter: 'reg' })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const contains = res.body.expansion.contains;
      expect(contains).toHaveLength(1);
      expect(contains[0].code).toBe('registered');
      expect(contains[0].display).toBe('Registered');
    });

    test('should filter observation-status with filter=error', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/observation-status/$expand')
        .query({ filter: 'error' })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const codes = res.body.expansion.contains.map(c => c.code);
      // "entered-in-error" contains "error" in display; "corrected" may also match
      expect(codes).toContain('entered-in-error');
    });

    test('should filter via Parameters POST with filter parameter', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'filter', valueString: 'mal' },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                status: 'active',
                compose: {
                  include: [{
                    system: 'http://hl7.org/fhir/administrative-gender'
                  }]
                }
              }
            }
          ]
        });

      expect(res.status).toBe(200);

      const codes = res.body.expansion.contains.map(c => c.code);
      expect(codes).toContain('male');
      expect(codes).toContain('female');
      expect(codes).not.toContain('other');
      expect(codes).not.toContain('unknown');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Pagination (offset / count)
  // ---------------------------------------------------------------------------
  describe('Pagination', () => {
    test('should return first page with count=2, offset=0', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ count: 2, offset: 0 })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.offset).toBe(0);
      expect(expansion.contains).toHaveLength(2);
      expect(expansion.contains[0].code).toBe('male');
      expect(expansion.contains[1].code).toBe('female');
    });

    test('should return second page with count=2, offset=2', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ count: 2, offset: 2 })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.offset).toBe(2);
      expect(expansion.contains).toHaveLength(2);
      expect(expansion.contains[0].code).toBe('other');
      expect(expansion.contains[1].code).toBe('unknown');
    });

    test('should have no overlap between pages', async () => {
      const page1 = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ count: 2, offset: 0 })
        .set('Accept', 'application/json');

      const page2 = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ count: 2, offset: 2 })
        .set('Accept', 'application/json');

      const codes1 = page1.body.expansion.contains.map(c => c.code);
      const codes2 = page2.body.expansion.contains.map(c => c.code);

      // No overlap
      const overlap = codes1.filter(c => codes2.includes(c));
      expect(overlap).toHaveLength(0);

      // Together they cover all 4 codes
      const all = [...codes1, ...codes2];
      expect(all).toHaveLength(4);
      expect(all).toContain('male');
      expect(all).toContain('female');
      expect(all).toContain('other');
      expect(all).toContain('unknown');
    });

    test('should return total only with count=0 (no contains)', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ count: 0 })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.contains).toBeUndefined();
    });

    test('should return empty contains when offset beyond total', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ offset: 10 })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.offset).toBe(10);
      expect(expansion.contains).toBeUndefined();
    });

    test('should return all codes when count exceeds total', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ count: 1000 })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.contains).toHaveLength(4);
    });

    test('should echo offset and count in expansion.parameter', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ count: 2, offset: 0 })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const params = res.body.expansion.parameter;
      const offsetParam = params.find(p => p.name === 'offset');
      const countParam = params.find(p => p.name === 'count');

      expect(offsetParam).toBeDefined();
      expect(offsetParam.valueInteger).toBe(0);
      expect(countParam).toBeDefined();
      expect(countParam.valueInteger).toBe(2);
    });

    test('should paginate observation-status correctly', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/observation-status/$expand')
        .query({ count: 2, offset: 0 })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(8);
      expect(expansion.contains).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Compose with Excludes
  // ---------------------------------------------------------------------------
  describe('Compose with Excludes', () => {
    test('should exclude a single concept from a whole system', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://hl7.org/fhir/administrative-gender'
            }],
            exclude: [{
              system: 'http://hl7.org/fhir/administrative-gender',
              concept: [{ code: 'unknown' }]
            }]
          }
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(3);
      expect(expansion.contains).toHaveLength(3);

      const codes = expansion.contains.map(c => c.code);
      expect(codes).toContain('male');
      expect(codes).toContain('female');
      expect(codes).toContain('other');
      expect(codes).not.toContain('unknown');
    });

    test('should exclude multiple concepts from a whole system', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://hl7.org/fhir/administrative-gender'
            }],
            exclude: [{
              system: 'http://hl7.org/fhir/administrative-gender',
              concept: [
                { code: 'unknown' },
                { code: 'other' }
              ]
            }]
          }
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(2);
      expect(expansion.contains).toHaveLength(2);

      const codes = expansion.contains.map(c => c.code);
      expect(codes).toContain('male');
      expect(codes).toContain('female');
      expect(codes).not.toContain('unknown');
      expect(codes).not.toContain('other');
    });

    test('should still have display values after exclusion', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://hl7.org/fhir/administrative-gender'
            }],
            exclude: [{
              system: 'http://hl7.org/fhir/administrative-gender',
              concept: [{ code: 'other' }, { code: 'unknown' }]
            }]
          }
        });

      expect(res.status).toBe(200);

      for (const entry of res.body.expansion.contains) {
        expect(entry.display).toBeDefined();
        expect(typeof entry.display).toBe('string');
        expect(entry.display.length).toBeGreaterThan(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Multiple Includes (Union)
  // ---------------------------------------------------------------------------
  describe('Multiple Includes (Union)', () => {
    test('should include codes from two different code systems', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [
              {
                system: 'http://hl7.org/fhir/administrative-gender',
                concept: [
                  { code: 'male' },
                  { code: 'female' }
                ]
              },
              {
                system: 'http://hl7.org/fhir/observation-status',
                concept: [
                  { code: 'final' },
                  { code: 'amended' }
                ]
              }
            ]
          }
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.contains).toHaveLength(4);

      const genderCodes = expansion.contains.filter(
        c => c.system === 'http://hl7.org/fhir/administrative-gender'
      );
      const statusCodes = expansion.contains.filter(
        c => c.system === 'http://hl7.org/fhir/observation-status'
      );

      expect(genderCodes).toHaveLength(2);
      expect(statusCodes).toHaveLength(2);

      expect(genderCodes.map(c => c.code)).toContain('male');
      expect(genderCodes.map(c => c.code)).toContain('female');
      expect(statusCodes.map(c => c.code)).toContain('final');
      expect(statusCodes.map(c => c.code)).toContain('amended');
    });

    test('should report used-codesystem for each system in expansion.parameter', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [
              {
                system: 'http://hl7.org/fhir/administrative-gender',
                concept: [{ code: 'male' }]
              },
              {
                system: 'http://hl7.org/fhir/observation-status',
                concept: [{ code: 'final' }]
              }
            ]
          }
        });

      expect(res.status).toBe(200);

      const usedSystems = res.body.expansion.parameter
        .filter(p => p.name === 'used-codesystem')
        .map(p => p.valueUri);

      expect(usedSystems.some(u => u.startsWith('http://hl7.org/fhir/administrative-gender'))).toBe(true);
      expect(usedSystems.some(u => u.startsWith('http://hl7.org/fhir/observation-status'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. ValueSet Imports
  // ---------------------------------------------------------------------------
  describe('ValueSet Imports', () => {
    test('should expand inline ValueSet importing administrative-gender', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender']
            }]
          }
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.contains).toHaveLength(4);

      const codes = expansion.contains.map(c => c.code);
      expect(codes).toContain('male');
      expect(codes).toContain('female');
      expect(codes).toContain('other');
      expect(codes).toContain('unknown');
    });

    test('should include used-valueset parameter when importing', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender']
            }]
          }
        });

      expect(res.status).toBe(200);

      const usedVS = res.body.expansion.parameter.find(
        p => p.name === 'used-valueset'
      );
      expect(usedVS).toBeDefined();
      expect(usedVS.valueUri).toMatch(/^http:\/\/hl7\.org\/fhir\/ValueSet\/administrative-gender/);
    });

    test('should expand inline ValueSet importing multiple value sets', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [
              { valueSet: ['http://hl7.org/fhir/ValueSet/administrative-gender'] },
              { valueSet: ['http://hl7.org/fhir/ValueSet/immunization-status'] }
            ]
          }
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(7);
      expect(expansion.contains).toHaveLength(7);

      const systems = [...new Set(expansion.contains.map(c => c.system))];
      expect(systems).toContain('http://hl7.org/fhir/administrative-gender');
      expect(systems).toContain('http://hl7.org/fhir/event-status');

      const codes = expansion.contains.map(c => c.code);
      // From admin-gender
      expect(codes).toContain('male');
      expect(codes).toContain('female');
      // From immunization-status
      expect(codes).toContain('completed');
      expect(codes).toContain('not-done');
    });

    test('should expand elementdefinition-types (imports fhir-types)', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/elementdefinition-types/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.contains.length).toBeGreaterThan(100);

      // Should contain FHIR path types and resource types
      const allCodes = [];
      function flatten(items) {
        if (!items) return;
        for (const item of items) {
          allCodes.push(item.code);
          if (item.contains) flatten(item.contains);
        }
      }
      flatten(expansion.contains);

      expect(allCodes).toContain('Patient');
      expect(allCodes).toContain('Observation');
      expect(allCodes).toContain('boolean');
      expect(allCodes).toContain('string');

      // Should report used-valueset for fhir-types
      const usedVS = expansion.parameter
        .filter(p => p.name === 'used-valueset')
        .map(p => p.valueUri);
      expect(usedVS.some(u => u.startsWith('http://hl7.org/fhir/ValueSet/fhir-types'))).toBe(true);
    });

    test('should fail when importing non-existent ValueSet', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              valueSet: ['http://example.org/nonexistent-vs']
            }]
          }
        });

      expect(res.status).toBe(422);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue[0].details.text).toContain('http://example.org/nonexistent-vs');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Expand Parameters
  // ---------------------------------------------------------------------------
  describe('Expand Parameters', () => {
    test('activeOnly=true should return expansion', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ activeOnly: true })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);

      // activeOnly should be echoed back in parameters
      const activeOnlyParam = expansion.parameter.find(
        p => p.name === 'activeOnly'
      );
      expect(activeOnlyParam).toBeDefined();
      expect(activeOnlyParam.valueBoolean).toBe(true);
    });

    test('includeDesignations=true should return expansion with designations if present', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ includeDesignations: true })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);

      const inclDesParam = expansion.parameter.find(
        p => p.name === 'includeDesignations'
      );
      expect(inclDesParam).toBeDefined();
      expect(inclDesParam.valueBoolean).toBe(true);

      // Contains entries should still have code/system/display
      for (const entry of expansion.contains) {
        expect(entry.system).toBeDefined();
        expect(entry.code).toBeDefined();
        expect(entry.display).toBeDefined();
      }
    });

    test('property=definition should return definition property on contains entries', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ property: 'definition' })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);

      // expansion.property should declare the property
      expect(expansion.property).toBeDefined();
      expect(Array.isArray(expansion.property)).toBe(true);

      const defProp = expansion.property.find(p => p.code === 'definition');
      expect(defProp).toBeDefined();
      expect(defProp.uri).toBe('http://hl7.org/fhir/concept-properties#definition');

      // Each contains entry should have the definition property
      for (const entry of expansion.contains) {
        expect(entry.property).toBeDefined();
        expect(Array.isArray(entry.property)).toBe(true);

        const def = entry.property.find(p => p.code === 'definition');
        expect(def).toBeDefined();
        expect(def.valueString).toBeDefined();
        expect(typeof def.valueString).toBe('string');
      }

      // Check specific definitions
      const male = expansion.contains.find(c => c.code === 'male');
      expect(male.property.find(p => p.code === 'definition').valueString).toBe('Male.');

      const female = expansion.contains.find(c => c.code === 'female');
      expect(female.property.find(p => p.code === 'definition').valueString).toBe('Female.');
    });

    test('excludeNested=true should flatten observation-status hierarchy', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/observation-status/$expand')
        .query({ excludeNested: true })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(8);
      // With excludeNested, all 8 codes should be at the top level
      expect(expansion.contains).toHaveLength(8);

      // None should have nested contains
      for (const entry of expansion.contains) {
        expect(entry.contains).toBeUndefined();
      }

      // corrected should now appear at top level, not nested under amended
      const codes = expansion.contains.map(c => c.code);
      expect(codes).toContain('corrected');
      expect(codes).toContain('amended');

      const excludeNestedParam = expansion.parameter.find(
        p => p.name === 'excludeNested'
      );
      expect(excludeNestedParam).toBeDefined();
      expect(excludeNestedParam.valueBoolean).toBe(true);
    });

    test('excludeNotForUI=true should return expansion', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ excludeNotForUI: true })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.contains).toHaveLength(4);

      const param = expansion.parameter.find(
        p => p.name === 'excludeNotForUI'
      );
      expect(param).toBeDefined();
      expect(param.valueBoolean).toBe(true);
    });

    test('combined parameters: activeOnly + excludeNested + property', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({
          activeOnly: true,
          excludeNested: true,
          property: 'definition'
        })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.contains).toHaveLength(4);

      // Both boolean params echoed back
      const paramNames = expansion.parameter.map(p => p.name);
      expect(paramNames).toContain('excludeNested');
      expect(paramNames).toContain('activeOnly');

      // definition property should be present
      expect(expansion.property).toBeDefined();
      expect(expansion.property.find(p => p.code === 'definition')).toBeDefined();

      for (const entry of expansion.contains) {
        expect(entry.property).toBeDefined();
        const def = entry.property.find(p => p.code === 'definition');
        expect(def).toBeDefined();
        expect(def.valueString).toBeDefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Inline ValueSet with Complex Compose
  // ---------------------------------------------------------------------------
  describe('Inline ValueSet with Complex Compose', () => {
    test('should expand with is-a filter on observation-status', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://hl7.org/fhir/observation-status',
              filter: [{
                property: 'concept',
                op: 'is-a',
                value: 'amended'
              }]
            }]
          }
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      // Should include "amended" and its child "corrected"
      const allCodes = [];
      function flatten(items) {
        if (!items) return;
        for (const item of items) {
          allCodes.push(item.code);
          if (item.contains) flatten(item.contains);
        }
      }
      flatten(expansion.contains);

      expect(allCodes).toContain('amended');
      expect(allCodes).toContain('corrected');
      expect(allCodes).not.toContain('final');
      expect(allCodes).not.toContain('registered');
    });

    test('should expand include + exclude combination from same system', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://hl7.org/fhir/observation-status',
              concept: [
                { code: 'registered' },
                { code: 'preliminary' },
                { code: 'final' },
                { code: 'amended' }
              ]
            }],
            exclude: [{
              system: 'http://hl7.org/fhir/observation-status',
              concept: [
                { code: 'preliminary' },
                { code: 'amended' }
              ]
            }]
          }
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      const codes = expansion.contains.map(c => c.code);
      expect(codes).toContain('registered');
      expect(codes).toContain('final');
      expect(codes).not.toContain('preliminary');
      expect(codes).not.toContain('amended');
    });

    test('should expand empty compose include list (returns empty expansion)', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: []
          }
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(0);
    });

    test('should expand with filter on large ValueSet (elementdefinition-types)', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/elementdefinition-types/$expand')
        .query({ filter: 'Patient' })
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const codes = res.body.expansion.contains.map(c => c.code);
      expect(codes).toContain('Patient');
      // Filter should reduce the count significantly from full set
      expect(codes.length).toBeLessThan(100);
      expect(codes.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Error Handling
  // ---------------------------------------------------------------------------
  describe('Error Handling', () => {
    test('should return 422 for inline ValueSet referencing unknown code system', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://example.org/totally-fake-system'
            }]
          }
        });

      expect(res.status).toBe(422);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue).toBeDefined();
      expect(res.body.issue[0].severity).toBe('error');
      expect(res.body.issue[0].code).toBe('not-found');
      expect(res.body.issue[0].details.text).toContain('http://example.org/totally-fake-system');
    });

    test('should return 422 for non-existent ValueSet id', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/this-does-not-exist/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(422);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue[0].code).toBe('not-found');
    });

    test('should return 422 for non-existent ValueSet URL', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/$expand')
        .query({ url: 'http://example.org/nonexistent-valueset' })
        .set('Accept', 'application/json');

      expect(res.status).toBe(422);
      expect(res.body.resourceType).toBe('OperationOutcome');
    });

    test('should return 400 when POST body is not a recognized resource', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({ foo: 'bar' });

      expect(res.status).toBe(400);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue[0].code).toBe('invalid');
    });

    test('should return 400 when GET has no url parameter', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(400);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue[0].code).toBe('invalid');
    });

    test('should return 422 for import of non-existent ValueSet', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              valueSet: ['http://example.org/nonexistent-vs']
            }]
          }
        });

      expect(res.status).toBe(422);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue[0].details.text).toContain('http://example.org/nonexistent-vs');
    });

    test('should return 422 for stored ValueSet that imports unavailable external ValueSet', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/security-labels/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(422);
      expect(res.body.resourceType).toBe('OperationOutcome');
      // security-labels imports v3-Confidentiality which is not in R5 core
      expect(res.body.issue[0].details.text).toContain('value set');
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Response Structure Validation
  // ---------------------------------------------------------------------------
  describe('Response Structure Validation', () => {
    test('expansion.identifier should be a UUID URN', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const identifier = res.body.expansion.identifier;
      expect(identifier).toBeDefined();
      expect(identifier).toMatch(
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    test('expansion.timestamp should be a valid ISO datetime', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const timestamp = res.body.expansion.timestamp;
      expect(timestamp).toBeDefined();

      const parsed = new Date(timestamp);
      expect(parsed.toString()).not.toBe('Invalid Date');
      // Timestamp should be recent (within the last hour)
      expect(parsed.getTime()).toBeGreaterThan(Date.now() - 3600000);
    });

    test('expansion.parameter should include used-codesystem', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const params = res.body.expansion.parameter;
      expect(params).toBeDefined();
      expect(Array.isArray(params)).toBe(true);

      const usedCS = params.find(p => p.name === 'used-codesystem');
      expect(usedCS).toBeDefined();
      expect(usedCS.valueUri).toBe('http://hl7.org/fhir/administrative-gender|5.0.0');
    });

    test('each contains entry should have system, code, and display', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      for (const entry of res.body.expansion.contains) {
        expect(entry.system).toBeDefined();
        expect(typeof entry.system).toBe('string');
        expect(entry.system.length).toBeGreaterThan(0);

        expect(entry.code).toBeDefined();
        expect(typeof entry.code).toBe('string');
        expect(entry.code.length).toBeGreaterThan(0);

        expect(entry.display).toBeDefined();
        expect(typeof entry.display).toBe('string');
        expect(entry.display.length).toBeGreaterThan(0);
      }
    });

    test('total should match actual count for small enumerated ValueSets', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(expansion.contains.length);
    });

    test('total should account for nested codes in hierarchical ValueSets', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/observation-status/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      // total=8 but top-level contains only has 7 (corrected is nested)
      expect(expansion.total).toBe(8);
      expect(expansion.contains).toHaveLength(7);

      // Count all entries including nested
      let count = 0;
      function countAll(items) {
        if (!items) return;
        for (const item of items) {
          count++;
          if (item.contains) countAll(item.contains);
        }
      }
      countAll(expansion.contains);
      expect(count).toBe(8);
    });

    test('response should preserve original ValueSet metadata', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      expect(res.body.resourceType).toBe('ValueSet');
      expect(res.body.url).toBe('http://hl7.org/fhir/ValueSet/administrative-gender');
      expect(res.body.version).toBe('5.0.0');
      expect(res.body.name).toBe('AdministrativeGender');
      expect(res.body.status).toBe('active');
    });

    test('response should have unique expansion identifier for each request', async () => {
      const res1 = await request(app)
        .get('/tx/r5/ValueSet/administrative-gender/$expand')
        .query({ excludeNested: true }) // force different cache key
        .set('Accept', 'application/json');

      const res2 = await request(app)
        .get('/tx/r5/ValueSet/observation-status/$expand')
        .query({ excludeNested: true })
        .set('Accept', 'application/json');

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Different ValueSets should produce different identifiers
      expect(res1.body.expansion.identifier).not.toBe(
        res2.body.expansion.identifier
      );
    });

    test('inline ValueSet response should not carry metadata from stored ValueSets', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://hl7.org/fhir/administrative-gender'
            }]
          }
        });

      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('ValueSet');
      expect(res.body.status).toBe('active');
      expect(res.body.expansion).toBeDefined();

      // Should not inherit the stored ValueSet's url/name/version
      expect(res.body.url).toBeUndefined();
      expect(res.body.name).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 11. Pre-expanded ValueSets
  // ---------------------------------------------------------------------------
  describe('Pre-expanded ValueSets', () => {
    test('should return pre-existing expansion for yesnodontknow', async () => {
      const res = await request(app)
        .get('/tx/r5/ValueSet/yesnodontknow/$expand')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion).toBeDefined();
      expect(expansion.contains).toBeDefined();
      expect(expansion.contains.length).toBe(3);

      const codes = expansion.contains.map(c => c.code);
      expect(codes).toContain('Y');
      expect(codes).toContain('N');
      expect(codes).toContain('asked-unknown');

      // Check displays
      const yEntry = expansion.contains.find(c => c.code === 'Y');
      expect(yEntry.display).toBe('Yes');

      const nEntry = expansion.contains.find(c => c.code === 'N');
      expect(nEntry.display).toBe('No');

      const dkEntry = expansion.contains.find(c => c.code === 'asked-unknown');
      expect(dkEntry.display).toBe("Don't know");
    });
  });

  // ---------------------------------------------------------------------------
  // 12. POST with Parameters resource
  // ---------------------------------------------------------------------------
  describe('POST with Parameters Resource', () => {
    test('should expand using url in Parameters', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'url',
              valueUri: 'http://hl7.org/fhir/ValueSet/administrative-gender'
            }
          ]
        });

      expect(res.status).toBe(200);
      expect(res.body.expansion.total).toBe(4);
    });

    test('should expand inline ValueSet in Parameters with count and offset', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'count', valueInteger: 2 },
            { name: 'offset', valueInteger: 1 },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                status: 'active',
                compose: {
                  include: [{
                    system: 'http://hl7.org/fhir/administrative-gender'
                  }]
                }
              }
            }
          ]
        });

      expect(res.status).toBe(200);

      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);
      expect(expansion.contains).toHaveLength(2);
      expect(expansion.offset).toBe(1);
    });

    test('should expand with tx-resource CodeSystem and inline ValueSet', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'tx-resource',
              resource: {
                resourceType: 'CodeSystem',
                url: 'http://example.org/test-fruits',
                version: '1.0.0',
                status: 'active',
                content: 'complete',
                concept: [
                  { code: 'apple', display: 'Apple' },
                  { code: 'banana', display: 'Banana' },
                  { code: 'cherry', display: 'Cherry' }
                ]
              }
            },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                url: 'http://example.org/test-fruits-vs',
                status: 'active',
                compose: {
                  include: [{
                    system: 'http://example.org/test-fruits'
                  }]
                }
              }
            }
          ]
        });

      expect(res.status).toBe(200);
      expect(res.body.expansion).toBeDefined();
      expect(res.body.expansion.contains).toHaveLength(3);

      const codes = res.body.expansion.contains.map(c => c.code);
      expect(codes).toContain('apple');
      expect(codes).toContain('banana');
      expect(codes).toContain('cherry');
    });

    test('should emit structured trace for explicit legacy execution', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: '_engine', valueCode: 'legacy' },
            { name: '_trace', valueBoolean: true },
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                status: 'active',
                compose: {
                  include: [{
                    system: 'http://hl7.org/fhir/administrative-gender'
                  }]
                }
              }
            }
          ]
        });

      expect(res.status).toBe(200);
      const expansion = res.body.expansion;
      expect(expansion.total).toBe(4);

      const traceExt = (expansion.extension || []).find(
        e => e.url === 'https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/expand-trace'
      );
      expect(traceExt).toBeDefined();
      const traceJson = JSON.parse(traceExt.valueString);
      expect(traceJson.totalMs).toBeGreaterThan(0);

      const spanNames = [];
      const collectSpanNames = (spans) => {
        for (const s of spans || []) {
          if (!s) continue;
          spanNames.push(s.name);
          if (Array.isArray(s.children)) collectSpanNames(s.children);
        }
      };
      collectSpanNames(traceJson.spans);
      expect(spanNames).toContain('legacy-expand');
    });
  });
});
