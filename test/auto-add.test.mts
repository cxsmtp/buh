/**
 * Pictures from numbered angles, and Quick add (src/lib/server/autoAdd.ts), with Google replaced by
 * a stand-in:
 * - the owner's prompt with "1. … 2. … 3. …" becomes three requests, one after another, each asking
 *   for ONE photograph from its angle (the list is never sent: the service drew all three in one
 *   collage); the rest of the prompt goes with every one; the first picture goes with the next ones;
 * - AI pictures go first and the owner's photo last (or after it, when the owner chooses);
 * - Quick add: the product is saved at once (hidden), then written, pictured and published in the
 *   background; Google's "wait" is waited out without the owner; a restart keeps the pictures
 *   already paid for; a double tap adds one product; one copy of the shop works at a time.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { bedroomPng, chunk, makePng } from './fixtures/png.mjs';

tempDataDir();
const settings = await import('@/lib/server/settings');
const gemini = await import('@/lib/server/gemini');
const stage = await import('@/lib/server/stagePhoto');
const staging = await import('@/lib/staging');
const auto = await import('@/lib/server/autoAdd');
const products = await import('@/lib/server/products');
const { saveImageDataUrl } = await import('@/lib/server/images');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { kvGet, kvSet } = await import('@/lib/server/kv');

// Built at run time: a key-shaped literal would trip secret scanners.
const KEY = ['AIza', 'Sy', 'TESTKEY-abcdefghijklmnopqrstu-Q9xZ'].join('');
const OWNER = 'owner@shop.test';

/** The owner's own prompt, as pasted in Settings → AI pictures (it had been cut at 1,000 characters). */
const PROMPT =
  'A professional, high-resolution (2k, ultra-sharp detail) e-commerce product photograph of the attached bedsheet set dressed on a king-size bed in an elegant, luxury bedroom. Output exactly three individual, separate full-frame images (not a collage or split screen) from three different angles: 1. Straight-on eye-level view centered on the made bed; 2. 45-degree three-quarter view showing the mattress depth and side drape; 3. High diagonal angle from the foot of the bed looking across the surface. Requirements across all images: * Complementary Styling: The bedroom wall colors, headboard fabric, flooring, and minimalist nightstands must be automatically chosen in tones that perfectly complement and enhance the primary and secondary colors of the uploaded bedsheet. * Identical Setting: The room setup, bed frame, headboard, lighting, and nightstands must remain identical across all views. * Clean Setup: Exactly two matching pillows propped neatly against the headboard; nothing extra on the bed, no throws or decorative cushions.';

let made = 0;
const fresh = () => {
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(2835 + ++made, 0);
  phys.writeUInt32BE(2835, 4);
  phys[8] = 1;
  return bedroomPng(160, 200, [chunk('pHYs', phys)]);
};
const SUGGESTION = { title: 'Indigo Garden Hand Block Set', shortDescription: 'Hand-stamped indigo florals on a soft white ground.', design: 'Indigo florals on white.', comfort: 'Soft and cool to sleep on.', closing: 'A calm bedroom favourite.', highlights: ['Indigo florals', 'White ground', 'Calm look'], colors: [{ name: 'Indigo', hex: '#3F4A8A' }], weave: 'percale', motif: 'Hand block floral' };

interface Sent {
  path: string;
  body: { contents: Array<{ parts: Array<{ text?: string; inlineData?: unknown }> }> };
}
let sent: Sent[] = [];
let answer: (req: Sent) => { status: number; data: unknown } = () => ({ status: 200, data: null });
const pictureCalls = () => sent.filter((s) => s.path.includes('image'));
const promptOf = (s: Sent) => s.body.contents[0].parts[0].text ?? '';
const imagesOf = (s: Sent) => s.body.contents[0].parts.filter((p) => p.inlineData).length;

const ok = (data: unknown) => ({ status: 200, data });
const picture = () => ok({ candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: fresh().toString('base64') } }] }, finishReason: 'STOP' }] });
const text = () => ok({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(SUGGESTION) }] }, finishReason: 'STOP' }] });

beforeEach(async () => {
  _clearAllRateLimits();
  sent = [];
  answer = (req) => (req.path.includes('image') ? picture() : text());
  gemini._setGeminiTransport(async (req) => {
    const s: Sent = { path: req.path, body: req.body ? JSON.parse(req.body) : null };
    sent.push(s);
    const a = answer(s);
    return { ...a, ok: a.status >= 200 && a.status < 300 };
  });
  auto._setSleep(async () => undefined);
  kvSet(auto.JOBS_KEY, []);
  kvSet('autoai:lease', { by: '', until: 0 });
  await settings.updateSettings('ai', { provider: 'gemini', geminiApiKey: KEY, geminiModel: 'gemini-3.1-pro', geminiImageModel: 'gemini-3.1-flash-image', enabled: true });
  await settings.updateSettings('aiPictures', { look: PROMPT, autoCreate: true, photoOrder: 'styled-first' });
});
afterEach(() => {
  gemini._setGeminiTransport(null);
  auto._setSleep(null);
});

