#!/usr/bin/env bash
# Compare IR vs Legacy engine: correctness and performance
# Usage: ./scripts/compare-engines.sh [base_url]
set -euo pipefail

BASE="${1:-http://localhost:8000}/r4/ValueSet/\$expand"
RUNS=5
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GRN='\033[0;32m'; RED='\033[0;31m'; YEL='\033[0;33m'; RST='\033[0m'

declare -a NAMES METHODS URLS BODIES
i=0

add_get() {
  NAMES[$i]="$1"; METHODS[$i]="GET"; URLS[$i]="$2"; BODIES[$i]=""; ((i++)) || true
}
add_post() {
  NAMES[$i]="$1"; METHODS[$i]="POST"; URLS[$i]="$BASE"; BODIES[$i]="$2"; ((i++)) || true
}

# --- Test cases ---

add_get "SNOMED is-a Diabetes (124 codes)" \
  "${BASE}?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=200&activeOnly=true"

add_get "SNOMED is-a Diabetes count=0" \
  "${BASE}?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=0&activeOnly=true"

add_get "SNOMED is-a Diabetes page1 (offset=0,count=10)" \
  "${BASE}?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=10&offset=0&activeOnly=true"

add_get "SNOMED is-a Diabetes page5 (offset=40,count=10)" \
  "${BASE}?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=10&offset=40&activeOnly=true"

add_get "SNOMED is-a Clinical finding (~124K) first 50" \
  "${BASE}?url=http://snomed.info/sct?fhir_vs=isa/404684003&count=50&activeOnly=true"

add_get "SNOMED is-a Clinical finding count=0" \
  "${BASE}?url=http://snomed.info/sct?fhir_vs=isa/404684003&count=0&activeOnly=true"

add_post "SNOMED diff: Diabetes minus Type2" \
  '{"resourceType":"Parameters","parameter":[{"name":"valueSet","resource":{"resourceType":"ValueSet","compose":{"include":[{"system":"http://snomed.info/sct","filter":[{"property":"concept","op":"is-a","value":"73211009"}]}],"exclude":[{"system":"http://snomed.info/sct","filter":[{"property":"concept","op":"is-a","value":"44054006"}]}]}}},{"name":"count","valueInteger":200},{"name":"activeOnly","valueBoolean":true}]}'

add_post "SNOMED 3-code enumeration + designations" \
  '{"resourceType":"Parameters","parameter":[{"name":"valueSet","resource":{"resourceType":"ValueSet","compose":{"include":[{"system":"http://snomed.info/sct","concept":[{"code":"73211009"},{"code":"44054006"},{"code":"46635009"}]}]}}},{"name":"includeDesignations","valueBoolean":true}]}'

add_post "LOINC CLASSTYPE=1 first 50" \
  '{"resourceType":"Parameters","parameter":[{"name":"valueSet","resource":{"resourceType":"ValueSet","compose":{"include":[{"system":"http://loinc.org","filter":[{"property":"CLASSTYPE","op":"=","value":"1"}]}]}}},{"name":"count","valueInteger":50}]}'

add_post "LOINC CLASSTYPE=1 count=0" \
  '{"resourceType":"Parameters","parameter":[{"name":"valueSet","resource":{"resourceType":"ValueSet","compose":{"include":[{"system":"http://loinc.org","filter":[{"property":"CLASSTYPE","op":"=","value":"1"}]}]}}},{"name":"count","valueInteger":0}]}'

add_get "SNOMED is-a Diabetes + text filter 'gestational'" \
  "${BASE}?url=http://snomed.info/sct?fhir_vs=isa/73211009&count=200&activeOnly=true&filter=gestational"

