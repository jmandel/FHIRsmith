'use strict';

const { membershipPlanStructuralForm, rowPlanStructuralForm } = require('./sqlite-v0-plan-normalize');
const { physicalPlanStructuralForm } = require('./sqlite-v0-physicalize');
const { sqlAstStructuralForm } = require('./sqlite-v0-sql-ast');
const { isTerminalPlan } = require('./sqlite-v0-plan-types');

function formatMembershipPlan(plan) {
  return formatValue(membershipPlanStructuralForm(plan));
}

function formatRowPlan(plan) {
  return formatValue(rowPlanStructuralForm(plan));
}

function formatPhysicalPlan(plan) {
  return formatValue(physicalPlanStructuralForm(plan));
}

function formatTerminalPlan(plan) {
  return formatValue(terminalPlanStructuralForm(plan));
}

function formatSqlAst(ast) {
  return formatValue(sqlAstStructuralForm(ast));
}

function terminalPlanStructuralForm(plan) {
  if (!isTerminalPlan(plan)) return null;
  switch (plan.kind) {
  case 'materializeConcepts':
    return {
      kind: 'materializeConcepts',
      columns: Array.isArray(plan.columns) ? [...plan.columns].map(String).sort() : [],
      includeTotal: plan.includeTotal === true,
      orderBy: Array.isArray(plan.orderBy) ? plan.orderBy.map(o => ({
        key: String(o?.key || ''),
        direction: String(o?.direction || '').toLowerCase(),
      })) : [],
      offset: Number.isInteger(plan.offset) ? plan.offset : 0,
      count: Number.isInteger(plan.count) ? plan.count : null,
      members: membershipPlanStructuralForm(plan.members),
    };
  case 'countMembers':
    return {
      kind: 'countMembers',
      members: membershipPlanStructuralForm(plan.members),
    };
  case 'probeMemberByCode':
    return {
      kind: 'probeMemberByCode',
      code: String(plan.code || ''),
      members: membershipPlanStructuralForm(plan.members),
    };
  default:
    return null;
  }
}

function formatValue(value, indent = '') {
  if (value == null) return `${indent}null`;
  if (typeof value !== 'object') return `${indent}${JSON.stringify(value)}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}[]`;
    return value.map(item => `${indent}- ${formatNested(item, indent)}`).join('\n');
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return `${indent}{}`;
  return keys.map(key => {
    const next = value[key];
    if (next == null || typeof next !== 'object') {
      return `${indent}${key}: ${JSON.stringify(next)}`;
    }
    return `${indent}${key}:\n${formatValue(next, `${indent}  `)}`;
  }).join('\n');
}

function formatNested(value, indent) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  const rendered = formatValue(value, `${indent}  `);
  return `\n${rendered}`;
}

module.exports = {
  formatMembershipPlan,
  formatPhysicalPlan,
  formatRowPlan,
  formatTerminalPlan,
  formatSqlAst,
  terminalPlanStructuralForm,
};
