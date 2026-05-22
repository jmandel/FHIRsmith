#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import yaml from 'yaml';

const require = createRequire(import.meta.url);
const { buildTempV0DbFile, makeBaseConcepts } = require('../tests/support/sqlite-v0-supplement-fixtures');
const { writeSupplementSidecar } = require('../tx/supplements/sqlite-sidecar');

const argv = process.argv.slice(2);
let baseLibrary = path.resolve('tests/tx/fixtures/v0-test-library.yaml');
let outDir = null;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--base-library') {
    baseLibrary = path.resolve(argv[++i]);
    continue;
  }
  if (arg === '--out-dir') {
    outDir = path.resolve(argv[++i]);
    continue;
  }
}

if (!outDir) {
  console.error('Missing --out-dir');
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

const system = 'http://example.org/op-harness-base';
const version = '1';
const supplementUrl = 'http://example.org/fhir/CodeSystem/op-harness-d20';
const supplementUrlD8 = 'http://example.org/fhir/CodeSystem/op-harness-d8';
const baseConcepts = makeBaseConcepts(40).map((concept) => ({
  ...concept,
  display: concept.code === 'C0001' ? 'Critical Concept' : (concept.code === 'C0002' ? 'Minor Concept' : concept.display),
}));

const built = buildTempV0DbFile(baseConcepts, { dir: outDir, system, version });
const supplementPath = path.join(outDir, 'op-harness-d20.supp.db');
const supplementPathD8 = path.join(outDir, 'op-harness-d8.supp.db');

const supplement = {
  resourceType: 'CodeSystem',
  url: supplementUrl,
  version,
  status: 'active',
  content: 'supplement',
  supplements: `${system}|${version}`,
  property: [
    { code: 'd20-roll', type: 'integer' },
  ],
  concept: [
    {
      code: 'C0001',
      designation: [
        {
          language: 'de',
          use: {
            system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
            code: 'preferredForLanguage',
          },
          value: 'Kritischer Treffer',
        },
      ],
      property: [
        { code: 'd20-roll', valueInteger: 20 },
      ],
    },
    {
      code: 'C0002',
      property: [
        { code: 'd20-roll', valueInteger: 1 },
      ],
    },
  ],
};

writeSupplementSidecar(supplementPath, supplement);
writeSupplementSidecar(supplementPathD8, {
  resourceType: 'CodeSystem',
  url: supplementUrlD8,
  version,
  status: 'active',
  content: 'supplement',
  supplements: `${system}|${version}`,
  property: [
    { code: 'd8-roll', type: 'integer' },
  ],
  concept: [
    {
      code: 'C0001',
      property: [
        { code: 'd8-roll', valueInteger: 2 },
      ],
    },
    {
      code: 'C0002',
      property: [
        { code: 'd8-roll', valueInteger: 7 },
      ],
    },
  ],
});

const baseConfig = yaml.parse(fs.readFileSync(baseLibrary, 'utf8'));
const sources = Array.isArray(baseConfig.sources) ? [...baseConfig.sources] : [];
sources.push({
  source: `sqlite-v0:${built.dbPath}`,
  options: {
    supplements: [supplementPath],
  },
});
sources[sources.length - 1].options.supplements.push(supplementPathD8);

const config = {
  ...baseConfig,
  sources,
};

const outPath = path.join(outDir, 'library.yaml');
fs.writeFileSync(outPath, yaml.stringify(config), 'utf8');
process.stdout.write(`${outPath}\n`);
