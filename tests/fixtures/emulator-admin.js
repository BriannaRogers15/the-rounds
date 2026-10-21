// Thin REST wrappers around the Firebase Emulator Suite's admin endpoints.
// Node 24's built-in fetch is used directly — no extra HTTP dependency.
const PROJECT_ID = 'the-rounds-fc02a';

// The emulator answers 409 ABORTED ("Transaction lock timeout") when the
// clear overlaps a commit still finishing — a transient status by
// definition — so retry briefly rather than fail the whole file.
async function clearFirestore() {
  const url = `http://127.0.0.1:8080/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, { method: 'DELETE' });
    if (res.ok) return;
    const body = await res.text();
    if (res.status !== 409 || attempt >= 5) throw new Error(`clearFirestore failed: ${res.status} ${body}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

async function clearAuthUsers() {
  const url = `http://127.0.0.1:9099/emulator/v1/projects/${PROJECT_ID}/accounts`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`clearAuthUsers failed: ${res.status} ${await res.text()}`);
}

// Fresh Auth + Firestore emulators (empty data, no leftover connection
// state) via the control endpoint global-setup.js serves — see there for why.
async function restartEmulators() {
  const res = await fetch('http://127.0.0.1:9299/restart', { method: 'POST' });
  if (!res.ok) throw new Error(`restartEmulators failed: ${res.status} ${await res.text()}`);
}

module.exports = { PROJECT_ID, clearFirestore, clearAuthUsers, restartEmulators };
