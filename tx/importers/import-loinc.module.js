// @ts-check

const { BaseTerminologyModule } = require('./tx-import-base');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');

/** @typedef {import('sqlite3').Database} SqliteDatabase */
/** @typedef {{mainCodesFound: boolean, partsFound: boolean, estimatedCodes: number, languageVariants: string[], warnings: string[]}} LoincValidationStats */
/** @typedef {{version: string, codeCount: number, mainCodeCount: number, partCount: number, answerListCount: number, languageCount: number, relationshipCount: number, sizeGB: number, lastModified: string}} LoincDatabaseStats */
/** @typedef {{name: string, sql: string}} CountQuery */
/** @typedef {{key: number, children: Set<number>}} LoincCodeInfo */
/** @typedef {{verbose?: boolean, mainOnly?: boolean}} LoincImportOptions */
/** @typedef {(currentProgress: number, operation: string) => void} ProgressCallback */

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class LoincModule extends BaseTerminologyModule {
  constructor() {
    super();
  }

  getName() {
    return 'loinc';
  }

  getDescription() {
    return 'Logical Observation Identifiers Names and Codes (LOINC) from Regenstrief Institute';
  }

  getSupportedFormats() {
    return ['csv', 'directory'];
  }

  getDefaultConfig() {
    return {
      verbose: true,
      overwrite: false,
      createIndexes: true,
      mainOnly: false,
      dest: './data/loinc.db'
    };
  }

  getEstimatedDuration() {
    return '45-120 minutes (depending on language variants)';
  }

  /**
   * @param {any} terminologyCommand
   * @param {Record<string, any>} globalOptions
   */
  registerCommands(terminologyCommand, globalOptions) {
    // Import command
    terminologyCommand
      .command('import')
      .description('Import LOINC data from source directory')
      .option('-s, --source <directory>', 'Source directory containing LOINC files')
      .option('-d, --dest <file>', 'Destination SQLite database')
      .option('-v, --version <version>', 'LOINC version identifier')
      .option('-y, --yes', 'Skip confirmations')
      .option('--no-indexes', 'Skip index creation for faster import')
      .option('--main-only', 'Import only main codes (skip language variants)')
      .action(async (/** @type {Record<string, any>} */ options) => {
        await this.handleImportCommand({...globalOptions, ...options});
      });

    // Validate command
    terminologyCommand
      .command('validate')
      .description('Validate LOINC source directory structure')
      .option('-s, --source <directory>', 'Source directory to validate')
      .action(async (/** @type {Record<string, any>} */ options) => {
        await this.handleValidateCommand({...globalOptions, ...options});
      });

    // Status command
    terminologyCommand
      .command('status')
      .description('Show status of LOINC database')
      .option('-d, --dest <file>', 'Database file to check')
      .action(async (/** @type {Record<string, any>} */ options) => {
        await this.handleStatusCommand({...globalOptions, ...options});
      });
  }

  /**
   * @param {Record<string, any>} options
   */
  async handleImportCommand(options) {
    try {
      // Gather configuration with remembered values
      const config = await this.gatherCommonConfig(options);

      // LOINC-specific configuration
      config.createIndexes = !options.noIndexes;
      config.mainOnly = options.mainOnly || false;
      config.estimatedDuration = this.getEstimatedDuration();

      if (!options.version) {
        const inquirer = require('inquirer');
        const { version } = await inquirer.prompt({
          type: 'input',
          name: 'version',
          message: 'LOINC version identifier:',
          default: config.version
        });
        config.version = version;
      }

      // Show confirmation unless --yes is specified
      if (!options.yes) {
        const confirmed = await this.confirmImport(config);
        if (!confirmed) {
          this.logInfo('Import cancelled');
          return;
        }
      }

      // Save configuration immediately after confirmation
      this.rememberSuccessfulConfig(config);

      // Run the import
      await this.runImportWithoutConfigSaving(config);
    } catch (error) {
      this.logError(`Import command failed: ${errorMessage(error)}`);
      if (options.verbose) {
        console.error(error instanceof Error ? error.stack : error);
      }
      throw error;
    }
  }

  /**
   * @param {Record<string, any>} config
   * @returns {Promise<boolean>}
   */
  async confirmImport(config) {
    const inquirer = require('inquirer');
    const chalk = require('chalk');

    console.log(chalk.cyan(`\n📋 ${this.getName()} Import Configuration:`));
    console.log(`  Source: ${chalk.white(config.source)}`);
    console.log(`  Destination: ${chalk.white(config.dest)}`);
    console.log(`  Version: ${chalk.white(config.version)}`);
    console.log(`  Main Only: ${chalk.white(config.mainOnly ? 'Yes' : 'No')}`);
    console.log(`  Create Indexes: ${chalk.white(config.createIndexes ? 'Yes' : 'No')}`);
    console.log(`  Overwrite: ${chalk.white(config.overwrite ? 'Yes' : 'No')}`);
    console.log(`  Verbose: ${chalk.white(config.verbose ? 'Yes' : 'No')}`);

    if (config.estimatedDuration) {
      console.log(`  Estimated Duration: ${chalk.white(config.estimatedDuration)}`);
    }

    const { confirmed } = await inquirer.prompt({
      type: 'confirm',
      name: 'confirmed',
      message: 'Proceed with import?',
      default: true
    });

    return confirmed;
  }

  /**
   * @param {Record<string, any>} config
   */
  async runImportWithoutConfigSaving(config) {
    try {
      console.log(chalk.blue.bold(`🏥 Starting ${this.getName()} Import...\n`));

      // Pre-flight checks
      this.logInfo('Running pre-flight checks...');
      const prerequisitesPassed = await this.validatePrerequisites(config);

      if (!prerequisitesPassed) {
        throw new Error('Pre-flight checks failed');
      }

      // Execute the import
      await this.executeImport(config);

      this.logSuccess(`${this.getName()} import completed successfully!`);

    } catch (error) {
      this.stopProgress();
      this.logError(`${this.getName()} import failed: ${errorMessage(error)}`);
      if (config.verbose) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  }

  /**
   * @param {Record<string, any>} options
   */
  async handleValidateCommand(options) {
    if (!options.source) {
      const answers = await require('inquirer').prompt({
        type: 'input',
        name: 'source',
        message: 'Source directory to validate:',
        validate: (/** @type {string} */ input) => input && fs.existsSync(input) ? true : 'Directory does not exist'
      });
      options.source = answers.source;
    }

    this.logInfo(`Validating LOINC directory: ${options.source}`);

    try {
      const stats = await this.validateLoincDirectory(options.source);

      this.logSuccess('Directory validation passed');
      console.log(`  Main codes file: ${stats.mainCodesFound ? 'Found' : 'Missing'}`);
      console.log(`  Parts file: ${stats.partsFound ? 'Found' : 'Missing'}`);
      console.log(`  Language variants: ${stats.languageVariants.length} found`);
      console.log(`  Estimated main codes: ${stats.estimatedCodes.toLocaleString()}`);

      if (stats.warnings.length > 0) {
        this.logWarning('Validation warnings:');
        stats.warnings.forEach((/** @type {string} */ warning) => console.log(`    ${warning}`));
      }

    } catch (error) {
      this.logError(`Validation failed: ${errorMessage(error)}`);
    }
  }

  /**
   * @param {Record<string, any>} options
   */
  async handleStatusCommand(options) {
    const dbPath = options.dest || './data/loinc.db';

    if (!fs.existsSync(dbPath)) {
      this.logError(`Database not found: ${dbPath}`);
      return;
    }

    this.logInfo(`Checking LOINC database: ${dbPath}`);

    try {
      const stats = await this.getDatabaseStats(dbPath);

      this.logSuccess('Database status:');
      console.log(`  Version: ${stats.version}`);
      console.log(`  Total Codes: ${stats.codeCount.toLocaleString()}`);
      console.log(`  Main LOINC Codes: ${stats.mainCodeCount.toLocaleString()}`);
      console.log(`  Parts: ${stats.partCount.toLocaleString()}`);
      console.log(`  Answer Lists: ${stats.answerListCount.toLocaleString()}`);
      console.log(`  Languages: ${stats.languageCount.toLocaleString()}`);
      console.log(`  Relationships: ${stats.relationshipCount.toLocaleString()}`);
      console.log(`  Database Size: ${stats.sizeGB.toFixed(2)} GB`);
      console.log(`  Last Modified: ${stats.lastModified}`);

    } catch (error) {
      this.logError(`Status check failed: ${errorMessage(error)}`);
    }
  }

  /**
   * @param {Record<string, any>} config
   * @returns {Promise<boolean>}
   */
  async validatePrerequisites(config) {
    const baseValid = await super.validatePrerequisites(config);

    try {
      this.logInfo('Validating LOINC directory structure...');
      await this.validateLoincDirectory(config.source);
      this.logSuccess('LOINC directory structure valid');
    } catch (error) {
      this.logError(`LOINC directory validation failed: ${errorMessage(error)}`);
      return false;
    }

    return baseValid;
  }

  /**
   * @param {Record<string, any>} config
   */
  async executeImport(config) {
    this.logInfo('Starting LOINC data migration...');

    const enhancedMigrator = new LoincDataMigratorWithProgress(
      this,
      config.verbose
    );

    await enhancedMigrator.migrate(
      config.source,
      config.dest,
      config.version,
      {
        verbose: config.verbose,
        mainOnly: config.mainOnly
      }
    );

    if (config.createIndexes) {
      this.logInfo('Creating database indexes...');
      await this.createIndexes(config.dest);
      this.logSuccess('Indexes created');
    }
  }

  /**
   * @param {string} sourceDir
   * @returns {Promise<LoincValidationStats>}
   */
  async validateLoincDirectory(sourceDir) {
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Source directory not found: ${sourceDir}`);
    }

    const requiredFiles = [
      'LoincTable/Loinc.csv',
      'AccessoryFiles/PartFile/Part.csv'
    ];

    const optionalFiles = [
      'AccessoryFiles/ConsumerName/ConsumerName.csv',
      'AccessoryFiles/AnswerFile/AnswerList.csv',
      'AccessoryFiles/PartFile/LoincPartLink_Primary.csv',
      'AccessoryFiles/AnswerFile/LoincAnswerListLink.csv',
      'AccessoryFiles/ComponentHierarchyBySystem/ComponentHierarchyBySystem.csv',
      'AccessoryFiles/LinguisticVariants/LinguisticVariants.csv'
    ];

    /** @type {string[]} */
    const warnings = [];
    let mainCodesFound = false;
    let partsFound = false;
    let estimatedCodes = 0;

    // Check required files
    for (const file of requiredFiles) {
      const filePath = path.join(sourceDir, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Required file missing: ${file}`);
      }

      if (file.includes('Loinc.csv')) {
        mainCodesFound = true;
        estimatedCodes = await this.countLines(filePath) - 1;
      } else if (file.includes('Part.csv')) {
        partsFound = true;
      }
    }

    // Check optional files
    for (const file of optionalFiles) {
      const filePath = path.join(sourceDir, file);
      if (!fs.existsSync(filePath)) {
        warnings.push(`Optional file missing: ${file}`);
      }
    }

    // Check for language variants
    /** @type {string[]} */
    const languageVariants = [];
    const linguisticVariantsDir = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants');
    if (fs.existsSync(linguisticVariantsDir)) {
      const files = fs.readdirSync(linguisticVariantsDir);
      for (const file of files) {
        if (file.includes('LinguisticVariant.csv') && !file.startsWith('LinguisticVariants.csv')) {
          languageVariants.push(file);
        }
      }
    }

    return {
      mainCodesFound,
      partsFound,
      estimatedCodes,
      languageVariants,
      warnings
    };
  }

  /**
   * @param {string} filePath
   * @returns {Promise<number>}
   */
  async countLines(filePath) {
    return new Promise((resolve, reject) => {
      let lineCount = 0;
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity
      });

      rl.on('line', () => lineCount++);
      rl.on('close', () => resolve(lineCount));
      rl.on('error', reject);
    });
  }

  /**
   * @param {string} dbPath
   * @returns {Promise<LoincDatabaseStats>}
   */
  async getDatabaseStats(dbPath) {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);

    return new Promise((resolve, reject) => {
      /** @type {Record<string, any>} */
      const stats = {};

      db.get('SELECT Value FROM Config WHERE ConfigKey = 2', (/** @type {Error | null} */ err, /** @type {{Value?: string} | undefined} */ row) => {
        if (err) return reject(err);
        stats.version = row ? row.Value : 'Unknown';

        const queries = [
          { name: 'codeCount', sql: 'SELECT COUNT(*) as count FROM Codes' },
          { name: 'mainCodeCount', sql: 'SELECT COUNT(*) as count FROM Codes WHERE Type = 1' },
          { name: 'partCount', sql: 'SELECT COUNT(*) as count FROM Codes WHERE Type = 2' },
          { name: 'answerListCount', sql: 'SELECT COUNT(*) as count FROM Codes WHERE Type = 3' },
          { name: 'languageCount', sql: 'SELECT COUNT(*) as count FROM Languages' },
          { name: 'relationshipCount', sql: 'SELECT COUNT(*) as count FROM Relationships' }
        ];

        let completed = 0;

        queries.forEach((/** @type {CountQuery} */ query) => {
          db.get(query.sql, (/** @type {Error | null} */ err, /** @type {{count: number}} */ row) => {
            if (err) return reject(err);
            stats[query.name] = row.count;
            completed++;

            if (completed === queries.length) {
              const fileStat = fs.statSync(dbPath);
              stats.sizeGB = fileStat.size / (1024 * 1024 * 1024);
              stats.lastModified = fileStat.mtime.toISOString();

              db.close();
              resolve(/** @type {LoincDatabaseStats} */ (stats));
            }
          });
        });
      });
    });
  }

  /**
   * @param {string} dbPath
   * @returns {Promise<void>}
   */
  async createIndexes(dbPath) {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);

    const indexes = [
      // Codes table indexes
      'CREATE INDEX IF NOT EXISTS idx_codes_code ON Codes(Code)',
      'CREATE INDEX IF NOT EXISTS idx_codes_type ON Codes(Type)',
      'CREATE INDEX IF NOT EXISTS idx_codes_status ON Codes(StatusKey)',
      'CREATE INDEX IF NOT EXISTS idx_codes_type_status ON Codes(Type, StatusKey)',

      // Relationships table indexes
      'CREATE INDEX IF NOT EXISTS idx_relationships_source ON Relationships(RelationshipTypeKey, SourceKey)',
      'CREATE INDEX IF NOT EXISTS idx_relationships_target ON Relationships(RelationshipTypeKey, TargetKey)',
      'CREATE INDEX IF NOT EXISTS idx_relationships_source_type ON Relationships(SourceKey, RelationshipTypeKey)',

      // Properties table indexes
      'CREATE INDEX IF NOT EXISTS idx_properties_code ON Properties(PropertyTypeKey, CodeKey)',
      'CREATE INDEX IF NOT EXISTS idx_properties_code2 ON Properties(CodeKey, PropertyTypeKey)',
      'CREATE INDEX IF NOT EXISTS idx_properties_valuekey ON Properties(PropertyValueKey)',

      // PropertyValues table indexes - for value lookups in filters
      'CREATE INDEX IF NOT EXISTS idx_propertyvalues_value ON PropertyValues(Value COLLATE NOCASE)',

      // Descriptions table indexes
      'CREATE INDEX IF NOT EXISTS idx_descriptions_code ON Descriptions(CodeKey, LanguageKey)',
      'CREATE INDEX IF NOT EXISTS idx_descriptions_type ON Descriptions(DescriptionTypeKey)',
      'CREATE INDEX IF NOT EXISTS idx_descriptions_code_type ON Descriptions(CodeKey, DescriptionTypeKey)',

      // Closure table indexes
      'CREATE INDEX IF NOT EXISTS idx_closure_ancestor ON Closure(AncestorKey)',
      'CREATE INDEX IF NOT EXISTS idx_closure_descendent ON Closure(DescendentKey)'
    ];

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        indexes.forEach(sql => {
          db.run(sql, (/** @type {Error | null} */ err) => {
            if (err) console.warn(`Index creation warning: ${err.message}`);
          });
        });
      });

      db.close((/** @type {Error | null} */ err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// Enhanced migrator with progress reporting
class LoincDataMigratorWithProgress {
  /**
   * @param {LoincModule} moduleInstance
   * @param {boolean} [verbose]
   */
  constructor(moduleInstance, verbose = true) {
    this.module = moduleInstance;
    this.verbose = verbose;
    this.totalProgress = 0;
    this.currentOperation = 'Starting';
  }

  /**
   * @param {string} sourceDir
   * @param {string} destFile
   * @param {string} version
   * @param {LoincImportOptions} options
   */
  async migrate(sourceDir, destFile, version, options) {
    // Estimate total work
    this.totalProgress = await this.estimateWorkload(sourceDir, options);

    this.module.logInfo(`Processing LOINC data (${this.totalProgress.toLocaleString()} estimated records)...`);

    // Create progress bar with operation display
    const progressFormat = '{operation} |{bar}| {percentage}% | {value}/{total} | ETA: {eta}s';
    this.module.createProgressBar(progressFormat);

    // Start the progress bar
    this.module.progressBar.start(this.totalProgress, 0, {
      operation: chalk.cyan('Starting'.padEnd(20).substring(0, 20))
    });

    // Create migrator with progress callback that properly updates both progress and operation
    const migratorWithProgress = new LoincDataMigrator((currentProgress, operation) => {
      if (operation) {
        this.currentOperation = operation;
      }

      if (this.module.progressBar) {
        this.module.progressBar.update(currentProgress, {
          operation: chalk.cyan(this.currentOperation.padEnd(20).substring(0, 20))
        });
      }
    });

    try {
      await migratorWithProgress.migrate(sourceDir, destFile, version, options);
    } finally {
      this.module.stopProgress();
    }
  }

  /**
   * @param {string} sourceDir
   * @param {LoincImportOptions} options
   * @returns {Promise<number>}
   */
  async estimateWorkload(sourceDir, options) {
    let totalLines = 0;
    const files = [
      'LoincTable/Loinc.csv',
      'AccessoryFiles/PartFile/Part.csv'
    ];

    const optionalFiles = [
      'AccessoryFiles/ConsumerName/ConsumerName.csv',
      'AccessoryFiles/AnswerFile/AnswerList.csv',
      'AccessoryFiles/PartFile/LoincPartLink_Primary.csv',
      'AccessoryFiles/AnswerFile/LoincAnswerListLink.csv',
      'AccessoryFiles/ComponentHierarchyBySystem/ComponentHierarchyBySystem.csv'
    ];

    // Count main files
    for (const file of [...files, ...optionalFiles]) {
      const filePath = path.join(sourceDir, file);
      if (fs.existsSync(filePath)) {
        totalLines += await this.countLines(filePath);
      }
    }

    // Count language variant files if not main-only
    if (!options.mainOnly) {
      const linguisticVariantsDir = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants');
      if (fs.existsSync(linguisticVariantsDir)) {
        const files = fs.readdirSync(linguisticVariantsDir);
        for (const file of files) {
          if (file.includes('LinguisticVariant.csv') && !file.startsWith('LinguisticVariants.csv')) {
            const filePath = path.join(linguisticVariantsDir, file);
            totalLines += await this.countLines(filePath);
          }
        }
      }
    }

    return Math.max(totalLines - 20, 1);
  }

  /**
   * @param {string} filePath
   * @returns {Promise<number>}
   */
  async countLines(filePath) {
    return new Promise((resolve, reject) => {
      let lineCount = 0;
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity
      });

      rl.on('line', () => lineCount++);
      rl.on('close', () => resolve(lineCount));
      rl.on('error', reject);
    });
  }
}

