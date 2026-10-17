/**
 * BUH-02.08, against the real build: the Admin Hub is invisible on the public site and only at
 * its private link. Every admin route (listed from the route files) answers exactly like an
 * address that does not exist until the browser has been through the link; guessable paths
 * (/admin, /wp-admin, /.env…) are the ordinary 404 byte for byte; the link sends no-referrer,
 * noindex and no-store; the shop's pages and scripts carry nothing of it. In Chromium: no way in
 * from the shop at 375 and 1280 px; the link opens the sign-in on a phone and the full hub on a
 * laptop, with a Phone view / Laptop view switch remembered per device; changing the link; the
 * server command; the password-reset email through its one-time path; the update that brings
 * the link (logged, emailed, shown once to a signed-in owner); the scanner slow-down, which a
 * shopper never meets. Skipped without a build (and the browser parts without Playwright).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { SMTPServer } from 'smtp-server';
import { adminPathIn, hasBuild, openDoor, rawFetch, startServer, type RunningServer } from './server.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;

const EMAIL = 'admin@beautifuluaehome.com';
let password = 'Door-Owner-Pass-1';
let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
/** The current admin link (changed by the tests below). */
let adminPath = '';
const mails: string[] = [];
let smtp: SMTPServer;

/** Text of an email (quoted-printable undone). */
const plain = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
async function mailMatching(re: RegExp, since = 0): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const found = mails.slice(since).map(plain).find((m) => re.test(m));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no email matching ${re}`);
}

async function signInOwner(s: RunningServer, newPassword: string): Promise<string> {
  const h = { 'content-type': 'application/json', origin: s.base };
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = s.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${s.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${s.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword }) });
  assert.equal(changed.status, 200);
  return (changed.headers.get('set-cookie') || '').split(';')[0];
}

before(async () => {
  if (skip) return;
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, cb) {
      let raw = '';
      stream.on('data', (d) => (raw += d));
      stream.on('end', () => {
        mails.push(raw);
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  const port = String((smtp.server.address() as { port: number }).port);
  server = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: port, SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@test', BACKUP_EMAIL: 'owner@test' });
  adminPath = server.adminPath;
  cookie = await signInOwner(server, password);
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
  smtp?.close();
});

/** Status, body and every header but Date: what a visitor can compare. */
async function answer(res: Response) {
  const body = await res.text();
  const headers = [...res.headers.entries()].filter(([k]) => k !== 'date').map(([k, v]) => `${k}: ${v}`).sort();
  return { status: res.status, body, headers };
}
const rand = () => crypto.randomBytes(6).toString('hex');

/** Every route file under these folders, as an address and its methods. */
function routes(): Array<{ url: string; methods: string[]; file: string }> {
  const out: Array<{ url: string; methods: string[]; file: string }> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'route.ts') {
        const src = fs.readFileSync(p, 'utf8');
        const methods = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
        const url = `/${path.relative('src/app', path.dirname(p))}`.replace(/\[key\]/g, 'store').replace(/\[[^\]]+\]/g, 'x');
        out.push({ url, methods, file: p });
      }
    }
  };
  walk('src/app/api/admin');
  for (const f of ['src/app/api/courier/dispatch', 'src/app/api/courier/test', 'src/app/api/ai-transform']) walk(f);
  return out;
}

test('without the door every admin route (from the route files) answers exactly like an unknown address, even with a session', { skip }, async () => {
  const list = routes();
  assert.ok(list.length >= 44, `${list.length} routes`);
  let checked = 0;
  for (const { url, methods, file } of list) {
    for (const method of methods) {
      const init = (extra: Record<string, string> = {}) => ({
        method,
        headers: { 'content-type': 'application/json', origin: server.base, ...extra },
        body: method === 'GET' ? undefined : '{}',
        redirect: 'manual' as const,
      });
      const unknown = await answer(await rawFetch(`${server.base}/api/no-such-${rand()}`, init()));
      assert.equal(unknown.status, 404);
      assert.deepEqual(await answer(await rawFetch(`${server.base}${url}`, init())), unknown, `${method} ${url} (${file})`);
      assert.deepEqual(await answer(await rawFetch(`${server.base}${url}`, init({ cookie }))), unknown, `${method} ${url} with a session but no door`);
      assert.deepEqual(await answer(await rawFetch(`${server.base}${url}`, init({ cookie: 'buh_door=forged.token' }))), unknown, `${method} ${url} with a forged door`);
      // Through the door, the route itself answers (JSON, not the 404 page).
      const through = await rawFetch(`${server.base}${url}`, init({ cookie: server.door }));
      assert.match(through.headers.get('content-type') || '', /json|text\/event-stream|octet|pdf|image|gzip/, `${method} ${url} through the door: ${through.status}`);
      await through.body?.cancel();
      checked++;
    }
  }
  assert.ok(checked >= 60, `${checked} route methods checked`);
});

test('guessable paths are the ordinary 404, byte for byte (body and headers) the same as any unknown address', { skip }, async () => {
  const unknown = await answer(await rawFetch(`${server.base}/no-such-page-${rand()}`));
  assert.equal(unknown.status, 404);
  for (const p of ['/admin', '/admin/', '/Admin', '/login', '/wp-admin', '/wp-login.php', '/dashboard', '/administrator', '/admin.php', '/.env', '/phpmyadmin', '/hub', '/hub/x', '/_buh/nowhere', `/${crypto.randomBytes(24).toString('base64url')}`, `/${crypto.randomBytes(32).toString('base64url')}`]) {
    const res = await rawFetch(`${server.base}${p}`, { redirect: 'follow' });
    assert.deepEqual(await answer(res), unknown, p);
  }
  // A link's own answer with a wrong case or a character changed: also just unknown.
  const near = adminPath.slice(0, -1) + (adminPath.endsWith('A') ? 'B' : 'A');
  assert.deepEqual(await answer(await rawFetch(`${server.base}${near}`)), unknown);
});

test('the admin link: no-referrer, noindex, no-store and an HttpOnly SameSite=Strict door cookie for 30 days; never in robots.txt, the sitemap, the shop or its scripts', { skip }, async () => {
  const res = await rawFetch(`${server.base}${adminPath}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const door = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('buh_door='))!;
  assert.match(door, /; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict/);
  assert.match(await res.text(), /<title>Admin Hub/);
  const segment = adminPath.slice(1);
  for (const p of ['/robots.txt', '/sitemap.xml']) {
    const text = await (await rawFetch(`${server.base}${p}`)).text();
    assert.ok(!text.includes(segment) && !/hub|admin/i.test(text), p);
  }
  // The shop's pages and every script and style they load (or can load later).
  const seen = new Set<string>();
  const problems: string[] = [];
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string }>;
  const scanFile = async (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    const text = await (await rawFetch(`${server.base}${url}`)).text();
    for (const bad of [segment, '/api/admin', 'buh_door', 'admin hub', 'x-buh-door', '"/hub"', "'/hub'"]) if (text.toLowerCase().includes(bad.toLowerCase())) problems.push(`${url}: ${bad}`);
    // "admin" only inside Firebase's own error messages (the phone-check library).
    const left = text.replace(/admin-restricted-operation|ADMIN_ONLY_OPERATION|by an administrator|to administrators/g, '');
    if (/admin/i.test(left)) problems.push(`${url}: …${left.slice(Math.max(0, left.search(/admin/i) - 50), left.search(/admin/i) + 30)}…`);
    for (const m of text.matchAll(/(?:\/_next\/)?static\/(?:chunks|css)\/[^"'\s()<>\\]+?\.(?:js|css)/g)) await scanFile(m[0].startsWith('/_next/') ? m[0] : `/_next/${m[0]}`);
  };
  for (const p of ['/', `/p/${products[0].id}`, '/offline', '/sw.js', '/manifest.webmanifest']) await scanFile(p);
  assert.ok(seen.size >= 10, `${seen.size} files`);
  assert.deepEqual(problems, []);
  // The server's own log: the link only in the one-time box, never in a logEvent line.
  assert.equal(server.log().split(segment).length - 1, 1, 'printed once');
  assert.ok(server.log().includes(`"link":"/${segment.slice(0, 4)}…"`));
});

test('the link was emailed to the admin email when it was made (email is set up here)', { skip }, async () => {
  const mail = await mailMatching(/Your Admin Hub: /);
  assert.ok(mail.includes(adminPath.slice(1)), 'the link is in it');
  assert.match(mail, /bookmark it/);
});

const overflow = (page: import('playwright').Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const width of [375, 1280]) {
  test(`the shop has no way into the admin at ${width} px`, { skip: skip || skipBrowser }, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 860 } });
    const page = await ctx.newPage();
    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('feed').waitFor();
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('a, button, [role=button], [title], [aria-label]')].map((e) => [e.textContent, e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('href')].join(' '))
    );
    assert.deepEqual(labels.filter((l) => /admin|hub|staff|owner|sign in|log ?in/i.test(l)), []);
    assert.ok(!/admin/i.test(await page.evaluate(() => document.body.innerText)));
    if (width < 768) {
      const tabs = await page.getByRole('navigation', { name: 'Shop' }).getByRole('button').allTextContents();
      assert.deepEqual(tabs.map((t) => t.replace(/\d+/g, '').trim()), ['Home', 'Search', 'Bag', 'Orders']);
    }
    // The version is plain text, not a way into Settings.
    assert.equal(await page.getByRole('button', { name: /BUH-/ }).count(), 0);
    assert.equal(await overflow(page), 0);
    await ctx.close();
  });
}

