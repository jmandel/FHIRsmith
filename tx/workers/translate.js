//
// Translate Worker - Handles ConceptMap $translate operation
//
// GET /ConceptMap/$translate?{params}
// POST /ConceptMap/$translate
// GET /ConceptMap/{id}/$translate?{params}
// POST /ConceptMap/{id}/$translate
//
// @ts-check

const { TerminologyWorker } = require('./worker');
const { TxParameters } = require('../params');
const { Parameters } = require('../library/parameters');
const { Issue, OperationOutcome } = require('../library/operation-outcome');
const {ConceptMap} = require("../library/conceptmap");
const {debugLog} = require("../operation-context");

/** @typedef {{statusCode?: number, issueCode?: string, message?: string}} WorkerErrorLike */

class TranslateWorker extends TerminologyWorker {
  /**
   * @param {any} opContext - Operation context
   * @param {any} log - Logger instance
   * @param {any} provider - Provider for concept maps and resources
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
    return 'translate';
  }

  /**
   * Handle a type-level $translate request
   * GET/POST /ConceptMap/$translate
   * @param {any} req - Express request
   * @param {any} res - Express response
   */
  async handle(req, res) {
    try {
      await this.handleTypeLevelTranslate(req, res);
    } catch (error) {
      const workerError = /** @type {WorkerErrorLike} */ (error);
      this.log.error(error);
      debugLog(error);
      if (error instanceof Issue) {
        const oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        return res.status(workerError.statusCode || 500).json(this.operationOutcome(
          'error', workerError.issueCode || 'exception', workerError.message || String(error)));
      }
    }
  }

  /**
   * Handle an instance-level $translate request
   * GET/POST /ConceptMap/{id}/$translate
   * @param {any} req - Express request
   * @param {any} res - Express response
   */
  async handleInstance(req, res) {
    try {
      await this.handleInstanceLevelTranslate(req, res);
    } catch (error) {
      const workerError = /** @type {WorkerErrorLike} */ (error);
      this.log.error(error);
      debugLog(error);
      if (error instanceof Issue) {
        const oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        return res.status(workerError.statusCode || 500).json(this.operationOutcome(
          'error', workerError.issueCode || 'exception', workerError.message || String(error)));
      }
    }
  }

