'use strict';

const {
  CodeSystemProviderLegacyFilter,
  FilterExecutionContext,
  CodeSystemFactoryProvider,
  CodeSystemContentMode,
} = require('./provider-legacy-filter');

class CodeSystemProviderV3Query extends CodeSystemProviderLegacyFilter {
  capabilitiesV3() {
    const proto = CodeSystemProviderV3Query.prototype;
    const hasOpenStream = (this.openStream !== proto.openStream);
    const hasPrepareMembership = (this.prepareMembership !== proto.prepareMembership);
    const hasDecorateMany = (this.decorateMany !== proto.decorateMany);

    return {
      query: hasOpenStream,
      membership: hasPrepareMembership,
      decorateMany: hasDecorateMany,
      supportsTextFilter: hasOpenStream,
      supportsSetOps: false,
      supportsPagination: false,
    };
  }

  async openStream(_queryIR, _opts = {}) {
    void _queryIR;
    void _opts;
    return null;
  }

  async prepareMembership(_queryIR) {
    void _queryIR;
    return null;
  }

  async decorateMany(_codes, _opts = {}) {
    void _codes;
    void _opts;
    return null;
  }
}

module.exports = {
  CodeSystemProviderV3Query,
  CodeSystemProvider: CodeSystemProviderV3Query,
  CodeSystemFactoryProvider,
  CodeSystemContentMode,
  FilterExecutionContext,
};
