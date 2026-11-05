/**
 * The Arabic shop (BUH-02.36.00): the words for each language, the product's Arabic fields, the
 * "Translate to Arabic" helper and the Terms & Conditions. The pages themselves: arabic-e2e.test.mts.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { makePng } from './fixtures/png.mjs';

tempDataDir();
const settings = await import('@/lib/server/settings');
const ai = await import('@/lib/server/aiWriting');
const products = await import('@/lib/server/products');
const { saveImageDataUrl } = await import('@/lib/server/images');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { matchesSearch } = await import('@/lib/catalogFilter');
const { productTitle, productShort, productDescription } = await import('@/lib/i18n/product');
const { fill } = await import('@/lib/i18n');
const { TERMS } = await import('@/lib/terms');

const ANTHROPIC = 'sk-ant-api03-TESTKEY-abcdefghijklmnopqrstuvwxyz0123456789-WXYZ';
const PHOTO = makePng(64, 64, (x, y) => ((x + y) % 16 < 8 ? [47, 63, 122] : [246, 244, 238]));
const PHOTO_URL = `data:image/png;base64,${PHOTO.toString('base64')}`;

let sent: string[] = [];
let answer: unknown = { titleAr: 'طقم سرير بنقشة شيفرون نيلية', shortDescriptionAr: 'شيفرون نيلي مطبوع يدويًا.', descriptionAr: 'سطر أول\n\nسطر ثانٍ' };

beforeEach(async () => {
  _clearAllRateLimits();
  sent = [];
  ai._setAnthropicTransport(async (body) => {
    const b = JSON.parse(body) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    sent.push(b.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
    return { status: 200, ok: true, data: { content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }], stop_reason: 'end_turn' } };
  });
  await settings.updateSettings('ai', { provider: 'anthropic', anthropicApiKey: ANTHROPIC, enabled: true, model: 'claude-sonnet-5-5' });
});
afterEach(() => ai._setAnthropicTransport(null));

const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? -1);

test('Translate to Arabic: the English words and the photo go to the writer; the answer is cut to each field; nothing is saved', async () => {
  const r = await ai.translateProduct({ image: PHOTO_URL, title: 'Indigo Chevron Bed Set', shortDescription: 'Hand-stamped chevrons.', description: 'Line one\nLine two' }, 'owner@s.t');
  assert.equal(r.titleAr, 'طقم سرير بنقشة شيفرون نيلية');
  assert.equal(r.descriptionAr, 'سطر أول\n\nسطر ثانٍ');
  assert.match(sent[0], /"Indigo Chevron Bed Set"/);
  assert.match(sent[0], /invent no facts/);
  // Too long: cut to the field's limit.
  answer = { titleAr: 'ا'.repeat(500), shortDescriptionAr: 'ب'.repeat(900), descriptionAr: 'ج'.repeat(9000) };
  const long = await ai.translateProduct({ image: PHOTO_URL, title: 'Set', shortDescription: 's', description: 'd' }, 'owner@s.t');
  assert.equal(long.titleAr.length, 160);
  assert.equal(long.shortDescriptionAr.length, 300);
  assert.equal(long.descriptionAr.length, 4000);
  // No English short or full description: none in Arabic either (the model can't make one up).
  answer = { titleAr: 'طقم', shortDescriptionAr: 'مختلق', descriptionAr: 'مختلق' };
  const bare = await ai.translateProduct({ image: PHOTO_URL, title: 'Set' }, 'owner@s.t');
  assert.deepEqual([bare.shortDescriptionAr, bare.descriptionAr], ['', '']);
  assert.equal(products.listProducts({ includeHidden: true }).some((p) => p.titleAr === 'طقم'), false);
});

test('Translate to Arabic: unknown fields, no name, no photo or a broken answer are refused; no key means AI is off', async () => {
  assert.equal(await status(ai.translateProduct({ image: PHOTO_URL, title: 'Set', price: 1 }, 'o@s.t')), 400);
  assert.equal(await status(ai.translateProduct({ image: PHOTO_URL, title: '  ' }, 'o@s.t')), 400);
  assert.equal(await status(ai.translateProduct({ title: 'Set' }, 'o@s.t')), 400);
  answer = 'not json';
  assert.equal(await status(ai.translateProduct({ image: PHOTO_URL, title: 'Set' }, 'o@s.t')), 502);
  answer = { titleAr: '' };
  assert.equal(await status(ai.translateProduct({ image: PHOTO_URL, title: 'Set' }, 'o@s.t')), 502);
  await settings.updateSettings('ai', { enabled: false });
  assert.equal(await status(ai.translateProduct({ image: PHOTO_URL, title: 'Set' }, 'o@s.t')), 409);
});

test('a product keeps its Arabic name and descriptions: checked on save, kept when not sent, cleared when sent empty; the shop shows them in Arabic and finds them in search', () => {
  const img = saveImageDataUrl(PHOTO_URL);
  const king = settings.getSettings('catalog').sizes.filter((s) => s.id === 'king');
  const base = { title: 'Indigo Set', shortDescription: 'Blue chevrons.', description: 'Soft cotton.', category: 'bedsheets', price: 300, featuredImage: img, galleryImages: [], profiles: king, defaultProfileId: 'king', stockBySize: { king: 1 } };
  const made = products.createProduct({ ...base, titleAr: '  طقم نيلي  ', shortDescriptionAr: 'شيفرون أزرق.', descriptionAr: 'قطن ناعم.' });
  assert.equal(made.titleAr, 'طقم نيلي');
  // Kept when an older screen saves without them.
  const kept = products.updateProduct(made.id, { ...base });
  assert.equal(kept.titleAr, 'طقم نيلي');
  assert.equal(kept.descriptionAr, 'قطن ناعم.');
  assert.throws(() => products.updateProduct(made.id, { ...base, titleAr: 'ا'.repeat(161) }), /Arabic name/);
  // Shown for Arabic, English otherwise (and when empty).
  assert.equal(productTitle(kept, 'ar'), 'طقم نيلي');
  assert.equal(productTitle(kept, 'en'), 'Indigo Set');
  assert.equal(productShort(kept, 'ar'), 'شيفرون أزرق.');
  assert.equal(productDescription(kept, 'ar'), 'قطن ناعم.');
  assert.ok(matchesSearch(kept, 'نيلي'));
  assert.ok(matchesSearch(kept, 'indigo'));
  const cleared = products.updateProduct(made.id, { ...base, titleAr: '', shortDescriptionAr: '', descriptionAr: '' });
  assert.equal(cleared.titleAr, undefined);
  assert.equal(productTitle(cleared, 'ar'), 'Indigo Set');
});

test('fill: placeholders are replaced, unknown ones left', () => {
  assert.equal(fill('Picture {n} of {count}', { n: 2, count: 5 }), 'Picture 2 of 5');
  assert.equal(fill('{x} stays', {}), '{x} stays');
});

test('Terms: every section in English and Arabic, paragraph for paragraph, the same placeholders; no returns for change of mind, the faulty-item remedy UAE law requires, the governing law', () => {
  const ids = TERMS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['returns', 'faulty', 'custom', 'liability', 'privacy', 'law', 'delivery', 'prices', 'force']) assert.ok(ids.includes(id), id);
  for (const s of TERMS) {
    assert.ok(s.title.en && s.title.ar, s.id);
    assert.equal(s.body.en.length, s.body.ar.length, s.id);
    for (let i = 0; i < s.body.en.length; i++) {
      const vars = (t: string) => (t.match(/\{[a-z]+\}/g) ?? []).sort().join();
      assert.equal(vars(s.body.ar[i]), vars(s.body.en[i]), `${s.id} #${i}`);
      assert.match(s.body.ar[i], /[؀-ۿ]/, `${s.id} #${i} is Arabic`);
    }
  }
  const text = (id: string) => TERMS.find((s) => s.id === id)!.body.en.join(' ');
  assert.match(text('returns'), /no returns|not accept returns/i);
  assert.match(text('returns'), /hygiene/i);
  assert.match(text('faulty'), /48 hours/);
  assert.match(text('liability'), /15 of 2020/);
  assert.match(text('law'), /United Arab Emirates|UAE/);
});
