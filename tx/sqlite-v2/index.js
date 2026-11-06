'use strict';
// sqlite-v2 terminology files: provider registration entry point.
//
// A library source line `sqlite-v2:<file>` (or `sqlite-v2!:<file>` for the default version of
// its system) loads one file. Without such a line nothing here is loaded and upstream
// behaviour is unchanged.

const Database = require('better-sqlite3');
const { SqliteV2Factory } = require('./provider');
const { SnomedV2Factory } = require('./snomed');

/** a factory for the file, chosen by the code system it holds */
async function loadSqliteV2Factory(i18n, file, opts = {}) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let uri;
  try {
    uri = db.prepare('SELECT uri FROM code_system WHERE id = 1').get().uri;
  } finally {
    db.close();
  }
  const factory = uri === 'http://snomed.info/sct' ? new SnomedV2Factory(i18n, file, opts) : new SqliteV2Factory(i18n, file, opts);
  await factory.load();
  return factory;
}

module.exports = { loadSqliteV2Factory };
