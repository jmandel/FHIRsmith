// @ts-check

// // Convert input to Languages instance if needed
// const langs = languages instanceof Languages ? languages :
//   Array.isArray(languages) ? Languages.fromAcceptLanguage(languages.join(',')) :
//     Languages.fromAcceptLanguage(languages || '');

// code instanceof CodeSystemProviderContext ? this.code


// const {Language} = require("./languages");
// if (designation.language) {
//   const designationLang = new Language(designation.language);
//   for (const requestedLang of langs) {
//     if (designationLang.matchesForDisplay(requestedLang)) {

/**
 * @typedef {{new (...args: any[]): any, name: string}} RuntimeConstructor
 * @typedef {Record<string, unknown>} ValueCarrier
 */

/**
 * @type {{
 *   noString(str: unknown): boolean,
 *   existsInList<T>(item: T, ...list: T[]): boolean,
 *   isInteger(str: unknown): boolean,
 *   parseIntOrDefault(value: string | number, defaultValue: number): number,
 *   parseFloatOrDefault(value: string | number, defaultValue: number): number,
 *   formatDuration(start: number, end: number): string
 * }}
 */
const Utilities = {
  noString: (str) => !str || String(str).trim() === '',
  existsInList: (item, ...list) => list.includes(item),
  isInteger: (str) => {
    if (typeof str !== 'string' || str === '') return false;
    const num = parseInt(str, 10);
    return num.toString() === str && !isNaN(num);
  },
  parseIntOrDefault(value, defaultValue) {
    const num = parseInt(String(value), 10);
    return isNaN(num) ? defaultValue : num;
  },
  parseFloatOrDefault(value, defaultValue) {
    const num = parseFloat(String(value));
    return isNaN(num) ? defaultValue : num;


  },

  /**
   * Format the difference between two Date.now() timestamps for human reading
   * @param {number} start - earlier timestamp (from Date.now())
   * @param {number} end - later timestamp (from Date.now())
   * @returns {string} formatted duration
   */
  formatDuration(start, end) {
    let ms = Math.abs(end - start);

    if (ms < 1000) return `${ms}ms`;

    const days = Math.floor(ms / 86400000);
    ms %= 86400000;
    const hours = Math.floor(ms / 3600000);
    ms %= 3600000;
    const minutes = Math.floor(ms / 60000);
    ms %= 60000;
    const seconds = Math.floor(ms / 1000);
    ms %= 1000;

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || ms) {
      parts.push(ms ? `${seconds}.${String(ms).padStart(3, '0')}s` : `${seconds}s`);
    }

    return parts.join(' ');
  }

};

/**
 * Validate a value against a runtime constructor.
 *
 * @param {any} param
 * @param {string} name
 * @param {RuntimeConstructor | StringConstructor | NumberConstructor | BooleanConstructor} type
 * @returns {void}
 */
function validateParameter(param, name, type) {
  if (param == null) {
    throw new Error(`${name} must be provided`);
  }

  const actualType = param.constructor?.name || typeof param;

  if (type === String) {
    if (typeof param !== 'string') {
      throw new Error(`${name} must be a string, but got ${actualType}`);
    }
  } else if (type === Number) {
    if (typeof param !== 'number' || isNaN(param)) {
      throw new Error(`${name} must be a number, but got ${actualType}`);
    }
  } else if (type === Boolean) {
    if (typeof param !== 'boolean') {
      throw new Error(`${name} must be a boolean, but got ${actualType}`);
    }
  } else {
    if (typeof param !== 'object') {
      throw new Error(`${name} must be a valid ${type.name}, but got ${actualType}`);
    }
    // Handle object types with instanceof
    if (!(param instanceof type)) {
      throw new Error(`${name} must be a valid ${type.name}, but got ${actualType}`);
    }
  }
}

/**
 * @param {any} param
 * @param {string} name
 * @param {string} type
 * @returns {void}
 */
