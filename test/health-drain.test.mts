/**
 * A copy being replaced hands its traffic over (BUH-02.43.00, found by the blue/green CI test on
 * Node 26): once the updater marks it, Caddy's own probe (/api/health?lb=1) answers 503, so Caddy
 * moves every request to the new copy before the old one is stopped; any other caller (monitors,
 * Docker's health check, a visitor) still gets 200 while it serves. Unmarked: 200 everywhere.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const mark = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buh-drain-')), 'buh-draining');
process.env.BUH_DRAIN_MARK = mark;
const { GET } = await import('@/app/api/health/route');
const ask = async (q = '') => {
  const res = GET(new Request(`http://shop.test/api/health${q}`));
  return { status: res.status, body: await res.json() };
};

test('not being replaced: 200 for Caddy and everyone', async () => {
  assert.deepEqual(await ask('?lb=1'), { status: 200, body: { ok: true } });
  assert.deepEqual(await ask(), { status: 200, body: { ok: true } });
});

test('being replaced: Caddy’s probe 503 (it moves off this copy); everyone else still 200', async () => {
  fs.writeFileSync(mark, '');
  try {
    assert.deepEqual(await ask('?lb=1'), { status: 503, body: { ok: false, draining: true } });
    assert.deepEqual(await ask(), { status: 200, body: { ok: true } });
    assert.deepEqual(await ask('?lb=0'), { status: 200, body: { ok: true } });
  } finally {
    fs.rmSync(mark, { force: true });
  }
});

test('the updater marks the old copy, then waits for Caddy, then stops it; Caddy probes ?lb=1', () => {
  const updater = fs.readFileSync('deploy/updater/updater.sh', 'utf8');
  assert.match(updater, /docker exec "\$drain_cid" touch \/tmp\/buh-draining/);
  assert.match(updater, /drain_colour "\$sw_active"\n\s*sleep "\$SETTLE_SECONDS"\n\s*stop_colour "\$sw_active"/);
  assert.match(fs.readFileSync('deploy/shop-snippets.caddy', 'utf8'), /^\thealth_uri \/api\/health\?lb=1$/m);
});
