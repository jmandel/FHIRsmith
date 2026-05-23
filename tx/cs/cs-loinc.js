// @ts-check

const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const { Language, Languages} = require('../../library/languages');
const csApi = require('./cs-api');
const CodeSystemFactoryProvider = /** @type {any} */ (csApi.CodeSystemFactoryProvider);
const { validateOptionalParameter, validateArrayParameter} = require("../../library/utilities");
const csBase = require("./cs-base");
const BaseCSServices = /** @type {any} */ (csBase.BaseCSServices);
const {sqlEscapeString} = require("../../xig/xig");
const regexUtilities = require('../../library/regex-utilities');

/** @typedef {import('sqlite3').Database} SqliteDatabase */
/** @typedef {string | LoincProviderContext | null | undefined} LoincContextInput */
/** @typedef {{context: LoincProviderContext | null, message?: string | null}} LoincLocateResult */
/** @typedef {{langs: Map<string, number>, codes: Map<string, LoincProviderContext>, codeList: Array<LoincProviderContext | null>, allKeys: number[], relationships: Map<string, string>, propertyList: Map<string, string>, statusKeys: Map<string, string>, statusCodes: Map<string, string>, _version: string, root: string, firstCodeKey: number}} LoincSharedData */
/** @typedef {{Lang: string, DType?: string, Value: string, dtype?: string, value?: string, lang?: string, IsDisplay?: boolean | number}} LoincDescriptionRow */
/** @typedef {{Key: number, Description?: string, Value?: string, PropertyValueKey?: number}} LoincKeyRow */
/** @typedef {{Relationship: string, Code: string, Description?: string, Value?: string}} LoincRelationshipRow */
/** @typedef {{StatusKey: number | string, Description: string}} LoincStatusRow */
/** @typedef {{LanguageKey: number, Code: string}} LoincLanguageRow */
/** @typedef {{RelationshipTypeKey: number | string, Description: string}} LoincRelationshipTypeRow */
/** @typedef {{PropertyTypeKey: number | string, Description: string}} LoincPropertyTypeRow */
/** @typedef {{CodeKey: number, Code: string, Type: number, Description: string, Status: string, maxKey?: number}} LoincCodeRow */
/** @typedef {{SourceKey: number, TargetKey: number}} LoincHierarchyRow */
/** @typedef {{ConfigKey: number, Value: string}} LoincConfigRow */
/** @typedef {{Code: string, Description?: string}} LoincAnswerListRow */
/** @typedef {{resourceType?: string, url: string, version: string | null, status: string, name: string, description: string, date: string, experimental: boolean, compose: {include: Array<{system: string, filter?: Array<{property: string, op: string, value: string}>, concept?: Array<{code: string}>}>}}} LoincValueSetLike */

// Context kinds matching Pascal enum
const LoincProviderContextKind = {
  CODE: 0,    // lpckCode
  PART: 1,    // lpckPart
  LIST: 2,    // lpckList
  ANSWER: 3   // lpckAnswer
};

/** @type {Record<string, string>} */
const classTypes = {
  '1': 'Laboratory class',
  '2': 'Clinical class',
  '3': 'Claims attachments',
  '4': 'Surveys',
  'Laboratory class' : '1',
  'Clinical class' : '2',
  'Claims attachments' : '3',
  'Surveys' : '4'
};

class DescriptionCacheEntry {
  /**
   * @param {boolean} display - Whether this designation is a display
   * @param {string} lang - Language code
   * @param {string} value - Designation value
   * @param {string} dtype - LOINC description type
   */
  constructor(display, lang, value, dtype) {
    this.display = display;
    this.lang = lang;
    this.value = value;
    this.dtype = dtype;
  }
}

class LoincProviderContext {
  /**
   * @param {number} key - LOINC code key
   * @param {number} kind - Context kind
   * @param {string} code - LOINC code
   * @param {string} desc - Display description
   * @param {string} status - Concept status
   */
  constructor(key, kind, code, desc, status) {
    this.key = key;
    this.kind = kind;
    this.code = code;
    this.desc = desc;
    this.status = status;
    /** @type {DescriptionCacheEntry[]} */
    this.displays = []; // Array of DescriptionCacheEntry
    /** @type {number[] | null} */
    this.children = null; // Will be Set of keys if this has children
  }

  /**
   * @param {number} key - Child code key
   * @returns {void}
   */
  addChild(key) {
    if (!this.children) {
      this.children = [];
    }
    this.children.push(key);
  }
}

class LoincDisplay {
  /**
   * @param {string} language - Language code
   * @param {string} value - Display value
   */
  constructor(language, value) {
    this.language = language;
    this.value = value;
  }
}

class LoincIteratorContext {
  /**
   * @param {LoincProviderContext | null} context - Parent context
   * @param {number[] | null | undefined} keys - Keys to iterate
   */
  constructor(context, keys) {
    this.context = context;
    this.keys = keys || [];
    this.current = 0;
    this.total = this.keys.length;
  }

  /**
   * @returns {boolean} Whether another context is available
   */
  more() {
    return this.current < this.total;
  }

  /**
   * @returns {void}
   */
  next() {
    this.current++;
  }
}

class LoincFilterHolder {
  constructor() {
    /** @type {number[]} */
    this.keys = [];
    this.cursor = 0;
    this.lsql = '';
  }

  /**
   * @param {number} key - Code key
   * @returns {boolean} Whether key is included in this filter
   */
  hasKey(key) {
    // Binary search since keys should be sorted
    let l = 0;
    let r = this.keys.length - 1;
    while (l <= r) {
      const m = Math.floor((l + r) / 2);
      if (this.keys[m] < key) {
        l = m + 1;
      } else if (this.keys[m] > key) {
        r = m - 1;
      } else {
        return true;
      }
    }
    return false;
  }
}

class LoincPrep {
  /**
   * @param {boolean} iterate - Whether filters are used for iteration
   */
  constructor(iterate = false) {
    this.iterate = iterate;
    /** @type {LoincFilterHolder[]} */
    this.filters = [];
  }
}

