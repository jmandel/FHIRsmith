// @ts-check

const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const csApi = require('./cs-api');
const FilterExecutionContext = /** @type {any} */ (csApi.FilterExecutionContext);
const CodeSystemFactoryProvider = /** @type {any} */ (csApi.CodeSystemFactoryProvider);
const {validateOptionalParameter, validateArrayParameter} = require("../../library/utilities");
const {ConceptMap} = require("../library/conceptmap");
const csBase = require("./cs-base");
const BaseCSServices = /** @type {any} */ (csBase.BaseCSServices);

/** @typedef {import('sqlite3').Database} SqliteDatabase */
/** @typedef {string | OMOPConcept | null | undefined} OMOPContextInput */
/** @typedef {{context: OMOPConcept | null, message?: string | null}} OMOPLocateResult */
/** @typedef {{_version: string}} OMOPSharedData */
/** @typedef {{concept_id: number | string, concept_name: string, standard_concept?: string | null, domain_id: string, concept_class_id?: string, vocabulary_id?: number | string, concept_class_concept_id?: number | string, domain_concept_id?: number | string, valid_start_date?: string | number, valid_end_date?: string | number, concept_code?: string, invalid_reason?: string | null, relationship_id?: string, reverse_relationship_id?: string, vocabulary_version?: string, count?: number}} OMOPRow */
/** @typedef {{concept_synonym_name: string, concept_name: string}} OMOPSynonymRow */
/** @typedef {{language: string, value: string}} OMOPSynonym */
/** @typedef {{resourceType?: string, url: string, status: string, version: string | null, name: string, description: string, date: string, experimental: boolean, compose: {include: Array<{system: string, filter?: Array<{property: string, op: string, value: string}>}>}}} OMOPValueSetLike */

class OMOPConcept {
  /**
   * @param {string} code - OMOP concept id
   * @param {string} display - Concept display
   * @param {string} domain - Domain id
   * @param {string} conceptClass - Concept class id
   * @param {string | null | undefined} standard - Standard concept flag
   * @param {string | number | null | undefined} vocabulary - Vocabulary id
   */
  constructor(code, display, domain, conceptClass, standard, vocabulary) {
    this.code = code;
    this.display = display;
    this.domain = domain;
    this.conceptClass = conceptClass;
    this.standard = standard || 'NS';
    this.vocabulary = String(vocabulary || '');
  }
}

class OMOPFilter extends FilterExecutionContext {
  /**
   * @param {SqliteDatabase} db - Open OMOP database
   * @param {string} sql - SQL query
   * @param {string | null} value - Filter value
   */
  constructor(db, sql, value = null) {
    super();
    this.db = db;
    this.sql = sql;
    this.value = value;
    /** @type {OMOPRow[]} */
    this.rows = [];
    this.cursor = 0;
    this.executed = false;
  }

  /**
   * @param {Array<string | number | null>} params - SQL parameters
   * @returns {Promise<void>}
   */
  async execute(params = []) {
    if (this.executed) return;

    return new Promise((resolve, reject) => {
      /** @type {(err: Error | null, rows: unknown[]) => void} */
      const callback = (err, rows) => {
        if (err) {
          reject(err);
        } else {
          this.rows = /** @type {OMOPRow[]} */ (rows || []);
          this.executed = true;
          resolve(undefined);
        }
      };

      if (params.length > 0) {
        this.db.all(this.sql, params, callback);
      } else {
        this.db.all(this.sql, callback);
      }
    });
  }

  /**
   * @param {Array<string | number | null>} params - SQL parameters
   * @returns {Promise<OMOPRow | undefined>}
   */
  async executeForLocate(params) {
    return new Promise((resolve, reject) => {
      this.db.get(this.sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? /** @type {OMOPRow} */ (row) : undefined);
        }
      });
    });
  }

  /**
   * @returns {void}
   */
  close() {
    // Database connection is managed by the provider
  }
}

class OMOPPrep extends FilterExecutionContext {
  iterate;

  /**
   * @param {boolean} iterate - Whether filters will be iterated
   */
  constructor(iterate) {
    super();
    this.iterate = iterate;
  }
}

// Vocabulary mapping functions
/**
 * @param {string} url - Code system URL
 * @returns {number} OMOP vocabulary id, or -1
 */
