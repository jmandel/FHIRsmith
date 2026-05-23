// @ts-check

const { LanguagePartType, Languages, Language, LanguageDefinitions} = require('../../library/languages');
const {validateParameter, validateOptionalParameter, validateArrayParameter} = require("../../library/utilities");
const natural = require('natural');

/** @typedef {{system?: string, version?: string, code?: string, display?: string}} CodingLike */
/** @typedef {{passes: boolean, rating: number}} PassRating */

/**
 * Display checking modes for concept designations
 */
const DisplayCheckingStyle = {
  EXACT: 'exact',
  CASE_INSENSITIVE: 'caseInsensitive',
  NORMALISED: 'normalised'
};

const allowedDesignationExtensions = [
  'http://hl7.org/fhir/StructureDefinition/coding-sctdescid',
  'http://hl7.org/fhir/StructureDefinition/rendering-style',
  'http://hl7.org/fhir/StructureDefinition/rendering-xhtml',
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
  'http://hl7.org/fhir/StructureDefinition/codesystem-alternate'
];
/**
 * Text search filter with stemming support
 */
class SearchFilterText {
  /** @type {string | null} */
  filter;
  /** @type {string[]} */
  stems;
  /** @type {any} */
  stemmer;

  /**
   * @param {string | null | undefined} filter
   */
  constructor(filter) {
    validateOptionalParameter(filter, 'filter', String);

    this.filter = filter ? filter.toLowerCase() : null;
    this.stems = [];
    this.stemmer = natural.PorterStemmer;
    if (filter) {
      this._process();
    }
  }

  /**
   * Check if filter is empty
   * @returns {boolean}
   */
  get isNull() {
    return this.stems.length === 0;
  }

  /**
   * Check if a value passes the filter
   * @param {string} value
   * @param {boolean} [returnRating]
   * @returns {boolean | PassRating}
   */
  passes(value, returnRating = false) {
    validateParameter(value, 'value', String);
    validateOptionalParameter(returnRating, 'returnRating', Boolean);

    if (this.isNull) {
      return returnRating ? {passes: true, rating: 0} : true;
    }

    let rating = 0;
    let i = 0;

    while (i < value.length) {
      if (this._isAlphaNumeric(value[i])) {
        const j = i;
        while (i < value.length && this._isAlphaNumeric(value[i])) {
          i++;
        }
        const word = value.substring(j, i).toLowerCase();
        const stemmed = this.stemmer.stem(word);

        if (this._find(stemmed)) {
          if (returnRating) {
            rating += value.length / this.stems.length;
            return {passes: true, rating};
          } else {
            return true;
          }
        }
      } else {
        i++;
      }
    }

    return returnRating ? {passes: false, rating: 0} : false;
  }

