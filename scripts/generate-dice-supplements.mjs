#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { Command } from 'commander';

const require = createRequire(import.meta.url);
const {
  buildDiceSupplementBundle,
  readSqliteV0BaseInfo,
} = require('../tx/supplements/synthetic');
const { writeSupplementSidecar } = require('../tx/supplements/sqlite-sidecar');

const program = new Command();

program
  .requiredOption('--db <path>', 'base sqlite-v0 database path')
  .requiredOption('--out-dir <path>', 'directory to write supplement resources into')
  .option('--dice <list>', 'comma-separated die specs', 'd20')
  .option('--formats <list>', 'comma-separated output formats: json,sqlite', 'json')
  .option('--url-root <url>', 'canonical root for generated supplements', 'http://example.org/fhir/CodeSystem/synthetic-dice-supplement')
  .option('--version <version>', 'supplement version', '1')
  .option('--language <code>', 'supplement language', 'en')
  .option('--salt <value>', 'deterministic salt for hash assignments', '')
  .option('--limit <n>', 'optional concept limit', value => Number.parseInt(value, 10))
  .parse(process.argv);

const opts = program.opts();
const outDir = path.resolve(opts.outDir);
fs.mkdirSync(outDir, { recursive: true });

const base = readSqliteV0BaseInfo(path.resolve(opts.db), {
  limit: Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : null,
});
const dice = String(opts.dice || 'd20')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);
const formats = new Set(
  String(opts.formats || 'json')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean)
);

const bundle = buildDiceSupplementBundle(base, {
  dice,
  urlRoot: opts.urlRoot,
  version: opts.version,
  language: opts.language,
  salt: opts.salt,
});

const manifest = {
  base: {
    system: base.system,
    version: base.version,
    name: base.name,
    releaseDate: base.releaseDate,
    conceptCount: base.codes.length,
  },
  supplements: [],
};

for (const item of bundle) {
  const entry = {
    die: item.die,
    url: item.resource.url,
    version: item.resource.version,
    summary: item.summary,
  };
  if (formats.has('json')) {
    const filename = `${item.die}.json`;
    const target = path.join(outDir, filename);
    fs.writeFileSync(target, JSON.stringify(item.resource, null, 2) + '\n', 'utf8');
    entry.jsonFile = filename;
  }
  if (formats.has('sqlite')) {
    const filename = `${item.die}.supp.db`;
    const target = path.join(outDir, filename);
    writeSupplementSidecar(target, item.resource);
    entry.sqliteFile = filename;
  }
  manifest.supplements.push(entry);
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

process.stdout.write(`${JSON.stringify({
  outDir,
  base: manifest.base,
  supplements: manifest.supplements.map(s => ({
    die: s.die,
    jsonFile: s.jsonFile || null,
    sqliteFile: s.sqliteFile || null,
    concepts: s.summary.concepts,
  })),
}, null, 2)}\n`);
