import net from 'node:net';
import type { AiSettings, AssistantSettings, BankTransferDetails, DeliverySettings, Emirate, BedProfileMeasurement, BrandSettings, CatalogSettings, CourierSettings, EmailSettings, FirebaseWebConfig, PaymentSettings, PhoneCheckMode, PhoneCheckSettings, PhoneVerificationConfig, SmsGatewaySettings, StoreSettings, ThemeSettings, LookSettings } from '@/types';
import { DEFAULT_LOOK_MODE, DEFAULT_LOOK_PRESET, LOOK_PRESETS, MODE_LABELS, isLookMode, isLookPreset } from '@/lib/design/themes';
import { FESTIVALS } from '@/lib/festivals/catalog';
import { marqueeItems, marqueeProblem, stripEmoji } from '@/lib/marquee';
import { DEFAULT_AI, DEFAULT_ASSISTANT, DEFAULT_CATALOG, DEFAULT_DELIVERY, DEFAULT_EMAIL_SETTINGS, DEFAULT_STORE, DEFAULT_THEME_SETTINGS } from '@/data/catalogDefaults';
import { INITIAL_BANK_DETAILS, INITIAL_BRAND_SETTINGS, INITIAL_COURIER_SETTINGS, INITIAL_SMS_SETTINGS } from '@/data/initialData';
import { getDb } from './db';
import { kvGet } from './kv';
import { jeeblyLiveBase } from '@/lib/jeeblyApi';
import { SMTP_PORTS, assertPublicMailHost } from './mail';
import { FIREBASE_PROJECT_ID } from './firebaseAuth';
import { bump, changedElsewhere } from './live';
import { envGateways } from '@/lib/otpService';
import { AI_MODELS, AI_PROVIDERS, DEEPSEEK_MODEL_ID, GEMINI_MODEL_ID } from '@/types';
import { HttpError } from './http';
import { IMAGE_NAME, acceptImageRef, cleanImage, LOGO_MAX_SIDE, readImage } from './images';
import { assertPublicHttpsUrl } from './outbound';
import { supportEmail as envSupportEmail } from './runtimeConfig';
import { DEFAULT_CARD_FEE_PERCENT, MAX_CARD_FEE_PERCENT } from '@/lib/money';
import { waMeLink } from '@/lib/whatsappConfirm';
import { DEFAULT_AI_PROMPT, FIELD_GUIDE_MAX, PROMPT_INSTRUCTIONS_MAX, WRITING_FIELDS, cleanGuide, cleanInstructions, type AiPromptSettings, type WritingFieldId } from '@/lib/aiPrompt';
import { FAL_KEY, FAL_KEY_HINT, FAL_MODEL_ID, OPENAI_IMAGE_MODEL_ID, OPENAI_KEY, OPENAI_KEY_HINT, PICTURE_PROVIDERS } from '@/lib/pictureProviders';
import { DEFAULT_AI_PICTURES, SCENE_ID, STYLE_MAX, STYLE_REFS_MAX, STYLE_SIDE_MAX, STAGING_LOOK_MAX, STAGING_MAX_SCENES, STAGING_NAME_MAX, STAGING_SCENE_MAX, STAGING_TRIO, oneLine, type AiPicturesSettings, type StagingScene } from '@/lib/staging';

/**
 * Shop settings, kept on the server so every visitor sees the same branding
 * and bank details, and the courier / SMS keys never reach a browser.
 *
 * Secrets are write-only: reads return them blank with a "saved" flag. On a
 * save, a non-empty secret replaces the stored one, an empty or missing one
 * keeps it, and null clears it. If the host a secret is sent to changes and no
 * new secret is given, the old secret is dropped (it was meant for the old host).
 */

export interface SettingsMap {
  brand: BrandSettings;
  bank: BankTransferDetails;
  courier: CourierSettings;
  sms: SmsGatewaySettings;
  catalog: CatalogSettings;
  store: StoreSettings;
  theme: ThemeSettings;
  email: EmailSettings;
  assistant: AssistantSettings;
  delivery: DeliverySettings;
  payments: PaymentSettings;
  phoneCheck: PhoneCheckSettings;
  look: LookSettings;
  ai: AiSettings;
  /** Settings → AI writing → Prompt: the shop's instructions and the field guides (the fixed rules are not settings). */
  aiPrompt: AiPromptSettings;
  /** Settings → AI pictures: the scenes, the default trio, the look and mood. */
  aiPictures: AiPicturesSettings;
}
export type SettingsKey = keyof SettingsMap;

const DEFAULTS: SettingsMap = {
  brand: INITIAL_BRAND_SETTINGS,
  // Empty until the owner enters the real account: bank transfer stays hidden until then.
  bank: INITIAL_BANK_DETAILS,

  // No keys, no pickup address and test mode until the owner enters their own.
  courier: {
    ...INITIAL_COURIER_SETTINGS,
    jeebly: { ...INITIAL_COURIER_SETTINGS.jeebly, apiKey: '', clientKey: '', sandboxApiKey: '', sandboxClientKey: '', isLive: false },
    echo: { ...INITIAL_COURIER_SETTINGS.echo, apiKey: '', isLive: false },
  },
  sms: {
    ...INITIAL_SMS_SETTINGS,
    twilio: { accountSid: '', authToken: '', fromNumber: '', verifyServiceSid: '' },
    infobip: { apiKey: '', baseUrl: 'https://api.infobip.com', fromSender: 'BUHome' },
    unifonic: { appSid: '', senderId: 'BUHome' },
    customWebhook: { endpointUrl: '', bearerToken: '' },
    isEnabled: false,
  },
  catalog: DEFAULT_CATALOG,
  store: DEFAULT_STORE,
  theme: DEFAULT_THEME_SETTINGS,
  email: DEFAULT_EMAIL_SETTINGS,
  assistant: DEFAULT_ASSISTANT,
  delivery: DEFAULT_DELIVERY,
  // Off, and no keys: checkout offers cash on delivery (and bank transfer) until the owner adds them.
  // The card fee the owner asked for (3.5%); bank transfer as the saved details allow (bankTransferMode()).
  payments: { cardEnabled: false, stripePublishableKey: '', stripeSecretKey: '', stripeWebhookSecret: '', cardFeePercent: DEFAULT_CARD_FEE_PERCENT, bankTransferMode: 'default' },
  // WhatsApp (free) for every shop, new or existing, until the owner chooses SMS codes.
  phoneCheck: { mode: 'whatsapp', unconfirmedCancelHours: 24, unopenedCancelHours: 6 },
  // Ivory & Gold, light or dark as the device is set (migration 13 records when it started).
  // Off, and no key: "Write from photo" explains how to switch it on.
  ai: DEFAULT_AI,
  aiPrompt: DEFAULT_AI_PROMPT,
  aiPictures: DEFAULT_AI_PICTURES,
  look: { preset: DEFAULT_LOOK_PRESET, mode: DEFAULT_LOOK_MODE, label: lookLabel(DEFAULT_LOOK_PRESET, DEFAULT_LOOK_MODE), changedAt: '', changedBy: '' },
};

/** "Noir & Champagne · Always dark". */
export function lookLabel(preset: LookSettings['preset'], mode: LookSettings['mode']): string {
  return `${LOOK_PRESETS[preset]?.name ?? preset} · ${MODE_LABELS[mode] ?? mode}`;
}

/** Where customers are asked to email: Settings → Store first, then NEXT_PUBLIC_SUPPORT_EMAIL. */
export function contactEmail(): string {
  return getSettings('store').supportEmail || envSupportEmail();
}

/** Paths of secret fields per settings group. */
const SECRETS: Record<SettingsKey, string[]> = {
  brand: [],
  bank: [],
  courier: ['jeebly.apiKey', 'jeebly.clientKey', 'jeebly.sandboxApiKey', 'jeebly.sandboxClientKey', 'echo.apiKey'],
  sms: ['twilio.authToken', 'infobip.apiKey', 'customWebhook.bearerToken', 'unifonic.appSid'],
  catalog: [],
  store: [],
  theme: [],
  email: ['smtpPass', 'imapPass'],
  assistant: [],
  delivery: [],
  payments: ['stripeSecretKey', 'stripeWebhookSecret'],
  phoneCheck: [],
  look: [],
  ai: ['anthropicApiKey', 'geminiApiKey', 'deepseekApiKey', 'openaiApiKey', 'falApiKey'],
  aiPrompt: [],
  aiPictures: [],
};

/** Secrets the admin hub may see the last 4 characters of (to tell which key is saved). */
const SHOW_LAST4 = new Set(['ai.anthropicApiKey', 'ai.geminiApiKey', 'ai.deepseekApiKey', 'ai.openaiApiKey', 'ai.falApiKey']);

const cache = new Map<SettingsKey, unknown>();

// The demo data's invented pickup (never the owner's): read as empty, so it never reaches a carrier or a label.
const SAMPLE_PICKUP_NAMES = new Set(['Beautiful UAE Home Artisan Studio', 'Beautiful UAE Home Central Warehouse']);
const SAMPLE_PICKUP_ADDRESSES = new Set(['Studio 08, Alserkal Avenue Creative Zone, Al Quoz 1', 'Warehouse 14, Al Quoz Industrial Area 3']);

export function getSettings<K extends SettingsKey>(key: K): SettingsMap[K] {
  if (cache.size && changedElsewhere('settings')) cache.clear();
  if (cache.has(key)) return cache.get(key) as SettingsMap[K];
  const row = getDb().prepare('SELECT data FROM settings WHERE key = ?').get(key) as { data: string } | undefined;
  const stored = row ? JSON.parse(row.data) : {};
  const merged = deepMerge(DEFAULTS[key], stored) as SettingsMap[K];
  // Shops still showing the old, long announcement lines get today's short ones.
  // Sample pickup details and account numbers older versions started with are not the owner's.
  if (key === 'courier') {
    const c = merged as unknown as CourierSettings;
    if (SAMPLE_PICKUP_NAMES.has(c.jeebly.pickupLocationName)) c.jeebly.pickupLocationName = '';
    if (SAMPLE_PICKUP_ADDRESSES.has(c.jeebly.pickupAddress)) c.jeebly.pickupAddress = '';
    if (c.echo.accountId === 'ECH-DXB-91402') c.echo.accountId = '';
    if (c.echo.hubCode === 'DXB-HUB-01') c.echo.hubCode = '';
  }
  // The chat's old default name: shops that never changed it get today's.
  if (key === 'assistant') {
    const a = merged as unknown as AssistantSettings;
    if (a.name === 'Shop assistant') a.name = DEFAULT_ASSISTANT.name;
  }
  if (key === 'brand') {
    const brand = merged as unknown as BrandSettings;
    brand.marquee = { ...brand.marquee, messages: marqueeItems(brand.marquee?.messages) };
  }
  cache.set(key, merged);
  return merged;
}

