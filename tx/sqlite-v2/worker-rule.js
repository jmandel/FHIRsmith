// The sqlite-v2 engine's rule for the launcher's default number of workers (cluster.md, "How
// many workers"): min(physicalCores − 1, round(0.6 × vCPU) + 1).
//
// A v2 process uses about 1.0-1.2 cores under load (synchronous SQLite, little in the libuv
// pool), against classic's 1.4-1.9, so one more worker pays where classic is flat. But past the
// physical cores less one it is a cliff, not a plateau: on 8 cores, 7 workers gave 405 timeouts
// in a surge where 6 gave the best goodput; on 4 cores SMT, 6 workers left a cheap probe
// waiting up to 26 s.

const { registerWorkerRule } = require('../../library/worker-count');

function v2Rule({ cores, vcpu }) {
  return { workers: Math.min(cores - 1, Math.round(0.6 * vcpu) + 1), formula: `min(${cores}−1, round(0.6×${vcpu})+1)` };
}

registerWorkerRule('v2', v2Rule, true);

module.exports = { v2Rule };
