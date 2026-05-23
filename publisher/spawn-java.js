// @ts-check

// Spawns the IG Publisher (java) with line-buffered stdout/stderr when possible.
//
// When Node spawns java with piped stdio, the JVM treats stdout as a block
// device and uses an ~8KB buffer. During long quiet phases of the IG Publisher
// (notably "Previous Version Comparison") that means progress lines sit in the
// buffer for many minutes, making it impossible to tell from the log whether
// the build is still alive.
//
// `stdbuf -oL -eL` (GNU coreutils) forces line-buffered I/O at the libc level,
// which avoids the stall. We detect stdbuf once at module load; if it's not
// available we fall back to spawning java directly.

const { spawn, spawnSync } = require('child_process');

/** @type {string | null} */
let stdbufPath = null;
let stdbufChecked = false;

/**
 * @returns {string | null}
 */
function detectStdbuf() {
  if (stdbufChecked) return stdbufPath;
  stdbufChecked = true;
  try {
    const result = spawnSync('stdbuf', ['--version'], { stdio: 'ignore' });
    if (result.status === 0) {
      stdbufPath = 'stdbuf';
    }
  } catch (_) {
    // stdbuf not on PATH — fall back to plain java
  }
  return stdbufPath;
}

/**
 * Spawn `java` with the given argv, forcing line-buffered output when stdbuf
 * is available. Signature mirrors child_process.spawn's (args, options).
 *
 * @param {string[]} javaArgs - arguments after the `java` command itself
 * @param {import('child_process').SpawnOptions} [options] - passed through to child_process.spawn
 * @returns {import('child_process').ChildProcess}
 */
function spawnJava(javaArgs, options = {}) {
  const stdbuf = detectStdbuf();
  if (stdbuf) {
    return spawn(stdbuf, ['-oL', '-eL', 'java', ...javaArgs], options);
  }
  return spawn('java', javaArgs, options);
}

/**
 * Returns true if line-buffering via stdbuf is active. Useful for one-shot
 * logging at startup so operators can tell whether to expect prompt output.
 * @returns {boolean}
 */
function isLineBuffered() {
  return detectStdbuf() !== null;
}

module.exports = { spawnJava, isLineBuffered };
