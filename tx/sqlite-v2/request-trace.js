'use strict';
// Whole-request traces: one Tracer per traced request, on the OperationContext
// (opContext.sqliteTrace), so expand.js, the workers and the sqlite-v2 providers all add spans
// to the same trace. Registered as router middleware after body parsing; with tracing off
// (modules.tx.sqliteV2Trace absent or "off") it is a single string comparison per request.
//
// A request asks with _trace=true, or _trace=cold to also bypass upstream's expansion cache
// (only honoured when tracing is enabled). The sqlite-v2 engine itself caches nothing.
// The trace goes back with the response:
//   ValueSet          -> extension on ValueSet.expansion
//   Parameters        -> a parameter named _trace (valueString)
//   OperationOutcome  -> extension on the OperationOutcome
// and into the ring buffer (/<endpoint>/sqlite-v2/traces).

const { Tracer, ring, settings, EXTENSION_URL } = require('./trace');

/** the _trace value of a request: 'true', 'cold' or null */
function requested(req) {
  const q = req.query && req.query._trace;
  if (q != null) return normalise(Array.isArray(q) ? q[0] : q);
  const b = req.body;
  if (b && b.resourceType === 'Parameters' && Array.isArray(b.parameter)) {
    const p = b.parameter.find((x) => x.name === '_trace');
    if (p) return normalise(p.valueString ?? p.valueCode ?? p.valueBoolean);
  }
  return null;
}

function normalise(v) {
  const s = String(v).toLowerCase();
  if (s === 'cold') return 'cold';
  if (s === 'true') return 'true';
  return null;
}

function summarise(data, status) {
  const r = { status };
  if (!data || typeof data !== 'object') return r;
  r.resourceType = data.resourceType;
  if (data.resourceType === 'ValueSet' && data.expansion) {
    r.total = data.expansion.total ?? null;
    r.returned = (data.expansion.contains || []).length;
  } else if (data.resourceType === 'Parameters') {
    const res = (data.parameter || []).find((p) => p.name === 'result' || p.name === 'outcome');
    if (res) r.result = res.valueBoolean ?? res.valueCode ?? null;
  } else if (data.resourceType === 'OperationOutcome') {
    r.issues = (data.issue || []).map((i) => i.code);
  }
  return r;
}

function middleware() {
  return (req, res, next) => {
    if (settings.mode === 'off' || req.path.startsWith('/sqlite-v2/')) return next();
    const want = requested(req);
    if (!want && settings.mode !== 'all') return next();
    const op = req.txOpContext;
    if (!op) return next();
    const t = new Tracer({ method: req.method, path: req.path, url: req.originalUrl.slice(0, 1000), trace: want });
    if (want === 'cold') {
      t.cold = true;
      // a POSTed Parameters body is read without the query string: carry _trace=cold into it
      // so the expansion cache is bypassed there too (tx/params.js)
      const b = req.body;
      if (b && b.resourceType === 'Parameters' && Array.isArray(b.parameter) && !b.parameter.some((x) => x.name === '_trace')) {
        b.parameter.push({ name: '_trace', valueString: 'cold' });
      }
      t.trace.request.cachesBypassed = ['expansion cache (upstream)'];
      t.trace.request.notCaches = ['SQLite page cache and OS page cache (mmap)', 'prepared statements', 'data built at load (LOINC order rank)'];
    }
    op.sqliteTrace = t;
    const root = t.open(req.method + ' ' + req.path, 'op', null);
    const json = res.json.bind(res);
    let done = false;
    res.json = (data) => {
      if (!done) {
        done = true;
        t.close(root, null);
        const trace = t.finish(summarise(data, res.statusCode));
        ring.push(trace);
        if (want && data && typeof data === 'object') {
          const s = JSON.stringify(trace);
          // copies: the response object may be shared (e.g. held by the expansion cache)
          const ext = { url: EXTENSION_URL, valueString: s };
          if (data.resourceType === 'ValueSet' && data.expansion) {
            data = { ...data, expansion: { ...data.expansion, extension: [...(data.expansion.extension || []), ext] } };
          } else if (data.resourceType === 'Parameters') {
            data = { ...data, parameter: [...(data.parameter || []), { name: '_trace', valueString: s }] };
          } else if (data.resourceType === 'OperationOutcome') {
            data = { ...data, extension: [...(data.extension || []), ext] };
          }
        }
      }
      return json(data);
    };
    next();
  };
}

module.exports = { middleware, requested };