function getVocabId(url) {
  /** @type {Record<string, number>} */
  const mapping = {
    'http://hl7.org/fhir/sid/icd-9-cm': 5046,
    'http://snomed.info/sct': 44819097,
    'http://hl7.org/fhir/sid/icd-10-cm': 44819098,
    'http://hl7.org/fhir/sid/icd-9-proc': 44819099,
    'http://www.ama-assn.org/go/cpt': 44819100,
    'http://terminology.hl7.org/CodeSystem/HCPCS-all-codes': 44819101,
    'http://loinc.org': 44819102,
    'http://www.nlm.nih.gov/research/umls/rxnorm': 44819104,
    'http://hl7.org/fhir/sid/ndc': 44819105,
    'http://unitsofmeasure.org': 44819107,
    'http://nucc.org/provider-taxonomy': 44819137,
    'http://www.whocc.no/atc': 44819117
  };
  return mapping[url] || -1;
}

/**
 * @param {number | string} key - OMOP vocabulary id
 * @returns {string} Code system URI
 */
function getUri(key) {
  const numericKey = Number(key);
  /** @type {Record<number, string>} */
  const mapping = {
    5046: 'http://hl7.org/fhir/sid/icd-9-cm',
    44819097: 'http://snomed.info/sct',
    44819098: 'http://hl7.org/fhir/sid/icd-10-cm',
    44819099: 'http://hl7.org/fhir/sid/icd-9-proc',
    44819100: 'http://www.ama-assn.org/go/cpt',
    44819101: 'http://terminology.hl7.org/CodeSystem/HCPCS-all-codes',
    44819102: 'http://loinc.org',
    44819104: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    44819105: 'http://hl7.org/fhir/sid/ndc',
    44819107: 'http://unitsofmeasure.org',
    44819117: 'http://www.whocc.no/atc',
    44819137: 'http://nucc.org/provider-taxonomy'
  };
  return mapping[numericKey] || '';
}

/**
 * @param {number | string} key - OMOP vocabulary id
 * @returns {string} Code system URI
 */
function getUriOrError(key) {
  const uri = getUri(key);
  if (!uri) {
    throw new Error(`Unmapped OMOP Vocabulary id: ${key}`);
  }
  return uri;
}

/**
 * @param {string} langConcept - OMOP language concept name
 * @returns {string} BCP47 language code
 */
function getLang(langConcept) {
  if (langConcept === 'English language') return 'en';
  if (langConcept === 'Spanish language') return 'es';
  return 'en'; // default
}

