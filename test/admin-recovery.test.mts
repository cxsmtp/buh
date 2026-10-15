/**
 * BUH-02.00.00: the admin sets their own sign-in email and mail server, and a
 * forgotten password is reset with a one-time emailed link.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD_HASH;
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'BACKUP_EMAIL', 'SMTP_FROM']) delete process.env[k];

const auth = await import('@/lib/server/adminAuth');
const settings = await import('@/lib/server/settings');
const mail = await import('@/lib/server/mail');

const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e) => (typeof e?.status === 'number' ? e.status : -1));
const PW = 'Owner-Own-Passphrase-1';

async function setUp() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(String(msg));
  try {
    await auth.signIn('nobody@example.com', 'x').catch(() => {});
  } finally {
    console.log = original;
  }
  const once = lines.join('\n').match(/Password: (\S+)/)![1];
  await auth.changePassword(once, PW);
}

test('forgot password: a link only for the admin email, single use, ends every session', async () => {
  await setUp();
  const session = (await auth.signIn('admin@beautifuluaehome.com', PW)).token;
  assert.equal(await auth.startPasswordReset('someone@else.com'), null, 'no link for another email');
  const token = await auth.startPasswordReset('  ADMIN@beautifuluaehome.com ');
  assert.ok(token && token.length >= 40);

  assert.equal(await statusOf(auth.completePasswordReset('not-the-token', 'Brand-New-Passphrase-2')), 400);
  await auth.completePasswordReset(token!, 'Brand-New-Passphrase-2');
  assert.equal(await auth.verifySessionToken(session), null, 'old sessions end');
  assert.equal(await statusOf(auth.signIn('admin@beautifuluaehome.com', PW)), 401, 'old password no longer works');
  assert.ok((await auth.signIn('admin@beautifuluaehome.com', 'Brand-New-Passphrase-2')).token);
  assert.equal(await statusOf(auth.completePasswordReset(token!, 'Third-Passphrase-333')), 400, 'the link works once');
});

test('two uses of one reset link at the same moment: only one succeeds', async () => {
  const token = (await auth.startPasswordReset('admin@beautifuluaehome.com'))!;
  const results = await Promise.all([
    statusOf(auth.completePasswordReset(token, 'Racing-Passphrase-AAA')),
    statusOf(auth.completePasswordReset(token, 'Racing-Passphrase-BBB')),
  ]);
  assert.deepEqual(results.sort(), [0, 400]);
});

test('a reset link expires after 30 minutes; asking again keeps earlier links valid; at most 3 an hour', async (t) => {
  const first = (await auth.startPasswordReset('admin@beautifuluaehome.com'))!;
  const second = (await auth.startPasswordReset('admin@beautifuluaehome.com'))!;
  const third = (await auth.startPasswordReset('admin@beautifuluaehome.com'))!;
  assert.ok(first && second && third);
  // A stranger who knows the email can't flood the owner or cancel the owner's link.
  assert.equal(await auth.startPasswordReset('admin@beautifuluaehome.com'), null, 'no fourth link within the hour');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 60 * 1000 });
  assert.equal(await statusOf(auth.completePasswordReset(second, 'Expired-Passphrase-1')), 400, 'expired');
  assert.ok(await auth.startPasswordReset('admin@beautifuluaehome.com'), 'a new link once the old ones expired');
  t.mock.timers.reset();
});

test('the admin changes their sign-in email (current password needed); reset links go to the new one', async () => {
  // The race above left one of the two passwords in place.
  const password = (await statusOf(auth.signIn('admin@beautifuluaehome.com', 'Racing-Passphrase-AAA'))) === 0 ? 'Racing-Passphrase-AAA' : 'Racing-Passphrase-BBB';
  const current = await auth.signIn('admin@beautifuluaehome.com', password);
  assert.equal(await statusOf(auth.changeAdminEmail('wrong-password', 'owner@shop.ae', { ip: '198.51.100.20' })), 401);
  assert.equal(await statusOf(auth.changeAdminEmail(password, 'not an email')), 400);
  const token = await auth.changeAdminEmail(password, ' Owner@Shop.ae ');
  assert.ok(await auth.verifySessionToken(token));
  assert.equal(await auth.verifySessionToken(current.token), null, 'other sessions end');
  assert.deepEqual(await auth.adminAccountInfo(), { email: 'owner@shop.ae', managedByEnv: false });
  assert.equal(await auth.startPasswordReset('admin@beautifuluaehome.com'), null);
  assert.ok(await auth.startPasswordReset('owner@shop.ae'));
  assert.ok((await auth.signIn('OWNER@shop.ae', password)).token);
});

test('email settings: public mail server only, known ports, password write-only, used before .env', async () => {
  assert.equal(mail.mailConfig(), null);
  assert.equal(mail.emailConfigured(), false);
  const bad = async (s: Record<string, unknown>) => statusOf(settings.updateSettings('email', s));
  assert.equal(await bad({ smtpHost: '127.0.0.1' }), 400, 'loopback refused');
  assert.equal(await bad({ smtpHost: '10.1.2.3' }), 400, 'private refused');
  assert.equal(await bad({ smtpHost: '169.254.169.254' }), 400, 'cloud metadata refused');
  assert.equal(await bad({ smtpHost: 'bad host!' }), 400);
  assert.equal(await bad({ smtpHost: '93.184.215.14', smtpPort: 3306 }), 400, 'not a mail port');
  assert.equal(await bad({ smtpHost: '93.184.215.14', sendTo: 'a@b.c, not-an-email' }), 400);

  process.env.SMTP_HOST = 'env-relay.example';
  process.env.BACKUP_EMAIL = 'env@example.com';
  await settings.updateSettings('email', { smtpHost: '93.184.215.14', smtpPort: 465, smtpSecurity: 'tls', smtpUser: 'shop@shop.ae', smtpPass: 'mailbox-secret', fromAddress: 'shop@shop.ae', sendTo: 'me@shop.ae, partner@shop.ae' });
  const view = settings.adminView('email');
  assert.equal(view.value.smtpPass, '', 'never sent back');
  assert.equal(view.secretsSet.smtpPass, true);
  const config = mail.mailConfig()!;
  assert.equal(config.source, 'settings');
  assert.equal(config.host, '93.184.215.14');
  assert.equal(config.pass, 'mailbox-secret');
  assert.equal(config.secure, true);
  assert.equal(config.to, 'me@shop.ae, partner@shop.ae');
  assert.equal(mail.sender(), 'shop@shop.ae');

  // Saving again without a password keeps it; a different server drops it (it was for the old one).
  await settings.updateSettings('email', { ...view.value, smtpPass: '' });
  assert.equal(mail.mailConfig()!.pass, 'mailbox-secret');
  await settings.updateSettings('email', { ...view.value, smtpHost: '93.184.215.15', smtpPass: '' });
  assert.equal(mail.mailConfig()!.pass, '');

  // Empty server: back to .env.production.
  await settings.updateSettings('email', { ...view.value, smtpHost: '', sendTo: '' });
  assert.equal(mail.mailConfig()!.source, 'environment');
  assert.equal(mail.ownerEmail(), 'env@example.com');
  delete process.env.SMTP_HOST;
  delete process.env.BACKUP_EMAIL;
});

test('regression: the answer to "Forgot password?" is as quick for the admin email as for any other (a slow mail server can\'t reveal it)', async () => {
  const net = await import('node:net');
  // A mail server that accepts the connection and never says a word.
  const silent = net.createServer(() => {});
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
  const port = (silent.address() as { port: number }).port;
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  process.env.BACKUP_EMAIL = 'owner@shop.ae';
  process.env.NEXT_PUBLIC_APP_URL = 'https://shop.example';
  await settings.updateSettings('email', { smtpHost: '', sendTo: '' });
  const { POST } = await import('@/app/api/admin/password/forgot/route');
  const ask = async (email: string) => {
    const started = Date.now();
    const res = await POST(new Request('https://shop.example/api/admin/password/forgot', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://shop.example', host: 'shop.example' }, body: JSON.stringify({ email }) }));
    return { ms: Date.now() - started, body: await res.json() };
  };
  const stranger = await ask('stranger@example.com');
  const owner = await ask('owner@shop.ae');
  assert.equal(owner.body.message, stranger.body.message, 'the same answer');
  assert.ok(owner.ms < 1000, `answered in ${owner.ms} ms, not after the mail server`);
  silent.close();
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL', 'NEXT_PUBLIC_APP_URL']) delete process.env[k];
});
