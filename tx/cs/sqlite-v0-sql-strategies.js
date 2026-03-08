'use strict';

const {
  boundedMembershipUpperLimit,
  extractCodeRegexFilter,
  extractSingleSeedClosureReachability,
  extractSingleSeedClosureReachabilityCodeRegexIntersect,
  extractSingleSeedClosureReachabilityDiff,
  extractSingleSeedClosureReachabilityIntersect,
  extractSupplementLiteralMatchPredicates,
  supportsEarlyStopMaterialize,
} = require('./sqlite-v0-sql-patterns');

function chooseMaterializeStrategy(node, ctx) {
  if (node.includeTotal === true) return 'materialize-with-total';
  if (extractCodeRegexFilter(node.members)) return 'code-regex-materialize';
  if (extractSupplementLiteralMatchPredicates(node.members, ctx)?.length > 0) return 'supplement-literal-materialize';

  const text = node?.selection?.text != null ? String(node.selection.text).trim() : '';
  if (!text && extractSingleSeedClosureReachabilityCodeRegexIntersect(node.members)) {
    return 'reachability-code-regex-materialize';
  }
  if (!text && extractSingleSeedClosureReachabilityIntersect(node.members)) {
    return 'reachability-intersect-materialize';
  }
  if (!text && extractSingleSeedClosureReachabilityDiff(node.members)) {
    return 'reachability-diff-materialize';
  }
  if (supportsEarlyStopMaterialize(node.members) && isEarlyStopMaterializeNode(node)) {
    return 'early-stop-materialize';
  }
  if (!text && extractSingleSeedClosureReachability(node.members)) {
    return 'reachability-materialize';
  }
  return 'generic-materialize';
}

function chooseCountStrategy(node, ctx) {
  if (extractCodeRegexFilter(node.members)) return 'code-regex-count';
  if (extractSupplementLiteralMatchPredicates(node.members, ctx)?.length > 0) return 'supplement-literal-count';

  const text = node?.selection?.text != null ? String(node.selection.text).trim() : '';
  if (!text && extractSingleSeedClosureReachabilityCodeRegexIntersect(node.members)) {
    return 'reachability-code-regex-count';
  }
  if (!text && extractSingleSeedClosureReachabilityIntersect(node.members)) {
    return 'reachability-intersect-count';
  }
  if (!text && extractSingleSeedClosureReachabilityDiff(node.members)) {
    return 'reachability-diff-count';
  }
  if (!text && extractSingleSeedClosureReachability(node.members)) {
    return 'reachability-count';
  }
  if (text && shouldUseConceptDrivenCount(node.members)) {
    return 'concept-driven-count';
  }
  return 'generic-count';
}

function chooseTerminalLoweringStrategy(node, ctx) {
  switch (node?.kind) {
  case 'materialize':
  case 'materializeConcepts':
    return chooseMaterializeStrategy(node, ctx);
  case 'count':
  case 'countMembers':
    return chooseCountStrategy(node, ctx);
  case 'probe':
  case 'probeMemberByCode':
    return 'probe';
  default:
    return null;
  }
}

function isEarlyStopMaterializeNode(node) {
  const orderBy = Array.isArray(node?.orderBy) ? node.orderBy : [];
  if (!Number.isInteger(node?.count) || node.count <= 0 || node.count > 100) return false;
  if (Number.isInteger(node?.offset) && node.offset > 0) return false;
  if (orderBy.length !== 1) return false;
  if (String(orderBy[0]?.key || '') !== 'code') return false;
  if (String(orderBy[0]?.direction || 'asc').toLowerCase() !== 'asc') return false;
  return true;
}

function shouldUseConceptDrivenCount(members, ceiling = 32) {
  const bound = boundedMembershipUpperLimit(members, ceiling);
  return Number.isInteger(bound) && bound >= 0 && bound <= ceiling;
}

module.exports = {
  chooseCountStrategy,
  chooseMaterializeStrategy,
  chooseTerminalLoweringStrategy,
};
