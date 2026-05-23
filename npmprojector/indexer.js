//
// FHIR Indexer
// Builds in-memory search indexes using FHIRPath expressions
//
// @ts-check

const fhirpath = require('fhirpath');

/** @typedef {{resourceType?: string, id?: string, [key: string]: any}} FhirResource */
/** @typedef {{code: string, expression?: string, base?: string[], type?: string, description?: string, name?: string, [key: string]: any}} SearchParameterLike */

class FHIRIndexer {
  constructor(fhirModel = null) {
    /** @type {Map<string, Map<any, FhirResource>>} */
    this.resources = new Map();      // resourceType -> id -> resource
    /** @type {Map<string, Map<string, Map<any, Set<any>>>>} */
    this.indexes = new Map();        // resourceType -> paramName -> value -> Set<id>
    /** @type {Map<string, Map<string, SearchParameterLike>>} */
    this.searchParams = new Map();   // resourceType -> paramName -> SearchParameter
    /** @type {any} */
    this.fhirModel = fhirModel;      // FHIRPath model for type resolution
  }

  /**
   * Load resources and search parameters, build all indexes
   * @param {FhirResource[]} resources
   * @param {SearchParameterLike[]} searchParameters
   */
  build(resources, searchParameters) {
    this.resources.clear();
    this.indexes.clear();
    this.searchParams.clear();

    // Index search parameters by resource type
    for (const sp of searchParameters) {
      if (!sp.expression) continue;

      const types = sp.base || [];
      for (const type of types) {
        if (!this.searchParams.has(type)) {
          this.searchParams.set(type, new Map());
        }
        this.searchParams.get(type)?.set(sp.code, sp);
      }
    }

    // Store resources and build indexes
    for (const resource of resources) {
      const type = resource.resourceType;
      if (!type) continue;

      // Store the resource
      if (!this.resources.has(type)) {
        this.resources.set(type, new Map());
      }
      this.resources.get(type)?.set(resource.id, resource);

      // Build indexes for this resource
      this.indexResource(resource);
    }

    return this.getStats();
  }

  /**
   * Index a single resource against all applicable search parameters
   * @param {FhirResource} resource
   */
  indexResource(resource) {
    const type = resource.resourceType;
    if (!type) return;

    const params = this.searchParams.get(type);
    if (!params) return;

    if (!this.indexes.has(type)) {
      this.indexes.set(type, new Map());
    }
    const typeIndexes = this.indexes.get(type);
    if (!typeIndexes) return;

    for (const [paramName, searchParam] of params) {
      if (!typeIndexes.has(paramName)) {
        typeIndexes.set(paramName, new Map());
      }
      const paramIndex = typeIndexes.get(paramName);
      if (!paramIndex) continue;

      try {
        const values = /** @type {any[]} */ (fhirpath.evaluate(resource, searchParam.expression || '', /** @type {any} */ (null), this.fhirModel));
        for (const value of values) {
          const normalizedValues = this.normalizeValue(value, searchParam.type);
          for (const normalized of normalizedValues) {
            if (normalized === null || normalized === undefined) continue;

            if (!paramIndex.has(normalized)) {
              paramIndex.set(normalized, new Set());
            }
            paramIndex.get(normalized)?.add(resource.id);
          }
        }
      } catch (err) {
        console.log(err);
        // FHIRPath evaluation failed - skip this param for this resource
        // Logged at debug level to avoid noise
      }
    }
  }

