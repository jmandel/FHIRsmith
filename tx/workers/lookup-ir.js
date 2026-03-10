'use strict';

const LookupWorker = require('./lookup');
const { trace } = require('../engine/expand-trace');
const { withResponseTrace } = require('./ir-worker-trace');

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