class LoincServices extends BaseCSServices {
  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @param {SqliteDatabase | null} db - Open LOINC database
   * @param {LoincSharedData} sharedData - Shared LOINC data loaded by factory
   */
  constructor(opContext, supplements, db, sharedData) {
    super(opContext, supplements);
    /** @type {SqliteDatabase | null} */
    this.db = db;

    // Shared data from factory
    this.langs = sharedData.langs;
    this.codes = sharedData.codes;
    this.codeList = sharedData.codeList;
    this.allKeys = sharedData.allKeys;
    this._version = sharedData._version;
    this.root = sharedData.root;
    this.firstCodeKey = sharedData.firstCodeKey;
    this.relationships = sharedData.relationships;
    this.propertyList = sharedData.propertyList;
    this.statusKeys = sharedData.statusKeys;
    this.statusCodes = sharedData.statusCodes;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // Metadata methods
  system() {
    return 'http://loinc.org';
  }

  version() {
    return this._version;
  }

  name() {
    return 'LOINC';
  }

  description() {
    return 'LOINC';
  }

  async totalCount() {
    return this.codes.size;
  }

  hasParents() {
    return true; // LOINC has hierarchical relationships
  }

  /**
   * @param {any} languages - Requested languages
   * @returns {boolean} Whether matching displays are available
   */
  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);

