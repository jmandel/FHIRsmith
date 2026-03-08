'use strict';

function irChildren(node) {
  if (!node || typeof node !== 'object') return [];
  switch (node.kind) {
  case 'union':
  case 'intersect':
    return (node.items || []).filter(Boolean);
  case 'diff':
    return [node.left, node.right].filter(Boolean);
  case 'import':
    return node.resolved ? [node.resolved] : [];
  default:
    return [];
  }
}

function walkIR(node, visit, ctx = {}) {
  if (!node || typeof node !== 'object') return;
  visit(node, ctx);
  for (const child of irChildren(node)) {
    walkIR(child, visit, ctx);
  }
}

function mapIR(node, mapFn, ctx = {}) {
  if (!node || typeof node !== 'object') return node;
  const mapped = rebuildNode(node, child => mapIR(child, mapFn, ctx));
  return mapFn(mapped, ctx);
}

async function mapIRAsync(node, mapFn, ctx = {}) {
  if (!node || typeof node !== 'object') return node;
  const mapped = await rebuildNodeAsync(node, child => mapIRAsync(child, mapFn, ctx));
  return await mapFn(mapped, ctx);
}

function rebuildNode(node, mapChild) {
  switch (node.kind) {
  case 'union':
  case 'intersect':
    return { ...node, items: (node.items || []).map(mapChild) };
  case 'diff':
    return { ...node, left: mapChild(node.left), right: mapChild(node.right) };
  case 'import':
    return node.resolved ? { ...node, resolved: mapChild(node.resolved) } : node;
  default:
    return node;
  }
}

async function rebuildNodeAsync(node, mapChild) {
  switch (node.kind) {
  case 'union':
  case 'intersect':
    return { ...node, items: await Promise.all((node.items || []).map(mapChild)) };
  case 'diff':
    return { ...node, left: await mapChild(node.left), right: await mapChild(node.right) };
  case 'import':
    return node.resolved ? { ...node, resolved: await mapChild(node.resolved) } : node;
  default:
    return node;
  }
}

module.exports = {
  irChildren,
  walkIR,
  mapIR,
  mapIRAsync,
};
