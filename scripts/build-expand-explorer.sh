#!/usr/bin/env bash
#
# Build the Expand Explorer static site bundle for a specific server base URL.
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
STATIC_DIR="$(dirname "$0")/../static"
SRC="$STATIC_DIR/expand-explorer.html"

mkdir -p "$OUT_DIR"
mkdir -p "$OUT_DIR/js"

# Shared static assets/pages used by the explorer + IR docs/tools.
cp "$STATIC_DIR/compile-to-ir.html" "$OUT_DIR/compile-to-ir.html"
cp "$STATIC_DIR/ir.html" "$OUT_DIR/ir.html"
cp "$STATIC_DIR/ir.md" "$OUT_DIR/ir.md"
cp "$STATIC_DIR/js/standalone-vs-ir-compiler.js" "$OUT_DIR/js/standalone-vs-ir-compiler.js"
cp "$STATIC_DIR/js/expand-explorer-test-cases.js" "$OUT_DIR/js/expand-explorer-test-cases.js"

if [ -z "$BASE_URL" ]; then
  # No base URL — keep the default auto-detect behavior
  cp "$SRC" "$OUT_DIR/expand-explorer.html"
  echo "Built explorer site → $OUT_DIR/ (auto-detect server URL)"
else
  # Inject the base URL as a global variable before the closing </head>
  sed "s|</head>|<script>window.__EXPAND_EXPLORER_BASE_URL__ = '${BASE_URL}';</script></head>|" \
    "$SRC" > "$OUT_DIR/expand-explorer.html"
  echo "Built explorer site → $OUT_DIR/ (server: $BASE_URL)"
fi
