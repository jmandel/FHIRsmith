// @ts-check

const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const csApi = require('./cs-api');
const CodeSystemProvider = /** @type {any} */ (csApi.CodeSystemProvider);
const CodeSystemFactoryProvider = /** @type {any} */ (csApi.CodeSystemFactoryProvider);
const {validateArrayParameter} = require("../../library/utilities");

/** @typedef {import('sqlite3').Database} SqliteDatabase */
/** @typedef {string | NdcConcept | null | undefined} NdcContextInput */
/** @typedef {{context: NdcConcept | null, message?: string | null}} NdcLocateResult */
/** @typedef {{types: Map<number, string>, organizations: Map<number, string>, doseForms: Map<number, string>, routes: Map<number, string>}} NdcLookupTables */
/** @typedef {'types' | 'organizations' | 'doseForms' | 'routes'} NdcLookupTableName */
/** @typedef {{type: 'code-type', value: '10-digit' | '11-digit' | 'product', _iterator?: {offset: number, hasMore: boolean}}} NdcFilter */
/** @typedef {{active?: boolean, tradeName?: string, suffix?: string, type?: number, doseForm?: number, route?: number, company?: number, category?: string, generics?: string, productCode?: string, code11?: string, originalCode?: string, display?: string}} NdcFullConceptData */
/** @typedef {{NDCKey: number, Code: string, Code11?: string, ProductCode?: string, PCode?: string, Active: number, TradeName?: string, Suffix?: string, Description?: string, Type?: number, DoseForm?: number, Route?: number, Company?: number, Category?: string, Generics?: string}} NdcRow */
/** @typedef {{Version: string}} NdcVersionRow */
/** @typedef {{count: number}} NdcCountRow */
/** @typedef {{NDCKey: number, Name: string}} NdcLookupRow */

class NdcConcept {
  /**
   * @param {string} code - NDC code
   * @param {string | null | undefined} display - Display text
   * @param {boolean} isPackage - Whether this is a package code
   * @param {number | null} key - Database key
   */
  constructor(code, display, isPackage = false, key = null) {
    this.code = code;
    this.display = display;
    this.isPackage = isPackage;
    this.key = key;

    // Additional NDC-specific properties
    /** @type {string | null} */
    this.productCode = null; // For packages, the related product code
    /** @type {string | null} */
    this.code11 = null; // 11-digit version for packages
    this.active = true;
    /** @type {Record<string, any>} */
    this.properties = {}; // Store additional properties from database
  }
}

class NdcServices extends CodeSystemProvider {
  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @param {SqliteDatabase | null} db - Open NDC database
   * @param {NdcLookupTables | null} lookupTables - Loaded lookup tables
   * @param {number | null} packageCount - Number of packages
   * @param {number | null} productCount - Number of products
   * @param {string | null} version - NDC data version
   */
  constructor(opContext, supplements, db, lookupTables, packageCount, productCount, version) {
    super(opContext, supplements);
    /** @type {SqliteDatabase | null} */
    this.db = db;
    this._version = version;
    this._lookupTables = lookupTables || { types: new Map(), organizations: new Map(), doseForms: new Map(), routes: new Map() };
    this._packageCount = packageCount || 0;
    this._productCount = productCount || 0;
  }

  // Clean up database connection when provider is destroyed
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // Metadata methods
  system() {
    return 'http://hl7.org/fhir/sid/ndc'; // NDC system URI
  }

  version() {
    return this._version;
  }

  description() {
    return 'National Drug Code (NDC) Directory';
  }

  name() {
    return 'NDC Codes';
  }

  async totalCount() {
    return this._packageCount + this._productCount;
  }