  /**
   * Check if designations pass the filter
   * @param {Designations | null | undefined} cds
   * @returns {boolean}
   */
  passesDesignations(cds) {
    validateOptionalParameter(cds, 'cds', Designations);

    if (this.isNull) {
      return true;
    }

    if (!cds) return false;

    for (const cd of cds.designations) {
      if (cd.value && this.passes(cd.value)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Calculate match score against stems
   * @param {string[] | null | undefined} stems
   * @returns {number}
   */
  matches(stems) {
    validateOptionalParameter(stems, 'stems', Array);

    if (this.stems.length === 0) return 100;
    if (!stems || stems.length === 0) return 0;

    let result = 0;

    for (const stem of stems) {
      let incomplete = false;
      let complete = false;

      for (const filterStem of this.stems) {
        if (filterStem === stem) {
          complete = true;
        } else if (stem.startsWith(filterStem)) {
          incomplete = true;
        }
      }

      if (complete) {
        result += stem.length / this.stems.length;
      } else if (incomplete) {
        result += (stem.length / this.stems.length) / 2;
      }
    }

    return result;
  }

  // Private methods

  /**
   * @returns {void}
   */
  _process() {
    if (!this.filter) {
      return;
    }
    let i = 0;

    while (i < this.filter.length) {
      if (this._isAlphaNumeric(this.filter[i])) {
        const j = i;
        while (i < this.filter.length && this._isAlphaNumeric(this.filter[i])) {
          i++;
        }
        const word = this.filter.substring(j, i);
        this.stems.push(this.stemmer.stem(word.toLowerCase()));
      } else {
        i++;
      }
    }

    this.stems.sort();
  }

  /**
   * @param {string} char
   * @returns {boolean}
   */
  _isAlphaNumeric(char) {
    return /[0-9a-zA-Z]/.test(char);
  }

  /**
   * @param {string} stem
   * @returns {boolean}
   */
  _find(stem) {
    // Binary search
    let left = 0;
    let right = this.stems.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midStem = this.stems[mid];

      if (stem.startsWith(midStem)) {
        return true;
      } else if (stem < midStem) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    return false;
  }
}

/**
 * Language matching types
 */
const LangMatchType = {
    LITERAL: 'literal',
    FULL: 'full',
    LANG_EXACT: 'langExact',
    LANG_REGION: 'langRegion',
    LANG: 'lang'
  };

/**
 * Display comparison sensitivity modes
 */
const DisplayCompareSensitivity = {
  CaseSensitive: 'case-sensitive',
  CaseInsensitive: 'case-insensitive',
  Normalized: 'normalized'  // Ignore whitespace differences
};

/**
 * Display difference results
 */
const DisplayDifference = {
  Exact: 'exact',
  Case: 'case',
  Normalized: 'normalized',
  None: 'none'
};


/**
 * Standard use codes for designations
 */
const DesignationUse = {
  DISPLAY: {
    system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra', // http://terminology.hl7.org/CodeSystem/designation-use',
    code: 'preferredForLanguage' // 'display'
  },
  FSN: {
    system: 'http://snomed.info/sct',
    code: '900000000000003001'  // Fully Specified Name
  },
  PREFERRED: {
    system: 'http://snomed.info/sct',
    code: '900000000000548007'  // Preferred term
  },
  SYNONYM: {
    system: 'http://snomed.info/sct',
    code: '900000000000013009'  // Synonym
  }
};

/**
 * Individual concept designation with language, use, and value
 */
class Designation {
  /** @type {string | null} */
  status;
  /** @type {Language | null} */
  language;
  /** @type {CodingLike | null} */
  use; // Coding {system, version, code, display} - well be DesignationUse.DISPLAY if is display
  /** @type {string | null} */
  value; // string
  /** @type {any[]} */
  extensions = []; // extensions on the designation
  /** @type {any} */
  source = null;
  /** @type {any} */
  supplement = null;

  constructor() {
    this.status = null;
    this.language = null;
    this.use = null;
    this.value = null;
    this.extensions = [];
  }

  /**
   * Get the display text for this designation
   * @returns {string}
   */
  get display() {
    return this.value ? this.value || '' : '';
  }

  /**
   * Get a string representation of this designation
   * @returns {string}
   */
  present() {
    let result = this.value ? `"${this.value || ''}"` : '""';

    if (this.language || this.use) {
      result += ' (';
      if (this.language) {
        result += this.language.code;
      }
      if (this.use) {
        result += '/' + this._renderCoding(this.use);
      }
      result += ')';
    }

    return result;
  }

  /**
   * Render a coding object as text
   * @param {CodingLike | null | undefined} coding
   * @returns {string}
   */
  _renderCoding(coding) {
    if (!coding) return '--';
    if (coding.display) return coding.display;
    if (coding.code) return coding.code;
    return coding.system || '--';
  }

  /**
   * @returns {boolean}
   */
  isPreferred() {
    return !!(this.use && this.use.system == DesignationUse.PREFERRED.system &&
      this.use.code == DesignationUse.PREFERRED.code);
  }

  /**
   * @returns {boolean}
   */
  isActive() {
    let inactive = ["withdrawn", "inactive"].includes(this.status || '');
    return !inactive;
  }

  /**
   * @returns {any}
   */
  asObject() {
    /** @type {any} */
    let obj = {}
    if (this.language) {
      obj.language = this.language.code;
    }
    if (this.use) {
      obj.use = this.use;
    }
    if (this.value) {
      obj.value = this.value;
    }
    for (let ext of this.extensions || []) {
      if (allowedDesignationExtensions.includes(ext.url)) {
        if (!obj.extension) {
          obj.extension = [];
        }
        obj.extension.push(ext);
      }
    }
    return obj;
  }
}

/**
 * Collection of concept designations with language matching and preference logic
 */
class Designations {
  /** @type {LanguageDefinitions} */
  languageDefinitions;
  /** @type {Language | null} */
  baseLang;
  /** @type {Designation[]} */
  designations;
  /** @type {any} */
  source;

  /**
   * @param {LanguageDefinitions} languageDefinitions
   */
  constructor(languageDefinitions) {
    validateParameter(languageDefinitions, "languageDefinitions", LanguageDefinitions);
    this.languageDefinitions = languageDefinitions;
    this.baseLang = null;
    this.designations = [];
    this.source = null; // Reference to CodeSystemProvider
  }

  /**
   * Clear all designations and reset base language
   * @returns {void}
   */
  clear() {
    this.baseLang = null;
    this.designations = [];
    this.source = null; // Reference to CodeSystemProvider
  }

  /**
   * Add a designation with string parameters
   * @param {boolean} isDisplay
   * @param {string} status
   * @param {string | null | undefined} lang
   * @param {CodingLike | null | undefined} use
   * @param {string} display
   * @param {any[]} [extensions]
   * @returns {Designation}
   */
  addDesignation(isDisplay, status, lang, use, display, extensions = []) {
    validateParameter(status, "status", String);
    validateParameter(isDisplay, "isDisplay", Boolean);
    validateOptionalParameter(lang, "lang", String);
    validateOptionalParameter(use, "use", Object);
    validateParameter(display, "display", String);
    validateArrayParameter(extensions, "extensions", Object);

    const designation = new Designation();
    designation.language = this.languageDefinitions.parse(lang);
    designation.value = display;
    designation.status = status;

    if (isDisplay) {
      designation.use = {
        system: DesignationUse.DISPLAY.system,
        code: DesignationUse.DISPLAY.code
      };
    } else if (use) {
      designation.use = use;
    }
    if (extensions.length > 0) {
      designation.extensions.push(...extensions)
    }
    this.designations.push(designation);
    return designation;
  }

  /**
   * Add designations from an array of displays
   * @param {string} status
   * @param {boolean} isDisplay
   * @param {string} lang
   * @param {CodingLike | null | undefined} use
   * @param {string[] | null | undefined} displays
   * @returns {void}
   */
  addDesignationsFromArray(status, isDisplay, lang, use, displays) {
    validateParameter(status, "status", String);
    validateParameter(isDisplay, "isDisplay", Boolean);
    validateParameter(lang, "lang", String);
    validateArrayParameter(displays, "displays", String, false);

    if (displays) {
      for (const display of displays) {
        this.addDesignation(isDisplay, status, lang, use, display);
      }
    }
  }

  /**
   * Add designation from FHIR CodeSystem concept designation
   * @param {any} concept
   * @returns {void}
   */
  addDesignationFromConcept(concept) {
    validateOptionalParameter(concept, 'concept', Object);
    if (!concept) return;
    this.addDesignation(false, "unknown", concept.language, concept.use, concept.value.trim(), concept.extension);
    //
    // if (context.display) {
    //   this.addDesignation(true, true, baseLanguage, null, context.display)
    // }
    // if (context.designation && Array.isArray(context.designation)) {
    //   for (const d of context.designation) {
    //     this.addDesignation(false, "unknown", d.language, d.use, d.value, d.extension);
    //   }
    // }
  }

  /**
   * @param {string | null | undefined} value
   * @returns {boolean}
   */
  hasAnyDisplay(value) {
    for (let designation of this.designations) {
      if (designation.value === value) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a display value exists with specified matching criteria
   * @param {Languages | null | undefined} langList
   * @param {Language | null | undefined} defLang
   * @param {string} value
   * @param {boolean} active
   * @param {string} mode
   * @returns {{found: boolean, difference: string}}
   */
  hasDisplay(langList, defLang, value, active, mode) {
    validateOptionalParameter(langList, 'langList', Languages); // Allow null
    validateOptionalParameter(defLang, 'defLang', Language);
    validateParameter(value, 'value', String);
    validateParameter(active, 'active', Boolean);
    validateParameter(mode, 'mode', String);

    const result = { found: false, difference: DisplayDifference.None };

    for (const cd of this.designations) {
      if (this._langsMatch(langList, cd.language, LangMatchType.LANG, defLang) &&
          (!active || cd.isActive()) && cd.value && this._stringMatches(value, cd.value, mode)) {
        result.found = true;
        return result;
      }
    }

    if (mode === DisplayCheckingStyle.EXACT) {
      for (const cd of this.designations) {
        if (this._langsMatch(langList, cd.language, LangMatchType.LANG, defLang) &&
          (!active || cd.isActive()) &&
          cd.value &&
          this._stringMatches(value, cd.value, DisplayCheckingStyle.CASE_INSENSITIVE)) {
          result.difference = DisplayDifference.Case;
          return result;
        }
      }
    }

    if (mode !== DisplayCheckingStyle.NORMALISED) {
      for (const cd of this.designations) {
        if (this._langsMatch(langList, cd.language, LangMatchType.LANG, defLang) &&
          (!active || cd.isActive()) &&
          cd.value &&
          this._stringMatches(value, cd.value, DisplayCheckingStyle.NORMALISED)) {
          result.difference = DisplayDifference.Normalized;
          return result;
        }
      }
    }

    return result;
  }

  /**
   * Count displays matching language criteria
   * @param {Languages | null | undefined} langList
   * @param {Language | null | undefined} defLang
   * @param {boolean} displayOnly
   * @returns {number}
   */
  displayCount(langList, defLang, displayOnly) {
    validateOptionalParameter(langList, 'langList', Languages); // Allow null
    validateOptionalParameter(defLang, 'defLang', Language);
    validateParameter(displayOnly, 'displayOnly', Boolean);

    let result = 0;

    // Try full match first
    for (const cd of this.designations) {
      if ((!displayOnly || this.isDisplay(cd)) &&
        this._langsMatch(langList, cd.language, LangMatchType.FULL, defLang) &&
        cd.value) {
        result++;
      }
    }

    if (result === 0) {
      // Try language-region match
      for (const cd of this.designations) {
        if ((!displayOnly || this.isDisplay(cd)) &&
          this._langsMatch(langList, cd.language, LangMatchType.LANG_REGION, defLang) &&
          cd.value) {
          result++;
        }
      }
    }

    if (result === 0) {
      // Try language-only match
      for (const cd of this.designations) {
        if ((!displayOnly || this.isDisplay(cd)) &&
          this._langsMatch(langList, cd.language, LangMatchType.LANG, defLang) &&
          cd.value) {
          result++;
        }
      }
    }

    return result;
  }

  /**
   * Present all matching designations as a formatted string
   * @param {Languages | null | undefined} langList
   * @param {Language | null | undefined} defLang
   * @param {boolean} displayOnly
   * @returns {string}
   */
  present(langList, defLang, displayOnly) {
    validateOptionalParameter(langList, 'langList', Languages); // Allow null
    validateOptionalParameter(defLang, 'defLang', Language);
    validateParameter(displayOnly, 'displayOnly', Boolean);

    /** @type {string[]} */
    const results = [];
    let count = 0;

    // Collect matching designations
    for (const cd of this.designations) {
      if ((!displayOnly || this.isDisplay(cd)) &&
        this._langsMatch(langList, cd.language, LangMatchType.LANG, null) &&
        cd.value) {
        count++;
        if (cd.language) {
          results.push(`'${cd.display}' (${cd.language.code})`);
        } else {
          results.push(`'${cd.display}'`);
        }
      }
    }

    // If no language-specific matches, get all
    if (count === 0) {
      for (const cd of this.designations) {
        if ((!displayOnly || this.isDisplay(cd)) && cd.value) {
          count++;
          if (cd.language) {
            results.push(`'${cd.display}' (${cd.language.code})`);
          } else {
            results.push(`'${cd.display}'`);
          }
        }
      }
    }

    return this._joinWithOr(results);
  }

  /**
   * Check if designation should be included for given language criteria
   * @param {Designation} cd
   * @param {Languages | null | undefined} langList
   * @param {Language | null | undefined} defLang
   * @returns {boolean}
   */
  include(cd, langList, defLang) {
    validateParameter(cd, 'cd', Designation);
    validateOptionalParameter(langList, 'langList', Languages); // Allow null
    validateOptionalParameter(defLang, 'defLang', Language);

    return this._langsMatch(langList, cd.language, LangMatchType.LANG, defLang);
  }

  /**
   * Find the preferred designation for given language preferences
   * @param {Languages | null} [langList]
   * @param {Set<any> | null} [supplements]
   * @returns {Designation | null}
   */
  preferredDesignation(langList = null, supplements = null) {
    if (this.designations.length === 0) {
      return null;
    }

    if (!langList || langList.length == 0) {
      // No language list, prefer base designations
      for (const cd of this.designations) {
        if (this._isPreferred(cd) && cd.isActive()) {
          if (supplements && cd.source) {
            supplements.add(cd.source);
          }
          return cd;
        }
      }
      for (const cd of this.designations) {
        if (this.isDisplay(cd) && cd.isActive()) {
          if (supplements && cd.source) {
            supplements.add(cd.source);
          }
          return cd;
        }
      }
      for (const cd of this.designations) {
        if (this.isDisplay(cd)) {
          if (supplements && cd.source) {
            supplements.add(cd.source);
          }
          return cd;
        }
      }
      for (const cd of this.designations) {
        if (this._isPreferred(cd)) {
          if (supplements && cd.source) {
            supplements.add(cd.source);
          }
          return cd;
        }
      }
      if (supplements && this.designations[0].source) {
        supplements.add(this.designations[0].source);
      }
      return this.designations[0];
    }

    for (const lang of langList.languages) {
      if (lang.quality <= 0) continue;

      const matchTypes = [LangMatchType.FULL, LangMatchType.LANG_REGION, LangMatchType.LANG];

      for (const matchType of matchTypes) {
        for (const cd of this.designations) {
          if (this._langMatches(lang, cd.language, matchType) && this.isDisplay(cd)) {
            if (supplements && cd.source) {
              supplements.add(cd.source);
            }
            return cd;
          }
        }
        for (const cd of this.designations) {
          if (this._langMatches(lang, cd.language, matchType) && this._isPreferred(cd)) {
            if (supplements && cd.source) {
              supplements.add(cd.source);
            }
            return cd;
          }
        }
        for (const cd of this.designations) {
          if (this._langMatches(lang, cd.language, matchType)) {
            if (supplements && cd.source) {
              supplements.add(cd.source);
            }
            return cd;
          }
        }
      }
    }
    for (const cd of this.designations) {
      if (!cd.language && this.isDisplay(cd)) {
        if (supplements && cd.source) {
          supplements.add(cd.source);
        }
        return cd;
      }
    }
    return null;
  }

  /**
   * Select the best designation from all collected matches
   */ /*
  _selectBestMatch(matches) {
    // Sort by priority:
    // 1. Match type (FULL > LANG_REGION > LANG)
    // 2. Language quality
    // 3. Designation type (base > display > other)
    // 4. Language specificity (exact language > regional variant)

    const matchTypePriority = {
      [LangMatchType.FULL]: 3,
      [LangMatchType.LANG_REGION]: 2,
      [LangMatchType.LANG]: 1
    };

    const getDesignationTypePriority = (cd) => {
      if (cd.base) return 3;
      if (this.isDisplay(cd)) return 2;
      return 1;
    };

    const getLanguageSpecificity = (cd) => {
      // For same match type, prefer exact language over regional variants
      // Shorter language codes are more general (fr vs fr-CA)
      const code = cd.language?.code || '';
      return -code.length; // Negative so shorter codes sort first
    };

    matches.sort((a, b) => {
      // 1. Language quality
      const qualityDiff = b.quality - a.quality;
      if (qualityDiff !== 0) return qualityDiff;

      // 2. Match type priority
      const matchTypeDiff = matchTypePriority[b.matchType] - matchTypePriority[a.matchType];
      if (matchTypeDiff !== 0) return matchTypeDiff;

      // 3. Designation type
      const designationTypeDiff = getDesignationTypePriority(b.designation) - getDesignationTypePriority(a.designation);
      if (designationTypeDiff !== 0) return designationTypeDiff;

      // 4. Language specificity (for same match type, prefer more specific matches)
      return getLanguageSpecificity(b.designation) - getLanguageSpecificity(a.designation);
    });

    return matches[0].designation;
  }
*/
  /**
   * Get preferred display text
   * @param {Languages | null | undefined} langList
   * @param {Language | null | undefined} [defLang]
   * @returns {string}
   */
  preferredDisplay(langList, defLang = null) {
    void defLang;
    const cd = this.preferredDesignation(langList || null, null);
    return cd ? cd.display : '';
  }

  /**
   * Get summary of all designations
   * @returns {string}
   */
  summary() {
    return this.designations.map((cd) => cd.present()).join(', ');
  }

  /**
   * Present this designations object
   * @returns {string}
   */
  presentSelf() {
    let result = this.baseLang ? `Lang: ${this.baseLang.code}` : 'Lang: ??';
    if (this.source) {
      result += `; source: ${this.source.constructor.name}`;
    }
    return result;
  }

  /**
   * Get language code for base language
   * @returns {string}
   */
  get langCode() {
    return this.baseLang ? this.baseLang.code : 'en';
  }

  /**
   * Get count of all designations
   * @returns {number}
   */
  get count() {
    return this.designations.length;
  }
  // Private helper methods

  /**
   * Check if designation is a display designation
   * @param {Designation} cd
   * @returns {boolean}
   */
  isDisplay(cd) {
    if (!cd.use) {
      return true;
    }
    if ((cd.use.system === DesignationUse.DISPLAY.system &&
        cd.use.code === DesignationUse.DISPLAY.code) ||
      (cd.use.system === DesignationUse.PREFERRED.system &&
        cd.use.code === DesignationUse.PREFERRED.code)) {
      return true;
    }
    return !!(this.source && this.source.isDisplay(cd));
  }

  /**
   * Check if designation is a display designation
   * @param {Designation} cd
   * @returns {boolean}
   */
  _isPreferred(cd) {
    return !cd.use ||
      (cd.use.system === DesignationUse.DISPLAY.system &&
        cd.use.code === DesignationUse.DISPLAY.code) ||
      (cd.use.system === DesignationUse.PREFERRED.system &&
        cd.use.code === DesignationUse.PREFERRED.code) ||
      // snomed
      (cd.use.system === 'http://snomed.info/sct' &&
        cd.use.code === '900000000000013009');
  }

  /**
   * Get depth for match type
   * @param {string} matchType
   * @returns {number}
   */
  _depthForMatchType(matchType) {
    switch (matchType) {
      case LangMatchType.LITERAL:
      case LangMatchType.FULL:
        return LanguagePartType.EXTENSION;
      case LangMatchType.LANG_EXACT:
        return LanguagePartType.REGION;
      case LangMatchType.LANG_REGION:
        return LanguagePartType.REGION;
      case LangMatchType.LANG:
        return LanguagePartType.LANGUAGE;
      default:
        return LanguagePartType.EXTENSION;
    }
  }

  /**
   * Check if a single language entry matches a stated language
   * @param {Language} langEntry
   * @param {Language | null | undefined} statedLang
   * @param {string} matchType
   * @returns {boolean}
   */
  _langMatches(langEntry, statedLang, matchType) {
    const actualLang = statedLang || this.baseLang;

    if (langEntry.quality <= 0) {
      return false;
    }

    if (langEntry.code === '*' && matchType !== LangMatchType.LITERAL) {
      return true;
    }

    if (actualLang) {
      if (matchType === LangMatchType.LITERAL) {
        return langEntry.code === actualLang.code;
      }

      // Parse the language entry if needed
      /** @type {Language | null} */
      let parsedLang = langEntry;
      if (typeof langEntry.code === 'string') {
        parsedLang = this.languageDefinitions.parse(langEntry.code);
      }

      if (parsedLang && parsedLang.matches(actualLang, this._depthForMatchType(matchType))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if language list matches stated language
   * @param {Languages | null | undefined} langList
   * @param {Language | null | undefined} statedLang
   * @param {string} matchType
   * @param {Language | null | undefined} defLang
   * @returns {boolean}
   */
  _langsMatch(langList, statedLang, matchType, defLang) {
    if (defLang && statedLang && statedLang.matches(defLang)) {
      return true;
    }

    if (!statedLang || !langList) {
      return true;
    }

    for (const langEntry of langList.languages) {
      if (this._langMatches(langEntry, statedLang, matchType)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if strings match according to specified mode
   * @param {string} source
   * @param {string} possible
   * @param {string} mode
   * @returns {boolean}
   */
  _stringMatches(source, possible, mode) {
    // We ignore lang parameter for now, like the Pascal version
    switch (mode) {
      case DisplayCheckingStyle.EXACT:
        return source === possible;
      case DisplayCheckingStyle.CASE_INSENSITIVE:
        return source.toLowerCase() === possible.toLowerCase();
      case DisplayCheckingStyle.NORMALISED:
        return this._normalizeWhitespace(source).toLowerCase() ===
          this._normalizeWhitespace(possible).toLowerCase();
      default:
        return false;
    }
  }

  /**
   * Normalize whitespace in a string
   * @param {string} str
   * @returns {string}
   */
  _normalizeWhitespace(str) {
    return str.replace(/\s+/g, ' ').trim();
  }

  /**
   * Join array with commas and final "or"
   * @param {string[]} items
   * @returns {string}
   */
  _joinWithOr(items) {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} or ${items[1]}`;

    const lastItem = items.pop();
    return `${items.join(', ')} or ${lastItem}`;
  }

  /**
   * Get allowed displays as a list (for error messages)
   * @param {Array<string>} output - Array to populate
   * @param {Languages | null} languages - Languages to consider
   * @param {Language | null} defaultLang - Default language fallback
   */
  allowedDisplays(output, languages = null, defaultLang = null) {
    const seen = new Set();

    for (const d of this.designations) {
      if (!d.isActive() || !(this.isDisplay(d)) || !d.value) continue;
      if (seen.has(d.value)) continue;

      // Check language match
      if (languages && languages.length > 0) {
        let langMatch = false;
        if (d.language) {
          langMatch = languagesHasMatch(languages, d.language);
        } else if (defaultLang || this.baseLang) {
          langMatch = true;
        }
        if (!langMatch) continue;
      }

      seen.add(d.value);
      output.push(d.value);
    }
  }


  /**
   * Get the inactive status string for a display
   * @param {string} display - Display text to find
   * @returns {string} Status string or empty
   */
  status(display) {
    for (const d of this.designations) {
      if (d.value === display) {
        return d.status || '';
      }
    }
    return '';
  }

  /**
   * Check if this collection has any displays for the given languages
   * @param {Languages | null | undefined} languages - Languages to check
   * @returns {boolean}
   */
  hasAnyDisplays(languages) {
    return this.displayCount(languages, null, true) > 0;
  }

  /**
   * Get all designations as an array (for iteration)
   * @returns {Designation[]}
   */
  all() {
    return [...this.designations];
  }

  /**
   * Iterator support
   * @returns {IterableIterator<Designation>}
   */
  [Symbol.iterator]() {
    return this.designations[Symbol.iterator]();
  }
}


/**
 * Check if a Languages collection has a match for a given language
 * @param {Languages} langs - Languages collection
 * @param {Language|string} target - Target language to match
 * @returns {boolean}
 */
function languagesHasMatch(langs, target) {
  if (!langs || langs.length === 0) return false;

  const targetLang = typeof target === 'string' ? new Language(target) : target;

  for (const lang of langs) {
    if (lang.matchesForDisplay(targetLang)) {
      return true;
    }
  }
  return false;
}


module.exports = {
  Designation,
  Designations,
  DesignationUse,
  SearchFilterText,
  DisplayCheckingStyle,
  DisplayCompareSensitivity,
  DisplayDifference,
  LangMatchType
};
