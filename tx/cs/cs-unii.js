// @ts-check

const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const csApi = require('./cs-api');
const CodeSystemProvider = /** @type {any} */ (csApi.CodeSystemProvider);
const CodeSystemFactoryProvider = /** @type {any} */ (csApi.CodeSystemFactoryProvider);

/** @typedef {import('sqlite3').Database} SqliteDatabase */
/** @typedef {string | UniiConcept | null | undefined} UniiContextInput */
/** @typedef {{context: UniiConcept | null, message?: string}} UniiLocateResult */
/** @typedef {{Version: string}} UniiVersionRow */
/** @typedef {{count: number}} UniiCountRow */
/** @typedef {{UniiKey: number, Display: string | null}} UniiRow */
/** @typedef {{Display: string | null}} UniiDescriptionRow */

class UniiConcept {
  /**
   * @param {string} code - UNII code
   * @param {string | null} display - Primary display text
   */
  constructor(code, display) {
    this.code = code;
    this.display = display;
    /** @type {string[]} */
    this.others = []; // Array of other descriptions from UniiDesc table
  }
}

class UniiServices extends CodeSystemProvider {
  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @param {SqliteDatabase | null} db - Open UNII database
   * @param {string | null} version - UNII data version
   */
  constructor(opContext, supplements, db, version) {
    super(opContext, supplements);
    /** @type {SqliteDatabase | null} */
    this.db = db;
    this._version = version;
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
    return 'http://fdasis.nlm.nih.gov'; // UNII system URI
  }

  version() {
    return this._version;
  }

  description() {
    return 'UNII Codes';
  }

  name() {
    return 'UNII Codes';
  }

  totalCount() {
    return -1; // Database-driven, use count query if needed
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
   * @param {UniiContextInput} code - UNII code or context
   * @returns {Promise<string | null>} UNII code
   */
  async code(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt ? ctxt.code : null;
  }

  /**
   * @param {UniiContextInput} code - UNII code or context
   * @returns {Promise<string | null>} Display string
   */
  async display(code) {
    
    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }
    if (ctxt.display && this.opContext.langs.isEnglishOrNothing()) {
      return ctxt.display.trim();
    }
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }
    return ctxt.display ? ctxt.display.trim() : '';
  }

  /**
   * @param {UniiContextInput} code - UNII code or context
   * @returns {Promise<null>} Definition, if any
   */
  async definition(code) {
    
    await this.#ensureContext(code);
    return null; // No definitions provided
  }

  /**
   * @param {UniiContextInput} code - UNII code or context
   * @returns {Promise<boolean>} Whether the concept is abstract
   */
  async isAbstract(code) {
    await this.#ensureContext(code);
    return false; // No abstract concepts
  }

  /**
   * @param {UniiContextInput} code - UNII code or context
   * @returns {Promise<boolean>} Whether the concept is inactive
   */
  async isInactive(code) {
    await this.#ensureContext(code);
    return false; // No inactive concepts
  }

  /**
   * @param {UniiContextInput} code - UNII code or context
   * @returns {Promise<boolean>} Whether the concept is deprecated
   */
  async isDeprecated(code) {
    await this.#ensureContext(code);
    return false; // No deprecated concepts
  }

  /**
   * @param {UniiContextInput} code - UNII code or context
   * @param {any} displays - Designation collector
   * @returns {Promise<void>}
   */
  async designations(code, displays) {
    
    const ctxt = await this.#ensureContext(code);
    if (ctxt != null) {
      // Add main display
      if (ctxt.display) {
        displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), ctxt.display.trim());
      }
      // Add other descriptions
      ctxt.others.forEach(other => {
        if (other && other.trim()) {
          displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), other.trim());
        }
      });
      this._listSupplementDesignations(ctxt.code, displays);
    }
  }

  /**
   * @param {UniiContextInput} code - UNII code or context
   * @returns {Promise<UniiConcept | null>}
   */
  async #ensureContext(code) {
    if (!code) {
      return null;
    }
    if (typeof code === 'string') {
      const ctxt = await this.locate(code);
      if (!ctxt.context) {
        throw new Error(ctxt.message);
      } else {
        return ctxt.context;
      }
    }
    if (code instanceof UniiConcept) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof code));
  }

  /**
   * @returns {SqliteDatabase}
   */
  #requireDb() {
    if (!this.db) {
      throw new Error('UNII database is closed');
    }
    return this.db;
  }

  // Database helper methods
  /**
   * @returns {Promise<string>}
   */
  async #getVersion() {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      db.get('SELECT Version FROM UniiVersion', (err, row) => {
        if (err) reject(err);
        else resolve(row ? /** @type {UniiVersionRow} */ (row).Version : 'unknown');
      });
    });
  }

  /**
   * @returns {Promise<number>}
   */
  async #getTotalCount() {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM Unii', (err, row) => {
        if (err) reject(err);
        else resolve(row ? /** @type {UniiCountRow} */ (row).count : 0);
      });
    });
  }

  // Lookup methods
  /**
   * @param {string | null | undefined} code - UNII code
   * @returns {Promise<UniiLocateResult>} Located concept and status message
   */
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      // First query: get main concept
      db.get('SELECT UniiKey, Display FROM Unii WHERE Code = ?', [code], (err, row) => {
        if (err) {
          return reject(err);
        }

        if (!row) {
          return resolve({ context: null, message: `UNII Code '${code}' not found` });
        }

        const uniiRow = /** @type {UniiRow} */ (row);
        const concept = new UniiConcept(code, uniiRow.Display);
        const uniiKey = uniiRow.UniiKey;

        // Second query: get all descriptions
        db.all('SELECT Display FROM UniiDesc WHERE UniiKey = ?', [uniiKey], (err, rows) => {
          if (err) return reject(err);

          // Add unique descriptions to others array
          rows.forEach(descRow => {
            const desc = /** @type {UniiDescriptionRow} */ (descRow).Display;
            if (desc && desc.trim() && !concept.others.includes(desc.trim())) {
              concept.others.push(desc.trim());
            }
          });

          resolve({ context: concept, message: undefined });
        });
      });
    });
  }

  versionAlgorithm() {
    return 'date';
  }
}

class UniiServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param {any} i18n - Translation support
   * @param {string} dbPath - Path to the UNII SQLite database
   */
  constructor(i18n, dbPath) {
    super(i18n);
    this.dbPath = dbPath;
    this.uses = 0;
    this._version = null;
  }

  /**
   * @returns {Promise<void>}
   */
  async load() {
    const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY);
    try {
      const row = await new Promise((resolve, reject) => {
        db.get('SELECT Version FROM UniiVersion', (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
      this._version = row ? /** @type {UniiVersionRow} */ (row).Version : 'unknown';
    } finally {
      await new Promise((resolve) => db.close(() => resolve(undefined)));
    }
  }

  defaultVersion() {
    return 'unknown';
  }

  system() {
    return 'http://fdasis.nlm.nih.gov'; // UNII system URI
  }

  version() {
    return this._version;
  }

  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @returns {UniiServices} New provider
   */
  build(opContext, supplements) {
    this.uses++;

    return new UniiServices(opContext, supplements, new sqlite3.Database(this.dbPath), this._version);
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

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  name() {
    return 'UNII Codes';
  }

  id() {
    return 'unii';
  }

}

module.exports = {
  UniiServices,
  UniiServicesFactory,
  UniiConcept
};
