import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh, empty DATA_DIR for one test file. */
export function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-test-'));
  process.env.DATA_DIR = dir;
  return dir;
}

export function jsonRequest(body: unknown, headers: Record<string, string> = {}, url = 'http://shop.test/api/x') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'shop.test', ...headers },
    body: text,
  });
}
