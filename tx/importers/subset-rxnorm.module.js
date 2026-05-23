// @ts-check

const { BaseTerminologyModule } = require('./tx-import-base');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');

/** @typedef {{requiredFiles: string[], optionalFiles: string[], codeCount: number, uniqueCodes: number, warnings: string[]}} SubsetValidationStats */
/** @typedef {{source: string, dest: string, handler: string}} RrfSubsetFile */

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class RxNormSubsetModule extends BaseTerminologyModule {
  constructor() {
    super();
  }

  getName() {
    return 'rxnorm-subset';
  }

  getDescription() {
    return 'Create a subset of RxNorm data for testing purposes';
  }

  getSupportedFormats() {
    return ['directory', 'txt'];
  }

  getDefaultConfig() {
    return {
      ...super.getDefaultConfig(),
      dest: './rxnorm-subset',
      expandRelationships: true,
      includeSynonyms: false,
      includeArchived: false,
      maxIterations: 5
    };
  }

  getEstimatedDuration() {
    return '10-30 minutes (depending on relationship expansion)';
  }

  /**
   * @param {any} terminologyCommand
   * @param {Record<string, any>} globalOptions
   */
  registerCommands(terminologyCommand, globalOptions) {
    // Subset command
    terminologyCommand
      .command('subset')
      .description('Create an RxNorm subset from a list of codes')
      .option('-s, --source <directory>', 'Source RxNorm directory (RRF files)')
      .option('-d, --dest <directory>', 'Destination directory for subset')
      .option('-c, --codes <file>', 'Text file with RxNorm codes (one per line)')
      .option('--no-expand', 'Skip relationship expansion')
      .option('--include-synonyms', 'Include synonym (SY) terms')
      .option('--include-archived', 'Include archived concepts')
      .option('--max-iterations <n>', 'Maximum relationship expansion iterations', '5')
      .option('-y, --yes', 'Skip confirmations')
      .action(async (/** @type {Record<string, any>} */ options) => {
        await this.handleSubsetCommand({...globalOptions, ...options});
      });

    // Validate command
    terminologyCommand
      .command('validate')
      .description('Validate subset inputs')
      .option('-s, --source <directory>', 'Source RxNorm directory to validate')
      .option('-c, --codes <file>', 'Codes file to validate')
      .action(async (/** @type {Record<string, any>} */ options) => {
        await this.handleValidateCommand({...globalOptions, ...options});
      });
  }

  /**
   * @param {Record<string, any>} options
   */
  async handleSubsetCommand(options) {
    try {
      // Gather configuration
      const config = await this.gatherSubsetConfig(options);

      // Show confirmation unless --yes is specified
      if (!options.yes) {
        const confirmed = await this.confirmSubset(config);
        if (!confirmed) {
          this.logInfo('Subset operation cancelled');
          return;
        }
      }

      // Save configuration
      this.rememberSuccessfulConfig(config);

      // Run the subset operation
      await this.runSubset(config);
    } catch (error) {
      this.logError(`Subset operation failed: ${errorMessage(error)}`);
      if (options.verbose) {
        console.error(error instanceof Error ? error.stack : error);
      }
      throw error;
    }
  }

  /**
   * @param {Record<string, any>} options
   * @returns {Promise<Record<string, any>>}
   */
  async gatherSubsetConfig(options) {
    const terminology = this.getName();
    const smartDefaults = this.configManager.generateDefaults(terminology);
    const recentSources = this.configManager.getRecentSources(terminology, 3);

    const questions = [];

    // Source directory
    if (!options.source) {
      /** @type {Record<string, any>} */
      const sourceQuestion = {
        type: 'input',
        name: 'source',
        message: 'Source RxNorm directory (RRF files):',
        validate: (/** @type {string} */ input) => {
          if (!input) return 'Source directory is required';
          if (!fs.existsSync(input)) return 'Source directory does not exist';
          return true;
        },
        filter: (/** @type {string} */ input) => path.resolve(input)
      };

      if (smartDefaults.source) {
        sourceQuestion.default = smartDefaults.source;
      }

      if (recentSources.length > 0) {
        sourceQuestion.type = 'list';
        sourceQuestion.choices = [
          ...recentSources.map((/** @type {string} */ src) => ({
            name: `${src} ${src === smartDefaults.source ? '(last used)' : ''}`.trim(),
            value: src
          })),
          { name: 'Enter new path...', value: 'NEW_PATH' }
        ];
        sourceQuestion.message = 'Select source RxNorm directory:';
      }

      questions.push(sourceQuestion);

      if (recentSources.length > 0) {
        questions.push({
          type: 'input',
          name: 'source',
          message: 'Enter new source path:',
          when: (/** @type {Record<string, any>} */ answers) => answers.source === 'NEW_PATH',
          validate: (/** @type {string} */ input) => {
            if (!input) return 'Source directory is required';
            if (!fs.existsSync(input)) return 'Source directory does not exist';
            return true;
          },
          filter: (/** @type {string} */ input) => path.resolve(input)
        });
      }
    }

    // Destination directory
    if (!options.dest) {
      questions.push({
        type: 'input',
        name: 'dest',
        message: 'Destination directory for subset:',
        default: smartDefaults.dest || './rxnorm-subset',
        validate: (/** @type {string} */ input) => {
          if (!input) return 'Destination directory is required';
          return true;
        },
        filter: (/** @type {string} */ input) => path.resolve(input)
      });
    }

    // Codes file - default to /tx/data/rxnorm-subset if it exists
    if (!options.codes) {
      const defaultCodesFile = '/tx/data/rxnorm-subset';
      questions.push({
        type: 'input',
        name: 'codes',
        message: 'Codes file (one code per line):',
        default: fs.existsSync(defaultCodesFile) ? defaultCodesFile : smartDefaults.codes,
        validate: (/** @type {string} */ input) => {
          if (!input) return 'Codes file is required';
          if (!fs.existsSync(input)) return 'Codes file does not exist';
          return true;
        },
        filter: (/** @type {string} */ input) => path.resolve(input)
      });
    }

    // Overwrite confirmation
    questions.push({
      type: 'confirm',
      name: 'overwrite',
      message: 'Overwrite destination directory if it exists?',
      default: smartDefaults.overwrite !== undefined ? smartDefaults.overwrite : false,
      when: (/** @type {Record<string, any>} */ answers) => {
        const destPath = options.dest || answers.dest;
        return fs.existsSync(destPath);
      }
    });

    // Expansion options
    questions.push({
      type: 'confirm',
      name: 'expandRelationships',
      message: 'Expand codes based on relationships (ingredients, forms, etc.)?',
      default: smartDefaults.expandRelationships !== undefined ? smartDefaults.expandRelationships : true
    });

    questions.push({
      type: 'confirm',
      name: 'includeSynonyms',
      message: 'Include synonym (SY) terms?',
      default: smartDefaults.includeSynonyms !== undefined ? smartDefaults.includeSynonyms : false
    });

    questions.push({
      type: 'confirm',
      name: 'includeArchived',
      message: 'Include archived concepts?',
      default: smartDefaults.includeArchived !== undefined ? smartDefaults.includeArchived : false
    });

    questions.push({
      type: 'confirm',
      name: 'verbose',
      message: 'Show verbose output?',
      default: smartDefaults.verbose !== undefined ? smartDefaults.verbose : true
    });

    const answers = await require('inquirer').prompt(questions);

    const finalConfig = {
      ...this.getDefaultConfig(),
      ...smartDefaults,
      ...options,
      ...answers,
      expandRelationships: !options.noExpand && (answers.expandRelationships !== false),
      includeSynonyms: options.includeSynonyms || answers.includeSynonyms,
      includeArchived: options.includeArchived || answers.includeArchived,
      maxIterations: parseInt(options.maxIterations) || 5
    };

    return finalConfig;
  }

  /**
   * @param {Record<string, any>} config
   * @returns {Promise<boolean>}
   */
  async confirmSubset(config) {
    console.log(chalk.cyan(`\n📋 RxNorm Subset Configuration:`));
    console.log(`  Source: ${chalk.white(config.source)}`);
    console.log(`  Destination: ${chalk.white(config.dest)}`);
    console.log(`  Codes File: ${chalk.white(config.codes)}`);
    console.log(`  Expand Relationships: ${chalk.white(config.expandRelationships ? 'Yes' : 'No')}`);
    console.log(`  Include Synonyms: ${chalk.white(config.includeSynonyms ? 'Yes' : 'No')}`);
    console.log(`  Include Archived: ${chalk.white(config.includeArchived ? 'Yes' : 'No')}`);
    console.log(`  Max Iterations: ${chalk.white(config.maxIterations)}`);
    console.log(`  Overwrite: ${chalk.white(config.overwrite ? 'Yes' : 'No')}`);

    if (config.estimatedDuration) {
      console.log(`  Estimated Duration: ${chalk.white(config.estimatedDuration)}`);
    }

    const { confirmed } = await require('inquirer').prompt({
      type: 'confirm',
      name: 'confirmed',
      message: 'Proceed with subset creation?',
      default: true
    });

    return confirmed;
  }

  /**
   * @param {Record<string, any>} config
   */
  async runSubset(config) {
    try {
      console.log(chalk.blue.bold(`🧬 Starting RxNorm Subset Creation...\n`));

      // Pre-flight checks
      this.logInfo('Running pre-flight checks...');
      const prerequisitesPassed = await this.validateSubsetPrerequisites(config);

      if (!prerequisitesPassed) {
        throw new Error('Pre-flight checks failed');
      }

      // Execute the subset creation
      await this.executeSubset(config);

      this.logSuccess('RxNorm subset created successfully!');

    } catch (error) {
      this.stopProgress();
      this.logError(`RxNorm subset creation failed: ${errorMessage(error)}`);
      if (config.verbose) {
        console.error(error instanceof Error ? error.stack : error);
      }
      throw error;
    }
  }

  /**
   * @param {Record<string, any>} options
   */
  async handleValidateCommand(options) {
    if (!options.source || !options.codes) {
      const answers = await require('inquirer').prompt([
        {
          type: 'input',
          name: 'source',
          message: 'Source RxNorm directory:',
          when: !options.source,
          validate: (/** @type {string} */ input) => input && fs.existsSync(input) ? true : 'Directory does not exist'
        },
        {
          type: 'input',
          name: 'codes',
          message: 'Codes file:',
          when: !options.codes,
          validate: (/** @type {string} */ input) => input && fs.existsSync(input) ? true : 'File does not exist'
        }
      ]);
      Object.assign(options, answers);
    }

    this.logInfo('Validating subset inputs...');

    try {
      const stats = await this.validateSubsetInputs(options.source, options.codes);

      this.logSuccess('Validation passed');
      console.log(`  Required files found: ${stats.requiredFiles.length}/3`);
      console.log(`  Optional files found: ${stats.optionalFiles.length}/3`);
      console.log(`  Codes in list: ${stats.codeCount.toLocaleString()}`);
      console.log(`  Unique codes: ${stats.uniqueCodes.toLocaleString()}`);

      if (stats.warnings.length > 0) {
        this.logWarning('Validation warnings:');
        stats.warnings.forEach((warning) => console.log(`    ${warning}`));
      }

    } catch (error) {
      this.logError(`Validation failed: ${errorMessage(error)}`);
    }
  }

  /**
   * @param {Record<string, any>} config
   * @returns {Promise<boolean>}
   */
  async validateSubsetPrerequisites(config) {
    const checks = [
      {
        name: 'Source directory exists',
        check: () => fs.existsSync(config.source)
      },
      {
        name: 'Codes file exists',
        check: () => fs.existsSync(config.codes)
      },
      {
        name: 'Source contains RxNorm RRF files',
        check: () => {
          const requiredFiles = ['RXNCONSO.RRF', 'RXNREL.RRF', 'RXNSTY.RRF'];
          return requiredFiles.every(file =>
            fs.existsSync(path.join(config.source, file))
          );
        }
      }
    ];

    let allPassed = true;

    for (const { name, check } of checks) {
      try {
        const passed = await check();
        if (passed) {
          this.logSuccess(name);
        } else {
          this.logError(name);
          allPassed = false;
        }
      } catch (error) {
        this.logError(`${name}: ${errorMessage(error)}`);
        allPassed = false;
      }
    }

    return allPassed;
  }

  /**
   * @param {Record<string, any>} config
   */
  async executeSubset(config) {
    this.logInfo('Loading target codes...');

    // Load initial target codes
    const initialTargetCodes = await this.loadTargetCodes(config.codes);
    this.logInfo(`Loaded ${initialTargetCodes.size.toLocaleString()} initial target codes`);

    if (config.verbose) {
      const sampleCodes = Array.from(initialTargetCodes).slice(0, 10);
      console.log(`Sample codes: ${sampleCodes.join(', ')}`);
    }

    let finalTargetCodes = initialTargetCodes;

    // Expand target codes based on relationships if requested
    if (config.expandRelationships) {
      this.logInfo('Expanding target codes based on RxNorm relationships...');

      const expander = new RxNormRelationshipExpander(
        config.source,
        config.verbose,
        config.maxIterations
      );

      finalTargetCodes = await expander.expandCodes(initialTargetCodes);

      const addedCodes = finalTargetCodes.size - initialTargetCodes.size;
      this.logInfo(`Added ${addedCodes.toLocaleString()} related codes through relationship expansion`);

      if (config.verbose && addedCodes > 0) {
        const newCodes = Array.from(finalTargetCodes).filter((/** @type {string} */ code) => !initialTargetCodes.has(code));
        const sampleNewCodes = newCodes.slice(0, 10);
        console.log(`Sample newly added codes: ${sampleNewCodes.join(', ')}`);
      }
    }

    this.logInfo(`Final target codes: ${finalTargetCodes.size.toLocaleString()}`);

    // Export final codes for inspection
    if (config.verbose) {
      const codesOutputPath = path.join(process.cwd(), 'rxnorm-final-target-codes.txt');
      await this.exportCodesToFile(finalTargetCodes, codesOutputPath);
    }

    // Create subset processor
    const processor = new RxNormSubsetProcessor(this, config.verbose);

    await processor.createSubset(
      config.source,
      config.dest,
      finalTargetCodes,
      {
        verbose: config.verbose,
        overwrite: config.overwrite,
        includeSynonyms: config.includeSynonyms,
        includeArchived: config.includeArchived
      }
    );
  }

  /**
   * @param {string} codesFile
   * @returns {Promise<Set<string>>}
   */
  async loadTargetCodes(codesFile) {
    const codes = new Set();

    const rl = readline.createInterface({
      input: fs.createReadStream(codesFile),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      const trimmedLine = line.trim();

      // Skip empty lines and comments
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue;
      }

      // Extract code (everything before # if there's an inline comment)
      const code = trimmedLine.split('#')[0].trim();
      if (code) {
        codes.add(code);
      }
    }

    return codes;
  }

  /**
   * @param {Set<string>} codeSet
   * @param {string} filePath
   */
  async exportCodesToFile(codeSet, filePath) {
    const sortedCodes = Array.from(codeSet).sort();
    const content = sortedCodes.join('\n') + '\n';

    fs.writeFileSync(filePath, content, 'utf8');
    this.logInfo(`Exported ${sortedCodes.length.toLocaleString()} codes to ${filePath}`);
  }

  /**
   * @param {string} sourceDir
   * @param {string} codesFile
   * @returns {Promise<SubsetValidationStats>}
   */
  async validateSubsetInputs(sourceDir, codesFile) {
    /** @type {SubsetValidationStats} */
    const stats = {
      requiredFiles: [],
      optionalFiles: [],
      codeCount: 0,
      uniqueCodes: 0,
      warnings: []
    };

    // Check for RxNorm RRF files
    const requiredFiles = ['RXNCONSO.RRF', 'RXNREL.RRF', 'RXNSTY.RRF'];
    const optionalFiles = ['RXNSAB.RRF', 'RXNATOMARCHIVE.RRF', 'RXNCUI.RRF'];

    for (const file of requiredFiles) {
      const filePath = path.join(sourceDir, file);
      if (fs.existsSync(filePath)) {
        stats.requiredFiles.push(file);
      } else {
        stats.warnings.push(`Required file not found: ${file}`);
      }
    }

    for (const file of optionalFiles) {
      const filePath = path.join(sourceDir, file);
      if (fs.existsSync(filePath)) {
        stats.optionalFiles.push(file);
      } else {
        stats.warnings.push(`Optional file not found: ${file}`);
      }
    }

    // Validate codes file
    const codes = await this.loadTargetCodes(codesFile);
    stats.codeCount = codes.size;
    stats.uniqueCodes = codes.size;

    return stats;
  }
}

