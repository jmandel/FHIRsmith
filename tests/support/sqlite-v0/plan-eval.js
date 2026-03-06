'use strict';

const { conceptIdsToCodes, interpretMembershipPlan } = require('../../../tx/cs/sqlite-v0-plan-interpret');
const { normalizeCodeList } = require('../terminology-model/normalize-results');

function evaluateSetPlanCodes(plan, model) {
  return normalizeCodeList(conceptIdsToCodes(interpretMembershipPlan(plan, model), model));
}

module.exports = {
  evaluateSetPlanCodes,
};