const HISTORY_KEEP = 30;
/**
 * Settings save themselves as the owner types (autosave). Changes within this long of the
 * previous one are one editing session: history keeps the version from before the session,
 * not every keystroke, so "Undo" and Settings history stay meaningful.
 */
const SESSION_MS = 2 * 60 * 1000;

/** The value without its secrets (history never keeps keys). */
function withoutSecrets(key: SettingsKey, value: unknown): Obj {
  const copy = structuredClone(value) as Obj;
  for (const p of SECRETS[key]) if (getPath(copy, p) !== undefined) setPath(copy, p, '');
  return copy;
}

function save<K extends SettingsKey>(key: K, value: SettingsMap[K], { keepHistory = false, auto = false, expectUpdatedAt }: { keepHistory?: boolean; auto?: boolean; expectUpdatedAt?: string | null } = {}) {
  // Keep the version being replaced, so it can be restored (Settings → System → History).
  const db = getDb();
  const before = db.prepare('SELECT data, updated_at FROM settings WHERE key = ?').get(key) as { data: string; updated_at: string } | undefined;
  // Two saves at once (an autosave still checking the mail server, and a Save): the one that read
  // older settings must not overwrite the newer ones.
  if (expectUpdatedAt !== undefined && (before?.updated_at ?? null) !== expectUpdatedAt) {
    throw new HttpError(409, 'These settings were changed meanwhile. Check them and save again.', {}, { code: 'changed_meanwhile' });
  }
  // Only autosaves are merged into one edit session, and only into one that began with an autosave
  // (an explicit Save just before is its own version: Undo must not go back past it).
  const lastAuto = db.prepare('SELECT data FROM kv WHERE key = ?').pluck().get(`settings:last-auto:${key}`) as string | undefined;
  const sameSession =
    auto &&
    !keepHistory &&
    before !== undefined &&
    lastAuto === JSON.stringify(before.updated_at) &&
    Date.now() - Date.parse(before.updated_at) < SESSION_MS;
  if (before && !sameSession) {
    db.prepare('INSERT INTO settings_history (key, data, saved_at) VALUES (?, ?, ?)').run(key, JSON.stringify(withoutSecrets(key, JSON.parse(before.data))), before.updated_at);
    // The last 30 per group; a version marked "pinned" (the look from before looks existed) stays.
    db.prepare(
      "DELETE FROM settings_history WHERE key = ? AND id NOT IN (SELECT id FROM settings_history WHERE key = ? ORDER BY id DESC LIMIT ?) AND json_extract(data, '$.pinned') IS NOT 1"
    ).run(key, key, HISTORY_KEEP);
  }
  const at = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO settings (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), at);
  // Remember whether this version came from an autosave (the next autosave may join its session).
  getDb()
    .prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(`settings:last-auto:${key}`, JSON.stringify(auto ? at : null), at);
  cache.set(key, value);
  bump('settings');
}

/** The version "Undo" goes back to: the newest one kept for this group (before the current editing session). */
export function undoVersionId(key: SettingsKey): number | null {
  const row = getDb().prepare('SELECT id FROM settings_history WHERE key = ? ORDER BY id DESC LIMIT 1').get(key) as { id: number } | undefined;
  return row?.id ?? null;
}

export interface SettingsVersion {
  id: number;
  key: SettingsKey;
  savedAt: string;
}

/** Earlier versions, newest first (for Settings → System). */
export function settingsHistory(limit = 60): SettingsVersion[] {
  return (getDb().prepare('SELECT id, key, saved_at FROM settings_history ORDER BY id DESC LIMIT ?').all(Math.min(200, limit)) as Array<{ id: number; key: SettingsKey; saved_at: string }>).map(
    (r) => ({ id: r.id, key: r.key, savedAt: r.saved_at })
  );
}

/**
 * Put an earlier version back. Keys are not in history, so the keys saved now
 * stay. The version replaced by this restore is itself kept, so it can be undone.
 */
export async function restoreSettingsVersion(id: number, by = ''): Promise<SettingsKey> {
  const row = getDb().prepare('SELECT key, data FROM settings_history WHERE id = ?').get(id) as { key: SettingsKey; data: string } | undefined;
  if (!row || !(row.key in DEFAULTS)) throw new HttpError(404, 'That version is no longer kept.');
  const key = row.key;
  // A look put back is a new change: now, by whoever put it back, named after the one restored.
  if (key === 'look') {
    const old = JSON.parse(row.data) as Partial<LookSettings>;
    await updateSettings('look', { preset: old.preset, mode: old.mode, label: `Switched back to: ${String(old.label || lookLabel(old.preset as LookSettings['preset'], old.mode as LookSettings['mode'])).replace(/^(Switched back to: )+/, '')}`.slice(0, 120), changedBy: by }, { keepHistory: true });
    return key;
  }
  // Saved like any other change: validated, and keys follow their host (a key saved for
  // today's address is not sent to an older one). Blank keys mean "keep the saved key".
  const old = JSON.parse(row.data) as Obj;
  // A payments version from before the card fee and bank choice existed keeps today's (not the defaults).
  if (key === 'payments') {
    const now = getSettings('payments');
    if (!('cardFeePercent' in old)) old.cardFeePercent = now.cardFeePercent;
    if (!('bankTransferMode' in old)) old.bankTransferMode = now.bankTransferMode;
  }
  const restored = deepMerge(DEFAULTS[key], old) as Obj;
  for (const p of SECRETS[key]) setPath(restored, p, '');
  // A restore is always kept in history (it can itself be undone), even mid-session.
  await updateSettings(key, restored, { keepHistory: true });
  return key;
}

/** What the admin hub may see: secrets blanked, with which ones are saved. */
export function adminView<K extends SettingsKey>(key: K): { value: SettingsMap[K]; secretsSet: Record<string, boolean>; secretsHint?: Record<string, string> } {
  const value = structuredClone(getSettings(key)) as unknown as Record<string, unknown>;
  const secretsSet: Record<string, boolean> = {};
  const secretsHint: Record<string, string> = {};
  for (const p of SECRETS[key]) {
    const saved = String(getPath(value, p) ?? '');
    secretsSet[p] = Boolean(saved);
    // ••••last4 (never more, and only for a key long enough that 4 characters say nothing about it).
    if (saved.length >= 20 && SHOW_LAST4.has(`${key}.${p}`)) secretsHint[p] = `••••${saved.slice(-4)}`;
    setPath(value, p, '');
  }
  return { value: value as unknown as SettingsMap[K], secretsSet, ...(Object.keys(secretsHint).length ? { secretsHint } : {}) };
}

export interface UpdateOptions<K extends SettingsKey> {
  keepHistory?: boolean;
  /** An autosave: merged into the current edit session, and never allowed to drop a saved key. */
  auto?: boolean;
  /** Runs on the complete new settings (keys included) before they are stored; throwing keeps the current ones. */
  beforeSave?: (next: SettingsMap[K], current: SettingsMap[K]) => Promise<void>;
  /**
   * Courier only: the owner's audited "Turn on without a sandbox check" (POST /api/courier/live).
   * Nothing else can switch Jeebly Live on without a passed Sandbox check.
   */
  liveOverride?: boolean;
}

/** How long a passed Sandbox check lets Jeebly Live mode be switched on. */
export const SANDBOX_CHECK_DAYS = 30;
export const SANDBOX_CHECK_KV = 'courier:sandbox-check';

/** True when the last Sandbox check passed within SANDBOX_CHECK_DAYS. */
export function sandboxCheckFresh(now = Date.now()): boolean {
  const last = kvGet<{ passed?: boolean; at?: string }>(SANDBOX_CHECK_KV)?.data;
  if (!last?.passed || !last.at) return false;
  const at = Date.parse(last.at);
  return Number.isFinite(at) && now - at <= SANDBOX_CHECK_DAYS * 86_400_000 && at <= now + 60_000;
}

