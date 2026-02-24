#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CACHE_DIR="${ROOT_DIR}/data/terminology-cache"
OUT_DIR="${ROOT_DIR}/tests/tx/fixtures/sqlite-supplements"

LOINC_SRC="${CACHE_DIR}/loinc_281_full.v0.db"
RXNORM_SRC="${CACHE_DIR}/rxnorm_02022026.v0.db"
SNOMED_SRC="${CACHE_DIR}/sct_intl_20250201.v0.db"

LOINC_OUT="${OUT_DIR}/supplement-loinc-d8.v0.db"
RXNORM_OUT="${OUT_DIR}/supplement-rxnorm-d8.v0.db"
SNOMED_OUT="${OUT_DIR}/supplement-snomed-d8.v0.db"

SNOMED_ROOTS="${SNOMED_ROOTS:-73211009,85562004}"
D8_SYSTEM="http://example.org/fhir/CodeSystem/d8"
LOINC_TARGET_VERSION_TOKEN="2.81"
RXNORM_TARGET_VERSION_TOKEN="02022026"
SNOMED_TARGET_VERSION_TOKEN="20250201"

for f in "${LOINC_SRC}" "${RXNORM_SRC}" "${SNOMED_SRC}"; do
  if [[ ! -f "${f}" ]]; then
    echo "Required file missing: ${f}" >&2
    exit 1
  fi
done

mkdir -p "${OUT_DIR}"

