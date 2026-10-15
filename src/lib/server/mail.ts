import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './http';
import { isPrivateAddress } from './outbound';
import { getSettings } from './settings';

/**
 * Email for backups, alerts, the daily summary and password resets.
 *
 * The SMTP server is set in Settings → Email (the password is write-only),
 * or, when that is empty, in .env.production (SMTP_*, BACKUP_EMAIL). The
 * connection is always encrypted (STARTTLS required, or TLS on port 465),
 * and the server must be a public address (no reaching inside the network).
 */

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  user: string;
  pass: string;
  from: string;
  /** Where the shop's own emails go (backups, alerts, the summary). */
  to: string;
  source: 'settings' | 'environment';
}

export const SMTP_PORTS = [25, 465, 587, 2525];

export function mailConfig(): MailConfig | null {
  const s = getSettings('email');
  if (s.smtpHost) {
    return {
      host: s.smtpHost,
      port: s.smtpPort,
      secure: s.smtpSecurity === 'tls',
      requireTLS: s.smtpSecurity !== 'tls',
      user: s.smtpUser,
      pass: s.smtpPass,
      from: s.fromAddress || s.smtpUser,
      to: s.sendTo || process.env.BACKUP_EMAIL || '',
      source: 'settings',
    };
  }
  const env = process.env;
  if (!env.SMTP_HOST) return null;
  const port = Number(env.SMTP_PORT || 587);
  return {
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    // SMTP_REQUIRE_TLS=false is for local testing only.
    requireTLS: port !== 465 && env.SMTP_REQUIRE_TLS !== 'false',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || 'backups@localhost',
    to: getSettings('email').sendTo || env.BACKUP_EMAIL || '',
    source: 'environment',
  };
}

/** A mail server and somebody to send to. */
export function emailConfigured(): boolean {
  const c = mailConfig();
  return Boolean(c && c.to);
}

/** Refuse a mail server that resolves to a private or internal address; returns the address checked. */
export async function assertPublicMailHost(host: string): Promise<string> {
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new HttpError(400, `The mail server ${host} could not be found.`);
  if (addresses.some(isPrivateAddress)) throw new HttpError(400, 'The mail server must be a public address.');
  return addresses[0];
}

export async function transport(config = mailConfig()) {
  if (!config) throw new Error('Email is not set up.');
  // Only servers set in Settings are checked here: the .env.production one is the operator's own choice
  // (and may be a local relay in tests).
  // Connect to the address that was checked (a second DNS answer can't swap in an internal one);
  // the certificate is still checked against the name.
  const address = config.source === 'settings' ? await assertPublicMailHost(config.host) : config.host;
  const nodemailer = (await import('nodemailer')).default;
  return nodemailer.createTransport({
    host: address,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    tls: { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false', servername: net.isIP(config.host) ? undefined : config.host },
    connectionTimeout: 20_000,
    socketTimeout: 60_000,
  });
}

export function sender(): string {
  return mailConfig()?.from || 'backups@localhost';
}

export function ownerEmail(): string {
  return mailConfig()?.to || '';
}
