import type { Emirate } from '@/types';
import { resolveArea } from '@/data/uaeAreas';

/**
 * Apple Pay / Google Pay give the customer's name, phone, email and delivery address (from the
 * wallet, through Stripe's Express Checkout). This maps that address onto the shop's own emirates
 * and areas. Nothing is guessed: an emirate or area that can't be matched comes back as missing,
 * and checkout asks for it before anyone pays.
 */

export interface WalletContact {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
}

export interface WalletAddress {
  fullName: string;
  email: string;
  /** As the wallet gave it (the shop's phone rules are applied by the caller). */
  phone: string;
  emirate: Emirate | null;
  /** One of the shop's areas, or null when it couldn't be told. */
  area: string | null;
  streetAddress: string;
  buildingVilla: string;
  flatVillaNo: string;
  country: string;
}

const key = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

/** Names wallets (and people) use for the seven emirates, in English and Arabic. */
const EMIRATE_NAMES: Array<[Emirate, string[]]> = [
  ['Dubai', ['dubai', 'dxb', 'دبي']],
  ['Abu Dhabi', ['abudhabi', 'abudhabiemirate', 'auh', 'ابوظبي', 'أبوظبي']],
  ['Sharjah', ['sharjah', 'shj', 'الشارقة', 'الشارقه']],
  ['Ajman', ['ajman', 'عجمان']],
  ['Ras Al Khaimah', ['rasalkhaimah', 'rasalkhaima', 'rak', 'رأسالخيمة', 'راسالخيمة', 'رأسالخيمه']],
  ['Fujairah', ['fujairah', 'alfujairah', 'fujeirah', 'الفجيرة', 'الفجيره']],
  ['Umm Al Quwain', ['ummalquwain', 'ummalqaiwain', 'uaq', 'أمالقيوين', 'امالقيوين']],
];

export function emirateFrom(text: string | null | undefined): Emirate | null {
  const k = key(text || '');
  if (!k) return null;
  for (const [emirate, names] of EMIRATE_NAMES) if (names.some((n) => key(n) === k)) return emirate;
  return null;
}

/** The flat, apartment or villa number written in the address ("Apt 1402", "Villa 24", "#7"), if any. */
function flatIn(text: string): string | null {
  const m = /(?:\b(?:apt|apartment|flat|villa|unit|office|suite|room)\b\.?|#)\s*(?:no\.?\s*)?([A-Za-z]?\d[\w-]{0,9})/i.exec(text);
  return m ? m[0].trim() : null;
}

export function walletAddress(c: WalletContact): WalletAddress {
  const a = c.address ?? {};
  const line1 = (a.line1 || '').trim();
  const line2 = (a.line2 || '').trim();
  const city = (a.city || '').trim();
  const state = (a.state || '').trim();
  let emirate = emirateFrom(state) ?? emirateFrom(city);

  // The area: the city field (when it isn't just the emirate), then each part of the address lines.
  const candidates = [...(emirateFrom(city) ? [] : [city]), ...line2.split(','), ...line1.split(','), ...(emirateFrom(state) ? [] : [state])]
    .map((s) => s.trim())
    .filter(Boolean);
  let area: string | null = null;
  for (const text of candidates) {
    const hit = resolveArea(text, emirate ?? undefined);
    if (!hit || (emirate && hit.emirate !== emirate)) continue;
    area = hit.name;
    emirate = emirate ?? hit.emirate;
    break;
  }

  const both = [line1, line2].filter(Boolean).join(', ');
  return {
    fullName: (c.name || '').trim().slice(0, 120),
    email: (c.email || '').trim().slice(0, 254),
    phone: (c.phone || '').trim().slice(0, 32),
    emirate,
    area,
    streetAddress: (line1 || line2).slice(0, 200),
    buildingVilla: (line2 || line1).slice(0, 120),
    flatVillaNo: (flatIn(both) || line2 || line1).slice(0, 40),
    country: (a.country || '').toUpperCase(),
  };
}
