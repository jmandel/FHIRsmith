/**
 * The usage tracker counts how often codes are seen (for the usage-count expansion property).
 * It is never emptied, so it must not keep made-up codes: validating unique 40 KB codes grew it
 * by 10 MB a second.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const ConceptUsageTracker = require('../../tx/usage-tracker');

const CS_URL = 'http://example.org/fhir/CodeSystem/usage-tracker-cs';
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: [{ code: 'known', display: 'Known' }]
};

describe('ConceptUsageTracker', () => {
  test('counts the codes it sees', () => {
    const t = new ConceptUsageTracker();
    t.seeConcept('http://a', 'x');
    t.seeConcept('http://a', 'x');
    expect(t.usages('http://a').get('x').count).toBe(2);
  });

  test('stops adding codes at its limits, but still counts the ones it has', () => {
    const t = new ConceptUsageTracker();
    t.seeConcept('http://a', 'x'.repeat(ConceptUsageTracker.MAX_CODE_LENGTH + 1));
    expect(t.usages('http://a')).toBeNull();
    t.seeConcept('http://a', 'x');
    t.codes = ConceptUsageTracker.MAX_CODES;
    t.seeConcept('http://a', 'y');
    t.seeConcept('http://b', 'y');
    t.seeConcept('http://a', 'x');
    expect(t.usages('http://a').has('y')).toBe(false);
    expect(t.usages('http://b')).toBeNull();
    expect(t.usages('http://a').get('x').count).toBe(2);
  });

  test('the packed codes count as a Map of codes would', () => {
    // a code takes its UTF-8 bytes, so codes with characters outside Latin-1 and of every length
    // up to the limit, in systems that each grow past several table sizes
    const t = new ConceptUsageTracker(20000, 30);
    const ref = new Map();
    let codes = 0;
    const refSee = (s, c) => {
      let m = ref.get(s);
      if (!(m && m.has(c))) {
        if (codes >= 20000 || c.length > 30) return;
        if (!m) ref.set(s, m = new Map());
        m.set(c, 0);
        codes++;
      }
      m.set(c, m.get(c) + 1);
    };
    const chars = ['a', 'B', '7', '-', '.', 'é', '中', '😀'];
    let seed = 1;
    const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
    for (let i = 0; i < 100000; i++) {
      const s = 'http://s' + rnd(8);
      let c = '';
      for (let k = rnd(rnd(36) + 1); k > 0; k--) c += chars[rnd(chars.length)];
      t.seeConcept(s, c);
      refSee(s, c);
    }
    expect(t.codes).toBe(codes);
    expect(codes).toBe(20000);
    for (const [s, m] of ref) {
      const u = t.usages(s);
      expect(new Map([...u].map(([c, x]) => [c, x.count]))).toEqual(m);
      for (const [c, n] of m) expect(u.get(c)).toEqual({ count: n });
      expect(u.get(s + '-not-a-code')).toBeUndefined();
      expect(u.has(s + '-not-a-code')).toBe(false);
    }
  });
});

describe('$validate-code records only valid codes', () => {
  let app;
  beforeAll(async () => { app = await getTestApp(); }, 60000);
  afterAll(async () => { await shutdownTestApp(); });

  test.each([['known', 1], ['made-up', 0]])('code %s', async (code, seen) => {
    const spy = jest.spyOn(ConceptUsageTracker.prototype, 'seeConcept');
    try {
      const res = await request(app).post('/tx/r5/CodeSystem/$validate-code')
        .set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: [
          { name: 'tx-resource', resource: CS },
          { name: 'coding', valueCoding: { system: CS_URL, code } }
        ] });
      expect(res.status).toBe(200);
      expect(spy.mock.calls.filter(c => c[1] === code)).toHaveLength(seen);
    } finally {
      spy.mockRestore();
    }
  });
});
