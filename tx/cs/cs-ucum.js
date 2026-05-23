/**
 * UCUM CodeSystem Provider
 * Implementation of CodeSystemProvider for UCUM (Unified Code for Units of Measure)
 */
// @ts-check

const csApi = require('./cs-api');
const FilterExecutionContext = /** @type {any} */ (csApi.FilterExecutionContext);
const CodeSystemFactoryProvider = /** @type {any} */ (csApi.CodeSystemFactoryProvider);
const ValueSet = require("../library/valueset");
const assert = require('assert');
const {UcumService} = require("../library/ucum-service");
const {validateArrayParameter, validateParameter, validateOptionalParameter} = require("../../library/utilities");
const {DesignationUse} = require("../library/designations");
const csBase = require("./cs-base");
const BaseCSServices = /** @type {any} */ (csBase.BaseCSServices);

/** @typedef {string | UcumContext | null | undefined} UcumContextInput */
/** @typedef {{context: UcumContext | null, message?: string | null}} UcumLocateResult */
/** @typedef {{code: string, display?: string, canonical?: string}} CommonUnitConcept */
/** @typedef {{url?: string, units: CommonUnitConcept[]}} CommonUnits */
/** @typedef {{feature: string, value: string}} CodeSystemFeature */

/**
 * UCUM provider context for concepts
 */
class UcumContext {
  /**
   * @param {string} code - UCUM code
   */
  constructor(code) {
    assert(typeof code === 'string', 'code must be string');
    this.code = code;
  }
}

/**
 * UCUM canonical unit filters
 */
class UcumFilter {
  /**
   * @param {string} canonical - Required canonical unit form
   */
  constructor(canonical = '') {
    this.canonical = canonical;
    this.cursor = -1; // Used for iteration
    /** @type {CommonUnitConcept[]} */
    this.codes = [];
  }
}

/**
 * UCUM CodeSystem Provider
 * Provides validation and lookup for UCUM unit expressions
 */
class UcumCodeSystemProvider extends BaseCSServices {
  /** @type {UcumService} */
  ucumService;
  /** @type {CommonUnits | null} */
  commonUnits;

  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @param {UcumService} ucumService - UCUM service
   * @param {CommonUnits | null} commonUnits - Common units enumeration
   */
  constructor(opContext, supplements, ucumService, commonUnits = null) {
    super(opContext, supplements);
    assert(ucumService != null && ucumService instanceof UcumService, 'ucumService must be a UcumService');
    validateOptionalParameter(commonUnits, 'commonUnits', Object);

    this.ucumService = ucumService;
    this.commonUnits = commonUnits;
  }


  // ========== Metadata Methods ==========

  system() {
    return 'http://unitsofmeasure.org'; // UCUM URI
  }

  version() {
    return this.ucumService.ucumIdentification().version;
  }

  description() {
    return 'Unified Code for Units of Measure (UCUM)';
  }

  name() {
    return 'UCUM';
  }

  totalCount() {
    return -1; // Unbounded due to grammar
  }

  /**
   * @returns {boolean} Whether the code system has parent relationships
   */
  hasParents() {
    return false; // No hierarchy in UCUM
  }

  contentMode() {
    return 'complete';
  }

  expandLimitation() {
    return 0; // No limitation
  }

  /**
   * @returns {string | null} Special enumeration ValueSet URL
   */
  specialEnumeration() {
    // Return URL of common units if available
    return this.commonUnits ? this.commonUnits.url || null : null;
  }

