//
// Parameters XML Serialization
//
// @ts-check

/** @typedef {import('../../types/fhirsmith').FhirElement} FhirElement */
/** @typedef {import('../../types/fhirsmith').FhirParameterPart} FhirParameterPart */
/** @typedef {import('../../types/fhirsmith').FhirResource} FhirResource */
/** @typedef {import('../../types/fhirsmith').XmlElement} XmlElement */

const { FhirXmlBase } = require('./xml-base');

// Forward declarations - will be loaded lazily to avoid circular dependencies
/** @type {any} */
let CodeSystemXML;
/** @type {any} */
let ValueSetXML;
/** @type {any} */
let ConceptMapXML;
/** @type {any} */
let OperationOutcomeXML;

/**
 * XML support for FHIR Parameters resources
 */
class ParametersXML extends FhirXmlBase {

  /**
   * Element order for Parameters (FHIR requires specific order)
   */
  static _elementOrder = [
    'id', 'meta', 'implicitRules', 'language', 'parameter'
  ];

  /**
   * Lazily load resource XML classes to avoid circular dependencies
   */
  static _loadResourceClasses() {
    if (!CodeSystemXML) {
      CodeSystemXML = require('./codesystem-xml').CodeSystemXML;
      ValueSetXML = require('./valueset-xml').ValueSetXML;
      ConceptMapXML = require('./conceptmap-xml').ConceptMapXML;
      OperationOutcomeXML = require('./operationoutcome-xml').OperationOutcomeXML;
    }
  }

  /**
   * Convert Parameters JSON to XML string
   * @param {FhirResource} json - Parameters as JSON
   * @param {number} fhirVersion - FHIR version (3, 4, or 5)
   * @returns {string} XML string
   */
  static toXml(json, fhirVersion) {
    this._loadResourceClasses();
    const content = this._renderParameters(json, 1, fhirVersion);
    return this.wrapInRootElement('Parameters', content);
  }

