/**
 * The Content Security Policy against the real build, in a real browser.
 *
 * Pages rendered for each request (the Admin Hub, a product's page, a tracking link, the terms, a
 * shared selection) carry a per-request nonce policy with no 'unsafe-inline' for scripts: their
 * own scripts run (the page works), an injected inline script or handler does not, Stripe.js can
 * still be loaded where the checkout is, the service worker still registers. The pages kept for a
 * while (the home, category and festival pages) cannot carry a nonce: they keep the static policy,
 * which this file states, so a change there is noticed.
 * Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { ownerPassword, wrongLogin } from './fixtures/fake.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;
const EMAIL = 'admin@beautifuluaehome.com';
const OWNER_PASSWORD = ownerPassword();

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
let productId = '';
let trackPath = '';

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  if (skip) return;
  server = await startServer();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify(wrongLogin()) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: OWNER_PASSWORD }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  const res = await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: '+971509998877' } });
  assert.equal(res.status, 200, await res.text());

  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  productId = products[0].id;
  const placed = await rawFetch(`${server.base}/api/orders`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      customer: { fullName: 'Noura Test', phone: '+971508817001', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
      items: [{ productId, profileId: products[0].profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
    }),
  });
  const text = await placed.text();
  assert.equal(placed.status, 201, text);
  trackPath = JSON.parse(text).order.trackPath;
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const scriptSrc = (policy: string | null) => (policy ?? '').split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) ?? '';
const nonceOf = (policy: string | null) => /'nonce-([^']+)'/.exec(scriptSrc(policy))?.[1] ?? '';
/** Every <script …> opening tag in a page. */
const scriptTags = (html: string) => [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);

/** The pages rendered per request, by the policy they get. */
const noncePages = (): Array<{ name: string; path: string; kind: 'private' | 'shop'; status: number }> => [
  { name: 'the Admin Hub', path: server.adminPath, kind: 'private', status: 200 },
  { name: 'a product’s page', path: `/p/${productId}`, kind: 'shop', status: 200 },
  { name: 'a tracking link', path: trackPath, kind: 'shop', status: 200 },
  { name: 'the terms', path: '/terms', kind: 'shop', status: 200 },
  { name: 'a shared selection that names none', path: '/c/no-such-selection', kind: 'shop', status: 404 },
  { name: 'a tracking link that opens nothing', path: '/track/nothing.here', kind: 'shop', status: 404 },
];

test('pages rendered per request: script-src has this request’s nonce and no unsafe-inline; every script in the page carries it; a visitor’s own header is never used', { skip }, async () => {
  for (const p of noncePages()) {
    const res = await rawFetch(`${server.base}${p.path}`, { headers: { 'content-security-policy': "script-src 'nonce-chosenByTheVisitor'", 'x-nonce': 'chosenByTheVisitor' } });
    const html = await res.text();
    assert.equal(res.status, p.status, p.name);
    const policy = res.headers.get('content-security-policy');
    const scripts = scriptSrc(policy);
    assert.doesNotMatch(scripts, /unsafe-inline|unsafe-eval/, `${p.name}: ${scripts}`);
    const nonce = nonceOf(policy);
    assert.match(nonce, /^[A-Za-z0-9+/]{24}$/, p.name);
    assert.ok(!html.includes('chosenByTheVisitor'), `${p.name}: the nonce is the server's`);
    assert.doesNotMatch(scripts, /strict-dynamic/, p.name);
    if (p.kind === 'private') {
      assert.doesNotMatch(scripts, /https:/, `${p.name}: no other site's script`);
    } else {
      assert.match(scripts, /https:\/\/js\.stripe\.com/, `${p.name}: Stripe.js stays allowed`);
    }
    // Every script the page brings carries the nonce, but the two that never run or are allowed by
    // hash: JSON-LD (data, not a script) and the language-direction script.
    const tags = scriptTags(html);
    assert.ok(tags.length >= 5, `${p.name}: ${tags.length} scripts`);
    const without = tags.filter((t) => !t.includes(`nonce="${nonce}"`) && !t.includes('application/ld+json'));
    assert.ok(without.length <= 1, `${p.name}: ${without.join(' ')}`);
    for (const t of without) assert.equal(t, '<script>', `${p.name}: only the hash-allowed inline script has no nonce`);
    // The rest of the policy and the other headers are the shop's usual ones.
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"]) assert.ok(policy!.includes(d), `${p.name}: ${d}`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((res.headers.get('content-security-policy') ?? '').split(',').length, 1, 'one policy, not two');

    // A new nonce for every request.
    const again = await rawFetch(`${server.base}${p.path}`);
    await again.arrayBuffer();
    assert.notEqual(nonceOf(again.headers.get('content-security-policy')), nonce, p.name);
  }
});

