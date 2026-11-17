const { test, expect, openOwnerPage, openSignedInPage, openAppPage, closeSession, closeContext } = require('../fixtures/app-fixture');
const { createRegularTestUser, randomTestEmail, randomUsername, getOwnerUid, OWNER_TEST_USERNAME } = require('../fixtures/auth-helpers');
const { seedDoc, getDoc } = require('../fixtures/firestore-seed');
const { clearFirestore } = require('../fixtures/emulator-admin');

// Accounts: every account has a public, unique username (shown on its
// reviews) and a private display name (only it sees). See auth-gate.js and
// the usernames/profiles rules in firestore.rules.
test.beforeAll(async () => { await clearFirestore(); });
test.afterAll(async () => { await clearFirestore(); });

async function startSignup(page, { username, email = randomTestEmail('acct') }) {
  await page.click('#authModeToggle');
  await page.fill('#authEmail', email);
  await page.fill('#authPassword', 'testpass123');
  await page.fill('#authName', username);
}

test.describe('Usernames at sign-up', () => {
  test('a username someone already has is refused (any capitalization)', async ({ browser }) => {
    const taken = await createRegularTestUser({ username: randomUsername('taken') });
    const context = await browser.newContext();
    const page = await openAppPage(context);
    try {
      await startSignup(page, { username: taken.username.toUpperCase() });
      await expect(page.locator('#authNameStatus')).toHaveText(`${taken.username.toUpperCase()} is taken`);
      await page.click('#authSubmitBtn');
      await expect(page.locator('#authError')).toContainText('is taken');
      await expect(page.locator('#authGate')).toBeVisible();
      expect(await page.evaluate(() => window.RoundsFirebase.auth.currentUser)).toBeNull();
    } finally {
      await closeContext(context);
    }
  });

  test('usernames with spaces, too short, or with a blocked word are refused', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await openAppPage(context);
    try {
      await page.click('#authModeToggle');
      for (const [name, msg] of [['has space', '3–20 letters'], ['ab', '3–20 letters'], ['xx_fuck_xx', "isn't allowed"], ['admin', "isn't allowed"]]) {
        await page.fill('#authName', name);
        await expect(page.locator('#authNameStatus')).toContainText(msg);
      }
    } finally {
      await closeContext(context);
    }
  });
});

test.describe('The "Pick your username" step', () => {
  test('an account without a username must pick one before using the app', async ({ browser }) => {
    const taken = await createRegularTestUser({ username: randomUsername('held') });
    const creds = await createRegularTestUser({ username: null, displayName: 'Google Name' });
    const context = await browser.newContext();
    const page = await openAppPage(context);
    try {
      await page.fill('#authEmail', creds.email);
      await page.fill('#authPassword', creds.password);
      await page.click('#authSubmitBtn');
      await expect(page.locator('#usernameGate')).toBeVisible();
      await expect(page.locator('.wrap')).toBeHidden();
      // Someone else's name: refused, still on the step.
      await page.fill('#usernameInput', taken.username);
      await expect(page.locator('#usernameStatus')).toHaveText(`${taken.username} is taken`);
      await page.click('#usernameSave');
      await expect(page.locator('#usernameError')).toContainText('is taken');
      await expect(page.locator('.wrap')).toBeHidden();
      // A free one: in, and the display name starts as the username.
      const mine = randomUsername('mine');
      await page.fill('#usernameInput', mine);
      await page.click('#usernameSave');
      await expect(page.locator('.wrap')).toBeVisible();
      await expect(page.locator('.signed-in-chip')).toContainText(mine);
      await expect.poll(() => getDoc(`profiles/${creds.uid}`)).toEqual({ username: mine });
      await expect.poll(async () => (await getDoc(`users/${creds.uid}`))?.displayName).toBe(mine);
    } finally {
      await closeContext(context);
    }
  });
});

test.describe('Profile', () => {
  test('shows username, private display name, email and sign-in method; the display name never reaches reviews', async ({ browser }) => {
    const creds = await createRegularTestUser({ username: randomUsername('prof') });
    const page = await openSignedInPage(browser, { creds });
    try {
      await page.click('#chipProfileLink');
      await expect(page.locator('#profileUsername')).toHaveValue(creds.username);
      await expect(page.locator('#profileDisplayName')).toHaveValue(creds.username);
      await expect(page.locator('.profile-facts')).toContainText(creds.email);
      await expect(page.locator('.profile-facts')).toContainText('Email and password');
      await expect(page.locator('.owner-badge')).toHaveCount(0);
      await page.fill('#profileDisplayName', 'Only Me Sees This');
      await page.click('#profileDisplaySave');
      await expect(page.locator('#profileDisplayStatus')).toHaveText('Saved.');
      await expect(page.locator('.signed-in-chip')).toContainText('Only Me Sees This');
      // Public profile holds only the username.
      expect(await getDoc(`profiles/${creds.uid}`)).toEqual({ username: creds.username });
    } finally {
      await closeSession(page);
    }
  });

  test('the owner account shows the Owner role', async ({ ownerPage }) => {
    await ownerPage.click('#chipProfileLink');
    await expect(ownerPage.locator('.owner-badge')).toHaveText('Owner');
    await expect(ownerPage.locator('#profileUsername')).toHaveValue(OWNER_TEST_USERNAME);
  });
});

