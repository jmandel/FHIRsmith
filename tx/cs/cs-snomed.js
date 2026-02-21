const { CodeSystemProvider, CodeSystemContentMode, Designation, CodeSystemFactoryProvider} = require('./cs-api');
const {
  SnomedStrings, SnomedWords, SnomedStems, SnomedReferences,
  SnomedDescriptions, SnomedDescriptionIndex, SnomedConceptList,
  SnomedRelationshipList, SnomedReferenceSetMembers, SnomedReferenceSetIndex,
  SnomedFileReader
} = require('../sct/structures');
const {
  SnomedExpressionServices, SnomedExpression, SnomedConcept,
  SnomedExpressionParser, NO_REFERENCE, SnomedServicesRenderOption
} = require('../sct/expressions');

// Context kinds matching Pascal enum
const SnomedProviderContextKind = {
  CODE: 0,
  EXPRESSION: 1
};

/**
 * SNOMED Expression Context - represents either a simple concept or complex expression
 */
class SnomedExpressionContext {
  constructor(source = '', expression = null) {
    this.source = source;
    this.expression = expression;
  }

  static fromReference(reference) {
    const expression = new SnomedExpression();
    expression.concepts.push(new SnomedConcept(reference));
    return new SnomedExpressionContext('', expression);
  }

  static fromCode(code, reference) {
    const expression = new SnomedExpression();
    const concept = new SnomedConcept(reference);
    concept.code = code;
    expression.concepts.push(concept);
    return new SnomedExpressionContext(code, expression);
  }

  static fromExpression(source, expression) {
    return new SnomedExpressionContext(source, expression);
  }

  isComplex() {
    return this.expression && this.expression.isComplex();
  }

  isSimple() {
    return this.expression && this.expression.isSimple();
  }

  getReference() {
    return this.expression && this.expression.concepts.length > 0
      ? this.expression.concepts[0].reference
      : NO_REFERENCE;
  }

  getCode() {
    if (this.source) return this.source;
    return this.expression && this.expression.concepts.length > 0
      ? this.expression.concepts[0].code
      : '';
  }
}

/**
 * Filter context for SNOMED filtering operations
 */
class SnomedFilterContext {
  constructor() {
    this.ndx = 0;
    this.cursor = 0;
    this.matches = [];
    this.members = [];
    this.descendants = [];
  }
}

class SnomedPrep {
  constructor() {
    this.filters = [];
  }
}

/**
 * Core SNOMED services providing access to structures and expression processing
 */
class SnomedServices {
  constructor(sharedData) {
    // Core data structures
    this.strings = new SnomedStrings(sharedData.strings);
    this.words = new SnomedWords(sharedData.words);
    this.stems = new SnomedStems(sharedData.stems);
    this.refs = new SnomedReferences(sharedData.refs);
    this.descriptions = new SnomedDescriptions(sharedData.desc);
    this.descriptionIndex = new SnomedDescriptionIndex(sharedData.descRef);
    this.concepts = new SnomedConceptList(sharedData.concept);
    this.relationships = new SnomedRelationshipList(sharedData.rel);
    this.refSetIndex = new SnomedReferenceSetIndex(sharedData.refSetIndex, sharedData.hasLangs);
    this.refSetMembers = new SnomedReferenceSetMembers(sharedData.refSetMembers);

    // Metadata
    this.versionUri = sharedData.versionUri;
    this.versionDate = sharedData.versionDate;
    this.edition = sharedData.edition;
    this.version = sharedData.version;
    this.totalCount = this.concepts.count();

    // Indexes and roots
    this.isAIndex = sharedData.isAIndex;
    this.activeRoots = sharedData.activeRoots;
    this.inactiveRoots = sharedData.inactiveRoots;
    this.defaultLanguage = sharedData.defaultLanguage;
    this.isTesting = sharedData.isTesting;

    // Expression services
    this.expressionServices = new SnomedExpressionServices({
      strings: this.strings,
      words: this.words,
      stems: this.stems,
      refs: this.refs,
      descriptions: this.descriptions,
      descriptionIndex: this.descriptionIndex,
      concepts: this.concepts,
      relationships: this.relationships,
      refSetMembers: this.refSetMembers,
      refSetIndex: this.refSetIndex
    }, this.isAIndex);

  }

