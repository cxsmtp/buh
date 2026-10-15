/** Settings → Versions: the bundled changelog, the updater's status, and switch requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-versions-'));
const statusDir = path.join(dir, 'status');
const controlDir = path.join(dir, 'control');
fs.mkdirSync(statusDir);
fs.mkdirSync(controlDir);
process.env.UPDATER_STATUS_DIR = statusDir;
process.env.UPDATER_CONTROL_DIR = controlDir;

const v = await import('@/lib/server/versions');

const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
function writeStatus(over: Record<string, unknown> = {}) {
  fs.rmSync(path.join(statusDir, 'status.json'), { force: true });
  fs.writeFileSync(
    path.join(statusDir, 'status.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), running: '2.0.0', lastGood: '2.0.0', previous: '', onServer: ['2.0.0'], autoUpdateMinutes: 15, lastRequest: { request: '', result: '', message: '', at: '' }, ...over })
  );
}
const request = () => (fs.existsSync(path.join(controlDir, 'request')) ? fs.readFileSync(path.join(controlDir, 'request'), 'utf8') : null);

test('the changelog in this repository parses: every release, newest first, with its pull request', () => {
  const entries = v.changelog();
  assert.ok(entries.length >= 4);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(entries[0].version, pkg.version, 'the newest entry is this version');
  assert.equal(entries[0].label, v.labelOf(pkg.version));
  for (const e of entries) {
    assert.match(e.version, /^\d+\.\d+\.\d+$/);
    assert.ok(e.lines.length >= 2, `${e.label} has bullets`);
    assert.ok(e.pr && e.pr > 0, `${e.label} links its pull request`);
  }
  assert.ok(entries.some((e) => e.version === '1.0.0'));
  assert.equal(v.versionOf('BUH-02.10.03'), '2.10.3');
  assert.equal(v.labelOf('2.10.3'), 'BUH-02.10.03');
});

test('no updater (or a stale status): switching is refused with the command shown instead', () => {
  assert.equal(v.updaterStatus(), null);
  assert.equal(statusOf(() => v.requestSwitch('2.0.0')), 409);
  writeStatus({ updatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
  assert.equal(v.updaterStatus(), null, 'a status 11 minutes old means the updater stopped');
  assert.equal(statusOf(() => v.requestSwitch('latest')), 409);
});

test('the status is read defensively: odd values dropped, links refused', () => {
  writeStatus({ running: '2.1.0; rm -rf /', onServer: ['2.0.0', '<script>', 7], lastRequest: { message: 'x'.repeat(2000) } });
  const s = v.updaterStatus()!;
  assert.equal(s.running, '');
  assert.deepEqual(s.onServer, ['2.0.0']);
  assert.equal(s.lastRequest.message.length, 300);
  fs.rmSync(path.join(statusDir, 'status.json'));
  const elsewhere = path.join(dir, 'elsewhere.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ updatedAt: new Date().toISOString(), running: '9.9.9' }));
  fs.symlinkSync(elsewhere, path.join(statusDir, 'status.json'));
  assert.equal(v.updaterStatus(), null);
});

test('a switch request: checked, one at a time, never older than 2.0.0, never through a planted file', () => {
  writeStatus({ running: '2.0.0', onServer: ['2.0.0', '2.0.1'] });
  assert.equal(statusOf(() => v.requestSwitch('2.0.0')), 409, 'already running');
  assert.equal(statusOf(() => v.requestSwitch('1.2.0')), 400, 'before per-size stock');
  assert.equal(statusOf(() => v.requestSwitch('2.0.0\nupdate')), 400);
  assert.equal(statusOf(() => v.requestSwitch('../../x')), 400);
  assert.equal(statusOf(() => v.requestSwitch('9.9.9')), 400, 'not a known version');
  assert.equal(v.requestSwitch('2.0.1'), 'rollback 2.0.1');
  assert.equal(request(), 'rollback 2.0.1\n');
  assert.equal(v.pendingRequest(), 'rollback 2.0.1');
  assert.equal(statusOf(() => v.requestSwitch('latest')), 409, 'one request at a time');
  fs.rmSync(path.join(controlDir, 'request'));

  // A link planted where the request goes is not written through.
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'keep\n');
  fs.symlinkSync(target, path.join(controlDir, 'request'));
  assert.equal(v.pendingRequest(), null);
  assert.equal(statusOf(() => v.requestSwitch('latest')), 409);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n');
  fs.rmSync(path.join(controlDir, 'request'));

  assert.equal(v.requestSwitch('latest'), 'update');
  assert.equal(request(), 'update\n');
  fs.rmSync(path.join(controlDir, 'request'));
});

test('during a switch (which can take minutes) the updater still counts as running, and a second switch waits', () => {
  writeStatus({ updatedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(), lastRequest: { request: 'rollback 2.0.1', result: 'working', message: 'Switching to 2.0.1…', at: '' } });
  assert.ok(v.updaterStatus(), 'a 6-minute-old status is not "stopped"');
  assert.equal(statusOf(() => v.requestSwitch('latest')), 409);
});
