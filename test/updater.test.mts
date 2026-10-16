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
// The buh-updater image (ids with "upd": the fake runs them as the updater).
const UPD1 = 'sha256:upd1' + '1'.repeat(60);
const UPD2 = 'sha256:upd2' + '2'.repeat(60);
const UPDBROKEN = 'sha256:updbroken' + '3'.repeat(55);
// The buh-proxy image ("proxy" ids: the fake's `nc -z` answers for them).
const PROXY1 = 'sha256:proxy1' + '4'.repeat(58);
const PROXY2 = 'sha256:proxy2' + '5'.repeat(58);
const PROXYBROKEN = 'sha256:proxybroken' + '6'.repeat(53);
const PROXY_REF = 'ghcr.io/cxsmtp/buh-proxy:latest';
const UPDATER_REF = 'ghcr.io/cxsmtp/buh-updater:latest';
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
  fs.writeFileSync(path.join(env.fake, 'ids'), [OLD, NEW, NEWER, BROKEN, CRASH, UPD1, UPD2, UPDBROKEN, PROXY1, PROXY2, PROXYBROKEN].join('\n') + '\n');
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
    // (waited for: the request can be gone a moment before its folder is removed)
    await until(() => fs.readdirSync(control).filter((f) => f.startsWith('.taken')).length === 0);

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

// ── Single-container mode (UPDATER_MODE=single): one shop container, e.g. Podman on Windows ──

const SHOP = 'beautifuluaehome';
const CAND = `${SHOP}-candidate`;
const PREV = `${SHOP}-previous`;
const runSingle = (e: Env, args: string[], extra: Record<string, string> = {}) => run(e, args, { UPDATER_MODE: 'single', COMPOSE_PROJECT_NAME: '', ...extra });
/** A container the way the owner started it by hand: data in beautifuluaehome-data, port 443, no label. */
function shopContainer(e: Env, name: string, id: string, status = 'running', data = `${SHOP}-data`) {
  container(e, name, id, status);
  const d = path.join(e.fake, 'c', name);
  fs.writeFileSync(path.join(d, 'data'), data + '\n');
  fs.writeFileSync(path.join(d, 'port'), '443\n');
  fs.mkdirSync(path.join(e.fake, 'vols'), { recursive: true });
  fs.writeFileSync(path.join(e.fake, 'vols', data), '');
}
const fileOf = (e: Env, name: string, f: string) => read(path.join(e.fake, 'c', name, f)).trim();
const exists = (e: Env, name: string) => fs.existsSync(path.join(e.fake, 'c', name));

/** The shop runs OLD as one container, recorded as last good. */
function runningSingle(e: Env) {
  tag(e, LATEST, OLD);
  shopContainer(e, SHOP, OLD);
  // Set up the way `setup` does it (the hand-started one is kept as -previous; dropped here).
  const r = runSingle(e, ['adopt']);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(path.join(e.state, 'last-good')).trim(), OLD);
  fs.rmSync(path.join(e.fake, 'c', PREV), { recursive: true, force: true });
  fs.rmSync(path.join(e.fake, 'events'), { force: true });
  fs.rmSync(path.join(e.alerts, 'alerts.log'), { force: true });
}

test('single: a good new image is tried without a port first, then replaces the shop on its port; the old one is kept as -previous', () => {
  const e = setup();
  runningSingle(e);
  publish(e, NEW);
  const r = runSingle(e, ['once']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(events(e), [
    `pull ${LATEST}`,
    `backup ${SHOP}`,
    `run ${CAND} ${NEW}`,
    `stop ${CAND}`,
    `rm ${CAND}`,
    `stop ${SHOP}`,
    `rename ${SHOP} ${PREV}`,
    `run ${SHOP} ${NEW} port=443`,
    `tag buh:last-good ${NEW}`,
    `tag buh:previous ${OLD}`,
    'prune',
  ]);
  assert.equal(statusOf(e, SHOP), 'running');
  assert.equal(fileOf(e, SHOP, 'image'), NEW);
  assert.equal(fileOf(e, SHOP, 'data'), `${SHOP}-data`, 'the same data volume');
  assert.equal(statusOf(e, PREV), 'exited');
  assert.equal(fileOf(e, PREV, 'image'), OLD);
  assert.equal(exists(e, CAND), false);
  // The fixed definition: hardening, the two updater volumes, TZ by default, the port only on the real one.
  assert.match(
    fileOf(e, SHOP, 'args'),
    /--restart unless-stopped -p 443:3000 -v beautifuluaehome-data:\/data -v beautifuluaehome-updater-control:\/updater-control -v beautifuluaehome-updater-status:\/updater-status:ro -e TZ=Asia\/Dubai --read-only --tmpfs \/tmp --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 512 \S+$/
  );
  assert.doesNotMatch(fileOf(e, PREV, 'args') + read(path.join(e.state, 'updater.log')), /run -d --name beautifuluaehome-candidate .*-p /);
  assert.equal(read(path.join(e.state, 'last-good')).trim(), NEW);
  const last = alerts(e).at(-1);
  assert.equal(last.level, 'info');
  assert.match(last.message, /it was closed for \d+s while switching/);

  fs.rmSync(path.join(e.fake, 'events'));
  assert.equal(runSingle(e, ['once']).code, 0);
  assert.deepEqual(events(e), [`pull ${LATEST}`], 'up to date: nothing happens');
});

test('single: a new image that fails its trial is removed; the shop never stops, and the image is not retried', () => {
  const e = setup();
  runningSingle(e);
  publish(e, BROKEN);
  const r = runSingle(e, ['once']);
  assert.equal(r.code, 1, r.out);
  assert.ok(!events(e).includes(`stop ${SHOP}`), events(e).join('\n'));
  assert.ok(events(e).includes(`rm ${CAND}`));
  assert.ok(!events(e).some((l) => l.includes('port=')), 'never started on the port');
  assert.equal(statusOf(e, SHOP), 'running');
  assert.equal(fileOf(e, SHOP, 'image'), OLD);
  assert.equal(exists(e, CAND), false);
  assert.match(read(path.join(e.state, 'bad-images')), /broken/);
  assert.equal(read(path.join(e.state, 'last-good')).trim(), OLD);
  const last = alerts(e).at(-1);
  assert.equal(last.level, 'error');
  assert.match(last.message, /never stopped and keeps serving/);

  fs.rmSync(path.join(e.fake, 'events'));
  assert.equal(runSingle(e, ['once']).code, 0);
  assert.ok(!events(e).some((l) => l.startsWith('run ')), 'skipped: ' + events(e).join('\n'));
});

test('single: the new container fails on the port: it is removed and the previous one is back on the port', () => {
  const e = setup();
  runningSingle(e);
  publish(e, NEW);
  fs.writeFileSync(path.join(e.fake, 'port-fails'), '');
  const r = runSingle(e, ['once']);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(events(e).slice(-6), [`stop ${SHOP}`, `rename ${SHOP} ${PREV}`, `run ${SHOP} ${NEW} port=443`, `rm ${SHOP}`, `rename ${PREV} ${SHOP}`, `start ${SHOP}`]);
  assert.equal(statusOf(e, SHOP), 'running');
  assert.equal(fileOf(e, SHOP, 'image'), OLD, 'the previous version serves');
  assert.equal(exists(e, PREV), false);
  assert.ok(read(path.join(e.state, 'bad-images')).includes(NEW.slice(7)));
  assert.equal(read(path.join(e.state, 'last-good')).trim(), OLD);
  const last = alerts(e).at(-1);
  assert.equal(last.level, 'error');
  assert.match(last.message, /previous container is back on port 443/);
});

test('single: no switch without a database snapshot', () => {
  const e = setup();
  runningSingle(e);
  publish(e, NEW);
  fs.writeFileSync(path.join(e.fake, 'backup-fails'), '');
  assert.equal(runSingle(e, ['once']).code, 2);
  assert.ok(!events(e).some((l) => l.startsWith('run ') || l.startsWith('stop ')), events(e).join('\n'));
});

test('single: self-healing starts a stopped shop, re-creates a missing one from last good, and never starts one on a missing data volume', () => {
  const e = setup();
  runningSingle(e);
  fs.writeFileSync(path.join(e.fake, 'c', SHOP, 'status'), 'exited\n');
  assert.equal(runSingle(e, ['heal']).code, 0);
  assert.deepEqual(events(e), [`start ${SHOP}`]);
  assert.equal(statusOf(e, SHOP), 'running');
  assert.deepEqual(alerts(e).map((a) => a.level), ['error', 'info']);

  // Gone altogether (and a newer, untested image on the server): started from last good.
  fs.rmSync(path.join(e.fake, 'c', SHOP), { recursive: true });
  fs.rmSync(path.join(e.fake, 'events'));
  tag(e, LATEST, NEW);
  assert.equal(runSingle(e, ['heal']).code, 0);
  assert.deepEqual(events(e), [`run ${SHOP} ${OLD} port=443`]);
  assert.equal(fileOf(e, SHOP, 'data'), `${SHOP}-data`);

  // A trial container left by an interrupted switch is removed.
  shopContainer(e, CAND, NEW);
  fs.rmSync(path.join(e.fake, 'events'));
  runSingle(e, ['heal']);
  assert.deepEqual(events(e), [`rm ${CAND}`]);

  // No data volume: nothing is started on empty data.
  const f = setup();
  tag(f, LATEST, OLD);
  tag(f, 'buh:last-good', OLD);
  const r = runSingle(f, ['heal']);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(events(f), []);
  assert.equal(alerts(f).at(-1).level, 'critical');
  assert.ok(alerts(f).some((a) => /data volume beautifuluaehome-data does not exist/.test(a.message)), JSON.stringify(alerts(f)));
});

test('single: a shop that stops answering is restarted; still not answering, it is re-created from last good', () => {
  const e = setup();
  runningSingle(e);
  fs.writeFileSync(path.join(e.fake, 'c', SHOP, 'health'), 'unhealthy\n');
  fs.writeFileSync(path.join(e.fake, 'c', SHOP, 'sick-after-restart'), '');
  runSingle(e, ['heal']);
  runSingle(e, ['heal']);
  assert.deepEqual(events(e), [], 'two bad checks: nothing yet');
  const r = runSingle(e, ['heal']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(events(e), [`restart ${SHOP}`, `rm ${SHOP}`, `run ${SHOP} ${OLD} port=443`]);
  assert.equal(statusOf(e, SHOP), 'running');
});

test('single: a container whose data is in another volume is never touched', () => {
  const e = setup();
  tag(e, LATEST, OLD);
  shopContainer(e, SHOP, OLD, 'exited', 'buhome-data');
  const r = runSingle(e, ['heal']);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(events(e), []);
  assert.match(alerts(e).at(-1).message, /keeps its data in buhome-data, not in the volume beautifuluaehome-data/);

  const a = runSingle(e, ['adopt']);
  assert.equal(a.code, 2, a.out);
  assert.match(a.out, /refusing: beautifuluaehome keeps its data in the volume buhome-data, not beautifuluaehome-data/);
  assert.match(a.out, /setup beautifuluaehome --volume buhome-data/);
  assert.deepEqual(events(e), []);
});

test("single: adopt re-creates the owner's container with the full definition (same image, same data), once", () => {
  const e = setup();
  tag(e, LATEST, NEW); // a newer image is on the server: adopt keeps the one that runs
  shopContainer(e, SHOP, OLD);
  const env = { SHOP_ENV: 'TZ=Asia/Dubai INSECURE_COOKIES=1 OTP_DEV_MODE=true' };
  const r = runSingle(e, ['adopt'], env);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(events(e).filter((l) => !l.startsWith('tag') && l !== 'prune'), [
    `backup ${SHOP}`,
    `run ${CAND} ${OLD}`,
    `stop ${CAND}`,
    `rm ${CAND}`,
    `stop ${SHOP}`,
    `rename ${SHOP} ${PREV}`,
    `run ${SHOP} ${OLD} port=443`,
  ]);
  assert.match(fileOf(e, SHOP, 'args'), /-e TZ=Asia\/Dubai -e INSECURE_COOKIES=1 -e OTP_DEV_MODE=true --read-only/);
  assert.ok(fileOf(e, SHOP, 'spec'));
  assert.equal(read(path.join(e.state, 'bad-images')), '');

  fs.rmSync(path.join(e.fake, 'events'));
  const again = runSingle(e, ['adopt'], env);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already runs with these settings/);
  assert.deepEqual(events(e), []);

  // Different settings: re-created again.
  assert.equal(runSingle(e, ['adopt'], { SHOP_ENV: `${env.SHOP_ENV} SHOP_LABEL=x` }).code, 0);
  assert.ok(events(e).includes(`run ${SHOP} ${OLD} port=443`), events(e).join('\n'));
  assert.match(fileOf(e, SHOP, 'args'), /-e SHOP_LABEL=x/);

  // A new shop (no container, no volume): started from the published image on a new volume.
  const f = setup();
  publish(f, OLD);
  const n = runSingle(f, ['adopt']);
  assert.equal(n.code, 0, n.out);
  assert.deepEqual(events(f), [`pull ${LATEST}`, `run ${SHOP} ${OLD} port=443`, `tag buh:last-good ${OLD}`]);
});

const IMAGE_ENV = ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_ENV=production', 'PORT=3000', 'HOSTNAME=0.0.0.0', 'DATA_DIR=/data'];
const SECRET = `s3cr3t with spaces $&"'|;\\ and =`;
/** The owner's container, started by hand with its own settings (secrets among them). */
function ownersContainer(e: Env, name = SHOP, extra: { env?: string[]; bindings?: string[]; mounts?: string[]; data?: string } = {}) {
  const data = extra.data ?? `${SHOP}-data`;
  shopContainer(e, name, OLD, 'running', data);
  const d = path.join(e.fake, 'c', name);
  const env = [...IMAGE_ENV.filter((l) => !l.startsWith('HOSTNAME=')), 'HOSTNAME=4f2a9c', `SESSION_SECRET=${SECRET}`, 'SMTP_PASS=p@ss=word', 'TRUST_PROXY=1', 'TZ=Europe/London', ...(extra.env ?? [])];
  fs.writeFileSync(path.join(d, 'env'), env.join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'bindings'), (extra.bindings ?? ['3000/tcp|0.0.0.0|8443', '3000/tcp|::|8443']).join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'mounts'), [`volume|${data}||/data`, ...(extra.mounts ?? [])].join('\n') + '\n');
}
const envOf = (e: Env, name: string) => fileOf(e, name, 'env').split('\n');

