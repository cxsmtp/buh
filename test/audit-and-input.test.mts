import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const { audit, verifyAuditLog } = await import('@/lib/server/audit');
const { parseOrderForDispatch, parseCourierProvider } = await import('@/lib/server/courierInput');

test('audit log is hash-chained and detects tampering', () => {
  audit('test.one', { a: 1 });
  audit('test.two', { password: 'hunter2' });
  audit('test.three', {});
  const file = fs.readdirSync(dir).find((f) => f.startsWith('audit-'))!;
  const full = path.join(dir, file);
  assert.deepEqual(verifyAuditLog(full), { ok: true, entries: 3, problems: [] });
  assert.ok(!fs.readFileSync(full, 'utf8').includes('hunter2'), 'secrets redacted');

  const lines = fs.readFileSync(full, 'utf8').trim().split('\n');
  lines[1] = lines[1].replace('test.two', 'test.TWO');
  fs.writeFileSync(full, lines.join('\n') + '\n');
  const result = verifyAuditLog(full);
  assert.equal(result.ok, false);

  fs.writeFileSync(full, [lines[0], lines[2]].join('\n') + '\n');
  assert.equal(verifyAuditLog(full).ok, false, 'deleting a line breaks the chain');
});

test('courier input: allow-listed, length-capped, numbers checked', () => {
  const order = {
    id: 'BUH-1',
    customer: { fullName: 'A\u0000B', phone: '+971501234567', emirate: 'Dubai', area: 'Marina', extra: 'dropped' },
    items: [{ title: 'Sheet', unitPrice: 100, quantity: 2 }],
    total: 200,
    paymentMethod: 'cod',
    __proto__: { polluted: true },
  };
  const parsed = parseOrderForDispatch(order);
  assert.equal(parsed.customer.fullName, 'A B');
  assert.equal((parsed.customer as Record<string, unknown>).extra, undefined);
  assert.throws(() => parseOrderForDispatch({ ...order, total: Infinity }));
  assert.throws(() => parseOrderForDispatch({ ...order, items: [] }));
  assert.throws(() => parseOrderForDispatch({ ...order, paymentMethod: 'free' }));
  assert.throws(() => parseCourierProvider('fedex'));
});
