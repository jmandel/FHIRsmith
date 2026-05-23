// @ts-check

//
// Read Worker - Handles resource read operations
//
// GET /{type}/{id}
//

const { TerminologyWorker } = require('./worker');
const {debugLog} = require("../operation-context");

class ReadWorker extends TerminologyWorker {
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
    return 'read';
  }
  /**
   * Handle a read request
   * @param {any} req - Express request (with txProvider attached)
   * @param {{json: (body: any) => any, status: (code: number) => {json: (body: any) => any}}} res - Express response
   * @param {string} resourceType - The resource type (CodeSystem, ValueSet, ConceptMap)
   * @returns {Promise<any>}
   */
  async handle(req, res, resourceType) {
    const { id } = req.params;

    this.log.debug(`Read ${resourceType}/${id}`);

    try {
      switch (resourceType) {
        case 'CodeSystem':
          return await this.handleCodeSystem(req, res, id);

        case 'ValueSet':
          return await this.handleValueSet(req, res, id);

        case 'ConceptMap':
          return await this.handleConceptMap(req, res, id);

        default:
          return res.status(404).json({
            resourceType: 'OperationOutcome',
            issue: [{
              severity: 'error',
              code: 'not-found',
              diagnostics: `Unknown resource type: ${resourceType}`
            }]
          });
      }
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      const readError = /** @type {{msgId?: string, message?: string}} */ (error);
      req.logInfo = this.usedSources.join("|")+" - error"+(readError.msgId  ? " "+readError.msgId : "");
      return res.status(500).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'exception',
          diagnostics: readError.message || String(error)
        }]
      });
    }
  }

  /**
   * Handle CodeSystem read
   * @param {any} req
   * @param {{json: (body: any) => any, status: (code: number) => {json: (body: any) => any}}} res
   * @param {string} id
   * @returns {Promise<any>}
   */
  async handleCodeSystem(req, res, id) {
    let cs = this.provider.getCodeSystemById(this.opContext, id);
    if (cs != null) {
      req.sourcePackage = cs.sourcePackage;
      return res.json(cs.jsonObj);
    }

    if (id.startsWith("x-")) {
      cs = this.provider.getCodeSystemFactoryById(this.opContext, id.substring(2));
      if (cs != null) {
        /** @type {any} */
        let json = {
          resourceType: "CodeSystem",
          id: "x-" + cs.id(),
          url: cs.system(),
          version: cs.version(),
          name: cs.name(),
          status: "active",
          description: "This is a place holder for the code system which is fully supported through internal means (not by this code system)",
          content: "not-present"
        }
        if (cs.webSource()) {
          json.extension = [{ url: "http://hl7.org/fhir/StructureDefinition/web-source", valueUrl : cs.webSource()}];
        }
        if (cs.version()) {
          json.version = cs.version();
        }
        if (cs.iteratable()) {
          json.content =  "complete",
          json.concept = [];
          let csp = cs.build(this.opContext, []);
          let iter = await csp.iteratorAll();
          let c = await csp.nextContext(iter);
          while (c) {
            /** @type {any} */
            let cc = {
              code: await csp.code(c),
              display: await csp.display(c)
            }
            let def = await csp.definition(c);
            if (def) {
              cc.definition = def;
            }
            json.concept.push(cc);
            c = await csp.nextContext(iter);
          }

        }
        return res.json(json);
      }
    }

    return res.status(404).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: 'not-found',
        diagnostics: `CodeSystem/${id} not found`
      }]
    });
  }

  /**
   * Handle ValueSet read
   * @param {any} req
   * @param {{json: (body: any) => any, status: (code: number) => {json: (body: any) => any}}} res
   * @param {string} id
   * @returns {Promise<any>}
   */
  async handleValueSet(req, res, id) {
    // Iterate through valueSetProviders in order
    for (const vsp of this.provider.valueSetProviders) {
      this.deadCheck('handleValueSet-loop');
      const vs = await vsp.fetchValueSetById(id);
      if (vs) {
        req.sourcePackage = vs.sourcePackage;
        return res.json(vs.jsonObj);
      }
    }

    return res.status(404).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: 'not-found',
        diagnostics: `ValueSet/${id} not found`
      }]
    });
  }
  /**
   * Handle ConceptMap read
   * @param {any} req
   * @param {{json: (body: any) => any, status: (code: number) => {json: (body: any) => any}}} res
   * @param {string} id
   * @returns {Promise<any>}
   */
  async handleConceptMap(req, res, id) {
    // Iterate through valueSetProviders in order
    for (const cmsp of this.provider.conceptMapProviders) {
      this.deadCheck('handleConceptMap-loop');
      const cm = await cmsp.fetchConceptMapById(id);
      if (cm) {
        req.sourcePackage = cm.sourcePackage;
        return res.json(cm.jsonObj);
      }
    }

    return res.status(404).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: 'not-found',
        diagnostics: `ValueSet/${id} not found`
      }]
    });
  }
}

module.exports = ReadWorker;