export async function updateSettings<K extends SettingsKey>(key: K, input: unknown, options: UpdateOptions<K> = {}): Promise<void> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Settings must be an object.');
  const current = getSettings(key);
  const currentAt = (getDb().prepare('SELECT updated_at FROM settings WHERE key = ?').get(key) as { updated_at: string } | undefined)?.updated_at ?? null;
  const next = await VALIDATORS[key](input as Record<string, unknown>, current as never);

  // Write-only secrets.
  for (const p of SECRETS[key]) {
    const given = getPath(input as Record<string, unknown>, p);
    if (given === null) setPath(next, p, '');
    else if (typeof given === 'string' && given.trim()) setPath(next, p, given.trim().slice(0, 500));
    else setPath(next, p, getPath(current as unknown as Record<string, unknown>, p) ?? '');
  }
  // A secret follows its host: a new host without a new secret drops the old one.
  if (key === 'email') {
    const e = next as unknown as EmailSettings;
    const i = input as { smtpPass?: unknown };
    if (e.smtpHost.toLowerCase() !== (current as EmailSettings).smtpHost.toLowerCase() && !nonEmpty(i.smtpPass)) e.smtpPass = '';
    const ii = input as { imapPass?: unknown };
    if (e.imapHost.toLowerCase() !== (current as EmailSettings).imapHost.toLowerCase() && !nonEmpty(ii.imapPass)) e.imapPass = '';
  }
  if (key === 'sms') {
    const sms = next as unknown as SmsGatewaySettings;
    const was = current as SmsGatewaySettings;
    const i = input as { infobip?: { apiKey?: unknown }; customWebhook?: { bearerToken?: unknown } };
    if (hostOf(sms.infobip.baseUrl) !== hostOf(was.infobip.baseUrl) && !nonEmpty(i.infobip?.apiKey)) sms.infobip.apiKey = '';
    if (hostOf(sms.customWebhook.endpointUrl) !== hostOf(was.customWebhook.endpointUrl) && !nonEmpty(i.customWebhook?.bearerToken)) {
      sms.customWebhook.bearerToken = '';
    }
  }
  if (key === 'courier') {
    // The live keys follow Jeebly's live address: moved to another host, they are dropped unless typed again.
    const c = next as unknown as CourierSettings;
    const was = (current as CourierSettings).jeebly.liveBaseUrl || '';
    const i = input as { jeebly?: { apiKey?: unknown; clientKey?: unknown } };
    if (was && hostOf(c.jeebly.liveBaseUrl || '') !== hostOf(was)) {
      if (!nonEmpty(i.jeebly?.apiKey)) c.jeebly.apiKey = '';
      if (!nonEmpty(i.jeebly?.clientKey)) c.jeebly.clientKey = '';
    }
  }
  // An autosave never removes a saved key (a half-typed new address would): that takes Save with the key.
  if (options.auto) {
    for (const p of SECRETS[key]) {
      if (getPath(current as unknown as Obj, p) && !getPath(next as unknown as Obj, p)) {
        throw new HttpError(409, 'Changing this address removes the saved password or key. Type the new one and press Save.', {}, { code: 'needs_save' });
      }
    }
  }
  // Switched on means checkout sends codes through it, so the chosen gateway must be complete.
  if (key === 'sms') {
    const sms = next as unknown as SmsGatewaySettings;
    const missing =
      sms.provider === 'twilio'
        ? !(sms.twilio.accountSid && sms.twilio.authToken && sms.twilio.fromNumber)
        : sms.provider === 'infobip'
        ? !(sms.infobip.apiKey && sms.infobip.baseUrl)
        : sms.provider === 'custom_webhook'
        ? !sms.customWebhook.endpointUrl
        : sms.provider === 'firebase'
        ? !firebaseConfigComplete(sms.firebase)
        : true;
    if (sms.isEnabled && missing) throw new HttpError(400, 'Fill in every field for the chosen SMS gateway before switching it on.');
  }
  // Card payments switched on means checkout takes cards: all three keys, from the same mode.
  if (key === 'payments') {
    const p = next as unknown as PaymentSettings;
    if (p.cardEnabled && !cardKeysComplete(p)) throw new HttpError(400, 'Add the publishable key, the secret key and the webhook signing secret before switching card payments on.');
    if (p.stripePublishableKey && p.stripeSecretKey && stripeMode(p.stripePublishableKey) !== stripeMode(p.stripeSecretKey)) {
      throw new HttpError(400, 'The publishable key and the secret key are from different modes (one test, one live). Use the pair from the same Stripe page.');
    }
  }
  // Jeebly Live books real shipments: only after a passed Sandbox check (or the owner's audited override).
  if (key === 'courier') {
    const c = next as unknown as CourierSettings;
    if (c.jeebly.isLive && !(current as CourierSettings).jeebly.isLive && !c.jeebly.liveBaseUrl) {
      throw new HttpError(409, "Add Jeebly's live address (Jeebly gives it with your production keys) before turning on Live mode.", {}, { code: 'live_base_required' });
    }
    if (c.jeebly.isLive && !(current as CourierSettings).jeebly.isLive && !options.liveOverride && !sandboxCheckFresh()) {
      throw new HttpError(409, `Run the Sandbox check first: Jeebly Live mode can be switched on after a Sandbox check has passed (within ${SANDBOX_CHECK_DAYS} days).`, {}, { code: 'sandbox_check_required' });
    }
  }
  // AI writing on means "Write from photo" calls the chosen AI: it needs that AI's key. Clearing
  // the chosen AI's key switches it off.
  if (key === 'ai') {
    const a = next as unknown as AiSettings;
    const activeKey = a.provider === 'gemini' ? 'geminiApiKey' : a.provider === 'deepseek' ? 'deepseekApiKey' : 'anthropicApiKey';
    if (getPath(input as Obj, activeKey) === null) a.enabled = false;
    if (a.enabled && !a[activeKey]) {
      throw new HttpError(400, a.provider === 'gemini' ? 'Add your Gemini API key before switching AI writing on with Gemini.' : a.provider === 'deepseek' ? 'Add your DeepSeek API key before switching AI writing on with DeepSeek.' : 'Add your Anthropic API key before switching AI writing on.');
    }
  }
  if (options.beforeSave) await options.beforeSave(next as SettingsMap[K], current);
  save(key, next as SettingsMap[K], { keepHistory: options.keepHistory, auto: options.auto, expectUpdatedAt: currentAt });
}

/**
 * For "test connection" buttons: the settings typed in the form, with any
 * blank secret filled from the saved one (the form never sees saved secrets).
 */
export function withStoredSecrets<K extends SettingsKey>(key: K, input: unknown): Record<string, unknown> {
  const copy = structuredClone(input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const saved = getSettings(key) as unknown as Record<string, unknown>;
  // A saved secret only goes to the host it was saved for: a test aimed at a new
  // host must bring its own key, or it could be used to send the key elsewhere.
  const savedHost: Record<string, string> = {};
  const typedHost: Record<string, string> = {};
  for (const [secret, urlPath] of Object.entries(SECRET_HOSTS[key])) {
    const typed = getPath(copy, urlPath);
    savedHost[secret] = hostOf(String(getPath(saved, urlPath) ?? ''));
    typedHost[secret] = typed === undefined ? savedHost[secret] : hostOf(String(typed ?? ''));
  }
  for (const p of SECRETS[key]) {
    const given = getPath(copy, p);
    if (typeof given === 'string' && given.trim()) continue;
    setPath(copy, p, p in savedHost && typedHost[p] !== savedHost[p] ? '' : getPath(saved, p) ?? '');
  }
  return copy;
}

/** Secrets tied to a URL a person can change: secret path → URL path. */
const SECRET_HOSTS: Record<SettingsKey, Record<string, string>> = {
  brand: {},
  bank: {},
  courier: { 'jeebly.apiKey': 'jeebly.liveBaseUrl', 'jeebly.clientKey': 'jeebly.liveBaseUrl' },
  sms: { 'infobip.apiKey': 'infobip.baseUrl', 'customWebhook.bearerToken': 'customWebhook.endpointUrl' },
  catalog: {},
  store: {},
  theme: {},
  look: {},
  email: {},
  assistant: {},
  delivery: {},
  payments: {},
  phoneCheck: {},
  ai: {},
  aiPrompt: {},
  aiPictures: {},
};

/**
 * Blank every saved secret in a copy of the database (used on the backup
 * snapshot, so courier and SMS keys never leave the server in an email).
 * The caller VACUUMs afterwards so the old values are not left in free pages.
 */
export function blankSecretsIn(db: import('better-sqlite3').Database): void {
  const rows = db.prepare('SELECT key, data FROM settings').all() as Array<{ key: string; data: string }>;
  const update = db.prepare('UPDATE settings SET data = ? WHERE key = ?');
  for (const row of rows) {
    const paths = SECRETS[row.key as SettingsKey];
    if (!paths?.length) continue;
    let value: Obj;
    try {
      value = JSON.parse(row.data);
    } catch {
      update.run('{}', row.key);
      continue;
    }
    for (const p of paths) if (getPath(value, p) !== undefined) setPath(value, p, '');
    update.run(JSON.stringify(value), row.key);
  }
}

// ── Validation (allow-lists; strings capped) ────────────────────────────────

/** AE + 21 digits with a correct ISO 13616 (mod-97) check: catches nearly every typo. */
export function validUaeIban(compact: string): boolean {
  if (!/^AE\d{21}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + '1014' + compact.slice(2, 4); // A=10, E=14
  let rest = 0;
  for (const d of rearranged) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

/** "test" or "live", from a Stripe key's prefix (pk_test_…, sk_live_…, rk_test_…). */
export function stripeMode(key: string): 'test' | 'live' | null {
  const m = /^(?:pk|sk|rk)_(test|live)_/.exec(key);
  return m ? (m[1] as 'test' | 'live') : null;
}

export function cardKeysComplete(p: PaymentSettings): boolean {
  return Boolean(p.stripePublishableKey && p.stripeSecretKey && p.stripeWebhookSecret);
}

/** Card payments are offered at checkout: switched on, with every key. */
export function cardPaymentsReady(p: PaymentSettings = getSettings('payments')): boolean {
  return p.cardEnabled && cardKeysComplete(p);
}

const BANK_MODES: PaymentSettings['bankTransferMode'][] = ['default', 'send_details', 'ask_whatsapp', 'off'];
const STRIPE_PUBLISHABLE = /^pk_(test|live)_[A-Za-z0-9]{10,240}$/;
const STRIPE_SECRET = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,240}$/;
const STRIPE_WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_-]{10,240}$/;

/** The real account is entered (bank details can be sent automatically). */
export function bankTransferReady(bank: BankTransferDetails): boolean {
  return Boolean(bank.iban && bank.accountName && bank.bankName);
}

/**
 * How checkout offers bank transfer now (Settings → Payments → Bank transfer), or null when it
 * doesn't: 'send_details' needs the account saved (without it, customers ask on WhatsApp when there
 * is a number), 'ask_whatsapp' the shop's WhatsApp number.
 * "default": send_details with an account, else ask_whatsapp with a number, else off.
 */
export function bankTransferMode(): 'send_details' | 'ask_whatsapp' | null {
  const chosen = getSettings('payments').bankTransferMode;
  const account = bankTransferReady(getSettings('bank'));
  const whatsapp = Boolean(waMeLink(getSettings('store').whatsappNumber, ''));
  if (chosen === 'off') return null;
  // The account was deleted: customers can still ask for it on WhatsApp rather than lose bank transfer.
  if (chosen === 'send_details') return account ? 'send_details' : whatsapp ? 'ask_whatsapp' : null;
  if (chosen === 'ask_whatsapp') return whatsapp ? 'ask_whatsapp' : null;
  return account ? 'send_details' : whatsapp ? 'ask_whatsapp' : null;
}

/** Bank-transfer orders "on request" (asked for on WhatsApp) still waiting for payment, not cancelled. */
export function openOnRequestTransfers(): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM orders WHERE payment_method = 'bank_transfer' AND bank_state IN ('awaiting', 'uploaded', 'not_received') AND status <> 'cancelled' AND json_extract(data, '$.bankDetailsBy') = 'whatsapp'")
      .get() as { n: number }
  ).n;
}

