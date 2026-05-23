// @ts-check

/**
 * Terminology Errors
 * 
 * Custom error classes for terminology operations
 */

/**
 * Error thrown when an operation exceeds time or resource limits
 */
class TooCostlyError extends Error {
  /** @type {string} */
  diagnostics;
  /** @type {number} */
  statusCode;
  /** @type {string} */
  issueCode;

  /**
   * @param {string} message - Error message
   * @param {string} diagnostics - Additional diagnostic information
   */
  constructor(message, diagnostics = '') {
    super(message);
    this.name = 'TooCostlyError';
    this.diagnostics = diagnostics;
    this.statusCode = 422; // Unprocessable Entity
    this.issueCode = 'too-costly';
  }
}

/**
 * Error thrown for terminology operation failures
 */
class TerminologyError extends Error {
  /** @type {string} */
  issueCode;
  /** @type {number} */
  statusCode;

  /**
   * @param {string} message - Error message
   * @param {string} issueCode - FHIR issue code (default: 'processing')
   * @param {number} statusCode - HTTP status code (default: 422)
   */
  constructor(message, issueCode = 'processing', statusCode = 422) {
    super(message);
    this.name = 'TerminologyError';
    this.issueCode = issueCode;
    this.statusCode = statusCode;
  }
}

/**
 * Error thrown when a required resource is not found
 */
class NotFoundError extends TerminologyError {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message, 'not-found', 404);
    this.name = 'NotFoundError';
  }
}

/**
 * Error thrown for invalid input
 */
class InvalidError extends TerminologyError {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message, 'invalid', 400);
    this.name = 'InvalidError';
  }
}

/**
 * Error thrown when an operation is not supported
 */
class NotSupportedError extends TerminologyError {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message, 'not-supported', 400);
    this.name = 'NotSupportedError';
  }
}

module.exports = {
  TooCostlyError,
  TerminologyError,
  NotFoundError,
  InvalidError,
  NotSupportedError
};
