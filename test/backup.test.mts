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
    assert.throws(() => backup.openBackup(raw, 'wrong'), /Wrong password: this backup was made with another backup password \(fingerprint [a-f0-9]{12}\)/);
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
    // The alert points to the card in the hub, never to a server setting.
    assert.equal(backup.backupHealth().notice, 'Backups are emailed unencrypted: anyone with a backup email can read customers’ details. Protect them with a password in Settings → System & backups.');
    assert.doesNotMatch(backup.backupHealth().notice ?? '', /BACKUP_PASSPHRASE|env/i);
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

test('the newest 14 backups are always kept; older ones go at most 5 a run, aged from the 14th newest', async () => {
  const bdir = path.join(dir, 'backups');
  for (const f of fs.readdirSync(bdir).filter((n) => n.startsWith('buh-backup-'))) fs.rmSync(path.join(bdir, f));
  const old = Array.from({ length: 20 }, (_, i) => `buh-backup-20200101-${String(i).padStart(4, '0')}.tar.gz`);
  const recent = Array.from({ length: 14 }, (_, i) => `buh-backup-20200201-${String(i).padStart(4, '0')}.tar.gz`);
  for (const f of [...old, ...recent]) fs.writeFileSync(path.join(bdir, f), 'x');
  const list = () => fs.readdirSync(bdir).filter((f) => f.startsWith('buh-backup-'));
  const start = Date.now();
  await backup.createBackup(new Date(start));
  assert.equal(list().length, 35 - 5, 'five of the oldest went');
  assert.deepEqual(old.slice(0, 5).filter((f) => list().includes(f)), [], 'the oldest first');
  for (let i = 1; i <= 3; i++) await backup.createBackup(new Date(start + i * 60_000));
  assert.deepEqual(old.filter((f) => list().includes(f)), [], 'every one from January is gone');
  for (const f of recent) assert.ok(list().includes(f), `${f} (14 days before the 14th newest) stays`);
  assert.equal(list().length, 14 + 4);
});

test('overdue backups show as failing: changes waiting too long, or no backup for 8 days with the weekly check on; a quiet shop is fine', async () => {
  const day = 24 * 3600_000;
  await backup.runBackup('manual');
  // Nothing new since: two days later the shop is not failing (only the "not emailed" warning).
  assert.notEqual(backup.backupHealth(Date.now() + 2 * day).level, 'failing');
  assert.equal(backup.backupHealth(Date.now() + 9 * day).level, 'failing');
  assert.match(backup.backupHealth(Date.now() + 9 * day).overdueText ?? '', /8 days/);
  // A change waiting past its 2 hours (plus an hour's grace) is failing.
  order('Late Change');
  assert.notEqual(backup.backupHealth(Date.now() + 2.5 * 3600_000).level, 'failing');
  assert.equal(backup.backupHealth(Date.now() + 3.5 * 3600_000).level, 'failing');
  assert.match(backup.backupHealth(Date.now() + 3.5 * 3600_000).overdueText ?? '', /orders/);
  await backup.runBackup('manual');
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

test('passkeys and recovery codes are in the backup and restored, but switched off until reviewed (the backup may predate a revocation)', async () => {
  const { SoftAuthenticator } = await import('./fixtures/soft-authenticator.mjs');
  const passkeys = await import('@/lib/server/passkeys');
  const { consumeRecoveryCode, createRecoveryCodes, recoveryCodeStatus } = await import('@/lib/server/recoveryCodes');
  const { _closeDb, getDb } = await import('@/lib/server/db');
  const rp = { rpID: 'shop.example', origin: 'https://shop.example' };

  const codes = createRecoveryCodes();
  assert.ok(consumeRecoveryCode(codes[0]));
  const phone = new SoftAuthenticator();
  const reg = await passkeys.startPasskeyRegistration({ rp, email: 'admin@beautifuluaehome.com', boundTo: 'b' });
  await passkeys.finishPasskeyRegistration({ rp, challengeId: reg.challengeId, boundTo: 'b', response: passkeys.parseRegistrationResponse(phone.register(reg.options as never, rp.origin)), name: 'Owner phone' });
  await passkeys.startPasskeySignIn({ rp }); // a half-finished sign-in: not worth keeping
  const before = getDb().prepare('SELECT * FROM admin_passkeys').get() as { public_key: Buffer };

  const result = await backup.createBackup();
  const target = path.join(os.tmpdir(), `buh-restore-signin-${Date.now()}`);
  // After the backup the owner loses that phone: removes its passkey, makes new codes.
  passkeys.removePasskey(phone.id);
  createRecoveryCodes();

  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]).toString();
  assert.match(out, /IMPORTANT: Admin Hub passkeys and recovery codes from this backup are switched off/);
  assert.match(out, /9 unused recovery codes were voided/);
  assert.match(out, /1 passkey is switched off until you confirm it/);

  const Database = (await import('better-sqlite3')).default;
  const restored = new Database(path.join(target, 'shop.db'), { readonly: true });
  const row = restored.prepare('SELECT * FROM admin_passkeys').get() as { name: string; public_key: Buffer; rp_id: string };
  assert.equal(row.name, 'Owner phone', 'the passkey is restored (to review), not lost');
  assert.equal(Buffer.compare(row.public_key, before.public_key), 0);
  assert.equal(row.rp_id, 'shop.example');
  assert.equal((restored.prepare('SELECT COUNT(*) AS n FROM admin_recovery_codes').get() as { n: number }).n, 0, 'old codes voided');
  assert.equal((restored.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').get() as { n: number }).n, 0, 'challenges left out');
  restored.close();

  // The restored shop: the lost phone's passkey and the old codes don't open it.
  _closeDb();
  process.env.DATA_DIR = target;
  try {
    assert.equal(recoveryCodeStatus().remaining, 0);
    assert.equal(consumeRecoveryCode(codes[1]), false, 'an old code is void');
    const notice = passkeys.restoreNotice()!;
    assert.equal(notice.suspendedPasskeys, 1);
    assert.equal(notice.backup, path.basename(result.file));
    assert.deepEqual(passkeys.listPasskeys(rp.rpID).map((p) => p.suspended), [true]);
    const tryIt = async () => {
      const signIn = await passkeys.startPasskeySignIn({ rp });
      return passkeys.finishPasskeySignIn({ rp, challengeId: signIn.challengeId, response: passkeys.parseAuthenticationResponse(phone.signIn(signIn.options as never, rp.origin)) });
    };
    await assert.rejects(tryIt(), /restored backup/);
    // The owner (signed in with the password) keeps it: it works again. Or removes it.
    passkeys.confirmPasskey(phone.id);
    assert.equal((await tryIt()).name, 'Owner phone');
    passkeys.dismissRestoreNotice();
    assert.equal(passkeys.restoreNotice(), null);
  } finally {
    _closeDb();
    process.env.DATA_DIR = dir;
  }
});
