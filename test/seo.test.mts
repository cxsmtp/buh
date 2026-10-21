/**
 * Search (SEO): snippet text, structured data, festival gift pages by date (before the window,
 * live, after, switched off, forced), the home page's title following the live festival, the
 * sitemap and robots, overrides, the verification codes, IndexNow (off by default; on: one ping
 * through the stand-in sender, rate-limited, audited), the settings' validation, and SEO settings
 * coming back from a backup.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
process.env.NEXT_PUBLIC_APP_URL = 'https://beautifuluaehome.com';

const text = await import('@/lib/seo/text');
const seo = await import('@/lib/server/seo');
const settings = await import('@/lib/server/settings');
const products = await import('@/lib/server/products');
const indexNow = await import('@/lib/server/indexNow');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { addDays } = await import('@/lib/festivals/dates');
const backup = await import('@/lib/server/backup');

const BASE = 'https://beautifuluaehome.com';
/** Noon in Dubai on a calendar day. */
const at = (day: string) => new Date(`${day}T08:00:00Z`);

test('titles fit in 60 characters at a word; descriptions in 155 by whole sentences', () => {
  assert.equal(text.fitTitle('Jaipur Indigo Set', 'Beautiful UAE Home'), 'Jaipur Indigo Set | Beautiful UAE Home');
  const long = text.fitTitle('The Mughal Botanical Garden Hand-Carved Teak Block Printed Bed Sheet Set', 'Beautiful UAE Home');
  assert.ok(long.length <= 60, long);
  assert.ok(!long.includes('|'), 'the shop name gives way first');
  assert.ok('The Mughal Botanical Garden Hand-Carved Teak Block Printed Bed Sheet Set'.startsWith(long), 'cut at a whole word');
  const d = text.fitDescription('First sentence is here. Second sentence is a little longer than the first one was. ' + 'Third '.repeat(30));
  assert.ok(d.length <= 155);
  assert.equal(d, 'First sentence is here. Second sentence is a little longer than the first one was.');
  const one = text.fitDescription('word '.repeat(60));
  assert.ok(one.length <= 155 && one.endsWith('…'));
  assert.equal(text.plainText('**Bold** _it_ [link](https://x.y) # Head'), 'Bold it link Head');
});

test('verification codes: the content value only (the whole tag is accepted), safe characters only', () => {
  assert.equal(text.verificationCode('<meta name="google-site-verification" content="AbC-123_xyz9876" />'), 'AbC-123_xyz9876');
  assert.equal(text.verificationCode('  0123456789ABCDEF0123456789ABCDEF '), '0123456789ABCDEF0123456789ABCDEF');
  assert.equal(text.verificationCode(''), '');
  assert.equal(text.verificationCode('"><script>alert(1)</script>'), null);
  assert.equal(text.verificationCode('short'), null);
});

