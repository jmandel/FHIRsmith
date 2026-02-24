#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CACHE_DIR="${ROOT_DIR}/data/terminology-cache"
OUT_DIR="${ROOT_DIR}/tests/tx/fixtures/sqlite-supplements"

LOINC_SRC="${CACHE_DIR}/loinc_281_full.v0.db"
RXNORM_SRC="${CACHE_DIR}/rxnorm_02022026.v0.db"
SNOMED_SRC="${CACHE_DIR}/sct_intl_20250201.v0.db"

LOINC_OUT="${OUT_DIR}/supplement-loinc-d20.v0.db"
RXNORM_OUT="${OUT_DIR}/supplement-rxnorm-d20.v0.db"
SNOMED_OUT="${OUT_DIR}/supplement-snomed-d20.v0.db"

SNOMED_ROOTS="${SNOMED_ROOTS:-73211009,85562004}"
D20_SYSTEM="http://example.org/fhir/CodeSystem/d20"

for f in "${LOINC_SRC}" "${RXNORM_SRC}" "${SNOMED_SRC}"; do
  if [[ ! -f "${f}" ]]; then
    echo "Required file missing: ${f}" >&2
    exit 1
  fi
done

mkdir -p "${OUT_DIR}"

init_db() {
  local db="$1"
  local supp_uri="$2"
  local supp_version="$3"
  local target_system="$4"
  local target_version="$5"

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
    "http://example.org/fhir/CodeSystem/supplement-loinc-d20" \
    "2026.02" \
    "http://loinc.org" \
    "2.81"

  sqlite3 "${LOINC_OUT}" <<SQL
ATTACH DATABASE '${LOINC_SRC}' AS src;
INSERT INTO supplement_code(code)
SELECT c.code
FROM src.concept c
WHERE c.cs_id = 1;
CREATE TEMP TABLE loinc_roll (
  code_id INTEGER PRIMARY KEY,
  d20 INTEGER NOT NULL
);
INSERT INTO loinc_roll(code_id, d20)
SELECT sc.code_id, (ABS(RANDOM()) % 20) + 1
FROM src.concept c
JOIN supplement_code sc ON sc.code = c.code
WHERE c.cs_id = 1;
INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT sc.code_id, 'D20', '${D20_SYSTEM}', 'en', 'D20 ' || c.code, 0, 1
FROM src.concept c
JOIN supplement_code sc ON sc.code = c.code
WHERE c.cs_id = 1;
INSERT INTO supplement_property(code_id, property, value_type, value_integer, active)
SELECT lr.code_id, 'd20', 'integer', lr.d20, 1
FROM loinc_roll lr;
INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT lr.code_id, 'DND', '${D20_SYSTEM}', 'en',
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
FROM loinc_roll lr
JOIN supplement_code sc ON sc.code_id = lr.code_id
JOIN src.concept c ON c.code = sc.code
WHERE c.cs_id = 1 AND lr.d20 < 5 AND c.display IS NOT NULL AND length(trim(c.display)) > 0;
INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT lr.code_id, 'DND', '${D20_SYSTEM}', 'fr',
  replace(trim(c.display), ' ', ' ' || (
    CASE ABS(RANDOM()) % 16
      WHEN 0 THEN 'ogre'
      WHEN 1 THEN 'lutin'
      WHEN 2 THEN 'sorcier'
      WHEN 3 THEN 'pretre'
      WHEN 4 THEN 'voleur'
      WHEN 5 THEN 'armure'
      WHEN 6 THEN 'bouclier'
      WHEN 7 THEN 'epee'
      WHEN 8 THEN 'hache'
      WHEN 9 THEN 'fleche'
      WHEN 10 THEN 'torche'
      WHEN 11 THEN 'chateau'
      WHEN 12 THEN 'grotte'
      WHEN 13 THEN 'quete'
      WHEN 14 THEN 'sortilege'
      ELSE 'grimoire'
    END
  ) || ' '),
  0, 1
FROM loinc_roll lr
JOIN supplement_code sc ON sc.code_id = lr.code_id
JOIN src.concept c ON c.code = sc.code
WHERE c.cs_id = 1 AND lr.d20 < 5 AND c.display IS NOT NULL AND length(trim(c.display)) > 0;
DROP TABLE loinc_roll;
DETACH DATABASE src;
ANALYZE;
VACUUM;
SQL
}

