// @ts-check

//
// TX Module - FHIR Terminology Server
//
// This module provides FHIR terminology services (CodeSystem, ValueSet, ConceptMap)
// with support for multiple endpoints at different FHIR versions.
//

const express = require('express');
const path = require('path');
const Logger = /** @type {any} */ (require('../library/logger'));
const libraryModule = require('./library');
const Library = /** @type {any} */ (libraryModule.Library);
const operationContextModule = require('./operation-context');
const OperationContext = /** @type {any} */ (operationContextModule.OperationContext);
const ResourceCache = /** @type {any} */ (operationContextModule.ResourceCache);
const ExpansionCache = /** @type {any} */ (operationContextModule.ExpansionCache);
const debugLog = /** @type {any} */ (operationContextModule.debugLog);
const languageModule = require('../library/languages');
const LanguageDefinitions = /** @type {any} */ (languageModule.LanguageDefinitions);
const i18nModule = require('../library/i18nsupport');
const I18nSupport = /** @type {any} */ (i18nModule.I18nSupport);
const codeSystemXmlModule = require('./xml/codesystem-xml');
const CodeSystemXML = /** @type {any} */ (codeSystemXmlModule.CodeSystemXML);
const txHtml = require('./tx-html');
const { Liquid } = require('liquidjs');
const packageJson = require("../package.json");

