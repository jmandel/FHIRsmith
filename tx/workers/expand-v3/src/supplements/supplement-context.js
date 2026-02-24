'use strict';

/**
 * SupplementContext is the primary v3 supplement interface.
 *
 * Design intent:
 * - Keep supplement handling request-scoped and backend-agnostic.
 * - Provide one API for both correctness (fallback predicate checks) and
 *   performance (native/pushdown and batched decoration).
 * - Let providers pull native handles when available, while allowing the
 *   engine to enforce semantics without provider-native support.
 *
 * Contract shape:
 * - preparePredicate({system, version, clause}) -> {batchHas(codes[]), close?} | null
 * - decorateMany({system, version, codes[], opts}) -> Map<code, DecorationOverlayRow>
 * - native({providerId, system, version}) -> provider-specific handle | null
 *
 * DecorationOverlayRow:
 * {
 *   code: string,
 *   display?: string,
 *   definition?: string,
 *   designations?: Array<object>,
 *   properties?: Array<object>
 * }
 */
class SupplementContext {
  constructor() {
    this._resolved = new Set();
    this._used = new Set();
  }

  canonicals() {
    return [];
  }

  markResolved(url) {
    if (url) this._resolved.add(String(url));
  }

  markUsed(url, _why = 'unknown') {
    if (url) this._used.add(String(url));
  }

  resolvedCanonicals() {
    return [...this._resolved];
  }

  usedCanonicals() {
    return [...this._used];
  }

  async preparePredicate(_request) {
    return null;
  }

  /**
   * Optional batched decoration overlay.
   *
   * Request shape:
   * {
   *   system: string,
   *   version?: string|null,
   *   codes: string[],
   *   opts?: {
   *     includeDesignations?: boolean,
   *     properties?: string[]
   *   }
   * }
   *
   * Returns a Map keyed by code. Missing codes imply no overlay.
   */
  async decorateMany(_request) {
    return new Map();
  }

  /**
   * Optional provider-native handle.
   * Used by providers that can natively consume supplement backends.
   */
  native(_request) {
    return null;
  }

  async close() {
    // no-op
  }
}

class EmptySupplementContext extends SupplementContext {
}

module.exports = {
  SupplementContext,
  EmptySupplementContext,
};