  /**
   * Handle type-level translate: /ConceptMap/$translate
   * ConceptMap identified by url+version params or from source/target
   * @param {any} req
   * @param {any} res
   */
  async handleTypeLevelTranslate(req, res) {
    this.deadCheck('translate-type-level');

    // Handle tx-resource and cache-id parameters from Parameters resource
    if (req.body && req.body.resourceType === 'Parameters') {
      this.setupAdditionalResources(req.body);
    }

    // Parse parameters from request
    const params = new Parameters(this.buildParameters(req));
    const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
    txp.readParams(params.jsonObj);

    // Extract required parameters per FHIR spec
    // url - canonical URL of the concept map (optional for type-level if source/target specified)
    // conceptMapVersion - version of the concept map
    // sourceCode / sourceCoding / sourceCodeableConcept - the code to translate
    // system - system of the code (if sourceCode used)
    // version - version of the code system
    // sourceScope - source value set scope
    // targetScope - target value set scope
    // targetSystem - target code system to translate to
    // dependency - additional dependencies for translation

    /** @type {any} */
    let coding = null;
    /** @type {any[]} */
    let conceptMaps = [];
    /** @type {any} */
    let targetScope = null;
    /** @type {any} */
    let sourceScope = null;
    /** @type {any} */
    let targetSystem = null;
    let reverse = false;

    // Get the source coding
    // Accept both R5 names (sourceCoding, sourceCodeableConcept, sourceCode/sourceSystem)
    // and R4 names (coding, codeableConcept, code/system) as aliases
    if (params.has('sourceCoding')) {
      coding = params.get('sourceCoding');
    } else if (params.has('coding')) {
      coding = params.get('coding');
    } else if (params.has('sourceCodeableConcept')) {
      const cc = /** @type {any} */ (params.get('sourceCodeableConcept'));
      if (cc.coding && cc.coding.length > 0) {
        coding = cc.coding[0]; // Use first coding
      } else {
        throw new Issue('error', 'invalid', null, null,
          'sourceCodeableConcept must contain at least one coding', null, 400);
      }
    } else if (params.has('codeableConcept')) {
      const cc = /** @type {any} */ (params.get('codeableConcept'));
      if (cc.coding && cc.coding.length > 0) {
        coding = cc.coding[0];
      } else {
        throw new Issue('error', 'invalid', null, null,
          'codeableConcept must contain at least one coding', null, 400);
      }
    } else if (params.has('sourceCode') || params.has('code')) {
      const code = params.has('sourceCode') ? params.get('sourceCode') : params.get('code');
      const system = params.has('sourceSystem') ? params.get('sourceSystem') : params.get('system');
      if (!system) {
        throw new Issue('error', 'invalid', null, null,
          'system parameter is required when using code/sourceCode', null, 400);
      }
      const version = params.has('sourceVersion') ? params.get('sourceVersion') : params.get('version');
      coding = {system, version, code};
    } else if (params.has('targetCoding')) {
      reverse = true;
      coding = params.get('targetCoding');
    } else if (params.has('targetCodeableConcept')) {
      reverse = true;
      const cc = /** @type {any} */ (params.get('targetCodeableConcept'));
      if (cc.coding && cc.coding.length > 0) {
        coding = cc.coding[0]; // Use first coding
      } else {
        throw new Issue('error', 'invalid', null, null,
          'sourceCodeableConcept must contain at least one coding', null, 400);
      }
    } else if (params.has('targetCode')) {
      reverse = true;
      const code = params.get('targetCode');
      const system = params.get('targetSystem');
      if (!system) {
        throw new Issue('error', 'invalid', null, null,
          'targetSystem parameter is required when using targetCode', null, 400);
      }
      const version = params.get('targetVersion');
      coding = { system, version, code };
    } else {
      throw new Issue('error', 'invalid', null, null,
        'Must provide sourceCode+(source)system, sourceCoding, or sourceCodeableConcept, or targetCode+targetSystem), targetCoding, or targetCodeableConcept', null, 400);
    }

    // Get the concept map
    if (params.has('url')) {
      const url = params.get('url');
      const cmVersion = params.get('conceptMapVersion');
      let conceptMap = await this.provider.findConceptMap(this.opContext, url, cmVersion);
      if (!conceptMap) {
        const msg = cmVersion
          ? `ConceptMap not found: ${url} version ${cmVersion}`
          : `ConceptMap not found: ${url}`;
        throw new Issue('error', 'not-found', null, null, msg, null, 404);
      } else {
        conceptMaps.push(conceptMap);
      }
    }

    // Get scope parameters
    if (params.has('sourceScope')) {
      sourceScope = params.get('sourceScope');
    }
    if (params.has('targetScope')) {
      targetScope = params.get('targetScope');
    }
    if (reverse) {
      if (params.has('sourceSystem')) {
        targetSystem = params.get('sourceSystem');
      }
    } else {
      if (params.has('targetSystem')) {
        targetSystem = params.get('targetSystem');
      }
    }
    let explicit = true;
    // If no explicit concept map, we need to find one based on source/target
    if (conceptMaps.length == 0) {
      explicit = false;
      if (reverse) {
        await this.findConceptMapsInAdditionalResources(conceptMaps,targetSystem, targetScope, sourceScope, coding.system);
        await this.provider.findConceptMapForTranslation(this.opContext, conceptMaps, targetSystem, targetScope, sourceScope, coding.system, coding.code);
      } else {
        await this.findConceptMapsInAdditionalResources(conceptMaps, coding.system, sourceScope, targetScope, targetSystem);
        await this.provider.findConceptMapForTranslation(this.opContext, conceptMaps, coding.system, sourceScope, targetScope, targetSystem, coding.code);
      }
      if (conceptMaps.length == 0) {
        throw new Issue('error', 'not-found', null, null, 'No suitable ConceptMaps found for the specified source and target', null, 404);
      }
    }

    // Perform the translation
    const result = await this.doTranslate(conceptMaps, coding, targetScope, targetSystem, txp, reverse, explicit);
    return res.status(200).json(result);
  }

