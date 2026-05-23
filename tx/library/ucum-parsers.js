// @ts-check

/**
 * UCUM Parsers - JavaScript port of UCUM Java library parsers
 * BSD 3-Clause License
 * Copyright (c) 2006+, Health Intersections Pty Ltd
 */

const {XMLParser} = require('fast-xml-parser');
const {
  ConceptKind, Operator, TokenType, UcumException, Decimal, Utilities,
  BaseUnit, DefinedUnit, Prefix, Value, Term, Symbol, Factor, Canonical, CanonicalUnit,
  Registry
} = require('./ucum-types.js');
const regexUtilities = require("../../library/regex-utilities");

/**
 * @typedef {import('./ucum-types.js').BaseUnit} BaseUnitType
 * @typedef {import('./ucum-types.js').Canonical} CanonicalType
 * @typedef {import('./ucum-types.js').CanonicalUnit} CanonicalUnitType
 * @typedef {import('./ucum-types.js').Decimal} DecimalType
 * @typedef {import('./ucum-types.js').DefinedUnit} DefinedUnitType
 * @typedef {import('./ucum-types.js').Factor} FactorType
 * @typedef {import('./ucum-types.js').Prefix} PrefixType
 * @typedef {import('./ucum-types.js').Registry} RegistryType
 * @typedef {import('./ucum-types.js').Symbol} SymbolType
 * @typedef {import('./ucum-types.js').Term} TermType
 * @typedef {import('./ucum-types.js').Value} ValueType
 * @typedef {BaseUnitType|DefinedUnitType|PrefixType} UcumConcept
 * @typedef {BaseUnitType|DefinedUnitType} UcumUnit
 * @typedef {{ error: (...args: unknown[]) => void }} ErrorLogger
 * @typedef {Record<string, any>} XmlNode
 */

// Lexer for tokenizing UCUM expressions (port of Lexer.java)
class Lexer {
  static NO_CHAR = '\0';

  /**
   * @param {string} source
   */
  constructor(source) {
    if (typeof source !== 'string') {
      throw new Error("not a string");
    }
    /** @type {string} */
    this.source = source || '';
    /** @type {number} */
    this.index = 0;
    /** @type {string|null} */
    this.token = null;
    /** @type {string} */
    this.type = TokenType.NONE;
    /** @type {number} */
    this.start = 0;

    this.consume();
  }

  consume() {
    this.token = null;
    this.type = TokenType.NONE;
    this.start = this.index;

    if (this.index < this.source.length) {
      const ch = this._nextChar();

      if (!(this._checkSingle(ch, '/', TokenType.SOLIDUS) ||
        this._checkSingle(ch, '.', TokenType.PERIOD) ||
        this._checkSingle(ch, '(', TokenType.OPEN) ||
        this._checkSingle(ch, ')', TokenType.CLOSE) ||
        this._checkAnnotation(ch) ||
        this._checkNumber(ch) ||
        this._checkNumberOrSymbol(ch))) {
        throw new UcumException(`Error processing unit '${this.source}': unexpected character '${ch}' at character ${this.start+1}`);
      }
    }
  }

  /**
   * @param {string} ch
   * @returns {boolean}
   */
  _checkNumber(ch) {
    if (ch === '+' || ch === '-') {
      this.token = ch;
      let nextCh = this._peekChar();

      while (nextCh >= '0' && nextCh <= '9') {
        this.token += nextCh;
        this.index++;
        nextCh = this._peekChar();
      }

      if (this.token.length === 1) {
        throw new UcumException(`Error processing unit '${this.source}': unexpected character '${ch}' at character ${this.start+1}: a + or - must be followed by at least one digit`);
      }

      this.type = TokenType.NUMBER;
      return true;
    }
    return false;
  }

  /**
   * @param {string} ch
   * @returns {boolean}
   */
  _checkNumberOrSymbol(ch) {
    let isSymbol = false;
    let inBrackets = false;

    if (this._isValidSymbolChar(ch, true, false)) {
      this.token = ch;
      isSymbol = isSymbol || !(ch >= '0' && ch <= '9');
      inBrackets = this._checkBrackets(ch, inBrackets);

      let nextCh = this._peekChar();
      inBrackets = this._checkBrackets(nextCh, inBrackets);

      while (this._isValidSymbolChar(nextCh, !isSymbol || inBrackets, inBrackets)) {
        this.token += nextCh;
        isSymbol = isSymbol || (nextCh !== Lexer.NO_CHAR && !(nextCh >= '0' && nextCh <= '9'));
        this.index++;
        nextCh = this._peekChar();
        inBrackets = this._checkBrackets(nextCh, inBrackets);
      }

      this.type = isSymbol ? TokenType.SYMBOL : TokenType.NUMBER;
      return true;
    }
    return false;
  }