function validateResource(param, name, type) {
  if (param == null) {
    throw new Error(`${name} must be provided`);
  }
  if (!(param instanceof Object)) {
    throw new Error(`${name} must be a Resource not a `);
  }
  if (param.resourceType != type) {
    throw new Error(`${name} must be a Resource of type ${type} not ${param.resourceType}`);
  }
}

/**
 * @param {any} param
 * @param {string} name
 * @param {RuntimeConstructor | StringConstructor | NumberConstructor | BooleanConstructor} type
 * @returns {void}
 */
function validateOptionalParameter(param, name, type) {
  if (param) {
    validateParameter(param, name, type);
  }
}

/**
 * @param {any[] | null | undefined} param
 * @param {string} name
 * @param {RuntimeConstructor | StringConstructor | NumberConstructor | BooleanConstructor} type
 * @param {boolean} [optional]
 * @returns {void}
 */
function validateArrayParameter(param, name, type, optional) {
  if (param == null) {
    if (optional) {
      return;
    } else {
      throw new Error(`${name} must be provided`);
    }
  }
  if (!Array.isArray(param)) {
    throw new Error(`${name} must be an array`);
  }
  for (let i = 0; i < param.length; i++) {
    validateParameter(param[i], name+`[${i}]`, type);
  }
}

/**
 * @param {unknown} value
 * @param {boolean} [defaultValue]
 * @returns {boolean}
 */
function strToBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return value === 'true' || value === true;
}

/**
 * Return the first FHIR primitive value field found on an element.
 *
 * @param {ValueCarrier | null | undefined} obj
 * @returns {unknown}
 */
function getValuePrimitive(obj) {
  if (!obj) return null;

  const primitiveTypes = [
    'valueString', 'valueCode', 'valueUri', 'valueUrl', 'valueCanonical',
    'valueBoolean', 'valueInteger', 'valueDecimal', 'valueDate', 'valueDateTime',
    'valueTime', 'valueInstant', 'valueId', 'valueOid', 'valueUuid',
    'valueMarkdown', 'valueBase64Binary', 'valuePositiveInt', 'valueUnsignedInt', 'valueInteger64'
  ];

  for (const type of primitiveTypes) {
    if (obj[type] !== undefined) {
      return obj[type];
    }
  }
  return null;
}

/**
 * Return the first FHIR complex datatype value field found on an element.
 *
 * @param {ValueCarrier | null | undefined} obj
 * @returns {unknown}
 */
function getValueDT(obj) {
  if (!obj) return null;

  const primitiveTypes = [
    'valueAddress', 'valueAge', 'valueAnnotation',
    'valueAttachment', 'valueCodeableConcept', 'valueCodeableReference', 'valueCoding', 'valueContactPoint', 'valueCount',
    'valueDistance', 'valueDuration', 'valueHumanName', 'valueIdentifier', 'valueMoney', 'valuePeriod', 'valueQuantity', 'valueRange',
    'valueRatio', 'valueRatioRange', 'valueReference', 'valueSampledData', 'valueSignature', 'valueTiming', 'valueContactDetail',
    'valueDataRequirement', 'valueExpression', 'valueParameterDefinition', 'valueRelatedArtifact', 'valueTriggerDefinition',
    'valueUsageContext', 'valueAvailability', 'valueExtendedContactDetail', 'valueVirtualServiceDetail', 'valueDosage', 'valueMeta'
  ];

  for (const type of primitiveTypes) {
    if (obj[type] !== undefined) {
      return obj[type];
    }
  }
  return null;
}



/**
 * Return the FHIR value[x] field name present on an element.
 *
 * @param {ValueCarrier | null | undefined} obj
 * @returns {string | null}
 */
