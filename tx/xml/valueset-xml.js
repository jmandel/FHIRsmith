//
// ValueSet XML Serialization
//
// @ts-check

/** @typedef {import('../../types/fhirsmith').FhirResource} FhirResource */
/** @typedef {import('../../types/fhirsmith').XmlElement} XmlElement */

const { FhirXmlBase } = require('./xml-base');

/**
 * XML support for FHIR ValueSet resources
 */
class ValueSetXML extends FhirXmlBase {

  /**
   * Element order for ValueSet (FHIR requires specific order)
   */
  static _elementOrder = [
    'id', 'meta', 'implicitRules', 'language', 'text', 'contained',
    'extension', 'modifierExtension',
    'url', 'identifier', 'version', 'versionAlgorithmString', 'versionAlgorithmCoding',
    'name', 'title', 'status', 'experimental', 'date', 'publisher',
    'contact', 'description', 'useContext', 'jurisdiction', 'purpose', 'copyright',
    'copyrightLabel', 'approvalDate', 'lastReviewDate', 'effectivePeriod',
    'immutable', 'compose', 'expansion'
  ];

  /**
   * Convert ValueSet JSON to XML string
   * @param {FhirResource} json - ValueSet as JSON
   * @param {number} fhirVersion - FHIR version (3, 4, or 5)
   * @returns {string} XML string
   */
  // eslint-disable-next-line no-unused-vars
  static toXml(json, fhirVersion) {
    const content = this.renderElementsInOrder(json, 1, this._elementOrder);
    return this.wrapInRootElement('ValueSet', content);
  }

  /**
   * Convert XML string to ValueSet JSON
   * @param {string} xml - XML string
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} JSON object
   */
  // eslint-disable-next-line no-unused-vars
  static fromXml(xml, fhirVersion) {
    const element = this.parseXmlString(xml);
    if (element.name !== 'ValueSet') {
      throw new Error(`Expected ValueSet root element, got ${element.name}`);
    }
    return this.convertElementToFhirJson(element, 'ValueSet');
  }

  /**
   * Parse from a pre-parsed XML element
   * @param {XmlElement} element - Parsed element with {name, attributes, children}
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} JSON object
   */
  // eslint-disable-next-line no-unused-vars
  static fromXmlElement(element, fhirVersion) {
    return this.convertElementToFhirJson(element, 'ValueSet');
  }
}

module.exports = { ValueSetXML };
