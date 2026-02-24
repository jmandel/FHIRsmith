#!/usr/bin/env bash
#
# Build the Expand Explorer static HTML for a specific server base URL.
#
# Usage:
#   ./scripts/build-expand-explorer.sh [BASE_URL] [OUT_DIR]
#
# Arguments:
#   BASE_URL  FHIR server base URL (default: auto-detect from window.location)
#   OUT_DIR   Output directory (default: ./dist)
#
# Examples:
#   ./scripts/build-expand-explorer.sh                              # dev: auto-detect
#   ./scripts/build-expand-explorer.sh http://localhost:9450/r4      # local server
#   ./scripts/build-expand-explorer.sh https://tx.example.org/r4    # production
#   ./scripts/build-expand-explorer.sh https://tx.example.org/r4 /var/www/html

set -euo pipefail

BASE_URL="${1:-}"
OUT_DIR="${2:-./dist}"
SRC="$(dirname "$0")/../static/expand-explorer.html"

mkdir -p "$OUT_DIR"

if [ -z "$BASE_URL" ]; then
  # No base URL — keep the default auto-detect behavior
  cp "$SRC" "$OUT_DIR/expand-explorer.html"
  echo "Built expand-explorer.html → $OUT_DIR/ (auto-detect server URL)"
else
  # Inject the base URL as a global variable before the closing </head>
  sed "s|</head>|<script>window.__EXPAND_EXPLORER_BASE_URL__ = '${BASE_URL}';</script></head>|" \
    "$SRC" > "$OUT_DIR/expand-explorer.html"
  echo "Built expand-explorer.html → $OUT_DIR/ (server: $BASE_URL)"
fi
