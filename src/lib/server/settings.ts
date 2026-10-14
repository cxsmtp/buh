import type { BankTransferDetails, BrandSettings, CourierSettings, SmsGatewaySettings } from '@/types';
import { INITIAL_BANK_DETAILS, INITIAL_BRAND_SETTINGS, INITIAL_COURIER_SETTINGS, INITIAL_SMS_SETTINGS } from '@/data/initialData';
import { getDb } from './db';
import { HttpError } from './http';
import { acceptImageRef } from './images';
import { assertPublicHttpsUrl } from './outbound';

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
};

/** Paths of secret fields per settings group. */
const SECRETS: Record<SettingsKey, string[]> = {
  brand: [],
  bank: [],
  courier: ['jeebly.apiKey', 'jeebly.clientKey', 'echo.apiKey'],
  sms: ['twilio.authToken', 'infobip.apiKey', 'customWebhook.bearerToken', 'unifonic.appSid'],
};

const cache = new Map<SettingsKey, unknown>();

export function getSettings<K extends SettingsKey>(key: K): SettingsMap[K] {
  if (cache.has(key)) return cache.get(key) as SettingsMap[K];
  const row = getDb().prepare('SELECT data FROM settings WHERE key = ?').get(key) as { data: string } | undefined;
  const stored = row ? JSON.parse(row.data) : {};
  const merged = deepMerge(DEFAULTS[key], stored) as SettingsMap[K];
  cache.set(key, merged);
  return merged;
}

function save<K extends SettingsKey>(key: K, value: SettingsMap[K]) {
  getDb()
    .prepare('INSERT INTO settings (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), new Date().toISOString());
  cache.set(key, value);
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
    const providers = ['twilio', 'infobip', 'custom_webhook'] as const;
    if (input.provider !== undefined && !providers.includes(input.provider as never)) throw new HttpError(400, 'Choose Twilio, Infobip or a webhook.');
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
      isEnabled: bool(input.isEnabled, current.isEnabled),
    };
  },
};

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
