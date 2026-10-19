/**
 * The accountant's read-only sign-in (src/lib/server/staffAuth.ts): invited by the owner with a
 * one-time setup link (hashes only, 72 hours, once), whose path opens the hub's door only while the
 * invite is open; the same sign-in and pauses as the owner; a session that says "accountant" and that
 * requireAdmin refuses everywhere but the read-only allow-list; revoking (or a new link) ends every
 * session at once; signing out ends only the accountant's own; a restored data folder starts a new
 * epoch; all of it audited. (Every admin route over HTTP: test/accountant-routes.test.mts.)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD_HASH;
const auth = await import('@/lib/server/adminAuth');
const staff = await import('@/lib/server/staffAuth');
const link = await import('@/lib/server/adminLink');
const { getDb } = await import('@/lib/server/db');

const PASSWORD = 'Ledger-Reader-2026!';
const auditLines = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details: Record<string, unknown> }));
async function statusOf(fn: () => unknown) {
  try {
    await fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

let owner = '';
let invite: Awaited<ReturnType<typeof staff.inviteAccountant>>;

test('the owner invites an accountant: a one-time link (only hashes kept) whose path opens the hub for 72 hours', async () => {
  owner = (await auth.adminAccountInfo()).email;
  assert.equal(await statusOf(() => staff.inviteAccountant('not-an-email', '', owner, owner)), 400);
  assert.equal(await statusOf(() => staff.inviteAccountant(owner.toUpperCase(), '', owner, owner)), 400, 'not the owner’s own email');
  invite = staff.inviteAccountant(' CA@Firm.Test ', 'Our CA', owner, owner);
  assert.equal(invite.account.email, 'ca@firm.test');
  assert.equal(invite.account.role, 'accountant');
  assert.equal(invite.account.status, 'invited');
  assert.match(invite.grant, link.GRANT_PATTERN);
  const row = JSON.stringify(getDb().prepare('SELECT * FROM staff_accounts').all());
  assert.ok(!row.includes(invite.token) && !row.includes(invite.grant), 'only hashes are stored');
  const now = Date.now();
  assert.ok(link.resetGrantExpiry(invite.grant, now) > now, 'the setup path opens the door');
  assert.equal(link.resetGrantExpiry(invite.grant, now + staff.STAFF_SETUP_TTL_MS + 1000), 0, 'not after 72 hours');
  assert.equal(link.resetGrantExpiry(`${invite.grant.slice(0, -1)}${invite.grant.endsWith('A') ? 'B' : 'A'}`, now), 0);
  // The front gate gives a door for exactly that long.
  const gate = await import('@/lib/server/frontGate');
  link.createLinkIfAbsent('test');
  const d = gate.decide(`/${invite.grant}`, '', now);
  assert.equal(d.kind, 'hub');
  assert.ok(auditLines().some((l) => l.action === 'accountant.invited' && l.details.staffId === invite.account.id && l.details.by === owner));
});

test('setup: a good password once, within 72 hours; then the accountant signs in with the same form', async () => {
  assert.equal(await statusOf(() => staff.completeStaffSetup('x'.repeat(43), PASSWORD)), 400, 'unknown token');
  assert.equal(await statusOf(() => staff.completeStaffSetup(invite.token, PASSWORD, Date.now() + staff.STAFF_SETUP_TTL_MS + 1000)), 400, 'expired');
  const s = await staff.completeStaffSetup(invite.token, PASSWORD);
  assert.equal(s.email, 'ca@firm.test');
  assert.equal(await statusOf(() => staff.completeStaffSetup(invite.token, PASSWORD)), 400, 'used once');
  assert.equal(link.resetGrantExpiry(invite.grant), 0, 'the setup path no longer opens anything');
  assert.ok(auditLines().some((l) => l.action === 'accountant.setup_done'));
  // Sign in: the same function, the same answers.
  assert.equal(await statusOf(() => auth.signIn('ca@firm.test', 'wrong-password-123')), 401);
  const r = await auth.signIn('CA@firm.test', PASSWORD);
  assert.equal(r.role, 'accountant');
  const session = await auth.verifySessionToken(r.token);
  assert.equal(session?.role, 'accountant');
  assert.equal(session?.email, 'ca@firm.test');
  assert.equal(session?.staffId, invite.account.id);
  assert.equal(session?.mustChangePassword, false);
});

test('an accountant session can’t be turned into an owner one, and is refused by owner-only checks', async () => {
  const r = await auth.signIn('ca@firm.test', PASSWORD);
  const [body, sig] = r.token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  delete payload.r;
  const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
  assert.equal(await auth.verifySessionToken(forged), null, 'the role is signed');
  const other = auth.signSessionPayload({ ...payload, r: 'owner' });
  assert.equal(await auth.verifySessionToken(other), null, 'no other role exists');
  // The guard: deny by default.
  const src = fs.readFileSync('src/lib/server/guard.ts', 'utf8');
  assert.match(src, /allow = OWNER_ONLY/);
  assert.match(src, /const OWNER_ONLY: readonly AdminRole\[\] = \['owner'\]/);
  // The link reveal is never shown to an accountant.
  assert.match(fs.readFileSync('src/lib/server/frontGate.ts', 'utf8'), /session\.role !== 'owner'\) return null/);
});

test('signing out ends only the accountant’s sessions; the owner’s carry on', async () => {
  const ownerSession = (await auth.passkeySession()).token;
  assert.equal((await auth.verifySessionToken(ownerSession))?.role, 'owner');
  const r = await auth.signIn('ca@firm.test', PASSWORD);
  const before = await auth.verifySessionToken(r.token);
  assert.ok(before);
  staff.endStaffSessions(before.staffId!);
  assert.equal(await auth.verifySessionToken(r.token), null);
  assert.equal((await auth.verifySessionToken(ownerSession))?.role, 'owner', 'the owner is still signed in');
  // And the owner signing out everywhere doesn't end the accountant's.
  const again = await auth.signIn('ca@firm.test', PASSWORD);
  auth.endAllSessions();
  assert.ok(await auth.verifySessionToken(again.token));
});

test('revoking ends every session and the password at once; a new setup link starts again', async () => {
  const r = await auth.signIn('ca@firm.test', PASSWORD);
  const revoked = staff.revokeStaff(invite.account.id, owner);
  assert.equal(revoked.status, 'revoked');
  assert.equal(await auth.verifySessionToken(r.token), null, 'signed out at once');
  assert.equal(await statusOf(() => auth.signIn('ca@firm.test', PASSWORD)), 401, 'the password no longer works');
  assert.ok(auditLines().some((l) => l.action === 'accountant.revoked' && l.details.by === owner));
  assert.equal(await statusOf(() => staff.revokeStaff('acc_nope123', owner)), 404);
  // Invited again: a new link; the old one never comes back.
  const again = staff.inviteAccountant('ca@firm.test', '', owner, owner);
  assert.equal(again.account.status, 'invited');
  assert.equal(again.account.name, 'Our CA', 'the name kept');
  assert.equal(await statusOf(() => staff.completeStaffSetup(invite.token, PASSWORD)), 400);
  const s = await staff.completeStaffSetup(again.token, `${PASSWORD}x`);
  assert.equal(s.email, 'ca@firm.test');
  const fresh = await auth.signIn('ca@firm.test', `${PASSWORD}x`);
  // A new setup link for an active account ends its sessions too.
  staff.inviteAccountant('ca@firm.test', '', owner, owner);
  assert.equal(await auth.verifySessionToken(fresh.token), null);
  assert.equal(staff.listStaff().filter((a) => a.email === 'ca@firm.test').length, 1, 'one account per email');
});

test('a restored data folder starts a new staff-session epoch: earlier accountant cookies stop working', async () => {
  const again = staff.inviteAccountant('second@firm.test', '', owner, owner);
  await staff.completeStaffSetup(again.token, PASSWORD);
  const r = await auth.signIn('second@firm.test', PASSWORD);
  assert.ok(await auth.verifySessionToken(r.token));
  fs.rmSync(path.join(dir, 'staff-session-state.json'));
  assert.equal(await auth.verifySessionToken(r.token), null);
});

test('wrong passwords for an accountant count towards the same pauses as the owner’s', async () => {
  const ip = '203.0.113.9';
  for (let i = 0; i < 5; i++) await statusOf(() => auth.signIn('second@firm.test', 'nope-nope-nope', { ip }));
  assert.equal(await statusOf(() => auth.signIn('second@firm.test', PASSWORD, { ip })), 429, 'paused, the right password not even checked');
});
