// @ts-check

const {validateParameter} = require("../../library/utilities");

/**
 * @typedef {import('../../types/fhirsmith').FhirOperationOutcome} FhirOperationOutcome
 * @typedef {import('../../types/fhirsmith').FhirOperationOutcomeIssue} FhirOperationOutcomeIssue
 */

class Issue extends Error {
  /** @type {string} */
  level;
  /** @type {string} */
  cause;
  /** @type {string | null} */
  path;
  /** @type {string | null} */
  msgId;
  /** @type {string | null} */
  issueCode;
  /** @type {number} */
  statusCode;
  /** @type {boolean | undefined} */
  isSetForhandleAsOO;
  /** @type {string | undefined} */
  diagnostics;
  /** @type {Issue[]} */
  issues = [];
  /** @type {boolean | undefined} */
  finished;
  /** @type {string | undefined} */
  unknownSystem;

  /**
   * @param {string} level
   * @param {string} cause
   * @param {string | null} path
   * @param {string | null} msgId
   * @param {string} message
   * @param {string | null} [issueCode]
   * @param {number} [statusCode]
   */
  constructor (level, cause, path, msgId, message, issueCode = null, statusCode = 500) {
    super(message);
    this.level = level;
    this.cause = cause;
    this.path = path;
    this.message = message;
    this.msgId = msgId;
    this.issueCode = issueCode;
    this.statusCode = statusCode;
  }

  /**
   * @returns {FhirOperationOutcomeIssue}
   */
  asIssue() {
    let res = /** @type {FhirOperationOutcomeIssue} */ ({
      severity: this.level,
      code: this.cause,
      details: {
        text: this.message
      }
    });
    if (this.path) {
      res.expression = [this.path]
    }
    if (this.issueCode) {
      res.details.coding = [{ system: "http://hl7.org/fhir/tools/CodeSystem/tx-issue-type", code : this.issueCode }];
    }
    if (this.msgId) {
      res.extension = [{ url: "http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id", valueString: this.msgId }];
    }
    if (this.diagnostics) {
      res.diagnostics = this.diagnostics;
    }
    return res;
  }

  /**
   * @param {number} statusCode
   * @returns {this}
   */
  handleAsOO(statusCode) {
    this.isSetForhandleAsOO = true;
    this.statusCode = statusCode;
    return this;
  }

  /**
   * @returns {boolean | undefined}
   */
  isHandleAsOO() {
    return this.isSetForhandleAsOO;
  }

  /**
   * @returns {this}
   */
  setFinished() {
    this.finished = true;
    return this;
  }
  /**
   * @param {string} s
   * @returns {this}
   */
  setUnknownSystem(s) {
    this.unknownSystem = s;
    return this;
  }
  /**
   * @param {Issue | null | undefined} issue
   * @returns {this}
   */
  addIssue(issue) {
    if (issue) {
      this.issues.push(issue);
    }
    return this;
  }

  /**
   * @param {string} diagnostics
   * @returns {this}
   */
  withDiagnostics(diagnostics) {
    this.diagnostics = diagnostics;
    return this;
  }
}

class OperationOutcome {
  /** @type {FhirOperationOutcome} */
  jsonObj;

  /**
   * @param {FhirOperationOutcome | null} [jsonObj]
   */
  constructor (jsonObj = null) {
    this.jsonObj = jsonObj ? jsonObj : { "resourceType": "OperationOutcome" };
  }

  /**
   * @param {Issue} newIssue
   * @returns {boolean}
   */
  addIssueIfNew(newIssue) {
    return this.addIssue(newIssue, true);
  }

  /**
   * @param {Issue} newIssue
   * @param {boolean} [ifNotDuplicate]
   * @returns {boolean}
   */
  addIssue(newIssue, ifNotDuplicate = false) {
    validateParameter(newIssue, "newIssue", Object);
    if (ifNotDuplicate) {
      for (let iss of this.jsonObj.issue || []) {
        if (iss.details.text === newIssue.message) {
          return false;
        }
      }
    }
    if (!this.jsonObj.issue) {
      this.jsonObj.issue = [];
    }
    this.jsonObj.issue.push(newIssue.asIssue());
    for (let extra of newIssue.issues) {
      this.addIssue(extra, false);
    }
    return true;
  }

  /**
   * @returns {FhirOperationOutcomeIssue[] | undefined}
   */
  hasIssues() {
    return this.jsonObj && this.jsonObj.issue;
  }

  /**
   * @returns {boolean}
   */
  hasErrors() {
    for (let iss of this.jsonObj.issue || []) {
      if (iss.severity === 'error') {
        return true;
      }
    }
    return false;
  }

  /**
   * @param {string[]} list
   * @returns {number | undefined}
   */
  listMissedErrors(list) {
    for (let iss of this.jsonObj.issue || []) {
      if (iss.severity === 'error' && iss.details && iss.details.text && !list.find(msg => msg === iss.details.text )) {
        return list.push(iss.details.text);
      }
    }

  }
}

module.exports = { OperationOutcome, Issue };
