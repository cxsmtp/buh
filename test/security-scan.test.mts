/**
 * Fixes from the Checkmarx scan of Fusion Hub (2026-10-18): each test failed before its fix.
 * Containers, IaC (KICS), secrets and SAST findings that applied to this code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (p: string) => fs.readFileSync(p, 'utf8');
const fromLines = (p: string) => read(p).split('\n').filter((l) => /^FROM\s/.test(l));

test('secrets: the demo data carries no courier keys (they shipped in the admin bundle)', async () => {
  const { INITIAL_COURIER_SETTINGS } = await import('@/data/initialData');
  assert.equal(INITIAL_COURIER_SETTINGS.jeebly.apiKey, '');
  assert.equal(INITIAL_COURIER_SETTINGS.jeebly.clientKey, '');
  assert.equal(INITIAL_COURIER_SETTINGS.echo.apiKey, '');
  assert.doesNotMatch(read('src/data/initialData.ts'), /\b(jb|ech)_live_/);
});

test('XSS: a stored receipt link is an href only when it is a path on this site or http(s)', async () => {
  const { safeLinkHref } = await import('@/lib/apiClient');
  assert.equal(safeLinkHref('/api/admin/orders/BUH-1/receipt'), '/api/admin/orders/BUH-1/receipt');
  assert.equal(safeLinkHref('https://example.com/r.png'), 'https://example.com/r.png');
  for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', '//evil.example/x', '/\\evil.example', '/x\ny', '', undefined, null]) {
    assert.equal(safeLinkHref(bad as string), undefined, String(bad));
  }
  // Both places that link to a receipt go through it.
  assert.match(read('src/components/admin/AdminOrdersTab.tsx'), /href=\{safeLinkHref\(order\.paymentReceiptUrl\)\}/);
  assert.doesNotMatch(read('src/components/admin/AdminOrdersTab.tsx'), /href=\{order\.paymentReceiptUrl\}/);
  assert.match(read('src/components/admin/OrderBankTransfer.tsx'), /const receipt = safeLinkHref\(order\.paymentReceiptUrl\) \|\|/);
});

test('input validation: the webhook address shown to the owner takes only a plain host from the Host header', async () => {
  const { hostOrPlaceholder } = await import('@/lib/server/payments');
  assert.equal(hostOrPlaceholder('shop.example.com'), 'shop.example.com');
  assert.equal(hostOrPlaceholder('127.0.0.1:3000'), '127.0.0.1:3000');
  assert.equal(hostOrPlaceholder('Shop.Example.com, other.example'), 'shop.example.com');
  for (const bad of ['evil.example/path', 'a"b', 'a b', 'https://x', '<script>', 'x:99999999', '', null, undefined]) {
    assert.equal(hostOrPlaceholder(bad), 'your-domain', String(bad));
  }
  assert.match(read('src/app/api/admin/payments/route.ts'), /hostOrPlaceholder\(req\.headers\.get\('host'\)\)/);
});

test('the recovery-codes print window gets no handle back to the hub', () => {
  assert.match(read('src/components/admin/settings/SignInRecoveryCard.tsx'), /window\.open\('', '_blank'[^)]*\);[\s\S]{0,300}w\.opener = null;/);
});

test('containers: patched bases, pinned by digest; no end-of-life Node, old Caddy or old docker CLI', () => {
  const files = ['Dockerfile', 'deploy/updater/Dockerfile', 'deploy/proxy/Dockerfile'];
  for (const f of files) for (const l of fromLines(f)) {
    if (/^FROM\s+(base|cli)\b/.test(l)) continue;
    assert.match(l, /@sha256:[0-9a-f]{64}/, `${f}: ${l}`);
  }
  assert.deepEqual(fromLines('Dockerfile')[0].split(/\s+/)[1].split('@')[0], 'node:24.22.0-alpine3.24');
  assert.match(read('deploy/proxy/Dockerfile'), /^FROM caddy:2\.11\.7-alpine@sha256:/m);
  const compose = read('docker-compose.yml');
  assert.match(compose, /image: caddy:2\.11\.7-alpine@sha256:/);
  assert.match(compose, /image: docker:29\.9\.1-cli@sha256:/);
  for (const f of [...files, 'docker-compose.yml', 'deploy/ci/single-container-test.sh', '.github/workflows/zero-downtime.yml']) {
    assert.doesNotMatch(read(f), /node:20|caddy:2\.8\.|docker:28\./, f);
  }
});

test('containers: what the images do not need is not in them', () => {
  const shop = read('Dockerfile');
  const runner = shop.slice(shop.indexOf('AS runner'));
  assert.match(runner, /rm -rf \/usr\/local\/lib\/node_modules \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/);
  assert.match(runner, /\/usr\/local\/bin\/corepack \/usr\/local\/bin\/yarn \/usr\/local\/bin\/yarnpkg \/opt\/yarn-v\*/);
  // The updater: only the docker CLI binary, on plain Alpine (no Compose or Buildx plugin).
  const updater = read('deploy/updater/Dockerfile');
  const final = fromLines('deploy/updater/Dockerfile').at(-1)!;
  assert.match(final, /^FROM alpine:3\.24\.2@sha256:/);
  assert.match(updater, /^COPY --from=cli \/usr\/local\/bin\/docker \/usr\/local\/bin\/docker$/m);
  assert.doesNotMatch(updater, /cli-plugins/);
  assert.match(read('deploy/proxy/Dockerfile'), /apk del --no-cache --no-network curl/);
});

test('IaC: every image and Compose service has a healthcheck', () => {
  assert.match(read('Dockerfile'), /^HEALTHCHECK /m);
  assert.match(read('deploy/updater/Dockerfile'), /^HEALTHCHECK [\s\S]*CMD \["\/bin\/sh", "\/updater\/updater\.sh", "selfcheck"\]/m);
  assert.match(read('deploy/proxy/Dockerfile'), /^HEALTHCHECK [\s\S]*CMD \["nc", "-z", "127\.0\.0\.1", "443"\]/m);
  const compose = read('docker-compose.yml');
  const service = (name: string) => {
    const start = compose.indexOf(`\n  ${name}:\n`);
    const rest = compose.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[a-z-]+:\n|\nvolumes:/);
    return rest.slice(0, end + 1);
  };
  assert.match(service('caddy'), /healthcheck:\n\s+test: \["CMD", "nc", "-z", "127\.0\.0\.1", "443"\]/);
  assert.match(service('updater'), /healthcheck:\n\s+test: \["CMD", "\/bin\/sh", "\/updater\/updater\.sh", "selfcheck"\]/);
  assert.match(read('deploy/ci/compose.ci.yml'), /healthcheck:\n\s+test: \["CMD", "nc", "-z", "127\.0\.0\.1", "8080"\]/);
});

test('SCA: debug is 4.4 everywhere (3.x has the ReDoS in enable(); eslint plugins only)', () => {
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> };
  const old = Object.entries(lock.packages).filter(([k, v]) => /(^|\/)node_modules\/debug$/.test(k) && !v.version?.startsWith('4.'));
  assert.deepEqual(old, []);
});
