//
// OperationOutcome XML Serialization
//
// @ts-check

/** @typedef {import('../../types/fhirsmith').FhirElement} FhirElement */
/** @typedef {import('../../types/fhirsmith').FhirResource} FhirResource */
/** @typedef {import('../../types/fhirsmith').XmlElement} XmlElement */

const { FhirXmlBase } = require('./xml-base');

/**
 * XML support for FHIR OperationOutcome resources
 */
class OperationOutcomeXML extends FhirXmlBase {

  /**
   * Element order for OperationOutcome (FHIR requires specific order)
   */
  static _elementOrder = [
    'id', 'meta', 'implicitRules', 'language', 'text', 'contained',
    'extension', 'modifierExtension', 'issue'
  ];

  /**
   * Element order for issue elements
   */
  static _issueElementOrder = [
    'severity', 'code', 'details', 'diagnostics', 'location', 'expression'
  ];

  /**
   * Convert OperationOutcome JSON to XML string
   * @param {FhirResource} json - OperationOutcome as JSON
   * @param {number} fhirVersion - FHIR version (3, 4, or 5)
   * @returns {string} XML string
   */
  // eslint-disable-next-line no-unused-vars
  static toXml(json, fhirVersion) {
    const content = this._renderOperationOutcome(json, 1);
    return this.wrapInRootElement('OperationOutcome', content);
  }

  /**
   * Render OperationOutcome with special handling for issues
   * @param {FhirResource} obj - OperationOutcome as JSON
   * @param {number} level - Indentation level
   * @returns {string} XML string
   * @private
   */
  static _renderOperationOutcome(obj, level) {
    let xml = '';

    // Process elements in order
    for (const key of this._elementOrder) {
      if (Object.hasOwn(obj, key) && key !== 'resourceType') {
        if (key === 'issue') {
          xml += this._renderIssues(obj.issue, level);
        } else {
          xml += this.renderElement(key, obj[key], level);
        }
      }
    }

    // Process any remaining elements
    for (const key of Object.keys(obj)) {
      if (!this._elementOrder.includes(key) && key !== 'resourceType' && !key.startsWith('_')) {
        xml += this.renderElement(key, obj[key], level);
      }
    }

    return xml;
  }

  /**
   * Render issue array with proper element ordering
   * @param {FhirElement | FhirElement[]} issues - Issue object or array
   * @param {number} level - Indentation level
   * @returns {string} XML string
   * @private
   */
  static _renderIssues(issues, level) {
    let xml = '';
    const issueList = Array.isArray(issues) ? issues : [issues];

    for (const issue of issueList) {
      xml += `${this.indent(level)}<issue>\n`;

      // Render issue elements in correct order
      for (const key of this._issueElementOrder) {
        if (Object.hasOwn(issue, key)) {
          xml += this.renderElement(key, issue[key], level + 1);
        }
      }

      // Render any remaining elements
      for (const key of Object.keys(issue)) {
        if (!this._issueElementOrder.includes(key) && !key.startsWith('_')) {
          xml += this.renderElement(key, issue[key], level + 1);
        }
      }

      xml += `${this.indent(level)}</issue>\n`;
    }

    return xml;
  }

  /**
   * Convert XML string to OperationOutcome JSON
   * @param {string} xml - XML string
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} JSON object
   */
  // eslint-disable-next-line no-unused-vars
  static fromXml(xml, fhirVersion) {
    const element = this.parseXmlString(xml);
    if (element.name !== 'OperationOutcome') {
      throw new Error(`Expected OperationOutcome root element, got ${element.name}`);
    }
    return this.convertElementToFhirJson(element, 'OperationOutcome');
  }

  /**
   * Parse from a pre-parsed XML element
   * @param {XmlElement} element - Parsed element with {name, attributes, children}
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} JSON object
   */
  // eslint-disable-next-line no-unused-vars
  static fromXmlElement(element, fhirVersion) {
    return this.convertElementToFhirJson(element, 'OperationOutcome');
  }
}

module.exports = { OperationOutcomeXML };
