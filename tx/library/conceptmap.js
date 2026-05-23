// @ts-check

const {CanonicalResource} = require("./canonical-resource");
const {VersionUtilities} = require("../../library/version-utilities");
const {conceptMapToR5, conceptMapFromR5} = require("../xversion/xv-conceptmap");

/**
 * @typedef {import('../../types/fhirsmith').FhirResource & {
 *   group?: ConceptMapGroup[],
 *   sourceScopeUri?: string,
 *   sourceScopeCanonical?: string,
 *   targetScopeUri?: string,
 *   targetScopeCanonical?: string
 * }} ConceptMapResource
 */
/** @typedef {{source?: string, target?: string, element?: ConceptMapElement[]}} ConceptMapGroup */
/** @typedef {{code?: string, display?: string, target?: ConceptMapTarget[]}} ConceptMapElement */
/** @typedef {{code?: string, display?: string, equivalence?: string, relationship?: string, comment?: string}} ConceptMapTarget */
/** @typedef {{system: string, version?: string, code?: string}} CodingLike */
/** @typedef {{group: ConceptMapGroup, match: ConceptMapElement, target?: ConceptMapTarget}} TranslationMatch */
/** @typedef {{system?: string, code?: string, display?: string}} ConceptSummary */
/** @typedef {{targetSystem?: string, targetCode?: string, targetDisplay?: string, sourceSystem?: string, sourceCode?: string, sourceDisplay?: string, equivalence?: string, relationship?: string, comment?: string}} MappingSummary */

/**
 * Represents a FHIR ConceptMap resource with version conversion support
 * @class
 */
class ConceptMap extends CanonicalResource {


  /**
   * Creates a new ConceptMap instance
   * @param {ConceptMapResource} jsonObj - The JSON object containing ConceptMap data
   * @param {string} [fhirVersion='R5'] - FHIR version ('R3', 'R4', or 'R5')
   */
  constructor(jsonObj, fhirVersion = 'R5') {
    super(jsonObj, fhirVersion);
    // Convert to R5 format internally (modifies input for performance)
    this.jsonObj = /** @type {ConceptMapResource} */ (conceptMapToR5(jsonObj, fhirVersion));
    this.validate();
    this.id = this.jsonObj.id;
  }

  /**
   * @returns {ConceptMapResource} ConceptMap JSON object
   */
  get conceptMap() {
    return /** @type {ConceptMapResource} */ (this.jsonObj);
  }

  /**
   * Static factory method for convenience
   * @param {string} jsonString - JSON string representation of ConceptMap
   * @param {string} [version='R5'] - FHIR version ('R3', 'R4', or 'R5')
   * @returns {ConceptMap} New ConceptMap instance
   */
  static fromJSON(jsonString, version = 'R5') {
    return new ConceptMap(JSON.parse(jsonString), version);
  }

  /**
   * Returns JSON string representation
   * @param {string} [version='R5'] - Target FHIR version ('R3', 'R4', or 'R5')
   * @returns {string} JSON string
   */
  toJSONString(version = 'R5') {
    const outputObj = conceptMapFromR5(this.jsonObj, version);
    return JSON.stringify(outputObj);
  }

    /**
   * Gets the FHIR version this ConceptMap was loaded from
   * @returns {string} FHIR version ('R3', 'R4', or 'R5')
   */
  getFHIRVersion() {
    return this.fhirVersion;
  }

  /**
   * Validates that this is a proper ConceptMap resource
   * @throws {Error} If validation fails
   */
  validate() {
    const resource = this.conceptMap;

    if (!resource || typeof resource !== 'object') {
      throw new Error('Invalid ConceptMap: expected object');
    }

    if (resource.resourceType !== 'ConceptMap') {
      throw new Error(`Invalid ConceptMap: resourceType must be "ConceptMap", got "${resource.resourceType}"`);
    }

    if (!resource.url || typeof resource.url !== 'string') {
      throw new Error('Invalid ConceptMap: url is required and must be a string');
    }

    if (resource.name && typeof resource.name !== 'string') {
      throw new Error('Invalid ConceptMap: name must be a string if present');
    }

    if (!resource.status || typeof resource.status !== 'string') {
      throw new Error('Invalid ConceptMap: status is required and must be a string');
    }

    const validStatuses = ['draft', 'active', 'retired', 'unknown'];
    if (!validStatuses.includes(resource.status)) {
      throw new Error(`Invalid ConceptMap: status must be one of ${validStatuses.join(', ')}, got "${resource.status}"`);
    }

    // Validate identifier - should be array in R5 after conversion
    if (resource.identifier && !Array.isArray(resource.identifier)) {
      throw new Error('Invalid ConceptMap: identifier should be an array (converted from R3/R4 format)');
    }

    // Validate group structure if present
    if (resource.group && !Array.isArray(resource.group)) {
      throw new Error('Invalid ConceptMap: group must be an array if present');
    }

    // Validate group elements
    if (resource.group) {
      resource.group.forEach((group, groupIndex) => {
        if (group.element && !Array.isArray(group.element)) {
          throw new Error(`Invalid ConceptMap: group[${groupIndex}].element must be an array if present`);
        }

        if (group.element) {
          group.element.forEach((element, elementIndex) => {

            if (element.target && !Array.isArray(element.target)) {
              throw new Error(`Invalid ConceptMap: group[${groupIndex}].element[${elementIndex}].target must be an array if present`);
            }
          });
        }
      });
    }
  }

