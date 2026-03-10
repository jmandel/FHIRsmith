'use strict';

const { Extensions } = require('../library/extensions');
const { getValuePrimitive } = require('../../library/utilities');
const { TxParameters } = require('../params');
const {
  ValidateWorker,
  ValueSetChecker,
} = require('./validate');
const { prepareIRPlan, countFromIR } = require('../engine/ir-expansion-plan');
const { executeIRExpansionPage, resolveIRExecutionScopes } = require('../engine/ir-expansion-execution');
const { mapIR } = require('../engine/ir-traversal');
const { optimize } = require('../engine/rewrite');
const { trace } = require('../engine/expand-trace');
const { Issue } = require('../library/operation-outcome');
const { withResponseTrace } = require('./ir-worker-trace');

function addCodeConstraint(node, code) {
  return mapIR(node, (current) => {
    if (current.kind !== 'selector') return current;
    const nextCodes = new Set([...(current.intersectCodes || []), String(code)]);
    return { ...current, intersectCodes: [...nextCodes] };
  });
}

function valueSetLabel(vs) {
  return vs?.vurl || vs?.url || vs?.jsonObj?.url || '';
}

class IRValueSetChecker extends ValueSetChecker {
  async prepareConceptSet(desc, cc) {
    this.worker.deadCheck('prepareConceptSet:ir');
    Extensions.checkNoModifiers(cc, 'IRValueSetChecker.prepare', desc);
    this.worker.opContext.addNote(this.valueSet, 'Prepare ' + desc + ': "' + this.worker.renderer.displayValueSetInclude(cc) + '"', this.indentCount);
    if (cc.valueSet) {
      for (const u of cc.valueSet) {
        const s = this.worker.pinValueSet(u);
        this.worker.deadCheck('prepareConceptSet:ir#import');
        if (!this.others.has(s)) {
          const other = await this.worker.findValueSet(s, '');
          if (other === null) {
            throw new Issue('error', 'not-found', null, 'Unable_to_resolve_value_Set_', this.worker.i18n.translate('Unable_to_resolve_value_Set_', this.params.HTTPLanguages, [s]), 'not-found', 422);
          }
          const checker = new IRValueSetChecker(this.worker, other, this.params);
          checker.indentCount = this.indentCount + 1;
          await checker.prepare(other, this.params, null);
          this.others.set(s, checker);
        }
      }
    }
    const v = this.worker.determineVersionBase(cc.system, cc.version, this.params);
    const cs = await this.worker.findCodeSystem(cc.system, v, this.params, ['complete', 'fragment'], null, true, false, false, this.worker.requiredSupplements);
    if (cs !== null) {
      this.worker.opContext.addNote(this.valueSet, 'CodeSystem found: "' + this.worker.renderer.displayCoded(cs) + '"', this.indentCount);
      for (const s of this.worker.requiredSupplements) {
        if (cs.hasSupplement(s)) this.worker.usedSupplements.add(s);
      }
      let i = 0;
      for (const ccf of cc.filter || []) {
        this.worker.deadCheck('prepareConceptSet:ir#filter');
        Extensions.checkNoModifiers(ccf, 'IRValueSetChecker.prepare', desc + '.filter');
        if (!ccf.value) {
          throw new Issue('error', 'invalid', `ValueSet.compose.${desc}.filter[${i}]`, 'UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE',
            this.worker.i18n.translate('UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE', this.params.HTTPLanguages, [cs.system(), ccf.property, ccf.op]), 'vs-invalid').handleAsOO(400);
        }
        i++;
      }
    } else if (cc.system) {
      this.worker.opContext.addNote(this.valueSet, 'CodeSystem version ' + v + ' not found: "' + this.worker.renderer.displayCoded(cc.system, cc.version) + '"', this.indentCount);
    }
  }

  async checkConceptSet(path, role, cs, cset, code, displays, vs, message, inactive, normalForm, vstatus, op, vcc, messages) {
    if (!cset.filter || cset.filter.length === 0) {
      return await super.checkConceptSet(path, role, cs, cset, code, displays, vs, message, inactive, normalForm, vstatus, op, vcc, messages);
    }
    return await this.worker.checkConceptSetViaIR({
      checker: this,
      path,
      role,
      cs,
      cset,
      code,
      displays,
      vs,
      message,
      inactive,
      normalForm,
      vstatus,
      op,
      vcc,
      messages,
    });
  }
}

class ValidateIRWorker extends ValidateWorker {
  constructor(...args) {
    super(...args);
    this._irPlanTexts = [];
  }

  recordIRPlanText(planText) {
    if (!planText) return;
    this._irPlanTexts.push(String(planText));
  }

  flushIRPlanText() {
    if (this._irPlanTexts.length === 0) return null;
    const joined = this._irPlanTexts.join('\n\n');
    this._irPlanTexts = [];
    return joined;
  }

