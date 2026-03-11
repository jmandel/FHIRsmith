'use strict';

const LookupWorker = require('./lookup');
const { Parameters } = require('../library/parameters');
const { TxParameters } = require('../params');
const { Issue, OperationOutcome } = require('../library/operation-outcome');
const { trace } = require('../engine/expand-trace');
const { withResponseTrace } = require('./ir-worker-trace');
const {
  createCodeSystemProviderWithSupplementRuntime,
  findCodeSystemWithSupplementRuntime,
  setupIRAdditionalResources,
} = require('./ir-runtime-support');

function shouldIncludeAllProperties(props = []) {
  return !Array.isArray(props) || props.length === 0
    || props.includes('*')
    || props.some((prop) => String(prop || '').toLowerCase() === 'property');
}

function requestedPropertyCodes(props = []) {
  return new Set(
    (props || [])
      .map((prop) => String(prop || '').trim())
      .filter(Boolean)
      .filter((prop) => prop !== '*' && prop.toLowerCase() !== 'property')
      .map((prop) => prop.toLowerCase())
  );
}

function propertyValueKey(property = {}) {
  const valueKeys = [
    'valueCode',
    'valueString',
    'valueInteger',
    'valueBoolean',
    'valueDateTime',
    'valueDate',
    'valueDecimal',
    'valueCoding',
    'valueUri',
    'valueCanonical',
  ];
  for (const key of valueKeys) {
    if (property[key] !== undefined && property[key] !== null) {
      return `${property.code || ''}:${key}:${JSON.stringify(property[key])}`;
    }
  }
  if (property.value !== undefined && property.value !== null) {
    return `${property.code || ''}:value:${JSON.stringify(property.value)}`;
  }
  return `${property.code || ''}:empty`;
}

function propertyParamKey(param = {}) {
  const parts = param.part || [];
  const codePart = parts.find((part) => part.name === 'code');
  const valuePart = parts.find((part) => part.name === 'value');
  if (!codePart || !valuePart) return JSON.stringify(parts);
  const valueName = Object.keys(valuePart).find((key) => key !== 'name');
  return `${codePart.valueCode || ''}:${valueName || 'value'}:${JSON.stringify(valueName ? valuePart[valueName] : null)}`;
}

function buildPropertyParam(property = {}) {
  const parts = [{ name: 'code', valueCode: property.code }];
  if (property.valueCode != null) {
    parts.push({ name: 'value', valueCode: property.valueCode });
  } else if (property.valueString != null) {
    parts.push({ name: 'value', valueString: property.valueString });
  } else if (property.valueInteger != null) {
    parts.push({ name: 'value', valueInteger: property.valueInteger });
  } else if (property.valueBoolean != null) {
    parts.push({ name: 'value', valueBoolean: property.valueBoolean });
  } else if (property.valueDateTime) {
    parts.push({ name: 'value', valueDateTime: property.valueDateTime });
  } else if (property.valueDate) {
    parts.push({ name: 'value', valueDate: property.valueDate });
  } else if (property.valueDecimal != null) {
    parts.push({ name: 'value', valueDecimal: property.valueDecimal });
  } else if (property.valueCoding) {
    parts.push({ name: 'value', valueCoding: property.valueCoding });
  } else if (property.valueUri) {
    parts.push({ name: 'value', valueUri: property.valueUri });
  } else if (property.valueCanonical) {
    parts.push({ name: 'value', valueCanonical: property.valueCanonical });
  } else if (property.value && typeof property.value === 'object' && property.value.code) {
    parts.push({
      name: 'value',
      valueCoding: {
        system: property.value.system,
        code: property.value.code,
        ...(property.value.display ? { display: property.value.display } : {}),
      },
    });
  } else if (property.value != null) {
    parts.push({ name: 'value', valueString: String(property.value) });
  } else {
    return null;
  }
  return { name: 'property', part: parts };
}

