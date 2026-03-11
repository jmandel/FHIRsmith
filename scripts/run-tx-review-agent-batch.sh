#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/run-tx-review-agent-batch.sh <batch-dir> [options]

Options:
  --cmd <template>     Command template for the external agent
  --parallel <n>       Number of issue folders to process concurrently (default: 4)
  --only <csv>         Restrict to issue folder names or numeric row ids
  --force              Re-run even if report.md already exists and is non-empty
  --dry-run            Print the expanded command for each issue without running it
  --help               Show this message

Template placeholders:
  {batch_dir}
  {issue_dir}
  {issue_name}
  {prompt_file}
  {report_file}
  {issue_json}
  {input_json}
  {detail_json}

Example:
  scripts/run-tx-review-agent-batch.sh tmp/tx-review-batches/my-batch \
    --cmd 'my-agent --cwd {issue_dir} --prompt-file {prompt_file} > {report_file}' \
    --parallel 4
EOF
}

shell_quote() {
  printf '%q' "$1"
}

matches_only_filter() {
  local issue_name=$1
  local only_csv=$2
  local item
  IFS=',' read -r -a only_items <<< "$only_csv"
  for item in "${only_items[@]}"; do
    item=${item//[[:space:]]/}
    [[ -z "$item" ]] && continue
    if [[ "$issue_name" == "$item" || "$issue_name" == "$item"-* ]]; then
      return 0
    fi
  done
  return 1
}

expand_template() {
  local template=$1
  local batch_dir=$2
  local issue_dir=$3
  local issue_name prompt_file report_file issue_json input_json detail_json
  issue_name=$(basename "$issue_dir")
  prompt_file="$issue_dir/prompt.md"
  report_file="$issue_dir/report.md"
  issue_json="$issue_dir/issue.json"
  input_json="$issue_dir/input.json"
  detail_json="$issue_dir/detail.json"

  local expanded=$template
  expanded=${expanded//\{batch_dir\}/$(shell_quote "$batch_dir")}
  expanded=${expanded//\{issue_dir\}/$(shell_quote "$issue_dir")}
  expanded=${expanded//\{issue_name\}/$(shell_quote "$issue_name")}
  expanded=${expanded//\{prompt_file\}/$(shell_quote "$prompt_file")}
  expanded=${expanded//\{report_file\}/$(shell_quote "$report_file")}
  expanded=${expanded//\{issue_json\}/$(shell_quote "$issue_json")}
  expanded=${expanded//\{input_json\}/$(shell_quote "$input_json")}
  expanded=${expanded//\{detail_json\}/$(shell_quote "$detail_json")}
  printf '%s' "$expanded"
}

run_one() {
  local batch_dir=$1
  local issue_dir=$2
  local cmd_template=$3
  local force=$4
  local dry_run=$5
  local issue_name report_file expanded

  issue_name=$(basename "$issue_dir")
  report_file="$issue_dir/report.md"

  if [[ -s "$report_file" && "$force" != "1" ]]; then
    echo "skip $issue_name existing report.md"
    return 0
  fi

  expanded=$(expand_template "$cmd_template" "$batch_dir" "$issue_dir")

  if [[ "$dry_run" == "1" ]]; then
    echo "dry-run $issue_name: $expanded"
    return 0
  fi

  echo "run $issue_name"
  (
    cd "$issue_dir"
    bash -lc "$expanded"
  )
}

if [[ "${1:-}" == "--run-one" ]]; then
  shift
  run_one "$@"
  exit 0
fi

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

batch_dir=$1
shift
batch_dir=$(cd "$batch_dir" && pwd)

parallel=${REVIEW_AGENT_PARALLEL:-4}
cmd_template=${REVIEW_AGENT_CMD:-}
force=0
dry_run=0
only_csv=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cmd)
      cmd_template=$2
      shift 2
      ;;
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
    --dry-run)
      dry_run=1
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

if [[ -z "$cmd_template" ]]; then
  echo "Missing --cmd or REVIEW_AGENT_CMD" >&2
  usage >&2
  exit 1
fi

if ! [[ "$parallel" =~ ^[0-9]+$ ]] || [[ "$parallel" -lt 1 ]]; then
  echo "Invalid --parallel value: $parallel" >&2
  exit 1
fi

if [[ ! -d "$batch_dir/issues" ]]; then
  echo "No issues directory found under $batch_dir" >&2
  exit 1
fi

mapfile -t issues < <(find "$batch_dir/issues" -mindepth 1 -maxdepth 1 -type d | sort)
if [[ -n "$only_csv" ]]; then
  filtered=()
  for issue_dir in "${issues[@]}"; do
    issue_name=$(basename "$issue_dir")
    if matches_only_filter "$issue_name" "$only_csv"; then
      filtered+=("$issue_dir")
    fi
  done
  issues=("${filtered[@]}")
fi

if [[ ${#issues[@]} -eq 0 ]]; then
  echo "No issue folders matched." >&2
  exit 1
fi

printf '%s\0' "${issues[@]}" | xargs -0 -P "$parallel" -I{} bash "$0" --run-one "$batch_dir" "{}" "$cmd_template" "$force" "$dry_run"
