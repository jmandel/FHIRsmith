'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildDiceSupplementBundle,
} = require('../../tx/supplements/synthetic');
const {
  readSupplementSidecarCodeSystem,
  readSupplementSidecarMeta,
  writeSupplementSidecar,
} = require('../../tx/supplements/sqlite-sidecar');
const { buildRuntimeSqliteV0Db } = require('../support/sqlite-v0-runtime-db');

function makeBaseConcepts(count = 40) {
  return Array.from({ length: count }, (_, index) => ({
    concept_id: index + 1,
    cs_id: 1,
    code: `C${String(index + 1).padStart(3, '0')}`,
    display: `Code ${index + 1}`,
    active: 1,
  }));
}

function literalValuesByCode(resource, propertyCode) {
  const out = new Map();
  for (const concept of resource.concept || []) {
    const values = (concept.property || [])
      .filter(prop => prop.code === propertyCode)
      .map(prop => {
        if (prop.valueString != null) return String(prop.valueString);
        if (prop.valueCode != null) return String(prop.valueCode);
        if (prop.valueInteger != null) return String(prop.valueInteger);
        if (prop.valueDecimal != null) return String(prop.valueDecimal);
        if (prop.valueBoolean != null) return String(prop.valueBoolean);
        return null;
      })
      .filter(Boolean);
    out.set(concept.code, values);
  }
  return out;
}

describe('supplement sqlite sidecar', () => {
  test('writes sidecar metadata and supports attached distinct/shared property queries', () => {
    const baseConcepts = makeBaseConcepts(48);
    const base = {
      system: 'http://example.org/base',
      version: '1',
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20', 'd8'],
      urlRoot: 'http://example.org/fhir/CodeSystem/test-dice',
      version: '1',
      salt: 'sidecar-test',
    });
    const d20 = bundle.find(item => item.die === 'd20').resource;
    const d8 = bundle.find(item => item.die === 'd8').resource;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supp-sidecar-'));
    const d20Path = path.join(dir, 'd20.supp.db');
    const d8Path = path.join(dir, 'd8.supp.db');
    try {
      writeSupplementSidecar(d20Path, d20);
      writeSupplementSidecar(d8Path, d8);

      const meta = readSupplementSidecarMeta(d20Path);
      expect(meta.url).toBe(d20.url);
      expect(meta.target_system).toBe(base.system);
      expect(meta.target_version).toBe(base.version);

      const db = buildRuntimeSqliteV0Db({ concepts: baseConcepts }, { csId: 1, propertyDefs: new Map() });
      try {
        db.exec(`ATTACH DATABASE '${d20Path.replace(/'/g, "''")}' AS supp20`);
        db.exec(`ATTACH DATABASE '${d8Path.replace(/'/g, "''")}' AS supp8`);

        const d20Rolls = literalValuesByCode(d20, 'd20-roll');
        const damage20 = literalValuesByCode(d20, 'damage-type');
        const damage8 = literalValuesByCode(d8, 'damage-type');

        const expectedCrit20 = [...d20Rolls.entries()]
          .filter(([, values]) => values.includes('20'))
          .map(([code]) => code)
          .sort();
        const crit20 = db.prepare(`
          SELECT c.code
            FROM concept c
            JOIN supp20.supplement_literal sl
              ON sl.source_code = c.code
             AND sl.property_code = 'd20-roll'
             AND sl.value_num = 20
           WHERE c.cs_id = 1
           ORDER BY c.code
        `).all().map(row => row.code);
        expect(crit20).toEqual(expectedCrit20);

        const targetCode = baseConcepts.find(concept => {
          const d20Damage = damage20.get(concept.code)?.[0];
          const d8DamageValue = damage8.get(concept.code)?.[0];
          const d20Roll = d20Rolls.get(concept.code)?.[0];
          return d20Damage && d8DamageValue && d20Damage !== d8DamageValue && d20Roll;
        })?.code;
        expect(targetCode).toBeTruthy();
        const wantedRoll = d20Rolls.get(targetCode)[0];
        const wantedDamage = damage8.get(targetCode)[0];

        const expectedMulti = baseConcepts
          .map(concept => concept.code)
          .filter(code =>
            d20Rolls.get(code)?.includes(wantedRoll)
            && ((damage20.get(code) || []).includes(wantedDamage) || (damage8.get(code) || []).includes(wantedDamage))
          )
          .sort();

        const multi = db.prepare(`
          WITH all_damage AS (
            SELECT source_code, value_text
              FROM supp20.supplement_literal
             WHERE property_code = 'damage-type'
            UNION ALL
            SELECT source_code, value_text
              FROM supp8.supplement_literal
             WHERE property_code = 'damage-type'
          )
          SELECT DISTINCT c.code
            FROM concept c
            JOIN supp20.supplement_literal r20
              ON r20.source_code = c.code
             AND r20.property_code = 'd20-roll'
             AND r20.value_num = @roll
            JOIN all_damage dmg
              ON dmg.source_code = c.code
             AND dmg.value_text = @damage
           WHERE c.cs_id = 1
           ORDER BY c.code
        `).all({ roll: Number(wantedRoll), damage: wantedDamage }).map(row => row.code);

        expect(multi).toEqual(expectedMulti);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('can materialize a sidecar back into a supplement CodeSystem', () => {
    const baseConcepts = makeBaseConcepts(24);
    const base = {
      system: 'http://example.org/base',
      version: '1',
      name: 'Synthetic Base',
      codes: baseConcepts.map(c => ({ code: c.code })),
    };
    const bundle = buildDiceSupplementBundle(base, {
      dice: ['d20'],
      urlRoot: 'http://example.org/fhir/CodeSystem/test-dice',
      version: '1',
      salt: 'sidecar-roundtrip',
    });
    const d20 = bundle[0].resource;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supp-sidecar-rt-'));
    const dbPath = path.join(dir, 'd20.supp.db');
    try {
      writeSupplementSidecar(dbPath, d20);
      const restored = readSupplementSidecarCodeSystem(dbPath);
      expect(restored.url).toBe(d20.url);
      expect(restored.version).toBe(d20.version);
      expect(restored.jsonObj.supplements).toBe(d20.supplements);

      const source = d20.concept.find(concept =>
        (concept.property || []).some(prop => prop.code === 'd20-roll' && prop.valueInteger === 20)
      );
      expect(source).toBeTruthy();

      const restoredConcept = restored.getConceptByCode(source.code);
      expect(restoredConcept).toBeTruthy();
      expect((restoredConcept.property || []).some(
        prop => prop.code === 'd20-roll' && prop.valueInteger === 20
      )).toBe(true);
      expect((restoredConcept.designation || []).some(
        d => String(d.value || '').includes('critical success')
      )).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
