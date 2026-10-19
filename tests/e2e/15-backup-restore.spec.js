const fs = require('fs');
const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');
const { getOwnerUid } = require('../fixtures/auth-helpers');
const { getDoc } = require('../fixtures/firestore-seed');
const { clearFirestore } = require('../fixtures/emulator-admin');

// Restore replaces the shared ledger wholesale (owner only), so each test
// starts from an empty Firestore — otherwise the restore would try to
// delete visits other tests' users authored, which the rules forbid.
test.beforeEach(async () => { await clearFirestore(); });
test.afterAll(async () => { await clearFirestore(); });

function backupFile(payload) {
  return { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)) };
}

test.describe('Export backup', () => {
  test('downloads the whole ledger as a the-rounds JSON file', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('#backToAreas');
      const [download] = await Promise.all([
        listingsPage.waitForEvent('download'),
        listingsPage.click('#exportBtn'),
      ]);
      expect(download.suggestedFilename()).toMatch(/^the-rounds-backup-\d{4}-\d{2}-\d{2}\.json$/);
      const payload = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      expect(payload).toMatchObject({ app: 'the-rounds', version: 1 });
      expect(payload.restaurants.map((r) => r.id)).toEqual(expect.arrayContaining(probes.map((r) => r.id)));
      expect(Array.isArray(payload.visits)).toBe(true);
      expect(Array.isArray(payload.profiles)).toBe(true);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});

test.describe('Restore backup (owner)', () => {
  const backup = () => ({
    app: 'the-rounds',
    version: 1,
    exportedAt: '2026-10-01T00:00:00.000Z',
    restaurants: [{ id: 'restored-1', name: 'Restored Spot', categories: ['American'], address: '9 Restore St, Chicago, IL 60607', createdAt: 1 }],
    visits: [{ id: 'restored-v1', restaurantId: 'restored-1', authorUid: getOwnerUid(), reviewer: 'Restorer', rating: 5, wouldReturn: true, ate: [], notes: '', date: '2026-09-01', createdAt: 1 }],
    profiles: [{ id: 'p-restored', name: 'Restorer' }],
    activeProfileId: 'p-restored',
  });

  test('confirming replaces the ledger, locally and in Firestore', async ({ ownerPage }) => {
    await injectRestaurants(ownerPage, [{ id: 'pre-existing', name: 'Pre-existing', categories: ['American'], address: 'Chicago, IL', createdAt: 1 }]);
    ownerPage.once('dialog', (d) => d.accept());
    await ownerPage.setInputFiles('#importFile', backupFile(backup()));

    await expect.poll(() => ownerPage.evaluate(() => restaurants.map((r) => r.id))).toEqual(['restored-1']);
    expect(await ownerPage.evaluate(() => visits.map((v) => v.id))).toEqual(['restored-v1']);
    expect(await ownerPage.evaluate(() => profiles.map((p) => p.name))).toEqual(['Restorer']);
    // Backups predating area fields still get them (written as a follow-up
    // save, so it lands after the restore's own snapshot round-trip).
    await expect.poll(() => ownerPage.evaluate(() => restaurants[0]?.town)).toBe('Chicago');
    await expect.poll(async () => (await getDoc('restaurants/restored-1'))?.town).toBe('Chicago');

    await expect.poll(() => getDoc('restaurants/restored-1')).toMatchObject({ name: 'Restored Spot' });
    await expect.poll(() => getDoc('visits/restored-v1')).toMatchObject({ rating: 5 });
    await expect.poll(() => getDoc('restaurants/pre-existing')).toBeNull();
  });

  test('cancelling the confirmation changes nothing', async ({ ownerPage }) => {
    await injectRestaurants(ownerPage, [{ id: 'keep-me', name: 'Keep Me', categories: ['American'], address: 'Chicago, IL', createdAt: 1 }]);
    const dialogs = [];
    ownerPage.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await ownerPage.setInputFiles('#importFile', backupFile(backup()));
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('1 listings, 1 visits, 1 reviewer');
    expect(await ownerPage.evaluate(() => restaurants.map((r) => r.id))).toContain('keep-me');
    expect(await getDoc('restaurants/restored-1')).toBeNull();
  });

  test('a file that isn\'t JSON is rejected', async ({ ownerPage }) => {
    const dialogs = [];
    ownerPage.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
    await ownerPage.setInputFiles('#importFile', backupFile('not json {'));
    await expect.poll(() => dialogs.at(-1)).toContain("isn't readable as a backup");
  });

  test('JSON that isn\'t a The Rounds backup is rejected', async ({ ownerPage }) => {
    const dialogs = [];
    ownerPage.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
    await ownerPage.setInputFiles('#importFile', backupFile({ app: 'something-else', restaurants: [], visits: [] }));
    await expect.poll(() => dialogs.at(-1)).toContain("doesn't look like a The Rounds backup");
  });
});