make_rxnorm() {
  init_db \
    "${RXNORM_OUT}" \
    "http://example.org/fhir/CodeSystem/supplement-rxnorm-d20" \
    "2026.02" \
    "http://www.nlm.nih.gov/research/umls/rxnorm" \
    "02022026"

  sqlite3 "${RXNORM_OUT}" <<SQL
ATTACH DATABASE '${RXNORM_SRC}' AS src;
INSERT INTO supplement_code(code)
SELECT c.code
FROM src.concept c
WHERE c.cs_id = 1;
CREATE TEMP TABLE rx_roll (
  code_id INTEGER PRIMARY KEY,
  d20 INTEGER NOT NULL
);
INSERT INTO rx_roll(code_id, d20)
SELECT sc.code_id, (ABS(RANDOM()) % 20) + 1
FROM src.concept c
JOIN supplement_code sc ON sc.code = c.code
WHERE c.cs_id = 1;
INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT sc.code_id, 'D20', '${D20_SYSTEM}', 'en', 'D20 ' || c.code, 0, 1
FROM src.concept c
JOIN supplement_code sc ON sc.code = c.code
WHERE c.cs_id = 1;
INSERT INTO supplement_property(code_id, property, value_type, value_integer, active)
SELECT rr.code_id, 'd20', 'integer', rr.d20, 1
FROM rx_roll rr;
INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT rr.code_id, 'DND', '${D20_SYSTEM}', 'en',
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
FROM rx_roll rr
JOIN supplement_code sc ON sc.code_id = rr.code_id
JOIN src.concept c ON c.code = sc.code
WHERE c.cs_id = 1 AND rr.d20 < 5 AND c.display IS NOT NULL AND length(trim(c.display)) > 0;
INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT rr.code_id, 'DND', '${D20_SYSTEM}', 'fr',
  replace(trim(c.display), ' ', ' ' || (
    CASE ABS(RANDOM()) % 16
      WHEN 0 THEN 'ogre'
      WHEN 1 THEN 'lutin'
      WHEN 2 THEN 'sorcier'
      WHEN 3 THEN 'pretre'
      WHEN 4 THEN 'voleur'
      WHEN 5 THEN 'armure'
      WHEN 6 THEN 'bouclier'
      WHEN 7 THEN 'epee'
      WHEN 8 THEN 'hache'
      WHEN 9 THEN 'fleche'
      WHEN 10 THEN 'torche'
      WHEN 11 THEN 'chateau'
      WHEN 12 THEN 'grotte'
      WHEN 13 THEN 'quete'
      WHEN 14 THEN 'sortilege'
      ELSE 'grimoire'
    END
  ) || ' '),
  0, 1
FROM rx_roll rr
JOIN supplement_code sc ON sc.code_id = rr.code_id
JOIN src.concept c ON c.code = sc.code
WHERE c.cs_id = 1 AND rr.d20 < 5 AND c.display IS NOT NULL AND length(trim(c.display)) > 0;
DROP TABLE rx_roll;
DETACH DATABASE src;
ANALYZE;
VACUUM;
SQL
}

make_snomed() {
  init_db \
    "${SNOMED_OUT}" \
    "http://example.org/fhir/CodeSystem/supplement-snomed-d20" \
    "2026.02" \
    "http://snomed.info/sct" \
    "20250201"

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
CREATE TEMP TABLE snomed_roll (
  code_id INTEGER PRIMARY KEY,
  d20 INTEGER NOT NULL
);
INSERT INTO snomed_roll(code_id, d20)
SELECT scode.code_id, (ABS(RANDOM()) % 20) + 1
FROM supplement_code scode;
INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT scode.code_id, 'D20', '${D20_SYSTEM}', 'en', 'D20 ' || sc.code, 0, 1
FROM selected_codes sc
JOIN supplement_code scode ON scode.code = sc.code;
INSERT INTO supplement_property(code_id, property, value_type, value_integer, active)
SELECT sr.code_id, 'd20', 'integer', sr.d20, 1
FROM snomed_roll sr;
INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT sr.code_id, 'DND', '${D20_SYSTEM}', 'en',
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
FROM snomed_roll sr
JOIN supplement_code sc ON sc.code_id = sr.code_id
JOIN src.concept c ON c.code = sc.code
WHERE sr.d20 < 5 AND c.display IS NOT NULL AND length(trim(c.display)) > 0;
INSERT INTO supplement_designation(code_id, designation, designation_system, language_code, val, preferred, active)
SELECT sr.code_id, 'DND', '${D20_SYSTEM}', 'fr',
  replace(trim(c.display), ' ', ' ' || (
    CASE ABS(RANDOM()) % 16
      WHEN 0 THEN 'ogre'
      WHEN 1 THEN 'lutin'
      WHEN 2 THEN 'sorcier'
      WHEN 3 THEN 'pretre'
      WHEN 4 THEN 'voleur'
      WHEN 5 THEN 'armure'
      WHEN 6 THEN 'bouclier'
      WHEN 7 THEN 'epee'
      WHEN 8 THEN 'hache'
      WHEN 9 THEN 'fleche'
      WHEN 10 THEN 'torche'
      WHEN 11 THEN 'chateau'
      WHEN 12 THEN 'grotte'
      WHEN 13 THEN 'quete'
      WHEN 14 THEN 'sortilege'
      ELSE 'grimoire'
    END
  ) || ' '),
  0, 1
FROM snomed_roll sr
JOIN supplement_code sc ON sc.code_id = sr.code_id
JOIN src.concept c ON c.code = sc.code
WHERE sr.d20 < 5 AND c.display IS NOT NULL AND length(trim(c.display)) > 0;
DROP TABLE snomed_roll;

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

cat <<EOF
Built synthetic D20 supplement sqlite DBs:
  ${LOINC_OUT}
  ${RXNORM_OUT}
  ${SNOMED_OUT}
EOF
