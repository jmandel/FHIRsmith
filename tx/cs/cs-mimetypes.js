// @ts-check

const csApi = require('./cs-api');
const CodeSystemProvider = /** @type {any} */ (csApi.CodeSystemProvider);
const CodeSystemFactoryProvider = /** @type {any} */ (csApi.CodeSystemFactoryProvider);
const assert = require('assert');
const { CodeSystem } = require("../library/codesystem");

/** @typedef {{type: string, subtype: string, isValid: boolean, source: string}} ParsedMimeType */
/** @typedef {string | MimeTypeConcept | null | undefined} MimeContextInput */

class MimeTypeConcept {
  /**
   * @param {string} code - MIME type code
   */
  constructor(code) {
    this.code = code;
    this.mimeType = this.#parseMimeType(code);
  }

  /**
   * @param {string} code - MIME type code
   * @returns {ParsedMimeType} Parsed MIME type components
   */
  #parseMimeType(code) {
    // Basic MIME type parsing - type/subtype with optional parameters
    const trimmed = code.trim();
    const parts = trimmed.split(';')[0].trim(); // Remove parameters for validation
    const typeParts = parts.split('/');

    if (typeParts.length === 2 && typeParts[0] && typeParts[1]) {
      return {
        type: typeParts[0],
        subtype: typeParts[1],
        isValid: true,
        source: trimmed
      };
    }

    return {
      type: '',
      subtype: '',
      isValid: false,
      source: trimmed
    };
  }

  isValid() {
    return this.mimeType.isValid && !!this.mimeType.subtype;
  }
}

class MimeTypeServices extends CodeSystemProvider {
  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   */
  constructor(opContext, supplements) {
    super(opContext, supplements);
  }

  // Metadata methods
  system() {
    return 'urn:ietf:bcp:13'; // BCP 13 defines MIME types
  }

  version() {
    return null;
  }

  description() {
    return 'Mime Types';
  }

  name() {
    return 'Mime Types';
  }

  totalCount() {
    return -1; // Not bounded - infinite possible MIME types
  }

  hasParents() {
    return false; // No hierarchical relationships
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
    return false; // MIME types don't have displays by default
  }

  // Core concept methods
  /**
   * @param {MimeContextInput} code - MIME type code or context
   * @returns {Promise<string | null>} MIME type code
   */
  async code(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt ? ctxt.code : null;
  }

  /**
   * @param {MimeContextInput} code - MIME type code or context
   * @returns {Promise<string | null>} Display string
   */
  async display(code) {
    
    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }

    // Check supplements first
    const suppDisplay = this._displayFromSupplements(ctxt.code);
    if (suppDisplay) {
      return suppDisplay;
    }

    // Default display is the code itself, trimmed
    return ctxt.code.trim();
  }

  /**
   * @param {MimeContextInput} code - MIME type code or context
   * @returns {Promise<null>} No default definitions
   */
  async definition(code) {
    
    await this.#ensureContext(code);
    return null; // No definitions provided
  }

  /**
   * @param {MimeContextInput} code - MIME type code or context
   * @returns {Promise<boolean>} Whether the MIME type is abstract
   */
  async isAbstract(code) {
    
    await this.#ensureContext(code);
    return false; // MIME types are not abstract
  }

  /**
   * @param {MimeContextInput} code - MIME type code or context
   * @returns {Promise<boolean>} Whether the MIME type is inactive
   */
  async isInactive(code) {
    
    await this.#ensureContext(code);
    return false; // MIME types are not inactive
  }

  /**
   * @param {MimeContextInput} code - MIME type code or context
   * @returns {Promise<boolean>} Whether the MIME type is deprecated
   */
  async isDeprecated(code) {
    
    await this.#ensureContext(code);
    return false; // MIME types are not deprecated
  }

  /**
   * @param {MimeContextInput} code - MIME type code or context
   * @param {any} displays - Designation collector
   * @returns {Promise<void>}
   */
  async designations(code, displays) {
    
    const ctxt = await this.#ensureContext(code);
    if (ctxt != null) {
      const display = await this.display(ctxt);
      if (display) {
        !displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), display);
      }
      this._listSupplementDesignations(ctxt.code, displays);
    }
  }

  /**
   * @param {MimeContextInput} code - MIME type code or context
   * @returns {Promise<MimeTypeConcept | null | undefined>} MIME type context
   */
  async #ensureContext(code) {
    if (!code) {
      return null;
    }
    if (typeof code === 'string') {
      const ctxt = await this.locate(code);
      if (!ctxt.context) {
        throw new Error(ctxt.message ? ctxt.message : `Invalid MIME type '${code}'`);
      } else {
        return ctxt.context;
      }
    }
    if (code instanceof MimeTypeConcept) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof code));
  }

  // Lookup methods
  /**
   * @param {string | null | undefined} code - MIME type code
   * @returns {Promise<{context: MimeTypeConcept | null, message: string | null | undefined}>} Locate result
   */
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const concept = new MimeTypeConcept(code);
    if (concept.isValid()) {
      return { context: concept, message: null };
    }

    return { context: null, message: undefined};
  }

  // Subsumption - not supported
  /**
   * @param {MimeContextInput} codeA - First MIME type
   * @param {MimeContextInput} codeB - Second MIME type
   * @returns {Promise<'not-subsumed'>} Subsumption result
   */
  async subsumesTest(codeA, codeB) {

    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    return 'not-subsumed'; // No subsumption relationships
  }

  /**
   * @param {MimeContextInput} code - MIME type code or context
   * @param {MimeContextInput} parent - Parent MIME type code or context
   * @returns {Promise<{context: null, message: string}>} Locate result
   */
  async locateIsA(code, parent) {
    await this.#ensureContext(code);
    await this.#ensureContext(parent);
    return { context: null, message: 'Subsumption not supported for MIME types' };
  }

  versionAlgorithm() {
    return null;
  }

  isNotClosed() {
    return true;
  }

}

class MimeTypeServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param {any} i18n - I18n support
   */
  constructor(i18n) {
    super(i18n);
    this.uses = 0;
  }

  defaultVersion() {
    return null;
  }

  system() {
    return 'urn:ietf:bcp:13'; // BCP 13 defines MIME types
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
   * @returns {MimeTypeServices} MIME type services
   */
  build(opContext, supplements) {
    this.uses++;
    return new MimeTypeServices(opContext, supplements);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }
  name() {
    return 'Mime Types';
  }


  id() {
    return "mimetypes";
  }
}

module.exports = {
  MimeTypeServices,
  MimeTypeServicesFactory,
  MimeTypeConcept
};