normalize_target_version_token() {
  local version="${1:-}"
  if [[ -z "${version}" ]]; then
    printf '%s' ""
    return
  fi
  if [[ "${version}" == *"|"* ]]; then
    version="${version##*|}"
  fi
  if [[ "${version}" == */version/* ]]; then
    version="${version##*/version/}"
  fi
  printf '%s' "${version}"
}

init_db() {
  local db="$1"
  local supp_uri="$2"
  local supp_version="$3"
  local target_system="$4"
  local target_version="$5"
  target_version="$(normalize_target_version_token "${target_version}")"

  rm -f "${db}"
  sqlite3 "${db}" <<SQL
PRAGMA journal_mode=WAL;
PRAGMA synchronous=OFF;
PRAGMA temp_store=MEMORY;

CREATE TABLE supplement_manifest (
  supplement_uri TEXT NOT NULL,
  supplement_version TEXT,
  target_system TEXT NOT NULL,
  target_version TEXT,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE supplement_code (
  code_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_supp_code_code ON supplement_code(code);

CREATE TABLE supplement_designation (
  designation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL,
  designation TEXT NOT NULL,
  designation_system TEXT,
  language_code TEXT,
  val TEXT NOT NULL,
  preferred INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_supp_designation_code_designation
  ON supplement_designation(code_id, designation, active);
CREATE INDEX idx_supp_designation_designation_val
  ON supplement_designation(designation, val COLLATE NOCASE, active);

CREATE TABLE supplement_property (
  property_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL,
  property TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  value_string TEXT,
  value_code TEXT,
  value_decimal REAL,
  value_integer INTEGER,
  value_boolean INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_supp_property_code_property
  ON supplement_property(code_id, property, active);
CREATE INDEX idx_supp_property_property_code
  ON supplement_property(property, value_code, active);
CREATE INDEX idx_supp_property_property_string
  ON supplement_property(property, value_string COLLATE NOCASE, active);
CREATE INDEX idx_supp_property_property_active_int_codeid
  ON supplement_property(property, active, value_integer, code_id);
CREATE INDEX idx_supp_property_property_active_dec_codeid
  ON supplement_property(property, active, value_decimal, code_id);
CREATE INDEX idx_supp_property_property_active_bool_codeid
  ON supplement_property(property, active, value_boolean, code_id);
CREATE INDEX idx_supp_property_property_active_lcode_codeid
  ON supplement_property(property, active, lower(value_code), code_id);
CREATE INDEX idx_supp_property_property_active_lstring_codeid
  ON supplement_property(property, active, lower(value_string), code_id);

DROP VIEW IF EXISTS supplement_designation_by_code;
CREATE VIEW supplement_designation_by_code AS
SELECT
  sc.code,
  sd.designation,
  sd.designation_system,
  sd.language_code,
  sd.val,
  sd.preferred,
  sd.active
FROM supplement_designation sd
JOIN supplement_code sc ON sc.code_id = sd.code_id;

DROP VIEW IF EXISTS supplement_property_by_code;
CREATE VIEW supplement_property_by_code AS
SELECT
  sc.code,
  sp.property,
  sp.value_type,
  sp.value_string,
  sp.value_code,
  sp.value_decimal,
  sp.value_integer,
  sp.value_boolean,
  sp.active
FROM supplement_property sp
JOIN supplement_code sc ON sc.code_id = sp.code_id;

INSERT INTO supplement_manifest(supplement_uri, supplement_version, target_system, target_version)
VALUES ('${supp_uri}', '${supp_version}', '${target_system}', '${target_version}');
SQL
}

make_loinc() {
  init_db \
    "${LOINC_OUT}" \
    "http://example.org/fhir/CodeSystem/supplement-loinc-d8" \
    "2026.02" \
    "http://loinc.org" \
    "${LOINC_TARGET_VERSION_TOKEN}"

  sqlite3 "${LOINC_OUT}" <<SQL
ATTACH DATABASE '${LOINC_SRC}' AS src;

INSERT INTO supplement_code(code)
SELECT c.code
FROM src.concept c
WHERE c.cs_id = 1;

CREATE TEMP TABLE roll (
  code_id INTEGER PRIMARY KEY,
  d8 INTEGER NOT NULL
);
INSERT INTO roll(code_id, d8)
SELECT sc.code_id, (ABS(RANDOM()) % 8) + 1
FROM supplement_code sc;

INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT sc.code_id, 'D8', '${D8_SYSTEM}', 'en', 'D8 ' || sc.code, 0, 1
FROM supplement_code sc;

INSERT INTO supplement_property(code_id, property, value_type, value_integer, active)
SELECT r.code_id, 'd8', 'integer', r.d8, 1
FROM roll r;

INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT r.code_id, 'DND', '${D8_SYSTEM}', 'en',
  replace(trim(c.display), ' ', ' ' || (
    CASE ABS(RANDOM()) % 16
      WHEN 0 THEN 'orc'
      WHEN 1 THEN 'goblin'
      WHEN 2 THEN 'dragon'
      WHEN 3 THEN 'bard'
      WHEN 4 THEN 'cleric'
      WHEN 5 THEN 'paladin'
      WHEN 6 THEN 'rogue'
      WHEN 7 THEN 'wizard'
      WHEN 8 THEN 'warlock'
      WHEN 9 THEN 'initiative'
      WHEN 10 THEN 'saving-throw'
      WHEN 11 THEN 'advantage'
      WHEN 12 THEN 'critical-hit'
      WHEN 13 THEN 'beholder'
      WHEN 14 THEN 'dungeon'
      ELSE 'quest'
    END
  ) || ' '),
  0, 1
FROM roll r
JOIN supplement_code sc ON sc.code_id = r.code_id
JOIN src.concept c ON c.code = sc.code
WHERE c.cs_id = 1 AND c.display IS NOT NULL AND length(trim(c.display)) > 0;

INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT r.code_id, 'DND', '${D8_SYSTEM}', 'la',
  replace(trim(c.display), ' ', ' ' || (
    CASE ABS(RANDOM()) % 16
      WHEN 0 THEN 'draco'
      WHEN 1 THEN 'magus'
      WHEN 2 THEN 'clericus'
      WHEN 3 THEN 'palatinus'
      WHEN 4 THEN 'latro'
      WHEN 5 THEN 'gladius'
      WHEN 6 THEN 'arcus'
      WHEN 7 THEN 'sagitta'
      WHEN 8 THEN 'incantatio'
      WHEN 9 THEN 'catacumba'
      WHEN 10 THEN 'templum'
      WHEN 11 THEN 'castrum'
      WHEN 12 THEN 'bestia'
      WHEN 13 THEN 'daemon'
      WHEN 14 THEN 'fortuna'
      ELSE 'thesaurus'
    END
  ) || ' '),
  0, 1
FROM roll r
JOIN supplement_code sc ON sc.code_id = r.code_id
JOIN src.concept c ON c.code = sc.code
WHERE c.cs_id = 1 AND c.display IS NOT NULL AND length(trim(c.display)) > 0;

DROP TABLE roll;
DETACH DATABASE src;
ANALYZE;
VACUUM;
SQL
}

make_rxnorm() {
  init_db \
    "${RXNORM_OUT}" \
    "http://example.org/fhir/CodeSystem/supplement-rxnorm-d8" \
    "2026.02" \
    "http://www.nlm.nih.gov/research/umls/rxnorm" \
    "${RXNORM_TARGET_VERSION_TOKEN}"

  sqlite3 "${RXNORM_OUT}" <<SQL
ATTACH DATABASE '${RXNORM_SRC}' AS src;

INSERT INTO supplement_code(code)
SELECT c.code
FROM src.concept c
WHERE c.cs_id = 1;

CREATE TEMP TABLE roll (
  code_id INTEGER PRIMARY KEY,
  d8 INTEGER NOT NULL
);
INSERT INTO roll(code_id, d8)
SELECT sc.code_id, (ABS(RANDOM()) % 8) + 1
FROM supplement_code sc;

INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT sc.code_id, 'D8', '${D8_SYSTEM}', 'en', 'D8 ' || sc.code, 0, 1
FROM supplement_code sc;

INSERT INTO supplement_property(code_id, property, value_type, value_integer, active)
SELECT r.code_id, 'd8', 'integer', r.d8, 1
FROM roll r;

INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT r.code_id, 'DND', '${D8_SYSTEM}', 'en',
  replace(trim(c.display), ' ', ' ' || (
    CASE ABS(RANDOM()) % 16
      WHEN 0 THEN 'orc'
      WHEN 1 THEN 'goblin'
      WHEN 2 THEN 'dragon'
      WHEN 3 THEN 'bard'
      WHEN 4 THEN 'cleric'
      WHEN 5 THEN 'paladin'
      WHEN 6 THEN 'rogue'
      WHEN 7 THEN 'wizard'
      WHEN 8 THEN 'warlock'
      WHEN 9 THEN 'initiative'
      WHEN 10 THEN 'saving-throw'
      WHEN 11 THEN 'advantage'
      WHEN 12 THEN 'critical-hit'
      WHEN 13 THEN 'beholder'
      WHEN 14 THEN 'dungeon'
      ELSE 'quest'
    END
  ) || ' '),
  0, 1
FROM roll r
JOIN supplement_code sc ON sc.code_id = r.code_id
JOIN src.concept c ON c.code = sc.code
WHERE c.cs_id = 1 AND c.display IS NOT NULL AND length(trim(c.display)) > 0;

INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT r.code_id, 'DND', '${D8_SYSTEM}', 'la',
  replace(trim(c.display), ' ', ' ' || (
    CASE ABS(RANDOM()) % 16
      WHEN 0 THEN 'draco'
      WHEN 1 THEN 'magus'
      WHEN 2 THEN 'clericus'
      WHEN 3 THEN 'palatinus'
      WHEN 4 THEN 'latro'
      WHEN 5 THEN 'gladius'
      WHEN 6 THEN 'arcus'
      WHEN 7 THEN 'sagitta'
      WHEN 8 THEN 'incantatio'
      WHEN 9 THEN 'catacumba'
      WHEN 10 THEN 'templum'
      WHEN 11 THEN 'castrum'
      WHEN 12 THEN 'bestia'
      WHEN 13 THEN 'daemon'
      WHEN 14 THEN 'fortuna'
      ELSE 'thesaurus'
    END
  ) || ' '),
  0, 1
FROM roll r
JOIN supplement_code sc ON sc.code_id = r.code_id
JOIN src.concept c ON c.code = sc.code
WHERE c.cs_id = 1 AND c.display IS NOT NULL AND length(trim(c.display)) > 0;

DROP TABLE roll;
DETACH DATABASE src;
ANALYZE;
VACUUM;
SQL
}

make_snomed() {
  init_db \
    "${SNOMED_OUT}" \
    "http://example.org/fhir/CodeSystem/supplement-snomed-d8" \
    "2026.02" \
    "http://snomed.info/sct" \
    "${SNOMED_TARGET_VERSION_TOKEN}"

  sqlite3 "${SNOMED_OUT}" <<SQL
ATTACH DATABASE '${SNOMED_SRC}' AS src;

CREATE TEMP TABLE selected_codes(code TEXT PRIMARY KEY);
WITH roots AS (
  SELECT trim(value) AS code FROM json_each('["' || replace('${SNOMED_ROOTS}', ',', '","') || '"]')
),
descendants AS (
  SELECT DISTINCT c.code AS code
  FROM roots r
  JOIN src.concept root ON root.code = r.code
  JOIN src.closure cl ON cl.ancestor_id = root.concept_id
  JOIN src.concept c ON c.concept_id = cl.descendant_id
)
INSERT INTO selected_codes(code)
SELECT code FROM descendants;

INSERT INTO supplement_code(code)
SELECT code FROM selected_codes;

CREATE TEMP TABLE roll (
  code_id INTEGER PRIMARY KEY,
  d8 INTEGER NOT NULL
);
INSERT INTO roll(code_id, d8)
SELECT sc.code_id, (ABS(RANDOM()) % 8) + 1
FROM supplement_code sc;

INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT sc.code_id, 'D8', '${D8_SYSTEM}', 'en', 'D8 ' || sc.code, 0, 1
FROM supplement_code sc;

INSERT INTO supplement_property(code_id, property, value_type, value_integer, active)
SELECT r.code_id, 'd8', 'integer', r.d8, 1
FROM roll r;

INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT r.code_id, 'DND', '${D8_SYSTEM}', 'en',
  replace(trim(c.display), ' ', ' ' || (
    CASE ABS(RANDOM()) % 16
      WHEN 0 THEN 'orc'
      WHEN 1 THEN 'goblin'
      WHEN 2 THEN 'dragon'
      WHEN 3 THEN 'bard'
      WHEN 4 THEN 'cleric'
      WHEN 5 THEN 'paladin'
      WHEN 6 THEN 'rogue'
      WHEN 7 THEN 'wizard'
      WHEN 8 THEN 'warlock'
      WHEN 9 THEN 'initiative'
      WHEN 10 THEN 'saving-throw'
      WHEN 11 THEN 'advantage'
      WHEN 12 THEN 'critical-hit'
      WHEN 13 THEN 'beholder'
      WHEN 14 THEN 'dungeon'
      ELSE 'quest'
    END
  ) || ' '),
  0, 1
FROM roll r
JOIN supplement_code sc ON sc.code_id = r.code_id
JOIN src.concept c ON c.code = sc.code
WHERE c.display IS NOT NULL AND length(trim(c.display)) > 0;

INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT r.code_id, 'DND', '${D8_SYSTEM}', 'la',
  replace(trim(c.display), ' ', ' ' || (
    CASE ABS(RANDOM()) % 16
      WHEN 0 THEN 'draco'
      WHEN 1 THEN 'magus'
      WHEN 2 THEN 'clericus'
      WHEN 3 THEN 'palatinus'
      WHEN 4 THEN 'latro'
      WHEN 5 THEN 'gladius'
      WHEN 6 THEN 'arcus'
      WHEN 7 THEN 'sagitta'
      WHEN 8 THEN 'incantatio'
      WHEN 9 THEN 'catacumba'
      WHEN 10 THEN 'templum'
      WHEN 11 THEN 'castrum'
      WHEN 12 THEN 'bestia'
      WHEN 13 THEN 'daemon'
      WHEN 14 THEN 'fortuna'
      ELSE 'thesaurus'
    END
  ) || ' '),
  0, 1
FROM roll r
JOIN supplement_code sc ON sc.code_id = r.code_id
JOIN src.concept c ON c.code = sc.code
WHERE c.display IS NOT NULL AND length(trim(c.display)) > 0;

DROP TABLE roll;
DROP TABLE selected_codes;
DETACH DATABASE src;
ANALYZE;
VACUUM;
SQL
}

make_loinc
make_rxnorm
make_snomed

sqlite3 "${LOINC_OUT}" "select 'loinc.codes', count(*) from supplement_code; select 'loinc.designations', count(*) from supplement_designation; select 'loinc.properties', count(*) from supplement_property;"
sqlite3 "${RXNORM_OUT}" "select 'rxnorm.codes', count(*) from supplement_code; select 'rxnorm.designations', count(*) from supplement_designation; select 'rxnorm.properties', count(*) from supplement_property;"
sqlite3 "${SNOMED_OUT}" "select 'snomed.codes', count(*) from supplement_code; select 'snomed.designations', count(*) from supplement_designation; select 'snomed.properties', count(*) from supplement_property;"

cat <<EOF2
Built synthetic D8 supplement sqlite DBs:
  ${LOINC_OUT}
  ${RXNORM_OUT}
  ${SNOMED_OUT}
EOF2
