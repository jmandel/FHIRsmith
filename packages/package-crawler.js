//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//
// @ts-check

const axios = require('axios');
const {XMLParser} = require('fast-xml-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {debugLog} = require("../tx/operation-context");
const axiosClient = /** @type {any} */ (axios);

/** @typedef {{allowed: boolean, allowedFeeds: string}} PackageAllowedResult */

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class PackageCrawler {
  /** @type {any} */
  log;
  /** @type {Set<string>} */
  packages = new Set();
  /** @type {any} */
  config;
  /** @type {any} */
  db;
  /** @type {any} */
  stats;
  /** @type {number} */
  totalBytes;
  /** @type {any} */
  crawlerLog;
  /** @type {string} */
  errors;
  /** @type {AbortController | null} */
  abortController;

  /**
   * @param {any} config
   * @param {any} db
   * @param {any} stats
   */
  constructor(config, db, stats) {
    this.config = config;
    this.db = db;
    this.stats = stats;
    this.totalBytes = 0;
    this.crawlerLog = {};
    this.errors = '';
    this.abortController = null;
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA busy_timeout = 5000');
  }

  /**
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  async isFeedPageVisited(url) {
    return new Promise((/** @type {(value: boolean) => void} */ resolve, reject) => {
      this.db.get('SELECT Url FROM FeedPages WHERE Url = ?', [url], (/** @type {Error | null} */ err, /** @type {any} */ row) => {
        if (err) reject(err);
        else resolve(!!row);
      });
    });
  }

  /**
   * @param {string} url
   * @returns {Promise<void>}
   */
  async markFeedPageVisited(url) {
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      this.db.run(
        'INSERT OR REPLACE INTO FeedPages (Url, VisitedAt) VALUES (?, ?)',
        [url, new Date().toISOString()],
        (/** @type {Error | null} */ err) => { if (err) reject(err); else resolve(); }
      );
    });
  }

  /**
   * @param {any} log
   * @returns {Promise<any>}
   */
  async crawl(log) {
    this.log = log;
    this.packages.clear();
    this.abortController = new AbortController();

    const startTime = Date.now();
    this.crawlerLog = {
      startTime: new Date().toISOString(),
      master: this.config.masterUrl,
      feeds: [],
      totalBytes: 0,
      errors: ''
    };

    this.log.info('Running web crawler for packages using master URL: '+ this.config.masterUrl);
    this.stats.task('Package Crawler', 'Running');

    try {
      // Fetch the master JSON file
      const masterResponse = await this.fetchJson(this.config.masterUrl);

      if (!masterResponse.feeds || !Array.isArray(masterResponse.feeds)) {
        throw new Error('Invalid master JSON: missing feeds array');
      }

      // Process package restrictions if available
      const packageRestrictions = masterResponse['package-restrictions'] || [];

      // Process each feed
      for (const feedConfig of masterResponse.feeds) {
        if (this.abortController?.signal.aborted) break;
        if (!feedConfig.url) {
          this.log.info('Skipping feed with no URL: '+ feedConfig);
          continue;
        }
        try {
          let url = this.fixUrl(feedConfig.url)
          if (!url.includes('simplifier')) {
            this.stats.task('Package Crawler', 'Running for '+feedConfig.url);
            await this.updateTheFeed(url, this.config.masterUrl,feedConfig.errors ? feedConfig.errors.replace(/\|/g, '@').replace(/_/g, '.') : '', packageRestrictions);
          }
        } catch (feedError) {
          this.log.error(`Failed to process feed ${feedConfig.url}: `+ errorMessage(feedError));
          // Continue with next feed even if this one fails
        }
      }
      // process simplifier last
      for (const feedConfig of masterResponse.feeds) {
        if (this.abortController?.signal.aborted) break;
        if (!feedConfig.url) {
          this.log.info('Skipping feed with no URL: '+ feedConfig);
          continue;
        }

        try {
          let url = this.fixUrl(feedConfig.url)
          if (url.includes('simplifier')) {
            this.stats.task('Package Crawler', 'Running for '+feedConfig.url);
            await this.updateTheFeed(url, this.config.masterUrl,feedConfig.errors ? feedConfig.errors.replace(/\|/g, '@').replace(/_/g, '.') : '', packageRestrictions);
          }
        } catch (feedError) {
          this.log.error(`Failed to process feed ${feedConfig.url}: `+ errorMessage(feedError));
          // Continue with next feed even if this one fails
        }
      }

      const runTime = Date.now() - startTime;
      this.crawlerLog.runTime = `${runTime}ms`;
      this.crawlerLog.endTime = new Date().toISOString();
      this.crawlerLog.totalBytes = this.totalBytes;

      this.log.info(`Web crawler completed successfully in ${runTime}ms`);
      this.log.info(`Total bytes processed: ${this.totalBytes}`);

      this.stats.taskDone('Package Crawler', 'Complete');
      return this.crawlerLog;

    } catch (error) {
      const runTime = Date.now() - startTime;
      this.crawlerLog.runTime = `${runTime}ms`;
      this.crawlerLog.fatalException = errorMessage(error);
      this.crawlerLog.endTime = new Date().toISOString();
      this.stats.taskError('Package Crawler', 'Error: '+errorMessage(error));

      this.log.error('Web crawler failed: '+ error);
      throw error;
    }
  }

  /**
   * @param {string} url
   * @returns {string}
   */
  fixUrl(url) {
    return url.replace(/^http:/, 'https:');
  }

  /**
   * @param {string} url
   * @returns {Promise<any>}
   */
  async fetchJson(url) {
    try {
      if (url.startsWith("/")) {
        const content = await fs.promises.readFile(url, "utf8");
        return JSON.parse(content);
      } else {
        const response = await axiosClient.get(url, {
          timeout: 30000,
          signal: this.abortController?.signal,
          headers: {
            'User-Agent': 'FHIR Package Crawler/1.0'
          }
        });
        return response.data;
      }
    } catch (error) {
      debugLog(error);
      const err = /** @type {any} */ (error);
      if (err.response && err.response.status === 429) {
        throw new Error(`RATE_LIMITED: Server returned 429 Too Many Requests for ${url}`);
      }
      throw new Error(`Failed to fetch JSON from ${url}: ${errorMessage(error)}`);
    }
  }

  /**
   * @param {string} url
   * @returns {Promise<any>}
   */
  async fetchXml(url) {
    try {
      if (url.startsWith("/")) {
        const content = await fs.promises.readFile(url, 'utf8');
        const parser = new XMLParser(/** @type {any} */ ({
          ignoreAttributes: false,
          attributeNamePrefix: '@_',
          textNodeName: '#text',
          entityExpansionLimit: 100000
        }));
        return parser.parse(content);
      } else {
        const response = await axiosClient.get(url, {
          timeout: 30000,
          signal: this.abortController?.signal,
          headers: {
            'User-Agent': 'FHIR Package Crawler/1.0'
          }
        });

        const parser = new XMLParser(/** @type {any} */ ({
          ignoreAttributes: false,
          attributeNamePrefix: '@_',
          textNodeName: '#text',
          entityExpansionLimit: 100000
        }));
        return parser.parse(response.data);
      }
    } catch (error) {
      debugLog(`Failed to fetch XML from ${url}: ${errorMessage(error)}`);
      const err = /** @type {any} */ (error);
      if (err.response && err.response.status === 429) {
        throw new Error(`RATE_LIMITED: Server returned 429 Too Many Requests for ${url}`);
      }
      throw new Error(`Failed to fetch XML from ${url}: ${errorMessage(error)}`);
    }
  }

  /**
   * @param {string} url
   * @returns {Promise<Buffer>}
   */
  async fetchUrl(url) {
    try {
      if (url.startsWith("/")) {
        const buffer = await fs.promises.readFile(url);
        this.totalBytes += buffer.byteLength;
        return buffer;
      } else {
        const response = await axiosClient.get(url, {
          timeout: 60000,
          responseType: 'arraybuffer',
          signal: this.abortController?.signal,
          headers: {
            'User-Agent': 'FHIR Package Crawler/1.0'
          }
        });

        this.totalBytes += response.data.byteLength;
        return Buffer.from(response.data);
      }
    } catch (error) {
      debugLog(`Failed to fetch ${url}: ${errorMessage(error)}`);
      const err = /** @type {any} */ (error);
      if (err.response && err.response.status === 429) {
        throw new Error(`RATE_LIMITED: Server returned 429 Too Many Requests for ${url}`);
      }
      throw new Error(`Failed to fetch ${url}: ${errorMessage(error)}`);
    }
  }

  /**
   * @param {string} url
   * @param {string} source
   * @param {string} email
   * @param {any[]} packageRestrictions
   */
  async updateTheFeed(url, source, email, packageRestrictions) {
    /** @type {any} */
    const feedLog = {
      url: url,
      items: []
    };
    this.crawlerLog.feeds.push(feedLog);

    this.log.info('Processing feed: ' + url);
    const startTime = Date.now();

    // The first page (the root feed URL) is always processed — it contains the
    // latest packages. Subsequent pages (followed via atom:link rel="next") are
    // historical archives and only need to be visited once.
    /** @type {string | null} */
    let currentUrl = url;
    let isFirstPage = true;

    while (currentUrl) {
      if (this.abortController?.signal.aborted) break;

      if (!isFirstPage) {
        const alreadyVisited = await this.isFeedPageVisited(currentUrl);
        if (alreadyVisited) {
          this.log.info(`Feed page already visited, stopping: ${currentUrl}`);
          break;
        }
      }

      try {
        this.log.info(`Fetching feed page: ${currentUrl}`);
        const xmlData = await this.fetchXml(currentUrl);
        if (isFirstPage) feedLog.fetchTime = `${Date.now() - startTime}ms`;

        /** @type {any[]} */
        let items = [];
        /** @type {string | null} */
        let nextUrl = null;

        if (xmlData.rss && xmlData.rss.channel) {
          const channel = xmlData.rss.channel;
          items = Array.isArray(channel.item) ? channel.item : [channel.item].filter(Boolean);

          // Check for RFC 5005 next-page link: <atom:link rel="next" href="..."/>
          const atomLinks = channel['atom:link'];
          if (atomLinks) {
            const links = Array.isArray(atomLinks) ? atomLinks : [atomLinks];
            const nextLink = links.find((/** @type {any} */ l) => l['@_rel'] === 'next');
            if (nextLink && nextLink['@_href']) {
              nextUrl = this.fixUrl(nextLink['@_href']);
            }
          }
        }

        this.log.info(`Found ${items.length} items in feed page ${currentUrl}`);

        let rateLimited = false;
        for (let i = 0; i < items.length; i++) {
          if (this.abortController?.signal.aborted) break;
          try {
            await this.updateItem(currentUrl, items[i], i, packageRestrictions, feedLog);
          } catch (itemError) {
            if (errorMessage(itemError).includes('RATE_LIMITED')) {
              this.log.info(`Rate limited while downloading package from ${currentUrl}, stopping feed processing`);
              feedLog.rateLimited = true;
              feedLog.rateLimitedAt = `item ${i}`;
              feedLog.rateLimitMessage = errorMessage(itemError);
              rateLimited = true;
              break;
            }
            this.log.error(`Error processing item ${i} from ${currentUrl}:` + errorMessage(itemError));
          }
        }

        if (rateLimited) break;

        // Mark this page as visited now that we've successfully processed it.
        // Don't mark the first page — it must always be re-crawled for new entries.
        if (!isFirstPage) {
          await this.markFeedPageVisited(currentUrl);
        }

        currentUrl = nextUrl;
        isFirstPage = false;

      } catch (error) {
        debugLog(error);
        if (errorMessage(error).includes('RATE_LIMITED')) {
          this.log.info(`Rate limited while fetching feed ${currentUrl}, stopping`);
          feedLog.rateLimited = true;
          feedLog.rateLimitMessage = errorMessage(error);
          feedLog.failTime = `${Date.now() - startTime}ms`;
          break;
        }
        feedLog.exception = errorMessage(error);
        feedLog.failTime = `${Date.now() - startTime}ms`;
        this.log.error(`Exception processing feed ${currentUrl}:` + errorMessage(error));
        break;
      }
    }

    if (this.errors && email && !feedLog.rateLimited) {
      this.log.info(`Would send error email to ${email} for feed ${url}`);
    }
  }

  /**
   * @param {string} source
   * @param {any} item
   * @param {number} index
   * @param {any[]} packageRestrictions
   * @param {any} feedLog
   */
  async updateItem(source, item, index, packageRestrictions, feedLog) {
    /** @type {any} */
    const itemLog = {
      status: '??'
    };
    feedLog.items.push(itemLog);

    try {
      // Extract GUID
      if (!item.guid || !item.guid['#text']) {
        const error = `Error processing item from ${source}#item[${index}]: no guid provided`;
        this.log.info(error);
        itemLog.error = 'no guid provided';
        itemLog.status = 'error';
        return;
      }

      const guid = item.guid['#text'];
      itemLog.guid = guid;

      // Extract title (package ID)
      const id = item.title;
      itemLog.id = id;

      if (!id) {
        itemLog.error = 'no title/id provided';
        itemLog.status = 'error';
        return;
      }

      // Check if not for publication
      if (item.notForPublication && item.notForPublication['#text'] === 'true') {
        itemLog.status = 'not for publication';
        itemLog.error = 'not for publication';
        return;
      }

      // Check package restrictions
      if (!this.isPackageAllowed(id, source, packageRestrictions).allowed) {
        if (!source.includes('simplifier.net')) {
          const error = `The package ${id} is not allowed to come from ${source}`;
          this.log.info(error);
          itemLog.error = error;
          itemLog.status = 'prohibited source';
        } else {
          itemLog.status = 'ignored';
          itemLog.error = `The package ${id} is published through another source`;
        }
        return;
      }

      if (this.packages.has(id)) {
        this.log.info(`Ignoring package ${id} because it's already been seen in another feed`);
        return;
      }
      this.packages.add(id);

      // Check if already processed
      if (await this.hasStored(guid)) {
        itemLog.status = 'Already Processed';
        return;
      }

      // Parse publication date
      let pubDate;
      let pd;
      try {
        pd = item.pubDate;
        pubDate = this.parsePubDate(pd);
      } catch (error) {
        itemLog.error = `Invalid date format '${pd}': ${errorMessage(error)}`;
        itemLog.status = 'error';
        return;
      }

      // Extract URL and fetch package
      const url = this.fixUrl(item.link);
      if (!url) {
        itemLog.error = 'no link provided';
        itemLog.status = 'error';
        return;
      }

      itemLog.url = url;
      this.log.info('Fetching package: ' + url);

      const packageContent = await this.fetchUrl(url);
      await this.store(source, url, guid, pubDate, packageContent, id, itemLog);

      itemLog.status = 'Fetched';

    } catch (error) {
      this.log.error(`Exception processing item ${itemLog.guid || index} from ${source}: `+ errorMessage(error));
      itemLog.status = 'Exception';
      itemLog.error = errorMessage(error);
      if (errorMessage(error).includes('RATE_LIMITED')) {
        throw error;
      }
    }

  }

  /**
   * @param {string} packageId
   * @param {string} source
   * @param {any[]} restrictions
   * @returns {PackageAllowedResult}
   */
  isPackageAllowed(packageId, source, restrictions) {
    if (!restrictions || !Array.isArray(restrictions)) {
      return { allowed: true, allowedFeeds: '' };
    }

    // Convert URLs to https for consistent comparison
    const fixUrl = (/** @type {string} */ url) => url.replace(/^http:/, 'https:');

    const fixedPackageId = fixUrl(packageId);
    const fixedSource = fixUrl(source);

    for (const restriction of restrictions) {
      if (!restriction.mask || !restriction.feeds) continue;

      const fixedMask = fixUrl(restriction.mask);

      if (this.matchesPattern(fixedPackageId, fixedMask)) {
        // This package matches a restriction - check if source is allowed
        const allowedFeeds = restriction.feeds.map((/** @type {string} */ feed) => fixUrl(feed));
        const feedList = allowedFeeds.join(', ');

        for (const allowedFeed of restriction.feeds) {
          const fixedFeed = fixUrl(allowedFeed);
          if (fixedSource === fixedFeed) {
            return { allowed: true, allowedFeeds: feedList };
          }
        }

        // Package matches restriction but source is not in allowed feeds
        return { allowed: false, allowedFeeds: feedList };
      }
    }

    // No restrictions matched - package is allowed from any source
    return { allowed: true, allowedFeeds: '' };
  }

  /**
   * @param {string} packageId
   * @param {string} mask
   * @returns {boolean}
   */
  matchesPattern(packageId, mask) {
    if (mask.includes('*')) {
      const starIndex = mask.indexOf('*');
      const maskPrefix = mask.substring(0, starIndex);
      const packagePrefix = packageId.substring(0, starIndex);
      return packagePrefix === maskPrefix;
    } else {
      return mask === packageId;
    }
  }

  /**
   * @param {string} guid
   * @returns {Promise<boolean>}
   */
  async hasStored(guid) {
    return new Promise((/** @type {(value: boolean) => void} */ resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM PackageVersions WHERE GUID = ?', [guid], (/** @type {Error | null} */ err, /** @type {any} */ row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row.count > 0);
        }
      });
    });
  }

  /**
   * @param {string} dateStr
   * @returns {Date}
   */
  parsePubDate(dateStr) {
    // Handle various RSS date formats
    let cleanDate = dateStr.toLowerCase().replace(/\s+/g, ' ').trim();

    // Remove day of week if present
    if (cleanDate.includes(',')) {
      cleanDate = cleanDate.substring(cleanDate.indexOf(',') + 1).trim();
    } else if (/^(mon|tue|wed|thu|fri|sat|sun)/.test(cleanDate)) {
      cleanDate = cleanDate.substring(cleanDate.indexOf(' ') + 1).trim();
    }

    // Pad single digit day
    if (cleanDate.length > 2 && cleanDate[1] === ' ' && /^\d$/.test(cleanDate[0])) {
      cleanDate = '0' + cleanDate;
    }

    // Try to parse the date
    const date = new Date(cleanDate);
    if (isNaN(date.getTime())) {
      throw new Error(`Cannot parse date: ${dateStr}`);
    }

    return date;
  }

  /**
   * @param {string} source
   * @param {string} url
   * @param {string} guid
   * @param {Date} date
   * @param {Buffer} packageBuffer
   * @param {string} idver
   * @param {any} itemLog
   */
  async store(source, url, guid, date, packageBuffer, idver, itemLog) {
    try {
      // Extract and parse the NPM package
      const npmPackage = await this.extractNpmPackage(packageBuffer, `${source}#${guid}`);

      const {id, version} = npmPackage;

      if (`${id}#${version}` !== idver) {
        const warning = `Warning processing ${idver}: actually found ${id}#${version} in the package`;
        this.log.info(warning);
        itemLog.warning = warning;
      }

      // Validate package data
      if (!this.isValidPackageId(id)) {
        throw new Error(`NPM Id "${id}" is not valid from ${source}`);
      }

      // Save to mirror if configured
      if (this.config.mirrorPath) {
        let fid = this.fixPrefix(id);
        const filename = `${fid}-${version}.tgz`;
        const filepath = path.join(this.config.mirrorPath, filename);
        fs.writeFileSync(filepath, packageBuffer);
      }

      if (!this.isValidSemVersion(version)) {
        throw new Error(`NPM Version "${version}" is not valid from ${source}`);
      }

      let canonical = npmPackage.canonical || `http://simplifier.net/packages/${id}`;
      if (!this.isAbsoluteUrl(canonical)) {
        throw new Error(`NPM Canonical "${canonical}" is not valid from ${source}`);
      }

      const isTemplate = npmPackage.kind === 2; // fhir.template
      if (npmPackage.hasInstallScripts) {
        throw new Error(`Package ${idver} rejected: contains install scripts (preinstall/install/postinstall)`);
      }
      if (npmPackage.hasJavaScript && !isTemplate && id !== 'hl7.fhir.pubpack') {
        throw new Error(`Package ${idver} rejected: contains JavaScript files but is not a template package`);
      }

      // Extract URLs from package
      const urls = this.processPackageUrls(npmPackage);

      // Commit to database
      await this.commit(packageBuffer, npmPackage, date, guid, id, version, canonical, urls);

    } catch (error) {
      debugLog(error);
      this.log.error(`Error storing package ${guid}:`+ errorMessage(error));
      throw error;
    }
  }

  /**
   * @param {Buffer} packageBuffer
   * @param {string} source
   * @returns {Promise<any>}
   */
  async extractNpmPackage(packageBuffer, source) {
    try {
      /** @type {Record<string, string>} */
      const files = {};
      const zlib = require('zlib');

      // First decompress the gzip
      const decompressed = zlib.gunzipSync(packageBuffer);

      // Parse tar manually without any file system operations
      let offset = 0;

      while (offset < decompressed.length) {
        // Read tar header (512 bytes)
        if (offset + 512 > decompressed.length) break;

        const header = decompressed.slice(offset, offset + 512);

        // Check if this is the end (null header)
        if (header[0] === 0) break;

        // Extract filename (first 100 bytes, null-terminated)
        let filename = '';
        for (let i = 0; i < 100; i++) {
          if (header[i] === 0) break;
          filename += String.fromCharCode(header[i]);
        }

        // Extract file size (12 bytes starting at offset 124, octal)
        let sizeStr = '';
        for (let i = 124; i < 136; i++) {
          if (header[i] === 0 || header[i] === 32) break; // null or space
          sizeStr += String.fromCharCode(header[i]);
        }
        const fileSize = parseInt(sizeStr, 8) || 0;

        // Move past header
        offset += 512;

        // Extract file content if we need this file
        if (fileSize > 0) {
          const cleanFilename = filename.replace(/^package\//, ''); // Remove package/ prefix

          const fileContent = decompressed.slice(offset, offset + fileSize);
          files[cleanFilename] = fileContent.toString('utf8');
        }

        // Move to next file (files are padded to 512-byte boundaries)
        const paddedSize = Math.ceil(fileSize / 512) * 512;
        offset += paddedSize;
      }

      // Parse package.json (required)
      if (!files['package.json']) {
        throw new Error('package.json not found in extracted package');
      }

      const packageJson = JSON.parse(files['package.json']);
      const hasInstallScripts = !!(
        packageJson.scripts && (
          packageJson.scripts.preinstall ||
          packageJson.scripts.install ||
          packageJson.scripts.postinstall
        )
      );
      const hasJavaScript = Object.keys(files).some((f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs'));

      // Extract basic NPM fields
      const id = packageJson.name || '';
      const version = packageJson.version || '';
      const description = packageJson.description || '';
      const author = this.extractAuthor(packageJson.author);
      const license = packageJson.license || '';
      const homepage = packageJson.homepage || packageJson.url || '';

      // Extract dependencies
      const dependencies = [];
      if (packageJson.dependencies) {
        for (const [dep, ver] of Object.entries(packageJson.dependencies)) {
          dependencies.push(`${dep}@${ver}`);
        }
      }

      // Extract FHIR-specific metadata
      let fhirVersion = '';
      let fhirVersionList = '';
      let canonical = '';
      let kind = 1; // Default to IG
      let notForPublication = false;

      // Check for FHIR metadata in package.json
      if (packageJson.fhirVersions) {
        if (Array.isArray(packageJson.fhirVersions)) {
          fhirVersionList = packageJson.fhirVersions.join(',');
          fhirVersion = packageJson.fhirVersions[0] || '';
        } else {
          fhirVersion = packageJson.fhirVersions;
          fhirVersionList = packageJson.fhirVersions;
        }
      } else if (packageJson['fhir-version']) {
        fhirVersion = packageJson['fhir-version'];
        fhirVersionList = packageJson['fhir-version'];
      }

      if (packageJson.canonical) {
        canonical = packageJson.canonical;
      }

      if (packageJson.type === 'fhir.core') {
        kind = 0; // Core
      } else if (packageJson.type === 'fhir.template') {
        kind = 2; // Template
      } else {
        kind = 1; // IG (Implementation Guide)
      }

      if (packageJson.notForPublication === true) {
        notForPublication = true;
      }

      // Parse .index.json if present
      if (files['.index.json']) {
        try {
          const indexJson = JSON.parse(files['.index.json']);

          // Extract additional metadata from .index.json
          if (indexJson['fhir-version'] && !fhirVersion) {
            fhirVersion = indexJson['fhir-version'];
            fhirVersionList = indexJson['fhir-version'];
          }

          if (indexJson.canonical && !canonical) {
            canonical = indexJson.canonical;
          }
        } catch (indexError) {
          this.log.warn(`Warning: Could not parse .index.json for ${id}: ${errorMessage(indexError)}`);
        }
      }

      // Parse ig.ini if present
      if (files['ig.ini']) {
        try {
          const iniData = this.parseIniFile(files['ig.ini']);

          if (iniData.IG && iniData.IG.canonical && !canonical) {
            canonical = iniData.IG.canonical;
          }

          if (iniData.IG && iniData.IG['fhir-version'] && !fhirVersion) {
            fhirVersion = iniData.IG['fhir-version'];
            fhirVersionList = iniData.IG['fhir-version'];
          }
        } catch (iniError) {
          this.log.warn(`Warning: Could not parse ig.ini for ${id}: ${errorMessage(iniError)}`);
        }
      }

      // Default fhirVersion if not found
      if (!fhirVersion) {
        fhirVersion = '4.0.1'; // Default to R4
        fhirVersionList = '4.0.1';
      }

      return {
        id,
        version,
        description,
        canonical,
        fhirVersion,
        fhirVersionList,
        author,
        license,
        url: homepage,
        dependencies,
        kind,
        hasInstallScripts,
        hasJavaScript,
        notForPublication,
        files
      };

    } catch (error) {
      console.log(error);
      throw new Error(`Failed to extract NPM package from ${source}: ${errorMessage(error)}`);
    }
  }

  /**
   * @param {any} author
   * @returns {string}
   */
  extractAuthor(author) {
    if (typeof author === 'string') {
      return author;
    } else if (typeof author === 'object' && author.name) {
      return author.name;
    }
    return '';
  }

  /**
   * @param {string} content
   * @returns {Record<string, Record<string, string>>}
   */
  parseIniFile(content) {
    /** @type {Record<string, Record<string, string>>} */
    const result = {};
    /** @type {string | null} */
    let currentSection = null;

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
        continue;
      }

      // Check for section header
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        result[currentSection] = {};
        continue;
      }

      // Check for key=value pair
      const keyValueMatch = trimmed.match(/^([^=]+)=(.*)$/);
      if (keyValueMatch && currentSection) {
        const key = keyValueMatch[1].trim();
        const value = keyValueMatch[2].trim();
        result[currentSection][key] = value;
      }
    }

    return result;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  isValidPackageId(id) {
    // Simple package ID validation
    return /^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(id);
  }

  /**
   * @param {string} version
   * @returns {boolean}
   */
  isValidSemVersion(version) {
    // Simple semantic version validation
    return /^\d+\.\d+\.\d+/.test(version);
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  isAbsoluteUrl(url) {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {any} npmPackage
   * @returns {string[]}
   */
  processPackageUrls(npmPackage) {
    /** @type {string[]} */
    const urls = [];

    try {

      for (const filename of Object.keys(npmPackage.files)) {
        try {
          const bytes = npmPackage.files[filename];
          if (filename.endsWith('.json')) {
            try {
              const jsonContent = JSON.parse(bytes);

              if (jsonContent.url && jsonContent.resourceType) {
                urls.push(jsonContent.url);
              }
            } catch (fileError) {
              // this.log.warn(`Error processing package file ${npmPackage.name}#${npmPackage.version}/package/${filename}: ${fileError.message}`);
            }
          }
        } catch (fileError) {
          this.log.warn(`Error processing package file ${npmPackage.id}#${npmPackage.version}/package/${filename}: ${errorMessage(fileError)}`);
        }
      }
    } catch (error) {
      this.log.warn(`Error processing package URLs for ${npmPackage.id}#${npmPackage.version}:`, errorMessage(error));
    }

    // Include main package URL
    if (npmPackage.url) {
      urls.push(npmPackage.url);
    }

    return urls;
  }

  /**
   * @param {Buffer} data
   * @returns {string}
   */
  genHash(data) {
    return crypto.createHash('sha1').update(data).digest('hex');
  }

  /**
   * @param {Buffer} packageBuffer
   * @param {any} npmPackage
   * @param {Date} date
   * @param {string} guid
   * @param {string} id
   * @param {string} version
   * @param {string} canonical
   * @param {string[]} urls
   * @returns {Promise<void>}
   */
  async commit(packageBuffer, npmPackage, date, guid, id, version, canonical, urls) {
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      // Get next version key
      this.db.get('SELECT MAX(PackageVersionKey) as maxKey FROM PackageVersions', (/** @type {Error | null} */ err, /** @type {any} */ row) => {
        if (err) {
          reject(err);
          return;
        }

        const vkey = (row?.maxKey || 0) + 1;
        const hash = this.genHash(packageBuffer);

        // Insert package version
        const insertVersionSql = `
            INSERT INTO PackageVersions
            (PackageVersionKey, GUID, PubDate, Indexed, Id, Version, Kind, DownloadCount,
             Canonical, FhirVersions, UploadCount, Description, ManualToken, Hash,
             Author, License, HomePage, Content)
            VALUES (?, ?, ?, datetime('now'), ?, ?, ?, 0, ?, ?, 1, ?, '', ?, ?, ?, ?, ?)
        `;

        this.db.run(insertVersionSql, [
          vkey, guid, date.toISOString(), id, version, npmPackage.kind,
          canonical, npmPackage.fhirVersionList, npmPackage.description,
          hash, npmPackage.author, npmPackage.license, npmPackage.url,
          packageBuffer
        ], (/** @type {Error | null} */ err) => {
          if (err) {
            reject(err);
            return;
          }

          // Insert FHIR versions, dependencies, and URLs
          this.insertRelatedData(vkey, npmPackage, urls).then(() => {
            // Handle package table (insert or update)
            this.upsertPackage(id, vkey, canonical).then(resolve).catch(reject);
          }).catch(reject);
        });
      });
    });
  }

  /**
   * @param {number} vkey
   * @param {any} npmPackage
   * @param {string[]} urls
   * @returns {Promise<any[]>}
   */
  async insertRelatedData(vkey, npmPackage, urls) {
    /** @type {Promise<any>[]} */
    const promises = [];

    // Insert FHIR versions
    if (npmPackage.fhirVersionList) {
      const fhirVersions = npmPackage.fhirVersionList.split(',');
      for (const fver of fhirVersions) {
        promises.push(new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
          this.db.run('INSERT INTO PackageFHIRVersions (PackageVersionKey, Version) VALUES (?, ?)',
            [vkey, fver.trim()], (/** @type {Error | null} */ err) => err ? reject(err) : resolve());
        }));
      }
    }

    // Insert dependencies
    for (const dep of npmPackage.dependencies) {
      promises.push(new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
        this.db.run('INSERT INTO PackageDependencies (PackageVersionKey, Dependency) VALUES (?, ?)',
          [vkey, dep], (/** @type {Error | null} */ err) => err ? reject(err) : resolve());
      }));
    }

    // Insert URLs
    for (const url of urls) {
      promises.push(new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
        this.db.run('INSERT INTO PackageURLs (PackageVersionKey, URL) VALUES (?, ?)',
          [vkey, url], (/** @type {Error | null} */ err) => err ? reject(err) : resolve());
      }));
    }

    return Promise.all(promises);
  }

  /**
   * @param {string} id
   * @param {number} vkey
   * @param {string} canonical
   * @returns {Promise<void>}
   */
  async upsertPackage(id, vkey, canonical) {
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      // Check if package exists
      this.db.get('SELECT MAX(PackageKey) as pkey FROM Packages WHERE Id = ?', [id], (/** @type {Error | null} */ err, /** @type {any} */ row) => {
        if (err) {
          reject(err);
          return;
        }

        if (!row?.pkey) {
          // Insert new package
          this.db.get('SELECT MAX(PackageKey) as maxKey FROM Packages', (/** @type {Error | null} */ err, /** @type {any} */ maxRow) => {
            if (err) {
              reject(err);
              return;
            }

            const pkey = (maxRow?.maxKey || 0) + 1;
            this.db.run('INSERT INTO Packages (PackageKey, Id, CurrentVersion, DownloadCount, Canonical) VALUES (?, ?, ?, 0, ?)',
              [pkey, id, vkey, canonical], (/** @type {Error | null} */ err) => err ? reject(err) : resolve());
          });
        } else {
          // Update existing package - check if this is the most recent version
          this.db.get(`
              SELECT PackageVersionKey
              FROM PackageVersions
              WHERE Id = ?
                AND Version != 'current'
              ORDER BY PubDate DESC, Version DESC LIMIT 1
          `, [id], (/** @type {Error | null} */ err, /** @type {any} */ latestRow) => {
            if (err) {
              reject(err);
              return;
            }

            if (latestRow?.PackageVersionKey === vkey) {
              // This is the most recent version, update the package
              this.db.run('UPDATE Packages SET Canonical = ?, CurrentVersion = ? WHERE Id = ?',
                [canonical, vkey, id], (/** @type {Error | null} */ err) => err ? reject(err) : resolve());
            } else {
              resolve(); // Not the most recent, no update needed
            }
          });
        }
      });
    });
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  fixPrefix(id) {
    if (id && id.startsWith("@") && id.includes("/")) {
      return id.replace("@", "$$").replace("/", "$");
    } else {
      return id;
    }
  }
  shutdown() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}

module.exports = PackageCrawler;
