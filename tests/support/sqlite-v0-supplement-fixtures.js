'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('yaml');
const express = require('express');
const BetterSqlite3 = require('better-sqlite3');

const TXModule = require('../../tx/tx');

function makeBaseConcepts(count = 320) {
  return Array.from({ length: count }, (_, index) => ({
    concept_id: index + 1,
    cs_id: 1,
    code: `C${String(index + 1).padStart(4, '0')}`,
    display: `Code ${index + 1}`,
    active: 1,
    definition: `Definition ${index + 1}`,
  }));
}

function buildTempV0DbFile(baseConcepts, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-v0-supp-config-'));
  const dbPath = path.join(dir, 'base.v0.db');
  const db = new BetterSqlite3(dbPath);
  try {
    db.exec(`
      CREATE TABLE code_system (
        cs_id INTEGER PRIMARY KEY,
        base_uri TEXT,
        version TEXT,
        canonical_uri TEXT,
        release_date TEXT,
        loaded_at TEXT,
        name TEXT,
        edition_code TEXT
      );
      CREATE TABLE cs_config (
        cs_id INTEGER,
        key TEXT,
        value TEXT
      );
      CREATE TABLE property_def (
        property_id INTEGER PRIMARY KEY,
        cs_id INTEGER,
        property_code TEXT,
        value_kind TEXT,
        is_hierarchy INTEGER,
        display TEXT,
        source_type TEXT
      );
      CREATE TABLE concept (
        concept_id INTEGER PRIMARY KEY,
        cs_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        active INTEGER NOT NULL,
        display TEXT,
        definition TEXT
      );
      CREATE TABLE concept_literal (
        literal_id INTEGER PRIMARY KEY,
        edge_set_id INTEGER NOT NULL,
        source_concept_id INTEGER NOT NULL,
        property_id INTEGER NOT NULL,
        value_raw TEXT,
        value_text TEXT,
        value_num REAL,
        value_bool INTEGER,
        group_id INTEGER NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE TABLE concept_link (
        edge_id INTEGER PRIMARY KEY,
        edge_set_id INTEGER NOT NULL,
        source_concept_id INTEGER NOT NULL,
        property_id INTEGER NOT NULL,
        target_concept_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE TABLE designation (
        designation_id INTEGER PRIMARY KEY,
        concept_id INTEGER NOT NULL,
        active INTEGER NOT NULL,
        language_code TEXT,
        use_code TEXT,
        term TEXT NOT NULL,
        preferred INTEGER NOT NULL
      );
      CREATE TABLE closure (
        ancestor_id INTEGER NOT NULL,
        descendant_id INTEGER NOT NULL
      );
      CREATE TABLE value_set (
        vs_id INTEGER PRIMARY KEY,
        cs_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        version TEXT,
        name TEXT
      );
      CREATE TABLE value_set_member (
        member_id INTEGER PRIMARY KEY,
        vs_id INTEGER NOT NULL,
        concept_id INTEGER NOT NULL,
        active INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE search_fts_display USING fts5(term);
      CREATE VIRTUAL TABLE search_fts_designation USING fts5(term);
      CREATE VIRTUAL TABLE search_fts_literal USING fts5(term);
    `);

    const system = opts.system || 'http://example.org/base';
    const version = opts.version || '1';
    db.prepare(`
      INSERT INTO code_system
        (cs_id, base_uri, version, canonical_uri, release_date, loaded_at, name, edition_code)
      VALUES
        (1, @system, @version, @canonical, '2026-03-06', '2026-03-06T00:00:00Z', 'Synthetic Base', NULL)
    `).run({
      system,
      version,
      canonical: `${system}|${version}`,
    });

    db.prepare(`
      INSERT INTO cs_config (cs_id, key, value)
      VALUES (1, 'runtime.search', @value)
    `).run({
      value: JSON.stringify({
        mode: 'fts',
        sources: ['designation', 'literal'],
        activeOnly: true,
        designationActiveOnly: true,
        literalActiveOnly: true,
        ftsTables: {
          display: 'search_fts_display',
          designation: 'search_fts_designation',
          literal: 'search_fts_literal',
        },
      }),
    });

    const insConcept = db.prepare(`
      INSERT INTO concept (concept_id, cs_id, code, active, display, definition)
      VALUES (@concept_id, @cs_id, @code, @active, @display, @definition)
    `);
    const insProp = db.prepare(`
      INSERT INTO property_def (property_id, cs_id, property_code, value_kind, is_hierarchy, display, source_type)
      VALUES (@property_id, 1, @property_code, @value_kind, @is_hierarchy, @display, @source_type)
    `);
    const insLiteral = db.prepare(`
      INSERT INTO concept_literal
        (literal_id, edge_set_id, source_concept_id, property_id, value_raw, value_text, value_num, value_bool, group_id, active)
      VALUES
        (@literal_id, @edge_set_id, @source_concept_id, @property_id, @value_raw, @value_text, @value_num, @value_bool, @group_id, @active)
    `);
    const insLink = db.prepare(`
      INSERT INTO concept_link
        (edge_id, edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)
      VALUES
        (@edge_id, @edge_set_id, @source_concept_id, @property_id, @target_concept_id, @group_id, @active)
    `);
    const insLiteralFts = db.prepare('INSERT INTO search_fts_literal(rowid, term) VALUES (@rowid, @term)');
    const insDisplayFts = db.prepare('INSERT INTO search_fts_display(rowid, term) VALUES (@rowid, @term)');
    const propertyDefs = opts.propertyDefs || [];
    for (const def of propertyDefs) {
      insProp.run({
        property_id: def.property_id,
        property_code: def.property_code,
        value_kind: def.value_kind || 'literal',
        is_hierarchy: def.is_hierarchy ? 1 : 0,
        display: def.display || def.property_code,
        source_type: def.source_type || null,
      });
    }
    const propertyIdByCode = new Map(propertyDefs.map(def => [String(def.property_code), def.property_id]));
    for (const concept of baseConcepts) {
      insConcept.run(concept);
      insDisplayFts.run({ rowid: concept.concept_id, term: concept.display });
    }
    let literalId = 1;
    for (const literal of opts.literals || []) {
      const propertyId = literal.property_id ?? propertyIdByCode.get(String(literal.property_code || ''));
      if (!Number.isInteger(propertyId)) continue;
      insLiteral.run({
        literal_id: literal.literal_id ?? literalId++,
        edge_set_id: literal.edge_set_id ?? 1,
        source_concept_id: literal.source_concept_id,
        property_id: propertyId,
        value_raw: literal.value_raw ?? null,
        value_text: literal.value_text ?? null,
        value_num: literal.value_num ?? null,
        value_bool: literal.value_bool ?? null,
        group_id: literal.group_id ?? 0,
        active: literal.active === 0 || literal.active === false ? 0 : 1,
      });
      const term = literal.value_text ?? literal.value_raw;
      if (term != null) insLiteralFts.run({ rowid: literal.literal_id ?? (literalId - 1), term: String(term) });
    }
    let edgeId = 1;
    for (const link of opts.links || []) {
      const propertyId = link.property_id ?? propertyIdByCode.get(String(link.property_code || ''));
      if (!Number.isInteger(propertyId)) continue;
      insLink.run({
        edge_id: link.edge_id ?? edgeId++,
        edge_set_id: link.edge_set_id ?? 1,
        source_concept_id: link.source_concept_id,
        property_id: propertyId,
        target_concept_id: link.target_concept_id,
        group_id: link.group_id ?? 0,
        active: link.active === 0 || link.active === false ? 0 : 1,
      });
    }
  } finally {
    db.close();
  }
  return { dir, dbPath };
}

function writeLibraryConfig(configPath, dbPath, supplementPaths) {
  const config = {
    base: {
      url: 'https://storage.googleapis.com/tx-fhir-org',
    },
    sources: [{
      source: `sqlite-v0:${dbPath}`,
      options: {
        supplements: supplementPaths,
      },
    }],
  };
  fs.writeFileSync(configPath, yaml.stringify(config), 'utf8');
}

async function createTempTxApp(configPath) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const txModule = new TXModule();
  await txModule.initialize({
    librarySource: configPath,
    endpoints: [{
      path: '/tx/r5',
      fhirVersion: '5.0',
      context: null,
    }],
  }, app);

  return { app, txModule };
}

module.exports = {
  buildTempV0DbFile,
  createTempTxApp,
  makeBaseConcepts,
  writeLibraryConfig,
};
