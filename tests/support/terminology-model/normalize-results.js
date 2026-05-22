'use strict';

function normalizeCodeList(values) {
  const input = values instanceof Set ? [...values] : (Array.isArray(values) ? values : (values ? [...values] : []));
  return [...new Set(input.map(String).filter(Boolean))].sort();
}

function normalizeCandidateRows(rows) {
  return (rows || [])
    .map(row => ({
      code: row?.code != null ? String(row.code) : null,
      display: row?.display ?? null,
      active: row?.active != null ? !!row.active : null,
      definition: row?.definition ?? null,
    }))
    .filter(row => row.code)
    .sort((a, b) => a.code.localeCompare(b.code));
}

module.exports = {
  normalizeCandidateRows,
  normalizeCodeList,
};
