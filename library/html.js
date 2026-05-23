// @ts-check

const {validateParameter, validateOptionalParameter} = require("./utilities");
const escape = require('escape-html');

/** @typedef {'Document' | 'Element' | 'Text' | 'Comment' | 'DocType' | 'Instruction'} XhtmlNodeType */
/** @typedef {{children: XhtmlNode[]}} XhtmlParseFrame */

/** @type {{Document: 'Document', Element: 'Element', Text: 'Text', Comment: 'Comment', DocType: 'DocType', Instruction: 'Instruction'}} */
const NodeType = {
  Document: 'Document',
  Element: 'Element',
  Text: 'Text',
  Comment: 'Comment',
  DocType: 'DocType',
  Instruction: 'Instruction'
};

class XhtmlNode {
  /**
   * @param {XhtmlNodeType} nodeType
   * @param {string | null} [name]
   */
  constructor(nodeType, name = null) {
    /** @type {XhtmlNodeType} */
    this.nodeType = nodeType;
    /** @type {string | null} */
    this.name = name;
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {XhtmlNode[]} */
    this.childNodes = [];
    /** @type {string | null} */
    this.content = null; // for text nodes
    this.inPara = false;
    this.inLink = false;
    this.pretty = true;
    /** @type {string | undefined} */
    this.lastWord = undefined;
    /** @type {XhtmlNode[] | undefined} */
    this.commaItems = undefined;
    this.commaFirst = true;
    /** @type {Map<string, XhtmlNode> | null} */
    this.namedParams = null;
    /** @type {Map<string, string> | null} */
    this.namedParamValues = null;
  }

  // Attribute methods
  /**
   * @param {string} name
   * @param {unknown} value
   * @returns {XhtmlNode}
   */
  setAttribute(name, value) {
    if (value != null) {
      this.attributes.set(name, String(value));
    }
    return this;
  }

  /**
   * @param {string} name
   * @param {unknown} value
   * @returns {XhtmlNode}
   */
  attribute(name, value) {
    return this.setAttribute(name, value);
  }

  /**
   * @param {string} name
   * @param {unknown} value
   * @returns {XhtmlNode}
   */
  attr(name, value) {
    return this.setAttribute(name, value);
  }

  /**
   * @param {string} name
   * @returns {string | null}
   */
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  hasAttribute(name) {
    return this.attributes.has(name);
  }

  /**
   * @param {string} name
   * @returns {XhtmlNode}
   */
  removeAttribute(name) {
    this.attributes.delete(name);
    return this;
  }

  // Class helpers
  /**
   * @param {string | null | undefined} className
   * @returns {XhtmlNode}
   */
  clss(className) {
    if (className) {
      const existing = this.attributes.get('class');
      if (existing) {
        this.attributes.set('class', existing + ' ' + className);
      } else {
        this.attributes.set('class', className);
      }
    }
    return this;
  }

  /**
   * @param {string | null | undefined} style
   * @returns {XhtmlNode}
   */
  style(style) {
    if (style) {
      this.attributes.set('style', style);
    }
    return this;
  }

  /**
   * @param {string | null | undefined} id
   * @returns {XhtmlNode}
   */
  id(id) {
    if (id) {
      this.attributes.set('id', id);
    }
    return this;
  }

  /**
   * @param {string | null | undefined} title
   * @returns {XhtmlNode}
   */
  title(title) {
    if (title) {
      this.attributes.set('title', title);
    }
    return this;
  }