  /**
   * Handle instance-level translate: /ConceptMap/{id}/$translate
   * ConceptMap identified by resource ID
   * @param {any} req
   * @param {any} res
   */
  async handleInstanceLevelTranslate(req, res) {
    this.deadCheck('translate-instance-level');

    const { id } = req.params;

    // Find the ConceptMap by ID
    const conceptMap = await this.provider.getConceptMapById(this.opContext, id);

    if (!conceptMap) {
      throw new Issue('error', 'not-found', null, null,
        `ConceptMap/${id} not found`, null, 404);
    }

    // Handle tx-resource and cache-id parameters from Parameters resource
    if (req.body && req.body.resourceType === 'Parameters') {
      this.setupAdditionalResources(req.body);
    }

    // Parse parameters from request
    const params = new Parameters(this.buildParameters(req));
    const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
    txp.readParams(params.jsonObj);

    // Get the source coding
    // Accept both R5 names (sourceCoding, sourceCodeableConcept, sourceCode)
    // and R4 names (coding, codeableConcept, code) as aliases
    /** @type {any} */
    let coding = null;

    if (params.has('sourceCoding')) {
      coding = params.get('sourceCoding');
    } else if (params.has('coding')) {
      coding = params.get('coding');
    } else if (params.has('sourceCodeableConcept')) {
      const cc = /** @type {any} */ (params.get('sourceCodeableConcept'));
      if (cc.coding && cc.coding.length > 0) {
        coding = cc.coding[0];
      } else {
        throw new Issue('error', 'invalid', null, null,
          'sourceCodeableConcept must contain at least one coding', null, 400);
      }
    } else if (params.has('codeableConcept')) {
      const cc = /** @type {any} */ (params.get('codeableConcept'));
      if (cc.coding && cc.coding.length > 0) {
        coding = cc.coding[0];
      } else {
        throw new Issue('error', 'invalid', null, null,
          'codeableConcept must contain at least one coding', null, 400);
      }
    } else if (params.has('sourceCode') || params.has('code')) {
      const code = params.has('sourceCode') ? params.get('sourceCode') : params.get('code');
      const system = params.has('system') ? params.get('system') : null;
      if (!system) {
        throw new Issue('error', 'invalid', null, null,
          'system parameter is required when using code/sourceCode', null, 400);
      }
      coding = {
        system,
        version: params.get('version'),
        code
      };
    } else {
      throw new Issue('error', 'invalid', null, null,
        'Must provide sourceCode (with system), sourceCoding, or sourceCodeableConcept', null, 400);
    }

    // Get optional scope/target parameters
    const targetScope = params.has('targetScope') ? params.get('targetScope') : null;
    const targetSystem = params.has('targetSystem') ? params.get('targetSystem') : null;

    /** @type {any[]} */
    let conceptMaps = [];
    conceptMaps.push(conceptMap);

    // Perform the translation
    const result = await this.doTranslate(conceptMaps, coding, targetScope, targetSystem, params);
    return res.status(200).json(result);
  }


  /**
   * @param {any} op
   * @param {any} langList
   * @param {string} path
   * @param {string} code
   * @param {string} system
   * @param {string | null | undefined} version
   * @param {string | null | undefined} display
   */
  checkCode(op, langList, path, code, system, version, display) {
    let result = false;
    const findCodeSystem = /** @type {any} */ (this.findCodeSystem.bind(this));
    const cp = findCodeSystem(system, version, null, ['complete', 'fragment'], true, true, false, null, /** @type {any} */ (this).requiredSupplements);
    if (cp != null) {
      const lct = cp.locate(this.opContext, code);
      if (op.error('InstanceValidator', 'invalid', path, lct != null, 'Unknown Code (' + system + '#' + code + ')')) {
        result = op.warning('InstanceValidator', 'invalid', path,
          (!display) || (display === cp.display(this.opContext, lct, null)),
          'Display for ' + system + ' code "' + code + '" should be "' + cp.display(this.opContext, lct, null) + '"');
      }
    }
    return result;
  }