  /**
   * @param {string} ch
   * @param {boolean} inBrackets
   * @returns {boolean}
   */
  _checkBrackets(ch, inBrackets) {
    if (ch === '[') {
      if (inBrackets) {
        this.error('Nested [');
      }
      return true;
    }
    if (ch === ']') {
      if (!inBrackets) {
        this.error('] without [');
      }
      return false;
    }
    return inBrackets;
  }

  /**
   * @param {string} ch
   * @param {boolean} allowDigits
   * @param {boolean} inBrackets
   * @returns {boolean}
   */
  _isValidSymbolChar(ch, allowDigits, inBrackets) {
    return (allowDigits && ch >= '0' && ch <= '9') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      ch === '[' || ch === ']' || ch === '%' || ch === '*' ||
      ch === '^' || ch === "'" || ch === '"' || ch === '_' ||
      (inBrackets && ch === '.');
  }

  /**
   * @param {string} ch
   * @returns {boolean}
   */
  _checkAnnotation(ch) {
    if (ch === '{') {
      const b = [];
      let nextCh = this._nextChar();

      while (nextCh !== '}') {
        if (!Utilities.isAsciiChar(nextCh)) {
          throw new UcumException(`Error processing unit '${this.source}': Annotation contains non-ascii characters`);
        }
        if (nextCh === Lexer.NO_CHAR) {
          throw new UcumException(`Error processing unit '${this.source}': unterminated annotation`);
        }
        b.push(nextCh);
        nextCh = this._nextChar();
      }

      this.token = b.join('');
      this.type = TokenType.ANNOTATION;
      return true;
    }
    return false;
  }

  /**
   * @param {string} ch
   * @param {string} test
   * @param {string} type
   * @returns {boolean}
   */
  _checkSingle(ch, test, type) {
    if (ch === test) {
      this.token = ch;
      this.type = type;
      return true;
    }
    return false;
  }

  /**
   * @returns {string}
   */
  _nextChar() {
    const res = this.index < this.source.length ? this.source.charAt(this.index) : Lexer.NO_CHAR;
    this.index++;
    return res;
  }

  /**
   * @returns {string}
   */
  _peekChar() {
    return this.index < this.source.length ? this.source.charAt(this.index) : Lexer.NO_CHAR;
  }

  /**
   * @returns {string|null}
   */
  getToken() {
    return this.token;
  }

  /**
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * @param {string} errMsg
   * @returns {never}
   */
  error(errMsg) {
    throw new UcumException(`Error processing unit '${this.source}': ${errMsg} at character ${this.start+1}`);
  }

  /**
   * @returns {number}
   */
  getTokenAsInt() {
    if (this.token == null) {
      throw new UcumException(`Error processing unit '${this.source}': missing numeric token at character ${this.start+1}`);
    }
    return this.token.charAt(0) === '+' ? parseInt(this.token.substring(1)) : parseInt(this.token);
  }

  /**
   * @returns {boolean}
   */
  finished() {
    return this.index === this.source.length;
  }
}

// Expression parser for UCUM unit expressions (port of ExpressionParser.java)
class ExpressionParser {
  /**
   * @param {UcumModel} model
   */
  constructor(model) {
    /** @type {UcumModel} */
    this.model = model;
  }

  /**
   * @param {string} code
   * @returns {TermType}
   */
  parse(code) {
    const lexer = new Lexer(code);
    const res = this._parseTerm(lexer, true);

    if (!lexer.finished()) {
      throw new UcumException('Expression was not parsed completely. Syntax Error?');
    }

    return res;
  }

  /**
   * @param {Lexer} lexer
   * @param {boolean} first
   * @returns {TermType}
   */
  _parseTerm(lexer, first) {
    const res = new Term();

    if (first && lexer.getType() === TokenType.NONE) {
      res.comp = new Factor(1);
    } else if (lexer.getType() === TokenType.SOLIDUS) {
      res.op = Operator.DIVISION;
      lexer.consume();
      res.term = this._parseTerm(lexer, false);
    } else {
      if (lexer.getType() === TokenType.ANNOTATION) {
        res.comp = new Factor(1); // still lose the annotation
        lexer.consume();
      } else {
        res.comp = this._parseComp(lexer);
      }

      if (lexer.getType() !== TokenType.NONE && lexer.getType() !== TokenType.CLOSE) {
        if (lexer.getType() === TokenType.SOLIDUS) {
          res.op = Operator.DIVISION;
          lexer.consume();
        } else if (lexer.getType() === TokenType.PERIOD) {
          res.op = Operator.MULTIPLICATION;
          lexer.consume();
        } else if (lexer.getType() === TokenType.ANNOTATION) {
          res.op = Operator.MULTIPLICATION; // implicit
        } else {
          lexer.error("Expected '/' or '.'");
        }
        res.term = this._parseTerm(lexer, false);
      }
    }

    return res;
  }

