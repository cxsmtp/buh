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
  assert.equal(s.mode, 'compose', 'no mode: the blue/green updater (before single mode existed)');
  writeStatus({ mode: 'single' });
  assert.equal(v.updaterStatus()!.mode, 'single');
  writeStatus({ mode: '<b>other</b>' });
  assert.equal(v.updaterStatus()!.mode, 'compose');
  // The registry refusing downloads (an expired login): passed on, as text, capped.
  assert.equal(v.updaterStatus()!.registryProblem, '');
  writeStatus({ registryProblem: 'the registry login has expired or is missing: ghcr.io refused to send ghcr.io/cxsmtp/buh:latest' });
  assert.match(v.updaterStatus()!.registryProblem, /^the registry login has expired/);
  writeStatus({ registryProblem: 'y'.repeat(2000) });
  assert.equal(v.updaterStatus()!.registryProblem.length, 400);
  writeStatus({ registryProblem: { html: '<b>' } });
  assert.equal(v.updaterStatus()!.registryProblem, '');
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

test('regression: the request appears whole (never written in place, so the updater cannot read it empty), and never replaces one', () => {
  writeStatus({ running: '2.0.0', onServer: ['2.0.0', '2.0.1'] });
  const target = path.join(controlDir, 'request');
  const written: string[] = [];
  const realWrite = fs.writeFileSync;
  const realOpen = fs.openSync;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    written.push(String(file));
    return (realWrite as (...a: unknown[]) => void)(file, ...rest);
  }) as typeof fs.writeFileSync;
  fs.openSync = ((file: fs.PathLike, ...rest: unknown[]) => {
    written.push(String(file));
    return (realOpen as (...a: unknown[]) => number)(file, ...rest);
  }) as typeof fs.openSync;
  try {
    assert.equal(v.requestSwitch('2.0.1'), 'rollback 2.0.1');
  } finally {
    fs.writeFileSync = realWrite;
    fs.openSync = realOpen;
  }
  assert.ok(!written.includes(target), `the request file itself is never opened for writing: ${written.join(', ')}`);
  assert.equal(request(), 'rollback 2.0.1\n');
  assert.equal(fs.statSync(target).nlink, 1, 'the temporary name is gone');
  assert.deepEqual(fs.readdirSync(controlDir), ['request']);

  fs.rmSync(target);

  // Something already there (here a link, which pendingRequest does not count): the link step
  // refuses, nothing is replaced or written through, and no temporary file is left behind.
  const other = path.join(dir, 'other');
  fs.writeFileSync(other, 'keep\n');
  fs.symlinkSync(other, target);
  assert.equal(statusOf(() => v.requestSwitch('2.0.1')), 409);
  assert.equal(fs.readFileSync(other, 'utf8'), 'keep\n');
  assert.deepEqual(fs.readdirSync(controlDir), ['request']);
  fs.rmSync(target);
});

test('during a switch (which can take minutes) the updater still counts as running, and a second switch waits', () => {
  writeStatus({ updatedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(), lastRequest: { request: 'rollback 2.0.1', result: 'working', message: 'Switching to 2.0.1…', at: '' } });
  assert.ok(v.updaterStatus(), 'a 6-minute-old status is not "stopped"');
  assert.equal(statusOf(() => v.requestSwitch('latest')), 409);
});

test('the install history, recorded digests and an integrity refusal are passed on, checked field by field', () => {
  const D = 'sha256:' + 'a'.repeat(64);
  writeStatus({
    history: [
      { at: '2026-10-16T10:00:00Z', version: '2.1.0', digest: D, why: 'scheduled' },
      { at: '2026-10-15T10:00:00Z', version: '?', digest: 'id:0123456789ab', why: 'set-up' },
      { at: '2026-10-14T10:00:00Z', version: '2.0.0', digest: 'sha256:<script>', why: 'manual' },
      { at: '2026-10-14T10:00:00Z', version: '2.0.0', digest: D, why: 'because' },
      'junk',
    ],
    digests: [{ version: '2.1.0', digest: D, verified: true }, { version: '2.0.0', digest: D, verified: 'yes' }, { version: 'x', digest: D, verified: true }],
    integrityProblem: 'Version 2.1.0 was refused: it is published under another digest',
  });
  const s = v.updaterStatus()!;
  assert.deepEqual(s.history, [
    { at: '2026-10-16T10:00:00Z', version: '2.1.0', digest: D, why: 'scheduled' },
    { at: '2026-10-15T10:00:00Z', version: '', digest: 'id:0123456789ab', why: 'set-up' },
  ]);
  assert.deepEqual(s.digests, [{ version: '2.1.0', digest: D, verified: true }, { version: '2.0.0', digest: D, verified: false }]);
  assert.match(s.integrityProblem, /^Version 2\.1\.0 was refused/);
  writeStatus({ history: 'x', digests: {} });
  assert.deepEqual(v.updaterStatus()!.history, []);
  assert.deepEqual(v.updaterStatus()!.digests, []);
  assert.equal(v.updaterStatus()!.integrityProblem, '');
});

test('"Install new versions automatically": a strict request line, one at a time; the status reports what the updater keeps', () => {
  fs.rmSync(path.join(statusDir, 'status.json'), { force: true });
  assert.equal(statusOf(() => v.requestAuto(false)), 409, 'no updater: nothing to switch');
  writeStatus({});
  assert.equal(v.updaterStatus()!.auto, true, 'on unless the updater says off');
  assert.deepEqual(v.updaterStatus()!.lastCheck, { at: '', result: '' });
  assert.equal(v.requestAuto(false), 'auto off');
  assert.equal(request(), 'auto off\n');
  assert.equal(statusOf(() => v.requestAuto(true)), 409, 'one request at a time');
  assert.equal(statusOf(() => v.requestSwitch('latest')), 409);
  fs.rmSync(path.join(controlDir, 'request'));
  assert.equal(v.requestAuto(true), 'auto on');
  fs.rmSync(path.join(controlDir, 'request'));
  writeStatus({ auto: false, lastCheck: { at: '2026-10-16T10:00:00Z', result: 'up to date (2.0.0)' } });
  assert.equal(v.updaterStatus()!.auto, false);
  assert.deepEqual(v.updaterStatus()!.lastCheck, { at: '2026-10-16T10:00:00Z', result: 'up to date (2.0.0)' });
  writeStatus({ auto: 'no', lastCheck: 'x' });
  assert.equal(v.updaterStatus()!.auto, true, 'only false turns it off');
  assert.deepEqual(v.updaterStatus()!.lastCheck, { at: '', result: '' });
});
