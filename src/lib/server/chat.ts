import crypto from 'node:crypto';
import type { ChatMessage, ChatThread } from '@/types';
import { reply as assistantReply } from '@/lib/assistant';
import { audit } from './audit';
import { getDb } from './db';
import { HttpError } from './http';
import { bump } from './live';
import { logEvent } from './log';
import { getSettings } from './settings';

/**
 * The shop's chat. A customer starts a conversation and gets a secret for it
 * (kept in their browser; only its hash is stored). The assistant answers from
 * Settings → Chat assistant; anything else, or "talk to a person", goes to the
 * owner: shown in Admin Hub → Chats and emailed (a reply to that email lands in
 * the chat, see chatMail.ts). If nobody has answered after the waiting time, the
 * customer is told we'll get back to them, on the contact details they leave.
 */

const MAX_BODY = 1000;
const MAX_MESSAGES_PER_THREAD = 300;
/** A customer who hasn't looked at the chat for this long gets the owner's reply by email (when they left an email). */
export const CUSTOMER_AWAY_MS = 2 * 60 * 1000;

interface Row {
  id: string;
  token_hash: string;
  reply_key: string;
  status: ChatThread['status'];
  customer_name: string;
  contact: string;
  page: string;
  ip: string;
  created_at: string;
  updated_at: string;
  handed_over_at: string | null;
  reassured_at: string | null;
  emailed_at: string | null;
  customer_seen_at: string | null;
  admin_seen_id: number;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');
const nowIso = (now = Date.now()) => new Date(now).toISOString();

/** Plain text only, trimmed and capped. */
export function cleanBody(v: unknown, max = MAX_BODY): string {
  if (typeof v !== 'string') throw new HttpError(400, 'Type a message.');
  const body = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) throw new HttpError(400, 'Type a message.');
  return body.slice(0, max);
}

/** A phone number (any country, 8–15 digits) or an email address. */
export function cleanContact(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError(400, 'Leave a phone number or an email.');
  const c = v.trim().slice(0, 254);
  if (/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(c)) return c.toLowerCase();
  const digits = c.replace(/[\s()-]/g, '');
  const phone = digits.startsWith('00') ? `+${digits.slice(2)}` : /^05\d{8}$/.test(digits) ? `+971${digits.slice(1)}` : digits;
  if (/^\+?[1-9]\d{7,14}$/.test(phone)) return phone.startsWith('+') ? phone : `+${phone}`;
  throw new HttpError(400, 'Please check the phone number or email.');
}

function row(id: string): Row | undefined {
  return getDb().prepare('SELECT * FROM chat_threads WHERE id = ?').get(id) as Row | undefined;
}

/** The customer's own conversation, checked against their secret (same answer for unknown and wrong). */
function own(id: unknown, token: unknown): Row {
  const r = typeof id === 'string' && /^[A-Za-z0-9_-]{10,40}$/.test(id) ? row(id) : undefined;
  const given = Buffer.from(sha(typeof token === 'string' ? token : ''));
  if (!r || !crypto.timingSafeEqual(given, Buffer.from(r.token_hash))) throw new HttpError(404, 'This chat has ended. Start a new one.');
  return r;
}

function addMessage(threadId: string, author: ChatMessage['author'], body: string, via: ChatMessage['via'], now = Date.now()): ChatMessage {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?').get(threadId) as { n: number }).n;
  if (count >= MAX_MESSAGES_PER_THREAD) throw new HttpError(429, 'This chat is full. Please start a new one, or message us on WhatsApp.');
  const at = nowIso(now);
  const info = db.prepare('INSERT INTO chat_messages (thread_id, at, author, body, via) VALUES (?, ?, ?, ?, ?)').run(threadId, at, author, body, via);
  db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(at, threadId);
  return { id: Number(info.lastInsertRowid), at, author, body, via };
}

function messages(threadId: string, after = 0): ChatMessage[] {
  return getDb()
    .prepare('SELECT id, at, author, body, via FROM chat_messages WHERE thread_id = ? AND id > ? ORDER BY id LIMIT 300')
    .all(threadId, after) as ChatMessage[];
}

