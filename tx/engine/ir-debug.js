'use strict';

const { canonicalizeIR, canonicalIRHash } = require('./rewrite');

function formatSelectorText(sel) {
  const system = sel.system || '?';
  const version = sel.version ? `|${sel.version}` : '';
  const locked = (!sel.version && sel.lockedDate) ? `@${sel.lockedDate}` : '';
  if (sel.shape === 'whole' || sel.shape === 'all') return `selector whole ${system}${version}${locked}`;
  if (sel.shape === 'concept') {
    const codes = (sel.conceptCodes || []).map(c => c?.code).filter(Boolean);
    const head = codes.slice(0, 5).join(', ');
    const more = codes.length > 5 ? ` ...(+${codes.length - 5})` : '';
    return `selector concept ${system}${version}${locked} [${codes.length}] ${head}${more}`.trim();
  }
  if (sel.shape === 'filter') {
    const clauses = (sel.filterClauses || []).map(f => `${f.property} ${f.op} ${f.value}`).join(' ; ');
    return `selector filter ${system}${version}${locked} ${clauses}`.trim();
  }
  return `selector ${sel.shape || '?'} ${system}${version}${locked}`;
}

function renderIRNodeLines(node, depth = 0, out = []) {
  const pad = '  '.repeat(depth);
  const id = node?.nodeId ? ` [${node.nodeId}]` : '';
  if (!node) {
    out.push(`${pad}(null)`);
    return out;
  }
  switch (node.kind) {
  case 'empty':
    out.push(`${pad}empty${id}`);
    return out;
  case 'selector':
    out.push(`${pad}${formatSelectorText(node)}${id}`);
    return out;
  case 'import': {
    const version = node.version ? `|${node.version}` : '';
    out.push(`${pad}import ${node.url || '?'}${version}${id}`);
    if (node.resolved) renderIRNodeLines(node.resolved, depth + 1, out);
    return out;
  }
  case 'union':
  case 'intersect': {
    const items = node.items || [];
    out.push(`${pad}${node.kind} [${items.length}]${id}`);
    for (const item of items) renderIRNodeLines(item, depth + 1, out);
    return out;
  }
  case 'diff':
    out.push(`${pad}diff${id}`);
    renderIRNodeLines(node.left, depth + 1, out);
    renderIRNodeLines(node.right, depth + 1, out);
    return out;
  default:
    out.push(`${pad}${node.kind || 'unknown'}${id}`);
    return out;
  }
}

function renderCanonicalIRText(expr, opts = {}) {
  const canonical = canonicalizeIR(expr, {
    optimizeExpr: opts.optimizeExpr !== false,
    assignNodeIds: opts.assignNodeIds !== false,
  });
  const lines = [];
  if (opts.includeHash !== false) {
    lines.push(`canonical-ir-hash: ${canonicalIRHash(canonical, { optimizeExpr: false })}`);
  }
  lines.push(opts.heading || 'canonical-ir:');
  renderIRNodeLines(canonical, 1, lines);
  return lines.join('\n');
}

function renderIRPlanText(root, systemsMap, runtime = {}) {
  const canonicalRoot = canonicalizeIR(root, { optimizeExpr: false, assignNodeIds: true });
  const systems = [...(systemsMap?.entries?.() || [])]
    .map(([, s]) => `${s.system}${s.version ? `|${s.version}` : ''}`)
    .sort();
  const lines = [];
  lines.push(`systems: ${systems.length > 0 ? systems.join(', ') : '(none)'}`);
  lines.push(`canonical-ir-hash: ${canonicalIRHash(canonicalRoot, { optimizeExpr: false })}`);
  lines.push('runtime-constraints:');
  const runtimeLines = [];
  if (runtime?.text) runtimeLines.push(`text-filter: ${JSON.stringify(runtime.text)}`);
  if (runtime?.activeOnly) runtimeLines.push('active-only: true');
  if (Number.isInteger(runtime?.offset) || Number.isInteger(runtime?.count)) {
    const off = Number.isInteger(runtime?.offset) ? runtime.offset : 0;
    const cnt = Number.isInteger(runtime?.count) ? runtime.count : -1;
    runtimeLines.push(`pagination: offset=${off} count=${cnt}`);
  }
  if (runtime?.count === 0) runtimeLines.push('total-only: true');
  if (runtimeLines.length === 0) runtimeLines.push('(none)');
  for (const line of runtimeLines) lines.push(`  ${line}`);
  lines.push('optimized-ir:');
  renderIRNodeLines(canonicalRoot, 1, lines);
  return lines.join('\n');
}

module.exports = {
  formatSelectorText,
  renderIRNodeLines,
  renderCanonicalIRText,
  renderIRPlanText,
};
