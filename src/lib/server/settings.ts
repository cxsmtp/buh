import net from 'node:net';
import type { BankTransferDetails, BedProfileMeasurement, BrandSettings, CatalogSettings, CourierSettings, EmailSettings, FirebaseWebConfig, PhoneVerificationConfig, SmsGatewaySettings, StoreSettings, ThemeSettings } from '@/types';
import { FESTIVALS } from '@/lib/festivals/catalog';
import { DEFAULT_CATALOG, DEFAULT_EMAIL_SETTINGS, DEFAULT_STORE, DEFAULT_THEME_SETTINGS } from '@/data/catalogDefaults';
import { INITIAL_BANK_DETAILS, INITIAL_BRAND_SETTINGS, INITIAL_COURIER_SETTINGS, INITIAL_SMS_SETTINGS } from '@/data/initialData';
import { getDb } from './db';
import { SMTP_PORTS, assertPublicMailHost } from './mail';
import { FIREBASE_PROJECT_ID } from './firebaseAuth';
import { bump, changedElsewhere } from './live';
import { envGateways } from '@/lib/otpService';
import { HttpError } from './http';
import { acceptImageRef } from './images';
import { assertPublicHttpsUrl } from './outbound';
import { supportEmail as envSupportEmail } from './runtimeConfig';

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
}
export type SettingsKey = keyof SettingsMap;

