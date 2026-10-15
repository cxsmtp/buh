import net from 'node:net';
import { getDb } from './db';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { assertPublicMailHost, emailConfigured, mailConfig, ownerEmail, sender, transport } from './mail';
import { getSettings } from './settings';
import { adminAccountInfo } from './adminAuth';
import { adminReply, customerEmailReply, markEmailed, setChatNotifiers, threadByReplyKey, threadRow, transcript } from './chat';

/**
 * Chat by email.
 *
 * - When a chat is handed to a person, the owner gets an email with the
 *   conversation; the subject carries [Chat #KEY].
 * - Replying to that email answers in the chat: every minute the shop reads
 *   new mail in its mailbox (Settings → Email → mailbox, IMAP), takes messages
 *   whose subject has a known [Chat #KEY], keeps only the new text (not the
 *   quoted conversation) and posts it, if it comes from the owner's address
 *   (or, for the customer's own replies, from the email they left).
 * - A reply the owner writes while the customer is away is emailed to the
 *   customer, if they left an email.
 */

const OWNER_EMAIL_EVERY_MS = 5 * 60 * 1000;
const KEY_RE = /\[Chat #([A-HJ-NP-Z2-9]{10})\]/;

const shopName = () => getSettings('brand').storeName || 'Beautiful UAE Home';

export interface MailboxConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Typed in Settings (checked to be a public server), or IMAP_* in .env.production (the operator's choice). */
  source: 'settings' | 'environment';
}

export function mailboxConfig(): MailboxConfig | null {
  const e = getSettings('email');
  const host = e.imapHost || process.env.IMAP_HOST || '';
  if (!host) return null;
  const user = e.imapHost ? e.imapUser || e.smtpUser : process.env.IMAP_USER || process.env.SMTP_USER || '';
  const pass = e.imapHost ? e.imapPass || (user === e.smtpUser ? e.smtpPass : '') : process.env.IMAP_PASS || process.env.SMTP_PASS || '';
  if (!user || !pass) return null;
  return { host, port: e.imapHost ? e.imapPort || 993 : Number(process.env.IMAP_PORT) || 993, user, pass, source: e.imapHost ? 'settings' : 'environment' };
}

/** Where replies should go: the mailbox the shop reads, when that is an address. */
function replyTo(): string | undefined {
  const box = mailboxConfig();
  if (box && /@/.test(box.user)) return box.user;
  return undefined;
}

/** Keep only what the person wrote: drop the quoted conversation and signatures' reply headers. */
export function newText(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const l = line.trim();
    if (/^On .{4,200}wrote:$/i.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^_{5,}$/.test(l) || /^From: .+/i.test(l) || /^Sent from my /i.test(l)) break;
    if (l.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

async function emailOwner(threadId: string, force = false) {
  const r = threadRow(threadId);
  const to = ownerEmail();
  if (!r || !to || !emailConfigured()) return;
  if (!force && r.emailed_at && Date.now() - Date.parse(r.emailed_at) < OWNER_EMAIL_EVERY_MS) return;
  markEmailed(threadId);
  const who = [r.customer_name, r.contact].filter(Boolean).join(' · ') || 'A customer (no contact details yet)';
  const canReply = Boolean(mailboxConfig());
  try {
    await (await transport()).sendMail({
      from: sender(),
      to,
      replyTo: replyTo(),
      subject: `[Chat #${r.reply_key}] ${who} is waiting for an answer`,
      text: [
        `${who} would like to talk to someone at ${shopName()}.`,
        r.page ? `They were on ${r.page}.` : '',
        '',
        transcript(threadId),
        '',
        '—',
        canReply
          ? 'Reply to this email to answer in the chat (keep [Chat #…] in the subject). You can also answer in Admin Hub → Chats.'
          : 'Answer in Admin Hub → Chats. (To answer by replying to this email, set up the mailbox in Settings → Email.)',
      ]
        .filter((l, i, a) => l !== '' || a[i - 1] !== '')
        .join('\n'),
    });
  } catch (err) {
    logEvent('warn', 'chat_owner_email_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function emailCustomer(threadId: string, body: string) {
  const r = threadRow(threadId);
  if (!r || !r.contact.includes('@') || !emailConfigured()) return;
  try {
    await (await transport()).sendMail({
      from: sender(),
      to: r.contact,
      replyTo: replyTo(),
      subject: `[Chat #${r.reply_key}] ${shopName()} replied to your message`,
      text: `${body}\n\n—\n${shopName()}. ${mailboxConfig() ? 'Reply to this email to continue the conversation.' : ''}`.trim(),
    });
  } catch (err) {
    logEvent('warn', 'chat_customer_email_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** The addresses whose replies count as the owner's. */
async function ownerAddresses(): Promise<Set<string>> {
  const set = new Set<string>();
  for (const a of ownerEmail().split(',')) if (a.trim()) set.add(a.trim().toLowerCase());
  try {
    set.add((await adminAccountInfo()).email.toLowerCase());
  } catch {
    // no admin account yet
  }
  const from = mailConfig()?.from;
  if (from) set.add(from.toLowerCase());
  return set;
}

export interface IncomingMail {
  messageId: string;
  subject: string;
  from: string;
  text: string;
  /** The receiving server's verdict (Authentication-Results), when present. */
  authResults: string;
}

/** Post one email into its chat. Returns what happened, for the log and tests. */
export async function acceptMail(mail: IncomingMail): Promise<'owner' | 'customer' | 'ignored'> {
  const key = mail.subject.match(KEY_RE)?.[1];
  const r = key ? threadByReplyKey(key) : undefined;
  if (!r) return 'ignored';
  const seen = new Set(kvGet<string[]>('chat:mail-seen')?.data ?? []);
  if (mail.messageId && seen.has(mail.messageId)) return 'ignored';
  // A forged sender is refused when the receiving server says so.
  if (/\bdmarc=fail\b/i.test(mail.authResults) || (/\bspf=fail\b/i.test(mail.authResults) && /\bdkim=(fail|none)\b/i.test(mail.authResults))) {
    logEvent('warn', 'chat_mail_refused', { reason: 'sender not verified' });
    return 'ignored';
  }
  const text = newText(mail.text);
  if (!text) return 'ignored';
  const from = mail.from.toLowerCase();
  let result: 'owner' | 'customer' | 'ignored' = 'ignored';
  if ((await ownerAddresses()).has(from)) {
    adminReply(r.id, text, 'email', from);
    result = 'owner';
  } else if (r.contact && from === r.contact.toLowerCase()) {
    customerEmailReply(r.id, text);
    result = 'customer';
  }
  if (mail.messageId) kvSet('chat:mail-seen', [...seen, mail.messageId].slice(-500));
  return result;
}

let polling = false;

/** Read new mail once (every minute from startup). */
export async function checkMailbox(): Promise<number> {
  const box = mailboxConfig();
  if (!box || polling) return 0;
  // Only if there are chats someone might be answering.
  const open = (getDb().prepare("SELECT COUNT(*) AS n FROM chat_threads WHERE status != 'bot' AND updated_at > ?").get(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()) as { n: number }).n;
  if (!open) return 0;
  polling = true;
  let posted = 0;
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  let client: InstanceType<typeof ImapFlow> | null = null;
  try {
    const address = box.source === 'settings' ? await assertPublicMailHost(box.host) : box.host;
    client = new ImapFlow({
      host: address,
      port: box.port,
      secure: true,
      servername: net.isIP(box.host) ? undefined : box.host,
      auth: { user: box.user, pass: box.pass },
      logger: false,
      socketTimeout: 60_000,
      tls: { servername: net.isIP(box.host) ? undefined : box.host, rejectUnauthorized: process.env.IMAP_REJECT_UNAUTHORIZED !== 'false' },
    } as ConstructorParameters<typeof ImapFlow>[0]);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = (await client.search({ seen: false, subject: '[Chat #', since: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }, { uid: true })) || [];
      for (const uid of uids.slice(0, 50)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source || msg.source.length > 2_000_000) continue;
        const parsed = await simpleParser(msg.source, { skipHtmlToText: false, skipImageLinks: true });
        const auth = parsed.headers.get('authentication-results');
        const outcome = await acceptMail({
          messageId: parsed.messageId || `uid:${uid}`,
          subject: parsed.subject || '',
          from: parsed.from?.value[0]?.address || '',
          text: parsed.text || '',
          authResults: Array.isArray(auth) ? auth.join(' ') : String(auth ?? ''),
        });
        if (outcome !== 'ignored') posted++;
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
    kvSet('chat:mailbox', { at: new Date().toISOString(), ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    kvSet('chat:mailbox', { at: new Date().toISOString(), ok: false, error: message.slice(0, 200) });
    logEvent('warn', 'chat_mailbox_failed', { error: message });
  } finally {
    polling = false;
    await client?.logout().catch(() => {});
  }
  return posted;
}

let started = false;

/** Wire the chat to email, and read the mailbox every minute. */
export function startChatMail() {
  setChatNotifiers(
    (id) => void emailOwner(id),
    (id, body) => void emailCustomer(id, body)
  );
  if (started || process.env.CHAT_MAIL_DISABLED === '1') return;
  started = true;
  const t = setInterval(() => void checkMailbox(), 60_000);
  t.unref();
}

export function mailboxStatus() {
  return { configured: Boolean(mailboxConfig()), last: kvGet<{ at: string; ok: boolean; error?: string }>('chat:mailbox')?.data ?? null };
}
