'use strict';

const fs = require('fs');
const path = require('path');

describe('v0 fixture config', () => {
  test('uses V0_DB_DIR placeholder instead of hardcoded absolute paths', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'v0-test-library.yaml');
    const text = fs.readFileSync(fixturePath, 'utf8');

    expect(text).toContain('${V0_DB_DIR}/sct_intl_20250201.v0.db');
    expect(text).toContain('${V0_DB_DIR}/loinc_281_full.v0.db');
    expect(text).toContain('${V0_DB_DIR}/rxnorm_02022026.v0.db');
    expect(text).not.toContain('/home/exedev/tx-data');
  });
});
