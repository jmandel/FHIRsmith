#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage:
  scripts/run-ir-harness.sh [options] [filter ...]

Starts a local server, waits for /r4/metadata, runs selected IR harness mode(s),
then always shuts the server down.

Modes (default: --ir):
  --ir            Run IR harness
  --legacy        Run legacy harness (--legacy)
  --perf          Run perf harness (--perf)
  --all           Run ir + legacy + perf

Options:
  --port <n>              Server port (default: 8000)
  --db-dir <path>         V0 DB directory (or env FHIRSMITH_V0_DB_DIR / V0_DB_DIR)
  --library-source <path> Library YAML (default: tests/tx/fixtures/v0-test-library.yaml)
  --with-synthetic-supplements
                        Generate and register synthetic sqlite supplement sidecars for LOINC
  --synthetic-supp-url-root <url>
                        Canonical root for generated synthetic supplements
                        (default: http://example.org/fhir/CodeSystem/harness-dice-supplement)
  --synthetic-supp-dice <list>
                        Comma-separated dice specs to generate (default: d20,d8)
  --perf-third-upstream   In --perf mode, add third timing column from a second server
  --third-port <n>        Second server port (default: 8001)
  --third-library-source <path>
                          Second server YAML (default: tests/tx/fixtures/upstream-provider-test-library.yaml)
  --upstream-db-dir <path>
                          Upstream DB/cache dir (or env FHIRSMITH_UPSTREAM_DB_DIR / UPSTREAM_DB_DIR)
  --out-root <path>       Root output dir (default: tmp/ir-harness-runs)
  --out-dir <path>        Exact output dir (overrides --out-root timestamp)
  --perf-out <path>       Perf HTML output path (default: <out-dir>/perf-table.html)
  --perf-runs <n>         PERF_RUNS value for --perf (default: 3)
  --filter <text>         Harness name filter (repeatable; OR-matched)
  --trace                 Pass --trace to harness
  --strict-ir-no-fallback (or --strict-ir) Fail if IR requests fall back to legacy
  --semantic-parity       Fail if IR and legacy semantic outputs disagree (when both succeed)
  --strict-total-consistency
                          Fail when total is inconsistent with returned contains
  -h, --help              Show this help

Examples:
  scripts/run-ir-harness.sh
  scripts/run-ir-harness.sh --all --perf-out tmp/my-perf.html
  scripts/run-ir-harness.sh --ir --filter SNOMED --filter pagination
  scripts/run-ir-harness.sh --ir SNOMED pagination
  scripts/run-ir-harness.sh --db-dir /home/jmandel/hobby/sct/cache --all
  scripts/run-ir-harness.sh --perf --perf-third-upstream --db-dir /home/jmandel/hobby/sct/cache --upstream-db-dir /home/jmandel/hobby/FHIRsmith/data/terminology-cache
EOF
}