test('product JSON-LD: price per size from fils, stock per size, the SKU, no ratings; < cannot end the script', async () => {
  const [first] = products.listProducts();
  const p = products.updateProduct(first.id, { title: 'Test </script><b>Set', price: 199.9, profiles: first.profiles.map((s, i) => ({ ...s, priceDelta: i === 0 ? 40.1 : s.priceDelta })) });
  const data = seo.productJsonLd(p, BASE) as Record<string, unknown> & { offers: Array<Record<string, unknown>> };
  assert.equal(data['@type'], 'Product');
  assert.equal(data.offers[0].price, '240.00', '199.90 + 40.10 in fils');
  assert.equal(data.offers[0].priceCurrency, 'AED');
  assert.equal(data.offers[0].sku, `${p.sku}-${p.profiles[0].id.toUpperCase()}`);
  assert.equal(data.sku, p.sku);
  assert.equal(data.offers[0].availability, (p.stockBySize[p.profiles[0].id] ?? 0) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock');
  assert.equal(data.offers[0].priceValidUntil, undefined, 'never invented');
  assert.equal((data.offers[0].shippingDetails as { shippingDestination: { addressCountry: string } }).shippingDestination.addressCountry, 'AE');
  const json = seo.jsonLdString(data);
  assert.ok(!/aggregateRating|review/i.test(json), 'no ratings or reviews');
  assert.ok(!json.includes('</script>') && !json.includes('<'), 'escaped');
  assert.equal(JSON.parse(json).name, 'Test </script><b>Set', 'still the same data');

  products.updateProduct(p.id, { stockBySize: Object.fromEntries(p.profiles.map((s) => [s.id, 0])) });
  const sold = seo.productJsonLd(products.getProduct(p.id)!, BASE) as { offers: Array<{ availability: string }> };
  assert.ok(sold.offers.every((o) => o.availability === 'https://schema.org/OutOfStock'));
});

test('a festival page by date: waiting before its window, live from 45 days before until it ends, waiting again after', () => {
  const now = at('2026-10-20');
  const d = seo.festivalPageState('diwali', now)!;
  assert.ok(d.start && d.end);
  const start = d.start!;
  const end = d.end!;
  assert.equal(seo.festivalPageState('diwali', at(addDays(start, -46)))!.status, 'waiting');
  assert.equal(seo.festivalPageState('diwali', at(addDays(start, -45)))!.status, 'live');
  assert.equal(seo.festivalPageState('diwali', at(end))!.status, 'live');
  const after = seo.festivalPageState('diwali', at(addDays(end, 1)))!;
  assert.equal(after.status, 'waiting');
  assert.ok(after.start! > end, 'shows next year’s dates');
  assert.equal(after.priority, 0.5);
  assert.equal(seo.festivalPageState('diwali', at(start))!.priority, 0.9);
  // Remembrance days and days inside another festival have no page.
  assert.equal(seo.festivalPageState('commemoration-day', now), null);
  assert.equal(seo.festivalPageState('laylat-al-qadr', now), null);
  // Not every festival has one by default.
  assert.equal(seo.festivalPageState('uae-flag-day', now)!.status, 'off');
});

test('the owner can switch a festival page off, force it live, or switch on one that is off by default', async () => {
  const d = seo.festivalPageState('diwali', at('2026-10-20'))!;
  const outside = at(addDays(d.start!, -60));
  await settings.updateSettings('seo', { festivals: { diwali: { mode: 'off' } } });
  assert.equal(seo.festivalPageState('diwali', at(d.start!))!.status, 'off');
  await settings.updateSettings('seo', { festivals: { diwali: { mode: 'live' } } });
  assert.equal(seo.festivalPageState('diwali', outside)!.status, 'live');
  await settings.updateSettings('seo', { festivals: { 'uae-flag-day': { mode: 'auto' } } });
  assert.notEqual(seo.festivalPageState('uae-flag-day', at('2026-10-20'))!.status, 'off');
  assert.equal(seo.festivalPageState('diwali', outside)!.status, 'waiting', 'the festivals list is replaced as a whole');
  // Switched off in Settings → Festival themes: no page unless switched on here.
  await settings.updateSettings('seo', { festivals: {} });
  await settings.updateSettings('theme', { disabledFestivals: ['holi'] });
  assert.equal(seo.festivalPageState('holi', at('2026-10-20'))!.status, 'off');
  await settings.updateSettings('seo', { festivals: { holi: { mode: 'auto' } } });
  assert.notEqual(seo.festivalPageState('holi', at('2026-10-20'))!.status, 'off');
  await settings.updateSettings('theme', { disabledFestivals: [] });
  await settings.updateSettings('seo', { festivals: {} });
});

test('the home page title follows the live festival, and goes back to the everyday one', async () => {
  const d = seo.festivalPageState('diwali', at('2026-10-20'))!;
  const day = at(addDays(d.start!, -1));
  const first = seo.liveFestivalPages(day)[0];
  assert.equal(first.id, 'diwali', 'the nearest live festival leads');
  const home = seo.homeTexts(day);
  assert.match(home.title, /^Diwali gift bedsheets/);
  assert.ok(home.title.length <= 60, home.title);
  assert.match(home.description, /Diwali/);
  // A quiet day: with a 7-day lead, find a day no festival page is live.
  await settings.updateSettings('seo', { leadDays: 7 });
  let quiet: Date | null = null;
  for (let i = 0; i < 365 && !quiet; i++) {
    const t = at(addDays('2027-01-01', i));
    if (!seo.liveFestivalPages(t).length) quiet = t;
  }
  assert.ok(quiet, 'some day has no live festival');
  const everyday = seo.homeTexts(quiet!);
  assert.equal(everyday.festival, null);
  assert.doesNotMatch(everyday.title, /gift/i);
  // The owner's own title wins.
  await settings.updateSettings('seo', { home: { title: 'My own home title for Google' }, leadDays: 45 });
  assert.equal(seo.homeTexts(day).title, 'My own home title for Google');
  await settings.updateSettings('seo', { home: {} });
});

test('sitemap: home, categories, festival pages by season, products on sale; never hidden ones, /c, the hub or the APIs', async () => {
  const list = products.listProducts();
  const hidden = products.updateProduct(list[1].id, { active: false });
  const removed = products.setArchived(list[2].id, true);
  await settings.updateSettings('seo', { festivals: { christmas: { mode: 'off' } } });
  const day = at('2026-10-20');
  const entries = seo.sitemapEntries(BASE, day);
  const urls = entries.map((e) => e.url);
  assert.ok(urls.includes(`${BASE}/`));
  const onSale = products.listProducts();
  for (const c of settings.getSettings('catalog').categories) {
    // Found live: empty category pages were offered to Google. Only categories with products are listed.
    const has = onSale.some((p) => p.category === c.id);
    assert.equal(urls.includes(`${BASE}/shop/${c.id}`), has, c.id);
  }
  assert.ok(urls.includes(`${BASE}/gifts/diwali`));
  assert.ok(!urls.includes(`${BASE}/gifts/christmas`), 'switched off');
  assert.ok(!urls.includes(`${BASE}/gifts/commemoration-day`));
  assert.ok(!urls.includes(`${BASE}/gifts/uae-flag-day`), 'off by default');
  assert.ok(urls.includes(`${BASE}/p/${list[0].id}`));
  assert.ok(!urls.includes(`${BASE}/p/${hidden.id}`), 'hidden');
  assert.ok(!urls.includes(`${BASE}/p/${removed.id}`), 'removed');
  assert.ok(urls.every((u) => !/\/(c|hub|api|pay|invoice)\//.test(u) && !u.endsWith('/hub')));
  const diwali = entries.find((e) => e.url.endsWith('/gifts/diwali'))!;
  const live = seo.festivalPageState('diwali', day)!.status === 'live';
  assert.equal(diwali.priority, live ? 0.9 : 0.5);
  const later = seo.sitemapEntries(BASE, at(addDays(seo.festivalPageState('diwali', day)!.end!, 1))).find((e) => e.url.endsWith('/gifts/diwali'))!;
  assert.equal(later.priority, 0.5, 'between seasons: kept, lower');
  assert.ok(entries.find((e) => e.url.endsWith(`/p/${list[0].id}`))!.lastModified, 'products carry their last change');
  products.updateProduct(hidden.id, { active: true });
  products.setArchived(removed.id, false);
  products.updateProduct(removed.id, { active: true });
  await settings.updateSettings('seo', { festivals: {} });
});

test('robots.txt: the shop open, the APIs and private pages closed, the sitemap named; the hub never named', async () => {
  const robots = (await import('@/app/robots')).default;
  const r = await robots();
  const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
  assert.equal(rules.allow, '/');
  assert.deepEqual(rules.disallow, ['/api/', '/pay/', '/invoice/']);
  assert.equal(r.sitemap, `${BASE}/sitemap.xml`);
  assert.ok(!JSON.stringify(r).includes('hub'));
});

test('product titles and descriptions: automatic, or the owner’s own from the editor', () => {
  const [p] = products.listProducts();
  products.updateProduct(p.id, { title: 'Indigo Chevron Set', shortDescription: 'Soft cotton in indigo. Made by hand in Jaipur. ' + 'More words here. '.repeat(12) });
  let now = products.getProduct(p.id)!;
  assert.equal(seo.productTitle(now), `Indigo Chevron Set | ${seo.shopName()}`);
  assert.ok(seo.productDescription(now).length <= 155);
  assert.match(seo.productDescription(now), /^Soft cotton in indigo\. Made by hand in Jaipur\./);
  products.updateProduct(p.id, { seoTitle: '  Indigo chevron bedsheets\u0000 in Dubai ', seoDescription: 'My own <b>words</b> for Google.' });
  now = products.getProduct(p.id)!;
  assert.equal(seo.productTitle(now), 'Indigo chevron bedsheets in Dubai');
  assert.equal(seo.productDescription(now), 'My own words for Google.');
  assert.match(seo.productAlt(now), /^Indigo Chevron Set/);
  products.updateProduct(p.id, { seoTitle: '', seoDescription: '' });
  assert.equal(products.getProduct(p.id)!.seoTitle, undefined, 'empty: automatic again');
});

test('landing-page texts: defaults from the catalogue and Settings → Delivery; the owner’s words; Reset', async () => {
  const cat = seo.categoryPages()[0];
  const d = seo.categoryDefaults(cat);
  assert.match(d.title, new RegExp(cat.label));
  assert.ok(d.title.length <= 60);
  assert.match(d.description, /Dubai/);
  await settings.updateSettings('seo', { categories: { [cat.id]: { title: 'Bedsheets online in Dubai | Shop', intro: 'Our own intro.\nSecond line' } } });
  const t = seo.categoryTexts(cat);
  assert.equal(t.title, 'Bedsheets online in Dubai | Shop');
  assert.equal(t.intro, 'Our own intro. Second line', 'one line');
  assert.equal(t.description, d.description, 'the rest stays automatic');
  await settings.updateSettings('seo', { categories: { [cat.id]: {} } });
  assert.equal(seo.categoryTexts(cat).title, d.title, 'reset');
  const f = seo.festivalPageState('eid-al-adha', at('2026-10-20'))!;
  assert.equal(seo.festivalDefaults(f).h1, 'Eid al-Adha gifts: bedsheets and bed sets');
});

test('SEO settings are validated: an allow-list, lengths, safe codes, lead days', async () => {
  await assert.rejects(settings.updateSettings('seo', { somethingElse: 1 }), /Unexpected field/);
  await assert.rejects(settings.updateSettings('seo', { leadDays: 3 }), /from 7 to 90/);
  await assert.rejects(settings.updateSettings('seo', { googleVerification: 'bad code"><x' }), /content=/);
  await assert.rejects(settings.updateSettings('seo', { festivals: { diwali: { mode: 'sometimes' } } }), /automatic, off or always live/);
  await assert.rejects(settings.updateSettings('seo', { festivals: { diwali: { title: 'x'.repeat(500) } } }), /at most 70/);
  await assert.rejects(settings.updateSettings('seo', { home: { title: 'x', script: 'y' } }), /unexpected field/);
  await settings.updateSettings('seo', {
    googleVerification: '<meta name="google-site-verification" content="GoogleCode_123-abc" />',
    bingVerification: '0123456789ABCDEF0123456789ABCDEF',
    festivals: { 'not-a-festival': { title: 'x' }, 'commemoration-day': { mode: 'live' }, diwali: { title: 'Diwali gifts ‮ reversed' } },
  });
  const s = settings.getSettings('seo');
  assert.equal(s.googleVerification, 'GoogleCode_123-abc');
  assert.equal(s.bingVerification, '0123456789ABCDEF0123456789ABCDEF');
  assert.deepEqual(Object.keys(s.festivals), ['diwali'], 'unknown and remembrance days dropped');
  assert.equal(s.festivals.diwali.title, 'Diwali gifts reversed', 'control characters stripped');
  assert.equal(s.indexNow, false, 'IndexNow stays off unless switched on');
});

test('IndexNow: off by default (nothing sent); on: one ping through safeFetch’s stand-in, rate-limited, audited', async () => {
  await settings.updateSettings('seo', { indexNow: false });
  const sent: Array<{ url: string; body: string }> = [];
  indexNow._setIndexNowSender(async (url, body) => {
    sent.push({ url, body });
    return { status: 202, ok: true };
  });
  const off = await indexNow.pingIndexNow(['/p/x']);
  assert.equal(off.sent, false);
  assert.equal(sent.length, 0);

  await settings.updateSettings('seo', { indexNow: true });
  _clearAllRateLimits();
  const r = await indexNow.pingIndexNow(['/p/abc', '/p/abc', 'https://evil.example/x', '/gifts/diwali']);
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.indexnow.org/indexnow');
  const body = JSON.parse(sent[0].body);
  assert.equal(body.host, 'beautifuluaehome.com');
  assert.match(body.key, /^[a-f0-9]{32}$/);
  assert.equal(body.keyLocation, `${BASE}/indexnow-key.txt`);
  assert.deepEqual(body.urlList, [`${BASE}/p/abc`, `${BASE}/gifts/diwali`], 'own pages only, once each');
  assert.equal(indexNow.lastPings()[0].ok, true);
  const audit = fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  assert.ok(audit.some((e) => e.action === 'seo.indexnow_ping' && e.details.urls === 2));

  for (let i = 0; i < 25; i++) await indexNow.pingIndexNow([`/p/${i}`]);
  assert.equal(sent.length, 20, 'at most 20 pings an hour');
  const limited = await indexNow.pingIndexNow(['/p/late']);
  assert.equal(limited.reason, 'rate limited');

  // A festival page going live is told once.
  _clearAllRateLimits();
  const { pingNewlyLiveFestivals } = await import('@/lib/server/seoWatch');
  const d = seo.festivalPageState('diwali', at('2026-10-20'))!;
  const day = at(d.start!);
  const firstRun = await pingNewlyLiveFestivals(day);
  assert.ok(firstRun.includes('diwali'));
  assert.deepEqual(await pingNewlyLiveFestivals(day), [], 'once per season');
  indexNow._setIndexNowSender(null);
  await settings.updateSettings('seo', { indexNow: false });
});

test('SEO settings and the IndexNow key come back from a backup (and are in settings history)', async () => {
  await settings.updateSettings('seo', { googleVerification: 'BackupCode_12345', festivals: { diwali: { title: 'Kept in the backup' } } });
  const key = indexNow.indexNowKey();
  assert.ok(settings.settingsHistory().some((v) => v.key === 'seo'), 'earlier versions kept');
  const result = await backup.createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-seo-restore-'));
  fs.rmSync(target, { recursive: true });
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  const row = db.prepare("SELECT data FROM settings WHERE key = 'seo'").get() as { data: string };
  const kv = db.prepare("SELECT data FROM kv WHERE key = 'seo:indexnow-key'").get() as { data: string };
  db.close();
  const restored = JSON.parse(row.data);
  assert.equal(restored.googleVerification, 'BackupCode_12345');
  assert.equal(restored.festivals.diwali.title, 'Kept in the backup');
  assert.equal(JSON.parse(kv.data), key);
});
