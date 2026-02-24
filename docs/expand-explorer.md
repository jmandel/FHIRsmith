# Expand Explorer — Static Demo

A single-page web app for exploring ValueSet `$expand` capabilities with full
debugging output: semantic IR, resolved IR, query IR, SQL queries with labels,
and execution traces.

## Quick Start

```bash
# 1. Start the server (default port from config, or override with PORT)
PORT=9450 node server.js

# 2. Open in a browser
open http://localhost:9450/expand-explorer.html
```

The app auto-detects the server URL from `window.location`.

## Running on a Custom Port

```bash
PORT=8080 node server.js
# → http://localhost:8080/expand-explorer.html
```

## Building for Deployment

When deploying the static HTML separately from the server (e.g. behind a CDN or
on a different host), use the build script to bake in the server base URL:

```bash
# Build with an explicit server URL
./scripts/build-expand-explorer.sh https://tx.example.org/r4 ./dist

# Serve the built file from any static host
cd dist && python3 -m http.server 8000
```

### Build Script Usage

```
./scripts/build-expand-explorer.sh [BASE_URL] [OUT_DIR]
```

| Argument   | Default        | Description                              |
|------------|----------------|------------------------------------------|
| `BASE_URL` | *(auto-detect)* | FHIR server base URL (e.g. `http://localhost:9450/r4`) |
| `OUT_DIR`  | `./dist`       | Output directory for the built HTML file |

**Examples:**

```bash
# Development — auto-detect from browser location
./scripts/build-expand-explorer.sh

# Local server on custom port
./scripts/build-expand-explorer.sh http://localhost:8080/r4

# Production deployment
./scripts/build-expand-explorer.sh https://tx.fhir.org/r4 /var/www/html
```

## CORS

When the explorer HTML is served from a different origin than the FHIR server,
the server must allow CORS. The FHIRsmith server includes CORS headers by
default.

## What It Shows

The app includes 37 pre-built test cases across 11 categories:

| Category            | Examples                                      |
|---------------------|-----------------------------------------------|
| Whole System        | US States, Currencies, Gender, M49 Area Codes |
| Enumerated Concepts | SNOMED, LOINC, RxNorm specific codes          |
| Hierarchy Filters   | SNOMED is-a, descendent-of                    |
| Property Filters    | M49 class=region, regex, decimals=0           |
| Text Search         | SNOMED "diabetes", RxNorm "aspirin"           |
| Excludes            | Concept excludes, subtree excludes            |
| Pagination          | count, offset, count=0 (total only)           |
| Multi-System        | Gender + US States, SNOMED + LOINC + RxNorm   |
| Combined            | is-a + text filter, multi-system + exclude    |
| ValueSet Imports    | Canonical URL imports, system intersection    |
| TX Resources        | Inline CodeSystems, chained VS→CS imports     |

### Debug Sections

Each expansion displays:

- **Results** — expanded codes in a table
- **Semantic IR** — the parsed IR tree from the ValueSet compose
- **Resolved IR** — IR after import resolution and flattening
- **Query IR** — the provider-facing query plan (when compilable)
- **Trace** — execution spans with timing bars, SQL cards inline showing
  the actual SQLite queries with syntax highlighting and semantic labels
  (`page`, `count`, `stream`, `bounded-count`, `designation`)
- **Raw Response** — full JSON response