  async withTrace(req, res, label, fn) {
    return await withResponseTrace(req, res, {
      log: msg => this.log.debug(msg),
      getPlanText: () => this.flushIRPlanText(),
    }, async () => {
      const span = trace.begin(label);
      try {
        return await fn();
      } finally {
        span.end();
      }
    });
  }

  async handleCodeSystem(req, res) {
    return await this.withTrace(req, res, 'validateIR:handleCodeSystem', async () => (
      await super.handleCodeSystem(req, res)
    ));
  }

  async handleCodeSystemInstance(req, res) {
    return await this.withTrace(req, res, 'validateIR:handleCodeSystemInstance', async () => {
      try {
        const { id } = req.params;
        const params = this.buildParameters(req);
        this.log.debug(`CodeSystem/${id}/$validate-code with params:`, params);

        this.setupAdditionalResources(params);

        const txp = new TxParameters(this.languages, this.i18n, true);
        txp.readParams(params);
        for (const item of txp.supplements) this.requiredSupplements.add(item);

        const codeSystem = await this.provider.getCodeSystemById(this.opContext, id);
        if (!codeSystem) {
          return res.status(422).json(this.operationOutcome('error', 'not-found', `CodeSystem/${id} not found`));
        }
        const csp = await this.createCodeSystemProviderWithSupplementRuntime(
          codeSystem,
          this.requiredSupplements
        );

        const mode = { mode: null };
        let coded = this.extractCodedValue(params, true, mode);
        if (!coded) {
          const code = this.getStringParam(params, 'code');
          if (code) {
            mode.mode = 'code';
            mode.issuePath = '';
            const coding = { code, system: csp.system() };
            if (csp.version()) coding.version = csp.version();
            const display = this.getStringParam(params, 'display');
            if (display) coding.display = display;
            coded = { coding: [coding] };
          }
        }
        if (!coded) {
          return res.status(400).json(this.operationOutcome(
            'error',
            'invalid',
            'Unable to find code to validate (looked for coding | codeableConcept | code in parameters =codingX:Coding)'
          ));
        }

        const result = await this.doValidationCS(coded, csp, txp, mode);
        req.logInfo = this.usedSources.join('|') + txp.logInfo();
        return res.json(result);
      } catch (error) {
        this.log.error(error);
        this.debugLog(error);
        return res.status(error.statusCode || 500).json(this.operationOutcome(
          'error', error.issueCode || 'exception', error.message
        ));
      }
    });
  }

  async handleValueSet(req, res) {
    return await this.withTrace(req, res, 'validateIR:handleValueSet', async () => (
      await super.handleValueSet(req, res)
    ));
  }

  async handleValueSetInstance(req, res) {
    return await this.withTrace(req, res, 'validateIR:handleValueSetInstance', async () => (
      await super.handleValueSetInstance(req, res)
    ));
  }

  async doValidationCS(coded, codeSystem, params, mode) {
    const span = trace.begin('validateIR:doValidationCS', {
      system: typeof codeSystem?.system === 'function' ? codeSystem.system() : null,
      version: typeof codeSystem?.version === 'function' ? codeSystem.version() : null,
    });
    try {
      return await super.doValidationCS(coded, codeSystem, params, mode);
    } finally {
      span.end();
    }
  }

  async doValidationVS(coded, valueSet, params, mode, issuePath) {
    const span = trace.begin('validateIR:doValidationVS', {
      url: valueSet?.url || valueSet?.jsonObj?.url || null,
    });
    try {
      this.deadCheck('doValidationVS:ir');
      this.params = params;

      for (const ext of Extensions.list(valueSet.jsonObj, 'http://hl7.org/fhir/StructureDefinition/valueset-supplement')) {
        this.requiredSupplements.add(getValuePrimitive(ext));
      }

      const checker = new IRValueSetChecker(this, valueSet, params);
      try {
        await checker.prepare();
      } catch (error) {
        this.log.error(error);
        this.debugLog(error);
        throw error;
      }

      const result = await checker.checkCodeableConcept(issuePath, coded, mode);
      if (params.diagnostics) {
        result.jsonObj.parameter.push({ name: 'diagnostics', valueString: this.opContext.diagnostics() });
      }
      return result.jsonObj;
    } finally {
      span.end();
    }
  }

