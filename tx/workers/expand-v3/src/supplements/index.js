'use strict';

const { SupplementContext, EmptySupplementContext } = require('./supplement-context');
const { ResourceSupplementContext } = require('./resource-supplement-context');
const { CompositeSupplementContext } = require('./composite-supplement-context');
const { SqliteSupplementContext } = require('./sqlite-supplement-context');

module.exports = {
  SupplementContext,
  EmptySupplementContext,
  ResourceSupplementContext,
  CompositeSupplementContext,
  SqliteSupplementContext,
};
