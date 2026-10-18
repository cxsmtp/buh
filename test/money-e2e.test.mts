/**
 * BUH-02.10 against the real build: Money (expenses, reports, audit log). Every new admin route:
 * without the door the unknown address, without a session 401, cross-site 403, a bad body 400, a
 * wrong type 415, too big 413. Bills are served only to the hub (nosniff, sandboxed, no-store,
 * inline). The accountant's ZIP and the audit exports are themselves audited (who, what period).
 * In Chromium at 375 and 1280 px: add an expense with a photo of the bill, see it in the list, run
 * the month's report, download the ZIP, open the audit log; no sideways scroll; the keyboard works.
 * Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
const { readZip } = await import('@/lib/server/zip');

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;

const EMAIL = 'admin@beautifuluaehome.com';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PHOTO = fs.readFileSync('test/fixtures/sheet-indigo.png');

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Money-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(server.dataDir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
const today = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
async function answer(res: Response) {
  const body = await res.text();
  const headers = [...res.headers.entries()].filter(([k]) => k !== 'date').map(([k, v]) => `${k}: ${v}`).sort();
  return { status: res.status, body, headers };
}

async function newExpense(over: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/admin/expenses', { key: crypto.randomUUID(), date: today(), amount: '45.75', categoryId: 'courier', method: 'card', payee: 'Jeebly', ...over });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).expense as { id: string; version: number; amountFils: number };
}

test('every new admin route: no door → the unknown address; no session → 401; cross-site → 403; bad body → 400/415; too big → 413', { skip }, async () => {
  const e = await newExpense();
  const bill = (await (await api('POST', `/api/admin/expenses/${e.id}/bills`, { file: `data:image/png;base64,${PNG.toString('base64')}`, name: 'b.png' })).json()).bill as { id: string };
  const d = today();
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/api/admin/expenses'],
    ['POST', '/api/admin/expenses', { key: crypto.randomUUID(), date: d, amount: '1', categoryId: 'other', method: 'cash' }],
    ['GET', '/api/admin/expenses/categories'],
    ['POST', '/api/admin/expenses/categories', { name: 'Door test' }],
    ['GET', `/api/admin/expenses/${e.id}`],
    ['PATCH', `/api/admin/expenses/${e.id}`, { version: 1, note: 'x' }],
    ['DELETE', `/api/admin/expenses/${e.id}`, { reason: 'x' }],
    ['POST', `/api/admin/expenses/${e.id}/bills`, { file: `data:image/png;base64,${PNG.toString('base64')}` }],
    ['GET', `/api/admin/expenses/${e.id}/bills/${bill.id}`],
    ['DELETE', `/api/admin/expenses/${e.id}/bills/${bill.id}`, { reason: 'x' }],
    ['GET', `/api/admin/reports?from=${d}&to=${d}`],
    ['PUT', '/api/admin/reports/settings', { yearStartMonth: 1 }],
    ['GET', `/api/admin/reports/export?from=${d}&to=${d}`],
    ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/audit/export?format=csv'],
  ];
  const unknown = await answer(await rawFetch(`${server.base}/api/no-such-${crypto.randomBytes(4).toString('hex')}`, { headers: { cookie } }));
  for (const [method, url, body] of routes) {
    const init = (headers: Record<string, string>) => ({ method, headers: { 'content-type': 'application/json', origin: server.base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    // No door (even signed in): exactly the unknown address.
    assert.deepEqual(await answer(await rawFetch(`${server.base}${url}`, init({ cookie }))), unknown, `${method} ${url} without the door`);
    // The door, no session.
    const out = await rawFetch(`${server.base}${url}`, init({ cookie: server.door }));
    assert.equal(out.status, 401, `${method} ${url} without a session`);
    await out.arrayBuffer();
    // Cross-site (changes, and the downloads).
    if (method !== 'GET' || /export/.test(url)) {
      const res = await api(method, url, body, { origin: 'https://evil.example' });
      assert.equal(res.status, 403, `${method} ${url} cross-site`);
      await res.arrayBuffer();
    }
  }
  // Bodies: an unexpected field, a wrong amount, a wrong type, too big.
  assert.equal((await api('POST', '/api/admin/expenses', { key: crypto.randomUUID(), date: d, amount: '1', categoryId: 'other', method: 'cash', isAdmin: true })).status, 400);
  assert.equal((await api('POST', '/api/admin/expenses', { key: crypto.randomUUID(), date: d, amount: '1.234', categoryId: 'other', method: 'cash' })).status, 400);
  assert.equal((await api('POST', '/api/admin/expenses', { key: crypto.randomUUID(), date: d, amount: '1', categoryId: 'nope', method: 'cash' })).status, 400);
  assert.equal((await api('POST', '/api/admin/expenses', { date: d, amount: '1', categoryId: 'other', method: 'cash' })).status, 400, 'no key');
  assert.equal((await api('POST', '/api/admin/expenses', '{not json')).status, 400);
  assert.equal((await api('POST', '/api/admin/expenses', 'a=1', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await api('POST', '/api/admin/expenses', { key: crypto.randomUUID(), note: 'x'.repeat(9000) })).status, 413);
  assert.equal((await api('POST', `/api/admin/expenses/${e.id}/bills`, { file: `data:application/pdf;base64,${Buffer.alloc(11 * 1024 * 1024).toString('base64')}` })).status, 413);
  assert.equal((await api('PATCH', `/api/admin/expenses/${e.id}`, { version: 1, removed_at: null })).status, 400);
  assert.equal((await api('PUT', '/api/admin/reports/settings', { yearStartMonth: 13 })).status, 400);
  assert.equal((await api('GET', '/api/admin/reports?from=2026-09-30&to=2026-09-01')).status, 400);
  assert.equal((await api('GET', '/api/admin/audit/export?format=xml')).status, 400);
  assert.equal((await api('GET', '/api/admin/expenses/EXP-NOPE-XXXXXX')).status, 404);
  // Errors say nothing internal.
  const err = await (await api('POST', '/api/admin/expenses', { key: crypto.randomUUID(), date: d, amount: '1', categoryId: 'other', method: 'cash', payee: 7 })).json();
  assert.equal(err.message, 'Paid to must be text.');
});

test('a bill is served only to the hub: its own type, nosniff, no-script policy, never cached, shown inline', { skip }, async () => {
  const e = await newExpense();
  const res = await api('POST', `/api/admin/expenses/${e.id}/bills`, { file: `data:image/png;base64,${PHOTO.toString('base64')}`, name: 'photo.png' });
  assert.equal(res.status, 201);
  const { bill } = await res.json();
  const got = await api('GET', bill.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('cache-control') || '', /no-store/);
  // The bill's own policy (next.config.ts and the route agree): the image only, sandboxed, never framed.
  assert.equal(got.headers.get('content-security-policy'), "default-src 'none'; img-src 'self'; frame-ancestors 'none'; sandbox");
  assert.match(got.headers.get('content-disposition') || '', /^inline; filename="EXP-/);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PHOTO, 'a PNG without text chunks is stored byte for byte');
  assert.equal((await rawFetch(`${server.base}${bill.url}`)).status, 404, 'not without the door');
  assert.ok(fs.existsSync(path.join(server.dataDir, 'expenses', `${bill.id}.png`)));
  // A PDF is downloaded, not shown (browsers won't open a PDF under a sandbox policy; a PDF can carry script).
  const pdf = (await (await api('POST', `/api/admin/expenses/${e.id}/bills`, { file: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64')}`, name: 'bill.pdf' })).json()).bill;
  const gotPdf = await api('GET', pdf.url);
  assert.equal(gotPdf.status, 200);
  assert.equal(gotPdf.headers.get('content-type'), 'application/pdf');
  assert.match(gotPdf.headers.get('content-disposition') || '', /^attachment; filename="EXP-.*\.pdf"$/);
  assert.match(gotPdf.headers.get('content-security-policy') || '', /sandbox/);
  await gotPdf.arrayBuffer();
});

test('in Chromium, under the policy actually sent: a photo of a bill opens in its own tab and shows; a PDF downloads', { skip: skip || skipBrowser }, async () => {
  const e = await newExpense({ payee: 'Tab test' });
  const photo = (await (await api('POST', `/api/admin/expenses/${e.id}/bills`, { file: `data:image/png;base64,${PHOTO.toString('base64')}`, name: 'p.png' })).json()).bill;
  const pdf = (await (await api('POST', `/api/admin/expenses/${e.id}/bills`, { file: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n').toString('base64')}`, name: 'p.pdf' })).json()).bill;
  const ctx = await browser.newContext({ acceptDownloads: true });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  // Through the private link first (it sets the door cookie), as the owner's browser has.
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  const res = await page.goto(`${server.base}${photo.url}`);
  assert.equal(res!.status(), 200);
  assert.match((await res!.allHeaders())['content-security-policy'] ?? '', /sandbox/);
  const size = await page.evaluate(() => {
    const img = document.querySelector('img');
    return img ? [img.naturalWidth, img.naturalHeight] : null;
  });
  assert.ok(size && size[0] > 0 && size[1] > 0, `the photo shows (${JSON.stringify(size)})`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.goto(`${server.base}${pdf.url}`).catch(() => null)]);
  assert.match(download.suggestedFilename(), /\.pdf$/);
  await ctx.close();
});

test('in Chromium: a bill that fails to upload, the amount then corrected, Save again: the one expense is changed (not lost, not doubled)', { skip: skip || skipBrowser }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 860 }, hasTouch: true });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  let failNext = true;
  await page.route('**/api/admin/expenses/*/bills', async (route) => {
    if (failNext && route.request().method() === 'POST') {
      failNext = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Try again.' }) });
    } else await route.continue();
  });
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await openAdminSection(page, /^Money/);
  await page.getByRole('heading', { name: 'Expenses' }).waitFor();
  await page.getByRole('button', { name: 'Add expense' }).click();
  const form = page.getByTestId('expense-form');
  await form.waitFor();
  const payee = `Retry Co ${Date.now()}`;
  await form.getByLabel('Amount (AED)').fill('10.00');
  await form.getByLabel('Paid to').fill(payee);
  await form.getByTestId('bill-input').setInputFiles({ name: 'retry.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
  await form.getByRole('button', { name: 'Save expense' }).click();
  await form.getByText(/The expense is saved, but a bill could not be attached/).waitFor();
  // The owner notices the amount was wrong, fixes it, and saves again (the bill goes this time).
  await form.getByLabel('Amount (AED)').fill('12.50');
  await form.getByRole('button', { name: 'Save expense' }).click();
  await page.getByText('Expense saved.').waitFor();
  const list = await (await api('GET', '/api/admin/expenses')).json();
  const mine = (list.expenses as Array<{ payee: string; amountFils: number; version: number; bills: unknown[] }>).filter((x) => x.payee === payee);
  assert.equal(mine.length, 1, 'one expense');
  assert.equal(mine[0].amountFils, 1250, 'the corrected amount was saved');
  assert.equal(mine[0].version, 2);
  assert.equal(mine[0].bills.length, 1);
  await ctx.close();
});

test('the accountant\'s ZIP over HTTP: a ZIP with the period\'s files and bills; who exported which period is audited first', { skip }, async () => {
  const e = await newExpense({ amount: '12.30', categoryId: 'packaging' });
  await api('POST', `/api/admin/expenses/${e.id}/bills`, { file: `data:image/png;base64,${PNG.toString('base64')}` });
  const d = today();
  const before = auditEntries().length;
  const res = await api('GET', `/api/admin/reports/export?from=${d}&to=${d}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="accounts_${d}_to_${d}.zip"`);
  const zip = readZip(Buffer.from(await res.arrayBuffer()));
  for (const f of ['README.txt', 'summary.html', 'summary.csv', 'sales.csv', 'order-items.csv', 'expenses.csv', 'audit-log.jsonl', 'audit-check.txt']) assert.ok(zip.has(f), f);
  assert.ok([...zip.keys()].includes(`bills/${d}_packaging_12.30_${e.id}.png`));
  const exported = auditEntries().slice(before).find((x) => x.action === 'report.exported')!;
  assert.deepEqual([exported.details.by, exported.details.from, exported.details.to], [EMAIL, d, d]);
  // The export's own entry is in the exported log.
  assert.ok(zip.get('audit-log.jsonl')!.toString().includes('"action":"report.exported"'));
  // The temporary file is gone once sent.
  for (let i = 0; i < 50 && fs.readdirSync(path.join(server.dataDir, 'exports')).length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(fs.readdirSync(path.join(server.dataDir, 'exports')), []);
  // The audit log viewer and its export (also audited).
  const page = await (await api('GET', `/api/admin/audit?action=expense.&order=${e.id}`)).json();
  assert.ok(page.total >= 2 && page.entries.every((x: { details: { expenseId: string } }) => x.details.expenseId === e.id));
  assert.equal(page.verification.ok, true);
  assert.match(page.verificationText[0], /^The log is intact/);
  const csv = await api('GET', `/api/admin/audit/export?format=csv&order=${e.id}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') || '', /^text\/csv/);
  const csvBytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 with a BOM');
  assert.ok(csvBytes.subarray(3).toString().startsWith('at_utc,'));
  assert.ok(auditEntries().some((x) => x.action === 'audit.exported' && x.details.by === EMAIL && x.details.format === 'csv'));
});

async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}

for (const width of [375, 1280]) {
  test(`at ${width}px: add an expense with a photo of the bill, see it, run the month's report, download the ZIP, open the audit log`, { skip: skip || skipBrowser }, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800, acceptDownloads: true });
    const [name, value] = cookie.split('=');
    await ctx.addCookies([{ name, value, url: server.base }]);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(page, /^Money/);
    await page.getByRole('heading', { name: 'Expenses' }).waitFor();
    assert.deepEqual(await overflow(page), [], 'expenses: no sideways scroll');

    // The keyboard reaches "Add expense" and opens the form with Enter.
    const add = page.getByRole('button', { name: 'Add expense' });
    await add.focus();
    await page.keyboard.press('Enter');
    const form = page.getByTestId('expense-form');
    await form.waitFor();
    const payee = `Packaging Co ${width}`;
    await form.getByLabel('Amount (AED)').fill('0.10');
    await form.getByLabel('Amount (AED)').press('Tab');
    await form.getByLabel('Category').selectOption({ label: 'Packaging' });
    await form.getByLabel('Paid to').fill(payee);
    await form.getByLabel('Card').check();
    await form.getByTestId('bill-input').setInputFiles({ name: 'bill.png', mimeType: 'image/png', buffer: PHOTO });
    await form.getByText('bill.png').waitFor();
    assert.deepEqual(await overflow(page), [], 'the form: no sideways scroll');
    await form.getByRole('button', { name: 'Save expense' }).click();
    await page.getByText('Expense saved.').waitFor();
    const item = page.getByTestId('expense-item').filter({ hasText: payee });
    await item.waitFor();
    assert.equal(await item.getByTestId('expense-amount').innerText(), 'AED 0.10');
    const billLink = item.getByRole('link', { name: /Bill 1/ });
    const href = (await billLink.getAttribute('href'))!;
    const bill = await api('GET', href);
    assert.equal(bill.status, 200);
    assert.equal(bill.headers.get('content-type'), 'image/jpeg', 'the photo was re-encoded in the browser (no EXIF)');
    const bytes = Buffer.from(await bill.arrayBuffer());
    assert.ok(!bytes.includes(Buffer.from('Exif')));
    assert.deepEqual(await overflow(page), [], 'the list: no sideways scroll');

    // The month's report, then the ZIP.
    await page.getByRole('button', { name: 'Reports' }).click();
    await page.getByTestId('report-expenses').waitFor();
    await page.getByTestId('vat-notice').waitFor();
    assert.equal(await page.getByTestId('vat-notice').getAttribute('data-level'), 'ok');
    assert.deepEqual(await overflow(page), [], 'reports: no sideways scroll');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-zip').click()]);
    assert.match(download.suggestedFilename(), /^accounts_\d{4}-\d{2}-01_to_\d{4}-\d{2}-\d{2}\.zip$/);
    const zip = readZip(fs.readFileSync((await download.path())!));
    assert.ok([...zip.keys()].some((f) => f.startsWith('bills/') && f.includes('_packaging_0.10_') && f.endsWith('.jpg')), [...zip.keys()].join(', '));
    assert.ok(zip.get('expenses.csv')!.toString().includes(payee));

    // The audit log: intact, with the expense in it.
    await page.getByRole('button', { name: 'Audit log' }).click();
    await page.getByTestId('audit-status').filter({ hasText: 'The log is intact' }).waitFor();
    await page.getByTestId('audit-entry').filter({ hasText: 'report.exported' }).first().waitFor();
    await page.getByLabel('What').selectOption('expense.created');
    await page.getByRole('button', { name: 'Show' }).click();
    await page.getByTestId('audit-entry').first().filter({ hasText: 'expense.created' }).waitFor();
    assert.deepEqual(await overflow(page), [], 'audit: no sideways scroll');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