const photo = () => ({ url: saveImageDataUrl(`data:image/png;base64,${makePng(90 + (made % 7), 110, (x, y) => ((x * 3 + y + made) % 20 < 9 ? [120, 30, 40] : [240, 236, 230])).toString('base64')}`) });

test('the owner’s prompt: three numbered angles become three pictures; the room and the requirements go with each; the 3,000-character prompt is kept whole', async () => {
  const { shared, angles } = staging.splitAngles(PROMPT);
  assert.deepEqual(angles, ['Straight-on eye-level view centered on the made bed', '45-degree three-quarter view showing the mattress depth and side drape', 'High diagonal angle from the foot of the bed looking across the surface']);
  assert.match(shared, /king-size bed in an elegant, luxury bedroom\./);
  assert.match(shared, /Identical Setting/);
  assert.match(shared, /no throws or decorative cushions/, 'the end of the prompt is no longer cut off');
  assert.doesNotMatch(shared, /three individual|1\. Straight/, 'the list and its lead-in are not sent');
  assert.equal(settings.getSettings('aiPictures').look.length, PROMPT.length);
  assert.ok(PROMPT.length > 1000);
  // Prompts without numbered angles are left as they are.
  assert.deepEqual(staging.splitAngles('Warm 2k light, 300 TC look, soft shadows.').angles, []);
  assert.deepEqual(stage.stagingStatus().angles.map((a) => a.n), [1, 2, 3]);
});

test('the studio: one request per angle, ONE photograph each, never the list; the first picture goes with the next so the room stays the same', async () => {
  const { url } = photo();
  const imageId = url.replace('/api/images/', '');
  const first = await stage.stagePhoto({ imageId, angle: 1 }, OWNER);
  const second = await stage.stagePhoto({ imageId, angle: 2, sameRoom: first.url }, OWNER);
  const calls = pictureCalls();
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const p = promptOf(c);
    assert.match(p, /ONE photograph from this one camera angle only/);
    assert.match(p, /never a collage, grid, split screen/);
    assert.doesNotMatch(p, /1\. Straight-on|2\. 45-degree|exactly three/, 'the numbered list is never sent');
    assert.match(p, /Identical Setting/);
  }
  assert.match(promptOf(calls[0]), /Straight-on eye-level view/);
  assert.doesNotMatch(promptOf(calls[0]), /45-degree/);
  assert.match(promptOf(calls[1]), /45-degree three-quarter view/);
  assert.equal(imagesOf(calls[0]), 1, 'the product photo only');
  assert.equal(imagesOf(calls[1]), 2, 'the product photo and the first picture');
  assert.match(promptOf(calls[1]), /same room, bed frame, headboard/);
  assert.notEqual(first.url, second.url);
  // Only angles that are in the prompt, and only pictures this feature made as "same room".
  await assert.rejects(stage.stagePhoto({ imageId, angle: 4 }, OWNER), /not in your prompt/);
  await assert.rejects(stage.stagePhoto({ imageId, angle: 2, sameRoom: url }, OWNER), /no longer stored/);
});

test('AI pictures first and the owner’s photo last (the default), or after the owner’s photo', () => {
  const made = { 'a.png': { source: 'p.png' }, 'b.png': { source: 'p.png' }, 'c.png': { source: 'p.png' } };
  const own = ['/api/images/p.png', '/api/images/q.png'];
  const add = ['/api/images/a.png', '/api/images/b.png', '/api/images/c.png'];
  assert.deepEqual(stage.withStyledPhotos(own, add, made, 'styled-first').photos, [...add, ...own]);
  assert.deepEqual(stage.withStyledPhotos(own, add, made, 'photo-first').photos, ['/api/images/p.png', ...add, '/api/images/q.png']);
  // Added again: nothing repeated; more AI pictures go after the ones already there.
  const again = stage.withStyledPhotos([...add.slice(0, 1), ...own], add, made, 'styled-first');
  assert.deepEqual(again.photos, [...add, ...own]);
  assert.deepEqual(again.added, add.slice(1));
  // Eight at most.
  const many = Array.from({ length: 7 }, (_, i) => `/api/images/own${i}.png`);
  const r = stage.withStyledPhotos(many, add, made, 'styled-first');
  assert.equal(r.photos.length, 8);
  assert.deepEqual(r.full, add.slice(1));
});

