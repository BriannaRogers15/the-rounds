const { test } = require('@playwright/test');
const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { createRulesEnv, dbs, seed, OWNER_UID } = require('./rules-env');

// firestore.rules: visits/{id}
//   read:           anyone (guest browsing shows reviews)
//   create:         signed in AND authorUid == your own uid
//                   AND the visit has a valid shape (fields, types, sizes,
//                   and its listing must exist) — every visitor's page
//                   renders every visit, so one malformed doc would break
//                   the listings for everyone
//   update:         only the visit's author — the owner has NO edit override
//   delete:         the author, or the owner (deleting a listing takes its
//                   visits with it; also how spam gets removed)
let testEnv;
const aliceVisit = { restaurantId: 'r1', authorUid: 'alice', reviewer: 'Alice', rating: 4, wouldReturn: true, ate: [], date: '2026-10-01' };

test.beforeAll(async () => { testEnv = await createRulesEnv(); });
test.afterAll(async () => { await testEnv.cleanup(); });
test.beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, 'restaurants/r1', { name: 'Probe Pizza Place', categories: ['Pizza'] });
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

test.describe('visits: create — shape validation', () => {
  const bob = (extra) => dbs(testEnv).bob.doc('visits/new').set({ ...aliceVisit, authorUid: 'bob', ...extra });
  const bobWithout = (field) => {
    const v = { ...aliceVisit, authorUid: 'bob' };
    delete v[field];
    return dbs(testEnv).bob.doc('visits/new').set(v);
  };

  test('the full shape Log a Visit writes is accepted', async () => {
    await assertSucceeds(bob({ id: 'new', notes: 'Great crust.', createdAt: Date.now(), ate: ['Cheese Slice'] }));
  });

  test('a legacy free-typed `ate` string is accepted', async () => {
    await assertSucceeds(bob({ ate: 'cheese slice' }));
  });

  for (const field of ['date', 'rating', 'wouldReturn', 'restaurantId']) {
    test(`a visit missing \`${field}\` is rejected`, async () => {
      await assertFails(bobWithout(field));
    });
  }

  test('a malformed date is rejected', async () => {
    await assertFails(bob({ date: 'yesterday' }));
  });

  test('a rating outside 1–5, or not a whole number, is rejected', async () => {
    await assertFails(bob({ rating: 0 }));
    await assertFails(bob({ rating: 6 }));
    await assertFails(bob({ rating: '5' }));
    await assertFails(bob({ rating: 4.5 }));
  });

  test('wouldReturn must be true/false', async () => {
    await assertFails(bob({ wouldReturn: 'yes' }));
  });

  test('a visit for a listing that does not exist is rejected', async () => {
    await assertFails(bob({ restaurantId: 'no-such-listing' }));
  });

  test('extra unknown fields are rejected', async () => {
    await assertFails(bob({ isAdmin: true }));
  });

  test('oversized notes / reviewer name / dish list are rejected', async () => {
    await assertFails(bob({ notes: 'x'.repeat(2001) }));
    await assertFails(bob({ reviewer: 'x'.repeat(81) }));
    await assertFails(bob({ ate: Array.from({ length: 101 }, (_, i) => `dish ${i}`) }));
  });

  test('an `id` field must match the document id', async () => {
    await assertFails(bob({ id: 'something-else' }));
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

  test("the owner can delete someone else's visit (listing deletes, spam removal)", async () => {
    await assertSucceeds(dbs(testEnv).owner.doc('visits/v-alice').delete());
  });

  test('the author cannot edit their visit into an invalid shape', async () => {
    await assertFails(dbs(testEnv).alice.doc('visits/v-alice').update({ rating: 9 }));
  });

  test('the author cannot hand their visit to someone else', async () => {
    await assertFails(dbs(testEnv).alice.doc('visits/v-alice').update({ authorUid: 'bob' }));
  });

  test('an unauthenticated visitor cannot edit or delete a visit', async () => {
    await assertFails(dbs(testEnv).guest.doc('visits/v-alice').update({ rating: 1 }));
    await assertFails(dbs(testEnv).guest.doc('visits/v-alice').delete());
  });
});
