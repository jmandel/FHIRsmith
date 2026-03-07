'use strict';

const BetterSqlite3 = require('better-sqlite3');

const DAMAGE_TYPES = ['acid', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'poison', 'radiant', 'thunder'];
const PARTY_ROLES = ['artillery', 'controller', 'defender', 'healer', 'leader', 'scout', 'striker', 'support'];

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  const text = String(input || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function parseDieSpec(spec) {
  if (spec && typeof spec === 'object' && Number.isInteger(spec.sides) && spec.sides > 1) {
    return { sides: spec.sides, label: spec.label ? String(spec.label) : `d${spec.sides}` };
  }
  if (typeof spec === 'number' && Number.isInteger(spec) && spec > 1) {
    return { sides: spec, label: `d${spec}` };
  }
  const raw = String(spec || '').trim().toLowerCase();
  const m = raw.match(/^d?(\d+)$/);
  if (!m) throw new Error(`Invalid die spec '${spec}'`);
  const sides = Number(m[1]);
  if (!Number.isInteger(sides) || sides <= 1) throw new Error(`Invalid die spec '${spec}'`);
  return { sides, label: `d${sides}` };
}

function sqliteV0VersionToken(meta) {
  const baseUri = meta?.baseUri || '';
  const canonicalUri = meta?.canonicalUri || '';
  if (canonicalUri) {
    const prefix = `${baseUri}|`;
    if (prefix !== '|' && canonicalUri.startsWith(prefix)) {
      return canonicalUri.slice(prefix.length);
    }
    return canonicalUri;
  }
  return meta?.version || null;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'codesystem';
}

function readSqliteV0BaseInfo(dbPath, opts = {}) {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const cs = db.prepare('SELECT * FROM code_system LIMIT 1').get();
    if (!cs) throw new Error(`No code_system row in ${dbPath}`);
    const meta = {
      csId: cs.cs_id,
      baseUri: cs.base_uri,
      version: cs.version || null,
      canonicalUri: cs.canonical_uri || null,
      name: cs.name || null,
      releaseDate: cs.release_date || null,
    };
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : null;
    const sql = [
      'SELECT code, display, active',
      'FROM concept',
      'WHERE cs_id = @cs',
      'ORDER BY code',
      limit ? 'LIMIT @limit' : '',
    ].filter(Boolean).join(' ');
    const rows = db.prepare(sql).all(limit ? { cs: cs.cs_id, limit } : { cs: cs.cs_id });
    return {
      system: meta.baseUri,
      version: sqliteV0VersionToken(meta),
      name: meta.name,
      releaseDate: meta.releaseDate,
      codes: rows.map(row => ({
        code: String(row.code),
        display: row.display != null ? String(row.display) : null,
        active: row.active !== 0 && row.active !== false,
      })),
      rawMeta: meta,
    };
  } finally {
    db.close();
  }
}

function rollForCode(code, die, salt = '') {
  const spec = parseDieSpec(die);
  return (fnv1a32(`roll|${spec.label}|${salt}|${code}`) % spec.sides) + 1;
}

function pickFromCode(code, die, salt, label, values) {
  return values[fnv1a32(`${label}|${parseDieSpec(die).label}|${salt}|${code}`) % values.length];
}

function sparseGate(code, die, salt, label, modulo, wanted = 0) {
  return (fnv1a32(`${label}|${parseDieSpec(die).label}|${salt}|${code}`) % modulo) === wanted;
}

function diceBand(roll, sides) {
  if (roll >= sides) return 'max';
  const ratio = roll / sides;
  if (ratio <= 0.33) return 'low';
  if (ratio <= 0.66) return 'mid';
  return 'high';
}

function sharedPropertyDefinitions() {
  return [
    {
      code: 'dice-band',
      uri: 'http://example.org/fhir/CodeSystem/synthetic-dice-supplement#dice-band',
      description: 'Shared additive band derived from the die roll',
      type: 'code',
    },
    {
      code: 'damage-type',
      uri: 'http://example.org/fhir/CodeSystem/synthetic-dice-supplement#damage-type',
      description: 'Shared additive damage type tag',
      type: 'code',
    },
    {
      code: 'party-role',
      uri: 'http://example.org/fhir/CodeSystem/synthetic-dice-supplement#party-role',
      description: 'Sparse shared additive party role tag',
      type: 'code',
    },
    {
      code: 'critical-band',
      uri: 'http://example.org/fhir/CodeSystem/synthetic-dice-supplement#critical-band',
      description: 'Sparse shared additive critical band tag',
      type: 'code',
    },
  ];
}

