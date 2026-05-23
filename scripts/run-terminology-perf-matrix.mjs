#!/usr/bin/env node
'use strict';

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function envOrDefault(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function envRequired(name) {
  const value = process.env[name];
  if (value && value.trim()) return value.trim();
  throw new Error(`${name} must be set. Example: ${name}=/path/to/terminology-cache`);
}

function ensureDir(pathValue, label) {
  if (!existsSync(pathValue)) {
    throw new Error(`${label} not found: ${pathValue}`);
  }
}

const dbDir = resolve(envRequired('V0_DB_DIR'));
const upstreamDbDir = resolve(envRequired('UPSTREAM_DB_DIR'));
const outDir = resolve(envOrDefault('TX_HARNESS_OUT_DIR', 'tmp/tx-harness-full-perf'));
const cacheRoot = resolve(envOrDefault('TX_HARNESS_CACHE_ROOT', 'tmp/tx-harness-cache'));
const perfRuns = envOrDefault('PERF_RUNS', '1');

ensureDir(dbDir, 'V0_DB_DIR');
ensureDir(upstreamDbDir, 'UPSTREAM_DB_DIR');

const args = [
  'scripts/tx-harness.mjs',
  '--perf',
  '--perf-third-upstream',
  '--db-dir', dbDir,
  '--upstream-db-dir', upstreamDbDir,
  '--out-dir', outDir,
  '--cache-root', cacheRoot,
  '--perf-runs', perfRuns,
  ...process.argv.slice(2),
];

console.log(`Running terminology perf matrix:
  V0_DB_DIR=${dbDir}
  UPSTREAM_DB_DIR=${upstreamDbDir}
  TX_HARNESS_OUT_DIR=${outDir}
  TX_HARNESS_CACHE_ROOT=${cacheRoot}
  PERF_RUNS=${perfRuns}
`);

const child = spawn(process.execPath, args, {
  cwd: ROOT_DIR,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
