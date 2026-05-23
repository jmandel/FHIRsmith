// @ts-check

const {CodeSystemProvider} = require("./cs-api");

/**
 * @typedef {import('../../types/fhirsmith').FhirParameterPart} FhirParameterPart
 * @typedef {FhirParameterPart & {part: FhirParameterPart[]}} FhirParameterWithParts
 */

class BaseCSServices extends CodeSystemProvider {

  /**
   * @param {FhirParameterPart[]} params
   * @param {string} type
   * @param {string} name
   * @param {string} value
   * @param {string | null} [language]
   * @returns {void}
   */
  _addProperty(params, type, name, value, language = null) {

    const property = /** @type {FhirParameterWithParts} */ ({
      name: type,
      part: [
        {name: 'code', valueCode: name},
        {name: 'value', valueString: value}
      ]
    });

    if (language) {
      property.part.push({name: 'language', valueCode: language});
    }

    params.push(property);
  }

  /**
   * @param {FhirParameterPart[]} params
   * @param {string} type
   * @param {string} name
   * @param {string} value
   * @param {string | null} [language]
   * @param {string | null} [description]
   * @returns {FhirParameterPart}
   */
  _addCodeProperty(params, type, name, value, language = null, description = null) {

    const property = /** @type {FhirParameterWithParts} */ ({
      name: type,
      part: [
        {name: 'code', valueCode: name},
        {name: 'value', valueCode: value}
      ]
    });

    if (language) {
      property.part.push({name: 'language', valueCode: language});
    }
    if (description) {
      property.part.push({name: 'description', valueString: description});
    }

    params.push(property);
    return property;
  }

  /**
   * @param {FhirParameterPart[]} params
   * @param {string} type
   * @param {string} name
   * @param {string} value
   * @returns {FhirParameterPart}
   */
  _addDateTimeProperty(params, type, name, value) {

    const property = /** @type {FhirParameterWithParts} */ ({
      name: type,
      part: [
        {name: 'code', valueCode: name},
        {name: 'value', valueDateTime: value}
      ]
    });
    params.push(property);
    return property;
  }

  /**
   * @param {FhirParameterPart[]} params
   * @param {string} type
   * @param {string} name
   * @param {string} value
   * @param {string | null} [language]
   * @returns {FhirParameterPart}
   */
  _addStringProperty(params, type, name, value, language = null) {

    const property = /** @type {FhirParameterWithParts} */ ({
      name: type,
      part: [
        {name: 'code', valueCode: name},
        {name: 'value', valueString: value}
      ]
    });

    if (language) {
      property.part.push({name: 'language', valueCode: language});
    }

    params.push(property);
    return property;
  }


  // Helper to check if a property should be included
  /**
   * @param {string[] | null | undefined} props
   * @param {string} name
   * @param {boolean} [defaultValue]
   * @returns {boolean}
   */
  _hasProp = (props, name, defaultValue = true) => {
    if (!props || props.length === 0) {
      return defaultValue;
    }
    const lowerName = name.toLowerCase();
    return props.some(p =>
      p.toLowerCase() === lowerName || p === '*'
    );
  };
}


module.exports = {
  BaseCSServices
};
