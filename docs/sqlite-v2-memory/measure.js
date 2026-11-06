// node measure.js <label> <dataDir> <port> <replay:yes|no>
// starts FHIRsmith with dataDir, records startup time and memory after startup, after a catalog
// replay, and after a replay with _trace=cold. Prints one JSON line.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const REPO = '/home/jmandel/hobby/.agent-scratch/fhirsmith-sqlite-v2-provider';
const [label, dataDir, port, doReplay, outDir] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function proc(pid) {
  const o = {};
  for (const l of fs.readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')) {
    const m = /^(VmRSS|RssAnon|RssFile|RssShmem|VmHWM):\s+(\d+) kB/.exec(l);
    if (m) o[m[1]] = Math.round(Number(m[2]) / 1024); // MiB
  }
  return o;
}
async function sample(pid, base) {
  await sleep(3000);
  const p = proc(pid);
  let inner = null;
  try {
    const j = await (await fetch(base + '/sqlite-v2/stats?gc=1')).json();
    const m = j.process;
    const MB = (x) => Math.round(x / 1048576);
    inner = { heapUsed: MB(m.heapUsed), heapTotal: MB(m.heapTotal), external: MB(m.external), arrayBuffers: MB(m.arrayBuffers),
      caches: j.caches ? Object.fromEntries(Object.entries(j.caches).map(([k, c]) => [k, { bytes: k === 'codes' ? null : MB(c.size), entries: c.entries, hits: c.hits, misses: c.misses, evictions: c.evictions }])) : null,
      orderArraysMB: j.data ? MB(j.data.orderArraysBytes) : null, stores: j.stores ? j.stores.length : null };
    await sleep(1000);
    Object.assign(inner, { afterGc: proc(pid) });
  } catch (e) { inner = { error: e.message }; }
  return { ...p, ...inner };
}
(async () => {
  const t0 = Date.now();
  const child = spawn('node', ['--expose-gc', 'server.js'], { cwd: REPO, env: { ...process.env, FHIRSMITH_DATA_DIR: dataDir }, stdio: ['ignore', fs.openSync(dataDir + '/measure-server.log', 'w'), 'ignore'] });
  const base = `http://localhost:${port}/r4`;
  for (;;) {
    try { const r = await fetch(base + '/metadata'); if (r.status === 200) break; } catch (e) { /* not yet */ }
    if (Date.now() - t0 > 600000) throw new Error('no start');
    await sleep(250);
  }
  const out = { label, startupMs: Date.now() - t0 };
  out.afterStartup = await sample(child.pid, base);
  if (doReplay === 'yes') {
    let n = 0;
    const rp = (extra) => { const t = Date.now(); try { execFileSync('node', ['tx/sqlite-v2/catalog/replay.js', '--base', base, '--json', `${outDir}/${label}-replay${++n}.json`], { cwd: REPO, env: { ...process.env, CATALOG_EXTRA_PARAMS: extra }, stdio: 'ignore', timeout: 1800000 }); } catch (e) { /* exit 1 on differences */ } return Date.now() - t; };
    out.replayMs = rp('');
    out.afterReplay = await sample(child.pid, base);
    out.replayColdMs = rp('_trace=cold');
    out.afterColdReplay = await sample(child.pid, base);
  }
  child.kill('SIGTERM');
  await sleep(1500);
  console.log(JSON.stringify(out));
})();
