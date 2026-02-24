'use strict';

const Database = require('better-sqlite3');
const { SupplementContext } = require('./supplement-context');
const { VersionUtilities } = require('../../../../../library/version-utilities');

/**
 * SQLite-backed SupplementContext.
 *
 * Rationale:
 * - Primary high-volume supplement backend for v3.
 * - Supports batched predicate checks and batched decoration without materializing
 *   large supplement resources in memory.
 * - Exposes a native() handle so sqlite code system providers can negotiate and
 *   optionally push down supplement-aware filtering.
 *
 * Expected schema surface:
 * - supplement_property_by_code view/table
 * - supplement_designation_by_code view/table
 * - supplement_manifest table
 */
class SqliteSupplementContext extends SupplementContext {
  constructor(entries = [], opts = {}) {
    super();
    this.entries = Array.isArray(entries) ? entries : [];
    const canonicalList = [];
    for (const e of this.entries) {
      if (e?.canonical) canonicalList.push(e.canonical);
      if (e?.canonicalVersioned) canonicalList.push(e.canonicalVersioned);
    }
    this._canonicals = this._dedupeCanonicals(canonicalList);
    this._dbByPath = new Map();
    this._operators = this._dedupeCanonicals(
      opts.operators || ['=', 'in', 'exists']
    );
    for (const c of this._canonicals) {
      this.markResolved(c);
    }
  }

  canonicals() {
    return this._canonicals;
  }

  native(request = {}) {
    const providerId = request.providerId || null;
    if (providerId && providerId !== 'sqlite') return null;
    const system = request.system || '';
    const version = request.version || null;
    const entries = this._entriesFor(system, version);
    if (entries.length === 0) return null;

    const properties = new Set();
    const operators = new Set();
    for (const e of entries) {
      for (const p of e.availableProperties || []) properties.add(String(p));
      for (const o of e.availableOperators || this._operators) operators.add(String(o));
    }

    return {
      kind: 'sqlite',
      complete: true,
      availableProperties: [...properties],
      availableOperators: [...operators],
      attachments: entries.map((e, i) => ({
        alias: `supp${i + 1}`,
        path: e.path,
        canonical: e.canonical,
        canonicalVersioned: e.canonicalVersioned || null,
        targetSystem: e.targetSystem || null,
        targetVersion: e.targetVersion || null,
      })),
    };
  }

  /**
   * Predicate preparation for supplement property clauses.
   * Returns batchHas(codes[]) so caller can avoid per-candidate DB fan-out.
   */
  async preparePredicate(request = {}) {
    const clause = request.clause || null;
    const system = request.system || '';
    const version = request.version || null;
    if (!clause || !clause.property || !clause.op) return null;

    const op = String(clause.op);
    if (!['=', 'in', 'exists'].includes(op)) return null;
    const property = String(clause.property);

    const entries = this._entriesFor(system, version)
      .filter(e => !Array.isArray(e.availableProperties) || e.availableProperties.includes(property));
    if (entries.length === 0) return null;

    for (const c of this._canonicals) this.markUsed(c, 'filter');

    if (op === 'exists') {
      const want = String(clause.value ?? 'true').toLowerCase() !== 'false';
      return {
        batchHas: async (codes) => {
          const keep = new Array(codes.length).fill(false);
          if (!Array.isArray(codes) || codes.length === 0) return keep;
          const codeSet = new Set(codes.map(c => String(c)));
          const found = new Set();
          for (const e of entries) {
            const db = this._openDb(e.path);
            const rows = this._queryPropertyRows(db, property, codeSet);
            for (const r of rows) {
              found.add(String(r.code || ''));
            }
          }
          return codes.map(code => want ? found.has(String(code)) : !found.has(String(code)));
        },
      };
    }

    const wantedSet = op === '='
      ? new Set([String(clause.value ?? '')])
      : new Set(String(clause.value ?? '').split(',').map(s => s.trim()).filter(Boolean));
    if (wantedSet.size === 0) {
      return { batchHas: async (codes) => new Array(codes.length).fill(false) };
    }

    return {
      batchHas: async (codes) => {
        const keep = new Array(codes.length).fill(false);
        if (!Array.isArray(codes) || codes.length === 0) return keep;
        const codeSet = new Set(codes.map(c => String(c)));
        const matching = new Set();
        for (const e of entries) {
          const db = this._openDb(e.path);
          const rows = this._queryPropertyRows(db, property, codeSet);
          for (const r of rows) {
            const code = String(r.code || '');
            if (!code) continue;
            const values = rowValuesAsStrings(r);
            if (values.some(v => wantedSet.has(v))) {
              matching.add(code);
            }
          }
        }
        return codes.map(code => matching.has(String(code)));
      },
    };
  }

