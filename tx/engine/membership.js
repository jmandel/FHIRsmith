'use strict';

/**
 * Composable membership index types for ValueSet expansion.
 *
 * A MembershipIndex answers "is code X in this set?" without
 * necessarily materializing the full set. Different implementations
 * back this with different strategies:
 * - SetMembership: in-memory Set<string>
 * - FilterCheckMembership: wraps legacy provider filterCheck()
 * - LocateMembership: wraps provider locate() for whole-system checks
 * - SqlMembership: wraps a prepared better-sqlite3 EXISTS statement
 * - UnionMembership: any child returns true
 * - IntersectMembership: all children return true
 * - DiffMembership: left.has() && !right.has()
 * - EmptyMembership: always returns false
 * - UniversalMembership: always returns true
 */

class MembershipIndex {
  /** @param {string} code @returns {boolean} */
  has(code) { throw new Error('abstract'); }
  /** @param {string[]} codes @returns {boolean[]} */
  batchHas(codes) { return codes.map(c => this.has(c)); }
}

class EmptyMembership extends MembershipIndex {
  has(_code) { return false; }
  batchHas(codes) { return new Array(codes.length).fill(false); }
}

class UniversalMembership extends MembershipIndex {
  has(_code) { return true; }
  batchHas(codes) { return new Array(codes.length).fill(true); }
}

class SetMembership extends MembershipIndex {
  constructor(codeSet) {
    super();
    this._set = codeSet instanceof Set ? codeSet : new Set(codeSet);
  }
  has(code) { return this._set.has(code); }
}

/**
 * Wraps the legacy filter protocol's filterCheck() for lazy membership.
 * Keeps a live FilterConceptSet and uses filterCheck() for point queries
 * rather than materializing the full result.
 *
 * @param {CodeSystemProvider} cs - the provider instance
 * @param {object} prep - the FilterExecutionContext from getPrepContext()
 * @param {object} filterSet - a FilterConceptSet from executeFilters()
 *
 * Note: filterCheck() is declared async but is sync-safe in all current
 * providers (SNOMED: array scan, LOINC: binary search, FhirCS: identity check).
 * We call it synchronously here. If a provider genuinely needs async filterCheck,
 * it should be routed to the SQLite v0 executor instead.
 */
class FilterCheckMembership extends MembershipIndex {
  constructor(cs, prep, filterSet) {
    super();
    this._cs = cs;
    this._prep = prep;
    this._set = filterSet;
    this._locateCache = new Map();
  }
  has(code) {
    // Get or cache the context for this code
    let ctx = this._locateCache.get(code);
    if (ctx === undefined) {
      // locate() is async-declared but sync-safe in practice
      const located = this._cs.locate(code);
      // Handle both sync return and thenable (shouldn't happen but safe)
      if (located && typeof located.then === 'function') {
        throw new Error('FilterCheckMembership requires sync locate() - provider ' + this._cs.system() + ' returned a promise');
      }
      ctx = located?.context || null;
      this._locateCache.set(code, ctx);
    }
    if (!ctx) return false;
    const result = this._cs.filterCheck(this._prep, this._set, ctx);
    if (result && typeof result.then === 'function') {
      throw new Error('FilterCheckMembership requires sync filterCheck() - provider ' + this._cs.system() + ' returned a promise');
    }
    return result === true;
  }
}

/**
 * For 'whole' selectors: code is a member if it exists in the code system.
 */
class LocateMembership extends MembershipIndex {
  constructor(cs) {
    super();
    this._cs = cs;
    this._cache = new Map();
  }
  has(code) {
    let result = this._cache.get(code);
    if (result === undefined) {
      const located = this._cs.locate(code);
      if (located && typeof located.then === 'function') {
        throw new Error('LocateMembership requires sync locate()');
      }
      result = !!located?.context;
      this._cache.set(code, result);
    }
    return result;
  }
}

/**
 * For SQLite v0: wraps a prepared better-sqlite3 EXISTS statement.
 * The statement should accept { ...baseParams, _checkCode: code } and
 * return a row if the code is a member, or undefined if not.
 */
class SqlMembership extends MembershipIndex {
  constructor(stmt, baseParams) {
    super();
    this._stmt = stmt;
    this._params = baseParams;
  }
  has(code) {
    return !!this._stmt.get({ ...this._params, _checkCode: code });
  }
}

class UnionMembership extends MembershipIndex {
  constructor(children) {
    super();
    this._children = children;
  }
  has(code) {
    for (const child of this._children) {
      if (child.has(code)) return true;
    }
    return false;
  }
}

class IntersectMembership extends MembershipIndex {
  constructor(children) {
    super();
    this._children = children;
  }
  has(code) {
    for (const child of this._children) {
      if (!child.has(code)) return false;
    }
    return true;
  }
}

class DiffMembership extends MembershipIndex {
  constructor(left, right) {
    super();
    this._left = left;
    this._right = right;
  }
  has(code) {
    return this._left.has(code) && !this._right.has(code);
  }
}

module.exports = {
  MembershipIndex,
  EmptyMembership,
  UniversalMembership,
  SetMembership,
  FilterCheckMembership,
  LocateMembership,
  SqlMembership,
  UnionMembership,
  IntersectMembership,
  DiffMembership,
};
