import crypto from 'node:crypto';
import type { BedProfileMeasurement, Product } from '@/types';
import { sizeFromPreset } from '@/lib/measurements';
import { blankVariant, defaultTypeFor } from '@/lib/productType';
import { DEFAULT_STAGING_SET } from '@/lib/staging';
import { aiStatus, describeProduct } from './aiWriting';
import { audit, auditOrThrow } from './audit';
import { HttpError } from './http';
import { IMAGE_NAME, readImage } from './images';
import { getDb } from './db';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { createProduct, getProduct, updateProduct } from './products';
import { getSettings } from './settings';
import { suggestSku } from './sku';
import { PRODUCT_MAX_PHOTOS, SOURCE_MAX_BYTES, anglesOf, saveStyledPhotos, sceneById, stagePhoto, stagingStatus } from './stagePhoto';

/**
 * Quick add (Inventory → Add product): the owner gives only the basics (photos, price, category,
 * sizes and stock; a name if they like) and presses Add. The product is saved at once, hidden, and
 * the owner can add the next one straight away. In the background, one product at a time, the
 * shop then:
 *   1. writes the name (unless the owner gave one), the descriptions, colours and a gift line from
 *      the first photo (Settings → AI writing), and gives it an SKU from that name;
 *   2. makes the AI pictures (Settings → AI pictures), ONE REQUEST PER PICTURE, one after another:
 *      one per numbered angle in the owner's prompt, else the one-press scenes. The first picture
 *      goes with the next ones so the room stays the same. A service's "wait a minute" is waited
 *      out and tried again, without the owner;
 *   3. puts the AI pictures first and the owner's photo last (Settings → AI pictures → order), and
 *      publishes it (unless the owner chose "keep hidden").
 * Nothing is invented: the AI writes only what it sees, and pictures keep the product's true
 * colours and pattern (src/lib/staging.ts). The owner can edit everything later.
 *
 * Safe across restarts and updates: the jobs live in the database (kv "autoai:jobs"); a job that
 * was running carries on where it stopped, and pictures already made (paid for) are kept, never
 * made again. A product that can't be written (no AI key, a refusal) stays hidden and says why,
 * under "Needs you"; pictures that fail leave the product published with its own photo.
 * Switched off in Settings → AI pictures ("Write and make pictures for new products"): the owner
 * then types the name and the product is saved as they choose.
 */

export const JOBS_KEY = 'autoai:jobs';
/** Jobs kept for the list (newest first); finished ones beyond this are forgotten (the products stay). */
const KEEP = 40;
/** A service that says "wait": waited out, at most this many times for one step. */
const MAX_WAITS = 6;
/** The longest single wait (the shop's own hourly picture limit can ask for up to an hour). */
const MAX_WAIT_MS = 60 * 60 * 1000;
export const PLACEHOLDER_TITLE = 'New design (AI is writing it)';

export type JobState = 'queued' | 'writing' | 'pictures' | 'waiting' | 'done' | 'needs_you';

export interface AutoJob {
  id: string;
  /** The owner's idempotency key: adding the same item twice (a double tap, a retry) adds it once. */
  key: string;
  productId: string;
  by: string;
  state: JobState;
  /** Publish when ready (else keep hidden). */
  publish: boolean;
  /** The owner typed a name (it is kept, never replaced). */
  named: boolean;
  /** The text was written (or skipped because the owner wrote it). */
  written: boolean;
  /** Pictures planned: an angle number ("angle:2") or a scene id, in order. */
  plan: string[];
  /** Pictures made so far, in plan order (addresses); "" for one that failed. */
  made: string[];
  /** Plain words for the owner when something did not work. */
  note: string;
  /** While waiting for a service: when it tries again. */
  until?: string;
  createdAt: string;
  updatedAt: string;
}

const now = () => new Date().toISOString();

export function listJobs(): AutoJob[] {
  return kvGet<AutoJob[]>(JOBS_KEY)?.data ?? [];
}

