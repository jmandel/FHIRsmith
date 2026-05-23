// @ts-check

const {getValuePrimitive} = require("../../library/utilities");
const {Issue} = require("./operation-outcome");

/**
 * @typedef {import('../../types/fhirsmith').FhirElement} FhirElement
 * @typedef {import('../../types/fhirsmith').FhirExtension} FhirExtension
 * @typedef {import('../../types/fhirsmith').FhirExtensionSource} FhirExtensionSource
 */

/**
 * @param {FhirExtensionSource} source
 * @param {'extension' | 'modifierExtension'} property
 * @returns {FhirExtension[]}
 */
function extensionArray(source, property) {
  if (!source) {
    return [];
  }
  if (Array.isArray(source)) {
    return source;
  }
  return source[property] || [];
}

const Extensions = {

  /**
   * @param {FhirExtensionSource} object
   * @param {string} url
   * @returns {FhirExtension[]}
   */
  list(object, url) {
    const extensions = extensionArray(object, 'extension');
    if (extensions.length) {
      const res = [];
      for (const extension of extensions) {
        if (extension.url === url) res.push(extension);
      }
      return res;
    } else {
      return [];
    }
  },

  /**
   * @param {FhirElement | null | undefined} resource
   * @param {string} place
   * @param {string} name
   * @returns {void}
   */
  checkNoImplicitRules(resource, place, name) {
    if (!resource) {
      return;
    }
    if (resource.jsonObj) {
      resource = resource.jsonObj
    }
    if (resource.implicitRules) {
      throw new Issue("error", "business-rule", null, null, 'Cannot process resource "'+name+'" due to the presence of implicit rules @'+place);
    }
  },

  /**
   * @param {FhirElement | null | undefined} element
   * @param {string} place
   * @param {string} name
   * @param {string} [resource]
   * @returns {true | void}
   */
  checkNoModifiers(element, place, name, resource) {
    if (!element) {
      return;
    }
    if (element.jsonObj) {
      element = element.jsonObj
    }
    if (element.modifierExtension) {
      let urls = new Set();
      for (const extension of element.modifierExtension) {
        urls.add(extension.url);
      }
      const resId = resource ? resource : "";
      const urlList = [...urls].join('\', \'');
      if (urls.size > 1) {
        throw new Issue("error", "business-rule", null, null, 'Cannot process resource '+resId+' at "' + name + '" due to the presence of modifier extensions '+urlList);
      } else {
        throw new Issue("error", "business-rule", null, null, 'Cannot process resource '+resId+' at "' + name + '" due to the presence of the modifier extension '+urlList);
      }
    }
    return true;
  },

  /**
   * @param {FhirExtensionSource} resource
   * @param {string} url
   * @returns {unknown}
   */
  readString(resource, url) {
    if (!resource) {
      return undefined;
    }
    let extensions = extensionArray(resource, 'extension');
    for (let ext of extensions || []) {
      if (ext.url === url) {
        return getValuePrimitive(ext);
      }
    }
    extensions = extensionArray(resource, 'modifierExtension');
    for (let ext of extensions || []) {
      if (ext.url === url) {
        return getValuePrimitive(ext);
      }
    }
    return null;
  },

  /**
   * @param {FhirExtensionSource} resource
   * @param {string} url
   * @param {number} defaultValue
   * @returns {number}
   */
  readNumber(resource, url, defaultValue) {
    if (!resource) {
      return defaultValue;
    }
    const extensions = extensionArray(resource, 'extension');
    for (let ext of extensions) {
      if (ext.url === url) {
        const value = getValuePrimitive(ext);
        if (typeof value === 'number') {
          return value;
        }
        if (typeof value === 'string') {
          const num = parseFloat(value);
          return isNaN(num) ? defaultValue : num;
        }
        return defaultValue;
      }
    }
    return defaultValue;
  },

  /**
   * @param {FhirExtensionSource} resource
   * @param {string} url
   * @returns {FhirExtension | null | undefined}
   */
  readValue(resource, url) {
    if (!resource) {
      return undefined;
    }
    const extensions = extensionArray(resource, 'extension');
    for (let ext of extensions || []) {
      if (ext.url === url) {
        return ext;
      }
    }
    return null;
  },

  /**
   * @param {FhirExtensionSource} object
   * @param {string} url
   * @returns {FhirExtension | undefined}
   */
  has(object, url) {
    if (!object) {
      return undefined;
    }
    const extensions = extensionArray(object, 'extension');
    return extensions.find(ex => ex.url === url);
  },

  /**
   * @param {FhirElement} exp
   * @param {string} url
   * @param {boolean} b
   * @returns {FhirExtension}
   */
  addBoolean(exp, url, b) {
    if (!exp.extension) {
      exp.extension = [];
    }
    let ext = /** @type {FhirExtension} */ ({ url : url, valueBoolean : b });
    exp.extension.push(ext);
    return ext;
  },

  /**
   * @param {FhirElement} exp
   * @param {string} url
   * @param {string} s
   * @returns {FhirExtension}
   */
  addString(exp, url, s) {
    if (!exp.extension) {
      exp.extension = [];
    }
    let ext = /** @type {FhirExtension} */ ({ url : url, valueString : s });
    exp.extension.push(ext);
    return ext;
  }
}

module.exports = { Extensions };
