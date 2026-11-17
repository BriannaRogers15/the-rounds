const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { seedDoc } = require('./firestore-seed');
const { PROJECT_ID } = require('./emulator-admin');

// Extracted from firestore.rules rather than re-typed, so this can never
// silently drift from the real constant if it's ever rotated.
function getOwnerUid() {
  const rules = fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8');
  const match = rules.match(/uid\s*==\s*'([^']+)'/);
  if (!match) throw new Error('Could not find OWNER_UID in firestore.rules');
  return match[1];
}

let counter = 0;
function randomTestEmail(prefix = 'test') {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.test`;
}

// Firebase Auth Emulator-only feature: accounts:batchCreate accepts a
// plaintext rawPassword and an explicit localId, neither of which the real
// Identity Toolkit API allows — this is how a test gets a session whose uid
// is literally OWNER_UID without adding any production-code seam for it.
// The real app's isOwner()/firestore.rules both just work, unmodified.
// "Authorization: Bearer owner" is a Firebase Auth Emulator-only convention
// that grants admin-level access for exactly this kind of call (setting an
// explicit localId, bypassing normal auth) — documented emulator behavior,
// not a real credential.
const ADMIN_HEADERS = { 'Content-Type': 'application/json', Authorization: 'Bearer owner' };

// accounts:batchCreate always requires an explicit localId per user (it
// does not auto-generate one for you), and — critically — reports a
// per-item failure as an `error` array inside an HTTP 200 response rather
// than a non-2xx status, so res.ok alone does not mean the account was
// actually created. Both must be handled, or a "created" user silently
// doesn't exist and the next sign-in attempt fails with user-not-found.
// `ignoreIfExists` makes this idempotent for the one fixed-uid account
// (OWNER_UID can't be randomized, so concurrent workers/tests all target
// the same localId — accounts:update can't upsert, it 400s on a
// not-yet-existing account, so "create, tolerate already-exists" is the
// only race-safe option here).
async function batchCreateUser(user, { ignoreIfExists = false } = {}) {
  const url = `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:batchCreate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ users: [user] }),
  });
  const body = await res.json();
  const alreadyExists = body.error?.[0]?.message?.includes('existing account');
  if (ignoreIfExists && alreadyExists) return;
  if (!res.ok || body.error?.length) {
    throw new Error(`batchCreate failed for ${user.localId}: ${res.status} ${JSON.stringify(body)}`);
  }
}

// Firebase Auth Emulator-only feature: accounts:batchCreate accepts a
// plaintext rawPassword and an explicit localId, neither of which the real
// Identity Toolkit API allows — this is how a test gets a session whose uid
// is literally OWNER_UID without adding any production-code seam for it.
// The real app's isOwner()/firestore.rules both just work, unmodified.
// "Authorization: Bearer owner" is a Firebase Auth Emulator-only convention
// that grants admin-level access for exactly this kind of call (setting an
// explicit localId, bypassing normal auth) — documented emulator behavior,
// not a real credential.
// Fixed, not randomized: OWNER_UID is a single constant, so every test/
// worker that needs an owner session is really asking for the *same*
// account. Deterministic credentials + ignoreIfExists make concurrent
// callers converge on one shared owner account instead of racing to create
// distinct ones under the same uid.
const OWNER_TEST_EMAIL = 'owner-test@example.test';
const OWNER_TEST_PASSWORD = 'owner-testpass-123';

// Every account picks a username before it can use the app. Test accounts
// get theirs arranged server-side (profile + reservation + private record),
// exactly the shape the app's sign-up writes, so they go straight in.
// `username: null` leaves it unset, to exercise the "Pick your username" step.
async function giveUsername(uid, username, { displayName = username, signInMethod = 'password' } = {}) {
  await seedDoc(`profiles/${uid}`, { username });
  await seedDoc(`usernames/${username.toLowerCase()}`, { uid, username });
  await seedDoc(`users/${uid}`, { displayName, signInMethod });
}
const OWNER_TEST_USERNAME = 'owner_test';

async function createOwnerTestUser() {
  const uid = getOwnerUid();
  await batchCreateUser(
    { localId: uid, email: OWNER_TEST_EMAIL, rawPassword: OWNER_TEST_PASSWORD, emailVerified: true, displayName: OWNER_TEST_USERNAME },
    { ignoreIfExists: true }
  );
  await giveUsername(uid, OWNER_TEST_USERNAME);
  return { uid, email: OWNER_TEST_EMAIL, password: OWNER_TEST_PASSWORD, username: OWNER_TEST_USERNAME };
}

let usernameCounter = 0;
function randomUsername(prefix = 'user') {
  usernameCounter += 1;
  return `${prefix}_${Date.now().toString(36).slice(-5)}${usernameCounter}`.slice(0, 20);
}

async function createRegularTestUser({ email = randomTestEmail('user'), password = 'testpass123', username = randomUsername(), displayName } = {}) {
  const uid = crypto.randomUUID();
  await batchCreateUser({ localId: uid, email, rawPassword: password, emailVerified: true, ...(displayName || username ? { displayName: displayName || username } : {}) });
  if (username) await giveUsername(uid, username, { displayName: displayName || username });
  return { uid, email, password, username, displayName: displayName || username };
}

module.exports = { getOwnerUid, randomTestEmail, randomUsername, createOwnerTestUser, createRegularTestUser, giveUsername, OWNER_TEST_USERNAME };
