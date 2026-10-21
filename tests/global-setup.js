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

let emulator = null;

async function startEmulators() {
  // detached: its own process group, so stopEmulators can signal the
  // firebase CLI *and* the Java emulator it spawns, not just npx.
  emulator = spawn(
    'npx',
    ['firebase', 'emulators:start', '--only', 'auth,firestore', '--project', 'the-rounds-fc02a'],
    { cwd: __dirname + '/..', stdio: ['ignore', 'pipe', 'pipe'], detached: true }
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
