#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { TX_HARNESS_CASES } from './tx-harness-cases/index.mjs';

const SEARCH_ROOTS = [
  'tmp/tx-harness-runs',
  'docs/perf',
];

const FIELD_LABELS = {
  result: 'result',
  display: 'display',
  message: 'message',
  code: 'code',
  system: 'system',
  version: 'version',
  name: 'name',
  propertyCount: 'propertyCount',
};

const FLAG_WEIGHTS = {
  'primary-transport-error': 110,
  'primary-http-error': 105,
  'primary-aborted': 100,
  'primary-unsupported': 95,
  'primary-too-costly': 90,
  'primary-assertion-failed': 85,
  'secondary-transport-error': 80,
  'secondary-http-error': 75,
  'secondary-aborted': 70,
  'secondary-unsupported': 65,
  'secondary-too-costly': 60,
  'secondary-assertion-failed': 55,
  'third-transport-error': 75,
  'third-http-error': 70,
  'third-aborted': 65,
  'third-unsupported': 60,
  'third-too-costly': 55,
  'third-assertion-failed': 50,
  'status-mismatch': 45,
  'resource-type-mismatch': 45,
  'issue-code-mismatch': 35,
  'issue-text-mismatch': 20,
  'params-result-mismatch': 40,
  'params-display-mismatch': 32,
  'params-message-mismatch': 28,
  'params-code-mismatch': 20,
  'params-system-mismatch': 20,
  'params-version-mismatch': 18,
  'params-name-mismatch': 18,
  'params-propertyCount-mismatch': 18,
  'params-other-mismatch': 15,
  'expand-total-mismatch': 20,
  'expand-page-size-mismatch': 18,
  'expand-order-mismatch': 6,
  aligned: 0,
};

