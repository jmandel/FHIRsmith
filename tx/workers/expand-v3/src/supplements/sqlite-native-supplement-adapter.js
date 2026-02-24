'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
let Database = null;
try {
  Database = require('better-sqlite3');
} catch (_e) {
  Database = null;
}

const { VersionUtilities } = require('../../../../../library/version-utilities');

/**
 * SQLite-native supplement adapter for resource-backed supplements.
 *
 * Responsibility:
 * - Convert in-memory CodeSystem supplement resources into transient sqlite
 *   artifacts with the same schema surface expected by sqlite query providers.
 * - Expose nativeHandle({system,version}) for sqlite provider negotiation.
 */
class SqliteNativeSupplementAdapter {
  constructor(entries = []) {
    this.entries = Array.isArray(entries) ? entries : [];
    this._nativeSqliteByEntryKey = new Map();
    this._nativeSqliteTempDirs = new Set();
  }

  static supported() {
    return !!Database;
  }

  nativeHandle(request = {}) {
    if (!Database) return null;
    const system = String(request?.system || '');
    const version = request?.version == null ? null : String(request.version);
    const entries = this._entriesFor(system, version);
    if (entries.length === 0) return null;

    const attachments = [];
    const properties = new Set();
    const operators = new Set(['=', 'in', 'exists']);

    for (const entry of entries) {
      const artifact = this._ensureSqliteArtifact(entry);
      if (!artifact) continue;
      for (const p of artifact.availableProperties) properties.add(p);
      attachments.push({
        alias: `rsupp_${attachments.length + 1}`,
        path: artifact.path,
        canonical: entry.canonical || null,
        canonicalVersioned: entry.canonicalVersioned || null,
        targetSystem: entry.targetSystem || null,
        targetVersion: entry.targetVersion || null,
      });
    }

    if (attachments.length === 0) return null;
    return {
      kind: 'sqlite',
      complete: true,
      availableProperties: [...properties],
      availableOperators: [...operators],
      attachments,
    };
  }

  close() {
    for (const dir of this._nativeSqliteTempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_e) {
        // ignore cleanup errors
      }
    }
    this._nativeSqliteTempDirs.clear();
    this._nativeSqliteByEntryKey.clear();
  }

  _entriesFor(system, version) {
    const requestedSystem = String(system || '');
    const requestedVersion = version == null ? null : String(version);
    return this.entries.filter((e) => {
      if (!e?.targetSystem) return false;
      if (requestedSystem && e.targetSystem !== requestedSystem) return false;
      if (!e.targetVersion || !requestedVersion) return true;
      return VersionUtilities.supplementVersionMatches(e.targetVersion, requestedVersion);
    });
  }

  _ensureSqliteArtifact(entry) {
    const key = `${entry.canonicalVersioned || entry.canonical}|${entry.targetSystem || ''}|${entry.targetVersion || ''}`;
    if (this._nativeSqliteByEntryKey.has(key)) return this._nativeSqliteByEntryKey.get(key);
    const artifact = this._materializeSupplementToSqlite(entry);
    if (!artifact) return null;
    this._nativeSqliteByEntryKey.set(key, artifact);
    return artifact;
  }

  _materializeSupplementToSqlite(entry) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-supp-sqlite-'));
    const dbPath = path.join(dir, 'supplement.v0.db');
    const db = new Database(dbPath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE supplement_manifest (
          supplement_uri TEXT NOT NULL,
          supplement_version TEXT,
          target_system TEXT NOT NULL,
          target_version TEXT,
          generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE supplement_code (
          code_id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE
        );
        CREATE TABLE supplement_property (
          property_id INTEGER PRIMARY KEY AUTOINCREMENT,
          code_id INTEGER NOT NULL,
          property TEXT NOT NULL,
          value_type TEXT NOT NULL DEFAULT 'string',
          value_string TEXT,
          value_code TEXT,
          value_decimal REAL,
          value_integer INTEGER,
          value_boolean INTEGER,
          active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE supplement_designation (
          designation_id INTEGER PRIMARY KEY AUTOINCREMENT,
          code_id INTEGER NOT NULL,
          designation TEXT NOT NULL,
          designation_system TEXT,
          language_code TEXT,
          val TEXT NOT NULL,
          preferred INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1
        );
        CREATE VIEW supplement_property_by_code AS
        SELECT
          sc.code,
          sp.property,
          sp.value_type,
          sp.value_string,
          sp.value_code,
          sp.value_decimal,
          sp.value_integer,
          sp.value_boolean,
          sp.active
        FROM supplement_property sp
        JOIN supplement_code sc ON sc.code_id = sp.code_id;
        CREATE VIEW supplement_designation_by_code AS
        SELECT
          sc.code,
          sd.designation,
          sd.designation_system,
          sd.language_code,
          sd.val,
          sd.preferred,
          sd.active
        FROM supplement_designation sd
        JOIN supplement_code sc ON sc.code_id = sd.code_id;
        CREATE INDEX idx_supp_prop_property_code ON supplement_property(property, code_id);
        CREATE INDEX idx_supp_code_code ON supplement_code(code);
      `);

      db.prepare(`
        INSERT INTO supplement_manifest
          (supplement_uri, supplement_version, target_system, target_version)
        VALUES (?, ?, ?, ?)
      `).run(
        entry.canonical,
        entry.canonicalVersioned && entry.canonicalVersioned.includes('|')
          ? entry.canonicalVersioned.substring(entry.canonicalVersioned.indexOf('|') + 1)
          : null,
        entry.targetSystem || '',
        entry.targetVersion || null
      );

      const insCode = db.prepare(`INSERT INTO supplement_code(code) VALUES (?)`);
      const insProp = db.prepare(`
        INSERT INTO supplement_property
          (code_id, property, value_type, value_string, value_code, value_decimal, value_integer, value_boolean, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);
      const insDesig = db.prepare(`
        INSERT INTO supplement_designation
          (code_id, designation, designation_system, language_code, val, preferred, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `);

      const codeIdByCode = new Map();
      const availableProperties = new Set();
      const addCode = (code) => {
        const c = String(code || '');
        if (!c) return null;
        if (codeIdByCode.has(c)) return codeIdByCode.get(c);
        const r = insCode.run(c);
        const id = Number(r.lastInsertRowid);
        codeIdByCode.set(c, id);
        return id;
      };

      const concepts = entry.supplement.getAllConcepts();
      for (const concept of concepts || []) {
        const code = String(concept?.code || '');
        if (!code) continue;
        const codeId = addCode(code);
        if (!codeId) continue;

        if (concept?.display) {
          insDesig.run(
            codeId,
            'display',
            'http://terminology.hl7.org/CodeSystem/designation-usage',
            concept?.language || entry.language || null,
            String(concept.display),
            1
          );
        }
        for (const d of concept?.designation || []) {
          if (!d || d.value == null) continue;
          insDesig.run(
            codeId,
            d?.use?.code ? String(d.use.code) : 'designation',
            d?.use?.system ? String(d.use.system) : null,
            d?.language ? String(d.language) : null,
            String(d.value),
            0
          );
        }

        for (const p of concept?.property || []) {
          const propCode = String(p?.code || '');
          if (!propCode) continue;
          const value = toSupplementPropertyValue(p);
          if (!value) continue;
          availableProperties.add(propCode);
          insProp.run(
            codeId,
            propCode,
            value.valueType,
            value.valueString,
            value.valueCode,
            value.valueDecimal,
            value.valueInteger,
            value.valueBoolean
          );
        }
      }

      this._nativeSqliteTempDirs.add(dir);
      return {
        path: dbPath,
        dir,
        availableProperties: [...availableProperties],
      };
    } finally {
      db.close();
    }
  }
}