function dieSpecificPropertyDefinition(die) {
  const spec = parseDieSpec(die);
  return {
    code: `${spec.label}-roll`,
    uri: `http://example.org/fhir/CodeSystem/synthetic-dice-supplement#${spec.label}-roll`,
    description: `Deterministic ${spec.label.toUpperCase()} roll assigned to each base code`,
    type: 'integer',
  };
}

function buildDiceSupplementConcept(code, die, opts = {}) {
  const spec = parseDieSpec(die);
  const salt = opts.salt || '';
  const roll = rollForCode(code, spec, salt);
  const properties = [
    { code: `${spec.label}-roll`, valueInteger: roll },
    { code: 'dice-band', valueCode: diceBand(roll, spec.sides) },
    { code: 'damage-type', valueCode: pickFromCode(code, spec, salt, 'damage-type', DAMAGE_TYPES) },
  ];

  if (sparseGate(code, spec, salt, 'party-role', 4, 0)) {
    properties.push({
      code: 'party-role',
      valueCode: pickFromCode(code, spec, salt, 'party-role-value', PARTY_ROLES),
    });
  }

  if (roll === spec.sides) {
    properties.push({ code: 'critical-band', valueCode: 'max' });
  } else if (roll === 1) {
    properties.push({ code: 'critical-band', valueCode: 'min' });
  }

  const designation = [];
  const language = opts.language || 'en';
  if (roll === spec.sides) {
    designation.push({ language, value: `${spec.label.toUpperCase()} critical success` });
  } else if (roll === 1) {
    designation.push({ language, value: `${spec.label.toUpperCase()} critical failure` });
  }

  return {
    code: String(code),
    ...(designation.length > 0 ? { designation } : {}),
    property: properties,
  };
}

function buildDiceSupplementResource(base, die, opts = {}) {
  const spec = parseDieSpec(die);
  const codes = Array.isArray(base?.codes) ? base.codes : [];
  const urlRoot = String(opts.urlRoot || 'http://example.org/fhir/CodeSystem/synthetic-dice-supplement').replace(/\/+$/, '');
  const baseSlug = slugify(base?.system || 'codesystem');
  const url = `${urlRoot}/${baseSlug}/${spec.label}`;
  const version = String(opts.version || '1');
  const target = base?.version ? `${base.system}|${base.version}` : String(base?.system || '');
  const titleBase = base?.name || base?.system || 'CodeSystem';

  return {
    resourceType: 'CodeSystem',
    url,
    version,
    name: `${slugify(titleBase).replace(/-/g, '_')}_${spec.label}_supplement`,
    title: `${titleBase} ${spec.label.toUpperCase()} synthetic supplement`,
    status: 'active',
    content: 'supplement',
    supplements: target,
    count: codes.length,
    language: opts.language || 'en',
    property: [
      dieSpecificPropertyDefinition(spec),
      ...sharedPropertyDefinitions(),
    ],
    concept: codes.map(item => buildDiceSupplementConcept(item.code || item, spec, opts)),
  };
}

function summarizeDiceSupplement(resource, die) {
  const spec = parseDieSpec(die);
  const rollCode = `${spec.label}-roll`;
  const rollCounts = {};
  let sharedBandCount = 0;
  let sharedRoleCount = 0;
  let designationCount = 0;
  for (const concept of resource?.concept || []) {
    for (const prop of concept.property || []) {
      if (prop.code === rollCode) {
        const key = String(prop.valueInteger);
        rollCounts[key] = (rollCounts[key] || 0) + 1;
      } else if (prop.code === 'dice-band') {
        sharedBandCount += 1;
      } else if (prop.code === 'party-role') {
        sharedRoleCount += 1;
      }
    }
    designationCount += (concept.designation || []).length;
  }
  return {
    die: spec.label,
    concepts: (resource?.concept || []).length,
    rollCounts,
    sharedBandCount,
    sharedRoleCount,
    designationCount,
  };
}

function buildDiceSupplementBundle(base, opts = {}) {
  const dice = (opts.dice || ['d20']).map(parseDieSpec);
  return dice.map(die => {
    const resource = buildDiceSupplementResource(base, die, opts);
    return {
      die: die.label,
      resource,
      summary: summarizeDiceSupplement(resource, die),
    };
  });
}

module.exports = {
  DAMAGE_TYPES,
  PARTY_ROLES,
  buildDiceSupplementBundle,
  buildDiceSupplementConcept,
  buildDiceSupplementResource,
  diceBand,
  fnv1a32,
  parseDieSpec,
  readSqliteV0BaseInfo,
  rollForCode,
  summarizeDiceSupplement,
};
