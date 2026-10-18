const { test } = require('@playwright/test');
const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { createRulesEnv, dbs, seed, OWNER_UID } = require('./rules-env');

// firestore.rules: visits/{id}
//   read:           anyone (guest browsing shows reviews)
//   create:         signed in AND authorUid == your own uid
//   update/delete:  only the visit's author — the owner has NO override.
//                   That last part is easy to assume wrong (the owner can
//                   delete listings, so surely they can delete reviews?)
//                   — they can't, and these tests pin that down.
let testEnv;
const aliceVisit = { restaurantId: 'r1', authorUid: 'alice', reviewer: 'Alice', rating: 4, wouldReturn: true, ate: [], date: '2026-10-01' };

test.beforeAll(async () => { testEnv = await createRulesEnv(); });
test.afterAll(async () => { await testEnv.cleanup(); });
test.beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, 'visits/v-alice', aliceVisit);
});

test.describe('visits: read', () => {
  test('an unauthenticated visitor can read visits', async () => {
    await assertSucceeds(dbs(testEnv).guest.doc('visits/v-alice').get());
  });
});

test.describe('visits: create', () => {
  test('an unauthenticated visitor cannot log a visit', async () => {
    await assertFails(dbs(testEnv).guest.doc('visits/new').set({ ...aliceVisit, authorUid: 'alice' }));
  });

  test('a signed-in user can log a visit attributed to themselves', async () => {
    await assertSucceeds(dbs(testEnv).bob.doc('visits/new').set({ ...aliceVisit, authorUid: 'bob', reviewer: 'Bob' }));
  });

  test('a signed-in user cannot log a visit attributed to someone else', async () => {
    await assertFails(dbs(testEnv).bob.doc('visits/new').set({ ...aliceVisit, authorUid: 'alice' }));
  });

  test('a signed-in user cannot log a visit with no authorUid at all', async () => {
    const { authorUid, ...noAuthor } = aliceVisit;
    await assertFails(dbs(testEnv).bob.doc('visits/new').set(noAuthor));
  });

  test('the owner cannot log a visit attributed to someone else', async () => {
    await assertFails(dbs(testEnv).owner.doc('visits/new').set({ ...aliceVisit, authorUid: 'alice' }));
  });

  test('the owner can log a visit attributed to themselves', async () => {
    await assertSucceeds(dbs(testEnv).owner.doc('visits/new').set({ ...aliceVisit, authorUid: OWNER_UID }));
  });
});

test.describe('visits: update / delete', () => {
  test('the author can edit their own visit', async () => {
    await assertSucceeds(dbs(testEnv).alice.doc('visits/v-alice').update({ rating: 5 }));
  });

  test('the author can delete their own visit', async () => {
    await assertSucceeds(dbs(testEnv).alice.doc('visits/v-alice').delete());
  });

  test("another signed-in user cannot edit someone else's visit", async () => {
    await assertFails(dbs(testEnv).bob.doc('visits/v-alice').update({ rating: 1 }));
  });

  test("another signed-in user cannot delete someone else's visit", async () => {
    await assertFails(dbs(testEnv).bob.doc('visits/v-alice').delete());
  });

  test("the owner cannot edit someone else's visit (no owner override)", async () => {
    await assertFails(dbs(testEnv).owner.doc('visits/v-alice').update({ rating: 1 }));
  });

  test("the owner cannot delete someone else's visit (no owner override)", async () => {
    await assertFails(dbs(testEnv).owner.doc('visits/v-alice').delete());
  });

  test('an unauthenticated visitor cannot edit or delete a visit', async () => {
    await assertFails(dbs(testEnv).guest.doc('visits/v-alice').update({ rating: 1 }));
    await assertFails(dbs(testEnv).guest.doc('visits/v-alice').delete());
  });
});
