'use strict';

const {
  ExpandTrace,
  traceStore,
  formatTraceSummary,
} = require('../engine/expand-trace');

const TRACE_EXTENSION_URL = 'https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/expand-trace';
const IR_PLAN_EXTENSION_URL = 'https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/ir-plan';

function traceRequestedFromRequest(req) {
  const queryValue = req?.query?._trace;
  if (queryValue != null) return truthy(queryValue);
  const body = req?.body;
  if (body?.resourceType === 'Parameters' && Array.isArray(body.parameter)) {
    const param = body.parameter.find((entry) => entry?.name === '_trace');
    if (param) {
      for (const key of ['valueBoolean', 'valueString', 'valueCode']) {
        if (param[key] != null) return truthy(param[key]);
      }
    }
  }
  if (body && typeof body === 'object' && body._trace != null) {
    return truthy(body._trace);
  }
  return false;
}

function truthy(value) {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return false;
}

function attachTracePayload(resource, traceObj, opts = {}) {
  if (!resource || !traceObj) return resource;
  const { log, irPlanText = null } = opts;
  const traceJson = traceObj.toJSON();
  if (!traceJson) return resource;

  if (resource.resourceType === 'Parameters') {
    resource.parameter = resource.parameter || [];
    resource.parameter = resource.parameter.filter((param) => param?.name !== 'trace' && param?.name !== 'irPlan');
    resource.parameter.push({ name: 'trace', valueString: JSON.stringify(traceJson) });
    if (irPlanText) {
      resource.parameter.push({ name: 'irPlan', valueString: String(irPlanText) });
    }
  } else {
    resource.extension = resource.extension || [];
    resource.extension = resource.extension.filter((ext) => ext?.url !== TRACE_EXTENSION_URL && ext?.url !== IR_PLAN_EXTENSION_URL);
    resource.extension.push({ url: TRACE_EXTENSION_URL, valueString: JSON.stringify(traceJson) });
    if (irPlanText) {
      resource.extension.push({ url: IR_PLAN_EXTENSION_URL, valueString: String(irPlanText) });
    }
  }

  log?.(`[IR trace] ${formatTraceSummary(traceJson)}`);
  return resource;
}

async function withResponseTrace(req, res, opts = {}, fn) {
  const enabled = traceRequestedFromRequest(req);
  if (!enabled) {
    return await fn();
  }

  const traceObj = new ExpandTrace();
  const originalJson = res.json.bind(res);
  res.json = (payload) => originalJson(attachTracePayload(payload, traceObj, {
    log: opts.log,
    irPlanText: typeof opts.getPlanText === 'function' ? opts.getPlanText() : null,
  }));

  try {
    return await traceStore.run(traceObj, fn);
  } finally {
    res.json = originalJson;
  }
}

module.exports = {
  TRACE_EXTENSION_URL,
  IR_PLAN_EXTENSION_URL,
  attachTracePayload,
  traceRequestedFromRequest,
  withResponseTrace,
};