test('Quick add: saved at once (hidden), then written, pictured angle by angle, AI pictures first, owner’s photo last, and published, with no one waiting', async () => {
  const { url } = photo();
  const catalog = settings.getSettings('catalog');
  const king = catalog.sizes.find((s) => s.id === 'king') ?? catalog.sizes[0];
  const key = 'q-test-0001abcd';
  const r = auto.quickAdd({ key, photos: [url], price: 189, sizes: [{ id: king.id, stock: 3 }] }, OWNER);
  assert.equal(r.product.active, false, 'hidden until it is ready');
  assert.equal(r.product.title, auto.PLACEHOLDER_TITLE);
  assert.equal(r.product.stockBySize[king.id], 3);
  assert.equal(r.product.material, '', 'no fabric invented');
  // A double tap (or a retry) adds it once.
  assert.equal(auto.quickAdd({ key, photos: [url], price: 189, sizes: [{ id: king.id, stock: 3 }] }, OWNER).product.id, r.product.id);

  await auto.kick();
  const p = products.getProduct(r.product.id)!;
  assert.equal(p.title, SUGGESTION.title);
  assert.equal(p.active, true, 'in the shop');
  assert.ok(p.description.length > 0);
  assert.equal(p.colors[0].name, 'Indigo');
  assert.match(p.sku ?? '', /^[A-Z0-9-]+$/);
  assert.doesNotMatch(p.sku ?? '', /NEW|DESIGN|WRIT/, 'the SKU follows the AI name, not the placeholder');
  const photos = [p.featuredImage, ...p.galleryImages];
  assert.equal(photos.length, 4);
  assert.equal(photos[3], url, 'the owner’s photo last');
  for (const u of photos.slice(0, 3)) assert.ok(p.stagedPhotos?.[u], `${u} is marked as an AI picture`);
  const calls = pictureCalls();
  assert.equal(calls.length, 3, 'one request per angle');
  assert.deepEqual(calls.map(imagesOf), [1, 2, 2], 'the first picture goes with the next two');
  assert.match(promptOf(calls[2]), /High diagonal angle/);
  const job = auto.listJobs().find((j) => j.productId === p.id)!;
  assert.equal(job.state, 'done');
  assert.match(job.note, /In the shop\. 3 of 3 AI pictures made\./);
});

test('Quick add: Google’s “wait a minute” is waited out and tried again by itself; a restart keeps the pictures already made', async () => {
  const { url } = photo();
  const catalog = settings.getSettings('catalog');
  let busy = 1;
  const waits: number[] = [];
  auto._setSleep(async (ms) => void waits.push(ms));
  answer = (req) => {
    if (req.path.includes('image') && busy-- > 0) return { status: 429, data: { error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] } } };
    return req.path.includes('image') ? picture() : text();
  };
  const r = auto.quickAdd({ key: 'q-test-0002abcd', photos: [url], price: 150, sizes: [{ id: catalog.sizes[0].id, stock: 1 }] }, OWNER);
  await auto.kick();
  assert.ok(waits.length >= 1 && waits[0] >= 37_000, 'waited as long as Google asked');
  const p = products.getProduct(r.product.id)!;
  assert.equal([p.featuredImage, ...p.galleryImages].length, 4);
  assert.equal(p.active, true);

  // A restart in the middle: the job as the stopped copy left it (written, one picture made, still
  // "pictures"). Only the other two pictures are made.
  answer = (req) => (req.path.includes('image') ? picture() : text());
  const own = photo().url;
  const p0 = products.createProduct({ title: 'Rose Garden Set', category: catalog.categories[0].id, price: 150, featuredImage: own, galleryImages: [], profiles: [catalog.sizes[0]], defaultProfileId: catalog.sizes[0].id, stockBySize: { [catalog.sizes[0].id]: 1 }, active: false, colors: [], isFeatured: false }, OWNER);
  const one = await stage.stagePhoto({ imageId: own.replace('/api/images/', ''), angle: 1 }, OWNER);
  const at = new Date().toISOString();
  kvSet(auto.JOBS_KEY, [{ id: 'job-restart', key: 'q-test-0003abcd', productId: p0.id, by: OWNER, state: 'pictures', publish: true, named: true, written: true, plan: ['angle:1', 'angle:2', 'angle:3'], made: [one.url], note: '', createdAt: at, updatedAt: at }]);
  sent = [];
  await auto.kick();
  assert.equal(pictureCalls().length, 2, 'the picture already paid for is not made again');
  assert.equal(imagesOf(pictureCalls()[0]), 2, 'and it is still sent with the next ones');
  const p2 = products.getProduct(p0.id)!;
  assert.equal(p2.active, true);
  assert.equal(p2.featuredImage, one.url);
  assert.equal(p2.galleryImages.at(-1), own);
});

