// @ts-check

/**
 * SNOMED CT Expression Constraint Language (ECL) Validator
 *
 * This implementation provides parsing, validation, and evaluation of ECL expressions
 * against SNOMED CT data using the existing SnomedServices infrastructure.
 *
 * Supports ECL v2.1 specification from SNOMED International
 */

/** @typedef {{type: string, value?: string | null}} ECLToken */
/** @typedef {Record<string, any>} ECLNode */
/** @typedef {{success: boolean, ast: ECLNode | null, errors: string[]}} ECLParseResult */
/** @typedef {{success: boolean, errors: string[]}} ECLSemanticResult */
/** @typedef {{descendants?: number[], matches?: Array<{index: number, term?: string | number | bigint}>, [key: string]: any}} FilterContextLike */
/** @typedef {Record<string, any>} SnomedServicesLike */

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ECL Token Types
const ECLTokenType = {
  // Literals
  SCTID: 'SCTID',
  TERM: 'TERM',
  STRING: 'STRING',
  INTEGER: 'INTEGER',
  DECIMAL: 'DECIMAL',

  // Operators (ECL 2.x spec)
  CHILD_OF: 'CHILD_OF',                    // <!   direct children only
  CHILD_OR_SELF_OF: 'CHILD_OR_SELF_OF',   // <<!  self + direct children
  DESCENDANT_OF: 'DESCENDANT_OF',         // <    all transitive descendants, no self
  DESCENDANT_OR_SELF_OF: 'DESCENDANT_OR_SELF_OF', // <<   self + all transitive descendants
  PARENT_OF: 'PARENT_OF',                 // >!   direct parents only
  PARENT_OR_SELF_OF: 'PARENT_OR_SELF_OF', // >>!  self + direct parents
  ANCESTOR_OF: 'ANCESTOR_OF',             // >    all transitive ancestors, no self
  ANCESTOR_OR_SELF_OF: 'ANCESTOR_OR_SELF_OF', // >>   self + all transitive ancestors

  // Set operators
  AND: 'AND',
  OR: 'OR',
  MINUS: 'MINUS',

  // Refinement
  COLON: 'COLON',                         // :
  EQUALS: 'EQUALS',                       // =
  NOT_EQUALS: 'NOT_EQUALS',               // !=

  // Comparison operators
  LT: 'LT',                               // <
  LTE: 'LTE',                             // <=
  GT: 'GT',                               // >
  GTE: 'GTE',                             // >=

  // Special
  MEMBER_OF: 'MEMBER_OF',                 // ^
  WILDCARD: 'WILDCARD',                   // *
  DOT: 'DOT',                             // .
  CARDINALITY_RANGE: 'CARDINALITY_RANGE', // ..
  REVERSE: 'REVERSE',                     // R

  // Brackets
  LPAREN: 'LPAREN',                       // (
  RPAREN: 'RPAREN',                       // )
  LBRACE: 'LBRACE',                       // {
  RBRACE: 'RBRACE',                       // }
  LBRACKET: 'LBRACKET',                   // [
  RBRACKET: 'RBRACKET',                   // ]

  // Separators
  COMMA: 'COMMA',                         // ,
  PIPE: 'PIPE',                           // |
  HASH: 'HASH',                           // #

  // Special tokens
  WS: 'WS',
  EOF: 'EOF',
  ERROR: 'ERROR'
};

// ECL Expression Node Types
const ECLNodeType = {
  SIMPLE_EXPRESSION_CONSTRAINT: 'SimpleExpressionConstraint',
  REFINED_EXPRESSION_CONSTRAINT: 'RefinedExpressionConstraint',
  COMPOUND_EXPRESSION_CONSTRAINT: 'CompoundExpressionConstraint',
  DOTTED_EXPRESSION_CONSTRAINT: 'DottedExpressionConstraint',

  CONCEPT_REFERENCE: 'ConceptReference',
  WILDCARD: 'Wildcard',
  MEMBER_OF: 'MemberOf',

  REFINEMENT: 'Refinement',
  ATTRIBUTE_SET: 'AttributeSet',
  ATTRIBUTE_GROUP: 'AttributeGroup',
  ATTRIBUTE: 'Attribute',

  SUB_EXPRESSION_CONSTRAINT: 'SubExpressionConstraint',
  EXPRESSION_COMPARISON: 'ExpressionComparison',
  NUMERIC_COMPARISON: 'NumericComparison',
  STRING_COMPARISON: 'StringComparison',

  CONJUNCTION: 'Conjunction',
  DISJUNCTION: 'Disjunction',
  EXCLUSION: 'Exclusion',

  CARDINALITY: 'Cardinality'
};

/**
 * ECL Lexer - Tokenizes ECL expressions
 */
class ECLLexer {
  /**
   * @param {string} input
   */
  constructor(input) {
    this.input = input;
    this.position = 0;
    this.current = this.input[0] || null;
  }

  /**
   * @param {string} message
   * @returns {never}
   */
  error(message) {
    throw new Error(`Lexer error at position ${this.position}: ${message}`);
  }

  advance() {
    this.position++;
    this.current = this.position < this.input.length ? this.input[this.position] : null;
  }

  /**
   * @param {number} [offset]
   * @returns {string | null}
   */
  peek(offset = 1) {
    const pos = this.position + offset;
    return pos < this.input.length ? this.input[pos] : null;
  }

  skipWhitespace() {
    while (this.current && /\s/.test(this.current)) {
      this.advance();
    }
  }

  /**
   * @returns {string}
   */
  readSCTID() {
    let value = '';
    while (this.current && /\d/.test(this.current)) {
      value += this.current;
      this.advance();
    }
    return value;
  }

  /**
   * @returns {string}
   */
  readTerm() {
    let value = '';
    // We should be positioned at the opening |
    if (this.current !== '|') {
      this.error('Expected | at start of term');
    }
    this.advance(); // Skip opening |

    while (this.current && this.current !== '|') {
      value += this.current;
      this.advance();
    }

    if (this.current !== '|') {
      this.error('Unterminated term - missing closing |');
    }

    this.advance(); // Skip closing |
    return value.trim();
  }

  /**
   * @returns {string}
   */
  readString() {
    let value = '';
    const quote = this.current;
    this.advance(); // Skip opening quote

    while (this.current && this.current !== quote) {
      if (this.current === '\\') {
        this.advance();
        if (this.current) {
          value += this.current;
          this.advance();
        }
      } else {
        value += this.current;
        this.advance();
      }
    }

    if (this.current !== quote) {
      this.error('Unterminated string');
    }

    this.advance(); // Skip closing quote
    return value;
  }

