// @ts-check

const { AbstractCodeSystemProvider } = require('./cs-provider-api');

/** @typedef {import('../../types/fhirsmith').FhirResource} FhirResource */

/**
 * Package-based ValueSet provider using shared database layer
 */
class ListCodeSystemProvider extends AbstractCodeSystemProvider {
  /**
   * A list of code systems that contains all the preloaded native code systems.
   * @type {FhirResource[]}
   */
  codeSystems = [];

  /**
   * ensure that the ids on the code systems are unique, if they are
   * in the global namespace
   *
   * @param {Set<string>} ids
   * @returns {void}
   */
  // eslint-disable-next-line no-unused-vars
  assignIds(ids) {
    for (const cs of this.codeSystems) {
      if (!cs.id || ids.has("CodeSystem/"+cs.id)) {
        cs.id = ""+ids.size;
      }
      ids.add("CodeSystem/"+cs.id);
    }
  }


  // eslint-disable-next-line no-unused-vars
  /**
   * @param {string} fhirVersion - FHIR version
   * @param {any} context - Operation context
   * @returns {Promise<FhirResource[]>} Loaded CodeSystems
   */
  async listCodeSystems(fhirVersion, context) {
    void fhirVersion;
    void context;
    return this.codeSystems;
  }
}

module.exports = {
  ListCodeSystemProvider
};
