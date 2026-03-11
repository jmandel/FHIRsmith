#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.dirname(SCRIPTS_DIR);
const RUNNER_SCRIPT = path.join(SCRIPTS_DIR, 'run-tx-review-agent-batch.sh');
const ANALYZE_SCRIPT = path.join(SCRIPTS_DIR, 'analyze-tx-harness-diffs.mjs');

function usage() {
  console.log(`Usage: node scripts/build-tx-review-batch.mjs [run-dir] [options]

Options:
  --run-dir <path>         Harness run directory to package
  --out-dir <path>         Output directory for the review batch
  --batch-name <name>      Friendly name recorded in batch metadata
  --kind <kind[,kind]>     Filter by kind: expand, lookup, validate
  --flag <flag[,flag]>     Filter by diff flag(s)
  --ids <id[,id]>          Select exact row ids after filtering
  --limit <n>              Max issues to export (default: 8)
  --unreviewed             Export only rows without a review marker
  --deferred               Export only rows whose review status is deferred
  --include-aligned        Include aligned rows in the source analysis
  --help                   Show this message
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    runDir: null,
    outDir: null,
    batchName: null,
    kinds: [],
    flags: [],
    ids: [],
    limit: 8,
    unreviewed: false,
    deferred: false,
    includeAligned: false,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--run-dir') {
      options.runDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--out-dir') {
      options.outDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--batch-name') {
      options.batchName = argv[i + 1];
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
    if (arg === '--ids') {
      options.ids.push(...splitCsv(argv[i + 1]));
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      options.limit = Number.parseInt(argv[i + 1], 10);
      i += 1;
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
    if (arg === '--include-aligned') {
      options.includeAligned = true;
      continue;
    }
    if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (!options.runDir && positional.length > 0) {
    options.runDir = positional[0];
  }

  if (!Number.isInteger(options.limit) || options.limit < 0) {
    fail(`Invalid --limit value: ${options.limit}`);
  }

  if (options.unreviewed && options.deferred) {
    fail('Choose at most one of --unreviewed or --deferred.');
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.writeFileSync(filePath, value);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'issue';
}

function timestampToken(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function defaultBatchName(runDir) {
  return `${path.basename(runDir)}-review-batch-${timestampToken()}`;
}

function buildAnalyzeArgs(options) {
  const args = [ANALYZE_SCRIPT];
  if (options.runDir) {
    args.push(options.runDir);
  }
  if (options.kinds.length > 0) {
    args.push('--kind', options.kinds.join(','));
  }
  if (options.flags.length > 0) {
    args.push('--flag', options.flags.join(','));
  }
  if (options.unreviewed) {
    args.push('--unreviewed');
  }
  if (options.deferred) {
    args.push('--deferred');
  }
  if (options.includeAligned) {
    args.push('--include-aligned');
  }
  args.push('--json');
  return args;
}

function runAnalysis(options) {
  const result = spawnSync(process.execPath, buildAnalyzeArgs(options), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`Diff analysis failed${detail ? `:\n${detail}` : ''}`);
  }
  return JSON.parse(result.stdout);
}

function selectRows(analysis, options) {
  let rows = Array.isArray(analysis.rows) ? [...analysis.rows] : [];
  if (options.ids.length > 0) {
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    rows = options.ids.map((id) => {
      const row = byId.get(String(id));
      if (!row) {
        fail(`Row id ${id} was not present in the filtered analysis set.`);
      }
      return row;
    });
  } else if (options.limit > 0) {
    rows = rows.slice(0, options.limit);
  } else {
    rows = [];
  }
  return rows;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function extractRequestFacts(request) {
  const queryParamNames = [];
  const pathValue = String(request?.path || '');
  const queryIndex = pathValue.indexOf('?');
  if (queryIndex >= 0 && queryIndex + 1 < pathValue.length) {
    const searchParams = new URLSearchParams(pathValue.slice(queryIndex + 1));
    for (const [name] of searchParams.entries()) {
      queryParamNames.push(name);
    }
  }

  const bodyParameterEntries = [];
  const inlineResourceTypes = [];
  const valueKinds = [];
  const parameterArray = Array.isArray(request?.body?.parameter) ? request.body.parameter : [];
  for (const parameter of parameterArray) {
    const name = String(parameter?.name || '').trim();
    if (!name) {
      continue;
    }
    const keys = Object.keys(parameter).filter((key) => key !== 'name');
    const detailKey = keys[0] || '';
    if (detailKey === 'resource' && parameter.resource?.resourceType) {
      const resourceType = String(parameter.resource.resourceType);
      bodyParameterEntries.push(`${name}=resource:${resourceType}`);
      inlineResourceTypes.push(resourceType);
      valueKinds.push(`resource:${resourceType}`);
      continue;
    }
    bodyParameterEntries.push(detailKey ? `${name}=${detailKey}` : name);
    if (detailKey) {
      valueKinds.push(detailKey);
    }
  }

  return {
    queryParamNames: uniqueStrings(queryParamNames),
    bodyParameterEntries: uniqueStrings(bodyParameterEntries),
    inlineResourceTypes: uniqueStrings(inlineResourceTypes),
    valueKinds: uniqueStrings(valueKinds),
    usesParametersResource: request?.body?.resourceType === 'Parameters',
  };
}

function resourceSpecRefs(resourceType) {
  if (resourceType === 'ValueSet') {
    return [
      { label: 'ValueSet resource page', url: 'https://build.fhir.org/valueset.html' },
      { label: 'ValueSet definitions', url: 'https://build.fhir.org/valueset-definitions.html' },
    ];
  }
  if (resourceType === 'CodeSystem') {
    return [
      { label: 'CodeSystem resource page', url: 'https://build.fhir.org/codesystem.html' },
      { label: 'CodeSystem definitions', url: 'https://build.fhir.org/codesystem-definitions.html' },
    ];
  }
  if (resourceType === 'Parameters') {
    return [
      { label: 'Parameters resource page', url: 'https://build.fhir.org/parameters.html' },
      { label: 'Parameters definitions', url: 'https://build.fhir.org/parameters-definitions.html' },
    ];
  }
  return [];
}

function detectOperation(inputDoc) {
  const request = inputDoc?.source?.request || {};
  const pathValue = String(request.path || '');
  if (pathValue.includes('/ValueSet/$expand')) {
    return {
      txEndpointHint: 'https://tx.fhir.org/r4/ValueSet/$expand',
      specFocus: 'ValueSet $expand',
      operationPageUrl: 'https://build.fhir.org/valueset-operation-expand.html',
      primaryResourceType: 'ValueSet',
    };
  }
  if (pathValue.includes('/ValueSet/') && pathValue.includes('$validate-code')) {
    return {
      txEndpointHint: 'https://tx.fhir.org/r4/ValueSet/$validate-code',
      specFocus: 'ValueSet $validate-code',
      operationPageUrl: 'https://build.fhir.org/valueset-operation-validate-code.html',
      primaryResourceType: 'ValueSet',
    };
  }
  if (pathValue.includes('/CodeSystem/') && pathValue.includes('$validate-code')) {
    return {
      txEndpointHint: 'https://tx.fhir.org/r4/CodeSystem/$validate-code',
      specFocus: 'CodeSystem $validate-code',
      operationPageUrl: 'https://build.fhir.org/codesystem-operation-validate-code.html',
      primaryResourceType: 'CodeSystem',
    };
  }
  if (pathValue.includes('/CodeSystem/') && pathValue.includes('$lookup')) {
    return {
      txEndpointHint: 'https://tx.fhir.org/r4/CodeSystem/$lookup',
      specFocus: 'CodeSystem $lookup',
      operationPageUrl: 'https://build.fhir.org/codesystem-operation-lookup.html',
      primaryResourceType: 'CodeSystem',
    };
  }
  return {
    txEndpointHint: 'https://tx.fhir.org/r4',
    specFocus: 'FHIR terminology operation',
    operationPageUrl: 'https://build.fhir.org/',
    primaryResourceType: null,
  };
}

function targetDebugByKey(detailDoc) {
  const map = new Map();
  for (const target of detailDoc?.targets || []) {
    map.set(target.key, target);
  }
  return map;
}

function buildIssuePrompt({ batchName, row, inputDoc, issueRelDir, operation }) {
  const request = inputDoc?.source?.request || {};
  const requestFacts = extractRequestFacts(request);
  const flags = Array.isArray(row.flags) && row.flags.length > 0 ? row.flags.join(', ') : 'none';
  const targetLines = (row.targets || [])
    .map((target) => {
      const summary = JSON.stringify(target.summary || null);
      return `- ${target.key} (${target.label}): status=${target.status}; supported=${target.supported}; summary=${summary}`;
    })
    .join('\n');
  const specRefs = [];
  if (operation.operationPageUrl) {
    specRefs.push({ label: 'Operation page', url: operation.operationPageUrl });
  }
  if (operation.primaryResourceType) {
    specRefs.push(...resourceSpecRefs(operation.primaryResourceType));
  }
  if (requestFacts.usesParametersResource) {
    specRefs.push(...resourceSpecRefs('Parameters'));
  }
  for (const resourceType of requestFacts.inlineResourceTypes) {
    specRefs.push(...resourceSpecRefs(resourceType));
  }
  if (
    requestFacts.valueKinds.some((kind) => kind.startsWith('value'))
    || requestFacts.queryParamNames.length > 0
  ) {
    specRefs.push(
      { label: 'FHIR datatypes', url: 'https://build.fhir.org/datatypes.html' },
      { label: 'FHIR datatype definitions', url: 'https://build.fhir.org/datatypes-definitions.html' },
    );
  }
  specRefs.push(
    { label: 'OperationOutcome resource page', url: 'https://build.fhir.org/operationoutcome.html' },
    { label: 'OperationOutcome definitions', url: 'https://build.fhir.org/operationoutcome-definitions.html' },
  );
  const specRefLines = uniqueStrings(specRefs.map((ref) => `${ref.label}: ${ref.url}`))
    .map((line) => `- ${line}`)
    .join('\n');
  const requestShapeLines = [
    `- Query parameter names in the saved request path: ${requestFacts.queryParamNames.join(', ') || 'none'}`,
    `- POST Parameters entries in the saved request body: ${requestFacts.bodyParameterEntries.join(', ') || 'none'}`,
    `- Inline resource types carried in the request: ${requestFacts.inlineResourceTypes.join(', ') || 'none'}`,
  ].join('\n');

  return `# Review Task

You are reviewing a saved terminology diff from the FHIRsmith perf harness.

## Local Context

- Batch: ${batchName}
- Issue folder: ${issueRelDir}
- Row: #${row.id} ${row.name}
- Kind: ${row.kind}
- Category: ${row.category}
- Flags: ${flags}
- Existing review marker: ${row.reviewLabel || 'none'}
- Harness status: ${row.harnessStatus}
- Request method/path: ${request.method || 'unknown'} ${request.path || 'unknown'}
- tx.fhir.org hint: ${operation.txEndpointHint}
- Spec focus: ${operation.specFocus}

## Problem Framing

This issue is about a FHIR terminology server operation such as \`$lookup\`, \`$validate-code\`, or \`$expand\`. The saved local artifacts come from different implementations of the same terminology behavior, and the purpose of this review is to decide whether any difference is materially meaningful.

We do not assume that every difference is important. Small incidental differences are often expected and should usually be treated as non-semantic unless they affect the practical meaning of the result. Examples of usually low-signal differences include:

- timestamps or elapsed times
- request IDs, trace IDs, or server-specific headers
- generated HTML formatting
- ordering differences that the specification leaves open
- wording differences in error text when the semantic outcome is still the same

The main thing to look for is meaningful semantic disagreement, for example:

- one implementation accepts a request shape that another rejects
- one implementation ignores or applies a parameter differently
- one implementation returns a different code, system, version, display, or validation result
- one implementation handles inline resources or supplements correctly while another does not
- one implementation is unsupported or times out while another returns a substantively correct answer

## Local Artifacts

- \`issue.json\`: batch metadata, row summaries, absolute paths to the original run artifacts
- \`input.json\`: canonical saved input for this row
- \`detail.json\`: full saved multi-target execution details
- \`detail.html\`: saved side-by-side detail page from the perf run
- \`outputs/<target>/request.json\`: exact request sent to that local target
- \`outputs/<target>/response.json\`: raw HTTP response captured from that local target
- \`outputs/<target>/trace.json\`: local trace payload when available
- \`outputs/<target>/plan.txt\`: IR plan text when available
- \`report-template.md\`: optional structure to copy into \`report.md\`

## Saved Request Shape

${requestShapeLines}

## Saved Local Summaries

${targetLines || '- no local target summaries were recorded'}

## Exact build.fhir.org Files To Read First

${specRefLines}

Use those exact pages before falling back to search results. The operation
page is the starting point; the linked resource and datatype pages are the
follow-up references when the request uses inline resources, typed values,
or response/error structures that need interpretation.

## What To Investigate

1. Inspect the local artifacts and explain why the three local targets differ.
2. Compare the same request shape against \`tx.fhir.org\` when feasible.
3. Check \`build.fhir.org\` for the relevant operation semantics, including what parameters are allowed, required, or optional, and how inline resources or supplements are expected to behave.
4. Separate incidental differences from meaningful semantic differences.
5. Decide which local behavior is most defensible:
   - \`primary\` = IR Branch + IR Worker
   - \`secondary\` = IR Branch + Legacy Worker
   - \`third\` = Upstream Providers + Legacy Worker
   - or \`ambiguous\`
6. Recommend whether this case is suitable for automatic adjudication and, if so, what rule shape should be encoded.

## How To Read The Spec Pages

1. Start with the operation page and read the prose above the parameter tables before reading the table rows.
2. Extract any normative or cross-parameter rules stated in prose, especially \`SHALL\`, \`SHOULD\`, \`MAY\`, \`MUST\`, one-of input-shape rules, mutual exclusivity, and dependencies between parameters. Do not assume those rules can be inferred from cardinality alone.
3. Then read the full input and output parameter tables. For every parameter that appears in \`request-source.json\`, use the Documentation column as well as the cardinality and type columns.
4. When the request uses common alternative shapes such as \`code + system\`, \`coding\`, or \`codeableConcept\`, confirm the allowed combinations from the operation page itself rather than assuming them from memory.
5. If the request carries inline resources, open the resource definition pages and inspect the elements actually present in the saved request. For example, confirm the meaning of fields like \`compose\`, \`include\`, \`exclude\`, \`filter\`, \`content\`, \`supplements\`, \`designation\`, and \`property\` from the resource definition pages rather than inferring them from local code.
6. If the request uses typed values such as \`Coding\`, \`CodeableConcept\`, \`code\`, \`uri\`, or a \`Parameters\` body, use the datatype or resource definition pages to understand what those payload shapes mean and what constraints they carry.
7. For disputes about status codes, issue codes, severity, or message text, use the \`OperationOutcome\` pages to distinguish required semantics from incidental wording.
8. If \`tx.fhir.org\` disagrees with a clear rule on \`build.fhir.org\`, say so plainly. If the spec is permissive or silent, say that plainly too.

## Evaluation Guidance

- Treat \`build.fhir.org\` as the source for expectations, options, and requirements.
- Treat \`tx.fhir.org\` as an important implementation reference point, not the sole source of truth.
- Distinguish unsupported or timeout behavior from semantically incorrect answers.
- Be explicit when the spec appears permissive rather than prescriptive.
- Do not over-index on harmless differences in headers, IDs, timing, or trace metadata.
- Do call out when a superficially small textual difference changes the clinical or terminological meaning.
- If local IR behavior is stronger than legacy or upstream, say so plainly.
- If the IR result looks wrong or underspecified, say that plainly too.

## Required Output

Write your final analysis to \`report.md\` in this folder by creating the file yourself if it does not yet exist, or updating it if it does. Do not rely on stdout redirection as the delivery mechanism. Keep the report concise but concrete.

The report must start with a YAML frontmatter block using this shape:

\`\`\`yaml
---
row_id: ${row.id}
status: ir-preferred | legacy-preferred | upstream-preferred | no-meaningful-difference | ambiguous | needs-followup
summary: "one-sentence takeaway"
meaningful_difference: yes | no | unclear
preferred_target: primary | secondary | third | none | ambiguous
confidence: low | medium | high
issue_class: short-kebab-case-label
spec_clarity: clear | mixed | unclear
tx_fhir_org_alignment: primary | secondary | third | mixed | not-tested
auto_adjudication: yes | no | conditional
---
\`\`\`

Guidance for the header:

- Use \`status: no-meaningful-difference\` when the differences are cosmetic, operational, or otherwise not materially semantic.
- Use \`preferred_target: none\` when there is no meaningful difference.
- Use \`status: needs-followup\` when the evidence is incomplete or the references do not resolve the question well enough.
- Keep \`summary\` to one sentence.
- Keep \`issue_class\` short, for example \`error-reporting\`, \`inline-resource\`, \`supplement-handling\`, \`parameter-handling\`, \`display-selection\`, \`unsupported\`, or \`timeout\`.

After the frontmatter, the report should include:

1. Verdict
2. Preferred Target
3. Confidence
4. Meaningful Difference Assessment
5. Local Evidence
6. tx.fhir.org Comparison
7. build.fhir.org Findings
8. Auto-Adjudication Recommendation
9. Follow-Up Advice

Include the exact URLs you consulted. Prefer paraphrase over long quotes.
`;
}

function buildReportTemplate(row) {
  return `---
row_id: ${row.id}
status: ir-preferred
summary: ""
meaningful_difference: yes
preferred_target: primary
confidence: medium
issue_class: ""
spec_clarity: mixed
tx_fhir_org_alignment: not-tested
auto_adjudication: conditional
---

# ${row.name}

## Verdict

## Preferred Target

## Confidence

## Meaningful Difference Assessment

## Local Evidence

## tx.fhir.org Comparison

## build.fhir.org Findings

## Auto-Adjudication Recommendation

## Follow-Up Advice
`;
}

function extractTargetArtifacts(issueDir, detailDoc, row) {
  const debugByKey = targetDebugByKey(detailDoc);
  for (const target of row.targets || []) {
    const targetDir = path.join(issueDir, 'outputs', target.key);
    ensureDir(targetDir);
    const debugTarget = debugByKey.get(target.key) || {};
    writeJson(path.join(targetDir, 'summary.json'), target);
    if (debugTarget.debug?.request) {
      writeJson(path.join(targetDir, 'request.json'), debugTarget.debug.request);
    }
    if (debugTarget.debug?.response) {
      writeJson(path.join(targetDir, 'response.json'), debugTarget.debug.response);
    }
    if (debugTarget.debug?.trace) {
      writeJson(path.join(targetDir, 'trace.json'), debugTarget.debug.trace);
    }
    if (debugTarget.debug?.error) {
      writeText(path.join(targetDir, 'error.txt'), `${String(debugTarget.debug.error).trim()}\n`);
    }
    if (debugTarget.debug?.irPlanText) {
      writeText(path.join(targetDir, 'plan.txt'), `${String(debugTarget.debug.irPlanText).trim()}\n`);
    }
  }
}

function buildBatchReadme({ batchName, outDir, issues }) {
  return `# ${batchName}

This directory packages selected perf-harness diffs for external review agents.

- Batch dir: ${outDir}
- Issue count: ${issues.length}
- Each issue folder contains local inputs, local outputs for every target, and a reviewer prompt. The reviewing agent is expected to create \`report.md\` itself.

Use the generated Copilot wrapper with the locally verified stdin flow:

\`\`\`bash
./run-with-copilot.sh --parallel 4 --dry-run
\`\`\`

The wrapper uses:

- \`copilot --model claude-opus-4.6\`
- prompt text from stdin via \`< prompt.md\`
- \`--yolo\`
- execution from inside each issue directory, so Copilot can create \`report.md\` with its own file tools

Run an external CLI agent in parallel with:

\`\`\`bash
./run-agents.sh --cmd 'your-agent --issue {issue_dir} --prompt-file {prompt_file} > {report_file}' --parallel 4
\`\`\`

Useful placeholders in \`--cmd\`:

- \`{batch_dir}\`
- \`{issue_dir}\`
- \`{issue_name}\`
- \`{prompt_file}\`
- \`{report_file}\`
- \`{issue_json}\`
- \`{input_json}\`
- \`{detail_json}\`

If the agent should run from inside the issue folder, include \`cd {issue_dir} && ...\` in the command template.
`;
}

function buildBatchWrapper(outDir) {
  const scriptPath = path.resolve(RUNNER_SCRIPT);
  return `#!/usr/bin/env bash
set -euo pipefail
exec ${shellQuote(scriptPath)} ${shellQuote(outDir)} "$@"
`;
}

function buildCopilotWrapper(outDir) {
  const scriptPath = path.resolve(RUNNER_SCRIPT);
  return `#!/usr/bin/env bash
set -euo pipefail

MODEL="\${COPILOT_MODEL:-claude-opus-4.6}"
PARALLEL="\${COPILOT_BATCH_PARALLEL:-4}"

cmd_template='copilot --model '"\${MODEL}"' --yolo --no-ask-user --no-custom-instructions < prompt.md'

exec ${shellQuote(scriptPath)} ${shellQuote(outDir)} --parallel "\${PARALLEL}" --cmd "\${cmd_template}" "$@"
`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const analysis = runAnalysis(options);
  const selectedRows = selectRows(analysis, options);
  if (selectedRows.length === 0) {
    fail('No rows matched the requested filters.');
  }

  const runDir = path.resolve(analysis.runDir);
  const batchName = options.batchName || defaultBatchName(runDir);
  const outDir = path.resolve(options.outDir || path.join(REPO_ROOT, 'tmp', 'tx-review-batches', batchName));
  const issuesDir = path.join(outDir, 'issues');
  ensureDir(issuesDir);

  const createdAt = new Date().toISOString();
  const manifestIssues = [];
  const selectedAnalysis = [];

  for (const row of selectedRows) {
    const issueSlug = `${String(row.id).padStart(3, '0')}-${slugify(row.name)}`;
    const issueDir = path.join(issuesDir, issueSlug);
    ensureDir(issueDir);

    const inputDoc = readJson(row.inputJsonPath);
    const detailDoc = readJson(row.detailJsonPath);
    const operation = detectOperation(inputDoc);
    const issueRelDir = path.relative(outDir, issueDir) || '.';

    fs.copyFileSync(row.inputJsonPath, path.join(issueDir, 'input.json'));
    fs.copyFileSync(row.detailJsonPath, path.join(issueDir, 'detail.json'));
    if (row.detailHtmlPath && fs.existsSync(row.detailHtmlPath)) {
      fs.copyFileSync(row.detailHtmlPath, path.join(issueDir, 'detail.html'));
    }
    if (inputDoc?.source?.request) {
      writeJson(path.join(issueDir, 'request-source.json'), inputDoc.source.request);
    }

    extractTargetArtifacts(issueDir, detailDoc, row);

    const issueDoc = {
      schemaVersion: 1,
      createdAt,
      batchName,
      runDir,
      row: {
        id: row.id,
        name: row.name,
        rawName: row.rawName,
        kind: row.kind,
        category: row.category,
        harnessStatus: row.harnessStatus,
        harnessOk: row.harnessOk,
        flags: row.flags || [],
        signature: row.signature,
        score: row.score,
        review: row.review || null,
        reviewLabel: row.reviewLabel || null,
      },
      operation,
      originalArtifacts: {
        inputJsonPath: row.inputJsonPath,
        detailJsonPath: row.detailJsonPath,
        detailHtmlPath: row.detailHtmlPath || null,
      },
      localTargets: row.targets || [],
    };
    writeJson(path.join(issueDir, 'issue.json'), issueDoc);
    writeText(path.join(issueDir, 'prompt.md'), buildIssuePrompt({ batchName, row, inputDoc, issueRelDir, operation }));
    writeText(path.join(issueDir, 'report-template.md'), buildReportTemplate(row));
    const emptyReportPath = path.join(issueDir, 'report.md');
    if (fs.existsSync(emptyReportPath) && fs.statSync(emptyReportPath).size === 0) {
      fs.unlinkSync(emptyReportPath);
    }

    manifestIssues.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      category: row.category,
      flags: row.flags || [],
      score: row.score,
      reviewLabel: row.reviewLabel || null,
      issueDir,
      promptFile: path.join(issueDir, 'prompt.md'),
      reportFile: path.join(issueDir, 'report.md'),
    });
    selectedAnalysis.push(row);
  }

  const manifest = {
    schemaVersion: 1,
    createdAt,
    batchName,
    runDir,
    outDir,
    selection: {
      kinds: options.kinds,
      flags: options.flags,
      ids: options.ids,
      limit: options.limit,
      unreviewed: options.unreviewed,
      deferred: options.deferred,
      includeAligned: options.includeAligned,
    },
    sourceAnalysis: {
      rowCount: analysis.rowCount,
      selectedRowCount: analysis.selectedRowCount,
      flagCounts: analysis.flagCounts,
      signatureCounts: analysis.signatureCounts,
    },
    issues: manifestIssues,
  };

  writeJson(path.join(outDir, 'manifest.json'), manifest);
  writeJson(path.join(outDir, 'selected-analysis.json'), {
    runDir: analysis.runDir,
    rowCount: analysis.rowCount,
    selectedRowCount: selectedRows.length,
    rows: selectedAnalysis,
  });
  writeText(path.join(outDir, 'README.md'), buildBatchReadme({ batchName, outDir, issues: manifestIssues }));
  writeText(path.join(outDir, 'run-agents.sh'), buildBatchWrapper(outDir));
  writeText(path.join(outDir, 'run-with-copilot.sh'), buildCopilotWrapper(outDir));
  fs.chmodSync(path.join(outDir, 'run-agents.sh'), 0o755);
  fs.chmodSync(path.join(outDir, 'run-with-copilot.sh'), 0o755);

  console.log(`Created review batch: ${outDir}`);
  console.log(`Run dir: ${runDir}`);
  console.log(`Issues: ${manifestIssues.length}`);
  for (const issue of manifestIssues) {
    const flagLabel = issue.flags.length > 0 ? issue.flags.join(', ') : 'aligned';
    console.log(`  #${issue.id} ${issue.kind} ${issue.name} [${flagLabel}]`);
  }
}

main();
