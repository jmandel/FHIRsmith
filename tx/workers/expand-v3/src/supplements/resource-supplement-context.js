'use strict';

const { SupplementContext } = require('./supplement-context');
const {
  SqliteNativeSupplementAdapter,
  buildResourceSupplementEntries,
} = require('./sqlite-native-supplement-adapter');

/**
 * Resource-backed SupplementContext.
 *
 * Rationale:
 * - Compatibility backend for in-memory CodeSystem supplements.
 * - Correctness-first fallback when native supplement backends are unavailable.
 * - Same interface as sqlite/native contexts so the engine and adapter can treat
 *   all supplement sources uniformly.
 */
class ResourceSupplementContext extends SupplementContext {
  constructor(supplements = [], opts = {}) {
    super();
    this.supplements = Array.isArray(supplements) ? supplements : [];
    this._entries = buildResourceSupplementEntries(this.supplements);
    this._propertyIndex = new Map();
    this._sqliteNativeAdapter = null;
    this._canonicals = this._dedupeCanonicals(
      opts.requiredCanonicals || this._entries.flatMap(e => [e.canonical, e.canonicalVersioned]).filter(Boolean)
    );
    for (const c of this._canonicals) this.markResolved(c);
  }

  canonicals() {
    return this._canonicals;
  }

  async preparePredicate({ clause }) {
    if (!clause || !clause.property || !clause.op) return null;
    const op = String(clause.op);
    if (!['=', 'in', 'exists'].includes(op)) return null;

    const propertyCode = String(clause.property);
    const propertyIndex = this._indexForProperty(propertyCode);
    if (!propertyIndex) return null;

    for (const c of this._canonicals) this.markUsed(c, 'filter');

    if (op === 'exists') {
      const want = String(clause.value).toLowerCase() !== 'false';
      return {
        batchHas: async (codes) => codes.map(code => {
          const vals = propertyIndex.get(String(code));
          const has = !!(vals && vals.length > 0);
          return want ? has : !has;
        }),
      };
    }

    if (op === '=') {
      const wanted = String(clause.value ?? '');
      return {
        batchHas: async (codes) => codes.map(code => {
          const vals = propertyIndex.get(String(code));
          if (!vals || vals.length === 0) return false;
          return vals.includes(wanted);
        }),
      };
    }

    // op === 'in'
    const set = new Set(String(clause.value ?? '').split(',').map(s => s.trim()).filter(Boolean));
    return {
      batchHas: async (codes) => codes.map(code => {
        const vals = propertyIndex.get(String(code));
        if (!vals || vals.length === 0) return false;
        for (const v of vals) {
          if (set.has(v)) return true;
        }
        return false;
      }),
    };
  }

  /**
   * Build batched decoration overlays from resource supplements.
   * This is intentionally page-sized and request-scoped.
   */
  async decorateMany(request = {}) {
    const codes = Array.isArray(request?.codes)
      ? request.codes.map(c => String(c || '')).filter(Boolean)
      : [];
    if (codes.length === 0) return new Map();

    const codeSet = new Set(codes);
    const byCode = new Map();
    const includeDesignations = request?.opts?.includeDesignations === true;
    const includeProps = Array.isArray(request?.opts?.properties)
      ? request.opts.properties.length > 0
      : false;

    for (const supp of this.supplements) {
      if (!supp || typeof supp.getConceptByCode !== 'function') continue;
      const canonical = supp?.vurl || supp?.url || null;
      if (canonical) this.markUsed(canonical, 'decorate');

      for (const code of codeSet) {
        const concept = supp.getConceptByCode(code);
        if (!concept) continue;
        if (!byCode.has(code)) byCode.set(code, { code, designations: [], properties: [] });
        const row = byCode.get(code);

        if (concept.display) {
          row.display = String(concept.display);
        }

        if (includeDesignations) {
          if (concept.display) {
            row.designations.push({
              value: String(concept.display),
              language: supp?.jsonObj?.language || null,
              use: { system: 'http://terminology.hl7.org/CodeSystem/designation-usage', code: 'display' },
            });
          }
          if (Array.isArray(concept.designation)) {
            for (const d of concept.designation) row.designations.push({ ...d });
          }
        }

        if (includeProps && Array.isArray(concept.property)) {
          for (const p of concept.property) row.properties.push({ ...p });
        }
        const itemWeight = readItemWeight(concept);
        if (itemWeight != null) {
          row.properties.push({ code: 'weight', valueDecimal: Number(itemWeight) });
        }
      }
    }

    for (const row of byCode.values()) {
      if (Array.isArray(row.designations) && row.designations.length === 0) delete row.designations;
      if (Array.isArray(row.properties) && row.properties.length === 0) delete row.properties;
    }
    return byCode;
  }

  /**
   * Native bridge for sqlite providers.
   *
   * Converts resource supplements into transient sqlite supplement artifacts so
   * query-target providers can handle supplement properties natively.
   */
  native(request = {}) {
    const providerId = request?.providerId || null;
    if (providerId && providerId !== 'sqlite') return null;
    if (!SqliteNativeSupplementAdapter.supported()) return null;
    if (!this._sqliteNativeAdapter) {
      this._sqliteNativeAdapter = new SqliteNativeSupplementAdapter(this._entries);
    }
    const handle = this._sqliteNativeAdapter.nativeHandle(request);
    if (handle?.attachments) {
      for (const att of handle.attachments) {
        if (att?.canonical) this.markUsed(att.canonical, 'native');
      }
    }
    return handle;
  }

  async close() {
    if (this._sqliteNativeAdapter) {
      this._sqliteNativeAdapter.close();
      this._sqliteNativeAdapter = null;
    }
  }

  _indexForProperty(propertyCode) {
    if (this._propertyIndex.has(propertyCode)) {
      return this._propertyIndex.get(propertyCode);
    }
    const byCode = new Map();
    for (const supp of this.supplements) {
      if (!supp || typeof supp.getAllConcepts !== 'function') continue;
      for (const concept of supp.getAllConcepts()) {
        const code = concept?.code;
        if (!code || !Array.isArray(concept?.property)) continue;
        for (const p of concept.property) {
          if (!p || String(p.code) !== propertyCode) continue;
          const value = readPropertyPrimitive(p);
          if (value == null) continue;
          if (!byCode.has(code)) byCode.set(code, []);
          byCode.get(code).push(String(value));
        }
      }
    }
    this._propertyIndex.set(propertyCode, byCode);
    return byCode;
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

function readPropertyPrimitive(p) {
  if (p.valueCode != null) return p.valueCode;
  if (p.valueString != null) return p.valueString;
  if (p.valueInteger != null) return p.valueInteger;
  if (p.valueBoolean != null) return p.valueBoolean;
  if (p.valueDecimal != null) return p.valueDecimal;
  if (p.valueUri != null) return p.valueUri;
  if (p.valueCanonical != null) return p.valueCanonical;
  if (p.valueDateTime != null) return p.valueDateTime;
  return null;
}

function readItemWeight(concept) {
  const exts = Array.isArray(concept?.extension) ? concept.extension : [];
  for (const ext of exts) {
    if (!ext || ext.url !== 'http://hl7.org/fhir/StructureDefinition/itemWeight') continue;
    if (ext.valueDecimal != null) return Number(ext.valueDecimal);
    if (ext.valueInteger != null) return Number(ext.valueInteger);
    if (ext.valueString != null) {
      const n = Number(ext.valueString);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

module.exports = {
  ResourceSupplementContext,
};