  /**
   * @param {Lexer} lexer
   * @returns {FactorType|SymbolType|TermType}
   */
  _parseComp(lexer) {
    if (lexer.getType() === TokenType.NUMBER) {
      const fact = new Factor(lexer.getTokenAsInt());
      lexer.consume();
      return fact;
    } else if (lexer.getType() === TokenType.SYMBOL) {
      return this._parseSymbol(lexer);
    } else if (lexer.getType() === TokenType.NONE) {
      lexer.error('unexpected end of expression looking for a symbol or a number');
    } else if (lexer.getType() === TokenType.OPEN) {
      lexer.consume();
      const res = this._parseTerm(lexer, true);
      if (lexer.getType() === TokenType.CLOSE) {
        lexer.consume();
      } else {
        lexer.error(`Unexpected Token Type '${lexer.getType()}' looking for a close bracket`);
      }
      return res;
    } else {
      lexer.error('unexpected token looking for a symbol or a number');
    }
    lexer.error('unreachable parser state');
  }

  /**
   * @param {Lexer} lexer
   * @returns {SymbolType}
   */
  _parseSymbol(lexer) {
    const symbol = new Symbol();
    const sym = lexer.getToken() || '';

    // now, can we pick a prefix that leaves behind a metric unit?
    /** @type {PrefixType|null} */
    let selected = null;
    /** @type {UcumUnit|null} */
    let unit = null;

    for (const prefix of this.model.getPrefixes()) {
      if (sym.startsWith(prefix.code)) {
        unit = this.model.getUnit(sym.substring(prefix.code.length)) || null;
        if (unit != null && (unit.kind === ConceptKind.BASEUNIT || /** @type {DefinedUnitType} */ (unit).metric)) {
          selected = prefix;
          break;
        }
      }
    }

    if (selected !== null) {
      symbol.prefix = selected;
      symbol.unit = unit;
    } else {
      unit = this.model.getUnit(sym) || null;
      if (unit != null) {
        symbol.unit = unit;
      } else if (sym !== '1') {
        lexer.error(`The unit '${sym}' is unknown`);
      }
    }

    lexer.consume();
    if (lexer.getType() === TokenType.NUMBER) {
      symbol.exponent = lexer.getTokenAsInt();
      lexer.consume();
    } else {
      symbol.exponent = 1;
    }

    return symbol;
  }
}

// Expression composer for creating string representations (port of ExpressionComposer.java)
class ExpressionComposer {
  /**
   * @param {TermType|CanonicalType|null|undefined} termOrCanonical
   * @param {boolean} [includeValue]
   * @returns {string}
   */
  compose(termOrCanonical, includeValue = true) {
    if (termOrCanonical === null || termOrCanonical === undefined) {
      return '1';
    }

    // Handle Canonical objects
    if (termOrCanonical instanceof Canonical) {
      return this.composeCanonical(termOrCanonical, includeValue);
    }

    // Handle Term objects
    /** @type {string[]} */
    const bldr = [];
    this._composeTerm(bldr, termOrCanonical);
    return bldr.join('');
  }

  /**
   * @param {CanonicalType} can
   * @param {boolean} [includeValue]
   * @returns {string}
   */
  composeCanonical(can, includeValue = true) {
    const b = [];
    if (includeValue) {
      b.push(can.value.toString());
    }

    let first = true;
    for (const c of can.units) {
      if (first) {
        first = false;
      } else {
        b.push('.');
      }
      b.push(c.base.code);
      if (c.exponent !== 1) {
        b.push(c.exponent.toString());
      }
    }
    return b.join('');
  }

  /**
   * @param {string[]} bldr
   * @param {TermType} term
   */
  _composeTerm(bldr, term) {
    if (term.comp !== null) {
      this._composeComp(bldr, term.comp);
    }
    if (term.op !== null) {
      this._composeOp(bldr, term.op);
    }
    if (term.term !== null) {
      this._composeTerm(bldr, term.term);
    }
  }

  /**
   * @param {string[]} bldr
   * @param {FactorType|SymbolType|TermType} comp
   */
  _composeComp(bldr, comp) {
    if (comp instanceof Factor) {
      this._composeFactor(bldr, comp);
    } else if (comp instanceof Symbol) {
      this._composeSymbol(bldr, comp);
    } else if (comp instanceof Term) {
      bldr.push('(');
      this._composeTerm(bldr, comp);
      bldr.push(')');
    } else {
      bldr.push('?');
    }
  }