  /**
   * @returns {{value: string, type: string}}
   */
  readNumber() {
    let value = '';
    let hasDecimal = false;

    // Handle negative numbers
    if (this.current === '-') {
      value += this.current;
      this.advance();
    }

    while (this.current && (/\d/.test(this.current) || (this.current === '.' && !hasDecimal))) {
      if (this.current === '.') {
        hasDecimal = true;
      }
      value += this.current;
      this.advance();
    }

    return {
      value,
      type: hasDecimal ? ECLTokenType.DECIMAL : ECLTokenType.INTEGER
    };
  }

  /**
   * @returns {ECLToken}
   */
  getNextToken() {
    while (this.current) {
      if (/\s/.test(this.current)) {
        this.skipWhitespace();
        continue;
      }

      // Single character tokens
      switch (this.current) {
        case '(':
          this.advance();
          return { type: ECLTokenType.LPAREN, value: '(' };
        case ')':
          this.advance();
          return { type: ECLTokenType.RPAREN, value: ')' };
        case '{':
          this.advance();
          return { type: ECLTokenType.LBRACE, value: '{' };
        case '}':
          this.advance();
          return { type: ECLTokenType.RBRACE, value: '}' };
        case '[':
          this.advance();
          return { type: ECLTokenType.LBRACKET, value: '[' };
        case ']':
          this.advance();
          return { type: ECLTokenType.RBRACKET, value: ']' };
        case ',':
          this.advance();
          return { type: ECLTokenType.COMMA, value: ',' };
        case '.':
          // Check for cardinality range operator (..)
          if (this.peek() === '.') {
            this.advance();
            this.advance();
            return { type: ECLTokenType.CARDINALITY_RANGE, value: '..' };
          } else {
            this.advance();
            return { type: ECLTokenType.DOT, value: '.' };
          }
        case ':':
          this.advance();
          return { type: ECLTokenType.COLON, value: ':' };
        case '^':
          this.advance();
          return { type: ECLTokenType.MEMBER_OF, value: '^' };
        case '*':
          this.advance();
          return { type: ECLTokenType.WILDCARD, value: '*' };
        case '#':
          this.advance();
          return { type: ECLTokenType.HASH, value: '#' };
        case '|': {
          // This is a term - read the entire |term| construct
          const termValue = this.readTerm();
          return {type: ECLTokenType.TERM, value: termValue};
        }
      }

      // Multi-character operators
      // ECL 2.x hierarchy operators:
      //   <    descendantOf         (transitive, no self)
      //   <<   descendantOrSelfOf   (transitive, with self)
      //   <!   childOf              (one step)
      //   <<!  childOrSelfOf        (one step + self)
      //   >    ancestorOf           (transitive, no self)
      //   >>   ancestorOrSelfOf     (transitive, with self)
      //   >!   parentOf             (one step)
      //   >>!  parentOrSelfOf       (one step + self)
      if (this.current === '<') {
        if (this.peek() === '<') {
          if (this.peek(2) === '!') {
            this.advance();
            this.advance();
            this.advance();
            return { type: ECLTokenType.CHILD_OR_SELF_OF, value: '<<!' };
          } else {
            this.advance();
            this.advance();
            return { type: ECLTokenType.DESCENDANT_OR_SELF_OF, value: '<<' };
          }
        } else if (this.peek() === '!') {
          this.advance();
          this.advance();
          return { type: ECLTokenType.CHILD_OF, value: '<!' };
        } else if (this.peek() === '=') {
          this.advance();
          this.advance();
          return { type: ECLTokenType.LTE, value: '<=' };
        } else {
          this.advance();
          return { type: ECLTokenType.DESCENDANT_OF, value: '<' };
        }
      }

      if (this.current === '>') {
        if (this.peek() === '>') {
          if (this.peek(2) === '!') {
            this.advance();
            this.advance();
            this.advance();
            return { type: ECLTokenType.PARENT_OR_SELF_OF, value: '>>!' };
          } else {
            this.advance();
            this.advance();
            return { type: ECLTokenType.ANCESTOR_OR_SELF_OF, value: '>>' };
          }
        } else if (this.peek() === '!') {
          this.advance();
          this.advance();
          return { type: ECLTokenType.PARENT_OF, value: '>!' };
        } else if (this.peek() === '=') {
          this.advance();
          this.advance();
          return { type: ECLTokenType.GTE, value: '>=' };
        } else {
          this.advance();
          return { type: ECLTokenType.ANCESTOR_OF, value: '>' };
        }
      }

      if (this.current === '=') {
        this.advance();
        return { type: ECLTokenType.EQUALS, value: '=' };
      }

      if (this.current === '!') {
        if (this.peek() === '=') {
          this.advance();
          this.advance();
          return { type: ECLTokenType.NOT_EQUALS, value: '!=' };
        } else {
          this.error(`Unexpected character: ${this.current}`);
        }
      }

      // String literals
      if (this.current === '"' || this.current === "'") {
        return { type: ECLTokenType.STRING, value: this.readString() };
      }

      // Handle numbers - check for decimal first, then SCTID
      if (/\d/.test(this.current)) {
        // Look ahead to see if this is a decimal number (digit.digit with no space)
        let pos = this.position;
        while (pos < this.input.length && /\d/.test(this.input[pos])) {
          pos++;
        }

        // Check if immediately followed by .digit (decimal number)
        if (pos < this.input.length &&
            this.input[pos] === '.' &&
            pos + 1 < this.input.length &&
            /\d/.test(this.input[pos + 1])) {
          // This is a decimal number - parse it completely
          const num = this.readNumber();
          return { type: num.type, value: num.value };
        } else {
          // This is a SCTID (concept ID)
          const value = this.readSCTID();
          return { type: ECLTokenType.SCTID, value };
        }
      }

      // Handle negative numbers separately
      const next = this.peek();
      if (this.current === '-' && next !== null && /\d/.test(next)) {
        const num = this.readNumber();
        return { type: num.type, value: num.value };
      }

      // Keywords and identifiers
      if (/[a-zA-Z_]/.test(this.current)) {
        let value = '';
        while (this.current && /[a-zA-Z0-9_]/.test(this.current)) {
          value += this.current;
          this.advance();
        }

        // Check for keywords
        switch (value.toUpperCase()) {
          case 'AND':
            return { type: ECLTokenType.AND, value: value };
          case 'OR':
            return { type: ECLTokenType.OR, value: value };
          case 'MINUS':
            return { type: ECLTokenType.MINUS, value: value };
          case 'R':
            return { type: ECLTokenType.REVERSE, value: value };
          default:
            // Could be a namespace identifier or other construct
            return { type: ECLTokenType.SCTID, value: value };
        }
      }

      this.error(`Unexpected character: ${this.current}`);
    }

    return { type: ECLTokenType.EOF, value: null };
  }

