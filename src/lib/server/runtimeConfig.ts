/**
 * Settings read when the shop starts, not when it is built.
 *
 * Next.js freezes `process.env.NEXT_PUBLIC_*` into the build, so a ready-made
 * container image would carry whatever was set on the build machine. These
 * are looked up by name at runtime instead (a variable key is never inlined),
 * so one image serves any shop, configured by its .env.production.
 */
const runtimeEnv = (name: string): string | undefined => (process.env as Record<string, string | undefined>)[name]?.trim() || undefined;

export const DEFAULT_SUPPORT_EMAIL = 'orders@beautifuluaehome.com';

/** Where customers with a non-UAE number are asked to email. */
export function supportEmail(): string {
  const v = runtimeEnv('NEXT_PUBLIC_SUPPORT_EMAIL');
  return v && v.length <= 254 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) ? v : DEFAULT_SUPPORT_EMAIL;
}

/** The shop's public address (https://yourdomain.ae), if set. */
export function appUrl(): string | undefined {
  return runtimeEnv('NEXT_PUBLIC_APP_URL');
}