class LookupIRWorker extends LookupWorker {
  async withTrace(req, res, label, fn) {
    return await withResponseTrace(req, res, {
      log: msg => this.log.debug(msg),
    }, async () => {
      const span = trace.begin(label);
      try {
        return await fn();
      } finally {
        span.end();
      }
    });
  }

  async handle(req, res) {
    return await this.withTrace(req, res, 'lookupIR:handle', async () => (
      await super.handle(req, res)
    ));
  }

  async handleInstance(req, res) {
    return await this.withTrace(req, res, 'lookupIR:handleInstance', async () => (
      await super.handleInstance(req, res)
    ));
  }

  async handleTypeLevelLookup(req, res) {
    try {
      this.deadCheck('lookup-type-level:ir');

      if (req.body && req.body.resourceType === 'Parameters') {
        setupIRAdditionalResources(this, req.body);
      }

      const params = new Parameters(this.buildParameters(req));
      const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
      txp.readParams(params.jsonObj);

      let csProvider;
      let code;
      const inlineCodeSystem = this.getResourceParam(params.jsonObj, 'codeSystem');

      if (inlineCodeSystem) {
        csProvider = await createCodeSystemProviderWithSupplementRuntime(
          this,
          inlineCodeSystem,
          txp.supplements
        );
        if (params.has('coding')) {
          const coding = params.get('coding');
          if (!coding.system) {
            return res.status(400).json(this.operationOutcome('error', 'invalid',
              'Coding parameter must include a system'));
          }
          if (!coding.code) {
            return res.status(400).json(this.operationOutcome('error', 'invalid',
              'Coding parameter must include a code'));
          }
          code = coding.code;
        } else if (params.has('code')) {
          code = params.get('code');
        } else {
          return res.status(400).json(this.operationOutcome('error', 'invalid',
            'Must provide code parameter or coding parameter with code'));
        }
      } else if (params.has('coding')) {
        const coding = params.get('coding');
        if (!coding.system) {
          return res.status(400).json(this.operationOutcome('error', 'invalid',
            'Coding parameter must include a system'));
        }
        if (!coding.code) {
          return res.status(400).json(this.operationOutcome('error', 'invalid',
            'Coding parameter must include a code'));
        }
        csProvider = await findCodeSystemWithSupplementRuntime(
          this,
          coding.system,
          coding.version || '',
          txp,
          ['complete', 'fragment'],
          null,
          true,
          false,
          false,
          txp.supplements
        );
        this.seeSourceProvider(csProvider, coding.system);
        code = coding.code;
      } else if (params.has('system') && params.has('code')) {
        csProvider = await findCodeSystemWithSupplementRuntime(
          this,
          params.get('system'),
          params.get('version') || '',
          txp,
          ['complete', 'fragment'],
          null,
          true,
          false,
          false,
          txp.supplements
        );
        this.seeSourceProvider(csProvider, params.get('system'));
        code = params.get('code');
      } else {
        return res.status(400).json(this.operationOutcome('error', 'invalid',
          'Must provide either coding parameter, or system and code parameters'));
      }

      if (!csProvider) {
        const coding = params.has('coding') ? params.get('coding') : null;
        const systemUrl = params.has('system') ? params.get('system') : coding?.system;
        const versionStr = params.has('version') ? params.get('version') : (coding?.version || '');
        if (!versionStr) {
          throw new Issue(
            'error',
            'not-found',
            null,
            'UNKNOWN_CODESYSTEM_EXP',
            this.i18n.translate('UNKNOWN_CODESYSTEM_EXP', txp.FHTTPLanguages, [systemUrl]),
            'not-found',
            422
          );
        }
        const versions = await this.listVersions(systemUrl);
        if (versions.length === 0) {
          throw new Issue(
            'error',
            'not-found',
            null,
            'UNKNOWN_CODESYSTEM_VERSION_EXP_NONE',
            this.i18n.translate('UNKNOWN_CODESYSTEM_VERSION_EXP_NONE', txp.FHTTPLanguages, [systemUrl, versionStr]),
            'not-found',
            422
          );
        }
        throw new Issue(
          'error',
          'not-found',
          null,
          'UNKNOWN_CODESYSTEM_VERSION_EXP',
          this.i18n.translate('UNKNOWN_CODESYSTEM_VERSION_EXP', txp.FHTTPLanguages, [systemUrl, versionStr, this.presentVersionList(versions)]),
          'not-found',
          422
        );
      }

      const result = await this.doLookup(csProvider, code, txp);
      return res.status(200).json(result);
    } catch (error) {
      this.log.error(error);
      this.debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(error.msgId  ? " "+error.msgId : "");
      if (error instanceof Issue) {
        const oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      }
      return res.status(error.statusCode || 500).json(this.operationOutcome(
        'error', error.issueCode || 'exception', error.message));
    }
  }

