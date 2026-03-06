#!/usr/bin/env node
'use strict';

import fs from 'fs';
import path from 'path';
import BetterSqlite3 from 'better-sqlite3';

function normalizeIsoDate(raw) {
  const v = String(raw || '').trim();
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1800 || y > 2400 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function digitsDateToIso(raw) {
  const v = String(raw || '').trim();
  if (!/^\d{8}$/.test(v)) return null;
  const y = Number(v.slice(0, 4));
  const mo = Number(v.slice(4, 6));
  const d = Number(v.slice(6, 8));
  if (y < 1800 || y > 2400 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

function mmddyyyyToIso(raw) {
  const v = String(raw || '').trim();
  if (!/^\d{8}$/.test(v)) return null;
  const mo = Number(v.slice(0, 2));
  const d = Number(v.slice(2, 4));
  const y = Number(v.slice(4, 8));
  if (y < 1800 || y > 2400 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${v.slice(4, 8)}-${v.slice(0, 2)}-${v.slice(2, 4)}`;
}

function extractReleaseDate({ releaseDate, canonicalUri, version, loadedAt }) {
  const explicit = normalizeIsoDate(releaseDate) || digitsDateToIso(releaseDate) || mmddyyyyToIso(releaseDate);
  if (explicit) return explicit;

  const canonical = String(canonicalUri || '');
  const ver = String(version || '');
  const loaded = String(loadedAt || '');

  const snomed = canonical.match(/\/version\/(\d{8})(?:$|[/?#])/);
  if (snomed) {
    const iso = digitsDateToIso(snomed[1]);
    if (iso) return iso;
  }

  const eight = ver.match(/(\d{8})/);
  if (eight) {
    const iso = digitsDateToIso(eight[1]) || mmddyyyyToIso(eight[1]);
    if (iso) return iso;
  }

  const isoToken = ver.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoToken) {
    const iso = normalizeIsoDate(isoToken[1]);
    if (iso) return iso;
  }

  const loadedIso = loaded.match(/^(\d{4}-\d{2}-\d{2})/);
  if (loadedIso) {
    const iso = normalizeIsoDate(loadedIso[1]);
    if (iso) return iso;
  }

  return null;
}

function hasColumn(db, table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => String(r.name) === col);
}

function processDb(dbPath) {
  const db = new BetterSqlite3(dbPath);
  try {
    if (!hasColumn(db, 'code_system', 'release_date')) {
      db.exec('ALTER TABLE code_system ADD COLUMN release_date TEXT');
    }

    const row = db.prepare('SELECT cs_id, version, canonical_uri, loaded_at, release_date FROM code_system LIMIT 1').get();
    if (!row) {
      console.log(`[skip] ${dbPath}: no code_system row`);
      return;
    }

    const releaseDate = extractReleaseDate({
      releaseDate: row.release_date,
      canonicalUri: row.canonical_uri,
      version: row.version,
      loadedAt: row.loaded_at,
    });

    db.prepare('UPDATE code_system SET release_date = @releaseDate WHERE cs_id = @csId').run({
      releaseDate,
      csId: row.cs_id,
    });

    console.log(`[ok] ${dbPath}: release_date=${releaseDate || '(null)'}`);
  } finally {
    db.close();
  }
}

function collectDbFiles(args) {
  const out = [];
  for (const a of args) {
    const p = path.resolve(a);
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.isFile() && p.endsWith('.db')) {
      out.push(p);
      continue;
    }
    if (st.isDirectory()) {
      for (const ent of fs.readdirSync(p)) {
        if (ent.endsWith('.db')) out.push(path.join(p, ent));
      }
    }
  }
  return [...new Set(out)].sort();
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/backfill-v0-release-date.mjs <db-file-or-dir> [...]');
  process.exit(1);
}

const dbFiles = collectDbFiles(args);
if (dbFiles.length === 0) {
  console.error('No .db files found.');
  process.exit(1);
}

for (const dbPath of dbFiles) {
  processDb(dbPath);
}