export interface CustomerView {
  id: string;
  status: ChatThread['status'];
  /** Handed to a person and no way to reach the customer yet: ask for it. */
  needsContact: boolean;
  contact: string;
  messages: ChatMessage[];
}

function customerView(r: Row, after = 0): CustomerView {
  const fresh = row(r.id)!;
  return { id: fresh.id, status: fresh.status, needsContact: fresh.status !== 'bot' && !fresh.contact, contact: fresh.contact, messages: messages(fresh.id, after) };
}

/** Optional hook (chatMail.ts) that emails the owner; kept separate so tests and the chat don't need a mail server. */
let notifyOwner: ((threadId: string) => void) | null = null;
let notifyCustomer: ((threadId: string, body: string) => void) | null = null;
export function setChatNotifiers(owner: typeof notifyOwner, customer: typeof notifyCustomer) {
  notifyOwner = owner;
  notifyCustomer = customer;
}

function handOver(r: Row, reason: 'asked' | 'unsure', now = Date.now()) {
  const db = getDb();
  if (r.status === 'bot' || r.status === 'closed') {
    db.prepare("UPDATE chat_threads SET status = 'waiting', handed_over_at = ?, reassured_at = NULL WHERE id = ?").run(nowIso(now), r.id);
    const first = reason === 'asked' ? 'Of course. I’ve asked the team to join this chat.' : 'I’m not sure about that one, so I’ve passed your question to the team.';
    addMessage(r.id, 'system', `${first} Someone usually replies within a few minutes.${r.contact ? '' : ' So we can get back to you even if you leave, please add your phone number or email below.'}`, 'web', now);
  }
  notifyOwner?.(r.id);
}

/** A customer's message: the assistant answers, or a person is asked to. */
function onCustomerMessage(r: Row, body: string, now = Date.now()) {
  addMessage(r.id, 'customer', body, 'web', now);
  if (r.status === 'waiting' || r.status === 'human') {
    notifyOwner?.(r.id);
    return;
  }
  const settings = getSettings('assistant');
  const answer = assistantReply(body, settings, getSettings('catalog').sizes);
  if (answer.kind === 'handover') handOver(r, answer.reason, now);
  else addMessage(r.id, 'bot', answer.text, 'web', now);
}