  /**
   * @param {string | null | undefined} sourceSystem - Source system URL
   * @param {string | null | undefined} sourceScope - Source scope URL
   * @param {string | null | undefined} targetScope - Target scope URL
   * @param {string | null | undefined} targetSystem - Target system URL
   * @returns {boolean} Whether this map can provide the translation
   */
  providesTranslation(sourceSystem, sourceScope, targetScope, targetSystem) {
    let source = this.sourceScope;
    let target = this.targetScope;
    if (this.canonicalMatches(source, sourceScope) && this.canonicalMatches(target, targetScope)) {
      return true;
    }
    for (let grp of this.jsonObj.group || []) {
      let source = grp.source;
      let target = grp.target;
      if (this.canonicalMatches(source, sourceSystem) && this.canonicalMatches(target, targetSystem)) {
        return true;
      }
    }
    return false;
  }

  /**
   * @param {CodingLike} coding - Source coding
   * @param {string | null | undefined} targetScope - Target scope URL
   * @param {string | null | undefined} targetSystem - Target system URL
   * @returns {TranslationMatch[]} Matching translations
   */
  listTranslations(coding, targetScope, targetSystem) {
    /** @type {TranslationMatch[]} */
    let result = [];
    let vurl = VersionUtilities.vurl(coding.system, coding.version);

    let all = this.canonicalMatches(targetScope, this.targetScope);
    for (const g of this.jsonObj.group || []) {
      const sourceOk = this.canonicalMatches(vurl, g.source);
      const targetOk = !targetSystem || this.canonicalMatches(targetSystem, g.target);
      if (all || (sourceOk && targetOk)) {
        for (const em of g.element || []) {
          if (em.code === coding.code) {
            let match = {
              group: g,
              match: em
            };
            result.push(match);
          }
        }
      }
    }
    return result;
  }

  /**
   * @param {CodingLike} coding - Target coding
   * @param {string | null | undefined} targetScope - Target scope URL
   * @param {string | null | undefined} sourceSystem - Source system URL
   * @returns {TranslationMatch[]} Matching reverse translations
   */
  listTranslationsReverse(coding, targetScope, sourceSystem) {
    /** @type {TranslationMatch[]} */
    let result = [];
    let vurl = VersionUtilities.vurl(coding.system, coding.version);

    let all = this.canonicalMatches(targetScope, this.targetScope);
    for (const g of this.jsonObj.group || []) {
      const targetOk = this.canonicalMatches(vurl, g.target);
      const sourceOk = !sourceSystem || this.canonicalMatches(sourceSystem, g.source);
      if (all || (sourceOk && targetOk)) {
        for (const em of g.element || []) {
          for (const tm of em.target || []) {
            if (tm.code === coding.code) {
              let match = {
                group: g,
                match: em,
                target: tm
              };
              result.push(match);
            }
          }
        }
      }
    }
    return result;
  }
    /**
   * Gets the source scope (R5) or source system (R3/R4)
   * @returns {string|undefined} Source scope/system
   */
  get sourceScope() {
    const resource = this.conceptMap;
    return resource.sourceScopeUri ? resource.sourceScopeUri : resource.sourceScopeCanonical;
  }

  /**
   * Gets the target scope (R5) or target system (R3/R4)
   * @returns {string|undefined} Target scope/system
   */
  get targetScope() {
    const resource = this.conceptMap;
    return resource.targetScopeUri ? resource.targetScopeUri : resource.targetScopeCanonical;
  }

  /**
   * Gets all mapping groups
   * @returns {ConceptMapGroup[]} Array of group objects
   */
  getGroups() {
    return this.conceptMap.group || [];
  }

  /**
   * Gets all source concepts across all groups
   * @returns {ConceptSummary[]} Array of {system, code, display} objects
   */
  getSourceConcepts() {
    /** @type {ConceptSummary[]} */
    const concepts = [];
    this.getGroups().forEach(group => {
      const system = group.source;
      if (group.element) {
        group.element.forEach(element => {
          concepts.push({
            system: system,
            code: element.code,
            display: element.display
          });
        });
      }
    });
    return concepts;
  }

