'use strict';

const Types = require('./sqlite-v0-plan-types');

function normalizedSearchConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    return {
      sources: ['display', 'designation'],
      activeOnly: true,
      designationActiveOnly: true,
      literalActiveOnly: true,
    };
  }
  return {
    sources: Array.isArray(cfg.sources) ? cfg.sources : ['display', 'designation'],
    activeOnly: cfg.activeOnly !== false,
    designationActiveOnly: cfg.designationActiveOnly !== false,
    literalActiveOnly: cfg.literalActiveOnly !== false,
  };
}

function activeConceptSet(scope = null, meta = null) {
  const origin = Types.normalizeOrigin({ paths: meta?.path ? [String(meta.path)] : [] });
  return Types.fromRows({
    scope,
    rows: Types.rowFilter({
      input: Types.rowScan({ table: 'concept', scope, origin, meta }),
      predicate: { kind: 'activeEquals', value: true },
      origin,
      meta,
    }),
    key: 'concept_id',
    origin,
    meta,
  });
}

function searchMatchSet(scope = null, text, cfg, meta = null) {
  const origin = Types.normalizeOrigin({ paths: meta?.path ? [String(meta.path)] : [] });
  return Types.fromRows({
    scope,
    rows: Types.rowSearch({
      scope,
      text,
      spec: {
        sources: Array.isArray(cfg.sources) ? [...cfg.sources] : ['display', 'designation'],
        activeOnlyConcepts: cfg.activeOnly !== false,
        designationActiveOnly: cfg.designationActiveOnly !== false,
        literalActiveOnly: cfg.literalActiveOnly !== false,
      },
      origin,
      meta,
    }),
    key: 'concept_id',
    origin,
    meta,
  });
}

function buildSelectionPlan(basePlan, selectionOpts = {}, runtime = {}) {
  const scope = Types.normalizeScope(basePlan?.scope || null);
  let plan = basePlan || Types.emptySet({ scope });
  const meta = selectionOpts.meta || null;

  if (selectionOpts.activeOnly) {
    plan = Types.setIntersect({
      scope,
      items: [plan, activeConceptSet(scope, meta)],
      meta,
    });
  }

  const text = selectionOpts.text != null ? String(selectionOpts.text).trim() : '';
  if (text) {
    const searchCfg = normalizedSearchConfig(runtime?.search);
    plan = Types.setIntersect({
      scope,
      items: [plan, searchMatchSet(scope, text, searchCfg, meta)],
      meta,
    });
  }

  return plan;
}

module.exports = {
  buildSelectionPlan,
  normalizedSearchConfig,
};