function saveJob(job: AutoJob): void {
  // Working on it: the lease is renewed with every step.
  takeLease();
  job.updatedAt = now();
  // Read and written in one immediate transaction: the other copy of the shop (an update's
  // overlap) or the owner's dismiss never loses a write.
  getDb()
    .transaction(() => {
      const jobs = listJobs().filter((j) => j.id !== job.id);
      jobs.unshift(job);
      // Unfinished jobs are always kept; finished ones only the newest.
      let finished = 0;
      kvSet(
        JOBS_KEY,
        jobs.filter((j) => !(j.state === 'done' || j.state === 'needs_you') || ++finished <= KEEP)
      );
    })
    .immediate();
}

/** Whether new products get AI text and pictures, and why not when they can't. */
export function autoStatus(): {
  on: boolean;
  writer: boolean;
  pictures: boolean;
  angles: string[];
  why: string;
} {
  const on = getSettings('aiPictures').autoCreate !== false;
  const writer = aiStatus().ready;
  const pictures = stagingStatus().ready;
  const why = !on
    ? 'Switched off in Settings → AI pictures.'
    : !writer && !pictures
      ? 'Set up AI writing and AI pictures in Settings to have new products written and pictured for you.'
      : !writer
        ? 'AI writing is not set up (Settings → AI writing): type the name yourself.'
        : !pictures
          ? 'AI pictures are not set up (Settings → AI pictures): products are written but keep your photo only.'
          : '';
  return {
    on,
    writer: on && writer,
    pictures: on && pictures,
    angles: stagingStatus().angles.map((a) => a.name),
    why,
  };
}

const FIELDS = new Set(['key', 'photos', 'price', 'compareAtPrice', 'category', 'sizes', 'title', 'publish']);

/**
 * POST /api/admin/products/quick: { key, photos: ["/api/images/<name>", …], price, compareAtPrice?,
 * category, sizes: [{ id, stock }], title?, publish? }. Saves the product (hidden while the AI
 * works) and queues the job; answers at once.
 */