    // Check supplements first
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }

    // Check if any requested languages are available in LOINC data
    for (const requestedLang of langs.languages) {
      for (const [loincLangCode] of this.langs) {
        const loincLang = new Language(loincLangCode);
        if (loincLang.matchesForDisplay(requestedLang)) {
          return true;
        }
      }
    }

    return super.hasAnyDisplays(langs);
  }

  // Core concept methods
  /**
   * @param {LoincContextInput} context - LOINC code or context
   * @returns {Promise<string | null>} Concept code
   */
  async code(context) {

    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.code : null;
  }

  /**
   * @param {LoincContextInput} context - LOINC code or context
   * @returns {Promise<string | null>} Display string
   */
  async display(context) {

    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return null;
    }

    // Check supplements first
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }

    // Use language-aware display logic
    if (this.opContext.langs && !this.opContext.langs.isEnglishOrNothing()) {
      const displays = await this.#getDisplaysForContext(ctxt, this.opContext.langs);
      const requestedLanguages = Array.isArray(this.opContext.langs.languages)
        ? this.opContext.langs.languages
        : (Array.isArray(this.opContext.langs.langs) ? this.opContext.langs.langs : []);

      // Try to find exact language match
      for (const lang of requestedLanguages) {
        for (const display of displays) {
          if (lang.matches(display.language, true)) {
            return display.value;
          }
        }
      }

      // Try partial language match
      for (const lang of requestedLanguages) {
        for (const display of displays) {
          if (lang.matches(display.language, false)) {
            return display.value;
          }
        }
      }
    }

    return ctxt.desc || '';
  }

  /**
   * @param {LoincContextInput} context - LOINC code or context
   * @returns {Promise<null>} Definition, if any
   */
  async definition(context) {
    await this.#ensureContext(context);
    return null; // LOINC doesn't provide definitions
  }

  /**
   * @param {LoincContextInput} context - LOINC code or context
   * @returns {Promise<boolean>} Whether concept is abstract
   */
  async isAbstract(context) {
    await this.#ensureContext(context);
    return false; // LOINC codes are not abstract
  }

  /**
   * @param {LoincContextInput} context - LOINC code or context
   * @returns {Promise<boolean>} Whether concept is inactive
   */
  async isInactive(context) {
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.status == 'DISCOURAGED' : false;
  }

  /**
   * @param {LoincContextInput} context - LOINC code or context
   * @returns {Promise<string | null>} Concept status
   */
  async getStatus(context) {
    const ctxt = await this.#ensureContext(context);
    return !ctxt || ctxt.status == 'NotStated' ? null : ctxt.status;
  }

  /**
   * @param {LoincContextInput} context - LOINC code or context
   * @returns {Promise<boolean>} Whether concept is deprecated
   */
  async isDeprecated(context) {
    await this.#ensureContext(context);
    return false; // Handle via status if needed
  }

  /**
   * @param {LoincContextInput} context - LOINC code or context
   * @param {any} displays - Designation collector
   * @returns {Promise<void>}
   */
  async designations(context, displays) {
    const ctxt = await this.#ensureContext(context);
    if (ctxt) {
      // Add main display
      displays.addDesignation(true, 'active', 'en-US', CodeSystem.makeUseForDisplay(), ctxt.desc.trim());

      // Add cached designations — load into local array then assign atomically.
      // This avoids duplication from concurrent pushes and allows retry if a prior load failed.
      if (ctxt.displays.length === 0) {
        const loaded = await this.#loadDesignationsForContext(ctxt);
        if (ctxt.displays.length === 0) {
          ctxt.displays = loaded;
        }
      }

      for (const entry of ctxt.displays) {
        let use = undefined;
        if (entry.dtype) {
          use = {
            system: 'http://loinc.org',
            code: entry.dtype,
            display: entry.dtype
          }
        }
        if (!use) {
          use = entry.display ? CodeSystem.makeUseForDisplay() : null;
        }
        displays.addDesignation(false, 'active', entry.lang, use, entry.value.trim());
      }

      // Add supplement designations
      this._listSupplementDesignations(ctxt.code, displays);
    }

  }

  /**
   * @param {LoincContextInput} ctxt - LOINC code or context
   * @param {string[]} props - Requested properties
   * @param {any[]} params - Parameters array
   * @returns {Promise<void>}
   */
  async extendLookup(ctxt, props, params) {
    validateArrayParameter(props, 'props', String);
    validateArrayParameter(params, 'params', Object);

    if (typeof ctxt === 'string') {
      const located = await this.locate(ctxt);
      if (!located.context) {
        throw new Error(located.message || `LOINC code '${ctxt}' not found`);
      }
      ctxt = located.context;
    }

    if (!(ctxt instanceof LoincProviderContext)) {
      throw new Error('Invalid context for LOINC lookup');
    }

    // Run all property queries in parallel — they're independent reads on the same key
    await Promise.all([
      this.#addRelationshipProperties(ctxt, props, params),
      this.#addConceptProperties(ctxt, props,params),
      this.#addStatusProperty(ctxt, props,params),
      this.#addRelatedNames(ctxt, props,params)
    ]);
  }

  /**
   * @param {number} kind - LOINC context kind
   * @returns {string} Designation use
   */
  #getDesignationUse(kind) {
    switch (kind) {
      case LoincProviderContextKind.CODE:
        return 'LONG_COMMON_NAME';
      case LoincProviderContextKind.PART:
        return 'PartDisplayName';
      default:
        return 'LONG_COMMON_NAME';
    }
  }

  /**
   * @param {LoincProviderContext} ctxt - LOINC context
   * @param {string[]} props - Requested properties
   * @param {any[]} params - Parameters array
   * @returns {Promise<void>}
   */
  async #addRelationshipProperties(ctxt, props, params) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT RelationshipTypes.Description as Relationship, Codes.Code, Codes.Description as Value
          FROM Relationships, RelationshipTypes, Codes
          WHERE Relationships.SourceKey = ?
            AND Relationships.RelationshipTypeKey = RelationshipTypes.RelationshipTypeKey
            AND Relationships.TargetKey = Codes.CodeKey
      `;

      db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {LoincRelationshipRow[]} */ (rows)) {
            if (this._hasProp(props, row.Relationship, true)) {
              this._addCodeProperty(params, 'property', row.Relationship, row.Code);
            }
          }
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {LoincProviderContext} ctxt - LOINC context
   * @param {string[]} props - Requested properties
   * @param {any[]} params - Parameters array
   * @returns {Promise<void>}
   */
  async #addConceptProperties(ctxt, props, params) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT PropertyTypes.Description, PropertyValues.Value
          FROM Properties, PropertyTypes, PropertyValues
          WHERE Properties.CodeKey = ?
            AND Properties.PropertyTypeKey = PropertyTypes.PropertyTypeKey
            AND Properties.PropertyValueKey = PropertyValues.PropertyValueKey
      `;

      db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {Array<{Description: string, Value: string}>} */ (rows)) {
            if (this._hasProp(props, row.Description, true)) {
              if (row.Description == 'CLASSTYPE') {
                this._addStringProperty(params, 'property', row.Description, classTypes[row.Value])
                  .part.push({name: 'description', valueString: row.Value});
              } else {
                this._addStringProperty(params, 'property', row.Description, row.Value);
              }
            }
          }
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {LoincProviderContext} ctxt - LOINC context
   * @param {string[]} props - Requested properties
   * @param {any[]} params - Parameters array
   * @returns {Promise<void>}
   */
  async #addStatusProperty(ctxt, props, params) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = 'SELECT StatusKey FROM Codes WHERE CodeKey = ? AND StatusKey != 0';

      db.get(sql, [ctxt.key], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          const statusRow = /** @type {{StatusKey: number | string}} */ (row);
          const statusDesc = this.statusCodes.get(statusRow.StatusKey.toString());
          if (statusRow.StatusKey && statusDesc) {
            if (this._hasProp(props, 'STATUS', true)) {
              this._addStringProperty(params, 'property', 'STATUS', statusDesc);
            }
          }
          resolve(undefined);
        } else {
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {LoincProviderContext} ctxt - LOINC context
   * @param {string[]} props - Requested properties
   * @param {any[]} params - Parameters array
   * @returns {Promise<void>}
   */
  async #addRelatedNames(ctxt, props, params) {
    const loaded = await this.#loadRelatedNames(ctxt);
    for (let d of loaded) {
      if (this._hasProp(props, 'RELATEDNAMES2', true)) {
        this._addProperty(params, 'property', 'RELATEDNAMES2', d.value, d.lang);
      }
    }
  }

  /**
   * @param {LoincProviderContext} ctxt - LOINC context
   * @param {string[]} props - Requested properties
   * @param {any[]} params - Parameters array
   * @returns {Promise<void>}
   */
  async #addAllDesignations(ctxt, props, params) {
    if (!this._hasProp(props, 'designation', true)) {
      return;
    }

    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT Languages.Code as Lang, DescriptionTypes.Description as DType, Descriptions.Value
          FROM Descriptions, Languages, DescriptionTypes
          WHERE Descriptions.CodeKey = ?
            AND Descriptions.DescriptionTypeKey != 4 
          AND Descriptions.DescriptionTypeKey = DescriptionTypes.DescriptionTypeKey 
          AND Descriptions.LanguageKey = Languages.LanguageKey
      `;

      db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {LoincDescriptionRow[]} */ (rows)) {
            this._addProperty(params, 'designation', row.DType || '', row.Value, row.Lang);
          }
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {LoincProviderContext} ctxt - LOINC context
   * @param {Languages | null | undefined} langs - Requested languages
   * @returns {Promise<LoincDisplay[]>} Displays
   */
  async #getDisplaysForContext(ctxt, langs) {
    validateOptionalParameter(langs, "langs", Languages);
    const displays = [new LoincDisplay('en-US', ctxt.desc)];
    const db = this.#requireDb();

    return new Promise((resolve, reject) => {
      const sql = `
          SELECT Languages.Code as Lang, Descriptions.Value
          FROM Descriptions, Languages
          WHERE Descriptions.CodeKey = ?
            AND Descriptions.DescriptionTypeKey IN (1,2,5)
            AND Descriptions.LanguageKey = Languages.LanguageKey
          ORDER BY DescriptionTypeKey
      `;

      db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {LoincDescriptionRow[]} */ (rows)) {
            displays.push(new LoincDisplay(row.Lang, row.Value));
          }

          // Add supplement displays
          this.#addSupplementDisplays(displays, ctxt.code);

          resolve(displays);
        }
      });
    });
  }

  /**
   * @param {LoincDisplay[]} displays - Display accumulator
   * @param {string} code - LOINC code
   * @returns {void}
   */
  #addSupplementDisplays(displays, code) {
    if (this.supplements) {
      for (const supplement of this.supplements) {
        const concept = supplement.getConceptByCode(code);
        if (concept) {
          if (concept.display) {
            displays.push(new LoincDisplay(supplement.jsonObj.language || 'en', concept.display));
          }
          if (concept.designation) {
            for (const designation of concept.designation) {
              const lang = designation.language || supplement.jsonObj.language || 'en';
              displays.push(new LoincDisplay(lang, designation.value));
            }
          }
        }
      }
    }
  }

  /**
   * @param {LoincProviderContext} ctxt - LOINC context
   * @returns {Promise<DescriptionCacheEntry[]>} Designations
   */
  async #loadDesignationsForContext(ctxt) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT Languages.Code as Lang, DescriptionTypes.Description as DType, Descriptions.Value
          FROM Descriptions, Languages, DescriptionTypes
          WHERE Descriptions.CodeKey = ?
            AND Descriptions.DescriptionTypeKey != 4
            AND Descriptions.DescriptionTypeKey = DescriptionTypes.DescriptionTypeKey
            AND Descriptions.LanguageKey = Languages.LanguageKey
      `;

      db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          /** @type {DescriptionCacheEntry[]} */
          const results = [];
          for (const row of /** @type {LoincDescriptionRow[]} */ (rows)) {
            const isDisplay = row.DType === 'LONG_COMMON_NAME';
            results.push(new DescriptionCacheEntry(isDisplay, row.Lang, row.Value, row.DType || ''));
          }
          resolve(results);
        }
      });
    });
  }

  /**
   * @param {LoincProviderContext} ctxt - LOINC context
   * @returns {Promise<DescriptionCacheEntry[]>} Related names
   */
  async #loadRelatedNames(ctxt) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT Languages.Code as Lang, Descriptions.Value
          FROM Descriptions, Languages
          WHERE Descriptions.CodeKey = ?
            AND Descriptions.DescriptionTypeKey = 4
            AND Descriptions.LanguageKey = Languages.LanguageKey
      `;

      db.all(sql, [ctxt.key], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          /** @type {DescriptionCacheEntry[]} */
          const results = [];
          for (const row of /** @type {LoincDescriptionRow[]} */ (rows)) {
            results.push(new DescriptionCacheEntry(false, row.Lang, row.Value, 'RELATEDNAMES2'));
          }
          resolve(results);
        }
      });
    });
  }

  /**
   * @param {LoincContextInput} context - LOINC code or context
   * @returns {Promise<LoincProviderContext | null>} Resolved context
   */
  async #ensureContext(context) {
    if (!context) {
      return null;
    }
    if (typeof context === 'string') {
      const ctxt = await this.locate(context);
      if (!ctxt.context) {
        throw new Error(ctxt.message || `LOINC code '${context}' not found`);
      } else {
        return ctxt.context;
      }
    }
    if (context instanceof LoincProviderContext) {
      return context;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof context));
  }

  /**
   * @returns {SqliteDatabase} Open database
   */
  #requireDb() {
    if (!this.db) {
      throw new Error('LOINC database is closed');
    }
    return this.db;
  }

  // Lookup methods
  /**
   * @param {string | null | undefined} code - LOINC code
   * @returns {Promise<LoincLocateResult>} Locate result
   */
  async locate(code) {

    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const context = this.codes.get(code);
    if (context) {
      return { context: context, message: null };
    }

    return { context: null, message: undefined };
  }

  // Iterator methods
  /**
   * @param {LoincContextInput} context - Parent context
   * @returns {Promise<LoincIteratorContext>} Iterator context
   */
  async iterator(context) {


    if (!context) {
      // Iterate all codes starting from first code
      return new LoincIteratorContext(null, this.allKeys);
    } else {
      const ctxt = await this.#ensureContext(context);
      if (ctxt && ctxt.kind === LoincProviderContextKind.PART && ctxt.children) {
        return new LoincIteratorContext(ctxt, ctxt.children);
      } else {
        return new LoincIteratorContext(ctxt, []);
      }
    }
  }

  /**
   * @param {LoincIteratorContext} iteratorContext - Iterator context
   * @returns {Promise<LoincProviderContext | null>} Next context
   */
  async nextContext(iteratorContext) {


    if (!iteratorContext.more()) {
      return null;
    }

    const key = iteratorContext.keys[iteratorContext.current];
    iteratorContext.next();

    return this.codeList[key];
  }

  // Filter support
  /**
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<boolean>} Whether this filter is supported
   */
  async doesFilter(prop, op, value) {
    // Relationship filters
    if (this.relationships.has(prop) && ['=', 'in', 'exists', 'regex'].includes(op)) {
      return true;
    }

    // Property filters
    if (this.propertyList.has(prop) && ['=', 'in', 'exists', 'regex'].includes(op)) {
      return true;
    }

    // Status filter
    if (prop === 'STATUS' && op === '=' && this.statusKeys.has(value)) {
      return true;
    }

    // LIST filter
    if (prop === 'LIST' && op === '=' && this.codes.has(value)) {
      return true;
    }

    // CLASSSTYPE filter
    if (prop === 'CLASSTYPE' && op === '=' && ["1", "2", "3", "4"].includes(value)) {
      return true;
    }

    // answers-for filter
    if (prop === 'answers-for' && op === '=') {
      return true;
    }

    // concept filters
    if (prop === 'concept' && ['is-a', 'descendent-of', '=', 'in', 'not-in'].includes(op)) {
      return true;
    }

    // code filters (VSAC workaround)
    if (prop === 'code' && ['is-a', 'descendent-of', '='].includes(op)) {
      return true;
    }

    // copyright filter
    if (prop === 'copyright' && op === '=' && ['LOINC', '3rdParty'].includes(value)) {
      return true;
    }

    return false;
  }

  /**
   * @param {boolean} iterate - Whether filters are for iteration
   * @returns {Promise<LoincPrep>} Filter preparation context
   */
  async getPrepContext(iterate) {
    return new LoincPrep(iterate);
  }

  /**
   * @param {LoincPrep} filterContext - Filter context
   * @param {boolean} forIteration - Whether filter is for iteration
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<void>}
   */
  async filter(filterContext, forIteration, prop, op, value) {
    const filter = new LoincFilterHolder();
    await this.#executeFilterQuery(prop, op, value, filter);
    filterContext.filters.push(filter);
  }

  /**
   * @param {LoincPrep} filterContext - Filter context
   * @param {{filter: string}} filterText - Text filter
   * @param {boolean} sort - Whether descending sort is requested
   * @returns {Promise<void>}
   */
  async searchFilter(filterContext, filterText, sort) {
    const filter = new LoincFilterHolder();
    await this.#executeFilterQuery('$text', (sort ? '>' : '<'), filterText.filter, filter);
    filterContext.filters.push(filter);
  }

  /**
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @param {LoincFilterHolder} filter - Filter holder
   * @returns {Promise<void>}
   */
  async #executeFilterQuery(prop, op, value, filter) {
    let sql = '';
    let lsql = '';

    // LIST filter
    if (prop === 'LIST' && op === '=' && this.codes.has(value)) {
      sql = `SELECT DISTINCT TargetKey as Key FROM Relationships
             WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
               AND SourceKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
             ORDER BY TargetKey ASC`;
      lsql = `SELECT COUNT(DISTINCT TargetKey) FROM Relationships
              WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
                AND SourceKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                AND TargetKey = `;
    }
    // answers-for filter
    else if (prop === 'answers-for' && op === '=') {
      if (value.startsWith('LL')) {
        sql = `SELECT DISTINCT TargetKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
                 AND SourceKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT TargetKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
                  AND SourceKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                  AND TargetKey = `;
      } else {
        sql = `SELECT DISTINCT TargetKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
                 AND SourceKey IN (
                   SELECT SourceKey FROM Relationships
                   WHERE RelationshipTypeKey = ${this.relationships.get('answers-for')}
                 AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                   )
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT TargetKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get('Answer')}
                  AND SourceKey IN (SELECT SourceKey FROM Relationships
                                    WHERE RelationshipTypeKey = ${this.relationships.get('answers-for')}
                                      AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}'))
                  AND TargetKey = `;
      }
    }
    // Relationship equal filter
    else if (this.relationships.has(prop) && op === '=') {
      if (this.codes.has(value)) {
        sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                 AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                  AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                  AND SourceKey = `;
      } else {
        sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                 AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Description = '${this.#sqlWrapString(value)}' COLLATE NOCASE)
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                  AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Description = '${this.#sqlWrapString(value)}' COLLATE NOCASE)
                  AND SourceKey = `;
      }
    }
    // Relationship 'in' filter
    else if (this.relationships.has(prop) && op === 'in') {
      const codes = this.#commaListOfCodes(value);
      sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
             WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
               AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code IN (${codes}))
             ORDER BY SourceKey ASC`;
      lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
              WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                AND TargetKey IN (SELECT CodeKey FROM Codes WHERE Code IN (${codes}))
                AND SourceKey = `;
    }
    // Relationship 'exists' filter
    else if (this.relationships.has(prop) && op === 'exists') {
      if (this.codes.has(value)) {
        sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                 AND EXISTS (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                  AND EXISTS (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                  AND SourceKey = `;
      } else {
        sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                 AND EXISTS (SELECT CodeKey FROM Codes WHERE Description = '${this.#sqlWrapString(value)}' COLLATE NOCASE)
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                  AND EXISTS (SELECT CodeKey FROM Codes WHERE Description = '${this.#sqlWrapString(value)}' COLLATE NOCASE)
                  AND SourceKey = `;
      }
    }
    // Relationship regex filter
    else if (this.relationships.has(prop) && op === 'regex') {
      const matchingKeys = await this.#findRegexMatches(
        `SELECT CodeKey as Key, Description FROM Codes
         WHERE CodeKey IN (SELECT TargetKey FROM Relationships WHERE RelationshipTypeKey = ${this.relationships.get(prop)})`,
        value,
        'Description'
      );
      if (matchingKeys.length > 0) {
        sql = `SELECT DISTINCT SourceKey as Key FROM Relationships
               WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                 AND TargetKey IN (${matchingKeys.join(',')})
               ORDER BY SourceKey ASC`;
        lsql = `SELECT COUNT(DISTINCT SourceKey) FROM Relationships
                WHERE RelationshipTypeKey = ${this.relationships.get(prop)}
                  AND TargetKey IN (${matchingKeys.join(',')})
                  AND SourceKey = `;
      }
    }
    // Property equal filter (with CLASSTYPE handling)
    else if (this.propertyList.has(prop) && op === '=') {
      let actualValue = value;
      if (prop === 'CLASSTYPE' && ['1', '2', '3', '4'].includes(value)) {
        actualValue = classTypes[value];
      }
      sql = `SELECT DISTINCT CodeKey as Key FROM Properties, PropertyValues
             WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
               AND Properties.PropertyValueKey = PropertyValues.PropertyValueKey
               AND PropertyValues.Value = '${this.#sqlWrapString(actualValue)}' COLLATE NOCASE
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(DISTINCT CodeKey) FROM Properties, PropertyValues
              WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
                AND Properties.PropertyValueKey = PropertyValues.PropertyValueKey
                AND PropertyValues.Value = '${this.#sqlWrapString(actualValue)}' COLLATE NOCASE
                AND CodeKey = `;
    }
    // Property 'in' filter
    else if (this.propertyList.has(prop) && op === 'in') {
      const codes = this.#commaListOfCodes(value);
      sql = `SELECT DISTINCT CodeKey as Key FROM Properties, PropertyValues
             WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
               AND Properties.PropertyValueKey = PropertyValues.PropertyValueKey
               AND PropertyValues.Value IN (${codes}) COLLATE NOCASE
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(DISTINCT CodeKey) FROM Properties, PropertyValues
              WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
                AND Properties.PropertyValueKey = PropertyValues.PropertyValueKey
                AND PropertyValues.Value IN (${codes}) COLLATE NOCASE
                AND CodeKey = `;
    }
    // Property 'exists' filter
    else if (this.propertyList.has(prop) && op === 'exists') {
      sql = `SELECT DISTINCT CodeKey as Key FROM Properties
             WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(CodeKey) FROM Properties
              WHERE Properties.PropertyTypeKey = ${this.propertyList.get(prop)}
                AND CodeKey = `;
    }
    // Property regex filter
    else if (this.propertyList.has(prop) && op === 'regex') {
      const matchingKeys = await this.#findRegexMatches(
        `SELECT PropertyValueKey, Value FROM PropertyValues
         WHERE PropertyValueKey IN (SELECT PropertyValueKey FROM Properties WHERE PropertyTypeKey = ${this.propertyList.get(prop)})`,
        value,
        'Value',
        'PropertyValueKey'
      );
      if (matchingKeys.length > 0) {
        sql = `SELECT DISTINCT CodeKey as Key FROM Properties
               WHERE PropertyTypeKey = ${this.propertyList.get(prop)}
                 AND PropertyValueKey IN (${matchingKeys.join(',')})
               ORDER BY CodeKey ASC`;
        lsql = `SELECT COUNT(DISTINCT CodeKey) FROM Properties
                WHERE PropertyTypeKey = ${this.propertyList.get(prop)}
                  AND PropertyValueKey IN (${matchingKeys.join(',')})
                  AND CodeKey = `;
      }
    }
    // Status filter
    else if (prop === 'STATUS' && op === '=' && this.statusKeys.has(value)) {
      sql = `SELECT CodeKey as Key FROM Codes
             WHERE StatusKey = ${this.statusKeys.get(value)}
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(CodeKey) FROM Codes
              WHERE StatusKey = ${this.statusKeys.get(value)}
                AND CodeKey = `;
    }
    // Concept hierarchy filters (is-a, descendent-of)
    else if (prop === 'concept' && ['is-a', 'descendent-of'].includes(op)) {
      sql = `SELECT DescendentKey as Key FROM Closure
             WHERE AncestorKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
             ORDER BY DescendentKey ASC`;
      lsql = `SELECT COUNT(DescendentKey) FROM Closure
              WHERE AncestorKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                AND DescendentKey = `;
    }
    // Concept equal filter (workaround for VSAC misuse)
    else if (prop === 'concept' && op === '=') {
      sql = `SELECT CodeKey as Key FROM Codes
             WHERE Code = '${this.#sqlWrapString(value)}'
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(CodeKey) FROM Codes
              WHERE Code = '${this.#sqlWrapString(value)}'
                AND CodeKey = `;
    }
    // Concept 'in' filter (workaround for VSAC misuse)
    else if (prop === 'concept' && op === 'in') {
      const codes = this.#commaListOfCodes(value);
      sql = `SELECT CodeKey as Key FROM Codes
             WHERE Code IN (${codes})
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(CodeKey) FROM Codes
              WHERE Code IN (${codes})
                AND CodeKey = `;
    }
    // Code property filters (workaround for VSAC misuse)
    else if (prop === 'code' && ['is-a', 'descendent-of'].includes(op)) {
      sql = `SELECT DescendentKey as Key FROM Closure
             WHERE AncestorKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
             ORDER BY DescendentKey ASC`;
      lsql = `SELECT COUNT(DescendentKey) FROM Closure
              WHERE AncestorKey IN (SELECT CodeKey FROM Codes WHERE Code = '${this.#sqlWrapString(value)}')
                AND DescendentKey = `;
    }
    else if (prop === 'code' && op === '=') {
      sql = `SELECT CodeKey as Key FROM Codes
             WHERE Code = '${this.#sqlWrapString(value)}'
             ORDER BY CodeKey ASC`;
      lsql = `SELECT COUNT(CodeKey) FROM Codes
              WHERE Code = '${this.#sqlWrapString(value)}'
                AND CodeKey = `;
    }
    // Copyright filters
    else if (prop === 'copyright' && op === '=') {
      if (value === 'LOINC') {
        sql = `SELECT CodeKey as Key FROM Codes
               WHERE NOT CodeKey IN (SELECT CodeKey FROM Properties WHERE PropertyTypeKey = 9)
               ORDER BY CodeKey ASC`;
        lsql = `SELECT COUNT(CodeKey) FROM Codes
                WHERE NOT CodeKey IN (SELECT CodeKey FROM Properties WHERE PropertyTypeKey = 9)
                  AND CodeKey = `;
      } else if (value === '3rdParty') {
        sql = `SELECT CodeKey as Key FROM Codes
               WHERE CodeKey IN (SELECT CodeKey FROM Properties WHERE PropertyTypeKey = 9)
               ORDER BY CodeKey ASC`;
        lsql = `SELECT COUNT(CodeKey) FROM Codes
                WHERE CodeKey IN (SELECT CodeKey FROM Properties WHERE PropertyTypeKey = 9)
                  AND CodeKey = `;
      }
    } else if (prop === '$text' && (op === '>' || op === '<')) {
      sql = `SELECT CodeKey as Key FROM Codes
             WHERE Description like '%${sqlEscapeString(value)}%'
             ORDER BY Description `+(op === '<' ? 'ASC' : 'DESC');
      lsql = `SELECT COUNT(CodeKey) as Key FROM Codes
             WHERE Codes.Description like '%${sqlEscapeString(value)}%'
             AND TargetKey = `;
    }

    if (sql) {
      await this.#executeSQL(sql, filter);
      filter.lsql = lsql;
    } else {
      throw new Error(`The filter "${prop} ${op} ${value}" is not supported for LOINC`);
    }
  }

// Helper method for regex matching
  /**
   * @param {string} sql - SQL query returning candidate rows
   * @param {string} pattern - Regex pattern
   * @param {string} valueColumn - Column to test
   * @param {string} keyColumn - Column containing returned key
   * @returns {Promise<number[]>} Matching keys
   */
  async #findRegexMatches(sql, pattern, valueColumn, keyColumn = 'Key') {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const regex = regexUtilities.compile(pattern);
      /** @type {number[]} */
      const matchingKeys = [];

      db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {Array<Record<string, any>>} */ (rows)) {
            if (regex.test(row[valueColumn])) {
              matchingKeys.push(Number(row[keyColumn]));
            }
          }
          resolve(matchingKeys);
        }
      });
    });
  }

// Helper method for comma-separated code lists
  /**
   * @param {string} source - Comma-separated code list
   * @returns {string} SQL-quoted code list
   */
  #commaListOfCodes(source) {
    const codes = source.split(',')
      .filter(s => this.codes.has(s.trim()))
      .map(s => `'${this.#sqlWrapString(s.trim())}'`);
    return codes.join(',');
  }

  /**
   * @param {string} sql - SQL query
   * @param {LoincFilterHolder} filter - Filter holder
   * @returns {Promise<void>}
   */
  async #executeSQL(sql, filter) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          filter.keys = /** @type {LoincKeyRow[]} */ (rows)
            .map(row => row.Key)
            .filter(key => key !== 0);
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {string} str - String to quote for SQL
   * @returns {string} Escaped SQL string
   */
  #sqlWrapString(str) {
    return str.replace(/'/g, "''");
  }

  /**
   * @param {LoincPrep} filterContext - Filter context
   * @returns {Promise<LoincFilterHolder[]>} Filters
   */
  async executeFilters(filterContext) {

    return filterContext.filters;
  }

  /**
   * @param {LoincPrep} filterContext - Filter context
   * @param {LoincFilterHolder} set - Filter set
   * @returns {Promise<number>} Number of keys
   */
  async filterSize(filterContext, set) {
    return set.keys.length;
  }

  /**
   * @param {LoincPrep} filterContext - Filter context
   * @param {LoincFilterHolder} set - Filter set
   * @returns {Promise<boolean>} Whether another concept is available
   */
  async filterMore(filterContext, set) {

    set.cursor = set.cursor || 0;
    return set.cursor < set.keys.length;
  }

  /**
   * @param {LoincPrep} filterContext - Filter context
   * @param {LoincFilterHolder} set - Filter set
   * @returns {Promise<LoincProviderContext | null>} Current concept
   */
  async filterConcept(filterContext, set) {


    if (set.cursor >= set.keys.length) {
      return null;
    }

    const key = set.keys[set.cursor];
    set.cursor++;

    return this.codeList[key];
  }

  /**
   * @param {LoincPrep} filterContext - Filter context
   * @param {LoincFilterHolder} set - Filter set
   * @param {string} code - LOINC code
   * @returns {Promise<LoincProviderContext | string | null>} Located concept, message, or null
   */
  async filterLocate(filterContext, set, code) {
    const context = this.codes.get(code);
    if (!context) {
      return `Not a valid code: ${code}`;
    }

    if (!set.lsql) {
      return 'Filter not understood';
    }

    // Check if this context's key is in the filter
    if (set.hasKey(context.key)) {
      return context;
    } else {
      return null; // `Code ${code} is not in the specified filter`;
    }
  }

  /**
   * @param {LoincPrep} filterContext - Filter context
   * @param {LoincFilterHolder} set - Filter set
   * @param {unknown} concept - Concept to test
   * @returns {Promise<boolean>} Whether concept is in the filter
   */
  async filterCheck(filterContext, set, concept) {
    if (!(concept instanceof LoincProviderContext)) {
      return false;
    }

    return set.hasKey(concept.key);
  }

  // Subsumption testing
  /**
   * @param {LoincContextInput} codeA - First code or context
   * @param {LoincContextInput} codeB - Second code or context
   * @returns {Promise<string>} Subsumption result
   */
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);

    return 'not-subsumed'; // Not implemented yet
  }

  versionAlgorithm() {
    return 'natural';
  }

  /**
   * @param {{use?: {code?: string}}} designation - Designation
   * @returns {boolean} Whether designation is a display
   */
  isDisplay(designation) {
    return designation.use?.code == "SHORTNAME" || designation.use?.code == "LONG_COMMON_NAME" || designation.use?.code == "LinguisticVariantDisplayName";
  }
}

class LoincServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param {any} i18n - Translation support
   * @param {string} dbPath - Path to LOINC SQLite database
   */
  constructor(i18n, dbPath) {
    super(i18n);
    this.dbPath = dbPath;
    this.uses = 0;
    this._loaded = false;
    /** @type {LoincSharedData | null} */
    this._sharedData = null;
  }

  system() {
    return 'http://loinc.org';
  }

  version() {
    return this.#sharedData()._version;
  }

  name() {
    return 'LOINC';
  }

  /**
   * @returns {LoincSharedData} Loaded shared data
   */
  #sharedData() {
    if (!this._sharedData) {
      throw new Error('LOINC shared data is not loaded');
    }
    return this._sharedData;
  }

  /**
   * @returns {Promise<void>}
   */
  async #ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async load() {
    const db = new sqlite3.Database(this.dbPath);

    // Enable performance optimizations
    await this.#optimizeDatabase(db);

    try {
      this._sharedData = /** @type {LoincSharedData} */ ({
        langs: new Map(),
        codes: new Map(),
        codeList: [null],
        allKeys: [],
        relationships: new Map(),
        propertyList: new Map(),
        statusKeys: new Map(),
        statusCodes: new Map(),
        _version: '',
        root: '',
        firstCodeKey: 0
      });

      // Load small lookup tables in parallel
      // eslint-disable-next-line no-unused-vars
      const [langs, statusCodes, relationships, propertyList, config] = await Promise.all([
        this.#loadLanguages(db),
        this.#loadStatusCodes(db),
        this.#loadRelationshipTypes(db),
        this.#loadPropertyTypes(db),
        this.#loadConfig(db)
      ]);

      // Load codes (largest operation)
      await this.#loadCodes(db);

      // Load dependent data in parallel
      await Promise.all([
        // this.#loadDesignationsCache(db),
        this.#loadHierarchy(db)
      ]);

    } finally {
      db.close();
    }
    this._loaded = true;
  }

  /**
   * @param {SqliteDatabase} db - LOINC database
   * @returns {Promise<void>}
   */
  async #optimizeDatabase(db) {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA synchronous = NORMAL');
        db.run('PRAGMA cache_size = 10000');
        db.run('PRAGMA temp_store = MEMORY');
        db.run('PRAGMA mmap_size = 268435456'); // 256MB

        // Ensure indexes exist for per-request query patterns
        db.run('CREATE INDEX IF NOT EXISTS idx_descriptions_codekey_typkey ON Descriptions(CodeKey, DescriptionTypeKey)');
        db.run('CREATE INDEX IF NOT EXISTS idx_relationships_sourcekey ON Relationships(SourceKey)');
        db.run('CREATE INDEX IF NOT EXISTS idx_properties_codekey ON Properties(CodeKey)', (err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      });
    });
  }

  /**
   * @param {SqliteDatabase} db - LOINC database
   * @returns {Promise<void>}
   */
  async #loadLanguages(db) {
    const sharedData = this.#sharedData();
    return new Promise((resolve, reject) => {
      db.all('SELECT LanguageKey, Code FROM Languages', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {LoincLanguageRow[]} */ (rows)) {
            sharedData.langs.set(row.Code, row.LanguageKey);
          }
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {SqliteDatabase} db - LOINC database
   * @returns {Promise<void>}
   */
  async #loadStatusCodes(db) {
    const sharedData = this.#sharedData();
    return new Promise((resolve, reject) => {
      db.all('SELECT StatusKey, Description FROM StatusCodes', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {LoincStatusRow[]} */ (rows)) {
            sharedData.statusKeys.set(row.Description, row.StatusKey.toString());
            sharedData.statusCodes.set(row.StatusKey.toString(), row.Description);
          }
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {SqliteDatabase} db - LOINC database
   * @returns {Promise<void>}
   */
  async #loadRelationshipTypes(db) {
    const sharedData = this.#sharedData();
    return new Promise((resolve, reject) => {
      db.all('SELECT RelationshipTypeKey, Description FROM RelationshipTypes', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {LoincRelationshipTypeRow[]} */ (rows)) {
            sharedData.relationships.set(row.Description, row.RelationshipTypeKey.toString());
          }
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {SqliteDatabase} db - LOINC database
   * @returns {Promise<void>}
   */
  async #loadPropertyTypes(db) {
    const sharedData = this.#sharedData();
    return new Promise((resolve, reject) => {
      db.all('SELECT PropertyTypeKey, Description FROM PropertyTypes', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {LoincPropertyTypeRow[]} */ (rows)) {
            sharedData.propertyList.set(row.Description, row.PropertyTypeKey.toString());
          }
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {SqliteDatabase} db - LOINC database
   * @returns {Promise<void>}
   */
  async #loadCodes(db) {
    const sharedData = this.#sharedData();
    return new Promise((resolve, reject) => {
      // First get the count to pre-allocate array
      db.get('SELECT MAX(CodeKey) as maxKey FROM Codes', (err, row) => {
        if (err) return reject(err);

        // Pre-allocate the array to avoid repeated resizing
        const maxKey = row ? (/** @type {{maxKey?: number}} */ (row).maxKey || 0) : 0;
        sharedData.codeList = new Array(maxKey + 1).fill(null);

        // Now load all codes
        db.all('SELECT CodeKey, Code, Type, Codes.Description, StatusCodes.Description as Status FROM Codes, StatusCodes where StatusCodes.StatusKey = Codes.StatusKey order by Type Asc, CodeKey Asc', (err, rows) => {
          if (err) return reject(err);

          // Batch process rows
          for (const row of /** @type {LoincCodeRow[]} */ (rows)) {
            const context = new LoincProviderContext(
              row.CodeKey,
              row.Type - 1,
              row.Code,
              row.Description,
              row.Status
            );

            sharedData.codes.set(row.Code, context);
            sharedData.codeList[row.CodeKey] = context;
            sharedData.allKeys.push(row.CodeKey);

            if (sharedData.firstCodeKey === 0 && context.kind === LoincProviderContextKind.CODE) {
              sharedData.firstCodeKey = context.key;
            }
          }
          resolve(undefined);
        });
      });
    });
  }

  /**
   * @param {SqliteDatabase} db - LOINC database
   * @returns {Promise<void>}
   */
  async #loadDesignationsCache(db) {
    const sharedData = this.#sharedData();
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT
              d.CodeKey,
              l.Code as Lang,
              dt.Description as DType,
              d.Value,
              dt.Description = 'LONG_COMMON_NAME' as IsDisplay
          FROM Descriptions d
                   JOIN Languages l ON d.LanguageKey = l.LanguageKey
                   JOIN DescriptionTypes dt ON d.DescriptionTypeKey = dt.DescriptionTypeKey
          WHERE d.DescriptionTypeKey != 4
          ORDER BY d.CodeKey
      `;

      db.all(sql, (err, rows) => {
        if (err) return reject(err);

        // Batch process by CodeKey to reduce lookups
        /** @type {number | null} */
        let currentKey = null;
        /** @type {LoincProviderContext | null} */
        let currentContext = null;

        for (const row of /** @type {Array<LoincDescriptionRow & {CodeKey: number}>} */ (rows)) {
          if (row.CodeKey !== currentKey) {
            currentKey = row.CodeKey;
            currentContext = sharedData.codeList[currentKey];
          }

          if (currentContext) {
            currentContext.displays.push(
              new DescriptionCacheEntry(row.IsDisplay === true || row.IsDisplay === 1, row.Lang, row.Value, row.DType || '')
            );
          }
        }
        resolve(undefined);
      });
    });
  }

  /**
   * @param {SqliteDatabase} db - LOINC database
   * @returns {Promise<void>}
   */
  async #loadHierarchy(db) {
    const sharedData = this.#sharedData();
    const childRelKey = sharedData.relationships.get('child');
    if (!childRelKey) {
      return; // No child relationships defined
    }

    return new Promise((resolve, reject) => {
      const sql = `
          SELECT SourceKey, TargetKey FROM Relationships
          WHERE RelationshipTypeKey = ${childRelKey}
      `;

      db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {LoincHierarchyRow[]} */ (rows)) {
            if (row.SourceKey !== 0 && row.TargetKey !== 0) {
              const parentContext = sharedData.codeList[row.SourceKey];
              if (parentContext) {
                parentContext.addChild(row.TargetKey);
              }
            }
          }
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {SqliteDatabase} db - LOINC database
   * @returns {Promise<void>}
   */
  async #loadConfig(db) {
    const sharedData = this.#sharedData();
    return new Promise((resolve, reject) => {
      db.all('SELECT ConfigKey, Value FROM Config WHERE ConfigKey IN (2, 3)', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {LoincConfigRow[]} */ (rows)) {
            if (row.ConfigKey === 2) {
              sharedData._version = row.Value;
            } else if (row.ConfigKey === 3) {
              sharedData.root = row.Value;
            }
          }
          resolve(undefined);
        }
      });
    });
  }

  defaultVersion() {
    return this._sharedData?._version || 'unknown';
  }

  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @returns {Promise<LoincServices>} New provider
   */
  async build(opContext, supplements) {
    await this.#ensureLoaded();
    this.recordUse();

    // Create read-only database connection for this provider instance
    const db = await new Promise((resolve, reject) => {
      const conn = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) reject(err);
        else resolve(conn);
      });
    });
    const conn = /** @type {SqliteDatabase} */ (db);
    // Apply performance PRAGMAs to per-request connection
    await new Promise((resolve, reject) => {
      conn.serialize(() => {
        conn.run('PRAGMA cache_size = 10000');
        conn.run('PRAGMA temp_store = MEMORY');
        conn.run('PRAGMA mmap_size = 268435456', (err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      });
    });

    return new LoincServices(opContext, supplements, conn, this.#sharedData());
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  /**
   * @param {string} url - ValueSet URL
   * @param {string | null | undefined} version - Requested version
   * @returns {Promise<LoincValueSetLike | null>} Known ValueSet or null
   */
  async buildKnownValueSet(url, version) {

    if (version && version != this.version()) {
      return null;
    }
    if (!url.startsWith('http://loinc.org/vs')) {
      return null;
    }
    if (url == 'http://loinc.org/vs') {
      // All LOINC codes
      return {
        resourceType: 'ValueSet', url: 'http://loinc.org/vs', version: this.version(), status: 'active',
        name: 'LOINC Value Set - all LOINC codes', description: 'All LOINC codes',
        date: new Date().toISOString(), experimental: false,
        compose: { include: [{ system: this.system() }] }
      };
    }

    if (url.startsWith('http://loinc.org/vs/')) {
      const code = url.substring(20);
      const ci = this.#sharedData().codes.get(code);
      if (!ci) {
        return null;
      }

      if (ci.kind === LoincProviderContextKind.PART) {
        // Part-based value set with ancestor filter
        return {
          resourceType: 'ValueSet',  url: url, version: this.version(), status: 'active',
          name: 'LOINCValueSetFor' + ci.code.replace(/-/g, '_'), description: 'LOINC value set for code ' + ci.code + ': ' + ci.desc,
          date: new Date().toISOString(),  experimental: false,
          compose: { include: [{ system: this.system(), filter: [{ property: 'ancestor', op: '=', value: code }] }]
          }
        };
      }

      if (ci.kind === LoincProviderContextKind.LIST) {
        // Answer list - enumerate concepts from database
        const concepts = await this.#getAnswerListConcepts(ci.key);
        return {
          resourceType: 'ValueSet', url: url, version: this.version(), status: 'active',
          name: 'LOINCAnswerList' + ci.code.replace(/-/g, '_'),  description: 'LOINC Answer list for code ' + ci.code + ': ' + ci.desc,
          date: new Date().toISOString(), experimental: false,
          compose: { include: [{ system: this.system(), concept: concepts }] }
        };
      }
    }

    return null;
  }

  /**
   * Get answer list concepts from database
   * @param {number} sourceKey - Key of the answer list
   * @returns {Promise<Array<{code: string}>>} Array of {code} objects
   */
  async #getAnswerListConcepts(sourceKey) {
    const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY);
    try {
      const sql = `
          SELECT Code, Description
          FROM Relationships, Codes
          WHERE SourceKey = ?
            AND RelationshipTypeKey = 40
            AND Relationships.TargetKey = Codes.CodeKey
      `;

      const rows = await new Promise((resolve, reject) => {
        db.all(sql, [sourceKey], (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      return /** @type {LoincAnswerListRow[]} */ (rows).map(row => ({ code: row.Code }));
    } finally {
      await new Promise((resolve) => db.close(() => resolve(undefined)));
    }
  }

  id() {
    return "loinc"+this.version();
  }
}

module.exports = {
  LoincServices,
  LoincServicesFactory,
  LoincProviderContext,
  LoincProviderContextKind
};