class LoincDataMigrator {
  /**
   * @param {ProgressCallback | null} [progressCallback]
   */
  constructor(progressCallback = null) {
    this.progressCallback = progressCallback;
    this.currentProgress = 0;
    this.stepCount = 16;
    this.currentOperation = 'Initializing';
    this.codeKey = 0;
    this.relKey = 0;
    this.descKey = 0;
    this.propKey = 0;
    this.propValueKey = 0;
    this.langKey = 1;
    /** @type {Map<string, LoincCodeInfo>} */
    this.codes = new Map();
    /** @type {LoincCodeInfo[]} */
    this.codeList = [];
    /** @type {Map<string, number>} */
    this.statii = new Map();
    /** @type {Map<string, number>} */
    this.langs = new Map();
    /** @type {Map<string, number>} */
    this.rels = new Map();
    /** @type {Map<string, number>} */
    this.dTypes = new Map();
    /** @type {Map<string, number>} */
    this.props = new Map();
    /** @type {Map<string, number>} */
    this.propValues = new Map();
    /** @type {Map<string, string>} */
    this.partNames = new Map();
  }

  /**
   * @param {number} [amount]
   * @param {string | null} [operation]
   */
  updateProgress(amount = 1, operation = null) {
    this.currentProgress += amount;
    if (operation) {
      this.currentOperation = operation;
    }
    if (this.progressCallback) {
      this.progressCallback(this.currentProgress, this.currentOperation);
    }
  }

