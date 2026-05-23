
// @ts-check

const FhirValidator = require('fhir-validator-wrapper');
const express = require('express');
const path = require('path');
const fs = require('fs');
const TXModule = require('../tx.js');
const ServerStats = require("../../stats");
const Logger = require("../../library/logger");
const {txTestVersion} = require("./test-cases-version");
const folders = require('../../library/folder-setup');
const {VersionUtilities} = require("../../library/version-utilities");

let count = 0;
let error = 0;

/**
 * @returns {Set<string>}
 */
function txTestModeSet() {
   return new Set(['tx.fhir.org', 'omop', 'general', 'snomed']);
}

/**
 * @returns {Promise<void>}
 */
async function startTxTests() {
    await startServer();
    await loadValidator();
}

/**
 * @returns {Promise<void>}
 */
async function  finishTxTests() {
    console.log(txTestSummary());
    let textfilename = path.join(__dirname, '../../test-cases-summary.txt');
    fs.writeFileSync(textfilename, txTestSummary());

    await unloadValidator();
    await stopServer();
}

/**
 * @returns {string}
 */
function txTestSummary() {
    let set = Array.from(txTestModeSet()).join('+');
    const runnerVersion = validator ? validator.jarVersion() : 'not-started';
    if (error == 0) {
      return `FHIRsmith passed all ${count} HL7 terminology service tests (modes ${set}, tests v${txTestVersion()}, runner v${runnerVersion})`;
    } else {
      return `FHIRsmith failed ${error} of ${count} HL7 terminology service tests (modes ${set}, tests v${txTestVersion()}, runner v${runnerVersion})`;
    }
}

/**
 * @param {{suite: string, test: string}} test
 * @param {string | boolean} [version]
 * @returns {Promise<void>}
 */
async function runTest(test, version = true) {
    const testVersion = typeof version === 'string' ? version : "5.0";
    const params = {
        server: 'http://localhost:'+TEST_PORT+(VersionUtilities.isR5Plus(testVersion) ? "/r5" : "/r4"),
        suiteName: test.suite,
        testName: test.test,
        version: testVersion
    };
    count++;
    const result = await validator.runTxTest(params);
    if (!result.result) { 
        error++;
    }
    
    expect(result).toEqual({ result: true });
}


const TEST_PORT = 9095;
const VALIDATOR_PORT = 9096;
const VALIDATOR_STARTUP_TIMEOUT = Number.parseInt(process.env.FHIR_VALIDATOR_STARTUP_TIMEOUT || '180000', 10);
const TEST_CONFIG_FILE = path.join(__dirname, '..', 'fixtures', 'test-cases-setup.json');

/** @type {import('http').Server | null} */
let server = null;
/** @type {any} */
let validator = null;
/** @type {any} */
let txModule = null;
/** @type {any} */
let log = null;
/** @type {any} */
let stats = null;

/**
 * @returns {Promise<void>}
 */
async function startServer() {
    const app = express();

    // Load test configuration
    let config;
    try {
        const configData = fs.readFileSync(TEST_CONFIG_FILE, 'utf8');
        config = JSON.parse(configData);
    } catch (error) {
        throw new Error(`Failed to load test config: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Middleware
    app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
    app.use(express.raw({ type: 'application/fhir+xml', limit: '50mb' }));
    app.use(express.json({ limit: '50mb' }));

    // Initialize TX module only
    stats = new ServerStats();
    txModule = new TXModule(stats);
    await txModule.initialize(config, app);

    return new Promise((resolve, reject) => {
        const listeningServer = app.listen(TEST_PORT, () => {
            console.log(`Test server started on port ${TEST_PORT}`);
            resolve();
        });
        server = listeningServer;
        listeningServer.on('error', reject);
    });
}

/**
 * @returns {Promise<void>}
 */
async function stopServer() {
    if (stats) {
        stats.finishStats();
    }

    if (txModule && typeof txModule.shutdown === 'function') {
        await txModule.shutdown();
        txModule = null;
    }

    const currentServer = server;
    if (currentServer) {
        return new Promise((resolve) => {
            currentServer.closeAllConnections();
            currentServer.close(() => {
                console.log('Test server stopped');
                server = null;
                resolve();
            });
        });
    }
}

/**
 * @returns {Promise<void>}
 */
async function loadValidator() {
    const validatorJarPath = folders.ensureFilePath('bin/validator_cli.jar');
    log =  Logger.getInstance().child({ module: 'test-runner' });
    validator = new FhirValidator(validatorJarPath, log);
    const validatorConfig = {
        version : '4.0',
        txServer : 'http://localhost:'+TEST_PORT+'/r5',
        txLog : path.join(folders.logsDir(), 'tx-test-cases.log'),
        port: VALIDATOR_PORT,
        timeout: VALIDATOR_STARTUP_TIMEOUT
    }
    await validator.start(validatorConfig);
    await validator.loadIG("hl7.fhir.uv.tx-ecosystem", "current");
}


/**
 * @returns {Promise<void>}
 */
async function unloadValidator() {

    // Stop FHIR validator
    if (validator) {
        try {
            log.info('Stopping FHIR validator...');
            await validator.stop();
            log.info('FHIR validator stopped');
        } catch (error) {
            log.error('Error stopping FHIR validator:', error);
        }
        validator = null;
    }

}
module.exports = { startTxTests, finishTxTests, runTest, txTestModeSet };