test("regression: adopt keeps the owner's own settings (secrets via a root-only env file, never logged) and port", () => {
  const e = setup();
  tag(e, LATEST, OLD);
  ownersContainer(e);
  // SHOP_PORT says 443, but the container the owner runs is on 8443: that is kept.
  const r = runSingle(e, ['adopt'], { SHOP_ENV: 'TZ=Asia/Dubai INSECURE_COOKIES=1' });
  assert.equal(r.code, 0, r.out);
  assert.ok(events(e).includes(`run ${SHOP} ${OLD} port=8443`), events(e).join('\n'));
  assert.equal(fileOf(e, SHOP, 'bindings'), '3000/tcp||8443', 'one binding (0.0.0.0 and :: are the same port)');
  for (const name of [SHOP]) {
    const env = envOf(e, name);
    assert.ok(env.includes(`SESSION_SECRET=${SECRET}`), env.join('\n'));
    assert.ok(env.includes('SMTP_PASS=p@ss=word'));
    assert.ok(env.includes('TRUST_PROXY=1'));
    assert.ok(env.includes('INSECURE_COOKIES=1'));
    assert.ok(env.includes('TZ=Asia/Dubai') && !env.includes('TZ=Europe/London'), 'SHOP_ENV wins');
  }
  // The env file: only what the owner added (not the image's, not the engine's, not SHOP_ENV's), root-only.
  const file = path.join(e.state, 'shop', 'env');
  assert.deepEqual(read(file).trim().split('\n'), [`SESSION_SECRET=${SECRET}`, 'SMTP_PASS=p@ss=word', 'TRUST_PROXY=1']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.match(fileOf(e, SHOP, 'args'), /--env-file \S+\/shop\/env/);
  // Keys are logged, values never (also not in alerts).
  const logged = r.out + read(path.join(e.state, 'updater.log')) + read(path.join(e.alerts, 'alerts.log'));
  assert.match(logged, /SESSION_SECRET SMTP_PASS TRUST_PROXY/);
  assert.ok(!logged.includes('s3cr3t') && !logged.includes('p@ss'), 'no secret in the logs');

  // Once set up: nothing to change, the heal leaves it alone, and the next switch keeps it all.
  fs.rmSync(path.join(e.fake, 'events'));
  assert.match(runSingle(e, ['adopt'], { SHOP_ENV: 'TZ=Asia/Dubai INSECURE_COOKIES=1' }).out, /nothing to change/);
  assert.equal(runSingle(e, ['heal'], { SHOP_ENV: 'TZ=Asia/Dubai INSECURE_COOKIES=1' }).code, 0);
  assert.deepEqual(events(e), []);
  publish(e, NEW);
  assert.equal(runSingle(e, ['once'], { SHOP_ENV: 'TZ=Asia/Dubai INSECURE_COOKIES=1' }).code, 0);
  assert.equal(fileOf(e, SHOP, 'image'), NEW);
  assert.ok(events(e).includes(`run ${SHOP} ${NEW} port=8443`));
  assert.ok(envOf(e, SHOP).includes(`SESSION_SECRET=${SECRET}`));
  // A heal that re-creates the shop keeps them too.
  fs.rmSync(path.join(e.fake, 'c', SHOP), { recursive: true });
  assert.equal(runSingle(e, ['heal'], { SHOP_ENV: 'TZ=Asia/Dubai INSECURE_COOKIES=1' }).code, 0);
  assert.ok(envOf(e, SHOP).includes(`SESSION_SECRET=${SECRET}`));
  assert.equal(fileOf(e, SHOP, 'port'), '8443');
});

test('regression: adopt refuses (exit 2, a plain list, nothing changed) what it cannot carry', () => {
  const e = setup();
  tag(e, LATEST, OLD);
  ownersContainer(e, SHOP, { bindings: ['3000/tcp||443', '9229/tcp||9229'], mounts: ['bind||/srv/receipts|/backups'], env: ['PORT=8080'] });
  // A value with a line break shows as more lines than entries.
  fs.writeFileSync(path.join(e.fake, 'c', SHOP, 'envcount'), String(envOf(e, SHOP).length - 1));
  const r = runSingle(e, ['adopt']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /- the bind \/srv\/receipts at \/backups/);
  assert.match(r.out, /- the port 9229 -> 9229\/tcp/);
  assert.match(r.out, /- the setting PORT/);
  assert.match(r.out, /line break/);
  assert.ok(!r.out.includes('s3cr3t'));
  assert.deepEqual(events(e), []);
  assert.equal(fs.existsSync(path.join(e.state, 'shop', 'env')), false);
  assert.deepEqual(fs.readdirSync(e.state).filter((f) => f.startsWith('.carry')), [], 'nothing left behind');
});

test('regression: never a second shop on the same data volume', () => {
  // Another container (the shop under another name) runs on the volume: nothing is started.
  const e = setup();
  tag(e, LATEST, OLD);
  shopContainer(e, 'my-shop', OLD);
  const r = runSingle(e, ['adopt']);
  assert.equal(r.code, 2, r.out);
  assert.match(alerts(e).at(-1).message, /another running container uses the data volume beautifuluaehome-data: my-shop/);
  assert.ok(!events(e).some((l) => l.startsWith('run ')), events(e).join('\n'));
  const h = runSingle(e, ['heal']);
  assert.equal(h.code, 1, h.out);
  assert.ok(!events(e).some((l) => l.startsWith('run ')), events(e).join('\n'));

  // Nor is a switch started while one runs beside the shop.
  const f = setup();
  runningSingle(f);
  shopContainer(f, 'stray', OLD);
  publish(f, NEW);
  assert.equal(runSingle(f, ['once']).code, 2);
  assert.ok(!events(f).some((l) => l.startsWith('run ') || l.startsWith('stop ')), events(f).join('\n'));
  // A stopped one does not block (it serves nobody).
  fs.writeFileSync(path.join(f.fake, 'c', 'stray', 'status'), 'exited\n');
  assert.equal(runSingle(f, ['once']).code, 0);
  assert.equal(fileOf(f, SHOP, 'image'), NEW);
});

test('regression: a shop container started by hand while the updater runs is set up again, once', () => {
  const e = setup();
  runningSingle(e);
  // The old routine: podman pull / stop / rm / run (no request and status volumes, no label).
  fs.rmSync(path.join(e.fake, 'c', SHOP), { recursive: true });
  ownersContainer(e);
  const r = runSingle(e, ['heal']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /was not started by the updater/);
  assert.ok(events(e).includes(`run ${SHOP} ${OLD} port=8443`), events(e).join('\n'));
  assert.match(fileOf(e, SHOP, 'args'), /beautifuluaehome-updater-control:\/updater-control/);
  assert.ok(envOf(e, SHOP).includes(`SESSION_SECRET=${SECRET}`));
  fs.rmSync(path.join(e.fake, 'events'));
  runSingle(e, ['heal']);
  assert.deepEqual(events(e), [], 'set up now: left alone');

  // One that cannot be carried: an alert, once; it keeps running as it is.
  fs.rmSync(path.join(e.fake, 'c', SHOP), { recursive: true });
  ownersContainer(e, SHOP, { mounts: ['bind||/srv/x|/x'] });
  fs.rmSync(path.join(e.alerts, 'alerts.log'), { force: true });
  runSingle(e, ['heal']);
  runSingle(e, ['heal']);
  assert.equal(alerts(e).filter((a) => /started by hand/.test(a.message)).length, 1);
  assert.equal(statusOf(e, SHOP), 'running');
  assert.ok(!events(e).some((l) => l.startsWith('run ')));
});

test('single: a version without the snapshot tool (before 2.0.0) is not switched away from, with a clear reason', () => {
  const e = setup();
  runningSingle(e);
  publish(e, NEW);
  fs.writeFileSync(path.join(e.fake, 'no-backup-script'), '');
  assert.equal(runSingle(e, ['once']).code, 2);
  assert.match(alerts(e).at(-1).message, /older than BUH-02\.00\.00/);
  assert.ok(!events(e).some((l) => l.startsWith('run ')));
});

test('single: stopping the updater during a trial ends the switch safely (the shop never stops)', async () => {
  const e = setup();
  runningSingle(e);
  publish(e, NEW);
  fs.writeFileSync(path.join(e.fake, 'hold-candidate'), '');
  fs.writeFileSync(path.join(e.state, 'update-now'), '');
  const child: ChildProcess = spawn('sh', [path.join(root, 'deploy/updater/updater.sh'), 'daemon'], {
    env: { PATH: `${e.bin}:${process.env.PATH}`, NODE_ENV: 'test', FAKE_DOCKER_DIR: e.fake, UPDATER_MODE: 'single', STATE_DIR: e.state, ALERT_DIR: e.alerts, PROJECT_DIR: e.project, HEALTH_TIMEOUT: '30', HEAL_CHECK_SECONDS: '1', UPDATE_CHECK_MINUTES: '0' },
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d));
  for (let i = 0; i < 100 && !events(e).includes(`run ${CAND} ${NEW}`); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(events(e).includes(`run ${CAND} ${NEW}`), out);
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGTERM'); // a new set-up, or podman stop
  fs.rmSync(path.join(e.fake, 'hold-candidate')); // the trial now passes
  assert.equal(await exited, 0);
  assert.match(out, /the updater is stopping, so the switch ends here/);
  assert.ok(!events(e).includes(`stop ${SHOP}`), events(e).join('\n'));
  assert.equal(fileOf(e, SHOP, 'image'), OLD);
  assert.equal(statusOf(e, SHOP), 'running');
  assert.equal(exists(e, CAND), false);
});

test('single: invalid SHOP_* settings are refused before Docker is touched', () => {
  const bad: Record<string, string>[] = [
    { SHOP_NAME: 'shop;rm -rf /' },
    { SHOP_NAME: '-shop' },
    { SHOP_NAME: 'a'.repeat(65) },
    { SHOP_NAME: '' + 'shop name' },
    { SHOP_PORT: '0' },
    { SHOP_PORT: '65536' },
    { SHOP_PORT: '443 -v /:/host' },
    { SHOP_PORT: '0443' },
    { SHOP_VOLUME: '../etc' },
    { SHOP_VOLUME: '/var/run/docker.sock' },
    { CONTROL_VOLUME: 'x y' },
    { STATUS_VOLUME: `${SHOP}-data` },
    { SHOP_ENV: 'TZ=Asia/Dubai X=$(id)' },
    { SHOP_ENV: 'lower=1' },
    { SHOP_ENV: "A='quoted'" },
    { SHOP_ENV: 'A="quoted"' },
    { SHOP_ENV: 'A=`id`' },
    { SHOP_ENV: 'A=1;id' },
    { SHOP_ENV: 'A=a\\b' },
    { SHOP_ENV: 'NOEQUALS' },
    { SHOP_ENV: 'DATA_DIR=/tmp' },
    { SHOP_ENV: 'PORT=80' },
    { SHOP_ENV: '-v=1' },
    { SHOP_ENV: 'A=é' },
    { SHOP_ENV: 'A=*' },
    { IMAGE: '--privileged' },
    { IMAGE: 'ghcr.io/cxsmtp/buh:latest -v /:/host' },
    { UPDATER_MODE: 'other' },
  ];
  for (const extra of bad) {
    const e = setup();
    shopContainer(e, SHOP, OLD);
    const r = runSingle(e, ['heal'], extra);
    assert.equal(r.code, 2, `${JSON.stringify(extra)} should be refused:\n${r.out}`);
    assert.deepEqual(events(e), [], JSON.stringify(extra));
    assert.equal(fs.existsSync(path.join(e.state, 'last-good')), false, JSON.stringify(extra));
  }
  // What the owner really uses is accepted (pairs separated by spaces or new lines).
  const e = setup();
  runningSingle(e);
  const ok = runSingle(e, ['heal'], { SHOP_NAME: SHOP, SHOP_PORT: '443', SHOP_ENV: 'TZ=Asia/Dubai\nINSECURE_COOKIES=1 OTP_DEV_MODE=true', SHOP_VOLUME: `${SHOP}-data` });
  assert.equal(ok.code, 0, ok.out);
});

test('single: Settings → Versions requests ("rollback X.Y.Z", "update") switch the one container, and the status says single mode', async () => {
  const e = setup();
  runningSingle(e);
  publish(e, NEW);
  assert.equal(runSingle(e, ['once']).code, 0); // the shop now runs NEW (2.1.0); OLD (2.0.0) is on the server
  fs.mkdirSync(path.join(e.fake, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(e.fake, 'versions', OLD), '2.0.0\n');
  fs.writeFileSync(path.join(e.fake, 'versions', NEW), '2.1.0\n');
  tag(e, 'ghcr.io/cxsmtp/buh:2.0.0', OLD);
  const control = path.join(path.dirname(e.state), 'control');
  const pub = path.join(path.dirname(e.state), 'public');
  fs.mkdirSync(control);
  fs.mkdirSync(pub);
  const child: ChildProcess = spawn('sh', [path.join(root, 'deploy/updater/updater.sh'), 'daemon'], {
    env: {
      PATH: `${e.bin}:${process.env.PATH}`,
      NODE_ENV: 'test',
      FAKE_DOCKER_DIR: e.fake,
      UPDATER_MODE: 'single',
      PROJECT_DIR: e.project,
      STATE_DIR: e.state,
      ALERT_DIR: e.alerts,
      CONTROL_DIR: control,
      PUBLIC_DIR: pub,
      HEALTH_TIMEOUT: '4',
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
    assert.equal(status().mode, 'single');
    assert.match(out, /one container beautifuluaehome on port 443, data in beautifuluaehome-data/);

    fs.writeFileSync(path.join(control, 'request'), 'rollback 2.0.0\n');
    await until(() => status()?.lastRequest.result === 'ok' && status()?.running === '2.0.0');
    assert.equal(fileOf(e, SHOP, 'image'), OLD);
    assert.equal(fileOf(e, PREV, 'image'), NEW);
    assert.equal(statusOf(e, SHOP), 'running');

    fs.writeFileSync(path.join(control, 'request'), 'update\n');
    await until(() => status()?.running === '2.1.0' && status()?.lastRequest.request === 'update');
    assert.equal(status().lastRequest.result, 'ok');
    assert.equal(fileOf(e, SHOP, 'image'), NEW);
    assert.match(fileOf(e, SHOP, 'args'), /-p 443:3000/);
  } finally {
    const exited = new Promise((r) => child.on('exit', r));
    child.kill('SIGTERM');
    await exited;
  }
});

test('regression: a private registry that refuses the download (login expired) is said plainly, once an hour, on Settings → Versions; nothing is marked bad', async () => {
  const e = setup();
  runningSingle(e);
  publish(e, NEW);
  fs.writeFileSync(path.join(e.fake, 'registry-denied'), 'ghcr.io\n');
  // Scheduled checks: no switch, exit 3, one alert for two refusals, no image marked bad.
  for (let i = 0; i < 2; i++) assert.equal(runSingle(e, ['once']).code, 3);
  assert.equal(fileOf(e, SHOP, 'image'), OLD);
  assert.ok(!events(e).some((l) => l.startsWith('run ')), events(e).join('\n'));
  const loginAlerts = alerts(e).filter((a) => /registry login has expired or is missing: ghcr\.io refused to send ghcr\.io\/cxsmtp\/buh:latest/.test(a.message));
  assert.equal(loginAlerts.length, 1, JSON.stringify(alerts(e)));
  assert.equal(loginAlerts[0].level, 'error');
  assert.match(loginAlerts[0].message, /podman login ghcr\.io/);
  assert.equal(read(path.join(e.state, 'bad-images')), '');
  // Settings → Versions: the status says so, and an "update" request says why it failed.
  const control = path.join(path.dirname(e.state), 'control');
  const pub = path.join(path.dirname(e.state), 'public');
  fs.mkdirSync(control);
  fs.mkdirSync(pub);
  const child: ChildProcess = spawn('sh', [path.join(root, 'deploy/updater/updater.sh'), 'daemon'], {
    env: {
      PATH: `${e.bin}:${process.env.PATH}`,
      NODE_ENV: 'test',
      FAKE_DOCKER_DIR: e.fake,
      UPDATER_MODE: 'single',
      PROJECT_DIR: e.project,
      STATE_DIR: e.state,
      ALERT_DIR: e.alerts,
      CONTROL_DIR: control,
      PUBLIC_DIR: pub,
      HEALTH_TIMEOUT: '4',
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
    await until(() => /^the registry login has expired or is missing: ghcr\.io refused/.test(status()?.registryProblem ?? ''));
    fs.writeFileSync(path.join(control, 'request'), 'update\n');
    await until(() => status()?.lastRequest.request === 'update' && status()?.lastRequest.result === 'failed');
    assert.match(status().lastRequest.message, /registry login has expired or is missing/);
    assert.equal(fileOf(e, SHOP, 'image'), OLD);
    // Logged in again: the next request works and the note goes away.
    fs.rmSync(path.join(e.fake, 'registry-denied'));
    fs.writeFileSync(path.join(control, 'request'), 'update\n');
    await until(() => status()?.lastRequest.result === 'ok' && status()?.registryProblem === '');
    assert.equal(fileOf(e, SHOP, 'image'), NEW);
  } finally {
    const exited = new Promise((r) => child.on('exit', r));
    child.kill('SIGTERM');
    await exited;
  }
  assert.ok(!/ghp_|password/i.test(read(path.join(e.state, 'updater.log'))));
});

// ── `setup` and self-update, from the published buh-updater image (no code on the host) ──

const SOCKET = '/run/user/1000/podman/podman.sock';
const UPDATER = `${SHOP}-updater`;
const STATE_VOL = (e: Env) => path.join(e.fake, 'volumes', `${SHOP}-updater-state`);
/** The one-line set-up: `podman run … -e SOCK=… buh-updater setup NAME`, with the fake engine. */
function runSetup(e: Env, args: string[], extra: Record<string, string> = {}) {
  if (!fs.existsSync(path.join(e.fake, 'tags', key(UPDATER_REF)))) tag(e, UPDATER_REF, UPD1);
  return run(e, ['setup', SHOP, ...args], {
    UPDATER_MODE: '',
    COMPOSE_PROJECT_NAME: '',
    SOCK: `unix://${SOCKET}`,
    UPDATER_IMAGE: UPDATER_REF,
    FAKE_UPDATER_SH: path.join(root, 'deploy/updater/updater.sh'),
    ...extra,
  });
}
const updaterEnv = (e: Env) => fileOf(e, UPDATER, 'env').split('\n');

test('setup, a new shop: volumes, the shop on 443 from the published image, then the updater with --restart=always', () => {
  const e = setup();
  publish(e, OLD);
  const r = runSetup(e, []);
  assert.equal(r.code, 0, r.out);
  const ev = events(e);
  for (const v of ['state', 'control', 'status']) assert.ok(ev.includes(`volume create ${SHOP}-updater-${v}`), ev.join('\n'));
  assert.ok(ev.some((l) => l.startsWith('prep ')));
  assert.ok(ev.includes('updater adopt'));
  assert.ok(ev.includes(`run ${SHOP} ${OLD} port=443`));
  assert.equal(ev.at(-1), `run ${UPDATER} ${UPD1}`);
  assert.equal(fileOf(e, SHOP, 'data'), `${SHOP}-data`);
  // The long-running updater: the socket (prefix stripped), label=disable, restart, settings.
  const args = fileOf(e, UPDATER, 'args');
  assert.match(args, /--restart=always --stop-timeout 600/);
  assert.match(args, /--security-opt label=disable -v \/run\/user\/1000\/podman\/podman.sock:\/var\/run\/docker.sock/);
  assert.match(args, /--read-only --tmpfs \/tmp --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --security-opt no-new-privileges:true --pids-limit 128/);
  assert.equal(fileOf(e, UPDATER, 'cmd'), 'daemon');
  const env = updaterEnv(e);
  for (const kv of [`SHOP_NAME=${SHOP}`, `SHOP_VOLUME=${SHOP}-data`, `SOCK=${SOCKET}`, `UPDATER_IMAGE=${UPDATER_REF}`, 'SHOP_ENV=TZ=Asia/Dubai', 'UPDATE_CHECK_MINUTES=15', `CONTROL_VOLUME=${SHOP}-updater-control`])
    assert.ok(env.includes(kv), `${kv} in\n${env.join('\n')}`);
  assert.match(r.out, /Done\. Automatic updates are on for beautifuluaehome/);
  assert.match(r.out, /podman-restart\.service/);
  assert.match(r.out, /systemctl --user enable --now podman\.socket podman-restart\.service/, 'rootless advice');
  assert.ok(fs.existsSync(path.join(STATE_VOL(e), 'last-good')));
});

test("setup, the owner's container on 127.0.0.1:3000 with an env file: binding, settings and data volume kept; a re-run changes nothing", () => {
  const e = setup();
  tag(e, LATEST, OLD);
  fs.writeFileSync(path.join(e.fake, 'rootful'), '');
  // `podman run --env-file .env -p 127.0.0.1:3000:3000 -v shopdata:/data …`: the file's lines are in its env.
  ownersContainer(e, SHOP, { bindings: ['3000/tcp|127.0.0.1|3000'], data: 'shopdata', env: ['NEXT_PUBLIC_APP_URL=https://shop.example', 'BACKUP_PASSPHRASE=two words "quoted"'] });
  const r = runSetup(e, []);
  assert.equal(r.code, 0, r.out);
  assert.ok(events(e).includes(`run ${SHOP} ${OLD} port=3000`), events(e).join('\n'));
  assert.equal(fileOf(e, SHOP, 'bindings'), '3000/tcp|127.0.0.1|3000', 'still on 127.0.0.1 only');
  assert.match(fileOf(e, SHOP, 'args'), /-p 127\.0\.0\.1:3000:3000/);
  assert.equal(fileOf(e, SHOP, 'data'), 'shopdata', 'the volume it had');
  const env = envOf(e, SHOP);
  for (const kv of ['NEXT_PUBLIC_APP_URL=https://shop.example', 'BACKUP_PASSPHRASE=two words "quoted"', `SESSION_SECRET=${SECRET}`, 'TZ=Europe/London'])
    assert.ok(env.includes(kv), `${kv} kept`);
  assert.ok(updaterEnv(e).includes('SHOP_VOLUME=shopdata'));
  assert.ok(updaterEnv(e).includes('SHOP_ENV='), 'no extra settings: its own are carried');
  assert.ok(!r.out.includes('s3cr3t') && !r.out.includes('two words'), 'no value in the output');
  assert.match(r.out, /sudo systemctl enable --now podman\.socket podman-restart\.service/, 'rootful advice');

  // Again: the shop is left as it is (only the updater is started afresh).
  fs.rmSync(path.join(e.fake, 'events'));
  const again = runSetup(e, []);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /nothing to change/);
  assert.ok(!events(e).some((l) => l.startsWith(`run ${SHOP} `) || l === `stop ${SHOP}`), events(e).join('\n'));
  assert.deepEqual(events(e).filter((l) => l.includes(UPDATER)), [`stop ${UPDATER}`, `rm ${UPDATER}`, `run ${UPDATER} ${UPD1}`]);
});

test('setup refuses, changing nothing: what cannot be carried, a second shop on the volume, data in a host folder, bad input', () => {
  const cases: [string, (e: Env) => void, string[], Record<string, string>, RegExp][] = [
    ['extra bind mount', (e) => ownersContainer(e, SHOP, { mounts: ['bind||/srv/x|/x'] }), [], {}, /the bind \/srv\/x at \/x/],
    ['second shop on the volume', (e) => (ownersContainer(e), shopContainer(e, 'my-other-shop', OLD)), [], {}, /Nothing was changed/],
    ['host folder', (e) => (ownersContainer(e), fs.writeFileSync(path.join(e.fake, 'c', SHOP, 'data'), '\n')), [], {}, /host folder/],
    ['bad name', () => {}, [], {}, /container name must be/],
    ['bad socket', () => {}, [], { SOCK: '/run/x;rm -rf /' }, /socket path/],
    ['no socket', () => {}, [], { SOCK: '' }, /socket path/],
    ['bad option', () => {}, ['--privileged', 'x'], {}, /unknown option/],
    ['bad env', (e) => ownersContainer(e), ['--env', 'A=$(id)'], {}, /SHOP_ENV/],
  ];
  for (const [what, prepare, args, extra, message] of cases) {
    const e = setup();
    tag(e, LATEST, OLD);
    prepare(e);
    const before = exists(e, SHOP) ? fileOf(e, SHOP, 'image') : '';
    const r = what === 'bad name' ? run(e, ['setup', 'shop;rm'], { SOCK: SOCKET, UPDATER_IMAGE: UPDATER_REF, FAKE_UPDATER_SH: 'x' }) : runSetup(e, args, extra);
    assert.equal(r.code, 2, `${what}: ${r.out}`);
    assert.match(r.out, message, what);
    assert.ok(!exists(e, UPDATER), `${what}: no updater started`);
    assert.ok(!events(e).some((l) => l.startsWith(`run ${SHOP}`) || l.startsWith(`stop ${SHOP}`)), `${what}: shop untouched: ${events(e).join('\n')}`);
    if (before) assert.equal(fileOf(e, SHOP, 'image'), before);
  }
});

test('private images: setup refuses without a login (nothing changed); with the mounted login it passes it on, and a new login is used without a restart', () => {
  const e = setup();
  publish(e, OLD);
  ownersContainer(e);
  tag(e, PROXY_REF, PROXY1);
  fs.writeFileSync(path.join(e.fake, 'registry-denied'), 'ghcr.io\n');
  const token = 'ghp_' + 'T'.repeat(36);
  // The login folder as the container sees it (AUTH_MOUNT), and the CLI's own config folder.
  const mount = path.join(path.dirname(e.state), 'registry-auth');
  const cliConfig = path.join(path.dirname(e.state), 'docker-config');
  fs.mkdirSync(mount);
  const login = { AUTH_MOUNT: mount, DOCKER_CONFIG: cliConfig };
  const proxy = ['--proxy', 'shop.example.com', '--email', 'owner@shop.example'];
  const untouched = () => assert.deepEqual(events(e).filter((l) => !l.startsWith('pull-denied ')), [], 'nothing created, started or stopped');

  // 1. A line without the login folder.
  fs.rmSync(path.join(e.fake, 'events'), { force: true });
  let r = runSetup(e, proxy, login);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /ghcr\.io refused to send ghcr\.io\/cxsmtp\/buh:latest ghcr\.io\/cxsmtp\/buh-updater:latest ghcr\.io\/cxsmtp\/buh-proxy:latest: no valid login/);
  assert.match(r.out, /did not pass Podman's login folder/);
  assert.match(r.out, /Nothing was changed/);
  assert.match(r.out, /podman login ghcr\.io -u YOUR-GITHUB-NAME --authfile \/root\/\.config\/containers\/auth\.json/);
  assert.match(r.out, /read:packages/);
  untouched();
  // 2. The folder, but no login in it.
  fs.writeFileSync(path.join(e.fake, 'setup-auth-mount'), '/root/.config/containers\n');
  r = runSetup(e, proxy, login);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /There is no auth\.json in \/root\/\.config\/containers/);
  untouched();
  // 3. Logged in: set up; the updater gets the folder read-only, and no token is shown.
  fs.writeFileSync(path.join(mount, 'auth.json'), JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from(`owner:${token}`).toString('base64') } } }));
  r = runSetup(e, proxy, login);
  assert.equal(r.code, 0, r.out);
  assert.match(fileOf(e, UPDATER, 'args'), new RegExp(`-v /root/\\.config/containers:${mount}:ro`));
  assert.ok(updaterEnv(e).includes('REGISTRY_AUTH_DIR=/root/.config/containers'));
  assert.equal(fs.readlinkSync(path.join(cliConfig, 'config.json')), path.join(mount, 'auth.json'), 'a link, not a copy');
  assert.ok(!r.out.includes(token) && !r.out.includes(Buffer.from(`owner:${token}`).toString('base64')));

  // 4. The token expires: the scheduled check says so; a new `podman login` (a new file) is used at once.
  publish(e, NEW);
  const asIt = { ...login, AUTH_MOUNT: mount, IMAGE: LATEST };
  fs.writeFileSync(path.join(mount, 'auth.json.new'), JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from('owner:old').toString('base64'), fake: 'expired' } } }));
  fs.renameSync(path.join(mount, 'auth.json.new'), path.join(mount, 'auth.json'));
  assert.equal(asUpdater(e, UPDATER, ['once'], asIt).code, 3);
  assert.match(read(path.join(STATE_VOL(e), 'alerts', 'alerts.log')), /registry login has expired or is missing: ghcr\.io refused/);
  fs.writeFileSync(path.join(mount, 'auth.json.new'), JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from(`owner:${token}`).toString('base64') } } }));
  fs.renameSync(path.join(mount, 'auth.json.new'), path.join(mount, 'auth.json'));
  assert.equal(asUpdater(e, UPDATER, ['once'], asIt).code, 0);
  assert.equal(fileOf(e, SHOP, 'image'), NEW);
  assert.ok(!fs.existsSync(path.join(STATE_VOL(e), 'registry-login')), 'the note is gone');
  const logText = read(path.join(STATE_VOL(e), 'updater.log'));
  assert.ok(!logText.includes(token) && !logText.includes('owner:'), 'no credential in the log');
});

