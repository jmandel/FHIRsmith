#!/usr/bin/env bash
# Run the HL7 tx-ecosystem test-cases suite with a named engine, and check that the engine
# named is the one that served (tests/tx/README.md "Engine runs").
#
#   test-scripts/test-cases-engine.sh --engine classic|v2|both --seed <dir> [--out <dir>]
#
#   --engine classic  tx/fixtures/test-cases-setup-classic.json: main's providers, content store off
#            v2       tx/fixtures/test-cases-setup-v2.json: sqlite-v2 LOINC 2.83 + SNOMED CT Intl 20260701
#                     + test edition, content store on
#            both     classic, then v2, then a comparison of the failing tests
#   --seed <dir>      terminology files to link into each run's private data directory
#                     (FHIRSMITH_DATA_DIR/terminology-cache): files are symlinked, package folders
#                     hard-link copied. classic needs Loinc_2.83b.db, Snomed_Intl_20260701.cache,
#                     sct_test_20250909i.cache; v2 needs loinc-2.83.db, sct-intl-20260701.db,
#                     sct-test-20250909-nl.db; both need omop_v20250227.db, icd11-2026-01-b.db.
#                     Anything missing is downloaded from the library's base url at startup.
#   --out <dir>       where runs go (default ./test-cases-runs); each run: jest.log, summary,
#                     report json, engine.json (the providers that served), exit status
#
# FHIRSMITH_ENGINE is set for the run, so the server stops at startup if any SNOMED CT, LOINC or
# RxNorm file is served by the other engine (tx/engine-report.js). Optional:
# FHIRSMITH_VALIDATOR_JAR (a pinned validator; recorded in the summary), TIMEOUT (seconds per
# run, default 1500: a run takes about 8 minutes), MEMORY_MAX (default 6G, needs systemd-run).
set -euo pipefail

engine= seed= out=
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) engine=$2; shift 2 ;;
    --seed) seed=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$engine" in classic|v2|both) ;; *) echo "--engine classic|v2|both is required" >&2; exit 2 ;; esac
[ -n "$seed" ] && [ -d "$seed" ] || { echo "--seed <dir> is required" >&2; exit 2; }

repo=$(cd "$(dirname "$0")/.." && pwd)
out=$(mkdir -p "${out:-$repo/test-cases-runs}" && cd "${out:-$repo/test-cases-runs}" && pwd)
seed=$(cd "$seed" && pwd)
commit=$(git -C "$repo" rev-parse --short HEAD)

run_one() {
  local e=$1 r="$out/$1"
  rm -rf "$r"; mkdir -p "$r/data/terminology-cache" "$r/tmp"
  for f in "$seed"/*; do
    if [ -d "$f" ]; then cp -al "$f" "$r/data/terminology-cache/"; else ln -s "$(readlink -f "$f")" "$r/data/terminology-cache/$(basename "$f")"; fi
  done
  echo "$commit" > "$r/commit.txt"
  local cap=()
  if command -v systemd-run >/dev/null 2>&1; then cap=(systemd-run --user --scope -q -p "MemoryMax=${MEMORY_MAX:-6G}"); fi
  local start=$(date +%s) status=0
  ( cd "$repo" && FHIRSMITH_ENGINE=$e FHIRSMITH_TX_TEST_CONFIG="$repo/tx/fixtures/test-cases-setup-$e.json" \
      FHIRSMITH_DATA_DIR="$r/data" TMPDIR="$r/tmp" \
      timeout "${TIMEOUT:-1500}" "${cap[@]}" npx jest tests/tx/test-cases.test.js ) > "$r/jest.log" 2>&1 || status=$?
  echo "exit $status elapsed $(( $(date +%s) - start ))s" > "$r/done.txt"
  for f in test-cases-summary.txt test-cases-report.json test-cases-engine.json; do
    [ -f "$repo/$f" ] && mv "$repo/$f" "$r/$f"
  done
  grep -h "Engine check failed" "$r/jest.log" | head -1 || true
  # the provider registration lines and the engines line, as the server logged them
  grep -E "Engines: |Engine check " "$r/jest.log" | head -3 | sed 's/^/  /' || true
  printf '%s: %s\n' "$e" "$(cat "$r/test-cases-summary.txt" 2>/dev/null || echo "no summary (see $r/jest.log)")"
  grep -E "^\s+● .* › " "$r/jest.log" | sed -E 's/^\s+● //' | sort -u > "$r/failed.txt" || true
  [ -f "$r/test-cases-engine.json" ] || { echo "$e: no engine record; the run did not start" >&2; return 1; }
  local label; label=$(node -e "console.log(require('$r/test-cases-engine.json').label)")
  [ "$label" = "$e" ] || { echo "$e: the run was labelled '$label', not '$e'" >&2; return 1; }
  return $status
}

rc=0
if [ "$engine" = both ]; then
  run_one classic || rc=1
  run_one v2 || rc=1
  { echo "# test-cases, classic vs v2 at $commit"; echo
    echo "classic: $(cat "$out/classic/test-cases-summary.txt" 2>/dev/null)"
    echo "v2:      $(cat "$out/v2/test-cases-summary.txt" 2>/dev/null)"; echo
    echo "## fail with v2 only"; comm -13 "$out/classic/failed.txt" "$out/v2/failed.txt"; echo
    echo "## fail with classic only"; comm -23 "$out/classic/failed.txt" "$out/v2/failed.txt"; echo
    echo "## fail with both"; comm -12 "$out/classic/failed.txt" "$out/v2/failed.txt"; } > "$out/COMPARE.md"
  cat "$out/COMPARE.md"
else
  run_one "$engine" || rc=1
fi
exit $rc
