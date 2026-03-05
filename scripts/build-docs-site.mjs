#!/usr/bin/env node
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as commonmark from 'commonmark';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { out: path.join(ROOT, 'build', 'docs-site') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      const v = argv[++i];
      if (!v) throw new Error('Missing value for --out');
      args.out = path.resolve(ROOT, v);
      continue;
    }
    if (a.startsWith('--out=')) {
      const v = a.slice('--out='.length);
      if (!v) throw new Error('Missing value for --out');
      args.out = path.resolve(ROOT, v);
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyDir(s, d);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderTopNav(baseHref = '') {
  const p = (rel) => `${baseHref}${rel}`;
  return `
  <nav>
    <div class="inner">
      <strong>FHIRsmith IR Docs</strong>
      <a href="${p('index.html')}">Landing</a>
      <a href="${p('ir-engine.html')}">IR Engine</a>
      <a href="${p('ir-compilation-tester.html')}">Compilation + Fuzzing</a>
      <a href="${p('tools/expand-explorer-lite.html')}">Explorer Lite</a>
      <a href="${p('perf/index.html')}">Perf Matrix</a>
    </div>
  </nav>`;
}

function pageTemplate({
  title,
  bodyHtml,
  baseHref = '',
  mainClass = '',
  extraStyles = '',
}) {
  const mainClassAttr = mainClass ? ` class="${escHtml(mainClass)}"` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; color: #1f2937; background: #f8fafc; }
    main { max-width: 980px; margin: 0 auto; padding: 24px 20px 64px; }
    nav { background: #0f172a; color: #e2e8f0; }
    nav .inner { max-width: 980px; margin: 0 auto; padding: 14px 20px; display: flex; gap: 14px; align-items: center; }
    nav a { color: #93c5fd; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    h1, h2, h3 { color: #0f172a; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 18px; margin: 14px 0; }
    code, pre { background: #f1f5f9; }
    pre { padding: 12px; border-radius: 8px; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; }
    th { background: #f8fafc; }
    ul { line-height: 1.5; }
${extraStyles}
  </style>
</head>
<body>
${renderTopNav(baseHref)}
  <main${mainClassAttr}>
${bodyHtml}
  </main>
</body>
</html>
`;
}

function markdownToHtml(mdText) {
  const parser = new commonmark.Parser();
  const renderer = new commonmark.HtmlRenderer();
  return renderer.render(parser.parse(mdText));
}

function listPerfSnapshots(perfSrcDir) {
  if (!fs.existsSync(perfSrcDir)) return [];
  const items = [];
  for (const ent of fs.readdirSync(perfSrcDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const tablePath = path.join(perfSrcDir, ent.name, 'perf-table.html');
    if (!fs.existsSync(tablePath)) continue;
    items.push({ name: ent.name, relDir: `perf/${ent.name}` });
  }
  items.sort((a, b) => b.name.localeCompare(a.name));
  return items;
}

function buildLandingPage(perfSnapshots) {
  const latest = perfSnapshots[0] || null;
  const latestShellHref = latest ? `${latest.relDir}/index.html` : 'perf/index.html';
  const latestLabel = latest ? latest.name : '(none found)';
  const snapshotList = perfSnapshots.length === 0
    ? '<li>No perf snapshots discovered under <code>docs/perf/</code>.</li>'
    : perfSnapshots.map((s) => (
      `<li><a href="${s.relDir}/index.html">${escHtml(s.name)}</a> · `
      + `<a href="${s.relDir}/perf-table.html">raw table</a></li>`
    )).join('\n');
  const body = `
<h1>FHIRsmith IR Engine Docs</h1>
<div class="card">
  <p>This site publishes current IR engine documentation plus a checked-in performance matrix comparing <code>_engine=ir</code> vs <code>_engine=legacy</code> with the same v0 SQLite providers.</p>
</div>
<div class="card">
  <h2>Quick Links</h2>
  <ul>
    <li><a href="${latestShellHref}">Latest Perf Matrix (with site navigation)</a></li>
    <li><a href="perf/index.html">All Perf Snapshots</a></li>
    <li><a href="tools/expand-explorer-lite.html">Expand Explorer (Lite)</a></li>
    <li><a href="ir-compilation-tester.html">IR Compilation + Fuzzing Tester Guide</a></li>
    <li><a href="ir-engine.html">IR Engine Design and Runtime Notes</a></li>
  </ul>
</div>
<div class="card">
  <h2>Published Perf Snapshot</h2>
  <p>Latest run id: <code>${escHtml(latestLabel)}</code>.</p>
  <p>Source files are committed under <code>docs/perf/</code>.</p>
  <ul>
${snapshotList}
  </ul>
</div>
`;
  return pageTemplate({ title: 'FHIRsmith IR Docs', bodyHtml: body });
}

function buildPerfIndexPage(perfSnapshots) {
  const list = perfSnapshots.length === 0
    ? '<li>No snapshots available.</li>'
    : perfSnapshots.map((s) => (
      `<li><a href="${escHtml(s.name)}/index.html">${escHtml(s.name)}</a> · `
      + `<a href="${escHtml(s.name)}/perf-table.html">raw table</a></li>`
    )).join('\n');

  const body = `
<h1>Perf Snapshots</h1>
<div class="card">
  <p>Each snapshot includes an integrated shell view (with top navigation) and raw generated files.</p>
  <ul>
${list}
  </ul>
</div>`;
  return pageTemplate({
    title: 'FHIRsmith IR Perf Snapshots',
    bodyHtml: body,
    baseHref: '../',
  });
}

function buildPerfSnapshotShellPage(snapshotName) {
  const body = `
<section class="card perf-shell-toolbar">
  <h1>Perf Snapshot: ${escHtml(snapshotName)}</h1>
  <p>
    View mode keeps the common docs nav visible while browsing the matrix and execution details.
    Raw files remain available for direct download.
  </p>
  <p>
    <a href="index.html?view=perf-table.html">Matrix View</a> ·
    <a href="perf-table.html" target="_blank" rel="noopener">Open Raw Table</a>
  </p>
  <p>
    Current view: <code id="viewLabel">perf-table.html</code>
  </p>
</section>
<iframe id="perfFrame" title="Performance Snapshot Viewer"></iframe>
<script>
(() => {
  const frame = document.getElementById('perfFrame');
  const label = document.getElementById('viewLabel');
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('view') || 'perf-table.html';

  function sanitize(view) {
    const v = String(view || '').trim();
    if (!v || v.includes('..') || v.startsWith('/') || v.includes('\\\\')) return 'perf-table.html';
    if (v === 'perf-table.html') return v;
    if (v.startsWith('perf-table.details/') && v.endsWith('.html')) return v;
    return 'perf-table.html';
  }

  const view = sanitize(requested);
  label.textContent = view;
  frame.src = view;

  function rewriteEmbeddedLinks() {
    const doc = frame.contentDocument;
    if (!doc) return;
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('perf-table.details/') && href.endsWith('.html')) {
        a.setAttribute('href', 'index.html?view=' + encodeURIComponent(href));
        a.setAttribute('target', '_top');
        a.removeAttribute('rel');
      } else if (href === 'perf-table.html' || href === '../perf-table.html') {
        a.setAttribute('href', 'index.html?view=perf-table.html');
        a.setAttribute('target', '_top');
        a.removeAttribute('rel');
      }
    }
  }

  frame.addEventListener('load', rewriteEmbeddedLinks);
})();
</script>
`;

  return pageTemplate({
    title: `Perf Snapshot ${snapshotName}`,
    bodyHtml: body,
    baseHref: '../../',
    mainClass: 'perf-shell-main',
    extraStyles: `
    .perf-shell-main { max-width: none; margin: 0; padding: 12px; height: calc(100vh - 64px); box-sizing: border-box; }
    .perf-shell-toolbar { margin: 0 0 10px 0; }
    #perfFrame { width: 100%; height: calc(100% - 180px); min-height: 70vh; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; }
    `,
  });
}

function main() {
  const args = parseArgs(process.argv);
  const outDir = args.out;
  const perfSrcDir = path.join(ROOT, 'docs', 'perf');
  const toolsSrcDir = path.join(ROOT, 'docs', 'tools');
  const docsPages = [
    { src: path.join(ROOT, 'docs', 'ir-engine.md'), out: 'ir-engine.html', title: 'IR Engine' },
    { src: path.join(ROOT, 'docs', 'ir-fuzzing.md'), out: 'ir-fuzzing.html', title: 'IR Fuzzing' },
    { src: path.join(ROOT, 'docs', 'ir-compilation-tester.md'), out: 'ir-compilation-tester.html', title: 'IR Compilation Tester' },
  ];

  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');

  const perfSnapshots = listPerfSnapshots(perfSrcDir);
  fs.writeFileSync(path.join(outDir, 'index.html'), buildLandingPage(perfSnapshots));

  for (const page of docsPages) {
    const md = fs.readFileSync(page.src, 'utf8');
    const html = pageTemplate({ title: page.title, bodyHtml: markdownToHtml(md) });
    fs.writeFileSync(path.join(outDir, page.out), html);
  }

  copyDir(perfSrcDir, path.join(outDir, 'perf'));
  copyDir(toolsSrcDir, path.join(outDir, 'tools'));

  const perfOutDir = path.join(outDir, 'perf');
  ensureDir(perfOutDir);
  fs.writeFileSync(path.join(perfOutDir, 'index.html'), buildPerfIndexPage(perfSnapshots));

  for (const snap of perfSnapshots) {
    const snapOut = path.join(perfOutDir, snap.name);
    ensureDir(snapOut);
    fs.writeFileSync(path.join(snapOut, 'index.html'), buildPerfSnapshotShellPage(snap.name));
  }

  console.log(`Docs site built at ${outDir}`);
}

main();
