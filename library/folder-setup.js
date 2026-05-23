// @ts-check

const path = require('path');
const fs = require('fs');

class FolderSetup {
  /** @type {string | null} */
  _dataDir;
  /** @type {boolean} */
  _initialized;

  constructor() {
    this._dataDir = null;
    this._initialized = false;
  }

  /**
   * @param {string | null} [dataDir]
   * @returns {this}
   */
  init(dataDir = null) {
    if (this._initialized) {
      return this;
    }

    this._dataDir = dataDir || process.env.FHIRSMITH_DATA_DIR || path.join(__dirname, '..', 'data');
    fs.mkdirSync(this._dataDir, { recursive: true });
    this._initialized = true;

    return this;
  }

  /**
   * @returns {string}
   */
  dataDir() {
    if (!this._initialized) {
      this.init();
    }
    return /** @type {string} */ (this._dataDir);
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  subDir(name) {
    const dir = path.join(this.dataDir(), name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * @param {...string} relativePath
   * @returns {string}
   */
  filePath(...relativePath) {
    return path.join(this.dataDir(), ...relativePath);
  }

  /**
   * @param {...string} relativePath
   * @returns {string}
   */
  ensureFilePath(...relativePath) {
    const filePath = path.join(this.dataDir(), ...relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return filePath;
  }

  /**
   * @param {...string} relativePath
   * @returns {string}
   */
  ensureFolder(...relativePath) {
    const dirPath = path.join(this.dataDir(), ...relativePath);
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
  }

  /**
   * @returns {string}
   */
  logsDir() {
    return this.subDir('logs');
  }

  /**
   * @returns {string}
   */
  cacheDir() {
    return this.subDir('cache');
  }

  /**
   * @returns {string}
   */
  databasesDir() {
    return this.subDir('databases');
  }
}

module.exports = new FolderSetup();