  close() {
    // Cleanup if needed
  }

  getSystemUri() {
    return 'http://snomed.info/sct';
  }

  getVersion() {
    return this.versionUri;
  }

  getDescription() {
    return `SNOMED CT ${getEditionName(this.edition)}`;
  }

  name() {
    return `SCT ${getEditionCode(this.edition)}`;
  }

  stringToIdOrZero(str) {
    try {
      if (!str) return 0n;
      return BigInt(str);
    } catch {
      return 0n;
    }
  }

  stringToId(str) {
    return BigInt(str);
  }

  getConceptId(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      return concept.identity.toString();
    } catch (error) {
      return reference.toString();
    }
  }

  conceptExists(conceptId) {
    const id = this.stringToIdOrZero(conceptId);
    if (id === 0n) return false;

    const result = this.concepts.findConcept(id);
    return result.found;
  }

  isActive(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      // Check status flags - active concepts typically have status 0
      return (concept.flags & 0x0F) === 0;
    } catch (error) {
      return false;
    }
  }

  isPrimitive(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      // Check primitive flag
      return (concept.flags & 0x10) !== 0;
    } catch (error) {
      return true; // Assume primitive if can't read
    }
  }

  subsumes(parentRef, childRef) {
    if (parentRef === childRef) {
      return true;
    }

    try {
      // Get the closure (all descendants) for parent concept
      const closureRef = this.concepts.getAllDesc(parentRef);

      if (closureRef === 0 || closureRef === 0xFFFFFFFF) {
        return false;
      }

      const descendants = this.refs.getReferences(closureRef);
      return descendants && descendants.includes(childRef);
    } catch (error) {
      return false;
    }
  }

  getDisplayName(reference = 0) {
    try {
      const concept = this.concepts.getConcept(reference);
      const descriptionsRef = concept.descriptions;

      if (descriptionsRef === 0) {
        return '';
      }

      const descriptionIndices = this.refs.getReferences(descriptionsRef);

      // Look for preferred term, then any active description
      for (const descIndex of descriptionIndices) {
        const description = this.descriptions.getDescription(descIndex);
        if (description.active) {
          const term = this.strings.getEntry(description.iDesc);
          return term.trim();
        }
      }

      return '';
    } catch (error) {
      return '';
    }
  }

  getConceptDescendants(reference) {
    try {
      const allDescRef = this.concepts.getAllDesc(reference);
      if (allDescRef === 0 || allDescRef === 0xFFFFFFFF) {
        return [];
      }
      return this.refs.getReferences(allDescRef) || [];
    } catch (error) {
      return [];
    }
  }

  getConceptChildren(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      const inboundsRef = concept.inbounds;

      if (inboundsRef === 0) return [];

      const inbounds = this.refs.getReferences(inboundsRef);
      const children = [];

      for (const relIndex of inbounds) {
        const rel = this.relationships.getRelationship(relIndex);
        if (rel.active && rel.relType === this.isAIndex && rel.group === 0) {
          children.push(rel.source);
        }
      }

      return children;
    } catch (error) {
      return [];
    }
  }

  getConceptParents(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      const parentsRef = concept.parents;

      if (parentsRef === 0) return [];

      return this.refs.getReferences(parentsRef) || [];
    } catch (error) {
      return [];
    }
  }

  getConceptRefSet(conceptIndex, byName = false) {
    for (let i = 0; i < this.refSetIndex.count(); i++) {
      const refSet = this.refSetIndex.getReferenceSet(i);
      if (refSet.definition === conceptIndex) {
        return byName ? refSet.membersByName : refSet.membersByRef;
      }
    }
    return 0;
  }

  // Filter support methods
  filterEquals(id) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    result.descendants = [conceptResult.index];
    return result;
  }

  filterIsA(id, includeBase = true) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    const descendants = this.getConceptDescendants(conceptResult.index);

    if (includeBase) {
      result.descendants = [conceptResult.index, ...descendants];
    } else {
      result.descendants = descendants;
    }

    return result;
  }

  filterIn(id) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    const refSetIndex = this.getConceptRefSet(conceptResult.index, false);
    if (refSetIndex === 0) {
      throw new Error(`The SNOMED CT Concept ${id} is not a reference set`);
    }

    result.members = this.refSetMembers.getMembers(refSetIndex) || [];
    return result;
  }

  searchFilter(searchText, includeInactive = false, exactMatch = false) {
    const result = new SnomedFilterContext();

    // Simplified search - in full implementation would use stemming and word indexes
    const searchTerms = searchText.toLowerCase().split(/\s+/);
    const matches = [];

    // Search through all concepts
    for (let i = 0; i < this.concepts.count(); i++) {
      const conceptIndex = i * this.concepts.constructor.CONCEPT_SIZE;

      try {
        const concept = this.concepts.getConcept(conceptIndex);
        if (!includeInactive && !this.isActive(conceptIndex)) {
          continue;
        }

        const descriptionsRef = concept.descriptions;
        if (descriptionsRef === 0) continue;

        const descriptionIndices = this.refs.getReferences(descriptionsRef);
        let matchFound = false;
        let priority = 0;

        for (const descIndex of descriptionIndices) {
          const description = this.descriptions.getDescription(descIndex);
          if (description.active) {
            const term = this.strings.getEntry(description.iDesc).toLowerCase();

            if (exactMatch) {
              // All search terms must be present
              matchFound = searchTerms.every(searchTerm => term.includes(searchTerm));
            } else {
              // Any search term can match
              matchFound = searchTerms.some(searchTerm => term.includes(searchTerm));
            }

            if (matchFound) {
              // Calculate priority based on match quality
              if (term === searchText.toLowerCase()) {
                priority = 100; // Exact match
              } else if (term.startsWith(searchText.toLowerCase())) {
                priority = 50; // Prefix match
              } else {
                priority = 10; // Contains match
              }
              break;
            }
          }
        }

        if (matchFound) {
          matches.push({
            index: conceptIndex,
            term: concept.identity,
            priority: priority
          });
        }
      } catch (error) {
        // Skip problematic concepts
        continue;
      }
    }

    // Sort by priority (descending)
    matches.sort((a, b) => b.priority - a.priority);

    result.matches = matches;
    return result;
  }
}

