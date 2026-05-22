'use strict';

const fs = require('fs');
const BetterSqlite3 = require('better-sqlite3');
const { CodeSystem } = require('../library/codesystem');
const { parseCanonical } = require('./types');
const { getValueName, getValueDT, getValuePrimitive } = require('../../library/utilities');

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function valueFromProperty(prop) {
  if (!prop || typeof prop !== 'object') return null;
  const primitive = getValuePrimitive(prop);
  if (primitive !== null) return primitive;
  const typed = getValueDT(prop);
  if (typed != null) return cloneJson(typed);
  const valueName = getValueName(prop);
  if (!valueName) return null;
  return cloneJson(prop[valueName]);
}

function ensureCodeSystem(resource) {
  if (resource instanceof CodeSystem) return resource;
  return new CodeSystem(resource);
}

function quoteIdent(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function qualifiedName(schema, table) {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table);
}

function createSupplementSidecarSchema(db, schema = null) {
  const tbl = (name) => qualifiedName(schema, name);
  const idx = (name) => schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
  const idxTable = (name) => schema ? quoteIdent(name) : tbl(name);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tbl('supplement_info')} (
      supplement_id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      version TEXT,
      canonical TEXT NOT NULL,
      target_system TEXT NOT NULL,
      target_version TEXT,
      name TEXT,
      title TEXT,
      language TEXT
    );

    CREATE TABLE IF NOT EXISTS ${tbl('supplement_property_def')} (
      property_code TEXT PRIMARY KEY,
      value_kind TEXT NOT NULL,
      is_hierarchy INTEGER NOT NULL,
      display TEXT,
      source_type TEXT
    );

    CREATE TABLE IF NOT EXISTS ${tbl('supplement_designation')} (
      designation_id INTEGER PRIMARY KEY,
      source_code TEXT NOT NULL,
      active INTEGER NOT NULL,
      language_code TEXT,
      use_system TEXT,
      use_code TEXT,
      term TEXT NOT NULL,
      preferred INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${tbl('supplement_literal')} (
      literal_id INTEGER PRIMARY KEY,
      source_code TEXT NOT NULL,
      property_code TEXT NOT NULL,
      value_raw TEXT,
      value_text TEXT,
      value_num REAL,
      value_bool INTEGER,
      group_id INTEGER NOT NULL,
      active INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${tbl('supplement_link')} (
      edge_id INTEGER PRIMARY KEY,
      source_code TEXT NOT NULL,
      property_code TEXT NOT NULL,
      target_code TEXT NOT NULL,
      target_system TEXT,
      group_id INTEGER NOT NULL,
      active INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${tbl('supplement_extension')} (
      extension_id INTEGER PRIMARY KEY,
      source_code TEXT NOT NULL,
      url TEXT NOT NULL,
      value_json TEXT
    );

    CREATE INDEX IF NOT EXISTS ${idx('idx_supp_designation_source')} ON ${idxTable('supplement_designation')}(source_code);
    CREATE INDEX IF NOT EXISTS ${idx('idx_supp_literal_source_prop')} ON ${idxTable('supplement_literal')}(source_code, property_code);
    CREATE INDEX IF NOT EXISTS ${idx('idx_supp_literal_prop_text')} ON ${idxTable('supplement_literal')}(property_code, value_text);
    CREATE INDEX IF NOT EXISTS ${idx('idx_supp_literal_prop_num')} ON ${idxTable('supplement_literal')}(property_code, value_num);
    CREATE INDEX IF NOT EXISTS ${idx('idx_supp_literal_prop_bool')} ON ${idxTable('supplement_literal')}(property_code, value_bool);
    CREATE INDEX IF NOT EXISTS ${idx('idx_supp_link_source_prop')} ON ${idxTable('supplement_link')}(source_code, property_code);
    CREATE INDEX IF NOT EXISTS ${idx('idx_supp_link_target')} ON ${idxTable('supplement_link')}(target_code);
    CREATE INDEX IF NOT EXISTS ${idx('idx_supp_extension_source')} ON ${idxTable('supplement_extension')}(source_code);
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tbl('search_fts_designation')} USING fts5(term);
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tbl('search_fts_literal')} USING fts5(term);
  `);
}

function detectValueKind(prop, propertyDef, targetSystem, opts = {}) {
  const linkHints = new Set((opts.linkPropertyCodes || []).map(String));
  const code = String(prop?.code || propertyDef?.code || '');
  const typed = getValueDT(prop);
  if (typed && typeof typed === 'object') {
    if (typed.code && (typed.system == null || typed.system === targetSystem || linkHints.has(code))) {
      return 'concept';
    }
  }
  if (linkHints.has(code)) return 'concept';
  return 'literal';
}

function rootPropertyDefs(codeSystem) {
  const defs = new Map();
  for (const def of codeSystem.jsonObj?.property || []) {
    if (!def?.code) continue;
    defs.set(String(def.code), {
      property_code: String(def.code),
      value_kind: def.type === 'Coding' || def.type === 'code' && def.isConcept === true ? 'concept' : 'literal',
      is_hierarchy: def.isHierarchy === true ? 1 : 0,
      display: def.description || def.display || null,
      source_type: def.type || null,
    });
  }
  return defs;
}

function normalizeSupplementRows(resource, opts = {}) {
  const codeSystem = ensureCodeSystem(resource);
  const target = parseCanonical(codeSystem.jsonObj?.supplements);
  if (!target?.url) {
    throw new Error(`Supplement ${codeSystem.url || '(unknown)'} is missing supplements target`);
  }

  const defs = rootPropertyDefs(codeSystem);
  const designations = [];
  const literals = [];
  const links = [];
  const extensions = [];
  let designationId = 1;
  let literalId = 1;
  let edgeId = 1;
  let extensionId = 1;

  for (const concept of codeSystem.getAllConcepts?.() || []) {
    const sourceCode = String(concept?.code || '');
    if (!sourceCode) continue;

    if (concept.display) {
      designations.push({
        designation_id: designationId++,
        source_code: sourceCode,
        active: 1,
        language_code: codeSystem.jsonObj?.language || null,
        use_system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra',
        use_code: 'display',
        term: String(concept.display),
        preferred: 1,
      });
    }

    for (const designation of concept.designation || []) {
      const term = String(designation?.value || '');
      if (!term) continue;
      designations.push({
        designation_id: designationId++,
        source_code: sourceCode,
        active: 1,
        language_code: designation.language || null,
        use_system: designation.use?.system || null,
        use_code: designation.use?.code || null,
        term,
        preferred: 1,
      });
    }

    let groupId = 1;
    for (const prop of concept.property || []) {
      if (!prop?.code) continue;
      const propertyCode = String(prop.code);
      const propertyDef = defs.get(propertyCode) || {
        property_code: propertyCode,
        value_kind: detectValueKind(prop, null, target.url, opts),
        is_hierarchy: 0,
        display: null,
        source_type: getValueName(prop)?.replace(/^value/, '') || null,
      };
      if (!defs.has(propertyCode)) defs.set(propertyCode, propertyDef);

      if (propertyDef.value_kind === 'concept') {
        const value = getValueDT(prop) || {};
        const targetCode = value.code || getValuePrimitive(prop);
        if (targetCode != null) {
          links.push({
            edge_id: edgeId++,
            source_code: sourceCode,
            property_code: propertyCode,
            target_code: String(targetCode),
            target_system: value.system || null,
            group_id: groupId++,
            active: 1,
          });
        }
        continue;
      }

      const value = valueFromProperty(prop);
      if (value == null) continue;
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      literals.push({
        literal_id: literalId++,
        source_code: sourceCode,
        property_code: propertyCode,
        value_raw: raw,
        value_text: typeof value === 'string'
          ? value
          : (typeof value === 'number' || typeof value === 'boolean' ? String(value) : null),
        value_num: typeof value === 'number' ? value : null,
        value_bool: typeof value === 'boolean' ? (value ? 1 : 0) : null,
        group_id: groupId++,
        active: 1,
      });
    }

    for (const ext of concept.extension || []) {
      extensions.push({
        extension_id: extensionId++,
        source_code: sourceCode,
        url: String(ext?.url || ''),
        value_json: JSON.stringify(ext),
      });
    }
  }

  return {
    info: {
      supplement_id: 1,
      url: codeSystem.url,
      version: codeSystem.version || null,
      canonical: codeSystem.vurl || codeSystem.url,
      target_system: target.url,
      target_version: target.version || null,
      name: codeSystem.name || null,
      title: codeSystem.title || null,
      language: codeSystem.jsonObj?.language || null,
    },
    propertyDefs: [...defs.values()].sort((a, b) => a.property_code.localeCompare(b.property_code)),
    designations,
    literals,
    links,
    extensions,
  };
}

function loadSupplementRowsIntoDb(db, rows, schema = null) {
  const tbl = (name) => qualifiedName(schema, name);
  const load = db.transaction((payload) => {
    db.exec(`
      DELETE FROM ${tbl('search_fts_designation')};
      DELETE FROM ${tbl('search_fts_literal')};
      DELETE FROM ${tbl('supplement_extension')};
      DELETE FROM ${tbl('supplement_link')};
      DELETE FROM ${tbl('supplement_literal')};
      DELETE FROM ${tbl('supplement_designation')};
      DELETE FROM ${tbl('supplement_property_def')};
      DELETE FROM ${tbl('supplement_info')};
    `);

    db.prepare(`
      INSERT INTO ${tbl('supplement_info')}
        (supplement_id, url, version, canonical, target_system, target_version, name, title, language)
      VALUES
        (@supplement_id, @url, @version, @canonical, @target_system, @target_version, @name, @title, @language)
    `).run(payload.info);

    const insProp = db.prepare(`
      INSERT INTO ${tbl('supplement_property_def')}
        (property_code, value_kind, is_hierarchy, display, source_type)
      VALUES
        (@property_code, @value_kind, @is_hierarchy, @display, @source_type)
    `);
    for (const row of payload.propertyDefs) insProp.run(row);

    const insDesignation = db.prepare(`
      INSERT INTO ${tbl('supplement_designation')}
        (designation_id, source_code, active, language_code, use_system, use_code, term, preferred)
      VALUES
        (@designation_id, @source_code, @active, @language_code, @use_system, @use_code, @term, @preferred)
    `);
    const insDesignationFts = db.prepare(`INSERT INTO ${tbl('search_fts_designation')}(rowid, term) VALUES (@rowid, @term)`);
    for (const row of payload.designations) {
      insDesignation.run(row);
      insDesignationFts.run({ rowid: row.designation_id, term: row.term });
    }

    const insLiteral = db.prepare(`
      INSERT INTO ${tbl('supplement_literal')}
        (literal_id, source_code, property_code, value_raw, value_text, value_num, value_bool, group_id, active)
      VALUES
        (@literal_id, @source_code, @property_code, @value_raw, @value_text, @value_num, @value_bool, @group_id, @active)
    `);
    const insLiteralFts = db.prepare(`INSERT INTO ${tbl('search_fts_literal')}(rowid, term) VALUES (@rowid, @term)`);
    for (const row of payload.literals) {
      insLiteral.run(row);
      if (row.value_text != null && row.value_text !== '') {
        insLiteralFts.run({ rowid: row.literal_id, term: row.value_text });
      }
    }

    const insLink = db.prepare(`
      INSERT INTO ${tbl('supplement_link')}
        (edge_id, source_code, property_code, target_code, target_system, group_id, active)
      VALUES
        (@edge_id, @source_code, @property_code, @target_code, @target_system, @group_id, @active)
    `);
    for (const row of payload.links) insLink.run(row);

    const insExtension = db.prepare(`
      INSERT INTO ${tbl('supplement_extension')}
        (extension_id, source_code, url, value_json)
      VALUES
        (@extension_id, @source_code, @url, @value_json)
    `);
    for (const row of payload.extensions) insExtension.run(row);
  });

  load(rows);
  return rows;
}

function writeSupplementSidecar(dbPath, resource, opts = {}) {
  const codeSystem = ensureCodeSystem(resource);
  if (opts.overwrite !== false && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  const rows = normalizeSupplementRows(codeSystem, opts);
  const db = new BetterSqlite3(dbPath);
  try {
    createSupplementSidecarSchema(db);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    loadSupplementRowsIntoDb(db, rows);
  } finally {
    db.close();
  }
  return rows;
}

function materializeSupplementInAttachedMemory(db, alias, resource, opts = {}) {
  const rows = normalizeSupplementRows(resource, opts);
  db.prepare('ATTACH DATABASE ? AS ' + quoteIdent(alias)).run(':memory:');
  createSupplementSidecarSchema(db, alias);
  loadSupplementRowsIntoDb(db, rows, alias);
  return rows;
}

function readSupplementSidecarMeta(dbPath) {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM supplement_info LIMIT 1').get() || null;
  } finally {
    db.close();
  }
}

function readSupplementSidecarPropertyDefs(dbPath) {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT property_code, value_kind, is_hierarchy, display, source_type
        FROM supplement_property_def
       ORDER BY property_code
    `).all();
  } finally {
    db.close();
  }
}