export function startChat(input: { message: unknown; name?: unknown; contact?: unknown; page?: unknown; ip?: string | null }, now = Date.now()): CustomerView & { token: string } {
  const settings = getSettings('assistant');
  if (!settings.enabled) throw new HttpError(404, 'Chat is not available right now. Please message us on WhatsApp or by email.');
  const body = cleanBody(input.message);
  const name = typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f\u007f<>]+/g, ' ').trim().slice(0, 80) : '';
  const contact = input.contact ? cleanContact(input.contact) : '';
  const page = typeof input.page === 'string' && /^\/[\w\-./?=&%]{0,200}$/.test(input.page) ? input.page : '';
  const id = crypto.randomBytes(12).toString('base64url');
  const token = crypto.randomBytes(24).toString('base64url');
  // In the email subject: a person replying by email lands in this chat. Letters and digits only, easy to keep.
  const replyKey = Array.from(crypto.randomBytes(10), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  const at = nowIso(now);
  getDb()
    .prepare('INSERT INTO chat_threads (id, token_hash, reply_key, customer_name, contact, page, ip, created_at, updated_at, customer_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, sha(token), replyKey, name, contact, page, input.ip ?? '', at, at, at);
  if (settings.greeting) addMessage(id, 'bot', settings.greeting, 'web', now - 1);
  onCustomerMessage(row(id)!, body, now);
  bump('chats');
  return { ...customerView(row(id)!), token };
}

export function customerSend(id: unknown, token: unknown, message: unknown, now = Date.now()): CustomerView {
  const r = own(id, token);
  const body = cleanBody(message);
  if (r.status === 'closed') getDb().prepare("UPDATE chat_threads SET status = 'bot' WHERE id = ?").run(r.id);
  const last = (getDb().prepare('SELECT MAX(id) AS id FROM chat_messages WHERE thread_id = ?').get(r.id) as { id: number | null }).id ?? 0;
  getDb().prepare('UPDATE chat_threads SET customer_seen_at = ? WHERE id = ?').run(nowIso(now), r.id);
  onCustomerMessage(row(r.id)!, body, now);
  bump('chats');
  return customerView(r, last);
}

/** "Talk to a person" button. */
export function customerAskPerson(id: unknown, token: unknown, now = Date.now()): CustomerView {
  const r = own(id, token);
  const last = (getDb().prepare('SELECT MAX(id) AS id FROM chat_messages WHERE thread_id = ?').get(r.id) as { id: number | null }).id ?? 0;
  handOver(r, 'asked', now);
  bump('chats');
  return customerView(r, last);
}

export function customerContact(id: unknown, token: unknown, input: { name?: unknown; contact: unknown }, now = Date.now()): CustomerView {
  const r = own(id, token);
  const contact = cleanContact(input.contact);
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.replace(/[\u0000-\u001f\u007f<>]+/g, ' ').trim().slice(0, 80) : r.customer_name;
  const last = (getDb().prepare('SELECT MAX(id) AS id FROM chat_messages WHERE thread_id = ?').get(r.id) as { id: number | null }).id ?? 0;
  getDb().prepare('UPDATE chat_threads SET contact = ?, customer_name = ? WHERE id = ?').run(contact, name, r.id);
  addMessage(r.id, 'system', `Thank you${name ? `, ${name.split(' ')[0]}` : ''}. If you leave before we reply, we’ll get back to you at ${contact}.`, 'web', now);
  notifyOwner?.(r.id);
  bump('chats');
  return customerView(r, last);
}

/** New messages since `after` (the customer's page asks every few seconds while the chat is open). */
export function customerPoll(id: unknown, token: unknown, after: unknown, now = Date.now()): CustomerView {
  const r = own(id, token);
  getDb().prepare('UPDATE chat_threads SET customer_seen_at = ? WHERE id = ?').run(nowIso(now), r.id);
  reassureIfWaiting(row(r.id)!, now);
  return customerView(r, Number.isInteger(Number(after)) ? Math.max(0, Number(after)) : 0);
}

/**
 * Nobody has answered within the waiting time: tell the customer, once, that we'll
 * get back to them (and ask how, if they haven't said). Run when the customer's page
 * asks for news, and every 30 seconds by the server.
 */
function reassureIfWaiting(r: Row, now = Date.now()): boolean {
  if (r.status !== 'waiting' || r.reassured_at || !r.handed_over_at) return false;
  const wait = getSettings('assistant').waitSeconds * 1000;
  if (now - Date.parse(r.handed_over_at) < wait) return false;
  const claimed = getDb().prepare("UPDATE chat_threads SET reassured_at = ? WHERE id = ? AND reassured_at IS NULL AND status = 'waiting'").run(nowIso(now), r.id);
  if (!claimed.changes) return false; // the other copy of the shop did it
  addMessage(
    r.id,
    'system',
    r.contact
      ? `Thank you for waiting. Everyone is busy for a moment, but your message is with us and we’ll get back to you at ${r.contact} as soon as we can. You can close this page.`
      : 'Thank you for waiting. Everyone is busy for a moment, but your message is with us. Please leave your phone number or email below, and we’ll get back to you as soon as we can.',
    'web',
    now
  );
  bump('chats');
  return true;
}

export function sweepChats(now = Date.now()): number {
  const rows = getDb().prepare("SELECT * FROM chat_threads WHERE status = 'waiting' AND reassured_at IS NULL").all() as Row[];
  let n = 0;
  for (const r of rows) if (reassureIfWaiting(r, now)) n++;
  return n;
}

// ── Admin Hub → Chats ─────────────────────────────────────────────────────────

function threadView(r: Row): ChatThread {
  const db = getDb();
  const last = db.prepare('SELECT body FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1').get(r.id) as { body: string } | undefined;
  const unread = (db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ? AND id > ? AND author = 'customer'").get(r.id, r.admin_seen_id) as { n: number }).n;
  return { id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, status: r.status, customerName: r.customer_name, contact: r.contact, page: r.page, unread, lastMessage: (last?.body ?? '').slice(0, 140) };
}

export function listChats(filter: 'open' | 'all' = 'open'): ChatThread[] {
  const rows = getDb()
    .prepare(`SELECT * FROM chat_threads ${filter === 'open' ? "WHERE status != 'closed' AND (status != 'bot' OR updated_at > ?)" : 'WHERE ? IS NOT NULL'} ORDER BY updated_at DESC LIMIT 200`)
    .all(nowIso(Date.now() - 7 * 24 * 60 * 60 * 1000)) as Row[];
  return rows.map(threadView);
}

/** Customer messages waiting for a person (for the Admin Hub badge). */
export function waitingCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM chat_threads WHERE status = 'waiting'").get() as { n: number }).n;
}

export function chatForAdmin(id: string): { thread: ChatThread; messages: ChatMessage[]; replyKey: string } {
  const r = row(id);
  if (!r) throw new HttpError(404, 'No such chat.');
  const all = messages(id);
  const lastId = all.length ? all[all.length - 1].id : 0;
  if (lastId > r.admin_seen_id) getDb().prepare('UPDATE chat_threads SET admin_seen_id = ? WHERE id = ?').run(lastId, id);
  return { thread: threadView(row(id)!), messages: all, replyKey: r.reply_key };
}

/** The owner's reply (from the Admin Hub, or an emailed reply). Emailed to the customer too if they've left the page and gave an email. */
export function adminReply(id: string, body: unknown, via: 'admin' | 'email', by: string, now = Date.now()): ChatMessage {
  const r = row(id);
  if (!r) throw new HttpError(404, 'No such chat.');
  const text = cleanBody(body, 4000);
  const msg = addMessage(id, 'admin', text, via, now);
  getDb().prepare("UPDATE chat_threads SET status = 'human', admin_seen_id = ? WHERE id = ?").run(msg.id, id);
  audit('chat.reply', { chat: id, by, via, length: text.length });
  const away = !r.customer_seen_at || now - Date.parse(r.customer_seen_at) > CUSTOMER_AWAY_MS;
  if (away && r.contact.includes('@')) notifyCustomer?.(id, text);
  bump('chats');
  return msg;
}

/** A customer's reply by email (they gave their email, and answered our email). */
export function customerEmailReply(id: string, body: string, now = Date.now()): void {
  const r = row(id);
  if (!r) return;
  addMessage(id, 'customer', cleanBody(body, 4000), 'email', now);
  if (r.status === 'closed' || r.status === 'bot') getDb().prepare("UPDATE chat_threads SET status = 'waiting', handed_over_at = ? WHERE id = ?").run(nowIso(now), id);
  notifyOwner?.(id);
  bump('chats');
}

export function setChatStatus(id: string, status: unknown, by: string): ChatThread {
  if (status !== 'closed' && status !== 'bot' && status !== 'human') throw new HttpError(400, 'Status: closed, bot or human.');
  const r = row(id);
  if (!r) throw new HttpError(404, 'No such chat.');
  getDb().prepare('UPDATE chat_threads SET status = ? WHERE id = ?').run(status, id);
  audit('chat.status', { chat: id, status, by });
  bump('chats');
  return threadView(row(id)!);
}

export function threadByReplyKey(key: string): Row | undefined {
  return getDb().prepare('SELECT * FROM chat_threads WHERE reply_key = ?').get(key) as Row | undefined;
}

/** For the owner's email: the conversation as plain text. */
export function transcript(id: string, limit = 30): string {
  const all = messages(id).slice(-limit);
  const who = { customer: 'Customer', bot: 'Assistant', admin: 'You', system: 'Shop' } as const;
  return all.map((m) => `${who[m.author]} (${new Date(m.at).toISOString().slice(11, 16)} UTC): ${m.body}`).join('\n\n');
}

export function markEmailed(id: string, now = Date.now()) {
  getDb().prepare('UPDATE chat_threads SET emailed_at = ? WHERE id = ?').run(nowIso(now), id);
}

export function threadRow(id: string) {
  return row(id);
}

export function _logChatProblem(event: string, err: unknown) {
  logEvent('warn', event, { error: err instanceof Error ? err.message : String(err) });
}
