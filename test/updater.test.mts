import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// deploy/updater/updater.sh, driven against a fake docker CLI (test/fixtures/fake-docker.sh),
// so the update / rollback / self-healing decisions are tested without a Docker daemon.
// The real switch through Caddy, under load, is tested in CI (.github/workflows/zero-downtime.yml).

const root = process.cwd();
const OLD = 'sha256:' + 'a'.repeat(64);
const NEW = 'sha256:' + 'b'.repeat(64);
const NEWER = 'sha256:' + 'c'.repeat(64);
const BROKEN = 'sha256:broken' + 'd'.repeat(58);
const CRASH = 'sha256:crash' + 'e'.repeat(59);
const LATEST = 'ghcr.io/cxsmtp/buh:latest';
const key = (ref: string) => ref.replace(/[/:@]/g, '_');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-updater-'));
  const env = {
    fake: path.join(dir, 'docker'),
    bin: path.join(dir, 'bin'),
    state: path.join(dir, 'state'),
    alerts: path.join(dir, 'shopdata', 'updater'),
    project: path.join(dir, 'project'),
  };
  for (const d of [env.fake, env.bin, env.state, env.project, path.join(env.fake, 'tags'), path.join(env.fake, 'registry')]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(root, 'test/fixtures/fake-docker.sh'), path.join(env.bin, 'docker'));
  fs.chmodSync(path.join(env.bin, 'docker'), 0o755);
  fs.writeFileSync(path.join(env.fake, 'ids'), [OLD, NEW, NEWER, BROKEN, CRASH].join('\n') + '\n');
  return env;
}
type Env = ReturnType<typeof setup>;