  /**
   * @param {string[]} bldr
   * @param {SymbolType} symbol
   */
  _composeSymbol(bldr, symbol) {
    if (symbol.prefix !== null) {
      bldr.push(symbol.prefix.code);
    }
    bldr.push(/** @type {UcumUnit} */ (symbol.unit).code);
    if (symbol.exponent !== 1) {
      bldr.push(symbol.exponent.toString());
    }
  }

  /**
   * @param {string[]} bldr
   * @param {FactorType} comp
   */
  _composeFactor(bldr, comp) {
    bldr.push(comp.value.toString());
  }

  /**
   * @param {string[]} bldr
   * @param {string} op
   */
  _composeOp(bldr, op) {
    if (op === Operator.DIVISION) {
      bldr.push('/');
    } else {
      bldr.push('.');
    }
  }
}

// Formal structure composer for human-readable representations (port of FormalStructureComposer.java)
class FormalStructureComposer {
  /**
   * @param {TermType} term
   * @returns {string}
   */
  compose(term) {
    /** @type {string[]} */
    const bldr = [];
    this._composeTerm(bldr, term);
    return bldr.join('');
  }

  /**
   * @param {string[]} bldr
   * @param {TermType} term
   */
  _composeTerm(bldr, term) {
    if (term.comp !== null) {
      this._composeComp(bldr, term.comp);
    }
    if (term.op !== null) {
      this._composeOp(bldr, term.op);
    }
    if (term.term !== null) {
      this._composeTerm(bldr, term.term);
    }
  }

  /**
   * @param {string[]} bldr
   * @param {FactorType|SymbolType|TermType} comp
   */
  _composeComp(bldr, comp) {
    if (comp instanceof Factor) {
      this._composeFactor(bldr, comp);
    } else if (comp instanceof Symbol) {
      this._composeSymbol(bldr, comp);
    } else if (comp instanceof Term) {
      this._composeTerm(bldr, comp);
    } else {
      bldr.push('?');
    }
  }

  /**
   * @param {string[]} bldr
   * @param {SymbolType} symbol
   */
  _composeSymbol(bldr, symbol) {
    bldr.push('(');
    if (symbol.prefix !== null) {
      bldr.push(symbol.prefix.names[0]);
    }
    bldr.push(/** @type {UcumUnit} */ (symbol.unit).names[0]);
    if (symbol.exponent !== 1) {
      bldr.push(' ^ ');
      bldr.push(symbol.exponent.toString());
    }
    bldr.push(')');
  }

  /**
   * @param {string[]} bldr
   * @param {FactorType} comp
   */
  _composeFactor(bldr, comp) {
    bldr.push(comp.value.toString());
  }

  /**
   * @param {string[]} bldr
   * @param {string} op
   */
  _composeOp(bldr, op) {
    if (op === Operator.DIVISION) {
      bldr.push(' / ');
    } else {
      bldr.push(' * ');
    }
  }
}

// UCUM model for storing all units, prefixes, etc.
class UcumModel {
  /**
   * @param {string|null} [version]
   * @param {string|null} [revision]
   * @param {Date|null} [revisionDate]
   */
  constructor(version = null, revision = null, revisionDate = null) {
    /** @type {string|null} */
    this.version = version;
    /** @type {string|null} */
    this.revision = revision;
    /** @type {Date|null} */
    this.revisionDate = revisionDate;
    /** @type {PrefixType[]} */
    this.prefixes = [];
    /** @type {BaseUnitType[]} */
    this.baseUnits = [];
    /** @type {DefinedUnitType[]} */
    this.definedUnits = [];
    /** @type {Map<string, UcumUnit>} */
    this.unitsMap = new Map(); // For quick lookup by code
  }

  /**
   * @param {PrefixType} prefix
   */
  addPrefix(prefix) {
    this.prefixes.push(prefix);
  }

  /**
   * @param {BaseUnitType} unit
   */
  addBaseUnit(unit) {
    this.baseUnits.push(unit);
    this.unitsMap.set(unit.code, unit);
    if (unit.codeUC !== unit.code) {
      this.unitsMap.set(unit.codeUC, unit);
    }
  }

  /**
   * @param {DefinedUnitType} unit
   */
  addDefinedUnit(unit) {
    this.definedUnits.push(unit);
    this.unitsMap.set(unit.code, unit);
  }

  /**
   * @param {string} code
   * @returns {UcumUnit|undefined}
   */
  getUnit(code) {
    return this.unitsMap.get(code);
  }

  /**
   * @returns {PrefixType[]}
   */
  getPrefixes() {
    return this.prefixes;
  }

