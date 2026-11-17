const { test } = require('@playwright/test');
const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { createRulesEnv, dbs, seed } = require('./rules-env');

// firestore.rules: usernames/{lowercased} + profiles/{uid}
//   A username is reserved by creating usernames/{lowercased}; it can't be
//   created twice, and a profile may only name a reservation its own
//   account holds. Profiles (just the username) are public; users/{uid}
//   (private display name, email) is readable only by its account.
let testEnv;
test.beforeAll(async () => { testEnv = await createRulesEnv(); });
test.afterAll(async () => { await testEnv.cleanup(); });
test.beforeEach(async () => { await testEnv.clearFirestore(); });

async function claim(db, uid, username, releaseOld) {
  const batch = db.batch();
  batch.set(db.doc(`profiles/${uid}`), { username });
  batch.set(db.doc(`usernames/${username.toLowerCase()}`), { uid, username });
  if (releaseOld) batch.delete(db.doc(`usernames/${releaseOld.toLowerCase()}`));
  return batch.commit();
}

test.describe('usernames', () => {
  test('a signed-in account can claim a free username (profile + reservation together)', async () => {
    await assertSucceeds(claim(dbs(testEnv).alice, 'alice', 'Alice_C'));
  });

  test('nobody can claim a username someone already has, in any capitalization', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'Alice_C');
    await assertFails(claim(dbs(testEnv).bob, 'bob', 'alice_c'));
    await assertFails(claim(dbs(testEnv).bob, 'bob', 'ALICE_C'));
  });

  test('a profile cannot point at someone else\'s reservation', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'Alice_C');
    await assertFails(dbs(testEnv).bob.doc('profiles/bob').set({ username: 'Alice_C' }));
  });

  test('a reservation must belong to its claimer and match its id', async () => {
    const db = dbs(testEnv).bob;
    const batch = db.batch();
    batch.set(db.doc('profiles/bob'), { username: 'bob_b' });
    batch.set(db.doc('usernames/bob_b'), { uid: 'alice', username: 'bob_b' });
    await assertFails(batch.commit());
  });

  test('changing your username frees the old one; nobody else can release yours', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'Alice_C');
    await assertFails(dbs(testEnv).bob.doc('usernames/alice_c').delete());
    await assertSucceeds(claim(dbs(testEnv).alice, 'alice', 'alice_new', 'Alice_C'));
    await assertSucceeds(claim(dbs(testEnv).bob, 'bob', 'Alice_C')); // free again
  });

  test('you cannot release your current username without moving off it', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'Alice_C');
    await assertFails(dbs(testEnv).alice.doc('usernames/alice_c').delete());
  });

  test('a change of capitalization alone is allowed', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'alice_c');
    await assertSucceeds(claim(dbs(testEnv).alice, 'alice', 'Alice_C'));
  });

  test('bad usernames are refused: spaces, too short/long, blocked words', async () => {
    for (const name of ['has space', 'ab', 'x'.repeat(21), 'big_fuck_x', 'NaziFan']) {
      await assertFails(claim(dbs(testEnv).alice, 'alice', name));
    }
  });

  test('profiles hold only a username, and only your own', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'Alice_C');
    await assertFails(dbs(testEnv).alice.doc('profiles/alice').set({ username: 'Alice_C', photoURL: 'x' }));
    await assertFails(dbs(testEnv).bob.doc('profiles/alice').set({ username: 'Alice_C' }));
  });

  test('anyone can read profiles and reservations (reviews show usernames)', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'Alice_C');
    await assertSucceeds(dbs(testEnv).guest.doc('profiles/alice').get());
    await assertSucceeds(dbs(testEnv).guest.doc('usernames/alice_c').get());
  });

  test('the private display name is readable only by its own account', async () => {
    await seed(testEnv, 'users/alice', { displayName: 'Alice Private', signInMethod: 'password' });
    await assertSucceeds(dbs(testEnv).alice.doc('users/alice').get());
    await assertFails(dbs(testEnv).bob.doc('users/alice').get());
    await assertFails(dbs(testEnv).guest.doc('users/alice').get());
  });
});