  /**
   * @returns {ECLToken[]}
   */
  tokenize() {
    /** @type {ECLToken[]} */
    const tokens = [];
    /** @type {ECLToken} */
    let token;

    do {
      token = this.getNextToken();
      tokens.push(token);
    } while (token.type !== ECLTokenType.EOF);

    return tokens;
  }
}

/**
 * ECL Parser - Parses tokens into AST
 */
class ECLParser {
  /**
   * @param {ECLToken[]} tokens
   */
  constructor(tokens) {
    this.tokens = tokens;
    this.position = 0;
    this.current = this.tokens[0] || { type: ECLTokenType.EOF, value: null };
  }

  /**
   * @param {string} message
   * @returns {never}
   */
  error(message) {
    throw new Error(`Parser error at token ${this.position}: ${message}. Current token: ${this.current.type}(${this.current.value})`);
  }

  advance() {
    this.position++;
    this.current = this.position < this.tokens.length ? this.tokens[this.position] : { type: ECLTokenType.EOF, value: null };
  }

  /**
   * @param {number} [offset]
   * @returns {ECLToken}
   */
  peek(offset = 1) {
    const pos = this.position + offset;
    return pos < this.tokens.length ? this.tokens[pos] : { type: ECLTokenType.EOF, value: null };
  }

  /**
   * @param {string} tokenType
   * @returns {ECLToken}
   */
  expect(tokenType) {
    if (this.current.type !== tokenType) {
      this.error(`Expected ${tokenType}, got ${this.current.type}`);
    }
    const token = this.current;
    this.advance();
    return token;
  }

  /**
   * @param {...string} tokenTypes
   * @returns {boolean}
   */
  match(...tokenTypes) {
    return tokenTypes.includes(this.current.type);
  }

  // Main parsing entry point
  /**
   * @returns {ECLNode}
   */
  parse() {
    const result = this.parseExpressionConstraint();
    if (this.current.type !== ECLTokenType.EOF) {
      this.error('Unexpected tokens after end of expression');
    }
    return result;
  }

  /**
   * @returns {ECLNode}
   */
  parseExpressionConstraint() {
    return this.parseCompoundExpressionConstraint();
  }

  /**
   * @returns {ECLNode}
   */
  parseCompoundExpressionConstraint() {
    let left = this.parseRefinedExpressionConstraint();

    while (this.match(ECLTokenType.AND, ECLTokenType.OR, ECLTokenType.MINUS)) {
      const operator = this.current;
      this.advance();
      const right = this.parseRefinedExpressionConstraint();

      const nodeType = operator.type === ECLTokenType.AND ? ECLNodeType.CONJUNCTION :
          operator.type === ECLTokenType.OR ? ECLNodeType.DISJUNCTION :
              ECLNodeType.EXCLUSION;

      left = {
        type: ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT,
        operator: nodeType,
        left,
        right
      };
    }

    return left;
  }

  /**
   * @returns {ECLNode}
   */
  parseRefinedExpressionConstraint() {
    let base = this.parseDottedExpressionConstraint();

    if (this.match(ECLTokenType.COLON)) {
      this.advance(); // consume :
      const refinement = this.parseRefinement();

      return {
        type: ECLNodeType.REFINED_EXPRESSION_CONSTRAINT,
        base,
        refinement
      };
    }

    return base;
  }

  /**
   * @returns {ECLNode}
   */
  parseDottedExpressionConstraint() {
    let base = this.parseSubExpressionConstraint();

    /** @type {ECLNode[]} */
    const attributes = [];
    while (this.match(ECLTokenType.DOT)) {
      this.advance(); // consume .
      const attribute = this.parseAttributeName();
      attributes.push(attribute);
    }

    if (attributes.length > 0) {
      return {
        type: ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT,
        base,
        attributes
      };
    }

    return base;
  }

  /**
   * @returns {ECLNode}
   */
  parseSubExpressionConstraint() {
    // Handle constraint operators
    /** @type {ECLToken | null} */
    let operator = null;
    if (this.match(
        ECLTokenType.CHILD_OF, ECLTokenType.CHILD_OR_SELF_OF,
        ECLTokenType.DESCENDANT_OF, ECLTokenType.DESCENDANT_OR_SELF_OF,
        ECLTokenType.PARENT_OF, ECLTokenType.PARENT_OR_SELF_OF,
        ECLTokenType.ANCESTOR_OF, ECLTokenType.ANCESTOR_OR_SELF_OF
    )) {
      operator = this.current;
      this.advance();
    }

    /** @type {ECLNode} */
    let focus;

    // Handle memberOf
    if (this.match(ECLTokenType.MEMBER_OF)) {
      this.advance(); // consume ^
      // Parse the reference set - can be concept reference, wildcard, or parenthesized expression
      // but NOT another constraint operator or member-of expression
      /** @type {ECLNode} */
      let refSet;
      if (this.match(ECLTokenType.LPAREN)) {
        this.advance(); // consume (
        refSet = this.parseExpressionConstraint();
        this.expect(ECLTokenType.RPAREN);
      } else {
        refSet = this.parseEclFocusConcept();
      }

      focus = {
        type: ECLNodeType.MEMBER_OF,
        refSet
      };
    } else if (this.match(ECLTokenType.LPAREN)) {
      this.advance(); // consume (
      focus = this.parseExpressionConstraint();
      this.expect(ECLTokenType.RPAREN);
    } else {
      focus = this.parseEclFocusConcept();
    }

    const result = {
      type: ECLNodeType.SUB_EXPRESSION_CONSTRAINT,
      operator: operator ? operator.type : null,
      focus
    };

    return result;
  }

  /**
   * @returns {ECLNode}
   */
  parseEclFocusConcept() {
    if (this.match(ECLTokenType.WILDCARD)) {
      this.advance();
      return {
        type: ECLNodeType.WILDCARD
      };
    }

    if (this.match(ECLTokenType.SCTID)) {
      const conceptId = String(this.current.value);
      this.advance();

      let term = null;
      if (this.match(ECLTokenType.TERM)) {
        term = this.current.value;
        this.advance();
      }

      return {
        type: ECLNodeType.CONCEPT_REFERENCE,
        conceptId,
        term
      };
    }

    this.error('Expected concept reference or wildcard');
  }

  /**
   * @returns {ECLNode}
   */
  parseRefinement() {
    return this.parseAttributeSet();
  }

