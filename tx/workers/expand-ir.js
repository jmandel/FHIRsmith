'use strict';

const { ExpandWorker, EXTERNAL_DEFAULT_LIMIT } = require('./expand');

const TRACE_EXTENSION_URL = 'https://github.com/HealthIntersections/FHIRsmith/StructureDefinition/expand-trace';

class ExpandIRWorker extends ExpandWorker {
  constructor(opContext, log, provider, languages, i18n, internalLimit, externalLimit, strictIR = true) {
    super(opContext, log, provider, languages, i18n, internalLimit, externalLimit);
    this.strictIR = !!strictIR;
  }

  async performExpansion(valueSet, params, logExtraOutput) {
    this.deadCheck('performExpansion:ir');

    this.params = params;
    params._engine = this.strictIR ? 'ir' : (params._engine || 'ir');

    if (params.limit < -1) {
      params.limit = -1;
    } else if (params.limit > EXTERNAL_DEFAULT_LIMIT) {
      params.limit = EXTERNAL_DEFAULT_LIMIT;
    }

    const { maybeExpandValueSetViaIR } = require('../engine/expand-entry');
    const irResult = await maybeExpandValueSetViaIR({
      valueSet,
      params,
      strictIR: this.strictIR,
      externalDefaultLimit: EXTERNAL_DEFAULT_LIMIT,
      traceExtensionUrl: TRACE_EXTENSION_URL,
      services: {
        findBaseProvider: async (system, version) => (
          await this.findCodeSystemWithSupplements(
            system, version, params, ['complete', 'fragment'],
            false, true, false, false, []
          )
        ),
        buildSupplementRegistry: async () => await this.buildSupplementRegistryForIR(),
        resolveSupplementSet: async (target, refs, registry) => (
          await this.resolveSupplementsForIRBaseScope(target, refs, registry)
        ),
        bindIRScope: async (provider, supplementSet) => (
          await this.bindIRScopeForExpansion(provider, supplementSet)
        ),
        resolveValueSet: async (url, version) => {
          try {
            const vs = await this.findValueSet(url, version);
            return vs?.jsonObj || vs;
          } catch {
            return null;
          }
        },
        resolveVersionAtDate: async (system, lockedDate) => {
          try {
            if (typeof this.resolveCodeSystemVersionAtDate !== 'function') return null;
            return await this.resolveCodeSystemVersionAtDate(system, lockedDate, params);
          } catch {
            return null;
          }
        },
        log: message => this.opContext?.log?.(message),
        diagnostics: () => this.opContext?.diagnostics?.(),
      },
    });
    return irResult?.expansion;
  }
}

module.exports = {
  ExpandIRWorker,
};
