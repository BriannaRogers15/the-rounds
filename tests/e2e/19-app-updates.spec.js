// Updates apply themselves: a published version reaches an open tab with
// no Reload click, but never while someone is typing or has a popup open.
//
// The shared fixtures switch the service worker off (see tests/README.md),
// so this spec runs its own copy of the app on its own server — one that
// sends GitHub Pages' caching header (max-age=600), because that header is
// what let an update install the previous version's files. "Publishing" =
// rewriting the copy's service-worker.js version and stamping app.js.
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const APP_FILES = ['index.html', 'styles.css', 'app.js', 'firebase-init.js', 'auth-gate.js',
  'data/address-lookup.js', 'data/menu-lookup.js', 'manifest.json', 'icon.svg', 'service-worker.js'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

let root, server, port, version = 0;

function publish(){
  version++;
  const sw = path.join(root, 'service-worker.js');
  fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/the-rounds-v\d+/, `the-rounds-v${9000 + version}`));
  const app = path.join(root, 'app.js');
  const src = fs.readFileSync(app, 'utf8').replace(/^window\.__ver=\d+;\n/, '');
  fs.writeFileSync(app, `window.__ver=${version};\n` + src);
}

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rounds-updates-'));
  for (const f of APP_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  }
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a published update applies itself, but waits for typing and popups', async ({ browser }) => {
  test.setTimeout(120000);
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  await context.addInitScript(() => { window.__ROUNDS_TEST__ = { useEmulators: true }; });
  const page = await context.newPage();
  // Every page load, so each update is checked to reload exactly once and
  // nothing else reloads the page.
  let loads = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) loads++; });
  // An update reloads the page, so a read can land mid-reload; that reads
  // as "not known yet" and the poll asks again.
  const runningVersion = () => page.evaluate(() => window.__ver).catch(() => null);
  // What the browser does when a tab comes back into view.
  const tabReturns = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  publish(); // v1: the first visit
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  await page.reload(); // now controlled by the worker
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect.poll(runningVersion).toBe(1);
  await page.waitForLoadState('load');
  expect(loads).toBe(2); // the visit and the reload above

  // Idle: v2 loads with no click, even though the server says files may be
  // reused for 10 minutes.
  publish();
  await tabReturns();
  await expect.poll(runningVersion, { timeout: 20000 }).toBe(2);
  await page.waitForLoadState('load');
  await expect(page.locator('#swUpdateBanner')).toHaveCount(0);
  expect(loads).toBe(3);

  // Typing: half-typed text in a box holds the update and is kept…
  const box = page.locator('input[type="email"], input[type="text"], input[type="password"]').locator('visible=true').first();
  await box.fill('half-typed@example.com');
  await box.blur();
  publish();
  await tabReturns();
  await page.waitForTimeout(6000);
  expect(await runningVersion()).toBe(2);
  expect(loads).toBe(3);
  await expect(box).toHaveValue('half-typed@example.com');
  // …and v3 applies once the box is cleared.
  await box.fill('');
  await box.blur();
  await expect.poll(runningVersion, { timeout: 15000 }).toBe(3);
  await page.waitForLoadState('load');
  expect(loads).toBe(4);

  // A popup holds it the same way, and v4 applies once it closes.
  await page.evaluate(() => { document.getElementById('modalRoot').innerHTML = '<div class="overlay"></div>'; });
  publish();
  await tabReturns();
  await page.waitForTimeout(6000);
  expect(await runningVersion()).toBe(3);
  expect(loads).toBe(4);
  await page.evaluate(() => { document.getElementById('modalRoot').innerHTML = ''; });
  await expect.poll(runningVersion, { timeout: 15000 }).toBe(4);
  await page.waitForLoadState('load');
  expect(loads).toBe(5);

  await context.close();
});
