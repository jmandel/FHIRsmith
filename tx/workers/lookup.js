//
// Lookup Worker - Handles CodeSystem $lookup operation
//
// GET /CodeSystem/$lookup?{params}
// POST /CodeSystem/$lookup
// GET /CodeSystem/{id}/$lookup?{params}
// POST /CodeSystem/{id}/$lookup
//
// @ts-check

const { TerminologyWorker } = require('./worker');
const { FhirCodeSystemProvider } = require('../cs/cs-cs');
const { Designations} = require("../library/designations");
const {TxParameters} = require("../params");
const {Parameters} = require("../library/parameters");
const {Issue, OperationOutcome} = require("../library/operation-outcome");
const {debugLog} = require("../operation-context");

/** @typedef {{system?: string, version?: string, code?: string}} CodingLike */
/** @typedef {{statusCode?: number, issueCode?: string, msgId?: string, className?: string, message?: string}} WorkerErrorLike */

class LookupWorker extends TerminologyWorker {
  /**
   * @param {any} opContext - Operation context
   * @param {any} log - Logger instance
   * @param {any} provider - Provider for code systems and resources
   * @param {any} languages - Language definitions
   * @param {any} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'lookup';
  }

  /**
   * Static factory method to handle type-level lookup from Express
   * GET/POST /CodeSystem/$lookup
   * @param {any} req - Express request
   * @param {any} res - Express response
   */
  async handle(req, res) {
    try {
      await this.handleTypeLevelLookup(req, res);
    } catch (error) {
      const workerError = /** @type {WorkerErrorLike} */ (error);
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(workerError.msgId  ? " "+workerError.msgId : "");
      const statusCode = workerError.statusCode || 500;
      const issueCode = workerError.issueCode || 'exception';
      return res.status(statusCode).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: issueCode,
          diagnostics: workerError.message || String(error)
        }]
      });
    }
  }

  /**
   * Static factory method to handle instance-level lookup from Express
   * GET/POST /CodeSystem/{id}/$lookup
   * @param {any} req - Express request
   * @param {any} res - Express response
   */
  async handleInstance(req, res) {

    try {
      await this.handleInstanceLevelLookup(req, res);
    } catch (error) {
      const workerError = /** @type {WorkerErrorLike} */ (error);
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(workerError.msgId  ? " "+workerError.msgId : "");
      const issueCode = workerError.issueCode || 'exception';
      return res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: issueCode,
          diagnostics: workerError.message || String(error)
        }]
      });
    }
  }

  /**
   * Handle type-level lookup: /CodeSystem/$lookup
   * CodeSystem identified by system+version params or coding parameter
   * @param {any} req
   * @param {any} res
   */
  async handleTypeLevelLookup(req, res) {
    try {
      this.deadCheck('lookup-type-level');

      // Handle tx-resource and cache-id parameters from Parameters resource
      if (req.body && req.body.resourceType === 'Parameters') {
        this.setupAdditionalResources(req.body);
      }

      // Parse parameters from request
      const params = new Parameters(this.buildParameters(req));
      const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
      txp.readParams(params.jsonObj);

      // Determine how the code system is identified
      let csProvider;
      /** @type {string} */
      let code;

      if (params.has('coding')) {
        // Coding parameter provided - extract system, version, code
        const coding = /** @type {CodingLike} */ (params.get('coding'));
        if (!coding.system) {
          return res.status(400).json(this.operationOutcome('error', 'invalid',
            'Coding parameter must include a system'));
        }
        if (!coding.code) {
          return res.status(400).json(this.operationOutcome('error', 'invalid',
            'Coding parameter must include a code'));
        }

        // Allow complete or fragment content modes, nullOk = true to handle not-found ourselves
        csProvider = await this.findCodeSystem(coding.system, coding.version || '', txp, ['complete', 'fragment'], true);
        this.seeSourceProvider(csProvider, coding.system);
        code = coding.code;

      } else if (params.has('system') && params.has('code')) {
        // system + code parameters
        const system = String(params.get('system'));
        const version = params.get('version') ? String(params.get('version')) : '';
        csProvider = await this.findCodeSystem(system, version, txp, ['complete', 'fragment'],
          null, true, false, false, txp.supplements);
        this.seeSourceProvider(csProvider, system);
        code = /** @type {string} */ (params.get('code'));

      } else {
        return res.status(400).json(this.operationOutcome('error', 'invalid',
          'Must provide either coding parameter, or system and code parameters'));
      }

      if (!csProvider) {
        const parameterSource = /** @type {any} */ (params);
        const systemUrl = parameterSource.system || parameterSource.coding?.system;
        const versionStr = parameterSource.version || parameterSource.coding?.version;
        const msg = versionStr
          ? `CodeSystem not found: ${systemUrl} version ${versionStr}`
          : `CodeSystem not found: ${systemUrl}`;
        return res.status(422).json(this.operationOutcome('error', 'not-found', msg));
      }

      // check supplements
      const used = new Set();
      const reported = new Set();
      this.checkSupplements(csProvider, /** @type {any} */ (null), txp.supplements, /** @type {any} */ (used), /** @type {any} */ (reported));
      const unused = new Set([...txp.supplements].filter(s => !used.has(s)));
      if (unused.size > 0) {
        throw new Issue('error', 'not-found', null, 'VALUESET_SUPPLEMENT_MISSING', this.i18n.translatePlural(unused.size, 'VALUESET_SUPPLEMENT_MISSING', txp.HTTPLanguages, [[...unused].join(',')]), 'not-found').handleAsOO(400);
      }

      // Perform the lookup
      const result = await this.doLookup(csProvider, code, txp, reported);
      return res.status(200).json(result);
    } catch (error) {
      const workerError = /** @type {WorkerErrorLike} */ (error);
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(workerError.msgId  ? " "+workerError.msgId : "");
      if (error instanceof Issue) {
        let oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        return res.status(workerError.statusCode || 500).json(this.operationOutcome(
          'error', workerError.issueCode || 'exception', workerError.message || String(error)));
      }
    }
  }

  /**
   * Handle instance-level lookup: /CodeSystem/{id}/$lookup
   * CodeSystem identified by resource ID
   * @param {any} req
   * @param {any} res
   */
  async handleInstanceLevelLookup(req, res) {
    try {
      this.deadCheck('lookup-instance-level');

      const {id} = req.params;

      // Find the CodeSystem by ID
      let codeSystem = this.provider.getCodeSystemById(this.opContext, id);
      this.seeSourceProvider(codeSystem, id);

      if (!codeSystem) {
        return res.status(404).json(this.operationOutcome('error', 'not-found',
          `CodeSystem/${id} not found`));
      }

      // Handle tx-resource and cache-id parameters from Parameters resource
      if (req.body && req.body.resourceType === 'Parameters') {
        this.setupAdditionalResources(req.body);
      }

      // Parse parameters from request
      const params = new Parameters(this.buildParameters(req));
      const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
      txp.readParams(params.jsonObj);

      // For instance-level, code is required (system/version come from the resource)
      /** @type {string} */
      let code;
      if (params.has('coding')) {
        code = /** @type {string} */ ((/** @type {CodingLike} */ (params.get('coding'))).code);
      } else if (params.has('code')) {
        code = /** @type {string} */ (params.get('code'));
      } else {
        return res.status(400).json(this.operationOutcome('error', 'invalid',
          'Must provide code parameter or coding parameter with code'));
      }

      // Load any supplements
      const supplements = this.loadSupplements(codeSystem.url, codeSystem.version, txp.supplements);

      // Create a FhirCodeSystemProvider for this CodeSystem
      const csProvider = new FhirCodeSystemProvider(this.opContext, codeSystem, supplements);

      // Perform the lookup
      const result = await this.doLookup(csProvider, code, txp);
      return res.status(200).json(result);
    } catch (error) {
      const workerError = /** @type {WorkerErrorLike} */ (error);
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(workerError.msgId  ? " "+workerError.msgId : "");
      if (error instanceof Issue) {
        let oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        return res.status(workerError.statusCode || 500).json(this.operationOutcome(
          'error', workerError.issueCode || 'exception', workerError.message || String(error)));
      }
    }
  }

  /**
   * Perform the actual lookup operation
   * @param {any} csProvider - CodeSystem provider
   * @param {string} code - Code to look up
   * @param {any} params - Parsed parameters
   * @param {Set<any>} [reportedSupplements] - Set of supplements that are to be reported
   * @returns {Promise<any>} Parameters resource with lookup result
   */
  async doLookup(csProvider, code, params, reportedSupplements) {
    this.deadCheck('doLookup');

    await this.checkSupplements(csProvider, /** @type {any} */ (null), params.supplements);

    // Helper to check if a property should be included
    /**
     * @param {string} name
     * @param {boolean} [defaultValue]
     */
    const hasProp = (name, defaultValue = true) => {
      if (!params.properties || params.properties.length === 0) {
        return defaultValue;
      }
      const lowerName = name.toLowerCase();
      return params.properties.some((/** @type {string} */ p) =>
        p.toLowerCase() === lowerName || p === '*'
      );
    };

    // Locate the code in the code system
    const locateResult = await csProvider.locate(code);

    if (!locateResult || !locateResult.context) {
      let message = `Unable to find code '${code}' in ${csProvider.system()} version ${csProvider.version() || 'unknown'}`
      if (locateResult?.message) {
        message += ' ('+locateResult.message+')';
      }
      throw new Issue('error', 'not-found', null, null, message, null, 404);
    }

    const ctxt = locateResult.context;

    // Build the response parameters
    /** @type {any[]} */
    const responseParams = [];

    // name (required)
    responseParams.push({
      name: 'name',
      valueString: csProvider.name()
    });
    responseParams.push({
      name: 'code',
      valueCode: code
    });

    responseParams.push({
      name: 'system',
      valueUri: csProvider.system()
    });

    // version (optional)
    const version = csProvider.version();
    if (version) {
      responseParams.push({
        name: 'version',
        valueString: version
      });
    }

    // display (required)
    const display = await csProvider.display(ctxt);
    const designations = new Designations(this.languages);
    await csProvider.designations(ctxt, designations);
    const pd = designations.preferredDesignation(params.workingLanguages());
    const disp = pd ? pd.value : undefined;
    responseParams.push({
      name: 'display',
      valueString: disp || display || code
    });

    // definition (optional) - top-level parameter
    if (hasProp('definition', true)) {
      const definition = await csProvider.definition(ctxt);
      if (definition) {
        responseParams.push({
          name: 'definition',
          valueString: definition
        });
      }
    }

    // abstract property (optional)
    if (hasProp('abstract', true)) {
      const isAbstract = await csProvider.isAbstract(ctxt);
      responseParams.push({
        name: 'abstract',
        valueBoolean: isAbstract
      });
    }

    // inactive property (optional)
    if (hasProp('inactive', true)) {
      const isInactive = await csProvider.isInactive(ctxt);
      responseParams.push({
        name: 'property',
        part: [
          { name: 'code', valueCode: 'inactive' },
          { name: 'value', valueBoolean: isInactive }
        ]
      });
    }

    // designations (optional)
    if (hasProp('designation', true)) {
      let designations = new Designations(this.languages);
      await csProvider.designations(ctxt, designations);
      if (designations && Array.isArray(designations.designations)) {
        for (const designation of designations.designations) {
          this.deadCheck('doLookup-designations');
          /** @type {any[]} */
          const designationParts = [];

          if (designation.supplement) {
            designationParts.push({
              name: 'source',
              valueCanonical: designation.supplement.vurl
            });
          }
          if (designation.language) {
            designationParts.push({
              name: 'language',
              valueCode: designation.language.code
            });
          }

          if (designation.use) {
            designationParts.push({
              name: 'use',
              valueCoding: designation.use
            });
          }

          designationParts.push({
            name: 'value',
            valueString: designation.value
          });

          responseParams.push({
            name: 'designation',
            part: designationParts
          });
        }
      }
    }

    // Let the provider add additional properties
    await csProvider.extendLookup(ctxt, params.properties || [], responseParams);

    if (reportedSupplements) {
      for (const supplement of reportedSupplements) {
        responseParams.push({
          name: 'used-supplement',
          valueCanonical: supplement
        });
      }
    }
    return {
      resourceType: 'Parameters',
      parameter: responseParams
    };
  }

  /**
   * Add a property to the response parameters
   * @param {any[]} responseParams - Response parameters array
   * @param {string} code - Property code
   * @param {*} value - Property value
   * @param {string} valueType - FHIR value type (e.g., 'valueString', 'valueBoolean')
   */
  addProperty(responseParams, code, value, valueType) {
    responseParams.push({
      name: 'property',
      part: [
        { name: 'code', valueCode: code },
        { name: 'value', [valueType]: value }
      ]
    });
  }

  /**
   * Build an OperationOutcome
   * @param {string} severity - error, warning, information
   * @param {string} code - Issue code
   * @param {string} message - Diagnostic message
   * @returns {any} OperationOutcome resource
   */
  operationOutcome(severity, code, message) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{
        severity,
        code,
        details: {text : message}
      }]
    };
  }
}

module.exports = LookupWorker;