function getValueName(obj) {
  if (!obj) return null;

  const primitiveTypes = [
    'valueString', 'valueCode', 'valueUri', 'valueUrl', 'valueCanonical',
    'valueBoolean', 'valueInteger', 'valueDecimal', 'valueDate', 'valueDateTime',
    'valueTime', 'valueInstant', 'valueId', 'valueOid', 'valueUuid',
    'valueMarkdown', 'valueBase64Binary', 'valuePositiveInt', 'valueAddress', 'valueAge', 'valueAnnotation',
    'valueAttachment', 'valueCodeableConcept', 'valueCodeableReference', 'valueCoding', 'valueContactPoint', 'valueCount',
    'valueDistance', 'valueDuration', 'valueHumanName', 'valueIdentifier', 'valueMoney', 'valuePeriod', 'valueQuantity', 'valueRange',
    'valueRatio', 'valueRatioRange', 'valueReference', 'valueSampledData', 'valueSignature', 'valueTiming', 'valueContactDetail',
    'valueDataRequirement', 'valueExpression', 'valueParameterDefinition', 'valueRelatedArtifact', 'valueTriggerDefinition',
    'valueUsageContext', 'valueAvailability', 'valueExtendedContactDetail', 'valueVirtualServiceDetail', 'valueDosage', 'valueMeta'
  ];

  for (const type of primitiveTypes) {
    if (obj[type] !== undefined) {
      return type;
    }
  }
  return null;
}

/**
 * @param {string | null | undefined} s
 * @returns {boolean}
 */
function isAbsoluteUrl(s) {
  return Boolean(s && (s.startsWith('urn:') || s.startsWith('http:') || s.startsWith('https:') || s.startsWith('ftp:')));
}

/**
 * This class takes two lists, and matches between the lists, producing three new lists:
 *   * items that are in both
 *   * items that only in left
 *   * items that are only in right
 *
 * You have to give it a match function that is called asynchronously
 *
 * examples of use:
 *
 * const matcher = new ArrayMatcher((l, r) =>
 *   this.filtersMatch(localstatus, cs, l, r)
 * );
 * await matcher.match(leftArray, rightArray);
 *
 * // Use the results
 * for (const { left, right } of matcher.matched) { ... }
 * for (const item of matcher.unmatchedLeft) { ... }
 * for (const item of matcher.unmatchedRight) { ... }
 *
 * // or
 * const matcher2 = new ArrayMatcher((l, r) =>
 *   this.compareProperties(system, version, l, r)
 * );
 * await matcher2.match(propsA, propsB);
 *
 */
/**
 * @template L
 * @template R
 */
class ArrayMatcher {
  /**
   * @param {(left: L, right: R) => boolean | Promise<boolean>} matchFn
   */
  constructor(matchFn) {
    this.matchFn = matchFn;
    /** @type {{left: L, right: R}[]} */
    this.matched = [];
    /** @type {L[]} */
    this.unmatchedLeft = [];
    /** @type {R[]} */
    this.unmatchedRight = [];
  }

  /**
   *
   * @param {L[] | null | undefined} left an array of items (or null/undefined)
   * @param {R[] | null | undefined} right an array of items (or null/undefined)
   * @returns {Promise<this>}
   */
  async match(left, right) {
    if (!left) {
      left = [];
    }
    if (!right) {
      right = [];
    }

    this.matched = [];
    this.unmatchedRight = [...right];

    for (const l of left) {
      let idx = -1;
      for (let i = 0; i < this.unmatchedRight.length; i++) {
        if (await this.matchFn(l, this.unmatchedRight[i])) {
          idx = i;
          break;
        }
      }
      if (idx !== -1) {
        this.matched.push({ left: l, right: this.unmatchedRight[idx] });
        this.unmatchedRight.splice(idx, 1);
      } else {
        this.unmatchedLeft.push(l);
      }
    }

    return this;
  }
}

const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * @param {string} s MMDDYYYY date string
 * @returns {string}
 */
function formatDateMMDDYYYY(s) {
  const mm = parseInt(s.substring(0, 2), 10);
  const dd = s.substring(2, 4);
  const yyyy = s.substring(4, 8);
  return dd + '-' + months[mm - 1] + ' ' + yyyy;
}

module.exports = { Utilities, ArrayMatcher, validateParameter, validateOptionalParameter, validateArrayParameter, validateResource, strToBool, getValuePrimitive, getValueDT, getValueName, isAbsoluteUrl, formatDateMMDDYYYY };