// RxNorm relationship expander
class RxNormRelationshipExpander {
  /** @type {string} */
  sourceDir;
  /** @type {boolean} */
  verbose;
  /** @type {number} */
  maxIterations;
  /** @type {Set<string>} */
  inwardRelationships;
  /** @type {Set<string>} */
  inwardRels;

  /**
   * @param {string} sourceDir
   * @param {boolean} [verbose]
   * @param {number} [maxIterations]
   */
  constructor(sourceDir, verbose = false, maxIterations = 5) {
    this.sourceDir = sourceDir;
    this.verbose = verbose;
    this.maxIterations = maxIterations;

    // Relationships that define components/ingredients of target codes (inward expansion)
    this.inwardRelationships = new Set([
      'has_ingredient',
      'has_form',
      'has_dose_form',
      'form_of',
      'ingredient_of',
      'consists_of',
      'contains'
    ]);

    // REL codes for inward relationships
    this.inwardRels = new Set(['RN', 'IN']); // Ingredient relationships
  }

  /**
   * @param {Set<string>} initialCodes
   * @returns {Promise<Set<string>>}
   */
  async expandCodes(initialCodes) {
    if (this.verbose) {
      console.log(`    Starting relationship expansion with ${initialCodes.size} codes`);
    }

    /** @type {Set<string>} */
    let currentCodes = new Set(initialCodes);
    let iteration = 0;

    while (iteration < this.maxIterations) {
      iteration++;
      const sizeBefore = currentCodes.size;

      if (this.verbose) {
        console.log(`    Iteration ${iteration}: Starting with ${sizeBefore} codes`);
      }

      const newCodes = await this.findRelatedCodes(currentCodes);

      // Add new codes to current set
      for (const code of newCodes) {
        currentCodes.add(code);
      }

      const sizeAfter = currentCodes.size;
      const added = sizeAfter - sizeBefore;

      if (this.verbose) {
        console.log(`    Iteration ${iteration}: Added ${added} codes (total: ${sizeAfter})`);
      }

      // Stop if no new codes were found
      if (added === 0) {
        if (this.verbose) {
          console.log(`    Expansion converged after ${iteration} iterations`);
        }
        break;
      }
    }

    return currentCodes;
  }