  // Child node management
  /**
   * @param {string | null} name
   * @returns {XhtmlNode}
   */
  #makeTag(name) {
    const node = new XhtmlNode(NodeType.Element, name);
    const tagName = name || '';
    if (this.inPara || tagName === 'p') {
      node.inPara = true;
    }
    if (this.inLink || tagName === 'a') {
      node.inLink = true;
    }
    const inlineElements = ['b', 'big', 'i', 'small', 'tt', 'abbr', 'acronym', 'cite', 'code',
      'dfn', 'em', 'kbd', 'strong', 'samp', 'var', 'a', 'bdo', 'br', 'img', 'map', 'object',
      'q', 'script', 'span', 'sub', 'sup', 'button', 'input', 'label', 'select', 'textarea'];
    if (inlineElements.includes(tagName)) {
      node.pretty = false;
    }
    return node;
  }

  /**
   * @param {string | number} nameOrIndex
   * @param {string | null} [name]
   * @returns {XhtmlNode}
   */
  addTag(nameOrIndex, name = null) {
    if (typeof nameOrIndex === 'number') {
      const node = this.#makeTag(name);
      this.childNodes.splice(nameOrIndex, 0, node);
      return node;
    } else {
      const node = this.#makeTag(nameOrIndex);
      this.childNodes.push(node);
      return node;
    }
  }

  /**
   * @param {unknown} content
   * @returns {XhtmlNode | null}
   */
  addText(content) {
    if (content != null) {
      const node = new XhtmlNode(NodeType.Text);
      node.content = String(content);
      this.childNodes.push(node);
      return node;
    }
    return null;
  }

  /**
   * @param {string | null | undefined} content
   * @returns {XhtmlNode | null}
   */
  addComment(content) {
    if (content != null) {
      const node = new XhtmlNode(NodeType.Comment);
      node.content = content;
      this.childNodes.push(node);
      return node;
    }
    return null;
  }

  /**
   * @param {Iterable<XhtmlNode> | null | undefined} nodes
   * @returns {XhtmlNode}
   */
  addChildren(nodes) {
    if (nodes) {
      for (const node of nodes) {
        this.childNodes.push(node);
      }
    }
    return this;
  }

  /**
   * @param {XhtmlNode | null | undefined} node
   * @returns {XhtmlNode}
   */
  addChild(node) {
    if (node) {
      this.childNodes.push(node);
    }
    return this;
  }

  /**
   * @returns {XhtmlNode}
   */
  clear() {
    this.childNodes = [];
    return this;
  }

  /**
   * @param {XhtmlNode} node
   * @returns {number}
   */
  indexOf(node) {
    return this.childNodes.indexOf(node);
  }

  /**
   * @returns {boolean}
   */
  hasChildren() {
    return this.childNodes.length > 0;
  }

  /**
   * @returns {XhtmlNode | null}
   */
  getFirstElement() {
    for (const child of this.childNodes) {
      if (child.nodeType === NodeType.Element) {
        return child;
      }
    }
    return null;
  }

  // Text content helpers
  /**
   * @param {unknown} content
   * @returns {XhtmlNode | null}
   */
  tx(content) {
    return this.addText(content);
  }

  /**
   * @param {unknown} content
   * @returns {XhtmlNode}
   */
  txN(content) {
    this.addText(content);
    return this;
  }

  /**
   * @param {unknown} content
   * @returns {XhtmlNode}
   */
  stx(content) {
    if (content) {
      this.addText(' ' + content);
    }
    return this;
  }

  // Fluent element creation methods
  /**
   * @param {number} level
   * @param {string | null} [id]
   * @returns {XhtmlNode}
   */
  h(level, id = null) {
    if (level < 1 || level > 6) {
      throw new Error('Illegal Header level ' + level);
    }
    const node = this.addTag('h' + level);
    if (id) {
      node.setAttribute('id', id);
    }
    return node;
  }

  h1() { return this.addTag('h1'); }
  h2() { return this.addTag('h2'); }
  h3() { return this.addTag('h3'); }
  h4() { return this.addTag('h4'); }
  h5() { return this.addTag('h5'); }
  h6() { return this.addTag('h6'); }

  /**
   * @param {string | null} [style]
   * @returns {XhtmlNode}
   */
  div(style = null) {
    const node = this.addTag('div');
    if (style) {
      node.setAttribute('style', style);
    }
    return node;
  }

  /**
   * @param {string | null} [style]
   * @param {string | null} [title]
   * @returns {XhtmlNode}
   */
  span(style = null, title = null) {
    const node = this.addTag('span');
    if (style) {
      node.setAttribute('style', style);
    }
    if (title) {
      node.setAttribute('title', title);
    }
    return node;
  }

  /**
   * @param {string | null | undefined} className
   * @returns {XhtmlNode}
   */
  spanClss(className) {
    const node = this.addTag('span');
    if (className) {
      node.setAttribute('class', className);
    }
    return node;
  }

  para() { return this.addTag('p'); }
  p() { return this.addTag('p'); }

  /**
   * @param {string | null} [clss]
   * @returns {XhtmlNode}
   */
  pre(clss = null) {
    const node = this.addTag('pre');
    if (clss) {
      node.setAttribute('class', clss);
    }
    return node;
  }

  blockquote() { return this.addTag('blockquote'); }

  // Lists
  ul() { return this.addTag('ul'); }
  ol() { return this.addTag('ol'); }
  li() { return this.addTag('li'); }

  // Tables
  /**
   * @param {string | null} [clss]
   * @param {boolean} [forPresentation]
   * @returns {XhtmlNode}
   */
  table(clss = null, forPresentation = false) {
    const node = this.addTag('table');
    if (clss) {
      node.clss(clss);
    }
    if (forPresentation) {
      node.clss('presentation');
    }
    return node;
  }

  /**
   * @param {XhtmlNode | null} [afterRow]
   * @returns {XhtmlNode}
   */
  tr(afterRow = null) {
    if (afterRow) {
      const index = this.indexOf(afterRow);
      return this.addTag(index + 1, 'tr');
    }
    return this.addTag('tr');
  }

  /**
   * @param {number | null} [index]
   * @returns {XhtmlNode}
   */
  th(index = null) {
    if (index !== null) {
      return this.addTag(index, 'th');
    }
    return this.addTag('th');
  }

  /**
   * @param {string | null} [clss]
   * @returns {XhtmlNode}
   */
  td(clss = null) {
    const node = this.addTag('td');
    if (clss) {
      node.setAttribute('class', clss);
    }
    return node;
  }

  thead() { return this.addTag('thead'); }
  tbody() { return this.addTag('tbody'); }
  tfoot() { return this.addTag('tfoot'); }

  // Inline elements
  b() { return this.addTag('b'); }
  i() { return this.addTag('i'); }
  em() { return this.addTag('em'); }
  strong() { return this.addTag('strong'); }
  small() { return this.addTag('small'); }
  sub() { return this.addTag('sub'); }
  sup() { return this.addTag('sup'); }

  /**
   * @param {unknown} [text]
   * @returns {XhtmlNode}
   */
  code(text = null) {
    const node = this.addTag('code');
    if (text) {
      node.tx(text);
    }
    return node;
  }

  /**
   * @param {unknown} preText
   * @param {unknown} text
   * @param {unknown} postText
   * @returns {XhtmlNode}
   */
  codeWithText(preText, text, postText) {
    this.tx(preText);
    const code = this.addTag('code');
    code.tx(text);
    this.tx(postText);
    return this;
  }

  // Line breaks
  br() {
    this.addTag('br');
    return this;
  }

  hr() {
    this.addTag('hr');
    return this;
  }

  // Links
  /**
   * @param {string | null | undefined} href
   * @param {string | null} [title]
   * @returns {XhtmlNode}
   */
  ah(href, title = null) {
    if (href == null) {
      return this.addTag('span');
    }
    const node = this.addTag('a').setAttribute('href', href);
    if (title) {
      node.setAttribute('title', title);
    }
    return node;
  }

  /**
   * @param {unknown} preText
   * @param {string} href
   * @param {string | null | undefined} title
   * @param {unknown} text
   * @param {unknown} postText
   * @returns {XhtmlNode}
   */
  ahWithText(preText, href, title, text, postText) {
    this.tx(preText);
    const a = this.addTag('a').setAttribute('href', href);
    if (title) {
      a.setAttribute('title', title);
    }
    a.tx(text);
    this.tx(postText);
    return a;
  }

  /**
   * @param {string | null | undefined} href
   * @param {string | null} [title]
   * @returns {XhtmlNode}
   */
  ahOrCode(href, title = null) {
    if (href != null) {
      return this.ah(href, title);
    } else if (title != null) {
      return this.code().setAttribute('title', title);
    } else {
      return this.code();
    }
  }

  /**
   * @param {string} name
   * @param {unknown} [text]
   * @returns {XhtmlNode}
   */
  an(name, text = ' ') {
    const a = this.addTag('a').setAttribute('name', name);
    a.tx(text);
    return a;
  }

  // Images
  /**
   * @param {string} src
   * @param {string | null | undefined} alt
   * @param {string | null} [title]
   * @returns {XhtmlNode}
   */
  img(src, alt, title = null) {
    const node = this.addTag('img')
      .setAttribute('src', src)
      .setAttribute('alt', alt || '.');
    if (title) {
      node.setAttribute('title', title);
    }
    return node;
  }

  /**
   * @param {string} src
   * @param {string} alt
   * @returns {XhtmlNode}
   */
  imgT(src, alt) {
    return this.img(src, alt, alt);
  }

  // Forms
  /**
   * @param {string} type
   * @param {string} name
   * @param {unknown} [value]
   * @returns {XhtmlNode}
   */
  input(type, name, value = null) {
    const node = this.addTag('input')
      .setAttribute('type', type)
      .setAttribute('name', name);
    if (value != null) {
      node.setAttribute('value', value);
    }
    return node;
  }

  /**
   * @param {unknown} text
   * @returns {XhtmlNode}
   */
  button(text) {
    const node = this.addTag('button');
    node.tx(text);
    return node;
  }

  /**
   * @param {string} name
   * @returns {XhtmlNode}
   */
  select(name) {
    return this.addTag('select').setAttribute('name', name);
  }

  /**
   * @param {string} value
   * @param {unknown} text
   * @param {boolean} [selected]
   * @returns {XhtmlNode}
   */
  option(value, text, selected = false) {
    const node = this.addTag('option').setAttribute('value', value);
    node.tx(text);
    if (selected) {
      node.setAttribute('selected', 'selected');
    }
    return node;
  }

  /**
   * @param {string} name
   * @param {number | null} [rows]
   * @param {number | null} [cols]
   * @returns {XhtmlNode}
   */
  textarea(name, rows = null, cols = null) {
    const node = this.addTag('textarea').setAttribute('name', name);
    if (rows != null) {
      node.setAttribute('rows', String(rows));
    }
    if (cols != null) {
      node.setAttribute('cols', String(cols));
    }
    return node;
  }

  /**
   * @param {string} forId
   * @returns {XhtmlNode}
   */
  label(forId) {
    return this.addTag('label').setAttribute('for', forId);
  }

  /**
   * @param {number | string} width
   * @returns {XhtmlNode}
   */
  colspan(width) {
    return this.attr("colspan", String(width));
  }

  // Conditional
  /**
   * @param {boolean} test
   * @returns {XhtmlNode}
   */
  iff(test) {
    if (test) {
      return this;
    } else {
      return new XhtmlNode(NodeType.Element, 'span'); // disconnected node
    }
  }

  // Separator helper
  /**
   * @param {unknown} text
   * @returns {XhtmlNode}
   */
  sep(text) {
    if (this.hasChildren()) {
      this.addText(text);
    }
    return this;
  }

  // Rendering
  /**
   * @returns {XhtmlNode}
   */
  notPretty() {
    this.pretty = false;
    return this;
  }

  /**
   * @returns {string}
   */
  allText() {
    let result = '';
    for (const child of this.childNodes) {
      if (child.nodeType === NodeType.Text) {
        result += child.content || '';
      } else if (child.nodeType === NodeType.Element) {
        result += child.allText();
      }
    }
    return result;
  }

  /**
   * @param {string} lastWord
   */
  startCommaList(lastWord) {
    validateParameter(lastWord, 'lastWord', String);
    if (this.lastWord) {
      throw new Error('Unclosed list');
    }
    this.lastWord = lastWord;
    this.commaItems = [];
    this.commaFirst = true;
  }

  /**
   * @param {string} text
   * @param {string | null | undefined} link
   */
  commaItem(text, link) {
    validateParameter(text, 'text', String);
    validateOptionalParameter(link, 'link', String);

    if (!this.commaFirst) {
      const comma = this.tx(", ");
      if (comma) {
        this.commaItems?.push(comma);
      }
    }
    this.commaFirst = false;
    if (link) {
      this.ah(link).tx(text);
    } else {
      this.tx(text);
    }
  }

  /**
   * @returns {void}
   */
  stopCommaList() {
    if (this.commaItems && this.commaItems.length > 0) {
      this.commaItems[this.commaItems.length-1].content = " "+this.lastWord+" ";
    }
    this.lastWord = undefined;
    this.commaItems = undefined;
  }

