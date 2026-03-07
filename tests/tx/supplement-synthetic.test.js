'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const BetterSqlite3 = require('better-sqlite3');
const { CodeSystem } = require('../../tx/library/codesystem');
const {
  buildDiceSupplementBundle,
  buildDiceSupplementConcept,
  readSqliteV0BaseInfo,
  rollForCode,
} = require('../../tx/supplements/synthetic');

function makeTempBaseDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supp-synth-'));
  const dbPath = path.join(dir, 'base.v0.db');
  const db = new BetterSqlite3(dbPath);
  db.exec(`
    CREATE TABLE code_system (
      cs_id INTEGER PRIMARY KEY,
      base_uri TEXT,
      version TEXT,
      canonical_uri TEXT,
      release_date TEXT,
      loaded_at TEXT,
      name TEXT,
      edition_code TEXT
    );
    CREATE TABLE concept (
      concept_id INTEGER PRIMARY KEY,
      cs_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      active INTEGER NOT NULL,
      display TEXT,
      definition TEXT
    );
  `);
  db.prepare(`
    INSERT INTO code_system
      (cs_id, base_uri, version, canonical_uri, release_date, loaded_at, name, edition_code)
    VALUES
      (1, 'http://loinc.org', '2.81', 'http://loinc.org|2.81', '2026-02-13', '2026-02-13T00:00:00Z', 'LOINC', NULL)
  `).run();
  const insert = db.prepare(`
    INSERT INTO concept (concept_id, cs_id, code, active, display, definition)
    VALUES (?, 1, ?, 1, ?, NULL)
  `);
  ['1000-1', '1000-2', '1000-3', '1000-4', '1000-5'].forEach((code, index) => {
    insert.run(index + 1, code, `Display ${code}`);
  });
  db.close();
  return { dir, dbPath };
}

describe('synthetic supplement generation', () => {
  test('reads base sqlite-v0 metadata and generates valid d20/d8 supplements', () => {
    const { dir, dbPath } = makeTempBaseDb();
    try {
      const base = readSqliteV0BaseInfo(dbPath);
      expect(base.system).toBe('http://loinc.org');
      expect(base.version).toBe('2.81');
      expect(base.codes).toHaveLength(5);

      const bundle = buildDiceSupplementBundle(base, {
        dice: ['d20', 'd8'],
        urlRoot: 'http://example.org/fhir/CodeSystem/test-dice',
        version: 'test-1',
        salt: 'unit-test',
      });
      expect(bundle.map(item => item.die)).toEqual(['d20', 'd8']);

      const d20 = new CodeSystem(bundle[0].resource);
      const d8 = new CodeSystem(bundle[1].resource);
      expect(d20.jsonObj.supplements).toBe('http://loinc.org|2.81');
      expect(d8.jsonObj.supplements).toBe('http://loinc.org|2.81');
      expect(d20.jsonObj.concept).toHaveLength(5);
      expect(d8.jsonObj.property.map(prop => prop.code)).toEqual(expect.arrayContaining([
        'd8-roll', 'dice-band', 'damage-type', 'party-role', 'critical-band',
      ]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('assigns deterministic die-specific and shared properties', () => {
    const d20a = buildDiceSupplementConcept('2160-0', 'd20', { salt: 'x' });
    const d20b = buildDiceSupplementConcept('2160-0', 'd20', { salt: 'x' });
    const d8 = buildDiceSupplementConcept('2160-0', 'd8', { salt: 'x' });

    expect(d20a).toEqual(d20b);
    expect(rollForCode('2160-0', 'd20', 'x')).toBe(
      d20a.property.find(prop => prop.code === 'd20-roll').valueInteger
    );
    expect(d20a.property.find(prop => prop.code === 'd20-roll')).toBeTruthy();
    expect(d8.property.find(prop => prop.code === 'd8-roll')).toBeTruthy();
    expect(d20a.property.find(prop => prop.code === 'damage-type')).toBeTruthy();
    expect(d8.property.find(prop => prop.code === 'damage-type')).toBeTruthy();
  });
});