  /**
   * @returns {boolean} Whether the code system has parent relationships
   */
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
    return super.hasAnyDisplays(langs);
  }

  // Core concept methods
  /**
   * @param {NdcContextInput} code - NDC code or context
   * @returns {Promise<string | null>} NDC code
   */
  async code(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt ? ctxt.code : null;
  }

  /**
   * @param {NdcContextInput} code - NDC code or context
   * @returns {Promise<string | null>} Display string
   */
  async display(code) {
    
    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }

    // Check supplements first
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }

    return ctxt.display ? ctxt.display.trim() : '';
  }

  /**
   * @param {NdcContextInput} code - NDC code or context
   * @returns {Promise<null>} Definition, if any
   */
  async definition(code) {
    await this.#ensureContext(code);
    return null; // No definitions provided in NDC
  }

  /**
   * @param {NdcContextInput} code - NDC code or context
   * @returns {Promise<boolean>} Whether the concept is abstract
   */
  async isAbstract(code) {
    await this.#ensureContext(code);
    return false; // No abstract concepts in NDC
  }

  /**
   * @param {NdcContextInput} code - NDC code or context
   * @returns {Promise<boolean>} Whether the concept is inactive
   */
  async isInactive(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt ? !ctxt.active : false;
  }

  /**
   * @param {NdcContextInput} code - NDC code or context
   * @returns {Promise<string>} Concept status
   */
  async getStatus(code) {

    const ctxt = await this.#ensureContext(code);
    return ctxt && ctxt.active ? "active" : "inactive";
  }

  /**
   * @param {NdcContextInput} code - NDC code or context
   * @returns {Promise<boolean>} Whether the concept is deprecated
   */
  async isDeprecated(code) {
    await this.#ensureContext(code);
    return false; // NDC doesn't track deprecated status separately
  }

  /**
   * @param {NdcContextInput} code - NDC code or context
   * @param {any} displays - Designation collector
   * @returns {Promise<void>}
   */
  async designations(code, displays) {
    const ctxt = await this.#ensureContext(code);

    if (ctxt) {
      // Add main display
      if (ctxt.display) {
        displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), ctxt.display.trim());
      }

      // Add supplement designations
      this._listSupplementDesignations(ctxt.code, displays);
    }
  }

  /**
   * @param {NdcContextInput} ctxt - NDC code or context
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
        throw new Error(located.message || `NDC Code '${ctxt}' not found`);
      }
      ctxt = located.context;
    }

    if (!(ctxt instanceof NdcConcept)) {
      throw new Error('Invalid context for NDC lookup');
    }

    // Get full data for the concept
    const fullData = await this.#getFullConceptData(ctxt);

    // Add NDC-specific properties
    if (!ctxt.isPackage) {
      // Product properties
      this.#addProperty(params, 'code-type', 'product');
      this.#addProperty(params, 'description', fullData.display || '');
    } else {
      // Package properties
      if (ctxt.code.includes('-')) {
        this.#addProperty(params, 'code-type', '10-digit');
        if (fullData.code11) {
          this.#addProperty(params, 'synonym', fullData.code11);
        }
      } else {
        this.#addProperty(params, 'code-type', '11-digit');
        if (fullData.originalCode) {
          this.#addProperty(params, 'synonym', fullData.originalCode);
        }
      }
      this.#addProperty(params, 'description', fullData.display || '');
      if (fullData.productCode) {
        this.#addProperty(params, 'product', fullData.productCode);
      }
    }

    // Common properties
    if (fullData.type && this._lookupTables.types.has(fullData.type)) {
      this.#addProperty(params, 'type', this._lookupTables.types.get(fullData.type) || '');
    }

    this.#addProperty(params, 'active', fullData.active ? 'true' : 'false');

    if (fullData.tradeName) {
      this.#addProperty(params, 'trade-name', fullData.tradeName);
    }

    if (fullData.doseForm && this._lookupTables.doseForms.has(fullData.doseForm)) {
      this.#addProperty(params, 'dose-form', this._lookupTables.doseForms.get(fullData.doseForm) || '');
    }

    if (fullData.route && this._lookupTables.routes.has(fullData.route)) {
      this.#addProperty(params, 'route', this._lookupTables.routes.get(fullData.route) || '');
    }

    if (fullData.company && this._lookupTables.organizations.has(fullData.company)) {
      this.#addProperty(params, 'company', this._lookupTables.organizations.get(fullData.company) || '');
    }

    if (fullData.category) {
      this.#addProperty(params, 'category', fullData.category);
    }

    if (fullData.generics) {
      this.#addProperty(params, 'generic', fullData.generics);
    }
  }

  /**
   * @param {any[]} params - Parameters array
   * @param {string} name - Property code
   * @param {string} value - Property value
   * @returns {void}
   */
  #addProperty(params, name, value) {
    // This follows the FHIR Parameters structure for lookup responses
    // Each property becomes a parameter with name='property' and sub-parameters
    const property = {
      name: 'property',
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueString: value }
      ]
    };

    params.push(property);
  }

  /**
   * @param {NdcConcept} concept - NDC concept
   * @returns {Promise<NdcFullConceptData>} Full concept data
   */
  async #getFullConceptData(concept) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      let sql, params;

      if (concept.isPackage) {
        sql = `
          SELECT p.Code as PCode, pkg.Code, pkg.Code11, pkg.Active, pkg.Description,
                 p.TradeName, p.Suffix, p.Type, p.DoseForm, p.Route, p.Company, 
                 p.Category, p.Generics
          FROM NDCProducts p
          JOIN NDCPackages pkg ON p.NDCKey = pkg.ProductKey
          WHERE pkg.NDCKey = ?
        `;
        params = [concept.key];
      } else {
        sql = `
          SELECT Code, TradeName, Suffix, Type, DoseForm, Route, Company, 
                 Category, Generics, Active
          FROM NDCProducts 
          WHERE NDCKey = ?
        `;
        params = [concept.key];
      }

      db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else if (!row) {
          resolve({});
        } else {
          const ndcRow = /** @type {NdcRow} */ (row);
          const result = /** @type {NdcFullConceptData} */ ({
            active: ndcRow.Active === 1,
            tradeName: ndcRow.TradeName,
            suffix: ndcRow.Suffix,
            type: ndcRow.Type,
            doseForm: ndcRow.DoseForm,
            route: ndcRow.Route,
            company: ndcRow.Company,
            category: ndcRow.Category,
            generics: ndcRow.Generics
          });

          if (concept.isPackage) {
            result.productCode = ndcRow.PCode;
            result.code11 = ndcRow.Code11;
            result.originalCode = ndcRow.Code;
            result.display = this.#packageDisplay(ndcRow);
          } else {
            result.display = this.#productDisplay(ndcRow);
          }

          resolve(result);
        }
      });
    });
  }

  /**
   * @param {NdcRow} row - Product row
   * @returns {string} Product display
   */
  #productDisplay(row) {
    const tradeName = row.TradeName || '';
    const suffix = row.Suffix || '';
    if (suffix) {
      return `${tradeName} ${suffix} (product)`.trim();
    }
    return `${tradeName} (product)`.trim();
  }

  /**
   * @param {NdcRow} row - Package row
   * @returns {string} Package display
   */
  #packageDisplay(row) {
    const tradeName = row.TradeName || '';
    const suffix = row.Suffix || '';
    const description = row.Description || '';

    let display = tradeName;
    if (suffix) {
      display += ` ${suffix}`;
    }
    if (description) {
      display += `, ${description}`;
    }
    display += ' (package)';

    return display.replace(/\s+/g, ' ').trim();
  }

  /**
   * @param {NdcContextInput} code - NDC code or context
   * @returns {Promise<NdcConcept | null>}
   */
  async #ensureContext(code) {
    if (!code) {
      return null;
    }
    if (typeof code === 'string') {
      const ctxt = await this.locate(code);
      if (!ctxt.context) {
        throw new Error(ctxt.message || `NDC Code '${code}' not found`);
      } else {
        return ctxt.context;
      }
    }
    if (code instanceof NdcConcept) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof code));
  }

  /**
   * @returns {SqliteDatabase}
   */
  #requireDb() {
    if (!this.db) {
      throw new Error('NDC database is closed');
    }
    return this.db;
  }

  // Lookup methods
  /**
   * @param {string | null | undefined} code - NDC code
   * @returns {Promise<NdcLocateResult>} Located concept and status message
   */
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    // First try packages (both regular code and code11)
    const packageResult = await this.#locateInPackages(code);
    if (packageResult) {
      return { context: packageResult, message: null };
    }

    // Then try products
    const productResult = await this.#locateInProducts(code);
    if (productResult) {
      return { context: productResult, message: null };
    }

    return { context: null, message: undefined };
  }

  /**
   * @param {string} code - NDC package code
   * @returns {Promise<NdcConcept | null>} Located package
   */
  async #locateInPackages(code) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      // Try both regular code and code11 formats
      const sql = `
        SELECT pkg.NDCKey, pkg.Code, pkg.Code11, p.TradeName, p.Suffix, pkg.Description,
               p.Code as ProductCode, pkg.Active
        FROM NDCPackages pkg
        JOIN NDCProducts p ON pkg.ProductKey = p.NDCKey
        WHERE pkg.Code = ? OR pkg.Code11 = ?
        LIMIT 1
      `;

      db.get(sql, [code, code], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          const ndcRow = /** @type {NdcRow} */ (row);
          const concept = new NdcConcept(code, this.#packageDisplay(ndcRow), true, ndcRow.NDCKey);
          concept.productCode = ndcRow.ProductCode || null;
          concept.code11 = ndcRow.Code11 || null;
          concept.active = ndcRow.Active === 1;
          resolve(concept);
        } else {
          resolve(null);
        }
      });
    });
  }

  /**
   * @param {string} code - NDC product code
   * @returns {Promise<NdcConcept | null>} Located product
   */
  async #locateInProducts(code) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT NDCKey, Code, TradeName, Suffix, Active
        FROM NDCProducts
        WHERE Code = ?
        LIMIT 1
      `;

      db.get(sql, [code], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          const ndcRow = /** @type {NdcRow} */ (row);
          const concept = new NdcConcept(code, this.#productDisplay(ndcRow), false, ndcRow.NDCKey);
          concept.active = ndcRow.Active === 1;
          resolve(concept);
        } else {
          resolve(null);
        }
      });
    });
  }

  // Filter support for code-type filtering
  /**
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<boolean>} Whether this filter is supported
   */
  async doesFilter(prop, op, value) {
    
    return prop === 'code-type' &&
      op === '=' &&
      ['10-digit', '11-digit', 'product'].includes(value);
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {boolean} forIteration - Whether the filter is for iteration
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<NdcFilter>}
   */
  async filter(filterContext, forIteration, prop, op, value) {
    

    if (prop === 'code-type' && op === '=') {
      const filter = /** @type {NdcFilter} */ ({ type: 'code-type', value: value });
      filterContext.filters.push(filter);
      return filter;
    }

    throw new Error(`The filter "${prop} ${op} ${value}" is not supported for NDC`);
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @returns {Promise<NdcFilter[]>} Filters to execute
   */
  async executeFilters(filterContext) {
    
    return filterContext.filters;
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {NdcFilter} set - Filter set
   * @returns {Promise<number>} Number of filtered codes
   */
  async filterSize(filterContext, set) {
    

    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      let sql;

      switch (set.value) {
        case 'product':
          sql = 'SELECT COUNT(*) as count FROM NDCProducts';
          break;
        case '10-digit':
          sql = "SELECT COUNT(*) as count FROM NDCPackages WHERE Code LIKE '%-%'";
          break;
        case '11-digit':
          sql = "SELECT COUNT(*) as count FROM NDCPackages WHERE Code NOT LIKE '%-%'";
          break;
        default:
          resolve(0);
          return;
      }

      db.get(sql, (err, row) => {
        if (err) reject(err);
        else resolve(row ? /** @type {NdcCountRow} */ (row).count : 0);
      });
    });
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {NdcFilter} set - Filter set
   * @returns {Promise<boolean>} Whether another concept is available
   */
  async filterMore(filterContext, set) {
    
    if (!set._iterator) {
      set._iterator = { offset: 0, hasMore: true };
    }
    return set._iterator.hasMore;
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {NdcFilter} set - Filter set
   * @returns {Promise<NdcConcept | null>} Current filtered concept
   */
  async filterConcept(filterContext, set) {
    

    if (!set._iterator) {
      set._iterator = { offset: 0, hasMore: true };
    }

    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      let sql;

      switch (set.value) {
        case 'product':
          sql = 'SELECT NDCKey, Code, TradeName, Suffix, Active FROM NDCProducts LIMIT 1 OFFSET ?';
          break;
        case '10-digit':
          sql = `
            SELECT pkg.NDCKey, pkg.Code, p.TradeName, p.Suffix, pkg.Description, pkg.Active
            FROM NDCPackages pkg
            JOIN NDCProducts p ON pkg.ProductKey = p.NDCKey
            WHERE pkg.Code LIKE '%-%'
            LIMIT 1 OFFSET ?
          `;
          break;
        case '11-digit':
          sql = `
            SELECT pkg.NDCKey, pkg.Code, p.TradeName, p.Suffix, pkg.Description, pkg.Active
            FROM NDCPackages pkg
            JOIN NDCProducts p ON pkg.ProductKey = p.NDCKey
            WHERE pkg.Code NOT LIKE '%-%'
            LIMIT 1 OFFSET ?
          `;
          break;
        default:
          resolve(null);
          return;
      }

      const iterator = /** @type {{offset: number, hasMore: boolean}} */ (set._iterator);
      db.get(sql, [iterator.offset], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          const ndcRow = /** @type {NdcRow} */ (row);
          iterator.offset++;

          let concept;
          if (set.value === 'product') {
            concept = new NdcConcept(ndcRow.Code, this.#productDisplay(ndcRow), false, ndcRow.NDCKey);
          } else {
            concept = new NdcConcept(ndcRow.Code, this.#packageDisplay(ndcRow), true, ndcRow.NDCKey);
          }
          concept.active = ndcRow.Active === 1;

          resolve(concept);
        } else {
          iterator.hasMore = false;
          resolve(null);
        }
      });
    });
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {NdcFilter} set - Filter set
   * @param {string} code - NDC code
   * @returns {Promise<NdcConcept | string | null | undefined>} Matching concept or rejection message
   */
  async filterLocate(filterContext, set, code) {
    

    // First locate the code normally
    const located = await this.locate(code);
    if (!located.context) {
      return located.message;
    }

    const concept = located.context;

    // Check if it matches the filter
    switch (set.value) {
      case 'product':
        return concept.isPackage ? 'Code is a package, not a product' : concept;
      case '10-digit':
        return (!concept.isPackage || !concept.code.includes('-')) ?
          'Code is not a 10-digit package code' : concept;
      case '11-digit':
        return (!concept.isPackage || concept.code.includes('-')) ?
          'Code is not an 11-digit package code' : concept;
      default:
        return 'Unknown filter type';
    }
  }

  /**
   * @param {any} filterContext - Filter execution context
   * @param {NdcFilter} set - Filter set
   * @param {NdcContextInput} concept - NDC code or context
   * @returns {Promise<boolean>} Whether the concept passes the filter
   */
  async filterCheck(filterContext, set, concept) {
    

    if (!(concept instanceof NdcConcept)) {
      return false;
    }

    switch (set.value) {
      case 'product':
        return !concept.isPackage;
      case '10-digit':
        return concept.isPackage && concept.code.includes('-');
      case '11-digit':
        return concept.isPackage && !concept.code.includes('-');
      default:
        return false;
    }
  }

  // Iterator methods - not supported for NDC

  versionAlgorithm() {
    return 'date';
  }
}

class NdcServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param {any} i18n - Translation support
   * @param {string} dbPath - Path to the NDC SQLite database
   */
  constructor(i18n, dbPath) {
    super(i18n);
    this.dbPath = dbPath;
    this.uses = 0;
    this._loaded = false;
    /** @type {NdcLookupTables | null} */
    this._lookupTables = null;
    /** @type {number | null} */
    this._packageCount = null;
    /** @type {number | null} */
    this._productCount = null;
    /** @type {string | null} */
    this._version = null;
  }

  system() {
    return 'http://hl7.org/fhir/sid/ndc'; // NDC system URI
  }

  version() {
    return this._version;
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

  /**
   * @returns {Promise<void>}
   */
  async #ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  async load() {
    // Use temporary database connection for loading
    const tempDb = new sqlite3.Database(this.dbPath);

    try {
      // Load version
      this._version = await new Promise((resolve, reject) => {
        tempDb.get('SELECT Version FROM NDCVersion ORDER BY Version DESC LIMIT 1', (err, row) => {
          if (err) reject(err);
          else resolve(row ? /** @type {NdcVersionRow} */ (row).Version : 'unknown');
        });
      });

      // Initialize lookup tables
      this._lookupTables = {
        types: new Map(),
        organizations: new Map(),
        doseForms: new Map(),
        routes: new Map()
      };

      // Load lookup tables
      /** @type {Array<{name: NdcLookupTableName, sql: string}>} */
      const tables = [
        { name: 'types', sql: 'SELECT NDCKey, Name FROM NDCProductTypes' },
        { name: 'organizations', sql: 'SELECT NDCKey, Name FROM NDCOrganizations' },
        { name: 'doseForms', sql: 'SELECT NDCKey, Name FROM NDCDoseForms' },
        { name: 'routes', sql: 'SELECT NDCKey, Name FROM NDCRoutes' }
      ];

      for (const table of tables) {
        await new Promise((resolve, reject) => {
          tempDb.all(table.sql, (err, rows) => {
            if (err) reject(err);
            else {
              const lookupTables = /** @type {NdcLookupTables} */ (this._lookupTables);
              const map = lookupTables[table.name];
              rows.forEach(row => {
                const lookupRow = /** @type {NdcLookupRow} */ (row);
                map.set(lookupRow.NDCKey, lookupRow.Name);
              });
              resolve(undefined);
            }
          });
        });
      }

      // Load counts
      this._packageCount = await new Promise((resolve, reject) => {
        tempDb.get('SELECT COUNT(NDCKey) as count FROM NDCPackages', (err, row) => {
          if (err) reject(err);
          else resolve(row ? /** @type {NdcCountRow} */ (row).count : 0);
        });
      });

      this._productCount = await new Promise((resolve, reject) => {
        tempDb.get('SELECT COUNT(NDCKey) as count FROM NDCProducts', (err, row) => {
          if (err) reject(err);
          else resolve(row ? /** @type {NdcCountRow} */ (row).count : 0);
        });
      });

    } finally {
      tempDb.close();
    }
    this._loaded = true;
  }

  defaultVersion() {
    return this._version || 'unknown';
  }

  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @returns {Promise<NdcServices>} New provider
   */
  async build(opContext, supplements) {
    
    this.recordUse();

    // Create fresh database connection for this provider instance
    const db = new sqlite3.Database(this.dbPath);

    return new NdcServices(
      opContext, supplements,
      db,
      this._lookupTables,
      this._packageCount,
      this._productCount,
      this._version
    );
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  name() {
    return 'NDC Codes';
  }


  id() {
    return 'ndc';
  }
}

module.exports = {
  NdcServices,
  NdcServicesFactory,
  NdcConcept
};