// Script execution methods

  /**
   * @param {string} name
   */
  startScript(name) {
    if (this.namedParams) {
      throw new Error(`Sequence Error - script is already open @ ${name}`);
    }
    this.namedParams = new Map();
    this.namedParamValues = new Map();
  }

  /**
   * @param {string} name
   * @returns {XhtmlNode}
   */
  param(name) {
    if (!this.namedParams) {
      throw new Error('Sequence Error - script is not already open');
    }
    // Create a detached node that will be inserted when the script executes
    const node = new XhtmlNode(NodeType.Element, 'p');
    node.inPara = true;
    this.namedParams.set(name, node);
    return node;
  }

  /**
   * @param {string} name
   * @param {unknown} value
   */
  paramValue(name, value) {
    if (!this.namedParamValues) {
      throw new Error('Sequence Error - script is not already open');
    }
    this.namedParamValues.set(name, String(value));
  }

  /**
   * @param {string} structure
   */
  execScript(structure) {
    const scriptNodes = this.#parseFragment(`<div>${structure}</div>`);
    this.#parseNodes(scriptNodes, this.childNodes);
  }

  /**
   * @param {XhtmlNode[]} source
   * @param {XhtmlNode[]} dest
   */
  #parseNodes(source, dest) {
    const namedParams = this.namedParams;
    const namedParamValues = this.namedParamValues;
    if (!namedParams || !namedParamValues) {
      throw new Error('Sequence Error - script is not already open');
    }
    for (const n of source) {
      if (n.name === 'param') {
        const paramName = n.getAttribute('name');
        const node = paramName ? namedParams.get(paramName) : null;
        if (node) {
          this.#parseNodes(node.childNodes, dest);
        }
      } else if (n.name === 'if') {
        const test = n.getAttribute('test');
        if (this.#passesTest(test)) {
          this.#parseNodes(n.childNodes, dest);
        }
      } else {
        dest.push(n);
      }
    }
  }

  /**
   * @param {string | null} test
   * @returns {boolean}
   */
  #passesTest(test) {
    if (!test || !this.namedParamValues) {
      return false;
    }
    const parts = test.trim().split(/\s+/);
    if (parts.length !== 3) {
      return false;
    }

    const [paramName, operator, compareValue] = parts;

    if (!this.namedParamValues.has(paramName)) {
      return false;
    }

    const paramValue = this.namedParamValues.get(paramName);
    if (paramValue === undefined) {
      return false;
    }

    switch (operator) {
      case '=':
        return compareValue.toLowerCase() === paramValue.toLowerCase();
      case '!=':
        return compareValue.toLowerCase() !== paramValue.toLowerCase();
      case '<':
        return this.#isInteger(paramValue) && this.#isInteger(compareValue) &&
            parseInt(paramValue, 10) < parseInt(compareValue, 10);
      case '<=':
        return this.#isInteger(paramValue) && this.#isInteger(compareValue) &&
            parseInt(paramValue, 10) <= parseInt(compareValue, 10);
      case '>':
        return this.#isInteger(paramValue) && this.#isInteger(compareValue) &&
            parseInt(paramValue, 10) > parseInt(compareValue, 10);
      case '>=':
        return this.#isInteger(paramValue) && this.#isInteger(compareValue) &&
            parseInt(paramValue, 10) >= parseInt(compareValue, 10);
      default:
        return false;
    }
  }

  /**
   * @param {string} str
   * @returns {boolean}
   */
  #isInteger(str) {
    return /^-?\d+$/.test(str);
  }

  /**
   * @param {string} html
   * @returns {XhtmlNode[]}
   */
  #parseFragment(html) {
    /** @type {XhtmlNode[]} */
    const nodes = [];
    /** @type {XhtmlParseFrame[]} */
    const stack = [{ children: nodes }];
    let current = stack[0];
    let i = 0;

    while (i < html.length) {
      if (html[i] === '<') {
        // Check for closing tag
        if (html[i + 1] === '/') {
          const endTag = html.indexOf('>', i);
          stack.pop();
          current = stack[stack.length - 1];
          i = endTag + 1;
          continue;
        }

        // Find tag end
        const tagEnd = html.indexOf('>', i);
        const tagContent = html.substring(i + 1, tagEnd);
        const selfClosing = tagContent.endsWith('/');
        const cleanContent = selfClosing ? tagContent.slice(0, -1).trim() : tagContent.trim();

        // Parse tag name and attributes
        const spaceIndex = cleanContent.indexOf(' ');
        const tagName = spaceIndex === -1 ? cleanContent : cleanContent.substring(0, spaceIndex);
        const attrString = spaceIndex === -1 ? '' : cleanContent.substring(spaceIndex + 1);

        const node = new XhtmlNode(NodeType.Element, tagName);

        // Parse attributes
        const attrRegex = /(\w+)=["']([^"']*)["']/g;
        let match;
        while ((match = attrRegex.exec(attrString)) !== null) {
          node.setAttribute(match[1], match[2]);
        }

        current.children.push(node);

        if (!selfClosing) {
          stack.push({ children: node.childNodes });
          current = stack[stack.length - 1];
        }

        i = tagEnd + 1;
      } else {
        // Text content
        const nextTag = html.indexOf('<', i);
        const textContent = nextTag === -1 ? html.substring(i) : html.substring(i, nextTag);

        if (textContent.trim()) {
          const textNode = new XhtmlNode(NodeType.Text);
          textNode.content = textContent;
          current.children.push(textNode);
        }

        i = nextTag === -1 ? html.length : nextTag;
      }
    }

    // Return children of the wrapper div
    return nodes.length > 0 && nodes[0].childNodes ? nodes[0].childNodes : nodes;
  }

  /**
   * @returns {void}
   */
  closeScript() {
    if (!this.namedParams) {
      throw new Error('Sequence Error - script is not already open');
    }
    this.namedParams = null;
    this.namedParamValues = null;
  }

  /**
   * Process markdown content and add it as HTML child nodes
   * @param {string} md - Markdown content to process
   * @returns {XhtmlNode} - this node for chaining
   */
  markdown(md) {
    if (!md) {
      return this;
    }

    const commonmark = /** @type {any} */ (require('commonmark'));
    const reader = new commonmark.Parser();
    const writer = new commonmark.HtmlRenderer({ safe: true });

    const parsed = reader.parse(md);
    const html = writer.render(parsed);

    // Parse the HTML and add as children
    const nodes = this.#parseFragment(`<div>${html}</div>`);
    for (const node of nodes) {
      this.childNodes.push(node);
    }

    return this;
  }

  /**
   * Process markdown content and add it inline (strips block-level wrapper)
   * Useful when you want to add markdown content within a paragraph
   * @param {string} md - Markdown content to process
   * @returns {XhtmlNode} - this node for chaining
   */
  markdownInline(md) {
    if (!md) {
      return this;
    }

    const commonmark = /** @type {any} */ (require('commonmark'));
    const reader = new commonmark.Parser();
    const writer = new commonmark.HtmlRenderer({ safe: true });

    const parsed = reader.parse(md);
    const html = writer.render(parsed);

    // Strip outer <p> tags if present for inline usage
    const trimmedHtml = html.trim().replace(/^<p>/, '').replace(/<\/p>\s*$/, '');

    // Parse the HTML and add as children
    const nodes = this.#parseFragment(`<span>${trimmedHtml}</span>`);
    for (const node of nodes) {
      // Add children of the wrapper span, not the span itself
      for (const child of node.childNodes) {
        this.childNodes.push(child);
      }
    }

    return this;
  }

  /**
   * @param {number} [indent]
   * @param {boolean} [pretty]
   * @returns {string}
   */
  render(indent = 0, pretty = true) {
    const effectivePretty = pretty && this.pretty;
    const indentStr = effectivePretty ? '  '.repeat(indent) : '';
    const newline = effectivePretty ? '\n' : '';

    if (this.nodeType === NodeType.Text) {
      return escape(this.content || '');
    }

    if (this.nodeType === NodeType.Comment) {
      return `${indentStr}<!-- ${this.content || ''} -->${newline}`;
    }

    if (this.nodeType === NodeType.Element) {
      const voidElements = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr'];
      const elementName = this.name || '';
      const isVoid = voidElements.includes(elementName);

      let attrs = '';
      for (const [key, value] of this.attributes) {
        attrs += ` ${key}="${this.#escapeAttr(value)}"`;
      }

      if (isVoid) {
        return `${indentStr}<${elementName}${attrs}/>${newline}`;
      }

      if (this.childNodes.length === 0) {
        return `${indentStr}<${elementName}${attrs}></${elementName}>${newline}`;
      }

      // Check if all children are text/inline
      const allInline = this.childNodes.every(c =>
        c.nodeType === NodeType.Text || !c.pretty
      );

      if (allInline || !effectivePretty) {
        let content = '';
        for (const child of this.childNodes) {
          content += child.render(0, false);
        }
        return `${indentStr}<${elementName}${attrs}>${content}</${elementName}>${newline}`;
      } else {
        let content = '';
        for (const child of this.childNodes) {
          content += child.render(indent + 1, true);
        }
        return `${indentStr}<${elementName}${attrs}>${newline}${content}${indentStr}</${elementName}>${newline}`;
      }
    }

    return '';
  }

  /**
   * @param {unknown} text
   * @returns {string}
   */
  #escapeAttr(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  toString() {
    return this.render(0, true);
  }

  toStringPretty() {
    return this.render(0, true);
  }

  toStringCompact() {
    return this.render(0, false);
  }
}

// Factory functions
/**
 * @param {string | null} [style]
 * @returns {XhtmlNode}
 */
function div(style = null) {
  const node = new XhtmlNode(NodeType.Element, 'div');
  node.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  if (style) {
    node.setAttribute('style', style);
  }
  return node;
}

/**
 * @param {string} name
 * @returns {XhtmlNode}
 */
function element(name) {
  return new XhtmlNode(NodeType.Element, name);
}

/**
 * @param {unknown} content
 * @returns {XhtmlNode}
 */
function text(content) {
  const node = new XhtmlNode(NodeType.Text);
  node.content = String(content);
  return node;
}

/**
 * @param {string} content
 * @returns {XhtmlNode}
 */
function comment(content) {
  const node = new XhtmlNode(NodeType.Comment);
  node.content = content;
  return node;
}

module.exports = {
  XhtmlNode,
  NodeType,
  div,
  element,
  text,
  comment
};
