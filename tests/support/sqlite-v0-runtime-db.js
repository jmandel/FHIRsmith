'use strict';

const BetterSqlite3 = require('better-sqlite3');

function registerRegexpFunction(db) {
  db.function('regexp', (pattern, value) => {
    if (pattern == null || value == null) return 0;
    const re = new RegExp(String(pattern));
    re.lastIndex = 0;
    return re.test(String(value)) ? 1 : 0;
  });
}

function buildRuntimeSqliteV0Db(fixture, opts = {}) {
  const db = new BetterSqlite3(':memory:');
  registerRegexpFunction(db);
  db.exec(`
    CREATE TABLE concept (
      concept_id INTEGER PRIMARY KEY,
      cs_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      active INTEGER NOT NULL,
      display TEXT,
      definition TEXT
    );
    CREATE TABLE property_def (
      property_id INTEGER PRIMARY KEY,
      cs_id INTEGER NOT NULL,
      property_code TEXT NOT NULL,
      value_kind TEXT NOT NULL,
      is_hierarchy INTEGER NOT NULL,
      display TEXT
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

  const concepts = fixture.concepts || [];
  const byId = new Map(concepts.map(c => [c.concept_id, c]));
  const csId = Number.isInteger(opts.csId)
    ? opts.csId
    : (concepts.find(c => Number.isInteger(c.cs_id))?.cs_id ?? 1);
  const propertyDefs = opts.propertyDefs instanceof Map ? opts.propertyDefs : new Map();
  const edgeSetId = Number.isInteger(opts.runtime?.hierarchy?.edgeSetId) ? opts.runtime.hierarchy.edgeSetId : 1;

  const insConcept = db.prepare('INSERT INTO concept (concept_id, cs_id, code, active, display, definition) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of concepts) {
    insConcept.run(
      row.concept_id,
      row.cs_id ?? csId,
      row.code,
      row.active !== 0 && row.active !== false ? 1 : 0,
      row.display ?? null,
      row.definition ?? null
    );
  }

  const insProp = db.prepare('INSERT INTO property_def (property_id, cs_id, property_code, value_kind, is_hierarchy, display) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [code, def] of propertyDefs.entries()) {
    insProp.run(
      def.property_id,
      csId,
      code,
      def.value_kind || 'literal',
      def.is_hierarchy ? 1 : 0,
      def.display || code
    );
  }

  const propertyIdByCode = new Map();
  for (const [code, def] of propertyDefs.entries()) {
    if (Number.isInteger(def.property_id)) propertyIdByCode.set(String(code), def.property_id);
  }

  const insLiteral = db.prepare(`
    INSERT INTO concept_literal
      (literal_id, edge_set_id, source_concept_id, property_id, value_raw, value_text, value_num, value_bool, group_id, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insLiteralFts = db.prepare('INSERT INTO search_fts_literal(rowid, term) VALUES (?, ?)');
  let literalId = 1;
  for (const row of fixture.literals || []) {
    const propertyId = propertyIdByCode.get(String(row.property || ''));
    if (!Number.isInteger(propertyId)) continue;
    const id = literalId++;
    insLiteral.run(
      id,
      row.edge_set_id ?? edgeSetId,
      row.source_concept_id,
      propertyId,
      row.value_raw ?? null,
      row.value_text ?? null,
      row.value_num ?? null,
      row.value_bool ?? null,
      row.group_id ?? 0,
      row.active !== 0 && row.active !== false ? 1 : 0
    );
    const term = row.value_text ?? row.value_raw;
    if (term != null) insLiteralFts.run(id, String(term));
  }

  const insLink = db.prepare(`
    INSERT INTO concept_link
      (edge_id, edge_set_id, source_concept_id, property_id, target_concept_id, group_id, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let edgeId = 1;
  for (const row of fixture.links || []) {
    const propertyId = propertyIdByCode.get(String(row.property || ''));
    if (!Number.isInteger(propertyId)) continue;
    insLink.run(
      edgeId++,
      row.edge_set_id ?? edgeSetId,
      row.source_concept_id,
      propertyId,
      row.target_concept_id,
      row.group_id ?? 0,
      row.active !== 0 && row.active !== false ? 1 : 0
    );
  }

  const insDesignation = db.prepare(`
    INSERT INTO designation
      (designation_id, concept_id, active, language_code, use_code, term, preferred)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insDesignationFts = db.prepare('INSERT INTO search_fts_designation(rowid, term) VALUES (?, ?)');
  let designationId = 1;
  for (const row of fixture.designations || []) {
    const id = designationId++;
    const term = row.term ?? row.value_text ?? row.value ?? '';
    insDesignation.run(
      id,
      row.concept_id,
      row.active !== 0 && row.active !== false ? 1 : 0,
      row.language_code ?? null,
      row.use_code ?? null,
      term,
      row.preferred !== false ? 1 : 0
    );
    if (term) insDesignationFts.run(id, String(term));
  }

  const insClosure = db.prepare('INSERT INTO closure (ancestor_id, descendant_id) VALUES (?, ?)');
  for (const row of fixture.closure || []) {
    insClosure.run(row.ancestor_id, row.descendant_id);
  }

  const insVs = db.prepare('INSERT INTO value_set (vs_id, cs_id, url, version, name) VALUES (?, ?, ?, ?, ?)');
  const insVsMember = db.prepare('INSERT INTO value_set_member (member_id, vs_id, concept_id, active) VALUES (?, ?, ?, ?)');
  let vsId = 1;
  let memberId = 1;
  for (const [url, members] of Object.entries(fixture.valueSetMembers || {})) {
    insVs.run(vsId, csId, url, null, null);
    for (const member of members || []) {
      const conceptId = typeof member === 'number' ? member : byId.get(member)?.concept_id;
      if (conceptId != null) {
        insVsMember.run(memberId++, vsId, conceptId, 1);
      }
    }
    vsId++;
  }

  const insDisplayFts = db.prepare('INSERT INTO search_fts_display(rowid, term) VALUES (?, ?)');
  for (const row of concepts) {
    if (row.display) insDisplayFts.run(row.concept_id, String(row.display));
  }

  return db;
}

module.exports = {
  buildRuntimeSqliteV0Db,
  registerRegexpFunction,
};
