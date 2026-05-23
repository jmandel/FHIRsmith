
// @ts-check

/** @typedef {{system?: string, version?: string, concept?: Array<{code?: string}>}} ValueSetInclude */
/** @typedef {{include?: ValueSetInclude[]}} ValueSetCompose */
/** @typedef {{count: number}} ConceptUsage */
/** @typedef {Record<string, Set<string>>} VersionUsageMap */
/** @typedef {{jsonObj: {compose?: ValueSetCompose}}} ValueSetWrapper */
/**
 * @typedef {{
 *   valueSetProviders: Array<{
 *     listAllValueSets(): Promise<string[]>,
 *     fetchValueSet(url: string): Promise<ValueSetWrapper | null>
 *   }>
 * }} UsageLibraryLike
 */

class ConceptUsageTracker {

  constructor() {
    /** @type {Map<string, Map<string, ConceptUsage>>} */
    this.map = new Map();
  }

  /**
   * @param {UsageLibraryLike} library - Loaded terminology library
   * @returns {Promise<number>} Number of ValueSets containing explicit concepts
   */
  async scanValueSets(library) {
    let c = 0;
    for (let vsp of library.valueSetProviders) {
      let list = await vsp.listAllValueSets();
      for (let url of list) {
        let vs = await vsp.fetchValueSet(url);
        if (vs && vs.jsonObj.compose) {
          if (await this.scanValueSet(vs.jsonObj.compose)) {
            c++;
          }
        }
      }
    }
    return c;
  }

  /**
   * @param {ValueSetCompose} compose - ValueSet compose block
   * @param {VersionUsageMap} [versions] - Version references by system
   * @param {boolean} [active] - Whether to collect version references
   * @returns {Promise<boolean>} Whether any explicit concepts were seen
   */
  async scanValueSet(compose, versions, active) {
    let ok = false;
    for (let inc of compose.include || []) {
      if (inc.system) {
        if (active && versions && inc.version) {
          this.seeVersion(versions, inc.system, inc.version);
        }
        for (let c of inc.concept || []) {
          if (c.code) {
            ok = true;
            this.seeConcept(inc.system, c.code);
          }
        }
      }
    }
    return ok;
  }

  /**
   * @param {string} system - CodeSystem canonical URL
   * @param {string} code - Concept code
   * @returns {void}
   */
  seeConcept(system, code) {
    let cs = this.map.get(system);
    if (!cs) {
      cs = new Map();
      this.map.set(system, cs);
    }
    let ci = cs.get(code);
    if (!ci) {
      ci = { count : 0 }
      cs.set(code, ci);
    }
    ci.count++;
  }

  /**
   * @param {string} system - CodeSystem canonical URL
   * @returns {Map<string, ConceptUsage> | null} Usage map for the system
   */
  usages(system) {
    return this.map.get(system) || null;
  }

  /**
   * @param {VersionUsageMap} versions - Version references by system
   * @param {string} system - CodeSystem canonical URL
   * @param {string} version - Referenced version
   * @returns {void}
   */
  seeVersion(versions, system, version) {
    let set = versions[system];
    if (set == null) {
      set = new Set();
      versions[system] = set;
    }
    set.add(version);
  }
}

module.exports = ConceptUsageTracker;
