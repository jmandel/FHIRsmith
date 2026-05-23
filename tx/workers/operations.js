
// @ts-check

const {TerminologyWorker} = require("./worker");

/**
 * this handles assembling the information for the operations form
 */
class OperationsWorker extends TerminologyWorker {
  /**
   * @param {any} opContext - Operation context
   * @param {any} log - Logger instance
   * @param {any} provider - Provider for code systems and resources
   * @param {any} languages - Language definitions
   * @param {any} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'search';
  }

  /**
   * @param {any} req
   * @param {{json: (body: any) => any}} res
   * @returns {Promise<any>}
   */
  async handle(req, res) {
    void req;
    /** @type {{resourceType: string, valueSets?: any}} */
    const formData = { resourceType : "Operations" };
    formData.valueSets = await this.provider.listAllValueSets();
    return res.json(formData);
  }
}

module.exports = { OperationsWorker };