// Import workers
const ReadWorker = /** @type {any} */ (require('./workers/read'));
const SearchWorker = /** @type {any} */ (require('./workers/search'));
const expandModule = require('./workers/expand');
const ExpandWorker = /** @type {any} */ (expandModule.ExpandWorker);
const INTERNAL_DEFAULT_LIMIT = /** @type {number} */ (expandModule.INTERNAL_DEFAULT_LIMIT);
const EXTERNAL_TEST_DEFAULT_LIMIT = /** @type {number} */ (expandModule.EXTERNAL_TEST_DEFAULT_LIMIT);
const validateModule = require('./workers/validate');
const ValidateWorker = /** @type {any} */ (validateModule.ValidateWorker);
const TranslateWorker = /** @type {any} */ (require('./workers/translate'));
const LookupWorker = /** @type {any} */ (require('./workers/lookup'));
const SubsumesWorker = /** @type {any} */ (require('./workers/subsumes'));
const metadataModule = require('./workers/metadata');
const MetadataHandler = /** @type {any} */ (metadataModule.MetadataHandler);
const batchValidateModule = require('./workers/batch-validate');
const BatchValidateWorker = /** @type {any} */ (batchValidateModule.BatchValidateWorker);
const capabilityXmlModule = require("./xml/capabilitystatement-xml");
const CapabilityStatementXML = /** @type {any} */ (capabilityXmlModule.CapabilityStatementXML);
const terminologyCapabilitiesXmlModule = require("./xml/terminologycapabilities-xml");
const TerminologyCapabilitiesXML = /** @type {any} */ (terminologyCapabilitiesXmlModule.TerminologyCapabilitiesXML);
const parametersXmlModule = require("./xml/parameters-xml");
const ParametersXML = /** @type {any} */ (parametersXmlModule.ParametersXML);
const operationOutcomeXmlModule = require("./xml/operationoutcome-xml");
const OperationOutcomeXML = /** @type {any} */ (operationOutcomeXmlModule.OperationOutcomeXML);
const valueSetXmlModule = require("./xml/valueset-xml");
const ValueSetXML = /** @type {any} */ (valueSetXmlModule.ValueSetXML);
const conceptMapXmlModule = require("./xml/conceptmap-xml");
const ConceptMapXML = /** @type {any} */ (conceptMapXmlModule.ConceptMapXML);
const txHtmlModule = require("./tx-html");
const TxHtmlRenderer = /** @type {any} */ (txHtmlModule.TxHtmlRenderer);
const rendererModule = require("./library/renderer");
const Renderer = /** @type {any} */ (rendererModule.Renderer);
const operationsModule = require("./workers/operations");
const OperationsWorker = /** @type {any} */ (operationsModule.OperationsWorker);
const relatedModule = require("./workers/related");
const RelatedWorker = /** @type {any} */ (relatedModule.RelatedWorker);
const {codeSystemFromR5} = require("./xversion/xv-codesystem");
const {operationOutcomeFromR5} = require("./xversion/xv-operationoutcome");
const {parametersFromR5} = require("./xversion/xv-parameters");
const {conceptMapFromR5} = require("./xversion/xv-conceptmap");
const {valueSetFromR5} = require("./xversion/xv-valueset");
const {terminologyCapabilitiesFromR5} = require("./xversion/xv-terminologyCapabilities");
const {capabilityStatementFromR5} = require("./xversion/xv-capabiliityStatement");
const {bundleFromR5} = require("./xversion/xv-bundle");
const {convertResourceToR5} = require("./xversion/xv-resource");
const ClosureWorker = /** @type {any} */ (require("./workers/closure"));
const bundleXmlModule = require("./xml/bundle-xml");
const BundleXML = /** @type {any} */ (bundleXmlModule.BundleXML);
const ConceptUsageTracker = /** @type {any} */ (require("./usage-tracker"));
const ProblemFinder = /** @type {any} */ (require("./problems"));
// const {writeFileSync} = require("fs");

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class TXModule {
  /** @type {NodeJS.Timeout[]} */
  timers = [];

  /**
   * @param {any} stats
   */
  constructor(stats) {
    /** @type {any} */
    this.config = null;
    /** @type {any} */
    this.library = null;
    /** @type {any[]} */
    this.endpoints = [];
    /** @type {Map<string, any>} */
    this.routers = new Map(); // path -> router
    this.requestIdCounter = 0; // Thread-safe request ID counter
    /** @type {any} */
    this.languages = null; // LanguageDefinitions
    /** @type {any} */
    this.i18n = null; // I18nSupport
    /** @type {any} */
    this.metadataHandler = null; // MetadataHandler
    this.liquid = new Liquid({
      root: path.join(__dirname, 'html'),  // optional: where to look for templates
      extname: '.liquid'    // optional: default extension
    });
    this.stats = stats;
    /** @type {any} */
    this.log = console;
    /** @type {any} */
    this.usageTracker = null;
    if (stats) {
      stats.cachingModules.push(this);
    }
  }

  /**
   * Generate a unique request ID
   * @returns {string} Unique request ID
   */
  generateRequestId() {
    this.requestIdCounter++;
    return `tx-${this.requestIdCounter}`;
  }

  /**
   * @param {any} req
   * @returns {string | null}
   */
  acceptsXml(req) {
    let _fmt = req.query._format || req.query.format || req.body?._format;
    if (_fmt && typeof _fmt !== 'string') {
      _fmt = null;
    }
    if (_fmt && _fmt == 'xml') {
      return 'application/fhir+xml';
    }
    if (!_fmt) {
      _fmt = req.headers.accept || '';
    }
    if (_fmt.includes('application/fhir+xml')) {
      return 'application/fhir+xml';
    } else if (_fmt.includes('application/xml+fhir')) {
      return 'application/xml+fhir';
    } else if (_fmt.includes('application/xml')) {
      return 'application/xml';
    } else {
      return null;
    }
  }

  /**
   * @param {any} req
   * @returns {string}
   */
  acceptsJson(req) {
    let _fmt = req.query._format || req.query.format || req.body?._format;
    if (_fmt && typeof _fmt !== 'string') {
      _fmt = null;
    }
    if (_fmt && _fmt == 'json') {
      return 'application/fhir+json';
    }
    if (!_fmt) {
      _fmt = req.headers.accept || '';
    }
    if (_fmt.includes('application/fhir+json')) {
      return 'application/fhir+json';
    } else if (_fmt.includes('application/json+fhir')) {
      return 'application/json+fhir';
    } else if (_fmt.includes('application/json')) {
      return 'application/json';
    } else {
      return 'application/fhir+json';
    }
  }

  /**
   * Initialize the TX module
   * @param {Record<string, any>} config - Module configuration
   * @param {any} app - Express application for registering endpoints
   */
  async initialize(config, app) {
    this.config = config;
    // Initialize logger with config settings
    this.log = Logger.getInstance().child({
      module: 'tx',
      consoleErrors: config.consoleErrors,
      telnetErrors: config.telnetErrors
    });
    this.usageTracker = new ConceptUsageTracker();

    this.log.info('Initializing TX module');

    // Load HTML template
    txHtml.loadTemplate();

    // Validate config
    if (!config.librarySource) {
      throw new Error('TX module requires librarySource configuration');
    }

    if (!config.endpoints || !Array.isArray(config.endpoints) || config.endpoints.length === 0) {
      throw new Error('TX module requires at least one endpoint configuration');
    }

    // Load language definitions
    const langPath = path.join(__dirname, 'data');
    this.log.info(`Loading language definitions from: ${langPath}`);
    this.languages = await LanguageDefinitions.fromFiles(langPath);
    this.log.info('Language definitions loaded');

    // Initialize i18n support
    const translationsPath = path.join(__dirname, '..', 'translations');
    this.log.info(`Loading translations from: ${translationsPath}`);
    this.i18n = new I18nSupport(translationsPath, this.languages);
    await this.i18n.load();
    this.log.info('I18n support initialized');

    // Initialize metadata handler with config
    this.metadataHandler = new MetadataHandler({
      baseUrl: config.baseUrl,
      serverVersion: packageJson.version,
      txVersion: packageJson.txVersion,
      softwareName: config.softwareName || 'FHIRsmith',
      name: config.name || 'FHIRTerminologyServer',
      title: config.title || 'FHIR Terminology Server',
      description: config.description || 'FHIR Terminology Server',
      contactUrl: config.contactUrl,
      contact: config.contact,
      releaseDate: config.releaseDate,
      host: config.host ? config.host : "localhost"
    });

    // Load the library from YAML
    this.log.info(`Loading library from: ${config.librarySource}`);
    this.library = new Library(config.librarySource, config.vsacCfg, this.log, this.stats);
    this.log.info(`Load...`);
    await this.library.load();
    this.log.info('Library loaded successfully');

    // Set up each endpoint
    for (const endpoint of config.endpoints) {
      await this.setupEndpoint(endpoint, app);
    }

    this.log.info(`TX module initialized with ${config.endpoints.length} endpoint(s)`);

    // Self-test: verify metadata generation works for each endpoint before accepting traffic
    await this.selfTest();
  }

  /**
   * Set up a single endpoint
   * @param {Record<string, any>} endpoint - Endpoint configuration {path, fhirVersion, context}
   * @param {any} app - Express application
   */
  async setupEndpoint(endpoint, app) {
    const { path: endpointPath, context } = endpoint;
    const fhirVersion = String(endpoint.fhirVersion);

    if (!endpointPath) {
      throw new Error('Endpoint requires a path');
    }

    if (!fhirVersion) {
      throw new Error(`Endpoint ${endpointPath} requires a fhirVersion`);
    }

    // Check for path conflicts
    if (this.routers.has(endpointPath)) {
      throw new Error(`Duplicate endpoint path: ${endpointPath}`);
    }

    this.log.info(`Setting up endpoint: ${endpointPath} (FHIR v${fhirVersion}, context: ${context || 'none'})`);

    const router = express.Router();

    // Get cache configuration
    const cacheTimeoutMinutes = this.config.cacheTimeout || 30;
    const expansionCacheSize = this.config.expansionCacheSize || 1000;
    const expansionCacheMemoryThreshold = this.config.expansionCacheMemoryThreshold || 0;

    // Store endpoint info for provider creation
    /** @type {Record<string, any>} */
    const endpointInfo = {
      path: endpointPath,
      fhirVersion,
      context: context || null,
      resourceCache: new ResourceCache(this.stats),
      expansionCache: new ExpansionCache(this.stats, expansionCacheSize, expansionCacheMemoryThreshold)
    };
    // Create the provider once for this endpoint
    endpointInfo.provider = await this.library.cloneWithFhirVersion(fhirVersion, context, endpointPath);

    // Set up periodic pruning of the resource cache
    // cacheTimeout is in minutes, default to 30 minutes
    const cacheTimeoutMs = cacheTimeoutMinutes * 60 * 1000;
    const pruneIntervalMs = 5 * 60 * 1000; // Run every 5 minutes
    if (this.stats) {
      this.stats.addTask("Client Cache", "5 min");
    }
    this.timers.push(setInterval(async () => {
      try {
        await endpointInfo.provider.updateCodeSystemList();
      } catch (error) {
        this.log.error(`Error updating CodeSystem list for ${endpointPath}: ${errorMessage(error)}`);
      }
    }, 60 * 1000));
    this.log.info(`CodeSystem list update scheduled for ${endpointPath}`);
    this.timers.push(setInterval(() => {
      endpointInfo.resourceCache.prune(cacheTimeoutMs);
    }, pruneIntervalMs));
    this.log.info(`Resource cache pruning enabled for ${endpointPath}: timeout ${cacheTimeoutMinutes} minutes, check interval 5 minutes`);

    // Set up periodic memory pressure check for expansion cache (if threshold configured)
    if (expansionCacheMemoryThreshold > 0) {
      if (this.stats) {
        this.stats.addTask("Expansion Cache", "5 min");
      }
      this.timers.push(setInterval(() => {
        if (endpointInfo.expansionCache.checkMemoryPressure()) {
          this.log.info(`Expansion cache memory pressure detected for ${endpointPath}, evicted oldest half`);
        }
      }, pruneIntervalMs));
      this.log.info(`Expansion cache for ${endpointPath}: max ${expansionCacheSize} entries, memory threshold ${expansionCacheMemoryThreshold}MB`);
    } else {
      this.log.info(`Expansion cache for ${endpointPath}: max ${expansionCacheSize} entries, no memory threshold`);
    }

    // Middleware to attach provider, context, and timing to request, and wrap res.json for HTML
    router.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      // Increment request count
      endpointInfo.provider.requestCount++;

      // Generate unique request ID
      const requestId = this.generateRequestId();

      // Get Accept-Language header for language preferences
      const acceptLanguage = req.get('Accept-Language') || 'en';

      // Create operation context with language, ID, time limit, and caches
      const opContext = new OperationContext(
        acceptLanguage, this.i18n, requestId, 30,
        endpointInfo.resourceCache, endpointInfo.expansionCache
      );
      opContext.usageTracker = this.usageTracker;

      // Attach everything to request
      req.txProvider = endpointInfo.provider;
      req.txEndpoint = endpointInfo;
      req.txStartTime = Date.now();
      req.txOpContext = opContext;
      req.txLanguages = this.languages;
      req.txI18n = this.i18n;
      req.txLog = this.log;

      // Release any code-system providers that opened sqlite connections
      // during this request. closeProviders() is idempotent so it's safe
      // for both events to fire. Listeners are sync; the close itself
      // runs fire-and-forget on the event loop.
      const releaseProviders = () => {
        opContext.closeProviders().catch((/** @type {unknown} */ err) => {
          try { this.log.warn(`closeProviders failed: ${errorMessage(err)}`); } catch (_) { /* ignore */ }
        });
      };
      res.on('finish', releaseProviders);
      res.on('close', releaseProviders);

      // Add X-Request-Id header to response
      res.setHeader('X-Request-Id', requestId);

      // Wrap res.json to intercept and convert to HTML if browser requests it, and log the request
      const originalJson = res.json.bind(res);

      let txhtml = new TxHtmlRenderer(new Renderer(opContext, endpointInfo.provider), this.liquid, this.languages, this.i18n, endpointInfo.path, endpointInfo.fhirVersion);
      res.json = async (/** @type {any} */ data) => {
        try {
          const duration = Date.now() - req.txStartTime;
          const isHtml = txhtml.acceptsHtml(req);
          const xmlFmt = this.acceptsXml(req);
          const jsonFmt = this.acceptsJson(req);
          data = this.transformResourceForVersion(data, endpointInfo.fhirVersion);

          let responseSize;
          let result;

          if (isHtml) {
            const title = txhtml.buildTitle(data, req);
            const content = await txhtml.render(data, req);
            const html = await txhtml.renderPage(title, content, req.txEndpoint, req.txStartTime);
            responseSize = Buffer.byteLength(html, 'utf8');
            res.setHeader('Content-Type', 'text/html');
            result = res.send(html);
          } else if (xmlFmt) {
            try {
              const xml = this.convertResourceToXml(data, endpointInfo.fhirVersion);
              responseSize = Buffer.byteLength(xml, 'utf8');
              res.setHeader('Content-Type', xmlFmt);
              result = res.send(xml);
            } catch (err) {
              console.error(err);
              // Fall back to JSON if XML conversion not supported
              this.log.warn(`XML conversion failed for ${data.resourceType}: ${errorMessage(err)}, falling back to JSON`);
              res.setHeader('Content-Type', jsonFmt);
              const jsonStr = JSON.stringify(data);
              responseSize = Buffer.byteLength(jsonStr, 'utf8');
              result = originalJson(data);
            }
          } else {
            const jsonStr = JSON.stringify(data);
            res.setHeader('Content-Type', jsonFmt);
            this.checkProperJson(jsonStr);
            responseSize = Buffer.byteLength(jsonStr, 'utf8');
            result = originalJson(data);
          }

          // Log the request with request ID
          const format = isHtml ? 'html' : (xmlFmt ? 'xml' : 'json');
          let li = req.logInfo ? "(" + req.logInfo + ")" : "";
          this.log.info(`[${requestId}] ${req.method} ${format} ${res.statusCode} ${duration}ms ${responseSize}: ${req.originalUrl} ${li})`);

          return result;
        } catch (err) {
          this.log.error(`Error rendering response: ${errorMessage(err)}`);
          console.error(err);
          res.status(500).send('Internal Server Error');
        }
      };

      next();
    });

    // CORS headers
    router.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    // JSON body parsing - accept both application/json and application/fhir+json
    // Handle body that may already be read as a Buffer by app-level middleware
    router.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      const contentType = req.get('Content-Type') || '';

      // Only process POST/PUT
      if (req.method !== 'POST' && req.method !== 'PUT') {
        return next();
      }

      if (contentType.includes('application/json') ||
        contentType.includes('application/fhir+json') ||
        contentType.includes('application/json+fhir')) {

        // If body is a Buffer, parse it
        if (Buffer.isBuffer(req.body)) {
          try {
            const bodyStr = req.body.toString('utf8');
            if (bodyStr) {
              req.body = JSON.parse(bodyStr);
            }
          } catch (e) {
            this.log.error(`JSON parse error: ${errorMessage(e)}`);
            return res.status(400).json({
              resourceType: 'OperationOutcome',
              issue: [{
                severity: 'error',
                code: 'invalid',
                diagnostics: `Invalid JSON: ${errorMessage(e)}`
              }]
            });
          }
        }

      } else if (contentType.includes('application/xml') ||
        // Handle XML
        contentType.includes('application/fhir+xml') ||
        contentType.includes('application/xml+fhir')) {

        let xmlStr;
        if (Buffer.isBuffer(req.body)) {
          xmlStr = req.body.toString('utf8');
        } else if (typeof req.body === 'string') {
          xmlStr = req.body;
        }

        if (xmlStr) {
          try {
            req.body = this.convertXmlToResource(xmlStr);
          } catch (e) {
            this.log.error(`XML parse error: ${errorMessage(e)}`);
            return res.status(400).json({
              resourceType: 'OperationOutcome',
              issue: [{
                severity: 'error',
                code: 'invalid',
                diagnostics: `Invalid XML: ${errorMessage(e)}`
              }]
            });
          }
        }
      } else if (contentType != 'application/x-www-form-urlencoded') {
        return res.status(415).json({
          resourceType: 'OperationOutcome',
          issue: [{
            severity: 'error',
            code: 'invalid',
            diagnostics: `Unsupported Media Type: ${contentType}`
          }]
        });
      }

      if (req.body) {
        req.body = convertResourceToR5(req.body, req.txEndpoint.fhirVersion);
      }
      next();
    });

    app.use(express.urlencoded({ extended: true }));

    // Set up routes
    this.setupRoutes(router);

    // Redirect /r5 → /r5/
    app.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      if (req.path === endpointPath) {
        return res.redirect(301, endpointPath + '/');
      }
      next();
    });

    // Register the router with the app
    app.use(endpointPath, router);
    this.routers.set(endpointPath, router);
    this.endpoints.push(endpointInfo);

    this.log.info(`Endpoint ${endpointPath} registered`);
  }

  /**
   * Set up routes for an endpoint
   * @param {any} router - Express router
   */
  setupRoutes(router) {
    const resourceTypes = ['CodeSystem', 'ValueSet', 'ConceptMap'];

    // ===== Operations =====


    // CodeSystem/$lookup (GET and POST)
    router.get('/CodeSystem/\\$lookup', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new LookupWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$lookup', Date.now() - start);
      }
    });
    router.post('/CodeSystem/\\$lookup', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new LookupWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$lookup', Date.now() - start);
      }
    });

    // CodeSystem/$subsumes (GET and POST)
    router.get('/CodeSystem/\\$subsumes', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new SubsumesWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$subsumes', Date.now() - start);
      }
    });
    router.post('/CodeSystem/\\$subsumes', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new SubsumesWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$subsumes', Date.now() - start);
      }
    });

    // CodeSystem/$validate-code (GET and POST)
    router.get('/CodeSystem/\\$validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleCodeSystem(req, res);
      } finally {
        this.countRequest('$validate', Date.now() - start);
      }
    });
    router.post('/CodeSystem/\\$validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleCodeSystem(req, res);
      } finally {
        this.countRequest('$validate', Date.now() - start);
      }
    });

    // CodeSystem/$batch-validate-code (GET and POST)
    router.get('/CodeSystem/\\$batch-validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new BatchValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleCodeSystem(req, res);
      } finally {
        this.countRequest('$batch', Date.now() - start);
      }
    });
    router.post('/CodeSystem/\\$batch-validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new BatchValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleCodeSystem(req, res);
      } finally {
        this.countRequest('$batch', Date.now() - start);
      }
    });
    // ValueSet/$validate-code (GET and POST)
    router.get('/ValueSet/\\$validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleValueSet(req, res);
      } finally {
        this.countRequest('$validate', Date.now() - start);
      }
    });
    router.post('/ValueSet/\\$validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleValueSet(req, res);
      } finally {
        this.countRequest('$validate', Date.now() - start);
      }
    });

    // ValueSet/$related(GET and POST)
    router.get('/ValueSet/\\$related', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new RelatedWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$related', Date.now() - start);
      }
    });
    router.post('/ValueSet/\\$related', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new RelatedWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$related', Date.now() - start);
      }
    });

    // ValueSet/$batch-validate-code (GET and POST)
    router.get('/ValueSet/\\$batch-validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new BatchValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleValueSet(req, res);
      } finally {
        this.countRequest('$batch', Date.now() - start);
      }
    });
    router.post('/ValueSet/\\$batch-validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new BatchValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleValueSet(req, res);
      } finally {
        this.countRequest('validate', Date.now() - start);
      }
    });

    // ValueSet/$expand (GET and POST)
    router.get('/ValueSet/\\$expand', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ExpandWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n, this.internalLimit(req), this.externalLimit(req));
        await worker.handle(req, res);
      } finally {
        this.countRequest('$expand', Date.now() - start);
      }
    });
    router.post('/ValueSet/\\$expand', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ExpandWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n, this.internalLimit(req), this.externalLimit(req));
        await worker.handle(req, res);
      } finally {
        this.countRequest('$expand', Date.now() - start);
      }
    });

    // ConceptMap/$translate (GET and POST)
    router.get('/ConceptMap/\\$translate', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new TranslateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$translate', Date.now() - start);
      }
    });
    router.post('/ConceptMap/\\$translate', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new TranslateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$translate', Date.now() - start);
      }
    });

    // ConceptMap/$closure (GET and POST)
    router.get('/ConceptMap/\\$closure', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ClosureWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$closure', Date.now() - start);
      }
    });
    router.post('/ConceptMap/\\$closure', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ClosureWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$closure', Date.now() - start);
      }
    });

    // ===== Instance operations =====

    // CodeSystem/[id]/$lookup
    router.get('/CodeSystem/:id/\\$lookup', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new LookupWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleInstance(req, res);
      } finally {
        this.countRequest('$lookup', Date.now() - start);
      }
    });
    router.post('/CodeSystem/:id/\\$lookup', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new LookupWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleInstance(req, res);
      } finally {
        this.countRequest('$lookup', Date.now() - start);
      }
    });

    // CodeSystem/[id]/$subsumes
    router.get('/CodeSystem/:id/\\$subsumes', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new SubsumesWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleInstance(req, res);
      } finally {
        this.countRequest('$subsumes', Date.now() - start);
      }
    });
    router.post('/CodeSystem/:id/\\$subsumes', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new SubsumesWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleInstance(req, res);
      } finally {
        this.countRequest('$subsumes', Date.now() - start);
      }
    });

    // CodeSystem/[id]/$validate-code
    router.get('/CodeSystem/:id/\\$validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleCodeSystemInstance(req, res);
      } finally {
        this.countRequest('$validate', Date.now() - start);
      }
    });
    router.post('/CodeSystem/:id/\\$validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleCodeSystemInstance(req, res);
      } finally {
        this.countRequest('$validate', Date.now() - start);
      }

    });

    // ValueSet/[id]/$validate-code
    router.get('/ValueSet/:id/\\$validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleValueSetInstance(req, res);
      } finally {
        this.countRequest('$validate', Date.now() - start);
      }
    });
    router.post('/ValueSet/:id/\\$validate-code', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ValidateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleValueSetInstance(req, res);
      } finally {
        this.countRequest('$validate', Date.now() - start);
      }
    });


    // ValueSet/[id]/$related
    router.get('/ValueSet/:id/\\$related', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new RelatedWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleInstance(req, res);
      } finally {
        this.countRequest('$related', Date.now() - start);
      }
    });
    router.post('/ValueSet/:id/\\$related', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new RelatedWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleInstance(req, res);
      } finally {
        this.countRequest('$related', Date.now() - start);
      }
    });

    // ValueSet/[id]/$expand
    router.get('/ValueSet/:id/\\$expand', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ExpandWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n, this.internalLimit(req), this.externalLimit(req));
        await worker.handleInstance(req, res);
      } finally {
        this.countRequest('$expand', Date.now() - start);
      }
    });
    router.post('/ValueSet/:id/\\$expand', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new ExpandWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n, this.internalLimit(req), this.externalLimit(req));
        await worker.handleInstance(req, res);
      } finally {
        this.countRequest('$expand', Date.now() - start);
      }
    });

    // ConceptMap/[id]/$translate
    router.get('/ConceptMap/:id/\\$translate', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new TranslateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleInstance(req, res);
      } finally {
        this.countRequest('$translate', Date.now() - start);
      }
    });
    router.post('/ConceptMap/:id/\\$translate', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new TranslateWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handleInstance(req, res);
      } finally {
        this.countRequest('$translate', Date.now() - start);
      }
    });

    // ===== Read and Search =====

    // Read: GET /[type]/[id]
    for (const resourceType of resourceTypes) {
      router.get(`/${resourceType}/:id`, async (/** @type {any} */ req, /** @type {any} */ res) => {
        const start = Date.now();
        try {
          // Skip if id starts with $ (it's an operation)
          if (req.params.id.startsWith('$')) {
            return res.status(404).json(this.operationOutcome(
              'error',
              'not-found',
              `Unknown operation: ${req.params.id}`
            ));
          }
          let worker = new ReadWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
          await worker.handle(req, res, resourceType);
        } finally {
          this.countRequest('read', Date.now() - start);
        }
      });
    }

    // Search: GET /[type]
    for (const resourceType of resourceTypes) {
      router.get(`/${resourceType}`, async (/** @type {any} */ req, /** @type {any} */ res) => {
        const start = Date.now();
        try {
          let worker = new SearchWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
          await worker.handle(req, res, resourceType);
        } finally {
          this.countRequest('search', Date.now() - start);
        }
      });
      router.post(`/${resourceType}/_search`, async (/** @type {any} */ req, /** @type {any} */ res) => {
        const start = Date.now();
        try {
          let worker = new SearchWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
          await worker.handle(req, res, resourceType);
        } finally {
          this.countRequest('search', Date.now() - start);
        }
      });
    }

    // Unsupported methods
    for (const resourceType of resourceTypes) {
      router.all(`/${resourceType}/:id`, (/** @type {any} */ req, /** @type {any} */ res) => {
        const start = Date.now();
        try {
          if (['PUT', 'POST', 'DELETE', 'PATCH'].includes(req.method)) {
            return res.status(405).json(this.operationOutcome(
              'error',
              'not-supported',
              `Method ${req.method} is not supported`
            ));
          }
        } finally {
          this.countRequest('$read', Date.now() - start);
        }
      });
    }

    router.get('/op.html',  async(/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let worker = new OperationsWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
        await worker.handle(req, res);
      } finally {
        this.countRequest('$op', Date.now() - start);
      }
    });

    router.get('/problems.html', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        let txhtml = new TxHtmlRenderer(new Renderer(req.txOpContext, req.txProvider), this.liquid, this.languages, this.i18n, req.txEndpoint.path, req.txEndpoint.fhirVersion);
        const problemFinder = new ProblemFinder();
        const content = await problemFinder.scanValueSets(req.txProvider);
        const html = await txhtml.renderPage('Problems', '<h3>ValueSet dependencies on unknown CodeSystem/Versions</h3>'+content, req.txEndpoint, req.txStartTime);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } finally {
        this.countRequest('problems', Date.now() - start);
      }
    });

    // Metadata / CapabilityStatement
    router.get('/metadata', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        try {
          await this.metadataHandler.handle(req, res);
        } catch (error) {
          this.log.error(`Error in /metadata: ${errorMessage(error)}`);
          res.status(500).json(this.operationOutcome('error', 'exception', errorMessage(error)));
        }
      } finally {
        this.countRequest('metadata', Date.now() - start);
      }
    });

    // $versions operation
    router.get('/\\$versions', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        try {
          await this.metadataHandler.handleVersions(req, res);
        } catch (error) {
          this.log.error(`Error in $versions: ${errorMessage(error)}`);
          res.status(500).json(this.operationOutcome('error', 'exception', errorMessage(error)));
        }
      } finally {
        this.countRequest('$versions', Date.now() - start);
      }
    });

    // Root endpoint info
    router.get('/', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        await res.json({
          resourceType: 'OperationOutcome',
          issue: [{
            severity: 'information',
            code: 'informational',
            diagnostics: `FHIR Terminology Server - FHIR v${req.txEndpoint.fhirVersion}`
          }]
        });
      } finally {
        this.countRequest('home', Date.now() - start);
      }
    });

    // External source info pages
    router.get('/info/:id', async (/** @type {any} */ req, /** @type {any} */ res) => {
      const start = Date.now();
      try {
        const source = req.txEndpoint.provider.externalSources.find((/** @type {any} */ s) => s.id() === req.params.id);
        if (!source) {
          res.status(404).send('Not found');
          return;
        }
        let txhtml = new TxHtmlRenderer(new Renderer(req.txOpContext, req.txEndpoint.provider), this.liquid, this.languages, this.i18n, req.txEndpoint.path, req.txEndpoint.fhirVersion);
        const content = await txhtml.buildInfoPage(source, req);
        const html = await txhtml.renderPage(source.name(), content, req.txEndpoint, start);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (error) {
        debugLog(error);
        this.log.error(`Error rendering info page for ${req.params.id}: ${errorMessage(error)}`);
        res.status(500).send('Internal server error');
      } finally {
        this.countRequest('info', Date.now() - start);
      }
    });
  }

  /**
   * Self-test: exercise CapabilityStatement and TerminologyCapabilities generation
   * for each endpoint immediately after startup, throwing on any failure.
   */
  async selfTest() {
    this.log.info('Running startup self-test for metadata endpoints...');

    for (const endpointInfo of this.endpoints) {
      const label = `${endpointInfo.path} (FHIR v${endpointInfo.fhirVersion})`;

      // Build a minimal mock req/res that captures what metadataHandler.handle() produces
      const makeMockReqRes = (/** @type {string | undefined} */ mode) => {
        const captured = /** @type {{data: any, status: number}} */ ({ data: null, status: 200 });

        const req = {
          method: 'GET',
          query: { mode },
          headers: {},
          // eslint-disable-next-line no-unused-vars
          get: (/** @type {string} */ name) => null,
          txEndpoint: endpointInfo,
          txProvider: endpointInfo.provider,
        };

        const res = {
          statusCode: 200,
          status(/** @type {number} */ code) { captured.status = code; return this; },
          setHeader() { return this; },
          json(/** @type {any} */ data) { captured.data = data; return this; },
          send(/** @type {any} */ data) { captured.data = data; return this; },
        };

        return { req, res, captured };
      };

      // Test 1: CapabilityStatement  (/metadata with no mode, or mode=full)
      try {
        const { req, res, captured } = makeMockReqRes(undefined);
        await this.metadataHandler.handle(req, res);
        if (!captured.data) {
          throw new Error('No response data returned');
        }
        const rt = captured.data.resourceType;
        if (rt !== 'CapabilityStatement') {
          throw new Error(`Expected CapabilityStatement, got ${rt}`);
        }
        this.log.info(`  [OK] CapabilityStatement for ${label}`);
      } catch (err) {
        this.log.error(`  [FAIL] CapabilityStatement for ${label}: ${errorMessage(err)}`);
        throw new Error(`Startup self-test failed (CapabilityStatement, ${label}): ${errorMessage(err)}`);
      }

      // Test 2: TerminologyCapabilities  (/metadata?mode=terminology)
      try {
        const { req, res, captured } = makeMockReqRes('terminology');
        await this.metadataHandler.handle(req, res);
        if (!captured.data) {
          throw new Error('No response data returned');
        }
        const rt = captured.data.resourceType;
        if (rt !== 'TerminologyCapabilities') {
          throw new Error(`Expected TerminologyCapabilities, got ${rt}`);
        }
        this.log.info(`  [OK] TerminologyCapabilities for ${label}`);
      } catch (err) {
        this.log.error(`  [FAIL] TerminologyCapabilities for ${label}: ${errorMessage(err)}`);
        throw new Error(`Startup self-test failed (TerminologyCapabilities, ${label}): ${errorMessage(err)}`);
      }
    }

    this.log.info('Startup self-test passed.');
  }

  /**
   * Build an OperationOutcome for errors
   */
  /**
   * @param {string} severity
   * @param {string} code
   * @param {string} message
   * @returns {Record<string, any>}
   */
  operationOutcome(severity, code, message) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{
        severity,
        code,
        diagnostics: message
      }]
    };
  }

  /**
   * Get module status for health check
   */
  getStatus() {
    return {
      enabled: true,
      status: this.library ? 'Running' : 'Not initialized',
      endpoints: this.endpoints.map(e => ({
        path: e.path,
        fhirVersion: e.fhirVersion,
        context: e.context
      }))
    };
  }

  /**
   * Shutdown the module
   */
  async shutdown() {
    this.log.info('Shutting down TX module');
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    // Clean up any resources if needed
    await this.library.close();
    this.log.info('TX module shut down');
  }

  /**
   * @param {any} params
   * @returns {any}
   */
  trimParameters(params) {
    if (!params || !params.parameter) {
      return params;
    }

    params.parameter = params.parameter.filter((/** @type {any} */ p) => p.name !== 'tx-resource');

    return params;
  }

  /**
   * @param {Record<string, any>} res
   * @param {string} fhirVersion
   * @returns {string}
   */
  convertResourceToXml(res, fhirVersion) {
    switch (res.resourceType) {
      case "CodeSystem" : return CodeSystemXML._jsonToXml(res);
      case "ValueSet" : return ValueSetXML.toXml(res);
      case "Bundle" : return BundleXML.toXml(res, fhirVersion);
      case "CapabilityStatement" : return CapabilityStatementXML.toXml(res, "R5");
      case "TerminologyCapabilities" : return TerminologyCapabilitiesXML.toXml(res, "R5");
      case "Parameters": return ParametersXML.toXml(res, fhirVersion);
      case "OperationOutcome": return OperationOutcomeXML.toXml(res, fhirVersion);
    }
    throw new Error(`Resource type ${res.resourceType} not supported in XML`);
  }

  /**
   * @param {string} xml
   * @returns {any}
   */
  convertXmlToResource(xml) {
    // Detect resource type from root element
    const rootMatch = xml.match(/<([A-Za-z]+)\s/);
    if (!rootMatch) {
      throw new Error('Could not detect resource type from XML');
    }

    const resourceType = rootMatch[1];

    let data;
    switch (resourceType) {
      case "Parameters":
        data = ParametersXML.fromXml(xml);
        break;
      case "CodeSystem":
        data = CodeSystemXML.fromXml(xml);
        break;
      case "ValueSet":
        data = ValueSetXML.fromXml(xml);
        break;
      case "ConceptMap":
        data = ConceptMapXML.fromXml(xml);
        break;
      default:
        throw new Error(`Resource type ${resourceType} not supported for XML input`);
    }

    return data;
  }

  /**
   * @param {string} name
   * @param {number} tat
   */
  countRequest(name, tat) {
    if (this.stats) {
      this.stats.countRequest(name, tat);
    }
  }

  cacheCount() {
    let count = 0;
    for (const ep of this.endpoints) {
      count = count + ep.resourceCache.size() + ep.expansionCache.size();
    }
    return count;
  }

  ec = 0;

  /**
   * @param {string} _jsonStr
   */
  checkProperJson(_jsonStr) {
    void _jsonStr;
    //   const errors = [];
    //   if (jsonStr.includes("[]")) errors.push("Found [] in json");
    //   if (jsonStr.includes('""')) errors.push('Found "" in json');
    //
    //   if (errors.length > 0) {
    //     this.ec++;
    //     const filename = `/Users/grahamegrieve/temp/tx-err-log/err${this.ec}.json`;
    //     writeFileSync(filename, jsonStr);
    //     throw new Error(errors.join('; '));
    //   }
  }

  /**
   * @param {Record<string, any>} data
   * @param {string} fhirVersion
   * @returns {any}
   */
  transformResourceForVersion(data, fhirVersion) {
    if (fhirVersion == "5.0" || !data.resourceType) {
      return data;
    }
    switch (data.resourceType) {
      case "CodeSystem": return codeSystemFromR5(data, fhirVersion);
      case "CapabilityStatement": return capabilityStatementFromR5(data, fhirVersion);
      case "TerminologyCapabilities": return terminologyCapabilitiesFromR5(data, fhirVersion);
      case "ValueSet": return valueSetFromR5(data, fhirVersion);
      case "ConceptMap": return conceptMapFromR5(data, fhirVersion);
      case "Parameters": return parametersFromR5(data, fhirVersion);
      case "OperationOutcome": return operationOutcomeFromR5(data, fhirVersion);
      case "Bundle": return bundleFromR5(data, fhirVersion);
      default: return data;
    }
  }

  /**
   * @param {any} req
   * @returns {number}
   */
  internalLimit(req) {
    let isTest = req.header("User-Agent") == 'Tools/Java';
    if (this.config.internalLimit && !isTest) return this.config.internalLimit; else return INTERNAL_DEFAULT_LIMIT;
  }

  /**
   * @param {any} req
   * @returns {number}
   */
  externalLimit(req) {
    let hdr = req.headers["x-too-costly-threshold"];
    if (hdr) {
      return parseInt(hdr);
    }
    let isTest = req.header("User-Agent") == 'Tools/Java';
    if (this.config.internalLimit && !isTest) return this.config.externalLimit; else return EXTERNAL_TEST_DEFAULT_LIMIT;
  }

}

module.exports = TXModule;
