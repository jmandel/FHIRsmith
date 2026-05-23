//
// TerminologyCapabilities XML Serialization
//
// @ts-check

/** @typedef {import('../../types/fhirsmith').FhirResource} FhirResource */
/** @typedef {import('../../types/fhirsmith').XmlElement} XmlElement */

const { FhirXmlBase } = require('./xml-base');

/**
 * XML support for FHIR TerminologyCapabilities resources
 */
class TerminologyCapabilitiesXML extends FhirXmlBase {

  /**
   * Element order for TerminologyCapabilities (FHIR requires specific order)
   */
  static _elementOrder = [
    'id', 'meta', 'implicitRules', 'language', 'text', 'contained',
    'extension', 'modifierExtension',
    'url', 'identifier', 'version', 'versionAlgorithmString', 'versionAlgorithmCoding',
    'name', 'title', 'status', 'experimental', 'date', 'publisher',
    'contact', 'description', 'useContext', 'jurisdiction', 'purpose', 'copyright',
    'copyrightLabel', 'kind', 'software', 'implementation', 'lockedDate',
    'codeSystem', 'expansion', 'codeSearch', 'validateCode', 'translation', 'closure'
  ];

  /**
   * Convert TerminologyCapabilities JSON to XML string
   * @param {FhirResource} json - TerminologyCapabilities as JSON
   * @param {number} fhirVersion - FHIR version (3, 4, or 5)
   * @returns {string} XML string
   */
  // eslint-disable-next-line no-unused-vars
  static toXml(json, fhirVersion) {
    const content = this.renderElementsInOrder(json, 1, this._elementOrder);
    return this.wrapInRootElement('TerminologyCapabilities', content);
  }

  /**
   * Convert XML string to TerminologyCapabilities JSON
   * @param {string} xml - XML string
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} JSON object
   */
  // eslint-disable-next-line no-unused-vars
  static fromXml(xml, fhirVersion) {
    const element = this.parseXmlString(xml);
    if (element.name !== 'TerminologyCapabilities') {
      throw new Error(`Expected TerminologyCapabilities root element, got ${element.name}`);
    }
    return this.convertElementToFhirJson(element, 'TerminologyCapabilities');
  }

  /**
   * Parse from a pre-parsed XML element
   * @param {XmlElement} element - Parsed element with {name, attributes, children}
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} JSON object
   */
  // eslint-disable-next-line no-unused-vars
  static fromXmlElement(element, fhirVersion) {
    return this.convertElementToFhirJson(element, 'TerminologyCapabilities');
  }
}

module.exports = { TerminologyCapabilitiesXML };
