'use strict';
// Value sets into a sqlite-v2 file (docs/sqlite-v2-content-store.md section 4).
//
// A value set is one value_set row (its resource JSON with every enumerated concept list replaced
// by {"$rows": n}), one vs_include row per compose.include / compose.exclude entry, and one
// vs_concept row per enumerated code, as TEXT. Nothing refers to a concept id of any file.
// The search columns are those of tx/vs/vs-database.js upsertValueSet, so search keeps its
// semantics. put() and remove() are one transaction each: a reader (WAL) sees the old or the new
// value set, never a mixture.

const crypto = require('crypto');

const PART_EXCLUDE = 1000000;

function plainConcept(cc) {
  const keys = Object.keys(cc);
  return (keys.length === 1 && keys[0] === 'code') || (keys.length === 2 && keys[0] === 'code' && keys[1] === 'display');
}

class ValueSetWriter {
  constructor(db) {
    this.db = db;
    this.s = {
      byId: db.prepare('SELECT vs_id FROM value_set WHERE id = ?'),
      ins: db.prepare(`INSERT INTO value_set (vs_id, id, url, version, date, description, effectivePeriod_start, effectivePeriod_end,
        expansion_identifier, name, publisher, status, title, content_hash, last_seen, date_first_seen, json)
        VALUES (@vs_id, @id, @url, @version, @date, @description, @es, @ee, @ei, @name, @publisher, @status, @title, @hash, @last_seen, @first_seen, @json)`),
      firstSeen: db.prepare('SELECT date_first_seen FROM value_set WHERE vs_id = ?'),
      del: db.prepare('DELETE FROM value_set WHERE vs_id = ?'),
      delInc: db.prepare('DELETE FROM vs_include WHERE vs_id = ?'),
      delConc: db.prepare('DELETE FROM vs_concept WHERE vs_id = ?'),
      delId: db.prepare('DELETE FROM vs_identifier WHERE vs_id = ?'),
      delJur: db.prepare('DELETE FROM vs_jurisdiction WHERE vs_id = ?'),
      delSys: db.prepare('DELETE FROM vs_system WHERE vs_id = ?'),
      insInc: db.prepare('INSERT INTO vs_include VALUES (?, ?, ?, ?, ?, ?, ?)'),
      insConc: db.prepare('INSERT INTO vs_concept (vs_id, part, code, display, json) VALUES (?, ?, ?, ?, ?)'),
      insId: db.prepare('INSERT INTO vs_identifier VALUES (?, ?, ?, ?, ?, ?)'),
      insJur: db.prepare('INSERT INTO vs_jurisdiction VALUES (?, ?, ?, ?)'),
      insSys: db.prepare('INSERT INTO vs_system VALUES (?, ?, ?)'),
      maxId: db.prepare('SELECT coalesce(max(vs_id), 0) AS m FROM value_set'),
    };
    this.nextId = this.s.maxId.get().m + 1;
    this.counts = { valueSets: 0, includes: 0, codes: 0, conceptJson: 0 };
    this.put = db.transaction((vs, opts) => this._put(vs, opts || {}));
    this.remove = db.transaction((id) => this._remove(id));
  }

  _remove(id) {
    const r = this.s.byId.get(id);
    if (!r) return false;
    this._clear(r.vs_id);
    this.s.del.run(r.vs_id);
    return true;
  }

  _clear(vsId) {
    this.s.delConc.run(vsId);
    this.s.delInc.run(vsId);
    this.s.delId.run(vsId);
    this.s.delJur.run(vsId);
    this.s.delSys.run(vsId);
  }

  /**
   * @param {object} vs  ValueSet JSON as the source holds it (not modified)
   * @param {object} opts { contentHash, lastSeen, dateFirstSeen } (unix seconds)
   * @returns {number} vs_id
   */
  _put(vs, opts) {
    if (!vs.url) throw new Error('ValueSet must have a url property');
    if (!vs.id) throw new Error('ValueSet must have an id');
    const now = Math.floor(Date.now() / 1000);
    const old = this.s.byId.get(vs.id);
    let vsId, firstSeen = opts.dateFirstSeen ?? now;
    if (old) {
      vsId = old.vs_id;
      if (opts.dateFirstSeen == null) firstSeen = this.s.firstSeen.get(vsId).date_first_seen ?? now;
      this._clear(vsId);
      this.s.del.run(vsId);
    } else {
      vsId = this.nextId++;
    }
    // the skeleton: same keys in the same order, enumerated lists replaced by a row count
    const skel = { ...vs };
    const lists = [];
    if (vs.compose) {
      skel.compose = { ...vs.compose };
      for (const [exclude, key] of [[0, 'include'], [1, 'exclude']]) {
        if (!Array.isArray(vs.compose[key])) continue;
        skel.compose[key] = vs.compose[key].map((inc, idx) => {
          const concepts = Array.isArray(inc.concept) ? inc.concept : null;
          lists.push({ exclude, idx, inc, concepts });
          if (!concepts) return inc;
          return { ...inc, concept: { $rows: concepts.length } };
        });
      }
    }
    this.s.ins.run({
      vs_id: vsId, id: vs.id, url: vs.url, version: vs.version || null, date: vs.date || null,
      description: vs.description || null, es: vs.effectivePeriod?.start || null, ee: vs.effectivePeriod?.end || null,
      ei: vs.expansion?.identifier || null, name: vs.name || null, publisher: vs.publisher || null,
      status: vs.status || null, title: vs.title || null,
      // as ValueSetDatabase: the hash of the stored JSON (backfilled there when not given)
      hash: opts.contentHash ?? crypto.createHash('sha256').update(JSON.stringify(vs)).digest('hex'),
      last_seen: opts.lastSeen ?? now, first_seen: firstSeen, json: JSON.stringify(skel)
    });
    for (const l of lists) {
      let first = null;
      if (l.concepts) {
        const part = l.exclude * PART_EXCLUDE + l.idx;
        for (const cc of l.concepts) {
          const plain = plainConcept(cc);
          const info = this.s.insConc.run(vsId, part, String(cc.code), cc.display ?? null, plain ? null : JSON.stringify(cc));
          if (first === null) first = Number(info.lastInsertRowid);
          if (!plain) this.counts.conceptJson++;
        }
        this.counts.codes += l.concepts.length;
      }
      this.s.insInc.run(vsId, l.exclude, l.idx, l.inc.system ?? null, l.inc.version ?? null, l.concepts ? l.concepts.length : 0, first);
      this.counts.includes++;
    }
    // search tables, as vs-database.js _insertRelatedRecords
    if (opts.related === false) {
      this.counts.valueSets++;
      return vsId;
    }
    if (vs.identifier) {
      for (const id of (Array.isArray(vs.identifier) ? vs.identifier : [vs.identifier])) {
        this.s.insId.run(vsId, id.system || null, id.value || null, id.use || null,
          id.type?.coding?.[0]?.system || null, id.type?.coding?.[0]?.code || null);
      }
    }
    for (const j of vs.jurisdiction || []) {
      for (const c of j.coding || []) this.s.insJur.run(vsId, c.system || null, c.code || null, c.display || null);
    }
    for (const inc of vs.compose?.include || []) {
      if (inc.system) this.s.insSys.run(vsId, inc.system, inc.version ?? null);
    }
    this.counts.valueSets++;
    return vsId;
  }
}

module.exports = { ValueSetWriter, PART_EXCLUDE, plainConcept };