test('what stays as it was: the kept pages keep the static policy (no nonce is possible there); an unknown address and the hub’s own name answer exactly alike', { skip }, async () => {
  for (const p of ['/', '/offline']) {
    const res = await rawFetch(`${server.base}${p}`);
    const html = await res.text();
    const scripts = scriptSrc(res.headers.get('content-security-policy'));
    assert.match(scripts, /'self' 'unsafe-inline'/, `${p}: ${scripts}`);
    assert.equal(nonceOf(res.headers.get('content-security-policy')), '');
    assert.ok(!/<script[^>]* nonce=/.test(html), `${p}: no nonce in a kept page`);
  }
  // The door: /hub, an admin API without the door and any unknown address are still one answer.
  const headersOf = async (p: string) => {
    const res = await rawFetch(`${server.base}${p}`);
    await res.arrayBuffer();
    return { status: res.status, headers: [...res.headers.entries()].filter(([k]) => k !== 'date').map(([k, v]) => `${k}: ${v}`).sort() };
  };
  assert.deepEqual(await headersOf('/hub'), await headersOf('/no-such-page-here'));
  assert.deepEqual(await headersOf('/pay/' + 'A'.repeat(43)), await headersOf('/no-such-page-here'));
  // API answers keep their own closed policy.
  const health = await rawFetch(`${server.base}/api/health`);
  assert.equal(health.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
});

interface Opened {
  page: Page;
  problems: string[];
  close: () => Promise<void>;
}
async function open(width: number, opts: { signedIn?: boolean; sw?: boolean } = {}): Promise<Opened> {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, isMobile: width < 768, hasTouch: width < 768, serviceWorkers: opts.sw ? 'allow' : 'block' });
  await ctx.route(/images\.unsplash\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>' }));
  if (opts.signedIn) {
    const [name, value] = cookie.split('=');
    await ctx.addCookies([{ name, value, url: server.base }]);
  }
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`error: ${e.message}`));
  page.on('console', (m) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(m.text())) problems.push(`csp: ${m.text()}`);
  });
  return { page, problems, close: () => ctx.close() };
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
/**
 * What an injected script would do, tried three ways: an inline <script>, an inline handler (the
 * usual XSS: <img onerror>), and a script from another site. Returns what ran.
 */
async function inject(page: Page): Promise<{ inline: boolean; handler: boolean; foreign: boolean; violations: number }> {
  await page.route('https://evil.example/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.__foreign = true;' }));
  return page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    let violations = 0;
    document.addEventListener('securitypolicyviolation', () => violations++);
    const s = document.createElement('script');
    s.textContent = 'window.__inline = true;';
    document.body.appendChild(s);
    const holder = document.createElement('div');
    holder.innerHTML = '<img src="data:image/gif;base64,AAAA" onerror="window.__handler = true">';
    document.body.appendChild(holder);
    // Written into the page as markup, as stored text shown unescaped would be.
    const frame = document.createElement('div');
    frame.innerHTML = '<a id="__probe" href="#" onclick="window.__handler = true; return false">x</a>';
    document.body.appendChild(frame);
    (document.getElementById('__probe') as HTMLElement).click();
    await new Promise<void>((resolve) => {
      const f = document.createElement('script');
      f.src = 'https://evil.example/x.js';
      f.onload = () => resolve();
      f.onerror = () => resolve();
      document.body.appendChild(f);
      setTimeout(resolve, 3000);
    });
    await new Promise((r) => setTimeout(r, 300));
    return { inline: w.__inline === true, handler: w.__handler === true, foreign: w.__foreign === true, violations };
  });
}

test('in a browser, the Admin Hub under the nonce policy: it loads and works at 375 and 1280 px with no policy violation; an injected script does not run', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const { page, problems, close } = await open(width, { signedIn: true });
    const res = (await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' }))!;
    assert.doesNotMatch(scriptSrc((await res.allHeaders())['content-security-policy']), /unsafe-inline/);
    // Its scripts ran: the hub is built in the browser, and reads the orders from the server.
    const nav = page.getByRole('navigation', { name: 'Admin sections' });
    await nav.waitFor();
    await nav.getByRole('button').first().waitFor();
    // The keyboard works: Tab reaches a control.
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY', `hub at ${width}: the keyboard reaches a control`);
    assert.equal(await overflow(page), false, `hub at ${width}: no sideways scroll`);
    assert.deepEqual(problems, [], `hub at ${width}`);

    const ran = await inject(page);
    assert.deepEqual({ inline: ran.inline, handler: ran.handler, foreign: ran.foreign }, { inline: false, handler: false, foreign: false }, `hub at ${width}: nothing injected runs`);
    assert.ok(ran.violations >= 3, `the browser refused each (${ran.violations})`);
    // And the hub goes on working afterwards.
    await nav.getByRole('button').first().click();
    await close();
  }
});