  /**
   * @param {string} sourceDir
   * @param {string} destFile
   * @param {string} [version]
   * @param {LoincImportOptions} [options]
   */
  async migrate(sourceDir, destFile, version = 'unknown', options = {}) {
    if (options.verbose) console.log('Starting LOINC data migration...');

    const destDir = path.dirname(destFile);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    if (fs.existsSync(destFile)) {
      fs.unlinkSync(destFile);
    }

    const db = new sqlite3.Database(destFile);

    try {
      // Initialize tracking variables
      this.codeKey = 0;
      this.relKey = 0;
      this.descKey = 0;
      this.propKey = 0;
      this.propValueKey = 0;
      this.langKey = 1;

      this.codes = new Map();
      this.codeList = [];
      this.statii = new Map();
      this.langs = new Map();
      this.rels = new Map();
      this.dTypes = new Map();
      this.props = new Map();
      this.propValues = new Map();
      this.partNames = new Map();

      // Create tables and initial data
      await this.createTables(db, version, options.verbose);

      // Discover language variants first
      const languageVariants = await this.discoverLanguageVariants(sourceDir);
      if (!options.mainOnly) {
        this.stepCount = 12 + languageVariants.length;
      }

      // Process all data with proper operation names
      this.updateProgress(0, 'Language Variants');
      await this.processLanguageVariants(db, sourceDir, 2, options);

      this.updateProgress(0, 'Parts');
      await this.processParts(db, sourceDir, 3, options);

      this.updateProgress(0, 'Main Codes');
      await this.processCodes(db, sourceDir, 4, options);

      this.updateProgress(0, 'Consumer Names');
      await this.processConsumerNames(db, sourceDir, 5, options);

      this.updateProgress(0, 'Answer Lists');
      await this.processLists(db, sourceDir, 6, options);

      this.updateProgress(0, 'Part Links');
      await this.processPartLinks(db, sourceDir, 7, options);

      this.updateProgress(0, 'List Links');
      await this.processListLinks(db, sourceDir, 8, options);

      this.updateProgress(0, 'Hierarchy');
      await this.processHierarchy(db, sourceDir, 9, options);

      this.updateProgress(0, 'Property Values');
      await this.processPropertyValues(db, 10, options);

      this.updateProgress(0, 'Closure Table');
      await this.storeClosureTable(db, 11, options);

      // Process individual language variants
      if (!options.mainOnly) {
        for (let i = 0; i < languageVariants.length; i++) {
          this.updateProgress(0, `Lang: ${languageVariants[i]}`);
          await this.processLanguage(db, sourceDir, 12 + i, languageVariants[i], options);
        }
      }

      if (options.verbose) console.log('LOINC data migration completed successfully');
    } finally {
      await this.closeDatabase(db, options.verbose);
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} version
   * @param {boolean} [verbose]
   * @returns {Promise<void>}
   */
  async createTables(db, version, verbose = true) {
    if (verbose) console.log('Creating database tables...');

    const tableSQL = [
      `CREATE TABLE Config (
                               ConfigKey INTEGER NOT NULL PRIMARY KEY,
                               Value TEXT NOT NULL
       )`,
      `CREATE TABLE Types (
                              TypeKey INTEGER NOT NULL PRIMARY KEY,
                              Code TEXT NOT NULL
       )`,
      `CREATE TABLE Languages (
                                  LanguageKey INTEGER NOT NULL PRIMARY KEY,
                                  Code TEXT NOT NULL,
                                  Description TEXT NOT NULL
       )`,
      `CREATE TABLE StatusCodes (
                                    StatusKey INTEGER NOT NULL PRIMARY KEY,
                                    Description TEXT NOT NULL
       )`,
      `CREATE TABLE RelationshipTypes (
                                          RelationshipTypeKey INTEGER NOT NULL PRIMARY KEY,
                                          Description TEXT NOT NULL
       )`,
      `CREATE TABLE DescriptionTypes (
                                         DescriptionTypeKey INTEGER NOT NULL PRIMARY KEY,
                                         Description TEXT NOT NULL
       )`,
      `CREATE TABLE PropertyTypes (
                                      PropertyTypeKey INTEGER NOT NULL PRIMARY KEY,
                                      Description TEXT NOT NULL
       )`,
      `CREATE TABLE Codes (
                              CodeKey INTEGER NOT NULL PRIMARY KEY,
                              Code TEXT NOT NULL,
                              Type INTEGER NOT NULL,
                              RelationshipKey INTEGER NULL,
                              StatusKey INTEGER NOT NULL,
                              Description TEXT NOT NULL
       )`,
      `CREATE TABLE Relationships (
                                      RelationshipKey INTEGER NOT NULL PRIMARY KEY,
                                      RelationshipTypeKey INTEGER NOT NULL,
                                      SourceKey INTEGER NOT NULL,
                                      TargetKey INTEGER NOT NULL,
                                      StatusKey INTEGER NOT NULL
       )`,
      `CREATE TABLE PropertyValues (
                                       PropertyValueKey INTEGER NOT NULL PRIMARY KEY,
                                       Value TEXT NOT NULL
       )`,
      `CREATE TABLE Properties (
                                   PropertyKey INTEGER NOT NULL PRIMARY KEY,
                                   PropertyTypeKey INTEGER NOT NULL,
                                   CodeKey INTEGER NOT NULL,
                                   PropertyValueKey INTEGER NOT NULL
       )`,
      `CREATE TABLE Descriptions (
                                     DescriptionKey INTEGER NOT NULL PRIMARY KEY,
                                     CodeKey INTEGER NOT NULL,
                                     LanguageKey INTEGER NOT NULL,
                                     DescriptionTypeKey INTEGER NOT NULL,
                                     Value TEXT NOT NULL
       )`,
      `CREATE TABLE Closure (
                                AncestorKey INTEGER NOT NULL,
                                DescendentKey INTEGER NOT NULL,
                                PRIMARY KEY (AncestorKey, DescendentKey)
       )`,
      `CREATE VIRTUAL TABLE TextIndex USING fts5(
        codekey UNINDEXED,
        type UNINDEXED, 
        lang UNINDEXED,
        text
      )`
    ];

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        tableSQL.forEach(sql => {
          db.run(sql, (/** @type {Error | null} */ err) => {
            if (err) return reject(err);
          });
        });

        this.insertInitialData(db, version);
        if (verbose) console.log('Database tables created');
        resolve();
      });
    });
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} version
   */
  insertInitialData(db, version) {
    // Config
    db.run('INSERT INTO Config (ConfigKey, Value) VALUES (1, "c3c89b66-5930-4aa2-8962-124561a5f8c1")');
    db.run('INSERT INTO Config (ConfigKey, Value) VALUES (2, ?)', [version]);

    // Types
    db.run('INSERT INTO Types (TypeKey, Code) VALUES (1, "Code")');
    db.run('INSERT INTO Types (TypeKey, Code) VALUES (2, "Part")');
    db.run('INSERT INTO Types (TypeKey, Code) VALUES (3, "AnswerList")');
    db.run('INSERT INTO Types (TypeKey, Code) VALUES (4, "Answer")');

    // Status codes
    const statusCodes = [
      [0, 'NotStated'], [1, 'ACTIVE'], [2, 'DEPRECATED'], [3, 'TRIAL'],
      [4, 'DISCOURAGED'], [5, 'EXAMPLE'], [6, 'PREFERRED'], [7, 'Primary'],
      [8, 'DocumentOntology'], [9, 'Radiology'], [10, 'NORMATIVE']
    ];
    statusCodes.forEach(([key, desc]) => {
      db.run('INSERT INTO StatusCodes (StatusKey, Description) VALUES (?, ?)', [key, desc]);
      this.statii.set(String(desc), Number(key));
    });

    // Relationship types
    const relationshipTypes = [
      [0, 'N/A'], [1, 'adjustment'], [2, 'challenge'], [3, 'CLASS'], [4, 'COMPONENT'],
      [5, 'count'], [6, 'analyte-divisor'], [7, 'document-kind'], [8, 'document-role'],
      [9, 'document-setting'], [10, 'document-subject-matter-domain'], [11, 'document-type-of-service'],
      [12, 'analyte-gene'], [13, 'METHOD_TYP'], [14, 'PROPERTY'], [15, 'rad-anatomic-location-imaging-focus'],
      [16, 'rad-guidance-for-action'], [17, 'rad-guidance-for-approach'], [18, 'rad-guidance-for-object'],
      [19, 'rad-guidance-for-presence'], [20, 'rad-maneuver-maneuver-type'], [21, 'rad-modality-modality-subtype'],
      [22, 'rad-modality-modality-type'], [23, 'rad-pharmaceutical-route'], [24, 'rad-pharmaceutical-substance-given'],
      [25, 'rad-reason-for-exam'], [26, 'rad-subject'], [27, 'rad-timing'], [28, 'rad-view-aggregation'],
      [29, 'rad-view-view-type'], [30, 'SCALE_TYP'], [31, 'analyte-suffix'], [32, 'super-system'],
      [33, 'SYSTEM'], [34, 'TIME_ASPCT'], [35, 'time-modifier'], [36, 'rad-anatomic-location-laterality'],
      [37, 'rad-anatomic-location-laterality-presence'], [38, 'rad-anatomic-location-region-imaged'],
      [39, 'AnswerList'], [40, 'Answer'], [41, 'answers-for'], [42, 'parent'], [43, 'child']
    ];
    relationshipTypes.forEach(([key, desc]) => {
      db.run('INSERT INTO RelationshipTypes (RelationshipTypeKey, Description) VALUES (?, ?)', [key, desc]);
      this.rels.set(String(desc), Number(key));
    });

    // Description types
    const descriptionTypes = [
      [1, 'LONG_COMMON_NAME'], [2, 'SHORTNAME'], [3, 'ConsumerName'],
      [4, 'RELATEDNAMES2'], [5, 'DisplayName'], [6, 'LinguisticVariantDisplayName']
    ];
    descriptionTypes.forEach(([key, desc]) => {
      db.run('INSERT INTO DescriptionTypes (DescriptionTypeKey, Description) VALUES (?, ?)', [key, desc]);
      this.dTypes.set(String(desc), Number(key));
    });

    // Property types
    const propertyTypes = [
      [1, 'CLASSTYPE'], [2, 'ORDER_OBS'], [3, 'EXAMPLE_UNITS'], [4, 'EXAMPLE_UCUM_UNITS'],
      [5, 'PanelType'], [6, 'AskAtOrderEntry'], [7, 'UNITSREQUIRED'], [9, 'Copyright'],
      [10, 'ValidHL7AttachmentRequest']
    ];
    propertyTypes.forEach(([key, desc]) => {
      db.run('INSERT INTO PropertyTypes (PropertyTypeKey, Description) VALUES (?, ?)', [key, desc]);
      this.props.set(String(desc), Number(key));
    });

    // Languages (English US is default)
    db.run('INSERT INTO Languages (LanguageKey, Code, Description) VALUES (1, "en-US", "English (United States)")');
    this.langs.set('en-US', 1);
  }

  /**
   * @param {string} sourceDir
   * @returns {Promise<string[]>}
   */
  async discoverLanguageVariants(sourceDir) {
    /** @type {string[]} */
    const languageVariants = [];
    const linguisticVariantsDir = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants');

    if (fs.existsSync(linguisticVariantsDir)) {
      const files = fs.readdirSync(linguisticVariantsDir);
      for (const file of files) {
        if (file.includes('LinguisticVariant.csv') && !file.startsWith('LinguisticVariants.csv')) {
          const match = file.match(/^([a-z]{2}[A-Z]{2})/);
          if (match) {
            const langCode = match[1].substring(0, 2) + '-' + match[1].substring(2);
            languageVariants.push(langCode);
          }
        }
      }
    }
    return languageVariants;
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} sourceDir
   * @param {number} step
   * @param {LoincImportOptions} options
   */
  async processLanguageVariants(db, sourceDir, step, options) {
    if (options.verbose) console.log('Processing Language Variants...');

    const filePath = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants/LinguisticVariants.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Language variants file not found: ${filePath}`);
      return;
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 4);
      if (items.length < 4) continue;

      const key = parseInt(items[0]);
      const langCode = items[1] + '-' + items[2];
      const description = items[3];

      db.run('INSERT INTO Languages (LanguageKey, Code, Description) VALUES (?, ?, ?)',
        [key, langCode, description]);
      this.langs.set(langCode, key);

      if (key > this.langKey) this.langKey = key;
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} sourceDir
   * @param {number} step
   * @param {LoincImportOptions} options
   */
  async processParts(db, sourceDir, step, options) {
    if (options.verbose) console.log('Processing Parts...');

    const filePath = path.join(sourceDir, 'AccessoryFiles/PartFile/Part.csv');
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let processedCount = 0;

    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 5);
      if (items.length < 5) continue;

      await this.processPartItem(db, items);
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }

    if (options.verbose) console.log(`  Processed ${processedCount} parts`);
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string[]} items
   */
  async processPartItem(db, items) {
    this.codeKey++;
    const codeKey = this.codeKey;
    const code = items[0];
    const type = 2;
    const relKey = this.rels.get(adjustPropName(items[1]));
    const description = items[2];
    const statusKey = this.statii.get(items[4]) || 0;

    db.run('INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, ?, ?, ?, ?, ?)',
      [codeKey, code, type, relKey, statusKey, description]);

    /** @type {LoincCodeInfo} */
    const codeInfo = { key: codeKey, children: new Set() };
    this.codes.set(code, codeInfo);
    this.codeList.push(codeInfo);
    this.partNames.set(items[1] + '.' + items[2], items[0]);

    this.addDescription(db, codeKey, 1, this.dTypes.get('DisplayName'), items[3]);
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} sourceDir
   * @param {number} step
   * @param {LoincImportOptions} options
   */
  async processCodes(db, sourceDir, step, options) {
    if (options.verbose) console.log('Processing Main Codes...');

    const filePath = path.join(sourceDir, 'LoincTable/Loinc.csv');
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let processedCount = 0;

    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 39);
      if (items.length < 39) continue;

      await this.processCodeItem(db, items);
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }

    if (options.verbose) console.log(`  Processed ${processedCount} main codes`);
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string[]} items
   */
  async processCodeItem(db, items) {
    this.codeKey++;
    const codeKey = this.codeKey;
    const code = removeQuotes(items[0]);
    const type = 1;
    const description = removeQuotes(items[25]);
    const statusKey = this.statii.get(items[11]) || 1;

    db.run('INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, ?, ?, ?, ?, ?)',
      [codeKey, code, type, null, statusKey, description]);

    /** @type {LoincCodeInfo} */
    const codeInfo = { key: codeKey, children: new Set() };
    this.codes.set(code, codeInfo);
    this.codeList.push(codeInfo);

    // Add CLASS relationship
    const clsCode = this.partNames.get('CLASS.' + items[7]);
    const clsInfo = clsCode ? this.codes.get(clsCode) : null;
    if (clsInfo) {
      this.addRelationship(db, codeKey, clsInfo.key, this.rels.get('CLASS'));
    }

    // Add properties
    this.addProperty(db, codeKey, this.props.get('CLASSTYPE'), descClassType(items[13]));
    this.addProperty(db, codeKey, this.props.get('ORDER_OBS'), items[21]);
    this.addProperty(db, codeKey, this.props.get('EXAMPLE_UNITS'), items[24]);
    this.addProperty(db, codeKey, this.props.get('EXAMPLE_UCUM_UNITS'), items[26]);
    this.addProperty(db, codeKey, this.props.get('PanelType'), items[34]);
    this.addProperty(db, codeKey, this.props.get('AskAtOrderEntry'), items[35]);
    this.addProperty(db, codeKey, this.props.get('UNITSREQUIRED'), items[18]);
    this.addProperty(db, codeKey, this.props.get('Copyright'), items[23]);
    this.addProperty(db, codeKey, this.props.get('ValidHL7AttachmentRequest'), items[38]);

    // Add descriptions
    this.addDescription(db, codeKey, 1, this.dTypes.get('LONG_COMMON_NAME'), description);
    this.addDescription(db, codeKey, 1, this.dTypes.get('ConsumerName'), items[12]);
    this.addDescription(db, codeKey, 1, this.dTypes.get('RELATEDNAMES2'), items[19]);
    this.addDescription(db, codeKey, 1, this.dTypes.get('SHORTNAME'), items[20]);
    this.addDescription(db, codeKey, 1, this.dTypes.get('DisplayName'), items[39]);
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} sourceDir
   * @param {number} step
   * @param {LoincImportOptions} options
   */
  async processConsumerNames(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/ConsumerName/ConsumerName.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Consumer names file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing Consumer Names...');

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 2);
      if (items.length < 2) continue;
      const codeInfo = this.codes.get(items[0]);
      if (!codeInfo) continue;

      this.addDescription(db, codeInfo.key, 1,
        this.dTypes.get('ConsumerName'), items[1]);
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} sourceDir
   * @param {number} step
   * @param {LoincImportOptions} options
   */
  async processLists(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/AnswerFile/AnswerList.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Answer lists file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing Answer Lists...');

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let processedCount = 0;
    let currentList = '';

    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 11);
      if (items.length < 11) continue;

      await this.processListItem(db, items, currentList);
      currentList = items[0];
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string[]} items
   * @param {string} currentList
   */
  async processListItem(db, items, currentList) {
    const listCode = removeQuotes(items[0]);
    let listCodeKey;

    if (listCode !== currentList) {
      this.codeKey++;
      listCodeKey = this.codeKey;
      const description = removeQuotes(items[1]);

      db.run('INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, ?, ?, ?, ?, ?)',
        [listCodeKey, listCode, 3, null, 0, description]);

      this.codes.set(listCode, { key: listCodeKey, children: new Set() });
    } else {
      const listInfo = this.codes.get(listCode);
      if (!listInfo) return;
      listCodeKey = listInfo.key;
    }

    const answerCode = removeQuotes(items[6]);
    let answerCodeKey;

    if (this.codes.has(answerCode)) {
      const answerInfo = this.codes.get(answerCode);
      if (!answerInfo) return;
      answerCodeKey = answerInfo.key;
    } else {
      this.codeKey++;
      answerCodeKey = this.codeKey;
      const description = removeQuotes(items[10]);

      db.run('INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, ?, ?, ?, ?, ?)',
        [answerCodeKey, answerCode, 4, null, 0, description]);

      this.codes.set(answerCode, { key: answerCodeKey, children: new Set() });
    }

    this.addRelationship(db, listCodeKey, answerCodeKey, this.rels.get('Answer'));
    this.addRelationship(db, answerCodeKey, listCodeKey, this.rels.get('AnswerList'));
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} sourceDir
   * @param {number} step
   * @param {LoincImportOptions} options
   */
  async processPartLinks(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/PartFile/LoincPartLink_Primary.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Part links file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing Part Links...');

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 7);
      if (items.length < 7) continue;

      const sourceCode = items[0];
      const targetCode = items[2];
      const relType = adjustPropName(items[5]);
      const status = items[6];

      const sourceInfo = this.codes.get(sourceCode);
      const targetInfo = this.codes.get(targetCode);
      if (sourceInfo && targetInfo) {
        this.addRelationship(db,
          sourceInfo.key,
          targetInfo.key,
          this.rels.get(relType),
          this.statii.get(status) || 0
        );
      }
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} sourceDir
   * @param {number} step
   * @param {LoincImportOptions} options
   */
  async processListLinks(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/AnswerFile/LoincAnswerListLink.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`List links file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing List Links...');

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 5);
      if (items.length < 5) continue;

      const sourceCode = items[0];
      const targetCode = items[2];
      const status = items[4];

      const sourceInfo = this.codes.get(sourceCode);
      const targetInfo = this.codes.get(targetCode);
      if (sourceInfo && targetInfo) {
        const statusKey = this.statii.get(status) || 0;
        this.addRelationship(db,
          sourceInfo.key,
          targetInfo.key,
          this.rels.get('AnswerList'),
          statusKey
        );
        this.addRelationship(db,
          targetInfo.key,
          sourceInfo.key,
          this.rels.get('answers-for'),
          statusKey
        );
      }
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} sourceDir
   * @param {number} step
   * @param {LoincImportOptions} options
   */
  async processHierarchy(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/ComponentHierarchyBySystem/ComponentHierarchyBySystem.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Hierarchy file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing Hierarchy...');

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 12);
      if (items.length < 5) continue;

      await this.processHierarchyItem(db, items);
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string[]} items
   */
  async processHierarchyItem(db, items) {
    const pathCode = items[3];
    const parentPath = items[2];
    const description = items[4];

    if (!this.codes.has(pathCode)) {
      this.codeKey++;
      const codeKey = this.codeKey;

      db.run('INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, ?, ?, ?, ?, ?)',
        [codeKey, pathCode, 2, 0, 0, description]);

      /** @type {LoincCodeInfo} */
      const codeInfo = { key: codeKey, children: new Set() };
      this.codes.set(pathCode, codeInfo);
      this.codeList.push(codeInfo);
    }

    if (!parentPath) {
      db.run('INSERT INTO Config (ConfigKey, Value) VALUES (3, ?)', [pathCode]);
    } else {
      const childInfo = this.codes.get(pathCode);
      const parentInfo = this.codes.get(parentPath);
      if (!childInfo || !parentInfo) return;
      const childKey = childInfo.key;
      const parentKey = parentInfo.key;

      this.addRelationship(db, childKey, parentKey, this.rels.get('parent'));
      this.addRelationship(db, parentKey, childKey, this.rels.get('child'));

      const pathParts = items[0].split('.');
      for (const ancestorCode of pathParts) {
        const ancestorInfo = this.codes.get(ancestorCode);
        if (ancestorInfo) {
          ancestorInfo.children.add(childKey);
        }
      }
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {number} step
   * @param {LoincImportOptions} options
   */
  async processPropertyValues(db, step, options) {
    if (options.verbose) console.log('Processing Property Values...');

    for (const [value, key] of this.propValues) {
      db.run('INSERT INTO PropertyValues (PropertyValueKey, Value) VALUES (?, ?)', [key, value]);
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {number} step
   * @param {LoincImportOptions} options
   */
  async storeClosureTable(db, step, options) {
    if (options.verbose) console.log('Storing Closure Table...');

    let count = 0;
    for (const codeInfo of this.codeList) {
      count++;

      if (codeInfo.children.size > 0) {
        for (const descendentKey of codeInfo.children) {
          db.run('INSERT INTO Closure (AncestorKey, DescendentKey) VALUES (?, ?)',
            [codeInfo.key, descendentKey]);
        }
      }

      if (count % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = count % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {string} sourceDir
   * @param {number} step
   * @param {string} langCode
   * @param {LoincImportOptions} options
   */
  async processLanguage(db, sourceDir, step, langCode, options) {
    if (options.verbose) console.log(`Processing Language ${langCode}...`);

    const langKey = this.langs.get(langCode);
    if (!langKey) return;

    const baseCode = langCode.replace('-', '');
    const fileName = `${baseCode}${langKey}LinguisticVariant.csv`;
    const filePath = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants', fileName);

    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Language file not found: ${filePath}`);
      return;
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 12);
      if (items.length < 12) continue;
      const codeInfo = this.codes.get(items[0]);
      if (!codeInfo) continue;

      const codeKey = codeInfo.key;

      this.addDescription(db, codeKey, langKey, this.dTypes.get('LONG_COMMON_NAME'), items[9]);
      this.addDescription(db, codeKey, langKey, this.dTypes.get('RELATEDNAMES2'), items[10]);
      this.addDescription(db, codeKey, langKey, this.dTypes.get('SHORTNAME'), items[8]);
      this.addDescription(db, codeKey, langKey, this.dTypes.get('LinguisticVariantDisplayName'), items[11]);

      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  /**
   * @param {SqliteDatabase} db
   * @param {number} codeKey
   * @param {number} languageKey
   * @param {number | undefined} descriptionType
   * @param {string | undefined} value
   */
  addDescription(db, codeKey, languageKey, descriptionType, value) {
    if (!value) return;

    this.descKey++;
    db.run('INSERT INTO Descriptions (DescriptionKey, CodeKey, LanguageKey, DescriptionTypeKey, Value) VALUES (?, ?, ?, ?, ?)',
      [this.descKey, codeKey, languageKey, descriptionType, value]);

    db.run('INSERT INTO TextIndex (codekey, type, lang, text) VALUES (?, ?, ?, ?)',
      [codeKey, descriptionType, languageKey, value]);
  }

  /**
   * @param {SqliteDatabase} db
   * @param {number} codeKey
   * @param {number | undefined} propertyType
   * @param {string | undefined} value
   */
  addProperty(db, codeKey, propertyType, value) {
    if (!value || !propertyType) return;

    this.propKey++;
    const propertyValueKey = this.getPropertyValueKey(value);

    db.run('INSERT INTO Properties (PropertyKey, PropertyTypeKey, CodeKey, PropertyValueKey) VALUES (?, ?, ?, ?)',
      [this.propKey, propertyType, codeKey, propertyValueKey]);
  }

  /**
   * @param {SqliteDatabase} db
   * @param {number} sourceKey
   * @param {number} targetKey
   * @param {number | undefined} relationshipType
   * @param {number} [statusKey]
   */
  addRelationship(db, sourceKey, targetKey, relationshipType, statusKey = 0) {
    if (!relationshipType) return;

    this.relKey++;
    db.run('INSERT INTO Relationships (RelationshipKey, RelationshipTypeKey, SourceKey, TargetKey, StatusKey) VALUES (?, ?, ?, ?, ?)',
      [this.relKey, relationshipType, sourceKey, targetKey, statusKey]);
  }

  /**
   * @param {string} value
   * @returns {number}
   */
  getPropertyValueKey(value) {
    if (this.propValues.has(value)) {
      return /** @type {number} */ (this.propValues.get(value));
    }

    this.propValueKey++;
    this.propValues.set(value, this.propValueKey);
    return this.propValueKey;
  }

  /**
   * @param {SqliteDatabase} db
   * @param {boolean} [verbose]
   * @returns {Promise<void>}
   */
  async closeDatabase(db, verbose = true) {
    /** @type {Promise<void>} */
    return new Promise((resolve) => {
      db.close((/** @type {Error | null} */ err) => {
        if (err && verbose) {
          console.error('Error closing database:', err);
        }
        resolve();
      });
    });
  }
}

// Property name mappings from Pascal code
const KNOWN_PROPERTY_NAMES = [
  'AskAtOrderEntry', 'AssociatedObservations', 'CHANGE_REASON_PUBLIC', 'CHNG_TYPE', 'CLASS', 'CLASSTYPE', 'COMMON_ORDER_RANK', 'COMMON_TEST_RANK', 'COMPONENT', 'CONSUMER_NAME',
  'DefinitionDescription', 'DisplayName', 'EXAMPLE_UCUM_UNITS', 'EXAMPLE_UNITS', 'EXMPL_ANSWERS', 'EXTERNAL_COPYRIGHT_LINK', 'EXTERNAL_COPYRIGHT_NOTICE', 'FORMULA',
  'HL7_ATTACHMENT_STRUCTURE', 'HL7_FIELD_SUBFIELD_ID', 'LONG_COMMON_NAME', 'MAP_TO', 'METHOD_TYP', 'ORDER_OBS', 'PROPERTY', 'PanelType', 'RELATEDNAMES2', 'SCALE_TYP',
  'SHORTNAME', 'STATUS', 'STATUS_REASON', 'STATUS_TEXT', 'SURVEY_QUEST_SRC', 'SURVEY_QUEST_TEXT', 'SYSTEM', 'TIME_ASPCT', 'UNITSREQUIRED', 'ValidHL7AttachmentRequest',
  'VersionFirstReleased', 'VersionLastChanged', 'adjustment', 'analyte', 'analyte-core', 'analyte-divisor', 'analyte-divisor-suffix', 'analyte-gene', 'analyte-numerator',
  'analyte-suffix', 'answer-list', 'answers-for', 'category', 'challenge', 'child', 'count', 'document-kind', 'document-role', 'document-setting', 'document-subject-matter-domain',
  'document-type-of-service', 'parent', 'rad-anatomic-location-imaging-focus', 'rad-anatomic-location-laterality', 'rad-anatomic-location-laterality-presence', 'rad-anatomic-location-region-imaged',
  'rad-guidance-for-action', 'rad-guidance-for-approach', 'rad-guidance-for-object', 'rad-guidance-for-presence', 'rad-maneuver-maneuver-type', 'rad-modality-modality-subtype',
  'rad-modality-modality-type', 'rad-pharmaceutical-route', 'rad-pharmaceutical-substance-given', 'rad-reason-for-exam', 'rad-subject', 'rad-timing', 'rad-view-aggregation',
  'rad-view-view-type', 'search', 'super-system', 'system-core', 'time-core', 'time-modifier',
  'Answer', 'AnswerList'
];

/**
 * @param {string} s
 * @returns {string}
 */
function adjustPropName(s) {
  if (KNOWN_PROPERTY_NAMES.includes(s)) {
    return s;
  }

  /** @type {Record<string, string>} */
  const mappings = {
    'ADJUSTMENT': 'adjustment',
    'CHALLENGE': 'challenge',
    'COUNT': 'count',
    'DIVISORS': 'analyte-divisor',
    'Document.Kind': 'document-kind',
    'Document.Role': 'document-role',
    'Document.Setting': 'document-setting',
    'Document.SubjectMatterDomain': 'document-subject-matter-domain',
    'Document.TypeOfService': 'document-type-of-service',
    'GENE': 'analyte-gene',
    'METHOD': 'METHOD_TYP',
    'Rad.Anatomic Location.Imaging Focus': 'rad-anatomic-location-imaging-focus',
    'Rad.Anatomic Location.Laterality': 'rad-anatomic-location-laterality',
    'Rad.Anatomic Location.Laterality.Presence': 'rad-anatomic-location-laterality-presence',
    'Rad.Anatomic Location.Region Imaged': 'rad-anatomic-location-region-imaged',
    'Rad.Guidance for.Action': 'rad-guidance-for-action',
    'Rad.Guidance for.Approach': 'rad-guidance-for-approach',
    'Rad.Guidance for.Object': 'rad-guidance-for-object',
    'Rad.Guidance for.Presence': 'rad-guidance-for-presence',
    'Rad.Maneuver.Maneuver Type': 'rad-maneuver-maneuver-type',
    'Rad.Modality.Modality Subtype': 'rad-modality-modality-subtype',
    'Rad.Modality.Modality Type': 'rad-modality-modality-type',
    'Rad.Pharmaceutical.Route': 'rad-pharmaceutical-route',
    'Rad.Pharmaceutical.Substance Given': 'rad-pharmaceutical-substance-given',
    'Rad.Reason for Exam': 'rad-reason-for-exam',
    'Rad.Subject': 'rad-subject',
    'Rad.Timing': 'rad-timing',
    'Rad.View.Aggregation': 'rad-view-aggregation',
    'Rad.View.View Type': 'rad-view-view-type',
    'SCALE': 'SCALE_TYP',
    'SUFFIX': 'analyte-suffix',
    'SUPER SYSTEM': 'super-system',
    'TIME': 'TIME_ASPCT',
    'TIME MODIFIER': 'time-modifier'
  };

  if (mappings[s]) {
    return mappings[s];
  }

  throw new Error(`Unknown Property Name: ${s}`);
}

/**
 * @param {string} s
 * @returns {string}
 */
function descClassType(s) {
  /** @type {Record<string, string>} */
  const types = {
    '1': 'Laboratory class',
    '2': 'Clinical class',
    '3': 'Claims attachment',
    '4': 'Surveys'
  };
  return types[s] || s;
}

// CSV parsing utility
/**
 * @param {string} line
 * @param {number} expectedCount
 * @returns {string[]}
 */
function csvSplit(line, expectedCount) {
  const result = new Array(expectedCount).fill('');
  let inQuoted = false;
  let currentField = 0;
  let fieldStart = 0;
  let i = 0;

  while (i < line.length && currentField < expectedCount) {
    const ch = line[i];

    if (!inQuoted && ch === ',') {
      if (currentField < expectedCount) {
        result[currentField] = line.substring(fieldStart, i).replace(/^"|"$/g, '').replace(/""/g, '"');
        currentField++;
        fieldStart = i + 1;
      }
    } else if (ch === '"') {
      if (inQuoted && i + 1 < line.length && line[i + 1] === '"') {
        i++;
      } else {
        inQuoted = !inQuoted;
      }
    }
    i++;
  }

  if (currentField < expectedCount) {
    result[currentField] = line.substring(fieldStart).replace(/^"|"$/g, '').replace(/""/g, '"');
  }

  return result;
}

/**
 * @param {string | undefined} str
 * @returns {string}
 */
function removeQuotes(str) {
  if (!str) return '';
  return str.replace(/^"|"$/g, '');
}

module.exports = {
  LoincModule,
  LoincDataMigrator
};