  /**
   * Normalize a value based on search parameter type
   * Returns an array of normalized values (some types produce multiple index entries)
   * @param {any} value
   * @param {string | undefined} paramType
   * @returns {any[]}
   */
  normalizeValue(value, paramType) {
    if (value === null || value === undefined) {
      return [];
    }

    switch (paramType) {
      case 'string':
        return [String(value).toLowerCase()];

      case 'token':
        // Handle CodeableConcept, Coding, Identifier, code, etc.
        if (typeof value === 'string') {
          return [value.toLowerCase()];
        }
        if (value.coding) {
          // CodeableConcept
          return value.coding.map((/** @type {any} */ c) => this.tokenKey(c.system, c.code)).filter(Boolean);
        }
        if (value.system !== undefined || value.code !== undefined || value.value !== undefined) {
          // Coding or Identifier
          return [this.tokenKey(value.system, value.code || value.value)].filter(Boolean);
        }
        return [String(value).toLowerCase()];

      case 'reference':
        // Handle Reference type
        if (typeof value === 'string') {
          return [value];
        }
        if (value.reference) {
          return [value.reference];
        }
        return [];

      case 'date':
        // Store as ISO string prefix for simple matching
        if (typeof value === 'string') {
          return [value];
        }
        if (value instanceof Date) {
          return [value.toISOString()];
        }
        return [];

      case 'quantity':
        // Index the numeric value (simplified - ignores units)
        if (typeof value === 'number') {
          return [value];
        }
        if (value.value !== undefined) {
          return [value.value];
        }
        return [];

      case 'number':
        if (typeof value === 'number') {
          return [value];
        }
        return [parseFloat(value)].filter(v => !isNaN(v));

      case 'uri':
        return [String(value)];

      default:
        return [String(value).toLowerCase()];
    }
  }

  /**
   * Create a token key from system and code
   * @param {any} system
   * @param {any} code
   * @returns {string | null}
   */
  tokenKey(system, code) {
    if (!code && !system) return null;
    if (!system) return `|${code}`.toLowerCase();
    if (!code) return `${system}|`.toLowerCase();
    return `${system}|${code}`.toLowerCase();
  }

  /**
   * Read a single resource by type and id
   * @param {string} resourceType
   * @param {string} id
   * @returns {FhirResource | null}
   */
  read(resourceType, id) {
    const typeResources = this.resources.get(resourceType);
    if (!typeResources) return null;
    return typeResources.get(id) || null;
  }

  /**
   * Search for resources
   * @param {string} resourceType
   * @param {Record<string, any>} queryParams
   * @returns {FhirResource[]}
   */
  search(resourceType, queryParams) {
    const typeResources = this.resources.get(resourceType);
    if (!typeResources) {
      return [];
    }

    const typeIndexes = this.indexes.get(resourceType);
    const typeSearchParams = this.searchParams.get(resourceType);

    // Start with all resource IDs
    /** @type {Set<any> | null} */
    let matchingIds = null;

    for (const [paramName, paramValue] of Object.entries(queryParams)) {
      // Skip special parameters
      if (paramName.startsWith('_')) continue;

      if (!typeSearchParams?.has(paramName) || !typeIndexes?.has(paramName)) {
        // Unknown search parameter - skip or could throw
        continue;
      }

      const searchParam = typeSearchParams.get(paramName);
      const paramIndex = typeIndexes.get(paramName);
      if (!searchParam || !paramIndex) continue;

      // Find matching IDs for this parameter
      const paramMatchingIds = this.searchParam(paramValue, searchParam, paramIndex);

      // Intersect with running result
      if (matchingIds === null) {
        matchingIds = paramMatchingIds;
      } else {
        const intersection = new Set();
        for (const id of matchingIds) {
          if (paramMatchingIds.has(id)) {
            intersection.add(id);
          }
        }
        matchingIds = intersection;
      }

      // Early exit if no matches
      if (matchingIds.size === 0) {
        return [];
      }
    }

    // If no search params provided, return all
    if (matchingIds === null) {
      return Array.from(typeResources.values());
    }

    // Return matching resources
    /** @type {FhirResource[]} */
    const matches = [];
    for (const id of matchingIds) {
      const resource = typeResources.get(id);
      if (resource) {
        matches.push(resource);
      }
    }
    return matches;
  }

