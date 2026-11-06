'use strict';
// Shared code for the sqlite-v2 query catalog: load entries, turn an entry + access pattern
// into concrete FHIR requests, call a server (with an on-disk response cache), and reduce a
// response to the comparable summary stored in reference/<id>.json.
// Node built-ins only, so the scripts run from a bare checkout.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATALOG_DIR = __dirname;
const ENTRIES_DIR = path.join(CATALOG_DIR, 'entries');
// reference answers: tx-dev.fhir.org (reference/); the earlier tx.fhir.org recordings are kept in
// reference-tx.fhir.org/ for history. CATALOG_REFERENCE_DIR selects another folder.
const REFERENCE_DIR = process.env.CATALOG_REFERENCE_DIR ? path.resolve(process.env.CATALOG_REFERENCE_DIR) : path.join(CATALOG_DIR, 'reference');

const OPERATIONS = ['expand', 'validate-code', 'lookup', 'subsumes'];
const PATTERNS = ['first-page', 'pages-1-3', 'deep-jump', 'first-then-deep', 'last-with-total'];

function loadEntries(dir = ENTRIES_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ file: f, entry: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

function pagingOf(entry) {
  const p = entry.paging || {};
  // count: null means "send neither offset nor count" (server defaults)
  return { count: p.count === undefined ? 20 : p.count, deepOffset: p.deepOffset != null ? p.deepOffset : 1000 };
}

/**
 * The page requests of one access pattern. `last-with-total` depends on the total of the
 * first page, so it is resolved with a callback: totalOf() -> number|null.
 * Returns [{offset, count}] (or null for non-expand operations: a single request).
 */
function pagesFor(entry, pattern, totalOf) {
  const { count, deepOffset } = pagingOf(entry);
  if (count === null) return [{ offset: null, count: null }];
  switch (pattern) {
    case 'first-page': return [{ offset: 0, count }];
    case 'pages-1-3': return [0, 1, 2].map((i) => ({ offset: i * count, count }));
    case 'deep-jump': return [{ offset: deepOffset, count }];
    case 'first-then-deep': return [{ offset: 0, count }, { offset: deepOffset, count }];
    case 'last-with-total': {
      const total = totalOf ? totalOf() : null;
      if (total == null) return [{ offset: 0, count, note: 'no total on first page; last page unknown' }];
      return [{ offset: 0, count }, { offset: Math.max(0, total - count), count }];
    }
    default: throw new Error('unknown pattern ' + pattern);
  }
}

function p(name, valueKey, value) { return { name, [valueKey]: value }; }

/** Build {method, path, body} for an entry; page = {offset, count} for expand. */
function buildRequest(entry, page) {
  const r = entry.request;
  const params = [];
  const add = (x) => params.push(x);
  if (r.valueSet) add({ name: 'valueSet', resource: r.valueSet });
  if (r.valueSetUrl) add(p('url', 'valueUri', r.valueSetUrl));
  for (const res of r.txResources || []) add({ name: 'tx-resource', resource: res });
  for (const [k, v] of Object.entries(r.parameters || {})) {
    for (const one of Array.isArray(v) ? v : [v]) add(typedParam(k, one));
  }
  // CATALOG_EXTRA_PARAMS="_trace=cold,…": extra string parameters on every request (measurement runs)
  for (const kv of (process.env.CATALOG_EXTRA_PARAMS || '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    add({ name: k, valueString: v });
  }
  if (r.operation === 'expand') {
    if (page && page.offset != null) add(p('offset', 'valueInteger', page.offset));
    if (page && page.count != null) add(p('count', 'valueInteger', page.count));
  }
  const pathFor = { expand: 'ValueSet/$expand', 'validate-code': (r.valueSet || r.valueSetUrl) ? 'ValueSet/$validate-code' : 'CodeSystem/$validate-code', lookup: 'CodeSystem/$lookup', subsumes: 'CodeSystem/$subsumes' };
  return { method: 'POST', path: pathFor[r.operation], body: { resourceType: 'Parameters', parameter: params } };
}

// FHIR parameter types for the names the catalog uses.
const PARAM_TYPES = {
  activeOnly: 'valueBoolean', includeDesignations: 'valueBoolean', excludeNested: 'valueBoolean',
  includeDefinition: 'valueBoolean', limitedExpansion: 'valueBoolean', abstract: 'valueBoolean',
  displayLanguage: 'valueCode', designation: 'valueString', filter: 'valueString', property: 'valueCode',
  useSupplement: 'valueCanonical', 'system-version': 'valueCanonical', 'force-system-version': 'valueCanonical',
  'check-system-version': 'valueCanonical', system: 'valueUri', version: 'valueString', code: 'valueCode',
  display: 'valueString', codeA: 'valueCode', codeB: 'valueCode', inferSystem: 'valueBoolean',
  lenient: 'valueBoolean', 'default-to-latest-version': 'valueBoolean', date: 'valueDateTime'
};
function typedParam(name, v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.coding || v.text) return { name, valueCodeableConcept: v };
    if (v.system || v.code) return { name, valueCoding: v };
    return { name, ...v }; // already typed, e.g. {"valueString": ".."}
  }
  const t = PARAM_TYPES[name] || (typeof v === 'boolean' ? 'valueBoolean' : typeof v === 'number' ? 'valueInteger' : 'valueString');
  return { name, [t]: v };
}

