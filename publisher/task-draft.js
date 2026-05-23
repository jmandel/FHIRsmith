// @ts-check

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = /** @type {any} */ (require('axios'));
const { spawnJava } = require('./spawn-java');

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class DraftTaskProcessor {
  /**
   * @param {any} config
   * @param {any} logger
   * @param {(taskId: any, level: string, message: string) => Promise<any>} logTaskMessage
   * @param {(taskId: any, status: string, data?: any) => Promise<any>} updateTaskStatus
   */
  constructor(config, logger, logTaskMessage, updateTaskStatus) {
    this.config = config;
    this.logger = logger;
    this.logTaskMessage = logTaskMessage;
    this.updateTaskStatus = updateTaskStatus;
  }

  /**
   * @param {any} task
   */
  async processDraftBuild(task) {
    this.logger.info('Processing draft build for task #' + task.id + ' (' + task.npm_package_id + '#' + task.version + ')');

    try {
      // Update status to building
      await this.updateTaskStatus(task.id, 'building');
      await this.logTaskMessage(task.id, 'info', 'Started draft build');

      // Run actual build process
      await this.runDraftBuild(task);

      // Update status to waiting for approval
      await this.updateTaskStatus(task.id, 'waiting for approval');
      await this.logTaskMessage(task.id, 'info', 'Draft build completed - waiting for approval');

      this.logger.info('Draft build completed for task #' + task.id);

    } catch (error) {
      this.logger.error('Draft build failed for task #' + task.id + ':', error);
      await this.updateTaskStatus(task.id, 'failed', {
        failure_reason: errorMessage(error)
      });
      await this.logTaskMessage(task.id, 'error', 'Draft build failed: ' + errorMessage(error));
      throw error; // Re-throw so the main processor knows it failed
    }
  }

  /**
   * @param {any} task
   */
  async runDraftBuild(task) {
    const taskDir = path.join(this.config.workspaceRoot, 'task-' + task.id);
    const draftDir = path.join(taskDir, 'draft');
    const logFile = path.join(taskDir, 'draft-build.log');

    await this.logTaskMessage(task.id, 'info', 'Creating task directory: ' + taskDir);

    // Step 1: Create/scrub task directory
    await this.createTaskDirectory(taskDir);

    // Step 2: Download latest publisher
    const publisherJar = await this.downloadPublisher(taskDir, task.id);

    // Step 3: Clone GitHub repository
    await this.cloneRepository(task, draftDir);

    // Step 4: Install FSH Sushi globally
    await this.installFshSushi(task.id);

    // Step 5: Run IG publisher
    await this.runIGPublisher(publisherJar, draftDir, logFile, task.id);

    // Update task with build output path
    await this.updateTaskStatus(task.id, 'building', {
      build_output_path: logFile,
      local_folder: taskDir
    });

    this.logger.info('Draft build completed for ' + task.npm_package_id + '#' + task.version);
  }

  /**
   * @param {string} taskDir
   */
  async createTaskDirectory(taskDir) {
    await this.logTaskMessage(null, 'info', 'Creating/cleaning task directory: ' + taskDir);

    // Remove existing directory if it exists
    if (fs.existsSync(taskDir)) {
      // Use Node.js built-in fs.rm (Node 14.14+) or fs.rmSync (Node 14.14+)
      if (fs.promises && fs.promises.rm) {
        // Use promise-based API
        await fs.promises.rm(taskDir, { recursive: true, force: true });
      } else if (fs.rmSync) {
        // Use synchronous API
        fs.rmSync(taskDir, { recursive: true, force: true });
      } else {
        // Fallback for older Node versions
        const rimraf = /** @type {any} */ (require('rimraf'));
        await new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
          if (typeof rimraf === 'function') {
            rimraf(taskDir, (/** @type {Error | null} */ err) => {
              if (err) reject(err);
              else resolve();
            });
          } else if (rimraf.rimraf) {
            rimraf.rimraf(taskDir).then(resolve).catch(reject);
          } else {
            reject(new Error('Unable to remove directory - unsupported rimraf version'));
          }
        });
      }
    }

    // Create fresh directory
    fs.mkdirSync(taskDir, { recursive: true });
  }

  /**
   * @param {string} taskDir
   * @param {any} taskId
   * @returns {Promise<string>}
   */
  async downloadPublisher(taskDir, taskId) {
    const publisherJar = path.join(taskDir, 'publisher.jar');

    await this.logTaskMessage(taskId, 'info', 'Downloading latest FHIR IG Publisher...');

    // Ensure the target directory exists
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }

    try {
      // Get latest release info from GitHub API
      const releaseResponse = await axios.get('https://api.github.com/repos/HL7/fhir-ig-publisher/releases/latest', {
        timeout: 30000 // 30 second timeout
      });

      const downloadUrl = releaseResponse.data.assets.find((/** @type {any} */ asset) =>
        asset.name === 'publisher.jar'
      )?.browser_download_url;

      if (!downloadUrl) {
        throw new Error('Could not find publisher.jar in latest release');
      }

      await this.logTaskMessage(taskId, 'info', 'Downloading from: ' + downloadUrl);

      // Download the file with progress tracking
      const response = await axios({
        method: 'GET',
        url: downloadUrl,
        responseType: 'stream',
        timeout: 300000 // 5 minute timeout for download
      });

      const writer = fs.createWriteStream(publisherJar);

      // Track download progress
      let downloadedBytes = 0;
      const totalBytes = parseInt(response.headers['content-length'] || '0');
      let lastProgressPercent = -1;

      response.data.on('data', (/** @type {Buffer} */ chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const progress = Math.round((downloadedBytes / totalBytes) * 100);
          // Log every 10% but avoid duplicate logs
          if (progress % 10 === 0 && progress !== lastProgressPercent) {
            this.logTaskMessage(taskId, 'info', 'Download progress: ' + progress + '%');
            lastProgressPercent = progress;
          }
        }
      });

      response.data.pipe(writer);

      await new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      await this.logTaskMessage(taskId, 'info', 'Publisher downloaded successfully (' + Math.round(downloadedBytes / 1024 / 1024) + 'MB)');
      return publisherJar;

    } catch (error) {
      const axiosError = /** @type {{code?: string}} */ (error);
      if (axiosError.code === 'ECONNABORTED') {
        throw new Error('Publisher download timed out - please try again');
      }
      throw new Error('Failed to download publisher: ' + errorMessage(error));
    }
  }

  /**
   * @param {any} task
   * @param {string} draftDir
   */
  async cloneRepository(task, draftDir) {
    const gitUrl = 'https://github.com/' + task.github_org + '/' + task.github_repo + '.git';

    await this.logTaskMessage(task.id, 'info', 'Cloning repository: ' + gitUrl + ' (branch: ' + task.git_branch + ')');

    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      const git = /** @type {any} */ (spawn('git', [
        'clone',
        '--branch', task.git_branch,
        '--single-branch',
        '--depth', '1', // Shallow clone for faster download
        gitUrl,
        draftDir
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      }));

      // eslint-disable-next-line no-unused-vars
      let stdout = '';
      let stderr = '';

      git.stdout.on('data', (/** @type {Buffer} */ data) => {
        stdout += data.toString();
      });

      git.stderr.on('data', (/** @type {Buffer} */ data) => {
        stderr += data.toString();
      });

      git.on('close', async (/** @type {number} */ code) => {
        if (code === 0) {
          await this.logTaskMessage(task.id, 'info', 'Repository cloned successfully');

          // Log some info about what was cloned
          try {
            const stats = fs.statSync(draftDir);
            if (stats.isDirectory()) {
              const files = fs.readdirSync(draftDir);
              await this.logTaskMessage(task.id, 'info', 'Cloned ' + files.length + ' files/directories');
            }
          } catch (e) {
            // Don't fail if we can't get stats
          }

          resolve();
        } else {
          const error = 'Git clone failed with code ' + code + ': ' + stderr;
          await this.logTaskMessage(task.id, 'error', error);
          reject(new Error(error));
        }
      });

      git.on('error', async (/** @type {Error} */ error) => {
        await this.logTaskMessage(task.id, 'error', 'Git clone error: ' + error.message);
        reject(error);
      });

      // Timeout for git clone (10 minutes)
      const timeout = setTimeout(async () => {
        git.kill();
        await this.logTaskMessage(task.id, 'error', 'Git clone timed out after 10 minutes');
        reject(new Error('Git clone timed out'));
      }, 10 * 60 * 1000);

      git.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * @param {any} taskId
   */
  async installFshSushi(taskId) {
    await this.logTaskMessage(taskId, 'info', 'Installing FSH Sushi globally...');

    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      const npm = /** @type {any} */ (spawn('npm', [
        'install',
        '-g',
        'fsh-sushi'
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      }));

      // eslint-disable-next-line no-unused-vars
      let stdout = '';
      let stderr = '';

      npm.stdout.on('data', (/** @type {Buffer} */ data) => {
        stdout += data.toString();
      });

      npm.stderr.on('data', (/** @type {Buffer} */ data) => {
        stderr += data.toString();
      });

      npm.on('close', async (/** @type {number} */ code) => {
        if (code === 0) {
          await this.logTaskMessage(taskId, 'info', 'FSH Sushi installed successfully');

          // Verify installation by checking version
          try {
            await this.checkSushiVersion(taskId);
          } catch (versionError) {
            this.logTaskMessage(taskId, 'warn', 'FSH Sushi installed but version check failed: ' + errorMessage(versionError));
          }

          resolve();
        } else {
          const error = 'NPM install failed with code ' + code + ': ' + stderr;
          await this.logTaskMessage(taskId, 'error', error);
          reject(new Error(error));
        }
      });

      npm.on('error', async (/** @type {Error} */ error) => {
        await this.logTaskMessage(taskId, 'error', 'NPM install error: ' + error.message);
        reject(error);
      });

      // Timeout after 5 minutes
      const timeout = setTimeout(async () => {
        npm.kill('SIGTERM');

        // Force kill after 10 seconds if still running
        setTimeout(() => {
          npm.kill('SIGKILL');
        }, 10000);

        await this.logTaskMessage(taskId, 'error', 'FSH Sushi installation timed out after 5 minutes');
        reject(new Error('FSH Sushi installation timed out'));
      }, 5 * 60 * 1000);

      npm.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * @param {any} taskId
   * @returns {Promise<string>}
   */
  async checkSushiVersion(taskId) {
    return new Promise((/** @type {(value: string) => void} */ resolve, reject) => {
      const sushi = /** @type {any} */ (spawn('sushi', ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe']
      }));

      let stdout = '';
      // eslint-disable-next-line no-unused-vars
      let stderr = '';

      sushi.stdout.on('data', (/** @type {Buffer} */ data) => {
        stdout += data.toString();
      });

      sushi.stderr.on('data', (/** @type {Buffer} */ data) => {
        stderr += data.toString();
      });

      sushi.on('close', async (/** @type {number} */ code) => {
        if (code === 0) {
          const version = stdout.trim();
          await this.logTaskMessage(taskId, 'info', 'FSH Sushi version: ' + version);
          resolve(version);
        } else {
          reject(new Error('Sushi version check failed with code ' + code));
        }
      });

      sushi.on('error', (/** @type {Error} */ error) => {
        reject(error);
      });

      // Quick timeout for version check
      setTimeout(() => {
        sushi.kill();
        reject(new Error('Sushi version check timed out'));
      }, 30000);
    });
  }

  /**
   * @param {string} publisherJar
   * @param {string} draftDir
   * @param {string} logFile
   * @param {any} taskId
   */
  async runIGPublisher(publisherJar, draftDir, logFile, taskId) {
    await this.logTaskMessage(taskId, 'info', 'Running FHIR IG Publisher...');

    // Check if sushi.config.yaml exists and log it
    const sushiConfigPath = path.join(draftDir, 'sushi-config.yaml');
    if (fs.existsSync(sushiConfigPath)) {
      await this.logTaskMessage(taskId, 'info', 'Found sushi-config.yaml');
    } else {
      await this.logTaskMessage(taskId, 'info', 'No sushi-config.yaml found');
    }

    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      const java = /** @type {any} */ (spawnJava([
        '-jar',
        '-Xmx20000m',
        publisherJar,
        '-ig',
        '.'
      ], {
        cwd: draftDir,
        stdio: ['pipe', 'pipe', 'pipe']
      }));

      // Create log file stream
      const logStream = fs.createWriteStream(logFile);

      // Write header to log file
      const startTime = new Date().toISOString();
      logStream.write('=== FHIR IG Publisher Build Log ===\n');
      logStream.write('Started: ' + startTime + '\n');
      logStream.write('Command: java -jar -Xmx20000m publisher.jar -ig .\n');
      logStream.write('Working Directory: ' + draftDir + '\n');
      logStream.write('=====================================\n\n');

      // eslint-disable-next-line no-unused-vars
      let hasOutput = false;
      let lastProgressUpdate = Date.now();

      java.stdout.on('data', (/** @type {Buffer} */ data) => {
        hasOutput = true;
        logStream.write(data);

        // Log progress periodically
        const now = Date.now();
        if (now - lastProgressUpdate > 30000) { // Every 30 seconds
          this.logTaskMessage(taskId, 'info', 'IG Publisher is still running...');
          lastProgressUpdate = now;
        }
      });

      java.stderr.on('data', (/** @type {Buffer} */ data) => {
        hasOutput = true;
        logStream.write(data);
      });

      java.on('close', async (/** @type {number} */ code) => {
        const endTime = new Date().toISOString();
        logStream.write('\n=====================================\n');
        logStream.write('Finished: ' + endTime + '\n');
        logStream.write('Exit Code: ' + code + '\n');
        logStream.end();

        if (code === 0) {
          await this.logTaskMessage(taskId, 'info', 'IG Publisher completed successfully');

          // Check for QA report
          const qaReportPath = path.join(draftDir, 'output', 'qa.html');
          if (fs.existsSync(qaReportPath)) {
            await this.logTaskMessage(taskId, 'info', 'QA report generated: output/qa.html');
          }

          resolve();
        } else {
          const error = 'IG Publisher failed with exit code: ' + code;
          await this.logTaskMessage(taskId, 'error', error);
          reject(new Error(error));
        }
      });

      java.on('error', async (/** @type {Error} */ error) => {
        logStream.write('\nERROR: ' + error.message + '\n');
        logStream.end();
        await this.logTaskMessage(taskId, 'error', 'IG Publisher error: ' + error.message);
        reject(error);
      });

      // Timeout configurable via publisher.igPublisherTimeoutMinutes (default: 60 minutes)
      const timeoutMinutes = this.config.igPublisherTimeoutMinutes || 60;
      const timeout = setTimeout(async () => {
        java.kill('SIGTERM'); // Try graceful shutdown first

        // Force kill after 10 seconds if still running
        setTimeout(() => {
          java.kill('SIGKILL');
        }, 10000);

        logStream.write('\nTIMEOUT: Process killed after ' + timeoutMinutes + ' minutes\n');
        logStream.end();
        await this.logTaskMessage(taskId, 'error', 'IG Publisher timed out after ' + timeoutMinutes + ' minutes');
        reject(new Error('IG Publisher timed out'));
      }, timeoutMinutes * 60 * 1000);

      java.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }
}

module.exports = DraftTaskProcessor;
