'use strict';

const { FilterExecutionContext } = require('./provider-core');
const {
  CodeSystemProviderBase,
  CodeSystemFactoryProviderBase,
  CodeSystemContentMode,
} = require('./provider-base');

class CodeSystemProviderLegacyFilter extends CodeSystemProviderBase {
  capabilitiesLegacyFilter() {
    return {
      filterPipeline: true,
      supportsSearchFilter: (this.searchFilter !== CodeSystemProviderLegacyFilter.prototype.searchFilter),
      supportsFilterPage: (this.filterPage !== CodeSystemProviderLegacyFilter.prototype.filterPage),
    };
  }
}

module.exports = {
  FilterExecutionContext,
  CodeSystemProviderLegacyFilter,
  CodeSystemProvider: CodeSystemProviderLegacyFilter,
  CodeSystemFactoryProvider: CodeSystemFactoryProviderBase,
  CodeSystemContentMode,
};