/**
 * SNOMED CT Code System Provider
 */
class SnomedProvider extends CodeSystemProvider {
  constructor(opContext, supplements, snomedServices) {
    super(opContext, supplements);
    this.sct = snomedServices;
  }

  // Metadata methods
  system() {
    return this.sct.getSystemUri();
  }

  version() {
    return this.sct.getVersion();
  }


  /**
   * @param {string} checkVersion - first version
   * @param {string} actualVersion - second version
   * @returns {boolean} True if actualVersion is more detailed than checkVersion (for SCT)
   */
  versionIsMoreDetailed(checkVersion, actualVersion) {
    return actualVersion && actualVersion.startsWith(checkVersion);
  }

  description() {
    return this.sct.getDescription();
  }

  totalCount() {
    return this.sct.totalCount;
  }

  contentMode() {
    return CodeSystemContentMode.Complete;
  }

  hasParents() {
    return true;
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);

    // Check supplements first
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }

    // SNOMED has displays for English and other languages
    return langs.isEnglishOrNothing();
  }

  // Core concept methods
  async code(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (!ctxt) return null;

    if (ctxt.isComplex()) {
      return this.sct.expressionServices.renderExpression(ctxt.expression, SnomedServicesRenderOption.Minimal);
    } else {
      return ctxt.getCode() || this.sct.getConceptId(ctxt.getReference());
    }
  }

  async display(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (!ctxt) return null;

    // Check supplements first
    let disp = this._displayFromSupplements(ctxt.getCode());
    if (disp) return disp;

    if (ctxt.isComplex()) {
      return this.sct.expressionServices.displayExpression(ctxt.expression);
    } else {
      return this.sct.getDisplayName(ctxt.getReference(), this.sct.defaultLanguage);
    }
  }

  async definition(context) {
    await this.#ensureContext(context);
    return null; // SNOMED doesn't provide definitions in this sense
  }

  async isAbstract(context) {
    await this.#ensureContext(context);
    return false; // SNOMED concepts are not abstract
  }

  async isInactive(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (!ctxt || ctxt.isComplex()) return false;

    return !this.sct.isActive(ctxt.getReference());
  }

  async isDeprecated(context) {
    await this.#ensureContext(context);

    return false; // Handle via status if needed
  }

  async getStatus(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (!ctxt || ctxt.isComplex()) return null;

    return this.sct.isActive(ctxt.getReference()) ? 'active' : 'inactive';
  }

  async designations(context, displays) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt) {


      if (ctxt.isComplex()) {
        // For complex expressions, just add the display
        const display = await this.display(context);
        if (display) {
          displays.addDesignation(true, 'active', new Designation('en-US', null, display));
        }
      } else {
        // Get all designations for the concept
        try {
          const concept = this.sct.concepts.getConcept(ctxt.getReference());
          const descriptionsRef = concept.descriptions;

          if (descriptionsRef !== 0) {
            const descriptionIndices = this.sct.refs.getReferences(descriptionsRef);

            for (const descIndex of descriptionIndices) {
              const description = this.sct.descriptions.getDescription(descIndex);
              const term = this.sct.strings.getEntry(description.iDesc).trim();
              const langCode = this.getLanguageCode(description.lang);
              const kind = this.sct.concepts.getConcept(description.kind);
              const kid = String(kind.identity);
              const kdesc = this.sct.getDisplayName(description.kind);
              let use = { system: 'http://snomed.info/sct', code: kid, display : kdesc};

              displays.addDesignation(false, description.active ? 'active' : 'inactive', langCode, use, term);
            }
          }
        } catch (error) {
          // Add basic designation if we can't read detailed descriptions
          const display = this.sct.getDisplayName(ctxt.getReference());
          if (display) {
            displays.addDesignation(true, 'active','en-US', null, display);
          }
        }

        // Add supplement designations
        this._listSupplementDesignations(ctxt.getCode(), displays);
      }
    }
  }

  getLanguageCode(langIndex) {
    const languageMap = {
      1: 'en',
      2: 'en-GB',
      3: 'es',
      4: 'fr',
      5: 'de'
    };
    return languageMap[langIndex] || 'en';
  }

  // Lookup methods
  async locate(code) {
    

    if (!code) return { context: null, message: 'Empty code' };

    const conceptId = this.sct.stringToIdOrZero(code);

    if (conceptId === 0n) {
      // Try parsing as expression
      try {
        const expression = new SnomedExpressionParser().parse(code);
        this.sct.expressionServices.checkExpression(expression);
        return {
          context: SnomedExpressionContext.fromExpression(code, expression),
          message: null
        };
      } catch (error) {
        return {
          context: null,
          message: `Code ${code} is not a valid SNOMED CT Term, and could not be parsed as an expression (${error.message})`
        };
      }
    } else {
      const result = this.sct.concepts.findConcept(conceptId);
      if (result.found) {
        return {
          context: SnomedExpressionContext.fromCode(code, result.index),
          message: null
        };
      } else {
        return {
          context: null,
          message: undefined
        };
      }
    }
  }

  async locateIsA(code, parent, disallowParent = false) {
    

    const childId = this.sct.stringToIdOrZero(code);
    const parentId = this.sct.stringToIdOrZero(parent);

    if (childId === 0n || parentId === 0n) {
      return { context: null, message: 'Invalid concept ID' };
    }

    const childResult = this.sct.concepts.findConcept(childId);
    const parentResult = this.sct.concepts.findConcept(parentId);

    if (!childResult.found || !parentResult.found) {
      return { context: null, message: 'Concept not found' };
    }

    const subsumes = this.sct.subsumes(parentResult.index, childResult.index);
    const allowedByParent = !disallowParent || (childResult.index !== parentResult.index);

    if (subsumes && allowedByParent) {
      return {
        context: SnomedExpressionContext.fromCode(code, childResult.index),
        message: null
      };
    } else {
      return { context: null, message: 'Concept is not subsumed by parent' };
    }
  }

  // Iterator methods
  async iterator(context) {
    

    if (!context) {
      // Iterate all active root concepts
      return {
        context: null,
        keys: this.sct.activeRoots.slice(),
        current: 0,
        total: this.sct.activeRoots.length
      };
    } else {
      const ctxt = await this.#ensureContext(context);
      if (!ctxt || ctxt.isComplex()) {
        return { context: ctxt, keys: [], current: 0, total: 0 };
      }

      // Get children of this concept
      const children = this.sct.getConceptChildren(ctxt.getReference());
      return {
        context: ctxt,
        keys: children,
        current: 0,
        total: children.length
      };
    }
  }

  async nextContext(iteratorContext) {
    

    if (iteratorContext.current >= iteratorContext.total) {
      return null;
    }

    const key = iteratorContext.keys[iteratorContext.current];
    iteratorContext.current++;

    return SnomedExpressionContext.fromReference(key);
  }

  // Filter support
  async doesFilter(prop, op, value) {
    

    if (prop === 'concept') {
      const id = this.sct.stringToIdOrZero(value);
      if (id !== 0n && ['=', 'is-a', 'descendent-of', 'in'].includes(op)) {
        return this.sct.conceptExists(value);
      }
    }

    return false;
  }

  async getPrepContext() {
    
    return new SnomedPrep(); // Simple filter context
  }

  async filter(filterContext, prop, op, value) {
    

    if (prop === 'concept') {
      const id = this.sct.stringToIdOrZero(value);
      if (id === 0n) {
        throw new Error(`Invalid concept ID: ${value}`);
      }

      switch (op) {
        case '=': {
          filterContext.filters.push(this.sct.filterEquals(id));
          return null;
        }
        case 'is-a': {
          filterContext.filters.push(this.sct.filterIsA(id, true));
          return null;
        }
        case 'descendent-of': {
          filterContext.filters.push(this.sct.filterIsA(id, false));
          return null;
        }
        case 'in': {
          filterContext.filters.push(this.sct.filterIn(id));
          return null;
        }
        default:
          throw new Error(`Unsupported filter operation: ${op}`);
      }
    }

    throw new Error(`Unsupported filter property: ${prop}`);
  }

  async executeFilters(filterContext) {
    
    return filterContext.filters;
  }

  async filterSize(filterContext, set) {
    

    if (set.matches && set.matches.length > 0) {
      return set.matches.length;
    } else if (set.members && set.members.length > 0) {
      return set.members.length;
    } else if (set.descendants && set.descendants.length > 0) {
      return set.descendants.length;
    }

    return 0;
  }

  async filterMore(filterContext, set) {
    
    set.cursor = set.cursor || 0;

    const size = await this.filterSize(filterContext, set);
    return set.cursor < size;
  }

  async filterConcept(filterContext, set) {
    

    const size = await this.filterSize(filterContext, set);
    if (set.cursor >= size) {
      return null;
    }

    let key;
    if (set.matches && set.matches.length > 0) {
      key = set.matches[set.cursor].index;
    } else if (set.members && set.members.length > 0) {
      key = set.members[set.cursor].ref;
    } else if (set.descendants && set.descendants.length > 0) {
      key = set.descendants[set.cursor];
    } else {
      return null;
    }

    set.cursor++;
    return SnomedExpressionContext.fromReference(key);
  }

  async filterLocate(filterContext, set, code) {
    

    const conceptResult = await this.locate(code);
    if (!conceptResult.context) {
      return conceptResult.message;
    }

    const ctxt = conceptResult.context;
    if (ctxt.isComplex()) {
      return 'Complex expressions not supported in filters';
    }

    const reference = ctxt.getReference();
    let found = false;

    if (set.matches && set.matches.length > 0) {
      found = set.matches.some(m => m.index === reference);
    } else if (set.members && set.members.length > 0) {
      found = set.members.some(m => m.ref === reference);
    } else if (set.descendants && set.descendants.length > 0) {
      found = set.descendants.includes(reference);
    }

    if (found) {
      return ctxt;
    } else {
      return `Code ${code} is not in the specified filter`;
    }
  }

  async filterCheck(filterContext, set, concept) {
    

    if (!(concept instanceof SnomedExpressionContext)) {
      return false;
    }

    if (concept.isComplex()) {
      return false;
    }

    const reference = concept.getReference();

    if (set.matches && set.matches.length > 0) {
      return set.matches.some(m => m.index === reference);
    } else if (set.members && set.members.length > 0) {
      return set.members.some(m => m.ref === reference);
    } else if (set.descendants && set.descendants.length > 0) {
      return set.descendants.includes(reference);
    }

    return false;
  }


  // Search filter
  async searchFilter(filterContext, filter, sort) {
    return this.sct.searchFilter(filter, false, sort);
  }

  // Subsumption testing
  async subsumesTest(codeA, codeB) {
    

    try {
      const exprA = new SnomedExpressionParser(this.sct.concepts).parse(codeA);
      const exprB = new SnomedExpressionParser(this.sct.concepts).parse(codeB);

      if (exprA.isSimple() && exprB.isSimple()) {
        const refA = exprA.concepts[0].reference;
        const refB = exprB.concepts[0].reference;

        if (refA === refB) {
          return 'equivalent';
        } else if (this.sct.subsumes(refA, refB)) {
          return 'subsumes';
        } else if (this.sct.subsumes(refB, refA)) {
          return 'subsumed-by';
        } else {
          return 'not-subsumed';
        }
      } else {
        const b1 = this.sct.expressionServices.expressionSubsumes(exprA, exprB);
        const b2 = this.sct.expressionServices.expressionSubsumes(exprB, exprA);

        if (b1 && b2) {
          return 'equivalent';
        } else if (b1) {
          return 'subsumes';
        } else if (b2) {
          return 'subsumed-by';
        } else {
          return 'not-subsumed';
        }
      }
    } catch (error) {
      throw new Error(`Error in subsumption test: ${error.message}`);
    }
  }

  // Helper methods
  async #ensureContext(context) {
    if (!context) {
      return null;
    }

    if (typeof context === 'string') {
      const result = await this.locate(context);
      if (!result.context) {
        throw new Error(result.message);
      }
      return result.context;
    }

    if (context instanceof SnomedExpressionContext) {
      return context;
    }

    throw new Error(`Unknown type at #ensureContext: ${typeof context}`);
  }

  versionAlgorithm() {
    return 'url';
  }

  isNotClosed() {
    return true;
  }

  isDisplay(cd) {
    return cd.use.system === this.system() &&
           (cd.use.code === '900000000000013009' || cd.use.code === '900000000000003001');
  }

}