  /**
   * @returns {ECLNode}
   */
  parseAttributeSet() {
    /** @type {ECLNode[]} */
    const attributes = [];

    do {
      if (this.match(ECLTokenType.LBRACE)) {
        // Attribute group
        attributes.push(this.parseAttributeGroup());
      } else {
        // Single attribute
        attributes.push(this.parseAttribute());
      }
    } while (this.match(ECLTokenType.COMMA) && (this.advance(), true));

    if (attributes.length === 1) {
      return attributes[0];
    }

    return {
      type: ECLNodeType.ATTRIBUTE_SET,
      attributes
    };
  }

  /**
   * @returns {ECLNode}
   */
  parseAttributeGroup() {
    /** @type {ECLNode | null} */
    let cardinality = null;

    // Check for cardinality before {
    if (this.match(ECLTokenType.LBRACKET)) {
      cardinality = this.parseCardinality();
    }

    this.expect(ECLTokenType.LBRACE);

    /** @type {ECLNode[]} */
    const attributes = [];
    do {
      attributes.push(this.parseAttribute());
    } while (this.match(ECLTokenType.COMMA) && (this.advance(), true));

    this.expect(ECLTokenType.RBRACE);

    return {
      type: ECLNodeType.ATTRIBUTE_GROUP,
      cardinality,
      attributes
    };
  }

  /**
   * @returns {ECLNode}
   */
  parseAttribute() {
    /** @type {ECLNode | null} */
    let cardinality = null;
    let reverse = false;

    // Check for cardinality first - this must come before attribute name
    if (this.match(ECLTokenType.LBRACKET)) {
      cardinality = this.parseCardinality();
    }

    // Check for reverse flag
    if (this.match(ECLTokenType.REVERSE)) {
      reverse = true;
      this.advance();
    }

    const name = this.parseAttributeName();

    // Parse comparison operator and value
    /** @type {ECLNode | null} */
    let comparison = null;
    if (this.match(ECLTokenType.EQUALS, ECLTokenType.NOT_EQUALS)) {
      const operator = this.current;
      this.advance();
      const value = this.parseSubExpressionConstraint();

      comparison = {
        type: ECLNodeType.EXPRESSION_COMPARISON,
        operator: operator.type,
        value
      };
    } else if (this.match(ECLTokenType.LT, ECLTokenType.LTE, ECLTokenType.DESCENDANT_OF, ECLTokenType.ANCESTOR_OF, ECLTokenType.GTE)) {
      // In ECL, bare `<` and `>` are overloaded: they lex as hierarchy
      // operators (DESCENDANT_OF / ANCESTOR_OF) but in an attribute comparison
      // context they mean less-than / greater-than. Accept them here and map
      // them to LT / GT so downstream consumers see a uniform shape.
      const operator = this.current;
      this.advance();

      this.expect(ECLTokenType.HASH);

      /** @type {string} */
      let value;
      if (this.match(ECLTokenType.SCTID, ECLTokenType.DECIMAL, ECLTokenType.INTEGER)) {
        // In numeric comparison context, accept SCTID, DECIMAL, or INTEGER as numbers
        value = String(this.current.value);
        this.advance();
      } else {
        this.error('Expected numeric value after #');
      }

      // Map DESCENDANT_OF to LT and ANCESTOR_OF to GT for numeric comparisons
      let operatorType = operator.type;
      if (operator.type === ECLTokenType.DESCENDANT_OF) {
        operatorType = ECLTokenType.LT;
      } else if (operator.type === ECLTokenType.ANCESTOR_OF) {
        operatorType = ECLTokenType.GT;
      }

      comparison = {
        type: ECLNodeType.NUMERIC_COMPARISON,
        operator: operatorType,
        value
      };
    }

    return {
      type: ECLNodeType.ATTRIBUTE,
      cardinality,
      reverse,
      name,
      comparison
    };
  }

  /**
   * @returns {ECLNode}
   */
  parseAttributeName() {
    return this.parseEclFocusConcept();
  }

  /**
   * @returns {ECLNode}
   */
  parseCardinality() {
    this.expect(ECLTokenType.LBRACKET);

    /** @type {number | null} */
    let min = null;
    /** @type {number | string | null} */
    let max = null;

    if (this.match(ECLTokenType.SCTID)) {
      // Parse as number in cardinality context
      min = parseInt(String(this.current.value), 10);
      this.advance();

      // Check for range syntax: ..
      if (this.match(ECLTokenType.CARDINALITY_RANGE)) {
        this.advance(); // consume ..

        if (this.match(ECLTokenType.SCTID)) {
          max = parseInt(String(this.current.value), 10);
          this.advance();
        } else if (this.match(ECLTokenType.WILDCARD)) {
          max = '*';
          this.advance();
        } else {
          this.error('Expected number or * after ..');
        }
      } else {
        max = min; // Single number means exact cardinality
      }
    } else if (this.match(ECLTokenType.WILDCARD)) {
      min = 0;
      max = '*';
      this.advance();
    } else {
      this.error('Expected number or * for cardinality');
    }

    this.expect(ECLTokenType.RBRACKET);

    return {
      type: ECLNodeType.CARDINALITY,
      min,
      max
    };
  }
}

/**
 * ECL Validator - Validates and evaluates ECL expressions
 */
class ECLValidator {
  /**
   * @param {SnomedServicesLike} snomedServices
   */
  constructor(snomedServices) {
    this.sct = snomedServices;
  }

  /**
   * Parse and validate an ECL expression
   * @param {string} eclExpression
   * @returns {ECLParseResult}
   */
  parse(eclExpression) {
    try {
      const lexer = new ECLLexer(eclExpression);
      const tokens = lexer.tokenize();

      const parser = new ECLParser(tokens);
      const ast = parser.parse();

      // Validate the AST
      this.validateAST(ast);

      return {
        success: true,
        ast,
        errors: []
      };
    } catch (error) {
      return {
        success: false,
        ast: null,
        errors: [errorMessage(error)]
      };
    }
  }

  /**
   * Validate AST node semantically
   * @param {ECLNode} node
   */
  validateAST(node) {
    if (!node || typeof node !== 'object') {
      throw new Error('Invalid AST node');
    }

    switch (node.type) {
      case ECLNodeType.CONCEPT_REFERENCE:
        this.validateConceptReference(node);
        break;

      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        this.validateAST(node.base);
        this.validateAST(node.refinement);
        break;

      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT:
        this.validateAST(node.left);
        this.validateAST(node.right);
        break;

      case ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT:
        this.validateAST(node.base);
        node.attributes.forEach((/** @type {ECLNode} */ attr) => this.validateAST(attr));
        break;

      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        this.validateAST(node.focus);
        break;

      case ECLNodeType.MEMBER_OF:
        this.validateAST(node.refSet);
        this.validateReferenceSet(node.refSet);
        break;

      case ECLNodeType.ATTRIBUTE_SET:
        node.attributes.forEach((/** @type {ECLNode} */ attr) => this.validateAST(attr));
        break;

      case ECLNodeType.ATTRIBUTE_GROUP:
        node.attributes.forEach((/** @type {ECLNode} */ attr) => this.validateAST(attr));
        break;

      case ECLNodeType.ATTRIBUTE:
        this.validateAST(node.name);
        if (node.comparison) {
          this.validateComparison(node.comparison);
        }
        break;

      case ECLNodeType.EXPRESSION_COMPARISON:
        this.validateAST(node.value);
        break;

      case ECLNodeType.WILDCARD:
        // Wildcards are always valid
        break;

      default:
        // Allow other node types to pass through
        break;
    }
  }