/** Settings → Payments "Card payment fee (%)": 0 (off) to 10, up to 2 decimals. */
export function cardFeePercent(p: PaymentSettings = getSettings('payments')): number {
  const v = Number(p.cardFeePercent);
  return Number.isFinite(v) && v > 0 && v <= MAX_CARD_FEE_PERCENT ? v : 0;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== '';

function text(v: unknown, field: string, max: number, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/** Like text(), keeping line breaks (answers, greetings). */
function longText(v: unknown, field: string, max: number, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The announcement bar's lines: up to 3, each up to 60 characters, emoji removed. Longer or more
 * are refused with a reason (the settings card shows the same limits as the owner types).
 */
function announcementLines(messages: unknown[], typed: boolean): string[] {
  const lines = messages.map((m, i) => stripEmoji(text(m, `Announcement ${i + 1}`, 500)));
  if (!typed) return marqueeItems(lines);
  const problem = marqueeProblem(lines);
  if (problem) throw new HttpError(400, problem);
  return lines.filter(Boolean);
}

const EMIRATES = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'];

const VALIDATORS: { [K in SettingsKey]: (input: Obj, current: SettingsMap[K]) => Promise<SettingsMap[K]> } = {
  async brand(input, current) {
    const marquee = obj(input.marquee);
    const messages = Array.isArray(marquee.messages) ? marquee.messages : current.marquee.messages;
    const accent = text(input.accentColor, 'Accent colour', 7, current.accentColor);
    if (!/^#[0-9a-fA-F]{6}$/.test(accent)) throw new HttpError(400, 'Accent colour must look like #c5a059.');
    const speed = Number(marquee.speedSeconds ?? current.marquee.speedSeconds);
    return {
      storeName: text(input.storeName, 'Store name', 60, current.storeName) || current.storeName,
      tagline: text(input.tagline, 'Tagline', 120, current.tagline),
      badgeText: text(input.badgeText, 'Badge', 30, current.badgeText),
      logoType: input.logoType === 'image' ? 'image' : 'text',
      logoText: text(input.logoText, 'Logo text', 4, current.logoText),
      logoImageUrl: input.logoImageUrl === undefined ? current.logoImageUrl : acceptImageRef(input.logoImageUrl, 'Logo image', { maxSide: LOGO_MAX_SIDE }),
      accentColor: accent,
      marquee: {
        enabled: bool(marquee.enabled, current.marquee.enabled),
        speedSeconds: Number.isFinite(speed) ? Math.min(120, Math.max(5, Math.round(speed))) : current.marquee.speedSeconds,
        messages: announcementLines(messages, Array.isArray(marquee.messages)),
      },
    };
  },

  async bank(input, current) {
    const typed = text(input.iban, 'IBAN', 40, current.iban).replace(/\s+/g, '').toUpperCase();
    if (typed && !validUaeIban(typed)) throw new HttpError(400, 'Please check the IBAN: a UAE IBAN is AE followed by 21 digits, and this one does not add up.');
    const iban = typed.replace(/(.{4})/g, '$1 ').trim();
    return {
      bankName: text(input.bankName, 'Bank name', 80, current.bankName),
      accountName: text(input.accountName, 'Account name', 120, current.accountName),
      accountNumber: text(input.accountNumber, 'Account number', 40, current.accountNumber),
      iban,
      swiftCode: text(input.swiftCode, 'SWIFT code', 11, current.swiftCode).toUpperCase(),
      branch: text(input.branch, 'Branch', 120, current.branch),
      instructions: text(input.instructions, 'Instructions', 500, current.instructions),
    };
  },

  async courier(input, current) {
    // Jeebly's production address, from Jeebly: https on a jeebly.com host only (keys are sent there).
    const liveBase = (v: unknown, fallback: string) => {
      const typed = text(v, 'Jeebly live address', 200, fallback);
      if (!typed) return '';
      const ok = jeeblyLiveBase(typed);
      if (!ok) throw new HttpError(400, 'Jeebly live address must be an https address on jeebly.com (as Jeebly gave it, e.g. https://….jeebly.com).');
      return ok;
    };
    const rules = obj(input.autoAssignRules);
    const j = obj(input.jeebly);
    const e = obj(input.echo);
    const provider = (v: unknown, fallback: 'jeebly' | 'echo' | 'manual') => (v === 'jeebly' || v === 'echo' || v === 'manual' ? v : fallback);
    const pickupEmirate = text(j.pickupEmirate, 'Pickup emirate', 40, current.jeebly.pickupEmirate);
    if (!EMIRATES.includes(pickupEmirate)) throw new HttpError(400, 'Pickup emirate must be one of the seven Emirates.');
    const packaging = input.packagingGrams === undefined || input.packagingGrams === null || input.packagingGrams === '' ? current.packagingGrams ?? 200 : Number(input.packagingGrams);
    if (!Number.isInteger(packaging) || packaging < 0 || packaging > 5000) throw new HttpError(400, 'Packaging weight must be whole grams from 0 to 5000.');
    return {
      packagingGrams: packaging,
      autoAssignRules: {
        codCourier: provider(rules.codCourier, current.autoAssignRules.codCourier),
        prepaidCourier: provider(rules.prepaidCourier, current.autoAssignRules.prepaidCourier),
      },
      jeebly: {
        apiKey: '',
        clientKey: '',
        sandboxApiKey: '',
        sandboxClientKey: '',
        serviceType: j.serviceType === 'Express' ? 'Express' : j.serviceType === 'Scheduled' ? 'Scheduled' : current.jeebly.serviceType,
        isLive: bool(j.isLive, current.jeebly.isLive),
        pickupLocationName: text(j.pickupLocationName, 'Pickup location', 120, current.jeebly.pickupLocationName),
        pickupPhone: text(j.pickupPhone, 'Pickup phone', 32, current.jeebly.pickupPhone),
        pickupAddress: text(j.pickupAddress, 'Pickup address', 200, current.jeebly.pickupAddress),
        liveBaseUrl: liveBase(j.liveBaseUrl, current.jeebly.liveBaseUrl ?? ''),
        pickupBuilding: text(j.pickupBuilding, 'Pickup building', 120, current.jeebly.pickupBuilding ?? ''),
        pickupArea: text(j.pickupArea, 'Pickup area', 120, current.jeebly.pickupArea ?? ''),
        pickupUnit: text(j.pickupUnit, 'Pickup unit', 40, current.jeebly.pickupUnit ?? ''),
        pickupLandmark: text(j.pickupLandmark, 'Pickup landmark', 120, current.jeebly.pickupLandmark ?? ''),
        pickupEmirate: pickupEmirate as CourierSettings['jeebly']['pickupEmirate'],
      },
      echo: {
        apiKey: '',
        accountId: text(e.accountId, 'Eco Express account', 80, current.echo.accountId),
        isLive: bool(e.isLive, current.echo.isLive),
        hubCode: text(e.hubCode, 'Hub code', 40, current.echo.hubCode),
        serviceTier: text(e.serviceTier, 'Service tier', 60, current.echo.serviceTier),
      },
    };
  },

  async sms(input, current) {
    const t = obj(input.twilio);
    const i = obj(input.infobip);
    const w = obj(input.customWebhook);
    // Unifonic is not wired to checkout, so it can't be chosen (it would look active and send nothing).
    const providers = ['twilio', 'infobip', 'custom_webhook', 'firebase'] as const;
    if (input.provider !== undefined && !providers.includes(input.provider as never)) throw new HttpError(400, 'Choose Twilio, Infobip, a webhook or Firebase.');
    const providerValue = (input.provider as SmsGatewaySettings['provider']) ?? (current.provider === 'unifonic' ? 'twilio' : current.provider);
    const senderId = text(input.senderId, 'Sender ID', 11, current.senderId) || 'BUHome';
    if (!/^[A-Za-z0-9 ]{1,11}$/.test(senderId)) throw new HttpError(400, 'Sender ID: up to 11 letters or digits.');
    const accountSid = text(t.accountSid, 'Twilio account SID', 34, current.twilio.accountSid);
    if (accountSid && !/^AC[0-9a-f]{32}$/i.test(accountSid)) throw new HttpError(400, 'Twilio account SID starts with AC followed by 32 characters.');
    const fromNumber = text(t.fromNumber, 'Twilio sender number', 20, current.twilio.fromNumber);
    if (fromNumber && !/^\+[1-9]\d{6,14}$/.test(fromNumber.replace(/\s/g, ''))) throw new HttpError(400, 'Twilio sender number must be in +country format.');
    const baseUrl = text(i.baseUrl, 'Infobip base URL', 200, current.infobip.baseUrl);
    if (baseUrl && baseUrl !== current.infobip.baseUrl) await assertPublicHttpsUrl(baseUrl, 'Infobip base URL');
    const endpointUrl = text(w.endpointUrl, 'Webhook URL', 500, current.customWebhook.endpointUrl);
    if (endpointUrl && endpointUrl !== current.customWebhook.endpointUrl) await assertPublicHttpsUrl(endpointUrl, 'Webhook URL');
    return {
      provider: providerValue,
      senderId,
      twilio: { accountSid, authToken: '', fromNumber: fromNumber.replace(/\s/g, ''), verifyServiceSid: '' },
      infobip: { apiKey: '', baseUrl, fromSender: senderId },
      unifonic: { appSid: '', senderId },
      customWebhook: { endpointUrl, bearerToken: '' },
      firebase: firebaseConfig(obj(input.firebase), current.firebase ?? EMPTY_FIREBASE),
      isEnabled: bool(input.isEnabled, current.isEnabled),
    };
  },

  async catalog(input, current) {
    const sizesIn = input.sizes === undefined ? current.sizes : input.sizes;
    if (!Array.isArray(sizesIn) || sizesIn.length === 0 || sizesIn.length > 20) throw new HttpError(400, 'Keep 1 to 20 size presets.');
    const sizes = sizesIn.map((s, i) => validateSizePreset(s, i));
    if (new Set(sizes.map((s) => s.id)).size !== sizes.length) throw new HttpError(400, 'Each size preset needs its own id.');
    const catsIn = input.categories === undefined ? current.categories : input.categories;
    if (!Array.isArray(catsIn) || catsIn.length === 0 || catsIn.length > 30) throw new HttpError(400, 'Keep 1 to 30 categories.');
    const categories = catsIn.map((c, i) => {
      const o = obj(c);
      const id = text(o.id, `Category ${i + 1} id`, 40);
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new HttpError(400, `Category ${i + 1}: the id may use only lowercase letters, digits and dashes.`);
      const label = text(o.label, `Category ${i + 1} name`, 40);
      if (!label) throw new HttpError(400, `Category ${i + 1} needs a name.`);
      // What a new product in it starts as (towels, cushions…: simple); kept only when simple.
      if (o.defaultType !== undefined && o.defaultType !== null && o.defaultType !== '' && o.defaultType !== 'bedding' && o.defaultType !== 'simple') throw new HttpError(400, `Category ${i + 1}: the default type must be bed linen or other.`);
      return { id, label, icon: text(o.icon, `Category ${i + 1} icon`, 8), ...(o.defaultType === 'simple' ? { defaultType: 'simple' as const } : {}) };
    });
    if (new Set(categories.map((c) => c.id)).size !== categories.length) throw new HttpError(400, 'Each category needs its own id.');
    const threshold = input.lowStockThreshold === undefined ? current.lowStockThreshold : Number(input.lowStockThreshold);
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 50) throw new HttpError(400, 'Low-stock warning must be a whole number from 0 to 50.');
    const weaves = input.weaves === undefined ? current.weaves : cleanWeaves(input.weaves);
    // A weave products still use can't go: they would show a weave the shop no longer has.
    for (const gone of current.weaves.filter((w) => !weaves.includes(w))) {
      const using = productsWithWeave(gone);
      if (using.length) {
        const names = using.slice(0, 5).map((p) => p.title).join(', ');
        throw new HttpError(
          400,
          `“${gone}” is still the weave of ${using.length} ${using.length === 1 ? 'product' : 'products'} (${names}${using.length > 5 ? ', …' : ''}). Change their weave first, or use Rename to move them to another weave.`,
          {},
          { code: 'weave_in_use', weave: gone, count: using.length }
        );
      }
    }
    return { sizes, categories, lowStockThreshold: threshold, weaves };
  },

  async ai(input, current) {
    const model = input.model === undefined ? current.model : input.model;
    if (!AI_MODELS.includes(model as AiSettings['model'])) throw new HttpError(400, `Model: one of ${AI_MODELS.join(', ')}.`);
    const provider = input.provider === undefined ? current.provider : input.provider;
    if (!AI_PROVIDERS.includes(provider as AiSettings['provider'])) throw new HttpError(400, 'Writing AI: Anthropic, Gemini or DeepSeek.');
    // Gemini model ids come from Google's own list (Test); only their shape is checked here.
    const geminiModel = input.geminiModel === undefined ? current.geminiModel : input.geminiModel;
    if (typeof geminiModel !== 'string' || (geminiModel !== '' && !GEMINI_MODEL_ID.test(geminiModel))) throw new HttpError(400, 'Gemini writing model: press Test and choose one from the list.');
    const geminiImageModel = input.geminiImageModel === undefined ? current.geminiImageModel : input.geminiImageModel;
    if (typeof geminiImageModel !== 'string' || !GEMINI_MODEL_ID.test(geminiImageModel)) throw new HttpError(400, 'Gemini image model: press Test and choose one from the list.');
    // DeepSeek model ids come from DeepSeek's own list (Test) too; only their shape is checked here.
    const deepseekModel = input.deepseekModel === undefined ? current.deepseekModel : input.deepseekModel;
    if (typeof deepseekModel !== 'string' || !DEEPSEEK_MODEL_ID.test(deepseekModel)) throw new HttpError(400, 'DeepSeek model: press Test and choose one from the list.');
    // The keys are kept or replaced after this (write-only); only their shape is checked here.
    const k = input.anthropicApiKey;
    if (k !== undefined && k !== null && typeof k !== 'string') throw new HttpError(400, 'The API key must be text.');
    if (typeof k === 'string' && k.trim() && !ANTHROPIC_KEY.test(k.trim())) throw new HttpError(400, 'An Anthropic API key starts with sk-ant- (console.anthropic.com → API keys).');
    const g = input.geminiApiKey;
    if (g !== undefined && g !== null && typeof g !== 'string') throw new HttpError(400, 'The API key must be text.');
    if (typeof g === 'string' && g.trim() && !GEMINI_KEY.test(g.trim())) throw new HttpError(400, GEMINI_KEY_HINT);
    const ds = input.deepseekApiKey;
    if (ds !== undefined && ds !== null && typeof ds !== 'string') throw new HttpError(400, 'The API key must be text.');
    if (typeof ds === 'string' && ds.trim() && !DEEPSEEK_KEY.test(ds.trim())) throw new HttpError(400, DEEPSEEK_KEY_HINT);
    // AI pictures: who makes them, their keys (shape only here) and models.
    const picturesProvider = input.picturesProvider === undefined ? current.picturesProvider ?? '' : input.picturesProvider;
    if (picturesProvider !== '' && !(PICTURE_PROVIDERS as readonly unknown[]).includes(picturesProvider)) throw new HttpError(400, 'Pictures: Google Gemini, OpenAI or fal.ai.');
    const oa = input.openaiApiKey;
    if (oa !== undefined && oa !== null && typeof oa !== 'string') throw new HttpError(400, 'The API key must be text.');
    if (typeof oa === 'string' && oa.trim() && !OPENAI_KEY.test(oa.trim())) throw new HttpError(400, OPENAI_KEY_HINT);
    const fk = input.falApiKey;
    if (fk !== undefined && fk !== null && typeof fk !== 'string') throw new HttpError(400, 'The API key must be text.');
    if (typeof fk === 'string' && fk.trim() && !FAL_KEY.test(fk.trim())) throw new HttpError(400, FAL_KEY_HINT);
    const openaiImageModel = input.openaiImageModel === undefined ? current.openaiImageModel ?? '' : input.openaiImageModel;
    if (typeof openaiImageModel !== 'string' || (openaiImageModel !== '' && !OPENAI_IMAGE_MODEL_ID.test(openaiImageModel))) throw new HttpError(400, 'OpenAI image model: press Test and choose one from the list.');
    const falModel = input.falModel === undefined ? current.falModel : input.falModel;
    if (typeof falModel !== 'string' || falModel.length > 120 || !FAL_MODEL_ID.test(falModel)) throw new HttpError(400, 'fal model: choose one from the list, or type a fal model id such as fal-ai/nano-banana/edit.');
    return {
      enabled: bool(input.enabled, current.enabled),
      provider: provider as AiSettings['provider'],
      model: model as AiSettings['model'],
      anthropicApiKey: '',
      geminiApiKey: '',
      geminiModel,
      geminiImageModel,
      deepseekApiKey: '',
      deepseekModel,
      labelStyledPhotos: bool(input.labelStyledPhotos, current.labelStyledPhotos),
      picturesProvider: picturesProvider as AiSettings['picturesProvider'],
      openaiApiKey: '',
      openaiImageModel,
      falApiKey: '',
      falModel,
    };
  },

  async aiPrompt(input, current) {
    return validateAiPrompt(input, current);
  },

  async aiPictures(input, current) {
    return validateAiPictures(input, current);
  },

  async store(input, current) {
    const wa = text(input.whatsappNumber, 'WhatsApp number', 20, current.whatsappNumber).replace(/[\s()-]/g, '');
    const whatsappNumber = wa.startsWith('00') ? `+${wa.slice(2)}` : wa.startsWith('05') ? `+971${wa.slice(1)}` : wa;
    if (whatsappNumber && !/^\+[1-9]\d{7,14}$/.test(whatsappNumber)) throw new HttpError(400, 'WhatsApp number: use the international form, e.g. +971 50 123 4567.');
    // Customers of open bank transfers "on request" ask for the details on this number.
    if (!whatsappNumber && current.whatsappNumber && bankTransferMode() === 'ask_whatsapp') {
      const open = openOnRequestTransfers();
      if (open) throw new HttpError(400, `WhatsApp number: ${open === 1 ? '1 bank-transfer order is' : `${open} bank-transfer orders are`} waiting for payment, and those customers ask for your bank details on this number. Keep it until they have paid (or the orders are cancelled), or first choose "Send our bank details automatically" in Settings → Payments.`);
    }
    const supportEmail = text(input.supportEmail, 'Support email', 254, current.supportEmail);
    if (supportEmail && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(supportEmail)) throw new HttpError(400, 'Please check the support email.');
    const ig = text(input.instagramHandle, 'Instagram', 40, current.instagramHandle).replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, '');
    if (ig && !/^[A-Za-z0-9._]{1,30}$/.test(ig)) throw new HttpError(400, 'Instagram: the account name only (letters, digits, dots, underscores).');
    const tt = text(input.tiktokHandle, 'TikTok', 40, current.tiktokHandle).replace(/^@/, '');
    if (tt && !/^[A-Za-z0-9._]{2,24}$/.test(tt)) throw new HttpError(400, 'TikTok: the account name only.');
    const fb = text(input.facebookUrl, 'Facebook', 200, current.facebookUrl);
    if (fb && !/^https:\/\/(www\.|m\.)?(facebook|fb)\.com\/[A-Za-z0-9.\-/_?=&]+$/.test(fb)) throw new HttpError(400, 'Facebook: paste the https://facebook.com/… page address.');
    return {
      whatsappNumber,
      whatsappGreeting: text(input.whatsappGreeting, 'WhatsApp greeting', 300, current.whatsappGreeting),
      showWhatsAppButton: bool(input.showWhatsAppButton, current.showWhatsAppButton),
      supportEmail,
      instagramHandle: ig,
      facebookUrl: fb,
      tiktokHandle: tt,
      storeAddress: text(input.storeAddress, 'Store address', 300, current.storeAddress),
      showLocalCurrency: bool(input.showLocalCurrency, current.showLocalCurrency),
      askOnWhatsApp: bool(input.askOnWhatsApp, current.askOnWhatsApp),
      askOnInstagram: bool(input.askOnInstagram, current.askOnInstagram),
      confirmOrdersOnWhatsApp: bool(input.confirmOrdersOnWhatsApp, current.confirmOrdersOnWhatsApp),
      holdUntilWhatsAppConfirmed: bool(input.holdUntilWhatsAppConfirmed, current.holdUntilWhatsAppConfirmed),
    };
  },

  async phoneCheck(input, current) {
    const mode = input.mode === undefined ? current.mode : input.mode;
    if (!PHONE_CHECK_MODES.includes(mode as PhoneCheckMode)) throw new HttpError(400, 'Phone check: choose WhatsApp or SMS code.');
    const hours = input.unconfirmedCancelHours === undefined ? current.unconfirmedCancelHours : Number(input.unconfirmedCancelHours);
    if (!Number.isInteger(hours) || hours < MIN_CANCEL_HOURS || hours > MAX_CANCEL_HOURS) {
      throw new HttpError(400, `Cancel unconfirmed orders after: a whole number of hours from ${MIN_CANCEL_HOURS} to ${MAX_CANCEL_HOURS}.`);
    }
    // "If the customer never opens WhatsApp, cancel after": sooner, never later than the hours above.
    // Typed later than them: refused; left as it was while the hours above came down: brought down too.
    const given = input.unopenedCancelHours !== undefined;
    let unopened = given ? Number(input.unopenedCancelHours) : current.unopenedCancelHours;
    if (!Number.isInteger(unopened) || unopened < MIN_CANCEL_HOURS || unopened > MAX_UNOPENED_HOURS) {
      throw new HttpError(400, `If the customer never opens WhatsApp, cancel after: a whole number of hours from ${MIN_CANCEL_HOURS} to ${MAX_UNOPENED_HOURS}.`);
    }
    if (unopened > hours) {
      if (given) throw new HttpError(400, `If the customer never opens WhatsApp, cancel after: at most ${hours} hours (the time to confirm).`);
      unopened = hours;
    }
    return { mode: mode as PhoneCheckMode, unconfirmedCancelHours: hours, unopenedCancelHours: unopened };
  },

  async email(input, current) {
    const host = text(input.smtpHost, 'Mail server', 253, current.smtpHost).toLowerCase();
    if (host && !net.isIPv4(host) && !/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw new HttpError(400, 'Mail server: a host name such as smtp.gmail.com.');
    if (host && host !== current.smtpHost) await assertPublicMailHost(host);
    const port = input.smtpPort === undefined ? current.smtpPort : Number(input.smtpPort);
    if (!SMTP_PORTS.includes(port)) throw new HttpError(400, `Mail server port: one of ${SMTP_PORTS.join(', ')}.`);
    const security = input.smtpSecurity === undefined ? current.smtpSecurity : input.smtpSecurity;
    if (security !== 'starttls' && security !== 'tls') throw new HttpError(400, 'Security must be STARTTLS or TLS.');
    const emailRe = /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/;
    const user = text(input.smtpUser, 'Mail user', 254, current.smtpUser);
    const from = text(input.fromAddress, 'From address', 254, current.fromAddress);
    if (from && !emailRe.test(from)) throw new HttpError(400, 'Please check the From address.');
    const sendTo = text(input.sendTo, 'Send to', 600, current.sendTo).split(',').map((x) => x.trim()).filter(Boolean);
    if (sendTo.length > 5 || sendTo.some((x) => !emailRe.test(x))) throw new HttpError(400, 'Send to: up to 5 email addresses, separated by commas.');
    const imapHost = text(input.imapHost, 'Mailbox server', 253, current.imapHost).toLowerCase();
    if (imapHost && !net.isIPv4(imapHost) && !/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(imapHost)) throw new HttpError(400, 'Mailbox server: a host name such as imap.hostinger.com.');
    if (imapHost && imapHost !== current.imapHost) await assertPublicMailHost(imapHost);
    const imapPort = input.imapPort === undefined ? current.imapPort : Number(input.imapPort);
    if (imapPort !== 993) throw new HttpError(400, 'Mailbox server port: 993 (IMAP over TLS).');
    const imapUser = text(input.imapUser, 'Mailbox user', 254, current.imapUser);
    return { smtpHost: host, smtpPort: port, smtpSecurity: security, smtpUser: user, smtpPass: '', fromAddress: from, sendTo: sendTo.join(', '), imapHost, imapPort, imapUser, imapPass: '' };
  },

  async delivery(input, current) {
    const emirateList = (v: unknown, field: string, fallback: Emirate[]): Emirate[] => {
      if (v === undefined) return fallback;
      if (!Array.isArray(v) || v.some((e) => !EMIRATES.includes(e as string))) throw new HttpError(400, `${field}: choose from the seven emirates.`);
      return [...new Set(v as Emirate[])];
    };
    const emirates = emirateList(input.emirates, 'Emirates we deliver to', current.emirates);
    if (!emirates.length) throw new HttpError(400, 'Deliver to at least one emirate.');
    const notIn = input.notServed === undefined ? current.notServed : input.notServed;
    const notServed = (Array.isArray(notIn) ? notIn : typeof notIn === 'string' ? notIn.split(/[,\n]/) : [])
      .map((a, i) => text(a, `Area ${i + 1}`, 80))
      .filter(Boolean)
      .slice(0, 200);
    const tooShort = notServed.find((a) => a.replace(/[^\p{L}\p{N}]/gu, '').length < 3);
    if (tooShort) throw new HttpError(400, `Areas not served: "${tooShort}" is too short; write the full area name.`);
    const feeIn = input.sameDayFee === undefined ? current.sameDayFee : Number(input.sameDayFee);
    // 19.99 × 100 is 1998.9999… in floating point: compare with a tolerance, then keep exact fils.
    if (!Number.isFinite(feeIn) || feeIn < 0 || feeIn > 500 || Math.abs(feeIn * 100 - Math.round(feeIn * 100)) > 1e-6) throw new HttpError(400, 'Same-day charge: AED 0 to 500 (up to 2 decimals).');
    const fee = Math.round(feeIn * 100) / 100;
    const cutoff = text(input.sameDayCutoff, 'Same-day cut-off', 5, current.sameDayCutoff);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) throw new HttpError(400, 'Same-day cut-off: a time like 13:00.');
    const sameDayEmirates = emirateList(input.sameDayEmirates, 'Same-day emirates', current.sameDayEmirates);
    const sameDayEnabled = bool(input.sameDayEnabled, current.sameDayEnabled);
    if (sameDayEnabled && !sameDayEmirates.length) throw new HttpError(400, 'Choose where same-day delivery is offered.');
    if (sameDayEnabled && cutoff === '00:00') throw new HttpError(400, 'Same-day cut-off: 00:00 would never allow it; choose a time like 13:00.');
    return {
      emirates,
      notServed,
      standardDays: text(input.standardDays, 'Delivery time', 40, current.standardDays) || '1–2 days',
      sameDayEnabled,
      sameDayFee: fee,
      sameDayCutoff: cutoff,
      sameDayEmirates,
    };
  },

  async payments(input, current) {
    const pk = text(input.stripePublishableKey, 'Publishable key', 250, current.stripePublishableKey);
    if (pk && !STRIPE_PUBLISHABLE.test(pk)) throw new HttpError(400, 'The publishable key starts with pk_test_ or pk_live_ (Stripe → Developers → API keys).');
    // The secrets are kept or replaced after this (write-only); only their shape is checked here.
    const sk = input.stripeSecretKey;
    if (typeof sk === 'string' && sk.trim() && !STRIPE_SECRET.test(sk.trim())) throw new HttpError(400, 'The secret key starts with sk_test_, sk_live_ or rk_ (a restricted key); not the publishable pk_ key.');
    const wh = input.stripeWebhookSecret;
    if (typeof wh === 'string' && wh.trim() && !STRIPE_WEBHOOK_SECRET.test(wh.trim())) throw new HttpError(400, 'The webhook signing secret starts with whsec_ (Stripe → Developers → Webhooks → your endpoint → Signing secret).');
    for (const [k, v] of Object.entries({ stripeSecretKey: sk, stripeWebhookSecret: wh })) {
      if (v !== undefined && v !== null && typeof v !== 'string') throw new HttpError(400, `${k === 'stripeSecretKey' ? 'Secret key' : 'Webhook signing secret'} must be text.`);
    }
    const feeIn = input.cardFeePercent === undefined || input.cardFeePercent === null ? current.cardFeePercent : typeof input.cardFeePercent === 'string' && input.cardFeePercent.trim() ? Number(input.cardFeePercent.trim()) : input.cardFeePercent;
    if (typeof feeIn !== 'number' || !Number.isFinite(feeIn) || feeIn < 0 || feeIn > MAX_CARD_FEE_PERCENT || Math.abs(feeIn * 100 - Math.round(feeIn * 100)) > 1e-6) {
      throw new HttpError(400, `Card payment fee: a percent from 0 to ${MAX_CARD_FEE_PERCENT}, with up to 2 decimals (0 turns it off).`);
    }
    const modeIn = input.bankTransferMode === undefined ? current.bankTransferMode : input.bankTransferMode;
    if (!BANK_MODES.includes(modeIn as PaymentSettings['bankTransferMode'])) throw new HttpError(400, 'Choose how bank transfer is offered.');
    return {
      cardEnabled: bool(input.cardEnabled, current.cardEnabled),
      stripePublishableKey: pk,
      stripeSecretKey: '',
      stripeWebhookSecret: '',
      cardFeePercent: Math.round(feeIn * 100) / 100,
      bankTransferMode: modeIn as PaymentSettings['bankTransferMode'],
    };
  },

  async assistant(input, current) {
    const waitSeconds = input.waitSeconds === undefined ? current.waitSeconds : Number(input.waitSeconds);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 30 || waitSeconds > 900) throw new HttpError(400, 'Waiting time: 30 to 900 seconds.');
    const entriesIn = input.entries === undefined ? current.entries : input.entries;
    if (!Array.isArray(entriesIn) || entriesIn.length > 200) throw new HttpError(400, 'Keep up to 200 answers.');
    const entries = entriesIn.map((e, i) => {
      const o = obj(e);
      const n = i + 1;
      const id = text(o.id, `Answer ${n} id`, 40) || `a${n}`;
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/i.test(id)) throw new HttpError(400, `Answer ${n}: the id may use only letters, digits and dashes.`);
      const question = text(o.question, `Answer ${n} question`, 200);
      const answer = longText(o.answer, `Answer ${n}`, 1500);
      if (!question || !answer) throw new HttpError(400, `Answer ${n}: fill in the question and the answer.`);
      const kwIn = Array.isArray(o.keywords) ? o.keywords : typeof o.keywords === 'string' ? o.keywords.split(',') : [];
      const keywords = [...new Set(kwIn.map((k) => text(k, `Answer ${n} keyword`, 40).toLowerCase()).filter(Boolean))].slice(0, 30);
      return { id, question, keywords, answer };
    });
    if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new HttpError(400, 'Each answer needs its own id.');
    return {
      enabled: bool(input.enabled, current.enabled),
      name: text(input.name, 'Assistant name', 40, current.name) || DEFAULT_ASSISTANT.name,
      greeting: longText(input.greeting, 'Greeting', 500, current.greeting),
      answerSizes: bool(input.answerSizes, current.answerSizes),
      waitSeconds,
      entries,
    };
  },

  look: (input, current) => validateLook(input, current),

  async theme(input, current) {
    const mode = input.mode === undefined ? current.mode : input.mode;
    if (mode !== 'auto' && mode !== 'manual' && mode !== 'off') throw new HttpError(400, 'Theme mode must be auto, manual or off.');
    const themeId = input.themeId === undefined ? current.themeId : text(input.themeId, 'Theme', 40);
    if (themeId !== 'default' && !FESTIVAL_ID_SET.has(themeId)) throw new HttpError(400, 'Unknown theme.');
    const disabledIn = input.disabledFestivals === undefined ? current.disabledFestivals : input.disabledFestivals;
    if (!Array.isArray(disabledIn) || disabledIn.length > 100) throw new HttpError(400, 'Switched-off festivals must be a list.');
    const disabledFestivals = [...new Set(disabledIn.filter((id): id is string => typeof id === 'string' && FESTIVAL_ID_SET.has(id)))];
    return {
      mode,
      themeId,
      disabledFestivals,
      showBanner: bool(input.showBanner, current.showBanner),
      showMarquee: bool(input.showMarquee, current.showMarquee),
    };
  },
};

