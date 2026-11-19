const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, injectVisits, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

// Interactive dish-checklist behavior (log-a-visit) requires a signed-in
// write session and is covered in Phase 4 — this file covers the read-only
// listing-window menu, which any guest can see.

// A listing whose name matches a curated, sectioned MENU_LOOKUP entry. It
// stores no dishes of its own: the whole menu comes from the entry, under
// the real section headers. Built from the entry itself rather than
// hard-coded, so curation edits don't break the test.
async function curatedProbe(page, entryName) {
  return page.evaluate((entryName) => {
    const entry = MENU_LOOKUP.find((e) => e.name === entryName);
    const sections = Object.entries(entry.sections).map(([title, dishes]) => ({ title, dishes }));
    return {
      probe: {
        id: 'probe-curated-menu', name: entry.name, categories: ['Chinese'],
        address: '1 Probe St, Chicago, IL 60616', menu: [], createdAt: Date.now(),
      },
      sections,
      dishCount: new Set(Object.values(entry.sections).flat().map((d) => d.toLowerCase())).size,
      asOf: entry.asOf,
    };
  }, entryName);
}

test.describe('Menu system (read-only display)', () => {
  test('a listing with dishes but no curated sections renders one flat list, no section headers', async ({ listingsPage }) => {
    const probes = probeRestaurants(); // Probe Pizza Place has no MENU_LOOKUP entry
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.locator('.ticket[data-id="probe-pizza-1"]').click();
      const menu = listingsPage.locator('#menuChips');
      await expect(menu.locator('.menu-group')).toHaveCount(1);
      await expect(menu.locator('.menu-sec-head')).toHaveCount(0);
      await expect(menu.locator('.menu-row')).toHaveCount(2); // Cheese Slice, Pepperoni Pie
      // A menu that only grew from visits has no source date to show.
      await expect(listingsPage.locator('.menu-head .section-sub')).toHaveText('2 dishes');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('a listing with no dishes shows the "no dishes on file" message and no search box', async ({ listingsPage }) => {
    const probes = probeRestaurants(); // gem has menu: []
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.locator('.ticket[data-id="probe-gem-3"]').click();
      await expect(listingsPage.locator('#menuChips .no-menu')).toContainText('No dishes on file yet');
      await expect(listingsPage.locator('#menuChips .menu-group')).toHaveCount(0);
      await expect(listingsPage.locator('#menuSearch')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('sections open and close; Most Popular starts open; the rest sit behind "Show N more sections"', async ({ listingsPage }) => {
    const { probe, sections, dishCount, asOf } = await curatedProbe(listingsPage, 'Chi Cafe');
    expect(sections[0].title).toBe('Most Popular');
    expect(sections.length).toBeGreaterThan(9);
    await injectRestaurants(listingsPage, [probe]);
    try {
      await listingsPage.evaluate((id) => openDetail(id), probe.id);
      const menu = listingsPage.locator('#menuChips');
      // The source date shows, so a stale menu is visible at a glance.
      const shown = await listingsPage.evaluate((d) => fmtDate(d), asOf);
      await expect(listingsPage.locator('.menu-head .section-sub')).toHaveText(`${dishCount} dishes · checked ${shown}`);

      await expect(menu.locator('.menu-group')).toHaveCount(8);
      await expect(menu.locator('.menu-group.open')).toHaveCount(1);
      const popular = menu.locator('.menu-group[data-section="Most Popular"]');
      await expect(popular.locator('.menu-sec-head')).toHaveAttribute('aria-expanded', 'true');
      await expect(popular.locator('.menu-sec-count')).toHaveText(String(sections[0].dishes.length));
      await expect(popular.locator('.menu-row')).toHaveCount(sections[0].dishes.length);

      // Closed sections show their dish count, not their dishes.
      const second = menu.locator(`.menu-group[data-section="${sections[1].title}"]`);
      await expect(second.locator('.menu-sec-count')).toHaveText(String(sections[1].dishes.length));
      await expect(second.locator('.menu-row')).toHaveCount(0);
      await second.locator('.menu-sec-head').click();
      await expect(second.locator('.menu-row')).toHaveCount(sections[1].dishes.length);
      await expect(second.locator('.menu-sec-head')).toHaveAttribute('aria-expanded', 'true');
      await popular.locator('.menu-sec-head').click();
      await expect(popular.locator('.menu-row')).toHaveCount(0);

      const more = menu.locator('.menu-more');
      await expect(more).toHaveText(`Show ${sections.length - 8} more sections`);
      await more.click();
      await expect(menu.locator('.menu-group')).toHaveCount(sections.length);
      await expect(menu.locator('.menu-more')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [probe.id] });
    }
  });

  test('"Search this menu" finds dishes in every section, closed ones included', async ({ listingsPage }) => {
    const { probe, sections } = await curatedProbe(listingsPage, 'Chi Cafe');
    // A dish from a section that starts closed and hidden behind "Show more".
    const hidden = sections[sections.length - 1];
    const target = hidden.dishes[0];
    await injectRestaurants(listingsPage, [probe]);
    try {
      await listingsPage.evaluate((id) => openDetail(id), probe.id);
      const menu = listingsPage.locator('#menuChips');
      await listingsPage.fill('#menuSearch', target.toUpperCase());
      await expect(menu.locator('.dish-name', { hasText: target })).toBeVisible();
      await expect(menu.locator(`.menu-group[data-section="${hidden.title}"]`)).toBeVisible();
      await expect(menu.locator('.menu-more')).toHaveCount(0);

      await listingsPage.fill('#menuSearch', 'zzz-no-such-dish');
      await expect(menu.locator('.no-menu')).toHaveText('No dishes match “zzz-no-such-dish”.');

      // Clearing the search brings the sections back as they were.
      await listingsPage.fill('#menuSearch', '');
      await expect(menu.locator('.menu-group')).toHaveCount(8);
      await expect(menu.locator('.menu-group.open')).toHaveCount(1);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [probe.id] });
    }
  });

  test('"ordered N×" counts real logged visits only, once per visit', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    const base = { restaurantId: 'probe-pizza-1', rating: 4, wouldReturn: true, notes: '', reviewer: 'Probe', authorUid: 'probe-uid', createdAt: Date.now() };
    const visits = [
      { ...base, id: 'probe-ord-1', date: '2026-10-01', ate: ['Pepperoni Pie', 'Cheese Slice'] },
      { ...base, id: 'probe-ord-2', date: '2026-10-02', ate: ['pepperoni pie', 'Pepperoni Pie'] }, // same dish twice in one visit
    ];
    await injectRestaurants(listingsPage, probes);
    try {
      // No visits yet: no badges at all.
      await listingsPage.evaluate(() => openDetail('probe-pizza-1'));
      await expect(listingsPage.locator('#menuChips .ordered-badge')).toHaveCount(0);
      await listingsPage.evaluate(() => closeModal());

      await injectVisits(listingsPage, visits);
      await listingsPage.evaluate(() => openDetail('probe-pizza-1'));
      const row = (dish) => listingsPage.locator('#menuChips .menu-row', { hasText: dish });
      await expect(row('Pepperoni Pie').locator('.ordered-badge')).toHaveText('ordered 2×');
      await expect(row('Cheese Slice').locator('.ordered-badge')).toHaveText('ordered 1×');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id), visitIds: visits.map((v) => v.id) });
    }
  });

  test('"Group favorites" leads the menu once dishes are rated 4+ on average — real ratings only', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    const base = { restaurantId: 'probe-pizza-1', rating: 4, wouldReturn: true, notes: '', reviewer: 'P', authorUid: 'p', createdAt: Date.now(), date: '2026-10-01' };
    const vs = [
      { ...base, id: 'probe-fav-1', ate: ['Pepperoni Pie', 'Cheese Slice'], dishDetails: [{ dish: 'Pepperoni Pie', rating: 5 }, { dish: 'Cheese Slice', rating: 3 }] },
      { ...base, id: 'probe-fav-2', ate: ['Pepperoni Pie'], dishDetails: [{ dish: 'Pepperoni Pie', rating: 4 }] },
    ];
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.evaluate(() => openDetail('probe-pizza-1'));
      await expect(listingsPage.locator('#menuChips .menu-group[data-section="Group favorites"]')).toHaveCount(0);
      await listingsPage.evaluate(() => closeModal());
      await injectVisits(listingsPage, vs);
      await listingsPage.evaluate(() => openDetail('probe-pizza-1'));
      const fav = listingsPage.locator('#menuChips .menu-group[data-section="Group favorites"]');
      await expect(fav).toHaveClass(/open/);
      await expect(fav.locator('.dish-name')).toHaveText(['Pepperoni Pie']); // 4.5 avg; Cheese Slice's 3 stays out
      await expect(fav.locator('.dish-avg')).toHaveText('4.5★');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id), visitIds: vs.map((v) => v.id) });
    }
  });
});