  /**
   * Gets all target concepts across all groups
   * @returns {Array<ConceptSummary & {equivalence?: string, relationship?: string}>} Array of {system, code, display, equivalence/relationship} objects
   */
  getTargetConcepts() {
    /** @type {Array<ConceptSummary & {equivalence?: string, relationship?: string}>} */
    const concepts = [];
    this.getGroups().forEach(group => {
      const system = group.target;
      if (group.element) {
        group.element.forEach(element => {
          if (element.target) {
            element.target.forEach(target => {
              concepts.push({
                system: system,
                code: target.code,
                display: target.display,
                equivalence: target.equivalence,
                relationship: target.relationship
              });
            });
          }
        });
      }
    });
    return concepts;
  }

  /**
   * Finds mappings for a source concept
   * @param {string} sourceSystem - Source system URL
   * @param {string} sourceCode - Source concept code
   * @returns {MappingSummary[]} Array of target mappings
   */
  findMappings(sourceSystem, sourceCode) {
    /** @type {MappingSummary[]} */
    const mappings = [];
    this.getGroups().forEach(group => {
      if (group.source === sourceSystem && group.element) {
        const element = group.element.find(el => el.code === sourceCode);
        if (element && element.target) {
          element.target.forEach(target => {
            mappings.push({
              targetSystem: group.target,
              targetCode: target.code,
              targetDisplay: target.display,
              equivalence: target.equivalence,
              relationship: target.relationship,
              comment: target.comment
            });
          });
        }
      }
    });
    return mappings;
  }

  /**
   * Finds reverse mappings for a target concept
   * @param {string} targetSystem - Target system URL
   * @param {string} targetCode - Target concept code
   * @returns {MappingSummary[]} Array of source mappings
   */
  findReverseMappings(targetSystem, targetCode) {
    /** @type {MappingSummary[]} */
    const mappings = [];
    this.getGroups().forEach(group => {
      if (group.target === targetSystem && group.element) {
        group.element.forEach(element => {
          if (element.target) {
            const targetMatch = element.target.find(t => t.code === targetCode);
            if (targetMatch) {
              mappings.push({
                sourceSystem: group.source,
                sourceCode: element.code,
                sourceDisplay: element.display,
                equivalence: targetMatch.equivalence,
                relationship: targetMatch.relationship,
                comment: targetMatch.comment
              });
            }
          }
        });
      }
    });
    return mappings;
  }

  /**
   * Gets all unique source systems
   * @returns {string[]} Array of source system URLs
   */
  getSourceSystems() {
    /** @type {Set<string>} */
    const systems = new Set();
    this.getGroups().forEach(group => {
      if (group.source) {
        systems.add(group.source);
      }
    });
    return Array.from(systems);
  }

  /**
   * Gets all unique target systems
   * @returns {string[]} Array of target system URLs
   */
  getTargetSystems() {
    /** @type {Set<string>} */
    const systems = new Set();
    this.getGroups().forEach(group => {
      if (group.target) {
        systems.add(group.target);
      }
    });
    return Array.from(systems);
  }

  /**
   * Gets basic info about this concept map
   * @returns {Object} Basic information object
   */
  getInfo() {
    const resource = this.conceptMap;
    const groups = this.getGroups();
    const totalMappings = groups.reduce((sum, group) => {
      return sum + (group.element ? group.element.reduce((elSum, el) => {
        return elSum + (el.target ? el.target.length : 0);
      }, 0) : 0);
    }, 0);

    return {
      resourceType: resource.resourceType,
      url: resource.url,
      version: resource.version,
      name: resource.name,
      title: resource.title,
      status: resource.status,
      fhirVersion: this.fhirVersion,
      sourceScope: this.sourceScope,
      targetScope: this.targetScope,
      groupCount: groups.length,
      sourceSystems: this.getSourceSystems(),
      targetSystems: this.getTargetSystems(),
      totalMappings: totalMappings
    };
  }

  /**
   * @param {string | null | undefined} value - Versioned canonical value
   * @param {string | null | undefined} pattern - Versioned canonical pattern
   * @returns {boolean} Whether the canonical URLs and optional versions match
   */
  canonicalMatches(value, pattern) {
    if (!pattern || !value) {
      return false;
    }
    const { url: vu, version: vv } = VersionUtilities.splitCanonical(value);
    const { url: pu, version: pv } = VersionUtilities.splitCanonical(pattern);

    if (!vu || !pu || vu != pu) {
      return false;
    }
    if (!pv) {
      return true;
    }
    return Boolean(vv && VersionUtilities.versionMatchesByAlgorithm(
      pv,
      vv,
      VersionUtilities.guessVersionAlgorithmFromVersion(vv)
    ));
  }
}


module.exports = { ConceptMap };