class OMOPServices extends BaseCSServices {
  /**
   * @param {any} opContext - Operation context
   * @param {any[] | null | undefined} supplements - Supplement CodeSystems
   * @param {SqliteDatabase | null} db - Open OMOP database
   * @param {OMOPSharedData} sharedData - Shared data loaded by factory
   */
  constructor(opContext, supplements, db, sharedData) {
    super(opContext, supplements);
    /** @type {SqliteDatabase | null} */
    this.db = db;
    this._version = sharedData._version;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // Metadata methods
  system() {
    return 'https://fhir-terminology.ohdsi.org';
  }

  version() {
    return this._version;
  }

  name() {
    return `OMOP Concepts`;
  }

  description() {
    return `OMOP Concepts, release ${this._version}`;
  }

  async totalCount() {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM Concepts', (err, row) => {
        if (err) reject(err);
        else resolve(row ? /** @type {OMOPRow} */ (row).count || 0 : 0);
      });
    });
  }

  // Core concept methods
  /**
   * @param {OMOPContextInput} context - OMOP code or context
   * @returns {Promise<string | null>} Concept code
   */
  async code(context) {
    
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.code : null;
  }

  /**
   * @param {OMOPContextInput} context - OMOP code or context
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
   * @param {OMOPContextInput} context - OMOP code or context
   * @returns {Promise<string>} Definition
   */
  async definition(context) {
    await this.#ensureContext(context);
    return ''; // OMOP doesn't provide definitions
  }

  /**
   * @param {OMOPContextInput} context - OMOP code or context
   * @returns {Promise<boolean>} Whether the concept is abstract
   */
  async isAbstract(context) {
    await this.#ensureContext(context);
    return false; // OMOP concepts are not abstract
  }

  /**
   * @param {OMOPContextInput} context - OMOP code or context
   * @returns {Promise<boolean>} Whether the concept is inactive
   */
  async isInactive(context) {
    await this.#ensureContext(context);
    return false; // Handle via standard_concept if needed
  }

  /**
   * @param {OMOPContextInput} context - OMOP code or context
   * @returns {Promise<boolean>} Whether the concept is deprecated
   */
  async isDeprecated(context) {
    await this.#ensureContext(context);
    return false; // Handle via invalid_reason if needed
  }

  /**
   * @param {OMOPContextInput} context - OMOP code or context
   * @param {any} displays - Designation collector
   * @returns {Promise<void>}
   */
  async designations(context, displays) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt) {
      // Add main display
      displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), ctxt.display);

      // Add synonyms
      const synonyms = await this.#getSynonyms(ctxt.code);
      for (const synonym of synonyms) {
        displays.addDesignation(false, 'active', synonym.language, null, synonym.value);
      }

      // Add supplement designations
      this._listSupplementDesignations(String(ctxt.code), displays);
    }
  }

  /**
   * @param {string} code - OMOP concept id
   * @returns {Promise<OMOPSynonym[]>} Synonyms
   */
  async #getSynonyms(code) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT concept_synonym_name, concept_name
          FROM ConceptSynonyms, Concepts
          WHERE ConceptSynonyms.language_concept_id = Concepts.concept_id
            AND ConceptSynonyms.concept_id = ?
      `;

      db.all(sql, [code], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const synonyms = /** @type {OMOPSynonymRow[]} */ (rows).map(row => ({
            language: getLang(row.concept_name),
            value: row.concept_synonym_name
          }));
          resolve(synonyms);
        }
      });
    });
  }

  /**
   * @param {OMOPContextInput} ctxt - OMOP code or context
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
        throw new Error(located.message || `OMOP Concept '${ctxt}' not found`);
      }
      ctxt = located.context;
    }

    if (!(ctxt instanceof OMOPConcept)) {
      throw new Error('Invalid context for OMOP lookup');
    }

    // Add basic properties
    if (this._hasProp(props, 'domain-id', true)) {
      this.#addCodeProperty(params, 'property', 'domain-id', ctxt.domain);
    }
    if (this._hasProp(props, 'concept-class-id', true)) {
      this.#addCodeProperty(params, 'property', 'concept-class-id', ctxt.conceptClass);
    }
    if (this._hasProp(props, 'standard-concept', true)) {
      this.#addCodeProperty(params, 'property', 'standard-concept', ctxt.standard);
    }
    if (this._hasProp(props, 'vocabulary-id', true)) {
      this.#addStringProperty(params, 'property', 'vocabulary-id', ctxt.vocabulary);
    }

    // Add synonyms as designations
    const synonyms = await this.#getSynonyms(ctxt.code);
    for (const synonym of synonyms) {
      this.#addStringProperty(params, 'designation', 'synonym', synonym.value, synonym.language);
    }

    // Add extended properties from database
    await this.#addExtendedProperties(ctxt, props, params);

    // Add relationships
    await this.#addRelationships(ctxt, props, params);
  }

  /**
   * @param {OMOPConcept} ctxt - OMOP concept
   * @param {string[]} props - Requested properties
   * @param {any[]} params - Parameters array
   * @returns {Promise<void>}
   */
  async #addExtendedProperties(ctxt, props, params) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = 'SELECT * FROM Concepts WHERE concept_id = ?';

      db.get(sql, [ctxt.code], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          const omopRow = /** @type {OMOPRow} */ (row);
          if (this._hasProp(props, 'concept-class-concept-id', true)) {
            this.#addCodeProperty(params, 'property', 'concept-class-concept-id', omopRow.concept_class_id || '');
          }
          if (this._hasProp(props, 'domain-concept-id', true)) {
            this.#addCodeProperty(params, 'property', 'domain-concept-id', omopRow.domain_id);
          }
          if (this._hasProp(props, 'valid-start-date', true) && omopRow.valid_start_date) {
            this.#addDateProperty(params, 'property', 'valid-start-date', omopRow.valid_start_date);
          }
          if (this._hasProp(props, 'valid-end-date', true) && omopRow.valid_end_date) {
            this.#addDateProperty(params, 'property', 'valid-end-date', omopRow.valid_end_date);
          }
          if (this._hasProp(props, 'source-concept-code', true) && omopRow.concept_code && omopRow.vocabulary_id && getUri(omopRow.vocabulary_id)) {
            this.#addCodingProperty(params, 'property', 'source-concept-code',
              getUriOrError(omopRow.vocabulary_id), omopRow.concept_code);
          }
          if (this._hasProp(props, 'vocabulary-concept-id', true)) {
            this.#addCodeProperty(params, 'property', 'vocabulary-concept-id', omopRow.vocabulary_id || '');
          }
          if (this._hasProp(props, 'invalid-reason', true) && omopRow.invalid_reason) {
            this.#addStringProperty(params, 'property', 'invalid-reason', omopRow.invalid_reason);
          }
          resolve(undefined);
        } else {
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {OMOPConcept} ctxt - OMOP concept
   * @param {string[]} props - Requested properties
   * @param {any[]} params - Parameters array
   * @returns {Promise<void>}
   */
  async #addRelationships(ctxt, props, params) {
    const seenConcepts = new Set();
    const db = this.#requireDb();

    // Forward relationships
    await new Promise((resolve, reject) => {
      const sql = `
          SELECT Concepts.concept_id, Concepts.concept_name, Relationships.relationship_id
          FROM Concepts, ConceptRelationships, Relationships
          WHERE ConceptRelationships.relationship_id = Relationships.relationship_concept_id
            AND ConceptRelationships.concept_id_2 = Concepts.concept_id
            AND ConceptRelationships.concept_id_1 = ?
      `;

      db.all(sql, [ctxt.code], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {OMOPRow[]} */ (rows)) {
            seenConcepts.add(row.concept_id);
            if (row.relationship_id && this._hasProp(props, row.relationship_id, true)) {
              this.#addCodingProperty(params, 'property', row.relationship_id,
                this.system(), row.concept_id, row.concept_name);
            }
          }
          resolve(undefined);
        }
      });
    });

    // Reverse relationships
    await new Promise((resolve, reject) => {
      const sql = `
          SELECT Concepts.concept_id, Concepts.concept_name, Relationships.reverse_relationship_id
          FROM Concepts, ConceptRelationships, Relationships
          WHERE ConceptRelationships.relationship_id = Relationships.relationship_concept_id
            AND ConceptRelationships.concept_id_1 = Concepts.concept_id
            AND ConceptRelationships.concept_id_2 = ?
      `;

      db.all(sql, [ctxt.code], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {OMOPRow[]} */ (rows)) {
            if (!seenConcepts.has(row.concept_id)) {
              if (row.reverse_relationship_id && this._hasProp(props, row.reverse_relationship_id, true)) {
                this.#addCodingProperty(params, 'property', row.reverse_relationship_id,
                  this.system(), row.concept_id, row.concept_name);
              }
            }
          }
          resolve(undefined);
        }
      });
    });
  }

  /**
   * @param {any[]} params - Parameters array
   * @param {string} type - Parameter name
   * @param {string} name - Property/designation code
   * @param {string | number | null | undefined} value - Property value
   * @param {string | null} language - Optional language
   * @returns {void}
   */
  #addStringProperty(params, type, name, value, language = null) {
    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueString: String(value) } // Ensure value is always a string
      ]
    };

    if (language) {
      property.part.push({ name: 'language', valueCode: language });
    }

    params.push(property);
  }

  /**
   * @param {any[]} params - Parameters array
   * @param {string} type - Parameter name
   * @param {string} name - Property code
   * @param {string | number} value - Date value
   * @param {string | null} language - Optional language
   * @returns {void}
   */
  #addDateProperty(params, type, name, value, language = null) {
    value = String(value);
    if (value && value.length === 8 && !value.includes('-')) {
      value = value.substring(0, 4) + '-' + value.substring(4, 6) + '-' + value.substring(6, 8);
    }

    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueDate: value }
      ]
    };

    if (language) {
      property.part.push({ name: 'language', valueCode: language });
    }

    params.push(property);
  }

  /**
   * @param {any[]} params - Parameters array
   * @param {string} type - Parameter name
   * @param {string} name - Property code
   * @param {string} system - Coding system
   * @param {string | number} code - Coding code
   * @param {string | undefined} display - Optional display
   * @returns {void}
   */
  #addCodingProperty(params, type, name, system, code, display = undefined) {
    /** @type {{system: string, code: string, display?: string}} */
    const valueCoding = {
      system: system,
      code: String(code)
    };

    if (display !== undefined) {
      valueCoding.display = display;
    }
    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueCoding:  valueCoding }
      ]
    };

    params.push(property);
  }

  /**
   * @param {any[]} params - Parameters array
   * @param {string} type - Parameter name
   * @param {string} name - Property code
   * @param {string | number | null | undefined} value - Property value
   * @param {string | null} language - Optional language
   * @returns {void}
   */
  #addCodeProperty(params, type, name, value, language = null) {
    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueCode: String(value) } // Ensure value is always a string
      ]
    };

    if (language) {
      property.part.push({ name: 'language', valueCode: language });
    }

    params.push(property);
  }

  /**
   * @param {string[]} props - Requested property names
   * @param {string} name - Property name
   * @param {boolean} defaultValue - Default if no properties requested
   * @returns {boolean} Whether the property was requested
   */
  #hasProp(props, name, defaultValue) {
    if (!props || props.length === 0) return defaultValue;
    return props.includes(name);
  }

  /**
   * @param {OMOPContextInput} context - OMOP code or context
   * @returns {Promise<OMOPConcept | null>}
   */
  async #ensureContext(context) {
    if (!context) {
      return null;
    }
    if (typeof context === 'string') {
      const ctxt = await this.locate(context);
      if (!ctxt.context) {
        throw new Error(ctxt.message ? ctxt.message : `OMOP Concept '${context}' not found`);
      } else {
        return ctxt.context;
      }
    }
    if (context instanceof OMOPConcept) {
      return context;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof context));
  }

  /**
   * @returns {SqliteDatabase}
   */
  #requireDb() {
    if (!this.db) {
      throw new Error('OMOP database is closed');
    }
    return this.db;
  }

  // Lookup methods
  /**
   * @param {string | null | undefined} code - OMOP concept id
   * @returns {Promise<OMOPLocateResult>} Locate result
   */
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT concept_id, concept_name, standard_concept,
                 Domains.domain_id, ConceptClasses.concept_class_id,
                 Vocabularies.vocabulary_id
          FROM Concepts, Domains, ConceptClasses, Vocabularies
          WHERE Concepts.domain_id = Domains.domain_concept_id
            AND ConceptClasses.concept_class_concept_id = Concepts.concept_class_id
            AND Concepts.vocabulary_id = Vocabularies.vocabulary_concept_id
            AND concept_id = ?
      `;

      db.get(sql, [code], (err, row) => {
        if (err) {
          reject(err);
        } else if (row && /** @type {OMOPRow} */ (row).concept_id.toString() === code) {
          const omopRow = /** @type {OMOPRow} */ (row);
          const concept = new OMOPConcept(
            code,
            omopRow.concept_name,
            omopRow.domain_id,
            omopRow.concept_class_id || '',
            omopRow.standard_concept || 'NS',
            omopRow.vocabulary_id
          );
          resolve({ context: concept, message: null });
        } else {
          resolve({ context: null, message: undefined });
        }
      });
    });
  }

  // Iterator methods - not supported for OMOP due to size
  /**
   * @param {OMOPContextInput} context - OMOP context
   * @returns {Promise<never>}
   */
  async iterator(context) {
    await this.#ensureContext(context);
    throw new Error('getNextContext not supported by OMOP - too large to iterate');
  }

  /**
   * @param {any} iteratorContext - Iterator context
   * @returns {Promise<never>}
   */
  // eslint-disable-next-line no-unused-vars
  async nextContext(iteratorContext) {
    throw new Error('getNextContext not supported by OMOP - too large to iterate');
  }

  // Filter support
  /**
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<boolean>} Whether this filter is supported
   */
  async doesFilter(prop, op, value) {
    if (prop === 'domain' && op === '=') {
      return value != null;
    }
    return false;
  }

  /**
   * @param {boolean} iterate - Whether filters will be iterated
   * @returns {Promise<OMOPPrep>} Prep context
   */
  async getPrepContext(iterate) {
    return new OMOPPrep(iterate);
  }

  /**
   * @param {OMOPPrep} filterContext - Filter context
   * @param {boolean} forIteration - Whether the filter is for iteration
   * @param {string} prop - Filter property
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<void>}
   */
  async filter(filterContext, forIteration, prop, op, value) {
    

    if (prop === 'domain' && op === '=') {
      let sql = `
          SELECT concept_id, concept_name, domain_id
          FROM Concepts
          WHERE standard_concept = 'S'
            AND domain_id IN (
              SELECT domain_concept_id
              FROM Domains
              WHERE domain_id = ?
          )
      `;

      let filter;
      const db = this.#requireDb();
      if (filterContext.iterate) {
        filter = new OMOPFilter(db, sql, value);
        await filter.execute([value]);
      } else {
        sql = sql + ' and concept_id = ?';
        filter = new OMOPFilter(db, sql, value);
      }
      filterContext.filters.push(filter);
    } else {
      throw new Error(`Filter "${prop} ${op} ${value}" not understood for OMOP`);
    }
  }

  /**
   * @param {OMOPPrep} filterContext - Filter context
   * @returns {Promise<OMOPFilter[]>} Filters
   */
  async executeFilters(filterContext) {
    return filterContext.filters;
  }

  /**
   * @param {OMOPPrep} filterContext - Filter context
   * @param {OMOPFilter} set - Filter set
   * @returns {Promise<number>} Filter size
   */
  async filterSize(filterContext, set) {
    return set.rows.length;
  }

  /**
   * @param {OMOPPrep} filterContext - Filter context
   * @param {OMOPFilter} set - Filter set
   * @returns {Promise<boolean>} Whether another concept exists
   */
  async filterMore(filterContext, set) {
    return set.cursor < set.rows.length;
  }

  /**
   * @param {OMOPPrep} filterContext - Filter context
   * @param {OMOPFilter} set - Filter set
   * @returns {Promise<OMOPConcept | null>} Current concept
   */
  async filterConcept(filterContext, set) {
    if (set.cursor >= set.rows.length) {
      return null;
    }

    const row = set.rows[set.cursor];
    set.cursor++;

    return new OMOPConcept(
      String(row.concept_id),
      row.concept_name,
      row.domain_id,
      '', // concept_class not in basic filter query
      'S', // standard_concept is 'S' by filter
      '' // vocabulary not in basic filter query
    );
  }

  /**
   * @param {OMOPPrep} filterContext - Filter context
   * @param {OMOPFilter} set - Filter set
   * @param {string} code - OMOP concept id
   * @returns {Promise<OMOPConcept | string>} Matching concept or error
   */
  async filterLocate(filterContext, set, code) {
    if (filterContext.iterate) {
      return `Filter not configured for locate operations`;
    }

    const row = await set.executeForLocate([set.value, code]);
    if (row && row.concept_id.toString() === code) {
      return new OMOPConcept(
        String(row.concept_id),
        row.concept_name,
        row.domain_id,
        '',
        'S',
        ''
      );
    } else {
      return `Code '${code}' is not in the value set`;
    }
  }

  /**
   * @param {OMOPPrep} filterContext - Filter context
   * @param {OMOPFilter} set - Filter set
   * @param {OMOPContextInput} concept - Concept to check
   * @returns {Promise<boolean>} Whether concept is in the filter
   */
  async filterCheck(filterContext, set, concept) {
    

    if (!(concept instanceof OMOPConcept)) {
      return false;
    }

    return set.rows.some(row => row.concept_id.toString() === concept.code);
  }

  /**
   * @param {OMOPPrep} filterContext - Filter context
   * @returns {Promise<void>}
   */
  async filterFinish(filterContext) {
    
    for (const filter of filterContext.filters) {
      filter.close();
    }
  }

  /**
   * @param {OMOPPrep | null | undefined} filterContext - Filter context
   * @returns {Promise<boolean>} Whether filters leave the set open
   */
  async filtersNotClosed(filterContext) {
    validateOptionalParameter(filterContext, "filterContext", FilterExecutionContext);
    return false; // OMOP filters are closed
  }


  // Subsumption testing - not implemented
  /**
   * @param {OMOPContextInput} codeA - First code or context
   * @param {OMOPContextInput} codeB - Second code or context
   * @returns {Promise<string>} Subsumption outcome
   */
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    
    return 'not-subsumed';
  }

  // Translation support
  /**
   * @param {any} map - ConceptMap
   * @param {{code: string | number}} coding - Source coding
   * @param {string} target - Target system
   * @returns {Promise<any[] | undefined>} Translations
   */
  async getTranslations(map, coding, target) {
    if (map == null) {
      return;
    }

    const vocabId = getVocabId(target);
    if (vocabId === -1) {
      return [];
    }

    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT concept_code, concept_name
          FROM Concepts
          WHERE concept_id = ? AND vocabulary_id = ?
      `;

      db.all(sql, [coding.code, vocabId], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const translations = /** @type {OMOPRow[]} */ (rows).map(row => ({
            system: target,
            code: row.concept_code || '',
            display: row.concept_name,
            relationship: 'equivalent',
            map: `${this.system()}/ConceptMap/to-${vocabId}|${this._version}`
          }));
          resolve(translations);
        }
      });
    });
  }

  // Build value sets for domains
  /**
   * @param {any} factory - Factory
   * @param {string} id - ValueSet id/url
   * @returns {Promise<OMOPValueSetLike>} ValueSet
   */
  async buildValueSet(factory, id) {
    const domain = id.substring(44); // Remove prefix

    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT concept_id, concept_name, Domains.domain_id
          FROM Concepts, Domains
          WHERE Domains.domain_id = ?
            AND Domains.domain_concept_id = Concepts.concept_id
      `;

      db.get(sql, [domain], (err, row) => {
        if (err) {
          reject(err);
        } else if (row && /** @type {OMOPRow} */ (row).domain_id === domain) {
          const omopRow = /** @type {OMOPRow} */ (row);
          // Create value set structure
          const valueSet = {
            url: id,
            status: 'active',
            version: this._version,
            name: `OMOPDomain${domain}`,
            description: `OMOP value set for domain ${omopRow.concept_name}`,
            date: new Date().toISOString(),
            experimental: false,
            compose: {
              include: [{
                system: this.system(),
                filter: [{
                  property: 'domain',
                  op: '=',
                  value: domain
                }]
              }]
            }
          };
          resolve(valueSet);
        } else {
          reject(new Error(`Unknown Value Domain ${id}`));
        }
      });
    });
  }

  // Register concept maps for vocabularies
  /**
   * @param {any[]} list - ConceptMap accumulator
   * @returns {Promise<void>}
   */
  async registerConceptMaps(list) {
    const db = this.#requireDb();
    return new Promise((resolve, reject) => {
      const sql = 'SELECT DISTINCT vocabulary_id FROM Concepts';

      db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of /** @type {OMOPRow[]} */ (rows)) {
            const key = row.vocabulary_id;
            if (key == null) {
              continue;
            }
            const uri = getUri(key);
            if (uri) {
              // Create concept maps (simplified structure)
              list.push({
                id: `to-${key}`,
                url: `${this.system()}/ConceptMap/to-${key}`,
                sourceUri: this.system(),
                targetUri: uri
              });
              list.push({
                id: `from-${key}`,
                url: `${this.system()}/ConceptMap/from-${key}`,
                sourceUri: uri,
                targetUri: this.system()
              });
            }
          }
          resolve(undefined);
        }
      });
    });
  }

  versionAlgorithm() {
    return 'date';
  }
}

class OMOPServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param {any} i18n - Translation support
   * @param {string} dbPath - Path to OMOP SQLite database
   */
  constructor(i18n, dbPath) {
    super(i18n);
    this.dbPath = dbPath;
    this.uses = 0;
    this._loaded = false;
    /** @type {OMOPSharedData | null} */
    this._sharedData = null;
  }

  system() {
    return 'https://fhir-terminology.ohdsi.org';
  }

  version() {
    return this._sharedData ? this._sharedData._version : null;
  }

  /**
   * @param {string} url - ValueSet URL
   * @param {string | null | undefined} version - ValueSet version
   * @returns {Promise<OMOPValueSetLike | null>}
   */
  async buildKnownValueSet(url, version) {
    if (!url.startsWith('https://fhir-terminology.ohdsi.org/ValueSet')) {
      return null;
    }
    if (version && version != this.version()) {
      return null;
    }
    if (url == 'https://fhir-terminology.ohdsi.org') {
      return {
        resourceType: 'ValueSet',
        url: url,
        status: 'active',
        version: this.version(),
        name: 'OMOP',
        description: 'OMOP value set',
        date: new Date().toISOString(),
        experimental: false,
        compose: {
          include: [{
            system: this.system()
        }]
      }
    }
    }
    const domain = url.substring(44);
    return {
      resourceType: 'ValueSet',
      url: url,
      status: 'active',
      version: this.version(),
      name: 'OMOPDomain' + domain,
      description: 'OMOP value set for domain ' + domain,
      date: new Date().toISOString(),
      experimental: false,
      compose: {
        include: [{
          system: this.system(),
          filter: [{
            property: 'domain',
            op: '=',
            value: domain
          }]
        }]
      }
    };


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
      this._sharedData = {
        _version: 'unknown'
      };

      // Load version from OMOP Extension vocabulary
      await this.#loadVersion(db);

    } finally {
      db.close();
    }
    this._loaded = true;
  }

  /**
   * @param {SqliteDatabase} db - OMOP database
   * @returns {Promise<void>}
   */
  async #loadVersion(db) {
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT vocabulary_version
          FROM Vocabularies
          WHERE vocabulary_id = 'OMOP Extension'
      `;

      db.get(sql, (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          const omopRow = /** @type {OMOPRow} */ (row);
          // Extract version number from the end of the version string
          const version = String(omopRow.vocabulary_version || 'unknown');
          const lastSpaceIndex = version.lastIndexOf(' ');
          const sharedData = /** @type {OMOPSharedData} */ (this._sharedData);
          sharedData._version = lastSpaceIndex !== -1 ?
            version.substring(lastSpaceIndex + 1) : version;
          resolve(undefined);
        } else {
          const sharedData = /** @type {OMOPSharedData} */ (this._sharedData);
          sharedData._version = 'unknown';
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
   * @returns {Promise<OMOPServices>} New provider
   */
  async build(opContext, supplements) {
    await this.#ensureLoaded();
    this.recordUse();

    // Create fresh database connection for this provider instance
    const db = new sqlite3.Database(this.dbPath);

    return new OMOPServices(opContext, supplements, db, /** @type {OMOPSharedData} */ (this._sharedData));
  }

  /**
   * @param {string} dbPath - Path to OMOP database
   * @returns {Promise<string>} Database status
   */
  static async checkDB(dbPath) {
    const fs = require('fs');
    try {
      if (!fs.existsSync(dbPath)) {
        return 'Database file not found';
      }
      const stats = fs.statSync(dbPath);
      if (stats.size < 1024) {
        return 'Database file too small';
      }
    } catch (e) {
      return `Database error: ${e instanceof Error ? e.message : String(e)}`;
    }

    let db;
    try {
      db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    } catch (e) {
      return `Database error: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      // Simple count query to verify database integrity. If the Concepts
      // table is missing, db.get rejects and we fall through to the catch.
      const row = await new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) as count FROM Concepts', (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
      const countRow = row ? /** @type {OMOPRow} */ (row) : null;
      return `OK (${countRow && countRow.count != null ? countRow.count : 0} Concepts)`;
    } catch (_e) {
      return 'Missing Tables - needs re-importing (by java)';
    } finally {
      await new Promise((resolve) => db.close(() => resolve(undefined)));
    }
  }


  /**
   * build and return a known concept map from the URL, if there is one.
   *
   * @param {any[]} conceptMaps - ConceptMap accumulator
   * @param {string} source - Source system
   * @param {string} dest - Destination system
   * @returns {Promise<void>}
   */
  async findImplicitConceptMaps(conceptMaps, source, dest) {
    if (source == 'https://fhir-terminology.ohdsi.org') {
      const key = this.#getVocabId(dest);
      if (key) {
        conceptMaps.push(new ConceptMap(this.makeCM(source, dest, key)));
      }
    } else if (dest == 'https://fhir-terminology.ohdsi.org') {
      const key = this.#getVocabId(source);
      if (key) {
        conceptMaps.push(new ConceptMap(this.makeCM(source, dest, key)));
      }
    } else {
      // nothing
    }
  }

  /**
   * @param {string} url - ConceptMap URL
   * @param {string | null | undefined} version - ConceptMap version
   * @returns {Promise<null>}
   */
  // eslint-disable-next-line no-unused-vars
  async findImplicitConceptMap(url, version) {
    return null;
  }

  /**
   * @param {string} url - CodeSystem URL
   * @returns {number | undefined} OMOP vocabulary id
   */
  #getVocabId(url) {
    /** @type {Record<string, number>} */
    const vocabMap = {
      'http://hl7.org/fhir/sid/icd-9-cm': 5046,
      'http://snomed.info/sct': 44819097,
      'http://hl7.org/fhir/sid/icd-10-cm': 44819098,
      // 'http://hl7.org/fhir/sid/icd-9-cm': 44819099, // duplicate - using first value
      'http://www.ama-assn.org/go/cpt': 44819100,
      'http://terminology.hl7.org/CodeSystem/HCPCS-all-codes': 44819101,
      'http://loinc.org': 44819102,
      'http://www.nlm.nih.gov/research/umls/rxnorm': 44819104,
      'http://hl7.org/fhir/sid/ndc': 44819105,
      'http://unitsofmeasure.org': 44819107,
      'http://nucc.org/provider-taxonomy': 44819137,
      'http://www.whocc.no/atc': 44819117
    };

    return vocabMap[url];
  }

  /**
   * @param {string} source - Source system
   * @param {string} dest - Destination system
   * @param {number} key - OMOP vocabulary id
   * @returns {any} ConceptMap JSON
   */
  makeCM(source, dest, key) {
    return {
      resourceType: 'ConceptMap',
      internalSource: this,
      url: this.system() + '/ConceptMap/' + key,
      status: 'active',
      group: [{
        source: source,
        target: dest
      }]
    };
  }


  name() {
    return `OMOP Concepts`;
  }

  id() {
    return 'omop';
  }
}

module.exports = {
  OMOPServices,
  OMOPServicesFactory,
  OMOPConcept,
  OMOPFilter
};
