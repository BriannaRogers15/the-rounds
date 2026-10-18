const { test } = require('@playwright/test');
const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { createRulesEnv, dbs, seed, OWNER_UID } = require('./rules-env');

// firestore.rules: users/{userId} — read and write only your own doc.
// There is no owner override here; the owner is just another user.
let testEnv;
test.beforeAll(async () => { testEnv = await createRulesEnv(); });
test.afterAll(async () => { await testEnv.cleanup(); });
test.beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, 'users/alice', { displayName: 'Alice', email: 'alice@example.test' });
  await seed(testEnv, 'users/bob', { displayName: 'Bob', email: 'bob@example.test' });
});

test.describe('users/{userId}', () => {
  test('an unauthenticated visitor cannot read any user doc', async () => {
    await assertFails(dbs(testEnv).guest.doc('users/alice').get());
  });

  test('an unauthenticated visitor cannot write any user doc', async () => {
    await assertFails(dbs(testEnv).guest.doc('users/alice').set({ displayName: 'x' }));
  });

  test('a user can read their own doc', async () => {
    await assertSucceeds(dbs(testEnv).alice.doc('users/alice').get());
  });

  test('a user can write their own doc', async () => {
    await assertSucceeds(dbs(testEnv).alice.doc('users/alice').set({ displayName: 'Alice 2' }, { merge: true }));
  });

  test("a user cannot read someone else's doc (no email/name exposure)", async () => {
    await assertFails(dbs(testEnv).alice.doc('users/bob').get());
  });

  test("a user cannot write someone else's doc", async () => {
    await assertFails(dbs(testEnv).alice.doc('users/bob').set({ displayName: 'hijacked' }));
  });

  test("the owner has no override: cannot read another user's doc", async () => {
    await assertFails(dbs(testEnv).owner.doc('users/alice').get());
  });

  test('the owner can still read and write their own doc', async () => {
    await assertSucceeds(dbs(testEnv).owner.doc(`users/${OWNER_UID}`).set({ displayName: 'Owner' }));
    await assertSucceeds(dbs(testEnv).owner.doc(`users/${OWNER_UID}`).get());
  });
});