/**
 * Factory for creating SNOMED services and providers
 */
class SnomedServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n, filePath) {
    super(i18n);
    this.filePath = filePath;
    this.uses = 0;
    this._loaded = false;
    this._sharedData = null;
  }

  system() {
    return 'http://snomed.info/sct';
  }

  version() {
    return this._sharedData.versionUri;
  }

  getPartialVersion() {
    let ver = this.version();
    if (ver.includes("/version")) {
      return ver.substring(0, ver.indexOf("/version"));
    } else {
      return null;
    }
  }
  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  async #ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  async load() {
    const reader = new SnomedFileReader(this.filePath);
    this._sharedData = await reader.loadSnomedData();
    this.snomedServices = new SnomedServices(this._sharedData);
    this._loaded = true;
  }

  defaultVersion() {
    return this._sharedData?.version || 'unknown';
  }

  async build(opContext, supplements = []) {
    await this.#ensureLoaded();
    this.recordUse();
    return new SnomedProvider(opContext, supplements, this.snomedServices);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }


  name() {
    return `SCT ${getEditionCode(this._sharedData.edition)}`;
  }

  id() {
    return "SCT"+this.version();
  }
}


function getEditionName(edition) {
  const editionMap = {
    '900000000000207008': 'International Edition',
    '449081005': 'International Spanish Edition',
    '11000221109': 'Argentinian Edition',
    '32506021000036107': 'Australian Edition (with drug extension)',
    '11000234105': 'Austrian Edition',
    '11000172109': 'Belgian Edition',
    '20621000087109': 'Canadian English Edition',
    '20611000087101': 'Canadian Canadian French Edition',
    '554471000005108': 'Danish Edition',
    '11000279109': 'Czech Edition',
    '11000181102': 'Estonian Edition',
    '11000229106': 'Finnish Edition',
    '11000274103': 'German Edition',
    '1121000189102': 'Indian Edition',
    '827022005': 'IPS Terminology',
    '11000220105': 'Irish Edition',
    '11000146104': 'Netherlands Edition',
    '21000210109': 'New Zealand Edition',
    '51000202101': 'Norwegian Edition',
    '11000267109': 'Republic of Korea Edition (South Korea)',
    '900000001000122104': 'Spanish National Edition',
    '45991000052106': 'Swedish Edition',
    '2011000195101': 'Swiss Edition',
    '83821000000107': 'UK Edition',
    '999000021000000109': 'UK Clinical Edition',
    '5631000179106': 'Uruguay Edition',
    '731000124108': 'US Edition',
    '21000325107': 'Chilean Edition',
    '5991000124107': 'US Edition (with ICD-10-CM maps)'
  };

  return editionMap[edition] || 'Unknown Edition';
}

