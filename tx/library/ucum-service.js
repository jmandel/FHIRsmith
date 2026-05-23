/**
 * UCUM Service - Main service class for UCUM operations
 * BSD 3-Clause License
 * Copyright (c) 2006+, Health Intersections Pty Ltd
 */
// @ts-check

const {
  UcumException, Pair, Registry, UcumVersionDetails
} = require('./ucum-types.js');

const {
  ExpressionParser, ExpressionComposer, FormalStructureComposer,
  UcumEssenceParser, Search, Converter, UcumValidator
} = require('./ucum-parsers.js');

/** @typedef {any} Decimal */
/** @typedef {any} ConceptKind */

// UCUM Service - main service class for UCUM operations
class UcumService {
  constructor() {
    /** @type {any} */
    this.model = null;
    this.handlers = new Registry();
  }

  /**
   * @param {string} xmlContent
   */
  init(xmlContent) {
    const parser = new UcumEssenceParser();
    this.model = parser.parse(xmlContent);
  }

  /**
   * Given a unit, return a formal description of what the units stand for using
   * full names
   * @param {string} unit the unit code
   * @return {string} formal description
   * @throws {UcumException}
   */
  analyse(unit) {
    if (!unit || !unit.trim()) {
      return "(unity)";
    }

    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    const term = new ExpressionParser(this.model).parse(unit);
    return new FormalStructureComposer().compose(term);
  }

  /**
   * Convert a unit to its canonical form
   * @param {string} unit the unit code
   * @return {string} canonical units
   * @throws {UcumException}
   */
  getCanonicalUnits(unit) {
    if (!unit || !unit.trim()) {
      throw new UcumException("getCanonicalUnits: unit must not be null or empty");
    }

    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    try {
      const term = new ExpressionParser(this.model).parse(unit);
      const convertedTerm = new Converter(this.model, this.handlers).convert(term);
      return new ExpressionComposer().compose(convertedTerm, false);
    } catch (e) {
      const error = /** @type {Error} */ (e);
      error.message = `Error processing ${unit}: ${error.message}`;
      throw error;
    }
  }

  /**
   * Check if two units are comparable (can be converted to same canonical form)
   * @param {string} units1 first unit
   * @param {string} units2 second unit
   * @return {boolean} true if comparable
   * @throws {UcumException}
   */
  isComparable(units1, units2) {
    if (!units1 || !units2) {
      return false;
    }

    try {
      const u1 = this.getCanonicalUnits(units1);
      const u2 = this.getCanonicalUnits(units2);
      return u1 === u2;
    } catch (e) {
      const error = /** @type {Error} */ (e);
      console.error('Error message:', error.message);
      console.error('Stack trace:', error.stack);
      return false;
    }
  }

  /**
   * Multiply one quantity by another
   * @param {Pair} o1 the base
   * @param {Pair} o2 the multiplier
   * @return {Pair} the result
   * @throws {UcumException}
   */
  multiply(o1, o2) {
    const res = new Pair(o1.getValue().multiply(o2.getValue()), o1.getCode() +"."+o2.getCode());
    return this.getCanonicalForm(res);
  }
  /**
   * Divide one quantity by another
   * @param {Pair} dividend the dividend
   * @param {Pair} divisor the divisor
   * @return {Pair} the result
   * @throws {UcumException}
   */
  divideBy(dividend, divisor) {
    const dividendCode = dividend.getCode();
    const divisorCode = divisor.getCode();

    const resultValue = dividend.getValue().divide(divisor.getValue());
    const resultCode = (dividendCode.includes("/") || dividendCode.includes("*") ?
        "(" + dividendCode + ")" : dividendCode) + "/" +
      (divisorCode.includes("/") || divisorCode.includes("*") ?
        "(" + divisorCode + ")" : divisorCode);

    const result = new Pair(resultValue, resultCode);
    return this.getCanonicalForm(result);
  }

  /**
   * Convert a Pair to its canonical form
   * @param {Pair} pair the pair to convert
   * @return {Pair} canonical form pair
   * @throws {UcumException}
   */
  getCanonicalForm(pair) {
    if (!pair) {
      throw new UcumException("getCanonicalForm: value must not be null");
    }

    const code = pair.getCode();
    if (!code || !code.trim()) {
      throw new UcumException("getCanonicalForm: value.code must not be null or empty");
    }

    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    const term = new ExpressionParser(this.model).parse(code);
    const c = new Converter(this.model, this.handlers).convert(term);

    let p = null;
    if (pair.getValue() === null || pair.getValue() === undefined) {
      p = new Pair(null, new ExpressionComposer().compose(c, false));
    } else {
      const newValue = pair.getValue().multiply(c.getValue());
      p = new Pair(newValue, new ExpressionComposer().compose(c, false));

      if (pair.getValue().isWholeNumber()) {
        // whole numbers are tricky - they have implied infinite precision, but we need to check for digit errors in the last couple of digits
        if (p.getValue().checkForCouldBeWholeNumber) {
          p.getValue().checkForCouldBeWholeNumber();
        }
      }
    }

    return p;
  }

