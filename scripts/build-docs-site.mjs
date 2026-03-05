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

function pageTemplate({ title, bodyHtml }) {
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
  </style>
</head>
<body>
  <nav>
    <div class="inner">
      <strong>FHIRsmith IR Docs</strong>
      <a href="index.html">Landing</a>
      <a href="ir-engine.html">IR Engine</a>
      <a href="ir-fuzzing.html">Fuzzing</a>
      <a href="ir-compilation-tester.html">Compilation Tester</a>
      <a href="tools/expand-explorer-lite.html">Explorer Lite</a>
      <a href="perf/v0-sqlite-20260304/perf-table.html">Perf Matrix</a>
    </div>
  </nav>
  <main>
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

function buildLandingPage() {
  const body = `
<h1>FHIRsmith IR Engine Docs</h1>
<div class="card">
  <p>This site publishes current IR engine documentation plus a checked-in performance matrix comparing <code>_engine=ir</code> vs <code>_engine=legacy</code> with the same v0 SQLite providers.</p>
</div>
<div class="card">
  <h2>Quick Links</h2>
  <ul>
    <li><a href="perf/v0-sqlite-20260304/perf-table.html">IR vs Legacy v0 Perf Matrix</a></li>
    <li><a href="tools/expand-explorer-lite.html">Expand Explorer (Lite)</a></li>
    <li><a href="ir-compilation-tester.html">IR Compilation Tester Guide</a></li>
    <li><a href="ir-fuzzing.html">IR Fuzzing + Direct Oracle Guide</a></li>
    <li><a href="ir-engine.html">IR Engine Design and Runtime Notes</a></li>
  </ul>
</div>
<div class="card">
  <h2>Published Perf Snapshot</h2>
  <p>Run id: <code>20260304-v0-perf</code> (full IR harness perf matrix, median of 3 runs each).</p>
  <p>Source files are committed under <code>docs/perf/v0-sqlite-20260304/</code>.</p>
</div>
`;
  return pageTemplate({ title: 'FHIRsmith IR Docs', bodyHtml: body });
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

  fs.writeFileSync(path.join(outDir, 'index.html'), buildLandingPage());

  for (const page of docsPages) {
    const md = fs.readFileSync(page.src, 'utf8');
    const html = pageTemplate({ title: page.title, bodyHtml: markdownToHtml(md) });
    fs.writeFileSync(path.join(outDir, page.out), html);
  }

  copyDir(perfSrcDir, path.join(outDir, 'perf'));
  copyDir(toolsSrcDir, path.join(outDir, 'tools'));

  console.log(`Docs site built at ${outDir}`);
}

main();