function getEditionCode(edition) {
  const editionMap = {
    '900000000000207008': 'Intl',
    '449081005': 'es',
    '11000221109': 'AR-es',
    '32506021000036107': 'AU+',
    '11000234105': 'AT',
    '11000172109': 'BE',
    '20621000087109': 'CA-en',
    '20611000087101': 'CA-fr',
    '554471000005108': 'DK',
    '11000279109': 'CZ',
    '11000181102': 'ES',
    '11000229106': 'FI',
    '11000274103': 'DE',
    '1121000189102': 'IN',
    '827022005': 'IPS',
    '11000220105': 'IE',
    '11000146104': 'NL',
    '21000210109': 'NZ',
    '51000202101': 'NO',
    '11000267109': 'KR',
    '900000001000122104': 'ES-es',
    '45991000052106': 'SW',
    '2011000195101': 'CH',
    '83821000000107': 'UK',
    '999000021000000109': 'UK-Clinical',
    '5631000179106': 'UR',
    '731000124108': 'US',
    '21000325107': 'CL',
    '5991000124107': 'US+)'
  };

  return editionMap[edition] || 'Unknown Edition';
}


module.exports = {
  SnomedProvider,
  SnomedServicesFactory,
  SnomedExpressionContext,
  SnomedServices,
  SnomedFilterContext,
  SnomedProviderContextKind
};