const FESTIVAL_ID_SET = new Set(FESTIVALS.map((f) => f.id));

const ANTHROPIC_KEY = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
/**
 * Google AI Studio keys: the classic standard key (AIza and 35 more characters, a little room
 * either way) or the authorization key AI Studio creates since May 2026, which starts with AQ.
 * (Google does not publish its length: 20–250 of letters, digits, '.', '_' or '-' after AQ.).
 */
export const GEMINI_KEY = /^(?:AIza[A-Za-z0-9_-]{30,60}|AQ\.[A-Za-z0-9._-]{20,250})$/;
/** What the owner is told when a Gemini key has the wrong shape. */
export const GEMINI_KEY_HINT = 'A Gemini API key starts with AIza or AQ. (aistudio.google.com → Get API key).';
/** DeepSeek keys: sk- and letters or digits (today 32 hex characters; a little room either way). Never sk-ant- (Anthropic). */
export const DEEPSEEK_KEY = /^sk-[A-Za-z0-9]{16,128}$/;
export const DEEPSEEK_KEY_HINT = 'A DeepSeek API key starts with sk- (platform.deepseek.com → API keys).';

/** A weave's name: letters and digits first, then also spaces and ' & / ( ) . + - (no markup). */
const WEAVE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} '’&\/().+-]*$/u;
export const MAX_WEAVES = 30;
export const WEAVE_MAX_LENGTH = 30;

