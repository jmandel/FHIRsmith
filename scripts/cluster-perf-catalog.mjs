#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function usage() {
  console.error('Usage: node scripts/cluster-perf-catalog.mjs <perf-table.catalog.json> [--top N] [--json]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let catalogArg = null;
let topN = 5;
let json = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--json') {
    json = true;
    continue;
  }
  if (arg === '--top') {
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) usage();
    topN = Math.max(1, Number.parseInt(next, 10) || 5);
    i++;
    continue;
  }
  if (arg.startsWith('--top=')) {
    topN = Math.max(1, Number.parseInt(arg.slice('--top='.length), 10) || 5);
    continue;
  }
  if (!catalogArg) {
    catalogArg = arg;
    continue;
  }
  usage();
}

if (!catalogArg) usage();

const catalogPath = resolve(catalogArg);
if (!existsSync(catalogPath)) {
  throw new Error(`Catalog not found: ${catalogPath}`);
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const rows = Array.isArray(catalog.rows) ? catalog.rows : [];
const catalogDir = dirname(catalogPath);

const analyzedRows = rows.map((row) => analyzeRow(row, catalogDir));
const clusters = clusterRows(analyzedRows, topN);

if (json) {
  process.stdout.write(JSON.stringify({
    catalogPath,
    rowCount: analyzedRows.length,
    clusters,
  }, null, 2));
  process.stdout.write('\n');
  process.exit(0);
}

console.log(`Catalog: ${catalogPath}`);
console.log(`Rows: ${analyzedRows.length}`);
for (const cluster of clusters) {
  console.log('');
  console.log(`${cluster.key}`);
  console.log(`  rows=${cluster.rowCount} maxIR=${fmtMs(cluster.maxIrMs)} medianIR=${fmtMs(cluster.medianIrMs)} bestGap=${fmtRatio(cluster.maxGapVsBestBaseline)} comparable=${cluster.comparableCount}`);
  console.log(`  tags=${cluster.tags.join(', ') || 'none'}`);
  if (cluster.notes.length > 0) {
    console.log(`  notes=${cluster.notes.join(' | ')}`);
  }
  for (const sample of cluster.examples) {
    console.log(`  - #${sample.id} ${sample.name}`);
    console.log(`    IR=${fmtMs(sample.irMs)} upstream=${fmtMaybeMs(sample.upstreamMs, sample.upstreamErr)} third=${fmtMaybeMs(sample.thirdMs, sample.thirdErr)} best=${fmtMaybeMs(sample.bestBaselineMs, null)} gap=${fmtRatio(sample.gapVsBestBaseline)}`);
  }
}

function analyzeRow(row, baseDir) {
  const input = loadInputPayload(row, baseDir);
  const source = input?.source || {};
  const valueSet = source.valueSet || null;
  const options = source.options || {};
  const compose = valueSet?.compose || {};
  const includeEntries = Array.isArray(compose.include) ? compose.include : [];
  const excludeEntries = Array.isArray(compose.exclude) ? compose.exclude : [];
  const allEntries = [...includeEntries, ...excludeEntries];
  const systems = new Set();
  const operators = [];
  let importCount = 0;
  let explicitConcepts = 0;
  let hierarchy = false;
  let codeRegex = false;
  let propertyFilter = false;
  let propertyRegex = false;
  let refsetMembership = false;

  for (const entry of allEntries) {
    if (entry?.system) systems.add(String(entry.system));
    if (Array.isArray(entry?.valueSet)) importCount += entry.valueSet.length;
    if (Array.isArray(entry?.concept)) explicitConcepts += entry.concept.length;
    for (const filter of Array.isArray(entry?.filter) ? entry.filter : []) {
      const property = String(filter?.property || '');
      const op = String(filter?.op || '');
      operators.push(property && op ? `${property}:${op}` : `${property}${op}`);
      if (property === 'concept' && (op === 'is-a' || op === 'descendent-of')) hierarchy = true;
      if (property === 'concept' && op === 'in') refsetMembership = true;
      if (property === 'code' && op === 'regex') codeRegex = true;
      if (property !== 'concept' && property !== 'code') {
        propertyFilter = true;
        if (op === 'regex') propertyRegex = true;
      }
    }
  }

  const tags = [];
  if (hierarchy) tags.push('hierarchy');
  if (refsetMembership) tags.push('refset');
  if (propertyFilter) tags.push('property-filter');
  if (propertyRegex) tags.push('property-regex');
  if (codeRegex) tags.push('code-regex');
  if (importCount > 0) tags.push('import');
  if (excludeEntries.length > 0) tags.push('exclude');
  if (systems.size > 1) tags.push('multi-system');
  if (explicitConcepts > 0) tags.push('enumerated');
  if (typeof options.filter === 'string' && options.filter.trim()) tags.push('runtime-text');
  if (options.activeOnly) tags.push('activeOnly');
  if (options.count === 0) tags.push('count-only');
  if (Number.isInteger(options.offset) && options.offset > 0) tags.push('offset');
  if (Number.isInteger(options.offset) && options.offset >= 1000) tags.push('deep-offset');
  if (options.includeDesignations) tags.push('designations');
  if (hasParam(options, 'displayLanguage')) tags.push('displayLanguage');
  if (hasParam(options, 'designation')) tags.push('designation-filter');

  const feature = classifyPrimaryCluster({
    systems: systems.size,
    hierarchy,
    refsetMembership,
    propertyFilter,
    propertyRegex,
    codeRegex,
    importCount,
    excludeCount: excludeEntries.length,
    filterText: typeof options.filter === 'string' && options.filter.trim() !== '',
    countOnly: options.count === 0,
    offset: Number.isInteger(options.offset) ? options.offset : 0,
    includeDesignations: !!options.includeDesignations,
    displayLanguage: hasParam(options, 'displayLanguage'),
  });

  const bestBaselineMs = minNumber(row.upstreamMs, row.thirdMs);
  const gapVsBestBaseline = Number.isFinite(bestBaselineMs) && Number.isFinite(row.irMs) && bestBaselineMs > 0
    ? row.irMs / bestBaselineMs
    : null;

  return {
    id: row.id,
    name: row.name,
    category: row.category,
    irMs: finiteOrNull(row.irMs),
    upstreamMs: finiteOrNull(row.upstreamMs),
    thirdMs: finiteOrNull(row.thirdMs),
    upstreamErr: row.upstreamErr || null,
    thirdErr: row.thirdErr || null,
    bestBaselineMs,
    gapVsBestBaseline,
    operators: [...new Set(operators)].sort(),
    tags: [...new Set(tags)].sort(),
    primaryCluster: feature.key,
    clusterNotes: feature.notes,
  };
}

function loadInputPayload(row, baseDir) {
  const rel = typeof row?.inputHref === 'string' && row.inputHref ? row.inputHref : null;
  if (!rel) return null;
  const abs = join(baseDir, rel);
  if (!existsSync(abs)) return null;
  return JSON.parse(readFileSync(abs, 'utf8'));
}

function hasParam(options, name) {
  const params = Array.isArray(options?.params) ? options.params : [];
  return params.some((param) => String(param?.name || '') === String(name));
}

function classifyPrimaryCluster(features) {
  if (features.includeDesignations || features.displayLanguage) {
    return {
      key: 'designation-decoration',
      notes: ['Decoration throughput or designation filtering dominates these cases.'],
    };
  }
  if (features.countOnly) {
    if (features.hierarchy) {
      return {
        key: 'count-only hierarchy',
        notes: ['Count path over large hierarchy membership is the main cost.'],
      };
    }
    if (features.propertyFilter) {
      return {
        key: 'count-only property-filter',
        notes: ['Count path over filtered literal/link rows is the main cost.'],
      };
    }
    return {
      key: 'count-only',
      notes: ['Count-only requests isolate total computation from row materialization.'],
    };
  }
  if (features.importCount > 0) {
    if (features.filterText) {
      return {
        key: 'import + runtime-text',
        notes: ['Imported set algebra plus runtime text can magnify pagination costs.'],
      };
    }
    if (features.excludeCount > 0) {
      return {
        key: 'import + exclusion',
        notes: ['Imported include/exclude composition stresses set algebra more than scanning.'],
      };
    }
    return {
      key: 'import-composition',
      notes: ['Imported ValueSet composition dominates these cases.'],
    };
  }
  if (features.systems > 1) {
    return {
      key: 'multi-system pagination',
      notes: ['Cross-system merge and stride pagination dominate these cases.'],
    };
  }
  if (features.codeRegex) {
    return {
      key: 'code-regex',
      notes: ['Regex predicates often defeat ordinary index paths.'],
    };
  }
  if (features.propertyRegex) {
    return {
      key: features.offset >= 1000 ? 'property-regex + deep-pagination' : 'property-regex',
      notes: ['Regex over concept_literal rows tends to be scan-heavy.'],
    };
  }
  if (features.hierarchy && features.filterText) {
    return {
      key: 'hierarchy + runtime-text',
      notes: ['These cases benefit when text filtering is applied after hierarchy membership is resolved.'],
    };
  }
  if (features.hierarchy && features.excludeCount > 0) {
    return {
      key: 'hierarchy + exclusion',
      notes: ['Large subtree algebra is the main work here.'],
    };
  }
  if (features.hierarchy) {
    return {
      key: 'hierarchy membership',
      notes: ['Hierarchy expansion plus paging/counting is the main work here.'],
    };
  }
  if (features.propertyFilter && features.filterText) {
    return {
      key: 'property-filter + runtime-text',
      notes: ['Property row selection followed by text filtering can trigger double work.'],
    };
  }
  if (features.propertyFilter && features.offset >= 1000) {
    return {
      key: 'property-filter + deep-pagination',
      notes: ['Property-filtered sets with high offsets often pay both count and page scan costs.'],
    };
  }
  if (features.propertyFilter) {
    return {
      key: 'property-filter',
      notes: ['Literal/link property membership and total computation dominate these cases.'],
    };
  }
  if (features.refsetMembership) {
    return {
      key: 'refset-membership',
      notes: ['Reference set membership drives these cases.'],
    };
  }
  if (features.filterText) {
    return {
      key: 'runtime-text',
      notes: ['Runtime text search dominates these cases.'],
    };
  }
  if (features.excludeCount > 0) {
    return {
      key: 'exclusion',
      notes: ['Set-difference work dominates these cases.'],
    };
  }
  if (features.offset >= 1000) {
    return {
      key: 'deep-pagination',
      notes: ['High offset pagination dominates these cases.'],
    };
  }
  return {
    key: 'other',
    notes: ['No stronger query-shape cluster matched.'],
  };
}

function clusterRows(rowsToCluster, top) {
  const byKey = new Map();
  for (const row of rowsToCluster) {
    const existing = byKey.get(row.primaryCluster) || {
      key: row.primaryCluster,
      rows: [],
      tags: new Set(),
      notes: new Set(),
    };
    existing.rows.push(row);
    for (const tag of row.tags) existing.tags.add(tag);
    for (const note of row.clusterNotes) existing.notes.add(note);
    byKey.set(row.primaryCluster, existing);
  }

  return [...byKey.values()]
    .map((cluster) => summarizeCluster(cluster, top))
    .sort((a, b) => {
      if (b.maxIrMs !== a.maxIrMs) return b.maxIrMs - a.maxIrMs;
      if (b.maxGapVsBestBaseline !== a.maxGapVsBestBaseline) return b.maxGapVsBestBaseline - a.maxGapVsBestBaseline;
      return a.key.localeCompare(b.key);
    });
}

function summarizeCluster(cluster, top) {
  const irValues = cluster.rows.map((row) => row.irMs).filter(Number.isFinite).sort((a, b) => a - b);
  const comparable = cluster.rows.filter((row) => Number.isFinite(row.bestBaselineMs));
  const examples = [...cluster.rows]
    .sort((a, b) => {
      const aScore = scoreRow(a);
      const bScore = scoreRow(b);
      if (bScore !== aScore) return bScore - aScore;
      return (b.irMs || 0) - (a.irMs || 0);
    })
    .slice(0, top)
    .map((row) => ({
      id: row.id,
      name: row.name,
      irMs: row.irMs,
      upstreamMs: row.upstreamMs,
      thirdMs: row.thirdMs,
      upstreamErr: row.upstreamErr,
      thirdErr: row.thirdErr,
      bestBaselineMs: row.bestBaselineMs,
      gapVsBestBaseline: row.gapVsBestBaseline,
    }));

  return {
    key: cluster.key,
    rowCount: cluster.rows.length,
    comparableCount: comparable.length,
    maxIrMs: maxNumber(cluster.rows.map((row) => row.irMs)),
    medianIrMs: median(irValues),
    maxGapVsBestBaseline: maxNumber(comparable.map((row) => row.gapVsBestBaseline)),
    tags: [...cluster.tags].sort(),
    notes: [...cluster.notes],
    examples,
  };
}

function scoreRow(row) {
  const ir = row.irMs || 0;
  const gap = row.gapVsBestBaseline && Number.isFinite(row.gapVsBestBaseline) && row.gapVsBestBaseline > 1
    ? row.gapVsBestBaseline
    : 1;
  return ir * gap;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[mid];
  return (values[mid - 1] + values[mid]) / 2;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function minNumber(...values) {
  const nums = values.filter(Number.isFinite);
  return nums.length > 0 ? Math.min(...nums) : null;
}

function maxNumber(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length > 0 ? Math.max(...nums) : null;
}

function fmtMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : 'n/a';
}

function fmtMaybeMs(value, err) {
  if (Number.isFinite(value)) return `${Math.round(value)}ms`;
  if (err) return 'ERR';
  return 'n/a';
}

function fmtRatio(value) {
  return Number.isFinite(value) ? `x${value.toFixed(1)}` : 'n/a';
}
