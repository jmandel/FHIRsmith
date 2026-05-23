// @ts-check

//
// Validate Worker - Handles $validate-code operations
//
// GET /CodeSystem/$validate-code?{params}
// POST /CodeSystem/$validate-code
// GET /CodeSystem/{id}/$validate-code?{params}
// POST /CodeSystem/{id}/$validate-code
// GET /ValueSet/$validate-code?{params}
// POST /ValueSet/$validate-code
// GET /ValueSet/{id}/$validate-code?{params}
// POST /ValueSet/{id}/$validate-code
//

const { TerminologyWorker } = require('./worker');
const {OperationOutcome, Issue} = require("../library/operation-outcome");
const {Parameters} = require("../library/parameters");
const {ValidateWorker} = require("./validate");
const {debugLog} = require("../operation-context");

class BatchValidateWorker extends TerminologyWorker {

  /** @type {Set<string>} */
  globalNames = new Set();

  /**
   * @param {any} opContext - Operation context
   * @param {any} log - Logger instance
   * @param {any} provider - Provider for code systems and resources
   * @param {any} languages - Language definitions
   * @param {any} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
    this.globalNames.add("tx-resource");
    this.globalNames.add("url");
    this.globalNames.add("valueSet");
    this.globalNames.add("lenient-display-validation");
    this.globalNames.add("__Accept-Language");
    this.globalNames.add("__Content-Language");
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'batch-validate-code';
  }

  /**
   * @param {any} req
   * @param {{json: (body: any) => any, status: (code: number) => {json: (body: any) => any}}} res
   * @returns {Promise<any>}
   */
  async handleValueSet(req, res) {
    try {
      let params = req.body;
      this.addHttpParams(req, params);

      /** @type {any[]} */
      let globalParams = [];
      for (const p of params.parameter) {
        if (this.globalNames.has(p.name)) {
          globalParams.push(p);
        }
      }

      /** @type {any[]} */
      let output = [];

      for (const p of params.parameter) {
        if (p.name == 'validation') {
          let op = new Parameters();
          op.jsonObj.parameter = [];
          for (const gp of globalParams) {
            let exists = p.resource.parameter.find(/** @param {any} pp */ pp => gp.name == pp.name);
            if (gp.name == 'tx-resource' || !exists) {
              op.jsonObj.parameter.push(gp);
            }
          }
          op.jsonObj.parameter.push(...p.resource.parameter);

          let worker = new ValidateWorker(this.opContext.copy(), this.log, this.provider, this.languages, this.i18n);
          try {
            let p;
            if (this.hasValueSet(op.jsonObj.parameter)) {
              p = await worker.handleValueSetInner(op.jsonObj);
            } else {
              p = await worker.handleCodeSystemInner(op.jsonObj);
            }
            output.push({name: "validation", resource : p});
          } catch (error) {
            this.log.error(error);
            debugLog(error);
            if (error instanceof Issue) {
              let op = new OperationOutcome();
              op.addIssue(error);
              output.push({name: "validation", resource : op.jsonObj});
            } else {
              const issueError = /** @type {{issueCode?: string, message?: string}} */ (error);
              output.push({name: "validation", resource : this.operationOutcome('error', issueError.issueCode || 'exception', issueError.message || String(error)) } );
            }
          }
        }
      }
      let result = { resourceType : "Parameters", parameter: output};
      req.logInfo = `${output.length} validations`;
      return res.json(result);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      const statusError = /** @type {{statusCode?: number, issueCode?: string, message?: string}} */ (error);
      return res.status(statusError.statusCode || 500).json(this.operationOutcome(
        'error', statusError.issueCode || 'exception', statusError.message || String(error)));
    }
  }

  /**
   * Build an OperationOutcome
   * @param {string} severity
   * @param {string} code
   * @param {string} message
   * @returns {any}
   */
  operationOutcome(severity, code, message) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{
        severity,
        code,
        details: {
          text: message
        },
        diagnostics: message
      }]
    };
  }

  /**
   * @param {any[]} parameter
   * @returns {any}
   */
  hasValueSet(parameter) {
    return parameter.find(/** @param {any} p */ p => p.name == 'url' || p.name == 'valueSet');
  }
}

module.exports = {
  BatchValidateWorker
};
