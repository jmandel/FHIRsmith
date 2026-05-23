// @ts-check

const csApi = require('./cs-api');
const CodeSystemProvider = /** @type {any} */ (csApi.CodeSystemProvider);
const FilterExecutionContext = /** @type {any} */ (csApi.FilterExecutionContext);
const CodeSystemFactoryProvider = /** @type {any} */ (csApi.CodeSystemFactoryProvider);
const { Language } = require('../../library/languages');
const { CodeSystem } = require("../library/codesystem");
const assert = require('assert');

/** @typedef {import('../../library/languages').LanguageDefinitions} LanguageDefinitions */
/** @typedef {'language' | 'ext-lang' | 'script' | 'region' | 'variant' | 'extension' | 'private-use'} LanguageComponentCode */
/** @typedef {string | Language | null | undefined} LanguageContextInput */
/** @typedef {{context: Language | null, message?: string | null}} LanguageLocateResult */

/**
 * Language component types for filtering
 * @type {Record<string, LanguageComponentCode>}
 */
const LanguageComponent = {
  LANG: 'language',
  EXTLANG: 'ext-lang',
  SCRIPT: 'script',
  REGION: 'region',
  VARIANT: 'variant',
  EXTENSION: 'extension',
  PRIVATE_USE: 'private-use'
};

/** @type {LanguageComponentCode[]} */
const CODES_LanguageComponent = Object.values(LanguageComponent);

/**
 * Filter context for language component filters
 */
class IETFLanguageCodeFilter {
  /**
   * @param {LanguageComponentCode} component - Language component to test
   * @param {boolean} status - True if the component must exist
   */
  constructor(component, status) {
    this.component = component; // LanguageComponent
    this.status = status; // boolean - true if component must exist, false if must not exist
  }
}

/**
 * IETF Language CodeSystem Provider
 * Provides validation and lookup for BCP 47 language tags
 */
class IETFLanguageCodeProvider extends CodeSystemProvider {
  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   */
  constructor(opContext, supplements) {
    super(opContext, supplements);
    /** @type {LanguageDefinitions} */
    this.languageDefinitions = opContext.i18n.languageDefinitions;
  }

  // ========== Metadata Methods ==========

  system() {
    return 'urn:ietf:bcp:47'; // BCP 47 URI
  }

  version() {
    return null; // No specific version for BCP 47. Could be date?
  }

  description() {
    return 'IETF language codes (BCP 47)';
  }

  name() {
    return 'IETF Lang (BCP 47)';
  }

  totalCount() {
    return -1; // Unbounded - grammar-based system
  }

  /**
   * @returns {boolean} Whether the code system has parent relationships
   */
  hasParents() {
    return false; // No hierarchy in language codes
  }

  contentMode() {
    return 'complete';
  }

  /**
   * @returns {void}
   */
  listFeatures() {
    // not sure about this?

    // // Return supported filter features
    // return CODES_LanguageComponent.map(component => ({
    //   feature: `rest.Codesystem:${this.system()}.filter`,
    //   value: `${component}:exists`
    // }));
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
    return super.hasAnyDisplays(langs);
  }

  // ========== Code Information Methods ==========

  /**
   * @param {LanguageContextInput} code - Language code or context
   * @returns {Promise<string>} Language code
   */
  async code(code) {

    const ctxt = await this.#ensureContext(code);
    if (ctxt instanceof Language) {
      return ctxt.code;
    }
    throw new Error('Invalid context type');
  }