  /**
   * @param {any} cm
   * @param {any} coding
   * @param {any} targetScope
   * @param {any} targetSystem
   * @param {any} params
   * @param {any[]} output
   * @param {boolean} explicit
   */
  translateUsingGroupsForwards(cm, coding, targetScope, targetSystem, params, output, explicit) {
    let result = false;
    const matches = cm.listTranslations(coding, targetScope, targetSystem);
    if (matches.length > 0) {
      for (let match of matches) {
        const g = match.group;
        const em = match.match;
        for (const map of em.target || []) {
          let ok = false;
          if (map.equivalence) { // R4 mode
            ok = ['null', 'relatedto', 'equivalent', 'equal', 'wider', 'subsumes', 'narrower', 'specializes', 'inexact'].includes(map.equivalence);
          } else {
            ok = ['null', 'related-to', 'equivalent',  'source-is-narrower-than-target', 'source-is-broader-than-target'].includes(map.relationship);
          }
          if (ok) {
            result = true;

            const outcome = {
              system: g.target,
              code: map.code
            };

            if (!this.hasMatch(output, outcome)) {
              /** @type {any[]} */
              const matchParts = [];
              matchParts.push({
                name: 'concept',
                valueCoding: outcome
              });
              matchParts.push({
                name: 'relationship',
                valueCode: map.relationship
              });
              // equivalence vs relationship will be sorted out in the version transform for parameters
              if (map.equivalence) {
                matchParts.push({
                  name: 'equivalence',
                  valueCode: map.equivalence
                });
              }
              if (map.comment) {
                matchParts.push({
                  name: 'message',
                  valueString: map.comment
                });
              }
              for (const prod of map.product || []) {
                /** @type {any[]} */
                const productParts = [];
                productParts.push({
                  name: 'element',
                  valueString: prod.property
                });
                productParts.push({
                  name: 'concept',
                  valueCoding: {
                    system: prod.system,
                    code: prod.value
                  }
                });
                matchParts.push({
                  name: 'product',
                  part: productParts
                });
              }
              if (!explicit) {
                matchParts.push({
                  name: 'originMap',
                  valueCanonical: cm.vurl
                });
              }
              output.push({
                name: 'match',
                part: matchParts
              });
            }
          }
        }
      }
    }
    return result;
  }

  /**
   * @param {any} cm
   * @param {any} coding
   * @param {any} targetScope
   * @param {any} targetSystem
   * @param {any} params
   * @param {any[]} output
   */
  translateUsingGroupsReverse(cm, coding, targetScope, targetSystem, params, output) {
    let result = false;
    const matches = cm.listTranslationsReverse(coding, targetScope, targetSystem);
    if (matches.length > 0) {
      for (let match of matches) {
        const g = match.group;
        const em = match.match;
        const map = match.target;
        let ok = false;
        if (map.equivalence) { // R4 mode
          ok = ['null', 'relatedto', 'equivalent', 'equal', 'wider', 'subsumes', 'narrower', 'specializes', 'inexact'].includes(map.equivalence);
        } else {
          ok = ['null', 'related-to', 'equivalent',  'source-is-narrower-than-target', 'source-is-broader-than-target'].includes(map.relationship);
        }
        if (ok) {
          result = true;

          const outcome = {
            system: g.source,
            code: em.code
          };
          const t = {
            system: g.target,
            code: coding.code
          };

          if (!this.hasMatch(output, outcome)) {
            /** @type {any[]} */
            const matchParts = [];
            matchParts.push({
              name: 'concept',
              valueCoding: t
            });
            matchParts.push({
              name: 'relationship',
              valueCode: map.relationship
            });
            // equivalence vs relationship will be sorted out in the version transform for parameters
            if (map.equivalence) {
              matchParts.push({
                name: 'equivalence',
                valueCode: map.equivalence
              });
            }
            if (map.comment) {
              matchParts.push({
                name: 'message',
                valueString: map.comment
              });
            }
            for (const prod of map.product || []) {
              /** @type {any[]} */
              const productParts = [];
              productParts.push({
                name: 'element',
                valueString: prod.property
              });
              productParts.push({
                name: 'concept',
                valueCoding: {
                  system: prod.system,
                  code: prod.value
                }
              });
              matchParts.push({
                name: 'product',
                part: productParts
              });
            }
            matchParts.push({
              name: 'source',
              valueCoding: outcome
            });
            output.push({
              name: 'match',
              part: matchParts
            });
          }
        }
      }
    }
    return result;
  }

  /**
   * @param {any} cm
   * @param {any} coding
   * @param {any} target
   * @param {any} params
   * @param {any[]} output
   * @param {boolean} reverse
   * @param {boolean} explicit
   */
  async translateUsingCodeSystem(cm, coding, target, params, output, reverse, explicit) {
    let result = false;
    const factory = cm.jsonObj.internalSource;
    let prov = await factory.build(this.opContext, []);
    this.opContext.registerProvider(prov);

    output.push({
      name: 'used-system',
      valueUri: prov.system() + '|' + prov.version()
    });

    let translations = await prov.getTranslations(cm, coding, target, reverse);

    if (translations.length > 0) {
      result = true;

      for (const t of translations) {
        if (t.map) {
          output.push({
            name: 'used-conceptmap',
            valueUri: t.map
          });
        }

        const outcome = {
          system: t.system,
          code: t.code,
          version: t.version,
          display: t.display
        };

        /** @type {any[]} */
        const matchParts = [];
        matchParts.push({
          name: 'concept',
          valueCoding: outcome
        });
        matchParts.push({
          name: 'relationship',
          valueCode: t.relationship
        });
        if (t.message) {
          matchParts.push({
            name: 'message',
            valueString: t.message
          });
        }
        if (!explicit) {
          matchParts.push({
            name: 'originMap',
            valueCanonical: cm.vurl
          });
        }
        output.push({
          name: 'match',
          part: matchParts
        });
      }
    }
    return result;
  }