  async checkConceptSetViaIR(opts = {}) {
    const {
      checker,
      path,
      role,
      cs,
      cset,
      code,
      displays,
      vs,
      inactive,
      vstatus,
      op,
      vcc,
    } = opts;

    this.opContext.addNote(vs, 'check code ' + role + ' ' + this.renderer.displayValueSetInclude(cset) + ' at ' + path + ' via IR', checker.indentCount);

    const span = trace.begin('validateIR:checkConceptSet', {
      role,
      system: cset?.system || null,
      code,
      filterCount: Array.isArray(cset?.filter) ? cset.filter.length : 0,
    });
    try {
      const miniVs = {
        resourceType: 'ValueSet',
        status: 'active',
        compose: {
          include: [JSON.parse(JSON.stringify(cset))],
        },
      };
      if (vs?.jsonObj?.compose?.lockedDate) {
        miniVs.compose.lockedDate = vs.jsonObj.compose.lockedDate;
      }

      const plan = await prepareIRPlan(miniVs, {
        resolveValueSet: async (url, version) => {
          const found = await this.findValueSet(url, version);
          return found?.jsonObj || found || null;
        },
        resolveVersionAtDate: async (system, lockedDate) => {
          if (typeof this.resolveCodeSystemVersionAtDate !== 'function') return null;
          return await this.resolveCodeSystemVersionAtDate(system, lockedDate, this.params);
        },
        warnings: [],
        debugPlan: true,
      });

      if (!plan) {
        throw new Issue('error', 'not-supported', path, 'FILTER_NOT_UNDERSTOOD',
          this.i18n.translate('FILTER_NOT_UNDERSTOOD', this.params.HTTPLanguages, [cset.filter[0].property, cset.filter[0].op, cset.filter[0].value, valueSetLabel(vs), cs.system()]), 'vs-invalid').handleAsOO(400);
      }
      this.recordIRPlanText(plan.planText);

      const constrainedIR = optimize(addCodeConstraint(plan.optimizedIR, code));
      const warnings = [];
      const scopeResult = await resolveIRExecutionScopes(plan.systems, constrainedIR, {
        findProvider: async (system, version) => (
          await this.bindIRScopeForOperation(
            system,
            version,
            this.params,
            ['complete', 'fragment'],
            op,
            true,
            true,
            false,
            this.requiredSupplements
          )
        ),
        text: null,
        effectiveActiveOnly: !!this.params.activeOnly,
        count: 1,
        totalOnly: false,
        allowIncompleteExpansion: false,
        warnings,
        countFromIR,
      });

      if (!scopeResult) {
        throw new Issue('error', 'not-supported', path, 'FILTER_NOT_UNDERSTOOD',
          this.i18n.translate('FILTER_NOT_UNDERSTOOD', this.params.HTTPLanguages, [cset.filter[0].property, cset.filter[0].op, cset.filter[0].value, valueSetLabel(vs), cs.system()]), 'vs-invalid').handleAsOO(400);
      }

      const page = await executeIRExpansionPage(scopeResult.resolved, {
        text: null,
        effectiveActiveOnly: !!this.params.activeOnly,
        offset: 0,
        count: 1,
        allowIncompleteExpansion: false,
        exactTotal: false,
        shouldOmitLazyTotal: true,
        limit: 0,
        vsJson: miniVs,
      });

      if (!page.candidates || page.candidates.length === 0) {
        this.opContext.addNote(vs, 'Filter ' + checker.filterSummary(cset) + ': Code "' + code + '" not found in ' + this.renderer.displayCoded(cs), checker.indentCount);
        return false;
      }

      const locResult = await cs.locate(code);
      if (!locResult?.context) {
        this.opContext.addNote(vs, 'IR matched but locate failed for code "' + code + '" in ' + this.renderer.displayCoded(cs), checker.indentCount);
        return false;
      }
      const loc = locResult.context;
      await this.listDisplaysFromCodeSystem(displays, cs, loc);
      if (!(this.params.abstractOk || !(await cs.isAbstract(loc)))) {
        this.opContext.addNote(vs, 'Filter ' + checker.filterSummary(cset) + ': Code "' + code + '" found in ' + this.renderer.displayCoded(cs) + ' but is abstract', checker.indentCount);
        if (!this.params.membershipOnly) {
          op.addIssue(new Issue('error', 'business-rule', path + '.code', 'ABSTRACT_CODE_NOT_ALLOWED', this.i18n.translate('ABSTRACT_CODE_NOT_ALLOWED', this.params.HTTPLanguages, [cs.system(), code]), 'code-rule'));
        }
        return false;
      }
      if ((this.params.activeOnly || checker.excludeInactives()) && await cs.isInactive(loc)) {
        this.opContext.addNote(vs, 'Filter ' + checker.filterSummary(cset) + ': Code "' + code + '" found in ' + this.renderer.displayCoded(cs) + ' but is inactive', checker.indentCount);
        inactive.value = true;
        inactive.path = path;
        vstatus.value = await cs.getStatus(loc);
        return false;
      }

      this.opContext.addNote(vs, 'Filter ' + checker.filterSummary(cset) + ': Code "' + code + '" found in ' + this.renderer.displayCoded(cs) + ' via IR', checker.indentCount);
      if (vcc !== null) {
        if (!vcc.coding) vcc.coding = [];
        vcc.coding.push({
          system: cs.system(),
          version: cs.version(),
          code: await cs.code(loc),
          display: displays.preferredDisplay(this.params.workingLanguages()),
        });
      }
      inactive.value = await cs.isInactive(loc);
      inactive.path = path;
      vstatus.value = await cs.getStatus(loc);
      return true;
    } finally {
      span.end();
    }
  }
}

module.exports = {
  ValidateIRWorker,
};
