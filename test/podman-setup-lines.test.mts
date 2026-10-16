/**
 * The one-line `setup` commands (src/lib/podmanSetup.ts) are the same everywhere an owner
 * copies them from (Settings → Versions, README, the deployment guide, the .bat), always pull a
 * newer updater image, and give the updater a bare socket path even when Podman reports
 * `unix://…` (regression: such a path in `-v` stopped the line before setup ran).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SETUP_CMD, SETUP_LINUX, SETUP_POWERSHELL } from '@/lib/podmanSetup';

const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', f), 'utf8');

test('the setup lines are the same in the guide, README and the .bat as on Settings → Versions', () => {
  const guide = read('HOSTINGER_DEPLOYMENT_GUIDE.md');
  const readme = read('README.md');
  for (const line of [SETUP_CMD, SETUP_POWERSHELL, SETUP_LINUX]) {
    assert.ok(guide.includes(`\n${line}\n`), `guide: ${line}`);
    assert.match(line, /-v "[^"]*containers:\/run\/buh\/registry-auth:ro"/, 'each line passes the registry login folder');
  }
  for (const line of [SETUP_CMD, SETUP_POWERSHELL]) assert.ok(readme.includes(`\n${line}\n`), `README: ${line}`);
  // (the .bat has Windows line ends once checked out: .gitattributes)
  assert.ok(read('scripts/podman-autoupdate.bat').split(/\r?\n/).includes(`REM   ${SETUP_CMD}`), '.bat');
  assert.match(guide, /Command Prompt \(cmd\), not PowerShell/);
  assert.match(readme, /Command Prompt \(cmd\), not PowerShell/);
});

test('every documented setup line pulls a newer updater image first', () => {
  for (const f of ['HOSTINGER_DEPLOYMENT_GUIDE.md', 'README.md', 'docs/user-guide.md', 'scripts/podman-autoupdate.bat']) {
    for (const line of read(f).split('\n').filter((l) => /podman run .*buh-updater:latest setup/.test(l))) {
      assert.match(line, /podman run --rm --pull=newer /, `${f}: ${line}`);
    }
  }
});

test('regression: the Linux line passes a bare socket path when Podman reports unix://…', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-setup-line-'));
  const log = path.join(dir, 'log');
  // A stand-in podman: `info` answers like Podman versions that report the URL form.
  fs.writeFileSync(
    path.join(dir, 'podman'),
    `#!/bin/sh\nif [ "$1" = info ]; then echo unix:///run/user/1000/podman/podman.sock; exit 0; fi\nprintf '%s\\n' "$@" > "${log}"\n`,
    { mode: 0o755 },
  );
  const r = spawnSync('sh', ['-c', SETUP_LINUX], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const args = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(args.includes('/run/user/1000/podman/podman.sock:/var/run/docker.sock'), args.join(' '));
  assert.ok(args.includes('SOCK=/run/user/1000/podman/podman.sock'), args.join(' '));
  assert.ok(args.includes('--pull=newer'));
  assert.ok(args.includes(`${process.env.HOME}/.config/containers:/run/buh/registry-auth:ro`), 'the registry login folder, read-only');
  assert.deepEqual(args.slice(-3), ['ghcr.io/cxsmtp/buh-updater:latest', 'setup', 'beautifuluaehome']);
  fs.rmSync(dir, { recursive: true, force: true });
});
