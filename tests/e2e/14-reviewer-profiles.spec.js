const { test, expect, openSignedInPage, closeSession } = require('../fixtures/app-fixture');
const { createRegularTestUser } = require('../fixtures/auth-helpers');

// Reviewer profiles are device-local display names (localStorage only,
// never synced) that get stamped on new visits. Separate from the Firebase
// account, which governs what you're allowed to edit.

// The reviewer button lives in the listings toolbar, which is hidden on
// the landing (neighborhoods) page.
async function openProfiles(page) {
  if (!(await page.locator('#listingsLayout').isVisible())) await page.click('#browseAllBtn');
  await page.click('#profileBtn');
  await expect(page.locator('#newProfileName')).toBeVisible();
}

test.describe('Reviewer profiles', () => {
  test('starts empty, and adding a name makes it the active reviewer', async ({ signedInPage }) => {
    await openProfiles(signedInPage);
    await expect(signedInPage.locator('#profileList')).toContainText('No reviewers yet');

    await signedInPage.fill('#newProfileName', 'Probe A');
    await signedInPage.press('#newProfileName', 'Enter');
    const row = signedInPage.locator('.profile-row', { hasText: 'Probe A' });
    await expect(row).toHaveClass(/active/);
    await expect(row.locator('.profile-active-tag')).toBeVisible();
    await expect(signedInPage.locator('#profileBtn')).toContainText('Probe A');
  });

  test('duplicate names are rejected, ignoring case', async ({ signedInPage }) => {
    const dialogs = [];
    signedInPage.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
    await openProfiles(signedInPage);
    await signedInPage.fill('#newProfileName', 'Probe A');
    await signedInPage.click('#addProfileBtn');
    await signedInPage.fill('#newProfileName', 'probe a');
    await signedInPage.click('#addProfileBtn');
    expect(dialogs.at(-1)).toContain('already taken');
    await expect(signedInPage.locator('.profile-row')).toHaveCount(1);
  });

  test('clicking another profile switches the active reviewer', async ({ signedInPage }) => {
    await openProfiles(signedInPage);
    for (const name of ['Probe A', 'Probe B']) {
      await signedInPage.fill('#newProfileName', name);
      await signedInPage.click('#addProfileBtn');
    }
    await expect(signedInPage.locator('.profile-row.active')).toContainText('Probe B');
    await signedInPage.locator('.profile-row', { hasText: 'Probe A' }).click();
    await expect(signedInPage.locator('.profile-row.active')).toContainText('Probe A');
    await expect(signedInPage.locator('#profileBtn')).toContainText('Probe A');
  });

  test('removing asks for confirmation; cancel keeps it, confirm removes it', async ({ signedInPage }) => {
    await openProfiles(signedInPage);
    await signedInPage.fill('#newProfileName', 'Probe A');
    await signedInPage.click('#addProfileBtn');
    const row = signedInPage.locator('.profile-row', { hasText: 'Probe A' });

    signedInPage.once('dialog', (d) => d.dismiss());
    await row.locator('.trash').click();
    await expect(row).toHaveCount(1);

    signedInPage.once('dialog', (d) => d.accept());
    await row.locator('.trash').click();
    await expect(signedInPage.locator('.profile-row')).toHaveCount(0);
  });

  test('profiles are per-device: the same account on another device starts with none', async ({ browser }) => {
    const creds = await createRegularTestUser();
    const deviceA = await openSignedInPage(browser, { creds });
    const deviceB = await openSignedInPage(browser, { creds });
    try {
      await openProfiles(deviceA);
      await deviceA.fill('#newProfileName', 'Only On A');
      await deviceA.click('#addProfileBtn');
      await expect(deviceA.locator('.profile-row')).toHaveCount(1);

      await openProfiles(deviceB);
      await expect(deviceB.locator('#profileList')).toContainText('No reviewers yet');
    } finally {
      await closeSession(deviceA);
      await closeSession(deviceB);
    }
  });
});
