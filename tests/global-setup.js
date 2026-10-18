// Starts the Firebase Auth + Firestore Emulators for the whole Playwright
// run, so every test — including pure guest-mode ones — can get past the
// auth gate (auth-gate.js unconditionally waits for window.RoundsFirebase
// to exist, see tests/README.md) without depending on live internet/Google
// Firebase. Firestore joins as of Phase 2, for real sign-in/owner flows and
// the shared-ledger watcher resolving promptly instead of falling back to
// an empty offline-cache snapshot. Returning a teardown function from
// globalSetup is Playwright's supported pattern for this, avoiding a
// separate file + cross-process PID handoff.
const { spawn } = require('child_process');
const http = require('http');

function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host, port, path: '/', timeout: 1000 }, (res) => {
        res.destroy();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${host}:${port}`));
        else setTimeout(attempt, 300);
      });
      req.on('timeout', () => req.destroy());
    };
    attempt();
  });
}

module.exports = async function globalSetup() {
  const emulator = spawn(
    'npx',
    ['firebase', 'emulators:start', '--only', 'auth,firestore', '--project', 'the-rounds-fc02a'],
    { cwd: __dirname + '/..', stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let output = '';
  emulator.stdout.on('data', (d) => { output += d.toString(); });
  emulator.stderr.on('data', (d) => { output += d.toString(); });

  try {
    await Promise.all([
      waitForPort(9099, '127.0.0.1', 30000),
      waitForPort(8080, '127.0.0.1', 30000),
    ]);
  } catch (err) {
    emulator.kill();
    console.error('Firebase Emulators failed to start. Output:\n' + output);
    throw err;
  }

  return async function globalTeardown() {
    emulator.kill();
  };
};
