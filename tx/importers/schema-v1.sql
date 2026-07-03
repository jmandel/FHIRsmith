-- sqlite-v1: shared terminology storage schema
--
-- One database holds one code system version (operational convention; the
-- cs_id scoping keeps multi-version-per-DB possible later). Behavior that
-- differs per terminology lives in cs_config rows, not in provider code.
-- See docs/sqlite-v1-design.md for the config key registry and semantics.

PRAGMA foreign_keys = OFF;
PRAGMA user_version = 2;

CREATE TABLE IF NOT EXISTS code_system (
  cs_id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_uri TEXT NOT NULL,            -- e.g. http://loinc.org
  edition_code TEXT,                 -- e.g. US1000124 module for SCT
  version TEXT,                      -- version string as served in FHIR
  canonical_uri TEXT NOT NULL,       -- versioned canonical (vurl)
  release_date TEXT,                 -- YYYY-MM-DD, for lockedDate resolution
  name TEXT,
  title TEXT,
  description TEXT,
  content_mode TEXT NOT NULL DEFAULT 'complete',
  source_kind TEXT,                  -- importer id, e.g. 'loinc-sqlite-v1'
  loaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_code_system_base_version
  ON code_system(base_uri, version);

-- Per-code-system behavior/config. Values are strings; JSON where the key
-- registry says so. Providers derive metadata (case sensitivity, default
-- language, hierarchy meaning, implicit value set patterns, version
-- algorithm, status semantics) from here instead of hardcoding.
CREATE TABLE IF NOT EXISTS cs_config (
  cs_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (cs_id, key),
  FOREIGN KEY (cs_id) REFERENCES code_system(cs_id)
);

CREATE TABLE IF NOT EXISTS concept (
  concept_id INTEGER PRIMARY KEY,
  cs_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  display TEXT,
  definition TEXT,
  FOREIGN KEY (cs_id) REFERENCES code_system(cs_id)
);

-- Codes are unique per code system; concept_id is the join identity
-- everywhere else. Case-sensitive lookup uses the unique index; providers
-- for case-insensitive systems (cs_config caseSensitive=0) use the NOCASE
-- index and must verify uniqueness-under-fold at import time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_concept_cs_code
  ON concept(cs_id, code);

CREATE INDEX IF NOT EXISTS idx_concept_active
  ON concept(cs_id, active);

CREATE INDEX IF NOT EXISTS idx_concept_cs_code_nocase
  ON concept(cs_id, code COLLATE NOCASE, concept_id);

CREATE INDEX IF NOT EXISTS idx_concept_cs_display_nocase
  ON concept(cs_id, display COLLATE NOCASE, concept_id);

CREATE TABLE IF NOT EXISTS designation (
  designation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  language_code TEXT,                -- BCP-47
  use_system TEXT,                   -- designation use coding: system
  use_code TEXT,                     --   and code
  term TEXT NOT NULL,
  preferred INTEGER NOT NULL DEFAULT 0,  -- preferred within its language
  FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE INDEX IF NOT EXISTS idx_designation_concept
  ON designation(concept_id, active);
CREATE INDEX IF NOT EXISTS idx_designation_concept_pref_term
  ON designation(concept_id, preferred DESC, term);

CREATE TABLE IF NOT EXISTS property_def (
  property_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cs_id INTEGER NOT NULL,
  property_code TEXT NOT NULL,
  uri TEXT,                          -- CodeSystem.property.uri when known
  fhir_type TEXT NOT NULL,           -- code|Coding|string|integer|boolean|decimal|dateTime
  value_kind TEXT NOT NULL,          -- 'concept' (concept_link) | 'literal' (concept_literal)
  is_hierarchy INTEGER NOT NULL DEFAULT 0,  -- participates in closure / is-a
  display TEXT,
  FOREIGN KEY (cs_id) REFERENCES code_system(cs_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_propdef_cs_code
  ON property_def(cs_id, property_code);

-- Concept-valued properties and hierarchy edges. edge_set_id distinguishes
-- alternative edge sets (e.g. SCT inferred=1 vs stated=2); group_id keeps
-- SCT relationship groups together.
CREATE TABLE IF NOT EXISTS concept_link (
  edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_set_id INTEGER NOT NULL DEFAULT 1,
  source_concept_id INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  target_concept_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (source_concept_id) REFERENCES concept(concept_id),
  FOREIGN KEY (target_concept_id) REFERENCES concept(concept_id),
  FOREIGN KEY (property_id) REFERENCES property_def(property_id)
);

CREATE INDEX IF NOT EXISTS idx_concept_link_source
  ON concept_link(source_concept_id, property_id, edge_set_id, active);
CREATE INDEX IF NOT EXISTS idx_concept_link_target
  ON concept_link(target_concept_id, property_id, edge_set_id, active);
CREATE INDEX IF NOT EXISTS idx_concept_link_prop_active_source
  ON concept_link(property_id, edge_set_id, active, source_concept_id, target_concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_link_prop_active_target
  ON concept_link(property_id, edge_set_id, active, target_concept_id, source_concept_id);

-- Literal-valued properties. value_raw preserves the source lexical form;
-- value_text/value_num/value_bool are typed projections per fhir_type.
CREATE TABLE IF NOT EXISTS concept_literal (
  literal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_set_id INTEGER NOT NULL DEFAULT 1,
  source_concept_id INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  value_raw TEXT,
  value_text TEXT,
  value_num REAL,
  value_bool INTEGER,
  group_id INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (source_concept_id) REFERENCES concept(concept_id),
  FOREIGN KEY (property_id) REFERENCES property_def(property_id)
);

CREATE INDEX IF NOT EXISTS idx_concept_literal_source
  ON concept_literal(source_concept_id, property_id, edge_set_id, active);
CREATE INDEX IF NOT EXISTS idx_concept_literal_prop_active_text_nocase
  ON concept_literal(property_id, active, value_text COLLATE NOCASE, source_concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_literal_prop_active_raw_nocase
  ON concept_literal(property_id, active, value_raw COLLATE NOCASE, source_concept_id);

-- Contentless trigram FTS over display / designation terms / literal text.
-- rowid links to concept_id, designation_id, literal_id respectively.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts_display
  USING fts5(term, tokenize='trigram', content='');
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts_designation
  USING fts5(term, tokenize='trigram', content='');
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts_literal
  USING fts5(term, tokenize='trigram', content='');

-- Transitive closure over active hierarchy edges (edge_set_id = primary).
-- NO self-rows: (a,a) is never stored. 'is-a' = seed ∪ descendants is the
-- query layer's job; 'descendent-of' reads this table directly.
CREATE TABLE IF NOT EXISTS closure (
  ancestor_id INTEGER NOT NULL,
  descendant_id INTEGER NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_closure_descendant
  ON closure(descendant_id, ancestor_id);

-- Enumerated value sets intrinsic to the source (SCT refsets, LOINC answer
-- lists). Implicit value-set URL patterns in cs_config resolve to these.
CREATE TABLE IF NOT EXISTS value_set (
  vs_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cs_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  version TEXT,
  name TEXT,
  FOREIGN KEY (cs_id) REFERENCES code_system(cs_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_value_set_cs_url_version
  ON value_set(cs_id, url, version);

CREATE TABLE IF NOT EXISTS value_set_member (
  member_id INTEGER PRIMARY KEY AUTOINCREMENT,
  vs_id INTEGER NOT NULL,
  concept_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (vs_id) REFERENCES value_set(vs_id),
  FOREIGN KEY (concept_id) REFERENCES concept(concept_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vsm_unique
  ON value_set_member(vs_id, concept_id);

CREATE TABLE IF NOT EXISTS load_audit (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_path TEXT,
  target_db TEXT,
  terminology TEXT,
  edition_code TEXT,
  version TEXT,
  status TEXT NOT NULL,
  stats_json TEXT
);