  /**
   * @returns {BaseUnitType[]}
   */
  getBaseUnits() {
    return this.baseUnits;
  }

  /**
   * @returns {DefinedUnitType[]}
   */
  getDefinedUnits() {
    return this.definedUnits;
  }

  /**
   * @returns {UcumUnit[]}
   */
  getAllUnits() {
    return [...this.baseUnits, ...this.definedUnits];
  }
}

// Parser for UCUM essence XML format using fast-xml-parser
class UcumEssenceParser {
  constructor() {
    /** @type {XMLParser} */
    this.parser = new XMLParser(/** @type {any} */ ({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: true,
      parseTrueNumberOnly: false,
      arrayMode: false,
      alwaysCreateTextNode: true
    }));
  }

  /**
   * @param {string} xmlContent
   * @returns {UcumModel}
   */
  parse(xmlContent) {
    let parsedXml;
    try {
      parsedXml = this.parser.parse(xmlContent);
    } catch (e) {
      const err = /** @type {Error} */ (e);
      err.message = `Invalid XML content: ${err.message}`;
      throw err;
    }

    const root = /** @type {XmlNode|undefined} */ (parsedXml.root);
    if (!root) {
      throw new UcumException("Unable to process XML document: expected 'root' element not found");
    }

    // Parse revision date
    let date = null;
    if (root['@_revision-date']) {
      const dt = root['@_revision-date'];
      if (dt.length > 25) {
        // old format: $Date: 2017-11-21 19:04:52 -0500"
        const dateStr = dt.substring(7, 32);
        date = new Date(dateStr);
      } else {
        date = new Date(dt);
      }
    }

    const model = new UcumModel(
      root['@_version'],
      root['@_revision'],
      date
    );

    // Parse prefixes
    if (root.prefix) {
      const prefixes = Array.isArray(root.prefix) ? root.prefix : [root.prefix];
      for (const prefixData of prefixes) {
        model.addPrefix(this._parsePrefix(prefixData));
      }
    }

    // Parse base units
    if (root['base-unit']) {
      const baseUnits = Array.isArray(root['base-unit']) ? root['base-unit'] : [root['base-unit']];
      for (const unitData of baseUnits) {
        model.addBaseUnit(this._parseBaseUnit(unitData));
      }
    }

    // Parse defined units
    if (root.unit) {
      const units = Array.isArray(root.unit) ? root.unit : [root.unit];
      for (const unitData of units) {
        model.addDefinedUnit(this._parseUnit(unitData));
      }
    }

    return model;
  }

  /**
   * @param {XmlNode} x
   * @returns {DefinedUnitType}
   */
  _parseUnit(x) {
    const unit = new DefinedUnit(x['@_Code'], x['@_CODE']);
    unit.metric = x['@_isMetric'] === 'yes';
    unit.isSpecial = x['@_isSpecial'] === 'yes';
    unit.class_ = x['@_class'];

    // Parse names
    if (x.name) {
      const names = Array.isArray(x.name) ? x.name : [x.name];
      for (const nameData of names) {
        const nameText = typeof nameData === 'string' ? nameData : nameData['#text'];
        if (nameText) {
          unit.names.push(nameText);
        }
      }
    }

    // Parse print symbol
    if (x.printSymbol) {
      unit.printSymbol = typeof x.printSymbol === 'string' ? x.printSymbol : x.printSymbol['#text'];
    }

    // Parse property
    if (x.property) {
      unit.property = typeof x.property === 'string' ? x.property : x.property['#text'];
    }

    // Parse value
    if (x.value) {
      unit.value = this._parseValue(x.value, `unit ${unit.code}`);
    }


    return unit;
  }

  /**
   * @param {XmlNode|string} x
   * @param {string} context
   * @returns {ValueType}
   */
  _parseValue(x, context) {
    let val = null;
    const valueAttr = typeof x === 'string' ? undefined : x['@_value'];
    if (valueAttr !== null && valueAttr !== undefined && valueAttr) {
      try {
        if (valueAttr.includes("."))
          val = new (/** @type {any} */ (Decimal))(valueAttr, 24); // unlimited precision for these
        else
          val = new Decimal(valueAttr);
      } catch (e) {
        const err = /** @type {Error} */ (e);
        err.message = "Error reading "+context+": "+err.message;
        throw err;
      }
    }
    const value = new Value(
      typeof x === 'string' ? '' : x['@_Unit'] || '',
      typeof x === 'string' ? '' : x['@_UNIT'] || '',
      val
    );
    value.text = typeof x === 'string' ? x : x['#text'] || '';
    return value;
  }

