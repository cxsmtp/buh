import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SMTPServer } from 'smtp-server';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { placeOrder } = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const backup = await import('@/lib/server/backup');
const { toCsv } = backup;

function order(name: string, phone = '+971501234567') {
  const p = listProducts()[0];
  return placeOrder({
    idempotencyKey: `test-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: name, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order;
}

test('CSV cells cannot run as Excel formulas, and Arabic text survives', () => {
  const csv = toCsv(['a', 'b'], [['=HYPERLINK("x")', '+971501234567'], ['فاطمة', 'has "quotes", commas']]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes(`'+971501234567`));
  assert.ok(csv.includes('فاطمة'));
  assert.ok(csv.includes('"has ""quotes"", commas"'));
});

test('a backup contains the database, flat files and receipts; `tar` reads it; the restore script restores it', async () => {
  order('Fatima Al Mansoori');
  order('=cmd|calc');
  const result = await backup.createBackup();
  assert.equal(result.encrypted, false);
  assert.match(path.basename(result.file), /^buh-backup-\d{8}-\d{4}\.tar\.gz$/);

  // Any standard tar can open it.
  const listing = execFileSync('tar', ['-tzf', result.file]).toString();
  for (const f of ['shop.db', 'orders.csv', 'order_items.csv', 'customers.csv', 'products.csv', 'MANIFEST.sha256']) assert.ok(listing.includes(f), f);

  const entries = backup.openBackup(fs.readFileSync(result.file));
  const orders = entries.find((e) => e.name === 'orders.csv')!.data.toString();
  assert.match(orders, /Fatima Al Mansoori/);
  assert.match(orders, /'=cmd\|calc/, 'formula neutralised');

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-'));
  fs.rmSync(target, { recursive: true });
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]).toString();
  assert.match(out, /2 orders/);
  assert.match(out, /Integrity check: ok/);
  assert.ok(fs.existsSync(path.join(target, 'shop.db')));
});

test('encrypted backups: unreadable without the passphrase, restorable with it', async () => {
  process.env.BACKUP_PASSPHRASE = 'correct horse battery staple';
  try {
    const result = await backup.createBackup();
    assert.equal(result.encrypted, true);
    const raw = fs.readFileSync(result.file);
    assert.ok(!raw.includes(Buffer.from('Fatima')), 'no plain customer data');
    assert.throws(() => backup.openBackup(raw), /encrypted/);
    assert.throws(() => backup.openBackup(raw, 'wrong'), /Wrong passphrase/);
    assert.ok(backup.openBackup(raw, 'correct horse battery staple').some((e) => e.name === 'shop.db'));

    const target = path.join(os.tmpdir(), `buh-restore-enc-${Date.now()}`);
    const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target], { env: { ...process.env } }).toString();
    assert.match(out, /Integrity check: ok/);
  } finally {
    delete process.env.BACKUP_PASSPHRASE;
  }
});

test('a damaged backup is refused', async () => {
  const result = await backup.createBackup();
  const entries = backup.openBackup(fs.readFileSync(result.file));
  assert.ok(entries.length > 0);
  const raw = fs.readFileSync(result.file);
  raw[Math.floor(raw.length / 2)] ^= 0xff;
  assert.throws(() => backup.openBackup(raw));
});

test('scheduled run: emails the backup with flat files to BACKUP_EMAIL and records it', async () => {
  const mails: Array<{ to: string; raw: string }> = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (d) => (raw += d));
      stream.on('end', () => {
        mails.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as { port: number }).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_FROM: 'shop@test', BACKUP_EMAIL: 'owner@test' });
  process.env.SMTP_REQUIRE_TLS = 'false'; // the test mail server has no TLS
  try {
    const state = await backup.runBackup('manual');
    assert.equal(state.lastError, undefined, state.lastError);
    assert.equal(state.lastEmailError, undefined, state.lastEmailError);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'owner@test');
    for (const f of ['orders.csv', 'customers.csv', 'products.csv', 'order_items.csv', '.tar.gz']) assert.ok(mails[0].raw.includes(f), f);
    // Emailed in the clear: flagged until a passphrase is set.
    assert.equal(backup.backupHealth().level, 'warning');
    assert.match(backup.backupHealth().notice ?? '', /BACKUP_PASSPHRASE/);
    process.env.BACKUP_PASSPHRASE = 'short';
    assert.match(backup.backupHealth().notice ?? '', /at least 12/);
    process.env.BACKUP_PASSPHRASE = 'a long enough passphrase';
    assert.equal(backup.backupHealth().level, 'ok');
  } finally {
    delete process.env.BACKUP_PASSPHRASE;
    server.close();
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_FROM', 'BACKUP_EMAIL', 'SMTP_REQUIRE_TLS']) delete process.env[k];
  }
});

test('without email set up, backups still run locally and the admin hub shows a warning', async () => {
  const state = await backup.runBackup('manual');
  assert.equal(state.lastError, undefined);
  assert.match(state.lastEmailError || '', /not set up/);
  assert.equal(backup.backupHealth().level, 'warning');
});

test('only the newest 14 backups are kept', async () => {
  const bdir = path.join(dir, 'backups');
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(bdir, `buh-backup-20200101-${String(i).padStart(4, '0')}.tar.gz`), 'x');
  await backup.createBackup();
  assert.equal(fs.readdirSync(bdir).filter((f) => f.startsWith('buh-backup-')).length, 14);
});

test('overdue or failed backups show as failing', () => {
  const day = 24 * 3600_000;
  assert.equal(backup.backupHealth(Date.now() + 2 * day).level, 'failing');
});

test('restore --replace swaps the data in place, keeps the old data aside and the backups folder', async () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-live-'));
  fs.writeFileSync(path.join(live, 'shop.db'), 'old database');
  fs.mkdirSync(path.join(live, 'backups'));
  fs.writeFileSync(path.join(live, 'backups', 'keep.tar.gz'), 'x');
  const result = await backup.createBackup();
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, live, '--replace']).toString();
  assert.match(out, /Integrity check: ok/);
  assert.ok(fs.readFileSync(path.join(live, 'shop.db')).subarray(0, 15).toString().startsWith('SQLite format 3'));
  const aside = fs.readdirSync(live).find((f) => f.startsWith('replaced-'))!;
  assert.equal(fs.readFileSync(path.join(live, aside, 'shop.db'), 'utf8'), 'old database');
  assert.ok(fs.existsSync(path.join(live, 'backups', 'keep.tar.gz')));
});