/** One weave name, trimmed and checked (1–30 characters). */
export function cleanWeaveName(v: unknown, field = 'Weave'): string {
  const name = text(v, field, 200).replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, `${field} needs a name.`);
  if (name.length > WEAVE_MAX_LENGTH) throw new HttpError(400, `${field}: at most ${WEAVE_MAX_LENGTH} characters.`);
  if (!WEAVE_NAME.test(name)) throw new HttpError(400, `${field}: letters, digits, spaces and ' & / ( ) . + - only.`);
  return name;
}

/** Settings → Catalogue → Weaves: 1 to 30 names, each once (ignoring capitals). */
function cleanWeaves(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_WEAVES) throw new HttpError(400, `Keep 1 to ${MAX_WEAVES} weaves.`);
  const weaves = v.map((w, i) => cleanWeaveName(w, `Weave ${i + 1}`));
  const seen = new Set<string>();
  for (const w of weaves) {
    if (seen.has(w.toLowerCase())) throw new HttpError(400, `“${w}” is in the list twice.`);
    seen.add(w.toLowerCase());
  }
  return weaves;
}

/** Products in the shop (not archived) with this weave, by title. Read straight from the database (no import cycle). */
export function productsWithWeave(weave: string): Array<{ id: string; title: string }> {
  const rows = getDb().prepare("SELECT id, json_extract(data, '$.title') AS title FROM products WHERE archived = 0 AND json_extract(data, '$.weave') = ? ORDER BY position, rowid").all(weave) as Array<{ id: string; title: string | null }>;
  return rows.map((r) => ({ id: r.id, title: String(r.title ?? r.id) }));
}

