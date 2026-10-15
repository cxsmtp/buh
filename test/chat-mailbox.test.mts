/** BUH-02.01.00: the shop reads its mailbox (IMAP over TLS) and posts replies to [Chat #…] emails into the chat. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { startFakeImap } from './fixtures/fake-imap.mjs';

tempDataDir();
process.env.BACKUP_EMAIL = 'owner@shop.ae';
process.env.SMTP_HOST = 'smtp.example.com';
process.env.IMAP_REJECT_UNAUTHORIZED = 'false'; // the fake server's own certificate

const chat = await import('@/lib/server/chat');
const chatMail = await import('@/lib/server/chatMail');
const { getDb } = await import('@/lib/server/db');

test('the mailbox is read over TLS; a reply to a chat email lands in the chat once and is marked read; others are left alone', async () => {
  chat.setChatNotifiers(null, null);
  const c = chat.startChat({ message: 'talk to a person', contact: 'buyer@example.com' });
  const key = getDb().prepare('SELECT reply_key FROM chat_threads WHERE id = ?').pluck().get(c.id) as string;
  const raw = (from: string, subject: string, body: string, id: string) =>
    `From: ${from}\nTo: shop@shop.ae\nSubject: ${subject}\nMessage-ID: <${id}@mail.test>\nAuthentication-Results: mx.shop.ae; spf=pass; dkim=pass; dmarc=pass\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\n${body}\n`;
  const imap = await startFakeImap('shop@shop.ae', 'box-pass', [
    { uid: 1, raw: raw('Owner <owner@shop.ae>', `Re: [Chat #${key}] buyer is waiting`, 'Yes, we deliver to Al Ain tomorrow =E2=9C=85\n\nOn Wed, Owner wrote:\n> old text', 'a1') },
    { uid: 2, raw: raw('Newsletter <news@example.com>', 'Weekly offers', 'not a chat', 'a2') },
  ]);
  process.env.IMAP_HOST = '127.0.0.1';
  process.env.IMAP_PORT = String(imap.port);
  process.env.IMAP_USER = 'shop@shop.ae';
  process.env.IMAP_PASS = 'box-pass';
  try {
    const posted = await chatMail.checkMailbox();
    assert.equal(posted, 1);
    const last = chat.chatForAdmin(c.id).messages.at(-1)!;
    assert.equal(last.author, 'admin');
    assert.equal(last.via, 'email');
    assert.equal(last.body, 'Yes, we deliver to Al Ain tomorrow ✅');
    assert.equal(imap.messages[0].seen, true, 'marked read');
    assert.equal(imap.messages[1].seen, undefined, 'other mail untouched');
    assert.equal(await chatMail.checkMailbox(), 0, 'nothing twice');
    assert.equal(chatMail.mailboxStatus().last?.ok, true);
    assert.ok(!imap.log.some((l) => l.includes('box-pass')), 'password not logged by the fake either');

    // A wrong password: reported in the hub, nothing breaks.
    process.env.IMAP_PASS = 'wrong';
    assert.equal(await chatMail.checkMailbox(), 0);
    assert.equal(chatMail.mailboxStatus().last?.ok, false);
  } finally {
    imap.close();
  }
});
