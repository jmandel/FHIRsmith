'use strict';

/**
 * tx/engine — IR-based ValueSet expansion engine.
 *
 * Compiles FHIR ValueSet definitions into an intermediate representation,
 * optimizes cross-import, and dispatches per-system subtrees to providers
 * via executeIR() (native on v0 SQLite) or LegacyIRAdapter (wraps any
 * CodeSystemProvider).
 */

const IR = require('./ir');
const { buildIRFromValueSet, buildIRFromCompose, buildComponentExpr } = require('./build-ir');
const { resolveImports, buildIRFromExpansion } = require('./resolve-imports');
const { optimize, flatten, collectSystems, projectToSystem, splitDiffRoot, flattenUnionToList } = require('./rewrite');
const membership = require('./membership');

const orchestrator = require('./orchestrator');

module.exports = {
  // IR constructors
  IR,

  // Compilation pipeline
  buildIRFromValueSet,
  buildIRFromCompose,
  buildComponentExpr,
  resolveImports,
  buildIRFromExpansion,
  optimize,
  flatten,

  // IR utilities
  collectSystems,
  projectToSystem,
  splitDiffRoot,
  flattenUnionToList,

  // Membership indexes
  ...membership,

  // Orchestrator
  ...orchestrator,
};