/**
 * The weave list with one name renamed (or, when the new name is already in the list, merged into
 * it), saved at once. For src/lib/server/weaves.ts, inside its transaction with the products.
 */
export function saveRenamedWeave(from: string, to: string): string[] {
  const current = getSettings('catalog');
  if (!current.weaves.includes(from)) throw new HttpError(404, `“${from}” is not in the weave list.`);
  const target = current.weaves.find((w) => w.toLowerCase() === to.toLowerCase() && w !== from);
  const weaves = target ? current.weaves.filter((w) => w !== from) : current.weaves.map((w) => (w === from ? to : w));
  save('catalog', { ...current, weaves }, { keepHistory: true });
  return weaves;
}

/** The look: a known preset and mode only; the time is the server's, never the browser's. */
async function validateLook(input: Obj, current: LookSettings): Promise<LookSettings> {
  const preset = input.preset === undefined ? current.preset : input.preset;
  if (!isLookPreset(preset)) throw new HttpError(400, 'Unknown look.');
  const mode = input.mode === undefined ? current.mode : input.mode;
  if (!isLookMode(mode)) throw new HttpError(400, 'Mode must be system, light or dark.');
  return {
    preset,
    mode,
    label: text(input.label, 'Label', 120) || lookLabel(preset, mode),
    changedAt: new Date().toISOString(),
    changedBy: text(input.changedBy, 'Changed by', 120),
  };
}

function validateSizePreset(v: unknown, i: number): BedProfileMeasurement {
  const o = obj(v);
  const n = `Size ${i + 1}`;
  const id = text(o.id, `${n} id`, 30);
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(id)) throw new HttpError(400, `${n}: the id may use only lowercase letters, digits and dashes.`);
  const name = text(o.name, `${n} name`, 60);
  if (!name) throw new HttpError(400, `${n} needs a name.`);
  const pieces = Number(o.piecesIncluded ?? 1);
  if (!Number.isInteger(pieces) || pieces < 1 || pieces > 20) throw new HttpError(400, `${n}: pieces must be 1 to 20.`);
  const delta = Number(o.priceDelta ?? 0);
  if (!Number.isFinite(delta) || Math.abs(delta) > 10_000) throw new HttpError(400, `${n}: price difference must be a number.`);
  return {
    id,
    name,
    badge: text(o.badge, `${n} label`, 40),
    mattressSize: text(o.mattressSize, `${n} mattress`, 80),
    fittedSheet: text(o.fittedSheet, `${n} fitted sheet`, 80),
    flatSheet: text(o.flatSheet, `${n} flat sheet`, 80),
    pillowcases: text(o.pillowcases, `${n} pillowcases`, 80),
    duvetCover: text(o.duvetCover, `${n} duvet cover`, 80) || undefined,
    cushionCovers: text(o.cushionCovers, `${n} cushion covers`, 80) || undefined,
    piecesIncluded: pieces,
    priceDelta: Math.round(delta * 100) / 100,
    ...weightOf(o.weightGrams, n),
  };
}

/** A size's packed weight in whole grams (optional): 1 to 50 000. */
function weightOf(v: unknown, n: string): { weightGrams?: number } {
  if (v === undefined || v === null || v === '') return {};
  const g = Number(v);
  if (!Number.isInteger(g) || g < 1 || g > 50_000) throw new HttpError(400, `${n}: weight must be whole grams from 1 to 50000.`);
  return { weightGrams: g };
}

// ── Firebase web config (public values, validated strictly) ────────────────

const EMPTY_FIREBASE: FirebaseWebConfig = { apiKey: '', authDomain: '', projectId: '', appId: '' };
const FIREBASE_API_KEY = /^AIza[0-9A-Za-z_-]{35}$/;
const FIREBASE_APP_ID = /^1:\d{1,20}:web:[0-9a-f]{1,40}$/;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * How the storefront verifies phones. Firebase only when it is the chosen,
 * switched-on and complete SMS option, and no gateway is set in the server
 * environment (which, as for every other gateway, takes precedence).
 */
export function phoneVerificationConfig(): PhoneVerificationConfig {
  // WhatsApp mode: no code at all ('server' keeps pages from before on their own path).
  if (phoneCheckMode() === 'whatsapp') return { method: 'server', check: 'whatsapp', cancelHours: getSettings('phoneCheck').unconfirmedCancelHours };
  const sms = getSettings('sms');
  if (!sms.isEnabled || sms.provider !== 'firebase' || !firebaseConfigComplete(sms.firebase) || hasEnvGateway()) return { method: 'server', check: 'sms_code' };
  const { apiKey, authDomain, projectId, appId } = sms.firebase;
  return { method: 'firebase', firebase: { apiKey, authDomain, projectId, appId }, check: 'sms_code' };
}

/**
 * Checkout sends phone codes: Settings → Phone check is "SMS code" and an SMS gateway (or Firebase)
 * is switched on, so card orders prove their phone like every other order. With "WhatsApp (free)"
 * no code is ever sent, as if there were no gateway. Saved settings can only be on when complete.
 */
export function phoneCodesOn(): boolean {
  return phoneCheckMode() === 'sms_code' && (hasEnvGateway() || getSettings('sms').isEnabled);
}

export const PHONE_CHECK_MODES: readonly PhoneCheckMode[] = ['whatsapp', 'sms_code'];
export const MIN_CANCEL_HOURS = 2;
export const MAX_CANCEL_HOURS = 168;
export const MAX_UNOPENED_HOURS = 48;

/** Settings → Phone check: 'whatsapp' (the default, free) or 'sms_code' (the gateways, unchanged). */
export function phoneCheckMode(): PhoneCheckMode {
  const mode = getSettings('phoneCheck').mode;
  return mode === 'sms_code' ? 'sms_code' : 'whatsapp';
}

/**
 * A one-time Admin Hub notice for a shop that had an SMS gateway switched on and never chose a
 * phone check: since this version its customers confirm on WhatsApp instead of an SMS code (the
 * owner's choice of default). Gone once dismissed, or once Settings → Phone check is saved.
 */
export function phoneCheckNoticeDue(): boolean {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'phoneCheck'").get()) return false;
  if (db.prepare("SELECT 1 FROM kv WHERE key = 'notice:phone-check-whatsapp'").get()) return false;
  return hasEnvGateway() || getSettings('sms').isEnabled;
}

