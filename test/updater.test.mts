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
  const r = runSingle(e, ['heal']);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(path.join(e.state, 'last-good')).trim(), OLD);
  fs.rmSync(path.join(e.fake, 'events'), { force: true });
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
  assert.match(a.out, /podman-autoupdate\.bat beautifuluaehome 443 buhome-data/);
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

  // Different settings (another port): re-created again.
  assert.equal(runSingle(e, ['adopt'], { ...env, SHOP_PORT: '8443' }).code, 0);
  assert.ok(events(e).includes(`run ${SHOP} ${OLD} port=8443`), events(e).join('\n'));

  // A new shop (no container, no volume): started from the published image on a new volume.
  const f = setup();
  publish(f, OLD);
  const n = runSingle(f, ['adopt']);
  assert.equal(n.code, 0, n.out);
  assert.deepEqual(events(f), [`pull ${LATEST}`, `run ${SHOP} ${OLD} port=443`, `tag buh:last-good ${OLD}`]);
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
    { SHOP_PORT: '127.0.0.1:443' },
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
