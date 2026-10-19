/**
 * BUH-02.01.00: the shop's chat. The assistant answers from its memory (and the
 * size presets), hands over to a person, the customer is reassured after the
 * waiting time, the owner replies in the hub or by email, and the customer gets
 * the reply by email if they left.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';
import type { IncomingMail } from '@/lib/server/chatMail';

tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
for (const k of ['SMTP_HOST', 'BACKUP_EMAIL', 'IMAP_HOST']) delete process.env[k];

const { reply } = await import('@/lib/assistant');
const chat = await import('@/lib/server/chat');
const chatMail = await import('@/lib/server/chatMail');
const settings = await import('@/lib/server/settings');
const { DEFAULT_ASSISTANT, DEFAULT_CATALOG } = await import('@/data/catalogDefaults');
const { getDb } = await import('@/lib/server/db');

const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
const T0 = Date.parse('2026-10-15T10:00:00Z');
const owner: string[] = [];
const customer: Array<[string, string]> = [];
chat.setChatNotifiers(
  (id) => owner.push(id),
  (id, body) => customer.push([id, body])
);

test('the assistant answers only from its memory and the size presets, and hands over otherwise', () => {
  const sizes = DEFAULT_CATALOG.sizes;
  const king = reply('What are the measurements of the king size?', DEFAULT_ASSISTANT, sizes);
  assert.equal(king.kind, 'answer');
  assert.match((king as { text: string }).text, /King/);
  assert.match((king as { text: string }).text, /\d+ x \d+/, 'real measurements from Settings → Catalogue');
  assert.doesNotMatch((king as { text: string }).text, /Single|Super King/, 'only the size asked about');
  assert.doesNotMatch((reply('measurements please', DEFAULT_ASSISTANT, sizes) as { text: string }).text, /Custom/, 'no made-up measurements for the custom preset');
  assert.deepEqual(reply('Do you have a discount code?', DEFAULT_ASSISTANT, sizes), { kind: 'answer', text: DEFAULT_ASSISTANT.entries.find((e) => e.id === 'discounts')!.answer, entryId: 'discounts' });
  assert.equal(reply('Is the fabric organic cotton from Jaipur?', DEFAULT_ASSISTANT, sizes).kind, 'handover', 'no answer: a person, not a guess');
  assert.deepEqual(reply('can I talk to a person please', DEFAULT_ASSISTANT, sizes), { kind: 'handover', reason: 'asked' });
  assert.equal(reply('Hello!', DEFAULT_ASSISTANT, sizes).kind, 'smalltalk');
  // Switched off: sizes are not answered from the presets.
  assert.equal(reply('measurements please', { ...DEFAULT_ASSISTANT, answerSizes: false }, sizes).kind, 'handover');
  // A new memory entry is used at once.
  const custom = { ...DEFAULT_ASSISTANT, entries: [{ id: 'oman', question: 'Do you deliver to Oman?', keywords: ['oman', 'muscat'], answer: 'Yes, to Muscat in 3 to 5 days.' }] };
  assert.equal((reply('shipping to muscat?', custom, sizes) as { text: string }).text, 'Yes, to Muscat in 3 to 5 days.');
});

test('a customer starts a chat; only their own secret opens it', () => {
  const c = chat.startChat({ message: 'How long is delivery?', page: '/p/abc', ip: '198.51.100.1' }, T0);
  assert.equal(c.status, 'bot');
  assert.ok(c.token.length >= 30);
  assert.deepEqual(c.messages.map((m) => m.author), ['bot', 'customer', 'bot'], 'greeting, question, answer');
  assert.match(c.messages[2].body, /24 to 48 hours/);
  assert.equal(statusOf(() => chat.customerPoll(c.id, 'wrong-token', 0, T0)), 404);
  assert.equal(statusOf(() => chat.customerPoll('../../etc', c.token, 0, T0)), 404);
  const other = chat.startChat({ message: 'hi' }, T0);
  assert.equal(statusOf(() => chat.customerPoll(other.id, c.token, 0, T0)), 404, 'one customer cannot read another’s chat');
  assert.equal(chat.customerPoll(c.id, c.token, c.messages.at(-1)!.id, T0).messages.length, 0, 'only new messages');
  assert.equal(statusOf(() => chat.startChat({ message: '   ' }, T0)), 400);
  assert.equal(chat.startChat({ message: 'x'.repeat(5000) }, T0).messages.find((m) => m.author === 'customer')!.body.length, 1000);
});

test('handed to a person: the owner is told, the customer leaves contact details, and is reassured once after the waiting time', () => {
  owner.length = 0;
  const c = chat.startChat({ message: 'Can you make a custom size for a round bed?' }, T0);
  assert.equal(c.status, 'waiting');
  assert.equal(c.needsContact, true);
  assert.deepEqual(owner, [c.id], 'the owner is notified');
  assert.equal(statusOf(() => chat.customerContact(c.id, c.token, { contact: 'not a phone' }, 0, T0)), 400);
  const withContact = chat.customerContact(c.id, c.token, { name: 'Fatima Al Mansoori', contact: '050 123 4567' }, 0, T0 + 1000);
  assert.equal(withContact.contact, '+971501234567');
  assert.equal(withContact.needsContact, false);
  assert.match(withContact.messages.at(-1)!.body, /we’ll get back to you at \+971501234567/);

  // Nobody answers. Before the waiting time: nothing; after: one message, once (even with two copies of the shop sweeping).
  const wait = settings.getSettings('assistant').waitSeconds * 1000;
  assert.equal(chat.customerPoll(c.id, c.token, 0, T0 + wait - 5000).messages.filter((m) => /Thank you for waiting/.test(m.body)).length, 0);
  assert.ok(chat.sweepChats(T0 + wait + 1000) >= 1);
  assert.equal(chat.sweepChats(T0 + wait + 2000), 0);
  const after = chat.customerPoll(c.id, c.token, 0, T0 + wait + 3000).messages.filter((m) => /Thank you for waiting/.test(m.body));
  assert.equal(after.length, 1);
  assert.match(after[0].body, /\+971501234567/, 'on the contact details they gave');
});

test('no contact details yet when nobody answers: the reassurance asks for them', () => {
  const c = chat.customerAskPerson(...(() => {
    const s = chat.startChat({ message: 'hello' }, T0);
    return [s.id, s.token, 0, T0] as const;
  })());
  assert.equal(c.status, 'waiting');
  chat.sweepChats(T0 + 10 * 60 * 1000);
  const last = chat.chatForAdmin(c.id).messages.at(-1)!;
  assert.match(last.body, /leave your phone number or email/);
});

test('the owner replies: the customer sees it; it is emailed only if they left and gave an email', () => {
  customer.length = 0;
  const here = chat.startChat({ message: 'talk to a person', contact: 'here@example.com' }, Date.now());
  chat.adminReply(here.id, 'Hello! Yes we can.', 'admin', 'owner@shop.ae', Date.now());
  assert.deepEqual(customer, [], 'still on the page: no email');
  const view = chat.customerPoll(here.id, here.token, 0, Date.now());
  assert.equal(view.status, 'human');
  assert.equal(view.messages.at(-1)!.author, 'admin');
  assert.equal(view.messages.at(-1)!.body, 'Hello! Yes we can.');

  const gone = chat.startChat({ message: 'talk to a person', contact: 'Gone@Example.com' }, T0);
  chat.adminReply(gone.id, 'Sorry for the wait, here is the answer.', 'admin', 'owner@shop.ae', T0 + 10 * 60 * 1000);
  assert.deepEqual(customer, [[gone.id, 'Sorry for the wait, here is the answer.']]);
  const phoneOnly = chat.startChat({ message: 'talk to a person', contact: '+971501112222' }, T0);
  chat.adminReply(phoneOnly.id, 'We will WhatsApp you.', 'admin', 'owner@shop.ae', T0 + 10 * 60 * 1000);
  assert.equal(customer.length, 1, 'no email address: the hub offers WhatsApp instead');

  const list = chat.listChats('open');
  assert.ok(list.some((t) => t.id === gone.id && t.status === 'human'));
  assert.equal(statusOf(() => chat.adminReply(gone.id, '', 'admin', 'x')), 400);
  chat.setChatStatus(gone.id, 'closed', 'owner@shop.ae');
  assert.ok(!chat.listChats('open').some((t) => t.id === gone.id));
  assert.ok(chat.listChats('all').some((t) => t.id === gone.id));
});

test('replies by email: only the new text, only from the owner (or the customer’s own address), never twice, never forged', async () => {
  process.env.BACKUP_EMAIL = 'owner@shop.ae';
  process.env.SMTP_HOST = 'smtp.example.com';
  const c = chat.startChat({ message: 'talk to a person', contact: 'buyer@example.com' }, Date.now());
  const key = chat.threadRow(c.id)!.reply_key;
  const mail = (over: Partial<IncomingMail> = {}) => ({
    messageId: `<${Math.random()}@mail>`,
    subject: `Re: [Chat #${key}] buyer@example.com is waiting for an answer`,
    from: 'owner@shop.ae',
    text: 'Yes, the queen is back in stock on Monday.\n\nOn Wed, 15 Oct 2026 at 10:00, Shop <shop@shop.ae> wrote:\n> Customer: when is the queen back?\n',
    authResults: 'mx.shop.ae; spf=pass; dkim=pass; dmarc=pass',
    ...over,
  });
  const first = mail();
  assert.equal(await chatMail.acceptMail(first), 'owner');
  assert.equal(await chatMail.acceptMail(first), 'ignored', 'the same email twice is posted once');
  let msgs = chat.chatForAdmin(c.id).messages;
  assert.equal(msgs.at(-1)!.body, 'Yes, the queen is back in stock on Monday.', 'the quoted conversation is left out');
  assert.equal(msgs.at(-1)!.via, 'email');

  assert.equal(await chatMail.acceptMail(mail({ from: 'stranger@evil.example' })), 'ignored');
  assert.equal(await chatMail.acceptMail(mail({ authResults: 'mx; dmarc=fail' })), 'ignored', 'a forged owner address is refused');
  assert.equal(await chatMail.acceptMail(mail({ subject: 'Re: [Chat #ZZZZZZZZZZ] guess' })), 'ignored', 'unknown chat');
  assert.equal(await chatMail.acceptMail(mail({ from: 'Buyer@Example.com', text: 'Great, I will take it.' })), 'customer');
  msgs = chat.chatForAdmin(c.id).messages;
  assert.equal(msgs.at(-1)!.author, 'customer');
  assert.equal(chat.threadRow(c.id)!.status, 'human');

  assert.equal(chatMail.newText('Thanks!\n-----Original Message-----\nFrom: x'), 'Thanks!');
  assert.equal(chatMail.newText('Line one\n> quoted\nLine two\nSent from my iPhone'), 'Line one\nLine two');
  delete process.env.BACKUP_EMAIL;
  delete process.env.SMTP_HOST;
});

test('settings → Chat assistant: checked, and switching it off stops new chats', async () => {
  const bad = async (s: Record<string, unknown>) => {
    try {
      await settings.updateSettings('assistant', s);
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  };
  assert.equal(await bad({ waitSeconds: 5 }), 400);
  assert.equal(await bad({ entries: [{ question: 'Q', answer: '' }] }), 400);
  assert.equal(await bad({ entries: Array.from({ length: 201 }, (_, i) => ({ id: `a${i}`, question: 'Q', answer: 'A' })) }), 400);
  await settings.updateSettings('assistant', { entries: [{ id: 'oman', question: 'Oman?', keywords: 'Oman, Muscat ,  ', answer: 'Line one\nLine two' }] });
  const saved = settings.getSettings('assistant');
  assert.deepEqual(saved.entries[0].keywords, ['oman', 'muscat']);
  assert.equal(saved.entries[0].answer, 'Line one\nLine two', 'line breaks kept');
  await settings.updateSettings('assistant', { enabled: false });
  assert.equal(statusOf(() => chat.startChat({ message: 'hi' })), 404);
  await settings.updateSettings('assistant', { enabled: true });

  // The mailbox password is write-only and follows its server.
  await settings.updateSettings('email', { imapHost: '93.184.215.14', imapPass: 'box-secret' });
  assert.equal(settings.adminView('email').value.imapPass, '');
  assert.equal(settings.adminView('email').secretsSet.imapPass, true);
  await settings.updateSettings('email', { imapHost: '93.184.215.15' });
  assert.equal(settings.getSettings('email').imapPass, '', 'a new server drops the old password');
  try {
    await settings.updateSettings('email', { imapHost: '10.0.0.8' });
    assert.fail('a private mailbox server must be refused');
  } catch (e) {
    assert.equal((e as { status?: number }).status, 400);
  }
});

test('backups carry the chats (database and chats.csv), and the restore script restores them', async () => {
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  const csv = backup.openBackup(fs.readFileSync(result.file)).find((e) => e.name === 'chats.csv')!.data.toString();
  assert.match(csv, /chat_id,at,from,via/);
  assert.match(csv, /Yes, the queen is back in stock on Monday\./);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-chat-'));
  const r = spawnSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  const n = (db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n;
  db.close();
  assert.ok(n > 10);
});

// ── Review of BUH-02.01.00 ─────────────────────────────────────────────────

test('regression: the shop’s own notification and out-of-office replies are never posted as the owner’s reply', async () => {
  process.env.BACKUP_EMAIL = 'shop@shop.ae'; // one mailbox for everything, as on many hosts
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'shop@shop.ae';
  const c = chat.startChat({ message: 'talk to a person', contact: 'buyer2@example.com' }, Date.now());
  const key = chat.threadRow(c.id)!.reply_key;
  const base = { subject: `[Chat #${key}] buyer2@example.com is waiting for an answer`, from: 'shop@shop.ae', text: 'buyer2 would like to talk to someone.\n\nCustomer: talk to a person', authResults: 'dkim=pass; dmarc=pass' };
  assert.equal(await chatMail.acceptMail({ ...base, messageId: '<own@x>', ownMail: true }), 'ignored', 'our own notification');
  assert.equal(await chatMail.acceptMail({ ...base, messageId: '<ooo@x>', subject: `Automatic reply: [Chat #${key}] …` }), 'ignored', 'out of office');
  assert.equal(await chatMail.acceptMail({ ...base, messageId: '<auto@x>', autoSubmitted: 'auto-replied' }), 'ignored', 'Auto-Submitted');
  assert.equal(chat.threadRow(c.id)!.status, 'waiting', 'still waiting for a real answer');
  for (const k of ['BACKUP_EMAIL', 'SMTP_HOST', 'SMTP_FROM']) delete process.env[k];
});

test('regression: an email claiming to be from the owner needs the mail server’s DKIM or DMARC pass', async () => {
  process.env.BACKUP_EMAIL = 'owner@shop.ae';
  process.env.SMTP_HOST = 'smtp.example.com';
  const c = chat.startChat({ message: 'talk to a person', contact: 'sneaky@example.com' }, Date.now());
  const key = chat.threadRow(c.id)!.reply_key;
  const forged = { messageId: '<forged@x>', subject: `Re: [Chat #${key}] x`, from: 'owner@shop.ae', text: 'Refund approved, pay the fee at evil.example' };
  assert.equal(await chatMail.acceptMail({ ...forged, authResults: '' }), 'ignored', 'no verdict at all');
  assert.equal(await chatMail.acceptMail({ ...forged, messageId: '<f2@x>', authResults: 'spf=softfail; dmarc=none' }), 'ignored');
  assert.ok(!chat.chatForAdmin(c.id).messages.some((m) => m.author === 'admin'));
  // The customer's own reply needs no verdict (it can only speak as the customer).
  assert.equal(await chatMail.acceptMail({ ...forged, messageId: '<c1@x>', from: 'sneaky@example.com', text: 'Any news?', authResults: '' }), 'customer');
  for (const k of ['BACKUP_EMAIL', 'SMTP_HOST']) delete process.env[k];
});

test('regression: the sending password is never offered to a different mailbox server', async () => {
  assert.equal(chatMail.sameProvider('imap.hostinger.com', 'smtp.hostinger.com'), true);
  assert.equal(chatMail.sameProvider('imap.gmail.com', 'smtp.gmail.com'), true);
  assert.equal(chatMail.sameProvider('mail.shop.co.uk', 'smtp.shop.co.uk'), true);
  assert.equal(chatMail.sameProvider('evil.co.uk', 'smtp.shop.co.uk'), false);
  assert.equal(chatMail.sameProvider('mail.attacker.net', 'smtp.hostinger.com'), false);
  await settings.updateSettings('email', { smtpHost: '93.184.215.14', smtpUser: 'shop@shop.ae', smtpPass: 'smtp-secret', imapHost: '93.184.215.20', imapUser: '', imapPass: null });
  assert.equal(chatMail.mailboxConfig(), null, 'no password for an unrelated server');
});

test('regression: a reply posted meanwhile is not skipped when the customer sends; the owner can answer a full chat', () => {
  const c = chat.startChat({ message: 'talk to a person' }, Date.now());
  const seen = c.messages.at(-1)!.id;
  const ownerMsg = chat.adminReply(c.id, 'Owner reply while you typed', 'admin', 'owner@shop.ae');
  const after = chat.customerSend(c.id, c.token, 'my question', seen);
  assert.ok(after.messages.some((m) => m.id === ownerMsg.id), 'the reply is in the answer');

  const full = chat.startChat({ message: 'hi' }, Date.now());
  const db = getDb();
  const insert = db.prepare("INSERT INTO chat_messages (thread_id, at, author, body, via) VALUES (?, ?, 'customer', 'x', 'web')");
  for (let i = 0; i < 300; i++) insert.run(full.id, new Date().toISOString());
  assert.equal(statusOf(() => chat.customerSend(full.id, full.token, 'one more')), 429);
  assert.ok(chat.adminReply(full.id, 'We are here.', 'admin', 'owner@shop.ae').id > 0);
});

test('regression: two copies reading the same email post it once; owner emails are claimed once per 5 minutes', async () => {
  assert.equal(chat.claimMail('<same@x>'), true);
  assert.equal(chat.claimMail('<same@x>'), false);
  const c = chat.startChat({ message: 'talk to a person' }, Date.now());
  getDb().prepare('UPDATE chat_threads SET emailed_at = NULL WHERE id = ?').run(c.id);
  const now = Date.now();
  assert.deepEqual([chat.claimOwnerEmail(c.id, 300_000, now), chat.claimOwnerEmail(c.id, 300_000, now)], [true, false]);
  assert.equal(chat.claimOwnerEmail(c.id, 300_000, now + 301_000), true);
});

test('regression: chats only the assistant handled are removed after 30 days; handed-over ones are kept', () => {
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const bot = chat.startChat({ message: 'measurements please' }, old); // the size table answers it
  const person = chat.startChat({ message: 'talk to a person' }, old);
  chat.purgeOldBotChats();
  assert.equal(chat.threadRow(bot.id), undefined);
  assert.equal(getDb().prepare('SELECT COUNT(*) FROM chat_messages WHERE thread_id = ?').pluck().get(bot.id), 0);
  assert.ok(chat.threadRow(person.id));
});

test('regression: order problems go to a person; an owner’s answer beats the size table', () => {
  const sizes = DEFAULT_CATALOG.sizes;
  for (const q of ['My king duvet arrived damaged', 'I was charged twice by card', 'When will my order 1234 arrive, it is late', 'where is my order?']) {
    assert.equal(reply(q, DEFAULT_ASSISTANT, sizes).kind, 'handover', q);
  }
  assert.equal((reply('Can I return a queen sheet?', DEFAULT_ASSISTANT, sizes) as { entryId: string }).entryId, 'returns');
  assert.equal((reply('Can I pay by card?', DEFAULT_ASSISTANT, sizes) as { entryId: string }).entryId, 'payment');
});

test('the chat is called "Beautiful Home Assistant": the old default name is upgraded, a name the owner chose stays', () => {
  const db = getDb();
  const save = (name: string) => {
    db.prepare('INSERT INTO settings (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run('assistant', JSON.stringify({ ...DEFAULT_ASSISTANT, name }), new Date().toISOString());
    settings._clearSettingsCache();
  };
  assert.equal(DEFAULT_ASSISTANT.name, 'Beautiful Home Assistant');
  save('Shop assistant');
  assert.equal(settings.getSettings('assistant').name, 'Beautiful Home Assistant');
  save('Noura from the shop');
  assert.equal(settings.getSettings('assistant').name, 'Noura from the shop');
});