  /**
   * Perform the actual translate operation
   * @param {any[]} conceptMaps - ConceptMap resources
   * @param {any} coding - Source coding to translate
   * @param {any} targetScope - Target value set scope (optional)
   * @param {any} targetSystem - Target code system (optional)
   * @param {any} params - Full parameters object
   * @param {boolean} [reverse] - Full parameters object*
   * @param {boolean} [explicit] - If the concept map was named explicitly
   * @returns {Promise<any>} Parameters resource with translate result
   */
  async doTranslate(conceptMaps, coding, targetScope, targetSystem, params, reverse, explicit) {
    this.deadCheck('doTranslate');

    /** @type {any[]} */
    const result = [];

    try {
      let added = false;
      const useReverse = !!reverse;
      const useExplicit = !!explicit;
      for (const cm of conceptMaps) {
        if (cm.jsonObj.internalSource) {
          added = await this.translateUsingCodeSystem(cm, coding, targetSystem, params, result, useReverse, useExplicit) || added;
        } else if (useReverse) {
          added = this.translateUsingGroupsReverse(cm, coding, targetScope, targetSystem, params, result) || added;
        } else{
          added = this.translateUsingGroupsForwards(cm, coding, targetScope, targetSystem, params, result, useExplicit) || added;
        }
      }
      result.push({
        name: 'result',
        valueBoolean: added
      });
      if (!added) {
        result.push({
          name: 'message',
          valueString: 'No translations found'
        });
      }
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      result.push({
        name: 'result',
        valueBoolean: false
      });
      result.push({
        name: 'message',
        valueString: error instanceof Error ? error.message : String(error)
      });
    }

    return {
      resourceType: 'Parameters',
      parameter: result
    };
  }

  /**
   * @param {any} cm
   * @param {any} vs
   */
  // eslint-disable-next-line no-unused-vars
  isOkTarget(cm, vs) {
    // if cm.target != null then
    //   result := cm.target.url = vs.url
    // else
    return false;
    // todo: or it might be ok to use this value set if it's a subset of the specified one?
  }

  // isOkSourceWithValueSet(cm, vs, coding) {
  //   let result = { found: false, group: null, match: null };
  //
  //   if (true /* (vs == null) || ((cm.source != null) && (cm.source.url === vs.url)) */) {
  //     for (const g of cm.groups || []) {
  //       for (const em of g.elements || []) {
  //         if ((g.source === coding.system) && (em.code === coding.code)) {
  //           result = {
  //             found: true,
  //             group: g,
  //             match: em
  //           };
  //         }
  //       }
  //     }
  //   }
  //   return result;
  // }


  /**
   * @param {any} cm
   */
  findConceptMap(cm) {
    let msg = '';
    if (cm != null) {
      return { found: true, message: msg };
    } else {
      return { found: false, message: msg };
    }
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
        diagnostics: message
      }]
    };
  }

  /**
   * @param {any[]} conceptMaps
   * @param {any} system
   * @param {any} sourceScope
   * @param {any} targetScope
   * @param {any} targetSystem
   */
  async findConceptMapsInAdditionalResources(conceptMaps, system, sourceScope, targetScope, targetSystem) {
    for (let res of this.additionalResources || []) {
      if (res instanceof ConceptMap) {
        if (res.providesTranslation(system, sourceScope, targetScope, targetSystem)) {
          conceptMaps.push(res);
        }
      }
    }
  }

  /**
   * @param {any[]} output
   * @param {any} outcome
   */
  hasMatch(output, outcome) {
    for (let o of output) {
      let c = o.part.find((/** @type {any} */ x) => x.name === 'concept');
      if (c.valueCoding.code === outcome.code && c.valueCoding.system === outcome.system) {
        return true;
      }
    }
    return false;
  }
}

module.exports = TranslateWorker;
