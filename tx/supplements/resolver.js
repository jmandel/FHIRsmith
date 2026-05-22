'use strict';

const { VersionUtilities } = require('../../library/version-utilities');
const { Issue } = require('../library/operation-outcome');
const {
  dedupeSupplementRefs,
  descriptorKey,
  makeBaseScope,
  supplementRefKey,
  targetMatchesDescriptor,
} = require('./types');
const { findCandidates } = require('./registry');

function compareCandidateVersions(left, right) {
  const leftVersion = String(left?.descriptor?.version || '').trim();
  const rightVersion = String(right?.descriptor?.version || '').trim();
  if (!leftVersion && !rightVersion) return 0;
  if (!leftVersion) return -1;
  if (!rightVersion) return 1;
  if (leftVersion === rightVersion) return 0;

  const algorithm = left?.descriptor?.versionAlgorithm
    || right?.descriptor?.versionAlgorithm
    || VersionUtilities.guessVersionFormat(leftVersion)
    || VersionUtilities.guessVersionFormat(rightVersion);

  if (algorithm === 'semver'
    && VersionUtilities.isSemVer(leftVersion)
    && VersionUtilities.isSemVer(rightVersion)) {
    return VersionUtilities.compareVersions(leftVersion, rightVersion);
  }

  if (algorithm === 'integer'
    || (/^\d+$/.test(leftVersion) && /^\d+$/.test(rightVersion))) {
    return Math.sign(parseInt(leftVersion, 10) - parseInt(rightVersion, 10));
  }

  if (algorithm === 'date') {
    return leftVersion.replace(/[^0-9]/g, '').localeCompare(rightVersion.replace(/[^0-9]/g, ''));
  }

  return leftVersion.localeCompare(rightVersion);
}

function chooseCandidate(target, ref, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const minPrecedence = Math.min(...candidates.map(c => Number(c.precedence) || 0));
  const scoped = candidates.filter(c => (Number(c.precedence) || 0) === minPrecedence);
  if (scoped.length === 1) return scoped[0];

  if (!ref?.version && scoped.every(candidate => candidate?.descriptor?.sourceKind !== 'inline')) {
    const ranked = [...scoped].sort((left, right) => {
      const versionCmp = compareCandidateVersions(right, left);
      if (versionCmp !== 0) return versionCmp;
      return String(left?.descriptor?.canonical || '').localeCompare(String(right?.descriptor?.canonical || ''));
    });
    if (ranked.length > 1 && compareCandidateVersions(ranked[0], ranked[1]) > 0) {
      return ranked[0];
    }
  }

  const labels = scoped.map(c => c.descriptor.canonical).sort();
  throw new Issue(
    'error',
    'invalid',
    null,
    'VALUESET_SUPPLEMENT_AMBIGUOUS',
    `Ambiguous supplement '${ref.canonical}' for ${target.system}${target.version ? `|${target.version}` : ''}: ${labels.join(', ')}`,
    'invalid',
    422
  );
}

async function resolveSupplementsForBaseScope({ target, refs, registry }) {
  if (!registry || !Array.isArray(registry.entries)) {
    throw new Error('resolveSupplementsForBaseScope requires a registry');
  }
  const selected = selectSupplementEntriesForBaseScope({ target, refs, registry });
  const items = [];

  for (const chosen of selected.entries) {
    const item = makeResolvedSupplementItem(chosen, selected.target);
    await item.materializeNativeBindingSource();
    if (chosen?.descriptor?.sourceKind !== 'sqlite-native') {
      await item.materializeOverlaySource();
    }
    items.push(item);
  }

  return {
    target: selected.target,
    items,
    matchedRefKeys: selected.matchedRefKeys,
    unresolvedRefs: selected.unresolvedRefs,
    missingRefs: selected.missingRefs,
    inapplicableRefs: selected.inapplicableRefs,
  };
}

function makeResolvedSupplementItem(chosen, target) {
  return {
    descriptor: chosen.descriptor,
    target,
    requestRef: chosen.requestRef,
    overlaySource: null,
    nativeBindingSource: null,
    _overlayResolved: false,
    _nativeResolved: false,
    async materializeOverlaySource() {
      if (this.overlaySource) return this.overlaySource;
      if (this._overlayResolved) return this.overlaySource;
      this._overlayResolved = true;
      const codeSystem = typeof chosen.materializeCodeSystem === 'function'
        ? await chosen.materializeCodeSystem(target)
        : null;
      this.overlaySource = codeSystem || null;
      return this.overlaySource;
    },
    async materializeNativeBindingSource() {
      if (this._nativeResolved) return this.nativeBindingSource;
      this._nativeResolved = true;
      this.nativeBindingSource = typeof chosen.materializeNativeBinding === 'function'
        ? await chosen.materializeNativeBinding(target)
        : null;
      return this.nativeBindingSource;
    },
  };
}

async function materializeSupplementItemOverlaySource(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.overlaySource) return item.overlaySource;
  if (typeof item.materializeOverlaySource === 'function') {
    return await item.materializeOverlaySource();
  }
  return item.overlaySource || null;
}

async function materializeSupplementSetOverlaySources(supplementSet) {
  for (const item of supplementSet?.items || []) {
    await materializeSupplementItemOverlaySource(item);
  }
  return supplementSet;
}

function selectSupplementEntriesForBaseScope({ target, refs, registry }) {
  if (!registry || !Array.isArray(registry.entries)) {
    throw new Error('selectSupplementEntriesForBaseScope requires a registry');
  }
  const baseScope = makeBaseScope(target?.system, target?.version);
  const orderedRefs = dedupeSupplementRefs(refs || []);
  const entries = [];
  const matchedRefKeys = [];
  const unresolvedRefs = [];
  const missingRefs = [];
  const inapplicableRefs = [];
  const seenDescriptors = new Set();

  for (const ref of orderedRefs) {
    const allCandidates = findCandidates(registry, ref);
    const candidates = allCandidates.filter(entry => targetMatchesDescriptor(baseScope, entry.descriptor));
    if (candidates.length === 0) {
      unresolvedRefs.push(ref);
      if (allCandidates.length === 0) missingRefs.push(ref);
      else inapplicableRefs.push(ref);
      continue;
    }
    const chosen = chooseCandidate(baseScope, ref, candidates);
    matchedRefKeys.push(supplementRefKey(ref));
    const key = descriptorKey(chosen.descriptor);
    if (seenDescriptors.has(key)) continue;
    seenDescriptors.add(key);
    entries.push({ ...chosen, requestRef: ref });
  }

  return {
    target: baseScope,
    entries,
    matchedRefKeys: matchedRefKeys.filter(Boolean),
    unresolvedRefs,
    missingRefs,
    inapplicableRefs,
  };
}

module.exports = {
  materializeSupplementItemOverlaySource,
  materializeSupplementSetOverlaySources,
  resolveSupplementsForBaseScope,
  selectSupplementEntriesForBaseScope,
};