export function quickAdd(body: Record<string, unknown>, actor: string): { product: Product; job: AutoJob | null; replayed: boolean } {
  for (const k of Object.keys(body)) if (!FIELDS.has(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  const key = typeof body.key === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.key) ? body.key : '';
  if (!key) throw new HttpError(400, 'Missing request key.');
  const done = listJobs().find((j) => j.key === key);
  if (done) {
    const p = getProduct(done.productId);
    if (p) return { product: p, job: done, replayed: true };
  }
  const added = kvGet<Record<string, string>>('autoai:keys')?.data ?? {};
  if (added[key] && getProduct(added[key])) return { product: getProduct(added[key])!, job: null, replayed: true };

  if (!Array.isArray(body.photos) || body.photos.length < 1) throw new HttpError(400, 'Add at least one photo.');
  if (body.photos.length > PRODUCT_MAX_PHOTOS) throw new HttpError(400, `At most ${PRODUCT_MAX_PHOTOS} photos.`);
  const photos = body.photos.map((u) => {
    const name = typeof u === 'string' ? u.replace(/^\/api\/images\//, '') : '';
    if (!IMAGE_NAME.test(name) || !readImage(name)) throw new HttpError(400, 'A photo is no longer stored: add it again.');
    return `/api/images/${name}`;
  });
  const catalog = getSettings('catalog');
  const category = typeof body.category === 'string' && catalog.categories.some((c) => c.id === body.category) ? body.category : (catalog.categories[0]?.id ?? '');
  const productType = defaultTypeFor(catalog, category);
  if (!Array.isArray(body.sizes) || body.sizes.length < 1 || body.sizes.length > 12) throw new HttpError(400, productType === 'simple' ? 'Add the stock.' : 'Choose at least one size.');
  const profiles: BedProfileMeasurement[] = [];
  const stockBySize: Record<string, number> = {};
  for (const s of body.sizes) {
    const o = (s && typeof s === 'object' && !Array.isArray(s) ? s : {}) as Record<string, unknown>;
    const stock = Number(o.stock ?? 0);
    if (!Number.isInteger(stock) || stock < 0 || stock > 100_000) throw new HttpError(400, 'Stock: a whole number, 0 or more.');
    if (productType === 'simple') {
      if (profiles.length) throw new HttpError(400, 'One stock figure for this category (add variants later in the editor).');
      const v = blankVariant([]);
      profiles.push(v);
      stockBySize[v.id] = stock;
      continue;
    }
    const preset = catalog.sizes.find((x) => x.id === o.id);
    if (!preset) throw new HttpError(400, 'Unknown size: choose one from Settings → Catalogue.');
    if (stockBySize[preset.id] !== undefined) throw new HttpError(400, 'Each size once.');
    profiles.push(sizeFromPreset(preset));
    stockBySize[preset.id] = stock;
  }
  const status = autoStatus();
  const typed = typeof body.title === 'string' ? body.title.trim() : '';
  if (!typed && !status.writer) throw new HttpError(400, `Give it a name. ${status.why}`.trim());
  const publish = body.publish !== false;
  const runs = status.writer || status.pictures;
  const product = createProduct(
    {
      productType,
      title: typed || PLACEHOLDER_TITLE,
      category,
      price: body.price,
      compareAtPrice: body.compareAtPrice ?? null,
      material: '',
      threadCount: 0,
      colors: [],
      featuredImage: photos[0],
      galleryImages: photos.slice(1),
      profiles,
      defaultProfileId: profiles[0].id,
      stockBySize,
      // Shown once the AI has written and pictured it (or at once when nothing is left to do).
      active: runs ? false : publish,
      isFeatured: false,
      isNewArrival: true,
      measurementsReview: false,
    },
    actor
  );
  kvSet('autoai:keys', Object.fromEntries([...Object.entries(added).slice(-200), [key, product.id]]));
  audit('product.quick_added', {
    by: actor,
    productId: product.id,
    photos: photos.length,
    sizes: profiles.length,
    named: Boolean(typed),
    auto: runs,
    publish,
  });
  if (!runs) return { product, job: null, replayed: false };
  const plan = status.pictures ? picturePlan() : [];
  const job: AutoJob = {
    id: crypto.randomUUID(),
    key,
    productId: product.id,
    by: actor,
    state: 'queued',
    publish,
    named: Boolean(typed),
    written: !status.writer,
    plan,
    made: [],
    note: '',
    createdAt: now(),
    updatedAt: now(),
  };
  saveJob(job);
  kick();
  return { product, job, replayed: false };
}

/** The pictures to make: one per numbered angle in the owner's prompt, else the one-press scenes. */
export function picturePlan(): string[] {
  const settings = getSettings('aiPictures');
  const angles = anglesOf(settings);
  if (angles.length) return angles.map((_, i) => `angle:${i + 1}`);
  const set = (settings.defaultSet?.length ? settings.defaultSet : DEFAULT_STAGING_SET).filter((id) => sceneById(id));
  return set;
}

// ── the worker ──────────────────────────────────────────────────────────────

let running: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;
/** Tests: the waits, made instant. */
let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function _setSleep(fn: ((ms: number) => Promise<void>) | null) {
  sleep = fn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
}

/** Start the worker if it is not already running (after an add, and at start-up). */
export function kick(): Promise<void> {
  if (!running) {
    running = work().finally(() => {
      running = null;
    });
  }
  return running;
}

/** At start-up: jobs an update or a restart interrupted carry on; then checked every few minutes. */
export function startAutoAdd(): void {
  void kick();
  if (!timer) {
    timer = setInterval(() => void kick(), 5 * 60 * 1000);
    timer.unref();
  }
}

/** This running copy of the shop (two run side by side for a minute during an update). */
const INSTANCE = crypto.randomUUID();
const LEASE_KEY = 'autoai:lease';
/** A worker holds the lease while it works and renews it with every step; one that stopped loses it after this. */
const LEASE_MS = 3 * 60 * 1000;

/**
 * Only one copy of the shop works on the jobs at a time, so a picture is never paid for twice
 * during an update's overlap. Taken atomically in the database; renewed while working.
 */
export function takeLease(instance: string = INSTANCE, at = Date.now()): boolean {
  const db = getDb();
  return db
    .transaction(() => {
      const held = kvGet<{ by: string; until: number }>(LEASE_KEY)?.data;
      if (held && held.by !== instance && held.until > at) return false;
      kvSet(LEASE_KEY, { by: instance, until: at + LEASE_MS });
      return true;
    })
    .immediate();
}

function dropLease(): void {
  const held = kvGet<{ by: string; until: number }>(LEASE_KEY)?.data;
  if (held?.by === INSTANCE) kvSet(LEASE_KEY, { by: '', until: 0 });
}

async function work(): Promise<void> {
  try {
    await workHeld();
  } finally {
    dropLease();
  }
}

async function workHeld(): Promise<void> {
  for (;;) {
    if (!takeLease()) return;
    const next = listJobs()
      .filter((j) => j.state !== 'done' && j.state !== 'needs_you' && (!j.until || j.until <= now()))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return;
    try {
      await runJob(next);
    } catch (err) {
      // Never stops the worker: the job says why, and the next one runs.
      logEvent('error', 'autoadd_job_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      finish(next, 'needs_you', 'Something went wrong while writing this product. Open it to finish it, or add it again.');
    }
  }
}

/** How long a "wait" error asks for (the service's own time, else a minute), or null for any other error. */
function waitFor(err: unknown): number | null {
  if (!(err instanceof HttpError)) return null;
  const busy = err.details?.code === 'ai_busy' || err.status === 429;
  if (!busy) return null;
  const sec = Number(err.details?.retryAfterSec ?? err.headers?.['Retry-After'] ?? 60);
  return Math.min(MAX_WAIT_MS, Math.max(5_000, (Number.isFinite(sec) ? sec : 60) * 1000 + 2_000));
}

/** Runs fn; when the service asks to wait, waits (shown on the job) and tries again. */
async function patiently<T>(job: AutoJob, state: JobState, fn: () => Promise<T>): Promise<T> {
  // A long wait keeps the lease (renewed every minute), so the other copy never starts the same picture.
  for (let i = 0; ; i++) {
    try {
      job.state = state;
      delete job.until;
      saveJob(job);
      return await fn();
    } catch (err) {
      const ms = waitFor(err);
      if (ms === null || i >= MAX_WAITS) throw err;
      job.state = 'waiting';
      job.until = new Date(Date.now() + ms).toISOString();
      job.note = err instanceof Error ? err.message : '';
      saveJob(job);
      for (let left = ms; left > 0; left -= 60_000) {
        await sleep(Math.min(60_000, left));
        takeLease();
      }
    }
  }
}

function finish(job: AutoJob, state: 'done' | 'needs_you', note: string): void {
  job.state = state;
  job.note = note;
  delete job.until;
  saveJob(job);
}

const said = (err: unknown) => (err instanceof Error ? err.message : 'It did not work.');

async function runJob(job: AutoJob): Promise<void> {
  const product = getProduct(job.productId);
  if (!product) return finish(job, 'needs_you', 'The product was removed before it was finished.');
  const cover = product.featuredImage && !(product.stagedPhotos ?? {})[product.featuredImage] ? product.featuredImage : [product.featuredImage, ...product.galleryImages].find((u) => u && !(product.stagedPhotos ?? {})[u]);
  const coverName = (cover ?? '').replace(/^\/api\/images\//, '');
  const img = coverName ? readImage(coverName) : undefined;
  if (!img) return finish(job, 'needs_you', 'Its photo is no longer stored: add a photo in the editor.');
  let context: {
    title?: string;
    motif?: string;
    colors?: string[];
    design?: string;
  } = {
    title: product.title === PLACEHOLDER_TITLE ? undefined : product.title,
  };
  let writeProblem = '';

  // 1. The words.
  if (!job.written) {
    try {
      const s = await patiently(job, 'writing', () =>
        describeProduct(
          {
            imageId: coverName,
            hints: {
              category: product.category,
              sizes: product.profiles.map((p) => p.name),
            },
          },
          job.by
        )
      );
      const fresh = getProduct(job.productId);
      if (!fresh) return finish(job, 'needs_you', 'The product was removed before it was finished.');
      const title = job.named || fresh.title !== PLACEHOLDER_TITLE ? fresh.title : s.title;
      const patch: Record<string, unknown> = {
        ...(title !== fresh.title ? { title, sku: suggestSku(title, fresh.category, fresh.id) } : {}),
        ...(!fresh.shortDescription && s.shortDescription ? { shortDescription: s.shortDescription } : {}),
        ...(!fresh.description && s.description ? { description: s.description } : {}),
        ...(!fresh.colors.length && s.colors.length ? { colors: s.colors } : {}),
        ...(s.weave ? { weave: s.weave } : {}),
        ...(s.giftLine
          ? {
              giftLines: {
                ...(fresh.giftLines ?? {}),
                [s.giftFor]: s.giftLine,
              },
            }
          : {}),
      };
      if (Object.keys(patch).length) updateProduct(job.productId, patch, job.by);
      context = {
        title,
        motif: s.motif || undefined,
        colors: s.colors.map((c) => c.name),
        design: s.design || undefined,
      };
      job.written = true;
      saveJob(job);
    } catch (err) {
      writeProblem = said(err);
      logEvent('warn', 'autoadd_write_failed', {
        productId: job.productId,
        error: writeProblem,
      });
      if (!job.named) {
        // Pictures are still made (the owner then only types a name).
        job.written = true;
        job.note = `The words were not written: ${writeProblem}`;
        saveJob(job);
      }
    }
  }

  // 2. The pictures, one request each, one after another.
  const failures: string[] = [];
  for (let i = job.made.length; i < job.plan.length; i++) {
    const step = job.plan[i];
    const angle = step.startsWith('angle:') ? Number(step.slice(6)) : 0;
    const first = job.made.find(Boolean) ?? '';
    try {
      const body: Record<string, unknown> = {
        imageId: coverName,
        context,
        aspect: '4:5',
        ...(angle ? { angle } : { preset: step }),
        ...(first && angle ? { sameRoom: first } : {}),
      };
      if (img.bytes.length > SOURCE_MAX_BYTES) throw new HttpError(413, 'The photo is too large (at most 4 MB).');
      const r = await patiently(job, 'pictures', () => stagePhoto(body, job.by));
      job.made.push(r.url);
    } catch (err) {
      failures.push(said(err));
      job.made.push('');
      // A setup problem (no key, wrong model) fails every picture alike: stop here.
      if (err instanceof HttpError && err.details?.code === 'staging_off') {
        while (job.made.length < job.plan.length) job.made.push('');
      }
    }
    saveJob(job);
  }
  const made = job.made.filter(Boolean);
  if (made.length) {
    try {
      saveStyledPhotos(job.productId, made, job.by);
    } catch (err) {
      failures.push(said(err));
    }
  }

  // 3. Published (unless kept hidden, or it still has no name).
  const now2 = getProduct(job.productId);
  if (!now2) return finish(job, 'needs_you', 'The product was removed before it was finished.');
  const noName = now2.title === PLACEHOLDER_TITLE;
  if (job.publish && !noName && now2.active === false) updateProduct(job.productId, { active: true }, job.by);
  const pics = job.plan.length ? ` ${made.length} of ${job.plan.length} AI pictures made${failures.length ? ` (${failures[0]})` : ''}.` : '';
  if (noName) return finish(job, 'needs_you', `Give it a name to publish it. ${writeProblem ? `The words were not written: ${writeProblem}` : ''}${pics}`.trim());
  auditOrThrow('product.quick_finished', {
    by: job.by,
    productId: job.productId,
    written: !writeProblem,
    pictures: made.length,
    planned: job.plan.length,
    published: job.publish,
  });
  finish(job, failures.length || writeProblem ? 'needs_you' : 'done', `${job.publish ? 'In the shop.' : 'Ready (kept hidden).'}${writeProblem ? ` The words were not written: ${writeProblem}` : ''}${pics}`.trim());
}

/** "Needs you" on the list: dismissed once the owner has seen it (the product stays). */
export function dismissJob(id: unknown): void {
  if (typeof id !== 'string') throw new HttpError(400, 'Which one?');
  const job = listJobs().find((j) => j.id === id);
  if (!job) return;
  if (job.state !== 'done' && job.state !== 'needs_you') throw new HttpError(409, 'Still working on it.');
  getDb()
    .transaction(() =>
      kvSet(
        JOBS_KEY,
        listJobs().filter((j) => j.id !== id)
      )
    )
    .immediate();
}