test('Quick add: without AI writing the owner types the name; with auto creation off nothing runs; a failed picture still publishes with the owner’s photo', async () => {
  const catalog = settings.getSettings('catalog');
  const size = [{ id: catalog.sizes[0].id, stock: 2 }];
  await settings.updateSettings('aiPictures', { autoCreate: false });
  assert.throws(() => auto.quickAdd({ key: 'q-test-0004abcd', photos: [photo().url], price: 99, sizes: size }, OWNER), /Give it a name/);
  const named = auto.quickAdd({ key: 'q-test-0005abcd', photos: [photo().url], price: 99, sizes: size, title: 'Plain White Percale Set' }, OWNER);
  assert.equal(named.job, null);
  assert.equal(named.product.active, true, 'published at once when nothing is left to do');
  await settings.updateSettings('aiPictures', { autoCreate: true });

  sent = [];
  answer = (req) => (req.path.includes('image') ? { status: 400, data: { error: { code: 400, message: 'Image generation is not available for this model.' } } } : text());
  const r = auto.quickAdd({ key: 'q-test-0006abcd', photos: [photo().url], price: 99, sizes: size }, OWNER);
  await auto.kick();
  const p = products.getProduct(r.product.id)!;
  assert.equal(p.active, true, 'written: in the shop with its own photo');
  assert.equal(p.galleryImages.length, 0);
  const job = auto.listJobs().find((x) => x.productId === p.id)!;
  assert.equal(job.state, 'needs_you');
  assert.match(job.note, /0 of 3 AI pictures made/);

  // The writer refuses: hidden, waiting for a name.
  answer = (req) => (req.path.includes('image') ? picture() : { status: 400, data: { error: { code: 400, message: 'API key not valid.' } } });
  const r3 = auto.quickAdd({ key: 'q-test-0007abcd', photos: [photo().url], price: 99, sizes: size }, OWNER);
  await auto.kick();
  const p3 = products.getProduct(r3.product.id)!;
  assert.equal(p3.active, false);
  assert.match(auto.listJobs().find((x) => x.productId === p3.id)!.note, /Give it a name to publish it/);
});

test('one copy of the shop works on the jobs at a time (an update’s overlap); the request is checked against an allow-list', () => {
  kvSet('autoai:lease', { by: '', until: 0 });
  assert.equal(auto.takeLease('copy-a', 1000), true);
  assert.equal(auto.takeLease('copy-b', 2000), false, 'the other copy waits');
  assert.equal(auto.takeLease('copy-a', 3000), true, 'renewed by its holder');
  assert.equal(auto.takeLease('copy-b', 3000 + 10 * 60 * 1000 + 1), true, 'taken over once the holder stopped');
  assert.equal(kvGet<{ by: string }>('autoai:lease')?.data.by, 'copy-b');
  kvSet('autoai:lease', { by: '', until: 0 });
  const size = [{ id: settings.getSettings('catalog').sizes[0].id, stock: 1 }];
  assert.throws(() => auto.quickAdd({ key: 'q-test-0008abcd', photos: [photo().url], price: 99, sizes: size, active: true }, OWNER), /Unexpected field/);
  assert.throws(() => auto.quickAdd({ key: 'short', photos: [photo().url], price: 99, sizes: size }, OWNER), /request key/);
  assert.throws(() => auto.quickAdd({ key: 'q-test-0009abcd', photos: ['https://evil.example/x.png'], price: 99, sizes: size }, OWNER), /no longer stored/);
  assert.throws(() => auto.quickAdd({ key: 'q-test-0010abcd', photos: [photo().url], price: 99, sizes: [{ id: 'nope', stock: 1 }] }, OWNER), /Unknown size/);
  assert.throws(() => auto.quickAdd({ key: 'q-test-0011abcd', photos: [photo().url], price: -5, sizes: size }, OWNER));
});

test('the daily summary lists new products the AI could not finish, under Action needed', async () => {
  const monitor = await import('@/lib/server/monitor');
  const size = [{ id: settings.getSettings('catalog').sizes[0].id, stock: 1 }];
  answer = (req) => (req.path.includes('image') ? picture() : { status: 400, data: { error: { code: 400, message: 'API key not valid.' } } });
  auto.quickAdd({ key: 'q-test-0012abcd', photos: [photo().url], price: 120, sizes: size }, OWNER);
  await auto.kick();
  const action = monitor.dailySummary(new Date()).sections.find((s) => s.title === 'Action needed')!;
  assert.ok(action.items.some((i) => /New products that need you: 1 \(Inventory → Being made by AI\)/.test(i.text)));
});
