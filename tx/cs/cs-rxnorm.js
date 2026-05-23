// @ts-check

const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const csApi = require('./cs-api');
const CodeSystemProvider = /** @type {any} */ (csApi.CodeSystemProvider);
const CodeSystemFactoryProvider = /** @type {any} */ (csApi.CodeSystemFactoryProvider);
const {Designations} = require("../library/designations");
const {validateArrayParameter, formatDateMMDDYYYY} = require("../../library/utilities");

/** @typedef {import('sqlite3').Database} SqliteDatabase */
/** @typedef {string | RxNormConcept | null | undefined} RxNormContextInput */
/** @typedef {{context: RxNormConcept | null, message?: string | null}} RxNormLocateResult */
/** @typedef {{version: string, rels: string[], reltypes: string[], totalCodeCount: number}} RxNormSharedData */
/** @typedef {Record<string, string>} RxNormSqlParams */
/** @typedef {{RXCUI?: string, SCUI?: string, STR: string, TTY?: string, suppress?: string, version?: string | number, [key: string]: any}} RxNormRow */
/** @typedef {{stems: string[]}} RxNormSearchFilter */

// Context for RxNorm concepts
class RxNormConcept {
  /**
   * @param {string} code - RxNorm/NCI code
   * @param {string} display - Display text
   */
  constructor(code, display = '') {
    this.code = code;
    this.display = display;
    /** @type {string[]} */
    this.others = []; // Array of alternative displays (SY terms, etc.)
    this.archived = false;
  }
}

// Filter holder for query building and iteration
class RxNormFilterHolder {
  constructor() {
    this.sql = '';
    this.text = false; // Whether this is a text search filter
    /** @type {RxNormSqlParams} */
    this.params = {}; // Parameters for the SQL query
    this.cursor = 0;
    /** @type {RxNormRow[] | null} */
    this.results = null; // Will hold query results for iteration
    this.executed = false;
  }
}

// Filter preparation context
class RxNormPrep {
  constructor() {
    /** @type {RxNormFilterHolder[]} */
    this.filters = [];
  }
}

// Iterator context
class RxNormIteratorContext {
  /**
   * @param {string} query - SQL query
   * @param {RxNormSqlParams} params - SQL parameters
   */
  constructor(query, params = {}) {
    this.query = query;
    this.params = params;
    this.cursor = 0;
    /** @type {RxNormRow[] | null} */
    this.results = null;
    this.executed = false;
  }

  /**
   * @returns {boolean} Whether another row is available
   */
  more() {
    return this.cursor < (this.results ? this.results.length : 0);
  }

  /**
   * @returns {void}
   */
  next() {
    this.cursor++;
  }
}

