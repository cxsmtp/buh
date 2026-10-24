/**
 * Pictures from numbered angles, and Quick add (src/lib/server/autoAdd.ts), with Google replaced by
 * a stand-in:
 * - the owner's prompt with "1. … 2. … 3. …" becomes three requests, one after another, each asking
 *   for ONE photograph from its angle (the list is never sent: the service drew all three in one
 *   collage); each is a NEW photograph from its own camera position (asked to "edit" the photo, the
 *   model kept its camera and the angles looked alike); the rest of the prompt goes with every one;
 *   the first picture goes with the next ones only when the owner asks for the same room;
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
const { saveImageDataUrl, readImage } = await import('@/lib/server/images');
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
const isCheck = (s: Sent) => Boolean(s.body?.contents?.[0]?.parts?.[0]?.text?.startsWith('You are the strict quality check'));
const verdict = (v: Record<string, unknown>) => ok({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(v) }] }, finishReason: 'STOP' }] });
const MODEL_LIST = ok({ models: [{ name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] }] });
/** The check's answers: all fine, or one thing wrong. */
const MATCHES = { samePrint: true, sameColours: true, pillowCovers: true, extraItems: false, reason: 'matches' };
const wrong = (v: Record<string, unknown>) => ({ ...MATCHES, ...v });
/** How the check answers (the model list and the check go here, whatever `answer` does). */
let checks: (req: Sent) => { status: number; data: unknown } = () => verdict(MATCHES);

