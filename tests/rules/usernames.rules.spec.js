const { test } = require('@playwright/test');
const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { createRulesEnv, dbs, seed } = require('./rules-env');
const firebase = require('firebase/compat/app').default;
require('firebase/compat/firestore');
const { FieldValue, Timestamp } = firebase.firestore;
const DAY = 24 * 60 * 60 * 1000;

// firestore.rules: usernames/{lowercased} + profiles/{uid}
//   A username is reserved by creating usernames/{lowercased}; it can't be
//   created twice, and a profile may only name a reservation its own
//   account holds. Profiles (just the username) are public; users/{uid}
//   (private display name, email) is readable only by its account.
let testEnv;
test.beforeAll(async () => { testEnv = await createRulesEnv(); });
test.afterAll(async () => { await testEnv.cleanup(); });
test.beforeEach(async () => { await testEnv.clearFirestore(); });

async function claim(db, uid, username, releaseOld, extra = {}) {
  const batch = db.batch();
  batch.set(db.doc(`profiles/${uid}`), { username, ...extra });
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
    batch.set(db.doc('profiles/bob'), { username: 'bobby_b' });
    batch.set(db.doc('usernames/bobby_b'), { uid: 'alice', username: 'bobby_b' });
    await assertFails(batch.commit());
  });

  test('changing your username frees the old one; nobody else can release yours', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'Alice_C');
    await assertFails(dbs(testEnv).bob.doc('usernames/alice_c').delete());
    await assertSucceeds(claim(dbs(testEnv).alice, 'alice', 'alice_new', 'Alice_C', { usernameChangedAt: FieldValue.serverTimestamp() }));
    await assertSucceeds(claim(dbs(testEnv).bob, 'bob', 'Alice_C')); // free again
  });

  // An account whose last username change was `daysAgo` days ago.
  async function changedDaysAgo(daysAgo) {
    await seed(testEnv, 'profiles/alice', { username: 'Alice_C', usernameChangedAt: Timestamp.fromMillis(Date.now() - daysAgo * DAY) });
    await seed(testEnv, 'usernames/alice_c', { uid: 'alice', username: 'Alice_C' });
  }

  test('the first change is free, and must record the server time', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'Alice_C');
    await assertFails(claim(dbs(testEnv).alice, 'alice', 'alice_new', 'Alice_C')); // no time recorded
    await assertFails(claim(dbs(testEnv).alice, 'alice', 'alice_new', 'Alice_C', { usernameChangedAt: Timestamp.fromMillis(Date.now() - 200 * DAY) })); // a made-up time
    await assertSucceeds(claim(dbs(testEnv).alice, 'alice', 'alice_new', 'Alice_C', { usernameChangedAt: FieldValue.serverTimestamp() }));
  });

  test('after a change, the next one waits 90 days', async () => {
    await changedDaysAgo(89);
    await assertFails(claim(dbs(testEnv).alice, 'alice', 'alice_new', 'Alice_C', { usernameChangedAt: FieldValue.serverTimestamp() }));
    await changedDaysAgo(91);
    await assertSucceeds(claim(dbs(testEnv).alice, 'alice', 'alice_new', 'Alice_C', { usernameChangedAt: FieldValue.serverTimestamp() }));
  });

  test('the change time can\'t be cleared or moved back to get around the wait', async () => {
    await changedDaysAgo(10);
    await assertFails(claim(dbs(testEnv).alice, 'alice', 'alice_new', 'Alice_C')); // cleared
    await assertFails(claim(dbs(testEnv).alice, 'alice', 'Alice_C', null, { usernameChangedAt: Timestamp.fromMillis(Date.now() - 200 * DAY) })); // moved back
  });

  test('a capitalization change is allowed during the wait, and keeps the change time', async () => {
    await changedDaysAgo(10);
    const stamp = (await dbs(testEnv).alice.doc('profiles/alice').get()).data().usernameChangedAt;
    await assertSucceeds(claim(dbs(testEnv).alice, 'alice', 'ALICE_C', null, { usernameChangedAt: stamp }));
    await assertFails(claim(dbs(testEnv).alice, 'alice', 'alice_c', null, { usernameChangedAt: FieldValue.serverTimestamp() })); // a fresh time isn't allowed either
  });

  test('you cannot release your current username without moving off it', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'Alice_C');
    await assertFails(dbs(testEnv).alice.doc('usernames/alice_c').delete());
  });

  test('a change of capitalization alone is allowed', async () => {
    await claim(dbs(testEnv).alice, 'alice', 'alice_c');
    await assertSucceeds(claim(dbs(testEnv).alice, 'alice', 'Alice_C'));
  });

  test('bad usernames are refused: spaces, too short/long, misplaced dots, blocked words', async () => {
    for (const name of ['has space', 'ab', 'briski', 'x'.repeat(21), '.leading_dot', 'trailing.', 'two..dots', 'big_fuck_x', 'NaziFanz']) {
      await assertFails(claim(dbs(testEnv).alice, 'alice', name));
    }
  });

  test('good usernames: 7 and 20 characters, dots in the middle', async () => {
    await assertSucceeds(claim(dbs(testEnv).alice, 'alice', 'abc_def'));
    await assertSucceeds(claim(dbs(testEnv).bob, 'bob', 'taco.tuesday_x.' + 'y'.repeat(5)));
  });

  test('profiles hold only a username (and when it last changed), and only your own', async () => {
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