  /**
   * Render Parameters with special handling for parameter elements
   * @param {FhirResource} obj - Parameters as JSON
   * @param {number} level - Indentation level
   * @param {number} fhirVersion - FHIR version
   * @returns {string} XML string
   * @private
   */
  static _renderParameters(obj, level, fhirVersion) {
    let xml = '';

    // Process elements in order
    for (const key of this._elementOrder) {
      if (Object.hasOwn(obj, key) && key !== 'resourceType') {
        if (key === 'parameter') {
          if (obj.parameter !== undefined) {
            xml += this._renderParameterArray(obj.parameter, level, fhirVersion);
          }
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
   * Render parameter array
   * @param {FhirParameterPart | FhirParameterPart[]} parameters - Parameters to render
   * @param {number} level - Indentation level
   * @param {number} fhirVersion - FHIR version
   * @returns {string} XML string
   * @private
   */
  static _renderParameterArray(parameters, level, fhirVersion) {
    let xml = '';
    if (!Array.isArray(parameters)) {
      parameters = [parameters];
    }

    for (const param of parameters) {
      xml += `${this.indent(level)}<parameter>\n`;
      xml += this._renderParameter(param, level + 1, fhirVersion);
      xml += `${this.indent(level)}</parameter>\n`;
    }

    return xml;
  }

  /**
   * Render a single parameter
   * @param {FhirParameterPart} param - Parameter to render
   * @param {number} level - Indentation level
   * @param {number} fhirVersion - FHIR version
   * @returns {string} XML string
   * @private
   */
  static _renderParameter(param, level, fhirVersion) {
    let xml = '';

    // Parameter element order: name, value[x], resource, part
    if (param.name !== undefined) {
      xml += `${this.indent(level)}<name value="${this.escapeXml(param.name)}"/>\n`;
    }

    // Handle value[x] - find the value property
    for (const [key, value] of Object.entries(param)) {
      if (key.startsWith('value')) {
        xml += this.renderElement(key, value, level);
        break;
      }
    }

    // Handle resource
    if (param.resource) {
      xml += `${this.indent(level)}<resource>\n`;
      xml += this._renderResource(param.resource, level + 1, fhirVersion);
      xml += `${this.indent(level)}</resource>\n`;
    }

    // Handle nested parts
    if (param.part) {
      for (const part of param.part) {
        xml += `${this.indent(level)}<part>\n`;
        xml += this._renderParameter(part, level + 1, fhirVersion);
        xml += `${this.indent(level)}</part>\n`;
      }
    }

    return xml;
  }

  /**
   * Render an embedded resource
   * @param {FhirResource} resource - Resource to render
   * @param {number} level - Indentation level
   * @param {number} fhirVersion - FHIR version
   * @returns {string} XML string
   * @private
   */
  static _renderResource(resource, level, fhirVersion) {
    const resourceType = resource.resourceType;
    if (!resourceType) {
      return '';
    }

    // Try to use dedicated XML converter
    /** @type {string} */
    let fullXml;
    try {
      switch (resourceType) {
        case 'CodeSystem':
          fullXml = CodeSystemXML.toXml(resource, fhirVersion);
          break;
        case 'ValueSet':
          fullXml = ValueSetXML.toXml(resource, fhirVersion);
          break;
        case 'ConceptMap':
          fullXml = ConceptMapXML.toXml(resource, fhirVersion);
          break;
        case 'OperationOutcome':
          fullXml = OperationOutcomeXML.toXml(resource, fhirVersion);
          break;
        case 'Parameters':
          fullXml = ParametersXML.toXml(resource, fhirVersion);
          break;
        default:
          // Fall back to generic rendering
          return this._renderGenericResource(resource, level);
      }

      // Remove XML declaration and re-indent
      let fragment = fullXml.replace(/^<\?xml[^?]*\?>\s*\n?/, '');

      // Add indentation to each line
      const indent = this.indent(level);
      fragment = fragment.split('\n').map(line => line ? indent + line : line).join('\n');

      return fragment;
    } catch (e) {
      return this._renderGenericResource(resource, level);
    }
  }

  /**
   * Generic resource rendering fallback
   * @param {FhirResource} resource - Resource to render
   * @param {number} level - Indentation level
   * @returns {string} XML string
   * @private
   */
  static _renderGenericResource(resource, level) {
    let xml = '';
    const resourceType = resource.resourceType;
    if (resourceType) {
      xml += `${this.indent(level)}<${resourceType} xmlns="${this.getNamespace()}">\n`;
      for (const [key, value] of Object.entries(resource)) {
        if (key !== 'resourceType') {
          xml += this.renderElement(key, value, level + 1);
        }
      }
      xml += `${this.indent(level)}</${resourceType}>\n`;
    }
    return xml;
  }

  /**
   * Convert XML string to Parameters JSON
   * @param {string} xml - XML string
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} JSON object
   */
  static fromXml(xml, fhirVersion) {
    this._loadResourceClasses();
    const element = this.parseXmlString(xml);
    if (element.name !== 'Parameters') {
      throw new Error(`Expected Parameters root element, got ${element.name}`);
    }
    return this._parseParametersElement(element, fhirVersion);
  }

  /**
   * Parse from a pre-parsed XML element
   * @param {XmlElement} element - Parsed element with {name, attributes, children}
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} JSON object
   */
  static fromXmlElement(element, fhirVersion) {
    this._loadResourceClasses();
    return this._parseParametersElement(element, fhirVersion);
  }

  /**
   * Parse Parameters element
   * @param {XmlElement} element - Parsed Parameters XML element
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource} Parameters resource
   * @private
   */
  static _parseParametersElement(element, fhirVersion) {
    /** @type {FhirResource} */
    const json = { resourceType: 'Parameters' };

    for (const child of element.children) {
      if (child.name === 'id') {
        json.id = child.attributes.value;
      } else if (child.name === 'meta') {
        json.meta = this.convertChildElement(child);
      } else if (child.name === 'implicitRules') {
        json.implicitRules = child.attributes.value;
      } else if (child.name === 'language') {
        json.language = child.attributes.value;
      } else if (child.name === 'parameter') {
        if (!json.parameter) {
          json.parameter = [];
        }
        json.parameter.push(this._parseParameter(child, fhirVersion));
      }
    }

    return json;
  }

  /**
   * Parse a parameter element
   * @param {XmlElement} element - Parsed parameter XML element
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirParameterPart} Parsed parameter
   * @private
   */
  static _parseParameter(element, fhirVersion) {
    /** @type {Partial<FhirParameterPart> & FhirElement} */
    const param = {};

    for (const child of element.children) {
      if (child.name === 'name') {
        param.name = child.attributes.value;
      } else if (child.name.startsWith('value')) {
        const { value, primitiveExt } = this._convertChildElementWithExt(child);
        if (value !== null) {
          param[child.name] = value;
        }
        if (primitiveExt !== null) {
          param['_' + child.name] = primitiveExt;
        }
      } else if (child.name === 'resource') {
        const resource = this._parseResourceElement(child, fhirVersion);
        if (resource !== null) {
          param.resource = resource;
        }
      } else if (child.name === 'part') {
        if (!param.part) {
          param.part = [];
        }
        param.part.push(this._parseParameter(child, fhirVersion));
      }
    }

    return /** @type {FhirParameterPart} */ (param);
  }

  /**
   * Parse a resource element
   * @param {XmlElement} element - Parsed resource wrapper element
   * @param {number} fhirVersion - FHIR version
   * @returns {FhirResource | null} Parsed resource
   * @private
   */
  static _parseResourceElement(element, fhirVersion) {
    if (element.children.length > 0) {
      const resourceElement = element.children[0];
      const resourceType = resourceElement.name;

      // Try to use dedicated parser
      switch (resourceType) {
        case 'CodeSystem':
          return CodeSystemXML.fromXmlElement(resourceElement, fhirVersion);
        case 'ValueSet':
          return ValueSetXML.fromXmlElement(resourceElement, fhirVersion);
        case 'ConceptMap':
          return ConceptMapXML.fromXmlElement(resourceElement, fhirVersion);
        case 'OperationOutcome':
          return OperationOutcomeXML.fromXmlElement(resourceElement, fhirVersion);
        case 'Parameters':
          return ParametersXML.fromXmlElement(resourceElement, fhirVersion);
        default:
          // Generic parsing
          return this.convertElementToFhirJson(resourceElement, resourceType);
      }
    }
    return null;
  }
}

module.exports = { ParametersXML };