  /**
   * @param {Set<string>} targetCodes
   * @returns {Promise<Set<string>>}
   */
  async findRelatedCodes(targetCodes) {
    /** @type {Set<string>} */
    const relatedCodes = new Set();
    const rxnrelPath = path.join(this.sourceDir, 'RXNREL.RRF');

    if (!fs.existsSync(rxnrelPath)) {
      if (this.verbose) {
        console.log(`    RXNREL file not found: ${rxnrelPath}`);
      }
      return relatedCodes;
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(rxnrelPath),
      crlfDelay: Infinity
    });

    let processedLines = 0;
    let matchedRelationships = 0;

    for await (const line of rl) {
      processedLines++;

      const items = line.split('|');
      if (items.length < 11) continue;

      const rxcui1 = items[0];  // Source concept
      const rel = items[3];     // Relationship type
      const rxcui2 = items[4];  // Target concept
      const rela = items[7];    // Specific relationship
      const sab = items[10];    // Source

      // Focus on RXNORM relationships
      if (sab !== 'RXNORM') continue;

      // Find inward relationships - where our target codes are the "complex" concept
      // and we want to include their "simple" components
      if (targetCodes.has(rxcui1)) {
        // Target code is source - include target (RXCUI2) for inward relationships
        if (this.isInwardRelationship(rel, rela)) {
          relatedCodes.add(rxcui2);
          matchedRelationships++;
        }
      }

      // Also check reverse relationships - if our target is a component,
      // include the complex concept that contains it
      if (targetCodes.has(rxcui2)) {
        // Target code is target - include source (RXCUI1) for outward relationships
        if (this.isReverseInwardRelationship(rel, rela)) {
          relatedCodes.add(rxcui1);
          matchedRelationships++;
        }
      }

      if (processedLines % 100000 === 0 && this.verbose) {
        console.log(`      Processed ${processedLines} relationships, found ${matchedRelationships} matches`);
      }
    }