function propertyTypeFromSourceType(sourceType, valueKind) {
  const raw = String(sourceType || '').trim();
  if (!raw) return valueKind === 'concept' ? 'code' : 'string';
  const lowered = raw.toLowerCase();
  if (['code', 'coding', 'string', 'boolean', 'integer', 'decimal', 'uri', 'canonical', 'date', 'datetime'].includes(lowered)) {
    return lowered === 'coding' ? 'code' : lowered;
  }
  return valueKind === 'concept' ? 'code' : 'string';
}

function buildLiteralProperty(row, def) {
  const type = propertyTypeFromSourceType(def?.source_type, def?.value_kind);
  if (type === 'boolean' && row.value_bool != null) {
    return { code: row.property_code, valueBoolean: !!row.value_bool };
  }
  if (type === 'integer' && row.value_num != null) {
    return { code: row.property_code, valueInteger: Number(row.value_num) };
  }
  if (type === 'decimal' && row.value_num != null) {
    return { code: row.property_code, valueDecimal: Number(row.value_num) };
  }
  if (type === 'code') {
    return { code: row.property_code, valueCode: row.value_text ?? row.value_raw ?? '' };
  }
  if (type === 'uri') {
    return { code: row.property_code, valueUri: row.value_text ?? row.value_raw ?? '' };
  }
  if (type === 'canonical') {
    return { code: row.property_code, valueCanonical: row.value_text ?? row.value_raw ?? '' };
  }
  if (type === 'date') {
    return { code: row.property_code, valueDate: row.value_text ?? row.value_raw ?? '' };
  }
  if (type === 'datetime') {
    return { code: row.property_code, valueDateTime: row.value_text ?? row.value_raw ?? '' };
  }
  return { code: row.property_code, valueString: row.value_text ?? row.value_raw ?? '' };
}

