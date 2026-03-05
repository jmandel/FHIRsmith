#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage:
  scripts/run-ir-harness.sh [options] [filter]

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
  --out-root <path>       Root output dir (default: tmp/ir-harness-runs)
  --out-dir <path>        Exact output dir (overrides --out-root timestamp)
  --perf-out <path>       Perf HTML output path (default: <out-dir>/perf-table.html)
  --perf-runs <n>         PERF_RUNS value for --perf (default: 3)
  --filter <text>         Harness name filter (or provide as positional arg)
  --trace                 Pass --trace to harness
  --strict-ir-no-fallback (or --strict-ir) Fail if IR requests fall back to legacy
  --semantic-parity       Fail if IR and legacy semantic outputs disagree (when both succeed)
  --strict-total-consistency
                          Fail when total is inconsistent with returned contains
  -h, --help              Show this help

Examples:
  scripts/run-ir-harness.sh
  scripts/run-ir-harness.sh --all --perf-out tmp/my-perf.html
  scripts/run-ir-harness.sh --ir --filter SNOMED
  scripts/run-ir-harness.sh --db-dir /home/jmandel/hobby/sct/cache --all
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
OUT_ROOT="tmp/ir-harness-runs"
OUT_DIR=""
PERF_OUT=""
PERF_RUNS_VALUE="${PERF_RUNS:-3}"
TRACE=0
STRICT_IR_NO_FALLBACK=0
SEMANTIC_PARITY=0
STRICT_TOTAL_CONSISTENCY=0
FILTER=""

MODE_SET=0
RUN_IR=1
RUN_LEGACY=0
RUN_PERF=0

DEFAULT_LIBRARY="$ROOT_DIR/tests/tx/fixtures/v0-test-library.yaml"
LIBRARY_SOURCE="${FHIRSMITH_LIBRARY_SOURCE:-$DEFAULT_LIBRARY}"
DB_DIR="${FHIRSMITH_V0_DB_DIR:-${V0_DB_DIR:-}}"

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
      FILTER="$2"
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
      if [[ -z "$FILTER" ]]; then
        FILTER="$1"
      else
        echo "Unexpected extra positional argument: $1" >&2
        usage
        exit 2
      fi
      ;;
  esac
  shift
done

LIBRARY_SOURCE="$(abspath "$LIBRARY_SOURCE")"
if [[ ! -f "$LIBRARY_SOURCE" ]]; then
  echo "Library source not found: $LIBRARY_SOURCE" >&2
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

if curl -fsS "http://localhost:${PORT}/r4/metadata" >/dev/null 2>&1; then
  echo "Port ${PORT} already appears to have a running FHIR endpoint." >&2
  echo "Use --port to avoid clobbering an existing server." >&2
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

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Output directory: $OUT_DIR"
echo "Starting server on :$PORT ..."

FHIRSMITH_DATA_DIR="$DATA_DIR" V0_DB_DIR="$DB_DIR" node "$ROOT_DIR/server.js" > "$OUT_DIR/server.log" 2>&1 &
SERVER_PID=$!

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

HARNESS_ARGS=()
if [[ -n "$FILTER" ]]; then
  HARNESS_ARGS+=("$FILTER")
fi
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
  echo "== ${mode^^} harness =="
  BASE_URL="http://localhost:${PORT}" "$@" | tee "$log_file"
}

if [[ "$RUN_IR" -eq 1 ]]; then
  run_harness "ir" node "$ROOT_DIR/scripts/ir-harness.mjs" "${HARNESS_ARGS[@]}"
fi

if [[ "$RUN_LEGACY" -eq 1 ]]; then
  run_harness "legacy" node "$ROOT_DIR/scripts/ir-harness.mjs" "${HARNESS_ARGS[@]}" --legacy
fi

if [[ "$RUN_PERF" -eq 1 ]]; then
  mkdir -p "$(dirname "$PERF_OUT")"
  run_harness "perf" env PERF_RUNS="$PERF_RUNS_VALUE" node "$ROOT_DIR/scripts/ir-harness.mjs" "${HARNESS_ARGS[@]}" --perf --perf-out "$PERF_OUT"
fi

echo
echo "Completed."
echo "Run directory: $OUT_DIR"
echo "Server log: $OUT_DIR/server.log"
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
