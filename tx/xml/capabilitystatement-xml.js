//
// CapabilityStatement XML Serialization
//
// @ts-check

/** @typedef {import('../../types/fhirsmith').FhirResource} FhirResource */
/** @typedef {import('../../types/fhirsmith').XmlElement} XmlElement */

const { FhirXmlBase } = require('./xml-base');

/**
 * XML support for FHIR CapabilityStatement resources
 */
class CapabilityStatementXML extends FhirXmlBase {

  /**
   * Element order for CapabilityStatement (FHIR requires specific order)
   */
  static _elementOrder = [
    'id', 'meta', 'implicitRules', 'language', 'text', 'contained',
    'extension', 'modifierExtension',
    'url', 'identifier', 'version', 'versionAlgorithmString', 'versionAlgorithmCoding',
    'name', 'title', 'status', 'experimental', 'date', 'publisher',
    'contact', 'description', 'useContext', 'jurisdiction', 'purpose', 'copyright',
    'copyrightLabel', 'kind', 'instantiates', 'imports',
    'software', 'implementation', 'fhirVersion', 'format', 'patchFormat',
    'acceptLanguage', 'implementationGuide', 'rest', 'messaging', 'document'
  ];

  /**
   * Convert CapabilityStatement JSON to XML string
   * @param {FhirResource} json - CapabilityStatement as JSON
   * @param {number} fhirVersion - FHIR version (3, 4, or 5)
   * @returns {string} XML string
   */
  // eslint-disable-next-line no-unused-vars
  static toXml(json, fhirVersion) {
    const content = this.renderElementsInOrder(json, 1, this._elementOrder);
    return this.wrapInRootElement('CapabilityStatement', content);
  }

  /**
   * Convert XML string to CapabilityStatement JSON
   * @param {string} xml - XML string
   * @returns {FhirResource} JSON object
   */
  static fromXml(xml) {
    const element = this.parseXmlString(xml);
    if (element.name !== 'CapabilityStatement') {
      throw new Error(`Expected CapabilityStatement root element, got ${element.name}`);
    }
    return this.convertElementToFhirJson(element, 'CapabilityStatement');
  }

  /**
   * Parse from a pre-parsed XML element
   * @param {XmlElement} element - Parsed element with {name, attributes, children}
   * @returns {FhirResource} JSON object
   */
  static fromXmlElement(element) {
    return this.convertElementToFhirJson(element, 'CapabilityStatement');
  }
}

module.exports = { CapabilityStatementXML };
