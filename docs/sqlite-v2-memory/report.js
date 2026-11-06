// node report.js : markdown tables from results/measure.jsonl and results/*-replay*.json
const fs = require('fs');
const M = '/home/jmandel/hobby/.agent-scratch/mem/results';
const runs = fs.readFileSync(M + '/measure.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const f = (x) => (x == null ? '–' : x < 10 ? x.toFixed(1) : Math.round(x).toString());
function timing(file) {
  if (!fs.existsSync(file)) return null;
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const first = [], deep = [];
  let refused = 0, pages = 0;
  for (const e of r) {
    for (const [pat, pgs] of Object.entries(e.patterns)) {
      pgs.forEach((pg, i) => {
        pages++;
        if (pg.status >= 400) { refused++; return; }
        if (!Number.isFinite(pg.ms)) return;
        if (i === 0 && (pat === 'first-page' || pat === 'single')) first.push(pg.ms);
        else if (i > 0 || pat === 'deep-jump') deep.push(pg.ms);
      });
    }
  }
  return { first, deep, refused, pages };
}
const row = (cols) => '| ' + cols.join(' | ') + ' |';
console.log('### Memory (MiB; "after GC" = after a forced full GC)\n');
console.log(row(['run', 'startup s', 'RSS', 'anon', 'file', 'heap', 'external', 'RSS after replay', 'anon', 'file', 'heap', 'external', 'RSS after GC', 'caches after replay', 'RSS after cold-trace replay']));
console.log(row(Array(15).fill('---')));
for (const r of runs) {
  const a = r.afterStartup || {}, b = r.afterReplay || {}, c = r.afterColdReplay || {};
  const cache = b.caches ? Object.entries(b.caches).map(([k, v]) => `${k} ${v.bytes != null ? v.bytes + ' MiB/' : ''}${v.entries}`).join('; ') : '';
  console.log(row([r.label, (r.startupMs / 1000).toFixed(1), a.VmRSS, a.RssAnon, a.RssFile, a.heapUsed, a.external, b.VmRSS ?? '', b.RssAnon ?? '', b.RssFile ?? '', b.heapUsed ?? '', b.external ?? '', b.afterGc ? b.afterGc.VmRSS : '', cache, c.VmRSS ?? '']));
}
console.log('\n### Per-request time (ms, client-measured, local HTTP)\n');
console.log(row(['run', 'first pages: n', 'median', 'p90', 'worst', 'deep/later pages: n', 'median', 'p90', 'worst', 'refused pages', 'replay s']));
console.log(row(Array(11).fill('---')));
for (const r of runs) {
  const t = timing(`${M}/${r.label}-replay1.json`);
  if (!t) continue;
  console.log(row([r.label, t.first.length, f(q(t.first, 0.5)), f(q(t.first, 0.9)), f(Math.max(...t.first)), t.deep.length, f(q(t.deep, 0.5)), f(q(t.deep, 0.9)), f(Math.max(...t.deep)), `${t.refused} of ${t.pages}`, (r.replayMs / 1000).toFixed(1)]));
}