test('in a browser, the storefront’s per-request pages under the nonce policy: they work (language direction, tracking, product), Stripe.js can load, an injected script does not run', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    // The tracking link: the page's own scripts open Track Order and read the order from the server.
    const track = await open(width);
    const res = (await track.page.goto(`${server.base}${trackPath}`, { waitUntil: 'domcontentloaded' }))!;
    assert.doesNotMatch(scriptSrc((await res.allHeaders())['content-security-policy']), /unsafe-inline/);
    const dialog = track.page.getByRole('dialog').first();
    await dialog.waitFor();
    assert.equal(await overflow(track.page), false, `tracking at ${width}: no sideways scroll`);
    assert.deepEqual(track.problems, [], `tracking at ${width}`);
    const ran = await inject(track.page);
    assert.deepEqual({ inline: ran.inline, handler: ran.handler, foreign: ran.foreign }, { inline: false, handler: false, foreign: false }, `tracking at ${width}: nothing injected runs`);
    await track.close();

    // A product's page: it renders, with its JSON-LD (data, never run) in place.
    const product = await open(width);
    await product.page.goto(`${server.base}/p/${productId}`, { waitUntil: 'domcontentloaded' });
    await product.page.locator('h1').first().waitFor();
    assert.ok((await product.page.locator('script[type="application/ld+json"]').count()) >= 1, 'JSON-LD is in the page');
    // Hydrated: the bag button answers.
    await product.page.waitForFunction(() => Object.keys(document.body.firstElementChild ?? {}).some((k) => k.startsWith('__react')) || document.querySelector('button') !== null);
    assert.equal(await overflow(product.page), false, `product at ${width}: no sideways scroll`);
    assert.deepEqual(product.problems, [], `product at ${width}`);

    // Stripe.js (what checkout loads when card payments are on) is still allowed there, by host.
    await product.page.route('https://js.stripe.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.Stripe = function () { return {}; };' }));
    const stripe = await product.page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const s = document.createElement('script');
          s.src = 'https://js.stripe.com/v3/';
          s.onload = () => resolve(typeof (window as unknown as { Stripe?: unknown }).Stripe === 'function');
          s.onerror = () => resolve(false);
          document.head.appendChild(s);
        })
    );
    assert.equal(stripe, true, `product at ${width}: Stripe.js loads`);
    assert.deepEqual(product.problems, [], `product at ${width}, after Stripe.js`);
    await product.close();
  }

  // The language-direction script (inline, allowed by its hash) still runs before the page paints:
  // an Arabic visitor's terms page is right to left.
  const ctx = await browser.newContext({ viewport: { width: 375, height: 860 }, locale: 'ar-AE', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  // Before any of the page's other scripts: read at the first moment the document has a body.
  await page.addInitScript(() => {
    new MutationObserver((_, o) => {
      if (document.body) {
        (window as unknown as { __dirAtBody?: string }).__dirAtBody = document.documentElement.dir;
        o.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${server.base}/terms`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'ar-AE');
  assert.equal(await overflow(page), false, 'terms (Arabic) at 375: no sideways scroll');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('in a browser, the service worker still registers from a page under the nonce policy', { skip: skip || skipBrowser }, async () => {
  const { page, problems, close } = await open(1280, { sw: true });
  await page.goto(`${server.base}/p/${productId}`, { waitUntil: 'domcontentloaded' });
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  assert.equal(scope, `${server.base}/`);
  assert.deepEqual(problems, []);
  await close();
});

test('what remains, stated: on a kept page (the home page) the static policy still lets an inline script run; another site’s script is refused everywhere', { skip: skip || skipBrowser }, async () => {
  const { page, close } = await open(1280);
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.locator('h1, h2').first().waitFor();
  const ran = await inject(page);
  assert.equal(ran.foreign, false, 'a script from another site never runs');
  // The gap that is left (see src/lib/csp.ts): if this starts failing, the home page got a stricter policy; update this test and the note.
  assert.equal(ran.inline, true);
  await close();
});