  /**
   * @param {XmlNode} x
   * @returns {BaseUnitType}
   */
  _parseBaseUnit(x) {
    const base = new BaseUnit(x['@_Code'], x['@_CODE']);
    const dimAttr = x['@_dim'];
    if (dimAttr) {
      base.dim = String(dimAttr).charAt(0);
    }

    // Parse names
    if (x.name) {
      const names = Array.isArray(x.name) ? x.name : [x.name];
      for (const nameData of names) {
        const nameText = typeof nameData === 'string' ? nameData : nameData['#text'];
        if (nameText) {
          base.names.push(nameText);
        }
      }
    }

    // Parse print symbol
    if (x.printSymbol) {
      base.printSymbol = typeof x.printSymbol === 'string' ? x.printSymbol : x.printSymbol['#text'];
    }

    // Parse property
    if (x.property) {
      base.property = typeof x.property === 'string' ? x.property : x.property['#text'];
    }

    return base;
  }

  /**
   * @param {XmlNode} x
   * @returns {PrefixType}
   */
  _parsePrefix(x) {
    const prefix = new Prefix(x['@_Code'], x['@_CODE']);

    // Parse names
    if (x.name) {
      const names = Array.isArray(x.name) ? x.name : [x.name];
      for (const nameData of names) {
        const nameText = typeof nameData === 'string' ? nameData : nameData['#text'];
        if (nameText) {
          prefix.names.push(nameText);
        }
      }
    }

    // Parse print symbol
    if (x.printSymbol) {
      prefix.printSymbol = typeof x.printSymbol === 'string' ? x.printSymbol : x.printSymbol['#text'];
    }

    // Parse value
    if (x.value && x.value['@_value']) {
      try {
        const valueStr = String(x.value['@_value']);
        // Handle scientific notation by converting to regular decimal first
        if (valueStr.includes('e') || valueStr.includes('E')) {
          const numValue = parseFloat(valueStr);
          if (isNaN(numValue)) {
            throw new Error(`Invalid numeric value: ${valueStr}`);
          }
          prefix.value = new (/** @type {any} */ (Decimal))(numValue.toString(), 24);
        } else {
          prefix.value = new (/** @type {any} */ (Decimal))(valueStr, 24);
        }
      } catch (e) {
        const err = /** @type {Error} */ (e);
        err.message = `Error parsing prefix '${prefix.code}' value '${x.value['@_value']}': ${err.message}`;
        throw err;
      }
    }

    return prefix;
  }
}

// Search functionality for finding concepts
class Search {
  constructor() {
    /** @type {ErrorLogger} */
    this.log = console;
  }

  /**
   * @param {UcumModel} model
   * @param {string|null} [kind]
   * @param {string} [text]
   * @param {boolean} [isRegex]
   * @returns {UcumConcept[]}
   */
  doSearch(model, kind = null, text = '', isRegex = false) {
    /** @type {UcumConcept[]} */
    const concepts = [];

    if (!kind || kind === ConceptKind.PREFIX) {
      this._searchPrefixes(concepts, model.getPrefixes(), text, isRegex);
    }
    if (!kind || kind === ConceptKind.BASEUNIT) {
      this._searchUnits(concepts, model.getBaseUnits(), text, isRegex);
    }
    if (!kind || kind === ConceptKind.UNIT) {
      this._searchUnits(concepts, model.getDefinedUnits(), text, isRegex);
    }

    return concepts;
  }

  /**
   * @param {UcumConcept[]} concepts
   * @param {UcumUnit[]} units
   * @param {string} text
   * @param {boolean} isRegex
   */
  _searchUnits(concepts, units, text, isRegex) {
    for (const unit of units) {
      if (this._matchesUnit(unit, text, isRegex)) {
        concepts.push(unit);
      }
    }
  }

  /**
   * @param {UcumUnit} unit
   * @param {string} text
   * @param {boolean} isRegex
   * @returns {boolean}
   */
  _matchesUnit(unit, text, isRegex) {
    return this._matches(unit.property, text, isRegex) ||
      this._matchesConcept(unit, text, isRegex);
  }

  /**
   * @param {UcumConcept[]} concepts
   * @param {PrefixType[]} prefixes
   * @param {string} text
   * @param {boolean} isRegex
   */
  _searchPrefixes(concepts, prefixes, text, isRegex) {
    for (const concept of prefixes) {
      if (this._matchesConcept(concept, text, isRegex)) {
        concepts.push(concept);
      }
    }
  }

  /**
   * @param {UcumConcept} concept
   * @param {string} text
   * @param {boolean} isRegex
   * @returns {boolean}
   */
  _matchesConcept(concept, text, isRegex) {
    for (const name of concept.names) {
      if (this._matches(name, text, isRegex)) {
        return true;
      }
    }

    return this._matches(concept.code, text, isRegex) ||
      this._matches(concept.codeUC, text, isRegex) ||
      this._matches(concept.printSymbol, text, isRegex);
  }

