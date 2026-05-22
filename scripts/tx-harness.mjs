#!/usr/bin/env node
import { createWriteStream, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile as execFileCb, spawn } from 'node:child_process';
import net from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import yaml from 'yaml';

const execFile = promisify(execFileCb);
const ROOT_DIR = resolve(dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_LIBRARY = resolve(ROOT_DIR, 'tests/tx/fixtures/v0-test-library.yaml');
const DEFAULT_THIRD_LIBRARY = resolve(ROOT_DIR, 'tests/tx/fixtures/upstream-provider-test-library.yaml');
const DEFAULT_CACHE_ROOT = resolve(ROOT_DIR, 'tmp/tx-harness-cache');
const REQUIRED_V0_DBS = ['sct_intl_20250201.v0.db', 'loinc_281_full.v0.db', 'rxnorm_02022026.v0.db'];
const REQUIRED_UPSTREAM_DBS = ['sct_intl_20250201.cache', 'loinc-2.81-b.db', 'rxnorm_02032025-a.db'];
const RUNNER_SCRIPT = resolve(ROOT_DIR, 'scripts/tx-harness-runner.mjs');
const SERVER_SCRIPT = resolve(ROOT_DIR, 'server.js');
const BUILD_CONFIG_SCRIPT = resolve(ROOT_DIR, 'scripts/build-tx-harness-config.mjs');
const GENERATE_SUPP_SCRIPT = resolve(ROOT_DIR, 'scripts/generate-dice-supplements.mjs');

function cliHasOption(name) {
  return process.argv.slice(2).some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function resolvePath(value) {
  return value && value.startsWith('/') ? value : resolve(ROOT_DIR, value || '.');
}

function ensureFile(pathValue, label) {
  if (!existsSync(pathValue)) throw new Error(`${label} not found: ${pathValue}`);
}

function ensureDir(pathValue, label) {
  if (!existsSync(pathValue)) throw new Error(`${label} does not exist: ${pathValue}`);
}

function ensureSymlink(linkPath, targetPath) {
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      return;
    }
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(targetPath, linkPath, 'dir');
}

function collect(value, previous) {
  previous.push(value);
  return previous;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function reserveEphemeralPort(avoid = new Set()) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await new Promise((resolvePromise, rejectPromise) => {
      const server = net.createServer();
      server.unref();
      server.on('error', rejectPromise);
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = server.address();
        const chosen = address && typeof address === 'object' ? address.port : null;
        server.close((err) => (err ? rejectPromise(err) : resolvePromise(chosen)));
      });
    });
    if (port && !avoid.has(port)) return port;
  }
  throw new Error('Unable to reserve an ephemeral local port');
}

async function choosePort(preferred, { explicit = false, avoid = new Set() } = {}) {
  if (explicit) {
    for (let port = preferred; port <= 65535; port++) {
      if (avoid.has(port)) continue;
      try {
        const server = net.createServer();
        server.unref();
        await new Promise((resolvePromise, rejectPromise) => {
          server.once('error', rejectPromise);
          server.listen({ host: '127.0.0.1', port }, () => server.close((err) => (err ? rejectPromise(err) : resolvePromise())));
        });
        return port;
      } catch {
        continue;
      }
    }
    throw new Error(`Unable to find a free local port starting from ${preferred}`);
  }
  return reserveEphemeralPort(avoid);
}

async function waitForReady(baseUrl, child, logPath, label) {
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/r4/metadata`);
      if (resp.ok) return;
    } catch {
      // keep waiting
    }
    if (child.exitCode != null) {
      throw new Error(`${label} exited before becoming ready. See ${logPath}`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label} readiness at ${baseUrl}/r4/metadata`);
}

function pipeChildToLog(child, logPath) {
  const stream = createWriteStream(logPath, { flags: 'a' });
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
    stream.write(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
    stream.write(chunk);
  });
  child.on('close', () => stream.end());
}

async function startManagedServer({ dataDir, dbDir, port, logPath, label }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const env = {
      ...process.env,
      FHIRSMITH_DATA_DIR: dataDir,
      V0_DB_DIR: dbDir,
    };
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      cwd: ROOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipeChildToLog(child, logPath);
    const baseUrl = `http://localhost:${port}`;
    try {
      await waitForReady(baseUrl, child, logPath, label);
      return { child, port, baseUrl };
    } catch (error) {
      child.kill('SIGTERM');
      await new Promise((resolvePromise) => child.once('close', resolvePromise));
      if (!/EADDRINUSE|before becoming ready|Timed out waiting/.test(String(error?.message || '')) || attempt === 4) {
        throw error;
      }
    }
  }
  throw new Error(`Unable to start ${label}`);
}