function buildResourceSupplementEntries(supplements = []) {
  const out = [];
  for (const supp of supplements || []) {
    if (!supp || typeof supp.getAllConcepts !== 'function') continue;
    const canonical = String(supp?.url || '');
    if (!canonical) continue;
    const canonicalVersioned = supp?.vurl
      ? String(supp.vurl)
      : (supp?.version ? `${canonical}|${String(supp.version)}` : null);
    const target = parseSupplementTarget(supp?.jsonObj?.supplements);
    const normalizedTargetVersion = target.version
      ? (VersionUtilities.normalizeVersionToken(target.version) || null)
      : null;
    out.push({
      supplement: supp,
      canonical,
      canonicalVersioned,
      targetSystem: target.system,
      targetVersion: normalizedTargetVersion,
      language: supp?.jsonObj?.language ? String(supp.jsonObj.language) : null,
    });
  }
  return out;
}

function parseSupplementTarget(raw) {
  const value = String(raw || '');
  if (!value) return { system: null, version: null };
  const idx = value.indexOf('|');
  if (idx < 0) return { system: value, version: null };
  const system = value.substring(0, idx);
  const version = value.substring(idx + 1) || null;
  return { system, version };
}

function toSupplementPropertyValue(p) {
  if (p?.valueCode != null) {
    return { valueType: 'code', valueString: null, valueCode: String(p.valueCode), valueDecimal: null, valueInteger: null, valueBoolean: null };
  }
  if (p?.valueInteger != null) {
    return { valueType: 'integer', valueString: null, valueCode: null, valueDecimal: null, valueInteger: Number(p.valueInteger), valueBoolean: null };
  }
  if (p?.valueDecimal != null) {
    return { valueType: 'decimal', valueString: null, valueCode: null, valueDecimal: Number(p.valueDecimal), valueInteger: null, valueBoolean: null };
  }
  if (p?.valueBoolean != null) {
    return { valueType: 'boolean', valueString: null, valueCode: null, valueDecimal: null, valueInteger: null, valueBoolean: p.valueBoolean ? 1 : 0 };
  }
  if (p?.valueString != null) {
    return { valueType: 'string', valueString: String(p.valueString), valueCode: null, valueDecimal: null, valueInteger: null, valueBoolean: null };
  }
  if (p?.valueUri != null) {
    return { valueType: 'string', valueString: String(p.valueUri), valueCode: null, valueDecimal: null, valueInteger: null, valueBoolean: null };
  }
  if (p?.valueCanonical != null) {
    return { valueType: 'string', valueString: String(p.valueCanonical), valueCode: null, valueDecimal: null, valueInteger: null, valueBoolean: null };
  }
  if (p?.valueDateTime != null) {
    return { valueType: 'string', valueString: String(p.valueDateTime), valueCode: null, valueDecimal: null, valueInteger: null, valueBoolean: null };
  }
  return null;
}

module.exports = {
  SqliteNativeSupplementAdapter,
  buildResourceSupplementEntries,
};
