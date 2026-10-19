/**
 * Reported: "I gave you the real API key — why is the label not real?" Live mode was off (and the
 * hub had no switch for it), so bookings were simulated. Now: Test mode books in Jeebly's demo
 * system with separate sandbox keys; the Sandbox check (create → label PDF → track → cancel, a
 * PREPAID TEST shipment) must pass before Live mode can be switched on, and Jeebly's live address
 * must be set (enforced in the settings save, not only the hub); the owner's override needs the
 * route's typed phrase and is audited (test/courier-e2e.test.mts); sandbox keys are write-only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { installJeeblyMock } from './fixtures/jeebly-mock.mjs';

const dir = tempDataDir();
const { updateSettings, getSettings, adminView, sandboxCheckFresh, SANDBOX_CHECK_KV } = await import('@/lib/server/settings');
const { runSandboxCheck, lastSandboxCheck } = await import('@/lib/server/jeeblySandbox');
const { kvSet } = await import('@/lib/server/kv');

type Call = { host: string; path: string; headers: Record<string, string>; body: Record<string, unknown> };
let mock: { calls: Call[]; restore: () => void } = installJeeblyMock();
afterEach(() => {
  mock.restore();
  mock = installJeeblyMock();
});

function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
const PICKUP = { pickupPhone: '+971501112222', pickupUnit: 'Shop 4', pickupBuilding: 'Barsha Tower', pickupArea: 'Al Barsha 1', pickupLandmark: 'Near the mall', pickupEmirate: 'Dubai' };

test('starter courier settings invent nothing: no keys, no pickup, no live address, no account numbers', () => {
  const c = getSettings('courier');
  for (const k of ['pickupAddress', 'pickupLocationName', 'pickupBuilding', 'pickupArea', 'pickupUnit', 'pickupLandmark', 'sandboxApiKey', 'liveBaseUrl'] as const) assert.equal(c.jeebly[k], '', k);
  assert.equal(c.echo.accountId, '');
  assert.equal(c.echo.hubCode, '');
  assert.equal(c.packagingGrams, 200);
});

test('sandbox keys are write-only: masked in what the hub reads, kept on the server', async () => {
  await updateSettings('courier', { jeebly: { sandboxApiKey: 'SB-KEY-123456', sandboxClientKey: 'SB-CLIENT-654321', ...PICKUP } });
  const view = adminView('courier');
  assert.equal(view.value.jeebly.sandboxApiKey, '');
  assert.equal(view.value.jeebly.sandboxClientKey, '');
  assert.equal(view.secretsSet['jeebly.sandboxApiKey'], true);
  assert.equal(view.secretsSet['jeebly.sandboxClientKey'], true);
  assert.ok(!JSON.stringify(view).includes('SB-KEY-123456'));
  assert.equal(getSettings('courier').jeebly.sandboxApiKey, 'SB-KEY-123456');
});

test("Jeebly's live address: https on jeebly.com only, checked on the server", async () => {
  for (const bad of ['http://portal.jeebly.com', 'https://jeebly.com.evil.example', 'https://portal.jeebly.com:8443', 'https://169.254.169.254']) {
    await assert.rejects(updateSettings('courier', { jeebly: { liveBaseUrl: bad } }), (e: { status?: number }) => e.status === 400, bad);
  }
  await updateSettings('courier', { jeebly: { liveBaseUrl: 'https://Portal.Jeebly.com/' } });
  assert.equal(getSettings('courier').jeebly.liveBaseUrl, 'https://portal.jeebly.com');
});

test('regression: Live mode is refused without a passed Sandbox check, and without the live address', async () => {
  await assert.rejects(updateSettings('courier', { jeebly: { isLive: true } }), (e) => code(e) === 'sandbox_check_required' && /Run the Sandbox check first/.test((e as Error).message));
  assert.equal(getSettings('courier').jeebly.isLive, false);
  // An autosave is the same save: refused too.
  await assert.rejects(updateSettings('courier', { jeebly: { isLive: true } }, { auto: true }), (e) => code(e) === 'sandbox_check_required');
  await assert.rejects(updateSettings('courier', { jeebly: { isLive: true, liveBaseUrl: '' } }, { liveOverride: true }), (e) => code(e) === 'live_base_required', 'the override never skips the address');
  await updateSettings('courier', { jeebly: { liveBaseUrl: 'https://portal.jeebly.com' } });
});

test('a failed Sandbox check (Jeebly refused the keys) is stored and audited, and does not open Live mode', async () => {
  mock.restore();
  mock = installJeeblyMock({ create: () => ({ status: 400, body: { success: 'false', message: 'Invalid API Token SB-CLIENT-654321' } }) });
  const check = await runSandboxCheck('owner@shop.test');
  assert.equal(check.passed, false);
  assert.deepEqual(check.steps.map((s) => [s.step, s.result]), [['create', 'fail'], ['label', 'not_checked'], ['tracking', 'not_checked'], ['cancel', 'not_checked']]);
  assert.equal(check.steps[0].httpStatus, 400);
  assert.match(check.steps[0].said, /Invalid API Token \[redacted\].*Check the Jeebly keys/);
  assert.equal(lastSandboxCheck()!.passed, false);
  assert.ok(auditEntries().some((e) => e.action === 'courier.sandbox_check' && e.details.result === 'failed'));
  await assert.rejects(updateSettings('courier', { jeebly: { isLive: true } }), (e) => code(e) === 'sandbox_check_required');
});

test('the Sandbox check: a PREPAID TEST shipment in the demo system, created, its label PDF, tracked, cancelled; then Live can go on', async () => {
  const check = await runSandboxCheck('owner@shop.test');
  assert.equal(check.passed, true, JSON.stringify(check.steps));
  assert.match(check.awb!, /^JB\d+$/);
  assert.deepEqual(check.steps.map((s) => [s.step, s.result]), [['create', 'pass'], ['label', 'pass'], ['tracking', 'pass'], ['cancel', 'pass']]);
  assert.deepEqual(mock.calls.map((c) => c.path), ['create_shipment', 'generate_shipment_label', 'track_shipment', 'cancel_shipment']);
  for (const c of mock.calls) {
    assert.equal(c.host, 'demo.jeebly.com');
    assert.equal(c.headers['x-api-key'], 'SB-KEY-123456', 'the sandbox keys');
  }
  const body = mock.calls[0].body;
  assert.equal(body.payment_type, 'PREPAID');
  assert.equal(body.cod_amount, undefined, 'nothing to collect');
  assert.match(String(body.destination_address_name), /TEST/);
  assert.match(String(body.customer_reference_number), /^TEST-/);
  assert.equal(body.origin_address_building_name, 'Barsha Tower', "the owner's pickup");
  assert.deepEqual(mock.calls.slice(1).map((c) => c.body), [1, 2, 3].map(() => ({ reference_number: check.awb })));
  assert.match(check.steps[2].said, /Last status: Pickup Scheduled/);
  assert.equal(check.steps[3].said, 'Shipment cancelled successfully');
  assert.ok(auditEntries().some((e) => e.action === 'courier.sandbox_check' && e.details.result === 'passed' && e.details.awb === check.awb));
  assert.equal(sandboxCheckFresh(), true);
  await updateSettings('courier', { jeebly: { isLive: true } });
  assert.equal(getSettings('courier').jeebly.isLive, true);
  await updateSettings('courier', { jeebly: { isLive: false } });
});

test("a Sandbox check whose cancel Jeebly refuses fails, with Jeebly's words", async () => {
  mock.restore();
  mock = installJeeblyMock({ cancel: () => ({ status: 400, body: { success: 'false1', message: 'Shipment can not be Cancel' } }) });
  const check = await runSandboxCheck('owner@shop.test');
  assert.equal(check.passed, false);
  assert.equal(check.steps[3].result, 'fail');
  assert.equal(check.steps[3].said, 'Shipment can not be Cancel');
});

test('a passed check older than 30 days no longer opens Live mode', async () => {
  kvSet(SANDBOX_CHECK_KV, { at: new Date(Date.now() - 31 * 86_400_000).toISOString(), by: 'x', passed: true, steps: [] });
  assert.equal(sandboxCheckFresh(), false);
  await assert.rejects(updateSettings('courier', { jeebly: { isLive: true } }), (e) => code(e) === 'sandbox_check_required');
  // The override (the route, after the typed phrase and its audit entry) is the only way past it.
  await updateSettings('courier', { jeebly: { isLive: true } }, { liveOverride: true });
  assert.equal(getSettings('courier').jeebly.isLive, true);
});

test('changing the live address drops the live keys unless they are typed again', async () => {
  await updateSettings('courier', { jeebly: { apiKey: 'LIVE-KEY-1', clientKey: 'LIVE-CLIENT-1' } });
  await updateSettings('courier', { jeebly: { liveBaseUrl: 'https://other.jeebly.com' } });
  assert.equal(getSettings('courier').jeebly.apiKey, '', 'a key goes only to the address it was saved for');
  assert.equal(getSettings('courier').jeebly.clientKey, '');
});

test('the Sandbox check needs the sandbox keys and the pickup details, and says so', async () => {
  await updateSettings('courier', { jeebly: { isLive: false, sandboxApiKey: null, sandboxClientKey: null } });
  const check = await runSandboxCheck('owner@shop.test');
  assert.equal(check.passed, false);
  assert.match(check.steps[0].said, /sandbox keys/);
  await updateSettings('courier', { jeebly: { sandboxApiKey: 'SB-KEY-123456', sandboxClientKey: 'SB-CLIENT-654321', pickupArea: '' } });
  const noArea = await runSandboxCheck('owner@shop.test');
  assert.match(noArea.steps[0].said, /Add your pickup area in Couriers/);
  assert.equal(mock.calls.length, 0);
  await updateSettings('courier', { jeebly: PICKUP });
});

test('the override route checks the phrase and audits before switching on (source)', () => {
  const src = fs.readFileSync('src/app/api/courier/live/route.ts', 'utf8');
  assert.match(src, /requireAdmin\(req\)/);
  assert.ok(src.indexOf("auditOrThrow('courier.live_override'") < src.indexOf('await updateSettings('), 'audited before Live is switched on');
  assert.match(src, /LIVE_OVERRIDE_PHRASE/);
});

test('backups keep the Sandbox check and the pickup details, and blank the sandbox keys; the restore script restores them', async () => {
  delete process.env.BACKUP_PASSPHRASE;
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const Database = (await import('better-sqlite3')).default;
  await updateSettings('courier', { jeebly: { sandboxApiKey: 'SB-KEY-BACKUP-1', sandboxClientKey: 'SB-CLIENT-BACKUP-1', pickupBuilding: 'Backup Tower' } });
  await runSandboxCheck('owner@shop.test');
  const { createBackup } = await import('@/lib/server/backup');
  const result = await createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-'));
  fs.rmSync(target, { recursive: true });
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  try {
    const check = JSON.parse((db.prepare('SELECT data FROM kv WHERE key = ?').get(SANDBOX_CHECK_KV) as { data: string }).data);
    assert.equal(check.passed, true);
    const courier = JSON.parse((db.prepare("SELECT data FROM settings WHERE key = 'courier'").get() as { data: string }).data);
    assert.equal(courier.jeebly.pickupBuilding, 'Backup Tower');
    assert.equal(courier.jeebly.sandboxApiKey, '', 'keys are not in backups');
    assert.equal(courier.jeebly.sandboxClientKey, '');
  } finally {
    db.close();
  }
});
