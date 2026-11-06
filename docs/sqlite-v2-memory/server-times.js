// node server-times.js run1 run2 ... : server-side time per catalog page, from the server's
// request log ("[tx-N] POST json <status> <ms>ms"), paired in order with the replay's pages
const fs = require('fs');
const M = '/home/jmandel/hobby/.agent-scratch/mem';
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const row = (c) => '| ' + c.join(' | ') + ' |';
const entries = {};
for (const f of fs.readdirSync(M + '/../fhirsmith-sqlite-v2-provider/tx/sqlite-v2/catalog/entries')) { const e = JSON.parse(fs.readFileSync(M + '/../fhirsmith-sqlite-v2-provider/tx/sqlite-v2/catalog/entries/' + f)); entries[e.id] = e; }
const per = {};
for (const arg of process.argv.slice(2)) {
  const [label, pass] = arg.split('@');
  const log = fs.readFileSync(`${M}/runs/${label}/measure-server.log`, 'utf8').split('\n')
    .map((l) => /\{tx\}: \[tx-\d+\] POST json (\d+) (\d+)ms/.exec(l)).filter(Boolean).map((m) => ({ status: +m[1], ms: +m[2] }));
  const r = JSON.parse(fs.readFileSync(`${M}/results/${label}-replay${pass || 1}.json`, 'utf8'));
  // the second pass's log lines follow the first pass's
  let i = pass === '2' ? JSON.parse(fs.readFileSync(`${M}/results/${label}-replay1.json`, 'utf8')).reduce((n, e) => n + Object.values(e.patterns).reduce((m, v) => m + v.length, 0), 0) : 0;
  const pages = [];
  for (const e of r) for (const [pat, pgs] of Object.entries(e.patterns)) pgs.forEach((pg, k) => {
    const s = log[i++];
    pages.push({ id: e.id, category: e.category, kind: k === 0 && (pat === 'first-page' || pat === 'single') ? 'first' : (k > 0 || pat === 'deep-jump') ? 'deep' : 'other', status: s ? s.status : null, ms: s ? s.ms : null, client: pg.ms });
  });
  per[arg] = pages;
}
const labels = Object.keys(per);
console.log('#### Server-side time per page (ms, from the request log)\n');
console.log(row(['run', 'first: n', 'median', 'p90', 'worst', 'deep: n', 'median', 'p90', 'worst', 'refused (4xx/5xx)']));
console.log(row(Array(10).fill('---')));
for (const l of labels) {
  const ok = per[l].filter((p) => p.status && p.status < 400);
  const f = ok.filter((p) => p.kind === 'first').map((p) => p.ms), d = ok.filter((p) => p.kind === 'deep').map((p) => p.ms);
  console.log(row([l, f.length, q(f, .5), q(f, .9), Math.max(...f), d.length, q(d, .5), q(d, .9), Math.max(...d), per[l].filter((p) => p.status >= 400).length + ' of ' + per[l].length]));
}
console.log('\n#### First pages by category: median / worst server ms (refused)\n');
const cats = [...new Set(per[labels[0]].map((p) => p.category))].sort();
console.log(row(['category', ...labels]));
console.log(row(Array(labels.length + 1).fill('---')));
for (const c of cats) {
  console.log(row([c, ...labels.map((l) => {
    const ps = per[l].filter((p) => p.category === c && p.kind === 'first');
    const ok = ps.filter((p) => p.status < 400).map((p) => p.ms);
    return ok.length ? `${q(ok, .5)} / ${Math.max(...ok)} (${ps.length - ok.length})` : `– (${ps.length})`;
  })]));
}
