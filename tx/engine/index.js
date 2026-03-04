'use strict';

/**
 * tx/engine — IR-based ValueSet expansion engine.
 *
 * Compiles FHIR ValueSet definitions into an intermediate representation,
 * optimizes cross-import, and dispatches per-system subtrees to executors
 * (legacy CodeSystemProvider adapter or SQLite v0 direct SQL).
 */

const IR = require('./ir');
const { buildIRFromValueSet, buildIRFromCompose, buildComponentExpr } = require('./build-ir');
const { resolveImports, buildIRFromExpansion } = require('./resolve-imports');
const { optimize, flatten, collectSystems, projectToSystem, splitDiffRoot, flattenUnionToList } = require('./rewrite');
const { ExpandEngine } = require('./engine');
const { LegacyExecutor } = require('./legacy-executor');
const { SqliteV0Executor } = require('./sqlite-v0-executor');
const membership = require('./membership');
const { IRExpandAdapter } = require('./expand-adapter');

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

  // Engine
  ExpandEngine,

  // Executors
  LegacyExecutor,
  SqliteV0Executor,

  // Adapter for existing expand worker
  IRExpandAdapter,

  // Membership indexes
  ...membership,
};
