// @ts-check

const fs = require('fs').promises;
const sqlite3 = require('sqlite3').verbose();
const { VersionUtilities } = require('../../library/version-utilities');
const { ConceptMap } = require('../library/conceptmap');

/** @typedef {import('sqlite3').Database} SqliteDatabase */
/** @typedef {{name: string, value: string}} SearchParam */
/** @typedef {{query: string, params: any[]}} SearchQuery */

// Columns that can be returned directly without parsing JSON
const INDEXED_COLUMNS = ['id', 'url', 'version', 'date', 'description', 'name', 'publisher', 'status', 'title'];

/**
 * Shared database layer for ConceptMap providers
 * Handles SQLite operations for indexing and searching ConceptMaps
 */
class ConceptMapDatabase {
  /** @type {number} */
  cmCount = 0;

  /** @type {string} */
  dbPath;

  /**
   * @param {string} dbPath - Path to the SQLite database file
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
  }

  /**
   * Check if the SQLite database already exists
   * @returns {Promise<boolean>}
   */
  async exists() {
    try {
      await fs.access(this.dbPath);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Create the SQLite database with required schema
   * @returns {Promise<void>}
   */
  async create() {
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(new Error(`Failed to create database: ${err.message}`));
          return;
        }

        // Create tables
        db.serialize(() => {
          // Main concept maps table
          db.run(`
              CREATE TABLE conceptmaps (
                                         id TEXT PRIMARY KEY,
                                         url TEXT,
                                         version TEXT,
                                         date TEXT,
                                         description TEXT,
                                         effectivePeriod_start TEXT,
                                         effectivePeriod_end TEXT,
                                         expansion_identifier TEXT,
                                         name TEXT,
                                         publisher TEXT,
                                         status TEXT,
                                         title TEXT,
                                         content TEXT NOT NULL,
                                         last_seen INTEGER DEFAULT (strftime('%s', 'now'))
              )
          `);

          // Identifiers table (0..* Identifier)
          db.run(`
              CREATE TABLE conceptmap_identifiers (
                                                    conceptmap_id TEXT,
                                                    system TEXT,
                                                    value TEXT,
                                                    use_code TEXT,
                                                    type_system TEXT,
                                                    type_code TEXT,
                                                    FOREIGN KEY (conceptmap_id) REFERENCES conceptmaps(url)
              )
          `);

          // Jurisdictions table (0..* CodeableConcept with 0..* Coding)
          db.run(`
              CREATE TABLE conceptmap_jurisdictions (
                                                      conceptmap_id TEXT,
                                                      system TEXT,
                                                      code TEXT,
                                                      display TEXT,
                                                      FOREIGN KEY (conceptmap_id) REFERENCES conceptmaps(url)
              )
          `);

          // Systems table (from compose.include[].system)
          db.run(`
              CREATE TABLE conceptmap_systems (
                                                conceptmap_id TEXT,
                                                system TEXT,
                                                FOREIGN KEY (conceptmap_id) REFERENCES conceptmaps(url)
              )
          `);

          // Create indexes for better search performance
          db.run('CREATE INDEX idx_conceptmaps_url ON conceptmaps(url, version)');
          db.run('CREATE INDEX idx_conceptmaps_version ON conceptmaps(version)');
          db.run('CREATE INDEX idx_conceptmaps_status ON conceptmaps(status)');
          db.run('CREATE INDEX idx_conceptmaps_name ON conceptmaps(name)');
          db.run('CREATE INDEX idx_conceptmaps_title ON conceptmaps(title)');
          db.run('CREATE INDEX idx_conceptmaps_publisher ON conceptmaps(publisher)');
          db.run('CREATE INDEX idx_conceptmaps_last_seen ON conceptmaps(last_seen)');
          db.run('CREATE INDEX idx_identifiers_system ON conceptmap_identifiers(system)');
          db.run('CREATE INDEX idx_identifiers_value ON conceptmap_identifiers(value)');
          db.run('CREATE INDEX idx_jurisdictions_system ON conceptmap_jurisdictions(system)');
          db.run('CREATE INDEX idx_jurisdictions_code ON conceptmap_jurisdictions(code)');
          db.run('CREATE INDEX idx_systems_system ON conceptmap_systems(system)');

          db.close((err) => {
            if (err) {
              reject(new Error(`Failed to close database after creation: ${err.message}`));
            } else {
              resolve();
            }
          });
        });
      });
    });
  }

  /**
   * Insert or update a single ConceptMap in the database
   * @param {any} conceptMap - The ConceptMap resource
   * @returns {Promise<void>}
   */
  async upsertConceptMap(conceptMap) {
    if (!conceptMap.url) {
      throw new Error('ConceptMap must have a url property');
    }

    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(new Error(`Failed to open database: ${err.message}`));
          return;
        }

        // Step 1: Delete existing related records
        db.run('DELETE FROM conceptmap_identifiers WHERE conceptmap_id = ?', [conceptMap.id], (err) => {
          if (err) {
            db.close();
            reject(new Error(`Failed to delete identifiers: ${err.message}`));
            return;
          }

          db.run('DELETE FROM conceptmap_jurisdictions WHERE conceptmap_id = ?', [conceptMap.id], (err) => {
            if (err) {
              db.close();
              reject(new Error(`Failed to delete jurisdictions: ${err.message}`));
              return;
            }

            db.run('DELETE FROM conceptmap_systems WHERE conceptmap_id = ?', [conceptMap.id], (err) => {
              if (err) {
                db.close();
                reject(new Error(`Failed to delete systems: ${err.message}`));
                return;
              }

              // Step 2: Insert main record
              const effectiveStart = conceptMap.effectivePeriod?.start || null;
              const effectiveEnd = conceptMap.effectivePeriod?.end || null;
              const expansionId = conceptMap.expansion?.identifier || null;

              db.run(`
                  INSERT OR REPLACE INTO conceptmaps (
                  id, url, version, date, description, effectivePeriod_start, effectivePeriod_end,
                  expansion_identifier, name, publisher, status, title, content, last_seen
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
              `, [
                conceptMap.id,
                conceptMap.url,
                conceptMap.version || null,
                conceptMap.date || null,
                conceptMap.description || null,
                effectiveStart,
                effectiveEnd,
                expansionId,
                conceptMap.name || null,
                conceptMap.publisher || null,
                conceptMap.status || null,
                conceptMap.title || null,
                JSON.stringify(conceptMap)
              ], (err) => {
                if (err) {
                  db.close();
                  reject(new Error(`Failed to insert main record: ${err.message}`));
                  return;
                }

                // Step 3: Insert related records
                this._insertRelatedRecords(db, conceptMap, resolve, reject);
              });
            });
          });
        });
      });
    });
  }

  /**
   * Insert related records for a ConceptMap
   * @param {SqliteDatabase} db - Database connection
   * @param {any} conceptMap - ConceptMap resource
   * @param {(value?: void) => void} resolve - Promise resolve function
   * @param {(reason?: any) => void} reject - Promise reject function
   * @private
   */
  _insertRelatedRecords(db, conceptMap, resolve, reject) {
    let pendingOperations = 0;
    let hasError = false;

    const operationComplete = () => {
      pendingOperations--;
      if (pendingOperations === 0 && !hasError) {
        db.close();
        resolve();
      }
    };

    /**
     * @param {Error} err
     */
    const operationError = (err) => {
      if (!hasError) {
        hasError = true;
        db.close();
        reject(err);
      }
    };

    // Insert identifiers
    if (conceptMap.identifier) {
      const identifiers = Array.isArray(conceptMap.identifier) ? conceptMap.identifier : [conceptMap.identifier];
      for (const id of identifiers) {
        pendingOperations++;
        const typeSystem = id.type?.coding?.[0]?.system || null;
        const typeCode = id.type?.coding?.[0]?.code || null;

        db.run(`
            INSERT INTO conceptmap_identifiers (
                conceptmap_id, system, value, use_code, type_system, type_code
            ) VALUES (?, ?, ?, ?, ?, ?)
        `, [
          conceptMap.id,
          id.system || null,
          id.value || null,
          id.use || null,
          typeSystem,
          typeCode
        ], (err) => {
          if (err) operationError(new Error(`Failed to insert identifier: ${err.message}`));
          else operationComplete();
        });
      }
    }

    // Insert jurisdictions
    if (conceptMap.jurisdiction) {
      for (const jurisdiction of conceptMap.jurisdiction) {
        if (jurisdiction.coding) {
          for (const coding of jurisdiction.coding) {
            pendingOperations++;
            db.run(`
                INSERT INTO conceptmap_jurisdictions (
                    conceptmap_id, system, code, display
                ) VALUES (?, ?, ?, ?)
            `, [
              conceptMap.id,
              coding.system || null,
              coding.code || null,
              coding.display || null
            ], (err) => {
              if (err) operationError(new Error(`Failed to insert jurisdiction: ${err.message}`));
              else operationComplete();
            });
          }
        }
      }
    }

    // Insert systems from compose.include
    if (conceptMap.compose?.include) {
      for (const include of conceptMap.compose.include) {
        if (include.system) {
          pendingOperations++;

          db.run(`
              INSERT INTO conceptmap_systems (conceptmap_id, system) VALUES (?, ?)
          `, [conceptMap.id, include.system], function(err) {
            if (err) {
              operationError(new Error(`Failed to insert system: ${err.message}`));
            } else {
              operationComplete();
            }
          });
        }
      }
    }

    // If no pending operations, close immediately
    if (pendingOperations === 0) {
      db.close();
      resolve();
    }
  }

  /**
   * Insert multiple ConceptMaps in a batch operation
   * @param {Array<any>} conceptMaps - Array of ConceptMap resources
   * @returns {Promise<void>}
   */
  async batchUpsertConceptMaps(conceptMaps) {
    if (conceptMaps.length === 0) {
      return;
    }

    // Process sequentially to avoid database locking
    for (const conceptMap of conceptMaps) {
      await this.upsertConceptMap(conceptMap.jsonObj);
    }
  }

  /**
   * Load all ConceptMaps from the database
   * @returns {Promise<Map<string, any>>} Map of all ConceptMaps keyed by various combinations
   */
  async loadAllConceptMaps() {
    return new Promise((/** @type {(value: Map<string, any>) => void} */ resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
          reject(new Error(`Failed to open database for loading: ${err.message}`));
          return;
        }

        db.all('SELECT id, url, version, content FROM conceptmaps', [], (err, rows) => {
          if (err) {
            db.close();
            reject(new Error(`Failed to load concept maps: ${err.message}`));
            return;
          }

          try {
            /** @type {Map<string, any>} */
            const conceptMapMap = new Map();
            this.cmCount = rows.length;

            for (const row of rows) {
              const conceptMap = new ConceptMap(JSON.parse(row.content));

              // Store by URL and id alone
              conceptMapMap.set(row.url, conceptMap);
              conceptMapMap.set(row.id, conceptMap);

              if (row.version) {
                // Store by url|version
                const versionKey = `${row.url}|${row.version}`;
                conceptMapMap.set(versionKey, conceptMap);

                // If version is semver, also store by url|major.minor
                try {
                  if (VersionUtilities.isSemVer(row.version)) {
                    const majorMinor = VersionUtilities.getMajMin(row.version);
                    if (majorMinor) {
                      const majorMinorKey = `${row.url}|${majorMinor}`;
                      conceptMapMap.set(majorMinorKey, conceptMap);
                    }
                  }
                } catch (error) {
                  // Ignore version parsing errors, just don't add major.minor key
                }
              }
            }

            db.close((err) => {
              if (err) {
                reject(new Error(`Failed to close database after loading: ${err.message}`));
              } else {
                resolve(conceptMapMap);
              }
            });
          } catch (error) {
            db.close();
            const message = error instanceof Error ? error.message : String(error);
            reject(new Error(`Failed to parse concept map content: ${message}`));
          }
        });
      });
    });
  }

  /**
   * Search for ConceptMaps based on criteria
   * @param {string | number | null | undefined} spaceId - Optional id prefix
   * @param {Array<SearchParam>} searchParams - Search criteria
   * @param {Array<string>|null} [elements] - Optional list of elements to return (for optimization)
   * @returns {Promise<Array<any>>} List of matching ConceptMaps
   */
  async search(spaceId, searchParams, elements = null) {
    const selectedElements = elements || [];

    // Check if we can optimize by selecting only indexed columns
    const canOptimize = selectedElements.length > 0 &&
      selectedElements.every(e => INDEXED_COLUMNS.includes(e));

    // Always include 'id' in the columns to select when optimizing
    const columnsToSelect = canOptimize
      ? (selectedElements.includes('id') ? selectedElements : ['id', ...selectedElements])
      : null;

    return new Promise((/** @type {(value: any[]) => void} */ resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
          reject(new Error(`Failed to open database for search: ${err.message}`));
          return;
        }

        const { query, params } = this._buildSearchQuery(searchParams, columnsToSelect);

        db.all(query, params, (err, rows) => {
          if (err) {
            db.close();
            reject(new Error(`Search query failed: ${err.message}`));
            return;
          }

          try {
            /** @type {any[]} */
            let results;
            if (canOptimize) {
              const selectedColumns = columnsToSelect || [];
              // Construct objects directly from columns - much faster!
              results = rows.map(row => {
                /** @type {Record<string, any>} */
                const obj = { resourceType: 'ConceptMap' };
                for (const elem of selectedColumns) {
                  if (row[elem] !== null && row[elem] !== undefined) {
                    if (elem === 'id' && spaceId) {
                      obj[elem] = `${spaceId}-${row[elem]}`;
                    } else {
                      obj[elem] = row[elem];
                    }
                  }
                }
                return obj;
              });
            } else {
              // Fall back to parsing JSON
              results = rows.map(row => {
                const parsed = JSON.parse(row.content);
                // Prefix id with spaceId if provided
                if (spaceId && parsed.id) {
                  parsed.id = `${spaceId}-${parsed.id}`;
                }
                return parsed;
              });
            }

            db.close((err) => {
              if (err) {
                reject(new Error(`Failed to close database after search: ${err.message}`));
              } else {
                resolve(results);
              }
            });
          } catch (error) {
            db.close();
            const message = error instanceof Error ? error.message : String(error);
            reject(new Error(`Failed to parse search results: ${message}`));
          }
        });
      });
    });
  }

  /**
   * Delete ConceptMaps that weren't seen in the latest scan
   * @param {number} cutoffTimestamp - Unix timestamp, delete records older than this
   * @returns {Promise<number>} Number of records deleted
   */
  async deleteOldConceptMaps(cutoffTimestamp) {
    return new Promise((/** @type {(value: number) => void} */ resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(new Error(`Failed to open database for cleanup: ${err.message}`));
          return;
        }

        // Get ids to delete first so related records can be removed before the main rows.
        db.all('SELECT id FROM conceptmaps WHERE last_seen < ?', [cutoffTimestamp], (err, rows) => {
          if (err) {
            db.close();
            reject(new Error(`Failed to find old records: ${err.message}`));
            return;
          }

          if (rows.length === 0) {
            db.close();
            resolve(0);
            return;
          }

          const idsToDelete = rows.map(row => row.id);
          let deletedCount = 0;
          let pendingDeletes = 0;
          let hasError = false;

          const deleteComplete = () => {
            pendingDeletes--;
            if (pendingDeletes === 0 && !hasError) {
              // Finally delete main records
              db.run('DELETE FROM conceptmaps WHERE last_seen < ?', [cutoffTimestamp], function(err) {
                if (err) {
                  db.close();
                  reject(new Error(`Failed to delete old records: ${err.message}`));
                } else {
                  deletedCount = this.changes;
                  db.close();
                  resolve(deletedCount);
                }
              });
            }
          };

          /**
           * @param {Error} err
           */
          const deleteError = (err) => {
            if (!hasError) {
              hasError = true;
              db.close();
              reject(err);
            }
          };

          // Delete related records first
          const placeholders = idsToDelete.map(() => '?').join(',');

          pendingDeletes = 3; // identifiers, jurisdictions, systems

          db.run(`DELETE FROM conceptmap_identifiers WHERE conceptmap_id IN (${placeholders})`, idsToDelete, (err) => {
            if (err) deleteError(new Error(`Failed to delete identifier records: ${err.message}`));
            else deleteComplete();
          });

          db.run(`DELETE FROM conceptmap_jurisdictions WHERE conceptmap_id IN (${placeholders})`, idsToDelete, (err) => {
            if (err) deleteError(new Error(`Failed to delete jurisdiction records: ${err.message}`));
            else deleteComplete();
          });

          db.run(`DELETE FROM conceptmap_systems WHERE conceptmap_id IN (${placeholders})`, idsToDelete, (err) => {
            if (err) deleteError(new Error(`Failed to delete system records: ${err.message}`));
            else deleteComplete();
          });
        });
      });
    });
  }

  /**
   * Get statistics about the database
   * @returns {Promise<Record<string, any>>} Statistics object
   */
  async getStatistics() {
    return new Promise((/** @type {(value: Record<string, any>) => void} */ resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
          reject(new Error(`Failed to open database for statistics: ${err.message}`));
          return;
        }

        const queries = [
          'SELECT COUNT(*) as total FROM conceptmaps',
          'SELECT status, COUNT(*) as count FROM conceptmaps GROUP BY status',
          'SELECT COUNT(DISTINCT system) as systems FROM conceptmap_systems'
        ];

        /** @type {Record<string, any>} */
        const results = {};
        let completed = 0;

        const checkComplete = () => {
          completed++;
          if (completed === queries.length) {
            db.close();
            resolve(results);
          }
        };

        // Total count
        db.get(queries[0], [], (err, row) => {
          if (err) {
            db.close();
            reject(err);
            return;
          }
          results.totalConceptMaps = row.total;
          checkComplete();
        });

        // Status breakdown
        db.all(queries[1], [], (err, rows) => {
          if (err) {
            db.close();
            reject(err);
            return;
          }
          results.byStatus = {};
          for (const row of rows) {
            results.byStatus[row.status || 'null'] = row.count;
          }
          checkComplete();
        });

        // System count
        db.get(queries[2], [], (err, row) => {
          if (err) {
            db.close();
            reject(err);
            return;
          }
          results.totalSystems = row.systems;
          checkComplete();
        });
      });
    });
  }

  /**
   * Build SQL query for search parameters
   * @param {Array<SearchParam>} searchParams - Search parameters
   * @param {Array<string>|null} [elements] - If provided, select only these columns (optimization)
   * @returns {SearchQuery} Query and parameters
   * @private
   */
  _buildSearchQuery(searchParams, elements = null) {
    /** @type {string[]} */
    const conditions = [];
    /** @type {any[]} */
    const params = [];
    /** @type {Set<string>} */
    const joins = new Set();

    for (const param of searchParams) {
      const { name, value } = param;

      switch (name.toLowerCase()) {
        case 'url':
          conditions.push('v.url LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'version':
          conditions.push('v.version LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'name':
          conditions.push('v.name LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'title':
          conditions.push('v.title LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'status':
          conditions.push('v.status LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'publisher':
          conditions.push('v.publisher LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'description':
          conditions.push('v.description LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'date':
          conditions.push('v.date LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'identifier':
          joins.add('JOIN conceptmap_identifiers vi ON v.id = vi.conceptmap_id');
          conditions.push('(vi.system = ? OR vi.value LIKE ?)');
          params.push(value, `%${value}%`);
          break;

        case 'jurisdiction':
          joins.add('JOIN conceptmap_jurisdictions vj ON v.id = vj.conceptmap_id');
          conditions.push('(vj.system = ? OR vj.code LIKE ?)');
          params.push(value, `%${value}%`);
          break;

        case 'system':
          joins.add('JOIN conceptmap_systems vs ON v.id = vs.conceptmap_id');
          conditions.push('vs.system LIKE ?');
          params.push(`%${value}%`);
          break;

        default:
          // For unknown parameters, try to search in the JSON content
          conditions.push('v.content LIKE ?');
          params.push(`%"${name}"%${value}%`);
          break;
      }
    }

    const joinClause = Array.from(joins).join(' ');
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Select columns based on optimization
    let selectClause;
    if (elements) {
      // Optimized: select only the columns we need
      const columns = elements.map(e => `v.${e}`).join(', ');
      selectClause = `SELECT DISTINCT ${columns}`;
    } else {
      // Full content needed
      selectClause = 'SELECT DISTINCT v.content';
    }

    const query = `
        ${selectClause}
        FROM conceptmaps v
            ${joinClause}
            ${whereClause}
        ORDER BY v.url
    `;

    return { query, params };
  }

  /**
   * @param {any} ids
   * @returns {void}
   */
  // eslint-disable-next-line no-unused-vars
  assignIds(ids) {
    // nothing - we don't do any assigning.
  }
}

module.exports = {
  ConceptMapDatabase
};