  /**
   * @param {any} languages - Requested languages
   * @returns {boolean} Whether displays are available
   */
  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }
    return langs.isEnglishOrNothing();
  }

  /**
   * @returns {CodeSystemFeature[]} Supported code system features
   */
  listFeatures() {
    return [
      {
        feature: `rest.Codesystem:${this.system()}.filter`,
        value: 'canonical:equals'
      }
    ];
  }

  // ========== Code Information Methods ==========

  /**
   * @param {UcumContextInput} code - UCUM code or context
   * @returns {Promise<string>} UCUM code
   */
  async code(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt.code;
  }

  /**
   * @param {UcumContextInput} code - UCUM code or context
   * @returns {Promise<string>} Display string
   */
  async display(code) {
    
    const ctxt = await this.#ensureContext(code);

    if (this.opContext.langs.isEnglishOrNothing()) {
      // Check for common units display first
      if (this.commonUnits) {
        for (const concept of this.commonUnits.units) {
          if (concept.code === ctxt.code && concept.display) {
            return concept.display.trim();
          }
        }
      }

      // Check supplements
      const supplementDisplay = this._displayFromSupplements(ctxt.code);
      if (supplementDisplay) {
        return supplementDisplay;
      }

      // Default to analysis
      return this.ucumService.analyse(ctxt.code);
    }

    // Non-English languages - check supplements first
    const supplementDisplay = this._displayFromSupplements(ctxt.code);
    if (supplementDisplay) {
      return supplementDisplay;
    }

    // Fall back to code per THO advice
    return ctxt.code;
  }

  /**
   * @param {UcumContextInput} code - UCUM code or context
   * @returns {Promise<null>} Definition, if any
   */
  async definition(code) {
    
    await this.#ensureContext(code);
    return null; // UCUM doesn't provide definitions
  }

  /**
   * @param {UcumContextInput} code - UCUM code or context
   * @returns {Promise<boolean>} Whether the concept is abstract
   */
  async isAbstract(code) {
    
    await this.#ensureContext(code);
    return false; // UCUM codes are not abstract
  }

  /**
   * @param {UcumContextInput} code - UCUM code or context
   * @returns {Promise<boolean>} Whether the concept is inactive
   */
  async isInactive(code) {
    
    await this.#ensureContext(code);
    return false; // We don't track inactive UCUM codes
  }

  /**
   * @param {UcumContextInput} code - UCUM code or context
   * @returns {Promise<boolean>} Whether the concept is deprecated
   */
  async isDeprecated(code) {
    
    await this.#ensureContext(code);
    return false; // We don't track deprecated UCUM codes
  }

  /**
   * @param {UcumContextInput} code - UCUM code or context
   * @param {any} displays - Designation collector
   * @returns {Promise<void>}
   */
  async designations(code, displays) {
    
    const ctxt = await this.#ensureContext(code);

    // Primary display (analysis)
    const analysis = this.ucumService.analyse(ctxt.code);
    displays.addDesignation(true, 'active', 'en', DesignationUse.DISPLAY, ctxt.code);
    displays.addDesignation(true, 'active', 'en', DesignationUse.SYNONYM, analysis);

    // Common unit display if available
    if (this.commonUnits) {
      for (const concept of this.commonUnits.units) {
        if (concept.code === ctxt.code && concept.display) {
          const display = concept.display.trim();
          if (display !== ctxt.code) {
            displays.addDesignation(false, 'active', 'en', DesignationUse.SYNONYM, display);
          }
        }
      }
    }

    // Add supplement designations
    this._listSupplementDesignations(ctxt.code, displays);
  }

  /**
   * @param {UcumContextInput} code - UCUM code or context
   * @returns {Promise<UcumContext>}
   */
  async #ensureContext(code) {
    if (code == null) {
      throw new Error('Empty code');
    }
    if (typeof code === 'string') {
      const result = await this.locate(code);
      if (!result.context) {
        throw new Error(result.message || `Invalid UCUM code: ${code}`);
      } else {
        return result.context;
      }
    }
    if (code instanceof UcumContext) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof code));
  }

  // ========== Lookup Methods ==========

  /**
   * @param {string | null | undefined} code - UCUM code
   * @returns {Promise<UcumLocateResult>} Located concept and status message
   */
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');

    if (!code) {
      return { context: null, message: 'Empty code' };
    }

    const validationResult = this.ucumService.validate(code);
    if (!validationResult) {
      return { context: new UcumContext(code), message: null };
    } else {
      return { context: null, message: validationResult };
    }
  }

  // ========== Filter Methods ==========

  /**
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<boolean>} Whether this filter is supported
   */
  async doesFilter(prop, op, value) {
    
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    // Support canonical unit filters
    return (prop === 'canonical' && op === '=');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {string} filter - Filter expression
   * @param {boolean} sort - Whether sorting was requested
   * @returns {Promise<never>}
   */
  async specialFilter(filterContext, filter, sort) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(filter && typeof filter === 'string', 'filter must be a non-null string');
    assert(typeof sort === 'boolean', 'sort must be a boolean');

    throw new Error('Special filter not presently implemented for UCUM');
    // const ucumFilter = new UcumFilterContext('');
    // filterContext.filters.push(ucumFilter);
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {boolean} forIteration - Whether the filter is for iteration
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<void>}
   */
  async filter(filterContext, forIteration, prop, op, value) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    if (prop !== 'canonical') {
      throw new Error(`Unsupported filter property: ${prop}`);
    }

    if (op !== '=') {
      throw new Error(`Unsupported filter operator for canonical: ${op}`);
    }

    const ucumFilter = new UcumFilter(value);
    filterContext.filters.push(ucumFilter);
    if (filterContext.forIterate) {
      if (!this.commonUnits) {
        throw new Error(`Cannot expand a UCUM filter unless the common units value set is available`);
      }
      /** @type {CommonUnitConcept[]} */
      const set = [];
      for (const concept of this.commonUnits.units) {
        try {
          if (concept.canonical === value) {
            set.push(concept);
          }
        } catch (error) {
          // nothing
        }
      }
      ucumFilter.codes = set;
    }
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @returns {Promise<UcumFilter[]>} Filters to execute
   */
  async executeFilters(filterContext) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return filterContext.filters;
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {UcumFilter} set - Filter set
   * @returns {Promise<number>} Number of filtered codes
   */
  async filterSize(filterContext, set) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof UcumFilter, 'set must be a UcumFilter');

    return set.codes.length;
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @returns {Promise<boolean>} Whether filters leave the set open
   */
  async filtersNotClosed(filterContext) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return true; // Grammar-based system is never closed
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {UcumFilter} set - Filter set
   * @returns {Promise<boolean>} Whether another concept is available
   */
  async filterMore(filterContext, set) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof UcumFilter, 'set must be a UcumFilter');

    set.cursor++;
    return set.cursor < set.codes.length;
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {UcumFilter} set - Filter set
   * @returns {Promise<UcumContext>} Current filtered concept
   */
  async filterConcept(filterContext, set) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof UcumFilter, 'set must be a UcumFilter');
    return new UcumContext(set.codes[set.cursor].code);
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {UcumFilter} set - Filter set
   * @param {string} code - UCUM code
   * @returns {Promise<UcumContext | string>} Matching context or rejection message
   */
  async filterLocate(filterContext, set, code) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof UcumFilter, 'set must be a UcumFilter');
    assert(typeof code === 'string', 'code must be non-null string');

    // Validate the code first
    const validationResult = this.ucumService.validate(code);
    if (validationResult) {
      return `Invalid UCUM code: ${validationResult}`;
    }

    if (!set.canonical) {
      // Special enumeration case - check if in common units
      if (this.commonUnits) {
        const found = this.commonUnits.units.find(concept => concept.code == code);
        if (found) {
          return new UcumContext(code);
        } else {
          return `Code ${code} is not in the common units enumeration`;
        }
      } else {
        return new UcumContext(code); // Valid code
      }
    } else {
      // Check canonical units
      try {
        const canonical = this.ucumService.getCanonicalUnits(code);
        if (canonical === set.canonical) {
          return new UcumContext(code);
        } else {
          return `Code ${code} has canonical form ${canonical}, not ${set.canonical} as required`;
        }
      } catch (error) {
        return `Error getting canonical form for ${code}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {UcumFilter} set - Filter set
   * @param {UcumContextInput} concept - UCUM code or context
   * @returns {Promise<boolean>} Whether the concept passes the filter
   */
  async filterCheck(filterContext, set, concept) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof UcumFilter, 'set must be a UcumFilter');

    const ctxt = await this.#ensureContext(concept);

    if (!set.canonical) {
      // Special enumeration case
      if (this.commonUnits) {
        return this.commonUnits.units.some(c => c.code === ctxt.code);
      }
      return true; // All valid codes are included
    } else {
      // Check canonical units
      try {
        const canonical = this.ucumService.getCanonicalUnits(ctxt.code);
        return canonical === set.canonical;
      } catch (error) {
        return false;
      }
    }
  }


  // ========== Not Iterator Methods: Cannot iterate UCUM codes ==========

  // ========== Additional Methods ==========

  /**
   * @param {UcumContextInput} a - First UCUM code or context
   * @param {UcumContextInput} b - Second UCUM code or context
   * @returns {Promise<boolean>} Whether both refer to the same concept
   */
  async sameConcept(a, b) {
    
    const codeA = await this.#ensureContext(a);
    const codeB = await this.#ensureContext(b);
    return codeA.code === codeB.code;
  }

  /**
   * @param {UcumContextInput} codeA - First UCUM code or context
   * @param {UcumContextInput} codeB - Second UCUM code or context
   * @returns {Promise<string>} Subsumption outcome
   */
  async subsumesTest(codeA, codeB) {

    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    return 'not-subsumed'; // No subsumption in UCUM
  }

  /**
   * @param {UcumContext} ctxt - UCUM context
   * @param {string[]} props - Requested property names
   * @param {any} params - Parameters object
   * @returns {Promise<void>}
   */
  async extendLookup(ctxt, props, params) {
    validateArrayParameter(props, 'props', String);
    validateArrayParameter(params, 'params', Object);


    if (this._hasProp(props, 'canonical', true)) {
      try {
        const canonical = this.ucumService.getCanonicalUnits(ctxt.code);
        // Add canonical property to params - implementation depends on your Parameters class
        if (params && typeof params.addProperty === 'function') {
          params.addProperty('canonical', canonical);
        }
      } catch (error) {
        // Ignore errors in canonical form calculation
      }
    }
  }

  versionAlgorithm() {
    return 'natural';
  }


  isNotClosed() {
    return true;
  }

  makeUseForSynonym() {
    return undefined;
  }
}

/**
 * Factory for creating UCUM CodeSystem providers
 */
class UcumCodeSystemFactory extends CodeSystemFactoryProvider {
  /**
   * @param {any} i18n - Translation support
   * @param {UcumService} ucumService - UCUM service
   * @param {ValueSet | null} commonUnitVS - Common units ValueSet
   */
  constructor(i18n, ucumService, commonUnitVS = null) {
    super(i18n);
    assert(ucumService != null && ucumService instanceof UcumService, 'ucumService must be a UcumService');
    assert(!commonUnitVS || commonUnitVS instanceof ValueSet, 'if provided, commonUnits must be a ValueSet');
    this.ucumService = ucumService;
    this.uses = 0;
    /** @type {CommonUnits | null} */
    this.commonUnits = null;

    if (commonUnitVS) {
      this.processCommonUnits(commonUnitVS);
    }
  }

  /**
   * @param {ValueSet} vs - Common units ValueSet
   * @returns {void}
   */
  processCommonUnits(vs) {
    validateParameter(vs, 'vs', ValueSet);
    if (vs) {
      this.commonUnits = { units : [] };
      this.commonUnits.url = vs.url;
      const concepts = /** @type {Array<{code: string, display?: string}>} */ (vs.jsonObj.compose.include[0].concept);
      for (const c of concepts) {
        /** @type {CommonUnitConcept} */
        const concept = { code: c.code, display : c.display };
        try {
          const canonical = this.ucumService.getCanonicalUnits(c.code);
          if (canonical) {
            concept.canonical = canonical;
          }
        } catch (err) {
          // nothing
        }
        this.commonUnits.units.push(concept);
      }
    } else {
      this.commonUnits = null;
    }
  }

  system() {
    return 'http://unitsofmeasure.org'; // UCUM URI
  }

  version() {
    return this.ucumService.ucumIdentification().getVersion();
  }

  /**
   * @param {string} url - ValueSet URL
   * @param {string | null | undefined} version - ValueSet version
   * @returns {Promise<null>}
   */
  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  defaultVersion() {
    if (this.ucumService && typeof this.ucumService.ucumIdentification === 'function') {
      const versionDetails = this.ucumService.ucumIdentification();
      return versionDetails ? versionDetails.getVersion() : '';
    }
    return '';
  }

  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @returns {UcumCodeSystemProvider} New provider
   */
  build(opContext, supplements) {
    this.recordUse();
    return new UcumCodeSystemProvider(opContext, supplements, this.ucumService, this.commonUnits);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  name() {
    return 'UCUM';
  }

  id() {
    return 'ucum';
  }
}

module.exports = {
  UcumCodeSystemProvider,
  UcumCodeSystemFactory,
  UcumContext,
  UcumFilter
};
