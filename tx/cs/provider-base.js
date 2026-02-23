'use strict';

const {
  CodeSystemProvider: LegacyCodeSystemProvider,
  CodeSystemFactoryProvider: LegacyCodeSystemFactoryProvider,
  CodeSystemContentMode,
} = require('./provider-core');

class CodeSystemProviderBase extends LegacyCodeSystemProvider {
  capabilitiesBase() {
    return {
      lookup: true,
      iterable: (this.iteratorAll !== CodeSystemProviderBase.prototype.iteratorAll)
        || (this.iterator !== CodeSystemProviderBase.prototype.iterator),
      notClosed: typeof this.isNotClosed === 'function' ? !!this.isNotClosed() : false,
    };
  }

  capabilitiesLegacyFilter() {
    return {
      filterPipeline: false,
      supportsSearchFilter: false,
      supportsFilterPage: false,
    };
  }

  capabilitiesV3() {
    return {
      query: false,
      membership: false,
      decorateMany: false,
      supportsTextFilter: false,
      supportsSetOps: false,
      supportsPagination: false,
    };
  }
}

class CodeSystemFactoryProviderBase extends LegacyCodeSystemFactoryProvider {
}

module.exports = {
  CodeSystemProviderBase,
  CodeSystemFactoryProviderBase,
  CodeSystemProvider: CodeSystemProviderBase,
  CodeSystemFactoryProvider: CodeSystemFactoryProviderBase,
  CodeSystemContentMode,
};
