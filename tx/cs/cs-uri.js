// @ts-check

const csApi = require('./cs-api');
const CodeSystemProvider = /** @type {any} */ (csApi.CodeSystemProvider);
const CodeSystemFactoryProvider = /** @type {any} */ (csApi.CodeSystemFactoryProvider);
const assert = require('assert');

/** @typedef {{property?: any[]}} SupplementConcept */

/**
 * Code system provider for URIs
 * This is a simple provider that treats any URI as a valid code
 * Uses strings directly as context since URIs have no additional metadata
 * Enhanced to support supplements for display and definition lookup
 */
class UriServices extends CodeSystemProvider {
  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   */
  constructor(opContext, supplements) {
    super(opContext, supplements);
  }

  // ============================================================================
  // Metadata for the code system
  // ============================================================================

  system() {
    return 'urn:ietf:rfc:3986'; // URI_URIs constant equivalent
  }

  version() {
    return null;
  }

  description() {
    return 'URIs';
  }

  totalCount() {
    return -1; // Infinite/unknown count
  }

  name() {
    return 'Internal URI services';
  }

  defLang() {
    return 'en';
  }

  /**
   * @param {any} languages - Requested languages
   * @returns {boolean} Whether displays are available
   */
  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    } else {
      return false; // URIs don't have displays by default
    }
  }

  hasParents() {
    return false; // URIs don't have hierarchy
  }

  // ============================================================================
  // Getting Information about concepts
  // ============================================================================

  /**
   * @param {string | null | undefined} code - URI code
   * @returns {Promise<string | null | undefined>} URI code
   */
  async code(code) {
    
    await this.#ensureContext(code);
    return code; // For URIs, the code is the context
  }

  /**
   * @param {string | null | undefined} code - URI code
   * @returns {Promise<string | null>} Display from supplements
   */
  async display(code) {
    
    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }
    return this._displayFromSupplements(ctxt);
  }

  /**
   * @param {string | null | undefined} code - URI code
   * @returns {Promise<null>} No default definitions
   */
  async definition(code) {
    
    await this.#ensureContext(code);
    return null; // URIs don't have definitions by default
  }

  /**
   * @param {string | null | undefined} code - URI code
   * @returns {Promise<boolean>} Whether the URI is abstract
   */
  async isAbstract(code) {
    
    await this.#ensureContext(code);
    return false; // URIs are not abstract
  }

  /**
   * @param {string | null | undefined} code - URI code
   * @returns {Promise<boolean>} Whether the URI is inactive
   */
  async isInactive(code) {
    
    await this.#ensureContext(code);
    return false; // URIs are not inactive
  }

  /**
   * @param {string | null | undefined} code - URI code
   * @returns {Promise<boolean>} Whether the URI is deprecated
   */
  async isDeprecated(code) {
    
    await this.#ensureContext(code);
    return false; // URIs are not deprecated
  }

  /**
   * @param {string | null | undefined} code - URI code
   * @param {any} displays - Designation collector
   * @returns {Promise<void>}
   */
  async designations(code, displays) {
    
    const ctxt = await this.#ensureContext(code);
    if (ctxt != null) {
      this._listSupplementDesignations(ctxt, displays);
    }
  }

  /**
   * @param {string | null | undefined} code - URI code
   * @returns {Promise<any[]>} Properties from supplements
   */
  async properties(code) {
    
    const ctxt = await this.#ensureContext(code);
    // Collect properties from all supplements
    /** @type {any[]} */
    let allProperties = [];

    if (this.supplements) {
      for (const supplement of this.supplements) {
        const concept = /** @type {SupplementConcept | null | undefined} */ (supplement.getConceptByCode(ctxt));  // Uses CodeSystem API
        if (concept && concept.property) {
          // Add all properties from this concept
          allProperties = allProperties.concat(concept.property);
        }
      }
    }

    return allProperties;
  }

  /**
   * @param {string | null | undefined} a - First URI
   * @param {string | null | undefined} b - Second URI
   * @returns {Promise<boolean>} Whether the URIs are identical
   */
  async sameConcept(a, b) {
    
    await this.#ensureContext(a);
    await this.#ensureContext(b);
    return a === b; // For URIs, direct string comparison
  }


  /**
   * @param {string | null | undefined} code - Candidate URI code
   * @returns {Promise<string | null | undefined>} URI context
   */
  async #ensureContext(code) {
    if (!code || typeof code === 'string') {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: "+ (typeof code));
  }

  // ============================================================================
  // Finding concepts
  // ============================================================================

  /**
   * @param {string | null | undefined} code - URI code
   * @returns {Promise<{context: string | null, message: string | null}>} Locate result
   */
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    // For URIs, any string is potentially valid
    // But we can check if it exists in supplements for better validation
    // but it doesn't make any difference...

    return {
      context: code, // Use the string directly as context
      message: null
    };
  }

  versionAlgorithm() {
    return null;
  }

  isNotClosed() {
    return true;
  }

  // ============================================================================
  // Filtering (not supported for URIs)
  // ============================================================================

  // nothing to declare

  // ============================================================================
  // Translations and concept maps
  // ============================================================================
}

/**
 * Factory for creating URI code system providers
 */
class UriServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param {any} i18n - I18n support
   */
  constructor(i18n) {
    super(i18n);
  }

  defaultVersion() {
    return null;
  }

  system() {
    return 'urn:ietf:rfc:3986'; // URI_URIs constant equivalent
  }

  version() {
    return null;
  }

  // eslint-disable-next-line no-unused-vars
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
   * @returns {Promise<UriServices>} URI services
   */
  async build(opContext, supplements) {
    this.recordUse();
    return new UriServices(opContext, supplements);
  }
  name() {
    return 'URI services';
  }


  id() {
    return "urls";
  }
}

module.exports = {
  UriServices,
  UriServicesFactory
};
