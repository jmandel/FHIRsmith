// @ts-check

/**
 * SNOMED CT Expression Library
 * Converted from Pascal ftx_sct_expressions.pas
 *
 * Copyright (c) 2011+, HL7 and Health Intersections Pty Ltd
 * Licensed under BSD-3-Clause
 */

/** @typedef {string | number | bigint} SnomedIdLike */
/** @typedef {Record<string, any>} SnomedStructuresLike */
/** @typedef {{isPreferred: boolean, isActive: boolean, languageCode: string, term: string, descriptionIndex: number}} DisplayDesignation */

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const MAX_TERM_LENGTH = 1024;
const NO_REFERENCE = 0xFFFFFFFF;

// Expression status enumeration
const SnomedExpressionStatus = {
  Unknown: 0,
  Equivalent: 1,
  SubsumedBy: 2
};

/**
 * Base class for all SNOMED expression elements
 */
class SnomedExpressionBase {
  constructor() {
    this.start = 0;
    this.stop = 0;
  }
}

/**
 * Represents a SNOMED concept with optional code, description, literal, or decimal value
 */
class SnomedConcept extends SnomedExpressionBase {
  /**
   * @param {number} [reference]
   */
  constructor(reference = NO_REFERENCE) {
    super();
    this.reference = reference;
    this.code = '';
    this.description = '';
    this.literal = '';
    this.decimal = '';
  }

  /**
   * Check if this concept matches another concept
   * @param {SnomedConcept | null | undefined} other
   * @returns {boolean}
   */
  matches(other) {
    if (!other) return false;

    if (this.reference !== NO_REFERENCE) {
      return this.reference === other.reference;
    } else if (this.code) {
      return this.code === other.code;
    } else if (this.decimal) {
      return this.decimal === other.decimal;
    } else if (this.literal) {
      return this.literal === other.literal;
    }

    return false;
  }

  /**
   * Get a string description of this concept
   * @returns {string}
   */
  describe() {
    if (this.code) {
      return this.code;
    } else if (this.decimal) {
      return '#' + this.decimal;
    } else if (this.literal) {
      return '"' + this.literal + '"';
    }
    return '';
  }

  /**
   * Compare two concepts for sorting
   * @param {SnomedConcept} other
   * @returns {number}
   */
  compare(other) {
    if (this.code) {
      return this.code.localeCompare(other.code);
    } else if (this.decimal) {
      return this.decimal.localeCompare(other.decimal);
    } else {
      return this.literal.localeCompare(other.literal);
    }
  }

  /**
   * Create a canonical copy of this concept
   * @returns {SnomedConcept}
   */
  canonical() {
    const result = new SnomedConcept();
    result.copyFrom(this);
    return result;
  }

  /**
   * Copy properties from another concept
   * @param {SnomedConcept} other
   */
  copyFrom(other) {
    this.reference = other.reference;
    this.code = other.code;
    this.description = other.description;
    this.literal = other.literal;
    this.decimal = other.decimal;
  }
}

/**
 * Represents a refinement (attribute-value pair) in a SNOMED expression
 */
class SnomedRefinement extends SnomedExpressionBase {
  constructor() {
    super();
    /** @type {SnomedConcept | null} */
    this.name = null;  // SnomedConcept
    /** @type {SnomedExpression | null} */
    this.value = null; // SnomedExpression
  }

  /**
   * Set the name (attribute) of this refinement
   * @param {SnomedConcept} name
   */
  setName(name) {
    this.name = name;
  }

  /**
   * Set the value of this refinement
   * @param {SnomedExpression} value
   */
  setValue(value) {
    this.value = value;
  }

  /**
   * Check if this refinement matches another
   * @param {SnomedRefinement | null | undefined} other
   * @returns {boolean}
   */
  matches(other) {
    if (!other) return false;
    if (!this.name || !this.value) return false;
    if (!this.name.matches(other.name)) return false;
    return this.value.matches(other.value) === '';
  }

  /**
   * Get a string description of this refinement
   * @returns {string}
   */
  describe() {
    return (this.name ? this.name.describe() : '') + '=' + (this.value ? this.value.describe() : '');
  }

  /**
   * Compare two refinements for sorting
   * @param {SnomedRefinement} other
   * @returns {number}
   */
  compare(other) {
    if (!this.name || !other.name) return this.name ? 1 : other.name ? -1 : 0;
    return this.name.compare(other.name);
  }

  /**
   * Create a canonical copy of this refinement
   * @returns {SnomedRefinement}
   */
  canonical() {
    const result = new SnomedRefinement();
    result.name = this.name ? this.name.canonical() : null;
    result.value = this.value ? this.value.canonical() : null;
    return result;
  }
}

/**
 * Represents a group of refinements in a SNOMED expression
 */
class SnomedRefinementGroup extends SnomedExpressionBase {
  constructor() {
    super();
    /** @type {SnomedRefinement[]} */
    this.refinements = []; // Array of SnomedRefinement
  }