function requestKey(req) {
  return crypto.createHash('sha256').update(req.method + ' ' + req.path + '\n' + JSON.stringify(req.body)).digest('hex').slice(0, 24);
}

/**
 * Call base + req.path. Cached on disk by request hash when cacheDir is set: a cached
 * response is never re-fetched. Returns {status, json, ms, cached, at}.
 */
async function callServer(base, req, { cacheDir, minIntervalMs = 0, timeoutMs = 120000, log, cache5xx = false } = {}) {
  const key = requestKey(req);
  const file = cacheDir ? path.join(cacheDir, key + '.json') : null;
  if (file && fs.existsSync(file)) return { ...JSON.parse(fs.readFileSync(file, 'utf8')), cached: true, key };
  if (minIntervalMs) await pace(minIntervalMs);
  const t0 = Date.now();
  let status, json, error;
  try {
    const res = await fetch(base.replace(/\/$/, '') + '/' + req.path, {
      method: req.method,
      headers: { Accept: 'application/fhir+json', 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    status = res.status;
    const text = await res.text();
    try { json = JSON.parse(text); } catch (e) { json = { _nonJson: text.slice(0, 2000) }; }
  } catch (e) {
    status = 0; error = String(e && e.message || e);
  }
  const out = { status, json, error, ms: Date.now() - t0, at: new Date().toISOString(), request: { method: req.method, path: req.path } };
  if (log) log(`${status} ${out.ms}ms ${req.path} ${key}`);
  if (cacheDir) { // ledger of every network request, cached or not
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.appendFileSync(path.join(cacheDir, 'requests.log'), `${out.at} ${status} ${out.ms} ${req.path} ${key}\n`);
  }
  // cache real answers; transport errors and 429 are retried later, 5xx only once confirmed
  if (file && status && status !== 429 && (status < 500 || cache5xx)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...out, body: req.body }));
  }
  return { ...out, cached: false, key };
}
let lastCall = 0;
async function pace(ms) {
  const wait = lastCall + ms - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

function issuesOf(oo) {
  if (!oo || !oo.issue) return [];
  return oo.issue.map((i) => ({ severity: i.severity, code: i.code, text: (i.details && i.details.text) || i.diagnostics || null, msgId: msgIdOf(i) }));
}
function msgIdOf(i) {
  const e = (i.extension || []).find((x) => /operationoutcome-message-id/.test(x.url));
  return e ? e.valueString : null;
}
function getParam(params, name) { return (params.parameter || []).filter((x) => x.name === name); }
function pval(x) {
  if (!x) return undefined;
  for (const k of Object.keys(x)) if (k.startsWith('value')) return x[k];
  return undefined;
}

/** Reduce a server response to a comparable summary. */
function summarize(entry, resp) {
  const s = { status: resp.status };
  if (resp.error) s.error = resp.error;
  const j = resp.json;
  if (!j) return s;
  if (j.resourceType === 'OperationOutcome') { s.issues = issuesOf(j); return s; }
  const op = entry.request.operation;
  if (op === 'expand' && j.resourceType === 'ValueSet') {
    const e = j.expansion || {};
    s.total = e.total != null ? e.total : null;
    if (e.offset != null) s.offset = e.offset;
    const codes = [];
    const walk = (list) => { for (const c of list || []) { if (c.code) codes.push((c.system || '') + '|' + (c.version || '') + '|' + c.code); walk(c.contains); } };
    walk(e.contains);
    s.codes = codes;
    s.usedCodeSystems = (e.parameter || []).filter((x) => x.name === 'used-codesystem' || x.name === 'used-supplement').map((x) => x.name + '=' + pval(x)).sort();
    const disp = [];
    const walkD = (list) => { for (const c of list || []) { if (c.code) disp.push(c.display || null); walkD(c.contains); } };
    walkD(e.contains);
    if (entry.request.parameters && (entry.request.parameters.displayLanguage || entry.request.parameters.useSupplement || entry.request.recordDisplays)) s.displays = disp;
    if (entry.request.parameters && entry.request.parameters.includeDesignations) {
      let n = 0; const langs = new Set();
      const walkG = (list) => { for (const c of list || []) { for (const d of c.designation || []) { n++; if (d.language) langs.add(d.language); } walkG(c.contains); } };
      walkG(e.contains);
      s.designations = { count: n, languages: [...langs].sort() };
    }
    if (entry.category === 'output-heavy') s.output = outputStats(resp.json, e);
    const warn = (e.extension || []).length ? (e.extension || []).map((x) => x.url.split('/').pop()) : undefined;
    if (warn) s.expansionExtensions = warn;
    const msgs = (e.parameter || []).filter((x) => /warning|limitedExpansion|message/.test(x.name)).map((x) => x.name + '=' + JSON.stringify(pval(x)));
    if (msgs.length) s.expansionNotes = msgs;
    return s;
  }
  if (j.resourceType === 'Parameters') {
    const one = (n) => { const x = getParam(j, n)[0]; return x ? pval(x) : undefined; };
    if (op === 'validate-code') {
      s.result = one('result');
      for (const n of ['display', 'system', 'version', 'code', 'inactive', 'message']) { const v = one(n); if (v !== undefined) s[n] = v; }
      const issues = getParam(j, 'issues')[0];
      if (issues && issues.resource) s.issues = issuesOf(issues.resource);
    } else if (op === 'lookup') {
      for (const n of ['name', 'version', 'display', 'abstract']) { const v = one(n); if (v !== undefined) s[n] = v; }
      const des = getParam(j, 'designation').map((d) => {
        const parts = Object.fromEntries((d.part || []).map((x) => [x.name, pval(x)]));
        return (parts.language || '') + ':' + (parts.use ? parts.use.code : '') + ':' + parts.value;
      }).sort();
      s.designations = des;
      s.properties = [...new Set(getParam(j, 'property').map((x) => {
        const parts = Object.fromEntries((x.part || []).map((y) => [y.name, pval(y)]));
        const v = parts.value; const vs = v && typeof v === 'object' ? (v.code || JSON.stringify(v)) : v;
        return parts.code + '=' + vs;
      }))].sort();
      if (entry.category === 'output-heavy') {
        s.responseBytes = JSON.stringify(j).length;
        const def = one('definition'); if (def !== undefined) s.definition = String(def).slice(0, 200);
        s.propertyCount = getParam(j, 'property').length;
        s.designationCount = getParam(j, 'designation').length;
      }
    } else if (op === 'subsumes') {
      s.outcome = one('outcome');
    }
    return s;
  }
  s.resourceType = j.resourceType;
  return s;
}

/** Size of what was built for an output-heavy expansion: rows, properties, designations, definitions. */
function outputStats(json, e) {
  const o = { responseBytes: JSON.stringify(json).length, rows: 0, propertyCodes: [], propertiesTotal: 0, propertiesMaxPerCode: 0,
    designationsTotal: 0, designationsMaxPerCode: 0, designationLanguages: [], designationUses: [], definitions: 0 };
  const pc = new Set(), langs = new Set(), uses = new Set();
  const walk = (list) => {
    for (const c of list || []) {
      if (c.code) {
        o.rows++;
        const props = (c.property || []).length + (c.extension || []).filter((x) => /concept-property|itemWeight|property/.test(x.url)).length;
        for (const p of c.property || []) pc.add(p.code);
        for (const x of c.extension || []) if (/property/.test(x.url)) { const code = (x.extension || []).find((y) => y.url === 'code'); if (code) pc.add(code.valueCode); }
        o.propertiesTotal += props; o.propertiesMaxPerCode = Math.max(o.propertiesMaxPerCode, props);
        const ds = c.designation || [];
        o.designationsTotal += ds.length; o.designationsMaxPerCode = Math.max(o.designationsMaxPerCode, ds.length);
        for (const d of ds) { if (d.language) langs.add(d.language); if (d.use) uses.add((d.use.system || '') + '|' + d.use.code); }
        if ((c.extension || []).some((x) => /definition/.test(x.url)) || c.definition) o.definitions++;
      }
      walk(c.contains);
    }
  };
  walk(e.contains);
  o.propertyCodes = [...pc].sort(); o.designationLanguages = [...langs].sort(); o.designationUses = [...uses].sort();
  return o;
}

/** Run every pattern of an entry; returns {patterns: {name: [ {offset,count,...summary} ]}, requests}. */
async function runEntry(entry, base, opts = {}) {
  const call = opts.call || callServer; // opts.call lets a caller add budgets/back-off
  const out = { patterns: {}, requests: 0, fetched: 0 };
  const r = entry.request;
  if (r.operation !== 'expand') {
    const req = buildRequest(entry, null);
    const resp = await call(base, req, opts);
    out.requests++; if (!resp.cached) out.fetched++;
    out.patterns.single = [{ key: resp.key, ...summarize(entry, resp) }];
    return out;
  }
  const firstPage = { v: undefined };
  for (const pattern of entry.patterns || ['first-page']) {
    const res = [];
    const pages = pagesFor(entry, pattern, () => firstPage.v === undefined ? null : firstPage.v);
    let resolvedPages = pages;
    if (pattern === 'last-with-total' && firstPage.v === undefined) {
      // need the first page to know the total
      const fp = await call(base, buildRequest(entry, pagesFor(entry, 'first-page')[0]), opts);
      out.requests++; if (!fp.cached) out.fetched++;
      const s = summarize(entry, fp); firstPage.v = s.total != null ? s.total : null;
      resolvedPages = pagesFor(entry, pattern, () => firstPage.v);
    }
    for (const pg of resolvedPages) {
      const resp = await call(base, buildRequest(entry, pg), opts);
      out.requests++; if (!resp.cached) out.fetched++;
      const s = summarize(entry, resp);
      if (pg.offset === 0 && firstPage.v === undefined) firstPage.v = s.total != null ? s.total : null;
      res.push({ offset: pg.offset, count: pg.count, ...(pg.note ? { note: pg.note } : {}), key: resp.key, ms: resp.ms, ...s });
    }
    out.patterns[pattern] = res;
  }
  return out;
}

module.exports = { CATALOG_DIR, ENTRIES_DIR, REFERENCE_DIR, OPERATIONS, PATTERNS, loadEntries, pagingOf, pagesFor, buildRequest, requestKey, callServer, summarize, runEntry };