abspath() {
  local p="$1"
  if [[ "$p" = /* ]]; then
    printf '%s\n' "$p"
  else
    printf '%s\n' "$ROOT_DIR/$p"
  fi
}

PORT=8000
THIRD_PORT=8001
OUT_ROOT="tmp/ir-harness-runs"
OUT_DIR=""
PERF_OUT=""
PERF_RUNS_VALUE="${PERF_RUNS:-3}"
TRACE=0
STRICT_IR_NO_FALLBACK=0
SEMANTIC_PARITY=0
STRICT_TOTAL_CONSISTENCY=0
WITH_SYNTHETIC_SUPPLEMENTS=0
SYNTHETIC_SUPP_URL_ROOT="http://example.org/fhir/CodeSystem/harness-dice-supplement"
SYNTHETIC_SUPP_DICE="d20,d8"
FILTERS=()

MODE_SET=0
RUN_IR=1
RUN_LEGACY=0
RUN_PERF=0
PERF_THIRD_UPSTREAM=0

DEFAULT_LIBRARY="$ROOT_DIR/tests/tx/fixtures/v0-test-library.yaml"
LIBRARY_SOURCE="${FHIRSMITH_LIBRARY_SOURCE:-$DEFAULT_LIBRARY}"
DB_DIR="${FHIRSMITH_V0_DB_DIR:-${V0_DB_DIR:-}}"
DEFAULT_THIRD_LIBRARY="$ROOT_DIR/tests/tx/fixtures/upstream-provider-test-library.yaml"
THIRD_LIBRARY_SOURCE="${FHIRSMITH_THIRD_LIBRARY_SOURCE:-$DEFAULT_THIRD_LIBRARY}"
UPSTREAM_DB_DIR="${FHIRSMITH_UPSTREAM_DB_DIR:-${UPSTREAM_DB_DIR:-}}"

select_mode() {
  if [[ "$MODE_SET" -eq 0 ]]; then
    RUN_IR=0
    RUN_LEGACY=0
    RUN_PERF=0
    MODE_SET=1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ir)
      select_mode
      RUN_IR=1
      ;;
    --legacy)
      select_mode
      RUN_LEGACY=1
      ;;
    --perf)
      select_mode
      RUN_PERF=1
      ;;
    --all)
      MODE_SET=1
      RUN_IR=1
      RUN_LEGACY=1
      RUN_PERF=1
      ;;
    --port)
      PORT="$2"
      shift
      ;;
    --db-dir)
      DB_DIR="$2"
      shift
      ;;
    --library-source)
      LIBRARY_SOURCE="$2"
      shift
      ;;
    --with-synthetic-supplements)
      WITH_SYNTHETIC_SUPPLEMENTS=1
      ;;
    --synthetic-supp-url-root)
      SYNTHETIC_SUPP_URL_ROOT="$2"
      shift
      ;;
    --synthetic-supp-dice)
      SYNTHETIC_SUPP_DICE="$2"
      shift
      ;;
    --perf-third-upstream)
      PERF_THIRD_UPSTREAM=1
      ;;
    --third-port)
      THIRD_PORT="$2"
      shift
      ;;
    --third-library-source)
      THIRD_LIBRARY_SOURCE="$2"
      shift
      ;;
    --upstream-db-dir)
      UPSTREAM_DB_DIR="$2"
      shift
      ;;
    --out-root)
      OUT_ROOT="$2"
      shift
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift
      ;;
    --perf-out)
      PERF_OUT="$2"
      shift
      ;;
    --perf-runs)
      PERF_RUNS_VALUE="$2"
      shift
      ;;
    --filter)
      FILTERS+=("$2")
      shift
      ;;
    --trace)
      TRACE=1
      ;;
    --strict-ir-no-fallback|--strict-ir)
      STRICT_IR_NO_FALLBACK=1
      ;;
    --semantic-parity)
      SEMANTIC_PARITY=1
      ;;
    --strict-total-consistency)
      STRICT_TOTAL_CONSISTENCY=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      FILTERS+=("$1")
      ;;
  esac
  shift
done

LIBRARY_SOURCE="$(abspath "$LIBRARY_SOURCE")"
if [[ ! -f "$LIBRARY_SOURCE" ]]; then
  echo "Library source not found: $LIBRARY_SOURCE" >&2
  exit 2
fi

THIRD_LIBRARY_SOURCE="$(abspath "$THIRD_LIBRARY_SOURCE")"
if [[ "$PERF_THIRD_UPSTREAM" -eq 1 && ! -f "$THIRD_LIBRARY_SOURCE" ]]; then
  echo "Third-library source not found: $THIRD_LIBRARY_SOURCE" >&2
  exit 2
fi

if [[ -z "$DB_DIR" ]]; then
  echo "Missing DB dir. Set --db-dir or FHIRSMITH_V0_DB_DIR (or V0_DB_DIR)." >&2
  exit 2
fi
DB_DIR="$(abspath "$DB_DIR")"
if [[ ! -d "$DB_DIR" ]]; then
  echo "DB dir does not exist: $DB_DIR" >&2
  exit 2
fi

for db in sct_intl_20250201.v0.db loinc_281_full.v0.db rxnorm_02022026.v0.db; do
  if [[ ! -f "$DB_DIR/$db" ]]; then
    echo "Missing required DB file: $DB_DIR/$db" >&2
    exit 2
  fi
done

if [[ "$PERF_THIRD_UPSTREAM" -eq 1 ]]; then
  if [[ "$RUN_PERF" -ne 1 ]]; then
    echo "--perf-third-upstream is only valid with --perf (or --all)." >&2
    exit 2
  fi
  if [[ -z "$UPSTREAM_DB_DIR" ]]; then
    echo "Missing upstream DB dir. Set --upstream-db-dir or FHIRSMITH_UPSTREAM_DB_DIR (or UPSTREAM_DB_DIR)." >&2
    exit 2
  fi
  UPSTREAM_DB_DIR="$(abspath "$UPSTREAM_DB_DIR")"
  if [[ ! -d "$UPSTREAM_DB_DIR" ]]; then
    echo "Upstream DB dir does not exist: $UPSTREAM_DB_DIR" >&2
    exit 2
  fi
  for db in sct_intl_20250201.cache loinc-2.81-b.db rxnorm_02032025-a.db; do
    if [[ ! -f "$UPSTREAM_DB_DIR/$db" ]]; then
      echo "Missing required upstream file: $UPSTREAM_DB_DIR/$db" >&2
      exit 2
    fi
  done
fi

if [[ -z "$OUT_DIR" ]]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  OUT_DIR="$OUT_ROOT/$STAMP"
fi
OUT_DIR="$(abspath "$OUT_DIR")"

if [[ -z "$PERF_OUT" ]]; then
  PERF_OUT="$OUT_DIR/perf-table.html"
fi
PERF_OUT="$(abspath "$PERF_OUT")"

DATA_DIR="$OUT_DIR/data"
mkdir -p "$DATA_DIR"
THIRD_DATA_DIR="$OUT_DIR/data-third"
if [[ "$PERF_THIRD_UPSTREAM" -eq 1 ]]; then
  mkdir -p "$THIRD_DATA_DIR"
  ln -sfn "$UPSTREAM_DB_DIR" "$THIRD_DATA_DIR/terminology-cache"
fi

HARNESS_SQLITE_SUPP_URL_ROOT_VALUE=""
SYNTHETIC_SUPP_DIR=""
SYNTHETIC_SUPP_MANIFEST=""

generate_synthetic_supplement_library() {
  SYNTHETIC_SUPP_DIR="$OUT_DIR/synthetic-supplements/loinc"
  SYNTHETIC_SUPP_MANIFEST="$SYNTHETIC_SUPP_DIR/manifest.json"
  HARNESS_SQLITE_SUPP_URL_ROOT_VALUE="${SYNTHETIC_SUPP_URL_ROOT%/}"
  mkdir -p "$SYNTHETIC_SUPP_DIR"

  echo "Generating synthetic sqlite supplements (${SYNTHETIC_SUPP_DICE}) ..."
  node "$ROOT_DIR/scripts/generate-dice-supplements.mjs" \
    --db "$DB_DIR/loinc_281_full.v0.db" \
    --out-dir "$SYNTHETIC_SUPP_DIR" \
    --dice "$SYNTHETIC_SUPP_DICE" \
    --formats sqlite \
    --url-root "$HARNESS_SQLITE_SUPP_URL_ROOT_VALUE" \
    > "$SYNTHETIC_SUPP_DIR/generation.json"

  local generated_library="$OUT_DIR/library.synthetic-supplements.yaml"
  node - "$LIBRARY_SOURCE" "$generated_library" "$SYNTHETIC_SUPP_MANIFEST" <<'NODE'
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const [libraryPath, outPath, manifestPath] = process.argv.slice(2);
const config = yaml.parse(fs.readFileSync(libraryPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const manifestDir = path.dirname(manifestPath);
const sqliteFiles = (manifest.supplements || [])
  .map(item => item.sqliteFile ? path.resolve(manifestDir, item.sqliteFile) : null)
  .filter(Boolean);

let patched = false;
config.sources = (config.sources || []).map((entry) => {
  let sourceSpec = null;
  let clone = null;
  let options = {};

  if (typeof entry === 'string') {
    sourceSpec = entry;
    clone = {};
  } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    if (typeof entry.source === 'string') {
      sourceSpec = entry.source;
      clone = { ...entry };
      options = { ...(entry.options || {}) };
    } else if (typeof entry.type === 'string') {
      sourceSpec = `${entry.type}:${entry.details || entry.path || ''}`;
      clone = { ...entry };
      options = { ...(entry.options || {}) };
    }
  }

  if (!sourceSpec) return entry;
  if (/^sqlite-v0!?:/.test(sourceSpec) && /loinc_.*\.v0\.db(?:$|[|?#])/.test(sourceSpec)) {
    patched = true;
    return {
      ...clone,
      source: sourceSpec,
      options: {
        ...options,
        supplements: sqliteFiles,
      },
    };
  }
  return entry;
});

if (!patched) {
  throw new Error(`Did not find a LOINC sqlite-v0 source in ${libraryPath}`);
}

fs.writeFileSync(outPath, yaml.stringify(config), 'utf8');
NODE

  LIBRARY_SOURCE="$generated_library"
}

if [[ "$WITH_SYNTHETIC_SUPPLEMENTS" -eq 1 ]]; then
  generate_synthetic_supplement_library
fi

if curl -fsS "http://localhost:${PORT}/r4/metadata" >/dev/null 2>&1; then
  echo "Port ${PORT} already appears to have a running FHIR endpoint." >&2
  echo "Use --port to avoid clobbering an existing server." >&2
  exit 1
fi
if [[ "$PERF_THIRD_UPSTREAM" -eq 1 ]] && curl -fsS "http://localhost:${THIRD_PORT}/r4/metadata" >/dev/null 2>&1; then
  echo "Third port ${THIRD_PORT} already appears to have a running FHIR endpoint." >&2
  echo "Use --third-port to avoid clobbering an existing server." >&2
  exit 1
fi

cat > "$DATA_DIR/config.json" <<JSON
{
  "hostName": "FHIRsmith IR Harness Runner",
  "server": {
    "port": ${PORT},
    "cors": { "origin": "*", "credentials": true }
  },
  "modules": {
    "shl": { "enabled": false },
    "vcl": { "enabled": false },
    "xig": { "enabled": false },
    "packages": { "enabled": false },
    "registry": { "enabled": false },
    "publisher": { "enabled": false },
    "token": { "enabled": false },
    "npmprojector": { "enabled": false },
    "tx": {
      "enabled": true,
      "host": "localhost:${PORT}",
      "baseUrl": "http://localhost:${PORT}",
      "name": "IR Harness TX",
      "title": "IR Harness Terminology Service",
      "librarySource": "$LIBRARY_SOURCE",
      "cacheTimeout": 30,
      "expansionCacheSize": 1000,
      "endpoints": [
        { "path": "/r4", "fhirVersion": "4.0", "context": null }
      ]
    }
  }
}
JSON

if [[ "$PERF_THIRD_UPSTREAM" -eq 1 ]]; then
cat > "$THIRD_DATA_DIR/config.json" <<JSON
{
  "hostName": "FHIRsmith IR Harness Runner (Third Backend)",
  "server": {
    "port": ${THIRD_PORT},
    "cors": { "origin": "*", "credentials": true }
  },
  "modules": {
    "shl": { "enabled": false },
    "vcl": { "enabled": false },
    "xig": { "enabled": false },
    "packages": { "enabled": false },
    "registry": { "enabled": false },
    "publisher": { "enabled": false },
    "token": { "enabled": false },
    "npmprojector": { "enabled": false },
    "tx": {
      "enabled": true,
      "host": "localhost:${THIRD_PORT}",
      "baseUrl": "http://localhost:${THIRD_PORT}",
      "name": "IR Harness TX (Third Backend)",
      "title": "IR Harness Terminology Service (Third Backend)",
      "librarySource": "$THIRD_LIBRARY_SOURCE",
      "cacheTimeout": 30,
      "expansionCacheSize": 1000,
      "endpoints": [
        { "path": "/r4", "fhirVersion": "4.0", "context": null }
      ]
    }
  }
}
JSON
fi

SERVER_PID=""
THIRD_SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$THIRD_SERVER_PID" ]] && kill -0 "$THIRD_SERVER_PID" 2>/dev/null; then
    kill "$THIRD_SERVER_PID" 2>/dev/null || true
    wait "$THIRD_SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Output directory: $OUT_DIR"
echo "Starting server on :$PORT ..."

FHIRSMITH_DATA_DIR="$DATA_DIR" V0_DB_DIR="$DB_DIR" node "$ROOT_DIR/server.js" > "$OUT_DIR/server.log" 2>&1 &
SERVER_PID=$!

if [[ "$PERF_THIRD_UPSTREAM" -eq 1 ]]; then
  echo "Starting third-backend server on :$THIRD_PORT ..."
  FHIRSMITH_DATA_DIR="$THIRD_DATA_DIR" node "$ROOT_DIR/server.js" > "$OUT_DIR/server-third.log" 2>&1 &
  THIRD_SERVER_PID=$!
fi

READY=0
for _ in $(seq 1 240); do
  if curl -fsS "http://localhost:${PORT}/r4/metadata" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server exited before becoming ready." >&2
    tail -n 120 "$OUT_DIR/server.log" >&2 || true
    exit 1
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  echo "Timed out waiting for server readiness (/r4/metadata)." >&2
  tail -n 120 "$OUT_DIR/server.log" >&2 || true
  exit 1
fi

if [[ "$PERF_THIRD_UPSTREAM" -eq 1 ]]; then
  THIRD_READY=0
  for _ in $(seq 1 240); do
    if curl -fsS "http://localhost:${THIRD_PORT}/r4/metadata" >/dev/null 2>&1; then
      THIRD_READY=1
      break
    fi
    if ! kill -0 "$THIRD_SERVER_PID" 2>/dev/null; then
      echo "Third server exited before becoming ready." >&2
      tail -n 120 "$OUT_DIR/server-third.log" >&2 || true
      exit 1
    fi
    sleep 1
  done

  if [[ "$THIRD_READY" -ne 1 ]]; then
    echo "Timed out waiting for third server readiness (/r4/metadata)." >&2
    tail -n 120 "$OUT_DIR/server-third.log" >&2 || true
    exit 1
  fi
fi

warm_perf_backend() {
  local base_url="$1"
  local engine="$2"
  local label="$3"
  local -a urls=(
    "http%3A%2F%2Fsnomed.info%2Fsct%3Ffhir_vs%3Disa%2F73211009"
    "http%3A%2F%2Floinc.org%3Ffhir_vs%3Dall"
    "http%3A%2F%2Fwww.nlm.nih.gov%2Fresearch%2Fumls%2Frxnorm%3Ffhir_vs%3Dall"
  )
  for url in "${urls[@]}"; do
    curl -fsS --max-time 30 \
      "${base_url}/r4/ValueSet/\$expand?url=${url}&count=1&_nocache=true&_engine=${engine}" \
      >/dev/null 2>&1 || true
  done
  echo "Warmed ${label} (${engine})"
}

if [[ "$RUN_PERF" -eq 1 ]]; then
  warm_perf_backend "http://localhost:${PORT}" "ir" "primary backend"
  warm_perf_backend "http://localhost:${PORT}" "legacy" "primary backend"
  if [[ "$PERF_THIRD_UPSTREAM" -eq 1 ]]; then
    warm_perf_backend "http://localhost:${THIRD_PORT}" "legacy" "third backend"
  fi
fi

HARNESS_ARGS=()
for f in "${FILTERS[@]}"; do
  HARNESS_ARGS+=(--filter "$f")
done
if [[ "$TRACE" -eq 1 ]]; then
  HARNESS_ARGS+=(--trace)
fi
if [[ "$STRICT_IR_NO_FALLBACK" -eq 1 ]]; then
  HARNESS_ARGS+=(--strict-ir-no-fallback)
fi
if [[ "$SEMANTIC_PARITY" -eq 1 ]]; then
  HARNESS_ARGS+=(--semantic-parity)
fi
if [[ "$STRICT_TOTAL_CONSISTENCY" -eq 1 ]]; then
  HARNESS_ARGS+=(--strict-total-consistency)
fi

run_harness() {
  local mode="$1"
  shift
  local log_file="$OUT_DIR/harness-${mode}.log"
  local -a env_args=("BASE_URL=http://localhost:${PORT}")
  if [[ "$mode" != "legacy" && -n "$HARNESS_SQLITE_SUPP_URL_ROOT_VALUE" ]]; then
    env_args+=("HARNESS_SQLITE_SUPP_URL_ROOT=$HARNESS_SQLITE_SUPP_URL_ROOT_VALUE")
  fi
  echo "== ${mode^^} harness =="
  env "${env_args[@]}" "$@" | tee "$log_file"
}

if [[ "$RUN_IR" -eq 1 ]]; then
  run_harness "ir" node "$ROOT_DIR/scripts/ir-harness.mjs" "${HARNESS_ARGS[@]}"
fi

if [[ "$RUN_LEGACY" -eq 1 ]]; then
  run_harness "legacy" node "$ROOT_DIR/scripts/ir-harness.mjs" "${HARNESS_ARGS[@]}" --legacy
fi

if [[ "$RUN_PERF" -eq 1 ]]; then
  mkdir -p "$(dirname "$PERF_OUT")"
  PERF_ENV=(env PERF_RUNS="$PERF_RUNS_VALUE")
  PERF_ENV+=(PERF_PRIMARY_LABEL="IR Branch + New Expander")
  PERF_ENV+=(PERF_SECONDARY_LABEL="IR Branch + Upstream Expander")
  if [[ "$PERF_THIRD_UPSTREAM" -eq 1 ]]; then
    PERF_ENV+=(PERF_THIRD_BASE_URL="http://localhost:${THIRD_PORT}")
    PERF_ENV+=(PERF_THIRD_ENGINE="legacy")
    PERF_ENV+=(PERF_THIRD_LABEL="Upstream Providers + Upstream Expander")
  fi
  run_harness "perf" "${PERF_ENV[@]}" node "$ROOT_DIR/scripts/ir-harness.mjs" "${HARNESS_ARGS[@]}" --perf --perf-out "$PERF_OUT"
fi

echo
echo "Completed."
echo "Run directory: $OUT_DIR"
echo "Server log: $OUT_DIR/server.log"
if [[ -n "$SYNTHETIC_SUPP_DIR" ]]; then
  echo "Synthetic supplements: $SYNTHETIC_SUPP_DIR"
  echo "Synthetic supplement manifest: $SYNTHETIC_SUPP_MANIFEST"
  echo "Synthetic supplement URL root: $HARNESS_SQLITE_SUPP_URL_ROOT_VALUE"
fi
if [[ "$PERF_THIRD_UPSTREAM" -eq 1 ]]; then
  echo "Third server log: $OUT_DIR/server-third.log"
fi
if [[ "$RUN_IR" -eq 1 ]]; then
  echo "IR log: $OUT_DIR/harness-ir.log"
fi
if [[ "$RUN_LEGACY" -eq 1 ]]; then
  echo "Legacy log: $OUT_DIR/harness-legacy.log"
fi
if [[ "$RUN_PERF" -eq 1 ]]; then
  echo "Perf log: $OUT_DIR/harness-perf.log"
  echo "Perf HTML: $PERF_OUT"
fi
