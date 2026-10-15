/** package-lock.json: a version bump must only touch the shop's own entries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')) as { version: string; packages: Record<string, { version?: string; resolved?: string }> };
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string };

test('package-lock.json: the shop version matches package.json, and every package matches the tarball it downloads', () => {
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const wrong: string[] = [];
  for (const [where, entry] of Object.entries(lock.packages)) {
    if (!where || !entry.resolved?.startsWith('https://registry.npmjs.org/')) continue;
    const file = entry.resolved.split('/').pop()!;
    if (!file.endsWith(`-${entry.version}.tgz`)) wrong.push(`${where}: version ${entry.version}, downloads ${file}`);
  }
  assert.deepEqual(wrong, []);
});