TOTAL=${#NAMES[@]}

echo "========================================="
echo " IR vs Legacy: Correctness & Performance"
echo " ${TOTAL} test cases, ${RUNS} timing runs each"
echo "========================================="
echo ""

CORRECT=0; INCORRECT=0; ERRORS=0

for ((t=0; t<TOTAL; t++)); do
  name="${NAMES[$t]}"
  method="${METHODS[$t]}"
  url="${URLS[$t]}"
  body="${BODIES[$t]}"

  echo -e "${YEL}[$((t+1))/${TOTAL}] ${name}${RST}"

  # Build request args for each engine
  if [ "$method" = "GET" ]; then
    ir_args=(-sf "${url}&_engine=ir")
    leg_args=(-sf "${url}&_engine=legacy")
    ir_time_args=(-sf -o /dev/null -w '%{time_total}' "${url}&_engine=ir")
    leg_time_args=(-sf -o /dev/null -w '%{time_total}' "${url}&_engine=legacy")
  else
    ir_body=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); d['parameter'].append({'name':'_engine','valueString':'ir'}); print(json.dumps(d))")
    leg_body=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); d['parameter'].append({'name':'_engine','valueString':'legacy'}); print(json.dumps(d))")
    ir_args=(-sf -X POST -H 'Content-Type: application/json' -d "$ir_body" "$BASE")
    leg_args=(-sf -X POST -H 'Content-Type: application/json' -d "$leg_body" "$BASE")
    ir_time_args=(-sf -o /dev/null -w '%{time_total}' -X POST -H 'Content-Type: application/json' -d "$ir_body" "$BASE")
    leg_time_args=(-sf -o /dev/null -w '%{time_total}' -X POST -H 'Content-Type: application/json' -d "$leg_body" "$BASE")
  fi

  # Fetch both (use -s not -sf so we get error response bodies)
  ir_args[0]="-s"
  leg_args[0]="-s"
  ir_resp=$(curl "${ir_args[@]}" 2>/dev/null) || ir_resp='{"expansion":{}}'
  leg_resp=$(curl "${leg_args[@]}" 2>/dev/null) || leg_resp='{"expansion":{}}'

  # Check for OperationOutcome errors
  ir_is_error=$(echo "$ir_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('resourceType')=='OperationOutcome' else '0')" 2>/dev/null || echo "1")
  leg_is_error=$(echo "$leg_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('resourceType')=='OperationOutcome' else '0')" 2>/dev/null || echo "1")

  if [ "$ir_is_error" = "1" ] && [ "$leg_is_error" = "1" ]; then
    echo -e "  ${RED}ERROR: both engines failed${RST}"
    ((ERRORS++)) || true
    echo ""
    continue
  fi
  if [ "$ir_is_error" = "1" ]; then
    ir_issue=$(echo "$ir_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('issue',[{}])[0].get('details',{}).get('text','unknown'))" 2>/dev/null)
    echo -e "  ${RED}IR failed: ${ir_issue}${RST}"
    echo -e "  Legacy returned data; IR did not. Skipping comparison."
    ((ERRORS++)) || true
    echo ""
    continue
  fi
  if [ "$leg_is_error" = "1" ]; then
    leg_issue=$(echo "$leg_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('issue',[{}])[0].get('details',{}).get('text','unknown'))" 2>/dev/null)
    echo -e "  ${YEL}Legacy failed: ${leg_issue}${RST}"
    echo -e "  IR returned data; legacy hit limit. IR-only result:"
    echo "$ir_resp" | python3 -c "import sys,json; e=json.load(sys.stdin).get('expansion',{}); print(f'  total={e.get(\"total\",\"?\")}, codes={len(e.get(\"contains\",[]))}')"
    ((ERRORS++)) || true
    echo ""
    continue
  fi

  # Correctness
  echo "$ir_resp" > /tmp/_ir.json
  echo "$leg_resp" > /tmp/_leg.json
  comparison=$(python3 "${SCRIPT_DIR}/compare-correctness.py")

  status=$(echo "$comparison" | head -1)
  details=$(echo "$comparison" | tail -n +2)
  if [ "$status" = "PASS" ]; then
    echo -e "  ${GRN}PASS${RST}"
    ((CORRECT++)) || true
  else
    echo -e "  ${RED}FAIL${RST}"
    ((INCORRECT++)) || true
  fi
  echo "$details"

  # Performance: collect timing
  ir_times=""
  leg_times=""
  for ((r=0; r<RUNS; r++)); do
    t_ir=$(curl "${ir_time_args[@]}" 2>/dev/null || echo "0")
    t_leg=$(curl "${leg_time_args[@]}" 2>/dev/null || echo "0")
    ir_times="${ir_times} ${t_ir}"
    leg_times="${leg_times} ${t_leg}"
  done

  python3 -c "
import statistics
ir = sorted([float(x) for x in '''${ir_times}'''.split()])
leg = sorted([float(x) for x in '''${leg_times}'''.split()])
ir_med = statistics.median(ir)
leg_med = statistics.median(leg)
ratio = leg_med / ir_med if ir_med > 0.001 else 0
faster = 'IR' if ir_med < leg_med else 'Legacy'
print(f'  perf:     IR={ir_med*1000:.0f}ms  Legacy={leg_med*1000:.0f}ms  ({ratio:.1f}x, {faster} faster)')
"
  echo ""
done

echo "========================================="
echo -e " Results: ${GRN}${CORRECT} pass${RST}, ${RED}${INCORRECT} fail${RST}, ${ERRORS} errors"
echo "========================================="
