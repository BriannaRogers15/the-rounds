// Node-side Firestore writes that bypass the security rules — for arranging
// data a test's own browser session isn't allowed to write (e.g. a visit by
// a *different* author, to prove the UI won't let you delete it). Writing
// those from the page instead would trigger a real rules rejection, which
// was shown in Phase 2 to leave the emulator degraded for later tests.
// Open pages see these docs through their live onSnapshot listeners.
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { PROJECT_ID } = require('./emulator-admin');

let envPromise = null;
function env() {
  // No `rules` passed: this must not overwrite the rules the emulator has
  // loaded from firestore.rules.
  envPromise ||= initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: '127.0.0.1', port: 8080 },
  });
  return envPromise;
}

async function seedDoc(docPath, data) {
  const testEnv = await env();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(docPath).set(data);
  });
}

async function deleteDoc(docPath) {
  const testEnv = await env();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(docPath).delete();
  });
}

async function getDoc(docPath) {
  const testEnv = await env();
  let data = null;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().doc(docPath).get();
    data = snap.exists ? snap.data() : null;
  });
  return data;
}

module.exports = { seedDoc, deleteDoc, getDoc };
