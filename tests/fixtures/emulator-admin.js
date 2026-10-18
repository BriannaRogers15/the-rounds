// Thin REST wrappers around the Firebase Emulator Suite's admin endpoints.
// Node 24's built-in fetch is used directly — no extra HTTP dependency.
const PROJECT_ID = 'the-rounds-fc02a';

async function clearFirestore() {
  const url = `http://127.0.0.1:8080/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`clearFirestore failed: ${res.status} ${await res.text()}`);
}

async function clearAuthUsers() {
  const url = `http://127.0.0.1:9099/emulator/v1/projects/${PROJECT_ID}/accounts`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`clearAuthUsers failed: ${res.status} ${await res.text()}`);
}

module.exports = { PROJECT_ID, clearFirestore, clearAuthUsers };