  async handleInstanceLevelLookup(req, res) {
    try {
      this.deadCheck('lookup-instance-level:ir');

      const { id } = req.params;
      let codeSystem = this.provider.getCodeSystemById(this.opContext, id);
      this.seeSourceProvider(codeSystem, id);

      if (!codeSystem) {
        return res.status(404).json(this.operationOutcome('error', 'not-found',
          `CodeSystem/${id} not found`));
      }

      if (req.body && req.body.resourceType === 'Parameters') {
        setupIRAdditionalResources(this, req.body);
      }

      const params = new Parameters(this.buildParameters(req));
      const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
      txp.readParams(params.jsonObj);

      let code;
      if (params.has('coding')) {
        code = params.get('coding').code;
      } else if (params.has('code')) {
        code = params.get('code');
      } else {
        return res.status(400).json(this.operationOutcome('error', 'invalid',
          'Must provide code parameter or coding parameter with code'));
      }

      const csProvider = await createCodeSystemProviderWithSupplementRuntime(
        this,
        codeSystem,
        txp.supplements
      );

      const result = await this.doLookup(csProvider, code, txp);
      return res.status(200).json(result);
    } catch (error) {
      this.log.error(error);
      this.debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(error.msgId  ? " "+error.msgId : "");
      if (error instanceof Issue) {
        const oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      }
      return res.status(error.statusCode || 500).json(this.operationOutcome(
        'error', error.issueCode || 'exception', error.message));
    }
  }

  async doLookup(csProvider, code, params) {
    const span = trace.begin('lookupIR:doLookup', {
      system: typeof csProvider?.system === 'function' ? csProvider.system() : null,
      code,
    });
    try {
      const result = await super.doLookup(csProvider, code, params);
      const responseParams = result?.parameter;
      if (!Array.isArray(responseParams)) return result;

      const locateResult = await csProvider.locate(code);
      if (!locateResult?.context) return result;
      const ctxt = locateResult.context;

      const existingPropertyKeys = new Set(
        responseParams
          .filter((param) => param?.name === 'property')
          .map(propertyParamKey)
      );

      const includeAll = shouldIncludeAllProperties(params.properties);
      const requestedCodes = requestedPropertyCodes(params.properties);
      const discovered = new Map();

      const providerProperties = typeof csProvider.properties === 'function'
        ? await csProvider.properties(ctxt)
        : [];
      for (const property of providerProperties || []) {
        if (!property?.code) continue;
        discovered.set(propertyValueKey(property), property);
      }

      const conceptCode = typeof csProvider.code === 'function'
        ? await csProvider.code(ctxt)
        : code;
      for (const supplement of csProvider.supplements || []) {
        const concept = supplement?.getConceptByCode?.(conceptCode);
        for (const property of concept?.property || []) {
          if (!property?.code) continue;
          discovered.set(propertyValueKey(property), property);
        }
      }

      for (const property of discovered.values()) {
        if (!includeAll && !requestedCodes.has(String(property.code || '').toLowerCase())) continue;
        const param = buildPropertyParam(property);
        if (!param) continue;
        const key = propertyParamKey(param);
        if (existingPropertyKeys.has(key)) continue;
        existingPropertyKeys.add(key);
        responseParams.push(param);
      }

      return result;
    } finally {
      span.end();
    }
  }
}

module.exports = {
  LookupIRWorker,
};