function usage() {
  console.log(`Usage: node scripts/analyze-tx-harness-diffs.mjs [run-dir] [options]

Options:
  --run-dir <path>         Analyze a specific harness run directory
  --kind <kind[,kind]>     Filter rows by kind: expand, lookup, validate
  --flag <flag[,flag]>     Filter rows that include one or more flags
  --limit <n>              Number of example rows to print (default: 8)
  --unreviewed             Show only rows without a review marker
  --deferred               Show only rows whose review status is deferred
  --json                   Emit machine-readable JSON instead of text
  --include-aligned        Include aligned rows in the filtered output
  --help                   Show this message
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    runDir: null,
    kinds: [],
    flags: [],
    limit: 8,
    json: false,
    includeAligned: false,
    unreviewed: false,
    deferred: false,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--include-aligned') {
      options.includeAligned = true;
      continue;
    }
    if (arg === '--unreviewed') {
      options.unreviewed = true;
      continue;
    }
    if (arg === '--deferred') {
      options.deferred = true;
      continue;
    }
    if (arg === '--run-dir') {
      options.runDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--kind') {
      options.kinds.push(...splitCsv(argv[i + 1]));
      i += 1;
      continue;
    }
    if (arg === '--flag') {
      options.flags.push(...splitCsv(argv[i + 1]));
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      options.limit = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (!Number.isInteger(options.limit) || options.limit < 0) {
    fail(`Invalid --limit value: ${options.limit}`);
  }

  if (!options.runDir && positional.length > 0) {
    options.runDir = positional[0];
  }

  if (options.unreviewed && options.deferred) {
    fail('Choose at most one of --unreviewed or --deferred.');
  }

  return options;
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function discoverRunDir(explicitRunDir) {
  if (explicitRunDir) {
    const resolved = path.resolve(explicitRunDir);
    ensureCatalog(resolved);
    return resolved;
  }

  const candidates = [];
  for (const root of SEARCH_ROOTS) {
    const resolvedRoot = path.resolve(root);
    if (!fs.existsSync(resolvedRoot)) {
      continue;
    }
    for (const entry of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const runDir = path.join(resolvedRoot, entry.name);
      const catalogPath = path.join(runDir, 'perf-table.catalog.json');
      if (!fs.existsSync(catalogPath)) {
        continue;
      }
      const stat = fs.statSync(catalogPath);
      candidates.push({
        runDir,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  if (candidates.length === 0) {
    fail('No harness run directory with perf-table.catalog.json was found.');
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.runDir.localeCompare(left.runDir));
  return candidates[0].runDir;
}

function ensureCatalog(runDir) {
  const catalogPath = path.join(runDir, 'perf-table.catalog.json');
  if (!fs.existsSync(catalogPath)) {
    fail(`No perf-table.catalog.json found in ${runDir}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeReviewMeta(review) {
  if (!review) return null;
  if (typeof review === 'string') {
    const note = review.trim();
    return note ? { status: 'reviewed', reviewedAt: null, note } : null;
  }
  if (typeof review !== 'object') return null;
  const status = String(review.status || 'reviewed').trim() || 'reviewed';
  const reviewedAt = review.reviewedAt ? String(review.reviewedAt).trim() : null;
  const note = review.note ? String(review.note).trim() : null;
  if (!reviewedAt && !note && status === 'reviewed') {
    return { status, reviewedAt: null, note: null };
  }
  return { status, reviewedAt, note };
}

function formatReviewLabel(review) {
  if (!review) return null;
  const bits = [];
  bits.push(review.status || 'reviewed');
  if (review.reviewedAt) bits.push(review.reviewedAt);
  if (review.note) bits.push(review.note);
  return bits.join(': ');
}

function isDeferredReview(review) {
  return !!review && String(review.status || '').trim().toLowerCase() === 'deferred';
}

const SOURCE_REVIEW_BY_KEY = buildSourceReviewMap();

function buildSourceReviewMap() {
  const map = new Map();
  for (const caseDef of TX_HARNESS_CASES) {
    const review = normalizeReviewMeta(caseDef.review);
    if (!review) continue;
    const kind = String(caseDef.kind || '').trim().toLowerCase();
    const name = String(caseDef.name || '').trim();
    if (!kind || !name) continue;
    map.set(`${kind}::${name}`, review);
    map.set(`${kind}: ${name}`, review);
  }
  return map;
}

function resolveReview(row) {
  const catalogReview = normalizeReviewMeta(row.review);
  if (catalogReview) return catalogReview;
  const kind = String(row.kind || '').trim().toLowerCase();
  const name = String(row.name || '').trim();
  const rawName = String(row.rawName || '').trim();
  return SOURCE_REVIEW_BY_KEY.get(`${kind}::${name}`) || SOURCE_REVIEW_BY_KEY.get(rawName) || null;
}

function scalarValue(parameter) {
  for (const [key, value] of Object.entries(parameter || {})) {
    if (key.startsWith('value')) {
      return value;
    }
  }
  return undefined;
}

function extractParameterSummary(parametersBody) {
  const valuesByName = {};
  for (const parameter of parametersBody?.parameter || []) {
    if (parameter.name === 'trace') {
      continue;
    }
    const value = scalarValue(parameter);
    if (value === undefined) {
      continue;
    }
    if (valuesByName[parameter.name] === undefined) {
      valuesByName[parameter.name] = value;
    } else if (Array.isArray(valuesByName[parameter.name])) {
      valuesByName[parameter.name].push(value);
    } else {
      valuesByName[parameter.name] = [valuesByName[parameter.name], value];
    }
  }
  return {
    result: valuesByName.result,
    display: valuesByName.display,
    message: valuesByName.message,
    code: valuesByName.code,
    system: valuesByName.system,
    version: valuesByName.version,
    name: valuesByName.name,
    propertyCount: (parametersBody?.parameter || []).filter((parameter) => parameter.name === 'property').length,
  };
}

function summarizeResponse(kind, response) {
  if (!response) {
    return null;
  }

  const body = response.body || {};
  const resourceType = body.resourceType || null;
  const summary = {
    status: response.status ?? null,
    resourceType,
  };

  if (resourceType === 'OperationOutcome') {
    const issue = body.issue?.[0] || {};
    summary.issueCode = issue.code || null;
    summary.issueText = issue.details?.text || issue.diagnostics || null;
    return summary;
  }

  if (resourceType === 'Parameters') {
    return {
      ...summary,
      ...extractParameterSummary(body),
    };
  }

  if (resourceType === 'ValueSet') {
    const contains = body.expansion?.contains || [];
    return {
      ...summary,
      total: body.expansion?.total ?? null,
      containsCount: contains.length,
      firstCodes: contains.slice(0, 5).map((concept) => `${concept.system || ''}|${concept.code || ''}`),
    };
  }

  return summary;
}

function classifyTarget(target, kind) {
  const response = target.debug?.response || null;
  const error = target.debug?.error || target.perf?.error || null;
  const errorText = String(error || '').toLowerCase();
  const summary = summarizeResponse(kind, response);
  let status = 'ok';

  if (target.supported === false) {
    status = 'unsupported';
  } else if (!response && (errorText.includes('aborted') || errorText.includes('timeout'))) {
    status = 'aborted';
  } else if (!response && error) {
    status = 'transport-error';
  } else if (
    response &&
    response.ok === false &&
    summary?.resourceType === 'OperationOutcome' &&
    summary.issueCode === 'too-costly'
  ) {
    status = 'too-costly';
  } else if (response && response.ok === false) {
    status = 'http-error';
  } else if (target.debug?.ok === false) {
    status = 'assertion-failed';
  }

  return {
    key: target.key,
    label: target.label,
    supported: target.supported,
    status,
    error,
    ms: target.perf?.ms ?? target.debug?.ms ?? null,
    summary,
  };
}

function uniqueValues(items) {
  return new Set(items.map((item) => JSON.stringify(item)));
}

function compareTargets(kind, targetStates) {
  const responseBearingStates = targetStates.filter((state) => state.summary);
  if (responseBearingStates.length < 2) {
    return [];
  }

  const flags = [];
  if (uniqueValues(responseBearingStates.map((state) => state.summary.status)).size > 1) {
    flags.push('status-mismatch');
  }
  if (uniqueValues(responseBearingStates.map((state) => state.summary.resourceType)).size > 1) {
    flags.push('resource-type-mismatch');
  }

  const outcomeStates = responseBearingStates.filter((state) => state.summary.resourceType === 'OperationOutcome');
  if (
    outcomeStates.length >= 2 &&
    uniqueValues(outcomeStates.map((state) => state.summary.issueCode)).size > 1
  ) {
    flags.push('issue-code-mismatch');
  }
  if (
    outcomeStates.length >= 2 &&
    uniqueValues(outcomeStates.map((state) => state.summary.issueText)).size > 1
  ) {
    flags.push('issue-text-mismatch');
  }

  if (kind === 'expand') {
    if (uniqueValues(responseBearingStates.map((state) => state.summary.total)).size > 1) {
      flags.push('expand-total-mismatch');
    }
    if (uniqueValues(responseBearingStates.map((state) => state.summary.containsCount)).size > 1) {
      flags.push('expand-page-size-mismatch');
    }
    if (uniqueValues(responseBearingStates.map((state) => state.summary.firstCodes || [])).size > 1) {
      flags.push('expand-order-mismatch');
    }
    return flags;
  }

  if (kind === 'lookup' || kind === 'validate') {
    for (const field of Object.keys(FIELD_LABELS)) {
      if (uniqueValues(responseBearingStates.map((state) => state.summary[field])).size > 1) {
        flags.push(`params-${field}-mismatch`);
      }
    }
    if (
      flags.length === 0 &&
      uniqueValues(responseBearingStates.map((state) => state.summary)).size > 1
    ) {
      flags.push('params-other-mismatch');
    }
    return flags;
  }

  return flags;
}

function scoreFlags(flags) {
  return flags.reduce((total, flag) => total + (FLAG_WEIGHTS[flag] || 10), 0);
}

function buildRowAnalysis(row, detail, runDir) {
  const review = resolveReview(row);
  const targetStates = detail.targets.map((target) => classifyTarget(target, row.kind));
  const flags = [];
  const distinctStatuses = new Set(targetStates.map((targetState) => targetState.status));

  if (distinctStatuses.size > 1) {
    for (const targetState of targetStates) {
      if (targetState.status !== 'ok') {
        flags.push(`${targetState.key}-${targetState.status}`);
      }
    }
  }

  flags.push(...compareTargets(row.kind, targetStates));

  const dedupedFlags = [...new Set(flags)];
  if (dedupedFlags.length === 0) {
    dedupedFlags.push('aligned');
  }

  const signature = dedupedFlags.join(' + ');
  return {
    id: row.id,
    name: row.name,
    rawName: row.rawName,
    kind: row.kind,
    category: row.category,
    review,
    reviewLabel: formatReviewLabel(review),
    harnessStatus: row.status,
    harnessOk: row.ok,
    flags: dedupedFlags,
    signature,
    score: scoreFlags(dedupedFlags),
    inputJsonPath: path.resolve(runDir, row.inputHref),
    detailJsonPath: path.resolve(runDir, row.detailJsonHref),
    detailHtmlPath: path.resolve(runDir, row.detailHref),
    targets: targetStates,
  };
}

function analyzeRun(runDir) {
  const catalogPath = path.join(runDir, 'perf-table.catalog.json');
  const catalog = readJson(catalogPath);
  const detailDir = path.join(runDir, 'perf-table.details');
  const rowsById = new Map(catalog.rows.map((row) => [row.id, row]));
  const analyses = [];

  for (const fileName of fs.readdirSync(detailDir).filter((entry) => entry.endsWith('.json')).sort()) {
    const detailPath = path.join(detailDir, fileName);
    const detail = readJson(detailPath);
    const row = rowsById.get(detail.rowIndex);
    if (!row) {
      continue;
    }
    analyses.push(buildRowAnalysis(row, detail, runDir));
  }

  const flagCounts = {};
  const signatureCounts = {};
  const kindCounts = {};

  for (const analysis of analyses) {
    signatureCounts[analysis.signature] = (signatureCounts[analysis.signature] || 0) + 1;
    kindCounts[analysis.kind] = kindCounts[analysis.kind] || {};
    kindCounts[analysis.kind][analysis.signature] = (kindCounts[analysis.kind][analysis.signature] || 0) + 1;
    for (const flag of analysis.flags) {
      flagCounts[flag] = (flagCounts[flag] || 0) + 1;
    }
  }

  return {
    runDir,
    rowCount: analyses.length,
    analyses,
    flagCounts,
    signatureCounts,
    kindCounts,
  };
}

function filterAnalyses(analyses, options) {
  return analyses
    .filter((analysis) => {
      if (!options.includeAligned && analysis.flags.length === 1 && analysis.flags[0] === 'aligned') {
        return false;
      }
      if (options.kinds.length > 0 && !options.kinds.includes(analysis.kind)) {
        return false;
      }
      if (options.unreviewed && analysis.review) {
        return false;
      }
      if (options.deferred && !isDeferredReview(analysis.review)) {
        return false;
      }
      if (options.flags.length > 0 && !options.flags.some((flag) => analysis.flags.includes(flag))) {
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.id - right.id;
    });
}

function pickExamples(analyses, limit) {
  const examples = [];
  const seenSignatures = new Set();

  for (const analysis of analyses) {
    if (seenSignatures.has(analysis.signature)) {
      continue;
    }
    seenSignatures.add(analysis.signature);
    examples.push(analysis);
    if (examples.length >= limit) {
      break;
    }
  }

  return examples;
}

function formatValue(value) {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatValue(entry)).join(', ')}]`;
  }
  return String(value);
}

function formatSummary(targetState) {
  if (!targetState.summary) {
    return targetState.error ? `error=${JSON.stringify(targetState.error)}` : 'no-response';
  }

  const summary = targetState.summary;
  const parts = [`${summary.status}`, summary.resourceType];
  if (summary.resourceType === 'OperationOutcome') {
    if (summary.issueCode) {
      parts.push(`issue=${summary.issueCode}`);
    }
    if (summary.issueText) {
      parts.push(`text=${JSON.stringify(summary.issueText)}`);
    }
    return parts.join(' ');
  }

  if (summary.resourceType === 'Parameters') {
    for (const field of Object.keys(FIELD_LABELS)) {
      if (summary[field] !== undefined) {
        parts.push(`${FIELD_LABELS[field]}=${formatValue(summary[field])}`);
      }
    }
    return parts.join(' ');
  }

  if (summary.resourceType === 'ValueSet') {
    if (summary.total !== undefined) {
      parts.push(`total=${formatValue(summary.total)}`);
    }
    if (summary.containsCount !== undefined) {
      parts.push(`contains=${formatValue(summary.containsCount)}`);
    }
    if (summary.firstCodes?.length) {
      parts.push(`first=${formatValue(summary.firstCodes)}`);
    }
    return parts.join(' ');
  }

  return parts.join(' ');
}

function sortCountEntries(counts) {
  return Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function printTextReport(report, filteredAnalyses, options) {
  const selectedReport = buildJsonReport(report, filteredAnalyses);
  console.log(`Run: ${report.runDir}`);
  console.log(`Rows analyzed: ${report.rowCount}`);
  console.log(`Rows selected: ${filteredAnalyses.length}`);
  console.log('');
  console.log('Flag counts:');
  for (const [flag, count] of sortCountEntries(selectedReport.flagCounts)) {
    if (!options.includeAligned && flag === 'aligned') {
      continue;
    }
    console.log(`  ${flag.padEnd(28)} ${count}`);
  }

  console.log('');
  console.log('Top signatures:');
  for (const [signature, count] of sortCountEntries(selectedReport.signatureCounts).slice(0, 12)) {
    if (!options.includeAligned && signature === 'aligned') {
      continue;
    }
    console.log(`  ${count.toString().padStart(3)}  ${signature}`);
  }

  if (filteredAnalyses.length === 0 || options.limit === 0) {
    return;
  }

  const examples = pickExamples(filteredAnalyses, options.limit);
  console.log('');
  console.log('Examples:');
  for (const analysis of examples) {
    console.log(`  #${analysis.id} ${analysis.kind} ${analysis.name}`);
    console.log(`    flags: ${analysis.flags.join(', ')}`);
    if (analysis.reviewLabel) {
      console.log(`    review: ${analysis.reviewLabel}`);
    }
    for (const target of analysis.targets) {
      console.log(`    ${target.key}: ${target.status} ${formatSummary(target)}`);
    }
    console.log(`    input: ${analysis.inputJsonPath}`);
    console.log(`    detail: ${analysis.detailJsonPath}`);
  }
}

function buildJsonReport(report, filteredAnalyses) {
  const selectedFlagCounts = {};
  const selectedSignatureCounts = {};

  for (const analysis of filteredAnalyses) {
    selectedSignatureCounts[analysis.signature] = (selectedSignatureCounts[analysis.signature] || 0) + 1;
    for (const flag of analysis.flags) {
      selectedFlagCounts[flag] = (selectedFlagCounts[flag] || 0) + 1;
    }
  }

  return {
    runDir: report.runDir,
    rowCount: report.rowCount,
    selectedRowCount: filteredAnalyses.length,
    flagCounts: selectedFlagCounts,
    signatureCounts: selectedSignatureCounts,
    allFlagCounts: report.flagCounts,
    allSignatureCounts: report.signatureCounts,
    rows: filteredAnalyses,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = discoverRunDir(options.runDir);
  const report = analyzeRun(runDir);
  const filteredAnalyses = filterAnalyses(report.analyses, options);

  if (options.json) {
    console.log(JSON.stringify(buildJsonReport(report, filteredAnalyses), null, 2));
    return;
  }

  printTextReport(report, filteredAnalyses, options);
}

main();