/** "Got it" on the notice above. */
export function dismissPhoneCheckNotice(): void {
  getDb().prepare("INSERT INTO kv (key, data, updated_at) VALUES ('notice:phone-check-whatsapp', ?, ?) ON CONFLICT(key) DO NOTHING").run(JSON.stringify({ dismissed: true }), new Date().toISOString());
}

/** Settings → Phone check's warning: without TRUST_PROXY the shop can't tell connections apart (stricter limits apply). */
export function behindProxy(): boolean {
  return process.env.TRUST_PROXY === '1';
}

function hasEnvGateway(): boolean {
  const g = envGateways();
  return Boolean(g.twilio || g.infobip || g.webhook);
}

/** Every field present: what "switched on" and the storefront need. */
export function firebaseConfigComplete(f: FirebaseWebConfig | undefined): f is FirebaseWebConfig {
  return Boolean(f && f.apiKey && f.authDomain && f.projectId && f.appId);
}

function firebaseConfig(input: Obj, current: FirebaseWebConfig): FirebaseWebConfig {
  const apiKey = text(input.apiKey, 'Firebase API key', 100, current.apiKey);
  if (apiKey && !FIREBASE_API_KEY.test(apiKey)) throw new HttpError(400, 'Firebase API key starts with AIza followed by 35 letters, digits, - or _.');
  const projectId = text(input.projectId, 'Firebase project ID', 100, current.projectId);
  if (projectId && !FIREBASE_PROJECT_ID.test(projectId)) throw new HttpError(400, 'Firebase project ID: 4 to 40 lowercase letters, digits or dashes.');
  const authDomain = text(input.authDomain, 'Firebase auth domain', 300, current.authDomain).toLowerCase();
  if (authDomain && !(projectId && authDomain === `${projectId}.firebaseapp.com`) && !(HOSTNAME.test(authDomain) && !authDomain.endsWith('.localhost') && !authDomain.endsWith('.local') && !authDomain.endsWith('.internal'))) {
    throw new HttpError(400, 'Firebase auth domain must be a host name such as your-project.firebaseapp.com (no https://, no path).');
  }
  const appId = text(input.appId, 'Firebase app ID', 100, current.appId);
  if (appId && !FIREBASE_APP_ID.test(appId)) throw new HttpError(400, 'Firebase app ID looks like 1:123456789012:web:abc123def456.');
  return { apiKey, authDomain, projectId, appId };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function getPath(o: Obj, p: string): unknown {
  return p.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' && Object.hasOwn(acc as Obj, k) ? (acc as Obj)[k] : undefined), o);
}

function setPath(o: unknown, p: string, value: unknown) {
  const keys = p.split('.');
  let target = o as Obj;
  for (const k of keys.slice(0, -1)) {
    if (!target[k] || typeof target[k] !== 'object') target[k] = {};
    target = target[k] as Obj;
  }
  target[keys[keys.length - 1]] = value;
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!over || typeof over !== 'object' || Array.isArray(over) || !base || typeof base !== 'object' || Array.isArray(base)) {
    return over === undefined ? structuredClone(base) : over;
  }
  const out: Obj = structuredClone(base) as Obj;
  for (const [k, v] of Object.entries(over as Obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = deepMerge(out[k], v);
  }
  return out;
}

/** Test hook. */
export function _clearSettingsCache() {
  cache.clear();
}

// ── AI prompts (Settings → AI writing → Prompt, Settings → AI pictures) ─────

/**
 * The owner's writing prompt: the instructions (line breaks kept, at most 4,000 characters) and a
 * guide per field (one line, at most 300), control characters taken out. Nothing else is accepted:
 * the fixed rules and the answer format are not settings. Also checks the unsaved prompt that "Try on
 * a photo" sends. Empty means "the shop's default".
 */
export function validateAiPrompt(v: unknown, current: AiPromptSettings): AiPromptSettings {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'The prompt must be an object.');
  const input = v as Obj;
  for (const k of Object.keys(input)) if (k !== 'instructions' && k !== 'fields') throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  let instructions = current.instructions ?? '';
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== 'string') throw new HttpError(400, 'The instructions must be text.');
    instructions = cleanInstructions(input.instructions);
    if (instructions.length > PROMPT_INSTRUCTIONS_MAX) throw new HttpError(400, `The instructions: at most ${PROMPT_INSTRUCTIONS_MAX.toLocaleString('en-GB')} characters.`);
  }
  const fields: Partial<Record<WritingFieldId, string>> = {};
  for (const f of WRITING_FIELDS) {
    const kept = current.fields?.[f.id];
    if (typeof kept === 'string' && kept) fields[f.id] = kept;
  }
  if (input.fields !== undefined) {
    if (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)) throw new HttpError(400, 'The field guides must be an object.');
    const given = input.fields as Obj;
    for (const k of Object.keys(given)) {
      const f = WRITING_FIELDS.find((x) => x.id === k);
      if (!f) throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
      const g = given[k];
      if (g !== null && typeof g !== 'string') throw new HttpError(400, `${f.label}: must be text.`);
      const clean = typeof g === 'string' ? cleanGuide(g) : '';
      if (clean.length > FIELD_GUIDE_MAX) throw new HttpError(400, `${f.label}: at most ${FIELD_GUIDE_MAX} characters.`);
      if (clean) fields[f.id] = clean;
      else delete fields[f.id];
    }
  }
  return { instructions, fields };
}

/**
 * Settings → AI pictures: 1 to 16 scenes (an id, a name of at most 60 characters, a scene of at most
 * 400, one line each, ids unique), the default trio (1 to 3 of those ids), and the look and mood (at
 * most 1,000, '' = the shop's default). The fixed rules are not settings.
 */
export function validateAiPictures(input: Obj, current: AiPicturesSettings): AiPicturesSettings {
  for (const k of Object.keys(input)) if (!['look', 'scenes', 'defaultSet', 'references', 'useReferences'].includes(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  let look = current.look ?? '';
  if (input.look !== undefined) {
    if (typeof input.look !== 'string') throw new HttpError(400, 'The look and mood must be text.');
    look = oneLine(input.look);
    if (look.length > STAGING_LOOK_MAX) throw new HttpError(400, `The look and mood: at most ${STAGING_LOOK_MAX.toLocaleString('en-GB')} characters.`);
  }
  let scenes = current.scenes;
  if (input.scenes !== undefined) {
    if (!Array.isArray(input.scenes) || input.scenes.length < 1) throw new HttpError(400, 'Keep at least one scene.');
    if (input.scenes.length > STAGING_MAX_SCENES) throw new HttpError(400, `At most ${STAGING_MAX_SCENES} scenes.`);
    const seen = new Set<string>();
    scenes = input.scenes.map((x, i): StagingScene => {
      const o = (x && typeof x === 'object' && !Array.isArray(x) ? x : {}) as Obj;
      for (const k of Object.keys(o)) if (k !== 'id' && k !== 'name' && k !== 'scene' && k !== 'style') throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
      if (o.style !== undefined && o.style !== 'references' && o.style !== 'scene') throw new HttpError(400, `Scene ${i + 1}: use my style photos, or this scene description only.`);
      const id = typeof o.id === 'string' ? o.id : '';
      if (!SCENE_ID.test(id) || seen.has(id)) throw new HttpError(400, `Scene ${i + 1}: a missing or repeated id.`);
      seen.add(id);
      const name = typeof o.name === 'string' ? oneLine(o.name) : '';
      if (!name) throw new HttpError(400, `Scene ${i + 1}: give it a name.`);
      if (name.length > STAGING_NAME_MAX) throw new HttpError(400, `Scene ${i + 1}: a name of at most ${STAGING_NAME_MAX} characters.`);
      const scene = typeof o.scene === 'string' ? oneLine(o.scene) : '';
      if (!scene) throw new HttpError(400, `${name}: describe the scene.`);
      if (scene.length > STAGING_SCENE_MAX) throw new HttpError(400, `${name}: a scene of at most ${STAGING_SCENE_MAX} characters.`);
      return { id, name, scene, ...(o.style === 'scene' ? { style: 'scene' as const } : {}) };
    });
  }
  const givenSet: unknown = input.defaultSet === undefined ? current.defaultSet : input.defaultSet;
  if (!Array.isArray(givenSet) || givenSet.some((d) => typeof d !== 'string')) throw new HttpError(400, 'Choose the scenes made with one press.');
  let defaultSet: string[] = [...new Set(givenSet as string[])];
  // Scenes taken away leave the trio too; an empty trio falls back to the first scenes.
  if (input.scenes !== undefined && input.defaultSet === undefined) defaultSet = defaultSet.filter((d) => scenes.some((s) => s.id === d));
  if (defaultSet.some((d) => !scenes.some((s) => s.id === d))) throw new HttpError(400, 'The scenes made with one press must be among the scenes.');
  if (defaultSet.length > STAGING_TRIO) throw new HttpError(400, `Choose at most ${STAGING_TRIO} scenes to make with one press.`);
  if (!defaultSet.length) defaultSet = scenes.slice(0, STAGING_TRIO).map((s) => s.id);
  const references = input.references === undefined ? current.references ?? [] : cleanReferences(input.references);
  return { look, scenes, defaultSet, references, useReferences: bool(input.useReferences, current.useReferences ?? true) };
}

/**
 * The style photos ("Make them look like these"): 0 to 5 of the shop's own stored pictures, each
 * stored through the style-photo upload (checked, metadata taken out), at most 1.5 MB and 2,048 px.
 */
function cleanReferences(v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'Style photos: a list.');
  if (v.length > STYLE_REFS_MAX) throw new HttpError(400, `At most ${STYLE_REFS_MAX} style photos.`);
  const out: string[] = [];
  for (const [i, u] of v.entries()) {
    const name = typeof u === 'string' ? u.replace(/^\/api\/images\//, '') : '';
    if (!IMAGE_NAME.test(name)) throw new HttpError(400, `Style photo ${i + 1}: upload it again.`);
    const img = readImage(name);
    if (!img) throw new HttpError(400, `Style photo ${i + 1} is no longer stored: upload it again.`);
    const clean = cleanImage(img.bytes, STYLE_MAX);
    if (!clean || clean.width > STYLE_SIDE_MAX || clean.height > STYLE_SIDE_MAX) throw new HttpError(400, `Style photo ${i + 1} is too large: upload it again (it is made smaller on the way).`);
    const url = `/api/images/${name}`;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}
