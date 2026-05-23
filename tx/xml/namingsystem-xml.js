//
// NamingSystem XML Serialization
//
// @ts-check

/** @typedef {import('../../types/fhirsmith').FhirResource} FhirResource */
/** @typedef {import('../../types/fhirsmith').XmlElement} XmlElement */

const { FhirXmlBase } = require('./xml-base');

/**
 * XML support for FHIR NamingSystem resources
 */
class NamingSystemXML extends FhirXmlBase {

  /**
   * Element order for NamingSystem (FHIR requires specific order)
   */
  static _elementOrder = [
    'id', 'meta', 'implicitRules', 'language', 'text', 'contained',
    'extension', 'modifierExtension',
    'url', 'identifier', 'version', 'versionAlgorithmString', 'versionAlgorithmCoding',
    'name', 'title', 'status', 'kind', 'experimental', 'date', 'publisher',
    'contact', 'responsible', 'type', 'description', 'useContext', 'jurisdiction',
    'purpose', 'copyright', 'copyrightLabel', 'approvalDate', 'lastReviewDate',
    'effectivePeriod', 'topic', 'author', 'editor', 'reviewer', 'endorser',
    'relatedArtifact', 'usage', 'uniqueId'
  ];

  /**
   * Convert NamingSystem JSON to XML string
   * @param {FhirResource} json - NamingSystem as JSON
   * @param {number} fhirVersion - FHIR version (3, 4, or 5)
   * @returns {string} XML string
   */
  // eslint-disable-next-line no-unused-vars
  static toXml(json, fhirVersion) {
    const content = this.renderElementsInOrder(json, 1, this._elementOrder);
    return this.wrapInRootElement('NamingSystem', content);
  }

  /**
   * Convert XML string to NamingSystem JSON
   * @param {string} xml - XML string
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} JSON object
   */
  // eslint-disable-next-line no-unused-vars
  static fromXml(xml, fhirVersion) {
    const element = this.parseXmlString(xml);
    if (element.name !== 'NamingSystem') {
      throw new Error(`Expected NamingSystem root element, got ${element.name}`);
    }
    return this.convertElementToFhirJson(element, 'NamingSystem');
  }

  /**
   * Parse from a pre-parsed XML element
   * @param {XmlElement} element - Parsed element with {name, attributes, children}
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} JSON object
   */
  // eslint-disable-next-line no-unused-vars
  static fromXmlElement(element, fhirVersion) {
    return this.convertElementToFhirJson(element, 'NamingSystem');
  }
}

module.exports = { NamingSystemXML };