  /**
   * @param {string|null|undefined} value
   * @param {string} text
   * @param {boolean} isRegex
   * @returns {boolean}
   */
  _matches(value, text, isRegex) {
    if (!value) return false;

    if (isRegex) {
      try {
        const regex = regexUtilities.compile(text);
        return regex.test(value);
      } catch (e) {
        this.log.error(e);
        return false;
      }
    } else {
      return value.toLowerCase().includes(text.toLowerCase());
    }
  }
}

// Converter for converting terms to canonical form (port of Converter.java)
class Converter {
  /**
   * @param {UcumModel} model
   * @param {RegistryType} [handlers]
   */
  constructor(model, handlers) {
    /** @type {UcumModel} */
    this.model = model;
    /** @type {RegistryType} */
    this.handlers = handlers || new Registry();
  }

  /**
   * @param {TermType} term
   * @returns {CanonicalType}
   */
  convert(term) {
    return this._normalise("  ", term);
  }

  /**
   * @param {string} indent
   * @param {TermType} term
   * @returns {CanonicalType}
   */
  _normalise(indent, term) {
    const result = new Canonical(new Decimal("1.000000000000000000000000000000"));

    this._debug(indent, "canonicalise", term);
    let div = false;
    /** @type {TermType|null} */
    let t = term;

    while (t != null) {
      if (t.comp instanceof Term) {
        const temp = this._normalise(indent + "  ", t.comp);
        if (div) {
          result.divideValue(temp.getValue());
          for (const c of temp.getUnits()) {
            c.setExponent(0 - c.getExponent());
          }
        } else {
          result.multiplyValue(temp.getValue());
        }
        result.getUnits().push(...temp.getUnits());
      } else if (t.comp instanceof Factor) {
        if (div) {
          result.divideValue(t.comp.value);
        } else {
          result.multiplyValue(t.comp.value);
        }
      } else if (t.comp instanceof Symbol) {
        this._debug(indent, "comp", t.comp.unit);
        const temp = this._normaliseSymbol(indent, t.comp);
        if (div) {
          result.divideValue(temp.getValue());
          for (const c of temp.getUnits()) {
            c.setExponent(0 - c.getExponent());
          }
        } else {
          result.multiplyValue(temp.getValue());
        }
        result.getUnits().push(...temp.getUnits());
      }
      div = t.op === Operator.DIVISION;
      t = t.term;
    }

    this._debug(indent, "collate", result);

    // Collate units of the same base
    for (let i = result.getUnits().length - 1; i >= 0; i--) {
      const sf = result.getUnits()[i];
      for (let j = i - 1; j >= 0; j--) {
        const st = result.getUnits()[j];
        if (st.getBase() === sf.getBase()) {
          st.setExponent(sf.getExponent() + st.getExponent());
          result.getUnits().splice(i, 1);
          break;
        }
      }
    }

    // Remove units with 0 exponent
    for (let i = result.getUnits().length - 1; i >= 0; i--) {
      const sf = result.getUnits()[i];
      if (sf.getExponent() === 0) {
        result.getUnits().splice(i, 1);
      }
    }

    this._debug(indent, "sort", result);

    // Sort units by base code
    result.getUnits().sort((lhs, rhs) => {
      return lhs.getBase().code.localeCompare(rhs.getBase().code);
    });

    this._debug(indent, "done", result);
    return result;
  }

  /**
   * @param {string} indent
   * @param {SymbolType} sym
   * @returns {CanonicalType}
   */
  _normaliseSymbol(indent, sym) {
    const result = new Canonical(new Decimal("1.000000000000000000000000000000"));
    const unit = sym.unit;
    if (unit == null) {
      throw new UcumException("No unit found for symbol");
    }

    if (unit instanceof BaseUnit) {
      result.getUnits().push(new CanonicalUnit(unit, sym.exponent));
    } else {
      const can = this._expandDefinedUnit(indent, /** @type {DefinedUnitType} */ (unit));
      for (const c of can.getUnits()) {
        c.setExponent(c.getExponent() * sym.exponent);
      }
      result.getUnits().push(...can.getUnits());

      if (sym.exponent > 0) {
        for (let i = 0; i < sym.exponent; i++) {
          result.multiplyValue(can.getValue());
        }
      } else {
        for (let i = 0; i > sym.exponent; i--) {
          result.divideValue(can.getValue());
        }
      }
    }

    if (sym.prefix != null) {
      if (sym.exponent > 0) {
        for (let i = 0; i < sym.exponent; i++) {
          result.multiplyValue(sym.prefix.value);
        }
      } else {
        for (let i = 0; i > sym.exponent; i--) {
          result.divideValue(sym.prefix.value);
        }
      }
    }
    return result;
  }

