// The codes one code system's value sets list, and how often each was seen, packed into typed
// arrays. Every process that answers requests needs them (a tx-worker as well as the master: a
// worker answers $expand with the usage-count property, and counts the codes it validates), and
// the scan of the demo library fills the 1,000,000-code limit: as a Map of a string and a {count}
// object per code that took about 108 MB of V8 heap per process; packed it takes about 31 MB
// outside the heap (the UTF-8 bytes of the codes, 4 + 4 bytes per code and a hash table).
//
// The codes are appended to one byte buffer in the order first seen; code i is
// bytes[starts[i] .. starts[i + 1]). An open-addressed hash table (slots) holds i + 1 per code.
class CodeUsages {
  constructor() {
    this.size = 0;
    this.bytes = Buffer.allocUnsafeSlow(64);
    this.used = 0;                          // bytes in use
    this.starts = new Uint32Array(8);       // starts[size] = used
    this.counts = new Uint32Array(8);
    this.slots = new Uint32Array(16);       // 0 = empty, else index + 1; at most half full
  }

  /** @returns {number} the slot of the code in scratch[0 .. n): its index + 1, or ~slot where it would go */
  #find(scratch, n) {
    let h = 0x811c9dc5;                     // FNV-1a
    for (let k = 0; k < n; k++) {
      h = Math.imul(h ^ scratch[k], 0x01000193);
    }
    const mask = this.slots.length - 1;
    for (let s = h & mask; ; s = (s + 1) & mask) {
      const e = this.slots[s];
      if (e === 0) {
        return ~s;
      }
      const a = this.starts[e - 1], b = this.starts[e];
      if (b - a === n && this.bytes.compare(scratch, 0, n, a, b) === 0) {
        return e;
      }
    }
  }

  /** @returns {number} the index + 1 of the code, or 0 if it isn't here */
  #indexOf(code) {
    const n = encode(code);
    if (n < 0) return 0;
    const r = this.#find(SCRATCH, n);
    return r > 0 ? r : 0;
  }

  /** count one more use of code; @returns {boolean} false if it isn't here (not counted) */
  see(code) {
    const e = this.#indexOf(code);
    if (e) {
      this.counts[e - 1]++;
    }
    return e > 0;
  }

  /** add code, which isn't here, with a count of 1; @returns {boolean} false if it can't be (not a string) */
  add(code) {
    const n = encode(code);
    if (n < 0) return false;
    if ((this.size + 1) * 2 > this.slots.length) {
      this.#rehash();
    }
    const slot = ~this.#find(SCRATCH, n);
    if (this.used + n > this.bytes.length) {
      const b = Buffer.allocUnsafeSlow(Math.max(this.bytes.length * 2, this.used + n));
      this.bytes.copy(b, 0, 0, this.used);
      this.bytes = b;
    }
    if (this.size + 1 >= this.starts.length) {
      const s = new Uint32Array(this.starts.length * 2);
      s.set(this.starts);
      this.starts = s;
    }
    if (this.size >= this.counts.length) {
      const c = new Uint32Array(this.counts.length * 2);
      c.set(this.counts);
      this.counts = c;
    }
    SCRATCH.copy(this.bytes, this.used, 0, n);
    this.used += n;
    this.counts[this.size] = 1;
    this.size++;
    this.starts[this.size] = this.used;
    this.slots[slot] = this.size;
    return true;
  }

  /** drop the room left for more codes (after the scan, which adds nearly all of them) */
  trim() {
    if (this.bytes.length > this.used) {
      const b = Buffer.allocUnsafeSlow(Math.max(this.used, 1));
      this.bytes.copy(b, 0, 0, this.used);
      this.bytes = b;
    }
    this.starts = this.starts.slice(0, this.size + 1);
    this.counts = this.counts.slice(0, Math.max(this.size, 1));
  }

  #rehash() {
    const old = this.slots;
    this.slots = new Uint32Array(old.length * 2);
    const mask = this.slots.length - 1;
    for (let e = 1; e <= this.size; e++) {
      const a = this.starts[e - 1], b = this.starts[e];
      let h = 0x811c9dc5;
      for (let k = a; k < b; k++) {
        h = Math.imul(h ^ this.bytes[k], 0x01000193);
      }
      let s = h & mask;
      while (this.slots[s] !== 0) s = (s + 1) & mask;
      this.slots[s] = e;
    }
  }

  /** @returns {{count: number}|undefined} */
  get(code) {
    const e = this.#indexOf(code);
    return e ? { count: this.counts[e - 1] } : undefined;
  }

  has(code) {
    return this.#indexOf(code) > 0;
  }

  * [Symbol.iterator]() {
    for (let i = 0; i < this.size; i++) {
      yield [this.bytes.toString('utf8', this.starts[i], this.starts[i + 1]), { count: this.counts[i] }];
    }
  }
}