async function runNodeScript(scriptPath, args, options = {}) {
  const { stdout, stderr } = await execFile(process.execPath, [scriptPath, ...args], {
    cwd: ROOT_DIR,
    env: options.env || process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

async function generateHarnessLibrary(baseLibrary, outDir) {
  await runNodeScript(BUILD_CONFIG_SCRIPT, ['--base-library', baseLibrary, '--out-dir', outDir]);
  return resolve(outDir, 'library.yaml');
}

async function generateSyntheticSupplementLibrary({ librarySource, outDir, dbDir, urlRoot, dice }) {
  const syntheticDir = resolve(outDir, 'synthetic-supplements/loinc');
  mkdirSync(syntheticDir, { recursive: true });
  await runNodeScript(GENERATE_SUPP_SCRIPT, [
    '--db', resolve(dbDir, 'loinc_281_full.v0.db'),
    '--out-dir', syntheticDir,
    '--dice', dice,
    '--formats', 'sqlite',
    '--url-root', urlRoot,
  ]);
  const manifestPath = resolve(syntheticDir, 'manifest.json');
  const generatedLibrary = resolve(outDir, 'library.synthetic-supplements.yaml');
  const config = yaml.parse(await (await import('node:fs/promises')).readFile(librarySource, 'utf8'));
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
  const sqliteFiles = (manifest.supplements || [])
    .map((item) => item.sqliteFile ? resolve(syntheticDir, item.sqliteFile) : null)
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
  if (!patched) throw new Error(`Did not find a LOINC sqlite-v0 source in ${librarySource}`);
  writeFileSync(generatedLibrary, yaml.stringify(config), 'utf8');
  return {
    librarySource: generatedLibrary,
    syntheticDir,
    manifestPath,
    urlRoot,
  };
}

function writeServerConfig({ dataDir, port, librarySource, name, title }) {
  writeFileSync(resolve(dataDir, 'config.json'), JSON.stringify({
    hostName: name,
    server: { port, cors: { origin: '*', credentials: true } },
    modules: {
      shl: { enabled: false },
      vcl: { enabled: false },
      xig: { enabled: false },
      packages: { enabled: false },
      registry: { enabled: false },
      publisher: { enabled: false },
      token: { enabled: false },
      npmprojector: { enabled: false },
      tx: {
        enabled: true,
        host: `localhost:${port}`,
        baseUrl: `http://localhost:${port}`,
        name,
        title,
        librarySource,
        cacheTimeout: 30,
        expansionCacheSize: 1000,
        endpoints: [
          { path: '/r4', fhirVersion: '4.0', context: null },
          { path: '/r5', fhirVersion: '5.0', context: null },
        ],
      },
    },
  }, null, 2), 'utf8');
}

async function warmPerfBackend(baseUrl, engine, label) {
  const urls = [
    'http%3A%2F%2Fsnomed.info%2Fsct%3Ffhir_vs%3Disa%2F73211009',
    'http%3A%2F%2Floinc.org%3Ffhir_vs%3Dall',
    'http%3A%2F%2Fwww.nlm.nih.gov%2Fresearch%2Fumls%2Frxnorm%3Ffhir_vs%3Dall',
  ];
  for (const url of urls) {
    try {
      await fetch(`${baseUrl}/r4/ValueSet/$expand?url=${url}&count=1&_nocache=true&_engine=${engine}`, { signal: AbortSignal.timeout(30000) });
    } catch {
      // warm-up is best-effort
    }
  }
  console.log(`Warmed ${label} (${engine})`);
}

async function runHarnessMode({ mode, runnerArgs, env, outDir }) {
  const logFile = resolve(outDir, `harness-${mode}.log`);
  const child = spawn(process.execPath, [RUNNER_SCRIPT, ...runnerArgs], {
    cwd: ROOT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeChildToLog(child, logFile);
  const exitCode = await new Promise((resolvePromise) => child.on('close', resolvePromise));
  if (exitCode !== 0) throw new Error(`${mode} harness failed (see ${logFile})`);
}

function buildRunnerArgs(options, mode, outDir) {
  const args = [];
  for (const value of options.filters) args.push('--filter', value);
  for (const value of options.kinds) args.push('--kind', value);
  for (const value of options.categories) args.push('--category', value);
  if (options.trace) args.push('--trace');
  if (options.strictIrNoFallback) args.push('--strict-ir-no-fallback');
  if (options.semanticParity) args.push('--semantic-parity');
  if (options.strictTotalConsistency) args.push('--strict-total-consistency');
  if (mode === 'legacy') args.push('--legacy');
  if (mode === 'perf') {
    args.push('--perf', '--perf-out', options.perfOut);
  } else {
    const matrixOut = mode === 'legacy'
      ? resolve(outDir, 'tx-matrix.legacy.html')
      : resolve(outDir, 'tx-matrix.html');
    args.push('--matrix-out', matrixOut);
  }
  return args;
}

async function main() {
  const program = new Command();
  program
    .name('tx-harness')
    .description('Unified TX harness: manages servers, runs matrix/perf cases, writes artifacts')
    .argument('[filters...]')
    .option('--ir', 'run current unified matrix')
    .option('--legacy', 'run unified matrix with the legacy worker path as default')
    .option('--perf', 'run perf matrix')
    .option('--all', 'run ir + legacy + perf')
    .option('--base-url <url>', 'use an already running primary server instead of launching one')
    .option('--third-base-url <url>', 'use an already running third server instead of launching one')
    .option('--port <n>', 'preferred local server port', (value) => parseInt(value, 10))
    .option('--third-port <n>', 'preferred third server port', (value) => parseInt(value, 10))
    .option('--db-dir <path>', 'v0 DB directory')
    .option('--upstream-db-dir <path>', 'upstream DB/cache dir')
    .option('--library-source <path>', 'library YAML source', DEFAULT_LIBRARY)
    .option('--third-library-source <path>', 'third server YAML source', DEFAULT_THIRD_LIBRARY)
    .option('--with-synthetic-supplements', 'enable synthetic sqlite supplements')
    .option('--without-synthetic-supplements', 'disable synthetic sqlite supplements')
    .option('--synthetic-supp-url-root <url>', 'synthetic supplement canonical root', 'http://example.org/fhir/CodeSystem/harness-dice-supplement')
    .option('--synthetic-supp-dice <list>', 'comma-separated dice specs', 'd20,d8')
    .option('--perf-third-upstream', 'add third timing column from a second server')
    .option('--out-root <path>', 'root output dir', 'tmp/tx-harness-runs')
    .option('--cache-root <path>', 'persistent harness cache root', DEFAULT_CACHE_ROOT)
    .option('--out-dir <path>', 'exact output dir')
    .option('--perf-out <path>', 'perf HTML output path')
    .option('--perf-runs <n>', 'PERF_RUNS value', (value) => parseInt(value, 10), 1)
    .option('--filter <text>', 'name filter', collect, [])
    .option('--kind <kind>', 'operation kind filter', collect, [])
    .option('--category <name>', 'category filter', collect, [])
    .option('--trace', 'pass --trace to harness')
    .option('--strict-ir-no-fallback', 'fail if IR requests fall back to legacy')
    .option('--semantic-parity', 'fail if IR and legacy semantic outputs disagree (when both succeed)')
    .option('--strict-total-consistency', 'fail when total is inconsistent with returned contains')
    .allowExcessArguments(true)
    .parse(process.argv);

  const options = program.opts();
  options.filters = [...(options.filter || []), ...(program.args || [])];
  options.kinds = options.kind || [];
  options.categories = options.category || [];
  options.strictIrNoFallback = !!options.strictIrNoFallback;
  const explicitLibrary = cliHasOption('--library-source');
  const explicitPort = cliHasOption('--port');
  const explicitThirdPort = cliHasOption('--third-port');
  const explicitSynthetic = cliHasOption('--with-synthetic-supplements') || cliHasOption('--without-synthetic-supplements');

  const selectedModes = options.all
    ? ['ir', 'legacy', 'perf']
    : [options.ir ? 'ir' : null, options.legacy ? 'legacy' : null, options.perf ? 'perf' : null].filter(Boolean);
  const modes = selectedModes.length > 0 ? selectedModes : ['ir'];

  const managedPrimary = !options.baseUrl;
  const managedThird = options.perfThirdUpstream && !options.thirdBaseUrl;

  const dbDirRaw = options.dbDir || process.env.FHIRSMITH_V0_DB_DIR || process.env.V0_DB_DIR;
  const upstreamDbDirRaw = options.upstreamDbDir || process.env.FHIRSMITH_UPSTREAM_DB_DIR || process.env.UPSTREAM_DB_DIR;
  const baseLibrary = resolvePath(options.librarySource);
  const thirdLibrary = resolvePath(options.thirdLibrarySource);
  ensureFile(baseLibrary, 'Library source');
  if (options.perfThirdUpstream) ensureFile(thirdLibrary, 'Third-library source');

  if (managedPrimary) {
    if (!dbDirRaw) throw new Error('Missing DB dir. Set --db-dir or FHIRSMITH_V0_DB_DIR (or V0_DB_DIR).');
    const dbDir = resolvePath(dbDirRaw);
    ensureDir(dbDir, 'DB dir');
    for (const db of REQUIRED_V0_DBS) ensureFile(resolve(dbDir, db), 'Required DB file');
    options.dbDir = dbDir;
  }
  if (managedThird) {
    if (!upstreamDbDirRaw) throw new Error('Missing upstream DB dir. Set --upstream-db-dir or FHIRSMITH_UPSTREAM_DB_DIR (or UPSTREAM_DB_DIR).');
    const upstreamDbDir = resolvePath(upstreamDbDirRaw);
    ensureDir(upstreamDbDir, 'Upstream DB dir');
    for (const db of REQUIRED_UPSTREAM_DBS) ensureFile(resolve(upstreamDbDir, db), 'Required upstream file');
    options.upstreamDbDir = upstreamDbDir;
  }

  if (modes.includes('perf') && !explicitSynthetic) options.withSyntheticSupplements = true;
  if (options.withoutSyntheticSupplements) options.withSyntheticSupplements = false;

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = resolvePath(options.outDir || join(options.outRoot, stamp));
  mkdirSync(outDir, { recursive: true });
  const cacheRoot = resolvePath(options.cacheRoot);
  mkdirSync(cacheRoot, { recursive: true });
  const perfOut = resolvePath(options.perfOut || join(outDir, 'perf-table.html'));
  options.perfOut = perfOut;

  let librarySource = baseLibrary;
  if (managedPrimary && !explicitLibrary) {
    librarySource = await generateHarnessLibrary(baseLibrary, outDir);
  }
  let syntheticInfo = null;
  if (managedPrimary && options.withSyntheticSupplements) {
    syntheticInfo = await generateSyntheticSupplementLibrary({
      librarySource,
      outDir,
      dbDir: options.dbDir,
      urlRoot: options.syntheticSuppUrlRoot,
      dice: options.syntheticSuppDice,
    });
    librarySource = syntheticInfo.librarySource;
  }

  const primaryDataDir = resolve(outDir, 'data');
  mkdirSync(primaryDataDir, { recursive: true });
  const primaryTerminologyCache = resolve(cacheRoot, 'primary');
  mkdirSync(primaryTerminologyCache, { recursive: true });
  ensureSymlink(resolve(primaryDataDir, 'terminology-cache'), primaryTerminologyCache);
  let thirdDataDir = null;
  if (managedThird) {
    thirdDataDir = resolve(outDir, 'data-third');
    mkdirSync(thirdDataDir, { recursive: true });
    const target = resolve(thirdDataDir, 'terminology-cache');
    ensureSymlink(target, options.upstreamDbDir);
  }

  const usedPorts = new Set();
  let primaryServer = null;
  let thirdServer = null;
  const cleanupTasks = [];
  try {
    if (managedPrimary) {
      const port = await choosePort(options.port || 8000, { explicit: explicitPort, avoid: usedPorts });
      usedPorts.add(port);
      writeServerConfig({
        dataDir: primaryDataDir,
        port,
        librarySource,
        name: 'FHIRsmith TX Harness Runner',
        title: 'TX Harness Terminology Service',
      });
      console.log(`Output directory: ${outDir}`);
      console.log(`Starting server on :${port} ...`);
      primaryServer = await startManagedServer({
        dataDir: primaryDataDir,
        dbDir: options.dbDir,
        port,
        logPath: resolve(outDir, 'server.log'),
        label: 'primary server',
      });
      cleanupTasks.push(() => primaryServer?.child.kill('SIGTERM'));
      options.baseUrl = primaryServer.baseUrl;
    } else {
      options.baseUrl = String(options.baseUrl).replace(/\/+$/, '');
      console.log(`Using existing primary server: ${options.baseUrl}`);
    }

    if (modes.includes('perf')) {
      await warmPerfBackend(options.baseUrl, 'ir', 'primary backend');
      await warmPerfBackend(options.baseUrl, 'legacy', 'primary backend');
    }

    if (options.perfThirdUpstream) {
      if (managedThird) {
        const port = await choosePort(options.thirdPort || 8001, { explicit: explicitThirdPort, avoid: usedPorts });
        usedPorts.add(port);
        writeServerConfig({
          dataDir: thirdDataDir,
          port,
          librarySource: thirdLibrary,
          name: 'FHIRsmith TX Harness Runner (Third Backend)',
          title: 'TX Harness Terminology Service (Third Backend)',
        });
        console.log(`Starting third server on :${port} ...`);
        thirdServer = await startManagedServer({
          dataDir: thirdDataDir,
          dbDir: options.upstreamDbDir,
          port,
          logPath: resolve(outDir, 'server-third.log'),
          label: 'third server',
        });
        cleanupTasks.push(() => thirdServer?.child.kill('SIGTERM'));
        options.thirdBaseUrl = thirdServer.baseUrl;
      } else {
        options.thirdBaseUrl = String(options.thirdBaseUrl).replace(/\/+$/, '');
        console.log(`Using existing third server: ${options.thirdBaseUrl}`);
      }
      if (modes.includes('perf')) {
        await warmPerfBackend(options.thirdBaseUrl, 'legacy', 'third backend');
      }
    }

    for (const mode of modes) {
      const env = {
        ...process.env,
        BASE_URL: options.baseUrl,
      };
      if (mode !== 'legacy' && syntheticInfo?.urlRoot) {
        env.HARNESS_SQLITE_SUPP_URL_ROOT = syntheticInfo.urlRoot;
      }
      if (mode === 'perf') {
        env.PERF_RUNS = String(options.perfRuns);
        env.PERF_PRIMARY_LABEL = 'IR Branch + IR Worker';
        env.PERF_SECONDARY_LABEL = 'IR Branch + Legacy Worker';
        if (options.perfThirdUpstream) {
          env.PERF_THIRD_BASE_URL = options.thirdBaseUrl;
          env.PERF_THIRD_ENGINE = 'legacy';
          env.PERF_THIRD_LABEL = 'Upstream Providers + Legacy Worker';
          env.PERF_THIRD_HTTP_TIMEOUT_MS = process.env.PERF_THIRD_HTTP_TIMEOUT_MS || '5000';
        }
      }
      const args = buildRunnerArgs(options, mode, outDir);
      const modeLabel = mode === 'ir'
        ? 'TX harness (IR-default matrix)'
        : mode === 'legacy'
          ? 'TX harness (legacy-default matrix)'
          : 'TX harness (perf matrix)';
      console.log(`== ${modeLabel} ==`);
      await runHarnessMode({ mode, runnerArgs: args, env, outDir });
    }

    console.log('\nCompleted.');
    console.log(`Run directory: ${outDir}`);
    console.log(`Harness cache root: ${cacheRoot}`);
    if (managedPrimary) console.log(`Server log: ${resolve(outDir, 'server.log')}`);
    if (syntheticInfo) {
      console.log(`Synthetic supplements: ${syntheticInfo.syntheticDir}`);
      console.log(`Synthetic supplement manifest: ${syntheticInfo.manifestPath}`);
      console.log(`Synthetic supplement URL root: ${syntheticInfo.urlRoot}`);
    }
    if (managedThird) console.log(`Third server log: ${resolve(outDir, 'server-third.log')}`);
    if (modes.includes('ir')) {
      console.log(`IR log: ${resolve(outDir, 'harness-ir.log')}`);
      console.log(`IR matrix: ${resolve(outDir, 'tx-matrix.html')}`);
    }
    if (modes.includes('legacy')) {
      console.log(`Legacy log: ${resolve(outDir, 'harness-legacy.log')}`);
      console.log(`Legacy matrix: ${resolve(outDir, 'tx-matrix.legacy.html')}`);
    }
    if (modes.includes('perf')) {
      console.log(`Perf log: ${resolve(outDir, 'harness-perf.log')}`);
      console.log(`Perf HTML: ${perfOut}`);
    }
  } finally {
    for (const task of cleanupTasks.reverse()) {
      try { task(); } catch {}
    }
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(2);
});