  /**
   * Search a single parameter
   * @param {any} queryValue
   * @param {SearchParameterLike} searchParam
   * @param {Map<any, Set<any>>} paramIndex
   * @returns {Set<any>}
   */
  searchParam(queryValue, searchParam, paramIndex) {
    const matchingIds = new Set();
    const paramType = searchParam.type;

    // Handle OR (comma-separated values)
    const values = String(queryValue).split(',');

    for (const value of values) {
      const trimmedValue = value.trim();

      switch (paramType) {
        case 'string': {
          // String search: case-insensitive starts-with by default
          const lowerValue = trimmedValue.toLowerCase();
          for (const [indexedValue, ids] of paramIndex) {
            if (indexedValue.startsWith(lowerValue)) {
              ids.forEach(id => matchingIds.add(id));
            }
          }
          break;
        }

        case 'token': {
          // Token search: exact match on system|code, |code, or code
          const tokenMatches = this.matchToken(trimmedValue, paramIndex);
          tokenMatches.forEach(id => matchingIds.add(id));
          break;
        }

        case 'reference': {
          // Reference search: exact match
          const refIds = paramIndex.get(trimmedValue);
          if (refIds) {
            refIds.forEach(id => matchingIds.add(id));
          }
          break;
        }

        case 'date': {
          // Simple prefix matching for dates (no range support as specified)
          for (const [indexedValue, ids] of paramIndex) {
            if (indexedValue.startsWith(trimmedValue)) {
              ids.forEach(id => matchingIds.add(id));
            }
          }
          break;
        }

        case 'number':
        case 'quantity': {
          // Numeric equality
          const numValue = parseFloat(trimmedValue);
          if (!isNaN(numValue)) {
            const ids = paramIndex.get(numValue);
            if (ids) {
              ids.forEach(id => matchingIds.add(id));
            }
          }
          break;
        }

        case 'uri': {
          // Exact match for URI
          const uriIds = paramIndex.get(trimmedValue);
          if (uriIds) {
            uriIds.forEach(id => matchingIds.add(id));
          }
          break;
        }

        default: {
          // Default: exact match (case-insensitive)
          const defaultIds = paramIndex.get(trimmedValue.toLowerCase());
          if (defaultIds) {
            defaultIds.forEach(id => matchingIds.add(id));
          }
        }
      }
    }

    return matchingIds;
  }

  /**
   * Match a token query against the index
   * Supports: system|code, |code, code, system|
   * @param {string} query
   * @param {Map<string, Set<any>>} paramIndex
   * @returns {Set<any>}
   */
  matchToken(query, paramIndex) {
    const matchingIds = new Set();
    const lowerQuery = query.toLowerCase();

    if (lowerQuery.includes('|')) {
      // Exact system|code match or system| or |code
      const ids = paramIndex.get(lowerQuery);
      if (ids) {
        ids.forEach(id => matchingIds.add(id));
      }
    } else {
      // Code-only search: match any system
      for (const [indexedValue, ids] of paramIndex) {
        const parts = indexedValue.split('|');
        const indexedCode = parts[parts.length - 1];
        if (indexedCode === lowerQuery) {
          ids.forEach(id => matchingIds.add(id));
        }
      }
    }

    return matchingIds;
  }

  /**
   * Get all supported resource types
   */
  getResourceTypes() {
    return Array.from(this.resources.keys());
  }

  /**
   * Get search parameters for a resource type
   * @param {string} resourceType
   * @returns {SearchParameterLike[]}
   */
  getSearchParams(resourceType) {
    const params = this.searchParams.get(resourceType);
    if (!params) return [];
    return Array.from(params.values());
  }

  /**
   * Get statistics about the indexed data
   */
  getStats() {
    /** @type {{resourceTypes: Record<string, any>, totalResources: number, totalIndexEntries: number}} */
    const stats = {
      resourceTypes: {},
      totalResources: 0,
      totalIndexEntries: 0
    };

    for (const [type, resources] of this.resources) {
      const typeIndexes = this.indexes.get(type);
      let indexEntries = 0;

      if (typeIndexes) {
        for (const [, paramIndex] of typeIndexes) {
          indexEntries += paramIndex.size;
        }
      }

      stats.resourceTypes[type] = {
        count: resources.size,
        indexedParams: typeIndexes?.size || 0,
        indexEntries
      };
      stats.totalResources += resources.size;
      stats.totalIndexEntries += indexEntries;
    }

    return stats;
  }
}

module.exports = FHIRIndexer;