test.describe('One way in per email', () => {
  // Measured on the Auth Emulator: Firebase itself refuses a second
  // password sign-up for an email (EMAIL_EXISTS), but a Google sign-in with
  // the same email lands on the password account. The app refuses that.
  // A Google sign-in through the app's own Firebase Auth instance (the
  // same module the app loads), with an emulator Google credential — what
  // "Continue with Google" ends in, without driving the emulator's popup
  // page (which hangs in CI's headless browser).
  async function googleSignIn(page, email) {
    await page.evaluate(async (email) => {
      const m = await import('https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js');
      const cred = m.GoogleAuthProvider.credential(JSON.stringify({ sub: `g-${email}`, email, email_verified: true, name: 'Google Person' }));
      await m.signInWithCredential(window.RoundsFirebase.auth, cred);
    }, email);
  }

  test('an email made with a password cannot sign in with Google', async ({ browser }) => {
    const creds = await createRegularTestUser({ email: `pw-${Date.now()}@gmail.com`, username: randomUsername('pw') });
    const context = await browser.newContext();
    const page = await openAppPage(context);
    try {
      await googleSignIn(page, creds.email);
      await expect(page.locator('#authError')).toHaveText('This email signs in with your email and password.');
      await expect(page.locator('#authGate')).toBeVisible();
      await expect(page.locator('.wrap')).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.RoundsFirebase.auth.currentUser)).toBeNull();
      // The password still works.
      await page.fill('#authEmail', creds.email);
      await page.fill('#authPassword', creds.password);
      await page.click('#authSubmitBtn');
      await expect(page.locator('.wrap')).toBeVisible();
    } finally {
      await closeContext(context);
    }
  });

  test('an email made with Google cannot get a second, password account', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await openAppPage(context);
    const email = `g-${Date.now()}@gmail.com`;
    try {
      await googleSignIn(page, email);
      await expect(page.locator('#usernameGate')).toBeVisible(); // first Google sign-in: pick a username
      await page.click('#usernameSignOut');
      await expect(page.locator('#authGate')).toBeVisible();
      await startSignup(page, { username: randomUsername('second'), email });
      await page.click('#authSubmitBtn');
      await expect(page.locator('#authError')).toContainText('already has an account');
    } finally {
      await closeContext(context);
    }
  });
});

test.describe('Moving visits from the old account', () => {
  test("the owner's first sign-in moves the other account's visits to the owner, intact", async ({ browser }) => {
    const OLD = '6CU0HDaWexeVbO69buTBECU764R2';
    await seedDoc('restaurants/move-probe', { id: 'move-probe', name: 'Probe Move Spot', categories: ['Pizza'], address: '1 Probe St, Chicago, IL 60607', menu: ['Cheese Slice'], createdAt: Date.now() });
    const base = { restaurantId: 'move-probe', authorUid: OLD, reviewer: 'Briski', wouldReturn: true, notes: 'kept', createdAt: 1 };
    await seedDoc('visits/old-1', { ...base, id: 'old-1', date: '2026-11-01', rating: 4, ate: ['Cheese Slice'], dishDetails: [{ dish: 'Cheese Slice', rating: 5 }] });
    await seedDoc('visits/old-2', { ...base, id: 'old-2', date: '2026-11-02', rating: 3.5, ate: [] });
    const page = await openOwnerPage(browser);
    try {
      const ownerUid = getOwnerUid();
      await expect.poll(() => page.evaluate((OLD) => visits.filter((v) => v.authorUid === OLD).length, OLD)).toBe(0);
      const moved = await page.evaluate((uid) => visits.filter((v) => v.restaurantId === 'move-probe' && v.authorUid === uid)
        .map(({ date, rating, ate, dishDetails, notes, reviewer }) => ({ date, rating, ate, dishDetails, notes, reviewer }))
        .sort((a, b) => a.date.localeCompare(b.date)), ownerUid);
      expect(moved).toEqual([
        { date: '2026-11-01', rating: 4, ate: ['Cheese Slice'], dishDetails: [{ dish: 'Cheese Slice', rating: 5 }], notes: 'kept', reviewer: OWNER_TEST_USERNAME },
        { date: '2026-11-02', rating: 3.5, ate: [], dishDetails: undefined, notes: 'kept', reviewer: OWNER_TEST_USERNAME },
      ]);
      await expect.poll(() => getDoc('visits/old-1')).toBeNull();
      await expect.poll(() => getDoc('visits/old-2')).toBeNull();
    } finally {
      await closeSession(page);
    }
  });
});
