#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.dirname(SCRIPTS_DIR);
const REVIEW_RUNNER = path.join(SCRIPTS_DIR, 'run-tx-review-agent-batch.sh');

const DEFAULT_ONTOSERVER_BASE = 'https://r4.ontoserver.csiro.au/fhir';

function usage() {
  console.log(`Usage: node scripts/build-ontoserver-compare-batch.mjs [run-dir] [options]

Options:
  --run-dir <path>            Harness run directory to package
  --out-dir <path>            Output directory for the comparison batch
  --batch-name <name>         Friendly name recorded in batch metadata
  --ontoserver-base <url>     Public Ontoserver base URL (default: ${DEFAULT_ONTOSERVER_BASE})
  --kind <kind[,kind]>        Filter by kind: expand, lookup, validate
  --ids <id[,id]>             Restrict to exact row ids
  --limit <n>                 Max rows to export (default: all)
  --help                      Show this message
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function copyIfExists(src, dest) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

function chmodX(filePath) {
  fs.chmodSync(filePath, 0o755);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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
  return `${path.basename(runDir)}-ontoserver-compare-${timestampToken()}`;
}

function parseArgs(argv) {
  const options = {
    runDir: null,
    outDir: null,
    batchName: null,
    ontoserverBase: DEFAULT_ONTOSERVER_BASE,
    kinds: [],
    ids: [],
    limit: null,
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
    if (arg === '--ontoserver-base') {
      options.ontoserverBase = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--kind') {
      options.kinds.push(...splitCsv(argv[i + 1]));
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
    if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (!options.runDir && positional.length > 0) {
    options.runDir = positional[0];
  }
  if (!options.runDir) {
    fail('Missing run directory.');
  }
  if (options.limit != null && (!Number.isInteger(options.limit) || options.limit < 0)) {
    fail(`Invalid --limit value: ${options.limit}`);
  }
  return options;
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function sanitizeParamsBody(body) {
  if (!body || body.resourceType !== 'Parameters' || !Array.isArray(body.parameter)) {
    return body;
  }
  return {
    ...body,
    parameter: body.parameter.filter((parameter) => {
      const name = String(parameter?.name || '');
      return !['_engine', '_trace', '_nocache'].includes(name);
    }),
  };
}

function sanitizeRequest(request, ontoserverBase) {
  if (!request) {
    return null;
  }

  const requestUrl = request.url || request.path;
  if (!requestUrl) {
    return null;
  }

  const parsed = new URL(requestUrl, 'http://localhost');
  const searchParams = new URLSearchParams(parsed.search);
  searchParams.delete('_engine');
  searchParams.delete('_trace');
  searchParams.delete('_nocache');

  let pathname = parsed.pathname || '';
  if (pathname === '/r4') {
    pathname = '';
  } else if (pathname.startsWith('/r4/')) {
    pathname = pathname.slice(3);
  }
  const relativePath = `${pathname || ''}${searchParams.toString() ? `?${searchParams.toString()}` : ''}` || '/';
  const base = stripTrailingSlash(ontoserverBase);
  const absoluteUrl = `${base}${relativePath}`;

  const body = sanitizeParamsBody(request.body);
  const headers = { ...(request.headers || {}) };
  delete headers.host;

  return {
    method: String(request.method || 'GET').toUpperCase(),
    path: relativePath,
    url: absoluteUrl,
    headers,
    body: body || null,
  };
}

function detectOperation(inputDoc, request) {
  const pathValue = String(request?.path || request?.url || '');
  const sourceKind = String(inputDoc?.source?.kind || '').trim();
  if (sourceKind === 'expand' || pathValue.includes('/$expand')) {
    return {
      name: 'ValueSet $expand',
      specUrl: 'https://build.fhir.org/valueset-operation-expand.html',
    };
  }
  if (sourceKind === 'lookup' || pathValue.includes('/$lookup')) {
    return {
      name: 'CodeSystem $lookup',
      specUrl: 'https://build.fhir.org/codesystem-operation-lookup.html',
    };
  }
  if (sourceKind === 'validate' || pathValue.includes('$validate-code')) {
    if (pathValue.includes('/ValueSet/')) {
      return {
        name: 'ValueSet $validate-code',
        specUrl: 'https://build.fhir.org/valueset-operation-validate-code.html',
      };
    }
    return {
      name: 'CodeSystem $validate-code',
      specUrl: 'https://build.fhir.org/codesystem-operation-validate-code.html',
    };
  }
  return {
    name: 'FHIR terminology operation',
    specUrl: 'https://build.fhir.org/',
  };
}

function summarizeRequestShape(request) {
  if (!request) {
    return [
      '- No replayable primary request was captured for this row.',
    ].join('\n');
  }

  const requestUrl = String(request.url || request.path || '');
  let pathOnly = String(request.path || '');
  if (!pathOnly && requestUrl) {
    const parsed = new URL(requestUrl, 'http://localhost');
    pathOnly = `${parsed.pathname || ''}${parsed.search || ''}`;
  }
  const queryIndex = pathOnly.indexOf('?');
  const queryNames = [];
  if (queryIndex >= 0) {
    const searchParams = new URLSearchParams(pathOnly.slice(queryIndex + 1));
    for (const [name] of searchParams.entries()) {
      queryNames.push(name);
    }
  }

  const bodyEntries = [];
  const inlineTypes = [];
  if (request.body?.resourceType === 'Parameters' && Array.isArray(request.body.parameter)) {
    for (const parameter of request.body.parameter) {
      const name = String(parameter?.name || '').trim();
      if (!name) {
        continue;
      }
      const keys = Object.keys(parameter).filter((key) => key !== 'name');
      const detailKey = keys[0] || '';
      if (detailKey === 'resource' && parameter.resource?.resourceType) {
        bodyEntries.push(`${name}=resource:${parameter.resource.resourceType}`);
        inlineTypes.push(String(parameter.resource.resourceType));
      } else if (detailKey) {
        bodyEntries.push(`${name}=${detailKey}`);
      } else {
        bodyEntries.push(name);
      }
    }
  }

  return [
    `- Method/path: ${request.method || 'unknown'} ${pathOnly || 'unknown'}`,
    `- Query parameter names: ${queryNames.join(', ') || 'none'}`,
    `- Parameters entries: ${bodyEntries.join(', ') || 'none'}`,
    `- Inline resource types: ${inlineTypes.join(', ') || 'none'}`,
  ].join('\n');
}

function buildIssuePrompt({ row, operation, ontoserverBase, hasReplayableRequest, issueRelDir, inputDoc }) {
  const request = inputDoc?.requests?.primary || null;
  const requestShape = summarizeRequestShape(request);

  return `# Ontoserver Comparison Task

You are comparing a saved local IR terminology result with a replay against a public Ontoserver instance.

## Context

- Issue folder: ${issueRelDir}
- Row: #${row.id} ${row.name}
- Kind: ${row.kind}
- Category: ${row.category}
- Local run source: saved perf artifacts from the local 3-column harness
- Public Ontoserver base: ${ontoserverBase}
- Operation focus: ${operation.name}
- Spec page: ${operation.specUrl}

## What Is In This Folder

- \`input.json\`: saved harness input for this row
- \`detail.json\`: full saved local multi-column details
- \`detail.html\`: saved local detail page
- \`local-ir/request.json\`: exact primary request sent to the local IR target
- \`local-ir/response.json\`: saved primary response from the local IR target
- \`local-ir/trace.json\`: saved primary trace when available
- \`local-ir/plan.txt\`: saved IR plan when available
- \`ontoserver-request.json\`: sanitized replay request for Ontoserver
- \`run-against-ontoserver.sh\`: helper script that replays the request against Ontoserver and writes \`ontoserver/response.json\`
- \`report-template.md\`: optional structure for \`report.md\`

## Saved Local IR Summary

- Local IR supported: ${row.irSupported}
- Local IR error flag: ${row.irError}
- Local IR time (ms): ${row.irMs}

## Saved Request Shape

${requestShape}

## Required Workflow

1. Read the saved local artifacts first so you understand what our IR engine did.
2. Run \`./run-against-ontoserver.sh\` in this folder to capture a fresh Ontoserver response.
3. Inspect:
   - \`local-ir/request.json\`
   - \`local-ir/response.json\`
   - \`ontoserver-request.json\`
   - \`ontoserver/response.json\`
   - \`ontoserver/status.txt\`
   - \`detail.json\`
4. Compare the Ontoserver behavior with the saved local IR behavior.
5. Use ${operation.specUrl} plus any linked resource/definition pages on build.fhir.org to decide which behavior is more defensible.

## Evaluation Guidance

- Focus on semantic differences, not timing, headers, IDs, or formatting.
- If Ontoserver rejects a local-only extension or request feature, say whether that seems like:
  - a local IR extension that is still defensible, or
  - a sign that our IR behavior is over-permissive or non-standard.
- If Ontoserver and local IR both succeed, compare:
  - result membership
  - paging behavior
  - total / offset / count semantics
  - designation, display, and property handling
  - warning / error semantics
- If Ontoserver fails for an obviously valid standard request shape, say so plainly.
- If the request depends on inline resources, supplements, or custom properties, be explicit about whether the spec clearly requires support or merely permits it.

## Ontoserver Replay Note

${hasReplayableRequest
    ? `A replayable primary request was captured, and this folder already contains a sanitized Ontoserver replay script.`
    : `No replayable primary request was captured for this row. If you cannot replay it, explain that and base your comparison on the saved local evidence plus the specification.`}

## Required Output

Write \`report.md\` in this folder. Start with YAML frontmatter:

\`\`\`yaml
---
row_id: ${row.id}
status: ir-preferred | ontoserver-preferred | no-meaningful-difference | ambiguous | needs-followup
summary: "one-sentence takeaway"
meaningful_difference: yes | no | unclear
preferred_target: ir | ontoserver | none | ambiguous
confidence: low | medium | high
issue_class: short-kebab-case-label
spec_clarity: clear | mixed | unclear
ontoserver_alignment: ir | ontoserver | mixed | not-tested
auto_adjudication: yes | no | conditional
---
\`\`\`

Then include:

1. Verdict
2. Preferred Target
3. Confidence
4. Meaningful Difference Assessment
5. Local IR Evidence
6. Ontoserver Comparison
7. build.fhir.org Findings
8. Auto-Adjudication Recommendation
9. Follow-Up Advice

Include exact URLs you consulted. Prefer paraphrase over long quotes.
`;
}

function buildReportTemplate(row) {
  return `---
row_id: ${row.id}
status: ambiguous
summary: ""
meaningful_difference: unclear
preferred_target: ambiguous
confidence: medium
issue_class: ""
spec_clarity: mixed
ontoserver_alignment: not-tested
auto_adjudication: conditional
---

# ${row.name}

## Verdict

## Preferred Target

## Confidence

## Meaningful Difference Assessment

## Local IR Evidence

## Ontoserver Comparison

## build.fhir.org Findings

## Auto-Adjudication Recommendation

## Follow-Up Advice
`;
}

function buildOntoserverReplayScript(sanitizedRequest, ontoserverBase) {
  if (!sanitizedRequest) {
    return `#!/usr/bin/env bash
set -euo pipefail
echo "No replayable request captured for this issue." >&2
exit 1
`;
  }

  const method = sanitizedRequest.method || 'GET';
  const pathValue = sanitizedRequest.path || '/';
  const bodyFileLine = sanitizedRequest.body
    ? "  -H 'Content-Type: application/fhir+json' \\\n  --data-binary @ontoserver-body.json \\\n"
    : '';

  return `#!/usr/bin/env bash
set -euo pipefail

BASE="\${ONTOSERVER_BASE:-${stripTrailingSlash(ontoserverBase)}}"
BASE="\${BASE%/}"
PATH_AND_QUERY=${shellQuote(pathValue)}

mkdir -p ontoserver

curl -sS -L \\
  -X ${method} \\
  -H 'Accept: application/fhir+json' \\
${bodyFileLine}  -D ontoserver/headers.txt \\
  -o ontoserver/response.json \\
  -w '%{http_code}\\n' \\
  "\${BASE}\${PATH_AND_QUERY}" > ontoserver/status.txt

printf 'status='
cat ontoserver/status.txt
`;
}

function buildProbeRunner(batchDir) {
  return `#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./run-ontoserver-probes.sh [options]

Options:
  --parallel <n>   Number of issue folders to probe concurrently (default: 4)
  --only <csv>     Restrict to issue folder names or numeric row ids
  --force          Re-run even if ontoserver/status.txt already exists
  --help           Show this message
EOF
}

matches_only_filter() {
  local issue_name=$1
  local only_csv=$2
  local item
  IFS=',' read -r -a only_items <<< "$only_csv"
  for item in "\${only_items[@]}"; do
    item=\${item//[[:space:]]/}
    [[ -z "$item" ]] && continue
    if [[ "$issue_name" == "$item" || "$issue_name" == "$item"-* ]]; then
      return 0
    fi
  done
  return 1
}

run_one() {
  local issue_dir=$1
  local force=$2
  local issue_name
  issue_name=$(basename "$issue_dir")

  if [[ -s "$issue_dir/ontoserver/status.txt" && "$force" != "1" ]]; then
    echo "skip $issue_name existing ontoserver/status.txt"
    return 0
  fi

  echo "probe $issue_name"
  (
    cd "$issue_dir"
    ./run-against-ontoserver.sh
  )
}

if [[ "\${1:-}" == "--run-one" ]]; then
  shift
  run_one "$@"
  exit 0
fi

parallel=\${ONTOSERVER_BATCH_PARALLEL:-4}
only_csv=
force=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel)
      parallel=$2
      shift 2
      ;;
    --only)
      only_csv=$2
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

mapfile -t issues < <(find ${shellQuote(path.join(batchDir, 'issues'))} -mindepth 1 -maxdepth 1 -type d | sort)
if [[ -n "$only_csv" ]]; then
  filtered=()
  for issue_dir in "\${issues[@]}"; do
    issue_name=$(basename "$issue_dir")
    if matches_only_filter "$issue_name" "$only_csv"; then
      filtered+=("$issue_dir")
    fi
  done
  issues=("\${filtered[@]}")
fi

if [[ \${#issues[@]} -eq 0 ]]; then
  echo "No issue folders matched." >&2
  exit 1
fi

printf '%s\\0' "\${issues[@]}" | xargs -0 -P "$parallel" -I{} bash "$0" --run-one "{}" "$force"
`;
}

function buildCopilotRunner() {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

exec ${shellQuote(REVIEW_RUNNER)} "$SCRIPT_DIR" \\
  --cmd 'copilot --model claude-opus-4.6 --yolo --no-ask-user --no-custom-instructions < prompt.md' \\
  "$@"
`;
}

function buildBatchReadme({ batchName, runDir, ontoserverBase, issues }) {
  return `# ${batchName}

This batch packages local IR perf-harness evidence alongside per-issue Ontoserver replay helpers.

- Source run: ${runDir}
- Public Ontoserver base default: ${ontoserverBase}
- Issue count: ${issues.length}

Per issue:

- inspect the saved local IR artifacts
- run \`./run-against-ontoserver.sh\`
- compare local IR against Ontoserver and build.fhir.org
- write \`report.md\`

Useful commands:

\`\`\`bash
./run-ontoserver-probes.sh --parallel 4
./run-with-copilot.sh --parallel 4
\`\`\`
`;
}

function normalizeRowName(row) {
  return `${String(row.id).padStart(3, '0')}-${slugify(row.rawName || row.name)}`;
}

function selectRows(catalogRows, options) {
  let rows = [...catalogRows];
  if (options.kinds.length > 0) {
    const kinds = new Set(options.kinds);
    rows = rows.filter((row) => kinds.has(row.kind));
  }
  if (options.ids.length > 0) {
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    rows = options.ids.map((id) => {
      const row = byId.get(String(id));
      if (!row) {
        fail(`Row id ${id} was not present in the selected run.`);
      }
      return row;
    });
  }
  if (options.limit != null) {
    rows = rows.slice(0, options.limit);
  }
  return rows;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(REPO_ROOT, options.runDir);
  const catalogPath = path.join(runDir, 'perf-table.catalog.json');
  if (!fs.existsSync(catalogPath)) {
    fail(`Missing catalog file: ${catalogPath}`);
  }

  const catalog = readJson(catalogPath);
  const rows = selectRows(catalog.rows || [], options);
  const batchName = options.batchName || defaultBatchName(runDir);
  const outDir = path.resolve(REPO_ROOT, options.outDir || path.join('tmp', 'tx-review-batches', batchName));

  ensureDir(outDir);
  ensureDir(path.join(outDir, 'issues'));

  const manifestIssues = [];

  for (const row of rows) {
    const issueName = normalizeRowName(row);
    const issueDir = path.join(outDir, 'issues', issueName);
    ensureDir(issueDir);
    ensureDir(path.join(issueDir, 'local-ir'));
    ensureDir(path.join(issueDir, 'ontoserver'));

    const inputPath = path.join(runDir, row.inputHref);
    const detailJsonPath = path.join(runDir, row.detailJsonHref);
    const detailHtmlPath = path.join(runDir, row.detailHref);
    const inputDoc = readJson(inputPath);
    const detailDoc = readJson(detailJsonPath);
    const primaryTarget = Array.isArray(detailDoc.targets)
      ? detailDoc.targets.find((target) => target.key === 'primary')
      : null;
    const localPrimarySummary = primaryTarget?.debug?.response?.resourceType
      ? primaryTarget.debug.response
      : primaryTarget?.debug?.response || null;
    const primaryRequest = inputDoc?.requests?.primary || primaryTarget?.debug?.request || null;
    const sanitizedRequest = sanitizeRequest(primaryRequest, options.ontoserverBase);
    const operation = detectOperation(inputDoc, sanitizedRequest || primaryRequest);

    writeJson(path.join(issueDir, 'input.json'), inputDoc);
    writeJson(path.join(issueDir, 'detail.json'), detailDoc);
    copyIfExists(detailHtmlPath, path.join(issueDir, 'detail.html'));

    if (primaryRequest) {
      writeJson(path.join(issueDir, 'local-ir', 'request.json'), primaryRequest);
    }
    if (primaryTarget?.debug?.response) {
      writeJson(path.join(issueDir, 'local-ir', 'response.json'), primaryTarget.debug.response);
    }
    if (primaryTarget?.debug?.trace) {
      writeJson(path.join(issueDir, 'local-ir', 'trace.json'), primaryTarget.debug.trace);
    }
    if (primaryTarget?.debug?.irPlanText) {
      writeText(path.join(issueDir, 'local-ir', 'plan.txt'), `${String(primaryTarget.debug.irPlanText).trim()}\n`);
    }
    writeJson(path.join(issueDir, 'local-ir', 'summary.json'), primaryTarget || null);

    if (sanitizedRequest) {
      writeJson(path.join(issueDir, 'ontoserver-request.json'), sanitizedRequest);
      if (sanitizedRequest.body) {
        writeJson(path.join(issueDir, 'ontoserver-body.json'), sanitizedRequest.body);
      }
    }

    const issueMetadata = {
      row_id: row.id,
      name: row.name,
      rawName: row.rawName,
      kind: row.kind,
      category: row.category,
      review: row.review,
      reviewLabel: row.reviewLabel,
      local_ir: {
        supported: row.irSupported,
        error: row.irError,
        ms: row.irMs,
        summary: primaryTarget || null,
      },
      run_dir: runDir,
      source_files: {
        input: inputPath,
        detail_json: detailJsonPath,
        detail_html: detailHtmlPath,
      },
      ontoserver: {
        base: stripTrailingSlash(options.ontoserverBase),
        request: sanitizedRequest,
      },
    };

    writeJson(path.join(issueDir, 'issue.json'), issueMetadata);
    writeText(
      path.join(issueDir, 'prompt.md'),
      buildIssuePrompt({
        row,
        operation,
        ontoserverBase: stripTrailingSlash(options.ontoserverBase),
        hasReplayableRequest: !!sanitizedRequest,
        issueRelDir: path.relative(REPO_ROOT, issueDir),
        inputDoc,
      }),
    );
    writeText(path.join(issueDir, 'report-template.md'), buildReportTemplate(row));
    writeText(
      path.join(issueDir, 'run-against-ontoserver.sh'),
      buildOntoserverReplayScript(sanitizedRequest, options.ontoserverBase),
    );
    chmodX(path.join(issueDir, 'run-against-ontoserver.sh'));

    manifestIssues.push({
      row_id: row.id,
      kind: row.kind,
      name: row.name,
      issue_dir: issueDir,
      review: row.review,
      reviewLabel: row.reviewLabel,
    });
  }

  writeJson(path.join(outDir, 'manifest.json'), {
    schemaVersion: 1,
    batchName,
    runDir,
    ontoserverBase: stripTrailingSlash(options.ontoserverBase),
    issueCount: manifestIssues.length,
    issues: manifestIssues,
  });
  writeText(
    path.join(outDir, 'README.md'),
    buildBatchReadme({
      batchName,
      runDir,
      ontoserverBase: stripTrailingSlash(options.ontoserverBase),
      issues: manifestIssues,
    }),
  );
  writeText(path.join(outDir, 'run-ontoserver-probes.sh'), buildProbeRunner(outDir));
  chmodX(path.join(outDir, 'run-ontoserver-probes.sh'));
  writeText(path.join(outDir, 'run-with-copilot.sh'), buildCopilotRunner());
  chmodX(path.join(outDir, 'run-with-copilot.sh'));

  console.log(`Created Ontoserver comparison batch: ${outDir}`);
  console.log(`Run dir: ${runDir}`);
  console.log(`Public Ontoserver base: ${stripTrailingSlash(options.ontoserverBase)}`);
  console.log(`Issues: ${manifestIssues.length}`);
}

main();