const DEFAULTS: SettingsMap = {
  brand: INITIAL_BRAND_SETTINGS,
  // Empty until the owner enters the real account: bank transfer stays hidden until then.
  bank: INITIAL_BANK_DETAILS,

  // Never start with the sample keys from the demo data.
  courier: {
    ...INITIAL_COURIER_SETTINGS,
    jeebly: { ...INITIAL_COURIER_SETTINGS.jeebly, apiKey: '', clientKey: '', isLive: false },
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
};

/** Where customers are asked to email: Settings → Store first, then NEXT_PUBLIC_SUPPORT_EMAIL. */
export function contactEmail(): string {
  return getSettings('store').supportEmail || envSupportEmail();
}

/** Paths of secret fields per settings group. */
const SECRETS: Record<SettingsKey, string[]> = {
  brand: [],
  bank: [],
  courier: ['jeebly.apiKey', 'jeebly.clientKey', 'echo.apiKey'],
  sms: ['twilio.authToken', 'infobip.apiKey', 'customWebhook.bearerToken', 'unifonic.appSid'],
  catalog: [],
  store: [],
  theme: [],
  email: ['smtpPass'],
};

const cache = new Map<SettingsKey, unknown>();

export function getSettings<K extends SettingsKey>(key: K): SettingsMap[K] {
  if (cache.size && changedElsewhere('settings')) cache.clear();
  if (cache.has(key)) return cache.get(key) as SettingsMap[K];
  const row = getDb().prepare('SELECT data FROM settings WHERE key = ?').get(key) as { data: string } | undefined;
  const stored = row ? JSON.parse(row.data) : {};
  const merged = deepMerge(DEFAULTS[key], stored) as SettingsMap[K];
  cache.set(key, merged);
  return merged;
}

const HISTORY_KEEP = 30;

/** The value without its secrets (history never keeps keys). */
function withoutSecrets(key: SettingsKey, value: unknown): Obj {
  const copy = structuredClone(value) as Obj;
  for (const p of SECRETS[key]) if (getPath(copy, p) !== undefined) setPath(copy, p, '');
  return copy;
}

function save<K extends SettingsKey>(key: K, value: SettingsMap[K]) {
  // Keep the version being replaced, so it can be restored (Settings → System → History).
  const db = getDb();
  const before = db.prepare('SELECT data, updated_at FROM settings WHERE key = ?').get(key) as { data: string; updated_at: string } | undefined;
  if (before) {
    db.prepare('INSERT INTO settings_history (key, data, saved_at) VALUES (?, ?, ?)').run(key, JSON.stringify(withoutSecrets(key, JSON.parse(before.data))), before.updated_at);
    db.prepare('DELETE FROM settings_history WHERE key = ? AND id NOT IN (SELECT id FROM settings_history WHERE key = ? ORDER BY id DESC LIMIT ?)').run(key, key, HISTORY_KEEP);
  }
  getDb()
    .prepare('INSERT INTO settings (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), new Date().toISOString());
  cache.set(key, value);
  bump('settings');
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
export async function restoreSettingsVersion(id: number): Promise<SettingsKey> {
  const row = getDb().prepare('SELECT key, data FROM settings_history WHERE id = ?').get(id) as { key: SettingsKey; data: string } | undefined;
  if (!row || !(row.key in DEFAULTS)) throw new HttpError(404, 'That version is no longer kept.');
  const key = row.key;
  // Saved like any other change: validated, and keys follow their host (a key saved for
  // today's address is not sent to an older one). Blank keys mean "keep the saved key".
  const restored = deepMerge(DEFAULTS[key], JSON.parse(row.data)) as Obj;
  for (const p of SECRETS[key]) setPath(restored, p, '');
  await updateSettings(key, restored);
  return key;
}

/** What the admin hub may see: secrets blanked, with which ones are saved. */
export function adminView<K extends SettingsKey>(key: K): { value: SettingsMap[K]; secretsSet: Record<string, boolean> } {
  const value = structuredClone(getSettings(key)) as unknown as Record<string, unknown>;
  const secretsSet: Record<string, boolean> = {};
  for (const p of SECRETS[key]) {
    secretsSet[p] = Boolean(getPath(value, p));
    setPath(value, p, '');
  }
  return { value: value as unknown as SettingsMap[K], secretsSet };
}

export async function updateSettings<K extends SettingsKey>(key: K, input: unknown): Promise<void> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Settings must be an object.');
  const current = getSettings(key);
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
  save(key, next as SettingsMap[K]);
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
  courier: {},
  sms: { 'infobip.apiKey': 'infobip.baseUrl', 'customWebhook.bearerToken': 'customWebhook.endpointUrl' },
  catalog: {},
  store: {},
  theme: {},
  email: {},
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

/** Bank transfer is offered only once the real account is entered. */
export function bankTransferReady(bank: BankTransferDetails): boolean {
  return Boolean(bank.iban && bank.accountName && bank.bankName);
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== '';

function text(v: unknown, field: string, max: number, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
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
      logoImageUrl: input.logoImageUrl === undefined ? current.logoImageUrl : acceptImageRef(input.logoImageUrl, 'Logo image'),
      accentColor: accent,
      marquee: {
        enabled: bool(marquee.enabled, current.marquee.enabled),
        speedSeconds: Number.isFinite(speed) ? Math.min(120, Math.max(5, Math.round(speed))) : current.marquee.speedSeconds,
        messages: messages.slice(0, 10).map((m, i) => text(m, `Marquee message ${i + 1}`, 160)).filter(Boolean),
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
    const rules = obj(input.autoAssignRules);
    const j = obj(input.jeebly);
    const e = obj(input.echo);
    const provider = (v: unknown, fallback: 'jeebly' | 'echo' | 'manual') => (v === 'jeebly' || v === 'echo' || v === 'manual' ? v : fallback);
    const pickupEmirate = text(j.pickupEmirate, 'Pickup emirate', 40, current.jeebly.pickupEmirate);
    if (!EMIRATES.includes(pickupEmirate)) throw new HttpError(400, 'Pickup emirate must be one of the seven Emirates.');
    return {
      autoAssignRules: {
        codCourier: provider(rules.codCourier, current.autoAssignRules.codCourier),
        prepaidCourier: provider(rules.prepaidCourier, current.autoAssignRules.prepaidCourier),
      },
      jeebly: {
        apiKey: '',
        clientKey: '',
        serviceType: j.serviceType === 'Express' ? 'Express' : j.serviceType === 'Scheduled' ? 'Scheduled' : current.jeebly.serviceType,
        isLive: bool(j.isLive, current.jeebly.isLive),
        pickupLocationName: text(j.pickupLocationName, 'Pickup location', 120, current.jeebly.pickupLocationName),
        pickupPhone: text(j.pickupPhone, 'Pickup phone', 32, current.jeebly.pickupPhone),
        pickupAddress: text(j.pickupAddress, 'Pickup address', 200, current.jeebly.pickupAddress),
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
      return { id, label, icon: text(o.icon, `Category ${i + 1} icon`, 8) };
    });
    if (new Set(categories.map((c) => c.id)).size !== categories.length) throw new HttpError(400, 'Each category needs its own id.');
    const threshold = input.lowStockThreshold === undefined ? current.lowStockThreshold : Number(input.lowStockThreshold);
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 50) throw new HttpError(400, 'Low-stock warning must be a whole number from 0 to 50.');
    return { sizes, categories, lowStockThreshold: threshold };
  },

  async store(input, current) {
    const wa = text(input.whatsappNumber, 'WhatsApp number', 20, current.whatsappNumber).replace(/[\s()-]/g, '');
    const whatsappNumber = wa.startsWith('00') ? `+${wa.slice(2)}` : wa.startsWith('05') ? `+971${wa.slice(1)}` : wa;
    if (whatsappNumber && !/^\+[1-9]\d{7,14}$/.test(whatsappNumber)) throw new HttpError(400, 'WhatsApp number: use the international form, e.g. +971 50 123 4567.');
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
    };
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
    return { smtpHost: host, smtpPort: port, smtpSecurity: security, smtpUser: user, smtpPass: '', fromAddress: from, sendTo: sendTo.join(', ') };
  },

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
  };
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
  const sms = getSettings('sms');
  if (!sms.isEnabled || sms.provider !== 'firebase' || !firebaseConfigComplete(sms.firebase) || hasEnvGateway()) return { method: 'server' };
  const { apiKey, authDomain, projectId, appId } = sms.firebase;
  return { method: 'firebase', firebase: { apiKey, authDomain, projectId, appId } };
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