test('one link: the sign-in on a phone, then the phone view; on a laptop the full view; a Phone view / Laptop view switch remembered per device', { skip: skip || skipBrowser }, async () => {
  // A phone that has never been here: the link opens the sign-in.
  const phone = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${server.base}${adminPath}`, { waitUntil: 'domcontentloaded' });
  await p.getByText('Admin Hub Security Access').waitFor();
  assert.equal(await overflow(p), 0);
  await p.locator('input[type=email]').fill(EMAIL);
  await p.locator('input[autocomplete=current-password]').fill(password);
  await p.getByRole('button', { name: /Unlock Admin Portal/ }).click();
  await p.locator('[data-hub-view="phone"]').waitFor();
  await p.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: 'More' }).waitFor();
  assert.equal(await p.getByRole('button', { name: 'Phone view' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await overflow(p), 0);
  await phone.close();

  // A laptop (signed in): the full view, tabs at the top.
  const laptop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [n, v] = cookie.split('=');
  await laptop.addCookies([{ name: n, value: v, url: server.base }]);
  const l = await laptop.newPage();
  l.on('pageerror', (e) => errors.push(e.message));
  // This laptop has the shop's service worker (it opened the shop first).
  const shopFiles = new Set<string>();
  l.on('response', (r) => shopFiles.add(r.url()));
  await laptop.route(/images\.unsplash\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
  await l.goto(server.base, { waitUntil: 'domcontentloaded' });
  await l.evaluate(() =>
    Promise.race([
      (async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
      })(),
      new Promise((_, no) => setTimeout(() => no(new Error('the shop’s service worker did not take over')), 20_000)),
    ])
  );
  l.removeAllListeners('response');
  const hubResponses: import('playwright').Response[] = [];
  l.on('response', (r) => hubResponses.push(r));
  const opened = (await l.goto(`${server.base}${adminPath}`, { waitUntil: 'domcontentloaded' }))!;
  await l.locator('[data-hub-view="laptop"]').waitFor();
  // The worker never answers the hub, nor anything the hub loads, and keeps none of it.
  assert.equal(opened.fromServiceWorker(), false);
  assert.deepEqual(hubResponses.filter((r) => r.fromServiceWorker()).map((r) => r.url()), []);
  const cached: string[] = await l.evaluate(async () => {
    const out: string[] = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url);
    return out;
  });
  const hubOnly = hubResponses.map((r) => r.url()).filter((u) => !shopFiles.has(u));
  assert.deepEqual(cached.filter((u) => u.includes(adminPath.slice(1)) || hubOnly.includes(u)), []);
  await l.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: /Orders & Dispatches/ }).waitFor();
  assert.equal(await l.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: 'More' }).count(), 0);
  // The switch, by keyboard: Phone view, remembered after a reload; then back.
  await l.getByRole('button', { name: 'Phone view' }).focus();
  await l.keyboard.press('Enter');
  await l.locator('[data-hub-view="phone"]').waitFor();
  assert.equal(await l.getByRole('button', { name: 'Phone view' }).getAttribute('aria-pressed'), 'true');
  await l.reload({ waitUntil: 'domcontentloaded' });
  await l.locator('[data-hub-view="phone"]').waitFor();
  await l.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: 'More' }).waitFor();
  assert.equal(await overflow(l), 0);
  await l.getByRole('button', { name: 'Laptop view' }).click();
  await l.locator('[data-hub-view="laptop"]').waitFor();
  await l.reload({ waitUntil: 'domcontentloaded' });
  await l.locator('[data-hub-view="laptop"]').waitFor();
  assert.equal(await overflow(l), 0);
  await laptop.close();
  assert.deepEqual(errors, []);
});

test('changing the admin link in Settings → Security: password needed; the old link and every door stop at once; the new link is shown once, emailed, audited without it', { skip: skip || skipBrowser }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [n, v] = cookie.split('=');
  await ctx.addCookies([{ name: n, value: v, url: server.base }]);
  const page = await ctx.newPage();
  await page.goto(`${server.base}${adminPath}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Security' }).click();
  await page.getByRole('button', { name: 'Change the admin link' }).click();
  await page.locator('#admin-link-password').fill('not my password');
  await page.getByRole('button', { name: 'Change the link now' }).click();
  await page.getByRole('alert').filter({ hasText: /not your current password/ }).waitFor();
  const mailsBefore = mails.length;
  await page.locator('#admin-link-password').fill(password);
  await page.getByRole('button', { name: 'Change the link now' }).click();
  const shown = (await page.getByTestId('new-admin-link').textContent())!;
  const newPath = new URL(shown).pathname;
  assert.match(newPath, /^\/[A-Za-z0-9_-]{32}$/);
  assert.notEqual(newPath, adminPath);
  assert.equal(await overflow(page), 0);

  const unknown = await answer(await rawFetch(`${server.base}/no-such-page-${rand()}`));
  assert.deepEqual(await answer(await rawFetch(`${server.base}${adminPath}`)), unknown, 'the old link is now just an unknown address');
  const unknownApi = await answer(await rawFetch(`${server.base}/api/no-such-${rand()}`));
  assert.deepEqual(await answer(await rawFetch(`${server.base}/api/admin/session`, { headers: { cookie: `${server.door}; ${cookie}` } })), unknownApi, 'another device’s door stopped working');
  // This browser was moved to the new link and keeps working.
  await page.getByRole('link', { name: 'Open the new link' }).click();
  await page.waitForURL(`${server.base}${newPath}`);
  await page.getByRole('navigation', { name: 'Admin sections' }).waitFor();
  const mail = await mailMatching(/was changed/, mailsBefore);
  assert.ok(mail.includes(newPath.slice(1)));
  const audit = fs.readdirSync(server.dataDir).filter((f) => f.startsWith('audit-')).map((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8')).join('');
  assert.match(audit, /"action":"admin\.link_changed"/);
  assert.ok(!audit.includes(newPath.slice(1)) && !audit.includes(adminPath.slice(1)), 'the audit log never has a link');
  await ctx.close();
  adminPath = newPath;
  await openDoor(server.base, adminPath);
});

test('lost the link: the server command makes a new one (it cannot print the old one: only a fingerprint is kept)', { skip }, async () => {
  const env = { ...process.env, DATA_DIR: server.dataDir, NEXT_PUBLIC_APP_URL: server.base };
  const info = execFileSync(process.execPath, ['scripts/admin-link.mjs'], { env }).toString();
  assert.match(info, /cannot be shown again/);
  const out = execFileSync(process.execPath, ['scripts/admin-link.mjs', '--new'], { env }).toString();
  const newPath = adminPathIn(out)!;
  assert.ok(newPath && out.includes(`${server.base}${newPath}`));
  const unknown = await answer(await rawFetch(`${server.base}/no-such-page-${rand()}`));
  assert.deepEqual(await answer(await rawFetch(`${server.base}${adminPath}`)), unknown, 'the old link stopped at once, in the running shop');
  assert.equal((await rawFetch(`${server.base}${newPath}`)).status, 200);
  adminPath = newPath;
  await openDoor(server.base, adminPath);
  // The owner's session was not touched.
  assert.equal((await (await fetch(`${server.base}/api/admin/session`, { headers: { cookie } })).json()).authenticated, true);
  if (skipBrowser) return;
  // Opened, the hub says "this is your private link: bookmark it".
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const [n, v] = cookie.split('=');
  await ctx.addCookies([{ name: n, value: v, url: server.base }]);
  const page = await ctx.newPage();
  await page.goto(`${server.base}${adminPath}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('admin-link-notice').waitFor();
  await page.getByRole('button', { name: /I.ve bookmarked it/ }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation', { name: 'Admin sections' }).waitFor();
  assert.equal(await page.getByTestId('admin-link-notice').count(), 0);
  await ctx.close();
});

test('forgot password: the emailed link opens the hub through its one-time path on a phone that never had the link; then it is gone', { skip: skip || skipBrowser }, async () => {
  const since = mails.length;
  const ask = await fetch(`${server.base}/api/admin/password/forgot`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify({ email: EMAIL }) });
  assert.equal(ask.status, 200);
  const mail = await mailMatching(/Choose a new password here/, since);
  const link = mail.match(/(http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43})#reset=([A-Za-z0-9_%-]+)/)!;
  assert.ok(link, 'a link with a one-time path and the token in the fragment');
  assert.ok(!mail.includes(adminPath.slice(1)), 'not the admin link itself');
  const phone = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true });
  const page = await phone.newPage();
  await page.goto(`${link[1]}#reset=${link[2]}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#admin-reset-password').waitFor();
  assert.ok(!page.url().includes('reset='), 'the token leaves the address bar');
  password = 'Reset-By-Email-Pass-2';
  await page.locator('#admin-reset-password').fill(password);
  await page.locator('#admin-reset-confirm').fill(password);
  await page.getByRole('button', { name: 'Set New Password' }).click();
  await page.getByText(/Password changed/).waitFor();
  // Signed in from that phone (its door came from the email's path).
  await page.locator('input[type=email]').fill(EMAIL);
  await page.locator('input[autocomplete=current-password]').fill(password);
  await page.getByRole('button', { name: /Unlock Admin Portal/ }).click();
  await page.getByRole('navigation', { name: 'Admin sections' }).waitFor();
  assert.equal(await overflow(page), 0);
  await phone.close();
  const unknown = await answer(await rawFetch(`${server.base}/no-such-page-${rand()}`));
  assert.deepEqual(await answer(await rawFetch(link[1])), unknown, 'used: its path is gone');
  // Every session ended with the reset: sign in again for the tests that follow.
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify({ email: EMAIL, password }) });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
});

test('an existing shop updated to private links: the shop keeps working, the link is logged once and emailed, and a signed-in owner is shown it once', { skip }, async () => {
  const port = String((smtp.server.address() as { port: number }).port);
  const mailEnv = { SMTP_HOST: '127.0.0.1', SMTP_PORT: port, SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@test', BACKUP_EMAIL: 'owner@test' };
  let shop = await startServer(mailEnv);
  const dataDir = shop.dataDir;
  const session = await signInOwner(shop, 'Updated-Shop-Pass-1');
  shop.stop();
  await new Promise((r) => setTimeout(r, 500));
  // The database as the version before private links left it.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(dataDir, 'shop.db'));
  db.prepare("DELETE FROM kv WHERE key IN ('admin:link', 'admin:link-reveal', 'admin:link-notice')").run();
  db.close();
  const since = mails.length;
  shop = await startServer({ ...mailEnv, DATA_DIR: dataDir });
  try {
    const newPath = shop.adminPath;
    assert.equal(shop.log().split(newPath.slice(1)).length - 1, 1, 'printed once');
    assert.ok((await mailMatching(/Your Admin Hub: /, since)).includes(newPath.slice(1)), 'emailed');
    assert.equal((await rawFetch(`${shop.base}/`)).status, 200, 'the shop works');
    // The owner's session from before the update still works (through the door).
    assert.equal((await (await fetch(`${shop.base}/api/admin/session`, { headers: { cookie: session } })).json()).authenticated, true);
    if (skipBrowser) return;
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const [n, v] = session.split('=');
    await ctx.addCookies([{ name: n, value: v, url: shop.base }]);
    const page = await ctx.newPage();
    await page.goto(shop.base, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(`${shop.base}${newPath}`);
    await page.getByTestId('admin-link-notice').getByText(/has moved to this private link/).waitFor();
    // Once only: the shop is the shop again.
    await page.goto(shop.base, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('feed').waitFor();
    assert.equal(page.url(), `${shop.base}/`);
    await ctx.close();
  } finally {
    shop.stop();
  }
});

test('scanner slow-down (TRUST_PROXY=1): many 404s from one address are slowed, then 429 for a while; other addresses and a whole shopping visit never are', { skip }, async () => {
  const shop = await startServer({ TRUST_PROXY: '1' });
  try {
    const from = (ip: string) => ({ headers: { 'x-real-ip': ip }, redirect: 'manual' as const });
    const time = async (url: string, ip: string) => {
      const t = Date.now();
      const res = await rawFetch(`${shop.base}${url}`, from(ip));
      await res.arrayBuffer();
      return { status: res.status, ms: Date.now() - t, retry: res.headers.get('retry-after') };
    };
    const scanner = '198.51.100.66';
    for (let i = 0; i < 10; i++) assert.equal((await time(`/wp-admin/${i}.php`, scanner)).status, 404);
    const slowed = await time('/.env', scanner);
    assert.equal(slowed.status, 404);
    assert.ok(slowed.ms >= 900, `slowed (${slowed.ms} ms)`);
    for (let i = 11; i < 30; i++) await time(`/admin${i}`, scanner);
    const shut = await time('/', scanner);
    assert.equal(shut.status, 429);
    assert.ok(Number(shut.retry) > 500, `Retry-After ${shut.retry}`);
    // Someone else, at the same moment: as fast as ever.
    const other = await time('/', '198.51.100.67');
    assert.equal(other.status, 200);
    assert.ok(other.ms < 900);
    // A shopper whose old page asks for files of the previous version, a gone photo and a dead
    // product link, again and again: never slowed, never shut out.
    const shopper = '198.51.100.68';
    const products = (await (await rawFetch(`${shop.base}/api/products`, from(shopper))).json()).products as Array<{ id: string }>;
    for (let round = 0; round < 3; round++) {
      for (const u of ['/', `/p/${products[0].id}`, '/api/products', '/api/settings/public', '/manifest.webmanifest', '/sw.js', '/offline']) {
        const r = await time(u, shopper);
        assert.ok(r.status < 400, `${u} ${r.status}`);
        assert.ok(r.ms < 900, `${u} ${r.ms} ms`);
      }
      for (let i = 0; i < 15; i++) assert.equal((await time(`/_next/static/chunks/old-${round}-${i}.js`, shopper)).status, 404);
      assert.equal((await time(`/api/images/${'a'.repeat(64)}.jpg`, shopper)).status, 404);
      assert.ok((await time('/p/a-product-that-was-removed', shopper)).status < 500);
    }
    assert.equal((await time('/', shopper)).status, 200);
    if (!skipBrowser) {
      // The same in a real browser at phone width: a whole visit, never a 429.
      const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, extraHTTPHeaders: { 'X-Real-IP': '198.51.100.69' } });
      const page = await ctx.newPage();
      const statuses: number[] = [];
      page.on('response', (r) => statuses.push(r.status()));
      for (let i = 0; i < 3; i++) {
        await page.goto(shop.base, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('feed').waitFor();
        await page.locator('[data-testid=feed] article a').first().click();
        await page.getByRole('dialog').first().waitFor();
        await page.keyboard.press('Escape');
      }
      assert.ok(!statuses.includes(429), 'never shut out');
      await ctx.close();
    }
  } finally {
    shop.stop();
  }
  // Without TRUST_PROXY (no real addresses), nothing is counted.
  for (let i = 0; i < 40; i++) await (await rawFetch(`${server.base}/wp-admin/${i}`, { headers: { 'x-real-ip': '198.51.100.70' } })).arrayBuffer();
  assert.equal((await rawFetch(`${server.base}/`, { headers: { 'x-real-ip': '198.51.100.70' } })).status, 200);
});