  /**
   * Check if this group matches another group
   * @param {SnomedRefinementGroup | null | undefined} other
   * @returns {boolean}
   */
  matches(other) {
    if (!other) return false;

    // Check all refinements in this group exist in other
    for (const refinement of this.refinements) {
      if (!other.hasRefinement(refinement)) {
        return false;
      }
    }

    // Check all refinements in other group exist in this
    for (const refinement of other.refinements) {
      if (!this.hasRefinement(refinement)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if this group contains a specific refinement
   * @param {SnomedRefinement} refinement
   * @returns {boolean}
   */
  hasRefinement(refinement) {
    return this.refinements.some(test => test.matches(refinement));
  }

  /**
   * Get a string description of this refinement group
   * @returns {string}
   */
  describe() {
    return this.refinements.map(r => r.describe()).join(',');
  }

  /**
   * Compare two refinement groups for sorting
   * @param {SnomedRefinementGroup} other
   * @returns {number}
   */
  compare(other) {
    if (this.refinements.length === 0 || other.refinements.length === 0) {
      return this.refinements.length - other.refinements.length;
    }
    return this.refinements[0].compare(other.refinements[0]);
  }

  /**
   * Create a canonical copy of this refinement group
   * @returns {SnomedRefinementGroup}
   */
  canonical() {
    const result = new SnomedRefinementGroup();
    for (const refinement of this.refinements) {
      result.refinements.push(refinement.canonical());
    }
    return result;
  }
}

/**
 * Main SNOMED expression class containing concepts, refinements, and refinement groups
 */
class SnomedExpression extends SnomedExpressionBase {
  constructor() {
    super();
    this.status = SnomedExpressionStatus.Unknown;
    /** @type {SnomedConcept[]} */
    this.concepts = []; // Array of SnomedConcept
    /** @type {SnomedRefinement[]} */
    this.refinements = []; // Array of SnomedRefinement
    /** @type {SnomedRefinementGroup[]} */
    this.refinementGroups = []; // Array of SnomedRefinementGroup
  }

  /**
   * Check if expression has refinements
   */
  hasRefinements() {
    return this.refinements.length > 0;
  }

  /**
   * Check if expression has refinement groups
   */
  hasRefinementGroups() {
    return this.refinementGroups.length > 0;
  }

  /**
   * Check if this is a simple expression (single concept, no refinements)
   */
  isSimple() {
    return (this.concepts.length === 1) &&
      !this.hasRefinements() &&
      !this.hasRefinementGroups();
  }

  /**
   * Check if this is a complex expression
   */
  isComplex() {
    return !this.isSimple();
  }

  /**
   * Check if expression contains a specific concept
   * @param {number | SnomedConcept} concept
   * @returns {boolean}
   */
  hasConcept(concept) {
    if (typeof concept === 'number') {
      return this.concepts.some(test => test.reference === concept);
    } else {
      return this.concepts.some(test => test.matches(concept));
    }
  }

  /**
   * Check if expression contains a specific refinement
   * @param {SnomedRefinement} refinement
   * @returns {boolean}
   */
  hasRefinement(refinement) {
    return this.refinements.some(test => test.matches(refinement));
  }

  /**
   * Check if expression contains a specific refinement group
   * @param {SnomedRefinementGroup} refinementGroup
   * @returns {boolean}
   */
  hasRefinementGroup(refinementGroup) {
    return this.refinementGroups.some(test => test.matches(refinementGroup));
  }

  /**
   * Check if this expression matches another expression
   * Returns empty string if match, error message if not
   * @param {SnomedExpression | null | undefined} other
   * @returns {string}
   */
  matches(other) {
    if (!other) return 'other is nil';

    // Check concepts
    for (const concept of this.concepts) {
      if (!other.hasConcept(concept)) {
        return 'concept ' + concept.describe() + ' not found in first expression';
      }
    }
    for (const concept of other.concepts) {
      if (!this.hasConcept(concept)) {
        return 'concept ' + concept.describe() + ' not found in second expression';
      }
    }

    // Check refinements
    for (const refinement of this.refinements) {
      if (!other.hasRefinement(refinement)) {
        return 'refinement ' + refinement.describe() + ' not found in first expression';
      }
    }
    for (const refinement of other.refinements) {
      if (!this.hasRefinement(refinement)) {
        return 'refinement ' + refinement.describe() + ' not found in second expression';
      }
    }

    // Check refinement groups
    for (const group of this.refinementGroups) {
      if (!other.hasRefinementGroup(group)) {
        return 'refinement group ' + group.describe() + ' not found in first expression';
      }
    }
    for (const group of other.refinementGroups) {
      if (!this.hasRefinementGroup(group)) {
        return 'refinement group ' + group.describe() + ' not found in second expression';
      }
    }

    return '';
  }

  /**
   * Get a string description of this expression
   * @returns {string}
   */
  describe() {
    /** @type {string[]} */
    const parts = [];

    // Status prefix
    switch (this.status) {
      case SnomedExpressionStatus.Equivalent:
        parts.push('===');
        break;
      case SnomedExpressionStatus.SubsumedBy:
        parts.push('<<<');
        break;
    }

    // Concepts
    parts.push(...this.concepts.map(c => c.describe()));

    // Refinements
    parts.push(...this.refinements.map(r => r.describe()));

    // Refinement groups
    parts.push(...this.refinementGroups.map(g => g.describe()));

    return parts.join(',');
  }

  /**
   * Create a canonical form of this expression (sorted and normalized)
   * @returns {SnomedExpression}
   */
  canonical() {
    const result = new SnomedExpression();
    result.status = this.status;

    // Copy and sort concepts
    for (const concept of this.concepts) {
      result.concepts.push(concept.canonical());
    }

    // Convert refinements and groups to canonical form
    if (this.hasRefinementGroups() || this.hasRefinements()) {
      // Copy refinement groups
      for (const group of this.refinementGroups) {
        if (group.refinements.length > 0) {
          result.refinementGroups.push(group.canonical());
        }
      }

      // Convert individual refinements to single-refinement groups
      for (const refinement of this.refinements) {
        const group = new SnomedRefinementGroup();
        group.refinements.push(refinement.canonical());
        result.refinementGroups.push(group);
      }
    }

    // Sort everything
    result.concepts.sort((a, b) => a.compare(b));

    if (result.hasRefinementGroups()) {
      for (const group of result.refinementGroups) {
        group.refinements.sort((a, b) => a.compare(b));
      }
      result.refinementGroups.sort((a, b) => a.compare(b));
    }

    return result;
  }

  /**
   * Merge another expression into this one
   * @param {SnomedExpression | null | undefined} exp
   */
  merge(exp) {
    if (exp) {
      this.concepts.push(...exp.concepts);
      this.refinements.push(...exp.refinements);
      this.refinementGroups.push(...exp.refinementGroups);
    }
  }
}

/**
 * Parser for SNOMED CT expression strings
 */
class SnomedExpressionParser {
  /**
   * @param {any} [conceptList] - list of all snomed concepts
   */
  constructor(conceptList = null) {
    this.source = '';
    this.cursor = 0;
    this.conceptList = conceptList;
  }

  /**
   * Parse a SNOMED expression string
   * @param {string} source
   * @returns {SnomedExpression}
   */
  parse(source) {
    this.source = source;
    this.cursor = 0;

    const result = new SnomedExpression();
    result.start = this.cursor;

    this.ws();

    // Check for status prefix
    if (this.peek() === '=') {
      result.status = SnomedExpressionStatus.Equivalent;
      this.prefix('=');
    } else if (this.peek() === '<') {
      result.status = SnomedExpressionStatus.SubsumedBy;
      this.prefix('<');
    }

    // Parse main expression
    result.concepts.push(this.concept());
    while (this.gchar('+')) {
      result.concepts.push(this.concept());
    }

    if (this.gchar(':')) {
      this.ws();
      this.refinements(result);
    }

    result.stop = this.cursor;

    this.rule(this.peek() === '\0', 'Found content ("' + this.peekDisp() + '") after end of expression');

    return result;
  }

  /**
   * Parse a concept
   * @returns {SnomedConcept}
   */
  concept() {
    const result = new SnomedConcept();
    result.start = this.cursor;

    this.ws();

    if (this.peek() === '#') {
      result.decimal = this.decimal();
    } else if (this.peek() === '"') {
      result.literal = this.stringConstant();
    } else {
      result.code = this.conceptId();
      if (this.conceptList) {
        const found = this.conceptList.findConcept(result.code);
        this.rule(found.found, 'Concept "' + result.code + '" not valid');
        result.reference = found.index;
      } else {
        result.reference = 0;
      }
    }

    this.ws();

    if (this.gchar('|')) {
      this.ws();
      result.description = this.term().trim();
      this.ws();
      this.fixed('|');
      this.ws();
    }

    result.stop = this.cursor;
    return result;
  }

  /**
   * Parse refinements for an expression
   * @param {SnomedExpression} expr
   */
  refinements(expr) {
    let next = true;
    while (next) {
      if (this.peek() !== '{') {
        expr.refinements.push(this.attribute());
      } else {
        expr.refinementGroups.push(this.attributeGroup());
      }
      this.ws();
      next = this.gchar(',');
      this.ws();
    }
  }

  /**
   * Parse an attribute group
   * @returns {SnomedRefinementGroup}
   */
  attributeGroup() {
    const result = new SnomedRefinementGroup();

    this.fixed('{');
    this.ws();
    result.start = this.cursor;

    result.refinements.push(this.attribute());
    while (this.gchar(',')) {
      result.refinements.push(this.attribute());
    }

    result.stop = this.cursor;
    this.ws();
    this.fixed('}');
    this.ws();

    return result;
  }

  /**
   * Parse an attribute (refinement)
   * @returns {SnomedRefinement}
   */
  attribute() {
    const result = new SnomedRefinement();
    result.start = this.cursor;

    result.name = this.attributeName();
    this.fixed('=');
    result.value = this.attributeValue();
    this.ws();

    result.stop = this.cursor;
    return result;
  }

  /**
   * Parse an attribute name
   * @returns {SnomedConcept}
   */
  attributeName() {
    const result = new SnomedConcept();
    result.start = this.cursor;

    this.ws();
    result.code = this.conceptId();
    this.ws();

    if (this.gchar('|')) {
      this.ws();
      result.description = this.term();
      this.ws();
      this.fixed('|');
      this.ws();
    }

    result.stop = this.cursor;
    return result;
  }

  /**
   * Parse an attribute value
   * @returns {SnomedExpression}
   */
  attributeValue() {
    this.ws();

    if (this.gchar('(')) {
      const result = this.expression();
      this.fixed(')');
      return result;
    } else {
      return this.expression();
    }
  }

  /**
   * Parse a sub-expression
   * @returns {SnomedExpression}
   */
  expression() {
    const result = new SnomedExpression();
    result.start = this.cursor;

    this.ws();
    result.concepts.push(this.concept());

    while (this.gchar('+')) {
      result.concepts.push(this.concept());
    }

    if (this.gchar(':')) {
      this.ws();
      this.refinements(result);
    }

    result.stop = this.cursor;
    return result;
  }

  /**
   * Parse a concept ID (sequence of digits)
   * @returns {string}
   */
  conceptId() {
    let result = '';

    while (this.isDigit(this.peek())) {
      result += this.next();
    }

    this.rule(result.length > 0, 'Concept not found (next char = "' + this.peekDisp() + '", in "' + this.source + '")');
    return result;
  }

  /**
   * Parse a decimal number
   * @returns {string}
   */
  decimal() {
    let result = '';
    this.fixed('#');

    while (this.isDigit(this.peek()) || this.peek() === '.') {
      result += this.next();
    }

    return result;
  }

  /**
   * Parse a term (text between | characters)
   * @returns {string}
   */
  term() {
    let result = '';

    while (this.peek() !== '|') {
      result += this.next();
    }

    return result;
  }

  /**
   * Parse a string constant
   * @returns {string}
   */
  stringConstant() {
    let result = '';
    this.fixed('"');

    while (this.peek() !== '"' && this.peek() !== '\0') {
      if (result.length > MAX_TERM_LENGTH) {
        throw new Error('Constant too long (>' + MAX_TERM_LENGTH + ' chars) at character ' + this.cursor);
      }
      result += this.next();
    }

    if (this.peek() === '\0') {
      throw new Error('Unterminated Constant at character ' + this.cursor);
    }

    this.fixed('"');
    return result;
  }

  /**
   * Skip whitespace
   */
  ws() {
    while (this.isWhitespace(this.peek())) {
      this.next();
    }
  }

  /**
   * Try to consume a specific character
   * @param {string} c
   * @returns {boolean}
   */
  gchar(c) {
    const result = this.peek() === c;
    if (result) {
      this.next();
    }
    return result;
  }

  /**
   * Require a specific character
   * @param {string} c
   */
  fixed(c) {
    const success = this.gchar(c);
    this.rule(success, 'Expected character "' + c + '" but found ' + this.peek());
    this.ws();
  }

  /**
   * Require a three-character prefix
   * @param {string} c
   */
  prefix(c) {
    this.fixed(c);
    this.fixed(c);
    this.fixed(c);
    this.ws();
  }

  /**
   * Get the next character and advance cursor
   * @returns {string}
   */
  next() {
    const result = this.peek();
    this.cursor++;
    return result;
  }

  /**
   * Peek at the current character
   * @returns {string}
   */
  peek() {
    if (this.cursor >= this.source.length) {
      return '\0';
    }
    return this.source[this.cursor];
  }

  /**
   * Get a display string for the current character
   * @returns {string}
   */
  peekDisp() {
    if (this.cursor >= this.source.length) {
      return '[n/a: overrun]';
    }
    return this.source[this.cursor];
  }

  /**
   * Assert a rule and throw if it fails
   * @param {boolean} test
   * @param {string} message
   */
  rule(test, message) {
    if (!test) {
      throw new Error(message + ' at character ' + (this.cursor+1));
    }
  }

  /**
   * Check if character is a digit
   * @param {string} c
   * @returns {boolean}
   */
  isDigit(c) {
    return c >= '0' && c <= '9';
  }

  /**
   * Check if character is whitespace
   * @param {string} c
   * @returns {boolean}
   */
  isWhitespace(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r';
  }
}

// Render options for expressions
const SnomedServicesRenderOption = {
  Minimal: 0,
  AsIs: 1,
  FillMissing: 2,
  ReplaceAll: 3
};

// Refinement group match states
const SnomedRefinementGroupMatchState = {
  NoMatch: 0,
  Identical: 1,
  Subsumed: 2
};

/**
 * Represents a matching concept with optional unmatched refinement groups
 */
class MatchingConcept {
  /**
   * @param {string} code
   * @param {SnomedRefinementGroup[] | null} [unmatchedGroups]
   */
  constructor(code, unmatchedGroups = null) {
    this.code = code;
    this.unmatchedGroups = unmatchedGroups || [];
  }
}

/**
 * SNOMED CT Expression Services
 * Provides comprehensive expression processing capabilities
 */
class SnomedExpressionServices {
  /**
   * @param {SnomedStructuresLike} snomedStructures
   * @param {number} isAIndex
   */
  constructor(snomedStructures, isAIndex) {
    this.strings = snomedStructures.strings;
    this.words = snomedStructures.words;
    this.stems = snomedStructures.stems;
    this.refs = snomedStructures.refs;
    this.descriptions = snomedStructures.descriptions;
    this.descriptionIndex = snomedStructures.descriptionIndex;
    this.concepts = snomedStructures.concepts;
    this.relationships = snomedStructures.relationships;
    this.refSetMembers = snomedStructures.refSetMembers;
    this.refSetIndex = snomedStructures.refSetIndex;

    this.isAIndex = isAIndex;
    this.defaultLanguage = 1; // Default to English
    this.building = false; // Set to true during import
    this.assumeClassified = true; // Optimization flag
    this.log = console;
  }

  /**
   * Condense an expression to find matching concepts
   * @param {SnomedExpression} exp
   * @returns {MatchingConcept[]}
   */
  condenseExpression(exp) {
    /** @type {SnomedRefinementGroup[]} */
    const grps = [];

    // Add all refinement groups
    grps.push(...exp.refinementGroups);

    // Convert individual refinements to single-refinement groups
    for (const ref of exp.refinements) {
      const grp = new SnomedRefinementGroup();
      grp.refinements.push(ref);
      grps.push(grp);
    }

    /** @type {MatchingConcept[]} */
    const result = [];

    if (exp.concepts.length === 1) {
      if (grps.length === 0) {
        result.push(new MatchingConcept(exp.concepts[0].code));
      } else {
        this.findMatchingConcepts(result, exp.concepts[0].reference, grps);
      }
    }

    if (result.length === 0) {
      throw new Error(`No matches found for ${exp.describe()}`);
    }

    return result;
  }

  /**
   * Get defining relationships for a concept
   * @param {number} conceptIndex
   * @returns {number[]}
   */
  getDefiningRelationships(conceptIndex) {
    const concept = this.concepts.getConcept(conceptIndex);
    const outboundIndex = concept.outbounds;

    if (outboundIndex === 0) {
      return [];
    }

    /** @type {number[]} */
    const result = [];
    const outbounds = this.refs.getReferences(outboundIndex);

    for (const relIndex of outbounds || []) {
      const rel = this.relationships.getRelationship(relIndex);

      // Only include active defining relationships that are not is-a
      if (rel.active && rel.defining && rel.relType !== this.isAIndex) {
        result.push(relIndex);
      }
    }

    return result;
  }

  /**
   * Check if groups match exactly
   * @param {SnomedRefinementGroup} a
   * @param {SnomedRefinementGroup} b
   * @returns {boolean}
   */
  groupsMatch(a, b) {
    for (const refA of a.refinements) {
      /** @type {SnomedRefinement | null} */
      let refB = null;

      // Find matching refinement by name
      for (const testRef of b.refinements) {
        if (refA.name && refA.name.matches(testRef.name)) {
          refB = testRef;
          break;
        }
      }

      if (!refB) {
        return false;
      }

      // Check if values are equivalent
      if (!this.expressionsEquivalent(refA.value, refB.value)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Parse expression string
   * @param {string} source
   * @returns {SnomedExpression}
   */
  parseExpression(source) {
    const parser = new SnomedExpressionParser();
    const result = parser.parse(source);
    this.checkExpression(result);
    return result;
  }

  /**
   * Check if two expressions are equivalent
   * @param {SnomedExpression | null} a
   * @param {SnomedExpression | null} b
   * @returns {boolean}
   */
  expressionsEquivalent(a, b) {
    if (!a || !b) return false;
    const e1 = a.canonical();
    const e2 = b.canonical();

    const match = e1.matches(e2);
    return match === '';
  }

  /**
   * Create defined expression from concept
   * @param {number} reference
   * @param {SnomedExpression} exp
   * @param {boolean} [ancestor]
   */
  createDefinedExpression(reference, exp, ancestor = false) {
    if (this.isPrimitive(reference)) {
      if (!exp.hasConcept(reference)) {
        const concept = new SnomedConcept(reference);
        concept.code = this.getConceptId(reference);
        exp.concepts.push(concept);
      }
    } else {
      // Add parent concepts
      const parents = this.getConceptParents(reference);
      for (const parent of parents) {
        this.createDefinedExpression(parent, exp, true);
      }

      if (!ancestor || !this.assumeClassified) {
        /** @type {Map<string, SnomedRefinementGroup>} */
        const groups = new Map(); // Group number -> refinement group

        // Process defining relationships
        const definingRels = this.getDefiningRelationships(reference);
        for (const relIndex of definingRels) {
          const rel = this.relationships.getRelationship(relIndex);

          const ref = new SnomedRefinement();
          ref.name = new SnomedConcept(rel.relType);
          ref.name.code = this.getConceptId(rel.relType);

          ref.value = new SnomedExpression();
          const targetConcept = new SnomedConcept(rel.target);
          targetConcept.code = this.getConceptId(rel.target);
          ref.value.concepts.push(targetConcept);

          if (rel.group === 0) {
            // Ungrouped refinement
            if (!exp.hasRefinement(ref)) {
              exp.refinements.push(ref);
            }
          } else {
            // Grouped refinement
            const groupKey = rel.group.toString();
            if (!groups.has(groupKey)) {
              groups.set(groupKey, new SnomedRefinementGroup());
            }
            const group = groups.get(groupKey);
            if (group) {
              group.refinements.push(ref);
            }
          }
        }

        // Add groups to expression
        for (const grp of groups.values()) {
          if (!exp.hasRefinementGroup(grp)) {
            exp.refinementGroups.push(grp);
          }
        }
      }
    }
  }

  /**
   * Create normal form for a concept
   * @param {number} reference
   * @returns {SnomedExpression}
   */
  createNormalForm(reference) {
    if (this.building) {
      const exp = new SnomedExpression();
      this.createDefinedExpression(reference, exp, false);
      return this.normaliseExpression(exp);
    } else {
      // Read from stored normal form
      const normalFormIndex = this.concepts.getNormalForm(reference);
      /** @type {string} */
      let source;

      if (normalFormIndex === 0) {
        source = this.getConceptId(reference);
      } else {
        source = this.strings.getEntry(normalFormIndex);
      }

      const result = new SnomedExpressionParser().parse(source);
      this.checkExpression(result);
      return result;
    }
  }

  /**
   * Rationalize expression by merging concepts and refinements
   * @param {SnomedExpression} exp
   */
  rationaliseExpression(exp) {
    // Merge subsumable concepts
    let i = 0;
    while (i < exp.concepts.length) {
      const c1 = exp.concepts[i];
      let j = i + 1;

      while (j < exp.concepts.length) {
        const c2 = exp.concepts[j];

        if (c1.reference !== NO_REFERENCE && c2.reference !== NO_REFERENCE) {
          if (this.subsumes(c1.reference, c2.reference)) {
            c1.copyFrom(c2);
            exp.concepts.splice(j, 1);
          } else if (this.subsumes(c2.reference, c1.reference)) {
            exp.concepts.splice(j, 1);
          } else {
            j++;
          }
        } else {
          j++;
        }
      }
      i++;
    }

    // Merge refinements
    this.mergeRefinements(exp.refinements);
    for (const group of exp.refinementGroups) {
      this.mergeRefinements(group.refinements);
    }

    // Merge refinement groups
    i = 0;
    while (i < exp.refinementGroups.length) {
      const grp1 = exp.refinementGroups[i];
      let j = i + 1;

      while (j < exp.refinementGroups.length) {
        const grp2 = exp.refinementGroups[j];

        if (this.mergeGroups(grp1, grp2)) {
          exp.refinementGroups.splice(j, 1);
        } else {
          j++;
        }
      }
      i++;
    }
  }

  /**
   * Merge refinement groups if possible
   * @param {SnomedRefinementGroup} grp1
   * @param {SnomedRefinementGroup} grp2
   * @returns {boolean}
   */
  mergeGroups(grp1, grp2) {
    // Find matching attribute names
    /** @type {number[]} */
    const matches = [];
    /** @type {boolean[]} */
    const targets = [];

    for (const ref1 of grp1.refinements) {
      for (const ref2 of grp2.refinements) {
        if (ref1.name && ref2.name && ref1.name.reference === ref2.name.reference) {
          matches.push(ref1.name.reference);
          break;
        }
      }
    }

    if (matches.length === 0) {
      return false;
    }

    // Check subsumption for each match
    let canMerge = true;
    for (const nameRef of matches) {
      const ref1 = this.getRefinementByName(nameRef, grp1.refinements);
      const ref2 = this.getRefinementByName(nameRef, grp2.refinements);

      if (!ref1 || !ref2) {
        canMerge = false;
        break;
      }

      if (this.expressionSubsumes(ref1.value, ref2.value)) {
        targets.push(true);
      } else if (this.expressionSubsumes(ref2.value, ref1.value)) {
        targets.push(false);
      } else {
        canMerge = false;
        break;
      }
    }

    if (canMerge) {
      // Perform the merge
      for (let i = 0; i < matches.length; i++) {
        const nameRef = matches[i];
        if (targets[i]) {
          const ref1 = this.getRefinementByName(nameRef, grp1.refinements);
          const ref2 = this.getRefinementByName(nameRef, grp2.refinements);
          if (ref1 && ref2) {
            ref1.value = ref2.value;
          }
        }
      }

      // Add non-matching refinements from grp2 to grp1
      for (const ref2 of grp2.refinements) {
        if (ref2.name && !matches.includes(ref2.name.reference)) {
          grp1.refinements.push(ref2);
        }
      }
    }

    return canMerge;
  }

  /**
   * Get refinement by name reference
   * @param {number} nameRef
   * @param {SnomedRefinement[]} refinements
   * @returns {SnomedRefinement | null}
   */
  getRefinementByName(nameRef, refinements) {
    for (const ref of refinements) {
      if (ref.name && ref.name.reference === nameRef) {
        return ref;
      }
    }
    return null;
  }

  /**
   * Merge refinements in a list
   * @param {SnomedRefinement[]} list
   */
  mergeRefinements(list) {
    let i = 0;
    while (i < list.length) {
      const ref1 = list[i];
      let j = i + 1;

      while (j < list.length) {
        const ref2 = list[j];

        if (ref1.name && ref1.name.matches(ref2.name)) {
          if (this.expressionSubsumes(ref1.value, ref2.value)) {
            ref1.value = ref2.value;
            list.splice(j, 1);
          } else if (this.expressionSubsumes(ref2.value, ref1.value)) {
            list.splice(j, 1);
          } else {
            j++;
          }
        } else {
          j++;
        }
      }
      i++;
    }
  }

  /**
   * Normalize expression to normal form
   * @param {SnomedExpression} exp
   * @returns {SnomedExpression}
   */
  normaliseExpression(exp) {
    const work = new SnomedExpression();

    // Process concepts
    for (const concept of exp.concepts) {
      if (concept.reference === NO_REFERENCE || this.isPrimitive(concept.reference)) {
        work.concepts.push(concept);
      } else {
        const ex = this.createNormalForm(concept.reference);
        work.merge(ex);
      }
    }

    // Process refinements
    for (const refSrc of exp.refinements) {
      const refDst = new SnomedRefinement();
      work.refinements.push(refDst);
      refDst.name = refSrc.name;
      refDst.value = this.normaliseExpression(/** @type {SnomedExpression} */ (refSrc.value));
    }

    // Process refinement groups
    for (const grpSrc of exp.refinementGroups) {
      const grpDst = new SnomedRefinementGroup();
      work.refinementGroups.push(grpDst);

      for (const refSrc of grpSrc.refinements) {
        const refDst = new SnomedRefinement();
        grpDst.refinements.push(refDst);
        refDst.name = refSrc.name;
        refDst.value = this.normaliseExpression(/** @type {SnomedExpression} */ (refSrc.value));
      }
    }

    const work2 = work.canonical();
    this.rationaliseExpression(work2);
    return work2.canonical();
  }

  /**
   * Check if expression a subsumes expression b
   * @param {SnomedExpression | null} a
   * @param {SnomedExpression | null} b
   * @returns {boolean}
   */
  expressionSubsumes(a, b) {
    if (!a || !b) return false;
    if (a.isSimple() && b.isSimple()) {
      return this.subsumes(a.concepts[0].reference, b.concepts[0].reference);
    }

    const e1 = this.normaliseExpression(a);
    const e2 = this.normaliseExpression(b);

    // Check root concepts
    for (const c of e1.concepts) {
      let ok = false;
      for (const ct of e2.concepts) {
        if (this.subsumesConcept(c, ct)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        return false;
      }
    }

    // Check refinement groups
    for (const r of e1.refinementGroups) {
      const rt = this.findMatchingGroup(r, e2);
      if (!rt || !this.subsumesGroup(r, rt)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if concept a subsumes concept b
   * @param {SnomedConcept} a
   * @param {SnomedConcept} b
   * @returns {boolean}
   */
  subsumesConcept(a, b) {
    if (a.matches(b)) {
      return true;
    }

    return (a.reference !== NO_REFERENCE) &&
      (b.reference !== NO_REFERENCE) &&
      this.subsumes(a.reference, b.reference);
  }

  /**
   * Check if group a subsumes group b
   * @param {SnomedRefinementGroup} a
   * @param {SnomedRefinementGroup} b
   * @returns {boolean}
   */
  subsumesGroup(a, b) {
    for (const refA of a.refinements) {
      /** @type {SnomedRefinement | null} */
      let refB = null;

      for (const testRef of b.refinements) {
        if (refA.name && refA.name.matches(testRef.name)) {
          refB = testRef;
          break;
        }
      }

      if (!refB) {
        return false;
      }

      if (!this.expressionSubsumes(refA.value, refB.value)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Find matching group in expression
   * @param {SnomedRefinementGroup} r
   * @param {SnomedExpression} exp
   * @returns {SnomedRefinementGroup | null}
   */
  findMatchingGroup(r, exp) {
    for (const t of exp.refinementGroups) {
      let all = true;

      for (const refs of r.refinements) {
        let match = false;
        for (const reft of t.refinements) {
          if (refs.name && refs.name.matches(reft.name)) {
            match = true;
            break;
          }
        }
        if (!match) {
          all = false;
          break;
        }
      }

      if (all) {
        return t;
      }
    }

    return null;
  }

  /**
   * Find concepts matching refinement patterns
   * @param {MatchingConcept[]} list
   * @param {number} reference
   * @param {SnomedRefinementGroup[]} refinements
   */
  findMatchingConcepts(list, reference, refinements) {
    const children = this.getConceptChildren(reference);

    for (const child of children) {
      const conceptId = this.getConceptId(child);
      const exp = new SnomedExpression();
      this.createDefinedExpression(child, exp, false);

      // Convert ungrouped refinements to groups
      for (const ref of exp.refinements) {
        const grp = new SnomedRefinementGroup();
        exp.refinementGroups.push(grp);
        grp.refinements.push(ref);
      }
      exp.refinements.length = 0;

      let allMatched = true;
      let oneUnMatched = false;
      /** @type {SnomedRefinementGroup[]} */
      const matchedGroups = [];

      for (const grp of exp.refinementGroups) {
        const state = this.checkGroupStateInRefinements(grp, refinements, matchedGroups);
        if (state === SnomedRefinementGroupMatchState.NoMatch) {
          oneUnMatched = true;
        } else if (state !== SnomedRefinementGroupMatchState.Identical) {
          allMatched = false;
        }
      }

      if (oneUnMatched) {
        // Neither this nor children will match
        continue;
      } else if (allMatched && matchedGroups.length > 0) {
        // Complete match
        list.push(new MatchingConcept(conceptId));
      } else {
        // Partial match - continue searching
        const nonMatchingGroups = this.listNonMatchingGroups(refinements, matchedGroups);
        if (nonMatchingGroups.length < refinements.length) {
          list.push(new MatchingConcept(conceptId, nonMatchingGroups));
        }
        this.findMatchingConcepts(list, child, nonMatchingGroups);
      }
    }
  }

  /**
   * Check group state in refinements
   * @param {SnomedRefinementGroup} grp
   * @param {SnomedRefinementGroup[]} refinements
   * @param {SnomedRefinementGroup[]} matchedGroups
   * @returns {number}
   */
  checkGroupStateInRefinements(grp, refinements, matchedGroups) {
    for (const g of refinements) {
      if (this.groupsMatch(grp, g)) {
        matchedGroups.push(g);
        return SnomedRefinementGroupMatchState.Identical;
      } else if (this.subsumesGroup(grp, g)) {
        return SnomedRefinementGroupMatchState.Subsumed;
      }
    }
    return SnomedRefinementGroupMatchState.NoMatch;
  }

  /**
   * List non-matching groups
   * @param {SnomedRefinementGroup[]} target
   * @param {SnomedRefinementGroup[]} source
   * @returns {SnomedRefinementGroup[]}
   */
  listNonMatchingGroups(target, source) {
    /** @type {SnomedRefinementGroup[]} */
    const result = [];

    for (const g of target) {
      const r = this.findMatchingGroupInList(g, source);
      if (!r) {
        result.push(g);
      }
    }

    return result;
  }

  /**
   * Find matching group in list
   * @param {SnomedRefinementGroup} r
   * @param {SnomedRefinementGroup[]} groups
   * @returns {SnomedRefinementGroup | null}
   */
  findMatchingGroupInList(r, groups) {
    for (const t of groups) {
      let all = true;

      for (const refs of r.refinements) {
        let match = false;
        for (const reft of t.refinements) {
          if (refs.name && refs.name.matches(reft.name)) {
            match = true;
            break;
          }
        }
        if (!match) {
          all = false;
          break;
        }
      }

      if (all) {
        return t;
      }
    }

    return null;
  }

  /**
   * Validate expression structure and concept references
   * @param {SnomedExpression} expression
   */
  checkExpression(expression) {
    for (const concept of expression.concepts) {
      this.checkConcept(concept);
    }

    if (expression.hasRefinements()) {
      for (const refinement of expression.refinements) {
        this.checkRefinement(refinement);
      }
    }

    if (expression.hasRefinementGroups()) {
      for (const group of expression.refinementGroups) {
        for (const refinement of group.refinements) {
          this.checkRefinement(refinement);
        }
      }
    }
  }

  /**
   * Validate concept reference
   * @param {SnomedConcept | null} concept
   * @param {string[]} [limits]
   */
  checkConcept(concept, limits) {
    if (!concept) {
      throw new Error('Missing concept');
    }
    if (concept.code) {
      const conceptId = BigInt(concept.code);
      const result = this.concepts.findConcept(conceptId);

      if (result.found) {
        concept.reference = result.index;
      } else if (concept.code !== '111115') { // Special case for some SNOMED extensions
        throw new Error(`Concept ${concept.code} not found`);
      }
    }
    if (limits && concept.reference) {
      // if a limit is specified, then the concept has to be a specialization of one of them.
      let ok = false;
      for (const limit of limits) {
        const parentRef = this.concepts.findConcept(limit);
        const descendentsRef = this.concepts.getAllDesc(parentRef.index);
        const descendants = this.refs.getReferences(descendentsRef);
        if (descendants && descendants.includes(concept.reference)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        if (limits.length == 1) {
          throw new Error(`Concept ${concept.code} is not valid in this context (must be a ${limits[0]})`);
        } else {
          throw new Error(`Concept ${concept.code} is not valid in this context (must be a descendent of one of ${limits})`);
        }
      }
    }

    // Validate description if provided
    if (concept.reference !== NO_REFERENCE && concept.description) {
      const displayNames = this.listDisplayNames(concept.reference, 0);
      const normalizedDescription = this.normalizeText(concept.description);

      let ok = false;

      // Check if matches preferred display (first in list)
      if (displayNames.length > 0 && displayNames[0].term) {
        ok = this.normalizeText(displayNames[0].term) === normalizedDescription;
      }

      // Check all designations if not already matched
      if (!ok) {
        for (const designation of displayNames) {
          if (this.normalizeText(designation.term) === normalizedDescription) {
            ok = true;
            break;
          }
        }
      }

      if (!ok) {
        const validTerms = displayNames.map(d => d.term).join('", "');
        throw new Error(`Term "${concept.description}" doesn't match a defined term at position ${concept.start} (valid terms would be from this list: "${validTerms}")`);
      }
    }
  }

  /**
   * List all display names for a concept
   * Equivalent to Pascal ListDisplayNames procedure
   * @param {number} conceptIndex
   * @param {number} [languageFilter]
   * @returns {DisplayDesignation[]}
   */
  listDisplayNames(conceptIndex, languageFilter = 0) {
    /** @type {DisplayDesignation[]} */
    const designations = [];

    try {
      const concept = this.concepts.getConcept(conceptIndex);
      const descriptionsRef = concept.descriptions;

      if (descriptionsRef === 0) {
        return designations; // No descriptions available
      }

      const descriptionIndices = this.refs.getReferences(descriptionsRef);

      for (let i = 0; i < (descriptionIndices || []).length; i++) {
        const descIndex = descriptionIndices[i];
        const description = this.descriptions.getDescription(descIndex);

        // Only include active descriptions
        if (description.active) {
          // Language filtering (simplified - could be enhanced)
          if (languageFilter === 0 || description.lang === languageFilter) {
            const term = this.strings.getEntry(description.iDesc).trim();

            designations.push({
              isPreferred: i === 0, // First description is considered preferred
              isActive: true,
              languageCode: this.codeForLanguage(description.lang),
              term: term,
              descriptionIndex: descIndex
            });
          }
        }
      }
    } catch (error) {
      // If we can't read the concept descriptions, return empty list
      this.log.warn(`Warning: Could not read descriptions for concept ${conceptIndex}: ${errorMessage(error)}`);
    }

    return designations;
  }

  /**
   * Normalize text for comparison (equivalent to Pascal normalise function)
   * @param {string | null | undefined} text
   * @returns {string}
   */
  normalizeText(text) {
    if (!text) return '';

    let result = '';
    let wasWhitespace = false;

    for (const char of text) {
      if (this.isWhitespace(char)) {
        if (!wasWhitespace) {
          result += ' ';
          wasWhitespace = true;
        }
      } else {
        result += char.toLowerCase();
        wasWhitespace = false;
      }
    }

    return result.trim();
  }

  /**
   * Check if character is whitespace
   * @param {string} char
   * @returns {boolean}
   */
  isWhitespace(char) {
    return char === ' ' || char === '\t' || char === '\n' || char === '\r';
  }

  /**
   * Get language code from internal language index
   * @param {number} langIndex
   * @returns {string}
   */
  codeForLanguage(langIndex) {
    // Simplified mapping - could be enhanced with proper language reference
    /** @type {Record<number, string>} */
    const languageMap = {
      1: 'en-US',
      2: 'en-GB',
      3: 'es',
      4: 'fr',
      5: 'de'
    };

    return languageMap[langIndex] || 'en-US';
  }

  /**
   * Validate refinement
   * @param {SnomedRefinement} refinement
   */
  checkRefinement(refinement) {
    if (!refinement.value) {
      throw new Error('Missing refinement value');
    }
    this.checkConcept(refinement.name, ['410662002', '106237007']);
    this.checkExpression(refinement.value);
  }

  /**
   * Render expression as string
   * @param {SnomedExpression} source
   * @param {number} [option]
   * @returns {string}
   */
  renderExpression(source, option = SnomedServicesRenderOption.AsIs) {
    /** @type {string[]} */
    const parts = [];
    this.renderExpressionParts(parts, source, option);
    return parts.join('');
  }

  /**
   * Helper methods that need to be implemented based on SNOMED structures
   */

  /**
   * @param {number} reference
   * @returns {boolean}
   */
  isPrimitive(reference) {
    // Check if concept is primitive based on concept flags
    // In SNOMED CT, primitive concepts are not fully defined by their relationships
    try {
      const concept = this.concepts.getConcept(reference);
      // Bit 0 typically indicates if concept is primitive (1) or defined (0)
      // This may vary based on the specific implementation
      return (concept.flags & 1) !== 0;
    } catch (error) {
      // If we can't read the concept, assume it's primitive for safety
      this.log.warn(`Warning: Could not check primitive status for concept ${reference}: ${errorMessage(error)}`);
      return true;
    }
  }

  /**
   * @param {number} reference
   * @returns {string}
   */
  getConceptId(reference) {
    // Get concept ID string from reference index
    try {
      const concept = this.concepts.getConcept(reference);
      return concept.identity.toString();
    } catch (error) {
      this.log.warn(`Warning: Could not get concept ID for reference ${reference}: ${errorMessage(error)}`);
      return reference.toString(); // Fall back to using the reference itself
    }
  }

  /**
   * @param {number} reference
   * @returns {number[]}
   */
  getConceptParents(reference) {
    // Get active parent concepts (needs implementation)
    const concept = this.concepts.getConcept(reference);
    const parentsIndex = concept.parents;

    if (parentsIndex === 0) {
      return [];
    }

    return this.refs.getReferences(parentsIndex) || [];
  }

  /**
   * @param {number} reference
   * @returns {number[]}
   */
  getConceptChildren(reference) {
    // Get child concepts (needs implementation based on inbound is-a relationships)
    /** @type {number[]} */
    const children = [];
    const concept = this.concepts.getConcept(reference);
    const inboundsIndex = concept.inbounds;

    if (inboundsIndex === 0) {
      return children;
    }

    const inbounds = this.refs.getReferences(inboundsIndex);

    for (const relIndex of inbounds || []) {
      const rel = this.relationships.getRelationship(relIndex);

      if (rel.active && rel.defining && rel.relType === this.isAIndex) {
        children.push(rel.source);
      }
    }

    return children;
  }

  /**
   * @param {number} a
   * @param {number} b
   * @returns {boolean}
   */
  subsumes(a, b) {
    // Check if concept a subsumes concept b using closure/descendants
    if (a === b) {
      return true;
    }

    try {
      // Get the closure (all descendants) for concept a
      // ?? const conceptA = this.concepts.getConcept(a);
      const closureRef = this.concepts.getAllDesc(a);

      if (closureRef === 0 || closureRef === 0xFFFFFFFF) {
        // No closure data or magic "no children" value
        return false;
      }

      // Get the array of descendant indices
      const descendants = this.refs.getReferences(closureRef);

      // Check if b is in the descendants of a
      return (descendants || []).includes(b);
    } catch (error) {
      // If we can't read closure data, fall back to simple equality check
      this.log.warn(`Warning: Could not check subsumption for ${a} -> ${b}: ${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * Helper to render expression parts
   * @param {string[]} parts
   * @param {SnomedExpression} expr
   * @param {number} option
   */
  renderExpressionParts(parts, expr, option) {
    // Render concepts
    for (let i = 0; i < expr.concepts.length; i++) {
      if (i > 0) parts.push('+');
      this.renderConcept(parts, expr.concepts[i], option);
    }

    // Render refinements and groups
    if (expr.hasRefinements() || expr.hasRefinementGroups()) {
      parts.push(':');

      // Ungrouped refinements
      if (expr.hasRefinements()) {
        for (let i = 0; i < expr.refinements.length; i++) {
          if (i > 0) parts.push(',');
          this.renderRefinement(parts, expr.refinements[i], option);
        }
      }

      // Grouped refinements
      if (expr.hasRefinementGroups()) {
        for (let j = 0; j < expr.refinementGroups.length; j++) {
          if (j > 0) parts.push(',');
          parts.push('{');

          for (let i = 0; i < expr.refinementGroups[j].refinements.length; i++) {
            if (i > 0) parts.push(',');
            this.renderRefinement(parts, expr.refinementGroups[j].refinements[i], option);
          }

          parts.push('}');
        }
      }
    }
  }

  /**
   * @param {string[]} parts
   * @param {SnomedConcept} expr
   * @param {number} option
   */
  renderConcept(parts, expr, option) {
    if (expr.reference !== NO_REFERENCE && expr.code === '') {
      expr.code = this.getConceptId(expr.reference);
      parts.push(expr.code);
    } else {
      parts.push(expr.describe());
    }

    let description = '';
    switch (option) {
      case SnomedServicesRenderOption.Minimal:
        description = '';
        break;
      case SnomedServicesRenderOption.AsIs:
        description = expr.description;
        break;
      case SnomedServicesRenderOption.FillMissing:
        description = expr.description;
        if (description === '') {
          if (expr.reference !== NO_REFERENCE) {
            description = this.getDisplayName(expr.reference);
          } else if (expr.code) {
            description = this.getDisplayName(expr.code);
          }
        }
        break;
      case SnomedServicesRenderOption.ReplaceAll:
        if (expr.code) {
          description = this.getDisplayName(expr.code);
        }
        break;
    }

    if (description) {
      parts.push('|');
      parts.push(description);
      parts.push('|');
    }
  }

  /**
   * @param {string[]} parts
   * @param {SnomedRefinement} expr
   * @param {number} option
   */
  renderRefinement(parts, expr, option) {
    if (!expr.name || !expr.value) {
      throw new Error('Cannot render incomplete refinement');
    }
    this.renderConcept(parts, expr.name, option);
    parts.push('=');
    this.renderExpressionParts(parts, expr.value, option);
  }

  /**
   * @param {string | number} conceptIdOrReference
   * @returns {string}
   */
  getDisplayName(conceptIdOrReference) {
    // Get display name for concept
    /** @type {number} */
    let conceptIndex;

    if (typeof conceptIdOrReference === 'string') {
      // It's a concept ID string, need to find the concept
      const conceptId = BigInt(conceptIdOrReference);
      const result = this.concepts.findConcept(conceptId);
      if (!result.found) {
        return '';
      }
      conceptIndex = result.index;
    } else {
      // It's already a concept index
      conceptIndex = conceptIdOrReference;
    }

    // Get the preferred display name (FSN or first active description)
    const displayNames = this.listDisplayNames(conceptIndex, this.defaultLanguage);

    if (displayNames.length > 0) {
      // Look for FSN first (if we can detect it), otherwise use first available
      for (const designation of displayNames) {
        if (designation.isPreferred) {
          return designation.term;
        }
      }
      // Fall back to first designation
      return displayNames[0].term;
    }

    return '';
  }
}

/**
 * Expression context for maintaining state during processing
 */
class SnomedExpressionContext {
  /**
   * @param {string | null | undefined} source
   * @param {SnomedExpression} expression
   */
  constructor(source, expression) {
    this.source = source || '';
    this.expression = expression;
  }

  /**
   * @param {number} reference
   * @returns {SnomedExpressionContext}
   */
  static fromReference(reference) {
    const expression = new SnomedExpression();
    expression.concepts.push(new SnomedConcept(reference));
    return new SnomedExpressionContext('', expression);
  }

  /**
   * @param {string} source
   * @param {number} reference
   * @returns {SnomedExpressionContext}
   */
  static fromSource(source, reference) {
    const expression = new SnomedExpression();
    expression.concepts.push(new SnomedConcept(reference));
    return new SnomedExpressionContext(source, expression);
  }

  /**
   * @returns {boolean}
   */
  isComplex() {
    return this.expression.isComplex();
  }

  /**
   * @returns {number}
   */
  getReference() {
    return this.expression.concepts[0].reference;
  }

  /**
   * @param {SnomedExpression} expression
   */
  setExpression(expression) {
    this.expression = expression;
  }
}

// Also add this method to SnomedExpressionServices to help with debugging
class SnomedExpressionServicesExtended extends SnomedExpressionServices {
  /**
   * @param {SnomedStructuresLike} snomedStructures
   * @param {number} isAIndex
   */
  constructor(snomedStructures, isAIndex) {
    super(snomedStructures, isAIndex);

    // Ensure building flag is accessible
    this.building = false;
  }

  /**
   * Enhanced getDefiningRelationships with better error handling
   * @param {number} conceptIndex
   * @returns {number[]}
   */
  getDefiningRelationships(conceptIndex) {
    try {
      const concept = this.concepts.getConcept(conceptIndex);
      const outboundIndex = concept.outbounds;

      if (outboundIndex === 0) {
        return [];
      }

      /** @type {number[]} */
      const result = [];
      const outbounds = this.refs.getReferences(outboundIndex);

      if (!outbounds) {
        return [];
      }

      for (const relIndex of outbounds) {
        try {
          const rel = this.relationships.getRelationship(relIndex);

          // Only include active defining relationships that are not is-a
          if (rel.active && rel.defining && rel.relType !== this.isAIndex) {
            result.push(relIndex);
          }
        } catch (error) {
          // Skip problematic relationships
          if (this.building) {
            this.log.warn(`Warning: Could not read relationship ${relIndex}: ${errorMessage(error)}`);
          }
        }
      }

      return result;
    } catch (error) {
      if (this.building) {
        this.log.warn(`Warning: Could not get defining relationships for concept ${conceptIndex}: ${errorMessage(error)}`);
      }
      return [];
    }
  }

  /**
   * Enhanced getConceptParents with better error handling
   * @param {number} reference
   * @returns {number[]}
   */
  getConceptParents(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      const parentsIndex = concept.parents;

      if (parentsIndex === 0) {
        return [];
      }

      const parents = this.refs.getReferences(parentsIndex);
      return parents || [];
    } catch (error) {
      if (this.building) {
        this.log.warn(`Warning: Could not get parents for concept ${reference}: ${errorMessage(error)}`);
      }
      return [];
    }
  }

  /**
   * Enhanced isPrimitive check with fallback
   * @param {number} reference
   * @returns {boolean}
   */
  isPrimitive(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      // In SNOMED CT, primitive concepts have the primitive flag set
      // The definitionStatusId in RF2 determines this:
      // 900000000000074008 = primitive, 900000000000073002 = fully defined
      return (concept.flags & 1) !== 0;
    } catch (error) {
      // If we can't read the concept, assume it's primitive for safety
      if (this.building) {
        this.log.warn(`Warning: Could not check primitive status for concept ${reference}, assuming primitive: ${errorMessage(error)}`);
      }
      return true;
    }
  }

  /**
   * Enhanced createDefinedExpression with better error handling
   * @param {number} reference
   * @param {SnomedExpression} exp
   * @param {boolean} [ancestor]
   */
  createDefinedExpression(reference, exp, ancestor = false) {
    try {
      if (this.isPrimitive(reference)) {
        if (!exp.hasConcept(reference)) {
          const concept = new SnomedConcept(reference);
          concept.code = this.getConceptId(reference);
          exp.concepts.push(concept);
        }
        return;
      }

      // Add parent concepts
      const parents = this.getConceptParents(reference);
      for (const parent of parents) {
        this.createDefinedExpression(parent, exp, true);
      }

      if (!ancestor || !this.assumeClassified) {
        /** @type {Map<string, SnomedRefinementGroup>} */
        const groups = new Map(); // Group number -> refinement group

        // Process defining relationships
        const definingRels = this.getDefiningRelationships(reference);
        for (const relIndex of definingRels) {
          try {
            const rel = this.relationships.getRelationship(relIndex);

            const ref = new SnomedRefinement();
            ref.name = new SnomedConcept(rel.relType);
            ref.name.code = this.getConceptId(rel.relType);

            ref.value = new SnomedExpression();
            const targetConcept = new SnomedConcept(rel.target);
            targetConcept.code = this.getConceptId(rel.target);
            ref.value.concepts.push(targetConcept);

            if (rel.group === 0) {
              // Ungrouped refinement
              if (!exp.hasRefinement(ref)) {
                exp.refinements.push(ref);
              }
            } else {
              // Grouped refinement
              const groupKey = rel.group.toString();
              if (!groups.has(groupKey)) {
                groups.set(groupKey, new SnomedRefinementGroup());
              }
              const group = groups.get(groupKey);
              if (group) {
                group.refinements.push(ref);
              }
            }
          } catch (error) {
            // Skip problematic relationships but continue
            if (this.building) {
              this.log.warn(`Warning: Could not process relationship ${relIndex}: ${errorMessage(error)}`);
            }
          }
        }

        // Add groups to expression
        for (const grp of groups.values()) {
          if (!exp.hasRefinementGroup(grp)) {
            exp.refinementGroups.push(grp);
          }
        }
      }
    } catch (error) {
      if (this.building) {
        this.log.warn(`Warning: Could not create defined expression for concept ${reference}: ${errorMessage(error)}`);
      }
      // Add as primitive concept as fallback
      if (!exp.hasConcept(reference)) {
        const concept = new SnomedConcept(reference);
        concept.code = this.getConceptId(reference);
        exp.concepts.push(concept);
      }
    }
  }
}


// Export classes and constants
module.exports = {
  // Expression status and constants
  SnomedExpressionStatus,
  MAX_TERM_LENGTH,
  NO_REFERENCE,

  // Core expression classes
  SnomedExpressionBase,
  SnomedConcept,
  SnomedRefinement,
  SnomedRefinementGroup,
  SnomedExpression,
  SnomedExpressionParser,

  // Services and context
  SnomedExpressionServices,
  SnomedExpressionContext,
  MatchingConcept,
  SnomedExpressionServicesExtended,

  // Enums and constants
  SnomedServicesRenderOption,
  SnomedRefinementGroupMatchState
};
