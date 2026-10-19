import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const { audit, verifyAuditLog } = await import('@/lib/server/audit');
const { parseCourierProvider, parseCourierSettings } = await import('@/lib/server/courierInput');

test('audit log is hash-chained and detects tampering', () => {
  audit('test.one', { a: 1 });
  audit('test.two', { password: 'hunter2' });
  audit('test.three', {});
  const file = fs.readdirSync(dir).find((f) => f.startsWith('audit-'))!;
  const full = path.join(dir, file);
  const fresh = verifyAuditLog(full);
  assert.deepEqual([fresh.ok, fresh.status, fresh.entries, fresh.problems], [true, 'intact', 3, []]);
  assert.ok(!fs.readFileSync(full, 'utf8').includes('hunter2'), 'secrets redacted');

  const lines = fs.readFileSync(full, 'utf8').trim().split('\n');
  lines[1] = lines[1].replace('test.two', 'test.TWO');
  fs.writeFileSync(full, lines.join('\n') + '\n');
  const result = verifyAuditLog(full);
  assert.equal(result.ok, false);

  fs.writeFileSync(full, [lines[0], lines[2]].join('\n') + '\n');
  assert.equal(verifyAuditLog(full).ok, false, 'deleting a line breaks the chain');
});

test('courier input: only known couriers and emirates; settings allow-listed', () => {
  assert.throws(() => parseCourierProvider('fedex'));
  assert.equal(parseCourierProvider('jeebly'), 'jeebly');
  const settings = parseCourierSettings({ jeebly: { apiKey: 'k', isLive: 'yes', extra: 1 }, echo: {} });
  assert.equal(settings.jeebly.isLive, false, 'only a real true switches live mode on');
  assert.equal((settings.jeebly as unknown as Record<string, unknown>).extra, undefined);
  assert.throws(() => parseCourierSettings({ jeebly: { pickupEmirate: 'Narnia' }, echo: {} }), /seven Emirates/);
});
