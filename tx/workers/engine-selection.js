'use strict';

function paramValue(param) {
  if (!param || typeof param !== 'object') return null;
  for (const key of ['valueString', 'valueCode', 'valueUri', 'valueCanonical']) {
    const value = param[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function requestedEngineFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body._engine === 'string' && body._engine.trim()) return body._engine.trim();
  if (body.resourceType === 'Parameters' && Array.isArray(body.parameter)) {
    for (const param of body.parameter) {
      if (param?.name !== '_engine') continue;
      const value = paramValue(param);
      if (value) return value;
    }
  }
  return null;
}

function normalizeRequestedEngine(engine) {
  const raw = String(engine || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'ir' || raw === 'legacy') return raw;
  return null;
}

function getRequestedEngine(req) {
  const queryEngine = typeof req?.query?._engine === 'string' ? req.query._engine : null;
  const bodyEngine = requestedEngineFromBody(req?.body);
  return normalizeRequestedEngine(queryEngine || bodyEngine);
}

function shouldUseIRExpandByDefault() {
  return process.env.EXPAND_IR_ENGINE === '1';
}

module.exports = {
  getRequestedEngine,
  normalizeRequestedEngine,
  shouldUseIRExpandByDefault,
};
