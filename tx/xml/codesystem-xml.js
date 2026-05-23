//
// CodeSystem XML Serialization
//
// @ts-check

/** @typedef {import('../../types/fhirsmith').FhirResource} FhirResource */
/** @typedef {import('../../types/fhirsmith').XmlElement} XmlElement */

const { FhirXmlBase } = require('./xml-base');

/**
 * XML support for FHIR CodeSystem resources
 */
class CodeSystemXML extends FhirXmlBase {

  /**
   * Element order for CodeSystem (FHIR requires specific order)
   */
  static _elementOrder = [
    'id', 'meta', 'implicitRules', 'language', 'text', 'contained',
    'extension', 'modifierExtension',
    'url', 'identifier', 'version', 'versionAlgorithmString', 'versionAlgorithmCoding',
    'name', 'title', 'status', 'experimental', 'date', 'publisher',
    'contact', 'description', 'useContext', 'jurisdiction', 'purpose', 'copyright',
    'copyrightLabel', 'approvalDate', 'lastReviewDate', 'effectivePeriod',
    'caseSensitive', 'valueSet', 'hierarchyMeaning', 'compositional', 'versionNeeded',
    'content', 'supplements', 'count', 'filter', 'property', 'concept'
  ];

  /**
   * Convert CodeSystem JSON to XML string
   * @param {FhirResource} json - CodeSystem as JSON
   * @returns {string} XML string
   */
  static toXml(json) {
    const content = this.renderElementsInOrder(json, 1, this._elementOrder);
    return this.wrapInRootElement('CodeSystem', content);
  }

  /**
   * Convert XML string to CodeSystem JSON
   * @param {string} xml - XML string
   * @returns {FhirResource} JSON object
   */
  static fromXml(xml) {
    const element = this.parseXmlString(xml);
    if (element.name !== 'CodeSystem') {
      throw new Error(`Expected CodeSystem root element, got ${element.name}`);
    }
    return this.convertElementToFhirJson(element, 'CodeSystem');
  }

  /**
   * Parse from a pre-parsed XML element
   * @param {XmlElement} element - Parsed element with {name, attributes, children}
   * @returns {FhirResource} JSON object
   */
  static fromXmlElement(element) {
    return this.convertElementToFhirJson(element, 'CodeSystem');
  }
}

module.exports = { CodeSystemXML };
