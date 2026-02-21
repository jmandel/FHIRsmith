const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const { CodeSystemProvider, CodeSystemFactoryProvider} = require('./cs-api');

class UniiConcept {
  constructor(code, display) {
    this.code = code;
    this.display = display;
    this.others = []; // Array of other descriptions from UniiDesc table
  }
}

class UniiServices extends CodeSystemProvider {
  constructor(opContext, supplements, db, version, codes) {
    super(opContext, supplements);
    this.db = db;
    this._version = version;
    this.codes = codes;
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

  hasParents() {
    return false; // No hierarchical relationships
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }
    return super.hasAnyDisplays(langs);
  }

  // Core concept methods
  async code(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt ? ctxt.code : null;
  }

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

  async definition(code) {
    
    await this.#ensureContext(code);
    return null; // No definitions provided
  }

  async isAbstract(code) {
    await this.#ensureContext(code);
    return false; // No abstract concepts
  }

  async isInactive(code) {
    await this.#ensureContext(code);
    return false; // No inactive concepts
  }

  async isDeprecated(code) {
    await this.#ensureContext(code);
    return false; // No deprecated concepts
  }

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

  async #ensureContext(code) {
    if (!code) {
      return code;
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

  // Database helper methods
  async #getVersion() {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT Version FROM UniiVersion', (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.Version : 'unknown');
      });
    });
  }

  async #getTotalCount() {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM Unii', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });
  }

  // Lookup methods
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const cached = this.codes.get(code);
    if (cached) return { context: cached, message: undefined };
    return { context: null, message: `UNII Code '${code}' not found` };
  }

  versionAlgorithm() {
    return 'date';
  }
}

class UniiServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n, dbPath) {
    super(i18n);
    this.dbPath = dbPath;
    this.uses = 0;
    this._version = null;
    this._codes = null;
  }

  async load() {
    let db = new sqlite3.Database(this.dbPath);

    try {
      this._version = await new Promise((resolve, reject) => {
        db.get('SELECT Version FROM UniiVersion', (err, row) => {
          if (err) {
            reject(new Error(err));
          } else {
            resolve(row ? row.Version : 'unknown');
          }
        });
      });

      // Preload all codes into memory
      this._codes = new Map();
      await new Promise((resolve, reject) => {
        const sql = `
          SELECT u.Code, u.Display, d.Display as DescDisplay
          FROM Unii u
          LEFT JOIN UniiDesc d ON u.UniiKey = d.UniiKey
        `;
        db.all(sql, (err, rows) => {
          if (err) return reject(err);
          for (const row of rows) {
            if (!this._codes.has(row.Code)) {
              this._codes.set(row.Code, new UniiConcept(row.Code, row.Display));
            }
            const concept = this._codes.get(row.Code);
            if (row.DescDisplay && row.DescDisplay.trim() && !concept.others.includes(row.DescDisplay.trim())) {
              concept.others.push(row.DescDisplay.trim());
            }
          }
          resolve();
        });
      });
    } finally {
      db.close();
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

  build(opContext, supplements) {
    this.uses++;

    return new UniiServices(opContext, supplements, new sqlite3.Database(this.dbPath), this._version, this._codes);
  }

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
    return "unii";
  }

}

module.exports = {
  UniiServices,
  UniiServicesFactory,
  UniiConcept
};