  /**
   * @param {string} indent
   * @param {DefinedUnitType} unit
   * @returns {CanonicalType}
   */
  _expandDefinedUnit(indent, unit) {
    if (unit.value == null) {
      throw new UcumException(`Unit '${unit.code}' has no value`);
    }
    let u = unit.value.unit;
    let v = unit.value.value;

    if (unit.isSpecial) {
      if (!this.handlers.exists(unit.code)) {
        throw new UcumException("Not handled yet (special unit)");
      } else {
        const handler = this.handlers.get(unit.code);
        if (handler == null) {
          throw new UcumException("Not handled yet (special unit)");
        }
        u = handler.getUnits();
        v = handler.getValue();
        if (handler.hasOffset()) {
          throw new UcumException("Not handled yet (special unit with offset from 0 at intersect)");
        }
      }
    }

    const t = new ExpressionParser(this.model).parse(u);
    this._debug(indent, "now handle", t);
    const result = this._normalise(indent + "  ", t);
    result.multiplyValue(v);
    return result;
  }

  /**
   * @param {string} indent
   * @param {string} state
   * @param {unknown} unit
   */
  // eslint-disable-next-line no-unused-vars
  _debug(indent, state, unit) {
    // Debug output - can be enabled for debugging
    // if (unit instanceof DefinedUnit) {
    //   console.log(indent + state + ": " +unit.code+"="+unit.value.value+" "+unit.value.unit);
    // } else if (unit instanceof Unit) {
    //   console.log(indent + state + ": " +unit.code);
    // } else {
    //   console.log(indent + state + ": " + new ExpressionComposer().compose(unit));
    // }
  }
}

// UCUM Validator for validating the model (port of UcumValidator.java)
class UcumValidator {
  /**
   * @param {UcumModel} model
   * @param {RegistryType} [handlers]
   */
  constructor(model, handlers) {
    /** @type {UcumModel} */
    this.model = model;
    /** @type {RegistryType} */
    this.handlers = handlers || new Registry();
    /** @type {string[]} */
    this.result = [];
    /** @type {ErrorLogger} */
    this.log = console;
  }

  /**
   * @returns {string[]}
   */
  validate() {
    this.result = [];
    this._checkCodes();
    this._checkUnits();
    return this.result;
  }

  _checkCodes() {
    for (const unit of this.model.getBaseUnits()) {
      this._checkUnitCode(unit.code, true);
    }
    for (const unit of this.model.getDefinedUnits()) {
      this._checkUnitCode(unit.code, true);
    }
  }

  _checkUnits() {
    for (const unit of this.model.getDefinedUnits()) {
      if (!unit.isSpecial) {
        if (unit.value == null) {
          this.result.push(`No value for ${unit.code}`);
        } else {
          this._checkUnitCode(unit.value.unit, false);
        }
      } else if (!this.handlers.exists(unit.code)) {
        this.result.push(`No Handler for ${unit.code}`);
      }
    }
  }

  /**
   * @param {string} code
   * @param {boolean} primary
   */
  _checkUnitCode(code, primary) {
    try {
      const term = new ExpressionParser(this.model).parse(code);
      const c = new ExpressionComposer().compose(term);
      if (c !== code) {
        this.result.push(`Round trip failed: ${code} -> ${c}`);
      }
      new Converter(this.model, this.handlers).convert(term);
    } catch (e) {
      const err = /** @type {Error} */ (e);
      this.result.push(`${code}: ${err.message}`);
    }

    if (primary) {
      try {
        // Check that codes don't have ambiguous digits outside brackets
        let inBrack = false;
        let nonDigits = false;
        for (let i = 0; i < code.length; i++) {
          const ch = code.charAt(i);
          if (ch === '[') {
            if (inBrack) {
              throw new Error("nested [");
            } else {
              inBrack = true;
            }
          }
          if (ch === ']') {
            if (!inBrack) {
              throw new Error("] without [");
            } else {
              inBrack = false;
            }
          }
          nonDigits = nonDigits || !(ch >= '0' && ch <= '9');
          if (ch >= '0' && ch <= '9' && !inBrack && nonDigits) {
            throw new Error(`code ${code} is ambiguous because it has digits outside []`);
          }
        }
      } catch (e) {
        const err = /** @type {Error} */ (e);
        this.log.error(err);
        this.result.push(err.message);
      }
    }
  }
}

module.exports = {
  Lexer,
  ExpressionParser,
  ExpressionComposer,
  FormalStructureComposer,
  UcumModel,
  UcumEssenceParser,
  Search,
  Converter,
  UcumValidator
};
