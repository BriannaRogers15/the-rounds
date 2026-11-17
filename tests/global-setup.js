// Starts the Firebase Auth + Firestore Emulators for the whole Playwright
// run, so every test — including pure guest-mode ones — can get past the
// auth gate (auth-gate.js unconditionally waits for window.RoundsFirebase
// to exist, see tests/README.md) without depending on live internet/Google
// Firebase. Returning a teardown function from globalSetup is Playwright's
// supported pattern for this, avoiding a separate file + cross-process PID
// handoff.
//
// It also serves a tiny control endpoint (POST /restart on CONTROL_PORT)
// that restarts the emulators. app-fixture.js calls it once at the start of
// every e2e spec file. Why: the Firestore emulator keeps per-connection
// server-side state from every browser session that has ever connected,
// even ones that unsubscribed and terminated cleanly. Measured directly:
// write latency grows with each closed session (≈210ms → ≈490ms over 15),
// so across a full ~140-test run the later files hit timeouts that have
// nothing to do with the app. Within one file it stays flat. A fresh
// emulator per file keeps every file starting from the same clean state.
// The emulator process stays owned by this (main runner) process, so
// worker crashes can never orphan a Java process.
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');

const CONTROL_PORT = 9299; // not 9150: that is the Firestore emulator's websocket port
const EMULATOR_PORTS = [9099, 8080];

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPorts(open, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = await Promise.all(EMULATOR_PORTS.map(portOpen));
    if (states.every((state) => state === open)) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for emulator ports ${EMULATOR_PORTS.join(', ')} to ${open ? 'open' : 'close'}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

// firebase-tools 15's emulators need Java 21 or newer. A machine can have
// several JDKs with an older one first on PATH, so pick a new-enough one
// explicitly: JAVA_HOME, then whatever is on PATH, then Homebrew's
// openjdk. The emulators get that JDK's bin directory first on their PATH.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const MIN_JAVA = 21;
function javaMajor(javaBin) {
  // `java -version` prints to stderr.
  const res = spawnSync(javaBin, ['-version'], { encoding: 'utf8' });
  return parseJavaVersion(`${res.stdout || ''}${res.stderr || ''}`);
}
function parseJavaVersion(text) {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return 0;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]); // "1.8" means Java 8
}
function findJavaBinDir() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin'));
  candidates.push(null); // whatever `java` is on PATH
  candidates.push('/opt/homebrew/opt/openjdk/bin', '/usr/local/opt/openjdk/bin');
  for (const dir of candidates) {
    const bin = dir ? path.join(dir, 'java') : 'java';
    if (dir && !fs.existsSync(bin)) continue;
    if (javaMajor(bin) >= MIN_JAVA) return dir; // null = PATH is already fine
  }
  throw new Error(`The Firebase emulators need Java ${MIN_JAVA}+. Install one (e.g. "brew install openjdk") or set JAVA_HOME to it.`);
}

let emulator = null;

let javaBinDir;
function emulatorEnv() {
  if (javaBinDir === undefined) javaBinDir = findJavaBinDir();
  if (!javaBinDir) return process.env;
  return { ...process.env, JAVA_HOME: path.dirname(javaBinDir), PATH: `${javaBinDir}${path.delimiter}${process.env.PATH}` };
}

async function startEmulators() {
  // detached: its own process group, so stopEmulators can signal the
  // firebase CLI *and* the Java emulator it spawns, not just npx.
  emulator = spawn(
    'npx',
    ['firebase', 'emulators:start', '--only', 'auth,firestore', '--project', 'the-rounds-fc02a'],
    { cwd: __dirname + '/..', stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: emulatorEnv() }
  );
  let output = '';
  emulator.stdout.on('data', (d) => { output += d.toString(); });
  emulator.stderr.on('data', (d) => { output += d.toString(); });
  try {
    await waitForPorts(true, 60000);
  } catch (err) {
    await stopEmulators();
    console.error('Firebase Emulators failed to start. Output:\n' + output);
    throw err;
  }
}

async function stopEmulators() {
  if (!emulator) return;
  const group = -emulator.pid;
  emulator = null;
  try { process.kill(group, 'SIGTERM'); } catch (_error) { /* already gone */ }
  try {
    await waitForPorts(false, 15000);
  } catch (_error) {
    try { process.kill(group, 'SIGKILL'); } catch (_e) { /* already gone */ }
    await waitForPorts(false, 5000);
  }
}

// Serialized so two overlapping requests can't interleave start/stop.
let restartChain = Promise.resolve();
function restartEmulators() {
  restartChain = restartChain.catch(() => {}).then(async () => {
    await stopEmulators();
    await startEmulators();
  });
  return restartChain;
}

module.exports = async function globalSetup() {
  if ((await Promise.all(EMULATOR_PORTS.map(portOpen))).some(Boolean)) {
    throw new Error(`Emulator port ${EMULATOR_PORTS.join('/')} already in use — stop any running "firebase emulators:start" first.`);
  }
  await startEmulators();

  const control = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/restart') {
      res.writeHead(404).end();
      return;
    }
    restartEmulators().then(
      () => res.writeHead(200).end('ok'),
      (err) => res.writeHead(500).end(String(err && err.stack || err)),
    );
  });
  try {
    await new Promise((resolve, reject) => {
      control.once('error', reject);
      control.listen(CONTROL_PORT, '127.0.0.1', resolve);
    });
  } catch (err) {
    await stopEmulators(); // don't leave them orphaned if setup fails here
    throw err;
  }

  return async function globalTeardown() {
    await new Promise((resolve) => control.close(resolve));
    await restartChain.catch(() => {});
    await stopEmulators();
  };
};

module.exports.CONTROL_PORT = CONTROL_PORT;
