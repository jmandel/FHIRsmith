'use strict';

// Compatibility surface only.
// New provider family modules should import from:
//   - ./provider-core
//   - ./provider-base
//   - ./provider-legacy-filter
//   - ./provider-v3-query
module.exports = require('./provider-core');
