'use strict';

function normalizeDesignationRows(rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row) continue;
    const value = row.value ?? row.val ?? row.term;
    if (value == null || String(value).length === 0) continue;
    const d = { value: String(value) };

    if (row.language) d.language = String(row.language);
    else if (row.language_code) d.language = String(row.language_code);

    const useSystem = row?.use?.system || row.use_system;
    const useCode = row?.use?.code || row.use_code || row.designation;
    if (useSystem || useCode) {
      d.use = {};
      if (useSystem) d.use.system = String(useSystem);
      if (useCode) d.use.code = String(useCode);
    }
    out.push(d);
  }
  return out;
}

function parseDesignationFilters(rawFilters) {
  const filters = [];
  for (const raw of rawFilters || []) {
    const v = String(raw || '').trim();
    if (!v || v === '*') continue;
    const bar = v.indexOf('|');
    if (bar > 0) {
      const system = v.slice(0, bar).trim();
      const code = v.slice(bar + 1).trim();
      if (system && code) filters.push({ kind: 'use', system, code });
      continue;
    }
    filters.push({ kind: 'language', language: v.toLowerCase() });
  }
  return filters;
}

function filterDesignationsByRequest(designations, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return designations;
  return (designations || []).filter(d => {
    const lang = String(d?.language || '').toLowerCase();
    const useSystem = String(d?.use?.system || '');
    const useCode = String(d?.use?.code || '');
    return filters.some(f => {
      if (f.kind === 'use') return f.system === useSystem && f.code === useCode;
      if (f.kind === 'language') return lang === f.language;
      return false;
    });
  });
}

function suppressRedundantDesignations(designations, display) {
  const out = [];
  const seen = new Set();
  for (const d of designations || []) {
    if (!d?.value) continue;
    const isDisplayUse = !d?.use || String(d?.use?.code || '').toLowerCase() === 'display';
    const isPrimaryLanguage = !d?.language || String(d.language).toLowerCase().startsWith('en');
    if (display && String(d.value) === String(display) && isDisplayUse && isPrimaryLanguage) continue;
    const k = `${d.value}|${d?.language || ''}|${d?.use?.system || ''}|${d?.use?.code || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

function dedupeProperties(props) {
  const out = [];
  const seen = new Set();
  for (const p of props || []) {
    if (!p || !p.code) continue;
    const k = JSON.stringify(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

module.exports = {
  normalizeDesignationRows,
  parseDesignationFilters,
  filterDesignationsByRequest,
  suppressRedundantDesignations,
  dedupeProperties,
};