/** The running updater (as SHOP-updater, from UPD1), set up by `setup`. */
function setUp(e: Env) {
  tag(e, LATEST, OLD);
  ownersContainer(e);
  const r = runSetup(e, []);
  assert.equal(r.code, 0, r.out);
  fs.rmSync(path.join(e.fake, 'events'));
}
/** A command run inside the updater container named `as`. */
const asUpdater = (e: Env, as: string, args: string[], extra: Record<string, string> = {}) =>
  runSingle(e, args, {
    UPDATER_CONTAINER: as,
    UPDATER_IMAGE: UPDATER_REF,
    SOCK: SOCKET,
    STATE_DIR: STATE_VOL(e),
    ALERT_DIR: path.join(STATE_VOL(e), 'alerts'),
    SHOP_ENV: '',
    SELF_CHECK_SECONDS: '0',
    ...extra,
  });

test('self-update: a newer buh-updater image is started as -new, checked, then takes the name; the old one is retired by it', () => {
  const e = setup();
  setUp(e);
  fs.writeFileSync(path.join(e.fake, 'registry', key(UPDATER_REF)), UPD2 + '\n');
  const r = asUpdater(e, UPDATER, ['self-update']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(events(e), [`pull ${UPDATER_REF}`, `run ${UPDATER}-new ${UPD2}`, `rename ${UPDATER} ${UPDATER}-old`, `rename ${UPDATER}-new ${UPDATER}`]);
  assert.equal(fileOf(e, UPDATER, 'image'), UPD2);
  assert.match(fileOf(e, UPDATER, 'args'), /--restart=always/);
  assert.match(read(path.join(STATE_VOL(e), 'alerts', 'alerts.log')), /updated itself/);

  // The new one, on its next round, stops and removes the one it replaced; nothing newer: done.
  fs.rmSync(path.join(e.fake, 'events'));
  assert.equal(asUpdater(e, UPDATER, ['self-update']).code, 0);
  assert.deepEqual(events(e), [`stop ${UPDATER}-old`, `rm ${UPDATER}-old`, `pull ${UPDATER_REF}`]);
  assert.equal(exists(e, `${UPDATER}-old`), false);
  // The shop was never touched.
  assert.equal(statusOf(e, SHOP), 'running');
});

test('self-update: a broken updater image is removed, the running updater stays, and shop updates go on', () => {
  const e = setup();
  setUp(e);
  fs.writeFileSync(path.join(e.fake, 'registry', key(UPDATER_REF)), UPDBROKEN + '\n');
  const r = asUpdater(e, UPDATER, ['self-update']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(events(e), [`pull ${UPDATER_REF}`, `run ${UPDATER}-new ${UPDBROKEN}`, `kill ${UPDATER}-new`, `rm ${UPDATER}-new`]);
  assert.equal(fileOf(e, UPDATER, 'image'), UPD1, 'the running updater is unchanged');
  assert.equal(exists(e, `${UPDATER}-new`), false);
  assert.match(read(path.join(STATE_VOL(e), 'alerts', 'alerts.log')), /not used \(it could not reach the engine/);
  // Not tried again.
  fs.rmSync(path.join(e.fake, 'events'));
  asUpdater(e, UPDATER, ['self-update']);
  assert.ok(!events(e).some((l) => l.startsWith('run ')), events(e).join('\n'));
  // Shop updates still work.
  publish(e, NEW);
  const u = asUpdater(e, UPDATER, ['once']);
  assert.equal(u.code, 0, u.out);
  assert.equal(fileOf(e, SHOP, 'image'), NEW);
});

test('regression: the request and status folders are taken back when the engine gave them to the shop (Podman 5)', { skip: process.getuid?.() !== 0 && 'needs root to chown' }, () => {
  const e = setup();
  runningSingle(e);
  const control = path.join(path.dirname(e.state), 'control');
  const pub = path.join(path.dirname(e.state), 'public');
  fs.mkdirSync(control, { mode: 0o755 });
  fs.mkdirSync(pub, { mode: 0o700 });
  // What Podman's Docker API did when it started the shop: the folders became the shop user's.
  fs.chownSync(control, 1001, 1001);
  fs.chownSync(pub, 1001, 1001);
  const r = runSingle(e, ['heal'], { CONTROL_DIR: control, PUBLIC_DIR: pub });
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.statSync(control).uid, 0);
  assert.equal(fs.statSync(control).mode & 0o7777, 0o1733);
  assert.equal(fs.statSync(pub).uid, 0);
  assert.equal(fs.statSync(pub).mode & 0o7777, 0o755);
  assert.match(r.out, /it is the updater's again/);
});

test('self-update: a new updater that never completes a round is removed, and the one before takes the name back', () => {
  const e = setup();
  setUp(e);
  fs.writeFileSync(path.join(e.fake, 'registry', key(UPDATER_REF)), UPD2 + '\n');
  // The handover: UPD2 takes the name; the one before waits (HANDOVER_SECONDS=0: no time).
  assert.equal(asUpdater(e, UPDATER, ['self-update'], { HANDOVER_SECONDS: '0' }).code, 0);
  assert.equal(fileOf(e, UPDATER, 'image'), UPD2);
  assert.equal(statusOf(e, `${UPDATER}-old`), 'running', 'the one before is kept, not stopped');
  assert.ok(fs.existsSync(path.join(STATE_VOL(e), 'handover')));
  // The new one fails in its working path (it never confirms); the one before notices.
  fs.rmSync(path.join(e.fake, 'events'));
  const r = asUpdater(e, `${UPDATER}-old`, ['self-update']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(events(e), [`kill ${UPDATER}`, `rm ${UPDATER}`, `rename ${UPDATER}-old ${UPDATER}`]);
  assert.equal(fileOf(e, UPDATER, 'image'), UPD1, 'the one before has the name again');
  assert.equal(exists(e, `${UPDATER}-old`), false);
  assert.match(read(path.join(STATE_VOL(e), 'bad-updater-images')), /upd2/);
  assert.match(read(path.join(STATE_VOL(e), 'alerts', 'alerts.log')), /did not complete a round/);
  // Not tried again.
  fs.rmSync(path.join(e.fake, 'events'));
  asUpdater(e, UPDATER, ['self-update']);
  assert.ok(!events(e).some((l) => l.startsWith('run ')), events(e).join('\n'));
});

test('self-update: once the new updater has done a round, the one before is removed and no longer takes over', () => {
  const e = setup();
  setUp(e);
  fs.writeFileSync(path.join(e.fake, 'registry', key(UPDATER_REF)), UPD2 + '\n');
  assert.equal(asUpdater(e, UPDATER, ['self-update'], { HANDOVER_SECONDS: '0' }).code, 0);
  // The one before, before the deadline: nothing.
  fs.writeFileSync(path.join(STATE_VOL(e), 'handover'), `${UPD2} ${Math.floor(Date.now() / 1000) + 600}\n`);
  fs.rmSync(path.join(e.fake, 'events'));
  asUpdater(e, `${UPDATER}-old`, ['self-update']);
  assert.deepEqual(events(e), []);
  // The new one does its round: confirmed, the one before removed.
  asUpdater(e, UPDATER, ['self-update']);
  assert.deepEqual(events(e).slice(0, 2), [`stop ${UPDATER}-old`, `rm ${UPDATER}-old`]);
  assert.equal(fs.existsSync(path.join(STATE_VOL(e), 'handover')), false);
});

/** Set up with the HTTPS proxy, the shop the owner started on 127.0.0.1:3000. */
function setUpProxy(e: Env, extra: Record<string, string> = {}, args: string[] = []) {
  tag(e, PROXY_REF, PROXY1);
  return runSetup(e, ['--proxy', 'shop.example.com', '--email', 'owner@shop.example', ...args], { PROXY_SETTLE_SECONDS: '0', ...extra });
}

test('setup --proxy: a new shop gets TRUST_PROXY=1 and its https address; the proxy is started once, not again on a re-run', () => {
  const e = setup();
  publish(e, OLD);
  tag(e, LATEST, OLD);
  const r = setUpProxy(e);
  assert.equal(r.code, 0, r.out);
  assert.equal(fileOf(e, SHOP, 'bindings'), '3000/tcp|127.0.0.1|3000', 'a new shop behind the proxy: this server only');
  const env = envOf(e, SHOP);
  assert.ok(env.includes('TRUST_PROXY=1') && env.includes('NEXT_PUBLIC_APP_URL=https://shop.example.com'), env.join('\n'));
  assert.ok(events(e).includes(`create ${SHOP}-proxy ${PROXY1}`));
  const penv = envOf(e, `${SHOP}-proxy`);
  for (const kv of ['DOMAIN=shop.example.com', 'UPSTREAM=127.0.0.1:3000', 'ACME_EMAIL=owner@shop.example']) assert.ok(penv.includes(kv), kv);
  assert.match(fileOf(e, `${SHOP}-proxy`, 'args'), /--network host .*--cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true/);
  assert.doesNotMatch(r.out, /Please check/);
  // Again: the proxy already runs this image with these settings, so HTTPS is not interrupted.
  fs.rmSync(path.join(e.fake, 'events'));
  const again = setUpProxy(e);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already runs with these settings/);
  assert.ok(!events(e).some((l) => l.includes(`${SHOP}-proxy`)), events(e).join('\n'));
});

test("setup --proxy on the owner's shop without TRUST_PROXY and with another address: kept as they are, and pointed out", () => {
  const e = setup();
  tag(e, LATEST, OLD);
  ownersContainer(e, SHOP, { bindings: ['3000/tcp|127.0.0.1|3000'], env: ['NEXT_PUBLIC_APP_URL=https://old.example'] });
  const envFile = path.join(e.fake, 'c', SHOP, 'env');
  fs.writeFileSync(envFile, read(envFile).replace('TRUST_PROXY=1\n', ''));
  const r = setUpProxy(e);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /does not have TRUST_PROXY=1[\s\S]*--env "TRUST_PROXY=1"/);
  assert.match(r.out, /NEXT_PUBLIC_APP_URL=https:\/\/old\.example, but the proxy serves https:\/\/shop\.example\.com/);
  assert.ok(!envOf(e, SHOP).includes('TRUST_PROXY=1'), 'not added without being asked');
  // Asked: added (and no more warnings).
  const fixed = setUpProxy(e, {}, ['--env', 'TRUST_PROXY=1 NEXT_PUBLIC_APP_URL=https://shop.example.com']);
  assert.equal(fixed.code, 0, fixed.out);
  assert.ok(envOf(e, SHOP).includes('TRUST_PROXY=1'));
  assert.doesNotMatch(fixed.out, /Please check/);
});

test('setup --proxy: when the proxy cannot start, the shop is still set up and the updater runs; it is not marked bad', () => {
  const e = setup();
  tag(e, LATEST, OLD);
  ownersContainer(e, SHOP, { bindings: ['3000/tcp|127.0.0.1|3000'] });
  fs.writeFileSync(path.join(e.fake, 'proxy-fails'), '');
  const r = setUpProxy(e);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /The shop was set up and the updater runs/);
  assert.equal(statusOf(e, UPDATER), 'running');
  assert.equal(exists(e, `${SHOP}-proxy`), false);
  assert.equal(read(path.join(STATE_VOL(e), 'bad-proxy-images')), '', 'ports taken is not the image');
  // The updater tries again; once the ports are free, the proxy runs. Alerts are limited.
  fs.rmSync(path.join(e.fake, 'events'));
  const env = { PROXY_IMAGE: PROXY_REF, PROXY_DOMAIN: 'shop.example.com', PROXY_EMAIL: 'owner@shop.example', PROXY_UPSTREAM: '127.0.0.1:3000', PROXY_SETTLE_SECONDS: '0' };
  asUpdater(e, UPDATER, ['self-update'], env);
  asUpdater(e, UPDATER, ['self-update'], env);
  assert.equal(read(path.join(STATE_VOL(e), 'alerts', 'alerts.log')).match(/did not come up \(are ports 80 and 443 free/g)?.length, 1, 'two rounds, one alert');
  fs.rmSync(path.join(e.fake, 'proxy-fails'));
  asUpdater(e, UPDATER, ['self-update'], env);
  assert.equal(statusOf(e, `${SHOP}-proxy`), 'running');
});

test('the proxy: an update that fails is undone and remembered; a missing proxy is never restarted from a bad image', () => {
  const e = setup();
  tag(e, LATEST, OLD);
  ownersContainer(e, SHOP, { bindings: ['3000/tcp|127.0.0.1|3000'] });
  assert.equal(setUpProxy(e).code, 0);
  const env = { PROXY_IMAGE: PROXY_REF, PROXY_DOMAIN: 'shop.example.com', PROXY_EMAIL: 'owner@shop.example', PROXY_UPSTREAM: '127.0.0.1:3000', PROXY_SETTLE_SECONDS: '0' };
  // An update to a broken proxy image: the previous one is back.
  fs.writeFileSync(path.join(e.fake, 'registry', key(PROXY_REF)), PROXYBROKEN + '\n');
  fs.rmSync(path.join(e.fake, 'events'));
  const d = asUpdater(e, UPDATER, ['update-proxy'], env);
  assert.equal(d.code, 0, d.out);
  assert.equal(fileOf(e, `${SHOP}-proxy`, 'image'), PROXY1, 'the one before is back');
  assert.match(read(path.join(STATE_VOL(e), 'bad-proxy-images')), /proxybroken/);
  // It disappears: started again from the last image that worked, not the bad one.
  fs.rmSync(path.join(e.fake, 'c', `${SHOP}-proxy`), { recursive: true });
  fs.rmSync(path.join(e.fake, 'events'));
  asUpdater(e, UPDATER, ['self-update'], env);
  assert.ok(events(e).includes(`create ${SHOP}-proxy ${PROXY1}`), events(e).join('\n'));
  // With no image that worked left, it waits and says so, once an hour.
  fs.rmSync(path.join(e.fake, 'c', `${SHOP}-proxy`), { recursive: true });
  fs.rmSync(path.join(STATE_VOL(e), 'proxy-last-good'));
  fs.rmSync(path.join(e.fake, 'events'));
  asUpdater(e, UPDATER, ['self-update'], env);
  asUpdater(e, UPDATER, ['self-update'], env);
  assert.ok(!events(e).some((l) => l.startsWith(`create ${SHOP}-proxy`)), events(e).join('\n'));
  assert.equal(read(path.join(STATE_VOL(e), 'alerts', 'alerts.log')).match(/failed before; waiting for a newer one/g)?.length, 1);
});

test('the proxy: the same image is left running; a new one is created before the old one stops (the shortest pause)', () => {
  const e = setup();
  tag(e, LATEST, OLD);
  ownersContainer(e, SHOP, { bindings: ['3000/tcp|127.0.0.1|3000'] });
  assert.equal(setUpProxy(e).code, 0);
  const env = { PROXY_IMAGE: PROXY_REF, PROXY_DOMAIN: 'shop.example.com', PROXY_EMAIL: 'owner@shop.example', PROXY_UPSTREAM: '127.0.0.1:3000', PROXY_SETTLE_SECONDS: '0' };
  // A release whose proxy image did not change (reproducible build: the same ID): untouched.
  fs.rmSync(path.join(e.fake, 'events'));
  assert.equal(asUpdater(e, UPDATER, ['update-proxy'], env).code, 0);
  assert.ok(!events(e).some((l) => l.includes(`${SHOP}-proxy`)), events(e).join('\n'));
  // A changed one: the old proxy serves until the new container exists, then stop, start.
  fs.writeFileSync(path.join(e.fake, 'registry', key(PROXY_REF)), PROXY2 + '\n');
  fs.rmSync(path.join(e.fake, 'events'), { force: true });
  assert.equal(asUpdater(e, UPDATER, ['update-proxy'], env).code, 0);
  assert.deepEqual(events(e).filter((l) => l.includes(`${SHOP}-proxy`)), [
    `rename ${SHOP}-proxy ${SHOP}-proxy-previous`,
    `create ${SHOP}-proxy ${PROXY2}`,
    `stop ${SHOP}-proxy-previous`,
    `start ${SHOP}-proxy`,
  ]);
  assert.equal(fileOf(e, `${SHOP}-proxy`, 'image'), PROXY2);
});

test('regression: the folder marker is never written through a link the shop planted', { skip: process.getuid?.() !== 0 && 'needs root to chown' }, () => {
  const e = setup();
  runningSingle(e);
  const control = path.join(path.dirname(e.state), 'control');
  const pub = path.join(path.dirname(e.state), 'public');
  fs.mkdirSync(control);
  fs.mkdirSync(pub);
  const target = path.join(path.dirname(e.state), 'precious');
  fs.writeFileSync(target, 'keep\n');
  fs.symlinkSync(target, path.join(control, '.updater-folder'));
  fs.chownSync(control, 1001, 1001);
  assert.equal(runSingle(e, ['heal'], { CONTROL_DIR: control, PUBLIC_DIR: pub }).code, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n');
  assert.equal(fs.statSync(control).uid, 0);
  assert.ok(fs.lstatSync(path.join(pub, '.updater-folder')).isFile(), 'made where there was none');
  assert.deepEqual(fs.readdirSync(pub).filter((f) => f.startsWith('.updater-folder.')), [], 'no temporary file left');
});

// ── "Install new versions automatically" (Settings → Versions: "auto on" / "auto off") ──

/** The updater's daemon as SHOP-updater (set up by `setup`), with its status and request folders. */
function daemonAs(e: Env, extra: Record<string, string> = {}) {
  const control = path.join(e.fake, 'volumes', `${SHOP}-updater-control`);
  const pub = path.join(e.fake, 'volumes', `${SHOP}-updater-status`);
  fs.mkdirSync(control, { recursive: true });
  fs.mkdirSync(pub, { recursive: true });
  const child: ChildProcess = spawn('sh', [path.join(root, 'deploy/updater/updater.sh'), 'daemon'], {
    env: {
      PATH: `${e.bin}:${process.env.PATH}`,
      NODE_ENV: 'test',
      FAKE_DOCKER_DIR: e.fake,
      UPDATER_MODE: 'single',
      UPDATER_CONTAINER: UPDATER,
      UPDATER_IMAGE: UPDATER_REF,
      SOCK: SOCKET,
      PROJECT_DIR: e.project,
      STATE_DIR: STATE_VOL(e),
      ALERT_DIR: path.join(STATE_VOL(e), 'alerts'),
      CONTROL_DIR: control,
      PUBLIC_DIR: pub,
      HEALTH_TIMEOUT: '4',
      HEAL_CHECK_SECONDS: '1',
      SELF_CHECK_SECONDS: '0',
      UPDATE_CHECK_MINUTES: '0',
      ...extra,
    },
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d));
  child.stderr?.on('data', (d: Buffer) => (out += d));
  const status = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(pub, 'status.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const until = async (fn: () => boolean, what: string) => {
    for (let i = 0; i < 150 && !fn(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fn(), `${what}\n${out}`);
  };
  const ask = (line: string) => fs.writeFileSync(path.join(control, 'request'), `${line}\n`);
  const stop = async () => {
    const exited = new Promise((r) => child.on('exit', r));
    child.kill('SIGTERM');
    await exited;
  };
  return { status, until, ask, stop };
}

test('auto off: no scheduled check or install (shop, proxy, updater); "update" from the page still works; the setting survives a restart and a self-update', async () => {
  const e = setup();
  setUp(e);
  fs.mkdirSync(path.join(e.fake, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(e.fake, 'versions', OLD), '2.0.0\n');
  fs.writeFileSync(path.join(e.fake, 'versions', NEW), '2.1.0\n');
  // 1. Switched off from the page.
  let d = daemonAs(e);
  try {
    await d.until(() => d.status()?.auto === true, 'on by default');
    d.ask('auto off');
    await d.until(() => d.status()?.auto === false && d.status()?.lastRequest.request === 'auto off' && d.status()?.lastRequest.result === 'ok', 'auto off confirmed');
  } finally {
    await d.stop();
  }
  // 2. A new shop version and a new updater are out; checks are due at once (every minute), but off means off.
  publish(e, NEW);
  fs.writeFileSync(path.join(e.fake, 'registry', key(UPDATER_REF)), UPD2 + '\n');
  fs.rmSync(path.join(e.fake, 'events'), { force: true });
  d = daemonAs(e, { UPDATE_CHECK_MINUTES: '1' });
  try {
    await d.until(() => d.status()?.auto === false, 'still off after a restart');
    await new Promise((r) => setTimeout(r, 3000));
    assert.ok(!events(e).some((l) => l.startsWith('pull ') || l.startsWith('run ')), events(e).join('\n'));
    assert.equal(fileOf(e, SHOP, 'image'), OLD);
    assert.equal(fileOf(e, UPDATER, 'image'), UPD1);
    // 3. Asked for on the page: it works.
    d.ask('update');
    await d.until(() => d.status()?.lastRequest.request === 'update' && d.status()?.lastRequest.result === 'ok', 'manual update');
    assert.equal(fileOf(e, SHOP, 'image'), NEW);
    assert.match(d.status().lastCheck.result, /^installed 2\.1\.0$/);
    assert.ok(Date.parse(d.status().lastCheck.at) > 0);
    assert.equal(fileOf(e, UPDATER, 'image'), UPD1, 'the updater did not update itself');
  } finally {
    await d.stop();
  }
  // 4. A self-update asked for by hand: the new updater keeps the setting (it is in the volume).
  assert.equal(asUpdater(e, UPDATER, ['self-update']).code, 0);
  assert.equal(fileOf(e, UPDATER, 'image'), UPD2);
  d = daemonAs(e);
  try {
    await d.until(() => d.status()?.auto === false, 'still off after the self-update');
    d.ask('auto on');
    await d.until(() => d.status()?.auto === true && d.status()?.lastRequest.request === 'auto on', 'on again');
    // Anything else is refused, and the setting is not touched.
    d.ask('auto maybe');
    await d.until(() => d.status()?.lastRequest.result === 'refused', 'unknown line refused');
    assert.equal(d.status().auto, true);
  } finally {
    await d.stop();
  }
});

// ── Versions installed here: history, digests first recorded (trust on first use), rollbacks by digest ──

const D_OLD = 'sha256:' + '1'.repeat(64);
const D_NEW = 'sha256:' + '2'.repeat(64);
const D_MOVED = 'sha256:' + '3'.repeat(64);
const REPO = 'ghcr.io/cxsmtp/buh';
const history = (e: Env) => read(path.join(e.state, 'install-history')).trim().split('\n').filter(Boolean).map((l) => l.split(' '));

test('every install is recorded (version, digest, when, why) and the shop runs by digest; the same version under another digest is refused', () => {
  const e = setup();
  runningSingle(e);
  fs.mkdirSync(path.join(e.fake, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(e.fake, 'versions', OLD), '2.0.0\n');
  fs.writeFileSync(path.join(e.fake, 'versions', NEW), '2.1.0\n');
  fs.writeFileSync(path.join(e.fake, 'versions', NEWER), '2.1.0\n'); // other contents, same number
  fs.mkdirSync(path.join(e.fake, 'registry-digest'), { recursive: true });
  // 2.1.0 is published (scheduled check): installed, recorded, started as repo@digest.
  publish(e, NEW);
  fs.writeFileSync(path.join(e.fake, 'registry-digest', key(LATEST)), D_NEW + '\n');
  assert.equal(runSingle(e, ['once']).code, 0);
  assert.equal(fileOf(e, SHOP, 'image'), NEW);
  assert.match(fileOf(e, SHOP, 'args'), new RegExp(`--pids-limit 512 ${REPO}@${D_NEW}$`), 'started by digest');
  assert.equal(read(path.join(e.state, 'version-digests')), `2.1.0 ${D_NEW}\n`);
  const [at, version, digest, why] = history(e).at(-1)!;
  assert.ok(Date.parse(at) > 0);
  assert.deepEqual([version, digest, why], ['2.1.0', D_NEW, 'scheduled']);
  // Asked for by hand: "manual".
  publish(e, NEW);
  assert.equal(runSingle(e, ['update-now']).code, 0, 'up to date: nothing installed');
  assert.equal(history(e).length, 2, 'set-up + 2.1.0');
  // 2.1.0 again, but other contents under another digest (a moved tag): refused, critical, the shop untouched.
  publish(e, NEWER);
  fs.writeFileSync(path.join(e.fake, 'registry-digest', key(LATEST)), D_MOVED + '\n');
  fs.rmSync(path.join(e.fake, 'events'), { force: true });
  assert.equal(runSingle(e, ['once']).code, 2);
  assert.equal(fileOf(e, SHOP, 'image'), NEW);
  assert.ok(!events(e).some((l) => l.startsWith('run ')), events(e).join('\n'));
  const critical = alerts(e).filter((a) => a.level === 'critical');
  assert.equal(critical.length, 1);
  assert.match(critical[0].message, /version 2\.1\.0 is published under another digest than the one it first came with here \(first 222222222222, now 333333333333\), so it is not installed/);
  assert.match(read(path.join(e.state, 'integrity-problem')), /2\.1\.0/);
  assert.equal(read(path.join(e.state, 'version-digests')), `2.1.0 ${D_NEW}\n`, 'the first record stays');
  assert.equal(read(path.join(e.state, 'bad-images')), '', 'not a broken image: a refused one');
  // Again: refused again, without a second alert within the hour.
  assert.equal(runSingle(e, ['once']).code, 2);
  assert.equal(alerts(e).filter((a) => a.level === 'critical').length, 1);
});

test('a rollback to a recorded version starts it by the digest it first came with, even if its tag has moved since', () => {
  const e = setup();
  runningSingle(e);
  fs.mkdirSync(path.join(e.fake, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(e.fake, 'versions', OLD), '2.0.0\n');
  fs.writeFileSync(path.join(e.fake, 'versions', NEW), '2.1.0\n');
  fs.writeFileSync(path.join(e.fake, 'versions', NEWER), '2.0.0\n');
  fs.mkdirSync(path.join(e.fake, 'registry-digest'), { recursive: true });
  // 2.0.0 first came as D_OLD (its pull recorded it), then 2.1.0 was installed.
  fs.writeFileSync(path.join(e.fake, 'registry', key(`${REPO}:2.0.0`)), OLD + '\n');
  fs.writeFileSync(path.join(e.fake, 'registry-digest', key(`${REPO}:2.0.0`)), D_OLD + '\n');
  fs.writeFileSync(path.join(e.fake, 'registry', key(`${REPO}@${D_OLD}`)), OLD + '\n');
  // (the digest is recorded the first time the version is checked: the rollback below)
  publish(e, NEW);
  fs.writeFileSync(path.join(e.fake, 'registry-digest', key(LATEST)), D_NEW + '\n');
  assert.equal(runSingle(e, ['once']).code, 0);
  assert.equal(runSingle(e, ['rollback', `${REPO}:2.0.0`]).code, 0);
  assert.equal(fileOf(e, SHOP, 'image'), OLD);
  assert.equal(history(e).at(-1)![1], '2.0.0');
  assert.equal(history(e).at(-1)![3], 'rollback');
  assert.match(read(path.join(e.state, 'version-digests')), new RegExp(`^2\\.0\\.0 ${D_OLD}$`, 'm'));
  // Back to 2.1.0 (by its digest too), then the 2.0.0 tag is moved to other contents: the rollback still runs D_OLD.
  assert.equal(runSingle(e, ['rollback', `${REPO}:2.1.0`]).code, 0);
  assert.equal(fileOf(e, SHOP, 'image'), NEW);
  fs.rmSync(path.join(e.fake, 'tags', key(`${REPO}:2.0.0`)));
  fs.writeFileSync(path.join(e.fake, 'registry', key(`${REPO}:2.0.0`)), NEWER + '\n');
  fs.writeFileSync(path.join(e.fake, 'registry-digest', key(`${REPO}:2.0.0`)), D_MOVED + '\n');
  fs.rmSync(path.join(e.fake, 'events'), { force: true });
  assert.equal(runSingle(e, ['rollback', `${REPO}:2.0.0`]).code, 0);
  assert.equal(fileOf(e, SHOP, 'image'), OLD, 'the recorded contents, not the moved tag');
  assert.match(fileOf(e, SHOP, 'args'), new RegExp(`${REPO}@${D_OLD}$`));
  assert.ok(!events(e).includes(`pull ${REPO}:2.0.0`), 'the moved tag is never fetched');
});

test('regression: an image built on this computer (no registry in its name) is never refused for its digest (Docker gives every local image one)', () => {
  const e = setup();
  runningSingle(e);
  fs.mkdirSync(path.join(e.fake, 'versions'), { recursive: true });
  fs.mkdirSync(path.join(e.fake, 'digests'), { recursive: true });
  for (const [id, d] of [[NEW, '4'], [NEWER, '5']]) {
    fs.writeFileSync(path.join(e.fake, 'versions', id), '2.1.0\n');
    fs.writeFileSync(path.join(e.fake, 'digests', id.slice(7)), `buh@sha256:${d.repeat(64)}\n`);
  }
  tag(e, 'buh:ci', NEW);
  assert.equal(runSingle(e, ['once'], { IMAGE: 'buh:ci' }).code, 0);
  assert.equal(fileOf(e, SHOP, 'image'), NEW);
  tag(e, 'buh:ci', NEWER);
  assert.equal(runSingle(e, ['once'], { IMAGE: 'buh:ci' }).code, 0);
  assert.equal(fileOf(e, SHOP, 'image'), NEWER, 'not refused');
  assert.equal(read(path.join(e.state, 'version-digests')), '');
  assert.ok(!alerts(e).some((a) => a.level === 'critical'));
});

test("regression: Podman's full names for local images (docker.io/library/…, localhost/…) are not registries to log in to", () => {
  const e = setup();
  publish(e, OLD);
  ownersContainer(e);
  // Docker Hub and localhost would refuse (nothing published there), as a missing login reads.
  fs.writeFileSync(path.join(e.fake, 'registry-denied'), 'docker.io\nlocalhost\n');
  tag(e, 'docker.io/library/buh-updater:vps-latest', UPD1);
  const r = runSetup(e, [], { UPDATER_IMAGE: 'docker.io/library/buh-updater:vps-latest', IMAGE: 'localhost/buh:ci' });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /refused to send/);
});
