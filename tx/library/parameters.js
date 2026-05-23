// @ts-check

const {getValuePrimitive, getValueDT} = require("../../library/utilities");
const {parametersToR5} = require("../xversion/xv-parameters");

/**
 * @typedef {import('../../types/fhirsmith').FhirParameterPart} FhirParameterPart
 * @typedef {import('../../types/fhirsmith').FhirResource} FhirResource
 */

class Parameters {
  /** @type {FhirResource & {resourceType: 'Parameters', parameter: FhirParameterPart[]}} */
  jsonObj;

  /**
   * @param {FhirResource | null} [jsonObj]
   * @param {string} [fhirVersion]
   */
  constructor (jsonObj = null, fhirVersion = 'R5') {
    this.jsonObj = /** @type {FhirResource & {resourceType: 'Parameters', parameter: FhirParameterPart[]}} */ (
      parametersToR5(jsonObj ? jsonObj : { "resourceType": "Parameters" }, fhirVersion)
    );
    if (!this.jsonObj.parameter) {
      this.jsonObj.parameter = [];
    }
  }

  /**
   * @param {string} name
   * @param {string} value
   * @returns {void}
   */
  addParamStr(name, value) {
    if (!this.jsonObj.parameter) {
      this.jsonObj.parameter = [];
    }
    let p = this.jsonObj.parameter.find(x => x.name === name);
    if (p) {
      p.valueString = value;
    } else {
      this.jsonObj.parameter.push({name: name, valueString: value});
    }
  }

  /**
   * @param {string} name
   * @param {string} valuename
   * @param {unknown} value
   * @returns {void}
   */
  addParam(name, valuename, value) {
    if (!this.jsonObj.parameter) {
      this.jsonObj.parameter = [];
    }
    let p = this.jsonObj.parameter.find(x => x.name === name);
    if (p) {
      p[valuename] = value;
    } else {
      let v = /** @type {FhirParameterPart} */ ({name: name});
      v[valuename] = value;
      this.jsonObj.parameter.push(v);
    }
  }

  /**
   * @param {string} name
   * @param {string} value
   * @returns {void}
   */
  addParamUri(name, value) {
    if (!this.jsonObj.parameter) {
      this.jsonObj.parameter = [];
    }
    let p = this.jsonObj.parameter.find(x => x.name === name);
    if (p) {
      p.valueUri = value;
    } else {
      this.jsonObj.parameter.push({name: name, valueUri: value});
    }
  }

  /**
   * @param {string} name
   * @param {string} value
   * @returns {void}
   */
  addParamCanonical(name, value) {
    if (!this.jsonObj.parameter) {
      this.jsonObj.parameter = [];
    }
    let p = this.jsonObj.parameter.find(x => x.name === name);
    if (p) {
      p.valueCanonical = value;
    } else {
      this.jsonObj.parameter.push({name: name, valueCanonical: value});
    }
  }

  /**
   * @param {string} name
   * @param {string} value
   * @returns {void}
   */
  addParamCode(name, value) {
    if (!this.jsonObj.parameter) {
      this.jsonObj.parameter = [];
    }
    let p = this.jsonObj.parameter.find(x => x.name === name);
    if (p) {
      p.valueCode = value;
    } else {
      this.jsonObj.parameter.push({name: name, valueCode: value});
    }
  }

  /**
   * @param {string} name
   * @param {boolean} value
   * @returns {void}
   */
  addParamBool(name, value) {
    if (!this.jsonObj.parameter) {
      this.jsonObj.parameter = [];
    }
    let p = this.jsonObj.parameter.find(x => x.name === name);
    if (p) {
      p.valueBoolean = value;
    } else {
      this.jsonObj.parameter.push({name: name, valueBoolean: value});
    }
  }

  /**
   * @param {string} name
   * @param {FhirResource} resource
   * @returns {void}
   */
  addParamResource(name, resource) {
    if (!this.jsonObj.parameter) {
      this.jsonObj.parameter = [];
    }
    this.jsonObj.parameter.push({ name: name, resource : resource });
  }

  /**
   * @param {string} name
   * @returns {FhirParameterPart | undefined}
   */
  has(name) {
    return this.jsonObj.parameter.find(x => x.name === name);
  }
  /**
   * @param {string} name
   * @returns {unknown}
   */
  get(name) {
    let p = this.jsonObj.parameter.find(x => x.name === name);
    let v = p ? getValuePrimitive(p) : null;
    if (p && !v) {
      v = getValueDT(p);
    }
    return v;
  }

}

module.exports = { Parameters };
