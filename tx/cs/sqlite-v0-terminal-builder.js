'use strict';

const Types = require('./sqlite-v0-plan-types');

function buildMaterializePlan(members, opts = {}) {
  return Types.materializeConcepts({
    members,
    columns: opts.columns,
    orderBy: opts.orderBy,
    offset: opts.offset,
    count: opts.count,
    includeTotal: opts.includeTotal === true,
    selection: {
      activeOnly: !!opts.activeOnly,
      text: opts.text != null ? String(opts.text) : null,
    },
    scope: opts.scope || null,
    origin: opts.origin || null,
    meta: opts.meta || null,
  });
}

function buildCountPlan(members, opts = {}) {
  return Types.countMembers({
    members,
    selection: {
      activeOnly: !!opts.activeOnly,
      text: opts.text != null ? String(opts.text) : null,
    },
    scope: opts.scope || null,
    origin: opts.origin || null,
    meta: opts.meta || null,
  });
}

function buildProbePlan(members, code, opts = {}) {
  return Types.probeMemberByCode({
    members,
    code,
    scope: opts.scope || null,
    origin: opts.origin || null,
    meta: opts.meta || null,
  });
}

module.exports = {
  buildCountPlan,
  buildMaterializePlan,
  buildProbePlan,
};
