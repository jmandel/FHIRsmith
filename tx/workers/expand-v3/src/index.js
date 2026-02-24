'use strict';

const {
  ValueSetExpander,
  ValueSetExpanderV3,
  ValueSetExpanderCompatV3,
  ExpandWorkerV3,
} = require('./expand-v3-worker');

module.exports = {
  // Default exports used by runtime callers
  ExpandWorker: ExpandWorkerV3,
  ValueSetExpander,

  // Native v3 exports
  ExpandWorkerV3,
  ValueSetExpanderV3,
  ValueSetExpanderCompatV3,

  // Engine internals (useful for unit tests)
  ir: require('./engine/ir'),
  buildIRFromValueSet: require('./engine/build-ir').buildIRFromValueSet,
  resolveImports: require('./engine/resolve-imports').resolveImports,
  rewrite: require('./engine/rewrite'),
  executeExpandV3: require('./engine/exec').executeExpandV3,

  // Provider adapters
  CsEngineAdapter: require('./providers/cs-provider-adapter').CsEngineAdapter,
};
