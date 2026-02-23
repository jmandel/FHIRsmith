'use strict';

const { trace: T } = require('./expand-trace');

const canonical = (system, version) => version ? `${system}|${version}` : system;
const excludeKey = (system, version, code) => `${system}|${version || ''}#${code}`;

class ExclusionIndex {
  constructor(passesImports) {
    this._passesImports = passesImports;
    this._exact = new Set();
    this._predicates = [];
  }

  addExact(system, version, code) {
    this._exact.add(excludeKey(system, version, code));
  }

  addImportedPredicate(baseSet, imports, offset = 0) {
    if (!baseSet) return;
    this._predicates.push({ baseSet, imports: imports || null, offset });
  }

  has(system, version, code) {
    T.count('exclusion_exact_checks');
    if (this._exact.has(excludeKey(system, version, code))) {
      T.count('exclusion_exact_hits');
      return true;
    }
    for (const p of this._predicates) {
      T.count('exclusion_import_predicate_checks');
      if (!p.baseSet.hasCode(system, code)) continue;
      if (p.imports && !this._passesImports(p.imports, system, code, p.offset)) continue;
      T.count('exclusion_import_predicate_hits');
      return true;
    }
    return false;
  }

  isEmpty() {
    return this._exact.size === 0 && this._predicates.length === 0;
  }
}

class ExclusionEvaluator {
  constructor(passesImports) {
    this.index = new ExclusionIndex(passesImports);
    this.filterPredicates = new Map(); // "system|version" -> [{ cs, prep, filterSets }]
  }

  addExact(system, version, code) {
    this.index.addExact(system, version, code);
  }

  addImportedPredicate(baseSet, imports, offset = 0) {
    this.index.addImportedPredicate(baseSet, imports, offset);
  }

  has(system, version, code) {
    return this.index.has(system, version, code);
  }

  isEmpty() {
    return this.index.isEmpty();
  }

  registerFilterPredicate(cs, prep, filterSets) {
    const key = canonical(cs.system(), cs.version());
    if (!this.filterPredicates.has(key)) {
      this.filterPredicates.set(key, []);
    }
    this.filterPredicates.get(key).push({ cs, prep, filterSets: filterSets || [] });
  }

  async matchesFilterPredicates(cs, context) {
    const key = canonical(cs.system(), cs.version());
    const predicates = this.filterPredicates.get(key);
    if (!predicates || predicates.length === 0) return false;

    T.count('exclusion_filter_predicate_candidates');
    for (const p of predicates) {
      let ok = true;
      for (const set of p.filterSets) {
        T.count('exclusion_filter_predicate_checks');
        if (await p.cs.filterCheck(p.prep, set, context) !== true) {
          ok = false;
          break;
        }
      }
      if (ok) {
        T.count('exclusion_filter_predicate_hits');
        return true;
      }
    }
    return false;
  }
}

class ExclusionPolicyBuilder {
  constructor(passesImports) {
    this._passesImports = passesImports;
  }

  create() {
    return new ExclusionEvaluator(this._passesImports);
  }

  async buildFromPlan(plan, fallbackGroups, applyExclude) {
    const evaluator = this.create();
    const groups = Array.isArray(fallbackGroups) ? fallbackGroups : (plan?.groups || []);
    if (typeof applyExclude !== 'function') {
      return evaluator;
    }

    for (const group of groups) {
      for (const exclude of (group?.excludes || [])) {
        await applyExclude({ evaluator, group, exclude });
      }
    }
    return evaluator;
  }

  addExact(evaluator, system, version, code) {
    evaluator.addExact(system, version, code);
  }

  addImportedPredicate(evaluator, baseSet, imports, offset = 0) {
    evaluator.addImportedPredicate(baseSet, imports, offset);
  }

  registerFilterPredicate(evaluator, cs, prep, filterSets) {
    evaluator.registerFilterPredicate(cs, prep, filterSets);
  }
}

module.exports = {
  ExclusionPolicyBuilder,
  ExclusionEvaluator,
  ExclusionIndex,
};