class RxNormServices extends CodeSystemProvider {
  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @param {SqliteDatabase | null} db - Open RxNorm database
   * @param {RxNormSharedData} sharedData - Shared data loaded by factory
   * @param {boolean} isNCI - Whether this is NCI metadata
   */
  constructor(opContext, supplements, db, sharedData, isNCI = false) {
    super(opContext, supplements);
    /** @type {SqliteDatabase | null} */
    this.db = db;
    this.isNCI = isNCI;

    // Shared data from factory
    this.dbVersion = sharedData.version;
    this.rels = sharedData.rels;
    this.reltypes = sharedData.reltypes;
    this.totalCodeCount = sharedData.totalCodeCount;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // Metadata methods
  system() {
    return this.isNCI ? 'http://ncimeta.nci.nih.gov' : 'http://www.nlm.nih.gov/research/umls/rxnorm';
  }

  version() {
    return this.dbVersion;
  }

  description() {
    return this.isNCI ? 'NCI Metathesaurus' : 'RxNorm';
  }

  name() {
    return this.isNCI ? 'NCI' : 'RxNorm';
  }

  async totalCount() {
    return this.totalCodeCount;
  }

  /**
   * @returns {string} Source abbreviation
   */
  getSAB() {
    return this.isNCI ? 'NCI' : 'RXNORM';
  }

  /**
   * @returns {string} Source code field name
   */
  getCodeField() {
    return this.isNCI ? 'SCUI' : 'RXCUI';
  }

  /**
   * @returns {boolean} Whether the code system has parent relationships
   */
  hasParents() {
    return true; // RxNorm has relationships
  }

  // Core concept methods
  /**
   * @param {RxNormContextInput} context - Code or context
   * @returns {Promise<string | null>} Concept code
   */
  async code(context) {
    
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.code : null;
  }

  /**
   * @param {RxNormContextInput} context - Code or context
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

    return ctxt.display || '';
  }

  /**
   * @param {RxNormContextInput} context - Code or context
   * @returns {Promise<null>} Definition, if any
   */
  async definition(context) {
    await this.#ensureContext(context);
    return null; // RxNorm doesn't provide definitions
  }

  /**
   * @param {RxNormContextInput} context - Code or context
   * @returns {Promise<boolean>} Whether the concept is abstract
   */
  async isAbstract(context) {
    await this.#ensureContext(context);

    return false; // RxNorm codes are not abstract
  }

  /**
   * @param {RxNormContextInput} context - Code or context
   * @returns {Promise<string | null>} Concept status
   */
  async getStatus(context) {

    const ctxt = await this.#ensureContext(context);

    if (!ctxt) {
      return null;
    }
    if (ctxt.archived) {
      return 'archived';
    }

    // Check suppress flag
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `SELECT suppress FROM rxnconso WHERE ${this.getCodeField()} = ? AND SAB = ? AND TTY <> 'SY'`;

      db.get(sql, [ctxt.code, this.getSAB()], (err, row) => {
        if (err) {
          reject(err);
        } else {
          const rxRow = row ? /** @type {RxNormRow} */ (row) : null;
          resolve(rxRow ? rxRow.suppress === '1' ? 'suppressed' : null : null);
        }
      });
    });
  }

  /**
   * @param {RxNormContextInput} context - Code or context
   * @returns {Promise<boolean>} Whether the concept is inactive
   */
  async isInactive(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (!ctxt) {
      return false;
    }
    if (ctxt.archived) {
      return true;
    }

    // Check suppress flag
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `SELECT suppress FROM rxnconso WHERE ${this.getCodeField()} = ? AND SAB = ? AND TTY <> 'SY'`;

      db.get(sql, [ctxt.code, this.getSAB()], (err, row) => {
        if (err) {
          reject(err);
        } else {
          const rxRow = row ? /** @type {RxNormRow} */ (row) : null;
          resolve(rxRow ? rxRow.suppress === '1' : false);
        }
      });
    });
  }

  /**
   * @param {RxNormContextInput} context - Code or context
   * @returns {Promise<boolean>} Whether the concept is deprecated
   */
  async isDeprecated(context) {
    
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.archived : false;
  }

  /**
   * @param {RxNormContextInput} context - Code or context
   * @param {any} displays - Designation collector
   * @returns {Promise<void>}
   */
  async designations(context, displays) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt) {
      // Add main display
      displays.addDesignation(true, 'active', 'en-US', CodeSystem.makeUseForDisplay(), ctxt.display);

      // Add other displays
      for (const other of ctxt.others) {
        displays.addDesignation(false, 'active', 'en-US', null, other);
      }

      // Add supplement designations
      this._listSupplementDesignations(ctxt.code, displays);
    }
  }

  /**
   * @param {RxNormContextInput} context - Code or context
   * @returns {Promise<RxNormConcept | null>}
   */
  async #ensureContext(context) {
    if (!context) {
      return null;
    }
    if (typeof context === 'string') {
      const ctxt = await this.locate(context);
      if (!ctxt.context) {
        throw new Error(ctxt.message || `Code '${context}' not found in ${this.name()}`);
      } else {
        return ctxt.context;
      }
    }
    if (context instanceof RxNormConcept) {
      return context;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof context));
  }

  /**
   * @returns {SqliteDatabase}
   */
  #requireDb() {
    if (!this.db) {
      throw new Error('RxNorm database is closed');
    }
    return this.db;
  }

  // Lookup methods
  /**
   * @param {string | null | undefined} code - Code to locate
   * @returns {Promise<RxNormLocateResult>} Locate result
   */
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      let sql = `SELECT STR, TTY FROM rxnconso WHERE ${this.getCodeField()} = ? AND SAB = ?`;

      db.all(sql, [code, this.getSAB()], (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        if (rows.length === 0) {
          // Try archive
          sql = `SELECT STR, TTY FROM RXNATOMARCHIVE WHERE ${this.getCodeField()} = ? AND SAB = ?`;
          db.all(sql, [code, this.getSAB()], (err, archiveRows) => {
            if (err) {
              reject(err);
              return;
            }

            if (archiveRows.length === 0) {
              resolve({ context: null, message: undefined});
              return;
            }

            const concept = this.#createConceptFromRows(code, /** @type {RxNormRow[]} */ (archiveRows), true);
            resolve({ context: concept, message: null });
          });
        } else {
          const concept = this.#createConceptFromRows(code, /** @type {RxNormRow[]} */ (rows), false);
          resolve({ context: concept, message: null });
        }
      });
    });
  }

  /**
   * @param {string} code - Concept code
   * @param {RxNormRow[]} rows - Database rows
   * @param {boolean} archived - Whether the concept is archived
   * @returns {RxNormConcept} Concept
   */
  #createConceptFromRows(code, rows, archived) {
    const concept = new RxNormConcept(code);
    concept.archived = archived;

    for (const row of rows) {
      if (row.TTY === 'SY' || concept.display && concept.display) {
        concept.others.push(row.STR.trim());
      } else {
        concept.display = row.STR.trim();
      }
    }

    return concept;
  }

  // Iterator methods
  /**
   * @param {RxNormContextInput} context - Optional context
   * @returns {Promise<RxNormIteratorContext>} Iterator context
   */
  async iterator(context) {
    

    if (!context) {
      // Iterate all codes
      const query = `SELECT ${this.getCodeField()}, STR FROM rxnconso WHERE SAB = ? AND TTY <> 'SY' ORDER BY ${this.getCodeField()}`;
      return new RxNormIteratorContext(query, { sab: this.getSAB() });
    } else {
      // No hierarchical iteration for specific contexts in this implementation
      return new RxNormIteratorContext('', {});
    }
  }

  /**
   * @param {RxNormIteratorContext} iteratorContext - Iterator context
   * @returns {Promise<RxNormConcept | null>} Next concept
   */
  async nextContext(iteratorContext) {
    

    if (!iteratorContext.executed) {
      await this.#executeIterator(iteratorContext);
    }

    if (!iteratorContext.more()) {
      return null;
    }

    const row = iteratorContext.results ? iteratorContext.results[iteratorContext.cursor] : null;
    if (!row) {
      return null;
    }
    iteratorContext.next();

    const concept = new RxNormConcept(row[this.getCodeField()], row.STR);
    return concept;
  }

  /**
   * @param {RxNormIteratorContext} iteratorContext - Iterator context
   * @returns {Promise<void>}
   */
  async #executeIterator(iteratorContext) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      db.all(iteratorContext.query, Object.values(iteratorContext.params), (err, rows) => {
        if (err) {
          reject(err);
        } else {
          iteratorContext.results = /** @type {RxNormRow[]} */ (rows);
          iteratorContext.executed = true;
          resolve(undefined);
        }
      });
    });
  }

  // Filter support
  /**
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<boolean>} Whether this filter is supported
   */
  async doesFilter(prop, op, value) {
    

    const propUC = prop.toUpperCase();

    // TTY filters
    if (propUC === 'TTY' && ['=', 'in'].includes(op)) {
      return true;
    }

    // STY filter
    if (propUC === 'STY' && op === '=') {
      return true;
    }

    // SAB filter
    if (propUC === 'SAB' && op === '=') {
      return true;
    }

    // Relationship filters (REL values like 'SY', 'RN', etc.)
    if (this.rels.includes(prop) && op === '=' && (value.startsWith('CUI:') || value.startsWith('AUI:'))) {
      return true;
    }

    // Relationship type filters (RELA values)
    if (this.reltypes.includes(prop) && op === '=' && (value.startsWith('CUI:') || value.startsWith('AUI:'))) {
      return true;
    }

    return false;
  }

  /**
   * @param {boolean} iterate - Whether filters will be iterated
   * @returns {Promise<RxNormPrep>} Filter prep context
   */
  // eslint-disable-next-line no-unused-vars
  async getPrepContext(iterate) {
    return new RxNormPrep();
  }

  /**
   * @param {RxNormPrep} filterContext - Filter context
   * @param {boolean} forIteration - Whether the filter is for iteration
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<void>}
   */
  async filter(filterContext, forIteration, prop, op, value) {
    

    const filter = new RxNormFilterHolder();
    const propUC = prop.toUpperCase();

    let sql = '';
    /** @type {RxNormSqlParams} */
    const params = {};

    if (op === 'in' && propUC === 'TTY') {
      const values = value.split(',').map(v => v.trim()).filter(v => v);
      const placeholders = values.map((_, i) => `$tty${i}`).join(',');
      sql = `AND TTY IN (${placeholders})`;
      values.forEach((val, i) => {
        params[`tty${i}`] = this.#sqlWrapString(val);
      });
    } else if (op === '=') {
      if (propUC === 'STY') {
        sql = `AND ${this.getCodeField()} IN (SELECT RXCUI FROM rxnsty WHERE TUI = $sty)`;
        params.sty = this.#sqlWrapString(value);
      } else if (propUC === 'SAB') {
        sql = `AND ${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE SAB = $sab)`;
        params.sab = this.#sqlWrapString(value);
      } else if (propUC === 'TTY') {
        sql = `AND TTY = $tty`;
        params.tty = this.#sqlWrapString(value);
      } else if (this.rels.includes(prop)) {
        if (value.startsWith('CUI:')) {
          const cui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXCUI IN (SELECT RXCUI2 FROM rxnrel WHERE REL = $rel AND RXCUI1 = $cui2)))`;
          params.rel = this.#sqlWrapString(prop);
          params.cui2 = this.#sqlWrapString(cui);
        } else if (value.startsWith('AUI:')) {
          const aui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXAUI IN (SELECT RXAUI2 FROM rxnrel WHERE REL = $rel AND RXAUI1 = $aui2)))`;
          params.rel = this.#sqlWrapString(prop);
          params.aui2 = this.#sqlWrapString(aui);
        }
      } else if (this.reltypes.includes(prop)) {
        if (value.startsWith('CUI:')) {
          const cui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXCUI IN (SELECT RXCUI2 FROM rxnrel WHERE RELA = $rela AND RXCUI1 = $cui2)))`;
          params.rela = this.#sqlWrapString(prop);
          params.cui2 = this.#sqlWrapString(cui);
        } else if (value.startsWith('AUI:')) {
          const aui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXAUI IN (SELECT RXAUI2 FROM rxnrel WHERE RELA = $rela AND RXAUI1 = $aui2)))`;
          params.rela = this.#sqlWrapString(prop);
          params.aui2 = this.#sqlWrapString(aui);
        }
      }
    }

    if (!sql) {
      throw new Error(`Unknown filter "${prop} ${op} ${value}"`);
    }

    filter.sql = sql;
    filter.params = params;
    filterContext.filters.push(filter);
  }

  /**
   * @param {RxNormPrep} filterContext - Filter context
   * @param {RxNormSearchFilter} filter - Search filter
   * @param {boolean} sort - Whether sorting was requested
   * @returns {Promise<void>}
   */
  async searchFilter(filterContext, filter, sort) {

    if (!filter || !filter.stems || filter.stems.length === 0) {
      throw new Error('Invalid search filter');
    }

    for (let i = 0; i < filter.stems.length; i++) {
      const stem = filter.stems[i];
      const rxnormFilter = new RxNormFilterHolder();
      rxnormFilter.text = true;
      rxnormFilter.sql = ` AND (${this.getCodeField()} = s${i}.CUI AND s${i}.stem LIKE $stem${i})`;
      rxnormFilter.params[`stem${i}`] = this.#sqlWrapString(stem) + '%';

      filterContext.filters.push(rxnormFilter);
    }
    if (sort) {
      // TODO
    }
  }

  /**
   * @param {RxNormPrep} filterContext - Filter context
   * @returns {Promise<RxNormFilterHolder[]>} Combined filters
   */
  async executeFilters(filterContext) {
    

    if (filterContext.filters.length === 0) {
      return [];
    }

    // Build the complete query
    let sql1 = '';
    let sql2 = 'FROM rxnconso';
    /** @type {RxNormSqlParams} */
    const allParams = {};

    let stemIndex = 0;

    // Add non-text filters first
    for (const filter of filterContext.filters) {
      if (!filter.text) {
        sql1 += ' ' + filter.sql;
        Object.assign(allParams, filter.params);
      }
    }

    // Add text search joins and filters
    for (const filter of filterContext.filters) {
      if (filter.text) {
        sql2 += `, rxnstems as s${stemIndex}`;
        const stemSql = filter.sql.replace(/s\d+/g, `s${stemIndex}`);
        sql1 += ' ' + stemSql;

        // Update parameter keys to match stem index
        for (const [key, value] of Object.entries(filter.params)) {
          const newKey = key.replace(/\d+/, stemIndex.toString());
          allParams[newKey] = value;
        }
        stemIndex++;
      }
    }

    const fullQuery = `SELECT ${this.getCodeField()}, STR ${sql2} WHERE SAB = $sab AND TTY <> 'SY' ${sql1}`;
    allParams.sab = this.getSAB();

    // Create a single filter holder with the combined query
    const combinedFilter = new RxNormFilterHolder();
    combinedFilter.sql = fullQuery;
    combinedFilter.params = allParams;

    return [combinedFilter];
  }

  /**
   * @param {RxNormPrep} filterContext - Filter context
   * @param {RxNormFilterHolder} set - Filter holder
   * @returns {Promise<number>} Number of matching rows
   */
  async filterSize(filterContext, set) {
    if (!set.executed) {
      await this.#executeFilter(set);
    }

    return set.results ? set.results.length : 0;
  }

  /**
   * @param {RxNormPrep} filterContext - Filter context
   * @param {RxNormFilterHolder} set - Filter holder
   * @returns {Promise<boolean>} Whether another row exists
   */
  async filterMore(filterContext, set) {
    

    if (!set.executed) {
      await this.#executeFilter(set);
    }

    return set.cursor < (set.results ? set.results.length : 0);
  }

  /**
   * @param {RxNormPrep} filterContext - Filter context
   * @param {RxNormFilterHolder} set - Filter holder
   * @returns {Promise<RxNormConcept | null>} Current concept
   */
  async filterConcept(filterContext, set) {
    

    if (!set.executed) {
      await this.#executeFilter(set);
    }

    if (!set.results || set.cursor >= set.results.length) {
      return null;
    }

    const row = set.results[set.cursor];
    set.cursor++;

    const concept = new RxNormConcept(row[this.getCodeField()], row.STR);
    return concept;
  }

  /**
   * @param {RxNormPrep} filterContext - Filter context
   * @param {RxNormFilterHolder} set - Filter holder
   * @param {string} code - Concept code
   * @returns {Promise<RxNormConcept | null>} Matching concept, if any
   */
  async filterLocate(filterContext, set, code) {
    

    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      // Build query to check if code exists in filter
      const checkQuery = `SELECT ${this.getCodeField()}, STR FROM rxnconso WHERE SAB = $sab AND TTY <> 'SY' AND ${this.getCodeField()} = $code ${set.sql.replace(/SELECT.*?FROM rxnconso/, '').replace(/WHERE SAB = \$sab AND TTY <> 'SY'/, '')}`;

      const params = { ...set.params, code };

      db.get(checkQuery, this.#buildParamArray(checkQuery, params), (err, row) => {
        if (err) {
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          const rxRow = /** @type {RxNormRow} */ (row);
          const concept = new RxNormConcept(rxRow[this.getCodeField()], rxRow.STR);
          resolve(concept);
        }
      });
    });
  }

  /**
   * @param {RxNormPrep} filterContext - Filter context
   * @param {RxNormFilterHolder} set - Filter holder
   * @param {RxNormContextInput} concept - Concept to check
   * @returns {Promise<boolean>} Whether the concept is in the filter
   */
  async filterCheck(filterContext, set, concept) {
    

    if (!(concept instanceof RxNormConcept)) {
      return false;
    }

    if (!set.executed) {
      await this.#executeFilter(set);
    }

    return set.results ? set.results.some(row => row[this.getCodeField()] === concept.code) : false;
  }

  /**
   * @param {RxNormFilterHolder} filter - Filter holder
   * @returns {Promise<void>}
   */
  async #executeFilter(filter) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const paramArray = this.#buildParamArray(filter.sql, filter.params);

      db.all(filter.sql, paramArray, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          filter.results = /** @type {RxNormRow[]} */ (rows);
          filter.executed = true;
          resolve(undefined);
        }
      });
    });
  }

  // Helper method to build parameter arrays for sqlite3
  /**
   * @param {string} sql - SQL containing named parameters
   * @param {RxNormSqlParams} params - Parameter values by name
   * @returns {string[]} Parameters in SQL order
   */
  #buildParamArray(sql, params) {
    /** @type {string[]} */
    const paramArray = [];
    /** @type {string[]} */
    const paramOrder = [];

    // Extract parameter names from SQL in order
    const paramMatches = sql.match(/\$\w+/g) || [];
    paramMatches.forEach(match => {
      const paramName = match.substring(1); // Remove $
      if (!paramOrder.includes(paramName)) {
        paramOrder.push(paramName);
      }
    });

    // Build array in correct order
    paramOrder.forEach(paramName => {
      if (Object.prototype.hasOwnProperty.call(params, paramName)) {
        paramArray.push(params[paramName]);
      }
    });

    return paramArray;
  }

  /**
   * @param {string} str - String to quote for SQLite
   * @returns {string} Escaped string
   */
  #sqlWrapString(str) {
    return str.replace(/'/g, "''");
  }

  // Subsumption testing
  /**
   * @param {RxNormContextInput} codeA - First code or context
   * @param {RxNormContextInput} codeB - Second code or context
   * @returns {Promise<string>} Subsumption outcome
   */
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    return 'not-subsumed'; // Not implemented yet
  }

  // Extension for lookup operation
  /**
   * @param {RxNormContextInput} ctxt - Code or context
   * @param {string[]} props - Requested properties
   * @param {any} params - Parameters object
   * @returns {Promise<void>}
   */
  async extendLookup(ctxt, props, params) {
    validateArrayParameter(props, 'props', String);
    validateArrayParameter(params, 'params', Object);


    if (typeof ctxt === 'string') {
      const located = await this.locate(ctxt);
      if (!located.context) {
        throw new Error(located.message || `Code '${ctxt}' not found in ${this.name()}`);
      }
      ctxt = located.context;
    }

    if (!(ctxt instanceof RxNormConcept)) {
      throw new Error('Invalid context for RxNorm lookup');
    }

    // Set abstract status
    params.abstract = false;

    // Add designations
    const designations =  new Designations(this.opContext.i18n.languageDefinitions);
    await this.designations(ctxt, designations);
    for (const designation of designations) {
      if (designation.value) {
        this.#addProperty(params, 'designation', 'display', designation.value, designation.language);
      }
    }
  }

  /**
   * @param {any} params - Parameters object
   * @param {string} type - Parameter name
   * @param {string} name - Property/designation code
   * @param {string} value - Property/designation value
   * @param {any} language - Optional language
   * @returns {void}
   */
  #addProperty(params, type, name, value, language = null) {
    if (!params.parameter) {
      params.parameter = [];
    }

    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueString: value }
      ]
    };

    if (language) {
      property.part.push({ name: 'language', valueCode: language });
    }

    params.parameter.push(property);
  }

  versionAlgorithm() {
    return 'date';
  }
}

class RxNormTypeServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param {any} i18n - Translation support
   * @param {string} dbPath - Path to RxNorm SQLite database
   * @param {boolean} isNCI - Whether this is NCI metadata
   */
  constructor(i18n, dbPath, isNCI = false) {
    super(i18n);
    this.dbPath = dbPath;
    this.isNCI = isNCI;
    this._loaded = false;
    /** @type {RxNormSharedData | null} */
    this._sharedData = null;
  }

  system() {
    return this.isNCI ? 'http://ncimeta.nci.nih.gov' : 'http://www.nlm.nih.gov/research/umls/rxnorm';
  }

  version() {
    return this._sharedData ? this._sharedData.version : null;
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
    const db = new sqlite3.Database(this.dbPath);

    try {
      await new Promise((resolve, reject) => {
        db.run(`CREATE INDEX IF NOT EXISTS idx_rxnstems_cui_stem ON RXNSTEMS(CUI, stem)`,
          err => err ? reject(err) : resolve(undefined));
      });

      this._sharedData = {
        version: '',
        rels: [],
        reltypes: [],
        totalCodeCount: 0
      };

      // Load version
      const sharedData = this._sharedData;
      sharedData.version = await this.#readVersion(db);

      // Load relationship types
      sharedData.rels = await this.#loadList(db, 'SELECT DISTINCT REL FROM RXNREL');

      // Load relationship attributes
      sharedData.reltypes = await this.#loadList(db, 'SELECT DISTINCT RELA FROM RXNREL');

      // Get total count
      const sab = this.isNCI ? 'NCI' : 'RXNORM';
      sharedData.totalCodeCount = await this.#getCount(db, `SELECT COUNT(RXCUI) FROM rxnconso WHERE SAB = ? AND TTY <> 'SY'`, [sab]);

    } finally {
      db.close();
    }
    this._loaded = true;
  }

  /**
   * @param {SqliteDatabase} db - RxNorm database
   * @returns {Promise<string>} Database version
   */
  async #readVersion(db) {
    return new Promise((resolve) => {
      db.get('SELECT version FROM RXNVer', (err, row) => {
        if (err || !row) {
          // Fallback: try to extract version from database path
          const dbDetails = this.dbPath;
          let version = '??';

          if (dbDetails.includes('.db')) {
            let d = dbDetails.substring(0, dbDetails.indexOf('.db'));
            if (d.includes('_')) {
              d = d.substring(d.lastIndexOf('_') + 1);
            }
            if (d.includes('-')) {
              d = d.substring(0, d.lastIndexOf('-'));
            }
            if (/^\d+$/.test(d)) {
              version = d;
            }
          }
          resolve(version);
        } else {
          resolve(String(/** @type {RxNormRow} */ (row).version));
        }
      });
    });
  }

  /**
   * @param {SqliteDatabase} db - RxNorm database
   * @param {string} sql - Query returning one value per row
   * @returns {Promise<string[]>} Values
   */
  async #loadList(db, sql) {
    return new Promise((resolve, reject) => {
      db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map(row => String(Object.values(/** @type {Record<string, any>} */ (row))[0])));
        }
      });
    });
  }

  /**
   * @param {SqliteDatabase} db - RxNorm database
   * @param {string} sql - Count query
   * @param {string[]} params - SQL parameters
   * @returns {Promise<number>} Count
   */
  async #getCount(db, sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          const value = row ? Object.values(/** @type {Record<string, any>} */ (row))[0] : 0;
          resolve(Number(value));
        }
      });
    });
  }

  defaultVersion() {
    return this._sharedData?.version || 'unknown';
  }

  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @returns {Promise<RxNormServices>} New provider
   */
  async build(opContext, supplements) {
    await this.#ensureLoaded();
    this.recordUse();

    // Create fresh database connection for this provider instance
    const db = new sqlite3.Database(this.dbPath);

    return new RxNormServices(opContext, supplements, db, /** @type {RxNormSharedData} */ (this._sharedData), this.isNCI);
  }

  name() {
    return this.isNCI ? 'NCI' : 'RxNorm';
  }

  id() {
    return this.name()+"-"+this.version();
  }

  /**
   * @param {string} version - Version to describe
   * @returns {string} Human-readable version
   */
  describeVersion(version) {
    try {
      return formatDateMMDDYYYY(version);
    } catch (error) {
      return "v" + version;
    }
  }
}

// Specific RxNorm implementation
class RxNormServicesFactory extends RxNormTypeServicesFactory {
  /**
   * @param {any} languageDefinitions - Translation support
   * @param {string} dbPath - Path to RxNorm SQLite database
   */
  constructor(languageDefinitions, dbPath) {
    super(languageDefinitions, dbPath, false);
  }
}

// NCI Meta implementation
class NCIServicesFactory extends RxNormTypeServicesFactory {
  /**
   * @param {any} languageDefinitions - Translation support
   * @param {string} dbPath - Path to NCI SQLite database
   */
  constructor(languageDefinitions, dbPath) {
    super(languageDefinitions, dbPath, true);
  }
}

module.exports = {
  RxNormServices,
  RxNormServicesFactory,
  NCIServicesFactory,
  RxNormConcept
};