  /**
   * @param {LanguageContextInput} code - Language code or context
   * @returns {Promise<string | null>} Display string
   */
  async display(code) {

    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }
    if (!this.opContext.langs.isEnglishOrNothing()) {
      // Try translated display for the primary requested language
      const primaryLang = this.opContext.langs.getPrimary();
      if (primaryLang && primaryLang.language) {
        const langTranslation = this.languageDefinitions.getTranslatedDisplayForLang(ctxt.language, primaryLang.language);
        if (langTranslation && langTranslation !== ctxt.language) {
          if (ctxt.isLangRegion()) {
            const regionTranslation = this.languageDefinitions.getTranslatedDisplayForRegion(ctxt.region, primaryLang.language);
            if (regionTranslation && regionTranslation !== ctxt.region) {
              return `${langTranslation} (${regionTranslation})`;
            }
          }
          return langTranslation;
        }
      }
    }
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }
    return this.languageDefinitions.present(ctxt).trim();
  }

  /**
   * @param {LanguageContextInput} code - Language code or context
   * @returns {Promise<null>} Definition, if any
   */
  async definition(code) {
    await this.#ensureContext(code);
    return null; // No definitions for language codes
  }

  /**
   * @param {LanguageContextInput} code - Language code or context
   * @returns {Promise<boolean>} Whether the concept is abstract
   */
  async isAbstract(code) {
    await this.#ensureContext(code);
    return false; // Language codes are not abstract
  }

  /**
   * @param {LanguageContextInput} code - Language code or context
   * @returns {Promise<boolean>} Whether the concept is inactive
   */
  async isInactive(code) {
    await this.#ensureContext(code);
    return false; // We don't track inactive language codes
  }

  /**
   * @param {LanguageContextInput} code - Language code or context
   * @returns {Promise<boolean>} Whether the concept is deprecated
   */
  async isDeprecated(code) {
    await this.#ensureContext(code);
    return false; // We don't track deprecated language codes
  }

  /**
   * @param {LanguageContextInput} code - Language code or context
   * @param {any} displays - Designation collector
   * @returns {Promise<any[]>} Added designations
   */
  async designations(code, displays) {
    const ctxt = await this.#ensureContext(code);
    const designations = /** @type {any[]} */ ([]);
    if (ctxt != null) {
      const primaryDisplay = this.languageDefinitions.present(ctxt).trim();
      displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), primaryDisplay);
      if (ctxt.isLangRegion()) {
        const langDisplay = this.languageDefinitions.getDisplayForLang(ctxt.language);
        const regionDisplay = this.languageDefinitions.getDisplayForRegion(ctxt.region);
        const regionVariant = `${langDisplay} (${regionDisplay})`;
        const regionVariant2 = `${langDisplay} (Region=${regionDisplay})`;
        const regionVariant3 = `${langDisplay}-${regionDisplay}`;
        const regionVariant4 = `${langDisplay}-${regionDisplay.toUpperCase()}`;
        displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), regionVariant2);
        displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), regionVariant3);
        displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), regionVariant4);
        displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), regionVariant);
      }
      // add alternative displays if available
      const displayCount = this.languageDefinitions.displayCount(ctxt);
      for (let i = 0; i < displayCount; i++) {
        const altDisplay = this.languageDefinitions.present(ctxt, i).trim();
        if (altDisplay && altDisplay !== primaryDisplay) {
          displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), altDisplay);
          // Add region variants for alternatives too
          if (ctxt.isLangRegion()) {
            const langDisplay = this.languageDefinitions.getDisplayForLang(ctxt.language, i);
            const regionDisplay = this.languageDefinitions.getDisplayForRegion(ctxt.region);
            const altRegionVariant = `${langDisplay} (${regionDisplay})`;
            displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), altRegionVariant);
          }
        }
      }
      // add translated designations from CSV data
      const translationLangs = ['fr', 'de', 'es', 'ar', 'zh', 'ru', 'ja', 'sw'];
      // languages that don't have upper/lower case distinction
      const caselessLangs = new Set(['ar', 'zh', 'ja']);

      for (const tLang of translationLangs) {
        const langTranslation = this.languageDefinitions.getTranslatedDisplayForLang(ctxt.language, tLang);
        if (langTranslation && langTranslation !== ctxt.language) {
          if (ctxt.isLangRegion()) {
            const regionTranslation = this.languageDefinitions.getTranslatedDisplayForRegion(ctxt.region, tLang);
            if (regionTranslation && regionTranslation !== ctxt.region) {
              const translatedDisplay = `${langTranslation} (${regionTranslation})`;
              displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), translatedDisplay);
              displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), `${langTranslation} (Region=${regionTranslation})`);
              displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), `${langTranslation}-${regionTranslation}`);
              if (!caselessLangs.has(tLang)) {
                displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), `${langTranslation}-${regionTranslation.toUpperCase()}`);
              }
            } else {
              displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), langTranslation);
            }
          } else {
            displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), langTranslation);
          }
        }
      }
      this._listSupplementDesignations(ctxt.code, displays);
    }
    return designations;
  }


  /**
   * @param {LanguageContextInput} code - Language code or context
   * @returns {Promise<Language | null | undefined>}
   */
  async #ensureContext(code) {
    if (code == null) {
      return code;
    }
    if (typeof code === 'string') {
      const ctxt = await this.locate(code);
      if (!ctxt.context) {
        throw new Error(ctxt.message ? ctxt.message : `Invalid language code: ${code}`);
      } else {
        return ctxt.context;
      }
    }
    if (code instanceof Language) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: "+ (typeof code));
  }

  // ========== Lookup Methods ==========

  /**
   * @param {string | null | undefined} code - Language code
   * @returns {Promise<LanguageLocateResult>} Located language and status message
   */
  async locate(code) {

    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const language = this.languageDefinitions.parse(code);
    if (!language) {
      return { context: null, message: undefined };
    }

    return { context: language, message: null };
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

    // Support exists filters for language components
    if (op === 'exists' && (value === 'true' || value === 'false')) {
      return CODES_LanguageComponent.includes(/** @type {LanguageComponentCode} */ (prop));
    }
    return false;
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

    if (op !== 'exists') {
      throw new Error(`Unsupported filter operator: ${op}`);
    }

    if (value !== 'true' && value !== 'false') {
      throw new Error(`Invalid exists value: ${value}, must be 'true' or 'false'`);
    }

    const componentIndex = CODES_LanguageComponent.indexOf(/** @type {LanguageComponentCode} */ (prop));
    if (componentIndex < 0) {
      throw new Error(`Unsupported filter property: ${prop}`);
    }

    const component = CODES_LanguageComponent[componentIndex];
    const status = value === 'true';

    filterContext.filters.push(new IETFLanguageCodeFilter(component, status));
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @returns {Promise<IETFLanguageCodeFilter[]>} Filters to execute
   */
  async executeFilters(filterContext) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return filterContext.filters;
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {IETFLanguageCodeFilter} set - Filter set
   * @returns {Promise<never>}
   */
  async filterSize(filterContext, set) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof IETFLanguageCodeFilter, 'set must be a IETFLanguageCodeFilter');

    throw new Error('Language valuesets cannot be expanded as they are based on a grammar');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @returns {Promise<boolean>} Whether filters leave the set open
   */
  async filtersNotClosed(filterContext) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return true; // Grammar-based system is not closed
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {IETFLanguageCodeFilter} set - Filter set
   * @returns {Promise<never>}
   */
  async filterMore(filterContext, set) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof IETFLanguageCodeFilter, 'set must be a IETFLanguageCodeFilter');
    throw new Error('Language valuesets cannot be expanded as they are based on a grammar');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {IETFLanguageCodeFilter} set - Filter set
   * @returns {Promise<never>}
   */
  async filterConcept(filterContext, set) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof IETFLanguageCodeFilter, 'set must be a IETFLanguageCodeFilter');
    throw new Error('Language valuesets cannot be expanded as they are based on a grammar');
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {IETFLanguageCodeFilter} set - Filter set
   * @param {string} code - Language code
   * @returns {Promise<Language | string>} Matching language or rejection message
   */
  async filterLocate(filterContext, set, code) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof IETFLanguageCodeFilter, 'set must be a IETFLanguageCodeFilter');
    assert(typeof code === 'string', 'code must be non-null string');

    const language = this.languageDefinitions.parse(code);
    if (!language) {
      return `Invalid language code: ${code}`;
    }

    const filter = set;
    let hasComponent = false;

    switch (filter.component) {
      case LanguageComponent.LANG:
        hasComponent = !!language.language;
        break;
      case LanguageComponent.EXTLANG:
        hasComponent = !!language.extLang.length;
        break;
      case LanguageComponent.SCRIPT:
        hasComponent = !!language.script;
        break;
      case LanguageComponent.REGION:
        hasComponent = !!language.region;
        break;
      case LanguageComponent.VARIANT:
        hasComponent = !!language.variant;
        break;
      case LanguageComponent.EXTENSION:
        hasComponent = !!language.extension;
        break;
      case LanguageComponent.PRIVATE_USE:
        hasComponent = language.privateUse.length > 0;
        break;
      default:
        return `Unknown language component: ${filter.component}`;
    }

    if (hasComponent === filter.status) {
      return language;
    } else {
      const action = filter.status ? 'does not contain' : 'contains';
      const requirement = filter.status ? 'required' : 'not allowed';
      return `The language code ${code} ${action} a ${filter.component}, and it is ${requirement}`;
    }
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {IETFLanguageCodeFilter} set - Filter set
   * @param {LanguageContextInput} concept - Language code or context
   * @returns {Promise<boolean | string>} Whether the concept passes the filter
   */
  async filterCheck(filterContext, set, concept) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof IETFLanguageCodeFilter, 'set must be a IETFLanguageCodeFilter');
    const ctxt = /** @type {Language} */ (await this.#ensureContext(concept));


    const filter = set;
    let hasComponent = false;

    switch (filter.component) {
      case LanguageComponent.LANG:
        hasComponent = !!ctxt.language;
        break;
      case LanguageComponent.EXTLANG:
        hasComponent = ctxt.extLang.length > 0;
        break;
      case LanguageComponent.SCRIPT:
        hasComponent = !!ctxt.script;
        break;
      case LanguageComponent.REGION:
        hasComponent = !!ctxt.region;
        break;
      case LanguageComponent.VARIANT:
        hasComponent = !!ctxt.variant;
        break;
      case LanguageComponent.EXTENSION:
        hasComponent = !!ctxt.extension;
        break;
      case LanguageComponent.PRIVATE_USE:
        hasComponent = ctxt.privateUse.length > 0;
        break;
      default:
        return `Unknown language component: ${filter.component}`;
    }

    return hasComponent === filter.status;
  }


  // ========== Iterator Methods ==========
  // Cannot iterate language codes (grammar-based)

  // ========== Additional Methods ==========

  /**
   * @param {LanguageContextInput} a - First language code or context
   * @param {LanguageContextInput} b - Second language code or context
   * @returns {Promise<boolean>} Whether both refer to the same concept
   */
  async sameConcept(a, b) {

    const codeA = await this.code(a);
    const codeB = await this.code(b);
    return codeA === codeB;
  }

  /**
   * @param {LanguageContextInput} codeA - First language code or context
   * @param {LanguageContextInput} codeB - Second language code or context
   * @returns {Promise<string>} Subsumption outcome
   */
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    return 'not-subsumed'; // No subsumption in language codes
  }

  versionAlgorithm() {
    return null;
  }

  isNotClosed() {
    return true;
  }
}

/**
 * Factory for creating IETF Language CodeSystem providers
 */
class IETFLanguageCodeFactory extends CodeSystemFactoryProvider  {
  /**
   * @param {any} i18n - Translation support
   */
  constructor(i18n) {
    super(i18n);
    this.uses = 0;
  }

  defaultVersion() {
    return ''; // No versioning for BCP 47
  }

  system() {
    return 'urn:ietf:bcp:47'; // BCP 47 URI
  }

  version() {
    return null; // No specific version for BCP 47. Could be date?
  }

  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @returns {IETFLanguageCodeProvider} New provider
   */
  build(opContext, supplements) {
    this.recordUse();
    return new IETFLanguageCodeProvider(opContext, supplements);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;

  }

  name() {
    return 'IETF Lang (BCP 47)';
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

  id() {
    return 'languages';
  }
}

module.exports = {
  IETFLanguageCodeProvider,
  IETFLanguageCodeFactory,
  IETFLanguageCodeFilter,
  LanguageComponent
};