  /**
   * Validate the UCUM model
   * @return {Array<string>} list of validation errors
   */
  validateUCUM() {
    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    const validator = new UcumValidator(this.model, this.handlers);
    return validator.validate();
  }

  /**
   * Get UCUM version identification
   * @return {UcumVersionDetails} version details
   */
  ucumIdentification() {
    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    return new UcumVersionDetails(this.model.revisionDate, this.model.version);
  }

  /**
   * Validate a unit expression
   * @param {string} unit the unit to validate
   * @return {string | null} null if valid, error message if invalid
   */
  validate(unit) {
    if (!unit) {
      return "unit must not be null";
    }

    if (!this.model) {
      return "UCUM service not initialized - call init() first";
    }

    try {
      new ExpressionParser(this.model).parse(unit);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Check if a unit expression is valid
   * @param {string} unit the unit to check
   * @return {boolean} true if valid, false if invalid
   */
  isValidUnit(unit) {
    return this.validate(unit) === null;
  }

  /**
   * Convert a value from one unit to another
   * @param {Decimal} value the value to convert
   * @param {string} sourceUnit source unit
   * @param {string} destUnit destination unit
   * @return {Decimal} converted value
   * @throws {UcumException}
   */
  convert(value, sourceUnit, destUnit) {
    if (!value) {
      throw new UcumException("convert: value must not be null");
    }
    if (!sourceUnit || !sourceUnit.trim()) {
      throw new UcumException("convert: sourceUnit must not be null or empty");
    }
    if (!destUnit || !destUnit.trim()) {
      throw new UcumException("convert: destUnit must not be null or empty");
    }

    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    if (sourceUnit === destUnit) {
      return value;
    }

    const src = new Converter(this.model, this.handlers).convert(
      new ExpressionParser(this.model).parse(sourceUnit)
    );
    const dst = new Converter(this.model, this.handlers).convert(
      new ExpressionParser(this.model).parse(destUnit)
    );

    const s = new ExpressionComposer().compose(src, false);
    const d = new ExpressionComposer().compose(dst, false);

    if (s !== d) {
      throw new UcumException(
        `Unable to convert between units ${sourceUnit} and ${destUnit} as they do not have matching canonical forms (${s} and ${d} respectively)`
      );
    }

    const canValue = value.multiply(src.getValue());
    let res = canValue.divide(dst.getValue());

    if (value.isWholeNumber()) {
      // whole numbers are tricky - they have implied infinite precision, but we need to check for digit errors in the last couple of digits
      if (res.checkForCouldBeWholeNumber) {
        res.checkForCouldBeWholeNumber();
      }
    }

    return res;
  }

  /**
   * Get all properties from defined units
   * @return {Set<string>} set of properties
   */
  getProperties() {
    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    /** @type {Set<string>} */
    const result = new Set();
    for (const unit of this.model.getDefinedUnits()) {
      if (unit.property) {
        result.add(unit.property);
      }
    }
    return result;
  }

  /**
   * Get all prefixes
   * @return {any[]} array of prefixes
   */
  getPrefixes() {
    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    return this.model.getPrefixes();
  }

  /**
   * Get all base units
   * @return {any[]} array of base units
   */
  getBaseUnits() {
    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    return this.model.getBaseUnits();
  }

  /**
   * Get all defined units
   * @return {any[]} array of defined units
   */
  getDefinedUnits() {
    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    return this.model.getDefinedUnits();
  }

  /**
   * Get the UCUM model
   * @return {any} the loaded model
   */
  getModel() {
    return this.model;
  }

  /**
   * Get the handlers registry
   * @return {Registry} the handlers registry
   */
  getHandlers() {
    return this.handlers;
  }

  /**
   * Search for concepts in the model
   * @param {ConceptKind | null} [kind] - type of concept to search for (optional)
   * @param {string} text - text to search for
   * @param {boolean} isRegex - whether text is a regex pattern
   * @return {any[]} array of matching concepts
   */
  search(kind = null, text = '', isRegex = false) {
    if (!this.model) {
      throw new UcumException("UCUM service not initialized - call init() first");
    }

    const search = new Search();
    return search.doSearch(this.model, kind, text, isRegex);
  }
}

module.exports = {
  UcumService
};
