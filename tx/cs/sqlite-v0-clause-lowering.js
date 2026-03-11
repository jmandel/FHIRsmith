'use strict';

const Types = require('./sqlite-v0-plan-types');
const { resolveHierarchyDescriptor } = require('./sqlite-v0-hierarchy');
const { relevantSupplementBindings } = require('./sqlite-v0-supplements');

function ok(plan) {
  return { ok: true, plan };
}

function fail(reason, detail = null, meta = null) {
  return {
    ok: false,
    reason: String(reason || 'unsupported'),
    detail: detail || null,
    meta: meta || null,
  };
}

function splitFilterValueList(value) {
  if (!value) return [];
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function resolveInValueSetUrl(runtime, value) {
  const implicitVs = runtime?.filters?.concept?.implicitValueSets;
  if (implicitVs && typeof implicitVs === 'object') {
    for (const prefix of Object.keys(implicitVs)) {
      if (String(value || '').startsWith(prefix)) return String(value);
    }
  }
  return String(value || '');
}

function resolveFilterConfig(property, propDef, runtime) {
  const filtersCfg = runtime?.filters?.properties;
  if (!filtersCfg) {
    return {
      sources: propDef.value_kind === 'concept' ? ['link'] : ['literal'],
      linkMatch: 'code-only',
      aliases: null,
      normalizeCase: false,
    };
  }

  const byCode = filtersCfg.byCode || {};
  const specific = byCode[property] || null;
  const defaultSources = Array.isArray(filtersCfg.defaultSources)
    ? filtersCfg.defaultSources
    : (propDef.value_kind === 'concept' ? ['link'] : ['literal']);
  const sources = Array.isArray(specific?.sources) && specific.sources.length > 0
    ? specific.sources
    : defaultSources;
  const linkMatch = specific?.linkMatch || filtersCfg.defaultLinkMatch || 'code-only';
  const valueCfg = { ...(filtersCfg.defaultValue || {}), ...(specific?.value || {}) };
  return {
    sources: [...new Set((sources || []).filter(s => s === 'literal' || s === 'link'))],
    linkMatch,
    aliases: valueCfg.aliases || null,
    normalizeCase: !!valueCfg.normalizeCase,
  };
}

function availableFilterSources(property, propDef, supplementBindings = []) {
  const sources = new Set();
  if (Number.isInteger(propDef?.property_id)) {
    sources.add(propDef.value_kind === 'concept' ? 'link' : 'literal');
  }
  if (relevantSupplementBindings(supplementBindings, property, { valueKind: 'literal' }).length > 0) {
    sources.add('literal');
  }
  if (relevantSupplementBindings(supplementBindings, property, { valueKind: 'concept' }).length > 0) {
    sources.add('link');
  }
  return sources;
}

function normalizeFilterValues(values, filterCfg) {
  return values.map(v => {
    const raw = String(v || '');
    if (filterCfg.aliases) {
      const lower = raw.toLowerCase();
      if (filterCfg.aliases[lower] !== undefined) return String(filterCfg.aliases[lower]);
      if (filterCfg.aliases[raw] !== undefined) return String(filterCfg.aliases[raw]);
    }
    if (filterCfg.normalizeCase) {
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    }
    return raw;
  }).filter(Boolean);
}

function clauseScope(clause, scope = null) {
  return Types.normalizeScope(scope);
}

function clauseOrigin(clause) {
  const nodeIds = [];
  if (clause?.nodeId) nodeIds.push(String(clause.nodeId));
  const paths = [];
  if (clause?.meta?.path) paths.push(String(clause.meta.path));
  return Types.normalizeOrigin({ nodeIds, paths });
}

function conceptScan(scope, origin, meta) {
  return Types.rowScan({ table: 'concept', scope, origin, meta });
}

function literalScan(scope, origin, meta) {
  return Types.rowScan({ table: 'concept_literal', scope, origin, meta });
}

function linkScan(scope, origin, meta) {
  return Types.rowScan({ table: 'concept_link', scope, origin, meta });
}

function valueSetMemberScan(scope, origin, meta) {
  return Types.rowScan({ table: 'value_set_member', scope, origin, meta });
}

function literalMatchSet({ scope, origin, meta, property, values }) {
  return Types.fromRows({
    scope,
    rows: Types.rowFilter({
      input: literalScan(scope, origin, meta),
      predicate: {
        kind: 'literalPropertyMatch',
        property: String(property || ''),
        values: [...new Set((values || []).map(String).filter(Boolean))].sort(),
      },
      origin,
      meta,
    }),
    key: 'source_concept_id',
    origin,
    meta,
  });
}

function literalExistsSet({ scope, origin, meta, property }) {
  return Types.fromRows({
    scope,
    rows: Types.rowFilter({
      input: literalScan(scope, origin, meta),
      predicate: {
        kind: 'literalPropertyExists',
        property: String(property || ''),
      },
      origin,
      meta,
    }),
    key: 'source_concept_id',
    origin,
    meta,
  });
}

function linkMatchSet({ scope, origin, meta, property, values, linkMatch }) {
  return Types.fromRows({
    scope,
    rows: Types.rowFilter({
      input: linkScan(scope, origin, meta),
      predicate: {
        kind: 'linkPropertyMatch',
        property: String(property || ''),
        values: [...new Set((values || []).map(String).filter(Boolean))].sort(),
        linkMatch: String(linkMatch || 'code-only'),
      },
      origin,
      meta,
    }),
    key: 'source_concept_id',
    origin,
    meta,
  });
}

function linkExistsSet({ scope, origin, meta, property }) {
  return Types.fromRows({
    scope,
    rows: Types.rowFilter({
      input: linkScan(scope, origin, meta),
      predicate: {
        kind: 'linkPropertyExists',
        property: String(property || ''),
      },
      origin,
      meta,
    }),
    key: 'source_concept_id',
    origin,
    meta,
  });
}

function lowerFilterClauseToSetPlan(clause, propertyDefs, runtime, opts = {}) {
  const property = String(clause?.property || '');
  const op = String(clause?.op || '');
  const value = clause?.value != null ? String(clause.value) : '';
  const meta = clause?.meta || null;
  const scope = clauseScope(clause, opts.scope || null);
  const origin = clauseOrigin(clause);

  if (property === 'concept') {
    if (op === '=') {
      return ok(Types.explicitCodes({
        scope,
        codes: [value],
        origin,
        meta,
      }));
    }
    if (op === 'is-a' || op === 'descendent-of') {
      const descriptor = resolveHierarchyDescriptor(property, op, propertyDefs, runtime);
      if (!descriptor) return fail('unsupported-hierarchy-filter', { property, op, value }, meta);
      return ok(Types.fromRows({
        scope,
        rows: Types.rowReachability({
          relation: descriptor,
          seed: Types.explicitCodes({
            scope,
            codes: [value],
            origin,
            meta,
          }),
          direction: 'down',
          includeSelf: op === 'is-a' ? descriptor.includeSelfForIsA !== false : false,
          origin,
          meta,
        }),
        key: 'concept_id',
        origin,
        meta,
      }));
    }
    if (op === 'in') {
      return ok(Types.fromRows({
        scope,
        rows: Types.rowFilter({
          input: valueSetMemberScan(scope, origin, meta),
          predicate: {
            kind: 'valueSetUrlEq',
            url: resolveInValueSetUrl(runtime, value),
          },
          origin,
          meta,
        }),
        key: 'concept_id',
        origin,
        meta,
      }));
    }
    return fail('unsupported-concept-filter', { property, op, value }, meta);
  }

  if (property === 'code' && op === 'regex') {
    return ok(Types.fromRows({
      scope,
      rows: Types.rowFilter({
        input: conceptScan(scope, origin, meta),
        predicate: {
          kind: 'codeRegex',
          pattern: value,
        },
        origin,
        meta,
      }),
      key: 'concept_id',
      origin,
      meta,
    }));
  }

  const propDef = propertyDefs.get(property);
  if (!propDef) return fail('unknown-property', { property, op, value }, meta);

  if (op === 'is-a' || op === 'descendent-of') {
    const descriptor = resolveHierarchyDescriptor(property, op, propertyDefs, runtime);
    if (!descriptor) return fail('unsupported-hierarchy-filter', { property, op, value }, meta);
    return ok(Types.fromRows({
      scope,
      rows: Types.rowReachability({
        relation: descriptor,
        seed: Types.explicitCodes({
          scope,
          codes: [value],
          origin,
          meta,
        }),
        direction: 'down',
        includeSelf: op === 'is-a' ? descriptor.includeSelfForIsA !== false : false,
        origin,
        meta,
      }),
      key: 'concept_id',
      origin,
      meta,
    }));
  }

  const filterCfg = resolveFilterConfig(property, propDef, runtime);
  const availableSources = availableFilterSources(property, propDef, opts.supplementBindings || []);
  const activeSources = (filterCfg.sources || []).filter(source => availableSources.has(source));
  if (op === '=' || op === 'in') {
    const rawValues = op === 'in' ? splitFilterValueList(value) : [value];
    const values = normalizeFilterValues(rawValues, filterCfg);
    if (values.length === 0) {
      return ok(Types.emptySet({ scope, origin, meta }));
    }
    if (!Array.isArray(filterCfg.sources) || filterCfg.sources.length === 0) {
      return fail('no-filter-sources', { property, op, value }, meta);
    }
    if (activeSources.length === 0) {
      return ok(Types.emptySet({ scope, origin, meta }));
    }

    const items = [];
    if (activeSources.includes('literal')) {
      items.push(literalMatchSet({ scope, origin, meta, property, values }));
    }
    if (activeSources.includes('link')) {
      items.push(linkMatchSet({ scope, origin, meta, property, values, linkMatch: filterCfg.linkMatch }));
    }
    if (items.length === 0) return fail('no-filter-sources', { property, op, value }, meta);
    if (items.length === 1) return ok(items[0]);
    return ok(Types.setUnion({ scope, items, origin, meta }));
  }

  if (op === 'regex') {
    if (!filterCfg.sources.includes('literal')) {
      return fail('regex-requires-literal-source', { property, op, value }, meta);
    }
    if (!activeSources.includes('literal')) {
      return ok(Types.emptySet({ scope, origin, meta }));
    }
    return ok(Types.fromRows({
      scope,
      rows: Types.rowFilter({
        input: literalScan(scope, origin, meta),
        predicate: {
          kind: 'literalPropertyRegex',
          property: String(property || ''),
          pattern: value,
        },
        origin,
        meta,
      }),
      key: 'source_concept_id',
      origin,
      meta,
    }));
  }

  if (op === 'exists') {
    const wantExists = String(value || '') === 'true'
      ? true
      : (String(value || '') === 'false' ? false : null);
    if (wantExists == null) {
      return fail('invalid-exists-value', { property, op, value }, meta);
    }

    const items = [];
    if (activeSources.includes('literal')) {
      items.push(literalExistsSet({ scope, origin, meta, property }));
    }
    if (activeSources.includes('link')) {
      items.push(linkExistsSet({ scope, origin, meta, property }));
    }

    const existsSet = items.length === 0
      ? Types.emptySet({ scope, origin, meta })
      : (items.length === 1 ? items[0] : Types.setUnion({ scope, items, origin, meta }));

    return ok(wantExists
      ? existsSet
      : Types.setDiff({
          scope,
          left: Types.allConcepts({ scope, origin, meta }),
          right: existsSet,
          origin,
          meta,
        }));
  }

  return fail('unsupported-property-filter', { property, op, value }, meta);
}

function analyzeFilterClauseSupport(clause, propertyDefs, runtime, opts = {}) {
  const lowered = lowerFilterClauseToSetPlan(clause, propertyDefs, runtime, opts);
  if (lowered.ok) {
    return {
      supported: true,
      reason: null,
      detail: null,
      meta: clause?.meta || null,
    };
  }
  return {
    supported: false,
    reason: lowered.reason,
    detail: lowered.detail,
    meta: lowered.meta,
  };
}

function supportsFilterClause(clause, propertyDefs, runtime, opts = {}) {
  return analyzeFilterClauseSupport(clause, propertyDefs, runtime, opts).supported;
}

module.exports = {
  analyzeFilterClauseSupport,
  fail,
  lowerFilterClauseToMembershipPlan: lowerFilterClauseToSetPlan,
  lowerFilterClauseToSetPlan,
  normalizeFilterValues,
  ok,
  resolveFilterConfig,
  resolveInValueSetUrl,
  splitFilterValueList,
  supportsFilterClause,
};
