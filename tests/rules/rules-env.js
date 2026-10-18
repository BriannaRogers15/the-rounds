const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { getOwnerUid } = require('../fixtures/auth-helpers');
const { PROJECT_ID } = require('../fixtures/emulator-admin');

// Loads the real firestore.rules file into the running Firestore Emulator
// (started by tests/global-setup.js). Same project id as the e2e suite —
// the emulator runs in singleProjectMode — so specs clear data per test and
// workers: 1 keeps rules and e2e files from interleaving mid-file.
async function createRulesEnv() {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
}

// Compat-style Firestore handles for each identity the rules distinguish.
function dbs(testEnv) {
  return {
    guest: testEnv.unauthenticatedContext().firestore(),
    alice: testEnv.authenticatedContext('alice').firestore(),
    bob: testEnv.authenticatedContext('bob').firestore(),
    owner: testEnv.authenticatedContext(getOwnerUid()).firestore(),
  };
}

// Writes bypassing the rules, for arranging fixture data.
async function seed(testEnv, docPath, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(docPath).set(data);
  });
}

module.exports = { createRulesEnv, dbs, seed, OWNER_UID: getOwnerUid() };
