/*
  eslint-disable no-unused-vars
 */
// @ts-check

const assert = require('assert');
const https = require('https');
const csApi = require('./cs-api');
const CodeSystemProvider = /** @type {any} */ (csApi.CodeSystemProvider);
const CodeSystemFactoryProvider = /** @type {any} */ (csApi.CodeSystemFactoryProvider);

/** @typedef {string | HGVSCode | null | undefined} HGVSContextInput */
/** @typedef {{valid: boolean, message: string}} HGVSValidationResult */
/** @typedef {{total: number, current: number, more(): boolean, next(): number}} EmptyIterator */

class HGVSCode {
  /**
   * @param {string} code - HGVS code
   */
  constructor(code) {
    this.code = code;
  }
}

class HGVSServices extends CodeSystemProvider {
  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   */
  constructor(opContext, supplements) {
    super(opContext, supplements);
  }

  // Metadata methods
  system() {
    return 'http://varnomen.hgvs.org';
  }

  version() {
    return '2.0';
  }

  description() {
    return 'HGVS validator';
  }

  name() {
    return 'HGVS validator';
  }

  async totalCount() {
    return 0; // No enumerable codes
  }

  specialEnumeration() {
    return null;
  }

  defaultToLatest() {
    return true;
  }

  // Core concept methods
  /**
   * @param {HGVSContextInput} context - HGVS context
   * @returns {Promise<string | null>} HGVS code
   */
  async code(context) {
    
    if (context instanceof HGVSCode) {
      return context.code;
    }
    return null;
  }

  /**
   * @param {HGVSContextInput} context - HGVS context
   * @returns {Promise<string | null>} Display string
   */
  async display(context) {
    
    return this.code(context);
  }

  /**
   * @param {HGVSContextInput} context - HGVS context
   * @returns {Promise<string>} Definition
   */
  async definition(context) {
    void context;
    return '';
  }

  /**
   * @param {HGVSContextInput} context - HGVS context
   * @returns {Promise<boolean>} Whether abstract
   */
  async isAbstract(context) {
    void context;
    
    return false;
  }

  /**
   * @param {HGVSContextInput} context - HGVS context
   * @returns {Promise<boolean>} Whether inactive
   */
  async isInactive(context) {
    void context;
    
    return false;
  }

  /**
   * @param {HGVSContextInput} context - HGVS context
   * @returns {Promise<boolean>} Whether deprecated
   */
  async isDeprecated(context) {
    void context;
    
    return false;
  }

  /**
   * @param {HGVSContextInput} context - HGVS context
   * @param {any} displays - Designation collector
   * @returns {Promise<void>}
   */
  async designations(context, displays) {

    if (context instanceof HGVSCode) {
      displays.addDesignation(true, 'active', '', null, context.code);

      // Add supplement designations
      this._listSupplementDesignations(context.code, displays);
    }
  }

  /**
   * @param {HGVSContextInput} ctxt - HGVS context
   * @param {any[]} props - Lookup properties
   * @param {any} params - Parameters resource
   * @returns {Promise<void>}
   */
  async extendLookup(ctxt, props, params) {
    void ctxt;
    void props;
    void params;
    
    // No additional properties to add for HGVS codes
  }

  // Lookup methods - this is the main functionality
  /**
   * @param {string | null | undefined} code - HGVS code
   * @returns {Promise<{context: HGVSCode | null, message: string | null | undefined}>} Locate result
   */
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    try {
      const result = await this.#validateHGVSCode(code);

      if (result.valid) {
        return {
          context: new HGVSCode(code),
          message: null
        };
      } else {
        return {
          context: null,
          message: result.message || undefined
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Error validating HGVS code: ${message}`);
    }
  }

  /**
   * @param {string} code - HGVS code
   * @returns {Promise<HGVSValidationResult>} Validation result
   */
  async #validateHGVSCode(code) {
    return new Promise((resolve, reject) => {
      const url = `https://clinicaltables.nlm.nih.gov/fhir/R4/CodeSystem/hgvs/$validate-code?code=${encodeURIComponent(code)}`;

      const request = https.get(url, { timeout: 5000 }, (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          try {
            const json = /** @type {any} */ (JSON.parse(data));
            let valid = false;
            let message = '';

            if (!json.resourceType) {
              message = 'Invalid response format';
            } else if (json.resourceType == 'OperationOutcome') {
              message = json.issue?.[0]?.details?.text || 'Unknown error';
            } else if (json.resourceType == 'Parameters') {
              // Parse the FHIR Parameters response
              if (json.parameter && Array.isArray(json.parameter)) {
                for (const param of json.parameter) {
                  if (param.name === 'result' && param.valueBoolean) {
                    valid = true;
                  } else if (param.name === 'message' && param.valueString) {
                    if (message) message += ', ';
                    message += param.valueString;
                  }
                }
              }
            } else {
              message = 'Invalid response resource type: ' + json.resourceType;
            }

            resolve({ valid, message });
          } catch (parseError) {
            const message = parseError instanceof Error ? parseError.message : String(parseError);
            reject(new Error(`Error parsing HGVS response: ${message}`));
          }
        });
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error('HGVS validation request timed out'));
      });