function buildLinkProperty(row, info) {
  if (row.target_system && row.target_system !== info?.target_system) {
    return {
      code: row.property_code,
      valueCoding: {
        system: row.target_system,
        code: row.target_code,
      },
    };
  }
  return { code: row.property_code, valueCode: row.target_code };
}

function readSupplementSidecarCodeSystem(dbPath) {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const info = db.prepare('SELECT * FROM supplement_info LIMIT 1').get();
    if (!info?.url) return null;

    const propertyDefs = db.prepare(`
      SELECT property_code, value_kind, is_hierarchy, display, source_type
        FROM supplement_property_def
       ORDER BY property_code
    `).all();
    const defsByCode = new Map(propertyDefs.map(def => [String(def.property_code), def]));

    const concepts = new Map();
    function conceptFor(code) {
      const key = String(code || '');
      if (!concepts.has(key)) {
        concepts.set(key, { code: key });
      }
      return concepts.get(key);
    }

    const designations = db.prepare(`
      SELECT designation_id, source_code, language_code, use_system, use_code, term
        FROM supplement_designation
       ORDER BY source_code, designation_id
    `).all();
    for (const row of designations) {
      const concept = conceptFor(row.source_code);
      concept.designation = concept.designation || [];
      const designation = { value: row.term };
      if (row.language_code) designation.language = row.language_code;
      if (row.use_system || row.use_code) {
        designation.use = {};
        if (row.use_system) designation.use.system = row.use_system;
        if (row.use_code) designation.use.code = row.use_code;
      }
      concept.designation.push(designation);
    }

    const literals = db.prepare(`
      SELECT literal_id, source_code, property_code, value_raw, value_text, value_num, value_bool
        FROM supplement_literal
       ORDER BY source_code, literal_id
    `).all();
    for (const row of literals) {
      const concept = conceptFor(row.source_code);
      concept.property = concept.property || [];
      concept.property.push(buildLiteralProperty(row, defsByCode.get(String(row.property_code))));
    }

    const links = db.prepare(`
      SELECT edge_id, source_code, property_code, target_code, target_system
        FROM supplement_link
       ORDER BY source_code, edge_id
    `).all();
    for (const row of links) {
      const concept = conceptFor(row.source_code);
      concept.property = concept.property || [];
      concept.property.push(buildLinkProperty(row, info));
    }

    const extensions = db.prepare(`
      SELECT extension_id, source_code, url, value_json
        FROM supplement_extension
       ORDER BY source_code, extension_id
    `).all();
    for (const row of extensions) {
      const concept = conceptFor(row.source_code);
      concept.extension = concept.extension || [];
      try {
        concept.extension.push(JSON.parse(row.value_json));
      } catch {
        concept.extension.push({ url: row.url });
      }
    }

    const resource = {
      resourceType: 'CodeSystem',
      url: info.url,
      ...(info.version ? { version: info.version } : {}),
      ...(info.name ? { name: info.name } : {}),
      ...(info.title ? { title: info.title } : {}),
      ...(info.language ? { language: info.language } : {}),
      status: 'active',
      content: 'supplement',
      supplements: info.target_version ? `${info.target_system}|${info.target_version}` : info.target_system,
      property: propertyDefs.map(def => ({
        code: def.property_code,
        type: propertyTypeFromSourceType(def.source_type, def.value_kind),
        ...(def.display ? { description: def.display } : {}),
        ...(def.is_hierarchy ? { isHierarchy: true } : {}),
      })),
      concept: [...concepts.values()].sort((a, b) => a.code.localeCompare(b.code)),
    };

    return new CodeSystem(resource);
  } finally {
    db.close();
  }
}

module.exports = {
  createSupplementSidecarSchema,
  loadSupplementRowsIntoDb,
  materializeSupplementInAttachedMemory,
  normalizeSupplementRows,
  readSupplementSidecarCodeSystem,
  readSupplementSidecarPropertyDefs,
  readSupplementSidecarMeta,
  writeSupplementSidecar,
};
