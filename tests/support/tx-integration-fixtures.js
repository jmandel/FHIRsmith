'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTempTxApp } = require('./sqlite-v0-supplement-fixtures');

async function createManagedTxFixture(opts = {}) {
  const prefix = opts.prefix || 'tx-test-';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    const setup = opts.setup ? await opts.setup({ dir }) : {};
    const configPath = setup?.configPath || path.join(dir, 'library.yaml');
    const loaded = await createTempTxApp(configPath);
    return {
      dir,
      app: loaded.app,
      txModule: loaded.txModule,
      ...setup,
    };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

async function destroyManagedTxFixture(fixture) {
  if (!fixture) return;
  if (fixture.txModule) {
    await fixture.txModule.shutdown();
  }
  if (fixture.dir) {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
}

module.exports = {
  createManagedTxFixture,
  destroyManagedTxFixture,
};
