const { test } = require('@playwright/test');
const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { createRulesEnv, dbs, seed } = require('./rules-env');

// firestore.rules: restaurants/{id}
//   read:           anyone, signed in or not (guest browsing)
//   create/delete:  owner only
//   update:         owner (any field), OR any signed-in user if the write
//                   changes *only* the `menu` field (the "something I ate
//                   that isn't listed" path from Log a Visit) — and that
//                   menu write may only append, as a list of sane size
let testEnv;
const existing = { name: 'Probe Pizza Place', categories: ['Pizza'], address: 'Chicago, IL', menu: ['Cheese Slice'] };

test.beforeAll(async () => { testEnv = await createRulesEnv(); });
test.afterAll(async () => { await testEnv.cleanup(); });
test.beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, 'restaurants/r1', existing);
});

test.describe('restaurants: read', () => {
  test('an unauthenticated visitor can read a listing', async () => {
    await assertSucceeds(dbs(testEnv).guest.doc('restaurants/r1').get());
  });

  test('a signed-in non-owner can read a listing', async () => {
    await assertSucceeds(dbs(testEnv).alice.doc('restaurants/r1').get());
  });
});

test.describe('restaurants: create', () => {
  const fresh = { name: 'New Spot', categories: ['American'], address: 'Chicago, IL' };

  test('an unauthenticated visitor cannot create a listing', async () => {
    await assertFails(dbs(testEnv).guest.doc('restaurants/new').set(fresh));
  });

  test('a signed-in non-owner cannot create a listing', async () => {
    await assertFails(dbs(testEnv).alice.doc('restaurants/new').set(fresh));
  });

  test('the owner can create a listing', async () => {
    await assertSucceeds(dbs(testEnv).owner.doc('restaurants/new').set(fresh));
  });
});

test.describe('restaurants: update', () => {
  test('a non-owner can add a dish (update touching only `menu`)', async () => {
    await assertSucceeds(dbs(testEnv).alice.doc('restaurants/r1').update({ menu: ['Cheese Slice', 'Garlic Knots'] }));
  });

  test('a non-owner can add a dish to a listing that had no menu yet', async () => {
    await seed(testEnv, 'restaurants/r2', { name: 'No Menu Yet', categories: ['American'] });
    await assertSucceeds(dbs(testEnv).alice.doc('restaurants/r2').update({ menu: ['Burger'] }));
  });

  test('a non-owner cannot remove dishes from the menu', async () => {
    await assertFails(dbs(testEnv).alice.doc('restaurants/r1').update({ menu: [] }));
  });

  test('a non-owner cannot replace the menu with something that is not a list', async () => {
    await assertFails(dbs(testEnv).alice.doc('restaurants/r1').update({ menu: 'gotcha' }));
  });

  test('a non-owner cannot grow the menu past the size cap', async () => {
    await assertFails(dbs(testEnv).alice.doc('restaurants/r1').update({ menu: Array.from({ length: 1001 }, (_, i) => `dish ${i}`) }));
  });

  test('a non-owner cannot change the name', async () => {
    await assertFails(dbs(testEnv).alice.doc('restaurants/r1').update({ name: 'Renamed' }));
  });

  test('a non-owner cannot change categories', async () => {
    await assertFails(dbs(testEnv).alice.doc('restaurants/r1').update({ categories: ['Pizza', 'Chicago Gems'] }));
  });

  test('a non-owner cannot sneak a non-menu field in alongside a menu change', async () => {
    await assertFails(dbs(testEnv).alice.doc('restaurants/r1').update({ menu: ['Cheese Slice', 'X'], name: 'Renamed' }));
  });

  test('an unauthenticated visitor cannot update even the menu', async () => {
    await assertFails(dbs(testEnv).guest.doc('restaurants/r1').update({ menu: ['Cheese Slice', 'X'] }));
  });

  test('the owner can update any field', async () => {
    await assertSucceeds(dbs(testEnv).owner.doc('restaurants/r1').update({ name: 'Renamed', categories: ['Italian'] }));
  });
});

test.describe('restaurants: delete', () => {
  test('an unauthenticated visitor cannot delete a listing', async () => {
    await assertFails(dbs(testEnv).guest.doc('restaurants/r1').delete());
  });

  test('a signed-in non-owner cannot delete a listing', async () => {
    await assertFails(dbs(testEnv).alice.doc('restaurants/r1').delete());
  });

  test('the owner can delete a listing', async () => {
    await assertSucceeds(dbs(testEnv).owner.doc('restaurants/r1').delete());
  });
});