    if (this.verbose) {
      console.log(`    Found ${relatedCodes.size} related codes from ${matchedRelationships} relationships`);
    }

    return relatedCodes;
  }

  /**
   * @param {string} rel
   * @param {string} rela
   * @returns {boolean}
   */
  isInwardRelationship(rel, rela) {
    // REL-based relationships
    if (this.inwardRels.has(rel)) {
      return true;
    }

    // RELA-based relationships (more specific)
    if (rela && this.inwardRelationships.has(rela)) {
      return true;
    }

    // Other common inward relationship patterns
    const inwardPatterns = [
      'has_ingredient',
      'has_active_ingredient',
      'has_precise_ingredient',
      'has_form',
      'has_dose_form',
      'contains',
      'consists_of'
    ];

    return !!(rela && inwardPatterns.some((pattern) => rela.includes(pattern)));
  }

  /**
   * @param {string} rel
   * @param {string} rela
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  isReverseInwardRelationship(rel, rela) {
    // These are relationships where if our target is RXCUI2,
    // we want to include RXCUI1 as it helps define our target
    const reversePatterns = [
      'ingredient_of',
      'form_of',
      'active_ingredient_of',
      'precise_ingredient_of',
      'contained_in',
      'part_of'
    ];

    return !!(rela && reversePatterns.some((pattern) => rela.includes(pattern)));
  }
}

// RxNorm subset processor
class RxNormSubsetProcessor {
  /** @type {RxNormSubsetModule} */
  module;
  /** @type {boolean} */
  verbose;
  /** @type {Set<string> | null} */
  targetCodes;
  /** @type {number} */
  processedFiles;
  /** @type {number} */
  totalFiles;

  /**
   * @param {RxNormSubsetModule} moduleInstance
   * @param {boolean} [verbose]
   */
  constructor(moduleInstance, verbose = true) {
    this.module = moduleInstance;
    this.verbose = verbose;
    this.targetCodes = null;
    this.processedFiles = 0;
    this.totalFiles = 0;
  }

  /**
   * @param {string} sourceDir
   * @param {string} destDir
   * @param {Set<string>} targetCodes
   * @param {Record<string, any>} options
   */
  async createSubset(sourceDir, destDir, targetCodes, options) {
    this.targetCodes = targetCodes;

    // Create destination directory structure
    await this.createDirectoryStructure(destDir, options.overwrite);

    // Define RRF files to process
    /** @type {RrfSubsetFile[]} */
    const filesToProcess = [
      {
        source: 'RXNCONSO.RRF',
        dest: 'RXNCONSO.RRF',
        handler: 'processRXNCONSO'
      },
      {
        source: 'RXNREL.RRF',
        dest: 'RXNREL.RRF',
        handler: 'processRXNREL'
      },
      {
        source: 'RXNSTY.RRF',
        dest: 'RXNSTY.RRF',
        handler: 'processRXNSTY'
      },
      {
        source: 'RXNSAB.RRF',
        dest: 'RXNSAB.RRF',
        handler: 'processRXNSAB'
      },
      {
        source: 'RXNCUI.RRF',
        dest: 'RXNCUI.RRF',
        handler: 'processRXNCUI'
      }
    ];

    // Conditionally add archived file
    if (options.includeArchived) {
      filesToProcess.push({
        source: 'RXNATOMARCHIVE.RRF',
        dest: 'RXNATOMARCHIVE.RRF',
        handler: 'processRXNATOMARCHIVE'
      });
    }

    // Count existing files
    this.totalFiles = filesToProcess.filter((file) =>
      fs.existsSync(path.join(sourceDir, file.source))
    ).length;

    this.module.logInfo(`Processing ${this.totalFiles} RRF files...`);
    this.module.createProgressBar();
    this.module.updateProgress(0, this.totalFiles);

    // Process each file
    for (const file of filesToProcess) {
      const sourcePath = path.join(sourceDir, file.source);
      const destPath = path.join(destDir, file.dest);

      if (fs.existsSync(sourcePath)) {
        if (this.verbose) {
          this.module.logInfo(`Processing ${file.source}...`);
        }

        const handler = /** @type {(sourcePath: string, destPath: string, options: Record<string, any>) => Promise<void>} */ (/** @type {any} */ (this)[file.handler].bind(this));
        await handler(sourcePath, destPath, options);
        this.processedFiles++;
        this.module.updateProgress(this.processedFiles);
      }
    }

    this.module.stopProgress();

    // Generate subset statistics
    await this.generateSubsetStats(destDir, targetCodes);
  }

  /**
   * @param {string} destDir
   * @param {boolean} overwrite
   */
  async createDirectoryStructure(destDir, overwrite) {
    if (fs.existsSync(destDir)) {
      if (overwrite) {
        fs.rmSync(destDir, { recursive: true, force: true });
      } else {
        throw new Error(`Destination directory already exists: ${destDir}`);
      }
    }

    fs.mkdirSync(destDir, { recursive: true });
  }

  /**
   * @param {string} sourcePath
   * @param {string} destPath
   * @param {Record<string, any>} options
   */
  async processRXNCONSO(sourcePath, destPath, options) {
    await this.processRRFFile(sourcePath, destPath, (items) => {
      const rxcui = items[0];
      const tty = items[12];

      // Include if RXCUI is in target set
      if (this.targetCodes && this.targetCodes.has(rxcui)) {
        // Optionally filter out synonyms
        if (!options.includeSynonyms && tty === 'SY') {
          return false;
        }
        return true;
      }

      return false;
    });
  }

  /**
   * @param {string} sourcePath
   * @param {string} destPath
   */
  async processRXNREL(sourcePath, destPath) {
    await this.processRRFFile(sourcePath, destPath, (items) => {
      const rxcui1 = items[0];
      const rxcui2 = items[4];

      // Include if either RXCUI is in target set
      return !!this.targetCodes && (this.targetCodes.has(rxcui1) || this.targetCodes.has(rxcui2));
    });
  }

  /**
   * @param {string} sourcePath
   * @param {string} destPath
   */
  async processRXNSTY(sourcePath, destPath) {
    await this.processRRFFile(sourcePath, destPath, (items) => {
      const rxcui = items[0];
      return !!this.targetCodes && this.targetCodes.has(rxcui);
    });
  }

  /**
   * @param {string} sourcePath
   * @param {string} destPath
   */
  async processRXNSAB(sourcePath, destPath) {
    // For RXNSAB, we need to find which sources are referenced
    // First pass: collect all SABs referenced in target concepts
    const referencedSabs = await this.findReferencedSabs(sourcePath.replace('RXNSAB.RRF', 'RXNCONSO.RRF'));

    await this.processRRFFile(sourcePath, destPath, (items) => {
      const rsab = items[3]; // RSAB field
      return referencedSabs.has(rsab);
    });
  }

  /**
   * @param {string} sourcePath
   * @param {string} destPath
   */
  async processRXNCUI(sourcePath, destPath) {
    await this.processRRFFile(sourcePath, destPath, (items) => {
      const cui1 = items[0];
      const cui2 = items[4];

      // Include if either CUI is in target set
      return !!this.targetCodes && (this.targetCodes.has(cui1) || (!!cui2 && this.targetCodes.has(cui2)));
    });
  }

  /**
   * @param {string} sourcePath
   * @param {string} destPath
   */
  async processRXNATOMARCHIVE(sourcePath, destPath) {
    await this.processRRFFile(sourcePath, destPath, (items) => {
      const rxcui = items[12]; // RXCUI field in archive
      return !!(rxcui && this.targetCodes && this.targetCodes.has(rxcui));
    });
  }

  /**
   * @param {string} rxnconsoPath
   * @returns {Promise<Set<string>>}
   */
  async findReferencedSabs(rxnconsoPath) {
    /** @type {Set<string>} */
    const referencedSabs = new Set();

    if (!fs.existsSync(rxnconsoPath)) {
      return referencedSabs;
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(rxnconsoPath),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      const items = line.split('|');
      if (items.length < 12) continue;

      const rxcui = items[0];
      const sab = items[11];

      if (this.targetCodes && this.targetCodes.has(rxcui)) {
        referencedSabs.add(sab);
      }
    }

    return referencedSabs;
  }

  /**
   * @param {string} sourcePath
   * @param {string} destPath
   * @param {(items: string[]) => boolean} filterFunction
   */
  async processRRFFile(sourcePath, destPath, filterFunction) {
    const readStream = fs.createReadStream(sourcePath);
    const writeStream = fs.createWriteStream(destPath);

    const rl = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity
    });

    let lineNum = 0;
    let includedLines = 0;

    for await (const line of rl) {
      lineNum++;

      const items = line.split('|');

      if (filterFunction(items)) {
        writeStream.write(line + '\n');
        includedLines++;
      }
    }

    writeStream.end();

    if (this.verbose && lineNum > 0) {
      const filename = path.basename(sourcePath);
      console.log(`    Included ${includedLines.toLocaleString()} of ${lineNum.toLocaleString()} lines in ${filename}`);
    }
  }

  /**
   * @param {string} destDir
   * @param {Set<string>} targetCodes
   */
  async generateSubsetStats(destDir, targetCodes) {
    /** @type {{originalTargetCodes: number, timestamp: string, files: Record<string, number>}} */
    const stats = {
      originalTargetCodes: targetCodes.size,
      timestamp: new Date().toISOString(),
      files: {}
    };

    // Count lines in each output file
    const files = fs.readdirSync(destDir);
    for (const file of files) {
      if (file.endsWith('.RRF')) {
        const filePath = path.join(destDir, file);
        const lineCount = await this.countLines(filePath);
        stats.files[file] = lineCount;
      }
    }

    // Write stats file
    const statsPath = path.join(destDir, 'subset-stats.json');
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));

    this.module.logInfo(`Subset statistics written to ${statsPath}`);
  }

  /**
   * @param {string} filePath
   * @returns {Promise<number>}
   */
  async countLines(filePath) {
    return new Promise((/** @type {(value: number) => void} */ resolve, reject) => {
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

module.exports = {
  RxNormSubsetModule
};