beforeEach(async () => {
  _clearAllRateLimits();
  sent = [];
  // Every picture is checked (Settings → AI pictures, on by default): it matches unless a test says otherwise.
  checks = () => verdict(MATCHES);
  answer = (req) => (req.path.includes('image') ? picture() : text());
  gemini._setGeminiTransport(async (req) => {
    const s: Sent = { path: req.path, body: req.body ? JSON.parse(req.body) : null };
    sent.push(s);
    const a = s.path.startsWith('/models?') ? MODEL_LIST : isCheck(s) ? checks(s) : answer(s);
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

test('the studio: one request per angle, a NEW photograph from its own camera position each (reported: the 3 pictures came out almost the same), never the list; the same room only when the owner asks', async () => {
  const { url } = photo();
  const imageId = url.replace('/api/images/', '');
  const first = await stage.stagePhoto({ imageId, angle: 1 }, OWNER);
  const second = await stage.stagePhoto({ imageId, angle: 2, sameRoom: first.url }, OWNER);
  const calls = pictureCalls();
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const p = promptOf(c);
    // Asked to "edit" the photo, the model kept its camera: every angle looked the same.
    assert.match(p, /^Make a NEW photograph of the bedding set in image 1/);
    assert.doesNotMatch(p, /Edit this photograph|Edit the first photograph/);
    assert.match(p, /NOT the camera position, angle, framing or crop of image 1/);
    assert.match(p, /clearly different from image 1/);
    assert.match(p, /Never a collage, grid, split screen/);
    assert.doesNotMatch(p, /1\. Straight-on|2\. 45-degree|exactly three/, 'the numbered list is never sent');
    assert.match(p, /Identical Setting/);
  }
  assert.match(promptOf(calls[0]), /The camera: Straight-on eye-level view/);
  assert.doesNotMatch(promptOf(calls[0]), /45-degree/);
  assert.match(promptOf(calls[1]), /The camera: 45-degree three-quarter view/);
  // By default the first picture is not sent with the next (the model copied it).
  assert.equal(imagesOf(calls[0]), 1, 'the product photo only');
  assert.equal(imagesOf(calls[1]), 1, 'not the first picture, by default');
  assert.notEqual(first.url, second.url);
  // The owner can ask for exactly the same room: then it is sent, the camera still moves.
  await settings.updateSettings('aiPictures', { sameRoom: true });
  sent = [];
  await stage.stagePhoto({ imageId, angle: 3, sameRoom: first.url }, OWNER);
  assert.equal(imagesOf(pictureCalls()[0]), 2);
  assert.match(promptOf(pictureCalls()[0]), /keep that room .* but NOT image 2's camera position: the camera moves/);
  await settings.updateSettings('aiPictures', { sameRoom: false });
  // Only angles that are in the prompt, and only pictures this feature made as "same room".
  await assert.rejects(stage.stagePhoto({ imageId, angle: 4 }, OWNER), /not in your prompt/);
  // A "same room" picture that is not one this feature made (or was discarded) is not sent.
  sent = [];
  await stage.stagePhoto({ imageId, angle: 2, sameRoom: url }, OWNER);
  assert.equal(imagesOf(pictureCalls()[0]), 1);
  await assert.rejects(stage.stagePhoto({ imageId, angle: 2, sameRoom: '../shop.db' }, OWNER), /same room/);
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
  assert.deepEqual(calls.map(imagesOf), [1, 1, 1], 'each angle from the product photo alone (by default)');
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

test('a product the AI finished leaves "Being made by AI" in Inventory (reported: it stayed after it was in the shop); the form keeps a tick for a few minutes', async () => {
  const { visibleJobs, DONE_SHOWN_MS } = await import('@/lib/client/autoJobs');
  const now = Date.parse('2026-10-21T10:00:00Z');
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const jobs = [
    { id: 'done', state: 'done', updatedAt: at(60_000) },
    { id: 'old-done', state: 'done', updatedAt: at(DONE_SHOWN_MS + 1) },
    { id: 'making', state: 'pictures', updatedAt: at(1000) },
    { id: 'needs', state: 'needs_you', updatedAt: at(3 * 86_400_000) },
  ];
  assert.deepEqual(visibleJobs(jobs, 'inventory', now).map((j) => j.id), ['making', 'needs']);
  assert.deepEqual(visibleJobs(jobs, 'form', now).map((j) => j.id), ['done', 'making', 'needs']);
});

// ── review fixes (BUH-02.24.01) ─────────────────────────────────────────────

const kingSize = () => [{ id: (settings.getSettings('catalog').sizes.find((s) => s.id === 'king') ?? settings.getSettings('catalog').sizes[0]).id, stock: 1 }];
/** A job as a stopped worker leaves it (still working), without running it. */
function pendingJob(productId: string, extra: Record<string, unknown> = {}) {
  const at = new Date().toISOString();
  kvSet(auto.JOBS_KEY, [{ id: `job-${productId}`, key: `q-${productId}`, productId, by: OWNER, state: 'pictures', publish: true, named: false, written: false, plan: ['angle:1', 'angle:2', 'angle:3'], made: [], note: '', createdAt: at, updatedAt: at, ...extra }]);
}

test('an editor save while the AI is still making the product is refused (it would put the placeholder over the AI’s work); show/hide is kept for when it is done', async () => {
  const p = products.createProduct({ title: auto.PLACEHOLDER_TITLE, category: settings.getSettings('catalog').categories[0].id, price: 150, featuredImage: photo().url, galleryImages: [], profiles: [settings.getSettings('catalog').sizes[0]], defaultProfileId: settings.getSettings('catalog').sizes[0].id, stockBySize: { [settings.getSettings('catalog').sizes[0].id]: 1 }, active: false, colors: [], isFeatured: false }, OWNER);
  pendingJob(p.id);
  assert.throws(() => auto.editWhileWorking(p.id, { title: auto.PLACEHOLDER_TITLE, price: 160, active: false }), (e: { status: number; details: { code: string } }) => e.status === 409 && e.details.code === 'ai_working');
  // Hide: taken now and remembered (kept hidden when it is done).
  assert.equal(auto.editWhileWorking(p.id, { active: false }), 'apply');
  assert.equal(auto.listJobs()[0].publish, false);
  // Show: remembered, published only once the AI has named it (never with its placeholder).
  assert.equal(auto.editWhileWorking(p.id, { active: true }), 'kept');
  assert.equal(auto.listJobs()[0].publish, true);
  assert.equal(products.getProduct(p.id)!.active, false);
  await auto.kick();
  const done = products.getProduct(p.id)!;
  assert.equal(done.title, SUGGESTION.title);
  assert.equal(done.active, true);
  // Done: a normal save again.
  assert.equal(auto.editWhileWorking(p.id, { price: 170 }), 'none');

  // Hidden by the owner meanwhile: kept hidden when it is done.
  const q = auto.quickAdd({ key: 'q-test-0101abcd', photos: [photo().url], price: 99, sizes: kingSize() }, OWNER);
  auto.editWhileWorking(q.product.id, { active: false });
  await auto.kick();
  assert.equal(products.getProduct(q.product.id)!.active, false, 'the owner hid it: not published');
  assert.match(auto.listJobs().find((j) => j.productId === q.product.id)!.note, /kept hidden/);
});

test('a product removed while the AI works is left alone: no more paid pictures, never published (reported by review)', async () => {
  const p = products.createProduct({ title: auto.PLACEHOLDER_TITLE, category: settings.getSettings('catalog').categories[0].id, price: 150, featuredImage: photo().url, galleryImages: [], profiles: [settings.getSettings('catalog').sizes[0]], defaultProfileId: settings.getSettings('catalog').sizes[0].id, stockBySize: { [settings.getSettings('catalog').sizes[0].id]: 1 }, active: false, colors: [], isFeatured: false }, OWNER);
  pendingJob(p.id);
  products.setArchived(p.id, true);
  sent = [];
  await auto.kick();
  assert.equal(sent.length, 0, 'nothing paid for');
  const after = products.getProduct(p.id)!;
  assert.equal(after.active, false);
  assert.equal(after.archived, true);
  assert.match(auto.listJobs()[0].note, /removed/);
});

test('a refused key stops the set after one picture; the same photo twice is one photo; a discarded first angle is not sent', async () => {
  sent = [];
  answer = (req) => (req.path.includes('image') ? { status: 400, data: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } } } : text());
  const one = photo().url;
  const r = auto.quickAdd({ key: 'q-test-0102abcd', photos: [one, one], price: 99, sizes: kingSize() }, OWNER);
  assert.equal(r.product.galleryImages.length, 0, 'the same picture twice is one photo');
  await auto.kick();
  assert.equal(pictureCalls().length, 1, 'not tried three times with a refused key');

  answer = (req) => (req.path.includes('image') ? picture() : text());
  const own = photo().url.replace('/api/images/', '');
  const first = await stage.stagePhoto({ imageId: own, angle: 1 }, OWNER);
  stage.discardStagedPhoto({ url: first.url }, OWNER);
  sent = [];
  const second = await stage.stagePhoto({ imageId: own, angle: 2, sameRoom: first.url }, OWNER);
  assert.ok(second.url);
  assert.equal(imagesOf(pictureCalls()[0]), 1, 'the discarded picture is not sent');
});

test('angles: a room described before the list is kept; numbered rules are not angles; the last angle is not cut at "e.g."; the list is never sent as one', async () => {
  const room = staging.splitAngles('A bright Dubai bedroom with white walls and oak floors, photographed from three angles: 1. Front view; 2. Side view; 3. Top view, e.g. from above. Soft light.');
  assert.deepEqual(room.angles, ['Front view', 'Side view', 'Top view, e.g. from above']);
  assert.equal(room.shared, 'A bright Dubai bedroom with white walls and oak floors. Soft light.');
  assert.deepEqual(staging.splitAngles('Requirements: 1. Keep colours true. 2. No people. 3. Soft light.').angles, []);
  // Only a request for pictures before the list: nothing is left of the lead-in, and the shop's look is used (never the list).
  await settings.updateSettings('aiPictures', { look: 'Make three separate photos from three angles: 1. Front view; 2. Side view; 3. Top view.' });
  sent = [];
  await stage.stagePhoto({ imageId: photo().url.replace('/api/images/', ''), angle: 3 }, OWNER);
  const p = promptOf(pictureCalls()[0]);
  assert.doesNotMatch(p, /1\. Front view/);
  assert.match(p, /The camera: Top view/);
  await settings.updateSettings('aiPictures', { look: PROMPT });
});

test('the daily summary stops listing a product once the owner has named and published it', async () => {
  const monitor = await import('@/lib/server/monitor');
  answer = (req) => (req.path.includes('image') ? picture() : { status: 400, data: { error: { code: 400, message: 'API key not valid.' } } });
  const r = auto.quickAdd({ key: 'q-test-0103abcd', photos: [photo().url], price: 120, sizes: kingSize() }, OWNER);
  await auto.kick();
  const listed = () => monitor.dailySummary(new Date()).sections.find((s) => s.title === 'Action needed')!.items.some((i) => /New products that need you/.test(i.text));
  assert.equal(listed(), true);
  products.updateProduct(r.product.id, { title: 'Blue Paisley Set', active: true }, OWNER);
  assert.equal(listed(), false);
});

// ── the design and the items on the bed (BUH-02.25) ─────────────────────────


test('every picture is sent with the rules: the exact printed design (never invented), and only the bedsheet and its pillow covers on the bed (no comforter, throw or cushions); the owner can reword the bed rule', async () => {
  const pic = await import('@/lib/server/pictureCheck');
  pic._resetCheckModel();
  const own = photo().url.replace('/api/images/', '');
  await stage.stagePhoto({ imageId: own, angle: 1 }, OWNER);
  await stage.stagePhoto({ imageId: own, preset: 'whole-bed' }, OWNER);
  for (const c of pictureCalls()) {
    const p = promptOf(c);
    assert.match(p, /What may be on the bed \(a rule\): On the bed only this set: the bedsheet and its pillow covers, each in its own design from its photo/);
    assert.match(p, /No comforter, duvet, quilt, blanket, throw, bed runner, decorative cushions, extra pillows/);
    assert.match(p, /Retain the exact motifs, arrangement, print scale and colours without inventing, redrawing, simplifying, restyling or replacing patterns/);
  }
  await settings.updateSettings('aiPictures', { onBed: 'Only the fitted sheet and two pillow covers.' });
  sent = [];
  await stage.stagePhoto({ imageId: own, angle: 2 }, OWNER);
  assert.match(promptOf(pictureCalls()[0]), /What may be on the bed \(a rule\): Only the fitted sheet and two pillow covers\./);
  await settings.updateSettings('aiPictures', { onBed: '' });
  await assert.rejects(settings.updateSettings('aiPictures', { onBed: 'x'.repeat(601) }), /at most 600/);
  await assert.rejects(settings.updateSettings('aiPictures', { checkPictures: 'yes' }), /on or off/);
});

test('each picture is checked against the product photo (reported: the design was changed and bedding added): a mismatch is made again with what was wrong; still wrong is marked and never added by quick add', async () => {
  const pic = await import('@/lib/server/pictureCheck');
  pic._resetCheckModel();
  const own = photo().url.replace('/api/images/', '');
  // Matches: one picture, checked.
  checks = () => verdict(MATCHES);
  sent = [];
  const good = await stage.stagePhoto({ imageId: own, angle: 1 }, OWNER);
  assert.deepEqual(good.check, { ok: true, reason: 'matches' });
  assert.equal(pictureCalls().length, 1);
  const checkCalls = sent.filter(isCheck);
  assert.equal(checkCalls.length, 1);
  assert.equal(imagesOf(checkCalls[0]), 2, 'the product photo and the new picture');

  // A different design the first time, right the second: made again with what was wrong.
  let first = true;
  checks = () => {
    const v = first ? wrong({ samePrint: false, extraItems: true, reason: 'the print is a different floral, and a grey comforter was added' }) : MATCHES;
    first = false;
    return verdict(v);
  };
  sent = [];
  const fixed = await stage.stagePhoto({ imageId: own, angle: 2 }, OWNER);
  assert.equal(fixed.check?.ok, true);
  const calls = pictureCalls();
  assert.equal(calls.length, 2, 'made again once');
  assert.match(promptOf(calls[1]), /The previous picture was rejected: the print is a different floral, and a grey comforter was added\. Copy every piece from its photo exactly this time\./);

  // Wrong both times: kept for the studio, marked; quick add never adds it.
  checks = () => verdict(wrong({ samePrint: false, reason: 'the pattern was redrawn' }));
  sent = [];
  const bad = await stage.stagePhoto({ imageId: own, angle: 3 }, OWNER);
  assert.deepEqual(bad.check, { ok: false, reason: 'the pattern was redrawn' });
  assert.equal(pictureCalls().length, stage.PICTURE_TRIES, 'made again up to 3 times in all, never more');

  const r = auto.quickAdd({ key: 'q-test-0201abcd', photos: [photo().url], price: 99, sizes: [{ id: settings.getSettings('catalog').sizes[0].id, stock: 1 }] }, OWNER);
  await auto.kick();
  const p = products.getProduct(r.product.id)!;
  assert.equal(p.galleryImages.length, 0, 'no non-matching picture on the product');
  assert.equal(Object.keys(p.stagedPhotos ?? {}).length, 0);
  assert.match(auto.listJobs().find((j) => j.productId === p.id)!.note, /did not match the product \(the pattern was redrawn\), so it was not added/);

  // Switched off: no check is made.
  await settings.updateSettings('aiPictures', { checkPictures: false });
  sent = [];
  const unchecked = await stage.stagePhoto({ imageId: own, angle: 1 }, OWNER);
  assert.equal(unchecked.check, null);
  assert.equal(sent.filter(isCheck).length, 0);
  await settings.updateSettings('aiPictures', { checkPictures: true });
});

test('only pictures of exactly the product reach a product (reported: pictures not true to the product were published): the server refuses one that failed the check or was never checked; the owner confirms an unchecked one; pillow covers are a must', async () => {
  const pic = await import('@/lib/server/pictureCheck');
  const { stagedRecords } = await import('@/lib/server/stagedPhotos');
  pic._resetCheckModel();
  const own = photo().url;
  const imageId = own.replace('/api/images/', '');
  const nameOf = (url: string) => url.replace('/api/images/', '');
  const product = auto.quickAdd({ key: 'q-test-0251abcd', photos: [own], price: 99, sizes: [{ id: settings.getSettings('catalog').sizes[0].id, stock: 1 }] }, OWNER).product;
  await auto.kick();
  const addTo = (url: string) => products.updateProduct(product.id, { galleryImages: [...products.getProduct(product.id)!.galleryImages, url] }, OWNER);

  // Every picture is told to show the product's pillow covers, and the check asks for them.
  await stage.stagePhoto({ imageId, angle: 1 }, OWNER);
  assert.match(promptOf(pictureCalls().at(-1)!), /one displayed on the bed and one distinct cover placed neatly beside or in front of the bed.*\n[\s\S]*Ensure the pillow covers display their design clearly/);
  assert.match(pic.CHECK_PROMPT, /pillowCovers: if image 1 shows pillow covers, true only if image 2 also clearly shows the pillow covers/);
  assert.match(pic.CHECK_PROMPT, /If you are not sure about any of these, answer the failing value\./);

  // Pillow covers missing every time: three tries, then marked; the record keeps the verdict.
  checks = () => verdict(wrong({ pillowCovers: false, reason: '' }));
  sent = [];
  const noCovers = await stage.stagePhoto({ imageId, angle: 2 }, OWNER);
  assert.deepEqual(noCovers.check, { ok: false, reason: 'the product’s pillow covers are missing or different' });
  assert.equal(pictureCalls().length, 3);
  assert.equal(stagedRecords()[nameOf(noCovers.url)].check, 'does_not_match');
  // Refused on a product, whoever sends it, and it can't be confirmed by hand either.
  assert.throws(() => addTo(noCovers.url), (e: { status: number; details?: { code?: string } }) => e.status === 409 && e.details?.code === 'picture_not_verified');
  assert.throws(() => stage.approveStagedPhoto({ url: noCovers.url, approve: true }, OWNER), (e: { status: number }) => e.status === 409);
  // Other colours fail too.
  checks = () => verdict(wrong({ sameColours: false, reason: 'the blue was turned green' }));
  assert.equal((await stage.stagePhoto({ imageId, angle: 3 }, OWNER)).check?.ok, false);

  // An answer missing a field is no verdict: not checked.
  assert.equal(pic.parseVerdict(JSON.stringify({ samePrint: true, extraItems: false, reason: 'matches' })), null);
  checks = () => verdict({ samePrint: true, extraItems: false });
  const unchecked = await stage.stagePhoto({ imageId, angle: 1 }, OWNER);
  assert.equal(unchecked.check, null);
  assert.equal(stagedRecords()[nameOf(unchecked.url)].check, 'not_checked');
  assert.throws(() => addTo(unchecked.url), (e: { status: number }) => e.status === 409);
  // The owner compared it and confirms: then it may be added (audited).
  assert.throws(() => stage.approveStagedPhoto({ url: unchecked.url }, OWNER), (e: { status: number }) => e.status === 400);
  assert.throws(() => stage.approveStagedPhoto({ url: unchecked.url, approve: true, extra: 1 }, OWNER), (e: { status: number }) => e.status === 400);
  assert.deepEqual(stage.approveStagedPhoto({ url: unchecked.url, approve: true }, OWNER), { check: 'approved' });
  assert.ok(addTo(unchecked.url).galleryImages.includes(unchecked.url));

  // A matching picture goes on; pictures already on a product (from before the checks) stay.
  checks = () => verdict(MATCHES);
  const good = await stage.stagePhoto({ imageId, angle: 2 }, OWNER);
  assert.equal(stagedRecords()[nameOf(good.url)].check, 'matches');
  assert.ok(addTo(good.url).galleryImages.includes(good.url));
  assert.ok(products.updateProduct(product.id, { title: 'Indigo Garden Set' }, OWNER), 'saving the product again keeps its pictures');

  // Quick add with the check switched off: no pictures made at all (they could never be added).
  await settings.updateSettings('aiPictures', { checkPictures: false });
  sent = [];
  const q = auto.quickAdd({ key: 'q-test-0252abcd', photos: [photo().url], price: 99, sizes: [{ id: settings.getSettings('catalog').sizes[0].id, stock: 1 }] }, OWNER);
  await auto.kick();
  assert.equal(pictureCalls().length, 0, 'none paid for');
  assert.equal(Object.keys(products.getProduct(q.product.id)!.stagedPhotos ?? {}).length, 0);
  assert.match(auto.listJobs().find((j) => j.productId === q.product.id)!.note, /AI pictures were not made: they can only be added once checked against your photo/);
  await settings.updateSettings('aiPictures', { checkPictures: true });
});

test('the owner’s fixed prompt and the set’s pieces (reported: pillow covers are redesigned; the comforter only when the set has one): the bedsheet from the main photo, the pillow covers from their own photo, a comforter only from its photo; each piece checked against its own', async () => {
  const pic = await import('@/lib/server/pictureCheck');
  pic._resetCheckModel();
  const sheet = photo().url;
  const pillow = photo().url;
  const comforter = photo().url;
  const nameOf = (url: string) => url.replace('/api/images/', '');
  const bytesOf = (url: string) => (readImage(nameOf(url))?.bytes ?? Buffer.alloc(0)).toString('base64');

  // The owner's optimized prompt is the fixed part, after everything else.
  const plain = staging.stagingPrompt('the whole bed', '', '4:5');
  for (const line of [
    'Strict fidelity requirements:',
    '- Exact print and motif replication: copy the printed design directly from its reference photo onto the sheets and the pillow covers (the bedsheets from image 1, the pillow covers from image 1). Retain the exact motifs, arrangement, print scale and colours without inventing, redrawing, simplifying, restyling or replacing patterns.',
    '- Colour accuracy: maintain the exact colours, shades and fabric tones of the reference photo; do not recolour, brighten, saturate or fade the fabric.',
    '- Texturing and construction: accurately render the fabric texture, stitching, piping, borders, edges and natural folds.',
    '- Component count: exactly match the pieces of this set (sheets, pillow covers); add no extra items, and remove none. This set has no comforter: show none. Ensure the pillow covers display their design clearly.',
    'Composition and environment:',
    '- A clean, minimalist, well-lit upscale bedroom interior background that complements the bedding without distracting from it.',
    '- Single frame: one single photograph filling the entire frame from one fixed camera angle. Never a collage, grid, split screen, multiple views or framed border.',
    '- Prohibitions: absolutely no text, letters, numbers, logos, watermarks, people, parts of people or pets anywhere in the image.',
  ])
    assert.ok(plain.includes(line), line);
  assert.match(plain, /The set: matching bedsheets \(no comforter\), neatly arranged on a modern platform bed, with the pillow covers placed prominently: one displayed on the bed and one distinct cover placed neatly beside or in front of the bed to showcase its pattern\./);
  assert.match(plain, /No comforter, duvet, quilt/);

  // The pillow cover photo: image 2, the pillow covers copied from it; no comforter.
  sent = [];
  await stage.stagePhoto({ imageId: nameOf(sheet), angle: 1, pillowImageId: pillow }, OWNER);
  let call = pictureCalls().at(-1)!;
  let parts = call.body.contents[0].parts as Array<{ text?: string; inlineData?: { data: string } }>;
  assert.equal(parts[1].inlineData!.data, bytesOf(sheet), 'image 1: the bedsheet');
  assert.equal(parts[2].inlineData!.data, bytesOf(pillow), 'image 2: the pillow cover');
  assert.equal(imagesOf(call), 2, 'no comforter photo');
  let p = promptOf(call);
  assert.match(p, /Image 1 is the bedsheet of this set; image 2 is its pillow cover \(the pillow covers carry exactly this design, not the bedsheet's\)/);
  assert.match(p, /the bedsheets from image 1, the pillow covers from image 2\)/);
  assert.match(p, /This set has no comforter: show none\./);
  // The check sees the bedsheet, the pillow cover and the picture, and asks for each.
  let check = sent.filter(isCheck).at(-1)!;
  assert.equal(imagesOf(check), 3);
  assert.match(promptOf(check), /Image 2 is the real photo of its pillow cover\. Image 3 is an AI-made picture/);
  assert.match(promptOf(check), /pillowCovers: true only if image 3 clearly shows the pillow covers, in the same design and colours as image 2 \(the real pillow cover photo\)/);
  assert.match(promptOf(check), /a comforter, duvet, quilt.*\(this set has no comforter\)/);

  // With a comforter: image 3, copied from its photo, and the check compares it.
  sent = [];
  await stage.stagePhoto({ imageId: nameOf(sheet), preset: 'whole-bed', pillowImageId: pillow, comforterImageId: comforter }, OWNER);
  call = pictureCalls().at(-1)!;
  parts = call.body.contents[0].parts as Array<{ text?: string; inlineData?: { data: string } }>;
  assert.equal(parts[3].inlineData!.data, bytesOf(comforter), 'image 3: the comforter');
  p = promptOf(call);
  assert.match(p, /image 3 is its comforter/);
  assert.match(p, /onto the comforter, the sheets and the pillow covers \(the bedsheets from image 1, the pillow covers from image 2, the comforter from image 3\)/);
  assert.match(p, /\(comforter, sheets, pillow covers\); add no extra items, and remove none\. Ensure/);
  assert.match(p, /a plush comforter and matching bedsheets/);
  assert.match(p, /On the bed only this set: the comforter, the bedsheet and the pillow covers/);
  check = sent.filter(isCheck).at(-1)!;
  assert.equal(imagesOf(check), 4);
  assert.match(promptOf(check), /the comforter the same design as image 3/);

  // A piece's photo must be a real photo, stored; nothing else is taken.
  const ai = await stage.stagePhoto({ imageId: nameOf(sheet), angle: 2 }, OWNER);
  await assert.rejects(stage.stagePhoto({ imageId: nameOf(sheet), angle: 1, pillowImageId: ai.url }, OWNER), /must be a real photo, not an AI picture/);
  await assert.rejects(stage.stagePhoto({ imageId: nameOf(sheet), angle: 1, comforterImageId: '../etc/passwd' }, OWNER), /Which photo is the comforter/);
  await assert.rejects(stage.stagePhoto({ imageId: nameOf(sheet), angle: 1, comforterImageId: `/api/images/${'a'.repeat(64)}.png` }, OWNER), /no longer stored/);

  // Saved on the product (allow-listed, real photos only), and quick add sends each piece with every picture.
  assert.throws(() => products.validateProduct({ ...products.getProduct(auto.quickAdd({ key: 'q-test-0260abcd', photos: [sheet], price: 99, sizes: [{ id: settings.getSettings('catalog').sizes[0].id, stock: 1 }] }, OWNER).product.id)!, setPhotos: { duvet: pillow } }), /Unexpected set piece/);
  assert.throws(() => products.validateProduct({ ...products.getProduct(auto.listJobs()[0].productId)!, setPhotos: { pillow: ai.url } }), /use a real photo of it, not an AI picture/);
  await auto.kick();
  sent = [];
  const q = auto.quickAdd({ key: 'q-test-0261abcd', photos: [sheet], price: 99, sizes: [{ id: settings.getSettings('catalog').sizes[0].id, stock: 1 }], setPhotos: { pillow } }, OWNER);
  assert.deepEqual(products.getProduct(q.product.id)!.setPhotos, { pillow });
  await auto.kick();
  const calls = pictureCalls();
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.equal(imagesOf(c) >= 2, true);
    assert.equal((c.body.contents[0].parts as Array<{ inlineData?: { data: string } }>)[2].inlineData!.data, bytesOf(pillow), 'the pillow cover with every picture');
    assert.match(promptOf(c), /This set has no comforter: show none\./);
  }
});