  /**
   * Batched decoration overlay from sqlite supplement tables/views.
   */
  async decorateMany(request = {}) {
    const codes = Array.isArray(request?.codes)
      ? request.codes.map(c => String(c || '')).filter(Boolean)
      : [];
    if (codes.length === 0) return new Map();

    const system = request.system || '';
    const version = request.version || null;
    const opts = request?.opts || {};
    const includeDesignations = opts.includeDesignations === true;
    const requestedProps = Array.isArray(opts.properties)
      ? opts.properties.map(p => String(p || '')).filter(Boolean)
      : [];
    const allProps = requestedProps.includes('*');
    const includeProps = allProps || requestedProps.length > 0;

    const entries = this._entriesFor(system, version);
    if (entries.length === 0) return new Map();
    for (const c of this._canonicals) this.markUsed(c, 'decorate');

    const byCode = new Map();
    const codeSet = new Set(codes);
    const propertyFilter = allProps ? null : new Set(requestedProps);
    for (const entry of entries) {
      const db = this._openDb(entry.path);
      if (includeDesignations) {
        const designationRows = this._queryDesignationRows(db, codeSet);
        for (const row of designationRows) {
          const code = String(row.code || '');
          if (!code) continue;
          if (!byCode.has(code)) byCode.set(code, { code, designations: [], properties: [] });
          const target = byCode.get(code);
          if (!target.display && (Number(row.preferred) === 1 || String(row.designation || '').toLowerCase() === 'display')) {
            target.display = String(row.val || '');
          }
          target.designations.push({
            value: String(row.val || ''),
            language: row.language_code ? String(row.language_code) : null,
            use: {
              system: row.designation_system ? String(row.designation_system) : undefined,
              code: row.designation ? String(row.designation) : undefined,
            },
          });
        }
      }
      if (includeProps) {
        const propRows = this._queryPropertyRows(db, null, codeSet);
        for (const row of propRows) {
          const propCode = String(row.property || '');
          if (!propCode) continue;
          if (propertyFilter && !propertyFilter.has(propCode)) continue;
          const code = String(row.code || '');
          if (!code) continue;
          if (!byCode.has(code)) byCode.set(code, { code, designations: [], properties: [] });
          const target = byCode.get(code);
          const p = rowToProperty(row);
          if (p) target.properties.push(p);
        }
      }
    }

    for (const row of byCode.values()) {
      if (Array.isArray(row.designations) && row.designations.length === 0) delete row.designations;
      if (Array.isArray(row.properties) && row.properties.length === 0) delete row.properties;
    }
    return byCode;
  }

  async close() {
    for (const db of this._dbByPath.values()) {
      try {
        db.close();
      } catch (_e) {
        // ignore close failure
      }
    }
    this._dbByPath.clear();
  }

  _entriesFor(system, version) {
    if (!system) return [];
    return this.entries.filter(e => {
      if (!e || e.targetSystem !== system) return false;
      if (!e.targetVersion || !version) return true;
      if (e.targetVersion === version) return true;
      try {
        return VersionUtilities.versionMatches(e.targetVersion, version)
          || VersionUtilities.versionMatches(version, e.targetVersion);
      } catch (_e) {
        return false;
      }
    });
  }

  _openDb(dbPath) {
    if (this._dbByPath.has(dbPath)) return this._dbByPath.get(dbPath);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this._dbByPath.set(dbPath, db);
    return db;
  }

  _queryPropertyRows(db, property, codeSet) {
    const codes = [...codeSet].map(c => String(c)).filter(Boolean);
    if (codes.length === 0) return [];
    const placeholders = codes.map(() => '?').join(',');
    const sql = property ? `
      SELECT code, value_type, value_string, value_code, value_decimal, value_integer, value_boolean
      FROM supplement_property_by_code
      WHERE active = 1
        AND property = ?
        AND code IN (${placeholders})
    ` : `
      SELECT code, property, value_type, value_string, value_code, value_decimal, value_integer, value_boolean
      FROM supplement_property_by_code
      WHERE active = 1
        AND code IN (${placeholders})
    `;
    return property ? db.prepare(sql).all(property, ...codes) : db.prepare(sql).all(...codes);
  }

  _queryDesignationRows(db, codeSet) {
    const codes = [...codeSet].map(c => String(c)).filter(Boolean);
    if (codes.length === 0) return [];
    const placeholders = codes.map(() => '?').join(',');
    const sql = `
      SELECT code, designation, designation_system, language_code, val, preferred
      FROM supplement_designation_by_code
      WHERE active = 1
        AND code IN (${placeholders})
    `;
    return db.prepare(sql).all(...codes);
  }

  _dedupeCanonicals(input) {
    const out = [];
    const seen = new Set();
    for (const x of input || []) {
      const c = String(x || '');
      if (!c || seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
    return out;
  }
}

function rowValuesAsStrings(r) {
  const out = [];
  if (r.value_string != null) out.push(String(r.value_string));
  if (r.value_code != null) out.push(String(r.value_code));
  if (r.value_integer != null) out.push(String(r.value_integer));
  if (r.value_decimal != null) out.push(String(r.value_decimal));
  if (r.value_boolean != null) out.push(Number(r.value_boolean) === 1 ? 'true' : 'false');
  return out;
}

function rowToProperty(r) {
  const propCode = String(r?.property || '');
  if (!propCode) return null;
  const valueType = String(r?.value_type || '').toLowerCase();
  const p = { code: propCode };
  if (valueType === 'code' && r?.value_code != null) p.valueCode = String(r.value_code);
  else if (valueType === 'integer' && r?.value_integer != null) p.valueInteger = Number(r.value_integer);
  else if (valueType === 'decimal' && r?.value_decimal != null) p.valueDecimal = Number(r.value_decimal);
  else if (valueType === 'boolean' && r?.value_boolean != null) p.valueBoolean = Number(r.value_boolean) === 1;
  else if (r?.value_string != null) p.valueString = String(r.value_string);
  else if (r?.value_code != null) p.valueCode = String(r.value_code);
  else if (r?.value_integer != null) p.valueInteger = Number(r.value_integer);
  else if (r?.value_decimal != null) p.valueDecimal = Number(r.value_decimal);
  else if (r?.value_boolean != null) p.valueBoolean = Number(r.value_boolean) === 1;
  else return null;
  return p;
}

module.exports = {
  SqliteSupplementContext,
};