      request.on('error', (error) => {
        reject(new Error(`HGVS validation request failed: ${error.message}`));
      });
    });
  }

  /**
   * @param {HGVSContextInput} code - Child code
   * @param {HGVSContextInput} parent - Parent code
   * @param {boolean} [disallowParent] - Whether parent itself is disallowed
   * @returns {Promise<null>} No hierarchy support
   */
  async locateIsA(code, parent, disallowParent = false) {
    void code;
    void parent;
    void disallowParent;
    
    return null; // No hierarchy support
  }

  // Iterator methods - not supported
  /**
   * @param {HGVSContextInput} context - HGVS context
   * @returns {Promise<EmptyIterator>} Empty iterator
   */
  async iterator(context) {
    void context;
    
    // Return empty iterator
    /** @type {EmptyIterator} */
    const iterator = {
      total: 0,
      current: 0,
      more: () => false,
      next: () => iterator.current++
    };
    return iterator;
  }

  /**
   * @param {EmptyIterator} iteratorContext - Iterator state
   * @returns {Promise<null>} No next context
   */
  async nextContext(iteratorContext) {
    
    iteratorContext.next();
    return null;
  }

  // Filter support - not supported
  /**
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<boolean>} Whether filter is supported
   */
  async doesFilter(prop, op, value) {
    void prop;
    void op;
    void value;
    
    return false;
  }

  /**
   * @param {boolean} iterate - Whether preparing for iteration
   * @returns {Promise<never>} Always unsupported
   */
  async getPrepContext(iterate) {
    void iterate;
    
    throw new Error('Filters are not supported for HGVS');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {boolean} forIteration - Whether filter is for iteration
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<never>} Always unsupported
   */
  async filter(filterContext, forIteration, prop, op, value) {
    void filterContext;
    void forIteration;
    void prop;
    void op;
    void value;
    
    throw new Error('Filters are not supported for HGVS');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @returns {Promise<never>} Always unsupported
   */
  async prepare(filterContext) {
    void filterContext;
    
    throw new Error('Filters are not supported for HGVS');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @returns {Promise<never>} Always unsupported
   */
  async executeFilters(filterContext) {
    void filterContext;
    
    throw new Error('Filters are not supported for HGVS');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {any} set - Filter set
   * @returns {Promise<never>} Always unsupported
   */
  async filterSize(filterContext, set) {
    void filterContext;
    void set;
    
    throw new Error('Filters are not supported for HGVS');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {any} set - Filter set
   * @returns {Promise<never>} Always unsupported
   */
  async filterMore(filterContext, set) {
    void filterContext;
    void set;
    
    throw new Error('Filters are not supported for HGVS');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {any} set - Filter set
   * @returns {Promise<never>} Always unsupported
   */
  async filterConcept(filterContext, set) {
    void filterContext;
    void set;
    
    throw new Error('Filters are not supported for HGVS');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {any} set - Filter set
   * @param {string} code - Concept code
   * @returns {Promise<never>} Always unsupported
   */
  async filterLocate(filterContext, set, code) {
    void filterContext;
    void set;
    void code;
    
    throw new Error('Filters are not supported for HGVS');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {any} set - Filter set
   * @param {HGVSContextInput} concept - Concept
   * @returns {Promise<never>} Always unsupported
   */
  async filterCheck(filterContext, set, concept) {
    void filterContext;
    void set;
    void concept;
    
    throw new Error('Filters are not supported for HGVS');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @returns {Promise<never>} Always unsupported
   */
  async filterFinish(filterContext) {
    void filterContext;
    
    throw new Error('Filters are not supported for HGVS');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @returns {Promise<boolean>} Whether filters are open-ended
   */
  async filtersNotClosed(filterContext) {
    void filterContext;
    
    return false;
  }

  // Subsumption testing - not supported
  /**
   * @param {HGVSContextInput} codeA - First code
   * @param {HGVSContextInput} codeB - Second code
   * @returns {Promise<never>} Always unsupported
   */
  async subsumesTest(codeA, codeB) {
    void codeA;
    void codeB;
    
    throw new Error('Subsumption is not supported for HGVS');
  }

  // Other methods
  /**
   * @param {any} card - CDS card
   * @param {any} langList - Language list
   * @param {string} baseURL - Base URL
   * @param {string} code - Concept code
   * @param {string} display - Display
   * @returns {Promise<void>}
   */
  async getCDSInfo(card, langList, baseURL, code, display) {
    void card;
    void langList;
    void baseURL;
    void code;
    void display;
    
    // No CDS info for HGVS
  }

  /**
   * @param {any[]} features - Feature list
   * @returns {Promise<void>}
   */
  async defineFeatures(features) {
    void features;
    
    // No special features
  }


  versionAlgorithm() {
    return null;
  }
}

class HGVSServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param {any} i18n - I18n support
   */
  constructor(i18n) {
    super(i18n);
    this.uses = 0;
  }

  defaultVersion() {
    return '2.0';
  }

  // Metadata methods
  system() {
    return 'http://varnomen.hgvs.org';
  }

  version() {
    return '2.0';
  }

  /**
   * @param {string} url - ValueSet URL
   * @param {string | null | undefined} version - ValueSet version
   * @returns {Promise<null>} No known ValueSet
   */
  async buildKnownValueSet(url, version) {
    void url;
    void version;
    return null;
  }

  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @returns {Promise<HGVSServices>} HGVS services
   */
  async build(opContext, supplements) {
    this.recordUse();
    return new HGVSServices(opContext, supplements);
  }

  static checkService() {
    // Simple check - just return that it's available
    // In practice, you might want to test the external service
    return 'OK (External validation service)';
  }

  name() {
    return 'HGVS validator';
  }


  id() {
    return "hgvs";
  }
}

module.exports = {
  HGVSServices,
  HGVSServicesFactory,
  HGVSCode
};