// the UTF-8 of the code looked up or added; grown for a long code
let SCRATCH = Buffer.allocUnsafeSlow(1024);

/** @returns {number} the UTF-8 length of code, written to SCRATCH, or -1 if it isn't a string */
function encode(code) {
  if (typeof code !== 'string') return -1;
  if (code.length * 3 > SCRATCH.length) {
    SCRATCH = Buffer.allocUnsafeSlow(code.length * 3);
  }
  return SCRATCH.write(code, 0, 'utf8');
}

const { setImmediate: yieldToEventLoop } = require('timers/promises');

// The startup scan reads every value set (thousands with the npm packages, VSAC), about a second
// of work: give requests a turn every YIELD_INTERVAL_MS of it.
const YIELD_INTERVAL_MS = 10;

class ConceptUsageTracker {

  // Defaults for usageTrackerMaxCodes and usageTrackerMaxCodeLength: most codes
  // tracked, 2x the about 500,000 codes the value sets of a full library list, and
  // the longest code, 2.5x the longest of those (40 characters). Codes beyond either
  // limit aren't tracked, so validating made-up codes can't grow the map forever.
  static MAX_CODES = 1000000;
  static MAX_CODE_LENGTH = 100;

  /**
   * @param {number} [maxCodes] - most codes tracked; Infinity = no limit
   * @param {number} [maxCodeLength] - longest code tracked; Infinity = no limit
   */
  constructor(maxCodes = ConceptUsageTracker.MAX_CODES, maxCodeLength = ConceptUsageTracker.MAX_CODE_LENGTH) {
    this.map = new Map();   // system -> CodeUsages
    this.codes = 0;
    this.maxCodes = maxCodes;
    this.maxCodeLength = maxCodeLength;
  }

  async scanValueSets(library) {
    let c = 0;
    let sliceStart = Date.now();
    for (let vsp of library.valueSetProviders) {
      if (vsp.scanUsage) {
        // a provider that can read its codes without building every value set (sqlite-v2 content)
        c += await vsp.scanUsage(this);
        continue;
      }
      await vsp.scanAllValueSets(async (vs) => {
        // in the callback, so it yields however the provider reads its value sets
        if (Date.now() - sliceStart >= YIELD_INTERVAL_MS) {
          await yieldToEventLoop();
          sliceStart = Date.now();
        }
        if (vs.jsonObj.compose) {
          if (await this.scanValueSet(vs.jsonObj.compose)) {
            c++;
          }
        }
      });
    }
    for (const cs of this.map.values()) {
      cs.trim();
    }
    return c;
  }

  async scanValueSet(compose, versions, active) {
    let ok = false;
    for (let inc of compose.include || []) {
      if (inc.system) {
        if (active && inc.version) {
          this.seeVersion(versions, inc.system, inc.version);
        }
        for (let c of inc.concept || []) {
          if (c.code) {
            ok = true;
            this.seeConcept(inc.system, c.code);
          }
        }
      }
    }
    return ok;
  }

  seeConcept(system, code) {
    let cs = this.map.get(system);
    if (cs && cs.see(code)) {
      return;
    }
    if (this.codes >= this.maxCodes || code.length > this.maxCodeLength) {
      return;
    }
    if (!cs) {
      cs = new CodeUsages();
      this.map.set(system, cs);
    }
    if (cs.add(code)) {
      this.codes++;
    }
  }

  /**
   * @returns {CodeUsages|null} the codes of system seen: get(code) -> {count} | undefined, has(code)
   */
  usages(system) {
    return this.map.get(system) || null;
  }

  seeVersion(versions, system, version) {
    let set = versions[system];
    if (set == null) {
      set = new Set();
      versions[system] = set;
    }
    set.add(version);
  }
}

module.exports = ConceptUsageTracker;
