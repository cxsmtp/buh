/**
 * Reported: tapping a chat in the Admin Hub showed "Something went wrong… i is not a function".
 * Newer Chrome returns a Promise from scrollIntoView; the chat view's effect returned that value,
 * and React called it as a clean-up function. Here the browser is made to behave like that Chrome.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';

let pw: typeof import('playwright') | null = null;
try {
  pw = await import('playwright');
} catch {
  pw = null;
}
const skip = !hasBuild || !pw;
let server: RunningServer;
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer();
  const h = { 'content-type': 'application/json', origin: server.base };
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Chat-Owner-Pass-123' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  for (const m of ['I want to talk to a person', 'what sizes do you have?']) {
    assert.equal((await fetch(`${server.base}/api/chat`, { method: 'POST', headers: h, body: JSON.stringify({ message: m }) })).status, 200);
  }
});
after(() => server?.stop());

test('no effect returns a value: an effect written as an expression can return something React then calls', () => {
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/use(Layout)?Effect\(\(\) =>\s*[^\s{]/.test(line)) offenders.push(`${p}:${i + 1}`);
        });
      }
    }
  };
  walk('src');
  assert.deepEqual(offenders, []);
});

test('Admin Hub chats open on a phone whose browser returns a Promise from scrollIntoView (newer Chrome)', { skip }, async () => {
  const browser = await pw!.chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => {
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args: Parameters<typeof original>) {
        original.apply(this, args);
        return Promise.resolve() as unknown as void;
      };
    });
    const [n, v] = cookie.split('=');
    await ctx.addCookies([{ name: n, value: v, url: server.base }]);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: /^Chats/ }).tap();
    for (let i = 0; i < 2; i++) {
      await page.locator('main button', { hasText: 'Customer' }).nth(i).tap();
      await page.getByRole('textbox', { name: 'Your reply' }).waitFor();
      assert.equal(await page.getByText('Something went wrong in the Admin Hub').count(), 0, `chat ${i + 1} opens`);
      await page.getByRole('button', { name: 'Back to the list' }).tap();
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
  }
});
