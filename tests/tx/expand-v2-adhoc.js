#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const folders = require('../../library/folder-setup');
folders.init(path.join(__dirname, '../../data'));

const { Library } = require('../../tx/library');
const { OperationContext } = require('../../tx/operation-context');
const { TxParameters } = require('../../tx/params');
const { SearchFilterText } = require('../../tx/library/designations');
const ValueSet = require('../../tx/library/valueset');
const { ExpandTrace, traceStore, formatTraceSummary } = require('../../tx/workers/expand-trace');

const WORKER_MODULES = {
  v2: require('../../tx/workers/expand-v2'),
  v3: require('../../tx/workers/expand-v3'),
};

const log = {
  info: (...a) => process.env.ADHOC_VERBOSE ? console.log('[INFO]', ...a) : null,
  debug: () => {},
  error: (...a) => console.error('[ERR]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
};

function usage() {
  return [
    'Usage:',
    '  node tests/tx/expand-v2-adhoc.js [options]',
    '',
    'Core options:',
    '  --impl v2|v3                      Worker impl (default: v2)',
    '  --vs-file <path>                  ValueSet JSON file',
    '  --vs-json <json>                  ValueSet JSON inline',
    '  --include <json>                  Repeated compose.include item JSON',
    '  --exclude <json>                  Repeated compose.exclude item JSON',
    '  --system <uri>                    Shortcut include: [{"system":"..."}]',
    '  --url <uri>                       Override ValueSet.url',
    '',
    'Parameters:',
    '  --params-file <path>              Full Parameters JSON (resourceType=Parameters)',
    '  --params-json <json>              Full Parameters JSON inline',
    '  --count <n>',
    '  --offset <n>',
    '  --limit <n>',
    '  --filter <text>                   Also used for SearchFilterText',
    '  --url-param <uri>                 Convenience for Parameters.url',
    '  --value-set-version <ver>         Convenience for Parameters.valueSetVersion',
    '  --param <json>                    Repeated full Parameters.parameter entry',
    '',
    'Extras:',
    '  --tx-resource-file <path>         Repeated; supports single resource, array, or Bundle',
    '  --tx-resource-json <json>         Repeated inline tx-resource (single resource or array)',
    '  --disable-pushdown                Set EXPAND_V2_DISABLE_PUSHDOWN=1 for this run',
    '  --trace off|summary|json          Default: off',
    '  --trace-max-spans <n>             Default: 24',
    '  --trace-file <path>               Optional file path to write trace JSON/summary',
    '  --out-file <path>                 Optional file path to write final output JSON',
    '  --full-result                     Include full expansion in output',
    '  --contains-preview <n>            Default: 20',
    '  --help',
    '',
    'Example:',
    '  node tests/tx/expand-v2-adhoc.js --impl v3 --system http://snomed.info/sct --count 1000 --offset 50000 --trace summary',
    '  node tests/tx/expand-v2-adhoc.js --impl v3 --vs-file ./my-vs.json --params-file ./my-params.json --trace json',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    let key;
    let value;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function listify(x) {
  if (x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON for ${label}: ${e.message}`);
  }
}

function parseIntOpt(val, label) {
  if (val === undefined) return undefined;
  const n = Number.parseInt(String(val), 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${label}: ${val}`);
  return n;
}

function firstParamPrimitive(params, name) {
  for (const p of params || []) {
    if (!p || p.name !== name) continue;
    if (Object.prototype.hasOwnProperty.call(p, 'valueInteger')) return p.valueInteger;
    if (Object.prototype.hasOwnProperty.call(p, 'valueString')) return p.valueString;
    if (Object.prototype.hasOwnProperty.call(p, 'valueUri')) return p.valueUri;
    if (Object.prototype.hasOwnProperty.call(p, 'valueCanonical')) return p.valueCanonical;
    if (Object.prototype.hasOwnProperty.call(p, 'valueCode')) return p.valueCode;
    if (Object.prototype.hasOwnProperty.call(p, 'valueBoolean')) return p.valueBoolean;
  }
  return null;
}

function flattenContains(contains, out = []) {
  for (const c of contains || []) {
    out.push(c);
    if (Array.isArray(c.contains) && c.contains.length > 0) {
      flattenContains(c.contains, out);
    }
  }
  return out;
}

function loadResourceFile(filePath) {
  const full = path.resolve(filePath);
  const raw = fs.readFileSync(full, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && parsed.resourceType === 'Bundle' && Array.isArray(parsed.entry)) {
    return parsed.entry.map(e => e?.resource).filter(Boolean);
  }
  return [parsed];
}

function loadJsonFile(filePath) {
  const full = path.resolve(filePath);
  const raw = fs.readFileSync(full, 'utf8');
  return JSON.parse(raw);
}

function buildVs(args) {
  if (args['vs-file']) {
    const p = path.resolve(String(args['vs-file']));
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  }
  if (args['vs-json']) {
    return parseJson(String(args['vs-json']), '--vs-json');
  }

  const include = listify(args.include).map((x, idx) => parseJson(String(x), `--include[${idx}]`));
  const exclude = listify(args.exclude).map((x, idx) => parseJson(String(x), `--exclude[${idx}]`));

  if (include.length === 0) {
    if (args.system) include.push({ system: String(args.system) });
  }
  if (include.length === 0) {
    throw new Error('Need one of: --vs-file, --vs-json, --include, or --system');
  }

  return {
    resourceType: 'ValueSet',
    status: 'active',
    url: args.url ? String(args.url) : `http://test.fhirsmith.org/vs/adhoc/${Date.now()}`,
    compose: {
      include,
      ...(exclude.length > 0 ? { exclude } : {}),
    },
  };
}

async function setupLibrary() {
  const preferredConfig = path.join(__dirname, 'fixtures', 'expand-v2-test-library.yaml');
  const fallbackConfig = path.join(__dirname, 'fixtures', 'test-library.yaml');
  const configFile = fs.existsSync(preferredConfig) ? preferredConfig : fallbackConfig;
  if (!fs.existsSync(configFile)) {
    throw new Error(`Missing config: ${preferredConfig} (or fallback ${fallbackConfig})`);
  }
  const library = new Library(configFile, null, log, null, {});
  await library.load();
  const provider = await library.cloneWithFhirVersion('5.0', null, '/r5');
  return { library, provider };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const impl = String(args.impl || 'v2').toLowerCase();
  if (!WORKER_MODULES[impl]) {
    throw new Error(`Unsupported --impl '${impl}'. Use v2 or v3.`);
  }

  const traceMode = String(args.trace || 'off').toLowerCase();
  if (!['off', 'summary', 'json'].includes(traceMode)) {
    throw new Error(`Unsupported --trace '${traceMode}'. Use off, summary, or json.`);
  }
  const traceMaxSpans = parseIntOpt(args['trace-max-spans'], '--trace-max-spans') ?? 24;
  const containsPreview = parseIntOpt(args['contains-preview'], '--contains-preview') ?? 20;
  const traceFile = args['trace-file'] ? path.resolve(String(args['trace-file'])) : null;
  const outFile = args['out-file'] ? path.resolve(String(args['out-file'])) : null;
  const fullResult = args['full-result'] === true;
  const disablePushdown = args['disable-pushdown'] === true;

  const hasExplicitVsInput = !!(args['vs-file'] || args['vs-json'] || args.include || args.system);
  let vsJson = hasExplicitVsInput ? buildVs(args) : null;

  let paramsResource;
  if (args['params-file']) {
    paramsResource = loadJsonFile(String(args['params-file']));
  } else if (args['params-json']) {
    paramsResource = parseJson(String(args['params-json']), '--params-json');
  } else {
    paramsResource = { resourceType: 'Parameters', parameter: [] };
  }
  if (!paramsResource || paramsResource.resourceType !== 'Parameters') {
    throw new Error('Parameters input must be a Parameters resource (resourceType=Parameters)');
  }

  const params = Array.isArray(paramsResource.parameter) ? [...paramsResource.parameter] : [];
  const count = parseIntOpt(args.count, '--count');
  const offset = parseIntOpt(args.offset, '--offset');
  const limit = parseIntOpt(args.limit, '--limit');
  const filter = args.filter !== undefined ? String(args.filter) : null;
  const urlParam = args['url-param'] !== undefined ? String(args['url-param']) : null;
  const valueSetVersion = args['value-set-version'] !== undefined ? String(args['value-set-version']) : null;

  if (count !== undefined) params.push({ name: 'count', valueInteger: count });
  if (offset !== undefined) params.push({ name: 'offset', valueInteger: offset });
  if (limit !== undefined) params.push({ name: 'limit', valueInteger: limit });
  if (filter !== null) params.push({ name: 'filter', valueString: filter });
  if (urlParam) params.push({ name: 'url', valueUri: urlParam });
  if (valueSetVersion) params.push({ name: 'valueSetVersion', valueString: valueSetVersion });
  for (const [idx, p] of listify(args.param).entries()) {
    params.push(parseJson(String(p), `--param[${idx}]`));
  }
  paramsResource = { resourceType: 'Parameters', parameter: params };

  const txResourceFiles = listify(args['tx-resource-file']);
  const txResourceJson = listify(args['tx-resource-json']);
  const txResources = [];
  for (const rf of txResourceFiles) txResources.push(...loadResourceFile(String(rf)));
  for (const [idx, rj] of txResourceJson.entries()) {
    const parsed = parseJson(String(rj), `--tx-resource-json[${idx}]`);
    if (Array.isArray(parsed)) txResources.push(...parsed);
    else txResources.push(parsed);
  }
  for (const p of params) {
    if (p?.name === 'tx-resource' && p.resource) txResources.push(p.resource);
  }

  const { ExpandWorker, ValueSetExpander } = WORKER_MODULES[impl];
  const { library, provider } = await setupLibrary();

  const prevPushdown = process.env.EXPAND_V2_DISABLE_PUSHDOWN;
  if (disablePushdown) process.env.EXPAND_V2_DISABLE_PUSHDOWN = '1';
  else delete process.env.EXPAND_V2_DISABLE_PUSHDOWN;

  try {
    const opContext = new OperationContext('en', library.i18n, null, 120);
    const worker = new ExpandWorker(opContext, log, provider, library.languageDefinitions, library.i18n);

    if (typeof worker.setupAdditionalResources === 'function') {
      worker.setupAdditionalResources(paramsResource);
    }
    if (txResources.length > 0) {
      const wrapped = txResources
        .map(res => worker.wrapRawResource ? worker.wrapRawResource(res) : null)
        .filter(Boolean);
      worker.additionalResources = (worker.additionalResources || []).concat(wrapped);
    }

    const txp = new TxParameters(library.languageDefinitions, library.i18n, false);
    txp.readParams(paramsResource);
    const normalizeNum = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
    const effectiveCount = normalizeNum(txp.count ?? firstParamPrimitive(params, 'count'));
    const effectiveOffset = normalizeNum(txp.offset ?? firstParamPrimitive(params, 'offset'));
    const effectiveLimit = normalizeNum(txp.limit ?? firstParamPrimitive(params, 'limit'));
    const effectiveFilter = txp.filter ?? firstParamPrimitive(params, 'filter');

    const findParam = (name) => params.find(p => p?.name === name);
    if (!vsJson) {
      const vsParam = findParam('valueSet');
      if (vsParam?.resource) vsJson = vsParam.resource;
    }

    let resolvedFromUrl = null;
    if (!vsJson) {
      const up = findParam('url');
      if (up) {
        const url = up.valueUri || up.valueCanonical || up.valueString || null;
        if (!url) throw new Error('url parameter provided but no valueUri/valueCanonical/valueString present');
        const vp = findParam('valueSetVersion');
        const version = vp ? (vp.valueString || vp.valueUri || vp.valueCanonical || null) : null;
        const found = await worker.findValueSet(url, version);
        if (!found) {
          throw new Error(version ? `ValueSet not found: ${url} version ${version}` : `ValueSet not found: ${url}`);
        }
        resolvedFromUrl = { url, version };
        vsJson = found.jsonObj || found;
      }
    }

    if (!vsJson) {
      throw new Error('Need one of: explicit ValueSet (--vs-file/--vs-json/--include/--system), Parameters.valueSet, or Parameters.url');
    }

    const vs = new ValueSet(vsJson.jsonObj || vsJson);
    const expander = new ValueSetExpander(worker, txp);
    const searchFilter = new SearchFilterText(txp.filter || filter);

    const t0 = performance.now();
    let result;
    let traceJson = null;
    if (traceMode !== 'off') {
      const trace = new ExpandTrace();
      result = await traceStore.run(trace, () => expander.expand(vs, searchFilter, false));
      traceJson = trace.toJSON();
    } else {
      result = await expander.expand(vs, searchFilter, false);
    }
    const ms = Math.round(performance.now() - t0);

    const flat = flattenContains(result?.expansion?.contains || []);
    const output = {
      impl,
      disablePushdown,
      ms,
      request: {
        count: effectiveCount ?? null,
        offset: effectiveOffset ?? null,
        limit: effectiveLimit ?? null,
        filter: effectiveFilter ?? null,
        parameterCount: params.length,
        txResourceCount: txResources.length,
        paramNames: params.map(p => p.name),
        resolvedFromUrl,
        compose: vsJson?.compose || null,
      },
      expansion: {
        total: result?.expansion?.total ?? null,
        rootCount: (result?.expansion?.contains || []).length,
        flatCount: flat.length,
        firstCodes: flat.slice(0, containsPreview).map(c => ({
          system: c.system || null,
          version: c.version || null,
          code: c.code || null,
          display: c.display || null,
        })),
        lastCodes: flat.slice(Math.max(0, flat.length - containsPreview)).map(c => ({
          system: c.system || null,
          version: c.version || null,
          code: c.code || null,
          display: c.display || null,
        })),
      },
    };

    if (fullResult) {
      output.result = result;
    }

    if (traceMode === 'summary') {
      output.traceSummary = traceJson ? formatTraceSummary(traceJson, { maxSpans: traceMaxSpans }) : null;
    } else if (traceMode === 'json') {
      output.trace = traceJson;
    }

    const rendered = JSON.stringify(output, null, 2);
    console.log(rendered);

    if (outFile) {
      fs.writeFileSync(outFile, rendered + '\n');
    }
    if (traceFile && traceJson) {
      if (traceMode === 'summary') {
        fs.writeFileSync(traceFile, (output.traceSummary || '') + '\n');
      } else {
        fs.writeFileSync(traceFile, JSON.stringify(traceJson, null, 2) + '\n');
      }
    }
  } finally {
    if (prevPushdown === undefined) delete process.env.EXPAND_V2_DISABLE_PUSHDOWN;
    else process.env.EXPAND_V2_DISABLE_PUSHDOWN = prevPushdown;
  }
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exit(2);
});