const tag = (e: Env, ref: string, id: string) => fs.writeFileSync(path.join(e.fake, 'tags', key(ref)), id + '\n');
const publish = (e: Env, id: string) => fs.writeFileSync(path.join(e.fake, 'registry', key(LATEST)), id + '\n');
function container(e: Env, colour: string, id: string, status = 'running', health?: string) {
  const d = path.join(e.fake, 'c', colour);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'image'), id + '\n');
  fs.writeFileSync(path.join(d, 'status'), status + '\n');
  if (health) fs.writeFileSync(path.join(d, 'health'), health + '\n');
}
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const events = (e: Env) => read(path.join(e.fake, 'events')).trim().split('\n').filter(Boolean);
const statusOf = (e: Env, colour: string) => read(path.join(e.fake, 'c', colour, 'status')).trim();
const alerts = (e: Env) => read(path.join(e.alerts, 'alerts.log')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

function run(e: Env, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync('sh', [path.join(root, 'deploy/updater/updater.sh'), ...args], {
    env: {
      PATH: `${e.bin}:${process.env.PATH}`,
      NODE_ENV: 'test',
      FAKE_DOCKER_DIR: e.fake,
      COMPOSE_PROJECT_NAME: 'buhome',
      PROJECT_DIR: e.project,
      STATE_DIR: e.state,
      ALERT_DIR: e.alerts,
      HEALTH_TIMEOUT: '4',
      SETTLE_SECONDS: '0',
      ...extra,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The shop runs OLD on app-blue, recorded as last good. */
function running(e: Env) {
  tag(e, LATEST, OLD);
  container(e, 'blue', OLD);
  assert.equal(run(e, ['heal']).code, 0);
  assert.equal(read(path.join(e.state, 'last-good')).trim(), OLD);
  fs.rmSync(path.join(e.fake, 'events'), { force: true });
}

test('a good new image: snapshot first, start the idle colour, then stop the old one; last good and previous move', () => {
  const e = setup();
  running(e);
  publish(e, NEW);
  const r = run(e, ['once']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(events(e), [
    `pull ${LATEST}`,
    'backup app-blue',
    'up app-green ' + NEW,
    `tag buh:last-good ${NEW}`,
    `tag buh:previous ${OLD}`,
    'stop app-blue',
    'prune',
  ]);
  assert.equal(statusOf(e, 'green'), 'running');
  assert.equal(statusOf(e, 'blue'), 'exited');
  assert.equal(read(path.join(e.state, 'active')).trim(), 'green');
  assert.equal(read(path.join(e.state, 'last-good')).trim(), NEW);
  assert.equal(alerts(e).at(-1).level, 'info');

  // Nothing new: nothing happens.
  fs.rmSync(path.join(e.fake, 'events'));
  assert.equal(run(e, ['once']).code, 0);
  assert.deepEqual(events(e), [`pull ${LATEST}`]);
});

test('a broken new image: removed, the old copy never stops, last good unchanged, and it is not retried', () => {
  const e = setup();
  running(e);
  publish(e, BROKEN);
  const r = run(e, ['once']);
  assert.equal(r.code, 1, r.out);
  assert.ok(!events(e).includes('stop app-blue'), events(e).join('\n'));
  assert.ok(events(e).includes('rm app-green'));
  assert.equal(statusOf(e, 'blue'), 'running');
  assert.equal(fs.existsSync(path.join(e.fake, 'c', 'green')), false);
  assert.equal(read(path.join(e.state, 'last-good')).trim(), OLD);
  assert.equal(read(path.join(e.fake, 'tags', key('buh:last-good'))).trim(), OLD);
  assert.match(read(path.join(e.state, 'bad-images')), /broken/);
  const last = alerts(e).at(-1);
  assert.equal(last.level, 'error');
  assert.match(last.message, /Rolled back: app-blue keeps serving/);

  // Same image again: skipped, nothing started.
  fs.rmSync(path.join(e.fake, 'events'));
  assert.equal(run(e, ['once']).code, 0);
  assert.ok(!events(e).some((l) => l.startsWith('up ')), events(e).join('\n'));

  // A newer image is tried.
  publish(e, NEWER);
  assert.equal(run(e, ['once']).code, 0);
  assert.equal(statusOf(e, 'green'), 'running');
  assert.equal(read(path.join(e.state, 'last-good')).trim(), NEWER);
});

test('an image that crashes at start is given up at once, not after the full timeout', () => {
  const e = setup();
  running(e);
  publish(e, CRASH);
  const started = Date.now();
  const r = run(e, ['once'], { HEALTH_TIMEOUT: '30' });
  assert.equal(r.code, 1, r.out);
  assert.ok(Date.now() - started < 15_000);
  assert.equal(statusOf(e, 'blue'), 'running');
});

test('no update without a database snapshot', () => {
  const e = setup();
  running(e);
  publish(e, NEW);
  fs.writeFileSync(path.join(e.fake, 'backup-fails'), '');
  const r = run(e, ['once']);
  assert.equal(r.code, 2, r.out);
  assert.ok(!events(e).some((l) => l.startsWith('up ')));
  assert.match(alerts(e).at(-1).message, /snapshot failed/);
  assert.equal(read(path.join(e.state, 'bad-images')), '', 'a failed snapshot does not reject the image');
});

test('self-healing: nothing running starts the last good image', () => {
  const e = setup();
  running(e);
  fs.writeFileSync(path.join(e.fake, 'c', 'blue', 'status'), 'exited\n');
  tag(e, LATEST, NEW); // a newer, untested image is on the server: not used to recover
  assert.equal(run(e, ['heal']).code, 0);
  assert.ok(events(e).includes('up app-blue ' + OLD), events(e).join('\n'));
  assert.equal(statusOf(e, 'blue'), 'running');
  assert.deepEqual(alerts(e).map((a) => a.level), ['error', 'info']);
});

test('self-healing: unhealthy 3 checks in a row is restarted; still unhealthy, the other colour takes over from last good', () => {
  const e = setup();
  running(e);
  fs.writeFileSync(path.join(e.fake, 'c', 'blue', 'health'), 'unhealthy\n');
  fs.writeFileSync(path.join(e.fake, 'c', 'blue', 'sick-after-restart'), '');
  run(e, ['heal']);
  run(e, ['heal']);
  assert.deepEqual(events(e), [], 'two bad checks: nothing yet');
  const r = run(e, ['heal']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(events(e), ['restart app-blue', 'up app-green ' + OLD, 'stop app-blue']);
  assert.equal(read(path.join(e.state, 'active')).trim(), 'green');

  // A restart that helps stops there.
  const f = setup();
  running(f);
  fs.writeFileSync(path.join(f.fake, 'c', 'blue', 'health'), 'unhealthy\n');
  for (let i = 0; i < 3; i++) run(f, ['heal']);
  assert.deepEqual(events(f), ['restart app-blue']);
  assert.equal(statusOf(f, 'blue'), 'running');
});

test('both copies running (a stray `docker compose up`): the recorded one is kept', () => {
  const e = setup();
  running(e);
  publish(e, NEW);
  run(e, ['once']); // green active now
  container(e, 'blue', NEW);
  fs.rmSync(path.join(e.fake, 'events'));
  run(e, ['heal']);
  assert.deepEqual(events(e), ['stop app-blue']);
  assert.equal(statusOf(e, 'green'), 'running');
});

test('regression: no rollback to a version before 2.0.0 (it keeps stock per product, not per size)', () => {
  const e = setup();
  running(e);
  publish(e, NEW);
  run(e, ['once']);
  fs.mkdirSync(path.join(e.fake, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(e.fake, 'versions', OLD), '1.2.0\n');
  fs.rmSync(path.join(e.fake, 'events'));
  const r = run(e, ['rollback']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /refusing to roll back to 1\.2\.0/);
  assert.ok(!events(e).some((l) => l.startsWith('up ') || l.startsWith('stop ')), 'nothing switched');
  assert.equal(run(e, ['rollback'], { FORCE_OLD_SCHEMA: '1' }).code, 0, 'possible when forced');
});

test('regression: alerts never follow a link planted in the alert folder', () => {
  const e = setup();
  fs.mkdirSync(e.alerts, { recursive: true });
  const target = path.join(path.dirname(e.alerts), 'precious');
  fs.writeFileSync(target, 'keep me\n');
  fs.chmodSync(target, 0o644);
  fs.symlinkSync(target, path.join(e.alerts, 'alerts.log'));
  run(e, ['heal']); // nothing running: an alert is written
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me\n', 'the link target is untouched');
  assert.equal(fs.statSync(target).mode & 0o777, 0o644, 'and keeps its permissions');
});

test('rollback goes back to the previous image without downtime, and keeps auto-update from re-applying the new one', () => {
  const e = setup();
  running(e);
  publish(e, NEW);
  run(e, ['once']);
  fs.rmSync(path.join(e.fake, 'events'));
  const r = run(e, ['rollback']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(events(e).filter((l) => !l.startsWith('tag') && l !== 'prune'), [
    'backup app-green',
    // the stopped old blue container is replaced by a fresh one
    'stop app-blue',
    'rm app-blue',
    'up app-blue ' + OLD,
    'stop app-green',
  ]);
  assert.equal(read(path.join(e.state, 'last-good')).trim(), OLD);
  fs.rmSync(path.join(e.fake, 'events'));
  run(e, ['once']);
  assert.ok(!events(e).some((l) => l.startsWith('up ')), 'the rolled-back image is not re-applied');
});

test('alert lines are JSON and a webhook URL must be https', () => {
  const e = setup();
  running(e);
  publish(e, BROKEN);
  const r = run(e, ['once'], { ALERT_WEBHOOK_URL: 'http://example.com/hook' });
  assert.match(r.out, /must start with https/);
  for (const a of alerts(e)) assert.ok(a.at && a.level && a.message);
});

test('the loop: UPDATE_CHECK_MINUTES=0 updates only when asked (trigger file), and stops cleanly on SIGTERM', async () => {
  const e = setup();
  running(e);
  publish(e, NEW);
  const child: ChildProcess = spawn('sh', [path.join(root, 'deploy/updater/updater.sh'), 'daemon'], {
    env: {
      PATH: `${e.bin}:${process.env.PATH}`,
      NODE_ENV: 'test',
      FAKE_DOCKER_DIR: e.fake,
      COMPOSE_PROJECT_NAME: 'buhome',
      PROJECT_DIR: e.project,
      STATE_DIR: e.state,
      ALERT_DIR: e.alerts,
      SETTLE_SECONDS: '0',
      HEAL_CHECK_SECONDS: '1',
      UPDATE_CHECK_MINUTES: '0',
    },
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d));
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fn(), out);
  };
  await until(() => out.includes('only on demand'));
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(!events(e).some((l) => l.startsWith('pull')), 'no check without a request');
  fs.writeFileSync(path.join(e.state, 'update-now'), '');
  await until(() => statusOf(e, 'green') === 'running' && statusOf(e, 'blue') === 'exited');
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.match(out, /updater stopped/);
  assert.equal(fs.existsSync(path.join(e.state, 'lock')), false);
});

test('Settings → Versions: the daemon takes a "rollback X.Y.Z" request, switches, and reports; bad or linked requests are ignored', async () => {
  const e = setup();
  running(e);
  publish(e, NEW);
  run(e, ['once']); // the shop now runs NEW (2.1.0); OLD (2.0.0) is on the server
  fs.mkdirSync(path.join(e.fake, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(e.fake, 'versions', OLD), '2.0.0\n');
  fs.writeFileSync(path.join(e.fake, 'versions', NEW), '2.1.0\n');
  tag(e, 'ghcr.io/cxsmtp/buh:2.0.0', OLD);
  const control = path.join(path.dirname(e.state), 'control');
  const pub = path.join(path.dirname(e.state), 'public');
  fs.mkdirSync(control);
  fs.mkdirSync(pub);
  // A link planted where the status goes must be replaced, not written through.
  const precious = path.join(path.dirname(e.state), 'precious');
  fs.writeFileSync(precious, 'keep me\n');
  fs.symlinkSync(precious, path.join(pub, 'status.json'));
  // A request that is a link is ignored (and removed).
  fs.symlinkSync(precious, path.join(control, 'request'));

  const child: ChildProcess = spawn('sh', [path.join(root, 'deploy/updater/updater.sh'), 'daemon'], {
    env: {
      PATH: `${e.bin}:${process.env.PATH}`,
      NODE_ENV: 'test',
      FAKE_DOCKER_DIR: e.fake,
      COMPOSE_PROJECT_NAME: 'buhome',
      PROJECT_DIR: e.project,
      STATE_DIR: e.state,
      ALERT_DIR: e.alerts,
      CONTROL_DIR: control,
      PUBLIC_DIR: pub,
      SETTLE_SECONDS: '0',
      HEAL_CHECK_SECONDS: '1',
      UPDATE_CHECK_MINUTES: '0',
    },
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d));
  const status = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(pub, 'status.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fn(), out);
  };
  try {
    await until(() => status()?.running === '2.1.0');
    assert.equal(fs.readFileSync(precious, 'utf8'), 'keep me\n', 'the planted link was not followed');
    assert.equal(fs.lstatSync(path.join(pub, 'status.json')).isSymbolicLink(), false);
    assert.ok(!fs.existsSync(path.join(control, 'request')), 'the linked request was removed');
    assert.deepEqual(status().onServer.sort(), ['2.0.0', '2.1.0']);

    // A pipe as the request would block a reader forever: it is moved aside unread, and the loop goes on.
    spawnSync('mkfifo', [path.join(control, 'request')]);
    await until(() => !fs.existsSync(path.join(control, 'request')) && status()?.lastRequest.request === '(not understood)');
    // A link to a file holding a valid line is not obeyed, and what the file says is never shown.
    const secret = path.join(path.dirname(e.state), 'secret');
    fs.writeFileSync(secret, 'rollback 2.0.0\n');
    fs.symlinkSync(secret, path.join(control, 'request'));
    const before = status().updatedAt;
    await until(() => !fs.existsSync(path.join(control, 'request')) && status()?.updatedAt !== before);
    assert.equal(statusOf(e, 'green'), 'running', 'not switched');
    assert.equal(status().lastRequest.request, '(not understood)');
    assert.deepEqual(fs.readdirSync(control).filter((f) => f.startsWith('.taken')), [], 'nothing left behind');

    // Not a version: ignored, nothing switched.
    fs.writeFileSync(path.join(control, 'request'), 'rollback 2.0.0; rm -rf /\n');
    await until(() => status()?.lastRequest.result === 'refused');
    assert.equal(statusOf(e, 'green'), 'running');

    fs.writeFileSync(path.join(control, 'request'), 'rollback 2.0.0\n');
    await until(() => status()?.lastRequest.result === 'ok' && status()?.running === '2.0.0');
    assert.match(out, /Admin Hub asked to switch to version 2\.0\.0/);
    assert.equal(statusOf(e, 'blue'), 'running');
    assert.equal(statusOf(e, 'green'), 'exited');

    // "Update to the latest" brings 2.1.0 back, though the rollback had set it aside.
    fs.writeFileSync(path.join(control, 'request'), 'update\n');
    await until(() => status()?.running === '2.1.0' && status()?.lastRequest.request === 'update');
    assert.equal(status().lastRequest.result, 'ok');
  } finally {
    const exited = new Promise((r) => child.on('exit', r));
    child.kill('SIGTERM');
    await exited;
  }
});
