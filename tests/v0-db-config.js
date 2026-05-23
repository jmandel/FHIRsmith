'use strict';

const fs = require('fs');
const path = require('path');

// Explicit configuration only: set FHIRSMITH_V0_DB_DIR/V0_DB_DIR or per-file
// overrides. DB-backed tests skip when no local terminology fixtures are named.
const DB_DIR = process.env.FHIRSMITH_V0_DB_DIR || process.env.V0_DB_DIR || null;

const SNOMED_DB = process.env.FHIRSMITH_SNOMED_DB
  || (DB_DIR ? path.join(DB_DIR, 'sct_intl_20250201.v0.db') : null);
const LOINC_DB = process.env.FHIRSMITH_LOINC_DB
  || (DB_DIR ? path.join(DB_DIR, 'loinc_281_full.v0.db') : null);
const RXNORM_DB = process.env.FHIRSMITH_RXNORM_DB
  || (DB_DIR ? path.join(DB_DIR, 'rxnorm_02022026.v0.db') : null);

function exists(p) {
  return typeof p === 'string' && p.length > 0 && fs.existsSync(p);
}

module.exports = {
  DB_DIR,
  SNOMED_DB,
  LOINC_DB,
  RXNORM_DB,
  hasSnomed: exists(SNOMED_DB),
  hasLoinc: exists(LOINC_DB),
  hasRxnorm: exists(RXNORM_DB),
};