  /**
   * Validate concept reference exists in SNOMED CT
   */
  /**
   * Validate concept reference exists in SNOMED CT and term matches if provided
   * @param {ECLNode} node
   */
  validateConceptReference(node) {
    if (!node.conceptId) {
      throw new Error('Concept reference missing concept ID');
    }

    if (!/^\d+$/.test(node.conceptId)) {
      throw new Error(`Invalid SNOMED CT concept ID format: ${node.conceptId}`);
    }

    // Check if it's a valid concept ID
    try {
      if (!this.sct.conceptExists(node.conceptId)) {
        // Check if it might be a number used in wrong context
        const numValue = parseInt(node.conceptId);
        if (numValue < 1000000) {
          throw new Error(`${node.conceptId} appears to be a number rather than a SNOMED CT concept ID. SNOMED concept IDs are typically 6+ digits. If this should be a numeric value, use it in a cardinality [${node.conceptId}] or comparison >= #${node.conceptId} context.`);
        } else {
          throw new Error(`SNOMED CT concept ${node.conceptId} not found in the loaded terminology`);
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('not found')) {
        throw error; // Re-throw our custom message
      }
      throw new Error(`Error validating concept ${node.conceptId}: ${message}`);
    }

    // Validate term if provided
    if (node.term) {
      try {
        const conceptIndex = this.getConceptReference(node.conceptId);
        const concept = this.sct.concepts.getConcept(conceptIndex);
        const descriptionsRef = concept.descriptions;

        if (descriptionsRef === 0) {
          throw new Error(`Concept ${node.conceptId} has no descriptions`);
        }

        const descriptionIndices = this.sct.refs.getReferences(descriptionsRef);
        let termFound = false;

        const list = [];
        // Check if the provided term matches any of the concept's descriptions
        for (const descIndex of descriptionIndices || []) {
          const description = this.sct.descriptions.getDescription(descIndex);
          const actualTerm = this.sct.strings.getEntry(description.iDesc).trim();
          list.push(actualTerm);
          if (actualTerm === node.term.trim()) {
            termFound = true;
            break;
          }
        }

        if (!termFound) {
          // Get the preferred term for a more helpful error message
          const preferredTerm = this.sct.getDisplayName(conceptIndex);
          throw new Error(`Term "${node.term}" does not match any active description for concept ${node.conceptId}. Expected term like "${preferredTerm}" or from ${list}`);
        }
      } catch (error) {
        const message = errorMessage(error);
        if (message.includes('does not match')) {
          throw error; // Re-throw our term validation error
        }
        throw new Error(`Error validating term for concept ${node.conceptId}: ${message}`);
      }
    }
  }
  /**
   * Validate reference set concept
   * @param {ECLNode} node
   */
  validateReferenceSet(node) {
    if (node.type === ECLNodeType.CONCEPT_REFERENCE) {
      const conceptIndex = this.getConceptReference(node.conceptId);
      const refSetIndex = this.sct.getConceptRefSet(conceptIndex, false);
      if (refSetIndex === 0) {
        throw new Error(`Concept ${node.conceptId} is not a reference set`);
      }
    }
  }

  /**
   * Validate comparison expressions
   * @param {ECLNode} comparison
   */
  validateComparison(comparison) {
    switch (comparison.type) {
      case ECLNodeType.EXPRESSION_COMPARISON:
        this.validateAST(comparison.value);
        break;

      case ECLNodeType.NUMERIC_COMPARISON:
        if (!/^-?\d+(\.\d+)?$/.test(comparison.value)) {
          throw new Error(`Invalid numeric value: ${comparison.value}`);
        }
        break;

      case ECLNodeType.STRING_COMPARISON:
        // String values are always valid
        break;
    }
  }

  /**
   * Evaluate ECL expression and return matching concepts
   * @param {string} eclExpression
   * @returns {Promise<{total: number, results: Array<{conceptId: string, term: string, active: boolean}>}>}
   */
  async evaluate(eclExpression) {
    const parseResult = this.parse(eclExpression);

    if (!parseResult.success) {
      throw new Error(`ECL parsing failed: ${parseResult.errors.join(', ')}`);
    }

    const ast = /** @type {ECLNode} */ (parseResult.ast);
    const filterContext = await this.evaluateAST(ast);
    return this.convertFilterToResults(filterContext);
  }

  /**
   * Evaluate AST node and return filter context
   * @param {ECLNode | null} [node]
   * @returns {Promise<FilterContextLike>}
   */
  async evaluateAST(node = {}) {
    if (!node) {
      throw new Error('Cannot evaluate null AST node');
    }

    switch (node.type) {
      case ECLNodeType.CONCEPT_REFERENCE:
        return await this.evaluateConceptReference(node);

      case ECLNodeType.WILDCARD:
        return await this.evaluateWildcard();

      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        return await this.evaluateSubExpressionConstraint(node);

      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT:
        return await this.evaluateCompoundExpression(node);

      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        return await this.evaluateRefinedExpression(node);

      case ECLNodeType.MEMBER_OF:
        return await this.evaluateMemberOf(node);

      default:
        throw new Error(`Unsupported AST node type: ${node.type}`);
    }
  }

  /**
   * @param {ECLNode} node
   * @returns {Promise<FilterContextLike>}
   */
  async evaluateConceptReference(node) {
    const conceptId = this.sct.stringToId(node.conceptId);
    return this.sct.filterEquals(conceptId);
  }

  /**
   * @returns {Promise<FilterContextLike>}
   */
  async evaluateWildcard() {
    const { SnomedFilterContext } = require('../cs/cs-snomed');

    // Return all concepts - this would need optimization in practice
    const filter = new SnomedFilterContext();
    /** @type {number[]} */
    const allConcepts = [];

    for (let i = 0; i < this.sct.concepts.count(); i++) {
      const conceptIndex = i * this.sct.concepts.constructor.CONCEPT_SIZE;
      if (this.sct.isActive(conceptIndex)) {
        allConcepts.push(conceptIndex);
      }
    }

    filter.descendants = allConcepts;
    return filter;
  }

  /**
   * @param {ECLNode} node
   * @returns {Promise<FilterContextLike>}
   */
  async evaluateSubExpressionConstraint(node) {
    const { SnomedFilterContext } = require('../cs/cs-snomed');

    const baseFilter = await this.evaluateAST(node.focus);

    if (!node.operator) {
      return baseFilter;
    }

    // Apply constraint operator — collect into a Set to deduplicate across
    // multi-concept base filters.
    /** @type {Set<number>} */
    const accumulated = new Set();

    for (const conceptIndex of baseFilter.descendants || []) {
      const conceptId = this.sct.concepts.getConceptId(conceptIndex);

      /** @type {FilterContextLike} */
      let operatorFilter;
      switch (node.operator) {
          // ── Descendants ─────────────────────────────────────────────────────
        case ECLTokenType.DESCENDANT_OF:           // <    transitive, no self
          operatorFilter = this.sct.filterIsA(conceptId, false);
          break;
        case ECLTokenType.DESCENDANT_OR_SELF_OF:   // <<   transitive + self
          operatorFilter = this.sct.filterIsA(conceptId, true);
          break;
        case ECLTokenType.CHILD_OF:                // <!   direct children only
          operatorFilter = this.sct.filterChildOf(conceptId);
          break;
        case ECLTokenType.CHILD_OR_SELF_OF: {      // <<!  self + direct children
          operatorFilter = new SnomedFilterContext();
          const selfResult = this.sct.concepts.findConcept(conceptId);
          const children = selfResult.found ? this.sct.getConceptChildren(selfResult.index) : [];
          operatorFilter.descendants = selfResult.found ? [selfResult.index, ...children] : children;
          break;
        }

          // ── Ancestors ───────────────────────────────────────────────────────
        case ECLTokenType.ANCESTOR_OF:             // >    transitive, no self
          operatorFilter = this.sct.filterGeneralizes(conceptId);
          break;
        case ECLTokenType.ANCESTOR_OR_SELF_OF: {   // >>   transitive + self
          operatorFilter = this.sct.filterGeneralizes(conceptId);
          const selfResult = this.sct.concepts.findConcept(conceptId);
          const descendants = operatorFilter.descendants || [];
          if (selfResult.found && !descendants.includes(selfResult.index)) {
            descendants.push(selfResult.index);
          }
          operatorFilter.descendants = descendants;
          break;
        }
        case ECLTokenType.PARENT_OF: {             // >!   direct parents only
          operatorFilter = new SnomedFilterContext();
          const selfResult = this.sct.concepts.findConcept(conceptId);
          operatorFilter.descendants = selfResult.found
              ? this.sct.getConceptParents(selfResult.index)
              : [];
          break;
        }
        case ECLTokenType.PARENT_OR_SELF_OF: {     // >>!  self + direct parents
          operatorFilter = new SnomedFilterContext();
          const selfResult = this.sct.concepts.findConcept(conceptId);
          const parents = selfResult.found ? this.sct.getConceptParents(selfResult.index) : [];
          operatorFilter.descendants = selfResult.found ? [selfResult.index, ...parents] : parents;
          break;
        }

        default:
          throw new Error(`Unknown constraint operator: ${node.operator}`);
      }

      for (const idx of operatorFilter.descendants || []) {
        accumulated.add(idx);
      }
    }

    const results = new SnomedFilterContext();
    results.descendants = [...accumulated];
    return results;
  }

  /**
   * @param {ECLNode} node
   * @returns {Promise<FilterContextLike>}
   */
  async evaluateCompoundExpression(node) {
    const { SnomedFilterContext } = require('../cs/cs-snomed');

    const leftFilter = await this.evaluateAST(node.left);
    const rightFilter = await this.evaluateAST(node.right);

    const result = new SnomedFilterContext();
    const leftSet = new Set(leftFilter.descendants || []);
    const rightSet = new Set(rightFilter.descendants || []);

    switch (node.operator) {
      case ECLNodeType.CONJUNCTION:
        result.descendants = [...leftSet].filter(x => rightSet.has(x));
        break;
      case ECLNodeType.DISJUNCTION:
        result.descendants = [...new Set([...leftSet, ...rightSet])];
        break;
      case ECLNodeType.EXCLUSION:
        result.descendants = [...leftSet].filter(x => !rightSet.has(x));
        break;
      default:
        throw new Error(`Unknown compound operator: ${node.operator}`);
    }

    return result;
  }

  /**
   * @param {ECLNode} node
   * @returns {Promise<FilterContextLike>}
   */
  async evaluateRefinedExpression(node) {
    // This is a simplified implementation
    // Full refinement evaluation would require analyzing concept relationships
    const baseFilter = await this.evaluateAST(node.base);

    // For now, return the base filter
    // TODO: Implement refinement filtering based on node.refinement
    return baseFilter;
  }

  /**
   * @param {ECLNode} node
   * @returns {Promise<FilterContextLike>}
   */
  async evaluateMemberOf(node) {
    const refSetFilter = await this.evaluateAST(node.refSet);

    if (refSetFilter.descendants && refSetFilter.descendants.length > 0) {
      const conceptIndex = refSetFilter.descendants[0];
      return this.sct.filterIn(this.sct.concepts.getConceptId(conceptIndex));
    }

    throw new Error('Invalid reference set for memberOf operation');
  }

  /**
   * Convert filter context to user-friendly results
   * @param {FilterContextLike} filterContext
   * @returns {{total: number, results: Array<{conceptId: string, term: string, active: boolean}>}}
   */
  convertFilterToResults(filterContext) {
    /** @type {Array<{conceptId: string, term: string, active: boolean}>} */
    const results = [];

    const concepts = filterContext.descendants || filterContext.matches || [];

    for (const conceptIndex of concepts.slice(0, 1000)) { // Limit results
      try {
        /** @type {string | number | bigint} */
        let conceptId;
        /** @type {string} */
        let term;
        /** @type {number} */
        let index;

        if (typeof conceptIndex === 'object' && conceptIndex.index !== undefined) {
          // From search results
          index = conceptIndex.index;
          conceptId = conceptIndex.term ?? this.sct.concepts.getConceptId(index);
          term = this.sct.getDisplayName(index);
        } else if (typeof conceptIndex === 'number') {
          // From regular index
          index = conceptIndex;
          conceptId = this.sct.concepts.getConceptId(conceptIndex);
          term = this.sct.getDisplayName(conceptIndex);
        } else {
          continue;
        }

        results.push({
          conceptId: conceptId.toString(),
          term,
          active: this.sct.isActive(index)
        });
      } catch (error) {
        // Skip concepts that can't be read
        continue;
      }
    }

    return {
      total: concepts.length,
      results
    };
  }

  /**
   * Helper to get concept reference index from concept ID
   * @param {string | number | bigint} conceptId
   * @returns {number}
   */
  getConceptReference(conceptId) {
    const id = this.sct.stringToId(conceptId);
    const result = this.sct.concepts.findConcept(id);
    if (!result.found) {
      throw new Error(`Concept ${conceptId} not found`);
    }
    return result.index;
  }

  /**
   * Validate ECL syntax only (no semantic validation)
   * @param {string} eclExpression
   * @returns {ECLParseResult}
   */
  validateSyntax(eclExpression) {
    try {
      const lexer = new ECLLexer(eclExpression);
      const tokens = lexer.tokenize();

      const parser = new ECLParser(tokens);
      const ast = parser.parse();

      return {
        success: true,
        ast,
        errors: []
      };
    } catch (error) {
      return {
        success: false,
        ast: null,
        errors: [errorMessage(error)]
      };
    }
  }

  /**
   * Get examples of valid ECL expressions
   * @returns {string[]}
   */
  getExamples() {
    return [
      // Simple concept
      '73211009 |Diabetes mellitus|',

      // Descendants
      '< 73211009 |Diabetes mellitus|',
      '<< 404684003 |Clinical finding|',

      // Wildcards
      '*',

      // Boolean operations
      '<< 19829001 |Disorder of lung| AND << 301867009 |Edema of trunk|',
      '<< 126537000 |Neoplasm of bone| OR << 92691004 |Secondary malignant neoplasm of bone|',

      // Refinements
      '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 72704001 |Fracture|',

      // Attribute groups
      '<< 404684003 |Clinical finding|: {116676008 |Associated morphology| = 72704001 |Fracture|, 363698007 |Finding site| = << 71341001 |Bone structure|}',

      // Member of reference set
      '^ 447562003 |ICD-10 complex map reference set|',

      // Dotted attributes
      '<< 404684003 |Clinical finding|.116676008 |Associated morphology|'
    ];
  }

  static CONCEPT_MODEL_ATTRIBUTE = '410662002'; // |Concept model attribute|
  static CLINICAL_FINDING = '404684003'; // |Clinical finding|
  static PROCEDURE = '71388002'; // |Procedure|

  /**
   * Perform semantic validation on a parsed AST
   * This is separate from parse() and optional
   * @param {ECLNode} ast
   * @returns {ECLSemanticResult}
   */
  validateSemantics(ast) {
    /** @type {string[]} */
    const errors = [];
    this.validateSemanticAST(ast, errors);

    return {
      success: errors.length === 0,
      errors
    };
  }

  /**
   * Parse AND validate semantics in one call
   * @param {string} eclExpression
   * @returns {ECLParseResult}
   */
  parseAndValidateSemantics(eclExpression) {
    const parseResult = this.parse(eclExpression);

    if (!parseResult.success) {
      return parseResult;
    }

    const ast = /** @type {ECLNode} */ (parseResult.ast);
    const semanticResult = this.validateSemantics(ast);

    return {
      success: parseResult.success && semanticResult.success,
      ast,
      errors: [...parseResult.errors, ...semanticResult.errors]
    };
  }

  /**
   * Semantic validation traversal (separate from basic validateAST)
   * @param {ECLNode | null} node
   * @param {string[]} errors
   */
  validateSemanticAST(node, errors) {
    if (!node || typeof node !== 'object') {
      return;
    }

    switch (node.type) {
      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        this.validateRefinedExpressionSemantics(node, errors);
        break;

      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT:
        this.validateSemanticAST(node.left, errors);
        this.validateSemanticAST(node.right, errors);
        break;

      case ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT:
        this.validateSemanticAST(node.base, errors);
        node.attributes.forEach((/** @type {ECLNode} */ attr) => this.validateSemanticAST(attr, errors));
        break;

      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        this.validateSemanticAST(node.focus, errors);
        break;

      case ECLNodeType.MEMBER_OF:
        this.validateSemanticAST(node.refSet, errors);
        break;

      case ECLNodeType.ATTRIBUTE_SET:
        node.attributes.forEach((/** @type {ECLNode} */ attr) => this.validateSemanticAST(attr, errors));
        break;

      case ECLNodeType.ATTRIBUTE_GROUP:
        node.attributes.forEach((/** @type {ECLNode} */ attr) => this.validateSemanticAST(attr, errors));
        break;

      case ECLNodeType.ATTRIBUTE:
        this.validateAttributeSemantics(node, errors);
        break;

      case ECLNodeType.EXPRESSION_COMPARISON:
        this.validateSemanticAST(node.value, errors);
        break;

        // Basic nodes don't need semantic validation
      case ECLNodeType.CONCEPT_REFERENCE:
      case ECLNodeType.WILDCARD:
        break;

      default:
        // Allow unknown node types to pass through
        break;
    }
  }

  /**
   * Validate semantics of refined expressions
   * @param {ECLNode} node
   * @param {string[]} errors
   */
  validateRefinedExpressionSemantics(node, errors) {
    this.validateSemanticAST(node.base, errors);
    this.validateSemanticAST(node.refinement, errors);

    // Get the base concept(s) being refined
    const baseConcepts = this.extractBaseConceptIds(node.base);
    const attributes = this.extractAttributesFromRefinement(node.refinement);

    // Validate each attribute in context
    for (const attr of attributes) {
      this.validateAttributeInContext(attr, baseConcepts, errors);
    }
  }

  /**
   * Validate attribute semantics
   * @param {ECLNode} node
   * @param {string[]} errors
   */
  validateAttributeSemantics(node, errors) {
    // Validate the attribute name is a relationship type
    this.validateRelationshipType(node.name, errors);

    // Validate the comparison if present
    if (node.comparison && node.comparison.value) {
      this.validateSemanticAST(node.comparison.value, errors);
      this.validateAttributeRange(node.name, node.comparison.value, errors);
    }
  }

  /**
   * Check if concept is a valid relationship type
   * @param {ECLNode} attributeNode
   * @param {string[]} errors
   */
  validateRelationshipType(attributeNode, errors) {
    if (attributeNode.type !== ECLNodeType.CONCEPT_REFERENCE) {
      return; // Skip validation for wildcards or complex expressions
    }

    try {
      const conceptId = attributeNode.conceptId;
      const conceptIndex = this.getConceptReference(conceptId);

      // Check if it's a descendant of "Concept model attribute"
      const attributeRootIndex = this.getConceptReference(ECLValidator.CONCEPT_MODEL_ATTRIBUTE);

      if (!this.sct.subsumes(attributeRootIndex, conceptIndex)) {
        const displayName = attributeNode.term || this.sct.getDisplayName(conceptIndex);
        errors.push(`Concept ${conceptId} |${displayName}| is not a valid relationship type. Relationship types must be descendants of ${ECLValidator.CONCEPT_MODEL_ATTRIBUTE} |Concept model attribute|`);
      }
    } catch (error) {
      errors.push(`Error validating relationship type ${attributeNode.conceptId}: ${errorMessage(error)}`);
    }
  }

  /**
   * Validate attribute usage in context of base concepts
   * @param {ECLNode} attribute
   * @param {number[]} baseConcepts
   * @param {string[]} errors
   */
  validateAttributeInContext(attribute, baseConcepts, errors) {
    // Check domain appropriateness
    for (const baseConcept of baseConcepts) {
      this.validateAttributeDomain(attribute.name, baseConcept, errors);
    }
  }

  /**
   * Validate attribute domain (which concepts can use this attribute)
   * @param {ECLNode} attributeNode
   * @param {number} baseConceptIndex
   * @param {string[]} errors
   */
  validateAttributeDomain(attributeNode, baseConceptIndex, errors) {
    if (attributeNode.type !== ECLNodeType.CONCEPT_REFERENCE) {
      return;
    }

    try {
      const attributeId = attributeNode.conceptId;

      // Define common domain restrictions
      /** @type {Record<string, string[]>} */
      const domainRules = {
        '116676008': ['404684003'], // |Associated morphology| -> |Clinical finding|
        '363698007': ['404684003'], // |Finding site| -> |Clinical finding|
        '42752001': ['71388002'],   // |Due to| -> |Procedure|
        '260686004': ['71388002'],  // |Method| -> |Procedure|
        '405815000': ['71388002']   // |Procedure device| -> |Procedure|
      };

      if (domainRules[attributeId]) {
        const allowedHierarchies = domainRules[attributeId];
        const isValidDomain = allowedHierarchies.some(hierarchyId => {
          const hierarchyIndex = this.getConceptReference(hierarchyId);
          return this.sct.subsumes(hierarchyIndex, baseConceptIndex);
        });

        if (!isValidDomain) {
          const hierarchyNames = allowedHierarchies.map(id => {
            const idx = this.getConceptReference(id);
            return this.sct.getDisplayName(idx);
          }).join(', ');

          const displayName = attributeNode.term || this.sct.getDisplayName(this.getConceptReference(attributeId));
          errors.push(`Attribute ${attributeId} |${displayName}| is not typically used with concepts outside of: ${hierarchyNames}`);
        }
      }
    } catch (error) {
      errors.push(`Error validating attribute domain for ${attributeNode.conceptId}: ${errorMessage(error)}`);
    }
  }

  /**
   * Validate attribute range (what values are allowed)
   * @param {ECLNode} attributeNode
   * @param {ECLNode} valueNode
   * @param {string[]} errors
   */
  validateAttributeRange(attributeNode, valueNode, errors) {
    if (attributeNode.type !== ECLNodeType.CONCEPT_REFERENCE) {
      return;
    }

    try {
      // Extract the actual concept reference from the value node
      let actualValueNode = valueNode;
      if (valueNode.type === ECLNodeType.SUB_EXPRESSION_CONSTRAINT) {
        actualValueNode = valueNode.focus;
      }

      if (actualValueNode.type !== ECLNodeType.CONCEPT_REFERENCE) {
        return; // Skip validation for wildcards or complex expressions
      }

      const attributeId = attributeNode.conceptId;
      const valueId = actualValueNode.conceptId;

      // Define common range restrictions
      /** @type {Record<string, string[]>} */
      const rangeRules = {
        '116676008': ['49755003'],  // |Associated morphology| -> |Morphologically abnormal structure|
        '363698007': ['442083009'], // |Finding site| -> |Anatomical or acquired body structure|
        '42752001': ['404684003'],  // |Due to| -> |Clinical finding|
        '47429007': ['78621006']    // |Associated with| -> |Physical force|
      };

      if (rangeRules[attributeId]) {
        const allowedRanges = rangeRules[attributeId];
        const valueIndex = this.getConceptReference(valueId);

        const isValidRange = allowedRanges.some(rangeId => {
          const rangeIndex = this.getConceptReference(rangeId);
          return this.sct.subsumes(rangeIndex, valueIndex);
        });

        if (!isValidRange) {
          const rangeNames = allowedRanges.map(id => {
            const idx = this.getConceptReference(id);
            return this.sct.getDisplayName(idx);
          }).join(', ');

          const valueDisplayName = actualValueNode.term || this.sct.getDisplayName(valueIndex);
          errors.push(`Value ${valueId} |${valueDisplayName}| is not a valid concept for attribute ${attributeId}. Expected values from: ${rangeNames}`);
        }
      }
    } catch (error) {
      errors.push(`Error validating attribute range for ${attributeNode.conceptId}: ${errorMessage(error)}`);
    }
  }

  /**
   * Extract base concept IDs from expression constraint
   * @param {ECLNode} node
   * @returns {number[]}
   */
  extractBaseConceptIds(node) {
    /** @type {number[]} */
    const concepts = [];

    switch (node.type) {
      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        concepts.push(...this.extractBaseConceptIds(node.focus));
        break;
      case ECLNodeType.CONCEPT_REFERENCE:
        concepts.push(this.getConceptReference(node.conceptId));
        break;
      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT:
        concepts.push(...this.extractBaseConceptIds(node.left));
        concepts.push(...this.extractBaseConceptIds(node.right));
        break;
      case ECLNodeType.MEMBER_OF:
        concepts.push(...this.extractBaseConceptIds(node.refSet));
        break;
      case ECLNodeType.WILDCARD:
        // Wildcards represent all concepts - skip semantic validation
        break;
    }

    return concepts;
  }

  /**
   * Extract attributes from refinement
   * @param {ECLNode} refinementNode
   * @returns {ECLNode[]}
   */
  extractAttributesFromRefinement(refinementNode) {
    /** @type {ECLNode[]} */
    const attributes = [];

    switch (refinementNode.type) {
      case ECLNodeType.ATTRIBUTE:
        attributes.push(refinementNode);
        break;
      case ECLNodeType.ATTRIBUTE_SET:
        attributes.push(...refinementNode.attributes);
        break;
      case ECLNodeType.ATTRIBUTE_GROUP:
        attributes.push(...refinementNode.attributes);
        break;
    }

    return attributes;
  }


}

module.exports = {
  ECLValidator,
  ECLLexer,
  ECLParser,
  ECLTokenType,
  ECLNodeType
};
